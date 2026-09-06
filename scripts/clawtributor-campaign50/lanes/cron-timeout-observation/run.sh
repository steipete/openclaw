#!/usr/bin/env bash
set -euo pipefail
target_dir="$1"
lane_dir="$2"
evidence_dir="$3"
mode="$4"
test "${CI:-}" = 1
test "${PROOF_MODE:-}" = "$mode"
test "${PROOF_LANE:-}" = "cron-timeout-observation-$mode"
test "$SOURCE_SHA" = b5412c2a40b200f7b11d235a4216e18d8e7ffd6f
cd "$target_dir"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
mkdir -p "$evidence_dir"
case "$mode" in
  red) ;;
  green) git apply --check "$lane_dir/candidate.patch"; git apply "$lane_dir/candidate.patch" ;;
  *) exit 2 ;;
esac
git diff --binary > "$evidence_dir/candidate-working-tree.patch"
sha256sum src/cron/command-runner.test.ts src/process/exec-termination.ts \
  src/process/exec.test.ts src/process/exec-runner.ts > "$evidence_dir/candidate-files.sha256"
cp src/cron/command-runner.test.ts "$evidence_dir/uninstrumented-command-runner.test.ts"
python3 "$lane_dir/instrument.py" src/cron/command-runner.test.ts
git diff --binary > "$evidence_dir/instrumented-working-tree.patch"
set +e
node scripts/run-vitest.mjs run src/cron/command-runner.test.ts \
  -t 'kills shell process groups on timeout' --reporter=verbose --reporter=json \
  --outputFile="$evidence_dir/focused.json" > "$evidence_dir/focused.log" 2>&1
test_exit=$?
set -e
node "$lane_dir/validate.mjs" "$evidence_dir/focused.json" "$evidence_dir/focused.log" \
  "$mode" "$test_exit" "$evidence_dir/verdict.json"
cp "$evidence_dir/uninstrumented-command-runner.test.ts" src/cron/command-runner.test.ts
if [ "$mode" = green ]; then
  node scripts/run-vitest.mjs run src/cron/command-runner.test.ts \
    src/process/exec.test.ts src/process/exec-termination.test.ts src/process/child-process.test.ts \
    --reporter=verbose --reporter=json --outputFile="$evidence_dir/owners.json" > "$evidence_dir/owners.log" 2>&1
  node --input-type=module - "$evidence_dir/owners.json" "$evidence_dir/owners.log" "$lane_dir/completed-report.mjs" <<'JS'
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {readCompletedReport}=await import(pathToFileURL(process.argv[4]).href);
const {report}=readCompletedReport(process.argv[2],process.argv[3]);
assert.equal(report.success,true);
assert.equal(report.numFailedTests,0);
assert.equal(report.testResults.length,4);
assert.ok(report.testResults.every(s=>s.status==='passed' && s.message===''));
const expected=['src/cron/command-runner.test.ts','src/process/exec.test.ts','src/process/exec-termination.test.ts','src/process/child-process.test.ts'];
assert.ok(expected.every(path=>report.testResults.some(s=>s.name.endsWith('/'+path))));
const active=report.testResults.flatMap(s=>s.assertionResults).filter(t=>t.status==='passed');
assert.ok(active.some(t=>t.fullName==='runCronCommandJob kills shell process groups on timeout'));
assert.ok(active.some(t=>t.fullName==='runCommandBuffered force-kills inherited-pipe descendants after the direct child exits'));
JS
  node scripts/check-changed.mjs --base "$SOURCE_SHA" -- src/cron/command-runner.test.ts > "$evidence_dir/changed-check.log" 2>&1
fi
git diff --check
git diff --binary > "$evidence_dir/final-working-tree.patch"
sha256sum src/cron/command-runner.test.ts src/process/exec-termination.ts \
  src/process/exec.test.ts src/process/exec-runner.ts > "$evidence_dir/final-files.sha256"
printf '%s\n' complete > "$evidence_dir/phase.txt"
