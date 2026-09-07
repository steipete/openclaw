import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validate } from "./validate.mjs";

const [target, lane, evidence, mode] = process.argv.slice(2);
assert([target, lane, evidence].every((value) => value && path.isAbsolute(value)));
assert(!lane.startsWith(`${target}/`) && !evidence.startsWith(`${target}/`));
assert.equal(mode, "green");
assert.equal(process.env.PROOF_MODE, mode);
assert.equal(process.env.PROOF_LANE, "feishu-103928-ordinary-postfix");
assert.equal(process.env.PROOF_VARIANT, "ordinary-output-and-finalization");
assert.equal(process.env.CI, "1");
assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.20.0");
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => fs.readFileSync(file);
const packetHash = hash(read(path.join(lane, "PACKET.json")));
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
const write = (name, value) =>
  fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
function verifyInputs() {
  assert.equal(hash(read(path.join(lane, "PACKET.json"))), packetHash);
  for (const [file, expected] of Object.entries(packet.files))
    assert.equal(hash(read(path.join(lane, file))), expected, file);
}
verifyInputs();
assert.equal(process.env.SOURCE_SHA, packet.source);
assert.equal(git("rev-parse", "HEAD"), packet.source);
assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
assert.equal(
  JSON.parse(read(path.join(target, "package.json"))).packageManager,
  packet.packageManager,
);
assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), "12.3.4");
fs.mkdirSync(evidence, { recursive: true });
let candidateActive = false;
let unjoinedWork = false;
let completed = false;
let failure;
let functional;
const commands = [];
function sourceReceipt(name) {
  verifyInputs();
  assert.equal(git("rev-parse", "HEAD"), packet.source);
  const expected = { ...packet.sourceHashes, ...(candidateActive ? packet.candidateHashes : {}) };
  const actual = {};
  for (const [file, value] of Object.entries(expected)) {
    actual[file] = hash(read(path.join(target, file)));
    assert.equal(actual[file], value, file);
  }
  assert.equal(git("ls-files", "--others", "--exclude-standard"), "");
  assert.deepEqual(
    git("diff", "--name-only", packet.source).split("\n").filter(Boolean).sort(),
    candidateActive ? Object.keys(packet.candidateHashes).sort() : [],
  );
  write(name, { source: packet.source, candidateActive, hashes: actual });
}
sourceReceipt("source-before.json");
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
);
async function command(id, bin, args, timeoutMs) {
  const directory = path.join(evidence, id);
  fs.mkdirSync(directory);
  const owned = path.join(directory, "command-state");
  fs.mkdirSync(owned);
  for (const name of ["home", "state", "config", "cache", "data", "tmp", "vitest-fs"])
    fs.mkdirSync(path.join(owned, name));
  const env = {
    PATH: process.env.PATH,
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    HOME: path.join(owned, "home"),
    OPENCLAW_HOME: path.join(owned, "home"),
    OPENCLAW_STATE_DIR: path.join(owned, "state"),
    OPENCLAW_CONFIG_PATH: path.join(owned, "config/openclaw.json"),
    XDG_CONFIG_HOME: path.join(owned, "config"),
    XDG_CACHE_HOME: path.join(owned, "cache"),
    XDG_DATA_HOME: path.join(owned, "data"),
    TMPDIR: path.join(owned, "tmp"),
    TMP: path.join(owned, "tmp"),
    TEMP: path.join(owned, "tmp"),
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(owned, "vitest-fs"),
    OPENCLAW_VITEST_MAX_WORKERS: "2",
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  const row = {
    id,
    bin,
    args,
    normalManagedReturn: false,
    childExitObserved: false,
    childExit: null,
    childSignal: null,
    signals: [],
    bytes: 0,
  };
  commands.push(row);
  const fd = fs.openSync(path.join(directory, "output.log"), "wx");
  const abort = new AbortController();
  let primary;
  try {
    row.exit = await runManagedCommand({
      bin,
      args,
      cwd: target,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      timeoutKillGraceMs: 5_000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal: abort.signal,
      abortKillGraceMs: 5_000,
      onSignal(signal) {
        row.signals.push(signal);
      },
      onReady(child) {
        row.pid = child.pid;
        child.once("exit", (code, signal) => {
          row.childExitObserved = true;
          row.childExit = code;
          row.childSignal = signal;
        });
        for (const stream of [child.stdout, child.stderr]) {
          assert(stream);
          stream.on("data", (chunk) => {
            row.bytes += chunk.length;
            try {
              assert(row.bytes <= 32 * 1024 * 1024, "Command output exceeded32MiB");
              fs.appendFileSync(fd, chunk);
            } catch (error) {
              primary ??= error;
              abort.abort();
            }
          });
        }
      },
    });
    row.normalManagedReturn = true;
  } catch (error) {
    unjoinedWork ||= hasUnjoinedWork(error);
    primary ??= error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      primary ??= error;
    }
    if (!unjoinedWork) {
      try {
        fs.rmSync(owned, { recursive: true });
        assert.equal(fs.existsSync(owned), false);
        row.ownedStateRemoved = true;
      } catch (error) {
        primary ??= error;
      }
    } else row.retainedState = owned;
    if (primary) row.error = String(primary);
    write("commands.json", commands);
  }
  if (primary) throw primary;
  assert.equal(row.normalManagedReturn, true);
  assert.equal(row.childExitObserved, true);
  assert.equal(row.childExit, 0);
  assert.equal(row.childSignal, null);
  assert.equal(row.exit, 0);
  assert.deepEqual(row.signals, []);
  return directory;
}
try {
  for (const [file, input] of Object.entries(packet.candidateFiles))
    fs.writeFileSync(path.join(target, file), read(path.join(lane, input)));
  candidateActive = true;
  sourceReceipt("candidate-before.json");
  git("diff", "--check", packet.source);
  const files = Object.keys(packet.candidateFiles);
  const functionalDirectory = path.join(evidence, "ordinary-tests");
  await command(
    "ordinary-tests",
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "extensions/feishu/src/delivery-trace.test.ts",
      "-t",
      "(?:settles a normal final reply with its accepted card identity|records streaming-happy|records final-only)$",
      "--reporter=verbose",
      "--reporter=json",
      "--reporter=./scripts/lib/vitest-report-capture.mts",
      "--includeTaskLocation",
      `--outputFile.json=${path.join(functionalDirectory, "tests.json")}`,
    ],
    300_000,
  );
  functional = validate(functionalDirectory);
  sourceReceipt("candidate-after-functional.json");
  await command(
    "format",
    path.join(target, "node_modules/.bin/oxfmt"),
    ["--check", "--config", ".oxfmtrc.jsonc", ...files],
    120_000,
  );
  await command(
    "lint",
    process.execPath,
    ["scripts/run-oxlint.mjs", "--tsconfig", "extensions/tsconfig.json", ...files],
    600_000,
  );
  await command(
    "production-types",
    process.execPath,
    [
      "scripts/run-tsgo.mjs",
      "-p",
      "tsconfig.extensions.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/extensions.tsbuildinfo",
    ],
    900_000,
  );
  await command(
    "test-types",
    process.execPath,
    [
      "scripts/run-tsgo.mjs",
      "-p",
      "test/tsconfig/tsconfig.extensions.test.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/extensions-test.tsbuildinfo",
    ],
    900_000,
  );
  await command(
    "changed-plan-only",
    process.execPath,
    ["scripts/check-changed.mjs", "--dry-run", "--base", packet.source, "--", ...files],
    120_000,
  );
  sourceReceipt("candidate-after-static.json");
  completed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
} finally {
  if (!unjoinedWork) {
    try {
      sourceReceipt("candidate-final.json");
    } catch (error) {
      completed = false;
      failure = { ...(failure ?? {}), finalSourceError: error.message };
    }
  } else completed = false;
  write("verdict.json", {
    completed,
    source: packet.source,
    packetHash,
    functional,
    commands,
    unjoinedWork,
    candidateActive,
    failure,
    scope: "ordinary repaired-implementation checks only",
    pausedScenarios: "not-executed-or-claimed-fixed",
    gatewayIngress: "not-run",
    credentialedFeishu: false,
  });
}
if (!completed) throw new Error(`Ordinary postfix checks incomplete: ${JSON.stringify(failure)}`);
console.log("FEISHU_103928_ORDINARY_POSTFIX_COMPLETE");
