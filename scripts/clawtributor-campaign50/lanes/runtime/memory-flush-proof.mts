import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createCase,
  MODEL_ID,
  MODEL_REF,
  startProvider,
  type ProofCase,
} from "./memory-flush-provider.mts";

const { values } = parseArgs({
  options: {
    "repo-root": { type: "string" },
    "artifact-base": { type: "string" },
    "isolated-child": { type: "boolean" },
  },
});
const repoRoot = path.resolve(values["repo-root"] ?? process.cwd());
const artifactBase = path.resolve(
  repoRoot,
  values["artifact-base"] ?? ".artifacts/qa-e2e/memory-flush-fresh",
);
const fromRepo = (relative: string) => pathToFileURL(path.join(repoRoot, relative)).href;
const TIMEOUT = 60_000;
async function checkpoint(promise: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Proof setup/checkpoint timeout: ${label}`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runChild() {
  const tmpRoot = await fs.realpath(process.env.TMPDIR!);
  for (const name of [
    "HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_OAUTH_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ]) {
    const value = process.env[name];
    assert.ok(
      value && path.isAbsolute(value) && value.startsWith(`${tmpRoot}${path.sep}`),
      `${name} escaped owned environment`,
    );
  }
  assert.equal(process.env.OPENCLAW_HOME, process.env.HOME);
  assert.equal(process.env.CODEX_HOME, undefined);
  const artifactRelative = path.relative(repoRoot, artifactBase);
  assert.ok(
    artifactRelative && !artifactRelative.startsWith("..") && !path.isAbsolute(artifactRelative),
  );
  await fs.access(path.join(repoRoot, "dist/index.js"));
  await fs.access(path.join(repoRoot, "dist/plugin-sdk/qa-lab.js"));
  await fs.mkdir(artifactBase, { recursive: true });
  const [qa, sessions, store, transcript, hostStore, stateHelpers] = await Promise.all([
    import(fromRepo("extensions/qa-lab/api.ts")),
    import(fromRepo("src/plugin-sdk/agent-sessions.ts")),
    import(fromRepo("src/plugin-sdk/session-store-runtime.ts")),
    import(fromRepo("src/plugin-sdk/session-transcript-runtime.ts")),
    import(fromRepo("src/config/sessions/session-accessor.ts")),
    import(fromRepo("test/e2e/qa-lab/runtime/gateway-compaction-state.fixture.ts")),
  ]);
  const state = qa.createQaBusState();
  const transport = qa.createQaChannelTransport(state);
  const bus = await qa.startQaBusServer({ state });
  const provider = await startProvider();
  const owner = qa.createQaGatewayChild();
  let gateway: Awaited<ReturnType<typeof owner.start>> | undefined;
  let active: ProofCase | undefined;
  const results: Array<Record<string, unknown>> = [];
  let baselineRed = false;
  let shutdownConfirmed = false;
  try {
    gateway = await owner.start({
      repoRoot,
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(repoRoot, "dist/index.js")],
        tempParentDir: tmpRoot,
      },
      transport,
      transportBaseUrl: bus.baseUrl,
      providerBaseUrl: provider.baseUrl,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      forcedRuntime: "openclaw",
      controlUiEnabled: false,
      thinkingDefault: "off",
      mutateConfig: (config: OpenClawConfig) => {
        const selectedProvider = config.models?.providers?.["mock-openai"];
        assert.ok(selectedProvider, "QA config omitted the synthetic provider");
        return {
          ...config,
          logging: { ...config.logging, level: "debug", consoleLevel: "debug" },
          cron: { ...config.cron, enabled: false },
          memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              contextTokens: 100_000,
              heartbeat: { every: "0m" },
              compaction: {
                mode: "safeguard",
                reserveTokens: 20_000,
                keepRecentTokens: 2_000,
                memoryFlush: { enabled: true, forceFlushTranscriptBytes: "1gb" },
              },
            },
          },
          models: {
            ...config.models,
            providers: {
              ...config.models?.providers,
              "mock-openai": {
                ...selectedProvider,
                models: selectedProvider.models.map((model) =>
                  model.id === MODEL_ID ? { ...model, contextWindow: 100_000 } : model,
                ),
              },
            },
          },
        };
      },
    });
    await transport.waitReady({ gateway, timeoutMs: TIMEOUT });
    assert.equal(gateway.cfg.plugins?.slots?.memory, "memory-core");
    assert.equal(gateway.cfg.agents?.defaults?.compaction?.mode, "safeguard");
    const cases = [
      {
        name: "stale-anchor-tail",
        tail: true,
        totalTokens: 40_000,
        fresh: false,
        version: 1,
        expected: "growth",
      },
      {
        name: "no-tail",
        tail: false,
        totalTokens: undefined,
        fresh: false,
        version: undefined,
        expected: 40_000,
      },
      {
        name: "stale-high",
        tail: false,
        totalTokens: 200_000,
        fresh: false,
        version: 1,
        expected: 40_000,
      },
      {
        name: "old-version",
        tail: false,
        totalTokens: 200_000,
        fresh: true,
        version: 0,
        expected: 40_000,
      },
      { name: "fresh-zero", tail: false, totalTokens: 0, fresh: true, version: 1, expected: 0 },
      {
        name: "fresh-low",
        tail: false,
        totalTokens: 1_000,
        fresh: true,
        version: 1,
        expected: 1_000,
      },
    ];
    for (const item of cases) {
      const proof = createCase(item.name);
      active = proof;
      provider.arm(proof);
      const target = {
        agentId: "qa",
        sessionId: proof.sessionId,
        sessionKey: proof.sessionKey,
        env: gateway.runtimeEnv,
        storePath: store.resolveStorePath(undefined, { agentId: "qa", env: gateway.runtimeEnv }),
      };
      const dbPath = hostStore.resolveSessionTranscriptDatabasePath(target);
      assert.ok(dbPath.startsWith(`${path.join(gateway.tempRoot, "state")}${path.sep}`));
      const now = Date.now();
      await store.upsertSessionEntry({
        ...target,
        entry: {
          sessionId: proof.sessionId,
          updatedAt: now,
          totalTokens: item.totalTokens,
          totalTokensFresh: item.fresh,
          totalTokensVersion: item.version,
          compactionCount: 0,
          memoryFlush: { kind: "succeeded", compactionCount: 0 },
        },
      });
      const messages: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 4; i++) {
        messages.push(
          { role: "user", content: `Remember historical marker amber-orchid ${"h".repeat(4000)}` },
          {
            role: "assistant",
            content: [{ type: "text", text: "Historical request completed." }],
            api: "openai-responses",
            provider: "mock-openai",
            model: MODEL_ID,
            stopReason: "stop",
          },
        );
      }
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Last measured answer." }],
        api: "openai-responses",
        provider: "mock-openai",
        model: MODEL_ID,
        stopReason: "stop",
        usage: {
          input: 40_000,
          output: 2_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 42_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      if (item.tail) {
        for (let i = 0; i < 10; i++)
          messages.push(
            { role: "user", content: "x".repeat(45_000) },
            {
              role: "assistant",
              content: [{ type: "text", text: "Unmetered historical answer." }],
              api: "openai-responses",
              provider: "mock-openai",
              model: MODEL_ID,
              stopReason: "stop",
            },
          );
      }
      for (const [index, message] of messages.entries()) {
        const result = await transcript.appendSessionTranscriptMessageByIdentity({
          ...target,
          message: { ...message, timestamp: now - messages.length + index },
          now: now - messages.length + index,
        });
        assert.ok(result?.appended, "Fixture transcript append failed");
      }
      const readEntry = (adoptCompaction = false) => {
        const entry = hostStore.loadSessionEntry({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
          env: target.env,
          readConsistency: "latest",
        });
        assert.ok(entry?.sessionId, "Canonical session row disappeared");
        if (adoptCompaction) {
          target.sessionId = entry.sessionId;
          proof.sessionId = entry.sessionId;
        } else {
          assert.equal(
            entry.sessionId,
            proof.sessionId,
            "Session identity changed before compaction",
          );
        }
        return entry;
      };
      // Finish historical-state seeding before admitting any Gateway turn. Appends may
      // invalidate freshness; each case independently supplies its recorded snapshot.
      await store.upsertSessionEntry({
        ...target,
        entry: {
          ...readEntry(),
          totalTokens: item.totalTokens,
          totalTokensFresh: item.fresh,
          totalTokensVersion: item.version,
        },
      });
      const seeded = readEntry();
      assert.equal(seeded.totalTokens, item.totalTokens);
      assert.equal(seeded.totalTokensFresh, item.fresh);
      assert.equal(seeded.totalTokensVersion, item.version);
      const compactIds = () =>
        sessions.SessionManager.open(target, gateway!.workspaceDir)
          .getEntries()
          .filter((event: { type: string }) => event.type === "compaction")
          .map((event: { id: string }) => event.id);
      assert.equal(compactIds().length, 0);
      const send = async (marker: string) => {
        const result = await gateway!.call("chat.send", {
          sessionKey: proof.sessionKey,
          message: `Reply with only this exact marker: ${marker}`,
          idempotencyKey: randomUUID(),
          deliver: true,
          originatingChannel: "qa-channel",
          originatingTo: "dm:qa-operator",
        });
        assert.equal(typeof result.runId, "string");
        return result.runId as string;
      };
      const terminal = async (runId: string) => {
        const result = await gateway!.call(
          "agent.wait",
          { runId, timeoutMs: TIMEOUT },
          { timeoutMs: TIMEOUT + 5_000 },
        );
        assert.equal(result.status, "ok", `Real run failed: ${JSON.stringify(result)}`);
      };
      const runId = await send(proof.finalMarker);
      await checkpoint(proof.firstRequest.promise, `${item.name} first real provider request`);
      const held = readEntry();
      assert.equal(held.totalTokensFresh, true, "Memory-flush freshness was not persisted");
      assert.equal(held.totalTokensVersion, 1, "Memory-flush version was not canonical");
      const summaryFirst = proof.requests[0]?.kind === "summary";
      if (item.expected === "growth") {
        if (held.totalTokens === 40_000 && !summaryFirst) baselineRed = true;
        else {
          assert.ok(held.totalTokens > 80_000, "Trailing transcript growth was omitted");
          assert.ok(summaryFirst, "Preflight did not dispatch real summarization");
        }
      } else {
        assert.equal(held.totalTokens, item.expected, `${item.name} total changed`);
        assert.equal(summaryFirst, false, `${item.name} unexpectedly compacted`);
      }
      proof.releaseFirst.resolve();
      await terminal(runId);
      await stateHelpers.waitForCompactionReply(state, runId, proof.finalMarker);
      const after = readEntry(true);
      const ids = compactIds();
      const expectedCompaction = item.tail && !baselineRed;
      if (expectedCompaction) {
        assert.ok(ids.length > 0, "Summary response did not commit a real transcript boundary");
        assert.equal(after.compactionCount, ids.length, "Committed compaction was not accounted");
        const branch = sessions.SessionManager.open(target, gateway.workspaceDir).getBranch();
        assert.ok(
          branch.some((event: { id: string }) => ids.includes(event.id)),
          "Committed summary is absent from active history",
        );
      } else {
        assert.equal(ids.length, 0);
        assert.equal(after.compactionCount ?? 0, 0);
      }
      const successor = await send(proof.recoveryMarker);
      await terminal(successor);
      await stateHelpers.waitForCompactionReply(state, successor, proof.recoveryMarker);
      assert.deepEqual(compactIds(), ids, "Continuation repeated or lost compaction");
      assert.equal(proof.requests.filter((request) => request.kind === "continuation").length, 1);
      assert.deepEqual(provider.errors, []);
      const result = {
        case: item.name,
        heldTotal: held.totalTokens,
        heldFresh: held.totalTokensFresh,
        firstRequest: proof.requests[0]?.kind,
        compactionCount: after.compactionCount ?? 0,
        compactionBoundaries: ids.length,
        continuationDelivered: true,
        requests: proof.requests,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    await fs.writeFile(
      path.join(artifactBase, "verdict.json"),
      JSON.stringify(
        { status: baselineRed ? "baseline-red" : "candidate-green", results },
        null,
        2,
      ),
    );
  } finally {
    active?.releaseFirst.resolve();
    try {
      const stopped = await owner.stop({ keepTemp: true });
      assert.equal(stopped.process, "confirmed-stopped");
      assert.deepEqual(stopped.errors, []);
      shutdownConfirmed = true;
      if (gateway) {
        await fs.writeFile(path.join(artifactBase, "gateway.log"), gateway.logs());
        const stagedRoot = gateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT;
        assert.equal(
          stagedRoot,
          path.join(repoRoot, ".artifacts", "qa-runtime", path.basename(gateway.tempRoot)),
        );
        await fs.rm(stagedRoot!, { recursive: true, force: true });
      }
    } finally {
      await provider.stop();
      await bus.stop();
    }
    if (shutdownConfirmed) await fs.writeFile(path.join(tmpRoot, "gateway-stopped"), "confirmed\n");
  }
  console.log(
    baselineRed
      ? "MEMORY_FLUSH_BASELINE_RED: stale anchor trusted despite trailing growth"
      : "MEMORY_FLUSH_CANDIDATE_GREEN: completed compaction and continuation",
  );
  return baselineRed ? 1 : 0;
}

async function launch() {
  if (values["isolated-child"]) return runChild();
  const { runManagedCommand } = await import(fromRepo("scripts/lib/managed-child-process.mts"));
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-fresh-proof-")),
  );
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const config = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CI: "1",
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_OAUTH_DIR: path.join(state, "credentials"),
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  };
  for (const directory of [
    home,
    state,
    env.OPENCLAW_OAUTH_DIR,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
  ])
    await fs.mkdir(directory!, { recursive: true, mode: 0o700 });
  await fs.writeFile(config, "{}\n", { mode: 0o600 });
  let joined = false;
  try {
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--import",
        path.join(repoRoot, "scripts/tsx.mjs"),
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
        "--isolated-child",
      ],
      env,
      requireProcessTreeExit: true,
      timeoutMs: 10 * 60_000,
    });
    joined = true;
    return code;
  } finally {
    if (
      joined &&
      (await fs.readFile(path.join(root, "gateway-stopped"), "utf8").catch(() => "")) ===
        "confirmed\n"
    )
      await fs.rm(root, { recursive: true, force: true });
    else
      console.error(`Proof namespace retained until owned process shutdown is confirmed: ${root}`);
  }
}
launch()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
