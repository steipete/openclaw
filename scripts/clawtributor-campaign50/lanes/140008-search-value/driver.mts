import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, evidenceDir, mode] = process.argv.slice(2);
assert(repoRoot && evidenceDir && (mode === "red" || mode === "green"));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "search-value-proof-"));
const importSource = (relative: string) =>
  import(pathToFileURL(path.join(repoRoot, relative)).href);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const failures: string[] = [];
const rows: unknown[] = [];
const globalErrors: string[] = [];
process.on("unhandledRejection", (error) => {
  globalErrors.push(String(error));
  process.exitCode = 1;
});
let dispose: (() => void) | undefined;
const started = performance.now();
try {
  const { createFindTool } = await importSource("src/agents/sessions/tools/find.ts");
  const { createGrepTool } = await importSource("src/agents/sessions/tools/grep.ts");
  const { createCodeModeTools, applyCodeModeCatalog, resolveCodeModeConfig } =
    await importSource("src/agents/code-mode.ts");
  const { createToolSearchCatalogRef } = await importSource("src/agents/tool-search.ts");
  const { disposeAllCodeModeRuns, activeRuns } = await importSource(
    "src/agents/code-mode-state.ts",
  );
  dispose = disposeAllCodeModeRuns;
  const config = { tools: { codeMode: true } };
  const resolved = resolveCodeModeConfig(config);
  assert.equal(resolved.runtime, "quickjs-wasi");
  assert.equal(resolved.maxOutputBytes, 65536);
  const findDir = path.join(workspace, "find");
  const grepDir = path.join(workspace, "grep", "d".repeat(60));
  const smallDir = path.join(workspace, "small");
  const emptyDir = path.join(workspace, "empty");
  for (const directory of [findDir, grepDir, smallDir, emptyDir])
    await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < 300; index++) {
    await fs.writeFile(
      path.join(findDir, `${String(index).padStart(3, "0")}-${"f".repeat(190)}.txt`),
      "fixture\n",
    );
  }
  await fs.writeFile(path.join(grepDir, "sample.txt"), `${"m".repeat(500)}\n`.repeat(120));
  await fs.writeFile(path.join(smallDir, "small.txt"), "needle alpha\nneedle beta\n");
  const cases = [
    { id: "find-large", tool: "find", args: { pattern: "*.txt", path: "find" }, large: true },
    { id: "grep-large", tool: "grep", args: { pattern: "m+", path: "grep" }, large: true },
    {
      id: "find-small",
      tool: "find",
      args: { pattern: "*.txt", path: "small" },
      expected: "small.txt",
    },
    {
      id: "grep-small",
      tool: "grep",
      args: { pattern: "needle", path: "small" },
      expected: "small.txt:1: needle alpha\nsmall.txt:2: needle beta",
    },
    {
      id: "find-empty",
      tool: "find",
      args: { pattern: "*.txt", path: "empty" },
      expected: "No files found matching pattern",
    },
    {
      id: "grep-empty",
      tool: "grep",
      args: { pattern: "absent", path: "small" },
      expected: "No matches found",
    },
  ];
  for (const scenario of cases) {
    const tool = scenario.tool === "find" ? createFindTool(workspace) : createGrepTool(workspace);
    const execute = tool.execute.bind(tool);
    const observed: any[] = [];
    // Observe the same invocation, preserving native search order and the exact returned value.
    tool.execute = async (...args: any[]) => {
      const result = await execute(...args);
      observed.push(result);
      return result;
    };
    const catalogRef = createToolSearchCatalogRef();
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: scenario.id,
      sessionKey: `agent:main:${scenario.id}`,
      runId: `proof-${scenario.id}`,
      catalogRef,
    };
    const controls = createCodeModeTools(ctx);
    applyCodeModeCatalog({ ...ctx, tools: [...controls, tool] });
    const exec = controls.find((item: any) => item.name === "exec");
    const wait = controls.find((item: any) => item.name === "wait");
    assert(exec && wait);
    let details = (
      await exec.execute(`call-${scenario.id}`, {
        code: `return await ${tool.name}(${JSON.stringify(scenario.args)});`,
      })
    ).details;
    for (let count = 0; details.status === "waiting" && count < 8; count++) {
      assert.equal(typeof details.runId, "string");
      details = (await wait.execute(`wait-${scenario.id}-${count}`, { runId: details.runId }))
        .details;
    }
    assert.equal(details.status, "completed", `${scenario.id}: Code Mode did not complete`);
    assert.equal(observed.length, 1, `${scenario.id}: tool execution count`);
    const actual = observed[0];
    const directText = actual.content
      .map((item: any) => (item.type === "text" ? item.text : ""))
      .join("");
    assert.equal(actual.details.content, directText);
    if (scenario.expected !== undefined) assert.equal(directText, scenario.expected);
    if (scenario.large) {
      assert.equal(actual.details.truncation.truncated, true);
      if (mode === "green") {
        const metadata = actual.details.truncation;
        assert.equal(metadata.truncatedBy, "bytes");
        assert.equal(metadata.maxBytes, 51200);
        assert.equal(metadata.maxLines, Number.MAX_SAFE_INTEGER);
        assert.equal(metadata.firstLineExceedsLimit, false);
        assert.equal(metadata.lastLinePartial, false);
        assert(directText.includes("50.0KB limit reached"));
        if (scenario.tool === "find") {
          assert.equal(metadata.totalLines, 300);
          assert.equal(metadata.totalBytes, 59699);
          assert.equal(metadata.outputLines, 257);
          assert.equal(metadata.outputBytes, 51142);
          assert.equal(actual.details.resultLimitReached, undefined);
        } else {
          assert.equal(metadata.totalLines, 100);
          assert.equal(metadata.totalBytes, 57691);
          assert.equal(metadata.outputLines, 88);
          assert.equal(metadata.outputBytes, 50766);
          assert.equal(actual.details.matchLimitReached, 100);
          assert.equal(actual.details.linesTruncated, undefined);
          assert(directText.includes("100 matches limit reached"));
        }
      }
      assert(
        Buffer.byteLength(directText) > 49000,
        `${scenario.id}: fixture did not reach byte truncation`,
      );
    }
    const value = details.value;
    const preserved = value?.content === directText;
    if (!preserved) failures.push(scenario.id);
    if (mode === "red" && scenario.large) {
      assert(bytes(actual.details) > resolved.maxOutputBytes);
      assert.equal(value?.truncated, true);
      assert.equal(Object.hasOwn(value, "content"), false);
      assert.equal(typeof value.prefix, "string");
      assert.equal(typeof actual.details.truncation.content, "string");
    } else {
      assert(preserved, `${scenario.id}: returned content differs from its producing invocation`);
      if (scenario.large) {
        assert(bytes(actual.details) < resolved.maxOutputBytes);
        assert.equal(Object.hasOwn(value.truncation, "content"), false);
        assert.deepEqual(value.truncation, actual.details.truncation);
      }
    }
    rows.push({
      id: scenario.id,
      status: details.status,
      invocations: observed.length,
      directTextBytes: Buffer.byteLength(directText),
      directTextSha256: digest(directText),
      producerDetailsBytes: bytes(actual.details),
      returnedValueBytes: bytes(value),
      returnedContentSha256: typeof value?.content === "string" ? digest(value.content) : null,
      contentPreserved: preserved,
      producerTruncated: actual.details.truncation?.truncated ?? false,
      returnedTruncation: value?.truncation ?? null,
      marker: value?.truncated === true,
    });
    catalogRef.disposeObserver?.();
  }
  assert.deepEqual(failures, mode === "red" ? ["find-large", "grep-large"] : []);
  assert.equal(globalErrors.length, 0);
  assert.equal(activeRuns.size, 0);
  await fs.writeFile(
    path.join(evidenceDir, "behavior.json"),
    `${JSON.stringify({ sourceSha: process.env.SOURCE_SHA, mode, runtime: resolved.runtime, maxOutputBytes: resolved.maxOutputBytes, failures, globalErrors, rows, seconds: (performance.now() - started) / 1000, rssBytes: process.memoryUsage().rss }, null, 2)}\n`,
  );
  console.log(
    `SEARCH_VALUE_PROOF ${mode}: ${rows.length} completed cases; ${failures.length} intended defects; zero global errors.`,
  );
} catch (error) {
  await fs.writeFile(
    path.join(evidenceDir, "failure.json"),
    `${JSON.stringify({ mode, sourceSha: process.env.SOURCE_SHA, rows, failures, globalErrors, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2)}\n`,
  );
  throw error;
} finally {
  dispose?.();
  await fs.rm(workspace, { recursive: true, force: true });
}
