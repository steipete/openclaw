#!/usr/bin/env python3
"""One hosted build variant; neither outcome is production repair proof."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

packet = Path(__file__).resolve().parent
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
manifest = json.loads((packet / "source-manifest.json").read_text())
variant = os.environ.get("PROOF_VARIANT")
assert variant in {"existing", "splitting"}
assert (
    os.environ.get("CI") == "1"
    and os.environ.get("PROOF_LANE") == "doctor-memory-" + variant
    and os.environ.get("PROOF_MODE") == "baseline"
    and sys.platform == "linux"
), "Expected the controller's isolated Linux build diagnostic"

def output(*args):
    return subprocess.check_output(args, text=True).strip()

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

assert output("git", "rev-parse", "HEAD") == manifest["base"]
assert output("git", "status", "--porcelain", "--untracked-files=no") == ""
assert output("node", "--version") == "v" + manifest["node"]
assert output("pnpm", "--version") == manifest["pnpm"]
selected = manifest["variants"][variant]
for name, sha in manifest["unchanged"].items():
    assert digest(name) == sha, name
for name, hashes in selected["files"].items():
    assert digest(name) == hashes["before"], name
patch = packet / selected["patch"]
assert digest(patch) == selected["sha256"]
subprocess.run(["git", "apply", "--check", str(patch)], check=True)
subprocess.run(["git", "apply", str(patch)], check=True)
for name, hashes in selected["files"].items():
    assert digest(name) == hashes["after"], name

command = [
    "node", "scripts/run-vitest.mjs", "run", "--config",
    "test/vitest/vitest.commands.config.ts",
    "src/commands/doctor-session-sqlite.memory.test.ts",
    "--reporter=verbose", "--reporter=json", "--outputFile=" + str(out / "tests.json"),
]
with (out / "diagnostic.log").open("wb") as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False)
text = re.sub(r"\x1b\[[0-9;]*m", "", (out / "diagnostic.log").read_text(errors="replace"))
build_path = Path(".artifacts/doctor-memory-build-diagnostic.json")
build = None
if build_path.is_file():
    shutil.copyfile(build_path, out / "bundle.json")
    build = json.loads(build_path.read_text())
report_path = out / "tests.json"
report = json.loads(report_path.read_text()) if report_path.is_file() else {}
cases = [case for suite in report.get("testResults", []) for case in suite.get("assertionResults", [])]
expected_names = [
    f"imports {scenario} transcripts and completes branch projections under a 256 MiB heap"
    for scenario in ("batch", "deep", "public")
]
case_shape = (
    len(report.get("testResults", [])) == 1
    and report.get("numTotalTests") == 3
    and [case.get("title") for case in cases] == expected_names
    and report["testResults"][0].get("message") == ""
    and report["testResults"][0].get("name", "").endswith("/src/commands/doctor-session-sqlite.memory.test.ts")
    and "Failed Suites" not in text
    and "Unhandled Errors" not in text
)
phases = []
for line in text.splitlines():
    start = line.find('{"doctorMemoryPhase":')
    if start < 0:
        continue
    try:
        row = json.JSONDecoder().raw_decode(line[start:])[0]
    except ValueError:
        continue
    if row.get("scenario") in {"batch", "deep", "public"}:
        phases.append(row)
scenario_pids = {
    scenario: sorted({row["pid"] for row in phases if row["scenario"] == scenario})
    for scenario in ("batch", "deep", "public")
}
gc_pids = sorted({
    int(pid)
    for pid in re.findall(r"\[(\d+):0x[0-9a-fA-F]+\]\s+\d+ ms: Mark-Compact", text)
})
build_shape = (
    isinstance(build, dict)
    and isinstance(build.get("metafile", {}).get("inputs"), dict)
    and bool(build.get("metafile", {}).get("outputs"))
    and all(
        build.get("outputSizes", {}).get(name) == metadata.get("bytes")
        for name, metadata in build.get("metafile", {}).get("outputs", {}).items()
    )
)
public_oom = (
    case_shape and build_shape
    and result.returncode != 0
    and [case.get("status") for case in cases] == ["passed", "passed", "failed"]
    and "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" in text
    and "SIGABRT" in text
    and "--max-old-space-size=256" in text
    and "seeded 1 sessions x 100000 events; importing" in text
    and re.search(r"\bTests\s+1 failed\s+\|\s+2 passed\s+\(3\)\s*$", text, re.MULTILINE)
    and len(scenario_pids["public"]) == 1
    and scenario_pids["public"] == gc_pids
)
completed = (
    case_shape and build_shape
    and result.returncode == 0
    and all(case.get("status") == "passed" for case in cases)
    and all(len(pids) == 1 for pids in scenario_pids.values())
    and all(any(
        row["scenario"] == scenario and row["doctorMemoryPhase"] == "fixture:rerun:after"
        for row in phases
    ) for scenario in ("batch", "deep", "public"))
    and not gc_pids
)
summary = {
    "variant": variant,
    "classification": "instrumented-public-child-oom" if public_oom else "completed-without-oom" if completed else "unclassified",
    "isFixProof": False,
    "source": manifest,
    "command": command,
    "exitCode": result.returncode,
    "caseShapeVerified": bool(case_shape),
    "buildShapeVerified": bool(build_shape),
    "cases": [{"fullName": case.get("fullName"), "title": case.get("title"), "status": case.get("status")} for case in cases],
    "phases": phases,
    "scenarioPids": scenario_pids,
    "gcPids": gc_pids,
    "logSha256": digest(out / "diagnostic.log"),
}
(out / "diagnostic-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
# Keep both rows visibly diagnostic; compare retained results, never a green badge.
sys.exit(result.returncode if result.returncode != 0 else 1)
