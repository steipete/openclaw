#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
[[ "$4" == red ]]
[[ "${PROOF_MODE:-}" == red ]]
[[ "${PROOF_LANE:-}" == macos-cli-selection-red ]]
cd "$proof_target"
mkdir -p "$proof_evidence"
python3 - "$proof_lane" "$proof_evidence" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2]); packet=json.loads((lane/'PACKET.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==packet['base']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
assert subprocess.check_output(['uname','-s'],text=True).strip()=='Darwin'
assert subprocess.check_output(['uname','-m'],text=True).strip()=='arm64'
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+packet['node']
package=json.loads(pathlib.Path('package.json').read_text()); assert package['packageManager']==packet['packageManager']
for name,expected in packet['artifacts'].items(): assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['sourceFiles'].items(): assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
(evidence/'selection-source.json').write_text(json.dumps(packet,indent=2)+'\n')
VERIFY
git apply --check "$proof_lane/regression.patch"
git apply "$proof_lane/regression.patch"
swift --version > "$proof_evidence/swift-version.txt"
xcodebuild -version > "$proof_evidence/xcode-version.txt"
cp "$proof_lane/CLIInstallerSelectionProofTests.swift" "$proof_evidence/executed-test.swift"
swift build --package-path apps/macos --build-system native --enable-code-coverage --build-tests > "$proof_evidence/build.log" 2>&1
set +e
node scripts/test-macos-native.mts default --package-path apps/macos --build-system native --enable-code-coverage --skip-build --disable-xctest --enable-swift-testing --filter CLIInstallerSelectionProofTests --event-stream-version 0 --event-stream-output-path "$proof_evidence/events.jsonl" > "$proof_evidence/native.log" 2>&1
proof_native_exit=$?
set -e
printf '%s\n' "$proof_native_exit" > "$proof_evidence/native-exit.txt"
python3 "$proof_lane/validate.py" "$proof_evidence" "$proof_native_exit"
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,subprocess,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text());evidence=pathlib.Path(sys.argv[2]); hashes={}
assert not subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).strip()
for name,expected in packet['sourceFiles'].items():
 actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest();assert actual==expected,name;hashes[name]=actual
assert hashlib.sha256(pathlib.Path(packet['testPath']).read_bytes()).hexdigest()==packet['testSha256']
(evidence/'final-source-bindings.json').write_text(json.dumps({'base':packet['base'],'sourceFiles':hashes,'testSha256':packet['testSha256']},indent=2)+'\n')
FINAL
