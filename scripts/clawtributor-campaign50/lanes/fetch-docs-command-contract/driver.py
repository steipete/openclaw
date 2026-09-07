"""Secretless, URL-free Fetch command/stdio proof; execute only on the admitted worker."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
from process_capture import CapturedChild, cleanup_owned, run

lane = Path(__file__).resolve().parent
evidence = Path(sys.argv[1]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
assert os.environ.get("CI") == "1"
assert sys.platform == "linux" and platform.machine() == "x86_64"
assert sys.version_info[:2] == (3, 12)
owned = Path(tempfile.mkdtemp(prefix="fetch-docs-141189-", dir=evidence))
home = owned / "home"
home.mkdir()
env = {"PATH": os.environ["PATH"], "HOME": str(home), "CI": "1", "LANG": "C.UTF-8"}
(evidence / "admission.json").write_text(json.dumps({"python": sys.version,
    "platform": platform.platform(), "environmentKeys": sorted(env),
    "fixture": str(owned), "fetchCalls": 0}, indent=2) + "\n")
passed = False
try:
    wheels = owned / "wheels"
    wheels.mkdir()
    for name in ["uv", "requirements"]:
        run([sys.executable, "-m", "pip", "download", "--isolated", "--no-deps", "--only-binary=:all:",
             "--require-hashes", "--index-url", "https://pypi.org/simple", "--dest", str(wheels),
             "-r", str(lane / (name + ".txt"))], owned, env, evidence, "download-" + name, 180)
    # Wheel-only, hashed acquisition is the only network phase. Runtime has no URL input.
    wheel_inventory = [{"file": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                       for p in sorted(wheels.glob("*.whl"))]
    (evidence / "wheels.json").write_text(json.dumps(wheel_inventory, indent=2) + "\n")
    assert any(x["sha256"] == "6642df733a1032e7f37d0f13849af8a944d46c02420d2c070cc14e0948f8fcc2"
               for x in wheel_inventory)
    uv_root = owned / "uv"
    run([sys.executable, "-m", "pip", "install", "--isolated", "--no-deps", "--no-index",
         "--find-links", str(wheels), "--require-hashes", "--target", str(uv_root),
         "-r", str(lane / "uv.txt")], owned, env, evidence, "install-uv", 60)
    uv = uv_root / "bin" / "uv"
    uvx = uv_root / "bin" / "uvx"
    assert uv.is_file() and uvx.is_file()
    assert run([str(uv), "--version"], owned, env, evidence, "uv-version").decode().startswith("uv 0.12.10")
    env.update({"UV_OFFLINE": "1", "UV_NO_INDEX": "1", "UV_FIND_LINKS": str(wheels),
                "UV_CONSTRAINT": str(lane / "requirements.txt"), "UV_NO_BUILD": "1",
                "UV_NO_CONFIG": "1", "UV_NO_ENV_FILE": "1", "UV_PYTHON_DOWNLOADS": "never",
                "UV_PYTHON": sys.executable, "UV_CACHE_DIR": str(owned / "cache"),
                "UV_TOOL_DIR": str(owned / "tools"), "UV_KEYRING_PROVIDER": "disabled"})
    inventory_code = "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()},sort_keys=True))"
    inventory = json.loads(run([str(uvx), "--from", "mcp-server-fetch", "python", "-c", inventory_code],
                               owned, env, evidence, "distribution-inventory", 120))
    expected = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)",
                              (lane / "requirements.txt").read_text(), re.MULTILINE))
    assert expected and len(expected) == 43
    assert inventory == {name.lower().replace("_", "-"): version for name, version in expected.items()}
    assert inventory["mcp"] == "1.29.0" and inventory["mcp-server-fetch"] == "2026.8.18"
    help_text = run([str(uvx), "mcp-server-fetch", "--help"], owned, env, evidence, "console-help", 60).decode()
    assert "usage:" in help_text and "--user-agent" in help_text and "--proxy-url" in help_text
    child = CapturedChild([str(uvx), "mcp-server-fetch"], owned, env, evidence, "stdio")
    sent = []
    def send(message):
        sent.append(message)
        (evidence / "sent.json").write_text(json.dumps(sent, indent=2) + "\n")
        child.send(message)
    def messages():
        raw = bytes(child.buffers["stdout"])
        return [json.loads(line) for line in raw.split(b"\n")[:-1] if line]
    def response(number):
        matches = [m for m in messages() if m.get("id") == number]
        assert len(matches) <= 1
        return matches[0] if matches else None
    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "openclaw-docs-command-proof", "version": "1.0.0"}}})
        child.pump_until(lambda: response(1) is not None, 60)
        initialized = response(1)
        assert initialized.get("jsonrpc") == "2.0" and "error" not in initialized
        assert initialized["result"]["protocolVersion"] == "2025-11-25"
        assert initialized["result"]["serverInfo"]["name"] == "mcp-fetch"
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        child.pump_until(lambda: response(2) is not None, 60)
        listed = response(2)
        assert listed.get("jsonrpc") == "2.0" and "error" not in listed
        tools = listed["result"]["tools"]
        assert len(tools) == 1 and tools[0]["name"] == "fetch"
        assert "url" in tools[0]["inputSchema"]["required"]
        child.finish(60)
        assert [m["method"] for m in sent] == ["initialize", "notifications/initialized", "tools/list"]
        assert len(messages()) == 2 and not bytes(child.buffers["stdout"]).split(b"\n")[-1]
        (evidence / "received.json").write_text(json.dumps(messages(), indent=2) + "\n")
    finally:
        child.cleanup_failure()
    passed = True
finally:
    # Raw receipts live outside the owned install/cache tree and survive failure cleanup.
    cleanup_owned(owned, evidence)
if passed:
    (evidence / "verdict.json").write_text(json.dumps({"passed": True, "package": "mcp-server-fetch==2026.8.18",
        "sdk": "mcp==1.29.0", "command": ["uvx", "mcp-server-fetch"], "constraintControlled": True,
        "cases": ["distribution-inventory", "console-help", "stdio-initialize-list", "normal-cleanup"],
        "fetchToolCalls": 0, "promptGetCalls": 0, "runtimeURLInputs": 0}) + "\n")
