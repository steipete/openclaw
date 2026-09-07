import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [laneDir, evidenceDir] = process.argv.slice(2);
const reuseDir = path.join(laneDir, "reuse");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(reuseDir, file), "utf8"));
const lineage = readJson("LINEAGE.json");
assert.equal(lineage.run, 34067314611);
assert.equal(lineage.job, 101578264433);
assert.equal(lineage.harness, "f35646704bdfafd0e8a5368c11c945f1dd59b8f8");
assert.equal(lineage.source, "f63095668169ea0260f5f7b6479dafc85cc5226c");
assert.equal(lineage.candidate, "1a42e4917dfda234bd3a4e32dfcd365a06baf4cf3271497fbda544fcc6f3704b");
assert.equal(
  lineage.correctedReader,
  "01ee2284d0bdd3f4f3120db0b9f63d13b808eb38e1b9f3b8380a1429a1b8c03e",
);
const expectedArtifacts = [
  "unit.json",
  "unit.log.txt",
  "source.json",
  "unchanged-source.sha256",
  "final-working-tree.patch",
  "index.json",
  "aggregate.capture.json",
  "merge-config.mjs.txt",
  "run.json",
  "memory-job.log.txt",
  ...[1, 2, 3].flatMap((index) => [`shard-${index}.json`, `shard-${index}.capture.json`]),
];
assert.deepEqual(
  lineage.artifacts.map((entry) => entry.transportPath).sort(),
  expectedArtifacts.sort(),
);
for (const entry of lineage.artifacts) {
  const data = fs.readFileSync(path.join(reuseDir, entry.transportPath));
  assert.equal(data.length, entry.bytes, entry.transportPath);
  assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256, entry.transportPath);
}
const source = readJson("source.json");
assert.equal(source.source, lineage.source);
assert.equal(source.lane, "prepared-catalog-green");
assert.equal(source.mode, "green");
assert.equal(source.node, "24.20.0");
assert.ok(source.packageManager.startsWith("pnpm@12.3.4+"));
const run = readJson("run.json");
assert.equal(run.databaseId, lineage.run);
assert.equal(run.headSha, lineage.harness);
const jobs = run.jobs.filter((job) => job.databaseId === lineage.job);
assert.equal(jobs.length, 1);
assert.equal(jobs[0].status, "completed");
assert.equal(jobs[0].conclusion, "failure");

const outcome = { code: 0, noOutputTimedOut: false, signal: null, groupJoined: true };
const index = readJson("index.json");
assert.equal(index.complete, true);
assert.equal(index.error, "");
assert.equal(index.entries.length, 3);
assert.deepEqual(index.merge, outcome);
const rawTests = [];
const rawFiles = [];
const rawCaptures = [];
const normalizedTests = (report) =>
  report.testResults
    .flatMap((suite) =>
      suite.assertionResults.map((test) => ({
        file: path.basename(suite.name),
        fullName: test.fullName,
        status: test.status,
      })),
    )
    .map((test) => JSON.stringify(test))
    .sort();
const assertCapture = (capture, ignoreUnhandledErrors = false) => {
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.ignoreUnhandledErrors, ignoreUnhandledErrors);
  assert.equal(capture.passWithNoTests, false);
  assert.deepEqual(capture.ended, {
    reason: "passed",
    unhandledErrors: 0,
    failedModules: 0,
    suiteErrors: 0,
  });
};
for (const invocation of [1, 2, 3]) {
  const entries = index.entries.filter((entry) => entry.invocation === invocation);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.state, "finished");
  assert.equal(entry.acceptedAttempt, 1);
  assert.equal(entry.attempts.length, 1);
  assert.deepEqual(entry.attempts[0].outcome, outcome);
  const raw = readJson(`shard-${invocation}.json`);
  assert.equal(raw.success, true);
  assert.equal(raw.numFailedTests, 0);
  assert.equal(raw.numPendingTests, 0);
  assert.equal(raw.numTodoTests ?? 0, 0);
  const capture = readJson(`shard-${invocation}.capture.json`);
  assertCapture(capture);
  rawCaptures.push(capture);
  assert.deepEqual(
    capture.modules.map((module) => path.basename(module.file)).sort(),
    entry.includePatterns.map((file) => path.basename(file)).sort(),
  );
  rawFiles.push(...raw.testResults.map((suite) => path.basename(suite.name)));
  rawTests.push(...normalizedTests(raw));
}
const mergeSource = fs.readFileSync(path.join(reuseDir, "merge-config.mjs.txt"), "utf8");
assert.ok(mergeSource.startsWith("export default ") && mergeSource.endsWith(";\n"));
const mergeConfig = JSON.parse(mergeSource.slice("export default ".length, -2));
assert.equal(mergeConfig.test.passWithNoTests, false);
assert.equal(mergeConfig.test.dangerouslyIgnoreUnhandledErrors, true);
assert.deepEqual(mergeConfig.test.reporters[1][1].expected, rawCaptures);
const aggregateCapture = readJson("aggregate.capture.json");
assert.ok(aggregateCapture.command.includes("--mergeReports"));
// Native replay derives this flag from already-qualified zero-error input captures.
assertCapture(aggregateCapture, true);
assert.deepEqual(rawFiles.sort(), Object.keys(lineage.unitCounts).sort());
const aggregate = readJson("unit.json");
assert.deepEqual(rawTests.sort(), normalizedTests(aggregate));
assert.equal(rawTests.length, 261);
assert.deepEqual(
  Object.fromEntries(
    aggregate.testResults.map((suite) => [
      path.basename(suite.name),
      suite.assertionResults.length,
    ]),
  ),
  lineage.unitCounts,
);
const readerPath = path.join(laneDir, "validate-tests.mjs");
assert.equal(
  createHash("sha256").update(fs.readFileSync(readerPath)).digest("hex"),
  lineage.correctedReader,
);
const reader = spawnSync(
  process.execPath,
  [readerPath, path.join(reuseDir, "unit.json"), path.join(reuseDir, "unit.log.txt")],
  { encoding: "utf8" },
);
assert.equal(reader.error, undefined);
assert.equal(reader.signal, null);
assert.equal(reader.status, 0, reader.stderr);
assert.equal(reader.stdout.trim(), "PREPARED_CATALOG_GREEN_UNITS_CONFIRMED files=5 tests=261");
const receipt = {
  status: "qualified-reused-unit-green",
  run: lineage.run,
  job: lineage.job,
  harness: lineage.harness,
  source: lineage.source,
  candidate: lineage.candidate,
  files: 5,
  tests: 261,
  firstAttempts: 3,
  targetTestsExecuted: false,
};
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(
  path.join(evidenceDir, "reused-unit-verification.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log("PREPARED_CATALOG_REUSED_261_UNITS_CONFIRMED");
