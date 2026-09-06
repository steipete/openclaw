import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";
const [reportFile, logFile] = process.argv.slice(2);
const { report } = readCompletedReport(reportFile, logFile);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(
  suite.name.replaceAll("\\", "/").endsWith("/src/auto-reply/reply/commands-update.test.ts"),
);
assert.equal(report.numTotalTests, 16);
assert.equal(report.numPassedTests, 16);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.success, true);
assert.equal(suite.assertionResults.length, 16);
for (const test of suite.assertionResults) {
  assert.equal(test.status, "passed", test.fullName);
  assert.equal(test.failureMessages.length, 0);
}
console.log("UPDATE_COMMAND_SIBLING_CONFIRMED");
