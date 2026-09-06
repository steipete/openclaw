import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
assert.ok(mode === "red" || mode === "green");
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
        inputTokens: 78_000,
        seedChars: 256_000,
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
              logging: { ...config.logging, level: "debug", consoleLevel: "debug" },
              cron: { ...config.cron, enabled: false },
              memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  heartbeat: { every: "0m" },
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
            compactionEvents: events
              .filter((event) => event.type === "compaction")
              .map((event) => event.id),
          };
        };
        const send = async (message, expectedReply) => {
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
        const finalInputTokens = proof.requests.some((request) => request.kind === "summary")
          ? 1000
          : spec.inputTokens + 20;
        await waitUntil(() => {
          const entry = readEntry();
          return entry?.totalTokens === finalInputTokens && entry.totalTokensFresh === true;
        }, "final provider usage persisted");
        const after = readState();
        output.after = after;
        const freshLogs = gateway.readLogsSince(mark).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
        const memoryLines = freshLogs
          .split("\n")
          .filter(
            (line) =>
              line.includes("memoryFlush check:") && line.includes(`sessionKey=${sessionKey} `),
          );
        const preflightLines = freshLogs
          .split("\n")
          .filter(
            (line) =>
              line.includes("preflightCompaction check:") &&
              line.includes(`sessionKey=${sessionKey} `),
          );
        assert.equal(preflightLines.length, 1);
        assert.equal(memoryLines.length, spec.flushEnabled ? 1 : 0);
        const memory = memoryLines[0] ? fields(memoryLines[0]) : undefined;
        const preflight = fields(preflightLines[0]);
        output.gates = { memory, preflight };
        const firstGate = memoryLines[0] ?? preflightLines[0];
        const warmAt = freshLogs.indexOf("startup trace: post-ready.context-window-cache ");
        if (!spec.warm)
          assert.ok(
            warmAt < 0 || warmAt > freshLogs.indexOf(firstGate),
            "Normal prewarm completed before the purported cold decision",
          );
        else assert.ok(warmAt >= 0 && warmAt < freshLogs.indexOf(firstGate));
        const expectedWindow = spec.cap ?? (spec.warm || mode === "green" ? 1_000_000 : 200_000);
        if (memory) {
          assert.equal(Number(memory.contextWindow), expectedWindow);
          assert.equal(Number(memory.threshold), expectedWindow - 24_000);
          assert.equal(memory.isCli, "false");
          assert.equal(memory.memoryFlushWritable, "true");
          assert.equal(memory.forceFlushByTranscriptSize, "false");
        }
        assert.equal(Number(preflight.contextWindow), expectedWindow);
        assert.equal(Number(preflight.threshold), expectedWindow - 20_000);
        assert.equal(preflight.responsesServerCompactionThreshold, "undefined");
        assert.equal(preflight.sizeTrigger, "false");
        assert.equal(preflight.sizeTriggerLatched, "false");
        if (spec.flushEnabled)
          assert.ok(
            Number(preflight.tokenCount) < Number(preflight.threshold),
            "Flush cell unexpectedly crossed blocking compaction",
          );
        const flushes = proof.requests.filter((item) => item.kind === "flush");
        const summaries = proof.requests.filter((item) => item.kind === "summary");
        const expectedFlush =
          spec.flushEnabled && (Boolean(spec.cap) || (!spec.warm && mode === "red"));
        const expectedCompaction = !spec.flushEnabled && mode === "red";
        assert.equal(flushes.length, expectedFlush ? 1 : 0);
        assert.equal(
          proof.requests.filter((item) => item.kind === "seed").length,
          proof.seedMarkers.length,
        );
        assert.equal(proof.requests.filter((item) => item.kind === "reply").length, 1);
        assert.equal(summaries.length > 0, expectedCompaction);
        assert.ok(summaries.length < 8);
        assert.equal(after.compactionCount, expectedCompaction ? 1 : 0);
        assert.equal(after.compactionEvents.length, expectedCompaction ? 1 : 0);
        if (expectedFlush)
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
        output.status =
          mode === "red" && spec.name.startsWith("cold-prepared")
            ? "confirmed-baseline-defect"
            : "passed-control";
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
      `${JSON.stringify({ status: mode === "red" ? "confirmed-baseline-defects" : "candidate-green", results }, null, 2)}\n`,
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
  console.log(
    mode === "red" ? "CATALOG_WINDOW_BASELINE_CONFIRMED" : "CATALOG_WINDOW_CANDIDATE_CONFIRMED",
  );
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
      timeoutMs: 15 * 60_000,
    });
    joined = true;
    assert.equal(code, 0, "Isolated Gateway proof failed");
  } finally {
    if (
      joined &&
      (await fs.readFile(path.join(tmpRoot, "gateway-stopped"), "utf8").catch(() => "")) ===
        "confirmed\n"
    )
      await fs.rm(tmpRoot, { recursive: true, force: true });
    else
      console.error(`Owned proof state retained until process shutdown is confirmed: ${tmpRoot}`);
  }
}

launch().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
