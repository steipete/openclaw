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
  execFileSync("git", args, { cwd: target, encoding: "utf8" });

export function auditSource(target, lane, packet, packetHash, phase) {
  assert(["baseline", "candidate"].includes(phase));
  assert.equal(hash(read(path.join(lane, "PACKET.json"))), packetHash);
  for (const [file, expected] of Object.entries(packet.files)) {
    assert(fs.lstatSync(path.join(lane, file)).isFile(), file);
    assert.equal(hash(read(path.join(lane, file))), expected, file);
  }
  assert.equal(git(target, "rev-parse", "HEAD").trim(), packet.source);
  assert.equal(git(target, "rev-parse", "HEAD^{tree}").trim(), packet.tree);
  assert.equal(git(target, "diff", "--name-only").trim(), "", "Index and disk differ");
  assert.equal(git(target, "ls-files", "--others", "--exclude-standard").trim(), "");
  const overlay = phase === "candidate" ? packet.candidateHashes : {};
  const changes = git(target, "diff", "--cached", "--name-only")
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(changes, Object.keys(overlay).sort());
  const observed = {};
  const indexedModes = Object.fromEntries(
    git(target, "ls-files", "--stage", "-z", "--", ...Object.keys(packet.sourceHashes))
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const [header, file] = row.split("\t");
        const [mode, , stage] = header.split(" ");
        assert.equal(stage, "0", file);
        return [file, mode];
      }),
  );
  assert.deepEqual(indexedModes, packet.sourceModes);
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

// Same literal-link inventory contract as accepted 140907; never traverse dependency links.
function isPluginDependencyLink(file) {
  const parts = file.split(path.sep);
  if (
    parts[0] !== "dist" ||
    parts[1] !== "extensions" ||
    parts[2] === "node_modules" ||
    parts[3] !== "node_modules"
  )
    return false;
  const name = parts[4];
  if (!name) return false;
  if (parts.length === 6) return name.startsWith("@") && Boolean(parts[5]);
  return (
    parts.length === 5 && (name === ".bin" || (!name.startsWith(".") && !name.startsWith("@")))
  );
}

export function inventoryBuild(target, output) {
  const rows = [];
  const receipt = { complete: false, rows };
  function visit(dir) {
    for (const entry of fs
      .readdirSync(path.join(target, dir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) rows.push([file, "file", hash(read(path.join(target, file)))]);
      else if (entry.isSymbolicLink()) {
        assert(isPluginDependencyLink(file), `Unexpected build link location: ${file}`);
        const literal = fs.readlinkSync(path.join(target, file), { encoding: "buffer" });
        rows.push([file, "symlink", literal.toString("base64")]);
        assert(literal.length > 0 && !path.isAbsolute(literal.toString("utf8")), file);
      } else throw new Error(`Unexpected build entry: ${file}`);
    }
  }
  try {
    assert(
      fs.lstatSync(path.join(target, "dist")).isDirectory(),
      "Expected a real built dist directory",
    );
    visit("dist");
    assert(rows.some(([file, type]) => file === "dist/entry.js" && type === "file"));
    assert(
      rows.some(([file, type]) => file === "dist/cli-startup-metadata.json" && type === "file"),
    );
    receipt.hash = hash(JSON.stringify(rows));
    receipt.files = rows.filter((row) => row[1] === "file").length;
    receipt.links = rows.filter((row) => row[1] === "symlink").length;
    receipt.complete = true;
    return receipt;
  } catch (error) {
    receipt.error = String(error.message);
    throw error;
  } finally {
    writeJson(output, receipt);
  }
}
