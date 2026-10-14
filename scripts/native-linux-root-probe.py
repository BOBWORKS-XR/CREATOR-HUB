"""Pinned Root 14 DEB: disposable native terms acceptance and normal close.

Only the disposable hosted lane may stage or launch. Probe-local action authority
is limited to the two exact Root terms controls and normal Root WM close. The
generic helper and its single-PID policy are unchanged. No module is opened.

Primary bitmap contract (obscured/off-screen pixels are undefined):
https://docs.gtk.org/gdk3/func.pixbuf_get_from_window.html
https://docs.gtk.org/gdk3-x11/ctor.X11Window.foreign_new_for_display.html
Peer PID is diagnostic, not authorization:
https://docs.gtk.org/atspi2/method.Accessible.get_process_id.html
WebKit joins UI/web-process AX trees; this does not authorize arbitrary peers:
https://bugs.webkit.org/show_bug.cgi?id=230255
Exact 2.50.4 Action names are check/uncheck and press, not GTK's click:
https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/AccessibilityObject.cpp
https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityObjectActionAtspi.cpp
"""
import ctypes as C
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import selectors
import stat
import subprocess
import sys
import tarfile
import time
import zipfile
from email.parser import Parser

sys.dont_write_bytecode = True
REPOSITORY = "BOBWORKS-XR/CREATOR-HUB"
REPOSITORY_ID = 1364807512
SOURCE = "5bb05a21d73c0fc3b2839cbcbd4322832b24aead"
TREE = "f91c61a8e29da84e0dbdbfa642d201cd4c6a3279"
RUN, ATTEMPT, JOB = 38630742955, 1, 116081506373
ARTIFACT = 11927495507
ARTIFACT_NAME = "signed-unix-hub-linux-38630742955-1"
ZIP_SIZE = 386824719
ZIP_SHA = "42c5e1a95605158ab084c4cad1db1a6fb5b49f6fe225db9cea868148cccda725"
PINS = {
    "creator-hub": (21364752, "2a09016d9721157afc62ea7163979c75b0c986b05cf0264afda97291b51b3689", 0o755),
    "builtin-manifest.json": (3663, "44de6e0e25890ac2cb20f7f2b16eb3ac151e6b4edb1104c974a9544f291f6fd7", 0o644),
    "modules.tar.gz": (56842646, "c2cffb6f886225d8c841e78497e92c6ede96896e0c5a28c89346254e5fc4a77a", 0o644),
    "signed-unix-assembly.json": (888, "a58370b7a92e4e5ab3400be3765ea289a6a52538d3c4bedb9de98e92b01007a0", 0o644),
}
# Original successful artifact and native DEB members, never CLI input.
DEB_NAME = "Creator Hub_0.1.14_amd64.deb"
DEB_PIN = (62780196, "f0297e74c6ce918b54c248b222af7ac64c3c96c270d281a17a017fb90a7714ec", 0o644)
INSTALLED_HUB_PIN = (21364752, "efca8d6ca5949e787f10c124e26b91202587b34803f65c7cc5c3e9ffb93fdbf9", 0o755)
INTEGRITY_PIN = (6026, "fba483967ad294fbbfe36e448ded73ffa78dc9ca27507e20297605358d34ec05", 0o644)
PRIVATE_SOURCE = "a3118106086516751b78a58b5dbd684cff4c63a7"
HANDOFF_SHA = "77bf64dcf8c82d4e9ad5e4112445a59639425e6315d4723f910bd8058c9a1a62"
TITLE = "Creator Hub - Development Preview"
TERMS = "Terms of use and risk acknowledgement"
TERMS_CHECKBOX = "I have read and agree to these terms, including the risk assumption and liability limitations above."
TERMS_ACCEPT = "Accept and continue"
POLICY = "2026-09-28-v1"
# Observed native system image in run 38634063716, not a same-name peer rule.
WEBKIT = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess"
WEBKIT_SHA = "5375925828be8acc2c0e905cae0d4654da0519ce1b83f2f724a43eae346bd78e"
WEBKIT_PACKAGE = "libwebkit2gtk-4.1-0:amd64"
WEBKIT_VERSION = "2.50.4-0ubuntu0.22.04.1"
SCOPE = "native-deb-root-terms-and-normal-close-only"
MAX_LOG, MAX_JSON = 262144, 196608
MAX_IMAGE = 1920 * 1080
FLAGS = {key: False for key in ("nativeGuiAccepted", "installationAccepted", "mcpAccepted",
                               "hostIntegrationAccepted", "migrationAccepted", "signedUpdateAccepted", "releaseReady")}
HELPER = Path(__file__).with_name("native-unix-window.py")


def require(value, message):
    if not value:
        raise RuntimeError(message)


def admission(env, system, machine):
    require(system == "linux" and machine == "x86_64", "Native Linux x86_64 required")
    require(all(env.get(k) == v for k, v in {
        "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
        "RUNNER_ARCH": "X64", "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_REPOSITORY_ID": str(REPOSITORY_ID),
        "CREATOR_LINUX_ROOT_PROBE": "1", "CREATOR_UNIX_WINDOW_TEST": "1",
    }.items()), "Exact opted-in disposable repository runner required")
    require(not env.get("FLATPAK_ID") and not env.get("APPIMAGE") and not env.get("APPDIR"),
            "Flatpak/AppImage environment refused for native DEB capture")


def unique_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def validate_source(binding):
    run, artifact, job, commit = (binding[k] for k in ("run", "artifact", "job", "commit"))
    require(all(type(v) is int for v in (run["id"], run["run_attempt"], run["repository"]["id"],
                                        artifact["id"], artifact["size_in_bytes"], job["id"], job["run_id"], job["run_attempt"])),
            "Canonical source integers required")
    require(run["id"] == RUN and run["run_attempt"] == ATTEMPT and run["head_sha"] == SOURCE
            and run["status"] == "completed" and run["conclusion"] == "success"
            and run["repository"]["id"] == REPOSITORY_ID and run["event"] == "push"
            and run["head_branch"] == "validation/unix-assembly-014"
            and run["path"] == ".github/workflows/unix-managed-assembly.yml", "Assembly run binding differs")
    require(artifact["id"] == ARTIFACT and artifact["name"] == ARTIFACT_NAME and artifact["expired"] is False
            and artifact["size_in_bytes"] == ZIP_SIZE and artifact["digest"] == "sha256:" + ZIP_SHA,
            "Original artifact identity differs")
    arun = artifact["workflow_run"]
    require(arun["id"] == RUN and arun["head_sha"] == SOURCE and arun["repository_id"] == REPOSITORY_ID
            and arun["head_repository_id"] == REPOSITORY_ID, "Artifact source differs")
    require(job["id"] == JOB and job["run_id"] == RUN and job["run_attempt"] == ATTEMPT
            and job["conclusion"] == "success" and job["name"].startswith("assembly (linux,"),
            "Successful native Linux assembly job required")
    require(commit["sha"] == SOURCE and commit["tree"]["sha"] == TREE, "Original source tree differs")
    package, tauri = binding["package"], binding["tauri"]
    require(package["name"] == "creator-hub" and package["version"] == tauri["version"] == "0.1.14"
            and tauri["productName"] == "Creator Hub" and tauri["identifier"] == "com.creatorworks.hub"
            and tauri["app"]["windows"][0]["title"] == TITLE, "Source version/window differs")


def ordinary(path):
    path = Path(path)
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)) and path.resolve() == path,
            "Exact unredirected absolute path required")
    return path


def file_record(path, limit, expected_mode=None):
    path = ordinary(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                 | getattr(os, "O_BINARY", 0))
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit,
                "Ordinary single-link bounded file required")
        if expected_mode is not None:
            require(stat.S_IMODE(before.st_mode) == expected_mode, "File mode differs")
        h, total = hashlib.sha256(), 0
        while chunk := os.read(fd, 65536):
            total += len(chunk)
            require(total <= limit, "File grew beyond bound")
            h.update(chunk)
        after = os.fstat(fd)
        keys = ("st_dev", "st_ino", "st_size", "st_mode", "st_nlink", "st_mtime_ns", "st_ctime_ns")
        pathname = path.stat()
        changed = [k for k in keys if getattr(before, k) != getattr(after, k)]
        # Windows pure fixtures: CPython stat/fstat disagree on deprecated ctime.
        # Linux retains full FD/path ctime comparison; Windows also pins birthtime.
        path_keys = keys if os.name != "nt" else keys[:-1] + ("st_birthtime_ns",)
        changed += [k for k in path_keys if getattr(before, k) != getattr(pathname, k)]
        require(not changed, "File identity changed while hashing: " + ",".join(changed))
        require(total == before.st_size, "File size changed")
        return {"size": total, "sha256": h.hexdigest(), "mode": stat.S_IMODE(before.st_mode),
                "device": str(before.st_dev), "inode": str(before.st_ino)}
    finally:
        os.close(fd)


def pinned(path, pin, mode=None):
    record = file_record(path, pin[0], mode)
    require((record["size"], record["sha256"]) == pin[:2], "Reviewed file bytes differ: " + Path(path).name)
    return record


def bounded_read(path, limit):
    before = file_record(path, limit)
    with Path(path).open("rb") as stream:
        data = stream.read(limit + 1)
    require(0 < len(data) <= limit and len(data) == before["size"]
            and hashlib.sha256(data).hexdigest() == before["sha256"] and file_record(path, limit) == before,
            "Read exceeds bound or file changed")
    return data


def verify_archive(path, manifest):
    require(manifest["platform"] == "linux" and manifest["arch"] == "x86_64", "Native Linux manifest required")
    binding = manifest["payloadArchive"]
    require(binding["file"] == "modules.tar.gz" and binding["schemaVersion"] == 1, "Archive contract differs")
    expected = {}
    executable = {"routing/creator-hub-mcp-router", "mcp/server/runtime/node"}
    for module in manifest["modules"].values():
        require(not set(expected).intersection(module["files"]), "Duplicate module path")
        expected.update(module["files"])
        executable.add(module["executable"])
    require(not set(expected).intersection(manifest["managedRouting"]["files"]), "Duplicate routing path")
    expected.update(manifest["managedRouting"]["files"])
    require(set(binding["files"]) == set(expected) and 0 < len(expected) <= 64, "Archive manifest inventory differs")
    before = pinned(path, (binding["size"], binding["sha256"]))
    seen, total, records = set(), 0, {}
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            name = member.name
            require(name in expected and name not in seen and member.isfile() and not member.linkname
                    and not member.pax_headers, "Unexpected/duplicate/linked archive entry")
            mode = 0o755 if name in executable else 0o644
            entry = binding["files"][name]
            require(member.mode == entry["mode"] == mode and member.size == entry["size"]
                    and 0 < member.size <= 256 * 1024 * 1024, "Archive entry size/mode differs")
            h, count = hashlib.sha256(), 0
            with archive.extractfile(member) as stream:
                while chunk := stream.read(65536):
                    count += len(chunk)
                    require(count <= member.size, "Archive entry exceeds bound")
                    h.update(chunk)
            require(count == member.size and h.hexdigest() == expected[name], "Archive resource hash differs")
            total += count
            require(total <= binding["unpackedSize"] <= 256 * 1024 * 1024, "Unpacked archive exceeds bound")
            seen.add(name)
            records[name] = {"size": count, "mode": mode, "sha256": h.hexdigest()}
    require(seen == set(expected) and total == binding["unpackedSize"], "Incomplete archive inventory")
    require(pinned(path, (binding["size"], binding["sha256"])) == before, "Archive changed during resource verification")
    return records


def paths(root):
    return {"creator-hub": Path("/usr/bin/creator-hub"),
            "modules.tar.gz": Path("/usr/lib/Creator Hub/modules.tar.gz"),
            "builtin-manifest.json": root / "input/builtin-manifest.json",
            "signed-unix-assembly.json": root / "input/signed-unix-assembly.json"}


def reviewed_package():
    require(isinstance(DEB_NAME, str) and re.fullmatch(r"[^/\\\x00-\x1f]+\.deb", DEB_NAME)
            and all(isinstance(pin, tuple) and len(pin) == 3 for pin in (DEB_PIN, INSTALLED_HUB_PIN, INTEGRITY_PIN)),
            "Fresh successful assembly DEB pins have not been reviewed")


def input_pins():
    reviewed_package()
    return {**PINS, "unix-package-integrity.json": INTEGRITY_PIN, "native-packages/" + DEB_NAME: DEB_PIN}


def input_path(root, name):
    require(name in input_pins(), "Unknown fixed package input")
    return root / "input" / Path(name).name


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
    os.chmod(path, mode)


def save_json(path, value):
    data = (json.dumps(value, ensure_ascii=True, indent=2) + "\n").encode()
    require(len(data) <= 1048576, "Report exceeds bound")
    write_new(path, data)


def stage(temp):
    reviewed_package()
    binding_bytes = bounded_read(temp / "linux-root-source-binding.json", MAX_JSON)
    binding = unique_json(binding_bytes)
    validate_source(binding)
    archive = temp / "linux-root-input.zip"
    original_zip = pinned(archive, (ZIP_SIZE, ZIP_SHA))
    root = temp / "linux-root-probe"
    root.mkdir(mode=0o700)
    report = {"scope": SCOPE, **FLAGS, "phase": "stage"}
    try:
        (root / "input").mkdir(mode=0o700)
        with zipfile.ZipFile(archive) as z:
            entries = z.infolist()
            require(len(entries) <= 128 and len({e.filename for e in entries}) == len(entries), "Ambiguous ZIP inventory")
            for name, pin in input_pins().items():
                entry = z.getinfo(name)
                require(not entry.is_dir() and not entry.flag_bits & 1 and entry.file_size == pin[0]
                        and stat.S_ISREG(entry.external_attr >> 16)
                        and stat.S_IMODE(entry.external_attr >> 16) == pin[2], "Original ZIP entry mode/size differs")
                data = z.read(entry)
                require(len(data) == pin[0] and hashlib.sha256(data).hexdigest() == pin[1], "Original ZIP entry hash differs")
                write_new(input_path(root, name), data, pin[2])
        require(pinned(archive, (ZIP_SIZE, ZIP_SHA)) == original_zip, "Original ZIP changed while staging")
        write_new(root / "source-binding.json", binding_bytes)
        report.update(verify_inputs(root, full=True))
        report["phase"] = "verified-deb-not-installed"
    except Exception as error:
        report["error"] = str(error)[:1000]
        raise
    finally:
        save_json(root / "stage-report.json", report)
    return report


def verify_inputs(root, full=False):
    require(stat.S_IMODE(ordinary(root).stat().st_mode) == 0o700, "Private probe directory required")
    binding = unique_json(bounded_read(root / "source-binding.json", MAX_JSON))
    validate_source(binding)
    files = {name: pinned(input_path(root, name), pin, pin[2]) for name, pin in input_pins().items()}
    receipt = unique_json(bounded_read(input_path(root, "signed-unix-assembly.json"), 8192))
    require(receipt["assemblyCommit"] == SOURCE and receipt["hubVersion"] == "0.1.14"
            and receipt["schemaVersion"] == 1 and receipt["product"] == "com.creatorworks.hub.unix-signed-assembly"
            and receipt["platform"] == "linux" and receipt["arch"] == "x86_64" and receipt["mcpMode"] == "writable"
            and receipt["privateSource"]["runId"] == 38621563945 and receipt["privateSource"]["runAttempt"] == 1
            and receipt["privateSource"]["sourceCommit"] == PRIVATE_SOURCE
            and receipt["privateSource"]["buildCommit"] == PRIVATE_SOURCE and receipt["handoffSha256"] == HANDOFF_SHA
            and receipt["privateModulesRecompiled"] is False and receipt["privateModulesResigned"] is False
            and receipt["nativeGuiAccepted"] is False and receipt["releaseReady"] is False, "Original assembly receipt differs")
    with input_path(root, "creator-hub").open("rb") as stream:
        elf = stream.read(20)
    require(elf[:7] == b"\x7fELF\x02\x01\x01" and elf[18:20] == b"\x3e\x00", "Exact native x86_64 ELF required")
    result = {"sourceCommit": SOURCE, "sourceTree": TREE, "runId": RUN, "runAttempt": ATTEMPT,
              "assemblyJobId": JOB, "artifactId": ARTIFACT, "artifactSha256": ZIP_SHA,
              "files": files, "originalAssembly": receipt, "layout": "/usr/bin + /usr/lib/Creator Hub",
              "debInstalled": False, "resourceLookupProof": "native package layout; not runtime module-load acceptance"}
    manifest = unique_json(bounded_read(input_path(root, "builtin-manifest.json"), 65536))
    integrity = unique_json(bounded_read(input_path(root, "unix-package-integrity.json"), 65536))
    validate_integrity(integrity, manifest)
    result["originalPackageIntegrity"] = integrity
    if full:
        result["resources"] = verify_archive(input_path(root, "modules.tar.gz"), manifest)
    return result


def validate_integrity(integrity, manifest):
    require(integrity["schemaVersion"] == 1 and integrity["platform"] == "linux" and integrity["arch"] == "x86_64"
            and integrity["experimental"] is True and integrity["mcpMode"] == "writable"
            and integrity["integrityPassed"] is True and integrity["writableGuiAccepted"] is False
            and integrity["releaseReady"] is False, "Original native package integrity refused")
    packages = integrity["packages"]
    require([v["format"] for v in packages] == ["deb", "rpm", "appimage"], "Complete native format integrity required")
    expected = {**manifest["modules"]["mcp"]["files"], **manifest["modules"]["setup"]["files"],
                **manifest["managedRouting"]["files"]}
    require(all(v["files"] == expected for v in packages), "Native package resource inventory differs")
    require(packages[0]["path"] == "native-packages/" + DEB_NAME and packages[0]["sha256"] == DEB_PIN[1]
            and packages[0]["hubSha256"] == INSTALLED_HUB_PIN[1], "Original DEB/ELF package pins differ")


def verify_deb_marker(raw, installed):
    token = b"__TAURI_BUNDLE_TYPE_VAR_UNK"
    require(raw.count(token) == 1, "Expected one original Tauri bundle marker")
    expected = raw.replace(token, token[:-3] + b"DEB", 1)
    require(installed == expected, "DEB image differs beyond exact source-proven Tauri marker")


def verify_stage(root, full=False):
    result = verify_inputs(root, full)
    actual = {}
    for name, pin in (("creator-hub", INSTALLED_HUB_PIN), ("modules.tar.gz", PINS["modules.tar.gz"])):
        path = paths(root)[name]
        require(path.stat().st_uid == 0, "Installed package file is not root-owned")
        actual[name] = pinned(path, pin, pin[2])
    verify_deb_marker(bounded_read(input_path(root, "creator-hub"), PINS["creator-hub"][0]),
                      bounded_read(paths(root)["creator-hub"], INSTALLED_HUB_PIN[0]))
    state = unique_json(bounded_read(root / "installed-package.json", 8192))
    require(state["packageState"] == "creator-hub\t0.1.14\tamd64\tinstalled\n"
            and state["debSha256"] == DEB_PIN[1] and state["sourceCommit"] == SOURCE,
            "Actual dpkg installation receipt differs; bytes are independently rechecked")
    result.update(debInstalled=True, installedFiles=actual, packageState=state["packageState"])
    return result


def load_helper():
    spec = importlib.util.spec_from_file_location("creator_existing_window_helper", HELPER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def check_process(child, start, executable, helper, parent_pid=None):
    require(child.poll() is None, "Owned Root already exited")
    proc = helper.Proc()
    record = proc.stat(child.pid)
    actual = helper.parse_start(record, child.pid)
    require(start is None or start == actual, "Owned Root start changed")
    require(int(record[record.rfind(")") + 2:].split()[1]) == (parent_pid or os.getpid()), "Root is not a direct owned child")
    request = helper.Request("snapshot", child.pid, actual, str(executable), INSTALLED_HUB_PIN[1], 1, TITLE, "FRAME")
    helper.identity(request, proc)
    return actual


def child_env(env, root):
    allowed = ("DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG", "LC_ALL",
               "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "GITHUB_REPOSITORY",
               "GITHUB_REPOSITORY_ID", "RUNNER_TEMP", "CREATOR_LINUX_ROOT_PROBE", "CREATOR_UNIX_WINDOW_TEST")
    result = {k: env[k] for k in allowed if k in env}
    result.update(PATH="/usr/bin:/bin", GDK_BACKEND="x11", NO_AT_BRIDGE="0", HOME=str(root / "home"),
                  XDG_CONFIG_HOME=str(root / "home/config"), XDG_DATA_HOME=str(root / "home/data"),
                  XDG_CACHE_HOME=str(root / "home/cache"), TMPDIR=str(root / "tmp"))
    return result


class Capture:
    """Drain pipes without blocking the parent or retaining unbounded child output."""
    def __init__(self, child, root, label):
        self.child, self.selector, self.items = child, selectors.DefaultSelector(), {}
        for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
            os.set_blocking(stream.fileno(), False)
            item = {"bytes": 0, "eof": False, "kept": bytearray(), "file": (root / f"{label}.{name}").open("xb")}
            self.items[name] = item
            self.selector.register(stream, selectors.EVENT_READ, (name, item))

    def pump(self, wait=0):
        for key, _event in self.selector.select(wait):
            _name, item = key.data
            data = os.read(key.fd, 65536)
            if not data:
                item["eof"] = True
                self.selector.unregister(key.fileobj)
                continue
            item["bytes"] += len(data)
            keep = data[:max(0, MAX_LOG - len(item["kept"]))]
            item["kept"].extend(keep)
            item["file"].write(keep)
            item["file"].flush()

    def metadata(self):
        return {name: {"bytes": item["bytes"], "retainedBytes": len(item["kept"]), "eof": item["eof"],
                       "truncated": item["bytes"] > MAX_LOG} for name, item in self.items.items()}

    def close(self):
        self.selector.close()
        for item in self.items.values():
            item["file"].close()
        self.child.stdout.close()
        self.child.stderr.close()


def run_tool(root, label, command, allowed=(0,), timeout=15):
    """Fixed native package tools only; no generic shell or inherited auth/env."""
    begin = time.monotonic()
    child = subprocess.Popen(command, cwd=root, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    capture = Capture(child, root, label)
    record = {"command": command, "pid": child.pid, "exitCode": None}
    try:
        deadline = begin + timeout
        while time.monotonic() < deadline:
            capture.pump(0.02)
            if child.poll() is not None and all(v["eof"] for v in capture.items.values()):
                break
        record.update(exitCode=child.poll(), elapsedMs=round((time.monotonic() - begin) * 1000), **capture.metadata())
        require(record["exitCode"] is not None, "Native package tool deadline; no signal sent; disposable teardown required")
        child.wait(timeout=0)
        require(record["exitCode"] in allowed and all(v["eof"] and not v["truncated"] for v in capture.metadata().values()),
                "Native package tool failed or exceeded bounded EOF: " + label)
        return record["exitCode"], bytes(capture.items["stdout"]["kept"])
    finally:
        capture.close()
        save_json(root / (label + ".json"), record)


def deb_control(data):
    require(0 < len(data) <= MAX_LOG, "DEB control archive exceeds bound")
    entries, control = {}, None
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for entry in archive:
            name = entry.name[2:] if entry.name.startswith("./") else entry.name
            if name in ("", ".") and entry.isdir():
                continue
            require(name in ("control", "md5sums") and name not in entries and entry.isfile()
                    and not entry.linkname and 0 < entry.size <= 65536,
                    "Unreviewed DEB control member or maintainer script refused")
            body = archive.extractfile(entry).read(65537)
            require(len(body) == entry.size, "DEB control member changed")
            entries[name] = {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
            if name == "control":
                control = Parser().parsestr(body.decode("utf8"))
    require(control is not None and not control.defects and not control.get_payload().strip(), "Malformed DEB control stanza")
    require(all(len(control.get_all(key, [])) == 1 for key in control.keys()), "Duplicate DEB control field")
    require(control.get("Package") == "creator-hub" and control.get("Version") == "0.1.14"
            and control.get("Architecture") == "amd64", "Actual native DEB identity differs")
    return {"package": control["Package"], "version": control["Version"], "architecture": control["Architecture"],
            "depends": control.get("Depends", ""), "members": entries, "maintainerScriptsPresent": False}


STATE_FORMAT = "${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n"


def installed_state(root, label):
    _status, output = run_tool(root, label, ["/usr/bin/dpkg-query", "-W", "-f=" + STATE_FORMAT, "creator-hub"])
    require(output == b"creator-hub\t0.1.14\tamd64\tinstalled\n", "Native dpkg package state differs")
    return output.decode("ascii")


def install(root):
    report = {"scope": SCOPE, **FLAGS, "phase": "preinstall", "debInstalled": False}
    try:
        report["package"] = verify_inputs(root, full=True)
        require(not os.path.lexists("/usr/bin/creator-hub") and not os.path.lexists("/usr/lib/Creator Hub"),
                "Existing native Hub paths refused; no replacement/removal is authorized")
        status, output = run_tool(root, "preinstall-state", ["/usr/bin/dpkg-query", "-W", "-f=" + STATE_FORMAT, "creator-hub"], allowed=(0, 1))
        require(status == 1 and not output, "Existing package registration refused")
        deb = input_path(root, "native-packages/" + DEB_NAME)
        before = pinned(deb, DEB_PIN, DEB_PIN[2])
        _status, control = run_tool(root, "deb-control", ["/usr/bin/dpkg-deb", "--ctrl-tarfile", str(deb)])
        report["control"] = deb_control(control)
        require(pinned(deb, DEB_PIN, DEB_PIN[2]) == before, "DEB changed during control review")
        report["phase"] = "dpkg-install"
        run_tool(root, "dpkg-install", ["/usr/bin/sudo", "-n", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8",
                                       "/usr/bin/dpkg", "--install", "--", str(deb)], timeout=90)
        state = installed_state(root, "postinstall-state")
        save_json(root / "installed-package.json", {"packageState": state, "debSha256": DEB_PIN[1], "sourceCommit": SOURCE})
        report["installed"] = verify_stage(root, full=True)
        report.update(debInstalled=True, phase="actual-deb-installed-not-launched")
    except Exception as error:
        report["error"] = str(error)[:1000]
        raise
    finally:
        save_json(root / "installation-report.json", report)
    return report


def run_worker(root, env, action, pid, start, xid, root_capture, records):
    begin = time.monotonic()
    child = subprocess.Popen(["/usr/bin/python3", "-B", str(Path(__file__).resolve()), "worker", action,
                              str(pid), start, str(xid)], cwd=root, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    record = {"action": action, "pid": child.pid, "exitCode": None, "elapsedMs": 0}
    records.append(record)
    capture = None
    try:
        capture = Capture(child, root, action)
        deadline = begin + (23 if action in ("discover", "snapshot") else 15)
        while time.monotonic() < deadline:
            capture.pump(0.02)
            root_capture.pump()
            if child.poll() is not None and all(item["eof"] for item in capture.items.values()):
                break
        status = child.poll()
        record.update(exitCode=status, elapsedMs=round((time.monotonic() - begin) * 1000), **capture.metadata())
        require(status is not None, "Read-only/action worker deadline reached; no signal sent, disposable teardown required")
        child.wait(timeout=0)
        require(all(v["eof"] and not v["truncated"] for v in capture.metadata().values()), "Worker output did not reach bounded EOF")
        raw = bytes(capture.items["stdout"]["kept"])
        require(0 < len(raw) <= MAX_JSON, "Worker result size differs")
        value = unique_json(raw)
        record["result"] = value
        require(status == 0 and not value.get("error"), "Worker refused: " + str(value.get("error", status))[:1000])
        return value
    finally:
        record["exitCode"] = child.poll()
        if capture is not None:
            capture.close()


def client_ids(x11):
    root = x11.x.XDefaultRootWindow(x11.display)
    value = x11.property(root, "_NET_CLIENT_LIST_STACKING")
    require(value and value[:2] == (33, 32) and 0 < len(value[2]) <= 32
            and len(set(value[2])) == len(value[2]), "Bounded exact WM client inventory unavailable")
    return value[2]


def discover(request, helper, x11):
    matches, refused = [], []
    for xid in client_ids(x11):
        # A claim filters inventory only. XRes, never this property, grants binding.
        claim = x11.property(xid, "_NET_WM_PID")
        if not claim or claim[:2] != (6, 32) or claim[2] != [request.pid]:
            continue
        info = x11.inspect(xid)
        if info["pid"] != request.pid:
            refused.append({"window": str(xid), **info})
        elif info["title"] == TITLE and info["mapped"]:
            matches.append((xid, info))
    require(not refused, "Claimed Root window has foreign XRes PID: " + json.dumps(refused)[:1000])
    require(len(matches) <= 1, "Ambiguous owned Root X window")
    if not matches:
        return None
    helper.identity(request, helper.Proc())
    xid, info = matches[0]
    return {"window": xid, "properties": info, "title": TITLE, "role": "FRAME"}


def peer_record(pid, helper):
    result = {"pid": pid, "authorization": False, "diagnosticOnly": True}
    if type(pid) is not int or pid <= 1:
        return result
    try:
        proc = helper.Proc()
        record = proc.stat(pid)
        start = helper.parse_start(record, pid)
        executable = proc.executable(pid)
        image_hash = proc.digest(pid)
        require(proc.executable(pid) == executable and helper.parse_start(proc.stat(pid), pid) == start,
                "Observed peer identity changed")
        result.update(startTime=start, parentPid=int(record[record.rfind(")") + 2:].split()[1]),
                      executable=executable, kernelImageSha256=image_hash)
    except Exception as error:
        result["error"] = str(error)[:300]
    return result


def process_uids(pid):
    with open(f"/proc/{pid}/status", "rb") as stream:
        body = stream.read(16385)
    require(len(body) <= 16384, "Process status exceeds bound")
    matches = re.findall(rb"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", body, re.M)
    require(len(matches) == 1, "Exact process UID tuple unavailable")
    return [int(v) for v in matches[0]]


def image_identity(path):
    value = os.stat(path)
    require(stat.S_ISREG(value.st_mode) and 0 < value.st_size <= 256 * 1024 * 1024,
            "Ordinary bounded kernel image required")
    return {key: str(getattr(value, key)) for key in
            ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")}


def native_process(pid, helper, full=True):
    proc = helper.Proc()
    first = proc.stat(pid)
    start = helper.parse_start(first, pid)
    uids, executable = process_uids(pid), proc.executable(pid)
    image = image_identity(f"/proc/{pid}/exe")
    result = {"pid": pid, "startTime": start, "parentPid": int(first[first.rfind(")") + 2:].split()[1]),
              "uids": uids, "executable": executable, "image": image}
    if full:
        result["kernelImageSha256"] = proc.digest(pid)
    last = proc.stat(pid)
    require(helper.parse_start(last, pid) == start and last[last.rfind(")") + 2:].split()[1]
            == first[first.rfind(")") + 2:].split()[1] and process_uids(pid) == uids
            and proc.executable(pid) == executable and image_identity(f"/proc/{pid}/exe") == image,
            "Process identity changed during capture")
    return result


def verify_system_webkit():
    path = ordinary(WEBKIT)
    for entry in [path, *path.parents]:
        value = entry.stat()
        require(value.st_uid == 0 and not value.st_mode & 0o022, "System WebKit path is not protected root-owned content")
    image = file_record(path, 256 * 1024 * 1024, 0o755)
    require(image["sha256"] == WEBKIT_SHA, "System WebKit image differs from measured native runner; no peer adopted")
    return image


def system_webkit_provenance(root):
    image = verify_system_webkit()
    _status, owner = run_tool(root, "webkit-owner", ["/usr/bin/dpkg-query", "-S", WEBKIT])
    _status, package = run_tool(root, "webkit-package", ["/usr/bin/dpkg-query", "-W", "-f=" + STATE_FORMAT, WEBKIT_PACKAGE])
    require(owner == (WEBKIT_PACKAGE + ": " + WEBKIT + "\n").encode(), "System WebKit package owner differs")
    require(package == ("libwebkit2gtk-4.1-0\t" + WEBKIT_VERSION + "\tamd64\tinstalled\n").encode(),
            "Measured native WebKit package version/state differs")
    require(verify_system_webkit() == image, "System WebKit image changed during package attribution")
    return {"path": WEBKIT, "sha256": WEBKIT_SHA, "package": WEBKIT_PACKAGE, "version": WEBKIT_VERSION, "file": image}


def validate_peer(peer, root):
    require(type(peer["pid"]) is int and peer["pid"] > 1 and peer["pid"] != root["pid"]
            and peer["parentPid"] == root["pid"], "WebKit peer is not a direct Root child")
    require(peer["uids"] == root["uids"], "WebKit peer UID differs")
    require(peer["executable"] == WEBKIT and peer["kernelImageSha256"] == WEBKIT_SHA,
            "Foreign WebKit peer path/image refused")
    require(int(peer["startTime"]) >= int(root["startTime"]), "WebKit peer predates Root")


class RootOwnership:
    """One pinned Root/XRes frame plus one pinned native renderer, never all peers."""
    def __init__(self, request, helper, x11, root_record, xres, system_file, renderer=None,
                 reader=None, system_check=None):
        self.request, self.helper, self.x11 = request, helper, x11
        self.root, self.xres, self.system_file, self.renderer = root_record, xres, system_file, renderer
        self.reader = reader or (lambda pid, full: native_process(pid, helper, full))
        self.system_check = system_check or verify_system_webkit
        require(root_record["pid"] == request.pid and root_record["startTime"] == request.start
                and root_record["executable"] == request.executable
                and root_record["kernelImageSha256"] == request.sha256, "Root binding differs from native request")
        if renderer is not None:
            validate_peer(renderer, root_record)
        self.recheck(full=True)

    def recheck(self, full=False):
        for expected in [self.root] + ([self.renderer] if self.renderer is not None else []):
            actual = self.reader(expected["pid"], full)
            require(all(expected.get(k) == v for k, v in actual.items()), "Bound Root/renderer identity changed")
        require(self.helper.bound_window(self.request, self.x11) == self.xres, "Bound Root XRes window changed")
        if full:
            require(self.system_check() == self.system_file, "Bound system WebKit provenance changed")

    def node(self, node):
        self.recheck()
        pid = node.get_process_id()
        require(type(pid) is int and pid > 1, "Invalid AX process identity")
        if pid != self.root["pid"]:
            if self.renderer is None:
                candidate = self.reader(pid, True)
                validate_peer(candidate, self.root)
                require(self.system_check() == self.system_file, "System WebKit changed before child binding")
                self.renderer = candidate
            require(pid == self.renderer["pid"], "Additional foreign AX peer refused")
        self.recheck()

    def evidence(self):
        return {"root": self.root, "xres": self.xres, "renderer": self.renderer,
                "policy": "one-native-direct-child-WebKit-in-exact-Root-frame"}


def owned_walk(window, ownership, atspi):
    helper, request = ownership.helper, ownership.request
    require(window.get_process_id() == request.pid and window.get_role() == atspi.Role.FRAME
            and window.get_name() == request.title, "Foreign AX window refused")
    nodes, pending = [], [(window, None, 0)]
    ownership.recheck(full=True)
    while pending:
        node, parent, depth = pending.pop()
        require(node is not None and len(nodes) < helper.MAX_NODES and depth < helper.MAX_DEPTH,
                "Owned AX tree exceeds bounds")
        ownership.node(node)
        if parent is not None:
            # AT-SPI get_parent may use a local cache. Read the live Parent
            # property before deciding; a null/foreign parent still refuses.
            # https://docs.gtk.org/atspi2/method.Accessible.clear_cache.html
            node.clear_cache()
            actual_parent = node.get_parent()
            require(actual_parent == parent, "AX subtree escaped the bound Root window: " + json.dumps({
                "depth": depth, "pid": node.get_process_id(), "role": int(node.get_role()),
                "expectedParentPid": parent.get_process_id(), "expectedParentRole": int(parent.get_role()),
                "actualParentPid": actual_parent.get_process_id() if actual_parent is not None else None,
                "actualParentRole": int(actual_parent.get_role()) if actual_parent is not None else None}))
            require(node.get_role() not in (atspi.Role.FRAME, atspi.Role.WINDOW, atspi.Role.APPLICATION),
                    "Foreign/nested AX window refused")
        require(node not in nodes, "Cyclic/duplicate AX subtree refused")
        nodes.append(node)
        budget = min(helper.MAX_CHILDREN, helper.MAX_NODES - len(nodes) - len(pending))
        pending.extend((child, node, depth + 1) for child in reversed(helper.children(node, budget)))
    ownership.recheck(full=True)
    require(helper.select_window(request, atspi) == window, "Owned AX window changed during traversal")
    return nodes


def snapshot_owned(request, helper, atspi, ownership):
    window = helper.select_window(request, atspi)
    nodes = owned_walk(window, ownership, atspi)
    result = {"action": "snapshot", "actionCount": 0, "nodes": [
        {"pid": n.get_process_id(), "role": int(n.get_role()), "name": (n.get_name() or "")[:256],
         **{s.lower(): n.get_state_set().contains(getattr(atspi.StateType, s))
            for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY", "CHECKED")}} for n in nodes],
        "controls": control_metadata(nodes, helper, atspi), "ownership": ownership.evidence()}
    ownership.recheck(full=True)
    require(helper.select_window(request, atspi) == window, "Owned AX window changed during snapshot")
    return result


def routing_diagnostic(request, helper, atspi):
    window = helper.select_window(request, atspi)
    nodes, pending = [], [(window, 0)]
    while pending:
        node, depth = pending.pop()
        require(node is not None and len(nodes) < helper.MAX_NODES and depth < helper.MAX_DEPTH, "Diagnostic tree exceeds bounds")
        pid = node.get_process_id()
        entry = {"pid": pid, "role": int(node.get_role()), "name": (node.get_name() or "")[:256], "depth": depth}
        nodes.append(entry)
        if pid != request.pid:
            return {"diagnosticOnly": True, "authorization": False, "nodesBeforeRefusal": nodes,
                    "foreignSubtreeRefused": True, "firstForeignPeer": peer_record(pid, helper)}
        budget = min(helper.MAX_CHILDREN, helper.MAX_NODES - len(nodes) - len(pending))
        pending.extend((child, depth + 1) for child in reversed(helper.children(node, budget)))
    return {"diagnosticOnly": True, "authorization": False, "nodesBeforeRefusal": nodes, "foreignSubtreeRefused": False}


def snapshot_ready(request, helper, atspi, proc, x11, ownership):
    """Poll absence/loading only; any identity, ambiguity or foreign tree refuses."""
    deadline, last = time.monotonic() + 20, None
    while time.monotonic() < deadline:
        helper.identity(request, proc)
        helper.bound_window(request, x11)
        roots = [app for app in helper.children(atspi.get_desktop(0), 128) if app.get_process_id() == request.pid]
        require(len(roots) <= 1, "Ambiguous Root accessibility applications")
        windows = [] if not roots else [n for n in helper.children(roots[0], 32)
                                        if n.get_name() == request.title and n.get_role() == atspi.Role.FRAME]
        require(len(windows) <= 1, "Ambiguous Root accessibility frames")
        if windows:
            require(windows[0].get_process_id() == request.pid, "Foreign accessibility frame refused")
            # A loading frame is not yet a snapshot. Never retry a foreign subtree.
            states = windows[0].get_state_set()
            if all(states.contains(getattr(atspi.StateType, k)) for k in ("SHOWING", "ENABLED", "SENSITIVE")) \
                    and not any(states.contains(getattr(atspi.StateType, k)) for k in ("DEFUNCT", "BUSY")):
                last = snapshot_owned(request, helper, atspi, ownership)
                if any(n["name"] == TERMS and n["showing"] for n in last["nodes"]):
                    return last
        time.sleep(0.05)
    require(last is not None, "Owned Root accessibility readiness deadline")
    return last


def control_metadata(nodes, helper, atspi):
    controls = []
    roles = {getattr(atspi.Role, key) for key in ("PUSH_BUTTON", "CHECK_BOX", "TOGGLE_BUTTON", "RADIO_BUTTON", "PAGE_TAB", "LINK", "COMBO_BOX")}
    for node in nodes:
        if node.get_role() not in roles:
            continue
        interface = node.get_action_iface()
        count = interface.get_n_actions() if interface else 0
        require(0 <= count <= 4, "Native control action count exceeds bound")
        if not count:
            continue
        names = [interface.get_action_name(i) for i in range(count)]
        require(all(isinstance(v, str) and len(v.encode("utf8")) <= 64 for v in names), "Native action metadata exceeds bound")
        states = node.get_state_set()
        controls.append({"pid": node.get_process_id(), "name": (node.get_name() or "")[:256],
                         "role": int(node.get_role()), "roleName": node.get_role_name(), "actions": names,
                         **{key.lower(): states.contains(getattr(atspi.StateType, key))
                            for key in ("CHECKED", "SELECTED", "SHOWING", "ENABLED", "SENSITIVE")}})
    return controls


def terms_control(nodes, action, helper, atspi):
    require(action in ("check-terms", "accept-terms"), "Non-terms native action refused")
    require(any(n.get_name() == TERMS and n.get_state_set().contains(atspi.StateType.SHOWING) for n in nodes),
            "Visible exact Root terms heading required")
    checks = [n for n in nodes if n.get_name() == TERMS_CHECKBOX and n.get_role() == atspi.Role.CHECK_BOX]
    accepts = [n for n in nodes if n.get_name() == TERMS_ACCEPT and n.get_role() == atspi.Role.PUSH_BUTTON]
    require(len(checks) == len(accepts) == 1, "Exact unique terms checkbox/button required")
    checked = checks[0].get_state_set().contains(atspi.StateType.CHECKED)
    require(checked == (action == "accept-terms"), "Terms checkbox precondition differs; never retry/toggle blindly")
    node, verb = (checks[0], "check") if action == "check-terms" else (accepts[0], "press")
    helper.ready(node, atspi)
    if action == "check-terms":
        require(not accepts[0].get_state_set().contains(atspi.StateType.ENABLED), "Terms accept unexpectedly enabled before agreement")
    interface = node.get_action_iface()
    require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == verb,
            "Exact source-proven WebKit terms action required: " + verb)
    return node, interface, verb


def perform_owned(action, request, helper, atspi, ownership):
    require(action in ("check-terms", "accept-terms", "close"), "Unreviewed native action refused")
    window = helper.select_window(request, atspi)
    nodes = owned_walk(window, ownership, atspi)
    selected = terms_control(nodes, action, helper, atspi)[0] if action != "close" else None
    if action == "close":
        ownership.x11.check_close(request.window)
    ownership.recheck(full=True)
    require(helper.select_window(request, atspi) == window, "AX frame changed before native action")
    current_nodes = owned_walk(window, ownership, atspi)
    if selected is not None:
        current, interface, verb = terms_control(current_nodes, action, helper, atspi)
        require(ownership.renderer is not None and current == selected
                and current.get_process_id() == ownership.renderer["pid"],
                "Terms control changed or is not in the bound WebKit child")
    terms_visible = any(n.get_name() == TERMS and n.get_state_set().contains(atspi.StateType.SHOWING) for n in current_nodes)
    ownership.recheck(full=True)
    # One terminal input boundary. Failures after this line never authorize retry.
    try:
        if selected is not None:
            require(interface.do_action(0), "Native terms action refused; no retry")
        else:
            ownership.x11.close_window(request.window, ownership.xres)
        return {"action": action, "actionCount": 1, "verb": verb if selected is not None else "WM_DELETE_WINDOW",
                "ownership": ownership.evidence(), "normalExitVerified": False,
                "termsVisibleBeforeAction": terms_visible}
    except Exception as error:
        raise helper.ActionError(str(error)) from error


def acknowledgement(root, earliest_ms):
    path = root / "home/data/CreatorHub/consent/hub-usage-terms.json"
    body = bounded_read(path, 2048)
    value = unique_json(body)
    require(set(value) == {"schemaVersion", "policyVersion", "acceptedAtMs"}
            and type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
            and value["policyVersion"] == POLICY and type(value["acceptedAtMs"]) is int
            and earliest_ms <= value["acceptedAtMs"] <= time.time_ns() // 1000000,
            "Saved native terms acknowledgement differs or predates actual input")
    return {"record": value, "file": file_record(path, 2048), "seeded": False}


def accept_terms(root, environment, child, start, xid, capture, report):
    path = root / "home/data/CreatorHub/consent/hub-usage-terms.json"
    require(not os.path.lexists(path), "Terms acknowledgement must be absent before native input")
    earliest = time.time_ns() // 1000000
    report["termsAcknowledgementAbsentBefore"] = True
    for action in ("check-terms", "accept-terms"):
        report["phase"] = action
        value = run_worker(root, environment, action, child.pid, start, xid, capture, report["workers"])
        require(value["action"] == action and value["actionCount"] == 1, "Exact native terms action receipt required")
        report[action] = value
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not os.path.lexists(path):
        capture.pump(0.02)
    report["termsAcknowledgement"] = acknowledgement(root, earliest)
    write_new(root / "native-terms-acknowledgement.json", bounded_read(path, 2048))
    require(file_record(root / "native-terms-acknowledgement.json", 2048)["sha256"]
            == report["termsAcknowledgement"]["file"]["sha256"], "Retained native acknowledgement copy differs")
    report["termsAcceptanceVerified"] = True


def intersects(a, b):
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def visible_rectangle(request, helper, x11):
    require(client_ids(x11) == [request.window], "Other managed windows present; bitmap refused")
    x = x11.x
    x.XQueryTree.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong),
                            C.POINTER(C.POINTER(C.c_ulong)), C.POINTER(C.c_uint)]
    x.XQueryTree.restype = C.c_int
    x.XTranslateCoordinates.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_int, C.c_int,
                                       C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong)]
    x.XTranslateCoordinates.restype = C.c_int
    root = x.XDefaultRootWindow(x11.display)

    def tree(xid):
        r, parent, count, items = C.c_ulong(), C.c_ulong(), C.c_uint(), C.POINTER(C.c_ulong)()
        try:
            require(x.XQueryTree(x11.display, xid, C.byref(r), C.byref(parent), C.byref(items), C.byref(count)), "X tree unavailable")
            x11.sync()
            require(r.value == root and count.value <= 256, "X tree exceeds local bound")
            return parent.value, list(items[:count.value]) if items else []
        finally:
            if items:
                x.XFree(items)

    def attrs(xid):
        value = helper.WindowAttributes()
        require(x.XGetWindowAttributes(x11.display, xid, C.byref(value)), "X geometry unavailable")
        x11.sync()
        return value

    a, screen = attrs(request.window), attrs(root)
    ox, oy, child = C.c_int(), C.c_int(), C.c_ulong()
    require(x.XTranslateCoordinates(x11.display, request.window, root, 0, 0, C.byref(ox), C.byref(oy), C.byref(child)), "Window origin unavailable")
    x11.sync()
    rect = (ox.value, oy.value, a.width, a.height)
    require(a.map_state == 2 and not a.override_redirect and 560 <= a.width <= 1920 and 480 <= a.height <= 1080
            and a.width * a.height <= MAX_IMAGE and ox.value >= 0 and oy.value >= 0
            and ox.value + a.width <= screen.width and oy.value + a.height <= screen.height,
            "Owned window is not wholly on-screen within pixel bounds")
    ancestor = request.window
    for _ in range(8):
        parent, _children = tree(ancestor)
        if parent == root:
            break
        require(parent > 0, "Owned WM ancestor unavailable")
        ancestor = parent
    else:
        raise RuntimeError("Owned WM ancestry exceeds bound")
    _parent, stack = tree(root)
    require(stack.count(ancestor) == 1, "Owned WM ancestor absent/ambiguous")
    for other in stack[stack.index(ancestor) + 1:]:
        geometry = attrs(other)
        if geometry.map_state == 2 and geometry.class_ == 1:
            require(not intersects(rect, (geometry.x - geometry.border, geometry.y - geometry.border,
                                         geometry.width + 2 * geometry.border, geometry.height + 2 * geometry.border)),
                    "Another mapped drawable obscures owned bitmap; capture refused")
    return rect


def pixel_metrics(pixels, width, height, stride, channels):
    require(0 < width <= 1920 and 0 < height <= 1080 and width * height <= MAX_IMAGE and channels in (3, 4)
            and width * channels <= stride <= width * channels + 64
            and (height - 1) * stride + width * channels <= len(pixels) <= height * stride,
            "Pixel buffer exceeds contract")
    colors, low, high, changed, first = set(), 255, 0, 0, tuple(pixels[:3])
    for y in range(height):
        for x in range(width):
            offset = y * stride + x * channels
            color = tuple(pixels[offset:offset + 3])
            if len(colors) < 256:
                colors.add(color)
            low, high = min(low, *color), max(high, *color)
            changed += color != first
    require(len(colors) >= 16 and high - low >= 32 and changed >= 100, "Owned bitmap is blank/insufficiently varied")
    return {"width": width, "height": height, "colorsAtLeast": len(colors), "channelRange": high - low,
            "pixelsDifferentFromFirst": changed, "nonblank": True}


def bitmap(request, root, helper, x11):
    import gi
    gi.require_version("Gdk", "3.0")
    gi.require_version("GdkX11", "3.0")
    from gi.repository import Gdk, GdkX11
    proc = helper.Proc()
    helper.identity(request, proc)
    bound = helper.bound_window(request, x11)
    rectangle = visible_rectangle(request, helper, x11)
    display = Gdk.Display.get_default()
    require(display is not None, "GDK X11 display unavailable")
    window = GdkX11.X11Window.foreign_new_for_display(display, request.window)
    require(window is not None and window.get_xid() == request.window and window.get_scale_factor() == 1, "Exact unscaled X11 drawable unavailable")
    # Primary GDK docs: obscured/off-screen pixels are undefined. Refuse either.
    pixbuf = Gdk.pixbuf_get_from_window(window, 0, 0, rectangle[2], rectangle[3])
    require(pixbuf is not None and pixbuf.get_width() == rectangle[2] and pixbuf.get_height() == rectangle[3]
            and pixbuf.get_bits_per_sample() == 8, "Owned drawable copy failed")
    metrics = pixel_metrics(pixbuf.get_pixels(), pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride(), pixbuf.get_n_channels())
    helper.identity(request, proc)
    require(helper.bound_window(request, x11) == bound and visible_rectangle(request, helper, x11) == rectangle,
            "Owned drawable changed during capture")
    ok, data = pixbuf.save_to_bufferv("png", [], [])
    require(ok and 0 < len(data) <= 16 * 1024 * 1024 and bytes(data[:8]) == b"\x89PNG\r\n\x1a\n", "Bounded PNG encoding failed")
    helper.identity(request, proc)
    require(helper.bound_window(request, x11) == bound, "Owned XRes identity changed before PNG retention")
    write_new(root / "root-window.png", data)
    return {"diagnosticOnly": True, "windowOnly": True, "xid": request.window, "xres": bound,
            "rectangle": rectangle, **metrics, "image": file_record(root / "root-window.png", 16 * 1024 * 1024)}


def worker(root, args):
    require(len(args) == 4 and args[0] in ("discover", "snapshot", "diagnose", "bitmap", "check-terms", "accept-terms", "close"),
            "Invalid worker request")
    action, pid, start, xid = args
    verify_stage(root)
    helper = load_helper()
    helper.ensure_runner(os.environ, sys.platform, platform.machine())
    request = helper.Request.parse(["snapshot", pid, start, str(paths(root)["creator-hub"]), INSTALLED_HUB_PIN[1], xid, TITLE, "FRAME"])
    proc, x11 = helper.Proc(), None
    helper.identity(request, proc)
    record = proc.stat(request.pid)
    require(int(record[record.rfind(")") + 2:].split()[1]) == os.getppid(), "Worker target is not its parent's Root child")
    try:
        if action == "bitmap":
            import gi
            gi.require_version("Gdk", "3.0")
            gi.require_version("GdkX11", "3.0")
            from gi.repository import Gdk
            # Initialize GDK before the helper installs its scoped Xlib handler.
            Gdk.init([])
        x11 = helper.X11()
        if action == "discover":
            deadline, last = time.monotonic() + 20, None
            while time.monotonic() < deadline:
                helper.identity(request, proc)
                try:
                    value = discover(request, helper, x11)
                    if value:
                        return value
                except RuntimeError as error:
                    last = str(error)
                    # Only an absent WM inventory is transient, never identity/foreign refusal.
                    if last != "Bounded exact WM client inventory unavailable":
                        raise
                time.sleep(0.05)
            raise RuntimeError("Owned Root X window readiness deadline: " + str(last))
        helper.bound_window(request, x11)
        if action == "bitmap":
            return bitmap(request, root, helper, x11)
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(3000, 3000)
        if action == "diagnose":
            value = routing_diagnostic(request, helper, Atspi)
            helper.identity(request, proc)
            helper.bound_window(request, x11)
            return value
        saved = unique_json(bounded_read(root / "root-ownership.json", 16384))
        require(saved["root"]["uids"] == [os.getuid()] * 4 and saved["root"]["parentPid"] == os.getppid()
                and saved["window"] == request.window, "Root UID/parent/window binding differs")
        require(saved["systemWebKit"]["path"] == WEBKIT and saved["systemWebKit"]["sha256"] == WEBKIT_SHA
                and saved["systemWebKit"]["package"] == WEBKIT_PACKAGE and saved["systemWebKit"]["version"] == WEBKIT_VERSION,
                "Exact measured system WebKit provenance required")
        renderer_path = root / "renderer-ownership.json"
        renderer = unique_json(bounded_read(renderer_path, 8192)) if renderer_path.exists() else None
        require(action == "snapshot" or renderer is not None, "Native input requires a completed owned renderer snapshot")
        ownership = RootOwnership(request, helper, x11, saved["root"], saved["xres"], saved["systemWebKit"]["file"], renderer)
        if action == "snapshot":
            value = snapshot_ready(request, helper, Atspi, proc, x11, ownership)
            require(ownership.renderer is not None, "Root snapshot has no verified native WebKit child")
            require(renderer is None, "Initial owned snapshot cannot replace an existing renderer binding")
            save_json(renderer_path, ownership.renderer)
            return value
        return perform_owned(action, request, helper, Atspi, ownership)
    finally:
        if x11 is not None:
            x11.dispose()


def normal_close(root, environment, child, start, xid, capture, report, helper):
    report["normalCloseAttempted"] = True
    closed = run_worker(root, environment, "close", child.pid, start, xid, capture, report["workers"])
    require(closed["action"] == "close" and closed["actionCount"] == 1, "Exact owned native normal-close receipt required")
    report["close"] = closed
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and (child.poll() is None or not all(i["eof"] for i in capture.items.values())):
        capture.pump(0.02)
    require(child.poll() == 0, "Root normal exit was not reaped as zero; no signal sent")
    child.wait(timeout=0)
    require(not helper.Proc().exists(child.pid), "Reaped Root PID still exists")
    require(all(i["eof"] and not i["truncated"] for i in capture.metadata().values()), "Root output failed bounded EOF")
    report["normalExitVerified"] = True


def probe(root, env):
    report = {"scope": SCOPE, **FLAGS, "phase": "verify", "termsAcceptanceVerified": False,
              "readOnlyCaptureCompleted": False, "normalExitVerified": False, "workers": []}
    child, capture, start, request_xid = None, None, None, None
    failure = None
    try:
        report["package"] = verify_stage(root, full=True)
        report["actualDpkgState"] = installed_state(root, "probe-installed-state")
        report["systemWebKit"] = system_webkit_provenance(root)
        for directory in (root / "home", root / "home/config", root / "home/data", root / "home/cache", root / "tmp"):
            directory.mkdir(mode=0o700)
        environment = child_env(env, root)
        require(re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", environment.get("DISPLAY", ""))
                and environment.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:"), "Private local X11/dbus session required")
        helper = load_helper()
        executable = paths(root)["creator-hub"]
        report["phase"] = "launch"
        child = subprocess.Popen([str(executable)], cwd=root, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        report["root"] = {"pid": child.pid, "parentPid": os.getpid(), "executable": str(executable)}
        capture = Capture(child, root, "root")
        start = check_process(child, None, executable, helper)
        report["root"] = {"pid": child.pid, "startTime": start, "parentPid": os.getpid(),
                          "executable": str(executable), "kernelImageSha256": INSTALLED_HUB_PIN[1]}
        report["phase"] = "discover"
        found = run_worker(root, environment, "discover", child.pid, start, 1, capture, report["workers"])
        request_xid = found["window"]
        report["window"] = found
        check_process(child, start, executable, helper)
        identity = native_process(child.pid, helper)
        require(identity["uids"] == [os.getuid()] * 4 and identity["parentPid"] == os.getpid()
                and identity["startTime"] == start and identity["kernelImageSha256"] == INSTALLED_HUB_PIN[1],
                "Captured Root native identity differs")
        save_json(root / "root-ownership.json", {"root": identity, "window": request_xid,
                                               "xres": found["properties"], "systemWebKit": report["systemWebKit"]})
        report["root"] = identity
        report["phase"] = "snapshot"
        try:
            snapshot = run_worker(root, environment, "snapshot", child.pid, start, request_xid, capture, report["workers"])
            require(snapshot["action"] == "snapshot" and snapshot["actionCount"] == 0, "Unexpected helper action")
            report["snapshot"] = snapshot
            report["termsObservedInOwnedSnapshot"] = any(n["name"] == TERMS and n["showing"] for n in snapshot["nodes"])
        except Exception as error:
            failure = error
            report["snapshotRefusal"] = str(error)[:1000]
            report["normalCloseSkippedReason"] = "Snapshot ownership/readiness refused; no native action authorized"
            # This read-only diagnostic stops at the first foreign node; never adopts it.
            try:
                report["accessibilityDiagnostic"] = run_worker(root, environment, "diagnose", child.pid, start,
                                                               request_xid, capture, report["workers"])
            except Exception as diagnostic:
                report["diagnosticRefusal"] = str(diagnostic)[:1000]
        report["phase"] = "bitmap"
        report["bitmap"] = run_worker(root, environment, "bitmap", child.pid, start, request_xid, capture, report["workers"])
        check_process(child, start, executable, helper)
        require(failure is None, "Original snapshot refusal preserved: " + str(failure))
        require(report["termsObservedInOwnedSnapshot"], "Actual terms node was not observed; no terms acceptance inferred")
        accept_terms(root, environment, child, start, request_xid, capture, report)
        report["phase"] = "normal-close"
        normal_close(root, environment, child, start, request_xid, capture, report, helper)
        saved_ack = report["termsAcknowledgement"]
        require(acknowledgement(root, saved_ack["record"]["acceptedAtMs"]) == saved_ack,
                "Native terms acknowledgement changed after normal Root exit")
        require(report["close"]["termsVisibleBeforeAction"] is False, "Terms modal remained visible after native acceptance")
        report.update(readOnlyCaptureCompleted=True, termsAcknowledgementRetainedAfterExit=True,
                      phase="native-terms-accepted-and-normally-reaped")
    except Exception as error:
        failure = error
        report["error"] = str(error)[:1000]
    finally:
        # One fresh, full ownership traversal must still pass for cleanup close.
        # Never retry a close or send a signal after a native input/worker timeout.
        if child is not None and capture is not None and child.poll() is None and report.get("snapshot") \
                and not report.get("normalCloseAttempted") and all(w["exitCode"] is not None for w in report["workers"]):
            report["cleanupNormalCloseAttempted"] = True
            try:
                normal_close(root, environment, child, start, request_xid, capture, report, helper)
            except Exception as cleanup:
                report["cleanupRefusal"] = str(cleanup)[:1000]
                if failure is None:
                    failure = cleanup
                    report["error"] = str(cleanup)[:1000]
        if capture is not None:
            try:
                capture.pump()
                report["rootOutput"] = capture.metadata()
                capture.close()
            except Exception as cleanup:
                report["captureCleanupError"] = str(cleanup)[:1000]
                if failure is None:
                    failure = cleanup
                    report["error"] = str(cleanup)[:1000]
                report["readOnlyCaptureCompleted"] = False
        if child is not None:
            report["rootExitCode"] = child.poll()
            report["disposableSessionTeardownRequired"] = child.poll() is None
        save_json(root / "report.json", report)
    require(failure is None, str(failure))
    return report


def main():
    admission(os.environ, sys.platform, platform.machine())
    temp = ordinary(os.environ["RUNNER_TEMP"])
    args = sys.argv[1:]
    require(bool(args), "Use stage, install, probe, or internal worker")
    if args == ["stage"]:
        result = stage(temp)
    elif args == ["install"]:
        result = install(temp / "linux-root-probe")
    elif args == ["probe"]:
        result = probe(temp / "linux-root-probe", os.environ)
    elif args[0] == "worker":
        result = worker(temp / "linux-root-probe", args[1:])
    else:
        raise RuntimeError("Unknown bounded probe command")
    output = json.dumps(result, ensure_ascii=True)
    require(len(output.encode()) <= (MAX_JSON if args[0] == "worker" else 1048576), "Result exceeds output bound")
    print(output if args[0] == "worker" else json.dumps({"phase": result.get("phase"), **FLAGS}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Workers emit one bounded machine-readable refusal; parent retains both pipes.
        print(json.dumps({"error": f"{type(error).__name__}: {str(error)[:1000]}",
                          "actionMayHaveRun": bool(getattr(error, "action_may_have_run", False)), **FLAGS}))
        sys.exit(1)
