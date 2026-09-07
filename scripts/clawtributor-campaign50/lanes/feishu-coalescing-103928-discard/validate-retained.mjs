import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function validateRetained(lane, packet) {
  const read = (name) => fs.readFileSync(path.join(lane, "retained", name));
  const json = (name) => JSON.parse(read(name));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const [name, expected] of Object.entries(packet.retainedHashes)) {
    assert.equal(hash(read(name)), expected, name);
  }
  const originalPacket = json("baseline-PACKET.json");
  assert.equal(
    hash(read("baseline-PACKET.json")),
    "14184726a27725dbca58c98129379e16aa07a3051bb2594c6f516d7790c1e0dc",
  );
  assert.equal(originalPacket.source, packet.source);
  assert.equal(
    hash(read("baseline-delivery-trace.test.ts")),
    "e4d1471ac043284c4e80665d31d83c46438f6584a4e417279110e38641b3a0c7",
  );
  const corrected = fs.readFileSync(path.join(lane, "delivery-trace.test.ts"), "utf8");
  const expected = 'content: "Open the result.\\n\\n- Result: https://example.com/result",';
  assert.equal(corrected.split(expected).length, 2);
  assert.equal(
    hash(corrected.replace(expected, 'content: "Open the result.",')),
    hash(read("baseline-delivery-trace.test.ts")),
  );
  const verdict = json("verdict.json");
  assert.equal(verdict.completed, false);
  assert.equal(
    verdict.packetHash,
    "14184726a27725dbca58c98129379e16aa07a3051bb2594c6f516d7790c1e0dc",
  );
  assert.equal(verdict.source, packet.source);
  assert.equal(verdict.unjoinedWork, false);
  assert.equal(verdict.overlayActive, false);
  const managed = json("managed-command.json");
  assert.equal(managed.normalManagedReturn, true);
  assert.equal(managed.childExitObserved, true);
  assert.equal(managed.childExit, 1);
  assert.equal(managed.exit, 1);
  assert.equal(managed.childSignal, null);
  assert.deepEqual(managed.signals, []);
  assert.equal(managed.ownedStateRemoved, true);
  assert.equal(read("test-exit.txt").toString().trim(), "1");
  for (const name of [
    "source-before.json",
    "overlay-before.json",
    "overlay-after.json",
    "source-after.json",
  ]) {
    const receipt = json(name);
    const overlay = name.startsWith("overlay-");
    const hashes = { ...originalPacket.sourceHashes };
    if (overlay)
      hashes["extensions/feishu/src/delivery-trace.test.ts"] =
        originalPacket.files["delivery-trace.test.ts"];
    assert.equal(receipt.source, packet.source);
    assert.deepEqual(receipt.hashes, hashes);
    assert.deepEqual(
      receipt.changed,
      overlay ? ["extensions/feishu/src/delivery-trace.test.ts"] : [],
    );
  }
  const capture = json("tests.json.capture.json");
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
  assert(capture.modules[0].file.endsWith("/extensions/feishu/src/delivery-trace.test.ts"));
  assert(!capture.command.some((arg) => /mergeReports/.test(arg)));
  const report = json("tests.json");
  assert.equal(report.success, false);
  assert.equal(report.numFailedTests, 2);
  assert.equal(report.numPassedTests, 4);
  assert.equal(report.numPendingTests, 10);
  assert.equal(report.numTotalTests, 16);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.testResults[0].message, "");
  const tests = report.testResults[0].assertionResults;
  const active = tests.filter((test) => test.status !== "skipped");
  assert.deepEqual(
    active.map((test) => [test.title, test.status]),
    [
      ["omits the stale middle wire snapshot while joining finalization", "failed"],
      ["retains the latest partial when startup and idle overlap", "passed"],
      ["joins the held preview before replacing it with controls", "failed"],
      ["records a failed preview and settles the successful final", "passed"],
      ["preserves accepted content when final finalization fails", "passed"],
      ["preserves accepted content when settings finalization fails", "passed"],
    ],
  );
  assert.match(active[0].failureMessages[0].split("\n")[0], /STALE_MIDDLE_WIRE_SNAPSHOT/);
  assert.match(active[0].failureMessages[0], /delivery-trace\.test\.ts:810:71/);
  assert.match(
    active[2].failureMessages[0],
    /Object\.cleanup[\s\S]*delivery-trace\.test\.ts:764:54/,
  );
  for (const test of tests.filter((test) => test.status !== "failed"))
    assert.deepEqual(test.failureMessages, []);
  const first = "First complete snapshot with ordinary text.";
  const middle = `${first} Middle snapshot that becomes stale.`;
  const latest = `${middle} Latest complete answer retained.`;
  for (const id of [
    "stale-middle",
    "delayed-start",
    "preview-error",
    "final-error",
    "settings-error",
  ]) {
    const row = json(`${id}.json`);
    const names =
      id === "delayed-start"
        ? ["start", "idle", "cleanup-idle"]
        : ["start", "delivery", "finalization", "idle", "cleanup-idle"];
    assert.equal(row.id, id);
    assert.equal(row.pending, names.length);
    assert.equal(row.joined, names.length);
    assert.deepEqual(row.outcomes.map((entry) => entry.name).sort(), names.sort());
    for (const entry of row.outcomes) {
      const rejected =
        ["final-error", "settings-error"].includes(id) &&
        ["idle", "finalization"].includes(entry.name);
      assert.equal(entry.status, rejected ? "rejected" : "fulfilled");
      if (rejected) assert.match(entry.error, /HTTP 503/);
    }
    assert.equal(row.visible.visibleReplySent, true);
    const requests = row.wire.filter((event) => event.phase === "request");
    assert.equal(requests.length, row.wire.filter((event) => event.phase === "response").length);
    assert.equal(requests.filter((event) => event.path === "/cardkit/v1/cards").length, 1);
    assert.equal(row.events.filter((event) => event.kind === "im.message.reply").length, 1);
    if (id === "stale-middle") {
      assert.deepEqual(
        requests
          .filter((event) => event.path.endsWith("/elements/content/content"))
          .map((event) => event.body.content),
        [first, middle, latest],
      );
      const finalization = row.outcomes.find((entry) => entry.name === "finalization");
      assert.equal(finalization.value.content, latest);
      assert.deepEqual(finalization.value.messageIds, ["om-1"]);
    }
  }
  return {
    run: 34151405952,
    originalConclusion: "FAILURE",
    source: packet.source,
    retainedDefect: "stale-middle",
    retainedCompletedControls: ["delayed-start", "preview-error", "final-error", "settings-error"],
    incompleteOriginalControl: "discard-controls",
    sourceAndCleanupVerified: true,
  };
}
