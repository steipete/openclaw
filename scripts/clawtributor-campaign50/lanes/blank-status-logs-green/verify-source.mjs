import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [target, lane, phase] = process.argv.slice(2);
assert(["clean", "baseline", "candidate"].includes(phase));
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
assert.equal(process.version, packet.node);
assert.equal(process.platform, "linux");
assert.equal(git("rev-parse", "HEAD"), packet.source);
const overlay =
  phase === "candidate" ? packet.candidateHashes : phase === "baseline" ? packet.testHashes : {};
assert.equal(git("ls-files", "--others", "--exclude-standard"), "");
assert.deepEqual(
  git("diff", "--name-only", "HEAD").split("\n").filter(Boolean).sort(),
  Object.keys(overlay).sort(),
);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).packageManager,
  packet.packageManager,
);
for (const [file, expected] of Object.entries({ ...packet.sourceHashes, ...overlay })) {
  assert.equal(hash(fs.readFileSync(path.join(target, file))), expected, file);
}
for (const [file, expected] of Object.entries(packet.files)) {
  assert.equal(hash(fs.readFileSync(path.join(lane, file))), expected, file);
}
const built = [];
let inventoryComplete = false;
let inventoryFailure;
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
function visit(dir) {
  for (const entry of fs
    .readdirSync(path.join(target, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile())
      built.push([file, "file", hash(fs.readFileSync(path.join(target, file)))]);
    else if (entry.isSymbolicLink()) {
      assert(isPluginDependencyLink(file), `Unexpected build link location: ${file}`);
      const literal = fs.readlinkSync(path.join(target, file), { encoding: "buffer" });
      built.push([file, "symlink", literal.toString("base64")]);
      assert(
        literal.length > 0 && !path.isAbsolute(literal.toString("utf8")),
        `Expected POSIX relative dependency link: ${file}`,
      );
    } else throw new Error(`Unexpected build entry: ${file}`);
  }
}
try {
  if (fs.existsSync(path.join(target, "dist"))) {
    assert(fs.lstatSync(path.join(target, "dist")).isDirectory(), "Expected a real dist directory");
    visit("dist");
  }
  inventoryComplete = true;
} catch (error) {
  inventoryFailure = { message: String(error.message), code: error.code };
  throw error;
} finally {
  process.stdout.write(
    `${JSON.stringify(
      {
        source: packet.source,
        phase,
        node: process.version,
        sourceHashes: { ...packet.sourceHashes, ...overlay },
        buildFiles: built.filter((row) => row[1] === "file").length,
        buildLinks: built.filter((row) => row[1] === "symlink").length,
        buildHash: hash(JSON.stringify(built)),
        buildInventory: built,
        inventoryComplete,
        inventoryFailure,
      },
      null,
      2,
    )}\n`,
  );
}
