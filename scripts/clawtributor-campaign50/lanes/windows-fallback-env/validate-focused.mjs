import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [reportFile, logFile, expectedFile, phase, exitCodeText, minimumText] = process.argv.slice(2);
const { report, log } = readCompletedReport(reportFile, logFile);
assert.ok(phase === "red" || phase === "green");
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
assert.equal(report.numPendingTestSuites, 0);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.replaceAll("\\", "/").endsWith(expectedFile));
assert.equal(suite.message, "");
const native = expectedFile.endsWith("schtasks.env-case.real.test.ts");
if (phase === "red") {
  assert.ok(native);
  assert.equal(Number(exitCodeText), 1);
  assert.equal(report.success, false);
  assert.equal(report.numTotalTests, 2);
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numFailedTests, 1);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  assert.equal(suite.status, "failed");
  assert.equal(suite.assertionResults.length, 2);
  const failed = suite.assertionResults.filter((test) => test.status === "failed");
  const passed = suite.assertionResults.filter((test) => test.status === "passed");
  assert.equal(failed.length, 1);
  assert.equal(passed.length, 1);
  assert.equal(failed[0].title, "preserves the saved override with different casing");
  assert.equal(passed[0].title, "preserves the saved override with matching casing");
  assert.equal(failed[0].failureMessages.length, 1);
  const detail = failed[0].failureMessages.join("\n");
  assert.match(detail, /PR122658_ENV_OVERRIDE_LOST/);
  assert.match(detail, /inherited/);
  assert.match(detail, /configured/);
} else {
  assert.equal(Number(exitCodeText), 0);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numFailedTests, 0);
  assert.equal(suite.status, "passed");
  assert.ok(report.numPassedTests >= Number(minimumText));
  if (native) {
    assert.equal(report.numTotalTests, 2);
    assert.equal(report.numPassedTests, 2);
    assert.equal(report.numPendingTests, 0);
    assert.equal(report.numTodoTests, 0);
    assert.ok(suite.assertionResults.every((test) => test.status === "passed"));
  }
}
console.log(`Accepted ${phase} completed test report: ${expectedFile}`);
