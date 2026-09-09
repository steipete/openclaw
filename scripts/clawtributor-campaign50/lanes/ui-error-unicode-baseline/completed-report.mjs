import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function readCompletedReport(reportFile, logFile, expectedAssertion) {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const log = readFileSync(logFile, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.doesNotMatch(
    log,
    /Failed Suites|EnvironmentTeardownError|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|globalSetup|globalTeardown|global[- ](?:setup|teardown).*?(?:error|fail)|^\s*Errors\s+[1-9]/im,
  );
  const incompleteNativeRun = [
    /^WARNING: Some tests are still running when generating the JSON report\./m,
    /^\[test\] retrying [^\n]+ after no-output timeout$/m,
    /^\[vitest\] no output for \d+ms; terminating stalled Vitest process group\.$/m,
    /^\[vitest-workers\] retaining [^\n]+: (?:compiler|borrower) join failed$/m,
    /^(?:Error: )?\[vitest\] retained temporary namespace [^\n]+; (?:descendant completion is unverified on this non-group launch|child\/group or nested resource completion was not verified)\. Stop the remaining writers before removing this exact directory\.$/m,
    /^(?:Error: )?\[vitest\] process group (?:\d+|unknown) remained alive \d+ms after SIGKILL; members: /m,
    /^\[vitest-pool\]: (?:Timeout terminating|Failed to terminate) [^\n]+ worker for test files /m,
    /^(?:Error: )?Managed command cleanup could not verify child, process group, and output closure$/m,
    /^(?:Error: )?Windows taskkill could not verify managed process tree exit$/m,
    /^FATAL ERROR: (?:[^\n]+ )?Allocation failed - (?:JavaScript heap|process) out of memory$/m,
    /^(?:Error(?: \[ERR_WORKER_OUT_OF_MEMORY\])?: )?Worker terminated due to reaching memory limit: [^\n]+$/m,
    /Source changed during compiled subprocess invocation|Compiled subprocess artifact changed|Compiled subprocess build failed|Compiled subprocess owner is closing/,
    /^\[control-ui-e2e\] unsafe cleanup: /m,
  ];
  for (const diagnostic of incompleteNativeRun) assert.doesNotMatch(log, diagnostic);
  // The native runner preserves red exit 1 when disposal also fails; retain only the exact expected assertion.
  const nativeErrors = log
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^\[?(?:[A-Za-z_$][\w$]*)?Error(?: \[[^\]\n]+\])?:/.test(line) &&
        !expectedAssertion?.test(line),
    );
  assert.deepEqual(nativeErrors, [], "Native completion or disposal failed");
  assert.ok(report.testResults.every((suite) => suite.message === ""));
  const summaries = (label) => [
    ...log.matchAll(new RegExp(`^\\s*${label}\\s+([^\\n]+) \\((\\d+)\\)\\s*$`, "gm")),
  ];
  const files = summaries("Test Files");
  const tests = summaries("Tests");
  assert.ok(files.length > 0 && tests.length === files.length, "Missing completed test summaries");
  assert.ok([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length >= files.length);
  const sum = (entries, status) =>
    entries.reduce((total, match) => {
      const count = match[1].match(new RegExp(`(?:^| \\| )(\\d+) ${status}(?:$| \\| )`));
      return total + Number(count?.[1] ?? 0);
    }, 0);
  assert.equal(
    files.reduce((total, entry) => total + Number(entry[2]), 0),
    report.testResults.length,
  );
  assert.equal(
    tests.reduce((total, entry) => total + Number(entry[2]), 0),
    report.numTotalTests,
  );
  assert.equal(sum(tests, "passed"), report.numPassedTests);
  assert.equal(sum(tests, "failed"), report.numFailedTests);
  assert.equal(sum(tests, "skipped"), report.numPendingTests);
  assert.equal(sum(tests, "todo"), report.numTodoTests ?? 0);
  assert.equal(
    sum(files, "failed"),
    report.testResults.filter((suite) => suite.status === "failed").length,
  );
  assert.equal(
    sum(files, "passed"),
    report.testResults.filter((suite) => suite.status === "passed").length,
  );
  return { report, log };
}
