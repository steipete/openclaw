#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
proof_dir=$2
tooling_head=$3
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
source_head=bb8295a2f69bb7232ee38d51c13becb1d2bf5e80
source_tree=aff804944b86fba6f70af72a1a84b5eb68d774f0
check_base=ea376be52530c68d196ce8614fbd7f986dea3963
arm=candidate
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
test "$(git -C "$source_dir" rev-parse "$check_base^{tree}")" = 5d66a2a08fc8067d6ccde51ecddd8dcfa6008e43
git -C "$source_dir" merge-base --is-ancestor "$check_base" "$source_head"
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
  git diff --exit-code
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

suite_paths=(
  extensions/memory-core/src/short-term-promotion.test.ts
  extensions/memory-core/src/cli.test.ts
  extensions/memory-core/src/dreaming-phases.test.ts
)
set +e
clean_run timeout --signal=TERM --kill-after=15s 240s \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-memory.config.ts \
  --configLoader runner "${suite_paths[@]}" \
  --reporter=default --reporter=json --outputFile="$proof_dir/suites-report.json" \
  2>&1 | tee "$proof_dir/suites.log"
suites_exit=${PIPESTATUS[0]}
set -e
verify_source
printf '%s\n' "$suites_exit" > "$proof_dir/artifacts/owner-suites-exit.txt"
test "$suites_exit" = 0
clean_run node "$tooling_root/.github/proof/memory-promotion-121287/verify-suites.mjs" \
  "$proof_dir/suites-report.json" "$proof_dir/artifacts/owner-suites.json"

changed_paths=(
  docs/cli/memory.md
  extensions/memory-core/src/short-term-promotion.ts
  "${suite_paths[@]}"
)
clean_run node scripts/check-changed.mjs --base "$check_base" --head "$source_head" --dry-run -- "${changed_paths[@]}" \
  2>&1 | tee "$proof_dir/artifacts/check-plan.log"
set +e
clean_run node scripts/check-changed.mjs --base "$check_base" --head "$source_head" -- "${changed_paths[@]}" \
  2>&1 | tee "$proof_dir/check.log"
checks_exit=${PIPESTATUS[0]}
set -e
verify_source
printf '%s\n' "$checks_exit" > "$proof_dir/artifacts/check-exit.txt"
exit "$checks_exit"
