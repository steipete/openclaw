import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [targetDir, evidenceRoot] = process.argv.slice(2);
assert.ok(path.isAbsolute(targetDir) && path.isAbsolute(evidenceRoot));
assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.20.0");
assert.equal(process.env.CI, "1");
assert.equal(process.env.PROOF_MODE, "green");
assert.equal(process.env.PROOF_LANE, "setup-error-installed-pair");
assert.ok(process.geteuid() > 0);
assert.ok(fs.statSync("/usr/bin/strace").isFile());
assert.equal(fs.statSync("/usr/bin/strace").mode & 0o6000, 0);
assert.equal(fs.statSync(process.execPath).mode & 0o6000, 0);
const laneDir = path.dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}
const save = (name, value) => fs.writeFileSync(path.join(evidenceRoot, name), value);
const saveJson = (name, value) => save(name, JSON.stringify(value, null, 2) + "\n");
function checkSources(kind, receipt) {
  const lines = fs
    .readFileSync(path.join(laneDir, `source-${kind}.sha256`), "utf8")
    .trim()
    .split("\n");
  const files = lines.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match);
    const file = path.resolve(targetDir, match[2]);
    assert.ok(file.startsWith(targetDir + path.sep));
    const actual = hash(fs.readFileSync(file));
    assert.equal(actual, match[1], match[2]);
    return { path: match[2], sha256: actual };
  });
  saveJson(receipt, { files, count: files.length });
}
fs.mkdirSync(evidenceRoot, { recursive: true });
checkSources("before", "source-before.json");
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(targetDir, "scripts/lib/managed-child-process.mts"))
);
const proof = {
  source: "5520a73e9115be31d5f710da23e9bd93ecff291f",
  candidate: {
    preservedParent: "7594dc9e58a076f60964b1af6d5a1b24754d887e",
    base: "5520a73e9115be31d5f710da23e9bd93ecff291f",
    patchSha256: "87eb9aca021d99acf3fb192b1efe9ff2dd3f83f56ddeca659e7857a6d59997c1",
  },
  processes: [],
  phases: [],
  cleanupErrors: [],
  unjoinedWork: false,
};
const proofDeadline = Date.now() + 45 * 60_000;
let scratchRoot;
let activeAbort;
let primaryError;
const permissionFiles = [];
const signalHandlers = new Map(
  ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
    signal,
    () => {
      proof.interrupted ??= signal;
      activeAbort?.abort();
    },
  ]),
);
for (const [signal, handler] of signalHandlers) {
  process.on(signal, handler);
}
function combine(first, second, message) {
  return first ? new AggregateError([first, second], message, { cause: second }) : second;
}
async function command(
  id,
  bin,
  args,
  { env, cwd = targetDir, timeoutMs = 90_000, limit = 8 * 1024 * 1024 },
) {
  assert.equal(proof.interrupted, undefined);
  const remainingMs = proofDeadline - Date.now();
  assert.ok(remainingMs > 0, "aggregate installed proof budget exhausted");
  timeoutMs = Math.min(timeoutMs, remainingMs);
  const row = {
    id,
    bin,
    args,
    cwd,
    uid: process.geteuid(),
    joined: false,
    outputBytes: 0,
    startedAt: new Date().toISOString(),
  };
  proof.processes.push(row);
  const chunks = { stdout: [], stderr: [] };
  const abort = new AbortController();
  activeAbort = abort;
  let commandError;
  try {
    row.exitCode = await runManagedCommand({
      bin,
      args,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      timeoutKillGraceMs: 5_000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal: abort.signal,
      abortKillGraceMs: 5_000,
      onSignal(signal) {
        proof.interrupted ??= signal;
      },
      onReady(child) {
        row.pid = child.pid;
        for (const [name, stream] of [
          ["stdout", child.stdout],
          ["stderr", child.stderr],
        ]) {
          stream.on("data", (chunk) => {
            row.outputBytes += chunk.length;
            if (row.outputBytes > limit) {
              row.outputLimit = true;
              abort.abort();
              return;
            }
            try {
              chunks[name].push(chunk);
            } catch (error) {
              commandError = combine(commandError, error, "Capture failed");
              abort.abort();
            }
          });
        }
      },
    });
    row.joined = true;
  } catch (error) {
    commandError = combine(commandError, error, "Command and capture failed");
    row.unjoinedWork = hasUnjoinedWork(error);
    proof.unjoinedWork ||= row.unjoinedWork;
    row.joined = !row.unjoinedWork;
    row.error = {
      name: error.name,
      message: error.message,
      code: error.code,
      processTreeState: error.processTreeState,
    };
  } finally {
    activeAbort = undefined;
    row.finishedAt = new Date().toISOString();
    try {
      save(`${id}.stdout.log`, Buffer.concat(chunks.stdout));
      save(`${id}.stderr.log`, Buffer.concat(chunks.stderr));
      saveJson(`${id}.process.json`, row);
    } catch (error) {
      commandError = combine(commandError, error, "Command and artifact write failed");
    }
  }
  if (commandError) {
    throw commandError;
  }
  assert.equal(proof.interrupted, undefined);
  assert.equal(row.outputLimit ?? false, false);
  assert.equal(row.joined, true);
  assert.equal(typeof row.exitCode, "number");
  return {
    code: row.exitCode,
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
  };
}
async function installedPhase(tarball, phase) {
  assert.ok(fs.lstatSync(tarball).isFile());
  assert.equal(fs.realpathSync(tarball), tarball);
  const observed = { phase, uid: process.geteuid(), cases: [] };
  proof.phases.push(observed);
  const evidenceDir = path.join(evidenceRoot, phase);
  const scratch = path.join(scratchRoot, phase);
  fs.mkdirSync(scratch);
  const run = (name, bin, args, env, timeoutMs) =>
    command(`${phase}/${name}`, bin, args, { env, cwd: work, timeoutMs: timeoutMs ?? 90_000 });
  const prepHome = path.join(scratch, "prepare-home");
  const prefix = path.join(scratch, "install");
  const work = path.join(scratch, "work");
  const tmp = path.join(scratch, "tmp");
  for (const dir of [prepHome, prefix, work, tmp]) {
    fs.mkdirSync(dir);
  }
  const userNpmrc = path.join(prepHome, "user.npmrc");
  const globalNpmrc = path.join(prepHome, "global.npmrc");
  fs.writeFileSync(userNpmrc, "");
  fs.writeFileSync(globalNpmrc, "");
  const prepEnv = {
    PATH: process.env.PATH,
    HOME: prepHome,
    USERPROFILE: prepHome,
    XDG_CONFIG_HOME: path.join(prepHome, "config"),
    TMPDIR: tmp,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LANG: "C.UTF-8",
    TZ: "UTC",
    NPM_CONFIG_USERCONFIG: userNpmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_CACHE: path.join(prepHome, "npm-cache"),
  };
  observed.tarballSha256 = await hashFile(tarball);
  const install = await run(
    "install",
    "npm",
    ["install", "-g", "--prefix", prefix, tarball, "--no-fund", "--no-audit"],
    prepEnv,
    600_000,
  );
  assert.equal(install.code, 0, "normal package installation failed");
  const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
  assert.equal(fs.realpathSync(packageRoot), packageRoot);
  assert.equal(fs.existsSync(path.join(packageRoot, "src")), false, "must use installed output");
  assert.equal(
    fs.existsSync(path.join(packageRoot, "extensions")),
    false,
    "no source plugin fallback",
  );
  assert.equal(
    fs.existsSync(path.join(packageRoot, "dist-runtime")),
    false,
    "ambiguous runtime overlay",
  );
  assert.equal(fs.existsSync(path.join(packageRoot, ".openclaw-lifecycle-pending")), false);
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "openclaw-install-guard")), false);
  const hostManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(hostManifest.name, "openclaw");
  assert.equal(hostManifest.bin.openclaw, "openclaw.mjs");
  const installedRequire = createRequire(path.join(packageRoot, "dist", "index.js"));
  const fsSafeRoot = path.dirname(
    path.dirname(installedRequire.resolve("@openclaw/fs-safe/advanced")),
  );
  assert.ok(fs.realpathSync(fsSafeRoot).startsWith(prefix + path.sep));
  const fsSafePackage = JSON.parse(fs.readFileSync(path.join(fsSafeRoot, "package.json"), "utf8"));
  assert.equal(fsSafePackage.version, "0.8.3");
  const dependencyFiles = {
    "root-file.js": "cc920bdeb8fd900ad0acb1324f1368f5f0e0fcf7cb1edf3182bae5d74bb95f57",
    "pinned-open.js": "e2c8a146aa5145f4d0accae495676dda94b095a0a8947552ceb52f3fc5c755eb",
  };
  for (const [name, expectedHash] of Object.entries(dependencyFiles)) {
    assert.equal(hash(fs.readFileSync(path.join(fsSafeRoot, "dist", name))), expectedHash);
  }
  observed.fsSafe = { version: fsSafePackage.version, files: dependencyFiles };
  const bin = path.join(packageRoot, "openclaw.mjs");
  const runtimeRoot = path.join(packageRoot, "dist", "extensions", "openai");
  assert.equal(fs.realpathSync(runtimeRoot), runtimeRoot);
  const packageFile = path.join(runtimeRoot, "package.json");
  const manifestFile = path.join(runtimeRoot, "openclaw.plugin.json");
  const pluginPackage = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const pluginManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(pluginManifest.id, "openai");
  assert.equal(pluginManifest.enabledByDefault, true);
  assert.ok(pluginManifest.providers.includes("openai"));
  const entries = pluginPackage.openclaw.runtimeExtensions ?? pluginPackage.openclaw.extensions;
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\.\/[a-zA-Z0-9_./-]+\.[cm]?js$/);
  assert.ok(!entries[0].split("/").includes(".."));
  const entry = path.resolve(runtimeRoot, entries[0]);
  assert.equal(fs.realpathSync(entry), entry);
  assert.ok(fs.statSync(entry).isFile());
  const boundFiles = [bin, packageFile, manifestFile, entry];
  const hashes = boundFiles.map((file) => ({
    path: path.relative(packageRoot, file),
    sha256: hash(fs.readFileSync(file)),
  }));
  observed.package = {
    name: hostManifest.name,
    version: hostManifest.version,
    runtimeRoot: path.relative(packageRoot, runtimeRoot),
    entries,
    files: hashes,
  };
  const unreadable = path.join(runtimeRoot, "pr140392-unreadable.txt");
  permissionFiles.push(unreadable);
  assert.equal(fs.existsSync(unreadable), false);
  fs.writeFileSync(unreadable, "Synthetic unreadable artifact data for diagnostic proof.\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.chmodSync(unreadable, 0);
  const stat = fs.lstatSync(unreadable);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.nlink, 1);
  assert.equal(stat.uid, process.geteuid());
  assert.equal(stat.mode & 0o777, 0);
  observed.unreadableFile = {
    name: path.basename(unreadable),
    uid: stat.uid,
    mode: stat.mode & 0o777,
    sameExecutingUid: true,
  };
  const guidance = "Run `openclaw onboard` to connect and live-test AI first.";
  const generic =
    "Could not bind the configured inference plugin runtime. Refresh or reinstall the plugin and retry.";
  const cause = "plugin runtime artifact file is not readable: pr140392-unreadable.txt";
  for (const json of [false, true]) {
    const name = json ? "setup-json" : "setup-text";
    const caseRoot = path.join(scratch, name);
    const home = path.join(caseRoot, "home");
    const state = path.join(caseRoot, "state");
    const workspace = path.join(caseRoot, "workspace");
    const agentDir = path.join(caseRoot, "agent");
    for (const dir of [home, state, workspace, agentDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const configPath = path.join(state, "openclaw.json");
    const config = {
      agents: {
        ownership: "explicit",
        entries: { main: { default: true, workspace, agentDir } },
        defaults: {
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    const configBytes = JSON.stringify(config, null, 2) + "\n";
    fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
    assert.throws(
      () => fs.readFileSync(unreadable),
      (error) => error.code === "EACCES",
    );
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      TMPDIR: tmp,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      LANG: "C.UTF-8",
      TZ: "UTC",
    };
    const tracePath = path.join(evidenceDir, `${name}.trace.log`);
    const args = [bin, "setup", "--message", "status", ...(json ? ["--json"] : [])];
    const output = await run(
      name,
      "/usr/bin/strace",
      [
        "-f",
        "-qq",
        "-s",
        "512",
        "-e",
        "trace=openat,socket,connect,sendto,sendmsg,sendmmsg",
        "-o",
        tracePath,
        process.execPath,
        ...args,
      ],
      env,
    );
    assert.equal(output.code, 1, "setup must fail through normal one-shot exit");
    assert.ok(fs.statSync(tracePath).size <= 8 * 1024 * 1024);
    const trace = fs.readFileSync(tracePath, "utf8");
    const opens = trace
      .split("\n")
      .filter(
        (line) => line.includes(unreadable) && /openat\(/.test(line) && / = -1 EACCES\b/.test(line),
      );
    assert.ok(opens.length > 0, "real installed CLI did not encounter the intended EACCES");
    const connections = trace
      .split("\n")
      .filter(
        (line) =>
          /(?:socket|connect|sendto|sendmsg|sendmmsg)\(/.test(line) && /AF_INET6?\b/.test(line),
      );
    assert.deepEqual(connections, [], "unexpected Internet socket or connection");
    const expected = `OpenClaw requires working inference: ${generic}${phase === "candidate" ? ` (${cause})` : ""}`;
    if (json) {
      const payload = JSON.parse(output.stdout);
      assert.equal(output.stderr, "", "unexpected installed JSON stderr");
      assert.deepEqual(payload, { ok: false, status: "unavailable", error: expected, guidance });
    } else {
      assert.equal(output.stderr, `${expected}\n${guidance}\n`, "wrong installed text output");
      assert.equal(output.stdout, "", "unexpected installed text stdout");
    }
    if (phase === "baseline") {
      assert.ok(!output.stdout.includes(cause) && !output.stderr.includes(cause));
    }
    assert.equal(fs.readFileSync(configPath, "utf8"), configBytes);
    assert.equal(fs.statSync(unreadable).mode & 0o777, 0);
    for (const record of hashes) {
      assert.equal(hash(fs.readFileSync(path.join(packageRoot, record.path))), record.sha256);
    }
    observed.cases.push({
      name,
      json,
      exitCode: 1,
      eaccesInCli: true,
      internetOperations: 0,
      exactError: expected,
      configUnchanged: true,
      packageFilesUnchanged: true,
    });
  }
  observed.caseAssertionsPassed = true;
}
try {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-installed-pair-140392-"));
  const buildHome = path.join(scratchRoot, "build-home");
  const buildTmp = path.join(scratchRoot, "build-tmp");
  fs.mkdirSync(buildHome);
  fs.mkdirSync(buildTmp);
  const buildEnv = {
    PATH: process.env.PATH,
    HOME: buildHome,
    USERPROFILE: buildHome,
    TMPDIR: buildTmp,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LANG: "C.UTF-8",
    TZ: "UTC",
  };
  const git = async (id, args) => {
    const result = await command(id, "git", args, { env: buildEnv });
    assert.equal(result.code, 0, id);
    return result;
  };
  assert.equal((await git("head-before", ["rev-parse", "HEAD"])).stdout.trim(), proof.source);
  await git("clean-before", ["diff", "--quiet"]);
  await git("index-before", ["diff", "--cached", "--quiet"]);
  for (const phase of ["baseline", "candidate"]) {
    fs.mkdirSync(path.join(evidenceRoot, phase), { recursive: true });
    if (phase === "candidate") {
      await git("candidate/apply-check", [
        "apply",
        "--check",
        path.join(laneDir, "candidate.patch"),
      ]);
      await git("candidate/apply", ["apply", path.join(laneDir, "candidate.patch")]);
      checkSources("after", "candidate/source-before-build.json");
      await git("candidate/tracked-before", [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
      ]);
    }
    const packageDir = path.join(scratchRoot, `package-${phase}`);
    const tarball = path.join(packageDir, `openclaw-140392-${phase}.tgz`);
    const packaged = await command(
      `${phase}/package`,
      process.execPath,
      [
        path.join(targetDir, "scripts/package-openclaw-for-docker.mjs"),
        "--allow-unreleased-changelog",
        "--output-dir",
        packageDir,
        "--output-name",
        path.basename(tarball),
      ],
      { env: buildEnv, timeoutMs: 45 * 60_000, limit: 32 * 1024 * 1024 },
    );
    assert.equal(packaged.code, 0, `${phase}: package owner failed`);
    checkSources(phase === "baseline" ? "before" : "after", `${phase}/source-after-package.json`);
    if (phase === "baseline") {
      await git("baseline/clean-after-package", ["diff", "--quiet"]);
    }
    await installedPhase(tarball, phase);
  }
  checkSources("after", "source-after.json");
  const final = await git("candidate/tracked-after", [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
  ]);
  assert.equal(
    final.stdout,
    fs.readFileSync(path.join(evidenceRoot, "candidate/tracked-before.stdout.log"), "utf8"),
  );
  await git("diff-check", ["diff", "--check"]);
  await git("index-after", ["diff", "--cached", "--quiet"]);
  proof.assertionsPassed = true;
} catch (error) {
  primaryError = error;
  proof.unjoinedWork ||= hasUnjoinedWork(error);
  proof.failure = { name: error.name, message: String(error.message).slice(0, 4000) };
} finally {
  if (!proof.unjoinedWork) {
    for (const file of permissionFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.chmodSync(file, 0o600);
        }
      } catch (error) {
        proof.cleanupErrors.push(error.message);
        primaryError = combine(primaryError, error, "Proof and permission cleanup failed");
      }
    }
    try {
      if (scratchRoot) {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      }
      proof.scratchRemoved = !scratchRoot || !fs.existsSync(scratchRoot);
    } catch (error) {
      proof.cleanupErrors.push(error.message);
      primaryError = combine(primaryError, error, "Proof and scratch cleanup failed");
    }
  } else {
    proof.retainedInputsRoot = scratchRoot;
    proof.scratchRemoved = false;
  }
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  for (const phase of proof.phases) {
    phase.scratchRemoved = proof.scratchRemoved;
    phase.complete =
      phase.caseAssertionsPassed === true &&
      proof.scratchRemoved === true &&
      proof.cleanupErrors.length === 0;
    try {
      saveJson(`${phase.phase}/installed-cli-receipt.json`, phase);
    } catch (error) {
      primaryError = combine(primaryError, error, "Proof and phase receipt write failed");
    }
  }
  proof.complete =
    !primaryError &&
    !proof.interrupted &&
    proof.assertionsPassed === true &&
    proof.scratchRemoved === true &&
    proof.cleanupErrors.length === 0;
  try {
    saveJson("installed-pair-receipt.json", proof);
  } catch (error) {
    primaryError = combine(primaryError, error, "Proof and receipt write failed");
  }
}
if (primaryError) {
  throw primaryError;
}
assert.equal(proof.complete, true);
assert.deepEqual(
  proof.phases.map((phase) => [phase.phase, phase.cases.length, phase.complete]),
  [
    ["baseline", 2, true],
    ["candidate", 2, true],
  ],
);
saveJson("complete.json", {
  verdict: "INSTALLED_CLI_CAPTURE_ERROR_PAIR_CONFIRMED",
  baselineCases: 2,
  candidateCases: 2,
  cliInternetOperations: 0,
  ownedScratchRemoved: true,
  scope: "first capture catch only; later owner/callback coverage remains synthetic",
});
console.log("PR140392_INSTALLED_CLI_CAPTURE_PAIR_CONFIRMED");
