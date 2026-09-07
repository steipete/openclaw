import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readCompletedReport } from "./completed-report.mjs";

const [reportFile, logFile, mode, exit, sourcePath] = process.argv.slice(2);
assert(mode === "red" || mode === "green");
const { report, log } = readCompletedReport(reportFile, logFile);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
const suites = report.testResults;
const tests = suites.flatMap((suite) => suite.assertionResults);
const failed = tests.filter((test) => test.status === "failed");
const cases = tests.filter((test) =>
  test.fullName.startsWith("sessionsCommand preserves token values in text and JSON ("),
);
assert.equal(cases.length, 9);
assert.equal(new Set(cases.map((test) => test.fullName)).size, 9);
assert.equal(report.numFailedTests, failed.length);
const runtimeCases = tests.filter(
  (test) =>
    test.fullName ===
    "sessionsCommand renders recorded runtime with current context after a same-model runtime change",
);
assert.equal(runtimeCases.length, 1);
const expectedRed = [...cases, ...runtimeCases];
if (mode === "red") {
  assert.equal(suites.length, 1);
  assert(suites[0].name.endsWith("/src/commands/sessions.test.ts"));
  assert.equal(Number(exit), 1);
  assert.equal(report.success, false);
  assert.equal(failed.length, 10);
  assert(expectedRed.every((test) => test.status === "failed"));
  assert(
    tests.filter((test) => !expectedRed.includes(test)).every((test) => test.status === "passed"),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "12e2042a0a93f56b9ef6a53e47c158aafd8f988c83aff749f9a6ec2442072605",
  );
  assert.equal(
    source.split("\n")[210].trim(),
    "expect(singleSessionTableCells(logs)[5]).toBe(expected);",
  );
  assert.equal(source.split("\n")[351].trim(), 'expect(row).toContain("11/1.0m (0%)");');
  for (const test of failed) {
    assert.equal(test.failureMessages.length, 1);
    const message = test.failureMessages[0];
    assert.match(message, /^AssertionError:/);
    assert.match(message, cases.includes(test) ? / to be / : / to contain /);
    const frame = message.match(/src\/commands\/sessions\.test\.ts:(\d+):\d+/);
    assert.equal(
      frame?.[1],
      cases.includes(test) ? "211" : "352",
      "Failure must originate at the text-value assertion",
    );
  }
} else {
  assert.equal(Number(exit), 0);
  assert.equal(report.success, true);
  assert.equal(failed.length, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert(tests.every((test) => test.status === "passed"));
  for (const test of tests) assert.deepEqual(test.failureMessages, []);
  assert(cases.every((test) => test.status === "passed"));
  const files = [
    "src/commands/sessions.test.ts",
    "src/commands/sessions-table.test.ts",
    "src/commands/status.format.test.ts",
    "src/config/sessions/context-token-provenance.test.ts",
    "src/utils/token-format.test.ts",
  ];
  assert.equal(suites.length, files.length);
  for (const file of files) {
    const suite = suites.find((entry) => entry.name.endsWith(`/${file}`));
    assert(suite, file);
    assert.equal(suite.status, "passed");
    assert(suite.assertionResults.some((test) => test.status === "passed"));
  }
}
console.log(
  `SESSION_TOKEN_UNIT_${mode.toUpperCase()}_VERIFIED passed=${report.numPassedTests} failed=${failed.length}`,
);
