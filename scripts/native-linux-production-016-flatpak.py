"""Finite production 016 bootstrap/activation controller, never a release gate.

Stage is data-only. Session requires separately requested execution, successful
production receipts and real catalogue signatures. Temporary lab TLS trust is
disposable-CI-only; no signing, command relay, automatic recovery or forced app shutdown.
"""
import hashlib
import base64
import ctypes
import copy
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import select
import secrets
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
import zlib

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("production_flatpak_neutral", HERE / "native-linux-integrated-pages.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
KEYBOARD_SPEC = importlib.util.spec_from_file_location("production_flatpak_keyboard", HERE / "native-linux-flatpak-dialog-input.py")
K = importlib.util.module_from_spec(KEYBOARD_SPEC)
KEYBOARD_SPEC.loader.exec_module(K)
require, parse, save = P.require, P.parse, P.save
PROFILE = "production-flatpak-host-016"
BRANCH = "refs/heads/validation/native-linux-production-016-flatpak"
WORKFLOW = ".github/workflows/native-linux-production-016-flatpak.yml"
REQUEST = "execute-production-bootstrap-activation-016"
REF = "app/com.creatorworks.hub/x86_64/stable"
NAME = "com.creatorworks.hub.Host"
RUNTIME = "runtime/org.gnome.Platform/x86_64/50"
PORTAL_URL = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
PORTAL_PROVIDERS = {
    'permissions': ('/usr/libexec/xdg-permission-store', 'org.freedesktop.impl.portal.PermissionStore'),
    'gtk': ('/usr/libexec/xdg-desktop-portal-gtk', 'org.freedesktop.impl.portal.desktop.gtk'),
    'portal': ('/usr/libexec/xdg-desktop-portal', 'org.freedesktop.portal.Desktop'),
}
DESCRIPTOR = "creator-hub-linux-x86_64-portable.json"
MANIFEST = "creator-hub-linux-x86_64-0.1.16.portable-manifest.json"
ARCHIVE = "creator-hub-linux-x86_64-0.1.16.appdir.tar.gz"
BOOTSTRAP_PREFIX = '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/'
KEY = {"size": 119, "sha256": "23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308"}
VERIFIER_CRATE = "native/linux-portable-deployment"
VERIFIER_SOURCE = "src-tauri/examples/verify-package-input.rs"
VERIFIER_KEY = "src-tauri/src/catalog-key.pub"
VERIFIER_PINS = {
    VERIFIER_SOURCE: {"size": 2266, "sha256": "81207a9e6b17a288c9ee95acf9c400ed9b047cfa319a3a1fed33df320f6fb135"},
    VERIFIER_CRATE + "/Cargo.lock": {"size": 10486, "sha256": "e41ae1db82e4a5d63e007cf3e45424ba511ecc194cf6a62359bd4863839f267f"},
    VERIFIER_KEY: KEY,
}
VERIFIER_LIMIT = 128 * 1024
TLS_DESTINATION = Path('/usr/local/share/ca-certificates/creator-production-bootstrap016.crt')
TLS_CONFIGURATION = (b'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=api.github.com\n'
    b'[ext]\nsubjectAltName=DNS:api.github.com,DNS:github.com\nbasicConstraints=critical,CA:TRUE\n'
    b'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
# Fixed root-owned destination and public certificate only; no privileged read of caller paths.
TLS_PUBLISH = ('import base64,os,sys; b=base64.b64decode(sys.argv[2],validate=True); '
    'assert 0<len(b)<=65536; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644); '
    'os.fchmod(f,0o644); n=os.write(f,b); assert n==len(b); os.fsync(f); os.close(f)')
TLS_REMOVE = ('import hashlib,os,stat,sys; p=sys.argv[1]; s=os.lstat(p); '
    'assert stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o644; '
    'f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW); h=os.fstat(f); assert (s.st_dev,s.st_ino,s.st_size)==(h.st_dev,h.st_ino,h.st_size); '
    'b=os.read(f,65537); assert 0<len(b)<=65536 and hashlib.sha256(b).hexdigest()==sys.argv[2]; '
    'identity=lambda x:(x.st_dev,x.st_ino,x.st_mode,x.st_uid,x.st_gid,x.st_nlink,x.st_size,x.st_mtime_ns,x.st_ctime_ns); '
    'assert identity(os.lstat(p))==identity(s) and identity(os.fstat(f))==identity(h); os.unlink(p); os.close(f)')
TLS_TRUST = Path('/etc/ssl/certs')
TLS_ALIAS_TARGETS = {'99383ae7.0': 'creator-production-bootstrap016.pem',
                     'creator-production-bootstrap016.pem': '/usr/local/share/ca-certificates/creator-production-bootstrap016.crt'}
TLS_ALIAS_REMOVE = r'''
import hashlib,json,os,re,stat,sys
assert os.getuid()==os.geteuid()==0 and len(sys.argv)==2 and len(sys.argv[1])<=4096
p=json.loads(sys.argv[1])
targets={'99383ae7.0':'creator-production-bootstrap016.pem','creator-production-bootstrap016.pem':'/usr/local/share/ca-certificates/creator-production-bootstrap016.crt'}
assert type(p) is dict and set(p)=={'directory','links','bundle'} and type(p['links']) is dict and set(p['links'])==set(targets)
assert type(p['directory']) is list and len(p['directory'])==5
assert all(type(v) is list and len(v)==9 for v in p['links'].values())
assert all(type(n) is int and 0<=n<2**64 for v in [p['directory'],*p['links'].values()] for n in v)
b=p['bundle']
assert type(b) is dict and set(b)=={'size','sha256'} and type(b['size']) is int and 0<b['size']<=2097152 and type(b['sha256']) is str and re.fullmatch('[a-f0-9]{64}',b['sha256'])
identity=lambda s:[getattr(s,k) for k in ('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_mtime_ns','st_ctime_ns','st_nlink')]
directory_key=lambda s:[s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid]
directory=os.open('/etc/ssl/certs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
held={}
bundle=None
def protected():
    for path in ('/','/etc','/etc/ssl','/etc/ssl/certs','/usr','/usr/local','/usr/local/share','/usr/local/share/ca-certificates'):
        s=os.lstat(path)
        assert stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and not s.st_mode&0o022
    assert directory_key(os.fstat(directory))==directory_key(os.lstat('/etc/ssl/certs'))==p['directory']
    assert not os.path.lexists('/usr/local/share/ca-certificates/creator-production-bootstrap016.crt')
def check_link(name):
    protected()
    for s in (os.fstat(held[name]),os.stat(name,dir_fd=directory,follow_symlinks=False)):
        assert stat.S_ISLNK(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and identity(s)==p['links'][name]
    assert os.readlink('',dir_fd=held[name])==os.readlink(name,dir_fd=directory)==targets[name]
try:
    protected()
    for name in targets:
        held[name]=os.open(name,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
        check_link(name)
    bundle=os.open('ca-certificates.crt',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
    original=os.fstat(bundle)
    assert stat.S_ISREG(original.st_mode) and original.st_uid==original.st_gid==0 and original.st_nlink==1 and stat.S_IMODE(original.st_mode)==0o644 and original.st_size==b['size']
    raw=os.read(bundle,b['size']+1)
    assert len(raw)==b['size'] and hashlib.sha256(raw).hexdigest()==b['sha256']
    for name in targets: check_link(name)
    for name in targets:
        check_link(name)
        assert identity(os.fstat(bundle))==identity(os.stat('ca-certificates.crt',dir_fd=directory,follow_symlinks=False))==identity(original)
        os.unlink(name,dir_fd=directory)
    os.fsync(directory)
    protected()
    assert not set(targets).intersection(os.listdir(directory))
finally:
    if bundle is not None: os.close(bundle)
    for fd in held.values(): os.close(fd)
    os.close(directory)
'''
GATES = dict.fromkeys(("candidateExecuted", "flatpakInstalled", "disclosureCancelAccepted", "missingHostAccepted",
                      "portalCaptureAccepted", "setupCancelAccepted", "bootstrapAccepted", "typedResumeAccepted",
                      "coldActivationAccepted", "warmActivationAccepted", "settingsPreserved", "signedUpdateAccepted",
                      "restartAccepted", "migrationAccepted", "authenticationAccepted", "mcpAccepted", "setupAccepted", "nativeGuiAccepted",
                      "steamDeckAccepted", "publicDiscoveryAccepted", "publisherSignatureAccepted", "releaseReady"), False)
MAX_TOTAL, MAX_FILE, MAX_ENTRIES = 512 * 1024 * 1024, 256 * 1024 * 1024, 8192


def admission(env, system, machine, uid):
    require(system == "linux" and machine == "x86_64" and type(uid) is int and uid > 0, "Unprivileged native Linux x86_64 only")
    for key, value in {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                       "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
                       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": BRANCH,
                       "GITHUB_WORKFLOW_REF": "BOBWORKS-XR/CREATOR-HUB/" + WORKFLOW + "@" + BRANCH}.items():
        require(env.get(key) == value, "Exact production controller context required: " + key)
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")) and all(
        re.fullmatch(r"[1-9][0-9]*", env.get(key, "")) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "CI source/run identity")
    require(not any(re.match(r"^(LD_|DYLD_|TAURI_|WEBKIT_|APPIMAGE$|APPDIR$|PYTHON|NODE_OPTIONS$|SSL_CERT_|CURL_CA_BUNDLE$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)", key)
                    or key.lower().endswith("proxy") for key in env), "Inherited runtime/trust/signing override")
    require(not env.get("FLATPAK_ID"), "Native controller only")


def locations():
    temp = Path(os.environ["RUNNER_TEMP"])
    require(temp.is_absolute() and temp.resolve(strict=True) == temp, "Canonical runner temp required")
    return temp / "native-linux-production-016-flatpak"


def regular(file, maximum=MAX_FILE, mode=None):
    file = Path(file)
    for part in (file, *file.parents):
        require(not part.is_symlink(), "Redirected input refused")
    require(file.resolve(strict=True) == file, "Canonical input required")
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid()
            and 0 < before.st_size <= maximum and (mode is None or stat.S_IMODE(before.st_mode) == mode), "Owned bounded regular input required")
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        require(P.stamp(os.fstat(fd)) == P.stamp(before), "Opened identity changed")
        chunks, total = [], 0
        while total <= before.st_size:
            chunk = os.read(fd, min(1024 * 1024, before.st_size + 1 - total))
            if not chunk:
                break
            total += len(chunk); chunks.append(chunk)
        require(total == before.st_size and P.stamp(os.fstat(fd)) == P.stamp(before)
                and P.stamp(file.lstat()) == P.stamp(before), "Input changed during read")
        return b"".join(chunks)
    finally:
        os.close(fd)


def bound(file, pin, maximum=MAX_FILE):
    require(type(pin) is dict and set(pin) == {"size", "sha256"} and type(pin["size"]) is int
            and 0 < pin["size"] <= maximum and re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]), "Invalid independent pin")
    raw = regular(file, maximum)
    require(len(raw) == pin["size"] and hashlib.sha256(raw).hexdigest() == pin["sha256"], "Pinned input differs")
    return raw


def output(file, raw, mode=0o600):
    with Path(file).open("xb") as stream:
        os.chmod(file, mode); stream.write(raw)


def stage_zip(raw, expected, destination):
    require(type(expected) is dict and 0 < len(expected) <= 16 and len(raw) <= 768 * 1024 * 1024, "ZIP bounds")
    # No member is written until the complete original inventory has been admitted.
    selected = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        entries = zipped.infolist()
        require(len(entries) == len(expected), "Exact original ZIP member set required")
        for entry in entries:
            name = entry.orig_filename
            require(name == entry.filename and name in expected and name not in selected and re.fullmatch(r"[A-Za-z0-9_. -]+", name)
                    and not entry.is_dir() and not entry.flag_bits & 1 and not (entry.external_attr >> 16) & 0o7000
                    and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
                    and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unknown/duplicate/redirected ZIP entry")
            pin = expected[name]
            require(entry.file_size == pin["size"] and 0 < entry.file_size <= MAX_FILE, "ZIP member size")
            data = zipped.read(entry)
            require(len(data) == pin["size"] and hashlib.sha256(data).hexdigest() == pin["sha256"], "ZIP member bytes differ")
            selected[name] = data
    require(set(selected) == set(expected), "Incomplete ZIP")
    destination.mkdir(mode=0o700)
    for name, data in selected.items():
        output(destination / name, data)


def command(args, *, env=None, timeout=60, input=None, limit=2 * 1024 * 1024, cwd=None):
    require(type(args) is list and args and Path(args[0]).is_absolute() and all(type(v) is str for v in args), "Fixed argv tool required")
    require(input is None, "No command-string/stdin relay")
    evidence = locations() / "evidence"
    if not evidence.exists():
        evidence.mkdir(mode=0o700)
    require(evidence.resolve(strict=True) == evidence and evidence.lstat().st_uid == os.getuid(), "Owned tool evidence directory")
    descriptor, receipt_path = tempfile.mkstemp(prefix='tool-', suffix='.json', dir=evidence)
    label = Path(receipt_path).stem
    capture = None
    receipt = {"tool": Path(args[0]).name, "pid": None, "exitCode": None}
    try:
        _, native = P.helpers()
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=env, cwd=HERE.parent if cwd is None else cwd)
        receipt['pid'] = child.pid
        capture = native.Capture(child, evidence, label)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            capture.pump(0.02)
            if child.poll() is not None and all(row['eof'] for row in capture.metadata().values()):
                break
        receipt.update(exitCode=child.poll(), output=capture.metadata())
        require(receipt['exitCode'] is not None, "Tool deadline; no signal sent, disposable teardown required")
        child.wait(timeout=0)
        require(receipt['exitCode'] == 0 and all(row['eof'] and not row['truncated'] and row['bytes'] <= limit
                for row in capture.metadata().values()), "Bounded tool failed: " + Path(args[0]).name)
        return bytes(capture.items['stdout']['kept'])
    finally:
        try:
            if capture is not None:
                capture.close()
        finally:
            with os.fdopen(descriptor, 'w', encoding='utf8') as stream:
                json.dump(receipt, stream, indent=2, allow_nan=False)


def node(mode, *, headless=False):
    executable = os.environ.get("CONTROLLER_NODE")
    require(executable and Path(executable).is_absolute() and Path(executable).is_file(), "Workflow-bound Node executable required")
    env = {key: value for key, value in os.environ.items() if key not in ("DISPLAY", "WAYLAND_DISPLAY")} if headless else None
    return command([executable, str(HERE / "native-linux-production-016-flatpak.cjs"), mode], env=env, limit=2 * 1024 * 1024)


def verify_tar(raw, manifest):
    require(type(manifest) is dict and set(manifest) == {"schemaVersion", "appId", "platform", "architecture", "version", "sourceCommit",
            "sourceTree", "format", "entrypoint", "archive", "entries"}, "Exact signed manifest fields")
    entries = manifest["entries"]
    require(manifest["version"] == "0.1.16" and manifest["format"] == "appdir-tar-gzip-v1"
            and 0 < len(entries) <= MAX_ENTRIES and len(raw) == manifest["archive"]["size"]
            and hashlib.sha256(raw).hexdigest() == manifest["archive"]["sha256"], "Signed archive binding")
    decoder, chunks, decoded_bytes = zlib.decompressobj(31), [], 0
    ceiling = MAX_TOTAL + MAX_ENTRIES * 1024 + 10240
    for offset in range(0, len(raw), 1024 * 1024):
        part = decoder.decompress(raw[offset:offset + 1024 * 1024], ceiling + 1 - decoded_bytes)
        decoded_bytes += len(part); require(decoded_bytes <= ceiling and not decoder.unconsumed_tail, "GZIP unpacked bound")
        chunks.append(part)
    require(decoder.eof and not decoder.unused_data, "One complete GZIP stream, no concatenation/trailing bytes")
    decoded = b"".join(chunks)
    seen, folded, total, retained, position = set(), set(), 0, {}, 0
    with tarfile.open(fileobj=io.BytesIO(decoded), mode="r:") as archive:
        for member in archive:
            name = member.name
            require(name in entries and name not in seen and name.lower() not in folded and len(seen) < MAX_ENTRIES
                    and len(name) <= 240 and not name.startswith("/") and "\\" not in name and ":" not in name
                    and all(p not in ("", ".", "..") for p in name.split("/")) and not member.pax_headers
                    and member.uid == member.gid == 0 and member.uname == member.gname == ""
                    and member.offset == position and member.offset_data == position + 512, "Signed TAR path/owner/inventory differs")
            position = member.offset_data + (member.size + 511) // 512 * 512
            seen.add(name); folded.add(name.lower()); expected = entries[name]
            if member.isdir():
                require(expected == {"kind": "directory", "mode": 0o755} and member.mode == 0o755 and member.size == 0, "TAR directory differs")
            else:
                require(member.isfile() and set(expected) == {"kind", "mode", "size", "sha256"} and expected["kind"] == "file"
                        and member.mode == expected["mode"] and member.mode in (0o644, 0o755)
                        and member.size == expected["size"] and 0 <= member.size <= MAX_FILE, "TAR file differs")
                total += member.size; require(total <= MAX_TOTAL, "TAR unpacked bound")
                source, digest, count = archive.extractfile(member), hashlib.sha256(), 0
                keep = name in ("creator-hub-portable-host.json", "AppRun")
                chunks = []
                while True:
                    part = source.read(1024 * 1024)
                    if not part:
                        break
                    count += len(part); require(count <= member.size, "TAR file overflow"); digest.update(part)
                    if keep:
                        require(count <= 16384, "Fixed startup record exceeds bound"); chunks.append(part)
                require(count == member.size and digest.hexdigest() == expected["sha256"], "TAR file bytes differ")
                if keep:
                    retained[name] = b"".join(chunks)
    require(seen == set(entries) and total == manifest["archive"]["unpackedSize"], "Incomplete signed TAR")
    tail = decoded[position:]
    require(1024 <= len(tail) <= 10240 and len(tail) % 512 == 0 and not any(tail), "Canonical TAR ending, no hidden trailing members")
    host = parse(retained["creator-hub-portable-host.json"])
    require(host == {"schemaVersion": 1, "version": "0.1.16", "activationInterface": "com.creatorworks.hub.Host1",
                     "integratedFeatures": True, "startupImageBinding": 1,
                     "executableSha256": entries["usr/bin/creator-hub"]["sha256"]}, "Signed host profile differs")
    require(entries["AppRun"]["mode"] == entries["usr/libexec/creator-hub-portable-selector"]["mode"] == 0o755,
            "Fixed signed entrypoints missing")
    return {"entries": len(seen), "unpackedBytes": total}


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, separators=(",", ": ")) + "\n").encode()


def verifier_root():
    return locations().with_name("native-linux-production-016-verifier")


def verifier_inputs(work, inputs):
    require(type(inputs) is dict and 3 < len(inputs) <= 64 and set(VERIFIER_PINS).issubset(inputs)
            and {VERIFIER_CRATE + "/Cargo.toml", VERIFIER_CRATE + "/src/lib.rs"}.issubset(inputs), "Complete verifier source binding required")
    require({file.relative_to(work / "source").as_posix() for file in (work / "source").rglob("*") if not file.is_dir()} == set(inputs),
            "Verifier snapshot inventory changed")
    for name, value in inputs.items():
        require(name in (*VERIFIER_PINS, VERIFIER_CRATE + "/Cargo.toml") or (
            name.startswith(VERIFIER_CRATE + "/src/") and name.endswith(".rs")
            and all(p not in ("", ".", "..") for p in name.split("/"))), "Unexpected verifier source")
        require(set(value) == {"pin", "originalStamp", "copyStamp"}, "Exact verifier input evidence required")
        if name in VERIFIER_PINS:
            require(value["pin"] == VERIFIER_PINS[name], "Verifier source, key or lock changed")
        for file, stamp in ((HERE.parent / name, value["originalStamp"]), (work / "source" / name, value["copyStamp"])):
            bound(file, value["pin"], 2 * 1024 * 1024)
            require(list(P.stamp(file.lstat())) == stamp, "Verifier input identity changed")


def verifier_compilers(compilers):
    require(set(compilers) == {"cargo", "rustc"}, "Exact pinned compiler pair required")
    for name, value in compilers.items():
        require(set(value) == {"path", "record", "stamp", "version"}, "Exact compiler evidence required")
        file = Path(value["path"])
        require(file.name == name and file.parent.name == "bin"
                and file.parent.parent.name == "1.99.0-x86_64-unknown-linux-gnu", "Fixed native Rust 1.99 toolchain required")
        require(P.record(file) == value["record"] and list(P.stamp(file.lstat())) == value["stamp"], "Compiler image changed")
        require(value["version"].startswith(name + " 1.99.0 "), "Compiler version differs")
        if name == "rustc":
            require("\nrelease: 1.99.0\n" in value["version"] and "\nhost: x86_64-unknown-linux-gnu\n" in value["version"], "Compiler release/host differs")


def copy_cargo_verifier(work):
    require(work == verifier_root() and work.resolve(strict=True) == work, "Fixed fresh verifier build directory required")
    file, copied = work / "target/debug/examples/verify-package-input", work / "verify-package-input"
    for parent in (file.parent, *file.parent.parents):
        value = parent.lstat()
        require(stat.S_ISDIR(value.st_mode) and not parent.is_symlink() and value.st_uid == os.getuid(), "Owned Cargo output ancestry required")
        if parent == work:
            require(stat.S_IMODE(value.st_mode) == 0o700, "Private fresh verifier build required")
            break
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and not file.is_symlink() and before.st_uid == os.getuid()
            and before.st_nlink >= 1 and stat.S_IMODE(before.st_mode) == 0o755
            and 0 < before.st_size <= 64 * 1024 * 1024, "Owned bounded Cargo executable required")
    # Cargo may hardlink its named example to a hashed output. Only this fixed build output permits it.
    identity = lambda value: (P.stamp(value), value.st_nlink)
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        require(identity(os.fstat(fd)) == identity(before), "Cargo executable changed during open")
        chunks, total = [], 0
        while total <= before.st_size:
            part = os.read(fd, min(1024 * 1024, before.st_size + 1 - total))
            if not part:
                break
            chunks.append(part); total += len(part)
        require(total == before.st_size and identity(os.fstat(fd)) == identity(before)
                and identity(file.lstat()) == identity(before), "Cargo executable changed during capture")
        raw = b"".join(chunks)
        output(copied, raw, 0o755)
        require(regular(copied, 64 * 1024 * 1024, 0o755) == raw and identity(os.fstat(fd)) == identity(before)
                and identity(file.lstat()) == identity(before), "Fresh verifier copy or Cargo executable changed")
        return copied, raw
    finally:
        os.close(fd)


def build_signature_verifier():
    work = verifier_root(); work.mkdir(mode=0o700)
    source = work / "source"; source.mkdir(mode=0o700)
    commit = os.environ["GITHUB_SHA"]
    names = command(["/usr/bin/git", "ls-tree", "-r", "--name-only", "-z", commit, "--",
                     VERIFIER_CRATE + "/Cargo.toml", VERIFIER_CRATE + "/Cargo.lock", VERIFIER_CRATE + "/src",
                     VERIFIER_SOURCE, VERIFIER_KEY], limit=65536).decode("utf8").split("\0")
    require(names[-1] == "" and 3 < len(names) - 1 <= 64 and len(set(names)) == len(names), "Bounded complete verifier source inventory required")
    inputs = {}
    for name in names[:-1]:
        require(name in (*VERIFIER_PINS, VERIFIER_CRATE + "/Cargo.toml") or (
            name.startswith(VERIFIER_CRATE + "/src/") and name.endswith(".rs")
            and all(p not in ("", ".", "..") for p in name.split("/"))), "Unexpected compiler input")
        raw = command(["/usr/bin/git", "show", commit + ":" + name], limit=2 * 1024 * 1024)
        expected = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        original = HERE.parent / name; bound(original, expected, 2 * 1024 * 1024)
        destination = source / name; destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        output(destination, raw, 0o644)
        inputs[name] = {"pin": expected, "originalStamp": list(P.stamp(original.lstat())), "copyStamp": list(P.stamp(destination.lstat()))}
    verifier_inputs(work, inputs)
    rustup = command(["/usr/bin/which", "rustup"], limit=4096).decode().strip()
    require(Path(rustup).is_absolute(), "Workflow Rust toolchain resolver required")
    compilers = {}
    for name in ("cargo", "rustc"):
        file = Path(command([rustup, "which", "--toolchain", "1.99.0", name], limit=4096).decode().strip())
        compilers[name] = {"path": str(file), "record": P.record(file), "stamp": list(P.stamp(file.lstat())),
                           "version": command([str(file), "-Vv"], limit=16384).decode("utf8")}
    verifier_compilers(compilers)
    cargo_home = work / "cargo-home"; cargo_home.mkdir(mode=0o700)
    env = {"HOME": os.environ["HOME"], "PATH": str(Path(compilers["cargo"]["path"]).parent) + ":/usr/bin:/bin",
           "CARGO_HOME": str(cargo_home), "RUSTC": compilers["rustc"]["path"]}
    command([compilers["cargo"]["path"], "build", "--locked", "--no-default-features", "--jobs", "2",
             "--manifest-path", str(source / VERIFIER_CRATE / "Cargo.toml"), "--example", "verify-package-input",
             "--target-dir", str(work / "target")], env=env, timeout=180, cwd=source)
    verifier_inputs(work, inputs); verifier_compilers(compilers)
    file, raw = copy_cargo_verifier(work)
    save(work / "receipt.json", {"schemaVersion": 1, "scope": "ci-only-offline-signature-verifier", "harnessSource": commit,
         "inputs": inputs, "compilers": compilers, "tool": {"pin": {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
         "stamp": list(P.stamp(file.lstat()))}, "releaseReady": False})


def signature_verifier():
    work = verifier_root()
    receipt = parse(regular(work / "receipt.json", 128 * 1024, 0o600))
    require(set(receipt) == {"schemaVersion", "scope", "harnessSource", "inputs", "compilers", "tool", "releaseReady"}
            and receipt["schemaVersion"] == 1 and receipt["scope"] == "ci-only-offline-signature-verifier"
            and receipt["harnessSource"] == os.environ["GITHUB_SHA"] and receipt["releaseReady"] is False, "Source-bound verifier receipt required")
    verifier_inputs(work, receipt["inputs"]); verifier_compilers(receipt["compilers"])
    file = work / "verify-package-input"
    bound(file, receipt["tool"]["pin"], 64 * 1024 * 1024)
    require(stat.S_IMODE(file.lstat().st_mode) == 0o755 and list(P.stamp(file.lstat())) == receipt["tool"]["stamp"], "Verifier executable identity changed")
    return file


def verify_catalogue_signature(metadata, signature):
    raw, sig = regular(metadata, VERIFIER_LIMIT), regular(signature, 4096)
    before = (P.stamp(metadata.lstat()), P.stamp(signature.lstat()))
    verifier = signature_verifier()
    answer = command([str(verifier), str(metadata), str(signature)], limit=4096)
    require(answer == ("Verified trusted package signature: " + hashlib.sha256(raw).hexdigest()
                       + ". No activation or client changes.\n").encode(), "Offline verifier did not confirm these exact bytes")
    require(signature_verifier() == verifier and before == (P.stamp(metadata.lstat()), P.stamp(signature.lstat()))
            and regular(metadata, VERIFIER_LIMIT) == raw and regular(signature, 4096) == sig, "Signature input/tool changed during verification")


def stage(root):
    require(set(p.name for p in root.iterdir()) == {"flatpak.zip", "portable.zip", "signed.zip", "profile.json", "signed-input.json", "api-binding.json"},
            "Fresh exact input directory required; no partial-stage adoption")
    node("preflight")
    profile = parse(regular(root / "profile.json", 16384, 0o600))
    signed = parse(regular(root / "signed-input.json", 16384, 0o600))
    binding = parse(regular(root / "api-binding.json", 32768, 0o600))
    require(binding["schemaVersion"] == 1 and binding["profile"] == PROFILE and binding["harnessSource"] == os.environ["GITHUB_SHA"]
            and all(binding[k] is False for k in GATES), "Fresh API binding required")
    stage_root = root / "stage"; stage_root.mkdir(mode=0o700)
    fixed = parse(command([os.environ["CONTROLLER_NODE"], "-e",
        "process.stdout.write(JSON.stringify(require('./scripts/native-linux-production-016-flatpak.cjs').FIXED))"]))
    stage_zip(bound(root / "flatpak.zip", fixed["zip"]), fixed["files"], stage_root / "flatpak")
    stage_zip(bound(root / "portable.zip", profile["portable"]["zip"], 768 * 1024 * 1024), profile["portable"]["files"], stage_root / "portable")
    stage_zip(bound(root / "signed.zip", signed["zip"], 8 * 1024 * 1024), signed["files"], stage_root / "signed")
    receipt = parse(regular(stage_root / "flatpak/production-flatpak-receipt.json", 262144))
    source = stage_root / "source"; source.mkdir(mode=0o700)
    for name, expected in receipt["source"]["input"]["files"].items():
        require(re.fullmatch(r"[A-Za-z0-9_./-]+", name) and all(p not in ("", ".", "..") for p in name.split("/")), "Source path")
        data = command(["/usr/bin/git", "show", fixed["sourceCommit"] + ":" + name])
        require(len(data) == expected["size"] and hashlib.sha256(data).hexdigest() == expected["sha256"], "Source blob differs")
        destination = source / name; destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True); output(destination, data)
    review = parse(node("verify-staged"))
    public_key = source / "src-tauri/src/catalog-key.pub"; bound(public_key, KEY, 4096)
    build_signature_verifier()
    for name in (DESCRIPTOR, MANIFEST):
        verify_catalogue_signature(stage_root / "signed" / name, stage_root / "signed" / (name + ".minisig"))
    manifest_bytes = regular(stage_root / "signed" / MANIFEST, 2 * 1024 * 1024)
    manifest = parse(manifest_bytes)
    review["archiveVerification"] = verify_tar(regular(stage_root / "portable" / ARCHIVE), manifest)
    review["generation"] = hashlib.sha256(manifest_bytes).hexdigest()
    review["signaturesVerified"] = True
    # A verified stage is still not an execution request or approval to install.
    review["runtimeEnabled"] = False
    save(root / "stage-review.json", review)


def clean_environment(root):
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "HOME": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "home/config"), "XDG_DATA_HOME": str(root / "home/data"),
            "XDG_CACHE_HOME": str(root / "home/cache"), "XDG_RUNTIME_DIR": str(root / "runtime"),
            "XDG_DATA_DIRS": str(root / "home/data") + ":/usr/local/share:/usr/share", "TMPDIR": str(root / "tmp"),
            "FLATPAK_USER_DIR": str(root / "installation"), "GDK_BACKEND": "x11", "NO_AT_BRIDGE": "0"}


def lab_environment(root):
    result = clean_environment(root)
    for name in ('GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_EVENT_NAME', 'GITHUB_REF',
                 'GITHUB_WORKFLOW_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'RUNNER_ENVIRONMENT',
                 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP', 'EXECUTION_REQUEST', 'CONTROLLER_NODE', 'CONTROLLER_PROFILE', 'SIGNED_INPUT'):
        if name in os.environ:
            result[name] = os.environ[name]
    return result


def bootstrap_inspect(root):
    # The unchanged data/provenance/signature review must precede this closed byte admission.
    return parse(command([os.environ['CONTROLLER_NODE'], str(HERE / 'linux-update-lab-feed.cjs'),
                          'bootstrap-016-inspect', str(root)], env=lab_environment(root)))


def loopback_proxy(value):
    require(type(value) is str and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', value)
            and int(value.rsplit(':', 1)[1]) <= 65535, 'Internally created IPv4 loopback proxy required')
    return value


def bootstrap_transport_ready(root, review, proxy):
    # Normal system chain/hostname validation, unchanged production URLs, no public-discovery claim.
    proxy = loopback_proxy(proxy)
    prefix = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/"
    image = PortalImage('curl')
    try:
        for name in (DESCRIPTOR, DESCRIPTOR + ".minisig", MANIFEST, MANIFEST + ".minisig"):
            expected = review["signed"]["files"][name]
            require(type(expected) is dict and set(expected) == {'size', 'sha256'} and type(expected['size']) is int
                    and 0 < expected['size'] <= 2 * 1024 * 1024 and type(expected['sha256']) is str
                    and re.fullmatch('[a-f0-9]{64}', expected['sha256']), 'Bounded exact readiness pin required')
            require(image.snapshot() == image.pin, 'Readiness curl image changed')
            value = command(['/usr/bin/curl', '--disable', '--silent', '--show-error', '--fail', '--http1.1',
                '--proto', '=https', '--proto-redir', '=https', '--no-location', '--max-redirs', '0', '--retry', '0',
                '--proxy', proxy, '--noproxy', '', '--tlsv1.2', '--connect-timeout', '10', '--max-time', '30',
                '--max-filesize', str(expected['size']), '--write-out', '\n%{json}', '--url', prefix + name],
                env=clean_environment(root), timeout=35, limit=expected['size'] + 16384)
            require(image.snapshot() == image.pin, 'Readiness curl image changed during transfer')
            size = expected['size']
            require(size < len(value) <= size + 16384 and value[size:size + 1] == b'\n', 'Bounded curl body and metadata required')
            raw, metadata = value[:size], parse(value[size + 1:])
            require(type(metadata) is dict and all(type(metadata.get(key)) is int and metadata[key] == expected_value
                    for key, expected_value in (('http_code', 200), ('http_connect', 200), ('num_redirects', 0), ('ssl_verify_result', 0)))
                    and metadata.get('http_version') == '1.1' and metadata.get('url_effective') == prefix + name,
                    'Exact verified HTTP/1.1 lab transport refused')
            require(hashlib.sha256(raw).hexdigest() == expected['sha256'], 'Lab URL differs from reviewed signed input')
    finally:
        image.close()


def protected_trust_parent(path):
    for parent in (path, *path.parents):
        value = parent.lstat()
        require(stat.S_ISDIR(value.st_mode) and not parent.is_symlink() and value.st_uid == value.st_gid == 0
                and not value.st_mode & 0o022, 'Protected native CI trust ancestry required')


def trust_view():
    result = {}
    for prefix, directory in (('local', TLS_DESTINATION.parent), ('system', Path('/etc/ssl/certs'))):
        protected_trust_parent(directory)
        paths = sorted(directory.rglob('*')) if prefix == 'local' else sorted(directory.iterdir())
        require(len(paths) <= 4096, 'Bounded CI certificate inventory required')
        for file in paths:
            row = file.lstat(); name = prefix + '/' + file.relative_to(directory).as_posix()
            require(row.st_uid == row.st_gid == 0, 'Foreign CI certificate entry')
            if stat.S_ISLNK(row.st_mode):
                require(prefix == 'system', 'Redirected local CA source refused')
                result[name] = {'link': os.readlink(file)}
            elif stat.S_ISDIR(row.st_mode):
                require(not row.st_mode & 0o022, 'Writable CI certificate directory')
                result[name] = {'directory': True, 'mode': stat.S_IMODE(row.st_mode)}
            else:
                require(not row.st_mode & 0o022, 'Writable CI certificate file')
                result[name] = P.record(file, 2 * 1024 * 1024)
    require(len(json_bytes(result)) <= 512 * 1024, 'Bounded trust before-image required')
    return result


def trust_difference(before, after, certificate_absent):
    require(type(before) is dict and type(after) is dict and max(len(before), len(after)) <= 4096,
            'Bounded trust diagnostic snapshots required')
    require(type(certificate_absent) is bool and all(type(name) is str for name in before.keys() | after.keys()),
            'Trust diagnostic snapshot names and certificate state')
    def bundle_pin(snapshot):
        value = snapshot.get('system/ca-certificates.crt')
        if not (type(value) is dict and 'link' not in value and type(value.get('size')) is int
                and 0 < value['size'] <= 2 * 1024 * 1024 and type(value.get('sha256')) is str
                and re.fullmatch(r'[a-f0-9]{64}', value['sha256'])):
            return None
        return {key: value[key] for key in ('size', 'sha256')}
    original_bundle, current_bundle = bundle_pin(before), bundle_pin(after)
    def entry(value):
        if value is None:
            return None
        require(type(value) is dict, 'Trust diagnostic entry shape')
        if 'link' in value:
            target = value['link']; require(type(target) is str and len(target) <= 4096, 'Bounded trust link')
            result = {'kind': 'link', 'targetSha256': hashlib.sha256(target.encode()).hexdigest()}
            if target in (str(TLS_DESTINATION), '../../usr/local/share/ca-certificates/' + TLS_DESTINATION.name,
                          TLS_DESTINATION.stem + '.pem'):
                result['ownedCandidateTarget'] = target
            return result
        result = {key: value[key] for key in ('directory', 'mode', 'uid', 'gid', 'size', 'sha256') if key in value}
        require(all(type(v) is int for k, v in result.items() if k not in ('directory', 'sha256'))
                and ('directory' not in result or type(result['directory']) is bool)
                and ('sha256' not in result or re.fullmatch(r'[a-f0-9]{64}', result['sha256'])), 'Public trust diagnostic metadata only')
        return result
    rows, counts = [], dict.fromkeys(('added', 'removed', 'changed'), 0)
    for name in sorted(before.keys() | after.keys()):
        if name in before and name in after and before[name] == after[name]:
            continue
        kind = 'added' if name not in before else 'removed' if name not in after else 'changed'
        counts[kind] += 1
        if len(rows) < 64:
            display = {'name': name} if re.fullmatch(r'(?:local|system)/[A-Za-z0-9_./+-]{1,240}', name) and '..' not in name.split('/') else {
                'nameRedacted': True, 'nameSha256': hashlib.sha256(name.encode()).hexdigest()}
            rows.append({**display, 'change': kind, 'before': entry(before.get(name)), 'after': entry(after.get(name))})
    result = {'schemaVersion': 1, 'readOnly': True, 'cleanupVerified': False, 'temporaryCertificateAbsent': certificate_absent,
              'bundle': {'before': original_bundle, 'after': current_bundle,
                         'bytesEqual': original_bundle is not None and original_bundle == current_bundle},
              'beforeSha256': hashlib.sha256(json_bytes(before)).hexdigest(), 'afterSha256': hashlib.sha256(json_bytes(after)).hexdigest(),
              'counts': counts, 'complete': sum(counts.values()) == len(rows), 'entries': rows}
    require(len(json_bytes(result)) <= 65536, 'Trust diagnostic output bound')
    return result


def tls_arm(root):
    raw = regular(root / 'lab-tls/armed.json', 512 * 1024, 0o600)
    arm = parse(raw)
    require(set(arm) == {'schemaVersion', 'profile', 'certificate', 'before'}
            and arm['schemaVersion'] == 1 and arm['profile'] == '016-bootstrap', 'Exact cleanup authority required')
    bound(root / 'lab-tls/public.crt', arm['certificate'], 65536)
    return arm, raw


@contextmanager
def tls_lock(root, seconds=0):
    import fcntl
    path = root / 'lab-tls/cleanup.lock'
    regular(path, 16, 0o600)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(P.stamp(os.fstat(fd)) == P.stamp(path.lstat()), 'Cleanup lock identity changed')
        end = time.monotonic() + seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); break
            except BlockingIOError:
                require(time.monotonic() < end, 'TLS cleanup is still owned; no concurrent publication/removal')
                time.sleep(0.1)
        yield
    finally:
        os.close(fd)


def capture_tls_aliases(before, after):
    added = {'system/' + name: {'link': target} for name, target in TLS_ALIAS_TARGETS.items()}
    require(not set(added).intersection(before) and after == {**before, **added}, 'Only the original trust snapshot plus the exact owned alias pair is eligible')
    bundle = before.get('system/ca-certificates.crt')
    require(type(bundle) is dict and type(bundle.get('size')) is int and 0 < bundle['size'] <= 2 * 1024 * 1024
            and type(bundle.get('sha256')) is str and re.fullmatch(r'[a-f0-9]{64}', bundle['sha256'])
            and bundle.get('uid') == bundle.get('gid') == 0 and bundle.get('mode') == 0o644, 'Original bounded root-owned trust bundle required')
    protected_trust_parent(TLS_TRUST)
    original = TLS_TRUST.lstat()
    directory_key = lambda info: [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid]
    links = {}
    for name, target in TLS_ALIAS_TARGETS.items():
        file = TLS_TRUST / name; info = file.lstat()
        require(stat.S_ISLNK(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1
                and os.readlink(file) == target, 'Only exact root-owned nonlinked alias symlinks may be removed')
        value = list(P.stamp(info)) + [info.st_nlink]
        current = file.lstat()
        require(list(P.stamp(current)) + [current.st_nlink] == value, 'Alias changed during capture')
        links[name] = value
    require(directory_key(TLS_TRUST.lstat()) == directory_key(original) and not os.path.lexists(TLS_DESTINATION)
            and P.record(TLS_TRUST / 'ca-certificates.crt', 2 * 1024 * 1024) == bundle, 'Trust directory, certificate or original bundle changed')
    return {'directory': directory_key(original), 'links': links, 'bundle': {key: bundle[key] for key in ('size', 'sha256')}}


def consume_tls_alias_attempt(root, armed_bytes, proof):
    parent = root / 'lab-tls'; marker = parent / 'alias-cleanup-attempted.json'
    raw = json_bytes({'schemaVersion': 1, 'profile': '016-bootstrap', 'armedSha256': hashlib.sha256(armed_bytes).hexdigest(), 'proof': proof})
    require(len(raw) <= 4096 and parent.resolve(strict=True) == parent, 'Bounded canonical one-attempt marker required')
    before = parent.lstat()
    require(stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o700,
            'Private owned cleanup marker directory required')
    key = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        require(key(os.fstat(directory)) == key(before), 'Cleanup marker directory changed')
        fd = os.open(marker.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        os.fchmod(fd, 0o600)
        require(os.write(fd, raw) == len(raw), 'Cleanup attempt marker write is uncertain; no helper authorized')
        os.fsync(fd)
        current = os.fstat(fd)
        require(stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid() and current.st_nlink == 1
                and stat.S_IMODE(current.st_mode) == 0o600 and key(os.stat(marker.name, dir_fd=directory, follow_symlinks=False)) == key(current)
                and key(parent.lstat()) == key(os.fstat(directory)) == key(before), 'Cleanup attempt marker identity changed')
        os.fsync(directory)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def cleanup_owned_tls(root, arm, armed_bytes):
    require(regular(root / 'lab-tls/armed.json', 512 * 1024, 0o600) == armed_bytes, 'Cleanup authority changed')
    bound(root / 'lab-tls/public.crt', arm['certificate'], 65536)
    protected_trust_parent(TLS_DESTINATION.parent)
    result = {'schemaVersion': 1, 'profile': '016-bootstrap', 'cleanupVerified': True,
              'publicDiscovery': False, 'releaseReady': False, 'scope': 'disposable-github-ci-only'}
    if os.path.lexists(root / 'lab-tls/alias-cleanup-attempted.json'):
        require(not os.path.lexists(TLS_DESTINATION) and trust_view() == arm['before'],
                'Alias cleanup attempt consumed; no retry or adoption, disposable teardown required')
        return result
    if os.path.lexists(TLS_DESTINATION):
        row = TLS_DESTINATION.lstat()
        require(stat.S_ISREG(row.st_mode) and row.st_uid == row.st_gid == 0 and row.st_nlink == 1
                and stat.S_IMODE(row.st_mode) == 0o644 and row.st_size == arm['certificate']['size']
                and hashlib.sha256(TLS_DESTINATION.read_bytes()).hexdigest() == arm['certificate']['sha256'],
                'Foreign/replaced CI certificate retained; cleanup outcome unknown')
        command(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-B', '-c', TLS_REMOVE,
                 str(TLS_DESTINATION), arm['certificate']['sha256']], env=lab_environment(root))
        command(['/usr/bin/sudo', '-n', '/usr/sbin/update-ca-certificates'], env=lab_environment(root))
    absent, after = not os.path.lexists(TLS_DESTINATION), trust_view()
    added = {'system/' + name: {'link': target} for name, target in TLS_ALIAS_TARGETS.items()}
    if absent and not set(added).intersection(arm['before']) and after == {**arm['before'], **added}:
        try:
            proof = capture_tls_aliases(arm['before'], after)
        except Exception:
            # An uncertain capture must not adopt a replacement on the next call.
            consume_tls_alias_attempt(root, armed_bytes, {'captureFailed': True})
            raise
        consume_tls_alias_attempt(root, armed_bytes, proof)
        command(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-B', '-c', TLS_ALIAS_REMOVE,
                 json.dumps(proof, separators=(',', ':'), allow_nan=False)], env=lab_environment(root))
        absent, after = not os.path.lexists(TLS_DESTINATION), trust_view()
    if not absent or after != arm['before']:
        # A failed one-attempt cleanup never weakens the full before-image requirement.
        try:
            difference = trust_difference(arm['before'], after, absent)
            for number in (1, 2):
                try:
                    save(root / f'tls-trust-diff-{number}-gtk.json', difference)
                    break
                except FileExistsError:
                    continue
        except Exception:
            pass
    require(absent and after == arm['before'], 'CI trust before-image was not restored')
    receipt = root / 'tls-cleanup.json'
    if receipt.exists():
        require(parse(regular(receipt, 4096, 0o600)) == result, 'Existing cleanup evidence differs')
    else:
        save(receipt, result)
    return result


class LabChild:
    def __init__(self, root, argv, label):
        self.root = root
        _, native = P.helpers()
        self.child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      env=lab_environment(root), cwd=HERE.parent)
        self.capture = native.Capture(self.child, root, label)
        self.lines = 0

    def send(self, raw):
        require(type(raw) is bytes and 0 < len(raw) <= 131072 and raw.endswith(b'\n'), 'Bounded fixed lab control required')
        self.child.stdin.write(raw); self.child.stdin.flush()

    def expect(self, kind, seconds=30):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.capture.pump(0.02)
            output = bytes(self.capture.items['stdout']['kept'])
            rows = output.split(b'\n')[:-1]
            require(len(rows) <= self.lines + 1 and len(output) <= 8192, 'Unexpected lab control output')
            if len(rows) > self.lines:
                value = parse(rows[self.lines]); self.lines += 1
                require(value.get('kind') == kind and value.get('pid') == self.child.pid and self.child.poll() is None,
                        'Lab child readiness differs')
                return value
            require(self.child.poll() is None, 'Owned lab child exited before readiness')
        raise RuntimeError('Owned lab readiness deadline; no native app input authorized')

    def finish(self):
        try:
            if not self.child.stdin.closed:
                self.child.stdin.close()
            end = time.monotonic() + 60
            while time.monotonic() < end:
                self.capture.pump(0.02)
                if self.child.poll() is not None and all(row['eof'] for row in self.capture.metadata().values()):
                    break
            require(self.child.poll() == 0 and all(row['eof'] and not row['truncated'] and row['bytes'] <= 8192
                    for row in self.capture.metadata().values()), 'Lab close/cleanup outcome unknown; disposable teardown required')
            self.child.wait(timeout=0)
        finally:
            self.capture.close()


def prepare_tls(root, review):
    verified_review(root, review)
    bootstrap_inspect(root)
    require(not os.path.lexists(TLS_DESTINATION), 'Existing CI trust entry refused')
    folder = root / 'lab-tls'; folder.mkdir(mode=0o700)
    output(folder / 'tls.cnf', TLS_CONFIGURATION)
    command(['/usr/bin/openssl', 'req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
             '-config', str(folder / 'tls.cnf'), '-keyout', str(folder / 'private.pem'), '-out', str(folder / 'public.crt')], env=lab_environment(root))
    for name in ('private.pem', 'public.crt'):
        os.chmod(folder / name, 0o600); regular(folder / name, 65536, 0o600)
    certificate = regular(folder / 'public.crt', 65536, 0o600)
    arm = {'schemaVersion': 1, 'profile': '016-bootstrap', 'certificate': {'size': len(certificate),
           'sha256': hashlib.sha256(certificate).hexdigest()}, 'before': trust_view()}
    output(folder / 'cleanup.lock', b'owned')
    with (folder / 'armed.json').open('xb') as stream:
        os.chmod(folder / 'armed.json', 0o600); stream.write(json_bytes(arm)); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    # Only this retained pipe owner can request publication. EOF/crash runs cleanup.
    guard = LabChild(root, ['/usr/bin/python3', '-B', str(Path(__file__).resolve()), '_tls_guard'], 'tls-guard')
    try:
        guard.expect('tls-cleanup-armed')
        guard.send(b'install\n'); guard.expect('tls-installed', 60)
        return guard
    except Exception:
        guard.finish()
        raise


def tls_guard(root):
    require(os.environ.get('EXECUTION_REQUEST') == REQUEST and stat.S_ISFIFO(os.fstat(0).st_mode), 'Private CI cleanup lease required')
    with tls_lock(root):
        arm, raw = tls_arm(root)
        require(not os.path.lexists(TLS_DESTINATION) and trust_view() == arm['before'], 'Initial CI trust state changed')
        print(json.dumps({'kind': 'tls-cleanup-armed', 'pid': os.getpid()}), flush=True)
        try:
            require(select.select([0], [], [], 30)[0] and os.read(0, 32) == b'install\n', 'No fixed install request')
            protected_trust_parent(TLS_DESTINATION.parent)
            require(not os.path.lexists(TLS_DESTINATION), 'Foreign CI trust entry appeared')
            cert = bound(root / 'lab-tls/public.crt', arm['certificate'], 65536)
            command(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-B', '-c', TLS_PUBLISH,
                     str(TLS_DESTINATION), base64.b64encode(cert).decode('ascii')], env=lab_environment(root))
            command(['/usr/bin/sudo', '-n', '/usr/sbin/update-ca-certificates'], env=lab_environment(root))
            print(json.dumps({'kind': 'tls-installed', 'pid': os.getpid()}), flush=True)
            require(select.select([0], [], [], 900)[0] and os.read(0, 32) == b'', 'Cleanup lease ended unexpectedly')
        finally:
            cleanup_owned_tls(root, arm, raw)


def verify_tls_cleanup(root):
    armed = root / 'lab-tls/armed.json'
    if not armed.exists():
        require(not os.path.lexists(TLS_DESTINATION), 'Unowned CI trust entry retained; no cleanup authority')
        return
    require(os.environ.get('EXECUTION_REQUEST') == REQUEST, 'No cleanup adoption from another mode')
    with tls_lock(root, 60):
        arm, raw = tls_arm(root)
        cleanup_owned_tls(root, arm, raw)


def bootstrap_feed(root):
    bootstrap_inspect(root)
    arm, _ = tls_arm(root)
    cert = bound(root / 'lab-tls/public.crt', arm['certificate'], 65536)
    key = regular(root / 'lab-tls/private.pem', 65536, 0o600)
    child = LabChild(root, [os.environ['CONTROLLER_NODE'], str(HERE / 'linux-update-lab-feed.cjs'), 'bootstrap-016', str(root)], 'lab-feed')
    try:
        child.send(json.dumps({'key': base64.b64encode(key).decode('ascii'), 'cert': base64.b64encode(cert).decode('ascii')},
                              separators=(',', ':')).encode('ascii') + b'\n')
        ready = child.expect('bootstrap-016-ready')
        require(set(ready) == {'kind', 'pid', 'proxyUrl', 'publicDiscovery', 'releaseReady'}
                and ready['publicDiscovery'] is ready['releaseReady'] is False, 'Lab scope differs')
        child.proxy = loopback_proxy(ready['proxyUrl'])
        return child
    except Exception:
        child.finish()
        raise


def finish_bootstrap_feed(feed, root, review):
    feed.send(b'close\n'); feed.finish()
    report = parse(regular(root / 'lab-transport.json', 16384, 0o600))
    expected = {BOOTSTRAP_PREFIX + name: pin['sha256'] for name, pin in review['signed']['files'].items()}
    expected[BOOTSTRAP_PREFIX + ARCHIVE] = review['portable']['manifest']['archive']['sha256']
    require(report['scope'] == 'linux-portable-016-bootstrap-lab-transport' and report['publicDiscovery'] is False
            and report['releaseReady'] is False and report['closeReason'] == 'caller'
            and {row['path']: row['sha256'] for row in report['requests'] if row['host'] == 'github.com'} == expected,
            'Every fixed bootstrap asset must have been served by the owned lab; no public acceptance')


def namespace_ids(raw, pid):
    require(type(raw) is bytes and len(raw) <= 16384, "Bounded kernel status required")
    matches = re.findall(rb"^NSpid:\s+([0-9 \t]+)$", raw, re.M)
    require(len(matches) == 1, "One kernel namespace PID tuple required")
    ids = [int(value) for value in matches[0].split()]
    require(1 <= len(ids) <= 8 and ids[0] == pid and all(value > 0 for value in ids), "Invalid namespace PID tuple")
    return ids


def ax_identity(peer, reported, process, namespaces, uid):
    # The AX peer is a host-namespace credential, never an untrusted GTK label.
    require(type(peer) is dict and peer.get("pid") == process["pid"] and peer.get("uid") == uid
            and re.fullmatch(r":[0-9]+\.[0-9]+", peer.get("owner", "")) and process["uids"] == [uid] * 4
            and type(reported) is int and reported in namespaces and namespaces[0] == process["pid"],
            "AX connection is not the exact kernel-bound client; no input permitted")


def proxy_runtime_path(value, runtime, uid):
    # Flatpak 1.12.7 common/flatpak-run.c create_proxy_socket/add_a11y_dbus_args.
    # https://github.com/flatpak/flatpak/blob/1.12.7/common/flatpak-run.c#L883-L899
    if value in ('/run/flatpak/at-spi-bus', '/run/flatpak/bus'):
        return value
    for prefix in (runtime, f'/run/user/{uid}'):
        if re.fullmatch(re.escape(prefix) + r'/\.dbus-proxy/(?:a11y|session|system)-bus-proxy-[A-Za-z0-9]{6}', value):
            return value
    return None


def proxy_unix_rows(raw, inodes, runtime, uid):
    require(type(raw) is bytes and len(raw) <= 512 * 1024, 'Bounded UNIX socket diagnostic')
    lines = raw.decode('utf-8').splitlines()
    require(0 < len(lines) <= 4096 and lines[0].split() == ['Num', 'RefCount', 'Protocol', 'Flags', 'Type', 'St', 'Inode', 'Path'],
            'Known kernel UNIX socket table header required')
    rows, seen = [], set()
    for line in lines[1:]:
        fields = line.split(None, 7)
        if len(fields) < 7 or not fields[6].isdigit() or int(fields[6]) not in inodes:
            continue
        inode = int(fields[6]); require(inode not in seen and len(rows) < 128, 'Duplicate/oversize owned socket rows')
        require(all(re.fullmatch(r'[a-fA-F0-9]+', fields[n]) for n in (3, 4, 5)), 'Known UNIX socket fields')
        seen.add(inode); row = {'inode': inode, 'flags': fields[3], 'type': fields[4], 'state': fields[5]}
        if len(fields) == 8:
            name = fields[7]; require(len(name) <= 4096, 'Bounded socket name')
            row['pathSha256'] = hashlib.sha256(name.encode()).hexdigest()
            known = proxy_runtime_path(name, runtime, uid)
            if known is not None:
                row['runtimePath'] = known
        rows.append(row)
    return rows


def proxy_process_io(pid, runtime, uid):
    require(type(pid) is int and 1 < pid <= 2147483647, 'Exact diagnostic process required')
    root = Path(f'/proc/{pid}')
    def read(file, limit):
        before = file.lstat(); require(stat.S_ISREG(before.st_mode), 'Kernel diagnostic file required')
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            require(P.stamp(os.fstat(stream.fileno())) == P.stamp(before), 'Diagnostic FD changed')
            raw = stream.read(limit + 1)
            require(len(raw) <= limit and P.stamp(os.fstat(stream.fileno())) == P.stamp(before), 'Kernel diagnostic bound/identity')
        require(P.stamp(file.lstat()) == P.stamp(before), 'Kernel diagnostic pathname changed')
        return raw
    ids = namespace_ids(read(root / 'status', 16384), pid)
    mount = os.readlink(root / 'ns/mnt'); require(re.fullmatch(r'mnt:\[[0-9]+\]', mount), 'Kernel mount namespace')
    def fd_names():
        names = []
        with os.scandir(root / 'fd') as entries:
            for item in entries:
                require(len(names) < 128 and re.fullmatch(r'[0-9]{1,10}', item.name), 'Bounded diagnostic FD table')
                names.append(item.name)
        return sorted(names, key=int)
    names, sockets = fd_names(), []
    for name in names:
        file = root / 'fd' / name; before = file.lstat()
        require(stat.S_ISLNK(before.st_mode), 'Kernel FD link required')
        target = os.readlink(file)
        require(len(target) <= 4096 and P.stamp(file.lstat()) == P.stamp(before) and os.readlink(file) == target, 'Diagnostic FD link changed')
        match = re.fullmatch(r'socket:\[([0-9]{1,20})\]', target)
        if match:
            sockets.append({'fd': int(name), 'inode': int(match[1])})
    unix = proxy_unix_rows(read(root / 'net/unix', 512 * 1024), {r['inode'] for r in sockets}, runtime, uid)
    paths = {'/run/flatpak/at-spi-bus', '/run/flatpak/bus'} | {r['runtimePath'] for r in unix if 'runtimePath' in r}
    require(len(paths) <= 8, 'Bounded source-profile runtime socket paths')
    objects = []
    for path in sorted(paths):
        file = Path(f'/proc/{pid}/root' + path)
        try:
            before = file.lstat()
        except FileNotFoundError:
            objects.append({'path': path, 'present': False}); continue
        require(P.stamp(file.lstat()) == P.stamp(before), 'Runtime socket metadata changed')
        objects.append({'path': path, 'present': True, 'socket': stat.S_ISSOCK(before.st_mode), 'dev': before.st_dev,
                        'ino': before.st_ino, 'mode': before.st_mode, 'uid': before.st_uid, 'gid': before.st_gid})
    require(fd_names() == names and os.readlink(root / 'ns/mnt') == mount
            and namespace_ids(read(root / 'status', 16384), pid) == ids, 'Kernel diagnostic namespace/FD table changed')
    return {'namespacePids': ids, 'mountNamespace': mount, 'sockets': sockets, 'unixRows': unix, 'runtimeObjects': objects}


PROXY_CAPTURE_STAGES = ('expected-launch', 'current-launch', 'client-identity', 'launch-identity', 'subtree',
                        'subtree-membership', 'proxy-identity', 'subtree-records', 'client-io', 'proxy-io',
                        'subtree-recheck', 'final-identities', 'output-bound')


def proxy_process_snapshot(row):
    require(type(row) is dict and all(type(row.get(key)) is int and 0 < row[key] <= 2147483647
            for key in ('pid', 'parentPid')) and type(row.get('startTime')) is str
            and re.fullmatch(r'[1-9][0-9]{0,19}', row['startTime']), 'Bounded diagnostic process tuple')
    require(type(row.get('uids')) is list and len(row['uids']) == 4 and all(type(uid) is int and 0 <= uid <= 2147483647
            for uid in row['uids']), 'Bounded diagnostic process UIDs')
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_mtime_ns', 'st_ctime_ns')
    require(type(row.get('image')) is dict and 'st_size' in row['image'], 'Diagnostic image metadata required')
    image = {key: row['image'][key] for key in fields if key in row['image']}
    require(all(type(value) is str and re.fullmatch(r'[0-9]{1,20}', value) for value in image.values()), 'Bounded image metadata')
    path = row.get('executable')
    require(type(path) is str and 0 < len(path) <= 4096, 'Bounded diagnostic executable path')
    result = {key: row[key] for key in ('pid', 'parentPid', 'startTime')}
    result.update(uids=list(row['uids']), image=image, executableSha256=hashlib.sha256(path.encode()).hexdigest(), verified=False)
    if path in ('/usr/bin/flatpak', '/usr/bin/bwrap', '/usr/libexec/flatpak-bwrap',
                '/usr/bin/xdg-dbus-proxy', '/app/bin/creator-hub-flatpak-activate'):
        result['executable'] = path
    if 'kernelImageSha256' in row:
        require(type(row['kernelImageSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', row['kernelImageSha256']), 'Diagnostic kernel image hash')
        result['kernelImageSha256'] = row['kernelImageSha256']
    return result


def consent_text(generation):
    require(re.fullmatch(r"[a-f0-9]{64}", generation), "Exact signed generation required")
    return ("Install Creator Hub native support 0.1.16?\n\nThis installs and registers the verified generation " + generation +
            " in your private native data directory. The Hub window runs OUTSIDE the Flatpak sandbox and uses your existing native settings.\n\n"
            "Your projects, MCP connections and settings will not be imported, replaced or migrated here. After installation, close this window normally and reopen Hub from Flatpak. "
            "No app will be launched or restarted automatically.\n\nCancel keeps Store creation, selection and registration unchanged.")


RESUME_STEPS = {
    "install": "Select only this already staged, signed generation. Registration is a separate later step.",
    "acknowledge-old": "Acknowledge that the interrupted deployment retained its prior selection. This step will not select or register a package.",
    "acknowledge-committed": "Acknowledge the already committed deployment selection. This step will not select another generation or register it.",
    "restore-registration": "Restore only the reviewed registration before-images. The selected package stays in place; registering it requires another review and approval.",
    "register": "Register this already selected, signed generation for native Flatpak activation. This step does not change the selected package.",
    "complete": "Verify that this exact setup is complete. This step does not install, select, register or launch an app.",
}


def resume_text(generation, step):
    require(re.fullmatch(r"[a-f0-9]{64}", generation) and step in RESUME_STEPS, "One known origin-bound native review step")
    return ("Review Creator Hub native support 0.1.16?\n\nVerified generation: " + generation + "\n\n" + RESUME_STEPS[step] +
            "\n\nOnly this reviewed step is approved. If setup advances, choose Review again for a fresh review and separate approval of the next step. "
            "Nothing is replayed or launched automatically. Your projects, MCP connections and settings are not migrated here. Cancel applies no step.")


def dialog_target(rows, labels, buttons, action):
    require(0 < len(rows) <= 48 and rows[0]["role"] in ("alert", "dialog")
            and not any(row["role"] in ("alert", "dialog", "frame", "window", "application") for row in rows[1:]), "One bounded native dialog")
    require(sorted(row["name"] for row in rows if row["role"] == "label") == sorted(labels), "Exact source-bound native question required")
    targets = [(index, row) for index, row in enumerate(rows) if row["role"] == "push button"]
    require(sorted(row["name"] for _, row in targets) == sorted(buttons) and action in buttons, "Exact native buttons required")
    result = [index for index, row in targets if row["name"] == action and row["showing"] and row["enabled"]]
    require(len(result) == 1, "One actionable native control")
    return result[0]


def launcher_button_mapping(source, question, action):
    require(type(source) is str and len(source.encode()) <= 262144, "Bounded authenticated launcher source required")
    expected = {'dialog': [('Cancel', 'Cancel'), ('Get Native Hub', 'Other(1)'), ('Open Creator Hub', 'Accept')],
                'error': [('Close', 'Close'), ('Get Native Hub', 'Other(1)')]}
    for variable, entries in expected.items():
        bodies = re.findall(r'\b' + variable + r'\.add_buttons\(\s*&\[(.*?)\]\s*\);', source, re.S)
        require(len(bodies) == 1, "One source-defined launcher button set required")
        pattern = r'\(\s*("(?:[^"\\]|\\.)*")\s*,\s*gtk::ResponseType::(Cancel|Close|Accept|Other\(1\))\s*\)\s*,'
        actual = [(parse(label), response) for label, response in re.findall(pattern, bodies[0])]
        require(actual == entries and not re.sub(pattern, '', bodies[0]).strip(), "Launcher source button order/response changed")
    defaults = re.findall(r'\b(?:dialog|error)\.set_default_response\((.*?)\);', source)
    require(defaults == ['gtk::ResponseType::Accept'], "Source-defined default Accept response required")
    require('if choice == gtk::ResponseType::Other(1)' in source and 'return installer_page();' in source
            and 'if choice != gtk::ResponseType::Accept' in source and 'return Ok(());' in source
            and 'return Err(message);' in source, "Launcher response branches changed")
    choices = {('disclosure', 'Cancel'): 'Escape', ('disclosure', 'Open Creator Hub'): 'Enter',
               ('disclosure', 'Get Native Hub'): 'ShiftTabSpace', ('missing', 'Close'): 'Escape'}
    require((question, action) in choices, "Only finite source-bound launcher decisions are allowed")
    return {'question': question, 'action': action, 'sequence': choices[question, action],
            'buttons': expected['dialog' if question == 'disclosure' else 'error'],
            'defaultResponse': 'Accept' if question == 'disclosure' else None,
            'widgetFocusVerified': False, 'nativeOutcomeRequired': True}


def keyboard_delivery(receipt, sequence, process, window, origin, *, warm_companion=None, warm_terminal=None):
    fields = {'schemaVersion', 'mechanism', 'pid', 'startTime', 'window', 'intent', 'candidateAction', 'delivery',
              'deliveryComplete', 'launchProvenance', 'widgetFocusVerified', 'outcomeVerified', 'nativeVerificationRequired', 'releaseReady'}
    if warm_companion is not None:
        require(type(warm_companion) is K.WarmRoot and sequence == 'Enter', "Only one opaque warm Enter companion is allowed")
        fields |= {'warmCompanion'}
    require(type(receipt) is dict and set(receipt) in (fields, fields | {'refusal'}) and len(json_bytes(receipt)) <= 16384,
            "One bounded complete helper receipt required")
    require(type(receipt['schemaVersion']) is int and receipt['schemaVersion'] == 1
            and receipt['mechanism'] == 'exact-xid-keyboard' and type(receipt['pid']) is int and receipt['pid'] == process['pid']
            and receipt['startTime'] == process['startTime'] and type(receipt['window']) is int and receipt['window'] == window
            and receipt['intent'] == sequence and receipt['candidateAction'] == {
                'Escape': 'decline-or-close', 'Enter': 'default-open', 'ShiftTabSpace': 'get-native-hub'}[sequence]
            and receipt['widgetFocusVerified'] is False and receipt['outcomeVerified'] is False
            and receipt['nativeVerificationRequired'] is True and receipt['releaseReady'] is False,
            "Helper receipt target/intent/authority differs")
    if warm_companion is not None:
        require(receipt['warmCompanion'] == {'binding': warm_companion.evidence, 'managedWindows': [warm_companion.window, window]},
                "Warm receipt differs from the exact two-owned-window binding")
    provenance = receipt['launchProvenance']
    require(type(provenance) is dict and set(provenance) == {'readOnly', 'popen', 'admittedLaunch', 'systemImage'}
            and provenance['readOnly'] is True and provenance['popen'] == {key: origin[key] for key in K.CONTINUITY_FIELDS},
            "Independent owned Popen provenance required")
    admitted, system = provenance['admittedLaunch'], provenance['systemImage']
    K.validate_process(admitted, full=True)
    require(admitted['executable'] == '/usr/bin/bwrap' and all(admitted[key] == origin[key] for key in K.CONTINUITY_FIELDS)
            and type(system) is dict and set(system) == {'path', 'image', 'kernelImageSha256', 'protectedRootOwned'}
            and system['path'] == '/usr/bin/bwrap' and system['protectedRootOwned'] is True
            and system['image'] == admitted['image'] and system['kernelImageSha256'] == admitted['kernelImageSha256'],
            "Protected post-exec system image provenance differs")
    strokes = [(modifiers, pressed) for _, modifiers in K.SEQUENCES[sequence] for pressed in (True, False)]
    rows = receipt['delivery']
    require(type(rows) is list and 0 < len(rows) <= len(strokes) and type(receipt['deliveryComplete']) is bool,
            "Empty or unbounded keyboard delivery is unknown")
    for index, row in enumerate(rows):
        require(type(row) is dict and set(row) == {'keycode', 'modifiers', 'pressed', 'submissionAttempted', 'returnObserved', 'submitted', 'synchronized'}
                and type(row['keycode']) is int and 8 <= row['keycode'] <= 255 and type(row['modifiers']) is int
                and (row['modifiers'], row['pressed']) == strokes[index]
                and all(type(row[key]) is bool for key in ('pressed', 'submissionAttempted', 'returnObserved', 'submitted', 'synchronized')),
                "Malformed keyboard delivery prefix")
        require(index % 2 == 0 or row['keycode'] == rows[index - 1]['keycode'], "Key release differs from its key press")
    synchronized = all(all(row[key] is True for key in ('submissionAttempted', 'returnObserved', 'submitted', 'synchronized')) for row in rows)
    if receipt['deliveryComplete'] is True:
        require(len(rows) == len(strokes) and synchronized and 'refusal' not in receipt, "Complete keyboard delivery not proven")
        return 'complete'
    if warm_companion is not None and sequence == 'Enter' and warm_terminal is not None:
        require(len(rows) == 2 and all(rows[0][k] is True for k in ('submissionAttempted', 'returnObserved', 'submitted', 'synchronized'))
                and all(rows[1][k] is True for k in ('submissionAttempted', 'returnObserved', 'submitted'))
                and rows[1]['synchronized'] is False and receipt.get('refusal') == 'Owned X resource query was refused',
                'Only the observed warm Enter release may be a consumed-terminal candidate')
        warm_release_error(warm_terminal, rows, window)
        return 'warm-consumed-terminal-candidate'
    require(sequence in ('Escape', 'Enter') and len(rows) == 1 and synchronized
            and type(receipt.get('refusal')) is str and 0 < len(receipt['refusal']) <= 256,
            "Incomplete keyboard delivery is unknown; no retry")
    return 'terminal-press-pending-owned-exit'


def warm_release_error(value, rows, window):
    require(type(value) is dict and set(value) == {'schemaVersion', 'kind', 'readOnly', 'inputPermitted', 'authorityGranted',
            'releaseReady', 'latchSet', 'events', 'truncated', 'captureUnavailable', 'submissions', 'submissionCaptureUnavailable'}
            and type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['kind'] == 'x11-keyboard-refusal'
            and value['readOnly'] is True and value['latchSet'] is True
            and all(value[k] is False for k in ('inputPermitted', 'authorityGranted', 'releaseReady', 'truncated',
                                               'captureUnavailable', 'submissionCaptureUnavailable')),
            'One complete retained X error diagnostic required')
    events, submissions = value['events'], value['submissions']
    require(type(events) is list and len(events) == 1 and type(submissions) is list and len(submissions) == 2,
            'No extra X errors or submissions allowed')
    for index, row in enumerate(submissions):
        require(type(row) is dict and set(row) == {'window', 'keycode', 'modifiers', 'pressed', 'latchBeforeSubmit', 'nextRequest',
                'latchBeforeSync', 'latchAfterSync', 'syncReturned'}
                and all(type(row[k]) is int for k in ('window', 'keycode', 'modifiers', 'nextRequest'))
                and row['window'] == window and row['keycode'] == rows[index]['keycode'] and row['modifiers'] == 0
                and row['pressed'] is (index == 0) and row['latchBeforeSubmit'] is False and row['latchBeforeSync'] is False
                and row['latchAfterSync'] is (index == 1) and row['syncReturned'] is (index == 0)
                and 0 < row['nextRequest'] < 2**64, 'Exact clean-latch Enter submission operands required')
    require(submissions[0]['nextRequest'] < submissions[1]['nextRequest'], 'Release request serial must follow press')
    event = events[0]
    require(type(event) is dict and set(event) == {'errorCode', 'requestCode', 'minorCode', 'serial', 'resourceId', 'sameDisplay', 'stage'}
            and all(type(event[k]) is int for k in ('errorCode', 'requestCode', 'minorCode', 'serial', 'resourceId'))
            and (event['errorCode'], event['requestCode'], event['minorCode']) == (3, 25, 0)
            and event['serial'] == submissions[1]['nextRequest'] and event['resourceId'] == window
            and event['sameDisplay'] is True and event['stage'] == 'release-sync',
            'Only the exact release SendEvent BadWindow is a candidate; delivery remains incomplete')


def attributed_warm_activation(record, client, admitted, owner, *, association_validator=None):
    require(type(record) is dict and not any(k in record for k in ('unavailable', 'captureUnavailable')),
            'Warm activation capture unavailable')
    value = record.get('observation')
    require(type(value) is dict and all(value.get(k) is True for k in ('readOnly', 'armed', 'inputStarted', 'workerStopped',
            'busIdentityMatched', 'closed', 'callReplyMatched'))
            and all(value.get(k) is False for k in ('qualified', 'inputPermitted', 'authorityGranted', 'releaseReady', 'deadlineExceeded'))
            and not any(k in value for k in ('unknown', 'unavailable', 'drainUnavailable'))
            and type(value.get('messageCount')) is int and value['messageCount'] == 2,
            'Exact completed passive observation required; exit zero is not activation evidence')
    call, reply, sender = value.get('call'), value.get('reply'), value.get('senderObservation')
    require(type(call) is dict and set(call) == {'kind', 'sender', 'destination', 'serial', 'replySerial', 'flags', 'empty', 'path', 'interface', 'member'}
            and type(reply) is dict and set(reply) == {'kind', 'sender', 'destination', 'serial', 'replySerial', 'flags', 'empty'}
            and all(type(row[k]) is int for row in (call, reply) for k in ('kind', 'serial', 'replySerial', 'flags'))
            and call['kind'] == 1 and call['flags'] == call['replySerial'] == 0 and call['empty'] is True
            and type(call['sender']) is str and re.fullmatch(r':[0-9]+\.[0-9]+', call['sender'])
            and call['sender'] != owner['name'] and call['destination'] in (NAME, owner['name'])
            and (call['path'], call['interface'], call['member']) == ('/com/creatorworks/hub/Host', 'com.creatorworks.hub.Host1', 'Start')
            and 0 < call['serial'] < 2**32 and 0 < reply['serial'] < 2**32
            and reply['kind'] == 2 and reply['flags'] == 1 and reply['empty'] is True
            and reply['sender'] == owner['name'] and reply['destination'] == call['sender'] and reply['replySerial'] == call['serial']
            and value.get('observedHeaders') == [call, reply], 'Exact empty Host1 Start and successful matched reply required')
    require(type(sender) is dict and sender.get('qualified') is False and sender.get('inputPermitted') is False
            and all(sender.get(k) is True for k in ('stable', 'sealedBeforeInput', 'correlatesToOriginalPopen'))
            and not any(k in sender for k in ('unavailable', 'failureStage'))
            and sender.get('originalPopen') == proxy_process_snapshot(admitted)
            and sender.get('expectedClient') == proxy_process_snapshot(client), 'Live sender must match the sealed owned launch')
    peer, ancestry = sender.get('peer'), sender.get('senderAncestors')
    require(type(peer) is dict and set(peer) == {'name', 'pid', 'uid'} and peer['name'] == call['sender']
            and type(peer['pid']) is int and peer['pid'] > 1 and type(peer['uid']) is int and peer['uid'] == client['uids'][0]
            and type(ancestry) is list and 0 < len(ancestry) <= 12 and ancestry[0]['pid'] == peer['pid'],
            'No name-only or UID-only sender attribution')
    if 'externalAssociation' in sender:
        association = sender['externalAssociation']
        require(type(association) is dict and association.get('complete') is True
                and association.get('uid') == peer['uid'] == 1001
                and association.get('original') == admitted and association.get('client') == client
                and proxy_process_snapshot(association['proxy']) == ancestry[0]
                and association['proxy']['pid'] == peer['pid'] and len(ancestry) == 1
                and sender.get('clientAncestors') == [proxy_process_snapshot(r) for r in association['tree']],
                'External proxy must match the complete pre-input instance/pipe snapshot, not fabricated ancestry')
        # Admission already validated and held this exact snapshot before input.
        # Repeat the closed wire contract here before any terminal acceptance.
        require(callable(association_validator), 'The independently bound association validator is required')
        association_validator(association, admitted, client, association['tree'])
    else:
        require(1 < len(ancestry) and ancestry[-1] == proxy_process_snapshot(admitted),
                'No name-only or UID-only sender attribution')


ROOT_WORKERS_UNKNOWN = []


def mixed_worker_diagnostic(value):
    def check(test): require(test, 'Typed post-failure mixed diagnostic required')
    check(type(value) is dict and set(value) == {'readOnly', 'inputPermitted', 'authorityGranted', 'releaseReady',
        'subjectPid', 'observedUids', 'heldMembership', 'heldKind', 'caller', 'heldChain', 'postFailure'}
        and value['readOnly'] is True and all(value[k] is False for k in ('inputPermitted', 'authorityGranted', 'releaseReady'))
        and (value['subjectPid'] is None or type(value['subjectPid']) is int and 1 < value['subjectPid'] < 2**31)
        and (value['observedUids'] is None or type(value['observedUids']) is list and len(value['observedUids']) == 4
            and all(type(uid) is int and 0 <= uid < 2**32 for uid in value['observedUids']))
        and (value['heldMembership'] is None or type(value['heldMembership']) is bool)
        and value['heldKind'] in (None, 'python', 'sudo', 'other')
        and type(value['heldChain']) is list and len(value['heldChain']) <= 5)
    def identity(row):
        check(type(row) is dict and set(row) == {'pid', 'parentPid', 'startTime', 'uids', 'state', 'heldKind'}
            and type(row['pid']) is int and 1 < row['pid'] < 2**31
            and (row['parentPid'] is None or type(row['parentPid']) is int and 0 <= row['parentPid'] < 2**31)
            and (row['startTime'] is None or type(row['startTime']) is str and re.fullmatch(r'[0-9]{1,20}', row['startTime']))
            and (row['uids'] is None or type(row['uids']) is list and len(row['uids']) == 4
                and all(type(uid) is int and 0 <= uid < 2**32 for uid in row['uids']))
            and row['state'] in (None, 'R', 'S', 'D', 'Z', 'X', 'x', 'T', 't', 'K', 'W', 'P', 'I', 'other')
            and row['heldKind'] in (None, 'python', 'sudo', 'other'))
    identity(value['caller'])
    for row in value['heldChain']: identity(row)
    check(len({row['pid'] for row in value['heldChain']}) == len(value['heldChain']))
    post = value['postFailure']
    check(type(post) is dict and set(post) == {'postFailureReadOnly', 'classification', 'stage', 'unavailable',
        'before', 'after', 'procIdentity', 'kernelImage', 'fixedSudoImage', 'fixedSudoSha256', 'live', 'cleanupConfirmed'}
        and post['postFailureReadOnly'] is True and post['classification'] in ('verifiedsudo', 'other', 'unavailable')
        and post['stage'] in ('root-worker-only', 'budget', 'pidfd', 'proc-directory', 'identity-before',
            'fixed-sudo-image', 'kernel-image', 'identity-after', 'stability', 'complete', 'cleanup')
        and post['unavailable'] in (None, 'ValueError', 'KeyError', 'TypeError', 'RuntimeError', 'PermissionError',
            'FileNotFoundError', 'ProcessLookupError', 'OSError', 'OtherError')
        and (post['live'] is None or type(post['live']) is bool) and type(post['cleanupConfirmed']) is bool
        and (post['fixedSudoSha256'] is None or type(post['fixedSudoSha256']) is str
            and re.fullmatch(r'[a-f0-9]{64}', post['fixedSudoSha256'])))
    for key in ('before', 'after'):
        if post[key] is not None: identity(post[key])
    for key in ('procIdentity', 'kernelImage', 'fixedSudoImage'):
        check(post[key] is None or type(post[key]) is list and len(post[key]) == 9
            and all(type(n) is int and 0 <= n < 2**64 for n in post[key]))
    check(post['classification'] == 'unavailable' or post['stage'] == 'complete' and post['unavailable'] is None
        and post['live'] is True and post['cleanupConfirmed'] is True and post['before'] == post['after']
        and post['before'] is not None and post['procIdentity'] is not None and post['kernelImage'] is not None
        and post['fixedSudoImage'] is not None and post['fixedSudoSha256'] is not None
        and post['before']['pid'] == value['subjectPid'] and post['before']['uids'] == value['observedUids']
        and ((post['kernelImage'] == post['fixedSudoImage']) == (post['classification'] == 'verifiedsudo')))
    check(len(json_bytes(value)) <= 6144)
    return copy.deepcopy(value)


def foreign_worker_diagnostic(value):
    def check(test): require(test, 'Typed cached foreign observation diagnostic required')
    check(type(value) is dict and set(value) == {'readOnly', 'inputPermitted', 'authorityGranted', 'releaseReady',
        'function', 'stage', 'line', 'subject', 'limit', 'heldCount', 'invocationMember', 'foreignMember',
        'checks', 'stamps', 'protectedSha256', 'clock', 'cleanupConfirmed'}
        and value['readOnly'] is True and all(value[k] is False for k in ('inputPermitted', 'authorityGranted', 'releaseReady'))
        and value['function'] in ('ForeignSudoObservations.observe', 'ForeignSudoObservations.identity',
            'ForeignSudoObservations.recheck', 'ForeignSudoObservations.close', 'InvocationImage.__init__',
            'InvocationImage.directory', 'InvocationImage.check', 'InvocationImage.snapshot', 'InvocationImage.close',
            'ProxyAssociationProc.read_at', 'inventory_probe', 'association_snapshot', 'association_snapshot_held',
            'inventory_probe.budget', 'association_snapshot.budget', 'association_snapshot_held.budget')
        and value['stage'] in ('budget-before', 'budget-after', 'admission', 'cap', 'pidfd-open', 'pidfd-live',
            'proc-open', 'proc-type', 'identity', 'recheck', 'live-before', 'proc-before', 'stat-read', 'status-read',
            'process-parse', 'process-shape', 'kernel-identity', 'image-before', 'image-after', 'row-recheck', 'close',
            'protected-image', 'kernel-open', 'image-kind', 'image-alias', 'image-path', 'image-directory',
            'image-open', 'image-snapshot', 'image-budget', 'image-file', 'image-read', 'image-eof', 'image-hash', 'image-close')
        and type(value['line']) is int and 0 < value['line'] < 100000
        and type(value['limit']) is int and value['limit'] == 4
        and (value['heldCount'] is None or type(value['heldCount']) is int and 0 <= value['heldCount'] <= 4)
        and all(value[k] is None or type(value[k]) is bool for k in ('invocationMember', 'foreignMember', 'cleanupConfirmed')))
    subject = value['subject']
    check(type(subject) is dict and set(subject) == {'pid', 'parentPid', 'startTime', 'uids', 'state', 'executableKind', 'executablePathSha256'}
        and (subject['pid'] is None or type(subject['pid']) is int and 1 < subject['pid'] < 2**31)
        and (subject['parentPid'] is None or type(subject['parentPid']) is int and 0 <= subject['parentPid'] < 2**31)
        and (subject['startTime'] is None or type(subject['startTime']) is str and re.fullmatch(r'[0-9]{1,20}', subject['startTime']))
        and (subject['uids'] is None or type(subject['uids']) is list and len(subject['uids']) == 4
             and all(type(uid) is int and 0 <= uid < 2**32 for uid in subject['uids']))
        and subject['state'] in (None, 'R', 'S', 'D', 'Z', 'X', 'x', 'T', 't', 'K', 'W', 'P', 'I', 'other')
        and subject['executableKind'] in ('unread', 'sudo', 'python', 'bwrap', 'proxy', 'launcher', 'other'))
    for digest in (subject['executablePathSha256'], value['protectedSha256']):
        check(digest is None or type(digest) is str and re.fullmatch(r'[a-f0-9]{64}', digest))
    check(type(value['checks']) is dict and set(value['checks']) <= {'open', 'pid_type', 'pid_range', 'unheld_invocation',
        'uid_type', 'uid_count', 'uid_integers', 'uid_tuple', 'live_open', 'live_before', 'pid_prefix', 'tail',
        'parent', 'start', 'uids', 'state', 'executable_match', 'live_after', 'row_match'}
        and all(type(item) is bool for item in value['checks'].values())
        and type(value['stamps']) is dict and set(value['stamps']) == {'procExpected', 'procHeldBefore', 'procNamedBefore',
            'procHeldAfter', 'procNamedAfter', 'kernelHeld', 'kernelNamed', 'protectedImage', 'protectedAlias',
            'aliasObserved', 'protectedNamed', 'parentHeld', 'parentNamed', 'fileObserved'})
    for stamp in value['stamps'].values():
        check(stamp is None or type(stamp) is list and len(stamp) in (5, 9)
            and all(type(n) is int and 0 <= n < 2**64 for n in stamp))
    check(type(value['clock']) is dict and set(value['clock']) == {'nowNs', 'expiresNs'}
        and all(n is None or type(n) is int and 0 <= n < 2**64 for n in value['clock'].values())
        and len(json_bytes(value)) <= 8192)
    return copy.deepcopy(value)


def root_worker_refusal(answer):
    error = RuntimeError('Complete protected root snapshot unavailable; no input')
    if type(answer) is dict and answer.get('ok') is False and set(answer) <= {'ok', 'unavailable', 'stage', 'pid', 'probeCaller', 'inventoryFailure', 'mixedFailure', 'foreignFailure'}:
        value = dict(readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False)
        if answer.get('unavailable') in ('ValueError', 'KeyError', 'TypeError', 'RuntimeError', 'PermissionError',
                                        'FileNotFoundError', 'ProcessLookupError', 'OSError'):
            value['type'] = answer['unavailable']
        if answer.get('stage') in ('root-entry', 'complete-uid-inventory', 'held-process-identities',
            'private-instance-and-pipes', 'unique-associated-proxy', 'complete-association-recheck',
            'probe-caller-chain', 'probe-recheck'):
            value['stage'] = answer['stage']
        if type(answer.get('pid')) is int and 1 < answer['pid'] < 2**31:
            value['pid'] = answer['pid']
        detail = answer.get('probeCaller')
        try:
            require(type(detail) is dict and set(detail) == {'predicate', 'hops'} and len(json_bytes(detail)) <= 4096
                    and detail['predicate'] in ('hop-read', 'hop-process-shape', 'hop-credentials', 'hop-executable',
                        'caller-read', 'caller-identity', 'caller-pidfd-live', 'chain-limit')
                    and type(detail['hops']) is list and 0 < len(detail['hops']) <= 5, 'Typed caller diagnostics required')
            for hop in detail['hops']:
                require(type(hop) is dict and set(hop) == {'pid', 'parentPid', 'startTime', 'uids', 'state', 'expectedKind', 'executableKind'}
                        and type(hop['pid']) is int and 1 < hop['pid'] < 2**31
                        and (hop['parentPid'] is None or type(hop['parentPid']) is int and 0 <= hop['parentPid'] < 2**31)
                        and (hop['startTime'] is None or type(hop['startTime']) is str and re.fullmatch(r'[0-9]{1,20}', hop['startTime']))
                        and (hop['uids'] is None or type(hop['uids']) is list and len(hop['uids']) == 4
                             and all(type(uid) is int and 0 <= uid < 2**32 for uid in hop['uids']))
                        and hop['state'] in (None, 'R', 'S', 'D', 'Z', 'X', 'x', 'T', 't', 'K', 'W', 'P', 'I', 'other')
                        and hop['expectedKind'] in ('python', 'sudo') and hop['executableKind'] in ('python', 'sudo', 'other', 'unread'),
                        'Bounded caller hop required')
            value['probeCaller'] = copy.deepcopy(detail)
        except Exception:
            pass
        detail = answer.get('inventoryFailure')
        try:
            require(type(detail) is dict and set(detail) == {'readOnly', 'inputPermitted', 'authorityGranted', 'releaseReady',
                'phase', 'scan', 'entryPid', 'entryUids', 'function', 'predicate', 'field', 'line', 'subject'}
                and detail['readOnly'] is True and all(detail[k] is False for k in ('inputPermitted', 'authorityGranted', 'releaseReady'))
                and detail['phase'] == 'complete-uid-inventory' and type(detail['scan']) is int and detail['scan'] in (1, 2)
                and (detail['entryPid'] is None or type(detail['entryPid']) is int and 1 < detail['entryPid'] < 2**31)
                and detail['function'] in ('ProxyAssociationProc.read_at', 'root_process', 'root_process.identity', 'root_uid_tuple',
                    'complete_uid_inventory', 'complete_uid_inventory.scan', 'InvocationChain.identity', 'InvocationChain.recheck',
                    'InvocationChain.mixed_process', 'InvocationImage.check', 'InvocationImage.snapshot', 'inventory_probe.budget',
                    'association_snapshot_held.budget')
                and detail['predicate'] in ('proc-read', 'uid-record', 'uid-range', 'process-read', 'process-shape', 'process-uids',
                    'executable-read', 'executable-shape', 'process-stability', 'image-read', 'image-identity', 'image-bytes',
                    'invocation-recheck', 'invocation-identity', 'mixed-membership', 'mixed-identity', 'scan-open', 'scan-budget',
                    'entry-directory', 'uid-read', 'mixed-invocation', 'proxy-count', 'scan-equality', 'deadline')
                and detail['field'] in ('stat', 'status', 'exe', 'proc', 'invocation', 'inventory', 'clock', 'unavailable')
                and type(detail['line']) is int and 0 < detail['line'] < 100000, 'Typed inventory failure required')
            for ids in (detail['entryUids'], detail['subject']['uids'] if type(detail['subject']) is dict else None):
                require(ids is None or type(ids) is list and len(ids) == 4
                    and all(type(uid) is int and 0 <= uid < 2**32 for uid in ids), 'Numeric observed UIDs required')
            subject = detail['subject']
            require(subject is None or type(subject) is dict
                and set(subject) == {'pid', 'parentPid', 'startTime', 'uids', 'state', 'executableKind'}
                and type(subject['pid']) is int and 1 < subject['pid'] < 2**31
                and (subject['parentPid'] is None or type(subject['parentPid']) is int and 0 <= subject['parentPid'] < 2**31)
                and (subject['startTime'] is None or type(subject['startTime']) is str and re.fullmatch(r'[0-9]{1,20}', subject['startTime']))
                and subject['state'] in (None, 'R', 'S', 'D', 'Z', 'X', 'x', 'T', 't', 'K', 'W', 'P', 'I', 'other')
                and subject['executableKind'] in ('unread', 'other', 'python', 'sudo', 'bwrap', 'proxy', 'launcher'),
                'Bounded observed process required')
            require(len(json_bytes(detail)) <= 2048, 'Bounded inventory failure required')
            value['inventoryFailure'] = copy.deepcopy(detail)
        except Exception:
            pass
        try:
            value['mixedFailure'] = mixed_worker_diagnostic(answer.get('mixedFailure'))
        except Exception:
            pass
        try:
            value['foreignFailure'] = foreign_worker_diagnostic(answer.get('foreignFailure'))
        except Exception:
            pass
        error.root_proxy_diagnostic = value
    return error


def root_exchange(tool, operation, raw, deadline):
    """Bounded pipe exchange; never signal a privileged child or wait without a deadline."""
    require(operation in ('root-proxy-snapshot', 'root-inventory-probe') and 0 < len(raw) <= 32768
            and time.monotonic() < deadline <= time.monotonic() + 6, 'Finite protected worker exchange required')
    child = subprocess.Popen(['/usr/bin/sudo', '-n', '--', '/usr/bin/python3', '-I', '-S', '-B',
                              str(tool), operation], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        bufsize=0, close_fds=True, start_new_session=True,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
    streams = (child.stdin, child.stdout, child.stderr)
    buffers, eof, offset, failure = [bytearray(), bytearray()], [False, False], 0, None
    def pump(until, writing):
        nonlocal offset
        readers = [stream for i, stream in enumerate(streams[1:]) if not eof[i]]
        writers = [child.stdin] if writing and not child.stdin.closed else []
        ready, writable, _ = select.select(readers, writers, [], max(0, min(.02, until - time.monotonic())))
        if writable:
            try:
                offset += os.write(child.stdin.fileno(), raw[offset:])
            except BlockingIOError:
                pass
            if offset == len(raw):
                child.stdin.close()
        for stream in ready:
            i = 0 if stream is child.stdout else 1
            require(len(buffers[i]) <= (32768 if i == 0 else 2048), 'Protected worker output bound exceeded')
            try:
                chunk = os.read(stream.fileno(), min(4096, (32768 if i == 0 else 2048) + 1 - len(buffers[i])))
            except BlockingIOError:
                continue
            if not chunk:
                eof[i] = True
            else:
                buffers[i].extend(chunk)
                require(len(buffers[i]) <= (32768 if i == 0 else 2048), 'Protected worker output bound exceeded')
    try:
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
        while time.monotonic() < deadline:
            pump(deadline, True)
            if child.poll() is not None and all(eof):
                require(offset == len(raw), 'Complete worker request was not submitted')
                if time.monotonic() >= deadline:
                    raise TimeoutError('Protected worker response reached or exceeded deadline')
                return subprocess.CompletedProcess(child.args, child.returncode, bytes(buffers[0]), bytes(buffers[1]))
        raise TimeoutError('Protected worker exit/EOF not observed within deadline')
    except Exception as error:
        failure = error
        raise
    finally:
        if failure is not None:
            # Closing our input is safe even when sudo cannot be killed by this UID.
            try:
                child.stdin.close()
            except OSError:
                pass
            cleanup_deadline = time.monotonic() + .25
            try:
                while time.monotonic() < cleanup_deadline and (child.poll() is None or not all(eof)):
                    pump(cleanup_deadline, False)
            except Exception:
                pass
            try:
                observed = child.poll() is not None
            except OSError:
                observed = False
            failure.root_proxy_diagnostic = dict(readOnly=True, inputPermitted=False, authorityGranted=False,
                releaseReady=False, stage='root-worker-exchange', exitObserved=observed,
                stdoutEof=eof[0], stderrEof=eof[1], cleanupUnconfirmed=not (observed and all(eof)))
            if not observed:
                ROOT_WORKERS_UNKNOWN.append(child)
        for stream in streams:
            try:
                stream.close()
            except OSError:
                pass


def root_inventory_preflight(root):
    require(os.getuid() == os.geteuid() == 1001 and os.environ.get('EXECUTION_REQUEST') == REQUEST
            and not any(os.environ.get(k) for k in ('DISPLAY', 'WAYLAND_DISPLAY', 'FLATPAK_ID'))
            and not root.exists() and not root.is_symlink(), 'Native-only headless preflight before collection required')
    proof = parse(regular(root.parent / 'native-linux-flatpak-root-source.json', 32768, 0o600))
    names = ('scripts/native-linux-production-016-flatpak.py', 'scripts/native-linux-production-016-flatpak.test.py',
             'scripts/native-linux-flatpak-activation-observer.py', 'scripts/native-linux-flatpak-activation-observer.test.py',
             'scripts/native-linux-flatpak-dialog-input.py', 'scripts/native-linux-flatpak-dialog-input.test.py',
             'scripts/native-unix-window.py', 'scripts/native-unix-window.test.py')
    require(set(proof) == {'schemaVersion', 'profile', 'harnessSource', 'harnessFiles', *GATES}
            and type(proof['schemaVersion']) is int and proof['schemaVersion'] == 1 and proof['profile'] == PROFILE
            and proof['harnessSource'] == os.environ.get('GITHUB_SHA')
            and re.fullmatch(r'[a-f0-9]{40}', proof['harnessSource'])
            and set(proof['harnessFiles']) == set(names) and all(proof[k] is False for k in GATES),
            'Independent exact eight-file current-source binding required before sudo')
    sources = {name: bound(HERE.parent / name, proof['harnessFiles'][name], 1024 * 1024) for name in names}
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('flatpak_root_preflight', loader=None))
    module.__file__ = str(HERE.parent / names[2])
    exec(compile(sources[names[2]], module.__file__, 'exec'), module.__dict__)
    code = proof['harnessFiles'][names[2]]['sha256']
    report = dict(schemaVersion=1, profile=PROFILE, harnessSource=proof['harnessSource'], readOnly=True,
                  inputPermitted=False, authorityGranted=False, inventoryProbed=False, **GATES)
    failure = None
    try:
        module.protected_tool(code)
        caller = module.root_process(os.getpid())
        request = dict(schemaVersion=1, operation=module.PROBE_OPERATION, harnessSource=proof['harnessSource'],
                       codeSha256=code, sequence=1, nonce=secrets.token_hex(32),
                       expiresNs=time.monotonic_ns() + 4 * 10**9, caller=caller)
        module.probe_request(request, time.monotonic_ns())
        result = root_exchange(module.PROXY_TOOL, 'root-inventory-probe', json_bytes(request), request['expiresNs'] / 10**9)
        answer = parse(result.stdout)
        if result.returncode != 0 or result.stderr:
            raise root_worker_refusal(answer)
        require(set(answer) == {'request', 'ok', 'snapshot'}
                and answer['request'] == request and answer['ok'] is True, 'Complete root inventory probe required')
        module.validate_probe(answer['snapshot'], request)
        module.protected_tool(code)
        require(time.monotonic_ns() < request['expiresNs'], 'Root inventory probe expired')
        report.update(inventoryProbed=True, inventory=answer['snapshot'])
    except Exception as error:
        failure = error
        report['unavailable'] = type(error).__name__
        if hasattr(error, 'root_proxy_diagnostic'):
            report['workerCleanup'] = error.root_proxy_diagnostic
        raise
    finally:
        try:
            output(root.parent / 'native-linux-flatpak-root-preflight.json', json_bytes(report))
        except Exception as error:
            if failure is None:
                raise
            failure.root_preflight_receipt_error = type(error).__name__


class RootProxySnapshot:
    def __init__(self, module, root, harness, code_sha256, original, client, capture, commits):
        require(os.getuid() == os.geteuid() == 1001 and root / 'runtime' == module.PROXY_RUNTIME
                and re.fullmatch(r'[a-f0-9]{40}', harness) and re.fullmatch(r'[a-f0-9]{64}', code_sha256),
                'Only the fixed hosted UID1001 Flatpak fixture may request this read-only snapshot')
        require(type(commits) is dict and set(commits) == {'appCommit', 'runtimeCommit'}
                and all(re.fullmatch(r'[a-f0-9]{64}', v) for v in commits.values()), 'Exact installed app/runtime commits required')
        self.module, self.harness, self.code, self.original, self.client = module, harness, code_sha256, original, client
        self.capture, self.sequence, self.nonces, self.blocked = capture, 1, set(), False
        self.commits = dict(commits)

    def __call__(self, tree):
        require(not self.blocked, 'Unknown root snapshot cannot be retried')
        self.blocked = True
        self.capture.budget()
        self.module.protected_tool(self.code)
        nonce = secrets.token_hex(32)
        require(nonce not in self.nonces and self.sequence <= 3, 'Fresh bounded root snapshot sequence required')
        self.nonces.add(nonce)
        request = dict(schemaVersion=1, operation='flatpak-proxy-snapshot-uid1001', harnessSource=self.harness,
                       codeSha256=self.code, sequence=self.sequence, nonce=nonce,
                       expiresNs=min(int(self.capture.transcript.deadline * 10**9), time.monotonic_ns() + 4 * 10**9),
                       original=self.original, client=self.client, tree=tree, caller=self.module.root_process(os.getpid()))
        self.module.root_request(request, time.monotonic_ns())
        raw = json_bytes(request); require(len(raw) <= 32768, 'Root snapshot request bound')
        result = root_exchange(self.module.PROXY_TOOL, 'root-proxy-snapshot', raw, request['expiresNs'] / 10**9)
        require(0 < len(result.stdout) <= 32768, 'Complete protected root snapshot unavailable; no input')
        answer = parse(result.stdout)
        if result.returncode != 0 or result.stderr:
            raise root_worker_refusal(answer)
        require(set(answer) == {'request', 'ok', 'snapshot'} and answer['request'] == request and answer['ok'] is True,
                'Root snapshot source/nonce/sequence reply differs')
        self.module.validate_association(answer['snapshot'], self.original, self.client, tree)
        require(all(answer['snapshot']['flatpakInfo']['fields'][k] == v for k, v in self.commits.items()),
                'Proxy instance must bind the independently installed app/runtime commits')
        self.capture.budget(); self.module.protected_tool(self.code)
        require(time.monotonic_ns() < request['expiresNs'], 'Root snapshot expired; no input')
        self.sequence += 1; self.blocked = False
        return answer['snapshot']


class ObserverPidfds:
    open = staticmethod(os.pidfd_open) if hasattr(os, 'pidfd_open') else None
    close = staticmethod(os.close)

    @staticmethod
    def ready(fd):
        return bool(select.select([fd], [], [], 0)[0])


class Session:
    def __init__(self, root, review):
        self.root, self.review = root, review
        self.app_env = clean_environment(root)
        self.app_env.update({key: os.environ[key] for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY") if key in os.environ})
        self.helper, self.native = P.helpers()
        self.x11, self.driver = self.helper.X11(), P.Driver()
        self.children, self.captures, self.fds = [], [], []
        self.portal_client = None
        self.flatpak_launch = None
        self.flatpak_popen = None
        self.flatpak_origin, self.flatpak_child, self.launcher_keys, self.portal_calls = None, None, [], None
        self.bootstrap_proxy = None
        self.real_portal = None
        self.report = {"schemaVersion": 1, "profile": PROFILE, "phase": "starting", **GATES}

    def launch(self, args, label, *, env=None, pass_fds=()):
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=self.app_env if env is None else env, **({'pass_fds': pass_fds} if pass_fds else {}))
        self.children.append(child); self.captures.append(self.native.Capture(child, self.root, label))
        return child

    def wait(self, test, seconds=30):
        def check():
            for capture in self.captures:
                capture.pump()
            return test()
        P.wait(check, seconds)

    def process(self, pid, digest):
        result = self.native.native_process(pid, self.helper)
        require(result["uids"] == [os.getuid()] * 4 and result["kernelImageSha256"] == digest, "Kernel client image/UID differs")
        return result

    def stable(self, before):
        require(self.native.native_process(before["pid"], self.helper) == before, "Kernel PID/start/image/UID changed")

    def windows(self):
        value = self.x11.property(self.x11.x.XDefaultRootWindow(self.x11.display), "_NET_CLIENT_LIST_STACKING")
        if value is None:
            return []
        require(value[:2] == (33, 32) and len(value[2]) <= 8 and len(set(value[2])) == len(value[2]), "Bounded window set")
        return value[2]

    def owned_window(self, process, title=None):
        self.stable(process)
        matches = [window for window in self.windows() if self.x11.inspect(window)["pid"] == process["pid"]
                   and (title is None or self.x11.inspect(window)["title"] == title)]
        require(len(matches) == 1, "One kernel-owned native window required")
        window = matches[0]; require(self.x11.inspect(window)["mapped"], "Native window must be visible")
        return window

    def close(self, process, window):
        self.stable(process)
        props = self.x11.inspect(window)
        request = self.helper.Request("snapshot", process["pid"], process["startTime"], process["executable"],
                                      process["kernelImageSha256"], window, props["title"], "FRAME")
        fd = os.pidfd_open(process["pid"]); self.fds.append(fd)
        self.x11.close_window(window, self.helper.bound_window(request, self.x11))
        self.wait(lambda: bool(select.select([fd], [], [], 0)[0]) and not Path(f'/proc/{process["pid"]}').exists())

    def proxy_attribution(self, client, peer):
        result = {'readOnly': True, 'stable': False, 'inputPermitted': False, 'qualified': False, 'peerPairingProven': False}
        result['proofProgress'] = dict.fromkeys(('currentLaunchRecorded', 'clientStable', 'currentLaunchMatchesExpected',
            'subtreeCaptured', 'subtreeContainsClientAndPeer', 'proxyImageMatched', 'subtreeRechecked', 'finalIdentitiesRechecked'), False)
        stage = 'expected-launch'
        try:
            launch = self.flatpak_launch
            require(launch is not None and peer['uid'] == os.getuid(), 'Owned Flatpak launch diagnostic only')
            result['expectedLaunch'] = proxy_process_snapshot(launch)
            popen = self.flatpak_popen
            require(type(popen) is dict and set(popen) == {'pid', 'startTime'} and popen['pid'] == launch['pid']
                    and type(popen['pid']) is int and 1 < popen['pid'] <= 2147483647
                    and type(popen['startTime']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', popen['startTime']), 'Independent owned Popen tuple required')
            result['popenIdentity'] = {**popen, 'verified': False}
            stage = 'current-launch'
            observed = self.native.native_process(popen['pid'], self.helper, False)
            require(observed['uids'] == [os.getuid()] * 4 and 0 < int(observed['image']['st_size']) <= 64 * 1024 * 1024,
                    'Bounded same-user current launch diagnostic')
            current = self.native.native_process(popen['pid'], self.helper)
            result['currentLaunch'] = proxy_process_snapshot(current)
            require({key: value for key, value in current.items() if key != 'kernelImageSha256'} == observed,
                    'Current launch changed during diagnostic image capture')
            result['proofProgress']['currentLaunchRecorded'] = True
            stage = 'client-identity'
            self.stable(client)
            result['proofProgress']['clientStable'] = True
            stage = 'launch-identity'
            require(self.native.native_process(launch['pid'], self.helper, False) == launch, 'Diagnostic launch changed')
            require(current['pid'] == popen['pid'] and current['startTime'] == popen['startTime']
                    and observed == launch, 'Current diagnostic launch differs from recorded Popen/launch tuple')
            result['proofProgress']['currentLaunchMatchesExpected'] = True
            stage = 'subtree'
            tree = P.subtree(launch['pid'], self.helper, self.native)
            result['proofProgress']['subtreeCaptured'] = True
            stage = 'subtree-membership'
            require(len(tree) <= 16 and client['pid'] in tree and peer['pid'] in tree, 'AX peer outside bounded owned launch')
            result['proofProgress']['subtreeContainsClientAndPeer'] = True
            stage = 'proxy-identity'
            require(tree[peer['pid']]['executable'] == '/usr/bin/xdg-dbus-proxy', 'Only owned proxy diagnostic')
            proxy = self.native.native_process(peer['pid'], self.helper)
            require(0 < int(proxy['image']['st_size']) <= 64 * 1024 * 1024
                    and {k: v for k, v in proxy.items() if k != 'kernelImageSha256'} == tree[peer['pid']], 'Diagnostic proxy identity changed')
            result['proofProgress']['proxyImageMatched'] = True
            stage = 'subtree-records'
            rows = [proxy_process_snapshot(row) for row in sorted(tree.values(), key=lambda r: r['pid'])]
            result.update(launch={'pid': launch['pid'], 'startTime': launch['startTime']}, peer=peer, subtree=rows, processes=[])
            for process in (client, proxy):
                stage = 'client-io' if process is client else 'proxy-io'
                result['processes'].append({'pid': process['pid'], 'kernelImageSha256': process['kernelImageSha256'],
                                           **proxy_process_io(process['pid'], str(self.root / 'runtime'), os.getuid())})
            stage = 'subtree-recheck'
            require(P.subtree(launch['pid'], self.helper, self.native) == tree, 'Diagnostic launch topology changed')
            result['proofProgress']['subtreeRechecked'] = True
            stage = 'final-identities'
            self.stable(client); self.stable(proxy)
            require(self.native.native_process(launch['pid'], self.helper, False) == launch, 'Diagnostic launch identity changed')
            result['proofProgress']['finalIdentitiesRechecked'] = True
            stage = 'output-bound'
            require(len(json_bytes(result)) <= 65536, 'Bounded proxy attribution output')
            result['stable'] = True
        except Exception as error:
            result['failureStage'] = stage
            result['unavailable'] = type(error).__name__ if type(error) in (
                RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, ValueError, KeyError, TypeError, OSError) else 'OtherError'
        if len(json_bytes(result)) > 65536:
            return {key: value for key, value in {**result, 'stable': False, 'unavailable': 'OutputLimit'}.items()
                    if key in ('readOnly', 'stable', 'inputPermitted', 'qualified', 'peerPairingProven', 'unavailable',
                               'failureStage', 'proofProgress', 'popenIdentity', 'expectedLaunch', 'currentLaunch')}
        return result

    def click_dialog(self, process, labels, buttons, action, phase, title="Creator Hub"):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.init(); Atspi.set_timeout(1500, 1500)
        refs, bus = self.native.native_ax_references()
        nodes, rows, aliases = [], [], {}
        before = self.native.native_process(process["pid"], self.helper)
        ids = namespace_ids(Path(f'/proc/{process["pid"]}/status').read_bytes(), process["pid"])
        def wire(node):
            name, pathname = node.app.bus_name, node.path
            require(type(name) is str and re.fullmatch(r"(?::[0-9]+\.[0-9]+|org\.[A-Za-z0-9_.-]+)", name)
                    and len(name) <= 255 and type(pathname) is str and len(pathname) <= 256
                    and re.fullmatch(r"/org/a11y/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+", pathname), "AX wire reference")
            peer = refs.resolve(name)
            ax_identity(peer, node.get_process_id(), process, ids, os.getuid())
            require(name not in aliases or aliases[name] == peer, "AX unique owner changed")
            aliases[name] = peer; require(len(aliases) <= 4, "AX alias bound")
            return peer["owner"], pathname
        diagnostic = {"phase": phase, "client": before, "namespacePids": ids, "actionAttempted": False, "actionReturned": False}
        try:
            diagnostic["unadmittedPeers"] = []
            dialogs = []
            def ready():
                nonlocal dialogs
                self.stable(process)
                apps = self.helper.children(Atspi.get_desktop(0), 32)
                diagnostic["applications"] = [{"pid": app.get_process_id(), "name": (app.get_name() or "")[:128]} for app in apps]
                dialogs = []
                for app in apps:
                    try:
                        app.clear_cache(); wire(app)
                    except RuntimeError:
                        if len(diagnostic["unadmittedPeers"]) < 8:
                            try:
                                peer = refs.resolve(app.app.bus_name)
                                require(peer["uid"] == os.getuid() and self.native.process_uids(peer["pid"]) == [os.getuid()] * 4,
                                        "Only same-user AX diagnostic")
                                record = self.native.native_process(peer["pid"], self.helper, False)
                                require(0 < int(record["image"]["st_size"]) <= 64 * 1024 * 1024, "Bounded diagnostic image")
                                diagnostic["unadmittedPeers"].append({"wire": peer, "reportedPid": app.get_process_id(),
                                    "kernel": self.native.native_process(peer["pid"], self.helper), "inputPermitted": False})
                                if process['executable'] == '/app/bin/creator-hub-flatpak-activate' and 'proxyAttribution' not in diagnostic:
                                    diagnostic['proxyAttribution'] = self.proxy_attribution(process, peer)
                            except Exception as error:
                                diagnostic["unadmittedPeers"].append({"error": str(error)[:240], "inputPermitted": False})
                        continue
                    dialogs.extend(child for child in self.helper.children(app, 4) if child.get_role_name() in ("alert", "dialog"))
                require(len(dialogs) <= 1, "Ambiguous native dialog; no input permitted")
                return len(dialogs) == 1
            self.wait(ready, 15)  # Readiness only; the native mutation below is never retried.
            pending, seen, deadline = [(dialogs[0], 0)], set(), time.monotonic() + 15
            while pending:
                node, depth = pending.pop(); require(depth < 8 and len(nodes) < 48 and time.monotonic() < deadline, "Native tree bound")
                node.clear_cache(); identity = wire(node); require(identity not in seen, "Repeated AX object"); seen.add(identity)
                name = node.get_name() or ""; require(len(name) <= 4096, "Native label bound")
                state = node.get_state_set()
                rows.append({"role": node.get_role_name(), "name": name, "showing": state.contains(Atspi.StateType.SHOWING),
                             "enabled": state.contains(Atspi.StateType.ENABLED) and state.contains(Atspi.StateType.SENSITIVE)})
                nodes.append(node); pending.extend((child, depth + 1) for child in reversed(self.helper.children(node, 16)))
            window = self.owned_window(process, title)
            rectangle = nodes[0].get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            require((rectangle.x, rectangle.y, rectangle.width, rectangle.height) == self.x11.frame_rectangle(window), "AX/native dialog frame differs")
            target = nodes[dialog_target(rows, labels, buttons, action)]
            interface = target.get_action_iface()
            require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click", "Unexpected GTK action")
            self.stable(process); wire(target)
            for name, peer in aliases.items():
                require(refs.resolve(name) == peer, "AX peer changed before action")
            diagnostic["actionAttempted"] = True; diagnostic["actionReturned"] = interface.do_action(0) is True
            require(diagnostic["actionReturned"], "GTK action outcome unknown; no retry")
        finally:
            diagnostic["rows"] = rows; save(self.root / (phase + "-gtk.json"), diagnostic); bus.close_sync(None)

    def flatpak_guard(self):
        child, origin = self.flatpak_child, self.flatpak_origin
        require(child is not None and origin is not None and any(child is owned for owned in self.children)
                and child.pid == origin['pid'] and child.poll() is None, "Original owned Flatpak Popen is no longer live")
        current = self.native.native_process(child.pid, self.helper, False)
        require(all(current[key] == origin[key] for key in K.CONTINUITY_FIELDS)
                and current['uids'] == [os.getuid()] * 4, "Original Flatpak PID/start/parent/UID changed")

    @staticmethod
    def retain_focus_diagnostic(diagnostic, error):
        try:
            value = getattr(error, 'focus_diagnostic', None)
            require(type(value) is dict and value.get('readOnly') is True and value.get('inputPermitted') is False
                    and value.get('authorityGranted') is False and value.get('releaseReady') is False,
                    'Only read-only focus diagnostics may be retained')
            raw = json_bytes(value)
            require(len(raw) <= 32768, 'Bounded focus diagnostic required')
            diagnostic['focusDiagnostic'] = parse(raw)
        except Exception:
            pass  # Preserve the original refusal even when diagnostics are unavailable.

    def capture_refused_proxy_association(self, module, attempt, client, tree, capture, target_guard):
        return module.proxy_association_diagnostic(attempt.binding.launch, client, tree, capture.read,
            image_open=K.HeldImage, system_image=PortalImage('proxy'), pidfds=ObserverPidfds,
            guard=lambda: (attempt.binding.verify(), target_guard()), budget=capture.budget)

    def start_warm_activation_diagnostic(self, client, attempt=None):
        state = {'capture': None, 'record': {'schemaVersion': 1, 'phase': 'warm', 'readOnly': True,
                 'qualified': False, 'inputPermitted': False, 'authorityGranted': False, 'releaseReady': False}}
        stage, baseline_diagnostic = 'harness-binding', {}
        try:
            # New imports need independent current-harness pins, never the frozen product inventory.
            names = ('scripts/native-linux-production-016-flatpak.py', 'scripts/native-linux-production-016-flatpak.test.py',
                     'scripts/native-linux-flatpak-activation-observer.py', 'scripts/native-linux-flatpak-activation-observer.test.py',
                     'scripts/native-linux-flatpak-dialog-input.py', 'scripts/native-linux-flatpak-dialog-input.test.py',
                     'scripts/native-unix-window.py', 'scripts/native-unix-window.test.py')
            binding = parse(regular(self.root / 'api-binding.json', 32768, 0o600))
            require(binding['harnessSource'] == os.environ.get('GITHUB_SHA')
                    and re.fullmatch(r'[a-f0-9]{40}', binding['harnessSource'])
                    and binding['profile'] == PROFILE and all(binding[k] is False for k in GATES)
                    and set(binding['harnessFiles']) == set(names), 'Exact independently bound diagnostic harness sources required')
            sources = {name: bound(HERE.parent / name, binding['harnessFiles'][name], 1024 * 1024) for name in names}
            state['record'].update(harnessSource=binding['harnessSource'], harnessFiles=binding['harnessFiles'])
            spec = importlib.util.spec_from_loader('owned_flatpak_activation_diagnostic', loader=None)
            module = importlib.util.module_from_spec(spec)
            name = names[2]
            module.__file__ = str(HERE.parent / name)
            exec(compile(sources[name], module.__file__, 'exec'), module.__dict__)
            state['associationValidator'] = module.validate_association
            stage = 'qualified-cold-root'
            cold, owner = self.report['coldRoot'], self.report['coldHost1Owner']
            require(self.report['coldActivationAccepted'] is True and owner['pid'] == cold['pid'], 'Qualified cold Root required')
            def target_guard():
                self.stable(cold)
                actual = self.host_owner()
                require(actual == owner, 'Diagnostic cold Host1 owner changed')
                return actual
            require(attempt is not None, 'Live owned keyboard binding required for pre-input ancestry')
            stage = 'owned-keyboard-binding-verify'
            attempt.binding.verify()
            stage = 'observer-create'
            capture = module.PassiveCapture(owner, attempt.binding.launch, client,
                lambda pid, full=False: self.native.native_process(pid, self.helper, full), proxy_process_snapshot,
                target_guard, os.environ.get('DBUS_SESSION_BUS_ADDRESS'), os.getuid())
            state['capture'] = capture
            stage = 'owned-subtree-read'
            tree = P.subtree(self.flatpak_child.pid, self.helper, self.native)
            try:
                baseline_diagnostic.update(module.lineage_inputs(attempt.binding.launch, client, tree))
            except Exception:
                baseline_diagnostic.update(readOnly=True, inputPermitted=False, authorityGranted=False,
                                           releaseReady=False, captureUnavailable=True)
            state['baselineDiagnostic'] = baseline_diagnostic
            snapshot = None
            if not any(row.get('executable') == '/usr/bin/xdg-dbus-proxy' for row in tree.values()):
                stage = 'external-instance-admission'
                installed = parse(regular(self.root / 'installed-flatpak.json', 32768, 0o600))
                require(installed['ref'] == REF and installed['runtime'] == RUNTIME
                        and installed['commit'] == self.review['flatpak']['commit'], 'Actual installed Flatpak commit binding required')
                snapshot = RootProxySnapshot(module, self.root, binding['harnessSource'],
                    hashlib.sha256(sources[name]).hexdigest(), attempt.binding.launch, client, capture,
                    dict(appCommit=installed['commit'], runtimeCommit=installed['runtimeCommit']))
            stage = 'protected-proxy-image-open'
            system = PortalImage('proxy')
            stage = 'pre-input-lineage-create'
            options = dict(image_open=K.HeldImage, system_image=system, pidfds=ObserverPidfds,
                guard=attempt.binding.verify, budget=capture.budget, diagnostic=baseline_diagnostic,
                diagnostic_state=capture.diagnostic_state)
            if snapshot is None:
                capture.baseline = module.OwnedLineage(attempt.binding.launch, client,
                    tree, capture.read, proxy_process_snapshot, **options)
            else:
                capture.baseline = module.AssociatedProxyLineage(attempt.binding.launch, client,
                    tree, capture.read, proxy_process_snapshot, snapshot=snapshot, **options)
            stage = 'observer-arm'
            capture.arm()
        except Exception as error:
            state['record']['unavailable'] = type(error).__name__
            state['record']['setupFailureStage'] = stage
            failure = getattr(error, 'root_proxy_diagnostic', None)
            if type(failure) is dict:
                try:
                    raw = json_bytes(failure)
                    require(len(raw) <= 32768, 'Bounded root snapshot refusal')
                    state['record']['rootProxySnapshotRefusal'] = parse(raw)
                except Exception:
                    pass  # Never replace the original ownership refusal.
            if state['capture'] is not None:
                try:
                    flags = state['capture'].diagnostic_state()
                    if type(flags) is dict and set(flags) == {'closed', 'stopRequested', 'deadlineExceeded', 'cancelled'} \
                            and all(type(flag) is bool for flag in flags.values()):
                        state['record']['setupStateAtFailure'] = flags
                except Exception:
                    pass
            if baseline_diagnostic:
                state['record']['preInputBaseline'] = baseline_diagnostic
            if stage == 'pre-input-lineage-create' and baseline_diagnostic.get('failureStage') == 'candidate-count':
                try:
                    state['record']['externalProxyDiagnostic'] = self.capture_refused_proxy_association(
                        module, attempt, client, tree, capture, target_guard)
                except Exception as diagnostic_error:
                    state['record']['externalProxyDiagnostic'] = dict(readOnly=True, qualified=False,
                        inputPermitted=False, authorityGranted=False, releaseReady=False, complete=False,
                        associationObserved=False, unavailable=type(diagnostic_error).__name__ if type(diagnostic_error) in (
                            ValueError, KeyError, TypeError, RuntimeError, PermissionError, FileNotFoundError,
                            ProcessLookupError, OSError) else 'OtherError')
        return state

    def finish_warm_activation_diagnostic(self, state, *, settle=False):
        # Neither cleanup nor capture failure may replace the original input/outcome refusal.
        record = state['record']
        if type(state.get('baselineDiagnostic')) is dict and 'failureStage' in state['baselineDiagnostic']:
            record['preInputBaseline'] = state['baselineDiagnostic']
        if state.get('finished'):
            return record
        state['finished'] = True
        try:
            if state['capture'] is not None:
                value = state['capture'].finish_observation() if settle else state['capture'].close()
                require(type(value) is dict and len(json_bytes(value)) <= 32768
                        and value.get('readOnly') is True
                        and all(value.get(key) is False for key in ('qualified', 'inputPermitted', 'authorityGranted', 'releaseReady')),
                        'Only passive diagnostic evidence may be retained')
                record['observation'] = value
        except Exception as error:
            record['captureUnavailable'] = type(error).__name__
        try:
            require(len(json_bytes(record)) <= 32768, 'Bounded passive diagnostic receipt required')
            save(self.root / 'warm-activation-observer-gtk.json', record)
        except Exception:
            pass
        return record

    def launcher_keyboard(self, client, question, action, phase, *, terminal):
        diagnostic = {'phase': phase, 'client': client, 'mechanism': 'exact-xid-keyboard', 'actionAttempted': False,
                      'actionReturned': False, 'outcomeVerified': False, 'releaseReady': False}
        self.launcher_keys.append(diagnostic)
        attempt, companion, passive = None, None, None
        try:
            require(client['executable'] == '/app/bin/creator-hub-flatpak-activate'
                    and client['kernelImageSha256'] == self.review['flatpak']['files']['creator-hub-flatpak-activate']['sha256'],
                    "Only the exact signed Flatpak launcher can use keyboard decisions")
            name = 'native/flatpak-native-activation/src/linux.rs'
            source = bound(self.root / 'stage/source' / name, self.review['flatpak']['source']['files'][name], 262144)
            mapping = launcher_button_mapping(source.decode('utf8'), question, action)
            diagnostic['sourceDialogButtonMapping'] = {**mapping, 'sourceFile': name, 'sourceSha256': hashlib.sha256(source).hexdigest()}
            self.flatpak_guard(); self.stable(client)
            window = self.owned_window(client, 'Creator Hub')
            if phase == 'warm':
                require(question == 'disclosure' and action == 'Open Creator Hub' and mapping['sequence'] == 'Enter',
                        "Companion only authorizes warm disclosure Enter")
                require(self.report.get('coldActivationAccepted') is True, "An independently qualified cold Root is required before warm input")
                cold = self.report['coldRoot']
                expected = self.root / 'home/data/creator-hub-portable/generations' / self.review['generation'] / 'AppDir/usr/bin/creator-hub'
                require(cold['kernelImageSha256'] == self.review['portable']['root']['sha256'] and cold['executable'] == str(expected),
                        "Warm companion is not the independently signed cold generation")
                companion = K.bind_warm_root(self.helper, self.native, self.x11, cold, self.report['coldRootWindow'],
                                             self.report['coldHost1Owner'], self.host_owner, cold_xres=self.report['coldRootXres'])
                require(companion.evidence['xres'] == self.report['coldRootXres'], "Cold Root XRes owner changed before warm input")
            options = {} if companion is None else {'warm_companion': companion}
            attempt = K.capture(self.helper, self.native, self.x11, client, self.flatpak_origin, self.flatpak_guard, window, **options)
            if phase == 'warm':
                passive = self.start_warm_activation_diagnostic(client, attempt)
                require(passive['capture'] is not None and 'unavailable' not in passive['record'], 'Warm pre-input baseline unavailable; no input')
                passive['capture'].begin_input()
            try:
                receipt = attempt.send(mapping['sequence'])
            except K.InputRefused as error:
                self.retain_focus_diagnostic(diagnostic, error)
                receipt = error.receipt
                diagnostic['refusal'] = str(error)[:512]
            diagnostic['keyboard'] = receipt
            diagnostic['actionAttempted'] = type(receipt) is dict and type(receipt.get('delivery')) is list and any(
                type(row) is dict and row.get('submissionAttempted') is True for row in receipt['delivery'])
            delivery = keyboard_delivery(receipt, mapping['sequence'], client, window, self.flatpak_origin, warm_companion=companion,
                warm_terminal=diagnostic.get('focusDiagnostic') if phase == 'warm' and terminal else None)
            diagnostic['deliveryClassification'] = delivery
            require(delivery == 'complete' or terminal, "Intermediate dialog delivery incomplete; no further input")
            if phase == 'warm':
                require(getattr(self, 'warm_activation_pending', None) is None, 'Warm activation cannot be replayed')
                self.warm_activation_pending, passive = passive, None
            return diagnostic
        except Exception as error:
            self.retain_focus_diagnostic(diagnostic, error)
            diagnostic['refusal'] = str(error)[:512]
            raise
        finally:
            try:
                if passive is not None:
                    self.finish_warm_activation_diagnostic(passive)
            finally:
                try:
                    if attempt is not None:
                        attempt.close()
                finally:
                    try:
                        if companion is not None:
                            companion.close()
                    finally:
                        save(self.root / (phase + '-gtk.json'), diagnostic)

    def consumed_warm_outcome(self):
        # Dispose in handler-installation order; the old latch/receipt are never reset.
        old = self.x11
        require(old.error is True, 'Consumed warm outcome requires the original latched connection')
        old.dispose()
        fresh = self.helper.X11()
        adopted = False
        try:
            cold, owner = self.report['coldRoot'], self.report['coldHost1Owner']
            self.stable(cold)
            require(self.host_owner() == owner and os.readlink(f'/proc/{cold["pid"]}/ns/mnt') == os.readlink('/proc/self/ns/mnt'),
                    'Cold Host1 owner/native namespace changed after warm input')
            stack = fresh.property(fresh.x.XDefaultRootWindow(fresh.display), '_NET_CLIENT_LIST_STACKING')
            require(stack == (33, 32, [self.report['coldRootWindow']])
                    and fresh.inspect(self.report['coldRootWindow']) == self.report['coldRootXres'],
                    'Warm terminal outcome needs the exact sole cold Root XRes window')
            self.stable(cold)
            require(self.host_owner() == owner, 'Cold Host1 owner changed during warm outcome')
            self.x11, adopted = fresh, True
            return 'attributed-start-same-owned-native-root'
        finally:
            if not adopted:
                fresh.dispose()

    def launcher_outcome(self, action, phase, missing):
        if action == 'Cancel' or missing:
            self.absent_installation()
            return 'native-support-absent'
        if action == 'Get Native Hub':
            if getattr(self, 'real_portal', None) is not None:
                self.wait(lambda: self.real_portal.state == 'complete')
                self.real_portal.complete()
            require(type(self.portal_calls) is list and len(self.portal_calls) == 1
                    and self.portal_calls[0] == {'url': PORTAL_URL, 'browserOpened': False, 'downloadAttempted': False, 'senderUid': os.getuid()}
                    and not self.windows(), "Exact guarded portal capture and no new window required")
            return 'guarded-portal-capture-only'
        self.wait(lambda: self.host_owner() is not None and len(self.windows()) == 1)
        owner = self.host_owner()
        require(owner is not None, "Expected native Host1 activation was not observed")
        native = self.process(owner['pid'], self.review['portable']['root']['sha256'])
        expected = self.root / 'home/data/creator-hub-portable/generations' / self.review['generation'] / 'AppDir/usr/bin/creator-hub'
        require(native['executable'] == str(expected) and os.readlink(f'/proc/{native["pid"]}/ns/mnt') == os.readlink('/proc/self/ns/mnt'),
                "Activated Root is not the exact signed native generation")
        window = self.owned_window(native, P.TITLE)
        require(self.windows() == [window], "Activation must have one owned native Hub window")
        if phase == 'warm':
            require(native == self.report['coldRoot'] and owner == self.report['coldHost1Owner']
                    and window == self.report['coldRootWindow'] and self.x11.inspect(window) == self.report['coldRootXres'],
                    "Warm activation replaced the original native Hub/window/Host1 owner")
        self.stable(native)
        require(self.host_owner() == owner, "Native Host1 owner changed during outcome observation")
        return 'same-owned-native-root' if phase == 'warm' else 'signed-native-root-activated'

    def portal_sender_refusal(self, peer, stage):
        result = {'readOnly': True, 'inputPermitted': False, 'authorityGranted': False, 'stable': False,
                  'failureStage': stage, 'sender': dict(peer), 'expectedClient': proxy_process_snapshot(self.portal_client)}
        try:
            require(peer['uid'] == os.getuid() and type(peer['pid']) is int and 1 < peer['pid'] < 2**31,
                    "Only exact same-user portal sender diagnostics")
            before = self.native.native_process(peer['pid'], self.helper, False)
            require(before['uids'] == [os.getuid()] * 4 and 0 < int(before['image']['st_size']) <= 64 * 1024 * 1024,
                    "Bounded ordinary portal sender diagnostic")
            observed = self.native.native_process(peer['pid'], self.helper)
            result['observedSender'] = proxy_process_snapshot(observed)
            require({k: v for k, v in observed.items() if k != 'kernelImageSha256'} == before,
                    "Portal sender changed during diagnostic capture")
            self.stable(self.portal_client)
            require(self.native.native_process(peer['pid'], self.helper) == observed, "Portal sender changed during recheck")
            result['stable'] = True
        except Exception as error:
            result['unavailable'] = type(error).__name__ if type(error) in (
                RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, ValueError, KeyError, TypeError, OSError) else 'OtherError'
        require(len(json_bytes(result)) <= 16384, "Portal diagnostic output exceeds bound")
        return result

    def host_owner(self):
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        def query(method, value, kind):
            return bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method,
                                 GLib.Variant("(s)", (value,)), GLib.VariantType.new(kind), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        if not query("NameHasOwner", NAME, "(b)"):
            return None
        owner = query("GetNameOwner", NAME, "(s)")
        require(re.fullmatch(r":[0-9]+\.[0-9]+", owner) and query("GetConnectionUnixUser", owner, "(u)") == os.getuid(), "Foreign Host1 owner")
        pid = query("GetConnectionUnixProcessID", owner, "(u)")
        require(query("GetNameOwner", NAME, "(s)") == owner, "Host1 bus owner changed")
        return {"name": owner, "pid": pid}

    def snapshot_preserved(self):
        expected = parse(regular(self.root / "preserved.json", 32768, 0o600))
        for name, record in expected.items():
            require(P.record(self.root / "home" / name) == record, "Native fixture setting/project/client entry changed")
        return expected

    def absent_installation(self):
        for name in ("home/data/creator-hub-portable", "home/data/dbus-1/services/com.creatorworks.hub.Host.service"):
            require(not os.path.lexists(self.root / name), "Cancellation created native activation state")
        require(self.host_owner() is None, "Cancellation acquired Host1")
        self.snapshot_preserved()

    def record_launcher_readiness_refusal(self, client, window, candidates, phase, error):
        require(phase in ('disclosure-cancel', 'missing-host', 'portal-only', 'cold', 'warm'), 'Finite readiness diagnostic phase required')
        known_errors = (RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, ValueError, KeyError, TypeError, OSError)
        result = {'schemaVersion': 1, 'phase': phase, 'failureStage': 'initial-window-readiness', 'readOnly': True,
                  'authorityGranted': False, 'inputPermitted': False, 'readinessAccepted': False, 'actionAttempted': False,
                  'releaseReady': False, 'complete': False, 'stable': False, 'observationsAfterRefusal': True,
                  'refusalAttributesCaptured': False,
                  'originalExceptionType': type(error).__name__ if type(error) in known_errors else 'OtherError'}
        try:
            result['failingXid'] = K.xid(window)
            try:
                origin = getattr(self.helper, '_VISIBILITY_DIAGNOSTIC_ORIGIN', None)
                raw = getattr(error, 'window_visibility_refusal', None)
                if origin is not None and getattr(error, '_visibility_diagnostic_origin', None) is origin \
                        and type(error) is RuntimeError and str(error) == 'Owned X window is not a managed visible window' \
                        and type(raw) is dict and set(raw) == {'window', 'map_state', 'override_redirect', 'class'} \
                        and type(raw['window']) is int and raw['window'] == window \
                        and all(type(raw[key]) is int and -(2**31) <= raw[key] < 2**31 for key in ('map_state', 'override_redirect', 'class')) \
                        and not (raw['map_state'] == 2 and not raw['override_redirect']):
                    result['originalRefusalAttributes'] = parse(json_bytes(raw))
                    result['refusalAttributesCaptured'] = True
            except Exception:
                pass  # Missing or inconsistent original metadata is never substituted from later observations.
            require(type(candidates) is list and len(candidates) <= 8 and window in candidates
                    and len(set(candidates)) == len(candidates), 'Bounded original readiness candidates required')
            for candidate in candidates:
                K.xid(candidate)
            result['originalCandidates'] = list(candidates)
            K.validate_process(client, full=True)
            require(client['executable'] == '/app/bin/creator-hub-flatpak-activate' and client['uids'] == [os.getuid()] * 4
                    and client['kernelImageSha256'] == self.review['flatpak']['files']['creator-hub-flatpak-activate']['sha256'],
                    'Only the independently verified launcher may be a diagnostic expectation')
            result['expectedClient'] = parse(json_bytes(client))
            root = K.xid(self.x11.x.XDefaultRootWindow(self.x11.display))
            queries = K.NativeWindow(self.helper, self.x11)
            for label in ('before', 'after'):
                self.flatpak_guard(); self.stable(client)
                view = {'expectedClientVerifiedBefore': True, 'expectedClientVerifiedAfter': False, 'wm': {}}
                result[label] = view
                for name, limit in (('_NET_CLIENT_LIST_STACKING', 8), ('_NET_ACTIVE_WINDOW', 1), ('_NET_SUPPORTING_WM_CHECK', 1)):
                    value = self.x11.property(root, name)
                    require(value is None or type(value) is tuple and len(value) == 3 and value[:2] == (33, 32)
                            and type(value[2]) is list and len(value[2]) <= limit
                            and all(type(v) is int and 0 <= v < 2**32 for v in value[2]), 'Bounded diagnostic WM state required')
                    view['wm'][name] = value
                row = {'xid': window, 'processRedacted': True}
                view['candidate'] = row
                attrs = queries.attributes(window)
                row['attributes'] = {name: getattr(attrs, field) for name, field in
                                     (('map_state', 'map_state'), ('override_redirect', 'override_redirect'), ('class', 'class_'), ('root', 'root'))}
                require(all(type(v) is int and -(2**31) <= v < 2**32 for v in row['attributes'].values()), 'Bounded raw window attributes required')
                xres = queries.xres_identity(window)
                require(type(xres) is dict and set(xres) == {'pid', 'client'}
                        and type(xres['pid']) is int and 1 < xres['pid'] < 2**31
                        and type(xres['client']) is int and 0 < xres['client'] < 2**32, 'Bounded raw XRes identity required')
                row.update(xres=xres, matchesExpectedPid=xres['pid'] == client['pid'], processRedacted=xres['pid'] != client['pid'])
                self.stable(client); self.flatpak_guard()
                view['expectedClientVerifiedAfter'] = True
            result['complete'] = True
            result['stable'] = result['before'] == result['after'] and result['before']['candidate']['matchesExpectedPid'] is True
        except Exception as diagnostic_error:
            result['unavailable'] = type(diagnostic_error).__name__ if type(diagnostic_error) in known_errors else 'OtherError'
        require(len(json_bytes(result)) <= 16384, 'Bounded readiness diagnostic output required')
        save(self.root / (phase + '-readiness-gtk.json'), result)

    def flatpak(self, action, phase, missing=False):
        require((action, phase, missing) in (('Cancel', 'disclosure-cancel', False), ('Open Creator Hub', 'missing-host', True),
                ('Get Native Hub', 'portal-only', False), ('Open Creator Hub', 'cold', False), ('Open Creator Hub', 'warm', False)),
                "Finite source-bound launcher action/phase required")
        child = self.launch(["/usr/bin/flatpak", "run", "--user", REF], phase)
        start = self.helper.parse_start(self.helper.Proc().stat(child.pid), child.pid)
        self.flatpak_popen = {'pid': child.pid, 'startTime': start}
        origin = self.native.native_process(child.pid, self.helper, False)
        require(origin['pid'] == child.pid and origin['startTime'] == start and origin['parentPid'] == os.getpid()
                and origin['uids'] == [os.getuid()] * 4 and origin['executable'] in ('/usr/bin/flatpak', '/usr/bin/bwrap'),
                "Original independently owned Flatpak Popen identity required")
        self.flatpak_origin, self.flatpak_child, self.launcher_keys = origin, child, []
        found = {}
        def discover():
            nonlocal found
            require(child.poll() is None, "Flatpak exited before disclosure")
            found = P.subtree(child.pid, self.helper, self.native)
            matches = [row for row in found.values() if row["executable"] == "/app/bin/creator-hub-flatpak-activate"]
            return len(matches) == 1
        self.wait(discover)
        row = [row for row in found.values() if row["executable"] == "/app/bin/creator-hub-flatpak-activate"][0]
        client = self.process(row["pid"], self.review["flatpak"]["files"]["creator-hub-flatpak-activate"]["sha256"])
        require(client["parentPid"] in found and int(client["startTime"]) >= int(start), "Launcher left this exact owned Flatpak launch")
        self.flatpak_launch = dict(found[child.pid])
        self.disclosure()
        pending_window = None
        def initial_window_ready():
            nonlocal pending_window
            candidates = self.windows()
            if pending_window is not None:
                self.flatpak_guard(); self.stable(client)
                require(pending_window['window'] in candidates, 'Pending launcher window disappeared or changed')
            for window in candidates:
                try:
                    try:
                        props = self.x11.inspect(window)
                    except RuntimeError as error:
                        origin = getattr(self.helper, '_VISIBILITY_DIAGNOSTIC_ORIGIN', None)
                        raw = getattr(error, 'window_visibility_refusal', None)
                        if not (origin is not None and getattr(error, '_visibility_diagnostic_origin', None) is origin
                                and type(error) is RuntimeError and str(error) == 'Owned X window is not a managed visible window'
                                and type(raw) is dict and raw == {'window': window, 'map_state': 0, 'override_redirect': 0, 'class': 1}
                                and all(type(value) is int for value in raw.values())):
                            raise
                        # Only this owned, initially unmapped window may remain pending; this grants no input authority.
                        self.flatpak_guard(); self.stable(client)
                        owner = K.NativeWindow(self.helper, self.x11).xres_identity(window)
                        require(type(owner) is dict and set(owner) == {'pid', 'client'}
                                and type(owner['pid']) is int and owner['pid'] == client['pid']
                                and type(owner['client']) is int and 0 < owner['client'] < 2**32,
                                'Pending launcher XRes ownership differs')
                        observed = {'window': window, **owner}
                        require(pending_window is None or observed == pending_window, 'Pending launcher XRes identity changed')
                        self.stable(client); self.flatpak_guard()
                        pending_window = observed
                        return False
                    if pending_window is not None and window == pending_window['window']:
                        require(props['pid'] == pending_window['pid'] and props['client'] == pending_window['client']
                                and props['mapped'] is True, 'Pending launcher mapped identity changed')
                    if props['pid'] == client['pid']:
                        require(pending_window is None or window == pending_window['window'], 'Pending launcher window changed')
                        if pending_window is not None:
                            self.stable(client); self.flatpak_guard()
                        return True
                except Exception as error:
                    try:
                        self.record_launcher_readiness_refusal(client, window, candidates, phase, error)
                    except Exception:
                        pass  # Diagnostic failures cannot mask or retry the original refusal.
                    raise
            return False
        self.wait(initial_window_ready)
        self.portal_client = client if action == "Get Native Hub" else None
        try:
            if action == 'Get Native Hub' and getattr(self, 'real_portal', None) is not None:
                self.real_portal.arm(client)
            self.launcher_keyboard(client, 'disclosure', action, phase, terminal=not missing)
            if missing:
                self.wait(lambda: any(self.x11.inspect(window)["pid"] == client["pid"] for window in self.windows()))
                self.launcher_keyboard(client, 'missing', 'Close', phase + '-missing', terminal=True)
            self.wait(lambda: child.poll() is not None)
            code = child.wait()
            exit_timing = {}
            if phase == 'warm':
                try:
                    observed = time.monotonic_ns()
                    if type(observed) is int and 0 <= observed < 2**64:
                        exit_timing['ownedExitObservedMonotonicNs'] = observed
                except Exception:
                    pass
            for diagnostic in self.launcher_keys:
                diagnostic['ownedPhaseExit'] = {**self.flatpak_popen, 'exitCode': code, 'expectedExitCode': 1 if missing else 0}
                diagnostic.update(exit_timing)
            require(type(code) is int and code == (1 if missing else 0), "Launcher outcome differs")
            self.snapshot_preserved()
            if phase == 'warm':
                pending = getattr(self, 'warm_activation_pending', None)
                require(pending is not None, 'Missing pre-input warm activation capture')
                record = self.finish_warm_activation_diagnostic(pending, settle=True)
                require(action == 'Open Creator Hub' and not missing, 'Only warm disclosure Enter may qualify')
                admitted = self.launcher_keys[-1]['keyboard']['launchProvenance']['admittedLaunch']
                attributed_warm_activation(record, client, admitted, self.report['coldHost1Owner'],
                    association_validator=pending.get('associationValidator'))
            candidate = self.launcher_keys[-1].get('deliveryClassification') == 'warm-consumed-terminal-candidate'
            proof = self.consumed_warm_outcome() if candidate else self.launcher_outcome(action, phase, missing)
            for diagnostic in self.launcher_keys:
                diagnostic.update(preservedDataVerified=True, outcomeVerified=True, outcomeProof=proof)
        except Exception as error:
            for diagnostic in self.launcher_keys:
                diagnostic['phaseFailure'] = str(error)[:512]
            raise
        finally:
            pending = getattr(self, 'warm_activation_pending', None)
            if pending is not None:
                self.finish_warm_activation_diagnostic(pending)
                self.warm_activation_pending = None
            self.portal_client = None
            for diagnostic in self.launcher_keys:
                # Delivery evidence is immutable; phase outcome is a separate record.
                save(self.root / (diagnostic['phase'] + '-outcome-gtk.json'), diagnostic)

    def disclosure(self):
        file = self.root / "stage/source/native/flatpak-native-activation/src/lib.rs"
        source = regular(file, 262144).decode("utf8")
        match = re.search(r'pub const DISCLOSURE: &str = ("(?:[^"\\]|\\.)*");', source)
        require(match is not None, "Source-bound disclosure missing")
        return parse(match[1])

    def driver_ready(self, child, driver_hash, webkit_hash):
        identity = self.process(child.pid, driver_hash)
        backend = None

        def driver_guard():
            require(child.poll() is None, "Owned WebDriver exited")
            self.stable(identity)

        def sockets_ready():
            nonlocal backend
            driver_guard()
            peers = [row for row in P.subtree(child.pid, self.helper, self.native).values()
                     if row["executable"] == "/usr/bin/WebKitWebDriver" and row["parentPid"] == child.pid]
            require(len(peers) <= 1 and (backend is None or len(peers) == 1), "Owned system driver disappeared or duplicated")
            if not peers:
                return False
            current = self.process(peers[0]["pid"], webkit_hash)
            require(current["parentPid"] == child.pid, "System driver parent differs")
            require(backend is None or current == backend, "System driver identity changed during startup")
            backend = current
            ready = P.listener(child.pid, 4444) and P.listener(backend["pid"], 4445)
            driver_guard()
            return ready

        # The pinned 2.1.0 intermediary forwards /status before WebKit has necessarily bound.
        # https://github.com/tauri-apps/tauri/blob/tauri-driver-v2.1.0/crates/tauri-driver/src/server.rs
        self.wait(sockets_ready)

        def backend_guard():
            driver_guard()
            self.stable(backend)
            require(P.listener(child.pid, 4444) and P.listener(backend["pid"], 4445), "Bound driver socket changed")

        self.driver.guard = backend_guard
        self.wait(lambda: self.driver.request("GET", "/status")["ready"] is True)
        self.report["setupTools"] = {"driver": identity, "systemDriver": backend}

    def setup(self):
        proxy = loopback_proxy(self.bootstrap_proxy)
        bootstrap_transport_ready(self.root, self.review, proxy)
        root_hash = self.review["portable"]["root"]["sha256"]
        setup_name = "Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
        original = self.root / "stage/portable" / setup_name
        profile = parse(regular(self.root / "profile.json", 16384))
        raw = bound(original, profile["portable"]["files"][setup_name])
        launch_dir = self.root / "setup"; launch_dir.mkdir(mode=0o700)
        executable = launch_dir / setup_name; output(executable, raw, 0o755)
        driver_file = P.record(self.root / "tools/bin/tauri-driver")
        webkit_file = P.record("/usr/bin/WebKitWebDriver")
        require(driver_file["uid"] == os.getuid() and driver_file["gid"] == os.getgid() and driver_file["mode"] == 0o755
                and webkit_file["uid"] == webkit_file["gid"] == 0 and webkit_file["mode"] == 0o755, "Unprotected WebDriver tooling")
        driver = self.launch([str(self.root / "tools/bin/tauri-driver"), "--native-driver", "/usr/bin/WebKitWebDriver"], "webdriver",
                             env={**self.app_env, 'HTTPS_PROXY': proxy, 'NO_PROXY': '127.0.0.1,localhost,::1'})
        self.driver_ready(driver, driver_file["sha256"], webkit_file["sha256"])
        # Documented AppImage runtime operation, no forged APPIMAGE/APPDIR or restart hint.
        # https://docs.appimage.org/user-guide/troubleshooting/fuse.html#extract-and-run-type-2-appimages
        value = self.driver.request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "tauri:options": {"application": str(executable), "args": ["--appimage-extract-and-run"]}}}})
        self.driver.session = value["sessionId"]
        found = {}
        def discover():
            nonlocal found
            found = P.subtree(driver.pid, self.helper, self.native)
            return len([row for row in found.values() if row["executable"].endswith("/usr/bin/creator-hub")]) == 1
        self.wait(discover)
        row = [row for row in found.values() if row["executable"].endswith("/usr/bin/creator-hub")][0]
        root = self.process(row["pid"], root_hash)
        self.wait(lambda: any(self.x11.inspect(window)["pid"] == root["pid"] for window in self.windows()))
        window = self.owned_window(root, P.TITLE)
        tooling_guard = self.driver.guard
        def setup_guard():
            tooling_guard()
            self.owned_window(root, P.TITLE)
        self.driver.guard = setup_guard
        self.wait(lambda: self.driver.read("#usage-terms-dialog", "attribute/open") is not None)
        self.driver.click("#usage-terms-checkbox"); self.driver.click("#usage-terms-continue")
        self.wait(lambda: self.driver.read("#usage-terms-dialog", "attribute/open") is None)
        self.wait(lambda: self.driver.read("#native-support-page", "displayed") is True
                  and self.driver.read("#native-support-install", "enabled") is True)
        require(self.driver.read("#native-support-error", "property/hidden") is True, "Setup reported error before review")
        self.absent_installation()
        self.driver.click("#native-support-install")
        self.wait(lambda: len(self.windows()) == 2, 120)
        self.click_dialog(root, ["Install native support", consent_text(self.review["generation"])], ["Install native support", "Cancel"],
                          "Cancel", "setup-cancel", "Install native support")
        self.wait(lambda: self.driver.read("#native-support-install", "enabled") is True)
        self.absent_installation(); self.report["setupCancelAccepted"] = True
        self.driver.click("#native-support-install")
        self.wait(lambda: len(self.windows()) == 2, 120)
        self.click_dialog(root, ["Install native support", consent_text(self.review["generation"])], ["Install native support", "Cancel"],
                          "Install native support", "setup-approve", "Install native support")
        self.wait(lambda: self.driver.read("#native-support-install", "property/hidden") is True
                  and self.driver.read("#native-support-check", "enabled") is True, 180)
        require(self.driver.read("#native-support-status") == "Native support is installed and registered. Close this setup window normally, then reopen Creator Hub from Flatpak. No MCP connection, project or settings migration was started.",
                "Native setup did not report exact completion")
        require(self.driver.read("#native-support-error", "property/hidden") is True, "Native setup stopped with an error")
        verify_registration(self.root, self.review)
        require(self.host_owner() is None, "Setup must not auto-launch or own Host1")
        self.snapshot_preserved()
        self.close(root, window)
        require(self.host_owner() is None, "Setup normal close unexpectedly activated Hub")
        self.report["bootstrapAccepted"] = True

    def review_resume_once(self, process, step, *, apply=False):
        # Explicit one-step UX only. The normal acceptance path never calls this
        # after an unknown result and never manufactures native recovery evidence.
        require(type(apply) is bool and step in RESUME_STEPS and self.driver.read("#native-support-recover", "displayed") is True,
                "Fresh origin-bound recovery must be offered by the actual Root")
        self.driver.click("#native-support-recover")
        self.wait(lambda: len(self.windows()) == 2, 120)
        self.click_dialog(process, [resume_text(self.review["generation"], step)], ["Apply reviewed step", "Cancel"],
                          "Apply reviewed step" if apply else "Cancel", "explicit-resume-" + step, "Review native support")
        self.wait(lambda: len(self.windows()) == 1 and self.driver.read("#native-support-check", "enabled") is True, 120)
        require(self.driver.read("#native-support-error", "property/hidden") is True, "Native one-step recovery refused; no retry")
        self.snapshot_preserved()
        # No next step is selected or retried here. This method alone cannot
        # qualify native recovery without a real retained interruption fixture.
        return self.driver.read("#native-support-status")


def verify_registration(root, review):
    store = root / "home/data/creator-hub-portable"
    selector = store / "activation-v1/creator-hub-portable-selector"
    actual = P.record(selector)
    require({key: actual[key] for key in ("size", "sha256")} == review["portable"]["selector"]
            and actual["uid"] == os.getuid() and actual["mode"] == 0o555, "Stable selector is not the reviewed signed executable")
    service = root / "home/data/dbus-1/services/com.creatorworks.hub.Host.service"
    expected = f"[D-BUS Service]\nName={NAME}\nExec={selector} activate\n".encode()
    require(regular(service, 4096, 0o644) == expected, "User Host1 service differs from fixed selector activation")
    require(parse(regular(store / "current.json", 32768, 0o600)) == {"schemaVersion": 1, "generation": review["generation"],
            "version": "0.1.16", "previousGeneration": None}, "Exact first-install selected generation required")
    require(not (store / "pending.json").exists() and not (store / "activation-v1/pending.json").exists(), "Interrupted native transaction requires explicit review")


def portal_desktop(source, nonce):
    require(type(source) is str and source.startswith('/') and len(source) <= 4096
            and not any(ord(c) < 32 or c in '%\\"`$' for c in source), 'Fixed absolute desktop worker source required')
    require(type(nonce) is str and re.fullmatch('[a-f0-9]{64}', nonce), 'One capture nonce required')
    return ('[Desktop Entry]\nType=Application\nName=Owned URL capture\nNoDisplay=true\nTerminal=false\n'
            'DBusActivatable=false\nMimeType=x-scheme-handler/https;\nExec=/usr/bin/python3 -I -S -B "' + source
            + '" _portal_capture ' + nonce + ' %u\n').encode('utf8')


def portal_worker_args(args):
    require(type(args) is list and len(args) == 3 and args[0] == '_portal_capture'
            and type(args[1]) is str and re.fullmatch('[a-f0-9]{64}', args[1]) and args[2] == PORTAL_URL,
            'Only the exact one-shot public URL capture is allowed')
    return args[1]


def portal_frame(frame, kind, nonce):
    fields = {'kind', 'nonce'} | ({'url'} if kind == 'ready' else set())
    require(kind in ('ready', 'ack', 'complete', 'release') and type(frame) is dict and set(frame) == fields
            and frame['kind'] == kind and frame['nonce'] == nonce
            and (kind != 'ready' or frame['url'] == PORTAL_URL), 'Exact single-use capture frame required')


def portal_worker_identity(process, credentials, parent, python, digest, uid, gid):
    require(type(credentials) is tuple and len(credentials) == 3 and all(type(n) is int for n in credentials)
            and credentials == (process['pid'], uid, gid)
            and process['uids'] == [uid] * 4 and process['parentPid'] == parent
            and process['executable'] == python and process['kernelImageSha256'] == digest,
            'Capture worker kernel credentials/image/exact portal parent differ')


def portal_socket_path(root):
    path = root / 'runtime/portal-capture.sock'
    require(len(os.fsencode(path)) < 108, 'Bounded private UNIX socket path required')
    return str(path)


def portal_worker(root, args):
    nonce = portal_worker_args(args)
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
        channel.settimeout(30)
        channel.connect(portal_socket_path(root))
        credentials = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(credentials[1:] == (os.getuid(), os.getgid()), 'Capture server must be the same private-session identity')
        channel.sendall(json_bytes({'kind': 'ready', 'nonce': nonce, 'url': PORTAL_URL}))
        portal_frame(parse(channel.recv(4097)), 'ack', nonce)
        channel.sendall(json_bytes({'kind': 'complete', 'nonce': nonce}))
        # Remain live until the controller has rechecked credentials, image, argv and parent.
        portal_frame(parse(channel.recv(4097)), 'release', nonce)


PORTAL_SESSION_SECONDS = 600


class PortalControlClosed(RuntimeError):
    pass


def portal_control_receive(channel, credentials):
    try:
        raw, controls, flags, _ = channel.recvmsg(4097, socket.CMSG_SPACE(12), socket.MSG_CMSG_CLOEXEC)
    except BlockingIOError:
        return None
    if raw == b'' and not controls and not flags & ~socket.MSG_CMSG_CLOEXEC:
        raise PortalControlClosed('Private portal supervisor channel closed')
    for level, kind, data in controls:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            for offset in range(0, len(data) - len(data) % 4, 4):
                os.close(struct.unpack('i', data[offset:offset + 4])[0])
    require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and 0 < len(raw) <= 4096 and len(controls) == 1
            and controls[0][:2] == (socket.SOL_SOCKET, socket.SCM_CREDENTIALS)
            and controls[0][2] == struct.pack('3i', *credentials), 'Exact private portal supervisor credentials required')
    return parse(raw)


def portal_control_send(channel, frame):
    raw = json_bytes(frame)
    require(len(raw) <= 4096 and channel.send(raw) == len(raw), 'One bounded portal supervisor packet required')


def portal_wait_owned_daemon(daemon, deadline):
    # Do not detach the owned daemon when the controller closes its private bus.
    # Popen.poll reaps only this child; no signal or broad wait is permitted.
    while True:
        status = daemon.poll()
        if status is not None:
            return status
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Portal daemon teardown remains unconfirmed')
        select.select([], [], [], min(0.05, remaining))


class PortalOwnedWorker:
    """One live-verified adopted child; only its exact nonblocking wait is permitted."""
    def __init__(self, expected, nonce, source, python, helper, native):
        self.pidfd, self.image = None, None
        self.expected, self.nonce, self.source = copy.deepcopy(expected), nonce, source
        self.python, self.helper, self.native = python, helper, native
        self.reaped = False
        try:
            K.validate_process(self.expected, full=True)
            portal_worker_identity(self.expected, (expected['pid'], os.getuid(), os.getgid()), os.getpid(),
                                   python.path, python.pin[1], os.getuid(), os.getgid())
            self.pidfd = os.pidfd_open(expected['pid'])
            self.image = K.HeldImage(expected['pid'])
            self.recheck_live()
        except Exception as error:
            try:
                self.close()
            except Exception:
                error.portal_cleanup_failed = True
            raise

    def recheck_live(self):
        self.python.recheck()
        require(self.native.native_process(self.expected['pid'], self.helper) == self.expected
                and self.image.snapshot() == self.python.pin == (self.expected['image'], self.expected['kernelImageSha256'])
                and not select.select([self.pidfd], [], [], 0)[0], 'Owned portal worker changed before release')
        args = ['/usr/bin/python3', '-I', '-S', '-B', str(self.source), '_portal_capture', self.nonce, PORTAL_URL]
        with open(f'/proc/{self.expected["pid"]}/cmdline', 'rb', buffering=0) as stream:
            require(stream.read(8193) == b'\0'.join(os.fsencode(arg) for arg in args) + b'\0', 'Exact retained portal worker argv required')
        require(self.native.native_process(self.expected['pid'], self.helper) == self.expected, 'Portal worker changed during retention')

    def reap(self):
        require(not self.reaped and self.pidfd is not None and self.image is not None, 'One retained portal child wait required')
        self.python.recheck()
        require(self.image.snapshot() == self.python.pin, 'Held portal worker image changed')
        proc, pid = self.helper.Proc(), self.expected['pid']
        before = proc.stat(pid)
        start = self.helper.parse_start(before, pid, require_live=False)
        fields = before[before.rfind(')') + 2:].split()
        require(start == self.expected['startTime'] and int(fields[1]) == self.expected['parentPid'] == os.getpid()
                and self.native.process_uids(pid) == self.expected['uids'] == [os.getuid()] * 4,
                'Exact adopted portal child identity required before wait')
        after = proc.stat(pid)
        require(self.helper.parse_start(after, pid, require_live=False) == start
                and after[after.rfind(')') + 2:].split()[1] == fields[1], 'Adopted portal child changed before wait')
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == 0:
            return None
        self.reaped = True
        require(waited == pid and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
                and not proc.exists(pid), 'Portal worker did not exit zero and reap exactly')
        return {'kind': 'reaped', 'nonce': self.nonce, 'pid': pid, 'startTime': start, 'exitCode': 0}

    def close(self):
        try:
            if self.image is not None:
                self.image.close(); self.image = None
        finally:
            if self.pidfd is not None:
                os.close(self.pidfd); self.pidfd = None


def portal_provider(role, control_fd=None, nonce=None):
    require(role in PORTAL_PROVIDERS, 'Only fixed native portal providers allowed')
    path = PORTAL_PROVIDERS[role][0]
    if role != 'portal':
        require(control_fd is None and nonce is None, 'Only the portal may retain a supervisor')
        os.execve(path, [path], dict(os.environ))
        return
    require(type(control_fd) is int and 2 < control_fd < 65536 and type(nonce) is str
            and re.fullmatch('[a-f0-9]{64}', nonce), 'Fixed private portal supervisor control required')
    channel = socket.socket(fileno=control_fd)
    worker = python = daemon = None
    failure = None
    session_deadline = time.monotonic() + PORTAL_SESSION_SECONDS
    try:
        require(channel.family == socket.AF_UNIX and channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_SEQPACKET
                and channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                == struct.pack('3i', os.getppid(), os.getuid(), os.getgid()), 'Original private supervisor parent required')
        channel.set_inheritable(False); channel.setblocking(False)
        channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        # The wrapper must remain the adoption/wait owner, not exec the daemon.
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        libc.prctl.restype = ctypes.c_int
        require(libc.prctl(36, 1, 0, 0, 0) == 0, 'Portal subreaper setup refused')
        enabled = ctypes.c_int(0)
        require(libc.prctl(37, ctypes.addressof(enabled), 0, 0, 0) == 0 and enabled.value == 1, 'Portal subreaper readback refused')
        daemon = subprocess.Popen([path], stdin=subprocess.DEVNULL, close_fds=True)
        portal_control_send(channel, {'kind': 'provider', 'nonce': nonce, 'pid': daemon.pid})
        helper, native = P.helpers()
        python = PortalImage('python')
        state, deadline = 'idle', None
        while True:
            require(time.monotonic() < session_deadline, 'Original private portal session lifetime expired')
            require(daemon.poll() is None, 'Owned portal daemon exited')
            require(deadline is None or time.monotonic() < deadline, 'Original portal capture deadline expired')
            try:
                frame = portal_control_receive(channel, (os.getppid(), os.getuid(), os.getgid()))
            except PortalControlClosed:
                require(state == 'complete', 'Portal controller closed before verified capture completion')
                break
            if frame is not None:
                require(type(frame) is dict and frame.get('nonce') == nonce, 'Bound portal supervisor nonce required')
                if state == 'idle':
                    require(set(frame) == {'kind', 'nonce', 'worker', 'deadline'} and frame['kind'] == 'retain'
                            and type(frame['deadline']) in (int, float) and time.monotonic() < frame['deadline'] <= time.monotonic() + 30,
                            'One finite portal child retention required')
                    deadline = frame['deadline']
                    worker = PortalOwnedWorker(frame['worker'], nonce, Path(__file__).resolve(), python, helper, native)
                    require(time.monotonic() < deadline, 'Portal retention exceeded original capture deadline')
                    portal_control_send(channel, {'kind': 'retained', 'nonce': nonce, 'pid': worker.expected['pid'],
                                                  'startTime': worker.expected['startTime']})
                    state = 'retained'
                else:
                    require(state == 'retained' and frame == {'kind': 'reap', 'nonce': nonce}, 'One retained portal child reap required')
                    state = 'reaping'
            if state == 'reaping':
                result = worker.reap()
                if result is not None:
                    require(time.monotonic() < deadline, 'Portal reap exceeded original capture deadline')
                    portal_control_send(channel, result)
                    worker.close(); worker = None
                    state, deadline = 'complete', None
            select.select([channel], [], [], 0.05)
    except BaseException as error:
        failure = error
        raise
    finally:
        cleanup_error = None
        if daemon is not None:
            try:
                portal_wait_owned_daemon(daemon, session_deadline)
            except Exception as error:
                cleanup_error = error
        for value in (worker, python, channel):
            try:
                if value is not None:
                    value.close()
            except Exception as error:
                cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            if failure is not None:
                failure.portal_cleanup_failed = True
            else:
                raise cleanup_error


class PortalImage(K.HeldImage):
    """Held package image from a finite protected system path, never a caller path."""
    def __init__(self, role):
        require(role in (*PORTAL_PROVIDERS, 'python', 'curl', 'proxy'), 'Only fixed portal/readiness/proxy system images allowed')
        system = {'python': '/usr/bin/python3', 'curl': '/usr/bin/curl', 'proxy': '/usr/bin/xdg-dbus-proxy'}
        original = Path(system[role] if role in system else PORTAL_PROVIDERS[role][0])
        self.fd, self.parents, self.alias = None, [], None
        try:
            if role == 'python':
                link = original.lstat()
                target = os.readlink(original)
                require(stat.S_ISLNK(link.st_mode) and link.st_uid == link.st_gid == 0
                        and re.fullmatch(r'python3\.[0-9]{1,2}', target), 'Protected system Python alias required')
                self.alias = original, P.stamp(link), target
                original = original.parent / target
            self.path = str(original)
            parent = None
            for name in ('/', *original.parts[1:-1]):
                fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
                             **({'dir_fd': parent} if parent is not None else {}))
                self.parents.append((parent, name, fd, K.ProtectedBwrap.directory_stamp(os.fstat(fd))))
                parent = fd
            self.name = original.name
            self.fd = os.open(self.name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            self.identity = K.image_stamp(os.fstat(self.fd))
            self.pin = self.snapshot()
        except Exception:
            self.close()
            raise

    def recheck(self):
        require(self.fd is not None and self.parents, 'Portal image binding is closed')
        for parent, name, fd, expected in self.parents:
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
                    and K.ProtectedBwrap.directory_stamp(info) == expected == K.ProtectedBwrap.directory_stamp(
                        os.stat(name, follow_symlinks=False, **({'dir_fd': parent} if parent is not None else {}))),
                    'Protected portal image ancestry changed')
        info = os.fstat(self.fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_mode & 0o111
                and not info.st_mode & 0o7022 and info.st_nlink >= 1 and K.image_stamp(info) == self.identity
                == K.image_stamp(os.stat(self.name, dir_fd=self.parents[-1][2], follow_symlinks=False)),
                'Protected portal package image changed')
        if self.alias:
            name, stamp, target = self.alias
            require(P.stamp(name.lstat()) == stamp and os.readlink(name) == target, 'System Python alias changed')

    def snapshot(self):
        self.recheck()
        result = super().snapshot()
        self.recheck()
        return result

    def close(self):
        try:
            super().close()
        finally:
            while self.parents:
                os.close(self.parents.pop()[2])


class PortalProvider:
    def __init__(self, session, role, image, bus, *, python=None, nonce=None):
        self.session, self.role, self.image, self.bus = session, role, image, bus
        self.process, self.owner = None, None
        self.control, self.wrapper, self.wrapper_image, self.provider_pid = None, None, None, None
        self.python, self.nonce, self.reap_requested = python, nonce, False
        env = {**session.app_env, **lab_environment(session.root)}
        args = ['/usr/bin/python3', '-I', '-S', '-B', str(Path(__file__).resolve()), '_portal_provider', role]
        peer = None
        try:
            if role == 'portal':
                env['XDG_DESKTOP_PORTAL_DIR'] = str(session.root / 'portal-backends')
                require(python is not None and type(nonce) is str and re.fullmatch('[a-f0-9]{64}', nonce), 'Private portal supervisor identity required')
                self.control, peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                for channel in (self.control, peer):
                    channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                    channel.setblocking(False); channel.set_inheritable(False)
                args.extend((str(peer.fileno()), nonce))
            self.args = args
            self.child = session.launch(args, 'real-portal-' + role, env=env,
                                        **({'pass_fds': (peer.fileno(),)} if peer is not None else {}))
            self.start = session.helper.parse_start(session.helper.Proc().stat(self.child.pid), self.child.pid)
            if peer is not None:
                peer.close(); peer = None
        except Exception as error:
            for value in (peer, self):
                try:
                    if value is not None:
                        value.close()
                except Exception:
                    error.portal_cleanup_failed = True
            raise

    def supervisor_guard(self):
        require(self.control is not None and self.child.poll() is None, 'Original portal supervisor must remain live')
        self.python.recheck()
        current = self.session.native.native_process(self.child.pid, self.session.helper, False)
        require(current['pid'] == self.child.pid and current['startTime'] == self.start and current['parentPid'] == os.getpid()
                and current['uids'] == [os.getuid()] * 4 and current['executable'] == self.python.path and current['image'] == self.python.pin[0],
                'Private portal supervisor kernel image differs')
        actual = self.session.native.native_process(self.child.pid, self.session.helper)
        require({key: value for key, value in actual.items() if key != 'kernelImageSha256'} == current
                and (actual['image'], actual['kernelImageSha256']) == self.python.pin, 'Portal supervisor image changed during binding')
        if self.wrapper is None:
            self.wrapper, self.wrapper_image = copy.deepcopy(actual), K.HeldImage(self.child.pid)
        require(actual == self.wrapper and self.wrapper_image.snapshot() == self.python.pin, 'Held portal supervisor identity changed')
        with open(f'/proc/{self.child.pid}/cmdline', 'rb', buffering=0) as stream:
            require(stream.read(8193) == b'\0'.join(os.fsencode(arg) for arg in self.args) + b'\0', 'Portal supervisor exact source/argv differs')
        self.session.stable(actual)

    def supervisor_receive(self):
        self.supervisor_guard()
        frame = portal_control_receive(self.control, (self.child.pid, os.getuid(), os.getgid()))
        self.supervisor_guard()
        return frame

    def bind(self):
        require(self.child.poll() is None, 'Owned portal provider exited during startup')
        supervised = self.role == 'portal'
        if supervised and self.provider_pid is None:
            frame = self.supervisor_receive()
            if frame is None:
                return False
            require(type(frame) is dict and set(frame) == {'kind', 'nonce', 'pid'} and frame['kind'] == 'provider'
                    and frame['nonce'] == self.nonce and type(frame['pid']) is int and frame['pid'] > 1
                    and frame['pid'] != self.child.pid, 'Exact owned portal daemon announcement required')
            self.provider_pid = frame['pid']
        pid = self.provider_pid if supervised else self.child.pid
        current = self.session.native.native_process(pid, self.session.helper, False)
        require(current['pid'] == pid and (int(current['startTime']) >= int(self.start) if supervised else current['startTime'] == self.start)
                and current['parentPid'] == (self.child.pid if supervised else os.getpid()) and current['uids'] == [os.getuid()] * 4,
                'Original portal Popen continuity changed')
        if current['executable'] != self.image.path:
            require(current['executable'] == str(Path('/usr/bin/python3').resolve(strict=True)), 'Unexpected portal startup image')
            return False
        self.image.recheck()
        actual = self.session.native.native_process(pid, self.session.helper)
        require({k: v for k, v in actual.items() if k != 'kernelImageSha256'} == current
                and (actual['image'], actual['kernelImageSha256']) == self.image.pin,
                'Portal kernel image differs from held package bytes')
        owner = self.bus_owner()
        if owner is None:
            return False
        require(owner['pid'] == pid and owner['uid'] == os.getuid(), 'Portal name is not the exact owned provider')
        self.process, self.owner = actual, owner
        self.guard()
        return True

    def bus_owner(self):
        from gi.repository import Gio, GLib
        def query(method, value, kind):
            return self.bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', method,
                GLib.Variant('(s)', (value,)), GLib.VariantType.new(kind), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        name = PORTAL_PROVIDERS[self.role][1]
        if not query('NameHasOwner', name, '(b)'):
            return None
        owner = query('GetNameOwner', name, '(s)')
        require(type(owner) is str and re.fullmatch(r':[0-9]+\.[0-9]+', owner), 'One unique portal bus owner required')
        result = {'name': owner, 'pid': query('GetConnectionUnixProcessID', owner, '(u)'),
                  'uid': query('GetConnectionUnixUser', owner, '(u)')}
        require(query('GetNameOwner', name, '(s)') == owner, 'Portal owner changed during query')
        return result

    def guard(self):
        require(self.child.poll() is None and self.process is not None and self.owner is not None,
                'Original bound portal provider must remain live')
        self.image.recheck()
        if self.role == 'portal':
            self.supervisor_guard()
        self.session.stable(self.process)
        require(self.bus_owner() == self.owner, 'Bound portal provider bus owner changed')

    def retain_worker(self, worker, deadline):
        self.guard()
        require(self.role == 'portal' and not self.reap_requested, 'Only one portal worker may be retained')
        self.reap_requested = True
        portal_control_send(self.control, {'kind': 'retain', 'nonce': self.nonce, 'worker': worker, 'deadline': deadline})
        self.guard()

    def begin_reap(self):
        self.guard()
        portal_control_send(self.control, {'kind': 'reap', 'nonce': self.nonce})
        self.guard()

    def close(self):
        control, image = self.control, self.wrapper_image
        self.control, self.wrapper_image = None, None
        failure = None
        for value in (control, image):
            try:
                if value is not None:
                    value.close()
            except Exception as error:
                failure = failure or error
        if failure is not None:
            raise failure


class RealPortalCapture:
    def __init__(self, session):
        from gi.repository import Gio
        self.session, self.providers, self.images, self.files = session, {}, {}, {}
        self.listener, self.channel, self.worker_image, self.source_fd = None, None, None, None
        self.state, self.connections, self.armed = 'starting', 0, False
        self.receipt = {'mechanism': 'real-xdg-desktop-portal', 'workerCompleted': False,
                        'browserOpened': False, 'downloadAttempted': False, 'releaseReady': False}
        self.nonce, self.client = secrets.token_hex(32), None
        self.calls = []; session.portal_calls = self.calls
        try:
            self.source = Path(__file__).resolve(strict=True)
            raw = regular(self.source, 1024 * 1024)
            self.source_fd = os.open(self.source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.source_stamp = P.stamp(os.fstat(self.source_fd))
            require(self.source_stamp == P.stamp(self.source.lstat()), 'Capture source changed before binding')
            self.source_pin = {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            applications = session.root / 'home/data/applications'
            applications.mkdir(mode=0o700)
            desktop = applications / 'creator-hub-owned-url-capture.desktop'
            mime = session.root / 'home/config/mimeapps.list'
            self.files = {desktop: portal_desktop(str(self.source), self.nonce), mime:
                b'[Default Applications]\nx-scheme-handler/https=creator-hub-owned-url-capture.desktop;\n'}
            backend = session.root / 'portal-backends'
            backend.mkdir(mode=0o700)
            self.files[backend / 'gtk.portal'] = (b'[portal]\nDBusName=org.freedesktop.impl.portal.desktop.gtk\n'
                b'Interfaces=org.freedesktop.impl.portal.AppChooser;\nUseIn=creator-hub-ci\n')
            for path, data in self.files.items():
                output(path, data)
            # Explicit default and content-type registration; no BROWSER or portal recursion overrides.
            command(['/usr/bin/update-desktop-database', str(applications)], env=session.app_env)
            require(command(['/usr/bin/dpkg', '--verify', 'xdg-desktop-portal', 'xdg-desktop-portal-gtk'],
                            env=session.app_env) == b'', 'Installed real portal package verification failed')
            self.protected_state()
            runtime = session.root / 'runtime'
            info = runtime.lstat()
            require(runtime.resolve(strict=True) == runtime and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o700, 'Canonical private capture runtime required')
            self.runtime_stamp = K.ProtectedBwrap.directory_stamp(info)
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            address = portal_socket_path(session.root)
            require(not os.path.lexists(address), 'Existing capture endpoint refused')
            self.listener.bind(address); os.chmod(address, 0o600)
            self.socket_stamp = P.stamp(Path(address).lstat())
            self.listener.listen(2); self.listener.setblocking(False)
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            self.images['python'] = PortalImage('python')
            for role in PORTAL_PROVIDERS:
                image = self.images[role] = PortalImage(role)
                provider = self.providers[role] = PortalProvider(session, role, image, bus,
                    **({'python': self.images['python'], 'nonce': self.nonce} if role == 'portal' else {}))
                session.wait(provider.bind)
            self.state = 'listening'
            self.guard()
        except Exception as error:
            try:
                save(session.root / 'real-portal-gtk.json', {**self.evidence(), 'error': str(error)[:512]})
            except Exception:
                pass
            try:
                self.close()
            except Exception:
                error.portal_cleanup_failed = True
            raise

    def protected_state(self):
        self.session.snapshot_preserved()
        self.session.absent_installation()
        for path, data in self.files.items():
            require(regular(path, 8192, 0o600) == data, 'Private browser configuration changed')
        require(P.stamp(os.fstat(self.source_fd)) == self.source_stamp == P.stamp(self.source.lstat())
                and {'size': len(raw := regular(self.source, 1024 * 1024)), 'sha256': hashlib.sha256(raw).hexdigest()} == self.source_pin,
                'Exact capture source changed')

    def guard(self):
        for provider in self.providers.values():
            provider.guard()
        if self.listener is not None:
            runtime = self.session.root / 'runtime'
            require(runtime.resolve(strict=True) == runtime and K.ProtectedBwrap.directory_stamp(runtime.lstat()) == self.runtime_stamp
                    and P.stamp(Path(portal_socket_path(self.session.root)).lstat()) == self.socket_stamp,
                    'Owned capture endpoint changed')

    def arm(self, client):
        require(self.state == 'listening' and not self.armed and self.connections == 0, 'One explicit portal scenario only')
        self.guard(); self.protected_state(); self.session.stable(client)
        self.client, self.armed, self.deadline = dict(client), True, time.monotonic() + 30

    def worker_guard(self):
        self.guard(); self.protected_state()
        python = self.images['python']; python.recheck()
        actual = self.session.native.native_process(self.credentials[0], self.session.helper)
        portal_worker_identity(actual, self.credentials, self.providers['portal'].child.pid, python.path, python.pin[1],
                               os.getuid(), os.getgid())
        require(actual == self.worker and (actual['image'], actual['kernelImageSha256']) == self.worker_image.snapshot() == python.pin,
                'Held capture worker identity changed')
        args = ['/usr/bin/python3', '-I', '-S', '-B', str(self.source), '_portal_capture', self.nonce, PORTAL_URL]
        with open(f'/proc/{actual["pid"]}/cmdline', 'rb', buffering=0) as stream:
            raw = stream.read(8193)
        require(len(raw) <= 8192 and raw == b'\0'.join(os.fsencode(arg) for arg in args) + b'\0',
                'Capture worker exact source/argv differ')
        self.session.stable(actual)

    def receive(self):
        try:
            raw, controls, flags, _ = self.channel.recvmsg(4097, socket.CMSG_SPACE(12), socket.MSG_CMSG_CLOEXEC)
        except BlockingIOError:
            return None
        for level, kind, data in controls:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                for offset in range(0, len(data) - len(data) % 4, 4):
                    os.close(struct.unpack('i', data[offset:offset + 4])[0])
        require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and len(raw) <= 4096 and len(controls) == 1
                and controls[0][:2] == (socket.SOL_SOCKET, socket.SCM_CREDENTIALS) and len(controls[0][2]) == 12
                and struct.unpack('3i', controls[0][2]) == self.credentials,
                'Exact per-message worker credentials and bounded packet required')
        return parse(raw)

    def poll(self):
        self.guard()
        try:
            channel, _ = self.listener.accept()
        except BlockingIOError:
            channel = None
        if channel is not None:
            self.connections += 1
            if not (self.armed and self.state == 'listening' and self.connections == 1):
                channel.close()
                raise RuntimeError('Unexpected or repeated default-handler invocation')
            self.channel = channel; channel.setblocking(False)
            channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            self.credentials = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(self.credentials[1:] == (os.getuid(), os.getgid()), 'Foreign capture peer credentials')
            observed = self.session.native.native_process(self.credentials[0], self.session.helper, False)
            python = self.images['python']
            require(observed['uids'] == [os.getuid()] * 4 and observed['parentPid'] == self.providers['portal'].child.pid
                    and observed['executable'] == python.path and observed['image'] == python.pin[0]
                    and 0 < int(observed['image']['st_size']) <= K.MAX_IMAGE, 'Only the bounded exact portal worker may be hashed')
            self.worker = self.session.native.native_process(self.credentials[0], self.session.helper)
            require({k: v for k, v in self.worker.items() if k != 'kernelImageSha256'} == observed,
                    'Capture worker changed before binding its image')
            self.worker_image = K.HeldImage(self.credentials[0])
            self.worker_guard()
            self.state = 'await-ready'
        if self.state in ('await-ready', 'await-complete'):
            frame = self.receive()
            if frame is not None:
                self.worker_guard()
                kind = 'ready' if self.state == 'await-ready' else 'complete'
                portal_frame(frame, kind, self.nonce)
                if kind == 'ready':
                    self.channel.sendall(json_bytes({'kind': 'ack', 'nonce': self.nonce}))
                    self.state = 'await-complete'
                else:
                    self.worker_guard()
                    self.providers['portal'].retain_worker(self.worker, self.deadline)
                    self.state = 'await-retained'
        if self.state == 'await-retained':
            provider = self.providers['portal']
            frame = provider.supervisor_receive()
            if frame is not None:
                require(time.monotonic() <= self.deadline, 'Portal retention acknowledgement exceeded original deadline')
                require(frame == {'kind': 'retained', 'nonce': self.nonce, 'pid': self.worker['pid'],
                                  'startTime': self.worker['startTime']}, 'Exact live-retained portal child acknowledgement required')
                self.worker_guard()
                provider.begin_reap()
                self.channel.sendall(json_bytes({'kind': 'release', 'nonce': self.nonce}))
                self.channel.close(); self.channel = None
                self.state = 'await-reaped'
        if self.state == 'await-reaped':
            provider = self.providers['portal']
            frame = provider.supervisor_receive()
            if frame is not None:
                require(time.monotonic() <= self.deadline, 'Portal reap acknowledgement exceeded original deadline')
                require(frame == {'kind': 'reaped', 'nonce': self.nonce, 'pid': self.worker['pid'],
                                  'startTime': self.worker['startTime'], 'exitCode': 0}
                        and not self.session.helper.Proc().exists(self.worker['pid']), 'Exact zero-exit portal worker reaping required')
                self.protected_state()
                require(self.worker_image.snapshot() == self.images['python'].pin, 'Held completed portal worker image changed')
                provider.guard()
                require(time.monotonic() <= self.deadline, 'Portal final recheck exceeded original capture deadline')
                self.receipt.update(workerCompleted=True, workerReaped=True, workerExitCode=0,
                    worker=self.worker, credentials=list(self.credentials), portalParent=provider.process,
                    portalSupervisor=provider.wrapper, source=self.source_pin,
                    protectedStateVerified=True, invocationCount=self.connections)
                self.state = 'complete'
                self.calls.append({'url': PORTAL_URL, 'browserOpened': False, 'downloadAttempted': False, 'senderUid': os.getuid()})
        require(not self.armed or self.state == 'complete' or time.monotonic() <= self.deadline,
                'Independent real-portal capture completion deadline')

    def complete(self):
        self.poll()
        require(self.armed and self.state == 'complete' and self.connections == 1 and len(self.calls) == 1
                and self.receipt['workerCompleted'] is True and self.receipt['workerReaped'] is True,
                'Launcher exit alone is not portal capture completion')
        self.protected_state()

    def close(self):
        failure = None
        for value in (*self.providers.values(), self.channel, self.listener, self.worker_image, *self.images.values()):
            try:
                if value is not None:
                    value.close()
            except Exception as error:
                failure = failure or error
        self.channel, self.listener, self.worker_image = None, None, None
        if self.source_fd is not None:
            fd, self.source_fd = self.source_fd, None
            try:
                os.close(fd)
            except Exception as error:
                failure = failure or error
        if failure is not None:
            raise failure

    def evidence(self):
        return {**self.receipt, 'state': self.state, 'invocationCount': self.connections,
                'providers': {role: {'process': provider.process, 'owner': provider.owner} for role, provider in self.providers.items()}}


def portal_capture(session):
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    info = Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.portal.OpenURI"><method name="OpenURI">'
        '<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/>'
        '</method></interface></node>')
    result = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                          GLib.Variant("(su)", ("org.freedesktop.portal.Desktop", 4)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    require(result == 1, "Fresh private portal name required; no replacement")
    calls = []
    session.portal_calls = calls
    def method(connection, sender, path, interface, name, parameters, invocation):
        uid, pid = None, None
        stage = 'request-shape'
        try:
            require(name == "OpenURI" and len(calls) == 0 and re.fullmatch(r":[0-9]+\.[0-9]+", sender), "Only one fixed portal capture")
            parent, uri, options = parameters.unpack()
            require(parent == "" and uri == PORTAL_URL and options == {}, "Only the source-bound setup URL may be captured")
            stage = 'sender-uid'
            uid = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixUser",
                                      GLib.Variant("(s)", (sender,)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
            stage = 'sender-pid'
            pid = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID",
                                      GLib.Variant("(s)", (sender,)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
            stage = 'sender-binding'
            require(uid == os.getuid() and session.portal_client is not None and pid == session.portal_client["pid"], "Portal sender is not the bound signed launcher")
            session.stable(session.portal_client)
            calls.append({"url": uri, "browserOpened": False, "downloadAttempted": False, "senderUid": uid})
            invocation.return_value(GLib.Variant("(o)", ("/org/freedesktop/portal/desktop/request/production_016/captured",)))
        except Exception as error:
            if uid == os.getuid() and type(pid) is int and session.portal_client is not None and 'portalAttribution' not in session.report:
                try:
                    session.report['portalSenderRefusal'] = session.portal_sender_refusal({'owner': sender, 'pid': pid, 'uid': uid}, stage)
                except Exception:
                    session.report['portalSenderRefusal'] = {'readOnly': True, 'inputPermitted': False, 'authorityGranted': False,
                                                            'failureStage': stage, 'unavailable': 'DiagnosticRefused'}
                try:
                    session.report['portalAttribution'] = session.proxy_attribution(session.portal_client, {'owner': sender, 'pid': pid, 'uid': uid})
                except Exception:
                    pass
            invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", str(error)[:512])
    registration = bus.register_object("/org/freedesktop/portal/desktop", info.interfaces[0], method, None, None)
    return bus, registration, calls


def run_session(root, review):
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gio, GLib, Gdk
    require(os.environ.get("HOME") == str(root / "home") and os.environ.get("FLATPAK_USER_DIR") == str(root / "installation"),
            "Private native HOME and Flatpak installation required")
    verified_review(root, review, headless=True)
    Gdk.init([])
    session = Session(root, review)
    wm, feed = None, None
    try:
        feed = bootstrap_feed(root)
        session.bootstrap_proxy = feed.proxy
        wm = session.launch(["/usr/bin/openbox", "--sm-disable"], "wm")
        session.wait(lambda: session.x11.property(session.x11.x.XDefaultRootWindow(session.x11.display), "_NET_SUPPORTING_WM_CHECK"))
        require(not session.windows() and session.host_owner() is None, "Fresh session already has an app/Host1")
        session.real_portal = RealPortalCapture(session)
        calls = session.real_portal.calls
        original_wait = session.wait
        def wait(test, seconds=30):
            def check():
                context = GLib.MainContext.default()
                while context.pending():
                    context.iteration(False)
                session.real_portal.poll()
                return test()
            original_wait(check, seconds)
        session.wait = wait
        session.absent_installation()
        session.report.update(candidateExecuted=True, flatpakInstalled=True, phase="disclosure-cancel")
        session.flatpak("Cancel", "disclosure-cancel"); session.absent_installation()
        session.report["disclosureCancelAccepted"] = True
        session.report["phase"] = "missing-host"
        session.flatpak("Open Creator Hub", "missing-host", missing=True); session.absent_installation()
        session.report["missingHostAccepted"] = True
        session.report['phase'] = 'portal-only'
        session.flatpak("Get Native Hub", "portal-only"); session.wait(lambda: len(calls) == 1)
        require(calls[0]["url"] == PORTAL_URL and not session.windows(), "Portal must only capture, never open browser/window")
        save(root / "portal-capture.json", {"calls": calls, "publicDownloadAccepted": False})
        session.absent_installation(); session.report["portalCaptureAccepted"] = True
        session.report["phase"] = "bootstrap"
        session.setup()
        session.report["phase"] = "cold-activation"
        session.flatpak("Open Creator Hub", "cold")
        session.wait(lambda: session.host_owner() is not None and len(session.windows()) == 1)
        cold = session.process(session.host_owner()["pid"], review["portable"]["root"]["sha256"])
        expected_path = root / "home/data/creator-hub-portable/generations" / review["generation"] / "AppDir/usr/bin/creator-hub"
        require(cold["executable"] == str(expected_path) and os.readlink(f'/proc/{cold["pid"]}/ns/mnt') == os.readlink("/proc/self/ns/mnt"),
                "Cold Root is not the exact selected native signed image outside the sandbox")
        environment = Path(f'/proc/{cold["pid"]}/environ').read_bytes(); require(len(environment) <= 32768, "Native environment bound")
        values = dict(value.split(b"=", 1) for value in environment.split(b"\0") if b"=" in value)
        require(all(values.get(name.encode()) == os.environ[name].encode() for name in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME")), "Native paths changed")
        window = session.owned_window(cold, P.TITLE)
        cold_owner, cold_xres = session.host_owner(), session.x11.inspect(window)
        require(cold_owner is not None and cold_owner['pid'] == cold['pid'] and cold_xres['pid'] == cold['pid']
                and cold_xres['mapped'] is True, "Cold Root/Host1/XRes ownership must agree")
        session.stable(cold)
        require(session.host_owner() == cold_owner and session.x11.inspect(window) == cold_xres, "Cold Root ownership changed during binding")
        session.report.update(coldActivationAccepted=True, coldRoot=cold, coldHost1Owner=cold_owner, coldRootWindow=window, coldRootXres=cold_xres)
        session.report["phase"] = "warm-activation"
        session.flatpak("Open Creator Hub", "warm")
        session.stable(cold); require(session.host_owner()["pid"] == cold["pid"] and session.windows() == [window], "Warm activation created/replaced Root")
        session.wait(lambda: session.x11.property(session.x11.x.XDefaultRootWindow(session.x11.display), "_NET_ACTIVE_WINDOW")[2] == [window])
        surface = root / "warm-surface"; surface.mkdir(mode=0o700)
        session.report["warmSurface"] = session.native.bitmap(session.helper.Request("snapshot", cold["pid"], cold["startTime"],
            cold["executable"], cold["kernelImageSha256"], window, P.TITLE, "FRAME"), surface, session.helper, session.x11)
        session.report["warmActivationAccepted"] = True
        session.snapshot_preserved(); verify_registration(root, review)
        session.close(cold, window); session.wait(lambda: session.host_owner() is None)
        require(not session.windows(), "Native normal close left another visible app")
        session.snapshot_preserved()
        finish_bootstrap_feed(feed, root, review); feed = None
        session.report.update(settingsPreserved=True, phase="complete", normalCloseObserved=True)
        command(["/usr/bin/openbox", "--exit"]); wm.wait(timeout=10)
    except Exception as error:
        session.report["error"] = str(error)[:1500]
        raise
    finally:
        if feed is not None:
            try:
                feed.finish()
            except Exception as error:
                session.report['labCloseError'] = str(error)[:500]
                session.report['labTeardownUnknown'] = True
        session.report["disposableTeardownRequired"] = session.report.get("phase") != "complete" or any(child.poll() is None for child in session.children)
        session.report["logs"] = [capture.metadata() for capture in session.captures]
        save(root / "report.json", session.report)
        if session.real_portal is not None:
            save(root / 'real-portal-gtk.json', session.real_portal.evidence())
            session.real_portal.close()
        for capture in session.captures:
            capture.close()
        for fd in session.fds:
            os.close(fd)
        session.x11.dispose()


def verified_review(root, review, *, headless=False):
    require(review["profile"] == PROFILE and review["signaturesVerified"] is True and review["runtimeEnabled"] is False
            and all(review[k] is False for k in GATES), "Signature-verified data stage required")
    # Source and byte admission is repeated; a report alone never grants authority.
    fresh = parse(node("verify-staged", headless=headless))
    require(fresh["portable"] == review["portable"] and fresh["flatpak"] == review["flatpak"] and fresh["signed"] == review["signed"], "Reviewed inputs drifted")
    bound(root / "stage/source/src-tauri/src/catalog-key.pub", KEY, 4096)
    for name in (DESCRIPTOR, MANIFEST):
        verify_catalogue_signature(root / "stage/signed" / name, root / "stage/signed" / (name + ".minisig"))
    manifest_bytes = regular(root / "stage/signed" / MANIFEST, 2 * 1024 * 1024)
    verify_tar(regular(root / "stage/portable" / ARCHIVE), parse(manifest_bytes))
    require(hashlib.sha256(manifest_bytes).hexdigest() == review["generation"], "Reviewed generation changed")
    return fresh


def session(root):
    require(os.environ.get("EXECUTION_REQUEST") == REQUEST, "Separate fixed execution request required before any install/session")
    review = parse(regular(root / "stage-review.json", 2 * 1024 * 1024, 0o600))
    verified_review(root, review)
    for path in (Path("/usr/bin/creator-hub"), Path("/usr/share/dbus-1/services/com.creatorworks.hub.Host.service"),
                 Path("/usr/local/share/dbus-1/services/com.creatorworks.hub.Host.service")):
        require(not os.path.lexists(path), "Disposable controller refuses an existing native installation/service")
    for name in ("home", "home/config", "home/data", "home/cache", "runtime", "tmp", "installation"):
        (root / name).mkdir(mode=0o700)
    preserved = {
        "config/creator-works-mcp/launcher-config.json": {"channels": [], "active_channel_id": None, "auto_start": False, "retainedUnknown": "keep"},
        "data/CreatorHub/preferences/hub-preferences.json": {"schemaVersion": 1, "preview": False, "autoDownload": False, "restoreHostedViews": True},
        ".claude.json": {"mcpServers": {"unrelated": {"command": "do-not-launch", "args": ["retained"]}}, "unknown": "keep"},
        "preserved-project/Assets/keep.json": {"project": "never migrate, rewrite or run"},
    }
    for name, value in preserved.items():
        file = root / "home" / name; file.parent.mkdir(mode=0o700, parents=True, exist_ok=True); output(file, json_bytes(value))
    save(root / "preserved.json", {name: P.record(root / "home" / name) for name in preserved})
    env = clean_environment(root)
    # The official runtime remote is confined to this disposable installation;
    # no app remote, test GPG key, Flathub submission or distribution claim.
    command(["/usr/bin/flatpak", "--user", "remote-add", "flathub", "https://dl.flathub.org/repo/flathub.flatpakrepo"], env=env, timeout=120)
    queried = command(["/usr/bin/flatpak", "--user", "remote-info", "--show-ref", "flathub", RUNTIME], env=env).decode().strip()
    commit = command(["/usr/bin/flatpak", "--user", "remote-info", "--show-commit", "flathub", RUNTIME], env=env).decode().strip()
    require(queried == RUNTIME and re.fullmatch(r"[a-f0-9]{64}", commit), "Exact runtime ref/commit required before install")
    command(["/usr/bin/flatpak", "--user", "install", "--noninteractive", "--assumeyes", "--no-related", "flathub", RUNTIME], env=env, timeout=900)
    command(["/usr/bin/flatpak", "--user", "update", "--noninteractive", "--assumeyes", "--no-related", "--commit=" + commit, RUNTIME], env=env, timeout=900)
    require(command(["/usr/bin/flatpak", "--user", "info", "--show-commit", RUNTIME], env=env).decode().strip() == commit, "Installed runtime commit drift")
    bundle = root / "stage/flatpak/Creator.Hub_0.1.16_x86_64.flatpak"
    command(["/usr/bin/flatpak", "--user", "install", "--bundle", "--noninteractive", "--assumeyes", "--no-related", "--no-deps", str(bundle)], env=env, timeout=120)
    require(command(["/usr/bin/flatpak", "--user", "info", "--show-commit", REF], env=env).decode().strip() == review["flatpak"]["commit"], "Installed bundle OSTree commit differs")
    metadata = command(["/usr/bin/flatpak", "--user", "info", "--show-metadata", REF], env=env)
    import configparser
    config = configparser.RawConfigParser(strict=True); config.optionxform = str; config.read_string(metadata.decode("utf8"))
    require(set(config.sections()) == {"Application", "Context", "Session Bus Policy"}, "Installed metadata sections differ")
    require(dict(config["Application"]) == {"name": "com.creatorworks.hub", "runtime": "org.gnome.Platform/x86_64/50", "sdk": "org.gnome.Sdk/x86_64/50", "command": "creator-hub-flatpak-activate"}
            and dict(config["Context"]) == {"sockets": "wayland;fallback-x11;"}
            and dict(config["Session Bus Policy"]) == {NAME: "talk"}, "Installed permissions exceed the producer contract")
    save(root / "installed-flatpak.json", {"ref": REF, "commit": review["flatpak"]["commit"], "runtime": RUNTIME,
                                           "runtimeCommit": commit, "manualBundle": True, "releaseReady": False})
    context = {key: value for key, value in os.environ.items() if key in ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID",
        "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_WORKFLOW_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
        "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "EXECUTION_REQUEST", "CONTROLLER_NODE",
        "CONTROLLER_PROFILE", "SIGNED_INPUT")}
    guard = prepare_tls(root, review)
    try:
        command(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24", "/usr/bin/dbus-run-session", "--",
                 "/usr/bin/python3", "-B", str(Path(__file__).resolve()), "_run"], env={**env, **context}, timeout=PORTAL_SESSION_SECONDS)
    finally:
        try:
            guard.finish()
        finally:
            verify_tls_cleanup(root)
    report = parse(regular(root / 'report.json', 32768, 0o600))
    require(report['phase'] == 'complete' and report['settingsPreserved'] is True, 'Native session did not complete')
    report['tlsCleanupVerified'] = True
    save(root / 'final-report.json', report)


def main():
    admission(os.environ, sys.platform, platform.machine() if sys.platform == "linux" else "", os.getuid() if hasattr(os, "getuid") else None)
    require(os.getuid() == os.geteuid(), "No privileged identity transition")
    args = sys.argv[1:]
    capture = bool(args) and args[0] == '_portal_capture'
    provider = (len(args) == 2 and args[0] == '_portal_provider' and args[1] in PORTAL_PROVIDERS and args[1] != 'portal'
                or len(args) == 4 and args[:2] == ['_portal_provider', 'portal'] and re.fullmatch('[0-9]{1,5}', args[2])
                and 2 < int(args[2]) < 65536 and re.fullmatch('[a-f0-9]{64}', args[3]))
    if capture:
        portal_worker_args(args)
    else:
        require(provider or len(args) == 1 and args[0] in ("stage", "session", "_run", "_tls_guard", "tls-cleanup", "root-preflight"),
                "Only fixed native controller modes")
    root = locations()
    if args == ['root-preflight']:
        root_inventory_preflight(root); return
    if sys.argv[1] == 'tls-cleanup':
        verify_tls_cleanup(root); return
    before = root.lstat()
    require(root.resolve(strict=True) == root and stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid()
            and stat.S_IMODE(before.st_mode) == 0o700, "Owned private input root required")
    if provider or capture:
        require(os.environ.get('EXECUTION_REQUEST') == REQUEST and os.environ.get('HOME') == str(root / 'home')
                and os.environ.get('XDG_RUNTIME_DIR') == str(root / 'runtime') and os.environ.get('DISPLAY')
                and os.environ.get('DBUS_SESSION_BUS_ADDRESS', '').startswith('unix:'), 'Private native portal worker role required')
        if capture:
            portal_worker(root, args)
        else:
            portal_provider(args[1], *((int(args[2]), args[3]) if len(args) == 4 else ()))
        return
    if sys.argv[1] == "stage":
        stage(root)
    elif sys.argv[1] == "session":
        session(root)
    elif sys.argv[1] == '_tls_guard':
        tls_guard(root)
    else:
        require(os.environ.get("EXECUTION_REQUEST") == REQUEST and os.environ.get("HOME") == str(root / "home")
                and os.environ.get("XDG_RUNTIME_DIR") == str(root / "runtime") and os.environ.get("DISPLAY")
                and os.environ.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:"), "Private inherited execution session required")
        review = parse(regular(root / "stage-review.json", 2 * 1024 * 1024, 0o600))
        require(review["signaturesVerified"] is True and all(review[key] is False for key in GATES), "Verified stage, not supplied acceptance flags")
        run_session(root, review)


if __name__ == "__main__":
    main()
