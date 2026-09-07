"""Run six ordered real diagnostic-owner cases in one isolated synthetic workspace."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from process_capture import cleanup_owned, run

repo = Path(sys.argv[1]).resolve()
lane = Path(__file__).resolve().parent
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
assert os.environ.get("CI") == "1" and sys.platform == "linux"
owned = Path(tempfile.mkdtemp(prefix="doctor-docs-137347-", dir=evidence))
home = owned / "home"
workspace = owned / "workspace"
state = owned / "state"
for p in [home, workspace, state, workspace / "packages/core"]:
    p.mkdir(parents=True, exist_ok=True)
config_path = owned / "openclaw.json"
env = {"PATH": os.environ["PATH"], "HOME": str(home), "CI": "1", "LANG": "C.UTF-8",
       "OPENCLAW_STATE_DIR": str(state), "OPENCLAW_CONFIG_PATH": str(config_path)}
node = shutil.which("node", path=env["PATH"])
assert node
cases = ["ignored-root", "recognized-root", "unfinished-bootstrap", "completed-bootstrap",
         "selected-bundled-extras", "disabled-extras"]
files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md", "CLAUDE.md",
         "packages/core/AGENTS.md", "packages/core/CLAUDE.md"]
for f in files:
    (workspace / f).write_text("a" * 100)
passed = False
try:
    for case in cases:
        if case == "ignored-root":
            (workspace / "CLAUDE.md").write_text("c" * 25000)
        elif case == "recognized-root":
            (workspace / "CLAUDE.md").write_text("c" * 100)
            (workspace / "AGENTS.md").write_text("a" * 25000)
        elif case == "unfinished-bootstrap":
            (workspace / "AGENTS.md").write_text("a" * 100)
            (workspace / "BOOTSTRAP.md").write_text("b" * 25000)
        elif case == "selected-bundled-extras":
            (workspace / "packages/core/AGENTS.md").write_text("e" * 25000)
            (workspace / "packages/core/CLAUDE.md").write_text("c" * 25000)
        cfg = {"agents": {"entries": {"proof": {"workspace": str(workspace)}}},
               "plugins": {"enabled": False},
               "hooks": {"internal": {"enabled": case == "selected-bundled-extras",
                 "entries": {"bootstrap-extra-files": {"enabled": True,
                     "paths": ["packages/core/AGENTS.md", "packages/core/CLAUDE.md"]}}}}}
        config_path.write_text(json.dumps(cfg) + "\n")
        inventory = [{"path": f, "bytes": (workspace/f).stat().st_size,
                      "sha256": hashlib.sha256((workspace/f).read_bytes()).hexdigest()} for f in files]
        (evidence / (case + "-fixture.json")).write_text(json.dumps(inventory, indent=2) + "\n")
        run([node, "--import", str(repo / "scripts/tsx.mjs"), str(lane / "doctor-case.mts"),
             str(repo), str(workspace), str(evidence), case], repo, env, evidence, case, 60)
        assert json.loads((evidence / (case + "-verdict.json")).read_text()) == {"passed": True, "caseId": case}
        assert json.loads((evidence / (case + "-db-close.json")).read_text())["completed"] is True
        assert inventory == [{"path": f, "bytes": (workspace/f).stat().st_size,
                              "sha256": hashlib.sha256((workspace/f).read_bytes()).hexdigest()} for f in files]
    passed = True
finally:
    cleanup_owned(owned, evidence)
if passed:
    (evidence / "verdict.json").write_text(json.dumps({"passed": True, "cases": cases,
        "proofKind": "real diagnostic owner", "fullCLI": False, "memoryPluginsEnabled": False,
        "currentOnlyHookSelection": True, "stableExecution": False}) + "\n")
