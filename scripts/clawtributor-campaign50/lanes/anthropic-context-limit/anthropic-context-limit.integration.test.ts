import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import type { Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

const text = "The answer reaches the available context boundary.";
const profiles = [
  { name: "buffered", id: "claude-opus-5", contextWindow: 1_000_000 },
  { name: "unbuffered", id: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
];
const reasons = [
  { name: "context-limit", reason: "model_context_window_exceeded", expected: "length" },
  { name: "output-limit", reason: "max_tokens", expected: "length" },
  { name: "normal-stop", reason: "end_turn", expected: "stop" },
];

const initialHost = getAiTransportHost();
beforeEach(() => configureAiTransportHost({ buildModelFetch: () => fetch }));
afterEach(() => configureAiTransportHost(initialHost));

describe("Anthropic context-limit terminal over HTTP", () => {
  for (const lane of ["direct", "managed"]) {
    for (const profile of profiles) {
      for (const scenario of reasons) {
        it(`${lane} ${profile.name} ${scenario.name}`, async () => {
          const requests: Array<{
            method?: string;
            path?: string;
            model?: string;
            stream?: boolean;
          }> = [];
          const events = [
            {
              type: "message_start",
              message: {
                id: "msg_context_limit",
                type: "message",
                role: "assistant",
                model: profile.id,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: profile.contextWindow - 3, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: scenario.reason, stop_sequence: null },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ];
          const body = events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join("");
          const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push({
              method: request.method,
              path: request.url,
              model: payload.model,
              stream: payload.stream,
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(body);
          });
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.off("error", reject);
              resolve();
            });
          });
          const { port } = server.address() as AddressInfo;
          const model = {
            id: profile.id,
            name: profile.id,
            api: "anthropic-messages",
            provider: "anthropic",
            baseUrl: `http://127.0.0.1:${port}`,
            reasoning: true,
            input: ["text"],
            contextWindow: profile.contextWindow,
            maxTokens: 2_048,
            cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
          } satisfies Model<"anthropic-messages">;
          const context = {
            messages: [{ role: "user" as const, content: "Finish the answer.", timestamp: 0 }],
          };
          try {
            const stream = await Promise.resolve(
              lane === "direct"
                ? streamAnthropic(model, context, {
                    apiKey: "synthetic-test-key",
                    cacheRetention: "none",
                    signal: AbortSignal.timeout(5_000),
                  })
                : createAnthropicMessagesTransportStreamFn()(model, context, {
                    apiKey: "synthetic-test-key",
                    cacheRetention: "none",
                    signal: AbortSignal.timeout(5_000),
                  }),
            );
            const eventTypes: string[] = [];
            for await (const event of stream) eventTypes.push(event.type);
            const result = await stream.result();
            expect(requests).toEqual([
              { method: "POST", path: "/v1/messages", model: profile.id, stream: true },
            ]);
            expect(result.stopReason, result.errorMessage).toBe(scenario.expected);
            expect(result.errorMessage).toBeUndefined();
            expect(result.content).toEqual([{ type: "text", text }]);
            expect(result.usage).toMatchObject({
              input: profile.contextWindow - 3,
              output: 3,
              totalTokens: profile.contextWindow,
            });
            expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        });
      }
    }
  }
});
