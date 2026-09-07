import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [reportFile, logFile, phase, exitCode] = process.argv.slice(2);
assert(phase === "red" || phase === "green");
const red = phase === "red";
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const log = readFileSync(logFile, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assert.equal(Number(exitCode), red ? 1 : 0);
assert.equal(report.success, !red);
assert.equal(report.testResults.length, 1);
assert.equal(report.numTotalTests, 31);
assert.equal(report.numPassedTests, red ? 30 : 31);
assert.equal(report.numFailedTests, red ? 1 : 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
const suite = report.testResults[0];
assert(
  suite.name
    .replaceAll("\\", "/")
    .endsWith("/extensions/openai/realtime-quicksilver-delegation.test.ts"),
);
assert.equal(suite.status, red ? "failed" : "passed");
assert.equal(suite.message, "");
assert.equal(suite.assertionResults.length, 31);
const regression =
  "GPT-Live sideband protocol returns a speakable failure for a delegated Unicode failure";
assert.equal(suite.assertionResults.filter((test) => test.fullName === regression).length, 1);
for (const test of suite.assertionResults) {
  const expectedFailure = red && test.fullName === regression;
  assert.equal(test.status, expectedFailure ? "failed" : "passed", test.fullName);
  if (expectedFailure) {
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages[0], /^AssertionError:/);
    assert.match(test.failureMessages[0], /realtime-quicksilver-delegation\.test\.ts:607:\d+/);
  } else {
    assert.deepEqual(test.failureMessages, [], test.fullName);
  }
}

assert.doesNotMatch(
  log,
  /^\s*(?:[⎯─━-]+\s*)?(?:Failed Suites|Unhandled Errors?|Unhandled Rejections?|Unhandled Exceptions?|Uncaught Exceptions?|EnvironmentTeardownError)(?:\s|:|$)/im,
);
if (!red) assert.doesNotMatch(log, /^\s*(?:[⎯─━-]+\s*)?Failed Tests(?:\s|:|$)/im);
assert.doesNotMatch(log, /^\s*Errors\s+[1-9]\d*/im);
assert.doesNotMatch(log, /^\s*Vitest caught \d+ unhandled errors?/im);
assert.doesNotMatch(log, /^\s*Some tests are still running when generating the JSON report/im);
const files = [...log.matchAll(/^\s*Test Files\s+([^\n]+) \((\d+)\)\s*$/gm)];
const tests = [...log.matchAll(/^\s*Tests\s+([^\n]+) \((\d+)\)\s*$/gm)];
assert.equal(files.length, 1);
assert.equal(tests.length, 1);
assert.equal(files[0][1], red ? "1 failed" : "1 passed");
assert.equal(Number(files[0][2]), 1);
assert.equal(tests[0][1], red ? "1 failed | 30 passed" : "31 passed");
assert.equal(Number(tests[0][2]), 31);
assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, 1);
assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
console.log(
  `GPT_LIVE_OWNER_${phase.toUpperCase()}: ${report.numPassedTests} passed, ${report.numFailedTests} intended failures`,
);
