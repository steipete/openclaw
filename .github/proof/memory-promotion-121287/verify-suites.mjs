import assert from "node:assert/strict";
import fs from "node:fs/promises";

const [reportPath, receiptPath] = process.argv.slice(2);
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numFailedTestSuites, 0);
assert.ok(report.numPassedTests > 0);
const expected = new Map([
  [
    "extensions/memory-core/src/short-term-promotion.test.ts",
    "keeps blocked origins out of ranking before applying the candidate limit",
  ],
  [
    "extensions/memory-core/src/cli.test.ts",
    "keeps preview limits available and preserves mixed apply output order",
  ],
  [
    "extensions/memory-core/src/dreaming-phases.test.ts",
    "keeps edited flush-quarantined daily files untrusted and out of ranking",
  ],
]);
assert.equal(report.testResults.length, expected.size);
const files = [];
for (const [filePath, regressionTitle] of expected) {
  const matching = report.testResults.filter((file) => file.name.endsWith(filePath));
  assert.equal(matching.length, 1);
  const file = matching[0];
  assert.equal(file.status, "passed");
  assert.equal(file.message, "");
  const regressions = file.assertionResults.filter((test) => test.title === regressionTitle);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].status, "passed");
  files.push({
    path: filePath,
    passed: file.assertionResults.filter((test) => test.status === "passed").length,
    skipped: file.assertionResults.filter((test) => test.status === "skipped").length,
    regressionTitle,
    regressionPassed: true,
  });
}
await fs.writeFile(
  receiptPath,
  `${JSON.stringify({ passedTests: report.numPassedTests, files }, null, 2)}\n`,
);
