import assert from "node:assert/strict";
import { readCompletedReport } from "./completed-report.mjs";
import { readNativeBlob } from "./native-blob.mjs";

const [phase, owner, reportPath, logPath, rawCode, file] = process.argv.slice(2);
assert(["baseline", "candidate"].includes(phase));
assert(["install", "update", "profile"].includes(owner));
const expectedFile =
  owner === "profile" ? "src/cli/profile.test.ts" : `src/cli/plugins-cli.${owner}.test.ts`;
assert.equal(file, expectedFile);
const { report, log } = readCompletedReport(reportPath, logPath);
const native = readNativeBlob(
  reportPath.replace(/\.json$/, ".blob.json"),
  `${reportPath}.capture.json`,
  report,
  phase,
);
assert.equal(report.testResults.length, 1);
assert(report.testResults[0].name.replaceAll("\\", "/").endsWith(`/${file}`));
assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
assert.equal(report.wasInterrupted ?? false, false);
const starts = [...log.matchAll(/^\[test\] starting (.+)$/gm)];
assert.equal(starts.length, 1, "Expected exactly one native project invocation");
assert(native.capture.projects[0].config.replaceAll("\\", "/").endsWith(`/${starts[0][1]}`));
const ends = [...log.matchAll(/^\[test\] (passed|failed) 1 Vitest shard in .+$/gm)];
assert.equal(ends.length, 1, "Missing single native project completion");
assert.equal(ends[0][1], phase === "baseline" ? "failed" : "passed");
const rows = report.testResults[0].assertionResults;
const active = rows.filter((test) => test.status !== "skipped");
const cases =
  owner === "install"
    ? [
        ["default", "openclaw"],
        ["profile", "openclaw --profile work"],
        ["container", "openclaw --container demo"],
        ["container before profile", "openclaw --container demo"],
      ]
    : owner === "update"
      ? [
          ["missing", "openclaw"],
          ["preview", "openclaw"],
          ["object-name", "openclaw"],
          ["npm-spec", "openclaw"],
          ["profile", "openclaw --profile work"],
          ["profile preview", "openclaw --profile work"],
          ["container", "openclaw --container demo"],
          ["container preview", "openclaw --container demo"],
          ["container before profile", "openclaw --container demo"],
          ["container before profile preview", "openclaw --container demo"],
        ]
      : [];
let expectedFailures = 0;
for (const [label, prefix] of cases) {
  const fullName =
    owner === "install"
      ? `plugins cli install preserves ${label} context in duplicate-install recovery guidance`
      : `plugins cli update rejects untracked update target with ${label} guidance`;
  const matches = active.filter((row) => row.fullName === fullName);
  assert.equal(matches.length, 1, fullName);
  const test = matches[0];
  const intendedFailure = phase === "baseline" && prefix !== "openclaw";
  assert.equal(test.status, intendedFailure ? "failed" : "passed", fullName);
  if (intendedFailure) {
    expectedFailures += 1;
    const matches = native.rows.filter((row) => row.fullName === fullName);
    assert.equal(matches.length, 1, fullName);
    assert.equal(matches[0].errors.length, 1, fullName);
    const error = matches[0].errors[0];
    assert.equal(error.name, "AssertionError");
    if (owner === "install") {
      assert.equal(
        error.expected,
        `Use \`${prefix} plugins update <id-or-npm-spec>\` to upgrade the tracked plugin, or rerun install with \`--force\` to replace it.`,
      );
      assert.equal(
        error.actual,
        "plugin already exists: /home/openclaw/.openclaw/extensions/lossless-claw (delete it first)\nUse `openclaw plugins update <id-or-npm-spec>` to upgrade the tracked plugin, or rerun install with `--force` to replace it.",
      );
    } else {
      assert.equal(
        error.expected,
        `No tracked plugin or hook pack found for "missing-plugin". Run "${prefix} plugins list" or "${prefix} hooks list" to inspect installed packages.`,
      );
      assert.equal(
        error.actual,
        'No tracked plugin or hook pack found for "missing-plugin". Run "openclaw plugins list" or "openclaw hooks list" to inspect installed packages.',
      );
    }
  }
}
if (phase === "baseline") {
  assert.notEqual(owner, "profile");
  assert.equal(active.length, cases.length);
  assert.equal(Number(rawCode), 1);
  assert.equal(report.success, false);
  assert.equal(report.numFailedTests, expectedFailures);
  assert.equal(report.numPassedTests, cases.length - expectedFailures);
} else {
  assert.equal(Number(rawCode), 0);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert(active.length > 0);
  assert(active.every((row) => row.status === "passed"));
}
process.stdout.write(
  `${JSON.stringify(
    {
      phase,
      owner,
      file,
      total: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests,
      protectedCases: cases.length,
      expectedFailures,
      completed: true,
      logBytes: Buffer.byteLength(log),
      nativePid: native.capture.pid,
      nativeEnded: native.capture.ended,
    },
    null,
    2,
  )}\n`,
);
