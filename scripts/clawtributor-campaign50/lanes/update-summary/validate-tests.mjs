import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [reportFile, logFile, mode, exitCode] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report } = readCompletedReport(reportFile, logFile);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.replaceAll("\\", "/").endsWith("/src/agents/tools/gateway-tool.test.ts"));
assert.equal(report.numTotalTests, 22);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(suite.assertionResults.length, 22);
assert.equal(report.numPassedTests, mode === "red" ? 21 : 22);
assert.equal(report.numFailedTests, mode === "red" ? 1 : 0);
assert.equal(report.success, mode === "green");
assert.equal(Number(exitCode), mode === "red" ? 1 : 0);
const regression = "gateway update action preserves update diagnostic Unicode in tool results";
const target = suite.assertionResults.filter((test) => test.fullName === regression);
assert.equal(target.length, 1);
assert.equal(target[0].status, mode === "red" ? "failed" : "passed");
for (const test of suite.assertionResults) {
  if (test.fullName !== regression || mode === "green") {
    assert.equal(test.status, "passed", test.fullName);
    assert.equal(test.failureMessages.length, 0, test.fullName);
  }
}
if (mode === "red") {
  assert.equal(target[0].failureMessages.length, 1);
  const failure = target[0].failureMessages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = failure.split("\n");
  assert.equal(
    lines[0],
    "AssertionError: UPDATE_DIAGNOSTIC_UTF16_BOUNDARY: expected 55358 to be 114 // Object.is equality",
  );
  assert.ok(lines.slice(1).every((line) => !line.trim() || /^\s+at /.test(line)));
  assert.match(failure, /gateway-tool\.test\.ts:/);
}
console.log(`UPDATE_SUMMARY_${mode.toUpperCase()}_CONFIRMED`);
