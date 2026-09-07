#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
proof_dir=$2
tooling_head=$3
tooling_root=$(cd "$(dirname "$0")/../../.." && pwd)
source_head=fea93117677b54350218956b0c25634a1a318117
source_tree=8a59db133cf4c0501a6d5c5b21216c371df54ff7
source_base=3f22e84d4e5da068a2c619ec8786aac038ef534c
source_base_tree=593960f1a7be49c0707814dd69803b958d350ef6
node_bin=$(dirname "$(command -v node)")
clean_path="$proof_dir/tools/node_modules/.bin:$node_bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$proof_dir"/{home,config,cache,state,tmp,artifacts,tools}
clean_run() {
  env -i PATH="$clean_path" HOME="$proof_dir/home" \
    XDG_CONFIG_HOME="$proof_dir/config" XDG_CACHE_HOME="$proof_dir/cache" \
    TMPDIR="$proof_dir/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 \
    OPENCLAW_STATE_DIR="$proof_dir/state" "$@"
}
verify_source() {
  test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_head"
  test "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" = "$source_tree"
  test "$(git -C "$source_dir" rev-parse "$source_base^{tree}")" = "$source_base_tree"
  git -C "$source_dir" merge-base --is-ancestor "$source_base" "$source_head"
  git -C "$source_dir" diff --cached --exit-code
  git -C "$source_dir" diff --exit-code
  test -z "$(git -C "$source_dir" status --porcelain)"
}
test "$(git -C "$tooling_root" rev-parse HEAD)" = "$tooling_head"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_head"
test "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" = "$source_tree"
cd "$tooling_root/.github/proof/session-ingestion-119367"
sha256sum --check files.sha256
cd "$source_dir"
verify_source
clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(process.versions.node, '24.20.0');
assert.ok(pkg.packageManager.startsWith('pnpm@12.3.4+sha512.'));
JS
sha256sum package.json pnpm-lock.yaml > "$proof_dir/artifacts/source-inputs.sha256"
printf '%s\n' "$source_head" > "$proof_dir/artifacts/source-head.txt"
printf '%s\n' "$source_tree" > "$proof_dir/artifacts/source-tree.txt"
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"
clean_run npm install --prefix "$proof_dir/tools" --no-audit --no-fund pnpm@12.3.4
[[ "$(clean_run pnpm --version)" == 12.3.4 ]]
clean_run pnpm install --frozen-lockfile 2>&1 | tee "$proof_dir/artifacts/install.log"
clean_run pnpm build qaRuntime 2>&1 | tee "$proof_dir/artifacts/build.log"
verify_source
sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const expectedHead = 'fea93117677b54350218956b0c25634a1a318117';
for (const stamp of ['dist/.buildstamp', 'dist/.runtime-postbuildstamp']) {
  assert.equal(JSON.parse(readFileSync(stamp, 'utf8')).head, expectedHead);
}
const required = ['openclaw.mjs', 'dist/entry.js', 'dist/extensions/memory-core/index.js',
  'dist/plugin-sdk/process-runtime.js', 'dist/plugin-sdk/session-transcript-runtime.js'];
const hashes = {};
for (const file of required) {
  assert.ok(existsSync(file), `Missing runtime build output: ${file}`);
  assert.ok(realpathSync(file).startsWith(`${realpathSync(process.cwd())}${path.sep}`));
  hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
}
writeFileSync(path.join(process.env.TMPDIR, '../artifacts/built-runtime.json'), JSON.stringify({ head: expectedHead, hashes }));
JS
# Same immutable candidate; reuse the verified CLI and103 memory tests from run34094068091.
set +e
clean_run node "$tooling_root/.github/proof/session-ingestion-119367/run-green.mjs" \
  "$source_dir" "$proof_dir" 2>&1 | tee "$proof_dir/checks.log"
proof_exit=${PIPESTATUS[0]}
set -e
printf '%s\n' "$proof_exit" > "$proof_dir/artifacts/recovery-exit.txt"
verify_source
sha256sum --check "$proof_dir/artifacts/source-inputs.sha256"
clean_run node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const before = JSON.parse(readFileSync(path.join(process.env.TMPDIR, '../artifacts/built-runtime.json'), 'utf8'));
for (const [file, hash] of Object.entries(before.hashes)) {
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), hash);
}
assert.equal(JSON.parse(readFileSync('dist/.buildstamp', 'utf8')).head, before.head);
assert.equal(JSON.parse(readFileSync('dist/.runtime-postbuildstamp', 'utf8')).head, before.head);
JS
cp "$tooling_root/.github/proof/session-ingestion-119367/files.sha256" "$proof_dir/artifacts/tooling-files.sha256"
exit "$proof_exit"
