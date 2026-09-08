#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
[[ "$mode" == compare && "${CI:-}" == 1 && "${PROOF_MODE:-}" == compare && "${PROOF_LANE:-}" == fixture-endpoint-isolation ]] || exit 64
[[ "$(node --version)" == v24.20.0 && "$(pnpm --version)" == 12.3.4 ]] || exit 65
base=eb470406185fbdf2e8cfc9cd365b7a3e7062fe09
test_file=test/helpers/openclaw-test-instance.env.test.ts
owner_file=test/helpers/openclaw-test-instance.ts
mkdir -p "$evidence_dir"
[[ ! -e "$evidence_dir/red.json" && ! -e "$evidence_dir/green.json" && ! -e "$evidence_dir/complete.txt" && ! -e "$evidence_dir/red.json.capture.json" && ! -e "$evidence_dir/green.json.capture.json" ]] || exit 68
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == "$base" ]] || exit 66
git diff --quiet
git diff --cached --quiet
[[ ! -e "$test_file" ]] || exit 67
sha256sum --check "$lane_dir/source-before.sha256" > "$evidence_dir/source-before.log"
sha256sum "$lane_dir/run.sh" "$lane_dir/verify.mjs" "$lane_dir/completed-report.mjs" "$lane_dir/regression.patch" "$lane_dir/regression.test.ts" "$lane_dir/owner.patch" "$lane_dir/source-before.sha256" "$lane_dir/source-after.sha256" > "$evidence_dir/packet.sha256"
retain() {
  result=$?
  trap - EXIT
  if ! git diff --binary --full-index --no-ext-diff --no-textconv > "$evidence_dir/final-working-tree.patch"; then result=1; fi
  if [[ -f "$test_file" ]]; then
    if ! cp "$test_file" "$evidence_dir/exercised-test.ts"; then result=1; fi
  fi
  if ! printf '%s\n' "$result" > "$evidence_dir/runner-exit.txt"; then result=1; fi
  exit "$result"
}
trap retain EXIT
git apply --check "$lane_dir/regression.patch"
git apply "$lane_dir/regression.patch"
cmp "$test_file" "$lane_dir/regression.test.ts"
sha256sum --check "$lane_dir/source-before.sha256" > "$evidence_dir/baseline-before.log"
set +e
node scripts/run-vitest.mjs run --config test/vitest/vitest.tooling.config.ts "$test_file" \
  --reporter=verbose --reporter=json --reporter=./scripts/lib/vitest-report-capture.mts --outputFile.json="$evidence_dir/red.json" > "$evidence_dir/red.log" 2>&1
red_exit=$?
set -e
printf '%s\n' "$red_exit" > "$evidence_dir/red-exit.txt"
node "$lane_dir/verify.mjs" red "$evidence_dir" "$target_dir" "$red_exit"
sha256sum --check "$lane_dir/source-before.sha256" > "$evidence_dir/baseline-after.log"
cmp "$test_file" "$lane_dir/regression.test.ts"
git diff --quiet
git diff --cached --quiet
git apply --check "$lane_dir/owner.patch"
git apply "$lane_dir/owner.patch"
sha256sum --check "$lane_dir/source-after.sha256" > "$evidence_dir/candidate-before.log"
set +e
node scripts/run-vitest.mjs run --config test/vitest/vitest.tooling.config.ts "$test_file" \
  --reporter=verbose --reporter=json --reporter=./scripts/lib/vitest-report-capture.mts --outputFile.json="$evidence_dir/green.json" > "$evidence_dir/green.log" 2>&1
green_exit=$?
set -e
printf '%s\n' "$green_exit" > "$evidence_dir/green-exit.txt"
node "$lane_dir/verify.mjs" green "$evidence_dir" "$target_dir" "$green_exit"
sha256sum --check "$lane_dir/source-after.sha256" > "$evidence_dir/candidate-after.log"
cmp "$test_file" "$lane_dir/regression.test.ts"
git diff --check
git diff --cached --quiet
[[ "$(git diff --name-only)" == "$owner_file" ]] || exit 69
printf '%s\n' 'FIXTURE_ENDPOINT_ISOLATION_PAIR_CONFIRMED' > "$evidence_dir/complete.txt"
