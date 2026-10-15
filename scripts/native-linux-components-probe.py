"""Disposable, pinned DEB component UI experiment; not migration acceptance.

Reuse the reviewed Root/XRes/direct-WebKit binding and captured Setup GTK contract.
All inputs below are fixed source controls, never caller-supplied UI selectors.
The native consent helper retains its strict single-process GTK dialog policy.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT_SHA = "d2848cd8110015982b9becee81aa259e333e6e0a9878bb152e2ae015f1e282f6"
SCOPE = "pinned-native-deb-embedded-components-only"
FALSE_GATES = {key: False for key in ("releaseReady", "migrationAccepted", "retirementAccepted",
                                    "signedUpdateAccepted", "flatpakHostIntegrationAccepted",
                                    "aiConnectionAccepted", "unityProjectAccepted")}
APPS = {
    "setup": {"hash": "35bef3b90848f64748da5bc9a5a7a632bac75b9c4a4e65f6eb78c8ee1c07729b",
              "size": 20868880, "title": "Open Setup in Creator Hub?", "approve": "Open in Hub",
              "view": "View Creator Project Setup", "version": "Setup 0.3.7"},
    "mcp": {"hash": "30da4a6adbbce992ebaad1d4589628016ca31d5e49cd62090bdd12537c00095f",
            "size": 17328424, "title": "Open MCP in Creator Hub?", "approve": "Enable MCP controls",
            "view": "View Creator Works MCP", "version": "MCP 2.7.7"},
}
RECIPE = "Approved recipe: Unity 6000.3.21f1 \u00b7 Creator SDK 4.0.14 \u00b7 URP 17.3.0 \u00b7 Input 1.20.0"
CONTROLS = {
    "skip-migration": ("Continue for now", "Move to unified Creator Hub"),
    "view-setup": (APPS["setup"]["view"], None),
    "view-mcp": (APPS["mcp"]["view"], None),
    "retry": ("Retry opening", None),
    "requirements": ("Check requirements again", RECIPE),
    "save-guide": ("Use existing controls", "Connect your AI to Unity"),
}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def load_root():
    path = HERE / "native-linux-root-probe.py"
    require(hashlib.sha256(path.read_bytes()).hexdigest() == ROOT_SHA, "Reviewed Root helper bytes changed")
    spec = importlib.util.spec_from_file_location("components_reviewed_root", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


B = load_root()


def configure_component_candidate(name):
    selected = B.configure_candidate(name)
    for app, (size, digest) in B.COMPONENT_PINS.items():
        APPS[app] = {**APPS[app], "hash": digest, "size": size}
    return {**selected, "helperSha256": ROOT_SHA}


def admission(env, system, machine):
    B.admission(env, system, machine)
    require(env.get("CREATOR_LINUX_COMPONENTS_PROBE") == "1", "Components opt-in required")


def manifest_pins(root):
    manifest = B.unique_json(B.bounded_read(B.input_path(root, "builtin-manifest.json"), 65536))
    for app, pin in APPS.items():
        module = manifest["modules"][app]
        require(module["files"][module["executable"]] == pin["hash"]
                and manifest["payloadArchive"]["files"][module["executable"]] == {"size": pin["size"], "mode": 0o755},
                "Reviewed component manifest identity differs: " + app)
    return manifest


def own_tree(window, owner, atspi):
    """Contained semantic parents, not strict reverse GetChildren equality.

    WebKit's live semantic Parent may skip a GetChildren container (measured in
    38639092559). Every Parent must still occur inside this same bound frame.
    Fixed controls below require two full walks and the same canonical wire ID.
    """
    helper, req = owner.helper, owner.request
    require(window.get_process_id() == req.pid and window.get_role() == atspi.Role.FRAME
            and window.get_name() == req.title, "Foreign component AX frame refused")
    reference = owner.references.identity(window, owner)
    require(reference == owner.references.window, "Component AX frame wire identity changed")
    nodes, seen, parents, pending = [], set(), [], [(window, 0)]
    owner.recheck(full=True)
    while pending:
        node, depth = pending.pop()
        require(node is not None and len(nodes) < helper.MAX_NODES and depth < helper.MAX_DEPTH,
                "Component AX subtree exceeds reviewed bounds")
        owner.node(node)
        key = tuple(owner.references.identity(node, owner))
        require(key not in seen, "Duplicate/cyclic component AX reference")
        seen.add(key)
        if depth:
            require(node.get_role() not in (atspi.Role.FRAME, atspi.Role.WINDOW, atspi.Role.APPLICATION),
                    "Nested/foreign AX window refused")
            node.clear_cache()
            parent = node.get_parent()
            require(parent is not None, "Component AX parent absent")
            owner.node(parent)
            parents.append(tuple(owner.references.identity(parent, owner)))
        nodes.append(node)
        budget = min(helper.MAX_CHILDREN, helper.MAX_NODES - len(nodes) - len(pending))
        pending.extend((child, depth + 1) for child in reversed(helper.children(node, budget)))
    require(all(parent in seen for parent in parents), "Component AX parent escaped bound subtree")
    owner.recheck(full=True)
    require(owner.same_node(helper.select_window(req, atspi), window), "Component Root frame changed")
    return nodes


def visible(nodes, atspi):
    return [node for node in nodes if node.get_state_set().contains(atspi.StateType.SHOWING)]


def readable_text_role(node, atspi):
    role = node.get_role()
    roles = {getattr(atspi.Role, key, -1) for key in ("PARAGRAPH", "TEXT", "STATIC", "LABEL")}
    if role in roles:
        return True
    # The already image/package-bound WebKit 2.50.4 omits Footer in its enum,
    # sending Paragraph=72 where libatspi calls 72 Footer and 73 Paragraph.
    # https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityAtspiEnums.h
    if role != 72 or B.WEBKIT_VERSION != "2.50.4-0ubuntu0.22.04.1":
        return False
    editable = getattr(atspi.StateType, "EDITABLE", None)
    if editable is None or node.get_state_set().contains(editable):
        return False
    attributes = node.get_attributes()
    return isinstance(attributes, dict) and attributes.get("tag") == "p" \
        and attributes.get("computed-role") == "paragraph" and attributes.get("toolkit") == "WebKitGTK"


def node_text(node, atspi):
    # Paragraph names are empty in the captured WebKit tree. This is a read,
    # never EditableText. https://docs.gtk.org/atspi2/method.Text.get_text.html
    if not node.get_state_set().contains(atspi.StateType.SHOWING) or not readable_text_role(node, atspi):
        return ""
    interface = node.get_text_iface()
    if interface is None:
        return ""
    count = interface.get_character_count()
    require(type(count) is int and 0 <= count <= 2048, "Owned UI text exceeds character bound")
    text = interface.get_text(0, count)
    require(isinstance(text, str) and len(text) <= count and len(text.encode("utf8")) <= 8192
            and interface.get_character_count() == count, "Owned UI text changed or exceeded byte bound")
    return text


def ui_snapshot(nodes, owner, atspi):
    result = {"actionCount": 0, "ownership": owner.evidence(), "nodes": [
        {"name": (n.get_name() or "")[:512], "text": node_text(n, atspi), "pid": n.get_process_id(), "role": int(n.get_role()),
         **{key.lower(): n.get_state_set().contains(getattr(atspi.StateType, key))
            for key in ("SHOWING", "ENABLED", "SENSITIVE", "BUSY", "DEFUNCT")}} for n in nodes],
        "controls": B.control_metadata(nodes, owner.helper, atspi)}
    require(sum(len(n["text"].encode("utf8")) for n in result["nodes"]) <= 16384, "Owned UI text aggregate exceeds bound")
    owner.recheck(full=True)
    return result


def text_interface_observation(nodes, owner, atspi):
    """Failure-only interface evidence; never an alternative readiness result."""
    result = {"readOnly": True, "authorization": False, "actionCount": 0, "verified": False,
              "timing": "post-failure-not-original-trace", "nodes": []}
    deadline = time.monotonic() + 5
    text_roles = {getattr(atspi.Role, key, -1) for key in ("PARAGRAPH", "TEXT", "STATIC", "LABEL")}
    diagnostic_roles = text_roles | {getattr(atspi.Role, key, -1) for key in
                                    ("SECTION", "HEADING", "PANEL", "STATUS_BAR")}

    def budget():
        require(time.monotonic() < deadline, "Read-only interface diagnostic budget exhausted")

    try:
        require(0 < len(nodes) <= 64, "Read-only interface node bound exceeded")
        owner.recheck(full=True)
        result["ownership"] = owner.evidence()
        indices = {}
        for index, node in enumerate(nodes):
            budget()
            owner.node(node)
            reference = tuple(owner.references.identity(node, owner))
            require(reference not in indices, "Duplicate diagnostic AX reference")
            indices[reference] = index
        for index, node in enumerate(nodes):
            def read(getter):
                budget()
                owner.node(node)
                return getter()

            record = {"index": index, "reference": list(owner.references.identity(node, owner)),
                      "pid": read(node.get_process_id), "role": int(read(node.get_role)),
                      "name": (read(node.get_name) or "")[:512]}
            record["states"] = {key.lower(): read(node.get_state_set).contains(getattr(atspi.StateType, key))
                                for key in ("SHOWING", "ENABLED", "SENSITIVE", "BUSY", "DEFUNCT", "EDITABLE")
                                if hasattr(atspi.StateType, key)}
            record["readinessTextRole"] = read(lambda: readable_text_role(node, atspi))
            result["nodes"].append(record)
            # Interface getters are read-only. Hyperlinks are counted, never
            # followed: child references must already belong to own_tree.
            # https://docs.gtk.org/atspi2/method.Accessible.get_interfaces.html
            for kind in ("interfaces", "attributes", "text", "hypertext", "children"):
                budget()
                detail = record[kind] = {}
                try:
                    if kind == "interfaces":
                        names = read(node.get_interfaces)
                        require(isinstance(names, (list, tuple)) and len(names) <= 32
                                and all(isinstance(n, str) and len(n.encode("utf8")) <= 64 for n in names),
                                "Diagnostic interface list exceeds bound")
                        detail["names"] = list(names)
                    elif kind == "attributes":
                        attributes = read(node.get_attributes)
                        require(isinstance(attributes, dict) and len(attributes) <= 32
                                and all(isinstance(k, str) and isinstance(v, str) and len(k.encode("utf8")) <= 128
                                        and len(v.encode("utf8")) <= 2048 for k, v in attributes.items())
                                and len(json.dumps(attributes).encode("utf8")) <= 4096,
                                "Diagnostic attributes exceed bound")
                        detail["values"] = attributes
                    elif kind == "text":
                        interface = read(node.get_text_iface)
                        detail["available"] = interface is not None
                        if interface is not None:
                            count = read(interface.get_character_count)
                            detail["characterCount"] = count
                            require(type(count) is int and 0 <= count <= 2048, "Diagnostic text count exceeds bound")
                            if (record["readinessTextRole"] or record["role"] in diagnostic_roles) and record["states"]["showing"] \
                                    and not record["states"].get("editable", False):
                                text = read(lambda: interface.get_text(0, count))
                                require(isinstance(text, str) and len(text) <= count and len(text.encode("utf8")) <= 8192,
                                        "Diagnostic text exceeds bound")
                                detail["value"] = text
                            detail["countAfter"] = read(interface.get_character_count)
                            detail["stable"] = detail["countAfter"] == count
                            require(detail["stable"], "Diagnostic text count changed")
                    elif kind == "hypertext":
                        interface = read(node.get_hypertext_iface)
                        detail["available"] = interface is not None
                        if interface is not None:
                            count = read(interface.get_n_links)
                            detail["linkCount"] = count
                            require(type(count) is int and 0 <= count <= 128, "Diagnostic hyperlink count unknown/oversized")
                    else:
                        count = read(node.get_child_count)
                        detail["count"] = count
                        require(type(count) is int and 0 <= count <= 128, "Diagnostic child count exceeds bound")
                        children = []
                        for child_index in range(count):
                            child = read(lambda: node.get_child_at_index(child_index))
                            owner.node(child)
                            reference = tuple(owner.references.identity(child, owner))
                            require(reference in indices, "Diagnostic child escaped already-owned subtree")
                            children.append(indices[reference])
                        require(len(set(children)) == len(children) and read(node.get_child_count) == count,
                                "Diagnostic child inventory changed/duplicated")
                        detail["indices"] = children
                except Exception as error:
                    detail["errorType"] = type(error).__name__[:64]
            if len(json.dumps(result).encode("utf8")) > 32768:
                result["nodes"].pop()
                raise RuntimeError("Read-only interface diagnostic output bound exceeded")
        owner.recheck(full=True)
        result["verified"] = all(not any("errorType" in record[key] for key in
                                 ("interfaces", "attributes", "text", "hypertext", "children"))
                                 for record in result["nodes"])
    except Exception as error:
        result["captureRefusal"] = {"errorType": type(error).__name__[:64]}
    while len(json.dumps(result).encode("utf8")) > 32768:
        result["verified"] = False
        result["captureRefusal"] = {"errorType": "OutputBound"}
        result["nodes"].pop()
    return result


def fixed_control(nodes, action, owner, atspi):
    require(action in CONTROLS, "Unreviewed component action")
    name, heading = CONTROLS[action]
    shown = visible(nodes, atspi)
    require(heading is None or any(n.get_name() == heading or node_text(n, atspi) == heading for n in shown),
            "Required component context missing: " + str(heading))
    choices = [n for n in shown if n.get_name() == name and n.get_role() == atspi.Role.PUSH_BUTTON]
    require(len(choices) == 1, "Exact unique component button required: " + name)
    node = choices[0]
    owner.helper.ready(node, atspi)
    require(owner.renderer is not None and node.get_process_id() == owner.renderer["pid"],
            "Fixed component control is not in the bound WebKit renderer")
    interface = node.get_action_iface()
    require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "press",
            "Expected single WebKit press action")
    return node, interface


def press(action, owner, atspi):
    window = owner.helper.select_window(owner.request, atspi)
    first, _ = fixed_control(own_tree(window, owner, atspi), action, owner, atspi)
    second, interface = fixed_control(own_tree(window, owner, atspi), action, owner, atspi)
    require(owner.same_node(first, second), "Fixed component button changed before action")
    owner.recheck(full=True)
    try:
        require(interface.do_action(0), "Component native press refused; never retry an uncertain action")
    except Exception as error:
        raise owner.helper.ActionError(str(error)) from error
    return {"action": action, "button": CONTROLS[action][0], "actionCount": 1,
            "ownership": owner.evidence()}


def shown_names(snapshot):
    return [value for n in snapshot["nodes"] if n["showing"] for value in (n["name"], n.get("text", "")) if value]


def ready_snapshot(snapshot, state):
    names = shown_names(snapshot)
    if state == "navigation":
        return "Move to unified Creator Hub" in names or APPS["setup"]["view"] in names
    if state in ("setup-declined", "mcp-declined"):
        label = "Setup" if state.startswith("setup") else "MCP"
        return any("Opening " + label + " in Hub was declined." in name for name in names)
    if state == "setup-ready":
        return APPS["setup"]["version"] in names and RECIPE in names and "linux" in names \
            and "Unity Hub or Unity CLI" in names
    if state == "mcp-ready":
        return APPS["mcp"]["version"] in names and "Connect your AI to Unity" in names \
            and "Use existing controls" in names
    if state == "mcp-saved":
        return APPS["mcp"]["version"] in names and "Connection guide" in names \
            and "Connect your AI to Unity" not in names
    raise RuntimeError("Unreviewed readiness state")


def proc_children(pid, opener=open):
    require(type(pid) is int and 1 < pid < 2**31, "Invalid owned Root PID")
    # children belongs to ONE task, not the process: worker-thread spawns must
    # be inventoried too. Never infer complete absence from this racy API.
    # https://man7.org/linux/man-pages/man5/proc_tid_children.5.html
    tasks = []
    with os.scandir(f"/proc/{pid}/task") as entries:
        for entry in entries:
            require(len(tasks) < 256 and re.fullmatch(r"[1-9][0-9]{0,9}", entry.name)
                    and 1 < int(entry.name) < 2**31 and entry.is_dir(follow_symlinks=False), "Invalid/bounded Root task inventory")
            tasks.append(int(entry.name))
    require(pid in tasks and len(set(tasks)) == len(tasks), "Root leader missing or duplicate task inventory")
    result = set()
    for tid in sorted(tasks):
        try:
            # procfs reports zero st_size; ordinary-file hashing cannot read it.
            with opener(f"/proc/{pid}/task/{tid}/children", "rb") as stream:
                body = stream.read(4097)
        except FileNotFoundError:
            require(tid != pid, "Root leader disappeared during inventory")
            continue
        words = body.split()
        require(len(body) <= 4096 and re.fullmatch(rb"(?:[1-9][0-9]*\s*)*", body) and len(words) <= 32
                and len(set(words)) == len(words), "Ambiguous/oversized Root child inventory")
        children = [int(word) for word in words]
        require(all(1 < child < 2**31 and child != pid for child in children), "Invalid direct-child PID")
        result.update(children)
        require(len(result) <= 32, "Root aggregate child inventory exceeds bound")
    # Inventory only. direct_backend independently rechecks native PPID, UID,
    # start, manifest hash/size and seals before any dialog can be authorized.
    return sorted(result)


def direct_backend(root_record, app, helper, observed=None):
    """Inventory only direct children; a name/receipt is never image authority."""
    found = []
    for pid in proc_children(root_record["pid"]):
        try:
            actual = B.native_process(pid, helper)
        except FileNotFoundError:
            continue
        if observed is not None:
            key = str(actual["pid"]) + ":" + actual["startTime"]
            require(key in observed or len(observed) < 32, "Observed Root child identities exceed bound")
            observed[key] = actual
        if actual["kernelImageSha256"] != APPS[app]["hash"]:
            continue
        require(actual["parentPid"] == root_record["pid"] and actual["uids"] == root_record["uids"],
                "Component direct-parent/UID mismatch")
        with helper.Proc().open_image(pid) as image:
            image_record = image.snapshot()
        require(image_record["sha256"] == APPS[app]["hash"] and image_record["size"] == APPS[app]["size"],
                "Component kernel hash/size differs")
        found.append((actual, image_record))
    require(len(found) <= 1, "Ambiguous exact sealed backend children")
    return found[0] if found else None


def receipt(root_record, actual, image, app):
    require(actual["parentPid"] == root_record["pid"] and actual["uids"] == root_record["uids"]
            and actual["uids"] == [os.getuid()] * 4 and image["seals"] == 15
            and image["sha256"] == actual["kernelImageSha256"] == APPS[app]["hash"]
            and image["size"] == APPS[app]["size"], "Unbound sealed component receipt refused")
    return {"schemaVersion": 1, "kind": "creator-hub-owned-sealed-child",
            "source": {"commit": B.SOURCE, "runId": B.RUN},
            "parent": {"pid": root_record["pid"], "startTime": root_record["startTime"],
                       "executable": root_record["executable"], "sha256": B.INSTALLED_HUB_PIN[1]},
            "child": {"pid": actual["pid"], "startTime": actual["startTime"],
                      "image": {key: image[key] for key in ("device", "inode", "size", "sha256")}
                      | {"requiredSeals": 15}}}


def dialog_window(pid, title, x11):
    matches = [item["window"] for item in owned_windows(pid, x11) if item["title"] == title and item["mapped"]]
    require(len(matches) <= 1, "Ambiguous exact native dialog")
    return matches[0] if matches else None


def owned_windows(pid, x11):
    matches = []
    for xid in B.client_ids(x11):
        claim = x11.property(xid, "_NET_WM_PID")
        if not claim or claim[:2] != (6, 32) or claim[2] != [pid]:
            continue
        info = x11.inspect(xid)
        require(info["pid"] == pid, "Dialog claimed PID differs from native XRes PID")
        matches.append({"window": xid, **info})
    return matches


def backend_ax_observation(request, helper, x11, atspi, binding, root_record, actual):
    """Failure-only read of one native Root/dialog owner, never input authority."""
    result = {"readOnly": True, "authorization": False, "actionCount": 0, "verified": False,
              "timing": "post-strict-snapshot-failure-not-original-trace", "windows": [], "nodes": []}
    try:
        require(request.action == "snapshot" and (request.receipt is not None
                or request.pid == root_record["pid"] and actual == root_record), "Diagnostic requires exact native owner")

        def recheck():
            helper.identity(request, helper.Proc(), binding)
            require(B.native_process(root_record["pid"], helper) == root_record
                    and B.native_process(request.pid, helper) == actual, "Backend/Root changed during AX diagnostic")

        recheck()
        xres = helper.bound_window(request, x11)
        result["xres"] = {"window": request.window, **xres}
        # Until the exact backend application is selected, read only PID metadata.
        apps = [app for app in helper.children(atspi.get_desktop(0), 128) if app.get_process_id() == request.pid]
        result["applicationCount"] = len(apps)
        require(len(apps) <= 1, "Ambiguous backend AX applications; no subtree read")
        pending = []
        if apps:
            for window in helper.children(apps[0], 32):
                require(window.get_process_id() == request.pid, "Foreign backend AX top-level refused")
                index = len(result["windows"])
                result["windows"].append({"pid": request.pid, "role": int(window.get_role()),
                                          "roleName": (window.get_role_name() or "")[:64], "name": (window.get_name() or "")[:256]})
                if request.receipt is None and window.get_role() == getattr(atspi.Role, "FRAME", -1):
                    result["skippedRootFrames"] = result.get("skippedRootFrames", 0) + 1
                    continue
                pending.append((window, 0, index))
        while pending:
            node, depth, index = pending.pop()
            require(node is not None and len(result["nodes"]) < helper.MAX_NODES and depth < helper.MAX_DEPTH,
                    "Backend AX diagnostic tree exceeds bound")
            require(node.get_process_id() == request.pid, "Foreign backend AX diagnostic subtree refused")
            result["nodes"].append({"windowIndex": index, "depth": depth, "pid": request.pid,
                                    "role": int(node.get_role()), "roleName": (node.get_role_name() or "")[:64],
                                    "name": (node.get_name() or "")[:256],
                                    **{s.lower(): node.get_state_set().contains(getattr(atspi.StateType, s))
                                       for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}})
            budget = min(helper.MAX_CHILDREN, helper.MAX_NODES - len(result["nodes"]) - len(pending))
            pending.extend((child, depth + 1, index) for child in reversed(helper.children(node, budget)))
        recheck()
        require(helper.bound_window(request, x11) == xres, "Backend XRes window changed during AX diagnostic")
        result["verified"] = True
        # These are same-PID AX candidates, not a manufactured AX-to-XID match.
        result["axToXidAssociationVerified"] = False
    except Exception as error:
        result["captureRefusal"] = str(error)[:1000]
    return result


def routing_permission(root, request, helper, x11, atspi, root_record, xid):
    args = [str(request.pid), request.start, request.executable, request.sha256, str(xid), "Enable managed MCP routing", "ALERT"]
    base = helper.Request.parse(["snapshot", *args])
    B.save_json(root / "managed-routing-window.json", {"readOnly": True, "authorization": False, "native": root_record,
                                                     "xres": {"window": xid, **helper.bound_window(base, x11)}})
    frame = None
    try:
        frame = x11.frame_rectangle(xid)
        snapshot = helper.Request.parse(["snapshot", *args], gtk_message_info_frame=frame)
        before = helper.perform(snapshot, atspi, helper.Proc(), x11)
        B.save_json(root / "managed-routing-snapshot.json", before)
    except Exception as error:
        B.save_json(root / "managed-routing-ax-refusal.json",
                    {"strictSnapshotError": str(error)[:1000], "nativeFrame": frame, "readOnly": True, "authorization": False,
                     "ax": backend_ax_observation(base, helper, x11, atspi, None, root_record, root_record)})
        raise
    require(B.native_process(request.pid, helper) == root_record, "Root identity changed before routing approval")
    result = helper.perform(helper.Request.parse(["click", *args, "Enable managed routing"], gtk_message_info_frame=frame),
                            atspi, helper.Proc(), x11)
    require(B.native_process(request.pid, helper) == root_record, "Root identity changed during routing approval")
    return {"dialogSnapshot": before, "input": result, "native": root_record}


def consent(root, action, request, helper, x11, atspi, root_record):
    app, choice = action.split("-", 1)
    require(app in APPS and (choice in ("decline", "approve") or action == "setup-capture"), "Unknown native consent action")
    gtk_component = B.SELECTED_CANDIDATE == B.GTK3_CANDIDATE
    role = "ALERT" if gtk_component else "DIALOG"
    deadline, routing, observed, matched = time.monotonic() + 20, None, {}, None
    while time.monotonic() < deadline:
        helper.identity(request, helper.Proc())
        require(B.native_process(request.pid, helper) == root_record, "Root identity changed during consent")
        route_xid = dialog_window(request.pid, "Enable managed MCP routing", x11) if app == "mcp" else None
        if route_xid:
            require(routing is None, "Managed routing dialog repeated; no automatic retry")
            if gtk_component:
                routing = routing_permission(root, request, helper, x11, atspi, root_record, route_xid)
            else:
                route = helper.Request.parse(["click", str(request.pid), request.start, request.executable,
                                              request.sha256, str(route_xid), "Enable managed MCP routing",
                                              "DIALOG", "Enable managed routing"])
                routing = helper.perform(route, atspi, helper.Proc(), x11)
        found = direct_backend(root_record, app, helper, observed)
        if found:
            actual, image = found
            matched = actual
            value = receipt(root_record, actual, image, app)
            pins = [str(request.pid), request.start, request.sha256, APPS[app]["hash"], B.SOURCE, str(B.RUN)]
            parsed = helper.Receipt.parse(value, pins)
            binding = helper.KernelBinding(parsed, helper.Proc())
            try:
                xid = dialog_window(actual["pid"], APPS[app]["title"], x11)
                if xid:
                    uid_before = B.process_uids(actual["pid"])
                    require(uid_before == root_record["uids"], "Native backend UID changed")
                    base_snapshot = helper.Request.sealed(["snapshot", str(xid), APPS[app]["title"], role], parsed)
                    B.save_json(root / (action + "-backend-window.json"),
                                {"readOnly": True, "authorization": False, "actionCount": 0, "receipt": value,
                                 "native": actual, "kernelImage": image, "expectedAxRole": role,
                                 "expectedAxName": "Information" if gtk_component else APPS[app]["title"],
                                 "xres": {"window": xid, **helper.bound_window(base_snapshot, x11)}})
                    frame = None
                    try:
                        frame = x11.frame_rectangle(xid) if gtk_component else None
                        snapshot = helper.Request.sealed(["snapshot", str(xid), APPS[app]["title"], role], parsed,
                                                         gtk_message_info_frame=frame)
                        before = helper.perform(snapshot, atspi, helper.Proc(), x11, binding)
                    except Exception as error:
                        diagnostic = {"strictSnapshotError": str(error)[:1000], "readOnly": True, "authorization": False,
                                      "nativeFrame": frame,
                                      "ax": backend_ax_observation(base_snapshot, helper, x11, atspi, binding, root_record, actual)}
                        try:
                            B.save_json(root / (action + "-backend-ax-refusal.json"), diagnostic)
                        except Exception as retention_error:
                            raise RuntimeError(str(error)[:1000] + "; diagnostic retention failed: "
                                               + type(retention_error).__name__) from error
                        raise
                    if choice == "capture":
                        B.save_json(root / (action + "-backend-ax.json"),
                                    {"readOnly": True, "authorization": False, "strictSnapshot": before,
                                     "ax": backend_ax_observation(snapshot, helper, x11, atspi, binding, root_record, actual)})
                        raise RuntimeError("Capture-only stop before component consent input")
                    args = ["click", str(xid), APPS[app]["title"], role,
                            "Not now" if choice == "decline" else APPS[app]["approve"]]
                    req = helper.Request.sealed(args, parsed, gtk_message_info_frame=frame)
                    require(B.process_uids(actual["pid"]) == uid_before, "Backend UID changed before consent")
                    result = helper.perform(req, atspi, helper.Proc(), x11, binding)
                    B.save_json(root / (action + "-backend.json"), {"receipt": value, "native": actual})
                    return {"app": app, "choice": choice, "native": actual, "receipt": value,
                            "dialogSnapshot": before, "input": result, "routing": routing}
            finally:
                binding.close()
        time.sleep(0.05)
    diagnostics = {"readOnly": True, "authorization": False, "rootChildren": list(observed.values()),
                   "rootWindows": owned_windows(request.pid, x11), "matchedBackend": matched, "routing": routing}
    if matched is not None and helper.Proc().exists(matched["pid"]):
        require(B.native_process(matched["pid"], helper) == matched, "Matched backend changed before diagnostic capture")
        diagnostics["backendWindows"] = owned_windows(matched["pid"], x11)
    B.save_json(root / (action + "-observation.json"), diagnostics)
    raise RuntimeError("Exact native component consent readiness deadline: " + action)


def worker(root, args):
    require(len(args) == 4, "Expected fixed worker action and owned Root PID/start/XID")
    action, pid, start, xid = args
    require(action in CONTROLS or action in ("navigation", "setup-declined", "mcp-declined", "setup-ready",
            "mcp-ready", "mcp-saved", "setup-decline", "setup-approve", "setup-capture", "mcp-decline", "mcp-approve", "failure-snapshot"),
            "Unknown bounded component worker")
    B.verify_stage(root)
    manifest_pins(root)
    helper = B.load_helper()
    request = helper.Request.parse(["snapshot", pid, start, str(B.paths(root)["creator-hub"]),
                                    B.INSTALLED_HUB_PIN[1], xid, B.TITLE, "FRAME"])
    saved = B.unique_json(B.bounded_read(root / "root-ownership.json", 16384))
    require(saved["root"]["parentPid"] == os.getppid() and saved["root"]["uids"] == [os.getuid()] * 4,
            "Worker does not share the Root's owning parent/UID")
    helper.identity(request, helper.Proc())
    require(B.native_process(request.pid, helper) == saved["root"], "Live Root differs from owned binding")
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.set_timeout(3000, 3000)
    x11, bus = helper.X11(), None
    try:
        helper.bound_window(request, x11)
        if action.endswith(("-decline", "-approve")) or action == "setup-capture":
            return consent(root, action, request, helper, x11, Atspi, saved["root"])
        renderer = B.unique_json(B.bounded_read(root / "renderer-ownership.json", 8192))
        refs = B.unique_json(B.bounded_read(root / "ax-ownership.json", 8192))
        references, bus = B.native_ax_references(refs)
        owner = B.RootOwnership(request, helper, x11, saved["root"], saved["xres"],
                                saved["systemWebKit"]["file"], renderer, references=references)
        if action in CONTROLS:
            return press(action, owner, Atspi)
        deadline, last = time.monotonic() + 20, None
        while time.monotonic() < deadline:
            nodes = own_tree(helper.select_window(request, Atspi), owner, Atspi)
            last = ui_snapshot(nodes, owner, Atspi)
            if action == "failure-snapshot":
                B.save_json(root / "failure-ui-snapshot.json", last)
                observation = text_interface_observation(nodes, owner, Atspi)
                B.save_json(root / "failure-text-interfaces.json", observation)
                last["textInterfaceObservation"] = observation
                return last
            if action in ("setup-ready", "mcp-ready", "mcp-saved"):
                alerts = [n["name"] for n in last["nodes"] if n["showing"] and n["name"]
                          and (n["role"] == int(Atspi.Role.ALERT) or n["name"].startswith("Action failed:"))]
                if alerts:
                    B.save_json(root / (action + "-error.json"), last)
                    raise RuntimeError("Actual component UI error: " + json.dumps(alerts)[:1000])
            if ready_snapshot(last, action):
                return last
            time.sleep(0.05)
        require(last is not None, "No owned component tree")
        B.save_json(root / (action + "-unready.json"), last)
        raise RuntimeError("Native component UI readiness deadline: " + action + "; exact tree retained")
    finally:
        if bus is not None:
            bus.close_sync(None)
        x11.dispose()


def call(root, env, action, child, start, xid, capture, report):
    label = "component-" + str(len(report["workers"])) + "-" + action
    begin = time.monotonic()
    worker_child = subprocess.Popen(["/usr/bin/python3", "-B", str(Path(__file__).resolve()), "worker", action,
                                     str(child.pid), start, str(xid)], cwd=root, env=env,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    record = {"action": action, "pid": worker_child.pid, "exitCode": None}
    report["workers"].append(record)
    output = B.Capture(worker_child, root, label)
    try:
        while time.monotonic() < begin + 23:
            output.pump(0.02)
            capture.pump()
            if worker_child.poll() is not None and all(v["eof"] for v in output.items.values()):
                break
        record.update(exitCode=worker_child.poll(), elapsedMs=round((time.monotonic() - begin) * 1000), **output.metadata())
        require(record["exitCode"] is not None, "Component worker deadline; no signal sent; runner teardown required")
        worker_child.wait(timeout=0)
        require(all(v["eof"] and not v["truncated"] for v in output.metadata().values()), "Component worker output incomplete")
        value = B.unique_json(bytes(output.items["stdout"]["kept"]))
        record["result"] = value
        require(record["exitCode"] == 0 and not value.get("error"), "Component worker refused: " + str(value.get("error"))[:1000])
        return value
    finally:
        record["exitCode"] = worker_child.poll()
        output.close()


def fixture(root):
    server = root / "fixture-server.mjs"
    B.write_new(server, b"throw new Error('isolated preference fixture must never execute');\n")
    config = {"channels": [], "active_channel_id": None, "mcp_server_path": str(server), "auto_start": False,
              "tool_groups": "core", "enable_custom_scripts": False, "allow_all_tests": True,
              "automatic_update_checks": False, "componentFixture": "preserve-no-project-no-client"}
    path = root / "home/config/creator-works-mcp/launcher-config.json"
    path.parent.mkdir(mode=0o700)
    B.save_json(path, config)
    setup = root / "home/data/CreatorProjectSetup/editor-roots.json"
    setup.parent.mkdir(mode=0o700)
    B.write_new(setup, b"[]\n")
    return {"config": config, "configFile": B.file_record(path, 16384),
            "server": B.file_record(server, 4096), "setup": B.file_record(setup, 16384)}


def fixture_check(root, before, saved=False):
    config_path = root / "home/config/creator-works-mcp/launcher-config.json"
    current = B.unique_json(B.bounded_read(config_path, 16384))
    expected = dict(before["config"])
    if saved:
        expected["connection_guide_version"] = 1
    require(current == expected, "Preference save changed fields beyond exact connection-guide preference")
    if not saved:
        require(B.file_record(config_path, 16384) == before["configFile"], "Config mutated before explicit native preference save")
    require(B.file_record(root / "fixture-server.mjs", 4096) == before["server"], "Owned custom server fixture changed")
    require(B.file_record(root / "home/data/CreatorProjectSetup/editor-roots.json", 16384) == before["setup"],
            "Setup editor-roots fixture changed")
    for path in ("home/config/banter-mcp", "home/config/Claude", "home/.codex", "home/.claude",
                 "home/config/Antigravity", "home/config/opencode", "home/data/CreatorHub/convergence/review-v1.json"):
        require(not os.path.lexists(root / path), "Unexpected client/legacy/migration fixture mutation: " + path)
    return {"config": B.file_record(config_path, 16384), "setupFixtureRetained": True,
            "customServerRetained": True, "connectionGuideVersion": current.get("connection_guide_version"),
            "migrationSkipped": True, "noClientOrProjectAction": True}


def backend_gone(record, helper):
    if not helper.Proc().exists(record["pid"]):
        return True
    actual = helper.Proc().stat(record["pid"])
    require(helper.parse_start(actual, record["pid"], require_live=False) == record["startTime"],
            "Backend PID reused before exit observation")
    return False


def wait_backend_gone(record, helper, capture):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not backend_gone(record, helper):
        capture.pump(0.02)
    require(backend_gone(record, helper), "Declined backend was not reaped")


def probe(root, env, capture_only=False):
    report = {"scope": SCOPE, **FALSE_GATES, "phase": "verify", "workers": [], "backends": [],
              "candidate": B.SELECTED_CANDIDATE, "productSource": B.SOURCE, "privateSource": B.PRIVATE_SOURCE,
              "productScope": "4f3744d GTK3 baseline; excludes router fix b154e36; not final release acceptance",
              "testSource": env.get("GITHUB_SHA"), "testRunId": env.get("GITHUB_RUN_ID"),
              "componentsAccepted": False, "normalExitVerified": False, "backendExitCodesObserved": False,
              "captureOnly": capture_only}
    child, capture, start, xid, failure = None, None, None, None, None
    helper = B.load_helper()
    try:
        report["package"] = B.verify_stage(root, full=True)
        manifest_pins(root)
        report["systemWebKit"] = B.system_webkit_provenance(root)
        for directory in ("home", "home/config", "home/data", "home/cache", "tmp"):
            (root / directory).mkdir(mode=0o700)
        before = fixture(root)
        report["fixtureBefore"] = before
        env_child = B.child_env(env, root)
        env_child["CREATOR_LINUX_COMPONENTS_PROBE"] = "1"
        require(re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", env_child.get("DISPLAY", ""))
                and env_child.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:"), "Private local display/dbus required")
        executable = B.paths(root)["creator-hub"]
        report["phase"] = "launch"
        child = subprocess.Popen([str(executable)], cwd=root, env=env_child, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        capture = B.Capture(child, root, "root")
        start = B.check_process(child, None, executable, helper)
        found = B.run_worker(root, env_child, "discover", child.pid, start, 1, capture, report["workers"])
        xid = found["window"]
        identity = B.native_process(child.pid, helper)
        require(identity["parentPid"] == os.getpid() and identity["uids"] == [os.getuid()] * 4,
                "Root direct-child/UID binding differs")
        B.save_json(root / "root-ownership.json", {"root": identity, "window": xid,
                                                 "xres": found["properties"], "systemWebKit": report["systemWebKit"]})
        report["root"] = identity
        report["snapshot"] = B.run_worker(root, env_child, "snapshot", child.pid, start, xid, capture, report["workers"])
        B.accept_terms(root, env_child, child, start, xid, capture, report)
        state = call(root, env_child, "navigation", child, start, xid, capture, report)
        if "Move to unified Creator Hub" in shown_names(state):
            report["phase"] = "skip-migration"
            call(root, env_child, "skip-migration", child, start, xid, capture, report)
        report["migrationSkipped"] = True
        fixture_check(root, before)
        if capture_only:
            report["phase"] = "capture-setup"
            call(root, env_child, "view-setup", child, start, xid, capture, report)
            call(root, env_child, "setup-capture", child, start, xid, capture, report)
            raise RuntimeError("Capture-only worker unexpectedly returned; further input refused")
        for app in ("setup", "mcp"):
            report["phase"] = "open-" + app
            call(root, env_child, "view-" + app, child, start, xid, capture, report)
            declined = call(root, env_child, app + "-decline", child, start, xid, capture, report)
            report["backends"].append(declined["native"])
            call(root, env_child, app + "-declined", child, start, xid, capture, report)
            wait_backend_gone(declined["native"], helper, capture)
            fixture_check(root, before)
            report["phase"] = "retry-" + app
            call(root, env_child, "retry", child, start, xid, capture, report)
            approved = call(root, env_child, app + "-approve", child, start, xid, capture, report)
            require(approved["native"]["pid"] != declined["native"]["pid"], "Retry did not create a distinct owned backend")
            report["backends"].append(approved["native"])
            report["phase"] = app + "-operation"
            call(root, env_child, app + "-ready", child, start, xid, capture, report)
            fixture_check(root, before)
            if app == "setup":
                call(root, env_child, "requirements", child, start, xid, capture, report)
                call(root, env_child, "setup-ready", child, start, xid, capture, report)
                report["setupNativeRequirementsVerified"] = True
            else:
                call(root, env_child, "save-guide", child, start, xid, capture, report)
                call(root, env_child, "mcp-saved", child, start, xid, capture, report)
                report["preferenceAfterSave"] = fixture_check(root, before, saved=True)
                report["mcpNativePreferenceVerified"] = True
        report["bitmap"] = B.run_worker(root, env_child, "bitmap", child.pid, start, xid, capture, report["workers"])
        report["phase"] = "normal-close"
        B.normal_close(root, env_child, child, start, xid, capture, report, helper)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not all(backend_gone(n, helper) for n in report["backends"]):
            capture.pump(0.02)
        require(all(backend_gone(n, helper) for n in report["backends"]), "An owned backend remains after normal Root exit")
        report["ownedBackendsAbsentAfterRootExit"] = True
        report["backendExitEvidence"] = "PID/start observed absent; backend exit status is not exported by product wait thread"
        report["retentionAfterExit"] = fixture_check(root, before, saved=True)
        require(B.acknowledgement(root, report["termsAcknowledgement"]["record"]["acceptedAtMs"])
                == report["termsAcknowledgement"], "Native terms acknowledgement changed after component operation")
        report.update(termsAcknowledgementRetainedAfterExit=True, componentsAccepted=True,
                      phase="native-components-preference-and-normal-root-exit")
    except Exception as error:
        failure = error
        report["error"] = str(error)[:1500]
    finally:
        if failure is not None and child is not None and capture is not None and child.poll() is None \
                and report.get("snapshot") and all(w["exitCode"] is not None for w in report["workers"]):
            try:
                report["failureSnapshot"] = call(root, env_child, "failure-snapshot", child, start, xid, capture, report)
            except Exception as diagnostic:
                report["failureSnapshotRefusal"] = str(diagnostic)[:1000]
            if not (root / "root-window.png").exists():
                try:
                    report["failureBitmap"] = B.run_worker(root, env_child, "bitmap", child.pid, start, xid, capture, report["workers"])
                except Exception as diagnostic:
                    report["failureBitmapRefusal"] = str(diagnostic)[:1000]
        if child is not None and capture is not None and child.poll() is None and report.get("snapshot") \
                and not report.get("normalCloseAttempted") and all(w["exitCode"] is not None for w in report["workers"]):
            try:
                B.normal_close(root, env_child, child, start, xid, capture, report, helper)
            except Exception as cleanup:
                report["cleanupRefusal"] = str(cleanup)[:1000]
        if capture is not None:
            capture.pump()
            report["rootOutput"] = capture.metadata()
            capture.close()
        if child is not None:
            report["rootExitCode"] = child.poll()
            report["disposableSessionTeardownRequired"] = child.poll() is None
        B.save_json(root / "components-report.json", report)
    require(failure is None, str(failure))
    return report


def main():
    admission(os.environ, sys.platform, platform.machine())
    selected = configure_component_candidate(os.environ.get("CREATOR_LINUX_ROOT_CANDIDATE", B.GTK3_CANDIDATE))
    require(B.SELECTED_CANDIDATE == B.GTK3_CANDIDATE, "Old component native dispatches are held; reviewed GTK3 assembly required")
    args = sys.argv[1:]
    if args == ["candidate-pins"]:
        print(json.dumps(selected, ensure_ascii=True))
        return
    root = B.ordinary(os.environ["RUNNER_TEMP"]) / "linux-root-probe"
    require(args and (args in (["probe"], ["capture-only"]) or args[0] == "worker"), "Use candidate-pins, probe, capture-only or fixed internal worker")
    result = probe(root, os.environ, capture_only=args == ["capture-only"]) if args[0] != "worker" else worker(root, args[1:])
    body = json.dumps(result, ensure_ascii=True)
    require(len(body.encode()) <= (B.MAX_JSON if args[0] == "worker" else 1048576), "Component output exceeds bounds")
    print(body if args[0] == "worker" else json.dumps({"phase": result["phase"], **FALSE_GATES}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)[:1500], **FALSE_GATES}))
        sys.exit(1)
