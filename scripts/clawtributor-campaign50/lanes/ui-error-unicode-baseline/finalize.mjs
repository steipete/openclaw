import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [evidence] = process.argv.slice(2);
const json = (name) => JSON.parse(readFileSync(path.join(evidence, name), "utf8"));
assert.deepEqual(json("source-before.json"), json("source-restored.json"));
assert.deepEqual(json("source-applied.json"), json("source-before-restoration.json"));
const qualified = json("qualified-browser.json");
assert.equal(qualified.baselineReproduced, true);
const files = [
  "source-before.json",
  "source-applied.json",
  "source-before-restoration.json",
  "source-restored.json",
  "browser.json",
  "browser.log",
  "browser-exit.txt",
  "qualified-browser.json",
  "applied.patch",
  "chromium-install.log",
  "packet-check.log",
];
writeFileSync(
  path.join(evidence, "receipt.json"),
  JSON.stringify(
    {
      ...qualified,
      sourceRestored: true,
      imageInspectionPending: true,
      outerExitStillRequired: true,
      files: Object.fromEntries(
        files.map((name) => [
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
