#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == green ]] || exit 64
base=cb4c06ee78fb61891b87ff95b288efb24df55dee
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == "$base" ]] || exit 65
git diff --quiet
git diff --cached --quiet
printf '%s\n' "$base" > "$evidence_dir/source-sha.txt"
sha256sum --check "$lane_dir/baseline-files.sha256" > "$evidence_dir/baseline-source.log"
cp "$lane_dir/candidate-files.sha256" "$evidence_dir/candidate-files.sha256"
sha256sum "$lane_dir/run.sh" "$lane_dir/status-case-green.mjs" "$lane_dir/verify-tests.mjs" "$lane_dir/completed-report.mjs" "$lane_dir/tests.patch" "$lane_dir/production.patch" > "$evidence_dir/proof.sha256"
git apply --check "$lane_dir/tests.patch"
git apply "$lane_dir/tests.patch"
rg '  src/commands/models/list.status.test.ts$' "$lane_dir/candidate-files.sha256" | sha256sum --check > "$evidence_dir/unit-red-test-source.log"
rg '  src/commands/models/list.status-command.ts$' "$lane_dir/baseline-files.sha256" | sha256sum --check > "$evidence_dir/unit-red-production-source.log"
set +e
node scripts/run-vitest.mjs run --config test/vitest/vitest.commands-light.config.ts \
  src/commands/models/list.status.test.ts -t 'keeps model status independent of' \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/unit-red.json" > "$evidence_dir/unit-red.log" 2>&1
unit_red_exit=$?
set -e
printf '%s\n' "$unit_red_exit" > "$evidence_dir/unit-red-exit.txt"
node "$lane_dir/verify-tests.mjs" "$evidence_dir" red "$unit_red_exit"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/candidate-before.log"
sha256sum --check "$lane_dir/unchanged-owner-files.sha256" > "$evidence_dir/owners-before.log"
set +e
node scripts/run-vitest.mjs run \
  src/commands/models/list.status.test.ts \
  src/agents/openai-model-routes.test.ts \
  src/plugins/provider-model-routes.test.ts \
  src/agents/model-catalog-visibility.test.ts \
  packages/model-catalog-core/src/provider-model-id-normalization.test.ts \
  src/shared/model-key.test.ts src/shared/lazy-promise.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/unit-green.json" > "$evidence_dir/unit-green.log" 2>&1
unit_green_exit=$?
set -e
printf '%s\n' "$unit_green_exit" > "$evidence_dir/unit-green-exit.txt"
node "$lane_dir/verify-tests.mjs" "$evidence_dir" green "$unit_green_exit"
pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/status-case-green.mjs" "$target_dir" "$evidence_dir" > "$evidence_dir/proof.log" 2>&1
node scripts/check-changed.mjs --base "$base" -- src/commands/models/list.status-command.ts src/commands/models/list.status.test.ts > "$evidence_dir/check-changed.log" 2>&1
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/candidate-after.log"
sha256sum --check "$lane_dir/unchanged-owner-files.sha256" > "$evidence_dir/owners-after.log"
git diff --check
git diff --binary > "$evidence_dir/candidate.patch"
