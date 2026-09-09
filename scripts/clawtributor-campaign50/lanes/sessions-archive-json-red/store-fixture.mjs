import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hash, read, writeJson } from "./source-audit.mjs";

const [target, fixtureFile, output, mode] = process.argv.slice(2);
assert(["seed", "inspect"].includes(mode));
const fixture = JSON.parse(read(fixtureFile));
const cases = JSON.parse(read(new URL("./cases.json", import.meta.url)));
assert.equal(process.cwd(), target);
assert.equal(process.env.OPENCLAW_CONFIG_PATH, fixture.configFile);
assert.equal(process.env.OPENCLAW_STATE_DIR, fixture.stateDir);
assert.equal(hash(read(fixture.configFile)), fixture.configSha256);
const load = (file) => import(pathToFileURL(path.join(target, file)).href);
const configModule = await load("src/config/config.ts");
const sessions = await load("src/config/sessions/session-accessor.ts");
const paths = await load("src/config/sessions/paths.ts");
const sqlite = await load("src/config/sessions/session-sqlite-target.ts");
const table = await load("src/commands/sessions-table.ts");
const agents = await load("src/state/openclaw-agent-db.ts");
const state = await load("src/state/openclaw-state-db.ts");
let completed = false;
const snapshot = { mode, targets: [], rows: [], projected: [], closed: false };
try {
  const configSnapshot = await configModule.readConfigFileSnapshot({
    observe: false,
    pluginValidation: "core-only",
  });
  assert.equal(configSnapshot.valid, true, JSON.stringify(configSnapshot.issues));
  const cfg = configModule.getRuntimeConfig();
  assert.deepEqual(Object.keys(cfg.agents.entries), cases.agents);
  for (const agentId of cases.agents) {
    const storePath = paths.resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const sqlitePath = sqlite.resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
    assert(sqlitePath.startsWith(fixture.stateDir + path.sep));
    snapshot.targets.push({ agentId, storePath, sqlitePath });
    if (mode === "seed") {
      assert.equal(
        fs.existsSync(sqlitePath),
        false,
        "Fixture store must be absent before initial creation",
      );
      assert.deepEqual(
        sessions.listSessionEntriesReadOnly({ agentId, storePath, projection: "list" }),
        [],
      );
      for (const row of cases.entries.filter((entry) => entry.agentId === agentId)) {
        sessions.replaceSessionEntrySync(
          { agentId, storePath, sessionKey: row.key },
          structuredClone(row.entry),
        );
      }
    }
    const rows = sessions.listSessionEntriesReadOnly({ agentId, storePath, projection: "list" });
    const expected = cases.entries.filter((entry) => entry.agentId === agentId);
    assert.equal(rows.length, expected.length);
    for (const row of rows.toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey))) {
      const authored = expected.find((entry) => entry.key === row.sessionKey);
      assert(authored, row.sessionKey);
      for (const [key, value] of Object.entries(authored.entry))
        assert.deepEqual(row.entry[key], value, key);
      assert.equal(
        Object.hasOwn(row.entry, "archivedAt"),
        Object.hasOwn(authored.entry, "archivedAt"),
      );
      const before = JSON.stringify(row.entry);
      const projected = table.toSessionDisplayRow(row.sessionKey, row.entry);
      assert.equal(JSON.stringify(row.entry), before, "Projection mutated its input");
      snapshot.rows.push({ agentId, key: row.sessionKey, entry: row.entry });
      snapshot.projected.push({ agentId, key: row.sessionKey, row: projected });
    }
  }
  completed = true;
} finally {
  await agents.closeOpenClawAgentDatabasesAsync();
  state.closeOpenClawStateDatabase();
  snapshot.closed = true;
  snapshot.completed = completed;
  writeJson(output, snapshot);
}
