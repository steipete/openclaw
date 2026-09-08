import assert from "node:assert/strict";
export function assertNoRunnerRecovery(log) {
  assert.doesNotMatch(log, /\[test\]\s+retrying\b|no-output timeout|FATAL ERROR:|out of memory/i);
  assert.doesNotMatch(
    log,
    /JSON report was generated while.*(?:running|pending)|some tests are still running/i,
  );
}
export function assertIntendedFailure(messages, id) {
  assert.equal(messages.length, 1);
  const firstLine = messages[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split("\n")[0];
  assert.ok(firstLine.startsWith(`AssertionError: C141548_DEFAULT_DISPLAY:${id}:`));
  assert.doesNotMatch(
    messages[0],
    /Timeout|Error: Expected an initialized|AggregateError|cleanup failed/,
  );
}
