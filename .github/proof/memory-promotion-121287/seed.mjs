import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sourceDir, caseDir, blockedText, eligibleText] = process.argv.slice(2);
assert.ok(path.isAbsolute(sourceDir) && path.isAbsolute(caseDir));
const blockedCount = Number(blockedText);
const eligibleCount = Number(eligibleText);
assert.ok(Number.isInteger(blockedCount) && blockedCount > 0 && blockedCount <= 504);
assert.ok(Number.isInteger(eligibleCount) && eligibleCount > 0 && eligibleCount <= 8);
// Stay within the existing readStore retention cap so the fixture reaches ranking intact.
assert.ok(blockedCount + eligibleCount <= 512);
const workspaceDir = path.join(caseDir, "workspace");
const stateDir = path.join(caseDir, "state");
assert.equal(process.env.OPENCLAW_STATE_DIR, stateDir);
assert.equal(process.env.OPENCLAW_CONFIG_PATH, path.join(caseDir, "openclaw.json"));
await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
const config = {
  gateway: { mode: "local" },
  agents: {
    defaults: { workspace: workspaceDir },
    entries: { proof: { default: true, workspace: workspaceDir } },
  },
  memory: { search: { provider: "none", sources: ["memory"] } },
  plugins: {
    allow: ["memory-core"],
    slots: { memory: "memory-core" },
    entries: { "memory-core": { enabled: true } },
  },
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { flag: "wx" });
await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Long-Term Memory\n", { flag: "wx" });

const { createPluginStateKeyedStore, closePluginStateDatabase } = await import(
  pathToFileURL(path.join(sourceDir, "src/plugin-state/plugin-state-store.ts")).href
);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const workspaceKey = sha256(path.resolve(workspaceDir).replaceAll("\\", "/"));
const wrap = (key, value) => ({ version: 1, workspaceKey, workspaceDir, key, value });
const stateKey = (key) => `${workspaceKey}:${sha256(key)}`;
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const relativePath = "memory/2026-04-03.md";
const records = [];
for (let index = 0; index < blockedCount + eligibleCount; index += 1) {
  const blocked = index < blockedCount;
  const line = index + 1;
  const score = blocked ? 0.99 : 0.1;
  const snippet = blocked
    ? `Blocked fixture note ${index}: keep release notes beside deployment checklists.`
    : `Eligible fixture note ${index - blockedCount}: keep release notes beside deployment checklists.`;
  records.push({
    key: `memory:${relativePath}:${line}:${line}`,
    path: relativePath,
    startLine: line,
    endLine: line,
    source: "memory",
    snippet,
    recallCount: 8,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 8 * score,
    maxScore: score,
    firstRecalledAt: nowIso,
    lastRecalledAt: nowIso,
    queryHashes: ["release", "deployment", "checklist"],
    recallDays: [nowIso.slice(0, 10)],
    conceptTags: [],
    provenance: {
      originClass: blocked ? (index % 2 === 0 ? "untrusted" : "system") : "agent",
      sessionKind: "interactive",
      observedAt: nowMs,
    },
  });
}
await fs.writeFile(
  path.join(workspaceDir, relativePath),
  `${records.map((r) => r.snippet).join("\n")}\n`,
  {
    flag: "wx",
  },
);
try {
  const recall = createPluginStateKeyedStore("memory-core", {
    namespace: "short-term-recall",
    maxEntries: 50_000,
  });
  for (const record of records) {
    await recall.register(stateKey(record.key), wrap(record.key, record));
  }
  const metadata = createPluginStateKeyedStore("memory-core", {
    namespace: "short-term-meta",
    maxEntries: 50_000,
  });
  await metadata.register(stateKey("recall"), wrap("recall", { updatedAt: nowIso }));
} finally {
  await closePluginStateDatabase();
}
const summary = {
  workspaceDir,
  stateDir,
  relativePath,
  blockedCount,
  eligibleCount,
  blockedKeys: records.slice(0, blockedCount).map((r) => r.key),
  eligibleKeys: records.slice(blockedCount).map((r) => r.key),
  eligibleSnippet: records[blockedCount].snippet,
  sourceSha256: sha256(await fs.readFile(path.join(workspaceDir, relativePath))),
};
await fs.writeFile(path.join(caseDir, "seed.json"), `${JSON.stringify(summary, null, 2)}\n`, {
  flag: "wx",
});
console.log(JSON.stringify({ blockedCount, eligibleCount, storedRows: records.length }));
