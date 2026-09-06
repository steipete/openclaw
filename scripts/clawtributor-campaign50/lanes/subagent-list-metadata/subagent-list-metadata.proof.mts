import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveSubagentRegistryToSqlite } from "../subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createSubagentsTool } from "./subagents-tool.js";

const [operation, stateDir, evidenceDir] = process.argv.slice(2);
assert(operation === "seed" || operation === "observe" || operation === "benchmark");
assert(stateDir && evidenceDir);
assert.equal(process.env.OPENCLAW_STATE_DIR, stateDir);
const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
const cfg: OpenClawConfig = { session: { store: storePath } };
const controller = "agent:main:metadata-controller";
const emptyController = "agent:main:metadata-empty";
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const primaryKey = `agent:main:subagent:${uuid(1)}`;
const secondaryKey = `agent:main:subagent:${uuid(2)}`;
const nestedKey = `agent:main:subagent:${uuid(3)}`;
const hiddenKey = `agent:main:subagent:${uuid(4)}`;
const unrelatedKey = (index: number) => `agent:main:subagent:${uuid(index + 100)}`;
const rowCount = 1000;
const skillsMarker = "UNRELATED_SKILLS_";
const reportMarker = "UNRELATED_REPORT_";
const primaryEntry: SessionEntry = {
  sessionId: uuid(1),
  updatedAt: 1,
  modelProvider: "demo-runtime",
  model: "runtime-model",
  providerOverride: "demo-override",
  modelOverride: "unused-override",
  inputTokens: 12,
  outputTokens: 1000,
  totalTokens: 197000,
  totalTokensFresh: true,
  totalTokensVersion: 1,
};

async function writeReport(name: string, value: unknown) {
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function expectedOutput(updated = false, caller = controller) {
  const empty = caller === emptyController;
  const model = updated ? "updated-model" : "runtime-model";
  const totalTokens = updated ? 198000 : 197000;
  return {
    status: "ok",
    action: "list",
    requesterSessionKey: caller,
    callerSessionKey: caller,
    callerIsSubagent: false,
    total: empty ? 0 : 2,
    taskTotal: 0,
    tasks: [],
    active: empty
      ? []
      : [
          {
            index: 1,
            runId: uuid(11),
            sessionKey: primaryKey,
            label: "Primary",
            task: "inspect metadata",
            status: "queued",
            pendingDescendants: 0,
            runtime: "n/a",
            runtimeMs: 0,
            model: `demo-runtime/${model}`,
            totalTokens,
          },
          {
            index: 2,
            runId: uuid(12),
            sessionKey: secondaryKey,
            label: "Secondary",
            task: "compare metadata",
            status: "active (waiting on 1 child)",
            pendingDescendants: 1,
            runtime: "1s",
            runtimeMs: 1000,
            childSessions: [nestedKey],
            model: "demo-override/override-model",
            totalTokens: 220,
          },
        ],
    recent: [],
    text: empty
      ? "active subagents:\n(none)\n\nrecent (last 30m):\n(none)"
      : `active subagents:\n1. Primary (${model}, n/a, tokens 1k (in 12 / out 1k), prompt/cache ${updated ? "198k" : "197k"}) queued - inspect metadata\n2. Secondary (override-model, 1s, tokens 220 (in 200 / out 20)) active (waiting on 1 child) - compare metadata\n\nrecent (last 30m):\n(none)`,
  };
}

if (operation === "seed") {
  const now = Date.now();
  replaceSessionEntrySync(
    { storePath, sessionKey: controller },
    { sessionId: uuid(20), updatedAt: 1 },
  );
  replaceSessionEntrySync({ storePath, sessionKey: primaryKey }, primaryEntry);
  replaceSessionEntrySync(
    { storePath, sessionKey: secondaryKey },
    {
      sessionId: uuid(2),
      updatedAt: 1,
      providerOverride: "demo-override",
      modelOverride: "override-model",
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 9999,
      totalTokensFresh: false,
      totalTokensVersion: 1,
    },
  );
  for (let index = 0; index < rowCount; index++) {
    replaceSessionEntrySync(
      { storePath, sessionKey: unrelatedKey(index) },
      {
        sessionId: uuid(index + 100),
        updatedAt: 1,
        skillsSnapshot: { prompt: `${skillsMarker}${index}_${"x".repeat(8192)}`, skills: [] },
        systemPromptReport: {
          source: "run",
          generatedAt: 1,
          workspaceDir: `/fixture/${reportMarker}${index}`,
          systemPrompt: { chars: 8192, projectContextChars: 0, nonProjectContextChars: 8192 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 8192, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      },
    );
  }
  const common = {
    requesterAgentId: "main",
    requesterDisplayKey: "metadata-controller",
    cleanup: "keep",
    completion: { required: false },
    delivery: { status: "not_required" },
  } as const;
  const runs: SubagentRunRecord[] = [
    {
      ...common,
      runId: uuid(11),
      childSessionKey: primaryKey,
      requesterSessionKey: controller,
      task: "inspect metadata",
      label: "Primary",
      createdAt: now,
      execution: { status: "queued" },
    },
    {
      ...common,
      runId: uuid(12),
      childSessionKey: secondaryKey,
      requesterSessionKey: controller,
      task: "compare metadata",
      label: "Secondary",
      createdAt: now - 1,
      accumulatedRuntimeMs: 1000,
      execution: { status: "running" },
    },
    {
      ...common,
      runId: uuid(13),
      childSessionKey: nestedKey,
      requesterSessionKey: secondaryKey,
      task: "completed nested work",
      createdAt: now - 4,
      execution: {
        status: "terminal",
        startedAt: now - 4,
        endedAt: now - 3,
        outcome: { status: "ok" },
      },
    },
    {
      ...common,
      runId: uuid(14),
      childSessionKey: hiddenKey,
      requesterSessionKey: "agent:main:other-controller",
      task: "unrelated work",
      label: "Hidden",
      createdAt: now - 2,
      execution: { status: "queued" },
    },
  ];
  saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
  await writeReport("seed.json", {
    proof: "subagent-metadata-seed",
    rowCount,
    skillsBytesPerRow: 8192,
    runs: runs.length,
  });
} else {
  const tool = createSubagentsTool({ config: cfg, agentSessionKey: controller, agentId: "main" });
  const emptyTool = createSubagentsTool({
    config: cfg,
    agentSessionKey: emptyController,
    agentId: "main",
  });
  const output = async (params: { action?: "list" }, updated = false, empty = false) => {
    const result = await (empty ? emptyTool : tool).execute("metadata-proof", params);
    const value: unknown = JSON.parse(JSON.stringify(result.details));
    assert.deepEqual(
      value,
      expectedOutput(updated, empty ? emptyController : controller),
      "SUBAGENT_LIST_OUTPUT_MISMATCH",
    );
    return value;
  };
  if (operation === "observe") {
    const originalParse = JSON.parse;
    const counts = { skills: 0, reports: 0 };
    JSON.parse = (value, reviver) => {
      if (typeof value === "string") {
        if (value.includes(skillsMarker)) counts.skills++;
        if (value.includes(reportMarker)) counts.reports++;
      }
      return originalParse(value, reviver);
    };
    const observations: Array<{ label: string; skills: number; reports: number; output: unknown }> =
      [];
    const observe = async (label: string, call: () => Promise<unknown>) => {
      const before = { ...counts };
      const result = await call();
      observations.push({
        label,
        skills: counts.skills - before.skills,
        reports: counts.reports - before.reports,
        output: result,
      });
    };
    try {
      await observe("first-list", () => output({ action: "list" }));
      await observe("warm-default-list", () => output({}));
      await observe("empty-controller", () => output({ action: "list" }, false, true));
      const beforeFull = { ...counts };
      const full = loadSessionEntryReadOnly({ storePath, sessionKey: unrelatedKey(0) });
      assert.equal(full?.skillsSnapshot?.prompt, `${skillsMarker}0_${"x".repeat(8192)}`);
      assert.equal(full?.systemPromptReport?.workspaceDir, `/fixture/${reportMarker}0`);
      const fullRead = {
        skills: counts.skills - beforeFull.skills,
        reports: counts.reports - beforeFull.reports,
      };
      assert(fullRead.skills > 0 && fullRead.reports > 0, "FULL_READ_OBSERVER_CONTROL_MISSING");
      replaceSessionEntrySync(
        { storePath, sessionKey: primaryKey },
        {
          ...primaryEntry,
          updatedAt: 2,
          model: "updated-model",
          totalTokens: 198000,
        },
      );
      await observe("after-writer-update", () => output({ action: "list" }, true));
      await writeReport("observations.json", {
        proof: "real-subagents-tool-sqlite-metadata",
        rowCount,
        observations,
        fullRead,
      });
    } finally {
      JSON.parse = originalParse;
    }
    assert.equal(
      observations.reduce(
        (total, observation) => total + observation.skills + observation.reports,
        0,
      ),
      0,
      "SUBAGENT_LIST_DECODED_UNRELATED_PROMPTS",
    );
  } else {
    const rssBefore = process.memoryUsage().rss;
    const firstStart = performance.now();
    const first = await tool.execute("metadata-proof", { action: "list" });
    const firstSeconds = (performance.now() - firstStart) / 1000;
    assert.deepEqual(JSON.parse(JSON.stringify(first.details)), expectedOutput());
    const rssAfterFirst = process.memoryUsage().rss;
    const warmStart = performance.now();
    let callSeconds = 0;
    for (let index = 0; index < 25; index++) {
      const start = performance.now();
      const result = await tool.execute("metadata-proof", { action: "list" });
      callSeconds += (performance.now() - start) / 1000;
      assert.deepEqual(JSON.parse(JSON.stringify(result.details)), expectedOutput());
    }
    await writeReport("measurements.json", {
      proof: "uninstrumented-subagents-tool-sqlite-metadata",
      rowCount,
      firstSeconds,
      warm: { calls: 25, callSeconds, wallSeconds: (performance.now() - warmStart) / 1000 },
      rssBefore,
      rssAfterFirst,
      rssAfterWarm: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS,
      timingThreshold: null,
    });
  }
}
