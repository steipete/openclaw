import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MODEL_ID, MODEL_REF, ORCHARD_TEXT, startProvider } from "./provider.mjs";

const { values } = parseArgs({
  options: {
    "repo-root": { type: "string" },
    "artifact-base": { type: "string" },
    mode: { type: "string" },
    "isolated-child": { type: "boolean" },
  },
});
const repoRoot = path.resolve(values["repo-root"] ?? process.cwd());
const artifactBase = path.resolve(
  values["artifact-base"] ?? path.join(repoRoot, ".artifacts/catalog-window-proof"),
);
const mode = values.mode;
assert.equal(mode, "green");
const fromRepo = (file) => pathToFileURL(path.join(repoRoot, file)).href;
const TIMEOUT = 90_000;

async function waitUntil(predicate, label) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Proof observation did not complete: ${label}`);
}

function fields(line) {
  return Object.fromEntries(
    [...line.matchAll(/(\w+)=([^ ]+)/g)].map((match) => [match[1], match[2]]),
  );
}

function logRecords(text) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const clean = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      const record = clean.startsWith("{") ? JSON.parse(clean) : { message: clean };
      assert.equal(typeof record.message, "string");
      return { ...record, message: record.message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "") };
    });
}

async function runChild() {
  const tmpRoot = await fs.realpath(process.env.TMPDIR);
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
      `${name} escaped owned state`,
    );
  }
  for (const name of ["CODEX_HOME", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"])
    assert.equal(process.env[name], undefined);
  assert.notEqual(process.env.NODE_ENV, "test");
  await fs.mkdir(artifactBase, { recursive: true });
  const [qa, store, hostStore, sessions] = await Promise.all([
    import(fromRepo("extensions/qa-lab/api.ts")),
    import(fromRepo("src/plugin-sdk/session-store-runtime.ts")),
    import(fromRepo("src/config/sessions/session-accessor.ts")),
    import(fromRepo("src/plugin-sdk/agent-sessions.ts")),
  ]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, "extensions/deepseek/openclaw.plugin.json"), "utf8"),
  );
  const findModel = (value) => {
    if (Array.isArray(value)) return value.map(findModel).find(Boolean);
    if (!value || typeof value !== "object") return undefined;
    if (value.id === MODEL_ID && value.contextWindow === 1_000_000) return value;
    return Object.values(value).map(findModel).find(Boolean);
  };
  const catalogRow = findModel(manifest);
  assert.ok(catalogRow && catalogRow.reasoning === true);
  const provider = await startProvider();
  const results = [];
  let allStopped = true;
  try {
    for (const spec of [
      {
        name: "cold-prepared-flush",
        inputTokens: 177_000,
        seedChars: 640_000,
        warm: false,
        flushEnabled: true,
      },
      {
        name: "cold-prepared-compaction",
        inputTokens: 190_000,
        seedChars: 640_000,
        warm: false,
        flushEnabled: false,
      },
      {
        name: "authored-cap-control",
        inputTokens: 74_000,
        replyInputTokens: 78_000,
        seedChars: 192_000,
        warm: false,
        flushEnabled: true,
        cap: 100_000,
      },
      {
        name: "natural-warm-control",
        inputTokens: 177_000,
        seedChars: 640_000,
        warm: true,
        flushEnabled: true,
      },
    ]) {
      const id = randomUUID();
      const proof = {
        ...spec,
        replyInputTokens: spec.replyInputTokens ?? spec.inputTokens + 20,
        seedMarkers: Array.from({ length: 4 }, (_, index) => `CATALOG_SEED_${id}_${index}`),
        replyMarker: `CATALOG_REPLY_${id}`,
        summaryMarker: `CATALOG_SUMMARY_${id}`,
        phase: "seed",
        requests: [],
        modelListRequests: 0,
      };
      provider.arm(proof);
      const state = qa.createQaBusState();
      const transport = qa.createQaChannelTransport(state);
      const bus = await qa.startQaBusServer({ state });
      const owner = qa.createQaGatewayChild();
      allStopped = false;
      let gateway;
      const deliveries = () =>
        state
          .getSnapshot()
          .messages.filter((item) => item.direction === "outbound")
          .map((item) => ({ runId: item.replyToId, text: item.text, isError: item.isError }));
      const output = {
        name: spec.name,
        sourceMode: mode,
        inputTokens: spec.inputTokens,
        seedChars: spec.seedChars,
        requests: proof.requests,
        seedRuns: [],
        cycles: [],
      };
      const assertDeliveries = () => {
        assert.deepEqual(
          deliveries().map(({ runId, text }) => ({ runId, text })),
          [...output.seedRuns, { runId: output.exerciseRun, text: proof.replyMarker }],
        );
        assert.ok(deliveries().every((item) => !item.isError));
      };
      try {
        gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "dist/index.js")],
            argsSuffix: ["--verbose"],
            tempParentDir: tmpRoot,
          },
          transport,
          transportBaseUrl: bus.baseUrl,
          providerBaseUrl: provider.baseUrl,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          enabledPluginIds: ["deepseek"],
          controlUiEnabled: false,
          thinkingDefault: "low",
          runtimeEnvPatch: {
            OPENCLAW_TEST_FAST: "0",
            OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "0",
            OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          },
          mutateConfig(config) {
            return {
              ...config,
              logging: {
                ...config.logging,
                level: "debug",
                consoleLevel: "debug",
                consoleStyle: "json",
              },
              cron: { ...config.cron, enabled: false },
              memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  heartbeat: { every: "0m" },
                  userTimezone: "UTC",
                  compaction: {
                    ...config.agents?.defaults?.compaction,
                    memoryFlush: { enabled: spec.flushEnabled },
                  },
                },
              },
              models: {
                mode: "merge",
                providers: {
                  deepseek: {
                    baseUrl: provider.baseUrl,
                    apiKey: "qa-synthetic",
                    api: "openai-completions",
                    request: { allowPrivateNetwork: true },
                    ...(spec.cap ? { models: [{ ...catalogRow, contextTokens: spec.cap }] } : {}),
                  },
                },
              },
            };
          },
        });
        assert.equal(gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME, undefined);
        assert.equal(gateway.runtimeEnv.OPENCLAW_TEST_FAST, "0");
        assert.equal(gateway.runtimeEnv.OPENCLAW_SKIP_STARTUP_MODEL_PREWARM, "0");
        for (const name of ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", "CODEX_HOME"])
          assert.equal(gateway.runtimeEnv[name], undefined);
        assert.notEqual(gateway.runtimeEnv.NODE_ENV, "test");
        assert.equal(gateway.cfg.models.providers.deepseek.models === undefined, !spec.cap);
        assert.equal(gateway.cfg.agents.defaults.thinkingDefault, "low");
        assert.equal(gateway.cfg.plugins.slots.memory, "memory-core");
        await transport.waitReady({ gateway, timeoutMs: TIMEOUT });
        const assertConfigShape = async () => {
          const current = JSON.parse(await fs.readFile(gateway.configPath, "utf8"));
          assert.equal(current.models.providers.deepseek.models === undefined, !spec.cap);
          assert.equal(current.agents.defaults.contextTokens, undefined);
          assert.equal(current.agents.defaults.thinkingDefault, "low");
          assert.equal(current.agents.defaults.userTimezone, "UTC");
          assert.equal(current.logging.consoleStyle, "json");
        };
        await assertConfigShape();
        const sessionKey = `agent:qa:catalog-window-${id}`;
        const storePath = store.resolveStorePath(undefined, {
          agentId: "qa",
          env: gateway.runtimeEnv,
        });
        const readEntry = () =>
          hostStore.loadSessionEntry({
            agentId: "qa",
            sessionKey,
            storePath,
            env: gateway.runtimeEnv,
            readConsistency: "latest",
          });
        const readState = () => {
          const entry = readEntry();
          assert.ok(entry?.sessionId, "Real session row missing");
          const target = {
            agentId: "qa",
            sessionKey,
            sessionId: entry.sessionId,
            storePath,
            env: gateway.runtimeEnv,
          };
          const stats = hostStore.readSessionTranscriptActiveStats(target);
          const events = sessions.SessionManager.open(target, gateway.workspaceDir).getEntries();
          return {
            sessionId: entry.sessionId,
            totalTokens: entry.totalTokens,
            totalTokensFresh: entry.totalTokensFresh,
            totalTokensVersion: entry.totalTokensVersion,
            modelProvider: entry.modelProvider,
            model: entry.model,
            contextTokens: entry.contextTokens,
            contextTokensSource: entry.contextTokensSource,
            compactionCount: entry.compactionCount ?? 0,
            memoryFlush: entry.memoryFlush,
            transcriptBytes: stats.sizeBytes,
            sourceMessages: events
              .filter(
                (event) =>
                  event.type === "message" && ["user", "assistant"].includes(event.message.role),
              )
              .map((event) => ({
                id: event.id,
                role: event.message.role,
                contentSha256: createHash("sha256")
                  .update(JSON.stringify(event.message.content))
                  .digest("hex"),
                hasReplyMarker: JSON.stringify(event.message.content).includes(proof.replyMarker),
              })),
            compactionEvents: events
              .filter((event) => event.type === "compaction")
              .map((event) => event.id),
          };
        };
        const send = async (message, expectedReply) => {
          const turnMark = gateway.markLogs();
          const start = await gateway.call("chat.send", {
            sessionKey,
            message,
            idempotencyKey: randomUUID(),
            deliver: true,
            originatingChannel: "qa-channel",
            originatingTo: "dm:qa-operator",
          });
          assert.equal(typeof start.runId, "string");
          const terminal = await gateway.call(
            "agent.wait",
            { runId: start.runId, timeoutMs: TIMEOUT },
            { timeoutMs: TIMEOUT + 5_000 },
          );
          assert.equal(terminal.status, "ok", `Real reply failed: ${JSON.stringify(terminal)}`);
          await waitUntil(
            () =>
              state
                .getSnapshot()
                .messages.some(
                  (item) =>
                    item.direction === "outbound" &&
                    item.replyToId === start.runId &&
                    item.text === expectedReply,
                ),
            "exact QA reply delivery",
          );
          assert.deepEqual(
            deliveries()
              .filter((item) => item.runId === start.runId)
              .map((item) => item.text),
            [expectedReply],
            "Run emitted extra or missing user-visible output",
          );
          const maintenanceEvents = () =>
            logRecords(gateway.readLogsSince(turnMark)).filter(
              (record) =>
                record.event === "session_maintenance" && record.sessionKey === sessionKey,
            );
          await waitUntil(
            () => maintenanceEvents().some((record) => record.phase === "settled"),
            "actual post-delivery maintenance settlement",
          );
          const records = logRecords(gateway.readLogsSince(turnMark));
          const events = maintenanceEvents();
          assert.equal(new Set(events.map((event) => event.maintenanceId)).size, 1);
          assert.equal(new Set(events.map((event) => event.lifecycleGeneration)).size, 1);
          assert.equal(typeof events[0].maintenanceId, "number");
          assert.equal(typeof events[0].lifecycleGeneration, "string");
          assert.deepEqual(
            events.map((event) => event.phase),
            ["pending", "started", "settled"],
          );
          const checks = records.filter(
            (record) =>
              (record.message.includes("memoryFlush check:") ||
                record.message.includes("preflightCompaction check:")) &&
              record.message.includes(`sessionKey=${sessionKey} `),
          );
          const dispatches = records.filter(
            (record) =>
              record.event === "memory_flush_dispatched" && record.sourceSessionKey === sessionKey,
          );
          output.cycles.push({ runId: start.runId, events, checks, dispatches });
          return start.runId;
        };
        await waitUntil(
          () => gateway.logs().includes("startup trace: post-ready.context-window-cache "),
          "normal prewarm before producing historical seed turns",
        );
        proof.seedTurnChars = spec.seedChars / proof.seedMarkers.length;
        const history = ORCHARD_TEXT.repeat(
          Math.ceil(proof.seedTurnChars / ORCHARD_TEXT.length),
        ).slice(0, proof.seedTurnChars);
        for (const [index, marker] of proof.seedMarkers.entries()) {
          proof.seedMarker = marker;
          proof.seedInputTokens = Math.floor(
            (spec.inputTokens * (index + 1)) / proof.seedMarkers.length,
          );
          const runId = await send(
            `Read synthetic orchard log section ${index + 1} of ${proof.seedMarkers.length}. It is background context only; reply exactly ${marker}.\n\n${history}`,
            marker,
          );
          output.seedRuns.push({ runId, text: marker });
          await waitUntil(() => {
            const entry = readEntry();
            return entry?.totalTokens === proof.seedInputTokens && entry.totalTokensFresh === true;
          }, "seed provider usage persisted");
        }
        const seeded = readState();
        assert.equal(seeded.totalTokens, spec.inputTokens);
        assert.equal(seeded.totalTokensFresh, true);
        assert.equal(seeded.modelProvider, "deepseek");
        assert.equal(seeded.model, MODEL_ID);
        assert.equal(seeded.contextTokens, spec.cap ?? 1_000_000);
        assert.equal(seeded.contextTokensSource, "resolved");
        assert.equal(seeded.compactionCount, 0);
        assert.equal(
          seeded.memoryFlush,
          undefined,
          "Fresh seed unexpectedly stamped a memory flush",
        );
        assert.ok(
          seeded.transcriptBytes < 2 * 1024 * 1024,
          "Seed exceeds the unchanged default byte-flush fuse",
        );
        output.seeded = seeded;
        await assertConfigShape();
        output.initialPid = gateway.pid;
        const mark = gateway.markLogs();
        await gateway.restartAfterStateMutation(async () => {});
        output.replacementPid = gateway.pid;
        assert.notEqual(
          output.replacementPid,
          output.initialPid,
          "Restart did not create a fresh process",
        );
        await assertConfigShape();
        if (spec.warm)
          await waitUntil(
            () =>
              gateway
                .readLogsSince(mark)
                .includes("startup trace: post-ready.context-window-cache "),
            "natural context-cache prewarm",
          );
        proof.phase = "exercise";
        output.exerciseRun = await send(
          `Reply with only this exact marker: ${proof.replyMarker}`,
          proof.replyMarker,
        );
        await waitUntil(() => {
          const entry = readEntry();
          return entry?.totalTokens === proof.replyInputTokens && entry.totalTokensFresh === true;
        }, "final provider usage persisted");
        const after = readState();
        output.after = after;
        const records = logRecords(gateway.readLogsSince(mark));
        const firstGate = records.findIndex(
          (record) =>
            record.message.includes("preflightCompaction check:") &&
            record.message.includes(`sessionKey=${sessionKey} `),
        );
        assert.ok(firstGate >= 0);
        const warmAt = records.findIndex((record) =>
          record.message.includes("startup trace: post-ready.context-window-cache "),
        );
        if (spec.warm) assert.ok(warmAt >= 0 && warmAt < firstGate);
        else
          assert.ok(
            warmAt < 0 || warmAt > firstGate,
            "Normal prewarm completed before the purported cold decision",
          );
        const readyAt = records.findIndex(
          (record) => record.subsystem === "gateway" && record.message === "gateway ready",
        );
        assert.ok(
          readyAt >= 0 && readyAt < firstGate,
          "Complete fresh Gateway readiness chronology was not retained",
        );
        const memoryGate = records.findIndex(
          (record) =>
            record.message.includes("memoryFlush check:") &&
            record.message.includes(`sessionKey=${sessionKey} `),
        );
        if (spec.name === "cold-prepared-flush") {
          assert.ok(memoryGate > firstGate);
          assert.ok(
            warmAt < 0 || warmAt > memoryGate,
            "Normal prewarm completed before the cold post-reply memory decision",
          );
        }
        output.coldObservation = {
          readyAt,
          firstGate,
          memoryGate,
          warmAt,
          firstGateRecord: records[firstGate],
          memoryGateRecord: records[memoryGate],
        };
        const expectedWindow = spec.cap ?? 1_000_000;
        assert.equal(output.cycles.length, proof.seedMarkers.length + 1);
        for (const cycle of output.cycles) {
          const preflights = cycle.checks
            .filter((record) => record.message.includes("preflightCompaction check:"))
            .map((record) => fields(record.message));
          const flushChecks = cycle.checks
            .filter((record) => record.message.includes("memoryFlush check:"))
            .map((record) => fields(record.message));
          assert.equal(
            preflights.length,
            2,
            "Expected foreground and completed optional preflight checks",
          );
          assert.equal(flushChecks.length, spec.flushEnabled ? 1 : 0);
          for (const preflight of preflights) {
            assert.equal(Number(preflight.contextWindow), expectedWindow);
            assert.equal(Number(preflight.threshold), expectedWindow - 20_000);
            assert.equal(preflight.responsesServerCompactionThreshold, "undefined");
            assert.equal(preflight.sizeTrigger, "false");
            assert.equal(preflight.sizeTriggerLatched, "false");
            assert.ok(Number(preflight.tokenCount) < Number(preflight.threshold));
          }
          for (const memory of flushChecks) {
            assert.equal(Number(memory.contextWindow), expectedWindow);
            assert.equal(Number(memory.threshold), expectedWindow - 24_000);
            assert.equal(memory.isCli, "false");
            assert.equal(memory.memoryFlushWritable, "true");
            assert.equal(memory.forceFlushByTranscriptSize, "false");
          }
          const expectedFlush = Boolean(spec.cap) && cycle.runId === output.exerciseRun;
          assert.equal(cycle.dispatches.length, expectedFlush ? 1 : 0);
          if (expectedFlush) {
            const dispatch = cycle.dispatches[0];
            assert.equal(dispatch.sourceSessionId, seeded.sessionId);
            assert.notEqual(dispatch.sessionId, seeded.sessionId);
            assert.notEqual(dispatch.sessionKey, sessionKey);
          }
        }
        const flushes = proof.requests.filter((request) => request.kind === "flush");
        assert.equal(flushes.length, spec.cap ? 1 : 0);
        assert.ok(
          flushes.every((request) => request.runtimeEventUser && request.maintenanceSystem),
        );
        assert.ok(proof.requests.every((request) => request.accepted));
        assert.equal(
          proof.requests.filter((request) => request.kind === "seed").length,
          proof.seedMarkers.length,
        );
        assert.equal(proof.requests.filter((request) => request.kind === "reply").length, 1);
        assert.equal(proof.requests.filter((request) => request.kind === "summary").length, 0);
        assert.equal(after.compactionCount, 0);
        assert.deepEqual(after.compactionEvents, []);
        assert.equal(after.sessionId, seeded.sessionId);
        assert.equal(after.totalTokens, proof.replyInputTokens);
        assert.equal(after.contextTokens, expectedWindow);
        assert.equal(after.contextTokensSource, "resolved");
        assert.equal(seeded.sourceMessages.length, proof.seedMarkers.length * 2);
        assert.deepEqual(
          after.sourceMessages.slice(0, seeded.sourceMessages.length),
          seeded.sourceMessages,
        );
        const addedMessages = after.sourceMessages.slice(seeded.sourceMessages.length);
        assert.deepEqual(
          addedMessages.map((message) => message.role),
          ["user", "assistant"],
        );
        assert.ok(addedMessages.every((message) => message.hasReplyMarker));
        if (spec.cap)
          assert.deepEqual(after.memoryFlush, { kind: "succeeded", compactionCount: 0 });
        else assert.equal(after.memoryFlush, undefined);
        assert.deepEqual(provider.errors, []);
        output.deliveries = deliveries();
        assertDeliveries();
        output.catalog = {
          provider: "deepseek",
          id: MODEL_ID,
          contextWindow: catalogRow.contextWindow,
          reasoning: catalogRow.reasoning,
          configuredRowsPresent: Boolean(spec.cap),
        };
        output.status = "candidate-green";
        results.push(output);
      } catch (error) {
        output.status = "failed-proof";
        output.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        const cleanupErrors = [];
        try {
          output.deliveries = deliveries();
          await fs.writeFile(
            path.join(artifactBase, `${spec.name}.json`),
            `${JSON.stringify(output, null, 2)}\n`,
          );
          if (gateway)
            await fs.writeFile(path.join(artifactBase, `${spec.name}.gateway.log`), gateway.logs());
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          const stopped = await owner.stop(
            gateway
              ? { keepTemp: true }
              : { preserveToDir: path.join(artifactBase, `${spec.name}-startup`) },
          );
          if (gateway) assert.equal(stopped.process, "confirmed-stopped");
          else
            assert.ok(
              stopped.process === "never-spawned" || stopped.process === "confirmed-stopped",
            );
          assert.deepEqual(stopped.errors, []);
          output.deliveries = deliveries();
          await fs.writeFile(
            path.join(artifactBase, `${spec.name}.json`),
            `${JSON.stringify(output, null, 2)}\n`,
          );
          if (output.status !== "failed-proof") assertDeliveries();
          if (gateway) {
            await fs.writeFile(path.join(artifactBase, `${spec.name}.gateway.log`), gateway.logs());
            const stagedRoot = gateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT;
            assert.equal(
              stagedRoot,
              path.join(repoRoot, ".artifacts/qa-runtime", path.basename(gateway.tempRoot)),
            );
            await fs.rm(stagedRoot, { recursive: true, force: true });
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await bus.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        allStopped = cleanupErrors.length === 0;
        if (cleanupErrors.length)
          throw new AggregateError(cleanupErrors, "Owned Gateway proof cleanup failed");
      }
    }
    assert.equal(results.length, 4);
    await fs.writeFile(
      path.join(artifactBase, "verdict.json"),
      `${JSON.stringify({ status: "candidate-green", results }, null, 2)}\n`,
    );
  } finally {
    await provider.stop();
    await fs.writeFile(
      path.join(artifactBase, "provider-errors.json"),
      `${JSON.stringify(provider.errors, null, 2)}\n`,
    );
    if (allStopped) await fs.writeFile(path.join(tmpRoot, "gateway-stopped"), "confirmed\n");
    assert.deepEqual(provider.errors, []);
  }
  console.log("CATALOG_WINDOW_CANDIDATE_CONFIRMED");
}

async function launch() {
  if (values["isolated-child"]) return runChild();
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepared-catalog-")),
  );
  const homeDir = path.join(tmpRoot, "home");
  const stateDir = path.join(tmpRoot, "state");
  const configPath = path.join(tmpRoot, "openclaw.json");
  const env = {
    PATH: process.env.PATH,
    CI: "1",
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    TMPDIR: tmpRoot,
    TMP: tmpRoot,
    TEMP: tmpRoot,
    XDG_CONFIG_HOME: path.join(tmpRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(tmpRoot, "xdg-data"),
    XDG_CACHE_HOME: path.join(tmpRoot, "xdg-cache"),
  };
  for (const dir of [
    homeDir,
    stateDir,
    env.OPENCLAW_OAUTH_DIR,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
  ])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, "{}\n", { mode: 0o600 });
  const { runManagedCommand } = await import(fromRepo("scripts/lib/managed-child-process.mts"));
  let passed = false;
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
      timeoutMs: 15 * 60_000,
    });
    assert.equal(code, 0, "Isolated Gateway proof failed");
    passed = true;
  } finally {
    if (
      passed &&
      (await fs.readFile(path.join(tmpRoot, "gateway-stopped"), "utf8").catch(() => "")) ===
        "confirmed\n"
    )
      await fs.rm(tmpRoot, { recursive: true, force: true });
    else console.error(`Owned proof state retained for diagnostics: ${tmpRoot}`);
  }
}

launch().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
