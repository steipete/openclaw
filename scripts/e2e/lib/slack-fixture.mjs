import crypto from "node:crypto";

const DEFAULT_TEAM_ID = "T0E2ETEST";
const DEFAULT_USER_ID = "U0E2ETESTHUMAN";
const DEFAULT_BOT_ID = "U0E2ETESTBOT";
const DEFAULT_CHANNEL_ID = "C0E2ETEST";

export function signSlackRequest({ signingSecret, timestamp, rawBody }) {
  if (!signingSecret) {
    throw new Error("signSlackRequest: signingSecret is required");
  }
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const baseString = `v0:${ts}:${rawBody}`;
  const hex = crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return { signature: `v0=${hex}`, timestamp: String(ts) };
}

export function buildAppMentionPayload({
  teamId = DEFAULT_TEAM_ID,
  userId = DEFAULT_USER_ID,
  botId = DEFAULT_BOT_ID,
  channelId = DEFAULT_CHANNEL_ID,
  text = "<@U0E2ETESTBOT> hello from e2e",
  ts,
  threadTs,
} = {}) {
  const eventTs = ts ?? `${Math.floor(Date.now() / 1000)}.000100`;
  return {
    token: "verification-token-unused",
    team_id: teamId,
    api_app_id: "A0E2ETEST",
    event: {
      type: "app_mention",
      user: userId,
      text,
      ts: eventTs,
      channel: channelId,
      event_ts: eventTs,
      team: teamId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
    type: "event_callback",
    event_id: `Ev${eventTs.replace(".", "")}`,
    event_time: Math.floor(Number(eventTs)),
    authorizations: [
      {
        enterprise_id: null,
        team_id: teamId,
        user_id: botId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  };
}

export function buildBotMessagePayload({
  teamId = DEFAULT_TEAM_ID,
  channelId = DEFAULT_CHANNEL_ID,
  botId = "B0E2ETEST",
  botUserId = DEFAULT_BOT_ID,
  text = "bot reply",
  ts,
  threadTs,
} = {}) {
  const eventTs = ts ?? `${Math.floor(Date.now() / 1000)}.000200`;
  return {
    token: "verification-token-unused",
    team_id: teamId,
    api_app_id: "A0E2ETEST",
    type: "event_callback",
    event_id: `EvBot${eventTs.replace(".", "")}`,
    event_time: Math.floor(Number(eventTs)),
    event: {
      type: "message",
      bot_id: botId,
      user: botUserId,
      text,
      channel: channelId,
      ts: eventTs,
      event_ts: eventTs,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
    authorizations: [
      {
        enterprise_id: null,
        team_id: teamId,
        user_id: botUserId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  };
}

export async function postSignedSlackEvent({
  url,
  signingSecret,
  payload,
  timestamp,
  fetchImpl = fetch,
}) {
  const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const { signature, timestamp: ts } = signSlackRequest({ signingSecret, timestamp, rawBody });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": ts,
    },
    body: rawBody,
  });
  return { response, rawBody, signature, timestamp: ts };
}
