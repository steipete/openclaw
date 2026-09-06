#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
case "$4" in compare) ;; *) exit 2 ;; esac
mkdir -p "$proof_evidence/baseline" "$proof_evidence/candidate"
cd "$proof_target"
python3 - "$proof_lane" "$proof_evidence" <<'PY_SETUP'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2])
base='fae213cdba6ca364c2fd5f44a6eb3a6540b06048'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==base
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],text=True).strip()
assert subprocess.check_output(['node','--version'],text=True).strip()=='v24.20.0'
package=json.loads(pathlib.Path('package.json').read_text())
assert package['packageManager'].split('+',1)[0]=='pnpm@12.1.0'
assert package['devDependencies']['vitest']=='4.1.11'
for name,expected in {
 'candidate.patch':'453189bed9fed6ae6e062b6147419ba3cac3a9d3ddb6ddae300f7eea1e76c5d8',
 'tests.patch':'a3e258d55a7eaf43aca8443ec0fea1dcde149f5314f24084fd8bf220608c105a',
}.items():
 assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
(evidence/'question-source.json').write_text(json.dumps({'base':base,'node':'24.20.0','pnpm':'12.1.0','vitest':'4.1.11','candidatePatch':'453189bed9fed6ae6e062b6147419ba3cac3a9d3ddb6ddae300f7eea1e76c5d8'},indent=2)+'\n')
PY_SETUP
validate_report() {
  python3 - "$1" "$2" "$3" "$4" <<'PY_REPORT'
import json,pathlib,re,sys
report=pathlib.Path(sys.argv[1]); code=int(sys.argv[2]); mode=sys.argv[3]; source=sys.argv[4]
data=json.loads(report.read_text()); log=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',report.with_suffix('.log').read_text())
assert all(re.search(r'(?m)^\s*'+label+r'\s',log) for label in ['Test Files','Tests','Start at','Duration']), 'Completed verbose run summary missing'
assert not re.search(r'Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites',log), 'Runtime/suite failure is not behavior proof'
assert all(not suite.get('message') for suite in data['testResults']), 'Suite load/runtime error'
checks=[a for suite in data['testResults'] for a in suite['assertionResults']]
assert checks and all(a['status'] in ('passed','failed') for a in checks), 'No skipped or missing proof assertions'
assert all(suite['name'].replace('\\','/').endswith(source) for suite in data['testResults'])
if mode=='baseline':
 assert code==1 and data['numFailedTests']==2 and data['numPassedTests']==0 and len(checks)==2
 expected={
  'remains actionable without question buttons (isOther=false)':'Reply with the number or option text.',
  'remains actionable without question buttons (isOther=true)':'Reply with the number, the option text, or your own answer.',
 }
 assert {a['title'] for a in checks}==set(expected)
 headers=list(re.finditer(r'^ *FAIL [^\n]*$',log,re.M))
 for assertion in checks:
  assert len(assertion.get('failureMessages',[]))==1, 'Extra test or hook failure alongside the card mismatch'
  message='\n'.join(assertion['failureMessages'])
  assert 'AssertionError' in message and 'ask-user-msteams-presentation.test.ts:41:' in message, 'Failure did not reach the actual card expectation'
  title=' > '.join([*assertion['ancestorTitles'],assertion['title']])
  blocks=[log[h.end():headers[i+1].start() if i+1<len(headers) else len(log)] for i,h in enumerate(headers) if source in h[0] and h[0].rstrip().endswith(' > '+title)]
  assert len(blocks)==1, 'Expected one named renderer failure block'
  block=blocks[0]
  assert 'presentationCard' in block and 'AssertionError' in block
  assert re.search(r'^-.*'+re.escape(expected[assertion['title']]),block,re.M), 'Typed guidance absent from expected card diff'
  assert re.search(r'^\+.*Tap an option',block,re.M), 'Original tap instruction absent from received card diff'
 verdict='EXPECTED_CARD_FAILURE_CONFIRMED'
else:
 assert mode=='candidate' and code==0 and data['success'] is True
 assert data['numFailedTests']==0 and data['numPassedTests']==len(checks)
 assert all(a['status']=='passed' for a in checks)
 if source=='test/contracts/ask-user-msteams-presentation.test.ts':
  assert len(checks)==2 and {a['title'] for a in checks}=={
   'remains actionable without question buttons (isOther=false)',
   'remains actionable without question buttons (isOther=true)',
  }
 if source=='src/agents/embedded-agent-subscribe.handlers.tools.test.ts':
  assert sum(a['title']=='delivers a numbered ask_user prompt with question id association' for a in checks)==1
 verdict='PASS'
result={'file':source,'mode':mode,'verdict':verdict,'passed':data['numPassedTests'],'failed':data['numFailedTests']}
report.with_suffix('.verdict.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY_REPORT
}
run_file() {
  local proof_phase=$1
  local proof_file=$2
  local proof_key=${proof_file//\//_}
  set +e
  node scripts/run-vitest.mjs "$proof_file" --reporter=verbose --reporter=json --outputFile="$proof_evidence/$proof_phase/$proof_key.json" >"$proof_evidence/$proof_phase/$proof_key.log" 2>&1
  proof_exit=$?
  set -e
  validate_report "$proof_evidence/$proof_phase/$proof_key.json" "$proof_exit" "$proof_phase" "$proof_file"
}
git apply "$proof_lane/tests.patch"
run_file baseline test/contracts/ask-user-msteams-presentation.test.ts
git apply --reverse "$proof_lane/tests.patch"
git apply "$proof_lane/candidate.patch"
proof_files=(
  test/contracts/ask-user-msteams-presentation.test.ts
  test/extension-test-boundary.test.ts
  src/agents/embedded-agent-subscribe.handlers.tools.test.ts
  extensions/msteams/src/welcome-card.test.ts
)
for proof_file in "${proof_files[@]}"; do
  run_file candidate "$proof_file"
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
assert len(reports)==4 and all(r['verdict']=='PASS' for r in reports)
(evidence/'verdict.json').write_text(json.dumps({'verdict':'PASS','kind':'shared-question-producer-real-Teams-renderer','baseline':'two actual-card assertion failures','candidate':reports,'liveService':False,'retainedTelegramProof':'separate contributor-provided evidence'},indent=2)+'\n')
PY_FINAL
