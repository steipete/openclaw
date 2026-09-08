import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCompletedReport } from "./completed-report.mjs";
const evidence = realpathSync(process.argv[2]);
assert.equal(Number(process.argv[3]), 1);
const { report, log } = readCompletedReport(
  path.join(evidence, "vitest.json"),
  path.join(evidence, "browser.log"),
);
assert.doesNotMatch(log, /run (?:was |is )?queued|unfinished|timed out|test timed out/i);
assert.equal(report.numTotalTests, 1);
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.testResults.length, 1);
const results = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(results.length, 1);
assert.equal(
  results[0].title,
  "refreshes the visible chat identity after a successful config change",
);
assert.equal(results[0].status, "failed");
assert.equal(results[0].failureMessages.length, 1);
assert.match(results[0].failureMessages[0], /config identity display follows committed identity/);
assert.match(results[0].failureMessages[0], /identity-config-refresh\.e2e\.test\.ts/);
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
  name: "Atlas",
  avatar: "🦞",
  avatarLabel: "Atlas",
  placeholder: "Message Atlas",
});
assert.equal(row.sender, "Atlas");
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
  path.join(evidence, "qualified-baseline.json"),
  JSON.stringify(
    {
      status: "expected-stale-pane-identity",
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
