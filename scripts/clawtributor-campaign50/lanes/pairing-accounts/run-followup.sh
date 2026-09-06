#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
proof_mode=$4
case "$proof_mode" in baseline-zalo|green-remaining) ;; *) exit 2 ;; esac
mkdir -p "$proof_evidence"
cd "$proof_target"
assert_no_unhandled_errors() {
  python3 - "$1" <<'PY_ERRORS'
import pathlib,re,sys
text=pathlib.Path(sys.argv[1]).read_text()
text=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
assert 'Test Files' in text, 'Verbose reporter did not complete its run summary'
assert not re.search(r'Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError', text), 'Vitest reported unhandled errors'
PY_ERRORS
}
cp "$proof_lane/followup-lineage.json" "$proof_evidence/prior-evidence.json"
proof_files=(extensions/zalo/src/channel.pairing.test.ts)
if [ "$proof_mode" = baseline-zalo ]; then
  git apply "$proof_lane/tests-zalo.patch"
  for proof_file in "${proof_files[@]}"; do
    proof_key=${proof_file//\//_}
    set +e
    node scripts/run-vitest.mjs "$proof_file" -t 'pairing.notifyApproval' --reporter=verbose --reporter=json --outputFile="$proof_evidence/$proof_key.json" >"$proof_evidence/$proof_key.log" 2>&1
    proof_exit=$?
    set -e
    assert_no_unhandled_errors "$proof_evidence/$proof_key.log"
    python3 - "$proof_evidence/$proof_key.json" "$proof_exit" "$proof_file" <<'PY'
import json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]); code=int(sys.argv[2]); result=json.loads(p.read_text())
assert code==1, 'Expected an ordinary assertion-failure exit'
assert all(not f.get('message') for f in result['testResults']), 'Unexpected suite runtime error'
checks=[a for f in result['testResults'] for a in f['assertionResults'] if a['status'] in ('passed','failed')]
assert len(checks)==4 and sum(a['status']=='failed' for a in checks)==3 and sum(a['status']=='passed' for a in checks)==1, 'Expected exactly three Zalo failures and one default control'
selected=[a for a in checks if a['fullName'].rstrip("'\"").endswith('the approved account')]
default=[a for a in checks if 'the default account' in a['fullName']]
assert len(selected)==1 and selected[0]['status']=='failed', 'Selected account did not demonstrate original failure'
assert len(default)==1 and default[0]['status']=='passed', 'Default account control did not pass'
expected=('token-beta','token-alpha')
message='\n'.join(selected[0].get('failureMessages',[]))
assert 'AssertionError' in message, 'Selected failure was not an assertion'
if not all(value in message for value in expected):
 log=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", p.with_suffix('.log').read_text())
 title=' > '.join([*selected[0]['ancestorTitles'],selected[0]['title']])
 blocks=list(re.finditer(r'^ *FAIL [^\n]*$',log,re.M))
 matches=[log[b.end():blocks[i+1].start() if i+1<len(blocks) else len(log)] for i,b in enumerate(blocks) if sys.argv[3] in b[0] and b[0].rstrip().endswith(' > '+title)]
 assert len(matches)==1, 'Expected one verbose failure block for the selected JSON assertion'
 diff=matches[0]
 assert 'AssertionError' in diff and '- Expected' in diff and '+ Received' in diff
 assert re.search(r'^-.*'+re.escape(expected[0])+r'.*$',diff,re.M), 'Selected expected account missing from its verbose diff'
 assert re.search(r'^\+.*'+re.escape(expected[1])+r'.*$',diff,re.M), 'Selected actual account missing from its verbose diff'
for a in checks:
 if a['status']!='failed' or a is selected[0]: continue
 message='\n'.join(a.get('failureMessages',[]))
 if 'configured proxy' in a['fullName']:
  assert 'http://proxy-beta.test:8080' in message and 'undefined' in message
 elif 'rejects a notification' in a['fullName'] or 'rejects an unsuccessful approval' in a['fullName']:
  assert 'promise resolved' in message and 'instead of rejecting' in message
 else: raise AssertionError(a['fullName'])
print(json.dumps({'file':str(p),'selected':'wrong-account-confirmed','default':'pass','failed':[a['fullName'] for a in checks if a['status']=='failed']}))
PY
  done
  git apply --reverse "$proof_lane/tests-zalo.patch"
else
  proof_files=(
    extensions/signal/src/core.test.ts
    extensions/synology-chat/src/channel.pairing.test.ts
    extensions/synology-chat/src/channel.test.ts
    extensions/zalo/src/channel.pairing.test.ts
  )
  for proof_file in "${proof_files[@]}"; do
    proof_key=${proof_file//\//_}
    node scripts/run-vitest.mjs "$proof_file" --reporter=verbose --reporter=json --outputFile="$proof_evidence/$proof_key.json" >"$proof_evidence/$proof_key.log" 2>&1
    assert_no_unhandled_errors "$proof_evidence/$proof_key.log"
    python3 - "$proof_evidence/$proof_key.json" "$proof_file" <<'PY'
import json,pathlib,sys
result=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert result['numPassedTests']>0 and result['numFailedTests']==0
assert len(result['testResults'])==1 and result['testResults'][0]['name'].endswith('/'+sys.argv[2])
assert all(not f.get('message') for f in result['testResults'])
if sys.argv[2]=='extensions/zalo/src/channel.pairing.test.ts':
 assert result['numPassedTests']==4
print(json.dumps({'file':sys.argv[2],'passed':result['numPassedTests'],'failed':0}))
PY
  done
  node scripts/run-vitest.mjs src/gateway/server-methods/channel-pairing.test.ts -t 'approves access even when the optional notification fails' --reporter=verbose --reporter=json --outputFile="$proof_evidence/gateway-notification-failure.json" >"$proof_evidence/gateway-notification-failure.log" 2>&1
  assert_no_unhandled_errors "$proof_evidence/gateway-notification-failure.log"
  python3 - "$proof_evidence/gateway-notification-failure.json" <<'PY'
import json,pathlib,sys
result=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert result['numPassedTests']==1 and result['numFailedTests']==0
assert all(not f.get('message') for f in result['testResults'])
checks=[a for f in result['testResults'] for a in f['assertionResults'] if a['status'] in ('passed','failed')]
assert len(checks)==1 and checks[0]['status']=='passed'
assert checks[0]['title']=='approves access even when the optional notification fails'
print('Gateway approval-preservation control: exactly one passed')
PY
  python3 - "$proof_lane/candidate-files.sha256" "$proof_evidence" <<'PY'
import hashlib,json,pathlib,sys
files=[]
for row in pathlib.Path(sys.argv[1]).read_text().splitlines():
 expected,name=row.split(None,1)
 actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
 assert actual==expected,name
 files.append({'file':name,'sha256':actual})
assert len(files)==16
pathlib.Path(sys.argv[2],'candidate-files-verified.json').write_text(json.dumps(files,indent=2)+'\n')
print('All16 candidate file hashes verified')
PY
fi
