#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
sudo apt-get update > "$evidence_dir/apt-update.log" 2>&1
sudo apt-get install --no-install-recommends -y ffmpeg ripgrep > "$evidence_dir/ffmpeg-install.log" 2>&1
dpkg-query -W -f='${Package} ${Version}\n' ffmpeg > "$evidence_dir/ffmpeg-package.txt"
/usr/bin/ffprobe -version > "$evidence_dir/ffprobe-version.txt"
case "$PROOF_VARIANT" in
  ffprobe4)
    rg -q '^ffprobe version 4\.' "$evidence_dir/ffprobe-version.txt"
    expected=red
    ;;
  ffprobe6)
    rg -q '^ffprobe version 6\.' "$evidence_dir/ffprobe-version.txt"
    expected=green
    ;;
  *) exit 64 ;;
esac
bash "$lane_dir/run-ffprobe-proof.sh" "$lane_dir" "$evidence_dir" "$expected"
