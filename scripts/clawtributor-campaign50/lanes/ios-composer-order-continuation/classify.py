"""Strict data-only native result classification; no source or UI execution."""
TESTS = {
    "secure": "testSecureFocus",
    "text": "testTextFocus",
    "hosts": "testAllowedHostsFocus",
    "passive": "testPassiveDismissal",
}
COMPATIBILITY = {
    "external": "testExternalReplaceAndClear",
    "selection": "testCaretAndSelectionEcho",
    "marked": "testMarkedTextRefreshAndCommit",
    "focus": "testFalseFocusAndDisabled",
}
FOCUS_FAILURES = {
    "first-tap-focus", "retap-focus", "post-tick-focus", "typed-focus", "hosts-post-tick-focus",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def classify(scenario, record, summary, code, device, compatibility=False):
    tests = COMPATIBILITY if compatibility else TESTS
    target = "ComposerCompatibilityTests" if compatibility else "FocusUITests"
    marker = "COMPOSER_COMPAT_ASSERT" if compatibility else "FOCUS_ASSERT"
    require(record["scenario"] == scenario and record["version"] == 1, "Wrong fixture identity")
    require(summary["totalTestCount"] == 1 and summary["skippedTests"] == 0 and summary["expectedFailures"] == 0,
            "Incomplete native result")
    configurations = summary["devicesAndConfigurations"]
    require(len(configurations) == 1, "Unexpected native configuration count")
    observed = configurations[0]["device"]
    require(observed["deviceId"].lower() == device.lower() and observed["platform"] == "iOS Simulator"
            and observed["architecture"] == "arm64" and observed["osVersion"] == "26.5"
            and observed["osBuildNumber"] == "23F77", "Native result has wrong Simulator binding")
    if compatibility:
        require(record["bundleID"] == "org.openclaw.tests.composercompat"
                and type(record["pid"]) is int and record["pid"] > 0 and record["snapshots"],
                "Wrong compatibility host or empty observations")
    else:
        require(record["foreground"] is True and record["sideEffects"] == "0" and record["bootstrapError"] == "none",
                "Bootstrap/effect failure")
    failures = summary["testFailures"]
    if record["outcome"] == "passed":
        require(record["phase"] == "complete" and code == 0 and summary["result"] == "Passed"
                and summary["passedTests"] == 1 and summary["failedTests"] == 0 and failures == [],
                "Native success disagreement")
        return "passed"
    require(record["outcome"] == "failed" and code == 65 and summary["result"] == "Failed"
            and summary["passedTests"] == 0 and summary["failedTests"] == 1 and len(failures) == 1,
            "Native failure is not isolated")
    failure = failures[0]
    require(failure["failureText"] == f"failed - {marker} {scenario} {record['phase']}"
            and failure["targetName"] == target
            and failure["testIdentifierString"] == f"{target}/{tests[scenario]}()",
            "Native assertion does not exactly match the fixture")
    if compatibility:
        return "compatibility-failed"
    require((scenario == "passive" and record["phase"] == "control-draft")
            or (scenario != "passive" and record["phase"] in FOCUS_FAILURES), "Unclassified UI failure")
    return "draft-reordered" if scenario == "passive" else "focus-failed"


def qualify_phase(phase):
    require(phase["exitCode"] == 0 and phase["finalBindingVerified"] is True, "Incomplete phase")
    require([row["scenario"] for row in phase["cases"]] == list(TESTS), "Original case order differs")
    require([row["scenario"] for row in phase["compatibility"]] == list(COMPATIBILITY), "Incomplete compatibility order")
    require(all(row["classification"] == "passed" for row in phase["compatibility"]), "Compatibility control failed")


def comparison(baseline, candidate):
    qualify_phase(baseline)
    qualify_phase(candidate)
    before, after = baseline["cases"][-1], candidate["cases"][-1]
    require(before["classification"] == "draft-reordered", "NONREPRODUCTION: uninstrumented baseline draft did not fail")
    require(after["classification"] == "passed", "Candidate did not preserve the original complete passive flow")
    return "Order-only draft-preservation discriminator qualified; separate focus PR remains unqualified"
