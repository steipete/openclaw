// Inert task launcher. All source/build bytes are bound before and after each native pass.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPhase } from "./phase-runner.mjs";
import { digest, PINS, verifyBuilt } from "./proof-integrity.mjs";
import { createSnapshotProofEnvironment } from "./secretless-env.parts.mjs";
assert.equal(process.env.CI, "true");
assert.equal(process.versions.node, "24.20.0");
const config = JSON.parse(await fs.readFile(path.resolve(process.argv[2]), "utf8"));
assert.ok(["baseline", "candidate"].includes(config.variant));
assert.ok(["observed", "uninstrumented"].includes(config.mode));
assert.equal(config.sourceCommit, PINS[config.variant].commit);
const repoRoot = await fs.realpath(config.repoRoot);
const expected = JSON.parse(
  await fs.readFile(path.join(config.scratchRoot, `${config.variant}-built.json`), "utf8"),
);
await verifyBuilt(repoRoot, config.variant, expected);
const packageJson = JSON.parse(
  await fs.readFile(path.join(repoRoot, "extensions/codex/package.json"), "utf8"),
);
assert.equal(packageJson.dependencies["@openai/codex"], "0.153.4");
const lcmArchive = await fs.realpath(config.lcmArchive);
assert.equal(
  digest(await fs.readFile(lcmArchive)),
  "58d7b1effb77236457dc7432d83c6a2662f1fbcbaf399bedd534c174a7f7da37",
);
const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const files = JSON.parse(await fs.readFile(path.join(harnessRoot, "proof-files.json"), "utf8"));
for (const [name, hash] of Object.entries(files)) {
  const relative = path.relative(
    path.resolve(harnessRoot, "../.."),
    path.resolve(harnessRoot, name),
  );
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.equal(digest(await fs.readFile(path.join(harnessRoot, name))), hash);
}
const copied = [];
const ownedRoot = await fs.mkdtemp(
  path.join(config.scratchRoot, `${config.variant}-${config.mode}-`),
);
let unjoined = false;
let launched = false;
try {
  for (const name of ["driver", "native"]) {
    const relative = `test/e2e/qa-lab/runtime/perf-115049-${name}.ts`;
    const target = path.join(repoRoot, relative);
    await fs.writeFile(target, await fs.readFile(path.join(harnessRoot, "../..", relative)), {
      flag: "wx",
      mode: 0o600,
    });
    copied.push(target);
  }
  const env = await createSnapshotProofEnvironment(ownedRoot);
  const runConfig = {
    ...config,
    repoRoot,
    lcmArchive,
    ownedRoot,
    observerPath: path.join(harnessRoot, "read-observer.mjs"),
    countsFile: path.join(ownedRoot, "read-counts.json"),
    verdictFile: path.join(ownedRoot, "verdict.json"),
  };
  const childConfig = path.join(ownedRoot, "run.json");
  await fs.writeFile(childConfig, JSON.stringify(runConfig), { mode: 0o600 });
  launched = true;
  const code = await runPhase({
    baseline: config.baselineRoot,
    label: `${config.variant}-${config.mode}`,
    bin: process.execPath,
    args: [
      "--import",
      path.join(repoRoot, "scripts/tsx.mjs"),
      path.join(repoRoot, "test/e2e/qa-lab/runtime/perf-115049-driver.ts"),
      childConfig,
    ],
    cwd: repoRoot,
    env,
    timeoutMs: 480_000,
    publishRoot: config.publishRoot,
  });
  assert.equal(code, 0);
  const verdict = JSON.parse(await fs.readFile(runConfig.verdictFile, "utf8"));
  assert.equal(verdict.complete, true);
  assert.equal(verdict.sourceCommit, PINS[config.variant].commit);
  assert.equal(verdict.mode, config.mode);
  assert.equal(verdict.cleanupJoined, true);
  await verifyBuilt(repoRoot, config.variant, expected);
  await fs.writeFile(
    path.join(config.publishRoot, `${config.variant}-${config.mode}.json`),
    JSON.stringify(verdict, null, 2) + "\n",
    { mode: 0o600 },
  );
} catch (error) {
  unjoined = error?.unjoined === true;
  throw error;
} finally {
  // The child records its own detached Gateway cleanup, beyond the outer process group.
  if (launched) {
    try {
      const cleanup = JSON.parse(await fs.readFile(path.join(ownedRoot, "cleanup.json"), "utf8"));
      unjoined ||= cleanup.joined !== true;
    } catch {
      unjoined = true;
    }
  }
  if (!unjoined) {
    for (const target of copied) {
      const relative = path.relative(repoRoot, target);
      assert.equal(
        digest(await fs.readFile(target)),
        files[`../../${relative}`],
        "proof fixture bytes changed during execution",
      );
      await fs.unlink(target);
    }
    await fs.rm(ownedRoot, { recursive: true });
  }
  await verifyBuilt(repoRoot, config.variant, expected);
  assert.equal(
    unjoined,
    false,
    "native cleanup was not verified; private scratch retained and never uploaded",
  );
}
