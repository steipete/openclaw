#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == green ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 9165b329314a7a46916d71018b6d7042c2973685 ]]
[[ "$SOURCE_SHA" == 9165b329314a7a46916d71018b6d7042c2973685 ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
proof_file=ui/src/e2e/avatar-owner-graphemes.e2e.test.ts
[[ ! -e "$proof_file" ]]
[[ ! -e ui/src/e2e/dashboard-shell-avatar-grapheme.e2e.test.ts ]]
retain_state() {
  git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"
  git diff --binary --full-index 9165b329314a7a46916d71018b6d7042c2973685 > "$evidence_dir/final-pr.patch"
  git status --porcelain > "$evidence_dir/final-status.txt"
}
trap retain_state EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
git add --intent-to-add -- ui/src/e2e/dashboard-shell-avatar-grapheme.e2e.test.ts
[[ ! -e ui/src/app/app-shell-view.test.ts ]]
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check.log"
printf '%s\n' owner-controls > "$evidence_dir/phase.txt"
node scripts/run-vitest.mjs ui/src/lib/avatar.test.ts ui/src/pages/dashboards/view.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/owner.json" > "$evidence_dir/owner.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" owner
cp "$lane_dir/avatar-owner-graphemes.e2e.test.ts" "$proof_file"
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check.log"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser-green > "$evidence_dir/phase.txt"
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner "$proof_file" ui/src/e2e/dashboard-shell-avatar-grapheme.e2e.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" > "$evidence_dir/browser.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" browser
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check-after.log"
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-after.log"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-after.log"
rm -- "$proof_file"
printf '%s\n' changed-gate > "$evidence_dir/phase.txt"
node scripts/check-changed.mjs --base 9165b329314a7a46916d71018b6d7042c2973685 -- ui/src/app/app-shell-view.ts ui/src/pages/dashboards/view.ts ui/src/lib/avatar.ts ui/src/pages/dashboards/view.test.ts ui/src/e2e/dashboard-shell-avatar-grapheme.e2e.test.ts > "$evidence_dir/changed-check.log" 2>&1
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-final.log"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-final.log"
[[ ! -e ui/src/app/app-shell-view.test.ts ]]
git diff --check
git diff --binary --full-index "$SOURCE_SHA" > "$evidence_dir/verified-composition.patch"
cmp "$lane_dir/candidate.patch" "$evidence_dir/verified-composition.patch"
printf '%s\n' complete > "$evidence_dir/phase.txt"
