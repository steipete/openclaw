#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == red ]]
mkdir -p "$evidence_dir"
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 305606ca5ac53a92c66e4e031c12ae3d44230c26 ]]
[[ "$SOURCE_SHA" == 305606ca5ac53a92c66e4e031c12ae3d44230c26 ]]
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check.log"
pnpm build > "$evidence_dir/build.log" 2>&1
node --import ./scripts/tsx.mjs "$lane_dir/driver.mts" "$target_dir" "$evidence_dir" red > "$evidence_dir/driver.log" 2>&1
sha256sum -c "$lane_dir/product.sha256" > "$evidence_dir/source-check-after.log"
printf '%s\n' complete > "$evidence_dir/phase.txt"
