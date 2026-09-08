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

export function assertMissingDefault(messages) {
  assert.equal(messages.length, 1);
  const [header, ...lines] = messages[0].split("\n");
  assert.equal(
    header,
    "AssertionError: expected undefined to be 'Default: On' // Object.is equality",
  );
  const frames = lines.filter((line) => line.trim() !== "");
  assert.ok(frames.length > 0);
  assert.ok(
    frames.every((line) => /^\s+at /.test(line)),
    "Unexpected diagnostic outside stack frames",
  );
}
