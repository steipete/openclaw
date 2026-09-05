import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The runner supplies the checkout; imports execute its actual bridge and registry.
const repo = resolve(process.argv[2] ?? ".");
const stateDir = await realpath(await mkdtemp(join(tmpdir(), "collector-wait-proof-")));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = join(stateDir, "openclaw.json");
const load = (relative) => import(pathToFileURL(join(repo, relative)).href);
const observations = {};
let cleanRegistry = () => {};
try {
  const { codeModeSwarmHandlers } = await load("src/agents/code-mode-swarm.runtime.ts");
  const { subagentRuns } = await load("src/agents/subagents/registry/subagent-registry-memory.ts");
  const { persistSubagentRunsToDiskOrThrow } = await load(
    "src/agents/subagents/registry/subagent-registry-state.ts",
  );
  const { createAgentsWaitTool } = await load("src/agents/tools/agents-wait-tool.ts");
  cleanRegistry = () => subagentRuns.clear();
  const sessionKey = "agent:main:main";
  const config = { tools: { swarm: true } };
  const ctx = { sessionKey, agentId: "main", config, runtimeConfig: config };
  function seed(runId, done = true, owner = sessionKey) {
    const entry = {
      runId,
      childSessionKey: `agent:worker:subagent:${runId}`,
      controllerSessionKey: owner,
      requesterSessionKey: owner,
      requesterDisplayKey: owner,
      task: "Synthetic collector cancellation proof",
      cleanup: "keep",
      createdAt: Date.now(),
      collect: true,
      swarmRequesterSessionKey: owner,
      groupId: "proof-group",
      execution: { status: done ? "terminal" : "running" },
      completion: { required: false, resultText: done ? "synthetic completion" : undefined },
      delivery: { status: "not_required" },
      ...(done ? { collectorCompletion: { status: "done" } } : {}),
    };
    subagentRuns.set(runId, entry);
    return entry;
  }
  function wait(runId, signal) {
    return codeModeSwarmHandlers.agentWait({
      request: { id: `proof:${runId}`, method: "agentWait", args: [runId] },
      ctx,
      signal,
    });
  }
  const completed = seed("completed");
  const active = await wait(completed.runId);
  assert.equal(active.result, "synthetic completion");
  observations.activeCompleted = "returned completion";

  const cancelled = new AbortController();
  cancelled.abort();
  observations.preAbortedCompleted = await wait(completed.runId, cancelled.signal).then(
    (value) => ({ status: "resolved", result: value.result }),
    (error) => ({ status: "rejected", message: error.message }),
  );
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);

  const pending = seed("pending-abort", false);
  const during = new AbortController();
  const parked = wait(pending.runId, during.signal);
  assert.equal(getEventListeners(during.signal, "abort").length, 1);
  const rejection = assert.rejects(parked, /agents\.run wait aborted\./);
  during.abort();
  await rejection;
  assert.equal(getEventListeners(during.signal, "abort").length, 0);
  observations.parkedAbort = "rejected and removed abort listener";

  const event = seed("event-completion", false);
  const eventController = new AbortController();
  const awaitingEvent = wait(event.runId, eventController.signal);
  assert.equal(getEventListeners(eventController.signal, "abort").length, 1);
  event.execution = { status: "terminal" };
  event.completion = { required: false, resultText: "persisted event result" };
  event.collectorCompletion = { status: "done" };
  persistSubagentRunsToDiskOrThrow(subagentRuns, [event.runId]);
  assert.equal((await awaitingEvent).result, "persisted event result");
  assert.equal(getEventListeners(eventController.signal, "abort").length, 0);
  observations.persistedCompletion = "registry write settled parked bridge";

  const foreign = seed("foreign", true, "agent:other:main");
  await assert.rejects(wait(foreign.runId), /agents\.run not_owner/);
  observations.foreignOwner = "rejected";
  const tool = createAgentsWaitTool({ agentSessionKey: sessionKey, agentId: "main", config });
  await assert.rejects(
    tool.execute("proof-poll", { ids: [completed.runId], timeoutSeconds: 0 }, cancelled.signal),
    /agents_wait aborted/,
  );
  observations.pollingSibling = "rejected pre-aborted completion";

  console.log("COLLECTOR_WAIT_PROOF " + JSON.stringify(observations));
  assert.deepEqual(
    observations.preAbortedCompleted,
    {
      status: "rejected",
      message: "agents.run wait aborted.",
    },
    "COLLECTOR_CANCELLATION_PRECEDENCE",
  );
} finally {
  cleanRegistry();
  await rm(stateDir, { recursive: true, force: true });
}
