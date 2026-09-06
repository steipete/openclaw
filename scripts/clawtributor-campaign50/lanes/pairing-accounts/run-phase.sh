#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
proof_mode=$4
case "$proof_mode" in baseline|green) ;; *) exit 2 ;; esac
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
cp "$proof_lane/pairing-approved-account.http.test.ts" src/channels/plugins/pairing-approved-account.http.test.ts
set +e
node scripts/run-vitest.mjs src/channels/plugins/pairing-approved-account.http.test.ts --reporter=verbose >"$proof_evidence/http.log" 2>&1
proof_exit=$?
set -e
assert_no_unhandled_errors "$proof_evidence/http.log"
python3 - "$proof_evidence" "$proof_mode" "$proof_exit" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; code=int(sys.argv[3]); log=(root/'http.log').read_text()
rows=[]
for line in log.splitlines():
 try: row=json.loads(line)
 except ValueError: continue
 if row.get('proof')=='pairing-account-http-observed': rows.append(row)
assert len(rows)==1, 'Expected one complete real notifier HTTP capture, not a generic failure'
row=rows[0]
assert len(row['requests'])==3
for request in row['requests']:
 assert request['payload']=={'text':'OpenClaw: your access has been approved.','user_ids':[42]}
if mode=='baseline':
 assert code==1 and 'PAIRING_ACCOUNT_HTTP_MISMATCH' in log
 assert row['outcomes']==[
  {'label':'selected','outcome':'returned','path':'/default'},
  {'label':'default','outcome':'returned','path':'/default'},
  {'label':'rejected','outcome':'returned','path':'/default'},
  {'label':'missing','outcome':'returned','path':None}]
 verdict='EXPECTED_FAILURE_CONFIRMED'
else:
 assert code==0
 assert row['outcomes']==[
  {'label':'selected','outcome':'returned','path':'/beta'},
  {'label':'default','outcome':'returned','path':'/default'},
  {'label':'rejected','outcome':'threw','path':'/beta'},
  {'label':'missing','outcome':'threw','path':None}]
 verdict='PASS'
result={'proof':'approved-account-notifier-http','kind':'synthetic-core-notifier-real-plugin-loopback-http','mode':mode,'verdict':verdict,'observations':row}
(root/'verdict.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
proof_files=(
  extensions/imessage/src/channel.runtime.test.ts
  extensions/irc/src/channel.test.ts
  extensions/line/src/channel.sendPayload.test.ts
  extensions/signal/src/core.test.ts
  extensions/synology-chat/src/channel.pairing.test.ts
  extensions/zalo/src/channel.pairing.test.ts
  extensions/zalouser/src/channel.test.ts
)
if [ "$proof_mode" = baseline ]; then
  git apply "$proof_lane/tests.patch"
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
assert checks, 'No pairing assertions executed'
selected=[a for a in checks if a['fullName'].rstrip("'\"").endswith('the approved account')]
default=[a for a in checks if 'the default account' in a['fullName']]
assert len(selected)==1 and selected[0]['status']=='failed', 'Selected account did not demonstrate original failure'
assert len(default)==1 and default[0]['status']=='passed', 'Default account control did not pass'
expected={
 'imessage':('/gateway/beta-imsg','/gateway/alpha-imsg'),
 'irc':('irc.beta.test','irc.alpha.test'),
 'line':('token-beta','token-alpha'),
 'signal':('+15550000002','+15550000001'),
 'synology-chat':('https://nas-beta/incoming','https://nas-default/incoming'),
 'zalo':('token-beta','token-alpha'),
 'zalouser':('beta-profile','alpha-profile'),
}
channel=p.name.split('_')[1]
message='\n'.join(selected[0].get('failureMessages',[]))
assert 'AssertionError' in message, 'Selected failure was not an assertion'
if not all(value in message for value in expected[channel]):
 log=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", p.with_suffix('.log').read_text())
 title=' > '.join([*selected[0]['ancestorTitles'],selected[0]['title']])
 blocks=list(re.finditer(r'^ *FAIL [^\n]*$',log,re.M))
 matches=[log[b.end():blocks[i+1].start() if i+1<len(blocks) else len(log)] for i,b in enumerate(blocks) if sys.argv[3] in b[0] and b[0].rstrip().endswith(' > '+title)]
 assert len(matches)==1, 'Expected one verbose failure block for the selected JSON assertion'
 diff=matches[0]
 assert 'AssertionError' in diff and '- Expected' in diff and '+ Received' in diff
 assert re.search(r'^-.*'+re.escape(expected[channel][0])+r'.*$',diff,re.M), 'Selected expected account missing from its verbose diff'
 assert re.search(r'^\+.*'+re.escape(expected[channel][1])+r'.*$',diff,re.M), 'Selected actual account missing from its verbose diff'
for a in checks:
 if a['status']!='failed' or a is selected[0]: continue
 message='\n'.join(a.get('failureMessages',[]))
 if 'configured proxy' in a['fullName']:
  assert channel=='zalo' and 'http://proxy-beta.test:8080' in message and 'undefined' in message
 elif 'rejects a notification' in a['fullName'] or 'rejects an unsuccessful approval' in a['fullName']:
  assert channel in ('synology-chat','zalo') and 'promise resolved' in message and 'instead of rejecting' in message
 else: raise AssertionError(a['fullName'])
print(json.dumps({'file':str(p),'selected':'wrong-account-confirmed','default':'pass','failed':[a['fullName'] for a in checks if a['status']=='failed']}))
PY
  done
  git apply --reverse "$proof_lane/tests.patch"
else
  node scripts/run-vitest.mjs "${proof_files[@]}" extensions/synology-chat/src/channel.test.ts --reporter=verbose >"$proof_evidence/focused.log" 2>&1
  assert_no_unhandled_errors "$proof_evidence/focused.log"
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
fi
