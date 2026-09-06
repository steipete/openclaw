#!/usr/bin/env bash
set -euo pipefail
TARGET_DIR=${1:?target directory required}
LANE_DIR=${2:?lane directory required}
EVIDENCE_DIR=${3:?evidence directory required}
MODE=${4:?mode required}
if [[ "$MODE" != red ]]; then
  echo 'This packet permits baseline proof only; candidate execution requires the reviewed follow-up packet.' >&2
  exit 2
fi
mkdir -p "$EVIDENCE_DIR"
cd "$TARGET_DIR"
EXPECTED_SHA=7475087fa97a73587e2b15ac514733ae3bbfa024
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" ]]
[[ "${SOURCE_SHA:?source SHA missing}" == "$EXPECTED_SHA" ]]
sha256sum -c "$LANE_DIR/product.sha256" > "$EVIDENCE_DIR/source-check.log"
sudo apt-get install --no-install-recommends -y fd-find > "$EVIDENCE_DIR/fd-install.log" 2>&1
fd_binary=$(command -v fdfind)
rg_binary=$(command -v rg)
mkdir -p "$EVIDENCE_DIR/bin"
ln -s "$fd_binary" "$EVIDENCE_DIR/bin/fd"
export PATH="$EVIDENCE_DIR/bin:$PATH"
fd --version > "$EVIDENCE_DIR/search-versions.log"
"$rg_binary" --version >> "$EVIDENCE_DIR/search-versions.log"
export OPENCLAW_STATE_DIR="$EVIDENCE_DIR/state"
export OPENCLAW_CONFIG_PATH="$EVIDENCE_DIR/state/openclaw.json"
node --import ./scripts/tsx.mjs "$LANE_DIR/driver.mts" "$TARGET_DIR" "$EVIDENCE_DIR" red > "$EVIDENCE_DIR/driver.log" 2>&1
sha256sum -c "$LANE_DIR/product.sha256" > "$EVIDENCE_DIR/source-check-after.log"
