#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in baseline|compare) ;; *) exit 64 ;; esac
cd "$target_dir"
mkdir -p "$evidence_dir"
proof_base=954d47a99a6b814da0bb31eb92adeb8603368f20
test "$(git rev-parse HEAD)" = "$proof_base"
git rev-parse HEAD > "$evidence_dir/source-sha.txt"
retain() {
  saved_exit=$?
  trap - EXIT
  for phase in baseline candidate; do
    source_dir=".artifacts/qa-e2e/campaign-noop-compaction-$phase"
    if [[ -d "$source_dir" ]]; then
      mkdir -p "$evidence_dir/$phase-artifacts"
      cp -R "$source_dir/." "$evidence_dir/$phase-artifacts/" || saved_exit=2
    fi
  done
  python3 - "$lane_dir/source-pin.json" "$evidence_dir" <<'RETAIN' || saved_exit=2
from pathlib import Path
import json,sys,shutil
pin=json.loads(Path(sys.argv[1]).read_text())
for source in pin['files']:
 target=Path(sys.argv[2])/'source'/source
 target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(source,target)
RETAIN
  git diff > "$evidence_dir/final-working-tree.patch" || saved_exit=2
  exit "$saved_exit"
}
trap retain EXIT
proof_source=$(mktemp -d "$target_dir/.proof-noop-compaction.XXXXXX")
cp "$lane_dir/noop-compaction-proof.mts" "$lane_dir/noop-context-engine-plugin.js" "$proof_source/"
verify_source() {
  node - "$lane_dir/source-pin.json" "$1" <<'VERIFY'
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [file, phase] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const [source, hashes] of Object.entries(pin.files)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), hashes[phase], `Source mismatch: ${source}`);
}
VERIFY
}
verify_source baseline
git apply --check "$lane_dir/candidate-tests.patch"
git apply "$lane_dir/candidate-tests.patch"
run_regression() {
  local phase=$1
  local key=$2
  local source=$3
  local selector=$4
  local unit_exit
  mkdir -p "$evidence_dir/$phase"
  if node scripts/run-vitest.mjs "$source" -t "$selector" --reporter=verbose --reporter=json --outputFile="$evidence_dir/$phase/$key.json" > "$evidence_dir/$phase/$key.log" 2>&1; then
    unit_exit=0
  else
    unit_exit=$?
  fi
  node - "$evidence_dir/$phase/$key.json" "$evidence_dir/$phase/$key.log" "$phase" "$key" "$source" "$unit_exit" <<'VERIFY'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [reportFile, logFile, phase, key, source, code] = process.argv.slice(2);
const log = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
for (const label of ['Test Files', 'Tests', 'Start at', 'Duration']) {
  assert.match(log, new RegExp(`^\\s*${label}\\s+\\S`, 'm'), `Missing completed verbose summary: ${label}`);
}
assert.doesNotMatch(log, /Vitest caught \d+ unhandled errors?|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites/);
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert.ok(report.testResults.every(file => file.message === '' && file.name.replaceAll('\\', '/').endsWith(source)));
const tests = report.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status));
assert.equal(tests.length, key === 'queued' ? 2 : 4);
for (const test of tests) {
  const shouldFail = phase === 'baseline' && (key === 'queued' ? test.fullName.endsWith('(compacted=false)') : test.fullName.endsWith('(ok=true)'));
  assert.equal(test.status, shouldFail ? 'failed' : 'passed', test.fullName);
  if (shouldFail) {
    assert.equal(test.failureMessages.length, 1);
    const failure = test.failureMessages[0].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.match(failure, /to be called 1 times, but got 0 times/);
  }
}
const failed = tests.filter(test => test.status === 'failed').length;
assert.equal(failed, phase === 'baseline' ? (key === 'queued' ? 1 : 2) : 0);
assert.equal(Number(code), failed ? 1 : 0);
assert.equal(report.numFailedTests, failed);
if (!failed) assert.equal(report.success, true);
console.log(`NOOP_OWNER_${phase.toUpperCase()}_${key.toUpperCase()}_CONFIRMED`);
VERIFY
}
run_regression baseline queued src/agents/embedded-agent-runner/compact.hooks.test.ts 'pairs successful engine hooks'
run_regression baseline recovery src/agents/embedded-agent-runner/run.compaction-runtime.test.ts 'settles no-op engine hooks'
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/baseline-build.log" 2>&1
if node --import ./scripts/tsx.mjs "$proof_source/noop-compaction-proof.mts" --repo-root "$target_dir" --artifact-base .artifacts/qa-e2e/campaign-noop-compaction-baseline > "$evidence_dir/baseline.log" 2>&1; then
  echo 'Expected baseline no-op hook omission' >&2
  exit 2
else
  proof_exit=$?
  test "$proof_exit" -eq 1
  grep -q '^NOOP_COMPACTION_BASELINE_RED:' "$evidence_dir/baseline.log"
fi
if [[ "$mode" == baseline ]]; then exit 0; fi
git apply --check "$lane_dir/candidate-production.patch"
git apply "$lane_dir/candidate-production.patch"
verify_source candidate
run_regression candidate queued src/agents/embedded-agent-runner/compact.hooks.test.ts 'pairs successful engine hooks'
run_regression candidate recovery src/agents/embedded-agent-runner/run.compaction-runtime.test.ts 'settles no-op engine hooks'
node scripts/run-vitest.mjs src/agents/embedded-agent-runner/compact.hooks.test.ts src/agents/embedded-agent-runner/run.compaction-runtime.test.ts src/plugins/wired-hooks-compaction.test.ts > "$evidence_dir/candidate-tests.log" 2>&1
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/candidate-build.log" 2>&1
node --import ./scripts/tsx.mjs "$proof_source/noop-compaction-proof.mts" --repo-root "$target_dir" --artifact-base .artifacts/qa-e2e/campaign-noop-compaction-candidate > "$evidence_dir/candidate.log" 2>&1
grep -q '^NOOP_COMPACTION_CANDIDATE_GREEN:' "$evidence_dir/candidate.log"
node scripts/check-changed.mjs --base "$proof_base" -- src/agents/embedded-agent-runner/compact.queued-execution.ts src/agents/embedded-agent-runner/run/compaction-runtime.ts src/agents/embedded-agent-runner/compact.hooks.test.ts src/agents/embedded-agent-runner/run.compaction-runtime.test.ts > "$evidence_dir/changed.log" 2>&1
verify_source candidate
git diff --numstat > "$evidence_dir/numstat.txt"
git diff > "$evidence_dir/candidate.patch"
git diff --check
