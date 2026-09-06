#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in red|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
cd "$target_dir"
test "$(git rev-parse HEAD)" = 76fb700f1322bc5d8d03ec6f9a63d0d637668aa7
git apply --check "$lane_dir/unit-regression.patch"
git apply "$lane_dir/unit-regression.patch"
if [[ "$mode" == green ]]; then
  git apply --check "$lane_dir/candidate-production.patch"
  git apply "$lane_dir/candidate-production.patch"
fi
set +e
node scripts/run-vitest.mjs src/gateway/worker-environments/transcript-commit.test.ts \
  -t "commits a non-default agent's global session" \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/unit.json" > "$evidence_dir/unit.log" 2>&1
unit_exit=$?
set -e
node - "$evidence_dir/unit.json" "$mode" "$unit_exit" "$evidence_dir/unit.log" <<'VERIFY'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [file, mode, code, logFile] = process.argv.slice(2);
const log = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
for (const title of ['Test Files', 'Tests', 'Start at', 'Duration']) {
  assert.match(log, new RegExp(`^\\s*${title}\\s+\\S`, 'm'), `Missing completed verbose summary: ${title}`);
}
assert.doesNotMatch(log, /Vitest caught \d+ unhandled errors?|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites \d+/);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.ok(report.testResults.every(file => file.message === ''), 'Unexpected suite runtime error');
const cases = report.testResults.flatMap(file => file.assertionResults)
  .filter(test => !['pending', 'skipped'].includes(test.status));
assert.equal(cases.length, 1);
if (mode === 'red') {
  assert.equal(code, '1');
  assert.equal(cases[0].status, 'failed');
  assert.equal(cases[0].failureMessages.length, 1);
  assert.match(cases[0].failureMessages.join('\n'), /WORKER_OWNER_COMMIT_139216/);
} else {
  assert.equal(code, '0');
  assert.equal(report.success, true);
  assert.equal(cases[0].status, 'passed');
}
console.log(`WORKER_OWNER_COMMIT_${mode.toUpperCase()}_CONFIRMED`);
VERIFY
bash "$lane_dir/run-wire.sh" "$target_dir" "$lane_dir" "$evidence_dir/wire" "$mode"
if [[ "$mode" == green ]]; then
  node scripts/run-vitest.mjs \
    src/gateway/worker-environments/transcript-commit.test.ts \
    src/gateway/worker-environments/inference-runtime.test.ts \
    src/gateway/worker-environments/live-events.test.ts \
    src/gateway/server-methods/sessions.abort-agent-scope.test.ts \
    src/config/sessions/combined-store-gateway.test.ts \
    --reporter=json --outputFile="$evidence_dir/scoped.json" > "$evidence_dir/scoped.log" 2>&1
  node scripts/check-changed.mjs --base 76fb700f1322bc5d8d03ec6f9a63d0d637668aa7 -- \
    src/gateway/worker-environments/session-target.ts \
    src/gateway/worker-environments/inference-runtime.ts \
    src/gateway/worker-environments/transcript-commit.test.ts > "$evidence_dir/changed.log" 2>&1
  git diff --numstat > "$evidence_dir/numstat.txt"
  git diff > "$evidence_dir/candidate.patch"
fi
