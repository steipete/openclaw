// Inert task fixture. Intended placement: test/e2e/qa-lab/runtime/.
// Published LCM and native SSE contracts inspected; complete proof review/execution pending.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
  type QaGatewayChild,
  type QaGatewayChildStateMutationContext,
} from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

export const SNAPSHOT_REPLY = "QA-SNAPSHOT-REUSE-OK";
export const SNAPSHOT_SESSION_KEY = "agent:qa:snapshot-reuse";
const SNAPSHOT_MODEL_REF = "openai/gpt-5.6-luna";
type SnapshotModel = Awaited<ReturnType<typeof startQaMockOpenAiServer>>;

/** The existing bounded debug API records actual requests received from native Codex. */
export async function readSnapshotProviderRequests(model: SnapshotModel, after = 0) {
  const response = await fetch(`${model.baseUrl}/debug/requests?after=${after}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, "mock provider request cursor must remain available");
  const requests: unknown = await response.json();
  assert.ok(Array.isArray(requests));
  return requests as MockOpenAiRequestSnapshot[];
}

/** Installs the verified published package through the normal managed plugin path. */
export async function withNativeSnapshotGateway<T>(
  params: {
    repoRoot: string;
    sourceCommit: string;
    lcmArchive: string;
    ownedRoot: string;
    observer?: { path: string; countsFile: string };
  },
  prepare: (gateway: QaGatewayChild, state: QaGatewayChildStateMutationContext) => Promise<void>,
  inspect: (gateway: QaGatewayChild, model: SnapshotModel) => Promise<T>,
): Promise<{ value: T; logs: string }> {
  assert.equal(process.env.CI, "true", "this composition is restricted to secretless CI");
  assert.ok(path.isAbsolute(params.repoRoot) && path.isAbsolute(params.lcmArchive));
  assert.ok(path.isAbsolute(params.ownedRoot));
  const owner = createQaGatewayChild();
  let model: SnapshotModel | undefined;
  let gateway: QaGatewayChild | undefined;
  let nodeOptions: string | undefined;
  if (params.observer) {
    const configFile = `${params.observer.countsFile}.config.json`;
    await fs.writeFile(
      configFile,
      JSON.stringify({
        repoRoot: params.repoRoot,
        commit: params.sourceCommit,
        sessionKey: SNAPSHOT_SESSION_KEY,
        outputFile: params.observer.countsFile,
      }),
      { mode: 0o600 },
    );
    const observerUrl = pathToFileURL(params.observer.path);
    observerUrl.searchParams.set("config", configFile);
    nodeOptions = `--import=${JSON.stringify(observerUrl.href)}`;
  }
  let interrupted = false;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [
        async () => {
          const stopped = await owner.stop();
          assert.notEqual(
            stopped.process,
            "unconfirmed",
            "Gateway process cleanup was not verified",
          );
          if (stopped.errors.length) {
            throw new AggregateError(stopped.errors, "Gateway cleanup failed");
          }
        },
        () => model?.stop(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      await fs.writeFile(
        path.join(params.ownedRoot, "cleanup.json"),
        JSON.stringify({ joined: errors.length === 0 }),
      );
      if (errors.length) {
        throw new AggregateError(errors, "snapshot Gateway cleanup failed");
      }
    })());
  const interrupt = () => {
    interrupted = true;
    void stop().catch(() => {});
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) {
    process.once(signal, interrupt);
  }
  const deadline = setTimeout(interrupt, 420_000);
  let value: T;
  try {
    value = await runQaGatewayFixture(async () => {
      const provider = await startQaMockOpenAiServer({ modelRefs: [SNAPSHOT_MODEL_REF] });
      model = provider;
      if (interrupted) {
        await provider.stop();
        throw new Error("snapshot proof was interrupted during provider startup");
      }
      const active = await owner.start({
        repoRoot: params.repoRoot,
        forcedRuntime: "codex",
        providerMode: "mock-openai",
        providerBaseUrl: `${provider.baseUrl}/v1`,
        primaryModel: SNAPSHOT_MODEL_REF,
        alternateModel: SNAPSHOT_MODEL_REF,
        transportBaseUrl: provider.baseUrl,
        controlUiEnabled: false,
        forwardHostHome: false,
        runtimeEnvPatch: {
          NODE_OPTIONS: nodeOptions,
          LCM_LOG_FILE: path.join(params.ownedRoot, "lcm.log"),
        },
        mutateConfig: (config) => ({
          ...config,
          logging: { ...config.logging, level: "debug" },
        }),
      });
      gateway = active;
      await active.runCli([
        "plugins",
        "install",
        `npm-pack:${params.lcmArchive}`,
        "--force",
        "--accept-capabilities",
      ]);
      await active.restartAfterStateMutation(async (state) => {
        const config: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        config.plugins ??= {};
        config.plugins.allow = [...new Set([...(config.plugins.allow ?? []), "lossless-claw"])];
        config.plugins.slots = { ...config.plugins.slots, contextEngine: "lossless-claw" };
        config.plugins.entries ??= {};
        config.plugins.entries["lossless-claw"] = {
          ...config.plugins.entries["lossless-claw"],
          enabled: true,
        };
        await fs.writeFile(state.configPath, JSON.stringify(config, null, 2) + "\n", {
          mode: 0o600,
        });
        await prepare(active, state);
      });
      assert.equal(interrupted, false);
      const result = await inspect(active, provider);
      assert.equal(interrupted, false);
      return result;
    }, stop);
  } finally {
    clearTimeout(deadline);
    try {
      await stop();
    } finally {
      for (const signal of signals) {
        process.off(signal, interrupt);
      }
    }
  }
  assert.ok(gateway);
  // Stop is joined before final diagnostics or counters are accepted by the caller.
  return { value, logs: gateway.logs() };
}

/** Uses the public Gateway turn lifecycle; the native process is never replaced. */
export async function runSnapshotTextTurn(
  gateway: QaGatewayChild,
  turn: "warmup" | "measured",
  index = 0,
) {
  const message = `Snapshot ${turn} turn ${index}. Reply with exactly: ${SNAPSHOT_REPLY}`;
  const startedAtMs = performance.now();
  const accepted = (await gateway.call("agent", {
    agentId: "qa",
    sessionKey: SNAPSHOT_SESSION_KEY,
    message,
    deliver: false,
    idempotencyKey: randomUUID(),
  })) as { status: string; runId: string };
  assert.equal(accepted.status, "accepted");
  const completed = (await gateway.call(
    "agent.wait",
    { runId: accepted.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  )) as { status: string };
  assert.equal(completed.status, "ok");
  return {
    runId: accepted.runId,
    message,
    elapsedMs: performance.now() - startedAtMs,
    processTreeRssBytes: gateway.getProcessRssBytes(),
  };
}
