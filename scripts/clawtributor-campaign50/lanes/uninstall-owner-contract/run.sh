#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == baseline ]]
python3 -I -S "$lane_dir/verify-inputs.py" "$lane_dir" "$target_dir" "$evidence_dir/runner-input-before.json"
python3 -I -S "$lane_dir/supervisor-controls.py" check "$evidence_dir/supervisor-controls"
python3 -I -S "$lane_dir/launch-driver.py" "$target_dir" "$evidence_dir" linux
python3 -I -S "$lane_dir/check-artifact.py" "$evidence_dir" linux > "$evidence_dir/acceptance.json"
