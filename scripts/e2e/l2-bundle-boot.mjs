#!/usr/bin/env node

import process from "node:process";
import { readFile } from "node:fs/promises";
import { runBundle } from "./lib/bundle-runner.mjs";
import { startMockSlackServer } from "./lib/mock-slack-server.mjs";
import { buildAppMentionPayload, signSlackRequest } from "./lib/slack-fixture.mjs";

const WALL_CLOCK_MS = 60_000;
const SUSPEND_METHODS = [
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
];

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

async function main() {
  const startedAt = performance.now();
  const wallClock = setTimeout(() => {
    process.stderr.write(`l2-bundle-boot: exceeded ${WALL_CLOCK_MS}ms wall clock\n`);
    process.exit(2);
  }, WALL_CLOCK_MS);
  wallClock.unref();

  // Boot a loopback mock Slack API so the bundled slack channel can complete
  // its auth.test handshake and register the /slack/events route. Without
  // this, slack channel registration fails on `invalid_auth` and L2 cannot
  // observe whether the route surface is wired up.
  const mockSlack = await startMockSlackServer();
  const runner = await runBundle({ slackApiUrl: mockSlack.url, capabilityProbe: true });
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
  try {
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
        cronReconciled: cronProbe.event,
        probeStatus: probe.status,
      })}\n`,
    );
  } finally {
    clearTimeout(wallClock);
    await runner.stop().catch(() => {});
    await mockSlack.stop().catch(() => {});
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
