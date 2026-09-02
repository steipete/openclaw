// Ephemeral proof overlay; not a production seam or a permanent Gateway suite.
import fs from "node:fs/promises";
import path from "node:path";
import {
  generateWAMessage,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WAMessage,
} from "baileys";
import { expect, it, vi } from "vitest";
import { startMinimalRealGateway } from "../../../src/gateway/minimal-gateway.test-helpers.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../src/test-utils/channel-plugins.js";
import { startQaGatewayRpcClient } from "../../qa-lab/src/gateway-rpc-client.js";
import { renderQaMarkdownReport } from "../../qa-lab/src/report.js";
import { whatsappChannelOutbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { createWebSendApi } from "./inbound/send-api.js";
import { cacheInboundMessageMeta } from "./quoted-message.js";

const connection = vi.hoisted(() => ({
  controllers: new Map<string, { getActiveListener: () => unknown }>(),
}));

// Existing delivery-recovery tests replace this connection boundary the same way.
vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: (accountId: string) =>
    connection.controllers.get(accountId) ?? null,
}));

const accountId = "default";
const groupJid = "120363000127959@g.us";
const peerJid = "15550001279@s.whatsapp.net";
const selfJid = "15550009999@s.whatsapp.net";
const originalText = "Synthetic original message for the quote preview.";
// quoted-message.ts owns a ten-minute cache. Age fixtures before any RPC starts.
const expiredAgeMs = 10 * 60 * 1_000 + 1;

type Scenario = {
  name: string;
  to: string;
  cache: "warm" | "missing" | "expired" | "media" | "unquoted";
  expectedPreview?: string;
};
const scenarios: Scenario[] = [
  { name: "group-warm", to: groupJid, cache: "warm", expectedPreview: originalText },
  { name: "group-missing", to: groupJid, cache: "missing" },
  { name: "group-expired", to: groupJid, cache: "expired" },
  { name: "direct-warm", to: peerJid, cache: "warm", expectedPreview: originalText },
  { name: "direct-missing", to: peerJid, cache: "missing" },
  { name: "direct-expired", to: peerJid, cache: "expired" },
  { name: "group-media", to: groupJid, cache: "media", expectedPreview: "<media:sticker>" },
  { name: "group-unquoted", to: groupJid, cache: "unquoted" },
];

type Observation = {
  jid: string;
  content: AnyMessageContent;
  options: MiscMessageGenerationOptions | null;
  encoded: WAMessage;
};
type CaseResult = {
  name: string;
  status: "pass" | "fail";
  request: Record<string, unknown>;
  response?: unknown;
  observations: Observation[];
  error?: string;
};

it("preserves accepted Gateway reply bodies and emits quotes only with cached previews", async () => {
  const outputDir = process.env.OPENCLAW_QUOTE_PROOF_DIR;
  const bindingPath = process.env.OPENCLAW_QUOTE_PROOF_BINDING;
  if (!outputDir || !bindingPath) {
    throw new Error("The reviewed proof controller must supply output and source-binding paths.");
  }
  const binding = JSON.parse(await fs.readFile(bindingPath, "utf8"));
  const startedAt = new Date();
  const cases: CaseResult[] = [];
  const cleanupErrors: string[] = [];
  let setupError: string | undefined;
  let gateway: Awaited<ReturnType<typeof startMinimalRealGateway>> | undefined;
  let client: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | undefined;
  let observations: Observation[] = [];
  let sequence = 0;
  try {
    const { setActivePluginRegistry } = await import("../../../src/plugins/runtime.js");
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "synthetic-quote-proof",
          plugin: {
            ...createChannelTestPluginBase({
              id: "whatsapp",
              capabilities: { chatTypes: ["direct", "group"] },
              config: {
                resolveAccount: () => ({ accountId, enabled: true }),
                isConfigured: async () => true,
              },
            }),
            outbound: whatsappChannelOutbound,
            message: whatsappMessageAdapter,
          },
        },
      ]),
    );
    gateway = await startMinimalRealGateway();
    const sendApi = createWebSendApi({
      defaultAccountId: accountId,
      sock: {
        async sendMessage(jid, content, options) {
          const encoded = await generateWAMessage(jid, content, {
            ...options,
            userJid: selfJid,
            messageId: `SYNTHETIC-127959-${++sequence}`,
            upload: async () => {
              throw new Error("Unexpected media upload in text-reply proof");
            },
          });
          observations.push({ jid, content, options: options ?? null, encoded });
          // Fake socket acceptance; encoding above is the unmodified Baileys implementation.
          return encoded;
        },
        sendPresenceUpdate: async () => undefined,
      },
    });
    connection.controllers.set(accountId, { getActiveListener: () => sendApi });
    client = await startQaGatewayRpcClient({
      wsUrl: gateway.url,
      token: gateway.token,
      logs: () => "",
    });
    for (const scenario of scenarios) {
      observations = [];
      const replyToId = `SYNTHETIC-INBOUND-${scenario.name}`;
      const body = `Synthetic reply ${scenario.name}: the complete outgoing body must survive.`;
      const request = {
        channel: "whatsapp",
        accountId,
        to: scenario.to,
        message: body,
        ...(scenario.cache === "unquoted" ? {} : { replyToId }),
        idempotencyKey: `synthetic-127959-${scenario.name}`,
      };
      const result: CaseResult = { name: scenario.name, status: "fail", request, observations };
      try {
        if (
          scenario.cache === "warm" ||
          scenario.cache === "media" ||
          scenario.cache === "expired"
        ) {
          const ageClock =
            scenario.cache === "expired"
              ? vi.spyOn(Date, "now").mockReturnValue(Date.now() - expiredAgeMs)
              : undefined;
          try {
            cacheInboundMessageMeta(accountId, scenario.to, replyToId, {
              participant: peerJid,
              fromMe: false,
              ...(scenario.cache === "media"
                ? { media: { kind: "sticker" } }
                : { body: originalText }),
            });
          } finally {
            ageClock?.mockRestore();
          }
        }
        result.response = await client.request("send", request);
        expect(observations, "one accepted socket message per Gateway send").toHaveLength(1);
        const observed = observations[0]!;
        expect(observed.jid).toBe(scenario.to);
        expect(observed.encoded.key.remoteJid).toBe(scenario.to);
        expect(result.response).toMatchObject({
          channel: "whatsapp",
          runId: request.idempotencyKey,
          messageId: observed.encoded.key.id,
        });
        const content = observed.encoded.message?.extendedTextMessage;
        expect(content?.text ?? observed.encoded.message?.conversation).toBe(body);
        if (scenario.expectedPreview) {
          expect(content?.contextInfo).toMatchObject({
            stanzaId: replyToId,
            participant: peerJid,
            quotedMessage: { conversation: scenario.expectedPreview },
          });
        } else {
          expect(content?.contextInfo?.stanzaId ?? null).toBeNull();
          expect(content?.contextInfo?.quotedMessage ?? null).toBeNull();
        }
        result.status = "pass";
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      cases.push(result);
    }
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await client?.stop();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      await gateway?.close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    connection.controllers.clear();
    vi.restoreAllMocks();
    const notes = [
      "Real authenticated Gateway send RPC, durable delivery, WhatsApp outbound owner/send API, and Baileys encoding; mock socket acceptance.",
      "No real WhatsApp service/client rendering, inbound network turn, or model-provider inference was exercised.",
      "Expired fixtures were pre-aged synchronously before RPC; chronological warm-to-expired owner behavior has separate permanent regression evidence.",
      "This is eight scenarios in one Vitest test, keeping one Gateway lifecycle and avoiding runtime-registry reset between sends.",
    ];
    const passed =
      cases.length === scenarios.length &&
      cases.every((item) => item.status === "pass") &&
      !setupError &&
      cleanupErrors.length === 0;
    const verdict = {
      schema: "openclaw-pr-127959-gateway-quote-proof-v1",
      status: passed ? "pass" : "fail",
      binding,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      expectedScenarios: scenarios.length,
      executedScenarios: cases.length,
      passedScenarios: cases.filter((item) => item.status === "pass").length,
      setupError: setupError ?? null,
      cleanupErrors,
      cases,
      limitations: notes,
    };
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, "verdict.json"),
      `${JSON.stringify(verdict, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(outputDir, "report.md"),
      renderQaMarkdownReport({
        title: "WhatsApp quote preview Gateway delivery proof",
        startedAt,
        finishedAt: new Date(),
        scenarios: cases.map((item) => ({
          name: item.name,
          status: item.status,
          details: item.error,
        })),
        checks: [
          {
            name: "All eight scenarios executed",
            status: cases.length === scenarios.length ? "pass" : "fail",
            details: setupError,
          },
          {
            name: "Gateway and client closed",
            status: cleanupErrors.length === 0 ? "pass" : "fail",
            details: cleanupErrors.join("\n") || undefined,
          },
        ],
        notes,
      }),
    );
    expect(
      verdict,
      "see verdict.json for every request and full encoded observation",
    ).toMatchObject({
      status: "pass",
      executedScenarios: 8,
      passedScenarios: 8,
      setupError: null,
      cleanupErrors: [],
    });
  }
}, 120_000);
