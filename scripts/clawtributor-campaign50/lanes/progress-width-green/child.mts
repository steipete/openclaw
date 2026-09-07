import assert from "node:assert/strict";
import { once } from "node:events";
import { closeSync, read, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [target, encoded, receiptPath] = process.argv.slice(2);
const cell = JSON.parse(encoded);
const readyFd = Number(process.env.PROOF_READY_FD);
assert.ok(Number.isSafeInteger(readyFd) && readyFd > 2);
assert.equal(process.stdin.isTTY, true);
assert.equal(process.stderr.isTTY, true);
assert.equal(process.stderr.columns, cell.columns);
assert.equal(process.stdin.isRaw === true, false);
for (const name of ["VITEST", "NODE_ENV", "CI"]) assert.equal(process.env[name], undefined);
const progress = await import(pathToFileURL(`${target}/src/cli/progress.ts`).href);
const wizard = await import(pathToFileURL(`${target}/src/wizard/clack-prompter.ts`).href);
const label = cell.label ?? "Checking channel status (probe)…";
const updatedLabel = cell.label
  ? label.replace("Scanning", "Checking")
  : "Checking channel status (ready)…";
const events = ["uncaughtExceptionMonitor", "unhandledRejection", "SIGINT", "SIGTERM", "exit"];
const before = Object.fromEntries(events.map((name) => [name, process.listeners(name)]));
const beforeResize = process.stderr.listeners("resize");
const marker = (phase) => process.stderr.write(`\x1b]777;progress-proof;${phase}\x07`);
const readReady = async (expected) => {
  const buffer = Buffer.alloc(1);
  const count = await new Promise((resolve, reject) => {
    read(readyFd, buffer, 0, 1, null, (error, count) => (error ? reject(error) : resolve(count)));
  });
  assert.equal(count, 1);
  assert.equal(buffer.toString(), expected);
};
let suppressed = false;
const observe = async (update) => {
  suppressed =
    cell.expectSuppressed === true &&
    events.every(
      (name) =>
        process.listeners(name).length === before[name].length &&
        process.listeners(name).every((listener, index) => listener === before[name][index]),
    );
  if (suppressed) marker("suppressed");
  await readReady("S");
  update(updatedLabel);
  marker("updated");
  await readReady("A");
  marker("active");
};
let columns = cell.columns;
let result;
marker("begin");
if (cell.kind === "wizard") {
  const reporter = wizard.createClackPrompter(process.stderr).progress(label);
  await observe((message) => reporter.update(message));
  reporter.stop(cell.finalMessage);
  if (cell.repeatStop) reporter.stop("Unexpected second completion");
  result = "wizard completed";
} else if (cell.kind === "delayed") {
  const reporter = progress.createCliProgress({ label, stream: process.stderr, delayMs: 2000 });
  const resized = once(process.stderr, "resize");
  marker("resize-request");
  await resized;
  columns = process.stderr.columns;
  assert.equal(columns, cell.finalColumns);
  await observe((message) => reporter.setLabel(message));
  reporter.done();
  result = "delayed completed";
} else {
  result = await progress.withProgress({ label, stream: process.stderr }, async (reporter) => {
    await observe((message) => reporter.setLabel(message));
    return "work completed";
  });
}
closeSync(readyFd);
marker("done");
await sleep(250);
marker("settled");
assert.deepEqual(process.stderr.listeners("resize"), beforeResize);
for (const name of events) assert.deepEqual(process.listeners(name), before[name]);
assert.equal(process.stdin.isRaw === true, false);
writeFileSync(
  receiptPath,
  JSON.stringify({
    id: cell.id,
    label,
    updatedLabel,
    columns,
    result,
    initialColumns: cell.columns,
    finalMessage: cell.finalMessage ?? null,
    suppressed,
    repeatedStop: cell.repeatStop === true,
    listenersRestored: true,
    rawInputRestored: true,
    completed: true,
  }),
);
// Natural completion is required; no process.exit or unref workaround.
