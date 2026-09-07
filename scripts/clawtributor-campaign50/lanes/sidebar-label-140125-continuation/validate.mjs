import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const [evidence, exitCode] = process.argv.slice(2);
const lane = path.dirname(fileURLToPath(import.meta.url));
const reuse = JSON.parse(fs.readFileSync(path.join(lane, "reuse.json"), "utf8"));
assert.equal(reuse.source, process.env.SOURCE_SHA);
assert.equal(reuse.run, 34090441998);
const source = fs.readFileSync("ui/src/e2e/sidebar-interactions.e2e.test.ts", "utf8");
const firstStart = source.indexOf(
  '  it("shows one row per agent and reaches agent switches with menu keys"',
);
const firstEnd = source.indexOf(
  '  it("preserves nested sidebar hyperlink layout and actions in both directions"',
  firstStart,
);
assert(firstStart >= 0 && firstEnd > firstStart);
assert.equal(
  createHash("sha256").update(source.slice(firstStart, firstEnd)).digest("hex"),
  reuse.preservedScenarioSha256,
);
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "browser.log"),
);
assert.doesNotMatch(
  log,
  /Some tests are still running when generating the JSON report|unsafe cleanup|retiring owned fork/,
);
assert.equal(Number(exitCode), 0);
assert.equal(report.success, true);
assert.equal(report.testResults.length, 1);
assert(report.testResults[0].name.endsWith("/ui/src/e2e/sidebar-interactions.e2e.test.ts"));
const tests = report.testResults[0].assertionResults;
assert.equal(tests.length, 8);
const name =
  "Control UI sidebar interactions mocked Gateway E2E preserves nested sidebar hyperlink layout and actions in both directions";
const control = tests.find((test) => test.fullName === name);
assert(control);
assert.equal(control.status, "passed");
assert.deepEqual(control.failureMessages, []);
assert(tests.filter((test) => test !== control).every((test) => test.status === "skipped"));
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPassedTests, 1);
assert.equal(report.numPendingTests, 7);
assert.equal(report.numTodoTests ?? 0, 0);
const browserRoot = path.join(evidence, "browser");
const directories = fs
  .readdirSync(browserRoot)
  .map((name) => path.join(browserRoot, name))
  .filter((file) => fs.statSync(file).isDirectory());
assert.equal(directories.length, 1);
const directory = directories[0];
const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const raw = read("nested-link-geometry.json");
const links = read("nested-link-controls.json");
assert.deepEqual(raw.observations, links.observations);
assert.equal(raw.menuSettlements.length, 8);
assert(raw.menuSettlements.every((sample) => sample.completed));
for (const selector of ["wa-dropdown.sidebar-identity-menu", "wa-dropdown.sidebar-more-menu"])
  assert.equal(raw.menuSettlements.filter((sample) => sample.selector === selector).length, 4);
assert.equal(raw.submenuSettlements.length, 4);
assert.equal(links.configurations, 4);
assert.equal(links.linkActions, 8);
assert.equal(links.externalDestinationsIntercepted, true);
assert.equal(links.chatSends, 0);
assert.equal(links.sessionCreates, 0);
for (const direction of ["ltr", "rtl"])
  for (const scale of [1, 1.4]) {
    const settlements = raw.submenuSettlements.filter(
      (sample) => sample.direction === direction && sample.scale === scale,
    );
    assert.equal(settlements.length, 1);
    const settled = settlements[0];
    assert(settled.seenShow && settled.completed && settled.stages.length > 0);
    const last = settled.stages.at(-1);
    assert(last.open && !last.hidden);
    assert(
      !last.className.split(/\s+/).includes("show") &&
        !last.className.split(/\s+/).includes("hide"),
    );
    assert(["none", "1"].includes(last.scale));
    assert.deepEqual(last.animations, []);
    for (const family of ["identity-help", "more-routes"]) {
      const rows = links.observations.filter(
        (sample) =>
          sample.direction === direction && sample.scale === scale && sample.family === family,
      );
      assert(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.anchorDirection, direction);
        assert.equal(row.itemDirection, direction);
        assert(["none", "1"].includes(row.surfaceScale));
        assert.deepEqual(row.surfaceAnimations, []);
        for (const field of [
          "labelWidth",
          "labelLeft",
          "labelRight",
          "anchorWidth",
          "anchorLeft",
          "anchorRight",
          "iconWidth",
          "surfaceWidth",
          "surfaceLayoutWidth",
        ])
          assert(Number.isFinite(row[field]));
        assert(row.labelWidth > 0 && row.anchorWidth > 80);
        assert(row.labelLeft >= row.anchorLeft - 0.5 && row.labelRight <= row.anchorRight + 0.5);
        assert(row.anchorLeft >= row.itemLeft - 0.5 && row.anchorRight <= row.itemRight + 0.5);
        assert(Math.abs(row.anchorWidth - row.iconWidth - row.labelWidth - 8) <= 0.5);
      }
    }
  }
const hashes = {};
for (const direction of ["ltr", "rtl"])
  for (const scale of [1, 1.4])
    for (const family of ["identity-links", "more-links"]) {
      const file = path.join(directory, `${family}-${direction}-${scale}.png`);
      const data = fs.readFileSync(file);
      assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert(data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0);
      hashes[path.relative(evidence, file)] = createHash("sha256").update(data).digest("hex");
    }
const videos = read("page-videos.json");
assert.deepEqual(
  videos.map(({ page }) => page).sort(),
  ["links-main", "docs-ltr-1", "docs-ltr-1.4", "docs-rtl-1", "docs-rtl-1.4"].sort(),
);
for (const video of videos) assert.equal(path.basename(video.file), video.file);
assert.deepEqual(
  fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".webm"))
    .sort(),
  videos.map(({ file }) => file).sort(),
);
for (const video of videos) {
  const file = path.join(directory, video.file);
  const data = fs.readFileSync(file);
  assert(data.length > 32);
  hashes[path.relative(evidence, file)] = createHash("sha256").update(data).digest("hex");
}
fs.writeFileSync(
  path.join(evidence, "accepted-control.json"),
  JSON.stringify(
    {
      source: reuse.source,
      selected: 1,
      passed: 1,
      filtered: 7,
      raw,
      links,
      captureHashes: hashes,
      historicalPrimaryReference: {
        run: reuse.run,
        harness: reuse.harness,
        preservedScenarioSha256: reuse.preservedScenarioSha256,
      },
      scope:
        "Only previously unfinished nested-link baseline control executed. Original run remains failed; owner must join the separately retained completed primary evidence.",
      visualInspection: "pending full independent capture inspection",
    },
    null,
    2,
  ),
);
console.log(
  "SIDEBAR_NESTED_LINK_CONTROL_VERIFIED source608b; settled animation geometry and all existing interaction bounds passed",
);
