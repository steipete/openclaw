#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == green ]] || exit 64
base=72913f02470db00da7cf00cf6f0470bf23269b6d
mkdir -p "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == "$base" ]] || exit 65
[[ "$(node --version)" == v24.20.0 ]] || exit 66
[[ "$(pnpm --version)" == 12.3.4 ]] || exit 67
git diff --exit-code
git diff --cached --exit-code
printf '%s\n' "$base" > "$evidence_dir/source-sha.txt"
sha256sum --check "$lane_dir/baseline-files.sha256" > "$evidence_dir/baseline-source.log"
cp "$lane_dir/candidate-files.sha256" "$evidence_dir/candidate-files.sha256"
sha256sum "$lane_dir/run.sh" "$lane_dir/diagnostic-service.mjs" "$lane_dir/verify-tests.mjs" "$lane_dir/completed-report.mjs" "$lane_dir/tests.patch" "$lane_dir/production.patch" > "$evidence_dir/proof.sha256"
git apply --check "$lane_dir/tests.patch"
git apply "$lane_dir/tests.patch"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/candidate-before.log"
sha256sum --check "$lane_dir/unchanged-owner-files.sha256" > "$evidence_dir/owners-before.log"
set +e
node scripts/run-vitest.mjs run \
  src/cli/daemon-cli/status.print.test.ts src/cli/daemon-cli/status.gather.test.ts \
  src/cli/daemon-cli/status.test.ts src/cli/daemon-cli/shared.test.ts \
  src/daemon/runtime-format.test.ts src/cli/program/routes.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/unit-green.json" > "$evidence_dir/unit-green.log" 2>&1
unit_green_exit=$?
set -e
printf '%s\n' "$unit_green_exit" > "$evidence_dir/unit-green-exit.txt"
node "$lane_dir/verify-tests.mjs" "$evidence_dir" green "$unit_green_exit"
node "$lane_dir/diagnostic-service.mjs" "$target_dir" "$evidence_dir" green > "$evidence_dir/proof.log" 2>&1
node scripts/check-changed.mjs --base "$base" -- src/cli/daemon-cli/status.print.ts src/cli/daemon-cli/status.print.test.ts > "$evidence_dir/check-changed.log" 2>&1
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/candidate-after.log"
sha256sum --check "$lane_dir/unchanged-owner-files.sha256" > "$evidence_dir/owners-after.log"
git diff --check
git diff --binary > "$evidence_dir/candidate.patch"
