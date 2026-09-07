#!/usr/bin/env bash
set -euo pipefail

baseline_dir=$1
candidate_dir=$2
proof_dir=$3
tooling_head=$4
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
baseline_head=149e97d4dbcadfaf2eda0c463aa7c7815da393d3
baseline_tree=cfa412019b0156d4e7cfeaa1120b7fcc88aa6344
candidate_head=f4742065da14544c3ee0d9e1036221cd27b19ddd
candidate_tree=4b107fbccb081ef9bd8a928c5b46ed581bc31457
driver_sha256=1d559430578c6d416ec098f5adc9dbe0697e460347dea0d4c7a39d1e9459b5ca
node_bin=$(dirname "$(command -v node)")
clean_path="$proof_dir/tools/node_modules/.bin:$node_bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$proof_dir"/{tools,store,artifacts}
clean_run() {
  local phase=$1
  shift
  mkdir -p "$proof_dir/$phase"/{home,config,cache,state,tmp}
  env -i PATH="$clean_path" HOME="$proof_dir/$phase/home" \
    USERPROFILE="$proof_dir/$phase/home" \
    XDG_CONFIG_HOME="$proof_dir/$phase/config" XDG_CACHE_HOME="$proof_dir/$phase/cache" \
    TMPDIR="$proof_dir/$phase/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    OPENCLAW_STATE_DIR="$proof_dir/$phase/state" \
    OPENCLAW_CONFIG_PATH="$proof_dir/$phase/state/openclaw.json" \
    OPENCLAW_VITEST_MAX_WORKERS=1 \
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="$proof_dir/$phase/cache/vitest" \
    "$@"
}

[[ "$(git -C "$tooling_root" rev-parse HEAD)" == "$tooling_head" ]]
cd "$tooling_root/.github/proof/stage-inputs-128454"
sha256sum --check files.sha256
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"

verify_source() {
  local source_dir=$1
  local head=$2
  local tree=$3
  [[ "$(git -C "$source_dir" rev-parse HEAD)" == "$head" ]]
  [[ "$(git -C "$source_dir" rev-parse HEAD^{tree})" == "$tree" ]]
  [[ -z "$(git -C "$source_dir" status --porcelain)" ]]
}
verify_source "$baseline_dir" "$baseline_head" "$baseline_tree"
verify_source "$candidate_dir" "$candidate_head" "$candidate_tree"
printf '%s\n' \
  src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts \
  src/auto-reply/reply/stage-sandbox-media.ts | LC_ALL=C sort > "$proof_dir/expected-paths.txt"
git -C "$candidate_dir" diff --no-ext-diff --no-textconv --name-only "$baseline_head" "$candidate_head" | LC_ALL=C sort > "$proof_dir/artifacts/source-changed-paths.txt"
cmp "$proof_dir/expected-paths.txt" "$proof_dir/artifacts/source-changed-paths.txt"
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml; do
  cmp "$baseline_dir/$file" "$candidate_dir/$file"
done

cd "$baseline_dir"
clean_run bootstrap node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(process.versions.node, '24.20.0');
assert.ok(pkg.packageManager.startsWith('pnpm@12.3.4+sha512.'));
JS
clean_run bootstrap npm install --prefix "$proof_dir/tools" --no-audit --no-fund pnpm@12.3.4
[[ "$(clean_run bootstrap pnpm --version)" == 12.3.4 ]]

run_phase() {
  local phase=$1
  local source_dir=$2
  local head=$3
  local tree=$4
  local artifact_dir="$proof_dir/artifacts/$phase"
  mkdir -p "$artifact_dir"
  cd "$source_dir"
  verify_source "$source_dir" "$head" "$tree"
  sha256sum package.json pnpm-lock.yaml pnpm-workspace.yaml > "$artifact_dir/source-inputs.sha256"
  printf '%s\n' "$head" > "$artifact_dir/source-head.txt"
  printf '%s\n' "$tree" > "$artifact_dir/source-tree.txt"
  clean_run "$phase" pnpm install --frozen-lockfile --store-dir "$proof_dir/store" 2>&1 | tee "$artifact_dir/install.log"
  verify_source "$source_dir" "$head" "$tree"
  clean_run "$phase" pnpm build qaRuntime 2>&1 | tee "$artifact_dir/build.log"
  verify_source "$source_dir" "$head" "$tree"
  sha256sum --check "$artifact_dir/source-inputs.sha256"
  clean_run "$phase" node --import ./scripts/tsx.mjs \
    "$tooling_root/.github/proof/stage-inputs-128454/ordinary-staging-runner.mjs" \
    "$phase" "$source_dir" "$head" "$tree" \
    "$tooling_root/.github/proof/stage-inputs-128454/ordinary-staging-proof.mjs" \
    "$driver_sha256" "$artifact_dir" 2>&1 | tee "$artifact_dir/component.log"
  verify_source "$source_dir" "$head" "$tree"
}

run_phase baseline "$baseline_dir" "$baseline_head" "$baseline_tree"
run_phase candidate "$candidate_dir" "$candidate_head" "$candidate_tree"
cd "$candidate_dir"
set +e
clean_run candidate node scripts/run-vitest.mjs \
  src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts \
  -t 'leaves no staged input directory|keeps host-staged inbound images|updates facts positionally|stages global-session media' \
  --reporter=default --reporter=json --outputFile="$proof_dir/candidate-regressions.raw.json" \
  2>&1 | tee "$proof_dir/artifacts/candidate/regressions.log"
regression_exit=${PIPESTATUS[0]}
set -e
clean_run candidate node --input-type=module - \
  "$proof_dir/candidate-regressions.raw.json" \
  "$proof_dir/artifacts/candidate/regressions.json" "$regression_exit" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output, exit] = process.argv.slice(2);
const result = JSON.parse(readFileSync(input, 'utf8'));
const cases = result.testResults.flatMap((file) => file.assertionResults);
const passed = cases.filter((test) => test.status === 'passed').map((test) => test.title).sort();
const expected = [
  'leaves no staged input directory when an owned source is missing',
  'stages global-session media with the prepared agent owner',
  'keeps host-staged inbound images available to native vision',
  'updates facts positionally: failed slot before staged slot',
  'updates facts positionally: staged slot before failed slot',
].sort();
writeFileSync(output, JSON.stringify({ exitCode: Number(exit), passed, failed: result.numFailedTests, cases: cases.map(({ title, status }) => ({ title, status })) }, null, 2) + '\n');
assert.equal(Number(exit), 0);
assert.equal(result.numFailedTests, 0);
assert.deepEqual(passed, expected);
JS
verify_source "$candidate_dir" "$candidate_head" "$candidate_tree"
