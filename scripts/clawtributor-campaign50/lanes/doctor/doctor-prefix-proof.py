#!/usr/bin/env python3
"""Exercise Doctor prefix recovery on isolated, synthetic Linux filesystems."""
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading

checkout = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
results = []


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run_case(name):
    root = Path(tempfile.mkdtemp(prefix=f"doctor-prefix-{name}-"))
    volume = root / "volume"
    volume.mkdir()
    mounted = False
    directory_unowned = False
    try:
        if name == "constrained":
            subprocess.run(
                ["sudo", "mount", "-t", "tmpfs", "-o", "size=20m,mode=0700", "tmpfs", str(volume)],
                check=True,
            )
            mounted = True
            subprocess.run(["sudo", "chown", f"{os.getuid()}:{os.getgid()}", str(volume)], check=True)
        home = root / "home"
        home.mkdir()
        state = root / "state"
        state.mkdir()
        config = volume / "openclaw.json"
        original_config = {
            "gateway": {"mode": "local", "port": free_port()},
            "agents": {"defaults": {"params": {"proofPadding": "p" * 409000}}},
        }
        recovered = (json.dumps(original_config, indent=2) + "\n").encode()
        original = b"Found and updated: False\n" + b"x" * 1000000 + b"\n" + recovered
        config.write_bytes(original)
        config.chmod(0o444 if name == "read-only-config" else 0o644)
        if name == "unowned-directory":
            subprocess.run(["sudo", "chown", "root:root", str(volume)], check=True)
            directory_unowned = True
            subprocess.run(["sudo", "chmod", "755", str(volume)], check=True)
        stop_lock_heartbeat = threading.Event()
        lock_heartbeat = None
        if name == "snapshot-unavailable":
            lock = volume / "openclaw.json.clobber.lock"
            lock.write_text("synthetic occupied snapshot lock\n")

            def keep_snapshot_lock_current():
                while not stop_lock_heartbeat.wait(1):
                    lock.touch()

            lock_heartbeat = threading.Thread(target=keep_snapshot_lock_current)
        reserved = None
        if name == "constrained":
            fs_stat = os.statvfs(volume)
            block = fs_stat.f_frsize
            original_allocation = config.stat().st_blocks * 512
            recovered_allocation = math.ceil(len(recovered) / block) * block
            reserved = original_allocation + recovered_allocation // 2
            remaining = fs_stat.f_bavail * block - reserved
            with (volume / "filler").open("wb") as filler:
                while remaining > 0:
                    chunk = min(remaining, 1024 * 1024)
                    filler.write(b"\0" * chunk)
                    remaining -= chunk
        child_env = os.environ.copy()
        child_env.update({
            "HOME": str(home),
            "OPENCLAW_HOME": str(home),
            "OPENCLAW_STATE_DIR": str(state),
            "OPENCLAW_CONFIG_PATH": str(config),
        })
        child = subprocess.Popen(
            ["pnpm", "openclaw", "doctor", "--repair", "--non-interactive"],
            cwd=checkout,
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        if lock_heartbeat:
            lock_heartbeat.start()
        try:
            output, _ = child.communicate(timeout=600)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
            raise RuntimeError("Doctor timed out; its proof-owned process group was terminated")
        finally:
            stop_lock_heartbeat.set()
            if lock_heartbeat:
                lock_heartbeat.join()
        # Retain only boolean diagnostics and hashes; Doctor may generate credentials.
        final = config.read_bytes()
        snapshots = list(volume.glob("openclaw.json.clobbered.*"))
        snapshot_preserved = len(snapshots) == 1 and snapshots[0].read_bytes() == original
        recovered_files = [
            path.name for path in [config, *volume.glob("openclaw.json.bak*")]
            if path.is_file() and path.read_bytes() == recovered
        ]
        summary = {
            "case": name,
            "exitCode": child.returncode,
            "originalSha256": digest(original),
            "finalSha256": digest(final),
            "recoveredSha256": digest(recovered),
            "recoveredBytesObservedIn": recovered_files,
            "snapshotCount": len(snapshots),
            "snapshotPreserved": snapshot_preserved,
            "enospc": "ENOSPC" in output,
            "permissionDenied": "EPERM" in output or "EACCES" in output,
            "prefixRemovalReported": "Removed non-JSON prefix from openclaw.json." in output,
            "inventedSnapshotClaim": "original saved as .clobbered.*" in output,
            "temporaryFiles": [path.name for path in volume.glob("*.tmp")],
        }
        if name == "constrained":
            summary["reservedBytes"] = reserved
        results.append(summary)
        (evidence / f"doctor-{name}.json").write_text(json.dumps(summary, indent=2) + "\n")
        if name == "constrained":
            assert child.returncode != 0 and summary["enospc"], summary
            assert final == original and snapshot_preserved, summary
            assert summary["temporaryFiles"] == [], summary
        elif name == "unowned-directory":
            assert child.returncode != 0 and summary["permissionDenied"], summary
            assert final == original and snapshots == [], summary
            assert not summary["prefixRemovalReported"], summary
            assert summary["temporaryFiles"] == [], summary
        else:
            assert child.returncode == 0, summary
            persisted = json.loads(final)
            assert persisted["agents"]["defaults"]["params"]["proofPadding"] == "p" * 409000, summary
            assert not final.startswith(b"Found and updated"), summary
            assert recovered_files, summary
            assert config.stat().st_mode & 0o777 == 0o600, summary
            assert summary["prefixRemovalReported"], summary
            assert not summary["inventedSnapshotClaim"], summary
            if name != "snapshot-unavailable":
                assert snapshot_preserved, summary
            else:
                assert snapshots == [], summary
    finally:
        if directory_unowned:
            subprocess.run(["sudo", "chown", f"{os.getuid()}:{os.getgid()}", str(volume)], check=True)
        if mounted:
            subprocess.run(["sudo", "umount", str(volume)], check=True)
        shutil.rmtree(root)


for case in ["ample", "constrained", "snapshot-unavailable", "read-only-config", "unowned-directory"]:
    run_case(case)
print("DOCTOR_PREFIX_PROOF_OK " + json.dumps(results))
