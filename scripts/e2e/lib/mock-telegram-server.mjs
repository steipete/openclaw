import http from "node:http";

const DEFAULT_BOT_TOKEN = "1234567890:bundle-telegram-e2e-token";
const BOOLEAN_RESULT_METHODS = new Set([
  "deleteMyCommands",
  "deleteWebhook",
  "setMyCommands",
  "setWebhook",
]);

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
    req.on("aborted", () => reject(new Error("mock request aborted")));
    req.on("error", reject);
  });
}

function telegramResult(method) {
  if (method === "getMe") {
    return {
      id: 1234567890,
      is_bot: true,
      first_name: "Bundle",
      username: "openclaw_bundle_e2e_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
  }
  if (method === "getWebhookInfo") {
    return { url: "", has_custom_certificate: false, pending_update_count: 0 };
  }
  if (method === "getMyCommands") {
    return [];
  }
  return BOOLEAN_RESULT_METHODS.has(method) ? true : undefined;
}

async function handleTelegramRequest({ req, res, botToken, calls }) {
  const rawBody = await readRequestBody(req);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = /^\/bot([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (!match || match[1] !== botToken) {
    jsonResponse(res, 404, { ok: false, description: "mock_not_found" });
    return;
  }
  const method = match[2];
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    jsonResponse(res, 400, { ok: false, description: "mock_invalid_json" });
    return;
  }
  calls.push({
    method,
    rawBody,
    body,
    headers: { ...req.headers },
    timestamp: new Date().toISOString(),
    timeMs: Date.now(),
  });
  const result = telegramResult(method);
  if (result === undefined) {
    jsonResponse(res, 404, {
      ok: false,
      error_code: 404,
      description: `mock_unsupported_method:${method}`,
    });
    return;
  }
  jsonResponse(res, 200, { ok: true, result });
}

export async function startMockTelegramServer({ port = 0, botToken = DEFAULT_BOT_TOKEN } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    void handleTelegramRequest({ req, res, botToken, calls }).catch(() => {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      try {
        if (res.headersSent) {
          res.destroy();
        } else {
          jsonResponse(res, 500, { ok: false, description: "mock_internal_error" });
        }
      } catch {
        res.destroy();
      }
    });
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
    throw new Error("mock-telegram-server: failed to bind listener");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    botToken,
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
                `waitForCall: timed out after ${timeoutMs}ms (calls so far: ${calls.map((call) => call.method).join(", ") || "<none>"})`,
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
