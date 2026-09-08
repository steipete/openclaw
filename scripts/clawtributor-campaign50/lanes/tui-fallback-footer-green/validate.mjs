import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const evidence = process.argv[2];
const stage = process.argv[3];
const code = Number(process.argv[4]);
const { report, log } = readCompletedReport(
  path.join(evidence, `${stage}.json`),
  path.join(evidence, `${stage}.log`),
);
if (stage !== "siblings") assert.equal(report.testResults.length, 1);
assert.equal(report.numTodoTests ?? 0, 0);
const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(assertions.length, report.numTotalTests);
assert.ok(assertions.every((test) => ["passed", "failed", "skipped"].includes(test.status)));
const selected = assertions.filter((test) => test.status !== "skipped");

if (stage === "owner") {
  assert.equal(code, 0);
  assert.equal(report.success, true);
  assert.equal(selected.length, 18);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPassedTests, 18);
  assert.ok(
    selected.every((test) => test.status === "passed" && test.failureMessages.length === 0),
  );
  const names = selected.map((test) => test.fullName);
  for (const title of [
    "updates the displayed model from fallback lifecycle steps",
    "refreshes the fallback model for a pending run",
    "refreshes the fallback model for a tracked run",
    "ignores fallback model updates for unrelated runs",
  ])
    assert.equal(names.filter((name) => name.endsWith(title)).length, 1);
  assert.equal(
    names.filter((name) =>
      name.includes("preserves model state for an invalid reported destination"),
    ).length,
    14,
  );
  writeFileSync(
    path.join(evidence, "owner-accepted.json"),
    JSON.stringify({ selected: names, allPassed: true }, null, 2),
  );
} else if (stage === "siblings") {
  assert.equal(code, 0);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.ok(selected.length > 0);
  assert.ok(
    selected.every((test) => test.status === "passed" && test.failureMessages.length === 0),
  );
  const expectedFiles = [
    "tui-attachment-failures.test.ts",
    "tui-session-actions.test.ts",
    "tui-formatters.test.ts",
  ];
  assert.deepEqual(
    report.testResults.map((suite) => path.basename(suite.name)).sort(),
    expectedFiles.sort(),
  );
  writeFileSync(
    path.join(evidence, "siblings-accepted.json"),
    JSON.stringify({ allPassed: true, count: selected.length }, null, 2),
  );
} else {
  assert.equal(stage, "pty");
  assert.equal(code, 0);
  assert.equal(report.success, true);
  assert.equal(selected.length, 1);
  assert.equal(
    selected[0].fullName,
    "refreshes the footer only for an accepted fallback destination without reloading history",
  );
  assert.equal(selected[0].status, "passed");
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numFailedTests, 0);
  assert.equal(selected[0].failureMessages.length, 0);
  const frames = [...log.matchAll(/TUI_FALLBACK_FRAME (\{[^\n]*\})/g)].map((match) =>
    JSON.parse(match[1]),
  );
  const exits = [...log.matchAll(/TUI_FALLBACK_EXIT (\{[^\n]*\})/g)].map((match) =>
    JSON.parse(match[1]),
  );
  assert.deepEqual(
    frames.map((frame) => frame.step),
    [1, 2, 3],
  );
  assert.equal(exits.length, 1);
  assert.equal(exits[0].exitCode, 0);
  assert.equal(exits[0].signal ?? 0, 0);
  const footer = (rows) => {
    const found = rows.filter((row) => row.includes("| session main (Main) |"));
    assert.equal(found.length, 1);
    return found[0];
  };
  const initial = footer(frames[0].before);
  assert.match(initial, /gpt-4o/);
  let selectedRun;
  for (const frame of frames) {
    assert.equal(frame.cols, 100);
    assert.equal(frame.rows, 30);
    assert.deepEqual(frame.before, frames[0].before);
    assert.deepEqual(frame.calls, frame.initialCalls);
    assert.deepEqual(frame.initialCalls, frames[0].initialCalls);
    const sends = frame.calls.filter((entry) => entry.method === "sendChat");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].payload.message, "fallback footer proof");
    assert.equal(frame.calls.filter((entry) => entry.method === "patchSession").length, 0);
    assert.deepEqual(frame.selection, {
      method: "fallbackSelection",
      payload: { step: frame.step, model: "gpt-4o" },
    });
    const event = frame.event.payload;
    assert.equal(frame.event.method, "fallbackEvent");
    assert.equal(event.stream, "lifecycle");
    assert.equal(event.data.phase, "fallback_step");
    assert.equal(event.data.fallbackStepFinalOutcome, "next_fallback");
    assert.equal(
      event.data.fallbackStepToModel,
      frame.step === 2 ? "malformed" : "anthropic/claude-sonnet-4",
    );
    assert.equal(event.sessionKey, sends[0].payload.sessionKey);
    if (frame.step === 1) assert.equal(event.runId, "foreign-run");
    else if (frame.step === 2) {
      assert.equal(event.runId, sends[0].payload.runId ?? "run-pty-fixture");
      selectedRun = event.runId;
    } else assert.equal(event.runId, selectedRun);
    assert.ok(frame.frame.some((row) => row.includes(`FALLBACK_EVENT_DELIVERED_${frame.step}`)));
    assert.ok(frame.frame.some((row) => row.includes("FALLBACK_RUN_ACTIVE")));
    assert.equal(
      footer(frame.frame),
      frame.step === 3 ? initial.replace("gpt-4o", "claude-sonnet-4") : initial,
    );
  }
  assert.ok(readFileSync(path.join(evidence, "pty.raw")).length > 0);
  writeFileSync(path.join(evidence, "frames.json"), JSON.stringify(frames, null, 2));
  writeFileSync(
    path.join(evidence, "candidate-observation.json"),
    JSON.stringify(
      {
        matchesExpectedUpdatedFooter: true,
        scope: "TUI received-event footer projection only",
        selectedRun,
        expected: initial.replace("gpt-4o", "claude-sonnet-4"),
        observed: footer(frames[2].frame),
        nativeExit: exits[0],
        backendSelectionUnchanged: true,
        noReloadOrPatch: true,
      },
      null,
      2,
    ),
  );
}
