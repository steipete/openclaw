import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [evidence, exitCode] = process.argv.slice(2);
const { report, log } = readCompletedReport(
  path.join(evidence, "pty.json"),
  path.join(evidence, "pty.log"),
);
assert.equal(exitCode, "1");
assert.equal(report.success, false);
assert.equal(report.numTotalTests, 27);
assert.equal(report.numPassedTests, 1);
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPendingTests, 25);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
assert.doesNotMatch(
  log,
  /Hook timed out|Test timed out|TimeoutError|Error: (?:timed out waiting|model selection did not finish|local TUI PTY fixture cleanup failed|local PTY fixture model provider is missing)/i,
);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
const cases = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(cases.length, 27);
const failed = cases.filter((test) => test.status === "failed");
const passed = cases.filter((test) => test.status === "passed");
assert.equal(failed.length, 1);
assert.equal(passed.length, 1);
assert.equal(
  failed[0].fullName,
  "TUI PTY real backends launches openclaw chat as local mode through a real PTY",
);
assert.equal(
  passed[0].fullName,
  "TUI PTY real backends with shared Gateway fixture launches openclaw tui against a real Gateway through a real PTY",
);
assert.equal(failed[0].failureMessages.length, 1);
assert.match(failed[0].failureMessages[0], /AssertionError/);
assert.match(failed[0].failureMessages[0], /to contain/);
assert.match(failed[0].failureMessages[0], /model set to anthropic\/claude-sonnet-5/);
for (const test of cases.filter((test) => test.status !== "failed")) {
  assert.equal(test.failureMessages.length, 0);
  assert.ok(["passed", "skipped"].includes(test.status));
}
function receipt(name) {
  const matches = [
    ...log.matchAll(new RegExp(`\\[behavior-evidence\\] ${name} (\\{[^\\n]+\\})`, "g")),
  ];
  assert.equal(matches.length, 1, `Expected one ${name} receipt`);
  return JSON.parse(matches[0][1]);
}
const identity = receipt("tui-local-cli-model-identity");
assert.equal(identity.requested, "claude-cli/claude-sonnet-5");
assert.match(identity.confirmation, /^model set to claude-cli\/claude-sonnet-5(?:\s|$)/);
assert.doesNotMatch(identity.confirmation, /anthropic\//);
assert.equal(identity.modelRequests, 0);
const roundtrip = receipt("tui-local-model-roundtrip");
assert.deepEqual(roundtrip, { alias: "chat", modelRequests: 1, replyVisible: true, exitCode: 0 });
const verdict = {
  mode: "red",
  verdict: "EXPECTED_LOCAL_MODEL_CONFIRMATION_DEFECT",
  identity,
  roundtrip,
  selected: 2,
  failed: 1,
  passed: 1,
  filtered: 25,
};
writeFileSync(path.join(evidence, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify(verdict));
