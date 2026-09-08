"""Bind the complete successful candidate envelope to its retained evidence."""
import hashlib
import json
from pathlib import Path
import sys

lane, evidence = (Path(value).resolve() for value in sys.argv[1:3])
manifest = json.loads((lane / "MANIFEST.json").read_text())
binding = json.loads((evidence / "final-source-binding.json").read_text())
assert binding["source"] == manifest["source"] and binding["productionChanged"] is True
assert binding["phase"] == "final"
assert json.loads((evidence / "owner-accepted.json").read_text())["allPassed"] is True
assert json.loads((evidence / "candidate-observation.json").read_text())["matchesExpectedUpdatedFooter"] is True
assert json.loads((evidence / "siblings-accepted.json").read_text())["allPassed"] is True
assert (evidence / "changed-exit-code.txt").read_text().strip() == "0"
assert (evidence / "comparison-base.txt").read_text().strip() == manifest["prBase"]
files = ["comparison-base.txt","siblings-accepted.json", "siblings.json", "siblings.log", "changed-plan.log", "changed-check.log", "changed-exit-code.txt","final-source-binding.json", "owner-accepted.json", "candidate-observation.json",
         "frames.json", "pty.raw", "pty.log", "pty.json", "owner.log", "owner.json",
         "initial.svg", "accepted-event-candidate.svg", "build.log"]
(evidence / "receipt.json").write_text(json.dumps({
    "candidateAccepted": True, "source": manifest["source"], "productionChanged": True,
    "baselineEvidence": manifest["baselineEvidence"],
    "manifestSha256": hashlib.sha256((lane / "MANIFEST.json").read_bytes()).hexdigest(),
    "scope": "Received-event TUI display only; no provider or persistence proof",
    "files": {name: hashlib.sha256((evidence / name).read_bytes()).hexdigest() for name in files},
}, indent=2) + "\n")
