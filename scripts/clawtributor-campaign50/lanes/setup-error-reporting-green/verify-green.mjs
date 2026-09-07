import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [evidenceDir, exitCode, ownerExitCode] = process.argv.slice(2);
assert.equal(Number(exitCode), 0, "candidate regression process must pass");
assert.equal(Number(ownerExitCode), 0, "owner suites must pass");
const { report } = readCompletedReport(
  path.join(evidenceDir, "tests.json"),
  path.join(evidenceDir, "tests.log"),
);
assert.equal(report.success, true);
assert.equal(report.numPassedTests, 9);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(
  suite.name
    .replaceAll("\\", "/")
    .endsWith("/src/system-agent/setup-inference-error-reporting.test.ts"),
);
assert.equal(suite.status, "passed");
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
  assert.equal(test.status, "passed", test.fullName);
  assert.deepEqual(test.failureMessages, []);
}
const { report: owners, log: ownerLog } = readCompletedReport(
  path.join(evidenceDir, "owners.json"),
  path.join(evidenceDir, "owners.log"),
);
assert.equal(owners.success, true);
assert.equal(owners.numFailedTests, 0);
assert.equal(owners.numPendingTests, 0);
assert.equal(owners.numTodoTests, 0);
assert.ok(owners.numPassedTests > 0);
assert.equal(owners.numTotalTests, owners.numPassedTests);
const reportSets = [...ownerLog.matchAll(/^\[test\] native report set: (.+)$/gm)];
assert.equal(reportSets.length, 1, "expected one native aggregate owner report");
const originalIndex = path.join(reportSets[0][1], "index.json");
const retained = path.join(evidenceDir, "native-owners");
mkdirSync(retained, { recursive: true });
copyFileSync(originalIndex, path.join(retained, "index.json"));
const index = JSON.parse(readFileSync(originalIndex, "utf8"));
assert.equal(index.complete, true);
assert.equal(index.error, "");
assert.ok(index.entries.length > 0);
for (const [entryIndex, entry] of index.entries.entries()) {
  assert.equal(entry.state, "finished");
  assert.equal(entry.acceptedAttempt, 1);
  assert.equal(entry.attempts.length, 1, "a retry cannot satisfy candidate proof");
  const attempt = entry.attempts[0];
  assert.equal(attempt.error, undefined);
  assert.equal(attempt.outcome.code, 0);
  assert.equal(attempt.outcome.signal, null);
  assert.equal(attempt.outcome.noOutputTimedOut, false);
  const originalCapture = `${attempt.json}.capture.json`;
  copyFileSync(originalCapture, path.join(retained, `capture-${entryIndex}.json`));
  const capture = JSON.parse(readFileSync(originalCapture, "utf8"));
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.ended.reason, "passed");
  assert.equal(capture.ended.unhandledErrors, 0);
  assert.equal(capture.ended.failedModules, 0);
  assert.equal(capture.ended.suiteErrors, 0);
}
const expectedOwners = [
  "src/system-agent/setup-inference.test.ts",
  "src/commands/system-agent-with-inference.test.ts",
  "src/logging/redact.test.ts",
];
assert.equal(owners.testResults.length, expectedOwners.length);
for (const file of expectedOwners) {
  const matches = owners.testResults.filter((entry) =>
    entry.name.replaceAll("\\", "/").endsWith("/" + file),
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "passed");
  assert.ok(matches[0].assertionResults.length > 0);
  for (const test of matches[0].assertionResults) {
    assert.equal(test.status, "passed", test.fullName);
    assert.deepEqual(test.failureMessages, []);
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
    let message;
    if (json) {
      assert.deepEqual(record.stderr, []);
      assert.equal(record.stdout.length, 1);
      const payload = JSON.parse(record.stdout[0]);
      assert.deepEqual(Object.keys(payload).sort(), ["ok", "status", "error", "guidance"].sort());
      assert.equal(payload.ok, false);
      assert.equal(payload.status, phase === "capture" ? "unavailable" : "auth");
      assert.equal(payload.guidance, guidance);
      message = payload.error;
    } else {
      assert.deepEqual(record.stdout, []);
      assert.equal(record.stderr.length, 1);
      assert.ok(record.stderr[0].endsWith("\n" + guidance));
      message = record.stderr[0].slice(0, -guidance.length - 1);
    }
    assert.ok(message.startsWith(prefix));
    if (phase === "drift") {
      assert.ok(message.includes("verified inference owner changed"));
    } else {
      const marker = `dependency-${phase}-reason-140392`;
      assert.equal(message.split(marker).length, 2);
      if (phase === "capture")
        assert.ok(message.includes("Refresh or reinstall the plugin and retry."));
      assert.ok(message.includes("OPENAI_API_KEY="));
      assert.ok(message.includes("access_token"));
      assert.ok(message.includes("***"));
      for (const sample of [
        "sk-140392syntheticfixturetoken123456789",
        "140392-structured-placeholder",
        "PR140392_PRIVATE_SAMPLE",
      ]) {
        assert.ok(!message.includes(sample));
      }
    }
  }
  summaries.push({ phase, json, rootRemoved: true, faultReached: record.faultReached });
}
const verdict = {
  verdict: "SYNTHETIC_OWNER_COMMAND_CANDIDATE_CONFIRMED",
  passedCauseCases: 6,
  passedControls: 3,
  ownerTests: owners.numPassedTests,
  cases: summaries,
  targetCodeExecutedByValidator: false,
};
writeFileSync(path.join(evidenceDir, "verdict.json"), JSON.stringify(verdict, null, 2));
console.log("PR140392_OWNER_COMMAND_CANDIDATE_CONFIRMED");
