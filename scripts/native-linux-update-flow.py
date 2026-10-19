"""Disposable frozen14 -> acceptance-only15 update; never publication authority.

Capture, system Cancel, and one synthetic authentication are separate runs.
Only the product installs/restarts15. No credential files or real homes are read.
Six helpers remain byte-frozen at edece08; native acceptance is still unverified.
"""
import ctypes
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BASE = Path("/opt/creator-polkit-fixture")
BRANCH = "refs/heads/validation/linux-installed-candidate-014"
FROZEN_SOURCE = "edece084a8b5711d5c1c7bc5050b350a0f8286d0"
FROZEN = {
    "native-linux-update-discovery.py": (40990, "bbba7b278831f9840872230d6386f7600bb9f51bb126d4c399f556cf7fe3c754"),
    "native-linux-root-probe.py": (85081, "91983346c5bac811028135b41c11a0dfc10e40a61c9f65aab535df326e354e72"),
    "native-linux-components-probe.py": (133192, "3616d19c6b74ac44da89c48f70620b0c1a5190983507b63a42c5783732d0ef1b"),
    "native-unix-window.py": (46844, "a8aa761c41b26c4cd4a52f4f3c698046ca4cca20e97c08ee5cd41d68afbfb83f"),
    "native-linux-polkit-probe.py": (70368, "bd895ead4a3ed0d118b9395f665c1a0264ad32d17f9bb38ee0797c58e78d4481"),
    "linux-update-lab-feed.cjs": (24216, "7bb0b5a21b6c83a1934775528a4b7c85eafbee3de48b339dc9ac097d7c908051"),
}
UID = 21314
USER = "creator-polkit-fixture"
EXE = "/usr/bin/creator-hub"
FALSE_GATES = {k: False for k in ("publicDiscovery", "systemAuthenticationAccepted", "signedUpdateAccepted",
    "restartAccepted", "normalCloseAfterRestart", "migrationAccepted", "viewsRestored", "flatpakAccepted", "releaseReady")}
MODES = ("capture", "system-cancel", "approve")
# Ubuntu 0.105-33ubuntu0.2 pkexec.c inserts resolved path into $(program).
# The GNOME selector/password contract is the independently pinned helper's
# source_contract, not a captured string or a mutation of its /usr/bin/true profile.
REVIEWED_DPKG_INPUT_PROFILE = {
    "question": "Authentication is needed to run `/usr/bin/dpkg' as the super user",
    "program": "/usr/bin/dpkg",
    "pkexecSourceSha256": "cbb94de97b57d52dab3672a9cf1ed2a3bc073ecebf3d16aea102ca165d26ec5f",
    "ubuntuOrigSha256": "8fdc7cc8ba4750fcce1a4db9daa759c12afebc7901237e1c993c38f08985e1df",
    "ubuntuPatchesSha256": "4811ed40c1c5ed9185c90a309594b293a4fe72760ad0840ef9abf52c29d6a689",
}
_dependencies = None


def require(value, message):
    if not value:
        raise RuntimeError(message)


def exact_json(raw):
    require(type(raw) is bytes and 0 < len(raw) <= 1048576, "Bounded JSON required")
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    def finite(value):
        result = float(value)
        require(math.isfinite(result), "Nonfinite JSON refused")
        return result
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_float=finite,
                      parse_constant=lambda _v: require(False, "Nonfinite JSON refused"))


def mode(env):
    value = env.get("CREATOR_LINUX_UPDATE_FLOW_MODE", "capture")
    require(value in MODES, "Unknown finite update-flow mode")
    return value


def admission(env, system, machine):
    require(system == "linux" and machine == "x86_64", "Native Linux x86_64 only")
    expected = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
        "RUNNER_ARCH": "X64", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
        "GITHUB_REF": BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "CREATOR_LINUX_UPDATE_FLOW": "1",
        "CREATOR_LINUX_ROOT_PROBE": "1", "CREATOR_UNIX_WINDOW_TEST": "1", "CREATOR_LINUX_COMPONENTS_PROBE": "1",
        "CREATOR_LINUX_UPDATE_DISCOVERY": "1", "CREATOR_LINUX_ROOT_CANDIDATE": "retirement-534465a"}
    require(all(env.get(k) == v for k, v in expected.items()), "Exact manual disposable CI context required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", ""))
            and re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ID", "")), "CI source/run binding required")
    require(not any(re.match(r"^(LD_|DYLD_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|TAURI_SIGNING_|CREATOR_HUB_SIGNING_)", k)
                    for k in env) and not any(env.get(k) for k in ("FLATPAK_ID", "APPIMAGE", "APPDIR")), "Injection/foreign package context refused")
    mode(env)


def frozen_directory():
    return HERE / "frozen" if HERE == BASE / "scripts" else HERE.parent / "flow-frozen/scripts"


def verify_frozen(directory):
    directory = Path(directory)
    for name, (length, digest) in FROZEN.items():
        target = directory / name
        require(target.resolve(strict=True) == target and target.is_file() and not target.is_symlink(), "Canonical frozen source required")
        raw = target.read_bytes()
        require(len(raw) == length and hashlib.sha256(raw).hexdigest() == digest, "Frozen dependency differs: " + name)


def dependencies():
    global _dependencies
    if _dependencies is None:
        directory = frozen_directory()
        verify_frozen(directory)
        def load(name, filename):
            spec = importlib.util.spec_from_file_location(name, directory / filename)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            return module
        discovery = load("flow_frozen_discovery", "native-linux-update-discovery.py")
        polkit = load("flow_frozen_polkit", "native-linux-polkit-probe.py")
        components = discovery.components()
        _dependencies = (discovery, components.B, components, polkit)
    return _dependencies


@dataclass(frozen=True)
class Phase14:
    version: str = "0.1.14"
    length: int = 22058224
    digest: str = "3357f024e3caff3e7563e702838b7e15e08bb8effd7915413e25c444d485ea7d"


@dataclass(frozen=True)
class Phase15:
    version: str = "0.1.15"
    length: int = 22048768
    digest: str = "7629379fbd3d0b7db0a996d727aa166750e08165478d622fe0d7c5047f2d50fe"


def phase_identity(phase, record, supervisor):
    require(type(phase) in (Phase14, Phase15) and phase == type(phase)(), "Only fixed complete phase pins admitted")
    require(type(record.get("pid")) is int and record["pid"] > 1 and re.fullmatch(r"[1-9][0-9]*", record.get("startTime", "")), "Kernel process/start identity required")
    require(record["uids"] == [UID] * 4 and record["parentPid"] == supervisor and record["executable"] == EXE
            and record["kernelImageSha256"] == phase.digest and int(record["image"]["st_size"]) == phase.length,
            "Exact owned phase kernel image/UID/parent required")
    return record


def enable_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    require(libc.prctl(36, 1, 0, 0, 0) == 0, "PR_SET_CHILD_SUBREAPER refused")
    value = ctypes.c_int(0)
    require(libc.prctl(37, ctypes.addressof(value), 0, 0, 0) == 0 and value.value == 1, "Subreaper readback refused")
    require(signal.getsignal(signal.SIGCHLD) != signal.SIG_IGN, "Owned child exit status must remain waitable")


def direct_children(pid):
    result = set()
    tasks = Path(f"/proc/{pid}/task")
    tids = list(tasks.iterdir())
    require(0 < len(tids) <= 256, "Supervisor task inventory exceeds bound")
    for task in tids:
        try:
            raw = (task / "children").read_bytes()
        except FileNotFoundError:
            continue
        require(len(raw) <= 16384 and re.fullmatch(rb"[0-9 ]*", raw), "Bounded kernel child inventory required")
        result.update(int(v) for v in raw.split())
        require(len(result) <= 256, "Owned descendant inventory exceeds bound")
    return result


def successor_identity(record, old, supervisor, baseline):
    phase_identity(Phase15(), record, supervisor)
    require(record["pid"] != old["pid"] and record["pid"] not in baseline
            and int(record["startTime"]) > int(old["startTime"]), "Replacement must be a fresh adopted child, not baseline/PID reuse")
    return record


def single_instance_owner(bus, polkit, glib, record):
    # Frozen534465a uses single-instance2.4.4 without its optional semver feature.
    identity = polkit.bus_identity(bus, "com.creatorworks.hub.SingleInstance", glib)
    require(identity["pid"] == record["pid"] and identity["uid"] == UID, "Phase Root does not own the actual single-instance session-bus name")
    return identity


def observed_package_state(root, b, label):
    _code, output = b.run_tool(root, label, ["/usr/bin/dpkg-query", "-W", "-f=" + b.STATE_FORMAT, "creator-hub"])
    require(type(output) is bytes and 0 < len(output) <= 256, "Bounded package-state observation required")
    return output.decode("ascii")


def installed15(root, b):
    """Read-only phase15 prerequisite, never an installation or acceptance flag."""
    state = observed_package_state(root, b, "installed15-state")
    require(state == "creator-hub\t0.1.15\tamd64\tinstalled\n", "Actual installed15 package state required")
    protected(Path(EXE))
    image = b.pinned(Path(EXE), (Phase15().length, Phase15().digest), 0o755)
    _code, output = b.run_tool(root, "installed15-verify", ["/usr/bin/dpkg", "--verify", "creator-hub"])
    require(output == b"", "Installed15 dpkg verification differs")
    return {"packageState": state, "image": image, "dpkgVerifyPassed": True, **FALSE_GATES}


def restart_candidate_diagnostic(pid):
    require(type(pid) is int and pid > 1, "Exact candidate PID required")
    try:
        return {"pid": pid, "kernelStat": proc_bytes(Path(f"/proc/{pid}/stat"), 4096).decode("utf-8", "replace")}
    except (OSError, RuntimeError):
        return {"pid": pid, "kernelStatUnavailable": True}


def capture_old_children(old, b, helper):
    records = {}
    for pid in sorted(direct_children(old["pid"])):
        try:
            if b.process_uids(pid) != old["uids"]:
                continue
            value = b.native_process(pid, helper)
        except (FileNotFoundError, ProcessLookupError):
            continue
        require(value["pid"] == pid and value["parentPid"] == old["pid"] and value["uids"] == old["uids"]
                and int(value["startTime"]) >= int(old["startTime"]) and value["executable"] != EXE
                and re.fullmatch(r"[a-f0-9]{64}", value.get("kernelImageSha256", "")), "Exact old non-Hub child identity required")
        records[pid] = value
    require(b.native_process(old["pid"], helper) == old, "Old Root changed during child inventory")
    return records


def recorded_old_zombie(pid, records, old, b, helper):
    value = records.get(pid)
    if value is None:
        return None
    require(value["pid"] == pid and value["parentPid"] == old["pid"] and value["uids"] == old["uids"]
            and value["executable"] != EXE and re.fullmatch(r"[a-f0-9]{64}", value.get("kernelImageSha256", "")),
            "Only measured old non-Hub children may be classified")
    def snapshot():
        raw = helper.Proc().stat(pid)
        require(raw.startswith(str(pid) + " (") and len(raw) <= 4096, "Exact bounded child kernel record required")
        fields = raw[raw.rfind(")") + 2:].split()
        require(len(fields) >= 20, "Incomplete child kernel record")
        return fields[0], fields[1], fields[19], b.process_uids(pid)
    first = snapshot()
    if first[0] != "Z":
        return None
    require(first == ("Z", str(os.getpid()), value["startTime"], old["uids"]) and snapshot() == first,
            "Old zombie PID/start/parent/UID changed; no skip")
    return {"pid": pid, "startTime": value["startTime"], "previousParentPid": old["pid"],
            "parentPid": os.getpid(), "executableBeforeUpdate": value["executable"],
            "kernelImageSha256BeforeUpdate": value["kernelImageSha256"], "state": "Z", "reaped": False}


def wait_successor(old_child, old, baseline, b, helper, capture, timeout=35, observation=None, old_children=None):
    """Observe only; never spawn a replacement or signal any Root/renderer."""
    deadline, replacement, old_zombies = time.monotonic() + timeout, None, set()
    while time.monotonic() < deadline:
        capture.pump(0.02)
        # Popen alone reaps old14. Do not waitpid(-1), consume agents or renderers.
        if old_child.poll() is None:
            continue
        require(old_child.returncode == 0, "Old Root did not exit normally for automatic restart")
        for pid in sorted(direct_children(os.getpid()) - baseline - {old["pid"]}):
            try:
                zombie = recorded_old_zombie(pid, old_children or {}, old, b, helper)
                if zombie is not None:
                    if observation is not None and pid not in old_zombies:
                        observation.setdefault("measuredOldZombies", []).append(zombie)
                    old_zombies.add(pid)
                    continue
                record = b.native_process(pid, helper)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except Exception:
                if observation is not None:
                    observation["candidateRefusal"] = restart_candidate_diagnostic(pid)
                raise
            if record["executable"] != EXE:
                continue
            successor_identity(record, old, os.getpid(), baseline)
            require(replacement is None or replacement == record, "Multiple or changing automatic replacements")
            replacement = record
        if replacement is not None:
            require(b.native_process(replacement["pid"], helper) == replacement, "Replacement changed before admission")
            return replacement
    raise RuntimeError("Automatic successor deadline; no manual relaunch, retry or restart acceptance")


def finish_successor(record, request, owner, b, helper, atspi, capture):
    """Phase15 caller must first bind its fresh XRes/renderer/AX, never old14 files."""
    phase_identity(Phase15(), record, os.getpid())
    require(owner.root == record and request.pid == record["pid"] and request.sha256 == Phase15().digest,
            "Fresh phase15 ownership required")
    action = b.perform_owned("close", request, helper, atspi, owner)
    end = time.monotonic() + 12
    while time.monotonic() < end:
        capture.pump(0.02)
        pid, status = os.waitpid(record["pid"], os.WNOHANG)
        if pid:
            require(pid == record["pid"] and os.waitstatus_to_exitcode(status) == 0, "Adopted Root did not close normally")
            return {"close": action, "reapedPid": pid, "exitCode": 0}
    raise RuntimeError("Owned phase15 normal-close deadline; no force-close")


def confirmation_approve(root, request, helper, x11, atspi, saved, b, c):
    """Separate exact source-bound Update Hub action; do not alter frozen Cancel."""
    contract = b.unique_json(b.bounded_read(root / "updater-confirmation-contract.json", 32768))
    native, frame = contract["native"], tuple(contract["nativeFrame"])
    require(contract["root"] == saved["root"] and contract["actionCount"] == 0 and native["pid"] == request.pid
            and native["title"] == "Update Creator Hub" and native["window"] != request.window, "Original confirmation capture required")
    require(len(frame) == 4 and all(type(v) is int for v in frame) and 0 <= frame[0] <= 1920 and 0 <= frame[1] <= 1080
            and 0 < frame[2] <= 1920 and 0 < frame[3] <= 1080, "Native confirmation frame exceeds bound")
    dialog = helper.Request("snapshot", request.pid, request.start, request.executable, request.sha256,
        native["window"], "Update Creator Hub", "ALERT", gtk_message_info_frame=frame)
    require(helper.bound_window(dialog, x11) == contract["xres"], "Confirmation XRes changed")
    refs_saved = b.unique_json(b.bounded_read(root / "ax-ownership.json", 8192))
    refs, bus = b.native_ax_references(refs_saved)
    question = "Update Creator Hub to 0.1.15?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."
    try:
        owner = b.RootOwnership(dialog, helper, x11, saved["root"], contract["xres"], saved["systemWebKit"]["file"], references=refs)
        def walk():
            owner.recheck(full=True)
            require([w for w in c.owned_windows(request.pid, x11) if w["mapped"] and w["window"] != request.window] == [native], "Additional/changed Root dialog")
            window = helper.select_window(dialog, atspi)
            pending, nodes, edges, seen = [(window, None, 0)], [], [], set()
            while pending:
                node, parent, depth = pending.pop()
                require(node is not None and len(nodes) < 64 and depth < 16, "Confirmation graph exceeds bound")
                node.clear_cache()
                require(node.get_process_id() == request.pid, "Foreign confirmation node")
                owner.node(node)
                reference = tuple(refs.identity(node, owner))
                require(reference not in seen, "Duplicate confirmation reference")
                seen.add(reference)
                if parent is not None:
                    require(node.get_role() not in (atspi.Role.FRAME, atspi.Role.WINDOW, atspi.Role.DIALOG, atspi.Role.ALERT, atspi.Role.APPLICATION)
                            and owner.same_node(node.get_parent(), parent), "Confirmation parent/window escaped")
                name = node.get_name()
                require(type(name) is str and len(name) <= 512, "Confirmation text exceeds bound")
                edges.append((reference, None if parent is None else tuple(refs.identity(parent, owner)), int(node.get_role()), name))
                nodes.append(node)
                pending.extend((v, node, depth + 1) for v in reversed(helper.children(node, min(32, 64-len(nodes)-len(pending)-1))))
            for text in ("Update Creator Hub", question):
                labels = [n for n in nodes if n.get_role() == atspi.Role.LABEL and n.get_name() == text]
                require(len(labels) == 1, "Exact title/question required")
                helper.ready(labels[0], atspi)
            buttons = [n for n in nodes if n.get_role() == atspi.Role.PUSH_BUTTON]
            require(len(buttons) == 2 and {n.get_name() for n in buttons} == {"Update Hub", "Not now"}, "Exact two confirmation buttons required")
            target = next(n for n in buttons if n.get_name() == "Update Hub")
            helper.ready(target, atspi)
            interface = target.get_action_iface()
            require(interface is not None and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click", "Exact GTK confirmation click required")
            require(owner.same_node(helper.select_window(dialog, atspi), window), "Confirmation frame changed")
            owner.recheck(full=True)
            return edges, target, interface
        first, before, _interface = walk()
        second, target, interface = walk()
        require(first == second and owner.same_node(before, target), "Confirmation changed between complete walks")
        try:
            require(interface.do_action(0), "Confirmation result refused/uncertain; no retry")
        except Exception as error:
            raise helper.ActionError("Confirmation result uncertain; no retry") from error
        return {"confirmationAccepted": True, "actionCount": 1, "button": "Update Hub", "axToXidAssociationVerified": True}
    finally:
        bus.close_sync(None)


def dpkg_profile(agent, helper, atspi, refs, x11, native, geometry, p, *, authenticate):
    """Separate source-bound profile. Never inspect password name/text/count."""
    require(len(native) == 1 and native[0]["pid"] == agent["pid"] and native[0]["client"] > 0
            and native[0]["mapped"] and native[0]["title"] == "Authenticate", "Single owned authentication dialog required")
    require(p.windows(agent["pid"], helper, x11) == native, "Authentication window changed")
    frame = x11.frame_rectangle(native[0]["window"])
    geometry.update(nativeFrame=None if frame is None else list(frame), axFrame=None)
    require(type(frame) is tuple and len(frame) == 4 and all(type(v) is int for v in frame)
            and all(0 <= v <= 8192 for v in frame[:2]) and all(0 < v <= 8192 for v in frame[2:]), "Bounded authentication frame required")
    owner = type("Owner", (), {"root": agent, "renderer": None})()
    refs.recheck()
    apps = [a for a in helper.fresh_close_children(atspi.get_desktop(0), 64) if a.get_process_id() == agent["pid"]]
    require(len(apps) == 1, "One owned agent application required")
    app = apps[0]
    app.clear_cache()
    require(app.get_role() == atspi.Role.APPLICATION and app.get_name() == "polkit-gnome-authentication-agent-1", "Exact GTK agent required")
    root_ref = tuple(refs.identity(app, owner))
    tops = helper.fresh_close_children(app, 16)
    require(len(tops) == 1, "One authentication top-level required")
    dialog = tops[0]
    graph, nodes, seen, pending = [], [], set(), [(dialog, root_ref, 0)]
    window_roles = {getattr(atspi.Role, k, -1) for k in ("APPLICATION", "DIALOG", "ALERT", "FRAME", "WINDOW")}
    while pending:
        node, parent, depth = pending.pop()
        require(node is not None and len(graph) < 64 and depth < 16, "Authentication graph exceeds bound")
        node.clear_cache()
        require(node.get_process_id() == agent["pid"], "Foreign authentication PID")
        ref = tuple(refs.identity(node, owner))
        require(ref[0] == root_ref[0] and ref not in seen, "Foreign/duplicate authentication reference")
        seen.add(ref)
        actual_parent = node.get_parent()
        require(actual_parent is not None and tuple(refs.identity(actual_parent, owner)) == parent, "Authentication reverse parent differs")
        role, states = node.get_role(), node.get_state_set()
        password = role == atspi.Role.PASSWORD_TEXT
        protected_ref = geometry.get("passwordReference")
        require(list(ref) != protected_ref or password, "Password role changed; no name/text read")
        if password:
            require(protected_ref is None or list(ref) == protected_ref, "Password reference changed")
            geometry["passwordReference"] = list(ref)
        require(password or not states.contains(atspi.StateType.EDITABLE), "Unexpected editable authentication node")
        name = None if password else node.get_name()
        require(name is None if password else type(name) is str and len(name) <= 1024, "Authentication name exceeds bound")
        require((role == atspi.Role.DIALOG and name == "Authenticate") if depth == 0 else role not in window_roles,
                "Nested/foreign authentication window")
        row = {"reference": list(ref), "parent": list(parent), "role": int(role), "name": name,
            **{s.lower(): states.contains(getattr(atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}}
        graph.append(row)
        nodes.append(node)
        pending.extend((child, ref, depth + 1) for child in reversed(helper.fresh_close_children(node, min(32, 64-len(graph)-len(pending)))))
    labels = [n for n, row in zip(nodes, graph) if row["role"] == int(atspi.Role.LABEL) and row["name"] == REVIEWED_DPKG_INPUT_PROFILE["question"]]
    passwords = [n for n, row in zip(nodes, graph) if row["role"] == int(atspi.Role.PASSWORD_TEXT)]
    buttons = [(n, row) for n, row in zip(nodes, graph) if row["role"] == int(atspi.Role.PUSH_BUTTON)]
    require(len(labels) == len(passwords) == 1 and len(buttons) == 2 and {r["name"] for _n, r in buttons} == {"Cancel", "Authenticate"},
            "Exact dpkg question/buttons/password required")
    extras, selected = [], None
    if authenticate:
        combos = [(n, r) for n, r in zip(nodes, graph) if r["role"] == int(atspi.Role.COMBO_BOX)]
        prompts = [(n, r) for n, r in zip(nodes, graph) if r["role"] == int(atspi.Role.LABEL) and r["name"] == "Password:"]
        items = [(n, r) for n, r in zip(nodes, graph) if r["role"] == int(atspi.Role.MENU_ITEM)]
        require(len(combos) == len(prompts) == 1 and combos[0][1]["name"] == USER and len(items) == 3
                and {r["name"] for _n, r in items} == {"Select user...", "Ubuntu (packer)", USER}, "Exact synthetic administrator selector required")
        combo = combos[0][0]
        selection = combo.get_selection_iface()
        require(selection is not None and selection.get_n_selected_children() == 1, "One selected identity required")
        current = selection.get_selected_child(0)
        require(current is not None, "Selected identity unavailable")
        current.clear_cache()
        candidate, selected = next((n, r) for n, r in items if r["name"] == USER)
        require(current.get_process_id() == agent["pid"] and current.get_role() == atspi.Role.MENU_ITEM and current.get_name() == USER
                and tuple(refs.identity(current, owner)) == tuple(selected["reference"]) == tuple(refs.identity(candidate, owner))
                and tuple(refs.identity(current.get_parent(), owner)) == tuple(selected["parent"]), "Foreign selected identity refused")
        require(passwords[0].get_state_set().contains(atspi.StateType.EDITABLE), "Editable synthetic password entry required")
        extras = [*combos, *prompts, (passwords[0], {"name": "password-entry"})]
    for node in [dialog, *labels, *passwords, *(n for n, _r in buttons), *(n for n, _r in extras)]:
        helper.ready(node, atspi)
    def bounds(node):
        component = node.get_component_iface()
        require(component is not None, "Authentication Component unavailable")
        rect = component.get_extents(atspi.CoordType.SCREEN)
        value = (rect.x, rect.y, rect.width, rect.height)
        require(all(type(v) is int for v in value), "Integer authentication bounds required")
        return value
    actual = bounds(dialog)
    geometry["axFrame"] = list(actual)
    require(actual == frame, "Authentication AX/native frame differs")
    controls = {}
    for node, row in [*buttons, *extras]:
        x, y, w, h = bounds(node)
        require(w > 0 and h > 0 and x >= frame[0] and y >= frame[1]
                and x+w <= frame[0]+frame[2] and y+h <= frame[1]+frame[3], "Authentication control outside frame")
        controls[row["name"]] = [x, y, w, h]
    refs.recheck()
    require(p.windows(agent["pid"], helper, x11) == native and x11.frame_rectangle(native[0]["window"]) == frame, "Authentication native identity changed")
    receipt = {"graph": graph, "native": native, "frame": list(frame), "controls": controls, "application": list(root_ref),
        "axToXidAssociationVerified": True, "passwordRead": False, "program": "/usr/bin/dpkg"}
    if authenticate:
        receipt.update(selectedIdentity=USER, selectedIdentityVerified=True, selectedReference=selected["reference"])
        return (passwords[0], next(n for n, r in buttons if r["name"] == "Authenticate")), receipt
    return next(n for n, r in buttons if r["name"] == "Cancel"), receipt


def wipe(value):
    if value is not None:
        value[:] = b"\0" * len(value)


def read_secret(env):
    require(mode(env) == "approve" and os.getuid() == os.geteuid() == UID, "Only synthetic approval consumes stdin")
    info = os.fstat(0)
    require(stat.S_ISFIFO(info.st_mode) and info.st_uid == 0, "Root-owned anonymous stdin pipe required")
    value = bytearray()
    try:
        while len(value) <= 65:
            part = os.read(0, 66-len(value))
            if not part:
                break
            value.extend(part)
        require(re.fullmatch(b"[0-9a-f]{64}\n", value), "Fixed synthetic stdin frame required")
        return bytearray(value[:-1])
    except Exception:
        raise RuntimeError("Synthetic stdin refused") from None
    finally:
        wipe(value)
        os.close(0)


def refreshed_dpkg(root, b, proof, count, pump):
    """One root-observer response per guard, never authority from an old file."""
    count[0] += 1
    index = count[0]
    require(1 <= index <= 5, "Finite authorization guard budget exhausted")
    b.write_new(root / f"dpkg-input-{index}.json", json.dumps({"index": index}).encode())
    response = BASE / f"dpkg-input-{index}.json"
    end = time.monotonic() + 8
    while time.monotonic() < end:
        pump()
        if response.exists():
            protected(response)
            raw = response.read_bytes()
            if raw:
                current = exact_json(raw)
                require(current == {"index": index, "proof": proof}, "Fresh root DPKG/package identity differs")
                return
        time.sleep(0.02)
    raise RuntimeError("Fresh root DPKG proof deadline; no input/retry")


SENTINELS = {
    "home/data/CreatorHub/preferences/hub-preferences.json": b'{"schemaVersion":1,"preview":false,"autoDownload":false,"restoreHostedViews":true}\n',
    "home/config/Claude/claude_desktop_config.json": b'{"mcpServers":{"unrelated-fixture":{"command":"do-not-execute"}}}\n',
    "home/.codex/config.toml": b'[mcp_servers.unrelated_fixture]\ncommand = "do-not-execute"\n',
    "fixture-project/Assets/preserve.txt": b"owned project sentinel; never open Unity\n",
    "fixture-project/ProjectSettings/ProjectVersion.txt": b"m_EditorVersion: 6000.3.21f1\n",
}


def preservation(root, b):
    names = (*SENTINELS, "home/config/creator-works-mcp/launcher-config.json", "fixture-server.mjs",
        "home/data/CreatorProjectSetup/editor-roots.json", "home/data/CreatorHub/consent/hub-usage-terms.json")
    return {name: b.file_record(root / name, 131072) for name in names}


def seed(root, b, c):
    fixture = c.fixture(root)
    for name, data in SENTINELS.items():
        target = root / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        b.write_new(target, data)
    config = root / "home/config/creator-works-mcp/launcher-config.json"
    value = exact_json(b.bounded_read(config, 131072))
    require(value["channels"] == [] and value["active_channel_id"] is None and value["auto_start"] is False, "Fresh empty fixture config required")
    value.update(channels=[{"id": "update-flow-project", "name": "Update flow project", "unity_project_path": str(root / "fixture-project"),
                           "scene_path": None, "enabled": True}], active_channel_id="update-flow-project")
    # Only c.fixture's just-created private synthetic file, before any app launch.
    config.write_bytes(json.dumps(value).encode())
    return fixture


def selected_project(root, b):
    value = exact_json(b.bounded_read(root / "home/config/creator-works-mcp/launcher-config.json", 131072))
    require(value["active_channel_id"] == "update-flow-project" and len(value["channels"]) == 1
            and value["channels"][0] == {"id": "update-flow-project", "name": "Update flow project", "unity_project_path": str(root / "fixture-project"),
                "scene_path": None, "enabled": True} and value["auto_start"] is False, "Selected project/settings changed")
    return {"activeChannel": "update-flow-project", "path": str(root / "fixture-project"), "autoStart": False}


RUNTIME_CODE = "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000);"


def runtime_identity(process, expected, b, helper):
    require(process.poll() is None and b.native_process(process.pid, helper) == expected
            and expected["parentPid"] == os.getpid() and expected["uids"] == [UID]*4, "Unrelated synthetic runtime changed/exited")
    return {"pid": expected["pid"], "startTime": expected["startTime"], "kernelImageSha256": expected["kernelImageSha256"],
            "survived": True, "scope": "synthetic-unrelated-node-not-real-AI-client"}


def successor_ui(record, old_xid, b, c, p, helper, x11, atspi, bus, glib, capture, system_file):
    """New process, new XID, new AX bus aliases/renderer. Never old14 workers."""
    refs, axbus = b.native_ax_references()
    try:
        end, owner, request = time.monotonic()+25, None, None
        while time.monotonic() < end:
            capture.pump(0.02)
            require(b.native_process(record["pid"], helper) == record, "Phase15 changed during UI readiness")
            present = p.dbus_call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "NameHasOwner", "(s)", ("com.creatorworks.hub.SingleInstance",), "(b)", glib)[0]
            if not present:
                continue
            single_instance_owner(bus, p, glib, record)
            windows = [w for w in c.owned_windows(record["pid"], x11) if w["mapped"]]
            require(len(windows) <= 1, "Ambiguous phase15 windows")
            if not windows:
                continue
            native = windows[0]
            require(native["window"] != old_xid and native["title"] == b.TITLE, "Fresh phase15 main window required")
            if owner is None:
                request = helper.Request("snapshot", record["pid"], record["startTime"], EXE, Phase15().digest, native["window"], b.TITLE, "FRAME")
                owner = b.RootOwnership(request, helper, x11, record, helper.bound_window(request, x11), system_file, references=refs)
            require(native["window"] == request.window, "Phase15 window replacement refused")
            apps = [a for a in helper.children(atspi.get_desktop(0), 128) if a.get_process_id() == record["pid"]]
            require(len(apps) <= 1, "Ambiguous phase15 AX applications")
            frames = [] if not apps else [n for n in helper.children(apps[0], 32) if n.get_role() == atspi.Role.FRAME and n.get_name() == b.TITLE]
            require(len(frames) <= 1, "Ambiguous phase15 AX frames")
            if not frames:
                continue
            state = frames[0].get_state_set()
            if not all(state.contains(getattr(atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE")) or any(
                    state.contains(getattr(atspi.StateType, s)) for s in ("DEFUNCT", "BUSY")):
                continue
            snapshot = b.snapshot_owned(request, helper, atspi, owner)
            if not any(n["name"] == "0.1.15" and n["showing"] for n in snapshot["nodes"]):
                continue
            require(owner.renderer is not None, "Fresh independently bound WebKit producer required")
            owner.recheck(full=True)
            return request, owner, axbus, snapshot
        raise RuntimeError("Fresh phase15 UI/version deadline; no manual relaunch or outcome adoption")
    except Exception:
        axbus.close_sync(None)
        raise


def wait_dismissal(p, helper, x11, native, capture, guard):
    end, observation = time.monotonic()+15, {}
    while time.monotonic() < end:
        capture.pump(0.02)
        guard()
        p.native_window_absence(x11, helper, native[0]["window"], observation)
        if observation.get("complete") and observation.get("absent"):
            require(not p.windows(native[0]["pid"], helper, x11), "Authentication dialog remains/reappeared; no retry")
            return observation
    raise RuntimeError("Authentication dismissal deadline; no retry/force-close")


def approval_complete(report):
    require(report["mode"] == "approve" and report["systemInput"]["passwordWriteAttempts"] == 1
            and report["systemInput"]["authenticateActionAttempts"] == 1
            and report["systemInput"].get("authenticateActionReturned") is True
            and report.get("installed15", {}).get("dpkgVerifyPassed") is True
            and report.get("automaticRestartObserved") is True and report.get("fresh15UiVerified") is True
            and report.get("settingsPreserved") is True and report.get("selectedProjectPreserved") is True
            and report.get("unrelatedRuntime", {}).get("survived") is True
            and report.get("normalClose15", {}).get("exitCode") == 0, "Incomplete native approval; no scoped acceptance")
    report["scopedFlowPassed"] = True
    report["scopedAcceptance"] = {"systemAuthentication": True, "signed15Installation": True,
        "automaticRestart": True, "normalClose": True, "settingsAndSelectedProject": True,
        "unrelatedSyntheticRuntime": True}


def perform_system_input(selected_mode, p, profile, guard, record, secret):
    require(selected_mode in ("system-cancel", "approve"), "Capture never authorizes system input")
    require(not record, "System input already attempted; no retry or outcome adoption")
    record.update(mode="authenticate" if selected_mode == "approve" else "cancel", outcome="unknown-no-retry",
                  passwordWriteAttempts=0, authenticateActionAttempts=0, cancelActionAttempts=0)
    if selected_mode == "approve":
        p.authenticate_once(profile, guard, record, secret)
    else:
        require(secret is None, "Cancel must never receive a credential")
        p.cancel_once(profile, guard, record)


def component_worker_environment(environment):
    return environment | {"CREATOR_LINUX_COMPONENTS_PROBE": "1"}


def native_capture(root, env):
    d, b, c, p = dependencies()
    selected_mode = mode(env)
    require(os.getuid() == os.geteuid() == UID, "Only fixed synthetic user admitted")
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, Gio, GLib
    Atspi.set_timeout(1500, 1500)
    report = {"scope": "disposable-frozen14-acceptance-only15-" + selected_mode, "mode": selected_mode, "phase": "verify",
        "testSource": env["GITHUB_SHA"], "frozenSource": FROZEN_SOURCE, "productSource": b.SOURCE,
        "workers": [], "confirmationAccepted": False, "dpkgAuthorizationCaptured": False,
        "scopedFlowPassed": False, "systemInput": {}, **FALSE_GATES}
    child = root_output = agent = feed = feed_output = x11 = axbus = secret = runtime = successor_bus = None
    failure = None
    lab = root.parent / "creator-linux-update-lab"
    try:
        if selected_mode == "approve":
            secret = read_secret(env)
        report["package"] = b.verify_stage(root, full=True)
        report["systemWebKit"] = b.system_webkit_provenance(root)
        report["systemFiles"] = p.verify_files(root)
        for name in ("home", "home/config", "home/data", "home/cache", "tmp"):
            (root / name).mkdir(mode=0o700)
        report["seed"] = seed(root, b, c)
        enable_subreaper()
        helper = b.load_helper()
        system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        report["session"] = p.session(system, os.getpid(), GLib)
        report["supervisor"] = parent = b.native_process(os.getpid(), helper)
        environment = b.child_env(env, root)
        environment.update(LANG="C", LC_ALL="C")
        agent = subprocess.Popen([p.AGENT], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        report["agent"] = agent_identity = b.native_process(agent.pid, helper)
        p.own_agent(agent, agent_identity, parent, helper)
        agent_session = p.session(system, agent.pid, GLib)
        require(all(agent_session[k] == report["session"][k] for k in ("object", "Id", "User", "Leader")), "Agent session differs")
        end, endpoint = time.monotonic() + 15, None
        while time.monotonic() < end:
            p.own_agent(agent, agent_identity, parent, helper)
            endpoint = p.agent_bus_identity(system, agent_identity, GLib)
            if endpoint is not None:
                break
            time.sleep(0.05)
        require(endpoint is not None, "Owned agent bus deadline")
        x11 = helper.X11()
        require(not p.windows(agent.pid, helper, x11), "Unexpected pre-existing authentication window")
        feed, feed_output, proxy, report["nodeImage"] = d.start_feed(root, lab, env, lab / "ephemeral-tls/private.pem", lab / "ephemeral-tls/public.crt")
        environment = d.child_environment(env, root, proxy) | {"LANG": "C", "LC_ALL": "C"}
        runtime = subprocess.Popen([env["CREATOR_DISCOVERY_NODE"], "-e", RUNTIME_CODE], env=b.child_env(env, root), cwd=root,
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        runtime_record = b.native_process(runtime.pid, helper)
        require(runtime_record["executable"] == env["CREATOR_DISCOVERY_NODE"]
                and runtime_record["kernelImageSha256"] == report["nodeImage"]["sha256"], "Synthetic runtime must use measured feed Node image")
        report["unrelatedRuntimeBefore"] = runtime_identity(runtime, runtime_record, b, helper)
        report["phase"] = "launch14"
        baseline = direct_children(os.getpid())
        child = subprocess.Popen([EXE], env=environment, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        root_output = b.Capture(child, root, "root")
        start = b.check_process(child, None, Path(EXE), helper)
        identity = phase_identity(Phase14(), b.native_process(child.pid, helper), os.getpid())
        session_bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            root_output.pump(0.02)
            require(child.poll() is None, "Root exited before single-instance bus readiness")
            present = p.dbus_call(session_bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "NameHasOwner", "(s)", ("com.creatorworks.hub.SingleInstance",), "(b)", GLib)[0]
            if present:
                report["singleInstance14"] = single_instance_owner(session_bus, p, GLib, identity)
                break
        require("singleInstance14" in report, "Root single-instance name readiness deadline")
        found = b.run_worker(root, environment, "discover", child.pid, start, 1, root_output, report["workers"])
        xid = found["window"]
        saved = {"root": identity, "window": xid, "xres": found["properties"], "systemWebKit": report["systemWebKit"]}
        b.save_json(root / "root-ownership.json", saved)
        report["root14"] = identity
        report["baselineOwnedChildren"] = sorted(baseline)
        b.run_worker(root, environment, "snapshot", child.pid, start, xid, root_output, report["workers"])
        b.accept_terms(root, environment, child, start, xid, root_output, report)
        component_environment = component_worker_environment(environment)
        navigation = c.call(root, component_environment, "navigation", child, start, xid, root_output, report)
        if "Move to unified Creator Hub" in c.shown_names(navigation):
            c.call(root, component_environment, "skip-migration", child, start, xid, root_output, report)
        report["migrationSkipped"] = True
        before = preservation(root, b)
        selection_before = selected_project(root, b)
        report["sentinelsBefore"] = before
        for action in ("check-updates", "ready", "open-confirmation", "capture-confirmation"):
            report["phase"] = action
            report[action] = d.call(root, environment, action, child, start, xid, root_output, report)
        request = helper.Request("snapshot", child.pid, start, EXE, Phase14().digest, xid, b.TITLE, "FRAME")
        report["phase"] = "approve-root-confirmation"
        report["confirmation"] = confirmation_approve(root, request, helper, x11, Atspi, saved, b, c)
        report["confirmationAccepted"] = True
        refs, axbus = b.native_ax_references()
        end = time.monotonic() + 30
        report["phase"] = "capture-owned-agent"
        while time.monotonic() < end:
            root_output.pump(0.02)
            current_root = b.native_process(child.pid, helper, full=False)
            require(child.poll() is None and all(identity.get(k) == v for k, v in current_root.items()), "Root14 changed before DPKG capture")
            p.own_agent(agent, agent_identity, parent, helper)
            require(p.agent_bus_identity(system, agent_identity, GLib) == endpoint, "Agent authority/bus binding changed")
            for pid in (os.getpid(), agent.pid, child.pid):
                current = p.session(system, pid, GLib)
                require(all(current[k] == report["session"][k] for k in ("object", "Id", "User", "Leader")), "Root/agent/session mismatch")
            native = p.windows(agent.pid, helper, x11)
            require(len(native) <= 1, "Ambiguous authentication windows")
            if not native:
                continue
            observed = p.raw_ax(agent_identity, helper, Atspi, refs)
            if observed is None:
                continue
            proof_path = BASE / "dpkg-request-proof.json"
            if not proof_path.exists():
                continue
            protected(proof_path)
            try:
                raw_proof = proof_path.read_bytes()
                if not raw_proof:
                    continue
                proof = exact_json(raw_proof)
            except (json.JSONDecodeError, PermissionError):
                continue
            require(proof["root14"] == identity and proof["program"] == "/usr/bin/dpkg" and proof["seals"] == 15,
                    "Root-owned fixed DPKG observation differs")
            require(native == p.windows(agent.pid, helper, x11), "Native agent window changed during capture")
            capture = {"native": native, "frame": x11.frame_rectangle(native[0]["window"]), "ax": observed,
                "agent": agent_identity, "systemBusAgent": endpoint, "root14": identity,
                "kernelDpkgRequest": proof,
                "readOnly": True, "authorization": False, "actionCount": 0, **FALSE_GATES}
            b.save_json(root / "original-dpkg-authorization.json", capture)
            report["dpkgAuthorizationCaptured"] = True
            report["capturedQuestionProvenAsDpkg"] = False
            report["pendingRootDpkgRequestVerified"] = True
            report["phase"] = "stopped-before-dpkg-password-or-cancel-input"
            break
        require(report["dpkgAuthorizationCaptured"], "Actual Root authorization dialog deadline; no fallback/no input")
        def agent_guard():
            p.own_agent(agent, agent_identity, parent, helper)
            require(p.agent_bus_identity(system, agent_identity, GLib) == endpoint, "Agent authority/bus changed")
            for pid in (os.getpid(), agent.pid):
                current = p.session(system, pid, GLib)
                require(all(current[k] == report["session"][k] for k in ("object", "Id", "User", "Leader")), "Authentication session changed")
            runtime_identity(runtime, runtime_record, b, helper)
        if selected_mode != "capture":
            report["phase"] = "one-system-input"
            counter, geometry = [0], {}
            def input_guard():
                agent_guard()
                require(child.poll() is None and b.native_process(child.pid, helper) == identity, "Original Root14 changed before system input")
                single_instance_owner(session_bus, p, GLib, identity)
                require(p.windows(agent.pid, helper, x11) == native, "Bound system dialog changed before input")
                refreshed_dpkg(root, b, proof, counter, lambda: root_output.pump(0.02))
                agent_guard()
            profile = lambda: dpkg_profile(agent_identity, helper, Atspi, refs, x11, native, geometry, p, authenticate=selected_mode == "approve")
            # The exclusive marker precedes any potentially successful action;
            # even an ambiguous return makes this fresh session non-retryable.
            b.save_json(root / "system-input-attempt.json", {"mode": selected_mode, "outcome": "unknown-no-retry", "source": env["GITHUB_SHA"]})
            old_children = capture_old_children(identity, b, helper) if selected_mode == "approve" else {}
            report["oldChildrenBeforeUpdate"] = list(old_children.values())
            perform_system_input(selected_mode, p, profile, input_guard, report["systemInput"], secret)
            report["capturedQuestionProvenAsDpkg"] = True
            wipe(secret)
            report["systemDismissal"] = wait_dismissal(p, helper, x11, native, root_output, agent_guard)
        if selected_mode == "approve":
            report["phase"] = "observe-automatic-restart"
            report["restartObservation"] = {}
            replacement = wait_successor(child, identity, baseline, b, helper, root_output,
                observation=report["restartObservation"], old_children=old_children)
            report["root15"] = replacement
            report["automaticRestartObserved"] = True
            report["installed15"] = installed15(root, b)
            request15, owner15, successor_bus, ui15 = successor_ui(replacement, xid, b, c, p, helper, x11, Atspi,
                session_bus, GLib, root_output, report["systemWebKit"]["file"])
            b.save_json(root / "phase15-ui.json", ui15)
            report["fresh15UiVerified"] = True
            require(preservation(root, b) == before, "Settings/client/project sentinel changed across installation/restart")
            require(selected_project(root, b) == selection_before, "Selected project changed across restart")
            report["settingsPreserved"] = report["selectedProjectPreserved"] = True
            report["unrelatedRuntime"] = runtime_identity(runtime, runtime_record, b, helper)
            report["normalClose15"] = finish_successor(replacement, request15, owner15, b, helper, Atspi, root_output)
            require(preservation(root, b) == before and selected_project(root, b) == selection_before, "State changed on normal15 close")
            report["unrelatedRuntime"] = runtime_identity(runtime, runtime_record, b, helper)
            approval_complete(report)
            report["systemInput"]["outcome"] = "approved-install-restart-proven"
        else:
            report["installedAfterCapture"] = b.installed_state(root, "installed-after-dpkg-capture")
            require(report["installedAfterCapture"] == "creator-hub\t0.1.14\tamd64\tinstalled\n", "Package changed without authentication")
            b.pinned(Path(EXE), (Phase14().length, Phase14().digest), 0o755)
            require(child.poll() is None and b.native_process(child.pid, helper) == identity, "Original14 must survive Cancel/capture")
            if selected_mode == "system-cancel":
                report["cancelledUi"] = d.call(root, environment, "cancelled", child, start, xid, root_output, report)
                require(report["cancelledUi"]["updaterReadyAfterCancel"] is True, "Original updater remains busy after system Cancel")
                require(not any(proc_bytes(Path(f"/proc/{pid}/cmdline"), 8192).startswith(b"/usr/bin/pkexec\0")
                    for pid in direct_children(identity["pid"])), "Original authorization request remains pending after Cancel")
                report["systemInput"]["outcome"] = "cancelled-original14-ready"
                report["scopedCancellationPassed"] = True
            require(preservation(root, b) == before and selected_project(root, b) == selection_before, "Settings/selection changed during capture/Cancel")
            report["captureSentinelsPreserved"] = True
            report["unrelatedRuntime"] = runtime_identity(runtime, runtime_record, b, helper)
        report["phase"] = "scoped-" + selected_mode + "-complete"
    except Exception as error:
        failure = error
        report["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        if selected_mode == "approve" and report.get("confirmationAccepted"):
            try:
                report["installedPackageOnRefusal"] = observed_package_state(root, b, "installed-on-refusal")
                report["installedImageOnRefusal"] = b.file_record(Path(EXE), 128 * 1024 * 1024, 0o755)
            except Exception as observation_error:
                report["installationObservationRefusal"] = {"type": type(observation_error).__name__, "message": str(observation_error)[:1000]}
    finally:
        wipe(secret)
        if feed is not None:
            try:
                report["feedShutdown"] = d.stop_feed(feed, feed_output)
                transport = b.unique_json(b.bounded_read(lab / "transport-report.json", 16384))
                prefix = "/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/"
                served = {(r["host"], r["path"]) for r in transport["requests"]}
                require({("github.com", prefix + "latest.json"), ("github.com", prefix + d.ASSET)} <= served,
                        "Actual post-confirmation installer/manifest requests missing")
                require(transport["publicDiscovery"] is transport["signedUpdateAccepted"] is transport["releaseReady"] is False,
                        "Transport cannot report updater acceptance")
                report["transport"] = transport
            except Exception as error:
                failure = failure or error
                report["transportRefusal"] = str(error)[:1000]
        if root_output is not None:
            root_output.pump()
            report["rootOutput"] = root_output.metadata()
            root_output.close()
        for label, process in (("root14", child), ("agent", agent)):
            report[label + "ExitCode"] = None if process is None else process.poll()
        if axbus is not None:
            axbus.close_sync(None)
        if successor_bus is not None:
            successor_bus.close_sync(None)
        if x11 is not None:
            x11.dispose()
        if runtime is not None:
            try:
                runtime.stdin.close()  # Cooperative exit only after survival was checked.
                report["unrelatedRuntimeCleanupExit"] = runtime.wait(timeout=5)
                require(report["unrelatedRuntimeCleanupExit"] == 0, "Synthetic runtime cooperative cleanup failed")
            except Exception as error:
                failure = failure or error
                report["runtimeCleanupRefusal"] = type(error).__name__
        if failure is not None:
            report["scopedFlowPassed"] = False
            report["scopedCancellationPassed"] = False
            report.pop("scopedAcceptance", None)
            report["recovery"] = "unknown-no-retry-disposable-session-teardown"
        report["disposableSessionTeardownRequired"] = True
        b.save_json(root / "update-flow-report.json", report)
    require(failure is None, "Actual Root flow stopped; original bounded refusal retained")
    return report


def pending_dpkg_proof(b, p, state):
    """Root-only read of the fixed fixture's Root -> pending pkexec -> sealed15.

    No process signals, request creation, file mutation or authorization. The
    result is a separate kernel observation, never authority for password input.
    """
    require(os.getuid() == os.geteuid() == 0, "Root observer required for setuid procfs")
    source = BASE / "result/linux-root-probe/root-ownership.json"
    if not source.exists():
        return None
    require(source.resolve(strict=True) == source and source.stat().st_uid == UID and source.stat().st_size <= 16384,
            "Fixed fixture ownership record required")
    helper = b.load_helper()
    if "root14" not in state:
        try:
            raw = source.read_bytes()
            if not raw:
                return None
            saved = exact_json(raw)["root"]
        except json.JSONDecodeError:
            return None  # The first tiny receipt can still be in its first write.
        require(type(saved) is dict and type(saved.get("pid")) is int and 1 < saved["pid"] <= 4194304,
                "Canonical finite fixture PID required before procfs access")
        require(b.process_uids(saved["pid"]) == [UID] * 4, "Only synthetic-user Root may be inspected")
        actual = b.native_process(saved["pid"], helper)
        require(actual == saved, "Fixture Root kernel identity differs")
        phase_identity(Phase14(), actual, actual["parentPid"])
        supervisor = b.native_process(actual["parentPid"], helper)
        require(supervisor["uids"] == [UID] * 4, "Only synthetic supervisor may own Root")
        command = proc_bytes(Path(f"/proc/{supervisor['pid']}/cmdline"), 8192)
        require(command == b"/usr/bin/python3\0-B\0/opt/creator-polkit-fixture/scripts/native-linux-update-flow.py\0session\0",
                "Root is not owned by the fixed reviewed session driver")
        state["root14"] = actual
    actual = state["root14"]
    require(all(actual.get(k) == v for k, v in b.native_process(actual["pid"], helper, full=False).items()), "Root14 metadata identity changed")
    matches = []
    for pid in sorted(direct_children(actual["pid"])):
        try:
            raw = proc_bytes(Path(f"/proc/{pid}/cmdline"), 8192)
        except (FileNotFoundError, ProcessLookupError):
            continue
        require(len(raw) <= 8192, "Bounded Root child command required")
        if raw.split(b"\0", 1)[0] != b"/usr/bin/pkexec":
            continue
        require(raw == b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0",
                "Root pkexec request differs from fixed DPKG command")
        process = b.native_process(pid, helper)
        require(process["parentPid"] == actual["pid"] and process["executable"] == "/usr/bin/pkexec"
                and process["kernelImageSha256"] == p.FILES["/usr/bin/pkexec"][3]
                and process["uids"][0] in (0, UID) and process["uids"][1:] == [0, 0, 0], "Exact Root-owned setuid installer image required")
        import fcntl
        fd = os.open(f"/proc/{pid}/fd/0", os.O_RDONLY | os.O_CLOEXEC)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_size == 62212268
                    and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == 15, "Exact fully sealed seekable15 stdin required")
            digest, offset = hashlib.sha256(), 0
            while offset < before.st_size:
                block = os.pread(fd, min(65536, before.st_size - offset), offset)
                require(block, "Short sealed package read")
                digest.update(block)
                offset += len(block)
            require(digest.hexdigest() == "98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796",
                    "Pending sealed package is not immutable TESTONLY15")
            after = os.fstat(fd)
            require((before.st_dev, before.st_ino, before.st_size) == (after.st_dev, after.st_ino, after.st_size)
                    and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == 15 and b.native_process(pid, helper) == process
                    and b.native_process(actual["pid"], helper) == actual, "Pending Root/package process changed")
            matches.append({"root14": actual, "pkexec": process, "program": "/usr/bin/dpkg",
                "arguments": ["--install", "/proc/self/fd/0"], "stdinBytes": before.st_size,
                "stdinSha256": digest.hexdigest(), "seals": 15, "readOnly": True, "authorization": False, **FALSE_GATES})
        finally:
            os.close(fd)
    require(len(matches) <= 1, "Ambiguous Root DPKG requests")
    return matches[0] if matches else None


def proc_bytes(path, limit):
    with path.open("rb") as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, "Kernel observation exceeds bound")
    return data


def protected(path, directory=False):
    for target in (path, *path.parents):
        info = target.lstat()
        require(not target.is_symlink() and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o7022,
                f"Root-protected fixture source/ancestor required: {target}; uid={info.st_uid}; gid={info.st_gid}; mode={stat.S_IMODE(info.st_mode):04o}")
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "Fixture source type differs")


def fixture_binding(env):
    require(HERE == BASE / "scripts", "Only installed fixed fixture driver may broker/session")
    protected(HERE, True)
    binding_path = BASE / "update-flow-source-binding.json"
    protected(binding_path)
    binding = exact_json(binding_path.read_bytes())
    require(binding["source"] == env["GITHUB_SHA"] and binding["frozenSource"] == FROZEN_SOURCE
            and set(binding["files"]) == {Path(__file__).name, *("frozen/" + n for n in FROZEN)}, "Complete fixed source binding required")
    for name, digest in binding["files"].items():
        target = HERE / name
        protected(target)
        require(target.stat().st_size <= 262144 and hashlib.sha256(target.read_bytes()).hexdigest() == digest,
                "Installed source differs from review checkpoint")
    verify_frozen(HERE / "frozen")
    return binding


def session_command(env):
    values = {k: env[k] for k in ("GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "GITHUB_REPOSITORY",
        "GITHUB_REPOSITORY_ID", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_EVENT_NAME",
        "CREATOR_LINUX_UPDATE_FLOW", "CREATOR_LINUX_UPDATE_FLOW_MODE", "CREATOR_LINUX_ROOT_PROBE", "CREATOR_UNIX_WINDOW_TEST",
        "CREATOR_LINUX_COMPONENTS_PROBE", "CREATOR_LINUX_UPDATE_DISCOVERY", "CREATOR_LINUX_ROOT_CANDIDATE", "CREATOR_DISCOVERY_NODE")}
    values.update(HOME="/var/lib/creator-polkit-fixture", USER=USER, RUNNER_TEMP=str(BASE / "result"), XDG_RUNTIME_DIR=str(BASE / "result/runtime"),
                  LANG="C", LC_ALL="C", GDK_BACKEND="x11", NO_AT_BRIDGE="0")
    return ["/usr/bin/systemd-run", "--wait", "--pipe", "--collect", "--quiet", "--unit=creator-update-flow-fixture",
        "--uid=" + USER, "--property=PAMName=login", "--property=Type=exec", "--property=RuntimeMaxSec=360",
        "--property=LimitCORE=0", "--property=WorkingDirectory=" + str(BASE),
        *("--setenv=" + k + "=" + v for k, v in values.items()),
        "/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a", "--server-args=-screen 0 1280x800x24",
        "/bin/sh", "-eu", "-c", "/usr/bin/openbox --sm-disable </dev/null >/dev/null 2>&1 & manager=$!; "
        "trap '/usr/bin/openbox --exit; wait \"$manager\"' EXIT; "
        "/usr/bin/python3 -B /opt/creator-polkit-fixture/scripts/native-linux-update-flow.py session"]


def broker(env):
    admission(env, sys.platform, platform.machine())
    require(os.getuid() == os.geteuid() == 0, "Fixed root broker only")
    selected_mode = mode(env)
    import pwd
    import grp
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(os.fstat(0).st_rdev == os.stat("/dev/null").st_rdev and stat.S_ISCHR(os.fstat(0).st_mode), "Broker stdin must be /dev/null")
    binding = fixture_binding(env)
    _d, b, _c, p = dependencies()
    account = pwd.getpwnam(USER)
    require((account.pw_uid, account.pw_gid, account.pw_dir, account.pw_shell) == (UID, UID, "/var/lib/creator-polkit-fixture", "/bin/bash")
            and set(os.getgrouplist(USER, UID)) == {UID, grp.getgrnam("sudo").gr_gid}, "Exact synthetic administrator required")
    output = BASE / "result"
    require(output.resolve(strict=True) == output and output.stat().st_uid == output.stat().st_gid == UID
            and stat.S_IMODE(output.stat().st_mode) == 0o700 and not os.path.lexists(output / "linux-root-probe/home"), "Fresh private synthetic home required")
    p.credential_tools(output)
    require(p.fixture_credential("status") == "L", "Fresh locked synthetic account required")
    policy = p.admin_config()
    b.write_new(BASE / "update-flow-once.json", json.dumps({"source": binding["source"], "uid": UID}).encode(), 0o600)
    record = {"scope": "fixed-root14-testonly15-disposable-session", "mode": selected_mode, "source": binding["source"], "uid": UID,
              "passwordProvisioned": False, "fixtureRelocked": False, "scopedFlowPassed": False, **FALSE_GATES}
    secret = payload = None
    relock, failure = False, None
    try:
        if selected_mode == "approve":
            secret = bytearray(secrets.token_hex(32).encode("ascii"))
            relock = True  # Even provision's ambiguous failure must attempt a relock.
            p.fixture_credential("provision", secret)
            require(p.fixture_credential("status") == "P", "Synthetic provisioning refused")
            record["passwordProvisioned"] = True
            payload = bytearray(secret)
            payload.append(10)
        session = subprocess.Popen(session_command(env), stdin=subprocess.PIPE if selected_mode == "approve" else subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, cwd=BASE, close_fds=True)
        if payload is not None:
            try:
                require(session.stdin.write(payload) == 65, "Synthetic pipe delivery refused")
                session.stdin.close()
            except Exception:
                raise RuntimeError("Synthetic pipe delivery refused; no retry") from None
            finally:
                wipe(payload)
                wipe(secret)
        deadline, proof, observation, index, observer_failed = time.monotonic() + 380, None, {}, 1, False
        while time.monotonic() < deadline and session.poll() is None:
            if not observer_failed:
                try:
                    if proof is None:
                        proof = pending_dpkg_proof(b, p, observation)
                        if proof is not None:
                            b.save_json(BASE / "dpkg-request-proof.json", proof)
                            os.chmod(BASE / "dpkg-request-proof.json", 0o644)
                    request = output / f"linux-root-probe/dpkg-input-{index}.json"
                    if proof is not None and index <= 5 and request.exists():
                        info = request.lstat()
                        require(request.resolve(strict=True) == request and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                                and info.st_uid == UID and info.st_size <= 64, "Fixed synthetic guard request required")
                        raw = request.read_bytes()
                        # An exclusive tiny receipt may still be in its first write.
                        if raw and raw.endswith(b"}"):
                            require(exact_json(raw) == {"index": index}, "Guard request sequence differs")
                            current = pending_dpkg_proof(b, p, observation)
                            require(current == proof, "Pending sealed DPKG identity changed before input")
                            response = BASE / f"dpkg-input-{index}.json"
                            b.save_json(response, {"index": index, "proof": current})
                            os.chmod(response, 0o644)
                            index += 1
                except Exception as error:
                    # Do not replace a session's original refusal with a later
                    # dead-Root observation. No further input proofs are issued.
                    observer_failed = True
                    record["observerRefusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
            time.sleep(0.1)
        receipt = output / "linux-root-probe/update-flow-report.json"
        if receipt.exists():
            info = receipt.lstat()
            require(receipt.resolve(strict=True) == receipt and stat.S_ISREG(info.st_mode) and info.st_uid == UID
                    and info.st_nlink == 1 and info.st_size <= 1048576, "Fixed session receipt required")
            result = exact_json(receipt.read_bytes())
            require(result["testSource"] == binding["source"] and result["mode"] == selected_mode, "Session receipt binding differs")
            if "refusal" in result:
                record["sessionRefusal"] = result["refusal"]
            require("refusal" not in result and not result.get("recovery"), "Original session refused; bounded session receipt retained")
            record["scopedFlowPassed"] = result.get("scopedFlowPassed") is True
            record["scopedCancellationPassed"] = result.get("scopedCancellationPassed") is True
        require(session.poll() == 0 and proof is not None and not observer_failed, "Session/kernel DPKG proof incomplete; no retry")
        session.wait(timeout=0)
        require((selected_mode != "approve" or record["scopedFlowPassed"])
                and (selected_mode != "system-cancel" or record["scopedCancellationPassed"]), "Requested finite flow not proven")
        require(p.admin_config() == policy, "Public administrator policy changed")
        record["sessionExitedZero"] = True
    except Exception as error:
        failure = error
        record["brokerRefusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
    finally:
        wipe(payload)
        wipe(secret)
        try:
            current = pwd.getpwnam(USER)
            require((current.pw_uid, current.pw_gid, current.pw_dir, current.pw_shell)
                    == (account.pw_uid, account.pw_gid, account.pw_dir, account.pw_shell), "Synthetic account identity changed; relock refused")
            if relock:
                p.fixture_credential("lock")
            require(p.fixture_credential("status") == "L", "Synthetic relock not proven")
            record["fixtureRelocked"] = True
        except Exception as error:
            failure = failure or error
            record["relockRefusal"] = "Synthetic relock refused; disposable teardown required"
        if failure is not None:
            record["scopedFlowPassed"] = False
            record["scopedCancellationPassed"] = False
            record["recovery"] = "unknown-no-retry-disposable-session-teardown"
        b.save_json(BASE / "update-flow-broker.json", record)
    require(failure is None, "Disposable broker refused; original session/cleanup receipts retained")
    return record


def checkpoint():
    return {"scope": "source/unit/preflight-only-native-unverified", "admittedNativeModes": list(MODES),
        "frozenSource": FROZEN_SOURCE, "frozenFiles": FROZEN,
        "pending": ["parent review before dispatch", "actual system Cancel and original14 readiness",
                    "actual signed15 installation", "automatic phase15 PID/window/normal-close proof",
                    "actual preserved settings/selected project/unrelated synthetic runtime"], **FALSE_GATES}


def main():
    args = sys.argv[1:]
    if args == ["checkpoint"]:
        return checkpoint()
    admission(os.environ, sys.platform, platform.machine())
    if args in (["broker"], ["session"]):
        fixture_binding(os.environ)
    d, b, _c, _p = dependencies()
    temp = b.ordinary(os.environ["RUNNER_TEMP"])
    if args == ["pins"]:
        return d.candidate_pins() | {"frozenSource": FROZEN_SOURCE, "frozenFiles": FROZEN}
    if args == ["stage"]:
        b.stage(temp)
        return d.stage_target(temp)
    if args == ["install14"]:
        return b.install(temp / "linux-root-probe")
    if args == ["tls"]:
        root, lab = temp / "linux-root-probe", temp / "creator-linux-update-lab"
        _key, _cert, evidence = d.prepare_tls(root, lab)
        return evidence
    if args == ["broker"]:
        return broker(os.environ)
    if args == ["session"]:
        return native_capture(temp / "linux-root-probe", os.environ)
    raise RuntimeError("Use checkpoint, pins, stage, install14, tls, or fixed internal broker/session")


if __name__ == "__main__":
    try:
        result = main()
        # Full receipts are retained in fixed files, never credential/TLS bodies.
        print(json.dumps(result if sys.argv[1:] in (["pins"], ["checkpoint"]) else {"phase": result.get("phase"), **FALSE_GATES}))
    except Exception as error:
        print(json.dumps({"error": str(error)[:1000], "captureStopped": True, **FALSE_GATES}))
        sys.exit(1)
