#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == candidate ]]
[[ "${CI:-}" == 1 && "$(node -p 'process.platform')" == linux ]]
[[ "${SOURCE_SHA:-}" == 9c4176406e90ba373d79fc1de173535cb9b003ba ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
retain_diff() { git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"; }
trap retain_diff EXIT
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" initial
comparison_base=6aa09cbadb594c3d46d5bd49a28c514df1b256b0
if ! git cat-file -e "$comparison_base^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=2 origin "$SOURCE_SHA" > "$evidence_dir/comparison-base-fetch.log" 2>&1
fi
[[ "$(git rev-parse "$comparison_base^{commit}")" == "$comparison_base" ]]
[[ "$(git cat-file -p HEAD | sed -n 's/^parent //p')" == "$comparison_base" ]]
printf '%s\n' "$comparison_base" > "$evidence_dir/comparison-base.txt"
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" patched
pnpm build > "$evidence_dir/build.log" 2>&1
node scripts/run-vitest.mjs run src/tui/tui-event-handlers.test.ts \
  -t 'updates the displayed model from fallback lifecycle steps|refreshes the fallback model for a|ignores fallback model updates for unrelated runs|preserves model state for an invalid reported destination' \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/owner.json" \
  > "$evidence_dir/owner.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" owner 0
node scripts/run-vitest.mjs run src/tui/tui-attachment-failures.test.ts src/tui/tui-session-actions.test.ts src/tui/tui-formatters.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/siblings.json" \
  > "$evidence_dir/siblings.log" 2>&1
node "$lane_dir/validate.mjs" "$evidence_dir" siblings 0
: > "$evidence_dir/pty.raw"
set +e
OPENCLAW_TUI_PTY_MIRROR_PATH="$evidence_dir/pty.raw" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts \
  src/tui/tui-session-identity-pty.e2e.test.ts \
  -t 'refreshes the footer only for an accepted fallback destination without reloading history' \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/pty.json" \
  > "$evidence_dir/pty.log" 2>&1
pty_code=$?
set -e
printf '%s\n' "$pty_code" > "$evidence_dir/pty-exit-code.txt"
node "$lane_dir/validate.mjs" "$evidence_dir" pty "$pty_code"
node "$lane_dir/render-frames.mjs" "$evidence_dir"
node scripts/check-changed.mjs --dry-run --base "$comparison_base" -- src/tui/tui-attachment-failures.test.ts src/tui/tui-event-handlers.test.ts src/tui/tui-event-handlers.ts src/tui/tui-fallback-fixture-test-support.ts src/tui/tui-pty-harness-fixture-test-support.ts src/tui/tui-run-lifecycle.ts src/tui/tui-session-actions.test.ts src/tui/tui-session-identity-pty.e2e.test.ts src/tui/tui.ts > "$evidence_dir/changed-plan.log" 2>&1
node scripts/check-changed.mjs --base "$comparison_base" -- src/tui/tui-attachment-failures.test.ts src/tui/tui-event-handlers.test.ts src/tui/tui-event-handlers.ts src/tui/tui-fallback-fixture-test-support.ts src/tui/tui-pty-harness-fixture-test-support.ts src/tui/tui-run-lifecycle.ts src/tui/tui-session-actions.test.ts src/tui/tui-session-identity-pty.e2e.test.ts src/tui/tui.ts > "$evidence_dir/changed-check.log" 2>&1
printf '%s\n' 0 > "$evidence_dir/changed-exit-code.txt"
python3 "$lane_dir/bind.py" "$target_dir" "$lane_dir" "$evidence_dir" final
git diff --check
python3 "$lane_dir/final-receipt.py" "$lane_dir" "$evidence_dir"
printf '%s\n' candidate-accepted > "$evidence_dir/phase.txt"
