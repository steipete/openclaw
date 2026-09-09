import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const [evidenceInput, mode, kind, exitCode] = process.argv.slice(2);
assert.equal(mode, "baseline");
assert.ok(kind === "renderer" || kind === "browser");
const evidence = realpathSync(evidenceInput);
const lane = path.dirname(fileURLToPath(import.meta.url));
const expectedAssertion =
  mode === "baseline"
    ? kind === "renderer"
      ? /^AssertionError: USAGE_KNOWN_ZERO_(?:HINT|FILTER):/
      : /^AssertionError: USAGE_KNOWN_ZERO_BROWSER:/
    : undefined;
const { report } = readCompletedReport(
  path.join(evidence, `${kind}.json`),
  path.join(evidence, `${kind}.log`),
  expectedAssertion,
);
assert.equal(exitCode, mode === "baseline" ? "1" : "0");
assert.equal(report.success, mode === "candidate");
assert.equal(report.testResults.length, 1);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.numPendingTestSuites, 0);
const suite = report.testResults[0];
const file =
  kind === "renderer"
    ? "ui/src/pages/usage/view.test.ts"
    : "ui/src/e2e/usage-cost-analysis.e2e.test.ts";
assert.ok(suite.name.replaceAll("\\", "/").endsWith(`/${file}`));
const assertions = suite.assertionResults;
assert.equal(assertions.length, report.numTotalTests);
assert.ok(assertions.every((test) => ["passed", "failed", "skipped"].includes(test.status)));
const skipped = assertions.filter((test) => test.status === "skipped");
assert.equal(skipped.length, report.numPendingTests);
for (const test of skipped) assert.deepEqual(test.failureMessages, []);
const active = assertions.filter((test) => test.status !== "skipped");
const rendererNames = [
  ...["known zero", "known positive", "unknown zero", "mixed positive"].map(
    (label) => `Usage recorded cost availability renders the recorded cost hint for ${label}`,
  ),
  ...["query", "session", "day"].map(
    (scope) =>
      `Usage recorded cost availability restores the missing-cost hint after clearing the known-zero ${scope} filter`,
  ),
  "renderUsage shows the empty state for an all-zero successful response",
];
const browserName =
  "Control UI usage cost analysis mocked Gateway E2E shows the recorded cost hint through ordinary Usage filters";
const expectedNames = kind === "renderer" ? rendererNames : [browserName];
assert.deepEqual(
  active.map((test) => test.fullName),
  expectedNames,
);
const redNames =
  kind === "renderer" ? [rendererNames[0], ...rendererNames.slice(4, 7)] : [browserName];
const failed = mode === "baseline" ? redNames.length : 0;
assert.equal(report.numFailedTests, failed);
assert.equal(report.numPassedTests, expectedNames.length - failed);
assert.equal(suite.status, failed ? "failed" : "passed");
const source = readFileSync(path.join(lane, path.basename(file)), "utf8").split("\n");
for (const test of active) {
  const red = mode === "baseline" && redNames.includes(test.fullName);
  assert.equal(test.status, red ? "failed" : "passed");
  if (!red) {
    assert.deepEqual(test.failureMessages, []);
    continue;
  }
  assert.equal(test.failureMessages.length, 1);
  const failure = test.failureMessages[0];
  const marker =
    kind === "browser"
      ? "USAGE_KNOWN_ZERO_BROWSER"
      : test.fullName === rendererNames[0]
        ? "USAGE_KNOWN_ZERO_HINT"
        : "USAGE_KNOWN_ZERO_FILTER";
  const markerLines = source.flatMap((line, index) =>
    line.includes(`"${marker}"`) ? [index] : [],
  );
  assert.equal(markerLines.length, 1);
  let first = markerLines[0];
  let last = first;
  while (first > 0 && !source[first].includes("expect(")) first -= 1;
  while (last < source.length && !source[last].includes(".toBe(")) last += 1;
  assert.ok(last - first < 8, "Expected one bounded assertion statement");
  const lines = Array.from({ length: last - first + 1 }, (_, index) => first + index + 1);
  assert.match(failure, new RegExp(`^AssertionError: ${marker}:`));
  assert.match(
    failure,
    new RegExp(`${path.basename(file).replaceAll(".", "\\.")}:(?:${lines.join("|")}):\\d+`),
  );
}
const qualification = {
  mode,
  kind,
  passed: report.numPassedTests,
  expectedFailed: failed,
  deliberatelyFiltered: skipped.length,
  activeNames: expectedNames,
  componentQualified: true,
  wholeLaneQualified: false,
};
if (kind === "browser") {
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    );
  const files = walk(path.join(evidence, "browser"));
  const receipts = files.filter((file) => path.basename(file) === "receipts.json");
  assert.equal(receipts.length, 1);
  const row = JSON.parse(readFileSync(receipts[0], "utf8"));
  const normalHint = "Average cost per message when providers report costs.";
  const missingHint = `${normalHint} Cost data is missing for some or all sessions in this range.`;
  assert.deepEqual(row.observations, [
    {
      stage: "mixed",
      query: "",
      hint: missingHint,
      value: "$0.03",
      labels: ["Known positive", "Known zero", "Unpriced usage"],
      visible: true,
    },
    {
      stage: "known-zero",
      query: 'label:"Known zero"',
      hint: mode === "baseline" ? missingHint : normalHint,
      value: "$0.00",
      labels: ["Known zero"],
      visible: true,
    },
    {
      stage: "cleared",
      query: "",
      hint: missingHint,
      value: "$0.03",
      labels: ["Known positive", "Known zero", "Unpriced usage"],
      visible: true,
    },
    {
      stage: "positive",
      query: 'label:"Known positive"',
      hint: normalHint,
      value: "$0.10",
      labels: ["Known positive"],
      visible: true,
    },
    {
      stage: "unknown",
      query: 'label:"Unpriced usage"',
      hint: missingHint,
      value: "$0.00",
      labels: ["Unpriced usage"],
      visible: true,
    },
  ]);
  assert.equal(row.responsesUnchanged, true);
  assert.deepEqual(row.forbiddenRequests, []);
  assert.ok(
    row.requests.includes("sessions.usage") &&
      row.requests.includes("usage.cost") &&
      row.requests.includes("usage.status"),
  );
  assert.ok(
    row.requests.every(
      (method) => !["chat.send", "config.set", "config.patch", "sessions.patch"].includes(method),
    ),
  );
  const response = row.responses["sessions.usage"];
  assert.equal(response.sessions.length, 3);
  assert.equal(response.totals.totalTokens, 5_100);
  assert.equal(response.totals.totalCost, 0.2);
  assert.equal(response.totals.missingCostEntries, 1);
  assert.deepEqual(row.responses["usage.status"].providers, []);
  assert.deepEqual(
    response.sessions.map((session) => ({
      label: session.label,
      tokens: session.usage.totalTokens,
      cost: session.usage.totalCost,
      missing: session.usage.missingCostEntries,
    })),
    [
      { label: "Known zero", tokens: 1_700, cost: 0, missing: 0 },
      { label: "Known positive", tokens: 1_700, cost: 0.2, missing: 0 },
      { label: "Unpriced usage", tokens: 1_700, cost: 0, missing: 1 },
    ],
  );
  assert.deepEqual(
    row.screenshots.map((file) => path.basename(file)),
    ["mixed.png", "known-zero.png"],
  );
  qualification.captures = row.screenshots.map((file) => {
    const resolved = realpathSync(file);
    assert.ok(resolved.startsWith(`${evidence}${path.sep}`));
    const bytes = readFileSync(resolved);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1440);
    assert.equal(bytes.readUInt32BE(20), 900);
    return {
      path: path.relative(evidence, resolved),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const stages = ["mixed", "known-zero", "cleared", "positive", "unknown"];
  assert.deepEqual(
    row.diagnostics.map((entry) => entry.stage),
    stages,
  );
  qualification.diagnosticCaptures = row.diagnostics.map((entry) => {
    const geometryFile = realpathSync(entry.geometryFile);
    const screenshot = realpathSync(entry.screenshot);
    assert.ok(geometryFile.startsWith(`${evidence}${path.sep}`));
    assert.ok(screenshot.startsWith(`${evidence}${path.sep}`));
    assert.equal(path.basename(geometryFile), `${entry.stage}-geometry.json`);
    assert.equal(path.basename(screenshot), `${entry.stage}.png`);
    const geometryBytes = readFileSync(geometryFile);
    const geometry = JSON.parse(geometryBytes.toString("utf8"));
    assert.equal(geometry.stage, entry.stage);
    assert.deepEqual(
      geometry.geometry.map(({ name }) => name),
      ["card", "tooltip-body", "hint-content"],
    );
    for (const { bounds } of geometry.geometry) {
      assert.ok(bounds);
      assert.ok([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite));
      assert.ok(bounds.width > 0 && bounds.height > 0);
      assert.ok(bounds.x >= 0 && bounds.y >= 0);
      assert.ok(bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 900);
    }
    const image = readFileSync(screenshot);
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(image.readUInt32BE(16), 1440);
    assert.equal(image.readUInt32BE(20), 900);
    return {
      stage: entry.stage,
      geometry: path.relative(evidence, geometryFile),
      geometrySha256: createHash("sha256").update(geometryBytes).digest("hex"),
      screenshot: path.relative(evidence, screenshot),
      screenshotSha256: createHash("sha256").update(image).digest("hex"),
    };
  });
  assert.deepEqual(
    row.screenshots,
    row.diagnostics.slice(0, 2).map(({ screenshot }) => screenshot),
  );
  qualification.captureInspection = "pending full synthetic capture inspection";
  qualification.observations = row.observations;
}
writeFileSync(
  path.join(evidence, `qualified-${kind}.json`),
  JSON.stringify(qualification, null, 2) + "\n",
);
