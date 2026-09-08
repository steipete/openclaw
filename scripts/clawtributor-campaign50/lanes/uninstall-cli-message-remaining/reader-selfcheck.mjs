import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOwnerReport } from "./read-owner-report.mjs";

const lane = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.join(lane, "cases.json"), "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-reader-data-"));
const reportFile = path.join(root, "report.json");
const logFile = path.join(root, "report.log");
const expectedFile = "/synthetic/source/src/commands/uninstall.test.ts";
const report = {
  success: true,
  numTotalTestSuites: 2,
  numPassedTestSuites: 2,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 22,
  numPassedTests: 3,
  numFailedTests: 0,
  numPendingTests: 19,
  numTodoTests: 0,
  testResults: [
    {
      name: expectedFile,
      status: "passed",
      message: "",
      assertionResults: contract.allNames.map((fullName) => ({
        fullName,
        ancestorTitles: ["uninstallCommand"],
        title: fullName.slice("uninstallCommand ".length),
        status: contract.activeNames.includes(fullName) ? "passed" : "skipped",
        failureMessages: [],
      })),
    },
  ],
};
const log =
  " Test Files  1 passed (1)\n      Tests  3 passed | 19 skipped (22)\n   Duration  1.00s (transform 0.10s)\n";
let rejected = 0;
function check(value, text = log) {
  fs.writeFileSync(reportFile, JSON.stringify(value));
  fs.writeFileSync(logFile, text);
  return readOwnerReport(reportFile, logFile, expectedFile, contract);
}
try {
  const accepted = check(report);
  assert.equal(accepted.passed, 3);
  assert.equal(accepted.skipped, 19);
  const mutations = [
    (value) => {
      value.success = false;
    },
    (value) => {
      value.numPassedTests = 4;
    },
    (value) => {
      value.numPendingTests = 18;
    },
    (value) => {
      value.numTotalTests = 21;
    },
    (value) => {
      value.numTotalTestSuites = 1;
    },
    (value) => {
      value.testResults[0].status = "failed";
    },
    (value) => {
      value.testResults[0].message = "afterAll failed";
    },
    (value) => {
      value.testResults[0].assertionResults[0].status = "pending";
    },
    (value) => {
      value.testResults[0].assertionResults[0].failureMessages = ["hidden failure"];
    },
    (value) => {
      value.testResults[0].assertionResults[1].fullName = "uninstallCommand unrelated case";
    },
    (value) => {
      value.testResults[0].assertionResults[1].ancestorTitles = [];
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => check(changed));
    rejected++;
  }
  for (const text of [
    log.replace("3 passed", "4 passed"),
    log.replace("   Duration  1.00s (transform 0.10s)\n", ""),
    `${log}WARNING: Some tests are still running when generating the JSON report.This is likely an internal bug in Vitest.\n`,
    `${log}⎯⎯⎯ Failed Suites 1 ⎯⎯⎯\n`,
    `${log}EnvironmentTeardownError: synthetic diagnostic\n`,
    `${log}[test] retrying synthetic after no-output timeout\n`,
  ]) {
    assert.throws(() => check(report, text));
    rejected++;
  }
  process.stdout.write(
    `${JSON.stringify({ dataOnly: true, targetImports: false, accepted: 1, rejected, originalCases: 22, active: 3, filtered: 19 })}\n`,
  );
} finally {
  fs.rmSync(root, { recursive: true });
}
