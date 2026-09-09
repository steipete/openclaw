import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [evidence, mode] = process.argv.slice(2);
assert.ok(mode === "baseline" || mode === "candidate");
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
if (mode === "candidate") {
  const log = readFileSync(path.join(evidence, "changed-check.log"), "utf8");
  assert.doesNotMatch(
    log,
    /\[dist artifacts\] child cleanup unverified; retained |\[control-ui-e2e\] unsafe cleanup: |Managed command cleanup could not verify child, process group, and output closure|Windows taskkill could not verify managed process tree exit/,
  );
  names.push("changed-check.log");
}
writeFileSync(
  path.join(evidence, "receipt.json"),
  JSON.stringify(
    {
      source: spec.source,
      tree: spec.tree,
      mode,
      renderer,
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
