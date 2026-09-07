#!/usr/bin/env bash
# Inert review draft; secretless hosted proof only.
set -euo pipefail
source_parent=$1
proof_dir=$2
tooling_head=$3
proof_mode=$4
script_dir=$(cd "$(dirname "$0")" && pwd)
node_bin=$(dirname "$(command -v node)")
clean_path="$proof_dir/tools/node_modules/.bin:$node_bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$proof_dir"/{home,config,cache,tmp,artifacts,tools}
clean_run() {
  env -i PATH="$clean_path" HOME="$proof_dir/home" \
    XDG_CONFIG_HOME="$proof_dir/config" XDG_CACHE_HOME="$proof_dir/cache" \
    TMPDIR="$proof_dir/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 "$@"
}
cd "$script_dir"
sha256sum --check files.sha256
[[ "$proof_mode" == baseline || "$proof_mode" == comparison ]]
[[ "$(git -C "$script_dir" rev-parse HEAD)" == "$tooling_head" ]]
printf '%s\n' "$tooling_head" > "$proof_dir/artifacts/tooling-head.txt"
cp files.sha256 "$proof_dir/artifacts/tooling-files.sha256"
cp pins.json "$proof_dir/artifacts/source-pins.json"
clean_run npm install --prefix "$proof_dir/tools" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org pnpm@12.3.4
# npm verifies the downloaded archive against this lock integrity before unpacking.
# Bind that installed package to the full repository pin before first pnpm execution.
clean_run node --input-type=module - "$source_parent/baseline/package.json" "$proof_dir/tools" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const [packageFile, tools] = process.argv.slice(2);
const pin = JSON.parse(readFileSync(packageFile, 'utf8')).packageManager;
const expected = 'pnpm@12.3.4+sha512.961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457';
assert.equal(pin, expected);
const installed = JSON.parse(readFileSync(`${tools}/package-lock.json`, 'utf8')).packages['node_modules/pnpm'];
const sri = `sha512-${Buffer.from(pin.split('+sha512.')[1], 'hex').toString('base64')}`;
assert.equal(installed.integrity, sri);
assert.equal(installed.version, '12.3.4');
assert.equal(installed.resolved, 'https://registry.npmjs.org/pnpm/-/pnpm-12.3.4.tgz');
assert.equal(JSON.parse(readFileSync(`${tools}/node_modules/pnpm/package.json`, 'utf8')).version, '12.3.4');
writeFileSync(`${tools}/../artifacts/pnpm-integrity.json`, JSON.stringify({ pin, integrity: installed.integrity, resolved: installed.resolved }));
JS
[[ "$(clean_run pnpm --version)" == 12.3.4 ]]
build_arm() {
  local arm=$1
  local src="$source_parent/$arm"
  # Source pins are reviewed tooling, never caller-controlled workflow inputs.
  clean_run node --input-type=module - "$script_dir/pins.json" "$src" "$arm" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [pinsFile, root, arm] = process.argv.slice(2);
const pin = JSON.parse(readFileSync(pinsFile, 'utf8'))[arm];
assert.ok(pin, 'Candidate needs an independently reviewed immutable pin');
assert.match(pin.head, /^[a-f0-9]{40}$/);
assert.match(pin.tree, /^[a-f0-9]{40}$/);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), pin.head);
assert.equal(git('rev-parse', 'HEAD^{tree}'), pin.tree);
assert.equal(git('status', '--porcelain'), '');
assert.equal(process.versions.node, '24.20.0');
assert.equal(JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).packageManager, 'pnpm@12.3.4+sha512.961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457');
JS
  cd "$src"
  [[ $(df -Pk . | awk 'NR==2 {print $4}') -ge 25000000 ]]
  clean_run pnpm install --frozen-lockfile 2>&1 | tee "$proof_dir/$arm-install.log"
  [[ $(df -Pk . | awk 'NR==2 {print $4}') -ge 12000000 ]]
  clean_run pnpm build qaRuntime 2>&1 | tee "$proof_dir/$arm-build.log"
  clean_run node "$script_dir/verify-build.mjs" "$script_dir/pins.json" "$src" "$proof_dir/artifacts/$arm-build.json" "$arm" write
  git diff --exit-code
  [[ -z "$(git status --porcelain)" ]]
}
observe() {
  local arm=$1
  local selection=$2
  local label=$3
  local count=$4
  local instance="$proof_dir/instances/$label"
  mkdir -p "$instance"/{home,config,cache,state,tmp,artifacts}
  # Timeout supervises the joined owner; the owner separately supervises every child group.
  set +e
  env -i PATH="$clean_path" HOME="$instance/home" \
    XDG_CONFIG_HOME="$instance/config" XDG_CACHE_HOME="$instance/cache" \
    TMPDIR="$instance/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 \
    OPENCLAW_STATE_DIR="$instance/state" \
    PROOF_EXPECT_DEDICATED="$([[ "$arm" == candidate ]] && printf 1)" \
    timeout --signal=TERM --kill-after=10s 45s \
    node "$script_dir/driver.mjs" "$source_parent/$arm" "$instance" "$label" "$selection" "$count" \
    2>&1 | tee "$proof_dir/$label-driver.log"
  local result=${PIPESTATUS[0]}
  set -e
  printf '%s\n' "$result" > "$proof_dir/artifacts/$label-exit.txt"
  if [[ -f "$instance/artifacts/$label.json" ]]; then
    cp "$instance/artifacts/$label.json" "$proof_dir/artifacts/$label.json"
  fi
  [[ "$result" == 0 ]]
  # No state/config/log archive: only the allowlisted synthetic receipt is retained.
}
build_arm baseline
observe baseline auto baseline-sanity 1
observe baseline auto baseline-before 20
# Candidate build/runtime execution begins only after successful baseline receipts exist.
if [[ "$proof_mode" == comparison ]]; then
  build_arm candidate
  observe candidate auto candidate-sanity 1
  observe candidate general candidate-general-sanity 1
  # Alternating arm order reduces monotonic host-temperature/cache-order bias.
  observe baseline auto round1-baseline 20
  observe candidate auto round1-candidate 20
  observe candidate general round1-general 20
  observe candidate general round2-general 20
  observe candidate auto round2-candidate 20
  observe baseline auto round2-baseline 20
  observe baseline auto round3-baseline 20
  observe candidate auto round3-candidate 20
  observe candidate general round3-general 20
fi
for arm in baseline candidate; do
  if [[ "$arm" == candidate && "$proof_mode" != comparison ]]; then
    continue
  fi
  clean_run node "$script_dir/verify-build.mjs" "$script_dir/pins.json" "$source_parent/$arm" "$proof_dir/artifacts/$arm-build.json" "$arm" verify
  git -C "$source_parent/$arm" diff --exit-code
  [[ -z "$(git -C "$source_parent/$arm" status --porcelain)" ]]
done
