import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

// Run from the exact source checkout with Node 24 and --import tsx.
const expected = process.argv[2];
assert.ok(expected === "baseline" || expected === "candidate");
assert.notEqual(process.getuid?.(), 0, "EACCES proof requires an unprivileged runner");
assert.notEqual(process.platform, "win32", "permission proof requires POSIX permissions");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "config-rejection-proof-")));
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_STATE_DIR = path.join(root, "process-state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "process-config.json");
const { createConfigIO, resetConfigRuntimeState } = await import(
  pathToFileURL(path.join(process.cwd(), "src/config/io.ts")).href
);
const { readRecentConfigAuditRecords } = await import(
  pathToFileURL(path.join(process.cwd(), "src/config/io.audit.ts")).href
);
const observations = [];
try {
  for (const outcome of ["success", "EACCES", "EEXIST", "explicit-destructive"] as const) {
    const caseHome = path.join(root, outcome);
    const configDir = path.join(caseHome, "config");
    const configPath = path.join(configDir, "openclaw.json");
    const stateDir = path.join(caseHome, "state");
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const original = { gateway: { mode: "local" } };
    const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
    await fs.writeFile(configPath, originalRaw, { mode: 0o600 });
    const warnings: string[] = [];
    const env = { HOME: caseHome, OPENCLAW_HOME: caseHome, OPENCLAW_STATE_DIR: stateDir };
    const io = createConfigIO({
      configPath,
      homedir: () => caseHome,
      env,
      observe: false,
      pluginValidation: "skip",
      logger: { warn: (message: unknown) => warnings.push(String(message)), error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    assert.equal(snapshot.valid, true, JSON.stringify(snapshot.issues));
    const rejectedPath = `${configPath}.rejected.2026-09-05T12-00-00-000Z`;
    const collisionBytes = "previous rejected payload\n";
    if (outcome === "EEXIST") {
      await fs.writeFile(rejectedPath, collisionBytes, { mode: 0o600 });
    }
    if (outcome === "EACCES") {
      await fs.chmod(configDir, 0o500);
    }
    let failure: unknown;
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T12:00:00.000Z") });
    try {
      await io.writeConfigFile(
        { update: { channel: "beta" } },
        {
          baseSnapshot: snapshot,
          skipPluginValidation: true,
          allowDestructiveWrite: outcome === "explicit-destructive",
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      mock.timers.reset();
      await fs.chmod(configDir, 0o700);
    }
    const actualRaw = await fs.readFile(configPath, "utf8");
    const artifacts = (await fs.readdir(configDir)).filter((entry) => entry.includes(".rejected."));
    if (outcome === "explicit-destructive") {
      assert.equal(failure, undefined);
      assert.equal(JSON.parse(actualRaw).update.channel, "beta");
      assert.equal(await fs.readFile(`${configPath}.bak`, "utf8"), originalRaw);
      assert.deepEqual(artifacts, []);
      observations.push({ outcome, committed: true, originalBackupIntact: true });
      continue;
    }
    assert.ok(failure instanceof Error);
    assert.equal(failure.code, "CONFIG_WRITE_REJECTED");
    assert.deepEqual(failure.reasons, ["gateway-mode-removed"]);
    assert.equal(actualRaw, originalRaw);
    assert.deepEqual(warnings, [failure.message]);
    const audit = readRecentConfigAuditRecords({ env, homedir: () => caseHome, limit: 10 }).find(
      (record) => record.event === "config.write" && record.configPath === configPath,
    );
    assert.ok(audit, "write refusal must remain visible in the canonical audit store");
    assert.equal(audit.result, "rejected");
    assert.equal(audit.errorCode, "CONFIG_WRITE_REJECTED");
    assert.equal(audit.errorMessage, failure.message);
    assert.equal(audit.nextHash, null);
    assert.equal(audit.nextBytes, null);
    const saved = outcome === "success";
    if (saved || expected === "baseline") {
      assert.equal(failure.rejectedPath, rejectedPath);
      assert.ok(failure.message.includes("Rejected payload saved to"));
    } else {
      if (Object.hasOwn(failure, "rejectedPath")) {
        throw new Error(`CONFIG_REJECTED_SAVE_REGRESSION:${outcome}`);
      }
      assert.ok(failure.message.includes("Rejected payload could not be saved to"));
      assert.ok(failure.message.includes(outcome));
      assert.equal(failure.message.includes("Rejected payload saved to"), false);
    }
    if (saved) {
      assert.equal(JSON.parse(await fs.readFile(rejectedPath, "utf8")).update.channel, "beta");
      assert.equal((await fs.stat(rejectedPath)).mode & 0o777, 0o600);
      assert.equal(artifacts.length, 1);
    } else if (outcome === "EEXIST") {
      assert.equal(await fs.readFile(rejectedPath, "utf8"), collisionBytes);
      assert.equal(artifacts.length, 1);
    } else {
      assert.deepEqual(artifacts, []);
    }
    observations.push({
      outcome,
      originalUnchanged: true,
      reportedSaved: failure.message.includes("Rejected payload saved to"),
      hasRejectedPath: Object.hasOwn(failure, "rejectedPath"),
      rejectedArtifacts: artifacts.length,
      warningMatchesError: true,
      auditMatchesError: true,
      diagnostic: failure.message.replaceAll(root, "<isolated-home>"),
    });
  }
  console.log(
    JSON.stringify(
      { expected, node: process.version, platform: process.platform, observations },
      null,
      2,
    ),
  );
} finally {
  mock.timers.reset();
  resetConfigRuntimeState();
  await fs.rm(root, { recursive: true, force: true });
}
