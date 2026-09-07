"""Bounded composer observations; instrumented results are causal leads only."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import shutil
import subprocess
import sys
import uuid
from trace_validation import validate_capture, validate_trace

SOURCE = "a1707cb38032c6d94e3a3c49d0de4e68f62539b9"
LOCK_SHA256 = "65a6c7259f2012d6cad33d2386b94fa653ce1080ead2015f858d8d1ae3648a0d"
ADMISSION_SHA256 = "9b61a58e502d2aa3ba0bdc336cbbf03b3208ee96289bf1b0a22d8b3e8a9ec3e8"
HOST_PACKET_SHA256 = "c2cb5165548264cd2d8076d7f4a07f38e3f139e78daa09958ac0959fea76e0c5"
BASELINE_PACKET_SHA256 = "04b38400f898113ba85ef931d3cf912dad30dcd0aa8eb150ae0424d69896b235"
ORDERED_PACKET_SHA256 = "8811a3e0b22e4515d49f86fc391126658453e9df03cbafdb08af9f6d9e5a77a9"
DESIGN_SHA256 = "7ff9e1e04fec076d68391a576c089f434844e4b97ca9408c9308fa08148c0abd"
TESTS = {
    "secure": "testSecureFocus",
    "text": "testTextFocus",
    "hosts": "testAllowedHostsFocus",
    "passive": "testPassiveDismissal",
}
FOCUS_FAILURES = {
    "first-tap-focus", "retap-focus", "post-tick-focus", "typed-focus", "hosts-post-tick-focus",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    target, lane, evidence = map(lambda value: Path(value).resolve(), sys.argv[1:4])
    mode = sys.argv[4]
    require(mode == "baseline", "Only baseline is authorized by this packet")
    require(os.environ.get("PROOF_VARIANT") == "composer-observation", "Wrong proof variant")
    require(os.environ.get("CI") in {"1", "true"} and os.environ.get("GITHUB_ACTIONS") == "true", "Missing real CI identity")
    require(os.environ.get("RUNNER_OS") == "macOS" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "This packet requires the reviewed secretless hosted macOS route")
    require(os.environ.get("SOURCE_SHA") == SOURCE, "Unexpected source pin")
    evidence.mkdir(parents=True, exist_ok=True)
    work = Path(os.environ["RUNNER_TEMP"]) / ("focus136179-" + uuid.uuid4().hex)
    work.mkdir()
    device = None
    resolved = None
    return_code = 1
    exports_attempted = set()
    overlay_installed = False
    receipt = {"source": SOURCE, "mode": mode, "stage": "composer-observation", "work": str(work),
               "admittedLockSha256": LOCK_SHA256, "commands": [], "cases": [], "diagnosticRecords": [],
               "caseOrder": list(TESTS), "attachments": {}, "composerTraces": {},
               "instrumented": True, "baselineAccepted": False}

    def command(name, argv, timeout=120, check=True, cwd=target):
        log = evidence / (name + ".log")
        receipt["commands"].append({"name": name, "argv": list(map(str, argv)), "timeoutSeconds": timeout})
        with log.open("wb") as output:
            process = subprocess.Popen(list(map(str, argv)), cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                receipt["commands"][-1]["timedOut"] = True
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                except ProcessLookupError:
                    process.wait(timeout=5)
                raise
        receipt["commands"][-1]["exitCode"] = code
        if check:
            require(code == 0, f"{name} failed; inspect retained log")
        return code, log.read_text(errors="replace")

    def export_attachments(result_bundle):
        scenario = result_bundle.stem
        exports_attempted.add(scenario)
        directory = evidence / (scenario + "-attachments")
        directory.mkdir()
        command("export-attachments-" + scenario, ["xcrun", "xcresulttool", "export", "attachments",
                                                   "--path", result_bundle, "--output-path", directory])
        files = sorted(path for path in directory.rglob("*") if path.is_file())
        images = [path for path in files if path.suffix.lower() == ".png"]
        require(images and all(path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n") for path in images),
                f"{scenario}: missing inspectable app screenshots")
        receipt["attachments"][scenario] = {
            "source": SOURCE,
            "hostSha256": receipt["hostSourceHashes"]["Host/FocusHost.swift"],
            "uiTestsSha256": receipt["hostSourceHashes"]["UITests/FocusUITests.swift"],
            "captureHelperSha256": receipt["hostSourceHashes"]["UITests/ComposerTraceCapture.swift"],
            "simulatorUDID": device,
            "files": [{"path": str(path.relative_to(evidence)), "sha256": digest(path)} for path in files],
        }

    def verify_overlay(phase):
        for relative, expected in packet["instrumentedSourceHashes"].items():
            require(digest(target / relative) == expected, f"Instrumented source drift: {relative}")
        _, tracked = command("instrumented-tracked-" + phase, ["git", "diff", "--name-only", "HEAD", "--"])
        require(tracked.splitlines() == [packet["ownerPath"]], "Unexpected tracked source delta")
        _, untracked = command("instrumented-untracked-" + phase, ["git", "ls-files", "--others", "--exclude-standard"])
        require(untracked.splitlines() == [packet["helperPath"]], "Unexpected untracked source delta")
        receipt.setdefault("sourceOverlayChecks", []).append(phase)

    def capture_composer(scenario, log):
        captures = [json.loads(value) for value in re.findall(r"COMPOSER_CAPTURE (\{[^\n]*\})", log)]
        require(len(captures) == 1 and "COMPOSER_CAPTURE_ERROR" not in log, "Missing/duplicate composer capture status")
        capture = captures[0]
        (evidence / (scenario + "-composer-capture.json")).write_text(json.dumps(capture, indent=2) + "\n")
        nonce = validate_capture(capture, scenario)
        pids = re.findall(r"Terminate org\.openclaw\.tests\.focus136179:(\d+)", log)
        require(len(pids) == 1 and int(pids[0]) > 1, "Missing exact native app PID")
        _, container_text = command("composer-container-" + scenario, [
            "xcrun", "simctl", "get_app_container", device, "org.openclaw.tests.focus136179", "data"])
        container = Path(container_text.strip()).resolve(strict=True)
        require(device.lower() in {part.lower() for part in container.parts}, "Container is not on owned Simulator")
        trace_path = container / "tmp" / ("composer-observation-" + nonce + ".json")
        require(trace_path.is_file() and not trace_path.is_symlink(), "Missing regular composer trace")
        require(trace_path.stat().st_size <= 8 * 1024 * 1024, "Composer trace exceeds bound")
        copied = evidence / (scenario + "-composer-trace.json")
        shutil.copyfile(trace_path, copied)
        trace = json.loads(copied.read_text())
        validation = validate_trace(trace, capture, scenario, int(pids[0]))
        receipt["composerTraces"][scenario] = {
            "path": copied.name, "sha256": digest(copied), "validation": validation,
            "source": SOURCE, "ownerSha256": packet["instrumentedSourceHashes"][packet["ownerPath"]],
            "helperSha256": packet["instrumentedSourceHashes"][packet["helperPath"]],
            "uiTestsSha256": receipt["hostSourceHashes"]["UITests/FocusUITests.swift"],
            "captureHelperSha256": receipt["hostSourceHashes"]["UITests/ComposerTraceCapture.swift"], "simulatorUDID": device,
        }

    try:
        _, head = command("source-head", ["git", "rev-parse", "HEAD"])
        require(head.strip() == SOURCE, "Wrong target checkout")
        _, clean = command("source-status", ["git", "status", "--porcelain"])
        require(not clean.strip(), "Target must begin clean")
        packet = json.loads((lane / "PACKET.json").read_text())
        for relative, expected in packet["sourceHashes"].items():
            require(digest(target / relative) == expected, f"Source hash differs: {relative}")
        for relative, expected in packet["artifactHashes"].items():
            require(digest(lane / relative) == expected, f"Reviewed artifact differs: {relative}")
        require(digest(lane / "ADMISSION.json") == ADMISSION_SHA256, "Root dependency admission differs")
        require(digest(lane / "HOST-PACKET.json") == HOST_PACKET_SHA256, "Accepted host packet differs")
        require(digest(lane / "BASELINE-PACKET.json") == BASELINE_PACKET_SHA256, "Original ordered baseline differs")
        require(digest(lane / "ORDERED-PACKET.json") == ORDERED_PACKET_SHA256, "Original diagnostic packet differs")
        require(digest(lane / "reference/DESIGN.md.txt") == DESIGN_SHA256, "Reviewed observation design differs")
        require(digest(lane / "Package.resolved") == LOCK_SHA256, "Admitted dependency lock differs")
        admission = json.loads((lane / "ADMISSION.json").read_text())
        require(admission["admitted"] is True and admission["source"] == SOURCE
                and admission["lockSha256"] == LOCK_SHA256 and admission["hostPacketSha256"] == HOST_PACKET_SHA256,
                "Dependency admission does not bind this source and host")
        for relative, expected in admission["hostSourceHashes"].items():
            original = lane / "reference/FocusUITests.swift" if relative == "UITests/FocusUITests.swift" else lane / relative
            require(digest(original) == expected, f"Admitted original host input differs: {relative}")
        require(digest(lane / "UITests/FocusUITests.swift") == packet["diagnosticUiTestsSha256"],
                "Reviewed diagnostic UI-test input differs")
        lock = json.loads((lane / "Package.resolved").read_text())
        require(lock["pins"] == admission["pins"] and lock["originHash"] == admission["originHash"]
                and lock["version"] == admission["lockFormatVersion"], "Admitted revision set differs")
        require(digest(target / "apps/shared/OpenClawKit/Package.swift") == admission["sourcePackageSha256"],
                "Admitted package declaration differs")
        for name in ("ADMISSION.json", "Package.resolved", "HOST-PACKET.json"):
            shutil.copyfile(lane / name, evidence / name)
        receipt["dependencyPins"] = admission["pins"]
        receipt["admittedOriginalHostSourceHashes"] = admission["hostSourceHashes"]
        receipt["hostSourceHashes"] = {
            relative: digest(lane / relative) for relative in admission["hostSourceHashes"]
        }
        receipt["hostSourceHashes"]["UITests/ComposerTraceCapture.swift"] = digest(lane / "UITests/ComposerTraceCapture.swift")
        receipt["baseSourceHashes"] = packet["sourceHashes"]
        receipt["sourceHashes"] = packet["instrumentedSourceHashes"]
        require(not (target / packet["helperPath"]).exists(), "Unexpected existing observation helper")
        shutil.copyfile(lane / "Overlay/ChatComposerTextViewIOS.swift", target / packet["ownerPath"])
        shutil.copyfile(lane / "Overlay/ComposerObservation.swift", target / packet["helperPath"])
        overlay_installed = True
        verify_overlay("installed")
        for relative in ("Overlay/ChatComposerTextViewIOS.swift", "Overlay/ComposerObservation.swift", "source-overlay.patch"):
            copied = evidence / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(lane / relative, copied)

        _, xcode = command("xcode-version", ["xcodebuild", "-version"])
        require(xcode.strip() == "Xcode 26.6\nBuild version 17F113", "Xcode pin unavailable")
        command("swift-version", ["swift", "--version"])
        _, sdk_text = command("ios-sdk-path", ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"])
        sdk = Path(sdk_text.strip())
        for framework, name in (("UIKit", "UITextView.h"), ("UIKit", "UIView.h"), ("CoreFoundation", "CFNotificationCenter.h")):
            shutil.copyfile(sdk / "System/Library/Frameworks" / (framework + ".framework") / "Headers" / name, evidence / name)
        _, xcodegen = command("xcodegen-version", ["xcodegen", "--version"])
        require(xcodegen.strip() == "Version: 2.46.0", "XcodeGen pin unavailable")
        _, node = command("node-version", ["node", "--version"])
        require(node.strip() == "v24.20.0", "Node pin unavailable")
        _, pnpm = command("pnpm-version", ["pnpm", "--version"])
        require(pnpm.strip() == "12.3.4", "pnpm pin unavailable")
        require((target / "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid").is_dir(),
                "Canonical Mermaid generation must precede this lane")

        _, runtime_text = command("simulator-runtimes", ["xcrun", "simctl", "list", "runtimes", "--json"])
        runtimes = [item for item in json.loads(runtime_text)["runtimes"]
                    if item["identifier"] == "com.apple.CoreSimulator.SimRuntime.iOS-26-5"
                    and item["version"] == "26.5" and item["isAvailable"]]
        require(len(runtimes) == 1, "Exact iOS26.5 runtime unavailable")
        _, types_text = command("simulator-types", ["xcrun", "simctl", "list", "devicetypes", "--json"])
        types = [item for item in json.loads(types_text)["devicetypes"]
                 if item["identifier"] == "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"]
        require(len(types) == 1, "Exact iPhone17Pro type unavailable")
        receipt["runtime"] = runtimes[0]
        receipt["deviceType"] = types[0]
        _, created = command("simulator-create", ["xcrun", "simctl", "create", "Focus136179-" + work.name,
                                                  types[0]["identifier"], runtimes[0]["identifier"]])
        device = str(uuid.UUID(created.strip())).upper()
        receipt["simulatorUDID"] = device
        command("simulator-boot", ["xcrun", "simctl", "boot", device])
        command("simulator-boot-status", ["xcrun", "simctl", "bootstatus", device, "-b"], timeout=180)

        project_root = work / "project"
        project_root.mkdir()
        for directory in ("Host", "UITests"):
            shutil.copytree(lane / directory, project_root / directory)
        template = (lane / "project.template.yml").read_text()
        require(template.count("__PACKAGE_PATH__") == 1, "Invalid project template")
        (project_root / "project.yml").write_text(template.replace(
            "__PACKAGE_PATH__", json.dumps(str(target / "apps/shared/OpenClawKit"))))
        command("generate-project", ["xcodegen", "generate", "--spec", project_root / "project.yml"], cwd=project_root)
        project = project_root / "FocusProof.xcodeproj"
        derived = work / "DerivedData"
        build_args = ["xcodebuild", "-project", project, "-scheme", "FocusProof", "-configuration", "Debug",
                      "-destination", "id=" + device, "-derivedDataPath", derived,
                      "-clonedSourcePackagesDirPath", work / "SourcePackages"]
        require(not list(project.rglob("Package.resolved")), "Unexpected preexisting project lock")
        resolved = project / "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        resolved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(lane / "Package.resolved", resolved)
        require(digest(resolved) == LOCK_SHA256, "Installed lock differs")
        receipt["resolvedSha256"] = LOCK_SHA256
        receipt["resolvedPackages"] = lock
        receipt["projectLockPath"] = str(resolved.relative_to(project))
        locked_args = build_args + ["-disableAutomaticPackageResolution", "-onlyUsePackageVersionsFromResolvedFile"]
        command("build-for-testing", locked_args + ["build-for-testing"], timeout=1200)

        def verify_dependency_checkouts(phase):
            require(digest(resolved) == LOCK_SHA256, "Package lock drifted")
            expected = {pin["state"]["revision"]: pin["identity"] for pin in admission["pins"]}
            require(len(expected) == len(admission["pins"]), "Admitted revisions are not distinct")
            directories = sorted(path for path in (work / "SourcePackages/checkouts").iterdir() if path.is_dir())
            require(len(directories) == len(expected), "Unexpected dependency checkout set")
            observed = {}
            for index, checkout in enumerate(directories):
                require(not checkout.is_symlink(), "Unexpected dependency checkout symlink")
                _, revision = command(f"dependency-{phase}-{index}-revision", ["git", "-C", checkout, "rev-parse", "HEAD"])
                revision = revision.strip()
                require(revision in expected and revision not in observed, "Dependency revision differs from admitted graph")
                _, state = command(f"dependency-{phase}-{index}-status", ["git", "-C", checkout, "status", "--porcelain"])
                require(not state.strip(), "Dependency checkout changed")
                observed[revision] = {"identity": expected[revision], "checkout": str(checkout)}
            receipt.setdefault("dependencyCheckoutChecks", {})[phase] = observed

        verify_dependency_checkouts("built")

        products = derived / "Build/Products/Debug-iphonesimulator"
        for name, bundle_id in (("FocusHost.app", "org.openclaw.tests.focus136179"),
                               ("FocusUITests-Runner.app", "org.openclaw.tests.focus136179.uitests.xctrunner")):
            app = products / name
            with (app / "Info.plist").open("rb") as handle:
                require(plistlib.load(handle)["CFBundleIdentifier"] == bundle_id, "Unexpected installed identity")
            command("signature-verify-" + name, ["codesign", "--verify", "--deep", "--strict", app])
            command("signature-details-" + name, ["codesign", "--display", "--verbose=4", app])

        for scenario, test in TESTS.items():
            result_bundle = evidence / (scenario + ".xcresult")
            code, log = command("test-" + scenario, locked_args + [
                "test-without-building", "-parallel-testing-enabled", "NO",
                "-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "120",
                "-maximum-test-execution-time-allowance", "120", "-resultBundlePath", result_bundle,
                "-only-testing:FocusUITests/FocusUITests/" + test], timeout=240, check=False)
            require(digest(resolved) == LOCK_SHA256, "Package lock changed during test launch")
            export_attachments(result_bundle)
            _, summary_text = command("summary-" + scenario, ["xcrun", "xcresulttool", "get", "test-results",
                                                              "summary", "--path", result_bundle, "--compact"])
            summary = json.loads(summary_text)
            records = [json.loads(match) for match in re.findall(r"FOCUS_RECORD (\{[^\n]*\})", log)]
            require(len(records) == 1, f"{scenario}: missing or duplicate fixture result")
            record = records[0]
            receipt["diagnosticRecords"].append(record)
            (evidence / (scenario + "-record.json")).write_text(json.dumps(record, indent=2) + "\n")
            capture_composer(scenario, log)
            require(record["scenario"] == scenario and record["version"] == 1, "Wrong fixture result")
            require(record["foreground"] and record["sideEffects"] == "0" and record["bootstrapError"] == "none",
                    f"{scenario}: bootstrap/effect failure")
            require(summary["totalTestCount"] == 1 and summary["skippedTests"] == 0 and summary["expectedFailures"] == 0,
                    f"{scenario}: incomplete native result")
            failures = summary["testFailures"]
            if record["outcome"] == "passed":
                require(code == 0 and summary["result"] == "Passed" and summary["passedTests"] == 1
                        and summary["failedTests"] == 0 and failures == [], f"{scenario}: native result disagreement")
            else:
                require(scenario != "passive" and record["phase"] in FOCUS_FAILURES, f"{scenario}: not an intended focus failure")
                require(record["outcome"] == "failed" and code == 65 and summary["result"] == "Failed"
                        and summary["passedTests"] == 0 and summary["failedTests"] == 1 and len(failures) == 1,
                        f"{scenario}: native failure is not isolated")
                require(f"FOCUS_ASSERT {scenario} {record['phase']}" in json.dumps(failures),
                        f"{scenario}: native assertion does not match fixture observation")
            receipt["cases"].append(record)
        require(any(row["scenario"] == "secure" and row["outcome"] == "failed" for row in receipt["cases"]),
                "NONREPRODUCTION: protected input did not demonstrate focus loss")
        verify_dependency_checkouts("completed")
        verify_overlay("completed")
        receipt["verdict"] = "instrumented diagnostics complete; not uninstrumented baseline qualification"
        return_code = 0
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    finally:
        if overlay_installed:
            try:
                verify_overlay("final")
            except Exception as error:
                receipt["sourceOverlayError"] = str(error)
                return_code = 1
        try:
            if resolved is not None:
                if resolved.exists():
                    shutil.copyfile(resolved, evidence / "installed-Package.resolved")
                    receipt["installedLockSha256"] = digest(resolved)
                    if receipt["installedLockSha256"] != LOCK_SHA256:
                        receipt["lockDrift"] = True
                        return_code = 1
                else:
                    receipt["installedLockMissing"] = True
                    return_code = 1
        except Exception as error:
            receipt["lockCaptureError"] = str(error)
            return_code = 1
        for result_bundle in sorted(evidence.glob("*.xcresult")):
            if result_bundle.stem not in exports_attempted:
                try:
                    export_attachments(result_bundle)
                except Exception as error:
                    receipt.setdefault("attachmentErrors", []).append(f"{result_bundle.stem}: {error}")
        if device is not None:
            for action in ("shutdown", "delete"):
                try:
                    command("simulator-" + action, ["xcrun", "simctl", action, device], check=False)
                except Exception as error:
                    receipt.setdefault("cleanupErrors", []).append(f"{action}: {error}")
            try:
                _, remaining = command("simulator-cleanup-inventory", ["xcrun", "simctl", "list", "devices", "--json"])
                identifiers = {item["udid"].lower() for group in json.loads(remaining)["devices"].values() for item in group}
                require(device.lower() not in identifiers, "Owned Simulator remains after deletion")
            except Exception as error:
                receipt.setdefault("cleanupErrors", []).append(str(error))
        if receipt.get("cleanupErrors") or receipt.get("attachmentErrors"):
            return_code = 1
        receipt["exitCode"] = return_code
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (evidence / "exit-code.txt").write_text(str(return_code) + "\n")
    return return_code


if __name__ == "__main__":
    sys.exit(main())
