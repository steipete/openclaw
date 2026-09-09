import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";
const lane = path.dirname(fileURLToPath(import.meta.url));
const evidence = realpathSync(process.argv[2]);
const phase = process.argv[3];
assert.ok(phase === "historical" || phase === "final");
const binding = JSON.parse(readFileSync(path.join(lane, "reuse-binding.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, expected] of Object.entries(binding.historicalHashes)) {
  assert.equal(hash(readFileSync(path.join(lane, "historical", name))), expected, name);
}
assert.equal(hash(readFileSync(path.join(lane, "candidate.patch"))), binding.finalCandidatePatch);
assert.equal(
  hash(readFileSync(path.join(lane, "historical/final-candidate.patch"))),
  binding.oldCandidatePatch,
);
const oldTest = readFileSync(path.join(lane, "tested-test.ts"), "utf8");
assert.equal(hash(oldTest), binding.oldTest);
const currentTest = readFileSync("ui/src/e2e/identity-config-refresh.e2e.test.ts", "utf8");
assert.equal(hash(currentTest), binding.finalTest);
const oldGuard = '          if (!fixture) throw new Error("Mock Gateway is not installed");';
assert.equal(oldTest.split(oldGuard).length, 2);
assert.equal(
  currentTest,
  oldTest.replace(
    oldGuard,
    '          if (!fixture) {\n            throw new Error("Mock Gateway is not installed");\n          }',
  ),
);
const ownerFiles = [
  "ui/src/lib/agents/identity.test.ts",
  "ui/src/pages/chat/chat-pane-identity.test.ts",
  "ui/src/pages/chat/chat-state.test.ts",
  "ui/src/pages/chat/chat-avatar.test.ts",
  "ui/src/pages/chat/chat-avatar-publication.test.ts",
];
for (const [reportName, logName, total, files] of [
  ["owner.json", "owner.log", 174, ownerFiles],
  ["vitest.json", "browser.log", 1, ["ui/src/e2e/identity-config-refresh.e2e.test.ts"]],
]) {
  const { report } = readCompletedReport(
    path.join(lane, "historical", reportName),
    path.join(lane, "historical", logName),
  );
  assert.equal(report.success, true);
  assert.equal(report.numTotalTests, total);
  assert.equal(report.numPassedTests, total);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.testResults.length, files.length);
  for (const file of files)
    assert.equal(report.testResults.filter((suite) => suite.name.endsWith("/" + file)).length, 1);
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(assertions.length, total);
  for (const assertion of assertions) {
    assert.equal(assertion.status, "passed");
    assert.deepEqual(assertion.failureMessages, []);
  }
}
const oldGate = readFileSync(path.join(lane, "historical/changed-check.log"), "utf8").replace(
  /\x1B\[[0-?]*[ -/]*[@-~]/g,
  "",
);
const summary = oldGate.split("[check:changed] summary").at(-1);
assert.equal([...summary.matchAll(/\sok\s/g)].length, 18);
assert.equal([...summary.matchAll(/failed:1/g)].length, 1);
assert.match(oldGate, /eslint\(curly\)/);
assert.match(oldGate, /identity-config-refresh\.e2e\.test\.ts:81:25/);
assert.match(oldGate, /Found 0 warnings and 1 error\./);
const browser = JSON.parse(
  readFileSync(path.join(lane, "historical/qualified-browser-green.json"), "utf8"),
);
assert.deepEqual(browser.observed, {
  name: "Cedar",
  avatar: "🌻",
  avatarLabel: "Cedar",
  placeholder: "Message Cedar",
});
assert.equal(browser.sender, "Cedar");
assert.equal(browser.controls.sendsBeforeSubmit, 0);
assert.equal(browser.controls.sendsAfterSubmit, 1);
assert.equal(browser.controls.replyVisible, true);
if (phase === "final") {
  const lint = readFileSync(path.join(evidence, "oxlint.log"), "utf8");
  assert.match(lint, /Found 0 warnings and 0 errors\./);
  assert.match(lint, /with 263 rules/);
  for (const file of ["format.log", "oxlint.log", "stylelint.log"]) {
    const text = readFileSync(path.join(evidence, file), "utf8");
    assert.doesNotMatch(text, /\bFAILED\b|^\s*\[?(?:[A-Za-z_$][\w$]*)?Error(?: \[[^\]\n]+\])?:/m);
  }
  assert.equal(
    hash(readFileSync(path.join(evidence, "final-candidate.patch"))),
    binding.finalCandidatePatch,
  );
  writeFileSync(
    path.join(evidence, "qualified-completion.json"),
    JSON.stringify(
      {
        status: "remaining-static-gates-complete",
        source: binding.source,
        finalCandidatePatch: binding.finalCandidatePatch,
        finalTest: binding.finalTest,
        historicalRun: binding.run,
        historicalJob: binding.job,
        historicalOutcome: binding.historicalOutcome,
        reusedOwnerTests: 174,
        reusedBrowserTests: 1,
        reusedStaticStages: 18,
        freshChecks: [
          "format",
          "263-rule targeted core Oxlint",
          "targeted UI Stylelint",
          "source and index closure",
        ],
        runtimeTestsReplayed: false,
        browserBuildReplayed: false,
      },
      null,
      2,
    ),
  );
}
