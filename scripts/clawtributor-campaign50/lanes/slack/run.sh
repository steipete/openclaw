#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
bash "$lane_dir/slack-reaction-run.sh" "$target_dir" "$lane_dir" "$evidence_dir/baseline" baseline
git apply --check "$lane_dir/136374-final.patch"
git apply "$lane_dir/136374-final.patch"
git diff --binary > "$evidence_dir/candidate.patch"
sha256sum extensions/slack/src/actions.ts extensions/slack/src/actions.reactions.test.ts > "$evidence_dir/candidate-files.sha256"
bash "$lane_dir/slack-reaction-run.sh" "$target_dir" "$lane_dir" "$evidence_dir/candidate" green
git diff --check
