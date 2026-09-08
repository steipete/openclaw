import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPlanContract, selectRemainingCommands } from "./plan-contract.mjs";
const lane = path.dirname(fileURLToPath(import.meta.url));
const contract = readPlanContract(lane);
const prefixCommands = contract.retainedPrefix.map((name) => ({ name, args: [] }));
const observed = [
  ...prefixCommands,
  ...contract.remainingCommands.map(({ name, bin, args }) => ({
    name,
    ...(bin ? { bin } : {}),
    args: [...args],
  })),
];
const scripts = JSON.parse(JSON.stringify(contract.packageAliases));
const result = selectRemainingCommands(observed, contract, contract.retainedPrefix, scripts);
assert.equal(observed.length, 30);
assert.equal(result.length, 13);
const rejected = [];
for (const audit of [
  "coercion helper declaration guard",
  "deprecated API usage",
  "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
]) {
  assert.throws(
    () =>
      selectRemainingCommands(
        observed.filter((command) => command.name !== audit),
        contract,
        contract.retainedPrefix,
        scripts,
      ),
    assert.AssertionError,
  );
  rejected.push(`missing ${audit}`);
}
const reordered = structuredClone(observed);
const start = contract.retainedPrefix.length;
[reordered[start + 1], reordered[start + 3]] = [reordered[start + 3], reordered[start + 1]];
assert.throws(
  () => selectRemainingCommands(reordered, contract, contract.retainedPrefix, scripts),
  assert.AssertionError,
);
rejected.push("reordered deferred audits");
const changedArgs = structuredClone(observed);
changedArgs[start + 3].args = ["--import", "tsx", "scripts/check-import-cycles.ts"];
assert.throws(
  () => selectRemainingCommands(changedArgs, contract, contract.retainedPrefix, scripts),
  assert.AssertionError,
);
rejected.push("wrong direct dead-export command");
assert.throws(
  () => selectRemainingCommands(observed, contract, contract.retainedPrefix.slice(1), scripts),
  assert.AssertionError,
);
rejected.push("wrong reused prefix");
assert.throws(
  () =>
    selectRemainingCommands(observed, contract, contract.retainedPrefix, {
      ...scripts,
      "check:coercion-helpers": "node wrong-script.mjs",
    }),
  assert.AssertionError,
);
rejected.push("wrong package alias");
console.log(
  JSON.stringify(
    {
      scope:
        "captured30 names and source-audited13 descriptors as inert data; no target plan execution",
      acceptedTotal: observed.length,
      acceptedRemaining: result.length,
      rejected,
    },
    null,
    2,
  ),
);
