"""Copy only the reviewed data subset from the immutable prior artifact ZIP."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


MANIFEST_SHA256 = "89405fd851ec36a213ab622df4f853069c484a61b549677f66667065a1a11e53"
ZIP_SHA256 = "0498dfdf394c1432743b892943831d7fdc88c76ce913d9edec682652e7755a04"
ZIP_BYTES = 60559347


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_members(archive, files, prefix, destination):
    """The caller authenticates both archive and manifest before copying data."""
    require(not destination.exists(), "verified destination must be fresh")
    destination.mkdir(parents=True)
    infos = archive.infolist()
    for relative, expected in files.items():
        parts = PurePosixPath(relative).parts
        require(parts and not relative.startswith("/") and ".." not in parts,
                "manifest path must stay within destination")
        matches = [info for info in infos if info.filename == prefix + relative]
        require(len(matches) == 1, "expected exactly one allowed archive member")
        member = matches[0]
        kind = stat.S_IFMT(member.external_attr >> 16)
        require(not member.is_dir() and kind in (0, stat.S_IFREG),
                "allowed archive member must be an ordinary file")
        require(member.file_size == expected["size"], "archive member size mismatch")
        with archive.open(member) as source:
            data = source.read(expected["size"] + 1)
        require(len(data) == expected["size"], "archive member content size mismatch")
        require(hashlib.sha256(data).hexdigest() == expected["sha256"],
                "archive member content digest mismatch")
        target = destination.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)


def verify(manifest_path, raw_directory, destination):
    require(manifest_path.is_file() and not manifest_path.is_symlink(),
            "expected regular controller manifest")
    manifest_bytes = manifest_path.read_bytes()
    require(hashlib.sha256(manifest_bytes).hexdigest() == MANIFEST_SHA256,
            "controller manifest digest mismatch")
    manifest = json.loads(manifest_bytes)
    require(manifest["artifactId"] == 10003125023 and manifest["runId"] == 34078660938,
            "prior artifact identity mismatch")
    require(manifest["repository"] == "steipete/openclaw"
            and manifest["artifactZipSha256"] == ZIP_SHA256,
            "prior artifact repository or digest mismatch")
    require(len(manifest["files"]) == 23
            and sum(item["size"] for item in manifest["files"].values()) == 61621891,
            "reviewed subset inventory mismatch")
    require(raw_directory.is_dir() and not raw_directory.is_symlink(),
            "expected ordinary download directory")
    entries = list(raw_directory.iterdir())
    require(len(entries) == 1 and stat.S_ISREG(entries[0].lstat().st_mode),
            "expected one ordinary raw artifact file")
    archive_path = entries[0]
    require(archive_path.stat().st_size == ZIP_BYTES, "prior ZIP size mismatch")
    require(digest_file(archive_path) == ZIP_SHA256, "prior ZIP digest mismatch")
    with zipfile.ZipFile(archive_path) as archive:
        copy_members(archive, manifest["files"], manifest["archivePrefix"], destination)
    source = json.loads((destination / "source.json").read_text())
    require(source["source"] == manifest["source"]
            and (destination / "source-sha.txt").read_text().strip() == manifest["source"],
            "retained source receipts disagree")
    return {"passed": True, "phase": "verified-subset", "artifactId": manifest["artifactId"],
            "runId": manifest["runId"], "manifestSha256": MANIFEST_SHA256,
            "zipSha256": ZIP_SHA256, "source": manifest["source"], "fileCount": 23,
            "retention": "owned transport files remain until disposable runner teardown"}


def main():
    manifest_path, raw_directory, destination, receipt = map(Path, sys.argv[1:])
    result = {"passed": False, "phase": "verifying-subset"}
    try:
        result = verify(manifest_path, raw_directory, destination)
    except Exception as error:
        result["errorType"] = type(error).__name__
        result["phase"] = "verification-failed"
        receipt.write_text(json.dumps(result, indent=2) + "\n")
        raise SystemExit(1) from None
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print("Verified the 23-file immutable telemetry reuse subset.")


if __name__ == "__main__":
    main()
