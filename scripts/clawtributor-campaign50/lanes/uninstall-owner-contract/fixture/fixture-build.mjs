import assert from "node:assert/strict";
import fs from "node:fs";
const part = process.argv[2];
assert.ok(part === "ui" || part === "cli");
assert.equal(
  JSON.parse(fs.readFileSync("package.json", "utf8")).description,
  "Synthetic installer ownership fixture; not the OpenClaw product",
);
fs.mkdirSync("dist", { recursive: true });
if (part === "ui") fs.writeFileSync("dist/synthetic-ui.txt", "synthetic UI build completed\n");
else fs.copyFileSync("fixture-entry.mjs", "dist/entry.js");
