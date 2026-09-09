import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acceptBaseline, checkCli, checkSnapshot } from "./read-output.mjs";
import { hash, read, writeJson } from "./source-audit.mjs";

export function validateArtifact(evidence, lane) {
  const load = (file) => JSON.parse(read(path.join(evidence, file)));
  const packetBytes = read(path.join(lane, "PACKET.json"));
  const packet = JSON.parse(packetBytes);
  const cases = JSON.parse(read(path.join(lane, "cases.json")));
  const result = load("result.json");
  assert.equal(result.completed, true);
  assert.equal(result.proofAccepted, true);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.ownedStateRemoved, true);
  assert.equal(result.cleanupUnverified ?? false, false);
  assert.equal(result.error, undefined);
  assert.equal(result.finalizationError, undefined);
  assert.equal(result.retainedOwnedState, undefined);
  assert.equal(result.source, packet.source);
  assert.equal(result.packetHash, hash(packetBytes));
  assert.equal(
    read(path.join(evidence, "verdict.txt")).toString(),
    "EXPECTED_ARCHIVE_PROJECTION_DEFECT_CONFIRMED\n",
  );
  assert.equal(hash(read(path.join(evidence, "inputs/PACKET.json"))), hash(packetBytes));
  for (const [file, expected] of Object.entries(packet.files)) {
    assert.equal(hash(read(path.join(lane, file))), expected);
    assert.equal(hash(read(path.join(evidence, "inputs", file))), expected);
  }
  assert.deepEqual(load("commands.json"), result.commands);
  const ids = [
    "build",
    "seed",
    "single-agent",
    "inspect-single-agent",
    "all-agents",
    "inspect-all-agents",
  ];
  assert.deepEqual(
    result.commands.map((row) => row.id),
    ids,
  );
  for (const row of result.commands) {
    assert.equal(row.exit, 0);
    assert.equal(row.childExitCode, 0);
    assert.equal(row.childExitSignal, null);
    assert.equal(row.joined, true);
    assert.equal(row.stdoutEnded, true);
    assert.equal(row.stderrEnded, true);
    assert.equal(row.authoredPreserved, true);
    assert.equal(row.unjoinedWork ?? false, false);
    assert.equal(row.outputLimitExceeded ?? false, false);
    assert.equal(row.captureOrPreservationFailed ?? false, false);
    assert.equal(row.executionError, undefined);
    assert(Number.isSafeInteger(row.pid) && row.pid > 1);
    assert(
      Number.isFinite(row.startedMs) &&
        Number.isFinite(row.finishedMs) &&
        row.finishedMs >= row.startedMs,
    );
    assert.deepEqual(row.authoredBefore, row.authoredAfter);
    assert.deepEqual(
      Object.keys(row.authoredBefore).sort(),
      ["home/input-marker.txt", "state/openclaw.json", "workspaces/alpha/input-marker.txt"].sort(),
    );
    assert.equal(
      row.authoredBefore["home/input-marker.txt"],
      hash("Synthetic #124540 home input\n"),
    );
    assert.equal(
      row.authoredBefore["workspaces/alpha/input-marker.txt"],
      hash("Synthetic #124540 workspace input\n"),
    );
    let count = 0;
    for (const stream of ["stdout", "stderr"]) {
      const bytes = read(path.join(evidence, row.id, stream));
      count += bytes.length;
      assert.equal(hash(bytes), row[stream + "Sha256"]);
    }
    assert.equal(count, row.outputBytes);
    assert(count <= row.limit);
    const receipt = load("source-after-" + row.id + ".json");
    assert.equal(receipt.source, packet.source);
    assert.equal(receipt.tree, packet.tree);
    assert.equal(receipt.phase, "baseline");
    assert.deepEqual(receipt.changes, []);
    assert.deepEqual(receipt.sourceHashes, packet.sourceHashes);
  }
  for (const name of ["source-before.json", "source-final.json"]) {
    const receipt = load(name);
    assert.equal(receipt.source, packet.source);
    assert.equal(receipt.tree, packet.tree);
    assert.deepEqual(receipt.changes, []);
    assert.deepEqual(receipt.sourceHashes, packet.sourceHashes);
  }
  const initial = load("seed.snapshot.json");
  assert.equal(initial.mode, "seed");
  const ownerFacts = checkSnapshot(initial, cases);
  assert.deepEqual(ownerFacts, result.ownerFacts);
  const stores = load("stores-before.json");
  assert.equal(stores.length, cases.agents.length * 4);
  assert.deepEqual(
    stores.map((file) => file.file),
    initial.targets.flatMap((target) =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => target.sqlitePath + suffix),
    ),
  );
  for (const target of initial.targets)
    assert.equal(stores.find((file) => file.file === target.sqlitePath).present, true);
  for (const file of stores) {
    assert.equal(typeof file.present, "boolean");
    if (file.present) assert(/^[a-f0-9]{64}$/.test(file.sha256));
  }
  const fixture = load("fixture.json");
  const config = load("config.json");
  assert.equal(hash(JSON.stringify(config, null, 2) + "\n"), fixture.configSha256);
  assert.deepEqual(Object.keys(config.agents.entries), cases.agents);
  assert.equal(config.plugins.enabled, false);
  const facts = [...ownerFacts];
  for (const test of cases.commands) {
    const row = result.commands.find((row) => row.id === test.id);
    assert.deepEqual(row.args.slice(1), test.argv);
    assert.equal(row.authoredBefore["state/openclaw.json"], fixture.configSha256);
    const actual = checkCli(
      test,
      read(path.join(evidence, test.id, "stdout")).toString(),
      read(path.join(evidence, test.id, "stderr")).toString(),
      cases,
      initial,
      row.startedMs,
      row.finishedMs,
    );
    assert.deepEqual(actual, load(test.id + ".accepted.json"));
    assert.deepEqual(
      { id: test.id, ...actual },
      result.cli.find((entry) => entry.id === test.id),
    );
    facts.push(...actual.facts);
    const inspected = load("inspect-" + test.id + ".snapshot.json");
    assert.equal(inspected.mode, "inspect");
    checkSnapshot(inspected, cases, initial);
    assert.deepEqual(load(test.id + ".stores.json"), stores);
    assert.deepEqual(load("inspect-" + test.id + ".stores.json"), stores);
  }
  const baseline = acceptBaseline(facts);
  assert.equal(baseline.intendedViolations, 8);
  assert.deepEqual(baseline, result.baseline);
  const build = load("build-inventory.json");
  for (const name of [
    "build-inventory.json",
    "single-agent.build-inventory.json",
    "all-agents.build-inventory.json",
    "final-build-inventory.json",
  ]) {
    const value = load(name);
    assert.equal(value.complete, true);
    assert.equal(hash(JSON.stringify(value.rows)), value.hash);
    assert.equal(value.hash, build.hash);
  }
  return {
    source: packet.source,
    packetHash: result.packetHash,
    expectedDefectConfirmed: true,
    ownerRows: 3,
    actualCliRows: 5,
    naturalJoinedCommands: 6,
    inputAndStorePreservation: true,
    candidateOrLifecycleExecuted: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [evidence, lane] = process.argv.slice(2);
  const value = validateArtifact(evidence, lane);
  writeJson(path.join(evidence, "INDEPENDENT-READER.json"), value);
  console.log("Read-only inventory baseline accepted");
}
