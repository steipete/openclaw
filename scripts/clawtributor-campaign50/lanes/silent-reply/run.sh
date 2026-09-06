#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
[[ "$4" == red ]]
cd "$proof_target"
mkdir -p "$proof_evidence"
python3 - "$proof_lane" "$proof_evidence" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2])
packet=json.loads((lane/'PACKET.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==packet['base']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
assert subprocess.check_output(['node','--version'],text=True).strip()=='v24.20.0'
package=json.loads(pathlib.Path('package.json').read_text())
assert package['packageManager'].split('+',1)[0]=='pnpm@12.3.4'
assert package['devDependencies']['vitest']=='4.1.11'
for name,expected in packet['artifacts'].items():
 assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['baselineFiles'].items():
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
(evidence/'silent-reply-source.json').write_text(json.dumps(packet,indent=2)+'\n')
VERIFY
git apply --check "$proof_lane/regression-tests.patch"
git apply "$proof_lane/regression-tests.patch"
proof_file=test/e2e/qa-lab/runtime/silent-reply-prompt-mode.e2e.test.ts
[[ ! -e "$proof_file" ]]
cp "$proof_lane/silent-reply-prompt-mode.e2e.test.ts" "$proof_file"
set +e
node scripts/run-vitest.mjs src/agents/embedded-agent-runner/run.silent-reply-prompt-mode.test.ts \
  --reporter=verbose --reporter=json --outputFile="$proof_evidence/runner.json" \
  > "$proof_evidence/runner.log" 2>&1
runner_exit=$?
set -e
python3 "$proof_lane/verify-red.py" "$proof_evidence/runner.json" "$proof_evidence/runner.log" "$runner_exit" runner
[[ "${OPENCLAW_E2E_SKIP_BUILD:-}" != 1 ]]
[[ "${OPENCLAW_E2E_USE_PREBUILT_DIST:-}" != 1 ]]
set +e
node scripts/run-vitest.mjs --config test/vitest/vitest.e2e.config.ts "$proof_file" \
  --reporter=verbose --reporter=json --outputFile="$proof_evidence/flow.json" \
  > "$proof_evidence/flow.log" 2>&1
flow_exit=$?
set -e
if [[ -d .artifacts/silent-reply-prompt-mode ]]; then
  cp -R .artifacts/silent-reply-prompt-mode "$proof_evidence/provider"
fi
python3 "$proof_lane/verify-red.py" "$proof_evidence/flow.json" "$proof_evidence/flow.log" "$flow_exit" flow
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text()); evidence=pathlib.Path(sys.argv[2])
for name,expected in packet['baselineFiles'].items():
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
observed=json.loads((evidence/'provider/observed.json').read_text())
assert observed['kind']=='qa-channel-direct-ingress-gateway-provider-prompt'
assert observed['channel']=='qa-channel' and observed['liveDiscord'] is False
assert observed['requestKind']=='agent-initial' and observed['providerOutcome']=='success'
assert observed['providerRequests']==1 and observed['visibleReplies']==1
assert observed['reply']=='QA_SILENT_REPLY_PROMPT_OK'
assert observed['hasTooling'] is True and observed['hasSafety'] is True
assert observed['hasGenericSilentReplies'] is True
(evidence/'verdict.json').write_text(json.dumps({'verdict':'EXPECTED_RED_CONFIRMED','base':packet['base'],'flow':observed},indent=2)+'\n')
print('SILENT_REPLY_BASELINE_RED_CONFIRMED')
FINAL
