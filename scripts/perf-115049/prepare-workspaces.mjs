// Inert CI-only builder: verify both exact trees before importing any checkout tooling.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runPhase } from "./phase-runner.mjs";
import { verifySource, verifyBuilt } from "./proof-integrity.mjs";
import { createSnapshotProofEnvironment } from "./secretless-env.parts.mjs";
assert.equal(process.env.CI, "true");
assert.equal(process.versions.node, "24.20.0");
const [baseline, candidate, publishRoot, scratch] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
await verifySource(baseline, "baseline");
await verifySource(candidate, "candidate");
for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "extensions/codex/package.json",
]) {
  assert.deepEqual(
    await fs.readFile(path.join(baseline, file)),
    await fs.readFile(path.join(candidate, file)),
    file,
  );
}
for (const [variant, repo] of [
  ["baseline", baseline],
  ["candidate", candidate],
]) {
  const ownedRoot = await fs.mkdtemp(path.join(scratch, `${variant}-build-`));
  const env = {
    ...(await createSnapshotProofEnvironment(ownedRoot)),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    OPENCLAW_BUILD_PRIVATE_QA: "1",
  };
  let unjoined = false;
  try {
    for (const [phase, args, timeoutMs] of [
      ["install", ["install", "--frozen-lockfile"], 600_000],
      ["build", ["build"], 900_000],
    ]) {
      await verifySource(repo, variant);
      assert.equal(
        await runPhase({
          baseline,
          label: `${variant}-${phase}`,
          bin: "pnpm",
          args,
          cwd: repo,
          env,
          timeoutMs,
          publishRoot,
        }),
        0,
      );
      await verifySource(repo, variant);
    }
    const binding = await verifyBuilt(repo, variant);
    await fs.writeFile(path.join(scratch, `${variant}-built.json`), JSON.stringify(binding));
    await fs.writeFile(
      path.join(publishRoot, `${variant}-source.json`),
      JSON.stringify({
        commit: binding.source.commit,
        tree: binding.source.tree,
        sourceSha256: binding.source.sha256,
        runtimeSha256: binding.runtime.sha256,
      }) + "\n",
    );
  } catch (error) {
    unjoined = error?.unjoined === true;
    throw error;
  } finally {
    if (!unjoined) {
      await fs.rm(ownedRoot, { recursive: true });
    }
  }
}
