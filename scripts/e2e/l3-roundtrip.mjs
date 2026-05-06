#!/usr/bin/env node

/**
 * L3 — Slack inbound roundtrip e2e.
 *
 * Boots the bundle with OPENCLAW_SLACK_API_URL_OVERRIDE pointing at a mock
 * Slack API, posts a signed `app_mention` Events API payload to the gateway's
 * /slack/events route, and verifies:
 *
 *   - Slack signature verification accepts the signed body (HTTP 200).
 *   - The bundle's bolt receiver dispatches the event into the agent pipeline.
 *   - Any outbound Slack API traffic (auth.test on boot, plus anything the
 *     bundle emits in response to the event) is captured at the mock.
 *
 * What L3 does NOT prove: that an LLM-backed agent reply round-trips back to
 * `chat.postMessage`. That requires a configured model provider with valid
 * credentials and is out of scope for this layer; the harness does record
 * whether `chat.postMessage` was called so future provider wiring lights up
 * automatically.
 */

import process from "node:process";
import { runBundle } from "./lib/bundle-runner.mjs";
import { startMockSlackServer } from "./lib/mock-slack-server.mjs";
import { buildAppMentionPayload, postSignedSlackEvent } from "./lib/slack-fixture.mjs";

const WALL_CLOCK_MS = 90_000;
const OUTBOUND_GRACE_MS = 5_000;

async function main() {
  const startedAt = performance.now();
  const wallClock = setTimeout(() => {
    process.stderr.write(`l3-roundtrip: exceeded ${WALL_CLOCK_MS}ms wall clock\n`);
    process.exit(2);
  }, WALL_CLOCK_MS);
  wallClock.unref();

  const mockSlack = await startMockSlackServer();
  const runner = await runBundle({ slackApiUrl: mockSlack.url });

  try {
    // Wait briefly for the slack channel to register its /slack/events route
    // (registration is gated on auth.test against the mock; the mock answers
    // synchronously but the bolt receiver still needs a tick to mount).
    const routeDeadline = Date.now() + 10_000;
    while (Date.now() < routeDeadline) {
      const probe = await fetch(`${runner.url}/slack/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (probe.status !== 404) {
        break;
      }
      if (runner.isDualLoadHit()) {
        throw new Error(`fatal stderr pattern: ${runner.isDualLoadHit()}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Some Slack startup paths register the route without a boot-time auth.test.
    // Treat auth.test as useful evidence when present; the signed inbound event
    // below is the gate for this release-bundle layer.
    let bootAuth = null;
    try {
      bootAuth = await mockSlack.waitForCall((c) => c.method === "auth.test", {
        timeoutMs: 1_000,
      });
    } catch {
      bootAuth = null;
    }

    const payload = buildAppMentionPayload({
      teamId: "T0E2ETEST",
      botId: "U0E2ETESTBOT",
      channelId: "C0E2ETEST",
      text: "<@U0E2ETESTBOT> ping from l3",
    });
    const eventStartMs = Date.now();
    const inboundStart = performance.now();
    const { response: inboundResponse } = await postSignedSlackEvent({
      url: `${runner.url}/slack/events`,
      signingSecret: runner.signingSecret,
      payload,
    });
    const inboundLatencyMs = Math.round(performance.now() - inboundStart);

    if (runner.isDualLoadHit()) {
      throw new Error(
        `fatal stderr pattern after inbound: ${runner.isDualLoadHit()}\nstderr:\n${runner.getStderr()}`,
      );
    }

    if (inboundResponse.status !== 200) {
      const body = await inboundResponse.text().catch(() => "<no body>");
      throw new Error(
        `inbound /slack/events expected 200, got ${inboundResponse.status}\nbody: ${body}\nstderr:\n${runner.getStderr()}`,
      );
    }

    // Give the bundle a short window to emit side-effect calls caused by the
    // signed event. This is the deterministic no-credentials behavior gate for
    // now; provider-backed chat.postMessage can be layered on later.
    await new Promise((r) => setTimeout(r, OUTBOUND_GRACE_MS));

    const callsAfterEvent = mockSlack.calls.filter((c) => c.timeMs >= eventStartMs);
    const callMethods = callsAfterEvent.map((c) => c.method);
    const postedMessage = callsAfterEvent.find((c) => c.method === "chat.postMessage");
    const eventInducedMethod = callMethods.find((method) => method !== "auth.test");
    if (!eventInducedMethod) {
      throw new Error(
        `signed Slack event produced no event-induced Slack API calls; methods=${callMethods.join(", ") || "<none>"}\nstderr:\n${runner.getStderr()}`,
      );
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        layer: "l3",
        elapsedMs,
        port: runner.port,
        inboundLatencyMs,
        inboundStatus: inboundResponse.status,
        bootAuthMethod: bootAuth?.method ?? null,
        outboundCallCount: callsAfterEvent.length,
        outboundMethods: callMethods,
        eventInducedMethod,
        chatPostMessage: postedMessage
          ? {
              channel: postedMessage.body?.channel,
              textLen:
                typeof postedMessage.body?.text === "string"
                  ? postedMessage.body.text.length
                  : null,
            }
          : null,
      })}\n`,
    );
  } finally {
    clearTimeout(wallClock);
    await runner.stop().catch(() => {});
    await mockSlack.stop().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`l3-roundtrip: ${err?.stack ?? err}\n`);
  if (err && typeof err === "object" && err.stderr) {
    process.stderr.write(`---bundle stderr (tail)---\n${String(err.stderr).slice(-4000)}\n`);
  }
  process.exit(1);
});
