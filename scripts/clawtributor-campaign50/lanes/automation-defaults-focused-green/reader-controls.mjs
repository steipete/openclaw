import assert from "node:assert/strict";
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
const missing = "AssertionError: expected undefined to be 'Default: On' // Object.is equality";
assertMissingDefault([missing]);
for (const messages of [[], [missing, "extra failure"], [`Error: setup failed\n${missing}`]]) {
  assert.throws(() => assertMissingDefault(messages), assert.AssertionError);
}
console.log(
  JSON.stringify({
    scope: "inert reader controls only; no browser or product execution",
    positive: 3,
    rejectedDiagnostics: diagnostics.length,
    rejectedFailureShapes: 7,
  }),
);
