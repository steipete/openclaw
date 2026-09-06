#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == compare ]]
cd "$target_dir"
bash "$lane_dir/run-followup.sh" "$target_dir" "$lane_dir" "$evidence_dir/baseline-zalo" baseline-zalo
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
bash "$lane_dir/run-followup.sh" "$target_dir" "$lane_dir" "$evidence_dir/candidate" green-remaining
git diff --check
cp "$lane_dir/candidate.patch" "$evidence_dir/candidate.patch"
cp "$lane_dir/candidate-files.sha256" "$evidence_dir/candidate-files.sha256"
cp "$lane_dir/followup-lineage.json" "$evidence_dir/prior-evidence.json"
