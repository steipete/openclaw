#!/usr/bin/env bash
set -euo pipefail
proof_dir="$1"
evidence_dir="$2"
mkdir -p "$evidence_dir"
[[ "$(git rev-parse HEAD)" == "7216075c2912dd331a4ba90df07efdc798069927" ]]
git rev-parse HEAD > "$evidence_dir/baseline-sha.txt"
git apply "$proof_dir/138411-nfc-tests.patch"
for target in fetch store; do
  test_path=extensions/file-transfer/src/tools/file-fetch-tool.test.ts
  [[ "$target" != store ]] || test_path=src/media/store.test.ts
  set +e
  node scripts/run-vitest.mjs "$test_path" -- --reporter=default --reporter=json --outputFile "$evidence_dir/baseline-$target.json" > "$evidence_dir/baseline-$target.log" 2>&1
  baseline_result=$?
  set -e
  cat "$evidence_dir/baseline-$target.log"
  [[ "$baseline_result" == 1 ]]
done
node "$proof_dir/validate-file-fetch-nfc-proof.mjs" baseline "$evidence_dir"
git apply "$proof_dir/138411-nfc-production.patch"
for target in fetch store; do
  test_path=extensions/file-transfer/src/tools/file-fetch-tool.test.ts
  [[ "$target" != store ]] || test_path=src/media/store.test.ts
  node scripts/run-vitest.mjs "$test_path" -- --reporter=default --reporter=json --outputFile "$evidence_dir/candidate-$target.json" 2>&1 | tee "$evidence_dir/candidate-$target.log"
done
node "$proof_dir/validate-file-fetch-nfc-proof.mjs" candidate "$evidence_dir"
node_modules/.bin/oxfmt --check extensions/file-transfer/src/tools/file-fetch-tool.ts extensions/file-transfer/src/tools/file-fetch-tool.test.ts src/media/store.ts src/media/store.test.ts 2>&1 | tee "$evidence_dir/candidate-format.log"
git diff --check
git diff > "$evidence_dir/candidate.patch"
sha256sum extensions/file-transfer/src/tools/file-fetch-tool.ts extensions/file-transfer/src/tools/file-fetch-tool.test.ts src/media/store.ts src/media/store.test.ts > "$evidence_dir/candidate-files.sha256"
sha256sum --check "$proof_dir/138411-nfc-candidate-files.sha256" | tee "$evidence_dir/source-hash-check.log"
