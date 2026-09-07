import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function validate(evidenceDir) {
  assert(evidenceDir);
  const read = async (name) => fs.readFile(path.join(evidenceDir, name), "utf8");
  const report = JSON.parse(await read("tests.json"));
  const log = (await read("tests.log")).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal((await read("test-exit.txt")).trim(), "1");
  assert.equal(report.success, false);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.numFailedTests, 1);
  assert.equal(report.numPassedTests, 5);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(
    report.numTotalTests,
    report.numFailedTests + report.numPassedTests + report.numPendingTests,
  );
  const suite = report.testResults[0];
  assert(
    suite.name.replaceAll("\\", "/").endsWith("/extensions/feishu/src/delivery-trace.test.ts"),
  );
  assert.equal(suite.status, "failed");
  assert.equal(suite.message, "");
  const capture = JSON.parse(await read("tests.json.capture.json"));
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.passWithNoTests, false);
  assert.deepEqual(capture.ended, {
    reason: "failed",
    unhandledErrors: 0,
    failedModules: 1,
    suiteErrors: 0,
  });
  assert.equal(capture.modules.length, 1);
  assert(
    capture.modules[0].file
      .replaceAll("\\", "/")
      .endsWith("/extensions/feishu/src/delivery-trace.test.ts"),
  );
  assert(Number.isSafeInteger(capture.pid) && capture.pid > 1);
  assert(Array.isArray(capture.command));
  assert(
    !capture.command.some((arg) => /mergeReports/.test(arg)),
    "Expected original direct capture, not replay",
  );
  assert.doesNotMatch(log, /\[test\] retrying|heap out of memory|no-output timeout/i);
  const prefix = "Feishu combined-owner coalescing proof ";
  const expected = [
    "omits the stale middle wire snapshot while joining finalization",
    "retains the latest partial when startup and idle overlap",
    "joins the held preview before replacing it with controls",
    "records a failed preview and settles the successful final",
    "preserves accepted content when final finalization fails",
    "preserves accepted content when settings finalization fails",
  ];
  const cases = suite.assertionResults.filter((entry) => entry.fullName.startsWith(prefix));
  assert.deepEqual(
    cases.map((entry) => entry.fullName.slice(prefix.length)),
    expected,
  );
  assert.equal(cases[0].status, "failed");
  assert.equal(cases[0].failureMessages.length, 1);
  assert.match(cases[0].failureMessages[0].split("\n")[0], /STALE_MIDDLE_WIRE_SNAPSHOT/);
  for (const entry of cases.slice(1)) {
    assert.equal(entry.status, "passed", entry.fullName);
    assert.deepEqual(entry.failureMessages, []);
  }
  for (const entry of suite.assertionResults.filter(
    (entry) => !entry.fullName.startsWith(prefix),
  )) {
    assert.equal(entry.status, "skipped", entry.fullName);
  }
  assert.equal(suite.assertionResults.length, report.numTotalTests);
  assert.doesNotMatch(
    log,
    /(?:Vitest caught \d+ unhandled|Some tests are still running when generating|EnvironmentTeardownError|Unhandled Rejection|Uncaught Exception)/i,
  );
  assert.match(log, /^\s*Test Files\s+1 failed \(1\)\s*$/m);
  assert.match(log, /^\s*Tests\s+1 failed\s*\|\s*5 passed/m);
  assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, 1);
  assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
  const first = "First complete snapshot with ordinary text.";
  const middle = `${first} Middle snapshot that becomes stale.`;
  const latest = `${middle} Latest complete answer retained.`;
  const ids = [
    "stale-middle",
    "delayed-start",
    "discard-controls",
    "preview-error",
    "final-error",
    "settings-error",
  ];
  const rows = [];
  for (const id of ids) {
    const row = JSON.parse(await read(`${id}.json`));
    assert.equal(row.id, id);
    assert(Number.isInteger(row.joined) && row.joined > 0);
    assert.equal(row.joined, row.pending);
    assert.equal(row.outcomes.length, row.joined);
    const expectedNames =
      id === "delayed-start"
        ? ["start", "idle", "cleanup-idle"]
        : id === "discard-controls"
          ? ["start", "delivery", "idle", "cleanup-idle"]
          : ["start", "delivery", "finalization", "idle", "cleanup-idle"];
    assert.deepEqual(row.outcomes.map((outcome) => outcome.name).sort(), expectedNames.sort());
    for (const outcome of row.outcomes) {
      const rejected =
        ["final-error", "settings-error"].includes(id) &&
        ["idle", "finalization"].includes(outcome.name);
      assert.equal(outcome.status, rejected ? "rejected" : "fulfilled", `${id}: ${outcome.name}`);
      if (rejected) assert.match(outcome.error, /HTTP 503/);
    }
    assert.equal(row.visible.visibleReplySent, true);
    const requests = row.wire.filter((event) => event.phase === "request");
    const responses = row.wire.filter((event) => event.phase === "response");
    assert.equal(requests.length, responses.length, `${id}: unjoined HTTP response`);
    const creates = requests.filter((event) => event.path === "/cardkit/v1/cards");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].method, "POST");
    const replies = row.events.filter((event) => event.kind === "im.message.reply");
    assert.equal(replies.length, id === "discard-controls" ? 2 : 1);
    assert.equal(replies[0].data.payload.msg_type, "interactive");
    assert.deepEqual(replies[0].data.payload.content, {
      type: "card",
      data: { card_id: "card-1" },
    });
    for (const request of requests) {
      assert(request.path.startsWith("/auth/") || request.path.startsWith("/cardkit/"));
      if (request.path.startsWith("/auth/")) assert.equal(request.body, undefined);
    }
    const content = requests.filter((event) => event.path.endsWith("/elements/content/content"));
    const settings = requests.filter((event) => event.path.endsWith("/settings"));
    const finalization = row.outcomes.filter((event) => event.name === "finalization");
    if (id === "stale-middle") {
      assert.deepEqual(
        content.map((event) => event.body.content),
        [first, middle, latest],
      );
      assert.equal(settings.length, 1);
      assert.equal(finalization.length, 1);
      assert.equal(finalization[0].status, "fulfilled");
      assert.equal(finalization[0].value.content, latest);
      assert.deepEqual(finalization[0].value.messageIds, ["om-1"]);
    } else if (id === "delayed-start") {
      assert.equal(content.at(-1).body.content, latest);
      assert.equal(settings.length, 1);
    } else if (id === "discard-controls") {
      assert.equal(row.events.filter((event) => event.kind === "im.message.delete").length, 1);
      const responseIndex = row.events.findIndex(
        (event) =>
          event.kind === "coalescing-http-response" &&
          event.data.path.endsWith("/elements/content/content"),
      );
      const deleteIndex = row.events.findIndex((event) => event.kind === "im.message.delete");
      assert(responseIndex >= 0 && deleteIndex > responseIndex);
      assert.equal(row.events.filter((event) => event.kind === "im.message.reply").length, 2);
    } else if (id === "preview-error") {
      assert.equal(finalization.length, 1);
      assert.equal(finalization[0].status, "fulfilled");
      assert.equal(finalization[0].value.content, latest);
      assert(row.logs.some((line) => line.includes("Update failed:") && line.includes("HTTP 503")));
    } else {
      assert.equal(finalization.length, 1);
      assert.equal(finalization[0].status, "rejected");
      assert.equal(row.outcomes.find((event) => event.name === "idle").status, "rejected");
      assert(row.logs.some((line) => line.includes("HTTP 503")));
    }
    rows.push({
      id,
      requests: requests.length,
      contentRequests: content.length,
      joined: row.joined,
    });
  }
  await fs.writeFile(
    path.join(evidenceDir, "baseline-verdict.json"),
    JSON.stringify(
      {
        source: "9060e16b7d136813b920d7b68f095b1206c341d2",
        kind: "real-dispatcher-and-session-with-synthetic-provider-transport",
        outcome: "named-stale-middle-defect-and-five-controls",
        gatewayIngress: "not-run-no-feishu-bridge",
        credentialedFeishu: false,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "FEISHU_COALESCING_BASELINE_ACCEPTED: one intended failure, five controls, all finalizations and HTTP responses joined",
  );
}
