#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
mkdir -p "$evidence_dir"
test_path=src/config/io.write-config.test.ts
git show "$SOURCE_SHA:$test_path" > "$evidence_dir/original-test.ts"
git apply --check "$lane_dir/137713-regression.patch"
git apply "$lane_dir/137713-regression.patch"
set +e
node scripts/run-vitest.mjs "$test_path" -t 'prefix recovery (preserves|publishes)' \
  --reporter=json --outputFile="$evidence_dir/baseline.json" > "$evidence_dir/baseline.log" 2>&1
baseline_exit=$?
set -e
node - "$evidence_dir/baseline.json" "$baseline_exit" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.argv[3], '1');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.equal(file.message, '');
const active = file.assertionResults.filter(test => ['passed', 'failed'].includes(test.status));
assert.equal(active.length, 4);
const expected = new Map([
  ['prefix recovery preserves the config after a failed write', /Found and updated/],
  ['prefix recovery preserves the config after a failed chmod', /promise resolved[\s\S]*true[\s\S]*instead of rejecting/],
  ['prefix recovery preserves the config after a failed rename', /promise resolved[\s\S]*true[\s\S]*instead of rejecting/],
  ['prefix recovery publishes private config without pathname chmod', /expected 420 to be 384/],
]);
for (const test of active) {
  assert.equal(test.status, 'failed');
  const pattern = expected.get(test.title);
  assert.ok(pattern, 'unexpected failed assertion');
  assert.match(test.failureMessages.join('\n').replace(/\u001b\[[0-9;]*m/g, ''), pattern);
  expected.delete(test.title);
}
assert.equal(expected.size, 0);
console.log('DOCTOR_OWNER_BASELINE_RED: all four publication invariants failed as expected');
NODE
cp "$evidence_dir/original-test.ts" "$test_path"
git apply --check "$lane_dir/137713-candidate.patch"
git apply "$lane_dir/137713-candidate.patch"
node scripts/run-vitest.mjs src/config/io.write-config.test.ts src/config/io.observe-recovery.test.ts \
  > "$evidence_dir/candidate-tests.log" 2>&1
pnpm build > "$evidence_dir/candidate-build.log" 2>&1
python3 "$lane_dir/doctor-prefix-proof.py" "$target_dir" "$evidence_dir/doctor" \
  > "$evidence_dir/doctor.log" 2>&1
rg -q '^DOCTOR_PREFIX_PROOF_OK ' "$evidence_dir/doctor.log"
git diff --check
git diff --binary > "$evidence_dir/candidate.patch"
sha256sum src/config/io.recovery.ts src/commands/doctor-config-preflight.ts "$test_path" > "$evidence_dir/candidate-files.sha256"
