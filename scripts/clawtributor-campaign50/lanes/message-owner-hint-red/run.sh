#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
test "$4" = baseline
mkdir -p "$proof_evidence"
cd "$proof_target"
test "$(pnpm --version)" = 12.3.4
cp "$proof_lane/PACKET.json" "$proof_evidence/packet.json"
finalize() {
  local proof_exit=$?
  set +e
  node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" > "$proof_evidence/source-final.json" 2> "$proof_evidence/source-final.stderr"
  local proof_source_exit=$?
  printf '%s\n' "$proof_source_exit" > "$proof_evidence/source-final.exit"
  if [[ "$proof_source_exit" != 0 ]]; then proof_exit=1; fi
  if [[ -s "$proof_evidence/source-after-build.json" && "$proof_source_exit" = 0 ]]; then
    node --input-type=module - "$proof_evidence" > "$proof_evidence/build-integrity.log" 2>&1 <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const evidence = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(path.join(evidence, name), "utf8"));
const built = read("source-after-build.json");
const after = read("source-final.json");
assert(built.buildFiles > 0);
assert.equal(after.buildFiles, built.buildFiles);
assert.equal(after.buildHash, built.buildHash);
console.log("Built CLI bytes unchanged");
JS
    local proof_integrity_exit=$?
    printf '%s\n' "$proof_integrity_exit" > "$proof_evidence/build-integrity.exit"
    if [[ "$proof_integrity_exit" != 0 ]]; then proof_exit=1; fi
  fi
  if [[ "$proof_exit" = 0 ]]; then
    printf 'BASELINE_REPRODUCED\n' > "$proof_evidence/verdict.txt"
  else
    printf 'FAILED\n' > "$proof_evidence/verdict.txt"
  fi
  exit "$proof_exit"
}
trap finalize EXIT
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" > "$proof_evidence/source-before.json"
set +e
pnpm build > "$proof_evidence/build.log" 2>&1
proof_build_exit=$?
set -e
printf '%s\n' "$proof_build_exit" > "$proof_evidence/build.exit"
test "$proof_build_exit" = 0
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" > "$proof_evidence/source-after-build.json"
node "$proof_lane/cli-proof.mjs" "$proof_target" "$proof_lane" "$proof_evidence/cli" baseline > "$proof_evidence/cli.log" 2>&1
