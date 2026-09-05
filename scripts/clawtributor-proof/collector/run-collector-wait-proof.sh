#!/usr/bin/env bash
set -euo pipefail
# Run only on the ephemeral hosted job after pinned dependencies are installed.
repo_dir="$1"
expected_sha="$2"
evidence_dir="$3"
proof_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_dir"
[[ "$(git rev-parse HEAD)" == "$expected_sha" ]]
[[ -z "$(git status --porcelain --untracked-files=no)" ]]
mkdir -p "$evidence_dir"
set +e
node --import tsx "$proof_dir/collector-wait-proof.mjs" "$PWD" >"$evidence_dir/baseline.log" 2>&1
baseline_exit=$?
set -e
cat "$evidence_dir/baseline.log"
[[ "$baseline_exit" == 1 ]]
node --input-type=module - "$evidence_dir/baseline.log" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const log = readFileSync(process.argv[2], 'utf8');
const lines = log.split('\n').filter((line) => line.startsWith('COLLECTOR_WAIT_PROOF '));
assert.equal(lines.length, 1);
const proof = JSON.parse(lines[0].slice('COLLECTOR_WAIT_PROOF '.length));
assert.deepEqual(proof.preAbortedCompleted, { status: 'resolved', result: 'synthetic completion' });
assert.equal(Object.keys(proof).length, 6);
assert.match(log, /COLLECTOR_CANCELLATION_PRECEDENCE/);
JS
git apply --check "$proof_dir/collector-wait-fix.patch"
git apply "$proof_dir/collector-wait-fix.patch"
git diff --check
git diff -- src/agents/tools/agents-wait-tool.ts >"$evidence_dir/candidate.patch"
node --import tsx "$proof_dir/collector-wait-proof.mjs" "$PWD" 2>&1 | tee "$evidence_dir/candidate.log"
node scripts/run-vitest.mjs src/agents/tools/agents-wait-tool.test.ts src/agents/code-mode-swarm.test.ts src/agents/code-mode-swarm.lazy.test.ts src/agents/code-mode-worker-lifecycle.test.ts 2>&1 | tee "$evidence_dir/candidate-tests.log"
printf 'Baseline SHA: %s\nBaseline exit: %s\nCandidate: independently authored guard reorder\n' "$expected_sha" "$baseline_exit" >"$evidence_dir/identity.txt"
