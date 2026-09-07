import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
exit_code = int(sys.argv[2])
assert exit_code == 0, f"Expected candidate exit 0, got {exit_code}"
records = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines() if line.strip()]
assert records and all(type(record.get("version")) is int and record["version"] == 0 for record in records), "Unsupported event ABI"
functions = {
    record["payload"]["id"]: record["payload"]["name"].removesuffix("()")
    for record in records
    if record.get("kind") == "test"
    and record["payload"].get("kind") == "function"
    and record["payload"].get("sourceLocation", {}).get("fileID", "").endswith("/CLIInstallerSelectionProofTests.swift")
}
expected = {"discoveryInspection", "emptyInspection", "updateSuccess", "updateRejected"}
assert len(functions) == 4 and set(functions.values()) == expected, functions
assert len(set(functions.values())) == 4
for record in records:
    if record.get("kind") == "test" and record["payload"].get("id") in functions:
        assert record["payload"].get("isParameterized") is False
all_events = [record["payload"] for record in records if record.get("kind") == "event"]
assert sum(event["kind"] == "runStarted" for event in all_events) == 1
assert sum(event["kind"] == "runEnded" for event in all_events) == 1
assert all_events[-1]["kind"] == "runEnded", "Incomplete native test run"
assert not any(event["kind"] in {"testSkipped", "testCancelled", "testCaseCancelled"} for event in all_events)
for kind in ("testStarted", "testEnded"):
    seen = [event.get("testID") for event in all_events if event["kind"] == kind and event.get("testID") in functions]
    assert len(seen) == 4 and set(seen) == set(functions), (kind, seen)
# No other function may execute under the exact filter.
test_records = {record["payload"]["id"]: record["payload"] for record in records if record.get("kind") == "test"}
for event in all_events:
    if event["kind"] in {"testStarted", "testEnded"} and event.get("testID") not in functions:
        suite = test_records[event["testID"]]
        assert suite["kind"] == "suite" and suite["name"] == "CLIInstallerSelectionProofTests", event
issues = [event for event in all_events if event["kind"] == "issueRecorded"]
assert issues == [], issues
log = (root / "native.log").read_text()
assert "[macos-native] retained resources" not in log
assert not any("[macos-native] security " in line and "failed" in line for line in log.splitlines())
prefix = "MANAGED_CLI_SELECTION_PROOF "
observations = [json.loads(line.split(prefix, 1)[1]) for line in log.splitlines() if prefix in line]
assert len(observations) == 4 and {row["case"] for row in observations} == expected
assert all(row["fixturesRemoved"] is True and row["foundationHomeMatches"] is True and row["expectedGatewayVersionNil"] is True for row in observations)
for row in observations:
    assert not pathlib.Path(row["launcherHome"]).exists(), "Canonical native launcher did not reclaim its disposable home"
    assert row["matches"] is True and row["actual"] == row["expected"]
    if row["case"] == "emptyInspection":
        assert row["actual"] == {"executable": "", "version": ""}
    else:
        assert row["actual"]["executable"].startswith(row["launcherHome"] + "/")
        assert row["actual"]["resolved"] == row["actual"]["executable"]
        if row["case"] == "updateSuccess":
            assert row["actual"]["version"] == "2026.9.1"
            assert row["actual"]["executable"].endswith("/.openclaw/bin/openclaw")
        else:
            assert row["actual"]["version"] == "2026.9.2"
            assert row["actual"]["executable"].endswith("/campaign140131-external/bin/openclaw")
(root / "verdict.json").write_text(json.dumps({"verdict": "CANDIDATE_SELECTION_PASSED", "selectedTests": 4, "expectedFailures": 0, "passingCases": 4, "observations": observations}, indent=2) + "\n")
print("MANAGED_SELECTION_CANDIDATE_CONFIRMED")
