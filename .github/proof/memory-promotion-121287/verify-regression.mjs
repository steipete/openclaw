import assert from "node:assert/strict";
import fs from "node:fs/promises";

const [reportPath, receiptPath] = process.argv.slice(2);
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 0);
// Vitest counts both the file suite and its enclosing describe as failed.
assert.equal(report.numFailedTestSuites, 2);
assert.equal(report.testResults.length, 1);
assert.ok(
  report.testResults[0].name.endsWith("extensions/memory-core/src/short-term-promotion.test.ts"),
);
assert.equal(report.testResults[0].status, "failed");
assert.equal(report.testResults[0].message, "");
const failed = report.testResults
  .flatMap((file) => file.assertionResults)
  .filter((test) => test.status === "failed");
assert.equal(failed.length, 1);
assert.equal(
  failed[0].title,
  "keeps blocked origins out of ranking before applying the candidate limit",
);
const message = failed[0].failureMessages.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
assert.match(
  message,
  /expected \[\s*1,\s*2,\s*3,\s*4,\s*5\s*\] to deeply equal \[\s*3,\s*4,\s*5\s*\]/,
);
assert.match(message, /short-term-promotion\.test\.ts/);
await fs.writeFile(
  receiptPath,
  `${JSON.stringify(
    {
      expectedFailure: true,
      test: failed[0].title,
      receivedLines: [1, 2, 3, 4, 5],
      expectedLines: [3, 4, 5],
      failedTests: report.numFailedTests,
      failedSuites: report.numFailedTestSuites,
      passedTests: report.numPassedTests,
    },
    null,
    2,
  )}\n`,
);
