import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";

const [phase, owner, reportFile, logFile, code, expectedFile] = process.argv.slice(2);
assert.ok(phase === "baseline" || phase === "candidate");
const { report, log } = readCompletedReport(reportFile, logFile);
assert.doesNotMatch(log, /Some tests are still running when generating the JSON report/);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.endsWith(`/${expectedFile}`));
const active = suite.assertionResults.filter((test) => ["passed", "failed"].includes(test.status));
const key = (test) => JSON.stringify([test.ancestorTitles, test.title]);
const expected = [];
const add = (ancestors, title, failed, label) =>
  expected.push({ ancestorTitles: ancestors, title, failed, label });

if (owner === "capability") {
  for (const alias of ["infer", "capability"]) {
    for (const raw of ["", "   "]) {
      for (const [name, label] of [
        ["web search limit", "--limit"],
        ["image generate count", "--count"],
        ["image edit count", "--count"],
        ["video generate duration", "--duration"],
      ]) {
        add(
          ["capability cli", `${alias} numeric options`, `blank value ${JSON.stringify(raw)}`],
          `rejects ${name} before provider dispatch`,
          true,
          label,
        );
      }
    }
    for (const raw of ["", "   ", "1000ms"]) {
      for (const name of [
        "image generate",
        "image edit",
        "image describe",
        "image describe-many",
        "video generate",
      ]) {
        add(
          ["capability cli", `${alias} numeric options`, `invalid timeout ${JSON.stringify(raw)}`],
          `rejects ${name} before provider dispatch`,
          raw !== "1000ms",
          "Invalid --timeout",
        );
      }
    }
  }
} else if (owner === "models") {
  for (const [name, label, partial] of [
    ["minParams", "--min-params", "7b"],
    ["maxAgeDays", "--max-age-days", "30d"],
    ["maxCandidates", "--max-candidates", "2.5"],
    ["timeout", "--timeout", "1000ms"],
    ["concurrency", "--concurrency", "2x"],
  ]) {
    for (const raw of ["", "   ", partial]) {
      add(
        ["models scan command", `${name} numeric value`],
        `rejects ${JSON.stringify(raw)} before scanning`,
        raw === "",
        label,
      );
    }
  }
} else if (owner === "shared") {
  const ancestors = ["capability CLI numeric option parsing"];
  add(ancestors, "keeps omitted optional values absent and parses valid values", false);
  for (const label of ["--duration", "--duration", "--limit", "--limit"]) {
    add(ancestors, `rejects explicit blank ${label} values`, true, label);
  }
  for (const raw of ["", "  "]) {
    add(
      ancestors,
      `rejects explicit blank --timeout-ms value ${JSON.stringify(raw)}`,
      true,
      "Invalid --timeout",
    );
  }
} else {
  assert.equal(owner, "sibling");
  assert.equal(phase, "candidate");
}

if (phase === "baseline") {
  assert.equal(Number(code), 1);
  assert.equal(active.length, expected.length);
  assert.equal(report.numFailedTests, expected.filter((test) => test.failed).length);
  assert.equal(report.numPassedTests, expected.filter((test) => !test.failed).length);
} else {
  assert.equal(Number(code), 0);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.ok(active.length > 0);
  assert.equal(report.numPassedTests, suite.assertionResults.length);
  for (const test of suite.assertionResults) {
    assert.equal(test.status, "passed");
    assert.deepEqual(test.failureMessages, []);
  }
}

const remaining = [...active];
for (const contract of expected) {
  const index = remaining.findIndex((test) => key(test) === key(contract));
  assert.ok(index >= 0, key(contract));
  const [test] = remaining.splice(index, 1);
  const failed = phase === "baseline" && contract.failed;
  assert.equal(test.status, failed ? "failed" : "passed", key(contract));
  if (!failed) continue;
  assert.equal(test.failureMessages.length, 1);
  const message = test.failureMessages[0];
  assert.match(message, /AssertionError:/);
  assert.ok(message.includes(expectedFile));
  if (owner === "shared") {
    assert.match(message, /expected .* to throw an error/);
  } else if (owner === "models") {
    assert.ok(message.includes(contract.label));
    assert.ok(message.includes("Cannot apply metadata"));
  } else if (/promise resolved .* instead of rejecting/s.test(message)) {
    assert.match(message, /undefined/);
  } else {
    assert.ok(message.includes(contract.label));
    assert.match(message, /expected .* to (?:contain|include)/s);
    assert.ok(message.includes("expectRuntimeErrorContains"));
  }
}
console.log(
  JSON.stringify({
    phase,
    owner,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
  }),
);
