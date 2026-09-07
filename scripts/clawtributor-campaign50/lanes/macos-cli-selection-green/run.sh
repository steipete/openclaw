#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
[[ "$4" == green ]]
[[ "${PROOF_MODE:-}" == green ]]
[[ "${PROOF_LANE:-}" == macos-cli-selection-green ]]
cd "$proof_target"
mkdir -p "$proof_evidence/flow" "$proof_evidence/units"
python3 - "$proof_lane" "$proof_evidence" <<'VERIFY'
import hashlib,json,pathlib,subprocess,sys
lane=pathlib.Path(sys.argv[1]);evidence=pathlib.Path(sys.argv[2]);packet=json.loads((lane/'PACKET.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==packet['base']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
assert subprocess.check_output(['uname','-s'],text=True).strip()=='Darwin'
assert subprocess.check_output(['uname','-m'],text=True).strip()=='arm64'
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+packet['node']
assert json.loads(pathlib.Path('package.json').read_text())['packageManager']==packet['packageManager']
for name,expected in packet['artifacts'].items(): assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in packet['sourceFiles'].items(): assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
(evidence/'selection-source.json').write_text(json.dumps(packet,indent=2)+'\n')
(evidence/'candidate.patch').write_bytes((lane/'candidate.patch').read_bytes())
VERIFY
git apply --check --index "$proof_lane/candidate.patch"
git apply --index "$proof_lane/candidate.patch"
git apply --check "$proof_lane/proof-fixture.patch"
git apply "$proof_lane/proof-fixture.patch"
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'CANDIDATE'
import hashlib,json,pathlib,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text());evidence=pathlib.Path(sys.argv[2])
for name,expected in (packet['candidateFiles']|packet['proofFiles']).items():
 data=pathlib.Path(name).read_bytes();assert hashlib.sha256(data).hexdigest()==expected,name
 (evidence/pathlib.Path(name).name).write_bytes(data)
CANDIDATE
swift --version > "$proof_evidence/swift-version.txt"
xcodebuild -version > "$proof_evidence/xcode-version.txt"
bash scripts/install-swift-tools.sh "$proof_evidence/swift-tools" > "$proof_evidence/swift-tools.log" 2>&1
export PATH="$proof_evidence/swift-tools:$PATH"
swift build --package-path apps/macos --build-system native --enable-code-coverage --build-tests > "$proof_evidence/build.log" 2>&1
set +e
node scripts/test-macos-native.mts default --package-path apps/macos --build-system native --enable-code-coverage --skip-build --disable-xctest --enable-swift-testing --filter CLIInstallerSelectionProofTests --event-stream-version 0 --event-stream-output-path "$proof_evidence/flow/events.jsonl" > "$proof_evidence/flow/native.log" 2>&1
proof_flow_exit=$?
set -e
printf '%s\n' "$proof_flow_exit" > "$proof_evidence/flow/exit-code.txt"
python3 "$proof_lane/validate-proof.py" "$proof_evidence/flow" "$proof_flow_exit"
set +e
node scripts/test-macos-native.mts default --package-path apps/macos --build-system native --enable-code-coverage --skip-build --disable-xctest --enable-swift-testing --filter 'CLIInstallerSelectionTests|CLIInstallerTests|CommandResolverTests|AppProfileTests|RuntimeLocatorTests' --event-stream-version 0 --event-stream-output-path "$proof_evidence/units/events.jsonl" > "$proof_evidence/units/native.log" 2>&1
proof_units_exit=$?
set -e
printf '%s\n' "$proof_units_exit" > "$proof_evidence/units/exit-code.txt"
python3 "$proof_lane/validate-units.py" "$proof_evidence/units" "$proof_units_exit"
swiftformat --lint apps/macos/Tests/OpenClawIPCTests/CLIInstallerSelectionTests.swift --config config/swiftformat > "$proof_evidence/unit-format.log" 2>&1
node scripts/check-changed.mjs --base 0ad318398e906aa710af94d61231dfe65946c02d -- apps/macos/Sources/OpenClaw/CLIInstaller.swift apps/macos/Tests/OpenClawIPCTests/CLIInstallerSelectionTests.swift > "$proof_evidence/check-changed.log" 2>&1
git diff --check HEAD
git diff --exit-code
python3 - "$proof_lane/PACKET.json" "$proof_evidence" <<'FINAL'
import hashlib,json,pathlib,subprocess,sys
packet=json.loads(pathlib.Path(sys.argv[1]).read_text());evidence=pathlib.Path(sys.argv[2]);hashes={}
assert set(subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines())==set(packet['candidateFiles'])
assert set(subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines())==set(packet['proofFiles'])
for name,expected in (packet['sourceFiles']|packet['candidateFiles']|packet['proofFiles']).items():
 data=pathlib.Path(name).read_bytes();assert hashlib.sha256(data).hexdigest()==expected,name;hashes[name]=expected
(evidence/'final-source-bindings.json').write_text(json.dumps({'base':packet['base'],'sourceFiles':hashes},indent=2)+'\n')
(evidence/'final-tracked.patch').write_bytes(subprocess.check_output(['git','diff','HEAD']))
FINAL
