import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const state = await mkdtemp(join(tmpdir(), "canvas-selection-proof-"));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = join(state, "openclaw.json");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const port = server.address().port;
const opts = {
  gatewayUrl: `ws://127.0.0.1:${port}`,
  gatewayToken: "synthetic-proof-only",
  timeoutMs: 5000,
};
await writeFile(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({ gateway: { mode: "local", port } }),
);
let node;
const calls = [];
server.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-challenge", ts: Date.now() },
    }),
  );
  socket.on("message", (bytes) => {
    const request = JSON.parse(bytes.toString());
    if (request.type !== "req") return;
    let payload;
    if (request.method === "connect")
      payload = {
        type: "hello-ok",
        protocol: 3,
        server: { version: "proof", connId: "proof" },
        features: { methods: ["node.list", "node.invoke"], events: [] },
        snapshot: {},
        policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
      };
    else if (request.method === "node.list") payload = { nodes: [node] };
    else if (request.method === "node.invoke") {
      calls.push(request.params);
      payload = { ok: true };
    } else throw new Error(`Unexpected RPC ${request.method}`);
    socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
  });
});
try {
  const { createCanvasTool } = await import("./extensions/canvas/src/tool.ts");
  const { createCanvasWidgetPresenter } =
    await import("./extensions/canvas/src/widget-presenter.ts");
  const { listNodes } = await import("./src/agents/tools/nodes-utils.ts");
  const { callGatewayTool } = await import("./src/agents/tools/gateway.ts");
  const nodesRuntime = {
    list: async () => ({ nodes: await listNodes(opts) }),
    invoke: async (params) => callGatewayTool("node.invoke", opts, params),
  };
  const rows = [
    { name: "bare", platform: "macos", eligible: true },
    { name: "native-version", platform: "macOS 26.6.2", eligible: true },
    { name: "case", platform: "MACOS", eligible: true },
    { name: "prefix", platform: "macosx", eligible: false },
    { name: "linux", platform: "linux", eligible: false },
    { name: "android", platform: "android", eligible: false },
    { name: "offline", platform: "macOS 26.6.2", connected: false, eligible: false },
    { name: "missing-command", platform: "macOS 26.6.2", commands: [], eligible: false },
  ];
  const observations = [];
  for (const row of rows) {
    node = {
      nodeId: "mac-proof",
      displayName: "Synthetic Mac",
      platform: row.platform,
      connected: row.connected ?? true,
      caps: ["canvas"],
      commands: row.commands ?? ["canvas.present", "canvas.hide"],
    };
    const before = calls.length;
    const tool = createCanvasTool();
    const present = await tool.execute("proof-present", { action: "present", ...opts }).then(
      (r) => r.details.ok === true,
      () => false,
    );
    const hide = await tool.execute("proof-hide", { action: "hide", ...opts }).then(
      (r) => r.details.ok === true,
      () => false,
    );
    const presenter = createCanvasWidgetPresenter(nodesRuntime);
    const available = (await presenter.availability({})).ok;
    const widget = (
      await presenter.present({
        document: {
          kind: "html",
          html: "<p>Synthetic proof</p>",
          hostedUrl: "/__openclaw__/canvas/documents/proof/index.html",
        },
        title: "Proof",
        context: {},
      })
    ).ok;
    observations.push({
      name: row.name,
      expected: row.eligible,
      present,
      hide,
      available,
      widget,
      commands: calls.slice(before).map((c) => c.command),
    });
  }
  console.log("CANVAS_SELECTION_PROOF " + JSON.stringify(observations));
  for (const row of observations) {
    assert.deepEqual(
      [row.present, row.hide, row.available, row.widget],
      Array(4).fill(row.expected),
      `CANVAS_SELECTION_CONTRACT:${row.name}`,
    );
    assert.deepEqual(
      row.commands,
      row.expected ? ["canvas.present", "canvas.hide", "canvas.present"] : [],
      `dispatch:${row.name}`,
    );
  }
} finally {
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  await rm(state, { recursive: true, force: true });
}
