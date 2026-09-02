// Ephemeral Node/tsx proof overlay. Production owners are imported without mocks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../src/gateway/test-openai-responses-model.js";
import { onAgentEvent } from "../../../src/infra/agent-events.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { readBody, writeSse } from "./providers/mock-openai/mock-openai-contracts.js";
import { MockResponseStream } from "./providers/mock-openai/mock-openai-stream.js";
import { buildMockFunctionCall } from "./providers/mock-openai/mock-openai-tooling.js";
import { waitForQaTransportAccountReady, waitForQaTransportCondition } from "./qa-transport.js";
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

async function main() {
  const milestone = (phase: string) => process.stderr.write(`METADATA_PROOF_PHASE ${phase}\n`);
  milestone("node-harness-entered");
  const outputDir = process.env.OPENCLAW_METADATA_PROOF_DIR;
  const bindingPath = process.env.OPENCLAW_METADATA_PROOF_BINDING;
  if (!outputDir || !bindingPath)
    throw new Error("Reviewed controller must supply output and source binding.");
  const binding = JSON.parse(await fs.readFile(bindingPath, "utf8"));
  // The controller accepts this same-head phase before starting the Gateway process.
  const metadataBytes = await fs.readFile(path.join(path.dirname(bindingPath), "metadata-verdict.json"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  assert.equal(metadata.mode, "candidate");
  assert.equal(metadata.factories, 3);
  assert.equal(metadata.executions, 6);
  assert.equal(metadata.rows.length, 6);
  assert.deepEqual(metadata.rows.map((row: { label: string }) => row.label), binding.metadataScenarioIds);
  const ownerBoundaryEvidence = {
    kind: "same-head-metadata-phase",
    head: binding.head,
    harnessSHA256: binding.metadataHarnessSHA256,
    verdictSHA256: createHash("sha256").update(metadataBytes).digest("hex"),
    scenarios: binding.metadataScenarioIds,
  };
  const startedAt = new Date();
  const fixture: FixtureState = { factories: 0, executions: [] };
  Reflect.set(globalThis, fixtureSymbol, fixture);
  const agentEvents: Array<Parameters<Parameters<typeof onAgentEvent>[0]>[0]> = [];
  const providerRequests: Array<Record<string, unknown>> = [];
  const results: RunCase[] = [];
  const cleanupErrors: string[] = [];
  const invariantErrors: string[] = [];
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
        OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_DIAGNOSTICS: "timeline",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path.join(outputDir, "startup-timeline.jsonl"),
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
        assert.equal(response.status, 200);
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
        assert.equal(final.length, 1);
        result.acceptedMessage = final[0];
        const reported = final[0]!.toolCalls?.map((tool) => tool.name) ?? [];
        assert.deepEqual(reported, scenario.hidden ? [] : [scenario.tool]);
        assert.equal(calls.get(scenario.id)?.requests, 2);
        const executed = fixture.executions.filter((item) => item.caseId === scenario.id);
        assert.equal(executed.length, 1);
        const lifecycle = agentEvents.filter(
          (event) => event.stream === "tool" && event.data.toolCallId === executed[0]!.callId,
        );
        const toolPhases = lifecycle.map((event) => event.data.phase);
        assert.ok(["start", "update", "result"].every((phase) => toolPhases.includes(phase)));
        assert.ok(lifecycle.every(
          (event) => (event.data.hideFromChannelProgress === true) === scenario.hidden,
        ));
        const runId = lifecycle[0]!.runId;
        await waitForQaTransportCondition(
          () => agentEvents.some(
            (event) => event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end",
          ) ? true : undefined,
          5_000,
        );
        assert.ok(agentEvents.some(
          (event) => event.runId === runId && event.stream === "lifecycle" && event.data.phase === "start",
        ));
        result.status = "pass";
      } catch (error) {
        result.error = String(error);
      }
      results.push(result);
      milestone(`${scenario.id}:${result.status}`);
    }
    try {
      // Factory counts are diagnostic; cached execute wrappers can invoke the factory.
      // Exact cache-hit and normalization claims belong to the separately bound phase.
      assert.ok(fixture.factories > 0);
      assert.equal(fixture.executions.length, 5);
      assert.deepEqual(providerErrors, []);
    } catch (error) {
      invariantErrors.push(String(error));
    }
  } catch (error) {
    invariantErrors.push(String(error));
  } finally {
    milestone("cleanup-starting");
    if (gateway) {
      for (const close of [
        () => disconnectGatewayClient(gateway!.client),
        () => gateway!.server.close({ reason: "metadata proof complete" }),
      ]) {
        try { await close(); } catch (error) { cleanupErrors.push(String(error)); }
      }
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
    Reflect.deleteProperty(globalThis, fixtureSymbol);
    milestone("cleanup-finished");
    const verdict = {
      schema: "openclaw-pr-132266-gateway-progress-proof-v2",
      runtime: "node/tsx",
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
      ownerBoundaryEvidence,
      fixture,
      providerRequests,
      providerErrors,
      agentEvents,
      busSnapshot,
      invariantErrors,
      cleanupErrors,
      limitations: [
        "Synthetic QA-channel and mock OpenAI HTTP; no Telegram, real provider, or Codex process executed.",
        "No module mocks or runtime spies. Gateway scenarios prove downstream tool-event metadata and accepted channel visibility.",
        "Exact descriptor cache cold/hit and normalizer clone invariants are mandatory in the same-head six-case metadata phase; Gateway factory totals alone do not prove a cache hit.",
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
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.executedScenarios, 5);
    assert.equal(verdict.passedScenarios, 5);
    assert.deepEqual(verdict.invariantErrors, []);
    assert.deepEqual(verdict.cleanupErrors, []);
  }
}

await main();
