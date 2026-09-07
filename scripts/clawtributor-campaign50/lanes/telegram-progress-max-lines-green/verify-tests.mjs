import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
const [evidence, lane, exit] = process.argv.slice(2);
assert.equal(exit, "0");
const { report, log } = readCompletedReport(
  path.join(evidence, "tests.json"),
  path.join(evidence, "tests.log"),
);
assert.doesNotMatch(
  log,
  /Some tests are still running when generating the JSON report|\[test\] retrying|heap out of memory|no-output timeout|close timed out/i,
);
assert.equal(report.success, true);
assert.equal(report.numTotalTests, 37);
assert.equal(report.numPassedTests, 37);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert(
  suite.name
    .replaceAll("\\", "/")
    .endsWith("/extensions/telegram/src/bot-message-dispatch.progress-updates.test.ts"),
);
assert.equal(suite.status, "passed");
assert.equal(suite.message, "");
assert.equal(suite.assertionResults.length, 37);
const expected = JSON.parse(fs.readFileSync(path.join(lane, "expected-tests.json"), "utf8"));
assert.deepEqual(suite.assertionResults.map((test) => test.title).sort(), expected.slice().sort());
for (const test of suite.assertionResults) {
  assert.equal(test.status, "passed");
  assert.deepEqual(test.failureMessages, []);
  assert.deepEqual(test.ancestorTitles, ["dispatchTelegramMessage progress-updates"]);
  assert.equal(test.fullName, `dispatchTelegramMessage progress-updates ${test.title}`);
}
const reportSets = [...log.matchAll(/^\[test\] native report set: (.+)$/gm)];
assert(reportSets.length <= 1);
if (reportSets.length === 1) {
  const directory = reportSets[0][1];
  assert(path.resolve(directory).startsWith(`${path.resolve(evidence)}${path.sep}`));
  const index = JSON.parse(fs.readFileSync(path.join(directory, "index.json"), "utf8"));
  assert.equal(index.complete, true);
  assert.equal(index.error, "");
  assert.equal(index.merge.code, 0);
  assert.equal(index.merge.signal, null);
  assert.equal(index.merge.noOutputTimedOut, false);
  assert.equal(index.merge.groupJoined, true);
  assert(index.entries.length > 0);
  for (const entry of index.entries) {
    assert.equal(entry.state, "finished");
    assert.equal(entry.acceptedAttempt, 1);
    assert.equal(entry.attempts.length, 1);
    const attempt = entry.attempts[0];
    assert.equal(attempt.error, undefined);
    assert.equal(attempt.outcome.code, 0);
    assert.equal(attempt.outcome.signal, null);
    assert.equal(attempt.outcome.noOutputTimedOut, false);
    assert.equal(attempt.outcome.groupJoined, true);
    const capture = JSON.parse(fs.readFileSync(`${attempt.json}.capture.json`, "utf8"));
    assert.equal(capture.ignoreUnhandledErrors, false);
    assert.equal(capture.processTimedOut, false);
    assert.equal(capture.ended.reason, "passed");
    assert.equal(capture.ended.unhandledErrors, 0);
    assert.equal(capture.ended.failedModules, 0);
    assert.equal(capture.ended.suiteErrors, 0);
  }
}
console.log("All37 unchanged Telegram cases passed with complete reports");
