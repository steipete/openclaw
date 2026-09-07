#!/usr/bin/env bash
set -euo pipefail
exec python3 "$2/proof.py" "$1" "$2" "$3" "$4"
