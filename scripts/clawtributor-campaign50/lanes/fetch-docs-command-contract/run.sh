#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-receipt.json"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == baseline && "$mode" == baseline ]]
[[ "${PROOF_LANE:-}" == fetch-docs-command-contract ]]
[[ "${SOURCE_SHA:?}" == 9d64ec1e5dc611cfa60cb67f843b2f641ab23c8b ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-before.log"
python3 "$lane_dir/driver.py" "$evidence_dir" > "$evidence_dir/driver.log" 2>&1
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-after-receipt.json"
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-after.log"
git diff HEAD --exit-code
python3 "$lane_dir/check-artifact.py" "$evidence_dir" > "$evidence_dir/acceptance.json"
printf '%s\n' FETCH_DOCS_COMMAND_COMPLETE
