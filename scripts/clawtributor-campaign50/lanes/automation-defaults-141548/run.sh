#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == red ]]
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == red ]]
[[ "${PROOF_LANE:-}" == automation-defaults-141548 ]]
cd "$target_dir"
[[ "${SOURCE_SHA:-}" == 2a0601f530c912284f08b586987dfc3a0ed8469f ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" before
node "$lane_dir/reader-controls.mjs" > "$evidence_dir/reader-controls.json"
printf '%s\n' source-schema > "$evidence_dir/phase.txt"
node --import ./scripts/tsx.mjs "$lane_dir/generate-schema.mjs" "$target_dir" "$lane_dir" "$evidence_dir/generated-schema.json" > "$evidence_dir/schema.log" 2>&1
python3 - "$target_dir" "$lane_dir" "$evidence_dir" <<'PY'
import json, pathlib, shutil, sys
target, lane, evidence = map(pathlib.Path, sys.argv[1:])
manifest = json.loads((lane / 'MANIFEST.json').read_text())
for source, destination in manifest['copies'].items():
    output = target / destination
    assert not output.exists(), f'Proof destination already exists: {destination}'
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(lane / source, output)
output = target / manifest['generated']
assert not output.exists()
shutil.copyfile(evidence / 'generated-schema.json', output)
PY
printf '%s\n' chromium-install > "$evidence_dir/phase.txt"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser-baseline > "$evidence_dir/phase.txt"
set +e
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/media" OPENCLAW_UI_E2E_DIAGNOSTIC_DIR="$evidence_dir/diagnostics" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/automation-defaults-141548.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/vitest.log" 2>&1
native_exit=$?
set -e
printf '%s\n' "$native_exit" > "$evidence_dir/native-exit.txt"
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" after
node "$lane_dir/validate.mjs" "$evidence_dir" "$lane_dir" "$native_exit" > "$evidence_dir/validation.log" 2>&1
printf '%s\n' complete > "$evidence_dir/phase.txt"
