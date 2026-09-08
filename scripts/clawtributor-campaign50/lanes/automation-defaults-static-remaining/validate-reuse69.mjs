import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
import { assertNoRunnerRecovery } from "./reader-guards.mjs";
const lane = process.argv[2];
const reuse = path.join(lane, "reuse-69");
const bytes = (file) => readFileSync(path.join(reuse, file));
const json = (file) => JSON.parse(bytes(file));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifest = JSON.parse(readFileSync(path.join(lane, "MANIFEST.json"), "utf8"));
const lineage = manifest.reusedCandidate;
const original = json("original-manifest.json");
assert.equal(
  hash(bytes("original-manifest.json")),
  "c63de915ca12bc93ee47c4503752ba28fc4df5ba9f923315c297b3871d8dd291",
);
assert.equal(lineage.manifest, hash(bytes("original-manifest.json")));
assert.equal(original.source, manifest.source);
assert.deepEqual(original.sourceHashes, manifest.sourceHashes);
assert.deepEqual(original.candidateHashes, manifest.candidateHashes);
for (const [carrier, mapping] of Object.entries(lineage.carriers))
  assert.equal(hash(readFileSync(path.join(lane, carrier))), mapping.sha256);
for (const name of ["regression.patch", "production.patch", "harness.html", "fixtures.json"])
  assert.equal(hash(readFileSync(path.join(lane, name))), original.files[name]);
for (const name of ["harness.ts", "types.ts", "browser.e2e.test.ts"])
  assert.equal(hash(bytes(`proof-inputs/${name}`)), original.files[name]);
const run = json("run.json");
assert.equal(run.databaseId, 34189419890);
assert.equal(run.databaseId, lineage.run);
assert.equal(run.headSha, "da4eea6a92a5522ae564ac5618923c2313e771f9");
assert.equal(run.headSha, lineage.harness);
assert.equal(run.attempt, 1);
assert.equal(run.conclusion, "failure");
assert.equal(run.status, "completed");
const job = run.jobs.filter((entry) => entry.databaseId === lineage.job);
assert.equal(job.length, 1);
assert.equal(job[0].databaseId, 101944258826);
assert.equal(job[0].status, "completed");
assert.equal(job[0].conclusion, "failure");
const artifacts = json("artifacts.json").artifacts;
assert.equal(artifacts.length, 1);
assert.equal(artifacts[0].id, lineage.artifactId);
assert.equal(artifacts[0].id, 10042039260);
assert.equal(artifacts[0].name, lineage.artifactName);
assert.equal(artifacts[0].digest, lineage.apiZipDigest);
assert.equal(artifacts[0].expired, false);
const download = json("downloads.json");
assert.equal(download.length, 1);
assert.equal(download[0].artifactId, artifacts[0].id);
assert.equal(download[0].apiZipDigest, artifacts[0].digest);
assert.equal(download[0].downloadedOnce, true);
const source = json("source.json");
assert.equal(source.source, manifest.source);
assert.equal(source.node, manifest.node);
assert.equal(source.packageManager, manifest.packageManager);
assert.equal(source.mode, "green");
assert.equal(source.lane, "automation-defaults-141548");
for (const phase of ["before", "unit-red", "candidate"]) {
  const record = json(`hashes-${phase}.json`);
  const expected = { ...original.sourceHashes };
  if (phase !== "before")
    expected["src/config/schema.hints.test.ts"] =
      original.candidateHashes["src/config/schema.hints.test.ts"];
  if (phase === "candidate") Object.assign(expected, original.candidateHashes);
  assert.equal(record.source, manifest.source);
  assert.equal(record.manifestSha256, lineage.manifest);
  assert.deepEqual(record.sourceHashes, expected);
  assert.deepEqual(record.packetHashes, original.files);
  if (phase === "candidate") {
    assert.deepEqual(
      record.copiedHashes,
      Object.fromEntries(
        Object.entries(original.copies).map(([name, dest]) => [dest, original.files[name]]),
      ),
    );
    assert.equal(record.generatedSha256, hash(bytes("generated-schema.json")));
  }
}
const normalize = (data) =>
  data
    .toString()
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .join("\n");
assert.equal(
  normalize(bytes("final-working-tree.patch")),
  normalize(
    Buffer.concat([
      readFileSync(path.join(lane, "regression.patch")),
      readFileSync(path.join(lane, "production.patch")),
    ]),
  ),
);
assert.equal(bytes("phase.txt").toString().trim(), "changed-check");
assert.equal(bytes("exit-code.txt").toString().trim(), "1");
assert.equal(bytes("native-exit.txt").toString().trim(), "0");
const unit = readCompletedReport(
  path.join(reuse, "unit-green.json"),
  path.join(reuse, "unit-green.log.txt"),
);
assertNoRunnerRecovery(unit.log);
assert.equal(unit.report.success, true);
assert.equal(unit.report.numTotalTests, 15);
assert.equal(unit.report.numPassedTests, 15);
assert.equal(unit.report.numFailedTests, 0);
assert.equal(unit.report.numPendingTests, 0);
assert.equal(unit.report.numTodoTests ?? 0, 0);
assert.equal(unit.report.testResults.length, 1);
assert.ok(unit.report.testResults[0].name.endsWith("/src/config/schema.hints.test.ts"));
assert.equal(unit.report.testResults[0].assertionResults.length, 15);
assert.ok(
  unit.report.testResults[0].assertionResults.every(
    (test) => test.status === "passed" && test.failureMessages.length === 0,
  ),
);
for (const name of ["cron.enabled", "cron.triggers.enabled"])
  assert.equal(
    unit.report.testResults[0].assertionResults.filter(
      (test) => test.title === `names the inherited state for ${name}`,
    ).length,
    1,
  );
const { report, log } = readCompletedReport(
  path.join(reuse, "vitest.json"),
  path.join(reuse, "vitest.log.txt"),
);
assertNoRunnerRecovery(log);
assert.equal(report.success, true);
assert.equal(report.numTotalTests, 6);
assert.equal(report.numPassedTests, 6);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
assert.ok(
  report.testResults[0].assertionResults.every(
    (test) => test.status === "passed" && test.failureMessages.length === 0,
  ),
);
assert.doesNotMatch(
  log,
  /unsafe cleanup|failed to capture failure diagnostics|hanging process|close timed out/i,
);
const fixtures = JSON.parse(readFileSync(path.join(lane, "fixtures.json"), "utf8"));
assert.deepEqual(
  report.testResults[0].assertionResults.map((test) => test.title).sort(),
  fixtures.map((fixture) => fixture.id).sort(),
);
const generated = json("generated-schema.json");
assert.equal(generated.source, manifest.source);
assert.deepEqual(generated.fixtures, fixtures);
assert.equal(generated.validation.length, 6);
assert.ok(generated.validation.every((entry) => entry.valid === true));
for (const key of ["cron.enabled", "cron.triggers.enabled"])
  assert.equal(generated.schemaResponse.uiHints[key].placeholder, "Default: On");
const pngs = json("inspected-media.json");
assert.equal(pngs.length, 19);
assert.equal(new Set(pngs.map((entry) => entry.artifactPath)).size, 19);
let captures = 0;
for (const fixture of fixtures) {
  const record = json(`cases/${fixture.id}.json`);
  assert.equal(record.source, manifest.source);
  assert.deepEqual(record.fixture, fixture.config);
  assert.deepEqual(record.browserErrors, []);
  assert.deepEqual(record.nonReadRequests, []);
  const expected = structuredClone(fixture.config);
  const callbacks = [];
  assert.equal(record.stages.length, fixture.id === "roundtrip" ? 8 : 1);
  for (const [index, stage] of record.stages.entries()) {
    if (index > 0 && index < 7) {
      const field = index <= 3 ? 0 : 1;
      const choice = (index - 1) % 3;
      const holder = field === 0 ? expected.cron : expected.cron.triggers;
      const fieldPath = field === 0 ? ["cron", "enabled"] : ["cron", "triggers", "enabled"];
      if (choice === 2) {
        delete holder.enabled;
        callbacks.push({ kind: "remove", path: fieldPath });
      } else {
        holder.enabled = choice === 0;
        callbacks.push({ kind: "patch", path: fieldPath, value: holder.enabled });
      }
      assert.equal(stage.name, `${field}-${["On", "Off", "Default: On"][choice]}`);
    } else assert.equal(stage.name, index === 0 ? "initial" : "reloaded");
    const state = stage.snapshot;
    assert.deepEqual(state.callbacks, callbacks);
    assert.deepEqual(state.form, expected);
    assert.deepEqual(JSON.parse(state.raw), expected);
    assert.deepEqual(JSON.parse(state.serialized), expected);
    if (index === 0 || index === 7) {
      assert.equal(state.raw, JSON.stringify(fixture.config));
      assert.equal(state.serialized, JSON.stringify(fixture.config));
    }
    assert.deepEqual(state.original, fixture.config);
    assert.deepEqual(state.sourceConfig, fixture.config);
    assert.equal(state.rawOriginal, JSON.stringify(fixture.config));
    assert.equal(state.snapshotRaw, JSON.stringify(fixture.config));
    assert.equal(state.dirty, index > 0 && index < 7 && index % 3 !== 0);
    for (const field of [0, 1]) {
      const value = field === 0 ? expected.cron?.enabled : expected.cron?.triggers?.enabled;
      assert.deepEqual(stage.displays[field], {
        kind: "select",
        label: value === undefined ? "Default: On" : value ? "On" : "Off",
        options: ["Default: On", "On", "Off"],
      });
    }
  }
  assert.deepEqual(record.final, record.stages.at(-1).snapshot);
  const expectedNames = [
    "initial-0.png",
    "initial-1.png",
    ...(fixture.id === "roundtrip"
      ? [
          "choice-0-1.png",
          "choice-0-2.png",
          "choice-0-3.png",
          "choice-1-4.png",
          "choice-1-5.png",
          "choice-1-6.png",
          "reloaded.png",
        ]
      : []),
  ];
  assert.deepEqual(
    record.captures.map((entry) => entry.name),
    expectedNames,
  );
  for (const capture of record.captures) {
    const { bounds: b, viewport } = capture;
    assert.deepEqual(viewport, { width: 1280, height: 900 });
    assert.ok(Object.values(b).every(Number.isFinite));
    assert.ok(
      b.width > 0 &&
        b.height > 0 &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.x + b.width <= 1280 &&
        b.y + b.height <= 900,
    );
    const carrier = lineage.carriers[`reuse-69/cases/${fixture.id}.json`].originalArtifactPath;
    const image = pngs.filter(
      (entry) => entry.artifactPath === carrier.replace(/receipt\.json$/, capture.name),
    );
    assert.equal(image.length, 1);
    assert.match(image[0].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(image[0].dimensions, [1280, 900]);
    captures += 1;
  }
}
assert.equal(captures, 19);
const changedLog = bytes("changed-check.log.txt")
  .toString()
  .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assertNoRunnerRecovery(changedLog);
assert.deepEqual(
  [...changedLog.matchAll(/^\s+\S+\s+ok\s+(.+)$/gm)].map((match) => match[1]),
  lineage.passedChecks,
);
const errors = [
  ...changedLog.matchAll(
    /^ui\/src\/e2e\/automation-defaults-141548\.e2e\.test\.ts\(\d+,\d+\): error TS(\d+): (.+)$/gm,
  ),
];
assert.equal(errors.length, 8);
assert.deepEqual(
  errors.map((entry) => entry[1]),
  ["1543", "2532", "2339", "2339", "2339", "2339", "2339", "2339"],
);
assert.equal([...changedLog.matchAll(/: error TS\d+:/g)].length, 8);
assert.match(changedLog, /failed:1\s+typecheck core tests/);
console.log(
  JSON.stringify(
    {
      accepted: true,
      originalRun: lineage.run,
      originalJobConclusion: "failure",
      source: manifest.source,
      unitGreen: 15,
      browserGreen: 6,
      actions: 6,
      inspectedPngHashes: 19,
      staticPassed: lineage.passedChecks,
      remainingStarts: "typecheck core tests",
      noFunctionalReplay: true,
    },
    null,
    2,
  ),
);
