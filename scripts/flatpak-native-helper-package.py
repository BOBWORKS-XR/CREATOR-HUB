"""Offline DEB inspection only; no installer, service registration or credentials.

Run the trusted-key Rust checker separately first. This inspector does not
authenticate a supplied expected digest/ELF hash, and reports that explicitly.
It snapshots exact bytes before invoking dpkg-deb on an owned copied FD.
"""
import email.parser
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MEMBERS_SHA = "07429e4febdf404bf31fe8b4a75c17e144399b3c7f2af640caf9c351765c6974"
SERVICE = "usr/share/dbus-1/services/com.creatorworks.hub.Host.service"
PARENTS = {"usr", "usr/share", "usr/share/dbus-1", "usr/share/dbus-1/services"}
SERVICE_BYTES = b"[D-BUS Service]\nName=com.creatorworks.hub.Host\nExec=/usr/bin/creator-hub --flatpak-activate\n"
LIMIT = 512 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def members(stream):
    source = HERE / "linux-retirement-package-verify.py"
    require(hashlib.sha256(source.read_bytes()).hexdigest() == MEMBERS_SHA, "Shared strict archive reader changed; review required")
    spec = importlib.util.spec_from_file_location("flatpak_native_package_members", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    yield from module.members(stream)


def inspect_control(stream, version):
    found = {}
    for name, member, archive in members(stream):
        require(name in ("control", "md5sums") and member.isfile() and member.uid == member.gid == 0
                and member.size <= 131072, "No maintainer script, trigger, conffile or unknown control payload admitted")
        found[name] = archive.extractfile(member).read()
    require(set(found) == {"control", "md5sums"}, "Complete native DEB control required")
    fields = email.parser.Parser().parsestr(found["control"].decode("utf-8"))
    require(all(len(fields.get_all(key)) == 1 for key in fields.keys()), "Duplicate package field")
    require(fields["Package"] == "creator-hub" and fields["Version"] == version and fields["Architecture"] == "amd64", "Exact native DEB identity required")
    require("TEST ONLY" not in fields.get("Description", "").upper(), "TEST ONLY packages cannot authorize installation")
    return {"package": fields["Package"], "version": fields["Version"], "architecture": fields["Architecture"]}


def inspect_data(stream, executable_hash):
    found, parents = {}, set()
    for name, member, archive in members(stream):
        if name in PARENTS:
            require(member.isdir() and member.uid == member.gid == 0 and member.mode == 0o755, "Root-protected session-service ancestors required")
            parents.add(name)
        if name.endswith(".service") and "dbus-1/" in name:
            require(name == SERVICE, "Additional D-Bus service not admitted")
        require(not name.startswith(("etc/dbus-1/", "usr/share/dbus-1/system-services/")), "No system D-Bus policy/grant permitted")
        if name not in (SERVICE, "usr/bin/creator-hub"):
            continue
        require(member.isfile() and member.uid == member.gid == 0 and member.mode == (0o644 if name == SERVICE else 0o755), "Native activation file kind/owner/mode differs")
        require(member.size <= (4096 if name == SERVICE else 64*1024*1024), "Activation member exceeds bound")
        raw = archive.extractfile(member).read()
        require(len(raw) == member.size, "Short native member read")
        digest = hashlib.sha256(raw).hexdigest()
        if name == SERVICE:
            require(raw == SERVICE_BYTES, "Fixed service has changed arguments, identity or authority")
        else:
            require(raw[:7] == b"\x7fELF\x02\x01\x01" and raw[18:20] == b"\x3e\x00" and digest == executable_hash, "Exact signed x86_64 native Hub image required")
        found[name] = {"sha256": digest, "size": len(raw), "uid": member.uid, "gid": member.gid, "mode": member.mode}
    require(set(found) == {SERVICE, "usr/bin/creator-hub"} and parents == PARENTS, "Native DEB lacks the fixed activation service/Root or protected ancestors")
    return found


def child_limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def inspect(package, version, package_hash, executable_hash):
    require(sys.platform == "linux" and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version), "Native Linux DEB inspection only")
    require(all(re.fullmatch(r"[a-f0-9]{64}", h) for h in (package_hash, executable_hash)), "Exact externally authenticated package/ELF digests required")
    path = Path(package)
    require(path.is_absolute() and path.resolve(strict=True) == path and not path.is_symlink(), "Canonical unlinked input required")
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= LIMIT, "Bounded native DEB required")
    with path.open("rb") as source:
        raw = source.read(LIMIT+1)
    require(len(raw) == before.st_size and hashlib.sha256(raw).hexdigest() == package_hash, "Exact approved native DEB bytes required")
    env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
    result = {"scope": "native-deb-activation-members-only", "signatureVerifiedByInspector": False,
              "nativeRootWiringAccepted": False, "nativeHelperInstalled": False, "signedUpdateAccepted": False, "releaseReady": False}
    with tempfile.TemporaryFile() as copied:
        copied.write(raw)
        copied.flush()
        for argument in ("--ctrl-tarfile", "--fsys-tarfile"):
            copied.seek(0)
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                child = subprocess.run(["/usr/bin/dpkg-deb", argument, f"/proc/self/fd/{copied.fileno()}"],
                    pass_fds=(copied.fileno(),), stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
                    env=env, cwd="/", timeout=90, preexec_fn=child_limits, check=False)
                require(child.returncode == 0 and errors.tell() == 0 and output.tell() <= LIMIT, "Read-only DEB query failed or exceeded bounds")
                output.seek(0)
                if argument == "--ctrl-tarfile":
                    result["control"] = inspect_control(output, version)
                else:
                    result["files"] = inspect_data(output, executable_hash)
    after = path.stat()
    require(all(getattr(before,k) == getattr(after,k) for k in ("st_dev","st_ino","st_size","st_mtime_ns","st_ctime_ns")), "Original native DEB changed during inspection")
    return result


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 5, "Use NATIVE_DEB EXACT_VERSION AUTHENTICATED_DEB_SHA256 AUTHENTICATED_ELF_SHA256; inspection never installs")
        print(json.dumps(inspect(*sys.argv[1:])))
    except Exception as error:
        print(str(error)[:1000], file=sys.stderr)
        sys.exit(1)
