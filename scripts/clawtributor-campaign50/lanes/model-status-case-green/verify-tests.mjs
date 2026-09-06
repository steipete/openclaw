import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [evidenceDir, mode, exitCode] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report, log } = readCompletedReport(
  path.join(evidenceDir, `unit-${mode}.json`),
  path.join(evidenceDir, `unit-${mode}.log`),
);
const tests = report.testResults.flatMap((suite) => suite.assertionResults);
const title = (id) => `keeps model status independent of ${id} routes`;
const ownerFile = "src/commands/models/list.status.test.ts";
const selected = ["Writer", "rEaDeR"].map((id) => {
  const matches = tests.filter((test) => test.title === title(id));
  assert.equal(matches.length, 1, `exactly one ${id} test result required`);
  assert.deepEqual(matches[0].ancestorTitles, ["modelsStatusCommand auth overview"]);
  assert.equal(matches[0].fullName, `modelsStatusCommand auth overview ${title(id)}`);
  return matches[0];
});
assert.equal(selected[0].status, "passed", "noncolliding control must pass");
assert.deepEqual(selected[0].failureMessages, []);
if (mode === "red") {
  assert.equal(exitCode, "1");
  assert.equal(report.testResults.length, 1);
  assert.ok(report.testResults[0].name.replaceAll("\\", "/").endsWith(`/${ownerFile}`));
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numFailedTests, 1);
  assert.equal(selected[1].status, "failed");
  assert.equal(selected[1].failureMessages.length, 1);
  const failure = selected[1].failureMessages[0];
  assert.match(failure, /^AssertionError: expected[^\n]*to deeply equal \[\]/);
  // The frozen fd08 test blob places the empty-diagnostics assertion on line 1533.
  assert.match(failure, /src\/commands\/models\/list\.status\.test\.ts:1533:\d+/);
  assert.equal([...log.matchAll(/^AssertionError:/gm)].length, 1);
  assert.match(log, /1533\|\s+expect\(payload\.auth\.modelRouteIssues\)\.toEqual\(\[\]\);/);
  const diffs = [...log.matchAll(/^- Expected\n\+ Received\n\n([\s\S]*?)(?=\n\s*❯)/gm)];
  assert.equal(diffs.length, 1);
  const lines = diffs[0][1].trim().split("\n");
  assert.ok(lines.every((line) => /^[+-] /.test(line)));
  assert.deepEqual(
    lines.filter((line) => line.startsWith("- ")),
    ["- []"],
  );
  const received = lines
    .filter((line) => line.startsWith("+ "))
    .map((line) => line.slice(2))
    .join("\n")
    .replace(/,\s*([}\]])/g, "$1");
  assert.deepEqual(JSON.parse(received), [
    {
      kind: "incompatible",
      provider: "openai",
      model: "reader",
      code: "ambiguous-openai-route-group",
      message: "Observed OpenAI routes disagree on the Platform adapter for an authored endpoint.",
    },
  ]);
  assert.ok(
    tests.filter((test) => test !== selected[1]).every((test) => test.failureMessages.length === 0),
  );
} else {
  assert.equal(exitCode, "0");
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.numPassedTests, report.numTotalTests);
  assert.equal(tests.length, report.numTotalTests);
  assert.ok(tests.every((test) => test.status === "passed" && test.failureMessages.length === 0));
  assert.equal(selected[1].status, "passed");
  const reportSets = [...log.matchAll(/^\[test\] native report set: (.+)$/gm)];
  assert.equal(reportSets.length, 1, "expected one native aggregate report owner");
  const index = JSON.parse(readFileSync(path.join(reportSets[0][1], "index.json"), "utf8"));
  assert.equal(index.complete, true);
  assert.equal(index.error, "");
  assert.ok(index.entries.length > 0);
  for (const entry of index.entries) {
    assert.equal(entry.state, "finished");
    assert.equal(entry.acceptedAttempt, 1);
    assert.equal(entry.attempts.length, 1, "a retry cannot satisfy candidate proof");
    const attempt = entry.attempts[0];
    assert.equal(attempt.error, undefined);
    assert.equal(attempt.outcome.code, 0);
    assert.equal(attempt.outcome.signal, null);
    assert.equal(attempt.outcome.noOutputTimedOut, false);
    const capture = JSON.parse(readFileSync(`${attempt.json}.capture.json`, "utf8"));
    assert.equal(capture.ignoreUnhandledErrors, false);
    assert.equal(capture.processTimedOut, false);
    assert.equal(capture.ended.reason, "passed");
    assert.equal(capture.ended.unhandledErrors, 0);
    assert.equal(capture.ended.failedModules, 0);
    assert.equal(capture.ended.suiteErrors, 0);
  }
  const expected = [
    "src/commands/models/list.status.test.ts",
    "src/agents/openai-model-routes.test.ts",
    "src/plugins/provider-model-routes.test.ts",
    "src/agents/model-catalog-visibility.test.ts",
    "packages/model-catalog-core/src/provider-model-id-normalization.test.ts",
    "src/shared/model-key.test.ts",
    "src/shared/lazy-promise.test.ts",
  ];
  assert.equal(report.testResults.length, expected.length);
  for (const file of expected) {
    const matches = report.testResults.filter((suite) =>
      suite.name.replaceAll("\\", "/").endsWith(`/${file}`),
    );
    assert.equal(matches.length, 1, `expected suite ${file}`);
    assert.equal(matches[0].status, "passed");
    assert.ok(matches[0].assertionResults.some((test) => test.status === "passed"));
  }
}
console.log(`STATUS_CASE_THREE_ID_140099_UNIT_${mode.toUpperCase()}_CONFIRMED`);
