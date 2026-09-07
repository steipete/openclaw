import collections
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
assert int(sys.argv[2]) == 0, "Native unit command failed"
records = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines() if line.strip()]
assert records and all(type(row.get("version")) is int and row["version"] == 0 for row in records)
definitions = [row["payload"] for row in records if row["kind"] == "test"]
tests = {test["id"]: test for test in definitions}
assert len(tests) == len(definitions), "Duplicate test identities"
functions = {key: test for key, test in tests.items() if test["kind"] == "function"}
expected_files = {
    "CLIInstallerSelectionTests.swift", "CLIInstallerTests.swift", "CommandResolverTests.swift",
    "AppProfileTests.swift", "RuntimeLocatorTests.swift",
}
assert functions
assert {test["sourceLocation"]["fileID"].rsplit("/", 1)[-1] for test in functions.values()} == expected_files
events = [row["payload"] for row in records if row["kind"] == "event"]
assert sum(event["kind"] == "runStarted" for event in events) == 1
assert sum(event["kind"] == "runEnded" for event in events) == 1
assert events[-1]["kind"] == "runEnded", "Incomplete native unit run"
assert not any(event["kind"] in {"issueRecorded", "testSkipped", "testCancelled", "testCaseCancelled"} for event in events)
assert any(message["symbol"] == "pass" for message in events[-1]["messages"])
starts = collections.Counter()
ends = collections.Counter()
case_starts = collections.Counter()
case_ends = collections.Counter()
for event in events:
    kind = event["kind"]
    if kind in {"testStarted", "testEnded", "testCaseStarted", "testCaseEnded"}:
        identity = event["testID"]
        assert identity in tests, "Unknown test executed"
        if kind == "testStarted":
            starts[identity] += 1
        elif kind == "testEnded":
            ends[identity] += 1
            assert ends[identity] <= starts[identity]
        elif kind == "testCaseStarted":
            assert identity in functions and functions[identity]["isParameterized"] is True
            case_starts[identity] += 1
        else:
            assert identity in functions and functions[identity]["isParameterized"] is True
            case_ends[identity] += 1
            assert case_ends[identity] <= case_starts[identity]
assert starts == ends
assert case_starts == case_ends
for identity, test in functions.items():
    assert starts[identity] == 1 and ends[identity] == 1, test["name"]
    assert type(test["isParameterized"]) is bool
    if test["isParameterized"]:
        assert case_starts[identity] > 0, "Parameterized test executed no cases"
owned = {identity: test for identity, test in functions.items()
         if test["sourceLocation"]["fileID"].endswith("/CLIInstallerSelectionTests.swift")}
assert len(owned) == 3
for phrase, expected_cases in [
    ("managed inspection preserves the external CLI selected by discovery", 1),
    ("managed inspection does not select a CLI when no selection exists", 1),
    ("managed update selects its CLI only after successful verification", 2),
]:
    matching = [(identity, test) for identity, test in owned.items() if phrase in test["name"]]
    assert len(matching) == 1, phrase
    identity, test = matching[0]
    count = case_starts[identity] if test["isParameterized"] else 1
    assert count == expected_cases, phrase
log = (root / "native.log").read_text()
assert "[macos-native] retained resources" not in log
assert not any("[macos-native] security " in line and "failed" in line for line in log.splitlines())
result = {"verdict": "NATIVE_OWNER_UNITS_PASSED", "files": sorted(expected_files),
          "functions": len(functions), "parameterCases": sum(case_starts.values()),
          "selectionScenarios": 4, "issues": 0, "complete": True}
(root / "verdict.json").write_text(json.dumps(result, indent=2) + "\n")
print("NATIVE_OWNER_UNITS_CONFIRMED")
