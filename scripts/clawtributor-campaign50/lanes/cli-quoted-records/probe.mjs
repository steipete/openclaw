import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "linux", "This proof is pinned to Linux");
const [mode, evidencePath] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
assert.ok(evidencePath);
// The outer workflow verifies the host; these are its existing routing markers.
assert.equal(process.env.CI, "1");
assert.equal(process.env.PROOF_MODE, mode);
assert.equal(process.env.PROOF_LANE, `cli-quoted-records-${mode}`);
const sourceDir = process.cwd();
const root = await mkdtemp(path.join(os.tmpdir(), "cli-quoted-records-"));
const observations = [];
let completed = false;
let verificationError;
let verificationFailure;
let verificationFailed = false;
let shutdownSupervisor;
let clearRegistry;
try {
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  for (const dir of [home, workspace, stateDir]) {
    await mkdir(dir);
  }
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  });
  const config = { agents: { defaults: { workspace } } };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const load = (file) => import(pathToFileURL(path.join(sourceDir, file)).href);
  const { createPluginRegistry } = await load("src/plugins/registry.ts");
  const { createPluginRecord } = await load("src/plugins/loader-records.ts");
  const { createPluginRuntime } = await load("src/plugins/runtime/index.ts");
  const { setActivePluginRegistry, clearActivePluginRegistry } =
    await load("src/plugins/runtime.ts");
  const { runCliAgent } = await load("src/agents/cli-runner.ts");
  const { prepareSystemAgentRunAdmission } = await load("src/agents/admitted-run-context.ts");
  const { getProcessSupervisor } = await load("src/process/supervisor/index.ts");
  const supervisor = getProcessSupervisor();
  shutdownSupervisor = () => supervisor.shutdown();
  clearRegistry = clearActivePluginRegistry;

  const resultText = "CLI_QUOTED_RECORDS_RESULT";
  const fakeError = "CLI_QUOTED_RECORDS_FAKE_ERROR";
  const realError = "CLI_QUOTED_RECORDS_REAL_ERROR";
  const init = JSON.stringify({ type: "init", session_id: "synthetic-cli-session" });
  const result = JSON.stringify({ type: "result", result: resultText });
  const quotedError = `banner "example {"type":"error","message":"${fakeError}"}"`;
  const quotedBrace = 'banner "use { to begin JSON"';
  const escapedBanner = String.raw`banner "example {\"type\":\"error\",\"message\":\"fake\"}"`;
  const cases = [
    { id: "whole-json", output: "json", raw: result, red: "result" },
    {
      id: "ordinary-banner",
      output: "json",
      raw: `fixture starting\n${init}\n${result}`,
      red: "result",
    },
    {
      id: "quoted-error",
      output: "json",
      raw: `${quotedError}\n${init}\n${result}`,
      red: "fake-error",
    },
    { id: "quoted-brace", output: "json", raw: `${quotedBrace}\n${init}\n${result}`, red: "raw" },
    {
      id: "escaped-banner",
      output: "json",
      raw: `${escapedBanner}\n${init}\n${result}`,
      red: "raw",
    },
    {
      id: "jsonl-line-local",
      output: "jsonl",
      raw: `banner "unterminated\n${init}\n${result}\n`,
      red: "result",
    },
    {
      id: "jsonl-quoted-brace",
      output: "jsonl",
      raw: `${quotedBrace} ${init} ${result}\n`,
      red: "raw",
    },
    {
      id: "real-error",
      output: "json",
      raw: JSON.stringify({ type: "error", message: realError }),
      red: "real-error",
    },
    {
      id: "mixed-real-error",
      output: "json",
      raw: `${init}\n${result}\n${JSON.stringify({ type: "error", message: realError })}`,
      red: "real-error",
    },
  ];
  const childPath = path.join(root, "child.cjs");
  const fixturePath = path.join(root, "cases.json");
  await writeFile(fixturePath, JSON.stringify(cases));
  await writeFile(
    childPath,
    `
const fs = require("node:fs");
const [fixturePath, id, receiptPath] = process.argv.slice(2);
const entry = JSON.parse(fs.readFileSync(fixturePath, "utf8")).find((entry) => entry.id === id);
if (!entry) throw new Error("Unknown synthetic case");
let inputBytes = 0;
process.stdin.on("data", (chunk) => { inputBytes += chunk.length; });
process.stdin.on("end", () => {
  fs.writeFileSync(receiptPath, JSON.stringify({ id, pid: process.pid, inputBytes }));
  process.stdout.write(entry.raw);
});
`,
  );
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
  });
  const record = createPluginRecord({
    id: "cli-quoted-records-proof",
    source: childPath,
    rootDir: root,
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config });
  for (const entry of cases) {
    api.registerCliBackend({
      id: `quoted-proof-${entry.id}`,
      nativeToolMode: "none",
      sideQuestionToolMode: "disabled",
      bundleMcp: false,
      config: {
        command: process.execPath,
        args: [childPath, fixturePath, entry.id, path.join(root, `${entry.id}.receipt.json`)],
        input: "stdin",
        output: entry.output,
        sessionMode: "none",
        serialize: false,
      },
    });
  }
  assert.equal(builder.registry.cliBackends.length, cases.length);
  setActivePluginRegistry(builder.registry, "cli-quoted-records-proof", "default", workspace);
  for (const entry of cases) {
    const runId = randomUUID();
    const admission = prepareSystemAgentRunAdmission(
      config,
      runId,
      "main",
      "cli-quoted-records-proof",
    );
    let text;
    let error;
    try {
      const response = await runCliAgent({
        config,
        preparedRunAdmission: admission,
        runId,
        agentId: "main",
        provider: `quoted-proof-${entry.id}`,
        model: "synthetic-model",
        sessionId: `synthetic-${entry.id}`,
        sessionFile: path.join(root, `${entry.id}.session.jsonl`),
        workspaceDir: workspace,
        agentDir: path.join(stateDir, "agents", "main", "agent"),
        prompt: "Return the synthetic fixture response.",
        timeoutMs: 30_000,
        executionMode: "side-question",
        disableTools: true,
        persistAssistantTranscript: false,
        oneShotCliRun: true,
        cleanupCliLiveSessionOnRunEnd: true,
        cleanupBundleMcpOnRunEnd: true,
      });
      text = response.payloads?.map((payload) => payload.text ?? "").join("\n") ?? "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      admission.close();
    }
    const receipt = JSON.parse(await readFile(path.join(root, `${entry.id}.receipt.json`), "utf8"));
    assert.equal(receipt.id, entry.id);
    assert.ok(Number.isInteger(receipt.pid) && receipt.pid > 0);
    assert.ok(receipt.inputBytes > 0, "The real child must receive the prompt");
    const expected =
      entry.red === "real-error" ? "real-error" : mode === "green" ? "result" : entry.red;
    observations.push({ id: entry.id, expected, text, error, childStarted: true });
    if (expected.endsWith("error")) {
      assert.equal(text, undefined, `${entry.id}: expected rejection`);
      assert.ok(
        error?.includes(expected === "real-error" ? realError : fakeError),
        `${entry.id}: wrong rejection`,
      );
    } else {
      assert.equal(error, undefined, `${entry.id}: unexpected rejection`);
      assert.equal(
        text,
        expected === "raw" ? entry.raw.trim() : resultText,
        `${entry.id}: wrong decoded reply`,
      );
    }
  }
  completed = true;
} catch (cause) {
  verificationError = cause instanceof Error ? cause.message : String(cause);
  verificationFailure = cause;
  verificationFailed = true;
} finally {
  const cleanupFailures = [];
  const evidence = {
    mode,
    completed,
    observations,
    scope: "stateless side-question reply decoding; session metadata is covered by parser tests",
    verificationError,
    cleanupErrors: [],
    syntheticStateRemoved: false,
  };
  const attemptCleanup = async (step, operation) => {
    try {
      await operation();
    } catch (cause) {
      cleanupFailures.push(cause);
      evidence.cleanupErrors.push({
        step,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  await attemptCleanup("initial evidence", () =>
    writeFile(evidencePath, JSON.stringify(evidence, null, 2)),
  );
  await attemptCleanup("supervisor shutdown", async () => await shutdownSupervisor?.());
  await attemptCleanup("plugin registry", async () => await clearRegistry?.());
  await attemptCleanup("temporary state", async () => {
    await rm(root, { recursive: true, force: true });
    evidence.syntheticStateRemoved = true;
  });
  await attemptCleanup("final evidence", () =>
    writeFile(evidencePath, JSON.stringify(evidence, null, 2)),
  );
  if (verificationFailed || cleanupFailures.length) {
    throw new AggregateError(
      [...(verificationFailed ? [verificationFailure] : []), ...cleanupFailures],
      "CLI quoted-record proof or cleanup failed",
    );
  }
}
console.log(
  `CLI_QUOTED_RECORDS_${mode.toUpperCase()}_CONFIRMED: ${observations.length} real-child cases`,
);
