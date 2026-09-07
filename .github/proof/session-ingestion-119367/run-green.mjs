import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sourceDir, proofDir] = process.argv.slice(2);
const { runCommandWithTimeout } = await import(
  pathToFileURL(path.join(sourceDir, "dist/plugin-sdk/process-runtime.js")).href
);
const receiptPath = path.join(proofDir, "artifacts/candidate-checks.json");
const receipt = { complete: false, commands: [], suites: [] };
const record = () => fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
const gitRange = [
  "--base",
  "3f22e84d4e5da068a2c619ec8786aac038ef534c",
  "--head",
  "fea93117677b54350218956b0c25634a1a318117",
];
const changedPaths = [
  "extensions/memory-core/src/dreaming-ingestion-state.ts",
  "extensions/memory-core/src/session-backfill.ts",
  "extensions/memory-core/src/session-ingestion.test.ts",
  "extensions/memory-core/src/session-ingestion.ts",
  "packages/memory-host-sdk/src/engine-sessions.ts",
  "packages/memory-host-sdk/src/host/session-files-reset-revision.test.ts",
  "packages/memory-host-sdk/src/host/session-files.ts",
  "src/plugin-sdk/memory-core-host-engine-sessions.ts",
];
async function run(label, args, timeoutMs) {
  const startedAt = Date.now();
  const result = await runCommandWithTimeout([process.execPath, ...args], {
    cwd: sourceDir,
    baseEnv: {},
    env: { ...process.env, OPENCLAW_VITEST_MAX_WORKERS: "2" },
    input: "",
    timeoutMs,
    killProcessTree: true,
    maxOutputBytes: 16 * 1024 * 1024,
    terminateOnOutputLimit: true,
  });
  receipt.commands.push({
    label,
    code: result.code,
    termination: result.termination,
    cleanup: result.cleanup,
    elapsedMs: Date.now() - startedAt,
  });
  await record();
  if (result.code !== 0 || result.termination !== "exit") {
    // Bounded failure diagnostics remain in Actions logs, outside the artifact allowlist.
    console.error(`${label} stdout tail:\n${result.stdout.slice(-8192)}`);
    console.error(`${label} stderr tail:\n${result.stderr.slice(-8192)}`);
  }
  assert.equal(result.termination, "exit", `${label} did not finish normally`);
  assert.equal(result.cleanup, "normal", `${label} cleanup was not normal`);
  assert.equal(result.code, 0, `${label} failed`);
}
async function suite(label, config, files, requiredTitles = []) {
  const reportPath = path.join(proofDir, `${label}.json`);
  await run(
    label,
    [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      config,
      "--configLoader",
      "runner",
      ...files,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    600_000,
  );
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numPendingTestSuites, 0);
  assert.ok(report.numPassedTests > 0);
  for (const file of report.testResults) {
    assert.equal(file.status, "passed");
    assert.equal(file.message, "");
  }
  for (const file of files) {
    assert.ok(
      report.testResults.some((result) => result.name.endsWith(file)),
      `${file} was not collected`,
    );
  }
  const tests = report.testResults.flatMap((file) => file.assertionResults);
  for (const test of tests) {
    assert.ok(["passed", "skipped", "todo"].includes(test.status), "test must have settled");
  }
  for (const title of requiredTitles) {
    assert.equal(tests.find((test) => test.title === title)?.status, "passed", title);
  }
  receipt.suites.push({
    label,
    passed: report.numPassedTests,
    skipped: report.numPendingTests,
    todo: report.numTodoTests,
    files: report.testResults.map((file) => ({
      path: path.relative(sourceDir, file.name),
      passed: file.assertionResults.filter((test) => test.status === "passed").length,
      skipped: file.assertionResults.filter((test) => test.status === "skipped").length,
    })),
    requiredTitles,
  });
  await record();
}
await run(
  "changed-check-plan",
  ["scripts/check-changed.mjs", "--dry-run", ...gitRange, "--", ...changedPaths],
  120_000,
);
await suite(
  "memory-owner-tests",
  "test/vitest/vitest.extension-memory.config.ts",
  [
    "extensions/memory-core/src/session-ingestion.test.ts",
    "extensions/memory-core/src/session-backfill.test.ts",
    "extensions/memory-core/src/dreaming-phases.test.ts",
  ],
  [
    "resumes an append after consuming 1 snapshot lines",
    "resumes an append after consuming 2 snapshot lines",
    "drains >80 unseen transcript messages across multiple unchanged sweeps",
    "stages idempotently, converges duplicate facts, and rolls back staged artifacts",
  ],
);
await suite(
  "session-export-tests",
  "test/vitest/vitest.unit.config.ts",
  [
    "packages/memory-host-sdk/src/host/session-files.test.ts",
    "packages/memory-host-sdk/src/host/session-files.path.test.ts",
    "packages/memory-host-sdk/src/host/session-files-archive-identity.test.ts",
    "packages/memory-host-sdk/src/host/session-files.windows-ownership.test.ts",
    "packages/memory-host-sdk/src/host/session-files.provenance.test.ts",
    "packages/memory-host-sdk/src/host/session-files-reset-revision.test.ts",
    "packages/memory-host-sdk/src/host/session-files-yield.test.ts",
    "packages/memory-host-sdk/src/host/session-reset-recall.test.ts",
  ],
  ["accepts a transcript append but invalidates its prefix hash after reset"],
);
await run(
  "canonical-changed-checks",
  ["scripts/check-changed.mjs", ...gitRange, "--", ...changedPaths],
  1_200_000,
);
receipt.complete = true;
await record();
