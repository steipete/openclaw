import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const evidence = realpathSync(process.argv[2]);
const phase = process.argv[3];
assert.ok(phase === "owner" || phase === "browser");
const success = (reportName, logName, tests, files) => {
  const { report, log } = readCompletedReport(
    path.join(evidence, reportName),
    path.join(evidence, logName),
  );
  assert.doesNotMatch(log, /run (?:was |is )?queued|unfinished|test timed out/i);
  assert.equal(report.numTotalTests, tests);
  assert.equal(report.numPassedTests, tests);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.testResults.length, files);
  const results = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(results.length, tests);
  for (const result of results) {
    assert.equal(result.status, "passed");
    assert.deepEqual(result.failureMessages, []);
  }
  return results;
};
if (phase === "owner") {
  success("owner.json", "owner.log", 9, 1);
} else {
  const assertions = success("vitest.json", "browser.log", 3, 2);
  assert.deepEqual(
    assertions.map((item) => item.title).sort(),
    [
      "downloads widget filenames without splitting UTF16 characters",
      "downloads image filenames without splitting UTF16 characters",
      "previews, downloads, and opens a ticketed generated image",
    ].sort(),
  );
  const lane = path.dirname(fileURLToPath(import.meta.url));
  const baseline = JSON.parse(readFileSync(path.join(lane, "baseline-downloads.json"), "utf8"));
  assert.equal(baseline.status, "expected-two-filename-defects");
  assert.equal(baseline.downloads.length, 14);
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
  const png = (bytes) => {
    assert.ok(bytes.length > 32);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.ok(width > 0 && height > 0);
    return { width, height };
  };
  const imageBytes = readFileSync(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"));
  const verified = [];
  for (const flow of ["widget", "image"]) {
    const receiptFile = receiptFiles.find((file) => path.basename(path.dirname(file)) === flow);
    assert.ok(receiptFile);
    const rows = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.equal(rows.length, 7);
    assert.deepEqual(
      rows.map((row) => row.id),
      ids,
    );
    for (const [index, row] of rows.entries()) {
      const before = baseline.downloads.find((item) => item.flow === flow && item.id === row.id);
      assert.ok(before);
      assert.equal(row.flow, flow);
      assert.equal(row.expectedFilename, `${expected[flow][index]}.png`);
      assert.equal(row.suggestedFilename, row.expectedFilename);
      assert.ok(row.suggestedFilename.isWellFormed());
      assert.ok(row.suggestedFilename.length <= 124);
      assert.equal(row.failure, null);
      assert.equal(row.chatRequests, 0);
      const bytes = owned(row.path);
      assert.equal(hash(bytes), row.sha256);
      assert.equal(bytes.length, row.bytes);
      assert.deepEqual(png(bytes), { width: row.width, height: row.height });
      const screenshot = owned(row.screenshot);
      assert.deepEqual(png(screenshot), { width: 1440, height: 900 });
      if (flow === "image") {
        assert.equal(hash(bytes), hash(imageBytes));
        assert.equal(row.sha256, before.sha256);
        assert.deepEqual(row.requestedVariants, ["thumbnail", "full"]);
        assert.equal(row.artifactRequests, 2);
      } else {
        assert.equal(row.canvasRequests, 1);
      }
      if (row.id === "pair-split") {
        assert.equal(row.title, `${"a".repeat(119)}📊`);
        assert.equal(before.suggestedFilename, `${"a".repeat(119)}\ufffd.png`);
        assert.notEqual(row.suggestedFilename, before.suggestedFilename);
      } else {
        assert.equal(row.suggestedFilename, before.suggestedFilename);
      }
      verified.push({
        flow,
        id: row.id,
        suggestedFilename: row.suggestedFilename,
        baselineSuggestedFilename: before.suggestedFilename,
        bytes: row.bytes,
        sha256: row.sha256,
        baselineSha256: before.sha256,
        width: row.width,
        height: row.height,
        screenshotSha256: hash(screenshot),
      });
    }
  }
  const existingCapture = files.filter(
    (file) => path.basename(file) === "ticketed-generated-image-subpath.png",
  );
  assert.equal(existingCapture.length, 1);
  png(readFileSync(existingCapture[0]));
  writeFileSync(
    path.join(evidence, "qualified-browser-green.json"),
    JSON.stringify(
      {
        status: "three-browser-cases-passed",
        downloads: verified,
        existingManagedImageRegression: "passed all subpath/ticket/hitarea/filename/open controls",
        captureInspection:
          "pending full-image inspection; screenshots show routes, receipts prove names",
        artifactInventory: files.map((file) => ({
          path: path.relative(evidence, file),
          sha256: hash(readFileSync(file)),
        })),
      },
      null,
      2,
    ),
  );
}
