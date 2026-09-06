#!/usr/bin/env bash
set -euo pipefail
# Arguments are absolute paths to target checkout, lane artifacts, evidence parent, and red|green.
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
case "$mode" in red|green) ;; *) exit 64 ;; esac
mkdir -p "$evidence_dir"
cd "$target_dir"
if [[ "$mode" == green ]]; then
  [[ "$(git rev-parse HEAD)" == 2cfe54b5a223b62418525dda5d7a060a082cd38c ]] || exit 65
  git fetch --no-tags --depth=2 origin 2cfe54b5a223b62418525dda5d7a060a082cd38c
  [[ "$(git rev-parse HEAD^)" == 9fcbf35492836af8991e87f3ea93b8300fda6a64 ]] || exit 65
  git apply --check "$lane_dir/candidate-production.patch"
  git apply "$lane_dir/candidate-production.patch"
fi
cp "$lane_dir/device-binding-state.e2e.test.ts" ui/src/e2e/device-binding-state.e2e.test.ts
if [[ "$mode" == green ]]; then
  node scripts/run-vitest.mjs ui/src/pages/devices/view.execution.test.ts \
    ui/src/pages/devices/view.devices.test.ts src/shared/node-match.test.ts \
    src/agents/bash-tools.exec-host-node-phases.test.ts \
    > "$evidence_dir/focused.log" 2>&1
fi
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
filters=()
if [[ "$mode" == red ]]; then
  filters=(-t 'keeps saved ID bindings')
fi
# This config's global setup builds fresh source into an invocation-owned temporary
# production bundle and serves that bundle; it never consumes canonical dist.
set +e
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/browser" node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/device-binding-state.e2e.test.ts "${filters[@]}" \
  --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/browser.log" 2>&1
proof_exit=$?
set -e
node - "$evidence_dir/vitest.json" "$mode" "$proof_exit" <<'NODE'
const fs = require('node:fs');
const [reportPath, mode, exit] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const cases = report.testResults.flatMap(file => file.assertionResults);
const failures = cases.filter(test => test.status === 'failed');
if (mode === 'red') {
  if (exit === '0' || failures.length !== 1 || !failures[0].fullName.includes('saved ID bindings') || !failures[0].failureMessages.join('\n').includes('BINDING_SELECTION_LOSS_133032')) {
    throw new Error('Red proof failed to demonstrate the specific saved-binding selection loss');
  }
  console.log('PR133032_RED_CONFIRMED: saved binding selection lost after capability loss');
} else {
  if (exit !== '0' || failures.length || cases.filter(test => test.status === 'passed').length !== 2) {
    throw new Error('Green proof requires both ID and name browser lifecycle scenarios');
  }
  console.log('PR133032_GREEN_CONFIRMED: ID and name selections survive loss/recovery with no config writes or pending draft');
}
NODE

if [[ "$mode" == green ]]; then
  node scripts/check-changed.mjs --base 9fcbf35492836af8991e87f3ea93b8300fda6a64 -- ui/src/pages/devices/view.ts \
    ui/src/i18n/locales/en.ts ui/src/pages/devices/view.execution.test.ts \
    ui/src/e2e/device-binding-state.e2e.test.ts docs/tools/exec.md \
    > "$evidence_dir/changed-check.log" 2>&1
  sha256sum ui/src/pages/devices/view.ts ui/src/pages/devices/view.execution.test.ts \
    ui/src/i18n/locales/en.ts ui/src/e2e/device-binding-state.e2e.test.ts docs/tools/exec.md \
    > "$evidence_dir/candidate-files.sha256"
  sha256sum --check "$lane_dir/candidate-files.sha256"
  git diff --check
fi
