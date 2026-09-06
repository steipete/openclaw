import json
import pathlib
import re
import sys

report_path, log_path, exit_text, phase = sys.argv[1:]
report = json.loads(pathlib.Path(report_path).read_text())
log = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", pathlib.Path(log_path).read_text())
assert int(exit_text) == 1, "Expected exactly a failing assertion exit"
assert all(re.search(r"(?m)^\s*" + label + r"\s", log) for label in ["Test Files", "Tests", "Start at", "Duration"]), "No completed Vitest summary"
assert not re.search(r"Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites", log), "Runtime/hook failure is not expected red"
suites = report["testResults"]
assert len(suites) == 1 and not suites[0].get("message"), "Wrong suite or suite setup failed"
assert report["numFailedTests"] == 1 and report["numPassedTests"] == 0
checks = suites[0]["assertionResults"]
assert len(checks) == 1 and checks[0]["status"] == "failed", "Extra, skipped or missing assertions"
expected = {
    "runner": ("src/agents/embedded-agent-runner/run.silent-reply-prompt-mode.test.ts", "preserves none across the attempt boundary and omits generic silent-reply guidance"),
    "flow": ("test/e2e/qa-lab/runtime/silent-reply-prompt-mode.e2e.test.ts", "omits generic silence guidance in the actual provider request while replying normally"),
}
source, title = expected[phase]
assert suites[0]["name"].replace("\\", "/").endswith(source)
assert checks[0]["title"] == title
failures = checks[0].get("failureMessages", [])
assert len(failures) == 1, "Extra test/hook failures"
message = failures[0]
assert "AssertionError" in message
if phase == "runner":
    assert re.search(r"expected undefined to be ['\"]none['\"]", message), "Runner did not fail on missing forwarded mode"
else:
    assert "SILENT_REPLY_GUIDANCE_LEAK" in message, "Flow did not reach final provider prompt assertion"
    assert "expected true to be false" in message, "Provider prompt failure had wrong actual value"
pathlib.Path(report_path).with_suffix(".verdict.json").write_text(json.dumps({"phase": phase, "verdict": "EXPECTED_ASSERTION_FAILURE", "source": source, "test": title}, indent=2) + "\n")
print(f"{phase}: intended assertion failure verified")
