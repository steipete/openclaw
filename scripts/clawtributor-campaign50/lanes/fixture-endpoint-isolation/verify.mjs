import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const [mode, evidenceDir, targetDir, exitText] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { report, log } = readCompletedReport(
  path.join(evidenceDir, `${mode}.json`),
  path.join(evidenceDir, `${mode}.log`),
);
assert.doesNotMatch(
  log,
  /\[vitest-workers\] retaining |EPROCESSGROUP_CLEANUP_FAILED|ETIMEDOUT|\[vitest-unhandled\]/,
);
assert.doesNotMatch(
  log,
  /\[vitest\] process group (?:\d+|unknown) remained alive \d+ms after SIGKILL; members:/,
);
assert.equal(Number(exitText), mode === "red" ? 1 : 0);
assert.equal(report.success, mode === "green");
assert.equal(report.numTotalTests, 5);
assert.equal(report.numPassedTests, mode === "red" ? 3 : 5);
assert.equal(report.numFailedTests, mode === "red" ? 2 : 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
const file = "test/helpers/openclaw-test-instance.env.test.ts";
const capture = JSON.parse(
  fs.readFileSync(path.join(evidenceDir, `${mode}.json.capture.json`), "utf8"),
);
assert.equal(capture.root, targetDir);
assert.ok(Number.isInteger(capture.pid) && capture.pid > 1);
assert.equal(capture.ignoreUnhandledErrors, false);
assert.equal(capture.processTimedOut, false);
assert.deepEqual(capture.ended, {
  reason: mode === "red" ? "failed" : "passed",
  unhandledErrors: 0,
  failedModules: mode === "red" ? 1 : 0,
  suiteErrors: 0,
});
assert.equal(capture.projects.length, 1);
assert.equal(capture.modules.length, 1);
for (const owner of [capture.projects[0], capture.modules[0]]) {
  assert.equal(owner.name, "tooling");
  assert.equal(owner.root, targetDir);
  assert.equal(owner.config, path.join(targetDir, "test/vitest/vitest.tooling.config.ts"));
  assert.equal(owner.pool, "threads");
}
assert.equal(capture.modules[0].file, path.join(targetDir, file));
const suite = report.testResults[0];
assert.equal(suite.name, path.join(targetDir, file));
assert.equal(suite.status, mode === "red" ? "failed" : "passed");
assert.equal(suite.assertionResults.length, 5);
const rows = [
  "clean environment",
  "inherited port",
  "inherited URL",
  "explicit options.env",
  "explicit undefined deletion",
];
const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "regression.test.ts"),
  "utf8",
);
const assertionLine =
  source
    .split("\n")
    .findIndex((line) => line.includes("expect(actual, `FIXTURE_ENDPOINT_ISOLATION")) + 1;
assert.ok(assertionLine > 0);
const actuals = {
  "inherited port": { port: 19702, override: {} },
  "inherited URL": {
    port: 19701,
    override: { url: "wss://inherited.fixture.invalid", source: "env" },
  },
};
const seen = new Set();
for (const result of suite.assertionResults) {
  assert.deepEqual(result.ancestorTitles, ["test instance endpoint isolation"]);
  const row = rows.find((name) => result.title === `preserves endpoint ownership with ${name}`);
  assert.ok(row && !seen.has(row));
  seen.add(row);
  assert.equal(result.fullName, `test instance endpoint isolation ${result.title}`);
  const shouldFail = mode === "red" && Object.hasOwn(actuals, row);
  assert.equal(result.status, shouldFail ? "failed" : "passed");
  assert.ok(Array.isArray(result.failureMessages));
  assert.equal(result.failureMessages.length, shouldFail ? 1 : 0);
  if (shouldFail) {
    const message = result.failureMessages[0];
    const prefix = `AssertionError: FIXTURE_ENDPOINT_ISOLATION ${JSON.stringify(actuals[row])}: expected `;
    assert.ok(message.startsWith(prefix), "wrong baseline assertion or endpoint tuple");
    assert.equal((message.match(/AssertionError:/g) ?? []).length, 1);
    assert.doesNotMatch(message, /AggregateError|Unhandled|EnvironmentTeardownError/);
    assert.ok(message.includes(`${file}:${assertionLine}:`), "wrong originating source assertion");
    assert.ok(message.length < 16_384);
  }
}
assert.equal(seen.size, 5);
fs.writeFileSync(
  path.join(evidenceDir, `${mode}-verdict.json`),
  JSON.stringify(
    {
      mode,
      tests: 5,
      passed: mode === "red" ? 3 : 5,
      failed: mode === "red" ? 2 : 0,
      assertionLine,
      rows: [...seen],
      scope: "fixture endpoint selection only; no application process or auth/history operation",
    },
    null,
    2,
  ) + "\n",
);
console.log(`FIXTURE_ENDPOINT_${mode.toUpperCase()}_CONFIRMED`);
