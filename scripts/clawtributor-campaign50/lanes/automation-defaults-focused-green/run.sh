#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == green ]]
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == green ]]
[[ "${PROOF_LANE:-}" == automation-defaults-141548 ]]
cd "$target_dir"
[[ "${SOURCE_SHA:-}" == 74fd11e05f2d5730dc03a67e27cc2d227ca5b339 ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
[[ "${OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM:-}" != 1 ]]
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" before
node "$lane_dir/reader-controls.mjs" > "$evidence_dir/reader-controls.json"
printf '%s\n' unit-regression-red > "$evidence_dir/phase.txt"
git apply --check "$lane_dir/regression.patch"
git apply "$lane_dir/regression.patch"
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" unit-red
set +e
node scripts/run-vitest.mjs run src/config/schema.hints.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/unit-red.json" > "$evidence_dir/unit-red.log" 2>&1
unit_red_exit=$?
set -e
printf '%s\n' "$unit_red_exit" > "$evidence_dir/unit-red-exit.txt"
node "$lane_dir/validate-unit.mjs" "$evidence_dir" red "$unit_red_exit" > "$evidence_dir/unit-red-validation.json"
printf '%s\n' candidate-source > "$evidence_dir/phase.txt"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
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
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" candidate
printf '%s\n' unit-candidate-green > "$evidence_dir/phase.txt"
node scripts/run-vitest.mjs run src/config/schema.hints.test.ts --reporter=verbose --reporter=json --outputFile="$evidence_dir/unit-green.json" > "$evidence_dir/unit-green.log" 2>&1
node "$lane_dir/validate-unit.mjs" "$evidence_dir" green 0 > "$evidence_dir/unit-green-validation.json"
printf '%s\n' chromium-install > "$evidence_dir/phase.txt"
pnpm exec playwright install --with-deps chromium > "$evidence_dir/chromium-install.log" 2>&1
printf '%s\n' browser-candidate > "$evidence_dir/phase.txt"
set +e
OPENCLAW_UI_E2E_ARTIFACT_DIR="$evidence_dir/media" OPENCLAW_UI_E2E_DIAGNOSTIC_DIR="$evidence_dir/diagnostics" \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/automation-defaults-141548.e2e.test.ts \
  --reporter=verbose --reporter=json --outputFile="$evidence_dir/vitest.json" \
  > "$evidence_dir/vitest.log" 2>&1
native_exit=$?
set -e
printf '%s\n' "$native_exit" > "$evidence_dir/native-exit.txt"
node "$lane_dir/validate.mjs" "$evidence_dir" "$lane_dir" "$native_exit" > "$evidence_dir/validation.log" 2>&1
printf '%s\n' changed-check > "$evidence_dir/phase.txt"
node scripts/check-changed.mjs --base 74fd11e05f2d5730dc03a67e27cc2d227ca5b339 -- src/config/schema.hints.ts src/config/schema.hints.test.ts > "$evidence_dir/changed-check.log" 2>&1
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" after
git diff --check
printf '%s\n' complete > "$evidence_dir/phase.txt"
