// Discord message processing coverage split by cohesive behavior.
import {
  ChannelType,
  GatewayDispatchEvents,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  type APIMessage,
} from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
import { mapGatewayDispatchData } from "../internal/gateway-dispatch.js";
import {
  attachRestMock,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import type { DiscordMessageEvent } from "./listeners.js";
import { discordChannelInfoCacheState } from "./message-channel-info-state.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import { createDiscordPreflightArgs } from "./message-handler.preflight.test-helpers.js";
import {
  BASE_CHANNEL_ROUTE,
  createBaseContext,
  createDirectMessageContextOverrides,
  createDiscordDraftStream,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  logVerboseForTest,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  getLastDispatchCtx,
  getLastDispatchReplyOptions,
  getLastRouteUpdate,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  expectRecordFields,
  getReactionEmojis,
  getDeliveredFinalTexts,
  requireRecord,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage session routing", () => {
  it.each([
    {
      transcript: "/status",
      agentText: '[Audio transcript (machine-generated, untrusted)]: "/status"',
    },
    { transcript: "", agentText: '[Audio transcript (machine-generated, untrusted)]: ""' },
  ])(
    "frames preflight audio transcript '$transcript' without command authority",
    async ({ transcript, agentText }) => {
      const ctx = await createBaseContext({
        message: {
          id: "m-audio-preflight",
          channelId: "c1",
          content: "",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-audio-preflight",
              url: "https://cdn.discordapp.com/attachments/voice.ogg",
              content_type: "audio/ogg",
              filename: "voice.ogg",
            },
          ],
        },
        baseText: "",
        messageText: "",
        preflightAudioTranscript: transcript,
        preparedMedia: [
          {
            path: "/tmp/openclaw-discord-test/voice.ogg",
            contentType: "audio/ogg",
          },
        ],
        cfg: {
          messages: { groupChat: { visibleReplies: "message_tool" } },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
      });

      await runProcessDiscordMessage(ctx);

      expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
        BodyForAgent: agentText,
        RawBody: "",
        CommandBody: "",
        CommandTurn: {
          kind: "normal",
          source: "message",
          authorized: false,
          commandName: undefined,
          body: "",
        },
        Transcript: transcript,
        media: [expect.objectContaining({ contentType: "audio/ogg", transcribed: true })],
      });
      expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    },
  );

  it("keeps typed control commands as explicit text command turns", async () => {
    const ctx = await createBaseContext({
      baseText: "/status",
      messageText: "/status",
      hasControlCommand: true,
      commandAuthorized: true,
    });

    await runProcessDiscordMessage(ctx);

    expect(requireRecord(getLastDispatchCtx(), "dispatch context").CommandTurn).toEqual({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "status",
      body: "/status",
    });
  });

  it("uses prepared media instead of re-downloading after the run queue", async () => {
    // Regression for #96165: Discord CDN attachment URLs expire, so process
    // must not re-fetch attachments preflight already downloaded at receipt
    // time. A throwing fetchImpl here proves no re-fetch happens.
    const fetchImpl = vi.fn(async () => {
      throw new Error("attachment should not be re-fetched after preflight downloaded it");
    });
    const ctx = await createBaseContext({
      message: {
        id: "m-preflight-media",
        channelId: "c1",
        content: "look",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-preflight-media",
            url: "https://cdn.discordapp.com/attachments/1/photo.png?ex=expired",
            content_type: "image/png",
            filename: "photo.png",
          },
        ],
      },
      baseText: "look",
      messageText: "look",
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/photo.png",
          contentType: "image/png",
        },
      ],
      discordRestFetch: fetchImpl,
    });

    await runProcessDiscordMessage(ctx);

    expect(fetchImpl).not.toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      media: [
        expect.objectContaining({
          path: "/tmp/openclaw-discord-test/photo.png",
          contentType: "image/png",
        }),
      ],
    });
  });

  it("does not attach referenced reply media when reply context is hidden", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("hidden reply media should not be fetched");
    });
    const ctx = await createBaseContext({
      cfg: {
        channels: { discord: { contextVisibility: "allowlist" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      author: {
        id: "U1",
        username: "alice",
        discriminator: "0",
        globalName: "Alice",
      },
      channelConfig: {
        allowed: true,
        users: ["U1"],
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-reply-hidden-media",
        channelId: "c1",
        content: "<@bot> what is this?",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: {
          type: 0,
          message_id: "m-hidden",
          channel_id: "c1",
        },
        referencedMessage: {
          id: "m-hidden",
          channelId: "c1",
          content: "hidden image",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-hidden",
              url: "https://cdn.discordapp.com/attachments/hidden.png",
              content_type: "image/png",
              filename: "hidden.png",
            },
          ],
          author: {
            id: "U2",
            username: "mallory",
            discriminator: "0",
            globalName: "Mallory",
          },
        },
      },
      baseText: "<@bot> what is this?",
      messageText: "<@bot> what is this?",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.MediaPath).toBeUndefined();
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("keeps attachment-only referenced messages as typed reply context", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } }),
    );
    const ctx = await createBaseContext({
      cfg: {
        channels: { discord: { contextVisibility: "all" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-attachment-reply",
        channelId: "c1",
        content: "<@bot> what is this?",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: { type: 0, message_id: "m-attachment-only", channel_id: "c1" },
        referencedMessage: {
          id: "m-attachment-only",
          channelId: "c1",
          content: "",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-only",
              url: "https://cdn.discordapp.com/attachments/1/attachment-only.png",
              content_type: "image/png",
              filename: "attachment-only.png",
            },
          ],
          author: {
            id: "U2",
            username: "bob",
            discriminator: "0",
            globalName: "Bob",
          },
        },
      },
      baseText: "<@bot> what is this?",
      messageText: "<@bot> what is this?",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(dispatchCtx.ReplyToId).toBe("m-attachment-only");
    expect(dispatchCtx.ReplyToSender).toBe("bob");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.media).toEqual([
      expect.objectContaining({
        contentType: "image/png",
        messageId: "m-attachment-only",
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not inject the bot's previous message body when users reply to it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("self-reply media should not be fetched");
    });
    const ctx = await createBaseContext({
      botUserId: "bot-1",
      cfg: {
        channels: { discord: { contextVisibility: "all" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-self-reply",
        channelId: "c1",
        content: "<@bot> hit that again",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: {
          type: 0,
          message_id: "m-bot-previous",
          channel_id: "c1",
        },
        referencedMessage: {
          id: "m-bot-previous",
          channelId: "c1",
          content: "The same stale bot response keeps looping.",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-bot-previous",
              url: "https://cdn.discordapp.com/attachments/previous.png",
              content_type: "image/png",
              filename: "previous.png",
            },
          ],
          author: {
            id: "bot-1",
            username: "Spartacus",
            discriminator: "0",
            globalName: "Spartacus",
          },
        },
      },
      baseText: "<@bot> hit that again",
      messageText: "<@bot> hit that again",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-bot-previous");
    expect(dispatchCtx.ReplyToSender).toBe("Spartacus");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(JSON.stringify(dispatchCtx)).not.toContain("The same stale bot response keeps looping.");
  });

  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      ChatType: "direct",
      From: "discord:U1",
      To: "user:U1",
      OriginatingTo: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
    });
  });

  it("pins Discord text DM main-route updates to the single configured DM owner", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      cfg: {
        messages: { ackReaction: "👀" },
        session: {
          store: "/tmp/openclaw-discord-process-test-sessions.json",
          dmScope: "main",
        },
      },
      channelConfig: { users: ["user:111"] },
      baseSessionKey: "agent:main:main",
      author: {
        id: "222",
        username: "bob",
        discriminator: "0",
        globalName: "Bob",
      },
      sender: { id: "222", label: "bob" },
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastRouteUpdate(), "last route update"), {
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
    });
    expectRecordFields(
      requireRecord(
        requireRecord(getLastRouteUpdate(), "last route update").mainDmOwnerPin,
        "main DM owner pin",
      ),
      {
        ownerRecipient: "111",
        senderRecipient: "222",
      },
    );
  });

  it("stores group lastRoute with channel target", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:c1",
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:channel:c1",
      channel: "discord",
      to: "channel:c1",
      accountId: "default",
    });
  });

  it("marks explicit message-tool guild replies as message-tool-only and disables source streaming", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      typingKeepalive: false,
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });

  it("sends the configured ack while suppressing automatic status reactions for always-on guild replies", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          groupChat: { visibleReplies: "message_tool" },
          statusReactions: {
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });

  it("honors explicit status reactions for always-on guild replies", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          groupChat: { visibleReplies: "message_tool" },
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual(["👀"]);
  });
});

const NATIVE_FORWARD_BOT_ID = "900000000000000003";
const NATIVE_FORWARD_TEXT = `/status forwarded task content <@${NATIVE_FORWARD_BOT_ID}>`;
const NATIVE_FORWARD_AGENT_TEXT = `[Forwarded message]\n${NATIVE_FORWARD_TEXT}`;

function nativeDiscordMessage(channelId: string, content: string): APIMessage {
  return {
    id: `${channelId}1`,
    channel_id: channelId,
    content,
    author: {
      id: "900000000000000001",
      username: "alice",
      discriminator: "0",
      global_name: null,
      avatar: null,
      bot: false,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: "2026-09-03T12:00:00.000Z",
    edited_timestamp: null,
    type: MessageType.Default,
    tts: false,
    pinned: false,
    flags: 0,
  };
}

describe("processDiscordMessage native forward boundary", () => {
  it.each([
    {
      name: "DM forward",
      channelId: "910000000000000001",
      guild: false,
      forward: true,
      reply: false,
      requireMention: false,
    },
    {
      name: "guild forward",
      channelId: "910000000000000002",
      guild: true,
      forward: true,
      reply: false,
      requireMention: false,
    },
    {
      name: "ordinary text",
      channelId: "910000000000000003",
      guild: false,
      forward: false,
      reply: false,
      requireMention: false,
    },
    {
      name: "ordinary reply",
      channelId: "910000000000000004",
      guild: false,
      forward: false,
      reply: true,
      requireMention: false,
    },
    {
      name: "forwarded mention cannot admit guild turn",
      channelId: "910000000000000005",
      guild: true,
      forward: true,
      reply: false,
      requireMention: true,
    },
  ])("preserves native $name text and authority", async (scenario) => {
    const guildId = "920000000000000001";
    const raw: APIMessage & { guild_id?: string } = nativeDiscordMessage(
      scenario.channelId,
      scenario.forward ? "" : "please explain this",
    );
    if (scenario.guild) {
      raw.guild_id = guildId;
    }
    if (scenario.forward) {
      raw.flags = MessageFlags.HasSnapshot;
      raw.message_reference = {
        type: MessageReferenceType.Forward,
        message_id: "930000000000000001",
        channel_id: "940000000000000001",
        guild_id: "950000000000000001",
      };
      // Native snapshots omit the original author; their mentions are not sender intent.
      raw.message_snapshots = [
        {
          message: {
            type: MessageType.Default,
            content: NATIVE_FORWARD_TEXT,
            attachments: [],
            embeds: [],
            mentions: [
              { ...raw.author, id: NATIVE_FORWARD_BOT_ID, username: "openclaw", bot: true },
            ],
            mention_roles: [],
            timestamp: "2026-09-03T11:00:00.000Z",
            edited_timestamp: null,
            flags: 0,
          },
        },
      ];
    } else if (scenario.reply) {
      const quoted = nativeDiscordMessage(scenario.channelId, "quoted ordinary message");
      quoted.id = "930000000000000002";
      quoted.author = { ...quoted.author, id: "900000000000000002", username: "bob" };
      raw.type = MessageType.Reply;
      raw.message_reference = {
        type: MessageReferenceType.Default,
        message_id: quoted.id,
        channel_id: scenario.channelId,
      };
      raw.referenced_message = quoted;
    }
    const client = createInternalTestClient();
    const restGet = vi.fn(async (route: string) => {
      if (route === `/channels/${scenario.channelId}`) {
        return {
          id: scenario.channelId,
          type: scenario.guild ? ChannelType.GuildText : ChannelType.DM,
          name: "native-proof",
        };
      }
      if (route === `/channels/${scenario.channelId}/messages/${raw.id}`) {
        return raw;
      }
      throw new Error(`unexpected native proof REST route: ${route}`);
    });
    attachRestMock(client, { get: restGet });
    // This is the same native mapping used for MESSAGE_CREATE, before channel preflight.
    const event = mapGatewayDispatchData(
      client,
      GatewayDispatchEvents.MessageCreate,
      raw,
    ) as DiscordMessageEvent;
    const guilds = { [guildId]: { requireMention: scenario.requireMention } };
    const discordConfig = {
      dmPolicy: "open" as const,
      allowFrom: ["*"],
      guilds,
      streaming: { mode: "off" as const },
    };
    const cfg: OpenClawConfig = {
      channels: { discord: discordConfig },
      messages: {
        ackReaction: "",
        statusReactions: { enabled: false },
        groupChat: { visibleReplies: "automatic" },
      },
      session: {
        store: "/tmp/openclaw-discord-process-test-sessions.json",
        dmScope: "per-channel-peer",
      },
    };
    const runtimeError = vi.fn();
    const runtimeExit = vi.fn((code: number) => {
      throw new Error(`unexpected native proof runtime exit: ${code}`);
    });
    let deliveryJoined = false;
    let processReturned = false;
    let observation: Record<string, unknown> = {};
    dispatchInboundMessage.mockImplementationOnce(async (params) => {
      if (!params) {
        throw new Error("native proof dispatcher params were missing");
      }
      const { dispatcher } = params;
      await dispatcher.sendFinalReply({ text: "native boundary reply" });
      await dispatcher.waitForIdle();
      deliveryJoined = true;
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    try {
      expect(event.message).toBeInstanceOf(Message);
      expect(event.message.rawData).toBe(raw);
      const preflight = await preflightDiscordMessage({
        ...createDiscordPreflightArgs({
          cfg,
          discordConfig,
          data: event,
          client,
          botUserId: NATIVE_FORWARD_BOT_ID,
        }),
        guildEntries: guilds,
        runtime: { log: vi.fn(), error: runtimeError, exit: runtimeExit },
      });
      if (scenario.requireMention) {
        observation = {
          admitted: preflight !== null,
          dropLogged: logVerboseForTest.mock.calls.some(
            ([line]) =>
              line ===
              `discord: drop guild message (mention required, botId=${NATIVE_FORWARD_BOT_ID})`,
          ),
        };
        expect(preflight).toBeNull();
        expect(observation.dropLogged).toBe(true);
        expect(dispatchInboundMessage).not.toHaveBeenCalled();
        expect(deliverDiscordReply).not.toHaveBeenCalled();
      } else {
        if (!preflight) {
          throw new Error(`native ${scenario.name} unexpectedly rejected before context`);
        }
        expect(preflight.baseText).toBe(raw.content);
        expect(preflight.messageText).toBe(
          scenario.forward ? NATIVE_FORWARD_AGENT_TEXT : raw.content,
        );
        expect(preflight.hasControlCommand).toBe(false);
        expect(preflight.wasMentioned).toBe(false);
        expect(preflight.effectiveWasMentioned).toBe(false);
        await runProcessDiscordMessage(preflight);
        processReturned = true;
        const dispatched = requireRecord(getLastDispatchCtx(), "native dispatch context");
        observation = {
          admitted: true,
          baseText: preflight.baseText,
          messageText: preflight.messageText,
          agentText: dispatched.agentText,
          BodyForAgent: dispatched.BodyForAgent,
          RawBody: dispatched.RawBody,
          CommandBody: dispatched.CommandBody,
          CommandTurn: dispatched.CommandTurn,
          WasMentioned: dispatched.WasMentioned,
          ReplyToBody: dispatched.ReplyToBody,
        };
        expect(dispatchInboundMessage).toHaveBeenCalledOnce();
        expect(deliverDiscordReply).toHaveBeenCalledOnce();
        expect(getDeliveredFinalTexts()).toEqual(["native boundary reply"]);
        expect(deliveryJoined).toBe(true);
        expect(dispatched.RawBody).toBe(raw.content);
        expect(dispatched.CommandBody).toBe(raw.content);
        expect(dispatched.CommandTurn).toEqual({
          kind: "normal",
          source: "message",
          authorized: false,
          commandName: undefined,
          body: raw.content,
        });
        expect(dispatched.WasMentioned).toBe(false);
        expect(dispatched.ReplyToBody).toBe(scenario.reply ? "quoted ordinary message" : undefined);
      }
      expect(runtimeError).not.toHaveBeenCalled();
      expect(runtimeExit).not.toHaveBeenCalled();
      expect(restGet.mock.calls.map(([route]) => route)).toEqual([
        ...(scenario.forward ? [`/channels/${scenario.channelId}/messages/${raw.id}`] : []),
        `/channels/${scenario.channelId}`,
      ]);
      if (!scenario.requireMention) {
        const expectedAgentText = scenario.forward ? NATIVE_FORWARD_AGENT_TEXT : raw.content;
        expect(
          { agentText: observation.agentText, BodyForAgent: observation.BodyForAgent },
          "native forwarded content must reach the finalized agent context without becoming sender intent",
        ).toEqual({ agentText: expectedAgentText, BodyForAgent: expectedAgentText });
      }
    } finally {
      discordChannelInfoCacheState.entries.delete(scenario.channelId);
      console.log(
        `PROOF_137313_NATIVE:${JSON.stringify({
          scenario: scenario.name,
          rawContent: raw.content,
          snapshotContent: raw.message_snapshots?.[0]?.message.content,
          topLevelMentionCount: raw.mentions.length,
          observation,
          dispatchCount: dispatchInboundMessage.mock.calls.length,
          replyCount: deliverDiscordReply.mock.calls.length,
          deliveryJoined,
          processReturned,
          channelCacheCleared: !discordChannelInfoCacheState.entries.has(scenario.channelId),
          runtimeErrors: runtimeError.mock.calls,
          runtimeExits: runtimeExit.mock.calls,
          restRoutes: restGet.mock.calls.map(([route]) => route),
        })}`,
      );
    }
  });
});
