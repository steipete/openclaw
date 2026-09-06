#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${SOURCE_SHA:?}" == ff41d00c264440c5b7fda67b6bf615f256a1c916 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff --exit-code
sha256sum src/cli/gateway-port-option.ts > "$evidence_dir/baseline-source.sha256"
node - "$lane_dir" <<'VERIFY_PACKET'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const lane = process.argv[2];
const packet = JSON.parse(fs.readFileSync(path.join(lane, 'PACKET.json'), 'utf8'));
for (const [file, expected] of Object.entries(packet.artifacts)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(lane, file))).digest('hex'), expected, file);
}
VERIFY_PACKET

owner_tests=(
  src/cli/gateway-port-option.test.ts
  src/cli/gateway-rpc.runtime.test.ts
  src/cli/program/register.onboard.test.ts
  src/cli/program/register.setup.test.ts
)
git apply --check "$lane_dir/regression-tests.patch"
git apply "$lane_dir/regression-tests.patch"
node - "$lane_dir" <<'VERIFY_REUSE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const lane = process.argv[2];
const directory = path.join(lane, 'reuse-wave12');
const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const packet = JSON.parse(fs.readFileSync(path.join(lane, 'PACKET.json'), 'utf8'));
assert.equal(receipt.runId, 34026143939);
assert.equal(receipt.source, packet.base);
assert.equal(receipt.node, '24.20.0');
assert.equal(receipt.pnpm, '12.3.4');
assert.equal(receipt.testsPatchSha256, packet.artifacts['regression-tests.patch']);
assert.deepEqual(receipt.owners, ['src/cli/gateway-port-option.test.ts', 'src/cli/gateway-rpc.runtime.test.ts', 'src/cli/program/register.onboard.test.ts']);
for (const [file, expected] of Object.entries(receipt.artifacts)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'), expected, file);
}
const original = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
assert.equal(original.source, packet.base);
assert.equal(original.node, receipt.node);
assert.equal(original.packageManager, JSON.parse(fs.readFileSync('package.json', 'utf8')).packageManager);
const withoutIndex = (text) => text.replace(/^index [^\n]+\n/gm, '');
assert.equal(withoutIndex(fs.readFileSync(path.join(directory, 'final-working-tree.patch'), 'utf8')), withoutIndex(fs.readFileSync(path.join(lane, 'regression-tests.patch'), 'utf8')));
for (const [file, expected] of Object.entries(packet.files)) {
  if (file.endsWith('.test.ts')) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, file);
}
VERIFY_REUSE
cp -R "$lane_dir/reuse-wave12" "$evidence_dir/reused-wave12"
for owner_test in "${owner_tests[@]:0:3}"; do
  report="$evidence_dir/reused-wave12/baseline-$(basename "$owner_test" .test.ts)"
  node "$lane_dir/verify-unit.mjs" "$report.json" "$report.log.txt" baseline 1 "$owner_test"
done
echo 'GATEWAY_PORT_BASELINE_REUSED: three completed owners from run34026143939; no rerun'
owner_test=${owner_tests[3]}
report="$evidence_dir/baseline-$(basename "$owner_test" .test.ts)"
set +e
node scripts/run-vitest.mjs "$owner_test" \
  -t 'rejects invalid port value|rejects invalid target|rejects invalid --gateway-port' \
  --reporter=verbose --reporter=json \
  --reporter="$target_dir/scripts/lib/vitest-report-capture.mts" \
  --outputFile.json="$report.json" > "$report.log" 2>&1
baseline_exit=$?
set -e
node "$lane_dir/verify-unit.mjs" "$report.json" "$report.log" baseline "$baseline_exit" \
  "$owner_test"
echo 'GATEWAY_PORT_UNIT_BASELINE_RED: eight blank-input failures and eleven controls across three reused owners plus the new setup run'
pnpm build > "$evidence_dir/baseline-build.log" 2>&1
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/port-cli-proof.mjs" \
  "$target_dir" "$evidence_dir/cli" baseline > "$evidence_dir/baseline-cli.log" 2>&1
rg -q '^GATEWAY_PORT_CLI_BASELINE_OK cases=13$' "$evidence_dir/baseline-cli.log"
sha256sum --check "$evidence_dir/baseline-source.sha256"

git apply --reverse --check "$lane_dir/regression-tests.patch"
git apply --reverse "$lane_dir/regression-tests.patch"
git diff --exit-code
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
set +e
node scripts/run-vitest.mjs "${owner_tests[@]}" src/cli/logs-cli.port.test.ts \
  src/cli/program/route-args.test.ts \
  --reporter=verbose --reporter=json --outputFile.json="$evidence_dir/candidate-unit.json" \
  > "$evidence_dir/candidate-unit.log" 2>&1
candidate_exit=$?
set -e
node "$lane_dir/verify-unit.mjs" "$evidence_dir/candidate-unit.json" \
  "$evidence_dir/candidate-unit.log" candidate "$candidate_exit"
pnpm build > "$evidence_dir/candidate-build.log" 2>&1
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/port-cli-proof.mjs" \
  "$target_dir" "$evidence_dir/cli" candidate > "$evidence_dir/candidate-cli.log" 2>&1
rg -q '^GATEWAY_PORT_CLI_CANDIDATE_OK cases=13$' "$evidence_dir/candidate-cli.log"
node - "$lane_dir/PACKET.json" <<'VERIFY_SOURCE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const packet = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [file, expected] of Object.entries(packet.files)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, file);
}
VERIFY_SOURCE
git diff --check
git diff --binary --full-index > "$evidence_dir/candidate.patch"
sha256sum "$evidence_dir/candidate.patch" > "$evidence_dir/candidate-patch.sha256"
echo GATEWAY_PORT_COMPARE_OK
