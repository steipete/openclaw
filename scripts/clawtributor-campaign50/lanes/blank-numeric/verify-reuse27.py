import hashlib
import json
import pathlib
import re
import sys

lane = pathlib.Path(sys.argv[1])
reuse = lane / "reuse-wave27"
lineage = json.loads((lane / "reuse-wave27-lineage.json").read_text())
manifest = json.loads((lane / "MANIFEST.json").read_text())
for name, expected in lineage["files"].items():
    assert hashlib.sha256((reuse / name).read_bytes()).hexdigest() == expected, name
run = json.loads((reuse / "run.json").read_text())
assert run["databaseId"] == lineage["run"]
assert run["headSha"] == lineage["harness"]
job = next(job for job in run["jobs"] if job["databaseId"] == lineage["job"])
assert job["status"] == "completed" and job["conclusion"] == "failure"
for owner in ("capability", "shared", "models"):
    assert (reuse / f"baseline-tests/{owner}.exit").read_text().strip() == "1"
for name in ("capability.json", "capability.log.txt", "capability.exit"):
    assert (reuse / "baseline-tests" / name).read_bytes() == (lane / "reuse-wave25/baseline-tests" / name).read_bytes()
assert lineage["prior_capability_run"] == json.loads((lane / "reuse-lineage.json").read_text())["run"]
assert lineage["source_base"] == manifest["base"]
assert hashlib.sha256((lane / "candidate.patch").read_bytes()).hexdigest() == lineage["candidate_patch_sha256"]
source = json.loads((reuse / "source.json").read_text())
assert source["source"] == manifest["base"]
assert source["node"] == manifest["node"]
assert source["packageManager"] == manifest["packageManager"]
before = json.loads((reuse / "source-baseline-before.json").read_text())
assert before == {"phase": "baseline", "base": manifest["base"], "node": manifest["node"], "pnpm": manifest["pnpm"], "source_hashes": "verified"}
old_manifest = json.loads((reuse / "manifest.json").read_text())
assert old_manifest["baseline_files"] == manifest["baseline_files"]
normalize = lambda text: re.sub(r"^index [0-9a-f]+\.\.[0-9a-f]+(?= |$)", "index HASH..HASH", text, flags=re.M)
assert normalize((reuse / "final-working-tree.patch").read_text()) == normalize((lane / "tests.patch").read_text())
print(json.dumps({"verdict": "source/lineage verified", "reused_run": lineage["run"], "prior_capability_run": lineage["prior_capability_run"], "stage": "all completed baseline unit reports; corrected strict readers still required"}))
