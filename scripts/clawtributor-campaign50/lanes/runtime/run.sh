#!/usr/bin/env bash
set -euo pipefail
# Hosted-only; candidate mode reconstructs the exact failed wave2 source without baseline reruns.
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in baseline|compare|candidate|flow-compare) ;; *) echo 'mode must be baseline, compare, candidate or flow-compare' >&2; exit 2;; esac
cd "$target_dir"
mkdir -p "$evidence_dir"
baseline_artifacts=.artifacts/qa-e2e/campaign-memory-flush-baseline
candidate_artifacts=.artifacts/qa-e2e/campaign-memory-flush-candidate
retain_diagnostics() {
  saved_exit=$?
  trap - EXIT
  for stage in baseline candidate; do
    source_dir=".artifacts/qa-e2e/campaign-memory-flush-$stage"
    if [[ -d "$source_dir" ]]; then
      mkdir -p "$evidence_dir/$stage-artifacts"
      cp -R "$source_dir/." "$evidence_dir/$stage-artifacts/" || {
        echo "Failed to retain $stage diagnostics" >&2
        if [[ "$saved_exit" -eq 0 ]]; then saved_exit=2; fi
      }
    fi
  done
  exit "$saved_exit"
}
trap retain_diagnostics EXIT
proof_source=$(mktemp -d "$target_dir/.proof-memory-flush.XXXXXX")
cp "$lane_dir/memory-flush-proof.mts" "$lane_dir/memory-flush-provider.mts" "$proof_source/"
git rev-parse HEAD > "$evidence_dir/source-sha.txt"
if [[ "$mode" == candidate || "$mode" == flow-compare ]]; then
  test "$(git rev-parse HEAD)" = 342b7fc95009cca85425a38ccbd360b859ac0f0e
fi
if [[ "$mode" != candidate ]]; then
  git apply --check "$lane_dir/candidate-tests.patch"
  git apply "$lane_dir/candidate-tests.patch"
  if [[ "$mode" != flow-compare ]]; then
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
  fi
  OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/baseline-build.log" 2>&1
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
  if [[ "$mode" == baseline ]]; then exit 0; fi
  git apply --check "$lane_dir/candidate-production.patch"
  git apply "$lane_dir/candidate-production.patch"
  node_modules/.bin/oxfmt src/auto-reply/reply/agent-runner-memory.ts src/auto-reply/reply/agent-runner-memory.test.ts
fi
if [[ "$mode" == candidate ]]; then
  git apply --check "$lane_dir/candidate-tests.patch"
  git apply "$lane_dir/candidate-tests.patch"
  git apply --check "$lane_dir/candidate-production.patch"
  git apply "$lane_dir/candidate-production.patch"
  node_modules/.bin/oxfmt src/auto-reply/reply/agent-runner-memory.ts src/auto-reply/reply/agent-runner-memory.test.ts
fi
if [[ "$mode" == candidate || "$mode" == flow-compare ]]; then
  python3 - <<'VERIFY_SOURCE'
from pathlib import Path
import hashlib
expected = {
    "src/auto-reply/reply/agent-runner-memory.ts": "943e984b458e0a80123076d3a4bf81cf4ba18d3f16b1054d8b85ce3321cfe7be",
    "src/auto-reply/reply/agent-runner-memory.test.ts": "2d3ede364bd6550dea56c2af9023ebf8d89b340e7722b9a8031092c40cde6566",
}
for filename, digest in expected.items():
    assert hashlib.sha256(Path(filename).read_bytes()).hexdigest() == digest, f"Failed-run candidate source changed: {filename}"
print("MEMORY_FLUSH_FAILED_SOURCE_MATCH")
VERIFY_SOURCE
fi
git diff --numstat > "$evidence_dir/numstat.txt"
cp src/auto-reply/reply/agent-runner-memory.ts "$evidence_dir/candidate-production.ts"
cp src/auto-reply/reply/agent-runner-memory.test.ts "$evidence_dir/candidate-test.ts"
if [[ "$mode" == compare ]]; then
  node scripts/run-vitest.mjs src/auto-reply/reply/agent-runner-memory.test.ts src/auto-reply/reply/agent-runner-memory.preflight-stale-tokens.test.ts src/auto-reply/reply/memory-flush.test.ts > "$evidence_dir/candidate-tests.log" 2>&1
fi
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/candidate-build.log" 2>&1
node --import ./scripts/tsx.mjs "$proof_source/memory-flush-proof.mts" --repo-root "$target_dir" --artifact-base "$candidate_artifacts" 2>&1 | tee "$evidence_dir/candidate.log"
grep -q '^MEMORY_FLUSH_CANDIDATE_GREEN:' "$evidence_dir/candidate.log"
git diff --check
