import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function readCompletedReport(reportFile, logFile) {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const log = readFileSync(logFile, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
  assert.doesNotMatch(
    log,
    /Failed Suites|EnvironmentTeardownError|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|globalSetup|globalTeardown|global[- ](?:setup|teardown).*?(?:error|fail)|^\s*Errors\s+[1-9]/im,
  );
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const suite of report.testResults) {
    assert.equal(suite.message, "");
    let failed = 0;
    for (const test of suite.assertionResults) {
      assert(["passed", "failed", "skipped"].includes(test.status), test.fullName);
      assert(Array.isArray(test.failureMessages), test.fullName);
      counts[test.status] += 1;
      if (test.status === "failed") {
        failed += 1;
        assert(test.failureMessages.length > 0, test.fullName);
      } else assert.deepEqual(test.failureMessages, [], test.fullName);
    }
    assert.equal(suite.status, failed > 0 ? "failed" : "passed", suite.name);
  }
  assert.equal(report.numPassedTests, counts.passed);
  assert.equal(report.numFailedTests, counts.failed);
  assert.equal(report.numPendingTests, counts.skipped);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.numTotalTests, counts.passed + counts.failed + counts.skipped);
  assert.equal(report.success, counts.failed === 0);
  const summaries = (label) => [
    ...log.matchAll(new RegExp(`^\\s*${label}\\s+([^\\n]+) \\((\\d+)\\)\\s*$`, "gm")),
  ];
  const files = summaries("Test Files");
  const tests = summaries("Tests");
  assert.ok(files.length > 0 && tests.length === files.length, "Missing completed test summaries");
  assert.ok([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length >= files.length);
  const sum = (entries, status) =>
    entries.reduce((total, match) => {
      const count = match[1].match(new RegExp(`(?:^| \\| )(\\d+) ${status}(?:$| \\| )`));
      return total + Number(count?.[1] ?? 0);
    }, 0);
  assert.equal(
    files.reduce((total, entry) => total + Number(entry[2]), 0),
    report.testResults.length,
  );
  assert.equal(
    tests.reduce((total, entry) => total + Number(entry[2]), 0),
    report.numTotalTests,
  );
  assert.equal(sum(tests, "passed"), report.numPassedTests);
  assert.equal(sum(tests, "failed"), report.numFailedTests);
  assert.equal(sum(tests, "skipped"), report.numPendingTests);
  assert.equal(sum(tests, "todo"), report.numTodoTests ?? 0);
  assert.equal(
    sum(files, "failed"),
    report.testResults.filter((suite) => suite.status === "failed").length,
  );
  assert.equal(
    sum(files, "passed"),
    report.testResults.filter((suite) => suite.status === "passed").length,
  );
  return { report, log };
}
