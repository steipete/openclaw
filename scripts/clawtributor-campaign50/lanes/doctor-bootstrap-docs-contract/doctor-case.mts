import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, workspace, evidence, caseId] = process.argv.slice(2);
assert(repo && workspace && evidence && caseId);
assert.equal(process.env.CI, "1");
assert.equal(process.env.OPENCLAW_BUNDLED_HOOKS_DIR, undefined);
assert.equal(process.env.VITEST, undefined);
assert.equal(process.env.NODE_ENV, undefined);
const load = (file: string) => import(pathToFileURL(path.join(repo, file)).href);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const save = (name: string, value: unknown) =>
  fs.writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`);
const cfg = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
assert.equal(cfg.agents.entries.proof.workspace, workspace);
assert.equal(cfg.plugins.enabled, false);
assert.equal(cfg.hooks.internal.load, undefined);
const state = await load("src/agents/workspace-state-store.ts");
const sharedDb = await load("src/state/openclaw-state-db.ts");
const agentDb = await load("src/state/openclaw-agent-db.ts");
const memory = await load("src/plugins/memory-runtime.ts");
try {
  if (caseId === "completed-bootstrap") {
    state.mergeWorkspaceSetupState(workspace, {
      bootstrapSeededAt: "2026-09-01T00:00:00.000Z",
      setupCompletedAt: "2026-09-01T00:01:00.000Z",
    });
  }
  const completion = state.readWorkspaceStateSnapshot(workspace, { readOnly: true });
  const memoryAdmission = await memory.classifyActiveMemoryWorkspacePaths({
    cfg,
    agentId: "proof",
    workspaceDir: workspace,
    relativePaths: ["USER.md", "MEMORY.md"],
  });
  await save(`${caseId}-memory.json`, memoryAdmission);
  assert.equal(memoryAdmission.status, "unavailable");
  const hookRoots = await load("src/hooks/bundled-dir.ts");
  const hooks = await load("src/hooks/workspace.ts");
  const hookPolicy = await load("src/hooks/configured.ts");
  const bundledDir = hookRoots.resolveBundledHooksDir();
  assert.equal(
    await fs.realpath(bundledDir),
    await fs.realpath(path.join(repo, "src/hooks/bundled")),
  );
  const selected = hooks
    .loadWorkspaceHookEntries(workspace, { config: cfg })
    .find((entry: { hook: { name: string } }) => entry.hook.name === "bootstrap-extra-files");
  assert(selected);
  const selection = hookPolicy.resolveInternalHookSelection(cfg);
  const loadable = hookPolicy.isHookLoadable({
    entry: selected,
    config: cfg,
    names: selection.names,
  });
  await save(`${caseId}-selection.json`, {
    selected: selected.hook,
    bundledDir,
    loadable,
    configured: selection.configured,
    names: selection.names ? [...selection.names] : null,
  });
  assert.equal(selected.hook.source, "openclaw-bundled");
  assert.equal(
    await fs.realpath(selected.hook.filePath),
    await fs.realpath(path.join(repo, "src/hooks/bundled/bootstrap-extra-files/HOOK.md")),
  );
  assert.equal(loadable, caseId === "selected-bundled-extras");
  const { resolveBootstrapContextForDiagnostics } = await load(
    "src/agents/bootstrap-files-diagnostics.ts",
  );
  const { buildBootstrapInjectionStats, analyzeBootstrapBudget } = await load(
    "src/agents/bootstrap-budget.ts",
  );
  const { resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars } = await load(
    "src/agents/embedded-agent-helpers/bootstrap.ts",
  );
  const resolved = await resolveBootstrapContextForDiagnostics({
    workspaceDir: workspace,
    config: cfg,
    agentId: "proof",
  });
  const limits = {
    bootstrapMaxChars: resolveBootstrapMaxChars(cfg, "proof"),
    bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(cfg, "proof"),
  };
  const analysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: resolved.bootstrapFiles,
      injectedFiles: resolved.contextFiles,
    }),
    ...limits,
  });
  const bootstrap = resolved.bootstrapFiles.map(
    (file: { path: string; name: string; missing: boolean; content?: string }) => ({
      path: path.relative(workspace, file.path),
      name: file.name,
      missing: file.missing,
      rawChars: file.content?.length ?? 0,
      contentSha256: digest(file.content ?? ""),
    }),
  );
  const context = resolved.contextFiles.map((file: { path: string; content: string }) => ({
    path: path.relative(workspace, file.path),
    chars: file.content.length,
    contentSha256: digest(file.content),
  }));
  await save(`${caseId}-raw.json`, { caseId, completion, limits, bootstrap, context, analysis });
  const fixture = JSON.parse(
    await fs.readFile(path.join(evidence, `${caseId}-fixture.json`), "utf8"),
  );
  for (const file of bootstrap) {
    if (!file.missing) {
      const input = fixture.find((entry: { path: string }) => entry.path === file.path);
      assert(input);
      assert.equal(file.rawChars, input.bytes);
      assert.equal(file.contentSha256, input.sha256);
    }
  }
  assert(limits.bootstrapMaxChars > 100 && limits.bootstrapMaxChars < 25000);
  assert(limits.bootstrapTotalMaxChars > 50000);
  assert(!bootstrap.some((file: { name: string }) => file.name === "CLAUDE.md"));
  assert(!context.some((file: { path: string }) => path.basename(file.path) === "CLAUDE.md"));
  const byPath = (relative: string) =>
    bootstrap.find((file: { path: string }) => file.path === relative);
  const checkLarge = (relative: string) => {
    assert.equal(byPath(relative)?.rawChars, 25000);
    const item = analysis.files.find(
      (file: { path: string }) => path.resolve(file.path) === path.join(workspace, relative),
    );
    assert(item);
    assert.equal(item.rawChars, 25000);
    assert(item.injectedChars > 0 && item.injectedChars <= limits.bootstrapMaxChars);
    assert(item.truncated && item.causes.includes("per-file-limit"));
  };
  assert(byPath("AGENTS.md"));
  if (caseId === "recognized-root") {
    checkLarge("AGENTS.md");
  } else {
    assert.equal(byPath("AGENTS.md").rawChars, 100);
    assert.equal(byPath("AGENTS.md").contentSha256, digest("a".repeat(100)));
  }
  if (caseId === "unfinished-bootstrap") {
    assert.equal(completion.setup.setupCompletedAt, undefined);
    checkLarge("BOOTSTRAP.md");
  }
  if (["completed-bootstrap", "selected-bundled-extras", "disabled-extras"].includes(caseId)) {
    assert.equal(completion.setup.setupCompletedAt, "2026-09-01T00:01:00.000Z");
    assert.equal((await fs.readFile(path.join(workspace, "BOOTSTRAP.md"), "utf8")).length, 25000);
    assert.equal(byPath("BOOTSTRAP.md"), undefined);
  }
  if (caseId === "selected-bundled-extras") {
    checkLarge("packages/core/AGENTS.md");
  } else {
    assert.equal(byPath("packages/core/AGENTS.md"), undefined);
  }
  if (["ignored-root", "completed-bootstrap", "disabled-extras"].includes(caseId)) {
    assert.equal(analysis.hasTruncation, false);
  }
  await save(`${caseId}-verdict.json`, { passed: true, caseId });
} finally {
  await memory.closeActiveMemorySearchManagersCore(cfg);
  await agentDb.closeOpenClawAgentDatabasesAsync();
  sharedDb.closeOpenClawStateDatabase();
  assert.equal(sharedDb.isOpenClawStateDatabaseOpen(), false);
  await save(`${caseId}-db-close.json`, { completed: true, sharedOpen: false });
}
