import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// Hash every index byte as it arrives; never retain the full repository listing.
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archive = "/tmp/openclaw-127959-gateway-quote-proof.tgz";
let output = null;
let expectedHead = null;
let stdout;
let stderr;
let verdict = { passed: false, testStarted: false, fullProofCompleted: false };
const writeJson = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
try {
  const inputs = process.argv.slice(1);
  expectedHead = inputs[0];
  assert.match(expectedHead ?? "", /^[0-9a-f]{40}$/);
  const binding = JSON.parse(inputs[1]);
  assert.equal(binding.candidateHead, expectedHead);
  const sourceHashes = binding.candidateFileSHA256;
  const proofBytes = Buffer.from(inputs[2], "base64");
  assert.equal(sha256(proofBytes), binding.proofTestSHA256);
  assert.equal(process.platform, "linux");
  assert.equal(process.version, "v24.19.0");
  process.umask(0o077);
  const root = fs.realpathSync(process.cwd());
  output = fs.realpathSync(fs.mkdtempSync("/tmp/openclaw-127959-quote-proof-"));
  assert.equal(fs.lstatSync(output).mode & 0o777, 0o700);
  verdict.head = expectedHead;
  const git = (...args) => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  const proofRelativePath = "extensions/whatsapp/src/quoted-message.gateway-proof.test.ts";
  assert.equal(binding.proofTestRemotePath, proofRelativePath);
  const proofPath = path.join(root, proofRelativePath);
  assert.equal(fs.realpathSync(path.dirname(proofPath)), path.join(root, "extensions/whatsapp/src"));
  assert.equal(spawnSync("/usr/bin/git", ["ls-files", "--error-unmatch", "--", proofRelativePath], { cwd: root, stdio: "ignore" }).status, 1, "Proof overlay must be untracked");
  assert.ok(!fs.existsSync(proofPath), "Do not replace any existing file");
  const snapshot = async (withProof) => {
    assert.equal(git("rev-parse", "HEAD"), expectedHead);
    assert.equal(git("rev-parse", "HEAD^{tree}"), binding.candidateTree);
    for (const args of [["diff", "--no-ext-diff", "--quiet"], ["diff", "--cached", "--no-ext-diff", "--quiet"]]) {
      assert.equal(spawnSync("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, stdio: "ignore" }).status, 0, "Tracked source/index changed");
    }
    for (const [name, hash] of Object.entries(sourceHashes)) {
      assert.ok(!path.isAbsolute(name) && !name.split("/").includes(".."));
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.equal(sha256(fs.readFileSync(path.join(root, name))), hash, name);
    }
    if (withProof) {
      assert.equal(sha256(fs.readFileSync(proofPath)), binding.proofTestSHA256);
      assert.equal(spawnSync("/usr/bin/git", ["ls-files", "--error-unmatch", "--", proofRelativePath], { cwd: root, stdio: "ignore" }).status, 1);
    }
    return { head: expectedHead, tree: git("rev-parse", "HEAD^{tree}"), index: await hashIndexEntries(root), sourceHashes, installedLockSHA256: sha256(fs.readFileSync(path.join(root, "node_modules/.pnpm/lock.yaml"))) };
  };
  const before = await snapshot(false);
  const baileysRoot = fs.realpathSync(path.join(root, "extensions/whatsapp/node_modules/baileys"));
  assert.ok(baileysRoot.startsWith(root + path.sep));
  const checkBaileys = () => {
    const hashes = {};
    for (const { path: name, sha256: expected } of binding.baileys.inspectedFiles) {
      assert.ok(!path.isAbsolute(name) && !name.split("/").includes(".."));
      hashes[name] = sha256(fs.readFileSync(path.join(baileysRoot, name)));
      assert.equal(hashes[name], expected, "Installed Baileys " + name);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(baileysRoot, "package.json"), "utf8")).version, binding.baileys.version);
    return { version: binding.baileys.version, hashes };
  };
  const installedBaileys = checkBaileys();
  assert.equal(binding.provider, "github-actions");
  assert.equal(binding.executionEnvironment, "github-hosted");
  assert.equal(process.execPath, binding.nodeExecutable);
  assert.equal(process.env.COREPACK_HOME, binding.corepackHome);
  fs.writeFileSync(proofPath, proofBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(output, "proof.test.ts"), proofBytes, { flag: "wx", mode: 0o600 });
  const home = path.join(output, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const proofOutput = path.join(output, "behavior");
  fs.mkdirSync(proofOutput, { mode: 0o700 });
  const env = { PATH: binding.environmentPath, HOME: home, CI: "1", COREPACK_HOME: process.env.COREPACK_HOME, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", OPENCLAW_QUOTE_PROOF_DIR: proofOutput, OPENCLAW_QUOTE_PROOF_BINDING: path.join(output, "source-binding.json") };
  for (const [key, name] of Object.entries({ TMPDIR: "tmp", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data", OPENCLAW_STATE_DIR: "state" })) {
    env[key] = path.join(home, name);
    fs.mkdirSync(env[key], { mode: 0o700 });
  }
  const command = [process.execPath, "scripts/run-vitest.mjs", "run", "--config", "test/vitest/vitest.extension-whatsapp.config.ts", proofRelativePath, "--reporter=default", "--reporter=json", `--outputFile=${path.join(output, "vitest.json")}`];
  assert.deepEqual(command.slice(1, 6), binding.commandSuffix);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.packageManager, binding.packageManager);
  const sourceBinding = { ...before, command, proofTest: { path: proofRelativePath, sha256: binding.proofTestSHA256, tracked: false }, expectedScenarioIds: binding.expectedScenarioIds, packageManager: pkg.packageManager, nodeVersion: process.version, envNames: Object.keys(env), dependencyExecution: "fresh frozen-lockfile install by hash-bound hosted controller", installedBaileys, provider: "github-actions", executionEnvironment: "github-hosted", hostedProvenance: binding.hostedProvenance, hydrate: false };
  writeJson("requested-binding.json", binding);
  writeJson("source-binding.json", sourceBinding);
  stdout = fs.openSync(path.join(output, "test.stdout"), "wx", 0o600);
  stderr = fs.openSync(path.join(output, "test.stderr"), "wx", 0o600);
  console.log("PROOF_PHASE:gateway_whatsapp_quote_proof");
  verdict.testStarted = true;
  const started = performance.now();
  const result = spawnSync(command[0], command.slice(1), { cwd: root, env, stdio: ["ignore", stdout, stderr], timeout: 1_200_000, killSignal: "SIGTERM" });
  Object.assign(verdict, { command, exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null, durationMs: Math.round(performance.now() - started) });
  const after = await snapshot(true);
  assert.deepEqual(after, before);
  assert.deepEqual(checkBaileys(), installedBaileys);
  writeJson("source-after.json", { ...after, proofTest: sourceBinding.proofTest, installedBaileys });
  verdict.sourceUnchanged = true;
  const behavior = JSON.parse(fs.readFileSync(path.join(proofOutput, "verdict.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(output, "vitest.json"), "utf8"));
  assert.deepEqual(behavior.binding, sourceBinding);
  assert.equal(behavior.schema, "openclaw-pr-127959-gateway-quote-proof-v1");
  assert.deepEqual(behavior.cases.map((item) => item.name), binding.expectedScenarioIds);
  assert.equal(behavior.expectedScenarios, 8);
  assert.equal(behavior.executedScenarios, 8);
  assert.equal(behavior.passedScenarios, 8);
  assert.equal(behavior.status, "pass");
  assert.equal(behavior.setupError, null);
  assert.deepEqual(behavior.cleanupErrors, []);
  assert.ok(behavior.cases.every((item) => item.status === "pass" && item.observations.length === 1));
  assert.equal(report.success, true);
  assert.equal(report.numTotalTests, 1);
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.testResults[0].assertionResults.length, 1);
  assert.equal(report.testResults[0].assertionResults[0].status, "passed");
  assert.equal(result.status, 0);
  Object.assign(verdict, { passed: true, fullProofCompleted: true, scenarioIds: binding.expectedScenarioIds, scenariosPassed: 8, vitestTestsPassed: 1, proofTestSHA256: binding.proofTestSHA256 });
} catch (error) {
  verdict = { ...verdict, head: expectedHead, passed: false, fullProofCompleted: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null };
} finally {
  let receipt = { ...verdict, artifact: null };
  try {
    if (stdout !== undefined) fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
    if (output === null) throw new Error("No safe receipt directory was created");
    const names = ["requested-binding.json", "source-binding.json", "source-after.json", "proof.test.ts", "test.stdout", "test.stderr", "vitest.json", "behavior/verdict.json", "behavior/report.md"].filter((name) => fs.existsSync(path.join(output, name)));
    const entries = names.map((name) => ({ name, stats: fs.lstatSync(path.join(output, name)) }));
    assert.ok(entries.every(({ stats }) => stats.isFile()));
    assert.ok(entries.reduce((sum, { stats }) => sum + stats.size, 0) <= 64 * 1024 * 1024, "Proof exceeds 64 MiB artifact envelope");
    writeJson("proof-verdict.json", verdict);
    assert.ok(!fs.existsSync(archive), "Do not overwrite another proof archive");
    fs.closeSync(fs.openSync(archive, "wx", 0o600));
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", output, "proof-verdict.json", ...names], { stdio: "ignore" });
    receipt = { ...verdict, artifact: archive, artifactSHA256: sha256(fs.readFileSync(archive)), artifactBytes: fs.statSync(archive).size };
  } catch (error) {
    verdict = { ...verdict, passed: false, artifactError: error instanceof Error ? error.message : String(error) };
    receipt = { ...verdict, artifact: null };
  }
  console.log("GATEWAY_QUOTE_PROOF_RECEIPT " + JSON.stringify(receipt));
}
process.exitCode = verdict.passed ? 0 : 1;
