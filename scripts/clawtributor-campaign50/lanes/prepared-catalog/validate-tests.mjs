import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";
const [reportFile, logFile, mode, exitCode] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report } = readCompletedReport(reportFile, logFile);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(
  suite.name.replaceAll("\\", "/").endsWith("/src/auto-reply/reply/agent-runner-memory.test.ts"),
);
const active = suite.assertionResults.filter(
  (test) => test.status === "passed" || test.status === "failed",
);
const names = ["prepared-flush", "prepared-preflight", "authored-cap", "missing-catalog"];
assert.equal(active.length, 4);
assert.equal(report.numPassedTests, mode === "red" ? 2 : 4);
assert.equal(report.numFailedTests, mode === "red" ? 2 : 0);
assert.equal(report.success, mode === "green");
assert.equal(Number(exitCode), mode === "red" ? 1 : 0);
for (const name of names) {
  const expectedName = `runMemoryFlushIfNeeded uses ${name} catalog facts for maintenance decisions`;
  const matches = active.filter((test) => test.fullName === expectedName);
  assert.equal(matches.length, 1, expectedName);
  const test = matches[0];
  const expectedFailure = mode === "red" && name.startsWith("prepared-");
  assert.equal(test.status, expectedFailure ? "failed" : "passed", name);
  assert.equal(test.failureMessages.length, expectedFailure ? 1 : 0);
  if (expectedFailure) {
    const lines = test.failureMessages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
    const marker = name === "prepared-flush" ? "FLUSH" : "PREFLIGHT";
    assert.match(
      lines[0],
      new RegExp(
        `^AssertionError: CATALOG_WINDOW_${marker}: expected 1 to be \\+?0 // Object.is equality$`,
      ),
    );
    assert.ok(lines.slice(1).every((line) => !line.trim() || /^\s+at /.test(line)));
  }
}
console.log(`PREPARED_CATALOG_UNIT_${mode.toUpperCase()}_CONFIRMED`);
