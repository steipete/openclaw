import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [reportFile, logFile] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const log = readFileSync(logFile, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assert.equal(report.success, true);
assert.equal(report.testResults.length, 1);
assert(Number.isInteger(report.numTotalTests) && report.numTotalTests > 0);
assert.equal(report.numPassedTests, report.numTotalTests);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
const suite = report.testResults[0];
assert(suite.name.replaceAll("\\", "/").endsWith("/src/cli/plugins-control-ui-build.test.ts"));
assert.equal(suite.status, "passed");
assert.equal(suite.message, "");
assert.equal(suite.assertionResults.length, report.numTotalTests);
for (const test of suite.assertionResults) {
  assert.equal(test.status, "passed", test.fullName);
  assert.deepEqual(test.failureMessages, [], test.fullName);
}

// Match diagnostic headings rather than passing test names mentioning errors.
assert.doesNotMatch(
  log,
  /^\s*(?:[⎯─━-]+\s*)?(?:Failed Suites|Failed Tests|Unhandled Errors?|Unhandled Rejections?|Unhandled Exceptions?|Uncaught Exceptions?|EnvironmentTeardownError)(?:\s|:|$)/im,
);
assert.doesNotMatch(log, /^\s*Errors\s+[1-9]\d*/im);
assert.doesNotMatch(log, /^\s*Vitest caught \d+ unhandled errors?/im);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/i);
const files = [...log.matchAll(/^\s*Test Files\s+(\d+) passed \((\d+)\)\s*$/gm)];
const tests = [...log.matchAll(/^\s*Tests\s+(\d+) passed \((\d+)\)\s*$/gm)];
assert.equal(files.length, 1, "Missing or ambiguous completed file summary");
assert.equal(tests.length, 1, "Missing or ambiguous completed test summary");
assert.equal(Number(files[0][1]), 1);
assert.equal(Number(files[0][2]), 1);
assert.equal(Number(tests[0][1]), report.numTotalTests);
assert.equal(Number(tests[0][2]), report.numTotalTests);
assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, 1);
assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
console.log(`PLUGIN_BUILD_OWNER_SUITE_COMPLETE: ${report.numTotalTests} assertions passed`);
