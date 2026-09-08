import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
const evidence = realpathSync(process.argv[2]);
const phase = process.argv[3];
assert.ok(phase === "owner" || phase === "browser");
const owner = readCompletedReport(
  path.join(evidence, "owner.json"),
  path.join(evidence, "owner.log"),
).report;
assert.equal(owner.numTotalTests, 9);
assert.equal(owner.numPassedTests, 9);
assert.equal(owner.numFailedTests, 0);
assert.equal(owner.numPendingTests, 0);
assert.equal(owner.numTodoTests ?? 0, 0);
if (phase === "owner") process.exit(0);
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "browser.log"),
);
assert.doesNotMatch(log, /run (?:was |is )?queued|unfinished|timed out|test timed out/i);
assert.equal(report.numTotalTests, 7);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPassedTests, 7);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
const assertions = report.testResults.flatMap((item) => item.assertionResults);
assert.equal(assertions.length, 7);
for (const result of assertions) {
  assert.equal(result.status, "passed");
  assert.deepEqual(result.failureMessages, []);
}
assert.equal(
  report.testResults
    .filter((file) => file.name.endsWith("dashboard-shell-avatar-grapheme.e2e.test.ts"))
    .flatMap((file) => file.assertionResults).length,
  3,
);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
const files = walk(path.join(evidence, "browser"));
const receiptFiles = files.filter((file) => path.basename(file) === "receipts.json");
assert.equal(receiptFiles.length, 4);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owned = (file) => {
  assert.equal(typeof file, "string");
  const resolved = realpathSync(file);
  assert.ok(resolved.startsWith(evidence + path.sep));
  return readFileSync(resolved);
};
const names = {
  emoji: "😀Alice",
  flag: "🇺🇸Team",
  joined: "👨‍👩‍👧‍👦Family",
  letter: "𐐨Name",
  lower: "alice",
  expansion: "ßeta",
  locale: "ilker",
  default: undefined,
  "no-environment": "😀Alice",
};
const expected = {
  emoji: ["😀", "😀"],
  flag: ["🇺🇸", "🇺🇸"],
  joined: ["👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"],
  letter: ["𐐀", "𐐨"],
  lower: ["A", "a"],
  expansion: ["SS", "ß"],
  locale: ["I", "i"],
  default: ["M", "A"],
  "no-environment": [null, null],
};
const verified = [];
const videos = new Set();
const screenshots = new Set();
for (const locale of ["en-US", "tr-TR"]) {
  for (const flow of ["dashboard", "shell"]) {
    const result = assertions.find(
      (item) => item.title === `${flow} initials preserve graphemes and casing ${locale}`,
    );
    assert.ok(result);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.failureMessages, []);
    const match = receiptFiles.filter((file) => {
      const joined = JSON.parse(readFileSync(path.join(path.dirname(file), "joined.json"), "utf8"));
      return joined.closed === true && joined.locale === locale && joined.flow === flow;
    });
    assert.equal(match.length, 1);
    const rows = JSON.parse(readFileSync(match[0], "utf8"));
    const ids =
      locale === "en-US"
        ? ["emoji", "flag", "joined", "letter", "lower", "expansion", "locale", "default"]
        : ["locale", "expansion"];
    if (flow === "shell") ids.push("no-environment");
    assert.deepEqual(
      rows.map((row) => row.id),
      ids,
    );
    for (const row of rows) {
      assert.equal(row.locale, locale);
      assert.equal(row.flow, flow);
      assert.equal(row.name, names[row.id]);
      const value = expected[row.id][flow === "dashboard" ? 0 : 1];
      assert.equal(row.expected, value);
      assert.equal(row.chatSends, 0);
      const defect = ["emoji", "flag", "joined", "letter"].includes(row.id);
      assert.equal(row.defect, defect);
      assert.equal(row.actual, value);
      if (flow === "shell" && value !== null) assert.ok(row.computed.includes(value));
      if (flow === "shell") {
        assert.equal(typeof row.computed, "string");
        assert.deepEqual(row.bootstrap, {
          path: "/control-ui-config.json",
          status: 200,
          assistantName: names[row.id] ?? null,
          environment: row.id === "no-environment" ? null : { label: "edge", color: "amber" },
        });
      }
      const screenshot = owned(row.screenshot);
      assert.equal(screenshot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(screenshot.readUInt32BE(16), 1440);
      assert.equal(screenshot.readUInt32BE(20), 900);
      screenshots.add(row.screenshot);
      const video = owned(row.video);
      assert.ok(video.length > 64);
      assert.equal(video.subarray(0, 4).toString("hex"), "1a45dfa3");
      videos.add(row.video);
      verified.push({ ...row, screenshotSha256: hash(screenshot), videoSha256: hash(video) });
    }
  }
}
assert.equal(verified.length, 22);
assert.equal(screenshots.size, 14);
assert.equal(videos.size, 14);
const nativeCasingFiles = files.filter((file) => path.basename(file) === "native-casing.json");
assert.equal(nativeCasingFiles.length, 1);
assert.deepEqual(JSON.parse(readFileSync(nativeCasingFiles[0], "utf8")), {
  browser: "151.0.7922.34",
  locale: "tr-TR",
  noArgument: "I",
  explicitTurkish: "İ",
  rootUpper: "I",
});
writeFileSync(
  path.join(evidence, "qualified-green.json"),
  JSON.stringify(
    {
      status: "candidate-all22rows-correct",
      rows: verified,
      screenshots: 14,
      videos: 14,
      captureInspection: "pending full inspection",
      inventory: files.map((file) => ({
        path: path.relative(evidence, file),
        sha256: hash(readFileSync(file)),
      })),
    },
    null,
    2,
  ),
);
