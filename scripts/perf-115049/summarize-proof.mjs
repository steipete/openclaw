// Summarizes observed work and separately measured uninstrumented costs without asserting a speedup.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.argv[2]);
const read = async (name) => JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
const baseline = await read("baseline-uninstrumented.json");
const candidate = await read("candidate-uninstrumented.json");
const before = await read("baseline-observed.json");
const after = await read("candidate-observed.json");
const units = await read("unit-proof.json");
for (const value of [baseline, candidate, before, after]) {
  assert.equal(value.complete, true);
  assert.equal(value.cleanupJoined, true);
  assert.equal(value.seedFingerprint, baseline.seedFingerprint);
  assert.equal(value.lcmVersion, "1.0.0");
  assert.equal(value.lcmSource, "988dee85592b9066ffe1c859542e8e18c23f2345");
  assert.equal(value.codexVersion, "0.153.4");
  assert.equal(value.node, baseline.node);
  assert.equal(value.finalTranscriptMessages, baseline.finalTranscriptMessages);
  assert.deepEqual(
    value.requestContext,
    baseline.requestContext,
    "paired synthetic request-context projection differs",
  );
}
assert.equal(before.sourceCommit, baseline.sourceCommit);
assert.equal(after.sourceCommit, candidate.sourceCommit);
assert.equal(baseline.sourceCommit, "5f661669b2c2979f2a61e23d4addb3bdd4545469");
assert.equal(before.measuredFullReads / before.measuredTurns, 2);
assert.equal(after.measuredFullReads / after.measuredTurns, 1);
assert.equal(units.baselineFailedStableReadAssertions, 2);
assert.equal(units.candidateOwnerAndSiblingTestsPassed, true);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const value of [baseline, candidate]) {
  assert.equal(value.mode, "uninstrumented");
  assert.equal(value.samples.length, 3);
}
const summary = {
  baseline: baseline.sourceCommit,
  candidate: candidate.sourceCommit,
  node: baseline.node,
  lcmVersion: "1.0.0",
  codexVersion: "0.153.4",
  seedMessages: baseline.seedMessages,
  fullReadsPerTurn: { baseline: 2, candidate: 1 },
  uninstrumentedSamples: { baseline: baseline.samples, candidate: candidate.samples },
  medianAgentWaitMs: {
    baseline: median(baseline.samples.map((sample) => sample.agentWaitMs)),
    candidate: median(candidate.samples.map((sample) => sample.agentWaitMs)),
  },
  medianProcessTreeRssBytes: {
    baseline: median(baseline.samples.map((sample) => sample.processTreeRssBytes)),
    candidate: median(candidate.samples.map((sample) => sample.processTreeRssBytes)),
  },
  pairedSyntheticRequestContext: baseline.requestContext,
  semanticContextAndTranscriptChecks: true,
  cleanupJoined: true,
  limitations:
    "One runner, three warm-turn samples per variant. Timing includes real Gateway/Codex/LCM flow against a scripted provider and debug logging. Read counters came from separate runs. No SQL microtiming, direct maintenance-return, peak-memory, full-prompt-byte-identity or statistical speedup claim.",
};
await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
