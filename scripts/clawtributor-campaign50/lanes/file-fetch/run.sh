#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == compare ]]
cd "$target_dir"
bash "$lane_dir/run-file-fetch-proof.sh" "$lane_dir" "$evidence_dir"
sha256sum --check "$lane_dir/138411-candidate-files.sha256" > "$evidence_dir/source-hash-check.log"
