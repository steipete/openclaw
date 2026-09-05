import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const load = (file: string) => import(pathToFileURL(path.join(repo, file)).href);
const stateDir = await mkdtemp(path.join(os.tmpdir(), "buzz-thread-proof-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const [
  { createBuzzRelayFixture },
  { buzzPlugin },
  { setBuzzRuntime },
  { runMessageAction },
  { setActivePluginRegistry },
  { createTestRegistry },
] = await Promise.all([
  load("extensions/buzz/src/buzz-relay.test-harness.ts"),
  load("extensions/buzz/src/channel.ts"),
  load("extensions/buzz/src/runtime.ts"),
  load("src/infra/outbound/message-action-runner.ts"),
  load("src/plugins/runtime.ts"),
  load("src/test-utils/channel-plugins.ts"),
]);
const fixture = await createBuzzRelayFixture();
const target = `buzz:${fixture.roomId}`;
const rootId = "a".repeat(64);
const childId = "b".repeat(64);
const cfg = {
  channels: {
    buzz: {
      enabled: true,
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      groups: { [fixture.roomId]: { enabled: true, requireMention: false } },
    },
  },
};
setBuzzRuntime({
  channel: {
    text: {
      resolveMarkdownTableMode: () => "preserve",
      convertMarkdownTables: (text: string) => text,
    },
  },
});
setActivePluginRegistry(
  createTestRegistry([{ pluginId: "buzz", plugin: buzzPlugin, source: "transport-proof" }]),
);
const cases = [
  {
    label: "implicit",
    mode: "all",
    extra: { threadId: rootId },
    expected: [["e", rootId, "", "reply"]],
  },
  {
    label: "explicit-child",
    mode: "all",
    extra: { threadId: rootId, replyTo: childId },
    expected: [
      ["e", rootId, "", "root"],
      ["e", childId, "", "reply"],
    ],
  },
  {
    label: "already-root",
    mode: "all",
    extra: { threadId: rootId, replyTo: rootId },
    expected: [["e", rootId, "", "reply"]],
  },
  { label: "off", mode: "off", extra: {}, expected: [] },
  { label: "top-level", mode: "all", extra: { topLevel: true }, expected: [] },
];
const verdicts: unknown[] = [];
try {
  for (const scenario of cases) {
    const result = await runMessageAction({
      cfg,
      action: "send",
      actionOrigin: "message-tool",
      params: { channel: "buzz", target, message: scenario.label, ...scenario.extra },
      toolContext: {
        currentChannelProvider: "buzz",
        currentChannelId: target,
        currentMessagingTarget: target,
        currentMessageId: childId,
        replyToMode: scenario.mode,
        hasRepliedRef: { value: false },
      },
    });
    const sent = fixture.received.find(
      (event: { content: string; kind: number; pubkey: string }) =>
        event.kind === 9 &&
        event.pubkey === fixture.botPublicKey &&
        event.content === scenario.label,
    );
    assert.ok(sent, `${scenario.label}: no signed event reached relay`);
    const tags = sent.tags.filter((tag: string[]) => tag[0] === "e");
    verdicts.push({
      scenario: scenario.label,
      observed: tags,
      expected: scenario.expected,
      resultKind: result.kind,
    });
  }
  console.log(
    JSON.stringify({
      entrypoint: "runMessageAction -> Buzz adapter -> one-shot authenticated WebSocket relay",
      verdicts,
    }),
  );
  for (const [index, scenario] of cases.entries()) {
    if (
      JSON.stringify((verdicts[index] as { observed: unknown }).observed) !==
      JSON.stringify(scenario.expected)
    ) {
      throw new Error(`BUZZ_THREAD_REGRESSION:${scenario.label}`);
    }
  }
  console.log("BUZZ_TRANSPORT_PROOF_GREEN");
} finally {
  setActivePluginRegistry(createTestRegistry([]));
  await fixture.close();
  await rm(stateDir, { recursive: true, force: true });
}
