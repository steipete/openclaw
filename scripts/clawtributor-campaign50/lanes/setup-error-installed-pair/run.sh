#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == green && "${CI:-}" == 1 && "${PROOF_MODE:-}" == green && "${PROOF_LANE:-}" == setup-error-installed-pair ]] || exit 64
[[ "$(id -u)" != 0 && -x /usr/bin/strace ]] || exit 65
[[ "$(node --version)" == v24.20.0 && "$(pnpm --version)" == 12.3.4 ]] || exit 66
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == 5520a73e9115be31d5f710da23e9bd93ecff291f ]] || exit 67
git diff --quiet
git diff --cached --quiet
sha256sum --check "$lane_dir/source-before.sha256" > "$evidence_dir/source-before.log"
sha256sum "$lane_dir/run.sh" "$lane_dir/proof.mjs" "$lane_dir/candidate.patch" "$lane_dir/source-before.sha256" "$lane_dir/source-after.sha256" > "$evidence_dir/proof.sha256"
npm --version > "$evidence_dir/npm-version.txt"
/usr/bin/strace --version > "$evidence_dir/strace-version.txt"
exec node "$lane_dir/proof.mjs" "$target_dir" "$evidence_dir"
