import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sourceHead, sourceTree, phase, buildKind, output, toolingHead] = process.argv.slice(2);
const { collectControlUiPerformanceMetrics } = await import(
  pathToFileURL(path.resolve("scripts/check-control-ui-performance.mts")).href
);
const dist = path.resolve("dist/control-ui");
const metrics = collectControlUiPerformanceMetrics(dist);
const modules = new Set();
for (const asset of metrics.startup.assets.filter((entry) => entry.type === "js")) {
  const map = JSON.parse(fs.readFileSync(path.join(dist, asset.file + ".map"), "utf8"));
  assert.equal(map.version, 3);
  assert.ok(Array.isArray(map.sources));
  for (const source of map.sources) {
    modules.add(source);
  }
}
const startupModules = [...modules].sort();
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      sourceHead,
      sourceTree,
      toolingHead,
      phase,
      buildKind,
      metrics,
      startupModules,
    },
    null,
    2,
  ) + "\n",
);
if (phase === "candidate") {
  for (const source of [
    "/ui/src/lib/model-auth.ts",
    "/src/infra/provider-usage.shared.ts",
    "/packages/model-catalog-core/src/provider-id.ts",
  ]) {
    assert.ok(!startupModules.some((entry) => entry.endsWith(source)), source);
  }
  assert.ok(
    startupModules.some((entry) => entry.endsWith("/ui/src/lib/model-auth-request-state.ts")),
  );
}
