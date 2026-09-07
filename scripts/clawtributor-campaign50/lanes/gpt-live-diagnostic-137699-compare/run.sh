#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir/baseline" "$evidence_dir/candidate"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == compare && "$mode" == compare ]]
[[ "${PROOF_LANE:-}" == gpt-live-diagnostic-137699-compare ]]
[[ "${SOURCE_SHA:?}" == 68c589aafad75433640347089f0523ec1ce0c20c ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/baseline.sha256"
sha256sum extensions/openai/realtime-quicksilver-session.ts \
  extensions/openai/realtime-quicksilver-gateway-bridge.ts \
  extensions/openai/realtime-quicksilver-events.ts \
  extensions/openai/realtime-quicksilver-wire.ts \
  src/plugin-sdk/realtime-voice-provider.ts src/infra/errors.ts \
  packages/normalization-core/src/error-coercion.ts \
  packages/normalization-core/src/utf16-slice.ts > "$evidence_dir/unchanged.sha256"
node --import ./scripts/tsx.mjs "$lane_dir/driver.mjs" "$target_dir" \
  "$evidence_dir/baseline" baseline > "$evidence_dir/baseline/driver.log" 2>&1
git apply --check "$lane_dir/regression.patch"
git apply "$lane_dir/regression.patch"
set +e
node scripts/run-vitest.mjs extensions/openai/realtime-quicksilver-delegation.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/baseline/owner-tests.json" \
  > "$evidence_dir/baseline/owner-tests.log" 2>&1
red_exit=$?
set -e
node "$lane_dir/validate-owner.mjs" "$evidence_dir/baseline/owner-tests.json" \
  "$evidence_dir/baseline/owner-tests.log" red "$red_exit" \
  > "$evidence_dir/baseline/owner-validation.log"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
sha256sum --check "$lane_dir/candidate.sha256"
node --import ./scripts/tsx.mjs "$lane_dir/driver.mjs" "$target_dir" \
  "$evidence_dir/candidate" candidate > "$evidence_dir/candidate/driver.log" 2>&1
node scripts/run-vitest.mjs extensions/openai/realtime-quicksilver-delegation.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/candidate/owner-tests.json" \
  > "$evidence_dir/candidate/owner-tests.log" 2>&1
node "$lane_dir/validate-owner.mjs" "$evidence_dir/candidate/owner-tests.json" \
  "$evidence_dir/candidate/owner-tests.log" green 0 \
  > "$evidence_dir/candidate/owner-validation.log"
node scripts/check-changed.mjs --base "$SOURCE_SHA" -- extensions/openai/realtime-quicksilver-delegation-controller.ts \
  extensions/openai/realtime-quicksilver-delegation.test.ts > "$evidence_dir/changed.log" 2>&1
sha256sum --check "$lane_dir/candidate.sha256" > "$evidence_dir/candidate/source-after.log"
sha256sum --check "$evidence_dir/unchanged.sha256" > "$evidence_dir/unchanged-after.log"
git diff --check
git diff --binary HEAD -- > "$evidence_dir/candidate.patch"
printf '%s\n' GPT_LIVE_DIAGNOSTIC_COMPARISON_COMPLETE
