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
assert package['devDependencies']['oxfmt']=='0.65.0'
for name,expected in packet['artifacts'].items():
 assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
(evidence/'silent-reply-lint-source.json').write_text(json.dumps(packet,indent=2)+'\n')
VERIFY
git apply --check "$proof_lane/candidate.patch"
git apply "$proof_lane/candidate.patch"
proof_file=test/e2e/qa-lab/runtime/silent-reply-prompt-mode.e2e.test.ts
node_modules/.bin/oxfmt --check "$proof_file" > "$proof_evidence/format.log" 2>&1
node scripts/run-oxlint.mjs --tsconfig test/tsconfig/tsconfig.test.root.json "$proof_file" > "$proof_evidence/lint.log" 2>&1
git diff --check
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text()); evidence=pathlib.Path(sys.argv[2]); hashes={}
for name,expected in packet['candidateFiles'].items():
 actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
 assert actual==expected,name
 hashes[name]=actual
(evidence/'verdict.json').write_text(json.dumps({'verdict':'STATIC_CORRECTION_VERIFIED','base':packet['base'],'candidateFiles':hashes,'retainedBehaviorProofRun':34045851221,'scope':'targeted final test format and root-test lint only; prior real flow and175siblings retained with unchanged production'},indent=2)+'\n')
print('SILENT_REPLY_STATIC_CORRECTION_VERIFIED')
FINAL
