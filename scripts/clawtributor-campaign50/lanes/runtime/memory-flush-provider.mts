import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

export const MODEL_ID = "gpt-5.6-luna";
export const MODEL_REF = `mock-openai/${MODEL_ID}`;
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function createCase(name: string) {
  const id = randomUUID();
  return {
    name,
    sessionId: id,
    sessionKey: `agent:qa:memory-fresh-${id}`,
    finalMarker: `QA_MEMORY_FINAL_${id}`,
    recoveryMarker: `QA_MEMORY_NEXT_${id}`,
    summaryMarker: `QA_MEMORY_SUMMARY_${id}`,
    firstRequest: gate(),
    releaseFirst: gate(),
    requests: [] as Array<{ kind: "summary" | "reply" | "continuation"; bytes: number }>,
  };
}
export type ProofCase = ReturnType<typeof createCase>;
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return textOf(item.text ?? item.content);
  }
  return "";
}
function assistant(response: ServerResponse, text: string) {
  const message = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}
export async function startProvider(
  observe: (event: string, details: Record<string, unknown>) => void = () => {},
) {
  let active: ProofCase | undefined;
  const errors: string[] = [];
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: MODEL_ID, object: "model" }] }));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses", "Unexpected outbound provider route");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        assert.ok(bytes <= 4 * 1024 * 1024, "Provider request exceeded proof bound");
        chunks.push(buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, MODEL_ID);
      const proof = active;
      assert.ok(proof, "Provider request outside an owned case");
      assert.ok(proof.requests.length < 32, "Unexpected retry/summarization loop");
      const input: Array<Record<string, unknown>> = Array.isArray(body.input) ? body.input : [];
      const instructions = [
        textOf(body.instructions),
        ...input.filter((item) => item.role === "system" || item.role === "developer").map(textOf),
      ].join("\n");
      const isSummary =
        /context summarization assistant[\s\S]*structured summary[\s\S]*do not continue/i.test(
          instructions,
        );
      const isContinuation =
        !isSummary &&
        input.some((item) => item.role === "user" && textOf(item).includes(proof.recoveryMarker));
      const kind = isSummary ? "summary" : isContinuation ? "continuation" : "reply";
      if (isContinuation && proof.requests.some((request) => request.kind === "summary")) {
        assert.ok(
          textOf(input).includes(proof.summaryMarker),
          "Continuation did not consume the committed summary",
        );
      }
      proof.requests.push({ kind, bytes });
      observe("provider-request", {
        case: proof.name,
        kind,
        bytes,
        hasFinalMarker: textOf(input).includes(proof.finalMarker),
        hasRecoveryMarker: textOf(input).includes(proof.recoveryMarker),
        hasSummaryMarker: textOf(input).includes(proof.summaryMarker),
      });
      response.once("close", () =>
        observe("provider-response-closed", {
          case: proof.name,
          kind,
          writableEnded: response.writableEnded,
        }),
      );
      if (proof.requests.length === 1) {
        proof.firstRequest.resolve();
        await proof.releaseFirst.promise;
      }
      if (response.destroyed) return;
      observe("provider-response", { case: proof.name, kind });
      assistant(
        response,
        isSummary
          ? `## Decisions\n- Retain the historical marker amber-orchid.\n\n## Open TODOs\n- Continue the user's request.\n\n## Constraints/Rules\n- Historical work is complete.\n\n## Pending user asks\n- Reply with the latest requested marker.\n\n## Exact identifiers\n- amber-orchid\n- ${proof.summaryMarker}`
          : isContinuation
            ? proof.recoveryMarker
            : proof.finalMarker,
      );
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      observe("provider-error", { error: errors.at(-1) });
      if (!response.destroyed) {
        response.writeHead(500);
        response.end("Synthetic provider assertion failed");
      }
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    errors,
    arm(proof: ProofCase) {
      active = proof;
    },
    async stop() {
      active?.releaseFirst.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(pending);
    },
  };
}
