import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Remote-only synthetic proof. This file never supplies an owner flag to a writer.
const [sourceDir, proofDir, arm] = process.argv.slice(2);
assert.ok(sourceDir && proofDir);
assert.ok(arm === "baseline" || arm === "candidate");
const artifactDir = path.join(proofDir, "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(proofDir, "owned-session-fixture-"));
const observations = { arm, syntheticHistoricalRows: 4097, commands: [] };
const save = (name, value) =>
  fs.writeFileSync(path.join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`);
const cli = path.join(sourceDir, "openclaw.mjs");
const agentId = "proof";
const sdk = (name) =>
  import(pathToFileURL(path.join(sourceDir, "dist", "plugin-sdk", `${name}.js`)).href);
const { runCommandWithTimeout } = await sdk("process-runtime");
let cleanupConfirmed = true;
const activeCommands = new Set();

async function runOwned(scope, argv, timeoutMs) {
  const pending = runCommandWithTimeout(argv, {
    cwd: sourceDir,
    baseEnv: {},
    env: scope.env,
    input: "",
    timeoutMs,
    killProcessTree: true,
    maxOutputBytes: 8 * 1024 * 1024,
    terminateOnOutputLimit: true,
  });
  activeCommands.add(pending);
  try {
    const result = await pending;
    if (!["normal", "cooperative", "forced"].includes(result.cleanup)) {
      cleanupConfirmed = false;
    }
    assert.notEqual(result.cleanup, "uncertain", "owned process cleanup is uncertain");
    return result;
  } catch (error) {
    if (!["normal", "cooperative", "forced"].includes(error?.cleanup)) {
      cleanupConfirmed = false;
    }
    throw error;
  } finally {
    activeCommands.delete(pending);
  }
}

function makeScope(name, backendPath) {
  const dir = path.join(fixtureRoot, name);
  const state = path.join(dir, "state");
  const workspace = path.join(dir, "workspace");
  const configPath = path.join(dir, "openclaw.json");
  for (const child of ["home", "config", "cache", "tmp", "workspace", "state"]) {
    fs.mkdirSync(path.join(dir, child), { recursive: true });
  }
  const config = {
    agents: {
      entries: { proof: { workspace, ...(backendPath ? { model: "fixture-cli/fixture" } : {}) } },
    },
    memory: { search: { provider: "none" } },
    plugins: {
      allow: ["memory-core", ...(backendPath ? ["fixture-cli"] : [])],
      ...(backendPath ? { load: { paths: [backendPath] } } : {}),
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    dir,
    state,
    workspace,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, "home"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      TMPDIR: path.join(dir, "tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  };
}

async function runCli(scope, label, args) {
  const startedAt = Date.now();
  const result = await runOwned(scope, [process.execPath, cli, ...args], 180_000);
  // Detailed diagnostics stay on the ephemeral runner; only structured observations upload.
  const observation = {
    label,
    exit: result.code,
    signal: result.signal,
    cleanup: result.cleanup,
    termination: result.termination,
    elapsedMs: Date.now() - startedAt,
  };
  observations.commands.push(observation);
  save("observations.json", observations);
  assert.equal(result.termination, "exit", `${label} did not finish normally`);
  assert.equal(result.code, 0, `${label} failed`);
  assert.equal(result.stdoutTruncatedBytes, undefined, `${label} JSON was truncated`);
  const parsed = JSON.parse(result.stdout);
  if (Number.isSafeInteger(parsed.candidateCount)) {
    observation.candidateCount = parsed.candidateCount;
  }
  save("observations.json", observations);
  return parsed;
}

async function sessionEvents(scope, sessionId, sessionKey) {
  // A joined read-only observer process also releases its SDK-owned DB handles at exit.
  const observer = path.join(scope.dir, "read-events.mjs");
  const runtimeUrl = pathToFileURL(
    path.join(sourceDir, "dist", "plugin-sdk", "session-transcript-runtime.js"),
  ).href;
  fs.writeFileSync(
    observer,
    `import { readSessionTranscriptEvents } from ${JSON.stringify(runtimeUrl)};
const events = await readSessionTranscriptEvents(JSON.parse(process.argv[2]));
process.stdout.write(JSON.stringify(events));\n`,
  );
  const params = {
    agentId,
    sessionId,
    sessionKey,
    storePath: path.join(scope.state, "agents", agentId, "sessions", "sessions.json"),
  };
  const result = await runOwned(
    scope,
    [process.execPath, observer, JSON.stringify(params)],
    30_000,
  );
  assert.equal(result.termination, "exit");
  assert.equal(result.code, 0, "canonical transcript observer failed");
  assert.equal(result.stdoutTruncatedBytes, undefined);
  return JSON.parse(result.stdout);
}

function createBackend() {
  const pluginDir = path.join(fixtureRoot, "owner-producer-plugin");
  const executableDir = path.join(pluginDir, "fixture-cli");
  fs.mkdirSync(executableDir, { recursive: true });
  fs.writeFileSync(
    path.join(executableDir, "package.json"),
    JSON.stringify({
      name: "@openclaw-proof/owner-cli",
      version: "1.0.0",
      type: "module",
      bin: { "fixture-cli": "./index.mjs" },
    }),
  );
  const executable = path.join(executableDir, "index.mjs");
  fs.writeFileSync(
    executable,
    '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write("Acknowledged the ordinary note.\\n"));\n',
  );
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw-proof/owner-producer",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture-cli",
      name: "Synthetic owner-turn fixture",
      cliBackends: ["fixture-cli"],
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  // Standard plugin registration; no transcript, admission, policy, or hook overrides.
  fs.writeFileSync(
    path.join(pluginDir, "index.mjs"),
    `export default { id: 'fixture-cli', name: 'Synthetic owner-turn fixture', register(api) {
    api.registerCliBackend({ id: 'fixture-cli', nativeToolMode: 'none', bundleMcp: false,
      runtimeArtifact: { kind: 'bundled-package-tree', packageName: '@openclaw-proof/owner-cli', entrypoint: 'command' },
      config: { command: ${JSON.stringify(executable)}, input: 'stdin', output: 'text', sessionMode: 'none', systemPromptWhen: 'never' }
    });
  }};\n`,
  );
  return pluginDir;
}

function writeLegacy(scope, sessionId, sessionKey, header, messages) {
  const sessionsDir = path.join(scope.state, "agents", agentId, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
  const stamp = new Date(
    Math.min(...messages.map((message) => new Date(message.timestamp).getTime())),
  ).toISOString();
  const records = [{ ...header, id: sessionId, cwd: scope.workspace, timestamp: stamp }];
  let parentId = null;
  for (const [index, message] of messages.entries()) {
    const id = `synthetic-message-${index}`;
    records.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    });
    parentId = id;
  }
  fs.writeFileSync(transcript, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [sessionKey]: { sessionId, updatedAt: Date.now(), sessionFile: transcript },
    }),
  );
}

async function importAndInspect(scope, label) {
  const selector = ["--session-sqlite-agent", agentId, "--json"];
  await runCli(scope, `${label}-dry-run`, ["doctor", "--session-sqlite", "dry-run", ...selector]);
  await runCli(scope, `${label}-import`, ["doctor", "--session-sqlite", "import", ...selector]);
  return await runCli(scope, `${label}-inspect`, [
    "doctor",
    "--session-sqlite",
    "inspect",
    ...selector,
  ]);
}

async function preview(scope, label) {
  return await runCli(scope, label, ["memory", "session-backfill", "--agent", agentId, "--json"]);
}

function corpusLines(scope) {
  const dir = path.join(scope.workspace, "memory", ".dreams", "session-corpus");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean));
}

try {
  const backend = createBackend();
  const producer = makeScope("producer-sanity", backend);
  const producerId = randomUUID();
  const producerKey = "agent:proof:chat:producer-sanity";
  await runCli(producer, "producer-turn", [
    "agent",
    "--local",
    "--agent",
    agentId,
    "--session-key",
    producerKey,
    "--session-id",
    producerId,
    "--model",
    "fixture-cli/fixture",
    "--message",
    "Owner prefers a quiet reading room.",
    "--json",
  ]);
  const produced = await sessionEvents(producer, producerId, producerKey);
  const header = produced.find((entry) => entry.type === "session");
  const user = produced.find(
    (entry) => entry.type === "message" && entry.message?.role === "user",
  )?.message;
  const assistant = produced.find(
    (entry) => entry.type === "message" && entry.message?.role === "assistant",
  )?.message;
  assert.ok(
    header && user && assistant,
    "ordinary CLI must produce a valid session and complete turn",
  );
  assert.equal(
    user.__openclaw?.senderIsOwner,
    true,
    "ownership must come from the real local-CLI producer",
  );
  assert.equal((await preview(producer, "producer-admission")).candidateCount, 2);

  // Carry only message data produced above, never opaque execution/admission state.
  // This projection retains producer-written provenance verbatim; it never manufactures it.
  const template = (message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.provenance ? { provenance: structuredClone(message.provenance) } : {}),
    ...(message.__openclaw ? { __openclaw: structuredClone(message.__openclaw) } : {}),
  });
  const userTemplate = template(user);
  const assistantTemplate = template(assistant);
  // Fail closed if the small producer carries operational metadata we have not reviewed.
  assert.deepEqual(Object.keys(userTemplate.__openclaw).sort(), ["senderIsOwner"]);
  assert.equal(assistantTemplate.__openclaw, undefined);
  const headerData = { type: header.type, version: header.version };
  assert.equal(headerData.type, "session");
  assert.ok(Number.isInteger(headerData.version));
  save("producer-message-data.json", {
    header: headerData,
    user: userTemplate,
    assistant: assistantTemplate,
  });

  const sanity = makeScope("doctor-sanity");
  const sanityId = randomUUID();
  writeLegacy(sanity, sanityId, "agent:proof:chat:doctor-sanity", headerData, [
    userTemplate,
    assistantTemplate,
  ]);
  await importAndInspect(sanity, "sanity");
  assert.equal(
    (await sessionEvents(sanity, sanityId, "agent:proof:chat:doctor-sanity")).filter(
      (row) => row.type === "message",
    ).length,
    2,
  );
  assert.equal((await preview(sanity, "sanity-admission")).candidateCount, 2);
  observations.producerAndImportSanity = "passed";
  save("observations.json", observations);

  // This is synthetic historical data derived from one real turn, not 4097 live/model turns.
  const scale = makeScope("historical-rollover");
  const scaleId = randomUUID();
  const scaleKey = "agent:proof:chat:historical-rollover";
  const startMs = Date.parse("2026-09-05T09:00:00.000Z");
  const messages = Array.from({ length: 4097 }, (_, index) => ({
    ...structuredClone(userTemplate),
    content: `Ordinary reading preference ${index % 16}.`,
    timestamp: startMs + index,
  }));
  writeLegacy(scale, scaleId, scaleKey, headerData, messages);
  await importAndInspect(scale, "scale");
  assert.equal(
    (await sessionEvents(scale, scaleId, scaleKey)).filter((row) => row.type === "message").length,
    4097,
  );
  const applied = await runCli(scale, "initial-apply", [
    "memory",
    "session-backfill",
    "--agent",
    agentId,
    "--apply",
    "--json",
  ]);
  assert.equal(applied.candidateCount, 4097);
  assert.equal(applied.batchCount, 52);
  assert.equal((await preview(scale, "unchanged-preview")).candidateCount, 0);
  const before = corpusLines(scale);
  assert.equal(before.length, 4097);
  const firstLine = before[0];

  const appendModule = path.join(sourceDir, "dist", "plugin-sdk", "session-transcript-runtime.js");
  // The child is a normal canonical data append, scoped only to the imported fixture.
  const appendScript = path.join(scale.dir, "append.mjs");
  const appendedMessage = {
    ...structuredClone(userTemplate),
    content: "A new ordinary reading preference.",
    timestamp: Date.parse("2026-09-06T09:00:00.000Z"),
  };
  fs.writeFileSync(
    appendScript,
    `import assert from 'node:assert/strict';
import { appendSessionTranscriptMessageByIdentity } from ${JSON.stringify(pathToFileURL(appendModule).href)};
const result = await appendSessionTranscriptMessageByIdentity(${JSON.stringify({ agentId, sessionId: scaleId, sessionKey: scaleKey, storePath: path.join(scale.state, "agents", agentId, "sessions", "sessions.json"), message: appendedMessage })});
assert.equal(result?.appended, true);\n`,
  );
  const appended = await runOwned(scale, [process.execPath, appendScript], 30_000);
  assert.equal(appended.termination, "exit");
  assert.equal(appended.code, 0, "canonical fixture append failed");
  assert.equal(
    (await sessionEvents(scale, scaleId, scaleKey)).filter((row) => row.type === "message").length,
    4098,
  );
  const appendedPreview = await preview(scale, "append-preview");
  const expected = arm === "baseline" ? 2 : 1;
  assert.equal(
    appendedPreview.candidateCount,
    expected,
    "must observe the specific rollover difference",
  );
  const appendedApply = await runCli(scale, "append-apply", [
    "memory",
    "session-backfill",
    "--agent",
    agentId,
    "--apply",
    "--json",
  ]);
  assert.equal(appendedApply.candidateCount, expected);
  assert.equal((await preview(scale, "final-preview")).candidateCount, 0);
  const after = corpusLines(scale);
  assert.equal(after.length, 4097 + expected);
  assert.equal(after.filter((line) => line === firstLine).length, arm === "baseline" ? 2 : 1);
  assert.equal(
    after.filter((line) => line.endsWith("User: A new ordinary reading preference.")).length,
    1,
  );
  observations.rollover = {
    initialCandidates: applied.candidateCount,
    initialBatches: applied.batchCount,
    appendCandidates: appendedPreview.candidateCount,
    corpusRows: after.length,
    firstRowOccurrences: after.filter((line) => line === firstLine).length,
    finalCandidates: 0,
  };
  save("observations.json", observations);
} finally {
  await Promise.allSettled([...activeCommands]);
  observations.cleanupConfirmed = cleanupConfirmed;
  save("observations.json", observations);
  if (cleanupConfirmed) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
