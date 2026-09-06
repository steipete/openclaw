#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
bash "$lane_dir/run-phase.sh" "$target_dir" "$lane_dir" "$evidence_dir/baseline" red
bash "$lane_dir/run-phase.sh" "$target_dir" "$lane_dir" "$evidence_dir/candidate" green
