#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
proof_mode=$4
mkdir -p "$proof_evidence"
cd "$proof_target"
cp "$proof_lane/actions.reactions-http.test.ts" extensions/slack/src/actions.reactions-http.test.ts
set +e
node scripts/run-vitest.mjs extensions/slack/src/actions.reactions-http.test.ts --reporter=verbose >"$proof_evidence/http.log" 2>&1
proof_exit=$?
set -e
python3 - "$proof_evidence" "$proof_mode" "$proof_exit" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; code=int(sys.argv[3]); log=(root/'http.log').read_text()
observations=[]
for line in log.splitlines():
 try:
  obj=json.loads(line)
 except ValueError:
  continue
 if obj.get('proof')=='slack-reaction-name-observed': observations.append(obj)
assert len(observations)==1, 'Expected one complete reaction HTTP capture, not a generic test failure'
obj=observations[0]; actual=obj['requests']; expected=obj['expectedRequests']
assert len(actual)==len(expected)==10, 'Incomplete add/remove matrix'
if mode=='baseline':
 assert code!=0 and 'SLACK_REACTION_NAME_MISMATCH' in log
 for i,(a,e) in enumerate(zip(actual,expected)):
  assert a['method']==e['method']
  if i in (0,5): assert a['name'] is None, 'Original custom name failure not observed'
  else: assert a==e, 'Ordinary custom/glyph/skin-tone control changed'
 verdict='EXPECTED_FAILURE_CONFIRMED'
else:
 assert code==0 and actual==expected, 'Candidate HTTP name preservation did not pass'
 verdict='PASS'
result={'proof':'slack-reaction-name-http','mode':mode,'verdict':verdict,'kind':'production-add-remove-real-sdk-loopback-http','observations':obj}
(root/'verdict.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY

if [ "$proof_mode" != baseline ]; then
  node scripts/run-vitest.mjs extensions/slack/src/actions.reactions.test.ts extensions/slack/src/actions.reactions-limit.test.ts --reporter=verbose >"$proof_evidence/focused.log" 2>&1
fi
