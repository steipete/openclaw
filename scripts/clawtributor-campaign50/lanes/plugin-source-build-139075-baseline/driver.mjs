import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [repoRoot, evidenceDir] = process.argv.slice(2);
assert(repoRoot && evidenceDir);
assert.equal(process.env.CI, "1");
assert.equal(process.env.PROOF_MODE, "baseline");
assert.equal(process.env.OPENCLAW_DEV_SOURCE_ROOT, undefined);
const laneDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-build-proof-"));
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
assert.equal(packageJson.devDependencies.esbuild, "0.28.2");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rows = [];
const invocations = [];
const sourceCases = [
  {
    id: "source-default",
    kind: "source",
    nodeEnv: null,
    sdk: "source-sdk-v2",
    workspace: "source-workspace-v2",
    defect: false,
  },
  {
    id: "source-production",
    kind: "source",
    nodeEnv: "production",
    sdk: "stale-sdk-v1",
    workspace: "stale-workspace-v1",
    defect: true,
  },
  {
    id: "packaged-default",
    kind: "packaged",
    nodeEnv: null,
    sdk: "packaged-sdk-v1",
    workspace: "packaged-workspace-v1",
    defect: false,
  },
  {
    id: "packaged-production",
    kind: "packaged",
    nodeEnv: "production",
    sdk: "packaged-sdk-v1",
    workspace: "packaged-workspace-v1",
    defect: false,
  },
];
const sourceText = (marker = "plugin-v1") =>
  [
    'import "./style.css";',
    'export { sdkMarker } from "openclaw/plugin-sdk/control-ui";',
    'export { workspaceMarker } from "@openclaw/gateway-protocol";',
    `export const pluginMarker = ${JSON.stringify(marker)};`,
    "",
  ].join("\n");

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function fixture(scenario) {
  const root = path.join(workspace, scenario.id);
  const host = path.join(root, "host");
  const plugin = path.join(host, "plugins", "proof");
  const files = {
    "host/package.json": JSON.stringify({
      name: "openclaw",
      version: "2026.9.2",
      type: "module",
      bin: { openclaw: "openclaw.mjs" },
      exports: { "./plugin-sdk/control-ui": { default: "./dist/plugin-sdk/control-ui.js" } },
    }),
    "host/dist/plugin-sdk/control-ui.js": `export const sdkMarker = ${JSON.stringify(scenario.kind === "source" ? "stale-sdk-v1" : "packaged-sdk-v1")};\n`,
    "host/packages/gateway-protocol/dist/index.mjs": `export const workspaceMarker = ${JSON.stringify(scenario.kind === "source" ? "stale-workspace-v1" : "packaged-workspace-v1")};\n`,
    "host/plugins/proof/package.json": JSON.stringify({
      name: "synthetic-browser-build",
      version: "1.0.0",
      type: "module",
      openclaw: { controlUi: "index.ts" },
      devDependencies: { esbuild: packageJson.devDependencies.esbuild },
    }),
    "host/plugins/proof/openclaw.plugin.json":
      JSON.stringify({ id: "synthetic-browser-build" }) + "\n",
    "host/plugins/proof/index.ts": sourceText(),
    "host/plugins/proof/style.css": ".proof { color: var(--text); }\n",
  };
  if (scenario.kind === "source") {
    files["host/src/plugin-sdk/control-ui.ts"] = 'export const sdkMarker = "source-sdk-v2";\n';
    files["host/packages/gateway-protocol/src/index.ts"] =
      'export const workspaceMarker = "source-workspace-v2";\n';
  }
  for (const [name, text] of Object.entries(files)) await write(path.join(root, name), text);
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(plugin, "node_modules"), "dir");
  const sourceExists = await fs.access(path.join(host, "src")).then(
    () => true,
    () => false,
  );
  assert.equal(sourceExists, scenario.kind === "source");
  await fs.mkdir(path.join(evidenceDir, scenario.id));
  await fs.writeFile(
    path.join(evidenceDir, scenario.id, "fixture-inputs.json"),
    JSON.stringify(
      {
        kind: scenario.kind,
        sourceExists,
        files: Object.fromEntries(
          Object.entries(files).map(([name, text]) => [name, { sha256: digest(text), text }]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
  return { root, host, plugin };
}

async function invoke(scenario, project, stage, action, expectedError) {
  const output = path.join(evidenceDir, scenario.id, `${stage}.json`);
  const env = { ...process.env };
  if (scenario.nodeEnv === null) delete env.NODE_ENV;
  else env.NODE_ENV = scenario.nodeEnv;
  const args = ["--import", path.join(repoRoot, "scripts/tsx.mjs")];
  if (action === "build") args.push(path.join(repoRoot, "scripts/build-plugin-control-ui.mts"));
  else args.push(path.join(laneDir, "check-artifact.mjs"), repoRoot, project.plugin, output);
  const result = spawnSync(process.execPath, args, {
    cwd: project.plugin,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  await fs.writeFile(
    path.join(evidenceDir, scenario.id, `${stage}.stdout.log`),
    result.stdout ?? "",
  );
  await fs.writeFile(
    path.join(evidenceDir, scenario.id, `${stage}.stderr.log`),
    result.stderr ?? "",
  );
  const receipt = {
    scenario: scenario.id,
    stage,
    action,
    nodeEnv: scenario.nodeEnv,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
  };
  invocations.push(receipt);
  await fs.writeFile(
    path.join(evidenceDir, scenario.id, `${stage}.outcome.json`),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  assert.equal(result.error, undefined, `${stage}: subprocess setup or timeout failure`);
  assert.equal(result.signal, null);
  assert(Number.isInteger(result.status));
  if (expectedError) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    return;
  }
  assert.equal(result.status, 0, `${scenario.id}/${stage}: ${result.stderr}`);
  if (action === "check") {
    const checked = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(checked.nodeEnv, scenario.nodeEnv);
    assert.equal(checked.compiler, "0.28.2");
    return checked;
  }
}

async function snapshot(scenario, project, stage) {
  const manifestBytes = await fs.readFile(path.join(project.plugin, "openclaw.plugin.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const declaration = manifest.controlUi;
  assert.match(declaration.entry, /^dist\/control-ui\/[a-f0-9]{64}\/index\.js$/);
  const generation = path.dirname(declaration.entry);
  assert.deepEqual(declaration.styles, [`${generation}/index.css`]);
  const directory = path.join(project.plugin, generation);
  const names = (await fs.readdir(directory)).sort();
  assert.deepEqual(names, ["index.css", "index.js"]);
  const hash = createHash("sha256");
  const files = {};
  for (const name of names) {
    const bytes = await fs.readFile(path.join(directory, name));
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
    files[name] = { bytes: bytes.length, sha256: digest(bytes) };
    await fs.writeFile(path.join(evidenceDir, scenario.id, `${stage}-${name}`), bytes);
  }
  assert.equal(path.basename(generation), hash.digest("hex"));
  const generations = (await fs.readdir(path.join(project.plugin, "dist/control-ui"))).sort();
  assert(
    generations.every((name) => /^[a-f0-9]{64}$/.test(name)),
    "staging directory leaked",
  );
  const result = { declaration, manifestSha256: digest(manifestBytes), files, generations };
  await fs.writeFile(path.join(evidenceDir, scenario.id, `${stage}-manifest.json`), manifestBytes);
  await fs.writeFile(
    path.join(evidenceDir, scenario.id, `${stage}-snapshot.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

try {
  for (const scenario of sourceCases) {
    const project = await fixture(scenario);
    await invoke(scenario, project, "01-build", "build");
    const initial = await snapshot(scenario, project, "01");
    const checked = await invoke(scenario, project, "02-check", "check");
    assert.deepEqual(checked.exports, {
      sdkMarker: scenario.sdk,
      workspaceMarker: scenario.workspace,
      pluginMarker: "plugin-v1",
    });
    assert.deepEqual(await snapshot(scenario, project, "02"), initial);
    await invoke(scenario, project, "03-repeat", "build");
    assert.deepEqual(await snapshot(scenario, project, "03"), initial);
    if (scenario.id === "source-default") {
      await fs.writeFile(path.join(project.plugin, "index.ts"), sourceText("plugin-v2"));
      await invoke(
        scenario,
        project,
        "04-stale-check",
        "check",
        /Control UI build is missing or stale/,
      );
      assert.deepEqual(await snapshot(scenario, project, "04"), initial);
      await invoke(scenario, project, "05-changed-build", "build");
      const changed = await snapshot(scenario, project, "05");
      assert.notEqual(changed.declaration.entry, initial.declaration.entry);
      assert.equal(changed.generations.length, 2);
      const changedCheck = await invoke(scenario, project, "06-changed-check", "check");
      assert.deepEqual(changedCheck.exports, {
        sdkMarker: scenario.sdk,
        workspaceMarker: scenario.workspace,
        pluginMarker: "plugin-v2",
      });
      for (const [name, file] of Object.entries(initial.files)) {
        assert.equal(
          digest(
            await fs.readFile(
              path.join(project.plugin, path.dirname(initial.declaration.entry), name),
            ),
          ),
          file.sha256,
        );
      }
      await fs.writeFile(
        path.join(project.plugin, "index.ts"),
        'export { missing } from "./missing-proof-module.js";\n',
      );
      await invoke(
        scenario,
        project,
        "07-failed-build",
        "build",
        /Could not resolve "\.\/missing-proof-module\.js"/,
      );
      assert.deepEqual(await snapshot(scenario, project, "07"), changed);
    }
    rows.push({
      id: scenario.id,
      nodeEnv: scenario.nodeEnv,
      exports: checked.exports,
      initial,
      observedDefect: scenario.defect,
    });
  }
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.filter((row) => row.observedDefect).map((row) => row.id),
    ["source-production"],
  );
  assert.notEqual(rows[0].initial.declaration.entry, rows[1].initial.declaration.entry);
  assert.equal(rows[2].initial.declaration.entry, rows[3].initial.declaration.entry);
  await fs.writeFile(
    path.join(evidenceDir, "behavior.json"),
    JSON.stringify(
      {
        sourceSha: process.env.SOURCE_SHA,
        mode: "baseline",
        outcome: "confirmed-stale-dist-build",
        cases: rows,
        invocations,
        controls: {
          checkReadOnly: true,
          repeatStable: true,
          oldGenerationPreserved: true,
          staleCheckRejected: true,
          compileFailurePreservedManifest: true,
          packagedFallbackPreserved: true,
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PLUGIN_SOURCE_BUILD_BASELINE: one stale-source environment defect; three matrix controls and generation integrity controls passed.",
  );
} catch (error) {
  await fs.writeFile(
    path.join(evidenceDir, "failure.json"),
    JSON.stringify(
      { sourceSha: process.env.SOURCE_SHA, rows, invocations, error: String(error) },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
  const removed = await fs.access(workspace).then(
    () => false,
    () => true,
  );
  await fs.writeFile(
    path.join(evidenceDir, "cleanup.json"),
    JSON.stringify({ taskWorkspaceRemoved: removed, childrenJoined: true }) + "\n",
  );
  assert(removed);
}
