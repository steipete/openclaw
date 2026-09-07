// Inert task fixture. Intended placement: test/e2e/qa-lab/runtime/perf-115049-driver.ts.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { readCodexSessionContext } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  readSnapshotProviderRequests,
  runSnapshotTextTurn,
  SNAPSHOT_REPLY,
  SNAPSHOT_SESSION_KEY,
  withNativeSnapshotGateway,
} from "./perf-115049-native.js";

assert.equal(process.env.CI, "true");
const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const observed = config.mode === "observed";
const logFile = path.join(config.ownedRoot, "lcm.log");
const sessionId = randomUUID();
const now = Date.now();
const seeds: Array<AgentMessage & { timestamp: number }> = [];
for (let index = 0; index < 4; index += 1) {
  seeds.push(
    {
      role: "user",
      content: `SYNTHETIC-SNAPSHOT-USER-${index} ${"neutral detail ".repeat(12).trim()}`,
      timestamp: now - 20_000 + index * 2_000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `SYNTHETIC-SNAPSHOT-ASSISTANT-${index} ${"neutral detail ".repeat(12).trim()}`,
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: now - 19_000 + index * 2_000,
    },
  );
}
function textOf(message: AgentMessage): string {
  if (!("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) =>
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n")
    : "";
}
const seedProjection = seeds.map((message) => ({ role: message.role, text: textOf(message) }));
const seedFingerprint = createHash("sha256").update(JSON.stringify(seedProjection)).digest("hex");
let target:
  | (Parameters<typeof readCodexSessionContext>[0] & { env: NodeJS.ProcessEnv })
  | undefined;
async function lcmLog() {
  try {
    assert.ok(
      (await fs.stat(logFile)).size <= 2 * 1024 * 1024,
      "LCM diagnostic output exceeded the proof budget",
    );
    return await fs.readFile(logFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
async function waitForLcmTurn(offset: number, warmup: boolean) {
  const deadline = Date.now() + 60_000;
  while (true) {
    const current = (await lcmLog()).slice(offset);
    const lines = current.split("\n").filter((line) => line.includes(SNAPSHOT_SESSION_KEY));
    const bootstrap = lines.find((line) => line.includes("bootstrap: done"));
    const committed = lines.find(
      (line) =>
        line.includes("pending-summary-prep: selected phase=commitTurn") &&
        line.includes("rawTokensOutsideTail=0") &&
        line.includes("shouldPrepare=false"),
    );
    const assembled = lines.some(
      (line) =>
        line.includes("assemble: done") && line.includes("contextProjectionMode=thread_bootstrap"),
    );
    const imported = warmup
      ? lines.some(
          (line) =>
            line.includes("bootstrap: sqlite projection initial import") &&
            line.includes(`importedMessages=${seeds.length}`),
        )
      : bootstrap?.includes("importedMessages=0 reason=already bootstrapped");
    if (bootstrap && committed && assembled && imported) {
      return { synchronizedBootstrap: !warmup, committedNoLeafPreparation: true };
    }
    assert.ok(
      Date.now() < deadline,
      "expected positive LCM bootstrap/assembly/commitTurn facts did not arrive",
    );
    await wait(25);
  }
}
async function counters() {
  const counts = JSON.parse(await fs.readFile(config.countsFile, "utf8"));
  assert.equal(counts.commit, config.sourceCommit);
  for (const field of ["calls", "completed", "failed"]) {
    assert.ok(Number.isSafeInteger(counts[field]) && counts[field] >= 0 && counts[field] <= 100);
  }
  assert.equal(counts.overflow, false);
  return counts as { calls: number; completed: number; failed: number; overflow: boolean };
}
function transcript() {
  assert.ok(target);
  return readCodexSessionContext(target, (messages, header) => {
    assert.ok(header && typeof header === "object" && "id" in header && "version" in header);
    assert.equal(header.id, sessionId);
    assert.equal(header.version, CURRENT_SESSION_VERSION);
    return Array.from(messages, (message) => ({ role: message.role, text: textOf(message) }));
  });
}
// Compare only owned synthetic markers, allowing native thread retention to omit prior input.
const requestContext: Array<{
  turn: string;
  markers: Array<{ marker: string; occurrences: number }>;
}> = [];
const knownMarkers = [
  ...seedProjection.map((message) => message.text),
  "Snapshot warmup turn 0.",
  ...[0, 1, 2].map((index) => `Snapshot measured turn ${index}.`),
  SNAPSHOT_REPLY,
];
function recordRequest(input: unknown, turn: string) {
  const wire = JSON.stringify(input);
  requestContext.push({
    turn,
    markers: knownMarkers.map((marker) => ({ marker, occurrences: wire.split(marker).length - 1 })),
  });
}
const completedTurns: string[] = [];
const result = await withNativeSnapshotGateway(
  {
    repoRoot: config.repoRoot,
    sourceCommit: config.sourceCommit,
    lcmArchive: config.lcmArchive,
    ownedRoot: config.ownedRoot,
    ...(observed ? { observer: { path: config.observerPath, countsFile: config.countsFile } } : {}),
  },
  async (gateway, state) => {
    const storePath = resolveStorePath(undefined, { agentId: "qa", env: state.runtimeEnv });
    const relative = path.relative(state.stateDir, storePath);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    target = {
      agentId: "qa",
      sessionId,
      sessionKey: SNAPSHOT_SESSION_KEY,
      storePath,
      env: state.runtimeEnv,
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId, updatedAt: now, compactionCount: 0 },
    });
    for (const message of seeds) {
      const appended = await appendSessionTranscriptMessageByIdentity({
        ...target,
        message,
        now: message.timestamp,
        cwd: gateway.workspaceDir,
      });
      assert.ok(appended?.appended);
    }
    assert.deepEqual(transcript(), seedProjection);
  },
  async (gateway, model) => {
    const firstOffset = (await lcmLog()).length;
    const warmup = await runSnapshotTextTurn(gateway, "warmup");
    await waitForLcmTurn(firstOffset, true);
    completedTurns.push(warmup.message);
    const initialRequests = await readSnapshotProviderRequests(model);
    assert.equal(initialRequests.length, 1);
    recordRequest(initialRequests[0].body.input, "warmup");
    const firstInput = JSON.stringify(initialRequests[0].body.input);
    for (const seed of seedProjection) {
      assert.ok(firstInput.includes(seed.text), "first native request lost seeded context");
    }
    assert.deepEqual(transcript().slice(-2), [
      { role: "user", text: warmup.message },
      { role: "assistant", text: SNAPSHOT_REPLY },
    ]);
    const before = observed ? await counters() : undefined;
    const samples = [];
    let cursor = initialRequests[0].cursor;
    for (let index = 0; index < 3; index += 1) {
      const offset = (await lcmLog()).length;
      const turn = await runSnapshotTextTurn(gateway, "measured", index);
      await waitForLcmTurn(offset, false);
      completedTurns.push(turn.message);
      const requests = await readSnapshotProviderRequests(model, cursor);
      assert.equal(requests.length, 1, "ordinary text turn made additional provider requests");
      assert.ok(!requests[0].plannedToolName);
      assert.ok(JSON.stringify(requests[0].body.input).includes(turn.message));
      recordRequest(requests[0].body.input, `measured-${index}`);
      cursor = requests[0].cursor;
      assert.deepEqual(transcript().slice(-2), [
        { role: "user", text: turn.message },
        { role: "assistant", text: SNAPSHOT_REPLY },
      ]);
      if (!observed) {
        assert.ok(Number.isFinite(turn.elapsedMs) && turn.elapsedMs >= 0);
        assert.ok(turn.processTreeRssBytes !== null && turn.processTreeRssBytes > 0);
        samples.push({
          agentWaitMs: turn.elapsedMs,
          processTreeRssBytes: turn.processTreeRssBytes,
        });
      }
    }
    const finalTranscript = transcript();
    assert.deepEqual(finalTranscript.slice(0, seeds.length), seedProjection);
    assert.equal(finalTranscript.length, seeds.length + completedTurns.length * 2);
    for (const message of completedTurns) {
      assert.equal(
        finalTranscript.filter((entry) => entry.role === "user" && entry.text === message).length,
        1,
      );
    }
    return {
      seedFingerprint,
      requestContext,
      seedMessages: seeds.length,
      measuredTurns: 3,
      samples,
      before,
      finalTranscriptMessages: finalTranscript.length,
      transcriptHeaderVersion: CURRENT_SESSION_VERSION,
    };
  },
);
assert.ok(!result.logs.includes("[snapshot-read-observer] artifact write failed"));
assert.ok(!result.logs.includes("failed to read mirrored session history"));
const finalCounts = observed ? await counters() : undefined;
if (finalCounts) {
  assert.equal(
    finalCounts.calls,
    finalCounts.completed,
    "a full read was still pending after joined cleanup",
  );
  assert.equal(finalCounts.failed, 0);
  assert.ok(result.value.before);
  const fullReads = finalCounts.calls - result.value.before.calls;
  assert.equal(fullReads, result.value.measuredTurns * (config.variant === "baseline" ? 2 : 1));
}
await fs.writeFile(
  config.verdictFile,
  JSON.stringify(
    {
      complete: true,
      sourceCommit: config.sourceCommit,
      mode: config.mode,
      variant: config.variant,
      node: process.versions.node,
      lcmVersion: "1.0.0",
      lcmSource: "988dee85592b9066ffe1c859542e8e18c23f2345",
      codexVersion: "0.153.4",
      ...result.value,
      ...(finalCounts
        ? { finalCounts, measuredFullReads: finalCounts.calls - result.value.before!.calls }
        : {}),
      cleanupJoined: true,
      limits:
        "Read counters are a separate observed pass. Timing/RSS passes have no observer. No SQL timings, maintenance-return or all-transcript-read-elimination claim.",
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
