#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-before.json"
[[ "${CI:-}" == 1 ]]
[[ "$mode" == green && "${PROOF_MODE:-}" == green ]]
[[ "${PROOF_LANE:-}" == progress-width-green-remaining ]]
[[ "${SOURCE_SHA:?}" == 6aa09cbadb594c3d46d5bd49a28c514df1b256b0 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-before.log"
sha256sum --check "$lane_dir/static-source.sha256" > "$evidence_dir/static-source-before.log"
python3 "$lane_dir/validate-reuse.py" "$lane_dir" > "$evidence_dir/reused-proof.json"
git apply --check "$lane_dir/candidate-before.patch"
git apply "$lane_dir/candidate-before.patch"
sha256sum --check "$lane_dir/candidate-before.sha256" > "$evidence_dir/reused-candidate-source.log"
git apply --reverse --check "$lane_dir/reuse/final-working-tree.patch"
git apply --check "$lane_dir/test-handle-repair.patch"
git apply "$lane_dir/test-handle-repair.patch"
sha256sum --check "$lane_dir/candidate-source.sha256" > "$evidence_dir/candidate-before.log"
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/remaining-checks.mjs" "$target_dir" "$lane_dir" "$evidence_dir" > "$evidence_dir/remaining-checks.log" 2>&1
git diff --check
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-after.json"
sha256sum --check "$lane_dir/source-after.sha256" > "$evidence_dir/source-after.log"
sha256sum --check "$lane_dir/static-source.sha256" > "$evidence_dir/static-source-after.log"
python3 - "$lane_dir" "$evidence_dir" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]);e=pathlib.Path(sys.argv[2]);r=json.loads((lane/'REPAIR.json').read_text())
assert set(subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines())==set(r['counts'])
for p,v in r['counts'].items():assert hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==v['sha256'],p
actual=subprocess.check_output(['git','diff','--abbrev=8','HEAD']);assert actual==(lane/'candidate.patch').read_bytes()
(e/'final-tracked.patch').write_bytes(actual)
(e/'candidate-bindings.json').write_text(json.dumps(r,indent=2)+'\n')
checks=json.loads((e/'remaining-checks.json').read_text());assert checks['complete'] and len(checks['results'])==9
assert checks['explicitShimCleanup'] and 'error' not in checks
assert all(x['status']==0 and x['strictOwnerResolved'] and x['closed'] for x in checks['results'])
(e/'completion.json').write_text(json.dumps({'accepted':True,'freshStaticChecks':9,'reusedRun':34169880359,'reusedUnits':50,'reusedPtyCases':12,'noFunctionalRerun':True})+'\n')
VERIFY
printf '%s\n' PROGRESS_WIDTH_REMAINING_COMPLETE
