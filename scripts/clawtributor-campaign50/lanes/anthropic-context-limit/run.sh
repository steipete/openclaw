#!/usr/bin/env bash
set -euo pipefail
[ "$4" = red ]
proof_target=$(cd "$1" && pwd)
proof_lane=$(cd "$2" && pwd)
mkdir -p "$3"
proof_evidence=$(cd "$3" && pwd)
cd "$proof_target"
[ "$(git rev-parse HEAD)" = a1707cb38032c6d94e3a3c49d0de4e68f62539b9 ]
[ "$(node --version)" = v24.20.0 ]
python3 - "$proof_target" "$proof_lane" "$proof_evidence" <<'PY'
import hashlib,json,pathlib,sys
root,lane,evidence=map(pathlib.Path,sys.argv[1:])
packet=json.loads((lane/'BASELINE-PACKET.json').read_text())
for name,expected in packet['files'].items():
    assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
source=json.loads((lane/'117748-source.json').read_text())
for name,expected in source['sourceHashes'].items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected,name
(evidence/'source-pins.json').write_text(json.dumps(source,indent=2)+'\n')
PY
proof_test=packages/ai/src/providers/anthropic-context-limit.integration.test.ts
[ ! -e "$proof_test" ]
cp "$proof_lane/anthropic-context-limit.integration.test.ts" "$proof_test"
set +e
node scripts/run-vitest.mjs "$proof_test" --reporter=verbose --reporter=json --outputFile="$proof_evidence/baseline.json" >"$proof_evidence/baseline.log" 2>&1
proof_rc=$?
set -e
printf '%s\n' "$proof_rc" >"$proof_evidence/baseline.exit"
cp "$proof_test" "$proof_evidence/baseline-test.ts"
node "$proof_lane/verify-baseline.mjs" "$proof_evidence/baseline.json" "$proof_evidence/baseline.log" "$proof_rc" "$proof_evidence/verdict.json"
