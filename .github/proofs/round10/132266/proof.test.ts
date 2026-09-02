// Ephemeral proof overlay. All source observers call through to the real owners.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimeTools from "../../../src/agents/runtime-plan/tools.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../src/gateway/test-openai-responses-model.js";
import { onAgentEvent } from "../../../src/infra/agent-events.js";
import * as pluginTools from "../../../src/plugins/tools.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { readBody, writeSse } from "./providers/mock-openai/mock-openai-contracts.js";
import { MockResponseStream } from "./providers/mock-openai/mock-openai-stream.js";
import { buildMockFunctionCall } from "./providers/mock-openai/mock-openai-tooling.js";
import { waitForQaTransportAccountReady } from "./qa-transport.js";
import { renderQaMarkdownReport } from "./report.js";

const pluginId = "metadata-progress-proof";
const fixtureSymbol = Symbol.for("openclaw.proof132266.fixture");
const cases = [
  { id: "hidden-cold", tool: "metadata_hidden", hidden: true },
  { id: "hidden-reused", tool: "metadata_hidden", hidden: true },
  { id: "hidden-nonenumerable", tool: "metadata_nonenumerable", hidden: true },
  { id: "visible-omitted", tool: "metadata_visible", hidden: false },
  { id: "visible-false", tool: "metadata_false", hidden: false },
];
type FixtureState = {
  factories: number;
  executions: Array<{ name: string; callId: string; caseId: string }>;
};
type RunCase = { id: string; status: "pass" | "fail"; error?: string; acceptedMessage?: unknown };

// The plugin is a synthetic input. Loader, descriptor owner, normalizer, agent loop,
// channel admission, progress consumer, delivery, and HTTP bus are unmodified.
const fixtureSource = `
const state = globalThis[Symbol.for("openclaw.proof132266.fixture")];
module.exports = {
  id: "metadata-progress-proof",
  name: "Synthetic metadata progress proof",
  register(api) {
    api.registerTool(() => {
      state.factories++;
      return ["metadata_hidden", "metadata_nonenumerable", "metadata_visible", "metadata_false"].map(name => {
        const tool = {
          name, label: name, description: "Return one synthetic proof result.",
          parameters: {type: "object", properties: {caseId: {type: "string"}}, required: ["caseId"], additionalProperties: false},
          async execute(callId, args, signal, onUpdate) {
            signal?.throwIfAborted();
            state.executions.push({name, callId, caseId: args.caseId});
            onUpdate?.({content: [{type: "text", text: "working:" + args.caseId}], details: {status: "running"}});
            return {content: [{type: "text", text: "completed:" + args.caseId}], details: {ok: true}};
          }
        };
        if (name === "metadata_nonenumerable") Object.defineProperty(tool, "hideFromChannelProgress", {value: true});
        if (name === "metadata_hidden") tool.hideFromChannelProgress = true;
        if (name === "metadata_false") tool.hideFromChannelProgress = false;
        return tool;
      });
    }, {names: ["metadata_hidden", "metadata_nonenumerable", "metadata_visible", "metadata_false"]});
  }
};
`;

it("preserves hidden tool metadata through real Gateway QA-channel turns", async () => {
  const milestone = (phase: string) => process.stderr.write(`METADATA_PROOF_PHASE ${phase}\n`);
  milestone("test-entered");
  const outputDir = process.env.OPENCLAW_METADATA_PROOF_DIR;
  const bindingPath = process.env.OPENCLAW_METADATA_PROOF_BINDING;
  if (!outputDir || !bindingPath)
    throw new Error("Reviewed controller must supply output and source binding.");
  const binding = JSON.parse(await fs.readFile(bindingPath, "utf8"));
  const startedAt = new Date();
  const fixture: FixtureState = { factories: 0, executions: [] };
  Reflect.set(globalThis, fixtureSymbol, fixture);
  const resolverRows: Array<Record<string, unknown>> = [];
  const normalizationRows: Array<Record<string, unknown>> = [];
  const agentEvents: Array<Parameters<Parameters<typeof onAgentEvent>[0]>[0]> = [];
  const providerRequests: Array<Record<string, unknown>> = [];
  const results: RunCase[] = [];
  const cleanupErrors: string[] = [];
  const invariantErrors: string[] = [];
  const originalResolve = pluginTools.resolvePluginTools;
  const resolverObserver = vi
    .spyOn(pluginTools, "resolvePluginTools")
    .mockImplementation((params) => {
      const before = fixture.factories;
      const tools = originalResolve(params);
      const selected = tools.filter((tool) => tool.name.startsWith("metadata_"));
      if (selected.length)
        resolverRows.push({
          factoryBefore: before,
          factoryAfter: fixture.factories,
          tools: selected.map((tool) => ({
            name: tool.name,
            hidden: tool.hideFromChannelProgress === true,
          })),
        });
      return tools;
    });
  const originalNormalize = runtimeTools.normalizeAgentRuntimeTools;
  const normalizationObserver = vi
    .spyOn(runtimeTools, "normalizeAgentRuntimeTools")
    .mockImplementation((params) => {
      const normalized = originalNormalize(params);
      for (const source of params.tools.filter((tool) => tool.name.startsWith("metadata_"))) {
        const target = normalized.find((tool) => tool.name === source.name);
        normalizationRows.push({
          name: source.name,
          sourceHidden: source.hideFromChannelProgress === true,
          targetHidden: target?.hideFromChannelProgress === true,
          sourceEnumerable: Object.prototype.propertyIsEnumerable.call(
            source,
            "hideFromChannelProgress",
          ),
          cloned: source !== target,
        });
      }
      return normalized;
    });
  let unsubscribe = () => {};
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const busState = createQaBusState();
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  const calls = new Map<string, { callId: string; requests: number }>();
  const providerErrors: string[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      const body = JSON.parse(raw) as Record<string, unknown>;
      const marker = [...raw.matchAll(/PROOF132266:([a-z-]+)/g)].at(-1)?.[1];
      const scenario = cases.find((item) => item.id === marker);
      if (!scenario) throw new Error("Provider received an unrecognized synthetic request.");
      const prior = calls.get(scenario.id);
      const stream = new MockResponseStream(`resp-${scenario.id}-${prior ? "final" : "tool"}`);
      if (!prior) {
        const offered = JSON.stringify(body.tools ?? []);
        if (!offered.includes(scenario.tool))
          throw new Error(`Tool missing from provider request: ${scenario.tool}`);
        const call = buildMockFunctionCall(scenario.tool, { caseId: scenario.id });
        calls.set(scenario.id, { callId: call.item.call_id, requests: 1 });
        stream.tool(call.item);
      } else {
        prior.requests++;
        if (prior.requests !== 2)
          throw new Error(`Unexpected extra provider request: ${scenario.id}`);
        const input = Array.isArray(body.input) ? body.input : [];
        const result = input.find(
          (item) => item?.type === "function_call_output" && item.call_id === prior.callId,
        );
        if (!result || !JSON.stringify(result).includes(`completed:${scenario.id}`))
          throw new Error(`Matching tool result missing: ${scenario.id}`);
        stream.message({ id: `final-${scenario.id}`, text: `FINAL132266:${scenario.id}` });
      }
      providerRequests.push({ scenario: scenario.id, body });
      await writeSse(response, stream.complete(16), "responses");
    })().catch((error: unknown) => {
      providerErrors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end("synthetic provider fixture failed");
    });
  });
  try {
    state = await createOpenClawTestState({
      label: "metadata-progress-proof",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    milestone("state-ready");
    const fixtureDir = state.path("plugin");
    await fs.mkdir(fixtureDir);
    await fs.writeFile(path.join(fixtureDir, "index.cjs"), fixtureSource);
    await fs.writeFile(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({
        name: pluginId,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(
      path.join(fixtureDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        contracts: { tools: [...new Set(cases.map((item) => item.tool))] },
      }),
    );
    bus = await startQaBusServer({ state: busState });
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Provider did not bind.");
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "metadata-proof",
    );
    const token = "synthetic-metadata-proof-token";
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: {
        enabled: true,
        allow: ["qa-channel", pluginId],
        load: { paths: [path.resolve("extensions/qa-channel"), fixtureDir] },
        entries: { "qa-channel": { enabled: true }, [pluginId]: { enabled: true } },
        slots: { memory: "none" },
      },
      channels: { "qa-channel": { enabled: true, baseUrl: bus.baseUrl } },
      tools: { profile: "full", allow: [...new Set(cases.map((item) => item.tool))] },
      gateway: { auth: { mode: "token", token } },
    } satisfies OpenClawConfig;
    milestone("gateway-starting");
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    milestone("gateway-connected");
    unsubscribe = onAgentEvent((event) => agentEvents.push(structuredClone(event)));
    await waitForQaTransportAccountReady({
      accountId: "default",
      channel: "qa-channel",
      gateway: { call: (method, params, opts) => gateway!.client.request(method, params, opts) },
    });
    milestone("channel-ready");
    for (const scenario of cases) {
      const result: RunCase = { id: scenario.id, status: "fail" };
      try {
        const response = await fetch(`${bus.baseUrl}/v1/inbound/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: "default",
            conversation: { kind: "direct", id: "metadata-proof-peer" },
            senderId: "synthetic-user",
            text: `PROOF132266:${scenario.id} Call ${scenario.tool} once and finish with the returned result.`,
          }),
        });
        expect(response.status).toBe(200);
        await busState.waitFor({
          kind: "message-text",
          direction: "outbound",
          textIncludes: `FINAL132266:${scenario.id}`,
          timeoutMs: 30_000,
        });
        const final = busState
          .getSnapshot()
          .messages.filter(
            (message) =>
              !message.deleted &&
              message.direction === "outbound" &&
              message.text === `FINAL132266:${scenario.id}`,
          );
        expect(final).toHaveLength(1);
        result.acceptedMessage = final[0];
        const reported = final[0]!.toolCalls?.map((tool) => tool.name) ?? [];
        expect(reported).toEqual(scenario.hidden ? [] : [scenario.tool]);
        expect(calls.get(scenario.id)?.requests).toBe(2);
        const executed = fixture.executions.filter((item) => item.caseId === scenario.id);
        expect(executed).toHaveLength(1);
        const lifecycle = agentEvents.filter(
          (event) => event.stream === "tool" && event.data.toolCallId === executed[0]!.callId,
        );
        expect(lifecycle.map((event) => event.data.phase)).toEqual(
          expect.arrayContaining(["start", "update", "result"]),
        );
        expect(
          lifecycle.every(
            (event) => (event.data.hideFromChannelProgress === true) === scenario.hidden,
          ),
        ).toBe(true);
        const runId = lifecycle[0]!.runId;
        await expect
          .poll(
            () =>
              agentEvents.some(
                (event) =>
                  event.runId === runId &&
                  event.stream === "lifecycle" &&
                  event.data.phase === "end",
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
        expect(
          agentEvents.some(
            (event) =>
              event.runId === runId && event.stream === "lifecycle" && event.data.phase === "start",
          ),
        ).toBe(true);
        result.status = "pass";
      } catch (error) {
        result.error = String(error);
      }
      results.push(result);
      milestone(`${scenario.id}:${result.status}`);
    }
    try {
      expect(resolverRows.some((row) => Number(row.factoryAfter) > Number(row.factoryBefore))).toBe(
        true,
      );
      expect(resolverRows.some((row) => row.factoryAfter === row.factoryBefore)).toBe(true);
      // The localhost mock is an OpenAI-compatible proxy. Native-only strict
      // cloning is exercised separately; this route must retain its real policy.
      expect(normalizationRows.length).toBeGreaterThan(0);
      expect(normalizationRows.every((row) => row.sourceHidden === row.targetHidden)).toBe(true);
      expect(providerErrors).toEqual([]);
    } catch (error) {
      invariantErrors.push(String(error));
    }
  } catch (error) {
    invariantErrors.push(String(error));
  } finally {
    milestone("cleanup-starting");
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "metadata proof complete" });
      }
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    // QA bus shutdown clears its ephemeral store; retain accepted facts before close.
    const busSnapshot = busState.getSnapshot();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    try {
      await bus?.stop();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      await state?.cleanup();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    unsubscribe();
    resolverObserver.mockRestore();
    normalizationObserver.mockRestore();
    Reflect.deleteProperty(globalThis, fixtureSymbol);
    milestone("cleanup-finished");
    const verdict = {
      schema: "openclaw-pr-132266-gateway-progress-proof-v1",
      binding,
      status:
        results.length === 5 &&
        results.every((result) => result.status === "pass") &&
        !invariantErrors.length &&
        !cleanupErrors.length
          ? "pass"
          : "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      expectedScenarios: 5,
      executedScenarios: results.length,
      passedScenarios: results.filter((result) => result.status === "pass").length,
      results,
      resolverRows,
      normalizationRows,
      fixture,
      providerRequests,
      providerErrors,
      agentEvents,
      busSnapshot,
      invariantErrors,
      cleanupErrors,
      limitations: [
        "Synthetic QA-channel and mock OpenAI HTTP; no Telegram, real provider, or Codex process executed.",
        "Call-through observers record resolver/normalizer results; all dispatched values are the real production results.",
        "Precise descriptor-before-runtime-factory ordering and direct nonenumerable clone controls remain separately bound metadata harness evidence.",
      ],
    };
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, "verdict.json"),
      JSON.stringify(verdict, null, 2) + "\n",
    );
    await fs.writeFile(
      path.join(outputDir, "report.md"),
      renderQaMarkdownReport({
        title: "Tool visibility through Gateway QA-channel",
        startedAt,
        finishedAt: new Date(),
        scenarios: results.map((result) => ({
          name: result.id,
          status: result.status,
          details: result.error,
        })),
        notes: verdict.limitations,
      }),
    );
    expect(verdict).toMatchObject({
      status: "pass",
      executedScenarios: 5,
      passedScenarios: 5,
      invariantErrors: [],
      cleanupErrors: [],
    });
  }
}, 180_000);
