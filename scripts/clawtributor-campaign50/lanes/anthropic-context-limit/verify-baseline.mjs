import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readCompletedReport } from "./completed-report.mjs";

const [reportPath, logPath, exitCode, verdictPath] = process.argv.slice(2);
const { report, log } = readCompletedReport(reportPath, logPath);
assert.equal(report.testResults.length, 1);
assert.equal(report.testResults[0].status, "failed");
assert.ok(
  report.testResults[0].name
    .replaceAll("\\", "/")
    .endsWith("/packages/ai/src/providers/anthropic-context-limit.integration.test.ts"),
);
assert.equal(report.success, false);
assert.equal(Number(exitCode), 1);
assert.equal(report.numTotalTests, 12);
assert.equal(report.numPassedTests, 8);
assert.equal(report.numFailedTests, 4);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
const results = report.testResults.flatMap((file) => file.assertionResults);
assert.equal(results.length, 12);
const expected = new Set();
for (const lane of ["direct", "managed"]) {
  for (const profile of ["buffered", "unbuffered"]) {
    for (const scenario of ["context-limit", "output-limit", "normal-stop"]) {
      expected.add(`${lane} ${profile} ${scenario}`);
    }
  }
}
for (const result of results) {
  assert.ok(expected.delete(result.title), `Unexpected or duplicate case: ${result.title}`);
  if (result.title.endsWith("context-limit")) {
    assert.equal(result.status, "failed");
    assert.equal(result.failureMessages.length, 1);
    const failure = result.failureMessages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = failure.split("\n");
    assert.match(
      lines[0],
      /^AssertionError: Unhandled stop reason: model_context_window_exceeded: expected .+error.+ to be .+length.+/,
    );
    assert.ok(lines.slice(1).every((line) => !line.trim() || /^\s+at /.test(line)));
    assert.match(failure, /anthropic-context-limit\.integration\.test\.ts:/);
  } else {
    assert.equal(result.status, "passed");
    assert.equal(result.failureMessages.length, 0);
  }
}
assert.equal(expected.size, 0);
assert.match(log, /Tests\s+4 failed\s*\|\s*8 passed\s*\(12\)/);
assert.doesNotMatch(
  log,
  /Failed Suites|Unhandled (?:Error|Rejection)|uncaught exception|FATAL ERROR|Heap out of memory/i,
);
writeFileSync(
  verdictPath,
  `${JSON.stringify({ verdict: "accepted-baseline", intendedFailures: 4, passingControls: 8, target: "Anthropic successful context-limit mapping" }, null, 2)}\n`,
);
