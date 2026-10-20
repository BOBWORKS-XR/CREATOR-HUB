"""Finite beta.9 read-only/private-registration probes; no Hub UI/discovery acceptance."""
import hashlib
from functools import partial
import json
import os
from pathlib import Path
import platform
import re
import selectors
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = "BOBWORKS-XR/CREATOR-HUB"
REPO_ID = "1364807512"
BRANCH = "refs/heads/validation/linux-unity-registry-probe"
WORKFLOW = REPO + "/.github/workflows/linux-unity-registry-probe.yml@" + BRANCH
REQUEST = "execute-readonly-beta9"
REGISTRATION_REQUEST = "execute-private-registration-pagination-beta9"
REGISTRATION_ROOT = "linux-unity-registry-pagination-probe"
PROJECT_NAMES = tuple("probe-project-" + str(index).zfill(2) for index in range(1, 14))
PROJECT_FILES = {"Assets/Probe.txt": b"Synthetic Creator Hub CLI pagination fixture; no Editor execution.\n",
                 "Packages/manifest.json": b'{"dependencies":{}}\n',
                 "ProjectSettings/ProjectVersion.txt": b"m_EditorVersion: 6000.3.21f1\n"}
VERSION = "1.0.0-beta.9"
ASSET = {"filename": "unity-linux-x64", "size": 23515432,
         "sha256": "8c0d6e2435449c8be7f0e6b2ce6330bfc5f17a98aec4b659c859940455dd0fe5"}
URL = "https://public-cdn.cloud.unity3d.com/hub/prod/cli/" + VERSION + "/" + ASSET["filename"]
MANIFEST = "modules/project-setup/src-tauri/src/unity-cli-release.json"
SOURCES = ("scripts/" + Path(__file__).name, "scripts/native-linux-unity-cli-registry-probe.test.py",
           ".github/workflows/linux-unity-registry-probe.yml", MANIFEST, "src-tauri/src/projects.rs")
COMMANDS = (
    ("version", ("--version",)),
    ("help", ("--help",)),
    ("projects-help", ("projects", "--help")),
    ("list-help", ("projects", "list", "--help")),
    ("add-help-only", ("projects", "add", "--help")),
    ("env", ("env", "--non-interactive", "--no-banner", "--no-pager")),
    ("list", ("projects", "list", "--json", "--non-interactive", "--no-banner", "--no-pager")),
)
FALSE = dict.fromkeys(("nonemptyRegistryAccepted", "automaticDiscoveryAccepted", "unityEditorAccepted",
                       "hubUiFixtureAccepted", "releaseReady"), False)
STDOUT_LIMIT, STDERR_LIMIT, COMMAND_SECONDS = 128 * 1024, 64 * 1024, 45
REGISTRATION_FILE_LIMIT = 32 * 1024 * 1024  # Conservative per-file test cap, not a vendor requirement.


def require(value, message):
    if not value:
        raise RuntimeError(message)


def pin(raw):
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def verified_elf(raw):
    require(pin(raw) == {key: ASSET[key] for key in ("size", "sha256")}
            and len(raw) >= 64 and raw[:7] == b"\x7fELF\x02\x01\x01"
            and int.from_bytes(raw[16:18], "little") in (2, 3) and raw[18:20] == b"\x3e\x00",
            "Pinned ordinary x86_64 ELF required")


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_regular(path, limit, expected=None):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit,
            "Bounded single-link ordinary file required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        require(identity(os.fstat(fd)) == identity(before), "File changed during open")
        raw = bytearray()
        while len(raw) <= limit:
            part = os.read(fd, min(65536, limit + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        require(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before)
                and identity(path.lstat()) == identity(before), "File changed or exceeded its bound")
    finally:
        os.close(fd)
    raw = bytes(raw)
    require(expected is None or pin(raw) == expected, "Fixed file bytes differ")
    return raw


def protected_parent(path, uid):
    require(path.is_absolute() and len(str(path)) <= 4096 and ".." not in path.parts
            and path.resolve(strict=True) == path, "Canonical existing parent required")
    for ancestor in (path, *path.parents):
        info = ancestor.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid)
                and (not info.st_mode & 0o022 or info.st_uid == 0 and info.st_mode & stat.S_ISVTX),
                "Protected directory ancestry required; no permission repair")


def private_directory(path, uid):
    os.mkdir(path, 0o700)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700
            and path.resolve(strict=True) == path, "New private directory creation failed")


def admission(env, system=None, machine=None, uid=None, euid=None):
    system = platform.system() if system is None else system
    machine = platform.machine() if machine is None else machine
    uid = getattr(os, "getuid", lambda: -1)() if uid is None else uid
    euid = getattr(os, "geteuid", lambda: -1)() if euid is None else euid
    require(system == "Linux" and machine == "x86_64" and type(uid) is int and uid > 0 and uid == euid,
            "Unprivileged native Linux x86_64 runner required")
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPO, "GITHUB_REPOSITORY_ID": REPO_ID,
                "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": BRANCH, "GITHUB_WORKFLOW_REF": WORKFLOW,
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "UNITY_REGISTRY_PROBE_REQUEST": REQUEST}
    require(all(env.get(key) == value for key, value in expected.items()), "Exact manual probe context required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", ""))
            and all(re.fullmatch(r"[1-9][0-9]*", env.get(key, "")) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")),
            "Exact source and run identity required")
    forbidden = r"^(LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|SSL_CERT_|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|UNITY_|HUB_)"
    require(not any((re.match(forbidden, key) and key != "UNITY_REGISTRY_PROBE_REQUEST")
                    or key.lower().endswith("proxy") for key in env), "Inherited injection/trust/Unity overrides refused")
    return uid


def child_environment(root):
    home = root / "home"
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "NO_COLOR": "1", "TERM": "dumb",
            "UNITY_NO_CONSENT_PROMPT": "1",
            "HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
            "XDG_CACHE_HOME": str(home / "cache"), "XDG_RUNTIME_DIR": str(root / "runtime"), "TMPDIR": str(root / "tmp")}


def registration_admission(env, system=None, machine=None, uid=None, euid=None):
    system = platform.system() if system is None else system
    machine = platform.machine() if machine is None else machine
    uid = getattr(os, "getuid", lambda: -1)() if uid is None else uid
    euid = getattr(os, "geteuid", lambda: -1)() if euid is None else euid
    require(system == "Linux" and machine == "x86_64" and type(uid) is int and uid > 0 and uid == euid,
            "Unprivileged native Linux x86_64 runner required")
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPO, "GITHUB_REPOSITORY_ID": REPO_ID,
                "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": BRANCH, "GITHUB_WORKFLOW_REF": WORKFLOW,
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "UNITY_REGISTRY_PROBE_REQUEST": REGISTRATION_REQUEST}
    require(all(env.get(key) == value for key, value in expected.items()), "Exact private registration context required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", ""))
            and all(re.fullmatch(r"[1-9][0-9]*", env.get(key, "")) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")),
            "Exact source and run identity required")
    forbidden = r"^(LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|SSL_CERT_|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|UNITY_|HUB_)"
    require(not any((re.match(forbidden, key) and key != "UNITY_REGISTRY_PROBE_REQUEST")
                    or key.lower().endswith("proxy") for key in env), "Inherited injection/trust/Unity overrides refused")
    return uid


def registration_paths(root):
    require(root.is_absolute() and root.name == REGISTRATION_ROOT and len(str(root)) <= 3072
            and ".." not in root.parts and root.resolve(strict=True) == root,
            "Exact new private pagination root required")
    return tuple(root / "home/projects" / name for name in PROJECT_NAMES)


def new_private_file(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            require(count > 0, "Incomplete private evidence/fixture write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def seed_projects(root, uid):
    paths = registration_paths(root)
    private_directory(root / "home/projects", uid)
    for project in paths:
        for directory in (project, project / "Assets", project / "Packages", project / "ProjectSettings"):
            private_directory(directory, uid)
        for relative, raw in PROJECT_FILES.items():
            new_private_file(project / relative, raw)


def project_inventory(root, uid):
    paths, result = registration_paths(root), {}
    protected_parent(root, uid)
    expected = {root / "home": {"config", "data", "cache", "projects"}, root / "home/projects": set(PROJECT_NAMES)}
    for project in paths:
        expected[project] = {"Assets", "Packages", "ProjectSettings"}
        for directory in ("Assets", "Packages", "ProjectSettings"):
            expected[project / directory] = {Path(name).name for name in PROJECT_FILES if name.startswith(directory + "/")}
    for directory, children in expected.items():
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700
                and directory.resolve(strict=True) == directory, "Private ordinary project ancestry required")
        # HOME also contains CLI-owned registry/config data; only its own identity is retained.
        if directory != root / "home":
            names = set()
            with os.scandir(directory) as entries:
                for entry in entries:
                    require(len(names) < len(children) and entry.name in children, "Unexpected synthetic project inventory")
                    names.add(entry.name)
            require(names == children, "Synthetic project entry missing")
            result[directory.relative_to(root / "home/projects").as_posix()] = {"kind": "directory", "stamp": identity(info)}
    for project in paths:
        for relative, raw in PROJECT_FILES.items():
            path = project / relative
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600, "Private single-link synthetic project file required")
            read_regular(path, 4096, pin(raw))
            require(identity(path.lstat()) == identity(info), "Synthetic project file changed during inventory")
            result[path.relative_to(root / "home/projects").as_posix()] = {"kind": "file", "stamp": identity(info), **pin(raw)}
    return result


def registration_json(raw):
    require(len(raw) <= STDOUT_LIMIT, "Bounded registration JSON required")
    text = raw.decode("utf-8", errors="strict")
    require(not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text), "Unexpected registration output controls")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Ambiguous duplicate JSON member")
            value[key] = item
        return value
    value = json.loads(text, object_pairs_hook=unique, parse_constant=lambda _: require(False, "Nonfinite JSON refused"))
    require(type(value) is dict and value.get("success") is True and value.get("errors") == []
            and value.get("warnings") == [], "CLI registration/list failure or partial result; no retry")
    return value


def listed_projects(raw, root, *, all_projects):
    value, known = registration_json(raw), {str(path): path.name for path in registration_paths(root)}
    rows = value.get("data")
    require(type(rows) is list and len(rows) <= 13, "Expected bounded actual project row array")
    found = set()
    for row in rows:
        require(type(row) is dict and type(row.get("path")) is str and row["path"] in known
                and row["path"] not in found, "Unknown, duplicate or ambiguous project path refused")
        found.add(row["path"])
    require(not all_projects or found == set(known), "All-projects readback did not include the exact 13 fixtures")
    return {known[path] for path in found}


def source_binding(workspace):
    require(workspace == HERE.parent and workspace.resolve(strict=True) == workspace, "Exact checked-out probe source required")
    files = {name: pin(read_regular(workspace / name, 2 * 1024 * 1024)) for name in SOURCES}
    manifest = json.loads(read_regular(workspace / MANIFEST, 16384))
    require(manifest["version"] == VERSION and manifest["binaries"]["linux-x64"] == ASSET,
            "Repository's exact beta.9 Linux asset manifest required")
    return files


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Unity download redirect refused")


def download(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline, size, digest = time.monotonic() + 120, 0, hashlib.sha256()
    with opener.open(URL, timeout=30) as response:
        require(response.status == 200 and response.geturl() == URL, "Exact HTTPS asset response required")
        length = response.headers.get("Content-Length")
        require(length is None or length == str(ASSET["size"]), "Asset response size differs")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o500)
        try:
            while True:
                require(time.monotonic() <= deadline, "Asset download deadline")
                block = response.read(min(65536, ASSET["size"] + 1 - size))
                if not block:
                    break
                size += len(block)
                require(size <= ASSET["size"], "Asset response exceeded fixed size")
                digest.update(block)
                view = memoryview(block)
                while view:
                    count = os.write(fd, view)
                    require(count > 0, "Short asset write")
                    view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
    require({"size": size, "sha256": digest.hexdigest()} == {key: ASSET[key] for key in ("size", "sha256")},
            "Downloaded asset differs from pinned beta.9")


class HeldBinary:
    def __init__(self, path, uid):
        self.path, self.uid, self.fd = path, uid, None
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid
                and stat.S_IMODE(info.st_mode) == 0o500 and info.st_size == ASSET["size"], "Protected fixed helper required")
        self.fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            self.before = info
            self.check()
        except Exception:
            self.close()
            raise

    def check(self):
        require(identity(os.fstat(self.fd)) == identity(self.before)
                and identity(self.path.lstat()) == identity(self.before), "Held helper identity changed")
        os.lseek(self.fd, 0, os.SEEK_SET)
        raw = bytearray()
        while len(raw) <= ASSET["size"]:
            block = os.read(self.fd, min(65536, ASSET["size"] + 1 - len(raw)))
            if not block:
                break
            raw.extend(block)
        verified_elf(raw)
        require(identity(os.fstat(self.fd)) == identity(self.before)
                and identity(self.path.lstat()) == identity(self.before), "Helper changed during verification")
        return raw

    def close(self):
        if self.fd is not None:
            os.close(self.fd); self.fd = None


class SealedImage:
    def __init__(self, source, uid):
        import fcntl
        self.source, self.uid, self.fd, self.control = source, uid, None, fcntl
        raw = source.check()
        verified_elf(raw)
        self.seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        self.fd = os.memfd_create("creator-unity-registry", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        try:
            view = memoryview(raw)
            while view:
                count = os.write(self.fd, view)
                require(count > 0, "Short memfd image write")
                view = view[count:]
            os.lseek(self.fd, 0, os.SEEK_SET)
            # This is our newly created anonymous image, never the downloaded source.
            os.fchmod(self.fd, 0o700)
            fcntl.fcntl(self.fd, fcntl.F_ADD_SEALS, self.seals)
            self.before = os.fstat(self.fd)
            self.check()
        except Exception:
            self.close()
            raise

    def check(self):
        self.source.check()
        info = os.fstat(self.fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 0 and info.st_uid == self.uid
                and stat.S_IMODE(info.st_mode) == 0o700 and identity(info) == identity(self.before)
                and not os.get_inheritable(self.fd)
                and self.control.fcntl(self.fd, self.control.F_GET_SEALS) == self.seals,
                "Owned immutable close-on-exec memfd required")
        os.lseek(self.fd, 0, os.SEEK_SET)
        raw = bytearray()
        while len(raw) <= ASSET["size"]:
            block = os.read(self.fd, min(65536, ASSET["size"] + 1 - len(raw)))
            if not block:
                break
            raw.extend(block)
        verified_elf(raw)
        require(identity(os.fstat(self.fd)) == identity(self.before), "Sealed image changed during readback")
        self.source.check()

    def close(self):
        if self.fd is not None:
            os.close(self.fd); self.fd = None


def child_limits(executable_fd):
    import resource
    # CPython makes pass_fds inheritable before preexec_fn. Restore Root's CLOEXEC
    # lifetime: available for exec path resolution, closed in the resulting ELF.
    os.set_inheritable(executable_fd, False)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (STDOUT_LIMIT, STDOUT_LIMIT))


def validate_output(role, raw):
    text = raw.decode("utf-8", errors="strict")
    require(not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text), "Unexpected control characters in helper output")
    if role == "version":
        require(text.strip() == VERSION, "Actual helper version did not match beta.9")
    elif role in ("help", "projects-help", "list-help", "add-help-only"):
        command = {"help": "unity", "projects-help": r"unity\s+projects", "list-help": r"unity\s+projects\s+list",
                   "add-help-only": r"unity\s+projects\s+add"}[role]
        require(re.search(r"\bUsage:\s*" + command + r"\b", text, re.I), "Expected command-specific help was not returned")
        if role == "help":
            require(re.search(r"\bprojects\b", text), "Projects command absent from actual help")
        if role == "projects-help":
            require(all(re.search(r"\b" + name + r"\b", text) for name in ("list", "add")), "Required project commands absent")
    elif role == "env":
        # Its actual output schema/path choices are not yet observed; retain text, not discovery acceptance.
        require(0 < len(raw) <= STDOUT_LIMIT and text.strip(), "Bounded nonempty env diagnostic required")
    else:
        require(role == "list", "Unknown helper output role")
        value = json.loads(text)
        require(type(value) is dict and value.get("success") is True and type(value.get("data")) is list
                and value["data"] == [], "Fresh isolated HOME must return a successful empty list; nonempty fixture deferred")


def run_fixed(tool, specification, root):
    require(specification in COMMANDS, "Only the seven fixed help/read-only commands may execute")
    if specification[0] == "env":
        help_raw = read_regular(root / "evidence/help.stdout", STDOUT_LIMIT)
        validate_output("help", help_raw)
        require(re.search(r"^\s+env\s+Print Unity Hub environment paths and version\s*$", help_raw.decode("utf-8"), re.M),
                "Actual pinned help must advertise the read-only env command")
    record, stdout = _run_command(tool, specification, root)
    require(record["exitCode"] == 0, "Fixed helper command failed: " + record["role"])
    validate_output(record["role"], stdout)
    if record["role"] == "env":
        record["diagnosticOnly"] = True
    return record


def run_registration_fixed(tool, specification, root):
    paths = registration_paths(root)
    allowed = (("hub-help", ("hub", "--help")), ("list-before", COMMANDS[-1][1]),
               ("register", ("projects", "add", *(str(path) for path in paths), *COMMANDS[-1][1][2:])),
               ("list-current", COMMANDS[-1][1]), ("list-all", (*COMMANDS[-1][1], "--all")))
    require(specification in allowed, "Only the fixed private registration/pagination commands may execute")
    if specification[0] in ("register", "list-current", "list-all"):
        project_inventory(root, os.getuid())
    if specification[0] != "hub-help":
        return _run_registration_command(tool, specification, root)
    return _run_command(tool, specification, root)


def _run_command(tool, specification, root):
    role, args = specification
    tool.check()
    evidence = root / "evidence"
    paths = [evidence / (role + suffix) for suffix in (".stdout", ".stderr")]
    handles = []
    try:
        for path in paths:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            handles.append(os.fdopen(fd, "wb"))
        executable = "/proc/self/fd/" + str(tool.fd)
        child = subprocess.Popen([executable, *args], executable=executable, shell=False, pass_fds=(tool.fd,), close_fds=True,
                                 stdin=subprocess.DEVNULL, stdout=handles[0], stderr=handles[1], env=child_environment(root),
                                 cwd=root / "home", preexec_fn=partial(child_limits, tool.fd))
        pid = child.pid
        try:
            code = child.wait(timeout=COMMAND_SECONDS)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=5)
            raise RuntimeError("Owned helper deadline; no retry or other process was signalled") from None
        tool.check()
    finally:
        for handle in handles:
            handle.close()
    stdout = read_regular(paths[0], STDOUT_LIMIT)
    stderr = read_regular(paths[1], STDERR_LIMIT)
    return {"role": role, "pid": pid, "exitCode": code, "stdout": pin(stdout), "stderr": pin(stderr)}, stdout


def execute(env):
    uid = admission(env)
    workspace = Path(env["GITHUB_WORKSPACE"])
    sources = source_binding(workspace)
    parent = Path(env["RUNNER_TEMP"])
    protected_parent(parent, uid)
    root = parent / "linux-unity-registry-probe"
    private_directory(root, uid)
    for name in ("evidence", "home", "home/config", "home/data", "home/cache", "runtime", "tmp", "tool"):
        private_directory(root / name, uid)
    report = {"schemaVersion": 1, "scope": "isolated-official-beta9-help-env-and-empty-list-diagnostic-only", "source": env["GITHUB_SHA"],
              "runId": env["GITHUB_RUN_ID"], "runAttempt": env["GITHUB_RUN_ATTEMPT"], "sources": sources,
              "version": VERSION, "asset": ASSET, "url": URL, "commands": [], "probeCompleted": False,
              "genuineNonemptyFixture": "deferred", "envOutputDiagnosticOnly": True, **FALSE}
    source, tool = None, None
    try:
        binary = root / "tool" / ASSET["filename"]
        download(binary)
        source = HeldBinary(binary, uid)
        tool = SealedImage(source, uid)
        report["tool"] = {"sourceDev": source.before.st_dev, "sourceIno": source.before.st_ino,
                          "dev": tool.before.st_dev, "ino": tool.before.st_ino, "uid": tool.before.st_uid,
                          "mode": stat.S_IMODE(tool.before.st_mode), "seals": tool.seals,
                          "execution": "sealed-memfd-cloexec", "sourceRetained": True,
                          **{key: ASSET[key] for key in ("size", "sha256")}}
        for specification in COMMANDS:
            report["commands"].append(run_fixed(tool, specification, root))
        require(source_binding(workspace) == sources, "Checked-out source changed during probe")
        report["probeCompleted"] = True
    except Exception as error:
        report["refusal"] = type(error).__name__
        raise
    finally:
        if tool is not None:
            tool.close()
        if source is not None:
            source.close()
        raw = (json.dumps(report, sort_keys=True, indent=2) + "\n").encode()
        require(len(raw) <= 16384, "Bounded probe receipt required")
        fd = os.open(root / "evidence/report.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)


def registration_limits(executable_fd):
    import resource
    os.set_inheritable(executable_fd, False)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (REGISTRATION_FILE_LIMIT, REGISTRATION_FILE_LIMIT))


def drain_registration(child, buffers, deadline):
    caps = {"stdout": STDOUT_LIMIT, "stderr": STDERR_LIMIT}
    require(set(buffers) == set(caps) and all(type(buffers[name]) is bytearray and len(buffers[name]) <= caps[name] for name in caps),
            "Bounded private registry output buffers required")
    with selectors.DefaultSelector() as poller:
        for name in caps:
            stream = getattr(child, name)
            os.set_blocking(stream.fileno(), False)
            poller.register(stream, selectors.EVENT_READ, name)
        while poller.get_map():
            remaining = deadline - time.monotonic()
            require(remaining > 0, "Private registry output deadline; no retry")
            for key, _mask in poller.select(min(remaining, 0.25)):
                name = key.data
                left = caps[name] - len(buffers[name])
                try:
                    raw = os.read(key.fd, min(65536, left + 1))
                except BlockingIOError:
                    continue
                if not raw:
                    poller.unregister(key.fileobj)
                    continue
                buffers[name].extend(raw[:left])
                require(len(raw) <= left, "Private registry " + name + " exceeded output cap; no retry")
        remaining = deadline - time.monotonic()
        require(remaining > 0, "Private registry process deadline; no retry")
        return child.wait(timeout=remaining)


def _run_registration_command(tool, specification, root):
    role, args = specification
    tool.check()
    buffers, handles, child, failure, cleanup = {"stdout": bytearray(), "stderr": bytearray()}, [], None, None, None
    code = None
    try:
        for suffix in buffers:
            path = root / "evidence" / (role + "." + suffix)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
                         | getattr(os, "O_BINARY", 0), 0o600)
            handles.append(os.fdopen(fd, "wb"))
        executable = "/proc/self/fd/" + str(tool.fd)
        deadline = time.monotonic() + COMMAND_SECONDS
        child = subprocess.Popen([executable, *args], executable=executable, shell=False, pass_fds=(tool.fd,), close_fds=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=child_environment(root), cwd=root / "home", preexec_fn=partial(registration_limits, tool.fd))
        code = drain_registration(child, buffers, deadline)
        tool.check()
    except Exception as error:
        failure = error
        if child is not None:
            try:
                if child.poll() is None:
                    child.kill(); child.wait(timeout=5)
            except Exception as error:
                cleanup = type(error).__name__
    finally:
        for handle, raw in zip(handles, buffers.values()):
            try:
                require(handle.write(raw) == len(raw), "Private registry output write incomplete")
                handle.flush(); os.fsync(handle.fileno())
            except Exception as error:
                if failure is None:
                    failure = error
            finally:
                try:
                    handle.close()
                except Exception as error:
                    if failure is None:
                        failure = error
        if child is not None:
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except Exception as error:
                        if failure is None:
                            failure = error
    record = {"role": role, "pid": None if child is None else child.pid, "exitCode": code,
              "fileSizeLimit": REGISTRATION_FILE_LIMIT, "fileSizeLimitScope": "per-file-test-cap-not-vendor-requirement",
              "outputComplete": failure is None, **{name: pin(raw) for name, raw in buffers.items()}}
    if code is not None and code < 0:
        record["terminationSignal"] = -code
    if cleanup is not None:
        record["cleanupRefusal"] = cleanup
    if failure is not None:
        failure.registration_record = record
        raise failure
    return record, bytes(buffers["stdout"])


def private_home_metadata(root, uid):
    registration_paths(root)
    protected_parent(root, uid)
    home = root / "home"
    require(home.resolve(strict=True) == home, "Canonical isolated HOME required")
    result = {"scope": "fixed-private-cli-home-metadata-only", "readOnly": True, "complete": False,
              "inputPermitted": False, "releaseReady": False, "entries": []}
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

    def walk(fd, relative, depth):
        require(depth <= 6, "Private HOME metadata depth bound")
        before = os.fstat(fd)
        require(stat.S_ISDIR(before.st_mode) and before.st_uid == uid and not before.st_mode & 0o022,
                "Owned protected metadata directory required")
        with os.scandir(fd) as entries:
            for entry in entries:
                require(len(result["entries"]) < 128 and len(entry.name) <= 128 and entry.name not in (".", "..")
                        and not any(value in entry.name for value in ("/", "\\", "\x00")), "Private HOME metadata entry bound")
                name = (relative + "/" if relative else "") + entry.name
                require(len(name) <= 1024, "Private HOME metadata path bound")
                info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                row = {"path": name, "stamp": identity(info), "size": info.st_size}
                result["entries"].append(row)
                require(info.st_uid == uid, "Foreign private HOME entry refused")
                if stat.S_ISREG(info.st_mode):
                    row["kind"] = "file"
                else:
                    require(stat.S_ISDIR(info.st_mode), "Linked or special private HOME entry refused")
                    row["kind"] = "directory"
                    if name == "projects":
                        row["subtree"] = "separate-exact-project-inventory"
                    else:
                        child = os.open(entry.name, flags, dir_fd=fd)
                        try:
                            require(identity(os.fstat(child)) == identity(info), "Private HOME directory changed during open")
                            walk(child, name, depth + 1)
                        finally:
                            os.close(child)
                require(identity(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)) == identity(info),
                        "Private HOME entry changed during metadata capture")
        require(identity(os.fstat(fd)) == identity(before), "Private HOME directory changed during capture")

    fd = os.open(home, flags)
    try:
        require(identity(os.fstat(fd)) == identity(home.lstat()), "Private HOME changed during open")
        try:
            walk(fd, "", 0)
            require(identity(os.fstat(fd)) == identity(home.lstat()), "Private HOME changed after capture")
            result["complete"] = True
        except Exception as error:
            result["refusal"] = type(error).__name__
    finally:
        os.close(fd)
    return result


def retain_registration_failure_metadata(root, uid, report):
    try:
        value = private_home_metadata(root, uid)
        raw = (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
        require(len(raw) <= 65536, "Private HOME metadata receipt bound")
        new_private_file(root / "evidence/register-home-metadata.json", raw)
        report["registrationFailureHomeMetadata"] = {**pin(raw), "complete": value["complete"], "readOnly": True}
    except Exception as error:
        report["registrationFailureMetadataRefusal"] = type(error).__name__


def project_preservation(before, after):
    names_match = set(before) == set(after)
    files = [name for name, row in before.items() if row["kind"] == "file"]
    directories = [name for name, row in before.items() if row["kind"] == "directory"]
    roots = set(PROJECT_NAMES)
    changes = [{"fixtureId": name, "before": dict(zip(("mtimeNs", "ctimeNs"), before[name]["stamp"][-2:])),
                "after": dict(zip(("mtimeNs", "ctimeNs"), after[name]["stamp"][-2:]))}
               for name in PROJECT_NAMES if name in before and name in after and before[name]["stamp"][-2:] != after[name]["stamp"][-2:]]
    return {"projectFileCount": len(files), "projectFileContentsAndIdentitiesPreserved": names_match and len(files) == 39
            and all(before[name] == after[name] for name in files),
            "projectNestedDirectoryIdentitiesPreserved": names_match
            and all(before[name] == after[name] for name in directories if name not in roots),
            "projectRootNonTimestampMetadataPreserved": names_match
            and roots <= set(before) and all(before[name]["kind"] == after[name]["kind"] == "directory"
                                            and before[name]["stamp"][:-2] == after[name]["stamp"][:-2] for name in roots),
            "projectRootTimestampDrift": changes}


def registration_sequence(tool, root, uid, report):
    for specification in COMMANDS[:5]:
        report["commands"].append(run_fixed(tool, specification, root))
    help_text = read_regular(root / "evidence/help.stdout", STDOUT_LIMIT).decode("utf-8")
    require(re.search(r"^\s+hub\s+Manage the Unity Hub application\s*$", help_text, re.M),
            "Actual pinned top-level help must advertise the Hub command")
    list_help = read_regular(root / "evidence/list-help.stdout", STDOUT_LIMIT).decode("utf-8")
    require("--all" in list_help and "Projects per page (default: 10)" in list_help,
            "Actual beta.9 pagination help differs; no registration attempted")

    def command(specification):
        try:
            record, raw = run_registration_fixed(tool, specification, root)
        except Exception as error:
            record = getattr(error, "registration_record", None)
            if type(record) is dict:
                report["commands"].append(record)
            raise
        report["commands"].append(record)
        require(record["exitCode"] == 0, "Private probe command failed; no retry: " + record["role"])
        return raw

    hub_help = command(("hub-help", ("hub", "--help"))).decode("utf-8", errors="strict")
    require(re.search(r"\bUsage:\s*unity\s+hub\b", hub_help, re.I), "Actual Hub-specific help required")
    before_list = command(("list-before", COMMANDS[-1][1]))
    validate_output("list", before_list)
    registration_json(before_list)
    seed_projects(root, uid)
    before = project_inventory(root, uid)
    before_raw = (json.dumps(before, sort_keys=True) + "\n").encode()
    require(len(before_raw) <= 32768, "Bounded project inventory required")
    new_private_file(root / "evidence/projects-before.json", before_raw)
    report["projectInventoryBefore"] = pin(before_raw)
    try:
        report["registrationAttempted"] = True
        try:
            registration_json(command(("register", ("projects", "add", *(str(path) for path in registration_paths(root)),
                                                      *COMMANDS[-1][1][2:]))))
        except Exception:
            retain_registration_failure_metadata(root, uid, report)
            raise
        report["registrationReturnedSuccess"] = True
        current = listed_projects(command(("list-current", COMMANDS[-1][1])), root, all_projects=False)
        every = listed_projects(command(("list-all", (*COMMANDS[-1][1], "--all"))), root, all_projects=True)
        report.update(currentCount=len(current), allCount=len(every),
                      currentFixtureIds=sorted(current), allFixtureIds=sorted(every), omittedFixtureIds=sorted(every - current),
                      jsonDefaultOmittedFixtures=current != every, paginationCompared=True)
    finally:
        original_failure = sys.exc_info()[0] is not None
        try:
            after = project_inventory(root, uid)
            after_raw = (json.dumps(after, sort_keys=True) + "\n").encode()
            require(len(after_raw) <= 32768, "Bounded project inventory required")
            new_private_file(root / "evidence/projects-after.json", after_raw)
            report["projectInventoryAfter"] = pin(after_raw)
            report.update(project_preservation(before, after))
            require(after == before, "Synthetic project inventory changed; no acceptance")
            report["projectContentsUnchanged"] = True
        except Exception as error:
            report["projectInventoryRefusal"] = type(error).__name__
            if not original_failure:
                raise


def execute_registration(env):
    uid = registration_admission(env)
    workspace = Path(env["GITHUB_WORKSPACE"])
    sources = source_binding(workspace)
    parent = Path(env["RUNNER_TEMP"])
    protected_parent(parent, uid)
    root = parent / REGISTRATION_ROOT
    private_directory(root, uid)
    for name in ("evidence", "home", "home/config", "home/data", "home/cache", "runtime", "tmp", "tool"):
        private_directory(root / name, uid)
    report = {"schemaVersion": 1, "scope": "cli-generated-registry-pagination-only", "source": env["GITHUB_SHA"],
              "runId": env["GITHUB_RUN_ID"], "runAttempt": env["GITHUB_RUN_ATTEMPT"], "sources": sources,
              "version": VERSION, "asset": ASSET, "url": URL, "commands": [], "probeCompleted": False,
              "registrationAttempted": False, "registrationReturnedSuccess": False, "paginationCompared": False,
              "projectContentsUnchanged": False, "genuineNonemptyFixture": "deferred", **FALSE}
    source, tool = None, None
    try:
        binary = root / "tool" / ASSET["filename"]
        download(binary)
        source = HeldBinary(binary, uid)
        tool = SealedImage(source, uid)
        report["tool"] = {"sourceDev": source.before.st_dev, "sourceIno": source.before.st_ino,
                          "dev": tool.before.st_dev, "ino": tool.before.st_ino, "uid": tool.before.st_uid,
                          "mode": stat.S_IMODE(tool.before.st_mode), "seals": tool.seals,
                          "execution": "sealed-memfd-cloexec", "sourceRetained": True,
                          **{key: ASSET[key] for key in ("size", "sha256")}}
        registration_sequence(tool, root, uid, report)
        require(source_binding(workspace) == sources, "Checked-out source changed during probe")
        report["probeCompleted"] = True
    except Exception as error:
        report["refusal"] = type(error).__name__
        raise
    finally:
        if tool is not None:
            tool.close()
        if source is not None:
            source.close()
        raw = (json.dumps(report, sort_keys=True, indent=2) + "\n").encode()
        require(len(raw) <= 16384, "Bounded probe receipt required")
        new_private_file(root / "evidence/report.json", raw)


def main(argv, env):
    require(argv in (["probe"], ["registration-pagination"]), "Only the two fixed manual probe phases exist")
    if argv == ["probe"]:
        execute(env)
    else:
        execute_registration(env)


if __name__ == "__main__":
    main(sys.argv[1:], os.environ)
