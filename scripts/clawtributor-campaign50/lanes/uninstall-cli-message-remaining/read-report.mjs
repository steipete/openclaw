import assert from "node:assert/strict";
import fs from "node:fs";

export function readReport(reportFile, logFile, expectedFile, expectedNames, filtered) {
  for (const file of [reportFile, logFile]) {
    assert(fs.lstatSync(file).isFile());
    assert(fs.statSync(file).size <= 4_000_000);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const log = fs.readFileSync(logFile, "utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numPendingTestSuites, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  const suite = report.testResults[0];
  assert.equal(suite.name, expectedFile);
  assert.equal(suite.status, "passed");
  assert.equal(suite.message, "");
  const rows = suite.assertionResults;
  assert.equal(report.numTotalTests, rows.length);
  const active = rows.filter((test) => test.status === "passed");
  for (const test of rows) {
    assert(test.status === "passed" || (filtered && test.status === "skipped"));
    assert.deepEqual(test.failureMessages, []);
  }
  assert.deepEqual(
    active.map((test) => test.fullName),
    expectedNames,
  );
  assert.equal(report.numPassedTests, active.length);
  assert.equal(report.numPendingTests, rows.length - active.length);
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
  const files = [...log.matchAll(/^\s*Test Files\s+1 passed \(1\)\s*$/gm)];
  const tests = [...log.matchAll(/^\s*Tests\s+(\d+) passed(?: \| (\d+) skipped)? \((\d+)\)\s*$/gm)];
  assert.equal(files.length, 1);
  assert.equal(tests.length, 1);
  assert.equal(Number(tests[0][1]), active.length);
  assert.equal(Number(tests[0][2] ?? 0), rows.length - active.length);
  assert.equal(Number(tests[0][3]), rows.length);
  assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
  return {
    names: active.map((test) => test.fullName),
    passed: active.length,
    skipped: rows.length - active.length,
  };
}
