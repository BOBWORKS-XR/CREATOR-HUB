"""Disposable native14 signed15 discovery, GTK capture and explicit cancellation.

Never approve installation, install15, authenticate, migrate, or claim release
acceptance. Existing B/C own package, terms, AX/renderer and XRes contracts.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import subprocess
import sys
import time
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BRANCH = "refs/heads/validation/linux-installed-candidate-014"
ASSET = "Creator_Hub_0.1.15_amd64-acceptance-only.deb"
DESCRIPTOR = "creator-hub-linux-x86_64-deb.json"
TARGET = {"run": 39105404389, "attempt": 1, "job": 117610063120, "artifact": 12127943519,
          "name": "linux-outer-update-target15-39105404389-1", "zipBytes": 68554208,
          "zipSha256": "9e946ea7e409cc6718d94c62c9f868929c795e9a0a03a139c4e2abc4567bac00",
          "source": "eef90658c4d9e6743c6c25f67e00ad36c783ca6e", "tree": "2ba0c775f944df14bf3de4c55993df2688991f78",
          "bytes": 62212268, "installer": "98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796",
          "executable": "7629379fbd3d0b7db0a996d727aa166750e08165478d622fe0d7c5047f2d50fe"}
METADATA = {
    DESCRIPTOR: (652786072, 513, "45e2ea02244001d328fb01785287eb1088207b007be11bb740b8a09890321735", DESCRIPTOR),
    DESCRIPTOR + ".minisig": (652786071, 318, "ce96f5a2bcad99929214f15b5061bc0f68ad90245a1422250562c075de84b830", DESCRIPTOR + ".minisig"),
    "latest.json": (652786073, 745, "e639229c12ac93866d4112c3ccb9f4d45c20adaa7ab7fff05afc15c0da45e7ea", "linux15-latest.json"),
}
PINS = {"descriptor": METADATA[DESCRIPTOR][2], "descriptorSignature": METADATA[DESCRIPTOR + ".minisig"][2],
        "manifest": METADATA["latest.json"][2], "installer": TARGET["installer"], "executable": TARGET["executable"]}
CONTROLS = {"check-updates": ("check-updates", "Check for updates"),
            "open-confirmation": ("hub-update-button", "Update Hub")}
FALSE_GATES = {key: False for key in ("publicDiscovery", "nativeConfirmationInputAuthorized", "confirmationAccepted",
    "systemAuthenticationAccepted", "signedUpdateAccepted", "restartAccepted", "migrationAccepted", "releaseReady")}
_components = None


def require(value, message):
    if not value:
        raise RuntimeError(message)


def components():
    global _components
    if _components is None:
        spec = importlib.util.spec_from_file_location("discovery_existing_components", HERE / "native-linux-components-probe.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        module.configure_component_candidate(module.B.CURRENT_CANDIDATE)
        _components = module
    return _components


def admission(env, system, machine):
    c = components()
    c.admission(env, system, machine)
    require(all(env.get(k) == v for k, v in {"CREATOR_LINUX_UPDATE_DISCOVERY": "1", "GITHUB_REF": BRANCH,
            "CREATOR_LINUX_ROOT_CANDIDATE": c.B.CURRENT_CANDIDATE}.items()), "Exact discovery runner/candidate required")
    require(env.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch")
            and re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Exact test event/source required")
    require(not any(re.match(r"^(LD_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|TAURI_SIGNING_|CREATOR_HUB_SIGNING_)", k)
                    for k in env), "Runtime/signing injection refused")


def candidate_pins():
    c = components()
    return {"root": c.configure_component_candidate(c.B.CURRENT_CANDIDATE), "target": TARGET, "metadata": METADATA,
            "testHelpers": {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in
                            ("native-linux-root-probe.py", "native-linux-components-probe.py", "native-unix-window.py",
                             "linux-update-lab-feed.cjs", "native-linux-update-discovery.py")}}


def validate_target_binding(value):
    run, artifact, job, commit, draft = (value[k] for k in ("run", "artifact", "job", "commit", "draft"))
    for record, fields in ((run, ("id", "run_attempt")), (artifact, ("id", "size_in_bytes")),
                           (artifact["workflow_run"], ("id", "repository_id", "head_repository_id")),
                           (run["repository"], ("id",)), (job, ("id", "run_id", "run_attempt")), (draft, ("id",))):
        require(all(type(record[k]) is int and record[k] > 0 for k in fields), "Canonical positive API integers required")
    require(type(artifact["expired"]) is bool and type(draft["draft"]) is bool, "Canonical API booleans required")
    require(type(value["assets"]) is list and len(value["assets"]) == 3
            and all(type(a["id"]) is type(a["size"]) is int for a in value["assets"]), "Three canonical metadata assets required")
    require(all(run.get(k) == v for k, v in {"id": TARGET["run"], "run_attempt": 1, "head_sha": TARGET["source"],
            "status": "completed", "conclusion": "success", "event": "push", "head_branch": "validation/linux-outer-update-fixture-014",
            "path": ".github/workflows/linux-outer-update-fixture-014.yml"}.items()) and run["repository"]["id"] == 1364807512,
            "Target producer differs")
    require(all(artifact.get(k) == v for k, v in {"id": TARGET["artifact"], "name": TARGET["name"], "expired": False,
            "size_in_bytes": TARGET["zipBytes"], "digest": "sha256:" + TARGET["zipSha256"]}.items()), "Target artifact differs")
    require(all(artifact["workflow_run"].get(k) == v for k, v in {"id": TARGET["run"], "head_sha": TARGET["source"],
            "repository_id": 1364807512, "head_repository_id": 1364807512}.items()), "Foreign target workflow artifact")
    require(job["id"] == TARGET["job"] and job["run_id"] == TARGET["run"] and job["run_attempt"] == 1
            and job["name"] == "target" and job["conclusion"] == "success", "Target job differs")
    require(commit["sha"] == TARGET["source"] and commit["tree"]["sha"] == TARGET["tree"], "Target source tree differs")
    require(draft == {"id": 411494394, "tag_name": "v0.1.13-validation", "draft": True}, "Private draft must remain a draft")
    expected = sorted((p[0], p[1], p[2], p[3]) for p in METADATA.values())
    actual = sorted((a["id"], a["size"], a["digest"].removeprefix("sha256:"), a["name"]) for a in value["assets"])
    require(actual == expected and all(a["state"] == "uploaded" for a in value["assets"]), "Exact signed metadata asset binding differs")


def stage_target(temp):
    b = components().B
    binding = b.unique_json(b.bounded_read(temp / "linux-discovery-target-binding.json", 32768))
    validate_target_binding(binding)
    archive = temp / "linux-discovery-target-original.zip"
    b.pinned(archive, (TARGET["zipBytes"], TARGET["zipSha256"]))
    lab = temp / "creator-linux-update-lab"
    lab.mkdir(mode=0o700)
    inputs = lab / "inputs"
    inputs.mkdir(mode=0o700)
    for name, (_id, size, digest, _remote) in METADATA.items():
        source = temp / ("linux-discovery-" + name)
        b.pinned(source, (size, digest))
        b.write_new(inputs / name, b.bounded_read(source, size))
    suffix = "/native-packages/Creator Hub_0.1.15_amd64.deb"
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        require(0 < len(entries) <= 256 and len({e.filename for e in entries}) == len(entries), "Ambiguous target ZIP")
        matches = [e for e in entries if e.filename.endswith(suffix)]
        require(len(matches) == 1, "Exact unique target DEB member required")
        entry = matches[0]
        require(not entry.is_dir() and not entry.flag_bits & 1 and entry.file_size == TARGET["bytes"]
                and not entry.filename.startswith("/") and ".." not in Path(entry.filename).parts
                and "\\" not in entry.filename and stat.S_ISREG(entry.external_attr >> 16), "Unsafe target member")
        data = zipped.read(entry)
        require(len(data) == TARGET["bytes"] and hashlib.sha256(data).hexdigest() == TARGET["installer"], "Target DEB bytes differ")
        b.write_new(inputs / ASSET, data)
    b.pinned(archive, (TARGET["zipBytes"], TARGET["zipSha256"]))
    b.save_json(lab / "config.json", {"schemaVersion": 1, "targetVersion": "0.1.15", "directory": str(inputs), "pins": PINS})
    b.save_json(lab / "input-binding.json", binding)
    return {"targetInputsStaged": True, "targetInstalled": False, **FALSE_GATES}


def loopback_proxy(value):
    require(type(value) is str and re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", value)
            and 1 <= int(value.rsplit(":", 1)[1]) <= 65535, "Exact ephemeral IPv4 loopback proxy required")
    return value


def child_environment(env, root, proxy):
    result = components().B.child_env(env, root)
    require(not any(k.lower().endswith("proxy") for k in result), "B environment unexpectedly retained a proxy")
    result["HTTPS_PROXY"] = loopback_proxy(proxy)
    return result


class NotReady(RuntimeError):
    pass


def fixed_controls(nodes, action, owner, atspi):
    require(action in CONTROLS, "Unreviewed updater action")
    c, b = components(), components().B
    wanted_id, wanted_name = CONTROLS[action]
    selected, headings = [], []
    counts = {key: 0 for key in (wanted_id, "hub-update-title")}
    for node in nodes:
        attributes = node.get_attributes()
        require(type(attributes) is dict and len(attributes) <= 32, "Bounded native attributes required")
        if attributes.get("id") in counts:
            counts[attributes["id"]] += 1
    require(all(n <= 1 for n in counts.values()), "Ambiguous fixed source IDs")
    for node in nodes:
        attributes = node.get_attributes()
        require(type(attributes) is dict and len(attributes) <= 32, "Bounded native attributes required")
        if attributes.get("id") not in (wanted_id, "hub-update-title"):
            continue
        owner.node(node)
        require(owner.renderer is not None and node.get_process_id() == owner.renderer["pid"], "Foreign fixed updater control")
        states = node.get_state_set()
        if not states.contains(atspi.StateType.SHOWING):
            raise NotReady("Updater context is not showing")
        require(attributes.get("toolkit") == "WebKitGTK", "Unexpected updater toolkit")
        if attributes.get("id") == "hub-update-title":
            require(node.get_name() == "Creator Hub update" and attributes.get("tag") == "h2"
                    and attributes.get("computed-role") == "heading", "Fixed source h2 context differs")
            role = node.get_role()
            require(role in (atspi.Role.HEADING, 82), "Updater heading role differs")
            if role == 82:
                require(b.WEBKIT_VERSION == "2.50.4-0ubuntu0.22.04.1" and owner.renderer["executable"] == b.WEBKIT
                        and owner.renderer["kernelImageSha256"] == b.WEBKIT_SHA and owner.system_file["sha256"] == b.WEBKIT_SHA,
                        "Heading82 requires exact already-bound WebKit producer")
                owner.recheck(full=True)
            headings.append(node)
        else:
            require(node.get_name() == wanted_name and node.get_role() == atspi.Role.PUSH_BUTTON
                    and attributes.get("tag") == "button" and attributes.get("computed-role") == "button", "Fixed source button differs")
            if not all(states.contains(getattr(atspi.StateType, s)) for s in ("ENABLED", "SENSITIVE")):
                raise NotReady("Updater button is not enabled yet")
            owner.helper.ready(node, atspi)
            interface = node.get_action_iface()
            require(interface is not None and interface.get_n_actions() == 1 and interface.get_action_name(0) == "press",
                    "Exact single WebKit press required")
            selected.append((node, interface))
    if not selected or not headings:
        raise NotReady("Fixed updater button/context absent")
    require(len(selected) == len(headings) == 1, "Ambiguous fixed updater context")
    return selected[0][0], selected[0][1], headings[0]


def press_control(action, owner, atspi):
    c = components()
    window = owner.helper.select_window(owner.request, atspi)
    first, _, heading = fixed_controls(c.own_tree(window, owner, atspi), action, owner, atspi)
    second, interface, second_heading = fixed_controls(c.own_tree(window, owner, atspi), action, owner, atspi)
    require(owner.same_node(first, second) and owner.same_node(heading, second_heading), "Updater control/context changed between complete walks")
    owner.recheck(full=True)
    try:
        require(interface.do_action(0), "Updater press refused; no retry")
    except Exception as error:
        raise owner.helper.ActionError("Updater native press uncertain; no retry") from error
    return {"action": action, "actionCount": 1, "domId": CONTROLS[action][0], "ownership": owner.evidence(), **FALSE_GATES}


def update_status(nodes, owner, atspi):
    # Source index.html uses p[role=status], mapped to StatusBar by WebKit,
    # not Paragraph. Read only this fixed status even when below the viewport;
    # pressing still requires the separate visible/enabled source button.
    # WebKit/webkitgtk-2.50.4 AccessibilityObjectAtspi.cpp::atspiRole.
    matches = [n for n in nodes if n.get_attributes().get("id") == "hub-update-status"]
    require(len(matches) == 1, "Exact unique updater status required")
    node = matches[0]
    owner.node(node)
    attributes = node.get_attributes()
    require(owner.renderer is not None and node.get_process_id() == owner.renderer["pid"]
            and node.get_role() == atspi.Role.STATUS_BAR
            and attributes.get("tag") == "p" and attributes.get("computed-role") == "status"
            and attributes.get("toolkit") == "WebKitGTK", "Fixed source status differs")
    states = node.get_state_set()
    require(not states.contains(atspi.StateType.DEFUNCT), "Updater status is defunct")
    interface = node.get_text_iface()
    require(interface is not None, "Updater status text interface absent")
    count = interface.get_character_count()
    require(type(count) is int and 0 <= count <= 512, "Updater status exceeds bound")
    text = interface.get_text(0, count)
    require(type(text) is str and len(text) == count and len(text.encode("utf8")) <= 2048
            and interface.get_character_count() == count, "Updater status text changed or oversized")
    owner.recheck(full=True)
    return {"text": text, "showing": states.contains(atspi.StateType.SHOWING), "readOnly": True}


def capture_dialog(root, request, helper, x11, atspi, saved):
    c, b = components(), components().B
    deadline = time.monotonic() + 20
    windows = []
    while time.monotonic() < deadline:
        require(b.native_process(request.pid, helper) == saved["root"], "Root changed before native updater capture")
        helper.bound_window(request, x11)
        windows = c.owned_windows(request.pid, x11)
        matches = [w for w in windows if w["mapped"] and w["window"] != request.window]
        require(len(matches) <= 1, "Ambiguous new Root native dialogs; no title-based selection")
        if matches:
            native = matches[0]
            dialog = helper.Request("snapshot", request.pid, request.start, request.executable, request.sha256,
                                    native["window"], native["title"], "ALERT")
            xres = helper.bound_window(dialog, x11)
            observed = c.backend_ax_observation(dialog, helper, x11, atspi, None, saved["root"], saved["root"])
            last = {"readOnly": True, "authorization": False, "actionCount": 0, "native": native, "xres": xres,
                    "root": saved["root"], "transientFor": x11.property(native["window"], "WM_TRANSIENT_FOR"),
                    "nativeFrame": x11.frame_rectangle(native["window"]), "ax": observed, **FALSE_GATES}
            b.save_json(root / "updater-confirmation-contract.json", last)
            require(observed.get("verified") is True, "Read-only Root dialog attribution refused; contract retained")
            groups = {}
            for node in observed["nodes"]:
                if node["showing"]:
                    groups.setdefault(node["windowIndex"], []).append(node)
            contexts = [nodes for nodes in groups.values() if any(n["name"].startswith("Update Creator Hub to 0.1.15?") for n in nodes)
                        and {"Update Hub", "Not now"} <= {n["name"] for n in nodes}]
            require(len(contexts) == 1, "Source updater text/buttons not uniquely captured; no input authorized")
            require(b.native_process(request.pid, helper) == saved["root"] and helper.bound_window(dialog, x11) == xres,
                    "Root/native dialog changed during capture")
            # No AX-to-XID association or GTK input policy is invented here.
            return {"dialogContractCaptured": True, "sourceQuestionAndButtonsObserved": True,
                    "axToXidAssociationVerified": False, "actionCount": 0, "window": native["window"], **FALSE_GATES}
        time.sleep(0.05)
    b.save_json(root / "updater-native-window-refusal.json", {"windows": windows, "readOnly": True, "authorization": False})
    raise RuntimeError("Native updater dialog absent; no retry/input")


def cancel_confirmation(root, request, helper, x11, atspi, saved):
    """One source-bound GTK cancellation; no shared dialog allowlist changes."""
    c, b = components(), components().B
    contract = b.unique_json(b.bounded_read(root / "updater-confirmation-contract.json", 32768))
    native, frame = contract["native"], tuple(contract["nativeFrame"])
    require(len(frame) == 4 and all(type(v) is int and 0 <= v <= 1920 for v in frame)
            and 0 < frame[2] <= 1920 and 0 < frame[3] <= 1080, "Captured native updater frame exceeds bound")
    require(contract["root"] == saved["root"] and contract["actionCount"] == 0
            and native["pid"] == request.pid and native["title"] == "Update Creator Hub"
            and native["window"] != request.window, "Original native updater binding required")
    dialog = helper.Request("snapshot", request.pid, request.start, request.executable, request.sha256,
                            native["window"], "Update Creator Hub", "ALERT", gtk_message_info_frame=frame)
    require(helper.bound_window(dialog, x11) == contract["xres"], "Captured updater XRes/frame changed")
    refs = b.unique_json(b.bounded_read(root / "ax-ownership.json", 8192))
    references, bus = b.native_ax_references(refs)
    question = "Update Creator Hub to 0.1.15?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."

    def walk():
        owner.recheck(full=True)
        current = [w for w in c.owned_windows(request.pid, x11) if w["mapped"] and w["window"] != request.window]
        require(current == [native], "Additional or changed owned native dialog")
        window = helper.select_window(dialog, atspi)
        pending, nodes, seen, edges = [(window, None, 0)], [], set(), []
        while pending:
            node, parent, depth = pending.pop()
            require(node is not None and len(nodes) < 64 and depth < 16, "Updater GTK tree exceeds bound")
            node.clear_cache()
            require(node.get_process_id() == request.pid, "Foreign updater GTK node")
            owner.node(node)
            reference = tuple(references.identity(node, owner))
            require(reference not in seen, "Duplicate/cyclic updater GTK node")
            seen.add(reference)
            if parent is not None:
                require(node.get_role() not in (atspi.Role.FRAME, atspi.Role.WINDOW, atspi.Role.DIALOG, atspi.Role.ALERT, atspi.Role.APPLICATION)
                        and owner.same_node(node.get_parent(), parent), "Updater GTK parent/window escaped")
            name = node.get_name()
            require(type(name) is str and len(name) <= 512, "Updater GTK name exceeds bound")
            # Fresh GetChildren on each complete walk, not cached semantic Parent.
            children = helper.children(node, min(32, 64 - len(nodes) - len(pending) - 1))
            edges.append((reference, None if parent is None else tuple(references.identity(parent, owner)), int(node.get_role()), name))
            nodes.append(node)
            pending.extend((child, node, depth + 1) for child in reversed(children))
        for text in ("Update Creator Hub", question):
            labels = [n for n in nodes if n.get_role() == atspi.Role.LABEL and n.get_name() == text]
            require(len(labels) == 1, "Exact updater GTK question/title required")
            helper.ready(labels[0], atspi)
        buttons = [n for n in nodes if n.get_role() == atspi.Role.PUSH_BUTTON]
        require(len(buttons) == 2 and {n.get_name() for n in buttons} == {"Update Hub", "Not now"}, "Exact two updater GTK buttons required")
        target = next(n for n in buttons if n.get_name() == "Not now")
        helper.ready(target, atspi)
        interface = target.get_action_iface()
        require(interface is not None and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click",
                "Exact native GTK cancellation action required")
        require(owner.same_node(helper.select_window(dialog, atspi), window), "Updater GTK window changed")
        owner.recheck(full=True)
        return edges, target, interface

    try:
        owner = b.RootOwnership(dialog, helper, x11, saved["root"], contract["xres"], saved["systemWebKit"]["file"], references=references)
        first, before, _ = walk()
        second, target, interface = walk()
        require(first == second and owner.same_node(before, target), "Updater GTK tree/target changed between fresh walks")
        try:
            require(interface.do_action(0), "Updater cancellation refused; no retry")
        except Exception as error:
            raise helper.ActionError("Updater native cancellation uncertain; no retry") from error
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            require(b.native_process(request.pid, helper) == saved["root"], "Root changed after cancellation")
            helper.bound_window(request, x11)
            if not any(w["window"] == native["window"] and w["mapped"] for w in c.owned_windows(request.pid, x11)):
                return {**FALSE_GATES, "actionCount": 1, "button": "Not now", "dialogDismissed": True,
                        "confirmationCancellationInputAuthorized": True, "axToXidAssociationVerified": True}
            time.sleep(0.05)
        raise RuntimeError("Updater cancellation dismissal deadline; no retry")
    finally:
        bus.close_sync(None)


def worker(root, args):
    c, b = components(), components().B
    require(len(args) == 4 and args[0] in (*CONTROLS, "ready", "capture-confirmation", "cancel-confirmation", "cancelled"), "Fixed discovery worker required")
    action, pid, start, xid = args
    b.verify_stage(root)
    helper = b.load_helper()
    request = helper.Request.parse(["snapshot", pid, start, str(b.paths(root)["creator-hub"]), b.INSTALLED_HUB_PIN[1], xid, b.TITLE, "FRAME"])
    saved = b.unique_json(b.bounded_read(root / "root-ownership.json", 16384))
    require(saved["root"]["parentPid"] == os.getppid() and saved["root"]["uids"] == [os.getuid()] * 4
            and saved["window"] == request.window and b.native_process(request.pid, helper) == saved["root"], "Held Root ownership differs")
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.set_timeout(3000, 3000)
    x11, bus, last = helper.X11(), None, None
    try:
        helper.identity(request, helper.Proc())
        helper.bound_window(request, x11)
        if action == "capture-confirmation":
            return capture_dialog(root, request, helper, x11, Atspi, saved)
        if action == "cancel-confirmation":
            return cancel_confirmation(root, request, helper, x11, Atspi, saved)
        refs = b.unique_json(b.bounded_read(root / "ax-ownership.json", 8192))
        renderer = b.unique_json(b.bounded_read(root / "renderer-ownership.json", 8192))
        references, bus = b.native_ax_references(refs)
        owner = b.RootOwnership(request, helper, x11, saved["root"], saved["xres"], saved["systemWebKit"]["file"], renderer, references=references)
        deadline, last = time.monotonic() + 20, None
        while time.monotonic() < deadline:
            nodes = c.own_tree(helper.select_window(request, Atspi), owner, Atspi)
            last = c.ui_snapshot(nodes, owner, Atspi)
            try:
                selected_action = "open-confirmation" if action in ("ready", "cancelled") else action
                fixed_controls(nodes, selected_action, owner, Atspi)
                if action in ("ready", "open-confirmation", "cancelled"):
                    last["sourceUpdateStatus"] = update_status(nodes, owner, Atspi)
                    # app.js writes the cancellation message to progress-message,
                    # not hub-update-status. Here require the ordinary updater
                    # to become actionable again; never assert a misplaced text.
                    expected = ("Version 0.1.15 is available.", "Version 0.1.15 is ready to install.")
                    if last["sourceUpdateStatus"]["text"] not in expected:
                        raise NotReady("Signed15 UI status not observed yet")
                if action in ("ready", "cancelled"):
                    b.save_json(root / ("signed15-ui-ready.json" if action == "ready" else "cancelled-ui-status.json"), last)
                    return {"signed15UiReady": action == "ready", "updaterReadyAfterCancel": action == "cancelled",
                            "actionCount": 0, "ownership": owner.evidence(), **FALSE_GATES}
                # An enabled control may change between polling and action. A
                # final two-walk refusal must propagate, never become a retry.
                break
            except NotReady:
                time.sleep(0.05)
        else:
            if last is not None:
                b.save_json(root / (action + "-not-ready.json"), last)
            raise RuntimeError("Source updater readiness deadline; no fallback")
        return press_control(action, owner, Atspi)
    except Exception as error:
        if isinstance(error, c.TreeRefusal):
            c.retain_tree_refusal(root, "update-" + action, error)
        if last is not None:
            try:
                b.save_json(root / (action + "-failure-ui.json"), last)
            except Exception:
                pass  # Diagnostic serialization must not replace the refusal.
        c.retain_failure_site(root, "update-" + action, error)
        raise
    finally:
        if bus is not None:
            bus.close_sync(None)
        x11.dispose()


def call(root, env, action, child, start, xid, capture, report):
    b = components().B
    worker_env = dict(env)
    for key in ("GITHUB_REF", "GITHUB_EVENT_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "CREATOR_LINUX_UPDATE_DISCOVERY"):
        worker_env[key] = os.environ[key]
    worker_env["CREATOR_LINUX_COMPONENTS_PROBE"] = "1"
    command = ["/usr/bin/python3", "-B", str(Path(__file__).resolve()), "worker", action, str(child.pid), start, str(xid)]
    process = subprocess.Popen(command, env=worker_env, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = b.Capture(process, root, "discovery-" + action)
    record = {"action": action, "pid": process.pid, "exitCode": None}
    report["workers"].append(record)
    try:
        end = time.monotonic() + 25
        while time.monotonic() < end:
            output.pump(0.02)
            capture.pump()
            if process.poll() is not None and all(v["eof"] for v in output.items.values()):
                break
        record.update(exitCode=process.poll(), output=output.metadata())
        require(record["exitCode"] is not None, "Discovery worker timeout; no signal or retry; teardown required")
        process.wait(timeout=0)
        require(all(v["eof"] and not v["truncated"] for v in output.metadata().values()), "Worker EOF/size refused")
        value = b.unique_json(bytes(output.items["stdout"]["kept"]))
        record["result"] = value
        require(record["exitCode"] == 0 and not value.get("error"), "Discovery worker refused; original capture retained")
        return value
    finally:
        output.close()


def prepare_tls(root, lab):
    b = components().B
    directory = lab / "ephemeral-tls"
    directory.mkdir(mode=0o700)
    config, key, cert = (directory / n for n in ("tls.cnf", "private.pem", "public.crt"))
    b.write_new(config, b"[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=api.github.com\n[ext]\nsubjectAltName=DNS:api.github.com,DNS:github.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n")
    b.run_tool(root, "create-ephemeral-lab-tls", ["/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-days", "1", "-config", str(config), "-keyout", str(key), "-out", str(cert)])
    os.chmod(key, 0o600)
    public = b.file_record(cert, 65536)
    destination = Path("/usr/local/share/ca-certificates/creator-linux-discovery.crt")
    require(not os.path.lexists(destination), "Existing lab trust refused")
    b.run_tool(root, "import-only-ci-public-ca", ["/usr/bin/sudo", "-n", "/usr/bin/install", "-o", "0", "-g", "0", "-m", "0644", str(cert), str(destination)])
    b.run_tool(root, "refresh-only-disposable-ci-ca", ["/usr/bin/sudo", "-n", "/usr/sbin/update-ca-certificates"], timeout=30)
    require(b.file_record(destination, 65536)["sha256"] == public["sha256"], "Imported public CA differs")
    return key, cert, {"publicCaSha256": public["sha256"], "scope": "disposable-CI-session-only", "globalUserTrustChanged": False}


def start_feed(root, lab, env, key, cert):
    b = components().B
    node = Path(env.get("CREATOR_DISCOVERY_NODE", ""))
    require(node.is_absolute() and node.name == "node" and node.resolve(strict=True) == node, "Explicit canonical Node image required")
    node_record = b.file_record(node, 256 * 1024 * 1024)
    feed_env = b.child_env(env, root)
    feed_env.update({k: env[k] for k in ("GITHUB_REF", "GITHUB_EVENT_NAME", "GITHUB_SHA", "GITHUB_RUN_ID")})
    feed_env["CREATOR_LINUX_UPDATE_LAB_FEED"] = "1"
    control = json.dumps({"key": base64.b64encode(b.bounded_read(key, 65536)).decode("ascii"),
                          "cert": base64.b64encode(b.bounded_read(cert, 65536)).decode("ascii")}).encode()
    require(len(control) < 131072, "Bounded ephemeral TLS stdin required")
    process = subprocess.Popen([str(node), str(HERE / "linux-update-lab-feed.cjs"), str(lab / "config.json"), str(lab / "transport-report.json")],
                               env=feed_env, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = b.Capture(process, root, "lab-transport")
    try:
        process.stdin.write(control)
        process.stdin.close()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            output.pump(0.02)
            raw = bytes(output.items["stdout"]["kept"])
            if b"\n" in raw:
                require(process.poll() is None and raw.count(b"\n") == 1 and len(raw) < 2048, "One live feed ready message required")
                ready = b.unique_json(raw)
                require(set(ready) == {"kind", "proxyUrl", "labDiscovery", "publicDiscovery", "releaseReady"}
                        and ready["kind"] == "linux-lab-feed-ready" and ready["labDiscovery"] is True
                        and ready["publicDiscovery"] is ready["releaseReady"] is False, "Feed startup scope differs")
                return process, output, loopback_proxy(ready["proxyUrl"]), node_record
            require(process.poll() is None, "Lab sidecar exited before ready; no app launched")
        raise RuntimeError("Lab transport readiness deadline; no app launched")
    except Exception:
        b.save_json(root / "feed-start-refusal.json", stop_feed(process, output))
        raise


def stop_feed(process, output):
    # Only the retained direct lab child is signalled. Never Hub, its dialog,
    # a renderer, any AI app or an unrelated process. Session teardown owns hangs.
    try:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        end = time.monotonic() + 5
        while time.monotonic() < end and (process.poll() is None or not all(v["eof"] for v in output.items.values())):
            output.pump(0.02)
        code = process.poll()
        if code is not None:
            process.wait(timeout=0)
        return {"exitCode": code, "output": output.metadata(), "teardownRequired": code is None}
    finally:
        output.close()


def probe(root, env, *, cancel=False):
    b = components().B
    report = {"scope": "native-linux14-signed15-discovery-confirmation-capture-only", **FALSE_GATES,
              "phase": "verify", "workers": [], "testSource": env["GITHUB_SHA"], "productSource": b.SOURCE,
              "dialogContractCaptured": False, "labSignedDiscoveryObserved": False}
    if cancel:
        report["scope"] = "native-linux14-signed15-discovery-confirmation-cancel-without-views"
    child = capture = feed = feed_capture = None
    failure = None
    lab = Path(env["RUNNER_TEMP"]) / "creator-linux-update-lab"
    try:
        report["package"] = b.verify_stage(root, full=True)
        report["systemWebKit"] = b.system_webkit_provenance(root)
        for name in ("home", "home/config", "home/data", "home/cache", "tmp"):
            (root / name).mkdir(mode=0o700)
        key, cert, report["ephemeralTrust"] = prepare_tls(root, lab)
        feed, feed_capture, proxy, report["nodeImage"] = start_feed(root, lab, env, key, cert)
        environment = child_environment(env, root, proxy)
        require(re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", environment.get("DISPLAY", ""))
                and environment.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:"), "Private X11/dbus required")
        helper = b.load_helper()
        executable = b.paths(root)["creator-hub"]
        report["phase"] = "launch14"
        child = subprocess.Popen([str(executable)], env=environment, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        capture = b.Capture(child, root, "root")
        start = b.check_process(child, None, executable, helper)
        found = b.run_worker(root, environment, "discover", child.pid, start, 1, capture, report["workers"])
        xid = found["window"]
        identity = b.native_process(child.pid, helper)
        require(identity["parentPid"] == os.getpid() and identity["uids"] == [os.getuid()] * 4, "Root direct-child/UID binding differs")
        b.save_json(root / "root-ownership.json", {"root": identity, "window": xid, "xres": found["properties"], "systemWebKit": report["systemWebKit"]})
        report["root"] = identity
        report["snapshot"] = b.run_worker(root, environment, "snapshot", child.pid, start, xid, capture, report["workers"])
        b.accept_terms(root, environment, child, start, xid, capture, report)
        for action in ("check-updates", "ready", "open-confirmation", "capture-confirmation"):
            report["phase"] = action
            report[action] = call(root, environment, action, child, start, xid, capture, report)
        report["dialogContractCaptured"] = report["capture-confirmation"]["dialogContractCaptured"]
        report["installedAfterCapture"] = b.installed_state(root, "installed-after-capture")
        require(report["installedAfterCapture"] == "creator-hub\t0.1.14\tamd64\tinstalled\n", "Installed14 changed without approval")
        report["installedImageAfterCapture"] = b.pinned(executable, b.INSTALLED_HUB_PIN, 0o755)
        require(b.native_process(child.pid, helper) == identity and child.poll() is None, "Root changed/exited during capture")
        report["phase"] = "stopped-before-native-confirmation-input"
        if cancel:
            acknowledgement = b.file_record(root / "home/data/CreatorHub/consent/hub-usage-terms.json", 16384)
            for action in ("cancel-confirmation", "cancelled"):
                report["phase"] = action
                report[action] = call(root, environment, action, child, start, xid, capture, report)
            report["installedAfterCancel"] = b.installed_state(root, "installed-after-cancel")
            report["imageAfterCancel"] = b.pinned(executable, b.INSTALLED_HUB_PIN, 0o755)
            require(b.file_record(root / "home/data/CreatorHub/consent/hub-usage-terms.json", 16384) == acknowledgement,
                    "Saved acknowledgement changed during cancellation")
            require(b.native_process(child.pid, helper) == identity and child.poll() is None, "Root restarted/exited after cancellation")
            report["confirmationCancelTestedWithoutViews"] = True
            report["close"] = b.run_worker(root, environment, "close", child.pid, start, xid, capture, report["workers"])
            child.wait(timeout=10)
            require(child.returncode == 0, "Root did not close normally after cancellation")
            report["normalCloseAfterCancel"] = True
            report["phase"] = "native-confirmation-cancelled-no-install"
    except Exception as error:
        failure = error
        report["error"] = str(error)[:1000]
    finally:
        if feed is not None:
            try:
                report["labShutdown"] = stop_feed(feed, feed_capture)
                require(report["labShutdown"]["exitCode"] == 0, "Lab child did not shut down normally; session teardown required")
                transport = b.unique_json(b.bounded_read(lab / "transport-report.json", 16384))
                require(transport["publicDiscovery"] is transport["signedUpdateAccepted"] is transport["releaseReady"] is False,
                        "Lab transport scope differs")
                served = {(r["host"], r["path"]) for r in transport["requests"]}
                prefix = "/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/"
                required = {("api.github.com", "/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10"),
                            ("github.com", prefix + DESCRIPTOR), ("github.com", prefix + DESCRIPTOR + ".minisig")}
                require(required <= served and ("github.com", prefix + "latest.json") not in served, "Discovery route evidence incomplete or confirmation bypassed")
                report["transport"] = transport
                report["labSignedDiscoveryObserved"] = bool(report["dialogContractCaptured"] and report.get("ready"))
            except Exception as error:
                report["transportRefusal"] = str(error)[:1000]
                failure = failure or error
        if capture is not None:
            capture.pump()
            report["rootOutput"] = capture.metadata()
            capture.close()
        report["rootExitCode"] = None if child is None else child.poll()
        report["disposableSessionTeardownRequired"] = child is not None and child.poll() is None
        b.save_json(root / "discovery-report.json", report)
    require(failure is None, "Discovery/capture stopped; original refusal retained")
    return report


def main():
    admission(os.environ, sys.platform, platform.machine())
    b = components().B
    args = sys.argv[1:]
    temp = b.ordinary(os.environ["RUNNER_TEMP"])
    if args == ["pins"]:
        print(json.dumps(candidate_pins()))
        return
    if args == ["stage"]:
        b.stage(temp)
        result = stage_target(temp)
    elif args == ["install14"]:
        result = b.install(temp / "linux-root-probe")
    elif args == ["probe"]:
        result = probe(temp / "linux-root-probe", os.environ)
    elif args == ["cancel-probe"]:
        result = probe(temp / "linux-root-probe", os.environ, cancel=True)
    elif len(args) == 5 and args[0] == "worker":
        result = worker(temp / "linux-root-probe", args[1:])
    else:
        raise RuntimeError("Use pins, stage, install14, probe, cancel-probe or fixed internal worker")
    encoded = json.dumps(result, ensure_ascii=True)
    require(len(encoded.encode("ascii")) <= b.MAX_JSON, "Bounded worker/report output required")
    print(encoded)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # TLS control never appears in an exception or report. UI/source/native
        # refusal details are bounded and saved in the owned capture directory.
        print(json.dumps({"error": type(error).__name__, "captureStopped": True, **FALSE_GATES}))
        sys.exit(1)
