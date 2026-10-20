"""Canonical nine-file transport wrapper. Never signs, extracts or executes inputs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import sys
import zipfile

spec = importlib.util.spec_from_file_location("handoff_stage_contract", Path(__file__).with_name("stage-signed-unix-handoff.py"))
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


def limit(name):
    return 256 * 1024 * 1024 if name == "modules.tar.gz" else 4096 if name.endswith(".minisig") else 128 * 1024


def inventory(root):
    contract.canonical(root)
    contract.require(root.is_dir() and not root.is_symlink(), "Existing regular input directory required")
    found = set()
    for item in root.rglob("*"):
        contract.require(not item.is_symlink(), "Redirected source refused")
        name = item.relative_to(root).as_posix()
        if item.is_dir():
            contract.require(name == "routing", "Unexpected source directory")
        else:
            contract.require(name in contract.NAMES and item.is_file(), "Unexpected source file")
            found.add(name)
    contract.require(found == contract.NAMES, "Exact nine-file source required")


def zip_members(archive):
    entries = archive.infolist()
    # ZipInfo.filename silently normalizes backslashes on Windows. Check the
    # original wire name so Windows preflight matches the native Unix consumer.
    contract.require(len(entries) == len(contract.NAMES)
                     and {item.orig_filename for item in entries} == contract.NAMES,
                     "Exact nine-file POSIX wire names required")
    for item in entries:
        contract.require(not item.is_dir() and not item.flag_bits & 1
                         and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG)
                         and 0 < item.file_size <= limit(item.orig_filename), "Invalid ZIP member")
    return entries


def pack(source, output):
    inventory(source)
    contract.canonical(output)
    contract.require(output.parent.is_dir() and not output.exists()
                     and not output.is_relative_to(source), "New output outside the signed source required")
    before, expected = {}, {}
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in sorted(contract.NAMES):
            file = source / name
            before[name] = contract.identity(file.stat())
            contract.require(file.stat().st_nlink == 1 and 0 < file.stat().st_size <= limit(name), "Bounded single-link input required")
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            digest, total = hashlib.sha256(), 0
            with file.open("rb") as incoming, archive.open(info, "w") as outgoing:
                for block in iter(lambda: incoming.read(65536), b""):
                    total += len(block)
                    contract.require(total <= limit(name), "Source grew beyond bound")
                    digest.update(block)
                    outgoing.write(block)
            contract.require(total == before[name][2] and contract.identity(file.stat()) == before[name], "Source changed while packing")
            expected[name] = (total, digest.hexdigest())
    inventory(source)
    with zipfile.ZipFile(output) as archive:
        for item in zip_members(archive):
            digest, total = hashlib.sha256(), 0
            with archive.open(item) as incoming:
                for block in iter(lambda: incoming.read(65536), b""):
                    total += len(block)
                    contract.require(total <= limit(item.orig_filename), "Archive member grew beyond bound")
                    digest.update(block)
            contract.require((total, digest.hexdigest()) == expected[item.orig_filename], "Wrapped file bytes differ")
            contract.require(contract.identity((source / item.orig_filename).stat()) == before[item.orig_filename], "Signed source changed")
    digest = hashlib.sha256()
    with output.open("rb") as incoming:
        for block in iter(lambda: incoming.read(65536), b""):
            digest.update(block)
    return {"zipBytes": output.stat().st_size, "zipSha256": digest.hexdigest(),
            "containerLayoutVerified": True, "fileBytesPreserved": True,
            "privateKeyIncluded": False, "releaseReady": False}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Use ABS_SIGNED_DIRECTORY ABS_NEW_ZIP; no signing or installation")
    print(json.dumps(pack(Path(sys.argv[1]), Path(sys.argv[2]))))
