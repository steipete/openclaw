"""Bind the complete successful baseline envelope to its retained evidence."""
import hashlib
import json
from pathlib import Path
import sys

lane, evidence = (Path(value).resolve() for value in sys.argv[1:3])
manifest = json.loads((lane / "MANIFEST.json").read_text())
binding = json.loads((evidence / "final-source-binding.json").read_text())
assert binding["source"] == manifest["source"] and binding["productionChanged"] is False
assert binding["phase"] == "final"
assert json.loads((evidence / "owner-accepted.json").read_text())["allPassed"] is True
assert json.loads((evidence / "baseline-observation.json").read_text())["matchesExpectedStaleFooter"] is True
files = ["final-source-binding.json", "owner-accepted.json", "baseline-observation.json",
         "frames.json", "pty.raw", "pty.log", "pty.json", "owner.log", "owner.json",
         "initial.svg", "accepted-event-baseline.svg", "build.log"]
(evidence / "receipt.json").write_text(json.dumps({
    "baselineAccepted": True, "source": manifest["source"], "productionChanged": False,
    "manifestSha256": hashlib.sha256((lane / "MANIFEST.json").read_bytes()).hexdigest(),
    "scope": "Received-event TUI display only; no provider or persistence proof",
    "files": {name: hashlib.sha256((evidence / name).read_bytes()).hexdigest() for name in files},
}, indent=2) + "\n")
