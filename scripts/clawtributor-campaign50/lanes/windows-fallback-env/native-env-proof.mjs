import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const [targetDir, evidenceDir] = process.argv.slice(2);
assert.equal(process.platform, "win32", "Actual Windows is required");
assert.ok(targetDir && evidenceDir, "Target and evidence directories are required");
const load = (relative) => import(pathToFileURL(path.join(targetDir, relative)).href);
const { buildTaskScript, encodeWindowsLauncherScript } = await load(
  "src/daemon/schtasks-layout.ts",
);
const { startStartupEntry } = await load("src/daemon/schtasks-runtime.ts");
const { collectConfigServiceEnvVars } = await load("src/config/config-env-vars.ts");

const CASE = "OPENCLAW_TEST_FALLBACK_CASE";
const CONTROL = "OPENCLAW_TEST_FALLBACK_CONTROL";
const PARENT = "OPENCLAW_TEST_FALLBACK_PARENT";
const ownedKeys = new Set([CASE, CONTROL, PARENT]);
assert.deepEqual(
  Object.keys(process.env).filter((key) => ownedKeys.has(key.toUpperCase())),
  [],
);
const pathHash = (value) =>
  createHash("sha256")
    .update(value ?? "")
    .digest("hex");
const parentPathHash = pathHash(process.env.PATH);
const cases = [
  {
    name: "case-collision",
    parentKey: CASE,
    configuredKey: CASE.toLowerCase(),
    expected: "configured",
  },
  { name: "same-case", parentKey: CASE, configuredKey: CASE, expected: "configured" },
  {
    name: "reverse-case",
    parentKey: CASE.toLowerCase(),
    configuredKey: CASE,
    expected: "configured",
  },
  { name: "new-key", configuredKey: CASE, expected: "configured" },
  { name: "inherited-key", parentKey: CASE, expected: "inherited" },
  {
    name: "path-excluded",
    parentKey: CASE,
    configuredKey: CASE,
    expected: "configured",
    excludedPath: true,
  },
];
const childSource = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const [outputPath, nonce] = process.argv.slice(2);
const observed = {
  nonce,
  pid: process.pid,
  platform: process.platform,
  nodeVersion: process.versions.node,
  value: process.env[${JSON.stringify(CASE)}] ?? null,
  keys: Object.keys(process.env).filter((key) => key.toUpperCase() === ${JSON.stringify(CASE)}),
  control: process.env[${JSON.stringify(CONTROL)}] ?? null,
  parentOnly: process.env[${JSON.stringify(PARENT)}] ?? null,
  pathHash: crypto.createHash("sha256").update(process.env.PATH ?? "").digest("hex"),
};
fs.writeFileSync(outputPath + ".tmp", JSON.stringify(observed));
fs.renameSync(outputPath + ".tmp", outputPath);
`;

async function waitForReport(file) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    assert.ok(Date.now() < deadline, "Owned child did not exit before fixture cleanup");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const results = [];
try {
  for (const testCase of cases) {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw fallback env "));
    let childExited = false;
    const output = new PassThrough();
    let serviceOutput = "";
    output.on("data", (chunk) => {
      serviceOutput += chunk.toString();
    });
    try {
      if (testCase.parentKey) process.env[testCase.parentKey] = "inherited";
      process.env[PARENT] = "parent-preserved";
      const parentKeys = Object.keys(process.env).filter((key) => key.toUpperCase() === CASE);
      assert.deepEqual(parentKeys, testCase.parentKey ? [testCase.parentKey] : []);
      const configVars = {
        [CONTROL]: "control",
        ...(testCase.configuredKey ? { [testCase.configuredKey]: "configured" } : {}),
      };
      const environment = collectConfigServiceEnvVars({ env: { vars: configVars } });
      assert.deepEqual(
        environment,
        configVars,
        "Fixture variables must pass unchanged service filtering",
      );
      if (testCase.excludedPath) environment.PATH = "Z:\\must-not-be-snapshotted";
      const nonce = randomUUID();
      const reportPath = path.join(fixtureDir, "child-result.json");
      const childPath = path.join(fixtureDir, "report-env.cjs");
      const scriptPath = path.join(fixtureDir, "gateway.cmd");
      await fs.writeFile(childPath, childSource);
      const launcher = buildTaskScript({
        programArguments: [process.execPath, childPath, reportPath, nonce],
        workingDirectory: fixtureDir,
        environment,
      });
      await fs.writeFile(
        scriptPath,
        encodeWindowsLauncherScript({ format: "cmd", content: launcher }),
      );
      await startStartupEntry({ OPENCLAW_TASK_SCRIPT: scriptPath }, output);
      const observed = await waitForReport(reportPath);
      assert.equal(observed.nonce, nonce);
      assert.equal(observed.platform, "win32");
      assert.equal(observed.nodeVersion, process.versions.node);
      assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
      await waitForExit(observed.pid);
      childExited = true;
      assert.equal(observed.control, "control");
      assert.equal(observed.parentOnly, "parent-preserved");
      assert.equal(observed.pathHash, parentPathHash);
      const caseResult = {
        name: testCase.name,
        parentKeys,
        configuredKeys: Object.keys(configVars),
        expected: testCase.expected,
        observed,
        childExited,
        serviceOutput,
        passed: observed.value === testCase.expected,
      };
      results.push(caseResult);
      await fs.writeFile(
        path.join(evidenceDir, `${testCase.name}.json`),
        JSON.stringify(caseResult, null, 2),
      );
    } finally {
      output.end();
      for (const key of Object.keys(process.env)) {
        if (ownedKeys.has(key.toUpperCase())) delete process.env[key];
      }
      if (childExited) await fs.rm(fixtureDir, { recursive: true });
    }
  }
  const report = {
    sourceSha: process.env.SOURCE_SHA,
    platform: process.platform,
    nodeVersion: process.versions.node,
    parentPathHash,
    results,
    failures: results.filter((result) => !result.passed).map((result) => result.name),
  };
  await fs.writeFile(
    path.join(evidenceDir, "native-env-results.json"),
    JSON.stringify(report, null, 2),
  );
  assert.deepEqual(report.failures, [], "PR122658_ENV_OVERRIDE_LOST");
  console.log("All six native fallback environment cases passed");
} catch (error) {
  await fs.writeFile(
    path.join(evidenceDir, "native-env-error.json"),
    JSON.stringify(
      {
        name: error.name,
        message: error.message,
        code: error.code ?? null,
        stack: error.stack,
        completedCases: results.length,
      },
      null,
      2,
    ),
  );
  throw error;
}
