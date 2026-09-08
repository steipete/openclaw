import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const read = (file) => fs.readFileSync(file);
export const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const git = (target, ...args) =>
  execFileSync("git", args, { cwd: target, encoding: "utf8", maxBuffer: 4_000_000 });

export function auditSource(target, lane, packet, packetHash, phase) {
  assert(["baseline", "red", "green"].includes(phase));
  assert.equal(hash(read(path.join(lane, "PACKET.json"))), packetHash);
  for (const [file, expected] of Object.entries(packet.files)) {
    assert(fs.lstatSync(path.join(lane, file)).isFile(), file);
    assert.equal(hash(read(path.join(lane, file))), expected, file);
  }
  assert.equal(git(target, "rev-parse", "HEAD").trim(), packet.source);
  assert.equal(git(target, "rev-parse", "HEAD^{tree}").trim(), packet.tree);
  assert.equal(git(target, "diff", "--name-only").trim(), "", "Index and disk differ");
  assert.equal(git(target, "ls-files", "--others", "--exclude-standard").trim(), "");
  const overlay =
    phase === "baseline"
      ? {}
      : { ...packet.regressionHashes, ...(phase === "green" ? packet.candidateHashes : {}) };
  const changes = git(target, "diff", "--cached", "--name-only")
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(changes, Object.keys(overlay).sort());
  const expectedModes = {
    ...packet.sourceModes,
    ...(phase === "baseline" ? {} : packet.regressionModes),
  };
  const observedModes = Object.fromEntries(
    git(target, "ls-files", "--stage", "-z", "--", ...Object.keys(expectedModes))
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const [header, file] = row.split("\t");
        const [fileMode, , stage] = header.split(" ");
        assert.equal(stage, "0", file);
        return [file, fileMode];
      }),
  );
  assert.deepEqual(observedModes, expectedModes);
  const observed = {};
  for (const [file, expected] of Object.entries({ ...packet.sourceHashes, ...overlay })) {
    assert(fs.lstatSync(path.join(target, file)).isFile(), file);
    observed[file] = hash(read(path.join(target, file)));
    assert.equal(observed[file], expected, file);
    assert.equal(
      hash(execFileSync("git", ["show", `:${file}`], { cwd: target, maxBuffer: 4_000_000 })),
      expected,
      file,
    );
  }
  assert.equal(
    JSON.parse(read(path.join(target, "package.json"))).packageManager,
    packet.packageManager,
  );
  return { source: packet.source, tree: packet.tree, phase, changes, sourceHashes: observed };
}
