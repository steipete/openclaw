"""Historical-data and fake-subprocess checks; no native process or target code runs."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

import proof

lane = Path(__file__).parent.resolve()
packet = json.loads((lane / "PACKET.json").read_text())
baseline = proof.accepted_baseline(lane, packet)
assert baseline["exitCode"] == 0 and baseline["cases"][-1]["classification"] == "draft-reordered"
historical = json.loads((lane / "AcceptedBaseline/failed-comparison-receipt.json").read_text())
assert historical["exitCode"] == 1 and historical["comparisonAccepted"] is False

for behavior in ("pre-input-failure", "unproven-retirement", "missing-receipt"):
    with TemporaryDirectory(prefix="composer-continuation-model-") as temporary:
        evidence = Path(temporary) / "evidence"
        calls = []

        def fake_phase(arguments):
            calls.append(arguments)
            assert arguments[1] == str(lane / "phase.py") and arguments[-1] == "candidate"
            if behavior == "missing-receipt":
                return 1
            phase = deepcopy(json.loads((lane / "AcceptedBaseline/failed-candidate-receipt.json").read_text()))
            if behavior == "unproven-retirement":
                phase["commandGroupRetirementVerified"] = False
                phase["cleanupIncomplete"] = True
                phase["resourcesRetained"] = {"target": "synthetic-target", "unprovenGroups": [{"pgid": 4242, "gone": False}]}
            (Path(arguments[4]) / "receipt.json").write_text(json.dumps(phase))
            return 1

        arguments = ["proof.py", "/synthetic-target", str(lane), str(evidence), "candidate"]
        with patch.object(sys, "argv", arguments), patch.dict("proof.os.environ", {"PROOF_VARIANT": "composer-order-comparison"}), \
                patch("proof.subprocess.call", fake_phase):
            exit_code = proof.main()
        result = json.loads((evidence / "receipt.json").read_text())
        assert exit_code == 1 and len(calls) == 1 and result["candidateAttempts"] == 1
        assert result["combinedEvidenceQualified"] is False and result["baselineRerun"] is False
        assert result["automaticFurtherRetries"] is False and result["priorRunOutcome"] == "FAILURE, unchanged"
        marker = evidence / "native-process-cleanup-incomplete.json"
        assert marker.exists() == (behavior != "pre-input-failure")
        if behavior == "unproven-retirement":
            assert json.loads(marker.read_text())["unprovenGroups"] == [{"pgid": 4242, "gone": False}]
print("Accepted baseline data +3 fake one-attempt/retention cases passed; no process or target execution")
