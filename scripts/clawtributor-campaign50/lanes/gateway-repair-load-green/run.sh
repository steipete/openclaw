#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
[[ "$4" == green ]]
[[ "${PROOF_MODE:-}" == green ]]
[[ "${PROOF_LANE:-}" == gateway-repair-load-green ]]
cd "$proof_target"
mkdir -p "$proof_evidence"
python3 - "$proof_lane" "$proof_evidence" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]);evidence=pathlib.Path(sys.argv[2]);packet=json.loads((lane/'PACKET.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==packet['base']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
assert subprocess.check_output(['uname','-s'],text=True).strip()=='Linux'
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+packet['node']
manifest=json.loads(pathlib.Path('package.json').read_text())
assert manifest['packageManager']==packet['packageManager'] and manifest['devDependencies']['vitest']=='5.0.0'
for name,expected in packet['artifacts'].items(): assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['sourceFiles'].items(): assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
(evidence/'repair-source.json').write_text(json.dumps(packet,indent=2)+'\n')
(evidence/'candidate.patch').write_bytes((lane/'candidate.patch').read_bytes())
VERIFY
git apply --check "$proof_lane/regression.patch"
git apply "$proof_lane/regression.patch"
set +e
node scripts/run-vitest.mjs src/cli/daemon-cli/start-repair.test.ts --reporter=default --reporter=json --outputFile.json="$proof_evidence/unit-red.json" > "$proof_evidence/unit-red.log" 2>&1
proof_unit_red_exit=$?
set -e
printf '%s\n' "$proof_unit_red_exit" > "$proof_evidence/unit-red-exit.txt"
node "$proof_lane/validate-tests.mjs" "$proof_evidence/unit-red.json" "$proof_evidence/unit-red.log" red "$proof_unit_red_exit"
git apply --check "$proof_lane/production.patch"
git apply "$proof_lane/production.patch"
python3 - "$proof_lane/PACKET.json" <<'CANDIDATE'
import hashlib,json,pathlib,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text())
for name,expected in packet['candidateFiles'].items(): assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
CANDIDATE
pnpm build:ci-artifacts > "$proof_evidence/build.log" 2>&1
node openclaw.mjs --version > "$proof_evidence/built-version.txt" 2>&1
set +e
node --import "$proof_target/scripts/tsx.mjs" "$proof_lane/proof.mjs" "$proof_target" "$proof_evidence" > "$proof_evidence/driver.log" 2>&1
proof_driver_exit=$?
set -e
printf '%s\n' "$proof_driver_exit" > "$proof_evidence/driver-exit.txt"
python3 "$proof_lane/validate.py" "$proof_evidence" "$proof_driver_exit"
set +e
node scripts/run-vitest.mjs src/cli/daemon-cli/start-repair.test.ts src/cli/daemon-cli/lifecycle-core.test.ts src/cli/daemon-cli/lifecycle-start-readiness.test.ts src/cli/daemon-cli/response.test.ts src/cli/daemon-cli/restart-health.test.ts --reporter=default --reporter=json --outputFile.json="$proof_evidence/unit-green.json" > "$proof_evidence/unit-green.log" 2>&1
proof_unit_green_exit=$?
set -e
printf '%s\n' "$proof_unit_green_exit" > "$proof_evidence/unit-green-exit.txt"
node "$proof_lane/validate-tests.mjs" "$proof_evidence/unit-green.json" "$proof_evidence/unit-green.log" green "$proof_unit_green_exit"
node scripts/check-changed.mjs --base 1d694c876d2b74efeee0f1aed2ca22d9bb28ef3f -- src/cli/daemon-cli/start-repair.ts src/cli/daemon-cli/start-repair.test.ts > "$proof_evidence/check-changed.log" 2>&1
git diff --check
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,subprocess,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text());evidence=pathlib.Path(sys.argv[2]);hashes={}
assert set(subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines())==set(packet['candidateFiles'])
for name,expected in (packet['sourceFiles']|packet['candidateFiles']).items():
 actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest();assert actual==expected,name;hashes[name]=actual
(evidence/'final-source-bindings.json').write_text(json.dumps({'base':packet['base'],'sourceFiles':hashes},indent=2)+'\n')
(evidence/'final-tracked.patch').write_bytes(subprocess.check_output(['git','diff','HEAD']))
FINAL
