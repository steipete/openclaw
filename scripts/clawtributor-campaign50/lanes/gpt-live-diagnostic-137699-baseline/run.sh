#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == baseline && "$mode" == baseline ]]
[[ "${PROOF_LANE:-}" == gpt-live-diagnostic-137699-baseline ]]
[[ "${SOURCE_SHA:?}" == b3d67aa9b80bd95ff696332ec8cc8c25e40a191d ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/controller.sha256"
sha256sum extensions/openai/realtime-quicksilver-delegation-controller.ts \
  extensions/openai/realtime-quicksilver-delegation.test.ts \
  extensions/openai/realtime-quicksilver-session.ts \
  extensions/openai/realtime-quicksilver-gateway-bridge.ts \
  extensions/openai/realtime-quicksilver-events.ts \
  extensions/openai/realtime-quicksilver-wire.ts \
  src/plugin-sdk/realtime-voice-provider.ts src/infra/errors.ts \
  packages/normalization-core/src/error-coercion.ts \
  packages/normalization-core/src/utf16-slice.ts > "$evidence_dir/source-before.sha256"
node --import ./scripts/tsx.mjs "$lane_dir/driver.mjs" "$target_dir" "$evidence_dir" \
  > "$evidence_dir/driver.log" 2>&1
node scripts/run-vitest.mjs extensions/openai/realtime-quicksilver-delegation.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/owner-tests.json" \
  > "$evidence_dir/owner-tests.log" 2>&1
node "$lane_dir/validate-owner.mjs" "$evidence_dir/owner-tests.json" \
  "$evidence_dir/owner-tests.log" > "$evidence_dir/owner-validation.log"
sha256sum --check "$evidence_dir/source-before.sha256" > "$evidence_dir/source-after.log"
git diff HEAD --exit-code
printf '%s\n' GPT_LIVE_DIAGNOSTIC_BASELINE_COMPLETE
