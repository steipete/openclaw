import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const evidence = realpathSync(process.argv[2]);
assert.equal(
  Number(process.argv[3]),
  1,
  "Baseline must fail only the two completed filename assertions",
);
const owner = readCompletedReport(
  path.join(evidence, "owner.json"),
  path.join(evidence, "owner.log"),
);
assert.equal(owner.report.numTotalTests, 7);
assert.equal(owner.report.numPassedTests, 7);
assert.equal(owner.report.numFailedTests, 0);
assert.equal(owner.report.numPendingTests, 0);
assert.equal(owner.report.numTodoTests ?? 0, 0);
for (const result of owner.report.testResults.flatMap((suite) => suite.assertionResults)) {
  assert.equal(result.status, "passed");
  assert.deepEqual(result.failureMessages, []);
}
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "browser.log"),
);
assert.doesNotMatch(log, /run (?:was |is )?queued|unfinished|timed out|test timed out/i);
assert.equal(report.numTotalTests, 2);
assert.equal(report.numFailedTests, 2);
assert.equal(report.numPassedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
const assertions = report.testResults.flatMap((result) => result.assertionResults);
assert.equal(assertions.length, 2);
const ids = ["short", "ascii120", "pair-fit", "pair-split", "sanitize", "fallback", "extension"];
const expected = {
  widget: [
    "Quarterly-📊",
    "a".repeat(120),
    `${"a".repeat(118)}📊`,
    "a".repeat(119),
    "Quarterly-status-Q3",
    "widget",
    "report.jpg",
  ],
  image: [
    "Quarterly 📊",
    "a".repeat(120),
    `${"a".repeat(118)}📊`,
    "a".repeat(119),
    "Quarterly - status- Q3",
    "generated-image",
    "report",
  ],
};
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  );
const files = walk(path.join(evidence, "browser"));
const receiptFiles = files.filter((file) => path.basename(file) === "receipts.json");
assert.equal(receiptFiles.length, 2);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owned = (file) => {
  const resolved = realpathSync(file);
  assert.ok(resolved.startsWith(`${evidence}${path.sep}`));
  return readFileSync(resolved);
};
const imageBytes = readFileSync(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"));
const verified = [];
for (const flow of ["widget", "image"]) {
  const result = assertions.find(
    (item) => item.title === `downloads ${flow} filenames without splitting UTF16 characters`,
  );
  assert.ok(result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureMessages.length, 1);
  assert.match(
    result.failureMessages[0],
    new RegExp(`${flow} download filenames preserve the UTF16 boundary`),
  );
  assert.match(result.failureMessages[0], /download-filename-utf16\.e2e\.test\.ts/);
  const receiptFile = receiptFiles.find((file) => path.basename(path.dirname(file)) === flow);
  assert.ok(receiptFile);
  const rows = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map((row) => row.id),
    ids,
  );
  for (const [index, row] of rows.entries()) {
    assert.equal(row.flow, flow);
    assert.equal(row.expectedFilename, `${expected[flow][index]}.png`);
    assert.equal(row.failure, null);
    assert.equal(row.chatRequests, 0);
    const bytes = owned(row.path);
    assert.equal(hash(bytes), row.sha256);
    assert.equal(bytes.length, row.bytes);
    assert.ok(bytes.length > 32);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), row.width);
    assert.equal(bytes.readUInt32BE(20), row.height);
    assert.ok(row.width > 0 && row.height > 0);
    const screenshot = owned(row.screenshot);
    assert.equal(screenshot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(screenshot.readUInt32BE(16), 1440);
    assert.equal(screenshot.readUInt32BE(20), 900);
    if (flow === "image") {
      assert.equal(hash(bytes), hash(imageBytes));
      assert.deepEqual(row.requestedVariants, ["thumbnail", "full"]);
      assert.equal(row.artifactRequests, 2);
    } else {
      assert.ok(row.canvasRequests > 0);
    }
    if (row.id === "pair-split") {
      assert.equal(row.title, `${"a".repeat(119)}📊`);
      assert.notEqual(row.suggestedFilename, row.expectedFilename);
      assert.ok(row.suggestedFilename.startsWith("a".repeat(119)));
      assert.ok(row.suggestedFilename.endsWith(".png"));
    } else {
      assert.equal(row.suggestedFilename, row.expectedFilename);
    }
    verified.push({
      flow,
      id: row.id,
      suggestedFilename: row.suggestedFilename,
      expectedFilename: row.expectedFilename,
      bytes: row.bytes,
      sha256: row.sha256,
      screenshotSha256: hash(screenshot),
    });
  }
}
writeFileSync(
  path.join(evidence, "qualified-baseline.json"),
  JSON.stringify(
    {
      status: "expected-two-filename-defects",
      tests: 2,
      downloads: verified,
      captureInspection: "pending independent full-image inspection",
      artifactInventory: files.map((file) => ({
        path: path.relative(evidence, file),
        sha256: hash(readFileSync(file)),
      })),
    },
    null,
    2,
  ),
);
