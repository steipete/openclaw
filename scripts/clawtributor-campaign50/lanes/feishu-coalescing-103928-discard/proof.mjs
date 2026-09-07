import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateRetained } from "./validate-retained.mjs";
import { validate } from "./validate.mjs";

const [target, lane, evidence, mode] = process.argv.slice(2);
assert([target, lane, evidence].every((value) => value && path.isAbsolute(value)));
assert(!lane.startsWith(`${target}/`) && !evidence.startsWith(`${target}/`));
assert.equal(mode, "baseline");
assert.equal(process.env.PROOF_MODE, mode);
assert.equal(process.env.PROOF_LANE, "feishu-coalescing-103928-discard");
assert.equal(process.env.PROOF_VARIANT, "remaining-discard-control");
assert.equal(process.env.CI, "1");
assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.20.0");
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const read = (file) => fs.readFileSync(file);
const write = (name, value) =>
  fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
const packetHash = hash(read(path.join(lane, "PACKET.json")));
const verifyInputs = () => {
  assert.equal(hash(read(path.join(lane, "PACKET.json"))), packetHash);
  for (const [name, expected] of Object.entries(packet.files))
    assert.equal(hash(read(path.join(lane, name))), expected, name);
};
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
const tracePath = "extensions/feishu/src/delivery-trace.test.ts";
const original = read(path.join(target, tracePath));
const overlay = read(path.join(lane, "delivery-trace.test.ts"));
let overlayActive = false;
let unjoinedWork = false;
let completed = false;
let failure;
const command = {
  normalManagedReturn: false,
  captureBytes: 0,
  childExit: null,
  childSignal: null,
  childExitObserved: false,
  signals: [],
};
const sourceReceipt = (name) => {
  verifyInputs();
  assert.equal(git("rev-parse", "HEAD"), packet.source);
  const hashes = {};
  for (const [file, expected] of Object.entries(packet.sourceHashes)) {
    hashes[file] = hash(read(path.join(target, file)));
    assert.equal(
      hashes[file],
      overlayActive && file === tracePath ? hash(overlay) : expected,
      file,
    );
  }
  assert.equal(git("ls-files", "--others", "--exclude-standard"), "");
  const changed = git("diff", "--name-only", packet.source).split("\n").filter(Boolean);
  assert.deepEqual(changed, overlayActive ? [tracePath] : []);
  write(name, { source: packet.source, hashes, changed });
};
const retained = validateRetained(lane, packet);
write("retained-validation.json", retained);
sourceReceipt("source-before.json");
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
);
const owned = path.join(evidence, "command-state");
const directories = ["home", "state", "config", "cache", "data", "tmp", "vitest-fs"];
fs.mkdirSync(owned);
for (const name of directories) fs.mkdirSync(path.join(owned, name));
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
  PROOF_EVIDENCE_DIR: evidence,
};
try {
  fs.writeFileSync(path.join(target, tracePath), overlay);
  overlayActive = true;
  sourceReceipt("overlay-before.json");
  git("diff", "--check");
  const fd = fs.openSync(path.join(evidence, "tests.log"), "wx");
  const abort = new AbortController();
  let captureFailure;
  try {
    command.exit = await runManagedCommand({
      bin: process.execPath,
      args: [
        "scripts/run-vitest.mjs",
        tracePath,
        "-t",
        "^Feishu combined-owner coalescing proof joins the held preview before replacing it with controls$",
        "--reporter=verbose",
        "--reporter=json",
        "--reporter=./scripts/lib/vitest-report-capture.mts",
        "--includeTaskLocation",
        `--outputFile.json=${path.join(evidence, "tests.json")}`,
      ],
      cwd: target,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 300_000,
      timeoutKillGraceMs: 5_000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal: abort.signal,
      abortKillGraceMs: 5_000,
      onSignal(signal) {
        command.signals.push(signal);
      },
      onReady(child) {
        command.pid = child.pid;
        child.once("exit", (code, signal) => {
          command.childExitObserved = true;
          command.childExit = code;
          command.childSignal = signal;
        });
        for (const stream of [child.stdout, child.stderr]) {
          assert(stream);
          stream.on("data", (chunk) => {
            command.captureBytes += chunk.length;
            try {
              assert(command.captureBytes <= 16 * 1024 * 1024, "Test log exceeded16MiB");
              fs.appendFileSync(fd, chunk);
            } catch (error) {
              captureFailure ??= error;
              abort.abort();
            }
          });
        }
      },
    });
    command.normalManagedReturn = true;
  } catch (error) {
    unjoinedWork = hasUnjoinedWork(error);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  if (captureFailure) throw captureFailure;
  assert.equal(command.exit, 0);
  assert.equal(command.childExitObserved, true);
  assert.equal(command.childExit, 0);
  assert.equal(command.childSignal, null);
  assert.deepEqual(command.signals, []);
  fs.writeFileSync(path.join(evidence, "test-exit.txt"), "0\n");
  sourceReceipt("overlay-after.json");
  await validate(evidence);
  verifyInputs();
  validateRetained(lane, packet);
  completed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
} finally {
  if (!unjoinedWork) {
    try {
      if (overlayActive) {
        assert.equal(
          hash(read(path.join(target, tracePath))),
          hash(overlay),
          "Trace overlay drift; retain it",
        );
        fs.writeFileSync(path.join(target, tracePath), original);
        overlayActive = false;
      }
      sourceReceipt("source-after.json");
      fs.rmSync(owned, { recursive: true });
      assert.equal(fs.existsSync(owned), false);
      command.ownedStateRemoved = true;
    } catch (error) {
      completed = false;
      failure = { ...(failure ?? {}), cleanup: error.message };
    }
  } else {
    completed = false;
    command.retainedCommandState = owned;
  }
  write("managed-command.json", command);
  write("verdict.json", {
    completed,
    source: packet.source,
    packetHash,
    unjoinedWork,
    overlayActive,
    command,
    failure,
    gatewayIngress: "not-run",
    credentialedFeishu: false,
    originalWave: { run: 34151405952, conclusion: "FAILURE" },
    retained,
  });
}
if (!completed) throw new Error(`Feishu baseline incomplete: ${JSON.stringify(failure)}`);
console.log("FEISHU_COALESCING_DISCARD_CONTINUATION_COMPLETE");
