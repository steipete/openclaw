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
[[ "${PROOF_LANE:-}" == progress-width-green ]]
[[ "${SOURCE_SHA:?}" == 6aa09cbadb594c3d46d5bd49a28c514df1b256b0 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff HEAD --exit-code
sha256sum --check "$lane_dir/source.sha256" > "$evidence_dir/source-before.log"
[[ "$(sha256sum node_modules/@clack/prompts/dist/index.mjs | cut -d' ' -f1)" == 917392e70d646fac367ff99ff3373528196dd56fb8436c373244a7f869277c0e ]]
sha256sum node_modules/@clack/prompts/dist/index.mjs > "$evidence_dir/dependency.log"
python3 "$lane_dir/verify-reuse.py" > "$evidence_dir/reused-baseline.json"
git apply --check "$lane_dir/full-candidate.patch"
git apply "$lane_dir/full-candidate.patch"
sha256sum --check "$lane_dir/source-green.sha256" > "$evidence_dir/candidate-before.log"
set +e
node scripts/run-vitest.mjs src/cli/progress.test.ts src/wizard/clack-prompter.test.ts --reporter=default --reporter=json --outputFile.json="$evidence_dir/unit-green.json" > "$evidence_dir/unit-green.log" 2>&1
unit_code=$?
set -e
printf '%s\n' "$unit_code" > "$evidence_dir/unit-green-exit.txt"
node "$lane_dir/validate-tests.mjs" "$evidence_dir/unit-green.json" "$evidence_dir/unit-green.log" "$unit_code" > "$evidence_dir/unit-acceptance.json"
python3 "$lane_dir/driver.py" "$target_dir" "$lane_dir" "$evidence_dir" > "$evidence_dir/driver.log" 2>&1
env -i PATH="$PATH" HOME="$evidence_dir" TMPDIR="$evidence_dir" \
  node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/check.mts" \
  "$target_dir" "$lane_dir" "$evidence_dir" "$mode" > "$evidence_dir/acceptance.json" 2> "$evidence_dir/check.log"
node scripts/check-changed.mjs --base "$SOURCE_SHA" -- src/cli/progress.ts src/cli/progress.test.ts src/wizard/clack-prompter.ts src/wizard/clack-prompter.test.ts > "$evidence_dir/check-changed.log" 2>&1
git diff --check
python3 "$lane_dir/verify-inputs.py" "$lane_dir" "$evidence_dir/input-after.json"
sha256sum --check "$lane_dir/source-green.sha256" > "$evidence_dir/source-after.log"
python3 - "$lane_dir/SOURCE-TESTS.json" "$evidence_dir" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
p=json.loads(pathlib.Path(sys.argv[1]).read_text());e=pathlib.Path(sys.argv[2])
assert set(subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines())==set(p['counts'])
for name,values in p['counts'].items():assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==values['sha256'],name
(e/'final-tracked.patch').write_bytes(subprocess.check_output(['git','diff','HEAD']))
(e/'candidate-bindings.json').write_text(json.dumps(p,indent=2)+'\n')
VERIFY
printf '%s\n' PROGRESS_WIDTH_CANDIDATE_COMPLETE
