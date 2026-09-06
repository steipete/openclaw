#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
[[ "$4" == green ]]
cd "$proof_target"
mkdir -p "$proof_evidence"
python3 - "$proof_lane" "$proof_evidence" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2]); packet=json.loads((lane/'PACKET.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==packet['base']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
assert subprocess.check_output(['node','--version'],text=True).strip()=='v24.20.0'
package=json.loads(pathlib.Path('package.json').read_text())
assert package['packageManager'].split('+',1)[0]=='pnpm@12.3.4'
assert package['devDependencies']['vitest']=='5.0.0'
for name,expected in packet['artifacts'].items():
 assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['baselineFiles'].items():
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
(evidence/'silent-reply-candidate-source.json').write_text(json.dumps(packet,indent=2)+'\n')
VERIFY
git apply --check "$proof_lane/candidate.patch"
git apply "$proof_lane/candidate.patch"
[[ ! -e src/agents/embedded-agent-runner/run.silent-reply-prompt-mode.test.ts ]]
proof_file=test/e2e/qa-lab/runtime/silent-reply-prompt-mode.e2e.test.ts
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
python3 "$proof_lane/verify-green.py" "$proof_evidence/flow.json" "$proof_evidence/flow.log" "$flow_exit" "$proof_file"
proof_siblings=(
  src/agents/system-prompt.test.ts
  src/agents/cli-runner/helpers.system-prompt.test.ts
  src/agents/tool-terminal-outcome.test.ts
  src/agents/tool-error-state.test.ts
)
for proof_sibling in "${proof_siblings[@]}"; do
  proof_key=$(basename "$proof_sibling" .test.ts)
  set +e
  node scripts/run-vitest.mjs "$proof_sibling" --reporter=verbose --reporter=json \
    --outputFile="$proof_evidence/$proof_key.json" > "$proof_evidence/$proof_key.log" 2>&1
  sibling_exit=$?
  set -e
  python3 "$proof_lane/verify-green.py" "$proof_evidence/$proof_key.json" "$proof_evidence/$proof_key.log" "$sibling_exit" "$proof_sibling"
done
node scripts/check-changed.mjs --base 96bf3652adabc25d86af15a950a72be63575acc5 -- src/agents/embedded-agent-runner/run/run-attempt-dispatch.ts "$proof_file" > "$proof_evidence/changed.log" 2>&1
git diff --check
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text()); evidence=pathlib.Path(sys.argv[2])
for name,expected in packet['candidateFiles'].items():
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['baselineFiles'].items():
 if name not in packet['candidateFiles']:
  assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
observed=json.loads((evidence/'provider/observed.json').read_text())
assert observed['kind']=='qa-channel-direct-ingress-gateway-provider-prompt'
assert observed['channel']=='qa-channel' and observed['liveDiscord'] is False
assert observed['requestKind']=='agent-initial' and observed['providerOutcome']=='success'
assert observed['providerRequests']==1 and observed['visibleReplies']==1
assert observed['reply']=='QA_SILENT_REPLY_PROMPT_OK'
assert observed['hasTooling'] is True and observed['hasSafety'] is True
assert observed['hasGenericSilentReplies'] is False
reports=[json.loads(p.read_text()) for p in evidence.glob('*.verdict.json')]
assert len(reports)==5 and all(r['verdict']=='PASS' for r in reports)
(evidence/'verdict.json').write_text(json.dumps({'verdict':'PASS','base':packet['base'],'kind':'real-qa-direct-ingress-provider-prompt','sourceDelta':0,'flow':observed,'reports':reports},indent=2)+'\n')
print('SILENT_REPLY_CANDIDATE_GREEN_CONFIRMED')
FINAL
