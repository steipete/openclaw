#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in red|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
cd "$target_dir"
# Candidate application belongs to the reviewed lane manifest, before this entry.
git rev-parse HEAD > "$evidence_dir/source-sha.txt"
sha256sum src/gateway/worker-environments/session-target.ts src/gateway/worker-environments/inference-runtime.ts > "$evidence_dir/production-before.sha256"
cp "$lane_dir/global-worker-owner.e2e.test.ts" test/e2e/qa-lab/runtime/global-worker-owner.e2e.test.ts
sha256sum test/e2e/qa-lab/runtime/global-worker-owner.e2e.test.ts > "$evidence_dir/proof.sha256"
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/build.log" 2>&1
set +e
OPENCLAW_WORKER_OWNER_PROOF_DIR="$evidence_dir/runtime" OPENCLAW_E2E_SKIP_BUILD=1 \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts \
  test/e2e/qa-lab/runtime/global-worker-owner.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/wire.json" > "$evidence_dir/wire.log" 2>&1
wire_exit=$?
set -e
node - "$evidence_dir" "$mode" "$wire_exit" <<'VERIFY'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [dir, mode, code] = process.argv.slice(2);
const log = fs.readFileSync(path.join(dir, 'wire.log'), 'utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
for (const title of ['Test Files', 'Tests', 'Start at', 'Duration']) {
  assert.match(log, new RegExp(`^\\s*${title}\\s+\\S`, 'm'), `Missing completed verbose summary: ${title}`);
}
assert.doesNotMatch(log, /Vitest caught \d+ unhandled errors?|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites \d+/);
const report = JSON.parse(fs.readFileSync(path.join(dir, 'wire.json'), 'utf8'));
const observed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime/observed.json'), 'utf8'));
const tests = report.testResults.flatMap(file => file.assertionResults);
assert.equal(tests.length, 1);
assert.equal(observed.created.key, 'global');
assert.equal(observed.agentId, 'qa');
assert.equal(observed.localControlStatus, 'ok');
assert.equal(observed.cleanupFailureCount, 0);
assert.deepEqual(observed.nodeReady, {
  approvalState: 'approved', connected: true, paired: true, sessionHost: true,
});
assert.ok(report.testResults.every(file => file.message === ''), 'Unexpected suite runtime error');
if (mode === 'red') {
  assert.equal(code, '1');
  assert.equal(tests[0].status, 'failed');
  assert.equal(tests[0].failureMessages.length, 1);
  assert.match(tests[0].failureMessages.join('\n'), /WORKER_GLOBAL_ATTACHMENT_139216/);
  assert.equal(observed.phase, 'dispatch');
  assert.equal(observed.dispatchError, 'Attached session target is unavailable');
} else {
  assert.equal(code, '0');
  assert.equal(report.success, true);
  assert.equal(tests[0].status, 'passed');
  assert.equal(observed.phase, 'passed');
  assert.equal(observed.placementState, 'active');
  assert.ok(observed.workerLaunches > 0);
  assert.equal(observed.dispatchError, undefined);
  assert.equal(observed.terminal.status, 'ok');
  assert.equal(observed.ownerAssistantMessages, 1);
  assert.equal(observed.otherAgentHasMarker, false);
}
console.log(`WORKER_GLOBAL_OWNER_${mode.toUpperCase()}_CONFIRMED`);
VERIFY
sha256sum --check "$evidence_dir/production-before.sha256"
git diff --check
