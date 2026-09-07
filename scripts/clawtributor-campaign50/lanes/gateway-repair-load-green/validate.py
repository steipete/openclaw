import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
assert int(sys.argv[2]) == 0, "Expected all six verification contracts to pass"
data = json.loads((root / "behavior.json").read_text())
assert data["complete"] is True and data["cleanupComplete"] is True and data["failures"] == []
expected = {f"{action}-{fault}" for action in ["start", "restart"] for fault in ["throw", "false", "healthy"]}
assert len(data["cases"]) == 6 and {case["id"] for case in data["cases"]} == expected
assert all(case["contractViolated"] is False for case in data["cases"])
for case in data["cases"]:
    assert case["readiness"] == [200, 200]
    assert case["unitBefore"] != case["unitAfter"]
    assert case["postInstallProbes"] > 0
    value = case["cli"]["value"]
    if case["fault"] == "healthy":
        assert case["cli"]["code"] == 0 and value["ok"] is True
        assert value["result"] == {"start": "started", "restart": "restarted"}[case["action"]]
        assert re.search(r"Gateway service definition repaired and (?:restarted|started)", value.get("message", ""))
        assert value["service"]["loaded"] is True
    else:
        assert case["cli"]["code"] == 1 and value["ok"] is False
        assert "result" not in value and "message" not in value and "service" not in value
        assert value["error"].startswith("Gateway repair failed:")
        assert ("Permission denied: campaign post-install inspection" if case["fault"] == "throw" else "not loaded after repair") in value["error"]
    assert case["contractViolated"] is False
    assert case["canonicalIdentity"] is True
    assert re.fullmatch(r"campaign139145-(?:start|restart)-(?:throw|false|healthy)-[a-f0-9]{8}", case["profile"])
    path = root / case["id"]
    cleanup = json.loads((path / "cleanup.json").read_text())
    assert cleanup["profile"] == case["profile"] and cleanup["canonicalIdentity"] is True
    assert cleanup["gatewayJoined"] is True and cleanup["cliJoined"] is True
    assert cleanup["retainedState"] is False
    assert cleanup["profileRemoved"] is True and cleanup["unitRemoved"] is True and cleanup["errors"] == []
    for name in ["seed-install", "action"]:
        process = json.loads((path / (name + ".process.json")).read_text())
        assert process["closed"] is True and process["groupGone"] is True
        assert process["timedOut"] is False and process["forcedCleanup"] is False and process["spawnError"] is None
        assert process["signal"] is None
        assert process["code"] == (1 if name == "action" and case["fault"] != "healthy" else 0)
        assert process["outputBytes"] <= 4 * 1024 * 1024
    assert json.loads((path / "action.stdout").read_text()) == case["cli"]["value"]
    assert json.loads((path / "manager-errors.json").read_text()) == []
    calls = json.loads((path / "native-calls.json").read_text())
    activations = [i for i, call in enumerate(calls) if call.get("event") == "activation-complete" and call["armed"]]
    assert len(activations) == 1
    activation = activations[0]
    assert calls[activation]["unitSha256"] == case["unitAfter"]
    commands = [call for call in calls[:activation] if call.get("bin") == "systemctl"]
    for command in ["daemon-reload", "enable"]:
        assert any(command in call["args"] and call["code"] == 0 for call in commands)
    probes = [call for call in calls[activation + 1:] if call.get("bin") == "systemctl" and "is-enabled" in call["args"]]
    assert len(probes) == case["postInstallProbes"]
    assert all(call["postActivation"] and call["unitSha256"] == case["unitAfter"] for call in probes)
    if case["fault"] == "throw":
        assert any(call["code"] == 1 and call["stderr"] == "Permission denied: campaign post-install inspection" for call in probes)
    elif case["fault"] == "false":
        assert any(call["code"] == 1 and call["stdout"].strip() == "disabled" for call in probes)
    else:
        assert all(call["code"] == 0 and call["stdout"].strip() == "enabled" for call in probes)
assert "POST_INSTALL_VERIFICATION_CONTRACT_PASSED" in (root / "driver.log").read_text()
assert "POST_INSTALL_PROBE_FALSE_SUCCESS" not in (root / "driver.log").read_text()
(root / "verdict.json").write_text(json.dumps({"verdict": "CANDIDATE_VERIFICATION_PASSED", "cases": 6, "contractViolations": 0, "healthyControls": 2, "realGatewayReadiness": True, "nativeManager": "simulated command boundary, actual install file effects and parsers", "cleanupComplete": True}, indent=2) + "\n")
print("POST_INSTALL_CANDIDATE_CONFIRMED")
