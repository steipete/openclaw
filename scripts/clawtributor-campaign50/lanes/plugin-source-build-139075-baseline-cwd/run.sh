#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == baseline && "$mode" == baseline ]]
[[ "${PROOF_LANE:-}" == plugin-source-build-139075-baseline ]]
[[ "${SOURCE_SHA:?}" == 2d58961f33fd48b94b48bf569b65fb1c6ad2d954 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-before.log"
node "$lane_dir/driver.mjs" "$target_dir" "$evidence_dir" > "$evidence_dir/driver.log" 2>&1
node scripts/run-vitest.mjs src/cli/plugins-control-ui-build.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/owner-tests.json" \
  > "$evidence_dir/owner-tests.log" 2>&1
node "$lane_dir/validate-owner.mjs" "$evidence_dir/owner-tests.json" \
  "$evidence_dir/owner-tests.log" > "$evidence_dir/owner-validation.log"
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-after.log"
git diff HEAD --exit-code
printf '%s\n' PLUGIN_SOURCE_BUILD_BASELINE_COMPLETE
