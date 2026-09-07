import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [sourceDir, proofDir, arm] = process.argv.slice(2);
assert.ok(path.isAbsolute(sourceDir) && path.isAbsolute(proofDir));
assert.ok(arm === "baseline" || arm === "candidate");
const { runManagedCommand } = await import(
  pathToFileURL(path.join(sourceDir, "scripts/lib/managed-child-process.mts")).href
);
const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed.mjs");
const observations = { arm, commands: [], completed: false };
const artifactDir = path.join(proofDir, "artifacts");
await fs.mkdir(artifactDir, { recursive: true });

function caseEnv(caseDir) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(caseDir, "home"),
    TMPDIR: path.join(caseDir, "tmp"),
    XDG_CONFIG_HOME: path.join(caseDir, "config"),
    XDG_CACHE_HOME: path.join(caseDir, "cache"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
    OPENCLAW_HOME: path.join(caseDir, "home"),
    OPENCLAW_STATE_DIR: path.join(caseDir, "state"),
    OPENCLAW_CONFIG_PATH: path.join(caseDir, "openclaw.json"),
  };
}

async function run(label, caseDir, command, args, expectedExit = 0) {
  let stdout = "";
  let stderr = "";
  let capturedBytes = 0;
  const controller = new AbortController();
  const started = performance.now();
  const usagePath = path.join(caseDir, `${label}.usage.json`);
  const exitCode = await runManagedCommand({
    bin: "/usr/bin/time",
    args: ["-f", '{"maxRssKiB":%M,"elapsedSeconds":%e}', "-o", usagePath, command, ...args],
    cwd: sourceDir,
    env: caseEnv(caseDir),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 120_000,
    timeoutForceKillOnLeaderExit: true,
    requireProcessTreeExit: true,
    signal: controller.signal,
    onReady(child) {
      for (const [stream, append] of [
        [
          child.stdout,
          (text) => {
            stdout += text;
          },
        ],
        [
          child.stderr,
          (text) => {
            stderr += text;
          },
        ],
      ]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (text) => {
          capturedBytes += Buffer.byteLength(text);
          if (capturedBytes > 4 * 1024 * 1024) {
            controller.abort(new Error("Owned proof output exceeded 4 MiB"));
            return;
          }
          append(text);
        });
      }
    },
  });
  assert.ok(!controller.signal.aborted, `${label}: output overflow`);
  const usageLines = (await fs.readFile(usagePath, "utf8")).trim().split("\n");
  const usage = JSON.parse(usageLines.at(-1));
  observations.commands.push({ label, exitCode, elapsedMs: performance.now() - started, ...usage });
  await fs.writeFile(path.join(caseDir, `${label}.stdout`), stdout);
  await fs.writeFile(path.join(caseDir, `${label}.stderr`), stderr);
  assert.equal(
    exitCode,
    expectedExit,
    `${label}: unexpected exit; inspect retained local command output`,
  );
  return { stdout, stderr };
}

async function seed(name, blocked, eligible) {
  const caseDir = path.join(proofDir, name);
  await Promise.all(
    ["home", "tmp", "config", "cache", "state"].map((dir) =>
      fs.mkdir(path.join(caseDir, dir), { recursive: true }),
    ),
  );
  await run("seed", caseDir, process.execPath, [
    "--import",
    path.join(sourceDir, "scripts/tsx.mjs"),
    seedPath,
    sourceDir,
    caseDir,
    String(blocked),
    String(eligible),
  ]);
  return {
    caseDir,
    fixture: JSON.parse(await fs.readFile(path.join(caseDir, "seed.json"), "utf8")),
  };
}

const thresholds = ["--min-score", "0", "--min-recall-count", "0", "--min-unique-queries", "0"];
async function cli(label, caseDir, args, expectedExit = 0) {
  return await run(
    label,
    caseDir,
    "pnpm",
    ["--silent", "openclaw", "memory", ...args],
    expectedExit,
  );
}
const blocked = (candidate) => ["untrusted", "system"].includes(candidate.provenance?.originClass);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

try {
  const basic = await seed("basic", 1, 1);
  const eligibleKey = basic.fixture.eligibleKeys[0];
  const preview = JSON.parse(
    (
      await cli("preview", basic.caseDir, [
        "promote",
        "--agent",
        "proof",
        "--limit",
        "1",
        ...thresholds,
        "--json",
      ])
    ).stdout,
  );
  assert.equal(preview.candidates.length, 1);
  const eligiblePreview = preview.candidates[0].key === eligibleKey;
  assert.equal(eligiblePreview, arm === "candidate");
  if (arm === "baseline") {
    assert.equal(preview.candidates[0].key, basic.fixture.blockedKeys[0]);
    assert.ok(blocked(preview.candidates[0]));
  }
  observations.preview = { eligiblePreview, firstKey: preview.candidates[0].key };

  const applied = JSON.parse(
    (
      await cli("apply", basic.caseDir, [
        "promote",
        "--agent",
        "proof",
        "--apply",
        "--limit",
        "1",
        ...thresholds,
        "--json",
      ])
    ).stdout,
  );
  assert.equal(applied.apply.applied, 1);
  assert.deepEqual(
    applied.apply.appliedCandidates.map((candidate) => candidate.key),
    [eligibleKey],
  );
  const memory = await fs.readFile(path.join(basic.fixture.workspaceDir, "MEMORY.md"), "utf8");
  assert.equal(memory.split(basic.fixture.eligibleSnippet).length - 1, 1);
  assert.ok(!memory.includes("Blocked fixture note"));
  observations.apply = {
    appliedKeys: [eligibleKey],
    eligibleTextOnce: true,
    blockedTextAbsent: true,
  };

  const included = JSON.parse(
    (
      await cli("include-promoted", basic.caseDir, [
        "promote",
        "--agent",
        "proof",
        "--include-promoted",
        ...thresholds,
        "--json",
      ])
    ).stdout,
  );
  assert.equal(
    typeof included.candidates.find((candidate) => candidate.key === eligibleKey)?.promotedAt,
    "string",
  );
  const explained = JSON.parse(
    (
      await cli("eligible-explain", basic.caseDir, [
        "promote-explain",
        eligibleKey,
        "--agent",
        "proof",
        "--include-promoted",
        "--json",
      ])
    ).stdout,
  );
  assert.equal(explained.candidate.key, eligibleKey);
  const blockedExplanation = await cli(
    "blocked-explain",
    basic.caseDir,
    ["promote-explain", basic.fixture.blockedKeys[0], "--agent", "proof", "--json"],
    arm === "candidate" ? 1 : 0,
  );
  if (arm === "candidate") {
    assert.match(blockedExplanation.stderr, /No promotion candidate matched/);
  } else {
    assert.equal(JSON.parse(blockedExplanation.stdout).candidate.key, basic.fixture.blockedKeys[0]);
  }
  assert.equal(
    sha256(await fs.readFile(path.join(basic.fixture.workspaceDir, basic.fixture.relativePath))),
    basic.fixture.sourceSha256,
  );
  observations.siblings = { includePromoted: true, eligibleExplain: true, sourceUnchanged: true };

  const scale = await seed("scale", 504, 8);
  const ranked = JSON.parse(
    (
      await cli("scale-preview", scale.caseDir, [
        "promote",
        "--agent",
        "proof",
        ...thresholds,
        "--json",
      ])
    ).stdout,
  );
  assert.equal(ranked.candidates.length, arm === "baseline" ? 512 : 8);
  assert.equal(ranked.candidates.filter(blocked).length, arm === "baseline" ? 504 : 0);
  assert.deepEqual(
    ranked.candidates
      .filter((candidate) => !blocked(candidate))
      .map((candidate) => candidate.key)
      .sort(),
    scale.fixture.eligibleKeys.sort(),
  );
  observations.scale = {
    seeded: 512,
    ranked: ranked.candidates.length,
    blockedRanked: ranked.candidates.filter(blocked).length,
    eligibleRanked: 8,
  };
  observations.completed = true;
} finally {
  await fs.writeFile(
    path.join(artifactDir, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}
