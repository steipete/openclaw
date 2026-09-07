"""Data-only trace validation. Success means complete observations, never a fixed product."""
import math
import re
import uuid

SPAN_EVENTS = {"beginEditing", "endEditing", "proposedEdit", "selectionChanged", "didChange", "update", "measure"}
POINT_EVENTS = {"initial", "bindingBefore", "bindingAfter", "textBefore", "textAfter",
                "selectionBefore", "selectionAfter", "echoReturn", "ignoredReturn", "fittingReturned"}
TEXT_FIELDS = ("uiText", "binding", "lastReported", "replacement")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_capture(capture, scenario):
    require(type(capture.get("version")) is int and capture["version"] == 1 and capture.get("scenario") == scenario, "Wrong capture identity")
    nonce = capture.get("nonce")
    require(isinstance(nonce, str) and str(uuid.UUID(nonce)) == nonce, "Invalid capture nonce")
    require(capture.get("acknowledged") is True and type(capture.get("resultRawValue")) is int and capture["resultRawValue"] == 1,
            "Capture did not receive a successful acknowledgement")
    require(capture.get("timeoutSeconds") == 3, "Capture deadline changed")
    times = [capture.get(key) for key in
             ("registeringAt", "registeredAt", "postedAt", "waitStartedAt", "acknowledgedAt", "finishedAt")]
    require(all(number(value) for value in times) and times == sorted(times), "Capture timing/order invalid")
    require(capture["acknowledgedAt"] - capture["postedAt"] <= 3, "Capture acknowledgement exceeded deadline")
    return nonce


def validate_trace(trace, capture, scenario, pid):
    nonce = validate_capture(capture, scenario)
    require(type(trace.get("version")) is int and trace["version"] == 1 and trace.get("nonce") == nonce and trace.get("scenario") == scenario,
            "Wrong trace envelope")
    require(type(pid) is int and pid > 1 and type(trace.get("pid")) is int and trace["pid"] == pid, "Trace PID differs from native app")
    require(trace.get("sealed") is True and type(trace.get("finalDepth")) is int and trace["finalDepth"] == 0, "Trace was not sealed at depth zero")
    require(trace.get("overflow") is False and trace.get("incomplete") is False
            and trace.get("breachedLimit") is None and type(trace.get("stoppedPayloads")) is int and trace["stoppedPayloads"] == 0, "Incomplete trace")
    for key, value in {"maximumRecords": 2048, "maximumDepth": 32, "maximumUTF16Units": 64,
                       "maximumRanges": 8, "maximumBytes": 8 * 1024 * 1024}.items():
        require(type(trace.get(key)) is int and trace[key] == value, "Trace bounds differ")
    records = trace.get("records")
    require(isinstance(records, list) and 0 < len(records) <= 2048
            and type(trace.get("finalSequence")) is int and trace["finalSequence"] == len(records), "Trace record count invalid")
    stack = []
    seen_spans = set()
    previous_time = -1
    initial = False
    for index, record in enumerate(records, 1):
        require(type(record.get("sequence")) is int and record["sequence"] == index, "Missing or reordered trace record")
        timestamp = record.get("uptime")
        require(number(timestamp) and timestamp >= previous_time, "Trace time went backward")
        previous_time = timestamp
        require(type(record.get("view")) is int and 1 <= record["view"] <= 2048, "Invalid view ordinal")
        for key in TEXT_FIELDS:
            value = record.get(key)
            require((value is None and key != "uiText") or
                    (isinstance(value, str) and len(value.encode("utf-16-le")) // 2 <= 64), "Oversized text field")
        require(record.get("uiTextUTF16Length") == len(record["uiText"].encode("utf-16-le")) // 2, "Text length differs")
        for key in ("isFirstResponder", "hasMarkedText"):
            require(type(record.get(key)) is bool, "Missing responder/composition state")
        require(record.get("isProgrammaticUpdate") is None or type(record["isProgrammaticUpdate"]) is bool,
                "Invalid programmatic state")
        ranges = record.get("proposedRanges")
        require(isinstance(ranges, list) and len(ranges) + 1 <= 8, "Too many ranges")
        for item in [record.get("selection"), *ranges]:
            require(isinstance(item, dict) and set(item) == {"location", "length"}, "Missing range")
            for value in item.values():
                require(isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9][0-9]{0,18})", value)
                        and -(2**63) <= int(value) <= 2**63 - 1, "Lossy or invalid native range integer")
        for key in ("proposedWidth", "fittingWidth", "fittingHeight"):
            value = record.get(key)
            require(value is None or number(value) or value in ("+infinity", "-infinity", "nan"), "Invalid measurement")
        require(type(record.get("depth")) is int, "Invalid depth type")
        phase, event, span = record.get("phase"), record.get("event"), record.get("span")
        if phase == "enter":
            require(event in SPAN_EVENTS and type(span) is int and span > 0 and span not in seen_spans,
                    "Invalid span entry")
            require(record.get("parentSpan") == (stack[-1][0] if stack else None), "Wrong span parent")
            seen_spans.add(span)
            stack.append((span, event, record.get("parentSpan")))
            require(record.get("depth") == len(stack) <= 32, "Invalid span depth")
        elif phase == "exit":
            require(stack and stack[-1] == (span, event, record.get("parentSpan"))
                    and record.get("depth") == len(stack), "Unmatched span exit")
            stack.pop()
        elif phase == "point":
            require(event in POINT_EVENTS and record.get("depth") == len(stack)
                    and span == (stack[-1][0] if stack else None)
                    and record.get("parentSpan") == (stack[-1][2] if stack else None), "Unbound point")
            initial = initial or event == "initial"
        else:
            raise ValueError("Unknown trace phase")
    require(not stack and initial, "Trace missing initial state or final closure")
    require(previous_time <= capture["acknowledgedAt"], "Acknowledgement precedes trace completion")
    return {"complete": True, "nonce": nonce, "pid": pid, "scenario": scenario,
            "recordCount": len(records), "spanCount": len(seen_spans),
            "eventCounts": {event: sum(row["event"] == event for row in records)
                            for event in sorted(SPAN_EVENTS | POINT_EVENTS)},
            "causalConclusion": "none; inspect trace and confirm on unchanged uninstrumented flow"}
