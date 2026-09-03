// DATA DRAFT: host execution is not authorized. Publish only after root review.
// Overlay beside the existing QA helpers; the actual Gateway runs dist/index.js.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { closeQaHttpServer, readQaJsonBody, writeJson } from "./bus-server.js";
import { reserveQaGatewayPort } from "./gateway-port-reservation.js";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.js";
import { getChannelIngressKysely } from "../../../src/channels/message/ingress-queue.js";
import { executeSqliteQuerySync } from "../../../src/infra/kysely-sync.js";
import { openExistingOpenClawStateDatabaseReadOnly } from "../../../src/state/openclaw-state-db.js";

const root = await fs.realpath(process.cwd());
const output = await fs.realpath(process.env.OPENCLAW_TALK_PROOF_DIR);
const binding = JSON.parse(await fs.readFile(process.env.OPENCLAW_TALK_PROOF_BINDING, "utf8"));
const mode = "baseline";
assert.equal(process.env.OPENCLAW_TALK_PROOF_MODE, mode, "Only unchanged baseline is admitted");
assert.equal(binding.runnable, true, "Root must seal an executable binding after review");
assert.match(binding.sourceIdentity, /^[a-f0-9]{64}$/);
const expectedHead = binding.baseHead;
assert.match(expectedHead, /^[a-f0-9]{40}$/);
const buildBytes = await fs.readFile(path.join(output, "runtime-build.json"));
const build = JSON.parse(buildBytes);
assert.equal(build.head, expectedHead);
assert.equal(build.sourceIdentity, binding.sourceIdentity);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
const milestone = (text) => process.stderr.write(`TALK_PROOF_PHASE ${text}\n`);
const MODEL = "mock-openai/gpt-5.6-luna";
// Synthetic, ephemeral values. Never collect credentials from the host.
const secret = randomBytes(32).toString("hex");
const apiUser = "fixture";
const apiPassword = randomBytes(24).toString("hex");
const requests = [], replies = [], cases = [], errors = [], cleanupErrors = [];
const rooms = new Map([
  ["dmplainhelp", 1], ["dmplainstatus", 1], ["dmjsonhelp", 1],
  ["dmjsonstatus", 1], ["groupcommand", 2], ["groupchatonly", 2],
  ["groupnotallowed", 2], ["dmrich", 1], ["dmmalformed", 1],
]);
let server, baseUrl, harness, debugDir;
const webhookReservations = [];
const webhookUrls = new Map();
let stagedBefore, stagedAfter, childRuntime, duplicateBefore, duplicateAfter, providerFinal;
let childStoppedBeforeFinalCounters = false, providerInflightFinal;
let interrupted = false, stopPromise, stopResult;
const owner = createQaLiveLaneGateway();
const stop = () => stopPromise ??= owner.stop(debugDir ? { preserveToDir: debugDir } : undefined);
let rejectInterrupted;
const interruption = new Promise((_, reject) => { rejectInterrupted = reject; });
void interruption.catch(() => {});
const guard = (operation) => {
  if (interrupted) throw new Error("Proof interrupted; no further admission");
  return Promise.race([operation, interruption]);
};
const onTerminate = () => {
  interrupted = true;
  rejectInterrupted(new Error("Proof deadline/SIGTERM"));
  void stop().catch(error => cleanupErrors.push(String(error)));
};
process.once("SIGTERM", onTerminate);

async function startTalk() {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const room = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v4\/room\/([a-z0-9]{4,30})$/.exec(url.pathname)?.[1];
      if (req.method === "GET" && room && rooms.has(room)) {
        assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${apiUser}:${apiPassword}`).toString("base64")}`);
        assert.equal(req.headers["ocs-apirequest"], "true");
        requests.push({ kind: "room", room, type: rooms.get(room) });
        writeJson(res, 200, { ocs: { meta: { status: "ok", statuscode: 100 }, data: { token: room, type: rooms.get(room) } } });
        return;
      }
      const target = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/bot\/([a-z0-9]{4,30})\/message$/.exec(url.pathname)?.[1];
      assert.equal(req.method, "POST");
      assert.ok(target && rooms.has(target), `Unexpected Talk endpoint: ${url.pathname}`);
      assert.equal(req.headers["ocs-apirequest"], "true");
      const body = await readQaJsonBody(req, { maxBytes: 64 * 1024 });
      assert.equal(typeof body?.message, "string");
      assert.ok(body.message.trim());
      const random = req.headers["x-nextcloud-talk-bot-random"];
      assert.equal(typeof random, "string");
      assert.ok(random.length >= 32);
      const expected = createHmac("sha256", secret).update(random + body.message).digest("hex");
      assert.equal(req.headers["x-nextcloud-talk-bot-signature"], expected);
      assert.ok(replies.length < 100, "Outbound observation bound exceeded");
      replies.push({ room: target, message: body.message, replyTo: body.replyTo, sequence: replies.length, hmacVerified: true });
      // BotController::sendMessage returns null data, unlike the user chat API.
      writeJson(res, 201, { ocs: { data: null } });
    })().catch(error => {
      errors.push(`Talk request: ${String(error)}`);
      if (!res.headersSent) writeJson(res, 500, { error: "Synthetic Talk contract failed" });
      else res.destroy();
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function queryIngress(id, account = "default") {
  const handle = await openExistingOpenClawStateDatabaseReadOnly({ env: harness.gateway.runtimeEnv });
  assert.ok(handle, "The Gateway must own an existing shared state database");
  try {
    const rows = executeSqliteQuerySync(handle.db, getChannelIngressKysely(handle.db)
      .selectFrom("channel_ingress_events")
      .select(["event_id", "status", "completed_at", "claim_token", "last_error", "attempts"])
      .where("channel_id", "=", "nextcloud-talk").where("account_id", "=", account)
      .where("event_id", "=", id)).rows;
    assert.ok(rows.length <= 1);
    return rows[0] ?? null;
  } finally { handle.walMaintenance.close(); }
}

async function modelRequests() {
  const response = await guard(fetch(harness.mock.baseUrl + "/debug/requests", { signal: AbortSignal.timeout(5_000) }));
  assert.equal(response.ok, true);
  const rows = await response.json();
  assert.ok(Array.isArray(rows) && rows.length < 50, "Unexpected mock-provider request count");
  return rows;
}

async function post(id, room, content, sender = "users/alice", valid = true, account = "default") {
  const raw = JSON.stringify({ type: "Create", actor: { type: "Person", id: sender, name: "Synthetic user" },
    object: { type: "Note", id, name: "message", content, mediaType: "text/markdown" },
    target: { type: "Collection", id: room, name: "Synthetic room" } });
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret).update(random + raw).digest("hex");
  const response = await guard(fetch(webhookUrls.get(account), { method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-nextcloud-talk-backend": baseUrl,
      "x-nextcloud-talk-random": random, "x-nextcloud-talk-signature": valid ? signature : "0".repeat(64) },
    signal: AbortSignal.timeout(10_000) }));
  const responseBody = await response.text();
  assert.equal(response.status, valid ? 200 : 401, responseBody);
  assert.equal(response.headers.get("x-openclaw-delivery-accepted"), valid ? "durable" : null);
  return { status: response.status, durable: valid, rawSha256: hash(raw) };
}

async function readStaging() {
  const installedLockSHA256 = hash(await fs.readFile(path.join(root, "node_modules/.pnpm/lock.yaml")));
  assert.equal(installedLockSHA256, binding.installedLockSHA256);
  const linkObservations = [];
  const staged = harness.gateway.runtimeEnv.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const stagingRoot = harness.gateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT;
  assert.ok(stagingRoot?.startsWith(path.join(root, ".artifacts/qa-runtime") + path.sep));
  assert.equal(staged, path.join(stagingRoot, "dist/extensions"));
  const plugins = {};
  const ids = (await fs.readdir(staged)).sort();
  for (const required of ["nextcloud-talk", "qa-lab", "openai"]) assert.ok(ids.includes(required), `Missing staged plugin: ${required}`);
  if (Object.keys(build.files).some(name => name.startsWith("dist/extensions/image-generation-core/"))) {
    assert.ok(ids.includes("image-generation-core"), "Generated runtime plugin was not staged");
  }
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/);
    const entries = {};
    async function visit(relative = "") {
      for (const entry of await fs.readdir(path.join(staged, id, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) {
          const source = `dist/extensions/${id}/${name}`;
          const expected = build.files[source];
          const observed = { source, symlink: await fs.readlink(path.join(staged, id, name)), expected };
          linkObservations.push(observed);
          assert.ok(linkObservations.length <= 100, "Staged link observation bound exceeded");
          await save("staged-links-progress.json", linkObservations);
          assert.equal(typeof expected?.symlink, "string", `Unbound staged link: ${source}`);
          assert.equal(typeof expected.resolvedRelativeTarget, "string");
          assert.equal(await fs.readlink(path.join(root, source)), expected.symlink);
          // Node's canonical fs.cp resolves relative link text against its source path.
          assert.equal(observed.symlink, path.resolve(path.dirname(path.join(root, source)), expected.symlink));
          const resolved = await fs.realpath(path.join(staged, id, name));
          observed.resolvedRelativeTarget = path.relative(root, resolved) || ".";
          await save("staged-links-progress.json", linkObservations);
          assert.ok(resolved === root || resolved.startsWith(root + path.sep), `Link escaped frozen checkout: ${source}`);
          assert.equal(observed.resolvedRelativeTarget, expected.resolvedRelativeTarget);
          assert.equal(await fs.realpath(path.join(root, source)), resolved);
          assert.ok(name.startsWith("node_modules/"), `Unexpected runtime asset link: ${source}`);
          const dependency = name.slice("node_modules/".length);
          assert.match(dependency, /^(?:\.bin|(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)$/i);
          const dependencyOwner = `extensions/${id}/node_modules/${dependency}`;
          assert.equal(await fs.realpath(path.join(root, dependencyOwner)), resolved);
          entries[name] = { symlink: observed.symlink, resolvedRelativeTarget: observed.resolvedRelativeTarget, dependencyOwner };
          continue;
        }
        if (entry.isDirectory()) { await visit(name); continue; }
        assert.ok(entry.isFile());
        assert.ok(!/(?<!\.d)\.[cm]?tsx?$/.test(name), `Source fallback staged: ${id}/${name}`);
        const bytes = await fs.readFile(path.join(staged, id, name));
        const sourceManifest = binding.stagedManifestSources[id];
        const source = name === "openclaw.plugin.json" && sourceManifest ? sourceManifest : `dist/extensions/${id}/${name}`;
        const expected = source === sourceManifest ? binding.sourceHashes[source] : build.files[source]?.sha256;
        assert.match(expected ?? "", /^[a-f0-9]{64}$/, `Unbound staged artifact: ${source}`);
        assert.equal(hash(bytes), expected, `Changed staged artifact: ${source}`);
        entries[name] = { sha256: hash(bytes), bytes: bytes.length };
      }
    }
    await visit();
    plugins[id] = entries;
  }
  assert.ok(plugins["nextcloud-talk"]["index.js"], "Actual Talk entry must be compiled index.js");
  return { plugins, installedLockSHA256 };
}

const scenarioRows = [
  { id: "134817001", room: "dmplainhelp", content: "/help", kind: "help" },
  { id: "134817002", room: "dmplainstatus", content: "/status", kind: "status" },
  { id: "134817003", room: "dmjsonhelp", content: '{"message":"/help","parameters":[]}', kind: "help", baselineKind: "agent" },
  { id: "134817004", room: "dmjsonstatus", content: '{"message":"/status","parameters":{}}', kind: "status", baselineKind: "agent" },
  { id: "134817005", room: "groupcommand", content: '{"message":"/help","parameters":{}}', kind: "help", baselineKind: "no-mention" },
  { id: "134817006", room: "groupchatonly", account: "roomonly", sender: "users/bob", content: '{"message":"/help","parameters":{}}', kind: "unauthorized-command", baselineKind: "agent" },
  { id: "134817007", room: "groupnotallowed", content: '{"message":"/help","parameters":{}}', kind: "room-denied" },
  { id: "134817008", room: "dmrich", content: '{"message":"Hello {user1}","parameters":{"user1":{"type":"user","id":"alice","name":"Alice"}}}', kind: "agent" },
  { id: "134817009", room: "dmmalformed", content: '{"message":"/help",', kind: "agent" },
];

try {
  milestone("parent-entered");
  const tmp = await fs.realpath(process.env.TMPDIR);
  assert.ok(tmp.startsWith("/tmp/"));
  assert.equal((await fs.stat(tmp)).mode & 0o777, 0o700);
  await fs.mkdir(path.join(root, ".artifacts"), { recursive: true });
  debugDir = await fs.mkdtemp(path.join(root, ".artifacts/proof-134817-debug-"));
  await startTalk();
  const ports = {};
  for (const account of ["default", "roomonly"]) {
    const reservation = await reserveQaGatewayPort(net.createServer());
    webhookReservations.push(reservation);
    ports[account] = reservation.port;
    webhookUrls.set(account, `http://127.0.0.1:${reservation.port}/nextcloud-talk-webhook`);
  }
  for (const reservation of webhookReservations) await reservation.release();
  webhookReservations.length = 0;
  milestone("gateway-starting");
  const requestedCommand = { executablePath: process.execPath, argsPrefix: [path.join(root, "dist/index.js")], tempParentDir: tmp };
  harness = await guard(owner.start({ repoRoot: root,
    command: requestedCommand,
    providerMode: "mock-openai", primaryModel: MODEL, alternateModel: MODEL, forcedRuntime: "openclaw",
    transportBaseUrl: baseUrl, controlUiEnabled: false,
    transport: { requiredPluginIds: ["nextcloud-talk"], createGatewayConfig: ({ baseUrl: endpoint }) => ({
      channels: { "nextcloud-talk": { enabled: true, baseUrl: endpoint, botSecret: secret, apiUser, apiPassword,
        webhookHost: "127.0.0.1", webhookPort: ports.default, dmPolicy: "allowlist", allowFrom: ["users/alice"],
        groupPolicy: "allowlist", groupAllowFrom: ["users/alice"],
        rooms: { "groupcommand": { requireMention: true } },
        // Empty account overrides are preserved by this plugin's canonical merger.
        // Room-only sender access must not become command authorization.
        accounts: { roomonly: { allowFrom: [], groupAllowFrom: [], webhookPort: ports.roomonly,
          rooms: { groupchatonly: { requireMention: false, allowFrom: ["users/bob"] } } } },
        network: { dangerouslyAllowPrivateNetwork: true } } },
      messages: { visibleReplies: "automatic" },
    }) },
    mutateConfig: cfg => ({ ...cfg, diagnostics: { ...cfg.diagnostics, enabled: true },
      logging: { ...cfg.logging, level: "debug", consoleLevel: "debug" } }),
  }));
  assert.ok(harness.mock);
  const gatewayPort = harness.gateway.cfg.gateway.port;
  assert.ok(Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort <= 65535);
  assert.equal(harness.gateway.baseUrl, `http://127.0.0.1:${gatewayPort}`);
  assert.ok(Number.isInteger(harness.gateway.pid) && harness.gateway.pid > 0);
  // The frozen QA owner appends these arguments using this returned config/URL port.
  // Direct dist/index.js skips entry.ts title-setting side effects.
  const canonicalLaunchArgv = [requestedCommand.executablePath, ...requestedCommand.argsPrefix,
    "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback", "--allow-unconfigured"];
  childRuntime = { pid: harness.gateway.pid, requestedCommand, canonicalLaunchArgv,
    gatewayPort, gatewayBaseUrl: harness.gateway.baseUrl,
    observedCmdline: (await fs.readFile(`/proc/${harness.gateway.pid}/cmdline`, "utf8")).split("\0").filter(Boolean),
    executable: await fs.readlink(`/proc/${harness.gateway.pid}/exe`), buildInventorySha256: hash(buildBytes) };
  assert.equal(await fs.realpath(childRuntime.executable), await fs.realpath(process.execPath));
  assert.deepEqual(childRuntime.observedCmdline, canonicalLaunchArgv);
  stagedBefore = await readStaging();
  await save("staged-before.json", stagedBefore);
  const readyDeadline = Date.now() + 30_000;
  while (![...webhookUrls.values()].every(url => harness.gateway.logs().includes(`webhook listening on ${url}`)) && Date.now() < readyDeadline) await guard(new Promise(resolve => setTimeout(resolve, 100)));
  for (const url of webhookUrls.values()) assert.ok(harness.gateway.logs().includes(`webhook listening on ${url}`));
  assert.deepEqual(await modelRequests(), []);
  let helpReply;
  for (const scenario of scenarioRows) {
    const expected = scenario.baselineKind ?? scenario.kind;
    const account = scenario.account ?? "default";
    const beforeRequests = await modelRequests();
    const beforeReplies = replies.length;
    const admitted = await post(scenario.id, scenario.room, scenario.content, scenario.sender, true, account);
    const deadline = Date.now() + 60_000;
    let row, diagnostic;
    const drop = expected === "no-mention" ? `drop room ${scenario.room} (no mention)`
      : expected === "unauthorized-command" ? `drop control command (unauthorized) target=${scenario.sender}`
      : expected === "room-denied" ? `drop room ${scenario.room} (not allowlisted)` : undefined;
    do {
      row = await queryIngress(scenario.id, account);
      diagnostic = harness.gateway.logs().split("\n").find(line => drop ? line.includes(`nextcloud-talk: ${drop}`)
        : line.includes("message processed: channel=nextcloud-talk ") && line.includes(`messageId=${scenario.id} `) && line.includes(" outcome=completed "));
      if (row?.status === "failed") throw new Error(`Ingress failed for ${scenario.id}: ${row.last_error}`);
      if (row?.status === "completed" && diagnostic && (drop || replies.length > beforeReplies)) break;
      await guard(new Promise(resolve => setTimeout(resolve, 100)));
    } while (Date.now() < deadline);
    const actualReplies = replies.slice(beforeReplies);
    const actualRequests = (await modelRequests()).slice(beforeRequests.length);
    const result = { id: scenario.id, account, expected, admitted, ingress: row, diagnostic,
      replies: actualReplies, modelRequests: actualRequests, rawContent: scenario.content, passed: false };
    cases.push(result);
    await save("cases-progress.json", cases);
    assert.equal(row?.status, "completed", `No completed ingress row for ${scenario.id}`);
    assert.equal(row.claim_token, null);
    assert.equal(row.last_error, null);
    assert.ok(diagnostic, `No actual processed/policy outcome for ${scenario.id}`);
    if (drop) { assert.equal(actualReplies.length, 0); assert.equal(actualRequests.length, 0); }
    else {
      assert.ok(actualReplies.length > 0 && actualReplies.every(reply => reply.room === scenario.room && reply.hmacVerified));
      const text = actualReplies.map(reply => reply.message).join("\n");
      if (expected === "agent") {
        assert.equal(actualRequests.length, 1);
        assert.ok(actualRequests[0].prompt.includes(scenario.content.trim()), "Model must receive original raw content");
        assert.equal(actualRequests[0].outcome, "success");
        assert.equal(actualRequests[0].plannedToolName, undefined);
        assert.notEqual(text, helpReply);
      } else {
        assert.equal(actualRequests.length, 0, "Canonical command must not invoke a model");
        if (expected === "help") {
          if (helpReply === undefined) { assert.ok(text.startsWith("ℹ️ Help") && text.includes("/status") && text.includes("/commands")); helpReply = text; }
          else assert.equal(text, helpReply);
        } else {
          assert.ok(text.includes("OpenClaw") && text.includes("mock-openai"), "Actual status response must describe the configured runtime");
          assert.ok(!text.includes("error rendering response"));
        }
      }
    }
    result.passed = true;
    milestone(`case-complete ${scenario.id}`);
  }
  const invalidBefore = { replies: replies.length, requests: (await modelRequests()).length };
  const invalid = await post("134817010", "dmplainhelp", "/help", "users/alice", false);
  assert.equal(await queryIngress("134817010"), null);
  assert.deepEqual({ replies: replies.length, requests: (await modelRequests()).length }, invalidBefore);
  cases.push({ id: "134817010", passed: true, admitted: invalid, rowAbsent: true });
  duplicateBefore = { row: await queryIngress("134817001"), replies: replies.length, requests: (await modelRequests()).length };
  await post("134817001", "dmplainhelp", "/help");
  duplicateAfter = { row: await queryIngress("134817001"), replies: replies.length, requests: (await modelRequests()).length };
  assert.deepEqual(duplicateAfter, duplicateBefore);
  cases.push({ id: "talk-completed-replay", passed: true, retainedTombstone: true });
  stagedAfter = await readStaging();
  assert.deepEqual(stagedAfter, stagedBefore);
  await save("staged-after.json", stagedAfter);
  // The child lifetime stops first; the external mock remains alive for a final
  // read. This closes late-counter gaps without claiming natural turn settlement.
  await guard(harness.gateway.stop({ preserveToDir: debugDir }));
  childStoppedBeforeFinalCounters = true;
  providerFinal = await modelRequests();
  const inflightResponse = await guard(fetch(harness.mock.baseUrl + "/debug/inflight-requests", { signal: AbortSignal.timeout(5_000) }));
  assert.equal(inflightResponse.ok, true);
  providerInflightFinal = await inflightResponse.json();
  assert.deepEqual(providerInflightFinal, []);
  assert.deepEqual(providerFinal, cases.flatMap(row => row.modelRequests ?? []));
  assert.deepEqual(replies, cases.flatMap(row => row.replies ?? []));
  assert.equal(providerFinal.length, duplicateAfter.requests);
  assert.equal(replies.length, duplicateAfter.replies);
} catch (error) { errors.push(String(error)); }
finally {
  milestone("cleanup-starting");
  await save("child-cleanup.json", { confirmed: false, phase: "stopping", interrupted });
  try {
    const stopped = await stop();
    stopResult = { process: stopped.process, errors: stopped.errors.map(String) };
    cleanupErrors.push(...stopResult.errors);
    assert.notEqual(stopped.process, "unconfirmed");
    if (harness) assert.equal(stopped.process, "confirmed-stopped");
    if (debugDir) {
      for (const name of ["gateway.stdout.log", "gateway.stderr.log", "README.txt"]) {
        const bytes = await fs.readFile(path.join(debugDir, name));
        assert.ok(bytes.length <= 4 * 1024 * 1024);
        await fs.writeFile(path.join(output, name), bytes);
      }
      await fs.rm(debugDir, { recursive: true });
    }
  } catch (error) { cleanupErrors.push(String(error)); }
  for (const reservation of webhookReservations) {
    try { await reservation.release(); } catch (error) { cleanupErrors.push(String(error)); }
  }
  try { if (server) await closeQaHttpServer(server); } catch (error) { cleanupErrors.push(String(error)); }
  const confirmed = Boolean(stopResult && stopResult.process !== "unconfirmed" && !cleanupErrors.length);
  if (duplicateAfter && replies.length !== duplicateAfter.replies) errors.push("Late duplicate outbound observed during cleanup");
  const completed = Boolean(!interrupted && !errors.length && !cleanupErrors.length && cases.length === 11 && cases.every(row => row.passed) && stagedAfter && childStoppedBeforeFinalCounters);
  const cleanup = { confirmed, phase: "finished", result: stopResult, errors: cleanupErrors };
  await save("child-cleanup.json", cleanup);
  await save("gateway-verdict.json", { schema: "openclaw-134817-command-proof-v1", mode, binding,
    completed, errors, cleanupErrors, childCleanup: cleanup, childRuntime, cases, requests, replies,
    providerFinal, providerInflightFinal, childStoppedBeforeFinalCounters, duplicateBefore, duplicateAfter, stagedBefore, stagedAfter,
    limitations: ["Synthetic Talk HTTP service and mock model; actual Gateway/plugin/command/transport code.",
      "A completed ingress row records adoption, not global turn closure. Dispatched rows also require the real processed diagnostic and accepted reply; final canonical group stop proves process closure.",
      "No authenticated Nextcloud deployment, native client slash-command interception, or Codex runtime claim."] });
  process.removeListener("SIGTERM", onTerminate);
  process.exitCode = completed && confirmed ? 0 : 1;
}
