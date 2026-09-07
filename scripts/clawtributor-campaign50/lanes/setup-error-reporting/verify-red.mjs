import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [evidenceDir, exitCode] = process.argv.slice(2);
assert.equal(Number(exitCode), 1, "baseline test process must fail");
const { report, log } = readCompletedReport(
  path.join(evidenceDir, "tests.json"),
  path.join(evidenceDir, "tests.log"),
);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
assert.equal(report.success, false);
assert.equal(report.numPassedTests, 3);
assert.equal(report.numFailedTests, 6);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(
  suite.name
    .replaceAll("\\", "/")
    .endsWith("/src/system-agent/setup-inference-error-reporting.test.ts"),
);
assert.equal(suite.status, "failed");
const targetNames = ["capture", "revalidate", "callback"].flatMap((phase) =>
  [true, false].map(
    (json) => `setup inference failure reporting preserves ${phase} cause in JSON=${json}`,
  ),
);
const controlNames = [
  "setup inference failure reporting preserves a successful synthetic verification",
  "setup inference failure reporting keeps a real synthetic artifact mismatch rejected",
  "setup inference failure reporting fully masks explicitly supplied known values",
];
assert.deepEqual(
  suite.assertionResults.map((test) => test.fullName).sort(),
  [...targetNames, ...controlNames].sort(),
);
for (const test of suite.assertionResults) {
  const target = targetNames.includes(test.fullName);
  assert.equal(test.status, target ? "failed" : "passed", test.fullName);
  assert.equal(test.failureMessages.length, target ? 1 : 0);
  if (target) {
    const lines = test.failureMessages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
    assert.equal(
      lines[0],
      "AssertionError: PR140392_CAUSE_LOST: expected false to be true // Object.is equality",
    );
    assert.ok(lines.slice(1).every((line) => !line.trim() || /^\s+at /.test(line)));
  }
}
const casesDir = path.join(evidenceDir, "cases");
const expectedFiles = [
  "capture-json.json",
  "capture-text.json",
  "revalidate-json.json",
  "revalidate-text.json",
  "callback-json.json",
  "callback-text.json",
  "success-json.json",
  "drift-json.json",
];
assert.deepEqual(readdirSync(casesDir).sort(), expectedFiles.sort());
const guidance = "Run `openclaw onboard` to connect and live-test AI first.";
const prefix = "OpenClaw requires working inference: ";
const summaries = [];
for (const file of expectedFiles) {
  const record = JSON.parse(readFileSync(path.join(casesDir, file), "utf8"));
  const phase = file.split("-")[0];
  const json = file.includes("-json.");
  assert.equal(record.scenario, phase);
  assert.equal(record.json, json);
  assert.equal(record.rootRemoved, true);
  assert.equal(record.tempDirsCreated, 1);
  assert.equal(record.writes, 0);
  assert.equal(record.onboardingDispatches, 0);
  const expectedPhases =
    phase === "capture"
      ? ["capture"]
      : [
          "capture",
          "probe",
          "runtime-load",
          ...(["success", "callback"].includes(phase) ? ["callback"] : []),
        ];
  assert.deepEqual(record.phases, expectedPhases);
  assert.equal(record.callbackAttempts, ["success", "callback"].includes(phase) ? 1 : 0);
  assert.equal(record.faultReached, ["success", "drift"].includes(phase) ? 0 : 1);
  assert.equal(record.managedDispatches, phase === "success" ? 1 : 0);
  if (phase === "success") {
    assert.deepEqual(record.exits, []);
    assert.deepEqual(record.stdout, []);
    assert.deepEqual(record.stderr, []);
  } else {
    assert.deepEqual(record.exits, [1]);
    const expectedError =
      prefix +
      (phase === "capture"
        ? "Could not bind the configured inference plugin runtime. Refresh or reinstall the plugin and retry."
        : "The verified inference owner changed before validation completed. Retry the inference check.");
    if (json) {
      assert.deepEqual(record.stderr, []);
      assert.equal(record.stdout.length, 1);
      assert.deepEqual(JSON.parse(record.stdout[0]), {
        ok: false,
        status: phase === "capture" ? "unavailable" : "auth",
        error: expectedError,
        guidance,
      });
    } else {
      assert.deepEqual(record.stdout, []);
      assert.deepEqual(record.stderr, [`${expectedError}\n${guidance}`]);
    }
  }
  summaries.push({ phase, json, rootRemoved: true, faultReached: record.faultReached });
}
const verdict = {
  verdict: "SYNTHETIC_OWNER_COMMAND_BASELINE_CONFIRMED",
  failedCauseCases: 6,
  passedControls: 3,
  cases: summaries,
  targetCodeExecutedByValidator: false,
};
writeFileSync(path.join(evidenceDir, "verdict.json"), JSON.stringify(verdict, null, 2));
console.log("PR140392_OWNER_COMMAND_BASELINE_CONFIRMED");
