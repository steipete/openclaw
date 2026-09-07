#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
test "$4" = green
mkdir -p "$proof_evidence/tests" "$proof_evidence/candidate-source"
cd "$proof_target"
test "$(pnpm --version)" = 12.3.4
cp "$proof_lane/PACKET.json" "$proof_evidence/packet.json"
cp "$proof_lane/candidate.patch" "$proof_evidence/candidate.patch"
proof_phase=clean
finalize() {
  local proof_exit=$?
  set +e
  node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" "$proof_phase" > "$proof_evidence/source-final.json" 2> "$proof_evidence/source-final.stderr"
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
assert(built.inventoryComplete && after.inventoryComplete);
assert(built.buildFiles > 0);
assert.equal(after.buildFiles, built.buildFiles);
assert.equal(after.buildLinks, built.buildLinks);
assert.equal(after.buildHash, built.buildHash);
console.log("Built CLI files and literal links unchanged");
JS
    local proof_integrity_exit=$?
    printf '%s\n' "$proof_integrity_exit" > "$proof_evidence/build-integrity.exit"
    if [[ "$proof_integrity_exit" != 0 ]]; then proof_exit=1; fi
  fi
  if [[ "$proof_exit" = 0 ]]; then printf 'CANDIDATE_PASSED\n' > "$proof_evidence/verdict.txt";
  else printf 'FAILED\n' > "$proof_evidence/verdict.txt"; fi
  exit "$proof_exit"
}
trap finalize EXIT
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" clean > "$proof_evidence/source-clean.json"
git apply --index "$proof_lane/tests.patch"
proof_phase=baseline
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" baseline > "$proof_evidence/source-unit-baseline.json"
run_unit() {
  local phase=$1 owner=$2 file=$3 filter=$4 stem=$5
  local args=("$file")
  if [[ -n "$filter" ]]; then args+=(-t "$filter"); fi
  set +e
  node scripts/run-vitest.mjs "${args[@]}" --reporter=verbose --reporter=json --outputFile="$proof_evidence/tests/$stem.json" > "$proof_evidence/tests/$stem.log" 2>&1
  local code=$?
  set -e
  printf '%s\n' "$code" > "$proof_evidence/tests/$stem.exit"
  node "$proof_lane/verify-tests.mjs" "$phase" "$owner" "$proof_evidence/tests/$stem.json" "$proof_evidence/tests/$stem.log" "$code" "$file" > "$proof_evidence/tests/$stem.verdict.json"
}
run_unit baseline logs src/commands/channels.logs.test.ts 'preserves ordering with line limit|rejects invalid line limit' baseline-logs
run_unit baseline models src/commands/models/list.status.test.ts 'rejects invalid probe numeric option|forwards probe numeric options' baseline-models
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" baseline > "$proof_evidence/source-after-unit-baseline.json"
git apply --index "$proof_lane/production.patch" "$proof_lane/docs.patch"
proof_phase=candidate
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" candidate > "$proof_evidence/source-candidate.json"
for file in src/commands/channels/logs.ts src/commands/models/list.status-command.ts src/commands/channels.logs.test.ts src/commands/models/list.status.test.ts docs/cli/channels.md docs/cli/models.md; do
  mkdir -p "$proof_evidence/candidate-source/$(dirname "$file")"
  cp "$file" "$proof_evidence/candidate-source/$file"
done
run_unit candidate logs src/commands/channels.logs.test.ts '' candidate-logs
run_unit candidate models src/commands/models/list.status.test.ts '' candidate-models
run_unit candidate sibling src/cli/channels-cli.test.ts '' candidate-channels-registration
run_unit candidate sibling src/cli/models-cli.test.ts '' candidate-models-registration
run_unit candidate sibling packages/normalization-core/src/number-coercion.test.ts '' candidate-coercion
set +e
node scripts/check-changed.mjs --base b7ec235a5cc05ae9577095498de5cfd6b8e2d293 -- src/commands/channels/logs.ts src/commands/models/list.status-command.ts src/commands/channels.logs.test.ts src/commands/models/list.status.test.ts docs/cli/channels.md docs/cli/models.md > "$proof_evidence/check-changed.log" 2>&1
proof_check_exit=$?
set -e
printf '%s\n' "$proof_check_exit" > "$proof_evidence/check-changed.exit"
test "$proof_check_exit" = 0
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" candidate > "$proof_evidence/source-after-checks.json"
set +e
pnpm build > "$proof_evidence/build.log" 2>&1
proof_build_exit=$?
set -e
printf '%s\n' "$proof_build_exit" > "$proof_evidence/build.exit"
test "$proof_build_exit" = 0
node "$proof_lane/verify-source.mjs" "$proof_target" "$proof_lane" candidate > "$proof_evidence/source-after-build.json"
node "$proof_lane/cli-proof.mjs" "$proof_target" "$proof_lane" "$proof_evidence/cli" candidate > "$proof_evidence/cli.log" 2>&1
