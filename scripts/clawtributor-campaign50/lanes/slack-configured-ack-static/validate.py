import json
from pathlib import Path
import re
import sys

lane, evidence = map(Path, sys.argv[1:3])
s = json.loads((lane / "source.json").read_text())
assert (evidence / "changed-checks.exit").read_text().strip() == "0"
log = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", (evidence / "changed-checks.log").read_text())
assert not re.search(r"\[check:changed\] (?:FAILED|no changed paths|delegating)|skipping sparse|sparse-missing|skipping missing|out of memory|Segmentation fault|^Killed|ETIMEDOUT|cleanup.*(?:failed|unverified)|retained temporary|Some tests are still running", log, re.I | re.M)
assert log.count("[check:changed] summary") == 1
summary = log.split("[check:changed] summary", 1)[1]
rows = re.findall(r"^\s*\d+(?:\.\d+)?(?:ms|s)\s+(\S+)\s+(.+?)\s*$", summary, re.M)
assert rows and all(status == "ok" for status, _ in rows)
names = [name for _, name in rows]
assert len(set(names)) == len(names)
for required in ["conflict markers", "doctor deprecation registry", "typecheck extensions", "typecheck extension tests", "lint extension changed files", "doctor contract declaration + closure guard tests"]:
    assert required in names, required
for name in names:
    assert log.count("[check:changed] " + name + "\n") == 1, name
for phase in ["before", "patched", "after"]:
    d = json.loads((evidence / ("source-" + phase + ".json")).read_text())
    expected = dict(s["baseline"])
    if phase != "before": expected.update(s["candidate"])
    assert d["files"] == expected
    assert d["base"] == s["base"] and d["committedHead"] == s["committedHead"]
    assert d["stagedTree"] == (s["sourceTree"] if phase == "before" else s["committedTree"])
print(json.dumps({"canonicalChangedChecks": "PASS", "base": s["base"], "committedHead": s["committedHead"], "committedTree": s["committedTree"], "checks": names, "slackBehaviorTestsRepeated": False, "canonicalDoctorAuditCases": 6}, indent=2))
