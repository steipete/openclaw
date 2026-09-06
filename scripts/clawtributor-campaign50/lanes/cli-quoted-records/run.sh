#!/usr/bin/env bash
set -euo pipefail

target_dir="$1"
lane_dir="$2"
evidence_dir="$3"
mode="$4"
subset="${PROOF_VARIANT:-all}"
case "$subset" in
  all) ;;
  remaining) test "$mode" = red ;;
  *) exit 2 ;;
esac
test "${CI:-}" = 1
test "${PROOF_MODE:-}" = "$mode"
test "${PROOF_LANE:-}" = "cli-quoted-records-$mode"
cd "$target_dir"
mkdir -p "$evidence_dir"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test "$SOURCE_SHA" = ed6e3aabf0ef6cd58a8ee9d9282a6dc6c06cc918
case "$mode" in
  red) patch_file="$lane_dir/regression.patch" ;;
  green) patch_file="$lane_dir/candidate.patch" ;;
  *) exit 2 ;;
esac

retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  if [ -f packages/normalization-core/src/balanced-json.test.ts ]; then
    cp packages/normalization-core/src/balanced-json.test.ts "$evidence_dir/balanced-json.test.ts" || proof_exit=2
  fi
  exit "$proof_exit"
}
trap retain_diff EXIT
git apply --check "$patch_file"
git apply "$patch_file"
if [ "$subset" = all ]; then
  printf '%s\n' owner-tests > "$evidence_dir/phase.txt"
  set +e
  node scripts/run-vitest.mjs run src/agents/cli-output-records.test.ts \
    -t 'keeps records around quoted examples and ignores later quoted errors|does not unwrap nested result-shaped JSON for non-claude json backends' \
    --reporter=verbose --reporter=json --outputFile="$evidence_dir/focused.json" > "$evidence_dir/focused.log" 2>&1
  test_exit=$?
  set -e
  node "$lane_dir/validate-tests.mjs" "$evidence_dir/focused.json" "$evidence_dir/focused.log" "$mode" focused "$test_exit"

  if [ "$mode" = green ]; then
    node scripts/run-vitest.mjs run \
      packages/normalization-core/src/balanced-json.test.ts \
      packages/normalization-core/src/json-coercion.test.ts \
      packages/ai/src/utils/provider-error.test.ts \
      src/agents/cli-output-records.test.ts \
      src/agents/cli-output-jsonl.test.ts \
      --reporter=verbose --reporter=json --outputFile="$evidence_dir/owners.json" > "$evidence_dir/owners.log" 2>&1
    node "$lane_dir/validate-tests.mjs" "$evidence_dir/owners.json" "$evidence_dir/owners.log" green owners 0
  fi

fi

printf '%s\n' build > "$evidence_dir/phase.txt"
pnpm build > "$evidence_dir/build.log" 2>&1
printf '%s\n' real-child > "$evidence_dir/phase.txt"
timeout 240s node --import tsx "$lane_dir/probe.mjs" "$mode" "$evidence_dir/real-child.json" "$subset" \
  > "$evidence_dir/real-child.log" 2>&1
git diff --check
printf '%s\n' complete > "$evidence_dir/phase.txt"
