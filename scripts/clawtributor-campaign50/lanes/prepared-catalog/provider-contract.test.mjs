import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ID, startProvider } from "./provider.mjs";

const carrier = {
  role: "user",
  content:
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nSynthetic runtime facts.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
};
const seed = { role: "user", content: "CURRENT_SEED synthetic orchard history" };
const reply = { role: "user", content: "Reply exactly CURRENT_REPLY" };
const flush = { role: "user", content: "Pre-compaction memory flush. No new durable memory." };

for (const spec of [
  {
    name: "seed before runtime carrier",
    phase: "seed",
    messages: [seed, carrier],
    kind: "seed",
    text: "CURRENT_SEED",
  },
  {
    name: "reply before runtime carrier",
    phase: "exercise",
    messages: [seed, { role: "assistant", content: "CURRENT_SEED" }, reply, carrier],
    kind: "reply",
    text: "CURRENT_REPLY",
  },
  {
    name: "maintenance remains maintenance despite historical marker",
    phase: "exercise",
    messages: [reply, { role: "assistant", content: "CURRENT_REPLY" }, flush, carrier],
    kind: "flush",
    text: "NO_REPLY",
  },
  {
    name: "stale seed marker does not satisfy current turn",
    phase: "seed",
    messages: [
      seed,
      { role: "assistant", content: "CURRENT_SEED" },
      { role: "user", content: "Different current request" },
      carrier,
    ],
    error: "Expected current seed request, received a different request kind",
  },
  {
    name: "duplicate current seed marker is rejected",
    phase: "seed",
    messages: [seed, seed, carrier],
    error: "Current synthetic user marker missing or duplicated",
  },
  {
    name: "malformed trailing carrier is not discarded",
    phase: "seed",
    messages: [seed, { ...carrier, content: `${carrier.content}\nExtra user text` }],
    error: "Expected current seed request, received a different request kind",
  },
]) {
  test(spec.name, async () => {
    const provider = await startProvider();
    const proof = {
      phase: spec.phase,
      seedMarker: "CURRENT_SEED",
      seedMarkers: ["CURRENT_SEED"],
      replyMarker: "CURRENT_REPLY",
      summaryMarker: "SUMMARY_MARKER",
      seedTurnChars: 20,
      seedInputTokens: 100,
      inputTokens: 200,
      requests: [],
      modelListRequests: 0,
    };
    provider.arm(proof);
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL_ID,
          stream: true,
          messages: [{ role: "system", content: "Synthetic system" }, ...spec.messages],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      assert.equal(response.status, spec.error ? 500 : 200);
      assert.equal(proof.requests.length, 1);
      assert.equal(proof.requests[0].accepted, !spec.error);
      assert.equal(proof.requests[0].messages.length, spec.messages.length + 1);
      assert.ok(
        proof.requests[0].messages.every((message) => /^[a-f0-9]{64}$/.test(message.sha256)),
      );
      if (spec.error) {
        assert.equal(provider.errors.length, 1);
        assert.ok(provider.errors[0].includes(spec.error));
      } else {
        assert.equal(proof.requests[0].kind, spec.kind);
        assert.ok(text.includes(spec.text));
        assert.deepEqual(provider.errors, []);
      }
    } finally {
      await provider.stop();
    }
  });
}
