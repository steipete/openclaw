import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export function readPlanContract(lane) {
  const json = (name) => JSON.parse(readFileSync(path.join(lane, name), "utf8"));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const contract = json("plan-contract.json");
  const manifest = json("MANIFEST.json");
  const original = json("reuse-71/original-manifest.json");
  assert.equal(
    hash(readFileSync(path.join(lane, "reuse-71/original-manifest.json"))),
    "f21a218dd379ecd39cda9e1f33ddb4ac0d1d179a647d561f7c07127ecb5d593e",
  );
  assert.equal(contract.source, manifest.source);
  assert.deepEqual(original.candidateHashes, manifest.candidateHashes);
  assert.deepEqual(original.sourceHashes, manifest.sourceHashes);
  const run = json("reuse-71/run.json");
  assert.equal(run.databaseId, contract.capturedRun);
  assert.equal(run.databaseId, 34195063822);
  assert.equal(run.headSha, contract.harness);
  assert.equal(run.headSha, "4a1357e20aaa5319d3a9ac2d744e1f25abdcd376");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "failure");
  assert.equal(run.attempt, 1);
  const jobs = run.jobs.filter((job) => job.databaseId === contract.capturedJob);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].databaseId, 101960912089);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].conclusion, "failure");
  const artifacts = json("reuse-71/artifacts.json").artifacts.filter(
    (entry) => entry.id === contract.artifact.id,
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, contract.artifact.name);
  assert.equal(artifacts[0].digest, contract.artifact.apiDigest);
  assert.equal(artifacts[0].expired, false);
  const downloads = json("reuse-71/downloads.json").filter(
    (entry) => entry.artifactId === contract.artifact.id,
  );
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].apiZipDigest, contract.artifact.apiDigest);
  assert.equal(downloads[0].downloadedOnce, true);
  const source = json("reuse-71/source.json");
  assert.equal(source.source, manifest.source);
  assert.equal(source.node, manifest.node);
  assert.equal(source.packageManager, manifest.packageManager);
  assert.equal(
    readFileSync(path.join(lane, "reuse-71/phase.txt"), "utf8").trim(),
    "remaining-static",
  );
  assert.equal(readFileSync(path.join(lane, "reuse-71/exit-code.txt"), "utf8").trim(), "1");
  for (const phase of ["before", "candidate"]) {
    const record = json(`reuse-71/hashes-${phase}.json`);
    assert.equal(record.source, manifest.source);
    assert.equal(
      record.manifestSha256,
      hash(readFileSync(path.join(lane, "reuse-71/original-manifest.json"))),
    );
    assert.deepEqual(
      record.sourceHashes,
      phase === "before"
        ? original.sourceHashes
        : { ...original.sourceHashes, ...original.candidateHashes },
    );
    assert.deepEqual(record.packetHashes, original.files);
    assert.deepEqual(record.staticOwnerHashes, original.staticOwnerHashes);
    if (phase === "candidate") {
      assert.deepEqual(
        record.copiedHashes,
        Object.fromEntries(
          Object.entries(original.copies).map(([name, dest]) => [dest, original.files[name]]),
        ),
      );
      assert.equal(
        record.generatedSha256,
        hash(readFileSync(path.join(lane, "reuse-69/generated-schema.json"))),
      );
    }
  }
  const normalize = (text) =>
    text
      .split("\n")
      .filter((line) => !line.startsWith("index "))
      .join("\n");
  assert.equal(
    normalize(readFileSync(path.join(lane, "reuse-71/final-working-tree.patch"), "utf8")),
    normalize(
      readFileSync(path.join(lane, "regression.patch"), "utf8") +
        readFileSync(path.join(lane, "production.patch"), "utf8"),
    ),
  );
  const raw = readFileSync(path.join(lane, contract.logCarrier));
  assert.equal(hash(raw), contract.logSha256);
  const body = raw.toString().split("  actual: [")[1]?.split("  ],\n  expected:")[0];
  assert.ok(body);
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  assert.ok(lines.every((line) => /^\s+'[^']+',?$/.test(line)));
  const captured = lines.map((line) => /^\s+'([^']+)',?$/.exec(line)[1]);
  assert.deepEqual(captured, contract.commandNames);
  assert.equal(new Set(captured).size, captured.length);
  assert.deepEqual(
    contract.commandNames.slice(0, contract.retainedPrefix.length),
    contract.retainedPrefix,
  );
  assert.deepEqual(
    contract.commandNames.slice(contract.retainedPrefix.length),
    contract.remainingCommands.map((command) => command.name),
  );
  return contract;
}

export function selectRemainingCommands(commands, contract, retainedPrefix, scripts) {
  assert.deepEqual(retainedPrefix, contract.retainedPrefix);
  assert.deepEqual(
    commands.map((command) => command.name),
    contract.commandNames,
  );
  const remaining = commands.slice(retainedPrefix.length);
  assert.deepEqual(
    remaining.map(({ name, bin, args }) => ({ name, bin: bin ?? null, args })),
    contract.remainingCommands,
  );
  for (const [alias, value] of Object.entries(contract.packageAliases))
    assert.equal(scripts[alias], value);
  assert.ok(remaining.length > 0);
  return remaining;
}
