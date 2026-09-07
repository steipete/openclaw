// Inspect the emitted relay closure before running a measured candidate cohort.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [baseline, candidate, receiptPath] = process.argv.slice(2);
const { parse } = createRequire(path.join(candidate, "package.json"))("acorn");
const { runUtf8CommandWithTimeout } = await import(
  pathToFileURL(path.join(baseline, "dist/plugin-sdk/process-runtime.js"))
);
const bundle = realpathSync(path.join(candidate, "dist/native-hook-relay"));
const queue = [path.join(bundle, "entry.js")];
const seen = new Set();
const result = {
  kind: "emitted-native-relay-closure",
  scope: "Relative static and literal dynamic imports; no full Gateway fallback claim",
  edges: [],
  schemaReaders: [],
  imports: [],
  complete: false,
};
try {
  for (const file of queue) {
    if (seen.has(file)) {
      continue;
    }
    assert.ok(realpathSync(file).startsWith(`${bundle}${path.sep}`));
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const nodes = [parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true })];
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression",
        ].includes(node.type) &&
        typeof node.source?.value === "string" &&
        node.source.value.startsWith(".")
      ) {
        const target = path.resolve(path.dirname(file), node.source.value);
        assert.ok(target.startsWith(`${bundle}${path.sep}`));
        result.edges.push({
          from: path.relative(bundle, file),
          to: path.relative(bundle, target),
          dynamic: node.type === "ImportExpression",
        });
        queue.push(target);
      }
      if (
        node.type === "NewExpression" &&
        node.callee?.name === "URL" &&
        typeof node.arguments?.[0]?.value === "string" &&
        /openclaw-(?:state|agent)-schema.*\.sql$/.test(node.arguments[0].value)
      ) {
        const target = new URL(node.arguments[0].value, pathToFileURL(file));
        assert.equal(target.protocol, "file:");
        result.schemaReaders.push({
          file: path.relative(bundle, file),
          line: node.loc.start.line,
          expression: source.slice(node.start, node.end),
          target: target.href,
          targetWithinBundle: fileURLToPath(target).startsWith(`${bundle}${path.sep}`),
          targetExists: existsSync(target),
        });
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "start", "end"].includes(key)) {
          continue;
        }
        if (Array.isArray(value)) {
          nodes.push(...value);
        } else if (value && typeof value === "object") {
          nodes.push(value);
        }
      }
    }
  }
  // Confirm any emitted SQL reader's actual module-load outcome, without a Gateway RPC.
  // This cannot claim that a real legacy Gateway fallback succeeded.
  for (const file of new Set(result.schemaReaders.map((row) => row.file))) {
    const url = pathToFileURL(path.join(bundle, file)).href;
    const probe = await runUtf8CommandWithTimeout(
      [
        process.execPath,
        "--input-type=module",
        "--eval",
        "try { await import(process.argv[1]); console.log(JSON.stringify({loaded:true})); } catch (error) { console.log(JSON.stringify({loaded:false,code:error.code,message:error.message})); process.exitCode=1; }",
        url,
      ],
      {
        timeoutMs: 10_000,
        cwd: candidate,
        baseEnv: process.env,
        killProcessTree: true,
        maxOutputBytes: 1024 * 1024,
      },
    );
    result.imports.push({ file, probe });
  }
  assert.ok(
    result.schemaReaders.every((row) => row.targetExists && row.targetWithinBundle),
    "Emitted relay closure retains a missing or unpackaged SQL asset",
  );
  assert.ok(
    result.imports.every(
      ({ probe }) =>
        probe.code === 0 &&
        probe.signal === null &&
        probe.termination === "exit" &&
        probe.cleanup === "normal" &&
        !probe.killed &&
        !probe.outputLimitExceeded &&
        !probe.stdoutTruncatedBytes &&
        !probe.stderrTruncatedBytes,
    ),
    "Emitted relay schema reader failed to load",
  );
  result.complete = true;
} catch (error) {
  result.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
}
