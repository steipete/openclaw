#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir/baseline" "$evidence_dir/candidate"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == compare && "$mode" == compare ]]
[[ "${PROOF_LANE:-}" == plugin-source-build-139075-compare ]]
[[ "${SOURCE_SHA:?}" == e831b5e425880278fdf5ca11365f503aab60e44f ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/baseline.sha256" > "$evidence_dir/baseline/source-before.log"
node "$lane_dir/driver.mjs" "$target_dir" "$evidence_dir/baseline" baseline \
  > "$evidence_dir/baseline/driver.log" 2>&1
sha256sum --check "$lane_dir/baseline.sha256" > "$evidence_dir/baseline/source-after.log"
git apply --check "$lane_dir/regression.patch"
git apply "$lane_dir/regression.patch"
set +e
node scripts/run-vitest.mjs src/cli/plugins-control-ui-build.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/baseline/tests.json" \
  > "$evidence_dir/baseline/tests.log" 2>&1
red_exit=$?
set -e
node "$lane_dir/validate-tests.mjs" "$evidence_dir/baseline/tests.json" \
  "$evidence_dir/baseline/tests.log" red "$red_exit" > "$evidence_dir/baseline/test-validation.log"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
sha256sum --check "$lane_dir/candidate.sha256" > "$evidence_dir/candidate/source-before.log"
node "$lane_dir/driver.mjs" "$target_dir" "$evidence_dir/candidate" candidate \
  > "$evidence_dir/candidate/driver.log" 2>&1
node scripts/run-vitest.mjs src/cli/plugins-control-ui-build.test.ts \
  src/cli/plugins-authoring-command.test.ts src/cli/plugins-feature-artifact.test.ts \
  src/plugins/sdk-alias.test.ts --reporter=verbose --reporter=json \
  --outputFile="$evidence_dir/candidate/tests.json" > "$evidence_dir/candidate/tests.log" 2>&1
node "$lane_dir/validate-tests.mjs" "$evidence_dir/candidate/tests.json" \
  "$evidence_dir/candidate/tests.log" green 0 > "$evidence_dir/candidate/test-validation.log"
node scripts/check-changed.mjs --base "$SOURCE_SHA" -- src/cli/plugins-control-ui-build.ts \
  src/cli/plugins-control-ui-build.test.ts > "$evidence_dir/changed.log" 2>&1
sha256sum --check "$lane_dir/candidate.sha256" > "$evidence_dir/candidate/source-after.log"
sha256sum --check "$lane_dir/unchanged.sha256" > "$evidence_dir/unchanged-after.log"
git diff --check
git diff --binary HEAD -- > "$evidence_dir/candidate.patch"
printf '%s\n' PLUGIN_SOURCE_BUILD_COMPARISON_COMPLETE
