import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, evidence] = process.argv.slice(2);
assert.ok(target && evidence);
const require = createRequire(path.join(target, "package.json"));
const { WebSocketServer } = require("ws");
const {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} = await import(pathToFileURL(path.join(target, "src/gateway/minimal-gateway.test-helpers.ts")));

const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-option-baseline-"));
const token = "synthetic-route-option-token";
const marker = "SYNTHETIC_ROUTE_OPTION_HEALTH";
const observations = { tcp: 0, methods: [] };
const records = [];
const server = createServer((_, response) => response.writeHead(404).end());
server.on("connection", () => observations.tcp++);
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  sendMinimalGatewayConnectChallenge(socket, "synthetic-route-option-challenge");
  socket.on("message", (data) => {
    const frame = parseMinimalGatewayRequestFrame(data);
    observations.methods.push(frame.method);
    if (frame.method === "connect") {
      sendMinimalGatewayResponse(
        socket,
        frame.id,
        buildMinimalGatewayHelloOkPayload({
          connId: "synthetic-route-option-peer",
          methods: ["health", "status"],
          auth: { role: "operator", scopes: ["operator.admin"] },
        }),
      );
    } else if (frame.method === "health") {
      sendMinimalGatewayResponse(socket, frame.id, {
        ok: true,
        ts: 1700000000000,
        durationMs: 7,
        channels: {},
        channelOrder: [],
        channelLabels: {},
        heartbeatSeconds: 0,
        defaultAgentId: "main",
        agents: [],
        sessions: { path: "synthetic.sqlite", count: 0, recent: [] },
        proofMarker: marker,
      });
    } else if (frame.method === "status") {
      sendMinimalGatewayResponse(socket, frame.id, {
        degradedSecretOwners: [],
        degradedPlugins: [],
      });
    } else {
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "Unexpected synthetic proof method" },
        }),
      );
    }
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const url = `ws://127.0.0.1:${port}`;

async function retainOutput(label, stream, text) {
  const bytes = Buffer.from(text.replaceAll(token, "[SYNTHETIC_TOKEN]"));
  const edgeBytes = 64 * 1024;
  const truncated = bytes.length > 2 * edgeBytes;
  const retained = truncated
    ? Buffer.concat([
        bytes.subarray(0, edgeBytes),
        Buffer.from(`\n[${bytes.length - 2 * edgeBytes} bytes omitted]\n`),
        bytes.subarray(-edgeBytes),
      ])
    : bytes;
  const file = `${label}.${stream}.txt`;
  await fs.writeFile(path.join(evidence, file), retained);
  return { file, sourceBytes: bytes.length, retainedBytes: retained.length, truncated };
}

async function invoke(testCase, fullCommander) {
  const label = `${testCase.name}-${fullCommander ? "commander" : "route"}`;
  const home = path.join(root, label);
  const state = path.join(home, "state");
  const configPath = path.join(state, "fixture.json");
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        port,
        auth: { mode: "token", token },
      },
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
    "OPENCLAW_DISABLE_ROUTE_FIRST",
  ])
    delete env[key];
  Object.assign(env, {
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
    NO_COLOR: "1",
  });
  if (fullCommander) env.OPENCLAW_DISABLE_ROUTE_FIRST = "1";
  const before = { tcp: observations.tcp, methods: observations.methods.length };
  const child = spawn("pnpm", ["--silent", "openclaw", ...testCase.args], {
    cwd: target,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const deadline = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 90000);
  let code;
  let signal;
  try {
    [code, signal] = await once(child, "close");
  } finally {
    clearTimeout(deadline);
  }
  const [stdoutCapture, stderrCapture] = await Promise.all([
    retainOutput(label, "stdout", stdout),
    retainOutput(label, "stderr", stderr),
  ]);
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {}
  const errorMessage = output?.error?.message ?? "";
  const reject = testCase.invalidFlag !== undefined;
  const record = {
    name: testCase.name,
    mode: fullCommander ? "full-commander" : "route-first",
    code,
    signal,
    stdoutCapture,
    stderrCapture,
    tcp: observations.tcp - before.tcp,
    methods: observations.methods.slice(before.methods),
    jsonDocument: output !== undefined,
    healthMarker: output?.proofMarker === marker && output?.ok === true,
    statusPeerReachable: output?.gateway?.reachable === true && output?.gateway?.url === url,
    cliErrorEnvelope: output?.ok === false && output?.error?.type === "cli_error",
    expectedUnknownOption:
      testCase.invalidFlag !== undefined &&
      errorMessage.includes(`OpenClaw does not recognize option "${testCase.invalidFlag}".`),
    stderrUnknownOption:
      testCase.invalidFlag !== undefined &&
      stderr.includes(`OpenClaw does not recognize option "${testCase.invalidFlag}".`),
  };
  records.push(record);
  await fs.writeFile(
    path.join(evidence, "cli-candidate.json"),
    JSON.stringify(records, null, 2) + "\n",
  );
  assert.equal(signal, null, JSON.stringify(record));
  assert.equal(record.jsonDocument, true, JSON.stringify(record));
  if (reject) {
    assert.equal(code, 1, JSON.stringify(record));
    assert.equal(record.cliErrorEnvelope, true, JSON.stringify(record));
    assert.equal(record.expectedUnknownOption, true, JSON.stringify(record));
    assert.equal(record.tcp, 0, JSON.stringify(record));
  } else {
    assert.equal(code, 0, JSON.stringify(record));
    assert.ok(record.tcp > 0, JSON.stringify(record));
    assert.ok(record.methods.includes("connect"), JSON.stringify(record));
    if (testCase.command === "health") {
      assert.equal(record.healthMarker, true, JSON.stringify(record));
      assert.ok(record.methods.includes("health"), JSON.stringify(record));
    } else {
      assert.equal(record.statusPeerReachable, true, JSON.stringify(record));
    }
  }
}

try {
  await fs.mkdir(evidence, { recursive: true });
  const cases = [
    { name: "health-valid", command: "health", args: ["health", "--json", "--timeout", "2000"] },
    {
      name: "health-pre-json",
      command: "health",
      args: ["--json", "health", "--timeout", "2000"],
      invalidFlag: "--json",
    },
    {
      name: "health-pre-verbose",
      command: "health",
      args: ["--verbose", "health", "--json", "--timeout", "2000"],
      invalidFlag: "--verbose",
    },
    {
      name: "health-pre-timeout-equals",
      command: "health",
      args: ["--timeout=2000", "health", "--json"],
      invalidFlag: "--timeout=2000",
    },
    {
      name: "health-root-profile",
      command: "health",
      args: ["--profile", "work", "health", "--json", "--timeout", "2000"],
    },
    {
      name: "health-root-value-command-word",
      command: "health",
      args: ["--profile", "health", "--no-color", "health", "--json", "--timeout", "2000"],
    },
    { name: "status-valid", command: "status", args: ["status", "--json", "--timeout", "2000"] },
    {
      name: "status-pre-json",
      command: "status",
      args: ["--json", "status", "--timeout", "2000"],
      invalidFlag: "--json",
    },
  ];
  for (const testCase of cases) {
    await invoke(testCase, false);
    await invoke(testCase, true);
  }
  console.log(
    `ROUTE_OPTION_CANDIDATE_CONFIRMED: ${records.length} CLI observations; both paths reject four malformed cases; valid controls succeed`,
  );
} finally {
  await closeMinimalGatewayServer(sockets);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
