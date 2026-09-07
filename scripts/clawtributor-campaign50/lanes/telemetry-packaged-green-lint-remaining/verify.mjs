import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { readCompletedReport } from "./completed-report.mjs";

const [laneDir, targetDir, evidenceDir, phase, code] = process.argv.slice(2);
const reuse = path.join(laneDir, "reuse");
const read = (root, name) => fs.readFileSync(path.join(root, name));
const json = (root, name) => JSON.parse(read(root, name));
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const base = "b8cbece8fb8de577d9ff33cedf8d8250585c55e4";
const endedPass = { reason: "passed", unhandledErrors: 0, failedModules: 0, suiteErrors: 0 };

if (phase === "reuse") {
  const lineage = json(reuse, "LINEAGE.json");
  assert.equal(lineage.run, 34094232133);
  assert.equal(lineage.job, 101654153564);
  assert.equal(lineage.harness, "ae090ea36f087591e798c86a771252a98275f25e");
  assert.equal(lineage.source, base);
  assert.equal(lineage.artifacts.length, 94);
  assert.equal(new Set(lineage.artifacts.map((entry) => entry.path)).size, 94);
  for (const entry of lineage.artifacts) {
    assert.equal(path.basename(entry.path), entry.path);
    const bytes = read(reuse, entry.path);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(hash(bytes), entry.sha256);
  }
  const run = json(reuse, "run.json");
  assert.equal(run.databaseId, lineage.run);
  assert.equal(run.headSha, lineage.harness);
  const jobs = run.jobs.filter((job) => job.databaseId === lineage.job);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].conclusion, "failure");
  assert.equal(read(reuse, "exit-code.txt").toString().trim(), "1");
  assert.equal(json(reuse, "source.json").source, base);
  const previous = json(reuse, "unit-green.json");
  assert.equal(previous.success, true);
  assert.equal(previous.numPassedTests, 290);
  assert.equal(previous.numFailedTests, 0);
  assert.equal(previous.numPendingTests, 0);
  assert.equal(previous.numTodoTests, 0);
  assert.equal(previous.testResults.length, 6);
  for (const suite of previous.testResults) {
    assert.equal(suite.status, "passed");
    assert.ok(
      suite.assertionResults.every(
        (test) => test.status === "passed" && test.failureMessages.length === 0,
      ),
    );
  }
  const index = json(reuse, "native-index.json");
  const outcome = { code: 0, signal: null, noOutputTimedOut: false, groupJoined: true };
  assert.equal(index.complete, true);
  assert.equal(index.error, "");
  assert.deepEqual(index.merge, outcome);
  assert.equal(index.entries.length, 3);
  for (let i = 0; i < 3; i++) {
    const entry = index.entries[i];
    assert.equal(entry.state, "finished");
    assert.equal(entry.acceptedAttempt, 1);
    assert.equal(entry.attempts.length, 1);
    assert.deepEqual(entry.attempts[0].outcome, outcome);
    const capture = json(reuse, `native-${i + 1}-report.json.capture.json`);
    assert.equal(capture.ignoreUnhandledErrors, false);
    assert.equal(capture.processTimedOut, false);
    assert.deepEqual(capture.ended, endedPass);
  }
  assert.deepEqual(json(reuse, "aggregate.capture.json").ended, endedPass);
  const observed = json(reuse, "observed.json");
  assert.equal(observed.source, base);
  assert.equal(observed.phase, "green-confirmed");
  assert.equal(observed.cleanupFailureCount, 0);
  assert.deepEqual(observed.cleanupFailures, []);
  assert.equal(observed.processes.length, 18);
  for (const proc of observed.processes) {
    assert.equal(proc.exitCode, ["unknown-flag", "unknown-command"].includes(proc.name) ? 1 : 0);
    assert.equal(proc.signal, null);
    assert.equal(proc.processError, null);
    for (const flag of ["timedOut", "outputLimit", "residualGroup"])
      assert.equal(proc[flag], false);
  }
  assert.equal(
    observed.tarball.sha256,
    "2345325f1c9ee3fd2d7630cd1afba968e1d2e7eadb803d56fb566c645332fa01",
  );
  const help = read(reuse, "explicit-help.stdout.log.txt").toString();
  const start = help.indexOf("Usage: openclaw telemetry [options] [command]");
  assert.ok(start >= 0);
  assert.equal(
    help.slice(0, start).trim(),
    "OpenClaw 2026.9.2 (b8cbece) — All your chats, one OpenClaw.",
  );
  assert.equal(read(reuse, "bare-telemetry.stdout.log.txt").toString(), help.slice(start));
  assert.equal(read(reuse, "bare-telemetry.stderr.log.txt").length, 0);
  const log = stripVTControlCharacters(read(reuse, "check-changed.log.txt").toString());
  const summaries = log.split("[check:changed] summary");
  assert.equal(summaries.length, 2);
  const checks = [
    ...summaries[1].matchAll(/^\s+\d+(?:\.\d+)?(?:ms|s)\s+(ok|failed:\d+)\s+(.+)$/gm),
  ].map((match) => ({ status: match[1], name: match[2] }));
  assert.equal(checks.length, 21);
  assert.ok(checks.slice(0, 20).every((check) => check.status === "ok"));
  assert.deepEqual(checks.at(-1), { status: "failed:1", name: "lint core changed files" });
  assert.equal(log.split("typescript(no-unnecessary-type-conversion)").length, 2);
  assert.ok(log.includes("src/cli/telemetry-cli.test.ts:201:20"));
  assert.ok(log.includes("Found 0 warnings and 1 error."));
  const production = read(targetDir, "src/cli/telemetry-cli.ts");
  assert.equal(hash(production), lineage.oldProduction);
  const test = read(targetDir, "src/cli/telemetry-cli.test.ts").toString();
  assert.equal(hash(test), lineage.newTest);
  const assignment = "exitCode = process.exitCode ?? 0;";
  assert.equal(test.split(assignment).length, 2);
  assert.equal(
    hash(test.replace(assignment, "exitCode = Number(process.exitCode ?? 0);")),
    lineage.oldTest,
  );
  fs.writeFileSync(
    path.join(evidenceDir, "reuse-verification.json"),
    JSON.stringify(
      {
        previousRun: lineage.run,
        previousJob: lineage.job,
        historicalTests: 290,
        historicalInstalledCliCalls: 13,
        passedEarlierGates: 20,
        unchangedProduction: true,
        testDelta: "remove Number wrapper only",
        newlyExecuted: false,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  assert.equal(phase, "tests");
  assert.equal(code, "0");
  const { report, log } = readCompletedReport(
    path.join(evidenceDir, "unit.json"),
    path.join(evidenceDir, "unit.log"),
  );
  assert.doesNotMatch(
    log,
    /Some tests are still running|\[test\] retrying|heap out of memory|no-output timeout/i,
  );
  assert.equal(report.success, true);
  assert.equal(report.numTotalTests, 13);
  assert.equal(report.numPassedTests, 13);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.testResults.length, 1);
  const suite = report.testResults[0];
  assert.ok(suite.name.replaceAll("\\", "/").endsWith("/src/cli/telemetry-cli.test.ts"));
  assert.equal(suite.status, "passed");
  assert.equal(suite.assertionResults.length, 13);
  assert.ok(
    suite.assertionResults.every(
      (test) => test.status === "passed" && test.failureMessages.length === 0,
    ),
  );
  assert.equal(
    suite.assertionResults.filter(
      (test) =>
        test.fullName ===
        "telemetry cli prints parent help with a successful exit when no subcommand is given",
    ).length,
    1,
  );
  const capture = json(evidenceDir, "unit.json.capture.json");
  assert.equal(capture.ignoreUnhandledErrors, false);
  assert.equal(capture.processTimedOut, false);
  assert.deepEqual(capture.ended, endedPass);
  assert.equal(capture.modules.length, 1);
  assert.ok(
    capture.modules[0].file.replaceAll("\\", "/").endsWith("/src/cli/telemetry-cli.test.ts"),
  );
}
console.log(`TELEMETRY_LINT_REMAINING_${phase.toUpperCase()}_VERIFIED`);
