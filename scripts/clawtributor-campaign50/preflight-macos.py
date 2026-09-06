"""Trusted workflow preflight; never executes target scripts or imports target code."""
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys

target = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
log_root = evidence / "preflight"
log_root.mkdir(exist_ok=True)
receipt = {"phase": "host", "passed": False, "commands": []}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(name, args, env=None):
    entry = {"name": name}
    receipt["commands"].append(entry)
    log = log_root / (name + ".log")
    with log.open("wb") as output:
        process = subprocess.Popen(args, stdout=output, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            entry["timedOut"] = True
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    continue
            require(process.poll() is not None, f"{name} timed out without confirmed process exit")
        entry["exitCode"] = process.returncode
    require(not entry.get("timedOut") and process.returncode == 0,
            f"{name} failed; inspect its retained log")
    return log.read_text(errors="replace").strip()


try:
    actual = {key: os.environ.get(key) for key in
              ("RUNNER_ENVIRONMENT", "RUNNER_OS", "GITHUB_ACTIONS", "CI")}
    receipt["hostMarkers"] = actual
    require(actual == {"RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "macOS",
                       "GITHUB_ACTIONS": "true", "CI": "true"}, "Actual hosted macOS identity is required")
    require(sys.platform == "darwin" and platform.machine() == "arm64", "Expected the macos-26 arm64 image")
    require(Path(os.environ.get("RUNNER_TEMP", "")).is_dir() and os.environ.get("RUNNER_TEMP"),
            "Missing actual runner temporary directory")
    for tool in ("git", "xcrun", "xcodebuild", "sw_vers", "sysctl",
                 "curl", "unzip", "shasum", "python3"):
        require(shutil.which(tool), f"Required image tool is unavailable: {tool}")
    receipt["macOSVersion"] = command("macos-version", ["sw_vers", "-productVersion"])
    require(receipt["macOSVersion"].split(".")[0] == "26", "Expected macOS major version 26")
    receipt["macOSBuild"] = command("macos-build", ["sw_vers", "-buildVersion"])
    receipt["architecture"] = platform.machine()
    receipt["kernel"] = platform.release()
    receipt["logicalCpuCount"] = int(command("logical-cpus", ["sysctl", "-n", "hw.logicalcpu"]))
    receipt["memoryBytes"] = int(command("memory-bytes", ["sysctl", "-n", "hw.memsize"]))
    receipt["imageVersion"] = os.environ.get("ImageVersion")
    receipt["phase"] = "source"
    expected = os.environ.get("SOURCE_SHA", "")
    require(re.fullmatch(r"[a-f0-9]{40}", expected), "Invalid source pin")
    receipt["source"] = command("source-head", ["git", "-C", str(target), "rev-parse", "HEAD"])
    require(receipt["source"] == expected, "Wrong target source")
    require(command("source-initial-status", ["git", "-C", str(target), "status", "--porcelain"]) == "",
            "Initial target includes tracked or untracked changes")
    for checkout in (target, Path(__file__).resolve().parents[2]):
        header = subprocess.run(["git", "-C", str(checkout), "config", "--local", "--name-only", "--get-regexp",
                                 r"^http\..*\.extraheader$"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=30, check=False)
        require(header.returncode == 1 and not header.stdout,
                "Checkout retained credential headers or inspection failed")
    receipt["credentialHeadersAbsent"] = True
    receipt["phase"] = "xcode"
    candidates = (Path("/Applications/Xcode_26.6.app/Contents/Developer"),
                  Path("/Applications/Xcode-26.6.0.app/Contents/Developer"))
    developer = next((path for path in candidates if path.is_dir()), None)
    require(developer is not None, "Reviewed Xcode 26.6 is not installed; no fallback is allowed")
    tool_env = dict(os.environ, DEVELOPER_DIR=str(developer))
    receipt["developerDir"] = str(developer)
    receipt["xcode"] = command("xcode-version", ["xcodebuild", "-version"], tool_env)
    require(receipt["xcode"] == "Xcode 26.6\nBuild version 17F113", "Exact Xcode 26.6/17F113 is unavailable")
    receipt["swiftPath"] = command("swift-path", ["xcrun", "--find", "swift"], tool_env)
    receipt["swift"] = command("swift-version", ["xcrun", "swift", "--version"], tool_env)
    for sdk in ("macosx", "iphonesimulator"):
        receipt[sdk] = {
            "path": command(sdk + "-path", ["xcrun", "--sdk", sdk, "--show-sdk-path"], tool_env),
            "version": command(sdk + "-version", ["xcrun", "--sdk", sdk, "--show-sdk-version"], tool_env),
        }
    receipt["phase"] = "publish-developer-dir"
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write("developer_dir=" + str(developer) + "\n")
    receipt["phase"] = "ready-for-node-setup"
    receipt["passed"] = True
except Exception as error:
    receipt["error"] = f"{type(error).__name__}: {error}"
finally:
    (evidence / "macos-preflight.json").write_text(json.dumps(receipt, indent=2) + "\n")

sys.exit(0 if receipt["passed"] else 1)
