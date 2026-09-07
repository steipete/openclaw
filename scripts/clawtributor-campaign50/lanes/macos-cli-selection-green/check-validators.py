"""Inert ABI/log validation checks; never loads or runs target source."""
import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

lane = pathlib.Path(__file__).resolve().parent
actual = lane.parents[1] / "proof-infra/runs/34153109025/campaign50-macos-cli-selection-red-1/evidence/macos-cli-selection-red"
actual_records = [json.loads(line) for line in (actual / "events.jsonl").read_text().splitlines()]
observations = json.loads((actual / "verdict.json").read_text())["observations"]
flow_records = [row for row in copy.deepcopy(actual_records)
                if not (row["kind"] == "event" and row["payload"]["kind"] == "issueRecorded")]
for row in flow_records:
    if row["kind"] == "event" and row["payload"]["kind"] == "runEnded":
        row["payload"]["messages"] = [{"symbol": "pass", "text": "Synthetic complete run"}]
for row in observations:
    row["actual"] = copy.deepcopy(row["expected"])
    row["matches"] = True
    row["launcherHome"] = row["launcherHome"].replace("oc-test-PPMlLd", "oc-test-inert-validator-never-created")
    for key in ("actual", "expected"):
        for field in ("executable", "resolved"):
            if field in row[key]:
                row[key][field] = row[key][field].replace("oc-test-PPMlLd", "oc-test-inert-validator-never-created")
flow_log = "\n".join("MANAGED_CLI_SELECTION_PROOF " + json.dumps(row) for row in observations)

def record(record_kind, **payload):
    return {"version": 0, "kind": record_kind, "payload": payload}

unit_records = []
names = [
    ("CLIInstallerSelectionTests.swift", "managed inspection preserves the external CLI selected by discovery()", 0),
    ("CLIInstallerSelectionTests.swift", "managed inspection does not select a CLI when no selection exists()", 0),
    ("CLIInstallerSelectionTests.swift", "managed update selects its CLI only after successful verification(_:)", 2),
    ("CLIInstallerTests.swift", "synthetic installer sibling()", 0),
    ("CommandResolverTests.swift", "synthetic resolver sibling()", 0),
    ("AppProfileTests.swift", "synthetic profile sibling()", 0),
    ("RuntimeLocatorTests.swift", "synthetic parameterized runtime sibling(_:)", 10),
]
for index, (file, name, cases) in enumerate(names):
    unit_records.append(record("test", id=f"opaque-{index}", kind="function", name=name,
                               sourceLocation={"fileID": "OpenClawIPCTests/" + file},
                               isParameterized=cases > 0))
unit_records.append(record("event", kind="runStarted", messages=[]))
for index, (_, _, cases) in enumerate(names):
    unit_records.append(record("event", kind="testStarted", testID=f"opaque-{index}", messages=[]))
    for _ in range(cases):
        unit_records.append(record("event", kind="testCaseStarted", testID=f"opaque-{index}", messages=[]))
        unit_records.append(record("event", kind="testCaseEnded", testID=f"opaque-{index}", messages=[]))
    unit_records.append(record("event", kind="testEnded", testID=f"opaque-{index}", messages=[]))
unit_records.append(record("event", kind="runEnded", messages=[{"symbol": "pass", "text": "Synthetic complete run"}]))

results = []
def check(name, validator, records, log="", code=0, accepted=False):
    with tempfile.TemporaryDirectory(prefix="140131-inert-validator-") as directory:
        root = pathlib.Path(directory)
        (root / "events.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
        (root / "native.log").write_text(log)
        result = subprocess.run([sys.executable, str(lane / validator), str(root), str(code)],
                                capture_output=True, text=True)
        assert (result.returncode == 0) == accepted, (name, result.stdout, result.stderr)
        results.append({"case": name, "expected": "accept" if accepted else "reject", "passed": True})

check("synthetic four green flows", "validate-proof.py", flow_records, flow_log, accepted=True)
check("actual baseline issues rejected", "validate-proof.py", actual_records, flow_log)
check("native failure rejected", "validate-proof.py", flow_records, flow_log, code=1)
check("missing observation rejected", "validate-proof.py", flow_records, "\n".join(flow_log.splitlines()[:-1]))
check("fixture cleanup failure rejected", "validate-proof.py", flow_records, flow_log.replace('"fixturesRemoved": true', '"fixturesRemoved": false', 1))
check("wrong selection rejected", "validate-proof.py", flow_records, flow_log.replace('"matches": true', '"matches": false', 1))
check("flow incomplete rejected", "validate-proof.py", flow_records[:-1], flow_log)
check("retained flow resources rejected", "validate-proof.py", flow_records, flow_log + "\n[macos-native] retained resources")
check("synthetic complete owner functions and parameter cases", "validate-units.py", unit_records, accepted=True)
check("unit native failure rejected", "validate-units.py", unit_records, code=1)
check("unit incomplete rejected", "validate-units.py", unit_records[:-1])
for event_kind in ("issueRecorded", "testSkipped", "testCancelled", "testCaseCancelled"):
    check(event_kind + " rejected", "validate-units.py",
          unit_records[:-1] + [record("event", kind=event_kind, testID="opaque-0", messages=[])] + unit_records[-1:])
missing_case = copy.deepcopy(unit_records)
del missing_case[next(i for i, row in enumerate(missing_case)
                      if row["kind"] == "event" and row["payload"]["kind"] == "testCaseEnded")]
check("unjoined parameter case rejected", "validate-units.py", missing_case)
no_cases = [row for row in unit_records if not (row["kind"] == "event" and
            row["payload"].get("testID") == "opaque-2" and row["payload"]["kind"].startswith("testCase"))]
check("missing update parameter cases rejected", "validate-units.py", no_cases)
wrong_file = copy.deepcopy(unit_records)
wrong_file[0]["payload"]["sourceLocation"]["fileID"] = "OpenClawIPCTests/UnexpectedTests.swift"
check("unexpected owner file rejected", "validate-units.py", wrong_file)
nonparam_case = unit_records[:-1] + [record("event", kind="testCaseStarted", testID="opaque-0", messages=[]),
                                   record("event", kind="testCaseEnded", testID="opaque-0", messages=[])] + unit_records[-1:]
check("impossible nonparameter case rejected", "validate-units.py", nonparam_case)
check("unit retention rejected", "validate-units.py", unit_records, "[macos-native] retained resources")
result = {"scope": "Synthetic ABI/log parser checks only; no Swift or target execution", "cases": results,
          "validatorHashes": {name: hashlib.sha256((lane / name).read_bytes()).hexdigest()
                              for name in ("validate-proof.py", "validate-units.py", "check-validators.py")}}
(lane / "validator-checks.json").write_text(json.dumps(result, indent=2) + "\n")
print(f"{len(results)} inert validator checks passed")
