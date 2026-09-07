"""Independently join retained command outcomes and the URL-free transcript."""
import json
import re
from pathlib import Path
import sys

r = Path(sys.argv[1])
load = lambda p: json.loads((r / p).read_text())
assert load("input-receipt.json") == load("input-after-receipt.json")
v = load("verdict.json")
assert v["passed"] and v["fetchToolCalls"] == v["promptGetCalls"] == v["runtimeURLInputs"] == 0
assert v["sdk"] == "mcp==1.29.0" and v["package"] == "mcp-server-fetch==2026.8.18"
assert load("cleanup.json")["absent"] and not load("cleanup.json")["retained"]
lock = Path(__file__).with_name("requirements.txt").read_text()
expected = {name.lower().replace("_", "-"): version for name, version in re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", lock, re.MULTILINE)}
assert len(expected) == 43
assert load("distribution-inventory.stdout") == expected
names = ["download-uv", "download-requirements", "install-uv", "uv-version", "distribution-inventory", "console-help", "stdio"]
for name in names:
    o = load(name + ".outcome.json")
    assert o["spawned"] and o["reaped"] and o["quiescent"] and o["exitCode"] == 0 and not o["forcedSignals"] and o["pipeEOF"] and o["processGroupGone"]
    for stream in ["stdout", "stderr"]:
        assert (r / (name + "." + stream)).stat().st_size == o["bytes"][stream] <= 1048576
sent = load("sent.json")
assert [m["method"] for m in sent] == ["initialize", "notifications/initialized", "tools/list"]
assert [m.get("id") for m in sent] == [1, None, 2]
assert sent[0]["params"]["protocolVersion"] == "2025-11-25"
received = load("received.json")
assert len(received) == 2 and [m["id"] for m in received] == [1, 2]
assert all(m["jsonrpc"] == "2.0" and "error" not in m for m in received)
assert received[0]["result"]["protocolVersion"] == "2025-11-25"
assert received[0]["result"]["serverInfo"]["name"] == "mcp-fetch"
assert [t["name"] for t in received[1]["result"]["tools"]] == ["fetch"]
raw = (r / "stdio.stdout").read_text()
assert raw.endswith("\n") and [json.loads(line) for line in raw.splitlines()] == received
assert "url" in received[1]["result"]["tools"][0]["inputSchema"]["required"]
assert "--user-agent" in (r / "console-help.stdout").read_text()
print(json.dumps({"accepted": True, "joinedProcesses": names, "fetchCalls": 0,
                  "protocol": received[0]["result"]["protocolVersion"],
                  "serverInfo": received[0]["result"]["serverInfo"]}))
