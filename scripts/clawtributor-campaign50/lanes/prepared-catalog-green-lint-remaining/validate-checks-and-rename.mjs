import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [laneDir, targetDir, evidenceDir] = process.argv.slice(2);
const reuseDir = path.join(laneDir, "reuse-checks");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(reuseDir, name), "utf8"));
const digest = (data) => createHash("sha256").update(data).digest("hex");
const lineage = readJson("LINEAGE.json");
assert.equal(lineage.run, 34071194087);
assert.equal(lineage.job, 101588756678);
assert.equal(lineage.harness, "8c848224d255ccc6971ac769d673b3453d1ad3e4");
assert.equal(lineage.source, "f63095668169ea0260f5f7b6479dafc85cc5226c");
assert.equal(
  lineage.executedCandidate,
  "1a42e4917dfda234bd3a4e32dfcd365a06baf4cf3271497fbda544fcc6f3704b",
);
assert.equal(
  lineage.currentCandidate,
  "e922e214813934dca1467b052828bbcff18130ff61752f99ba6780950c408b30",
);
const artifactNames = [
  "source.json",
  "unchanged-source.sha256",
  "final-working-tree.patch",
  "reused-unit-verification.json",
  "exit-code.txt",
  "check-changed.log.txt",
  "run.json",
];
assert.deepEqual(
  lineage.artifacts.map((entry) => entry.transportPath).sort(),
  artifactNames.sort(),
);
for (const entry of lineage.artifacts) {
  const data = fs.readFileSync(path.join(reuseDir, entry.transportPath));
  assert.equal(data.length, entry.bytes, entry.transportPath);
  assert.equal(digest(data), entry.sha256, entry.transportPath);
}
const source = readJson("source.json");
assert.equal(source.source, lineage.source);
assert.equal(source.lane, "prepared-catalog-green-remaining");
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
assert.equal(fs.readFileSync(path.join(reuseDir, "exit-code.txt"), "utf8").trim(), "1");
const units = readJson("reused-unit-verification.json");
assert.deepEqual(units, {
  status: "qualified-reused-unit-green",
  run: 34067314611,
  job: 101578264433,
  harness: "f35646704bdfafd0e8a5368c11c945f1dd59b8f8",
  source: lineage.source,
  candidate: lineage.executedCandidate,
  files: 5,
  tests: 261,
  firstAttempts: 3,
  targetTestsExecuted: false,
});
const log = fs
  .readFileSync(path.join(reuseDir, "check-changed.log.txt"), "utf8")
  .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
const sections = log.split("[check:changed] summary");
assert.equal(sections.length, 2);
const checks = sections[1].split("\n").flatMap((line) => {
  const match = /^\s+(\d+(?:\.\d+)?(?:ms|s))\s+(ok|failed:\d+)\s+(.+)$/.exec(line);
  return match ? [{ status: match[2], name: match[3] }] : [];
});
const passedNames = [
  "conflict markers",
  "max-lines suppression ratchet",
  "assertion SAFETY comment ratchet",
  "changelog attributions",
  "doctor deprecation registry",
  "guarded extension wildcard re-exports",
  "plugin-sdk wildcard re-exports",
  "duplicate scan target coverage",
  "dependency pin guard",
  "format changed files",
  "plugin boundaries",
  "wrapper shadowing",
  "package patch guard",
  "test temp creation report (warning-only)",
  "core tsgo graph boundary",
  "typecheck core",
  "typecheck core tests",
  "coercion helper declaration guard",
  "deprecated API usage",
  "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
];
assert.deepEqual(checks, [
  ...passedNames.map((name) => ({ status: "ok", name })),
  { status: "failed:1", name: "lint core changed files" },
]);
assert.equal(
  log.split("eslint(no-shadow): 'model' is already declared in the upper scope.").length,
  2,
);
assert.ok(log.includes("Found 0 warnings and 1 error."));
assert.ok(log.includes("[check:changed] FAILED (exit 1)"));
const owner = "src/auto-reply/reply/agent-runner-memory.ts";
const current = fs.readFileSync(path.join(targetDir, owner), "utf8");
assert.equal(digest(current), "b62bc3bdcfaa601120173c70beaacc22777b0e1a5fb2ec6ac42a2f53b5ddf7cc");
for (const text of [
  "const catalogModel = findModelInCatalog(",
  "modelContextWindow: catalogModel?.contextWindow",
  "modelContextTokens: catalogModel?.contextTokens",
]) {
  assert.equal(current.split(text).length - 1, 2, text);
}
assert.equal(current.split("catalogModel").length - 1, 6);
const previous = current.replaceAll("catalogModel", "model");
assert.equal(digest(previous), "072a0d07915553db4841626d854c0f51f34064fa34ee3def4738a0a3d5ff2af5");
const readHashes = (name) =>
  Object.fromEntries(
    fs
      .readFileSync(path.join(laneDir, name), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        assert.ok(match);
        return [match[2], match[1]];
      }),
  );
const before = readHashes("candidate-before-source.sha256");
const after = readHashes("candidate-source.sha256");
assert.equal(Object.keys(before).length, 6);
assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
for (const [file, hash] of Object.entries(after)) {
  assert.equal(digest(fs.readFileSync(path.join(targetDir, file))), hash, file);
  if (file !== owner) assert.equal(hash, before[file], file);
}
const receipt = {
  status: "qualified-equivalent-evidence-reuse",
  unitRun: units.run,
  unitTests: 261,
  checkRun: lineage.run,
  passedChecks: 20,
  executedCandidate: lineage.executedCandidate,
  currentCandidate: lineage.currentCandidate,
  equivalence:
    "Two local binding names and four direct references; inverse substitution byte-identical",
  freshRemaining: ["exact failed lint", "build", "four candidate Gateway cells"],
  targetTestsExecuted: false,
};
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(
  path.join(evidenceDir, "rename-and-check-reuse.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log("PREPARED_CATALOG_ALPHA_REUSE_CONFIRMED tests=261 checks=20");
