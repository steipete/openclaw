import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [reportFile, logFile, phase, exitCode] = process.argv.slice(2);
assert(phase === "red" || phase === "green");
const red = phase === "red";
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const log = readFileSync(logFile, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assert.equal(Number(exitCode), red ? 1 : 0);
assert.equal(report.success, !red);
const expectedFiles = red
  ? ["src/cli/plugins-control-ui-build.test.ts"]
  : [
      "src/cli/plugins-control-ui-build.test.ts",
      "src/cli/plugins-authoring-command.test.ts",
      "src/cli/plugins-feature-artifact.test.ts",
      "src/plugins/sdk-alias.test.ts",
    ];
assert.equal(report.testResults.length, expectedFiles.length);
for (const file of expectedFiles) {
  const suites = report.testResults.filter((suite) =>
    suite.name.replaceAll("\\", "/").endsWith(`/${file}`),
  );
  assert.equal(suites.length, 1, file);
  assert.equal(suites[0].message, "");
  assert(suites[0].assertionResults.length > 0);
  assert.equal(suites[0].status, red ? "failed" : "passed");
}
const tests = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(tests.length, report.numTotalTests);
assert.equal(report.numFailedTests, red ? 1 : 0);
assert.equal(report.numPendingTests, red ? 0 : 1);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.numPassedTests, tests.length - report.numFailedTests - report.numPendingTests);
if (red) assert.equal(tests.length, 14);
const regression =
  "native plugin browser builds bundles SDK source instead of stale dist under NODE_ENV=production";
const windowsOnly =
  "buildPluginLoaderJitiOptions uses an absolute Windows local application-data cache root";
assert.equal(tests.filter((test) => test.fullName === regression).length, 1);
if (!red) assert.equal(tests.filter((test) => test.fullName === windowsOnly).length, 1);
for (const test of tests) {
  if (red && test.fullName === regression) {
    assert.equal(test.status, "failed");
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages[0], /^AssertionError:/);
    assert.match(test.failureMessages[0], /plugins-control-ui-build\.test\.ts:172:\d+/);
    assert.match(test.failureMessages[0], /dist\/control-ui\//);
  } else {
    if (!red && test.fullName === windowsOnly) {
      assert(test.status === "pending" || test.status === "skipped");
    } else {
      assert.equal(test.status, "passed", test.fullName);
    }
    assert.deepEqual(test.failureMessages, [], test.fullName);
  }
}
assert.doesNotMatch(
  log,
  /^\s*(?:[⎯─━-]+\s*)?(?:Failed Suites|Unhandled Errors?|Unhandled Rejections?|Unhandled Exceptions?|Uncaught Exceptions?|EnvironmentTeardownError)(?:\s|:|$)/im,
);
if (!red) assert.doesNotMatch(log, /^\s*(?:[⎯─━-]+\s*)?Failed Tests(?:\s|:|$)/im);
assert.doesNotMatch(log, /^\s*Errors\s+[1-9]\d*/im);
assert.doesNotMatch(log, /^\s*Vitest caught \d+ unhandled errors?/im);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/i);
const summaries = (label) => [
  ...log.matchAll(new RegExp(`^\\s*${label}\\s+([^\\n]+) \\((\\d+)\\)\\s*$`, "gm")),
];
const files = summaries("Test Files");
const counts = summaries("Tests");
assert(files.length > 0 && files.length === counts.length);
const sum = (rows, state) =>
  rows.reduce(
    (total, row) =>
      total + Number(row[1].match(new RegExp(`(?:^| \\| )(\\d+) ${state}(?:$| \\| )`))?.[1] ?? 0),
    0,
  );
assert.equal(
  files.reduce((total, row) => total + Number(row[2]), 0),
  report.testResults.length,
);
assert.equal(
  counts.reduce((total, row) => total + Number(row[2]), 0),
  report.numTotalTests,
);
assert.equal(sum(counts, "passed"), report.numPassedTests);
assert.equal(sum(counts, "failed"), report.numFailedTests);
assert.equal(sum(counts, "skipped"), report.numPendingTests);
assert.equal(sum(files, "failed"), red ? 1 : 0);
assert.equal(sum(files, "passed"), red ? 0 : expectedFiles.length);
assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, files.length);
assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, files.length);
console.log(
  `PLUGIN_SOURCE_BUILD_TESTS_${phase.toUpperCase()}: ${report.numPassedTests} passed, ${report.numFailedTests} intended failures, ${report.numPendingTests} existing Windows skip`,
);
