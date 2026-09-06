#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == baseline ]]
cd "$target_dir"
python3 "$lane_dir/run-paired-diagnostic.py" "$evidence_dir"
