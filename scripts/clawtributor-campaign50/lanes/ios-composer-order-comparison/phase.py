"""One uninstrumented comparison phase with the original four-case UI sequence."""
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
import time
import uuid

from classify import TESTS, COMPATIBILITY, classify

SOURCE = "a1707cb38032c6d94e3a3c49d0de4e68f62539b9"
LOCK_SHA256 = "65a6c7259f2012d6cad33d2386b94fa653ce1080ead2015f858d8d1ae3648a0d"
ADMISSION_SHA256 = "9b61a58e502d2aa3ba0bdc336cbbf03b3208ee96289bf1b0a22d8b3e8a9ec3e8"
HOST_PACKET_SHA256 = "c2cb5165548264cd2d8076d7f4a07f38e3f139e78daa09958ac0959fea76e0c5"
BASELINE_PACKET_SHA256 = "04b38400f898113ba85ef931d3cf912dad30dcd0aa8eb150ae0424d69896b235"
OWNER = "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatComposerTextViewIOS.swift"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def drain_process_group(process):
    result = {"pgid": process.pid, "gone": False, "signals": []}

    def probe():
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            process.poll()
            result["leaderExitCode"] = process.returncode
            result["gone"] = process.returncode is not None
            if not result["gone"]:
                result["error"] = "Group absent but direct child retirement unproven"
            return "absent"
        except OSError as error:
            result["error"] = str(error)
            return "unknown"
        return "present"

    if probe() != "present":
        return result
    for termination_signal in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, termination_signal)
            result["signals"].append(termination_signal.name)
        except ProcessLookupError:
            pass
        except OSError as error:
            result["error"] = str(error)
            return result
        deadline = time.monotonic() + 5
        while True:
            if probe() != "present":
                return result
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    result["error"] = "Process group still exists after bounded TERM/KILL drain"
    return result


def main():
    target, lane, evidence = map(lambda value: Path(value).resolve(), sys.argv[1:4])
    mode = sys.argv[4]
    require(mode in {"baseline", "candidate"}, "Wrong comparison phase")
    require(os.environ.get("PROOF_VARIANT") == "composer-order-comparison", "Wrong proof variant")
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
    packet = None
    dependency_ready = False
    project_root = None
    resources_safe = True
    receipt = {"source": SOURCE, "mode": mode, "stage": "composer-order-comparison", "work": str(work),
               "admittedLockSha256": LOCK_SHA256, "commands": [], "cases": [], "diagnosticRecords": [],
               "caseOrder": list(TESTS), "attachments": {}, "compatibility": [], "finalBindingVerified": False}

    def command(name, argv, timeout=120, check=True, cwd=target):
        nonlocal resources_safe
        require(resources_safe, "Command group retirement unproven; resources retained")
        log = evidence / (name + ".log")
        receipt["commands"].append({"name": name, "argv": list(map(str, argv)), "timeoutSeconds": timeout})
        with log.open("wb") as output:
            resources_safe = False
            process = None
            receipt["commands"][-1]["groupRetirement"] = {
                "pgid": None, "gone": False, "state": "spawn-pending",
            }
            try:
                process = subprocess.Popen(list(map(str, argv)), cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                receipt["commands"][-1]["groupRetirement"] = {
                    "pgid": process.pid, "gone": False, "state": "wait-pending",
                }
                try:
                    code = process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    receipt["commands"][-1]["timedOut"] = True
                    raise
            finally:
                if process is not None:
                    try:
                        retirement = drain_process_group(process)
                    except BaseException as error:
                        receipt["commands"][-1]["groupRetirement"] = {
                            "pgid": process.pid, "gone": False, "error": str(error),
                        }
                        raise
                    receipt["commands"][-1]["groupRetirement"] = retirement
                    resources_safe = retirement["gone"] is True
        require(resources_safe, "Command group retirement unproven; resources retained")
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
            "mode": mode,
            "ownerSha256": receipt["effectiveSourceHashes"][OWNER],
            "compatibilitySourceHashes": receipt["compatibilitySourceHashes"],
            "hostSha256": receipt["hostSourceHashes"]["Host/FocusHost.swift"],
            "uiTestsSha256": receipt["hostSourceHashes"]["UITests/FocusUITests.swift"],
            "simulatorUDID": device,
            "files": [{"path": str(path.relative_to(evidence)), "sha256": digest(path)} for path in files],
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
        if mode == "candidate":
            require(digest(lane / "candidate/ChatComposerTextViewIOS.swift") == packet["candidateOwnerSha256"],
                    "Candidate owner differs")
            shutil.copyfile(lane / "candidate/ChatComposerTextViewIOS.swift", target / OWNER)
        receipt["effectiveSourceHashes"] = dict(packet["sourceHashes"])
        if mode == "candidate":
            receipt["effectiveSourceHashes"][OWNER] = packet["candidateOwnerSha256"]
        require(digest(lane / "ADMISSION.json") == ADMISSION_SHA256, "Root dependency admission differs")
        require(digest(lane / "HOST-PACKET.json") == HOST_PACKET_SHA256, "Accepted host packet differs")
        require(digest(lane / "BASELINE-PACKET.json") == BASELINE_PACKET_SHA256, "Original ordered baseline differs")
        require(digest(lane / "Package.resolved") == LOCK_SHA256, "Admitted dependency lock differs")
        admission = json.loads((lane / "ADMISSION.json").read_text())
        require(admission["admitted"] is True and admission["source"] == SOURCE
                and admission["lockSha256"] == LOCK_SHA256 and admission["hostPacketSha256"] == HOST_PACKET_SHA256,
                "Dependency admission does not bind this source and host")
        for relative, expected in admission["hostSourceHashes"].items():
            original = lane / relative
            if relative == "UITests/FocusUITests.swift":
                original = lane / "reference/FocusUITests.swift"
            elif relative == "project.template.yml":
                original = lane / "reference/project.template.yml"
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
        receipt["sourceHashes"] = packet["sourceHashes"]
        receipt["packetSha256"] = digest(lane / "PACKET.json")
        receipt["compatibilitySourceHashes"] = {
            relative: digest(lane / relative) for relative in (
                "CompatibilityHost/CompatibilityHost.swift", "CompatibilityTests/ComposerCompatibilityTests.swift")
        }

        _, xcode = command("xcode-version", ["xcodebuild", "-version"])
        require(xcode.strip() == "Xcode 26.6\nBuild version 17F113", "Xcode pin unavailable")
        command("swift-version", ["swift", "--version"])
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
        for directory in ("Host", "UITests", "CompatibilityHost", "CompatibilityTests"):
            shutil.copytree(lane / directory, project_root / directory)
        template = (lane / "project.template.yml").read_text()
        require(template.count("__PACKAGE_PATH__") == 1, "Invalid project template")
        (project_root / "project.yml").write_text(template.replace(
            "__PACKAGE_PATH__", json.dumps(str(target / "apps/shared/OpenClawKit"))))
        command("generate-project", ["xcodegen", "generate", "--spec", project_root / "project.yml"], cwd=project_root)
        project = project_root / "FocusProof.xcodeproj"
        receipt["generatedProjectHashes"] = {
            str(path.relative_to(project_root)): digest(path)
            for path in sorted(project.rglob("*")) if path.is_file()
        }
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

        dependency_ready = True
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
            record["classification"] = classify(scenario, record, summary, code, device)
            receipt["cases"].append(record)

        # A separate hosted test app runs only after the original four UI cases.
        compatibility_args = list(locked_args)
        compatibility_args[compatibility_args.index("FocusProof")] = "CompatibilityProof"
        command("compatibility-build-for-testing", compatibility_args + ["build-for-testing"], timeout=1200)
        compatibility_app = products / "CompatibilityHost.app"
        with (compatibility_app / "Info.plist").open("rb") as handle:
            require(plistlib.load(handle)["CFBundleIdentifier"] == "org.openclaw.tests.composercompat", "Wrong compatibility app")
        command("signature-verify-compatibility", ["codesign", "--verify", "--deep", "--strict", compatibility_app])
        command("signature-details-compatibility", ["codesign", "--display", "--verbose=4", compatibility_app])
        compatibility_bundle = compatibility_app / "PlugIns/ComposerCompatibilityTests.xctest"
        command("signature-verify-compatibility-tests", ["codesign", "--verify", "--deep", "--strict", compatibility_bundle])
        for scenario, test in COMPATIBILITY.items():
            name = "compatibility-" + scenario
            result_bundle = evidence / (name + ".xcresult")
            code, log = command("test-" + name, compatibility_args + [
                "test-without-building", "-parallel-testing-enabled", "NO",
                "-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "120",
                "-maximum-test-execution-time-allowance", "120", "-resultBundlePath", result_bundle,
                "-only-testing:ComposerCompatibilityTests/ComposerCompatibilityTests/" + test], timeout=240, check=False)
            require(digest(resolved) == LOCK_SHA256, "Package lock changed during compatibility launch")
            export_attachments(result_bundle)
            _, summary_text = command("summary-" + name, ["xcrun", "xcresulttool", "get", "test-results",
                "summary", "--path", result_bundle, "--compact"])
            records = [json.loads(match) for match in re.findall(r"COMPOSER_COMPAT_RECORD (\{[^\n]*\})", log)]
            require(len(records) == 1, f"{name}: missing or duplicate compatibility result")
            record = records[0]
            (evidence / (name + "-record.json")).write_text(json.dumps(record, indent=2) + "\n")
            record["classification"] = classify(scenario, record, json.loads(summary_text), code, device, compatibility=True)
            receipt["compatibility"].append(record)
        receipt["verdict"] = "Completed native observations; comparison owns acceptance"
        return_code = 0
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    finally:
        try:
            require(resources_safe, "Final binding inspection skipped: command group retirement unproven")
            require(packet is not None and "effectiveSourceHashes" in receipt, "Missing admitted effective source")
            for relative, expected in receipt["effectiveSourceHashes"].items():
                require(digest(target / relative) == expected, f"Source changed during proof: {relative}")
            require(project_root is not None, "Missing generated test host")
            for relative in ("Host/FocusHost.swift", "UITests/FocusUITests.swift",
                             "CompatibilityHost/CompatibilityHost.swift", "CompatibilityTests/ComposerCompatibilityTests.swift"):
                require(digest(project_root / relative) == packet["artifactHashes"][relative],
                        f"Copied host input changed: {relative}")
            for relative, expected in receipt["generatedProjectHashes"].items():
                require(digest(project_root / relative) == expected, f"Generated project changed: {relative}")
            _, final_head = command("source-final-head", ["git", "rev-parse", "HEAD"])
            require(final_head.strip() == SOURCE, "Source HEAD changed")
            _, final_status = command("source-final-status", ["git", "status", "--porcelain"])
            expected_status = " M " + OWNER if mode == "candidate" else ""
            require(final_status.rstrip() == expected_status, "Unexpected final source changes")
            command("source-final-diff", ["git", "diff", "--binary"], check=False)
            if dependency_ready:
                verify_dependency_checkouts("completed")
            require(dependency_ready, "Dependency graph was not built and checked")
            receipt["finalBindingVerified"] = True
        except Exception as error:
            receipt["finalBindingError"] = str(error)
            return_code = 1
        try:
            if resources_safe and resolved is not None:
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
        for result_bundle in (sorted(evidence.glob("*.xcresult")) if resources_safe else ()):
            if not resources_safe:
                break
            if result_bundle.stem not in exports_attempted:
                try:
                    export_attachments(result_bundle)
                except Exception as error:
                    receipt.setdefault("attachmentErrors", []).append(f"{result_bundle.stem}: {error}")
        if resources_safe and device is not None:
            for action in ("shutdown", "delete"):
                if not resources_safe:
                    break
                try:
                    command("simulator-" + action, ["xcrun", "simctl", action, device], check=False)
                except Exception as error:
                    receipt.setdefault("cleanupErrors", []).append(f"{action}: {error}")
            try:
                require(resources_safe, "Simulator inventory skipped: command group retirement unproven")
                _, remaining = command("simulator-cleanup-inventory", ["xcrun", "simctl", "list", "devices", "--json"])
                identifiers = {item["udid"].lower() for group in json.loads(remaining)["devices"].values() for item in group}
                require(device.lower() not in identifiers, "Owned Simulator remains after deletion")
            except Exception as error:
                receipt.setdefault("cleanupErrors", []).append(str(error))
        if receipt.get("cleanupErrors") or receipt.get("attachmentErrors"):
            return_code = 1
        if not resources_safe:
            receipt["cleanupIncomplete"] = True
            receipt["resourcesRetained"] = {
                "reason": "Command spawn/wait did not establish safe completion or retirement",
                "work": str(work), "target": str(target), "evidence": str(evidence),
                "simulatorUDID": device,
                "unprovenGroups": [row["groupRetirement"] for row in receipt["commands"]
                    if row.get("groupRetirement", {}).get("gone") is False],
            }
            return_code = 1
        receipt["commandGroupRetirementVerified"] = resources_safe
        receipt["exitCode"] = return_code
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (evidence / "exit-code.txt").write_text(str(return_code) + "\n")
    return return_code


if __name__ == "__main__":
    sys.exit(main())
