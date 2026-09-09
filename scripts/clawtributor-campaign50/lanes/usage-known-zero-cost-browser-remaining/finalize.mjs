import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [evidence, mode] = process.argv.slice(2);
assert.equal(mode, "baseline");
const lane = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(path.join(lane, "source.json"), "utf8"));
const json = (file) => JSON.parse(readFileSync(path.join(evidence, file), "utf8"));
const before = json("source-before.json");
const applied = json("source-applied.json");
const retired = json("source-before-restoration.json");
const restored = json("source-restored.json");
assert.deepEqual(restored, before);
assert.deepEqual(retired, applied);
assert.equal(before.source, spec.source);
assert.equal(before.tree, spec.tree);
assert.deepEqual(before.hashes, spec.original);
assert.equal(applied.phase, mode);
assert.deepEqual(applied.hashes, { ...spec.original, ...spec[mode] });
assert.deepEqual(applied.changedPaths, Object.keys(spec[mode]).sort());
const renderer = json("qualified-renderer.json");
const browser = json("qualified-browser.json");
for (const row of [renderer, browser]) {
  assert.equal(row.mode, mode);
  assert.equal(row.componentQualified, true);
}
const names = [
  "source-before.json",
  "source-applied.json",
  "source-before-restoration.json",
  "source-restored.json",
  "renderer.json",
  "renderer.log",
  "renderer-exit.txt",
  "browser.json",
  "browser.log",
  "browser-exit.txt",
  "qualified-renderer.json",
  "qualified-browser.json",
  "applied.patch",
  "chromium-install.log",
  "packet-check.log",
];
const reuse = json("renderer-reuse.json");
assert.equal(reuse.historicalRun, 34304097761);
assert.equal(reuse.historicalRunConclusion, "FAILURE");
assert.equal(reuse.historicalBrowserQualified, false);
assert.equal(reuse.rendererExecutedThisRun, false);
assert.equal(reuse.rendererQualified, true);
names.push("renderer-reuse.json");

writeFileSync(
  path.join(evidence, "receipt.json"),
  JSON.stringify(
    {
      source: spec.source,
      tree: spec.tree,
      mode,
      renderer,
      rendererReuse: reuse,
      browser,
      sourceRestored: true,
      proofComponentsQualified: true,
      outerExitStillRequired: true,
      files: Object.fromEntries(
        names.map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(path.join(evidence, name)))
            .digest("hex"),
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
