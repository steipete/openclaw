import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
import { assertNoRunnerRecovery } from "./reader-guards.mjs";
const [evidence, lane, nativeExit] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(lane, "MANIFEST.json"), "utf8"));
const fixtures = JSON.parse(fs.readFileSync(path.join(lane, "fixtures.json"), "utf8"));
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "vitest.log"),
);
assertNoRunnerRecovery(log);
assert.equal(Number(nativeExit), 0);
assert.equal(report.success, true);
assert.equal(report.numTotalTests, 6);
assert.equal(report.numPassedTests, 6);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
assert.ok(
  report.testResults[0].name.endsWith("/ui/src/e2e/automation-defaults-141548.e2e.test.ts"),
);
const assertions = report.testResults[0].assertionResults;
assert.equal(assertions.length, 6);
assert.deepEqual(
  assertions.map((test) => test.title).sort(),
  fixtures.map((fixture) => fixture.id).sort(),
);
assert.ok(
  assertions.every((test) => test.status === "passed" && test.failureMessages.length === 0),
);
const media = path.join(evidence, "media");
const directories = fs.readdirSync(media).map((name) => path.join(media, name));
assert.equal(directories.length, 6);
const receipts = directories.map((dir) => ({
  dir,
  receipt: JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8")),
}));
assert.deepEqual(
  receipts.map(({ receipt }) => receipt.id).sort(),
  fixtures.map((fixture) => fixture.id).sort(),
);
const options = ["Default: On", "On", "Off"];
const display = (label) => ({ kind: "select", label, options });
function assertOriginal(snapshot, fixture) {
  assert.equal(snapshot.id, fixture.id);
  assert.deepEqual(snapshot.original, fixture.config);
  assert.deepEqual(snapshot.sourceConfig, fixture.config);
  assert.equal(snapshot.rawOriginal, JSON.stringify(fixture.config));
  assert.equal(snapshot.snapshotRaw, JSON.stringify(fixture.config));
}
for (const fixture of fixtures) {
  const { dir, receipt } = receipts.find(({ receipt }) => receipt.id === fixture.id);
  assert.equal(receipt.source, manifest.source);
  assert.deepEqual(receipt.fixture, fixture.config);
  assert.deepEqual(receipt.browserErrors, []);
  assert.deepEqual(receipt.nonReadRequests, []);
  const initial = receipt.stages[0];
  assert.equal(initial.name, "initial");
  assertOriginal(initial.snapshot, fixture);
  assert.deepEqual(initial.snapshot.callbacks, []);
  assert.equal(initial.snapshot.dirty, false);
  assert.deepEqual(initial.snapshot.form, fixture.config);
  assert.equal(initial.snapshot.raw, JSON.stringify(fixture.config));
  assert.equal(initial.snapshot.serialized, JSON.stringify(fixture.config));
  assert.deepEqual(initial.displays, [display(fixture.expected), display(fixture.expected)]);
  const expectedNames = ["initial-0.png", "initial-1.png"];
  if (fixture.id === "roundtrip") {
    assert.equal(receipt.stages.length, 8);
    const expectedConfig = structuredClone(fixture.config);
    const callbacks = [];
    let stageIndex = 1;
    for (const field of [0, 1]) {
      for (const label of ["On", "Off", "Default: On"]) {
        const stage = receipt.stages[stageIndex++];
        const fieldPath = field === 0 ? ["cron", "enabled"] : ["cron", "triggers", "enabled"];
        const holder = field === 0 ? expectedConfig.cron : expectedConfig.cron.triggers;
        if (label === "Default: On") {
          delete holder.enabled;
          callbacks.push({ kind: "remove", path: fieldPath });
        } else {
          holder.enabled = label === "On";
          callbacks.push({ kind: "patch", path: fieldPath, value: holder.enabled });
        }
        assert.equal(stage.name, `${field}-${label}`);
        assertOriginal(stage.snapshot, fixture);
        assert.deepEqual(stage.snapshot.form, expectedConfig);
        assert.deepEqual(JSON.parse(stage.snapshot.raw), expectedConfig);
        assert.deepEqual(JSON.parse(stage.snapshot.serialized), expectedConfig);
        assert.deepEqual(stage.snapshot.callbacks, callbacks);
        assert.equal(stage.snapshot.dirty, label !== "Default: On");
        const expectedDisplays = [display("Default: On"), display("Default: On")];
        expectedDisplays[field] = display(label);
        assert.deepEqual(stage.displays, expectedDisplays);
        expectedNames.push(`choice-${field}-${callbacks.length}.png`);
      }
    }
    const reloaded = receipt.stages[7];
    assert.equal(reloaded.name, "reloaded");
    assertOriginal(reloaded.snapshot, fixture);
    assert.deepEqual(reloaded.snapshot.callbacks, callbacks);
    assert.deepEqual(reloaded.snapshot.form, fixture.config);
    assert.equal(reloaded.snapshot.dirty, false);
    assert.equal(reloaded.snapshot.raw, JSON.stringify(fixture.config));
    assert.equal(reloaded.snapshot.serialized, JSON.stringify(fixture.config));
    assert.deepEqual(reloaded.displays, [display("Default: On"), display("Default: On")]);
    assert.deepEqual(receipt.final, reloaded.snapshot);
    expectedNames.push("reloaded.png");
  } else {
    assert.equal(receipt.stages.length, 1);
    assert.deepEqual(receipt.final, initial.snapshot);
  }
  assert.deepEqual(
    receipt.captures.map((capture) => capture.name),
    expectedNames,
  );
  for (const capture of receipt.captures) {
    const { bounds, viewport } = capture;
    assert.deepEqual(viewport, { width: 1280, height: 900 });
    for (const value of Object.values(bounds)) assert.ok(Number.isFinite(value));
    assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0);
    assert.ok(
      bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
    );
    const bytes = fs.readFileSync(path.join(dir, capture.name));
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.readUInt32BE(16), 1280);
    assert.equal(bytes.readUInt32BE(20), 900);
    assert.ok(bytes.length > 1000);
  }
  const videos = fs.readdirSync(dir).filter((name) => name.endsWith(".webm"));
  assert.equal(videos.length, 1);
  const video = fs.readFileSync(path.join(dir, videos[0]));
  assert.deepEqual(video.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  assert.ok(video.length > 1000);
}
fs.writeFileSync(
  path.join(evidence, "accepted-green.json"),
  `${JSON.stringify({ source: manifest.source, nativeExit: Number(nativeExit), browserCases: 6, initialZeroWriteStates: 6, roundtripActions: 6, capturesWithViewportBounds: 19, mediaDirectories: directories, scope: "configuration form/draft/serialization/reload, not live scheduler or save transport" }, null, 2)}\n`,
);
console.log(
  "Accepted candidate: six browser cases, six real selection actions, preserved source/siblings, and all capture bounds.",
);
