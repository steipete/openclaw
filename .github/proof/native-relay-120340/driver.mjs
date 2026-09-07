// Inert review draft. Run only in the approved secretless workflow, never locally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [source, proof, label, selection, countText] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.equal(process.versions.node, "24.20.0");
assert.ok(["auto", "general"].includes(selection));
const count = Number(countText);
assert.ok(count === 1 || count === 20);
assert.match(label, /^[a-z0-9-]+$/);
const artifacts = path.join(proof, "artifacts");
mkdirSync(artifacts, { recursive: true });
process.chdir(source);
const sdk = (name) =>
  import(pathToFileURL(path.join(source, "dist/plugin-sdk", `${name}.js`)).href);
const { registerNativeHookRelay } = await sdk("agent-harness-runtime");
const { initializeGlobalHookRunner } = await sdk("hook-runtime");
const { signalProcessTree } = await sdk("process-runtime");
const observations = {
  label,
  selection,
  count,
  callbacks: [],
  children: [],
  samples: [],
  complete: false,
};
const file = path.join(proof, "ordinary-read.txt");
writeFileSync(file, "benign relay proof\n");
const content = readFileSync(file, "utf8");
initializeGlobalHookRunner({
  plugins: [{ id: "relay-proof-observer", status: "loaded" }],
  hooks: [],
  typedHooks: [
    {
      pluginId: "relay-proof-observer",
      hookName: "after_tool_call",
      source: "synthetic owned relay proof",
      handler: (event, context) => {
        observations.callbacks.push({ event, context });
      },
    },
  ],
});
// No private retention, admission, assertion, policy or approval overrides.
const relay = registerNativeHookRelay({
  provider: "codex",
  sessionId: "relay-proof",
  runId: label,
  allowedEvents: ["post_tool_use"],
  ttlMs: 60_000,
  command: {
    nodeExecutable: process.execPath,
    timeoutMs: 5_000,
    ...(selection === "general" ? { executable: path.join(source, "openclaw.mjs") } : {}),
  },
});
const groups = new Set();
const active = new Map();
const joins = [];
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
let sampler;
let samplingError;
let stopped = false;
const started = performance.now();
function procSnapshot() {
  const rows = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const group = Number(fields[2]);
      if (!groups.has(group)) {
        continue;
      }
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      rows.push({
        pid: Number(name),
        group,
        state: fields[0],
        rssKiB: Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0),
      });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  return rows;
}
function sample() {
  try {
    const rows = procSnapshot();
    observations.samples.push({
      elapsedMs: performance.now() - started,
      processes: rows,
      aggregateRssKiB: rows.reduce((sum, row) => sum + row.rssKiB, 0),
    });
  } catch (error) {
    samplingError = error;
  }
}
function stopOwned() {
  stopped = true;
  for (const pid of active.keys()) {
    signalProcessTree(pid, "SIGTERM", { detached: true });
  }
}
const onSignal = () => stopOwned();
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
try {
  assert.equal(relay.shouldRelayEvent("post_tool_use"), true);
  const command = relay.commandForEvent("post_tool_use");
  assert.ok(command.startsWith("exec "));
  const expectedEntry =
    selection === "general" || !process.env.PROOF_EXPECT_DEDICATED
      ? path.join(source, "openclaw.mjs")
      : path.join(source, "dist/native-hook-relay/entry.js");
  assert.ok(command.includes(expectedEntry));
  observations.selectedEntrypoint = path.relative(source, expectedEntry);
  // The real owner generated all identifiers and locator arguments. Never log the command/token.
  eventLoop.enable();
  sampler = setInterval(sample, 20);
  for (let i = 0; i < count; i += 1) {
    const toolCallId = `${label}-${i}`;
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "read",
      tool_use_id: toolCallId,
      tool_input: { path: file },
      tool_response: content,
    };
    const begin = performance.now();
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: source,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const receipt = { toolCallId, payload, stdout: "", stderr: "", code: null, signal: null };
    observations.children.push(receipt);
    if (child.pid) {
      groups.add(child.pid);
      active.set(child.pid, child);
      receipt.pid = child.pid;
    }
    let outputBytes = 0;
    const collect = (key, bytes) => {
      const remaining = Math.max(0, 1024 * 1024 - outputBytes);
      if (remaining > 0) {
        receipt[key] += bytes.subarray(0, remaining).toString("utf8");
      }
      outputBytes += bytes.length;
      if (outputBytes > 1024 * 1024) {
        receipt.outputLimitExceeded = true;
        stopOwned();
      }
    };
    child.stdout.on("data", (bytes) => collect("stdout", bytes));
    child.stderr.on("data", (bytes) => collect("stderr", bytes));
    child.stdin.on("error", (error) => {
      receipt.stdinError = error.message;
    });
    child.on("error", (error) => {
      receipt.spawnError = error.message;
    });
    joins.push(
      new Promise((resolve) =>
        child.once("close", (code, signal) => {
          receipt.code = code;
          receipt.signal = signal;
          receipt.elapsedMs = performance.now() - begin;
          active.delete(child.pid);
          resolve();
        }),
      ),
    );
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  }
  const watchdog = setTimeout(stopOwned, 15_000);
  const killBackstop = setTimeout(() => {
    for (const pid of active.keys()) {
      signalProcessTree(pid, "SIGKILL", { detached: true });
    }
  }, 17_000);
  try {
    await Promise.all(joins);
  } finally {
    clearTimeout(watchdog);
    clearTimeout(killBackstop);
  }
  sample();
  assert.equal(stopped, false);
  assert.equal(samplingError, undefined);
  assert.equal(observations.callbacks.length, count);
  for (const child of observations.children) {
    assert.equal(child.code, 0);
    assert.equal(child.signal, null);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
    assert.equal(child.outputLimitExceeded, undefined);
    assert.equal(child.stdinError, undefined);
    assert.equal(child.spawnError, undefined);
    const matches = observations.callbacks.filter(
      ({ event }) => event.toolCallId === child.toolCallId,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].event.toolName, "read");
    assert.deepEqual(matches[0].event.params, { path: file });
    assert.equal(matches[0].event.result, content);
    assert.equal(matches[0].context.sessionId, "relay-proof");
    assert.equal(matches[0].context.runId, label);
  }
  observations.complete = true;
} catch (error) {
  observations.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  eventLoop.disable();
  observations.ownerEventLoopDelayMs = { mean: eventLoop.mean / 1e6, max: eventLoop.max / 1e6 };
  observations.sampledAggregatePeakRssKiB = Math.max(
    0,
    ...observations.samples.map((x) => x.aggregateRssKiB),
  );
  if (active.size > 0) {
    stopOwned();
    await delay(1_000);
    for (const pid of active.keys()) {
      signalProcessTree(pid, "SIGKILL", { detached: true });
    }
    await Promise.all(joins);
  }
  const leftover = procSnapshot();
  if (leftover.length > 0) {
    observations.leakedProcessesBeforeCleanup = leftover;
    observations.complete = false;
    process.exitCode = 1;
    for (const group of new Set(leftover.map((row) => row.group))) {
      signalProcessTree(group, "SIGTERM", { detached: true });
    }
    await delay(1_000);
    for (const group of new Set(procSnapshot().map((row) => row.group))) {
      signalProcessTree(group, "SIGKILL", { detached: true });
    }
    await delay(100);
  }
  relay.unregister();
  const deadline = performance.now() + 5_000;
  while (
    process.getActiveResourcesInfo().includes("TCPServerWrap") &&
    performance.now() < deadline
  ) {
    await delay(20);
  }
  observations.cleanup = {
    unregisterCalled: true,
    activeChildren: active.size,
    remainingOwnedProcesses: procSnapshot(),
    remainingTcpServers: process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap")
      .length,
  };
  if (
    observations.cleanup.activeChildren ||
    observations.cleanup.remainingOwnedProcesses.length ||
    observations.cleanup.remainingTcpServers
  ) {
    observations.complete = false;
    process.exitCode = 1;
  }
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  writeFileSync(
    path.join(artifacts, `${label}.json`),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}
