import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { parseSlackTarget } from "./targets.js";

type SlackThreadingToolContext = {
  currentChannelId?: string;
  currentUserId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

function normalizeSlackId(value?: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function isSlackDmChannelId(value?: string): boolean {
  return /^D[A-Z0-9]+$/i.test(value ?? "");
}

function isBareSlackUserId(raw: string): boolean {
  return /^U[A-Z0-9]+$/i.test(raw.trim());
}

export function slackTargetMatchesCurrentThread(params: {
  to: string;
  toolContext?: Pick<SlackThreadingToolContext, "currentChannelId" | "currentUserId">;
}): boolean {
  const context = params.toolContext;
  if (!context?.currentChannelId) {
    return false;
  }

  const parsedTarget = parseSlackTarget(params.to, { defaultKind: "channel" });
  if (!parsedTarget) {
    return false;
  }

  const currentChannelId = normalizeSlackId(context.currentChannelId);
  const targetId = normalizeSlackId(parsedTarget.id);

  if (parsedTarget.kind === "channel" && targetId === currentChannelId) {
    return true;
  }

  if (!isSlackDmChannelId(context.currentChannelId)) {
    return false;
  }

  const currentUserId = normalizeSlackId(context.currentUserId);
  if (!currentUserId) {
    return false;
  }

  if (parsedTarget.kind === "user" && targetId === currentUserId) {
    return true;
  }

  return isBareSlackUserId(params.to) && targetId === currentUserId;
}

export function resolveSlackAutoThreadId(params: {
  to: string;
  toolContext?: SlackThreadingToolContext;
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  if (context.replyToMode !== "all" && !isSingleUseReplyToMode(context.replyToMode ?? "off")) {
    return undefined;
  }
  if (!slackTargetMatchesCurrentThread({ to: params.to, toolContext: context })) {
    return undefined;
  }
  if (isSingleUseReplyToMode(context.replyToMode ?? "off") && context.hasRepliedRef?.value) {
    return undefined;
  }
  return context.currentThreadTs;
}
