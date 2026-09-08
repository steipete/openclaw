#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == green && "${CI:-}" == 1 && "${PROOF_MODE:-}" == green ]]
[[ "${PROOF_LANE:-}" == automation-defaults-141548 ]]
[[ "${SOURCE_SHA:-}" == 74fd11e05f2d5730dc03a67e27cc2d227ca5b339 ]]
cd "$target_dir"
[[ "$(node --version)" == v24.20.0 && "$(pnpm --version)" == 12.3.4 ]]
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" before
node "$lane_dir/reader-controls.mjs" > "$evidence_dir/reader-controls.json"
node "$lane_dir/check-plan-contract.mjs" > "$evidence_dir/plan-controls.json"
python3 -B "$lane_dir/check-reuse.py" > "$evidence_dir/reuse-controls.json"
python3 "$lane_dir/validate-reuse.py" "$lane_dir" > "$evidence_dir/reused-unit-bindings.json"
node "$lane_dir/validate-unit.mjs" "$lane_dir/reuse" red 1 > "$evidence_dir/reused-unit-validation.json"
python3 -B "$lane_dir/check-reuse69.py" > "$evidence_dir/reuse69-controls.json"
node "$lane_dir/validate-reuse69.mjs" "$lane_dir" > "$evidence_dir/reused-candidate.json"
printf '%s\n' restore-proven-source > "$evidence_dir/phase.txt"
git apply --check "$lane_dir/regression.patch"
git apply "$lane_dir/regression.patch"
git apply --check "$lane_dir/production.patch"
git apply "$lane_dir/production.patch"
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
shutil.copyfile(lane / 'reuse-69/generated-schema.json', output)
shutil.copyfile(lane / 'reuse-69/generated-schema.json', evidence / 'generated-schema.json')
PY
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" candidate
printf '%s\n' remaining-static > "$evidence_dir/phase.txt"
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/remaining-checks.mjs" "$target_dir" "$lane_dir" "$evidence_dir" > "$evidence_dir/remaining-checks.log" 2>&1
python3 "$lane_dir/verify-source.py" "$target_dir" "$lane_dir" "$evidence_dir" after
git diff --check
python3 - "$evidence_dir" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); r = json.loads((p / 'remaining-checks.json').read_text())
assert r['complete'] and r['explicitShimCleanup'] and 'error' not in r
assert len(r['results']) == r['expectedRemaining'] == len(r['planned'])
assert r['canonicalPlanCount'] == len(r['reusedCommands']) + len(r['planned'])
assert all(row['status'] == 0 and row['closed'] and row['strictOwnerResolved'] for row in r['results'])
(p / 'completion.json').write_text(json.dumps({'reusedFailedRun': 34189419890, 'reusedUnits': 15, 'reusedBrowserCases': 6, 'reusedCaptures': 19, 'remainingChecks': len(r['results']), 'canonicalPlanCount': r['canonicalPlanCount'], 'complete': True}) + '\n')
PY
printf '%s\n' complete > "$evidence_dir/phase.txt"
