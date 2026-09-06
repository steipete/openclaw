#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in red|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
cd "$target_dir"
if [[ "$mode" == green ]]; then
  git apply --check "$lane_dir/candidate.patch"
  git apply "$lane_dir/candidate.patch"
fi
if [[ "$mode" == red ]]; then
  git apply --check "$lane_dir/unit-regression.patch"
  git apply "$lane_dir/unit-regression.patch"
fi
set +e
node scripts/run-vitest.mjs src/cli/qr-cli.test.ts -t 'prints the requested output for' \
  --reporter=json --outputFile="$evidence_dir/unit.json" > "$evidence_dir/unit.log" 2>&1
unit_exit=$?
set -e
node - "$evidence_dir/unit.json" "$mode" "$unit_exit" <<'NODE'
const fs = require('node:fs');
const [file, mode, exit] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const cases = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped');
const failures = cases.filter(test => test.status === 'failed');
if (mode === 'red') {
  if (exit !== '1' || cases.length !== 4 || failures.length !== 2 || !failures.every(test => test.failureMessages.join('\n').includes('QR_JSON_WRITER_NOT_REACHED'))) {
    throw new Error('Baseline did not reproduce exactly two combined-flag JSON writer failures');
  }
} else if (exit !== '0' || cases.length !== 4 || failures.length !== 0) {
  throw new Error('Candidate did not pass all four owner output modes');
}
console.log(`QR_OWNER_${mode.toUpperCase()}_CONFIRMED`);
NODE
pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/probe.mjs" "$target_dir" "$evidence_dir" "$mode" > "$evidence_dir/probe.log" 2>&1

if [[ "$mode" == green ]]; then
  node scripts/run-vitest.mjs src/cli/qr-cli.test.ts --reporter=json --outputFile="$evidence_dir/full-owner.json" > "$evidence_dir/owner-tests.log" 2>&1
  OPENCLAW_E2E_SKIP_BUILD=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts test/cli-json-stdout.e2e.test.ts -t 'keeps combined .* output flags as one JSON document on stdout' --reporter=json --outputFile="$evidence_dir/committed-e2e.json" > "$evidence_dir/committed-e2e.log" 2>&1
  node --input-type=module - "$evidence_dir/full-owner.json" "$evidence_dir/committed-e2e.json" <<'VERIFY_GREEN'
import assert from "node:assert/strict";
import fs from "node:fs";
for (const [index, file] of process.argv.slice(2).entries()) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.testResults[0].message, "");
  const cases = report.testResults[0].assertionResults.filter(test => test.status !== "pending" && test.status !== "skipped");
  assert.equal(cases.length, index === 0 ? 30 : 2);
  for (const test of cases) {
    assert.equal(test.status, "passed");
    if (index === 1) assert.match(test.title, /^keeps combined '(?:qr|clawbot qr)' output flags as one JSON document on stdout$/);
  }
}
console.log("QR_COMMITTED_REGRESSIONS_GREEN: 30 owner cases and two built-CLI cases passed");
VERIFY_GREEN
  git diff --check
  sha256sum src/cli/qr-cli.ts src/cli/qr-cli.test.ts test/cli-json-stdout.e2e.test.ts docs/cli/qr.md > "$evidence_dir/candidate-files.sha256"
  git diff > "$evidence_dir/candidate.patch"
fi
