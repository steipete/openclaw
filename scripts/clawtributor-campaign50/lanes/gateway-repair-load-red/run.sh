#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
[[ "$4" == red ]]
[[ "${PROOF_MODE:-}" == red ]]
[[ "${PROOF_LANE:-}" == gateway-repair-load-red ]]
cd "$proof_target"
mkdir -p "$proof_evidence"
python3 - "$proof_lane" "$proof_evidence" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]);evidence=pathlib.Path(sys.argv[2]);packet=json.loads((lane/'PACKET.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==packet['base']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
assert subprocess.check_output(['uname','-s'],text=True).strip()=='Linux'
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+packet['node']
assert json.loads(pathlib.Path('package.json').read_text())['packageManager']==packet['packageManager']
for name,expected in packet['artifacts'].items(): assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['sourceFiles'].items(): assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
(evidence/'repair-source.json').write_text(json.dumps(packet,indent=2)+'\n')
VERIFY
pnpm build:ci-artifacts > "$proof_evidence/build.log" 2>&1
node openclaw.mjs --version > "$proof_evidence/built-version.txt" 2>&1
set +e
node --import "$proof_target/scripts/tsx.mjs" "$proof_lane/proof.mjs" "$proof_target" "$proof_evidence" > "$proof_evidence/driver.log" 2>&1
proof_driver_exit=$?
set -e
printf '%s\n' "$proof_driver_exit" > "$proof_evidence/driver-exit.txt"
python3 "$proof_lane/validate.py" "$proof_evidence" "$proof_driver_exit"
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,subprocess,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text());evidence=pathlib.Path(sys.argv[2]);hashes={}
assert not subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).strip()
for name,expected in packet['sourceFiles'].items():
 actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest();assert actual==expected,name;hashes[name]=actual
(evidence/'final-source-bindings.json').write_text(json.dumps({'base':packet['base'],'sourceFiles':hashes},indent=2)+'\n')
FINAL
