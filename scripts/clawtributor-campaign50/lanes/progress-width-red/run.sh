#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-before.json"
[[ "${CI:-}" == 1 ]]
[[ "$mode" == red && "${PROOF_MODE:-}" == red ]]
[[ "${PROOF_LANE:-}" == progress-width-red ]]
[[ "${SOURCE_SHA:?}" == 6aa09cbadb594c3d46d5bd49a28c514df1b256b0 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-before.log"
[[ "$(sha256sum node_modules/@clack/prompts/dist/index.mjs | cut -d' ' -f1)" == 917392e70d646fac367ff99ff3373528196dd56fb8436c373244a7f869277c0e ]]
sha256sum node_modules/@clack/prompts/dist/index.mjs > "$evidence_dir/dependency.log"
python3 "$lane_dir/driver.py" "$target_dir" "$lane_dir" "$evidence_dir" > "$evidence_dir/driver.log" 2>&1
# The checker executes source-owned fixed-width screen/ANSI helpers in a secretless environment.
env -i PATH="$PATH" HOME="$evidence_dir" TMPDIR="$evidence_dir" \
  node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/check.mts" \
  "$target_dir" "$lane_dir" "$evidence_dir" "$mode" > "$evidence_dir/acceptance.json" 2> "$evidence_dir/check.log"
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-after.json"
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-after.log"
git diff HEAD --exit-code > "$evidence_dir/final-tracked.patch"
printf '%s\n' PROGRESS_WIDTH_BASELINE_COMPLETE
