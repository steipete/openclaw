"""Read the reviewed lane manifest before any target code executes."""
import json
import os
from pathlib import Path
import re

root = Path(__file__).parent
rows = json.loads((root / "matrix.json").read_text())
if not isinstance(rows, list) or not rows or len(rows) > 12:
    raise ValueError("expected between 1 and 12 reviewed proof lanes")
seen = set()
for row in rows:
    if set(row) != {"id", "directory", "runner", "source", "node", "pnpm", "mode", "variant"}:
        raise ValueError("unexpected proof lane fields")
    for key in ("id", "directory", "variant"):
        if not isinstance(row[key], str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", row[key]):
            raise ValueError("invalid proof lane identifier")
    if row["id"] in seen:
        raise ValueError("duplicate proof lane")
    seen.add(row["id"])
    if row["runner"] not in {"ubuntu-22.04", "ubuntu-24.04", "windows-2025"}:
        raise ValueError("proof requires an explicit GitHub-hosted Ubuntu or Windows image")
    if not re.fullmatch(r"[a-f0-9]{40}", row["source"]):
        raise ValueError("proof source must be an immutable full SHA")
    for key in ("node", "pnpm"):
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", row[key]):
            raise ValueError("toolchain versions must be exact")
    if row["mode"] not in {"baseline", "compare", "candidate", "red", "green"}:
        raise ValueError("invalid proof mode")
    entrypoint = "run.ps1" if row["runner"] == "windows-2025" else "run.sh"
    runner = root / "lanes" / row["directory"] / entrypoint
    if not runner.is_file() or runner.is_symlink():
        raise ValueError("missing regular reviewed lane runner")
matrix = json.dumps({"include": rows}, separators=(",", ":"))
print(matrix)
with open(os.environ["GITHUB_OUTPUT"], "a") as output:
    output.write("matrix=" + matrix + "\n")
