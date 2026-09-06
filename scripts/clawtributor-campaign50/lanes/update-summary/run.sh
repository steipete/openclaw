#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == "$mode" ]]
[[ "${PROOF_LANE:-}" == "update-summary-$mode" ]]
[[ "${SOURCE_SHA:?}" == 8bda552f4e49cf505b849e086f7a974e573e2e3f ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.1.0 ]]
[[ "$mode" == red ]]
git diff --exit-code
sha256sum src/gateway/update-run-summary.ts src/agents/tools/gateway-tool.ts \
  src/agents/tools/in-process-gateway.ts src/agents/tools/common.ts \
  src/agents/tools/tool-results.ts packages/normalization-core/src/record-coerce.ts \
  packages/normalization-core/src/utf16-slice.ts > "$evidence_dir/baseline-source.sha256"
printf '%s  %s\n' 63448a961f728c52abf00d576b1955ebf2946d4169e953f046079d2df3da2bd7 src/gateway/update-run-summary.ts | sha256sum --check
printf '%s  %s\n' 8b2474386eab51f565702a2507accac08f2c1310f113b816991b59ee66513120 "$lane_dir/baseline-tests.patch" | sha256sum --check
git apply --check "$lane_dir/baseline-tests.patch"
git apply "$lane_dir/baseline-tests.patch"
retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  exit "$proof_exit"
}
trap retain_diff EXIT
sha256sum src/agents/tools/gateway-tool.test.ts > "$evidence_dir/tests.sha256"
set +e
node scripts/run-vitest.mjs run src/agents/tools/gateway-tool.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/tests.json" > "$evidence_dir/tests.log" 2>&1
test_exit=$?
set -e
node "$lane_dir/validate-tests.mjs" "$evidence_dir/tests.json" "$evidence_dir/tests.log" red "$test_exit"
sha256sum --check "$evidence_dir/baseline-source.sha256"
sha256sum --check "$evidence_dir/tests.sha256"
git diff --check
printf '%s\n' UPDATE_SUMMARY_BASELINE_COMPLETE
