import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [evidence, exitCode, phase] = process.argv.slice(2);
assert.ok(["pty", "embedded", "projector", "sqlite"].includes(phase));
const { report, log } = readCompletedReport(
  path.join(evidence, `${phase}.json`),
  path.join(evidence, `${phase}.log`),
);
assert.equal(exitCode, "0");
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
assert.doesNotMatch(
  log,
  /Hook timed out|Test timed out|TimeoutError|Some tests are still running when generating the JSON report|Error: (?:timed out waiting|model selection did not finish|local TUI PTY fixture cleanup failed|local PTY fixture model provider is missing)/,
);
const cases = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(cases.length, report.numTotalTests);
for (const test of cases) {
  assert.equal(test.failureMessages.length, 0);
  assert.ok(["passed", "skipped"].includes(test.status));
}
if (phase !== "pty") {
  const names = {
    embedded: "src/tui/embedded-backend.test.ts",
    projector: "src/gateway/session-utils.test.ts",
    sqlite: "src/config/sessions/session-sqlite-target.test.ts",
  };
  assert.ok(report.testResults[0].name.endsWith(names[phase]));
  assert.ok(report.numPassedTests > 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numPassedTests, report.numTotalTests);
  if (phase === "embedded") {
    assert.equal(
      cases.filter((test) =>
        test.title.startsWith(
          "scopes selected global patch policy and result to the stored owner:",
        ),
      ).length,
      2,
    );
  }
  if (phase === "projector") {
    for (const title of [
      "strips retired thinking provenance from Gateway patch results",
      "separates Claude CLI runtime metadata from canonical model identity",
      "ignores bare CLI runtime metadata when the selected default differs",
    ]) {
      assert.ok(
        cases.some((test) => test.title === title),
        `Missing owner control: ${title}`,
      );
    }
  }
  const verdict = { phase, verdict: "PASS", passed: report.numPassedTests };
  writeFileSync(
    path.join(evidence, `${phase}-verdict.json`),
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
  console.log(JSON.stringify(verdict));
} else {
  assert.equal(report.numTotalTests, 27);
  assert.equal(report.numPassedTests, 2);
  assert.equal(report.numPendingTests, 25);
  assert.deepEqual(
    cases.filter((test) => test.status === "passed").map((test) => test.fullName),
    [
      "TUI PTY real backends launches openclaw chat as local mode through a real PTY",
      "TUI PTY real backends with shared Gateway fixture launches openclaw tui against a real Gateway through a real PTY",
    ],
  );
  function receipt(name) {
    const matches = [
      ...log.matchAll(new RegExp(`\\[behavior-evidence\\] ${name} (\\{[^\\n]+\\})`, "g")),
    ];
    assert.equal(matches.length, 1, `Expected one ${name} receipt`);
    return JSON.parse(matches[0][1]);
  }
  const identity = receipt("tui-local-cli-model-identity");
  assert.equal(identity.requested, "claude-cli/claude-sonnet-5");
  assert.match(identity.confirmation, /^model set to anthropic\/claude-sonnet-5(?:\s|$)/);
  assert.doesNotMatch(identity.confirmation, /claude-cli\//);
  assert.equal(identity.modelRequests, 0);
  const roundtrip = receipt("tui-local-model-roundtrip");
  assert.deepEqual(roundtrip, { alias: "chat", modelRequests: 1, replyVisible: true, exitCode: 0 });
  const verdict = {
    phase,
    verdict: "PASS",
    identity,
    roundtrip,
    selected: 2,
    passed: 2,
    filtered: 25,
  };
  writeFileSync(path.join(evidence, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(JSON.stringify(verdict));
}
