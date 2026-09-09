#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == baseline || "$mode" == candidate ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$SOURCE_SHA" == 7f7aeb699013db4400f9ec6cfa430168e208d7bd ]]
[[ "${CI:-}" == 1 && "$(node -p 'process.platform')" == linux ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
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
git apply --check --index "$lane_dir/tests.patch"
git apply --index "$lane_dir/tests.patch"
if [[ "$mode" == candidate ]]; then
  git apply --check --index "$lane_dir/product.patch"
  git apply --index "$lane_dir/product.patch"
fi
node "$lane_dir/verify-source.mjs" "$target_dir" "$mode" > "$evidence_dir/source-applied.json"
git diff --cached --binary --full-index "$SOURCE_SHA" > "$evidence_dir/applied.patch"
printf '%s\n' renderer > "$evidence_dir/phase.txt"
set +e
node scripts/run-vitest.mjs ui/src/pages/usage/view.test.ts \
  -t 'Usage recorded cost availability|shows the empty state for an all-zero successful response' \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/renderer.json" \
  > "$evidence_dir/renderer.log" 2>&1
renderer_exit=$?
set -e
printf '%s\n' "$renderer_exit" > "$evidence_dir/renderer-exit.txt"
node "$lane_dir/validate.mjs" "$evidence_dir" "$mode" renderer "$renderer_exit"
printf '%s\n' chromium-install > "$evidence_dir/phase.txt"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser > "$evidence_dir/phase.txt"
set +e
OPENCLAW_UI_E2E_RECORD=1 OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/usage-cost-analysis.e2e.test.ts \
  -t 'shows the recorded cost hint through ordinary Usage filters' \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/browser.json" \
  > "$evidence_dir/browser.log" 2>&1
browser_exit=$?
set -e
printf '%s\n' "$browser_exit" > "$evidence_dir/browser-exit.txt"
node "$lane_dir/validate.mjs" "$evidence_dir" "$mode" browser "$browser_exit"
if [[ "$mode" == candidate ]]; then
  printf '%s\n' changed-gate > "$evidence_dir/phase.txt"
  node scripts/check-changed.mjs --base "$SOURCE_SHA" -- \
    ui/src/pages/usage/view.ts ui/src/pages/usage/view.test.ts \
    ui/src/e2e/usage-cost-analysis.e2e.test.ts > "$evidence_dir/changed-check.log" 2>&1
fi
node "$lane_dir/verify-source.mjs" "$target_dir" "$mode" > "$evidence_dir/source-before-restoration.json"
if [[ "$mode" == candidate ]]; then
  git apply --reverse --check --index "$lane_dir/product.patch"
  git apply --reverse --index "$lane_dir/product.patch"
fi
git apply --reverse --check --index "$lane_dir/tests.patch"
git apply --reverse --index "$lane_dir/tests.patch"
node "$lane_dir/verify-source.mjs" "$target_dir" original > "$evidence_dir/source-restored.json"
git diff --cached --check
node "$lane_dir/finalize.mjs" "$evidence_dir" "$mode"
printf '%s\n' complete > "$evidence_dir/phase.txt"
