import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const [targetDir, evidenceDir, mode] = process.argv.slice(2);
assert.ok(path.isAbsolute(targetDir) && path.isAbsolute(evidenceDir));
assert.equal(mode, "green");
assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.20.0");
const source = "72913f02470db00da7cf00cf6f0470bf23269b6d";
const observed = { source, mode, phase: "prepare", processes: [], cleanupFailures: [] };
let abortActive;
const forwardSignal = (signal) => {
  observed.interrupted ??= signal;
  abortActive?.();
};
const signalHandlers = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [signal, () => forwardSignal(signal)]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const scratch = mkdtempSync(path.join(os.tmpdir(), "daemon-label-140547-"));
const prepHome = path.join(scratch, "prepare-home");
const proofHome = path.join(scratch, "operator-home");
const work = path.join(scratch, "work");
for (const dir of [prepHome, proofHome, work, path.join(scratch, "tmp")]) mkdirSync(dir);
mkdirSync(evidenceDir, { recursive: true });
const save = (name, value) => writeFileSync(path.join(evidenceDir, name), value);
const saveJson = (name, value) => save(name, `${JSON.stringify(value, null, 2)}\n`);
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const npmUserConfig = path.join(prepHome, "user.npmrc");
const npmGlobalConfig = path.join(prepHome, "global.npmrc");
writeFileSync(npmUserConfig, "");
writeFileSync(npmGlobalConfig, "");
const prepEnv = {
  PATH: process.env.PATH,
  HOME: prepHome,
  USERPROFILE: prepHome,
  XDG_CONFIG_HOME: path.join(prepHome, "config"),
  TMPDIR: path.join(scratch, "tmp"),
  CI: "1",
  NO_COLOR: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
  DO_NOT_TRACK: "1",
  NPM_CONFIG_USERCONFIG: npmUserConfig,
  NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
};

async function run(
  name,
  command,
  args,
  { env = prepEnv, cwd = work, timeout = 120_000, limit = 8 * 1024 * 1024 } = {},
) {
  assert.equal(observed.interrupted, undefined, "driver interrupted before process launch");
  const result = {
    name,
    command,
    args,
    cwd,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    processError: null,
    timedOut: false,
    outputLimit: false,
    residualGroup: false,
  };
  observed.processes.push(result);
  const output = await new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let forceTimer;
    let terminationRequested = false;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") result.processError ??= error.message;
      }
    };
    const groupExists = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error.code !== "ESRCH") result.processError ??= error.message;
        return error.code !== "ESRCH";
      }
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      signalGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        result.forcedTermination = true;
        signalGroup("SIGKILL");
      }, 10_000);
    };
    abortActive = () => {
      result.interrupted = observed.interrupted;
      terminate();
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, timeout);
    const capture = (stream, chunk) => {
      const available = Math.max(0, limit - bytes);
      if (available > 0) chunks[stream].push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > limit) {
        result.outputLimit = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => {
      result.processError = error.message;
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      abortActive = undefined;
      result.exitCode = code;
      result.signal = signal;
      result.finishedAt = new Date().toISOString();
      if (groupExists()) {
        result.residualGroup = true;
        signalGroup("SIGTERM");
        await new Promise((settle) => setTimeout(settle, 10_000));
        if (groupExists()) {
          result.forcedTermination = true;
          signalGroup("SIGKILL");
        }
      }
      const stdoutBytes = Buffer.concat(chunks.stdout);
      const stderrBytes = Buffer.concat(chunks.stderr);
      resolve({
        stdoutBytes,
        stderrBytes,
        stdout: stdoutBytes.toString("utf8"),
        stderr: stderrBytes.toString("utf8"),
      });
    });
  });
  save(`${name}.stdout.log`, output.stdoutBytes);
  save(`${name}.stderr.log`, output.stderrBytes);
  saveJson(`${name}.process.json`, result);
  assert.equal(result.interrupted, undefined, `${name}: interrupted`);
  assert.equal(result.processError, null, `${name}: process error`);
  assert.equal(result.signal, null, `${name}: signal`);
  assert.equal(result.timedOut, false, `${name}: timeout`);
  assert.equal(result.outputLimit, false, `${name}: output bound`);
  assert.equal(result.residualGroup, false, `${name}: child group did not finish`);
  assert.equal(typeof result.exitCode, "number", `${name}: missing normal exit`);
  return { ...output, result };
}

let failure;
try {
  const build = await run("build", "pnpm", ["build"], {
    cwd: targetDir,
    timeout: 45 * 60_000,
    limit: 64 * 1024 * 1024,
  });
  assert.equal(build.result.exitCode, 0, "normal build must pass");
  const buildInfo = JSON.parse(readFileSync(path.join(targetDir, "dist/build-info.json"), "utf8"));
  assert.equal(buildInfo.commit, source, "built artifact source binding");
  observed.buildInfo = buildInfo;
  const entry = path.join(targetDir, "openclaw.mjs");
  observed.entry = {
    path: entry,
    sha256: hash(readFileSync(entry)),
    kind: "built-checkout-declared-bin",
  };
  observed.limitation =
    "Fresh HOME is a nondefault install identity, so both cases are diagnostic-only independently of --port. Only the observed stopped/unknown service state is proved; no running service, native-target control or failed remote probe is claimed.";
  const configPath = path.join(proofHome, "openclaw.json");
  const config = {
    gateway: { mode: "local", port: 19001, controlUi: { enabled: false } },
    update: { checkOnStart: false },
  };
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(configPath, configBytes);
  save("initial-config.json", configBytes);
  const cliEnv = {
    PATH: prepEnv.PATH,
    HOME: proofHome,
    USERPROFILE: proofHome,
    XDG_CONFIG_HOME: path.join(proofHome, "config"),
    TMPDIR: prepEnv.TMPDIR,
    CI: "1",
    NO_COLOR: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: path.join(proofHome, "state"),
  };
  const cli = async (name, args) => {
    const before = readFileSync(configPath);
    save(`${name}.config-before.json`, before);
    const output = await run(name, process.execPath, [entry, ...args], { env: cliEnv });
    const after = readFileSync(configPath);
    save(`${name}.config-after.json`, after);
    assert.equal(output.result.exitCode, 0, `${name}: ordinary CLI exit`);
    assert.deepEqual(before, configBytes, `${name}: expected fixture config`);
    assert.deepEqual(after, before, `${name}: status must not modify config`);
    assert.doesNotMatch(
      output.stderr,
      /UnhandledPromiseRejection|uncaught exception|unhandled rejection/i,
      `${name}: unexpected runtime failure`,
    );
    return output;
  };
  observed.cases = [];
  for (const [name, portArgs, port, portSource] of [
    ["relocated-home", [], 19001, "env/config"],
    ["explicit-port", ["--port", "19002"], 19002, "cli"],
  ]) {
    observed.phase = `${name}-json-control`;
    const args = ["gateway", "status", ...portArgs, "--no-probe"];
    const jsonRun = await cli(`${name}-json`, [...args, "--json"]);
    const status = JSON.parse(jsonRun.stdout);
    saveJson(`${name}.json`, status);
    assert.equal(status.config.cli.path, configPath);
    assert.equal(status.config.cli.valid, true);
    assert.equal(status.config.cli.exists, true);
    assert.equal(status.service.targetRole, "diagnostic-only");
    assert.equal(status.service.command, null, "fixture must not inspect an installed service");
    assert.ok(
      ["not-loaded", "unknown"].includes(status.service.loadState.status),
      "loaded native services are outside this fixture",
    );
    assert.equal(
      status.service.loaded,
      status.service.loadState.status === "unknown" ? null : false,
    );
    assert.ok(
      ["stopped", "unknown"].includes(status.service.runtime?.status),
      "only observed unavailable/stopped runtime is in scope",
    );
    assert.equal(Object.hasOwn(status, "rpc"), false, "--no-probe must omit RPC result");
    assert.equal(status.gateway.port, port);
    assert.equal(status.gateway.portSource, portSource);
    assert.equal(status.gateway.probeUrl, `ws://127.0.0.1:${port}`);
    observed.phase = `${name}-human`;
    const human = await cli(`${name}-human`, args);
    const text = stripVTControlCharacters(`${human.stdout}\n${human.stderr}`);
    save(`${name}.normalized.log`, text);
    const lines = text.split(/\r?\n/);
    const serviceLines = lines.filter((line) => line.startsWith("Service:"));
    const runtimeLines = lines.filter((line) => line.startsWith("Runtime:"));
    assert.equal(serviceLines.length, 1, "exactly one Service line");
    assert.equal(runtimeLines.length, 1, "exactly one Runtime line");
    const serviceState =
      status.service.loadState.status === "unknown" ? "unknown" : status.service.notLoadedText;
    assert.equal(
      serviceLines[0],
      `Service: ${status.service.label} (${serviceState}) (diagnostic only, not the probe target)`,
      "candidate service text preserves recorded load state and labels its diagnostic role",
    );
    assert.ok(
      runtimeLines[0] === `Runtime: ${status.service.runtime.status}` ||
        runtimeLines[0].startsWith(`Runtime: ${status.service.runtime.status} (`),
      "runtime text must agree with observed native status",
    );
    const qualifier = "(diagnostic only, not the probe target)";
    assert.equal(
      serviceLines[0].includes(qualifier),
      true,
      "SERVICE_LABEL_140547: candidate Service must display recorded diagnostic role",
    );
    assert.equal(
      runtimeLines[0].endsWith(` ${qualifier}`),
      true,
      "SERVICE_LABEL_140547: candidate Runtime must display recorded diagnostic role",
    );
    assert.equal(
      runtimeLines[0].split(qualifier).length,
      2,
      "runtime qualifier must appear exactly once",
    );
    observed.cases.push({
      name,
      role: status.service.targetRole,
      loadState: status.service.loadState,
      runtime: status.service.runtime,
      selectedPort: port,
      portSource,
      serviceLine: serviceLines[0],
      runtimeLine: runtimeLines[0],
    });
  }
  observed.phase = "green-confirmed";
} catch (error) {
  failure = error;
  observed.failure = { name: error.name, message: error.message };
} finally {
  const uncertainTeardown =
    Boolean(observed.interrupted) ||
    observed.processes.some(
      (entry) =>
        entry.timedOut ||
        entry.outputLimit ||
        entry.signal ||
        entry.processError ||
        entry.residualGroup ||
        entry.forcedTermination,
    );
  if (uncertainTeardown)
    observed.cleanupFailures.push({
      path: scratch,
      message:
        "Retained owned roots: abnormal process termination cannot prove detached descendants settled.",
    });
  else {
    try {
      rmSync(scratch, { recursive: true });
    } catch (error) {
      observed.cleanupFailures.push({ path: scratch, message: error.message });
    }
  }
  observed.cleanupFailureCount = observed.cleanupFailures.length;
  saveJson("observed.json", observed);
}
for (const [signal, handler] of signalHandlers) process.off(signal, handler);
if (failure) throw failure;
assert.equal(observed.interrupted, undefined, "driver interrupted");
assert.equal(observed.cleanupFailureCount, 0, "owned fixture cleanup must succeed");
console.log("SERVICE_LABEL_140547_REAL_CLI_GREEN_CONFIRMED");
