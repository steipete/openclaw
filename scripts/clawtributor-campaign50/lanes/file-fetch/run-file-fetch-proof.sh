#!/usr/bin/env bash
set -euo pipefail
proof_dir="$1"
evidence_dir="$2"
mode="$3"
case "$mode" in compare|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
git rev-parse HEAD > "$evidence_dir/baseline-sha.txt"
git apply "$proof_dir/138411-tests.patch"
if [[ "$mode" == compare ]]; then
set +e
node scripts/run-vitest.mjs extensions/file-transfer/src/tools/file-fetch-tool.test.ts -- --reporter=json --outputFile "$evidence_dir/baseline-tests.json" > "$evidence_dir/baseline-tests.log" 2>&1
baseline_result=$?
set -e
cat "$evidence_dir/baseline-tests.log"
[[ "$baseline_result" == 1 ]]
node --input-type=module - "$evidence_dir/baseline-tests.json" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const names = [
  "keeps the canonical basename through real staging and forwarding: 'Quarterly report.md'",
  "keeps the canonical basename through real staging and forwarding: 'train.py'",
  "keeps the canonical basename through real staging and forwarding: 'report.xlsx'",
  "keeps Windows node basenames through real staging",
  "strips one leading UTF-8 BOM only from inline text",
];
assert.equal(report.success, false);
assert.equal(report.numFailedTests, names.length);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.equal(file.message, "", "no file-level runtime error may replace regression evidence");
const failed = file.assertionResults.filter((test) => test.status === "failed");
assert.deepEqual(failed.map((test) => test.title).sort(), names.sort());
for (const test of failed) {
  const messages = test.failureMessages.join("\n");
  if (test.title.startsWith("strips one leading")) {
    assert.match(messages, /called with arguments/);
    assert.match(messages, /bom\.md/);
  } else {
    assert.match(messages, /expected .* to be/);
  }
}
for (const test of file.assertionResults) {
  if (!names.includes(test.title)) assert.equal(test.status, "passed");
}
console.log("FILE_FETCH_BASELINE_RED: real saved/outbound basenames are missing");
NODE
fi
git apply "$proof_dir/138411-production.patch"
node scripts/run-vitest.mjs extensions/file-transfer/src/tools/file-fetch-tool.test.ts -- --reporter=json --outputFile "$evidence_dir/candidate-tests.json" 2>&1 | tee "$evidence_dir/candidate-tests.log"
node --input-type=module - "$evidence_dir/candidate-tests.json" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
const tests = report.testResults.flatMap((file) => file.assertionResults);
for (const file of report.testResults) assert.equal(file.message, "");
for (const test of tests) assert.equal(test.status, "passed");
assert.equal(tests.filter((test) => /real staging/.test(test.title)).length, 4);
console.log("FILE_FETCH_CANDIDATE_GREEN: real node bytes, staged files, outbound filenames and UUID uniqueness verified; Gateway transport/audit simulated");
NODE
node scripts/run-vitest.mjs src/media/store.test.ts 2>&1 | tee "$evidence_dir/store-sibling-tests.log"
node_modules/.bin/oxfmt --check extensions/file-transfer/src/tools/file-fetch-tool.ts extensions/file-transfer/src/tools/file-fetch-tool.test.ts 2>&1 | tee "$evidence_dir/candidate-format.log"
git diff --check
git diff > "$evidence_dir/candidate.patch"
sha256sum extensions/file-transfer/src/tools/file-fetch-tool.ts extensions/file-transfer/src/tools/file-fetch-tool.test.ts > "$evidence_dir/candidate-files.sha256"
