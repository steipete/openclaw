// Exact JSON collection/case proof; the sole baseline overlay is always restored.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runPhase } from "./phase-runner.mjs";
import { blobId, verifySource, verifyBuilt, runtimeManifest } from "./proof-integrity.mjs";
import { createSnapshotProofEnvironment } from "./secretless-env.parts.mjs";
import { writeUnitDiagnostic } from "./unit-diagnostic.mjs";
assert.equal(process.env.CI, "true");
const [baseline, candidate, publishRoot, scratch] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
const ownerTest = "extensions/codex/src/app-server/run-attempt.context-engine.test.ts";
const files = [
  ownerTest,
  "src/agents/sessions/session-manager-model-context.test.ts",
  "extensions/codex/src/app-server/session-history.test.ts",
  "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
];
const bindings = {};
for (const [variant, repo] of [
  ["baseline", baseline],
  ["candidate", candidate],
]) {
  bindings[variant] = JSON.parse(
    await fs.readFile(path.join(scratch, `${variant}-built.json`), "utf8"),
  );
  await verifyBuilt(repo, variant, bindings[variant]);
}
async function run(repo, label, args, sourceOverlays = {}) {
  const root = await fs.mkdtemp(path.join(scratch, `${label}-`));
  let unjoined = false;
  try {
    const env = await createSnapshotProofEnvironment(root);
    env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH = path.join(root, "vitest-cache");
    return await runPhase({
      baseline,
      label,
      bin: process.execPath,
      args: ["scripts/run-vitest.mjs", ...args],
      cwd: repo,
      env,
      timeoutMs: 300_000,
      publishRoot,
      sourceOverlays,
      ...(label === "candidate-owners"
        ? { privateOutputFile: path.join(scratch, "candidate-runner.log") }
        : {}),
    });
  } catch (error) {
    unjoined = error?.unjoined === true;
    throw error;
  } finally {
    if (!unjoined) {
      await fs.rm(root, { recursive: true });
    }
  }
}
const original = await fs.readFile(path.join(baseline, ownerTest));
const improved = await fs.readFile(path.join(candidate, ownerTest));
const baselineReport = path.join(scratch, "baseline-regression.json");
let baselineUnjoined = false;
try {
  await fs.writeFile(path.join(baseline, ownerTest), improved);
  const overlays = { [ownerTest]: blobId(improved) };
  await verifySource(baseline, "baseline", overlays);
  assert.equal(
    await run(
      baseline,
      "baseline-regression",
      [
        ownerTest,
        "--testNamePattern=assembles current SQLite history after stable bootstrap",
        "--reporter=json",
        `--outputFile=${baselineReport}`,
      ],
      overlays,
    ),
    1,
  );
  await verifySource(baseline, "baseline", overlays);
  assert.deepEqual(await runtimeManifest(baseline), bindings.baseline.runtime);
  const report = JSON.parse(await fs.readFile(baselineReport, "utf8"));
  assert.equal(report.numFailedTests, 2);
  assert.equal(report.testResults.length, 1);
  assert.equal(path.relative(baseline, report.testResults[0].name), ownerTest);
  const failed = report.testResults[0].assertionResults.filter((test) => test.status === "failed");
  assert.equal(failed.length, 2);
  for (const admitted of [false, true]) {
    const title = `assembles current SQLite history after stable bootstrap (admitted=${admitted})`;
    const test = failed.find((value) => value.title === title);
    assert.ok(test);
    assert.match(
      stripVTControlCharacters(test.failureMessages.join("\n")),
      /called 1 times[\s\S]*got 2 times/u,
    );
  }
} catch (error) {
  baselineUnjoined = error?.unjoined === true;
  throw error;
} finally {
  if (!baselineUnjoined) {
    await fs.writeFile(path.join(baseline, ownerTest), original);
    await verifyBuilt(baseline, "baseline", bindings.baseline);
  }
}
const candidateReport = path.join(scratch, "candidate-owners.json");
const inventory = JSON.parse(
  await fs.readFile(new URL("./unit-case-inventory.json", import.meta.url), "utf8"),
);
let code;
let commandError;
let candidateUnjoined = false;
let sourceRuntimeVerified = false;
let report;
try {
  code = await run(candidate, "candidate-owners", [
    ...files,
    "--includeTaskLocation",
    "--reporter=json",
    `--outputFile=${candidateReport}`,
  ]);
} catch (error) {
  commandError = error;
  candidateUnjoined = error?.unjoined === true;
} finally {
  // A nonzero test result still needs custody evidence; unsettled workers retain their inputs.
  if (!candidateUnjoined) {
    try {
      for (const [variant, repo] of [
        ["baseline", baseline],
        ["candidate", candidate],
      ]) {
        await verifyBuilt(repo, variant, bindings[variant]);
      }
      sourceRuntimeVerified = true;
    } catch {
      sourceRuntimeVerified = false;
    }
  }
  try {
    report = await writeUnitDiagnostic({
      repo: candidate,
      reportFile: candidateReport,
      outputFile: path.join(publishRoot, "candidate-unit-diagnostic.json"),
      inventory,
      sourceFiles: bindings.candidate.source.files,
      exitCode: code,
      unjoined: candidateUnjoined,
      sourceRuntimeVerified,
    });
  } catch {
    throw Object.assign(new Error("Could not finalize the safe candidate unit diagnostic"), {
      unjoined: candidateUnjoined,
    });
  }
}
if (commandError) {
  throw commandError;
}
assert.equal(
  sourceRuntimeVerified,
  true,
  "source/runtime custody verification failed after candidate tests",
);
assert.equal(code, 0, "candidate owner tests failed; see the safe unit diagnostic");
assert.ok(report, "candidate JSON report is missing or invalid; see the safe unit diagnostic");
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.deepEqual(
  report.testResults.map((suite) => path.relative(candidate, suite.name)).sort(),
  [...files].sort(),
);
const cases = report.testResults.flatMap((suite) => {
  assert.ok(suite.assertionResults.length > 0);
  assert.ok(
    suite.assertionResults.every((test) => test.status === "passed"),
    "focused owners must have no skipped/pending/failing tests",
  );
  return suite.assertionResults.map((test) => test.title);
});
const critical = [
  ...[false, true].map(
    (reset) => `keeps one active suffix after repeated successful rewrites (reset=${reset})`,
  ),
  ...[
    ["stable", false],
    ["stable", true],
    ["append", false],
    ["append", true],
    ["reset", false],
    ["compaction", false],
  ].map(
    ([mutation, admitted]) =>
      `assembles current SQLite history after ${mutation} bootstrap (admitted=${admitted})`,
  ),
  "keeps the first SQLite history when a changed transcript cannot be reread",
  "stops before assembly and native turn start when bootstrap is cancelled",
  ...["whole", "reset", "compaction", "reset-compaction", "leaf", "opaque"].map(
    (scenario) =>
      `acquires detached ${scenario} context without native payloads or changing stored evidence`,
  ),
];
for (const title of critical) {
  assert.equal(cases.filter((actual) => actual === title).length, 1, title);
}
await fs.writeFile(
  path.join(publishRoot, "unit-proof.json"),
  JSON.stringify({
    baselineFailedStableReadAssertions: 2,
    failureContract: "expected one full model read, observed two",
    candidateOwnerAndSiblingTestsPassed: true,
    collectedFiles: files,
    passedTests: cases.length,
    criticalPassed: critical,
    sourceAndRuntimeBytesPreserved: true,
  }) + "\n",
);
