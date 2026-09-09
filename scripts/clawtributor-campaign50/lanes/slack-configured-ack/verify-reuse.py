import hashlib
import json
from pathlib import Path
import sys

lane = Path(sys.argv[1])
reuse = lane / "reuse-unit"
lineage = json.loads((reuse / "LINEAGE.json").read_text())
assert (lineage["run"], lineage["job"], lineage["harness"]) == (
    34296547260, 102294347434, "f607f0a30faf78aa694ef45e7104e69b875966fa"
)
assert lineage["overall_run"] == "FAILURE"
assert lineage["packet"] == "b77fc26ddb7b8b8bec02ad03732e170433ffdcec3488c792d84d693aa4df78b2"
for name, digest in lineage["files"].items():
    assert hashlib.sha256((reuse / name).read_bytes()).hexdigest() == digest, name
assert lineage["files"]["manifest.json"] == lineage["packet"]
current = json.loads((lane / "source.json").read_text())
prior = json.loads((reuse / "slack-ack-source.json").read_text())
assert current["base"] == prior["base"] == lineage["source"]
old_manifest = json.loads((reuse / "manifest.json").read_text())
for name, original in [("slack-ack-source.json", "source.json"), ("ack-ingress.proof.test.ts", "ack-ingress.proof.test.ts"), ("candidate.patch", "candidate.patch")]:
    assert lineage["files"][name] == old_manifest["files"][original], name
expected = dict(prior["baseline"])
expected[prior["unit_path"]] = prior["candidate"][prior["unit_path"]]
for name, digest in prior["baseline"].items():
    assert current["baseline"][name] == digest, name
assert current["candidate"] == prior["candidate"]
for name in ["source-baseline-before.json", "baseline-unit.source.json"]:
    receipt = json.loads((reuse / name).read_text())
    assert receipt["head"] == lineage["source"]
    assert receipt["phase"] == "baseline"
    assert receipt["files"] == expected
    assert receipt["node"] == "24.20.0"
    assert receipt["packageManager"] == current["packageManager"]
    assert receipt["sdk"] == current["sdkFiles"]
assert (reuse / "candidate.patch").read_bytes() == (lane / "candidate.patch").read_bytes()
assert (reuse / "baseline-unit.exit").read_text().strip() == "1"
print(json.dumps({"run": lineage["run"], "scope": "baseline-unit-only", "source": lineage["source"], "lineage": "PASS"}))
