#!/usr/bin/env python3
"""Reviewed, baseline-only CI controller. Never imports or runs a candidate."""
import gzip
import hashlib
import json
import os
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
        raise ValueError("Product HEAD/tree differs from the fixed baseline")
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


def main():
    repo, output = (Path(value).resolve() for value in sys.argv[1:])
    output.mkdir(parents=True, exist_ok=False)
    assets = Path(__file__).resolve().parent
    binding = json.loads(regular(assets / "binding.json"))
    manifest = json.loads(regular(assets / "publication-manifest.json"))
    verdict = {"completed": False, "baselineRed": False, "candidateStarted": False,
               "candidate": "UNBOUND_DISABLED", "errors": []}
    steps = []
    before = None
    exit_code = 1
    try:
        if binding["mode"] != "baseline-only" or binding["candidate"] != {"enabled": False, "head": None}:
            raise ValueError("Candidate execution is not implemented in this controller")
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
        before = snapshot(repo, output, "before-install", binding["baseline"])
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
        for label, argv, timeout in commands:
            if run(repo, output, env, label, argv, timeout, steps) != 0:
                raise RuntimeError(f"Preparation failed: {label}")
            if label == "node-version" and (output / "node-version.stdout").read_text().strip() != "v24.19.0":
                raise ValueError("Unexpected Node version")
            if label == "pnpm-version" and (output / "pnpm-version.stdout").read_text().strip() != "12.1.0":
                raise ValueError("Unexpected pnpm version")
        dependencies = []
        for name in ("pako", "vite", "typescript", "playwright"):
            package_path = repo / "ui/node_modules" / name / "package.json"
            if not package_path.exists():
                package_path = repo / "node_modules" / name / "package.json"
            data = regular(package_path)
            package = json.loads(data)
            dependencies.append({"name": package["name"], "version": package["version"],
                                 "packageJsonSha256": digest(data)})
        write_json(output / "installed-dependencies.json", dependencies)
        after_install = snapshot(repo, output, "after-install", binding["baseline"])
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
        if baseline != 348668 or limit != 349244:
            raise ValueError("Committed startup budget changed")
        violations = measured["violations"]
        if measured["metrics"]["startup"]["js"]["requests"] != 8:
            raise ValueError("Baseline startup topology differs from the observed eight-asset case")
        verdict.update({"buildExitCode": build, "performanceExitCode": metric_exit,
                        "startupGzipBytes": measured["metrics"]["startup"]["js"]["gzipBytes"],
                        "enforcementLimit": limit})
        if measured["report"] not in (output / "ui-build.stdout").read_text():
            raise ValueError("Canonical ui:build did not reach the same complete performance report")
        if not violations and build == 0 and metric_exit == 0:
            verdict["outcome"] = "baseline-premise-not-reproduced"
            exit_code = 2
        elif build == 1 and metric_exit == 1 and violations == [{
            "metric": "startup JS gzip", "actual": verdict["startupGzipBytes"],
            "limit": 349244, "unit": "bytes"
        }] and verdict["startupGzipBytes"] > 349244:
            verdict["baselineRed"] = True
            verdict["outcome"] = "baseline-startup-budget-exceeded"
            exit_code = 0
        else:
            raise ValueError("Build failure is not solely the expected canonical startup gzip guard")
        verdict["completed"] = True
    except BaseException as error:
        verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
        exit_code = 1
    finally:
        if before is not None:
            try:
                after = snapshot(repo, output, "final", binding["baseline"])
                verdict["sourceAndIndexUnchanged"] = before == after
                if before != after:
                    raise ValueError("Final source/index differs from pre-install snapshot")
            except BaseException as error:
                verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
                verdict["completed"] = False
                verdict["baselineRed"] = False
                exit_code = 1
        verdict["cleanup"] = {"commandCount": len(steps), "allProcessGroupsGone": all(
            row.get("processGroupGone") is True for row in steps),
            "serverStarted": False, "candidateStarted": False,
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
            verdict["baselineRed"] = False
            exit_code = 1
        write_json(output / "verdict.json", verdict)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
