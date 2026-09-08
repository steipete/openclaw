import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
import { assertIntendedFailure, assertNoRunnerRecovery } from "./reader-guards.mjs";
const [evidence, lane, nativeExit] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(lane, "MANIFEST.json"), "utf8"));
const fixtures = JSON.parse(fs.readFileSync(path.join(lane, "fixtures.json"), "utf8"));
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "vitest.log"),
);
assertNoRunnerRecovery(log);
assert.equal(Number(nativeExit), 1);
assert.equal(report.success, false);
assert.equal(report.numTotalTests, 6);
assert.equal(report.numPassedTests, 2);
assert.equal(report.numFailedTests, 4);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(assertions.length, 6);
assert.deepEqual(
  assertions.map((entry) => entry.title).sort(),
  fixtures.map((entry) => entry.id).sort(),
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
  fixtures.map((entry) => entry.id).sort(),
);
for (const fixture of fixtures) {
  const assertion = assertions.find((entry) => entry.title === fixture.id);
  const { dir, receipt } = receipts.find(({ receipt }) => receipt.id === fixture.id);
  assert.equal(receipt.source, manifest.source);
  assert.deepEqual(receipt.fixture, fixture.config);
  assert.deepEqual(receipt.browserErrors, []);
  assert.deepEqual(receipt.nonReadRequests, []);
  assert.equal(receipt.stages.length, 1);
  const initial = receipt.stages[0];
  assert.equal(initial.name, "initial");
  for (const snapshot of [initial.snapshot, receipt.final]) {
    assert.equal(snapshot.id, fixture.id);
    assert.deepEqual(snapshot.callbacks, []);
    assert.equal(snapshot.dirty, false);
    for (const key of ["form", "original", "sourceConfig"])
      assert.deepEqual(snapshot[key], fixture.config);
    assert.deepEqual(JSON.parse(snapshot.serialized), fixture.config);
    for (const key of ["raw", "rawOriginal", "snapshotRaw", "serialized"])
      assert.equal(snapshot[key], JSON.stringify(fixture.config));
  }
  assert.deepEqual(receipt.final, initial.snapshot);
  const expectedBoolean = fixture.expected === "On";
  assert.deepEqual(initial.displays, [
    { kind: "switch", checked: expectedBoolean },
    { kind: "switch", checked: expectedBoolean },
  ]);
  const intendedFailure = fixture.expected === "Default: On";
  assert.equal(assertion.status, intendedFailure ? "failed" : "passed");
  assert.equal(assertion.failureMessages.length, intendedFailure ? 1 : 0);
  if (intendedFailure) assertIntendedFailure(assertion.failureMessages, fixture.id);
  for (const name of ["initial-0.png", "initial-1.png"]) {
    const bytes = fs.readFileSync(path.join(dir, name));
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(bytes.length > 1000);
  }
  const videos = fs.readdirSync(dir).filter((name) => name.endsWith(".webm"));
  assert.equal(videos.length, 1);
  const video = fs.readFileSync(path.join(dir, videos[0]));
  assert.deepEqual(video.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  assert.ok(video.length > 1000);
}
fs.writeFileSync(
  path.join(evidence, "accepted-red.json"),
  `${JSON.stringify({ source: manifest.source, nativeExit: Number(nativeExit), accepted: "four omitted-setting DOM assertions only", cases: fixtures.map((fixture) => fixture.id), controls: "six initial/final raw/source/dirty/callback checks; explicit true and false; two unchanged metadata placeholders", mediaDirectories: directories }, null, 2)}\n`,
);
console.log(
  "Accepted baseline: four intended inherited-display assertions; two explicit-value controls; six zero-write initial states.",
);
