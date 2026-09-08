#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == red ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 0ad318398e906aa710af94d61231dfe65946c02d ]]
[[ "$SOURCE_SHA" == 0ad318398e906aa710af94d61231dfe65946c02d ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
proof_file=ui/src/e2e/avatar-owner-graphemes.e2e.test.ts
[[ ! -e "$proof_file" ]]
retain_state() {
  git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"
  git status --porcelain > "$evidence_dir/final-status.txt"
}
trap retain_state EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
cp "$lane_dir/avatar-owner-graphemes.e2e.test.ts" "$proof_file"
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check.log"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' owner-controls > "$evidence_dir/phase.txt"
node scripts/run-vitest.mjs ui/src/lib/avatar.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/owner.json" > "$evidence_dir/owner.log" 2>&1
printf '%s\n' browser-red > "$evidence_dir/phase.txt"
set +e
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner "$proof_file" --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" > "$evidence_dir/browser.log" 2>&1
proof_exit=$?
set -e
node "$lane_dir/validate.mjs" "$evidence_dir" "$proof_exit"
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check-after.log"
sha256sum -c "$lane_dir/proof.sha256" > "$evidence_dir/proof-check-after.log"
rm -- "$proof_file"
git diff --exit-code
printf '%s\n' complete > "$evidence_dir/phase.txt"
