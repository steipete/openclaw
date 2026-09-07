import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function validate(evidence) {
  const read = (name) => fs.readFile(path.join(evidence, name), "utf8");
  const report = JSON.parse(await read("tests.json"));
  const log = (await read("tests.log")).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal((await read("test-exit.txt")).trim(), "0");
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numPendingTests, 15);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.numTotalTests, 16);
  assert.equal(report.testResults.length, 1);
  const suite = report.testResults[0];
  assert.equal(suite.status, "passed");
  assert.equal(suite.message, "");
  assert(suite.name.endsWith("/extensions/feishu/src/delivery-trace.test.ts"));
  assert.equal(suite.assertionResults.length, 16);
  const active = suite.assertionResults.filter((test) => test.status !== "skipped");
  assert.equal(active.length, 1);
  assert.equal(
    active[0].fullName,
    "Feishu combined-owner coalescing proof joins the held preview before replacing it with controls",
  );
  assert.equal(active[0].status, "passed");
  for (const test of suite.assertionResults) assert.deepEqual(test.failureMessages, []);
  const capture = JSON.parse(await read("tests.json.capture.json"));
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.passWithNoTests, false);
  assert.deepEqual(capture.ended, {
    reason: "passed",
    unhandledErrors: 0,
    failedModules: 0,
    suiteErrors: 0,
  });
  assert.equal(capture.modules.length, 1);
  assert(capture.modules[0].file.endsWith("/extensions/feishu/src/delivery-trace.test.ts"));
  assert(!capture.command.some((arg) => /mergeReports/.test(arg)));
  assert.doesNotMatch(
    log,
    /Failed Suites|EnvironmentTeardownError|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|Some tests are still running when generating|\[test\] retrying|no-output timeout|heap out of memory/i,
  );
  assert.match(log, /^\s*Test Files\s+1 passed \(1\)\s*$/m);
  assert.match(log, /^\s*Tests\s+1 passed\s*\|\s*15 skipped \(16\)\s*$/m);
  assert.equal([...log.matchAll(/^\s*Start at\s+\S.+$/gm)].length, 1);
  assert.equal([...log.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
  const row = JSON.parse(await read("discard-controls.json"));
  assert.equal(row.id, "discard-controls");
  assert.equal(row.joined, 4);
  assert.equal(row.pending, 4);
  assert.deepEqual(row.outcomes.map((entry) => entry.name).sort(), [
    "cleanup-idle",
    "delivery",
    "idle",
    "start",
  ]);
  assert(row.outcomes.every((entry) => entry.status === "fulfilled"));
  const delivery = row.outcomes.find((entry) => entry.name === "delivery").value;
  assert.equal(delivery.content, "Open the result.\n\n- Result: https://example.com/result");
  assert.deepEqual(delivery.messageIds, ["om-2"]);
  assert.equal(delivery.visibleReplySent, true);
  assert.equal(row.visible.visibleReplySent, true);
  const requests = row.wire.filter((event) => event.phase === "request");
  assert.equal(requests.length, row.wire.filter((event) => event.phase === "response").length);
  assert.equal(
    requests.filter((event) => event.path === "/cardkit/v1/cards" && event.method === "POST")
      .length,
    1,
  );
  assert.equal(row.events.filter((event) => event.kind === "im.message.create").length, 0);
  const replies = row.events.filter((event) => event.kind === "im.message.reply");
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0].data.payload.content, { type: "card", data: { card_id: "card-1" } });
  assert.equal(row.events.filter((event) => event.kind === "im.message.delete").length, 1);
  const responded = row.events.findIndex(
    (event) =>
      event.kind === "coalescing-http-response" &&
      event.data.path.endsWith("/elements/content/content"),
  );
  const deleted = row.events.findIndex((event) => event.kind === "im.message.delete");
  const replacement = row.events.findLastIndex((event) => event.kind === "im.message.reply");
  assert(responded >= 0 && deleted > responded && replacement > deleted);
  assert.equal(row.events[deleted].data.target, "om-1");
  const replacementCard = replies[1].data.payload.content;
  assert.deepEqual(replacementCard.body.elements, [
    { tag: "markdown", content: "Open the result." },
    {
      tag: "button",
      text: { tag: "plain_text", content: "Result" },
      type: "default",
      behaviors: [{ type: "open_url", default_url: "https://example.com/result" }],
    },
  ]);
  assert(!JSON.stringify(replacementCard).includes("First complete snapshot"));
  await fs.writeFile(
    path.join(evidence, "discard-verdict.json"),
    JSON.stringify(
      {
        source: "9060e16b7d136813b920d7b68f095b1206c341d2",
        completed: true,
        control: "discard-controls",
        joined: 4,
        canonicalReceiptTextVerified: true,
        nativeResponseDeleteReplacementOrderVerified: true,
        gatewayIngress: "not-run",
        credentialedFeishu: false,
      },
      null,
      2,
    ) + "\n",
  );
}
