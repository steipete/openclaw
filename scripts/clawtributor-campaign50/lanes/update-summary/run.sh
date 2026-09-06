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
[[ "$mode" == compare ]]
[[ "${SOURCE_SHA:?}" == 8bda552f4e49cf505b849e086f7a974e573e2e3f ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.1.0 ]]
git diff --exit-code
printf '%s  %s\n' 0fd5bc13850cec1b50467b8c1c23275b150df257a4c1c54f83a5e73f6f2d8308 "$lane_dir/candidate.patch" | sha256sum --check
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  exit "$proof_exit"
}
trap retain_diff EXIT
printf '%s  %s\n' a074697d991a3f73b7e06858c4907326dfed9d10165d5bdec0dec1b150c3e5de src/gateway/update-run-summary.ts | sha256sum --check
printf '%s  %s\n' d06f3a1bebb027bf0f92de58f938874acc8e7689a02bae5c8cc2a08223a5def4 src/agents/tools/gateway-tool.test.ts | sha256sum --check
sha256sum src/gateway/update-run-summary.ts src/agents/tools/gateway-tool.test.ts \
  src/agents/tools/gateway-tool.ts src/agents/tools/in-process-gateway.ts \
  src/agents/tools/tool-results.ts packages/normalization-core/src/record-coerce.ts \
  packages/normalization-core/src/utf16-slice.ts src/auto-reply/reply/commands-update.ts \
  src/auto-reply/reply/commands-update.test.ts > "$evidence_dir/candidate-source.sha256"
node scripts/run-vitest.mjs run src/agents/tools/gateway-tool.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/tests.json" > "$evidence_dir/tests.log" 2>&1
node "$lane_dir/validate-tests.mjs" "$evidence_dir/tests.json" "$evidence_dir/tests.log" green 0
node scripts/run-vitest.mjs run src/auto-reply/reply/commands-update.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/sibling.json" > "$evidence_dir/sibling.log" 2>&1
node "$lane_dir/validate-sibling.mjs" "$evidence_dir/sibling.json" "$evidence_dir/sibling.log"
node_modules/.bin/oxfmt --check src/gateway/update-run-summary.ts src/agents/tools/gateway-tool.test.ts > "$evidence_dir/format.log" 2>&1
sha256sum --check "$evidence_dir/candidate-source.sha256"
git diff --check
printf '%s\n' UPDATE_SUMMARY_CANDIDATE_COMPLETE
