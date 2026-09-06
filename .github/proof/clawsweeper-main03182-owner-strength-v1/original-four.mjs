// Exact original reports -> actual production compaction -> compiled detectors -> renderer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { report, markers } from "./main-proof-report-helpers.mjs";

const [repoArg, fixturesArg, ordinalArg, outputArg, candidateBindingArg] = process.argv.slice(2);
const root = pathToFileURL(`${resolve(repoArg)}/`);
const inputs = pathToFileURL(`${resolve(fixturesArg)}/`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const read = (path) => readFileSync(new URL(path, root));
const git = (...args) => execFileSync("git", ["--no-replace-objects", ...args], {
  cwd: fileURLToPath(root),
  encoding: "utf8",
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 10000,
});

async function main() {
  assert.equal(process.argv.length, 7, "Usage: original-four.mjs <repo> <fixture-dir> <ordinal> <result.json> <candidate-binding.json>");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
  const binding = JSON.parse(readFileSync(new URL("binding.json", inputs)));
  const cases = JSON.parse(readFileSync(new URL("cases.json", inputs)));
  const ordinal = Number(ordinalArg);
  assert.equal(cases.length, 4);
  assert.ok(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < 4);
  const candidateBindingBytes = readFileSync(candidateBindingArg);
  const candidate = JSON.parse(candidateBindingBytes);
  assert.deepEqual(Object.keys(candidate).sort(), ["mainSha", "sourceDiffSHA256", "sourceOwners"]);
  assert.equal(candidate.mainSha, binding.mainSha);
  assert.equal(git("rev-parse", "HEAD").trim(), binding.mainSha);
  assert.match(candidate.sourceDiffSHA256, /^[a-f0-9]{64}$/);
  assert.equal(
    sha256(git("diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "src")),
    candidate.sourceDiffSHA256,
  );
  assert.ok(Array.isArray(candidate.sourceOwners));
  assert.deepEqual(
    candidate.sourceOwners.map((owner) => owner.path).sort(),
    binding.sourceOwners.map((owner) => owner.path).sort(),
  );
  for (const owner of candidate.sourceOwners) {
    assert.deepEqual(Object.keys(owner).sort(), ["bytes", "path", "sha256"]);
    assert.ok(Number.isSafeInteger(owner.bytes) && owner.bytes >= 0);
    assert.match(owner.sha256, /^[a-f0-9]{64}$/);
    const bytes = read(owner.path);
    assert.equal(bytes.length, owner.bytes);
    assert.equal(sha256(bytes), owner.sha256);
  }
  const selected = cases[ordinal];
  const fixtureBinding = binding.fixtures.find((entry) => entry.file === selected.fixture);
  assert.ok(fixtureBinding);
  const fixtureBytes = readFileSync(new URL(selected.fixture, inputs));
  assert.equal(fixtureBytes.length, fixtureBinding.bytes);
  assert.equal(sha256(fixtureBytes), fixtureBinding.sha256);
  const fixture = JSON.parse(fixtureBytes);
  assert.equal(fixture.number, fixtureBinding.number);
  assert.equal(fixture.repository, "openclaw/openclaw");
  assert.equal(fixture.headSha, fixtureBinding.headSha);
  assert.equal(fixture.baseSha, fixtureBinding.baseSha);
  assert.equal(fixture.pullFiles.length, fixtureBinding.pullFileCount);

  const { createContextHydration } = await import(new URL("dist/clawsweeper-context-hydration.js", root));
  const { asRecord } = await import(new URL("dist/clawsweeper-item-policy.js", root));
  const unavailable = () => { throw new Error("Unused external hydration capability called"); };
  const { compactPullFile } = createContextHydration(new Proxy({ asRecord }, {
    get: (target, key) => Object.hasOwn(target, key) ? target[key] : unavailable,
  }));
  assert.ok(["full", "production-normalized"].includes(selected.mode));
  const pullFiles = selected.mode === "full" ? fixture.pullFiles : fixture.pullFiles.map(compactPullFile);
  if (selected.mode === "production-normalized") {
    for (let index = 0; index < pullFiles.length; index += 1) {
      const original = fixture.pullFiles[index];
      assert.equal(pullFiles[index].filename, original.filename);
      assert.equal(pullFiles[index].patch, original.patch.length <= 2000
        ? original.patch : `${original.patch.slice(0, 2000)}\n\n[truncated ${original.patch.length - 2000} chars]`);
    }
  }
  const { dataModelChangeFromContext, sqliteSchemaChangeFromContext } = await import(new URL("dist/clawsweeper-change-detection.js", root));
  const { renderReviewCommentFromReport } = await import(new URL("dist/clawsweeper.js", root));
  const context = { issue: {}, comments: [], timeline: [], pullFiles };
  const detection = dataModelChangeFromContext("openclaw/openclaw", context);
  const sqlite = sqliteSchemaChangeFromContext("openclaw/openclaw", context);
  const rendered = renderReviewCommentFromReport(report(detection, sqlite, false), "none");
  const observed = markers(rendered);
  const failures = [];
  for (const [boundary, check] of [
    ["persisted-classification", () => assert.deepEqual(detection, selected.expected.detection)],
    ["sqlite-classification", () => assert.deepEqual(sqlite, selected.expected.sqlite)],
    ["no-persisted-warning", () => assert.equal(observed.persistedModelWarning, false)],
    ["no-sqlite-warning", () => assert.equal(observed.sqliteTableWarning, false)],
    ["no-compatibility-gate", () => assert.equal(observed.compatibilityGate, false)],
    ["no-human-verdict", () => assert.equal(observed.humanVerdict, false)],
    ["pass-verdict", () => assert.equal(observed.passVerdict, true)],
    ["no-fix-action", () => assert.doesNotMatch(rendered, /clawsweeper-action:fix-required/)],
  ]) {
    try { check(); } catch (error) { failures.push({ boundary, name: error.name, message: error.message }); }
  }
  const compiledPaths = ["clawsweeper-change-detection", "clawsweeper-context-hydration", "clawsweeper-item-policy", "clawsweeper-text", "clawsweeper"];
  const result = {
    name: selected.name, ordinal, mode: selected.mode, expected: selected.expected,
    detection, sqlite, markers: observed, rendered, failures, passed: failures.length === 0,
    pullFiles,
    provenance: {
      sourceHead: binding.mainSha, fixture: fixtureBinding,
      candidateBindingSHA256: sha256(candidateBindingBytes),
      sourceDiffSHA256: candidate.sourceDiffSHA256,
      inputSHA256: sha256(JSON.stringify(pullFiles)),
      patchInventory: pullFiles.map((file) => ({ filename: file.filename, length: file.patch.length, sha256: sha256(file.patch) })),
      compiledHashes: Object.fromEntries(compiledPaths.map((name) => [`dist/${name}.js`, sha256(read(`dist/${name}.js`))])),
      sourceHashes: Object.fromEntries(candidate.sourceOwners.map((owner) => [owner.path, owner.sha256])),
      environment: { provider: "local-node", node: process.version, platform: process.platform, arch: process.arch },
      limits: "Offline compiled detector-to-render observation with synthetic report readiness. Compaction uses production compactPullFile. No model, GitHub publication, migration or OpenClaw/Codex runtime execution; outer runner owns complete source/build/host provenance.",
    },
  };
  writeFileSync(outputArg, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  // Preserve setup classification without exposing host paths or an import stack.
  console.error(error instanceof Error ? error.name : "Unknown setup error");
  process.exitCode = 2;
});
