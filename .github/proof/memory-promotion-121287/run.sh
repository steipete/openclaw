#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
proof_dir=$2
tooling_head=$3
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
source_head=ea376be52530c68d196ce8614fbd7f986dea3963
source_tree=5d66a2a08fc8067d6ccde51ecddd8dcfa6008e43
arm=baseline
regression_path=extensions/memory-core/src/short-term-promotion.test.ts
regression_sha256=a4038774acdcb050271b1799b2b7d2e4eceb00aa79bc3f0551a8977a0b9f7868
regression_applied=0
node_bin=$(dirname "$(command -v node)")
clean_path="$proof_dir/tools/node_modules/.bin:$node_bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$proof_dir"/{home,config,cache,state,tmp,artifacts,tools}
clean_run() {
  env -i PATH="$clean_path" HOME="$proof_dir/home" \
    XDG_CONFIG_HOME="$proof_dir/config" XDG_CACHE_HOME="$proof_dir/cache" \
    TMPDIR="$proof_dir/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 NO_COLOR=1 \
    OPENCLAW_STATE_DIR="$proof_dir/state" "$@"
}

test "$(git -C "$tooling_root" rev-parse HEAD)" = "$tooling_head"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_head"
test "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" = "$source_tree"
test -x /usr/bin/time
git -C "$source_dir" diff --exit-code
cd "$source_dir"
clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(process.versions.node, '24.20.0');
assert.equal(pkg.packageManager, 'pnpm@12.3.4+sha512.961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457');
JS
sha256sum pnpm-lock.yaml package.json > "$proof_dir/artifacts/source-inputs.sha256"
printf '%s\n' "$source_head" > "$proof_dir/artifacts/source-head.txt"
printf '%s\n' "$source_tree" > "$proof_dir/artifacts/source-tree.txt"
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"
clean_run node --version > "$proof_dir/artifacts/node-version.txt"
cd "$tooling_root/.github/proof/memory-promotion-121287"
sha256sum --check files.sha256
cd "$source_dir"

verify_source() {
  test "$(git rev-parse HEAD)" = "$source_head"
  test "$(git rev-parse 'HEAD^{tree}')" = "$source_tree"
  if [[ "$regression_applied" == 1 ]]; then
    test "$(git diff --name-only)" = "$regression_path"
    git diff --binary --full-index -- "$regression_path" > "$proof_dir/artifacts/observed-regression.patch"
    cmp "$proof_dir/artifacts/observed-regression.patch" \
      "$tooling_root/.github/proof/memory-promotion-121287/regression.patch"
    printf '%s  %s\n' "$regression_sha256" "$regression_path" | sha256sum --check
  else
    git diff --exit-code
  fi
  git diff --cached --exit-code
  git ls-files --others --exclude-standard > "$proof_dir/artifacts/untracked-source.txt"
  test ! -s "$proof_dir/artifacts/untracked-source.txt"
  sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
  (cd "$tooling_root/.github/proof/memory-promotion-121287" && sha256sum --check files.sha256)
}

runtime_binding() {
  clean_run node --input-type=module - "$source_head" "$1" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const buildStamp = JSON.parse(readFileSync('dist/.buildstamp', 'utf8'));
const runtimeStamp = JSON.parse(readFileSync('dist/.runtime-postbuildstamp', 'utf8'));
assert.equal(buildStamp.head, process.argv[2]);
assert.equal(runtimeStamp.head, process.argv[2]);
const files = [
  'openclaw.mjs', 'scripts/run-node.mjs', 'scripts/run-node.mts', 'dist/entry.js',
  'dist/.buildstamp', 'dist/.runtime-postbuildstamp',
  'extensions/memory-core/src/short-term-promotion.ts',
  'extensions/memory-core/src/dreaming-consolidation-candidates.ts',
  'extensions/memory-core/src/short-term-promotion-apply.ts',
];
const hashes = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(process.argv[3], JSON.stringify({
  sourceHead: process.argv[2], buildCommand: 'pnpm build qaRuntime',
  buildProfile: 'qaRuntime', profileEvidence: 'successful canonical build invocation; stamps contain head, not profile',
  executionMode: 'normal pnpm repository CLI via run-node -> openclaw.mjs -> dist/entry.js; wrapper selects this checkout with OPENCLAW_DEV_SOURCE_ROOT',
  installedPackageClaim: false, buildStamp, runtimeStamp, hashes,
}, null, 2) + '\n');
JS
}
verify_source
clean_run npm install --prefix "$proof_dir/tools" --no-audit --no-fund pnpm@12.3.4
test "$(clean_run pnpm --version)" = 12.3.4
clean_run node --input-type=module - "$proof_dir/tools/package-lock.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const installed = JSON.parse(readFileSync(process.argv[2], 'utf8')).packages['node_modules/pnpm'];
assert.equal(installed.version, '12.3.4');
assert.equal(installed.integrity, 'sha512-' + Buffer.from(pkg.packageManager.split('+sha512.')[1], 'hex').toString('base64'));
JS
clean_run pnpm install --frozen-lockfile 2>&1 | tee "$proof_dir/install.log"
verify_source
clean_run pnpm build qaRuntime 2>&1 | tee "$proof_dir/build.log"
verify_source
runtime_binding "$proof_dir/artifacts/runtime-after-build.json"

# Each real CLI invocation starts with only the driver's explicit synthetic state.
set +e
clean_run node --import ./scripts/tsx.mjs \
  "$tooling_root/.github/proof/memory-promotion-121287/driver.mjs" \
  "$source_dir" "$proof_dir" "$arm" 2>&1 | tee "$proof_dir/driver.log"
proof_exit=${PIPESTATUS[0]}
set -e
verify_source
runtime_binding "$proof_dir/artifacts/runtime-after-flow.json"
cmp "$proof_dir/artifacts/runtime-after-build.json" "$proof_dir/artifacts/runtime-after-flow.json"
printf '%s\n' "$proof_exit" > "$proof_dir/artifacts/observation-exit.txt"
test "$proof_exit" = 0

# Run the new unit regression only after the unchanged-source live observation.
git apply --check "$tooling_root/.github/proof/memory-promotion-121287/regression.patch"
git apply "$tooling_root/.github/proof/memory-promotion-121287/regression.patch"
regression_applied=1
verify_source
set +e
clean_run timeout --signal=TERM --kill-after=15s 240s \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-memory.config.ts \
  --configLoader runner "$regression_path" \
  --testNamePattern 'keeps blocked origins out of ranking before applying the candidate limit' \
  --reporter=json --outputFile="$proof_dir/regression-report.json" \
  2>&1 | tee "$proof_dir/regression.log"
regression_exit=${PIPESTATUS[0]}
set -e
verify_source
test "$regression_exit" = 1
clean_run node "$tooling_root/.github/proof/memory-promotion-121287/verify-regression.mjs" \
  "$proof_dir/regression-report.json" "$proof_dir/artifacts/expected-regression-failure.json"
