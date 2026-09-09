#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == green ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 251634acaccd9d0576a915461f7a154cc51b50f4 ]]
[[ "$SOURCE_SHA" == 251634acaccd9d0576a915461f7a154cc51b50f4 ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
[[ ! -e ui/src/e2e/identity-config-refresh.e2e.test.ts ]]
retain_state() {
  git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"
  git diff --cached --binary --full-index "$SOURCE_SHA" > "$evidence_dir/final-candidate.patch"
  git status --porcelain > "$evidence_dir/final-status.txt"
}
trap retain_state EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
git apply --check --index "$lane_dir/candidate.patch"
git apply --index "$lane_dir/candidate.patch"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check.log"
printf '%s\n' owner-controls > "$evidence_dir/phase.txt"
node scripts/run-vitest.mjs \
  ui/src/lib/agents/identity.test.ts \
  ui/src/pages/chat/chat-pane-identity.test.ts \
  ui/src/pages/chat/chat-state.test.ts \
  ui/src/pages/chat/chat-avatar.test.ts \
  ui/src/pages/chat/chat-avatar-publication.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/owner.json" \
  > "$evidence_dir/owner.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" owner
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser-green > "$evidence_dir/phase.txt"
OPENCLAW_CAPTURE_UI_PROOF=1 OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/identity-config-refresh.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/browser.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" browser
printf '%s\n' changed-gate > "$evidence_dir/phase.txt"
node scripts/check-changed.mjs --base "$SOURCE_SHA" -- \
  ui/src/pages/chat/chat-pane-lifecycle.ts \
  ui/src/pages/chat/chat-state-page.ts \
  ui/src/pages/chat/chat-pane.test-support.ts \
  ui/src/e2e/identity-config-refresh.e2e.test.ts > "$evidence_dir/changed-check.log" 2>&1
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-final.log"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-final.log"
git diff --exit-code
git diff --cached --binary --full-index "$SOURCE_SHA" > "$evidence_dir/final-candidate.patch"
cmp "$lane_dir/candidate.patch" "$evidence_dir/final-candidate.patch"
git diff --cached --check
printf '%s\n' complete > "$evidence_dir/phase.txt"
