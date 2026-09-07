import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [sourceDir, proofDir] = process.argv.slice(2);
const fixture = fileURLToPath(new URL("./scanner.test.ts", import.meta.url));
const sourcePath = "extensions/memory-core/src/session-ingestion.test.ts";
const transplanted = await fs.readFile(fixture, "utf8");
const failureLine =
  transplanted.split("\n").findIndex((line) => line.includes(".toEqual(expected)")) + 1;
assert.ok(failureLine > 0);
await fs.copyFile(fixture, path.join(sourceDir, sourcePath));
await fs.writeFile(path.join(proofDir, "regression-transplanted"), "scanner-only\n");
const { runCommandWithTimeout } = await import(
  pathToFileURL(path.join(sourceDir, "dist/plugin-sdk/process-runtime.js")).href
);
const reportPath = path.join(proofDir, "scanner-report.json");
const result = await runCommandWithTimeout(
  [
    process.execPath,
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "test/vitest/vitest.extension-memory.config.ts",
    "--configLoader",
    "runner",
    sourcePath,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  {
    cwd: sourceDir,
    baseEnv: {},
    env: process.env,
    input: "",
    timeoutMs: 240_000,
    killProcessTree: true,
    maxOutputBytes: 4 * 1024 * 1024,
    terminateOnOutputLimit: true,
  },
);
assert.equal(result.termination, "exit");
assert.equal(result.cleanup, "normal");
assert.equal(result.code, 1, "unchanged baseline must fail the two appended-snapshot regressions");
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
assert.equal(report.numTotalTests, 12);
assert.equal(report.numFailedTests, 2);
assert.equal(report.numPassedTests, 10);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
// Vitest counts both the file suite and its enclosing describe.
assert.equal(report.numFailedTestSuites, 2);
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.ok(file.name.endsWith(sourcePath));
assert.equal(file.status, "failed");
assert.equal(file.message, "", "module loading and file hooks must succeed");
const failed = file.assertionResults.filter((test) => test.status === "failed");
assert.equal(failed.length, 2);
const failures = [];
for (const consumed of [1, 2]) {
  const title = `resumes an append after consuming ${consumed} snapshot lines`;
  const failure = failed.find((test) => test.title === title);
  assert.ok(failure, title);
  const message = failure.failureMessages.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(
    message.includes(`session-ingestion.test.ts:${failureLine}:`),
    "failure must be the post-append output assertion",
  );
  assert.match(message, /expected[\s\S]*User: Alpha durable note\.[\s\S]*to deeply equal/);
  const expectedFirst =
    consumed === 1 ? "User: Bravo durable note." : "User: Charlie durable note.";
  assert.ok(message.slice(message.indexOf("to deeply equal")).includes(expectedFirst));
  failures.push({
    title,
    consumedLines: consumed,
    unexpectedOldSnippet: "User: Alpha durable note.",
    expectedFirst,
  });
}
await fs.writeFile(
  path.join(proofDir, "artifacts/expected-scanner-failures.json"),
  `${JSON.stringify(
    {
      expectedFailure: true,
      failedTests: 2,
      passedTests: 10,
      failedSuites: 2,
      sourcePath,
      failureLine,
      processCleanup: result.cleanup,
      failures,
    },
    null,
    2,
  )}\n`,
);
