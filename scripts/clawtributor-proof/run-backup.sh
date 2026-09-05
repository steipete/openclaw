#!/usr/bin/env bash
set -euo pipefail
lane="$1"
proof_dir="$2/$lane"
evidence_dir="$3"
mkdir -p "$evidence_dir"
git rev-parse HEAD > "$evidence_dir/baseline-sha.txt"
if [[ "$lane" == backup-unicode ]]; then
  cp "$proof_dir/proof.mts" .clawtributor-backup-proof.mts
  set +e
  node --import ./scripts/tsx.mjs .clawtributor-backup-proof.mts > "$evidence_dir/baseline.log" 2>&1
  result=$?
  set -e
  cat "$evidence_dir/baseline.log"
  [[ "$result" == 1 ]]
  grep -q '^BACKUP_UNICODE_BASELINE_RED:' "$evidence_dir/baseline.log"
  git apply "$proof_dir/production.patch"
  node --import ./scripts/tsx.mjs .clawtributor-backup-proof.mts 2>&1 | tee "$evidence_dir/candidate.log"
  grep -Fxq 'BACKUP_UNICODE_CANDIDATE_GREEN' "$evidence_dir/candidate.log"
  git apply "$proof_dir/tests.patch"
  node scripts/run-vitest.mjs src/infra/backup-create.windows.test.ts packages/normalization-core/src/utf16-slice.test.ts 2>&1 | tee "$evidence_dir/candidate-tests.log"
else
  cp "$proof_dir/real-filesystem-proof.mts" .clawtributor-config-proof.mts
  node --import ./scripts/tsx.mjs .clawtributor-config-proof.mts baseline 2>&1 | tee "$evidence_dir/baseline-observed.log"
  set +e
  node --import ./scripts/tsx.mjs .clawtributor-config-proof.mts candidate > "$evidence_dir/baseline.log" 2>&1
  result=$?
  set -e
  cat "$evidence_dir/baseline.log"
  [[ "$result" == 1 ]]
  grep -Fq 'CONFIG_REJECTED_SAVE_REGRESSION:EACCES' "$evidence_dir/baseline.log"
  git apply "$proof_dir/candidate.patch"
  node --import ./scripts/tsx.mjs .clawtributor-config-proof.mts candidate 2>&1 | tee "$evidence_dir/candidate.log"
  node scripts/run-vitest.mjs src/config/io.write-config.test.ts src/config/io.eacces.test.ts src/config/io.audit.test.ts src/config/config.backup-rotation.test.ts 2>&1 | tee "$evidence_dir/candidate-tests.log"
fi
git diff --check
git diff > "$evidence_dir/candidate.patch"
