import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertNoRunnerRecovery } from "./reader-guards.mjs";
const lane = process.argv[2];
const read = (name) => readFileSync(path.join(lane, "reuse-72", name));
const json = (name) => JSON.parse(read(name));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync(path.join(lane, "MANIFEST.json"), "utf8"));
const original = json("original-manifest.json");
assert.equal(
  sha(read("original-manifest.json")),
  "5a0044a93524dedde37c8c213bc311b97cf646c1059c8cf030bbbefad6933eef",
);
assert.equal(original.source, manifest.source);
assert.deepEqual(original.sourceHashes, manifest.sourceHashes);
assert.deepEqual(original.staticOwnerHashes, manifest.staticOwnerHashes);
assert.deepEqual(original.candidateHashes, manifest.candidateHashes);
const originalPlan = json("original-plan-contract.json");
assert.equal(sha(read("original-plan-contract.json")), original.files["plan-contract.json"]);
const currentPlan = JSON.parse(readFileSync(path.join(lane, "plan-contract.json"), "utf8"));
assert.deepEqual(currentPlan.commandNames, originalPlan.commandNames);
assert.deepEqual(currentPlan.packageAliases, originalPlan.packageAliases);
const run = json("run.json");
assert.equal(run.databaseId, 34198758390);
assert.equal(run.headSha, "bc04a0d21cadbc66622d0075d7e05b0c0e83e86d");
assert.equal(run.status, "completed");
assert.equal(run.conclusion, "failure");
assert.equal(run.attempt, 1);
const jobs = run.jobs.filter((job) => job.databaseId === 101972504092);
assert.equal(jobs.length, 1);
assert.equal(jobs[0].status, "completed");
assert.equal(jobs[0].conclusion, "failure");
const artifacts = json("artifacts.json").artifacts.filter(
  (entry) => entry.name === "campaign50-automation-defaults-141548-1",
);
assert.equal(artifacts.length, 1);
assert.equal(artifacts[0].expired, false);
const downloads = json("downloads.json").filter((entry) => entry.artifactId === artifacts[0].id);
assert.equal(downloads.length, 1);
assert.equal(downloads[0].apiZipDigest, artifacts[0].digest);
assert.equal(downloads[0].downloadedOnce, true);
const source = json("source.json");
assert.equal(source.source, manifest.source);
assert.equal(source.node, manifest.node);
assert.equal(source.packageManager, manifest.packageManager);
for (const phase of ["before", "candidate"]) {
  const record = json(`hashes-${phase}.json`);
  assert.equal(record.source, manifest.source);
  assert.equal(record.manifestSha256, sha(read("original-manifest.json")));
  assert.deepEqual(
    record.sourceHashes,
    phase === "before"
      ? original.sourceHashes
      : { ...original.sourceHashes, ...original.candidateHashes },
  );
  assert.deepEqual(record.staticOwnerHashes, original.staticOwnerHashes);
  assert.deepEqual(record.packetHashes, original.files);
  if (phase === "candidate") {
    assert.deepEqual(
      record.copiedHashes,
      Object.fromEntries(
        Object.entries(original.copies).map(([name, dest]) => [dest, original.files[name]]),
      ),
    );
    assert.equal(
      record.generatedSha256,
      sha(readFileSync(path.join(lane, "reuse-69/generated-schema.json"))),
    );
  }
}
const normalize = (text) =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .join("\n");
assert.equal(
  normalize(read("final-working-tree.patch").toString()),
  normalize(
    readFileSync(path.join(lane, "regression.patch"), "utf8") +
      readFileSync(path.join(lane, "production.patch"), "utf8"),
  ),
);
assert.equal(read("phase.txt").toString().trim(), "remaining-static");
assert.equal(read("exit-code.txt").toString().trim(), "1");
const record = json("remaining-checks.json");
assert.equal(record.source, manifest.source);
assert.equal(record.canonicalPlanCount, originalPlan.commandNames.length);
assert.equal(record.expectedRemaining, originalPlan.remainingCommands.length);
assert.deepEqual(record.reusedCommands, originalPlan.retainedPrefix);
assert.deepEqual(
  record.planned,
  originalPlan.remainingCommands.map(({ name, bin, args }) => ({ name, bin: bin ?? "pnpm", args })),
);
assert.equal(record.complete, false);
assert.equal(record.explicitShimCleanup, true);
assert.equal(record.error.unjoinedWork, false);
assert.equal(record.error.code, "ERR_ASSERTION");
assert.equal(record.results.length, 4);
for (const [index, row] of record.results.entries()) {
  const planned = originalPlan.remainingCommands[index];
  assert.equal(row.name, planned.name);
  assert.equal(row.bin, planned.bin ?? "corepack");
  assert.deepEqual(row.args, planned.bin ? planned.args : ["pnpm", ...planned.args]);
  assert.equal(row.spawned, true);
  assert.equal(row.closed, true);
  assert.equal(row.strictProcessTreeExit, true);
  assert.equal(row.status, index < 3 ? 0 : 1);
  assert.equal(row.exitCode, row.status);
  assert.equal(row.exitSignal, null);
  assert.deepEqual(row.signals, []);
  assert.equal(row.stdoutEnded, true);
  assert.equal(row.stderrEnded, true);
  if (index < 3) assert.equal(row.strictOwnerResolved, true);
}
const passed = record.results.slice(0, 3).map((row) => row.name);
assert.deepEqual(passed, [
  "typecheck core tests",
  "coercion helper declaration guard",
  "deprecated API usage",
]);
assert.deepEqual(currentPlan.retainedPrefix, [...originalPlan.retainedPrefix, ...passed]);
assert.deepEqual(
  currentPlan.remainingCommands,
  originalPlan.remainingCommands.slice(passed.length),
);
const log = read("remaining-checks.log.txt")
  .toString()
  .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
assertNoRunnerRecovery(log);
assert.doesNotMatch(log, /timed out|ENOBUFS|ERROR: Error loading|unsafe cleanup/i);
assert.deepEqual(
  [...log.matchAll(/^\[remaining\] (.+)$/gm)].map((entry) => entry[1]),
  record.results.map((row) => row.name),
);
for (const name of ["production", "script"])
  assert.equal(
    log.split(`[deadcode] Knip ${name} unused-export scan passed with 0 entries.`).length - 1,
    1,
  );
const findings = log
  .split("Unused exports are not allowed:\n")[1]
  ?.split("\nDelete the exports")[0];
assert.equal(
  findings,
  "  ui/src/e2e/fixtures/automation-141548/types.ts: Fixture\n  ui/src/e2e/fixtures/automation-141548/types.ts: ProofApi",
);
const before = read("original-types.ts").toString();
assert.equal(sha(Buffer.from(before)), original.files["types.ts"]);
const after = readFileSync(path.join(lane, "types.ts"), "utf8");
assert.equal(
  after,
  before
    .replace("export type Fixture =", "type Fixture =")
    .replace("export type ProofApi =", "type ProofApi ="),
);
for (const name of ["browser.e2e.test.ts", "harness.ts"]) {
  const file = readFileSync(path.join(lane, name));
  assert.equal(sha(file), original.files[name]);
  assert.doesNotMatch(file.toString(), /\b(?:Fixture|ProofApi)\b/);
}
console.log(
  JSON.stringify(
    {
      accepted: true,
      originalRun: run.databaseId,
      originalJobConclusion: "failure",
      passedCommands: passed,
      failedCommand: record.results[3].name,
      wholeFailedCommandMustRun: true,
      cleanup: "natural close/EOF, no signals or unjoined work; shim cleaned",
      correction: "only two unused type export modifiers removed",
    },
    null,
    2,
  ),
);
