import assert from "node:assert/strict";
import fs from "node:fs";
import { acceptBaseline, archiveFact, checkCli, checkSnapshot } from "./read-output.mjs";

const cases = JSON.parse(fs.readFileSync(new URL("./cases.json", import.meta.url)));
const started = 1788001000000;
const targets = cases.agents.map((agentId) => ({
  agentId,
  storePath: `/synthetic/state/${agentId}/sessions.json`,
  sqlitePath: `/synthetic/state/${agentId}/openclaw-agent.sqlite`,
}));
function payload(test) {
  const rows = cases.entries.filter((row) => test.agents.includes(row.agentId));
  return {
    path: test.id === "single-agent" ? targets[0].sqlitePath : null,
    ...(test.id === "all-agents"
      ? {
          allAgents: true,
          stores: targets.map((row) => ({ agentId: row.agentId, path: row.sqlitePath })),
        }
      : {}),
    count: rows.length,
    totalCount: rows.length,
    limitApplied: null,
    hasMore: false,
    activeMinutes: null,
    sessions: rows.map((row) => {
      const { archivedAt, ...entry } = row.entry;
      void archivedAt;
      return {
        ...entry,
        key: row.key,
        agentId: row.agentId,
        model: row.expectedModel,
        ageMs: started - row.entry.updatedAt,
        acpRuntime: false,
        kind: "direct",
        agentRuntime: { id: "openclaw", source: "model" },
        contextTokens: 64000,
      };
    }),
  };
}
const snapshot = {
  mode: "seed",
  completed: true,
  closed: true,
  targets,
  rows: cases.entries.map((row) => ({
    agentId: row.agentId,
    key: row.key,
    entry: structuredClone(row.entry),
  })),
  projected: cases.entries.map((row) => {
    const { archivedAt, ...entry } = row.entry;
    void archivedAt;
    return { agentId: row.agentId, key: row.key, row: entry };
  }),
};
const tests = [];
const check = (name, action) => {
  action();
  tests.push({ name, passed: true });
};
for (const test of cases.commands)
  check("valid baseline " + test.id, () => {
    const actual = checkCli(
      test,
      JSON.stringify(payload(test)),
      "",
      cases,
      snapshot,
      started,
      started + 100,
    );
    acceptBaseline(actual.facts);
  });
check("valid owner baseline", () => acceptBaseline(checkSnapshot(snapshot, cases)));
check("zero remains archived", () =>
  assert.equal(archiveFact({ archived: true, archivedAt: 0 }, { archivedAt: 0 }).matches, true),
);
check("absent timestamp is unarchived", () =>
  assert.equal(archiveFact({ archived: false }, {}).matches, true),
);
const mutations = [
  [
    "wrong count",
    (v) => {
      v.count++;
    },
  ],
  [
    "missing row",
    (v) => {
      v.sessions.pop();
    },
  ],
  [
    "wrong all-agents",
    (v) => {
      v.allAgents = false;
    },
  ],
  [
    "wrong store",
    (v) => {
      v.stores[0].path = "/other";
    },
  ],
  [
    "wrong explicit model",
    (v) => {
      v.sessions[1].model = "gpt-5.5";
    },
  ],
  [
    "nonfresh lost",
    (v) => {
      v.sessions[2].totalTokensFresh = true;
    },
  ],
  [
    "known total lost",
    (v) => {
      v.sessions[1].totalTokens = null;
    },
  ],
  [
    "runtime label leak",
    (v) => {
      v.sessions[0].runtimeLabel = "internal";
    },
  ],
  [
    "prepared model leak",
    (v) => {
      v.sessions[0].displayModelRef = {};
    },
  ],
  [
    "clock outside interval",
    (v) => {
      v.sessions[0].ageMs = -1;
    },
  ],
  [
    "reordered rows",
    (v) => {
      v.sessions.reverse();
    },
  ],
];
for (const [name, mutate] of mutations)
  check("reject " + name, () => {
    const test = cases.commands[1];
    const v = payload(test);
    mutate(v);
    assert.throws(() =>
      checkCli(test, JSON.stringify(v), "", cases, snapshot, started, started + 100),
    );
  });
check("reject stderr", () =>
  assert.throws(() =>
    checkCli(
      cases.commands[0],
      JSON.stringify(payload(cases.commands[0])),
      "unexpected",
      cases,
      snapshot,
      started,
      started + 100,
    ),
  ),
);
check("reject stdout noise", () =>
  assert.throws(() =>
    checkCli(
      cases.commands[0],
      "noise\n" + JSON.stringify(payload(cases.commands[0])),
      "",
      cases,
      snapshot,
      started,
      started + 100,
    ),
  ),
);
check("reject rewritten archive fact", () => {
  const changed = structuredClone(snapshot);
  changed.rows[1].entry.archivedAt = 1;
  assert.throws(() => checkSnapshot(changed, cases, snapshot));
});
check("reject missing close", () => {
  const changed = structuredClone(snapshot);
  changed.closed = false;
  assert.throws(() => checkSnapshot(changed, cases));
});
check("reject wrong-value instead of expected missing projection", () =>
  assert.throws(() =>
    acceptBaseline([
      { matches: false, actual: { hasArchived: true, archived: false, hasArchivedAt: false } },
    ]),
  ),
);
check("reject fixed output as baseline", () =>
  assert.throws(() =>
    acceptBaseline([
      { matches: true, actual: { hasArchived: true, archived: true, hasArchivedAt: true } },
    ]),
  ),
);
console.log(JSON.stringify({ sourceImports: false, targetExecution: false, tests }, null, 2));
