#!/usr/bin/env python3
"""Hosted-only diagnostic. Preserve failed child output; never treat it as repaired."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

packet = Path(__file__).resolve().parent
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
manifest = json.loads((packet / "source-manifest.json").read_text())

def output(*args):
    return subprocess.check_output(args, text=True).strip()

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

assert (
    os.environ.get("CI") == "1"
    and os.environ.get("PROOF_LANE") == "doctor-public-memory-diagnostic"
    and os.environ.get("PROOF_MODE") == "baseline"
    and sys.platform == "linux"
), "Expected the isolated Linux diagnostic lane"
assert output("git", "rev-parse", "HEAD") == manifest["base"]
assert output("git", "status", "--porcelain", "--untracked-files=no") == ""
assert output("node", "--version") == "v" + manifest["node"]
assert output("pnpm", "--version") == manifest["pnpm"]
for name, hashes in manifest["files"].items():
    assert digest(name) == hashes.get("before", hashes.get("unchanged")), name
assert digest(packet / "diagnostic.patch") == manifest["patchSha256"]
subprocess.run(["git", "apply", "--check", str(packet / "diagnostic.patch")], check=True)
subprocess.run(["git", "apply", str(packet / "diagnostic.patch")], check=True)
for name, hashes in manifest["files"].items():
    assert digest(name) == hashes.get("after", hashes.get("unchanged")), name

test_name = "imports public transcripts and completes branch projections under a 256 MiB heap"
command = [
    "node", "scripts/run-vitest.mjs", "run", "--config",
    "test/vitest/vitest.commands.config.ts",
    "src/commands/doctor-session-sqlite.memory.test.ts",
    "--testNamePattern", "^" + re.escape(test_name) + "$", "--reporter=verbose",
]
with (out / "diagnostic.log").open("wb") as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False)
text = (out / "diagnostic.log").read_text(errors="replace")
text = re.sub(r"\x1b\[[0-9;]*m", "", text)
phases = []
for line in text.splitlines():
    start = line.find('{"doctorMemoryPhase":')
    if start < 0:
        continue
    try:
        row = json.JSONDecoder().raw_decode(line[start:])[0]
    except (ValueError, json.JSONDecodeError):
        continue
    if not phases or row != phases[-1]:
        phases.append(row)
phase_pids = {row.get("pid") for row in phases}
gc_pids = {
    int(pid)
    for pid in re.findall(r"\[(\d+):0x[0-9a-fA-F]+\]\s+\d+ ms: Mark-Compact", text)
}
observed_oom = (
    result.returncode != 0
    and test_name in text
    and "seeded 1 sessions x 100000 events; importing" in text
    and "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" in text
    and "SIGABRT" in text
    and "--max-old-space-size=256" in text
    and re.search(r"\bTests\s+1 failed\s+\|\s+2 skipped\s+\(3\)\s*$", text, re.MULTILINE)
    and re.search(r"\bTest Files\s+1 failed\s+\(1\)\s*$", text, re.MULTILINE)
    and "Failed Suites" not in text
    and "Unhandled Errors" not in text
    and len(phases) > 0
    and len(phase_pids) == 1
    and phase_pids == gc_pids
)
summary = {
    "classification": "instrumented-public-child-oom" if observed_oom else "unclassified",
    "isFixProof": False,
    "command": command,
    "exitCode": result.returncode,
    "source": manifest,
    "phases": phases,
    "phasePids": sorted(phase_pids),
    "gcPids": sorted(gc_pids),
    "logSha256": digest(out / "diagnostic.log"),
}
(out / "diagnostic-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
# Even a classified OOM remains a failed run. Artifacts are uploaded with always().
sys.exit(result.returncode if result.returncode != 0 else 1)
