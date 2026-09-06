import hashlib
import json
import pathlib
import subprocess
import sys

lane, evidence = map(pathlib.Path, sys.argv[1:3])
phase = sys.argv[3]
assert phase in ("baseline", "candidate")
subprocess.run([sys.executable, str(lane / "verify-source.py"), str(lane), phase], check=True)
entry = pathlib.Path("dist/entry.js")
assert entry.is_file()
files = []
for file in sorted(pathlib.Path("dist").rglob("*")):
    if file.is_symlink():
        files.append({"path": str(file), "symlink": str(file.readlink())})
    elif file.is_file():
        files.append({"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
assert files
result = {
    "phase": phase,
    "command": ["pnpm", "build"],
    "exit": 0,
    "source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "entry": "openclaw.mjs",
    "entry_sha256": hashlib.sha256(pathlib.Path("openclaw.mjs").read_bytes()).hexdigest(),
    "built_entry_sha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
    "build_info": json.loads(pathlib.Path("dist/build-info.json").read_text()),
    "files": files,
}
(evidence / (phase + "-build.json")).write_text(json.dumps(result, indent=2) + "\n")
