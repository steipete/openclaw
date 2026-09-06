"""Capture a proposed SwiftPM lock. This does not admit it or execute UI proof."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from urllib.parse import urlsplit
import uuid

SOURCE = "a1707cb38032c6d94e3a3c49d0de4e68f62539b9"
HOST_PACKET_SHA256 = "c2cb5165548264cd2d8076d7f4a07f38e3f139e78daa09958ac0959fea76e0c5"
DIRECT = {
    "elevenlabskit": ("https://github.com/steipete/elevenlabskit", "0.1.1"),
    "grdb.swift": ("https://github.com/groue/grdb.swift", "7.11.1"),
    "swiftmath": ("https://github.com/mgriebling/swiftmath", "1.7.3"),
    "swift-markdown": ("https://github.com/swiftlang/swift-markdown", "0.8.0"),
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    target, lane, evidence = map(lambda value: Path(value).resolve(), sys.argv[1:4])
    mode = sys.argv[4]
    evidence.mkdir(parents=True, exist_ok=True)
    receipt = {
        "source": SOURCE,
        "stage": "resolution-only",
        "admitted": False,
        "uiExecutionRequested": False,
        "simulatorCreated": False,
        "appBuildRequested": False,
        "appSigningRequested": False,
        "acceptedHostPacketSha256": HOST_PACKET_SHA256,
        "commands": [],
    }
    code = 1
    work = None
    project = None

    def capture_locks():
        files = list(project.rglob("Package.resolved")) if project is not None and project.exists() else []
        receipt["lockFilesFound"] = []
        for index, resolved in enumerate(files):
            name = "Package.resolved" if len(files) == 1 else f"partial-{index}-Package.resolved"
            shutil.copyfile(resolved, evidence / name)
            receipt["lockFilesFound"].append({
                "file": name, "projectRelativePath": str(resolved.relative_to(project)), "sha256": digest(resolved),
            })
        return files

    def command(name, argv, timeout=120, check=True, cwd=target):
        log = evidence / (name + ".log")
        entry = {"name": name, "argv": list(map(str, argv)), "timeoutSeconds": timeout}
        receipt["commands"].append(entry)
        with log.open("wb") as output:
            process = subprocess.Popen(entry["argv"], cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                result = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                entry["timedOut"] = True
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                except ProcessLookupError:
                    process.wait(timeout=5)
                raise
        entry["exitCode"] = result
        if check:
            require(result == 0, f"{name} failed; inspect retained log")
        return result, log.read_text(errors="replace")

    try:
        require(mode == "baseline" and os.environ.get("PROOF_VARIANT") == "resolution-only",
                "This packet only supports the explicit resolution-only preflight")
        require(os.environ.get("CI") in {"true", "1"} and os.environ.get("GITHUB_ACTIONS") == "true",
                "Missing real CI identity")
        require(os.environ.get("RUNNER_OS") == "macOS" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
                "The reviewed secretless hosted macOS route is required")
        require(os.environ.get("SOURCE_SHA") == SOURCE, "Unexpected source pin")
        require(digest(lane / "HOST-PACKET.json") == HOST_PACKET_SHA256, "Accepted host packet differs")
        host_packet = json.loads((lane / "HOST-PACKET.json").read_text())
        packet = json.loads((lane / "PACKET.json").read_text())
        for relative, expected in packet["artifactHashes"].items():
            require(digest(lane / relative) == expected, f"Reviewed artifact differs: {relative}")
        for relative in ("Host/FocusHost.swift", "UITests/FocusUITests.swift", "project.template.yml"):
            require(digest(lane / relative) == host_packet["artifactHashes"][relative], "Host/project drifted")
        _, head = command("source-head", ["git", "rev-parse", "HEAD"])
        require(head.strip() == SOURCE, "Wrong target checkout")
        _, clean = command("source-status", ["git", "status", "--porcelain"])
        require(not clean.strip(), "Target must begin clean")
        for relative, expected in host_packet["sourceHashes"].items():
            require(digest(target / relative) == expected, f"Source hash differs: {relative}")
        receipt["sourceHashes"] = host_packet["sourceHashes"]
        receipt["hostSourceHashes"] = {
            relative: host_packet["artifactHashes"][relative]
            for relative in ("Host/FocusHost.swift", "UITests/FocusUITests.swift", "project.template.yml")
        }
        _, xcode = command("xcode-version", ["xcodebuild", "-version"])
        require(xcode.strip() == "Xcode 26.6\nBuild version 17F113", "Xcode pin unavailable")
        _, swift = command("swift-version", ["swift", "--version"])
        receipt["xcode"] = xcode.strip()
        receipt["swift"] = swift.strip()
        _, xcodegen = command("xcodegen-version", ["xcodegen", "--version"])
        require(xcodegen.strip() == "Version: 2.46.0", "XcodeGen pin unavailable")
        _, node = command("node-version", ["node", "--version"])
        require(node.strip() == "v24.20.0", "Node pin unavailable")
        _, pnpm = command("pnpm-version", ["pnpm", "--version"])
        require(pnpm.strip() == "12.3.4", "pnpm pin unavailable")

        work = Path(os.environ["RUNNER_TEMP"]) / ("focus-resolution-" + uuid.uuid4().hex)
        work.mkdir()
        receipt["work"] = str(work)
        project_root = work / "project"
        project_root.mkdir()
        for directory in ("Host", "UITests"):
            shutil.copytree(lane / directory, project_root / directory)
        template = (lane / "project.template.yml").read_text()
        require(template.count("__PACKAGE_PATH__") == 1, "Invalid project template")
        project_text = template.replace("__PACKAGE_PATH__", json.dumps(str(target / "apps/shared/OpenClawKit")))
        (project_root / "project.yml").write_text(project_text)
        (evidence / "generated-project.yml").write_text(project_text)
        command("generate-project", ["xcodegen", "generate", "--spec", project_root / "project.yml"], cwd=project_root)
        project = project_root / "FocusProof.xcodeproj"
        shutil.copyfile(project / "project.pbxproj", evidence / "generated-project.pbxproj")
        require(not list(project.rglob("Package.resolved")), "Unexpected preexisting dependency lock")
        derived = work / "DerivedData"
        resolve_code, _ = command("resolve-packages", [
            "xcodebuild", "-project", project, "-scheme", "FocusProof", "-configuration", "Debug",
            "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derived,
            "-clonedSourcePackagesDirPath", work / "SourcePackages", "-resolvePackageDependencies"],
            timeout=600, check=False)
        resolved_files = capture_locks()
        require(resolve_code == 0, "Package resolution failed; any captured lock remains unadmitted")
        require(len(resolved_files) == 1, "Expected one generated test-project package resolution")
        resolved = resolved_files[0]
        lock = json.loads(resolved.read_text())
        pins = lock.get("pins")
        require(isinstance(pins, list) and pins, "Missing complete SwiftPM pin set")
        identities = set()
        by_identity = {}
        for pin in pins:
            identity = pin["identity"]
            require(isinstance(identity, str) and identity not in identities, "Duplicate or invalid package identity")
            identities.add(identity)
            require(pin["kind"] == "remoteSourceControl", "Non-SCM dependency needs separate admission")
            location = urlsplit(pin["location"])
            require(location.scheme == "https" and location.hostname and not location.username and not location.password
                    and not location.query and not location.fragment, "Unexpected dependency locator")
            require(re.fullmatch(r"[0-9a-f]{40}", pin["state"].get("revision", "")) is not None,
                    "Every dependency must have an immutable Git revision")
            by_identity[identity] = pin
        for identity, (location, version) in DIRECT.items():
            require(identity in by_identity, f"Missing direct dependency: {identity}")
            pin = by_identity[identity]
            require(pin["location"].rstrip("/").removesuffix(".git").lower() == location,
                    f"Direct dependency repository changed: {identity}")
            require(pin["state"].get("version") == version, f"Direct dependency version changed: {identity}")
        products = derived / "Build/Products"
        require(not list(products.rglob("*.app")) and not list(products.rglob("*.xctest")),
                "Resolution preflight unexpectedly produced an app or test bundle")
        for relative, expected in host_packet["sourceHashes"].items():
            require(digest(target / relative) == expected, f"Source changed during resolution: {relative}")
        command("source-final-diff", ["git", "diff", "--exit-code"])
        receipt["resolvedSha256"] = digest(resolved)
        receipt["resolvedVersion"] = lock["version"]
        receipt["pins"] = pins
        receipt["directRequirements"] = DIRECT
        receipt["verdict"] = "captured-unadmitted-resolution; no UI baseline executed"
        (evidence / "RESOLUTION-CANDIDATE.json").write_text(json.dumps(receipt, indent=2) + "\n")
        code = 0
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    finally:
        try:
            capture_locks()
        except Exception as error:
            receipt["lockCaptureError"] = f"{type(error).__name__}: {error}"
            code = 1
        # Keep generated workspace/checkouts until the disposable runner is discarded,
        # including partial resolution failures. All durable review inputs are copied above.
        receipt["workspaceDisposition"] = "retained-until-disposable-runner-teardown"
        receipt["exitCode"] = code
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (evidence / "exit-code.txt").write_text(str(code) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
