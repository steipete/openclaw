#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == green ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 411e3f41b5484be425fa0e726621ae0b10f2a62a ]]
[[ "$SOURCE_SHA" == 411e3f41b5484be425fa0e726621ae0b10f2a62a ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
git cat-file -e b75423c2fcc30bda76fbe0480662bcaaea54a5b4^{commit} 2>/dev/null || \
  git fetch --no-tags --depth=2 origin "$SOURCE_SHA"
[[ "$(git rev-parse HEAD^)" == b75423c2fcc30bda76fbe0480662bcaaea54a5b4 ]]
retain_diff() { git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"; }
trap retain_diff EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
git apply --check "$lane_dir/candidate-production.patch"
git apply "$lane_dir/candidate-production.patch"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check.log"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' author-regression > "$evidence_dir/phase.txt"
OPENCLAW_CAPTURE_UI_PROOF=0 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/sidebar-interactions.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/author.json" \
  > "$evidence_dir/author.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" author
[[ ! -e ui/src/e2e/sidebar-label-owner.e2e.test.ts ]]
cp "$lane_dir/sidebar-label-owner.e2e.test.ts" ui/src/e2e/sidebar-label-owner.e2e.test.ts
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check.log"
printf '%s\n' candidate-browser > "$evidence_dir/phase.txt"
OPENCLAW_CAPTURE_UI_PROOF=1 OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/sidebar-label-owner.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/browser.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" browser
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check-after.log"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-after.log"
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-after.log"
printf '%s\n' changed-gate > "$evidence_dir/phase.txt"
node scripts/check-changed.mjs --base b75423c2fcc30bda76fbe0480662bcaaea54a5b4 -- \
  ui/src/styles/layout.css ui/src/e2e/sidebar-interactions.e2e.test.ts > "$evidence_dir/changed-check.log" 2>&1
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-final.log"
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-final.log"
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check-final.log"
git diff --check
printf '%s\n' complete > "$evidence_dir/phase.txt"
