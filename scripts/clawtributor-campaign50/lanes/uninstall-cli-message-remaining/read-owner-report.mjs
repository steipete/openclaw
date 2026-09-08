import assert from "node:assert/strict";
import fs from "node:fs";
import { readReport } from "./read-report.mjs";

export function readOwnerReport(reportFile, logFile, expectedFile, contract) {
  const accepted = readReport(reportFile, logFile, expectedFile, contract.activeNames, true);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const rows = report.testResults[0].assertionResults;
  // Vitest5 getSuites includes this one file and its one describe; it.each adds tests, not suites.
  assert.equal(report.numTotalTestSuites, 2);
  assert.equal(report.numPassedTestSuites, 2);
  assert.equal(report.numTotalTests, 22);
  assert.equal(accepted.passed, contract.expectedPassed);
  assert.equal(accepted.skipped, contract.expectedSkipped);
  assert.deepEqual(rows.map((row) => row.fullName).sort(), [...contract.allNames].sort());
  for (const row of rows) {
    assert.deepEqual(row.ancestorTitles, ["uninstallCommand"]);
    assert.equal(row.fullName, `uninstallCommand ${row.title}`);
    assert.equal(row.status, contract.activeNames.includes(row.fullName) ? "passed" : "skipped");
  }
  return {
    ...accepted,
    total: rows.length,
    suites: report.numTotalTestSuites,
    scope: "Three original mocked failure cases; nineteen other cases filtered without execution",
  };
}
