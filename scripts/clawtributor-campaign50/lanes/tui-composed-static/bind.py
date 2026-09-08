"""Inspect hashes and Git data only; never import target source."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

target, lane, evidence = [Path(value).resolve() for value in sys.argv[1:4]]
phase = sys.argv[4]
manifest = json.loads((lane / "MANIFEST.json").read_text())
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def git(*args):
    return subprocess.check_output(["git", "-C", str(target), *args], text=True).strip()
assert phase in {"initial", "patched", "final"}
assert git("rev-parse", "HEAD") == manifest["source"]
assert git("rev-parse", "HEAD^{tree}") == manifest["sourceTree"]
sparse = subprocess.run(["git", "-C", str(target), "config", "--get", "--bool", "core.sparseCheckout"], capture_output=True, text=True)
assert sparse.returncode in {0, 1}
if sparse.returncode == 0:
    assert sparse.stdout.strip() == "false"
for relative, expected in manifest["artifacts"].items():
    assert digest(lane / relative) == expected, relative
expected = dict(manifest["sourceHashes"])
if phase == "initial":
    assert not git("status", "--porcelain")
else:
    expected.update(manifest["candidateHashes"])
    changed = git("diff", "--name-only").splitlines()
    untracked = git("ls-files", "--others", "--exclude-standard").splitlines()
    assert sorted(changed + untracked) == sorted(manifest["overlayPaths"])
    assert not git("diff", "--cached", "--name-only")
for relative, value in expected.items():
    assert digest(target / relative) == value, relative
(evidence / (phase + "-binding.json")).write_text(json.dumps({
    "phase": phase, "source": manifest["source"], "sourceTree": manifest["sourceTree"],
    "hashes": expected, "manifestSha256": digest(lane / "MANIFEST.json")
}, indent=2) + "\n")
