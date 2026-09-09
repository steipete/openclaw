import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const lane = path.dirname(fileURLToPath(import.meta.url));
const evidence = process.argv[2];
const json = (file) => JSON.parse(readFileSync(path.join(lane, file), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const admission = json("BASELINE.json");
const source = json("source.json");
assert.equal(admission.status, "accepted-baseline");
assert.equal(admission.source, source.source);
assert.equal(admission.capturesInspectedByOwnerAndIndependent, true);
assert.equal(admission.baselineRepeatedInCandidate, false);
for (const [file, expected] of Object.entries(admission.files)) {
  assert.ok(file.startsWith("baseline/") && !file.split("/").includes(".."));
  assert.equal(hash(readFileSync(path.join(lane, file))), expected, file);
}
const job = json("baseline/job.json");
assert.equal(job.run, admission.browserRun);
assert.equal(job.job.databaseId, admission.browserJob);
assert.equal(job.harness, admission.browserHarness);
assert.equal(job.job.status, "completed");
assert.equal(job.job.conclusion, "success");
const identity = json("baseline/source.json");
assert.equal(identity.source, source.source);
assert.equal(identity.mode, "baseline");
assert.equal(identity.node, "24.20.0");
const before = json("baseline/source-before.json");
const applied = json("baseline/source-applied.json");
assert.deepEqual(before, json("baseline/source-restored.json"));
assert.deepEqual(applied, json("baseline/source-before-restoration.json"));
assert.equal(before.source, source.source);
assert.equal(before.tree, source.tree);
assert.deepEqual(before.hashes, source.original);
assert.deepEqual(applied.changedPaths, [source.browserFile]);
assert.deepEqual(applied.hashes, {
  ...source.original,
  [source.browserFile]: admission.browserFixtureSha256,
});
assert.equal(
  hash(readFileSync(path.join(lane, "usage-cost-analysis.e2e.test.ts"))),
  admission.browserFixtureSha256,
);
assert.equal(source.candidate[source.browserFile], admission.browserFixtureSha256);
assert.equal(hash(readFileSync(path.join(lane, "view.test.ts"))), admission.rendererFixtureSha256);
assert.equal(source.candidate[source.unitFile], admission.rendererFixtureSha256);
const rendererApplied = json("baseline/renderer-source-applied.json");
assert.equal(rendererApplied.source, source.source);
assert.equal(rendererApplied.hashes[source.unitFile], admission.rendererFixtureSha256);
const reuse = json("baseline/renderer-reuse.json");
assert.equal(reuse.historicalRun, admission.rendererRun);
assert.equal(reuse.historicalJob, admission.rendererJob);
assert.equal(reuse.historicalRunConclusion, "FAILURE");
assert.equal(reuse.rendererExecutedThisRun, false);
assert.equal(reuse.rendererQualified, true);
for (const file of ["renderer.json", "renderer.log", "renderer-exit.txt"]) {
  assert.equal(
    hash(readFileSync(path.join(lane, "baseline", file))),
    reuse.inputHashes[`reuse/${file}`],
  );
}
for (const [kind, total, failures, skipped, marker] of [
  ["renderer", 8, 4, 26, /^AssertionError: USAGE_KNOWN_ZERO_(?:HINT|FILTER):/],
  ["browser", 1, 1, 10, /^AssertionError: USAGE_KNOWN_ZERO_BROWSER:/],
]) {
  const { report } = readCompletedReport(
    path.join(lane, "baseline", `${kind}.json`),
    path.join(lane, "baseline", `${kind}.log`),
    marker,
  );
  assert.equal(report.testResults.length, 1);
  assert.equal(report.numFailedTests, failures);
  assert.equal(report.numPassedTests, total - failures);
  assert.equal(report.numPendingTests, skipped);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.numPendingTestSuites, 0);
  const assertions = report.testResults[0].assertionResults;
  assert.ok(assertions.every((row) => ["passed", "failed", "skipped"].includes(row.status)));
  assert.equal(assertions.length, report.numTotalTests);
  const qualified = json(`baseline/qualified-${kind}.json`);
  assert.equal(qualified.componentQualified, true);
  assert.equal(qualified.mode, "baseline");
  assert.deepEqual(
    assertions.filter((row) => row.status !== "skipped").map((row) => row.fullName),
    qualified.activeNames,
  );
  for (const row of assertions) {
    if (row.status === "failed") {
      assert.equal(row.failureMessages.length, 1);
      assert.match(row.failureMessages[0], marker);
    } else {
      assert.deepEqual(row.failureMessages, []);
    }
  }
}
for (const file of ["exit-code.txt", "lane-exit.txt"]) {
  assert.equal(readFileSync(path.join(lane, "baseline", file), "utf8").trim(), "0");
}
assert.equal(readFileSync(path.join(lane, "baseline/phase.txt"), "utf8").trim(), "complete");
assert.equal(readFileSync(path.join(lane, "baseline/browser-exit.txt"), "utf8").trim(), "1");
for (const file of [
  "final-status.txt",
  "final-working-tree.patch",
  "bootstrap-final-working-tree.patch",
]) {
  assert.equal(readFileSync(path.join(lane, "baseline", file)).length, 0);
}
const qualified = json("baseline/qualified-browser.json");
const records = json("baseline/browser-receipts.json");
assert.deepEqual(records.observations, qualified.observations);
assert.deepEqual(records.forbiddenRequests, []);
assert.equal(records.responsesUnchanged, true);
const normal = "Average cost per message when providers report costs.";
const missing = `${normal} Cost data is missing for some or all sessions in this range.`;
assert.deepEqual(
  records.observations.map(({ stage, hint, value }) => ({ stage, hint, value })),
  [
    { stage: "mixed", hint: missing, value: "$0.03" },
    { stage: "known-zero", hint: missing, value: "$0.00" },
    { stage: "cleared", hint: missing, value: "$0.03" },
    { stage: "positive", hint: normal, value: "$0.10" },
    { stage: "unknown", hint: missing, value: "$0.00" },
  ],
);
assert.deepEqual(qualified.diagnosticCaptures, admission.captureHashes);
for (const capture of admission.captureHashes) {
  const bytes = readFileSync(path.join(lane, "baseline", `${capture.stage}-geometry.json`));
  assert.equal(hash(bytes), capture.geometrySha256);
  const geometry = JSON.parse(bytes.toString("utf8"));
  assert.equal(geometry.stage, capture.stage);
  assert.deepEqual(
    geometry.geometry.map(({ name }) => name),
    ["card", "tooltip-body", "hint-content"],
  );
  for (const { bounds } of geometry.geometry) {
    assert.ok(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite));
    assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 900);
  }
}
const receipt = json("baseline/receipt.json");
assert.equal(receipt.source, source.source);
assert.equal(receipt.sourceRestored, true);
assert.equal(receipt.proofComponentsQualified, true);
for (const [file, expected] of Object.entries(receipt.files)) {
  assert.equal(hash(readFileSync(path.join(lane, "baseline", file))), expected, file);
}
writeFileSync(
  path.join(evidence, "baseline-verified.json"),
  JSON.stringify(
    {
      source: source.source,
      rendererRun: admission.rendererRun,
      originalRendererRunConclusion: "FAILURE",
      browserRun: admission.browserRun,
      browserJobConclusion: "SUCCESS",
      baselinesExecutedThisRun: false,
      rendererFixtureSha256: admission.rendererFixtureSha256,
      browserFixtureSha256: admission.browserFixtureSha256,
      sourceRestoredInBrowserBaseline: true,
      capturesPreviouslyInspected: admission.captureHashes,
      baselineInputHashes: admission.files,
    },
    null,
    2,
  ) + "\n",
);
