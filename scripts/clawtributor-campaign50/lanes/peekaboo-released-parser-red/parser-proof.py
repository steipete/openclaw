"""Run only on the campaign's disposable hosted macOS envelope; never a desktop."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tarfile
import urllib.request

TARGET = Path(sys.argv[1]).resolve()
LANE = Path(sys.argv[2]).resolve()
EVIDENCE = Path(sys.argv[3]).resolve()
MODE = sys.argv[4]
SOURCE = "6adfb69831b86e93bcd3fd365e11a22700fb37bb"
RELEASE_SOURCE = "f047bd97a260814bfebf4c81e7a4fdfe64581ff4"
ARCHIVE_SHA = "e26f9782d22ae346821c91dc454a50797c045d20a7eece7ede160bd94f165ffd"
ARCHIVE_BYTES = 30_784_077
URL = "https://github.com/openclaw/Peekaboo/releases/download/v4.3.1/peekaboo-macos-universal.tar.gz"
SKILL_SHA = "0e7f6ae6c9a3d82f58f013b391d7eaa0259f60081de053e9ce0fde70724cc5ff"
REQUIREMENT = 'anchor apple generic and certificate leaf[subject.OU] = "FWJYW4S8P8" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
receipt = {"phase": "preflight", "passed": False, "commands": [], "cases": []}
owned_cli_pids = set()
registry = None


def save():
    (EVIDENCE / "parser-proof.json").write_text(json.dumps(receipt, indent=2) + "\n")


def run(name, args, env=None, cli=False):
    entry = {"name": name, "argv": [str(arg) for arg in args]}
    receipt["commands"].append(entry)
    stdout = EVIDENCE / f"{name}.stdout.log"
    stderr = EVIDENCE / f"{name}.stderr.log"
    with stdout.open("wb") as out, stderr.open("wb") as err:
        process = subprocess.Popen(args, env=env, cwd=TARGET, stdin=subprocess.DEVNULL,
                                   stdout=out, stderr=err, start_new_session=True)
        entry["pid"] = process.pid
        if cli:
            owned_cli_pids.add(process.pid)
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
        entry["exitCode"] = process.returncode
    save()
    assert process.poll() is not None and not entry.get("timedOut"), name
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        entry["processGroupGone"] = True
    else:
        raise AssertionError(f"Owned process group survived: {name}")
    assert stdout.stat().st_size <= 512 * 1024 and stderr.stat().st_size <= 512 * 1024
    return process.returncode, stdout.read_text(), stderr.read_text()


def check_registry():
    if registry.exists():
        names = sorted(entry.name for entry in registry.iterdir())
        for name in names:
            match = re.fullmatch(r"boo\.peekaboo\.sckit-aware\.(\d+)\.(\d+)", name)
            assert match and int(match.group(1)) in owned_cli_pids, "Foreign capability marker"
        receipt["transientMarkers"] = names
    else:
        receipt["transientMarkers"] = []
    save()


try:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    assert MODE == "red"
    assert os.environ.get("CI") == "true" and os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    assert os.environ.get("RUNNER_OS") == "macOS"
    assert sys.platform == "darwin" and platform.machine() == "arm64"
    home = Path(os.environ["HOME"]).resolve()
    assert str(home.parent).startswith("/private/tmp/oc-proof-") or str(home.parent).startswith("/tmp/oc-proof-")
    assert home.name == "home" and Path(os.environ["CFFIXED_USER_HOME"]).resolve() == home
    assert subprocess.check_output(["git", "-C", str(TARGET), "rev-parse", "HEAD"], text=True).strip() == SOURCE
    skill = TARGET / "skills/peekaboo/SKILL.md"
    assert hashlib.sha256(skill.read_bytes()).hexdigest() == SKILL_SHA
    receipt.update({"source": SOURCE, "releaseSource": RELEASE_SOURCE, "skillSha256": SKILL_SHA,
                    "scope": "released CLI parser/help only; no GUI, Bridge or provider command"})
    archive = EVIDENCE / "peekaboo-4.3.1.tar.gz"
    receipt["phase"] = "acquire"
    with urllib.request.urlopen(URL, timeout=60) as source, archive.open("xb") as output:
        size = 0
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            assert size <= ARCHIVE_BYTES
            output.write(chunk)
    assert size == ARCHIVE_BYTES
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA
    toolroot = home.parent / "peekaboo-release-4.3.1"
    toolroot.mkdir(mode=0o700)
    payload = json.loads((LANE / "PAYLOAD-HASHES.json").read_text())
    with tarfile.open(archive, "r:gz") as package:
        for name, expected in payload.items():
            assert name in {"peekaboo", "libswiftCompatibilitySpan.dylib", "LICENSE", "README.md", "VERSION"}
            member = package.getmember("peekaboo-macos-universal/" + name)
            assert member.isfile() and member.size == expected["size"]
            data = package.extractfile(member).read()
            assert hashlib.sha256(data).hexdigest() == expected["sha256"]
            destination = toolroot / name
            destination.write_bytes(data)
            destination.chmod(expected["mode"])
    binary = toolroot / "peekaboo"
    assert (toolroot / "VERSION").read_text().strip() == "4.3.1"
    receipt["archiveSha256"] = ARCHIVE_SHA
    receipt["payloadHashes"] = payload
    receipt["phase"] = "signature"
    code, _, _ = run("signature", ["/usr/bin/codesign", "--verify", "--strict", "-R", "=" + REQUIREMENT, str(binary)])
    assert code == 0
    code, _, signature = run("signature-details", ["/usr/bin/codesign", "-d", "--verbose=4", str(binary)])
    assert code == 0 and "TeamIdentifier=FWJYW4S8P8" in signature
    assert "Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)" in signature
    code, _, _ = run("compat-library-signature", ["/usr/bin/codesign", "--verify", "--strict", str(toolroot / "libswiftCompatibilitySpan.dylib")])
    assert code == 0
    code, architectures, _ = run("architectures", ["/usr/bin/lipo", "-archs", str(binary)])
    assert code == 0 and set(architectures.split()) == {"arm64", "x86_64"}
    config = home / "peekaboo-proof-config"
    config.mkdir(mode=0o700)
    (config / "config.json").write_text("{}\n")
    cli_env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
               "CFFIXED_USER_HOME": str(home), "TMPDIR": os.environ["TMPDIR"],
               "PEEKABOO_CONFIG_DIR": str(config), "PEEKABOO_CONFIG_DISABLE_MIGRATION": "1",
               "LANG": "en_US.UTF-8", "TERM": "dumb"}
    code, temporary, _ = run("canonical-user-temp", ["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], env=cli_env)
    assert code == 0 and Path(temporary.strip()).is_dir()
    registry = Path(temporary.strip()) / "boo.peekaboo.sckit-aware"
    assert not registry.exists() or not any(registry.iterdir()), "Runner has prior Peekaboo capability state"
    receipt["initialTransientRegistryEmpty"] = True
    receipt["phase"] = "version"
    code, output, error = run("version", [str(binary), "--version"], env=cli_env, cli=True)
    check_registry()
    version = output.strip()
    match = re.fullmatch(r"Peekaboo 4\.3\.1 \([^\n]*/([a-f0-9]{7,40}), built: [^\n]+\)", version)
    assert code == 0 and error == "" and match and RELEASE_SOURCE.startswith(match.group(1))
    plan = json.loads((LANE / "release-plan.json").read_text())
    assert plan["source_commit"] == RELEASE_SOURCE and plan["version"] == "4.3.1"
    assert plan["publication_eligible"] is True
    receipt["version"] = version
    receipt["releasePlanSource"] = plan["source_commit"]
    receipt["phase"] = "parser"
    cases = [
        ("apps", ["list", "apps", "--help"], ["app", "list", "--help"], "peekaboo app list"),
        ("image", ["image", "--help"], ["see", "--help"], "peekaboo see --no-elements"),
        ("keys", ["hotkey", "--help"], ["press", "--help"], "peekaboo press"),
        ("drag", ["swipe", "--help"], ["drag", "--help"], "peekaboo drag"),
    ]
    for name, old, current, replacement in cases:
        check_registry()
        code, output, error = run(f"old-{name}", [str(binary), *old], env=cli_env, cli=True)
        check_registry()
        expected_error = f"Error: Command 'peekaboo {old[0]}' was removed in v4. Use '{replacement}'.\n"
        assert code == 1 and output == "" and error == expected_error
        code, output, error = run(f"current-{name}", [str(binary), *current], env=cli_env, cli=True)
        check_registry()
        plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
        assert code == 0 and error == "" and "removed in v4" not in output
        assert any(line.strip().rstrip(":").lower() == "usage" for line in plain.splitlines())
        assert re.search(r"(?m)^\s*peekaboo " + re.escape(" ".join(current[:-1])) + r"(?:\s|$)", plain)
        features = {"apps": ["--json"], "image": ["--no-elements"],
                    "keys": ["--foreground", "cmd+shift+t"], "drag": ["--from", "--to"]}[name]
        assert all(feature in plain for feature in features), name
        receipt["cases"].append({"name": name, "old": old, "current": current,
                                 "oldRejectedAsRemoved": True, "currentHelpSucceeded": True,
                                 "declaredHelpFeatures": features})
        save()
    assert len(receipt["cases"]) == 4
    assert sorted(entry.name for entry in config.iterdir()) == ["config.json"]
    assert (config / "config.json").read_text() == "{}\n"
    assert hashlib.sha256(skill.read_bytes()).hexdigest() == SKILL_SHA
    check_registry()
    receipt.update({"phase": "complete", "passed": True, "baselineRejectedCommands": 4,
                    "supportedHelpControls": 4, "guiCommandsExecuted": 0,
                    "transientCleanup": "normal CLI pruning retained; last owned marker left to disposable runner teardown"})
    save()
except Exception as error:
    receipt.update({"errorType": type(error).__name__, "error": str(error)})
    save()
    raise
