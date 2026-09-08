import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";
const lane = path.dirname(fileURLToPath(import.meta.url));
const evidence = realpathSync(process.argv[2]);
assert.equal(Number(process.argv[3]), 0);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const history = path.join(lane, "historical");
const binding = JSON.parse(readFileSync(path.join(lane, "historical-binding.json"), "utf8"));
assert.equal(binding.run, "34172030121");
assert.equal(binding.workflowResult, "FAILURE");
assert.equal(binding.aggregateAcceptance, false);
assert.equal(Object.keys(binding.inventory).length, 51);
const reference = JSON.parse(readFileSync(path.join(lane, "historical-reference.json"), "utf8"));
assert.equal(reference.repository, "steipete/openclaw");
assert.equal(reference.runId, 34172030121);
assert.equal(reference.artifactId, 10036043699);
assert.equal(
  reference.artifactDigest,
  "sha256:13030e8fae8912d511d3a34a86c10432cd533b48853f2bec966baf8b86ef4dfd",
);
assert.equal(Object.keys(reference.includedFiles).length, 18);
assert.equal(Object.keys(reference.referencedFiles).length, 33);
assert.deepEqual({ ...reference.includedFiles, ...reference.referencedFiles }, binding.inventory);
for (const [file, sha] of Object.entries(reference.includedFiles)) {
  assert.doesNotMatch(file, /\.(?:png|webm)$/i);
  const resolved = realpathSync(path.join(history, file));
  assert.ok(resolved.startsWith(history + path.sep));
  assert.equal(hash(readFileSync(resolved)), sha);
}
const oldOwner = readCompletedReport(
  path.join(history, "owner.json"),
  path.join(history, "owner.log"),
).report;
assert.equal(oldOwner.numPassedTests, 5);
assert.equal(oldOwner.numFailedTests, 0);
assert.equal(oldOwner.numPendingTests, 0);
const oldBrowser = readCompletedReport(
  path.join(history, "vitest.json"),
  path.join(history, "browser.log"),
).report;
assert.equal(oldBrowser.numTotalTests, 4);
assert.equal(oldBrowser.numFailedTests, 3);
assert.equal(oldBrowser.numPassedTests, 1);
const reused = binding.rows.filter((row) => row.scenarioJoined);
assert.equal(reused.length, 20);
assert.equal(reused.filter((row) => row.defect).length, 8);
assert.equal(binding.rows.filter((row) => !row.scenarioJoined).length, 1);
assert.equal(readFileSync(path.join(history, "final-working-tree.patch"), "utf8"), "");
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "browser.log"),
);
assert.doesNotMatch(log, /run (?:was |is )?queued|unfinished|timed out|test timed out/i);
assert.equal(report.numTotalTests, 4);
assert.equal(report.numPassedTests, 1);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 3);
assert.equal(report.numTodoTests ?? 0, 0);
const assertions = report.testResults.flatMap((result) => result.assertionResults);
assert.equal(assertions.length, 4);
const completed = assertions.filter((result) => result.status === "passed");
assert.equal(completed.length, 1);
assert.equal(completed[0].title, "dashboard initials preserve graphemes and casing tr-TR");
assert.deepEqual(completed[0].failureMessages, []);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
const files = walk(path.join(evidence, "browser"));
const receiptFiles = files.filter((file) => path.basename(file) === "receipts.json");
assert.equal(receiptFiles.length, 1);
const dir = path.dirname(receiptFiles[0]);
assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "joined.json"), "utf8")), {
  closed: true,
  locale: "tr-TR",
  flow: "dashboard",
});
const casing = JSON.parse(readFileSync(path.join(dir, "native-casing.json"), "utf8"));
assert.deepEqual(casing, {
  browser: "151.0.7922.34",
  locale: "tr-TR",
  noArgument: "I",
  explicitTurkish: "İ",
  rootUpper: "I",
});
const rows = JSON.parse(readFileSync(receiptFiles[0], "utf8"));
assert.equal(rows.length, 2);
assert.deepEqual(
  rows.map(({ id, name, expected, actual, defect, locale, flow, chatSends }) => ({
    id,
    name,
    expected,
    actual,
    defect,
    locale,
    flow,
    chatSends,
  })),
  [
    {
      id: "locale",
      name: "ilker",
      expected: "I",
      actual: "I",
      defect: false,
      locale: "tr-TR",
      flow: "dashboard",
      chatSends: 0,
    },
    {
      id: "expansion",
      name: "ßeta",
      expected: "SS",
      actual: "SS",
      defect: false,
      locale: "tr-TR",
      flow: "dashboard",
      chatSends: 0,
    },
  ],
);
const owned = (file) => {
  const resolved = realpathSync(file);
  assert.ok(resolved.startsWith(evidence + path.sep));
  return readFileSync(resolved);
};
assert.equal(new Set(rows.map((row) => row.screenshot)).size, 1);
assert.equal(new Set(rows.map((row) => row.video)).size, 1);
const screenshot = owned(rows[0].screenshot);
const video = owned(rows[0].video);
assert.equal(screenshot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(screenshot.readUInt32BE(16), 1440);
assert.equal(screenshot.readUInt32BE(20), 900);
assert.ok(video.length > 64);
assert.equal(video.subarray(0, 4).toString("hex"), "1a45dfa3");
writeFileSync(
  path.join(evidence, "combined-baseline.json"),
  JSON.stringify(
    {
      status: "unfinished-control-completed",
      originalRun: "34172030121",
      originalRunResult: "FAILURE",
      historicalArtifact: reference,
      source: binding.source,
      helperTestsReused: 5,
      priorCompletedRows: reused,
      newRows: rows,
      originalWrongOracleRow: binding.rows.filter((row) => !row.scenarioJoined),
      casing,
      screenshots: { sha256: hash(screenshot), inspection: "pending full independent inspection" },
      video: { sha256: hash(video), inspection: "pending" },
      finalSourceGuards: "require run phase complete and after hash logs",
      inventory: files.map((file) => ({
        path: path.relative(evidence, file),
        sha256: hash(readFileSync(file)),
      })),
    },
    null,
    2,
  ),
);
