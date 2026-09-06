import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [mode, reportFile, logFile, exitCode, expectedFile] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report } = readCompletedReport(reportFile, logFile);
assert.equal(report.testResults.length, 1);
assert.ok(report.testResults[0].name.endsWith(`/${expectedFile}`));
const executed = report.testResults[0].assertionResults.filter((test) =>
  ["passed", "failed"].includes(test.status),
);
const title = "builds the subagent list without decoding unrelated saved prompts";
if (mode === "red") {
  assert.equal(Number(exitCode), 1);
  assert.equal(report.numFailedTests, 1);
  assert.equal(report.numPassedTests, 0);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].title, title);
  assert.equal(executed[0].status, "failed");
  assert.equal(executed[0].failureMessages.length, 1);
  assert.match(executed[0].failureMessages[0], /AssertionError: expected 20 to be \+?0/);
} else {
  assert.equal(Number(exitCode), 0);
  assert.equal(report.numFailedTests, 0);
  assert.ok(report.numPassedTests > 0);
  if (expectedFile.endsWith("/subagent-list.test.ts")) {
    const regression = executed.filter((test) => test.title === title);
    assert.equal(regression.length, 1);
    assert.equal(regression[0].status, "passed");
  }
}
console.log(
  JSON.stringify({
    mode,
    file: expectedFile,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
  }),
);
