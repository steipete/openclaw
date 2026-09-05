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
  { getFeishuSequentialKey },
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
  load("extensions/feishu/src/sequential-key.ts"),
  load("extensions/feishu/src/post.ts"),
  load("src/config/runtime-snapshot.ts"),
]);

type Receipt = {
  path: string;
  id: string;
  content: string;
  text: string;
  messageType: string;
  receiveId?: string;
};
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
        messageType: body.msg_type,
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
  messages: { inbound: { byChannel: { feishu: 1_000 } } },
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
  resolveSequentialKey: getFeishuSequentialKey,
});
const receivedEventIds: string[] = [];
const dispatcher = new EventDispatcher({ verificationToken: "synthetic-webhook-token" }).register({
  "im.message.receive_v1": (event: { message: { message_id: string } }) => {
    receivedEventIds.push(event.message.message_id);
    return handler(event);
  },
});
const ingress = createHttpServer(adaptDefault("/event", dispatcher));
await new Promise<void>((resolve) => ingress.listen(0, "127.0.0.1", resolve));
const ingressAddress = ingress.address();
assert.ok(ingressAddress && typeof ingressAddress !== "string");
const cases = ["p2p", "group"];
const observations: unknown[] = [];
try {
  for (const chatType of cases) {
    const ids = [`om_${chatType}_first`, `om_${chatType}_last`];
    const beforeReceipts = receipts.length;
    const sourceMessages = [
      {
        text: "@_bot @_user_1 first",
        mentions: [
          { key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } },
          { key: "@_user_1", name: "Alice @_user_10", id: { open_id: "ou_alice" } },
        ],
      },
      {
        text: "@_bot @_user_1 @_user_10thanks",
        mentions: [
          { key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } },
          { key: "@_user_1", name: "Bob", id: { open_id: "ou_bob" } },
          { key: "@_user_10", name: "Carol", id: { open_id: "ou_carol" } },
        ],
      },
    ];
    const requests: Array<Promise<Response>> = [];
    for (const [index, source] of sourceMessages.entries()) {
      const envelope = {
        schema: "2.0",
        header: {
          event_id: `ev_${ids[index]}`,
          event_type: "im.message.receive_v1",
          token: "synthetic-webhook-token",
          app_id: "cli_synthetic_proof",
          create_time: String(Date.now()),
        },
        event: {
          sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
          message: {
            message_id: ids[index],
            chat_id: "oc_synthetic",
            chat_type: chatType,
            message_type: "text",
            content: JSON.stringify({ text: source.text }),
            mentions: source.mentions,
            create_time: String(Date.now()),
          },
        },
      };
      requests.push(
        fetch(`http://127.0.0.1:${ingressAddress.port}/event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(60_000),
        }),
      );
      const ingressDeadline = Date.now() + 10_000;
      while (!receivedEventIds.includes(ids[index]) && Date.now() < ingressDeadline) await delay(5);
      assert.ok(receivedEventIds.includes(ids[index]), "ordered SDK ingress was not observed");
    }
    for (const response of await Promise.all(requests)) {
      await response.text();
      assert.equal(response.status, 200, `${chatType}: SDK ingress HTTP status`);
    }
    const deadline = Date.now() + 30_000;
    while (
      receipts.length === beforeReceipts &&
      runtimeErrors.length === 0 &&
      Date.now() < deadline
    ) {
      await delay(25);
    }
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join("\n"));
    const inputs = modelInputs.filter((item) => ids.includes(item.id));
    assert.equal(inputs.length, 1, `${chatType}: expected one debounced model turn`);
    const input = inputs[0];
    assert.equal(input.id, ids[1], `${chatType}: last transport event retains dispatch identity`);
    assert.equal(
      receipts.length,
      beforeReceipts + 1,
      `${chatType}: missing or duplicate final HTTPS receipt`,
    );
    // Only the last mention-forward request supplies notification targets after batching.
    const expectedContent = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: "at", user_id: "ou_bob", user_name: "Bob" },
            { tag: "at", user_id: "ou_carol", user_name: "Carol" },
            { tag: "md", text: input.output },
          ],
        ],
      },
    });
    assert.equal(receipts.at(-1)?.messageType, "post", `${chatType}: unexpected outbound format`);
    assert.equal(
      receipts.at(-1)?.content,
      expectedContent,
      `${chatType}: serialized outbound content differs`,
    );
    assert.equal(
      receipts.at(-1)?.text,
      "@Bob@Carol" + input.output,
      `${chatType}: rendered outbound content differs`,
    );
    const expected =
      '<at user_id="ou_alice">Alice @_user_10</at> first\n<at user_id="ou_bob">Bob</at> <at user_id="ou_carol">Carol</at>thanks';
    observations.push({
      scenario: chatType,
      order: ids,
      modelRawBody: input.rawBody,
      expected,
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
  for (const observation of observations as Array<{
    scenario: string;
    modelRawBody: string;
    modelBodyForAgent: string;
    expected: string;
  }>) {
    if (
      observation.modelRawBody !== observation.expected ||
      !observation.modelBodyForAgent.includes(observation.expected)
    ) {
      throw new Error(`FEISHU_DEBOUNCE_REGRESSION:${observation.scenario}`);
    }
  }
  console.log("FEISHU_DEBOUNCE_PROOF_GREEN");
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
