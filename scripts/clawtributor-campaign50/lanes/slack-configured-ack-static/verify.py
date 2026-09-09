import hashlib
import json
from pathlib import Path
import subprocess
import sys

lane, phase = Path(sys.argv[1]), sys.argv[2]
assert phase in {"clean", "candidate"}
s = json.loads((lane / "source.json").read_text())
m = json.loads((lane / "MANIFEST.json").read_text())
for name, expected in m["files"].items():
    assert hashlib.sha256((lane / name).read_bytes()).hexdigest() == expected, name
run = lambda *args: subprocess.check_output(args, text=True).strip()
assert run("git", "rev-parse", "HEAD") == s["base"]
assert run("git", "rev-parse", "HEAD^{tree}") == s["sourceTree"]
assert run("node", "--version") == "v" + s["node"]
assert run("pnpm", "--version") == s["pnpm"]
assert json.loads(Path("package.json").read_text())["packageManager"] == s["packageManager"]
subprocess.run(["git", "diff", "--quiet"], check=True)
assert run("git", "ls-files", "--others", "--exclude-standard") == ""
assert run("git", "diff", "--cached", "--name-only").splitlines() == ([] if phase == "clean" else sorted(s["candidate"]))
expected = dict(s["baseline"])
if phase == "candidate":
    expected.update(s["candidate"])
assert run("git", "write-tree") == (s["sourceTree"] if phase == "clean" else s["committedTree"])
for name, digest in expected.items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest, name
print(json.dumps({"phase": phase, "base": s["base"], "sourceTree": s["sourceTree"], "committedHead": s["committedHead"], "stagedTree": run("git", "write-tree"), "files": expected, "node": s["node"], "packageManager": s["packageManager"]}, indent=2))
