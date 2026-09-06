#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
bash "$lane_dir/run-file-fetch-nfc-proof.sh" "$lane_dir" "$evidence_dir"
