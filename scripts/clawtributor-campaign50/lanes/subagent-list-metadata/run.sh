#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
test "$4" = green
mkdir -p "$proof_evidence/unit-red" "$proof_evidence/focused"
cd "$proof_target"
python3 "$proof_lane/verify-binding.py" "$proof_lane/MANIFEST.json" baseline
cp "$proof_lane/baseline-lineage.json" "$proof_evidence/baseline-lineage.json"
cp "$proof_lane/baseline-verdict.json" "$proof_evidence/baseline-verdict.json"
cp "$proof_lane/candidate.patch" "$proof_evidence/candidate.patch"
git apply "$proof_lane/tests.patch"
proof_file=src/agents/subagents/registry/subagent-list.test.ts
set +e
node scripts/run-vitest.mjs "$proof_file" -t 'builds the subagent list without decoding unrelated saved prompts' --reporter=verbose --reporter=json --outputFile="$proof_evidence/unit-red/tests.json" > "$proof_evidence/unit-red/tests.log" 2>&1
proof_exit=$?
set -e
node "$proof_lane/verify-tests.mjs" red "$proof_evidence/unit-red/tests.json" "$proof_evidence/unit-red/tests.log" "$proof_exit" "$proof_file"
git apply --reverse "$proof_lane/tests.patch"
git apply "$proof_lane/production.patch"
bash "$proof_lane/run-real-flow.sh" "$proof_target" "$proof_lane" "$proof_evidence/real-flow" green
git apply "$proof_lane/tests.patch"
proof_files=(
  src/agents/subagents/registry/subagent-list.test.ts
  src/agents/subagents/registry/subagent-active-context.test.ts
  src/agents/tools/subagents-tool.test.ts
)
for proof_file in "${proof_files[@]}"; do
  proof_key=${proof_file//\//_}
  node scripts/run-vitest.mjs "$proof_file" --reporter=verbose --reporter=json --outputFile="$proof_evidence/focused/$proof_key.json" > "$proof_evidence/focused/$proof_key.log" 2>&1
  node "$proof_lane/verify-tests.mjs" green "$proof_evidence/focused/$proof_key.json" "$proof_evidence/focused/$proof_key.log" 0 "$proof_file"
done
python3 - "$proof_lane" "$proof_evidence" <<'PY'
import hashlib,json,pathlib,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2])
before=json.loads((lane/'baseline-verdict.json').read_text())
after=json.loads((evidence/'real-flow/verdict.json').read_text())
assert before['verdict']=='EXPECTED_UNRELATED_PROMPT_DECODING_CONFIRMED' and after['verdict']=='PASS'
prior=before['observations']['observations']; current=after['observations']['observations']
assert len(prior)==len(current)==4
for left,right in zip(prior,current):
 assert left['label']==right['label'] and left['output']==right['output']
 assert right['skills']==right['reports']==0
files=[]
for row in (lane/'candidate-files.sha256').read_text().splitlines():
 expected,name=row.split(None,1)
 actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
 assert actual==expected,name
 files.append({'path':name,'sha256':actual})
assert len(files)==2
result={'verdict':'PASS','prior_run':34045851221,'exact_public_outputs_unchanged':True,'candidate_file_hashes':files,'baseline_measurements':before['measurements'],'candidate_measurements':after['measurements'],'measurement_note':'Observed in separate hosted processes/runs; no timing or RSS threshold.'}
(evidence/'completion.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
