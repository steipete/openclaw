import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

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
  values["artifact-base"] ?? ".artifacts/qa-e2e/noop-compaction",
);
const fromRepo = (relative: string) => pathToFileURL(path.join(repoRoot, relative)).href;
const PLUGIN_ID = "qa-noop-compaction-proof";
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const TIMEOUT = 60_000;

type Trace = {
  phase: string;
  sessionKey: string;
  event?: { compactedCount?: number };
  result?: { ok: boolean; compacted: boolean; reason: string };
};

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
  const traceFile = path.join(artifactBase, "plugin-trace.jsonl");
  await fs.writeFile(traceFile, "");
  const pluginDir = path.join(tmpRoot, "noop-plugin");
  await fs.mkdir(pluginDir);
  await fs.copyFile(
    new URL("./noop-context-engine-plugin.js", import.meta.url),
    path.join(pluginDir, "index.js"),
  );
  await fs.writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      kind: "context-engine",
      activation: { onStartup: true },
      configSchema: {
        type: "object",
        additionalProperties: false,
        required: ["traceFile"],
        properties: { traceFile: { type: "string" } },
      },
    }),
  );
  const [qa, store, transcript, hostStore] = await Promise.all([
    import(fromRepo("extensions/qa-lab/api.ts")),
    import(fromRepo("src/plugin-sdk/session-store-runtime.ts")),
    import(fromRepo("src/plugin-sdk/session-transcript-runtime.ts")),
    import(fromRepo("src/config/sessions/session-accessor.ts")),
  ]);
  const state = qa.createQaBusState();
  const transport = qa.createQaChannelTransport(state);
  const bus = await qa.startQaBusServer({ state });
  let providerCalls = 0;
  const provider = http.createServer((_request, response) => {
    providerCalls += 1;
    response.writeHead(500).end("No-op proof must not contact a model provider");
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const owner = qa.createQaGatewayChild();
  let gateway: Awaited<ReturnType<typeof owner.start>> | undefined;
  let shutdownConfirmed = false;
  let phase = "gateway-start";
  let failureDetails: string | undefined;
  const results: Array<Record<string, unknown>> = [];
  const readTrace = async (): Promise<Trace[]> =>
    (await fs.readFile(traceFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const retain = async () => {
    await fs.writeFile(
      path.join(artifactBase, "diagnostics.json"),
      JSON.stringify(
        {
          phase,
          results,
          providerCalls,
          trace: await readTrace(),
          ...(failureDetails ? { failure: failureDetails } : {}),
        },
        null,
        2,
      ),
    );
    if (gateway) await fs.writeFile(path.join(artifactBase, "gateway.log"), gateway.logs());
  };
  let missingCompletions = 0;
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
      providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      forcedRuntime: "openclaw",
      controlUiEnabled: false,
      thinkingDefault: "off",
      mutateConfig: (config: OpenClawConfig) => ({
        ...config,
        logging: { ...config.logging, level: "debug", consoleLevel: "debug" },
        cron: { ...config.cron, enabled: false },
        memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
        agents: {
          ...config.agents,
          defaults: { ...config.agents?.defaults, heartbeat: { every: "0m" } },
        },
        plugins: {
          ...config.plugins,
          enabled: true,
          allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
          load: {
            ...config.plugins?.load,
            paths: [...(config.plugins?.load?.paths ?? []), pluginDir],
          },
          slots: { ...config.plugins?.slots, contextEngine: PLUGIN_ID },
          entries: {
            ...config.plugins?.entries,
            [PLUGIN_ID]: { enabled: true, config: { traceFile } },
          },
        },
      }),
    });
    await transport.waitReady({ gateway, timeoutMs: TIMEOUT });
    assert.equal(gateway.cfg.plugins?.slots?.contextEngine, PLUGIN_ID);
    for (const caseName of ["noop", "failure", "throw"]) {
      phase = `seed-${caseName}`;
      const sessionId = randomUUID();
      const sessionKey = `agent:qa:compaction-proof-${caseName}`;
      const target = {
        agentId: "qa",
        sessionId,
        sessionKey,
        env: gateway.runtimeEnv,
        storePath: store.resolveStorePath(undefined, { agentId: "qa", env: gateway.runtimeEnv }),
      };
      assert.ok(
        hostStore
          .resolveSessionTranscriptDatabasePath(target)
          .startsWith(`${path.join(gateway.tempRoot, "state")}${path.sep}`),
      );
      await store.upsertSessionEntry({
        ...target,
        entry: { sessionId, updatedAt: Date.now(), compactionCount: 0 },
      });
      for (const message of [
        { role: "user", content: "Remember the orchard plan." },
        {
          role: "assistant",
          content: [{ type: "text", text: "The orchard plan is recorded." }],
          api: "openai-responses",
          provider: "mock-openai",
          model: "gpt-5.6-luna",
          stopReason: "stop",
        },
      ]) {
        const appended = await transcript.appendSessionTranscriptMessageByIdentity({
          ...target,
          message: { ...message, timestamp: Date.now() },
        });
        assert.ok(appended?.appended, "Synthetic history was not persisted");
      }
      const readEntry = () => {
        const entry = hostStore.loadSessionEntry({ ...target, readConsistency: "latest" });
        assert.equal(entry?.sessionId, sessionId);
        return {
          sessionId: entry.sessionId,
          compactionCount: entry.compactionCount ?? 0,
          totalTokens: entry.totalTokens,
          totalTokensFresh: entry.totalTokensFresh,
        };
      };
      const beforeEntry = readEntry();
      const beforeTranscript = store.loadTranscriptEventsSync(target);
      const repeats = caseName === "noop" ? 2 : 1;
      for (let attempt = 1; attempt <= repeats; attempt++) {
        phase = `compact-${caseName}-${attempt}`;
        const traceStart = (await readTrace()).length;
        const result = await gateway.call(
          "sessions.compact",
          { key: sessionKey },
          { timeoutMs: TIMEOUT },
        );
        assert.equal(result.compacted, false);
        assert.equal(result.ok, caseName === "noop");
        const trace = (await readTrace()).slice(traceStart);
        assert.ok(
          trace.every((event) => event.sessionKey === sessionKey),
          "Hook crossed synthetic session identity",
        );
        assert.equal(
          trace[0]?.phase,
          "before",
          "Real selected engine did not emit before_compaction",
        );
        assert.equal(
          trace[1]?.phase,
          caseName === "throw" ? "engine-throw" : "engine-result",
          "Gateway did not invoke the registered engine",
        );
        if (caseName === "noop") {
          assert.equal(result.reason, "Proof no-op");
          assert.deepEqual(trace[1].result, { ok: true, compacted: false, reason: "Proof no-op" });
          if (trace.length === 2) missingCompletions += 1;
          else {
            assert.equal(trace.length, 3);
            assert.equal(trace[2].phase, "after");
            assert.equal(trace[2].event?.compactedCount, 0);
          }
        } else {
          assert.equal(trace.length, 2, "Failed compaction emitted a completion hook");
          assert.match(String(result.reason), /Controlled proof (rejection|engine failure)/);
        }
        assert.deepEqual(readEntry(), beforeEntry, "No-op/failure changed session accounting");
        assert.deepEqual(
          store.loadTranscriptEventsSync(target),
          beforeTranscript,
          "No-op/failure changed transcript history",
        );
        assert.equal(providerCalls, 0);
        results.push({
          case: caseName,
          attempt,
          result,
          phases: trace.map((event) => event.phase),
          afterCount: trace.find((event) => event.phase === "after")?.event?.compactedCount ?? null,
          accountingUnchanged: true,
          transcriptUnchanged: true,
        });
        await retain();
      }
    }
    assert.ok(
      missingCompletions === 0 || missingCompletions === 2,
      "Inconsistent repeated no-op lifecycle",
    );
    phase = "complete";
    await fs.writeFile(
      path.join(artifactBase, "verdict.json"),
      JSON.stringify(
        {
          status: missingCompletions ? "baseline-red" : "candidate-green",
          missingCompletions,
          providerCalls,
          results,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failureDetails = String(error);
    await retain();
    throw error;
  } finally {
    await retain();
    try {
      const stopped = await owner.stop(
        gateway
          ? { keepTemp: true }
          : { preserveToDir: path.join(artifactBase, "gateway-start-logs") },
      );
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
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      await bus.stop();
    }
    if (shutdownConfirmed) await fs.writeFile(path.join(tmpRoot, "gateway-stopped"), "confirmed\n");
  }
  console.log(
    missingCompletions
      ? "NOOP_COMPACTION_BASELINE_RED: two successful no-ops omitted after hook"
      : "NOOP_COMPACTION_CANDIDATE_GREEN: no-op completion paired; failure and history controls unchanged",
  );
  return missingCompletions ? 1 : 0;
}

async function launch() {
  if (values["isolated-child"]) return runChild();
  const { runManagedCommand } = await import(fromRepo("scripts/lib/managed-child-process.mts"));
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-noop-compaction-proof-")),
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
