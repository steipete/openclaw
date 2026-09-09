#!/usr/bin/env bash
set -euo pipefail
target=$1
lane=$2
evidence=$3
[[ "$4" == candidate ]]
[[ "$target" = /* && "$lane" = /* && "$evidence" = /* ]]
[[ "${CI:-}" == 1 && "${SOURCE_SHA:-}" == 0fb043343719937687064f4a47d0730d4a97bfcb ]]
mkdir -p "$evidence"
cd "$target"
trap 'code=$?; printf "%s\n" "$code" > "$evidence/chain-exit.txt"' EXIT
cp "$lane/MANIFEST.json" "$evidence/manifest.json"
cp "$lane/source.json" "$evidence/static-source.json"
cp "$lane/candidate.patch" "$evidence/candidate.patch"
python3 "$lane/verify.py" "$lane" clean > "$evidence/source-before.json"
git apply --index "$lane/candidate.patch"
python3 "$lane/verify.py" "$lane" candidate > "$evidence/source-patched.json"
set +e
node scripts/check-changed.mjs --staged --timed > "$evidence/changed-checks.log" 2>&1
code=$?
set -e
printf '%s\n' "$code" > "$evidence/changed-checks.exit"
python3 "$lane/verify.py" "$lane" candidate > "$evidence/source-after.json"
git diff HEAD --binary --full-index > "$evidence/final.patch"
[[ "$code" == 0 ]]
python3 "$lane/validate.py" "$lane" "$evidence" > "$evidence/verdict.json"
printf 'PASS\n' > "$evidence/verdict.txt"
