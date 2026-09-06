import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  wireMessageText,
  type PairedNodeWorkerHost,
  type PublishedWireWorkspace,
  type WireGateway,
  type WireNodeRead,
} from "./paired-node-worker-wire-fixture.js";

const MARKER = "GLOBAL-WORKER-OWNER-139216";
const KEY = "global";
const AGENT = "qa";

type RunResult = { runId?: string; status?: string; summary?: string };
type History = { messages?: Array<{ role?: string; content?: unknown }> };

it(
  "attaches a global session to its existing agent and persists a real worker turn",
  {
    timeout: PROOF_TIMEOUT_MS + 180_000,
  },
  async () => {
    const evidenceDir = process.env.OPENCLAW_WORKER_OWNER_PROOF_DIR;
    if (!evidenceDir) {
      throw new Error("OPENCLAW_WORKER_OWNER_PROOF_DIR is required");
    }
    await fs.mkdir(evidenceDir, { recursive: true });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-global-worker-owner-"));
    const gatewayOwner = createQaGatewayChild();
    let gateway: WireGateway | undefined;
    let operator: GatewayClient | undefined;
    let worker: PairedNodeWorkerHost | undefined;
    let published: PublishedWireWorkspace | undefined;
    let provider: Awaited<ReturnType<typeof startPairedNodeWorkerLifecycleProvider>> | undefined;
    let phase = "setup";
    const observed: Record<string, unknown> = { agentId: AGENT, sessionKey: KEY };
    const failures: unknown[] = [];
    try {
      provider = await startPairedNodeWorkerLifecycleProvider([]);
      published = await createPublishedWireWorkspace(root);
      gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        useRepoCli: true,
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (config) => ({
          ...config,
          agents: {
            ...config.agents,
            ownership: "explicit",
            entries: { main: {}, ...config.agents?.entries },
          },
          session: { ...config.session, scope: "global" },
          nodeHost: { ...config.nodeHost, workerRuns: { enabled: true } },
        }),
      });
      operator = await connectWireClient({ gateway, role: "operator", identity: null });
      worker = await createPairedNodeWorkerHost({ gateway, operator, root, capacity: 1 });
      const nodes = await operator.request<{ nodes?: WireNodeRead[] }>("node.list", {});
      const pairedNode = nodes.nodes?.find((node) => node.nodeId === worker.identity.deviceId);
      observed.nodeReady = {
        approvalState: pairedNode?.approvalState,
        connected: pairedNode?.connected,
        paired: pairedNode?.paired,
        sessionHost: pairedNode?.sessionHost,
      };
      expect(observed.nodeReady).toEqual({
        approvalState: "approved",
        connected: true,
        paired: true,
        sessionHost: true,
      });
      phase = "create";
      const created = await operator.request<{ key?: string; sessionId?: string }>(
        "sessions.create",
        {
          key: KEY,
          agentId: AGENT,
          worktree: true,
          worktreeName: "global-worker-owner",
          worktreeBaseRef: "main",
          cwd: published.source,
        },
      );
      observed.created = { key: created.key, sessionId: created.sessionId };
      expect(created).toMatchObject({ key: KEY });
      expect(created.sessionId).toBeTruthy();
      phase = "local-control";
      const local = await operator.request<RunResult>("chat.send", {
        sessionKey: KEY,
        agentId: AGENT,
        message: "Reply exactly: GLOBAL-LOCAL-CONTROL",
        deliver: false,
        idempotencyKey: "global-local-control-139216",
      });
      expect(local).toMatchObject({ status: "started" });
      const localTerminal = await operator.request<RunResult>(
        "agent.wait",
        {
          runId: local.runId,
          timeoutMs: PROOF_TIMEOUT_MS,
        },
        { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
      );
      observed.localControlStatus = localTerminal.status;
      expect(localTerminal.status).toBe("ok");
      phase = "dispatch";
      let dispatched: { placement?: { state?: string } } | undefined;
      try {
        dispatched = await operator.request<{ placement?: { state?: string } }>(
          "sessions.dispatch",
          { key: KEY, agentId: AGENT, deviceId: worker.identity.deviceId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
      } catch (error) {
        observed.dispatchError = error instanceof Error ? error.message : String(error);
      }
      expect(observed.dispatchError, "WORKER_GLOBAL_ATTACHMENT_139216").toBeUndefined();
      observed.placementState = dispatched?.placement?.state;
      expect(dispatched?.placement).toMatchObject({ state: "active" });
      phase = "turn";
      const started = await operator.request<RunResult>("chat.send", {
        sessionKey: KEY,
        agentId: AGENT,
        message: `Reply exactly: ${MARKER}`,
        deliver: false,
        idempotencyKey: "global-worker-owner-139216",
      });
      expect(started).toMatchObject({ status: "started" });
      expect(started.runId).toBeTruthy();
      const terminal = await operator.request<RunResult>(
        "agent.wait",
        {
          runId: started.runId,
          timeoutMs: PROOF_TIMEOUT_MS,
        },
        { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
      );
      observed.terminal = { status: terminal.status, summary: terminal.summary };
      observed.workerLaunches = worker.commands.filter(
        (command) => command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      ).length;
      expect(observed.workerLaunches).toBeGreaterThan(0);
      expect(terminal.status, "WORKER_GLOBAL_OWNER_139216").toBe("ok");
      phase = "history";
      const history = await operator.request<History>("chat.history", {
        sessionKey: KEY,
        agentId: AGENT,
        limit: 100,
      });
      const matchingMessages = (history.messages ?? []).filter(
        (message) => message.role === "assistant" && wireMessageText(message).includes(MARKER),
      );
      observed.ownerAssistantMessages = matchingMessages.length;
      expect(matchingMessages).toHaveLength(1);
      const other = await operator.request<History>("chat.history", {
        sessionKey: KEY,
        agentId: "main",
        limit: 100,
      });
      observed.otherAgentHasMarker = (other.messages ?? []).some((message) =>
        wireMessageText(message).includes(MARKER),
      );
      expect(observed.otherAgentHasMarker).toBe(false);
      await worker.waitForWorkersIdle();
      expect(worker.invokeErrors).toEqual([]);
      phase = "passed";
    } catch (error) {
      failures.push(error);
    } finally {
      if (gateway) {
        await fs.writeFile(path.join(evidenceDir, "gateway.log"), gateway.logs());
      }
      let cleanupFailureCount = 0;
      // Drain the real worker before shutting down the Gateway that owns its RPCs.
      for (const cleanup of [
        () => worker?.stop(),
        () => operator?.stopAndWait({ timeoutMs: 2_000 }),
        () => stopQaGatewayFixture(gatewayOwner),
        () => provider?.stop(),
        () => published && closeWireServer(published.server),
        () => fs.rm(root, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupFailureCount += 1;
          failures.push(error);
        }
      }
      await fs.writeFile(
        path.join(evidenceDir, "observed.json"),
        `${JSON.stringify({ phase, ...observed, cleanupFailureCount }, null, 2)}\n`,
      );
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "global worker owner proof failed");
    }
  },
);
