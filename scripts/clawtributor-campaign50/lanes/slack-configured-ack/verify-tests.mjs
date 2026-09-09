import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [phase, kind, reportFile, logFile, exitCode, observationDirectory] = process.argv.slice(2);
assert.ok(phase === "baseline" || phase === "candidate");
assert.ok(kind === "unit" || kind === "ingress");
const expectedAssertion =
  phase === "baseline"
    ? kind === "unit"
      ? /^AssertionError: expected null to be an instance of Promise$/
      : /^AssertionError: SLACK_PICKUP_ACK: expected \[\] to have a length of 1 but got \+?0$/
    : undefined;
const { report, log } = readCompletedReport(reportFile, logFile, expectedAssertion);
assert.doesNotMatch(log, /report is not finished|unfinished report/i);
assert.equal(report.testResults.length, 1);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(exitCode, phase === "baseline" ? "1" : "0");
assert.equal(report.success, phase === "candidate");
const tests = report.testResults[0].assertionResults;
const active = tests.filter((test) => test.status === "passed" || test.status === "failed");
assert.ok(tests.every((test) => ["passed", "failed", "skipped"].includes(test.status)));
const filtered = tests.filter((test) => test.status === "skipped");
assert.equal(filtered.length, report.numPendingTests);
for (const test of filtered) assert.deepEqual(test.failureMessages, []);
const names =
  kind === "unit"
    ? [
        "keeps the configured static ack with automatic/default status",
        "keeps the configured static ack with automatic/disabled status",
        "keeps the configured static ack with message-tool/default status",
        "keeps the configured static ack with message-tool/disabled status",
        "primes Slack status reactions when channel replies are message-tool-only",
      ]
    : ["tool-disabled", "tool-default", "automatic-disabled", "tool-enabled"];
assert.deepEqual(active.map((test) => test.title).sort(), [...names].sort());
assert.equal(report.numFailedTests, phase === "baseline" ? 2 : 0);
assert.equal(report.numPassedTests, names.length - report.numFailedTests);
const suite =
  kind === "unit"
    ? "slack prepareSlackMessage inbound contract"
    : "Slack registered pickup acknowledgement";
const sourceName = kind === "unit" ? "prepare.test.ts" : "ack-ingress.proof.test.ts";
const source = readFileSync(new URL(sourceName, import.meta.url), "utf8").split("\n");
const start =
  kind === "unit"
    ? source.findIndex((line) => line.includes('"keeps the configured static ack with $label"'))
    : 0;
assert.ok(start >= 0);
const needle =
  kind === "unit"
    ? "expect(prepared.ackReactionPromise).toBeInstanceOf(Promise)"
    : 'expect(requests, "SLACK_PICKUP_ACK")';
const failureLine = source.findIndex((line, index) => index >= start && line.includes(needle)) + 1;
assert.ok(failureLine > 0);
const targetName = kind === "unit" ? "prepare.test.ts" : "monitor.ack-ingress.proof.test.ts";
assert.ok(
  report.testResults[0].name.endsWith(
    `/extensions/slack/src/${kind === "unit" ? "monitor/message-handler/" : ""}${targetName}`,
  ),
);
for (const test of active) {
  assert.equal(test.fullName, `${suite} ${test.title}`);
  const red =
    phase === "baseline" &&
    (kind === "unit"
      ? test.title.includes("message-tool/")
      : ["tool-disabled", "tool-default"].includes(test.title));
  assert.equal(test.status, red ? "failed" : "passed");
  if (red) {
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages[0], /^AssertionError:/);
    assert.match(
      test.failureMessages[0],
      new RegExp(`${targetName.replaceAll(".", "\\.")}:${failureLine}:\\d+`),
    );
    assert.match(
      test.failureMessages[0],
      kind === "unit" ? /expected null to be an instance of Promise/ : /SLACK_PICKUP_ACK/,
    );
  } else {
    assert.deepEqual(test.failureMessages, []);
  }
}
if (kind === "ingress") {
  assert.equal(report.numPendingTests, 0);
  assert.deepEqual(
    readdirSync(observationDirectory).sort(),
    names.map((name) => `${name}.json`).sort(),
  );
  for (const name of names) {
    const value = JSON.parse(readFileSync(join(observationDirectory, `${name}.json`), "utf8"));
    assert.equal(value.id, name);
    assert.equal(value.monitorStarts, 1);
    assert.equal(value.monitorStopCalls, 2);
    assert.equal(value.ready, true);
    assert.equal(value.suiteBlocked, false);
    assert.deepEqual(value.cleanupErrors, []);
    assert.deepEqual(value.closure, {
      id: name,
      monitorJoined: true,
      apiJoined: true,
      serverClosed: true,
      ownersJoined: true,
      stateRemoved: true,
    });
    assert.equal(value.replyCalls, 1);
    assert.equal(value.visibleSends, 0);
    assert.deepEqual(value.runtimeErrors, []);
    assert.deepEqual(value.reactionRemoves, []);
    assert.ok(value.userLookups.length > 0 && value.channelLookups.length > 0);
    const red = phase === "baseline" && ["tool-disabled", "tool-default"].includes(name);
    assert.equal(value.requests.length, red ? 0 : 1);
    assert.equal(value.reactionAdds.length, value.requests.length);
    if (!red) {
      const expected = { channel: "C1", timestamp: "456", name: "eyes" };
      assert.deepEqual(value.reactionAdds, [[expected]]);
      assert.equal(value.requests[0].method, "POST");
      assert.equal(value.requests[0].path, "/api/reactions.add");
      assert.equal(value.requests[0].contentType, "application/x-www-form-urlencoded");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(value.requests[0].body)), expected);
    }
  }
}
console.log(
  JSON.stringify(
    {
      phase,
      kind,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      deliberatelyFiltered: report.numPendingTests,
      verdict: "PASS",
      liveSlack: false,
    },
    null,
    2,
  ),
);
