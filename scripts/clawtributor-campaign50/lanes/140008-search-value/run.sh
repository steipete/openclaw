#!/usr/bin/env bash
set -euo pipefail
TARGET_DIR=${1:?target directory required}
LANE_DIR=${2:?lane directory required}
EVIDENCE_DIR=${3:?evidence directory required}
MODE=${4:?mode required}
[[ "$MODE" == green ]]
mkdir -p "$EVIDENCE_DIR"
cd "$TARGET_DIR"
[[ "$(git rev-parse HEAD)" == 7475087fa97a73587e2b15ac514733ae3bbfa024 ]]
[[ "${SOURCE_SHA:?source SHA missing}" == 7475087fa97a73587e2b15ac514733ae3bbfa024 ]]
retain_diff() { git diff --binary > "$EVIDENCE_DIR/final-working-tree.patch"; }
trap retain_diff EXIT
sha256sum -c "$LANE_DIR/product.sha256" > "$EVIDENCE_DIR/source-check.log"
sudo apt-get install --no-install-recommends -y fd-find > "$EVIDENCE_DIR/fd-install.log" 2>&1
fd_binary=$(command -v fdfind)
command -v rg >/dev/null
mkdir -p "$EVIDENCE_DIR/bin"
ln -s "$fd_binary" "$EVIDENCE_DIR/bin/fd"
export PATH="$EVIDENCE_DIR/bin:$PATH"
fd --version > "$EVIDENCE_DIR/search-versions.log"
rg --version >> "$EVIDENCE_DIR/search-versions.log"
export OPENCLAW_STATE_DIR="$EVIDENCE_DIR/state"
export OPENCLAW_CONFIG_PATH="$EVIDENCE_DIR/state/openclaw.json"
export OPENCLAW_VITEST_MAX_WORKERS=2
sha256sum -c "$LANE_DIR/baseline-test.sha256" > "$EVIDENCE_DIR/baseline-test-check.log"
git apply --check "$LANE_DIR/regression.patch"
git apply "$LANE_DIR/regression.patch"
# Test-only baseline red was independently verified from run 34034282400.
# Apply the unchanged candidate without repeating either accepted baseline.
git apply --check "$LANE_DIR/production.patch"
git apply "$LANE_DIR/production.patch"
sha256sum -c "$LANE_DIR/candidate.sha256" > "$EVIDENCE_DIR/candidate-check.log"
printf '%s\n' regression-green > "$EVIDENCE_DIR/phase.txt"
node scripts/run-vitest.mjs run src/agents/filesystem-tools-output-contract.test.ts --reporter=verbose --reporter=json --outputFile="$EVIDENCE_DIR/green.json" > "$EVIDENCE_DIR/green.log" 2>&1
node "$LANE_DIR/validate-tests.mjs" "$EVIDENCE_DIR/green.json" "$EVIDENCE_DIR/green.log" green regression 0
printf '%s\n' siblings > "$EVIDENCE_DIR/phase.txt"
node scripts/run-vitest.mjs run src/agents/sessions/tools/find.test.ts src/agents/sessions/tools/find.fd.test.ts src/agents/sessions/tools/grep.stream-errors.test.ts src/agents/sessions/tools/grep.byte-path.test.ts src/agents/sessions/tools/render-utils.test.ts src/agents/sessions/tools/truncate.test.ts src/agents/sessions/tools/index.test.ts --reporter=verbose --reporter=json --outputFile="$EVIDENCE_DIR/siblings.json" > "$EVIDENCE_DIR/siblings.log" 2>&1
node "$LANE_DIR/validate-tests.mjs" "$EVIDENCE_DIR/siblings.json" "$EVIDENCE_DIR/siblings.log" green siblings 0
printf '%s\n' native-green > "$EVIDENCE_DIR/phase.txt"
node --import ./scripts/tsx.mjs "$LANE_DIR/driver.mts" "$TARGET_DIR" "$EVIDENCE_DIR" green > "$EVIDENCE_DIR/driver.log" 2>&1
sha256sum -c "$LANE_DIR/candidate.sha256" > "$EVIDENCE_DIR/candidate-check-after.log"
sha256sum -c "$LANE_DIR/unchanged.sha256" > "$EVIDENCE_DIR/unchanged-check-after.log"
node_modules/.bin/oxfmt --check src/agents/filesystem-tools-output-contract.test.ts src/agents/sessions/tools/find.ts src/agents/sessions/tools/grep.ts src/agents/sessions/tools/tool-contracts.ts > "$EVIDENCE_DIR/format.log" 2>&1
git diff --check
printf '%s\n' complete > "$EVIDENCE_DIR/phase.txt"
