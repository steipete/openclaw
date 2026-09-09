import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nativeOwnershipUncertainty, readReport } from "./read-report.mjs";
import { auditSource, git, hash, read, writeJson } from "./source-audit.mjs";

const [target, lane, evidence, mode] = process.argv.slice(2);
const packetFile = path.join(lane, "PACKET.json");
const packetHash = hash(read(packetFile));
const packet = JSON.parse(read(packetFile));
const cases = JSON.parse(read(path.join(lane, "cases.json")));
const result = {
  completed: false,
  source: packet.source,
  packetHash,
  mode,
  commands: [],
  scope: "real preflight owner only; no update/install/managed-runtime operation",
};
const phase = mode;
let regressionApplied = false;
let candidateApplied = false;
let unjoinedWork = false;
let supervisor;
fs.mkdirSync(evidence, { recursive: true });
const save = (name, value) => writeJson(path.join(evidence, name), value);
const audit = (label) => {
  const value = auditSource(
    target,
    lane,
    packet,
    packetHash,
    candidateApplied ? "green" : regressionApplied ? "red" : "baseline",
  );
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

async function command(id, bin, args, timeoutMs, maxOutputBytes, expectedExit = 0) {
  const directory = path.join(evidence, id);
  fs.mkdirSync(directory);
  const owned = fs.mkdtempSync(path.join(directory, "owned-"));
  for (const name of ["home", "state/workspace", "config", "cache", "data", "tmp", "vitest-fs"])
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
    PATH: process.env.PATH,
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
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(owned, "vitest-fs"),
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
    const capturedOutput = [streams.stdout, streams.stderr]
      .map((chunks) => Buffer.concat(chunks).toString("utf8"))
      .join("\n");
    row.nativeOwnershipDiagnostics = nativeOwnershipUncertainty(capturedOutput);
    row.nativeOwnershipUnverified = row.nativeOwnershipDiagnostics.length > 0;
    row.nativeCompletionUnverified = Boolean(
      row.outputLimitExceeded ||
      row.executionError ||
      !row.joined ||
      !row.stdoutEnded ||
      !row.stderrEnded ||
      row.childExitSignal !== null ||
      row.exit !== expectedExit ||
      row.childExitCode !== expectedExit,
    );
    unjoinedWork ||= row.nativeOwnershipUnverified || row.nativeCompletionUnverified;
    let cleanupPermitted =
      row.joined && !row.nativeOwnershipUnverified && !row.nativeCompletionUnverified;

    try {
      for (const name of ["stdout", "stderr"]) {
        const bytes = Buffer.concat(streams[name]);
        fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx" });
        row[`${name}Sha256`] = hash(bytes);
      }
      if (cleanupPermitted && id === "owner-tests") {
        const logFile = path.join(directory, "combined.log");
        fs.writeFileSync(logFile, capturedOutput, { flag: "wx" });
        try {
          row.ownerReport = readReport(
            path.join(directory, "vitest.json"),
            logFile,
            path.join(target, cases.file),
            cases,
            mode,
          );
        } catch (error) {
          row.nativeCompletionUnverified = true;
          row.reportError = { message: String(error.message) };
          unjoinedWork = true;
          cleanupPermitted = false;
          throw error;
        }
      }
      if (cleanupPermitted) {
        row.authoredAfter = authoredInputs(owned);
        assert.deepEqual(row.authoredAfter, row.authoredBefore, "Authored CLI inputs changed");
      }
    } catch (error) {
      primaryError ??= error;
      row.captureOrPreservationFailed = true;
      row.nativeCompletionUnverified = true;
      unjoinedWork = true;
      cleanupPermitted = false;
    }
    if (cleanupPermitted) {
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
  assert.equal(row.nativeOwnershipUnverified, false, "Native nested resource joins are unverified");
  assert.equal(row.nativeCompletionUnverified, false, "Native completion was not fully observed");
  assert.equal(row.outputLimitExceeded ?? false, false);
  assert.equal(row.exit, expectedExit, id);
  assert.equal(row.childExitCode, expectedExit, id);
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
  assert.equal(mode, "green");
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
  for (const file of ["regression.patch", "candidate.patch", "cases.json"])
    fs.copyFileSync(path.join(lane, file), path.join(evidence, file));
  supervisor = await import(
    pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
  );
  const vitestPackage = path.join(target, "node_modules/vitest/package.json");
  assert.equal(JSON.parse(read(vitestPackage)).version, "5.0.0");
  save("dependency.json", {
    node: process.version,
    pnpm: packet.pnpm,
    vitest: "5.0.0",
    packageSha256: hash(read(vitestPackage)),
    reportOwnerSha256: hash(
      read(path.join(target, "node_modules/vitest/dist/chunks/index.B89dZ0-N.js")),
    ),
  });
  git(target, "apply", "--check", "--index", path.join(lane, "regression.patch"));
  git(target, "apply", "--index", path.join(lane, "regression.patch"));
  regressionApplied = true;
  if (mode === "green") {
    git(target, "apply", "--check", "--index", path.join(lane, "candidate.patch"));
    git(target, "apply", "--index", path.join(lane, "candidate.patch"));
    candidateApplied = true;
  }
  audit("source-overlay");
  const report = path.join(evidence, "owner-tests", "vitest.json");
  const owner = await command(
    "owner-tests",
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      cases.config,
      cases.file,
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    packet.testTimeoutMs,
    packet.testOutputLimitBytes,
    0,
  );
  result.ownerTests = owner.row.ownerReport;
  assert(result.ownerTests);
  save("owner-tests-qualified.json", result.ownerTests);
  audit("source-after-owner-tests");
  if (mode === "green") {
    const checks = await command(
      "changed-checks",
      process.execPath,
      [
        "scripts/check-changed.mjs",
        "--base",
        packet.source,
        "--",
        ...Object.keys({ ...packet.regressionHashes, ...packet.candidateHashes }).sort(),
      ],
      packet.checkTimeoutMs,
      packet.checkOutputLimitBytes,
    );
    result.changedChecks = {
      exit: checks.row.exit,
      joined: checks.row.joined,
      explicitBase: packet.source,
    };
    audit("source-after-checks");
  }
  fs.writeFileSync(
    path.join(evidence, "final-overlay.patch"),
    git(target, "diff", "--cached", "--binary"),
  );
  assert.equal(result.commands.length, 2);
  result.gatesPassed = true;
} catch (error) {
  unjoinedWork ||= supervisor?.hasUnjoinedWork(error) ?? false;
  result.error = { message: String(error.message), stack: error.stack };
} finally {
  try {
    if (unjoinedWork) {
      result.cleanupUnverified = true;
      result.retainedOverlay = { regressionApplied, candidateApplied };
    } else {
      audit("source-before-restoration");
      if (candidateApplied) {
        git(target, "apply", "--check", "--reverse", "--index", path.join(lane, "candidate.patch"));
        git(target, "apply", "--reverse", "--index", path.join(lane, "candidate.patch"));
        candidateApplied = false;
      }
      if (regressionApplied) {
        git(
          target,
          "apply",
          "--check",
          "--reverse",
          "--index",
          path.join(lane, "regression.patch"),
        );
        git(target, "apply", "--reverse", "--index", path.join(lane, "regression.patch"));
        regressionApplied = false;
      }
      audit("source-final");
      result.sourceRestored = true;
    }
  } catch (error) {
    result.restorationError = { message: String(error.message) };
  }
  result.completed =
    result.gatesPassed === true &&
    result.sourceRestored === true &&
    !result.cleanupUnverified &&
    !result.error &&
    !result.restorationError;
  save("result.json", result);
  fs.writeFileSync(
    path.join(evidence, "verdict.txt"),
    result.completed ? `NODE_ENGINE_GUIDANCE_${mode.toUpperCase()}_CONFIRMED\n` : "FAILED\n",
  );
  process.exitCode = result.completed ? 0 : 1;
}
