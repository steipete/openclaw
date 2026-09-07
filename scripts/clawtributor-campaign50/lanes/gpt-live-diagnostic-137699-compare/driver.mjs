import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [repoRoot, evidenceDir, mode] = process.argv.slice(2);
assert(repoRoot && evidenceDir);
assert(mode === "baseline" || mode === "candidate");
const importSource = (relative) => import(pathToFileURL(path.join(repoRoot, relative)).href);
const { OpenAIQuicksilverDelegationController } = await importSource(
  "extensions/openai/realtime-quicksilver-delegation-controller.ts",
);
const { formatErrorMessage } = await importSource("src/infra/errors.ts");
const prefix = "OpenAI GPT-Live delegation consult failed: ";
const clientText =
  "The agent task failed. Tell the user it did not complete and offer to try again.";
const rows = [];
const globalErrors = [];
const onUnhandled = (error) => globalErrors.push(String(error));
process.on("unhandledRejection", onUnhandled);
const cases = [
  {
    id: "astral-crosses-boundary",
    input: "x".repeat(179) + "🤖",
    baseline: "x".repeat(179) + "\ud83e",
    expected: "x".repeat(179),
    defect: true,
  },
  {
    id: "astral-fits-boundary",
    input: "x".repeat(178) + "🤖",
    baseline: "x".repeat(178) + "🤖",
    expected: "x".repeat(178) + "🤖",
    defect: false,
  },
  {
    id: "astral-after-boundary",
    input: "x".repeat(180) + "🤖",
    baseline: "x".repeat(180),
    expected: "x".repeat(180),
    defect: false,
  },
  {
    id: "normalized-astral-boundary",
    input: " \t" + "x".repeat(178) + "\n\n🤖 \t",
    baseline: "x".repeat(178) + " \ud83e",
    expected: "x".repeat(178) + " ",
    defect: true,
  },
  {
    id: "bmp-boundary",
    input: "界".repeat(181),
    baseline: "界".repeat(180),
    expected: "界".repeat(180),
    defect: false,
  },
  {
    id: "whitespace-fallback",
    input: " \t\n ",
    baseline: "unknown error",
    expected: "unknown error",
    defect: false,
  },
  {
    id: "ordinary-failure",
    input: "workspace unavailable",
    baseline: "workspace unavailable",
    expected: "workspace unavailable",
    defect: false,
  },
  {
    id: "injected-formatter",
    input: "synthetic upstream detail",
    formattedInput: "host formatted diagnostic",
    baseline: "host formatted diagnostic",
    expected: "host formatted diagnostic",
    defect: false,
  },
];

try {
  for (const scenario of cases) {
    const events = [];
    const sent = [];
    const warnings = [];
    const fatalErrors = [];
    const sessionController = new AbortController();
    let consultCalls = 0;
    let formatterCalls = 0;
    const failure = new Error(scenario.input);
    let finish;
    let deadline;
    const settled = new Promise((resolve, reject) => {
      finish = resolve;
      deadline = setTimeout(() => reject(new Error(`${scenario.id}: no terminal frame`)), 5_000);
    });
    const socket = {
      readyState: 1,
      send(payload) {
        events.push("send");
        sent.push(JSON.parse(payload));
        finish();
      },
    };
    const controller = new OpenAIQuicksilverDelegationController(
      {
        getSocket: () => socket,
        model: "synthetic-diagnostic",
        logger: {
          debug: () => assert.fail("unexpected ignored frame"),
          warn: (message) => {
            events.push("warn");
            warnings.push(message);
          },
        },
        onFatalError: (error) => fatalErrors.push(String(error)),
        runAgentConsult: async ({ prompt, signal }) => {
          events.push("consult");
          consultCalls += 1;
          assert.equal(signal.aborted, false);
          assert.equal(
            prompt,
            "<realtime_delegation>\n  <input>Check the synthetic fixture</input>\n</realtime_delegation>",
          );
          throw failure;
        },
        signal: sessionController.signal,
      },
      (error) => {
        events.push("format");
        formatterCalls += 1;
        assert.equal(error, failure);
        return formatErrorMessage(
          scenario.formattedInput ? new Error(scenario.formattedInput) : error,
        );
      },
    );
    try {
      controller.handleFrame(
        Buffer.from(
          JSON.stringify({
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: scenario.id,
              content: [{ type: "input_text", text: "Check the synthetic fixture" }],
            },
          }),
        ),
        false,
      );
      await settled;
      await nextEventLoopTurn();
      assert.equal(consultCalls, 1);
      assert.equal(formatterCalls, 1);
      assert.deepEqual(events, ["consult", "format", "warn", "send"]);
      assert.deepEqual(fatalErrors, []);
      assert.deepEqual(warnings, [
        prefix + (mode === "baseline" ? scenario.baseline : scenario.expected),
      ]);
      assert.deepEqual(sent, [
        {
          type: "delegation.context.append",
          delegation_item_id: scenario.id,
          channel: "speakable",
          content: [{ type: "input_text", text: clientText }],
        },
      ]);
      const reason = warnings[0].slice(prefix.length);
      assert(reason.length <= 180);
      const observedDefect = reason !== scenario.expected;
      assert.equal(observedDefect, mode === "baseline" && scenario.defect);
      assert.equal(reason.isWellFormed(), !observedDefect);
      const logBytes = Buffer.from(warnings[0] + "\n", "utf8");
      const decodedLog = logBytes.toString("utf8");
      assert.equal(decodedLog.includes("\ufffd"), observedDefect);
      await fs.writeFile(path.join(evidenceDir, `${scenario.id}.log`), logBytes);
      rows.push({
        id: scenario.id,
        consultCalls,
        formatterCalls,
        events,
        loggedReason: reason,
        expectedReason: scenario.expected,
        utf16Units: reason.length,
        wellFormed: reason.isWellFormed(),
        utf8Replacement: decodedLog.includes("\ufffd"),
        logSha256: createHash("sha256").update(logBytes).digest("hex"),
        clientFrames: sent,
        observedDefect,
      });
    } finally {
      clearTimeout(deadline);
      controller.stop(new Error("proof case complete"));
      sessionController.abort(new Error("proof case complete"));
    }
  }
  await nextEventLoopTurn();
  assert.deepEqual(globalErrors, []);
  assert.equal(rows.length, 8);
  assert.deepEqual(
    rows.filter((row) => row.observedDefect).map((row) => row.id),
    mode === "baseline" ? ["astral-crosses-boundary", "normalized-astral-boundary"] : [],
  );
  await fs.writeFile(
    path.join(evidenceDir, "behavior.json"),
    JSON.stringify(
      {
        sourceSha: process.env.SOURCE_SHA,
        mode,
        outcome: mode === "baseline" ? "confirmed-defect" : "repaired",
        providerRequests: 0,
        privilegedDelegations: 0,
        globalErrors,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `GPT_LIVE_DIAGNOSTIC_${mode.toUpperCase()}: ${rows.filter((row) => row.observedDefect).length} defects, 8 cases, 8 safe client replies.`,
  );
} catch (error) {
  await fs.writeFile(
    path.join(evidenceDir, "failure.json"),
    JSON.stringify(
      { sourceSha: process.env.SOURCE_SHA, rows, globalErrors, error: String(error) },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  process.off("unhandledRejection", onUnhandled);
}
