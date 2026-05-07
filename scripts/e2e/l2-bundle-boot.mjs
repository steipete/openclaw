#!/usr/bin/env node

import process from "node:process";
import { runBundle } from "./lib/bundle-runner.mjs";
import { startMockSlackServer } from "./lib/mock-slack-server.mjs";
import { buildAppMentionPayload, signSlackRequest } from "./lib/slack-fixture.mjs";

const WALL_CLOCK_MS = 60_000;

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
  const runner = await runBundle({ slackApiUrl: mockSlack.url });
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

    const elapsedMs = Math.round(performance.now() - startedAt);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        layer: "l2",
        elapsedMs,
        port: runner.port,
        slackChannelRegistered,
        signatureVerified,
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
