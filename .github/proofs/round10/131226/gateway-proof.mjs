// Inert until published and run by the fixed secretless hosted controller.
// This parent uses source QA helpers; the product runs dist/index.js in its own child.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createQaBusState } from "./bus-state.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.js";
import { GatewayClient } from "../../../src/gateway/client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../src/utils/message-channel.js";

const PLUGIN = "qa-tool-media-terminal";
const SPEECH = "qa-terminal-speech";
const SESSION = "agent:qa:tool-media-terminal";
const MODEL = "mock-openai/gpt-5.6-luna";
const SPOKEN = "Runtime parity voice fixture.";
const WAV = "UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROMPT = "Tool search QA check target=tts. Provider HTTP 503 after tool QA check.";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = await fs.realpath(process.cwd());
const output = await fs.realpath(process.env.OPENCLAW_MEDIA_PROOF_DIR);
const binding = JSON.parse(await fs.readFile(process.env.OPENCLAW_MEDIA_PROOF_BINDING, "utf8"));
const buildBytes = await fs.readFile(path.join(output, "runtime-build.json"));
const build = JSON.parse(buildBytes);
assert.equal(build.head, binding.baseHead);
assert.equal(build.sourceIdentity, binding.sourceIdentity);
const save = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
const milestone = (phase) => process.stderr.write(`MEDIA_PROOF_PHASE ${phase}\n`);

// The only injected behavior is a synthetic speech provider. Hooks record facts,
// return nothing, and cannot manufacture pending media, history, or delivery.
const fixtureSource = `
const state = globalThis[Symbol.for("openclaw.proof131226.fixture")] ??= { observations: [], overflow: false };
const observe = value => {
  if (state.observations.length >= 1000) { state.overflow = true; return; }
  state.observations.push(structuredClone(value));
};
module.exports = { id: ${JSON.stringify(PLUGIN)}, register(api) {
  api.registerSpeechProvider({
    id: ${JSON.stringify(SPEECH)}, label: "Synthetic terminal speech", isConfigured: () => true,
    async synthesize(request) {
      observe({kind: "synthesis", text: request.text});
      return {audioBuffer: Buffer.from(${JSON.stringify(WAV)}, "base64"), fileExtension: ".wav", outputFormat: "wav", voiceCompatible: false};
    }
  });
  if (api.registrationMode !== "full") return;
  api.registerGatewayMethod("media-proof.inspect", ({respond}) => {
    respond(true, {...structuredClone(state), runtime: {pid: process.pid, executable: process.execPath, argv: [...process.argv]}});
  }, {scope: "operator.read"});
  api.on("after_tool_call", event => {
    if (event.toolName === "tts") observe({kind: "tool", runId: event.runId, toolCallId: event.toolCallId, error: event.error, media: event.result?.details?.media});
  });
  api.on("reply_payload_sending", event => {
    observe({kind: "reply", sessionKey: event.sessionKey, runId: event.runId, deliveryKind: event.kind, payload: event.payload});
  });
}};
`;

function records(value) {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(records)];
}
function audioRecords(value) {
  return records(value).filter(row => (row.type === "audio" || row.kind === "audio") && typeof row.url === "string" && typeof row.artifactId === "string");
}
async function hashTree(directory) {
  const files = {};
  async function visit(relative) {
    for (const entry of (await fs.readdir(path.join(directory, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `Unexpected staged symlink: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else {
        assert.ok(entry.isFile());
        const bytes = await fs.readFile(path.join(directory, name));
        files[name] = {sha256: hash(bytes), bytes: bytes.length};
      }
    }
  }
  await visit("");
  return files;
}

const owner = createQaLiveLaneGateway();
const busState = createQaBusState();
const transport = createQaChannelTransport(busState);
const errors = [];
const cleanupErrors = [];
const events = [];
let eventOverflow = false;
let bus, harness, client, fixtureRoot, debugDir, stopPromise, stopResult;
let stagedBefore, stagedAfter, childRuntime, observation, downloaded, historySummary;
let interrupted = false;
let rejectInterrupted;
const interruption = new Promise((_, reject) => { rejectInterrupted = reject; });
void interruption.catch(() => {});
const guard = (operation) => {
  if (interrupted) throw new Error("Proof interrupted; no further admission");
  return Promise.race([operation, interruption]);
};
const stop = () => stopPromise ??= owner.stop(debugDir ? {preserveToDir: debugDir} : undefined);
const onTerminate = () => {
  interrupted = true;
  rejectInterrupted(new Error("Proof execution deadline/SIGTERM"));
  // Canonical stop closes child admission before its first await.
  void stop().catch(error => cleanupErrors.push(String(error)));
};
process.once("SIGTERM", onTerminate);

async function connect() {
  let pending, rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    pending = new GatewayClient({
      url: harness.gateway.wsUrl, token: harness.gateway.token,
      origin: new URL(harness.gateway.baseUrl).origin,
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"],
      platform: "qa", requestTimeoutMs: 30_000,
      onEvent(event) { if (events.length < 2000) events.push(event); else eventOverflow = true; },
      onHelloOk: () => resolve(pending), onConnectError: reject,
      onClose: (code, reason) => reject(new Error(`Gateway closed ${code}: ${reason}`)),
    });
    pending.start();
  });
  const timer = setTimeout(() => rejectReady(new Error("Gateway connect timeout")), 20_000);
  try { return await guard(ready); }
  catch (error) { pending?.stop(); throw error; }
  finally { clearTimeout(timer); }
}

async function readStaging() {
  const bundledDir = harness.gateway.runtimeEnv.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const stagedRoot = harness.gateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT;
  assert.ok(stagedRoot?.startsWith(path.join(root, ".artifacts/qa-runtime") + path.sep));
  assert.equal(bundledDir, path.join(stagedRoot, "dist/extensions"));
  const plugins = {};
  const ids = (await fs.readdir(bundledDir)).sort();
  assert.ok(ids.includes("qa-channel") && ids.includes("openai"));
  for (const id of ids) {
    const files = await hashTree(path.join(bundledDir, id));
    for (const [name, fact] of Object.entries(files)) {
      assert.ok(!/(?<!\.d)\.[cm]?tsx?$/.test(name), `Source staged instead of dist: ${id}/${name}`);
      const source = name === "openclaw.plugin.json" ? `extensions/${id}/${name}` : `dist/extensions/${id}/${name}`;
      const expected = name === "openclaw.plugin.json" ? binding.sourceHashes[source] : build.files[source]?.sha256;
      assert.equal(fact.sha256, expected, `Unbound staged bytes: ${source}`);
    }
    plugins[id] = files;
  }
  return {plugins};
}

try {
  milestone("parent-entered");
  const tmp = await fs.realpath(process.env.TMPDIR);
  assert.ok(tmp.startsWith("/tmp/"));
  assert.equal((await fs.stat(tmp)).mode & 0o777, 0o700);
  fixtureRoot = await fs.mkdtemp(path.join(tmp, "media-fixture-"));
  await fs.writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({name: PLUGIN, version: "1.0.0", openclaw: {extensions: ["./index.cjs"]}}));
  await fs.writeFile(path.join(fixtureRoot, "index.cjs"), fixtureSource);
  await fs.writeFile(path.join(fixtureRoot, "openclaw.plugin.json"), JSON.stringify({id: PLUGIN, activation: {onStartup: true}, configSchema: {type: "object", properties: {}, additionalProperties: false}}));
  await fs.mkdir(path.join(root, ".artifacts"), {recursive: true});
  debugDir = await fs.mkdtemp(path.join(root, ".artifacts/proof-131226-debug-"));
  bus = await startQaBusServer({state: busState});
  milestone("gateway-starting");
  harness = await guard(owner.start({
    repoRoot: root, command: {executablePath: process.execPath, argsPrefix: [path.join(root, "dist/index.js")], tempParentDir: tmp}, providerMode: "mock-openai",
    primaryModel: MODEL, alternateModel: MODEL, forcedRuntime: "openclaw",
    transport, transportBaseUrl: bus.baseUrl, controlUiEnabled: false,
    mutateConfig: cfg => ({
      ...cfg, messages: {...cfg.messages, visibleReplies: "automatic"},
      tools: {...cfg.tools, alsoAllow: [...(cfg.tools?.alsoAllow ?? []), "tts"]},
      agents: {...cfg.agents, entries: {...cfg.agents?.entries, qa: {...cfg.agents?.entries?.qa,
        tools: {...cfg.agents?.entries?.qa?.tools, alsoAllow: [...(cfg.agents?.entries?.qa?.tools?.alsoAllow ?? []), "tts"]},
      }}},
      plugins: {...cfg.plugins, allow: [...(cfg.plugins?.allow ?? []), PLUGIN],
        load: {...cfg.plugins?.load, paths: [...(cfg.plugins?.load?.paths ?? []), fixtureRoot]},
        entries: {...cfg.plugins?.entries, [PLUGIN]: {enabled: true}}},
      tts: {...cfg.tts, auto: "off", provider: SPEECH},
    }),
  }));
  assert.ok(harness.mock, "Secretless mock provider must exist");
  const inspect = () => guard(harness.gateway.call("media-proof.inspect", {}, {timeoutMs: 5_000}));
  const initial = await inspect();
  assert.equal(initial.runtime.pid, harness.gateway.pid);
  assert.equal(await fs.realpath(initial.runtime.executable), await fs.realpath(process.execPath));
  assert.equal(initial.runtime.argv[1], path.join(root, "dist/index.js"));
  assert.deepEqual(initial.runtime.argv.slice(2, 4), ["gateway", "run"]);
  assert.equal(initial.overflow, false);
  assert.deepEqual(initial.observations, []);
  childRuntime = {...initial.runtime, buildInventorySHA256: hash(buildBytes)};
  stagedBefore = await readStaging();
  await save("staged-before.json", stagedBefore);
  await guard(transport.waitReady({gateway: harness.gateway}));
  client = await connect();
  const subscription = await guard(client.request("sessions.subscribe", {}));
  assert.equal(subscription?.subscribed, true, "Session subscription must be acknowledged before chat.send");
  milestone("admitting-one-turn");
  const runId = randomUUID();
  const deadline = Date.now() + 90_000;
  await guard(client.request("chat.send", {sessionKey: SESSION, message: PROMPT, deliver: false, idempotencyKey: runId}));
  let terminal, settled;
  while ((!terminal || !settled) && Date.now() < deadline) {
    terminal = events.filter(event => event.event === "chat").map(event => event.payload)
      .find(payload => payload?.runId === runId && ["error", "final", "aborted"].includes(payload.state));
    settled = events.filter(event => event.event === "sessions.changed").map(event => event.payload)
      .find(payload => payload?.sessionKey === SESSION && payload.reason === "chat.run.settled" &&
        payload.lastRunId === runId && payload.hasActiveRun === false);
    if (!terminal || !settled) await guard(new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now())))));
  }
  assert.ok(terminal, "No terminal chat event");
  assert.ok(settled, "No exact settled-session event before the shared 90-second deadline; proof incomplete");
  assert.equal(eventOverflow, false);
  // Native chat.error can precede media finalization. Only chat.run.settled
  // follows awaited dispatch and owner release; a lost event is incomplete proof.
  const response = await guard(fetch(harness.mock.baseUrl + "/debug/requests", {signal: AbortSignal.timeout(5_000)}));
  assert.equal(response.ok, true);
  const requests = await response.json();
  const toolRequests = requests.filter(row => row.prompt.includes(PROMPT) && row.plannedToolName === "tts");
  assert.equal(toolRequests.length, 1, "Require exactly one planned real TTS call");
  assert.equal(toolRequests[0].plannedToolArgs?.text, SPOKEN);
  const failedFollowup = requests.find(row => row.cursor > toolRequests[0].cursor && row.prompt.includes(PROMPT) && row.outcome === "error" && row.toolOutput.includes(SPOKEN));
  assert.ok(failedFollowup, "503 must follow the real completed speech tool output");
  assert.equal(failedFollowup.toolOutputCallId, toolRequests[0].plannedToolCallId);
  const fixture = await inspect();
  assert.equal(fixture.overflow, false);
  const observations = fixture.observations;
  assert.deepEqual(observations.filter(row => row.kind === "synthesis"), [{kind: "synthesis", text: SPOKEN}]);
  const completed = observations.filter(row => row.kind === "tool");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].error, undefined);
  assert.equal(completed[0].media?.trustedLocalMedia, true);
  assert.equal(typeof completed[0].media?.mediaUrl, "string");
  assert.equal(terminal.state, "error", "Media must preserve the authoritative terminal error");
  const history = await guard(client.request("chat.history", {sessionKey: SESSION, limit: 50}));
  const audio = audioRecords(history);
  const mediaReplies = observations.filter(row => row.kind === "reply").map(row => row.payload)
    .filter(payload => payload?.mediaUrl || payload?.mediaUrls?.length);
  observation = {scenario: "tts-wav-then-provider-503", prerequisitesPassed: true,
    ttsCalls: completed.length, failedFollowupReceivedToolOutput: true,
    persistenceBarrier: {subscriptionAcknowledged: true, sessionKey: settled.sessionKey,
      reason: settled.reason, lastRunId: settled.lastRunId, hasActiveRun: settled.hasActiveRun,
      admittedRunId: runId, deadlineMs: 90_000},
    chronology: {plannedTool: {cursor: toolRequests[0].cursor, callId: toolRequests[0].plannedToolCallId},
      failedFollowup: {cursor: failedFollowup.cursor, toolOutputCallId: failedFollowup.toolOutputCallId},
      completedTool: {runId: completed[0].runId, toolCallId: completed[0].toolCallId, trustedLocalMedia: true}},
    terminalState: terminal.state, mediaReplies: mediaReplies.length,
    errorMarkedMediaReplies: mediaReplies.filter(row => row.isError).length,
    persistedAudioArtifacts: audio.length};
  // Do not export temporary download tickets, auth/state, or full runtime config.
  historySummary = {audio: audio.map(row => ({type: row.type ?? row.kind, artifactId: row.artifactId}))};
  if (audio.length === 1) {
    const artifactId = audio[0].artifactId;
    const ticket = await guard(client.request("artifacts.download", {sessionKey: SESSION, artifactId}));
    const url = new URL(ticket.url, harness.gateway.baseUrl);
    assert.equal(url.origin, new URL(harness.gateway.baseUrl).origin);
    const fetched = await guard(fetch(url, {signal: AbortSignal.timeout(5_000)}));
    assert.equal(fetched.ok, true);
    assert.ok(fetched.headers.get("content-type")?.includes("audio/wav"));
    const bytes = Buffer.from(await fetched.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(WAV, "base64"));
    client.stop();
    client = await connect();
    const reloaded = await guard(client.request("chat.history", {sessionKey: SESSION, limit: 50}));
    assert.deepEqual(audioRecords(reloaded).map(row => row.artifactId), [artifactId]);
    downloaded = {sha256: hash(bytes), bytes: bytes.length, reconnectRetained: true};
  }
  stagedAfter = await readStaging();
  assert.deepEqual(stagedAfter, stagedBefore);
  await save("staged-after.json", stagedAfter);
  milestone("observation-complete");
} catch (error) {
  errors.push(String(error));
} finally {
  milestone("cleanup-starting");
  client?.stop();
  await save("child-cleanup.json", {confirmed: false, phase: "stopping", interrupted});
  try {
    const result = await stop();
    stopResult = {process: result.process, errors: result.errors.map(String)};
    cleanupErrors.push(...stopResult.errors);
    assert.notEqual(stopResult.process, "unconfirmed");
    if (harness) assert.equal(stopResult.process, "confirmed-stopped");
    if (debugDir) {
      for (const name of ["gateway.stdout.log", "gateway.stderr.log", "README.txt"]) {
        const bytes = await fs.readFile(path.join(debugDir, name));
        assert.ok(bytes.length <= 4 * 1024 * 1024);
        await fs.writeFile(path.join(output, name), bytes);
      }
      await fs.rm(debugDir, {recursive: true});
    }
  } catch (error) { cleanupErrors.push(String(error)); }
  try { await bus?.stop(); } catch (error) { cleanupErrors.push(String(error)); }
  const confirmed = Boolean(stopResult && stopResult.process !== "unconfirmed" && !cleanupErrors.length);
  if (confirmed && fixtureRoot) {
    try { await fs.rm(fixtureRoot, {recursive: true}); }
    catch (error) { cleanupErrors.push(String(error)); }
  }
  const cleanup = {confirmed, phase: "finished", interrupted, result: stopResult, errors: cleanupErrors};
  await save("child-cleanup.json", cleanup);
  const completed = !interrupted && !errors.length && !cleanupErrors.length && observation?.prerequisitesPassed && Boolean(stagedAfter);
  const verdict = {schema: "openclaw-131226-media-proof-v1", binding, runtime: "built-child-gateway",
    completed: Boolean(completed), errors, cleanupErrors, childCleanup: cleanup, childRuntime,
    stagedBefore, stagedAfter, observation, historySummary, downloaded,
    limitations: ["Synthetic TTS/WAV and HTTP 503; no image-generation, overload, real provider, browser rendering, or Codex runtime claim.",
      "Read-only fixture hooks observe actual tool and delivery events; all persisted media originates in the real turn."]};
  await save("gateway-verdict.json", verdict);
  process.removeListener("SIGTERM", onTerminate);
  milestone("cleanup-finished");
  process.exitCode = completed ? 0 : 1;
}
