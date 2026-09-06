import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [jsonPath, logPath, stage, exitCode, owner] = process.argv.slice(2);
assert.ok(["baseline", "candidate"].includes(stage));
const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const log = fs.readFileSync(logPath, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
assert.doesNotMatch(
  log,
  /Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites\s+\d+/,
);
for (const file of report.testResults) assert.equal(file.message, "", file.name);
const tests = report.testResults.flatMap((file) =>
  file.assertionResults.filter((test) => ["passed", "failed"].includes(test.status)),
);
if (stage === "baseline") {
  assert.equal(exitCode, "1");
  assert.equal(report.testResults.length, 1);
  const capture = JSON.parse(fs.readFileSync(`${jsonPath}.capture.json`, "utf8"));
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.passWithNoTests, false);
  assert.deepEqual(capture.ended, {
    reason: "failed",
    unhandledErrors: 0,
    failedModules: 1,
    suiteErrors: 0,
  });
  assert.equal(capture.modules.length, 1);
  assert.equal(path.relative(capture.root, capture.modules[0].file), owner);
  assert.equal(report.testResults[0].name, capture.modules[0].file);
  const expected =
    owner === "src/infra/cli-root-options.test.ts"
      ? [
          "requires the root command before command options in route mode",
          "requires the root command before command options in command-path mode",
        ]
      : ["defers command options placed before status or health to Commander"];
  assert.ok(
    ["src/infra/cli-root-options.test.ts", "src/cli/program/route-args.test.ts"].includes(owner),
  );
  assert.deepEqual(
    tests.map((test) => test.title),
    expected,
  );
  for (const test of tests) {
    assert.equal(test.status, "failed");
    assert.equal(test.failureMessages.length, 1);
    assert.match(test.failureMessages.join("\n").replace(/\u001b\[[0-9;]*m/g, ""), /to be null/);
  }
  console.log(`ROOT_OPTION_UNIT_BASELINE_RED owner=${owner} failures=${tests.length}`);
} else {
  assert.equal(exitCode, "0");
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  for (const test of tests) assert.equal(test.status, "passed");
  const files = report.testResults.map((file) => path.basename(file.name)).sort();
  for (const file of report.testResults) {
    assert.ok(
      file.assertionResults.some((test) => test.status === "passed"),
      file.name,
    );
  }
  assert.deepEqual(
    files,
    [
      "cli-root-options.test.ts",
      "route-args.test.ts",
      "argv-invocation.test.ts",
      "register.cron-simple.test.ts",
      "error-output.test.ts",
      "argv.test.ts",
    ].sort(),
  );
  for (const name of [
    "requires the root command before command options in route mode",
    "requires the root command before command options in command-path mode",
    "defers command options placed before status or health to Commander",
  ]) {
    assert.equal(tests.filter((test) => test.title === name).length, 1, name);
  }
  console.log(`ROOT_OPTION_UNIT_CANDIDATE_GREEN cases=${tests.length}`);
}
