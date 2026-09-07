// Byte/source binding only. This draft is not locally executed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
const [pinsFile, root, receipt, arm, mode] = process.argv.slice(2);
const pin = JSON.parse(readFileSync(pinsFile, "utf8"))[arm];
const fileBytes = {};
const hash = (file) => {
  const bytes = readFileSync(path.join(root, file));
  fileBytes[file] = bytes.length;
  return createHash("sha256").update(bytes).digest("hex");
};
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
function buildFiles(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return buildFiles(name);
    }
    return entry.isFile() ? [name] : [];
  });
}
const distFiles = buildFiles("dist");
const files = [
  ...new Set([
    "package.json",
    "pnpm-lock.yaml",
    "openclaw.mjs",
    "dist/.buildstamp",
    "dist/.runtime-postbuildstamp",
    ...distFiles.filter((file) => /\.(?:js|mjs|cjs|json)$/.test(file)),
  ]),
].sort();
const hashes = Object.fromEntries(files.map((file) => [file, hash(file)]));
const nativeRelayFiles = distFiles.filter((file) => file.startsWith("dist/native-hook-relay/"));
const bytesFor = (file) => fileBytes[file] ?? statSync(path.join(root, file)).size;
const result = {
  head: pin.head,
  tree: pin.tree,
  profile: "qaRuntime",
  hashes,
  byteCounts: {
    hashedFileBytes: Object.values(fileBytes).reduce((sum, bytes) => sum + bytes, 0),
    distRegularFiles: distFiles.length,
    distRegularFileBytes: distFiles.reduce((sum, file) => sum + bytesFor(file), 0),
    nativeRelayFiles: nativeRelayFiles.length,
    nativeRelayBytes: nativeRelayFiles.reduce((sum, file) => sum + bytesFor(file), 0),
  },
};
if (mode === "write") {
  writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
} else {
  assert.equal(mode, "verify");
  assert.deepEqual(result, JSON.parse(readFileSync(receipt, "utf8")));
}
