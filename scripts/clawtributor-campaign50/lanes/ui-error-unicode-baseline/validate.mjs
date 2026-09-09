import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompletedReport } from "./completed-report.mjs";

const [evidence, actualExit] = process.argv.slice(2);
const spec = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "source.json"), "utf8"),
);
assert.equal(actualExit, "1", "Baseline must fail its intended assertions");
const expectedError = /^(?:AssertionError: )?expected true to be false \/\/ Object\.is equality$/;
const { report } = readCompletedReport(
  path.join(evidence, "browser.json"),
  path.join(evidence, "browser.log"),
  expectedError,
);
assert.equal(report.success, false);
assert.equal(report.numTotalTests, 2);
assert.equal(report.numPassedTests, 0);
assert.equal(report.numFailedTests, 2);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.numTotalTestSuites, 2);
assert.equal(report.numPassedTestSuites, 0);
assert.equal(report.numFailedTestSuites, 2);
assert.equal(report.numPendingTestSuites, 0);
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.equal(file.name.endsWith(`/${spec.browserFile}`), true);
assert.equal(file.status, "failed");
assert.equal(file.message, "");
assert.deepEqual(
  file.assertionResults.map((row) => row.fullName),
  spec.testNames,
);
for (const row of file.assertionResults) {
  assert.equal(row.status, "failed");
  assert.equal(row.failureMessages.length, 1);
  assert.match(row.failureMessages[0].split("\n")[0], expectedError);
  assert.ok(row.failureMessages[0].includes(spec.browserFile));
}

const observationPaths = [];
function visit(directory) {
  for (const name of readdirSync(directory)) {
    const filePath = path.join(directory, name);
    const stat = lstatSync(filePath);
    assert.equal(stat.isSymbolicLink(), false, filePath);
    if (stat.isDirectory()) visit(filePath);
    else {
      assert.equal(stat.isFile(), true, filePath);
      if (name === "observation.json") observationPaths.push(filePath);
    }
  }
}
visit(path.join(evidence, "browser"));
assert.equal(observationPaths.length, 2);
const observations = observationPaths.map((filePath) => {
  const data = readFileSync(filePath);
  assert.ok(data.length < 16_384);
  const value = JSON.parse(data);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  assert.match(value.browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(value.brokenBoundary, true);
  assert.ok(
    Array.isArray(value.requestMethods) &&
      value.requestMethods.every((method) => typeof method === "string"),
  );
  assert.equal(
    value.requestMethods.some((method) =>
      /^(?:update\.(?:run|apply)|plugins\.controlUi\.reload)$/.test(method),
    ),
    false,
  );
  const png = readFileSync(path.join(path.dirname(filePath), "projection.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return {
    value,
    file: path.relative(evidence, filePath),
    sha256: createHash("sha256").update(data).digest("hex"),
    screenshotSha256: createHash("sha256").update(png).digest("hex"),
  };
});
assert.deepEqual(observations.map(({ value }) => value.surface).sort(), [
  "plugin-report",
  "recorded-update",
]);
const plugin = observations.find(({ value }) => value.surface === "plugin-report").value;
assert.equal(plugin.input, `${"x".repeat(511)}😀tail`);
assert.deepEqual(plugin.params, {
  pluginId: "ui-fixture",
  revision: "unicode-boundary",
  status: "failed",
  error: `${"x".repeat(511)}\ud83d`,
});
assert.ok(plugin.requestMethods.includes("plugins.controlUi.report"));
const update = observations.find(({ value }) => value.surface === "recorded-update").value;
assert.equal(update.input, `${"x".repeat(179)}😀tail`);
assert.equal(update.displayedCause, "x".repeat(179));
assert.equal(typeof update.text, "string");
assert.ok(update.text.length < 4096);
assert.match(update.text, /x{179}[\ud83d\ufffd]/u);
assert.equal(update.text.includes("😀tail"), false);
assert.ok(update.requestMethods.includes("update.status"));
assert.equal(plugin.pid, update.pid);
writeFileSync(
  path.join(evidence, "qualified-browser.json"),
  JSON.stringify(
    {
      source: spec.source,
      baselineReproduced: true,
      isFixProof: false,
      nativeExit: 1,
      failed: 2,
      passed: 0,
      testNames: spec.testNames,
      observations,
    },
    null,
    2,
  ) + "\n",
);
