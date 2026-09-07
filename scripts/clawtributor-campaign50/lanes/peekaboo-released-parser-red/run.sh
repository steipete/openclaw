#!/usr/bin/env bash
set -euo pipefail
python3 "$2/parser-proof.py" "$1" "$2" "$3" "$4"
