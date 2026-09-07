#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
test "$4" = compare
test "${PROOF_VARIANT:-}" = remaining
mkdir -p "$proof_evidence/baseline-tests" "$proof_evidence/candidate-tests"
cd "$proof_target"
cp "$proof_lane/candidate.patch" "$proof_evidence/candidate.patch"
cp "$proof_lane/MANIFEST.json" "$proof_evidence/manifest.json"
cp "$proof_lane/candidate-files.sha256" "$proof_evidence/candidate-files.sha256"
python3 "$proof_lane/verify-source.py" "$proof_lane" clean > "$proof_evidence/source-clean.json"
git apply --index "$proof_lane/tests.patch"
python3 "$proof_lane/verify-source.py" "$proof_lane" baseline > "$proof_evidence/source-baseline-before.json"

run_unit() {
  local phase=$1 owner=$2 file=$3 filter=$4
  local stem="$proof_evidence/$phase-tests/${5:-$owner}"
  local args=("$file")
  if [[ -n "$filter" ]]; then args+=(-t "$filter"); fi
  set +e
  node scripts/run-vitest.mjs "${args[@]}" --reporter=verbose --reporter=json --outputFile="$stem.json" > "$stem.log" 2>&1
  local code=$?
  set -e
  printf '%s\n' "$code" > "$stem.exit"
  node "$proof_lane/verify-tests.mjs" "$phase" "$owner" "$stem.json" "$stem.log" "$code" "$file" > "$stem.verdict.json"
}

python3 "$proof_lane/verify-reuse.py" "$proof_lane" > "$proof_evidence/reuse-verification.json"
python3 "$proof_lane/verify-reuse27.py" "$proof_lane" > "$proof_evidence/reuse-wave27-verification.json"
cp -R "$proof_lane/reuse-wave25" "$proof_evidence/reuse-wave25"
cp -R "$proof_lane/reuse-wave27" "$proof_evidence/reuse-wave27"
cp "$proof_lane/reuse-lineage.json" "$proof_evidence/reuse-lineage.json"
cp "$proof_lane/reuse-wave27-lineage.json" "$proof_evidence/reuse-wave27-lineage.json"
for owner in capability shared models; do
  cp "$proof_lane/reuse-wave27/baseline-tests/$owner.json" "$proof_evidence/baseline-tests/$owner.json"
  cp "$proof_lane/reuse-wave27/baseline-tests/$owner.log.txt" "$proof_evidence/baseline-tests/$owner.log"
  cp "$proof_lane/reuse-wave27/baseline-tests/$owner.exit" "$proof_evidence/baseline-tests/$owner.exit"
  case "$owner" in
    capability) file=src/cli/capability-cli.test.ts ;;
    shared) file=src/cli/capability-cli/shared.test.ts ;;
    models) file=src/commands/models/scan.test.ts ;;
  esac
  node "$proof_lane/verify-tests.mjs" baseline "$owner" "$proof_evidence/baseline-tests/$owner.json" "$proof_evidence/baseline-tests/$owner.log" 1 "$file" > "$proof_evidence/baseline-tests/$owner.verdict.json"
done
pnpm build > "$proof_evidence/baseline-build.log" 2>&1
python3 "$proof_lane/record-build.py" "$proof_lane" "$proof_evidence" baseline
python3 "$proof_lane/cli-proof.py" "$proof_target" "$proof_lane" "$proof_evidence/baseline-cli" baseline > "$proof_evidence/baseline-cli.log" 2>&1
python3 "$proof_lane/verify-source.py" "$proof_lane" baseline > "$proof_evidence/source-baseline-after.json"

git apply --index "$proof_lane/production.patch"
git apply --index "$proof_lane/docs.patch"
python3 "$proof_lane/verify-source.py" "$proof_lane" candidate > "$proof_evidence/source-candidate-before.json"
run_unit candidate capability src/cli/capability-cli.test.ts ''
run_unit candidate shared src/cli/capability-cli/shared.test.ts ''
run_unit candidate models src/commands/models/scan.test.ts ''
run_unit candidate sibling src/cli/parse-timeout.test.ts '' timeout
run_unit candidate sibling src/cli/models-cli.test.ts '' registration
run_unit candidate sibling packages/normalization-core/src/number-coercion.test.ts '' coercion
pnpm build > "$proof_evidence/candidate-build.log" 2>&1
python3 "$proof_lane/record-build.py" "$proof_lane" "$proof_evidence" candidate
python3 "$proof_lane/cli-proof.py" "$proof_target" "$proof_lane" "$proof_evidence/candidate-cli" candidate > "$proof_evidence/candidate-cli.log" 2>&1
python3 "$proof_lane/verify-source.py" "$proof_lane" candidate > "$proof_evidence/source-candidate-after.json"
git diff --cached --check
printf 'PASS\n' > "$proof_evidence/verdict.txt"
