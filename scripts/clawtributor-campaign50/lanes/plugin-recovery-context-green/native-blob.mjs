import assert from "node:assert/strict";
import fs from "node:fs";

// Vitest5 BlobReporter stores a flatted table. Project native tasks without
// hydrating the cyclic module graph or executing any serialized value.
export function readNativeBlob(blobPath, capturePath, report, phase) {
  const table = JSON.parse(fs.readFileSync(blobPath, "utf8"));
  assert(Array.isArray(table) && table.length > 0);
  const ref = (key) => {
    assert(
      typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key),
      "Invalid native blob reference",
    );
    const index = Number(key);
    assert(Number.isSafeInteger(index) && index < table.length);
    return table[index];
  };
  const object = (key) => {
    const value = ref(key);
    assert(value && typeof value === "object" && !Array.isArray(value));
    return value;
  };
  const array = (key) => {
    const value = ref(key);
    assert(Array.isArray(value));
    return value;
  };
  const text = (key) => {
    const value = ref(key);
    assert.equal(typeof value, "string");
    return value;
  };
  const optionalText = (key) => (key === undefined ? undefined : text(key));
  const root = table[0];
  assert(Array.isArray(root) && root.length === 6);
  assert.equal(text(root[0]), "5.0.0");
  assert.deepEqual(array(root[2]), [], "Native blob contains unhandled errors");
  assert(Number.isFinite(root[4]) && root[4] >= 0);
  const modules = array(root[1]);
  assert.equal(modules.length, 1);
  const module = object(modules[0]);
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  assert(Number.isInteger(capture.pid) && capture.pid > 0);
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.passWithNoTests, false);
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.modules.length, 1);
  assert.equal(capture.projects.length, 1);
  const file = text(module.filepath);
  assert.equal(file, report.testResults[0].name);
  assert.equal(capture.modules[0].file, file);
  assert.equal(capture.modules[0].taskId, text(module.id));
  assert.equal(capture.modules[0].name, optionalText(module.projectName) ?? "");
  for (const key of ["name", "namePrefix", "root", "config", "pool"]) {
    assert.equal(capture.modules[0][key], capture.projects[0][key], key);
  }
  assert(
    capture.command.includes(`--outputFile.json=${capturePath.slice(0, -".capture.json".length)}`),
  );
  assert(capture.command.includes(`--outputFile.blob=${blobPath}`));
  assert.equal(capture.ended.reason, phase === "baseline" ? "failed" : "passed");
  assert.equal(capture.ended.unhandledErrors, 0);
  assert.equal(capture.ended.suiteErrors, 0);
  assert.equal(capture.ended.failedModules, phase === "baseline" ? 1 : 0);
  const statusMap = { pass: "passed", fail: "failed", skip: "skipped" };
  const rows = [];
  const visited = new Set();
  function walk(key) {
    assert(!visited.has(key), "Repeated native task");
    visited.add(key);
    const task = object(key);
    const type = text(task.type);
    if (type === "suite") {
      for (const child of array(task.tasks)) walk(child);
      return;
    }
    assert.equal(type, "test");
    const names = [];
    let parent = task.suite;
    const parents = new Set();
    while (parent !== undefined) {
      assert(!parents.has(parent), "Cyclic native suite ancestry");
      parents.add(parent);
      const suite = object(parent);
      names.unshift(text(suite.name));
      parent = suite.suite;
    }
    const name = text(task.name);
    if (name) names.push(name);
    const result = task.result === undefined ? undefined : object(task.result);
    const state = optionalText(result?.state) ?? text(task.mode);
    assert(Object.hasOwn(statusMap, state), `Native task is incomplete: ${names.join(" ")}`);
    const errors = result?.errors === undefined ? [] : array(result.errors).map(object);
    rows.push({
      id: text(task.id),
      fullName: names.join(" "),
      status: statusMap[state],
      errors: errors.map((error) => ({
        name: optionalText(error.name),
        actual: optionalText(error.actual),
        expected: optionalText(error.expected),
        failureMessage: optionalText(error.stack) || optionalText(error.message),
      })),
    });
  }
  walk(modules[0]);
  assert.equal(rows.length, report.numTotalTests);
  const inventory = (items) =>
    items.map((row) => JSON.stringify([row.fullName, row.status, row.failureMessages])).sort();
  assert.deepEqual(
    inventory(
      rows.map((row) => ({
        ...row,
        failureMessages: row.errors.map((error) => error.failureMessage),
      })),
    ),
    inventory(report.testResults[0].assertionResults),
  );
  return { rows, capture };
}
