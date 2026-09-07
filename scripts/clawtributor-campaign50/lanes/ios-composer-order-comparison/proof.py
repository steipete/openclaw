"""Baseline-first order discriminator; this packet itself grants no execution authority."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from classify import comparison, qualify_phase, require


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    target, lane, evidence = (Path(value).resolve() for value in sys.argv[1:4])
    require(sys.argv[4] == "compare", "Only the complete reviewed comparison is supported")
    require(os.environ.get("PROOF_VARIANT") == "composer-order-comparison", "Wrong variant")
    evidence.mkdir(parents=True, exist_ok=True)
    cleanup_marker = evidence / "native-process-cleanup-incomplete.json"
    receipt = {"variant": "composer-order-comparison", "comparisonAccepted": False,
               "focusPRQualified": False, "phases": []}
    code = 1
    try:
        require(not cleanup_marker.exists(), "Prior command-group cleanup is unreconciled")
        packet = json.loads((lane / "PACKET.json").read_text())
        for relative, expected in packet["artifactHashes"].items():
            require(digest(lane / relative) == expected, f"Packet input differs: {relative}")
        original = (lane / "reference/ChatComposerTextViewIOS.swift").read_bytes()
        before = b"            self.lastReportedText = textView.text\n            self.parent.text = textView.text\n"
        after = b"            self.parent.text = textView.text\n            self.lastReportedText = textView.text\n"
        require(original.count(before) == 1 and original.replace(before, after)
                == (lane / "candidate/ChatComposerTextViewIOS.swift").read_bytes(), "Not the sole ordering change")
        receipt["packetSha256"] = digest(lane / "PACKET.json")
        receipt["source"] = packet["source"]
        receipt["candidateOwnerSha256"] = packet["candidateOwnerSha256"]
        results = {}
        for mode in ("baseline", "candidate"):
            directory = evidence / mode
            directory.mkdir()
            marker = {"version": 1, "phase": mode, "status": "phase-in-progress",
                      "retainedResources": {"target": str(target), "evidence": str(directory)},
                      "unprovenGroups": []}
            pending_marker = evidence / "native-process-cleanup-incomplete.pending"
            pending_marker.write_text(json.dumps(marker, indent=2) + "\n")
            pending_marker.replace(cleanup_marker)
            # phase.py owns bounded command groups and Simulator retirement or retention.
            phase_code = subprocess.call([sys.executable, str(lane / "phase.py"), str(target), str(lane), str(directory), mode])
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
            receipt["phases"].append({"mode": mode, "exitCode": phase_code,
                                      "receiptSha256": digest(directory / "receipt.json")})
            require(phase_code == phase["exitCode"] == 0, f"{mode}: incomplete native evidence")
            qualify_phase(phase)
            results[mode] = phase
            if mode == "baseline":
                require(phase["cases"][-1]["classification"] == "draft-reordered",
                        "NONREPRODUCTION: baseline draft did not fail; candidate not run")
        require(results["baseline"]["simulatorUDID"] != results["candidate"]["simulatorUDID"],
                "Comparison reused a Simulator")
        receipt["verdict"] = comparison(results["baseline"], results["candidate"])
        receipt["comparisonAccepted"] = True
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
