import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [lane, evidence] = process.argv.slice(2);
assert.equal(process.version, "v24.20.0");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const lineage = JSON.parse(fs.readFileSync(path.join(lane, "REUSE.json"), "utf8"));
const reuse = path.join(lane, "reuse");
for (const [file, expected] of Object.entries(lineage.files))
  assert.equal(hash(fs.readFileSync(path.join(reuse, file))), expected, file);
const read = (file) => JSON.parse(fs.readFileSync(path.join(reuse, file), "utf8"));
const oldPacket = read("packet.json");
assert.equal(hash(fs.readFileSync(path.join(reuse, "packet.json"))), lineage.packetSha256);
assert.equal(oldPacket.source, packet.source);
assert.equal(oldPacket.candidatePatch, packet.candidatePatch);
assert.deepEqual(oldPacket.candidateHashes, packet.candidateHashes);
assert.deepEqual(oldPacket.sourceHashes, packet.sourceHashes);
for (const [file, expected] of Object.entries(oldPacket.files))
  assert.equal(lineage.files[`executed-lane/${file}.txt`], expected, file);
assert.equal(hash(fs.readFileSync(path.join(reuse, "candidate.patch"))), packet.candidatePatch);
for (const [file, expected] of Object.entries(packet.candidateHashes))
  assert.equal(
    hash(fs.readFileSync(path.join(reuse, "candidate-source", `${file}.txt`))),
    expected,
    file,
  );
for (const [file, phase] of [
  ["source-clean.json", "clean"],
  ["source-unit-baseline.json", "baseline"],
  ["source-after-unit-baseline.json", "baseline"],
  ["source-candidate.json", "candidate"],
  ["source-final.json", "candidate"],
]) {
  const snapshot = read(file);
  assert.equal(snapshot.source, packet.source);
  assert.equal(snapshot.phase, phase);
  assert.equal(snapshot.inventoryComplete, true);
  assert.equal(snapshot.inventoryFailure, undefined);
  assert.deepEqual(snapshot.sourceHashes, {
    ...packet.sourceHashes,
    ...(phase === "baseline"
      ? packet.testHashes
      : phase === "candidate"
        ? packet.candidateHashes
        : {}),
  });
}
assert.equal(fs.readFileSync(path.join(reuse, "source-final.exit"), "utf8").trim(), "0");
assert.equal(fs.readFileSync(path.join(reuse, "source-final.stderr"), "utf8"), "");
const verdicts = [];
for (const request of lineage.reports) {
  const stem = path.join(reuse, "tests", request.stem);
  const code = fs.readFileSync(`${stem}.exit`, "utf8").trim();
  const log = fs.readFileSync(`${stem}.log`, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal([...log.matchAll(/^\[test\] (?:passed|failed) 1 Vitest shard in .+$/gm)].length, 1);
  assert.match(
    log,
    new RegExp(
      `^\\[test\\] ${request.phase === "baseline" ? "failed" : "passed"} 1 Vitest shard in .+$`,
      "m",
    ),
  );
  assert.doesNotMatch(
    log,
    /retained temporary namespace|native report set:|retry(?:ing)?|process group.*(?:failed|unverified)/i,
  );
  const output = execFileSync(
    process.execPath,
    [
      path.join(lane, "verify-tests.mjs"),
      request.phase,
      request.owner,
      `${stem}.json`,
      `${stem}.log`,
      code,
      request.file,
    ],
    { encoding: "utf8" },
  );
  verdicts.push({ stem: request.stem, ...JSON.parse(output) });
}
assert.equal(verdicts.length, 7);
assert.equal(
  verdicts.filter((row) => row.phase === "baseline").reduce((sum, row) => sum + row.failed, 0),
  4,
);
assert.equal(
  verdicts.filter((row) => row.phase === "baseline").reduce((sum, row) => sum + row.passed, 0),
  12,
);
assert.deepEqual(
  verdicts.filter((row) => row.phase === "candidate").map((row) => row.passed),
  [20, 48, 68, 91, 30],
);
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(
  path.join(evidence, "reused-units.json"),
  `${JSON.stringify({ run: lineage.run, job: lineage.job, harness: lineage.harness, source: packet.source, candidate: packet.candidatePatch, candidatePassed: 257, baselineIntendedFailures: 4, baselineControls: 12, verdicts, scope: "Immutable native JSON/log/exit revalidation; no target test execution" }, null, 2)}\n`,
);
console.log(
  "Accepted immutable unit evidence: 4 intended failures, 12 controls, 257 candidate passes.",
);
