#!/usr/bin/env bash
set -euo pipefail
[[ "$4" == green ]] || exit 64
[[ "$(node --version)" == v24.20.0 ]] || exit 65
[[ "$(pnpm --version)" == 12.3.4 ]] || exit 66
node "$2/run-proof.mjs" "$1" "$2" "$3" "$4"
