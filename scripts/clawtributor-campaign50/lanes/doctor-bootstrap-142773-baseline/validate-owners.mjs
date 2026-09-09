import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [reportPath, logPath, inventoryPath] = process.argv.slice(2);
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const log = readFileSync(logPath, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assert.equal(report.success, true);
const expected = [
  "src/commands/doctor-bootstrap-size.test.ts",
  "src/flows/doctor-core-bootstrap-size-check.test.ts",
];
assert.equal(report.testResults.length, expected.length);
for (const name of expected) {
  const matches = report.testResults.filter((suite) =>
    suite.name.replaceAll("\\", "/").endsWith("/" + name),
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "passed");
  assert.equal(matches[0].message, "");
  assert.deepEqual(
    matches[0].assertionResults.map((test) => test.fullName).sort(),
    [...inventory[name]].sort(),
  );
}
const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(assertions.length, 9);
assert.equal(report.numTotalTests, assertions.length);
assert.equal(report.numPassedTests, assertions.length);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numFailedTestSuites, 0);
assert.equal(report.numPendingTestSuites ?? 0, 0);
assert.equal(report.snapshot?.failure ?? false, false);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
for (const test of assertions) {
  assert.equal(test.status, "passed", test.fullName);
  assert.deepEqual(test.failureMessages, []);
}
assert.doesNotMatch(
  log,
  /^\s*(?:[⎯─━-]+\s*)?(?:Failed Suites|Failed Tests|Unhandled Errors?|Unhandled Rejections?|Unhandled Exceptions?|Uncaught Exceptions?|EnvironmentTeardownError)(?:\s|:|$)/im,
);
assert.doesNotMatch(log, /^\s*Errors\s+[1-9]\d*/im);
assert.doesNotMatch(log, /^\s*Vitest caught \d+ unhandled errors?/im);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/i);
const summaries = (label) => [
  ...log.matchAll(new RegExp(`^\\s*${label}\\s+(\\d+) passed \\((\\d+)\\)\\s*$`, "gm")),
];
const files = summaries("Test Files");
const tests = summaries("Tests");
assert(files.length > 0 && tests.length === files.length);
for (const row of [...files, ...tests]) assert.equal(row[1], row[2]);
assert.equal(
  files.reduce((sum, row) => sum + Number(row[1]), 0),
  expected.length,
);
assert.equal(
  tests.reduce((sum, row) => sum + Number(row[1]), 0),
  assertions.length,
);
assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, files.length);
assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, files.length);
console.log(
  `DOCTOR_OWNERS: ${assertions.length} passed; both original suites completed without skips or global errors`,
);
