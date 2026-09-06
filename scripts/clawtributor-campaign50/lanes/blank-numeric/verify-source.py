import hashlib
import json
import pathlib
import subprocess
import sys

lane = pathlib.Path(sys.argv[1])
phase = sys.argv[2]
assert phase in ("clean", "baseline", "candidate")
manifest = json.loads((lane / "MANIFEST.json").read_text())
git = lambda *args: subprocess.check_output(["git", *args], text=True).strip()
assert git("rev-parse", "HEAD") == manifest["base"]
assert subprocess.check_output(["node", "--version"], text=True).strip() == "v" + manifest["node"]
assert subprocess.check_output(["pnpm", "--version"], text=True).strip() == manifest["pnpm"]
assert json.loads(pathlib.Path("package.json").read_text())["packageManager"] == manifest["packageManager"]
assert json.loads(pathlib.Path("package.json").read_text())["bin"]["openclaw"] == manifest["entry"]
assert hashlib.sha256(pathlib.Path(manifest["entry"]).read_bytes()).hexdigest() == manifest["entry_sha256"]
if phase == "clean":
    assert not git("status", "--porcelain", "--untracked-files=normal")
else:
    for name, expected in manifest[phase + "_files"].items():
        assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected, name
    actual = set(git("diff", "--name-only", "HEAD").splitlines())
    expected = set(manifest["candidate_files"])
    if phase == "baseline":
        expected = {name for name in expected if name.endswith(".test.ts")}
    assert actual == expected, actual ^ expected
    assert not git("ls-files", "--others", "--exclude-standard")
print(json.dumps({"phase": phase, "base": manifest["base"], "node": manifest["node"], "pnpm": manifest["pnpm"], "source_hashes": "verified"}))
