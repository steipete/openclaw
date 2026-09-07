import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const [laneDir] = process.argv.slice(2);
const read = (name) => readFileSync(path.join(laneDir, name));
const lineage = JSON.parse(read("retained-lineage.json"));
assert.equal(lineage.run, 34147489594);
assert.equal(lineage.job, 101822582964);
assert.equal(lineage.harness, "fbd558c211a0cc5067113dc86bdc49925fee94a6");
assert.equal(lineage.source, "e831b5e425880278fdf5ca11365f503aab60e44f");
assert.equal(lineage.wholeRun, "FAILURE");
assert.equal(Object.keys(lineage.files).length, 128);
for (const [logical, file] of Object.entries(lineage.files)) {
  assert(logical.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== ".."));
  assert.equal(file.stored, `retained-wave52/${logical}.txt`);
  assert.equal(createHash("sha256").update(read(file.stored)).digest("hex"), file.sha256, logical);
}
const retained = (logical) => read(lineage.files[logical].stored).toString("utf8");
assert.equal(JSON.parse(retained("source.json")).source, lineage.source);
assert.equal(retained("exit-code.txt").trim(), "1");
assert.deepEqual(JSON.parse(retained("baseline/cleanup.json")), {
  taskWorkspaceRemoved: true,
  childrenJoined: true,
});
const behavior = JSON.parse(retained("baseline/behavior.json"));
assert.equal(behavior.sourceSha, lineage.source);
assert.equal(behavior.mode, "baseline");
assert.equal(behavior.cases.length, 4);
assert.equal(behavior.invocations.length, 16);
const normalizePatch = (value) => value.replace(/^index .*\n/gm, "");
assert.equal(
  normalizePatch(retained("final-working-tree.patch")),
  normalizePatch(read("regression.patch").toString("utf8")),
);
console.log("RETAINED_WAVE52: 128 exact raw files verified; failed whole-run status preserved");
