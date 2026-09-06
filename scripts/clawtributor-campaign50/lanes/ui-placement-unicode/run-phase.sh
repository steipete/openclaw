#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in red|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
cd "$target_dir"
expected_base=$(cat "$lane_dir/proof-source-base.txt")
[[ "$(git rev-parse HEAD)" == "$expected_base" ]] || exit 65
cp "$lane_dir/session-placement-recovery.test.ts" ui/src/pages/new-session/session-placement-recovery.test.ts
cp "$lane_dir/placement-error-unicode.e2e.test.ts" ui/src/e2e/placement-error-unicode.e2e.test.ts
if [[ "$mode" == green ]]; then
  git apply --check "$lane_dir/candidate-production.patch"
  git apply "$lane_dir/candidate-production.patch"
  node scripts/run-vitest.mjs ui/src/pages/new-session/session-placement-recovery.test.ts \
    ui/src/pages/new-session/session-placement-submit.test.ts \
    ui/src/lib/sessions/session-placement-startup.test.ts \
    > "$evidence_dir/focused.log" 2>&1
fi
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
# The owning E2E setup builds fresh production source into its own temporary bundle.
set +e
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/placement-error-unicode.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/browser.log" 2>&1
proof_exit=$?
set -e
node - "$evidence_dir/vitest.json" "$evidence_dir/browser.log" "$mode" "$proof_exit" <<'NODE'
const fs = require('node:fs');
const [file, logFile, mode, code] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const log = fs.readFileSync(logFile, 'utf8').replace(/\u001b\[[0-9;]*m/g, '');
const expectedNames = [false, true].map(value =>
  `Placement error Unicode boundary retains a readable bounded dispatch failure (pause write fails: ${value})`);
const cases = report.testResults.flatMap(file => file.assertionResults);
if (report.testResults.length !== 1 || report.testResults.some(file => file.message !== '') ||
    report.numTotalTests !== 2 || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
    cases.length !== 2 || [...cases.map(test => test.fullName)].sort().join('\n') !== expectedNames.sort().join('\n')) {
  throw new Error('Unexpected placement boundary test inventory or suite error');
}
// The pinned verbose reporter exposes hook/global errors omitted by JSON assertions.
if (/Failed Suites|Unhandled (?:Errors?|Rejections?|Exceptions?)|Uncaught Exception|globalSetup|globalTeardown|global[- ](?:setup|teardown).*?(?:error|fail)|^\s*Errors\s+[1-9]/im.test(log) ||
    !/^\s*Duration\s+\S.+$/m.test(log)) {
  throw new Error('Browser run has suite/global diagnostics or lacks a completed verbose summary');
}
const failures = cases.filter(test => test.status === 'failed');
if (mode === 'red') {
  const marker = 'Error: PLACEMENT_ERROR_UTF16_SPLIT_137649: rendered pause diagnostic contains a split surrogate';
  if (code !== '1' || report.success !== false || report.numFailedTests !== 2 || report.numPassedTests !== 0 ||
      !/^\s*Test Files\s+1 failed \(1\)\s*$/m.test(log) ||
      !/^\s*Tests\s+2 failed \(2\)\s*$/m.test(log) ||
      failures.length !== 2 || failures.some(test => test.failureMessages.length !== 1 ||
        test.failureMessages[0].split('\n')[0] !== marker ||
        test.failureMessages[0].split('\n').slice(1).some(line => line.trim() && !/^\s+at /.test(line)))) {
    throw new Error('Baseline must contain only two exact rendered surrogate-split failures with exit1');
  }
  console.log('PR137649_RED_CONFIRMED: both placement error boundaries split UTF16 in the bundled UI');
} else {
  if (code !== '0' || report.success !== true || report.numPassedTests !== 2 || report.numFailedTests !== 0 ||
      !/^\s*Test Files\s+1 passed \(1\)\s*$/m.test(log) ||
      !/^\s*Tests\s+2 passed \(2\)\s*$/m.test(log) ||
      cases.some(test => test.status !== 'passed' || test.failureMessages.length !== 0)) {
    throw new Error('Candidate must pass both placement error browser flows without suite/global failures');
  }
  console.log('PR137649_GREEN_CONFIRMED: both bounded diagnostics remain well formed and recovery remains intact');
}
NODE
if [[ "$mode" == green ]]; then
  node scripts/check-changed.mjs --base "$expected_base" -- \
    ui/src/lib/sessions/session-placement-recovery.ts \
    ui/src/pages/new-session/session-placement-recovery.test.ts \
    ui/src/e2e/placement-error-unicode.e2e.test.ts > "$evidence_dir/changed-check.log" 2>&1
  sha256sum ui/src/lib/sessions/session-placement-recovery.ts \
    ui/src/pages/new-session/session-placement-recovery.test.ts \
    ui/src/e2e/placement-error-unicode.e2e.test.ts > "$evidence_dir/candidate-files.sha256"
  sha256sum --check "$lane_dir/candidate-files.sha256"
  git diff --check
fi
