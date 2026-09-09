import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lane = path.dirname(fileURLToPath(import.meta.url));
const [target, phase] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(path.join(lane, "source.json"), "utf8"));
assert.ok(["original", "baseline", "candidate"].includes(phase));
const git = (...args) =>
  execFileSync("git", args, { cwd: target, encoding: "utf8", timeout: 30_000 }).trim();
assert.equal(git("rev-parse", "HEAD"), spec.source);
assert.equal(git("rev-parse", "HEAD^{tree}"), spec.tree);
assert.equal(git("diff", "--name-only"), "", "Unstaged tracked source drift");
assert.equal(git("ls-files", "--others", "--exclude-standard"), "", "Unexpected untracked input");
const changed = phase === "original" ? {} : spec[phase];
assert.deepEqual(
  git("diff", "--cached", "--name-only", spec.source).split("\n").filter(Boolean).sort(),
  Object.keys(changed).sort(),
);
assert.equal(
  git("diff", "--cached", "--summary", spec.source),
  "",
  "Unexpected file mode or ownership change",
);
const expected = { ...spec.original, ...changed };
const hashes = {};
for (const [file, sha256] of Object.entries(expected)) {
  hashes[file] = createHash("sha256")
    .update(readFileSync(path.join(target, file)))
    .digest("hex");
  assert.equal(hashes[file], sha256, file);
}
console.log(
  JSON.stringify(
    {
      source: spec.source,
      tree: spec.tree,
      phase,
      changedPaths: Object.keys(changed).sort(),
      hashes,
    },
    null,
    2,
  ),
);
