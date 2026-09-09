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
node "$lane_dir/verify.mjs" "$evidence_dir" historical
files=(
  ui/src/e2e/identity-config-refresh.e2e.test.ts
  ui/src/pages/chat/chat-pane-lifecycle.ts
  ui/src/pages/chat/chat-pane.test-support.ts
  ui/src/pages/chat/chat-state-page.ts
)
printf '%s\n' format > "$evidence_dir/phase.txt"
pnpm exec oxfmt --check --no-error-on-unmatched-pattern -- "${files[@]}" > "$evidence_dir/format.log" 2>&1
printf '%s\n' oxlint > "$evidence_dir/phase.txt"
node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.core.json "${files[@]}" > "$evidence_dir/oxlint.log" 2>&1
printf '%s\n' stylelint > "$evidence_dir/phase.txt"
node --import tsx scripts/run-stylelint.mts "${files[@]}" > "$evidence_dir/stylelint.log" 2>&1
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-final.log"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-final.log"
git diff --exit-code
git diff --cached --binary --full-index "$SOURCE_SHA" > "$evidence_dir/final-candidate.patch"
cmp "$lane_dir/candidate.patch" "$evidence_dir/final-candidate.patch"
git diff --cached --check
node "$lane_dir/verify.mjs" "$evidence_dir" final
printf '%s\n' complete > "$evidence_dir/phase.txt"
