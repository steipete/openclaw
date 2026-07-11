#!/usr/bin/env node

import process from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runBundle } from "./lib/bundle-runner.mjs";
import { startMockSlackServer } from "./lib/mock-slack-server.mjs";
import { startMockTelegramServer } from "./lib/mock-telegram-server.mjs";
import { buildAppMentionPayload, signSlackRequest } from "./lib/slack-fixture.mjs";

const WALL_CLOCK_MS = 60_000;
const SUSPEND_METHODS = [
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
];
const TELEGRAM_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const TELEGRAM_UPDATE_ID = 424242;
const TELEGRAM_FAILURE_UPDATE_ID = TELEGRAM_UPDATE_ID - 1;
const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "guest_message",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "purchased_paid_media",
  "poll",
  "poll_answer",
  "my_chat_member",
  "managed_bot",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
  "message_reaction",
];
const SQLITE_PROBE_BUSY_TIMEOUT_MS = 5_000;

async function readJsonWhenAvailable(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`cron reconciliation probe was not written within ${timeoutMs}ms`);
}

async function callAdminRpc(runner, method, params, authenticated = true) {
  const response = await fetch(`${runner.url}/api/v1/admin/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${runner.gatewayToken}` } : {}),
    },
    body: JSON.stringify({ id: `l2-${method}`, method, params }),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function waitForTelegramWebhookHealth(webhookUrl, timeoutMs = 10_000) {
  const healthUrl = new URL("/healthz", webhookUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.status === 200) {
        return response;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Telegram webhook was not healthy within ${timeoutMs}ms: ${lastError?.message ?? "unknown"}`,
  );
}

function telegramStateDatabasePath(homeDir) {
  return path.join(homeDir, ".openclaw", "state", "openclaw.sqlite");
}

async function waitForTelegramIngressTable(homeDir, timeoutMs = 10_000) {
  const databasePath = telegramStateDatabasePath(homeDir);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database
        .prepare(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'channel_ingress_events'",
        )
        .get();
      if (row?.found === 1) {
        return;
      }
      lastError = new Error("channel_ingress_events table is absent");
    } catch (error) {
      lastError = error;
    } finally {
      database?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Telegram durable ingress table was not available within ${timeoutMs}ms: ${lastError?.message ?? "unknown"}`,
  );
}

async function waitForTelegramIngressRow(homeDir, updateId, timeoutMs = 10_000) {
  const databasePath = telegramStateDatabasePath(homeDir);
  const queueName = JSON.stringify(["telegram", "default"]);
  const eventId = String(updateId).padStart(16, "0");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const rows = database
        .prepare(
          "SELECT event_id, status FROM channel_ingress_events WHERE queue_name = ? AND event_id = ?",
        )
        .all(queueName, eventId);
      if (rows.length === 1) {
        return rows[0];
      }
      lastError = new Error(`expected one durable ingress row, got ${rows.length}`);
    } catch (error) {
      lastError = error;
    } finally {
      database?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Telegram durable ingress row was not available within ${timeoutMs}ms: ${lastError?.message ?? "unknown"}`,
  );
}

function readTelegramIngressRows(homeDir) {
  const database = new DatabaseSync(telegramStateDatabasePath(homeDir), { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT event_id, status FROM channel_ingress_events WHERE queue_name = ? ORDER BY event_id",
      )
      .all(JSON.stringify(["telegram", "default"]));
  } finally {
    database.close();
  }
}

async function proveTelegramDurableAck(runner, mockTelegram) {
  if (!runner.telegramWebhookUrl || !runner.telegramWebhookSecret) {
    throw new Error("bundle runner did not configure the Telegram webhook probe");
  }
  const registration = await mockTelegram.waitForCall((call) => call.method === "setWebhook");
  const expectedRegistration = {
    url: runner.telegramWebhookUrl,
    secret_token: runner.telegramWebhookSecret,
    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
  };
  const registrationKeys = Object.keys(registration.body ?? {}).toSorted();
  const expectedRegistrationKeys = Object.keys(expectedRegistration).toSorted();
  if (
    JSON.stringify(registrationKeys) !== JSON.stringify(expectedRegistrationKeys) ||
    registration.body?.url !== expectedRegistration.url ||
    registration.body?.secret_token !== expectedRegistration.secret_token ||
    JSON.stringify(registration.body?.allowed_updates) !==
      JSON.stringify(expectedRegistration.allowed_updates)
  ) {
    throw new Error(
      `Telegram setWebhook registration mismatch: ${JSON.stringify(registration.body)}`,
    );
  }

  const health = await waitForTelegramWebhookHealth(runner.telegramWebhookUrl);
  if (health.headers.get(TELEGRAM_ACCEPTED_HEADER) !== null) {
    throw new Error("Telegram health route exposed the durable acceptance marker");
  }

  const notFound = await fetch(new URL("/not-telegram-webhook", runner.telegramWebhookUrl), {
    method: "POST",
  });
  if (notFound.status !== 404 || notFound.headers.get(TELEGRAM_ACCEPTED_HEADER) !== null) {
    throw new Error(`Telegram negative route returned an acceptance marker (${notFound.status})`);
  }

  const unauthorizedBody = JSON.stringify({ update_id: TELEGRAM_UPDATE_ID });
  const unauthorized = await fetch(runner.telegramWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: unauthorizedBody,
  });
  if (unauthorized.status !== 401 || unauthorized.headers.get(TELEGRAM_ACCEPTED_HEADER) !== null) {
    throw new Error(
      `Telegram unauthorized route returned an acceptance marker (${unauthorized.status})`,
    );
  }

  const postDurableUpdate = (updateId) =>
    fetch(runner.telegramWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": runner.telegramWebhookSecret,
      },
      body: JSON.stringify({ update_id: updateId }),
    });

  await waitForTelegramIngressTable(runner.homeDir);
  const databasePath = telegramStateDatabasePath(runner.homeDir);
  const faultDatabase = new DatabaseSync(databasePath);
  try {
    faultDatabase.exec(`PRAGMA busy_timeout = ${SQLITE_PROBE_BUSY_TIMEOUT_MS}`);
    faultDatabase.exec(`
      CREATE TRIGGER bundle_e2e_reject_telegram_ingress
      BEFORE INSERT ON channel_ingress_events
      WHEN NEW.queue_name = '["telegram","default"]'
        AND NEW.event_id = '${String(TELEGRAM_FAILURE_UPDATE_ID).padStart(16, "0")}'
      BEGIN
        SELECT RAISE(ABORT, 'bundle injected durable write failure');
      END;
    `);
    const failed = await postDurableUpdate(TELEGRAM_FAILURE_UPDATE_ID);
    if (failed.status !== 500 || failed.headers.get(TELEGRAM_ACCEPTED_HEADER) !== null) {
      throw new Error(
        `Telegram persistence failure expected 500 without an acceptance marker (${failed.status})`,
      );
    }
  } finally {
    try {
      faultDatabase.exec("DROP TRIGGER IF EXISTS bundle_e2e_reject_telegram_ingress");
    } finally {
      faultDatabase.close();
    }
  }

  const commitGateDatabase = new DatabaseSync(databasePath);
  let gateOpen = false;
  let responseSettled = false;
  let acceptedTask;
  try {
    commitGateDatabase.exec(`PRAGMA busy_timeout = ${SQLITE_PROBE_BUSY_TIMEOUT_MS}`);
    commitGateDatabase.exec("BEGIN IMMEDIATE");
    gateOpen = true;
    acceptedTask = postDurableUpdate(TELEGRAM_UPDATE_ID).then(
      (response) => {
        responseSettled = true;
        return { response };
      },
      (error) => {
        responseSettled = true;
        return { error };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (responseSettled) {
      throw new Error("Telegram durable response completed before the SQLite write lock released");
    }
    commitGateDatabase.exec("ROLLBACK");
    gateOpen = false;
  } finally {
    if (gateOpen) {
      commitGateDatabase.exec("ROLLBACK");
    }
    commitGateDatabase.close();
  }
  const acceptedResult = await acceptedTask;
  if (acceptedResult.error) {
    throw acceptedResult.error;
  }
  const accepted = acceptedResult.response;
  if (accepted.status !== 200 || accepted.headers.get(TELEGRAM_ACCEPTED_HEADER) !== "durable") {
    throw new Error(
      `Telegram initial durable update was not acknowledged after persistence (${accepted.status})`,
    );
  }

  const row = await waitForTelegramIngressRow(runner.homeDir, TELEGRAM_UPDATE_ID);
  const expectedEventId = String(TELEGRAM_UPDATE_ID).padStart(16, "0");
  if (row.event_id !== expectedEventId) {
    throw new Error(`Telegram durable ingress row has wrong event id: ${row.event_id}`);
  }

  const duplicate = await postDurableUpdate(TELEGRAM_UPDATE_ID);
  if (duplicate.status !== 200 || duplicate.headers.get(TELEGRAM_ACCEPTED_HEADER) !== "durable") {
    throw new Error(
      `Telegram duplicate durable update was not acknowledged after persistence (${duplicate.status})`,
    );
  }
  const rowsAfterDuplicate = readTelegramIngressRows(runner.homeDir);
  if (rowsAfterDuplicate.length !== 1 || rowsAfterDuplicate[0]?.event_id !== expectedEventId) {
    throw new Error(
      `Telegram duplicate did not preserve one durable ingress row: ${JSON.stringify(rowsAfterDuplicate)}`,
    );
  }
  return {
    updateId: TELEGRAM_UPDATE_ID,
    status: rowsAfterDuplicate[0].status,
    rows: rowsAfterDuplicate.length,
    commitGateBlockedResponse: true,
    persistenceFailureRejected: true,
  };
}

async function main() {
  const startedAt = performance.now();
  const wallClock = setTimeout(() => {
    process.stderr.write(`l2-bundle-boot: exceeded ${WALL_CLOCK_MS}ms wall clock\n`);
    process.exit(2);
  }, WALL_CLOCK_MS);
  wallClock.unref();

  let mockSlack;
  let mockTelegram;
  let runner;
  try {
    // Loopback APIs let the packaged channels complete startup without external
    // credentials while the probes still exercise their real HTTP surfaces.
    mockSlack = await startMockSlackServer();
    mockTelegram = await startMockTelegramServer();
    runner = await runBundle({
      slackApiUrl: mockSlack.url,
      telegramApiUrl: mockTelegram.url,
      telegramBotToken: mockTelegram.botToken,
      capabilityProbe: true,
    });
    // Debug aid: snapshot what the gateway thinks it has registered.
    if (process.env.OPENCLAW_E2E_DEBUG === "1") {
      for (const probePath of ["/healthz", "/ready", "/status", "/channels"]) {
        try {
          const r = await fetch(`${runner.url}${probePath}`);
          process.stderr.write(`[l2-debug] ${probePath} -> ${r.status}\n`);
        } catch (err) {
          process.stderr.write(`[l2-debug] ${probePath} -> err: ${err.message}\n`);
        }
      }
    }

    // Probe the slack webhook with an event_callback body and a deliberately
    // wrong signature. If the slack channel registered, the route exists and
    // signature verification rejects it. If the channel did not register, we
    // get 404. A 200 means signature verification is missing.
    const probeDeadline = Date.now() + 10_000;
    let probe;
    let lastErr;
    const badPayload = buildAppMentionPayload({ text: "<@U0E2ETESTBOT> l2 bad signature" });
    const badRawBody = JSON.stringify(badPayload);
    const { timestamp: badTimestamp } = signSlackRequest({
      signingSecret: runner.signingSecret,
      rawBody: badRawBody,
    });
    while (Date.now() < probeDeadline) {
      try {
        probe = await fetch(runner.url + "/slack/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": badTimestamp,
            "x-slack-signature": "v0=bad-signature",
          },
          body: badRawBody,
        });
        lastErr = undefined;
        if (probe.status !== 404) {
          break;
        }
      } catch (err) {
        lastErr = err;
      }
      if (runner.isDualLoadHit()) {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!probe) {
      throw new Error(
        `slack probe never got a response: ${lastErr?.message ?? "unknown"}\nstderr:\n${runner.getStderr()}\nstdout:\n${runner.getStdout()}`,
      );
    }

    const stderrText = runner.getStderr();
    const fatalNeedle = runner.isDualLoadHit();
    if (fatalNeedle) {
      throw new Error(`fatal stderr pattern: ${fatalNeedle}\n${stderrText}`);
    }

    const slackChannelRegistered = probe.status !== 404;
    const signatureVerified = probe.status === 401 || probe.status === 403;

    if (!slackChannelRegistered) {
      throw new Error(
        `slack channel did not register: POST /slack/events returned 404\nstderr:\n${stderrText}`,
      );
    }
    if (!signatureVerified) {
      throw new Error(
        `slack channel /slack/events failed to reject bad signature; got ${probe.status}\nstderr:\n${stderrText}`,
      );
    }

    const telegramDurableAck = await proveTelegramDurableAck(runner, mockTelegram);

    const unauthorized = await callAdminRpc(runner, "commands.list", undefined, false);
    if (unauthorized.response.status !== 401) {
      throw new Error(
        `admin RPC unauthenticated probe expected 401, got ${unauthorized.response.status}`,
      );
    }

    const commands = await callAdminRpc(runner, "commands.list");
    const commandMethods = commands.body?.payload?.methods;
    if (commands.response.status !== 200 || !Array.isArray(commandMethods)) {
      throw new Error(`admin RPC commands.list failed: ${JSON.stringify(commands.body)}`);
    }
    for (const method of SUSPEND_METHODS) {
      if (!commandMethods.includes(method)) {
        throw new Error(`admin RPC commands.list lacks ${method}`);
      }
    }

    const prepared = await callAdminRpc(runner, "gateway.suspend.prepare", {
      requestId: "l2-suspension",
    });
    if (prepared.response.status !== 200 || prepared.body?.payload?.status !== "ready") {
      throw new Error(`gateway suspension prepare failed: ${JSON.stringify(prepared.body)}`);
    }
    const suspensionId = prepared.body.payload.suspensionId;
    const status = await callAdminRpc(runner, "gateway.suspend.status", { suspensionId });
    if (status.response.status !== 200 || status.body?.payload?.status !== "ready") {
      throw new Error(`gateway suspension status failed: ${JSON.stringify(status.body)}`);
    }
    const resumed = await callAdminRpc(runner, "gateway.suspend.resume", { suspensionId });
    if (
      resumed.response.status !== 200 ||
      resumed.body?.payload?.status !== "running" ||
      resumed.body?.payload?.ok !== true
    ) {
      throw new Error(`gateway suspension resume failed: ${JSON.stringify(resumed.body)}`);
    }

    const cronProbe = await readJsonWhenAvailable(runner.cronProbePath);
    const seededIds = cronProbe.seededIds;
    const seededJobs = Array.isArray(seededIds)
      ? seededIds.map((id) => cronProbe.jobs?.find((job) => job.id === id))
      : [];
    if (
      cronProbe.event?.reason !== "startup" ||
      typeof cronProbe.event?.enabled !== "boolean" ||
      !Array.isArray(cronProbe.jobs) ||
      seededJobs.length !== 2 ||
      seededJobs.some((job) => !job) ||
      seededJobs[0].enabled !== true ||
      seededJobs[1].enabled !== false
    ) {
      throw new Error(`invalid cron_reconciled probe: ${JSON.stringify(cronProbe)}`);
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        layer: "l2",
        elapsedMs,
        port: runner.port,
        slackChannelRegistered,
        signatureVerified,
        adminRpcAuthenticated: true,
        suspensionRoundtrip: true,
        telegramDurableAck,
        cronReconciled: cronProbe.event,
        probeStatus: probe.status,
      })}\n`,
    );
  } finally {
    clearTimeout(wallClock);
    await runner?.stop().catch(() => {});
    await mockSlack?.stop().catch(() => {});
    await mockTelegram?.stop().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`l2-bundle-boot: ${err?.stack ?? err}\n`);
  if (err && typeof err === "object" && err.stderr) {
    process.stderr.write(`---bundle stderr (tail)---\n${String(err.stderr).slice(-4000)}\n`);
  }
  if (err && typeof err === "object" && err.stdout) {
    process.stderr.write(`---bundle stdout (tail)---\n${String(err.stdout).slice(-2000)}\n`);
  }
  process.exit(1);
});
