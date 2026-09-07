import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [target, rawPid, rawExit] = process.argv.slice(2);
const pid = Number(rawPid);
const exitCode = Number(rawExit);
assert.equal(process.platform, "linux");
assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid <= 0x7fffffff && pid !== process.pid);
assert.ok(Number.isSafeInteger(exitCode));
const { inspectManagedProcessGroup } = await import(
  pathToFileURL(`${target}/scripts/lib/managed-child-process.mts`).href
);
const originalSpawn = childProcess.spawnSync;
const originalKill = process.kill;
const observations = [];
const errors = (error) =>
  error
    ? { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 500) }
    : null;
childProcess.spawnSync = function (...args) {
  let result;
  let thrown;
  try {
    result = Reflect.apply(originalSpawn, this, args);
    return result;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const [command, argv, options] = args;
    const stdout = typeof result?.stdout === "string" ? result.stdout : null;
    observations.push({
      kind: "ps",
      command,
      argv,
      options: {
        encoding: options?.encoding,
        stdio: options?.stdio,
        timeout: options?.timeout,
        killSignal: options?.killSignal,
      },
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      error: errors(thrown ?? result?.error),
      threw: thrown !== undefined,
      stdout: stdout?.slice(0, 65536) ?? null,
      truncated: stdout !== null && stdout.length > 65536,
    });
  }
};
process.kill = function (...args) {
  try {
    const result = Reflect.apply(originalKill, this, args);
    observations.push({ kind: "kernel", pid: args[0], signal: args[1], result, error: null });
    return result;
  } catch (error) {
    observations.push({ kind: "kernel", pid: args[0], signal: args[1], error: errors(error) });
    throw error;
  }
};
syncBuiltinESMExports();
let canonicalState;
try {
  canonicalState = inspectManagedProcessGroup(
    { pid, exitCode, signalCode: null },
    {
      errorPolicy: "indeterminate",
      platform: "linux",
      useProcessGroup: true,
    },
  );
} finally {
  childProcess.spawnSync = originalSpawn;
  process.kill = originalKill;
  syncBuiltinESMExports();
}
const expectedArgs = ["-s", String(pid), "-L", "-o", "pgid=,state="];
const observationValid =
  observations.length >= 1 &&
  observations.every((entry) =>
    entry.kind === "kernel"
      ? entry.pid === -pid && entry.signal === 0
      : entry.command === "ps" &&
        JSON.stringify(entry.argv) === JSON.stringify(expectedArgs) &&
        JSON.stringify(entry.options) ===
          JSON.stringify({
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
            killSignal: "SIGKILL",
          }) &&
        !entry.truncated,
  );
console.log(
  JSON.stringify({
    pid,
    exitCode,
    observerPid: process.pid,
    canonicalState,
    policy: "indeterminate",
    observationValid,
    observations,
    builtinBindingsRestored:
      childProcess.spawnSync === originalSpawn && process.kill === originalKill,
  }),
);
if (!observationValid || !["dead", "live", "indeterminate"].includes(canonicalState))
  process.exitCode = 1;
