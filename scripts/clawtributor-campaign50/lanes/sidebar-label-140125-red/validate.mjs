import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";

const [evidence, exitCode] = process.argv.slice(2);
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "browser.log"),
);
assert.doesNotMatch(
  log,
  /Some tests are still running when generating the JSON report|unsafe cleanup|retiring owned fork/,
);
assert.equal(Number(exitCode), 1);
assert.equal(report.success, false);
assert.equal(report.testResults.length, 1);
assert(report.testResults[0].name.endsWith("/ui/src/e2e/sidebar-interactions.e2e.test.ts"));
const tests = report.testResults[0].assertionResults;
assert.equal(tests.length, 8);
const root = "Control UI sidebar interactions mocked Gateway E2E ";
const red = tests.find(
  (test) =>
    test.fullName === root + "shows one row per agent and reaches agent switches with menu keys",
);
const control = tests.find(
  (test) =>
    test.fullName ===
    root + "preserves nested sidebar hyperlink layout and actions in both directions",
);
assert(red && control);
assert.equal(red.status, "failed");
assert.equal(red.failureMessages.length, 1);
assert.equal(
  red.failureMessages[0].split("\n")[0],
  "Error: SIDEBAR_LABEL_OVERFLOW_140125: complete action label escapes its menu item",
);
assert.match(red.failureMessages[0], /ui\/src\/e2e\/sidebar-interactions\.e2e\.test\.ts:\d+:\d+/);
assert.equal(control.status, "passed");
assert.deepEqual(control.failureMessages, []);
assert(
  tests
    .filter((test) => test !== red && test !== control)
    .every((test) => test.status === "skipped"),
);
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 1);
assert.equal(report.numPendingTests, 6);
assert.equal(report.numTodoTests ?? 0, 0);
const browserRoot = path.join(evidence, "browser");
const directories = fs
  .readdirSync(browserRoot)
  .map((name) => path.join(browserRoot, name))
  .filter((file) => fs.statSync(file).isDirectory());
const findOne = (name) => {
  const files = directories
    .map((directory) => path.join(directory, name))
    .filter((file) => fs.existsSync(file));
  assert.equal(files.length, 1, `Expected one retained ${name}`);
  return files[0];
};
const geometryFile = findOne("label-geometry.json");
const samples = JSON.parse(fs.readFileSync(geometryFile, "utf8"));
assert.equal(samples.length, 4);
assert.deepEqual(
  samples.map(({ direction, scale }) => [direction, scale]),
  [
    ["ltr", 1],
    ["ltr", 1.4],
    ["rtl", 1],
    ["rtl", 1.4],
  ],
);
for (const sample of samples) {
  for (const field of [
    "labelLeft",
    "labelRight",
    "labelWidth",
    "itemLeft",
    "itemRight",
    "menuWidth",
  ])
    assert(Number.isFinite(sample[field]));
  assert.equal(sample.menuWidth, 264);
  assert.equal(sample.text, "What can Scheduled Automations do?");
  if (sample.direction === "ltr")
    assert(
      sample.labelRight - sample.itemRight > 0.5,
      "Both original LTR text scales must show actual overflow",
    );
}
const controls = JSON.parse(fs.readFileSync(findOne("label-controls.json"), "utf8"));
assert.deepEqual(controls, {
  capabilitiesDraft: "What can you do?",
  focusedBeforeSwitch: true,
  menuClosedAfterAction: true,
  selectedPath: "/chat/research",
  chatSends: 0,
  sessionCreates: 0,
  keyboardAndGrid: "passed",
  samples: 4,
});
const links = JSON.parse(fs.readFileSync(findOne("nested-link-controls.json"), "utf8"));
assert.equal(links.configurations, 4);
assert.equal(links.linkActions, 8);
assert.equal(links.externalDestinationsIntercepted, true);
assert.equal(links.chatSends, 0);
assert.equal(links.sessionCreates, 0);
for (const direction of ["ltr", "rtl"])
  for (const scale of [1, 1.4])
    for (const family of ["identity-help", "more-routes"]) {
      const rows = links.observations.filter(
        (sample) =>
          sample.direction === direction && sample.scale === scale && sample.family === family,
      );
      assert(rows.length > 0, "Missing actual nested-link geometry family");
      for (const row of rows) {
        assert.equal(row.anchorDirection, direction);
        assert.equal(row.itemDirection, direction);
        assert(row.labelWidth > 0 && row.anchorWidth > 80);
        assert(row.labelLeft >= row.anchorLeft - 0.5 && row.labelRight <= row.anchorRight + 0.5);
        assert(row.anchorLeft >= row.itemLeft - 0.5 && row.anchorRight <= row.itemRight + 0.5);
        assert(Math.abs(row.anchorWidth - row.iconWidth - row.labelWidth - 8) <= 0.5);
      }
    }
const screenshots = [];
for (const direction of ["ltr", "rtl"])
  for (const scale of [1, 1.4]) {
    for (const name of [
      `long-label-${direction}-${scale}.png`,
      `identity-links-${direction}-${scale}.png`,
      `more-links-${direction}-${scale}.png`,
    ])
      screenshots.push(findOne(name));
  }
screenshots.push(findOne("capabilities-unsent-focused.png"));
const hashes = {};
for (const file of screenshots) {
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert(data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0);
  hashes[path.relative(evidence, file)] = createHash("sha256").update(data).digest("hex");
}
const videoReceipts = directories.map((directory) => ({
  directory,
  receipts: JSON.parse(fs.readFileSync(path.join(directory, "page-videos.json"), "utf8")),
}));
assert.equal(videoReceipts.length, 2);
const pages = videoReceipts.flatMap(({ directory, receipts }) =>
  receipts.map((receipt) => {
    assert.equal(path.basename(receipt.file), receipt.file);
    assert(receipt.file.endsWith(".webm"));
    return { page: receipt.page, file: path.join(directory, receipt.file) };
  }),
);
assert.deepEqual(
  pages.map(({ page }) => page).sort(),
  ["agent-main", "links-main", "docs-ltr-1", "docs-ltr-1.4", "docs-rtl-1", "docs-rtl-1.4"].sort(),
);
const videos = directories.flatMap((directory) =>
  fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".webm"))
    .map((name) => path.join(directory, name)),
);
assert.equal(videos.length, 6);
assert.deepEqual(videos.toSorted(), pages.map(({ file }) => file).toSorted());
assert(videos.every((file) => fs.statSync(file).size > 32));
for (const file of videos)
  hashes[path.relative(evidence, file)] = createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
fs.writeFileSync(
  path.join(evidence, "accepted-baseline.json"),
  JSON.stringify(
    {
      source: "608b9ba2437d22188bac854a012458880ff55211",
      selected: 2,
      failed: 1,
      passed: 1,
      filtered: 6,
      samples,
      controls,
      links,
      screenshotHashes: hashes,
      videos: videos.map((file) => path.relative(evidence, file)),
      visualInspection: "pending independent inspection of complete synthetic captures",
    },
    null,
    2,
  ),
);
console.log(
  "SIDEBAR_LABEL_BASELINE_VERIFIED two LTR overflows; four geometry states; action/keyboard/RTL/link controls completed",
);
