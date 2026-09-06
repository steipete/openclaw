import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [phase, evidenceDir] = process.argv.slice(2);
assert.ok(phase === "baseline" || phase === "candidate");
const canonicalKeyError = /store key must use one canonical relative spelling/;
const cases = {
  fetch: new Map([
    [
      "keeps the canonical basename through real staging and forwarding: \u1100\u1161.txt",
      canonicalKeyError,
    ],
  ]),
  store: new Map([
    ["normalizes decomposed Hangul in stored …", canonicalKeyError],
    ["normalizes letters joined by filename s…", canonicalKeyError],
    ["preserves decomposed accents in stored …", /to match/],
    ["composes Unicode before applying the fi…", /to match/],
    ["normalizes original filename while dete…", /to match/],
  ]),
};
for (const [name, expectedFailures] of Object.entries(cases)) {
  const prefix = path.join(evidenceDir, `${phase}-${name}`);
  const report = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  const log = fs.readFileSync(`${prefix}.log`, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(
    log,
    /Vitest caught \d+ unhandled|Unhandled (?:Errors|Rejection)|Uncaught Exception|Failed Suites\s+\d+/i,
  );
  assert.match(log, /^\s*Test Files\s+\S/m, "missing completed test summary");
  assert.match(log, /^\s*Tests\s+\S/m, "missing completed assertion summary");
  assert.match(log, /^\s*Duration\s+\d+(?:\.\d+)?(?:ms|s)\b/m, "missing completed duration");
  assert.equal(report.testResults.length, 1);
  assert.equal(report.testResults[0].message, "");
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  const tests = report.testResults[0].assertionResults;
  if (phase === "baseline") {
    assert.equal(report.success, false);
    assert.equal(report.numFailedTests, expectedFailures.size);
    const failed = tests.filter((test) => test.status === "failed");
    assert.deepEqual(failed.map((test) => test.title).sort(), [...expectedFailures.keys()].sort());
    for (const test of tests) {
      const expectedError = expectedFailures.get(test.title);
      if (expectedError) {
        assert.equal(test.failureMessages.length, 1, test.title);
        assert.match(test.failureMessages[0], expectedError);
      } else assert.equal(test.status, "passed");
    }
  } else {
    assert.equal(report.success, true);
    assert.equal(report.numFailedTests, 0);
    const before = JSON.parse(
      fs.readFileSync(path.join(evidenceDir, `baseline-${name}.json`), "utf8"),
    );
    assert.deepEqual(
      tests.map((test) => test.title).sort(),
      before.testResults[0].assertionResults.map((test) => test.title).sort(),
    );
    for (const test of tests) assert.equal(test.status, "passed");
  }
  if (name === "fetch") {
    assert.equal(tests.length, 23);
    assert.equal(tests.filter((test) => test.title.includes("real staging")).length, 5);
  }
  console.log(
    JSON.stringify({
      phase,
      suite: name,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
    }),
  );
}
console.log(
  phase === "baseline"
    ? "FILE_FETCH_NFC_RED: canonical key and normalized-name failures reproduced"
    : "FILE_FETCH_NFC_GREEN: real Unicode staging, bytes, filename limits, and stream sibling verified",
);
