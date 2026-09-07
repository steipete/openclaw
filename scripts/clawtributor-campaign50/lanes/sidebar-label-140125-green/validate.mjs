import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const [evidence, phase] = process.argv.slice(2);
assert(phase === "author" || phase === "browser");
const lane = path.dirname(fileURLToPath(import.meta.url));
const reportName = phase === "author" ? "author.json" : "vitest.json";
const logName = phase === "author" ? "author.log" : "browser.log";
const { report, log } = readCompletedReport(
  path.join(evidence, reportName),
  path.join(evidence, logName),
);
assert.doesNotMatch(
  log,
  /Some tests are still running when generating the JSON report|unsafe cleanup|retiring owned fork/,
);
assert.equal(report.success, true);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
const file =
  phase === "author" ? "sidebar-interactions.e2e.test.ts" : "sidebar-label-owner.e2e.test.ts";
assert(suite.name.endsWith(`/ui/src/e2e/${file}`));
assert.equal(suite.status, "passed");
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert(
  suite.assertionResults.every(
    (test) => test.status === "passed" && test.failureMessages.length === 0,
  ),
);
assert.equal(suite.assertionResults.length, phase === "author" ? 7 : 2);
assert.equal(report.numPassedTests, phase === "author" ? 7 : 2);
if (phase === "author") {
  console.log("SIDEBAR_AUTHOR_REGRESSIONS_VERIFIED seven original author tests passed");
  process.exit(0);
}
const names = [
  "shows one row per agent and reaches agent switches with menu keys",
  "preserves nested sidebar hyperlink layout and actions in both directions",
];
assert.deepEqual(
  suite.assertionResults.map((test) => test.fullName).sort(),
  names.map((name) => `Control UI sidebar label owner proof ${name}`).sort(),
);
const directories = fs
  .readdirSync(path.join(evidence, "browser"))
  .map((name) => path.join(evidence, "browser", name))
  .filter((file) => fs.statSync(file).isDirectory());
assert.equal(directories.length, 2);
const findOne = (name) => {
  const found = directories
    .map((directory) => path.join(directory, name))
    .filter((file) => fs.existsSync(file));
  assert.equal(found.length, 1, `Expected one ${name}`);
  return found[0];
};
const read = (name) => JSON.parse(fs.readFileSync(findOne(name), "utf8"));
const samples = read("label-geometry.json");
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
  assert(sample.labelWidth > 0 && sample.clientWidth > 0);
  assert(sample.labelLeft >= sample.itemLeft - 0.5 && sample.labelRight <= sample.itemRight + 0.5);
}
const controls = read("label-controls.json");
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
const links = read("nested-link-controls.json");
const raw = read("nested-link-geometry.json");
assert.deepEqual(raw.observations, links.observations);
assert.equal(links.configurations, 4);
assert.equal(links.linkActions, 8);
assert.equal(links.externalDestinationsIntercepted, true);
assert.equal(links.chatSends, 0);
assert.equal(links.sessionCreates, 0);
assert.equal(raw.menuSettlements.length, 8);
assert(raw.menuSettlements.every((row) => row.completed));
assert.equal(raw.submenuSettlements.length, 4);
for (const sample of raw.submenuSettlements) {
  assert(sample.seenShow && sample.completed);
  const last = sample.stages.at(-1);
  assert(last.open && !last.hidden && ["none", "1"].includes(last.scale));
  assert.deepEqual(last.animations, []);
}
const baseline = JSON.parse(
  fs.readFileSync(path.join(lane, "baseline-link-geometry.json"), "utf8"),
);
const key = (row) => JSON.stringify([row.direction, row.scale, row.family, row.href, row.text]);
assert.equal(new Set(raw.observations.map(key)).size, raw.observations.length);
assert.deepEqual(raw.observations.map(key).sort(), baseline.observations.map(key).sort());
const allocation = (row) => [
  row.anchorWidth,
  row.anchorHeight,
  row.labelWidth,
  row.labelLeft - row.anchorLeft,
  row.labelRight - row.anchorLeft,
  row.iconWidth,
  row.anchorLeft - row.itemLeft,
  row.itemRight - row.anchorRight,
];
for (const row of raw.observations) {
  assert.equal(row.anchorDirection, row.direction);
  assert.equal(row.itemDirection, row.direction);
  assert(["none", "1"].includes(row.surfaceScale));
  assert.deepEqual(row.surfaceAnimations, []);
  assert(row.labelWidth > 0 && row.anchorWidth > 80);
  assert(row.labelLeft >= row.anchorLeft - 0.5 && row.labelRight <= row.anchorRight + 0.5);
  assert(row.anchorLeft >= row.itemLeft - 0.5 && row.anchorRight <= row.itemRight + 0.5);
  assert(Math.abs(row.anchorWidth - row.iconWidth - row.labelWidth - 8) <= 0.5);
  const previous = baseline.observations.find((entry) => key(entry) === key(row));
  const expected = allocation(previous);
  allocation(row).forEach((value, index) =>
    assert(
      Math.abs(value - expected[index]) <= 0.5,
      "Candidate changed live nested-link allocation",
    ),
  );
}
const captures = {};
const pngs = ["capabilities-unsent-focused.png", "agent-menu-without-new-session-rows.png"];
for (const direction of ["ltr", "rtl"])
  for (const scale of [1, 1.4])
    for (const prefix of ["long-label", "identity-links", "more-links"])
      pngs.push(`${prefix}-${direction}-${scale}.png`);
for (const name of pngs) {
  const file = findOne(name);
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert(data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0);
  captures[path.relative(evidence, file)] = createHash("sha256").update(data).digest("hex");
}
const videos = directories.flatMap((directory) =>
  JSON.parse(fs.readFileSync(path.join(directory, "page-videos.json"), "utf8")).map((row) => {
    assert.equal(path.basename(row.file), row.file);
    return { ...row, file: path.join(directory, row.file) };
  }),
);
assert.deepEqual(
  videos.map(({ page }) => page).sort(),
  ["agent-main", "links-main", "docs-ltr-1", "docs-ltr-1.4", "docs-rtl-1", "docs-rtl-1.4"].sort(),
);
const files = directories.flatMap((directory) =>
  fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".webm"))
    .map((name) => path.join(directory, name)),
);
assert.deepEqual(files.sort(), videos.map(({ file }) => file).sort());
for (const file of files) {
  const data = fs.readFileSync(file);
  assert(data.length > 32);
  captures[path.relative(evidence, file)] = createHash("sha256").update(data).digest("hex");
}
fs.writeFileSync(
  path.join(evidence, "accepted-green.json"),
  JSON.stringify(
    {
      source: process.env.SOURCE_SHA,
      authorTests: 7,
      browserCanaries: 2,
      allFresh: true,
      samples,
      controls,
      links,
      raw,
      captures,
      historicalBaselineRuns: [34090441998, 34103844505],
      scope:
        "Exact native411e candidate; original author tests unchanged; supplemental canary is ephemeral proof only. No historical output is reused as candidate behavior.",
      visualInspection: "pending independent full capture inspection",
    },
    null,
    2,
  ),
);
console.log(
  "SIDEBAR_LABEL_GREEN_VERIFIED contained labels and unchanged nested-link geometry with all original interaction controls",
);
