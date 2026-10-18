"""One installed, isolated Linux migration and normal-reopen check, not updater acceptance."""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import select
import shutil
import stat
import subprocess
import sys
import time
import signal

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BRANCH = "refs/heads/validation/linux-integrated-migration"
SOURCE = "bbd0a5d58562a3d8af0c84e5360eef9d26803eef"
HELPER_SOURCE = "4f2243591fa51243c10250b8a23a30e60f8d2888"
HELPERS = {
    "native-linux-integrated-pages.py": (29342, "cdb370433c563058b5f4afba303755388aa025bf56d8d133f3739c1d57b821cb"),
    "native-linux-root-probe.py": (85081, "91983346c5bac811028135b41c11a0dfc10e40a61c9f65aab535df326e354e72"),
    "native-unix-window.py": (46844, "a8aa761c41b26c4cd4a52f4f3c698046ca4cca20e97c08ee5cd41d68afbfb83f"),
}
OLD = {"release": 402569194, "asset": 608030423, "source": "9cd12e28d1dd05057b84166d4718a5d6369eff93",
       "size": 1769943, "sha256": "21ccf2b284207a5c76d188e59e2967282a39bfd7457a13ac7e3ffb91b3002884",
       "serverSize": 1221209, "serverSha256": "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149"}
HUB = "/usr/bin/creator-hub"
FALSE_GATES = dict.fromkeys(("releaseReady", "signedUpdateAccepted", "restartAccepted", "flatpakAccepted",
                            "liveAiAccepted", "standaloneRemovalAccepted", "nativeAuthenticationAccepted"), False)
BACKUP_QUESTION = "Let Creator Hub use your existing MCP and Project Setup settings?\n\nHub will ask verified idle standalone app windows to close normally, then keep exact local backups. Busy or unverified apps are not force-closed. AI clients, Unity and Node connections stay open.\n\nSettings remain in their current locations; Unity projects are not moved or edited. Existing AI connections are reviewed separately before changing them. No standalone installation is removed by this step. Cancel leaves the current setup unchanged."
ROUTING_QUESTION = "Enable Creator Hub's managed MCP connection?\n\nA signed retained router will keep AI-client command paths stable across compatible Hub updates. Existing client settings are not changed by this action. Moving their connections still requires your approval. Old apps and Unity projects stay in place."
FINISH_QUESTION = "Finish moving to Creator Hub?\n\nYour settings backups and existing AI connections have been reviewed. No known standalone MCP or Project Setup installation was found. This step only finishes the guide; it does not remove an app, change client settings, move projects or stop a connection.\n\nCancel keeps the guide open."


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def admission(env, system, machine):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB",
                "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": BRANCH,
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "CREATOR_INTEGRATED_MIGRATION": "1"}
    require(system == "linux" and machine == "x86_64" and all(env.get(k) == v for k, v in expected.items())
            and env.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch"), "Exact disposable Linux migration branch required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Source commit required")
    require(not any(re.match(r"^(LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|NODE_OPTIONS$|TAURI_|WEBKIT_|SSL_CERT_|CREATOR_HUB_SIGNING_)", k) for k in env)
            and not env.get("FLATPAK_ID"), "Foreign runtime/signing context refused")


def helpers():
    directory = HERE.parent / "migration-helpers/scripts"
    for name, (size, sha) in HELPERS.items():
        raw = (directory / name).read_bytes()
        require(len(raw) == size and digest(raw) == sha, "Frozen helper differs: " + name)
    spec = importlib.util.spec_from_file_location("migration_pages", directory / "native-linux-integrated-pages.py")
    pages = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pages)
    return (pages, *pages.helpers())


def route_paths(home, descriptor):
    module = descriptor["module"]
    encoded = json.dumps({"executable": module["executable"], "version": module["version"],
                          "files": dict(sorted(module["files"].items()))}, separators=(",", ":"), ensure_ascii=False).encode()
    generation = digest(encoded)
    base = home / "data/creator-hub"
    return (base / "mcp-route-v1/linux-x86_64/router-v1/creator-hub-mcp-router",
            base / "runtime-generations/linux-x86_64" / generation / "mcp/server/creator-works-mcp.mjs", generation)


def profiles(home, descriptor):
    router, server, _ = route_paths(home, descriptor)
    old = home / "data/creator-works-mcp/server"
    project = home / "retained-project"
    details = f"Codex\nOld command: {old}/runtime/node\nOld server: {old}/creator-works-mcp.mjs\nProject kept: {project}"
    batch = f"Move these existing connections to Creator Hub?\n\n{details}\n\nManaged router: {router}\nArguments: none. Signed activation selects the retained runtime.\n\nNames and ownership markers are not publisher verification. Continue only for your Creator Works connections. Exact local before/after images and backups are retained. Client options, other servers and selected projects are preserved. Interrupted changes require recovery review; no blind rollback is attempted. No app is uninstalled or stopped."
    server_question = f"Move the saved MCP server path to Hub's verified retained runtime?\n\nNew server: {server}\n\nOnly this path changes. Project selection, options and unknown settings are preserved. Exact local backups and recovery records are kept. Old apps and AI clients are not stopped or removed by this step."
    return [
        ("Move to unified Creator Hub", "Information", BACKUP_QUESTION, "Back up and continue", "Keep existing"),
        ("Enable managed MCP routing", "Information", ROUTING_QUESTION, "Enable managed routing", "Not now"),
        ("Review existing MCP connections", "Warning", batch, "Move selected connections", "Keep existing"),
        ("Keep MCP settings working in Hub", "Information", server_question, "Move server path", "Keep existing"),
        ("Finish Creator Hub migration", "Information", FINISH_QUESTION, "Finish migration", "Keep reviewing"),
    ]


def validate_graph(profile, graph, pid, frame):
    require(0 < len(graph) <= 64 and len({tuple(n["ref"]) for n in graph}) == len(graph), "Ambiguous GTK graph")
    require(all(n["pid"] == pid for n in graph), "Foreign GTK node")
    require(all(n["role"] not in (40, 61, 79) for n in graph), "Unexpected input node")
    require(graph[0]["role"] == 2 and graph[0]["name"] == profile[1] and graph[0]["frame"] == list(frame), "AX/native dialog association differs")
    require([n["name"] for n in graph if n["role"] == 43].count(profile[3]) == 1
            and sorted(n["name"] for n in graph if n["role"] == 43) == sorted(profile[3:]), "Exact two source-bound buttons required")
    require(sum(n["role"] == 29 and n["name"] == profile[2] for n in graph) == 1, "Exact source-bound question required")
    require(any(n["role"] == 29 and n["name"] == profile[0] for n in graph), "Source title label missing")
    require(all(n["ready"] for n in graph if n["role"] in (2, 29, 43)), "Hidden/busy GTK approval")
    refs = {tuple(n["ref"]) for n in graph}
    require(all(n["parent"] is None if i == 0 else tuple(n["parent"]) in refs for i, n in enumerate(graph)), "Escaped GTK parent")


def seed(root, binding, pages):
    home = root / "home"
    old = home / "data/creator-works-mcp/server/creator-works-mcp.mjs"
    config, _ = pages.fixtures(root, old)
    old.parent.mkdir(mode=0o700, parents=True)
    (old.parent / "runtime").mkdir(mode=0o700)
    for key, target, mode in (("legacyServer", old, 0o600), ("node", old.parent / "runtime/node", 0o755)):
        shutil.copyfile(binding[key]["path"], target)
        os.chmod(target, mode)
        pages.pinned(target, binding[key], os.getuid(), mode)
    codex = home / ".codex/config.toml"
    codex.write_text(f'# retained foreign preamble\nmodel = "keep-model"\n[mcp_servers.unrelated]\ncommand = "/bin/false"\n\n[mcp_servers."creator-works"]\ncommand = "{old.parent}/runtime/node"\nargs = ["{old}"]\ntimeout = 37\nenabled = false\n[mcp_servers."creator-works".env]\nUNITY_PROJECT_PATH = "{home}/retained-project"\nCUSTOM = "preserve"\n', encoding="utf8")
    return {"config": config, "clientBefore": codex.read_text(), "before": {str(f.relative_to(home)): pages.record(f) for f in home.rglob("*") if f.is_file()}}


def completed_journal(pending, completed, before, after, current, allowed):
    require(pending == completed and pending.get("schema") == 1 and set(pending) == {"schema", "files"}, "Unfinished/unknown migration journal")
    require(type(pending["files"]) is list and len(pending["files"]) == 1, "Unexpected transaction members")
    entry = pending["files"][0]
    require(set(entry) == {"client", "path", "before_sha256", "after_sha256"} and entry["path"] in allowed, "Foreign journal target")
    require(digest(before) == entry["before_sha256"] and digest(after) == entry["after_sha256"] and current == after,
            "Journal before/after/current evidence differs")


def preserved(root, binding, fixtures, pages):
    home = root / "home"
    router, server, generation = route_paths(home, binding["runtime"])
    changes = {pages.CONFIG, ".codex/config.toml"}
    for name, expected in fixtures["before"].items():
        if name not in changes:
            require(pages.record(home / name) == expected, "Foreign/project/old-runtime fixture changed: " + name)
    actual = pages.parse((home / pages.CONFIG).read_bytes())
    require(actual == {**fixtures["config"], "mcp_server_path": str(server)}, "Unexpected product-setting change")
    codex = (home / ".codex/config.toml").read_text()
    import toml
    expected_client = toml.loads(fixtures["clientBefore"])
    entry = expected_client["mcp_servers"]["creator-works"]
    entry.update(command=str(router), args=[])
    entry["env"]["CREATOR_WORKS_CONFIG_OWNER"] = "creator-hub-v1"
    require(toml.loads(codex) == expected_client, "Codex semantic fields differ beyond the approved route/owner change")
    require(f'command = "{router}"' in codex and re.search(r"args = \[\s*\]", codex), "Codex not converted to zero-argument router")
    for value in ('# retained foreign preamble', 'model = "keep-model"', '[mcp_servers.unrelated]\ncommand = "/bin/false"',
                  'timeout = 37', 'enabled = false', f'UNITY_PROJECT_PATH = "{home}/retained-project"', 'CUSTOM = "preserve"'):
        require(value in codex, "Unrelated Codex option changed")
    route = home / "data/creator-hub/mcp-route-v1/linux-x86_64"
    receipt = pages.parse((route / "active.json").read_bytes())
    require(receipt == {"schemaVersion": 1, "descriptorSha256": binding["runtimeSha256"], "generation": generation}, "Signed route receipt differs")
    descriptor = route / "descriptors" / receipt["descriptorSha256"]
    require(digest((descriptor / "runtime.json").read_bytes()) == binding["runtimeSha256"], "Retained descriptor differs from producer")
    for name, sha in binding["runtime"]["module"]["files"].items():
        target = home / "data/creator-hub/runtime-generations/linux-x86_64" / generation / name
        require(pages.record(target)["sha256"] == sha, "Retained signed payload differs")
    require(pages.record(router)["sha256"] == binding["routerSha256"], "Retained router differs from producer")
    for name in changes | {"data/CreatorProjectSetup/editor-roots.json"}:
        before = fixtures["before"][name]
        original = home / name
        backup = original.parent / ".creator-hub-settings-backups" / (original.name + "." + before["sha256"] + ".bak")
        retained = pages.record(backup)
        require(retained["sha256"] == before["sha256"] and retained["size"] == before["size"] and retained["mode"] == 0o600, "Exact private before-image missing")
    review = pages.parse((home / "data/CreatorHub/convergence/review-v1.json").read_bytes())
    require(review["policy"] == 1 and review["stores_retained"] is True and review["connections_reviewed"] is True
            and review["standalone_removal_accepted"] is False, "Durable convergence review differs")
    journals = [home / "data/creator-hub/client-migrations-v1", home / "config/creator-works-mcp/.creator-hub-product-settings"]
    completed = []
    for directory in journals:
        children = list(directory.iterdir())
        for child in children:
            require(child.name != "hub.lock" or (child.is_file() and not child.is_symlink()), "Redirected cooperative lock")
        children = [child for child in children if child.name != "hub.lock"]
        require(0 < len(children) <= 8, "Unexpected migration journal inventory")
        for child in children:
            require(re.fullmatch(r"[a-f0-9]{64}", child.name) and child.is_dir() and not child.is_symlink(), "Unknown journal")
            pending = pages.parse((child / "pending.json").read_bytes())
            require(len(pending["files"]) == 1, "Unexpected transaction members")
            entry = pending["files"][0]
            target = Path(entry["path"])
            require(target in (home / pages.CONFIG, home / ".codex/config.toml"), "Foreign journal target")
            completed_journal(pending, pages.parse((child / "completed.json").read_bytes()),
                              (child / "0.before.bin").read_bytes(), (child / "0.after.bin").read_bytes(), target.read_bytes(),
                              {str(home / pages.CONFIG), str(home / ".codex/config.toml")})
            completed.append(str(child))
    return {"router": str(router), "server": str(server), "generation": generation, "completedJournals": completed,
            "config": pages.record(home / pages.CONFIG), "client": pages.record(home / ".codex/config.toml")}


class Session:
    def __init__(self, root, binding, pages, helper, native, report, label):
        self.root, self.binding, self.pages, self.helper, self.native = root, binding, pages, helper, native
        self.report, self.label, self.dialogs = report, label, set()
        self.x11, self.driver = helper.X11(), pages.Driver()
        self.child = subprocess.Popen([binding["driver"]["path"], "--native-driver", "/usr/bin/WebKitWebDriver"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.logs = native.Capture(self.child, root, label + "-driver")
        self.driver_process = native.native_process(self.child.pid, helper)
        pages.wait(lambda: pages.listener(self.child.pid, 4444))
        response = self.driver.request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": HUB, "args": []}}}})
        self.driver.session = response["sessionId"]
        peers = pages.subtree(self.child.pid, helper, native)
        roots = [p for p in peers.values() if p["executable"] == HUB]
        require(len(roots) == 1, "Driver-owned installed Root missing/ambiguous")
        self.owned = native.native_process(roots[0]["pid"], helper)
        require(self.owned["kernelImageSha256"] == binding["hub"]["sha256"], "Root kernel image differs")
        parent = native.native_process(self.owned["parentPid"], helper)
        require(parent["pid"] in peers and parent["executable"] == "/usr/bin/WebKitWebDriver" and parent["parentPid"] == self.child.pid
                and parent["kernelImageSha256"] == pages.record("/usr/bin/WebKitWebDriver")["sha256"], "Native driver ancestry differs")
        self.native_driver = parent
        self.pidfd = os.pidfd_open(self.owned["pid"])
        pages.wait(lambda: len(native.client_ids(self.x11)) == 1)
        self.window = native.client_ids(self.x11)[0]
        self.request = helper.Request("snapshot", self.owned["pid"], self.owned["startTime"], HUB, binding["hub"]["sha256"], self.window, pages.TITLE, "FRAME")
        self.xres = helper.bound_window(self.request, self.x11)
        self.gtk_file = Path("/usr/lib/x86_64-linux-gnu/libgtk-3.so.0").resolve(strict=True)
        gtk = pages.record(self.gtk_file)
        require(gtk["uid"] == gtk["gid"] == 0 and not gtk["mode"] & 0o022, "GTK library is not protected")
        require(native.run_tool(root, label + "-gtk-verify", ["/usr/bin/dpkg", "--verify", "libgtk-3-0"])[1] == b"", "Factory GTK package changed")
        package = native.run_tool(root, label + "-gtk-package", ["/usr/bin/dpkg-query", "-W", "-f=${Version}\t${Architecture}\t${db:Status-Status}", "libgtk-3-0"])[1]
        require(re.fullmatch(rb"3\.24\.33-[^\t\n]+\tamd64\tinstalled", package), "Unreviewed GTK geometry implementation")
        owner = native.run_tool(root, label + "-gtk-owner", ["/usr/bin/dpkg-query", "-S", str(self.gtk_file)])[1]
        require(owner in (("libgtk-3-0:amd64: " + str(self.gtk_file) + "\n").encode(), ("libgtk-3-0: " + str(self.gtk_file) + "\n").encode()), "GTK package owner differs")
        self.gtk = gtk
        self.driver.guard = self.guard
        self.guard()
        report[label] = {"root": self.owned, "driver": self.driver_process, "nativeDriver": parent, "xres": self.xres}

    def process_guard(self):
        require(self.child.poll() is None and self.native.native_process(self.owned["pid"], self.helper) == self.owned, "Installed Root identity changed")
        require(self.native.native_process(self.child.pid, self.helper) == self.driver_process
                and self.pages.listener(self.child.pid, 4444), "Driver identity/listener changed")
        self.pages.subtree(self.child.pid, self.helper, self.native)

    def guard(self):
        self.logs.pump()
        self.process_guard()
        require(self.helper.bound_window(self.request, self.x11) == self.xres, "Main XRes changed")
        windows = self.native.client_ids(self.x11)
        require(self.window in windows and len(windows) <= (2 if self.dialogs else 1), "Unexpected native window")
        for xid in windows:
            if xid != self.window:
                info = self.x11.inspect(xid)
                require(info["pid"] == self.owned["pid"] and info["title"] in self.dialogs and info["mapped"] and info["client"] > 0, "Foreign/unexpected dialog")

    def approve(self, profile):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(1500, 1500)
        title = profile[0]
        self.pages.wait(lambda: any(self.x11.inspect(w)["title"] == title for w in self.native.client_ids(self.x11) if w != self.window), 20)
        self.guard()
        windows = [w for w in self.native.client_ids(self.x11) if w != self.window]
        require(len(windows) == 1, "Exactly one owned GTK confirmation required")
        xid, frame = windows[0], self.x11.frame_rectangle(windows[0])
        require(len(frame) == 4 and all(type(v) is int for v in frame) and frame[2] > 0 and frame[3] > 0, "Native frame unavailable")
        request = self.helper.Request("snapshot", self.owned["pid"], self.owned["startTime"], HUB, self.binding["hub"]["sha256"], xid, title, "ALERT")
        xres = self.helper.bound_window(request, self.x11)
        self.report["lastGtkObservation"] = {"title": title, "native": xres, "frame": frame, "actionCount": 0, "phase": "before-ax-attribution"}
        refs, bus = self.native.native_ax_references()
        # This bounded tree is native GTK in Root only, never a WebKit subtree.
        owner = self.native.RootOwnership(request, self.helper, self.x11, self.owned, xres, self.gtk,
            references=refs, system_check=lambda: self.pages.record(self.gtk_file))
        def capture():
            self.guard(); owner.recheck(full=True)
            apps = [a for a in self.helper.children(Atspi.get_desktop(0), 128) if a.get_process_id() == request.pid]
            require(len(apps) == 1, "Owned GTK AX application ambiguous")
            tops = self.helper.children(apps[0], 8)
            self.report["lastGtkObservation"] = {"title": title, "native": xres, "frame": frame,
                "ownedAxTops": [{"pid": n.get_process_id(), "role": int(n.get_role()), "name": n.get_name()[:256]} for n in tops], "actionCount": 0}
            candidates = [n for n in tops if n.get_role() == Atspi.Role.ALERT and n.get_name() == profile[1]]
            require(len(candidates) == 1, "Source-bound GTK AX alert missing/ambiguous")
            pending, graph, targets = [(candidates[0], None, 0)], [], []
            while pending:
                node, parent, depth = pending.pop()
                require(len(graph) < 64 and depth < 12 and node.get_process_id() == request.pid, "GTK tree escaped bound/Root")
                node.clear_cache(); owner.node(node)
                role = int(node.get_role())
                require(role not in (40, 61, 79), "Unexpected input in confirmation; no contents read")
                require(isinstance(node.get_name(), str) and len(node.get_name()) <= 4096, "GTK text exceeds bound")
                reference = refs.identity(node, owner)
                if parent is not None:
                    require(owner.same_node(node.get_parent(), parent), "GTK parent escaped")
                states = node.get_state_set()
                rectangle = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN) if not graph else None
                graph.append({"ref": reference, "parent": None if parent is None else refs.identity(parent, owner), "pid": node.get_process_id(),
                              "role": role, "name": node.get_name(), "ready": all(states.contains(getattr(Atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE")) and not any(states.contains(getattr(Atspi.StateType, s)) for s in ("DEFUNCT", "BUSY")),
                              "frame": None if rectangle is None else [rectangle.x, rectangle.y, rectangle.width, rectangle.height]})
                if role == 43 and node.get_name() == profile[3]:
                    targets.append(node)
                pending.extend((child, node, depth + 1) for child in reversed(self.helper.children(node, min(16, 64-len(graph)-len(pending)))))
            return graph, targets
        try:
            first, _ = capture()
            self.pages.save(self.root / ("gtk-" + str(len(self.report["approvals"])) + ".json"), {"native": xres, "frame": frame, "graph": first, "actionCount": 0})
            validate_graph(profile, first, request.pid, frame)
            second, targets = capture()
            require(first == second and self.x11.frame_rectangle(xid) == frame, "GTK graph/frame changed")
            validate_graph(profile, second, request.pid, frame)
            require(len(targets) == 1, "Ambiguous approval target")
            action = targets[0].get_action_iface()
            require(action is not None and action.get_n_actions() == 1 and action.get_action_name(0) == "click", "One native click required")
            owner.recheck(full=True)
            require(action.do_action(0), "Approval outcome uncertain; no retry")
            self.report["approvals"].append({"title": title, "button": profile[3], "actionCount": 1, "pid": request.pid, "xid": xid})
            self.pages.wait(lambda: xid not in self.native.client_ids(self.x11))
        finally:
            bus.close_sync(None)

    def migrate_step(self, selector, profiles):
        require(selector in ("#convergence-prepare", "#convergence-connections", "#convergence-retire"), "Unapproved UI control")
        self.guard()
        self.dialogs = {profile[0] for profile in profiles}
        # HTTP worker never touches Xlib; all GTK/XRes checks stay on this thread.
        self.driver.guard = self.process_guard
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as worker:
                future = worker.submit(self.driver.click, selector)
                for profile in profiles:
                    self.approve(profile)
                future.result(timeout=20)
        finally:
            self.driver.guard = self.guard
            self.dialogs = set()
        self.guard()
        require(not self.driver.read("#convergence-error", "text"), "Migration UI reported an error")

    def close(self):
        self.guard()
        self.x11.close_window(self.window, self.helper.bound_window(self.request, self.x11))
        self.pages.wait(lambda: bool(select.select([self.pidfd], [], [], 0.1)[0]), 12)
        self.pages.wait(lambda: not Path(f"/proc/{self.owned['pid']}").exists(), 5)
        self.report[self.label]["normalCloseObserved"] = True
        self.driver.guard = lambda: None
        try:
            self.driver.call("DELETE", "")
        except RuntimeError as error:
            self.report[self.label]["sessionCleanup"] = str(error)[:300]
        # Only the two independently bound fixture drivers may be terminated,
        # after the installed product has already closed normally.
        native_fd = os.pidfd_open(self.native_driver["pid"])
        require(self.native.native_process(self.native_driver["pid"], self.helper) == self.native_driver, "Native driver changed before fixture cleanup")
        self.child.terminate(); self.child.wait(timeout=10)
        if not select.select([native_fd], [], [], 0)[0]:
            signal.pidfd_send_signal(native_fd, signal.SIGTERM)
            self.pages.wait(lambda: bool(select.select([native_fd], [], [], 0.1)[0]), 5)
        os.close(native_fd)
        self.logs.pump(); self.logs.close()
        os.close(self.pidfd); self.x11.dispose()


def run(binding, root, pages, helper, native, report):
    pages.pinned(HUB, binding["hub"], 0, 0o755)
    require(native.run_tool(root, "dpkg-verify", ["/usr/bin/dpkg", "--verify", "creator-hub"])[1] == b"", "Installed DEB differs")
    wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    session = None
    try:
        session = Session(root, binding, pages, helper, native, report, "first")
        d = session.driver
        pages.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
        d.click("#usage-terms-checkbox"); d.click("#usage-terms-continue")
        pages.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
        terms = pages.record(root / "home/data/CreatorHub/consent/hub-usage-terms.json")
        all_profiles = profiles(root / "home", binding["runtime"])
        session.migrate_step("#convergence-prepare", all_profiles[:1])
        session.migrate_step("#convergence-connections", all_profiles[1:4])
        session.migrate_step("#convergence-retire", all_profiles[4:])
        pages.wait(lambda: d.read("#convergence-dialog", "attribute/open") is None)
        report["afterMigration"] = preserved(root, binding, binding["fixtures"], pages)
        session.close(); session = None
        report["afterClose"] = preserved(root, binding, binding["fixtures"], pages)
        session = Session(root, binding, pages, helper, native, report, "reopened")
        require(session.owned["pid"] != report["first"]["root"]["pid"], "Root did not reopen as a new process")
        d = session.driver
        pages.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
        pages.wait(lambda: d.read("#convergence-dialog", "attribute/open") is None)
        d.click("#entry-mcp .app-row")
        pages.wait(lambda: d.read('#feature-mcp [data-field="status"]') == "Ready")
        require(not d.elements("iframe,object,embed"), "Reopened a separate app UI")
        require(pages.record(root / "home/data/CreatorHub/consent/hub-usage-terms.json") == terms, "Terms acknowledgement changed")
        report["afterReopen"] = preserved(root, binding, binding["fixtures"], pages)
        require(report["afterReopen"] == report["afterMigration"] == report["afterClose"], "Migration did not persist")
        session.close(); session = None
        report.update(migrationAccepted=True, normalReopenPersistenceAccepted=True)
    finally:
        if session is not None:
            report["captureOnlyStop"] = True
            report["lastRequest"] = session.driver.last_request
        else:
            subprocess.run(["/usr/bin/openbox", "--exit"], check=True, timeout=10)
            wm.wait(timeout=10)


def main():
    if sys.argv[1:] == ["pins"]:
        print(json.dumps({"source": SOURCE, "helperSource": HELPER_SOURCE, "helpers": HELPERS, "old": OLD}))
        return
    admission(os.environ, sys.platform, platform.machine())
    pages, helper, native = helpers()
    temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    file = temp / "integrated-migration-input.json"
    require(sys.argv[1:] == [str(file)] and pages.record(file)["mode"] == 0o600, "Exact private input binding required")
    binding = pages.parse(file.read_bytes())
    require(binding["sourceCommit"] == SOURCE and binding["schemaVersion"] == 1, "Unexpected installed candidate")
    for name, mode in (("package", 0o600), ("driver", 0o755), ("legacyServer", 0o600), ("node", 0o600)):
        require(Path(binding[name]["path"]).is_relative_to(temp), "Foreign staged input")
        pages.pinned(binding[name]["path"], binding[name], os.getuid(), mode)
    require(binding["legacyServer"]["sha256"] == OLD["serverSha256"] and binding["legacyServer"]["size"] == OLD["serverSize"], "Wrong previous server")
    root = temp / "linux-integrated-migration"
    if os.environ.get("CREATOR_MIGRATION_PRIVATE") != "1":
        root.mkdir(mode=0o700)
        pages.save(root / "fixtures.json", seed(root, binding, pages))
        allowed = ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "CREATOR_INTEGRATED_MIGRATION")
        env = {k: v for k, v in os.environ.items() if k in allowed}
        env.update(PATH="/usr/bin:/bin", LANG="C.UTF-8", LC_ALL="C.UTF-8", HOME=str(root / "home"), XDG_CONFIG_HOME=str(root / "home/config"), XDG_DATA_HOME=str(root / "home/data"), XDG_CACHE_HOME=str(root / "home/cache"), XDG_RUNTIME_DIR=str(root / "runtime"), TMPDIR=str(root / "tmp"), GDK_BACKEND="x11", NO_AT_BRIDGE="0", CREATOR_MIGRATION_PRIVATE="1")
        native.run_tool(root, "private-session", ["/usr/bin/env", *[k + "=" + v for k, v in env.items()], "/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24", "/usr/bin/dbus-run-session", "--", "/usr/bin/python3", "-B", str(Path(__file__).resolve()), str(file)], timeout=300)
        return
    require(all(os.environ.get(k) == str(root / p) for k, p in {"HOME": "home", "XDG_CONFIG_HOME": "home/config", "XDG_DATA_HOME": "home/data", "XDG_RUNTIME_DIR": "runtime"}.items()), "Isolated HOME required")
    binding["fixtures"] = pages.parse((root / "fixtures.json").read_bytes())
    report = {**FALSE_GATES, "migrationAccepted": False, "normalReopenPersistenceAccepted": False, "source": SOURCE, "harness": os.environ["GITHUB_SHA"], "approvals": []}
    try:
        run(binding, root, pages, helper, native, report)
    except Exception as error:
        report["error"] = str(error)[:1000]
        raise
    finally:
        pages.save(root / "report.json", report)


if __name__ == "__main__":
    main()
