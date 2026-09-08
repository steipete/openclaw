#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == red ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 251634acaccd9d0576a915461f7a154cc51b50f4 ]]
[[ "$SOURCE_SHA" == 251634acaccd9d0576a915461f7a154cc51b50f4 ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
proof_file=ui/src/e2e/identity-config-refresh.e2e.test.ts
[[ ! -e "$proof_file" ]]
retain_state() {
  git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"
  git status --porcelain > "$evidence_dir/final-status.txt"
}
trap retain_state EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
cp "$lane_dir/identity-config-refresh.e2e.test.ts" "$proof_file"
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check.log"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser-red > "$evidence_dir/phase.txt"
set +e
OPENCLAW_CAPTURE_UI_PROOF=1 OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  "$proof_file" --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/browser.log" 2>&1
proof_exit=$?
set -e
node "$lane_dir/validate.mjs" "$evidence_dir" "$proof_exit"
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check-after.log"
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check-after.log"
rm -- "$proof_file"
git diff --exit-code
printf '%s\n' complete > "$evidence_dir/phase.txt"
