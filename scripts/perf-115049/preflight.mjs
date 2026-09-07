// Built-ins only: run before the first checkout-owned action, install, test or runtime import.
import assert from "node:assert/strict";
import path from "node:path";
import { verifySource } from "./proof-integrity.mjs";
assert.equal(process.env.CI, "true");
assert.equal(process.versions.node, "24.20.0");
for (const variant of ["baseline", "candidate"]) {
  const source = await verifySource(path.resolve(variant), variant);
  console.log(
    JSON.stringify({
      variant,
      commit: source.commit,
      tree: source.tree,
      sourceSha256: source.sha256,
    }),
  );
}
