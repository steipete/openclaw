import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acceptBaseline, checkCli, checkSnapshot } from "./read-output.mjs";
import { auditSource, hash, inventoryBuild, read, writeJson } from "./source-audit.mjs";

const [target, lane, evidence, mode] = process.argv.slice(2);
const packetFile = path.join(lane, "PACKET.json");
const packetHash = hash(read(packetFile));
const packet = JSON.parse(read(packetFile));
const cases = JSON.parse(read(path.join(lane, "cases.json")));
const result = {
  completed: false,
  source: packet.source,
  packetHash,
  commands: [],
  pendingGates: [
    "candidate adoption",
    "candidate owner/CLI proof",
    "changed checks",
    "reviews",
    "PR CI",
    "native landing",
  ],
};
fs.mkdirSync(evidence, { recursive: true });
const save = (name, value) => writeJson(path.join(evidence, name), value);
let supervisor;
let unjoinedWork = false;
let owned;
let buildInventory;
const audit = (id) => save(id + ".json", auditSource(target, lane, packet, packetHash, "baseline"));

function makeEnvironment(root, isBuild) {
  for (const dir of [
    "home",
    "state",
    "config",
    "cache",
    "data",
    "tmp",
    "workspaces/alpha",
    "workspaces/beta",
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const stateDir = path.join(root, "state");
  const configFile = path.join(stateDir, "openclaw.json");
  const config = {
    plugins: { enabled: false },
    session: { store: path.join(stateDir, "sessions/{agentId}/sessions.json") },
    agents: {
      ownership: "explicit",
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": {}, "openai/gpt-5.4": {} },
      },
      entries: {
        alpha: { workspace: path.join(root, "workspaces/alpha") },
        beta: { workspace: path.join(root, "workspaces/beta") },
      },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  fs.writeFileSync(path.join(root, "home/input-marker.txt"), "Synthetic #124540 home input\n", {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(root, "workspaces/alpha/input-marker.txt"),
    "Synthetic #124540 workspace input\n",
    { flag: "wx" },
  );
  const env = {
    PATH: isBuild ? process.env.PATH : `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CI: "1",
    HOME: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configFile,
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
  return { root, stateDir, configFile, configSha256: hash(read(configFile)), config, env };
}

function authored(environment) {
  return Object.fromEntries(
    ["home/input-marker.txt", "state/openclaw.json", "workspaces/alpha/input-marker.txt"].map(
      (file) => {
        const full = path.join(environment.root, file);
        assert(fs.lstatSync(full).isFile(), file);
        return [file, hash(read(full))];
      },
    ),
  );
}

function stores(snapshot) {
  return snapshot.targets.flatMap((target) =>
    ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const file = target.sqlitePath + suffix;
      if (!fs.existsSync(file)) return { file, present: false };
      assert(fs.lstatSync(file).isFile(), file);
      return { file, present: true, sha256: hash(read(file)) };
    }),
  );
}

async function command(id, bin, args, environment, timeoutMs, limit) {
  const folder = path.join(evidence, id);
  fs.mkdirSync(folder);
  const chunks = { stdout: [], stderr: [] };
  const row = {
    id,
    bin,
    args,
    env: environment.env,
    cwd: target,
    timeoutMs,
    limit,
    startedMs: Date.now(),
    joined: false,
    outputBytes: 0,
    stdoutEnded: false,
    stderrEnded: false,
    authoredBefore: authored(environment),
  };
  result.commands.push(row);
  let primaryError;
  const abort = new AbortController();
  try {
    row.exit = await supervisor.runManagedCommand({
      bin,
      args,
      cwd: target,
      env: environment.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      timeoutKillGraceMs: 5000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal: abort.signal,
      abortKillGraceMs: 5000,
      onReady(child) {
        row.pid = child.pid;
        child.once("exit", (code, signal) => {
          row.childExitCode = code;
          row.childExitSignal = signal;
        });
        for (const stream of ["stdout", "stderr"]) {
          child[stream].once("end", () => {
            row[stream + "Ended"] = true;
          });
          child[stream].on("data", (chunk) => {
            row.outputBytes += chunk.length;
            if (row.outputBytes > limit) {
              row.outputLimitExceeded = true;
              abort.abort();
            } else chunks[stream].push(chunk);
          });
        }
      },
    });
    row.joined = true;
  } catch (error) {
    primaryError = error;
    row.unjoinedWork = supervisor.hasUnjoinedWork(error);
    unjoinedWork ||= row.unjoinedWork;
    row.joined = !row.unjoinedWork;
    row.executionError = {
      message: String(error.message),
      code: error.code,
      processTreeState: error.processTreeState,
    };
  } finally {
    row.finishedMs = Date.now();
    try {
      for (const stream of ["stdout", "stderr"]) {
        const bytes = Buffer.concat(chunks[stream]);
        fs.writeFileSync(path.join(folder, stream), bytes, { flag: "wx" });
        row[stream + "Sha256"] = hash(bytes);
      }
      if (row.joined) {
        row.authoredAfter = authored(environment);
        assert.deepEqual(row.authoredAfter, row.authoredBefore, "Authored files changed");
        row.authoredPreserved = true;
      }
    } catch (error) {
      primaryError ??= error;
      row.captureOrPreservationFailed = true;
    }
    save("commands.json", result.commands);
  }
  if (primaryError) throw primaryError;
  assert.equal(row.outputLimitExceeded ?? false, false);
  assert.equal(row.exit, 0, id);
  assert.equal(row.childExitCode, 0, id);
  assert.equal(row.childExitSignal, null, id);
  assert(row.joined && row.stdoutEnded && row.stderrEnded && row.authoredPreserved, id);
  assert(Number.isSafeInteger(row.pid) && row.pid > 1);
  audit("source-after-" + id);
  return {
    row,
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
  };
}

try {
  assert.equal(mode, "red");
  assert.equal(process.env.PROOF_MODE, mode);
  assert.equal(process.env.PROOF_LANE, packet.lane);
  assert.equal(process.env.PROOF_VARIANT, packet.variant);
  assert.equal(process.env.SOURCE_SHA, packet.source);
  assert.equal(process.env.CI, "1");
  assert.equal(process.platform, "linux");
  assert.equal(process.version, packet.node);
  for (const value of [target, lane, evidence]) assert(path.isAbsolute(value));
  assert(target !== lane && target !== evidence && lane !== evidence);
  assert(!lane.startsWith(target + path.sep) && !evidence.startsWith(target + path.sep));
  assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), packet.pnpm);
  audit("source-before");
  for (const file of ["PACKET.json", ...Object.keys(packet.files)]) {
    const destination = path.join(evidence, "inputs", file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(lane, file), destination);
  }
  supervisor = await import(
    pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts")).href
  );
  save("host.json", {
    node: process.version,
    platform: process.platform,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  });
  owned = fs.mkdtempSync(path.join(evidence, "owned-"));
  const buildEnv = makeEnvironment(path.join(owned, "build"), true);
  await command(
    "build",
    "pnpm",
    ["build"],
    buildEnv,
    packet.buildTimeoutMs,
    packet.buildOutputLimitBytes,
  );
  buildInventory = inventoryBuild(target, path.join(evidence, "build-inventory.json"));
  const environment = makeEnvironment(path.join(owned, "runtime"), false);
  const fixture = {
    stateDir: environment.stateDir,
    configFile: environment.configFile,
    configSha256: environment.configSha256,
  };
  const fixtureFile = path.join(evidence, "fixture.json");
  save("fixture.json", fixture);
  save("config.json", environment.config);
  const fixtureArgs = (id, action) => [
    "--import",
    "./scripts/tsx.mjs",
    path.join(lane, "store-fixture.mjs"),
    target,
    fixtureFile,
    path.join(evidence, id + ".snapshot.json"),
    action,
  ];
  await command(
    "seed",
    process.execPath,
    fixtureArgs("seed", "seed"),
    environment,
    packet.cliTimeoutMs,
    packet.cliOutputLimitBytes,
  );
  const initial = JSON.parse(read(path.join(evidence, "seed.snapshot.json")));
  result.ownerFacts = checkSnapshot(initial, cases);
  const originalStores = stores(initial);
  save("stores-before.json", originalStores);
  assert(
    initial.targets.every((target) =>
      originalStores.some((file) => file.file === target.sqlitePath && file.present),
    ),
  );
  result.cli = [];
  for (const test of cases.commands) {
    const captured = await command(
      test.id,
      process.execPath,
      [path.join(target, "openclaw.mjs"), ...test.argv],
      environment,
      packet.cliTimeoutMs,
      packet.cliOutputLimitBytes,
    );
    const actual = checkCli(
      test,
      captured.stdout,
      captured.stderr,
      cases,
      initial,
      captured.row.startedMs,
      captured.row.finishedMs,
    );
    result.cli.push({ id: test.id, ...actual });
    save(test.id + ".accepted.json", actual);
    const afterCli = stores(initial);
    save(test.id + ".stores.json", afterCli);
    assert.deepEqual(afterCli, originalStores, "Read-only CLI changed session database files");
    const inspectId = "inspect-" + test.id;
    await command(
      inspectId,
      process.execPath,
      fixtureArgs(inspectId, "inspect"),
      environment,
      packet.cliTimeoutMs,
      packet.cliOutputLimitBytes,
    );
    checkSnapshot(
      JSON.parse(read(path.join(evidence, inspectId + ".snapshot.json"))),
      cases,
      initial,
    );
    const afterInspect = stores(initial);
    save(inspectId + ".stores.json", afterInspect);
    assert.deepEqual(
      afterInspect,
      originalStores,
      "Read-only snapshot changed session database files",
    );
    const currentBuild = inventoryBuild(
      target,
      path.join(evidence, test.id + ".build-inventory.json"),
    );
    assert.equal(
      currentBuild.hash,
      buildInventory.hash,
      "Built code changed during read-only execution",
    );
  }
  result.baseline = acceptBaseline([
    ...result.ownerFacts,
    ...result.cli.flatMap((row) => row.facts),
  ]);
  assert.equal(result.baseline.intendedViolations, 8);
  assert.deepEqual(
    result.commands.map((row) => row.id),
    ["build", "seed", "single-agent", "inspect-single-agent", "all-agents", "inspect-all-agents"],
  );
  result.proofAccepted = true;
} catch (error) {
  unjoinedWork ||= supervisor?.hasUnjoinedWork(error) ?? false;
  result.error = { message: String(error.message), stack: error.stack };
} finally {
  try {
    if (unjoinedWork) {
      result.cleanupUnverified = true;
    } else {
      audit("source-final");
      if (buildInventory)
        assert.equal(
          inventoryBuild(target, path.join(evidence, "final-build-inventory.json")).hash,
          buildInventory.hash,
        );
      result.sourceUnchanged = true;
    }
    if (owned && !result.error && result.proofAccepted && result.sourceUnchanged && !unjoinedWork) {
      fs.rmSync(owned, { recursive: true });
      assert.equal(fs.existsSync(owned), false);
      result.ownedStateRemoved = true;
    } else if (owned) result.retainedOwnedState = owned;
  } catch (error) {
    result.finalizationError = String(error.message);
    if (owned) result.retainedOwnedState = owned;
  }
  result.completed =
    result.proofAccepted === true &&
    result.sourceUnchanged === true &&
    result.ownedStateRemoved === true &&
    !result.error &&
    !result.finalizationError &&
    !result.cleanupUnverified;
  save("result.json", result);
  fs.writeFileSync(
    path.join(evidence, "verdict.txt"),
    result.completed ? "EXPECTED_ARCHIVE_PROJECTION_DEFECT_CONFIRMED\n" : "FAILED\n",
  );
  process.exitCode = result.completed ? 0 : 1;
}
