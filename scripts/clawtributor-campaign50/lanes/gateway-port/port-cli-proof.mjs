import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, evidence, stage] = process.argv.slice(2);
assert.ok(target && evidence && ["baseline", "candidate"].includes(stage));
const require = createRequire(path.join(target, "package.json"));
const { WebSocketServer } = require("ws");
const {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} = await import(pathToFileURL(path.join(target, "src/gateway/minimal-gateway.test-helpers.ts")));

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-port-proof-"));
const token = "synthetic-gateway-port-proof-token";
const records = [];
const peers = [];

async function peer(label) {
  const observations = { tcp: 0, methods: [] };
  const server = createServer((_, response) => response.writeHead(404).end());
  server.on("connection", () => observations.tcp++);
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    sendMinimalGatewayConnectChallenge(socket, "synthetic-port-challenge");
    socket.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      observations.methods.push(frame.method);
      if (frame.method === "connect") {
        sendMinimalGatewayResponse(
          socket,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["logs.tail"],
            auth: { role: "operator", scopes: ["operator.admin"] },
          }),
        );
      } else if (frame.method === "logs.tail") {
        sendMinimalGatewayResponse(socket, frame.id, {
          file: "synthetic-gateway.log",
          cursor: 1,
          size: 1,
          lines: [`SYNTHETIC_PORT_ENDPOINT=${label}`],
        });
      } else {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "INVALID_REQUEST", message: "Unexpected proof method" },
          }),
        );
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const result = { label, server, sockets, observations, port, url: `ws://127.0.0.1:${port}` };
  peers.push(result);
  return result;
}

async function invoke(name, extraArgs, extraEnv, expectedPeer, expectedError, json = true) {
  const directory = path.join(root, name);
  const stateDir = path.join(directory, "state");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(stateDir, "openclaw.json");
  const fallbackLog = path.join(directory, "fallback.log");
  await fs.writeFile(fallbackLog, "UNEXPECTED_LOCAL_FALLBACK\n");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: { mode: "local", port: peers[0].port, auth: { mode: "token", token } },
      logging: { file: fallbackLog },
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  for (const key of [
    "OPENCLAW_PROFILE",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
  ])
    delete env[key];
  Object.assign(
    env,
    {
      HOME: directory,
      OPENCLAW_HOME: directory,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      NO_COLOR: "1",
    },
    extraEnv,
  );
  const before = peers.map(({ observations }) => ({
    tcp: observations.tcp,
    methods: observations.methods.length,
  }));
  const child = spawn(
    "pnpm",
    [
      "--silent",
      "openclaw",
      "logs",
      "--timeout",
      "1500",
      ...(json ? ["--json"] : []),
      ...extraArgs,
    ],
    {
      cwd: target,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  const deadline = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 90_000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let code;
  let signal;
  try {
    [code, signal] = await once(child, "close");
  } finally {
    clearTimeout(deadline);
  }
  const connections = peers.map(({ label, observations }, index) => ({
    label,
    count: observations.tcp - before[index].tcp,
    methods: observations.methods.slice(before[index].methods),
  }));
  const output = stdout + stderr;
  let frames = [];
  let validJson = true;
  if (json) {
    try {
      frames = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      validJson = false;
    }
  }
  const record = {
    stage,
    name,
    code,
    signal,
    connections,
    validJson,
    expectedMarker: expectedPeer
      ? output.includes(`SYNTHETIC_PORT_ENDPOINT=${expectedPeer.label}`)
      : false,
    invalidPort: output.includes("--port must be an integer between 1 and 65535."),
    conflictingTarget: output.includes("Use either --url or --port, not both."),
    cliErrorEnvelope: frames.some(
      (frame) => frame.ok === false && frame.error?.type === "cli_error",
    ),
    diagnosticCodes: [
      ...new Set(
        output.match(/\b(?:ERR_[A-Z_]+|ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ENOSPC)\b/g) ??
          [],
      ),
    ],
  };
  records.push(record);
  await fs.writeFile(path.join(evidence, `${stage}.json`), JSON.stringify(records, null, 2) + "\n");
  assert.equal(signal, null, JSON.stringify(record));
  assert.equal(validJson, true, JSON.stringify(record));
  if (expectedError) {
    assert.equal(code, 1, JSON.stringify(record));
    assert.ok(record[expectedError], JSON.stringify(record));
    if (json) assert.equal(record.cliErrorEnvelope, true, JSON.stringify(record));
    assert.equal(
      connections.reduce((sum, item) => sum + item.count, 0),
      0,
      JSON.stringify(record),
    );
  } else {
    assert.equal(code, 0, JSON.stringify(record));
    assert.equal(record.expectedMarker, true, JSON.stringify(record));
    for (const connection of connections) {
      if (connection.label === expectedPeer.label) {
        assert.ok(connection.count > 0, JSON.stringify(record));
        assert.ok(connection.methods.includes("logs.tail"), JSON.stringify(record));
      } else {
        assert.equal(connection.count, 0, JSON.stringify(record));
      }
    }
  }
}

try {
  await fs.mkdir(evidence, { recursive: true });
  const configured = await peer("configured");
  const other = await peer("other");
  await invoke("omitted", [], {}, configured);
  await invoke("environment-port", [], { OPENCLAW_GATEWAY_PORT: String(other.port) }, other);
  await invoke("empty-environment-port", [], { OPENCLAW_GATEWAY_PORT: "" }, configured);
  await invoke("environment-url", [], { OPENCLAW_GATEWAY_URL: other.url }, other);
  await invoke("valid", ["--port", String(other.port)], {}, other);
  await invoke(
    "valid-over-environment",
    ["--port", String(configured.port)],
    { OPENCLAW_GATEWAY_PORT: String(other.port), OPENCLAW_GATEWAY_URL: other.url },
    configured,
  );
  for (const [name, args] of [
    ["empty", ["--port", ""]],
    ["whitespace", ["--port", " \t "]],
    ["equals-empty", ["--port="]],
  ]) {
    await invoke(
      name,
      args,
      {},
      stage === "baseline" ? configured : undefined,
      stage === "candidate" ? "invalidPort" : undefined,
    );
  }
  await invoke("invalid-numeric", ["--port", "1e4"], {}, undefined, "invalidPort");
  await invoke(
    "target-conflict",
    ["--url", other.url, "--port", String(configured.port), "--token", token],
    {},
    undefined,
    "conflictingTarget",
  );
  await invoke(
    "empty-text",
    ["--port", ""],
    {},
    stage === "baseline" ? configured : undefined,
    stage === "candidate" ? "invalidPort" : undefined,
    false,
  );
  await invoke("valid-text", ["--port", String(other.port)], {}, other, undefined, false);
  console.log(`GATEWAY_PORT_CLI_${stage.toUpperCase()}_OK cases=${records.length}`);
} finally {
  for (const { sockets, server } of peers) {
    await closeMinimalGatewayServer(sockets);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(root, { recursive: true, force: true });
}
