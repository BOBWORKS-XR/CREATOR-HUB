"""Opt-in installed Root WebDriver test; never installs, authenticates or publishes.

Parent binding (0600, caller owned): schemaVersion, sourceCommit, package
{path,size,sha256,version}, hub {size,sha256}, driver/server {path,size,sha256}.
The parent must independently verify the DEB/ELF and extract the real server.
No expected hash is learned from the running application. No native dialog input.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import select
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
HUB = "/usr/bin/creator-hub"
TITLE = "Creator Hub - Development Preview"
POLICY = "2026-09-28-v1"
CONFIG = "config/creator-works-mcp/launcher-config.json"
FALSE_GATES = dict.fromkeys(("releaseReady", "migrationAccepted", "signedUpdateAccepted", "restartAccepted",
                            "flatpakAccepted", "nativeAuthenticationAccepted", "liveAiAccepted", "nativeGuiAccepted",
                            "hostIntegrationAccepted", "installationAccepted", "mcpAccepted", "setupAccepted"), False)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def admission(env, system, machine):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB",
                "GITHUB_REPOSITORY_ID": "1364807512",
                "GITHUB_REF": "refs/heads/validation/linux-integrated-pages", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "CREATOR_LINUX_INTEGRATED_PAGES": "1"}
    require(system == "linux" and machine == "x86_64" and all(env.get(k) == v for k, v in expected.items())
            and env.get("GITHUB_EVENT_NAME") in ("workflow_dispatch", "push"),
            "Exact opt-in disposable Linux validation branch required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")) and
            all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "Invalid CI source/run")
    require(not any(re.match(r"^(LD_|PYTHONPATH$|PYTHONHOME$|NODE_OPTIONS$|WEBKIT_|TAURI_|CREATOR_HUB_SIGNING_|SSL_CERT_)", k)
                    for k in env), "Inherited runtime/signing overrides refused")


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "Duplicate JSON key")
        value[key] = item
    return value


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: require(False, "Nonfinite JSON"))


def stamp(value):
    return tuple(getattr(value, key) for key in ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns"))


def record(file, limit=256 * 1024 * 1024):
    file = Path(file)
    require(file.is_absolute() and file.resolve(strict=True) == file, "Redirected file refused")
    before = file.stat()
    require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= limit, "Invalid bounded regular file")
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        if sys.platform == "linux":
            require(stamp(os.fstat(stream.fileno())) == stamp(before), "Opened file identity differs")
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        if sys.platform == "linux":
            require(stamp(os.fstat(stream.fileno())) == stamp(before), "Open file changed during measurement")
    require(file.resolve(strict=True) == file and stamp(file.stat()) == stamp(before), "File changed during measurement")
    return dict(size=before.st_size, sha256=digest.hexdigest(), mode=stat.S_IMODE(before.st_mode), uid=before.st_uid, gid=before.st_gid)


def pinned(file, expected, uid, mode):
    require(type(expected["size"]) is int and 0 < expected["size"] <= 256 * 1024 * 1024
            and type(expected["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", expected["sha256"]), "Invalid parent file pin")
    value = record(file)
    require(value == {"size": expected["size"], "sha256": expected["sha256"], "mode": mode, "uid": uid, "gid": os.getgid() if uid else 0},
            "Exact file hash/size/numeric owner/mode differs: " + str(file))
    return value


def save(file, value):
    with Path(file).open("x", encoding="utf8") as stream:
        os.chmod(file, 0o600)
        json.dump(value, stream, indent=2, allow_nan=False)


def helpers():
    loaded = []
    for name in ("native-unix-window", "native-linux-root-probe"):
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        loaded.append(module)
    return loaded


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("WebDriver redirect refused")


class Driver:
    def __init__(self):
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.session, self.guard = "", lambda: None

    def request(self, method, suffix, payload=None, limit=131072):
        require(method in ("GET", "POST", "DELETE") and re.fullmatch(r"/[A-Za-z0-9_./-]+", suffix)
                and ".." not in suffix, "Invalid finite WebDriver request")
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        require(body is None or len(body) <= 16384, "Oversized WebDriver request")
        self.guard()
        request = urllib.request.Request("http://127.0.0.1:4444" + suffix, body, {"Content-Type": "application/json"}, method=method)
        try:
            with self.http.open(request, timeout=15) as response:
                require(response.status == 200, "Unexpected HTTP outcome")
                length = response.headers.get("Content-Length")
                require(length is None or (length.isdecimal() and int(length) <= limit), "Oversized response header")
                raw = response.read(limit + 1)
        except urllib.error.HTTPError as error:
            raw = error.read(2049)
            detail = "Protocol error body unavailable or oversized"
            if len(raw) <= 2048:
                try:
                    value = parse(raw).get("value", {})
                    detail = str(value.get("error", "unknown"))[:80] + ": " + str(value.get("message", ""))[:500]
                except (ValueError, AttributeError, RuntimeError):
                    pass
            raise RuntimeError(f"WebDriver {method} {suffix}: HTTP {error.code}: {detail}") from None
        require(0 < len(raw) <= limit, "Oversized/empty WebDriver response")
        require(length is None or len(raw) == int(length), "Truncated WebDriver response")
        result = parse(raw)
        require(type(result) is dict and "value" in result, "Malformed WebDriver outcome")
        value = result["value"]
        require(not (type(value) is dict and "error" in value), "WebDriver command failed: " + str(value)[:300])
        self.guard()
        return value

    def call(self, method, suffix, value=None, **kwargs):
        return self.request(method, "/session/" + self.session + suffix, value, **kwargs)

    def elements(self, selector):
        value = self.call("POST", "/elements", {"using": "css selector", "value": selector})
        require(type(value) is list and len(value) <= 64, "Element inventory exceeds bound")
        ids = [item.get("element-6066-11e4-a52e-4f735466cecf") for item in value]
        require(all(type(i) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", i) for i in ids), "Invalid element IDs")
        return ids

    def element(self, selector):
        value = self.elements(selector)
        require(len(value) == 1, "Expected exactly one control: " + selector)
        return value[0]

    def read(self, selector, endpoint="text"):
        return self.call("GET", "/element/" + self.element(selector) + "/" + endpoint)

    def click(self, selector):
        require(self.read(selector, "displayed") is True and self.read(selector, "enabled") is True, "Control not actionable")
        self.call("POST", "/element/" + self.element(selector) + "/click", {})


def wait(check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise RuntimeError("Read-only readiness deadline; no mutation retried")


def feature_status(status, error, enabled):
    require(type(status) is str and len(status) <= 512 and type(error) is str and len(error) <= 2048, "Invalid page status")
    require(not error and status == "Ready" and enabled is True, "Feature not ready: " + status + " " + error)


def defer_migration(driver):
    wait(lambda: driver.read("#convergence-dialog", "attribute/open") is not None)
    driver.click("#convergence-later")
    wait(lambda: driver.read("#convergence-dialog", "attribute/open") is None)


def png_dimensions(png):
    require(33 <= len(png) <= 6 * 1024 * 1024 and png[:16] == b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "Invalid bounded PNG")
    width, height = struct.unpack(">II", png[16:24])
    require(560 <= width <= 1920 and 480 <= height <= 1080, "Screenshot dimensions differ")
    return width, height


def fixtures(root, server):
    home = root / "home"
    for part in ("home", "home/config", "home/data", "home/cache", "runtime", "tmp"):
        (root / part).mkdir(mode=0o700)
    project = home / "retained-project"
    config = {"channels": [{"id": "retained", "name": "Retained fixture", "unity_project_path": str(project),
                            "scene_path": None, "enabled": False, "unknownChannel": "keep"}], "active_channel_id": None,
              "mcp_server_path": str(server), "auto_start": False, "tool_groups": "core", "enable_custom_scripts": False,
              "allow_all_tests": False, "automatic_update_checks": False, "connection_guide_version": 1, "unknownConfig": {"keep": 17}}
    values = {"config/creator-works-mcp/launcher-config.json": config,
              "config/Claude/claude_desktop_config.json": {"mcpServers": {"unrelated": {"command": "/bin/false"}}},
              ".codex/config.toml": '[mcp_servers.unrelated]\ncommand = "/bin/false"\n',
              "data/CreatorProjectSetup/editor-roots.json": [str(home / "retained-editor")],
              "data/CreatorHub/preferences/hub-preferences.json": {"schemaVersion": 1, "preview": False, "autoDownload": False, "restoreHostedViews": False},
              "retained-project/Packages/manifest.json": {"dependencies": {}}, "retained-project/Assets/keep.json": {"keep": 23}}
    for relative, value in values.items():
        file = home / relative
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if isinstance(value, str):
            with file.open("x", encoding="utf8") as stream:
                stream.write(value)
            os.chmod(file, 0o600)
        else:
            save(file, value)
    return config, {name: record(home / name) for name in values}


def preserved(home, before, original, groups):
    require(all(record(home / name) == value for name, value in before.items() if name != CONFIG), "Protected fixture changed")
    current = record(home / CONFIG, 262144)
    require(all(current[k] == before[CONFIG][k] for k in ("mode", "uid", "gid")), "MCP settings protection changed")
    actual = parse((home / CONFIG).read_bytes())
    require(actual == {**original, "tool_groups": groups}, "Unexpected MCP setting/project/unknown-field change")


def listener(pid, port):
    descriptors = list(Path(f"/proc/{pid}/fd").iterdir())
    require(len(descriptors) <= 256, "Driver descriptor bound exceeded")
    sockets = set()
    for file in descriptors:
        try:
            sockets.add(os.readlink(file))
        except FileNotFoundError:
            pass
    raw = Path(f"/proc/{pid}/net/tcp").read_bytes()
    require(len(raw) <= 65536, "Socket inventory exceeds bound")
    matches = [line.split() for line in raw.decode("ascii").splitlines()[1:]
               if line.split()[1:2] == [f"0100007F:{port:04X}"] and line.split()[3:4] == ["0A"]]
    return len(matches) == 1 and f"socket:[{matches[0][9]}]" in sockets


def subtree(pid, helper, native):
    pending, found = [(pid, None)], {}
    while pending:
        current, parent = pending.pop()
        require(current not in found and len(found) < 64, "Driver subtree exceeds bound")
        item = native.native_process(current, helper, False)
        require(parent is None or item["parentPid"] == parent, "Child ownership changed")
        require(item["uids"] == [os.getuid()] * 4, "Foreign UID in owned subtree")
        require(Path(item["executable"]).name not in ("creator-works-mcp-launcher", "creator-project-setup"), "Legacy module GUI launched")
        found[current] = item
        tasks = list(Path(f"/proc/{current}/task").iterdir())
        require(len(tasks) <= 128, "Thread inventory exceeds bound")
        children = set()
        for task in tasks:
            try:
                raw = (task / "children").read_bytes()
                require(len(raw) <= 8192 and re.fullmatch(rb"[0-9 ]*", raw), "Invalid child inventory")
                children.update(map(int, raw.split()))
            except FileNotFoundError:
                pass
        require(not children.intersection(found), "Repeated/cyclic child inventory")
        pending.extend((child, current) for child in children)
    return found


def run(binding, root, report):
    helper, native = helpers()
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    Gdk.init([])
    command = lambda label, args: native.run_tool(root, label, args)[1]
    package, hub, driver = binding["package"], binding["hub"], binding["driver"]
    require(command("harness-source", ["/usr/bin/git", "-C", str(HERE.parent), "rev-parse", "HEAD"])
            == (os.environ["GITHUB_SHA"] + "\n").encode(), "Harness checkout differs from CI source")
    require(command("package-state", ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}", "creator-hub"])
            == ("creator-hub\t" + package["version"] + "\tamd64\tinstalled").encode(), "Installed package differs")
    require(command("dpkg-verify", ["/usr/bin/dpkg", "--verify", "creator-hub"]) == b"", "Installed package verification failed")
    pinned(HUB, hub, 0, 0o755)
    native_driver = record("/usr/bin/WebKitWebDriver")
    require((native_driver["uid"], native_driver["gid"], native_driver["mode"]) == (0, 0, 0o755), "Unprotected native driver")
    wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    wm_log = native.Capture(wm, root, "wm")
    child = subprocess.Popen([driver["path"], "--native-driver", "/usr/bin/WebKitWebDriver"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    logs = native.Capture(child, root, "driver")
    x11, request, pidfd, d = helper.X11(), None, None, Driver()
    driver_identity = native.native_process(child.pid, helper)
    try:
        wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"))
        # Readiness alone may retry; a session creation or click is issued once.
        def available():
            try:
                return listener(child.pid, 4444) and d.request("GET", "/status").get("ready") is True
            except urllib.error.URLError:
                require(child.poll() is None, "Owned driver exited before readiness")
                return False
        wait(available)
        value = d.request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": HUB, "args": []}}}})
        d.session = value["sessionId"]
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", d.session), "Invalid session ID")
        peers = subtree(child.pid, helper, native)
        roots = [p for p in peers.values() if p["executable"] == HUB]
        require(len(roots) == 1, "Exact driver-owned Root missing/ambiguous")
        owned = native.native_process(roots[0]["pid"], helper)
        require(owned["kernelImageSha256"] == hub["sha256"], "Running Root image differs")
        parent = native.native_process(owned["parentPid"], helper)
        require(parent["pid"] in peers and parent["executable"] == "/usr/bin/WebKitWebDriver"
                and parent["kernelImageSha256"] == native_driver["sha256"] and parent["parentPid"] == child.pid,
                "Root is not the owned native driver's direct child")
        require(driver_identity["kernelImageSha256"] == driver["sha256"], "Running intermediary driver differs")
        pidfd = os.pidfd_open(owned["pid"])
        wait(lambda: bool(x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_CLIENT_LIST_STACKING")))
        windows = native.client_ids(x11)
        require(len(windows) == 1 and x11.inspect(windows[0])["pid"] == owned["pid"], "Unexpected native window/dialog")
        request = helper.Request("snapshot", owned["pid"], owned["startTime"], HUB, hub["sha256"], windows[0], TITLE, "FRAME")
        report.update(rootProcess=owned, driverProcess=driver_identity, nativeDriverProcess=parent,
                      xres=helper.bound_window(request, x11), fixtureBefore=binding["fixtures"])
        def guard():
            logs.pump(); wm_log.pump()
            current = subtree(child.pid, helper, native)
            for expected in (driver_identity, parent, owned):
                require(current.get(expected["pid"]) == {k: v for k, v in expected.items() if k != "kernelImageSha256"}, "Owned process chain changed")
            require(listener(child.pid, 4444) and listener(parent["pid"], 4445), "Driver socket ownership changed")
            require(native.client_ids(x11) == windows, "Unexpected GTK/module window; no native action attempted")
            helper.bound_window(request, x11)
        d.guard = guard
        require(len(d.call("GET", "/window/handles")) == 1 and not d.elements("iframe,object,embed"), "Unexpected webview/frame")
        terms = root / "home/data/CreatorHub/consent/hub-usage-terms.json"
        require(not terms.exists(), "Terms were already seeded/accepted")
        wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
        started = time.time_ns() // 1000000
        d.click("#usage-terms-checkbox"); d.click("#usage-terms-continue")
        wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
        consent = parse(terms.read_bytes())
        require(set(consent) == {"schemaVersion", "policyVersion", "acceptedAtMs"} and consent["schemaVersion"] == 1
                and consent["policyVersion"] == POLICY and type(consent["acceptedAtMs"]) is int
                and started <= consent["acceptedAtMs"] <= time.time_ns() // 1000000, "Native terms record missing/differs")
        report["termsObserved"] = True
        report["phase"] = "defer-migration-for-page-test"
        defer_migration(d)
        report["migrationDeferred"] = True
        preserved(root / "home", binding["fixtures"], binding["config"], "core")
        for feature in ("mcp", "setup"):
            report["phase"] = "open-" + feature
            if feature == "mcp":
                d.click('#entry-mcp .app-row')
            else:
                d.click("#suite-trigger"); d.click('#suite-menu [data-view="setup"]')
            prefix = "#feature-" + feature
            wait(lambda: bool(d.elements(prefix + ' [data-field="status"]')) and d.read(prefix + ' [data-field="status"]') == "Ready"
                 and d.read(prefix, "attribute/aria-busy") == "false")
            feature_status(d.read(prefix + ' [data-field="status"]'), d.read(prefix + ' [data-field="error"]'), d.read(prefix + ' [data-field="controls"]', "attribute/disabled") is None)
            require(not d.elements("iframe,object,embed") and len(d.call("GET", "/window/handles")) == 1, "Separate webview/frame")
            if feature == "mcp":
                preserved(root / "home", binding["fixtures"], binding["config"], "core")
                require(d.read(prefix + ' [data-field="project"]', "property/value") == "", "A project was selected unexpectedly")
                summaries = d.elements(prefix + " details.feature-section > summary")
                require(len(summaries) == 2, "Advanced settings structure changed")
                require(d.call("GET", "/element/" + summaries[1] + "/text") == "Advanced settings", "Wrong summary")
                d.call("POST", "/element/" + summaries[1] + "/click", {})
                d.click(prefix + ' [data-field="groups"] option[value="read"]'); d.click(prefix + ' [data-field="save"]')
                wait(lambda: d.read(prefix + ' [data-field="setup-result"]').startswith("Options saved."))
                wait(lambda: d.read(prefix, "attribute/aria-busy") == "false" and d.read(prefix + ' [data-field="status"]') == "Ready")
                preserved(root / "home", binding["fixtures"], binding["config"], "read")
            else:
                require(d.read(prefix + ' [data-field="platform"]') == "linux", "Wrong Setup platform")
            encoded = d.call("GET", "/screenshot", limit=8 * 1024 * 1024)
            png = base64.b64decode(encoded, validate=True)
            width, height = png_dimensions(png)
            import gi
            gi.require_version("GdkPixbuf", "2.0")
            from gi.repository import GdkPixbuf
            loader = GdkPixbuf.PixbufLoader.new_with_type("png"); loader.write(png); loader.close()
            image = loader.get_pixbuf()
            metrics = native.pixel_metrics(image.get_pixels(), width, height, image.get_rowstride(), image.get_n_channels())
            with (root / (feature + ".png")).open("xb") as stream:
                stream.write(png)
            physical = root / ("physical-" + feature)
            physical.mkdir(mode=0o700)
            d.guard()
            surface = native.bitmap(request, physical, helper, x11)
            d.guard()
            report[feature] = {"status": "Ready", "screenshot": metrics, "sha256": hashlib.sha256(png).hexdigest(),
                               "nativeSurface": surface}
        preserved(root / "home", binding["fixtures"], binding["config"], "read")
        pinned(HUB, hub, 0, 0o755)
        report["pagesObserved"] = True
    except Exception:
        if request is not None:
            try:
                d.guard()
                report["openDialogs"] = [str(d.call("GET", "/element/" + element + "/text"))[:2048]
                                         for element in d.elements("dialog[open]")]
                physical = root / "physical-failure"
                physical.mkdir(mode=0o700)
                report["failureSurface"] = native.bitmap(request, physical, helper, x11)
            except Exception as capture_error:
                report["failureCaptureError"] = str(capture_error)[:500]
        raise
    finally:
        if request is not None:
            try:
                d.guard(); helper.identity(request, helper.Proc())
                x11.close_window(request.window, helper.bound_window(request, x11))
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not select.select([pidfd], [], [], 0.1)[0]:
                    logs.pump(); wm_log.pump()
                require(bool(select.select([pidfd], [], [], 0)[0]), "Root did not exit after normal close")
                wait(lambda: not Path(f"/proc/{request.pid}").exists(), 3)
                report["normalCloseObserved"] = True
            except Exception as error:
                report["closeError"] = str(error)[:500]
        d.guard = lambda: None
        # WebKit session destruction can kill its browser: only delete after observed exit.
        if report["normalCloseObserved"] and d.session:
            try:
                d.call("DELETE", "")
            except Exception as error:
                report["sessionCleanupError"] = str(error)[:300]
        if pidfd is not None:
            os.close(pidfd)
        x11.dispose()
        if report["normalCloseObserved"]:
            child.terminate(); child.wait(timeout=10)
            subprocess.run(["/usr/bin/openbox", "--exit"], check=True, timeout=10)
            wm.wait(timeout=10)
        report["disposableTeardownRequired"] = not report["normalCloseObserved"]
        deadline = time.monotonic() + 2
        while report["normalCloseObserved"] and time.monotonic() < deadline and not all(v["eof"] for v in logs.items.values()):
            logs.pump(0.02); wm_log.pump()
        report["logs"] = logs.metadata()
        logs.close(); wm_log.close()
        if report["normalCloseObserved"] and report.get("pagesObserved"):
            preserved(root / "home", binding["fixtures"], binding["config"], "read")
            pinned(HUB, hub, 0, 0o755)
            report["fixturesPreservedAfterClose"] = True


def main():
    admission(os.environ, sys.platform, platform.machine() if sys.platform == "linux" else "")
    require(len(sys.argv) == 2, "Expected parent-verified binding JSON")
    temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    source = Path(sys.argv[1])
    require(source == temp / "linux-integrated-pages-input.json", "Fixed private parent binding path required")
    meta = record(source, 16384)
    require(meta["uid"] == os.getuid() and meta["mode"] == 0o600, "Parent binding is not private")
    binding = parse(source.read_bytes())
    require(type(binding["schemaVersion"]) is int and binding["schemaVersion"] == 1
            and re.fullmatch(r"[a-f0-9]{40}", binding["sourceCommit"]), "Invalid package source")
    package = binding["package"]
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", package["version"]), "Invalid package version")
    require(Path(package["path"]).suffix == ".deb" and Path(binding["driver"]["path"]).name == "tauri-driver"
            and Path(binding["server"]["path"]).name == "creator-works-mcp.mjs", "Unexpected parent input kind")
    require(all(Path(binding[key]["path"]).is_relative_to(temp) for key in ("package", "driver", "server")), "Inputs must be private runner-temporary artifacts")
    pinned(package["path"], package, os.getuid(), 0o600)
    for name in ("driver", "server"):
        pinned(binding[name]["path"], binding[name], os.getuid(), 0o755 if name == "driver" else 0o600)
    require(HERE.parent == Path(os.environ["GITHUB_WORKSPACE"]).resolve(), "Foreign harness workspace")
    root = temp / "linux-integrated-pages"
    if os.environ.get("CREATOR_PAGES_PRIVATE_SESSION") != "1":
        root.mkdir(mode=0o700)
        config, before = fixtures(root, binding["server"]["path"])
        save(root / "fixture-binding.json", {"config": config, "fixtures": before})
        env = {k: v for k, v in os.environ.items() if k in ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "CREATOR_LINUX_INTEGRATED_PAGES")}
        env.update(PATH="/usr/bin:/bin", LANG="C.UTF-8", LC_ALL="C.UTF-8", HOME=str(root / "home"), XDG_CONFIG_HOME=str(root / "home/config"), XDG_DATA_HOME=str(root / "home/data"), XDG_CACHE_HOME=str(root / "home/cache"), XDG_RUNTIME_DIR=str(root / "runtime"), TMPDIR=str(root / "tmp"), GDK_BACKEND="x11", NO_AT_BRIDGE="0", CREATOR_PAGES_PRIVATE_SESSION="1")
        _, native = helpers()
        native.run_tool(root, "private-session", ["/usr/bin/env", *[k + "=" + v for k, v in env.items()], "/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24", "/usr/bin/dbus-run-session", "--", "/usr/bin/python3", "-B", str(Path(__file__).resolve()), str(source)], timeout=180)
        return
    require(all(os.environ.get(k) == str(root / suffix) for k, suffix in {"HOME": "home", "XDG_CONFIG_HOME": "home/config", "XDG_DATA_HOME": "home/data", "XDG_RUNTIME_DIR": "runtime"}.items()), "Fresh private profile required")
    binding.update(parse((root / "fixture-binding.json").read_bytes()))
    report = {**FALSE_GATES, "sourceCommit": binding["sourceCommit"], "harnessCommit": os.environ["GITHUB_SHA"], "package": package, "hub": binding["hub"], "normalCloseObserved": False, "rootExitCode": None, "disposableTeardownRequired": True}
    try:
        run(binding, root, report)
        require(report["normalCloseObserved"], "Normal owned close not observed")
    except Exception as error:
        report["error"] = str(error)[:1000]
        raise
    finally:
        save(root / "report.json", report)


if __name__ == "__main__":
    main()
