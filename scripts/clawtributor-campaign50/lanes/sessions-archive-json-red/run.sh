#!/usr/bin/env bash
set -euo pipefail
node "$2/proof.mjs" "$1" "$2" "$3" "$4"
exec node "$2/validate-artifact.mjs" "$3" "$2"
