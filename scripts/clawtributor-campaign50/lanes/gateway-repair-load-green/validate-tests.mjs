import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [reportFile, logFile, mode, code] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
assert.equal(Number(code), mode === "red" ? 1 : 0);
const { report, log } = readCompletedReport(reportFile, logFile);
assert.doesNotMatch(
  log,
  /JSON report was generated while.*(?:running|pending)|some tests are still running/i,
);
const cases = report.testResults.flatMap((suite) => suite.assertionResults);
const owner = report.testResults.filter((suite) => suite.name.endsWith("/start-repair.test.ts"));
assert.equal(owner.length, 1);
assert.equal(owner[0].assertionResults.length, 19);
assert.equal(report.numTotalTests, cases.length);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.ok(cases.every((test) => ["passed", "failed"].includes(test.status)));
const expected = ["start", "restart"].flatMap((action) =>
  ["throws", "returns false"].map(
    (probe) =>
      `repairLoadedGatewayServiceForStart fails ${action} repair when the post-install probe ${probe}`,
  ),
);
for (const title of expected) {
  assert.equal(cases.filter((test) => test.fullName === title).length, 1, title);
}
const failed = cases.filter((test) => test.status === "failed");
assert.equal(report.numFailedTests, failed.length);
assert.equal(report.numPassedTests, cases.length - failed.length);
if (mode === "red") {
  assert.equal(report.success, false);
  assert.equal(report.testResults.length, 1);
  assert.deepEqual(failed.map((test) => test.fullName).sort(), expected.sort());
  for (const test of failed) {
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages[0], /promise resolved .* instead of rejecting/s);
  }
} else {
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, 5);
  assert.equal(failed.length, 0);
  assert.ok(cases.every((test) => test.failureMessages.length === 0));
  for (const title of [
    "restarts a disabled installed service through its native manager",
    "fails restart when an installed service cannot be inspected",
  ]) {
    assert.equal(cases.filter((test) => test.title === title).length, 1, title);
  }
}
console.log(
  JSON.stringify({
    mode,
    total: cases.length,
    passed: report.numPassedTests,
    failed: failed.length,
  }),
);
