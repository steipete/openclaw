#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == candidate ]]
[[ "${CI:-}" == 1 && "$(node -p 'process.platform')" == linux ]]
[[ "${SOURCE_SHA:-}" == d3a596d97eca4b66a907d936adc5fc7a9b73a9b4 ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
completed=0
finish() {
  result=$?
  trap - EXIT
  set +e
  printf '%s\n' "$result" > "$evidence_dir/command-chain-exit.txt"
  if [[ "$result" != 0 || "$completed" != 1 ]]; then
    printf '%s\n' 'Static command chain incomplete; retained evidence is not accepted.' > "$evidence_dir/incomplete.txt"
    [[ "$result" != 0 ]] || result=1
    exit "$result"
  fi
  python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" final > "$evidence_dir/final-binding.log" 2>&1
  result=$?
  printf '%s\n' "$result" > "$evidence_dir/final-binding-exit.txt"
  [[ "$result" == 0 ]] || exit "$result"
  git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"
  result=$?
  [[ "$result" == 0 ]] || exit "$result"
  git diff --check > "$evidence_dir/diff-check.log" 2>&1
  result=$?
  printf '%s\n' "$result" > "$evidence_dir/diff-check-exit.txt"
  [[ "$result" == 0 ]] || exit "$result"
  python3 "$lane_dir/validate.py" "$lane_dir" "$evidence_dir"
  result=$?
  [[ "$result" == 0 ]] || exit "$result"
  printf '%s\n' static-candidate-accepted > "$evidence_dir/phase.txt"
}
trap finish EXIT
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" initial
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" patched
pnpm exec oxfmt --check test/helpers/openclaw-test-instance.ts test/helpers/openclaw-test-instance.env.test.ts > "$evidence_dir/format.log" 2>&1
printf '%s\n' 0 > "$evidence_dir/format-exit.txt"
pnpm tsgo:test:root > "$evidence_dir/types.log" 2>&1
printf '%s\n' 0 > "$evidence_dir/types-exit.txt"
node scripts/run-oxlint.mjs --tsconfig test/tsconfig/tsconfig.test.root.json test/helpers/openclaw-test-instance.ts test/helpers/openclaw-test-instance.env.test.ts > "$evidence_dir/lint.log" 2>&1
printf '%s\n' 0 > "$evidence_dir/lint-exit.txt"
completed=1
