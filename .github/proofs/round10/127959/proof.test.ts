// Ephemeral proof: synthetic socket events, real automatic delivery and Baileys encoding.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { generateWAMessage, type AnyMessageContent, type MiscMessageGenerationOptions, type WASocket } from "baileys";
import { createChannelIngressQueueForTests, closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import type { WhatsAppDurableInboundQueue } from "../inbound/durable-receive.js";
import { attachWebInboxToSocket } from "../inbound/monitor.js";
import { cacheInboundMessageMeta, lookupInboundMessageMeta } from "../quoted-message.js";
import { resolveWhatsAppSocketTiming } from "../socket-timing.js";
import { createWhatsAppReplyTransportContext, deliverWebReply } from "./deliver-reply.js";

const accountId = "default";
const groupJid = "120363000127959@g.us";
const peerJid = "15550001279@s.whatsapp.net";
const selfJid = "15550009999@s.whatsapp.net";
const originalText = "Synthetic original message for the quote preview.";
const scenarios = [
  { id: "group-missing", jid: groupJid, cache: "missing" },
  { id: "group-warm", jid: groupJid, cache: "warm", preview: originalText },
  { id: "group-expired", jid: groupJid, cache: "expired" },
  { id: "direct-missing", jid: peerJid, cache: "missing" },
  { id: "direct-warm", jid: peerJid, cache: "warm", preview: originalText },
  { id: "direct-expired", jid: peerJid, cache: "expired" },
  { id: "group-media", jid: groupJid, cache: "media", preview: "<media:sticker>" },
  { id: "group-unquoted", jid: groupJid, cache: "unquoted" },
] as const;
type Scenario = (typeof scenarios)[number];
type Observation = {
  jid: string;
  messageId: string | null | undefined;
  encodedText: string | null | undefined;
  quoteId?: string | null;
  participant?: string | null;
  quotedText?: string | null;
  optionsPresent: boolean;
};
type CaseResult = {
  id: string;
  status: "pass" | "fail";
  inboundId: string;
  requestedQuoteId?: string;
  expectedBody: string;
  admissionKind?: string;
  providerAccepted?: boolean;
  resultIds?: string[];
  receiptIds?: string[];
  observations: Observation[];
  error?: string;
};

it("preserves automatic reply bodies and quotes only available previews", async () => {
  const outputDir = process.env.OPENCLAW_AUTOMATIC_QUOTE_PROOF_DIR;
  const bindingPath = process.env.OPENCLAW_AUTOMATIC_QUOTE_PROOF_BINDING;
  if (!outputDir || !bindingPath) {
    throw new Error("The reviewed controller must supply automatic proof output and binding paths.");
  }
  const binding = JSON.parse(await fs.readFile(bindingPath, "utf8"));
  const results: CaseResult[] = [];
  const unexpectedMessages: string[] = [];
  const cleanupErrors: string[] = [];
  const replyLogs: Array<{ level: "info" | "warn"; message: string }> = [];
  const observations: Observation[] = [];
  const ev = new EventEmitter();
  const inboundCases = new Map<string, Scenario>();
  const startedAt = new Date().toISOString();
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let listener: Awaited<ReturnType<typeof attachWebInboxToSocket>> | undefined;
  let queue: WhatsAppDurableInboundQueue | undefined;
  let setupError: string | undefined;
  let sequence = 0;
  let socketClosed = false;
  let queueDrained = false;
  // Only the external socket is synthetic. The attached session, admission,
  // platform.reply closure, delivery receipt and encoder stay production-owned.
  const socketFixture = {
    ev,
    user: { id: selfJid },
    end: () => { socketClosed = true; },
    sendPresenceUpdate: async () => undefined,
    readMessages: async () => undefined,
    fetchAccountReachoutTimelock: async () => ({ isActive: false }),
    groupFetchAllParticipating: async () => ({}),
    groupMetadata: async (jid: string) => ({ id: jid, subject: "Synthetic proof group", participants: [{ id: peerJid }, { id: selfJid }] }),
    async sendMessage(jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) {
      const encoded = await generateWAMessage(jid, content, {
        ...options,
        userJid: selfJid,
        messageId: `SYNTHETIC-AUTOMATIC-127959-${++sequence}`,
        upload: async () => { throw new Error("Unexpected media upload in text-reply proof"); },
      });
      const text = encoded.message?.extendedTextMessage;
      // Record the actual body/quote projection; incidental random reporting bytes are irrelevant.
      observations.push({
        jid: encoded.key.remoteJid ?? jid,
        messageId: encoded.key.id,
        encodedText: text?.text ?? encoded.message?.conversation,
        quoteId: text?.contextInfo?.stanzaId,
        participant: text?.contextInfo?.participant,
        quotedText: text?.contextInfo?.quotedMessage?.conversation,
        optionsPresent: options !== undefined,
      });
      return encoded;
    },
  };
  try {
    state = await createOpenClawTestState({ label: "automatic-quote-proof" });
    const authDir = state.path("auth");
    await fs.mkdir(authDir);
    type QueuePayload = Parameters<WhatsAppDurableInboundQueue["enqueue"]>[1];
    queue = createChannelIngressQueueForTests<QueuePayload>({ channelId: "whatsapp", accountId, stateDir: state.stateDir });
    listener = await attachWebInboxToSocket({
      // WASocket exposes many unrelated network methods; this external fixture supplies
      // every operation reached by the real text-only attached-inbox path.
      sock: socketFixture as unknown as WASocket,
      cfg: { channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+15550001279"], groupPolicy: "allowlist", groupAllowFrom: ["+15550001279"], groups: { "*": { requireMention: false } } } } },
      accountId,
      authDir,
      socketTiming: resolveWhatsAppSocketTiming(),
      verbose: false,
      durableInboundQueue: queue,
      onMessage: async (message) => {
        const inboundId = message.event.id ?? "";
        const scenario = inboundCases.get(inboundId);
        if (!scenario || results.some((result) => result.inboundId === inboundId)) {
          unexpectedMessages.push(inboundId);
          return;
        }
        const requestedQuoteId = scenario.cache === "unquoted" ? undefined : `SYNTHETIC-QUOTE-${scenario.id}`;
        const expectedBody = `Synthetic automatic reply ${scenario.id}: the complete outgoing body must survive.`;
        const result: CaseResult = { id: scenario.id, status: "fail", inboundId, requestedQuoteId, expectedBody, observations: [] };
        const before = observations.length;
        try {
          expect(message.admission.accountId).toBe(accountId);
          expect(message.admission.senderAccess.allowed).toBe(true);
          expect(message.platform.chatJid).toBe(scenario.jid);
          expect(message.payload.body).toBe(`Synthetic inbound trigger ${scenario.id}.`);
          result.admissionKind = message.admission.conversation.kind;
          if (requestedQuoteId && ["warm", "expired", "media"].includes(scenario.cache)) {
            const ageClock = scenario.cache === "expired" ? vi.spyOn(Date, "now").mockReturnValue(Date.now() - 10 * 60 * 1_000 - 1) : undefined;
            try {
              cacheInboundMessageMeta(accountId, scenario.jid, requestedQuoteId, {
                participant: peerJid,
                fromMe: false,
                ...(scenario.cache === "media" ? { media: { kind: "sticker" } } : { body: originalText }),
              });
            } finally {
              ageClock?.mockRestore();
            }
          }
          if (requestedQuoteId && scenario.cache === "missing") {
            expect(lookupInboundMessageMeta(accountId, scenario.jid, requestedQuoteId)).toBeUndefined();
          }
          const transport = createWhatsAppReplyTransportContext(message);
          const delivered = await deliverWebReply({
            replyResult: { text: expectedBody, ...(requestedQuoteId ? { replyToId: requestedQuoteId } : {}) },
            transport,
            maxMediaBytes: 1024 * 1024,
            textLimit: 4096,
            replyLogger: {
              info: (_fields, text) => { replyLogs.push({ level: "info", message: text }); },
              warn: (_fields, text) => { replyLogs.push({ level: "warn", message: text }); },
            },
          });
          result.providerAccepted = delivered.providerAccepted;
          result.resultIds = delivered.results.map((item) => item.messageId);
          result.receiptIds = delivered.receipt.parts.map((part) => part.platformMessageId);
          result.observations = observations.slice(before);
          expect(result.observations).toHaveLength(1);
          const observed = result.observations[0]!;
          expect(observed.jid).toBe(scenario.jid);
          expect(observed.encodedText).toBe(expectedBody);
          expect(delivered.providerAccepted).toBe(true);
          expect(result.resultIds).toEqual([observed.messageId]);
          expect(result.receiptIds).toEqual([observed.messageId]);
          if ("preview" in scenario) {
            expect(observed.quoteId).toBe(requestedQuoteId);
            expect(observed.participant).toBe(peerJid);
            expect(observed.quotedText).toBe(scenario.preview);
          } else {
            expect(observed.quoteId ?? null).toBeNull();
            expect(observed.quotedText ?? null).toBeNull();
          }
          result.status = "pass";
        } catch (error) {
          result.observations = observations.slice(before);
          result.error = error instanceof Error ? error.message : String(error);
        }
        results.push(result);
      },
    });
    for (const scenario of scenarios) {
      const inboundId = `SYNTHETIC-TRIGGER-${scenario.id}`;
      inboundCases.set(inboundId, scenario);
      ev.emit("messages.upsert", { type: "notify", messages: [{
        key: { id: inboundId, remoteJid: scenario.jid, fromMe: false, ...(scenario.jid === groupJid ? { participant: peerJid } : {}) },
        message: { conversation: `Synthetic inbound trigger ${scenario.id}.` },
        messageTimestamp: Math.floor(Date.now() / 1000),
      }] });
      await vi.waitFor(() => expect(results.some((result) => result.inboundId === inboundId)).toBe(true), { timeout: 10_000, interval: 10 });
    }
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await listener?.close();
      if (queue) {
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        queueDrained = true;
      }
      expect(ev.eventNames().flatMap((event) => ev.listeners(event))).toEqual([]);
      expect(socketClosed).toBe(true);
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      closeOpenClawStateDatabaseForTest();
      await state?.cleanup();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    vi.restoreAllMocks();
    const passed = results.length === scenarios.length && results.every((result) => result.status === "pass") && !setupError && !unexpectedMessages.length && !cleanupErrors.length;
    const verdict = {
      schema: "openclaw-pr-127959-automatic-quote-proof-v1",
      status: passed ? "pass" : "fail",
      binding,
      startedAt,
      finishedAt: new Date().toISOString(),
      expectedScenarios: scenarios.length,
      executedScenarios: results.length,
      passedScenarios: results.filter((result) => result.status === "pass").length,
      setupError: setupError ?? null,
      unexpectedMessages,
      cleanupErrors,
      socketClosed,
      queueDrained,
      replyLogs,
      cases: results,
      limitations: ["Synthetic messages.upsert and socket acceptance; real admission, queue, automatic reply transport and Baileys encoding.", "Preselected reply payload replaces model inference. No public WhatsApp connection, service acceptance, client rendering, routing/model selection or full Gateway inbound turn was exercised."],
    };
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
    expect(verdict).toMatchObject({ status: "pass", executedScenarios: 8, passedScenarios: 8, setupError: null, unexpectedMessages: [], cleanupErrors: [], socketClosed: true, queueDrained: true });
  }
}, 120_000);
