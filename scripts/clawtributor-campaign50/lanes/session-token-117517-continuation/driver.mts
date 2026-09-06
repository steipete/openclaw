import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [repoRoot, evidenceDir, mode] = process.argv.slice(2);
assert(repoRoot && evidenceDir && mode === "red", "Baseline-only packet");
const stateDir = path.join(evidenceDir, "state");
const configPath = path.join(stateDir, "openclaw.json");
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(
  configPath,
  JSON.stringify({
    agents: {
      defaults: { model: { primary: "openai/gpt-5.6-sol" } },
      entries: { main: { default: true } },
    },
  }),
  { mode: 0o600 },
);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  NO_COLOR: "1",
});
const source = (relative: string) => import(pathToFileURL(path.join(repoRoot, relative)).href);
const { replaceSessionEntry, listSessionEntriesReadOnly } = await source(
  "src/config/sessions/session-accessor.ts",
);
const { resolveSqliteTargetFromSessionStorePath } = await source(
  "src/config/sessions/session-sqlite-target.ts",
);
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabaseByPath, closeOpenClawAgentDatabases } =
  await source("src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabase } = await source("src/state/openclaw-state-db.ts");
const { formatTokensCompact } = await source("src/commands/status.format.ts");
const { formatContextUsageLine } = await source("src/tui/tui-formatters.ts");
const rows: unknown[] = [];
const reusedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "reused-34062271559");
const reuse = JSON.parse(await fs.readFile(path.join(reusedDir, "reuse.json"), "utf8"));
assert.equal(reuse.source, process.env.SOURCE_SHA);
assert.deepEqual(reuse.callIds, ["zero-json", "zero-text-0", "one-json", "one-text-0"]);
for (const [file, expected] of Object.entries(reuse.hashes)) {
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(path.join(reusedDir, file)))
      .digest("hex"),
    expected,
  );
}
const reusedSource = JSON.parse(await fs.readFile(path.join(reusedDir, "source.json"), "utf8"));
assert.equal(reusedSource.source, reuse.source);
assert.equal(reusedSource.node, "24.20.0");
assert(reusedSource.packageManager.startsWith("pnpm@12.3.4+"));
assert.equal((await fs.readFile(path.join(reusedDir, "final-working-tree.patch"))).length, 0);
let executedCalls = 0;
const consumedReuse: string[] = [];
const started = performance.now();
const failures: string[] = [];
const cases = [
  {
    id: "zero",
    total: 0,
    context: 200000,
    fresh: true,
    version: 1,
    old: "0.0k/200k (0%)",
    canonical: "0/200k (0%)",
  },
  {
    id: "one",
    total: 1,
    context: 200000,
    fresh: true,
    version: 1,
    old: "0.0k/200k (0%)",
    canonical: "1/200k (0%)",
    primary: true,
  },
  {
    id: "forty-nine",
    total: 49,
    context: 200000,
    fresh: true,
    version: 1,
    old: "0.0k/200k (0%)",
    canonical: "49/200k (0%)",
    primary: true,
  },
  {
    id: "small-context",
    total: 420,
    context: 999,
    fresh: true,
    version: 1,
    old: "0.4k/1.0k (42%)",
    canonical: "420/999 (42%)",
  },
  {
    id: "stale",
    total: 1,
    context: 200000,
    fresh: false,
    version: 1,
    old: "0.0k/200k (?%)",
    canonical: "1/200k (?%)",
  },
  {
    id: "missing-version",
    total: 49,
    context: 200000,
    fresh: true,
    old: "0.0k/200k (?%)",
    canonical: "49/200k (?%)",
  },
  { id: "unknown", context: 200000, old: "unknown/200k (?%)", canonical: "unknown/200k (?%)" },
  {
    id: "million",
    total: 1000000,
    context: 2500000,
    fresh: true,
    version: 1,
    old: "1000k/2500k (40%)",
    canonical: "1.0m/2.5m (40%)",
  },
  {
    id: "wrapped",
    total: 49,
    context: 200000,
    fresh: true,
    version: 1,
    old: "0.0k/200k (0%)",
    canonical: "49/200k (0%)",
    wrapped: true,
  },
  {
    id: "untrusted-old-context",
    total: 1,
    context: 999,
    fresh: true,
    version: 1,
    oldContext: true,
  },
];
const compact = (value: string) => value.replace(/\s/g, "");
function parseSingleRow(stdout: string) {
  const lines = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  const cells = lines
    .filter((line) => /^[│|]/u.test(line))
    .map((line) =>
      line
        .split(/[│|]/u)
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  assert(cells.length >= 2, "CLI did not emit a table and a data row");
  const [headers, ...body] = cells;
  const tokenIndex = headers.findIndex((cell) => cell === "Tokens (ctx %)");
  const modelIndex = headers.findIndex((cell) => cell === "Model");
  assert(tokenIndex >= 0 && modelIndex >= 0, "Missing expected table columns");
  assert(body.every((row) => row.length === headers.length));
  return {
    tokens: body.map((row) => row[tokenIndex]).join(""),
    model: body.map((row) => row[modelIndex]).join(""),
    physicalRows: body.length,
  };
}
function selectHumanTable(result: { stdout: string; stderr: string }, route: string[]) {
  const expectedStream = route.length === 1 ? "stderr" : "stdout";
  const streams = ["stdout", "stderr"] as const;
  const tables = streams.filter((stream) => /^┌/m.test(result[stream]));
  assert.deepEqual(
    tables,
    [expectedStream],
    "Expected exactly one table in the command-owned stream",
  );
  for (const stream of streams) {
    if (stream !== expectedStream)
      assert.doesNotMatch(
        result[stream],
        /^[┌├└│]/mu,
        "Unexpected table fragment on non-owned stream",
      );
    const lines = result[stream].split("\n").filter((line) => line.trim());
    for (const line of lines) {
      assert(
        /^[┌├└│]/u.test(line) ||
          line.startsWith("Session store: ") ||
          line === "Sessions listed: 1" ||
          /^Config \(.+\): Removed retired agents\.entries\.\*\.default markers\.$/.test(line),
        `Unexpected human output on ${stream}: ${line}`,
      );
    }
  }
  const text = result[expectedStream];
  assert.equal((text.match(/^┌/gm) ?? []).length, 1);
  assert.equal((text.match(/^└/gm) ?? []).length, 1);
  assert.equal((text.match(/^├/gm) ?? []).length, 1);
  return { text, stream: expectedStream };
}
async function cli(id: string, args: string[]) {
  const save = async (stdout: string, stderr: string, outcome: unknown) => {
    await fs.writeFile(path.join(evidenceDir, `${id}.stdout`), stdout);
    await fs.writeFile(path.join(evidenceDir, `${id}.stderr`), stderr);
    await fs.writeFile(
      path.join(evidenceDir, `${id}.outcome.json`),
      JSON.stringify(outcome, null, 2),
    );
  };
  if (reuse.callIds.includes(id)) {
    const outcome = JSON.parse(
      await fs.readFile(path.join(reusedDir, `${id}.outcome.json`), "utf8"),
    );
    assert.deepEqual(outcome, { exitCode: 0, signal: null });
    assert(!consumedReuse.includes(id));
    consumedReuse.push(id);
    return {
      stdout: await fs.readFile(path.join(reusedDir, `${id}.stdout`), "utf8"),
      stderr: await fs.readFile(path.join(reusedDir, `${id}.stderr`), "utf8"),
      receipt: { kind: "reused", run: reuse.run, callId: id },
    };
  }
  try {
    executedCalls++;
    const result = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "openclaw.mjs"), ...args],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    await save(result.stdout, result.stderr, { exitCode: 0, signal: null });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      receipt: { kind: "executed", callId: id },
    };
  } catch (error) {
    // execFile attaches captured streams and termination details to rejected errors.
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
    };
    await save(failure.stdout ?? "", failure.stderr ?? "", {
      exitCode: failure.code ?? null,
      signal: failure.signal ?? null,
      killed: failure.killed ?? false,
      error: String(error),
    });
    throw error;
  }
}

try {
  for (const item of cases) {
    const storePath = path.join(
      stateDir,
      "agents",
      "main",
      "fixture-stores",
      item.id,
      "sessions.json",
    );
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const sessionKey = `agent:main:proof-${item.id}`;
    const model = item.wrapped ? `synthetic-model-${"long".repeat(30)}` : "gpt-5.6-sol";
    const entry = {
      sessionId: `proof-${item.id}`,
      updatedAt: Date.now() - 60000,
      model,
      modelProvider: item.wrapped ? "ollama" : "openai",
      // Locked native session windows are an existing supported context provenance contract.
      modelSelectionLocked: item.oldContext !== true,
      contextTokens: item.context,
      ...(item.total === undefined ? {} : { totalTokens: item.total }),
      ...(item.fresh === undefined ? {} : { totalTokensFresh: item.fresh }),
      ...(item.version === undefined ? {} : { totalTokensVersion: item.version }),
    };
    openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    assert(await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry));
    const before = listSessionEntriesReadOnly({ agentId: "main", storePath, projection: "list" });
    assert.equal(before.length, 1);
    closeOpenClawAgentDatabaseByPath(databasePath);
    const selection = ["--agent", "main", "--store", databasePath];
    const jsonResult = await cli(`${item.id}-json`, ["sessions", "--json", ...selection]);
    const json = JSON.parse(jsonResult.stdout);
    assert.equal(json.count, 1);
    assert.equal(json.sessions.length, 1);
    const recorded = json.sessions[0];
    assert.equal(recorded.key, sessionKey);
    assert.equal(recorded.totalTokens, item.total ?? null);
    assert.equal(recorded.totalTokensFresh, item.fresh === true && item.version === 1);
    if (item.oldContext) {
      assert(
        recorded.contextTokens > 999,
        "Unproven old window must not override the selected model",
      );
    } else {
      assert.equal(recorded.contextTokens, item.context);
    }
    const routes = item.primary ? [["sessions"], ["sessions", "list"]] : [["sessions", "list"]];
    for (const [index, route] of routes.entries()) {
      const textResult = await cli(`${item.id}-text-${index}`, [...route, ...selection]);
      const { text, stream } = selectHumanTable(textResult, route);
      const parsed = parseSingleRow(text);
      if (item.oldContext) {
        assert(parsed.tokens.startsWith("0.0k/"));
        assert(parsed.tokens.endsWith("(0%)"));
      } else {
        assert.equal(compact(parsed.tokens), compact(item.old!));
      }
      assert.equal(parsed.model, model);
      if (item.wrapped) assert(parsed.physicalRows > 1, "Long model did not exercise wrapping");
      if (item.primary) {
        assert.notEqual(compact(parsed.tokens), compact(item.canonical!));
        failures.push(`${item.id}:${route.join(" ")}`);
      }
      rows.push({
        id: item.id,
        receipt: textResult.receipt,
        jsonReceipt: jsonResult.receipt,
        tableStream: stream,
        route: route.join(" "),
        tokens: parsed.tokens,
        expectedCanonical: item.canonical ?? null,
        physicalRows: parsed.physicalRows,
        jsonTotal: recorded.totalTokens,
        jsonFresh: recorded.totalTokensFresh,
        jsonContext: recorded.contextTokens,
        tableSha256: createHash("sha256").update(text).digest("hex"),
        stdoutSha256: createHash("sha256").update(textResult.stdout).digest("hex"),
        stderrSha256: createHash("sha256").update(textResult.stderr).digest("hex"),
      });
    }
    if (item.primary || item.id === "zero") {
      const percent = Math.round((item.total! / item.context) * 100);
      const status = formatTokensCompact({
        totalTokens: item.total,
        contextTokens: item.context,
        percentUsed: percent,
      });
      const tui = formatContextUsageLine({ total: item.total, context: item.context, percent });
      assert.equal(status, item.canonical);
      assert.equal(tui, `tokens ${item.canonical}`);
      rows.push({ id: `${item.id}-canonical-siblings`, status, tui });
    }
    const unchanged = listSessionEntriesReadOnly({
      agentId: "main",
      storePath,
      projection: "list",
    });
    assert.equal(unchanged.length, 1);
    // Reused receipts describe the old run and path, not reads of this recreated database.
    if (item.id !== "zero") assert.deepEqual(unchanged, before);
    closeOpenClawAgentDatabaseByPath(databasePath);
  }
  assert.deepEqual(failures, [
    "one:sessions",
    "one:sessions list",
    "forty-nine:sessions",
    "forty-nine:sessions list",
  ]);
  assert.equal(executedCalls, 18);
  assert.deepEqual(consumedReuse, reuse.callIds);
  await fs.writeFile(
    path.join(evidenceDir, "behavior.json"),
    JSON.stringify(
      {
        reusedRun: reuse.run,
        reusedCalls: consumedReuse,
        executedCalls,
        source: process.env.SOURCE_SHA,
        mode,
        failures,
        rows,
        seconds: (performance.now() - started) / 1000,
      },
      null,
      2,
    ),
  );
  console.log(
    `SESSION_TOKEN_BASELINE_VERIFIED primaryDefects=${failures.length} fixtures=${cases.length}`,
  );
} finally {
  // All handles and state belong to this isolated proof process.
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabase();
  await fs.rm(stateDir, { recursive: true, force: true });
}
