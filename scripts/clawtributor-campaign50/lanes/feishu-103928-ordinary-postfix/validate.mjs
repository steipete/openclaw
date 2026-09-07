import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function validate(directory) {
  const report = JSON.parse(fs.readFileSync(path.join(directory, "tests.json"), "utf8"));
  const capture = JSON.parse(
    fs.readFileSync(path.join(directory, "tests.json.capture.json"), "utf8"),
  );
  const log = fs
    .readFileSync(path.join(directory, "output.log"), "utf8")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(report.success, true);
  assert.equal(report.numPassedTests, 3);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 8);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.numTotalTests, 11);
  assert.equal(report.testResults.length, 1);
  const suite = report.testResults[0];
  assert.equal(suite.status, "passed");
  assert.equal(suite.message, "");
  assert(suite.name.endsWith("/extensions/feishu/src/delivery-trace.test.ts"));
  assert.equal(suite.assertionResults.length, 11);
  const selected = suite.assertionResults.filter((entry) => entry.status !== "skipped");
  assert.deepEqual(selected.map((entry) => entry.fullName).sort(), [
    "feishu delivery trace goldens records final-only",
    "feishu delivery trace goldens records streaming-happy",
    "feishu delivery trace goldens settles a normal final reply with its accepted card identity",
  ]);
  for (const entry of suite.assertionResults) {
    assert.equal(entry.status, selected.includes(entry) ? "passed" : "skipped");
    assert.deepEqual(entry.failureMessages, []);
  }
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.passWithNoTests, false);
  assert.deepEqual(capture.ended, {
    reason: "passed",
    unhandledErrors: 0,
    failedModules: 0,
    suiteErrors: 0,
  });
  assert.equal(capture.modules.length, 1);
  assert(capture.modules[0].file.endsWith("/extensions/feishu/src/delivery-trace.test.ts"));
  assert(!capture.command.some((argument) => /mergeReports/.test(argument)));
  assert.doesNotMatch(
    log,
    /Failed Suites|EnvironmentTeardownError|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|Some tests are still running when generating|\[test\] retrying|no-output timeout|heap out of memory/i,
  );
  assert.match(log, /^\s*Test Files\s+1 passed \(1\)\s*$/m);
  assert.match(log, /^\s*Tests\s+3 passed\s*\|\s*8 skipped \(11\)\s*$/m);
  assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, 1);
  assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
  return {
    kind: "ordinary repaired-implementation functionality only",
    passed: selected.map((entry) => entry.fullName),
    filtered: 8,
    gatewayIngress: "not-run",
    credentialedFeishu: false,
    pausedScenarios: "not-executed-or-claimed-fixed",
  };
}
