import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";
const [phase, owner, reportFile, logFile, code, expectedFile] = process.argv.slice(2);
assert(["baseline", "candidate"].includes(phase));
const { report } = readCompletedReport(reportFile, logFile);
assert.equal(report.success, phase === "candidate");
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert(suite.name.endsWith(`/${expectedFile}`));
const active = suite.assertionResults.filter((test) => ["passed", "failed"].includes(test.status));
const expected = [];
if (owner === "logs") {
  for (const limit of ["undefined", "2"])
    expected.push({ title: `preserves ordering with line limit ${limit}`, failed: false });
  for (const value of ["2x", "", "   "])
    expected.push({
      title: `rejects invalid line limit ${JSON.stringify(value)}`,
      failed: value === "",
    });
} else if (owner === "models") {
  for (const [key, partial] of [
    ["probeTimeout", "5000ms"],
    ["probeConcurrency", "2.5"],
    ["probeMaxTokens", "64x"],
  ]) {
    for (const value of [partial, "", "   "])
      expected.push({
        title: `rejects invalid probe numeric option ${JSON.stringify({ [key]: value })}`,
        failed: value === "",
      });
  }
  for (const options of [{}, { probeTimeout: "1.5", probeConcurrency: "1", probeMaxTokens: "1" }])
    expected.push({
      title: `forwards probe numeric options ${JSON.stringify(options)}`,
      failed: false,
    });
} else assert.equal(owner, "sibling");
assert.equal(new Set(active.map((test) => test.fullName)).size, active.length);
for (const contract of expected) {
  const matches = active.filter((test) => test.title === contract.title);
  assert.equal(matches.length, 1, contract.title);
  const test = matches[0];
  const failed = phase === "baseline" && contract.failed;
  assert.equal(test.status, failed ? "failed" : "passed", contract.title);
  if (failed) {
    assert.equal(test.failureMessages.length, 1);
    const message = test.failureMessages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    assert.match(message, /promise resolved .* instead of rejecting/s);
    assert.match(message, /undefined/);
    assert(message.includes(expectedFile));
  }
}
if (phase === "baseline") {
  assert.equal(Number(code), 1);
  assert.equal(active.length, expected.length);
  assert.equal(report.numFailedTests, expected.filter((test) => test.failed).length);
  assert.equal(report.numPassedTests, expected.filter((test) => !test.failed).length);
} else {
  assert.equal(Number(code), 0);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert(active.length > 0);
  assert(active.every((test) => test.status === "passed"));
}
console.log(
  JSON.stringify({
    phase,
    owner,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
    expectedCases: expected.length,
    accepted: true,
  }),
);
