import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { parse } = require("internal/deps/acorn/acorn/dist/acorn");
const source = readFileSync(new URL("./inspect-group.mjs", import.meta.url), "utf8");
const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
const selected = ast.body.filter(
  (node) =>
    (node.type === "VariableDeclaration" &&
      node.declarations.some((decl) =>
        ["originalSpawn", "originalKill", "observations", "errors"].includes(decl.id.name),
      )) ||
    (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression"),
);
assert.equal(selected.length, 6);
const finalizer = ast.body.find((node) => node.type === "TryStatement").finalizer;
const calls = [];
const sentinel = { status: 0, signal: null, stdout: "12345 Z\n", stderr: null };
const originalError = Object.assign(new Error("owned inert error"), { code: "EPERM" });
let throwKill = false;
let throwSpawn = false;
const originalSpawn = function (...args) {
  calls.push({ thisValue: this, args });
  if (throwSpawn) throw originalError;
  return sentinel;
};
const originalKill = function (...args) {
  calls.push({ thisValue: this, args });
  if (throwKill) throw originalError;
  return true;
};
const fakeChildProcess = { spawnSync: originalSpawn };
const fakeProcess = { kill: originalKill };
let syncs = 0;
const context = vm.createContext({
  childProcess: fakeChildProcess,
  process: fakeProcess,
  syncBuiltinESMExports: () => syncs++,
});
vm.runInContext(selected.map((node) => source.slice(node.start, node.end)).join("\n"), context);
const argv = ["-s", "12345", "-L", "-o", "pgid=,state="];
const options = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 5000,
  killSignal: "SIGKILL",
};
const receiver = {};
assert.equal(fakeChildProcess.spawnSync.call(receiver, "ps", argv, options), sentinel);
assert.equal(calls[0].thisValue, receiver);
assert.equal(calls[0].args[1], argv);
assert.equal(calls[0].args[2], options);
assert.equal(fakeProcess.kill(-12345, 0), true);
throwKill = true;
assert.throws(
  () => fakeProcess.kill(-12345, 0),
  (error) => error === originalError,
);
sentinel.stdout = "z".repeat(65537);
assert.equal(fakeChildProcess.spawnSync("ps", argv, options), sentinel);
throwSpawn = true;
assert.throws(
  () => fakeChildProcess.spawnSync("ps", argv, options),
  (error) => error === originalError,
);
const observations = vm.runInContext("observations", context);
assert.equal(observations[0].stdout, "12345 Z\n");
assert.equal(observations[1].result, true);
assert.equal(observations[2].error.code, "EPERM");
assert.equal(observations[3].stdout.length, 65536);
assert.equal(observations[3].truncated, true);
assert.equal(observations[4].threw, true);
assert.equal(observations[4].error.code, "EPERM");
vm.runInContext(source.slice(finalizer.start, finalizer.end), context);
assert.equal(fakeChildProcess.spawnSync, originalSpawn);
assert.equal(fakeProcess.kill, originalKill);
assert.equal(syncs, 1);
console.log(
  JSON.stringify(
    {
      observerSha256: createHash("sha256").update(source).digest("hex"),
      checks: [
        "arguments/options/receiver unchanged",
        "return object identity unchanged",
        "kernel result unchanged",
        "kernel and spawn thrown error identities unchanged",
        "bounded diagnostic truncation flagged",
        "builtin identities restored",
      ],
      targetImports: false,
      targetExecution: false,
      processActions: false,
    },
    null,
    2,
  ),
);
