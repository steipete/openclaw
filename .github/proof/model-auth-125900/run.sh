#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
proof_dir=$2
tooling_head=$3
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
phase=$4
case "$phase" in
  baseline)
    source_head=b392c6080f7c12782a2c808c742eb93b25cd5979
    source_tree=1b2108d00d24aefae81b9d8bd81e4be6186d24ca
    ;;
  candidate)
    source_head=c9ac2e0b2431f8939a93c1e41cb1db24e9e5af19
    source_tree=e82805419822e6acf64f9c9c944cc008fab17b23
    ;;
  *) exit 2 ;;
esac
regression_path=ui/src/lib/model-auth.test.ts
driver_path=ui/src/e2e/model-auth-coalescing.real-gateway.e2e.test.ts
registry_path=test/vitest/vitest.ui-e2e.config.ts
registry_sha256=645343181ba7efd465f3fb0156bb88fae9b0f28c596a5d971b33d180d26d1759
node_bin=$(dirname "$(command -v node)")
clean_path="$proof_dir/tools/node_modules/.bin:$node_bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$proof_dir"/{home,config,cache,state,tmp,artifacts/browser,tools}
clean_run() {
  env -i \
    PATH="$clean_path" HOME="$proof_dir/home" \
    XDG_CONFIG_HOME="$proof_dir/config" XDG_CACHE_HOME="$proof_dir/cache" \
    TMPDIR="$proof_dir/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 \
    OPENCLAW_STATE_DIR="$proof_dir/state" \
    MODEL_AUTH_PROOF_SOURCE_HEAD="$source_head" \
    PLAYWRIGHT_BROWSERS_PATH="$proof_dir/cache/playwright" \
    OPENCLAW_VITEST_MAX_WORKERS=2 \
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="$proof_dir/cache/vitest-modules" \
    OPENCLAW_UI_E2E_ARTIFACT_DIR="$proof_dir/artifacts/browser" \
    "$@"
}

test "$(git -C "$tooling_root" rev-parse HEAD)" = "$tooling_head"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_head"
test "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" = "$source_tree"
if [[ "$phase" == candidate ]]; then
  test "$(git -C "$source_dir" rev-parse 'HEAD^1')" = 1667c547e83ddfd79fa85a7312348859ce45da95
  test "$(git -C "$source_dir" rev-parse 'HEAD^2')" = b392c6080f7c12782a2c808c742eb93b25cd5979
  git -C "$source_dir" merge-base --is-ancestor b392c6080f7c12782a2c808c742eb93b25cd5979 HEAD
fi
git -C "$source_dir" diff --exit-code
cd "$source_dir"

clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(process.versions.node, '24.20.0');
assert.ok(pkg.packageManager.startsWith('pnpm@12.3.4+sha512.'));
assert.equal(pkg.devDependencies.playwright, '1.62.1');
assert.equal(pkg.devDependencies.vitest, '5.0.0');
assert.equal(pkg.devDependencies.oxfmt, '0.65.0');
JS
sha256sum pnpm-lock.yaml package.json > "$proof_dir/artifacts/source-inputs.sha256"
printf '%s\n' "$source_head" > "$proof_dir/artifacts/source-head.txt"
printf '%s\n' "$source_tree" > "$proof_dir/artifacts/source-tree.txt"
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"

cd "$tooling_root/.github/proof/model-auth-125900"
sha256sum --check files.sha256
cd "$source_dir"
if [[ "$phase" == baseline ]]; then
  test ! -e "$regression_path"
  cp "$tooling_root/.github/proof/model-auth-125900/model-auth.test.ts" "$regression_path"
else
  cmp "$regression_path" "$tooling_root/.github/proof/model-auth-125900/model-auth.test.ts"
fi
cp "$tooling_root/.github/proof/model-auth-125900/driver.e2e.test.ts" "$driver_path"
patch --batch --fuzz=0 -p1 < "$tooling_root/.github/proof/model-auth-125900/registration.patch"

verify_source_scope() {
  {
    git diff --name-only
    git ls-files --others --exclude-standard
  } | LC_ALL=C sort -u > "$proof_dir/artifacts/changed-paths.txt"
  {
    printf '%s\n' "$driver_path" "$registry_path"
    if [[ "$phase" == baseline ]]; then
      printf '%s\n' "$regression_path"
    fi
  } | LC_ALL=C sort > "$proof_dir/expected-paths.txt"
  cmp "$proof_dir/expected-paths.txt" "$proof_dir/artifacts/changed-paths.txt"
  sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
  printf '%s  %s\n' "$registry_sha256" "$registry_path" | sha256sum --check
  cmp "$driver_path" "$tooling_root/.github/proof/model-auth-125900/driver.e2e.test.ts"
  cmp "$regression_path" "$tooling_root/.github/proof/model-auth-125900/model-auth.test.ts"
  git diff --binary -- "$registry_path" > "$proof_dir/artifacts/registry.patch"
  cp "$driver_path" "$proof_dir/artifacts/driver.e2e.test.ts"
}
verify_source_scope

clean_run npm install --prefix "$proof_dir/tools" --no-audit --no-fund pnpm@12.3.4
[[ "$(clean_run pnpm --version)" == 12.3.4 ]]
clean_run pnpm install --frozen-lockfile 2>&1 | tee "$proof_dir/artifacts/install.log"
clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const [name, version] of [['playwright', '1.62.1'], ['vitest', '5.0.0'], ['oxfmt', '0.65.0']]) {
  assert.equal(require(name + '/package.json').version, version);
}
JS
verify_source_scope
# The baseline overlays the exact reviewed test and must fail its ordinary-read
# dedup assertion. The preserved JSON needs inspection; an arbitrary failure is not proof.
set +e
if [[ "$phase" == baseline ]]; then
  clean_run node scripts/run-vitest.mjs run --config ui/vitest.config.ts \
    "$regression_path" -t 'shares pending ordinary reads without retaining completed results' \
    --reporter=json --outputFile="$proof_dir/artifacts/owner-tests.json" \
    2>&1 | tee "$proof_dir/artifacts/owner-tests.log"
  owner_exit=${PIPESTATUS[0]}
else
  clean_run node scripts/run-vitest.mjs run --config ui/vitest.config.ts \
    "$regression_path" ui/src/app/app-host.chat-metadata.test.ts \
    ui/src/lib/model-catalog-store.test.ts ui/src/components/sidebar-attention-store.test.ts \
    --reporter=json --outputFile="$proof_dir/artifacts/owner-tests.json" \
    2>&1 | tee "$proof_dir/artifacts/owner-tests.log"
  owner_exit=${PIPESTATUS[0]}
fi
set -e
printf '%s\n' "$owner_exit" > "$proof_dir/artifacts/owner-tests-exit.txt"
verify_source_scope
clean_run pnpm build qaRuntime 2>&1 | tee "$proof_dir/artifacts/build-runtime.log"
clean_run pnpm ui:build 2>&1 | tee "$proof_dir/artifacts/build-ui.log"
clean_run node --import ./scripts/tsx.mjs "$tooling_root/.github/proof/model-auth-125900/capture-startup.mjs" \
  "$source_head" "$source_tree" "$phase" normal "$proof_dir/artifacts/startup-normal.json" "$tooling_head"
verify_source_scope
clean_run pnpm exec playwright install chromium 2>&1 | tee "$proof_dir/artifacts/browser-install.log"

# The runtime fixture receives only this explicit parent environment. Its own
# child overrides remove test shortcuts; no Actions/OIDC/provider credentials flow in.
set +e
clean_run node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  "$driver_path" 2>&1 | tee "$proof_dir/artifacts/observation.log"
proof_exit=${PIPESTATUS[0]}
set -e
verify_source_scope
printf '%s\n' "$proof_exit" > "$proof_dir/artifacts/observation-exit.txt"
if [[ "$phase" == baseline ]]; then
  test "$owner_exit" -eq 1
  clean_run node --input-type=module - "$proof_dir/artifacts/owner-tests.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 0);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.endsWith('/ui/src/lib/model-auth.test.ts'));
assert.equal(suite.status, 'failed');
assert.equal(suite.message, '');
const failures = report.testResults.flatMap((suite) => suite.assertionResults)
  .filter((test) => test.status === 'failed');
assert.equal(failures.length, 1);
assert.equal(failures[0].title, 'shares pending ordinary reads without retaining completed results');
const failure = stripVTControlCharacters(failures[0].failureMessages.join('\n'));
assert.match(failure, /to be called once with arguments/);
assert.match(failure, /models\.authStatus/);
assert.match(failure, /Number of calls:\s+2/);
JS
else
  test "$owner_exit" -eq 0
  clean_run node --input-type=module - "$proof_dir/artifacts/owner-tests.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(report.numFailedTests, 0);
const files = [
  'ui/src/lib/model-auth.test.ts',
  'ui/src/app/app-host.chat-metadata.test.ts',
  'ui/src/lib/model-catalog-store.test.ts',
  'ui/src/components/sidebar-attention-store.test.ts',
];
assert.equal(report.testResults.length, files.length);
for (const file of files) {
  const results = report.testResults.filter((suite) => suite.name.endsWith('/' + file));
  assert.equal(results.length, 1, file);
  assert.equal(results[0].status, 'passed', file);
  assert.equal(results[0].message, '', file);
  assert.ok(results[0].assertionResults.some((test) => test.status === 'passed'), file);
}
const passed = new Set(report.testResults.flatMap((suite) => suite.assertionResults)
  .filter((test) => test.status === 'passed').map((test) => test.title));
for (const title of [
  'shares pending ordinary reads without retaining completed results',
  'retires shared auth reads at the application boundary (config.changed)',
  'retires shared auth reads at the application boundary (chat.metadata.changed)',
  'retires shared auth reads at the application boundary (same-client reconnect)',
]) {
  assert.ok(passed.has(title), title);
}
JS
  # Measure the canonical budget after the real browser exits. Its normalized
  # build identity must never be served by the live Gateway's normal bundle.
  set +e
  clean_run pnpm ui:check-performance:base b392c6080f7c12782a2c808c742eb93b25cd5979 \
    2>&1 | tee "$proof_dir/artifacts/startup-check.log"
  startup_exit=${PIPESTATUS[0]}
  set -e
  printf '%s\n' "$startup_exit" > "$proof_dir/artifacts/startup-check-exit.txt"
  clean_run node --import ./scripts/tsx.mjs "$tooling_root/.github/proof/model-auth-125900/capture-startup.mjs" \
    "$source_head" "$source_tree" "$phase" comparison "$proof_dir/artifacts/startup-comparison.json" "$tooling_head"
  verify_source_scope
  test "$startup_exit" -eq 0
fi
exit "$proof_exit"
