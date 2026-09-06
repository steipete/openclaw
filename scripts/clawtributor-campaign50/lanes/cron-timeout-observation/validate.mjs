import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readCompletedReport } from "./completed-report.mjs";
const [reportFile, logFile, mode, exitCode, output] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report, log } = readCompletedReport(reportFile, logFile);
assert.equal(report.testResults.length, 1);
assert.equal(report.testResults[0].message, "");
const active = report.testResults[0].assertionResults.filter(
  (entry) => entry.status === "passed" || entry.status === "failed",
);
assert.equal(active.length, 1);
assert.equal(active[0].fullName, "runCronCommandJob kills shell process groups on timeout");
assert.equal(active[0].status, mode === "red" ? "failed" : "passed");
assert.equal(report.numFailedTests, mode === "red" ? 1 : 0);
assert.equal(report.numPassedTests, mode === "red" ? 0 : 1);
assert.equal(report.success, mode === "green");
assert.equal(Number(exitCode), mode === "red" ? 1 : 0);
assert.equal(active[0].failureMessages.length, mode === "red" ? 1 : 0);
if (mode === "red") {
  const lines = active[0].failureMessages[0].split("\n");
  assert.equal(lines[0], "Error: CRON_OBSERVATION_CLOCK_FROZEN");
  assert.ok(lines.slice(1).every((line) => !line.trim() || /^\s+at /.test(line)));
  assert.doesNotMatch(active[0].failureMessages[0], /Test timed out|AssertionError|CLEANUP_FAILED/);
}
const receipts = [...log.matchAll(/CRON_PHASE_PROOF (\{[^\n]+\})/g)].map((match) =>
  JSON.parse(match[1]),
);
assert.deepEqual(
  receipts.map((entry) => entry.phase),
  mode === "red"
    ? ["observation-pending", "cleanup"]
    : ["observation-pending", "completed", "cleanup"],
);
const pending = receipts[0];
assert.equal(pending.forceAttempts, 1);
assert.ok(["sent", "ESRCH"].includes(pending.forceOutcome));
assert.ok(pending.groupPolls > 1);
assert.ok(pending.pendingTimers > 0);
assert.equal(pending.commandSettled, false);
assert.equal(pending.observationReleased, true);
const cleanup = receipts.at(-1);
assert.equal(cleanup.childGone, true);
assert.equal(cleanup.commandSettled, true);
assert.equal(cleanup.fakeTimers, false);
assert.equal(cleanup.observationReleased, true);
if (mode === "green") assert.equal(receipts[1].commandSettled, true);
writeFileSync(
  output,
  JSON.stringify({ mode, accepted: true, test: active[0].fullName, receipts }, null, 2) + "\n",
);
console.log(`CRON_OBSERVATION_${mode.toUpperCase()}_CONFIRMED`);
