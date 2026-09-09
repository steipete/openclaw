#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == baseline ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$SOURCE_SHA" == 2bac366b0b370cdbf8b7691f106eebc3d931c5a1 ]]
[[ "${PROOF_MODE:-}" == baseline && "${PROOF_LANE:-}" == ui-error-unicode-baseline && "${PROOF_VARIANT:-}" == ordinary-projections ]]
[[ "${CI:-}" == 1 && "$(node -p 'process.platform')" == linux ]]
[[ "$(node --version)" == v24.20.0 && "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
[[ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]]
finish() {
  lane_exit=$?
  trap - EXIT
  git diff --binary --full-index "$SOURCE_SHA" -- > "$evidence_dir/final-working-tree.patch" || lane_exit=1
  git status --porcelain > "$evidence_dir/final-status.txt" || lane_exit=1
  printf '%s\n' "$lane_exit" > "$evidence_dir/lane-exit.txt"
  exit "$lane_exit"
}
trap finish EXIT
(cd "$lane_dir" && sha256sum -c packet.sha256) > "$evidence_dir/packet-check.log"
node "$lane_dir/verify-source.mjs" "$target_dir" original > "$evidence_dir/source-before.json"
git apply --check --index "$lane_dir/browser.patch"
git apply --index "$lane_dir/browser.patch"
node "$lane_dir/verify-source.mjs" "$target_dir" baseline > "$evidence_dir/source-applied.json"
git diff --cached --binary --full-index "$SOURCE_SHA" > "$evidence_dir/applied.patch"
printf '%s\n' chromium-install > "$evidence_dir/phase.txt"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser > "$evidence_dir/phase.txt"
set +e
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/error-projection-unicode.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/browser.json" \
  > "$evidence_dir/browser.log" 2>&1
browser_exit=$?
set -e
printf '%s\n' "$browser_exit" > "$evidence_dir/browser-exit.txt"
node "$lane_dir/validate.mjs" "$evidence_dir" "$browser_exit"
node "$lane_dir/verify-source.mjs" "$target_dir" baseline > "$evidence_dir/source-before-restoration.json"
git apply --reverse --check --index "$lane_dir/browser.patch"
git apply --reverse --index "$lane_dir/browser.patch"
node "$lane_dir/verify-source.mjs" "$target_dir" original > "$evidence_dir/source-restored.json"
git diff --cached --check
node "$lane_dir/finalize.mjs" "$evidence_dir"
printf '%s\n' complete > "$evidence_dir/phase.txt"
