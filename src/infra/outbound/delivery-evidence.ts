import { createHash, randomUUID } from "crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { extractErrorCode, formatErrorMessage, readErrorName } from "../errors.js";

const log = createSubsystemLogger("outbound/delivery");

export type DeliveryStatus =
  | "prepared"
  | "target_invalid"
  | "queued"
  | "gateway_accepted"
  | "provider_started"
  | "provider_delivered"
  | "provider_accepted"
  | "partial"
  | "failed"
  | "skipped"
  | "suppressed"
  | "unknown";

export type DeliveryVia = "direct" | "routed" | "gateway" | "plugin-action" | "fallback";

export type DeliveryPayloadMeta = {
  textLength: number;
  textHash?: string;
  mediaCount: number;
  hasMedia: boolean;
  hasStructuredPayload?: boolean;
  chunkIndex?: number;
  chunkCount?: number;
};

export type DeliveryEvidenceFields = {
  deliveryAttemptId?: string;
  runId?: string;
  sessionKeyHash?: string;
  channel?: string;
  provider?: string;
  via?: DeliveryVia;
  accountId?: string | null;
  targetHash?: string;
  targetKind?: string;
  threadHash?: string;
  replyToIdHash?: string;
  kind?: string;
  payload?: DeliveryPayloadMeta;
  status?: DeliveryStatus;
  providerMessageId?: string;
  providerConversationId?: string;
  providerStatus?: string;
  providerErrorCode?: string;
  providerHttpStatus?: number;
  elapsedMs?: number;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  [key: string]: unknown;
};

export function createDeliveryAttemptId(prefix = "delivery"): string {
  return prefix + "_" + randomUUID();
}

export function hashForLog(value: unknown): string | undefined {
  const text = stringifyHashInput(value);
  if (!text) {
    return undefined;
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function stringifyHashInput(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function summarizePayloadForLog(params: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: readonly string[] | null;
  hasStructuredPayload?: boolean;
  chunkIndex?: number;
  chunkCount?: number;
}): DeliveryPayloadMeta {
  const text = params.text ?? "";
  const mediaCount =
    (params.mediaUrls?.filter((url) => typeof url === "string" && url.length > 0).length ?? 0) +
    (params.mediaUrl ? 1 : 0);
  return {
    textLength: text.length,
    ...(text ? { textHash: hashForLog(text) } : {}),
    mediaCount,
    hasMedia: mediaCount > 0,
    ...(params.hasStructuredPayload !== undefined
      ? { hasStructuredPayload: params.hasStructuredPayload }
      : {}),
    ...(params.chunkIndex !== undefined ? { chunkIndex: params.chunkIndex } : {}),
    ...(params.chunkCount !== undefined ? { chunkCount: params.chunkCount } : {}),
  };
}

export function summarizeErrorForLog(
  error: unknown,
): Pick<
  DeliveryEvidenceFields,
  "errorName" | "errorMessage" | "errorStack" | "providerErrorCode" | "providerHttpStatus"
> {
  const status = readNumericField(error, "status") ?? readNumericField(error, "statusCode");
  return {
    errorName:
      readErrorName(error) || (error instanceof Error ? error.constructor.name : undefined),
    errorMessage: formatErrorMessage(error),
    errorStack: error instanceof Error ? error.stack : undefined,
    providerErrorCode: extractErrorCode(error),
    ...(status !== undefined ? { providerHttpStatus: status } : {}),
  };
}

function readNumericField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function logDeliveryEvent(event: string, fields: DeliveryEvidenceFields): void {
  const level = event.endsWith(".error") || fields.status === "failed" ? "warn" : "info";
  log[level](event, fields);
}

export function validateProviderMessageIdResult<T extends { messageId?: unknown }>(
  result: T,
  params: { channel: string; provider?: string },
): asserts result is T & { messageId: string } {
  if (!result || typeof result !== "object") {
    throw new Error((params.provider ?? params.channel) + " send returned no result");
  }
  const messageId = result.messageId;
  if (typeof messageId !== "string" || !messageId.trim()) {
    throw new Error((params.provider ?? params.channel) + " send returned no messageId");
  }
}
