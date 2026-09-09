import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";
const evidence = realpathSync(process.argv[2]);
const phase = process.argv[3];
assert.ok(phase === "owner" || phase === "browser");
const lane = path.dirname(fileURLToPath(import.meta.url));
const { report, log } = readCompletedReport(
  path.join(evidence, phase === "owner" ? "owner.json" : "vitest.json"),
  path.join(evidence, phase === "owner" ? "owner.log" : "browser.log"),
);
assert.doesNotMatch(log, /run (?:was |is )?queued|unfinished|timed out|test timed out/i);
assert.equal(report.success, true);
assert.ok(report.numTotalTests > 0);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPassedTests, report.numTotalTests);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
const results = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(results.length, report.numTotalTests);
for (const result of results) {
  assert.equal(result.status, "passed");
  assert.deepEqual(result.failureMessages, []);
}
const filesExpected =
  phase === "owner"
    ? JSON.parse(readFileSync(path.join(lane, "owner-files.json"), "utf8"))
    : ["ui/src/e2e/identity-config-refresh.e2e.test.ts"];
assert.equal(report.testResults.length, filesExpected.length);
for (const file of filesExpected) {
  const matching = report.testResults.filter((suite) =>
    suite.name.replaceAll("\\", "/").endsWith("/" + file),
  );
  assert.equal(matching.length, 1, file);
  assert.equal(matching[0].status, "passed");
  assert.ok(matching[0].assertionResults.length > 0);
}
if (phase === "owner") {
  writeFileSync(
    path.join(evidence, "qualified-owners.json"),
    JSON.stringify(
      {
        status: "all-five-owner-suites-passed",
        files: filesExpected,
        assertions: report.numTotalTests,
        skipped: 0,
      },
      null,
      2,
    ),
  );
} else {
  assert.equal(report.numTotalTests, 1);
  assert.equal(
    results[0].title,
    "refreshes the visible chat identity after a successful config change",
  );
  const baseline = JSON.parse(readFileSync(path.join(lane, "baseline-qualified.json"), "utf8"));
  assert.equal(baseline.status, "expected-stale-pane-identity");
  assert.deepEqual(baseline.observed, {
    name: "Atlas",
    avatar: "🦞",
    avatarLabel: "Atlas",
    placeholder: "Message Atlas",
  });
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)],
    );
  const files = walk(path.join(evidence, "browser"));
  const receiptFiles = files.filter((file) => path.basename(file) === "receipts.json");
  assert.equal(receiptFiles.length, 1);
  const row = JSON.parse(readFileSync(receiptFiles[0], "utf8"));
  assert.equal(row.initial.name, "Atlas");
  assert.equal(row.initial.avatar, "🦞");
  assert.equal(row.initial.draft, "Keep this unsent garden note.");
  assert.equal(row.initial.transcriptRows, 0);
  assert.deepEqual(row.observed, {
    name: "Cedar",
    avatar: "🌻",
    avatarLabel: "Cedar",
    placeholder: "Message Cedar",
  });
  assert.equal(row.sender, "Cedar");
  assert.deepEqual(row.controls, baseline.controls);
  assert.deepEqual(row.responses, baseline.responses);
  assert.deepEqual(row.controls, {
    sessionPreserved: true,
    draftPreserved: true,
    transcriptPreserved: true,
    sendsBeforeSubmit: 0,
    sendsAfterSubmit: 1,
    sentSession: "agent:main:main",
    sentMessage: "Keep this unsent garden note.",
    reply: "The garden note stayed in this chat.",
    replyVisible: true,
  });
  const identities = row.responses.filter((item) => item.method === "agent.identity.get");
  const rosters = row.responses.filter((item) => item.method === "agents.list");
  assert.ok(identities.length >= 2);
  assert.ok(rosters.length >= 1);
  assert.equal(identities.length + rosters.length, row.responses.length);
  for (const item of identities) {
    assert.equal(item.params.agentId, "main");
    assert.deepEqual(item.response, {
      agentId: "main",
      name: "Cedar",
      avatar: "🌻",
      avatarStatus: "none",
      nameSource: "agent",
    });
  }
  for (const item of rosters)
    assert.deepEqual(item.response, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        {
          id: "main",
          name: "Cedar",
          identity: { name: "Cedar", emoji: "🌻" },
          model: { primary: "openai/gpt-5.5" },
        },
      ],
    });
  assert.deepEqual(
    row.screenshots.map((file) => path.basename(file)),
    ["initial.png", "settled.png", "roundtrip.png"],
  );
  assert.equal(files.filter((file) => file.endsWith(".png")).length, 3);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const captures = row.screenshots.map((file) => {
    const resolved = realpathSync(file);
    assert.ok(resolved.startsWith(`${evidence}${path.sep}`));
    const bytes = readFileSync(resolved);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1440);
    assert.equal(bytes.readUInt32BE(20), 900);
    return { path: path.relative(evidence, resolved), sha256: hash(bytes) };
  });
  writeFileSync(
    path.join(evidence, "qualified-browser-green.json"),
    JSON.stringify(
      {
        status: "chat-identity-refresh-passed",
        observed: row.observed,
        sender: row.sender,
        controls: row.controls,
        responses: row.responses,
        captures,
        captureInspection: "pending full synthetic-image inspection",
        artifactInventory: files.map((file) => ({
          path: path.relative(evidence, file),
          sha256: hash(readFileSync(file)),
        })),
      },
      null,
      2,
    ),
  );
}
