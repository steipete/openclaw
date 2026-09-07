#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == red && "${CI:-}" == 1 && "${PROOF_MODE:-}" == red && "${PROOF_LANE:-}" == setup-error-reporting-red ]] || exit 64
base=6df7c32f477a458950f01a541119944b5bd85557
mkdir -p "$evidence_dir/cases"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == "$base" ]] || exit 65
git diff --quiet
git diff --cached --quiet
[[ ! -e src/system-agent/setup-inference-error-reporting.test.ts ]] || exit 66
[[ "$(node --version)" == v24.20.0 ]] || exit 67
node -e 'const p=require("./package.json"); if(!p.packageManager.startsWith("pnpm@12.3.4+"))process.exit(68)'
sha256sum --check "$lane_dir/source-files.sha256" > "$evidence_dir/source-before.log"
cp "$lane_dir/error-reporting.test.ts" src/system-agent/setup-inference-error-reporting.test.ts
cp "$lane_dir/error-reporting.test.ts" "$evidence_dir/overlay-test.ts"
cmp "$lane_dir/error-reporting.test.ts" src/system-agent/setup-inference-error-reporting.test.ts
sha256sum "$lane_dir/run.sh" "$lane_dir/error-reporting.test.ts" "$lane_dir/verify-red.mjs" "$lane_dir/completed-report.mjs" > "$evidence_dir/proof.sha256"
printf '%s\n' "$base" > "$evidence_dir/source-sha.txt"
retain() {
  result=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch"
  sha256sum src/system-agent/setup-inference-error-reporting.test.ts > "$evidence_dir/test-after.sha256"
  printf '%s\n' "$result" > "$evidence_dir/runner-exit.txt"
  exit "$result"
}
trap retain EXIT
set +e
OPENCLAW_SETUP_ERROR_PROOF_DIR="$evidence_dir/cases" node scripts/run-vitest.mjs \
  src/system-agent/setup-inference-error-reporting.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/tests.json" > "$evidence_dir/tests.log" 2>&1
test_exit=$?
set -e
printf '%s\n' "$test_exit" > "$evidence_dir/test-exit.txt"
node "$lane_dir/verify-red.mjs" "$evidence_dir" "$test_exit"
sha256sum --check "$lane_dir/source-files.sha256" > "$evidence_dir/source-after.log"
cmp "$lane_dir/error-reporting.test.ts" src/system-agent/setup-inference-error-reporting.test.ts
git diff --quiet
git diff --cached --quiet
