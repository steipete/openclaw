#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == red ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 608b9ba2437d22188bac854a012458880ff55211 ]]
[[ "$SOURCE_SHA" == 608b9ba2437d22188bac854a012458880ff55211 ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
retain_diff() { git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"; }
trap retain_diff EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
cp "$lane_dir/sidebar-interactions.e2e.test.ts" ui/src/e2e/sidebar-interactions.e2e.test.ts
sha256sum -c "$lane_dir/test.sha256" > "$evidence_dir/test-check.log"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' unfinished-control > "$evidence_dir/phase.txt"
set +e
OPENCLAW_CAPTURE_UI_PROOF=1 OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/sidebar-interactions.e2e.test.ts \
  --testNamePattern='preserves nested sidebar hyperlink layout and actions in both directions' \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/browser.log" 2>&1
proof_exit=$?
set -e
node "$lane_dir/validate.mjs" "$evidence_dir" "$proof_exit"
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/source-check-after.log"
sha256sum -c "$lane_dir/test.sha256" > "$evidence_dir/test-check-after.log"
printf '%s\n' complete > "$evidence_dir/phase.txt"
