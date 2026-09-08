"""Hash and Git-state checks only; target source is never imported."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

target, lane, evidence = (Path(value).resolve() for value in sys.argv[1:4])
phase = sys.argv[4]
manifest = json.loads((lane / "MANIFEST.json").read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", str(target), *args]).decode()


assert phase in {"initial", "patched", "final"}
assert git("rev-parse", "HEAD").strip() == manifest["source"]
for relative, expected in manifest["artifacts"].items():
    assert digest(lane / relative) == expected, relative
expected_hashes = dict(manifest["sourceHashes"])
if phase == "initial":
    assert not git("status", "--porcelain").strip()
    assert not (target / "src/tui/tui-fallback-fixture-test-support.ts").exists()
else:
    expected_hashes.update(manifest["patchedTestHashes"])
    tracked = git("diff", "--name-only").splitlines()
    untracked = git("ls-files", "--others", "--exclude-standard").splitlines()
    assert sorted(tracked + untracked) == sorted(manifest["patchedTestHashes"])
    assert not git("diff", "--cached", "--name-only").strip()
for relative, expected in expected_hashes.items():
    assert digest(target / relative) == expected, relative
(evidence / (phase + "-source-binding.json")).write_text(json.dumps({
    "source": manifest["source"], "phase": phase, "hashes": expected_hashes,
    "productionChanged": False, "manifestSha256": digest(lane / "MANIFEST.json"),
}, indent=2) + "\n")
