"""Join exact fixture/diagnostic content, per-file outcomes and all original child receipts."""
import hashlib
import json
from pathlib import Path
import sys

r = Path(sys.argv[1])
load = lambda p: json.loads((r / p).read_text())
assert load("input-receipt.json") == load("input-after-receipt.json")
cases = ["ignored-root", "recognized-root", "unfinished-bootstrap", "completed-bootstrap", "selected-bundled-extras", "disabled-extras"]
assert load("verdict.json")["cases"] == cases and load("verdict.json")["passed"]
cleanup = load("cleanup.json")
assert cleanup["absent"] and not cleanup["retained"] and cleanup["spawnRecords"] == 6
for case in cases:
    o = load(case + ".outcome.json")
    assert o["spawned"] and o["reaped"] and o["quiescent"] and o["exitCode"] == 0
    assert not o["forcedSignals"] and o["pipeEOF"] and o["processGroupGone"]
    for stream in ["stdout", "stderr"]:
        assert (r / (case + "." + stream)).stat().st_size == o["bytes"][stream] <= 1048576
    assert load(case + "-db-close.json") == {"completed": True, "sharedOpen": False}
    assert load(case + "-memory.json")["status"] == "unavailable"
    selection = load(case + "-selection.json")
    assert selection["selected"]["source"] == "openclaw-bundled"
    assert selection["loadable"] == (case == "selected-bundled-extras")
    observed = load(case + "-raw.json")
    fixture = {x["path"]: x for x in load(case + "-fixture.json")}
    bootstrap = {x["path"]: x for x in observed["bootstrap"]}
    context = {x["path"]: x for x in observed["context"]}
    assert len(bootstrap) == len(observed["bootstrap"])
    assert len(context) == len(observed["context"])
    for relative, file in bootstrap.items():
        assert relative in fixture and not file["missing"]
        assert file["rawChars"] == fixture[relative]["bytes"]
        assert file["contentSha256"] == fixture[relative]["sha256"]
    assert "AGENTS.md" in bootstrap and all(Path(p).name != "CLAUDE.md" for p in bootstrap)
    assert all(p in bootstrap for p in context)
    assert ("packages/core/AGENTS.md" in bootstrap) == (case == "selected-bundled-extras")
    if case in ["completed-bootstrap", "selected-bundled-extras", "disabled-extras"]:
        assert "BOOTSTRAP.md" not in bootstrap
        assert fixture["BOOTSTRAP.md"]["bytes"] == 25000
        assert observed["completion"]["setup"]["setupCompletedAt"] == "2026-09-01T00:01:00.000Z"
    large = {"recognized-root": "AGENTS.md", "unfinished-bootstrap": "BOOTSTRAP.md", "selected-bundled-extras": "packages/core/AGENTS.md"}.get(case)
    if large:
        assert bootstrap[large]["rawChars"] == 25000
        workspace = Path(cleanup["path"]) / "workspace"
        analyzed = [x for x in observed["analysis"]["files"] if Path(x["path"]) == workspace / large]
        assert len(analyzed) == 1
        item = analyzed[0]
        assert item["rawChars"] == 25000 and item["truncated"]
        assert "per-file-limit" in item["causes"]
        assert 0 < item["injectedChars"] <= observed["limits"]["bootstrapMaxChars"]
        assert context[large]["chars"] == item["injectedChars"]
        assert observed["analysis"]["hasTruncation"]
    else:
        assert not observed["analysis"]["hasTruncation"]
    if case != "recognized-root":
        expected_small = hashlib.sha256(b"a" * 100).hexdigest()
        assert bootstrap["AGENTS.md"]["contentSha256"] == expected_small
        assert bootstrap["AGENTS.md"]["rawChars"] == 100
        assert context["AGENTS.md"]["chars"] == 100
        assert context["AGENTS.md"]["contentSha256"] == expected_small
    assert load(case + "-verdict.json") == {"passed": True, "caseId": case}
print(json.dumps({"accepted": True, "cases": cases, "joinedProcesses": 6,
                  "fullCLI": False, "stableExecution": False, "memoryPluginsEnabled": False}))
