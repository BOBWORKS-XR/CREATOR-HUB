"""Finite production 016 bootstrap/activation controller, never a release gate.

Stage is data-only. Session requires separately requested execution, successful
production receipts and real catalogue signatures. No custom trust, signing,
command relay, app remote, automatic recovery or forced process shutdown.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import select
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
import zlib

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("production_flatpak_neutral", HERE / "native-linux-integrated-pages.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
require, parse, save = P.require, P.parse, P.save
PROFILE = "production-flatpak-host-016"
BRANCH = "refs/heads/validation/native-linux-production-016-flatpak"
WORKFLOW = ".github/workflows/native-linux-production-016-flatpak.yml"
REQUEST = "execute-production-bootstrap-activation-016"
REF = "app/com.creatorworks.hub/x86_64/stable"
NAME = "com.creatorworks.hub.Host"
RUNTIME = "runtime/org.gnome.Platform/x86_64/50"
PORTAL_URL = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
DESCRIPTOR = "creator-hub-linux-x86_64-portable.json"
MANIFEST = "creator-hub-linux-x86_64-0.1.16.portable-manifest.json"
ARCHIVE = "creator-hub-linux-x86_64-0.1.16.appdir.tar.gz"
KEY = {"size": 119, "sha256": "23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308"}
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


def command(args, *, env=None, timeout=60, input=None, limit=2 * 1024 * 1024):
    require(type(args) is list and args and Path(args[0]).is_absolute() and all(type(v) is str for v in args), "Fixed argv tool required")
    require(input is None, "No command-string/stdin relay")
    evidence = locations() / "evidence"
    if not evidence.exists():
        evidence.mkdir(mode=0o700)
    require(evidence.resolve(strict=True) == evidence and evidence.lstat().st_uid == os.getuid(), "Owned tool evidence directory")
    label = "tool-" + str(len(list(evidence.glob('*.json'))))
    _, native = P.helpers()
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env=env, cwd=HERE.parent)
    capture = native.Capture(child, evidence, label)
    receipt = {"tool": Path(args[0]).name, "pid": child.pid, "exitCode": None}
    try:
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
        capture.close(); save(evidence / (label + '.json'), receipt)


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
    for name in (DESCRIPTOR, MANIFEST):
        command(["/usr/bin/minisign", "-Vm", str(stage_root / "signed" / name), "-x", str(stage_root / "signed" / (name + ".minisig")),
                 "-p", str(public_key), "-q"])
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


def public_transport_ready(root, review):
    # No private CA, redirect override or unpublished-download success is invented.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    prefix = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/"
    for name in (DESCRIPTOR, DESCRIPTOR + ".minisig", MANIFEST, MANIFEST + ".minisig"):
        expected = review["signed"]["files"][name]
        with opener.open(prefix + name, timeout=30) as response:
            require(response.status == 200 and response.url.startswith(("https://github.com/", "https://release-assets.githubusercontent.com/")), "Fixed production transport refused")
            raw = response.read(expected["size"] + 1)
        require(len(raw) == expected["size"] and hashlib.sha256(raw).hexdigest() == expected["sha256"], "Fixed public URL differs from reviewed signed input")


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


class Session:
    def __init__(self, root, review):
        self.root, self.review = root, review
        self.app_env = clean_environment(root)
        self.app_env.update({key: os.environ[key] for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY") if key in os.environ})
        self.helper, self.native = P.helpers()
        self.x11, self.driver = self.helper.X11(), P.Driver()
        self.children, self.captures, self.fds = [], [], []
        self.portal_client = None
        self.report = {"schemaVersion": 1, "profile": PROFILE, "phase": "starting", **GATES}

    def launch(self, args, label):
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.app_env)
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

    def flatpak(self, action, phase, missing=False):
        require(action in ("Cancel", "Open Creator Hub", "Get Native Hub"), "Finite launcher action")
        child = self.launch(["/usr/bin/flatpak", "run", "--user", REF], phase)
        start = self.helper.parse_start(self.helper.Proc().stat(child.pid), child.pid)
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
        disclosure = self.disclosure()
        self.wait(lambda: any(self.x11.inspect(window)["pid"] == client["pid"] for window in self.windows()))
        self.portal_client = client if action == "Get Native Hub" else None
        self.click_dialog(client, ["Open native Creator Hub?", disclosure], ["Cancel", "Get Native Hub", "Open Creator Hub"], action, phase)
        if missing:
            message = ("Native Hub support is unavailable or did not confirm activation. Choose Get Native Hub for the dedicated Creator Hub Native Support setup AppImage, "
                       "not the ordinary Hub AppImage. Close Hub normally and open the setup download to review native support setup. Then close setup and reopen this Flatpak. "
                       "This launcher did not install software or change host settings.")
            self.wait(lambda: any(self.x11.inspect(window)["pid"] == client["pid"] for window in self.windows()))
            self.click_dialog(client, ["Native Hub support is required", message], ["Close", "Get Native Hub"], "Close", phase + "-missing")
        self.wait(lambda: child.poll() is not None)
        require(child.wait() == (1 if missing else 0), "Launcher outcome differs")
        self.portal_client = None
        self.snapshot_preserved()

    def disclosure(self):
        file = self.root / "stage/source/native/flatpak-native-activation/src/lib.rs"
        source = regular(file, 262144).decode("utf8")
        match = re.search(r'pub const DISCLOSURE: &str = ("(?:[^"\\]|\\.)*");', source)
        require(match is not None, "Source-bound disclosure missing")
        return parse(match[1])

    def setup(self):
        public_transport_ready(self.root, self.review)
        root_hash = self.review["portable"]["root"]["sha256"]
        setup_name = "Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
        original = self.root / "stage/portable" / setup_name
        profile = parse(regular(self.root / "profile.json", 16384))
        raw = bound(original, profile["portable"]["files"][setup_name])
        launch_dir = self.root / "setup"; launch_dir.mkdir(mode=0o700)
        executable = launch_dir / setup_name; output(executable, raw, 0o755)
        driver = self.launch([str(self.root / "tools/bin/tauri-driver"), "--native-driver", "/usr/bin/WebKitWebDriver"], "webdriver")
        self.wait(lambda: P.listener(driver.pid, 4444))
        require(self.driver.request("GET", "/status")["ready"] is True, "Owned WebDriver not ready")
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
        self.driver.guard = lambda: self.owned_window(root, P.TITLE)
        self.wait(lambda: self.driver.read("#usage-terms-dialog", "attribute/open") is not None)
        self.driver.click("#usage-terms-checkbox"); self.driver.click("#usage-terms-continue")
        self.wait(lambda: self.driver.read("#usage-terms-dialog", "attribute/open") is None)
        self.wait(lambda: self.driver.read("#native-support-page", "displayed") is True
                  and self.driver.read("#native-support-install", "enabled") is True)
        require(self.driver.read("#native-support-error", "property/hidden") is True, "Setup reported error before review")
        self.absent_installation()
        self.driver.click("#native-support-install")
        self.wait(lambda: len(self.windows()) == 2, 120)
        self.click_dialog(root, [consent_text(self.review["generation"])], ["Install native support", "Cancel"],
                          "Cancel", "setup-cancel", "Install native support")
        self.wait(lambda: self.driver.read("#native-support-install", "enabled") is True)
        self.absent_installation(); self.report["setupCancelAccepted"] = True
        self.driver.click("#native-support-install")
        self.wait(lambda: len(self.windows()) == 2, 120)
        self.click_dialog(root, [consent_text(self.review["generation"])], ["Install native support", "Cancel"],
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
    def method(connection, sender, path, interface, name, parameters, invocation):
        try:
            require(name == "OpenURI" and len(calls) == 0 and re.fullmatch(r":[0-9]+\.[0-9]+", sender), "Only one fixed portal capture")
            parent, uri, options = parameters.unpack()
            require(parent == "" and uri == PORTAL_URL and options == {}, "Only the source-bound setup URL may be captured")
            uid = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixUser",
                                      GLib.Variant("(s)", (sender,)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
            pid = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID",
                                      GLib.Variant("(s)", (sender,)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
            require(uid == os.getuid() and session.portal_client is not None and pid == session.portal_client["pid"], "Portal sender is not the bound signed launcher")
            session.stable(session.portal_client)
            calls.append({"url": uri, "browserOpened": False, "downloadAttempted": False, "senderUid": uid})
            invocation.return_value(GLib.Variant("(o)", ("/org/freedesktop/portal/desktop/request/production_016/captured",)))
        except Exception as error:
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
    wm, portal_bus, portal_id = None, None, None
    try:
        wm = session.launch(["/usr/bin/openbox", "--sm-disable"], "wm")
        session.wait(lambda: session.x11.property(session.x11.x.XDefaultRootWindow(session.x11.display), "_NET_SUPPORTING_WM_CHECK"))
        require(not session.windows() and session.host_owner() is None, "Fresh session already has an app/Host1")
        portal_bus, portal_id, calls = portal_capture(session)
        original_wait = session.wait
        def wait(test, seconds=30):
            def check():
                context = GLib.MainContext.default()
                while context.pending():
                    context.iteration(False)
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
        session.report["coldActivationAccepted"] = True; session.report["coldRoot"] = cold
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
        session.report.update(settingsPreserved=True, phase="complete", normalCloseObserved=True)
        command(["/usr/bin/openbox", "--exit"]); wm.wait(timeout=10)
    except Exception as error:
        session.report["error"] = str(error)[:1500]
        raise
    finally:
        session.report["disposableTeardownRequired"] = session.report.get("phase") != "complete" or any(child.poll() is None for child in session.children)
        session.report["logs"] = [capture.metadata() for capture in session.captures]
        save(root / "report.json", session.report)
        if portal_bus is not None:
            portal_bus.unregister_object(portal_id)
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
    for name in (DESCRIPTOR, MANIFEST):
        command(["/usr/bin/minisign", "-Vm", str(root / "stage/signed" / name), "-x", str(root / "stage/signed" / (name + ".minisig")),
                 "-p", str(root / "stage/source/src-tauri/src/catalog-key.pub"), "-q"])
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
    command(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24", "/usr/bin/dbus-run-session", "--",
             "/usr/bin/python3", "-B", str(Path(__file__).resolve()), "_run"], env={**env, **context}, timeout=600)


def main():
    admission(os.environ, sys.platform, platform.machine() if sys.platform == "linux" else "", os.getuid() if hasattr(os, "getuid") else None)
    require(os.getuid() == os.geteuid(), "No privileged identity transition")
    require(len(sys.argv) == 2 and sys.argv[1] in ("stage", "session", "_run"), "Only fixed stage or separately requested session")
    root = locations(); before = root.lstat()
    require(root.resolve(strict=True) == root and stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid()
            and stat.S_IMODE(before.st_mode) == 0o700, "Owned private input root required")
    if sys.argv[1] == "stage":
        stage(root)
    elif sys.argv[1] == "session":
        session(root)
    else:
        require(os.environ.get("EXECUTION_REQUEST") == REQUEST and os.environ.get("HOME") == str(root / "home")
                and os.environ.get("XDG_RUNTIME_DIR") == str(root / "runtime") and os.environ.get("DISPLAY")
                and os.environ.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:"), "Private inherited execution session required")
        review = parse(regular(root / "stage-review.json", 2 * 1024 * 1024, 0o600))
        require(review["signaturesVerified"] is True and all(review[key] is False for key in GATES), "Verified stage, not supplied acceptance flags")
        run_session(root, review)


if __name__ == "__main__":
    main()
