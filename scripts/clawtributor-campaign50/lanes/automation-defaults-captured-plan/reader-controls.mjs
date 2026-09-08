import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertIntendedFailure,
  assertMissingDefault,
  assertNoRunnerRecovery,
} from "./reader-guards.mjs";
assertNoRunnerRecovery("Test Files 1 failed (1)\nTests 4 failed | 2 passed (6)\nDuration 1s");
const diagnostics = [
  "[test] retrying failed batch",
  "no-output timeout",
  "FATAL ERROR: simulated diagnostic",
  "JavaScript heap out of memory",
  "JSON report was generated while tests are still running",
  "JSON report was generated while tests are pending",
  "some tests are still running",
];
for (const diagnostic of diagnostics)
  assert.throws(() => assertNoRunnerRecovery(diagnostic), assert.AssertionError);
const intended =
  "AssertionError: C141548_DEFAULT_DISPLAY:absent-parents: expected switches to equal inherited selectors";
assertIntendedFailure([intended], "absent-parents");
for (const messages of [
  [],
  [intended, "extra error"],
  [`Error: setup failed\n${intended}`],
  [intended.replace("absent-parents", "empty-cron")],
]) {
  assert.throws(() => assertIntendedFailure(messages, "absent-parents"), assert.AssertionError);
}
const observed = JSON.parse(
  readFileSync(new URL("./reuse/unit-red.json", import.meta.url), "utf8"),
).testResults[0].assertionResults.filter((test) => test.status === "failed");
assert.equal(observed.length, 2);
for (const test of observed) assertMissingDefault(test.failureMessages);
const missing = observed[0].failureMessages[0];
const badDiagnostics = [
  [],
  [missing, "extra failure"],
  [`Error: setup failed\n${missing}`],
  ["Error: Test timed out in 10000ms.\n    at runWithTimeout (vitest.js:1:1)"],
  ["Error: Hook timed out in 10000ms.\n    at runWithTimeout (vitest.js:1:1)"],
  [`${missing}\nError: Test timed out in 10000ms.`],
  [`${missing}\nAggregateError: cleanup failed`],
];
for (const messages of badDiagnostics)
  assert.throws(() => assertMissingDefault(messages), assert.AssertionError);
console.log(
  JSON.stringify({
    scope: "inert reader controls only; no browser or product execution",
    positive: 4,
    rejectedDiagnostics: diagnostics.length,
    rejectedFailureShapes: 11,
  }),
);
