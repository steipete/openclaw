import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [target, lane] = process.argv.slice(2);
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
assert.equal(process.version, packet.node);
assert.equal(git("rev-parse", "HEAD"), packet.source);
assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
assert.equal(
  JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).packageManager,
  packet.packageManager,
);
for (const [file, expected] of Object.entries(packet.sourceHashes)) {
  assert.equal(hash(fs.readFileSync(path.join(target, file))), expected, file);
}
for (const [file, expected] of Object.entries(packet.files)) {
  assert.equal(hash(fs.readFileSync(path.join(lane, file))), expected, file);
}
const built = [];
function visit(dir) {
  for (const entry of fs
    .readdirSync(path.join(target, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) built.push([file, hash(fs.readFileSync(path.join(target, file)))]);
    else throw new Error(`Unexpected build entry: ${file}`);
  }
}
if (fs.existsSync(path.join(target, "dist"))) visit("dist");
process.stdout.write(
  `${JSON.stringify({ source: packet.source, node: process.version, sourceHashes: packet.sourceHashes, buildFiles: built.length, buildHash: hash(JSON.stringify(built)), buildInventory: built }, null, 2)}\n`,
);
