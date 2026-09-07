// Remote-only proof wrapper; exact pins come from the reviewed workflow.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [kind, sourceDir, expectedHead, expectedTree, driver, expectedDriverSha256, artifactDir] =
  process.argv.slice(2);
assert.ok(kind === "baseline" || kind === "candidate");
assert.ok([sourceDir, driver, artifactDir].every(path.isAbsolute));
assert.match(expectedHead, /^[0-9a-f]{40}$/);
assert.match(expectedTree, /^[0-9a-f]{40}$/);
assert.match(expectedDriverSha256, /^[0-9a-f]{64}$/);
assert.equal(process.versions.node, "24.20.0");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", ["-C", sourceDir, ...args], { encoding: "utf8" }).trim();
const buildStampSha256 = {};
const verify = async () => {
  assert.equal(git("rev-parse", "HEAD"), expectedHead);
  assert.equal(git("rev-parse", "HEAD^{tree}"), expectedTree);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(hash(await fs.readFile(driver)), expectedDriverSha256);
  for (const stamp of [".buildstamp", ".runtime-postbuildstamp"]) {
    const bytes = await fs.readFile(path.join(sourceDir, "dist", stamp));
    assert.equal(JSON.parse(bytes.toString("utf8")).head, expectedHead);
    const digest = hash(bytes);
    if (Object.hasOwn(buildStampSha256, stamp)) {
      assert.equal(digest, buildStampSha256[stamp]);
    } else {
      buildStampSha256[stamp] = digest;
    }
  }
};
await verify();
await fs.mkdir(artifactDir, { recursive: true });
const { runManagedCommand } = await import(
  pathToFileURL(path.join(sourceDir, "scripts/lib/managed-child-process.mts")).href
);
const allowed = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CI",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
];
const env = Object.fromEntries(
  allowed.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
);
let childPid;
const exitCode = await runManagedCommand({
  bin: process.execPath,
  args: ["--import", "./scripts/tsx.mjs", driver, sourceDir, artifactDir],
  cwd: sourceDir,
  env,
  stdio: "inherit",
  shell: false,
  timeoutMs: 300_000,
  requireProcessTreeExit: true,
  onReady: (child) => {
    childPid = child.pid;
  },
});
await verify();
const result = JSON.parse(
  await fs.readFile(path.join(artifactDir, "ordinary-staging.json"), "utf8"),
);
assert.equal(result.driverSha256, expectedDriverSha256);
assert.equal(
  result.stagingOwnerSha256,
  hash(await fs.readFile(path.join(sourceDir, "src/auto-reply/reply/stage-sandbox-media.ts"))),
);
assert.deepEqual(
  result.observations.map((item) => item.name),
  ["missing-only", "success", "missing-then-valid", "valid-then-missing"],
);
assert.equal(result.cleaned, true);
assert.deepEqual(
  result.failures,
  kind === "baseline" ? ["missing-only:staging-directory-count"] : [],
);
assert.equal(exitCode, kind === "baseline" ? 1 : 0);
await fs.writeFile(
  path.join(artifactDir, "accepted-proof.json"),
  JSON.stringify(
    {
      kind,
      sourceHead: expectedHead,
      sourceTree: expectedTree,
      driverSha256: expectedDriverSha256,
      buildStampSha256,
      stagingOwnerSha256: result.stagingOwnerSha256,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      childPid,
      childExitCode: exitCode,
      childTreeAndPipesJoined: true,
      observationCount: result.observations.length,
      cleaned: true,
      acceptedFailures: result.failures,
    },
    null,
    2,
  ) + "\n",
);
