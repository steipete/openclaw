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
assert.equal(cases.length, 8);
assert.equal(new Set(cases.map((row) => row.id)).size, 8);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const genericError =
  "Multiple agents are configured, but this operation has no explicit owner. Select an agent explicitly; CLI callers can pass --agent <id>, channels can add a binding, and ambient services can set their agentId target.";
await fs.mkdir(evidence, { recursive: true });
const owned = await fs.mkdtemp(path.join(os.tmpdir(), "message-owner-141886-"));
const observations = [];
let completed = false;
let failure;
try {
  for (const test of cases) {
    const root = path.join(owned, test.id);
    for (const name of ["home", "state", "config", "cache", "data", "tmp", "workspace"]) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    const configPath = path.join(root, "config", "openclaw.json");
    const config = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { workspace: path.join(root, "workspace") },
      },
      plugins: { enabled: false },
      logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "fixture.log") },
    };
    await writeJson(configPath, config);
    const before = digest(await fs.readFile(configPath));
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
    const row = {
      id: test.id,
      kind: test.kind,
      argv: [path.join(target, "openclaw.mjs"), ...test.argv],
      config,
      configPath,
      before,
      envKeys: Object.keys(env).sort(),
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
        args: row.argv,
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
      row.after = digest(await fs.readFile(configPath));
      await writeJson(path.join(evidence, "observations.json"), observations);
    }
    assert.equal(row.after, before, `${test.id}: authored config changed`);
    assert.equal(row.managedJoined, true);
    assert.equal(row.outputLimitExceeded ?? false, false);
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    const all = `${out}\n${err}`;
    if (test.kind === "owner") {
      assert.equal(row.exit, 1);
      assert.equal(
        all.split(genericError).length - 1,
        1,
        `${test.id}: exact baseline owner diagnostic missing/repeated`,
      );
      assert(!all.includes("message CLI has no explicit owner"));
      row.observedOwnerDiagnostic = genericError;
    } else if (test.kind === "help") {
      assert.equal(row.exit, 0);
      assert(out.includes(test.usage), `${test.id}: wrong help surface`);
      assert(
        !/^\s+(?:-[A-Za-z],\s*)?--agent(?:\s|[=<])/m.test(out),
        "Unsupported --agent appeared in help options",
      );
      assert(!all.includes("has no explicit owner"));
    } else {
      assert.equal(test.kind, "unsupported");
      assert.equal(row.exit, 1);
      assert.equal(all.split("unknown option '--agent'").length - 1, 1);
      assert(!all.includes("has no explicit owner"), "Unknown option reached owner resolution");
    }
    row.accepted = true;
    await writeJson(path.join(evidence, "observations.json"), observations);
    process.stdout.write(`${JSON.stringify({ id: row.id, exit: row.exit, accepted: true })}\n`);
  }
  assert.equal(observations.length, 8);
  assert.equal(observations.filter((row) => row.kind === "owner").length, 3);
  assert.equal(observations.filter((row) => row.kind === "help").length, 3);
  assert.equal(observations.filter((row) => row.kind === "unsupported").length, 2);
  assert(observations.every((row) => row.accepted && row.managedJoined));
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
      "Three ambiguous-owner diagnostics, three help surfaces and two unsupported-selector controls; no configured channel/plugin/credential, no remedy execution or successful message action.",
  });
}
