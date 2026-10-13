"""Parse native tar metadata without filesystem extraction; retain bytes and modes."""

import configparser
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import struct
import sys
import tarfile

MAX_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 10000
PRODUCT = "Creator Hub"
BINARY = "creator-hub"
APP_ID = "com.creatorworks.hub"
DESKTOP = f"usr/share/applications/{PRODUCT}.desktop"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    if name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    require(len(name) <= 2048 and not name.startswith("/") and "\\" not in name
            and not any(ord(char) < 32 or ord(char) == 127 for char in name), "Unsafe tar path")
    require(all(part not in ("", ".", "..") for part in name.split("/")), "Unsafe tar path")
    return name


def elf_header(data, main=False):
    require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01", "Expected little-endian ELF64")
    kind, machine, version = struct.unpack_from("<HHI", data, 16)
    require(machine == 62 and version == 1 and kind in (2, 3), "Expected x86_64 ELF executable/shared object")
    require(struct.unpack_from("<H", data, 52)[0] == 64, "Invalid ELF header size")
    if main:
        offset = struct.unpack_from("<Q", data, 32)[0]
        size, count = struct.unpack_from("<HH", data, 54)
        require(offset >= 64 and size == 56 and count > 0 and offset + size * count <= len(data),
                "Invalid executable ELF program headers")


def desktop_identity(data):
    require(len(data) <= 64 * 1024 and b"\x00" not in data, "Invalid desktop metadata")
    parser = configparser.ConfigParser(interpolation=None, strict=True, delimiters=("=",),
                                       comment_prefixes=("#",), inline_comment_prefixes=None)
    parser.optionxform = str
    parser.read_string(data.decode("utf-8"))
    require(parser.sections() == ["Desktop Entry"] and not parser.defaults(), "Unexpected desktop groups")
    entry = parser["Desktop Entry"]
    for key, value in {"Name": PRODUCT, "Exec": BINARY, "Icon": BINARY, "Type": "Application",
                       "Terminal": "false"}.items():
        require(entry.get(key) == value, f"Unexpected desktop {key}")
    require(set(entry) <= {"Name", "Exec", "Icon", "Type", "Terminal", "Categories", "Comment",
                            "StartupWMClass"}, "Unknown desktop launch contract")


def mapping(name, directory):
    if name == f"usr/bin/{BINARY}":
        return f"bin/{BINARY}"
    if name == f"usr/lib/{PRODUCT}" or name.startswith(f"usr/lib/{PRODUCT}/"):
        return name[4:]
    if name == f"usr/share/doc/{PRODUCT}" or name.startswith(f"usr/share/doc/{PRODUCT}/"):
        return name[4:]
    match = re.fullmatch(r"usr/share/icons/hicolor/([1-9][0-9]*x[1-9][0-9]*(?:@2)?)/apps/creator-hub\.png", name)
    if match and not directory:
        return f"share/icons/hicolor/{match[1]}/apps/{APP_ID}.png"
    if name == DESKTOP and not directory:
        return None
    parents = {"usr", "usr/bin", "usr/lib", "usr/share", "usr/share/doc", "usr/share/applications",
               "usr/share/icons", "usr/share/icons/hicolor"}
    if directory and (name in parents or re.fullmatch(
            r"usr/share/icons/hicolor/[1-9][0-9]*x[1-9][0-9]*(?:@2)?(?:/apps)?", name)):
        # Keep the original ancestor mode for relocated native paths.
        return None if name in ("usr", "usr/share/applications") else name[4:]
    raise ValueError(f"Unknown native DEB payload contract: {name}")


def inspect(data):
    require(len(data) <= MAX_BYTES, "Tar exceeds limit")
    items = []
    seen = {}
    total = 0
    desktop_seen = False
    binary_seen = False
    icons = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for index, member in enumerate(archive):
            require(index < MAX_ENTRIES, "Too many tar members")
            if member.name in (".", "./") and member.isdir():
                continue
            name = safe_name(member.name)
            require(name not in seen, "Duplicate tar path")
            require(member.isfile() or member.isdir(), "Links, devices and special tar members are refused")
            require(not member.issparse(), "Sparse files are refused")
            require(member.mode & ~0o777 == 0, "Special permission bits are refused")
            require(member.size >= 0 and (not member.isdir() or member.size == 0), "Invalid tar member size")
            total += member.size
            require(total <= MAX_BYTES, "Payload exceeds limit")
            seen[name] = member.isdir()
            dest = mapping(name, member.isdir())
            contents = b"" if member.isdir() else archive.extractfile(member).read()
            require(len(contents) == member.size, "Truncated tar member")
            if name == DESKTOP:
                desktop_identity(contents)
                desktop_seen = True
            if name == f"usr/bin/{BINARY}":
                require(member.isfile() and member.mode & 0o111 != 0, "Native executable is not executable")
                elf_header(contents, main=True)
                binary_seen = True
            elif contents.startswith(b"\x7fELF"):
                elf_header(contents)
            if dest and dest.startswith("share/icons/") and member.isfile():
                require(contents.startswith(b"\x89PNG\r\n\x1a\n"), "Native icon is not PNG")
                icons += 1
            if dest:
                item = {"source": name, "path": dest, "type": "directory" if member.isdir() else "file",
                        "mode": member.mode, "byteLength": len(contents)}
                if member.isfile():
                    item["sha256"] = hashlib.sha256(contents).hexdigest()
                items.append((item, contents))
    require(binary_seen and desktop_seen and icons > 0, "Native executable, product desktop and PNG icons are required")
    for name in seen:
        parts = name.split("/")
        for end in range(1, len(parts)):
            parent = "/".join(parts[:end])
            require(parent not in seen or seen[parent], "Tar file used as parent directory")
    require(len({item["path"] for item, _ in items}) == len(items), "Duplicate mapped path")
    items.sort(key=lambda pair: pair[0]["path"])
    return items


def repack(items):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for item, contents in items:
            member = tarfile.TarInfo(item["path"])
            member.mode = item["mode"]
            member.type = tarfile.DIRTYPE if item["type"] == "directory" else tarfile.REGTYPE
            member.size = item["byteLength"]
            # Archive container owner/timestamps are normalized, never file bytes or modes.
            archive.addfile(member, io.BytesIO(contents) if member.isfile() else None)
    return output.getvalue()


def verify(inventory, root):
    require(inventory["schemaVersion"] == 1, "Unexpected inventory schema")
    root = Path(root)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "Invalid install root")
    for item in inventory["entries"]:
        name = safe_name(item["path"])
        target = root / name
        for ancestor in [target, *target.parents]:
            require(not ancestor.is_symlink(), "Installed payload contains a link")
            if ancestor == root:
                break
        info = target.stat()
        require(stat.S_IMODE(info.st_mode) == item["mode"], f"Installed mode changed: {name}")
        if item["type"] == "directory":
            require(stat.S_ISDIR(info.st_mode), "Installed directory changed")
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_size == item["byteLength"], "Installed file changed")
            with target.open("rb") as source:
                require(hashlib.file_digest(source, "sha256").hexdigest() == item["sha256"],
                        f"Installed bytes changed: {name}")


def main():
    mode = sys.argv[1]
    if mode == "verify" and len(sys.argv) == 4:
        with open(sys.argv[2], encoding="utf-8") as source:
            verify(json.load(source), sys.argv[3])
        return
    require(mode in ("inspect", "repack") and len(sys.argv) == 2, "Unknown payload operation")
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    items = inspect(data)
    if mode == "repack":
        sys.stdout.buffer.write(repack(items))
    else:
        print(json.dumps({"schemaVersion": 1, "executable": f"bin/{BINARY}",
                          "entries": [item for item, _ in items],
                          "replacedMetadata": [DESKTOP]}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, tarfile.TarError, configparser.Error) as error:
        sys.exit(f"Native payload refused: {error}")
