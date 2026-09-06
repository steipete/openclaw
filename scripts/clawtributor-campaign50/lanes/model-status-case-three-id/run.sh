#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == red ]] || exit 64
mkdir -p "$evidence_dir"
cd "$target_dir"
source_sha=$(git rev-parse HEAD)
[[ "$source_sha" == 55d979e5187e544230808cb7ab906828c3e3f603 ]] || exit 65
printf '%s\n' "$source_sha" > "$evidence_dir/source-sha.txt"
sha256sum --check "$lane_dir/source-files.sha256" > "$evidence_dir/source-before.log"
cp "$lane_dir/source-files.sha256" "$evidence_dir/source-files.sha256"
sha256sum "$lane_dir/run.sh" "$lane_dir/status-case-baseline.mjs" > "$evidence_dir/proof.sha256"
pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/status-case-baseline.mjs" "$target_dir" "$evidence_dir" > "$evidence_dir/proof.log" 2>&1
sha256sum --check "$lane_dir/source-files.sha256" > "$evidence_dir/source-after.log"
git diff --check
