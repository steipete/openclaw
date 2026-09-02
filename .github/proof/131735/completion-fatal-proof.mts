// Standalone process-boundary proof. Execute only in the approved proof environment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [rootArg, manifestArg, mode, homeArg] = process.argv.slice(2);
assert(rootArg && manifestArg && homeArg && (mode === "grace-error" || mode === "awaited"));
const root = path.resolve(rootArg);
const manifest = JSON.parse(await readFile(manifestArg, "utf8")) as {
  head: string;
  files: Record<string, string>;
};
assert.match(manifest.head, /^[a-f0-9]{40}$/);
const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(head, manifest.head);
for (const required of [
  "src/agents/subagents/registry/subagent-registry-completion-runtime.ts",
  "src/agents/subagents/registry/subagent-registry-pending-lifecycle.ts",
  "src/agents/subagents/registry/subagent-lifecycle-events.ts",
  "src/agents/agent-run-terminal-outcome.ts",
  "src/process/gateway-work-admission.ts",
  "src/infra/unhandled-rejections.ts",
  "scripts/tsx.mjs",
  "pnpm-lock.yaml",
]) assert.match(manifest.files[required], /^[a-f0-9]{64}$/);
async function verifySources() {
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert(!path.isAbsolute(file) && !file.split("/").includes(".."));
    const actual = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
    assert.equal(actual, expected, `source changed: ${file}`);
  }
}
await verifySources();
assert.equal(process.env.HOME, homeArg);
assert.equal(process.env.OPENCLAW_HOME, homeArg);
assert.equal(process.env.OPENCLAW_STATE_DIR, path.join(homeArg, "state"));
assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.VITEST, undefined);
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const { installUnhandledRejectionHandler } = await load("src/infra/unhandled-rejections.ts");
const { createSubagentRegistryCompletionRuntime } = await load(
  "src/agents/subagents/registry/subagent-registry-completion-runtime.ts",
);
const { getActiveGatewayRootWorkCount } = await load("src/process/gateway-work-admission.ts");
const { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } = await load("src/agents/agent-run-terminal-outcome.ts");
const { SUBAGENT_ENDED_REASON_ERROR } = await load(
  "src/agents/subagents/registry/subagent-lifecycle-events.ts",
);
installUnhandledRejectionHandler();
const events: string[] = [];
const record = (event: string) => {
  events.push(event);
  writeSync(1, `PROOF_EVENT ${JSON.stringify({ event })}\n`);
};
const entry = {
  runId: "proof-completion", generation: 1,
  childSessionKey: "agent:main:subagent:proof-completion",
  requesterSessionKey: "agent:main:main", requesterDisplayKey: "main",
  task: "synthetic completion", cleanup: "keep", createdAt: Date.now(),
  execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "error", error: "failed" } },
  cleanupHandled: true,
};
const runs = new Map([[entry.runId, entry]]);
const resumed = new Set([entry.runId]);
const retryTimers = new Set<ReturnType<typeof setTimeout>>();
const resumeError = new Error("synthetic completion resume failure");
let attempts = 0;
const warning = Promise.withResolvers<void>();
const runtime = createSubagentRegistryCompletionRuntime({
  runs, resumed, retryTimers,
  completeSubagentRun: async () => {
    record(`completion-attempt-${++attempts}`);
    throw new Error("synthetic completion operation failure");
  },
  scheduleSweep: () => { throw new Error("unexpected running-row fallback"); },
  resumeRun: () => { record("resume-failed"); throw resumeError; },
  warn: (message: string, meta?: Record<string, unknown>) => {
    if (message !== "failed to complete subagent run in background") return;
    assert.equal(meta?.error, resumeError);
    assert.equal(meta?.source, "lifecycle-error-grace");
    record("background-warning");
    warning.resolve();
  },
});
const watchdog = setTimeout(() => {
  writeSync(2, "PROOF_TIMEOUT: expected terminal evidence was not observed\n");
  process.exit(2);
}, AGENT_RUN_TERMINAL_RETRY_GRACE_MS + 5_000);
try {
  if (mode === "grace-error") {
    record("grace-scheduled");
    runtime.pendingLifecycle.scheduleError({ runId: entry.runId, endedAt: entry.execution.endedAt, error: "failed" });
    await warning.promise;
    assert.deepEqual(events, ["grace-scheduled", "completion-attempt-1", "completion-attempt-2", "resume-failed", "background-warning"]);
  } else {
    await assert.rejects(runtime.completeSubagentRunWithRecovery({
      runId: entry.runId, expectedEntry: entry, endedAt: entry.execution.endedAt,
      outcome: { status: "error", error: "failed" }, reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: true,
    }, "subagent-wait"), (error: unknown) => error === resumeError);
    record("awaited-rejection-observed");
    assert.deepEqual(events, ["completion-attempt-1", "completion-attempt-2", "resume-failed", "awaited-rejection-observed"]);
  }
  await nextTurn();
  assert.equal(attempts, 2);
  assert.equal(runs.get(entry.runId), entry);
  assert.equal(entry.cleanupHandled, false);
  assert.equal(resumed.has(entry.runId), false);
  assert.equal(retryTimers.size, 0);
  assert.equal(getActiveGatewayRootWorkCount(), 0);
  await verifySources();
  writeSync(1, `PROOF_VERDICT ${JSON.stringify({ head, node: process.version, mode, events, alive: true, attempts, admissionRoots: 0, retryTimers: 0, rowRetained: true })}\n`);
} finally {
  clearTimeout(watchdog);
  runtime.pendingLifecycle.clearAll();
}
