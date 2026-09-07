import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, lane, evidence, phase] = process.argv.slice(2);
assert.equal(phase, "candidate");
assert.equal(process.version, "v24.20.0");
const { runManagedCommand } = await import(
  pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
);
const cases = JSON.parse(await fs.readFile(path.join(lane, "cases.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = async (file) => digest(await fs.readFile(file));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
await fs.mkdir(evidence, { recursive: true });
const owned = await fs.mkdtemp(path.join(os.tmpdir(), "blank-cli-140907-"));
const observations = [];
let completed = false;
let failure;
try {
  for (const test of cases) {
    assert(!test.argv.includes("--probe"));
    assert.deepEqual(
      test.argv.slice(0, 2),
      test.owner === "logs" ? ["channels", "logs"] : ["models", "status"],
    );
    const root = path.join(owned, test.id);
    for (const name of ["home", "state", "config", "cache", "data", "tmp", "workspace"]) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    const configPath = path.join(root, "config", "openclaw.json");
    const logPath = path.join(root, "fixture.log");
    const messages = Array.from(
      { length: 205 },
      (_, index) => `synthetic-row-${String(index + 1).padStart(3, "0")}`,
    );
    await fs.writeFile(
      logPath,
      messages
        .map((message) => JSON.stringify({ time: "2026-09-07T00:00:00.000Z", message }))
        .join("\n") + "\n",
    );
    await writeJson(configPath, {
      agents: {
        defaults: {
          workspace: path.join(root, "workspace"),
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
      },
      logging: { level: "silent", consoleLevel: "silent", file: logPath },
    });
    const before = { config: await fileHash(configPath), log: await fileHash(logPath) };
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
    };
    const argv = [path.join(target, "openclaw.mjs"), ...test.argv];
    const row = {
      id: test.id,
      owner: test.owner,
      kind: test.kind,
      argv,
      expected: test.expected,
      before,
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
      await fs.writeFile(path.join(evidence, `${test.id}.stdout`), Buffer.concat(stdout));
      await fs.writeFile(path.join(evidence, `${test.id}.stderr`), Buffer.concat(stderr));
      row.stdoutSha256 = digest(Buffer.concat(stdout));
      row.stderrSha256 = digest(Buffer.concat(stderr));
      row.after = { config: await fileHash(configPath), log: await fileHash(logPath) };
      await writeJson(path.join(evidence, "observations.json"), observations);
    }
    assert.deepEqual(row.after, before, `${test.id}: synthetic config/log changed`);
    assert.equal(row.managedJoined, true);
    assert.equal(row.outputLimitExceeded ?? false, false);
    assert.equal(row.exit, test.expected.exit, `${test.id}: wrong CLI exit`);
    const payload = JSON.parse(Buffer.concat(stdout).toString("utf8").trim());
    row.payload = payload;
    if (test.expected.error) {
      assert.deepEqual(payload, {
        ok: false,
        error: { type: "cli_error", message: test.expected.error },
      });
    } else if (test.owner === "logs") {
      assert.equal(payload.file, logPath);
      assert.equal(payload.channel, "all");
      assert.equal(payload.truncated, true);
      assert.deepEqual(
        payload.lines.map((line) => line.message),
        messages.slice(-test.expected.lines),
      );
      row.observedLines = payload.lines.length;
    } else {
      assert.equal(payload.configPath, configPath);
      assert.equal(payload.defaultModel, "anthropic/claude-sonnet-4-6");
      assert.equal(payload.resolvedDefault, "anthropic/claude-sonnet-4-6");
      assert.equal(Object.hasOwn(payload.auth, "probes"), false);
      assert.deepEqual(payload.auth.providersWithOAuth, []);
      assert.deepEqual(payload.auth.oauth.profiles, []);
      assert.deepEqual(payload.auth.shellEnvFallback.appliedKeys, []);
      row.noProbeRequestedOrReported = true;
    }
    row.accepted = true;
    await writeJson(path.join(evidence, "observations.json"), observations);
    process.stdout.write(`${JSON.stringify({ id: row.id, exit: row.exit, accepted: true })}\n`);
  }
  assert.equal(observations.length, 18);
  assert.equal(observations.filter((row) => row.kind === "blank" && row.exit === 1).length, 4);
  assert.equal(observations.filter((row) => row.kind === "whitespace" && row.exit === 1).length, 4);
  assert(observations.every((row) => row.accepted && row.managedJoined));
  await fs.rm(owned, { recursive: true });
  completed = true;
} catch (error) {
  failure = { message: String(error.message), stack: error.stack };
  throw error;
} finally {
  await writeJson(path.join(evidence, "verdict.json"), {
    phase,
    completed,
    verdict: completed ? "CANDIDATE_PASSED" : "FAILED",
    cases: observations.length,
    failure,
    ownedState: completed ? "removed after all managed joins" : owned,
    scope:
      "four explicit empty CLI inputs rejected; whitespace rejected; omitted/default/normal controls; no --probe invocation",
  });
}
