"""One candidate continuation; immutable prior baseline evidence is reused as data."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from classify import classify, comparison, qualify_phase, require

PRIOR_RUN = 34114744042
PRIOR_PACKET_SHA = "61de13890d250a379488aec667ed54502a2ff30a983d2138af7310575191db45"
BASELINE_RECEIPT_SHA = "9b676fbb5f1fe9acd85081fe5b2a40b2e56538f3bf13bafe51fa7bb97bfa86d8"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def accepted_baseline(lane, packet):
    require(digest(lane / "COMPARISON-PACKET.json") == PRIOR_PACKET_SHA, "Prior comparison packet differs")
    previous = json.loads((lane / "COMPARISON-PACKET.json").read_text())
    for relative, expected in previous["artifactHashes"].items():
        original = {"proof.py": "reference/ComparisonProof.py", "README.md": "reference/ComparisonREADME.md"}.get(relative, relative)
        require(digest(lane / original) == expected, f"Original comparison input differs: {relative}")
    require(packet["sourceHashes"] == previous["sourceHashes"]
            and packet["candidateOwnerSha256"] == previous["candidateOwnerSha256"], "Source or candidate differs")
    metadata = json.loads((lane / "BASELINE-EVIDENCE.json").read_text())
    require(metadata["run"] == PRIOR_RUN and metadata["comparisonPacketSha256"] == PRIOR_PACKET_SHA
            and metadata["baselineReceiptSha256"] == BASELINE_RECEIPT_SHA
            and metadata["priorRunOutcome"] == "FAILURE, unchanged", "Wrong historical evidence")
    for relative, expected in metadata["historicalEvidenceFiles"].items():
        require(digest(lane / (relative + ".txt" if relative.endswith(".log") else relative)) == expected, f"Baseline evidence differs: {relative}")
    root = lane / "AcceptedBaseline"
    require(digest(root / "receipt.json") == BASELINE_RECEIPT_SHA, "Accepted baseline receipt differs")
    prior = json.loads((root / "failed-comparison-receipt.json").read_text())
    require(prior["comparisonAccepted"] is False and prior["focusPRQualified"] is False and prior["exitCode"] == 1
            and prior["packetSha256"] == PRIOR_PACKET_SHA and prior["source"] == packet["source"]
            and prior["phases"] == [
                {"mode": "baseline", "exitCode": 0, "receiptSha256": BASELINE_RECEIPT_SHA},
                {"mode": "candidate", "exitCode": 1, "receiptSha256": metadata["failedCandidateReceiptSha256"]},
            ], "Prior failed wave must remain failed")
    require(digest(root / "failed-candidate-receipt.json") == metadata["failedCandidateReceiptSha256"],
            "Prior candidate failure receipt differs")
    failed_candidate = json.loads((root / "failed-candidate-receipt.json").read_text())
    require(failed_candidate["exitCode"] == 1 and failed_candidate["cases"] == []
            and failed_candidate["compatibility"] == [] and len(failed_candidate["diagnosticRecords"]) == 1
            and failed_candidate["diagnosticRecords"][0]["scenario"] == "secure"
            and failed_candidate["diagnosticRecords"][0]["phase"] == "setup-scenario",
            "Prior candidate did not stop at the approved pre-input setup failure")
    baseline = json.loads((root / "receipt.json").read_text())
    qualify_phase(baseline)
    require(baseline["mode"] == "baseline" and baseline["source"] == packet["source"]
            and baseline["packetSha256"] == PRIOR_PACKET_SHA
            and baseline["effectiveSourceHashes"] == packet["sourceHashes"]
            and baseline["commandGroupRetirementVerified"] is True
            and baseline["installedLockSha256"] == packet["admittedLockSha256"], "Baseline source/cleanup binding differs")
    require(baseline["cases"][-1]["classification"] == "draft-reordered", "Accepted baseline is not the intended draft red")
    for compatibility, rows in ((False, baseline["cases"]), (True, baseline["compatibility"])):
        for row in rows:
            name = ("compatibility-" if compatibility else "") + row["scenario"]
            record = json.loads((root / (name + "-record.json")).read_text())
            summary = json.loads((root / ("summary-" + name + ".log.txt")).read_text())
            command = next(item for item in baseline["commands"] if item["name"] == "test-" + name)
            require(record == {key: value for key, value in row.items() if key != "classification"},
                    f"Baseline recorded observation differs: {name}")
            require(classify(row["scenario"], record, summary, command["exitCode"], baseline["simulatorUDID"],
                             compatibility=compatibility) == row["classification"], "Baseline native result differs")
    return baseline


def main():
    target, lane, evidence = (Path(value).resolve() for value in sys.argv[1:4])
    require(sys.argv[4] == "candidate", "Only the one candidate continuation is supported")
    require(os.environ.get("PROOF_VARIANT") == "composer-order-comparison", "Wrong unchanged phase variant")
    evidence.mkdir(parents=True, exist_ok=True)
    cleanup_marker = evidence / "native-process-cleanup-incomplete.json"
    receipt = {"stage": "candidate-only-continuation", "priorRun": PRIOR_RUN,
               "priorRunOutcome": "FAILURE, unchanged", "baselineRerun": False,
               "candidateAttempts": 0, "combinedEvidenceQualified": False,
               "focusPRQualified": False, "automaticFurtherRetries": False}
    code = 1
    try:
        require(not cleanup_marker.exists(), "Prior command-group cleanup is unreconciled")
        packet = json.loads((lane / "PACKET.json").read_text())
        for relative, expected in packet["artifactHashes"].items():
            require(digest(lane / relative) == expected, f"Packet input differs: {relative}")
        baseline = accepted_baseline(lane, packet)
        receipt["acceptedBaselineReceiptSha256"] = BASELINE_RECEIPT_SHA
        receipt["packetSha256"] = digest(lane / "PACKET.json")
        receipt["source"] = packet["source"]
        receipt["candidateOwnerSha256"] = packet["candidateOwnerSha256"]
        original = (lane / "reference/ChatComposerTextViewIOS.swift").read_bytes()
        before = b"            self.lastReportedText = textView.text\n            self.parent.text = textView.text\n"
        after = b"            self.parent.text = textView.text\n            self.lastReportedText = textView.text\n"
        require(original.count(before) == 1 and original.replace(before, after)
                == (lane / "candidate/ChatComposerTextViewIOS.swift").read_bytes(), "Not the sole ordering change")
        directory = evidence / "candidate"
        directory.mkdir()
        marker = {"version": 1, "phase": "candidate", "status": "phase-in-progress",
                  "retainedResources": {"target": str(target), "evidence": str(directory)}, "unprovenGroups": []}
        pending_marker = evidence / "native-process-cleanup-incomplete.pending"
        pending_marker.write_text(json.dumps(marker, indent=2) + "\n")
        pending_marker.replace(cleanup_marker)
        receipt["candidateAttempts"] = 1
        phase_code = subprocess.call([sys.executable, str(lane / "phase.py"), str(target), str(lane), str(directory), "candidate"])
        phase = json.loads((directory / "receipt.json").read_text())
        if phase.get("commandGroupRetirementVerified") is True and not phase.get("cleanupIncomplete"):
            cleanup_marker.unlink()
        else:
            marker.update(status="command-group-retirement-unproven",
                          retainedResources=phase.get("resourcesRetained", marker["retainedResources"]),
                          unprovenGroups=phase.get("resourcesRetained", {}).get("unprovenGroups", []))
            pending_marker.write_text(json.dumps(marker, indent=2) + "\n")
            pending_marker.replace(cleanup_marker)
        require(not cleanup_marker.exists(), "Command-group retirement unproven; outer resources retained")
        receipt["candidateExitCode"] = phase_code
        receipt["candidateReceiptSha256"] = digest(directory / "receipt.json")
        require(phase_code == phase["exitCode"] == 0, "Candidate continuation incomplete; no automatic retry")
        require(phase["simulatorUDID"] != baseline["simulatorUDID"], "Continuation reused the prior Simulator")
        receipt["verdict"] = comparison(baseline, phase)
        receipt["combinedEvidenceQualified"] = True
        code = 0
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    finally:
        if cleanup_marker.exists():
            receipt["cleanupIncomplete"] = True
            receipt["cleanupMarker"] = cleanup_marker.name
            code = 1
        receipt["exitCode"] = code
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (evidence / "exit-code.txt").write_text(str(code) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
