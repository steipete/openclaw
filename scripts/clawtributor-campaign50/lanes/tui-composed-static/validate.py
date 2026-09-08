"""Qualify completed static checks from retained data; never execute target code."""
import hashlib
import json
from pathlib import Path
import re
import sys

lane, evidence = [Path(value).resolve() for value in sys.argv[1:3]]
manifest = json.loads((lane / "MANIFEST.json").read_text())
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
for name in ["command-chain", "format", "types", "lint", "final-binding", "diff-check"]:
    assert (evidence / (name + "-exit.txt")).read_text().strip() == "0", name
assert not (evidence / "incomplete.txt").exists()
logs = {name: (evidence / (name + ".log")).read_text() for name in ["format", "types", "lint"]}
for name, text in logs.items():
    assert not re.search(r"skipping sparse|sparse-missing|skipping missing|out of memory|heap out of memory|Segmentation fault|Killed|timed out|ETIMEDOUT|retaining|cleanup failed|\[dist artifacts\] child cleanup unverified; retained", text, re.I), name
assert "All matched files use the correct format." in logs["format"]
assert "scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.test.root.json" in logs["types"]
assert re.search(r"Found 0 warnings and 0 errors\.", logs["lint"])
assert re.search(r"on 2 files", logs["lint"])
for phase in ["initial", "patched", "final"]:
    binding = json.loads((evidence / (phase + "-binding.json")).read_text())
    assert binding["source"] == manifest["source"] and binding["sourceTree"] == manifest["sourceTree"]
    assert binding["manifestSha256"] == digest(lane / "MANIFEST.json")
    expected = dict(manifest["sourceHashes"])
    if phase != "initial":
        expected.update(manifest["candidateHashes"])
    assert binding["hashes"] == expected
files = ["format.log", "types.log", "lint.log", "initial-binding.json", "patched-binding.json", "final-binding.json", "final-working-tree.patch", "diff-check.log"]
(evidence / "receipt.json").write_text(json.dumps({
    "staticChecksAccepted": True, "source": manifest["source"], "scope": "Canonical test-root type check and two helper-file format/lint checks only",
    "runtimeTestsExecuted": False, "oldCiCauseClaim": False,
    "manifestSha256": digest(lane / "MANIFEST.json"), "files": {name: digest(evidence / name) for name in files}
}, indent=2) + "\n")
