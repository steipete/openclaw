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
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
await fs.mkdir(evidence, { recursive: true });
const owned = await fs.mkdtemp(path.join(os.tmpdir(), "automation-docs-137229-"));
const observations = [];
let completed = false;
let failure;
async function snapshot(root) {
  const entries = [];
  async function visit(relative) {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push([name, "directory"]);
        await visit(name);
      } else if (entry.isFile()) {
        entries.push([name, digest(await fs.readFile(path.join(root, name)))]);
      } else {
        throw new Error(`Unexpected state entry: ${name}`);
      }
    }
  }
  for (const name of ["home", "state", "config", "data"]) await visit(name);
  return entries;
}
try {
  for (const test of cases) {
    assert(["automations", "cron"].includes(test.argv[0]));
    assert.equal(test.argv.at(-1), "--help");
    assert(test.argv.length === 2 || test.argv.length === 3);
    const child = test.argv.length === 3 ? test.argv[1] : undefined;
    assert([undefined, "edit", "update", "zzzzzzzzzz"].includes(child));
    const root = path.join(owned, test.id);
    for (const name of ["home", "state", "config", "cache", "data", "tmp"]) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    const env = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: path.join(root, "home"),
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "config", "openclaw.json"),
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
      argv: [path.join(target, "openclaw.mjs"), ...test.argv],
      expected: test.expected,
      before: await snapshot(root),
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
        timeoutMs: 120_000,
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
              if (outputBytes > 1_000_000) {
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
      row.after = await snapshot(root);
      await writeJson(path.join(evidence, "observations.json"), observations);
    }
    assert.equal(row.managedJoined, true);
    assert.equal(row.outputLimitExceeded ?? false, false);
    assert.equal(row.exit, test.expected.exit, `${test.id}: wrong exit`);
    assert.deepEqual(row.after, row.before, `${test.id}: account/config/state changed`);
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    assert.equal(err, test.expected.stderr, `${test.id}: wrong stderr`);
    if (test.expected.stdout !== undefined) {
      assert.equal(out, test.expected.stdout, `${test.id}: wrong stdout`);
    } else {
      assert(out.includes(test.expected.usage), `${test.id}: missing canonical usage`);
      assert(out.includes(test.expected.description), `${test.id}: missing description`);
      if (test.kind === "parent") {
        const commands = out.split("\nCommands:\n")[1]?.split("\nDocs:")[0];
        assert(commands, `${test.id}: missing Commands section`);
        assert.match(commands, /^\s+edit\s+Edit an automation \(patch fields\)/m);
        assert.doesNotMatch(commands, /^\s+update(?:\s|\[|\|)/m);
      }
    }
    row.accepted = true;
    await writeJson(path.join(evidence, "observations.json"), observations);
    process.stdout.write(`${JSON.stringify({ id: row.id, exit: row.exit, accepted: true })}\n`);
  }
  assert.equal(observations.length, 8);
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
    verdict: completed ? "DOCUMENTED_COMMAND_MISMATCH_CONFIRMED" : "FAILED",
    cases: observations.length,
    failure,
    ownedState: completed ? "removed after all managed joins" : owned,
    scope:
      "Real built CLI help and unknown-child parser only; no automation action, Gateway, provider, or credential use.",
  });
}
