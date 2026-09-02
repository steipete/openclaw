"""Run the exact permanent installer test against frozen original and published fix."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import time

MAX_LOG_BYTES = 16 * 1024 * 1024


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def git_bytes(root, *args):
    # Read-only guards must not refresh the index stat cache they are observing.
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    return subprocess.check_output(["git", "-C", str(root), *args], env=env)


def git(root, *args):
    return git_bytes(root, *args).decode().strip()


def tracked_snapshot(root, paths):
    snapshot = {}
    for relative in paths:
        path = root / relative
        if path.is_symlink():
            snapshot[relative] = {"kind": "symlink", "sha256": digest(os.readlink(path).encode())}
        else:
            require(path.is_file(), "Tracked file missing or changed type: " + relative)
            snapshot[relative] = {"kind": "file", "sha256": digest(path.read_bytes())}
    return snapshot


def snapshot_digest(snapshot):
    return digest(json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode())


def capture_source_guard(root, expected_sha, destination):
    require(git(root, "rev-parse", "HEAD") == expected_sha, "Source HEAD drifted")
    require(not git_bytes(root, "diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"), "Checkout index differs from HEAD")
    require(not git_bytes(root, "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--"), "Checkout has tracked changes before proof")
    stage = git_bytes(root, "ls-files", "--stage", "-z")
    flags = git_bytes(root, "ls-files", "-v", "-z")
    require(all(row.startswith(b"H ") for row in flags.split(b"\0") if row), "Sparse or assume-unchanged index flags are not admitted")
    entries = []
    for row in stage.split(b"\0"):
        if not row:
            continue
        metadata, relative = row.split(b"\t", 1)
        mode, oid, level = metadata.decode().split(" ")
        name = relative.decode()
        require(level == "0" and mode in {"100644", "100755", "120000"}, "Unsupported or unmerged index entry")
        require(not Path(name).is_absolute() and ".." not in Path(name).parts, "Tracked path escapes source")
        entries.append({"path": name, "mode": mode, "blob": oid})
    paths = [entry["path"] for entry in entries]
    require(len(paths) == len(set(paths)), "Duplicate index paths")
    index_path = Path(git(root, "rev-parse", "--git-path", "index"))
    if not index_path.is_absolute():
        index_path = root / index_path
    snapshot = tracked_snapshot(root, paths)
    guard = {"head": expected_sha, "indexFileSha256": digest(index_path.read_bytes()),
             "indexEntriesSha256": digest(stage), "indexFlagsSha256": digest(flags),
             "trackedCount": len(paths), "initialWorkingTreeSha256": snapshot_digest(snapshot),
             "expectedChangedPaths": [], "expectedWorkingTree": snapshot}
    write_json(destination / "tracked-baseline.json", {"indexEntries": entries, "workingTree": snapshot})
    return guard


def verify_source_guard(root, guard, destination, phase):
    index_path = Path(git(root, "rev-parse", "--git-path", "index"))
    if not index_path.is_absolute():
        index_path = root / index_path
    actual_changes = git_bytes(root, "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--").decode().rstrip("\0").split("\0")
    actual_changes = [name for name in actual_changes if name]
    observed = {
        "head": git(root, "rev-parse", "HEAD"), "indexFileSha256": digest(index_path.read_bytes()),
        "indexEntriesSha256": digest(git_bytes(root, "ls-files", "--stage", "-z")),
        "indexFlagsSha256": digest(git_bytes(root, "ls-files", "-v", "-z")),
        "expectedIndexFileSha256": guard["indexFileSha256"],
        "expectedIndexEntriesSha256": guard["indexEntriesSha256"],
        "expectedIndexFlagsSha256": guard["indexFlagsSha256"],
        "trackedCount": guard["trackedCount"], "actualChangedPaths": actual_changes,
        "expectedChangedPaths": guard["expectedChangedPaths"],
    }
    # Retain the observed index even if a missing tracked path prevents hashing.
    write_json(destination / ("integrity-" + phase + ".json"), observed)
    snapshot = tracked_snapshot(root, guard["expectedWorkingTree"])
    changed = [name for name, value in snapshot.items() if value != guard["expectedWorkingTree"][name]]
    observed.update(workingTreeSha256=snapshot_digest(snapshot), changedBytes=changed,
                    indexUnchanged=all(observed[key] == guard[key] for key in ("indexFileSha256", "indexEntriesSha256", "indexFlagsSha256")),
                    trackedBytesMatch=not changed)
    write_json(destination / ("integrity-" + phase + ".json"), observed)
    require(observed["head"] == guard["head"], "Source HEAD changed during proof")
    require(observed["indexUnchanged"], "Git index snapshot changed during proof")
    require(sorted(actual_changes) == sorted(guard["expectedChangedPaths"]), "Unexpected tracked Git changes")
    require(not changed, "Tracked input bytes changed: " + ", ".join(changed[:10]))


def verify_asset_lock(root, manifest_bytes, manifest):
    require((root / "manifest.json").read_bytes() == manifest_bytes, "Proof manifest changed during execution")
    for relative, expected in manifest.items():
        path = (root / relative).resolve()
        require(path.is_relative_to(root) and digest(path.read_bytes()) == expected, "Proof or binding asset changed: " + relative)


def run(argv, cwd, env, prefix, timeout):
    started = time.monotonic()
    termination = None
    with prefix.with_suffix(".stdout").open("wb") as out, prefix.with_suffix(".stderr").open("wb") as err:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=out, stderr=err,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        try:
            while process.poll() is None:
                size = prefix.with_suffix(".stdout").stat().st_size + prefix.with_suffix(".stderr").stat().st_size
                if size > MAX_LOG_BYTES or time.monotonic() - started > timeout:
                    termination = "output-limit" if size > MAX_LOG_BYTES else "timeout"
                    killer = Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"
                    subprocess.run([str(killer), "/PID", str(process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   check=False, timeout=15)
                    process.wait(timeout=15)
                    break
                time.sleep(0.2)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=15)
        receipt = {"argv": argv, "cwd": str(cwd), "exitCode": process.returncode,
                   "termination": termination, "seconds": round(time.monotonic() - started, 3)}
    total_bytes = 0
    for stream in ("stdout", "stderr"):
        raw = prefix.with_suffix("." + stream).read_bytes()
        receipt[stream + "Sha256"] = digest(raw)
        total_bytes += len(raw)
    if total_bytes > MAX_LOG_BYTES:
        termination = "output-limit"
        receipt["termination"] = termination
    write_json(prefix.with_suffix(".command.json"), receipt)
    require(termination is None, prefix.name + " exceeded process limit")
    return receipt


def child_environment(root, node):
    # Preserve native Windows prerequisites from the workflow's Bash parent.
    # PSModulePath is retained verbatim: no PS7 parent, module map or import injection.
    names = {"systemroot", "windir", "comspec", "path", "pathext", "psmodulepath",
             "programfiles", "programfiles(x86)", "programw6432", "processor_architecture",
             "processor_architew6432", "os", "number_of_processors"}
    env = {key: value for key, value in os.environ.items() if key.lower() in names}
    for name in ("profile", "temp", "bin", "corepack", "store", "cache", "profile/AppData/Local", "profile/AppData/Roaming"):
        (root / name).mkdir(parents=True, exist_ok=True)
    env.update(HOME=str(root / "profile"), USERPROFILE=str(root / "profile"),
               LOCALAPPDATA=str(root / "profile/AppData/Local"), APPDATA=str(root / "profile/AppData/Roaming"),
               TEMP=str(root / "temp"), TMP=str(root / "temp"), CI="true",
               COREPACK_HOME=str(root / "corepack"), COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
               PNPM_CONFIG_STORE_DIR=str(root / "store"), PNPM_CONFIG_CACHE_DIR=str(root / "cache"),
               npm_config_cache=str(root / "cache/npm"), GIT_TERMINAL_PROMPT="0",
               OPENCLAW_VITEST_MAX_WORKERS="1", OPENCLAW_TEST_PROJECTS_PARALLEL="1",
               NODE_OPTIONS="--max-old-space-size=8192")
    path_key = next((key for key in env if key.lower() == "path"), "PATH")
    env[path_key] = str(root / "bin") + os.pathsep + str(node.parent) + os.pathsep + env.get(path_key, "")
    return env


def read_tests(path, title, before):
    require(path.is_file(), "Canonical Vitest JSON was not produced")
    require(path.stat().st_size < MAX_LOG_BYTES, "Oversized Vitest JSON")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    files = data.get("testResults", [])
    require(len(files) == 1 and files[0]["name"].replace("\\", "/").endswith("/test/scripts/install-ps1.test.ts"), "Unexpected test selection")
    require(not files[0].get("message"), "Vitest reported a module or hook error")
    tests = files[0].get("assertionResults", [])
    require(tests, "No actual test cases")
    require(data.get("numTotalTests") == len(tests), "Incomplete case inventory")
    require(data.get("numFailedTests") == (1 if before else 0), "Unexpected failed-test count")
    require(data.get("success") is (not before), "Unexpected Vitest success flag")
    target = [test for test in tests if test.get("title") == title]
    require(len(target) == 1, "Permanent regression missing or duplicated")
    failed = [test for test in tests if test["status"] == "failed"]
    if before:
        require(failed == target and target[0]["status"] == "failed", "Original must fail only the new regression")
        failure = "\n".join(target[0].get("failureMessages") or [])
        require("tar fixture failure" in failure, "Original failure was not redirected native stderr")
    else:
        require(data.get("success") is True and not failed and target[0]["status"] == "passed", "Published candidate did not pass")
    require(all(test["status"] in {"passed", "failed", "pending", "skipped", "todo"} for test in tests), "Unknown test status")
    return [{"name": test["fullName"], "title": test["title"], "status": test["status"]} for test in tests]


def main():
    before, after, work, output = (Path(arg).resolve() for arg in sys.argv[1:])
    require(not work.exists() and not output.exists(), "Proof paths must be fresh")
    work.mkdir(parents=True)
    output.mkdir(parents=True)
    assets = Path(__file__).resolve().parent
    proof_root = assets.parents[2]
    report = {"schema": "openclaw-pr-135410-permanent-proof-v1", "status": "running", "variants": {}}
    try:
        require(os.name == "nt" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Hosted Windows required")
        require(os.environ.get("GITHUB_REPOSITORY") == "steipete/openclaw", "Wrong proof repository")
        require(os.environ.get("GITHUB_REF") == "refs/heads/codex/round10-windows-permanent-proof", "Wrong proof branch")
        require(git(proof_root, "rev-parse", "HEAD") == os.environ["GITHUB_SHA"], "Proof assets differ from workflow SHA")
        manifest_bytes = (proof_root / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        verify_asset_lock(proof_root, manifest_bytes, manifest)
        proof_guard = capture_source_guard(proof_root, os.environ["GITHUB_SHA"], output)
        pins = json.loads((assets / "bindings.json").read_text())
        overlay = (assets / "install-ps1.test.ts").read_bytes()
        require(digest(overlay) == pins["testOverlaySha256"], "Overlay test hash mismatch")
        node_path = shutil.which("node")
        require(node_path, "Pinned Node executable absent")
        node = Path(node_path).resolve()
        require(digest(node.read_bytes()) == pins["nodeWindowsX64ExeSha256"], "Node executable differs from official pinned distribution")
        corepack = node.parent / "node_modules/corepack/dist/corepack.js"
        require(corepack.is_file(), "Bundled Corepack missing")
        corepack_sha = digest(corepack.read_bytes())
        write_json(output / "toolchain.json", {"nodeSha256": digest(node.read_bytes()),
                   "corepackLauncherSha256": corepack_sha,
                   "expectedCorepackLauncherSha256": pins["corepackLauncherSha256"]})
        require(corepack_sha == pins["corepackLauncherSha256"], "Corepack launcher differs from pinned Windows Node distribution")
        require(json.loads((corepack.parent.parent / "package.json").read_text())["version"] == pins["corepackVersion"], "Bundled Corepack version mismatch")
        report.update(workflowSha=os.environ["GITHUB_SHA"], bindingsSha256=digest((assets / "bindings.json").read_bytes()),
                      runner={key: os.environ.get(key) for key in ["RUNNER_ENVIRONMENT", "RUNNER_OS", "ImageOS", "ImageVersion", "GITHUB_RUN_ID"]},
                      nodeSha256=digest(node.read_bytes()), corepackLauncherSha256=digest(corepack.read_bytes()))
        source_guards = {}
        for variant, root in [("before", before), ("after", after)]:
            pin = pins["source"][variant]
            case_output = output / variant
            case_output.mkdir()
            source_guard = capture_source_guard(root, pin["sha"], case_output)
            source_guards[variant] = source_guard
            require(git(root, "rev-parse", "HEAD") == pin["sha"], variant + " source SHA mismatch")
            require(git(root, "rev-parse", "HEAD^{tree}") == pin["tree"], variant + " tree mismatch")
            for relative, expected in pin["files"].items():
                # actions/checkout may materialize Windows line endings; bind the exact Git blob.
                blob = subprocess.check_output(["git", "-C", str(root), "show", "HEAD:" + relative])
                require(digest(blob) == expected, variant + " source blob mismatch: " + relative)
                require((root / relative).read_bytes().replace(b"\r\n", b"\n") == blob, variant + " checkout bytes differ: " + relative)
            require(json.loads((root / "package.json").read_text())["packageManager"] == pins["packageManager"], "Package-manager pin changed")
            if variant == "before":
                (root / pins["target"]).write_bytes(overlay)
                source_guard["expectedChangedPaths"] = [pins["target"]]
                source_guard["expectedWorkingTree"][pins["target"]] = {"kind": "file", "sha256": digest(overlay)}
            require((root / pins["target"]).read_bytes().replace(b"\r\n", b"\n") == overlay, "Both variants must use the identical permanent test")
            verify_source_guard(root, source_guard, case_output, "admitted")
            env = child_environment(work / variant, node)
            report["phase"] = variant + ":setup"
            write_json(output / "run.json", report)
            for name, argv in [
                ("node-version", [str(node), "--version"]),
                ("enable-pnpm", [str(node), str(corepack), "enable", "--install-directory", str(work / variant / "bin"), "pnpm"]),
                ("pnpm-version", [str(node), str(corepack), "pnpm", "--version"]),
            ]:
                receipt = run(argv, root, env, case_output / name, 180)
                require(receipt["exitCode"] == 0, name + " failed")
            require((case_output / "node-version.stdout").read_text().strip() == "v" + pins["nodeVersion"], "Node version mismatch")
            require((case_output / "pnpm-version.stdout").read_text().strip() == "12.1.0", "pnpm version mismatch")
            engines = {
                "ps51": str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                "ps7": shutil.which("pwsh", path=next(v for k, v in env.items() if k.lower() == "path")),
            }
            require(all(engines.values()), "Both stock PowerShell engines are required")
            for engine_name, executable in engines.items():
                probe = run([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                             "[Console]::WriteLine($PSVersionTable.PSVersion.ToString() + '|' + $PSVersionTable.PSEdition + '|' + $Host.Name)"],
                            root, env, case_output / ("engine-" + engine_name), 30)
                require(probe["exitCode"] == 0, engine_name + " identity probe failed")
                identity = (case_output / ("engine-" + engine_name + ".stdout")).read_text(encoding="utf-8-sig").strip().split("|")
                version, edition = ("5.1.", "Desktop") if engine_name == "ps51" else ("7.", "Core")
                require(len(identity) == 3 and identity[0].startswith(version) and identity[1:] == [edition, "ConsoleHost"], "Wrong PowerShell identity")
            install = run([str(node), str(corepack), "pnpm", "install", "--frozen-lockfile", "--config.ignore-scripts=false", "--config.enable-pre-post-scripts=true"], root, env, case_output / "install", 900)
            require(install["exitCode"] == 0, variant + " frozen dependency install failed")
            verify_source_guard(root, source_guard, case_output, "installed")
            verify_asset_lock(proof_root, manifest_bytes, manifest)
            report["phase"] = variant + ":test"
            write_json(output / "run.json", report)
            result_path = case_output / "tests.json"
            receipt = run([str(node), "scripts/run-vitest.mjs", pins["target"], "--reporter=verbose", "--reporter=json", "--outputFile=" + str(result_path)], root, env, case_output / "tests", 480)
            require(receipt["exitCode"] == (1 if variant == "before" else 0), variant + " unexpected test exit")
            console = (case_output / "tests.stdout").read_text(encoding="utf-8", errors="replace") + "\n" + (case_output / "tests.stderr").read_text(encoding="utf-8", errors="replace")
            require(not re.search(r"Vitest caught [1-9]\d* unhandled errors?|\[vitest\] UNHANDLED ERRORS \(", console), "Canonical Vitest reported unhandled errors")
            require("Some tests are still running when generating the JSON report" not in console, "Vitest report was incomplete")
            inventory = read_tests(result_path, pins["regressionTitle"], variant == "before")
            verify_source_guard(root, source_guard, case_output, "tested")
            verify_asset_lock(proof_root, manifest_bytes, manifest)
            verify_source_guard(proof_root, proof_guard, output, variant + "-tested")
            report["variants"][variant] = {"sha": pin["sha"], "tree": pin["tree"], "testSha256": pins["testOverlaySha256"], "exitCode": receipt["exitCode"], "tests": inventory, "psModulePath": next((v for k, v in env.items() if k.lower() == "psmodulepath"), None)}
            write_json(output / "run.json", report)
        original = sorted(report["variants"]["before"]["tests"], key=lambda test: test["name"])
        repaired = sorted(report["variants"]["after"]["tests"], key=lambda test: test["name"])
        require(len(original) == len(repaired), "Test inventory size changed")
        for old, new in zip(original, repaired):
            require(old["name"] == new["name"], "Test inventory changed")
            require(new["status"] == ("passed" if old["title"] == pins["regressionTitle"] else old["status"]), "Sibling outcome changed")
        for variant, root in [("before", before), ("after", after)]:
            verify_source_guard(root, source_guards[variant], output / variant, "final")
        verify_asset_lock(proof_root, manifest_bytes, manifest)
        verify_source_guard(proof_root, proof_guard, output, "final")
        report["status"] = "pass"
    except Exception as error:
        report["status"] = "fail"
        report["error"] = str(error)
    finally:
        try:
            shutil.rmtree(work)
            report["workspaceCleanupComplete"] = not work.exists()
        except Exception as error:
            report["status"] = "fail"
            report["cleanupError"] = str(error)
        write_json(output / "run.json", report)
    require(report["status"] == "pass", report.get("error", "Permanent test proof failed"))


if __name__ == "__main__":
    main()
