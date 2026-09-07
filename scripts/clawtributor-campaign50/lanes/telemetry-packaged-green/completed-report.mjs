import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function readCompletedReport(reportFile, logFile) {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const log = readFileSync(logFile, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.doesNotMatch(
    log,
    /Failed Suites|EnvironmentTeardownError|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|globalSetup|globalTeardown|global[- ](?:setup|teardown).*?(?:error|fail)|^\s*Errors\s+[1-9]/im,
  );
  assert.ok(report.testResults.every((suite) => suite.message === ""));
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
