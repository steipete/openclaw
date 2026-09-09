import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyNativeRetention } from "./native-retention.mjs";

const [repo, evidence] = process.argv.slice(2);
assert(repo && evidence);
assert.equal(process.env.CI, "1");
const lane = path.dirname(fileURLToPath(import.meta.url));
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(repo, "scripts/lib/managed-child-process.mts")).href
);
let safeForCleanup = true;
const parent = path.join(repo, ".artifacts");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "doctor-bootstrap-proof-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stripAnsi = (value) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
const cases = [
  { id: "fixed-user", files: { "USER.md": 5000 }, max: 20000, total: 60000 },
  { id: "near-user", files: { "USER.md": 3500 }, max: 20000, total: 60000 },
  { id: "lower-user", files: { "USER.md": 1800 }, max: 20000, override: 2000, total: 60000 },
  { id: "ordinary-file", files: { "SOUL.md": 18000 }, max: 20000, total: 60000 },
  { id: "total-drop", files: { "SOUL.md": 1000, "IDENTITY.md": 500 }, max: 20000, total: 1000 },
  { id: "mixed", files: { "SOUL.md": 5000, "IDENTITY.md": 500 }, max: 4000, total: 3000 },
  { id: "quiet", files: { "USER.md": 100 }, max: 20000, total: 60000 },
  { id: "empty", files: {}, max: 20000, total: 60000 },
];
const rows = [];
const children = [];

async function snapshot(directory) {
  const files = {};
  async function walk(dir, prefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        files[relative] = { symlink: await fs.readlink(path.join(dir, entry.name)) };
      } else if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else {
        assert(entry.isFile());
        const bytes = await fs.readFile(path.join(dir, entry.name));
        files[relative] = { bytes: bytes.length, sha256: digest(bytes) };
      }
    }
  }
  await walk(directory, "");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function childEnv(home, config) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("OPENCLAW_") || name.startsWith("VITEST")) delete env[name];
  }
  delete env.NODE_ENV;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_HIDE_BANNER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

async function isAbsent(target) {
  try {
    await fs.lstat(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function invoke(id, kind, command, args, env, expectedExit, timeout = 120000) {
  const output = path.join(evidence, id);
  await fs.mkdir(output, { recursive: true });
  const receipt = { id, kind, command, args, managedJoined: false };
  children.push(receipt);
  const stdout = [],
    stderr = [],
    combined = [];
  const limit = kind === "warmup" ? 64 * 1024 * 1024 : 8 * 1024 * 1024;
  let bytes = 0;
  const abort = new AbortController();
  try {
    receipt.status = await runManagedCommand({
      bin: command,
      args,
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: timeout,
      requireProcessTreeExit: true,
      signal: abort.signal,
      onSignal(signal) {
        receipt.signal = signal;
      },
      onReady(child) {
        receipt.pid = child.pid;
        for (const [stream, chunks] of [
          [child.stdout, stdout],
          [child.stderr, stderr],
        ]) {
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > limit) {
              receipt.outputLimitExceeded = true;
              abort.abort();
            } else {
              chunks.push(chunk);
              combined.push(chunk);
            }
          });
        }
      },
    });
    receipt.managedJoined = true;
  } catch (error) {
    const unjoined = hasUnjoinedWork(error);
    safeForCleanup = safeForCleanup && !unjoined;
    receipt.error = {
      message: String(error),
      code: error?.code,
      processTreeState: error?.processTreeState,
      unjoined,
    };
    throw error;
  } finally {
    // Classify serialized native ownership before status checks or any fixture removal.
    receipt.nativeRetention = classifyNativeRetention({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    receipt.nativeClassificationComplete = !receipt.outputLimitExceeded && !receipt.error?.unjoined;
    safeForCleanup =
      safeForCleanup &&
      receipt.nativeClassificationComplete &&
      receipt.nativeRetention.length === 0;
    receipt.outputBytesObserved = bytes;
    await fs.writeFile(path.join(output, `${kind}.stdout.log`), Buffer.concat(stdout));
    await fs.writeFile(path.join(output, `${kind}.stderr.log`), Buffer.concat(stderr));
    await fs.writeFile(path.join(output, `${kind}.log`), Buffer.concat(combined));
    await fs.writeFile(
      path.join(output, `${kind}.outcome.json`),
      JSON.stringify(receipt, null, 2) + "\n",
    );
  }
  assert.deepEqual(
    receipt.nativeRetention,
    [],
    "Native owner retained unfinished or unverified work",
  );
  assert.equal(receipt.outputLimitExceeded ?? false, false);
  assert.equal(receipt.signal, undefined);
  assert.equal(receipt.status, expectedExit, `${id}/${kind}`);
  return Buffer.concat(stdout).toString("utf8");
}

try {
  const warmHome = path.join(root, "warmup");
  await fs.mkdir(warmHome);
  const warmConfig = path.join(warmHome, "openclaw.json");
  await fs.writeFile(warmConfig, JSON.stringify({ plugins: { enabled: false } }) + "\n");
  const version = await invoke(
    "warmup",
    "warmup",
    "pnpm",
    ["--silent", "openclaw", "--version"],
    childEnv(warmHome, warmConfig),
    0,
    1200000,
  );
  assert.match(version, /2026\.9\.3/);
  const ownerReport = path.join(evidence, "owners", "tests.json");
  await invoke(
    "owners",
    "tests",
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "src/commands/doctor-bootstrap-size.test.ts",
      "src/flows/doctor-core-bootstrap-size-check.test.ts",
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile=${ownerReport}`,
    ],
    childEnv(warmHome, warmConfig),
    0,
    300000,
  );
  await invoke(
    "owners",
    "validation",
    process.execPath,
    [
      path.join(lane, "validate-owners.mjs"),
      ownerReport,
      path.join(evidence, "owners", "tests.log"),
      path.join(lane, "owner-test-names.json"),
    ],
    childEnv(warmHome, warmConfig),
    0,
    30000,
  );

  for (const scenario of cases) {
    const directory = path.join(root, scenario.id);
    const workspace = path.join(directory, "workspace");
    const home = path.join(directory, "home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(home);
    for (const name of [
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]) {
      await fs.writeFile(path.join(workspace, name), "x".repeat(scenario.files[name] ?? 0));
    }
    const config = {
      agents: {
        defaults: {
          workspace,
          bootstrapMaxChars: scenario.max,
          bootstrapTotalMaxChars: scenario.total,
        },
        entries: { main: scenario.override ? { bootstrapMaxChars: scenario.override } : {} },
      },
      plugins: { enabled: false },
    };
    const configPath = path.join(directory, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const before = {
      workspace: await snapshot(workspace),
      configSha256: digest(await fs.readFile(configPath)),
    };
    const output = path.join(evidence, scenario.id);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "fixture.json"),
      JSON.stringify({ scenario, config, before }, null, 2) + "\n",
    );
    const analysisPath = path.join(output, "analysis.json");
    const humanRaw = await invoke(
      scenario.id,
      "human",
      process.execPath,
      [
        "--import",
        path.join(repo, "scripts/tsx.mjs"),
        path.join(lane, "human.mjs"),
        repo,
        configPath,
        analysisPath,
      ],
      childEnv(home, configPath),
      0,
    );
    const human = stripAnsi(humanRaw);
    const analysis = JSON.parse(await fs.readFile(analysisPath, "utf8"));
    const hasFindings = !["quiet", "empty"].includes(scenario.id);
    const cliRaw = await invoke(
      scenario.id,
      "cli",
      "pnpm",
      [
        "--silent",
        "openclaw",
        "doctor",
        "--lint",
        "--only",
        "core/doctor/bootstrap-size",
        "--severity-min",
        "info",
        "--json",
      ],
      childEnv(home, configPath),
      hasFindings ? 1 : 0,
    );
    const cli = JSON.parse(cliRaw);
    assert.equal(cli.checksRun, 1);
    assert.equal(cli.ok, !hasFindings);
    assert(Array.isArray(cli.findings));
    assert.equal(cli.findings.length > 0, hasFindings);
    for (const finding of cli.findings) {
      assert.equal(finding.checkId, "core/doctor/bootstrap-size");
      assert(["warning", "info"].includes(finding.severity));
      assert.equal(typeof finding.fixHint, "string");
      assert(finding.path === workspace || finding.path.startsWith(workspace + path.sep));
      assert.doesNotMatch(finding.message, /health check threw/i);
    }
    const file = (name) => {
      const found = analysis.files.filter((entry) => entry.name === name);
      assert.equal(found.length, 1, name);
      return found[0];
    };
    const checkId = "core/doctor/bootstrap-size";
    const truncationHint =
      "Reduce the file size or tune `agents.entries.*.bootstrapMaxChars` / `bootstrapTotalMaxChars` for this agent, or the corresponding `agents.defaults.*` fallback.";
    const nearHint =
      "Reduce the file size or tune `agents.entries.*.bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits.";
    const totalHint =
      "Reduce bootstrap file sizes or tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback.";
    const truncatedFinding = (name) => ({
      checkId,
      severity: "warning",
      message: `${name} exceeds bootstrap limits and will be truncated.`,
      path: path.join(workspace, name),
      fixHint: truncationHint,
    });
    const nearFinding = (name) => ({
      checkId,
      severity: "info",
      message: `${name} is near the configured bootstrap file limit.`,
      path: path.join(workspace, name),
      fixHint: nearHint,
    });
    const totalFinding = {
      checkId,
      severity: "warning",
      message: "Total bootstrap context is near the configured total limit.",
      path: workspace,
      fixHint: totalHint,
    };
    const expectedFindings = {
      "fixed-user": [truncatedFinding("USER.md")],
      "near-user": [nearFinding("USER.md")],
      "lower-user": [nearFinding("USER.md")],
      "ordinary-file": [nearFinding("SOUL.md")],
      "total-drop": [totalFinding, truncatedFinding("IDENTITY.md")],
      mixed: [totalFinding, truncatedFinding("IDENTITY.md"), truncatedFinding("SOUL.md")],
      quiet: [],
      empty: [],
    };
    assert.deepEqual(
      cli.findings,
      expectedFindings[scenario.id],
      `${scenario.id}: exact CLI findings`,
    );
    assert(Number.isSafeInteger(cli.checksSkipped) && cli.checksSkipped >= 0);
    assert.equal(analysis.totals.bootstrapMaxChars, scenario.override ?? scenario.max);
    assert.equal(analysis.totals.bootstrapTotalMaxChars, scenario.total);
    assert.equal(analysis.totals.nearLimitRatio, 0.85);
    const expectedRaw = Object.values(scenario.files).reduce((sum, count) => sum + count, 0);
    assert.equal(analysis.totals.rawChars, expectedRaw);
    assert.equal(
      analysis.totals.injectedChars,
      analysis.files.reduce((sum, entry) => sum + (entry.missing ? 0 : entry.injectedChars), 0),
    );
    assert.equal(analysis.totals.truncatedChars, expectedRaw - analysis.totals.injectedChars);
    const expectedTruncated = {
      "fixed-user": ["USER.md"],
      "near-user": [],
      "lower-user": [],
      "ordinary-file": [],
      "total-drop": ["IDENTITY.md"],
      mixed: ["SOUL.md", "IDENTITY.md"],
      quiet: [],
      empty: [],
    };
    const expectedNear = {
      "fixed-user": ["USER.md"],
      "near-user": ["USER.md"],
      "lower-user": ["USER.md"],
      "ordinary-file": ["SOUL.md"],
      "total-drop": [],
      mixed: ["SOUL.md"],
      quiet: [],
      empty: [],
    };
    assert.deepEqual(
      analysis.truncatedFiles.map((entry) => entry.name),
      expectedTruncated[scenario.id],
    );
    assert.deepEqual(
      analysis.nearLimitFiles.map((entry) => entry.name),
      expectedNear[scenario.id],
    );
    assert.equal(analysis.hasTruncation, expectedTruncated[scenario.id].length > 0);
    assert.equal(analysis.totalNearLimit, ["total-drop", "mixed"].includes(scenario.id));
    const defects = [];
    if (scenario.id === "fixed-user") {
      assert.equal(file("USER.md").effectiveFileLimit, 4000);
      assert.equal(file("USER.md").rawChars, 5000);
      assert(file("USER.md").injectedChars <= 4000);
      assert(file("USER.md").truncated);
      assert.deepEqual(file("USER.md").causes, ["per-file-limit"]);
      assert.match(human, /bootstrapMaxChars/);
      assert(
        cli.findings.some(
          (finding) =>
            finding.path.endsWith("USER.md") && finding.fixHint.includes("bootstrapMaxChars"),
        ),
      );
      defects.push(
        "human-fixed-cap-ineffective-config-tip",
        "structured-fixed-cap-ineffective-config-tip",
      );
    }
    if (scenario.id === "near-user") {
      assert.equal(file("USER.md").effectiveFileLimit, 4000);
      assert.equal(file("USER.md").injectedChars, 3500);
      assert.equal(file("USER.md").truncated, false);
      assert(file("USER.md").nearLimit);
      assert.match(human, /3,500 chars \(18% of max\/file 20,000\)/);
      assert(
        cli.findings.some(
          (finding) => finding.message === "USER.md is near the configured bootstrap file limit.",
        ),
      );
      defects.push("human-near-cap-wrong-denominator", "structured-near-cap-configured-wording");
    }
    if (scenario.id === "lower-user") {
      assert.equal(file("USER.md").effectiveFileLimit, 2000);
      assert.equal(file("USER.md").injectedChars, 1800);
      assert.match(human, /1,800 chars \(90% of max\/file 2,000\)/);
    }
    if (scenario.id === "ordinary-file") {
      assert.equal(file("SOUL.md").effectiveFileLimit, 20000);
      assert.equal(file("SOUL.md").injectedChars, 18000);
      assert.match(human, /18,000 chars \(90% of max\/file 20,000\)/);
    }
    if (scenario.id === "total-drop") {
      assert.equal(file("IDENTITY.md").injectedChars, 0);
      assert.equal(file("IDENTITY.md").effectiveFileLimit, 20000);
      assert.deepEqual(file("IDENTITY.md").causes, ["total-limit"]);
      assert(analysis.totalNearLimit);
      assert.equal(file("SOUL.md").injectedChars, 1000);
      assert.equal(analysis.totals.injectedChars, 1000);
    }
    if (scenario.id === "mixed") {
      assert.deepEqual(file("SOUL.md").causes, ["per-file-limit", "total-limit"]);
      assert(file("SOUL.md").injectedChars > 0 && file("SOUL.md").injectedChars <= 3000);
      assert.deepEqual(file("IDENTITY.md").causes, ["total-limit"]);
      assert(analysis.totals.injectedChars <= 3000 && analysis.totals.injectedChars >= 2550);
    }
    if (!hasFindings) {
      assert.equal(human.trim(), "");
      assert.equal(analysis.hasTruncation, false);
      assert.equal(analysis.nearLimitFiles.length, 0);
      assert.equal(analysis.totalNearLimit, false);
    }
    const after = {
      workspace: await snapshot(workspace),
      configSha256: digest(await fs.readFile(configPath)),
    };
    assert.deepEqual(after, before, `${scenario.id}: diagnostic modified input files`);
    const stateAbsent = await isAbsent(path.join(home, "state"));
    assert(stateAbsent, `${scenario.id}: diagnostic created OpenClaw state`);
    await fs.writeFile(
      path.join(output, "preservation.json"),
      JSON.stringify({ before, after, stateAbsent, homeFiles: await snapshot(home) }, null, 2) +
        "\n",
    );
    rows.push({
      id: scenario.id,
      defects,
      findings: cli.findings.length,
      analysisTotals: analysis.totals,
    });
  }
  assert.equal(children.length, 19);
  assert.equal(rows.flatMap((row) => row.defects).length, 4);
  await fs.writeFile(
    path.join(evidence, "behavior.json"),
    JSON.stringify({ source: process.env.SOURCE_SHA, mode: "baseline", rows, children }, null, 2) +
      "\n",
  );
  console.log(
    "DOCTOR_BOOTSTRAP_BASELINE: four observed output defects; eight cases and preservation controls completed",
  );
} catch (error) {
  await fs.writeFile(
    path.join(evidence, "failure.json"),
    JSON.stringify({ error: String(error), rows, children }, null, 2) + "\n",
  );
  throw error;
} finally {
  if (safeForCleanup) await fs.rm(root, { recursive: true, force: true });
  const removed = safeForCleanup ? await isAbsent(root) : false;
  await fs.writeFile(
    path.join(evidence, "cleanup.json"),
    JSON.stringify({
      taskFixtureRemoved: removed,
      retainedFixture: removed ? undefined : root,
      safeForCleanup,
      allCommandsResolvedAndJoined: children.every((child) => child.managedJoined),
    }) + "\n",
  );
  if (safeForCleanup) assert(removed);
}
