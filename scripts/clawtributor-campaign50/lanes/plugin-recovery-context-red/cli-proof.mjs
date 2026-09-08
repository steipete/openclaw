import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, lane, evidence, phase] = process.argv.slice(2);
assert.equal(phase, "baseline");
assert.equal(process.version, "v24.20.0");
const { runManagedCommand } = await import(
  pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
);
const cases = JSON.parse(await fs.readFile(path.join(lane, "cases.json"), "utf8"));
assert.equal(cases.length, 14);
assert.equal(new Set(cases.map((row) => row.id)).size, 14);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const fixtureFiles = ["package.json", "openclaw.plugin.json", "index.js", "KEEP.txt"];
async function snapshotFiles(root) {
  const result = {};
  for (const name of (await fs.readdir(root)).sort()) {
    const file = path.join(root, name);
    const info = await fs.lstat(file);
    assert(info.isFile(), `Unexpected fixture entry: ${file}`);
    result[name] = digest(await fs.readFile(file));
  }
  return result;
}
await fs.mkdir(evidence, { recursive: true });
const owned = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-hints-117631-"));
const observations = [];
let completed = false;
let failure;
try {
  for (const test of cases) {
    const root = path.join(owned, test.id);
    for (const name of ["home", "state", "config", "cache", "data", "tmp", "workspace", "source"]) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    const configPath = path.join(root, "config", "openclaw.json");
    const sourcePath = path.join(root, "source");
    const destination = path.join(root, "state", "extensions", "campaign-hint-fixture");
    if (test.owner === "duplicate-link") {
      await fs.mkdir(destination, { recursive: true });
      for (const file of fixtureFiles) {
        await fs.copyFile(path.join(lane, "fixture", file), path.join(sourcePath, file));
        await fs.copyFile(path.join(lane, "fixture", file), path.join(destination, file));
      }
    }
    const config = {
      agents: {
        ownership: "explicit",
        entries: { ops: {} },
        defaults: { workspace: path.join(root, "workspace") },
      },
      plugins: { enabled: false },
      logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "fixture.log") },
    };
    await writeJson(configPath, config);
    const capture = async () => ({
      config: digest(await fs.readFile(configPath)),
      source: await snapshotFiles(sourcePath),
      ...(test.owner === "duplicate-link" ? { destination: await snapshotFiles(destination) } : {}),
    });
    const before = await capture();
    const env = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: path.join(root, "home"),
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: configPath,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_DATA_HOME: path.join(root, "data"),
      TMPDIR: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TEMP: path.join(root, "tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      TERM: "dumb",
      NO_COLOR: "1",
      ...test.env,
    };
    const argv = [
      path.join(target, "openclaw.mjs"),
      ...(test.rootArgs ?? []),
      ...test.args.map((arg) => (arg === "<owned-source-directory>" ? sourcePath : arg)),
    ];
    const row = {
      id: test.id,
      owner: test.owner,
      argv,
      config,
      configPath,
      sourcePath,
      destination,
      contextProof: test.contextProof,
      before,
      envKeys: Object.keys(env).sort(),
      suppliedContext: test.env ?? {},
      startedAt: new Date().toISOString(),
      managedJoined: false,
    };
    observations.push(row);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const abort = new AbortController();
    try {
      row.exit = await runManagedCommand({
        bin: process.execPath,
        args: argv,
        cwd: target,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 240_000,
        timeoutKillGraceMs: 5000,
        timeoutForceKillOnLeaderExit: true,
        requireProcessTreeExit: true,
        signal: abort.signal,
        abortKillGraceMs: 5000,
        onReady(child) {
          row.pid = child.pid;
          for (const [stream, chunks] of [
            [child.stdout, stdout],
            [child.stderr, stderr],
          ]) {
            stream.on("data", (chunk) => {
              outputBytes += chunk.length;
              if (outputBytes > 2_000_000) {
                row.outputLimitExceeded = true;
                abort.abort();
              } else chunks.push(chunk);
            });
          }
        },
      });
      row.managedJoined = true;
    } catch (error) {
      row.executionError = { message: String(error.message), code: error.code };
      throw error;
    } finally {
      row.finishedAt = new Date().toISOString();
      row.outputBytes = outputBytes;
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      await fs.writeFile(path.join(evidence, `${test.id}.stdout`), out);
      await fs.writeFile(path.join(evidence, `${test.id}.stderr`), err);
      row.stdoutSha256 = digest(out);
      row.stderrSha256 = digest(err);
      row.after = await capture();
      await writeJson(path.join(evidence, "observations.json"), observations);
    }
    assert.deepEqual(row.after, before, `${test.id}: authored config/package bytes changed`);
    assert.equal(row.managedJoined, true);
    assert.equal(row.outputLimitExceeded ?? false, false);
    assert.equal(row.exit, test.exit, `${test.id}: wrong CLI exit`);
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    const all = `${out}\n${err}`;
    if (test.owner === "duplicate-link") {
      const duplicate = `plugin already exists: ${destination} (delete it first)`;
      const hint =
        "Use `openclaw plugins update <id-or-npm-spec>` to upgrade the tracked plugin, or rerun install with `--force` to replace it.";
      assert.equal(
        all.split(duplicate).length - 1,
        1,
        `${test.id}: real duplicate path not reached`,
      );
      assert.equal(
        all.split(hint).length - 1,
        1,
        `${test.id}: baseline install hint missing/repeated`,
      );
      assert(!all.includes("Also not a valid hook pack"));
      assert(!all.includes("Linked plugin path:"));
      row.observedHint = hint;
    } else if (test.owner === "missing-update" || test.owner === "missing-update-dry-run") {
      const hint =
        'No tracked plugin or hook pack found for "campaign-untracked-fixture". Run "openclaw plugins list" or "openclaw hooks list" to inspect installed packages.';
      assert.equal(
        all.split(hint).length - 1,
        1,
        `${test.id}: baseline update hint missing/repeated`,
      );
      row.observedHint = hint;
    } else {
      assert.equal(all.split(test.expected).length - 1, 1, `${test.id}: control changed`);
      row.observedControl = test.expected;
    }
    row.accepted = true;
    await writeJson(path.join(evidence, "observations.json"), observations);
    process.stdout.write(`${JSON.stringify({ id: row.id, exit: row.exit, accepted: true })}\n`);
  }
  assert.equal(observations.length, 14);
  assert(observations.every((row) => row.accepted && row.managedJoined));
  assert.equal(new Set(observations.map((row) => row.pid)).size, 14);
  await fs.rm(owned, { recursive: true });
  await assert.rejects(fs.stat(owned), { code: "ENOENT" });
  completed = true;
} catch (error) {
  failure = { message: String(error.message), stack: error.stack };
  throw error;
} finally {
  await writeJson(path.join(evidence, "verdict.json"), {
    phase,
    completed,
    verdict: completed ? "BASELINE_REPRODUCED" : "FAILED",
    cases: observations.length,
    failure,
    ownedState: completed ? "removed after all managed joins" : owned,
    scope:
      "Duplicate linked install and untracked update recovery hints in default/profile/container-child contexts; no external installer, successful install/update, provider call, or actual container launch claimed.",
  });
}
