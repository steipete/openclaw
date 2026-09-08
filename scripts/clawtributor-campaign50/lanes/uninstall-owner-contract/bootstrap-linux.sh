#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mkdir -p "$HOME" "$evidence_dir" "$HOME/tmp"
[[ "${CI:-}" == 1 && "${PROOF_LANE:-}" == uninstall-owner-posix && "${PROOF_MODE:-}" == baseline ]]
[[ "${PROOF_VARIANT:-}" == installer-ownership && "${SOURCE_SHA:-}" == f5a30f8484671abdb422a9ea8b39837a668ed019 ]]
[[ "${NODE_VERSION:-}" == 24.20.0 && "${PNPM_VERSION:-}" == 12.3.4 ]]
[[ "$(git -C "$target_dir" rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ -z "$(git -C "$target_dir" status --porcelain)" ]]
[[ "$(node --version)" == v24.20.0 ]]
export TMPDIR="$HOME/tmp"
python3 -I -S "$lane_dir/verify-inputs.py" "$lane_dir" "$target_dir" "$evidence_dir/input-before.json"
set +e
bash "$lane_dir/run.sh" "$target_dir" "$lane_dir" "$evidence_dir" baseline > "$evidence_dir/bootstrap-child.log" 2>&1
proof_exit=$?
set -e
printf '%s\n' "$proof_exit" > "$evidence_dir/exit-code.txt"
python3 -I -S "$lane_dir/verify-inputs.py" "$lane_dir" "$target_dir" "$evidence_dir/input-after.json"
git -C "$target_dir" diff --binary "$SOURCE_SHA" -- > "$evidence_dir/bootstrap-final-working-tree.patch"
[[ ! -s "$evidence_dir/bootstrap-final-working-tree.patch" ]]
exit "$proof_exit"
