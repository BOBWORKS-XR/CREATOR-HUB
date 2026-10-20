"""Read-only private016 -> private017 DEB delta check; no install or acceptance."""
import email.parser
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BASE_SHA = "07429e4febdf404bf31fe8b4a75c17e144399b3c7f2af640caf9c351765c6974"
ROOT = "usr/bin/creator-hub"
ARCHIVE = "usr/lib/Creator Hub/modules.tar.gz"
LIMIT = 512 * 1024 * 1024
ZIP_FILES = {"deb": ("native-packages/Creator Hub_0.1.16_amd64.deb", "baseline016.deb"),
             "rawHub": ("creator-hub", "creator-hub"), "manifest": ("builtin-manifest.json", "builtin-manifest.json"),
             "assemblyReceipt": ("signed-unix-assembly.json", "signed-unix-assembly.json")}


def require(value, message):
    if not value:
        raise ValueError(message)


def base_reader():
    source = HERE / "linux-retirement-package-verify.py"
    require(hashlib.sha256(source.read_bytes()).hexdigest() == BASE_SHA, "Original strict016 package verifier changed")
    spec = importlib.util.spec_from_file_location("private017_original_package_reader", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pin(value):
    require(type(value) is dict and set(value) == {"size", "sha256"}
            and type(value["size"]) is int and 0 < value["size"] <= LIMIT
            and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "Exact bounded byte pin required")


def record(raw):
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def control(stream, base):
    found = {}
    for name, member, archive in base.members(stream):
        require(name in ("control", "md5sums") and member.isfile() and member.uid == member.gid == 0
                and member.mode == 0o644 and not member.pax_headers and member.size <= 131072,
                "No unknown control file, maintainer script, conffile or trigger")
        found[name] = archive.extractfile(member).read()
    require(set(found) == {"control", "md5sums"}, "Complete control payload required")
    fields = email.parser.Parser().parsestr(found["control"].decode("utf8"))
    require(all(len(fields.get_all(k)) == 1 for k in fields.keys()), "Duplicate control field")
    checksums = {}
    for line in found["md5sums"].decode("ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{32})  ([^\x00-\x1f]+)", line)
        require(match and match[2] not in checksums, "Canonical unique md5sums required")
        name = match[2]
        require(not name.startswith("/") and all(p not in ("", ".", "..") for p in name.split("/")), "Canonical checksum path required")
        checksums[name] = match[1]
    return dict(fields.items()), checksums


def data(stream, base):
    result = {}
    for name, member, archive in base.members(stream):
        require(not member.pax_headers and member.uid == member.gid == 0
                and member.mode in ((0o644, 0o755) if member.isfile() else (0o755,)), "Unreviewed package metadata or capabilities")
        item = {"kind": "file" if member.isfile() else "directory", "mode": member.mode, "uid": member.uid,
                "gid": member.gid, "size": member.size}
        if member.isfile():
            sha, md5, count, header = hashlib.sha256(), hashlib.md5(), 0, b""
            file = archive.extractfile(member)
            while chunk := file.read(65536):
                count += len(chunk)
                require(count <= member.size, "Member exceeded declared size")
                sha.update(chunk)
                md5.update(chunk)
                if len(header) < 20:
                    header += chunk[:20 - len(header)]
            require(count == member.size, "Short package member")
            item.update(sha256=sha.hexdigest(), md5=md5.hexdigest(), header=header.hex())
        result[name] = item
    return result


def compare(baseline, candidate, expected):
    validate_expected(expected)
    before, after = baseline["fields"], candidate["fields"]
    require(before["Version"] == "0.1.16" and after["Version"] == "0.1.17", "Only actual016 -> actual017 fixture packages admitted")
    require(set(before) == set(after), "Control fields changed")
    for name in before:
        if name not in ("Version", "Installed-Size"):
            require(before[name] == after[name], "Unreviewed package control delta")
    for fields in (before, after):
        require(fields["Package"] == "creator-hub" and fields["Architecture"] == "amd64", "Wrong package identity")
        require(re.fullmatch(r"[1-9][0-9]*", fields.get("Installed-Size", ""))
                and int(fields["Installed-Size"]) <= LIMIT // 1024, "Bounded installed size required")
    old, new = baseline["files"], candidate["files"]
    require(set(old) == set(new) and ROOT in new and ARCHIVE in new, "Package paths changed")
    for name in old:
        if name not in (ROOT, ARCHIVE):
            require(old[name] == new[name], "Only Root and module archive bytes may change")
        else:
            require(all(old[name][k] == new[name][k] for k in ("kind", "mode", "uid", "gid")), "Changed Root/archive ownership or mode")
            require(new[name]["kind"] == "file", "Root/archive must remain regular files")
    for package, checksums in ((baseline, baseline["md5sums"]), (candidate, candidate["md5sums"])):
        require(checksums == {n: v["md5"] for n, v in package["files"].items() if v["kind"] == "file"}, "DEB checksums do not match actual data")
    baseline_members(baseline, expected["baseline"])
    for name, value in {ROOT: expected["candidate"]["hub"], ARCHIVE: expected["candidate"]["archive"]}.items():
        require({k: new[name][k] for k in ("size", "sha256")} == value, "Actual package member differs from approved/built bytes")
    require(old[ROOT]["sha256"] != new[ROOT]["sha256"], "Relabelled016 Root cannot be a017 target")
    require(new[ROOT]["mode"] == 0o755 and new[ARCHIVE]["mode"] == 0o644, "Exact Root/archive modes required")
    root = bytes.fromhex(new[ROOT]["header"])
    require(root[:7] == b"\x7fELF\x02\x01\x01" and root[18:20] == b"\x3e\x00", "Native x86_64 Root required")
    return {"scope": "private017-deb-delta-only", "original016Preserved": True, "helperPolicyServicePreserved": True,
            "nativeGuiAccepted": False, "migrationAccepted": False, "signedUpdateAccepted": False, "restartAccepted": False, "releaseReady": False}


def validate_expected(expected):
    require(set(expected) == {"baseline", "candidate"}, "Exact private017 expected fields required")
    for side, names in (("baseline", {"deb", "hub", "helper", "policy", "service"}), ("candidate", {"deb", "hub", "archive"})):
        require(set(expected[side]) == names, "Exact package pin set required")
        for value in expected[side].values():
            pin(value)


def baseline_members(package, pins):
    for name, key in ((ROOT, "hub"), ("usr/libexec/creator-hub-deb-retirement-helper", "helper"),
                      ("usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy", "policy"),
                      ("usr/share/dbus-1/services/com.creatorworks.hub.Host.service", "service")):
        require({k: package["files"][name][k] for k in ("size", "sha256")} == pins[key], "Actual016 member differs from approved bytes")


def child_limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def inspect(package, expected, base, version):
    pin(expected["deb"])
    path = Path(package)
    require(path.is_absolute() and path.resolve(strict=True) == path and not path.is_symlink(), "Canonical package path required")
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == expected["deb"]["size"], "Bounded independent package file required")
    with path.open("rb") as stream:
        require(os.fstat(stream.fileno()) == before, "Package changed before opening")
        raw = stream.read(expected["deb"]["size"] + 1)
    require(record(raw) == expected["deb"], "Package bytes differ")
    result = {}
    with tempfile.TemporaryFile() as copied:
        copied.write(raw)
        copied.flush()
        for argument in ("--ctrl-tarfile", "--fsys-tarfile"):
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                process = subprocess.run(["/usr/bin/dpkg-deb", argument, f"/proc/self/fd/{copied.fileno()}"],
                                         pass_fds=(copied.fileno(),), stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
                                         env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, cwd="/", timeout=90,
                                         preexec_fn=child_limits, check=False)
                require(process.returncode == 0 and errors.tell() == 0 and output.tell() <= LIMIT, "Bounded read-only DEB query failed")
                output.seek(0)
                if argument == "--ctrl-tarfile":
                    if version == "0.1.16":
                        base.control(output, "0.1.16", base.PRODUCTION_PROFILE)
                        output.seek(0)
                    result["fields"], result["md5sums"] = control(output, base)
                else:
                    base.data(output, expected["helper"]["sha256"], expected["policy"]["sha256"], base.PRODUCTION_PROFILE)
                    output.seek(0)
                    result["files"] = data(output, base)
    after = path.stat()
    require(all(getattr(before, k) == getattr(after, k) for k in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")), "Package changed during inspection")
    return result


def verify(baseline, candidate, expected):
    require(sys.platform == "linux", "Native Linux read-only inspection required")
    validate_expected(expected)
    base = base_reader()
    old = inspect(baseline, expected["baseline"], base, "0.1.16")
    candidate_pins = {**expected["candidate"], **{k: expected["baseline"][k] for k in ("helper", "policy", "service")}}
    new = inspect(candidate, candidate_pins, base, "0.1.17")
    return compare(old, new, expected)


def inspect_baseline(package, expected):
    require(sys.platform == "linux" and set(expected) == {"deb", "hub", "helper", "policy", "service"}, "Native exact baseline pins required")
    for value in expected.values():
        pin(value)
    result = inspect(package, expected, base_reader(), "0.1.16")
    baseline_members(result, expected)
    require(result["md5sums"] == {n: v["md5"] for n, v in result["files"].items() if v["kind"] == "file"}, "Baseline checksum coverage differs")
    return {"scope": "original016-production-deb-inspection-only", "files": result["files"], "releaseReady": False}


def stage_zip(package, expected, destination):
    require(set(expected) == {"zip", "files"} and set(expected["files"]) == set(ZIP_FILES), "Exact baseline ZIP bindings required")
    require(set(expected["zip"]) == {"size", "sha256"} and type(expected["zip"]["size"]) is int
            and 0 < expected["zip"]["size"] <= 768 * 1024 * 1024
            and re.fullmatch(r"[a-f0-9]{64}", expected["zip"]["sha256"]), "Bounded ZIP pin required")
    for value in expected["files"].values():
        pin(value)
    source, target = Path(package), Path(destination)
    require(source.is_absolute() and source.resolve(strict=True) == source and source.stat().st_nlink == 1
            and source.is_file() and not source.is_symlink(), "Canonical independent ZIP required")
    require(target.is_absolute() and target.resolve() == target and not target.exists()
            and target.parent.resolve(strict=True) == target.parent, "Fresh canonical staging directory required")
    before = source.stat()
    require(before.st_size == expected["zip"]["size"], "ZIP size differs")
    with source.open("rb") as input_, tempfile.TemporaryFile() as copied:
        require(os.fstat(input_.fileno()) == before, "ZIP changed before opening")
        sha, total = hashlib.sha256(), 0
        while chunk := input_.read(65536):
            total += len(chunk)
            require(total <= before.st_size, "ZIP exceeded bound")
            sha.update(chunk)
            copied.write(chunk)
        require(total == before.st_size and sha.hexdigest() == expected["zip"]["sha256"], "ZIP bytes differ")
        after = source.stat()
        require(all(getattr(before, k) == getattr(after, k) for k in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")), "ZIP changed during snapshot")
        copied.seek(0)
        with zipfile.ZipFile(copied) as archive:
            names, expanded = set(), 0
            require(len(archive.infolist()) <= 256, "ZIP inventory exceeds bound")
            for member in archive.infolist():
                name = member.filename.rstrip("/") if member.is_dir() else member.filename
                require(name not in names and not name.startswith("/") and "\\" not in name
                        and all(p not in ("", ".", "..") for p in name.split("/")), "Ambiguous ZIP path")
                mode = member.external_attr >> 16
                require(not member.flag_bits & 1 and stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "Encrypted or special ZIP entry")
                names.add(name)
                expanded += member.file_size
                require(0 <= member.file_size <= LIMIT and expanded <= LIMIT, "Expanded ZIP exceeds bound")
            for key, (name, _) in ZIP_FILES.items():
                require(name in names and archive.getinfo(name).file_size == expected["files"][key]["size"], "Missing or oversized baseline member")
            target.mkdir(mode=0o700)
            for key, (name, output) in ZIP_FILES.items():
                raw = archive.read(name)
                require(record(raw) == expected["files"][key], "Baseline ZIP member bytes differ")
                with open(target / output, "xb") as stream:
                    stream.write(raw)
                os.chmod(target / output, 0o600)
    return {"scope": "pinned016-zip-staging-only", "files": expected["files"], "releaseReady": False}


if __name__ == "__main__":
    try:
        arguments = sys.argv[1:]
        require(len(arguments) == 3 or len(arguments) == 4 and arguments[0] == "--stage-baseline", "Use BASELINE016_DEB CANDIDATE017_DEB EXPECTED_JSON, --inspect-baseline DEB EXPECTED_JSON, or --stage-baseline ZIP EXPECTED_JSON NEW_DIRECTORY")
        metadata_file = arguments[2]
        with open(metadata_file, "rb") as stream:
            raw = stream.read(32769)
        require(len(raw) <= 32768, "Expected metadata exceeds bound")
        def pairs(items):
            out = {}
            for key, value in items:
                require(key not in out, "Duplicate JSON key")
                out[key] = value
            return out
        expected = json.loads(raw, object_pairs_hook=pairs)
        if len(arguments) == 4:
            result = stage_zip(arguments[1], expected, arguments[3])
        elif arguments[0] == "--inspect-baseline":
            result = inspect_baseline(arguments[1], expected)
        else:
            result = verify(arguments[0], arguments[1], expected)
        print(json.dumps(result))
    except Exception as error:
        print(str(error)[:1500], file=sys.stderr)
        sys.exit(2)
