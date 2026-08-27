"""Classify exact JUnit failures; infrastructure failures are never fail-first proof."""

import fnmatch
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
artifacts = pathlib.Path(sys.argv[2])
command_exit = int(sys.argv[3])
expected = manifest["expectedFailures"]
failures = []
tests = 0
skipped = 0
errors = 0
test_names = []
for report in sorted((artifacts / "junit").glob("TEST-*.xml")):
    for case in ET.parse(report).getroot().iter("testcase"):
        tests += 1
        test_names.extend([case.get("classname", ""), case.get("classname", "") + "." + case.get("name", "")])
        skipped += len(case.findall("skipped"))
        errors += len(case.findall("error"))
        for failure in case.findall("failure"):
            failures.append({
                "classname": case.get("classname", ""),
                "name": case.get("name", ""),
                "message": failure.get("message", "") + "\n" + (failure.text or ""),
            })

expected_keys = [(item["classname"], item["name"]) for item in expected]
actual_keys = [(item["classname"], item["name"]) for item in failures]
matched = len(set(expected_keys)) == len(expected_keys) and sorted(actual_keys) == sorted(expected_keys) and all(
    sum(
        actual["classname"] == wanted["classname"]
        and actual["name"] == wanted["name"]
        and wanted["messageContains"] in actual["message"]
        for actual in failures
    ) == 1
    for wanted in expected
)
valid = tests > 0 and skipped == 0 and errors == 0 and matched
valid = valid and all(
    any(fnmatch.fnmatchcase(name, test_filter) for name in test_names)
    for test_filter in manifest["testFilters"]
)
valid = valid and (command_exit == 1 if expected else command_exit == 0)
gradle_log = (artifacts / "gradle.log").read_text()
if expected:
    # JUnit can be written before a finalizer/worker failure. Keep that separate from test-red.
    failed_tasks = re.findall(r"^Execution failed for task '([^']+)'\.$", gradle_log, re.MULTILINE)
    valid = valid and failed_tasks == [":app:testPlayDebugUnitTest"]
    valid = valid and gradle_log.count("FAILURE: Build failed with an exception.") == 1
    valid = valid and "> There were failing tests." in gradle_log
    valid = valid and len(re.findall(r"^BUILD FAILED in .+$", gradle_log, re.MULTILINE)) == 1
    valid = valid and not re.search(r"^.*(?:Multiple task action failures|Build completed with [0-9]+ failures).*$", gradle_log, re.MULTILINE)
result = {
    "result": ("expected-red" if expected else "pass") if valid else "invalid-proof",
    "sourceSha": manifest["sourceSha"],
    "overlaySha256": manifest["overlaySha256"],
    "tests": tests,
    "skipped": skipped,
    "errors": errors,
    "failures": failures,
    "commandExit": command_exit,
}
(artifacts / "unit-result.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "failures"}))
sys.exit(0 if valid else 1)
