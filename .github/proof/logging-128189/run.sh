#!/usr/bin/env bash
set -euo pipefail
checkout_root=$1
proof_dir=$2
tooling_head=$3
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
driver_dir="$tooling_root/.github/proof/logging-128189"
node_bin=$(dirname "$(command -v node)")
clean_path="$proof_dir/tools/node_modules/.bin:$node_bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$proof_dir"/{home,config,cache,state,tmp,artifacts,tools}
clean_run() {
  env -i PATH="$clean_path" HOME="$proof_dir/home" \
    XDG_CONFIG_HOME="$proof_dir/config" XDG_CACHE_HOME="$proof_dir/cache" \
    TMPDIR="$proof_dir/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 \
    OPENCLAW_STATE_DIR="$proof_dir/state" "$@"
}
test "$(git -C "$tooling_root" rev-parse HEAD)" = "$tooling_head"
cd "$driver_dir"
sha256sum --check files.sha256
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"
clean_run npm install --prefix "$proof_dir/tools" --no-audit --no-fund pnpm@12.3.4
test "$(clean_run pnpm --version)" = 12.3.4
for arm in baseline candidate; do
  source_dir="$checkout_root/$arm"
  arm_artifacts="$proof_dir/artifacts/$arm"
  mkdir -p "$arm_artifacts"
  source_head=$(clean_run node -e 'const p=require(process.argv[1])[process.argv[2]];if(!p)process.exit(1);process.stdout.write(p.head)' "$driver_dir/source-pins.json" "$arm")
  source_tree=$(clean_run node -e 'const p=require(process.argv[1])[process.argv[2]];if(!p)process.exit(1);process.stdout.write(p.tree)' "$driver_dir/source-pins.json" "$arm")
  test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_head"
  test "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" = "$source_tree"
  cd "$source_dir"
  git diff --exit-code
  test -z "$(git status --porcelain)"
  clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(process.versions.node, '24.20.0');
assert.ok(pkg.packageManager.startsWith('pnpm@12.3.4+sha512.'));
JS
  sha256sum package.json pnpm-lock.yaml src/logging/{redact-bounded,redact,logger,logger-file-transport,subsystem,config,state}.ts > "$arm_artifacts/source-inputs.sha256"
  printf '%s\n' "$source_head" > "$arm_artifacts/source-head.txt"
  printf '%s\n' "$source_tree" > "$arm_artifacts/source-tree.txt"
  clean_run pnpm install --frozen-lockfile > "$proof_dir/$arm-install.log" 2>&1
  clean_run pnpm build qaRuntime > "$proof_dir/$arm-build.log" 2>&1
  git diff --exit-code
  test -z "$(git status --porcelain)"
  sha256sum --check "$arm_artifacts/source-inputs.sha256"
  clean_run node --input-type=module - "$source_head" "$arm_artifacts/built-runtime.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [head, output] = process.argv.slice(2);
for (const stamp of ['dist/.buildstamp', 'dist/.runtime-postbuildstamp']) {
  assert.equal(JSON.parse(readFileSync(stamp, 'utf8')).head, head);
}
const hashes = {};
for (const file of ['dist/entry.js', 'dist/plugin-sdk/process-runtime.js']) {
  assert.ok(realpathSync(file).startsWith(`${realpathSync(process.cwd())}${path.sep}`));
  hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
}
writeFileSync(output, JSON.stringify({ head, node: process.versions.node, hashes }));
JS
done
# Match dependencies and every unchanged logging owner before comparing timings.
cmp "$checkout_root/baseline/package.json" "$checkout_root/candidate/package.json"
cmp "$checkout_root/baseline/pnpm-lock.yaml" "$checkout_root/candidate/pnpm-lock.yaml"
for owner in redact logger logger-file-transport subsystem config state; do
  cmp "$checkout_root/baseline/src/logging/$owner.ts" "$checkout_root/candidate/src/logging/$owner.ts"
done
set +e
clean_run node "$driver_dir/driver.mjs" compare "$checkout_root" "$proof_dir/artifacts" > "$proof_dir/driver.log" 2>&1
proof_exit=$?
set -e
printf '%s\n' "$proof_exit" > "$proof_dir/artifacts/driver-exit.txt"
validation_exit=0
if [ "$proof_exit" -eq 0 ]; then
  cd "$checkout_root/candidate"
  suites=(src/logging/redact.test.ts src/logging/logger-redaction-behavior.test.ts src/logging/redact-token-ordering.test.ts)
  set +e
  clean_run node --import ./scripts/tsx.mjs scripts/test-projects.mts "${suites[@]}" -- \
    --reporter=json --outputFile="$proof_dir/unit-report.json" 2>&1 | tee "$proof_dir/unit.log"
  tests_exit=${PIPESTATUS[0]}
  clean_run node --input-type=module - "$proof_dir/unit-report.json" "$proof_dir/artifacts/validation-summary.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [reportPath, output] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const expected = ['src/logging/redact.test.ts', 'src/logging/logger-redaction-behavior.test.ts', 'src/logging/redact-token-ordering.test.ts'].sort();
const files = report.testResults.map((file) => ({
  path: path.relative(process.cwd(), file.name),
  count: file.assertionResults.length,
  passed: file.assertionResults.filter((test) => test.status === 'passed').length,
}));
writeFileSync(output, JSON.stringify({ source: '88c1629b9e3e42c809d14dbc6417677c3487305c', success: report.success, files }));
assert.deepEqual(files.map((file) => file.path).sort(), expected, 'focused logging suite collection differs');
assert.equal(report.success, true);
assert.ok(files.every((file) => file.count > 0 && file.passed === file.count), 'focused logging cases skipped or failed');
JS
  collection_exit=$?
  clean_run node scripts/check-changed.mjs --base 44dbc50d172e9e7ec407b8e21e26aefa430cc933 --head 88c1629b9e3e42c809d14dbc6417677c3487305c -- \
    src/logging/redact-bounded.ts src/logging/redact.test.ts 2>&1 | tee "$proof_dir/changed-checks.log"
  changed_exit=${PIPESTATUS[0]}
  set -e
  printf '%s\n' "$tests_exit" > "$proof_dir/artifacts/tests-exit.txt"
  printf '%s\n' "$collection_exit" > "$proof_dir/artifacts/collection-exit.txt"
  printf '%s\n' "$changed_exit" > "$proof_dir/artifacts/changed-checks-exit.txt"
  if [ "$tests_exit" -ne 0 ] || [ "$collection_exit" -ne 0 ] || [ "$changed_exit" -ne 0 ]; then
    validation_exit=1
  fi
fi
for arm in baseline candidate; do
  cd "$checkout_root/$arm"
  git diff --exit-code
  test -z "$(git status --porcelain)"
  sha256sum --check "$proof_dir/artifacts/$arm/source-inputs.sha256"
  clean_run node --input-type=module - "$proof_dir/artifacts/$arm/built-runtime.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const before = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [file, hash] of Object.entries(before.hashes)) {
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), hash);
}
for (const stamp of ['dist/.buildstamp', 'dist/.runtime-postbuildstamp']) {
  assert.equal(JSON.parse(readFileSync(stamp, 'utf8')).head, before.head);
}
JS
done
cp "$driver_dir/files.sha256" "$proof_dir/artifacts/tooling-files.sha256"
if [ "$proof_exit" -ne 0 ]; then
  exit "$proof_exit"
fi
exit "$validation_exit"
