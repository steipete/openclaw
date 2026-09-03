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


def parse_git_index_v2(data):
    # Index layout is Git's SHA-1/v2 format, not a staged-file projection.
    require(32 <= len(data) <= 8 * 1024 * 1024, "Git index size is invalid")
    require(data[:8] == b"DIRC\x00\x00\x00\x02", "Expected Git index version 2")
    end = len(data) - 20
    require(hashlib.sha1(data[:end]).digest() == data[end:], "Git index checksum is invalid")
    count = int.from_bytes(data[8:12], "big")
    require(count <= (end - 12) // 64, "Git index entry count exceeds its bounds")
    entries, extensions = [], []
    cursor, previous = 12, None
    for _ in range(count):
        start = cursor
        require(start + 62 < end, "Truncated Git index entry")
        flags = int.from_bytes(data[start + 60:start + 62], "big")
        require(not flags & 0x4000, "Extended entry flags are invalid in index version 2")
        name_end = data.find(b"\x00", start + 62, end)
        require(name_end >= 0, "Unterminated Git index pathname")
        name = data[start + 62:name_end]
        require(name and all(part not in (b"", b".", b"..", b".git") for part in name.split(b"/")),
                "Invalid Git index pathname")
        require((flags & 0xFFF) == min(len(name), 0xFFF), "Git index pathname length differs")
        key = (name, (flags >> 12) & 3)
        require(previous is None or previous < key, "Git index entries are not ordered")
        previous = key
        cursor = start + ((name_end - start + 1 + 7) // 8) * 8
        require(cursor <= end and data[name_end:cursor] == bytes(cursor - name_end),
                "Git index entry padding is invalid")
        entries.append((start, cursor, name))
    extension_start = cursor
    while cursor < end:
        require(cursor + 8 <= end, "Truncated Git index extension")
        signature = data[cursor:cursor + 4]
        # Required extensions such as split-index change entry interpretation.
        require(65 <= signature[0] <= 90, "Unsupported required Git index extension")
        size = int.from_bytes(data[cursor + 4:cursor + 8], "big")
        next_cursor = cursor + 8 + size
        require(next_cursor <= end, "Git index extension exceeds its bounds")
        extensions.append((cursor, next_cursor, signature))
        cursor = next_cursor
    require(cursor == end, "Git index did not end at its checksum")
    return entries, extension_start, extensions


def compare_git_indexes(before, after):
    before_entries, before_extensions, before_layout = parse_git_index_v2(before)
    after_entries, after_extensions, after_layout = parse_git_index_v2(after)
    require(len(before) == len(after) and before[:12] == after[:12], "Git index header or size changed")
    require(before_entries == after_entries and before_extensions == after_extensions
            and before_layout == after_layout, "Git index entry or extension layout changed")
    changes = []
    fields = ("ctimeSeconds", "ctimeNanoseconds", "mtimeSeconds", "mtimeNanoseconds")
    for start, end, name in before_entries:
        # Git status may refresh only these stat timestamps without staging content.
        # Every other entry byte, including flags, pathname and padding, stays fixed.
        require(before[start + 16:end] == after[start + 16:end],
                "Git index changed outside ctime/mtime: " + name.decode("utf8", errors="backslashreplace"))
        changed = {}
        for offset, field in enumerate(fields):
            position = start + offset * 4
            old = int.from_bytes(before[position:position + 4], "big")
            new = int.from_bytes(after[position:position + 4], "big")
            if old != new:
                changed[field] = {"before": old, "after": new}
        if changed:
            changes.append({"path": name.decode("utf8", errors="backslashreplace"), "changes": changed})
    require(before[before_extensions:-20] == after[after_extensions:-20], "Git index extension bytes changed")
    return {"format": "git-index-v2-sha1", "equivalent": True,
            "beforeSHA256": digest(before), "afterSHA256": digest(after),
            "rawBytesEqual": before == after, "entryCount": len(before_entries),
            "allowedChangedFields": list(fields), "timestampChanges": changes}


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
    raw_index_blobs = {}
    raw_index_captures = []
    index_reference = None

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

    def git(*args, index_file=None):
        command_env = env if index_file is None else {**env, "GIT_INDEX_FILE": str(index_file)}
        return subprocess.check_output(["git", *args], cwd=product, env=command_env)

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
        raw_index_capture = {}
        def capture_raw_index(path=None, suffix=None):
            require(raw_index_path is not None, "Raw index path unavailable")
            require(raw_index_path.resolve().is_relative_to(product), "Raw index is outside the isolated product checkout")
            path = raw_index_path if path is None else path
            require(not path.is_symlink() and path.is_file(), "Index capture must be a regular file")
            with path.open("rb") as stream:
                metadata = os.fstat(stream.fileno())
                data = stream.read(8 * 1024 * 1024 + 1)
            require(len(data) <= 8 * 1024 * 1024, "Raw index capture exceeds 8 MiB")
            require(len(data) == metadata.st_size and data[:4] == b"DIRC", "Index capture is incomplete or invalid")
            fingerprint = digest(data)
            blob_name = "raw-index-" + fingerprint + ".bin"
            if fingerprint not in raw_index_blobs:
                require(sum(raw_index_blobs.values()) + len(data) <= 24 * 1024 * 1024,
                        "Raw index captures exceed 24 MiB")
                with (output / blob_name).open("xb") as stream:
                    stream.write(data)
                raw_index_blobs[fingerprint] = len(data)
            require(len(raw_index_captures) < 32, "Raw index capture count exceeded")
            record = {
                "label": label if suffix is None else label + "/" + suffix,
                "sequence": len(raw_index_captures), "blob": blob_name,
                "bytes": len(data), "sha256": fingerprint, "monotonicSeconds": time.monotonic(),
                "mtimeNs": metadata.st_mtime_ns, "ctimeNs": metadata.st_ctime_ns, "inode": metadata.st_ino,
            }
            if suffix is None:
                raw_index_capture.update(record)
            raw_index_captures.append(record)
            write_json(output / "raw-index-captures.json", raw_index_captures)
            return record
        comparison_observation = {"command": ["git", "diff", "--name-only"]}
        def capture_tracked_changes():
            require(raw_index_capture, "Initial raw index capture unavailable")
            try:
                # Porcelain diff refreshes stat-only changes. Give it an exact private
                # index copy so the comparison cannot refresh the guarded real index.
                with tempfile.TemporaryDirectory(prefix="diff-index-", dir=work) as directory:
                    comparison = Path(directory) / "index"
                    comparison.write_bytes((output / raw_index_capture["blob"]).read_bytes())
                    # Git uses the index mtime to identify racy stat entries.
                    os.utime(comparison, ns=(raw_index_capture["mtimeNs"], raw_index_capture["mtimeNs"]))
                    copied = capture_raw_index(comparison, "comparison-before")
                    comparison_observation["before"] = copied
                    require(copied["sha256"] == raw_index_capture["sha256"]
                            and copied["mtimeNs"] == raw_index_capture["mtimeNs"], "Comparison index differs")
                    try:
                        return git("diff", "--name-only", index_file=comparison).decode().splitlines()
                    finally:
                        comparison_observation["after"] = capture_raw_index(comparison, "comparison-after")
            finally:
                real_after = capture_raw_index(suffix="real-after-comparison")
                comparison_observation["realAfter"] = real_after
                require(real_after["sha256"] == raw_index_capture["sha256"], "Git comparison changed real index")
        state = {
            "head": observe("head", lambda: git("rev-parse", "HEAD").decode().strip()),
            "tree": observe("tree", lambda: git("rev-parse", "HEAD^{tree}").decode().strip()),
            "rawIndexPath": str(raw_index_path) if raw_index_path is not None else None,
            "rawIndexSHA256": observe("rawIndex", lambda: capture_raw_index()["sha256"]),
            "rawIndexCapture": raw_index_capture,
            "stagedProjectionSHA256": observe("stagedProjection", lambda: digest(git("ls-files", "--stage", "-z"))),
            "trackedChanges": observe("trackedChanges", capture_tracked_changes),
            "trackedChangesComparison": comparison_observation,
            "installedLockSHA256": observe("installedLock", lambda: digest((product / "node_modules/.pnpm/lock.yaml").read_bytes())),
            "expectedInstalledLockSHA256": installed_before,
            "overlaid": overlaid, "sourceFiles": [], "errors": errors,
        }
        def compare_capture():
            reference = index_reference or raw_index_capture
            comparison = compare_git_indexes((output / reference["blob"]).read_bytes(),
                                              (output / raw_index_capture["blob"]).read_bytes())
            require(comparison["beforeSHA256"] == reference["sha256"]
                    and comparison["afterSHA256"] == raw_index_capture["sha256"], "Captured index blob changed")
            return comparison
        state["rawIndexComparison"] = observe("rawIndexComparison", compare_capture)
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
        require(state["rawIndexComparison"] is not None and state["rawIndexComparison"]["equivalent"],
                "Git index changed outside permitted stat timestamps; inspect " + label + ".json")
        return state

    try:
        git_launcher = shutil.which("git", path=env["PATH"])
        require(git_launcher, "Git launcher unavailable")
        write_json(output / "git-toolchain.json", {
            "version": git("--version").decode().strip(), "launcher": git_launcher,
            "launcherSHA256": digest(Path(git_launcher).read_bytes()),
            "porcelainDiffIndex": "exact disposable copy with preserved mtime; real index remains guarded",
        })
        before = verify_sources("source-before")
        index_reference = before["rawIndexCapture"]
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
        require(after["rawIndexComparison"]["equivalent"], "Git index changed outside permitted stat timestamps")
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
            "rawGitIndexAfterSHA256": after["rawIndexSHA256"], "gitIndexComparison": after["rawIndexComparison"],
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
            and final_after["rawIndexComparison"] is not None and final_after["rawIndexComparison"]["equivalent"]
            and final_after["trackedChanges"] == [binding["permanentTestPath"]]
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
