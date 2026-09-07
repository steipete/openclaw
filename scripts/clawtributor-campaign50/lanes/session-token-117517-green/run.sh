#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == b57c5f25a9142ac8e1195e8552c54c268c2e03f8 ]]
[[ "$SOURCE_SHA" == b57c5f25a9142ac8e1195e8552c54c268c2e03f8 ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
retain_diff() { git diff --binary --full-index > "$evidence_dir/final-working-tree.patch"; }
trap retain_diff EXIT
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
git apply --check "$lane_dir/regression.patch"
git apply "$lane_dir/regression.patch"
printf '%s\n' regression-red > "$evidence_dir/phase.txt"
set +e
node scripts/run-vitest.mjs run src/commands/sessions.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/red.json" > "$evidence_dir/red.log" 2>&1
red_exit=$?
set -e
node "$lane_dir/validate-tests.mjs" "$evidence_dir/red.json" "$evidence_dir/red.log" red "$red_exit" src/commands/sessions.test.ts
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-before-candidate.log"
sha256sum -c "$lane_dir/production-baseline.sha256" > "$evidence_dir/production-still-baseline.log"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check.log"
printf '%s\n' regression-green > "$evidence_dir/phase.txt"
node scripts/run-vitest.mjs run src/commands/sessions.test.ts src/commands/sessions-table.test.ts src/commands/status.format.test.ts src/config/sessions/context-token-provenance.test.ts src/utils/token-format.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/green.json" > "$evidence_dir/green.log" 2>&1
node "$lane_dir/validate-tests.mjs" "$evidence_dir/green.json" "$evidence_dir/green.log" green 0 src/commands/sessions.test.ts
printf '%s\n' build > "$evidence_dir/phase.txt"
pnpm build > "$evidence_dir/build.log" 2>&1
printf '%s\n' cli-green > "$evidence_dir/phase.txt"
node --import ./scripts/tsx.mjs "$lane_dir/driver.mts" "$target_dir" "$evidence_dir" green > "$evidence_dir/driver.log" 2>&1
sha256sum -c "$lane_dir/candidate.sha256" > "$evidence_dir/candidate-check-after.log"
sha256sum -c "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-after.log"
node_modules/.bin/oxfmt --check src/commands/sessions.ts src/commands/sessions.test.ts > "$evidence_dir/format.log" 2>&1
git diff --check
printf '%s\n' complete > "$evidence_dir/phase.txt"
