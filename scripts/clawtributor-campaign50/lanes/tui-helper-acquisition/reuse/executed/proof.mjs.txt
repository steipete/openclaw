import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readReport } from "./read-report.mjs";

const [target, lane, evidence, mode] = process.argv.slice(2);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (file) => fs.readFileSync(file);
const packetFile = path.join(lane, "PACKET.json");
const packetHash = hash(read(packetFile));
const packet = JSON.parse(read(packetFile));
const writeJson = (name, data) =>
  fs.writeFileSync(path.join(evidence, name), `${JSON.stringify(data, null, 2)}\n`);
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" });
const trackedTests = () =>
  git("ls-files", "-z", "--", "*.test.ts").split("\0").filter(Boolean).sort();
const inventory = JSON.parse(read(path.join(lane, "tracked-tests.json")));
const contracts = JSON.parse(read(path.join(lane, "cases.json")));
const result = { completed: false, commands: [], phases: {}, source: packet.source, packetHash };
let patched = false;
let unjoinedWork = false;
fs.mkdirSync(evidence, { recursive: true });

function audit(label) {
  assert.equal(hash(read(packetFile)), packetHash);
  for (const [file, expected] of Object.entries(packet.files)) {
    assert(fs.lstatSync(path.join(lane, file)).isFile());
    assert.equal(hash(read(path.join(lane, file))), expected, file);
  }
  assert.equal(git("rev-parse", "HEAD").trim(), packet.source);
  assert.equal(git("rev-parse", "HEAD^{tree}").trim(), packet.tree);
  assert.equal(git("diff", "--name-only").trim(), "", "Index and disk must match");
  assert.equal(git("ls-files", "--others", "--exclude-standard").trim(), "");
  const changes = git("diff", "--cached", "--name-status").trim().split("\n").filter(Boolean);
  assert.deepEqual(changes, patched ? [`M\t${packet.acquisition}`, `D\t${packet.removed}`] : []);
  const observed = {};
  for (const [file, expected] of Object.entries(packet.sourceHashes)) {
    if (patched && file === packet.removed) {
      assert.equal(fs.existsSync(path.join(target, file)), false);
      assert.equal(git("ls-files", "--", file).trim(), "");
      continue;
    }
    assert(fs.lstatSync(path.join(target, file)).isFile(), file);
    observed[file] = hash(read(path.join(target, file)));
    assert.equal(
      observed[file],
      patched && file === packet.acquisition ? packet.acquisitionAfter : expected,
      file,
    );
    assert.equal(
      hash(execFileSync("git", ["show", `:${file}`], { cwd: target })),
      observed[file],
      file,
    );
  }
  const files = trackedTests();
  assert.deepEqual(
    files,
    patched ? inventory.filter((file) => file !== packet.removed) : inventory,
  );
  assert(files.includes(packet.acquisition));
  writeJson(`${label}.json`, {
    source: packet.source,
    tree: packet.tree,
    patched,
    changes,
    sourceHashes: observed,
    indexedTestCount: files.length,
    indexedTestInventoryHash: hash(JSON.stringify(files)),
    removedPresent: files.includes(packet.removed),
  });
}

try {
  assert.equal(mode, "green");
  assert.equal(process.env.PROOF_MODE, mode);
  assert.equal(process.env.PROOF_LANE, packet.lane);
  assert.equal(process.env.PROOF_VARIANT, packet.variant);
  assert.equal(process.env.SOURCE_SHA, packet.source);
  assert.equal(process.env.CI, "1");
  assert.equal(process.platform, "linux");
  assert.equal(process.version, "v24.19.0");
  for (const item of [target, lane, evidence]) assert(path.isAbsolute(item));
  assert(!lane.startsWith(`${target}/`) && !evidence.startsWith(`${target}/`));
  assert.equal(
    JSON.parse(read(path.join(target, "package.json"))).packageManager,
    packet.packageManager,
  );
  assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), packet.pnpm);
  audit("source-before");
  const { runManagedCommand, hasUnjoinedWork } = await import(
    pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
  );
  writeJson("host.json", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    packageManager: packet.packageManager,
  });
  git("apply", "--check", "--index", path.join(lane, "candidate.patch"));
  git("apply", "--index", path.join(lane, "candidate.patch"));
  patched = true;
  audit("source-candidate-indexed");

  for (const contract of contracts) {
    const directory = path.join(evidence, contract.id);
    fs.mkdirSync(directory);
    const owned = fs.mkdtempSync(path.join(directory, "owned-"));
    for (const name of ["home", "state", "config", "cache", "data", "tmp", "vitest-fs"])
      fs.mkdirSync(path.join(owned, name));
    const env = {
      PATH: process.env.PATH,
      CI: process.env.CI,
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
      NODE_OPTIONS: "--max-old-space-size=8192",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    const reportFile = path.join(directory, "vitest.json");
    const logFile = path.join(directory, "vitest.log");
    const args = [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.tooling.config.ts",
      contract.file,
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile=${reportFile}`,
      ...(contract.pattern ? ["--testNamePattern", contract.pattern] : []),
    ];
    const row = {
      id: contract.id,
      args,
      startedAt: new Date().toISOString(),
      joined: false,
      outputBytes: 0,
      timeoutMs: 600_000,
    };
    result.commands.push(row);
    let primaryError;
    const abort = new AbortController();
    const fd = fs.openSync(logFile, "wx");
    try {
      row.exit = await runManagedCommand({
        bin: process.execPath,
        args,
        cwd: target,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: row.timeoutMs,
        timeoutKillGraceMs: 5000,
        timeoutForceKillOnLeaderExit: true,
        requireProcessTreeExit: true,
        signal: abort.signal,
        abortKillGraceMs: 5000,
        onReady(child) {
          row.pid = child.pid;
          for (const stream of [child.stdout, child.stderr])
            stream.on("data", (chunk) => {
              row.outputBytes += chunk.length;
              if (row.outputBytes > 4_000_000) {
                row.outputLimitExceeded = true;
                abort.abort();
              } else {
                try {
                  fs.appendFileSync(fd, chunk);
                } catch (error) {
                  primaryError ??= error;
                  row.captureFailed = true;
                  abort.abort();
                }
              }
            });
        },
      });
      row.joined = true;
    } catch (error) {
      primaryError ??= error;
      row.unjoinedWork = hasUnjoinedWork(error);
      unjoinedWork ||= row.unjoinedWork;
      row.joined = !row.unjoinedWork;
      row.processTreeState = error.processTreeState;
    } finally {
      try {
        fs.closeSync(fd);
      } catch (error) {
        primaryError ??= error;
      }
      row.finishedAt = new Date().toISOString();
      row.outputSha256 = hash(read(logFile));
      if (row.joined) {
        try {
          fs.rmSync(owned, { recursive: true });
          assert.equal(fs.existsSync(owned), false);
          row.ownedStateRemoved = true;
        } catch (error) {
          primaryError ??= error;
          row.stateCleanupFailed = true;
        }
      } else row.retainedState = owned;
      writeJson("commands.json", result.commands);
    }
    if (primaryError) throw primaryError;
    assert.equal(row.outputLimitExceeded ?? false, false);
    assert.equal(row.exit, 0);
    result.phases[contract.id] = readReport(
      reportFile,
      logFile,
      path.join(target, contract.file),
      contract.names,
      Boolean(contract.pattern),
    );
    row.reportSha256 = hash(read(reportFile));
    audit(`source-after-${contract.id}`);
  }
  result.completed = true;
} catch (error) {
  result.failure = { message: String(error?.message ?? error).slice(0, 2000), code: error?.code };
} finally {
  if (!unjoinedWork) {
    try {
      if (patched) {
        audit("source-before-restoration");
        git("apply", "--reverse", "--check", "--index", path.join(lane, "candidate.patch"));
        git("apply", "--reverse", "--index", path.join(lane, "candidate.patch"));
        patched = false;
      }
      audit("source-final");
      result.sourceRestored = true;
    } catch (error) {
      result.completed = false;
      result.finalSourceFailure = String(error?.message ?? error).slice(0, 2000);
    }
  } else {
    result.completed = false;
    result.retainedCandidate = true;
    result.unjoinedWork = true;
  }
  writeJson("commands.json", result.commands);
  writeJson("result.json", result);
}
process.exitCode = result.completed && result.sourceRestored ? 0 : 1;
