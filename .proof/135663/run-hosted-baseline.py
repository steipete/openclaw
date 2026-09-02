"""Draft proof controller. Never execute on an operator host or without parent review."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def snapshot(root):
    records = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        directory = Path(directory)
        for name in sorted(dirs + files):
            path = directory / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                records.append([relative, "link", os.readlink(path)])
            elif path.is_file():
                records.append([relative, "file", path.stat().st_mode & 0o777, digest(path.read_bytes())])
    return sorted(records)


def main():
    assets, product, output = [Path(value).resolve() for value in sys.argv[1:]]
    output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((assets / "publication-assets.json").read_text())
    required_assets = {"run-hosted-baseline.py", "MacNodeHostWorkerProcessGroupProof.swift", "MacNodeHostWorkerTests.swift", "binding.json"}
    require(set(manifest) == required_assets, "Publication manifest must bind the exact four executable/input assets")
    asset_checks = {name: {"expected": expected, "actual": digest((assets / name).read_bytes())} for name, expected in manifest.items()}
    write_json(output / "publication-assets-verified.json", asset_checks)
    require(all(row["expected"] == row["actual"] for row in asset_checks.values()), "Publication asset changed")
    require(Path(__file__).resolve() == assets / "run-hosted-baseline.py", "Controller is outside the verified publication")
    binding = json.loads((assets / "binding.json").read_text())
    require(binding["publicationReady"] is True, "Draft packet: parent review and publication binding are required")
    require(platform.system() == "Darwin", "macOS is required")
    for key, value in {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_OS": "macOS"}.items():
        require(os.environ.get(key) == value, "Real GitHub macOS runner markers are required")
    require(os.environ.get("RUNNER_TEMP"), "Missing runner temp")
    work = Path(tempfile.mkdtemp(prefix="oc-135663-", dir="/tmp")).resolve()
    home, tmp, tools = [work / name for name in ("home", "tmp", "bin")]
    for path in (home, tmp, tools):
        path.mkdir(mode=0o700)
    allowed = ("PATH", "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS", "RUNNER_TEMP", "RUNNER_TRACKING_ID", "LANG", "LC_ALL")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(HOME=str(home), TMPDIR=str(tmp) + "/", CI="true", GITHUB_ACTIONS="true", RUNNER_OS="macOS")
    env["PATH"] = str(tools) + os.pathsep + env["PATH"]
    steps = []
    unconfirmed_commands = []
    installed_before = None
    original_test = None
    proof_test = configuration_file = None
    configuration_bytes = None
    proof_test_created = configuration_created = False
    overlaid = False
    result_payload = None

    def run(name, command, allow_failure=False):
        started = time.monotonic()
        log = output / (name + ".log")
        step = {"name": name, "command": command, "state": "running", "exitCode": None,
                "processGroupClosure": "unconfirmed", "timeoutOwner": "GitHub job (90 minutes)",
                "nativeOwnerRequiresJoinedClosure": "scripts/test-macos-native.mts" in command}
        steps.append(step)
        write_json(output / "steps.json", steps)
        try:
            with log.open("wb") as stream:
                result = subprocess.run(command, cwd=product, env=env, stdout=stream, stderr=subprocess.STDOUT)
            step.update(state="leader-exited", exitCode=result.returncode)
            # The native owner requires joined closure, but emits no structured success receipt.
            # A status code alone cannot distinguish its returned failure from a cleanup exception.
            if result.returncode != 0:
                unconfirmed_commands.append(name)
            else:
                step["processGroupClosure"] = "not-observed-by-controller"
        except BaseException as error:
            step.update(state="interrupted-or-launch-failed", error=str(error))
            unconfirmed_commands.append(name)
            raise
        finally:
            step["seconds"] = time.monotonic() - started
            write_json(output / "steps.json", steps)
        if not allow_failure:
            require(result.returncode == 0, name + " failed; inspect its preserved log")
        return result.returncode, log.read_text(errors="replace")

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=product, env=env)

    def capture_sources(label, overlaid=False):
        errors = {}
        def observe(name, operation):
            try:
                return operation()
            except Exception as error:
                errors[name] = str(error)
                return None
        raw_index_path = observe("indexPath", lambda: Path(git("rev-parse", "--git-path", "index").decode().strip()))
        if raw_index_path is not None and not raw_index_path.is_absolute():
            raw_index_path = product / raw_index_path
        state = {
            "head": observe("head", lambda: git("rev-parse", "HEAD").decode().strip()),
            "tree": observe("tree", lambda: git("rev-parse", "HEAD^{tree}").decode().strip()),
            "rawIndexPath": str(raw_index_path) if raw_index_path is not None else None,
            "rawIndexSHA256": observe("rawIndex", lambda: digest(raw_index_path.read_bytes())),
            "stagedProjectionSHA256": observe("stagedProjection", lambda: digest(git("ls-files", "--stage", "-z"))),
            "trackedChanges": observe("trackedChanges", lambda: git("diff", "--name-only").decode().splitlines()),
            "installedLockSHA256": observe("installedLock", lambda: digest((product / "node_modules/.pnpm/lock.yaml").read_bytes())),
            "expectedInstalledLockSHA256": installed_before,
            "overlaid": overlaid, "sourceFiles": [], "errors": errors,
        }
        state["installedLockMatches"] = None if installed_before is None else state["installedLockSHA256"] == installed_before
        for row in binding["sourceBindings"]:
            expected = row["sha256"]
            if overlaid and row["path"] == binding["permanentTestPath"]:
                expected = binding["permanentTestSHA256"]
            actual = observe(row["path"], lambda row=row: digest((product / row["path"]).read_bytes()))
            state["sourceFiles"].append({"path": row["path"], "expected": expected, "actual": actual, "matches": expected == actual})
        write_json(output / (label + ".json"), state)
        return state

    def verify_sources(label, overlaid=False):
        state = capture_sources(label, overlaid)
        require(state["head"] == binding["baselineSHA"], "Product HEAD changed")
        require(state["tree"] == binding["baselineTree"], "Product Git tree changed")
        require(all(row["matches"] for row in state["sourceFiles"]), "Frozen source mismatch; inspect " + label + ".json")
        expected_paths = [binding["permanentTestPath"]] if overlaid else []
        require(state["trackedChanges"] == expected_paths, "Unexpected tracked source changes")
        return state

    try:
        before = verify_sources("source-before")
        index_before = before["rawIndexSHA256"]
        projection_before = before["stagedProjectionSHA256"]
        require(index_before and projection_before, "Could not bind raw index and staged projection")
        package = json.loads((product / "package.json").read_text())
        require(package["packageManager"] == binding["packageManager"], "Package manager integrity pin changed")
        node = shutil.which("node", path=env["PATH"])
        corepack = shutil.which("corepack", path=env["PATH"])
        require(node and corepack, "Bundled Node/Corepack setup is incomplete")
        _, version = run("node-version", [node, "--version"])
        require(version.strip() == "v" + binding["setupNodeVersion"], "Setup Node version differs")
        run("macos-version", ["sw_vers"])
        run("xcode-version", ["xcodebuild", "-version"])
        run("swift-version", ["swift", "--version"])
        _, sdk_path = run("sdk-path", ["xcrun", "--show-sdk-path"])
        sdk = Path(sdk_path.strip())
        write_json(output / "sdk-header-bindings.json", {
            name: digest((sdk / "usr/include" / name).read_bytes())
            for name in ("libproc.h", "sys/proc_info.h")
        })
        run("corepack-enable", [corepack, "enable", "--install-directory", str(tools)])
        run("corepack-prepare", [corepack, "prepare", binding["packageManager"], "--activate"])
        pnpm = str(tools / "pnpm")
        run("install", [pnpm, "install", "--frozen-lockfile"])
        installed_lock = product / "node_modules/.pnpm/lock.yaml"
        installed_before = digest(installed_lock.read_bytes())
        write_json(output / "install-lock-after-install.json", {
            "trackedLockSHA256": digest((product / "pnpm-lock.yaml").read_bytes()),
            "installedLockSHA256": installed_before,
        })
        run("full-build", [pnpm, "build"])
        run("apple-mermaid", [node, "scripts/prepare-apple-mermaid.mjs"])
        architecture = {"arm64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
        require(architecture, "Unsupported runner architecture")
        runtime_parent = work / "node-worker"
        run("canonical-stage-and-package-controls", ["bash", "scripts/stage-mac-node-worker.sh", str(runtime_parent), architecture])
        runtime = runtime_parent / architecture
        bundled_node = runtime / "bin/node"
        _, bundled_version = run("bundled-node-version", [str(bundled_node), "--version"])
        require(bundled_version.strip() == "v" + binding["bundledNodeVersion"], "Installer Node changed; inspect its exact libuv before proceeding")
        build_info = json.loads((runtime / "lib/node_modules/openclaw/dist/build-info.json").read_text())
        require(build_info["commit"] == binding["baselineSHA"], "Built worker provenance differs")
        runtime_before = snapshot(runtime)
        write_json(output / "runtime-before.json", runtime_before)
        write_json(output / "build-info.json", build_info)
        verify_sources("source-before-overlay")
        test_path = product / binding["permanentTestPath"]
        test_bytes = (assets / "MacNodeHostWorkerTests.swift").read_bytes()
        require(digest(test_bytes) == binding["permanentTestSHA256"], "Permanent test overlay changed")
        original_test = test_path.read_bytes()
        test_path.write_bytes(test_bytes)
        overlaid = True
        proof_test = product / binding["proofTestPath"]
        require(not proof_test.exists(), "Proof test path already exists")
        fixture = (assets / "MacNodeHostWorkerProcessGroupProof.swift").read_bytes()
        require(digest(fixture) == binding["proofTestSHA256"], "Proof fixture changed")
        proof_test.write_bytes(fixture)
        proof_test_created = True
        configuration_dir = product / ".proof-135663"
        configuration_dir.mkdir(exist_ok=False)
        configuration_file = configuration_dir / "configuration.json"
        write_json(configuration_file, {
            "phase": "baseline", "runtime": str(runtime), "output": str(output), "sourceSHA": binding["baselineSHA"],
        })
        configuration_bytes = configuration_file.read_bytes()
        configuration_created = True
        native_args = ["--package-path", "apps/macos", "--build-system", "native", "--enable-code-coverage"]
        run("swift-build-tests", ["swift", "build", *native_args, "--build-tests"])
        native = [node, "scripts/test-macos-native.mts", "default", *native_args, "--skip-build"]
        regression_name = "worker forces app exec host without fallback or startup respawn"
        regression_code, regression_log = run("permanent-regression-red", [*native, "--filter", regression_name], True)
        controls_code, controls_log = run("existing-owner-controls", [*native, "--filter", "MacNodeHostWorkerTests", "--skip", regression_name], True)
        lifecycle_code, _ = run("actual-packaged-owner", [*native, "--filter", "MacNodeHostWorkerProcessGroupProof"], True)
        runtime_after = snapshot(runtime)
        write_json(output / "runtime-after.json", runtime_after)
        after = verify_sources("source-after", overlaid=True)
        require(after["rawIndexSHA256"] == index_before, "Raw Git index bytes changed")
        require(after["stagedProjectionSHA256"] == projection_before, "Staged-file projection changed")
        require(after["installedLockMatches"] is True, "Installed dependency lock changed")
        require(runtime_before == runtime_after, "Packaged runtime bytes changed during proof")
        require(digest(proof_test.read_bytes()) == binding["proofTestSHA256"], "Proof test changed after compile")
        require(regression_code == 1 and regression_name in regression_log and "exited(46)" in regression_log,
                "Permanent test did not produce the intended baseline launch-environment failure")
        require(controls_code == 0, "Existing owner controls failed")
        for name in binding["requiredControlNames"]:
            require(re.search(re.escape(name) + r"[^\n]*passed after", controls_log), "Missing passing control: " + name)
        require(lifecycle_code == 0, "Actual packaged-worker lifecycle proof failed")
        for scenario in ("normal", "unresponsive"):
            observation = json.loads((output / scenario / "observation.json").read_text())
            require(observation["phase"] == "baseline" and observation["sourceSHA"] == binding["baselineSHA"], "Observation binding differs")
            require(observation["scenario"] == scenario, "Observation scenario differs")
            require(observation.get("error") is None and observation["cleanupComplete"] is True, "Lifecycle or cleanup failed")
            require(observation["directWorkerSurvivedStop"] == (scenario == "unresponsive"), "Unexpected stop outcome")
            expected = ["before-launch", "ready-and-identity-verified"]
            if scenario == "unresponsive":
                expected += ["worker-stopped"]
            expected += ["owner-stop-called", "owner-stop-returned", "behavior-observed", "cleanup-complete"]
            require([event["name"] for event in observation["events"]] == expected, "Process sequence differs")
            require([event["sequence"] for event in observation["events"]] == list(range(len(expected))), "Event order is incomplete")
            times = [event["elapsedSeconds"] for event in observation["events"]]
            require(all(value >= 0 for value in times) and times == sorted(times), "Event clock is not monotonic")
        result_payload = {
            "baselineReproduced": True, "candidateTested": False, "baselineSHA": binding["baselineSHA"],
            "baselineTree": binding["baselineTree"], "rawGitIndexSHA256": index_before,
            "stagedProjectionSHA256": projection_before, "installedLockSHA256": installed_before,
            "runtimeManifestSHA256": digest(json.dumps(runtime_before, sort_keys=True).encode()),
            "bundledNodeVersion": bundled_version.strip(), "steps": steps,
        }
    except BaseException as error:
        write_json(output / "failure.json", {"error": str(error), "steps": steps, "resourceRoot": str(work)})
        raise
    finally:
        final_after = capture_sources("source-after", overlaid)
        restoration = {"performed": False, "unconfirmedCommands": unconfirmed_commands, "error": None}
        if result_payload is not None and not (
            final_after["head"] == binding["baselineSHA"] and final_after["tree"] == binding["baselineTree"]
            and all(row["matches"] for row in final_after["sourceFiles"])
            and final_after["rawIndexSHA256"] == index_before
            and final_after["stagedProjectionSHA256"] == projection_before
            and final_after["installedLockMatches"] is True
        ):
            restoration["error"] = "Final source/index/lock snapshot differs from validated proof"
        try:
            if original_test is not None and not unconfirmed_commands and restoration["error"] is None:
                require(digest(test_path.read_bytes()) == binding["permanentTestSHA256"], "Refusing to overwrite a changed test overlay")
                test_path.write_bytes(original_test)
                if proof_test_created:
                    require(digest(proof_test.read_bytes()) == binding["proofTestSHA256"], "Refusing to remove a changed proof fixture")
                    proof_test.unlink()
                if configuration_created:
                    require(configuration_file.read_bytes() == configuration_bytes, "Refusing to remove a changed fixture locator")
                    configuration_file.unlink()
                    configuration_file.parent.rmdir()
                restoration["performed"] = True
            elif unconfirmed_commands:
                restoration["reason"] = "Outer command group closure unconfirmed; retain namespace and fixture inputs"
        except Exception as error:
            restoration["error"] = str(error)
        restored = capture_sources("source-restored", overlaid=False)
        restoration["sourceMatchesBaseline"] = all(row["matches"] for row in restored["sourceFiles"])
        restoration["overlayInputsRetained"] = original_test is not None and not restoration["performed"]
        if restoration["performed"] and not restoration["sourceMatchesBaseline"]:
            restoration["error"] = "Restored source does not match baseline"
        restored["restoration"] = restoration
        write_json(output / "source-restored.json", restored)
        removed = result_payload is not None and not unconfirmed_commands and restoration["error"] is None
        if removed:
            shutil.rmtree(work)
        write_json(output / "namespace-cleanup.json", {
            "resourceRoot": str(work), "removed": removed, "unconfirmedCommands": unconfirmed_commands,
            "closureEvidence": "native launcher contract and fixture receipts are separate from outer subprocess status",
        })
        if result_payload is not None:
            require(restoration["error"] is None, "Source restoration failed; inspect source-restored.json")
            result_payload.update(resourceRootRemoved=removed, retainedResourceRoot=None if removed else str(work),
                                  unconfirmedOuterCommands=unconfirmed_commands)
            write_json(output / "result.json", result_payload)


if __name__ == "__main__":
    main()
