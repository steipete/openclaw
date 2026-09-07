"""Pure fake-process/OS/time checks. Never creates, signals, or runs a process."""
import signal
import subprocess
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

from phase import SOURCE, drain_process_group, main as phase_main


class FakeProcess:
    pid = 4242

    def __init__(self, behavior):
        self.behavior = behavior
        self.returncode = None
        self.group_exists = behavior != "already-gone"
        self.signals = []
        self.clock = 0

    def poll(self):
        if self.behavior == "poll-error":
            raise OSError("synthetic wait failure")
        if self.behavior != "unreaped" and (self.signals or not self.group_exists):
            self.returncode = 0
        return self.returncode

    def killpg(self, pgid, operation):
        assert pgid == self.pid
        if self.behavior == "permission" or (self.behavior == "probe-permission" and operation == 0):
            raise PermissionError("synthetic permission failure")
        if not self.group_exists:
            raise ProcessLookupError("synthetic absent group")
        if operation != 0:
            self.signals.append(operation)
        if self.behavior in {"term-cleans", "unreaped"} and operation == signal.SIGTERM:
            self.group_exists = False
        if self.behavior == "leader-exits-descendant-stays" and operation == signal.SIGKILL:
            self.group_exists = False

    def sleep(self, seconds):
        self.clock += seconds


def check(behavior):
    process = FakeProcess(behavior)
    with patch("phase.os.killpg", process.killpg), patch("phase.time.monotonic", lambda: process.clock), \
            patch("phase.time.sleep", process.sleep):
        return process, drain_process_group(process)


process, result = check("leader-exits-descendant-stays")
assert result["gone"] and process.signals == [signal.SIGTERM, signal.SIGKILL]
assert 5 <= process.clock < 5.1 and result["leaderExitCode"] == 0
process, result = check("term-cleans")
assert result["gone"] and process.signals == [signal.SIGTERM]
process, result = check("already-gone")
assert result["gone"] and process.signals == []
process, result = check("persistent")
assert not result["gone"] and process.signals == [signal.SIGTERM, signal.SIGKILL]
assert 10 <= process.clock < 10.2
for behavior in ("permission", "probe-permission", "unreaped"):
    _, result = check(behavior)
    assert result["gone"] is False and result["error"]
try:
    check("poll-error")
except OSError:
    pass
else:
    raise AssertionError("Unexpected poll error was swallowed")

class TerminalProcess(FakeProcess):
    def __init__(self, behavior, outcome):
        super().__init__(behavior)
        self.outcome = outcome

    def wait(self, timeout):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        self.returncode = self.outcome
        return self.returncode

    def poll(self):
        if self.behavior == "poll-error":
            raise OSError("synthetic wait failure")
        if self.returncode is None and (self.signals or not self.group_exists):
            self.returncode = -15
        return self.returncode


cases = [
    ("already-gone", 0, True),
    ("persistent", 0, False),
    ("already-gone", 65, True),
    ("persistent", 65, False),
    ("leader-exits-descendant-stays", -9, True),
    ("persistent", -9, False),
    ("term-cleans", subprocess.TimeoutExpired("synthetic", 120), True),
    ("persistent", subprocess.TimeoutExpired("synthetic", 120), False),
    ("term-cleans", KeyboardInterrupt("synthetic interruption"), True),
    ("permission", KeyboardInterrupt("synthetic interruption"), False),
    ("term-cleans", ValueError("synthetic unexpected wait error"), True),
    ("persistent", ValueError("synthetic unexpected wait error"), False),
    ("poll-error", 0, False),
    ("spawn-failure", None, False),
]
for behavior, outcome, expected_safe in cases:
    with TemporaryDirectory(prefix="composer-wait-model-") as temporary:
        root = Path(temporary)
        evidence = root / "evidence"
        environment = {
            "CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_OS": "macOS",
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_TEMP": temporary,
            "SOURCE_SHA": SOURCE, "PROOF_VARIANT": "composer-order-comparison",
        }
        arguments = ["phase.py", str(root / "synthetic-target"), str(Path(__file__).parent), str(evidence), "baseline"]
        process = TerminalProcess(behavior, outcome)
        def fake_spawn(*args, **kwargs):
            if behavior == "spawn-failure":
                raise FileNotFoundError("synthetic spawn failure")
            return process
        with patch.object(sys, "argv", arguments), patch.dict("phase.os.environ", environment), \
                patch("phase.subprocess.Popen", side_effect=fake_spawn) as spawn, \
                patch("phase.os.killpg", process.killpg), patch("phase.time.monotonic", lambda: process.clock), \
                patch("phase.time.sleep", process.sleep):
            try:
                result = phase_main()
            except KeyboardInterrupt:
                result = 130
        receipt = json.loads((evidence / "receipt.json").read_text())
        assert result in (1, 130) and spawn.call_count == 1
        assert receipt["commandGroupRetirementVerified"] is expected_safe, (behavior, outcome)
        assert bool(receipt.get("cleanupIncomplete")) is not expected_safe
        retirement = receipt["commands"][0]["groupRetirement"]
        assert retirement["gone"] is expected_safe
        assert retirement["pgid"] == (None if behavior == "spawn-failure" else 4242)
        if isinstance(outcome, int) and expected_safe:
            assert retirement["leaderExitCode"] == outcome
        if behavior == "leader-exits-descendant-stays":
            assert process.signals == [signal.SIGTERM, signal.SIGKILL]
        if not expected_safe:
            assert receipt["resourcesRetained"]["unprovenGroups"] == [retirement]
        assert len(receipt["commands"]) == 1 and not receipt["finalBindingVerified"]
print("22 fake group/terminal-path cases passed; no process or target execution")
