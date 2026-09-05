import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { reactSlackMessage, removeSlackReaction } from "./actions.js";
import { getSlackWriteClient } from "./client.js";

describe("Slack reaction name HTTP boundary", () => {
  it("preserves custom names and glyph translations when adding and removing", async () => {
    const requests: Array<{ method: string; name: string | null }> = [];
    const expectedRequests: Array<{ method: string; name: string }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const method =
          new URL(request.url ?? "/", "http://127.0.0.1").pathname.split("/").at(-1) ?? "";
        requests.push({ method, name: body.get("name") });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Loopback port unavailable");
      const client = getSlackWriteClient("xoxb-synthetic-proof", {
        slackApiUrl: `http://127.0.0.1:${address.port}/api/`,
      });
      for (const [method, send] of [
        ["reactions.add", reactSlackMessage],
        ["reactions.remove", removeSlackReaction],
      ] as const) {
        for (const [emoji, expected] of [
          [":constructor:", "constructor"],
          ["custom_project", "custom_project"],
          ["👍", "thumbsup"],
          ["⚠️", "warning"],
          ["👍🏽", "thumbsup::skin-tone-4"],
        ] as const) {
          await send("C12345678", "1700000000.000100", emoji, { client });
          expectedRequests.push({ method, name: expected });
        }
      }
      process.stdout.write(
        `${JSON.stringify({ proof: "slack-reaction-name-observed", requests, expectedRequests })}\n`,
      );
      expect(requests, "SLACK_REACTION_NAME_MISMATCH").toEqual(expectedRequests);
      expect(requests).toHaveLength(10);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
