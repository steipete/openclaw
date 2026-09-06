import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export const MODEL_ID = "deepseek-v4-flash";
export const MODEL_REF = `deepseek/${MODEL_ID}`;
export const ORCHARD_TEXT =
  "The amber orchard uses cedar planting rows and a weekly irrigation review. Soil observations remain in the orchard log, and each completed review records its watering decision. ";

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return textOf(value.text ?? value.content);
  return "";
}

function reply(response, text, inputTokens) {
  const identity = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
  };
  const chunks = [
    {
      ...identity,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { ...identity, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {
      ...identity,
      choices: [],
      usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.end(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

export async function startProvider() {
  let active;
  const errors = [];
  const pending = new Set();
  const server = createServer((request, response) => {
    const task = (async () => {
      assert.ok(active, "Provider traffic outside an owned case");
      if (request.method === "GET" && request.url === "/v1/models") {
        active.modelListRequests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        assert.ok(bytes < 3 * 1024 * 1024, "Synthetic provider request exceeded its bound");
        chunks.push(buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, MODEL_ID);
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.messages));
      const user = body.messages.filter((message) => message.role === "user").at(-1);
      const lastUser = textOf(user);
      const system = body.messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map(textOf)
        .join("\n");
      const summary = /context summarization assistant/i.test(system);
      const flush = !summary && lastUser.startsWith("Pre-compaction memory flush.");
      const kind = summary
        ? "summary"
        : flush
          ? "flush"
          : lastUser.includes(active.seedMarker) && active.phase === "seed"
            ? "seed"
            : "reply";
      if (active.phase === "seed")
        assert.equal(kind, "seed", "Fresh seed unexpectedly ran maintenance");
      if (kind === "seed")
        assert.ok(
          lastUser.length >= active.seedTurnChars,
          "Seed transcript was truncated before provider dispatch",
        );
      if (kind === "reply")
        assert.ok(lastUser.includes(active.replyMarker), "The requested user reply was lost");
      assert.ok(active.requests.length < 12, "Unexpected provider retry or maintenance loop");
      const containsSummary = textOf(body.messages).includes(active.summaryMarker);
      const inputTokens =
        kind === "seed"
          ? active.seedInputTokens
          : kind === "summary" || containsSummary
            ? 1000
            : active.inputTokens + (kind === "flush" ? 10 : 20);
      active.requests.push({
        kind,
        phase: active.phase,
        bytes,
        messageCount: body.messages.length,
        lastUserChars: lastUser.length,
        containsSummary,
        atMs: Date.now(),
        emittedInputTokens: inputTokens,
      });
      if (kind === "summary") {
        const summarizedText = textOf(body.messages);
        const identifiers = active.seedMarkers.filter((marker) => summarizedText.includes(marker));
        assert.ok(identifiers.length > 0, "Summary did not receive genuine prior seed messages");
        assert.ok(
          !summarizedText.includes(active.replyMarker),
          "Summary consumed the pending user ask",
        );
        reply(
          response,
          `## Decisions\n- The amber orchard uses cedar planting rows and a weekly irrigation review. Completed reviews record soil observations and watering decisions.\n\n## Open TODOs\n- Continue the orchard schedule in the next user turn.\n\n## Constraints/Rules\n- Preserve the orchard plan and completed-review conclusions.\n\n## Pending user asks\nNone; the historical seed request was answered.\n\n## Exact identifiers\n- amber-orchard\n${identifiers.map((marker) => `- ${marker}`).join("\n")}\n- ${active.summaryMarker}`,
          inputTokens,
        );
      } else if (kind === "flush") {
        reply(response, "NO_REPLY", inputTokens);
      } else if (kind === "seed") {
        reply(response, active.seedMarker, inputTokens);
      } else {
        if (active.requests.some((entry) => entry.kind === "summary"))
          assert.ok(containsSummary, "Reply did not consume the committed summary");
        reply(response, active.replyMarker, inputTokens);
      }
    })().catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) {
        response.writeHead(500);
        response.end("Synthetic provider contract failed");
      }
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    errors,
    arm(proof) {
      active = proof;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(pending);
    },
  };
}
