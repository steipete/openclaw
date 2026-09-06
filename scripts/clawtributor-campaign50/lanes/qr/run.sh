#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in red|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
cd "$target_dir"
if [[ "$mode" == red ]]; then
  git apply --check "$lane_dir/unit-regression.patch"
  git apply "$lane_dir/unit-regression.patch"
fi
set +e
node scripts/run-vitest.mjs src/cli/qr-cli.test.ts -t 'prints the requested output for' \
  --reporter=json --outputFile="$evidence_dir/unit.json" > "$evidence_dir/unit.log" 2>&1
unit_exit=$?
set -e
node - "$evidence_dir/unit.json" "$mode" "$unit_exit" <<'NODE'
const fs = require('node:fs');
const [file, mode, exit] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const cases = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped');
const failures = cases.filter(test => test.status === 'failed');
if (mode === 'red') {
  if (exit !== '1' || cases.length !== 4 || failures.length !== 2 || !failures.every(test => test.failureMessages.join('\n').includes('QR_JSON_WRITER_NOT_REACHED'))) {
    throw new Error('Baseline did not reproduce exactly two combined-flag JSON writer failures');
  }
} else if (exit !== '0' || cases.length !== 4 || failures.length !== 0) {
  throw new Error('Candidate did not pass all four owner output modes');
}
console.log(`QR_OWNER_${mode.toUpperCase()}_CONFIRMED`);
NODE
pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/probe.mjs" "$target_dir" "$evidence_dir" "$mode" > "$evidence_dir/probe.log" 2>&1
