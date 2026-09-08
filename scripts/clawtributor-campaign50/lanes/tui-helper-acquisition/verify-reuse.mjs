import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readReport } from "./read-report.mjs";

export function verifyPlannerReuse(lane, packet) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const root = path.join(lane, "reuse");
  const read = (file) => fs.readFileSync(path.join(root, file));
  const json = (file) => JSON.parse(read(file));
  const lineage = JSON.parse(fs.readFileSync(path.join(lane, "REUSE.json"), "utf8"));
  for (const [file, expected] of Object.entries(lineage.files)) {
    assert(fs.lstatSync(path.join(root, file)).isFile(), file);
    assert.equal(hash(read(file)), expected, file);
  }
  assert.equal(lineage.run, 34224353831);
  assert.equal(lineage.job, 102054765998);
  assert.equal(lineage.harness, "6f835f4ddf129897ff7cfe9a66362e4c6bc1331d");
  assert.equal(lineage.originalConclusion, "failure");
  assert.equal(hash(read("reconciliation.json")), lineage.reconciliationHash);
  const reconciliation = json("reconciliation.json");
  assert.equal(reconciliation.plannerComponentQualified, true);
  assert.equal(reconciliation.originalRun, lineage.run);
  assert.equal(reconciliation.originalJob, lineage.job);
  assert.equal(reconciliation.originalJobConclusion, "failure");
  assert.equal(reconciliation.acquisitionExecuted, false);
  assert.equal(reconciliation.source, packet.source);
  assert.equal(reconciliation.admittedAtOrBelow80, true);
  assert.equal(reconciliation.exactPlannedJobsAfter, null);
  assert.equal(reconciliation.commandExit, 0);
  assert.equal(reconciliation.joined, true);
  assert.equal(reconciliation.ownedStateRemoved, true);
  assert.equal(reconciliation.sourceRestored, true);
  assert.equal(reconciliation.remainingAcquisitionCases, 10);
  const proposal = json("reconciliation-proposal.json");
  assert.equal(hash(read("reconciliation-proposal.json")), reconciliation.proposalSha256);
  assert.deepEqual(reconciliation.inputHashes, proposal.inputHashes);
  for (const [file, expected] of Object.entries(reconciliation.inputHashes))
    assert.equal(hash(read(file)), expected, file);
  assert.equal(hash(read("run.json")), proposal.runMetadataSha256);
  const run = json("run.json");
  assert.equal(run.databaseId, lineage.run);
  assert.equal(run.headSha, lineage.harness);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "failure");
  const jobs = run.jobs.filter((job) => job.databaseId === lineage.job);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].conclusion, "failure");
  const previous = json("executed/PACKET.json.txt");
  assert.equal(
    hash(read("executed/PACKET.json.txt")),
    "45776f127b4093270295aaca613e03f5c7fb9146e40bc32993b9ee808d4d12d7",
  );
  assert.equal(reconciliation.packetHash, hash(read("executed/PACKET.json.txt")));
  for (const key of [
    "source",
    "tree",
    "node",
    "pnpm",
    "packageManager",
    "acquisition",
    "removed",
    "acquisitionAfter",
  ])
    assert.equal(previous[key], packet[key], key);
  assert.deepEqual(previous.parents, packet.parents);
  assert.deepEqual(previous.sourceHashes, packet.sourceHashes);
  const source = json("source.json");
  assert.equal(source.source, packet.source);
  assert.equal(source.node, packet.node);
  assert.equal(source.packageManager, packet.packageManager);
  assert.equal(source.lane, previous.lane);
  assert.equal(source.mode, "green");
  const host = json("host.json");
  assert.equal(host.node, `v${packet.node}`);
  assert.equal(host.platform, "linux");
  assert.equal(host.packageManager, packet.packageManager);
  for (const [file, expected] of Object.entries(previous.files))
    assert.equal(hash(read(`executed/${file}.txt`)), expected, file);
  assert.equal(hash(read("executed/candidate.patch.txt")), packet.files["candidate.patch"]);
  assert.equal(hash(read("executed/tracked-tests.json.txt")), packet.files["tracked-tests.json"]);
  const oldContracts = json("executed/cases.json.txt");
  assert.deepEqual(
    oldContracts.map((contract) => contract.id),
    ["planner", "acquisition"],
  );
  assert.deepEqual(reconciliation.plannerNames, oldContracts[0].names);
  assert.equal(reconciliation.passed, 3);
  assert.equal(reconciliation.filtered, 50);
  const currentContracts = JSON.parse(fs.readFileSync(path.join(lane, "cases.json"), "utf8"));
  assert.deepEqual(currentContracts, [oldContracts[1]]);
  const oldReader = read("executed/read-report.mjs.txt").toString("utf8");
  const marker =
    "  assert.equal([...log.matchAll(/^\\[test\\] passed 1 Vitest shard in .+$/gm)].length, 1);\n";
  assert.equal(oldReader.split(marker).length, 2);
  assert.equal(
    fs.readFileSync(path.join(lane, "read-report.mjs"), "utf8"),
    oldReader.replace(marker, ""),
  );

  const inventory = json("executed/tracked-tests.json.txt");
  const candidateInventory = inventory.filter((file) => file !== packet.removed);
  const candidateHashes = { ...packet.sourceHashes, [packet.acquisition]: packet.acquisitionAfter };
  delete candidateHashes[packet.removed];
  for (const [file, patched] of [
    ["source-before.json", false],
    ["source-candidate-indexed.json", true],
    ["source-before-restoration.json", true],
    ["source-final.json", false],
  ]) {
    const receipt = json(file);
    assert.equal(receipt.source, packet.source);
    assert.equal(receipt.tree, packet.tree);
    assert.equal(receipt.patched, patched);
    assert.deepEqual(
      receipt.changes,
      patched ? [`M\t${packet.acquisition}`, `D\t${packet.removed}`] : [],
    );
    assert.deepEqual(receipt.sourceHashes, patched ? candidateHashes : packet.sourceHashes);
    assert.equal(Object.keys(receipt.sourceHashes).length, patched ? 36 : 37);
    assert.equal(receipt.indexedTestCount, patched ? 13820 : 13821);
    assert.equal(
      receipt.indexedTestInventoryHash,
      hash(JSON.stringify(patched ? candidateInventory : inventory)),
    );
    assert.equal(receipt.removedPresent, !patched);
  }
  assert.equal(read("bootstrap-final-working-tree.patch").length, 0);
  assert.equal(read("exit-code.txt").toString("utf8").trim(), "1");
  const original = json("result.json");
  assert.equal(original.completed, false);
  assert.equal(original.sourceRestored, true);
  assert.equal(original.source, packet.source);
  assert.equal(original.packetHash, hash(read("executed/PACKET.json.txt")));
  assert.deepEqual(original.phases, {});
  assert.deepEqual(original.failure, {
    message: "Expected values to be strictly equal:\n\n0 !== 1\n",
    code: "ERR_ASSERTION",
  });
  const commands = json("commands.json");
  assert.deepEqual(commands, original.commands);
  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.equal(command.id, "planner");
  assert.equal(command.exit, 0);
  assert.equal(command.joined, true);
  assert.equal(command.ownedStateRemoved, true);
  for (const key of ["unjoinedWork", "outputLimitExceeded", "captureFailed", "stateCleanupFailed"])
    assert.equal(command[key] ?? false, false, key);
  assert(Number.isSafeInteger(command.pid) && command.pid > 0);
  const started = Date.parse(command.startedAt);
  const finished = Date.parse(command.finishedAt);
  assert(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
  assert.equal(command.timeoutMs, 600000);
  assert(finished - started < command.timeoutMs);
  assert.equal(command.outputBytes, read("planner/vitest.log").length);
  assert.equal(command.outputSha256, hash(read("planner/vitest.log")));
  const originalEvidence =
    "/home/runner/work/openclaw/openclaw/evidence/tui-helper-inventory/planner/vitest.json";
  assert.deepEqual(command.args, [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "test/vitest/vitest.tooling.config.ts",
    oldContracts[0].file,
    "--reporter=verbose",
    "--reporter=json",
    `--outputFile=${originalEvidence}`,
    "--testNamePattern",
    oldContracts[0].pattern,
  ]);
  const report = readReport(
    path.join(root, "planner/vitest.json"),
    path.join(root, "planner/vitest.log"),
    `/home/runner/work/openclaw/openclaw/target/${oldContracts[0].file}`,
    oldContracts[0].names,
    true,
  );
  assert.equal(report.passed, 3);
  assert.equal(report.skipped, 50);
  return {
    run: lineage.run,
    job: lineage.job,
    harness: lineage.harness,
    originalConclusion: "failure",
    source: packet.source,
    tree: packet.tree,
    reconciliationHash: lineage.reconciliationHash,
    report,
    indexedTestInventory: [13821, 13820, 13821],
    sourcePins: [37, 36, 37],
    nativeCommandExit: 0,
    joined: true,
    ownedStateRemoved: true,
    scope:
      "Historical native planner evidence revalidated as data; no planner execution in this continuation",
  };
}
