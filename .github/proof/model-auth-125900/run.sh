#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
proof_dir=$2
tooling_head=$3
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
source_head=0cd1ca7552a005a405dea7311036c063dc9635d0
source_tree=cfabc1495b23c0888e7a0c34c57efcd826b5a7bb
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
    PLAYWRIGHT_BROWSERS_PATH="$proof_dir/cache/playwright" \
    OPENCLAW_VITEST_MAX_WORKERS=2 \
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="$proof_dir/cache/vitest-modules" \
    OPENCLAW_UI_E2E_ARTIFACT_DIR="$proof_dir/artifacts/browser" \
    "$@"
}

test "$(git -C "$tooling_root" rev-parse HEAD)" = "$tooling_head"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_head"
test "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" = "$source_tree"
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
cp "$tooling_root/.github/proof/model-auth-125900/driver.e2e.test.ts" "$driver_path"
patch --batch --fuzz=0 -p1 < "$tooling_root/.github/proof/model-auth-125900/registration.patch"

verify_source_scope() {
  {
    git diff --name-only
    git ls-files --others --exclude-standard
  } | LC_ALL=C sort -u > "$proof_dir/artifacts/changed-paths.txt"
  printf '%s\n' "$driver_path" "$registry_path" | LC_ALL=C sort > "$proof_dir/expected-paths.txt"
  cmp "$proof_dir/expected-paths.txt" "$proof_dir/artifacts/changed-paths.txt"
  sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
  printf '%s  %s\n' "$registry_sha256" "$registry_path" | sha256sum --check
  cmp "$driver_path" "$tooling_root/.github/proof/model-auth-125900/driver.e2e.test.ts"
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
clean_run pnpm build qaRuntime 2>&1 | tee "$proof_dir/artifacts/build-runtime.log"
clean_run pnpm ui:build 2>&1 | tee "$proof_dir/artifacts/build-ui.log"
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
exit "$proof_exit"
