#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == green && "${CI:-}" == 1 && "${PROOF_MODE:-}" == green && "${PROOF_LANE:-}" == setup-error-reporting-green ]] || exit 64
base=3ffa84f3fe94d3efedd858315e27d79beebcfe1c
mkdir -p "$evidence_dir/cases"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == "$base" ]] || exit 65
git diff --quiet
git diff --cached --quiet
[[ ! -e src/system-agent/setup-inference-error-reporting.test.ts ]] || exit 66
[[ "$(node --version)" == v24.20.0 ]] || exit 67
node -e 'const p=require("./package.json"); if(!p.packageManager.startsWith("pnpm@12.3.4+"))process.exit(68)'
sha256sum --check "$lane_dir/source-before.sha256" > "$evidence_dir/source-before.log"
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
sha256sum --check "$lane_dir/source-after.sha256" > "$evidence_dir/candidate-before.log"
cp src/system-agent/setup-inference-error-reporting.test.ts "$evidence_dir/overlay-test.ts"
sha256sum "$lane_dir/run.sh" "$lane_dir/candidate.patch" "$lane_dir/verify-green.mjs" "$lane_dir/completed-report.mjs" > "$evidence_dir/proof.sha256"
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
node scripts/run-vitest.mjs \
  src/system-agent/setup-inference.test.ts \
  src/commands/system-agent-with-inference.test.ts \
  src/logging/redact.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/owners.json" > "$evidence_dir/owners.log" 2>&1
owner_exit=$?
set -e
printf '%s\n' "$test_exit" > "$evidence_dir/test-exit.txt"
printf '%s\n' "$owner_exit" > "$evidence_dir/owner-exit.txt"
node "$lane_dir/verify-green.mjs" "$evidence_dir" "$test_exit" "$owner_exit"
node scripts/check-changed.mjs --base "$base" -- \
  src/system-agent/setup-inference-core.ts \
  src/system-agent/setup-inference-activate.ts \
  src/system-agent/setup-inference-verify.ts \
  src/system-agent/setup-inference-error-reporting.test.ts \
  docs/cli/openclaw.md > "$evidence_dir/check-changed.log" 2>&1
sha256sum --check "$lane_dir/source-after.sha256" > "$evidence_dir/candidate-after.log"
cmp "$lane_dir/error-reporting.test.ts" src/system-agent/setup-inference-error-reporting.test.ts
git diff --cached --quiet
