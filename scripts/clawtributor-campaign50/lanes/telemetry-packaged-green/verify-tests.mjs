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
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
const owner = "src/cli/telemetry-cli.test.ts";
const title = "prints parent help with a successful exit when no subcommand is given";
const tests = report.testResults.flatMap((suite) =>
  suite.assertionResults.map((test) => ({ ...test, file: suite.name.replaceAll("\\", "/") })),
);
const matches = tests.filter((test) => test.file.endsWith(`/${owner}`) && test.title === title);
assert.equal(matches.length, 1);
const selected = matches[0];
assert.deepEqual(selected.ancestorTitles, ["telemetry cli"]);
assert.equal(selected.fullName, `telemetry cli ${title}`);
assert.equal(tests.length, report.numTotalTests);
assert.equal(report.numTodoTests ?? 0, 0);
assert.doesNotMatch(log, /\[test\] retrying|heap out of memory|no-output timeout/i);

function verifyCapture(capture, failed) {
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.ended.reason, failed ? "failed" : "passed");
  assert.equal(capture.ended.unhandledErrors, 0);
  assert.equal(capture.ended.failedModules, failed ? 1 : 0);
  assert.equal(capture.ended.suiteErrors, 0);
}

if (mode === "red") {
  assert.equal(exitCode, "1");
  assert.equal(report.success, false);
  assert.equal(report.testResults.length, 1);
  assert.ok(report.testResults[0].name.replaceAll("\\", "/").endsWith(`/${owner}`));
  assert.equal(report.numPassedTests, 0);
  assert.equal(report.numFailedTests, 1);
  assert.equal(report.numPendingTests, tests.length - 1);
  assert.equal(selected.status, "failed");
  assert.equal(selected.failureMessages.length, 1);
  assert.match(
    selected.failureMessages[0],
    /^AssertionError: expected 1 to deeply equal \+?0(?:\n|$)/,
  );
  assert.match(selected.failureMessages[0], /src\/cli\/telemetry-cli\.test\.ts:209:\d+/);
  assert.equal([...log.matchAll(/^AssertionError:/gm)].length, 1);
  assert.match(log, /209\|\s+expect\(exitCode\)\.toEqual\(0\);/);
  assert.ok(
    tests
      .filter((test) => test !== selected)
      .every((test) => test.status === "skipped" && test.failureMessages.length === 0),
  );
  const capture = JSON.parse(
    readFileSync(path.join(evidenceDir, "unit-red.json.capture.json"), "utf8"),
  );
  verifyCapture(capture, true);
  assert.equal(capture.modules.length, 1);
  assert.ok(capture.modules[0].file.replaceAll("\\", "/").endsWith(`/${owner}`));
} else {
  assert.equal(exitCode, "0");
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numPassedTests, report.numTotalTests);
  assert.ok(tests.every((test) => test.status === "passed" && test.failureMessages.length === 0));
  for (const name of ["explicit help", "implicit help", "nested help"]) {
    assert.equal(
      tests.filter(
        (test) =>
          test.file.endsWith(`/${owner}`) &&
          test.title === `preserves ${name} without reading or changing telemetry`,
      ).length,
      1,
    );
  }
  const expectedFiles = [
    owner,
    "src/cli/program/parent-default-help.test.ts",
    "src/cli/program/preaction.test.ts",
    "src/cli/cli-utils.test.ts",
    "src/cli/argv.test.ts",
    "src/infra/telemetry.test.ts",
  ];
  assert.equal(report.testResults.length, expectedFiles.length);
  for (const file of expectedFiles) {
    const suites = report.testResults.filter((suite) =>
      suite.name.replaceAll("\\", "/").endsWith(`/${file}`),
    );
    assert.equal(suites.length, 1);
    assert.equal(suites[0].status, "passed");
    assert.ok(suites[0].assertionResults.some((test) => test.status === "passed"));
  }
  const reportSets = [...log.matchAll(/^\[test\] native report set: (.+)$/gm)];
  assert.equal(reportSets.length, 1);
  const index = JSON.parse(readFileSync(path.join(reportSets[0][1], "index.json"), "utf8"));
  assert.equal(index.complete, true);
  assert.equal(index.error, "");
  assert.equal(index.merge.code, 0);
  assert.equal(index.merge.signal, null);
  assert.equal(index.merge.noOutputTimedOut, false);
  assert.equal(index.merge.groupJoined, true);
  assert.ok(index.entries.length > 0);
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
    verifyCapture(JSON.parse(readFileSync(`${attempt.json}.capture.json`, "utf8")), false);
  }
}
console.log(`TELEMETRY_PARENT_140283_UNIT_${mode.toUpperCase()}_CONFIRMED`);
