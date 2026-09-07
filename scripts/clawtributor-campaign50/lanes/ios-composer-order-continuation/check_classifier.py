"""Synthetic native-result guard checks only; never imports or executes target code."""
from copy import deepcopy

from classify import COMPATIBILITY, TESTS, classify, comparison

DEVICE = "11111111-2222-3333-4444-555555555555"
record = {"scenario": "passive", "version": 1, "foreground": True, "sideEffects": "0",
          "bootstrapError": "none", "outcome": "failed", "phase": "control-draft"}
summary = {
    "totalTestCount": 1, "skippedTests": 0, "expectedFailures": 0,
    "devicesAndConfigurations": [{"device": {
        "deviceId": DEVICE, "platform": "iOS Simulator", "architecture": "arm64",
        "osVersion": "26.5", "osBuildNumber": "23F77"}}],
    "testFailures": [{"failureText": "failed - FOCUS_ASSERT passive control-draft",
                      "targetName": "FocusUITests", "testIdentifierString": "FocusUITests/testPassiveDismissal()"}],
    "result": "Failed", "passedTests": 0, "failedTests": 1,
}


def reject(call):
    try:
        call()
    except (RuntimeError, KeyError):
        return
    raise AssertionError("Malformed native evidence was accepted")


assert classify("passive", record, summary, 65, DEVICE) == "draft-reordered"
checks = 1
for key, value in [("totalTestCount", 2), ("skippedTests", 1), ("expectedFailures", 1),
                   ("failedTests", 2), ("passedTests", 1), ("result", "Passed")]:
    altered = deepcopy(summary)
    altered[key] = value
    reject(lambda: classify("passive", record, altered, 65, DEVICE))
    checks += 1
for code in (0, 1, 137):
    reject(lambda: classify("passive", record, summary, code, DEVICE))
    checks += 1
for key, value in [("failureText", "failed - FOCUS_ASSERT passive control-draft\nUnexpected failure"),
                   ("targetName", "OtherTests"), ("testIdentifierString", "FocusUITests/testTextFocus()")]:
    altered = deepcopy(summary)
    altered["testFailures"][0][key] = value
    reject(lambda: classify("passive", record, altered, 65, DEVICE))
    checks += 1
altered = deepcopy(summary)
altered["testFailures"].append(deepcopy(altered["testFailures"][0]))
reject(lambda: classify("passive", record, altered, 65, DEVICE))
reject(lambda: classify("passive", record, summary, 65, "wrong-device"))
checks += 2
for key, value in [("phase", "setup-composer"), ("outcome", "invalid"),
                   ("foreground", False), ("sideEffects", "1"), ("bootstrapError", "error")]:
    altered_record = dict(record, **{key: value})
    reject(lambda: classify("passive", altered_record, summary, 65, DEVICE))
    checks += 1
green_record = dict(record, outcome="passed", phase="complete")
green_summary = dict(summary, result="Passed", passedTests=1, failedTests=0, testFailures=[])
assert classify("passive", green_record, green_summary, 0, DEVICE) == "passed"
checks += 1
before = {"exitCode": 0, "finalBindingVerified": True,
          "cases": [{"scenario": name, "classification": "draft-reordered" if name == "passive" else "focus-failed"}
                    for name in TESTS],
          "compatibility": [{"scenario": name, "classification": "passed"} for name in COMPATIBILITY]}
after = deepcopy(before)
after["cases"][-1]["classification"] = "passed"
assert "separate focus PR remains unqualified" in comparison(before, after)
checks += 1
for variant, change in [
    (before, lambda value: value["cases"].reverse()),
    (before, lambda value: value["cases"][-1].update(classification="passed")),
    (before, lambda value: value["compatibility"][2].update(classification="compatibility-failed")),
    (before, lambda value: value.update(finalBindingVerified=False)),
    (before, lambda value: value.update(exitCode=1)),
    (after, lambda value: value["compatibility"].pop()),
    (after, lambda value: value["cases"][-1].update(classification="draft-reordered")),
]:
    altered = deepcopy(variant)
    change(altered)
    reject(lambda: comparison(altered, after) if variant is before else comparison(before, altered))
    checks += 1
print(f"{checks} synthetic classifier guards passed; no target execution")
