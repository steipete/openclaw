#!/usr/bin/env bash
set -euo pipefail
exec node "$2/proof.mjs" "$1" "$2" "$3" "$4"
