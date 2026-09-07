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
  const firstLine = message.split("\n", 1)[0];
  const frames = message
    .split("\n")
    .filter((line) => line.includes(`${expectedFile}:`))
    .map((line) => {
      const location = line.match(/:(\d+):(\d+)\)?$/);
      assert.ok(location, line);
      return `${location[1]}:${location[2]}`;
    });
  const requireRejectsFrame = () => {
    assert.match(message, /at _Assertion\.__VITEST_REJECTS__ /);
    assert.ok(message.includes("vitest/dist/chunks/index.OVGXnVRj.js:2453:33"));
  };
  if (owner === "shared") {
    assert.equal(firstLine, "AssertionError: expected [Function] to throw an error");
    assert.deepEqual(frames, [contract.label === "Invalid --timeout" ? "30:47" : "26:19"]);
  } else if (owner === "models") {
    assert.ok(
      firstLine.startsWith(
        `Error: expected [Function] to throw error including '${contract.label}' but got 'Cannot apply metadata`,
      ),
    );
    assert.deepEqual(frames, ["211:8"]);
    requireRejectsFrame();
  } else if (
    contract.label === "Invalid --timeout" &&
    [
      "rejects image describe before provider dispatch",
      "rejects image describe-many before provider dispatch",
    ].includes(contract.title)
  ) {
    assert.equal(firstLine, 'Error: promise resolved "undefined" instead of rejecting');
    assert.deepEqual(frames, ["3234:68"]);
    requireRejectsFrame();
  } else {
    assert.match(firstLine, /^AssertionError: expected .* to (?:contain|include)/);
    assert.ok(firstLine.includes(contract.label));
    assert.ok(message.includes("at expectRuntimeErrorContains ("));
    assert.deepEqual(frames, [
      "883:47",
      contract.label === "Invalid --timeout" ? "3236:9" : "3218:9",
    ]);
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
