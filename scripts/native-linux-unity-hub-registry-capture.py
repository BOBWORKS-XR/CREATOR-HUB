"""One official Hub first-run observation. Never registers a project or signs in."""
import configparser
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import selectors
import shlex
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import zlib
from email.parser import Parser

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO, REPO_ID = "BOBWORKS-XR/CREATOR-HUB", "1364807512"
BRANCH = "refs/heads/validation/linux-unity-hub-registry-capture"
WORKFLOW = REPO + "/.github/workflows/linux-unity-hub-registry-capture.yml@" + BRANCH
REQUEST = "observe-official-hub-3.22.3"
DIRECTORY = "linux-unity-hub-registry-capture"
VERSION, PACKAGE = "3.22.3", "unityhub"
FINGERPRINT = "A08CA7CD4D006A4128EC2850BE3E6EA534E8243F"
REPOSITORY = "https://hub-dist.unity3d.com/artifactory/hub-debian-prod-local/"
DEB_MEMBER = "pool/main/u/unity/unityhub_amd64/UnityHubSetup-3.22.3-amd64.deb"
PINS = {
    "key": (3147, "50b6488eb573a02a96f897482fd190e965eaf58c60b7053aec31ab54bc63b726"),
    "inrelease": (3588, "500ed8c23aa56e40ff520b648204eed874aaf486562fba9514cff02b4ba5f8a6"),
    "packages": (6378, "eefd19479be76a8fd9b5be1b28115b1b7e8eba54cc5d600b728f774d9c2b71d5"),
    "packages-raw": (44460, "2bf958558842532d836ae9000b7184219c263addcf4d064d75f987151af9148b"),
    "deb": (167637012, "a3ab6c61cbedbcd4baed4da06834a1737c4419f5c8c761fe326136f87435481f"),
}
URLS = {
    "key": ("https://hub.unity3d.com/linux/keys/public",
            "https://hub-dist.unity3d.com/artifactory/api/security/keypair/unityTechnologiesApS/public"),
    "inrelease": ("https://hub.unity3d.com/linux/repos/deb/dists/stable/InRelease",
                  REPOSITORY + "dists/stable/InRelease"),
    "packages": ("https://hub.unity3d.com/linux/repos/deb/dists/stable/main/binary-amd64/Packages.gz",
                 REPOSITORY + "dists/stable/main/binary-amd64/Packages.gz"),
    "deb": ("https://hub.unity3d.com/linux/repos/deb/" + DEB_MEMBER, REPOSITORY + DEB_MEMBER),
}
HELPERS = ("scripts/native-unix-window.py", "scripts/native-linux-root-probe.py")
SOURCES = ("scripts/native-linux-unity-hub-registry-capture.py",
           "scripts/native-linux-unity-hub-registry-capture.test.py",
           ".github/workflows/linux-unity-hub-registry-capture.yml", *HELPERS)
FALSE = dict.fromkeys(("hubUiRegistrationAttempted", "hubUiFixtureAccepted", "nonemptyRegistryAccepted",
                      "automaticDiscoveryAccepted", "cliBeta9CompatibilityAccepted", "accountInteractionAttempted",
                      "unityEditorAccepted", "releaseReady"), False)
MAX_LOG, MAX_TAR, MAX_FILE, MAX_ENTRIES = 1024 * 1024, 768 * 1024 * 1024, 256 * 1024 * 1024, 20000
SYSTEM_TOOLS = ("/usr/bin/gpg", "/usr/bin/gpgv", "/usr/bin/dpkg-deb", "/usr/bin/xauth")
GUI_TOOLS = ("/usr/bin/dbus-run-session", "/usr/bin/xvfb-run", "/usr/bin/Xvfb", "/usr/bin/openbox")
DISPLAY_ARGS = "-screen 0 1280x1000x24"
LABELS = {"Unity Hub", "Welcome to Unity Hub", "Sign in", "Sign In", "Create account", "Create Unity ID",
          "Projects", "Add", "Add project from disk", "Install Unity Editor"}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def pin(raw):
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def expected(role):
    size, digest = PINS[role]
    return {"size": size, "sha256": digest}


def identity(info):
    return tuple(getattr(info, name) for name in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid",
                                                "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))


def file_pin(path, limit, wanted=None):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit,
            "Bounded single-link ordinary file required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    digest, size = hashlib.sha256(), 0
    try:
        require(identity(os.fstat(fd)) == identity(before), "Input changed during open")
        while block := os.read(fd, min(65536, limit + 1 - size)):
            size += len(block)
            require(size <= limit, "Input exceeds its bound")
            digest.update(block)
        require(size == before.st_size and identity(os.fstat(fd)) == identity(before)
                and identity(path.lstat()) == identity(before), "Input changed during read")
    finally:
        os.close(fd)
    result = {"size": size, "sha256": digest.hexdigest()}
    require(wanted is None or result == wanted, "Fixed input bytes differ")
    return result


def read(path, limit, wanted=None):
    before = file_pin(path, limit, wanted)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(limit + 1)
    except Exception:
        raise
    require(pin(raw) == before == file_pin(path, limit, wanted), "Input changed between bounded reads")
    return raw


def write_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def save(path, value, limit=65536):
    raw = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    require(len(raw) <= limit, "Evidence JSON exceeds its bound")
    write_new(path, raw)


def private_directory(path):
    os.mkdir(path, 0o700)
    value = path.lstat()
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid()
            and stat.S_IMODE(value.st_mode) == 0o700 and path.resolve(strict=True) == path,
            "Fresh owned private directory required; no permission repair")


def protected_parent(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, "Canonical parent required")
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid())
                and (not info.st_mode & 0o022 or info.st_uid == 0 and info.st_mode & stat.S_ISVTX),
                "Protected parent ancestry required")


def admission(env, system=None, machine=None, uid=None, euid=None):
    system = platform.system() if system is None else system
    machine = platform.machine() if machine is None else machine
    uid = getattr(os, "getuid", lambda: -1)() if uid is None else uid
    euid = getattr(os, "geteuid", lambda: -1)() if euid is None else euid
    require(system == "Linux" and machine == "x86_64" and type(uid) is int and uid > 0 and uid == euid,
            "Ordinary native Linux x64 runner required")
    fixed = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPO, "GITHUB_REPOSITORY_ID": REPO_ID,
             "GITHUB_REF": BRANCH, "GITHUB_WORKFLOW_REF": WORKFLOW, "GITHUB_EVENT_NAME": "workflow_dispatch",
             "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
             "UNITY_HUB_CAPTURE_REQUEST": REQUEST}
    require(all(env.get(name) == value for name, value in fixed.items()), "Exact manual observation context required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")) and all(
        re.fullmatch(r"[1-9][0-9]*", env.get(name, "")) for name in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")),
        "Exact run/source identity required")
    forbidden = r"^(LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|SSL_CERT_|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|UNITY_|HUB_|ELECTRON_|CHROME_|FLATPAK_ID$)"
    blocked = sorted(name for name in env if (re.match(forbidden, name) and name != "UNITY_HUB_CAPTURE_REQUEST")
                     or name.lower().endswith("proxy"))
    names = [name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name)
             else "sha256:" + hashlib.sha256(name.encode("utf8", errors="surrogatepass")).hexdigest() for name in blocked[:4]]
    require(not blocked, "Inherited injection or sandbox/trust override refused; " + json.dumps(
        {"forbiddenEnvNames": names, "omitted": max(0, len(blocked) - len(names))}, separators=(",", ":")))


def root_path(env):
    parent = Path(env["RUNNER_TEMP"])
    protected_parent(parent)
    return parent / DIRECTORY


def source_gate(env):
    workspace = Path(env["GITHUB_WORKSPACE"])
    require(workspace == HERE.parent and workspace.resolve(strict=True) == workspace, "Exact checked-out source required")
    return {name: file_pin(workspace / name, 2 * 1024 * 1024) for name in SOURCES}


def environment(root):
    home = root / "home"
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
            "XDG_CACHE_HOME": str(home / "cache"), "XDG_RUNTIME_DIR": str(root / "runtime"), "TMPDIR": str(root / "tmp")}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def download(role, destination):
    require(role in URLS, "Only fixed public Unity objects may be downloaded")
    origin, canonical = URLS[role]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    # Follow exactly the observed official-to-official mapping, never arbitrary redirects.
    try:
        response = opener.open(origin, timeout=30)
    except urllib.error.HTTPError as error:
        try:
            require(error.code == 302 and error.headers.get("Location") == canonical
                    and len(error.read(4097)) <= 4096, "Unreviewed Unity redirect refused")
        finally:
            error.close()
        response = opener.open(canonical, timeout=30)
    deadline, size, digest = time.monotonic() + 180, 0, hashlib.sha256()
    with response:
        require(response.status == 200 and response.geturl() in (origin, canonical), "Exact public HTTPS object required")
        require(response.headers.get("Content-Length") in (None, str(PINS[role][0])), "Unexpected object size")
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, "wb") as stream:
            while True:
                require(time.monotonic() <= deadline, "Public object deadline; no retry")
                block = response.read(min(65536, PINS[role][0] + 1 - size))
                if not block:
                    break
                size += len(block)
                require(size <= PINS[role][0], "Public object exceeded its bound")
                stream.write(block)
                digest.update(block)
            stream.flush()
            os.fsync(stream.fileno())
    require({"size": size, "sha256": digest.hexdigest()} == expected(role), "Pinned public object changed")
    return file_pin(destination, PINS[role][0], expected(role))


def system_tool(path):
    require(path in (*SYSTEM_TOOLS, *GUI_TOOLS), "Unreviewed system executable")
    for item in (Path(path), *Path(path).parents):
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "Protected ordinary system executable/ancestry required")
    require(Path(path).is_file() and os.access(path, os.X_OK), "Required system executable unavailable")
    return file_pin(Path(path), MAX_FILE)


def prerequisites(env):
    admission(env)
    tools = {path: system_tool(path) for path in (*SYSTEM_TOOLS, *GUI_TOOLS)}
    import gi
    for namespace, version in (("Atspi", "2.0"), ("Gdk", "3.0"), ("GdkX11", "3.0")):
        gi.require_version(namespace, version)
    from gi.repository import Atspi, Gdk, GdkX11
    require(all(value is not None for value in (Atspi, Gdk, GdkX11)), "Fixed native GI namespaces unavailable")
    return {"systemTools": tools, "candidateExecuted": False, **FALSE}


class Drain:
    """Owned pipe capture; overflow is retained and fails, never accepted as truncated success."""
    def __init__(self, child, directory, label, stdout_limit=MAX_LOG):
        self.selector, self.rows = selectors.DefaultSelector(), {}
        for name, stream, maximum in (("stdout", child.stdout, stdout_limit), ("stderr", child.stderr, MAX_LOG)):
            path = directory / (label + "." + name)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            row = {"path": path, "stream": stream, "file": os.fdopen(fd, "wb"), "bytesSeen": 0,
                   "maximum": maximum, "retainedBytes": 0, "eof": False, "overflow": False}
            self.rows[name] = row
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, row)

    def pump(self, wait=0.02):
        for key, _events in self.selector.select(wait):
            row = key.data
            block = os.read(key.fd, 65536)
            if not block:
                row["eof"] = True
                self.selector.unregister(key.fileobj)
                continue
            row["bytesSeen"] += len(block)
            kept = block[:max(0, row["maximum"] - row["retainedBytes"])]
            row["file"].write(kept)
            row["file"].flush()
            row["retainedBytes"] += len(kept)
            row["overflow"] = row["bytesSeen"] > row["maximum"]

    def check(self):
        require(not any(row["overflow"] for row in self.rows.values()), "Owned output overflow; partial evidence retained")

    def complete(self):
        return all(row["eof"] for row in self.rows.values())

    def metadata(self):
        return {name: {**{key: row[key] for key in ("bytesSeen", "retainedBytes", "maximum", "eof", "overflow")},
                       "file": file_pin(row["path"], row["maximum"])} for name, row in self.rows.items()}

    def close(self):
        self.selector.close()
        for row in self.rows.values():
            row["file"].close()
            row["stream"].close()


def wait_exit(child, output, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        output.pump()
        output.check()
        if child.poll() is not None and output.complete():
            return child.wait(timeout=0)
    raise RuntimeError("Owned process/output deadline; no retry or forced shutdown")


def run_tool(root, role, args, *, body=None, maximum=MAX_LOG, seconds=30):
    before = system_tool(args[0])
    child = subprocess.Popen(args, cwd=root, env=environment(root), shell=False, close_fds=True,
                             stdin=subprocess.PIPE if body is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = Drain(child, root / "evidence", role, maximum)
    result = {"role": role, "pid": child.pid, "command": args, "exitCode": None}
    try:
        if body is not None:
            require(len(body) <= 16384, "Bounded public verification input required")
            child.stdin.write(body)
            child.stdin.close()
        result["exitCode"] = wait_exit(child, output, seconds)
        require(result["exitCode"] == 0 and system_tool(args[0]) == before, "Fixed system tool failed or changed")
        return root / "evidence" / (role + ".stdout")
    finally:
        result["streams"] = output.metadata()
        output.close()
        save(root / "evidence" / (role + ".json"), result)


def stanza(raw):
    message = Parser().parsestr(raw.decode("utf8", errors="strict"))
    require(not message.defects and not message.get_payload().strip() and all(
        len(message.get_all(key, [])) == 1 for key in message.keys()), "Unambiguous DEB822 stanza required")
    return message


def index_binding(release, compressed):
    text = release.decode("ascii", errors="strict")
    fields = stanza(release)
    require(fields["Suite"] == fields["Codename"] == "stable" and fields["Origin"] == "Artifactory"
            and fields["Date"] == "Tue, 13 Oct 2026 21:12:32 UTC", "Exact signed stable snapshot required")
    rows = [line.split() for line in fields["SHA256"].splitlines() if line.strip()]
    selected = [row for row in rows if len(row) == 3 and row[2] == "main/binary-amd64/Packages.gz"]
    require(len(selected) == 1 and selected[0][:2] == [expected("packages")["sha256"], str(PINS["packages"][0])],
            "Signed package-index pin differs")
    require(pin(compressed) == expected("packages"), "Package index changed")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = decoder.decompress(compressed, PINS["packages-raw"][0] + 1)
    require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
            and pin(raw) == expected("packages-raw"), "Bounded single gzip index required")
    matches = [stanza(part) for part in raw.split(b"\n\n") if part.strip()]
    matches = [entry for entry in matches if entry["Package"] == PACKAGE and entry["Version"] == VERSION
               and entry["Architecture"] == "amd64"]
    require(len(matches) == 1, "One exact official amd64 Hub candidate required")
    entry = matches[0]
    require(entry["Filename"] == DEB_MEMBER and entry["Size"] == str(PINS["deb"][0])
            and entry["SHA256"] == PINS["deb"][1] and entry["Installed-Size"] == "514709", "Signed DEB identity differs")
    return {key: entry[key] for key in ("Package", "Version", "Architecture", "Filename", "Size", "SHA256",
                                       "Depends", "Pre-Depends", "Recommends", "Installed-Size")}


def verify_metadata(root):
    for role in ("key", "inrelease", "packages"):
        download(role, root / "inputs" / role)
    key = read(root / "inputs/key", 16384, expected("key"))
    ring = run_tool(root, "key-dearmor", ["/usr/bin/gpg", "--no-options", "--batch", "--homedir",
                    str(root / "verification"), "--dearmor"], body=key)
    verified = run_tool(root, "apt-signature", ["/usr/bin/gpgv", "--homedir", str(root / "verification"),
                        "--keyring", str(ring), "--status-fd", "2", "--output", "-", str(root / "inputs/inrelease")])
    status = read(root / "evidence/apt-signature.stderr", MAX_LOG).decode("utf8", errors="strict")
    valid = re.findall(r"^\[GNUPG:\] VALIDSIG ([A-F0-9]{40}) .* ([A-F0-9]{40})$", status, re.M)
    require(valid == [(FINGERPRINT, FINGERPRINT)] and not re.search(
        r"^\[GNUPG:\] (?:BADSIG|ERRSIG|NO_PUBKEY|EXPSIG|EXPKEYSIG|REVKEYSIG)\b", status, re.M), "Exact current Unity signing key required")
    return index_binding(read(verified, 16384), read(root / "inputs/packages", 16384, expected("packages")))


def payload_name(value):
    name = value[2:] if value.startswith("./") else value
    require(0 < len(name.encode("utf8")) <= 4096 and not name.startswith("/") and "\\" not in name
            and not re.search(r"[\x00-\x1f\x7f]", name)
            and all(part not in ("", ".", "..") for part in name.split("/")), "Unsafe package member")
    return name


def inventory(archive_path):
    records, total = {}, 0
    with tarfile.open(archive_path, mode="r:") as archive:
        for member in archive:
            if member.name in (".", "./") and member.isdir():
                continue
            name = payload_name(member.name.rstrip("/") if member.isdir() else member.name)
            require(name not in records and len(records) < MAX_ENTRIES and 0 <= member.size <= MAX_FILE
                    and not member.sparse and (member.isfile() or member.isdir() or member.issym()),
                    "Duplicate, special, hard-linked, sparse or excessive package member")
            special = member.mode & 0o7000
            require(not special or name == "opt/unityhub/chrome-sandbox" and member.isfile() and special == 0o4000,
                    "Unreviewed privileged package member")
            record = {"mode": member.mode & 0o7777, "archiveUid": member.uid, "archiveGid": member.gid,
                      "kind": "file" if member.isfile() else "directory" if member.isdir() else "symlink"}
            if member.isfile():
                total += member.size
                require(total <= MAX_TAR, "Unpacked payload exceeds bound")
                source = archive.extractfile(member)
                digest, size = hashlib.sha256(), 0
                while block := source.read(65536):
                    size += len(block)
                    digest.update(block)
                require(size == member.size, "Truncated package member")
                record.update(size=size, sha256=digest.hexdigest())
            elif member.issym():
                target = member.linkname
                require(0 < len(target) <= 4096 and "\\" not in target and not re.search(r"[\x00-\x1f\x7f]", target), "Unsafe package link")
                resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(name), target))
                require(not resolved.startswith(("../", "/")) and resolved not in (".", ".."), "Escaping package link")
                record.update(target=target, resolved=resolved)
            records[name] = record
    for name, value in records.items():
        require(all(str(parent) not in records or records[str(parent)]["kind"] == "directory"
                    for parent in PurePosixPath(name).parents if str(parent) != "."), "Package writes through non-directory member")
        if value["kind"] == "symlink":
            target, seen = value["resolved"], {name}
            for _ in range(16):
                require(target in records and target not in seen, "Unresolved or cyclic package link")
                seen.add(target)
                if records[target]["kind"] != "symlink":
                    break
                target = records[target]["resolved"]
            else:
                raise RuntimeError("Package link chain exceeds bound")
    require(records, "Empty package payload")
    return records


def verify_extracted(directory, records):
    found = set()
    for current, folders, files in os.walk(directory, followlinks=False):
        for name in (*folders, *files):
            path = Path(current) / name
            relative = path.relative_to(directory).as_posix()
            require(relative in records, "Unrecorded extracted package entry")
            found.add(relative)
            item, info = records[relative], path.lstat()
            require(info.st_uid == os.getuid(), "Rootless extraction must remain owned by the runner")
            if item["kind"] == "symlink":
                require(stat.S_ISLNK(info.st_mode) and os.readlink(path) == item["target"], "Extracted package link differs")
            else:
                require(stat.S_IMODE(info.st_mode) == item["mode"], "Extracted package mode differs; no permission repair")
                if item["kind"] == "directory":
                    require(stat.S_ISDIR(info.st_mode), "Extracted package directory differs")
                else:
                    file_pin(path, MAX_FILE, {key: item[key] for key in ("size", "sha256")})
    require(found == set(records), "Extracted package inventory differs")


def launch_image(directory, records):
    desktop = "usr/share/applications/unityhub.desktop"
    executable = "opt/unityhub/unityhub"
    require(records.get(desktop, {}).get("kind") == records.get(executable, {}).get("kind") == "file", "Exact Hub desktop/native roles required")
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read_string(read(directory / desktop, 16384).decode("utf8"))
    entry = parser["Desktop Entry"]
    require(entry["Name"] == "Unity Hub" and entry["Type"] == "Application", "Official Hub desktop identity differs")
    args = shlex.split(entry["Exec"])
    require(args and args[0] == "/" + executable and args[1:] in ([], ["%U"], ["%u"], ["%F"], ["%f"]),
            "Only normal native Hub launch is allowed; no wrapper or sandbox flags")
    path = directory / executable
    value = file_pin(path, MAX_FILE, {key: records[executable][key] for key in ("size", "sha256")})
    with path.open("rb") as stream:
        head = stream.read(20)
    require(len(head) == 20 and head[:7] == b"\x7fELF\x02\x01\x01" and int.from_bytes(head[16:18], "little") in (2, 3)
            and head[18:20] == b"\x3e\x00" and records[executable]["mode"] & 0o111, "Native x64 Hub ELF required")
    return {"relative": executable, **value}


def stage(env):
    admission(env)
    sources = source_gate(env)
    root = root_path(env)
    private_directory(root)
    for name in ("inputs", "verification", "image", "home", "home/config", "home/data", "home/cache", "runtime", "tmp", "evidence"):
        private_directory(root / name)
    report = {"schemaVersion": 1, "source": env["GITHUB_SHA"], "runId": env["GITHUB_RUN_ID"],
              "sources": sources, "stageComplete": False, "candidateExecuted": False, "phase": "metadata", **FALSE}
    try:
        report["package"] = verify_metadata(root)
        report["phase"] = "verified-installer-download"
        download("deb", root / "inputs/hub.deb")
        report["phase"] = "package-data-inspection"
        control_path = run_tool(root, "deb-control", ["/usr/bin/dpkg-deb", "--field", str(root / "inputs/hub.deb")])
        control = stanza(read(control_path, 65536))
        require(all(control[key] == report["package"][key] for key in ("Package", "Version", "Architecture", "Depends", "Pre-Depends", "Installed-Size")),
                "DEB control differs from the signed index")
        archive = run_tool(root, "deb-payload", ["/usr/bin/dpkg-deb", "--fsys-tarfile", str(root / "inputs/hub.deb")], maximum=MAX_TAR, seconds=120)
        records = inventory(archive)
        save(root / "evidence/payload-inventory.json", records, 8 * 1024 * 1024)
        report["phase"] = "rootless-extraction"
        run_tool(root, "deb-extract", ["/usr/bin/dpkg-deb", "--extract", str(root / "inputs/hub.deb"), str(root / "image")], seconds=120)
        verify_extracted(root / "image", records)
        report["image"] = launch_image(root / "image", records)
        require(file_pin(root / "inputs/hub.deb", PINS["deb"][0], expected("deb")) == expected("deb"), "Installer changed after extraction")
        require(source_gate(env) == sources, "Source changed during staging")
        report.update(stageComplete=True, phase="staged-not-launched", privilegedSetupPerformed=False,
                      maintainerScriptsExecuted=False, dependenciesInstalled=False)
    except Exception as error:
        report["refusal"] = type(error).__name__ + ": " + str(error)[:512]
        raise
    finally:
        save(root / "evidence/stage.json", report)


def review_stage(env):
    admission(env)
    root = root_path(env)
    report = json.loads(read(root / "evidence/stage.json", 65536))
    require(report["stageComplete"] is True and report["source"] == env["GITHUB_SHA"]
            and report["runId"] == env["GITHUB_RUN_ID"] and report["sources"] == source_gate(env)
            and all(report[name] is False for name in FALSE), "Current exact data-only stage required")
    file_pin(root / "inputs/hub.deb", PINS["deb"][0], expected("deb"))
    records = json.loads(read(root / "evidence/payload-inventory.json", 8 * 1024 * 1024))
    verify_extracted(root / "image", records)
    require(launch_image(root / "image", records) == report["image"], "Staged launch image changed")
    return root, report


def session_command(root):
    values = environment(root)
    return ["/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a", "--server-args=" + DISPLAY_ARGS,
            "/usr/bin/env", *(name + "=" + value for name, value in values.items()),
            "/usr/bin/python3", "-I", "-B", str(HERE / "native-linux-unity-hub-registry-capture.py"), "observe"]


def session(env):
    root, _stage = review_stage(env)
    save(root / "evidence/session-attempt.json", {"source": env["GITHUB_SHA"], "attemptConsumed": True, **FALSE})
    # Preserve only the exact Actions admission fields, never ambient credentials or sandbox flags.
    child_env = {key: env[key] for key in ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF",
                 "GITHUB_WORKFLOW_REF", "GITHUB_EVENT_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
                 "GITHUB_WORKSPACE", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "UNITY_HUB_CAPTURE_REQUEST")}
    child_env.update(environment(root))
    output = None
    result = {"pid": None, "exitCode": None, "failureClass": "environment-unqualified", **FALSE}
    try:
        for tool in GUI_TOOLS:
            system_tool(tool)
        child = subprocess.Popen(session_command(root), env=child_env, cwd=root, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, close_fds=True)
        result["pid"] = child.pid
        output = Drain(child, root / "evidence", "session")
        result["exitCode"] = wait_exit(child, output, 150)
        require(result["exitCode"] == 0, "First-run observation refused; inspect retained owned evidence")
    except Exception as error:
        result["refusal"] = type(error).__name__ + ": " + str(error)[:512]
        raise
    finally:
        if output is not None:
            result["streams"] = output.metadata()
            output.close()
        save(root / "evidence/session.json", result)


def helpers():
    result = []
    for name, relative in (("unity_hub_window", HELPERS[0]), ("unity_hub_bitmap", HELPERS[1])):
        specification = importlib.util.spec_from_file_location(name, HERE.parent / relative)
        module = importlib.util.module_from_spec(specification)
        sys.modules[name] = module
        specification.loader.exec_module(module)
        result.append(module)
    return result


def wm_client_ids(x11):
    """Inventory may be empty; only the later XRes check establishes window ownership."""
    root = x11.x.XDefaultRootWindow(x11.display)
    value = x11.property(root, "_NET_CLIENT_LIST_STACKING")
    require(type(value) is tuple and len(value) == 3 and value[:2] == (33, 32)
            and type(value[2]) is list and len(value[2]) <= 32
            and all(type(xid) is int and 0 < xid <= 0xffffffff for xid in value[2])
            and len(set(value[2])) == len(value[2]), "Bounded exact local WM inventory unavailable")
    return value[2]


def sandbox_observation(root):
    values = {}
    for name in ("/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/user/max_user_namespaces",
                 "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"):
        try:
            with open(name, encoding="ascii") as stream:
                value = stream.read(65)
            require(re.fullmatch(r"[0-9]+\n?", value) and len(value) <= 64, "Unrecognized namespace metadata")
            values[name] = value.strip()
        except FileNotFoundError:
            values[name] = None
    path = root / "image/opt/unityhub/chrome-sandbox"
    helper = None
    if os.path.lexists(path):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode), "Sandbox helper is not an ordinary extracted file")
        helper = {"uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode),
                  "rootOwned4755": info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o4755}
    return {"readOnly": True, "kernelSettings": values, "chromeSandbox": helper,
            "userNamespaceOperationProven": False, "settingsChanged": False, "sandboxDisabled": False}


def sanitize_ax(value):
    require(type(value) is dict and type(value.get("nodes")) is list and len(value["nodes"]) <= 512
            and value.get("actionCount") == 0, "Bounded observation-only AX result required")
    result = []
    for node in value["nodes"]:
        name = node.get("name", "")
        require(type(name) is str and len(name) <= 256, "AX name exceeds bound")
        result.append({**{key: node[key] for key in ("role", "showing", "enabled", "sensitive", "defunct", "busy")},
                       "label": name if name in LABELS else None, "nameSha256": hashlib.sha256(name.encode()).hexdigest()})
    return result


def classify_ax(nodes):
    visible = {node["label"] for node in nodes if node["showing"] is True}
    if visible.intersection({"Sign in", "Sign In"}) and not {"Projects", "Add"}.issubset(visible):
        return "sign-in-surface-observed-no-interaction"
    if {"Projects", "Add"}.issubset(visible):
        return "projects-and-add-visible-not-tested"
    return "unclassified-no-input-authorized"


def observe(env):
    root, staged = review_stage(env)
    require(env.get("DISPLAY") and env.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:")
            and all(env.get(name) == value for name, value in environment(root).items()), "Exact isolated GUI environment required")
    read(root / "evidence/session-attempt.json", 65536)
    save(root / "evidence/gui-attempt.json", {"source": env["GITHUB_SHA"], "attemptConsumed": True, **FALSE})
    report = {"schemaVersion": 1, "scope": "official-Hub-first-run-observation-only", "phase": "prerequisites",
              "candidateExecuted": False, "normalCloseAttempted": False, "normalCloseObserved": False,
              "observationCaptured": False, "failureClass": "environment-unqualified", **FALSE}
    child = output = wm = wm_output = x11 = request = process = bound = None
    try:
        helper, native = helpers()
        import gi
        gi.require_version("Atspi", "2.0")
        gi.require_version("Gdk", "3.0")
        from gi.repository import Atspi, Gdk
        Gdk.init([])
        report["sandbox"] = sandbox_observation(root)
        system_tool("/usr/bin/openbox")
        wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], env={**environment(root), **{
            key: env[key] for key in ("DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS") if key in env}},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, close_fds=True)
        wm_output = Drain(wm, root / "evidence", "openbox")
        x11 = helper.X11()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"):
            wm_output.pump()
            wm_output.check()
            require(wm.poll() is None, "Owned window manager exited")
        require(x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK")
                and not wm_client_ids(x11), "Fresh owned desktop readiness required")
        executable = root / "image" / staged["image"]["relative"]
        file_pin(executable, MAX_FILE, {key: staged["image"][key] for key in ("size", "sha256")})
        gui_env = {**environment(root), **{key: env[key] for key in ("DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS") if key in env}}
        report["phase"] = "normal-startup"
        child = subprocess.Popen([str(executable)], cwd=executable.parent, env=gui_env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, close_fds=True)
        report.update(candidateExecuted=True, pid=child.pid)
        output = Drain(child, root / "evidence", "hub")
        process = native.native_process(child.pid, helper)
        require(process["parentPid"] == os.getpid() and process["uids"] == [os.getuid()] * 4
                and process["executable"] == str(executable) and process["kernelImageSha256"] == staged["image"]["sha256"],
                "Owned signed Hub process/image required")
        report["process"] = process
        deadline, window = time.monotonic() + 45, None
        while time.monotonic() < deadline:
            output.pump()
            output.check()
            wm_output.pump()
            wm_output.check()
            require(child.poll() is None and native.native_process(child.pid, helper) == process, "Owned Hub exited or changed before capture")
            clients = wm_client_ids(x11)
            if clients:
                require(len(clients) == 1, "Ambiguous first-run windows; no input authorized")
                candidate = x11.inspect(clients[0])
                require(candidate["pid"] == child.pid and candidate["mapped"] is True and candidate["client"] > 0,
                        "First-run window is not the exact owned Hub")
                window, bound = clients[0], candidate
                break
        require(window is not None, "No owned Hub window before deadline")
        request = helper.Request.parse(["snapshot", str(child.pid), process["startTime"], str(executable),
                                        staged["image"]["sha256"], str(window), bound["title"], "FRAME"])
        report.update(window=window, xres=bound, phase="owned-first-run-capture")
        try:
            ax = sanitize_ax(helper.perform(request, Atspi, helper.Proc(), x11))
            save(root / "evidence/ax.json", {"nodes": ax, "actionCount": 0}, 196608)
            report["firstRunState"] = classify_ax(ax)
        except Exception as error:
            report["axUnavailable"] = type(error).__name__
            report["firstRunState"] = "unclassified-no-input-authorized"
        report["surface"] = native.bitmap(request, root / "evidence", helper, x11)
        require(native.native_process(child.pid, helper) == process and x11.inspect(window) == bound, "Hub changed during observation")
        report.update(observationCaptured=True, phase="observation-complete-no-registration")
    except Exception as error:
        report["refusal"] = type(error).__name__ + ": " + str(error)[:512]
        raise
    finally:
        try:
            if request is not None and child.poll() is None:
                require(native.native_process(child.pid, helper) == process and x11.inspect(request.window) == bound,
                        "Owned normal-close guard changed; no close attempted")
                x11.check_close(request.window)
                write_new(root / "evidence/normal-close-intent.json", json.dumps({"pid": child.pid,
                    "startTime": process["startTime"], "window": request.window, "oneAttempt": True}).encode())
                report["normalCloseAttempted"] = True
                x11.close_window(request.window, bound)
                report["exitCode"] = wait_exit(child, output, 15)
                require(report["exitCode"] == 0 and not wm_client_ids(x11), "Normal Hub close was not confirmed")
                report["normalCloseObserved"] = True
            if output is not None:
                if child.poll() is not None:
                    wait_exit(child, output, 5)
                else:
                    output.pump(0)
                report["streams"] = output.metadata()
                output.check()
            require(source_gate(env) == staged["sources"], "Source changed during observation")
        except Exception as error:
            report["teardownRefusal"] = type(error).__name__ + ": " + str(error)[:512]
            raise
        finally:
            if output is not None:
                if "streams" not in report:
                    report["streams"] = output.metadata()
                output.close()
            if wm_output is not None:
                wm_output.pump(0)
                report["windowManagerStreams"] = wm_output.metadata()
                wm_output.close()
            if x11 is not None:
                x11.dispose()
            report["disposableRunnerTeardownRequired"] = True
            save(root / "evidence/observation.json", report)


if __name__ == "__main__":
    require(len(sys.argv) == 2 and sys.argv[1] in ("admit", "prerequisites", "stage", "session", "observe"), "Only finite capture phases exist")
    {"admit": admission, "prerequisites": prerequisites, "stage": stage, "session": session, "observe": observe}[sys.argv[1]](os.environ)
