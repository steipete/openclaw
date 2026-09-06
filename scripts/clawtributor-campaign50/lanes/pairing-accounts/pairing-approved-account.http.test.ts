import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synologyChatPlugin } from "../../../extensions/synology-chat/api.js";
import type { OpenClawConfig } from "../../config/types.js";
import { notifyPairingApproved } from "./pairing.js";

describe("approved account notification HTTP boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("selects the approved account and surfaces undelivered notifications", async () => {
    vi.stubEnv("SYNOLOGY_CHAT_INCOMING_URL", "");
    const requests: Array<{ path: string; payload: unknown }> = [];
    const outcomes: Array<{ label: string; outcome: string; path: string | null }> = [];
    let accept = true;
    const server = createServer((request, response) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = new URLSearchParams(Buffer.concat(parts).toString("utf8"));
        requests.push({
          path: request.url ?? "",
          payload: JSON.parse(body.get("payload") ?? "null"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: accept }));
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: false, error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Loopback port unavailable");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const cfg: OpenClawConfig = {
        channels: {
          "synology-chat": {
            token: "default-fixture",
            incomingUrl: `${baseUrl}/default`,
            accounts: { beta: { token: "beta-fixture", incomingUrl: `${baseUrl}/beta` } },
          },
        },
      };
      for (const step of [
        { label: "selected", accountId: "beta", accept: true, configured: true },
        { label: "default", accountId: undefined, accept: true, configured: true },
        { label: "rejected", accountId: "beta", accept: false, configured: true },
        { label: "missing", accountId: "beta", accept: true, configured: false },
      ]) {
        accept = step.accept;
        const before = requests.length;
        let outcome = "returned";
        try {
          await notifyPairingApproved({
            channelId: "synology-chat",
            id: "42",
            cfg: step.configured
              ? cfg
              : { channels: { "synology-chat": { accounts: { beta: { token: "fixture" } } } } },
            accountId: step.accountId,
            pairingAdapter: synologyChatPlugin.pairing,
          });
        } catch {
          outcome = "threw";
        }
        outcomes.push({
          label: step.label,
          outcome,
          path: requests.length > before ? requests.at(-1)!.path : null,
        });
      }
      process.stdout.write(
        `${JSON.stringify({ proof: "pairing-account-http-observed", outcomes, requests })}\n`,
      );
      expect(outcomes, "PAIRING_ACCOUNT_HTTP_MISMATCH").toEqual([
        { label: "selected", outcome: "returned", path: "/beta" },
        { label: "default", outcome: "returned", path: "/default" },
        { label: "rejected", outcome: "threw", path: "/beta" },
        { label: "missing", outcome: "threw", path: null },
      ]);
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(request.payload).toEqual({
          text: "OpenClaw: your access has been approved.",
          user_ids: [42],
        });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
