#!/usr/bin/env python3
"""Fixed-head secretless candidate proof; refuses execution while the binding is disabled."""
import gzip
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time
import traceback


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def git(repo, *args):
    return subprocess.check_output(["git", "--no-optional-locks", "-C", str(repo), *args])


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"Expected a regular file: {path}")
    return path.read_bytes()


def snapshot(repo, output, label, binding):
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    tree = git(repo, "rev-parse", "HEAD^{tree}").decode().strip()
    if head != binding["head"] or tree != binding["tree"]:
        raise ValueError("Product HEAD/tree differs from the fixed candidate")
    entries = []
    for row in git(repo, "ls-tree", "-rz", "--full-tree", "HEAD").split(b"\0"):
        if not row:
            continue
        metadata, raw_name = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        name = os.fsdecode(raw_name)
        path = repo / name
        if kind != "blob":
            raise ValueError(f"Unsupported tracked object: {name}")
        if mode == "120000":
            if not path.is_symlink():
                raise ValueError(f"Tracked symlink replaced: {name}")
            data = os.fsencode(os.readlink(path))
        else:
            data = regular(path)
            actual_mode = "100755" if path.stat().st_mode & 0o111 else "100644"
            if mode != actual_mode:
                raise ValueError(f"Tracked mode changed: {name}")
        actual_oid = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual_oid != oid:
            raise ValueError(f"Tracked source differs from Git blob: {name}")
        entries.append({"path": name, "mode": mode, "blob": oid, "sha256": digest(data)})
    index_path = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index").decode().strip())
    index = regular(index_path)
    staged = git(repo, "ls-files", "--stage", "-z")
    (output / f"{label}-index.bin").write_bytes(index)
    receipt = {"head": head, "tree": tree, "entries": entries,
               "indexSha256": digest(index), "stageSha256": digest(staged)}
    write_json(output / f"{label}-source.json", receipt)
    return receipt


def run(repo, output, env, label, argv, timeout, steps):
    started = time.time()
    row = {"label": label, "argv": argv, "startedAtEpoch": started, "timeoutSeconds": timeout}
    steps.append(row)
    write_json(output / "steps.json", steps)
    proc = None
    try:
        with (output / f"{label}.stdout").open("wb") as stdout, (output / f"{label}.stderr").open("wb") as stderr:
            proc = subprocess.Popen(argv, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                    stdout=stdout, stderr=stderr, start_new_session=True)
            row["pid"] = proc.pid
            row["exitCode"] = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        row["timedOut"] = True
        row["error"] = str(error)
        # Let the unchanged Vitest shim forward termination and join its owned group.
        # This teardown reserve never changes the execution deadline or a failing result.
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            row["terminationExitCode"] = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            row["terminationGraceExpired"] = True
        raise RuntimeError(f"Command execution deadline exceeded: {label}") from error
    except BaseException as error:
        row["error"] = str(error)
        raise
    finally:
        if proc is not None:
            # This process group belongs only to this command, never the job shell.
            try:
                os.killpg(proc.pid, 0)
            except ProcessLookupError:
                row["processGroupGone"] = True
            else:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                row["processGroupGone"] = False
                row["remainingGroupKilled"] = True
        row["finishedAtEpoch"] = time.time()
        write_json(output / "steps.json", steps)
    if not row.get("processGroupGone"):
        raise RuntimeError(f"Command retained descendants: {label}; group killed")
    return row["exitCode"]


def retain_bundle(repo, output, measured):
    dist = repo / "dist/control-ui"
    retained = output / "bundle"
    retained.mkdir()
    for name in ("index.html", "asset-manifest.json"):
        (retained / name).write_bytes(regular(dist / name))
    manifest = json.loads(regular(dist / "asset-manifest.json"))
    if manifest["version"] != 1:
        raise ValueError("Unexpected asset manifest version")
    generation = hashlib.sha256()
    inventory = []
    names = set()
    for entry in manifest["assets"]:
        name = entry["path"]
        if not name.startswith("assets/") or ".." in Path(name).parts or name in names:
            raise ValueError("Unsafe or duplicate manifest path")
        names.add(name)
        data = regular(dist / name)
        if len(data) != entry["size"] or digest(data) != entry["sha256"]:
            raise ValueError(f"Manifest bytes mismatch: {name}")
        generation.update(f"{name}\0{len(data)}\0{digest(data)}\n".encode())
        inventory.append(entry)
        destination = retained / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    actual_names = {p.relative_to(dist).as_posix() for p in (dist / "assets").rglob("*")
                    if p.is_file() and not p.name.endswith(".map")}
    if actual_names != names or generation.hexdigest() != manifest["generation"]:
        raise ValueError("Asset manifest generation or inventory mismatch")
    selected = measured["metrics"]["startup"]["assets"]
    for entry in selected:
        name = entry["file"]
        if name not in names:
            raise ValueError("Startup asset absent from the validated manifest")
        raw = regular(dist / name)
        for suffix, field in (("", "rawBytes"), (".gz", "gzipBytes"), (".br", "brotliBytes")):
            data = regular(dist / (name + suffix))
            if len(data) != entry[field]:
                raise ValueError("Canonical metric differs from actual sidecar size")
            destination = retained / (name + suffix)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            if suffix == ".gz" and gzip.decompress(data) != raw:
                raise ValueError("Retained startup gzip does not decode to the asset")
    write_json(output / "bundle-inventory.json", inventory)
    return {"generation": manifest["generation"], "assets": len(inventory),
            "startup": selected, "retainedFiles": sorted(p.relative_to(retained).as_posix()
             for p in retained.rglob("*") if p.is_file())}


def tree_entries(repo):
    result = {}
    for row in git(repo, "ls-tree", "-rz", "--full-tree", "HEAD").split(b"\0"):
        if not row:
            continue
        metadata, raw_name = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        if kind != "blob":
            raise ValueError("Only ordinary tracked blobs are supported")
        result[os.fsdecode(raw_name)] = {"mode": mode, "blob": oid}
    return result


def verify_candidate_delta(repo, reference, output, binding, allowed):
    baseline = binding["baseline"]
    if git(reference, "rev-parse", "HEAD").decode().strip() != baseline["head"] or git(
            reference, "rev-parse", "HEAD^{tree}").decode().strip() != baseline["tree"]:
        raise ValueError("Reference checkout differs from immutable upstream baseline")
    if allowed["base"] != baseline["head"] or len(allowed["files"]) != 6:
        raise ValueError("Delta manifest must bind the six reviewed files to the baseline")
    old, new = tree_entries(reference), tree_entries(repo)
    expected = {row["path"]: row for row in allowed["files"]}
    changed = {name for name in old.keys() | new.keys() if old.get(name) != new.get(name)}
    if len(expected) != 6 or changed != expected.keys():
        raise ValueError("Candidate changed paths differ from the exact six-file allowlist")
    observed = []
    for name in sorted(changed):
        row = expected[name]
        if old.get(name) != row["beforeGit"] or new.get(name) != row["candidateGit"]:
            raise ValueError(f"Candidate/base blob or mode mismatch: {name}")
        old_sha = digest(git(reference, "cat-file", "blob", old[name]["blob"])) if name in old else None
        new_sha = digest(regular(repo / name))
        if old_sha != row["beforeSha256"] or new_sha != row["candidateSha256"]:
            raise ValueError(f"Candidate/base source digest mismatch: {name}")
        observed.append({"path": name, "before": old.get(name), "candidate": new.get(name),
                         "beforeSha256": old_sha, "candidateSha256": new_sha})
    for name, expected_sha in binding["sourceSha256"].items():
        if digest(regular(repo / name)) != expected_sha:
            raise ValueError(f"Bound candidate source input differs: {name}")
    write_json(output / "candidate-delta.json", {"baseline": baseline,
               "candidate": binding["candidate"], "changed": observed,
               "allOtherTrackedTreeEntriesIdentical": True,
               "baselineTrackedCount": len(old), "candidateTrackedCount": len(new)})


def read_test_report(repo, output, label, test_path):
    report_path = output / f"{label}.json"
    report = json.loads(regular(report_path))
    files = report["testResults"]
    if report["success"] is not True or len(files) != 1 or files[0]["name"] != str(repo / test_path):
        raise ValueError(f"Test report did not run exactly its bound file: {label}")
    file = files[0]
    assertions = file["assertionResults"]
    if not assertions or file["status"] != "passed" or file["message"]:
        raise ValueError(f"Test file did not pass: {label}")
    if any(row["status"] != "passed" or row["failureMessages"] for row in assertions):
        raise ValueError(f"Skipped or failed assertion in {label}")
    if any(report[key] != 0 for key in ("numFailedTests", "numPendingTests", "numTodoTests",
                                      "numFailedTestSuites", "numPendingTestSuites")):
        raise ValueError(f"Test report contains incomplete or failing results: {label}")
    if report["numTotalTests"] != len(assertions) or report["numPassedTests"] != len(assertions):
        raise ValueError(f"Test report counts disagree with actual assertions: {label}")
    return {"file": test_path, "passed": len(assertions), "reportSha256": digest(regular(report_path)),
            "titles": [row["fullName"] for row in assertions]}


def verify_bundle_unchanged(repo, output, bundle):
    retained = output / "bundle"
    for name in bundle["retainedFiles"]:
        if regular(repo / "dist/control-ui" / name) != regular(retained / name):
            raise ValueError(f"Build output changed after measurement: {name}")
    inventory = json.loads(regular(output / "bundle-inventory.json"))
    expected = {row["path"] for row in inventory}
    actual = {p.relative_to(repo / "dist/control-ui").as_posix()
              for p in (repo / "dist/control-ui/assets").rglob("*")
              if p.is_file() and not p.name.endswith(".map")}
    if actual != expected:
        raise ValueError("Runtime asset inventory changed after measurement")


def main():
    repo, reference, output = (Path(value).resolve() for value in sys.argv[1:])
    output.mkdir(parents=True, exist_ok=False)
    assets = Path(__file__).resolve().parent
    binding = json.loads(regular(assets / "binding.json"))
    manifest = json.loads(regular(assets / "publication-manifest.json"))
    allowed = json.loads(regular(assets / "allowed-delta.json"))
    verdict = {"completed": False, "candidateGreen": False, "candidateStarted": False,
               "candidate": binding["candidate"], "errors": []}
    steps = []
    before = None
    exit_code = 1
    try:
        candidate = binding["candidate"]
        if binding["mode"] != "candidate-only" or candidate["enabled"] is not True or not all(
                isinstance(candidate.get(key), str) and re.fullmatch(r"[0-9a-f]{40}", candidate[key])
                for key in ("head", "tree")):
            raise ValueError("Candidate remains UNBOUND: reviewed exact head/tree and enabled binding required")
        if candidate["repository"] != "openclaw/openclaw":
            raise ValueError("Unexpected candidate repository")
        for name, expected in manifest.items():
            if digest(regular(assets / name)) != expected:
                raise ValueError(f"Proof asset hash mismatch: {name}")
        provenance = {key: os.environ.get(key) for key in (
            "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_EVENT_NAME", "GITHUB_RUN_ID",
            "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH")}
        if provenance["RUNNER_ENVIRONMENT"] != "github-hosted" or provenance["RUNNER_OS"] != "Linux":
            raise ValueError("This proof requires GitHub-hosted Linux")
        os_release = Path("/etc/os-release").read_text()
        if 'VERSION_ID="24.04"' not in os_release.splitlines() or "ID=ubuntu" not in os_release.splitlines():
            raise ValueError("This proof requires Ubuntu 24.04")
        (output / "os-release.txt").write_text(os_release)
        provenance["uname"] = list(os.uname())
        if provenance["GITHUB_REPOSITORY"] != "steipete/openclaw" or provenance["GITHUB_REF"] != "refs/heads/codex/round10-ui-startup-budget-proof":
            raise ValueError("Unexpected proof publication repository/ref")
        if git(assets, "rev-parse", "HEAD").decode().strip() != provenance["GITHUB_SHA"]:
            raise ValueError("Proof checkout does not match workflow SHA")
        write_json(output / "provenance.json", provenance)
        shutil.copyfile(assets / "binding.json", output / "binding.json")
        shutil.copyfile(assets / "publication-manifest.json", output / "publication-manifest.json")
        shutil.copyfile(assets / "allowed-delta.json", output / "allowed-delta.json")
        verify_candidate_delta(repo, reference, output, binding, allowed)
        before = snapshot(repo, output, "before-install", candidate)
        if (repo / "dist").exists() or (repo / "node_modules").exists():
            raise ValueError("Proof requires a fresh checkout without build/dependency output")
        # No inherited HOME, package config, token, credential helper, or product settings.
        isolated = output / "isolated"
        for name in ("home", "tmp", "cache", "config", "data", "corepack", "bin"):
            (isolated / name).mkdir(parents=True)
        env = {"PATH": str(isolated / "bin") + os.pathsep + os.environ["PATH"],
               "HOME": str(isolated / "home"), "TMPDIR": str(isolated / "tmp"),
               "XDG_CACHE_HOME": str(isolated / "cache"), "XDG_CONFIG_HOME": str(isolated / "config"),
               "XDG_DATA_HOME": str(isolated / "data"), "COREPACK_HOME": str(isolated / "corepack"),
               "CI": "1", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
        write_json(output / "execution-environment.json", env)
        package_manager = json.loads(regular(repo / "package.json"))["packageManager"]
        if package_manager != binding["packageManager"]:
            raise ValueError("Unexpected package manager")
        commands = [
            ("node-version", ["node", "--version"], 30),
            ("corepack-enable", ["corepack", "enable", "--install-directory", str(isolated / "bin")], 60),
            ("pnpm-prepare", ["corepack", "prepare", package_manager, "--activate"], 300),
            ("pnpm-version", ["pnpm", "--version"], 30),
            ("install", ["pnpm", "install", "--frozen-lockfile"], 1200),
        ]
        verdict["candidateStarted"] = True
        for label, argv, timeout in commands:
            if run(repo, output, env, label, argv, timeout, steps) != 0:
                raise RuntimeError(f"Preparation failed: {label}")
            if label == "node-version" and (output / "node-version.stdout").read_text().strip() != "v24.19.0":
                raise ValueError("Unexpected Node version")
            if label == "pnpm-version" and (output / "pnpm-version.stdout").read_text().strip() != "12.1.0":
                raise ValueError("Unexpected pnpm version")
        dependencies = []
        for name in ("pako", "vite", "typescript", "playwright", "vitest", "jsdom"):
            package_path = repo / "ui/node_modules" / name / "package.json"
            if not package_path.exists():
                package_path = repo / "node_modules" / name / "package.json"
            data = regular(package_path)
            package = json.loads(data)
            dependencies.append({"name": package["name"], "version": package["version"],
                                 "packageJsonSha256": digest(data)})
        write_json(output / "installed-dependencies.json", dependencies)
        after_install = snapshot(repo, output, "after-install", candidate)
        if before != after_install:
            raise ValueError("Install changed tracked source or the real index")
        build = run(repo, output, env, "ui-build", ["pnpm", "ui:build"], 1200, steps)
        sidecars = run(repo, output, env, "sidecar-check", ["node", "--import", "./scripts/tsx.mjs",
                       "scripts/check-control-ui-precompressed-assets.mts"], 180, steps)
        metric_exit = run(repo, output, env, "performance-json", ["node", "--import", "./scripts/tsx.mjs",
                         "scripts/check-control-ui-performance.mts", "--json"], 180, steps)
        measured = json.loads((output / "performance-json.stdout").read_text())
        write_json(output / "metrics.json", measured)
        verdict["bundle"] = retain_bundle(repo, output, measured)
        if sidecars != 0:
            raise ValueError("Finalized compression sidecar validation failed")
        baseline = measured["startupBudgetBaseline"]["startupJsGzipBytes"]
        limit = baseline + measured["startupJsTolerance"] + measured["startupJsBuildVariance"]
        if baseline != 349565 or limit != 350141:
            raise ValueError("Committed startup budget changed")
        violations = measured["violations"]
        if measured["metrics"]["startup"]["js"]["requests"] != 8:
            raise ValueError("Candidate startup topology differs from the required eight-asset case")
        verdict.update({"buildExitCode": build, "performanceExitCode": metric_exit,
                        "startupGzipBytes": measured["metrics"]["startup"]["js"]["gzipBytes"],
                        "enforcementLimit": limit})
        if measured["report"] not in (output / "ui-build.stdout").read_text():
            raise ValueError("Canonical ui:build did not reach the same complete performance report")
        if violations or build != 0 or metric_exit != 0 or verdict["startupGzipBytes"] >= 349244:
            raise ValueError("Candidate must pass canonical build/performance with no violations below 349244")
        after_build = snapshot(repo, output, "after-build", candidate)
        if before != after_build:
            raise ValueError("Build changed tracked source or the real index")
        focused = [
            ("memory-view", "ui/src/pages/config/memory.test.ts"),
            ("memory-import-view", "ui/src/pages/memory-import/view.test.ts"),
            ("vite-catalog", "ui/src/app/vite-config.node.test.ts"),
        ]
        verdict["focusedTests"] = []
        for label, test_path in focused:
            argv = ["node", "scripts/run-vitest.mjs", "run", "--config",
                    "test/vitest/vitest.ui.config.ts", test_path,
                    "--reporter=verbose", "--reporter=json", "--outputFile=" + str(output / f"{label}.json")]
            code = run(repo, output, env, label, argv, 300, steps)
            phase = snapshot(repo, output, "after-" + label, candidate)
            if phase != before:
                raise ValueError(f"Focused suite changed tracked source/index: {label}")
            if code != 0:
                raise RuntimeError(f"Focused suite failed: {label}")
            verdict["focusedTests"].append(read_test_report(repo, output, label, test_path))
        i18n = run(repo, output, env, "i18n-verify", ["pnpm", "ui:i18n:verify"], 300, steps)
        if snapshot(repo, output, "after-i18n-verify", candidate) != before:
            raise ValueError("i18n verification changed tracked source or index")
        if i18n != 0:
            raise RuntimeError("Keyless contributor i18n verification failed")
        verdict["i18nVerifyExitCode"] = i18n
        verdict["outcome"] = "candidate-startup-budget-and-focused-checks-passed"
        verdict["candidateGreen"] = True
        verdict["completed"] = True
        exit_code = 0
    except BaseException as error:
        verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
        exit_code = 1
    finally:
        if before is not None:
            try:
                after = snapshot(repo, output, "final", binding["candidate"])
                verdict["sourceAndIndexUnchanged"] = before == after
                if before != after:
                    raise ValueError("Final source/index differs from pre-install snapshot")
                if "bundle" in verdict:
                    verify_bundle_unchanged(repo, output, verdict["bundle"])
                    verdict["runtimeAssetsUnchangedAfterChecks"] = True
            except BaseException as error:
                verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
                verdict["completed"] = False
                verdict["candidateGreen"] = False
                exit_code = 1
        verdict["cleanup"] = {"commandCount": len(steps), "allOuterProcessGroupsGone": all(
            row.get("processGroupGone") is True for row in steps),
            "serverStarted": False, "candidateStarted": verdict["candidateStarted"],
            "nestedVitestCleanupOwner": "unchanged canonical run-vitest shim, process completion and resource owner",
            "canonicalVitestCallsCompleted": all(any(row["label"] == label and row.get("exitCode") == 0
                and not row.get("timedOut") for row in steps)
                for label in ("memory-view", "memory-import-view", "vite-catalog")),
            "hostLifetime": "GitHub-hosted job teardown; no persistent remote lease"}
        # Avoid uploading installation caches, package metadata, or synthetic HOME contents.
        isolated = output / "isolated"
        try:
            if isolated.exists():
                shutil.rmtree(isolated)
            verdict["cleanup"]["syntheticStateRemoved"] = True
        except BaseException as error:
            verdict["cleanup"]["syntheticStateRemoved"] = False
            verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
            verdict["completed"] = False
            verdict["candidateGreen"] = False
            exit_code = 1
        write_json(output / "verdict.json", verdict)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
