import http from "node:http";

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseRequestBody(rawBody, contentType) {
  if (!rawBody) {
    return {};
  }
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(rawBody);
    } catch {
      return { _raw: rawBody };
    }
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody).entries());
  }
  return { _raw: rawBody };
}

const RESPONSES = {
  "auth.test": ({ teamId, botUserId, botId }) => ({
    ok: true,
    url: "https://e2etest.slack.com/",
    team: "openclaw-e2e",
    user: "openclaw-bot",
    team_id: teamId,
    user_id: botUserId,
    bot_id: botId,
  }),
  "chat.postMessage": (_ctx, body) => ({
    ok: true,
    channel: body.channel ?? "C0E2ETEST",
    ts: `${Math.floor(Date.now() / 1000)}.0001`,
    message: {
      type: "message",
      user: "U0E2ETESTBOT",
      text: typeof body.text === "string" ? body.text : "",
      ts: `${Math.floor(Date.now() / 1000)}.0001`,
    },
  }),
  "conversations.info": (_ctx, body) => ({
    ok: true,
    channel: {
      id: body.channel ?? "C0E2ETEST",
      name: "e2e-test",
      is_channel: true,
      is_member: true,
    },
  }),
  "users.info": (_ctx, body) => ({
    ok: true,
    user: {
      id: body.user ?? "U0E2ETEST",
      name: "e2e-user",
      profile: { display_name: "e2e-user", real_name: "E2E User" },
    },
  }),
  "apps.connections.open": () => ({
    ok: false,
    error: "socket_mode_disabled_by_e2e_mock",
  }),
  "chat.update": (_ctx, body) => ({
    ok: true,
    channel: body.channel,
    ts: body.ts ?? `${Math.floor(Date.now() / 1000)}.0002`,
  }),
  "chat.delete": (_ctx, body) => ({
    ok: true,
    channel: body.channel,
    ts: body.ts,
  }),
  "reactions.add": () => ({ ok: true }),
  "reactions.remove": () => ({ ok: true }),
  "files.upload": () => ({
    ok: true,
    file: { id: "F0E2EFILE", name: "e2e", url_private: "https://e2etest.slack.com/file" },
  }),
};

export async function startMockSlackServer({
  port = 0,
  teamId = "T0E2ETEST",
  botUserId = "U0E2ETESTBOT",
  botId = "B0E2ETEST",
} = {}) {
  const calls = [];
  const ctx = { teamId, botUserId, botId };

  const server = http.createServer(async (req, res) => {
    const rawBody = await readRequestBody(req);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const apiMethod = url.pathname.replace(/^\/api\//, "");
    const body = parseRequestBody(rawBody, req.headers["content-type"]);
    const recorded = {
      method: apiMethod,
      body,
      rawBody,
      headers: { ...req.headers },
      timestamp: new Date().toISOString(),
      timeMs: Date.now(),
    };
    calls.push(recorded);

    const responder = RESPONSES[apiMethod];
    if (responder) {
      jsonResponse(res, 200, responder(ctx, body));
      return;
    }
    jsonResponse(res, 200, { ok: false, error: `mock_unhandled:${apiMethod}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock-slack-server: failed to bind listener");
  }

  return {
    url: `http://127.0.0.1:${address.port}/api/`,
    port: address.port,
    calls,
    waitForCall: (predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const found = calls.find(predicate);
          if (found) {
            resolve(found);
            return;
          }
          if (Date.now() > deadline) {
            reject(
              new Error(
                `waitForCall: timed out after ${timeoutMs}ms (calls so far: ${calls.map((c) => c.method).join(", ") || "<none>"})`,
              ),
            );
            return;
          }
          setTimeout(tick, intervalMs);
        };
        tick();
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
