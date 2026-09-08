import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkOutput, uninstallRow, oldDescription, newDescription } from "./read-output.mjs";
import { auditSource, git, hash, inventoryBuild, read, writeJson } from "./source-audit.mjs";

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
  phases: {},
  pendingGates: [
    "focused owner tests",
    "explicit-base changed checks",
    "independent code review",
    "required PR CI",
    "native landing",
  ],
};
let phase = "baseline";
let patched = false;
let unjoinedWork = false;
let latestBuild;
let supervisor;
fs.mkdirSync(evidence, { recursive: true });
const save = (name, value) => writeJson(path.join(evidence, name), value);
const audit = (label) => {
  const value = auditSource(target, lane, packet, packetHash, patched ? "candidate" : "baseline");
  save(`${label}.json`, value);
  return value;
};

function authoredInputs(root) {
  const files = [
    "home/input-marker.txt",
    "state/openclaw.json",
    "state/workspace/input-marker.txt",
  ];
  return Object.fromEntries(
    files.map((file) => {
      assert(fs.lstatSync(path.join(root, file)).isFile(), file);
      return [file, hash(read(path.join(root, file)))];
    }),
  );
}

function observeState(root) {
  const rows = [];
  function visit(dir) {
    for (const entry of fs
      .readdirSync(path.join(root, dir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      assert(rows.length < 10_000, "Unexpectedly large owned state inventory");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        rows.push([file, "directory"]);
        visit(file);
      } else if (entry.isFile()) rows.push([file, "file", fs.statSync(path.join(root, file)).size]);
      else if (entry.isSymbolicLink())
        rows.push([
          file,
          "symlink",
          fs.readlinkSync(path.join(root, file), { encoding: "buffer" }).toString("base64"),
        ]);
      else rows.push([file, "other"]);
    }
  }
  visit("");
  return rows;
}

async function command(id, bin, args, timeoutMs, maxOutputBytes, isCli = false) {
  const directory = path.join(evidence, id);
  fs.mkdirSync(directory);
  const owned = fs.mkdtempSync(path.join(directory, "owned-"));
  for (const name of ["home", "state/workspace", "config", "cache", "data", "tmp"])
    fs.mkdirSync(path.join(owned, name), { recursive: true });
  fs.writeFileSync(path.join(owned, "home/input-marker.txt"), "synthetic home input\n", {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(owned, "state/workspace/input-marker.txt"),
    "synthetic workspace input\n",
    { flag: "wx" },
  );
  const configFile = path.join(owned, "state/openclaw.json");
  const config = { agents: { defaults: { workspace: path.join(owned, "state/workspace") } } };
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  const env = {
    PATH: isCli ? `${path.dirname(process.execPath)}:/usr/bin:/bin` : process.env.PATH,
    CI: process.env.CI,
    HOME: path.join(owned, "home"),
    OPENCLAW_HOME: path.join(owned, "home"),
    OPENCLAW_STATE_DIR: path.join(owned, "state"),
    OPENCLAW_CONFIG_PATH: configFile,
    XDG_CONFIG_HOME: path.join(owned, "config"),
    XDG_CACHE_HOME: path.join(owned, "cache"),
    XDG_DATA_HOME: path.join(owned, "data"),
    TMPDIR: path.join(owned, "tmp"),
    TMP: path.join(owned, "tmp"),
    TEMP: path.join(owned, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  const row = {
    id,
    phase,
    bin,
    args,
    cwd: target,
    env,
    timeoutMs,
    maxOutputBytes,
    config,
    authoredBefore: authoredInputs(owned),
    startedAt: new Date().toISOString(),
    joined: false,
    outputBytes: 0,
    stdoutEnded: false,
    stderrEnded: false,
  };
  result.commands.push(row);
  const streams = { stdout: [], stderr: [] };
  const abort = new AbortController();
  let primaryError;
  try {
    row.exit = await supervisor.runManagedCommand({
      bin,
      args,
      cwd: target,
      env,
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
        for (const name of ["stdout", "stderr"]) {
          child[name].once("end", () => {
            row[`${name}Ended`] = true;
          });
          child[name].on("data", (chunk) => {
            row.outputBytes += chunk.length;
            if (row.outputBytes > maxOutputBytes) {
              row.outputLimitExceeded = true;
              abort.abort();
            } else streams[name].push(chunk);
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
    row.finishedAt = new Date().toISOString();
    try {
      for (const name of ["stdout", "stderr"]) {
        const bytes = Buffer.concat(streams[name]);
        fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx" });
        row[`${name}Sha256`] = hash(bytes);
      }
      if (row.joined) {
        row.authoredAfter = authoredInputs(owned);
        row.stateAfter = observeState(owned);
        assert.deepEqual(row.authoredAfter, row.authoredBefore, "Authored CLI inputs changed");
      }
    } catch (error) {
      primaryError ??= error;
      row.captureOrPreservationFailed = true;
    }
    if (row.joined) {
      try {
        fs.rmSync(owned, { recursive: true });
        assert.equal(fs.existsSync(owned), false);
        row.ownedStateRemoved = true;
      } catch (error) {
        primaryError ??= error;
        row.stateCleanupFailed = true;
      }
    } else row.retainedOwnedState = owned;
    save("commands.json", result.commands);
  }
  if (primaryError) throw primaryError;
  assert.equal(row.outputLimitExceeded ?? false, false);
  assert.equal(row.exit, 0, id);
  assert.equal(row.childExitCode, 0, id);
  assert.equal(row.childExitSignal, null, id);
  assert(row.stdoutEnded && row.stderrEnded && row.joined && row.ownedStateRemoved, id);
  assert(Number.isSafeInteger(row.pid) && row.pid > 1, id);
  return {
    row,
    stdout: Buffer.concat(streams.stdout).toString("utf8"),
    stderr: Buffer.concat(streams.stderr).toString("utf8"),
  };
}

try {
  assert.equal(packet.source, "d3a2fb0296673d93f6e6e795b0e267c0a22a1f34");
  assert.equal(mode, "compare");
  assert.equal(process.env.PROOF_MODE, mode);
  assert.equal(process.env.PROOF_LANE, packet.lane);
  assert.equal(process.env.PROOF_VARIANT, packet.variant);
  assert.equal(process.env.SOURCE_SHA, packet.source);
  assert.equal(process.env.CI, "1");
  assert.equal(process.platform, "linux");
  assert.equal(process.version, packet.node);
  for (const item of [target, lane, evidence]) assert(path.isAbsolute(item));
  assert(target !== lane && target !== evidence && lane !== evidence);
  assert(!lane.startsWith(`${target}/`) && !evidence.startsWith(`${target}/`));
  assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), packet.pnpm);
  audit("source-before");
  fs.copyFileSync(packetFile, path.join(evidence, "packet.json"));
  fs.copyFileSync(path.join(lane, "candidate.patch"), path.join(evidence, "candidate.patch"));
  supervisor = await import(
    pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
  );
  save("host.json", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    packageManager: packet.packageManager,
  });
  const commanderPackage = path.join(target, "node_modules/commander/package.json");
  const commander = JSON.parse(read(commanderPackage));
  assert.equal(commander.version, "15.0.0");
  save("dependency.json", {
    name: commander.name,
    version: commander.version,
    realPackagePath: fs.realpathSync(commanderPackage),
    files: Object.fromEntries(
      ["package.json", "lib/command.js", "lib/help.js"].map((file) => [
        file,
        hash(read(path.join(target, "node_modules/commander", file))),
      ]),
    ),
  });
  assert.deepEqual(cases, [
    { id: "root-help", argv: ["--help"] },
    { id: "uninstall-help", argv: ["uninstall", "--help"] },
    {
      id: "service-preview",
      argv: ["uninstall", "--service", "--dry-run", "--yes", "--non-interactive"],
    },
  ]);

  for (phase of ["baseline", "candidate"]) {
    if (phase === "candidate") {
      git(target, "apply", "--check", "--index", path.join(lane, "candidate.patch"));
      git(target, "apply", "--index", path.join(lane, "candidate.patch"));
      patched = true;
      audit("source-candidate-indexed");
    }
    const build = await command(
      `${phase}-build`,
      "pnpm",
      ["build"],
      packet.buildTimeoutMs,
      packet.buildOutputLimitBytes,
    );
    audit(`source-${phase}-built`);
    latestBuild = inventoryBuild(target, path.join(evidence, `${phase}-build-inventory.json`));
    const metadata = JSON.parse(read(path.join(target, "dist/cli-startup-metadata.json")));
    assert.equal(
      uninstallRow(metadata.rootHelpText),
      phase === "baseline" ? oldDescription : newDescription,
    );
    fs.copyFileSync(
      path.join(target, "dist/cli-startup-metadata.json"),
      path.join(evidence, `${phase}-cli-startup-metadata.json`),
    );
    const observations = [];
    result.phases[phase] = { buildExit: build.row.exit, accepted: false, observations };
    for (const test of cases) {
      const captured = await command(
        `${phase}-${test.id}`,
        process.execPath,
        [path.join(target, "openclaw.mjs"), ...test.argv],
        packet.cliTimeoutMs,
        packet.cliOutputLimitBytes,
        true,
      );
      const actual = checkOutput(test.id, phase, captured.stdout, captured.stderr, metadata);
      captured.row.outputAccepted = true;
      observations.push({ id: test.id, actual });
      audit(`source-${phase}-${test.id}`);
      const after = inventoryBuild(
        target,
        path.join(evidence, `${phase}-${test.id}-build-inventory.json`),
      );
      assert.equal(after.hash, latestBuild.hash, "Built CLI changed during execution");
      save("commands.json", result.commands);
    }
    result.phases[phase].accepted = true;
    save(`${phase}-observations.json`, result.phases[phase]);
  }
  assert.equal(result.commands.length, 8);
  assert.equal(result.commands.filter((row) => row.outputAccepted).length, 6);
  assert.deepEqual(
    result.phases.baseline.observations[1].actual.flags,
    result.phases.candidate.observations[1].actual.flags,
  );
  assert.deepEqual(
    result.phases.baseline.observations[2].actual.preview,
    result.phases.candidate.observations[2].actual.preview,
  );
  result.outputProofAccepted = true;
} catch (error) {
  unjoinedWork ||= supervisor?.hasUnjoinedWork(error) ?? false;
  result.error = { message: String(error.message), stack: error.stack };
} finally {
  try {
    if (unjoinedWork) {
      result.retainedCandidate = patched;
      result.cleanupUnverified = true;
    } else {
      audit("source-before-restoration");
      if (patched) {
        git(target, "apply", "--check", "--reverse", "--index", path.join(lane, "candidate.patch"));
        git(target, "apply", "--reverse", "--index", path.join(lane, "candidate.patch"));
        patched = false;
      }
      audit("source-final");
      if (latestBuild) {
        const finalBuild = inventoryBuild(
          target,
          path.join(evidence, "final-build-inventory.json"),
        );
        assert.equal(finalBuild.hash, latestBuild.hash);
      }
      result.sourceRestored = true;
    }
  } catch (error) {
    result.restorationError = { message: String(error.message) };
  }
  result.completed =
    result.outputProofAccepted === true &&
    result.sourceRestored === true &&
    !result.cleanupUnverified &&
    !result.error &&
    !result.restorationError;
  save("result.json", result);
  fs.writeFileSync(
    path.join(evidence, "verdict.txt"),
    result.completed ? "OUTPUT_COMPARISON_PASSED\n" : "FAILED\n",
  );
  process.exitCode = result.completed ? 0 : 1;
}
