"""Synthetic data-parser checks only, not iOS observation or reproduction."""
from copy import deepcopy
from trace_validation import validate_trace

nonce = "6cfc33bd-a773-4d9e-8fe4-55a5efb8e02a"
capture = {"version": 1, "scenario": "passive", "nonce": nonce, "acknowledged": True,
           "resultRawValue": 1, "timeoutSeconds": 3, "registeringAt": 10.0, "registeredAt": 10.1,
           "postedAt": 10.2, "waitStartedAt": 10.3, "acknowledgedAt": 10.8, "finishedAt": 10.9}
initial = {"sequence": 1, "uptime": 1.0, "event": "initial", "phase": "point", "depth": 0,
           "view": 1, "uiText": "", "uiTextUTF16Length": 0,
           "selection": {"location": "9223372036854775807", "length": "0"}, "proposedRanges": [],
           "isFirstResponder": False, "hasMarkedText": False, "isProgrammaticUpdate": False}
entry = {**initial, "sequence": 2, "uptime": 2.0, "event": "measure", "phase": "enter", "span": 1, "depth": 1}
exit_record = {**entry, "sequence": 3, "uptime": 2.1, "phase": "exit"}
trace = {"version": 1, "scenario": "passive", "nonce": nonce, "pid": 42, "sealed": True,
         "finalDepth": 0, "finalSequence": 3, "overflow": False, "incomplete": False,
         "stoppedPayloads": 0, "maximumRecords": 2048, "maximumDepth": 32,
         "maximumUTF16Units": 64, "maximumRanges": 8, "maximumBytes": 8388608,
         "records": [initial, entry, exit_record]}
assert validate_trace(trace, capture, "passive", 42)["complete"]


def rejected(change_trace=lambda value: None, change_capture=lambda value: None):
    candidate, observation = deepcopy(trace), deepcopy(capture)
    change_trace(candidate)
    change_capture(observation)
    try:
        validate_trace(candidate, observation, "passive", 42)
    except (ValueError, KeyError, TypeError):
        return
    raise AssertionError("Invalid diagnostic trace accepted")


rejected(lambda value: value.update(pid=43))
rejected(lambda value: value.update(nonce="6cfc33bd-a773-4d9e-8fe4-55a5efb8e02b"))
rejected(lambda value: value.update(overflow=True, incomplete=True, breachedLimit="records"))
rejected(lambda value: value.update(sealed=False))
rejected(lambda value: value.update(finalDepth=1))
rejected(lambda value: value["records"][2].update(span=2))
rejected(lambda value: value["records"][1].update(parentSpan=8))
rejected(lambda value: value["records"][2].update(sequence=4))
rejected(lambda value: value["records"][2].update(uptime=0.0))
rejected(lambda value: value["records"][0]["selection"].update(location=9223372036854775807))
rejected(lambda value: value["records"][0].update(uiText="🧠" * 33, uiTextUTF16Length=66))
rejected(lambda value: value["records"][0].update(proposedRanges=[{"location": "0", "length": "0"}] * 8))
rejected(lambda value: value["records"][0].update(hasMarkedText="false"))
rejected(lambda value: value["records"][0].update(sequence=True))
rejected(change_capture=lambda value: value.update(acknowledged=False, resultRawValue=2))
rejected(change_capture=lambda value: value.update(registeredAt=10.4))
rejected(change_capture=lambda value: value.update(acknowledgedAt=14.0, finishedAt=14.1))
print("18 synthetic trace checks passed; no target execution")
