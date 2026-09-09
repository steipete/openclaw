#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
test "$4" = compare
[[ "$proof_target" = /* && "$proof_lane" = /* && "$proof_evidence" = /* ]]
mkdir -p "$proof_evidence/baseline-observations" "$proof_evidence/candidate-observations"
cd "$proof_target"
python3 "$proof_lane/verify-source.py" "$proof_lane" clean > "$proof_evidence/source-clean.json"
proof_state=$(mktemp -d "$proof_evidence/state.XXXXXX")
proof_complete=false
trap 'if [[ "$proof_complete" = true ]]; then rm -rf "$proof_state"; else printf "Preserved incomplete proof state: %s\n" "$proof_state" >&2; fi' EXIT
export OPENCLAW_HOME="$proof_state/openclaw"
export OPENCLAW_TMP_DIR="$proof_state/tmp"
export XDG_CONFIG_HOME="$proof_state/config"
export XDG_CACHE_HOME="$proof_state/cache"
export XDG_DATA_HOME="$proof_state/data"
export TMPDIR="$proof_state/tmp"
mkdir -p "$OPENCLAW_HOME" "$OPENCLAW_TMP_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
cp "$proof_lane/source.json" "$proof_evidence/slack-ack-source.json"
cp "$proof_lane/MANIFEST.json" "$proof_evidence/manifest.json"
cp "$proof_lane/candidate.patch" "$proof_evidence/candidate.patch"
cp "$proof_lane/ack-ingress.proof.test.ts" "$proof_evidence/ack-ingress.proof.test.ts"
cp "$proof_lane/ack-ingress.proof.test.ts" extensions/slack/src/monitor.ack-ingress.proof.test.ts
git apply --index "$proof_lane/tests.patch"
python3 "$proof_lane/verify-source.py" "$proof_lane" baseline > "$proof_evidence/source-baseline-before.json"

run_phase() {
  local phase=$1 kind=$2 file=$3
  local stem="$proof_evidence/$phase-$kind"
  local args=("$file")
  if [[ "$kind" = unit ]]; then
    args+=(-t 'keeps the configured static ack with|primes Slack status reactions when channel replies are message-tool-only')
  fi
  export SLACK_ACK_PROOF_OUTPUT="$proof_evidence/$phase-observations"
  set +e
  node scripts/run-vitest.mjs "${args[@]}" --reporter=verbose --reporter=json --outputFile="$stem.json" > "$stem.log" 2>&1
  local code=$?
  set -e
  printf '%s\n' "$code" > "$stem.exit"
  python3 "$proof_lane/verify-source.py" "$proof_lane" "$phase" > "$stem.source.json"
  node "$proof_lane/verify-tests.mjs" "$phase" "$kind" "$stem.json" "$stem.log" "$code" "$proof_evidence/$phase-observations" > "$stem.verdict.json"
}

python3 "$proof_lane/verify-reuse.py" "$proof_lane" > "$proof_evidence/unit-lineage-verdict.json"
mkdir -p "$proof_evidence/reused-unit"
cp "$proof_lane/reuse-unit/"* "$proof_evidence/reused-unit/"
node "$proof_lane/verify-tests.mjs" baseline unit \
  "$proof_evidence/reused-unit/baseline-unit.json" \
  "$proof_evidence/reused-unit/baseline-unit.log.txt" 1 \
  "$proof_evidence/reused-unit/unused-observations" > "$proof_evidence/reused-unit/current-reader-verdict.json"
run_phase baseline ingress extensions/slack/src/monitor.ack-ingress.proof.test.ts
git apply --index "$proof_lane/production.patch"
python3 "$proof_lane/verify-source.py" "$proof_lane" candidate > "$proof_evidence/source-candidate-before.json"
run_phase candidate unit extensions/slack/src/monitor/message-handler/prepare.test.ts
run_phase candidate ingress extensions/slack/src/monitor.ack-ingress.proof.test.ts
python3 "$proof_lane/verify-source.py" "$proof_lane" candidate > "$proof_evidence/source-candidate-after.json"
git diff HEAD --binary > "$proof_evidence/final-working-tree.patch"
printf 'PASS\n' > "$proof_evidence/verdict.txt"
proof_complete=true
