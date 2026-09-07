#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
base=b8cbece8fb8de577d9ff33cedf8d8250585c55e4
[[ "$mode" == green ]]
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "$(git rev-parse HEAD)" == "$base" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff --exit-code
git diff --cached --exit-code
retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  exit "$proof_exit"
}
trap retain_diff EXIT
printf '%s\n' "$base" > "$evidence_dir/source-sha.txt"
sha256sum --check "$lane_dir/baseline-files.sha256" > "$evidence_dir/baseline-source.log"
printf '%s  %s\n' ae8d599cf1e05c5c6a024fd8c5fd431bb5300ceb1773e5ba9b9a7fbfa3f10fc3 "$lane_dir/reuse/LINEAGE.json" | sha256sum --check
sha256sum "$lane_dir/run.sh" "$lane_dir/verify.mjs" "$lane_dir/correction.patch" "$lane_dir/completed-report.mjs" > "$evidence_dir/proof.sha256"
git apply --check "$lane_dir/reuse/final-working-tree.patch"
git apply "$lane_dir/reuse/final-working-tree.patch"
sha256sum --check "$lane_dir/reuse/candidate-files.sha256" > "$evidence_dir/previous-candidate.log"
git apply --check "$lane_dir/correction.patch"
git apply "$lane_dir/correction.patch"
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/candidate-before.log"
sha256sum --check "$lane_dir/unchanged-owner-files.sha256" > "$evidence_dir/owners-before.log"
node "$lane_dir/verify.mjs" "$lane_dir" "$target_dir" "$evidence_dir" reuse > "$evidence_dir/reuse.log" 2>&1
set +e
node scripts/run-vitest.mjs run --config test/vitest/vitest.cli.config.ts src/cli/telemetry-cli.test.ts \
  --reporter=verbose --reporter=json --reporter=./scripts/lib/vitest-report-capture.mts \
  --outputFile.json="$evidence_dir/unit.json" > "$evidence_dir/unit.log" 2>&1
unit_exit=$?
set -e
printf '%s\n' "$unit_exit" > "$evidence_dir/unit-exit.txt"
node "$lane_dir/verify.mjs" "$lane_dir" "$target_dir" "$evidence_dir" tests "$unit_exit" > "$evidence_dir/unit-verification.log" 2>&1
run_step() {
  local label=$1
  shift
  set +e
  "$@" > "$evidence_dir/$label.log" 2>&1
  local step_exit=$?
  set -e
  printf '%s\t%s\n' "$label" "$step_exit" >> "$evidence_dir/steps.tsv"
  return "$step_exit"
}
run_step format node_modules/.bin/oxfmt --check --no-error-on-unmatched-pattern -- src/cli/telemetry-cli.test.ts src/cli/telemetry-cli.ts
run_step lint node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.core.json src/cli/telemetry-cli.test.ts src/cli/telemetry-cli.ts
run_step native-schema node scripts/check-native-state-schema-version.mjs
run_step database-first pnpm check:database-first-legacy-stores
run_step media pnpm check:media-download-helpers
run_step sidecar pnpm check:runtime-sidecar-loaders
run_step cycles pnpm check:import-cycles
run_step webhook pnpm lint:webhook:no-low-level-body-read
run_step pairing-store pnpm lint:auth:no-pairing-store-group
run_step pairing-account pnpm lint:auth:pairing-account-scope
sha256sum --check "$lane_dir/candidate-files.sha256" > "$evidence_dir/candidate-after.log"
sha256sum --check "$lane_dir/unchanged-owner-files.sha256" > "$evidence_dir/owners-after.log"
git diff --check
git diff --name-only | sort > "$evidence_dir/changed-files.txt"
cut -d ' ' -f 3 "$lane_dir/candidate-files.sha256" | sort > "$evidence_dir/expected-files.txt"
cmp "$evidence_dir/changed-files.txt" "$evidence_dir/expected-files.txt"
printf '%s\n' TELEMETRY_140283_LINT_REMAINING_COMPLETE
