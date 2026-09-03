/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { captureEnv } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const INSTANCE_BINDING_PROBE_KEY = Symbol.for("openclaw.test.gatewayInstanceBindingProbe");
const INSTANCE_BINDING_PROBE_METHOD = "instanceBinding.probe";

type InstanceBindingProbeResult = {
  registryId: number;
  sessionsId: number;
  placementId: number;
  reloadSettled?: boolean;
};

const CHANNEL_BINDING_IDS = ["binding-first", "binding-second"] as const;
type ChannelBindingMonitor = {
  channelId: string;
  runtimeId: number;
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  stopped: boolean;
};
type ChannelBindingProof = {
  events: Array<{ event: string; channelId?: string; runtimeId?: number }>;
  monitors: ChannelBindingMonitor[];
  observations: unknown[];
};

type InstanceBindingProbeCoordinator = {
  identify: (value: object) => number;
  nextRegistryId: number;
  runtimes: PluginRuntime[];
  serviceStarts: number;
  serviceStops: number;
  serviceStopFailure?: "rejection" | "timeout";
  channelProof?: ChannelBindingProof;
};

function installInstanceBindingProbeCoordinator(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
  channels?: boolean;
}): InstanceBindingProbeCoordinator {
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const coordinator: InstanceBindingProbeCoordinator = {
    identify(value) {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const id = nextId++;
      ids.set(value, id);
      return id;
    },
    nextRegistryId: 1,
    runtimes: [],
    serviceStarts: 0,
    serviceStops: 0,
    ...(options?.channels ? { channelProof: { events: [], monitors: [], observations: [] } } : {}),
    ...(options?.serviceStopFailure ? { serviceStopFailure: options.serviceStopFailure } : {}),
  };
  (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY] = coordinator;
  return coordinator;
}

async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<{ runtime: PluginRuntime }> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      // Plugin runtimes are proxies. Keep the async result non-thenable so
      // Promise assimilation does not materialize the broad runtime graph.
      return { runtime };
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

function requestInstanceBindingProbe(runtime: PluginRuntime) {
  return runtime.gateway.request<InstanceBindingProbeResult>(
    INSTANCE_BINDING_PROBE_METHOD,
    {},
    { scopes: ["operator.read"] },
  );
}

async function writeInstanceBindingProbePlugin(): Promise<{ bundledRoot: string }> {
  const bundledRoot = tempDirs.make("openclaw-instance-binding-");
  const pluginDir = path.join(bundledRoot, "instance-binding-probe");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: "instance-binding-probe",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "instance-binding-probe",
      name: "Startup plugin",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-probe",
  register(api) {
    const coordinator = globalThis[Symbol.for("openclaw.test.gatewayInstanceBindingProbe")];
    const registryId = coordinator.nextRegistryId++;
    coordinator.runtimes.push(api.runtime);
    if (coordinator.serviceStopFailure) {
      api.registerService({
        id: "instance-binding-service",
        start() {
          coordinator.serviceStarts += 1;
        },
        stop() {
          coordinator.serviceStops += 1;
          if (coordinator.serviceStopFailure === "rejection") {
            return Promise.reject(new Error("instance-binding service cleanup rejected"));
          }
          if (coordinator.serviceStopFailure === "timeout") {
            return new Promise(() => {});
          }
        },
      });
    }
    api.registerGatewayMethod("${INSTANCE_BINDING_PROBE_METHOD}", ({ context, respond }) => {
      respond(true, {
        registryId,
        sessionsId: coordinator.identify(context.sessionCompanion),
        placementId: coordinator.identify(context.workerSessionPlacementService),
        ...(coordinator.channelProof ? { reloadSettled: context.isConfigReloadSettled() } : {}),
      });
    }, { scope: "operator.read" });
  },
};
`,
  );
  return { bundledRoot };
}

async function writeChannelBindingProbePlugin(bundledRoot: string): Promise<void> {
  const pluginDir = path.join(bundledRoot, "instance-binding-channels");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "instance-binding-channels",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "instance-binding-channels",
      channels: CHANNEL_BINDING_IDS,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-channels",
  register(api) {
    const coordinator = globalThis[Symbol.for("openclaw.test.gatewayInstanceBindingProbe")];
    const proof = coordinator.channelProof;
    const runtimeId = coordinator.identify(api.runtime);
    for (const channelId of ${JSON.stringify(CHANNEL_BINDING_IDS)}) {
      proof.events.push({ event: "register", channelId, runtimeId });
      api.registerChannel({
        id: channelId,
        meta: { id: channelId, label: channelId, selectionLabel: channelId,
          docsPath: "/channels", blurb: "Synthetic lifecycle channel" },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default", enabled: true }),
          isConfigured: () => true,
        },
        gateway: {
          async startAccount(ctx) {
            const monitor = { channelId, runtimeId, runtime: api.runtime,
              abortSignal: ctx.abortSignal, stopped: false };
            proof.monitors.push(monitor);
            proof.events.push({ event: "start", channelId, runtimeId });
            ctx.setStatus({ accountId: ctx.accountId, connected: true, lifecycle: "ready" });
            try {
              await new Promise((resolve) => {
                if (ctx.abortSignal.aborted) { resolve(); return; }
                ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            } finally {
              monitor.stopped = true;
              proof.events.push({ event: "stopped", channelId, runtimeId });
            }
          },
          async stopAccount(ctx) {
            proof.events.push({ event: ctx.abortSignal.aborted ? "stop-aborted" : "stop-unaborted",
              channelId, runtimeId });
          },
        },
      });
    }
  },
};
`,
  );
}

async function prepareInstanceBindingTest(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
  channels?: boolean;
}) {
  const coordinator = installInstanceBindingProbeCoordinator(options);
  const plugin = await writeInstanceBindingProbePlugin();
  if (options?.channels) {
    await writeChannelBindingProbePlugin(plugin.bundledRoot);
  }
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = plugin.bundledRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
  }
  const config = {
    plugins: {
      enabled: true,
      allow: [
        "instance-binding-probe",
        ...(options?.channels ? ["instance-binding-channels"] : []),
      ],
      entries: {
        "instance-binding-probe": { enabled: true },
        ...(options?.channels ? { "instance-binding-channels": { enabled: true } } : {}),
      },
    },
  };
  const { loadPluginLookUpTable } = await import("../plugins/plugin-lookup-table.js");
  expect(loadPluginLookUpTable({ config, env: process.env }).startup.pluginIds).toContain(
    "instance-binding-probe",
  );
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
  return { coordinator, bundledRoot: plugin.bundledRoot };
}

async function patchInstanceBindingTestConfig(
  socket: Awaited<ReturnType<typeof connectWebchatClient>>,
) {
  const current = await rpcReq<{ hash?: string }>(socket, "config.get", {});
  expect(current.ok).toBe(true);
  expect(current.payload?.hash).toBeTypeOf("string");
  return await rpcReq(socket, "config.patch", {
    raw: JSON.stringify({
      plugins: {
        entries: {
          "instance-binding-probe": { subagent: { allowModelOverride: true } },
        },
      },
    }),
    baseHash: current.payload?.hash,
  });
}

describe("gateway plugin instance bindings", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  const sockets: Array<Awaited<ReturnType<typeof connectWebchatClient>>> = [];

  let channelProof: ChannelBindingProof | undefined;
  let channelEnv: ReturnType<typeof captureEnv> | undefined;
  let skippedBefore: { channels?: string; providers?: string } | undefined;

  afterEach(async () => {
    const closingSockets = sockets.splice(0);
    const socketClosures = closingSockets.map((socket) =>
      socket.readyState === socket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    let serversClosed = false;
    try {
      for (const socket of closingSockets) {
        socket.close();
      }
      for (const server of started.splice(0).toReversed()) {
        await server.close({ reason: "instance binding cleanup" });
      }
      serversClosed = true;
      await Promise.all(socketClosures);
    } finally {
      channelEnv?.restore();
      channelEnv = undefined;
      delete (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY];
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      if (channelProof) {
        const proof = channelProof;
        channelProof = undefined;
        const cleanup = {
          serversClosed,
          socketsClosed: closingSockets.every((socket) => socket.readyState === socket.CLOSED),
          monitorsStopped: proof.monitors.every(
            (monitor) => monitor.stopped && monitor.abortSignal.aborted,
          ),
          skipEnvRestored:
            process.env.OPENCLAW_SKIP_CHANNELS === skippedBefore?.channels &&
            process.env.OPENCLAW_SKIP_PROVIDERS === skippedBefore?.providers,
        };
        proof.events.push({ event: "cleanup" });
        console.info(
          "PROOF_126547_LEDGER:" +
            JSON.stringify({
              ...proof,
              monitors: proof.monitors.map(({ channelId, runtimeId, stopped, abortSignal }) => ({
                channelId,
                runtimeId,
                stopped,
                aborted: abortSignal.aborted,
              })),
              cleanup,
            }),
        );
        expect(cleanup).toEqual({
          serversClosed: true,
          socketsClosed: true,
          monitorsStopped: true,
          skipEnvRestored: true,
        });
      }
      skippedBefore = undefined;
    }
  });

  it(
    "keeps unscoped plugin work bound to each real Gateway across reverse shutdown",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();

      const first = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(first);
      await first.startupSettled;
      const sharedMetadata = getGatewayPluginMetadataSnapshot();
      expect(sharedMetadata).toBeDefined();

      await expect(
        startTestGatewayServer(await getFreePort(), {
          bind: "loopback",
          host: "0.0.0.0",
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway bind=loopback resolved to non-loopback host");
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      const firstRegistrationCount = coordinator.runtimes.length;
      expect(firstRegistrationCount).toBeGreaterThan(0);
      const { runtime: firstRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, firstRegistrationCount),
        "first",
      );

      const second = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(second);
      await second.startupSettled;
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);
      const { runtime: secondRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(firstRegistrationCount),
        "second",
      );

      const firstProbe = await requestInstanceBindingProbe(firstRuntime);
      const secondProbe = await requestInstanceBindingProbe(secondRuntime);
      expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
      expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
      expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await expect(
        secondRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });

      await second.close({ reason: "close last-started Gateway first" });
      started.pop();
      clearPluginMetadataLifecycleCaches();
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      await expect(requestInstanceBindingProbe(secondRuntime)).rejects.toThrow(
        "In-process gateway dispatch requires a gateway request scope or instance binding",
      );
      await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await first.close({ reason: "close final Gateway metadata owner" });
      started.pop();
      expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    },
  );

  it(
    "keeps startup metadata through hot reload and discovers manifest changes after Gateway restart",
    { timeout: 600_000 },
    async () => {
      const { coordinator, bundledRoot } = await prepareInstanceBindingTest();

      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      const startupMetadata = getGatewayPluginMetadataSnapshot();
      expect(startupMetadata?.byPluginId.get("instance-binding-probe")?.name).toBe(
        "Startup plugin",
      );
      const manifestPath = path.join(bundledRoot, "instance-binding-probe", "openclaw.plugin.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: "Changed plugin" }));
      const initialRegistrationCount = coordinator.runtimes.length;
      expect(initialRegistrationCount).toBeGreaterThan(0);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      const initialProbe = await requestInstanceBindingProbe(initialRuntime);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload.ok, reload.error?.message).toBe(true);
      await expect
        .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
        .toBeGreaterThan(initialRegistrationCount);
      const { runtime: reloadedRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(initialRegistrationCount),
        "hot-reloaded",
      );
      const reloadedProbe = await requestInstanceBindingProbe(reloadedRuntime);

      expect(reloadedProbe.registryId).not.toBe(initialProbe.registryId);
      expect(reloadedProbe.sessionsId).toBe(initialProbe.sessionsId);
      expect(reloadedProbe.placementId).toBe(initialProbe.placementId);
      expect(getGatewayPluginMetadataSnapshot()).toBe(startupMetadata);
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Startup plugin");
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        "In-process gateway dispatch requires a gateway request scope or instance binding",
      );
      await expect(
        reloadedRuntime.subagent.getSessionMessages({
          sessionKey: "agent:main:main",
          limit: 1,
        }),
      ).resolves.toEqual({ messages: [] });

      socket.close();
      sockets.splice(sockets.indexOf(socket), 1);
      await server.close({ reason: "plugin metadata restart" });
      started.splice(started.indexOf(server), 1);
      const restarted = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(restarted);
      await restarted.startupSettled;
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Changed plugin");
    },
  );

  it(
    "restarts every channel holding a retired runtime after unrelated plugin config reload",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest({ channels: true });
      const proof = coordinator.channelProof;
      if (!proof) {
        throw new Error("channel binding fixture was not installed");
      }
      channelProof = proof;
      skippedBefore = {
        channels: process.env.OPENCLAW_SKIP_CHANNELS,
        providers: process.env.OPENCLAW_SKIP_PROVIDERS,
      };
      channelEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
      delete process.env.OPENCLAW_SKIP_CHANNELS;
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      await expect.poll(() => proof.monitors.length, { timeout: 30_000 }).toBe(2);
      const initialMonitors = [...proof.monitors];
      expect(initialMonitors.map((monitor) => monitor.channelId).toSorted()).toEqual([
        ...CHANNEL_BINDING_IDS,
      ]);
      const initialProbes = await Promise.all(
        initialMonitors.map((monitor) => requestInstanceBindingProbe(monitor.runtime)),
      );
      expect(initialProbes[0]).toEqual(initialProbes[1]);
      expect(initialProbes[0].reloadSettled).toBe(true);
      proof.observations.push({ phase: "initial", probes: initialProbes });
      proof.events.push({ event: "initial-requests-succeeded" });
      const registrationsBeforeReload = coordinator.runtimes.length;
      const reloadEventIndex = proof.events.length;
      proof.events.push({ event: "reload-request" });
      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload.ok, reload.error?.message).toBe(true);
      await expect
        .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
        .toBeGreaterThan(registrationsBeforeReload);
      const { runtime: freshRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(registrationsBeforeReload),
        "reloaded",
      );
      await expect
        .poll(async () => (await requestInstanceBindingProbe(freshRuntime)).reloadSettled, {
          timeout: 30_000,
        })
        .toBe(true);
      const freshProbe = await requestInstanceBindingProbe(freshRuntime);
      expect(freshProbe.registryId).not.toBe(initialProbes[0].registryId);
      expect(freshProbe.sessionsId).toBe(initialProbes[0].sessionsId);
      expect(freshProbe.placementId).toBe(initialProbes[0].placementId);
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      proof.observations.push({ phase: "replacement", probe: freshProbe });
      proof.events.push({ event: "reload-settled" });
      for (const monitor of initialMonitors) {
        await expect(requestInstanceBindingProbe(monitor.runtime)).rejects.toThrow(
          "In-process gateway dispatch requires a gateway request scope or instance binding",
        );
        proof.observations.push({
          phase: "retired-binding-rejected",
          channelId: monitor.channelId,
          runtimeId: monitor.runtimeId,
        });
      }
      const predecessorsStopped = initialMonitors.every(
        (monitor) => monitor.stopped && monitor.abortSignal.aborted,
      );
      proof.observations.push({ phase: "successor-handoff", predecessorsStopped });
      // Starts hand off before their setImmediate callback; a retired live predecessor is
      // already a failure, while a completed predecessor permits waiting for its successor.
      if (predecessorsStopped) {
        await expect
          .poll(
            () =>
              proof.monitors
                .filter((monitor) => !monitor.stopped)
                .map((monitor) => monitor.channelId)
                .toSorted(),
            { timeout: 30_000 },
          )
          .toEqual([...CHANNEL_BINDING_IDS]);
      }
      const observations = await Promise.all(
        initialMonitors.map(async (initial) => {
          const active = proof.monitors.filter(
            (monitor) => monitor.channelId === initial.channelId && !monitor.stopped,
          );
          const monitor = active[0];
          const response = monitor
            ? await requestInstanceBindingProbe(monitor.runtime).then(
                (value) => ({ ok: true, registryId: value.registryId }),
                (error: unknown) => ({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
            : { ok: false, error: "no active channel monitor" };
          const events = proof.events.slice(reloadEventIndex);
          const stoppedAt = events.findIndex(
            (event) =>
              event.event === "stopped" &&
              event.channelId === initial.channelId &&
              event.runtimeId === initial.runtimeId,
          );
          const registrationStartedAt = events.findIndex((event) => event.event === "register");
          const registeredAt = events.findIndex(
            (event) =>
              event.event === "register" &&
              event.channelId === initial.channelId &&
              event.runtimeId === monitor?.runtimeId,
          );
          const startedAt = events.findIndex(
            (event) =>
              event.event === "start" &&
              event.channelId === initial.channelId &&
              event.runtimeId === monitor?.runtimeId,
          );
          return {
            channelId: initial.channelId,
            activeCount: active.length,
            oldStopped: initial.stopped && initial.abortSignal.aborted,
            freshRuntime: monitor !== undefined && monitor.runtime !== initial.runtime,
            stoppedBeforeRegistration: stoppedAt >= 0 && registrationStartedAt > stoppedAt,
            startedFromNewRegistration: registeredAt >= 0 && startedAt > registeredAt,
            response,
          };
        }),
      );
      proof.observations.push({ phase: "settled-channels", channels: observations });
      proof.events.push({ event: "channels-observed" });
      expect(
        observations,
        "settled plugin replacement must renew every retained channel runtime",
      ).toEqual(
        initialMonitors.map(({ channelId }) => ({
          channelId,
          activeCount: 1,
          oldStopped: true,
          freshRuntime: true,
          stoppedBeforeRegistration: true,
          startedFromNewRegistration: true,
          response: { ok: true, registryId: freshProbe.registryId },
        })),
      );
    },
  );

  it.each(["rejection", "timeout"] as const)(
    "keeps the active Gateway runtime when real plugin replacement cleanup fails by %s",
    { timeout: 600_000 },
    async (serviceStopFailure) => {
      const { coordinator } = await prepareInstanceBindingTest({ serviceStopFailure });
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const port = await getFreePort();
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;

      const initialRegistry = getActivePluginRegistry();
      const initialRuntimeConfig = getActiveSecretsRuntimeConfigSnapshot()?.config;
      const initialRegistrationCount = coordinator.runtimes.length;
      const initialHandler = initialRegistry?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD];
      expect(initialRegistry).toBeDefined();
      expect(initialRuntimeConfig).toBeDefined();
      expect(initialHandler).toBeTypeOf("function");
      expect(coordinator.serviceStarts).toBe(1);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload.ok, reload.error?.message).toBe(true);

      await expect.poll(() => hotReloadRecovery.mock.calls.length, { timeout: 30_000 }).toBe(1);
      expect(coordinator.serviceStops).toBe(1);
      expect(coordinator.serviceStarts).toBe(1);
      expect(coordinator.runtimes).toHaveLength(initialRegistrationCount);
      expect(getActiveSecretsRuntimeConfigSnapshot()?.config).toBe(initialRuntimeConfig);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD]).toBe(
        initialHandler,
      );
    },
  );
});
