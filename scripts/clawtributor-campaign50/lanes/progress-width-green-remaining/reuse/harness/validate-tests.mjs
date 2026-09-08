import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [reportFile, logFile, code] = process.argv.slice(2);
assert.equal(Number(code), 0);
const { report, log } = readCompletedReport(reportFile, logFile);
assert.doesNotMatch(
  log,
  /JSON report was generated while.*(?:running|pending)|some tests are still running/i,
);
// A later successful report must not conceal a failed earlier attempt.
assert.doesNotMatch(log, /\[test\]\s+retrying\b|no-output timeout|FATAL ERROR:|out of memory/i);
assert.equal(report.success, true);
assert.equal(report.testResults.length, 2);
const expectedFiles = new Map([
  ["/src/cli/progress.test.ts", 15],
  ["/src/wizard/clack-prompter.test.ts", 35],
]);
for (const [suffix, count] of expectedFiles) {
  const matches = report.testResults.filter((suite) => suite.name.endsWith(suffix));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "passed");
  assert.equal(matches[0].assertionResults.length, count);
}
const cases = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(cases.length, 50);
assert.equal(report.numTotalTests, 50);
assert.equal(report.numPassedTests, 50);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.ok(cases.every((test) => test.status === "passed" && test.failureMessages.length === 0));
const names = [
  ...[32, 36, 80].map((columns) => `cli progress bounds spinner at ${columns} columns`),
  "cli progress suppresses animation below the frame budget",
  "cli progress does not let a finished reporter clear or unlock a newer progress line",
  "cli progress unregisters a delayed tty progress line when done before start",
  "createClackPrompter keeps completion after clearing tiny animation",
  ...[undefined, "", "First line\nSecond line"].map(
    (message) => `createClackPrompter preserves tiny completion ${JSON.stringify(message)} once`,
  ),
];
for (const name of names)
  assert.equal(cases.filter((test) => test.fullName === name).length, 1, name);
console.log(JSON.stringify({ accepted: true, files: 2, passed: 50, failed: 0 }));
