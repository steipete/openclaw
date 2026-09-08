#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == candidate ]]
[[ "${CI:-}" == 1 && "$(node -p 'process.platform')" == linux ]]
[[ "${SOURCE_SHA:-}" == 0ad91c51170adce8d177bc2473ee8558a62f6a83 ]]
[[ "$(node --version)" == v24.19.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
patched=0
finish() {
  result=$?
  trap - EXIT
  set +e
  printf '%s\n' "$result" > "$evidence_dir/primary-exit-code.txt"
  git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"
  diff_result=$?
  printf '%s\n' "$diff_result" > "$evidence_dir/final-diff-exit-code.txt"
  if [[ "$result" == 0 && "$diff_result" != 0 ]]; then result=$diff_result; fi
  if [[ "$patched" == 1 ]]; then
    python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" final > "$evidence_dir/final-binding.log" 2>&1
    binding_result=$?
    printf '%s\n' "$binding_result" > "$evidence_dir/final-binding-exit-code.txt"
    if [[ "$result" == 0 && "$binding_result" != 0 ]]; then result=$binding_result; fi
  fi
  printf '%s\n' "$result" > "$evidence_dir/lane-exit-code.txt"
  exit "$result"
}
trap finish EXIT
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" initial
git apply --check "$lane_dir/repair.patch"
git apply "$lane_dir/repair.patch"
patched=1
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" patched
CI=true node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.core.json src/tui/tui-pty-harness-fixture-test-support.ts > "$evidence_dir/fixture-lint.log" 2>&1
printf '%s\n' 0 > "$evidence_dir/fixture-lint-exit.txt"
vitest_cache="$HOME/.cache/campaign50-tui-preference-vitest"
node_cache="$HOME/.cache/campaign50-tui-preference-node"
[[ ! -e "$vitest_cache" && ! -e "$node_cache" ]]
mkdir -p "$vitest_cache" "$node_cache"
CI=true NODE_OPTIONS=--max-old-space-size=8192 \
  OPENCLAW_VITEST_MAX_WORKERS=2 \
  OPENCLAW_NODE_TEST_PLAN_CONCURRENCY=1 \
  OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE=0 \
  OPENCLAW_NODE_TEST_TARGETS_JSON='[]' \
  OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64='' \
  OPENCLAW_NODE_TEST_GROUPS_JSON="$(cat "$lane_dir/SELECTED-NODE-GROUPS.json")" \
  OPENCLAW_NODE_TEST_VITEST_ARGS_JSON='[]' \
  OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="$vitest_cache" \
  OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=0 \
  NODE_COMPILE_CACHE="$node_cache" \
  OPENCLAW_NODE_COMPILE_CACHE_WRITER=0 \
  node --import tsx scripts/ci-run-node-test-shard.mts > "$evidence_dir/groups.log" 2>&1
printf '%s\n' 0 > "$evidence_dir/groups-exit.txt"
node "$lane_dir/validate.mjs" "$lane_dir" "$evidence_dir"
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" final
git diff --check
python3 "$lane_dir/final-receipt.py" "$lane_dir" "$evidence_dir"
printf '%s\n' candidate-accepted > "$evidence_dir/phase.txt"
