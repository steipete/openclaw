#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${SOURCE_SHA:?}" == 7475087fa97a73587e2b15ac514733ae3bbfa024 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff --exit-code
git apply --check "$lane_dir/regression-tests.patch"
git apply "$lane_dir/regression-tests.patch"
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/parser-changed-boundaries.mjs" \
  "$target_dir" "$evidence_dir" baseline > "$evidence_dir/changed-boundaries-baseline.log" 2>&1
owner_tests=(src/infra/cli-root-options.test.ts src/cli/program/route-args.test.ts)
for owner in "${owner_tests[@]}"; do
  report="$evidence_dir/baseline-$(basename "$owner" .test.ts)"
  set +e
  node scripts/run-vitest.mjs "$owner" \
    -t 'requires the root command before command options|defers command options placed before status or health' \
    --reporter=verbose --reporter=json --reporter="$target_dir/scripts/lib/vitest-report-capture.mts" \
    --outputFile.json="$report.json" > "$report.log" 2>&1
  baseline_exit=$?
  set -e
  node "$lane_dir/verify-unit.mjs" "$report.json" "$report.log" baseline "$baseline_exit" "$owner"
done
git apply --reverse --check "$lane_dir/regression-tests.patch"
git apply --reverse "$lane_dir/regression-tests.patch"
git diff --exit-code
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
set +e
node scripts/run-vitest.mjs "${owner_tests[@]}" src/cli/argv-invocation.test.ts \
  src/cli/cron-cli/register.cron-simple.test.ts src/cli/program/error-output.test.ts src/cli/argv.test.ts \
  --reporter=verbose --reporter=json --outputFile.json="$evidence_dir/candidate-unit.json" \
  > "$evidence_dir/candidate-unit.log" 2>&1
candidate_exit=$?
set -e
node "$lane_dir/verify-unit.mjs" "$evidence_dir/candidate-unit.json" "$evidence_dir/candidate-unit.log" candidate "$candidate_exit"
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/parser-candidate.mjs" "$target_dir" "$evidence_dir" > "$evidence_dir/parser-candidate.log" 2>&1
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/parser-changed-boundaries.mjs" \
  "$target_dir" "$evidence_dir" candidate > "$evidence_dir/changed-boundaries-candidate.log" 2>&1
pnpm build > "$evidence_dir/build.log" 2>&1
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/candidate-cli.mjs" "$target_dir" "$evidence_dir" > "$evidence_dir/cli-candidate.log" 2>&1
node - "$lane_dir/CANDIDATE-PACKET.json" <<'VERIFY_SOURCE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const packet = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [file, expected] of Object.entries(packet.files)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, file);
}
VERIFY_SOURCE
git diff --check
git diff --binary --full-index > "$evidence_dir/candidate.patch"
echo ROOT_OPTION_CANDIDATE_OK
