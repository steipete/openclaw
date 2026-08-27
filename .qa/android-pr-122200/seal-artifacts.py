"""Stage a bounded allowlist, never the mutable capture directory or symlinks."""

import hashlib
import json
import os
import pathlib
import re
import stat
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
root_files = {
    "manifest.json", "cleanup.json", "tooling-sha.txt", "java-version.txt",
    "disk-before.txt", "memory-before.txt", "runner-image.json", "sdk-install.log",
    "system-image.properties", "system-image-sha256.txt", "emulator-version.txt",
    "emulator-acceleration.txt", "emulator-gpu-options.txt", "avd-create.log",
    "applied-overlay.patch", "gradle-wrapper.properties", "gradle-daemon-jvm.properties",
    "gradle.log", "gradle-exit.txt", "unit-result.json", "apk-sha256.txt",
    "emulator.log", "boot.png", "app-install.log", "test-install.log",
    "native-driver.log", "native-driver-exit.txt", "native-result.json",
}
if not stat.S_ISDIR(source.lstat().st_mode):
    raise RuntimeError("Artifact source is not a regular directory")
entries = list(source.rglob("*"))
if len(entries) > 128:
    raise RuntimeError("Artifact entry count exceeds 128")
destination.mkdir(mode=0o700)
inventory = []
total = 0
for entry in sorted(entries):
    relative = entry.relative_to(source).as_posix()
    mode = entry.lstat().st_mode
    if stat.S_ISDIR(mode):
        if relative != "junit":
            raise RuntimeError(f"Unexpected artifact directory: {relative}")
        (destination / relative).mkdir(mode=0o700)
        continue
    allowed = relative in root_files or re.fullmatch(r"native-[a-z0-9_-]{1,64}\.(png|xml|json|log|txt)", relative)
    allowed = allowed or re.fullmatch(r"junit/TEST-[A-Za-z0-9_.$-]+\.xml", relative)
    if not allowed or not stat.S_ISREG(mode):
        raise RuntimeError(f"Artifact is not an allowed regular file: {relative}")
    # O_NOFOLLOW also rejects a final-component symlink replaced after lstat.
    descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise RuntimeError(f"Artifact changed file type: {relative}")
        data = stream.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        raise RuntimeError(f"Artifact exceeds 16 MiB: {relative}")
    total += len(data)
    if total > 64 * 1024 * 1024:
        raise RuntimeError("Artifacts exceed 64 MiB")
    output = destination / relative
    output.parent.mkdir(mode=0o700, exist_ok=True)
    output.write_bytes(data)
    inventory.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
if not inventory:
    raise RuntimeError("No proof artifacts were produced")
(destination / "artifact-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
print(json.dumps({"sealedFiles": len(inventory), "sealedBytes": total}))
