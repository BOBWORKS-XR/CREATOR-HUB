"""016 direct pages and one-guide Not now only. Approval migration is unfinished."""
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
HUB = "/usr/bin/creator-hub"
TITLE = "Creator Hub - Development Preview"
LOG_LIMIT = 262144  # Same finite bound as the reused native Capture primitive.
FLAGS = dict.fromkeys(("directPagesObserved", "guideDeferralAccepted", "manualReopenObserved", "migrationAccepted", "nativeMigrationCancellationAccepted",
                      "standaloneRetirementAccepted", "signedUpdateAccepted", "automaticRestartAccepted", "flatpakAccepted", "releaseReady"), False)


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
    return module


S = load("native-linux-016-stage")
require = S.require


def neutral_helpers():
    # Reuse only transport, process/window ownership, capture and read helpers.
    # Never call the historical session, fixtures, selectors or source admission.
    pages = load("native-linux-integrated-pages")
    helper, native = pages.helpers()
    return pages, helper, native


def fingerprint(file):
    require(file.resolve() == file, "Redirected fixture file")
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "Regular single-link fixture")
    raw = file.read_bytes(); after = file.lstat()
    fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")
    require(tuple(getattr(before, k) for k in fields) == tuple(getattr(after, k) for k in fields), "Fixture changed while reading")
    return {"size": len(raw), "sha256": S.digest(raw), "dev": before.st_dev, "ino": before.st_ino,
            "mode": stat.S_IMODE(before.st_mode), "uid": before.st_uid, "gid": before.st_gid}


def check_logs(logs):
    logs.pump()
    require(all(not value["truncated"] for value in logs.metadata().values()),
            "Owned driver log exceeded 256 KiB; bounded evidence retained, native run failed")


def log_evidence(logs, root):
    metadata = logs.metadata()
    require(set(metadata) == {"stdout", "stderr"}, "Unknown owned log streams")
    result = {}
    for name, value in metadata.items():
        saved = fingerprint(root / ("driver." + name))
        require(saved["mode"] == 0o600 and saved["uid"] == os.getuid() and saved["gid"] == os.getgid()
                and saved["size"] == value["retainedBytes"] <= LOG_LIMIT
                and value["bytes"] >= value["retainedBytes"]
                and value["truncated"] is (value["bytes"] > LOG_LIMIT), "Owned log metadata differs")
        result[name] = {**value, "file": saved, "limitBytes": LOG_LIMIT}
    return result


def fixtures(root, mode):
    home = root / "home"
    for name in ("home", "home/config", "home/data", "home/cache", "runtime", "tmp"):
        (root / name).mkdir(mode=0o700)
    project = home / "current-project"
    current = {"channels": [{"id": "current", "name": "016 retained project", "unity_project_path": str(project), "scene_path": None, "enabled": True}],
               "active_channel_id": "current", "mcp_server_path": "/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs",
               "auto_start": False, "tool_groups": "core", "enable_custom_scripts": False, "allow_all_tests": False,
               "automatic_update_checks": False, "connection_guide_version": 1, "unknownConfig": {"keep": 16}}
    legacy = json.loads(json.dumps(current))
    if mode == "migration-cancel":
        legacy["channels"].append({"id": "missing", "name": "Legacy unique project", "unity_project_path": str(home / "legacy-project"), "scene_path": None, "enabled": False})
        legacy["auto_start"] = True
    values = {"config/creator-works-mcp/launcher-config.json": current, "config/banter-mcp/launcher-config.json": legacy,
              "config/creator-works-mcp/hosted-operation-outcomes.json": {"revision": 1, "records": []},
              "data/CreatorProjectSetup/editor-roots.json": ["/opt/016-no-editor"],
              # GUI tests require a supported record. Future/unknown Hub fields
              # remain a separate retirement-only byte-preservation test.
              "data/CreatorHub/preferences/hub-preferences.json": {"schemaVersion": 1, "preview": False, "autoDownload": False, "restoreHostedViews": False},
              "config/Claude/claude_desktop_config.json": {"mcpServers": {"unrelated": {"command": "/bin/false"}}},
              ".codex/config.toml": '# retained 016 client\n[mcp_servers.unrelated]\ncommand = "/bin/false"\n[mcp_servers.creator-works]\ncommand = "/usr/lib/Creator Works MCP/server/runtime/node"\nargs = ["/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs"]\nenabled = false\n',
              "current-project/Packages/manifest.json": {"dependencies": {"com.sidequest.creator-sdk": "4.0.14"}},
              "current-project/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.21f1\n",
              "current-project/Assets/keep.txt": "protected 016 content\n",
              "legacy-project/Packages/manifest.json": {"dependencies": {}}, "legacy-project/Assets/keep.txt": "legacy protected\n",
              "legacy-project/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.21f1\n"}
    for name, value in values.items():
        file = home / name; file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        S.write(file, value.encode() if isinstance(value, str) else json.dumps(value).encode())
    return {name: fingerprint(home / name) for name in values}


def preserved(home, before):
    after = {name: fingerprint(home / name) for name in before}
    require(after == before, "Protected settings/client/project changed")
    # Not now must not start a settings backup, routing migration or retirement.
    for directory in (home / "config", home / "data"):
        require(not list(directory.rglob("*.bak")), "Cancellation unexpectedly created a settings backup")
    for name in ("data/CreatorHub/convergence/review-v1.json", "data/CreatorHub/client-migrations-v1", "config/creator-works-mcp/.creator-hub-product-settings"):
        require(not (home / name).exists(), "Cancellation unexpectedly advanced migration")
    return after


def installed(stage, binding):
    for name, expected in binding["packageFiles"].items():
        file = Path("/") / name
        require(file.resolve() == file, "Redirected installed resource")
        m = file.lstat()
        require(stat.S_ISREG(m.st_mode) and m.st_nlink == 1 and m.st_uid == m.st_gid == 0
                and stat.S_IMODE(m.st_mode) == expected["mode"] and m.st_size == expected["size"], "Installed resource metadata")
        require(S.digest(file.read_bytes()) == expected["sha256"], "Installed resource bytes")
    for package, version in (("creator-hub", "0.1.16"), ("creator-works-mcp", "2.7.7"), ("creator-project-setup", "0.3.7")):
        env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
        result = subprocess.run(["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", package], capture_output=True, check=True, env=env)
        require(result.stdout == f"{package}\t{version}\tamd64\tinstall ok installed\n".encode() and not result.stderr, "Installed package state differs")
        check = subprocess.run(["/usr/bin/dpkg", "--verify", package], capture_output=True, check=True, env=env)
        require(not check.stdout and not check.stderr, "Installed package verification differs")


def current_ui(d, pages, mode, reopened):
    pages.wait(lambda: d.read("#view-projects", "displayed") is True)
    require(d.read("#view-hub", "displayed") is False and d.read("#projects-home-title") == "Projects", "Current Projects home missing")
    require(d.read("#unified-home-updater", "displayed") is True, "One Hub updater missing")
    require(not d.elements("iframe,object,embed") and len(d.call("GET", "/window/handles")) == 1, "Nested app document/window")
    if not reopened:
        pages.wait(lambda: d.read("#convergence-dialog", "attribute/open") is not None)
        require(d.read("#convergence-title") == "Move to Hub" and d.read("#convergence-move", "displayed") is True
                and d.read("#convergence-move", "enabled") is True and not d.read("#convergence-error")
                and d.read("#convergence-later") == "Not now", "Current one-guide migration not offered")
        for old in ("prepare", "connections", "retire"):
            require(d.read("#convergence-" + old, "displayed") is False, "Obsolete migration controls exposed")
        d.click("#convergence-later")
    pages.wait(lambda: d.read("#convergence-dialog", "attribute/open") is None)
    # start() awaits convergence before populating Projects. This positive
    # readiness check prevents accepting a closed dialog before status returns.
    pages.wait(lambda: d.read('#project-list .project-row[data-mcp-selected="true"]', "displayed") is True)
    require(d.read("#convergence-dialog", "attribute/open") is None, "Migration guide reopened after startup")
    if mode == "migration-cancel":
        return {"oneGuideDeferred": True, "reminderSuppressionObserved": reopened}
    require("Selected for MCP" in d.read('#project-list .project-row[data-mcp-selected="true"]')
            and "MCP bridge not installed" in d.read('#project-list .project-row[data-mcp-selected="true"]'), "Home selection/bridge label unclear")
    result = {}
    for feature in ("mcp", "setup"):
        d.click("#suite-trigger")
        selector = '#suite-menu [data-view="' + feature + '"]'
        pages.wait(lambda: d.read(selector, "displayed") is True and d.read(selector, "enabled") is True)
        d.click(selector)
        prefix = "#feature-" + feature
        pages.wait(lambda: d.read(prefix, "attribute/aria-busy") == "false" and d.read(prefix + ' [data-field="status"]') == "Ready")
        require(not d.read(prefix + ' [data-field="error"]')
                and d.read(prefix + ' [data-field="controls"]', "attribute/disabled") is None, "Direct feature not Ready")
        require(not d.elements("iframe,object,embed") and len(d.call("GET", "/window/handles")) == 1, "Separate feature document/window")
        if feature == "mcp":
            selected = prefix + ' .feature-project[data-selected="true"]'
            require(d.read(selected + " .feature-project-select", "attribute/aria-pressed") == "true", "MCP selected project unclear")
            pages.wait(lambda: "Bridge not installed" in d.read(selected + " .feature-project-meta"))
        result[feature] = {"ready": True}
    return result


def session(root, home, binding, reopened=False):
    pages, helper, native = neutral_helpers()
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    Gdk.init([])
    d, x11 = pages.Driver(), helper.X11()
    driver_path = Path(os.environ["RUNNER_TEMP"]) / "native-linux-016-driver/bin/tauri-driver"
    driver_pin = S.parse((Path(os.environ["RUNNER_TEMP"]) / "native-linux-016-stage/driver.json").read_bytes())
    pages.pinned(driver_path, driver_pin, os.getuid(), 0o755)
    native_driver = pages.record("/usr/bin/WebKitWebDriver")
    require(native_driver["uid"] == native_driver["gid"] == 0 and native_driver["mode"] == 0o755, "Unprotected native driver")
    require(native.MAX_LOG == LOG_LIMIT, "Neutral log capture bound changed")
    wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    child = subprocess.Popen([str(driver_path), "--native-driver", "/usr/bin/WebKitWebDriver"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
    logs = native.Capture(child, root, "driver")
    for name in ("stdout", "stderr"):
        os.chmod(root / ("driver." + name), 0o600)
    request = owned = pidfd = None
    result = {"normalCloseObserved": False, "reopened": reopened, "disposableTeardownRequired": True}
    failure = None
    try:
        driver_identity = native.native_process(child.pid, helper)
        require(driver_identity["kernelImageSha256"] == driver_pin["sha256"], "Running intermediary driver differs")
        pages.wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"))
        def bootstrap_guard():
            check_logs(logs)
            require(child.poll() is None and native.native_process(child.pid, helper) == driver_identity
                    and pages.listener(child.pid, 4444), "Readiness intermediary identity/socket changed")
        d.guard = bootstrap_guard
        def available():
            check_logs(logs)
            require(child.poll() is None and native.native_process(child.pid, helper) == driver_identity, "Driver exited/changed")
            if not pages.listener(child.pid, 4444):
                return False
            return d.request("GET", "/status")["ready"] is True
        pages.wait(available)
        peers = [p for p in pages.subtree(child.pid, helper, native).values()
                 if p["executable"] == "/usr/bin/WebKitWebDriver" and p["parentPid"] == child.pid]
        require(len(peers) == 1, "One owned native driver required before session creation")
        backend = native.native_process(peers[0]["pid"], helper)
        require(backend["kernelImageSha256"] == native_driver["sha256"] and pages.listener(backend["pid"], 4445), "Pre-session native driver differs")
        def session_guard():
            bootstrap_guard()
            require(native.native_process(backend["pid"], helper) == backend and pages.listener(backend["pid"], 4445), "Session native driver changed")
        d.guard = session_guard
        response = d.request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": HUB, "args": []}}}})
        d.session = response["sessionId"]
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", d.session), "Invalid WebDriver session")
        roots = [p for p in pages.subtree(child.pid, helper, native).values() if p["executable"] == HUB]
        require(len(roots) == 1, "One driver-owned Hub required")
        owned = native.native_process(roots[0]["pid"], helper)
        require(owned["kernelImageSha256"] == binding["profile"]["pins"]["hub"]["sha256"], "Running Hub differs")
        parent = native.native_process(owned["parentPid"], helper)
        require(parent == backend and parent["executable"] == "/usr/bin/WebKitWebDriver" and parent["parentPid"] == child.pid
                and parent["kernelImageSha256"] == native_driver["sha256"], "Native driver ownership differs")
        pidfd = os.pidfd_open(owned["pid"])
        pages.wait(lambda: len(native.client_ids(x11)) == 1)
        window = native.client_ids(x11)[0]
        request = helper.Request("snapshot", owned["pid"], owned["startTime"], HUB, owned["kernelImageSha256"], window, TITLE, "FRAME")
        def guard():
            check_logs(logs)
            require(child.poll() is None and native.native_process(owned["pid"], helper) == owned, "Owned Hub changed")
            require(native.native_process(child.pid, helper) == driver_identity and native.native_process(parent["pid"], helper) == parent and pages.listener(child.pid, 4444)
                    and pages.listener(parent["pid"], 4445), "Driver identity/socket changed")
            require(native.client_ids(x11) == [window], "Unexpected native window/dialog")
            helper.bound_window(request, x11)
            pages.subtree(child.pid, helper, native)
        d.guard = guard; guard()
        terms = home / "data/CreatorHub/consent/hub-usage-terms.json"
        if not reopened:
            require(not terms.exists(), "Terms already seeded")
            pages.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
            accepted_after = time.time_ns() // 1000000
            d.click("#usage-terms-checkbox"); d.click("#usage-terms-continue")
        else:
            accepted_after = 1
        pages.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
        consent = S.parse(terms.read_bytes())
        require(set(consent) == {"schemaVersion", "policyVersion", "acceptedAtMs"} and consent["schemaVersion"] == 1
                and consent["policyVersion"] == "2026-09-28-v1" and type(consent["acceptedAtMs"]) is int
                and accepted_after <= consent["acceptedAtMs"] <= time.time_ns() // 1000000, "Native terms record differs")
        result["consent"] = fingerprint(terms)
        result.update(current_ui(d, pages, binding["profile"]["mode"], reopened))
        capture_dir = root / "physical"; capture_dir.mkdir(mode=0o700)
        result["surface"] = native.bitmap(request, capture_dir, helper, x11)
        require(result["surface"].get("nonblank") is True, "Blank Hub surface")
        result["root"] = owned
    except Exception as error:
        failure = error; result["error"] = str(error)[:1500]
    finally:
        if request is not None:
            try:
                d.guard(); x11.close_window(request.window, helper.bound_window(request, x11))
                def exited():
                    check_logs(logs)
                    return bool(select.select([pidfd], [], [], 0)[0]) and not Path(f"/proc/{request.pid}").exists()
                pages.wait(exited, 15)
                result["normalCloseObserved"] = True
                # Only dispose test tools after the product has exited normally.
                child.terminate(); child.wait(timeout=10)
                pages.wait(lambda: (logs.pump() or all(value["eof"] for value in logs.metadata().values())))
                subprocess.run(["/usr/bin/openbox", "--exit"], check=True, timeout=10); wm.wait(timeout=10)
                result["disposableTeardownRequired"] = False
            except Exception as error:
                result["closeError"] = str(error)[:700]
                if failure is None:
                    failure = error
        if pidfd is not None:
            os.close(pidfd)
        try:
            logs.pump(); result["driverLogs"] = log_evidence(logs, root)
            require(all(not value["truncated"] for value in result["driverLogs"].values()),
                    "Owned driver log exceeded 256 KiB; bounded evidence retained, native run failed")
        except Exception as error:
            result["logError"] = str(error)[:700]
            if failure is None:
                failure = error
        finally:
            x11.dispose(); logs.close()
        S.write(root / "session.json", json.dumps(result).encode())
    if failure is not None:
        raise failure
    require(result["normalCloseObserved"], "Normal close incomplete")
    return result


def main():
    S.admission(os.environ); require(sys.argv[1:] == [], "No native path/phase override")
    temp = Path(os.environ["RUNNER_TEMP"]); stage = temp / "native-linux-016-stage"
    binding = S.parse((stage / "binding.json").read_bytes()); S.profile(binding["profile"])
    installed(stage, binding)
    root = temp / "native-linux-016-result"
    if os.environ.get("CREATOR_016_PRIVATE") != "1":
        root.mkdir(mode=0o700)
        before = fixtures(root, binding["profile"]["mode"]); S.write(root / "before.json", json.dumps(before).encode())
        keep = ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "CREATOR_NATIVE_LINUX_016")
        env = {k: os.environ[k] for k in keep}
        env.update(PATH="/usr/bin:/bin", LANG="C.UTF-8", LC_ALL="C.UTF-8", HOME=str(root / "home"), XDG_CONFIG_HOME=str(root / "home/config"),
                   XDG_DATA_HOME=str(root / "home/data"), XDG_CACHE_HOME=str(root / "home/cache"), XDG_RUNTIME_DIR=str(root / "runtime"),
                   TMPDIR=str(root / "tmp"), GDK_BACKEND="x11", NO_AT_BRIDGE="0", CREATOR_016_PRIVATE="1")
        # No timeout kills or automatic retries; runner teardown owns failed sessions.
        result = subprocess.run(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24", "/usr/bin/dbus-run-session", "--",
                                 "/usr/bin/python3", "-B", str(Path(__file__).resolve())], env=env, check=False)
        require(result.returncode == 0, "Private native session failed; evidence retained")
        return
    home = root / "home"
    require(all(os.environ.get(k) == str(home / part) for k, part in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data"}.items()), "Isolated HOME differs")
    before = S.parse((root / "before.json").read_bytes())
    report = {**FLAGS, "scope": binding["profile"]["mode"], "harnessSource": os.environ["GITHUB_SHA"],
              "assembly": binding["profile"]["assembly"], "migrationApprovalImplemented": False}
    try:
        first = root / "first"; first.mkdir(mode=0o700); report["first"] = session(first, home, binding)
        report["protectedAfterFirst"] = preserved(home, before); installed(stage, binding)
        second = root / "reopened"; second.mkdir(mode=0o700); report["reopened"] = session(second, home, binding, True)
        require(report["first"]["root"]["pid"] != report["reopened"]["root"]["pid"], "Reopen did not create a new Hub")
        require(report["first"]["consent"] == report["reopened"]["consent"], "Terms did not persist unchanged across manual reopen")
        report["protectedAfterReopen"] = preserved(home, before); installed(stage, binding)
        report["manualReopenObserved"] = True
        report["guideDeferralAccepted"] = True
        report["directPagesObserved"] = binding["profile"]["mode"] == "pages"
    except Exception as error:
        report["error"] = str(error)[:1500]; raise
    finally:
        S.write(root / "report.json", json.dumps(report).encode())


if __name__ == "__main__":
    main()
