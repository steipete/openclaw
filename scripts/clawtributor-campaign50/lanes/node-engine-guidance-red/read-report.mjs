import assert from "node:assert/strict";
import fs from "node:fs";

// Native disposal errors can follow a completed test report without changing red exit 1.
export function nativeOwnershipUncertainty(output) {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const diagnostics = [
    /^(?:Error: )?\[vitest\] retained temporary namespace [^\n]+; (?:descendant completion is unverified on this non-group launch|child\/group or nested resource completion was not verified)\. Stop the remaining writers before removing this exact directory\.$/,
    /^\[vitest-workers\] retaining [^\n]+: (?:compiler|borrower) join failed$/,
    /^(?:Error: )?\[vitest\] process group (?:\d+|unknown) remained alive \d+ms after SIGKILL; members: /,
    /^\[vitest-pool\]: (?:Timeout terminating|Failed to terminate) [^\n]+ worker for test files /,
    /^(?:Error: )?Managed command cleanup could not verify child, process group, and output closure$/,
    /^(?:Error: )?Windows taskkill could not verify managed process tree exit$/,
  ];
  return clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const nativeError = /^\[?(?:[A-Za-z_$][\w$]*)?Error(?: \[[^\]\n]+\])?:/.test(line);
      return diagnostics.some((pattern) => pattern.test(line)) || nativeError;
    })
    .slice(0, 20);
}

export function readReport(reportFile, logFile, expectedFile, cases, mode) {
  assert.equal(mode, "green");
  for (const file of [reportFile, logFile]) {
    assert(fs.lstatSync(file).isFile());
    assert(fs.statSync(file).size <= 4_000_000);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const log = fs.readFileSync(logFile, "utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.deepEqual(nativeOwnershipUncertainty(log), [], "Native completion or disposal failed");
  const passed = cases.greenPassed;
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPassedTests, passed);
  assert.equal(report.numTotalTests, cases.names.length);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numPendingTestSuites, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  const suite = report.testResults[0];
  assert.equal(suite.name, expectedFile);
  assert.equal(suite.status, "passed");
  assert.equal(suite.message, "");
  const rows = suite.assertionResults;
  assert.deepEqual(
    rows.map((row) => row.fullName),
    cases.names,
  );
  for (const row of rows) {
    assert.equal(row.status, "passed", row.fullName);
    assert(Number.isFinite(row.duration) && row.duration >= 0, row.fullName);
    assert.deepEqual(row.failureMessages, []);
  }
  assert.doesNotMatch(
    log,
    /^WARNING: Some tests are still running when generating the JSON report\./m,
  );
  assert.doesNotMatch(log, /^Vitest caught [1-9][0-9]* unhandled errors? during the test run\.$/m);
  const fatalLines = [
    /^[ \t]*⎯+[ \t]+Failed Suites [1-9]\d*[ \t]+⎯+[ \t]*$/m,
    /^(?:Error: )?(?:Hook|Test) timed out in \d+ms(?: while waiting for [^\n]+)?\.$/m,
    /^EnvironmentTeardownError: /m,
    /^\[vitest\] UNHANDLED ERRORS \([1-9]\d*\)(?:: |$)/m,
    /^\[test\] retrying [^\n]+ after no-output timeout$/m,
    /^\[vitest\] no output for \d+ms; terminating stalled Vitest process group\.$/m,
    /^\[vitest-pool\]: (?:Timeout terminating|Failed to terminate) [^\n]+ worker for test files /m,
    /^\[vitest-workers\] retaining [^\n]+: (?:compiler|borrower) join failed$/m,
    /^(?:Error: )?\[vitest\] process group (?:\d+|unknown) remained alive \d+ms after SIGKILL; members: /m,
    /^\[vitest\] retained temporary namespace [^\n]+; (?:descendant completion is unverified on this non-group launch|child\/group or nested resource completion was not verified)\. Stop the remaining writers before removing this exact directory\.$/m,
    /^FATAL ERROR: (?:[^\n]+ )?Allocation failed - (?:JavaScript heap|process) out of memory$/m,
    /^(?:Error(?: \[ERR_WORKER_OUT_OF_MEMORY\])?: )?Worker terminated due to reaching memory limit: [^\n]+$/m,
  ];
  for (const diagnostic of fatalLines) assert.doesNotMatch(log, diagnostic);
  assert.doesNotMatch(log, /^[ \t]*Errors[ \t]+[1-9]/m);
  assert.equal([...log.matchAll(/^\s*Test Files\s+1 passed \(1\)\s*$/gm)].length, 1);
  const summaries = [...log.matchAll(/^\s*Tests\s+(\d+) passed \((\d+)\)\s*$/gm)];
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0].slice(1).map(Number), [passed, cases.names.length]);
  assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
  return { mode, names: cases.names, failed: 0, passed, noSkips: true };
}
