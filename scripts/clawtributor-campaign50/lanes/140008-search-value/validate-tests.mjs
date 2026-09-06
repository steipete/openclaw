import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";
const [reportFile, logFile, mode, scope, exitCode] = process.argv.slice(2);
assert(["red", "green"].includes(mode));
assert(["regression", "siblings"].includes(scope));
const { report } = readCompletedReport(reportFile, logFile);
const active = report.testResults
  .flatMap((suite) => suite.assertionResults)
  .filter((test) => test.status === "passed" || test.status === "failed");
const failed = active.filter((test) => test.status === "failed");
assert.equal(report.numFailedTests, failed.length);
if (scope === "regression") {
  const names = [
    "filesystem tool output contracts keeps oversized find output inside the Code Mode value budget",
    "filesystem tool output contracts keeps oversized grep output inside the Code Mode value budget",
  ];
  assert.equal(report.testResults.length, 1);
  assert(
    report.testResults[0].name
      .replaceAll("\\", "/")
      .endsWith("/src/agents/filesystem-tools-output-contract.test.ts"),
  );
  assert.equal(active.length, 15);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.deepEqual(failed.map((test) => test.fullName).sort(), mode === "red" ? names.sort() : []);
  assert.equal(report.numPassedTests, mode === "red" ? 13 : 15);
  for (const name of names) assert.equal(active.filter((test) => test.fullName === name).length, 1);
  for (const test of failed) {
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages[0], /^AssertionError:/);
    assert.match(test.failureMessages[0], /to match object/);
    assert.match(test.failureMessages[0], /content/);
  }
  assert.equal(Number(exitCode), mode === "red" ? 1 : 0);
  assert.equal(report.success, mode === "green");
} else {
  assert.equal(mode, "green");
  assert.equal(Number(exitCode), 0);
  assert.equal(report.success, true);
  assert.equal(failed.length, 0);
  const files = [
    "find.test.ts",
    "find.fd.test.ts",
    "grep.stream-errors.test.ts",
    "grep.byte-path.test.ts",
    "render-utils.test.ts",
    "truncate.test.ts",
    "index.test.ts",
  ];
  assert.equal(report.testResults.length, files.length);
  for (const file of files) {
    const suite = report.testResults.find((entry) =>
      entry.name.replaceAll("\\", "/").endsWith(`/src/agents/sessions/tools/${file}`),
    );
    assert(suite, file);
    assert.equal(suite.status, "passed");
    assert(suite.assertionResults.some((test) => test.status === "passed"));
  }
  assert(active.length > 0);
}
console.log(`SEARCH_VALUE_${scope.toUpperCase()}_${mode.toUpperCase()}_VERIFIED`);
