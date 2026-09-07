import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const entryFacades = [];
const generatedRuntimes = [];
const scripts = metrics.startup.assets.filter((entry) => entry.type === "js");
for (const asset of scripts) {
  const mapPath = path.join(dist, asset.file + ".map");
  if (!fs.existsSync(mapPath)) {
    const code = fs.readFileSync(path.join(dist, asset.file), "utf8");
    if (asset.file === "assets/rolldown-runtime-DkW27tQK.js") {
      // This exact unmapped runtime is shared with the verified canonical build.
      // Pin its complete bytes so product code cannot hide in an unmapped chunk.
      const sha256 = createHash("sha256").update(code).digest("hex");
      assert.equal(sha256, "4625e101449061a5fae04634001143ffaba4e22a6141f1f77ed6d342b4e9db4e");
      generatedRuntimes.push({ file: asset.file, sha256 });
      continue;
    }
    // Rolldown's generated entry only invokes a mapped startup chunk; it has no
    // original module to map. Reject every other missing-map shape.
    assert.match(asset.file, /^assets\/index-[\w-]+\.js$/u);
    assert.ok(Buffer.byteLength(code) <= 256);
    const facade = code
      .trim()
      .match(
        /^import\{(?:[A-Za-z_$][\w$]* as )?(?<local>[A-Za-z_$][\w$]*)\}from"(?<target>\.\/[\w-]+\.js)";\k<local>\(\);$/u,
      );
    assert.ok(facade, asset.file);
    const target = path.posix.join("assets", facade.groups.target);
    assert.ok(
      scripts.some((entry) => entry.file === target),
      target,
    );
    assert.ok(fs.existsSync(path.join(dist, target + ".map")), target);
    entryFacades.push({ file: asset.file, target, code });
    continue;
  }
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
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
      entryFacades,
      generatedRuntimes,
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
