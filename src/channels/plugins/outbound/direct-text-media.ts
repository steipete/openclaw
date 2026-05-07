import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence,
  sendPayloadMediaSequenceAndFinalize,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkText } from "../../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import {
  createDeliveryAttemptId,
  hashForLog,
  logDeliveryEvent,
  summarizeErrorForLog,
  summarizePayloadForLog,
  validateProviderMessageIdResult,
} from "../../../infra/outbound/delivery-evidence.js";
import type { OutboundMediaAccess } from "../../../media/load-options.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.adapters.js";

type DirectSendOptions = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
};

type DirectSendResult = { messageId: string; [key: string]: unknown };

type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (
  to: string,
  text: string,
  opts: TOpts,
) => Promise<TResult>;
export {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence,
  sendPayloadMediaSequenceAndFinalize,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";

export function resolveScopedChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
}): number | undefined {
  return resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: params.resolveChannelLimitMb,
    accountId: params.accountId,
  });
}

export function createScopedChannelMediaMaxBytesResolver(channel: string) {
  return (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveScopedChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        (cfg.channels?.[channel]?.accounts?.[accountId] as { mediaMaxMb?: number } | undefined)
          ?.mediaMaxMb ?? cfg.channels?.[channel]?.mediaMaxMb,
    });
}

export function createDirectTextMediaOutbound<
  TOpts extends Record<string, unknown>,
  TResult extends DirectSendResult,
>(params: {
  channel: string;
  resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
  resolveMaxBytes: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => number | undefined;
  buildTextOptions: (params: DirectSendOptions) => TOpts;
  buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter {
  const sendDirect = async (sendParams: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    deps?: OutboundSendDeps;
    replyToId?: string | null;
    threadId?: string | number | null;
    mediaUrl?: string;
    mediaAccess?: OutboundMediaAccess;
    buildOptions: (params: DirectSendOptions) => TOpts;
  }) => {
    const send = params.resolveSender(sendParams.deps);
    const maxBytes = params.resolveMaxBytes({
      cfg: sendParams.cfg,
      accountId: sendParams.accountId,
    });
    const deliveryAttemptId = createDeliveryAttemptId(params.channel);
    const startedAt = Date.now();
    logDeliveryEvent("outbound.delivery.start", {
      deliveryAttemptId,
      channel: params.channel,
      via: "direct",
      accountId: sendParams.accountId,
      targetHash: hashForLog(sendParams.to),
      replyToIdHash: hashForLog(sendParams.replyToId),
      threadHash: hashForLog(sendParams.threadId),
      payload: summarizePayloadForLog({ text: sendParams.text, mediaUrl: sendParams.mediaUrl }),
      status: "provider_started",
    });
    try {
      const result = await send(
        sendParams.to,
        sendParams.text,
        sendParams.buildOptions({
          cfg: sendParams.cfg,
          mediaUrl: sendParams.mediaUrl,
          mediaAccess: sendParams.mediaAccess,
          mediaLocalRoots: sendParams.mediaAccess?.localRoots,
          mediaReadFile: sendParams.mediaAccess?.readFile,
          accountId: sendParams.accountId,
          replyToId: sendParams.replyToId,
          threadId: sendParams.threadId,
          maxBytes,
        }),
      );
      validateProviderMessageIdResult(result, { channel: params.channel });
      const providerChannelId = typeof result.channel === "string" ? result.channel : undefined;
      logDeliveryEvent("outbound.delivery.provider_result", {
        deliveryAttemptId,
        channel: params.channel,
        via: "direct",
        accountId: sendParams.accountId,
        targetHash: hashForLog(sendParams.to),
        replyToIdHash: hashForLog(sendParams.replyToId),
        threadHash: hashForLog(sendParams.threadId),
        providerMessageId: result.messageId,
        providerConversationId: providerChannelId,
        status: "provider_delivered",
        elapsedMs: Date.now() - startedAt,
      });
      return {
        ...result,
        ...(providerChannelId ? { providerChannelId } : {}),
        channel: params.channel,
      };
    } catch (error) {
      logDeliveryEvent("outbound.delivery.error", {
        deliveryAttemptId,
        channel: params.channel,
        via: "direct",
        accountId: sendParams.accountId,
        targetHash: hashForLog(sendParams.to),
        replyToIdHash: hashForLog(sendParams.replyToId),
        threadHash: hashForLog(sendParams.threadId),
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        ...summarizeErrorForLog(error),
      });
      throw error;
    }
  };

  const outbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sanitizeText: ({ text }) => sanitizeForPlainText(text),
    sendPayload: async (ctx) =>
      await sendTextMediaPayload({ channel: params.channel, ctx, adapter: outbound }),
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId }) => {
      return await sendDirect({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        buildOptions: params.buildTextOptions,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
    }) => {
      return await sendDirect({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess:
          mediaAccess ??
          (mediaLocalRoots || mediaReadFile
            ? {
                ...(mediaLocalRoots?.length ? { localRoots: mediaLocalRoots } : {}),
                ...(mediaReadFile ? { readFile: mediaReadFile } : {}),
              }
            : undefined),
        accountId,
        deps,
        replyToId,
        threadId,
        buildOptions: params.buildMediaOptions,
      });
    },
  };
  return outbound;
}
