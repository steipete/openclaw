// Byte/source binding only. This draft is not locally executed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
const [pinsFile, root, receipt, arm, mode] = process.argv.slice(2);
const pin = JSON.parse(readFileSync(pinsFile, "utf8"))[arm];
const hash = (file) =>
  createHash("sha256")
    .update(readFileSync(path.join(root, file)))
    .digest("hex");
for (const stamp of ["dist/.buildstamp", "dist/.runtime-postbuildstamp"]) {
  assert.equal(JSON.parse(readFileSync(path.join(root, stamp), "utf8")).head, pin.head);
}
const required = [
  "openclaw.mjs",
  "dist/entry.js",
  "dist/plugin-sdk/agent-harness-runtime.js",
  "dist/plugin-sdk/hook-runtime.js",
  "dist/plugin-sdk/process-runtime.js",
];
if (arm === "candidate") {
  required.push("dist/native-hook-relay/entry.js");
}
for (const file of required) {
  assert.ok(realpathSync(path.join(root, file)).startsWith(`${realpathSync(root)}${path.sep}`));
}
function runtimeFiles(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return runtimeFiles(name);
    }
    return entry.isFile() && /\.(?:js|mjs|cjs|json)$/.test(name) ? [name] : [];
  });
}
const files = [
  ...new Set([
    "package.json",
    "pnpm-lock.yaml",
    "openclaw.mjs",
    "dist/.buildstamp",
    "dist/.runtime-postbuildstamp",
    ...runtimeFiles("dist"),
  ]),
].sort();
const hashes = Object.fromEntries(files.map((file) => [file, hash(file)]));
const result = { head: pin.head, tree: pin.tree, profile: "qaRuntime", hashes };
if (mode === "write") {
  writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
} else {
  assert.equal(mode, "verify");
  assert.deepEqual(result, JSON.parse(readFileSync(receipt, "utf8")));
}
