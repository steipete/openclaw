#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
proof_mode=$4
case "$proof_mode" in baseline|green) ;; *) exit 2 ;; esac
mkdir -p "$proof_evidence"
cd "$proof_target"
proof_file=extensions/imessage/src/channel.runtime.test.ts
if [ "$proof_mode" = baseline ]; then
  git apply "$proof_lane/tests.patch"
  proof_filter=(-t 'pairing.notifyApproval')
else
  proof_filter=()
fi
set +e
node scripts/run-vitest.mjs "$proof_file" "${proof_filter[@]}" --reporter=verbose --reporter=json --outputFile="$proof_evidence/tests.json" >"$proof_evidence/tests.log" 2>&1
proof_exit=$?
set -e
python3 - "$proof_evidence" "$proof_mode" "$proof_exit" <<'PY'
import json,pathlib,re,sys
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; code=int(sys.argv[3])
result=json.loads((root/'tests.json').read_text())
log=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',(root/'tests.log').read_text())
assert all(re.search(r'(?m)^\s*'+label+r'\s',log) for label in ['Test Files','Tests','Start at','Duration'])
assert not re.search(r'Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites\s+\d+',log)
assert len(result['testResults'])==1
file=result['testResults'][0]
assert file['name'].endswith('/extensions/imessage/src/channel.runtime.test.ts')
assert not file.get('message')
checks=[a for a in file['assertionResults'] if a['status'] in ('passed','failed')]
pairing=[a for a in checks if 'pairing.notifyApproval' in a['fullName']]
assert len(pairing)==2
assert sum('the approved account' in a['title'] for a in pairing)==1
assert sum('the default account' in a['title'] for a in pairing)==1
if mode=='baseline':
 assert code==1 and result['numFailedTests']==2 and result['numPassedTests']==0 and len(checks)==2
 expected='✅ OpenClaw access approved. Send a message to start chatting.'
 actual='OpenClaw: your access has been approved.'
 blocks=list(re.finditer(r'(?:^ *FAIL [^\n]*\n)+',log,re.M))
 for a in pairing:
  assert a['status']=='failed'
  assert len(a.get('failureMessages',[]))==1
  message=a['failureMessages'][0]
  assert 'AssertionError' in message
  title=' > '.join([*a['ancestorTitles'],a['title']])
  matches=[log[b.end():blocks[i+1].start() if i+1<len(blocks) else len(log)] for i,b in enumerate(blocks) if any('extensions/imessage/src/channel.runtime.test.ts' in header and header.rstrip().endswith(' > '+title) for header in b[0].splitlines())]
  assert len(matches)==1
  diff=matches[0]
  assert re.search(r'^-.*'+re.escape(expected)+r'.*$',diff,re.M),a['title']
  assert re.search(r'^\+.*'+re.escape(actual)+r'.*$',diff,re.M),a['title']
 verdict='EXPECTED_IMESSAGE_TEXT_FAILURES_CONFIRMED'
else:
 assert code==0 and result['numFailedTests']==0 and result['numPassedTests']==15
 assert all(a['status']=='passed' for a in pairing)
 verdict='PASS'
report={'proof':'imessage-approval-text-preservation','mode':mode,'verdict':verdict,'passed':result['numPassedTests'],'failed':result['numFailedTests'],'pairing':[{'title':a['title'],'status':a['status']} for a in pairing]}
(root/'verdict.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
PY
if [ "$proof_mode" = baseline ]; then
  git apply --reverse "$proof_lane/tests.patch"
else
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
