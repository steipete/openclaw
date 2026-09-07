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
const owner = "src/cli/daemon-cli/status.print.test.ts";
const runtimeCases = [
  ["running", "running (pid 8000)"],
  ["stopped", "stopped"],
  ["unknown", "unknown"],
  ["absent", null],
];
const selectedTitles = runtimeCases.map(
  ([label]) => `projects diagnostic-only service state with ${label} runtime`,
);
const tests = report.testResults.flatMap((suite) =>
  suite.assertionResults.map((test) => ({ ...test, file: suite.name.replaceAll("\\", "/") })),
);
const selected = selectedTitles.map((title) => {
  const matches = tests.filter((test) => test.title === title && test.file.endsWith(`/${owner}`));
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].ancestorTitles, ["printDaemonStatus"]);
  assert.equal(matches[0].fullName, `printDaemonStatus ${title}`);
  return matches[0];
});
assert.equal(tests.length, report.numTotalTests);
assert.equal(report.numTodoTests ?? 0, 0);
assert.doesNotMatch(log, /\[test\] retrying|heap out of memory|no-output timeout/i);

function verifyCapture(capture, expectedFailure) {
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.ended.reason, expectedFailure ? "failed" : "passed");
  assert.equal(capture.ended.unhandledErrors, 0);
  assert.equal(capture.ended.failedModules, expectedFailure ? 1 : 0);
  assert.equal(capture.ended.suiteErrors, 0);
}

if (mode === "red") {
  assert.equal(exitCode, "1");
  assert.equal(report.success, false);
  assert.equal(report.testResults.length, 1);
  assert.ok(report.testResults[0].name.replaceAll("\\", "/").endsWith(`/${owner}`));
  assert.equal(report.numPassedTests, 0);
  assert.equal(report.numFailedTests, 4);
  for (const test of selected) {
    assert.equal(test.status, "failed");
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages[0], /^AssertionError: expected[\s\S]*to deeply equal/);
    assert.match(test.failureMessages[0], /src\/cli\/daemon-cli\/status\.print\.test\.ts:1419:\d+/);
  }
  assert.ok(
    tests
      .filter((test) => !selected.includes(test))
      .every((test) => test.status === "skipped" && test.failureMessages.length === 0),
  );
  assert.equal(report.numPendingTests, tests.length - 4);
  assert.equal([...log.matchAll(/^AssertionError:/gm)].length, 4);
  const diffs = [...log.matchAll(/^- Expected\n\+ Received\n\n([\s\S]*?)(?=\n\s*❯)/gm)];
  assert.equal(diffs.length, 4);
  const actualPairs = diffs
    .map((diff) => {
      const lines = diff[1].trimEnd().split("\n");
      assert.ok(lines.every((line) => /^(?:  |\+ |\- )/.test(line)));
      const decode = (excludedPrefix) =>
        JSON.parse(
          lines
            .filter((line) => !line.startsWith(excludedPrefix))
            .map((line) => line.slice(2))
            .join("\n")
            .replace(/,\s*([}\]])/g, "$1"),
        );
      return JSON.stringify([decode("+ "), decode("- ")]);
    })
    .sort();
  const expectedPairs = runtimeCases
    .map(([, runtime]) =>
      JSON.stringify([
        [
          "Service: LaunchAgent (loaded) (diagnostic only, not the probe target)",
          ...(runtime === null
            ? []
            : [`Runtime: ${runtime} (diagnostic only, not the probe target)`]),
        ],
        ["Service: LaunchAgent (loaded)", ...(runtime === null ? [] : [`Runtime: ${runtime}`])],
      ]),
    )
    .sort();
  assert.deepEqual(actualPairs, expectedPairs);
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
  const allowedSkipped = [
    [
      "src/cli/daemon-cli/status.print.test.ts",
      "printDaemonStatus shortens real Windows home casing aliases in human status",
    ],
    [
      "src/cli/daemon-cli/status.gather.test.ts",
      "gatherDaemonStatus surfaces stale updater launchd jobs only during deep status",
    ],
  ];
  const skipped = tests.filter((test) => test.status === "skipped");
  assert.equal(skipped.length, allowedSkipped.length);
  assert.equal(report.numPendingTests, allowedSkipped.length);
  for (const [file, fullName] of allowedSkipped)
    assert.equal(
      skipped.filter(
        (test) =>
          test.file.endsWith(`/${file}`) &&
          test.fullName === fullName &&
          test.failureMessages.length === 0,
      ).length,
      1,
    );
  assert.ok(
    tests.every(
      (test) => ["passed", "skipped"].includes(test.status) && test.failureMessages.length === 0,
    ),
  );
  assert.equal(report.numPassedTests, tests.filter((test) => test.status === "passed").length);
  assert.equal(report.numPassedTests + report.numPendingTests, report.numTotalTests);
  for (const role of ["diagnostic-only", "target", "undefined"]) {
    for (const runtime of ["running", "stopped", "unknown", "absent"]) {
      const title = `projects ${role} service state with ${runtime} runtime`;
      const matches = tests.filter(
        (test) => test.file.endsWith(`/${owner}`) && test.title === title,
      );
      assert.equal(matches.length, 1);
      assert.equal(matches[0].status, "passed");
    }
  }
  const expectedFiles = [
    owner,
    "src/cli/daemon-cli/status.gather.test.ts",
    "src/cli/daemon-cli/status.test.ts",
    "src/cli/daemon-cli/shared.test.ts",
    "src/daemon/runtime-format.test.ts",
    "src/cli/program/routes.test.ts",
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
console.log(`SERVICE_LABEL_140547_UNIT_${mode.toUpperCase()}_CONFIRMED`);
