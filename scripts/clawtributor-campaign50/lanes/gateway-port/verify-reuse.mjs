import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const lane = process.argv[2];
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const withoutIndex = (text) => text.replace(/^index [^\n]+\n/gm, "");
function verifyManifest(name, runId, owners) {
  const directory = path.join(lane, name);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.source, packet.base);
  assert.equal(receipt.node, "24.20.0");
  assert.equal(receipt.pnpm, "12.3.4");
  assert.equal(receipt.testsPatchSha256, packet.artifacts["regression-tests.patch"]);
  assert.deepEqual(receipt.owners, owners);
  for (const [file, expected] of Object.entries(receipt.artifacts)) {
    assert.equal(hash(path.join(directory, file)), expected, file);
  }
  const original = JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8"));
  assert.equal(original.source, packet.base);
  assert.equal(original.node, receipt.node);
  assert.equal(
    original.packageManager,
    JSON.parse(fs.readFileSync("package.json", "utf8")).packageManager,
  );
  assert.equal(
    withoutIndex(fs.readFileSync(path.join(directory, "final-working-tree.patch"), "utf8")),
    withoutIndex(fs.readFileSync(path.join(lane, "regression-tests.patch"), "utf8")),
  );
  return receipt;
}
verifyManifest("reuse-wave12", 34026143939, [
  "src/cli/gateway-port-option.test.ts",
  "src/cli/gateway-rpc.runtime.test.ts",
  "src/cli/program/register.onboard.test.ts",
]);
const receipt = verifyManifest("reuse-wave14", 34028447384, [
  "src/cli/program/register.setup.test.ts",
]);
for (const [file, expected] of Object.entries(packet.files)) {
  if (file.endsWith(".test.ts")) assert.equal(hash(file), expected, file);
}

const expectedPeers = new Map([
  ["omitted", "configured"],
  ["environment-port", "other"],
  ["empty-environment-port", "configured"],
  ["environment-url", "other"],
  ["valid", "other"],
  ["valid-over-environment", "configured"],
  ["empty", "configured"],
  ["whitespace", "configured"],
  ["equals-empty", "configured"],
]);
const records = JSON.parse(
  fs.readFileSync(path.join(lane, "reuse-wave14", "cli-baseline.json"), "utf8"),
);
assert.deepEqual(receipt.qualifiedCliNames, [...expectedPeers.keys()]);
assert.deepEqual(receipt.unqualifiedCliNames, ["invalid-numeric"]);
assert.deepEqual(
  records.map((record) => record.name),
  [...expectedPeers.keys(), "invalid-numeric"],
);
for (const record of records.slice(0, 9)) {
  assert.equal(record.stage, "baseline");
  assert.equal(record.code, 0, record.name);
  assert.equal(record.signal, null, record.name);
  assert.equal(record.validJson, true, record.name);
  assert.equal(record.expectedMarker, true, record.name);
  assert.equal(record.invalidPort, false, record.name);
  assert.equal(record.conflictingTarget, false, record.name);
  assert.deepEqual(
    record.connections.map((connection) => connection.label),
    ["configured", "other"],
  );
  for (const connection of record.connections) {
    if (connection.label === expectedPeers.get(record.name)) {
      assert.ok(connection.count > 0, record.name);
      assert.ok(connection.methods.includes("connect"), record.name);
      assert.ok(connection.methods.includes("logs.tail"), record.name);
    } else {
      assert.equal(connection.count, 0, record.name);
      assert.deepEqual(connection.methods, [], record.name);
    }
  }
}
console.log(
  "GATEWAY_PORT_CLI_REUSED: nine successful baseline cases from run34028447384; invalid-numeric output format remains unqualified",
);
