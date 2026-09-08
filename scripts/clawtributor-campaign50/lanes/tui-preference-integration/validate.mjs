import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [lane, evidence] = process.argv.slice(2);
const read = (name) => readFileSync(path.join(evidence, name), "utf8");
const input = (name) => JSON.parse(readFileSync(path.join(lane, name), "utf8"));
assert.equal(read("fixture-lint-exit.txt").trim(), "0");
assert.equal(read("groups-exit.txt").trim(), "0");
const clean = (text) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
const log = clean(read("groups.log"));
assert.doesNotMatch(
  log,
  /Failed Suites|EnvironmentTeardownError|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|globalSetup|globalTeardown|Some tests are still running when generating the JSON report|\[test\] retrying|no-output timeout|heap out of memory|\[test\] FAILED|failed to spawn|end \(exit (?!0\))[0-9]+/i,
);
const original = input("ORIGINAL-NODE-GROUPS.json");
const selected = input("SELECTED-NODE-GROUPS.json");
const expectedCases = input("ORIGINAL-PREFERENCE-CASES.json");
const target = "ui/src/app/settings.preferences.node.test.ts";
assert.equal(expectedCases.length, 28);
assert.deepEqual(selected, [{ ...original[1], includePatterns: [target] }]);
const plan = selected[0];
const markers = [...log.matchAll(/^\[shard:([^\n]+)\] (begin|end \(exit ([^)]*)\))$/gm)];
assert.deepEqual(
  markers.map((m) => [m[1], m[2]]),
  [
    [plan.shard_name, "begin"],
    [plan.shard_name, "end (exit 0)"],
  ],
);
assert.match(
  log,
  /\[shard:resources\] logicalCpuCount=\d+ totalMemoryBytes=\d+ requested plans=1 admitted plans=1/,
);
const prefix = `[shard:${plan.shard_name}] `;
const lines = log
  .split("\n")
  .filter((line) => line.startsWith(prefix))
  .map((line) => line.slice(prefix.length));
const text = lines.join("\n");
const summary = (label) => {
  const values = [
    ...text.matchAll(new RegExp(`^\\s*${label}\\s+([^\\n]+) \\((\\d+)\\)\\s*$`, "gm")),
  ];
  assert.equal(values.length, 1, label);
  return values[0];
};
const files = summary("Test Files");
const tests = summary("Tests");
assert.equal(files[1].trim(), "1 passed");
assert.equal(Number(files[2]), 1);
assert.equal(tests[1].trim(), "28 passed");
assert.equal(Number(tests[2]), 28);
assert.equal([...text.matchAll(/^\s*Duration\s+\S.+$/gm)].length, 1);
assert.equal(
  lines.filter((line) => line === "[vitest-workers] verifying completed generation before cleanup")
    .length,
  1,
);
assert.doesNotMatch(text, /^\s*Errors\s+[1-9]|^\s*(?:FAIL|×)\s/m);
const completedCases = lines.flatMap((line) => {
  const match = line.match(/^\s*✓\s+ui\s+(\S+)\s+>\s+(.+)$/);
  if (!match) return [];
  assert.equal(match[1], target);
  return [match[2].replace(/\s+\d+(?:\.\d+)?(?:ms|s)\s*$/, "").trim()];
});
assert.deepEqual(completedCases, expectedCases);
const lint = clean(read("fixture-lint.log"));
assert.doesNotMatch(
  lint,
  /\[oxlint[^\]]*\] (?:FAILED|failed)|skipping oxlint|no present sparse-checkout targets|File has too many lines|eslint\(max-lines\)/i,
);
assert.ok(lint.trim().length > 0);
writeFileSync(
  path.join(evidence, "accepted.json"),
  JSON.stringify(
    {
      accepted: true,
      scope: "Existing preference-owner file and fixture lint only",
      file: target,
      passed: 28,
      skipped: 0,
      originalCaseOrder: true,
      completedCases,
      completedGeneration: true,
      zeroUnhandledErrors: true,
      fixtureLintPassed: true,
      agenticGroupRerun: false,
      fullUiGroupProved: false,
      fullCiShardProved: false,
    },
    null,
    2,
  ) + "\n",
);
