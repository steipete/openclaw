import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readPlanContract, selectRemainingCommands } from "./plan-contract.mjs";
const [target, lane, evidence] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(`${lane}/MANIFEST.json`, "utf8"));
const reuse = JSON.parse(readFileSync(`${evidence}/reused-candidate.json`, "utf8"));
assert.equal(reuse.accepted, true);
assert.equal(reuse.originalRun, 34189419890);
assert.equal(reuse.originalJobConclusion, "failure");
const staticReuse = JSON.parse(readFileSync(`${evidence}/reused-static72.json`, "utf8"));
assert.equal(staticReuse.accepted, true);
assert.equal(staticReuse.originalRun, 34198758390);
const retainedPrefix = [...reuse.staticPassed, ...staticReuse.passedCommands];
const paths = Object.keys(manifest.candidateHashes).sort();
const { detectChangedLanesForPaths, getChangedCoreTestPaths } = await import(
  pathToFileURL(`${target}/scripts/changed-lanes.mts`).href
);
const { createChangedCheckPlan, createPnpmManagedCommand, cleanupCorepackPnpmShimDir } =
  await import(pathToFileURL(`${target}/scripts/check-changed.mts`).href);
const { resolveLocalCheckEnv } = await import(
  pathToFileURL(`${target}/scripts/lib/local-check-runtime.mts`).href
);
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(`${target}/scripts/lib/managed-child-process.mts`).href
);
const result = detectChangedLanesForPaths({ paths, base: manifest.source, head: "HEAD" });
assert.equal(getChangedCoreTestPaths(result), undefined);
const plan = createChangedCheckPlan(result, {
  base: manifest.source,
  head: "HEAD",
  env: process.env,
});
const contract = readPlanContract(lane);
const scripts = JSON.parse(readFileSync(`${target}/package.json`, "utf8")).scripts;
const remaining = selectRemainingCommands(plan.commands, contract, retainedPrefix, scripts);
assert.ok(remaining.every((command) => command.coreTestCheck === undefined));
const receipt = {
  source: manifest.source,
  reusedRun: reuse.originalRun,
  capturedPlanRun: contract.capturedRun,
  canonicalPlanCount: contract.commandNames.length,
  expectedRemaining: remaining.length,
  reusedCommands: retainedPrefix,
  reusedStaticRun: staticReuse.originalRun,
  planned: remaining.map(({ name, bin, args }) => ({ name, bin: bin ?? "pnpm", args })),
  results: [],
  complete: false,
};
let mayCleanShim = true;
try {
  for (const command of remaining) {
    const selected = command.bin ? command : createPnpmManagedCommand(command);
    const row = {
      name: command.name,
      bin: selected.bin,
      args: selected.args,
      spawned: false,
      closed: false,
      signals: [],
      strictProcessTreeExit: true,
    };
    receipt.results.push(row);
    writeFileSync(`${evidence}/remaining-checks.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`[remaining] ${command.name}`);
    row.status = await runManagedCommand({
      bin: selected.bin,
      args: selected.args,
      env: selected.env ?? resolveLocalCheckEnv(),
      requireProcessTreeExit: true,
      onSignal(signal) {
        row.signals.push(signal);
      },
      onReady(child) {
        row.spawned = true;
        row.pid = child.pid;
        child.once("close", (code, signal) => {
          row.closed = true;
          row.exitCode = code;
          row.exitSignal = signal;
          row.stdoutEnded = child.stdout?.readableEnded ?? null;
          row.stderrEnded = child.stderr?.readableEnded ?? null;
        });
      },
    });
    assert.equal(row.status, 0);
    assert.equal(row.spawned, true);
    assert.equal(row.closed, true);
    assert.equal(row.exitCode, 0);
    assert.equal(row.exitSignal, null);
    assert.deepEqual(row.signals, []);
    assert.equal(row.stdoutEnded, true);
    assert.equal(row.stderrEnded, true);
    row.strictOwnerResolved = true;
    writeFileSync(`${evidence}/remaining-checks.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  receipt.complete = true;
} catch (error) {
  mayCleanShim = !hasUnjoinedWork(error);
  receipt.error = {
    name: error.name,
    message: error.message,
    code: error.code,
    unjoinedWork: !mayCleanShim,
  };
  throw error;
} finally {
  if (mayCleanShim) cleanupCorepackPnpmShimDir();
  else process.removeListener("exit", cleanupCorepackPnpmShimDir);
  receipt.explicitShimCleanup = mayCleanShim;
  writeFileSync(`${evidence}/remaining-checks.json`, `${JSON.stringify(receipt, null, 2)}\n`);
}
