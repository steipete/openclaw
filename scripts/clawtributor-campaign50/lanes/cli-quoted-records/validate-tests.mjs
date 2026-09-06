import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [reportFile, logFile, mode, scope, exitCode] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
assert.ok(scope === "focused" || scope === "owners");
const { report } = readCompletedReport(reportFile, logFile);
const regression =
  "parseCliJson keeps records around quoted examples and ignores later quoted errors";
const control =
  "parseCliJson does not unwrap nested result-shaped JSON for non-claude json backends";
const active = report.testResults
  .flatMap((suite) => suite.assertionResults)
  .filter((entry) => entry.status === "passed" || entry.status === "failed");
if (scope === "focused") {
  assert.equal(report.testResults.length, 1);
  assert.ok(
    report.testResults[0].name
      .replaceAll("\\", "/")
      .endsWith("/src/agents/cli-output-records.test.ts"),
  );
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((entry) => entry.fullName).sort(), [regression, control].sort());
  const failure = active.find((entry) => entry.fullName === regression);
  assert.equal(active.find((entry) => entry.fullName === control).status, "passed");
  assert.equal(failure.status, mode === "red" ? "failed" : "passed");
  assert.equal(report.numPassedTests, mode === "red" ? 1 : 2);
  assert.equal(report.numFailedTests, mode === "red" ? 1 : 0);
  assert.equal(Number(exitCode), mode === "red" ? 1 : 0);
  assert.equal(report.success, mode === "green");
  assert.equal(failure.failureMessages.length, mode === "red" ? 1 : 0);
  if (mode === "red") {
    const lines = failure.failureMessages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
    assert.equal(
      lines[0],
      "AssertionError: CLI_QUOTED_RECORDS_LOST: expected '' to be 'done' // Object.is equality",
    );
    assert.ok(lines.slice(1).every((line) => !line.trim() || /^\s+at /.test(line)));
  }
} else {
  assert.equal(mode, "green");
  assert.equal(Number(exitCode), 0);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.ok(report.numPassedTests >= 199);
  const expectedFiles = [
    "packages/normalization-core/src/balanced-json.test.ts",
    "packages/normalization-core/src/json-coercion.test.ts",
    "packages/ai/src/utils/provider-error.test.ts",
    "src/agents/cli-output-records.test.ts",
    "src/agents/cli-output-jsonl.test.ts",
  ];
  assert.equal(report.testResults.length, expectedFiles.length);
  for (const file of expectedFiles) {
    const suites = report.testResults.filter((suite) =>
      suite.name.replaceAll("\\", "/").endsWith(`/${file}`),
    );
    assert.equal(suites.length, 1, file);
    assert.equal(suites[0].status, "passed");
    assert.ok(suites[0].assertionResults.some((entry) => entry.status === "passed"));
  }
}
console.log(`CLI_QUOTED_RECORDS_${scope.toUpperCase()}_${mode.toUpperCase()}_CONFIRMED`);
