#!/usr/bin/env bash
set -euo pipefail
source_dir=$1
proof_dir=$2
tooling_head=$3
arm=$4
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
# The candidate remains fail-closed until its exact published source is reviewed and bound.
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
sha256sum package.json pnpm-lock.yaml src/logging/{redact-bounded,redact,logger,logger-file-transport,subsystem,config,state}.ts > "$proof_dir/artifacts/source-inputs.sha256"
printf '%s\n' "$source_head" > "$proof_dir/artifacts/source-head.txt"
printf '%s\n' "$source_tree" > "$proof_dir/artifacts/source-tree.txt"
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"
clean_run npm install --prefix "$proof_dir/tools" --no-audit --no-fund pnpm@12.3.4
test "$(clean_run pnpm --version)" = 12.3.4
clean_run pnpm install --frozen-lockfile > "$proof_dir/install.log" 2>&1
clean_run pnpm build qaRuntime > "$proof_dir/build.log" 2>&1
git diff --exit-code
test -z "$(git status --porcelain)"
sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
clean_run node --input-type=module - "$source_head" "$proof_dir/artifacts/built-runtime.json" <<'JS'
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
set +e
clean_run node "$driver_dir/driver.mjs" observe "$source_dir" "$proof_dir/artifacts" "$arm" > "$proof_dir/driver.log" 2>&1
proof_exit=$?
set -e
printf '%s\n' "$proof_exit" > "$proof_dir/artifacts/driver-exit.txt"
git diff --exit-code
test -z "$(git status --porcelain)"
sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
clean_run node --input-type=module - "$proof_dir/artifacts/built-runtime.json" <<'JS'
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
cp "$driver_dir/files.sha256" "$proof_dir/artifacts/tooling-files.sha256"
exit "$proof_exit"
