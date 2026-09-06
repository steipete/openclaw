import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [jsonPath, logPath, stage, exitCode, ownerTest] = process.argv.slice(2);
assert.ok(["baseline", "candidate"].includes(stage));
const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const log = fs.readFileSync(logPath, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
assert.doesNotMatch(
  log,
  /Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites\s+\d+/,
);
assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
assert.equal(report.unhandledErrors?.length ?? 0, 0);
const files = new Map(report.testResults.map((file) => [path.basename(file.name), file]));
assert.equal(files.size, stage === "baseline" ? 1 : 6);
for (const file of files.values()) {
  assert.equal(file.message, "", file.name);
}
const executed = report.testResults.flatMap((file) =>
  file.assertionResults.filter((test) => ["passed", "failed"].includes(test.status)),
);
const failures = executed.filter((test) => test.status === "failed");
if (stage === "baseline") {
  assert.equal(exitCode, "1");
  assert.equal(failures.length, 2);
  const capture = JSON.parse(fs.readFileSync(`${jsonPath}.capture.json`, "utf8"));
  assert.equal(capture.processTimedOut, false);
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.passWithNoTests, false);
  assert.deepEqual(capture.ended, {
    reason: "failed",
    unhandledErrors: 0,
    failedModules: 1,
    suiteErrors: 0,
  });
  assert.equal(capture.modules.length, 1);
  assert.equal(path.relative(capture.root, capture.modules[0].file), ownerTest);
  assert.equal(report.testResults[0].name, capture.modules[0].file);
  const expected = new Map([
    ["gateway-port-option.test.ts", [8, "rejects invalid port value", /to throw an error/]],
    [
      "gateway-rpc.runtime.test.ts",
      [3, "rejects invalid target", /promise resolved[\s\S]*instead of rejecting/],
    ],
    [
      "register.onboard.test.ts",
      [
        4,
        "rejects invalid --gateway-port",
        /--gateway-port must be an integer between 1 and 65535/,
      ],
    ],
    [
      "register.setup.test.ts",
      [
        4,
        "rejects invalid --gateway-port",
        /--gateway-port must be an integer between 1 and 65535/,
      ],
    ],
  ]);
  const name = path.basename(ownerTest);
  assert.ok(expected.has(name), name);
  const [count, prefix, pattern] = expected.get(name);
  const tests = files
    .get(name)
    ?.assertionResults.filter((test) => ["passed", "failed"].includes(test.status));
  assert.equal(tests?.length, count, name);
  const failed = tests.filter((test) => test.status === "failed");
  assert.equal(failed.length, 2, name);
  assert.equal(new Set(failed.map((test) => test.title)).size, 2, name);
  for (const test of failed) {
    assert.ok(test.title.startsWith(prefix), test.title);
    if (name === "gateway-rpc.runtime.test.ts") {
      assert.doesNotMatch(test.title, /url/);
      const port = test.title.match(/["']?port["']?\s*:\s*(["'])(.*?)\1/s);
      assert.ok(port, test.title);
      assert.match(port[2], /^(?:\s|\\t)*$/);
    } else {
      const value = test.title.slice(prefix.length).replace(/ before onboarding dispatch$/, "");
      assert.equal(value.trim(), "", test.title);
    }
    assert.match(test.failureMessages.join("\n").replace(/\u001b\[[0-9;]*m/g, ""), pattern);
  }
  console.log(`GATEWAY_PORT_UNIT_BASELINE_OWNER_RED: ${ownerTest} has two blank-input failures`);
} else {
  assert.equal(exitCode, "0");
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(failures.length, 0);
  assert.ok(executed.length > 19);
  assert.equal(
    executed.filter((test) =>
      /^(?:rejects invalid port value|rejects invalid target|rejects invalid --gateway-port)/.test(
        test.title,
      ),
    ).length,
    19,
  );
  for (const name of [
    "gateway-port-option.test.ts",
    "gateway-rpc.runtime.test.ts",
    "register.onboard.test.ts",
    "register.setup.test.ts",
    "logs-cli.port.test.ts",
    "route-args.test.ts",
  ]) {
    const file = files.get(name);
    assert.ok(
      file?.assertionResults.some((test) => test.status === "passed"),
      name,
    );
  }
  console.log(
    `GATEWAY_PORT_UNIT_CANDIDATE_GREEN: ${executed.length} owner and sibling assertions passed`,
  );
}
