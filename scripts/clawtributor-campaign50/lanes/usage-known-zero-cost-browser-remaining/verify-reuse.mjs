import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lane = path.dirname(fileURLToPath(import.meta.url));
const evidence = process.argv[2];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (name) => JSON.parse(readFileSync(path.join(lane, name), "utf8"));
const reuse = read("REUSE.json");
for (const [name, expected] of Object.entries(reuse.files)) {
  assert.equal(hash(readFileSync(path.join(lane, name))), expected, name);
}
const historical = read("reuse/historical-run.json");
assert.equal(historical.databaseId, 34304097761);
assert.equal(historical.headSha, "6b4afc6b3659af285db44895c4f554d28743d88c");
assert.equal(historical.attempt, 1);
assert.equal(historical.status, "completed");
assert.equal(historical.conclusion, "failure");
assert.equal(historical.job.databaseId, 102317092344);
assert.equal(historical.job.status, "completed");
assert.equal(historical.job.conclusion, "failure");
assert.equal(reuse.run, historical.databaseId);
assert.equal(reuse.job, historical.job.databaseId);
assert.equal(reuse.harness, historical.headSha);
assert.equal(reuse.originalRun, "FAILURE");
assert.equal(reuse.browserQualified, false);
assert.equal(reuse.sourceRestoredInOldRun, false);
assert.equal(hash(readFileSync(path.join(lane, "reuse/packet-manifest.json"))), reuse.packet);
const manifest = read("reuse/packet-manifest.json");
assert.equal(
  hash(readFileSync(path.join(lane, "reuse/packet-source.json"))),
  manifest.inputFiles["source.json"],
);
assert.equal(
  hash(readFileSync(path.join(lane, "view.test.ts"))),
  manifest.inputFiles["view.test.ts"],
);
const current = read("source.json");
const prior = read("reuse/packet-source.json");
assert.equal(current.source, prior.source);
assert.equal(current.tree, prior.tree);
assert.deepEqual(current.original, prior.original);
const source = read("reuse/source.json");
assert.equal(source.source, current.source);
assert.equal(source.mode, "baseline");
assert.equal(source.node, "24.20.0");
assert.ok(source.packageManager.startsWith("pnpm@12.3.4+sha512."));
const before = read("reuse/source-before.json");
const applied = read("reuse/source-applied.json");
assert.equal(before.phase, "original");
assert.equal(applied.phase, "baseline");
assert.equal(before.source, current.source);
assert.equal(before.tree, current.tree);
assert.deepEqual(before.hashes, prior.original);
assert.deepEqual(applied.hashes, { ...prior.original, ...prior.baseline });
assert.deepEqual(applied.changedPaths, Object.keys(prior.baseline).sort());
assert.equal(hash(readFileSync(path.join(lane, "view.test.ts"))), prior.baseline[prior.unitFile]);
assert.deepEqual(
  readFileSync(path.join(lane, "reuse/applied.patch")),
  readFileSync(path.join(lane, "reuse/final-working-tree.patch")),
);
assert.equal(readFileSync(path.join(lane, "reuse/phase.txt"), "utf8").trim(), "browser");
for (const name of ["renderer-exit.txt", "exit-code.txt", "lane-exit.txt"]) {
  assert.equal(readFileSync(path.join(lane, "reuse", name), "utf8").trim(), "1");
}
assert.equal(
  readFileSync(path.join(lane, "reuse/final-status.txt"), "utf8"),
  "M  ui/src/e2e/usage-cost-analysis.e2e.test.ts\nM  ui/src/pages/usage/view.test.ts\n",
);
for (const name of ["renderer.json", "renderer.log", "renderer-exit.txt"]) {
  copyFileSync(path.join(lane, "reuse", name), path.join(evidence, name), constants.COPYFILE_EXCL);
}
assert.equal(existsSync(path.join(evidence, "qualified-renderer.json")), false);
// This invokes only the retained-data validator, never Vitest or a target module.
execFileSync(
  process.execPath,
  [path.join(lane, "validate.mjs"), evidence, "baseline", "renderer", "1"],
  { timeout: 10_000, stdio: "inherit" },
);
const qualified = JSON.parse(readFileSync(path.join(evidence, "qualified-renderer.json"), "utf8"));
assert.deepEqual(qualified, read("reuse/qualified-renderer.json"));
assert.equal(qualified.passed, 4);
assert.equal(qualified.expectedFailed, 4);
assert.equal(qualified.deliberatelyFiltered, 26);
assert.equal(qualified.componentQualified, true);
assert.equal(qualified.wholeLaneQualified, false);
writeFileSync(
  path.join(evidence, "renderer-reuse.json"),
  JSON.stringify(
    {
      historicalRun: reuse.run,
      historicalJob: reuse.job,
      historicalRunConclusion: "FAILURE",
      historicalBrowserQualified: false,
      historicalRestorationPerformed: false,
      rendererExecutedThisRun: false,
      rendererQualified: true,
      source: current.source,
      inputHashes: reuse.files,
    },
    null,
    2,
  ) + "\n",
);
