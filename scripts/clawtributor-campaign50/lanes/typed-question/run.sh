#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
case "$4" in green) ;; *) exit 2 ;; esac
mkdir -p "$proof_evidence/candidate"
cd "$proof_target"
python3 - "$proof_lane" "$proof_evidence" <<'PY_SETUP'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2])
base='0ebb320906da7e1727934b3cf816cedf98270357'
patch='e63584e0ce8ea0df7a75c77c647a48bef6e8679f6143d83f54a105a0995dc494'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==base
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],text=True).strip()
assert subprocess.check_output(['node','--version'],text=True).strip()=='v24.20.0'
package=json.loads(pathlib.Path('package.json').read_text())
assert package['packageManager'].split('+',1)[0]=='pnpm@12.3.4'
assert package['devDependencies']['vitest']=='5.0.0'
assert hashlib.sha256((lane/'candidate.patch').read_bytes()).hexdigest()==patch
assert hashlib.sha256((lane/'candidate-files.sha256').read_bytes()).hexdigest()=='016d3dcb4d0424a336e1913b4d55e96a2cb09a1e87eb076b62b7834024f970ae'
(evidence/'question-source.json').write_text(json.dumps({'base':base,'node':'24.20.0','pnpm':'12.3.4','vitest':'5.0.0','candidatePatch':patch,'historicalProofRun':34026143939,'mode':'green-only'},indent=2)+'\n')
PY_SETUP
git apply "$proof_lane/candidate.patch"
proof_files=(
  test/contracts/ask-user-msteams-presentation.test.ts
  test/extension-test-boundary.test.ts
  src/agents/embedded-agent-subscribe.handlers.tools.test.ts
  extensions/msteams/src/welcome-card.test.ts
  src/infra/question-channel-runtime.generation.test.ts
)
for proof_file in "${proof_files[@]}"; do
  proof_key=${proof_file//\//_}
  set +e
  node scripts/run-vitest.mjs "$proof_file" --reporter=verbose --reporter=json --outputFile="$proof_evidence/candidate/$proof_key.json" >"$proof_evidence/candidate/$proof_key.log" 2>&1
  proof_exit=$?
  set -e
  python3 - "$proof_evidence/candidate/$proof_key.json" "$proof_exit" "$proof_file" <<'PY_REPORT'
import json,pathlib,re,sys
report=pathlib.Path(sys.argv[1]); code=int(sys.argv[2]); source=sys.argv[3]
data=json.loads(report.read_text()); log=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',report.with_suffix('.log').read_text())
assert all(marker in log for marker in ('Test Files','Tests','Start at','Duration')), 'Incomplete verbose run summary'
assert not re.search(r'Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites',log), 'Global or suite failure'
assert all(not suite.get('message') for suite in data['testResults']), 'Suite load/runtime error'
checks=[a for suite in data['testResults'] for a in suite['assertionResults']]
assert checks and all(a['status']=='passed' and not a.get('failureMessages') for a in checks), 'No failed, skipped, missing or extra-error assertions'
assert code==0 and data['success'] is True and data['numFailedTests']==0
assert data['numPassedTests']==len(checks)==data['numTotalTests']
assert all(suite['name'].replace('\\','/').endswith(source) for suite in data['testResults'])
if source=='test/contracts/ask-user-msteams-presentation.test.ts':
 assert len(checks)==2 and {a['title'] for a in checks}=={
  'remains actionable without question buttons (isOther=false)',
  'remains actionable without question buttons (isOther=true)',
 }
if source=='src/agents/embedded-agent-subscribe.handlers.tools.test.ts':
 assert sum(a['title']=='delivers a numbered ask_user prompt with question id association' for a in checks)==1
if source=='src/infra/question-channel-runtime.generation.test.ts':
 assert len(checks)==2 and {a['title'] for a in checks}=={
  'keeps a queued tool prompt on its expired question after the id is reused',
  'keeps a queued harness prompt on its expired question after the id is reused',
 }
result={'file':source,'verdict':'PASS','passed':len(checks),'failed':0,'skipped':0}
report.with_suffix('.verdict.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY_REPORT
done
python3 - "$proof_lane" "$proof_evidence" <<'PY_FINAL'
import hashlib,json,pathlib,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2]); hashes=[]
for line in (lane/'candidate-files.sha256').read_text().splitlines():
 expected,name=line.split('  ',1); actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
 assert actual==expected,name
 hashes.append({'file':name,'sha256':actual})
assert len(hashes)==3
(evidence/'candidate-files-verified.json').write_text(json.dumps(hashes,indent=2)+'\n')
reports=[json.loads(p.read_text()) for p in (evidence/'candidate').glob('*.verdict.json')]
assert len(reports)==5 and all(r['verdict']=='PASS' for r in reports)
(evidence/'verdict.json').write_text(json.dumps({'verdict':'PASS','kind':'composed-question-renderer-handler-delivery','base':'0ebb320906da7e1727934b3cf816cedf98270357','candidate':reports,'historicalRedAnd209ProofRun':34026143939,'liveService':False,'retainedTelegramProof':'separate historical contributor loopback evidence'},indent=2)+'\n')
PY_FINAL
