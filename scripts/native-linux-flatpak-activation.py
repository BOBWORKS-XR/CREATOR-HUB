"""Disposable real Flatpak GTK disclosure + native DEB warm/cold activation.

No host command relay, product rebuild, signing, publication or native-dialog
bypass. Imports only proof primitives from the separately owned pages harness.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import select
import subprocess
import sys
import time
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("activation_pages_primitives", HERE / "native-linux-integrated-pages.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
require = P.require
BRANCH = "refs/heads/validation/linux-flatpak-activation-next"
ID, NAME, INTERFACE, OBJECT = "com.creatorworks.hub", "com.creatorworks.hub.Host", "com.creatorworks.hub.Host1", "/com/creatorworks/hub/Host"
REF = "app/com.creatorworks.hub/x86_64/native-activation-test"
RUNTIME, SDK = "runtime/org.gnome.Platform/x86_64/50", "runtime/org.gnome.Sdk/x86_64/50"
PACKAGE = {"size": 63874630, "sha256": "8f9ff4b4694d00150bf86f7a5befc6a1cfc80610d55212b717d602ceb84fe86c", "version": "0.1.14"}
HUB = {"size": 27369792, "sha256": "3ac7fdd5cedf85df41844c32c7dcdeb180ca14fc66a7f6e274c1ace5fc5e39b8"}
SERVER = {"size": 1621513, "sha256": "62d410eba4d81646a35ee274b5904a17287026bdc4d765426d6cf3b07d04141a"}
ZIP = {"size": 182723403, "sha256": "71a2a4e42a1b1e2fe5e1e64f363f7d3c06444b03b5d2177b2e4565ad8a710c4c"}
SOURCE = "5065fb1112b9e96978e40e64503fa979f559baae"
SERVICE = Path("/usr/share/dbus-1/services/com.creatorworks.hub.Host.service")
PROXY = "/usr/libexec/flatpak-dbus-proxy"
IDENTITY_DIAGNOSTIC_ONLY = True
SERVICE_BYTES = b"[D-BUS Service]\nName=com.creatorworks.hub.Host\nExec=/usr/bin/creator-hub --flatpak-activate\n"
GATES = {key: False for key in ("releaseReady", "flatpakAccepted", "migrationAccepted", "signedUpdateAccepted", "restartAccepted",
                              "publisherSignatureAccepted", "nativeAuthenticationAccepted", "steamDeckAccepted", "finalCandidateQualified")}


def admission(env, system, machine):
    expected = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": BRANCH,
                "CREATOR_FLATPAK_ACTIVATION_TEST": "1"}
    require(system == "linux" and machine == "x86_64" and all(env.get(k) == v for k, v in expected.items())
            and env.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch"), "Exact disposable activation runner required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")) and
            all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "Invalid CI identity")
    require(not any(re.match(r"^(LD_|TAURI_|WEBKIT_|PYTHONPATH$|PYTHONHOME$|NODE_OPTIONS$|BASH_ENV$|ENV$|SSL_CERT_|CREATOR_HUB_SIGNING_)", k)
                    for k in env) and not env.get("FLATPAK_ID"), "Runtime/signing overrides refused")


def locations():
    return Path(os.environ["RUNNER_TEMP"]).resolve() / "flatpak-activation"


def stage():
    temp, root = Path(os.environ["RUNNER_TEMP"]).resolve(), locations()
    root.mkdir(mode=0o700)
    archive = temp / "flatpak-activation-input.zip"
    P.pinned(archive, ZIP, os.getuid(), 0o600)
    wanted = {"native-packages/Creator Hub_0.1.14_amd64.deb": ("native.deb", PACKAGE),
              "modules/mcp/server/creator-works-mcp.mjs": ("creator-works-mcp.mjs", SERVER)}
    with zipfile.ZipFile(archive) as zipped:
        entries, seen = zipped.infolist(), set()
        require(0 < len(entries) <= 64 and sum(e.file_size for e in entries) <= 768 * 1024 * 1024, "ZIP inventory bound")
        for entry in entries:
            name = entry.orig_filename
            require(name == entry.filename and name not in seen and "\\" not in name and ":" not in name and not name.startswith("/")
                    and all(p not in ("", ".", "..") for p in name.rstrip("/").split("/"))
                    and (entry.external_attr >> 16) & 0o170000 in (0, 0o100000, 0o040000)
                    and not entry.flag_bits & 1 and 0 <= entry.file_size <= 256 * 1024 * 1024, "Unsafe ZIP member")
            seen.add(name)
        for name, (destination, pin) in wanted.items():
            entry = zipped.getinfo(name)
            require(not entry.is_dir() and entry.file_size == pin["size"], "Selected ZIP member differs")
            raw = zipped.read(entry)
            require(len(raw) == pin["size"] and hashlib.sha256(raw).hexdigest() == pin["sha256"], "Selected bytes differ")
            with (root / destination).open("xb") as stream:
                os.chmod(root / destination, 0o600); stream.write(raw)
    config, fixtures = P.fixtures(root, root / "creator-works-mcp.mjs")
    P.save(root / "fixtures.json", {"config": config, "files": fixtures})


def clean_environment(root, original):
    env = {k: v for k, v in original.items() if k.startswith("GITHUB_") and k in (
        "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT", "GITHUB_EVENT_NAME", "GITHUB_WORKSPACE") or k in ("RUNNER_TEMP", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "CREATOR_FLATPAK_ACTIVATION_TEST")}
    env.update(PATH="/usr/bin:/bin", LANG="C.UTF-8", LC_ALL="C.UTF-8", HOME=str(root / "home"),
               XDG_CONFIG_HOME=str(root / "home/config"), XDG_DATA_HOME=str(root / "home/data"), XDG_CACHE_HOME=str(root / "home/cache"),
               XDG_RUNTIME_DIR=str(root / "runtime"), XDG_DATA_DIRS="/usr/local/share:/usr/share", TMPDIR=str(root / "tmp"),
               FLATPAK_USER_DIR=str(root / "installation"), FLATPAK_FANCY_OUTPUT="0", FLATPAK_TTY_PROGRESS="0", NO_AT_BRIDGE="0", GDK_BACKEND="x11")
    return env


def disclosure():
    source = (HERE.parent / "native/flatpak-native-activation/src/lib.rs").read_text()
    match = re.search(r'pub const DISCLOSURE: &str = ("(?:[^"\\]|\\.)*");', source)
    require(match is not None, "Missing source-bound disclosure")
    return P.parse(match[1])


def dialog_contract(nodes, text, action):
    require(action in ("Cancel", "Open Creator Hub") and 1 <= len(nodes) <= 48, "Unreviewed action/tree size")
    require(nodes[0]["role"] == "alert" and not any(n["role"] in ("alert", "dialog", "frame", "window", "application") for n in nodes[1:]), "Unexpected GTK window tree")
    labels = [n["name"] for n in nodes if n["role"] == "label"]
    require(labels.count("Open native Creator Hub?") == labels.count(text) == 1, "Disclosure labels differ")
    buttons = [i for i, n in enumerate(nodes) if n["role"] == "push button"]
    require(len(buttons) == 3 and {nodes[i]["name"] for i in buttons} == {"Cancel", "Get Native Hub", "Open Creator Hub"}, "Disclosure buttons differ")
    target = [i for i in buttons if nodes[i]["name"] == action]
    require(len(target) == 1 and nodes[target[0]]["showing"] and nodes[target[0]]["enabled"], "Consent control is not ready")
    return target[0]


def snapshot_fixtures(root):
    expected = P.parse((root / "fixtures.json").read_bytes())["files"]
    actual = {name: P.record(root / "home" / name) for name in expected}
    require(actual == expected, "Host settings/client/project fixture changed")
    return actual


def empty_windows(x11):
    value = x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_CLIENT_LIST_STACKING")
    if value is None:
        return []
    require(value[:2] == (33, 32) and len(value[2]) <= 8 and len(set(value[2])) == len(value[2]), "Unexpected native window inventory")
    return value[2]


def stable(native, helper, expected, on_mismatch=None):
    actual = native.native_process(expected["pid"], helper, False)
    matches = actual == {k: v for k, v in expected.items() if k != "kernelImageSha256"}
    try:
        if not matches and on_mismatch is not None:
            on_mismatch(actual)
    finally:
        require(matches, "Owned process identity changed")


def identity_deltas(expected, actual):
    def bounded(value):
        encoded = json.dumps(value, ensure_ascii=True, sort_keys=True)
        return value if len(encoded) <= 256 else {"jsonPrefix": encoded[:128], "jsonLength": len(encoded)}
    fields = ("pid", "startTime", "parentPid", "uids", "executable")
    image_fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")
    changes = []
    for name in fields:
        if expected.get(name) != actual.get(name):
            changes.append({"field": name, "expected": bounded(expected.get(name)), "actual": bounded(actual.get(name))})
    for name in image_fields:
        if expected.get("image", {}).get(name) != actual.get("image", {}).get(name):
            changes.append({"field": "image." + name, "expected": bounded(expected.get("image", {}).get(name)),
                            "actual": bounded(actual.get("image", {}).get(name))})
    return {"pid": expected["pid"], "changes": changes,
            "recordShapeChanged": set(expected) - {"kernelImageSha256"} != set(actual)
                or set(expected.get("image", {})) != set(actual.get("image", {}))}


def stable_pair(native, helper, context, root, phase):
    require(phase in ("cancel", "warm", "cold"), "Unreviewed diagnostic phase")
    def refused(role, actual):
        records = {}
        for peer in ("cli", "launcher"):
            try:
                observed = actual if peer == role else native.native_process(context[peer]["pid"], helper, False)
                records[peer] = identity_deltas(context[peer], observed)
            except Exception as error:
                records[peer] = {"pid": context[peer]["pid"], "inspectionError": type(error).__name__[:80]}
        report = {"failedRole": role, "records": records, "diagnosticOnly": True, **GATES}
        require(len(json.dumps(report, ensure_ascii=True).encode()) <= 24576, "Identity diagnostic exceeds bound")
        P.save(root / (phase + "-identity-refusal.json"), report)
    for role in ("cli", "launcher"):
        stable(native, helper, context[role], lambda actual, role=role: refused(role, actual))


def owner(bus, name=NAME):
    from gi.repository import Gio, GLib
    def query(method, target, signature):
        return bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method,
            GLib.Variant("(s)", (target,)), GLib.VariantType.new(signature), Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
    if not query("NameHasOwner", name, "(b)"):
        return None
    unique = query("GetNameOwner", name, "(s)")
    pid = query("GetConnectionUnixProcessID", unique, "(u)")
    require(query("GetConnectionUnixUser", unique, "(u)") == os.getuid() and query("GetNameOwner", name, "(s)") == unique, "Activation bus owner changed")
    return {"name": unique, "pid": pid}


def gtk_worker(root, phase):
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.init(); Atspi.set_timeout(1500, 1500)
    helper, native = P.helpers()
    context = P.parse((root / (phase + "-context.json")).read_bytes())
    report = {"actionAttempted": False, "actionReturned": False, "nodes": [], **GATES}
    x11, ax_bus = helper.X11(), None
    try:
        require(os.getppid() == context["controller"], "GTK worker is not the controller's owned child")
        launcher, cli = context["launcher"], context["cli"]
        proxies = context["proxies"]
        def check():
            stable_pair(native, helper, context, root, phase)
            chain = P.subtree(cli["pid"], helper, native)
            require(chain.get(launcher["pid"]) == {k: v for k, v in launcher.items() if k != "kernelImageSha256"}, "Launcher left owned Flatpak tree")
            require(x11.inspect(context["window"]) == context["xres"], "GTK native window changed")
        check()
        if IDENTITY_DIAGNOSTIC_ONLY:
            report["identityChecksMatched"] = True
            raise RuntimeError("Diagnostic-only trial: ownership matched; no GTK input permitted")
        status = Path(f'/proc/{launcher["pid"]}/status').read_bytes()
        require(len(status) <= 16384, "Process status bound")
        match = re.search(rb"^NSpid:\s+([0-9 \t]+)$", status, re.M)
        require(match is not None, "Kernel namespace PID tuple unavailable")
        ids = [int(v) for v in match[1].split()]
        require(1 <= len(ids) <= 8 and ids[0] == launcher["pid"], "Unexpected namespace PID identity")
        references, ax_bus = native.native_ax_references()
        peers = {v["pid"]: v for v in [launcher, *proxies]}
        aliases = {}
        def wire(node):
            name, pathname = node.app.bus_name, node.path
            require(type(name) is str and len(name) <= 255 and re.fullmatch(r"(?::[0-9]+\.[0-9]+|org\.[A-Za-z0-9_.-]+)", name)
                    and type(pathname) is str and re.fullmatch(r"/org/a11y/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+", pathname) and len(pathname) <= 256, "Invalid GTK AX wire reference")
            peer = references.resolve(name)
            require(peer["pid"] in peers and peer["uid"] == os.getuid() and node.get_process_id() in (ids[0], ids[-1]), "GTK AX owner is not the kernel-bound launcher/proxy")
            stable(native, helper, peers[peer["pid"]])
            require(name not in aliases or aliases[name] == peer, "GTK AX owner changed")
            aliases[name] = peer
            require(len(aliases) <= 4, "GTK AX aliases bound")
            return peer["owner"], pathname
        apps = helper.children(Atspi.get_desktop(0), 32)
        report["applications"] = [{"pid": a.get_process_id(), "role": a.get_role_name(), "name": (a.get_name() or "")[:128]} for a in apps]
        matches = []
        for app in apps:
            if app.get_process_id() in (ids[0], ids[-1]):
                wire(app)
                matches.extend(n for n in helper.children(app, 4) if n.get_role() == Atspi.Role.ALERT)
        require(len(matches) == 1, "Exact native GTK disclosure missing/ambiguous")
        objects, seen, pending = [], set(), [(matches[0], 0)]
        deadline = time.monotonic() + 15
        while pending:
            node, depth = pending.pop()
            require(time.monotonic() < deadline and depth < 8 and len(objects) < 48, "GTK tree/deadline bound")
            node.clear_cache(); identity = wire(node)
            require(identity not in seen, "Repeated GTK node"); seen.add(identity)
            name = node.get_name() or ""
            require(len(name) <= 1024, "GTK label exceeds bound")
            state = node.get_state_set()
            report["nodes"].append({"role": node.get_role_name(), "name": name, "showing": state.contains(Atspi.StateType.SHOWING), "enabled": state.contains(Atspi.StateType.ENABLED)})
            objects.append(node)
            pending.extend((child, depth + 1) for child in reversed(helper.children(node, 16)))
        rectangle = objects[0].get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        require((rectangle.x, rectangle.y, rectangle.width, rectangle.height) == x11.frame_rectangle(context["window"]), "GTK AX/native frame differs")
        target = objects[dialog_contract(report["nodes"], disclosure(), context["action"])]
        action = target.get_action_iface()
        require(action and action.get_n_actions() == 1 and action.get_action_name(0) == "click", "GTK button has unexpected action interface")
        check(); wire(target)
        for name, value in aliases.items():
            require(references.resolve(name) == value, "GTK alias changed before input")
        report["actionAttempted"] = True
        report["actionReturned"] = action.do_action(0) is True
        require(report["actionReturned"], "GTK click outcome unknown; do not retry")
    except Exception as error:
        report["error"] = str(error)[:700]
        raise
    finally:
        P.save(root / (phase + "-gtk.json"), report)
        if ax_bus is not None:
            ax_bus.close_sync(None)
        x11.dispose()


def exercise(root):
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, Gio
    Gdk.init([])
    helper, native = P.helpers()
    report = {"sourceCommit": SOURCE, "harnessCommit": os.environ["GITHUB_SHA"], "rootExitCode": None,
              "cancelObserved": False, "warmObserved": False, "coldObserved": False, "settingsPreserved": False, **GATES}
    logs, children, fds = [], [], []
    def launch(args, label):
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        children.append(child); logs.append(native.Capture(child, root, label))
        return child
    def pump():
        for log in logs:
            log.pump()
    def wait(test, seconds=20):
        P.wait(lambda: (pump(), test())[1], seconds)
    def command(label, args):
        env = clean_environment(root, os.environ)
        env.update({k: os.environ[k] for k in ("DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS") if k in os.environ})
        return native.run_tool(root, label, ["/usr/bin/env", *[k + "=" + v for k, v in env.items()], *args])[1].decode().strip()
    def close_root(process, window, label):
        request = helper.Request("snapshot", process["pid"], process["startTime"], P.HUB, HUB["sha256"], window, P.TITLE, "FRAME")
        stable(native, helper, process); helper.identity(request, helper.Proc())
        fd = os.pidfd_open(process["pid"]); fds.append(fd)
        x11.close_window(window, helper.bound_window(request, x11))
        wait(lambda: bool(select.select([fd], [], [], 0)[0]) and not Path(f'/proc/{process["pid"]}').exists(), 15)
        wait(lambda: owner(bus) is None)
        report[label] = True
    x11, driver, d = None, None, P.Driver()
    try:
        P.pinned(root / "native.deb", PACKAGE, os.getuid(), 0o600); P.pinned(P.HUB, HUB, 0, 0o755)
        service = P.record(SERVICE)
        require(SERVICE.read_bytes() == SERVICE_BYTES and (service["mode"], service["uid"], service["gid"]) == (0o644, 0, 0), "Installed service differs")
        for path in SERVICE.parents:
            value = path.stat()
            require(path.resolve() == path and value.st_uid == value.st_gid == 0 and not value.st_mode & 0o022, "Service ancestor is not protected")
        require(command("dpkg-state", ["/usr/bin/dpkg-query", "-W", "-f=${Version}\t${db:Status-Status}", "creator-hub"]) == "0.1.14\tinstalled", "Installed package differs")
        require(command("dpkg-verify", ["/usr/bin/dpkg", "--verify", "creator-hub"]) == "", "Installed package changed")
        binding = P.parse((root / "launcher-binding.json").read_bytes())
        require(command("flatpak-commit", ["/usr/bin/flatpak", "info", "--user", "--show-commit", REF]) == binding["commit"], "App deployment differs")
        snapshot_fixtures(root)
        wm = launch(["/usr/bin/openbox", "--sm-disable"], "wm")
        x11 = helper.X11(); wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"))
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        require(owner(bus) is None and not empty_windows(x11), "Fresh session already has a Root/window")
        driver = launch([str(root / "driver/bin/tauri-driver"), "--native-driver", "/usr/bin/WebKitWebDriver"], "driver")
        wait(lambda: P.listener(driver.pid, 4444))
        require(d.request("GET", "/status")["ready"] is True, "Driver not ready")
        session = d.request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": P.HUB, "args": []}}}})
        d.session = session["sessionId"]
        chain = P.subtree(driver.pid, helper, native)
        candidates = [p for p in chain.values() if p["executable"] == P.HUB]
        require(len(candidates) == 1, "Exact WebDriver-owned Root missing")
        warm = native.native_process(candidates[0]["pid"], helper)
        require(warm["kernelImageSha256"] == HUB["sha256"], "Warm Root hash differs")
        wait(lambda: len(empty_windows(x11)) == 1 and (owner(bus) or {}).get("pid") == warm["pid"])
        window = empty_windows(x11)[0]
        require(x11.inspect(window)["pid"] == warm["pid"], "Warm window is foreign")
        def web_guard():
            pump(); stable(native, helper, warm)
            require(empty_windows(x11) == [window] and x11.inspect(window)["pid"] == warm["pid"], "Unexpected native window during HTML test")
        d.guard = web_guard
        wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
        d.click("#usage-terms-checkbox"); d.click("#usage-terms-continue")
        wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
        P.defer_migration(d)
        terms = root / "home/data/CreatorHub/consent/hub-usage-terms.json"
        consent = P.parse(terms.read_bytes())
        require(consent["schemaVersion"] == 1 and consent["policyVersion"] == P.POLICY and type(consent["acceptedAtMs"]) is int and consent["acceptedAtMs"] > 0, "Native terms not recorded")
        terms_before = P.record(terms)
        proxy_image = P.record(PROXY)
        require(proxy_image["uid"] == proxy_image["gid"] == 0 and proxy_image["mode"] == 0o755, "OS proxy is not protected")
        report.update(warmRoot=warm, warmWindow=window, launcher=binding, settingsBefore=snapshot_fixtures(root))
        def disclosure_action(phase, action, expected_windows):
            cli = launch(["/usr/bin/flatpak", "run", "--user", REF], phase)
            cli_record = native.native_process(cli.pid, helper)
            peers = {}
            def found():
                nonlocal peers
                peers = P.subtree(cli.pid, helper, native)
                return len([p for p in peers.values() if p["executable"].endswith("/creator-hub-flatpak-activate")]) == 1
            wait(found)
            candidate = [p for p in peers.values() if p["executable"].endswith("/creator-hub-flatpak-activate")][0]
            launcher = native.native_process(candidate["pid"], helper)
            require(launcher["kernelImageSha256"] == binding["sha256"] and launcher["parentPid"] in peers, "Launcher kernel image/ownership differs")
            proxies = [native.native_process(p["pid"], helper) for p in peers.values() if p["executable"] == PROXY]
            require(len(proxies) <= 4 and all(p["kernelImageSha256"] == proxy_image["sha256"] for p in proxies), "Foreign proxy image")
            wait(lambda: len(empty_windows(x11)) == expected_windows + 1)
            matches = [w for w in empty_windows(x11) if x11.inspect(w)["pid"] == launcher["pid"]]
            require(len(matches) == 1, "Exact kernel-owned GTK window missing")
            gtk_window = matches[0]; properties = x11.inspect(gtk_window)
            require(properties["mapped"] and properties["title"] == "Creator Hub", "Wrong native disclosure window")
            P.save(root / (phase + "-context.json"), {"controller": os.getpid(), "cli": cli_record, "launcher": launcher,
                "proxies": proxies, "window": gtk_window, "xres": properties, "action": action})
            worker = launch(["/usr/bin/python3", "-B", str(Path(__file__).resolve()), "gtk", phase], phase + "-worker")
            wait(lambda: worker.poll() is not None, 35); require(worker.wait() == 0, "Owned GTK selector refused; inspect its bounded capture")
            wait(lambda: cli.poll() is not None, 20); require(cli.wait() == 0, "Flatpak activation returned failure")
            snapshot_fixtures(root); require(P.record(terms) == terms_before, "Existing consent changed")
        report["phase"] = "cancel-disclosure"
        disclosure_action("cancel", "Cancel", 1)
        require(owner(bus)["pid"] == warm["pid"] and empty_windows(x11) == [window], "Cancel changed native Root")
        report["cancelObserved"] = True
        report["phase"] = "warm-disclosure"
        disclosure_action("warm", "Open Creator Hub", 1)
        stable(native, helper, warm)
        require(owner(bus)["pid"] == warm["pid"] and empty_windows(x11) == [window], "Warm activation created/replaced Root")
        wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_ACTIVE_WINDOW")[2] == [window])
        report["warmObserved"] = True
        physical = root / "warm-surface"; physical.mkdir(mode=0o700)
        report["warmSurface"] = native.bitmap(helper.Request("snapshot", warm["pid"], warm["startTime"], P.HUB, HUB["sha256"], window, P.TITLE, "FRAME"), physical, helper, x11)
        close_root(warm, window, "warmNormalCloseObserved")
        d.guard = lambda: None
        try:
            d.call("DELETE", "")
        except RuntimeError as error:
            report["sessionCleanupDiagnostic"] = str(error)[:300]
        driver.terminate(); driver.wait(timeout=10)
        wait(lambda: not empty_windows(x11))
        report["phase"] = "cold-disclosure"
        disclosure_action("cold", "Open Creator Hub", 0)
        wait(lambda: owner(bus) is not None and len(empty_windows(x11)) == 1)
        cold = native.native_process(owner(bus)["pid"], helper)
        require(cold["kernelImageSha256"] == HUB["sha256"] and cold["pid"] != warm["pid"] and cold["uids"] == [os.getuid()] * 4, "Cold Root kernel identity differs")
        require(os.readlink(f'/proc/{cold["pid"]}/ns/mnt') == os.readlink("/proc/self/ns/mnt"), "Cold Root stayed inside Flatpak mount namespace")
        raw = Path(f'/proc/{cold["pid"]}/environ').read_bytes()
        require(len(raw) <= 32768, "Cold environment exceeds bound")
        values = dict(item.split(b"=", 1) for item in raw.split(b"\0") if b"=" in item)
        require(all(values.get(k.encode()) == os.environ[k].encode() for k in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME")), "Cold Root did not use host fixture directories")
        cold_window = empty_windows(x11)[0]
        require(x11.inspect(cold_window)["pid"] == cold["pid"], "Cold native window owner differs")
        physical = root / "cold-surface"; physical.mkdir(mode=0o700)
        report["coldSurface"] = native.bitmap(helper.Request("snapshot", cold["pid"], cold["startTime"], P.HUB, HUB["sha256"], cold_window, P.TITLE, "FRAME"), physical, helper, x11)
        report.update(coldRoot=cold, coldWindow=cold_window, coldObserved=True)
        close_root(cold, cold_window, "coldNormalCloseObserved")
        report.update(settingsAfter=snapshot_fixtures(root), settingsPreserved=True, phase="complete")
        require(P.record(terms) == terms_before, "Consent changed after cold close")
        command("close-wm", ["/usr/bin/openbox", "--exit"]); wm.wait(timeout=10)
    except Exception as error:
        report["error"] = str(error)[:1000]
        raise
    finally:
        report["disposableTeardownRequired"] = report.get("phase") != "complete"
        report["logs"] = [log.metadata() for log in logs]
        P.save(root / "report.json", report)
        for fd in fds:
            os.close(fd)
        for log in logs:
            log.close()
        if x11 is not None:
            x11.dispose()


def main():
    admission(os.environ, sys.platform, platform.machine() if sys.platform == "linux" else "")
    require(len(sys.argv) in (2, 3), "Use stage, session, run, or gtk PHASE")
    mode, root = sys.argv[1], locations()
    if mode == "stage":
        require(len(sys.argv) == 2, "No stage arguments"); stage()
    elif mode == "session":
        _, native = P.helpers()
        env = clean_environment(root, os.environ)
        native.run_tool(root, "private-session", ["/usr/bin/env", *[k + "=" + v for k, v in env.items()], "/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24",
            "/usr/bin/dbus-run-session", "--", "/usr/bin/python3", "-B", str(Path(__file__).resolve()), "run"], timeout=240)
    else:
        require(os.environ.get("HOME") == str(root / "home") and os.environ.get("XDG_DATA_HOME") == str(root / "home/data")
                and os.environ.get("XDG_RUNTIME_DIR") == str(root / "runtime"), "Private profile required before D-Bus")
        if mode == "run" and len(sys.argv) == 2:
            exercise(root)
        elif mode == "gtk" and len(sys.argv) == 3 and sys.argv[2] in ("cancel", "warm", "cold"):
            gtk_worker(root, sys.argv[2])
        else:
            raise RuntimeError("Unreviewed finite activation mode")


if __name__ == "__main__":
    main()
