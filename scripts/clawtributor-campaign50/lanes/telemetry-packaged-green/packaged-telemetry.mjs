import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const [targetDir, evidenceDir, mode] = process.argv.slice(2);
assert.ok(path.isAbsolute(targetDir) && path.isAbsolute(evidenceDir));
assert.equal(mode, "green");
assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.20.0");
const source = "b8cbece8fb8de577d9ff33cedf8d8250585c55e4";
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
const scratch = mkdtempSync(path.join(os.tmpdir(), "telemetry-140283-"));
const prepHome = path.join(scratch, "prepare-home");
const proofHome = path.join(scratch, "operator-home");
const prefix = path.join(scratch, "install");
const work = path.join(scratch, "work");
for (const dir of [prepHome, proofHome, prefix, work, path.join(scratch, "tmp")]) mkdirSync(dir);
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
  const packageDir = path.join(evidenceDir, "package");
  mkdirSync(packageDir);
  const tarball = path.join(packageDir, "openclaw-telemetry-140283.tgz");
  const pack = await run(
    "pack",
    process.execPath,
    [
      path.join(targetDir, "scripts/package-openclaw-for-docker.mjs"),
      "--output-dir",
      packageDir,
      "--output-name",
      path.basename(tarball),
      "--pack-json",
      path.join(evidenceDir, "pack.json"),
      "--allow-unreleased-changelog",
    ],
    { cwd: targetDir, timeout: 45 * 60_000, limit: 64 * 1024 * 1024 },
  );
  assert.equal(pack.result.exitCode, 0, "canonical package preparation must pass");
  const tarBytes = readFileSync(tarball);
  const receipts = JSON.parse(readFileSync(path.join(evidenceDir, "pack.json"), "utf8"));
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  assert.equal(receipt.name, "openclaw");
  assert.equal(receipt.version, "2026.9.2");
  assert.equal(receipt.filename, path.basename(tarball));
  assert.equal(receipt.integrity, `sha512-${hash(tarBytes, "sha512", "base64")}`);
  assert.equal(receipt.shasum, hash(tarBytes, "sha1"));
  assert.ok(receipt.files.some((file) => file.path === "openclaw.mjs"));
  assert.ok(receipt.files.some((file) => file.path === "dist/build-info.json"));
  assert.equal(
    receipt.files.some((file) => file.path === "src/entry.ts" || file.path.startsWith(".git/")),
    false,
  );
  observed.tarball = {
    path: tarball,
    sha256: hash(tarBytes),
    integrity: receipt.integrity,
    entryCount: receipt.files.length,
  };
  saveJson("tarball.json", observed.tarball);
  const install = await run(
    "install",
    "npm",
    ["install", "--global", "--prefix", prefix, tarball, "--no-fund", "--no-audit"],
    { timeout: 20 * 60_000, limit: 32 * 1024 * 1024 },
  );
  assert.equal(install.result.exitCode, 0, "normal package install must pass");
  const dependencyList = await run(
    "installed-dependencies",
    "npm",
    ["ls", "--global", "--prefix", prefix, "--all", "--json"],
    { timeout: 120_000, limit: 32 * 1024 * 1024 },
  );
  assert.equal(dependencyList.result.exitCode, 0, "installed dependency graph must be healthy");
  const dependencies = JSON.parse(dependencyList.stdout);
  saveJson("installed-dependencies.json", dependencies);
  assert.equal(dependencies.dependencies.openclaw.dependencies.commander.version, "15.0.0");
  assert.equal(
    dependencies.dependencies.openclaw.dependencies["@openclaw/proxyline"].version,
    "0.3.7",
  );
  observed.nativeBaseDifference =
    "This candidate is built from native parent b8c with proxyline0.3.7; the accepted baseline package was0a55 with proxyline0.3.11. Telemetry policy bypasses proxy lifecycle in both.";
  const installedRoot = path.join(prefix, "lib/node_modules/openclaw");
  const manifest = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, receipt.name);
  assert.equal(manifest.version, receipt.version);
  assert.equal(manifest.bin.openclaw, "openclaw.mjs");
  const bin = path.join(prefix, "bin/openclaw");
  assert.equal(realpathSync(bin), path.join(installedRoot, manifest.bin.openclaw));
  assert.equal(existsSync(path.join(installedRoot, ".git")), false);
  assert.equal(existsSync(path.join(installedRoot, "src/entry.ts")), false);
  const buildInfo = JSON.parse(
    readFileSync(path.join(installedRoot, "dist/build-info.json"), "utf8"),
  );
  assert.equal(buildInfo.commit, source);
  assert.equal(buildInfo.version, manifest.version);
  const fileHashes = {};
  for (const relative of ["openclaw.mjs", "dist/build-info.json"]) {
    const packed = await run(`archive-${path.basename(relative)}`, "tar", [
      "-xOf",
      tarball,
      `package/${relative}`,
    ]);
    assert.equal(packed.result.exitCode, 0);
    const installed = readFileSync(path.join(installedRoot, relative));
    assert.equal(
      hash(installed),
      hash(packed.stdoutBytes),
      `${relative}: installed bytes must match archive`,
    );
    fileHashes[relative] = hash(installed);
  }
  observed.installed = {
    prefix,
    root: installedRoot,
    bin,
    manifestVersion: manifest.version,
    buildInfo,
    fileHashes,
  };
  saveJson("installed.json", observed.installed);

  const configPath = path.join(proofHome, "openclaw.json");
  const initial = {
    meta: { lastTouchedVersion: manifest.version, migrations: { modelPolicyAllowlist: true } },
    update: { checkOnStart: false },
    telemetry: { enabled: false, consentedAt: "2026-09-01T00:00:00.000Z" },
  };
  writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`);
  saveJson("initial-config.json", initial);
  const cliEnv = {
    PATH: prepEnv.PATH,
    HOME: proofHome,
    USERPROFILE: proofHome,
    XDG_CONFIG_HOME: path.join(proofHome, "config"),
    TMPDIR: prepEnv.TMPDIR,
    CI: "1",
    NO_COLOR: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    DO_NOT_TRACK: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: path.join(proofHome, "state"),
  };
  const cli = async (name, args, mutate = false) => {
    const before = readFileSync(configPath);
    save(`${name}.config-before.json`, before);
    const output = await run(name, bin, args, { env: cliEnv });
    const after = readFileSync(configPath);
    save(`${name}.config-after.json`, after);
    if (!mutate) assert.deepEqual(after, before, `${name}: config changed`);
    assert.doesNotMatch(
      output.stderr,
      /unhandled|uncaught|(?:^|\n)\s*(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|AggregateError):/i,
      `${name}: unexpected runtime failure`,
    );
    return output;
  };
  const version = await cli("version", ["--version"]);
  assert.equal(version.result.exitCode, 0);
  assert.equal(version.stdout, `OpenClaw ${manifest.version} (${source.slice(0, 7)})\n`);
  assert.equal(version.stderr, "");
  const expectedBanner = `OpenClaw ${manifest.version} (${source.slice(0, 7)}) — All your chats, one OpenClaw.`;
  const helpBlock = (text, usage) => {
    const start = text.indexOf(`Usage: ${usage}`);
    assert.ok(start >= 0, `missing help Usage: ${usage}`);
    const prefixText = text.slice(0, start).trim();
    assert.ok(prefixText === "" || prefixText === expectedBanner, "unexpected text before help");
    return text.slice(start);
  };
  observed.phase = "controls";
  const help = await cli("explicit-help", ["telemetry", "--help"]);
  assert.equal(help.result.exitCode, 0);
  assert.equal(help.stderr, "");
  const parentHelp = helpBlock(help.stdout, "openclaw telemetry [options] [command]");
  assert.match(parentHelp, /Inspect and manage anonymous usage telemetry/);
  const rows = parentHelp
    .split("Commands:\n")[1]
    ?.trim()
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "));
  assert.deepEqual(rows, [
    "help Display help for command",
    "off Disable anonymous feature statistics",
    "on Enable anonymous feature statistics",
    "show Show exactly what the daily update request sends",
  ]);
  const parentAlias = await cli("help-command", ["telemetry", "help"]);
  assert.equal(parentAlias.result.exitCode, 0);
  assert.equal(parentAlias.stderr, "");
  assert.equal(helpBlock(parentAlias.stdout, "openclaw telemetry [options] [command]"), parentHelp);
  const showHelp = await cli("show-help", ["telemetry", "show", "--help"]);
  const showHelpAlias = await cli("help-show", ["telemetry", "help", "show"]);
  for (const output of [showHelp, showHelpAlias]) {
    assert.equal(output.result.exitCode, 0);
    assert.equal(output.stderr, "");
  }
  assert.equal(
    helpBlock(showHelp.stdout, "openclaw telemetry show [options]"),
    helpBlock(showHelpAlias.stdout, "openclaw telemetry show [options]"),
  );
  assert.match(showHelp.stdout, /--json/);
  const unknownFlag = await cli("unknown-flag", ["telemetry", "--not-a-real-option"]);
  assert.equal(unknownFlag.result.exitCode, 1);
  assert.equal(unknownFlag.stdout, "");
  assert.match(unknownFlag.stderr, /OpenClaw does not recognize option "--not-a-real-option"\./);
  const unknownCommand = await cli("unknown-command", ["telemetry", "not-a-real-command"]);
  assert.equal(unknownCommand.result.exitCode, 1);
  assert.equal(unknownCommand.stdout, "");
  assert.match(unknownCommand.stderr, /OpenClaw telemetry has no command "not-a-real-command"\./);
  const verifyShow = async (name) => {
    const output = await cli(name, ["telemetry", "show", "--json"]);
    assert.equal(output.result.exitCode, 0);
    assert.equal(output.stderr, "");
    const json = JSON.parse(output.stdout);
    assert.deepEqual(json, {
      featureStatsEnabled: false,
      reason: "automated-environment",
      endpoint: "https://telemetry.openclaw.ai/api/latest-version",
      lastPingAt: null,
      request: null,
    });
    saveJson(`${name}.json`, json);
  };
  await verifyShow("show-before");
  for (const [name, enabled] of [
    ["on", true],
    ["off", false],
  ]) {
    const output = await cli(`consent-${name}`, ["telemetry", name], true);
    assert.equal(output.result.exitCode, 0);
    assert.match(
      output.stdout,
      new RegExp(`Anonymous feature stats ${enabled ? "enabled" : "disabled"}\\.`),
    );
    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(updated.telemetry.enabled, enabled);
    const time = Date.parse(updated.telemetry.consentedAt);
    assert.ok(
      Number.isFinite(time) &&
        time >= Date.parse(output.result.startedAt) &&
        time <= Date.parse(output.result.finishedAt),
      "consent timestamp belongs to invocation",
    );
    assert.deepEqual(
      { ...updated, telemetry: initial.telemetry },
      initial,
      "non-telemetry config preserved",
    );
    assert.deepEqual(Object.keys(updated.telemetry).sort(), ["consentedAt", "enabled"]);
    await verifyShow(`show-after-${name}`);
  }
  observed.phase = "bare-telemetry";
  const bare = await cli("bare-telemetry", ["telemetry"]);
  assert.equal(
    bare.result.exitCode,
    0,
    "TELEMETRY_PARENT_140283: candidate bare help must succeed",
  );
  assert.equal(bare.stderr, "");
  assert.equal(
    bare.stdout,
    parentHelp,
    "candidate canonical parent help omits startup banner and preserves complete help",
  );
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
  if (uncertainTeardown) {
    observed.cleanupFailures.push({
      path: scratch,
      message:
        "Retained owned roots: abnormal process termination cannot prove detached descendants settled.",
    });
  } else {
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
console.log("TELEMETRY_PARENT_140283_PACKAGED_GREEN_CONFIRMED");
