#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == red ]] || exit 64
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 0a55c7c0d199da69e343ddf10115cb2dcba71b16 ]] || exit 65
[[ "$(node --version)" == v24.20.0 ]] || exit 66
[[ "$(pnpm --version)" == 12.3.4 ]] || exit 67
git diff --exit-code
git diff --cached --exit-code
git rev-parse HEAD > "$evidence_dir/source-sha.txt"
sha256sum --check "$lane_dir/source-files.sha256" > "$evidence_dir/source-before.log"
cp "$lane_dir/source-files.sha256" "$evidence_dir/source-files.sha256"
sha256sum "$lane_dir/run.sh" "$lane_dir/packaged-telemetry.mjs" "$lane_dir/verify-reuse.mjs" "$lane_dir/reuse-manifest.json" > "$evidence_dir/proof.sha256"
set +e
node "$lane_dir/packaged-telemetry.mjs" "$target_dir" "$evidence_dir" "$mode" > "$evidence_dir/proof.log" 2>&1
proof_exit=$?
set -e
printf '%s\n' "$proof_exit" > "$evidence_dir/proof-exit.txt"
sha256sum --check "$lane_dir/source-files.sha256" > "$evidence_dir/source-after.log"
git diff --binary > "$evidence_dir/final-tracked.patch"
git diff --exit-code
git diff --cached --exit-code
exit "$proof_exit"
