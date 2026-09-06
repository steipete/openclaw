import base64
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile

target, lane, evidence = map(pathlib.Path, sys.argv[1:4])
phase = sys.argv[4]
assert phase in ("baseline", "candidate")
cases = json.loads((lane / "cli-cases.json").read_text())
evidence.mkdir(parents=True, exist_ok=True)
observations = []
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

with tempfile.TemporaryDirectory(prefix="blank-numeric-") as owned:
    owned = pathlib.Path(owned)
    fixture = owned / "image.png"
    fixture.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII="))
    for case in cases:
        state = owned / case["id"]
        for name in ("state", "home", "config", "cache", "data", "tmp"):
            (state / name).mkdir(parents=True)
        config = state / "config" / "openclaw.json"
        config_before = digest(config)
        env = {
            **os.environ,
            "OPENCLAW_STATE_DIR": str(state / "state"),
            "OPENCLAW_HOME": str(state / "home"),
            "OPENCLAW_CONFIG_PATH": str(config),
            "XDG_CONFIG_HOME": str(state / "config"),
            "XDG_CACHE_HOME": str(state / "cache"),
            "XDG_DATA_HOME": str(state / "data"),
            "TMPDIR": str(state / "tmp"),
        }
        argv = ["node", "openclaw.mjs", *[value.replace("{fixture}", str(fixture)) for value in case["argv"]]]
        log = evidence / (case["id"] + ".log")
        (evidence / (case["id"] + ".argv.json")).write_text(json.dumps(argv) + "\n")
        with log.open("wb") as output:
            process = subprocess.Popen(argv, cwd=target, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=240)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise
        text = ansi.sub("", log.read_text())
        matches = list(re.finditer(r'^\{\n\s*"ok":', text, re.M))
        config_after = digest(config)
        row = {"id": case["id"], "phase": phase, "argv": argv, "exit": code, "log_sha256": digest(log), "config_before": config_before, "config_after": config_after}
        observations.append(row)
        (evidence / "observations.json").write_text(json.dumps(observations, indent=2) + "\n")
        assert code == 1, row
        assert config_after == config_before, row
        assert len(matches) == 1, row
        result, _ = json.JSONDecoder().raw_decode(text[matches[0].start():])
        assert result["ok"] is False and result["error"]["type"] == "cli_error", result
        message = result["error"]["message"]
        row["message"] = message
        row["expected"] = case[phase]
        (evidence / "observations.json").write_text(json.dumps(observations, indent=2) + "\n")
        assert message.startswith(case[phase]), row
        if case["baseline"] != case["candidate"]:
            assert not message.startswith(case["candidate" if phase == "baseline" else "baseline"]), row
        print(json.dumps({"id": case["id"], "phase": phase, "exit": code, "expected_error": case[phase], "config_unchanged": True}), flush=True)

assert len(observations) == len(cases)
(evidence / "verdict.json").write_text(json.dumps({"phase": phase, "verdict": "PASS", "cases": len(cases), "config_unchanged": True, "proof": "actual root CLI parser-versus-downstream errors; no successful provider call claimed"}, indent=2) + "\n")
