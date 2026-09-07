import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";
import { instrumentGrowth, orderTooling } from "./instrument.mjs";

const [target, lane, evidence, mode] = process.argv.slice(2);
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
assert.equal(mode, "compare");
assert.equal(process.env.PROOF_MODE, mode);
assert.equal(process.env.PROOF_LANE, packet.lane);
assert.equal(process.env.PROOF_VARIANT, "planner-growth-141015");
assert.equal(process.env.SOURCE_SHA, packet.base);
assert.equal(process.env.CI, "1");
assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.19.0");
assert(path.isAbsolute(target) && path.isAbsolute(lane) && path.isAbsolute(evidence));
assert(!evidence.startsWith(`${target}/`) && !lane.startsWith(`${target}/`));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (file) => fs.readFileSync(file);
const packetHash = hash(read(path.join(lane, "PACKET.json")));
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const boundedJson = (file, limit = 32_000_000) => {
  assert(fs.lstatSync(file).isFile() && fs.statSync(file).size <= limit, file);
  return JSON.parse(read(file));
};
fs.mkdirSync(evidence, { recursive: true });
for (const [file, expected] of Object.entries(packet.files)) {
  assert.equal(hash(read(path.join(lane, file))), expected, file);
}
assert.equal(packet.files["candidate.patch"], packet.candidatePatch);
assert.equal(git("rev-parse", "HEAD"), packet.base);
assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
assert.equal(
  JSON.parse(read(path.join(target, "package.json"))).packageManager,
  packet.packageManager,
);
assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), "12.3.4");
const original = Object.fromEntries(
  packet.changedFiles.map((file) => [file, read(path.join(target, file))]),
);
const plannerFile = "test/scripts/ci-node-test-plan.test.ts";
const configFile = "test/vitest/vitest.tooling.config.ts";
const configOriginal = read(path.join(target, configFile));
const originalCaseNames = boundedJson(path.join(lane, "failed-shard-cases.json"));
const commands = [];
const phases = {};
let currentPhase = "baseline";
let completed = false;
let failure;
let unjoinedWork = false;
const activeOverlays = {};
const startedAt = Date.now();

function sourceReceipt(label, overrides = {}) {
  assert.equal(hash(read(path.join(lane, "PACKET.json"))), packetHash, "Packet changed");
  for (const [file, expectedHash] of Object.entries(packet.files))
    assert.equal(hash(read(path.join(lane, file))), expectedHash, file);
  assert.equal(git("rev-parse", "HEAD"), packet.base);
  const expected = {
    ...packet.sourceHashes,
    ...(currentPhase === "candidate" ? packet.candidateHashes : {}),
    ...overrides,
  };
  const observed = {};
  for (const [file, expectedHash] of Object.entries(expected)) {
    observed[file] = hash(read(path.join(target, file)));
    assert.equal(observed[file], expectedHash, file);
  }
  const changed = git("diff", "--name-only", packet.base, "--").split("\n").filter(Boolean).sort();
  const allowed = new Set([
    ...(currentPhase === "candidate" ? packet.changedFiles : []),
    ...Object.keys(overrides),
  ]);
  assert(
    changed.every((file) => allowed.has(file)),
    "Unexpected source delta",
  );
  assert.equal(git("ls-files", "--others", "--exclude-standard"), "");
  writeJson(path.join(evidence, `${label}.json`), {
    base: packet.base,
    currentPhase,
    hashes: observed,
    changed,
    head: git("rev-parse", "HEAD"),
  });
}

sourceReceipt("source-before");
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
);
writeJson(path.join(evidence, "hardware.json"), {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cpus: os.cpus().length,
  availableParallelism: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  packageManager: packet.packageManager,
});

async function command(id, args, timeoutMs) {
  const directory = path.join(evidence, id);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["home", "tmp", "state", "config", "cache", "data", "vitest-fs"])
    fs.mkdirSync(path.join(directory, name));
  const env = {
    PATH: process.env.PATH,
    CI: process.env.CI,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    HOME: path.join(directory, "home"),
    OPENCLAW_HOME: path.join(directory, "home"),
    OPENCLAW_STATE_DIR: path.join(directory, "state"),
    OPENCLAW_CONFIG_PATH: path.join(directory, "config/openclaw.json"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_DATA_HOME: path.join(directory, "data"),
    TMPDIR: path.join(directory, "tmp"),
    TMP: path.join(directory, "tmp"),
    TEMP: path.join(directory, "tmp"),
    OPENCLAW_VITEST_MAX_WORKERS: "2",
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(directory, "vitest-fs"),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  const remainingMs = 3_000_000 - (Date.now() - startedAt);
  assert(remainingMs > 0, "Aggregate proof deadline exhausted");
  const row = {
    id,
    args,
    startedAt: new Date().toISOString(),
    timeoutMs: Math.min(timeoutMs, remainingMs),
    joined: false,
    outputBytes: 0,
  };
  commands.push(row);
  const fd = fs.openSync(path.join(directory, "output.log"), "wx");
  const abort = new AbortController();
  let primaryError;
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
            if (row.outputBytes > 64_000_000) {
              row.outputLimitExceeded = true;
              abort.abort();
            } else {
              try {
                fs.appendFileSync(fd, chunk);
              } catch (error) {
                primaryError ??= error;
                row.captureError = error.message;
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
    row.error = {
      message: error.message,
      code: error.code,
      processTreeState: error.processTreeState,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      primaryError ??= error;
      row.captureCloseError = error.message;
    }
    row.finishedAt = new Date().toISOString();
    if (row.joined) {
      try {
        for (const name of ["home", "tmp", "state", "config", "cache", "data", "vitest-fs"]) {
          const owned = path.join(directory, name);
          fs.rmSync(owned, { recursive: true });
          assert.equal(fs.existsSync(owned), false);
        }
        row.ownedCommandStateRemoved = true;
      } catch (error) {
        primaryError ??= error;
        row.stateCleanupError = error.message;
      }
    } else row.retainedCommandState = directory;
    try {
      row.outputSha256 = hash(read(path.join(directory, "output.log")));
      writeJson(path.join(evidence, "commands.json"), commands);
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  assert.equal(row.outputLimitExceeded ?? false, false);
  return { row, directory };
}

function testArgs(files, report, pattern) {
  return [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "test/vitest/vitest.tooling.config.ts",
    ...files,
    "--reporter=verbose",
    "--reporter=json",
    "--includeTaskLocation",
    `--outputFile=${report}`,
    ...(pattern ? ["--testNamePattern", pattern] : []),
  ];
}

function completedReport(run) {
  const file = path.join(run.directory, "tests.json");
  boundedJson(file);
  const { report } = readCompletedReport(file, path.join(run.directory, "output.log"));
  assert(
    report.testResults.every((suite) =>
      suite.assertionResults.every((test) => ["passed", "failed", "skipped"].includes(test.status)),
    ),
  );
  for (const suite of report.testResults)
    for (const test of suite.assertionResults) {
      if (test.status !== "failed") assert.deepEqual(test.failureMessages, []);
    }
  assert.equal(report.numTodoTests ?? 0, 0);
  return report;
}

function reportCases(report) {
  return report.testResults.flatMap((suite) =>
    suite.assertionResults.map((test) => ({
      file: path.relative(target, suite.name).replaceAll("\\", "/"),
      name: [...test.ancestorTitles, test.title].join(" > "),
      title: test.title,
      status: test.status,
      duration: test.duration,
      failureMessages: test.failureMessages,
    })),
  );
}

async function originalShard() {
  const id = `${currentPhase}-original`;
  const config = orderTooling(configOriginal.toString(), path.join(lane, "order.mjs"));
  const configHash = hash(config);
  fs.writeFileSync(path.join(target, configFile), config);
  activeOverlays[configFile] = configHash;
  let run;
  try {
    sourceReceipt(`${id}-source`, { [configFile]: configHash });
    run = await command(
      id,
      testArgs(packet.originalFiles, path.join(evidence, id, "tests.json")),
      900_000,
    );
  } finally {
    if (!unjoinedWork) {
      assert.equal(hash(read(path.join(target, configFile))), configHash, "Order overlay drift");
      fs.writeFileSync(path.join(target, configFile), configOriginal);
      delete activeOverlays[configFile];
    }
    sourceReceipt(`${id}-source-final`, activeOverlays);
  }
  const report = completedReport(run);
  const cases = reportCases(report);
  assert.equal(report.numTotalTests, 601);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.testResults.length, 3);
  assert.deepEqual(
    cases
      .map(({ file, name }) => ({ file, name }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    originalCaseNames
      .map(({ file, name }) => ({ file, name }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  const ordered = [...report.testResults]
    .sort((a, b) => a.startTime - b.startTime)
    .map((suite) => path.relative(target, suite.name));
  assert.deepEqual(ordered, packet.originalFiles);
  const failed = cases.filter((test) => test.status === "failed");
  if (currentPhase === "baseline" && failed.length === 1) {
    assert.equal(failed[0].title, packet.growthTitle);
    assert.equal(failed[0].failureMessages.length, 1);
    assert.equal(
      failed[0].failureMessages[0].split("\n")[0].trim(),
      "Error: Test timed out in 120000ms.",
    );
    assert.match(failed[0].failureMessages[0], /test\/scripts\/ci-node-test-plan\.test\.ts:2197:3/);
    assert.equal(run.row.exit, 1);
    assert.equal(report.numPassedTests, 600);
    assert.equal(report.numFailedTests, 1);
    assert.equal(report.success, false);
  } else {
    assert.equal(failed.length, 0);
    assert.equal(run.row.exit, 0);
    assert.equal(report.numPassedTests, 601);
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.success, true);
  }
  const growth = cases.find((test) => test.title === packet.growthTitle);
  return {
    classification: failed.length ? "ORIGINAL_GROWTH_TIMEOUT" : "ALL_PASSED",
    growth,
    reportSha256: hash(read(path.join(run.directory, "tests.json"))),
  };
}

async function diagnostic() {
  const id = `${currentPhase}-diagnostic`;
  const plans = path.join(evidence, `${id}-plans`);
  fs.mkdirSync(plans);
  const saved = read(path.join(target, plannerFile));
  const instrumented = instrumentGrowth(saved.toString(), plans);
  const instrumentedHash = hash(instrumented);
  fs.writeFileSync(path.join(target, plannerFile), instrumented);
  activeOverlays[plannerFile] = instrumentedHash;
  let run;
  try {
    sourceReceipt(`${id}-source`, { [plannerFile]: instrumentedHash });
    run = await command(
      id,
      testArgs([plannerFile], path.join(evidence, id, "tests.json"), packet.growthTitle),
      300_000,
    );
  } finally {
    if (!unjoinedWork) {
      assert.equal(
        hash(read(path.join(target, plannerFile))),
        instrumentedHash,
        "Diagnostic overlay drift",
      );
      fs.writeFileSync(path.join(target, plannerFile), saved);
      delete activeOverlays[plannerFile];
    }
    sourceReceipt(`${id}-source-final`, activeOverlays);
  }
  const report = completedReport(run);
  const active = reportCases(report).filter((test) => test.status !== "skipped");
  assert.equal(active.length, 1);
  assert.equal(active[0].title, packet.growthTitle);
  writeJson(path.join(evidence, `${id}-case.json`), active[0]);
  assert.equal(
    run.row.exit,
    0,
    "Diagnostic incomplete; retain actual failure, never extend its budget",
  );
  assert.equal(active[0].status, "passed");
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numTotalTests, 53);
  assert.equal(report.numPendingTests, 52);
  assert.equal(fs.readdirSync(plans).length, 20);
  let totalBytes = 0;
  const rows = [];
  for (let index = 0; index < 10; index++) {
    const row = boundedJson(path.join(plans, `row-${index}.json`), 100_000);
    assert.equal(row.ordinal, index);
    assert.deepEqual(
      { includeGrowthFile: row.includeGrowthFile, extraFiles: row.extraFiles },
      packet.variants[index],
    );
    assert(
      Number.isSafeInteger(row.pid) &&
        row.pid > 1 &&
        Number.isSafeInteger(row.owner) &&
        row.owner > 0,
    );
    assert(
      Number.isFinite(row.importMs) &&
        row.importMs >= 0 &&
        Number.isFinite(row.packingMs) &&
        row.packingMs >= 0,
    );
    const file = path.join(plans, `plan-${index}.json`);
    boundedJson(file, 16_000_000);
    const bytes = read(file);
    totalBytes += bytes.length;
    rows.push({ ...row, planSha256: hash(bytes), planBytes: bytes.length });
  }
  assert(totalBytes <= 64_000_000);
  assert.equal(new Set(rows.map((row) => row.pid)).size, 1);
  assert.equal(new Set(rows.map((row) => row.owner)).size, currentPhase === "baseline" ? 10 : 1);
  return { rows, wholeCaseDurationMs: active[0].duration, includesOneTimeCaptureCost: true };
}

async function readerControls() {
  const id = `${currentPhase}-readers`;
  const run = await command(
    id,
    testArgs(
      ["test/scripts/bounded-response.test.ts", "test/scripts/firecrawl-compare.test.ts"],
      path.join(evidence, id, "tests.json"),
    ),
    300_000,
  );
  const report = completedReport(run);
  assert.equal(run.row.exit, 0);
  assert.equal(report.numTotalTests, 15);
  assert.equal(report.numPassedTests, 15);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.success, true);
  const claudeId = `${currentPhase}-claude-controls`;
  const pattern = packet.claudeTitles
    .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const claude = await command(
    claudeId,
    testArgs(
      ["test/scripts/dev-tooling-safety.test.ts"],
      path.join(evidence, claudeId, "tests.json"),
      pattern,
    ),
    300_000,
  );
  const claudeReport = completedReport(claude);
  const active = reportCases(claudeReport).filter((test) => test.status !== "skipped");
  assert.equal(claude.row.exit, 0);
  assert.equal(claudeReport.numPassedTests, 4);
  assert.equal(claudeReport.numFailedTests, 0);
  assert.equal(claudeReport.success, true);
  assert.deepEqual(active.map((test) => test.title).sort(), [...packet.claudeTitles].sort());
  assert(active.every((test) => test.status === "passed"));
  return { boundedAndFirecrawl: 15, claudeRequestControls: 4 };
}

try {
  for (const phase of ["baseline", "candidate"]) {
    currentPhase = phase;
    if (phase === "candidate") {
      for (const file of packet.changedFiles) {
        assert.equal(hash(read(path.join(target, file))), hash(original[file]));
        fs.writeFileSync(path.join(target, file), read(path.join(lane, "candidate", file)));
      }
    }
    sourceReceipt(`${phase}-before`);
    phases[phase] = {};
    phases[phase].original = await originalShard();
    phases[phase].diagnostic = await diagnostic();
    phases[phase].readers = await readerControls();
    sourceReceipt(`${phase}-after`);
    writeJson(path.join(evidence, "phases.json"), phases);
  }
  assert.deepEqual(
    phases.baseline.diagnostic.rows.map((row) => row.planSha256),
    phases.candidate.diagnostic.rows.map((row) => row.planSha256),
  );
  for (let index = 0; index < 10; index++) {
    assert(
      read(path.join(evidence, "baseline-diagnostic-plans", `plan-${index}.json`)).equals(
        read(path.join(evidence, "candidate-diagnostic-plans", `plan-${index}.json`)),
      ),
    );
  }
  git("add", "--", ...packet.changedFiles);
  assert.deepEqual(
    git("diff", "--cached", "--name-only", packet.base).split("\n").sort(),
    [...packet.changedFiles].sort(),
  );
  assert.equal(
    hash(execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: target })),
    packet.candidateIndex,
  );
  for (const dry of [true, false]) {
    const gate = await command(
      dry ? "changed-plan" : "changed-gates",
      [
        "scripts/check-changed.mjs",
        "--staged",
        "--base",
        packet.base,
        ...(dry ? ["--dry-run"] : []),
        "--",
        ...packet.changedFiles,
      ],
      1_800_000,
    );
    assert.equal(gate.row.exit, 0);
  }
  sourceReceipt("candidate-after-gates");
  assert.equal(
    hash(execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: target })),
    packet.candidateIndex,
  );
  assert(commands.every((row) => row.joined && row.ownedCommandStateRemoved));
  completed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  try {
    sourceReceipt("source-final", activeOverlays);
  } catch (error) {
    completed = false;
    failure = { ...(failure ?? {}), finalSourceError: error.message };
    process.exitCode = 1;
  }
  writeJson(path.join(evidence, "phases.json"), phases);
  writeJson(path.join(evidence, "verdict.json"), {
    completed,
    verdict: completed ? "PAIRED_PROOF_COMPLETE" : "INCOMPLETE_OR_FAILED",
    base: packet.base,
    reviewedPrHead: packet.reviewedPrHead,
    candidatePatch: packet.candidatePatch,
    phases,
    commands,
    failure,
    unjoinedWork,
    retainedOverlays: activeOverlays,
    targetExecutedOnlyOnHostedController: true,
    limitations:
      "Raw single-pair timing; no fixed speedup claim. Candidate whole-case time includes one-time capture. Baseline pass is hosted nonreproduction. Exact-head CI and independent actual evidence review remain required.",
  });
}
