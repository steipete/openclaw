#!/usr/bin/env bash
set -euo pipefail
# Ephemeral hosted checkout only; dependencies must be installed from its frozen lockfile.
repo_dir="$1"
expected_sha="$2"
evidence_dir="$3"
proof_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_dir"
case "$expected_sha" in
  e71a547002e1a8dfb604857a81fa2c08390efb66|93e644a971923362cd2da8793117af9df97ca405) ;;
  *) echo 'Expected original CI merge or the recorded original PR head.' >&2; exit 2 ;;
esac
[[ "$(git rev-parse HEAD)" == "$expected_sha" ]]
[[ -z "$(git status --porcelain --untracked-files=no)" ]]
mkdir -p "$evidence_dir"
node --input-type=module - "$expected_sha" "$evidence_dir" "$proof_dir" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [sha, output, proofDir] = process.argv.slice(2);
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const manifest = read('package.json');
const vitest = read('node_modules/vitest/package.json');
assert.equal(process.versions.node, '24.19.0');
assert.match(manifest.packageManager, /^pnpm@12\.1\.0\+/);
assert.equal(manifest.devDependencies.vitest, '4.1.11');
assert.equal(vitest.version, '4.1.11');
const planBytes = readFileSync(join(proofDir, 'agentic-gateway-core-3.original-plan.json'));
const plans = JSON.parse(planBytes);
assert.equal(plans.length, 1);
assert.equal(plans[0].shard_name, 'agentic-gateway-core-3');
assert.equal(plans[0].env.OPENCLAW_VITEST_MAX_WORKERS, '2');
writeFileSync(join(output, 'identity.json'), JSON.stringify({
  originalRun: 33953975765, originalJob: 101273900230,
  originalPrHead: '93e644a971923362cd2da8793117af9df97ca405',
  originalMerge: 'e71a547002e1a8dfb604857a81fa2c08390efb66',
  originalBase: '961464a5177e02cf037b7783fed0dc842619f16d',
  observedSource: sha, exactOriginalMergedTree: sha.startsWith('e71a5470'),
  node: process.versions.node, vitest: vitest.version,
  packageManager: manifest.packageManager,
  planSha256: createHash('sha256').update(planBytes).digest('hex'),
  configs: plans[0].configs, includePatterns: plans[0].includePatterns.length,
  workers: 2, planConcurrency: 1,
  scope: 'Original group and include order; scheduler timing is not deterministic',
}, null, 2) + '\n');
JS
cp "$proof_dir/agentic-gateway-core-3.original-plan.json" "$evidence_dir/plan.json"
git apply --check "$proof_dir/broker-timer-diagnostic.patch"
git apply "$proof_dir/broker-timer-diagnostic.patch"
git diff --check
git diff -- src/gateway/desktop/node-stream-broker.test.ts >"$evidence_dir/instrumentation.patch"
export CI=true
export NODE_OPTIONS=--max-old-space-size=8192
export OPENCLAW_NODE_TEST_GROUPS_JSON="$(cat "$proof_dir/agentic-gateway-core-3.original-plan.json")"
export OPENCLAW_NODE_TEST_CONFIGS_JSON=null
export OPENCLAW_NODE_TEST_ENV_JSON=null
export OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON=null
export OPENCLAW_NODE_TEST_TARGETS_JSON=null
export OPENCLAW_NODE_TEST_VITEST_ARGS_JSON='[]'
export OPENCLAW_VITEST_MAX_WORKERS=2
export OPENCLAW_NODE_TEST_PLAN_CONCURRENCY=1
export OPENCLAW_VITEST_SHARD_NAME=agentic-gateway-core-3
export OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=300000
export OPENCLAW_VITEST_NO_OUTPUT_RETRY=1
unset OPENCLAW_VITEST_INCLUDE_FILE OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE
set +e
node --import tsx scripts/ci-run-node-test-shard.mts 2>&1 | tee "$evidence_dir/shard.log"
run_codes=("${PIPESTATUS[@]}")
shard_exit=${run_codes[0]}
if [[ "$shard_exit" == 0 && "${run_codes[1]}" != 0 ]]; then
  shard_exit=${run_codes[1]}
fi
set -e
printf '%s\n' "$shard_exit" >"$evidence_dir/exit-code.txt"
exit "$shard_exit"
