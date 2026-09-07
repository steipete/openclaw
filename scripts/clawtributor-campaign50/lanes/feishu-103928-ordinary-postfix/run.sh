#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
exec node --import ./scripts/tsx.mjs "$lane_dir/proof.mjs" "$target_dir" "$lane_dir" "$evidence_dir" "$mode"
