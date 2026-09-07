import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";
const [reportFile, logFile] = process.argv.slice(2);
const { report, log } = readCompletedReport(reportFile, logFile);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
const files = [
  "src/auto-reply/reply/agent-runner-memory.test.ts",
  "src/auto-reply/reply/memory-flush.test.ts",
  "src/auto-reply/reply/reply-state.test.ts",
  "src/agents/context.test.ts",
  "src/agents/context.opencode-go.test.ts",
];
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, files.length);
let total = 0;
for (const file of files) {
  const matches = report.testResults.filter((suite) =>
    suite.name.replaceAll("\\", "/").endsWith(`/${file}`),
  );
  assert.equal(matches.length, 1, file);
  const suite = matches[0];
  assert.ok(suite.assertionResults.length > 0, file);
  for (const test of suite.assertionResults) {
    assert.equal(test.status, "passed", test.fullName);
    assert.deepEqual(test.failureMessages, [], test.fullName);
  }
  total += suite.assertionResults.length;
}
assert.equal(report.numTotalTests, total);
assert.equal(report.numPassedTests, total);
const tests = report.testResults.flatMap((suite) => suite.assertionResults);
for (const name of [
  "prepared-flush",
  "prepared-preflight",
  "authored-cap",
  "provider-mismatch",
  "missing-catalog",
]) {
  assert.equal(
    tests.filter(
      (test) =>
        test.fullName ===
        `runMemoryFlushIfNeeded uses ${name} catalog facts for maintenance decisions`,
    ).length,
    1,
  );
}
for (const name of [
  "Responses server compaction host/transport parity keeps prepared-only OpenAI window gates aligned",
  "Responses server compaction host/transport parity keeps prepared active cap below an authored n… gates aligned",
  "uses a prepared-only Anthropic window for its enabled server floor",
])
  assert.equal(tests.filter((test) => test.fullName === name).length, 1, name);
console.log(`PREPARED_CATALOG_GREEN_UNITS_CONFIRMED files=${files.length} tests=${total}`);
