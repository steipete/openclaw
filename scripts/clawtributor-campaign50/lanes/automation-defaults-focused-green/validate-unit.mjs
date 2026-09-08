import assert from "node:assert/strict";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
import { assertMissingDefault, assertNoRunnerRecovery } from "./reader-guards.mjs";
const [evidence, mode, nativeExit] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report, log } = readCompletedReport(
  path.join(evidence, `unit-${mode}.json`),
  path.join(evidence, `unit-${mode}.log`),
);
assertNoRunnerRecovery(log);
const red = mode === "red";
assert.equal(Number(nativeExit), red ? 1 : 0);
assert.equal(report.success, !red);
assert.equal(report.testResults.length, 1);
assert.ok(report.testResults[0].name.endsWith("/src/config/schema.hints.test.ts"));
assert.equal(report.numTotalTests, 15);
assert.equal(report.numPassedTests, red ? 13 : 15);
assert.equal(report.numFailedTests, red ? 2 : 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
const cases = report.testResults[0].assertionResults;
assert.equal(cases.length, 15);
const expected = [
  "names the inherited state for cron.enabled",
  "names the inherited state for cron.triggers.enabled",
];
for (const title of expected) assert.equal(cases.filter((test) => test.title === title).length, 1);
for (const test of cases) {
  const intended = red && expected.includes(test.title);
  assert.equal(test.status, intended ? "failed" : "passed");
  assert.equal(test.failureMessages.length, intended ? 1 : 0);
  if (intended) assertMissingDefault(test.failureMessages);
}
console.log(
  JSON.stringify({
    mode,
    cases: 15,
    passing: red ? 13 : 15,
    intendedFailures: red ? 2 : 0,
    nativeExit: Number(nativeExit),
  }),
);
