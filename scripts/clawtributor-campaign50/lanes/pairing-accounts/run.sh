#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == compare ]]
cd "$target_dir"
bash "$lane_dir/run-phase.sh" "$target_dir" "$lane_dir" "$evidence_dir/baseline" baseline
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
bash "$lane_dir/run-phase.sh" "$target_dir" "$lane_dir" "$evidence_dir/candidate" green
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/source-hash-check.log"
git diff --check
cp "$lane_dir/candidate.patch" "$evidence_dir/candidate.patch"
cp "$lane_dir/candidate-files.sha256" "$evidence_dir/candidate-files.sha256"
cp "$lane_dir/pairing-approved-account.http.test.ts" "$evidence_dir/pairing-approved-account.http.test.ts"
