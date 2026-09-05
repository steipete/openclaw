#!/usr/bin/env bash
set -euo pipefail
proof_dir="$1"
evidence_dir="$2"
expected_baseline="$3"
mkdir -p "$evidence_dir/fixtures"
git rev-parse HEAD > "$evidence_dir/baseline-sha.txt"
cp "$proof_dir/ffprobe-real-proof.mts" .clawtributor-ffprobe-proof.mts
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=1 -c:a flac "$evidence_dir/fixtures/tone.flac"
ffmpeg -v error -f lavfi -i color=c=blue:s=160x96:d=1 -c:v ffv1 "$evidence_dir/fixtures/clip.mkv"
set +e
node --import ./scripts/tsx.mjs .clawtributor-ffprobe-proof.mts "$evidence_dir/fixtures" > "$evidence_dir/baseline-real.log" 2>&1
baseline_result=$?
set -e
cat "$evidence_dir/baseline-real.log"
if [[ "$expected_baseline" == red ]]; then
  [[ "$baseline_result" == 1 ]]
  rg -q 'ffprobe version [45]\.' "$evidence_dir/baseline-real.log"
  rg -q '^FFPROBE_BASELINE_RED:' "$evidence_dir/baseline-real.log"
else
  [[ "$expected_baseline" == green && "$baseline_result" == 0 ]]
  rg -q 'ffprobe version ([6-9]|[1-9][0-9]+)\.' "$evidence_dir/baseline-real.log"
  rg -q '^FFPROBE_CANDIDATE_GREEN$' "$evidence_dir/baseline-real.log"
fi
git apply "$proof_dir/137219-tests.patch"
set +e
node scripts/run-vitest.mjs src/media/media-probe.test.ts -- --reporter=json --outputFile "$evidence_dir/baseline-tests.json" > "$evidence_dir/baseline-tests.log" 2>&1
regression_result=$?
set -e
cat "$evidence_dir/baseline-tests.log"
[[ "$regression_result" == 1 ]]
node --input-type=module - "$evidence_dir/baseline-tests.json" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.equal(report.success, false);
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.numTotalTests, report.numPassedTests + 1);
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.match(file.name, /src\/media\/media-probe\.test\.ts$/);
assert.equal(file.message, "", "no file-level runtime error may stand in for a regression");
const failed = file.assertionResults.filter((test) => test.status === "failed");
assert.equal(failed.length, 1);
assert.equal(failed[0].title, "falls back to pipe input when older ffprobe lacks fd support (fd option value rejected)");
assert.match(failed[0].failureMessages.join("\n"), /expected null to deeply equal/);
assert.match(failed[0].failureMessages.join("\n"), /durationMs/);
for (const test of file.assertionResults) {
  if (test !== failed[0]) assert.equal(test.status, "passed");
}
console.log("FFPROBE_UNIT_BASELINE_RED: only quoted fd-option duration assertion failed");
NODE
git apply "$proof_dir/137219-production.patch"
node --import ./scripts/tsx.mjs .clawtributor-ffprobe-proof.mts "$evidence_dir/fixtures" 2>&1 | tee "$evidence_dir/candidate-real.log"
rg -q '^FFPROBE_CANDIDATE_GREEN$' "$evidence_dir/candidate-real.log"
node scripts/run-vitest.mjs src/media/media-probe.test.ts 2>&1 | tee "$evidence_dir/candidate-tests.log"
node_modules/.bin/oxfmt --check src/media/media-probe.ts src/media/media-probe.test.ts 2>&1 | tee "$evidence_dir/candidate-format.log"
git diff --check
git diff > "$evidence_dir/candidate.patch"
sha256sum src/media/media-probe.ts src/media/media-probe.test.ts > "$evidence_dir/candidate-files.sha256"
