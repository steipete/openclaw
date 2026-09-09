import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lane = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const root = mkdtempSync(path.join(output, "reader-data-only-"));
const names = [
  ...["known zero", "known positive", "unknown zero", "mixed positive"].map(
    (label) => `Usage recorded cost availability renders the recorded cost hint for ${label}`,
  ),
  ...["query", "session", "day"].map(
    (scope) =>
      `Usage recorded cost availability restores the missing-cost hint after clearing the known-zero ${scope} filter`,
  ),
  "renderUsage shows the empty state for an all-zero successful response",
];
const source = readFileSync(path.join(lane, "view.test.ts"), "utf8").split("\n");
function fixture(mode) {
  const failures = mode === "baseline" ? 4 : 0;
  const red = new Set(mode === "baseline" ? [names[0], ...names.slice(4, 7)] : []);
  const assertions = names.map((fullName) => {
    const marker = fullName === names[0] ? "USAGE_KNOWN_ZERO_HINT" : "USAGE_KNOWN_ZERO_FILTER";
    const line = source.findIndex((line) => line.includes(`"${marker}"`)) + 1;
    return {
      title: fullName,
      fullName,
      status: red.has(fullName) ? "failed" : "passed",
      failureMessages: red.has(fullName)
        ? [
            `AssertionError: ${marker}: expected recorded missing hint to equal normal hint\n at /fixture/ui/src/pages/usage/view.test.ts:${line}:1`,
          ]
        : [],
    };
  });
  assertions.push(
    ...["unselected one", "unselected two"].map((fullName) => ({
      title: fullName,
      fullName,
      status: "skipped",
      failureMessages: [],
    })),
  );
  return {
    mode,
    exitCode: mode === "baseline" ? "1" : "0",
    report: {
      success: mode === "candidate",
      numTotalTests: 10,
      numPassedTests: 8 - failures,
      numFailedTests: failures,
      numPendingTests: 2,
      numTodoTests: 0,
      numPendingTestSuites: 0,
      testResults: [
        {
          name: "/fixture/ui/src/pages/usage/view.test.ts",
          status: failures ? "failed" : "passed",
          message: "",
          assertionResults: assertions,
        },
      ],
    },
    log: `Test Files  1 ${failures ? "failed" : "passed"} (1)\nTests  ${failures ? "4 failed | 4 passed" : "8 passed"} | 2 skipped (10)\nDuration  1.00s (tests 1ms)\n`,
  };
}
const checks = [
  ["baseline exact assertion and native skipped", true, "baseline", () => {}],
  ["candidate all active passed", true, "candidate", () => {}],
  [
    "benign progress heartbeat",
    true,
    "baseline",
    (row) => {
      row.log = "[vitest] still running with no output for 30000ms.\n" + row.log;
    },
  ],
  [
    "unfinished report warning",
    false,
    "baseline",
    (row) => {
      row.log +=
        "WARNING: Some tests are still running when generating the JSON report.This is likely an internal bug in Vitest.\n";
    },
  ],
  [
    "unhandled teardown",
    false,
    "baseline",
    (row) => {
      row.log += "Unhandled Errors\nError: environment closed\n";
    },
  ],
  [
    "native cleanup error",
    false,
    "baseline",
    (row) => {
      row.log +=
        "Error: Managed command cleanup could not verify child, process group, and output closure\n";
    },
  ],
  [
    "UI unsafe cleanup",
    false,
    "baseline",
    (row) => {
      row.log +=
        "[control-ui-e2e] unsafe cleanup: fixture retirement failed; retiring owned fork\n";
    },
  ],
  [
    "retained worker",
    false,
    "baseline",
    (row) => {
      row.log += "[vitest-workers] retaining /owned: borrower join failed\n";
    },
  ],
  [
    "terminating timeout",
    false,
    "baseline",
    (row) => {
      row.log += "[vitest] no output for 30000ms; terminating stalled Vitest process group.\n";
    },
  ],
  [
    "native retry",
    false,
    "baseline",
    (row) => {
      row.log += "[test] retrying one after no-output timeout\n";
    },
  ],
  [
    "OOM",
    false,
    "baseline",
    (row) => {
      row.log +=
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
    },
  ],
  [
    "wrong assertion marker",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].assertionResults[0].failureMessages[0] =
        "AssertionError: unrelated";
    },
  ],
  [
    "wrong assertion source line",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].assertionResults[0].failureMessages[0] =
        "AssertionError: USAGE_KNOWN_ZERO_HINT: wrong failure\n at /fixture/ui/src/pages/usage/view.test.ts:1:1";
    },
  ],
  [
    "nested failure message",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].assertionResults[0].failureMessages.push("Error: hook failed");
    },
  ],
  [
    "unexpected active test",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].assertionResults[1].fullName = "foreign test";
    },
  ],
  [
    "pending native assertion",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].assertionResults[8].status = "pending";
    },
  ],
  [
    "todo native assertion",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].assertionResults[8].status = "todo";
    },
  ],
  [
    "incorrect filtered counter",
    false,
    "baseline",
    (row) => {
      row.report.numPendingTests = 1;
    },
  ],
  [
    "suite error",
    false,
    "baseline",
    (row) => {
      row.report.testResults[0].message = "hook failure";
    },
  ],
  [
    "missing completed summary",
    false,
    "baseline",
    (row) => {
      row.log = "";
    },
  ],
  [
    "missing duration",
    false,
    "baseline",
    (row) => {
      row.log = row.log.replace(/^Duration.*\n/m, "");
    },
  ],
  [
    "signal exit",
    false,
    "baseline",
    (row) => {
      row.exitCode = "143";
    },
  ],
];
const results = [];
for (const [name, accepted, mode, mutate] of checks) {
  const row = fixture(mode);
  mutate(row);
  const directory = mkdtempSync(path.join(root, "case-"));
  writeFileSync(path.join(directory, "renderer.json"), JSON.stringify(row.report));
  writeFileSync(path.join(directory, "renderer.log"), row.log);
  const result = spawnSync(
    process.execPath,
    [path.join(lane, "validate.mjs"), directory, mode, "renderer", row.exitCode],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(result.error, undefined, name);
  assert.equal(result.signal, null, name);
  assert.equal(result.status === 0, accepted, `${name}: ${result.stderr}`);
  results.push({ name, expectedAccepted: accepted, exit: result.status });
}
for (const file of ["validate.mjs", "completed-report.mjs", "verify-source.mjs", "finalize.mjs"])
  execFileSync(process.execPath, ["--check", path.join(lane, file)]);
execFileSync("/bin/bash", ["-n", path.join(lane, "run.sh")]);
writeFileSync(
  path.join(root, "RESULT.json"),
  JSON.stringify({ syntheticDataOnly: true, targetExecuted: false, checks: results }, null, 2) +
    "\n",
);
console.log(path.join(root, "RESULT.json"));
