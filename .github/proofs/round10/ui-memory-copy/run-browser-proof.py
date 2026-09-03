#!/usr/bin/env python3
"""Fixed-revision browser preservation proof; both published revisions are explicitly bound."""
# Source/index helpers copied from the reviewed baseline controller (see provenance.json).
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import struct
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
    row = {"label": label, "argv": argv, "startedAtEpoch": time.time(), "timeoutSeconds": timeout}
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
        # Allow the unchanged native shim to forward termination and join its owned group.
        # This is teardown reserve, not an extension of the failed execution deadline.
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            row["terminationExitCode"] = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            row["terminationGraceExpired"] = True
        raise RuntimeError(f"Command deadline exceeded: {label}") from error
    finally:
        if proc is not None:
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
    if not row.get("processGroupGone") or row.get("exitCode") != 0:
        raise RuntimeError(f"Command failed or retained descendants: {label}")


def fixture_state(repo, owned):
    result = []
    for entry in owned:
        target = repo / entry["destination"]
        current = target.lstat()
        if (current.st_dev, current.st_ino) != (entry["device"], entry["inode"]):
            raise ValueError(f"Fixture identity changed: {entry['destination']}")
        if stat.S_IMODE(current.st_mode) != entry["mode"]:
            raise ValueError(f"Fixture mode changed: {entry['destination']}")
        if digest(regular(target)) != entry["sha256"]:
            raise ValueError(f"Fixture bytes changed: {entry['destination']}")
        result.append(entry)
    return result


def install_fixtures(repo, assets, manifest, owned):
    for entry in manifest["files"]:
        destination = Path(entry["destination"])
        if destination.is_absolute() or ".." in destination.parts:
            raise ValueError("Invalid fixture destination")
        target = repo / destination
        if target.parent.resolve() != target.parent or not target.parent.is_dir():
            raise ValueError("Fixture parent is not the expected ordinary source directory")
        if os.path.lexists(target):
            raise ValueError(f"Fixture destination already exists: {destination}")
        data = regular(assets / "fixtures" / entry["source"])
        if digest(data) != entry["sha256"]:
            raise ValueError("Fixture source differs from frozen before/after bytes")
        with os.fdopen(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644), "wb") as output:
            output.write(data)
        created = target.lstat()
        owned.append({**entry, "device": created.st_dev, "inode": created.st_ino, "mode": stat.S_IMODE(created.st_mode)})
    return fixture_state(repo, owned)


FALLBACK_PATH = "ui/src/i18n/test/memory-import-cold-fallback.test.ts"
BROWSER_PATH = "ui/src/e2e/memory-import-cold-copy.e2e.test.ts"
FALLBACK_TITLES = ["cold Settings owner preserves English fallback", "cold Import owner preserves English fallback"]
BROWSER_TITLES = [
    "cold Settings Memory renders its import section",
    "cold Memory Import renders English planning and confirmation copy",
    "cold Memory Import renders the non-admin denial",
    "cold Memory Import renders shipped German planning and confirmation copy",
]


def check_test_report(repo, output, label, test_path, passed_titles, skipped_titles):
    report_path = output / f"{label}.json"
    report = json.loads(regular(report_path))
    files = report["testResults"]
    if report["success"] is not True or len(files) != 1 or files[0]["name"] != str(repo / test_path):
        raise ValueError(f"Wrong or unsuccessful test file: {label}")
    file = files[0]
    assertions = file["assertionResults"]
    expected = {title: "passed" for title in passed_titles} | {title: "skipped" for title in skipped_titles}
    if file["status"] != "passed" or file["message"] or len(assertions) != len(expected):
        raise ValueError(f"Incomplete file result: {label}")
    actual = {row["title"]: row["status"] for row in assertions}
    if actual != expected or len(actual) != len(assertions) or any(row["failureMessages"] for row in assertions):
        raise ValueError(f"Actual assertion selection/status mismatch: {label}")
    counts = {"numTotalTests": len(expected), "numPassedTests": len(passed_titles),
              "numPendingTests": len(skipped_titles), "numFailedTests": 0, "numTodoTests": 0,
              "numFailedTestSuites": 0, "numPendingTestSuites": 0}
    if any(report[key] != value for key, value in counts.items()):
        raise ValueError(f"JSON counts differ from exact assertion results: {label}")
    return {"label": label, "file": test_path, "passed": passed_titles, "unselected": skipped_titles,
            "sha256": digest(regular(report_path))}


def check_captures(output):
    expected = {
        "settings-en": ("en", "settings/memory/settings", True, ["01-settings-memory-import.png"]),
        "import-en": ("en", "memory-import", True, ["01-import-ready.png", "02-import-confirmation.png"]),
        "denial-en": ("en", "memory-import", False, ["01-import-admin-required.png"]),
        "import-de": ("de", "memory-import", True, ["01-import-ready.png", "02-import-confirmation.png"]),
    }
    receipts = list((output / "browser").glob("*/verdict.json"))
    if len(receipts) != 4:
        raise ValueError("Expected four independent cold browser receipts")
    seen = set()
    result = []
    for path in receipts:
        row = json.loads(regular(path))
        name = row["name"]
        if name not in expected or name in seen:
            raise ValueError("Missing or duplicate cold browser case")
        seen.add(name)
        locale, route, admin, captures = expected[name]
        if (row["locale"], row["route"], row["admin"]) != (locale, route, admin):
            raise ValueError("Browser receipt identity differs from its fixed scenario")
        if row["completed"] is not True or row["contextClosed"] is not True or row["pageErrors"] or row.get("error"):
            raise ValueError("Browser scenario or context cleanup incomplete")
        if not row["loadedAssets"] or any(asset["status"] != 200 for asset in row["loadedAssets"]):
            raise ValueError("Browser did not load its real bundle successfully")
        if digest(regular(path.parent / "served-index.html")) != row["indexSha256"]:
            raise ValueError("Served UI index bytes differ from their receipt")
        if [capture["file"] for capture in row["captures"]] != captures:
            raise ValueError("Scenario screenshots differ from the fixed capture contract")
        images = []
        for capture in row["captures"]:
            data = regular(path.parent / capture["file"])
            if digest(data) != capture["sha256"] or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
                raise ValueError("Screenshot bytes/hash/header invalid")
            width, height = struct.unpack(">II", data[16:24])
            images.append({**capture, "width": width, "height": height})
        result.append({"name": name, "receipt": str(path.relative_to(output)), "sha256": digest(regular(path)), "images": images})
    return result


def main():
    phase, repo_arg, output_arg = sys.argv[1:]
    repo, output = Path(repo_arg).resolve(), Path(output_arg).resolve()
    output.mkdir(parents=True, exist_ok=False)
    assets = Path(__file__).resolve().parent
    binding = json.loads(regular(assets / "binding.json"))
    manifest = json.loads(regular(assets / "publication-manifest.json"))
    fixtures = json.loads(regular(assets / "install-manifest.json"))
    verdict = {"phase": phase, "completed": False, "errors": [], "fixtureCleanup": "not-installed"}
    steps, owned, reports = [], [], []
    before = None
    state = output.parent / (output.name + "-synthetic-state")
    exit_code = 1
    try:
        if binding["mode"] != "browser-preservation" or phase not in ("baseline", "candidate"):
            raise ValueError("Unsupported proof phase")
        revision = binding["phases"][phase]
        if revision["enabled"] is not True or revision["repository"] != "openclaw/openclaw":
            raise ValueError("This revision is disabled; root must seal and enable it before execution")
        for name, expected_sha in manifest.items():
            if digest(regular(assets / name)) != expected_sha:
                raise ValueError(f"Published proof asset mismatch: {name}")
        provenance = {key: os.environ.get(key) for key in ("GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF",
            "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH")}
        if provenance["RUNNER_ENVIRONMENT"] != "github-hosted" or provenance["RUNNER_OS"] != "Linux":
            raise ValueError("Only GitHub-hosted Linux is supported")
        os_release = Path("/etc/os-release").read_text()
        if 'VERSION_ID="24.04"' not in os_release.splitlines() or "ID=ubuntu" not in os_release.splitlines():
            raise ValueError("Ubuntu 24.04 is required")
        if provenance["GITHUB_REPOSITORY"] != "steipete/openclaw" or provenance["GITHUB_REF"] != "refs/heads/codex/round10-ui-memory-copy-proof":
            raise ValueError("Unexpected proof repository/ref")
        if git(assets, "rev-parse", "HEAD").decode().strip() != provenance["GITHUB_SHA"]:
            raise ValueError("Proof checkout does not equal the workflow SHA")
        provenance["uname"] = list(os.uname())
        write_json(output / "provenance.json", provenance)
        (output / "os-release.txt").write_text(os_release)
        for name in ("binding.json", "publication-manifest.json", "install-manifest.json"):
            shutil.copyfile(assets / name, output / name)
        before = snapshot(repo, output, "before-install", revision)
        for name, expected_sha in revision["sourceSha256"].items():
            if digest(regular(repo / name)) != expected_sha:
                raise ValueError(f"Pinned source input mismatch: {name}")
        for name in revision.get("absentSourcePaths", []):
            if os.path.lexists(repo / name):
                raise ValueError(f"Baseline source path expected absent: {name}")
        if (repo / "node_modules").exists() or (repo / "dist").exists():
            raise ValueError("Proof requires a fresh checkout")
        state.mkdir(exist_ok=False)
        for name in ("home", "tmp", "cache", "config", "data", "corepack", "bin"):
            (state / name).mkdir()
        env = {"PATH": str(state / "bin") + os.pathsep + os.environ["PATH"], "HOME": str(state / "home"),
               "TMPDIR": str(state / "tmp"), "XDG_CACHE_HOME": str(state / "cache"),
               "XDG_CONFIG_HOME": str(state / "config"), "XDG_DATA_HOME": str(state / "data"),
               "COREPACK_HOME": str(state / "corepack"), "CI": "true", "GITHUB_ACTIONS": "true",
               "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "OPENCLAW_UI_E2E_ARTIFACT_DIR": str(output / "browser")}
        write_json(output / "execution-environment.json", env)
        manager = json.loads(regular(repo / "package.json"))["packageManager"]
        if manager != binding["packageManager"]:
            raise ValueError("Package manager identity differs from the binding")
        preparation = [
            ("node-version", ["node", "--version"], 30),
            ("corepack-enable", ["corepack", "enable", "--install-directory", str(state / "bin")], 60),
            ("pnpm-prepare", ["corepack", "prepare", manager, "--activate"], 300),
            ("pnpm-version", ["pnpm", "--version"], 30),
            ("install", ["pnpm", "install", "--frozen-lockfile"], 1200),
            ("playwright-version", ["pnpm", "--dir", "ui", "exec", "playwright", "--version"], 30),
            ("chromium-install", ["pnpm", "--dir", "ui", "exec", "playwright", "install", "--with-deps", "chromium"], 600),
        ]
        versions = {"node-version": "v24.19.0", "pnpm-version": "12.1.0", "playwright-version": "Version 1.62.1"}
        for label, argv, timeout in preparation:
            run(repo, output, env, label, argv, timeout, steps)
            if label in versions and (output / f"{label}.stdout").read_text().strip() != versions[label]:
                raise ValueError(f"Unexpected runtime version: {label}")
        if snapshot(repo, output, "after-install", revision) != before:
            raise ValueError("Frozen install changed source or real index")
        browser_probe = "const {chromium}=require('./ui/node_modules/playwright');process.stdout.write(JSON.stringify({path:chromium.executablePath()}));"
        run(repo, output, env, "chromium-path", ["node", "-e", browser_probe], 30, steps)
        browser_path = Path(json.loads((output / "chromium-path.stdout").read_text())["path"])
        if not browser_path.is_relative_to(state):
            raise ValueError("Playwright executable is not in this job's isolated installation")
        run(repo, output, env, "chromium-version", [str(browser_path), "--version"], 30, steps)
        write_json(output / "browser-runtime.json", {"path": str(browser_path), "sha256": digest(regular(browser_path)),
            "version": (output / "chromium-version.stdout").read_text().strip(), "playwright": "1.62.1"})
        write_json(output / "fixtures-installed.json", install_fixtures(repo, assets, fixtures, owned))
        for number, title in enumerate(FALLBACK_TITLES):
            label = f"fallback-{number + 1}"
            fixture_state(repo, owned)
            argv = ["node", "scripts/run-vitest.mjs", "run", "--config", "ui/vitest.config.ts", "--configLoader", "runner",
                    "--project", "unit", FALLBACK_PATH, "-t", f"^{title}$", "--reporter=default", "--reporter=json",
                    f"--outputFile={output / (label + '.json')}"]
            run(repo, output, env, label, argv, 300, steps)
            fixture_state(repo, owned)
            reports.append(check_test_report(repo, output, label, FALLBACK_PATH, [title], [FALLBACK_TITLES[1 - number]]))
        fixture_state(repo, owned)
        run(repo, output, env, "browser-tests", ["node", "scripts/run-vitest.mjs", "run", "--config", "test/vitest/vitest.ui-e2e.config.ts",
            "--configLoader", "runner", "--project", "ui-e2e-bundled", BROWSER_PATH, "--reporter=default", "--reporter=json",
            f"--outputFile={output / 'browser-tests.json'}"], 1200, steps)
        fixture_state(repo, owned)
        reports.append(check_test_report(repo, output, "browser-tests", BROWSER_PATH, BROWSER_TITLES, []))
        verdict["captures"] = check_captures(output)
        verdict["tests"] = reports
        verdict["completed"] = True
        exit_code = 0
    except BaseException as error:
        verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
    finally:
        joins_complete = bool(steps) and all(row.get("exitCode") == 0 and row.get("processGroupGone") is True
                                           and not row.get("timedOut") for row in steps)
        verdict["ownedCommandJoinsComplete"] = joins_complete
        try:
            if owned:
                write_json(output / "fixtures-final.json", fixture_state(repo, owned))
                if joins_complete:
                    for entry in owned:
                        (repo / entry["destination"]).unlink()
                    verdict["fixtureCleanup"] = "owned-files-unlinked-after-successful-native-joins"
                else:
                    verdict["fixtureCleanup"] = "retained-until-ephemeral-host-teardown; owned joins not proven"
            if before is not None:
                after = snapshot(repo, output, "final", binding["phases"][phase])
                verdict["sourceAndIndexUnchanged"] = before == after
                if before != after:
                    raise ValueError("Final full source/raw index changed")
            if state.exists() and joins_complete:
                shutil.rmtree(state)
            verdict["syntheticStateRemoved"] = not state.exists()
        except BaseException as error:
            verdict["errors"].append({"message": str(error), "stack": traceback.format_exc()})
            verdict["completed"] = False
            exit_code = 1
        if not joins_complete:
            verdict["completed"] = False
            exit_code = 1
        verdict["cleanupScope"] = "No persistent lease; job host is ephemeral. Runtime teardown is owned by unchanged suite and native Vitest wrappers."
        write_json(output / "verdict.json", verdict)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
