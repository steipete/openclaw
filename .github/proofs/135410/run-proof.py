"""Hosted-only PowerShell extraction proof; no installer entrypoint or dependency install."""
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

BASE_SHA = "af531525c46444521986002d64b888ee5ed097cb"
BASE_HASH = "b3203481f6a1dc9fbe73ced87c9ca3b76102a957fefce7c01e6c230db2545875"
AFTER_HASH = "1d4ba1cafb90a8fd1472ad99687433774441909777728b5470918203117473e2"
OLD = "        & $tarCommand.Source -xf $ZipPath -C $DestinationPath --strip-components 1"
NEW = '        Invoke-CommandFromWindowsSafeDirectory -CommandPath $tarCommand.Source -Arguments @("-xf", $ZipPath, "-C", $DestinationPath, "--strip-components", "1")'
ENTRY = re.compile(r"\r?\n\$null = Main\r?\nComplete-Install\s*$", re.M)
NODE_HASH = hashlib.sha256(b"node fixture bytes").hexdigest()
OUTPUT_CAP = 2 * 1024 * 1024
# Resolve only the current engine's required stock modules before module autoload can
# search unrelated runner modules; this identical setup precedes every proof process.
STOCK_MODULE_SETUP = (
    "foreach ($proofModule in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management')) { "
    "$proofModulePath = [IO.Path]::Combine($PSHOME, 'Modules', $proofModule, ($proofModule + '.psd1')); "
    "[Console]::Error.WriteLine('stock-module-import=' + $proofModulePath); "
    "Import-Module -Name $proofModulePath -ErrorAction Stop; "
    "[Console]::Error.WriteLine('stock-module-loaded=' + $proofModule); }; "
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git_head(root):
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def child_environment(temp):
    # Candidate PowerShell sees only Windows process prerequisites and task-owned temp paths.
    names = {
        "systemroot", "windir", "comspec", "path", "pathext", "userprofile",
        "localappdata", "appdata", "programfiles", "programfiles(x86)",
        "programw6432", "processor_architecture", "processor_architew6432",
        "os", "number_of_processors",
    }
    # PS7 -> Python -> Windows PowerShell must not inherit PS7 module paths.
    # Each engine reconstructs its stock module path; no caller modules are injected.
    env = {key: value for key, value in os.environ.items() if key.lower() in names}
    profile = temp / "profile"
    local = profile / "AppData/Local"
    roaming = profile / "AppData/Roaming"
    local.mkdir(parents=True)
    roaming.mkdir(parents=True)
    env.update(TEMP=str(temp), TMP=str(temp), HOME=str(profile), USERPROFILE=str(profile),
               LOCALAPPDATA=str(local), APPDATA=str(roaming))
    return env


def run_child(argv, env, cwd, prefix):
    stdout_path = prefix.with_suffix(".stdout")
    stderr_path = prefix.with_suffix(".stderr")
    started = time.monotonic()
    termination = None
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        proc = subprocess.Popen(
            argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
            stdout=stdout, stderr=stderr,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        while proc.poll() is None:
            total = stdout_path.stat().st_size + stderr_path.stat().st_size
            if total > OUTPUT_CAP or time.monotonic() - started > 30:
                termination = "output-limit" if total > OUTPUT_CAP else "timeout"
                killer = Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe"
                subprocess.run(
                    [str(killer), "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                    check=False,
                )
                proc.wait(timeout=10)
                break
            time.sleep(0.1)
        code = proc.wait()
    if stdout_path.stat().st_size + stderr_path.stat().st_size > OUTPUT_CAP:
        termination = "output-limit"
    return {
        "argv": argv, "exitCode": code, "termination": termination,
        "seconds": round(time.monotonic() - started, 3),
        "stdoutSha256": digest(stdout_path.read_bytes()),
        "stderrSha256": digest(stderr_path.read_bytes()),
    }


def main():
    baseline, work, output = (Path(arg).resolve() for arg in sys.argv[1:])
    require(not work.exists() and not output.exists(), "Proof workspace already exists")
    work.mkdir(parents=True)
    output.mkdir(parents=True)
    rows_dir = output / "rows"
    rows_dir.mkdir()
    temp = work / "temp"
    temp.mkdir()
    script_root = Path(__file__).resolve().parent
    assets_root = script_root.parents[2]
    report = {"schema": "openclaw-portable-node-hosted-proof-v1", "status": "running", "rows": []}
    try:
        require(os.name == "nt", "Windows required")
        require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "GitHub-hosted runner required")
        require(os.environ.get("RUNNER_OS") == "Windows", "Windows runner metadata required")
        require(os.environ.get("GITHUB_REPOSITORY") == "steipete/openclaw", "Unexpected proof repository")
        require(os.environ.get("GITHUB_REF") == "refs/heads/codex/round10-windows-node-proof", "Unexpected proof branch")
        require(git_head(assets_root) == os.environ["GITHUB_SHA"], "Proof assets not at workflow SHA")
        manifest_bytes = (assets_root / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        for relative, expected in manifest.items():
            path = (assets_root / relative).resolve()
            require(path.is_relative_to(assets_root), "Manifest path escaped proof assets")
            data = path.read_bytes()
            actual = digest(data)
            report.setdefault("assetVerification", []).append({
                "path": relative, "expectedSha256": expected, "actualSha256": actual,
                "bytes": len(data), "lfCount": data.count(b"\n"),
                "crlfCount": data.count(b"\r\n"),
            })
            require(actual == expected, "Proof asset hash mismatch: " + relative)
        require(git_head(baseline) == BASE_SHA, "Baseline checkout SHA mismatch")
        original = subprocess.check_output(["git", "-C", str(baseline), "show", BASE_SHA + ":scripts/install.ps1"])
        require(digest(original) == BASE_HASH, "Baseline installer bytes mismatch")
        materialized = (baseline / "scripts/install.ps1").read_bytes()
        require(materialized.replace(b"\r\n", b"\n") == original, "Materialized baseline differs from pinned blob")
        text = original.decode("utf-8")
        require(text.count(OLD) == 1, "One exact tar call required")
        revised = text.replace(OLD, NEW).encode("utf-8")
        require(digest(revised) == AFTER_HASH, "Reviewed overlay bytes mismatch")
        harness = (script_root / "extraction-case.ps1").read_bytes()
        source_binding = {
            "workflowSha": os.environ["GITHUB_SHA"], "manifestSha256": digest(manifest_bytes),
            "baselineSha": BASE_SHA, "baselineInstallerSha256": BASE_HASH,
            "afterInstallerSha256": AFTER_HASH, "harnessSha256": digest(harness),
            "materializedInstallerSha256": digest(materialized),
            "sourceBytes": "Exact Git blob, avoiding Windows checkout newline conversion",
            "afterIdentity": "Reviewed one-line data overlay; not a published candidate commit",
            "runner": {key: os.environ.get(key) for key in (
                "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion",
                "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB",
            )},
        }
        write_json(output / "source-binding.json", source_binding)
        env = child_environment(temp)
        ps51 = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        ps7 = shutil.which("pwsh")
        require(ps51.is_file() and ps7, "Both PowerShell engines are required")
        engines = {"ps51": str(ps51), "ps7": ps7}
        for key, engine in engines.items():
            report["phase"] = "engine-probe:" + key
            write_json(output / "run.json", report)
            probe_command = (
                "[Console]::Error.WriteLine('probe-entered'); "
                "[Console]::Error.WriteLine('probe-pshome=' + $PSHOME); "
                "[Console]::Error.WriteLine('probe-modulepath=' + $env:PSModulePath); "
                + STOCK_MODULE_SETUP
                + "@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;hostName=$Host.Name}|ConvertTo-Json -Compress; "
                "[Console]::Error.WriteLine('probe-serialized')"
            )
            probe = run_child(
                [engine, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe_command],
                env, work, rows_dir / ("probe-" + key),
            )
            write_json(rows_dir / ("probe-" + key + ".command.json"), probe)
            require(probe["termination"] is None, key + " probe " + str(probe["termination"]))
            require(probe["exitCode"] == 0, key + " probe failed")
            identity = json.loads((rows_dir / ("probe-" + key + ".stdout")).read_bytes().decode("utf-8-sig"))
            required = ("5.1.", "Desktop") if key == "ps51" else ("7.", "Core")
            require(identity["version"].startswith(required[0]) and identity["edition"] == required[1], "Wrong engine version")
            source_binding[key] = identity
        write_json(output / "source-binding.json", source_binding)
        for variant, full in (("before", original), ("after", revised)):
            module, count = ENTRY.subn("", full.decode("utf-8"))
            require(count == 1, "Canonical installer entrypoint not found exactly once")
            assembled = module.encode("utf-8") + b"\n" + harness
            source_binding[variant + "ExecutedSha256"] = digest(assembled)
            write_json(output / "source-binding.json", source_binding)
            script = work / (variant + ".ps1")
            script.write_bytes(assembled)
            for engine_key, mode, outcome in itertools.product(
                engines, ("redirected", "unmerged"), ("noisy-failure", "quiet-failure", "tar-success")
            ):
                case_id = "-".join((variant, engine_key, mode, outcome))
                record_path = rows_dir / (case_id + ".json")
                config_path = work / (case_id + "-config.json")
                write_json(config_path, {
                    "id": case_id, "mode": mode, "outcome": outcome,
                    "root": str(work / (case_id + " fixture")), "recordPath": str(record_path),
                    "expectedNodeSha256": NODE_HASH,
                })
                row_env = dict(env, OPENCLAW_INSTALL_PROOF_CONFIG=str(config_path))
                literal = "'" + str(script).replace("'", "''") + "'"
                invocation = STOCK_MODULE_SETUP + "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Get-Content -LiteralPath " + literal + " -Raw)))"
                command = [engines[engine_key], "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", invocation]
                receipt = run_child(command, row_env, work, rows_dir / case_id)
                write_json(rows_dir / (case_id + ".command.json"), receipt)
                require(receipt["termination"] is None, case_id + " process limit exceeded")
                require(record_path.is_file(), case_id + " lacks a verdict")
                row = json.loads(record_path.read_text(encoding="utf-8-sig"))
                require(row["id"] == case_id and row["schema"] == "openclaw-portable-node-extraction-proof-v1", "Verdict identity mismatch")
                require("completed" in row, case_id + " fixture setup failed: " + "; ".join(row.get("errors", [])))
                require(row.get("cleanupComplete") and row.get("pathRestored"), case_id + " cleanup failed")
                require(row.get("preferenceRestored") and row.get("locationRestored"), case_id + " caller state leaked")
                require(row.get("actualArguments") == row.get("expectedArguments") and len(row["actualArguments"]) == 6, case_id + " argv mismatch")
                expected_exit = 0 if outcome == "tar-success" else 17
                require(row.get("nativeExit") == expected_exit, case_id + " native exit mismatch")
                expected_red = variant == "before" and engine_key == "ps51" and mode == "redirected" and outcome == "noisy-failure"
                if expected_red:
                    require(receipt["exitCode"] == 1 and row["status"] == "fail", "Required original RED missing")
                    require(row.get("completed") is False and "tar fixture failure" in (row.get("caught") or ""), "RED was not native stderr failure")
                    require(not row.get("nodeExists") and row.get("partialRemains"), "RED did not precede fallback publication")
                    require(set(row["errors"]) == {"owner invocation failed", "published bytes mismatch", "partial tar output remains"}, "RED has unrelated failures")
                else:
                    require(receipt["exitCode"] == 0 and row["status"] == "pass" and row["errors"] == [], case_id + " did not pass")
                    require(row.get("completed") and row["nodeSha256"] == NODE_HASH, case_id + " publication failed")
                    require(row["fallbackTempCount"] == 0 and not row["partialRemains"], case_id + " extraction cleanup failed")
                    output_text = (rows_dir / (case_id + ".stdout")).read_text(encoding="utf-8", errors="replace") + "\n" + (rows_dir / (case_id + ".stderr")).read_text(encoding="utf-8", errors="replace") + "\n" + "\n".join(row["invocationOutput"])
                    require("native-tar-complete" in output_text, case_id + " native stdout lost")
                    require(("tar fixture failure" in output_text) == (outcome == "noisy-failure"), case_id + " native stderr changed")
                    require(("trying .NET zip extraction" in output_text) == (outcome != "tar-success"), case_id + " wrong fallback branch")
                    if variant == "after":
                        require(os.path.normcase(row["nativeCwd"]) == os.path.normcase(row["safeLocation"]), case_id + " did not use safe native cwd")
                report["rows"].append({"id": case_id, "observed": "expected-red" if expected_red else "pass", "verdictSha256": digest(record_path.read_bytes())})
                write_json(output / "run.json", report)
                print(case_id + ": " + report["rows"][-1]["observed"], flush=True)
            # Any unexpected before failure aborts above; only validated original behavior admits the after overlay.
        require(len(report["rows"]) == 24, "Incomplete proof matrix")
        require((baseline / "scripts/install.ps1").read_bytes() == materialized, "Baseline installer changed")
        write_json(output / "source-binding.json", source_binding)
        report["status"] = "pass"
        report["expectedRed"] = 1
        report["beforeControlsPassed"] = 11
        report["afterPassed"] = 12
    except Exception as exc:
        report["status"] = "fail"
        report["error"] = str(exc)
    finally:
        try:
            shutil.rmtree(work)
            report["workspaceCleanupComplete"] = not work.exists()
        except Exception as exc:
            report["status"] = "fail"
            report["cleanupError"] = str(exc)
        write_json(output / "run.json", report)
    require(report["status"] == "pass", report.get("error", "Proof failed"))


if __name__ == "__main__":
    main()
