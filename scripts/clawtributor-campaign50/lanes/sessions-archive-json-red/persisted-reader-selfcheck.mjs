import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Synthetic receipts only: no target imports, child commands, databases or live state.
const lane = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.dirname(fileURLToPath(import.meta.url));
const legacy = process.argv.includes("--expect-serialization-failure");
const { archiveFact, checkCli, checkSnapshot } = await import(
  pathToFileURL(path.join(lane, "read-output.mjs")).href
);
const { validateArtifact } = await import(
  pathToFileURL(path.join(lane, "validate-artifact.mjs")).href
);
const packetBytes = fs.readFileSync(path.join(lane, "PACKET.json"));
const packet = JSON.parse(packetBytes);
const cases = JSON.parse(fs.readFileSync(path.join(lane, "cases.json")));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const tests = [];
const check = (name, run) => {
  run();
  tests.push({ name, passed: true });
};
const startedMs = 1788001000000;
const finishedMs = startedMs + 100;
const targets = cases.agents.map((agentId) => ({
  agentId,
  storePath: `/synthetic/state/${agentId}/sessions.json`,
  sqlitePath: `/synthetic/state/${agentId}/openclaw-agent.sqlite`,
}));
const config = {
  plugins: { enabled: false },
  session: { store: "/synthetic/state/sessions/{agentId}/sessions.json" },
  agents: {
    ownership: "explicit",
    defaults: {
      model: { primary: "openai/gpt-5.5" },
      models: { "openai/gpt-5.5": {}, "openai/gpt-5.4": {} },
    },
    entries: Object.fromEntries(
      cases.agents.map((id) => [id, { workspace: "/synthetic/workspaces/" + id }]),
    ),
  },
};
const configSha256 = hash(JSON.stringify(config, null, 2) + "\n");
const initial = {
  completed: true,
  closed: true,
  mode: "seed",
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
function cliPayload(test) {
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
        ageMs: startedMs - row.entry.updatedAt,
        acpRuntime: false,
        kind: "direct",
        agentRuntime: { id: "openclaw", source: "model" },
        contextTokens: 64000,
      };
    }),
  };
}
function buildReceiptFiles() {
  const files = new Map();
  const json = (file, value) => files.set(file, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
  files.set("inputs/PACKET.json", packetBytes);
  for (const file of Object.keys(packet.files))
    files.set("inputs/" + file, fs.readFileSync(path.join(lane, file)));
  const source = {
    source: packet.source,
    tree: packet.tree,
    phase: "baseline",
    changes: [],
    sourceHashes: packet.sourceHashes,
  };
  json("source-before.json", source);
  json("source-final.json", source);
  json("seed.snapshot.json", initial);
  const stores = targets.flatMap((target) =>
    ["", "-wal", "-shm", "-journal"].map((suffix) => ({
      file: target.sqlitePath + suffix,
      present: suffix === "",
      ...(suffix === "" ? { sha256: hash("synthetic database receipt " + target.agentId) } : {}),
    })),
  );
  json("stores-before.json", stores);
  json("config.json", config);
  json("fixture.json", {
    stateDir: "/synthetic/state",
    configFile: "/synthetic/state/openclaw.json",
    configSha256,
  });
  const buildRows = [
    ["dist/entry.js", "file", hash("synthetic entry")],
    ["dist/cli-startup-metadata.json", "file", hash("{}")],
  ];
  const build = {
    complete: true,
    rows: buildRows,
    hash: hash(JSON.stringify(buildRows)),
    files: 2,
    links: 0,
  };
  for (const name of [
    "build-inventory.json",
    "single-agent.build-inventory.json",
    "all-agents.build-inventory.json",
    "final-build-inventory.json",
  ])
    json(name, build);
  const cli = cases.commands.map((test) => ({
    id: test.id,
    ...checkCli(test, JSON.stringify(cliPayload(test)), "", cases, initial, startedMs, finishedMs),
  }));
  for (const actual of cli) {
    const { id, ...accepted } = actual;
    json(id + ".accepted.json", accepted);
    json("inspect-" + id + ".snapshot.json", { ...initial, mode: "inspect" });
    json(id + ".stores.json", stores);
    json("inspect-" + id + ".stores.json", stores);
  }
  const commands = [
    "build",
    "seed",
    "single-agent",
    "inspect-single-agent",
    "all-agents",
    "inspect-all-agents",
  ].map((id, index) => {
    const test = cases.commands.find((test) => test.id === id);
    const stdout = Buffer.from(
      test ? JSON.stringify(cliPayload(test)) : "synthetic command receipt\n",
    );
    const stderr = Buffer.alloc(0);
    files.set(id + "/stdout", stdout);
    files.set(id + "/stderr", stderr);
    json("source-after-" + id + ".json", source);
    const authored = {
      "home/input-marker.txt": hash("Synthetic #124540 home input\n"),
      "state/openclaw.json": configSha256,
      "workspaces/alpha/input-marker.txt": hash("Synthetic #124540 workspace input\n"),
    };
    return {
      id,
      args: test ? ["/synthetic/openclaw.mjs", ...test.argv] : [],
      exit: 0,
      childExitCode: 0,
      childExitSignal: null,
      joined: true,
      stdoutEnded: true,
      stderrEnded: true,
      authoredPreserved: true,
      pid: 1000 + index,
      startedMs,
      finishedMs,
      authoredBefore: authored,
      authoredAfter: authored,
      outputBytes: stdout.length,
      limit: id === "build" ? packet.buildOutputLimitBytes : packet.cliOutputLimitBytes,
      stdoutSha256: hash(stdout),
      stderrSha256: hash(stderr),
    };
  });
  json("commands.json", commands);
  const ownerFacts = checkSnapshot(initial, cases);
  const facts = [...ownerFacts, ...cli.flatMap((row) => row.facts)];
  json("result.json", {
    completed: true,
    proofAccepted: true,
    sourceUnchanged: true,
    ownedStateRemoved: true,
    source: packet.source,
    packetHash: hash(packetBytes),
    commands,
    ownerFacts,
    cli,
    baseline: { intendedViolations: facts.length, facts },
  });
  files.set("verdict.txt", Buffer.from("EXPECTED_ARCHIVE_PROJECTION_DEFECT_CONFIRMED\n"));
  return files;
}
const seedFiles = buildReceiptFiles();
function exercise(mutate, expectFailure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-receipt-data-"));
  const files = new Map([...seedFiles].map(([key, bytes]) => [key, Buffer.from(bytes)]));
  const get = (name) => JSON.parse(files.get(name));
  const put = (name, value) => files.set(name, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
  const command = (id, fn) => {
    const result = get("result.json");
    fn(result.commands.find((row) => row.id === id));
    put("result.json", result);
    put("commands.json", result.commands);
  };
  const stdout = (id, fn) => {
    const bytes = Buffer.from(JSON.stringify(fn(JSON.parse(files.get(id + "/stdout")))));
    files.set(id + "/stdout", bytes);
    command(id, (row) => {
      row.stdoutSha256 = hash(bytes);
      row.outputBytes = bytes.length + files.get(id + "/stderr").length;
    });
  };
  try {
    mutate?.({ files, get, put, command, stdout });
    for (const [file, bytes] of files) {
      const destination = path.join(root, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: "wx" });
    }
    if (expectFailure)
      assert.throws(
        () => validateArtifact(root, lane),
        expectFailure === true ? undefined : expectFailure,
      );
    else assert.equal(validateArtifact(root, lane).expectedDefectConfirmed, true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}
if (legacy) {
  check("original full persisted receipt rejects undefined fact keys", () =>
    exercise(
      undefined,
      (error) =>
        error.code === "ERR_ASSERTION" &&
        /archived/.test(error.message) &&
        /undefined/.test(error.message),
    ),
  );
} else {
  check("valid full persisted owner CLI and aggregate receipts", () => exercise());
  for (const row of [
    {},
    { archived: null, archivedAt: null },
    { archived: false },
    { archived: true, archivedAt: 0 },
  ]) {
    check("fact JSON roundtrip " + JSON.stringify(row), () => {
      const fact = archiveFact(row, { archivedAt: 0 });
      assert.deepEqual(clone(fact), fact);
      for (const key of ["archived", "archivedAt"]) {
        assert.equal(Object.hasOwn(fact.actual, key), Object.hasOwn(row, key));
        if (Object.hasOwn(row, key)) assert.equal(fact.actual[key], row[key]);
      }
    });
  }
  check("explicit undefined presence remains distinct from absence", () => {
    const fact = archiveFact({ archived: undefined, archivedAt: undefined }, {});
    assert.equal(fact.actual.hasArchived, true);
    assert.equal(fact.actual.hasArchivedAt, true);
    assert.deepEqual(clone(fact), fact);
    assert.equal(fact.matches, false);
  });
  const mutations = [
    [
      "owner presence flag",
      ({ get, put }) => {
        const r = get("result.json");
        r.ownerFacts[0].actual.hasArchived = true;
        put("result.json", r);
      },
    ],
    [
      "persisted CLI fact",
      ({ get, put }) => {
        const r = get("single-agent.accepted.json");
        r.facts[0].actual.archived = false;
        put("single-agent.accepted.json", r);
      },
    ],
    [
      "aggregate fact",
      ({ get, put }) => {
        const r = get("result.json");
        r.baseline.facts[0].matches = true;
        put("result.json", r);
      },
    ],
    [
      "timestamp zero lost",
      ({ get, put }) => {
        const r = get("seed.snapshot.json");
        delete r.rows[2].entry.archivedAt;
        put("seed.snapshot.json", r);
      },
    ],
    [
      "wrong value rather than missing field",
      ({ stdout }) =>
        stdout("single-agent", (r) => {
          r.sessions[0].archived = false;
          return r;
        }),
    ],
    [
      "known token total",
      ({ stdout }) =>
        stdout("all-agents", (r) => {
          r.sessions[1].totalTokens++;
          return r;
        }),
    ],
    [
      "native nonzero",
      ({ command }) =>
        command("seed", (r) => {
          r.exit = 1;
          r.childExitCode = 1;
        }),
    ],
    [
      "missing EOF",
      ({ command }) =>
        command("single-agent", (r) => {
          r.stdoutEnded = false;
        }),
    ],
    [
      "unjoined command",
      ({ command }) =>
        command("seed", (r) => {
          r.unjoinedWork = true;
        }),
    ],
    ["raw hash mismatch", ({ files }) => files.set("single-agent/stdout", Buffer.from("{}"))],
    [
      "all-agent metadata",
      ({ stdout }) =>
        stdout("all-agents", (r) => {
          r.allAgents = false;
          return r;
        }),
    ],
    [
      "store preservation",
      ({ get, put }) => {
        const r = get("all-agents.stores.json");
        r[0].sha256 = "a".repeat(64);
        put("all-agents.stores.json", r);
      },
    ],
    [
      "post-read row mutation",
      ({ get, put }) => {
        const r = get("inspect-all-agents.snapshot.json");
        r.rows[0].entry.label = "changed";
        put("inspect-all-agents.snapshot.json", r);
      },
    ],
    [
      "source binding",
      ({ get, put }) => {
        const r = get("source-final.json");
        r.source = "0".repeat(40);
        put("source-final.json", r);
      },
    ],
    [
      "copied input bytes",
      ({ files }) => files.set("inputs/read-output.mjs", Buffer.from("changed")),
    ],
  ];
  for (const [name, mutate] of mutations)
    check("reject persisted " + name, () => exercise(mutate, true));
}
console.log(JSON.stringify({ dataOnly: true, targetExecution: false, tests }, null, 2));
