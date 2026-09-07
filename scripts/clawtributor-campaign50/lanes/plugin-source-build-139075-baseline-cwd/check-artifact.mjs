import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, pluginRoot, output] = process.argv.slice(2);
const { buildPluginControlUi } = await import(
  pathToFileURL(path.join(repoRoot, "src/cli/plugins-control-ui-build.ts")).href
);
const manifest = JSON.parse(
  await fs.readFile(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
);
const declaration = await buildPluginControlUi({
  rootDir: pluginRoot,
  source: "index.ts",
  check: true,
});
assert.deepEqual(declaration, manifest.controlUi);
const built = await import(pathToFileURL(path.join(pluginRoot, declaration.entry)).href);
const compiler = createRequire(path.join(pluginRoot, "package.json"))("esbuild");
await fs.writeFile(
  output,
  JSON.stringify(
    {
      nodeEnv: process.env.NODE_ENV ?? null,
      compiler: compiler.version,
      declaration,
      exports: {
        sdkMarker: built.sdkMarker,
        workspaceMarker: built.workspaceMarker,
        pluginMarker: built.pluginMarker,
      },
    },
    null,
    2,
  ) + "\n",
);
