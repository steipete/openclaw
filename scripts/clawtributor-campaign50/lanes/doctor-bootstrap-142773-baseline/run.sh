#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${CI:-}" == 1 ]]
[[ "$mode" == baseline && "${PROOF_MODE:-}" == baseline ]]
[[ "${PROOF_LANE:-}" == doctor-bootstrap-142773-baseline ]]
[[ "${SOURCE_SHA:?}" == 7c6ca652ef75c7bea81659879424551fabfdafe3 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-before.log"
node --import ./scripts/tsx.mjs "$lane_dir/driver.mjs" "$target_dir" "$evidence_dir" > "$evidence_dir/driver.log" 2>&1
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-after.log"
git diff HEAD --exit-code
printf '%s\n' DOCTOR_BOOTSTRAP_BASELINE_COMPLETE
