// Run only through the pinned GitHub-hosted proof workflow.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archive = "/tmp/openclaw-132266-after-proof.tgz";
const phaseNames = ["unit-normalizer", "unit-cache", "unit-resolver", "metadata", "gateway"];
let output, root, binding, before, snapshot, proofPath;
let overlayCreated = false;
let expectedHead = null;
const verdict = { passed: false, fullProofCompleted: false, phase: "setup", phases: [], cleanupErrors: [] };
const writeJson = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

// The repository index can exceed execFile's buffer; hash its complete stream.
function hashIndexEntries(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr = Buffer.concat([stderr, chunk.subarray(0, 8192 - stderr.length)]); });
    child.on("error", reject);
    child.stdout.on("error", reject);
    child.stderr.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) reject(new Error(`git index listing failed: code=${code} signal=${signal}; ${stderr.toString("utf8")}`));
      else resolve({ sha256: hash.digest("hex"), bytes });
    });
  });
}

function checkVitest(name, expectedFile, expectedCount) {
  const report = JSON.parse(fs.readFileSync(path.join(output, `${name}.json`), "utf8"));
  assert.equal(report.success, true, name);
  assert.equal(report.numTotalTests, expectedCount, name);
  assert.equal(report.numPassedTests, expectedCount, name);
  for (const key of ["numFailedTests", "numPendingTests", "numTodoTests"]) assert.equal(report[key], 0, `${name}:${key}`);
  assert.equal(report.testResults.length, 1, name);
  const suite = report.testResults[0];
  assert.ok(suite.name.endsWith("/" + expectedFile), name);
  assert.equal(suite.assertionResults.length, expectedCount, name);
  assert.ok(suite.assertionResults.every((item) => item.status === "passed"), name);
  return { file: expectedFile, passed: expectedCount };
}

try {
  process.umask(0o077);
  // Allocate the receipt directory before parsing inputs so setup failures retain artifacts.
  output = fs.realpathSync(fs.mkdtempSync("/tmp/openclaw-132266-after-proof-"));
  assert.equal(fs.lstatSync(output).mode & 0o777, 0o700);
  const inputs = process.argv.slice(1);
  expectedHead = inputs[0];
  assert.match(expectedHead ?? "", /^[0-9a-f]{40}$/);
  verdict.head = expectedHead;
  binding = JSON.parse(inputs[1]);
  assert.equal(binding.candidateHead, expectedHead);
  assert.equal(binding.remoteArchive, archive);
  const proofBytes = Buffer.from(inputs[2], "base64");
  const metadataBytes = Buffer.from(inputs[3], "base64");
  assert.equal(sha256(proofBytes), binding.proofTestSHA256);
  assert.equal(sha256(metadataBytes), binding.metadataHarnessSHA256);
  assert.equal(process.platform, "linux");
  assert.equal(process.version, "v24.19.0");
  root = fs.realpathSync(process.cwd());
  const git = (...args) => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  const proofRelativePath = "extensions/qa-lab/src/plugin-tool-progress.gateway-proof.test.ts";
  assert.equal(binding.proofTestRemotePath, proofRelativePath);
  proofPath = path.join(root, proofRelativePath);
  assert.equal(fs.realpathSync(path.dirname(proofPath)), path.join(root, "extensions/qa-lab/src"));
  assert.equal(spawnSync("/usr/bin/git", ["ls-files", "--error-unmatch", "--", proofRelativePath], { cwd: root, stdio: "ignore" }).status, 1);
  assert.ok(!fs.existsSync(proofPath), "Do not overwrite an existing proof path");
  snapshot = async (withProof) => {
    assert.equal(git("rev-parse", "HEAD"), expectedHead);
    assert.equal(git("rev-parse", "HEAD^{tree}"), binding.candidateTree);
    for (const args of [["diff", "--no-ext-diff", "--quiet"], ["diff", "--cached", "--no-ext-diff", "--quiet"]]) {
      assert.equal(spawnSync("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, stdio: "ignore" }).status, 0, "Tracked source/index changed");
    }
    for (const [name, hash] of Object.entries(binding.candidateFileSHA256)) {
      assert.ok(!path.isAbsolute(name) && !name.split("/").includes(".."));
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.equal(sha256(fs.readFileSync(path.join(root, name))), hash, name);
    }
    if (withProof) assert.equal(sha256(fs.readFileSync(proofPath)), binding.proofTestSHA256);
    return { head: expectedHead, tree: binding.candidateTree, index: await hashIndexEntries(root), sourceHashes: binding.candidateFileSHA256, installedLockSHA256: sha256(fs.readFileSync(path.join(root, "node_modules/.pnpm/lock.yaml"))) };
  };
  before = await snapshot(false);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.packageManager, binding.packageManager);
  assert.equal(binding.provider, "github-actions");
  assert.equal(binding.executionEnvironment, "github-hosted");
  assert.equal(process.execPath, binding.nodeExecutable);
  assert.equal(process.env.COREPACK_HOME, binding.corepackHome);
  fs.writeFileSync(proofPath, proofBytes, { flag: "wx", mode: 0o600 });
  overlayCreated = true;
  fs.writeFileSync(path.join(output, "proof.test.ts"), proofBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(output, "metadata-after.mjs"), metadataBytes, { flag: "wx", mode: 0o600 });
  const behaviorDirectory = path.join(output, "behavior");
  fs.mkdirSync(behaviorDirectory, { mode: 0o700 });
  const commands = binding.unitSuites.map((suite) => ({ name: suite.phase, argv: [process.execPath, "scripts/run-vitest.mjs", "run", suite.path, "--reporter=default", "--reporter=json", `--outputFile=${path.join(output, suite.phase + ".json")}`] }));
  commands.push({ name: "metadata", argv: [process.execPath, "--import", path.join(root, "scripts/tsx.mjs"), path.join(output, "metadata-after.mjs"), "candidate", path.join(output, "runtime/metadata/workspace")] });
  commands.push({ name: "gateway", argv: [process.execPath, "--import", path.join(root, "scripts/tsx.mjs"), proofPath] });
  assert.deepEqual(commands.map((command) => command.name), phaseNames);
  const envs = {};
  for (const { name } of commands) {
    const home = path.join(output, "runtime", name);
    fs.mkdirSync(home, { mode: 0o700, recursive: true });
    const env = { PATH: binding.environmentPath, HOME: home, CI: "1", COREPACK_HOME: process.env.COREPACK_HOME, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
    assert.equal(env.COREPACK_HOME, binding.corepackHome);
    for (const [key, directory] of Object.entries({ TMPDIR: "tmp", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data", OPENCLAW_STATE_DIR: "state" })) {
      env[key] = path.join(home, directory);
      fs.mkdirSync(env[key], { mode: 0o700 });
    }
    fs.mkdirSync(path.join(home, "workspace"), { mode: 0o700 });
    if (name === "gateway") {
      env.OPENCLAW_METADATA_PROOF_DIR = behaviorDirectory;
      env.OPENCLAW_METADATA_PROOF_BINDING = path.join(output, "source-binding.json");
    }
    envs[name] = env;
  }
  const sourceBinding = { ...before, commands, proofTest: { path: proofRelativePath, sha256: binding.proofTestSHA256, tracked: false }, metadataHarnessSHA256: binding.metadataHarnessSHA256, expectedScenarioIds: binding.expectedScenarioIds, metadataScenarioIds: binding.metadataScenarioIds, packageManager: pkg.packageManager, nodeVersion: process.version, envNames: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, Object.keys(env)])), dependencyExecution: "fresh frozen-lockfile install by hash-bound hosted controller", provider: "github-actions", executionEnvironment: "github-hosted", hostedProvenance: binding.hostedProvenance, hydrate: false };
  writeJson("requested-binding.json", binding);
  writeJson("source-binding.json", sourceBinding);
  for (const command of commands) {
    verdict.phase = command.name;
    console.log(`PROOF_PHASE:132266_${command.name}`);
    const out = fs.openSync(path.join(output, command.name + ".stdout"), "wx", 0o600);
    const err = fs.openSync(path.join(output, command.name + ".stderr"), "wx", 0o600);
    let result;
    const started = performance.now();
    try {
      result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: root, env: envs[command.name], stdio: ["ignore", out, err], timeout: command.name === "gateway" ? 180_000 : 1_200_000, killSignal: "SIGTERM" });
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
    const phaseResult = { name: command.name, argv: command.argv, exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null, durationMs: Math.round(performance.now() - started) };
    verdict.phases.push(phaseResult);
    writeJson(command.name + "-result.json", phaseResult);
    assert.deepEqual(await snapshot(true), before);
    assert.equal(sha256(fs.readFileSync(path.join(output, "metadata-after.mjs"))), binding.metadataHarnessSHA256);
    assert.equal(result.status, 0, command.name);
    const unit = binding.unitSuites.find((suite) => suite.phase === command.name);
    if (unit) checkVitest(command.name, unit.path, unit.expectedTests);
    if (command.name === "metadata") {
      const metadataLines = fs.readFileSync(path.join(output, "metadata.stdout"), "utf8").split("\n").filter((line) => line.startsWith("METADATA_PROOF "));
      assert.equal(metadataLines.length, 1);
      const metadata = JSON.parse(metadataLines[0].slice("METADATA_PROOF ".length));
      assert.equal(metadata.mode, "candidate");
      assert.equal(metadata.factories, 3);
      assert.equal(metadata.executions, 6);
      assert.deepEqual(metadata.rows.map((row) => row.label), binding.metadataScenarioIds);
      for (const row of metadata.rows) {
        const hidden = !["cache-hit-visible", "visible"].includes(row.label);
        assert.equal(row.marker, hidden, row.label);
        assert.equal(row.lifecycleEvents, 3, row.label);
        assert.equal(row.finalReplies, 1, row.label);
        assert.equal(row.progressCallbacks, hidden ? 0 : 2, row.label);
        assert.equal(row.itemCallbacks, hidden ? 0 : 1, row.label);
      }
      writeJson("metadata-verdict.json", metadata);
      verdict.metadataScenariosPassed = 6;
    }
  }
  const behavior = JSON.parse(fs.readFileSync(path.join(behaviorDirectory, "verdict.json"), "utf8"));
  assert.deepEqual(behavior.binding, sourceBinding);
  assert.equal(behavior.schema, "openclaw-pr-132266-gateway-progress-proof-v2");
  assert.equal(behavior.runtime, "node/tsx");
  assert.equal(behavior.status, "pass");
  for (const key of ["expectedScenarios", "executedScenarios", "passedScenarios"]) assert.equal(behavior[key], 5, key);
  assert.deepEqual(behavior.results.map((row) => row.id), binding.expectedScenarioIds);
  assert.ok(behavior.results.every((row) => row.status === "pass"));
  for (const key of ["invariantErrors", "providerErrors", "cleanupErrors"]) assert.deepEqual(behavior[key], [], key);
  assert.equal(verdict.metadataScenariosPassed, 6);
  assert.deepEqual(behavior.ownerBoundaryEvidence, {
    kind: "same-head-metadata-phase",
    head: expectedHead,
    harnessSHA256: binding.metadataHarnessSHA256,
    verdictSHA256: sha256(fs.readFileSync(path.join(output, "metadata-verdict.json"))),
    scenarios: binding.metadataScenarioIds,
  });
  assert.ok(behavior.fixture.factories > 0);
  assert.equal(behavior.providerRequests.length, 10);
  assert.equal(behavior.fixture.executions.length, 5);
  Object.assign(verdict, { passed: true, fullProofCompleted: true, phase: "complete", permanentTestsPassed: binding.unitSuites.reduce((sum, suite) => sum + suite.expectedTests, 0), gatewayScenariosPassed: 5, metadataScenariosPassed: 6 });
} catch (error) {
  Object.assign(verdict, { passed: false, fullProofCompleted: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null });
} finally {
  try {
    if (before && snapshot) {
      const after = await snapshot(overlayCreated);
      assert.deepEqual(after, before);
      writeJson("source-after.json", after);
      verdict.sourceUnchanged = true;
    }
  } catch (error) { verdict.cleanupErrors.push("source verification: " + String(error)); }
  try {
    if (overlayCreated) {
      assert.equal(sha256(fs.readFileSync(proofPath)), binding.proofTestSHA256);
      fs.unlinkSync(proofPath);
      verdict.proofOverlayRemoved = true;
    }
    if (output) {
      fs.rmSync(path.join(output, "runtime"), { recursive: true, force: true });
      verdict.runtimeHomesRemoved = true;
    }
  } catch (error) { verdict.cleanupErrors.push("owned scratch cleanup: " + String(error)); }
  if (verdict.cleanupErrors.length) Object.assign(verdict, { passed: false, fullProofCompleted: false });
  let receipt = { ...verdict, head: expectedHead, artifact: null };
  try {
    assert.ok(output, "No safe receipt directory created");
    writeJson("proof-verdict.json", { ...verdict, head: expectedHead });
    const names = ["proof-verdict.json", "requested-binding.json", "source-binding.json", "source-after.json", "proof.test.ts", "metadata-after.mjs", "metadata-verdict.json", "behavior/verdict.json", "behavior/report.md", "behavior/startup-timeline.jsonl", ...phaseNames.flatMap((name) => [`${name}.stdout`, `${name}.stderr`, `${name}.json`, `${name}-result.json`])].filter((name) => fs.existsSync(path.join(output, name)));
    const entries = names.map((name) => ({ name, stats: fs.lstatSync(path.join(output, name)) }));
    assert.ok(entries.every(({ stats }) => stats.isFile()));
    assert.ok(entries.every(({ name, stats }) => name !== "behavior/startup-timeline.jsonl" || stats.size <= 4 * 1024 * 1024), "Startup timeline exceeds 4 MiB");
    assert.ok(entries.reduce((sum, { stats }) => sum + stats.size, 0) <= 64 * 1024 * 1024, "Proof exceeds 64 MiB envelope");
    fs.closeSync(fs.openSync(archive, "wx", 0o600));
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", output, ...names], { stdio: "ignore" });
    receipt = { ...verdict, head: expectedHead, artifact: archive, artifactSHA256: sha256(fs.readFileSync(archive)), artifactBytes: fs.statSync(archive).size };
  } catch (error) {
    Object.assign(verdict, { passed: false, fullProofCompleted: false, artifactError: String(error) });
    receipt = { ...verdict, head: expectedHead, artifact: null };
  }
  console.log("TOOL_METADATA_PROOF_RECEIPT " + JSON.stringify(receipt));
}
process.exitCode = verdict.passed ? 0 : 1;
