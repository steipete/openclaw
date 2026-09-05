import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const [keyPath, certPath] = process.argv.slice(3);
assert.ok(keyPath && certPath, "supply synthetic TLS key and certificate paths");
const stateDir = await mkdtemp(path.join(os.tmpdir(), "feishu-runtime-proof-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const load = (file: string) => import(pathToFileURL(path.join(repo, file)).href);
const require = createRequire(path.join(repo, "extensions/feishu/package.json"));
const { EventDispatcher, adaptDefault } = require("@larksuiteoapi/node-sdk");
const [
  { createPluginRuntime },
  { setActivePluginRegistry },
  { createTestRegistry },
  { feishuPlugin },
  { setFeishuRuntime },
  { createFeishuMessageReceiveHandler },
  { handleFeishuMessage, parseFeishuMessageEvent },
  { hasProcessedFeishuMessage },
  { parsePostContent },
  { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot },
] = await Promise.all([
  load("src/plugins/runtime/index.ts"),
  load("src/plugins/runtime.ts"),
  load("src/test-utils/channel-plugins.ts"),
  load("extensions/feishu/src/channel.ts"),
  load("extensions/feishu/src/runtime.ts"),
  load("extensions/feishu/src/monitor.message-handler.ts"),
  load("extensions/feishu/src/bot.ts"),
  load("extensions/feishu/src/dedup.ts"),
  load("extensions/feishu/src/post.ts"),
  load("src/config/runtime-snapshot.ts"),
]);

type Receipt = { path: string; id: string; content: string; text: string; receiveId?: string };
const receipts: Receipt[] = [];
const unexpectedRequests: string[] = [];
const api = createHttpsServer(
  { key: await readFile(keyPath), cert: await readFile(certPath) },
  async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const pathname = new URL(request.url ?? "/", "https://localhost").pathname;
    response.setHeader("Content-Type", "application/json");
    if (pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.end(
        JSON.stringify({ code: 0, tenant_access_token: "synthetic-proof-token", expire: 3600 }),
      );
    } else if (request.method === "GET" && pathname.startsWith("/open-apis/im/v1/chats/")) {
      response.end(JSON.stringify({ code: 0, data: { name: "Synthetic proof room" } }));
    } else if (
      request.method === "POST" &&
      /^\/open-apis\/im\/v1\/messages(?:\/[^/]+\/reply)?$/.test(pathname)
    ) {
      const id = `om_receipt_${receipts.length + 1}`;
      assert.equal(typeof body.content, "string", "outbound message has no content");
      const text =
        body.msg_type === "post"
          ? parsePostContent(body.content).textContent
          : JSON.parse(body.content).text;
      receipts.push({
        path: pathname,
        id,
        content: body.content,
        text,
        receiveId: body.receive_id,
      });
      response.end(JSON.stringify({ code: 0, data: { message_id: id, chat_id: "oc_synthetic" } }));
    } else {
      unexpectedRequests.push(`${request.method} ${pathname}`);
      response.statusCode = 500;
      response.end(JSON.stringify({ code: 1, msg: "unexpected synthetic API request" }));
    }
  },
);
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiAddress = api.address();
assert.ok(apiAddress && typeof apiAddress !== "string");
const workspace = path.join(stateDir, "workspace");
await mkdir(workspace, { recursive: true });
const cfg = {
  agents: { entries: { main: { default: true, workspace } } },
  session: { dmScope: "per-channel-peer" },
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_synthetic_proof",
      appSecret: "synthetic-proof-secret",
      domain: `https://127.0.0.1:${apiAddress.port}`,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      resolveSenderNames: false,
      typingIndicator: false,
      renderMode: "raw",
      streaming: { mode: "off" },
      historyLimit: 0,
      groups: { oc_synthetic: { requireMention: true } },
    },
  },
};
const modelInputs: Array<{ id: string; rawBody: string; bodyForAgent: string; output: string }> =
  [];
const runtime = createPluginRuntime({
  // Established mock-provider seam: all channel ingress, recording, normalization,
  // final settlement, reply encoding and SDK HTTP delivery remain production code.
  dispatchReplyFromConfig: async ({
    ctx,
    dispatcher,
  }: {
    ctx: Record<string, string>;
    dispatcher: { sendFinalReply: (payload: { text: string }) => boolean };
  }) => {
    const rawBody = ctx.RawBody;
    assert.equal(typeof rawBody, "string", "model context has no raw body");
    const output = `proof:${ctx.MessageSid}:${Buffer.from(rawBody).toString("base64")}`;
    modelInputs.push({ id: ctx.MessageSid, rawBody, bodyForAgent: ctx.BodyForAgent, output });
    const queuedFinal = dispatcher.sendFinalReply({ text: output });
    return { queuedFinal, counts: { tool: 0, block: 0, final: queuedFinal ? 1 : 0 } };
  },
});
// Feishu uses inbound.run, while the factory's convenience binding covers inbound.dispatch.
// Inject the same supported ChannelTurnPlan provider callback without replacing runChannelTurn.
const runInbound = runtime.channel.inbound.run;
runtime.channel.inbound.run = (params: {
  adapter: { resolveTurn: (...args: unknown[]) => Promise<Record<string, unknown>> };
}) =>
  runInbound({
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (...args: unknown[]) => ({
        ...(await params.adapter.resolveTurn(...args)),
        dispatchReplyFromConfig: runtime.channel.reply.dispatchReplyFromConfig,
      }),
    },
  });
setRuntimeConfigSnapshot(cfg);
setFeishuRuntime(runtime);
setActivePluginRegistry(
  createTestRegistry([
    { pluginId: "feishu", plugin: feishuPlugin, source: "runtime-proof", origin: "bundled" },
  ]),
);
const runtimeErrors: string[] = [];
const handler = createFeishuMessageReceiveHandler({
  cfg,
  channelRuntime: runtime.channel,
  accountId: "default",
  runtime: { log: () => {}, error: (value: unknown) => runtimeErrors.push(String(value)) },
  chatHistories: new Map(),
  fireAndForget: false,
  handleMessage: handleFeishuMessage,
  resolveDebounceText: ({ event }: { event: unknown }) =>
    parseFeishuMessageEvent(event, "ou_bot").content,
  hasProcessedMessage: hasProcessedFeishuMessage,
  getBotOpenId: () => "ou_bot",
  getBotName: () => "Synthetic Bot",
});
const dispatcher = new EventDispatcher({ verificationToken: "synthetic-webhook-token" }).register({
  "im.message.receive_v1": handler,
});
const ingress = createHttpServer(adaptDefault("/event", dispatcher));
await new Promise<void>((resolve) => ingress.listen(0, "127.0.0.1", resolve));
const ingressAddress = ingress.address();
assert.ok(ingressAddress && typeof ingressAddress !== "string");
const cases = [
  {
    name: "prefixes-dm",
    chatType: "p2p",
    text: "@_user_1 @_user_10 @_user_11thanks",
    mentions: [
      { key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } },
      { key: "@_user_10", name: "Alice", id: { open_id: "ou_alice" } },
      { key: "@_user_11", name: "Bob", id: { open_id: "ou_bob" } },
    ],
    expected: '<at user_id="ou_alice">Alice</at> <at user_id="ou_bob">Bob</at>thanks',
  },
  {
    name: "literal-name-group",
    chatType: "group",
    text: "@_bot @_user_10 @_user_1",
    mentions: [
      { key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } },
      { key: "@_user_10", name: "Alice @_user_1", id: { open_id: "ou_alice" } },
      { key: "@_user_1", name: "Bob", id: { open_id: "ou_bob" } },
    ],
    expected: '<at user_id="ou_alice">Alice @_user_1</at> <at user_id="ou_bob">Bob</at>',
  },
  {
    name: "plain-control",
    chatType: "p2p",
    text: "hello without mentions",
    mentions: [],
    expected: "hello without mentions",
  },
];
const observations: unknown[] = [];
try {
  for (const scenario of cases) {
    const id = `om_${scenario.name}`;
    const beforeReceipts = receipts.length;
    const envelope = {
      schema: "2.0",
      header: {
        event_id: `ev_${scenario.name}`,
        event_type: "im.message.receive_v1",
        token: "synthetic-webhook-token",
        app_id: "cli_synthetic_proof",
        create_time: String(Date.now()),
      },
      event: {
        sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
        message: {
          message_id: id,
          chat_id: "oc_synthetic",
          chat_type: scenario.chatType,
          message_type: "text",
          content: JSON.stringify({ text: scenario.text }),
          mentions: scenario.mentions,
          create_time: String(Date.now()),
        },
      },
    };
    const response = await fetch(`http://127.0.0.1:${ingressAddress.port}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(60_000),
    });
    await response.text();
    assert.equal(response.status, 200, `${scenario.name}: SDK ingress HTTP status`);
    // The receive handler may acknowledge admission before the final send settles.
    const deadline = Date.now() + 30_000;
    while (
      receipts.length === beforeReceipts &&
      runtimeErrors.length === 0 &&
      Date.now() < deadline
    ) {
      await delay(25);
    }
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join("\n"));
    const input = modelInputs.find((item) => item.id === id);
    assert.ok(input, `${scenario.name}: no model dispatch (setup/admission failure)`);
    assert.equal(
      receipts.length,
      beforeReceipts + 1,
      `${scenario.name}: missing or duplicate final HTTPS receipt`,
    );
    assert.equal(
      receipts.at(-1)?.text,
      input.output,
      `${scenario.name}: delivered bytes differ from mock-provider output`,
    );
    observations.push({
      scenario: scenario.name,
      modelRawBody: input.rawBody,
      expected: scenario.expected,
      modelBodyForAgent: input.bodyForAgent,
      receipt: receipts.at(-1),
    });
  }
  assert.deepEqual(unexpectedRequests, [], "unexpected API calls");
  console.log(
    JSON.stringify({
      entrypoint:
        "Lark SDK HTTP event -> Feishu receive handler -> real core inbound runtime -> mock provider -> real Feishu reply dispatcher -> SDK HTTPS receipt",
      observations,
    }),
  );
  for (const [index, scenario] of cases.entries()) {
    const input = modelInputs[index];
    if (input.rawBody !== scenario.expected || !input.bodyForAgent.includes(scenario.expected)) {
      throw new Error(`FEISHU_MENTION_REGRESSION:${scenario.name}`);
    }
  }
  console.log("FEISHU_RUNTIME_PROOF_GREEN");
} finally {
  setActivePluginRegistry(createTestRegistry([]));
  clearRuntimeConfigSnapshot();
  ingress.closeAllConnections();
  api.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => ingress.close(() => resolve())),
    new Promise<void>((resolve) => api.close(() => resolve())),
  ]);
  await rm(stateDir, { recursive: true, force: true });
}
