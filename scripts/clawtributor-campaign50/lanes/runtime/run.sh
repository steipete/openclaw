#!/usr/bin/env bash
set -euo pipefail
# Hosted-only. Dependencies must already be installed from the frozen package-manager pin.
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in baseline|compare) ;; *) echo 'mode must be baseline or compare' >&2; exit 2;; esac
cd "$target_dir"
mkdir -p "$evidence_dir"
proof_source=$(mktemp -d "$target_dir/.proof-memory-flush.XXXXXX")
cp "$lane_dir/memory-flush-proof.mts" "$lane_dir/memory-flush-provider.mts" "$proof_source/"
git rev-parse HEAD > "$evidence_dir/source-sha.txt"
# The test selector is intentionally new; absence or an unrelated crash must fail this lane.
git apply --check "$lane_dir/candidate-tests.patch"
git apply "$lane_dir/candidate-tests.patch"
if node scripts/run-vitest.mjs src/auto-reply/reply/agent-runner-memory.test.ts -t 'includes appended transcript growth before persisting fresh usage' > "$evidence_dir/baseline-regression.log" 2>&1; then
  cat "$evidence_dir/baseline-regression.log"
  echo 'Expected baseline regression failure' >&2
  exit 2
else
  test_exit=$?
  cat "$evidence_dir/baseline-regression.log"
  test "$test_exit" -eq 1
  grep -Eq 'expected 40000 to be greater than 80000' "$evidence_dir/baseline-regression.log"
fi
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/baseline-build.log" 2>&1
baseline_artifacts=.artifacts/qa-e2e/campaign-memory-flush-baseline
if node --import ./scripts/tsx.mjs "$proof_source/memory-flush-proof.mts" --repo-root "$target_dir" --artifact-base "$baseline_artifacts" > "$evidence_dir/baseline.log" 2>&1; then
  cat "$evidence_dir/baseline.log"
  echo 'Expected baseline accounting failure' >&2
  exit 2
else
  proof_exit=$?
  cat "$evidence_dir/baseline.log"
  test "$proof_exit" -eq 1
  grep -q '^MEMORY_FLUSH_BASELINE_RED:' "$evidence_dir/baseline.log"
fi
cp -R "$baseline_artifacts" "$evidence_dir/baseline-artifacts"
if [[ "$mode" == baseline ]]; then exit 0; fi
git apply --check "$lane_dir/candidate-production.patch"
git apply "$lane_dir/candidate-production.patch"
node_modules/.bin/oxfmt src/auto-reply/reply/agent-runner-memory.ts src/auto-reply/reply/agent-runner-memory.test.ts
git diff --numstat > "$evidence_dir/numstat.txt"
cp src/auto-reply/reply/agent-runner-memory.ts "$evidence_dir/candidate-production.ts"
cp src/auto-reply/reply/agent-runner-memory.test.ts "$evidence_dir/candidate-test.ts"
node scripts/run-vitest.mjs src/auto-reply/reply/agent-runner-memory.test.ts src/auto-reply/reply/agent-runner-memory.preflight-stale-tokens.test.ts src/auto-reply/reply/memory-flush.test.ts > "$evidence_dir/candidate-tests.log" 2>&1
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/candidate-build.log" 2>&1
candidate_artifacts=.artifacts/qa-e2e/campaign-memory-flush-candidate
node --import ./scripts/tsx.mjs "$proof_source/memory-flush-proof.mts" --repo-root "$target_dir" --artifact-base "$candidate_artifacts" | tee "$evidence_dir/candidate.log"
grep -q '^MEMORY_FLUSH_CANDIDATE_GREEN:' "$evidence_dir/candidate.log"
cp -R "$candidate_artifacts" "$evidence_dir/candidate-artifacts"
git diff --check
