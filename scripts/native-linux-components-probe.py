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
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT_SHA = "91983346c5bac811028135b41c11a0dfc10e40a61c9f65aab535df326e354e72"
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
COMPONENT_ORDER = ("mcp", "setup")
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


class TreeRefusal(RuntimeError):
    def __init__(self, observation):
        super().__init__("Component AX parent escaped bound subtree")
        self.observation = observation


TREE_METADATA_VALUES = {
    "tag": frozenset("a abbr address article aside b blockquote body br button caption code col colgroup "
                     "dd details dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 "
                     "head header hgroup hr html i iframe img input label legend li main menu nav ol optgroup "
                     "option p pre progress section select small span strong summary table tbody td textarea "
                     "tfoot th thead time tr ul video".split()),
    "computed-role": frozenset("alert alertdialog application article banner blockquote button caption cell "
                               "checkbox code columnheader combobox complementary contentinfo definition "
                               "deletion dialog directory document emphasis feed figure form generic grid "
                               "gridcell group heading img insertion link list listbox listitem log main "
                               "marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter "
                               "navigation none note option paragraph presentation progressbar radio "
                               "radiogroup region row rowgroup rowheader scrollbar search searchbox "
                               "section separator slider spinbutton status strong subscript superscript "
                               "switch tab table tablist tabpanel term textbox time timer toolbar tooltip "
                               "tree treegrid treeitem".split()),
    "toolkit": frozenset(("WebKitGTK", "gtk", "Gtk", "GTK")),
}


def tree_refusal_metadata(missing, collected):
    """Only GetChildren endpoints already collected by the original refusing walk."""
    records, selected = [], set()
    for edge in missing[:8]:
        for endpoint in ("node", "getChildrenParent"):
            reference = tuple(edge[endpoint])
            if reference not in collected or reference in selected:
                continue
            selected.add(reference)
            node = collected[reference]
            record = {"reference": list(reference)}
            for field, getter in (("role", "get_role"), ("childCount", "get_child_count"),
                                  ("attributes", "get_attributes")):
                try:
                    value = getattr(node, getter)()
                    if field == "role":
                        if not isinstance(value, int) or isinstance(value, bool):
                            raise TypeError()
                        if not 0 <= value <= 0xffffffff:
                            raise ValueError()
                        value = int(value)
                    elif field == "childCount":
                        if type(value) is not int:
                            raise TypeError()
                        if not 0 <= value <= 128:
                            raise ValueError()
                    else:
                        if type(value) is not dict:
                            raise TypeError()
                        if len(value) > 32:
                            raise ValueError()
                        allowed = {}
                        for key, vocabulary in TREE_METADATA_VALUES.items():
                            if key not in value:
                                continue
                            item = value[key]
                            if type(item) is not str:
                                raise TypeError()
                            if len(item) > 64 or len(item.encode("utf8")) > 64 or item not in vocabulary:
                                raise ValueError()
                            allowed[key] = item
                        value = allowed
                    record[field] = value
                except Exception as error:
                    record.setdefault("errors", {})[field] = {"errorType": type(error).__name__[:64]}
            records.append(record)
    return records


def retain_tree_refusal(root, action, error):
    try:
        B.save_json(root / (action + "-tree-refusal.json"), error.observation)
    except Exception as capture_error:
        print(json.dumps({"treeCaptureRefusal": type(capture_error).__name__[:64]}), file=sys.stderr)


def failure_site(error):
    """Original Python call sites only; never locals, source lines or remote text."""
    allowed = {str(HERE / name): name for name in (
        "native-linux-components-probe.py", "native-linux-root-probe.py", "native-unix-window.py")}
    frames, count, cursor = [], 0, error.__traceback__
    while cursor is not None and count < 64:
        code = cursor.tb_frame.f_code
        if code.co_filename in allowed:
            name = code.co_name
            frames.append({"file": allowed[code.co_filename], "function": name[:80]
                           if re.fullmatch(r"[A-Za-z0-9_<>]+", name) else "unknown",
                           "line": cursor.tb_lineno})
        count += 1
        cursor = cursor.tb_next
    return {"readOnly": True, "authorization": False, "actionCount": 0,
            "timing": "original-exception-not-a-retry", "errorType": type(error).__name__[:64],
            "frames": frames[-12:], "truncated": cursor is not None or len(frames) > 12}


def retain_failure_site(root, action, error):
    try:
        B.save_json(root / (action + "-failure-site.json"), failure_site(error))
    except Exception as capture_error:
        print(json.dumps({"failureSiteCaptureRefusal": type(capture_error).__name__[:64]}), file=sys.stderr)


def source_heading_observation(collected, roles, owner, atspi):
    """Missing-heading evidence only; never a context/role fallback.

    WebKitGTK 2.50.4 AccessibilityObjectAtspi::attributes exposes the HTML id
    as "id". Compare the fixed source id; never retain arbitrary ids or text.
    """
    require(type(collected) is dict and 0 < len(collected) <= 512 and roles.keys() == collected.keys(),
            "Source-heading inventory exceeds original bounds")
    result = {"readOnly": True, "authorization": False, "actionCount": 0, "nativeAcceptance": False,
              "expectedId": "connection-guide-title", "expectedButtonId": "connection-guide-skip",
              "inspectedCount": 0, "attributesReadCount": 0, "namesReadCount": 0,
              "idMatchCount": 0, "buttonIdMatchCount": 0, "nameMatchCount": 0,
              "candidateCount": 0, "candidates": [], "candidatesTruncated": False,
              "errorCount": 0, "errors": [], "errorsTruncated": False}
    for reference, node in collected.items():
        record = {"reference": list(reference), "role": int(roles[reference]),
                  "roleEqualsHeading": roles[reference] == atspi.Role.HEADING}

        def failed(field, error):
            error_type = type(error).__name__[:64]
            record.setdefault("errors", {})[field] = {"errorType": error_type}
            result["errorCount"] += 1
            if len(result["errors"]) < 8:
                result["errors"].append({"reference": list(reference), "field": field, "errorType": error_type})
            else:
                result["errorsTruncated"] = True

        try:
            owner.node(node)
            require(tuple(owner.references.identity(node, owner)) == reference and node.get_role() == roles[reference],
                    "Heading observation wire ID/role changed")
            result["inspectedCount"] += 1
        except Exception as error:
            failed("binding", error)
            continue
        try:
            name = node.get_name()
            if type(name) is not str:
                raise TypeError()
            if len(name) > 128 or len(name.encode("utf8")) > 512:
                raise ValueError()
            record["nameEqualsSourceHeading"] = name == CONTROLS["save-guide"][1]
            record["nameEqualsFixedButton"] = name == CONTROLS["save-guide"][0]
            result["nameMatchCount"] += int(record["nameEqualsSourceHeading"])
            result["namesReadCount"] += 1
        except Exception as error:
            failed("name", error)
        try:
            attributes = node.get_attributes()
            if type(attributes) is not dict:
                raise TypeError()
            if len(attributes) > 32:
                raise ValueError()
            html_id = attributes.get("id", "")
            if type(html_id) is not str:
                raise TypeError()
            if len(html_id) > 128 or len(html_id.encode("utf8")) > 128:
                raise ValueError()
            record["idEqualsSourceHeading"] = html_id == result["expectedId"]
            record["idEqualsFixedButton"] = html_id == result["expectedButtonId"]
            result["idMatchCount"] += int(record["idEqualsSourceHeading"])
            result["buttonIdMatchCount"] += int(record["idEqualsFixedButton"])
            allowed = {}
            for key, vocabulary in TREE_METADATA_VALUES.items():
                if key not in attributes:
                    continue
                value = attributes[key]
                if type(value) is not str:
                    raise TypeError()
                if len(value) > 64 or len(value.encode("utf8")) > 64 or value not in vocabulary:
                    raise ValueError()
                allowed[key] = value
            record["attributes"] = allowed
            result["attributesReadCount"] += 1
        except Exception as error:
            failed("attributes", error)
        allowed = record.get("attributes", {})
        # Evidence rows never satisfy context by themselves. The read-only hit
        # test separately checks the full pinned-producer heading contract.
        if (record.get("idEqualsSourceHeading") or record.get("idEqualsFixedButton")
                or record.get("nameEqualsSourceHeading") or record.get("nameEqualsFixedButton")
                or record["roleEqualsHeading"] or allowed.get("tag") == "h2"
                or allowed.get("computed-role") == "heading"):
            result["candidateCount"] += 1
            if len(result["candidates"]) < 8:
                result["candidates"].append(record)
            else:
                result["candidatesTruncated"] = True
    result["complete"] = result["errorCount"] == 0
    return result


def fixed_control_hit_test(window, collected, owner, atspi):
    """Read-only save-guide evidence from the original GetChildren inventory.

    No semantic Parent, new tree walk, action interface or readiness fallback.
    https://docs.gtk.org/atspi2/method.Component.get_accessible_at_point.html
    https://docs.gtk.org/atspi2/method.Component.get_extents.html
    """
    result = {"readOnly": True, "authorization": False, "actionCount": 0,
              "nativeAcceptance": False, "verified": False, "control": "save-guide",
              "timing": "original-refusing-walk-not-a-retry", "hitPath": []}
    stage = "binding"
    try:
        helper, req = owner.helper, owner.request
        owner.recheck(full=True)
        require(type(collected) is dict and 0 < len(collected) <= min(512, helper.MAX_NODES),
                "Hit-test inventory exceeds bound")
        frame_ref = tuple(owner.references.identity(window, owner))
        require(list(frame_ref) == owner.references.window and collected.get(frame_ref) is window
                and window.get_process_id() == req.pid and window.get_role() == atspi.Role.FRAME,
                "Hit-test frame differs from bound Root")
        roles = {}
        for reference, node in collected.items():
            owner.node(node)
            require(tuple(owner.references.identity(node, owner)) == reference, "Collected wire ID changed")
            role = node.get_role()
            require(isinstance(role, int) and not isinstance(role, bool) and 0 <= role <= 0xffffffff,
                    "Collected numeric role unavailable/oversized")
            require(reference == frame_ref or role not in
                    (atspi.Role.FRAME, atspi.Role.WINDOW, atspi.Role.APPLICATION), "Nested AX window refused")
            roles[reference] = role
        require(owner.renderer is not None, "Bound renderer absent")
        result.update(collectedCount=len(collected), frameReference=list(frame_ref),
                      rootPid=req.pid, rendererPid=owner.renderer["pid"], xid=req.window)

        def shown(node):
            states = node.get_state_set()
            require(all(states.contains(getattr(atspi.StateType, state)) for state in ("VISIBLE", "SHOWING"))
                    and not states.contains(atspi.StateType.DEFUNCT), "Component not visible and showing")

        def fixed_name(node):
            value = node.get_name()
            require(type(value) is str and len(value) <= 128, "Fixed-control name unavailable/oversized")
            return value

        stage = "fixed-controls"
        name, heading = CONTROLS["save-guide"]

        def heading_matches(reference, node):
            role = roles[reference]
            if role not in (atspi.Role.HEADING, 82) or fixed_name(node) != heading:
                return False
            if role == atspi.Role.HEADING:
                return True
            # This producer omits Footer, so Heading=82; libatspi Heading=83.
            # Its GetRole sends role() as uint32 without translating the enum.
            # WebKit/webkitgtk-2.50.4: AccessibilityAtspiEnums.h and
            # AccessibilityObjectAtspi.cpp (GetRole/role). Not a global offset.
            renderer = owner.renderer
            if (B.WEBKIT_VERSION != "2.50.4-0ubuntu0.22.04.1" or renderer is None
                    or renderer["kernelImageSha256"] != B.WEBKIT_SHA or renderer["executable"] != B.WEBKIT
                    or owner.system_file.get("sha256") != B.WEBKIT_SHA
                    or node.get_process_id() != renderer["pid"]):
                return False
            owner.recheck(full=True)
            owner.node(node)
            require(tuple(owner.references.identity(node, owner)) == reference, "Diagnostic heading wire ID changed")
            attributes = node.get_attributes()
            expected = {"id": "connection-guide-title", "tag": "h2", "computed-role": "heading", "toolkit": "WebKitGTK"}
            return (type(attributes) is dict and len(attributes) <= 32
                    and all(type(attributes.get(key)) is str and attributes[key] == value for key, value in expected.items()))

        candidates, headings = [], []
        # Only the source button/heading roles are inspected; no returned names
        # or arbitrary UI text are retained in this diagnostic.
        for reference, node in collected.items():
            if roles[reference] == atspi.Role.PUSH_BUTTON and fixed_name(node) == name:
                candidates.append(reference)
            elif heading_matches(reference, node):
                headings.append(reference)
        result.update(candidateCount=len(candidates), headingCount=len(headings))
        if not headings:
            try:
                result["sourceHeadingObservation"] = source_heading_observation(collected, roles, owner, atspi)
            except Exception as error:
                result["sourceHeadingCaptureRefusal"] = {"errorType": type(error).__name__[:64]}
        require(len(candidates) == len(headings) == 1, "Exact unique source button/heading required")
        target_ref, heading_ref = candidates[0], headings[0]
        target, source_heading = collected[target_ref], collected[heading_ref]
        result.update(headingReference=list(heading_ref), headingRole=int(roles[heading_ref]),
                      clientHeadingRole=int(atspi.Role.HEADING), headingComparison="native-Atspi"
                      if roles[heading_ref] == atspi.Role.HEADING else "pinned-WebKitGTK-2.50.4-exact-DOM")
        require(target.get_process_id() == source_heading.get_process_id() == owner.renderer["pid"],
                "Source controls are not in the bound renderer")
        shown(source_heading)
        result["targetReference"] = list(target_ref)

        stage = "geometry"
        native_rect = B.visible_rectangle(req, helper, owner.x11)
        require(type(native_rect) is tuple and len(native_rect) == 4
                and all(type(v) is int and 0 <= v <= 0x7fffffff for v in native_rect)
                and 0 < native_rect[2] <= 1920 and 0 < native_rect[3] <= 1080,
                "Native rectangle unavailable/oversized")
        result["nativeRectangle"] = list(native_rect)

        def inside(inner, outer):
            return (outer[0] <= inner[0] and outer[1] <= inner[1]
                    and inner[0] + inner[2] <= outer[0] + outer[2]
                    and inner[1] + inner[3] <= outer[1] + outer[3])

        # GTK's AX Frame includes WM decorations; content controls do not.
        # Use the existing exact-XID _NET_FRAME_EXTENTS reader, never padding.
        owner.recheck(full=True)
        native_frame = owner.x11.frame_rectangle(req.window)
        owner.recheck(full=True)
        require(type(native_frame) is tuple and len(native_frame) == 4
                and all(type(v) is int and 0 <= v <= 0x7fffffff for v in native_frame)
                and 0 < native_frame[2] <= 1920 and 0 < native_frame[3] <= 1080
                and inside(native_rect, native_frame), "Native frame unavailable/oversized or excludes client")
        result["nativeFrameRectangle"] = list(native_frame)

        def geometry(node, field, bounds=native_rect):
            shown(node)
            component = node.get_component_iface()
            require(component is not None, "Component interface absent")
            extents = component.get_extents(atspi.CoordType.SCREEN)
            rect = (extents.x, extents.y, extents.width, extents.height)
            require(all(type(v) is int and -0x80000000 <= v <= 0x7fffffff for v in rect),
                    "Component rectangle type/range exceeds bound")
            result[field] = list(rect)
            require(0 < rect[2] <= 1920 and 0 < rect[3] <= 1080 and inside(rect, bounds),
                    "Component rectangle escapes native window")
            return component, rect

        frame_component, frame_rect = geometry(window, "frameRectangle", native_frame)
        require(frame_rect == native_frame, "AX Frame differs from exact native WM frame")
        _target_component, target_rect = geometry(target, "controlRectangle")
        _heading_component, heading_rect = geometry(source_heading, "headingRectangle")
        require(inside(target_rect, frame_rect), "Control rectangle escapes AX frame")
        point = (target_rect[0] + target_rect[2] // 2, target_rect[1] + target_rect[3] // 2)
        result["point"] = list(point)

        stage = "hit-test"
        current_ref, component = frame_ref, frame_component
        visited = {frame_ref}
        result["hitPath"].append(list(frame_ref))
        while current_ref != target_ref:
            if len(visited) >= 32:
                result["hitRefusal"] = "ObjectBound"
                raise RuntimeError()
            hit = component.get_accessible_at_point(*point, atspi.CoordType.SCREEN)
            if hit is None:
                result["hitRefusal"] = "NoChild"
                raise RuntimeError()
            # Read reference fields only. Do not query PID/role/component on an
            # unknown hit, resolve new aliases, or follow its children/parents.
            bus_name, path = hit.app.bus_name, hit.path
            require(type(bus_name) is str and len(bus_name) <= 255 and type(path) is str and len(path) <= 256,
                    "Hit reference exceeds wire bound")
            require(re.fullmatch(r"/org/a11y/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+", path), "Invalid AX hit path")
            peer = owner.references.aliases.get(bus_name)
            if peer is None:
                result["hitRefusal"] = "UncollectedAlias"
                raise RuntimeError()
            next_ref = (peer["owner"], path)
            if next_ref not in collected or next_ref in visited:
                result["refusedHitReference"] = list(next_ref)
                result["hitRefusal"] = "UncollectedReference" if next_ref not in collected else "Cycle"
                raise RuntimeError()
            visited.add(next_ref)
            result["hitPath"].append(list(next_ref))
            current_ref = next_ref
            current = collected[current_ref]
            owner.node(current)
            require(tuple(owner.references.identity(current, owner)) == current_ref, "Hit wire ID changed")
            shown(current)
            if current_ref != target_ref:
                component = current.get_component_iface()
                require(component is not None, "Hit Component interface absent")

        stage = "recheck"
        owner.recheck(full=True)
        client_after = B.visible_rectangle(req, helper, owner.x11)
        frame_after = owner.x11.frame_rectangle(req.window)
        owner.recheck(full=True)
        result.update(nativeRectangleAfter=list(client_after), nativeFrameRectangleAfter=list(frame_after))
        require(client_after == native_rect and frame_after == native_frame, "Native client/frame rectangle changed")
        require(geometry(window, "frameRectangleAfter", native_frame)[1] == frame_rect
                and geometry(target, "controlRectangleAfter")[1] == target_rect
                and geometry(source_heading, "headingRectangleAfter")[1] == heading_rect,
                "Frame/control/heading rectangle changed")
        final_candidates, final_headings = [], []
        for reference, node in collected.items():
            owner.node(node)
            require(tuple(owner.references.identity(node, owner)) == reference and node.get_role() == roles[reference],
                    "Collected wire ID/role changed")
            if reference in visited:
                shown(node)
            if roles[reference] == atspi.Role.PUSH_BUTTON and fixed_name(node) == name:
                final_candidates.append(reference)
            elif heading_matches(reference, node):
                final_headings.append(reference)
        shown(source_heading)
        require(final_candidates == candidates and final_headings == headings
                and owner.references.window == list(frame_ref), "Source control/frame changed")
        owner.recheck(full=True)
        result["verified"] = True
    except Exception as error:
        result["refusal"] = {"stage": stage, "errorType": type(error).__name__[:64]}
    if len((json.dumps(result, ensure_ascii=True, indent=2) + "\n").encode("utf8")) > 24576:
        result = {"readOnly": True, "authorization": False, "actionCount": 0, "nativeAcceptance": False,
                  "verified": False, "control": "save-guide", "refusal": {"stage": "output", "errorType": "OutputBound"}}
    return result


def capture_refusal_hit_test(error, window, collected, owner, atspi):
    """Optional evidence cannot replace the original refusal or authorize input."""
    try:
        observation = {**error.observation, "fixedControlHitTest": fixed_control_hit_test(window, collected, owner, atspi)}
        if "knownObjects" in observation:
            observation["knownObjects"] = list(observation["knownObjects"])
        observation["collectedReferences"] = list(observation["collectedReferences"])
        while len((json.dumps(observation, ensure_ascii=True, indent=2) + "\n").encode("utf8")) > 32768:
            if observation.get("knownObjects"):
                observation["knownObjects"].pop()
                observation["knownObjectsTruncated"] = True
            elif observation["collectedReferences"]:
                observation["collectedReferences"].pop()
                observation["referencesTruncated"] = True
            else:
                observation["fixedControlHitTest"] = {"readOnly": True, "authorization": False, "actionCount": 0,
                    "nativeAcceptance": False, "verified": False, "control": "save-guide",
                    "refusal": {"stage": "output", "errorType": "OutputBound"}}
                require(len((json.dumps(observation, indent=2) + "\n").encode("utf8")) <= 32768,
                        "Refusal diagnostic exceeds output bound")
        error.observation = observation
    except Exception as capture_error:
        error.observation["hitTestCaptureRefusal"] = {"errorType": type(capture_error).__name__[:64]}
        try:
            while len((json.dumps(error.observation, indent=2) + "\n").encode("utf8")) > 32768:
                if error.observation.get("knownObjects"):
                    error.observation["knownObjects"].pop()
                    error.observation["knownObjectsTruncated"] = True
                else:
                    require(error.observation["collectedReferences"], "Refusal capture exceeds bound")
                    error.observation["collectedReferences"].pop()
                    error.observation["referencesTruncated"] = True
        except Exception:
            pass  # A local serialization failure must never replace TreeRefusal.


def own_tree(window, owner, atspi):
    """Contained semantic parents, not strict reverse GetChildren equality.

    WebKit's live semantic Parent may skip a GetChildren container (measured in
    38639092559). Same-frame Parent membership is a harness invariant, not an
    established upstream guarantee; a mismatch still refuses without input.
    Fixed controls below require two full walks and the same canonical wire ID.
    """
    helper, req = owner.helper, owner.request
    require(window.get_process_id() == req.pid and window.get_role() == atspi.Role.FRAME
            and window.get_name() == req.title, "Foreign component AX frame refused")
    reference = owner.references.identity(window, owner)
    require(reference == owner.references.window, "Component AX frame wire identity changed")
    nodes, seen, parents, pending = [], set(), [], [(window, None, 0)]
    collected = {}
    owner.recheck(full=True)
    while pending:
        node, expected_parent, depth = pending.pop()
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
            parents.append({"node": list(key), "parent": owner.references.identity(parent, owner),
                            "getChildrenParent": list(expected_parent), "depth": depth,
                            "pid": node.get_process_id(), "role": int(node.get_role())})
        nodes.append(node)
        collected[key] = node
        budget = min(helper.MAX_CHILDREN, helper.MAX_NODES - len(nodes) - len(pending))
        pending.extend((child, key, depth + 1) for child in reversed(helper.children(node, budget)))
    missing = [record for record in parents if tuple(record["parent"]) not in seen]
    if missing:
        owner.recheck(full=True)
        observation = {"readOnly": True, "authorization": False, "actionCount": 0,
                       "timing": "original-refusing-walk-not-a-retry", "collectedCount": len(nodes),
                       "checkedParents": len(parents), "missingCount": len(missing),
                       "missing": missing[:8], "collectedReferences": [list(ref) for ref in sorted(seen)[:32]],
                       "referencesTruncated": len(seen) > 32, "missingTruncated": len(missing) > 8}
        error = TreeRefusal(observation)
        try:
            enriched = {**observation, "knownObjects": tree_refusal_metadata(missing[:8], collected),
                        "knownObjectsTruncated": False}
            # Match save_json's on-disk encoding, not just compact JSON size.
            while len((json.dumps(enriched, ensure_ascii=True, indent=2) + "\n").encode("utf8")) > 32768:
                enriched["knownObjectsTruncated"] = True
                if enriched["knownObjects"]:
                    enriched["knownObjects"].pop()
                else:
                    enriched["collectedReferences"] = enriched["collectedReferences"][:-1]
                    enriched["referencesTruncated"] = True
                    require(enriched["collectedReferences"], "Tree refusal capture exceeds bound")
            error.observation = enriched
        except Exception as capture_error:
            observation["metadataRefusal"] = {"errorType": type(capture_error).__name__[:64]}
        capture_refusal_hit_test(error, window, collected, owner, atspi)
        raise error
    owner.recheck(full=True)
    require(owner.same_node(helper.select_window(req, atspi), window), "Component Root frame changed")
    return nodes


def visible(nodes, atspi):
    return [node for node in nodes if node.get_state_set().contains(atspi.StateType.SHOWING)]


GUIDE_IDS = {
    "mcp-host-frame": (39, "iframe", "group", "Creator Works MCP"),
    "connection-guide-dialog": (16, "dialog", "dialog", "Connect your AI to Unity"),
    "connection-guide-title": (82, "h2", "heading", "Connect your AI to Unity"),
    "connection-guide-skip": (43, "button", "button", "Use existing controls"),
}
MCP_SAVED_IDS = {
    "connectionGuideBtn": (43, "button", "button", "Connection guide"),
    "hosted-status": (54, "span", "status", None),
}
ROOT_SEQUENCE_IDS = {
    "mcp-host-frame": GUIDE_IDS["mcp-host-frame"],
    "setup-host-frame": (39, "iframe", "group", "Creator Project Setup"),
    "view-hosted": (109, "section", "region", "Hosted Creator app"),
    "hosted-stop": (43, "button", "button", "Close MCP"),
    "view-builtin": (109, "section", "region", None),
    "builtin-title": (82, "h2", "heading", "Creator Works MCP"),
    "view-hub": (109, "section", "region", "Apps"),
    "entry-setup": (85, "div", "generic", None),
}
SETUP_SEQUENCE_IDS = {
    "setup-host-frame": (39, "iframe", "group", "Creator Project Setup"),
    "recipe-line": (85, "div", "generic", None),
    "refresh-button": (43, "button", "button", "Check requirements again"),
    "hosted-status": MCP_SAVED_IDS["hosted-status"],
    "requirements": (85, "div", "generic", None),
}
SOURCE_SEQUENCE = ("mcp-ready", "save-guide", "mcp-saved", "close-mcp", "mcp-closed", "return-apps",
                   "view-setup", "setup-ready", "requirements", "setup-checked")
CLOSE_TITLE = "Close hosted app?"
CLOSE_BODY = ("Close this hosted app view? Unsaved form entries in this view will be discarded. "
              "Project files and the standalone app are unchanged.")
# Exact producer values, not a libatspi offset or a generic role conversion.
# WebKit/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityAtspiEnums.h
GUIDE_WEBKIT_ROOT_ROLES = (23, 69, 74)  # Frame, Window, Application.
GUIDE_LIBRARIES = (
    ("libgtk-3-0", "/usr/lib/x86_64-linux-gnu/libgtk-3.so.0", "root"),
    ("libatk-bridge2.0-0", "/usr/lib/x86_64-linux-gnu/libatk-bridge-2.0.so.0", "root"),
    ("libatspi2.0-0", "/usr/lib/x86_64-linux-gnu/libatspi.so.0", "worker"),
)


def guide_mapped_file(body, pathname, device, inode):
    """Only the selected protected library's executable maps, not other paths."""
    require(type(body) is str and 0 < len(body) <= 1048576, "Bounded native maps required")
    matches = []
    for line in body.splitlines():
        fields = line.split(None, 5)
        if len(fields) != 6 or fields[5] != pathname:
            continue
        require(re.fullmatch(r"[0-9a-f]+-[0-9a-f]+", fields[0])
                and re.fullmatch(r"[r-][w-][x-][ps]", fields[1])
                and re.fullmatch(r"[0-9a-f]+", fields[2])
                and re.fullmatch(r"[0-9a-f]+:[0-9a-f]+", fields[3]) and fields[4].isdigit(),
                "Invalid selected library mapping")
        require(tuple(int(v, 16) for v in fields[3].split(":")) == device and int(fields[4]) == inode,
                "Mapped library differs from protected file")
        if "x" in fields[1]:
            require(fields[1] == "r-xp" and len(matches) < 8, "Writable/shared/excess library code maps refused")
            matches.append(fields[:5])
    require(matches, "Selected runtime library is not executable-mapped")
    return matches


def guide_runtime_state(owner):
    owner.recheck(full=True)
    result = {}
    for package, link, process in GUIDE_LIBRARIES:
        selected = Path(link).resolve(strict=True)
        require(str(selected).startswith("/usr/lib/x86_64-linux-gnu/"), "Runtime library escaped system directory")
        for entry in (Path(link), selected, *selected.parents):
            info = entry.lstat()
            require(info.st_uid == info.st_gid == 0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022),
                    "Runtime library ancestry is not protected root-owned content")
        before = selected.stat()
        require(stat.S_ISREG(before.st_mode), "Runtime library is not regular")
        record = B.file_record(selected, 64 * 1024 * 1024)
        require(record["device"] == str(before.st_dev) and record["inode"] == str(before.st_ino),
                "Runtime file identity changed before maps attribution")
        pid = owner.request.pid if process == "root" else os.getpid()
        with open(f"/proc/{pid}/maps", encoding="utf8") as stream:
            body = stream.read(1048577)
        mappings = guide_mapped_file(body, str(selected), (os.major(before.st_dev), os.minor(before.st_dev)), before.st_ino)
        require(B.file_record(selected, 64 * 1024 * 1024) == record, "Mapped runtime library changed")
        result[package] = {"path": str(selected), "file": record, "pid": pid, "maps": mappings}
    owner.recheck(full=True)
    return result


def guide_runtime_provenance(root, action, owner):
    before = guide_runtime_state(owner)
    packages = {}
    for index, (package, _link, _process) in enumerate(GUIDE_LIBRARIES):
        prefix = action + "-guide-runtime-" + str(index)
        _status, version = B.run_tool(root, prefix + "-package", ["/usr/bin/dpkg-query", "-W", "-f=" + B.STATE_FORMAT, package + ":amd64"], timeout=5)
        require(len(version) <= 512, "Runtime package metadata exceeds bound")
        fields = version.decode("ascii").rstrip("\n").split("\t")
        require(len(fields) == 4 and fields[0] == package and fields[2:] == ["amd64", "installed"]
                and re.fullmatch(r"[0-9][0-9A-Za-z:.+~_-]{0,127}", fields[1]), "Invalid installed runtime package state")
        if package == "libgtk-3-0":
            require(re.fullmatch(r"3\.24\.33-[0-9A-Za-z.+~_-]+", fields[1]), "GTK source version differs from audited 3.24.33")
        _status, attribution = B.run_tool(root, prefix + "-owner", ["/usr/bin/dpkg-query", "-S", before[package]["path"]], timeout=5)
        require(attribution == (package + ":amd64: " + before[package]["path"] + "\n").encode(),
                "Mapped runtime library package attribution differs")
        packages[package] = fields[1]
    require(guide_runtime_state(owner) == before, "Runtime libraries changed during package attribution")
    return {"packages": packages, "mappedFiles": before, "scope": "observed-native-runtime-binding-not-publisher-authentication"}


def fresh_source_inventory(window, owner, atspi, observation, phase):
    """Finite disposable sequence only; this read does not authorize an action.

    Clear libatspi's cache before EACH count/index read, including the frame.
    See atspi_accessible_get_child_at_index's ATSPI_CACHE_CHILDREN branch and
    WebKitGTK 2.50.4 AXObjectCacheAtspi's separate deferred Parent updates.
    """
    require(phase in SOURCE_SEQUENCE, "Unknown finite source inventory")
    contracts = (GUIDE_IDS if phase in ("mcp-ready", "save-guide") else
                 {**GUIDE_IDS, **MCP_SAVED_IDS, **ROOT_SEQUENCE_IDS} if phase in ("mcp-saved", "close-mcp") else
                 SETUP_SEQUENCE_IDS if phase in ("setup-ready", "requirements", "setup-checked") else ROOT_SEQUENCE_IDS)
    owner.recheck(full=True)
    frame = tuple(owner.references.identity(window, owner))
    require(list(frame) == owner.references.window and window.get_role() == atspi.Role.FRAME
            and window.get_process_id() == owner.request.pid and window.get_name() == owner.request.title,
            "Source guide frame differs from bound native Root")
    nodes, rows, pending, ids, paths = {}, [], [(window, None, ())], {}, {}
    observation.update(freshness="clear-cache-before-each-child-count-and-index", sourceObservations=[])
    while pending:
        node, parent, ancestors = pending.pop()
        require(len(nodes) < min(512, owner.helper.MAX_NODES) and len(ancestors) < owner.helper.MAX_DEPTH,
                "Source guide forward tree exceeds bound")
        owner.node(node)
        reference = tuple(owner.references.identity(node, owner))
        require(reference not in nodes, "Duplicate/cyclic source guide wire reference")
        node.clear_cache()
        owner.node(node)
        role = node.get_role()
        require(isinstance(role, int) and not isinstance(role, bool) and 0 <= role <= 0xffffffff,
                "Invalid source guide numeric role")
        root_roles = ((atspi.Role.FRAME, atspi.Role.WINDOW, atspi.Role.APPLICATION)
                      if node.get_process_id() == owner.request.pid else GUIDE_WEBKIT_ROOT_ROLES)
        require(reference == frame or role not in root_roles,
                "Nested/foreign source guide Root refused")
        attributes = node.get_attributes()
        require(type(attributes) is dict and len(attributes) <= 32, "Source guide attribute map exceeds bound")
        source_id = attributes.get("id")
        source_id = source_id if type(source_id) is str and source_id in contracts else None
        row = {"reference": list(reference), "parent": list(parent) if parent else None, "role": int(role)}
        if source_id is not None:
            require(owner.renderer is not None and node.get_process_id() == owner.renderer["pid"],
                    "Source guide DOM is not in the bound renderer")
            expected_role, tag, computed, name = contracts[source_id]
            source = {"id": source_id, "roleMatches": role == expected_role,
                      "tagMatches": attributes.get("tag") == tag,
                      "computedRoleMatches": attributes.get("computed-role") == computed,
                      "toolkitMatches": attributes.get("toolkit") == "WebKitGTK",
                      "nameMatches": name is None or node.get_name() == name}
            row["source"] = source
            states = node.get_state_set()
            row["states"] = {state: states.contains(getattr(atspi.StateType, state)) for state in
                             ("VISIBLE", "SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}
            if source_id == "connection-guide-dialog" and phase in ("mcp-ready", "save-guide"):
                # Native 39113636046: showModal() in the pinned iframe has MODAL=false.
                # Page.cpp::axObjectCache initializes from the main document;
                # AXObjectCache.cpp::modalNode is not the iframe's HTML modal state.
                row["atspiModalObserved"] = states.contains(atspi.StateType.MODAL)
            if len(observation["sourceObservations"]) < 8:
                observation["sourceObservations"].append({"reference": list(reference), "role": int(role),
                    **source, "states": dict(row["states"]),
                    **({"atspiModalObserved": row["atspiModalObserved"]} if "atspiModalObserved" in row else {})})
            ids.setdefault(source_id, []).append((reference, ancestors))
        nodes[reference] = node
        paths[reference] = ancestors
        rows.append(row)
        node.clear_cache()
        count = node.get_child_count()
        require(type(count) is int and 0 <= count <= owner.helper.MAX_CHILDREN
                and count <= owner.helper.MAX_NODES - len(nodes) - len(pending), "Source guide child count exceeds bound")
        children = []
        for index in range(count):
            node.clear_cache()
            child = node.get_child_at_index(index)
            require(child is not None, "Source guide forward child disappeared")
            children.append(child)
        node.clear_cache()
        require(node.get_child_count() == count, "Source guide child count changed during fresh reads")
        pending.extend((child, reference, (*ancestors, reference)) for child in reversed(children))
    observation.update(nodeCount=len(rows), graphSha256=hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
                       sourceCounts={key: len(ids.get(key, [])) for key in contracts}, sourcePaths={}, parentMismatches=[])
    for source_id, matches in ids.items():
        if len(matches) == 1:
            ref, ancestors = matches[0]
            observation["sourcePaths"][source_id] = [list(item) for item in (*ancestors, ref)]
    # Never resolve, inspect PID/role, or traverse an uncollected semantic parent.
    forward_parents = {tuple(row["reference"]): row["parent"] for row in rows}
    for reference, node in nodes.items():
        try:
            parent = node.get_parent()
            canonical = None
            if parent is not None:
                alias = owner.references.aliases.get(parent.app.bus_name)
                if alias is not None and type(parent.path) is str and len(parent.path) <= 256:
                    canonical = (alias["owner"], parent.path)
            if reference != frame and (list(canonical) if canonical else None) != forward_parents[reference] \
                    and len(observation["parentMismatches"]) < 8:
                observation["parentMismatches"].append({"node": list(reference), "parentCollected": canonical in nodes,
                    "forwardParent": forward_parents[reference], "collectedParent": list(canonical) if canonical in nodes else None})
        except Exception as error:
            if len(observation["parentMismatches"]) < 8:
                observation["parentMismatches"].append({"node": list(reference), "errorType": type(error).__name__[:64]})
    require(all(len(matches) == 1 for matches in ids.values()), "Duplicate source context ID")
    owner.recheck(full=True)
    return rows, nodes, paths, ids


class SourceNotReady(RuntimeError):
    pass


def source_context(rows, ids, required, setup_read=False):
    require(all(len(ids.get(key, [])) == 1 for key in required), "Exact unique source guide IDs required")
    for row in rows:
        if row.get("source", {}).get("id") in required:
            require(all(value is True for key, value in row["source"].items() if key != "id"),
                    "Source guide DOM/role/name contract differs")
            states = row["states"]
            require(states["VISIBLE"] and states["SHOWING"] and not states["DEFUNCT"] and not states["BUSY"],
                    "Source guide context is not visible/ready")
            if row["source"]["id"] in ("connection-guide-skip", "connectionGuideBtn", "hosted-stop", "refresh-button"):
                if setup_read and row["source"]["id"] == "refresh-button":
                    continue
                require(states["ENABLED"] and states["SENSITIVE"], "Source guide control is disabled")
    return [ids[key][0][0] for key in required]


def source_document(rows, nodes, paths, iframe, owner, observation):
    documents = [tuple(row["reference"]) for row in rows if row["role"] == 94 and iframe in paths[tuple(row["reference"])]]
    require(len(documents) == 1, "Exact one forward component document required")
    document = documents[0]
    require(nodes[document].get_process_id() == owner.renderer["pid"]
            and nodes[document].get_attributes().get("toolkit") == "WebKitGTK", "Component document producer differs")
    observation["sourcePaths"]["component-document"] = [list(item) for item in (*paths[document], document)]
    return document


def source_version(nodes, paths, status, expected, atspi, observation, setup_read=False):
    # This exact role=status span renders its content; Accessible.Name is not
    # its text. WebKitGTK 2.50.4 interfacesForObject exposes inline-renderer Text.
    node = nodes[status]
    node.clear_cache()
    interface = node.get_text_iface()
    detail = {"reader": "exact-hosted-status-Text", "interfacePresent": interface is not None}
    observation["hostedVersionRead"] = detail
    require(interface is not None, "Exact source status Text interface absent")
    count = interface.get_character_count()
    detail["characterCount"] = count if type(count) is int and 0 <= count <= 128 else None
    require(type(count) is int and 0 < count <= 128, "Source hosted version text exceeds bound")
    text = interface.get_text(0, count)
    require(type(text) is str and len(text) == count and len(text.encode()) <= 512
            and interface.get_character_count() == count, "Source hosted version text changed or exceeded bound")
    matches = node.get_state_set().contains(atspi.StateType.SHOWING) and text == expected
    detail["knownState"] = text if text in (APPS["mcp"]["version"], APPS["setup"]["version"], "Opening app") else "other"
    observation["hostedVersionMatches"] = matches
    if not matches and setup_read and text == "Opening app":
        raise SourceNotReady("Bound Setup initial workflow is still opening")
    require(matches, "Exact source hosted component version is not ready")


def fresh_guide_walk(window, owner, atspi, observation, saved=False):
    require(type(saved) is bool, "Fixed MCP phase required")
    rows, nodes, paths, ids = fresh_source_inventory(window, owner, atspi, observation, "mcp-saved" if saved else "mcp-ready")
    required = ("mcp-host-frame", *MCP_SAVED_IDS) if saved else tuple(GUIDE_IDS)
    references = source_context(rows, ids, required)
    frame, iframe = tuple(owner.references.window), references[0]
    document = source_document(rows, nodes, paths, iframe, owner, observation)
    require(all(document in ancestors for key, matches in ids.items() if key not in ("mcp-host-frame", "hosted-status")
                and key in (*GUIDE_IDS, *MCP_SAVED_IDS)
                for _ref, ancestors in matches), "MCP source context escaped exact iframe document")
    if saved:
        target, status = references[1:]
        require(iframe not in paths[status], "Hosted status escaped the Root document")
        source_version(nodes, paths, status, APPS["mcp"]["version"], atspi, observation)
        require(not any(row.get("source", {}).get("id") in tuple(GUIDE_IDS)[1:] and row["states"]["SHOWING"] for row in rows),
                "Post-save guide remains visible; no action will be retried")
        require(not any(row["role"] == 2 and nodes[tuple(row["reference"])].get_state_set().contains(atspi.StateType.SHOWING)
                        for row in rows), "Visible source MCP/Root alert after save")
        owner.recheck(full=True)
        return rows, nodes, (frame, iframe, target, status)
    dialog, heading, target = references[1:]
    require(iframe in ids["connection-guide-dialog"][0][1]
            and dialog in ids["connection-guide-title"][0][1]
            and dialog in ids["connection-guide-skip"][0][1], "Source guide modal/control ancestry differs")
    owner.recheck(full=True)
    return rows, nodes, (frame, iframe, dialog, heading, target)


def source_rectangles(owner, atspi, nodes, references):
    require(2 <= len(references) <= 5, "Bounded source geometry required")
    client = B.visible_rectangle(owner.request, owner.helper, owner.x11)
    frame = owner.x11.frame_rectangle(owner.request.window)
    def inside(inner, outer):
        return (outer[0] <= inner[0] and outer[1] <= inner[1]
                and inner[0] + inner[2] <= outer[0] + outer[2] and inner[1] + inner[3] <= outer[1] + outer[3])
    require(all(type(rect) is tuple and len(rect) == 4 and all(type(v) is int and 0 <= v <= 0x7fffffff for v in rect)
                and 0 < rect[2] <= 1920 and 0 < rect[3] <= 1080 for rect in (client, frame))
            and inside(client, frame), "Source guide native geometry differs")
    result = {"client": list(client), "frame": list(frame), "source": []}
    for index, reference in enumerate(references):
        node = nodes[reference]
        owner.node(node)
        component = node.get_component_iface()
        require(component is not None, "Source guide Component interface absent")
        extent = component.get_extents(atspi.CoordType.SCREEN)
        rect = (extent.x, extent.y, extent.width, extent.height)
        require(all(type(v) is int and -0x80000000 <= v <= 0x7fffffff for v in rect)
                and 0 < rect[2] <= 1920 and 0 < rect[3] <= 1080
                and (rect == frame if index == 0 else inside(rect, client)), "Source guide AX geometry escaped native binding")
        result["source"].append(list(rect))
    owner.recheck(full=True)
    return result


def source_guide_geometry(owner, atspi, nodes, references, saved=False):
    require(type(saved) is bool and len(references) == (4 if saved else 5), "Fixed source MCP geometry only")
    result = source_rectangles(owner, atspi, nodes, references)
    if not saved:
        def inside(inner, outer):
            return (outer[0] <= inner[0] and outer[1] <= inner[1]
                    and inner[0] + inner[2] <= outer[0] + outer[2] and inner[1] + inner[3] <= outer[1] + outer[3])
        require(inside(tuple(result["source"][3]), tuple(result["source"][2]))
                and inside(tuple(result["source"][4]), tuple(result["source"][2])), "Guide controls escaped their modal")
    owner.recheck(full=True)
    return result


def source_guide(root, action, owner, atspi):
    require(action in ("mcp-ready", "save-guide", "mcp-saved") and B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE,
            "Source guide path is only for fixed current disposable candidate")
    saved = action == "mcp-saved"
    report = {"readOnly": True, "authorization": False, "actionCount": 0, "nativeAcceptance": False,
              "action": action, "scope": "disposable-current-fixed-MCP-guide-only", "walks": []}
    try:
        report["runtime"] = guide_runtime_provenance(root, action, owner)
        first = {}
        report["walks"].append(first)
        rows, nodes, references = fresh_guide_walk(owner.helper.select_window(owner.request, atspi), owner, atspi, first, saved=saved)
        geometry = source_guide_geometry(owner, atspi, nodes, references, saved=saved)
        interface = None
        if action == "save-guide":
            target = nodes[references[-1]]
            owner.helper.ready(target, atspi)
            interface = target.get_action_iface()
            require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "press",
                    "Exact single source guide press required")
        second = {}
        report["walks"].append(second)
        final_rows, final_nodes, final_refs = fresh_guide_walk(owner.helper.select_window(owner.request, atspi), owner, atspi, second, saved=saved)
        require(rows == final_rows and references == final_refs, "Fresh complete source guide graph/ancestry changed")
        require(source_guide_geometry(owner, atspi, final_nodes, final_refs, saved=saved) == geometry, "Source guide geometry changed")
        require(guide_runtime_state(owner) == report["runtime"]["mappedFiles"], "Source guide runtime libraries changed")
        report.update(geometry=geometry, freshWalksMatched=True)
        if saved:
            report.update(guideDismissed=True, hostedVersion=APPS["mcp"]["version"], preferenceVerified=False)
        require(len((json.dumps(report, indent=2) + "\n").encode()) <= 32768, "Source guide report exceeds bound")
        if action == "save-guide":
            target = final_nodes[final_refs[-1]]
            owner.helper.ready(target, atspi)
            owner.recheck(full=True)
            try:
                require(interface.do_action(0), "Source guide press refused; never retry")
                owner.recheck(full=True)
            except Exception as error:
                report["actionMayHaveRun"] = True
                raise owner.helper.ActionError(str(error)) from error
            report.update(readOnly=False, actionCount=1)
        return report
    except Exception as error:
        report["refusal"] = {"errorType": type(error).__name__[:64]}
        raise
    finally:
        try:
            require(len((json.dumps(report, indent=2) + "\n").encode()) <= 32768, "Source guide retention exceeds bound")
            B.save_json(root / (action + "-source-guide.json"), report)
        except Exception as error:
            print(json.dumps({"sourceGuideCaptureRefusal": type(error).__name__[:64]}), file=sys.stderr)


def fixed_subtree_values(nodes, paths, reference, atspi):
    values = []
    selected = [node for ref, node in nodes.items() if ref == reference or reference in paths[ref]]
    require(0 < len(selected) <= 64, "Fixed source text subtree exceeds bound")
    for node in selected:
        if not node.get_state_set().contains(atspi.StateType.SHOWING):
            continue
        name = node.get_name()
        require(type(name) is str and len(name) <= 2048, "Source text name exceeds bound")
        values.extend(value for value in (name, node_text(node, atspi)) if value)
    require(sum(len(value.encode()) for value in values) <= 16384, "Fixed source text aggregate exceeds bound")
    return values


def source_button(nodes, paths, context, name, owner, atspi):
    matches = [ref for ref, node in nodes.items() if context in paths[ref]
               and node.get_role() == 43 and node.get_name() == name]
    require(len(matches) == 1, "Exact unique button in fixed source context required")
    ref, = matches
    node = nodes[ref]
    attrs = node.get_attributes()
    require(node.get_process_id() == owner.renderer["pid"] and type(attrs) is dict
            and all(attrs.get(k) == v for k, v in {"tag": "button", "computed-role": "button", "toolkit": "WebKitGTK"}.items()),
            "Fixed source button producer/tag/role differs")
    owner.helper.ready(node, atspi)
    return ref


def source_sequence_walk(owner, atspi, action, observation):
    window = owner.helper.select_window(owner.request, atspi)
    if action == "close-mcp":
        rows, nodes, refs = fresh_guide_walk(window, owner, atspi, observation, saved=True)
        ids = {row["source"]["id"]: [(tuple(row["reference"]), tuple(tuple(v) for v in observation["sourcePaths"][row["source"]["id"]][:-1]))]
               for row in rows if "source" in row}
        hosted, stop = source_context(rows, ids, ("view-hosted", "hosted-stop"))
        require(hosted in ids["hosted-stop"][0][1] and hosted in ids["mcp-host-frame"][0][1],
                "MCP close escaped exact hosted Root context")
        return rows, nodes, (refs[0], refs[1], refs[-1], stop), stop
    rows, nodes, paths, ids = fresh_source_inventory(window, owner, atspi, observation, action)
    frame = tuple(owner.references.window)
    if action in ("mcp-closed", "return-apps", "view-setup"):
        require(not any(key in ids for key in ("mcp-host-frame", "setup-host-frame")), "An embedded document remains in Root navigation")
        if action in ("mcp-closed", "return-apps"):
            context, heading = source_context(rows, ids, ("view-builtin", "builtin-title"))
            require(context in paths[heading], "Closed MCP heading escaped built-in context")
            target = source_button(nodes, paths, context, "All apps", owner, atspi)
            return rows, nodes, (frame, heading, target), target
        hub, entry = source_context(rows, ids, ("view-hub", "entry-setup"))
        require(hub in paths[entry], "Setup app entry escaped Apps context")
        target = source_button(nodes, paths, entry, APPS["setup"]["view"], owner, atspi)
        return rows, nodes, (frame, target), target
    require(action in ("setup-ready", "requirements", "setup-checked"), "Unknown finite source operation")
    setup_read = action in ("setup-ready", "setup-checked")
    iframe, recipe, refresh, status, requirements = source_context(rows, ids, tuple(SETUP_SEQUENCE_IDS), setup_read=setup_read)
    document = source_document(rows, nodes, paths, iframe, owner, observation)
    require(all(document in paths[ref] for ref in (recipe, refresh, requirements)) and iframe not in paths[status],
            "Setup source controls escaped exact document")
    source_version(nodes, paths, status, APPS["setup"]["version"], atspi, observation, setup_read=setup_read)
    recipe_values = fixed_subtree_values(nodes, paths, recipe, atspi)
    if setup_read and "Loading approved recipe\u2026" in recipe_values:
        raise SourceNotReady("Bound Setup recipe is still loading")
    require(RECIPE in recipe_values, "Exact pinned Setup recipe is not ready")
    require("Unity Hub or Unity CLI" in fixed_subtree_values(nodes, paths, requirements, atspi), "Actual Setup requirements missing")
    require(not any(row["role"] == 2 and nodes[tuple(row["reference"])].get_state_set().contains(atspi.StateType.SHOWING)
                    for row in rows), "Visible Setup/Root source alert")
    if setup_read:
        states = nodes[refresh].get_state_set()
        if not (states.contains(atspi.StateType.ENABLED) and states.contains(atspi.StateType.SENSITIVE)):
            raise SourceNotReady("Bound Setup refresh is still checking")
    return rows, nodes, (frame, iframe, recipe, refresh), refresh


def source_sequence(root, action, owner, atspi):
    require(action in SOURCE_SEQUENCE and action not in ("mcp-ready", "save-guide", "mcp-saved")
            and B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE, "Fixed current source sequence only")
    report = {"action": action, "readOnly": True, "authorization": False, "actionCount": 0,
              "nativeAcceptance": False, "walks": []}
    try:
        report["runtime"] = guide_runtime_provenance(root, action, owner)
        deadline = time.monotonic() + 15
        while True:
            before = {}
            report["walks"] = [before]
            try:
                rows, nodes, refs, target = source_sequence_walk(owner, atspi, action, before)
                break
            except SourceNotReady:
                require(action in ("setup-ready", "setup-checked") and time.monotonic() < deadline,
                        "Bound Setup read-only readiness deadline; no input retried")
                report["readinessObservations"] = report.get("readinessObservations", 0) + 1
                time.sleep(0.05)
        geometry = source_rectangles(owner, atspi, nodes, refs)
        interface = None
        if action in ("close-mcp", "return-apps", "view-setup", "requirements"):
            owner.helper.ready(nodes[target], atspi)
            interface = nodes[target].get_action_iface()
            require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "press",
                    "Exact single source press required")
        after = {}
        report["walks"].append(after)
        current, final_nodes, final_refs, final_target = source_sequence_walk(owner, atspi, action, after)
        require(rows == current and refs == final_refs and target == final_target, "Fresh finite source graph/control changed")
        require(source_rectangles(owner, atspi, final_nodes, final_refs) == geometry, "Finite source geometry changed")
        require(guide_runtime_state(owner) == report["runtime"]["mappedFiles"], "Finite source runtime changed")
        report.update(freshWalksMatched=True, geometry=geometry)
        require(len((json.dumps(report, indent=2) + "\n").encode()) <= 32768, "Finite source report exceeds bound")
        if interface is not None:
            owner.helper.ready(final_nodes[final_target], atspi)
            owner.recheck(full=True)
            try:
                require(interface.do_action(0), "Finite source press refused; never retry")
                owner.recheck(full=True)
            except Exception as error:
                report["actionMayHaveRun"] = True
                raise owner.helper.ActionError("Finite source action uncertain; no retry") from error
            report.update(actionCount=1, readOnly=False)
        return report
    finally:
        try:
            require(len((json.dumps(report, indent=2) + "\n").encode()) <= 32768, "Finite source capture exceeds bound")
            B.save_json(root / (action + "-source-sequence.json"), report)
        except Exception as error:
            print(json.dumps({"sourceSequenceCaptureRefusal": type(error).__name__[:64]}), file=sys.stderr)


def confirm_mcp_close(root, owner, atspi):
    """Consume the shared exact native profile, never another GTK controller."""
    require(B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE, "Current disposable close sequence only")
    helper, request, x11 = owner.helper, owner.request, owner.x11
    guide_runtime_provenance(root, "confirm-close-mcp", owner)
    deadline = time.monotonic() + 10
    while True:
        owner.recheck(full=True)
        windows = [w for w in owned_windows(request.pid, x11) if w["mapped"] and w["window"] != request.window]
        require(len(windows) <= 1 and all(w["title"] == CLOSE_TITLE for w in windows), "Unexpected owned native close dialog")
        if windows:
            break
        require(time.monotonic() < deadline, "Native hosted-close dialog absent; no input retried")
        time.sleep(0.05)
    native, = windows
    frame = x11.frame_rectangle(native["window"])
    args = [str(request.pid), request.start, request.executable, request.sha256, str(native["window"]), CLOSE_TITLE, "ALERT"]
    snapshot = helper.Request("snapshot", request.pid, request.start, request.executable, request.sha256,
                              native["window"], CLOSE_TITLE, "ALERT")
    try:
        snapshot = helper.Request.parse(["snapshot", *args], gtk_message_info_frame=frame)
        before = helper.perform(snapshot, atspi, helper.Proc(), x11, root_close_owner=owner)
    except Exception:
        B.save_json(root / "close-mcp-native-refusal.json", {"readOnly": True, "actionCount": 0, "native": native,
                    "nativeFrame": frame, "ax": backend_ax_observation(snapshot, helper, x11, atspi, None, owner.root, owner.root)})
        raise
    B.save_json(root / "close-mcp-native-snapshot.json", before)
    owner.recheck(full=True)
    require([w for w in owned_windows(request.pid, x11) if w["mapped"] and w["window"] != request.window] == [native],
            "Native close window changed after snapshot")
    result = helper.perform(helper.Request.parse(["click", *args, "Close view"], gtk_message_info_frame=frame),
                            atspi, helper.Proc(), x11, root_close_owner=owner)
    deadline = time.monotonic() + 10
    while True:
        owner.recheck(full=True)
        remaining = [w for w in owned_windows(request.pid, x11) if w["mapped"] and w["window"] != request.window]
        require(all(w == native for w in remaining), "Another native window replaced hosted close")
        if not remaining:
            return {"actionCount": 1, "dialogDismissed": True, "backendExitVerified": False, "input": result}
        require(time.monotonic() < deadline, "Hosted close dismissal deadline; no retry")
        time.sleep(0.05)


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


def exception_causes(error):
    """Original local call sites, including causes; no exception text or locals."""
    records, seen, relation = [], set(), "original"
    while error is not None and id(error) not in seen and len(records) < 8:
        seen.add(id(error))
        records.append({"relation": relation, **failure_site(error)})
        if error.__cause__ is not None:
            error, relation = error.__cause__, "cause"
        elif not error.__suppress_context__:
            error, relation = error.__context__, "context"
        else:
            error = None
    return {"records": records, "truncated": error is not None}


def decline_observation(request, child_request, helper, x11, root_record, actual, binding):
    """One read-only observation of the already-bound Root, child and exact XID.

    A missing/zombie child or absent XID is evidence only, not an exit receipt,
    post-action liveness exception, replacement authority or permission to retry.
    """
    result = {"readOnly": True, "authorization": False, "actionCount": 0, "nativeAcceptance": False,
              "normalExitVerified": False, "rootStable": False, "dialogGone": None}
    try:
        r = child_request.receipt
        require(child_request.action == "click" and child_request.title == APPS["mcp"]["title"]
                and child_request.button == "Not now" and r is not None and r == binding.receipt
                and r.child_pid == actual["pid"] and r.child_start == actual["startTime"]
                and r.child_hash == actual["kernelImageSha256"] == APPS["mcp"]["hash"]
                and r.parent_pid == actual["parentPid"] == request.pid == root_record["pid"]
                and r.parent_start == request.start == root_record["startTime"], "Unbound decline diagnostic")
        proc = helper.Proc()

        def root_check():
            helper.identity(request, proc)
            require(B.native_process(request.pid, helper) == root_record, "Diagnostic Root identity changed")
            return helper.bound_window(request, x11)

        root_window = root_check()
        result["root"] = {key: root_record[key] for key in
                          ("pid", "startTime", "parentPid", "uids", "executable", "kernelImageSha256")}
        result["rootWindow"] = {"window": request.window, **root_window}
        result["heldKernelImage"] = binding.parent_and_image()
        child = result["child"] = {"expectedPid": actual["pid"], "expectedStartTime": actual["startTime"],
                                   "expectedParentPid": actual["parentPid"], "matchesOwnedIdentity": False}

        def child_stat():
            record = proc.stat(actual["pid"])
            start = helper.parse_start(record, actual["pid"], require_live=False)
            fields = record[record.rfind(")") + 2:].split()
            require(len(start) <= 20 and len(fields[0]) == 1 and fields[0] in "RSDZTtXxKWPI"
                    and fields[1].isdigit() and 0 <= int(fields[1]) < 2**31, "Invalid diagnostic process fields")
            observation = {"pid": actual["pid"], "startTime": start, "state": fields[0], "parentPid": int(fields[1])}
            return observation

        try:
            child["beforeStatus"] = first = child_stat()
            require(first["startTime"] == actual["startTime"] and first["parentPid"] == actual["parentPid"],
                    "Diagnostic child PID/start/parent changed")
            child["uids"] = B.process_uids(actual["pid"])
            child["afterStatus"] = last = child_stat()
            child["matchesOwnedIdentity"] = (last["startTime"] == actual["startTime"]
                                             and last["parentPid"] == actual["parentPid"]
                                             and child["uids"] == actual["uids"] == root_record["uids"])
        except FileNotFoundError:
            child["processFileAbsent"] = True
        except Exception as error:
            child["captureRefusal"] = {"errorType": type(error).__name__[:64]}
        try:
            if child_request.window not in B.client_ids(x11):
                result.update(dialogGone=True, dialogEvidence="exact-XID-absent-from-bounded-WM-client-list")
            else:
                result["dialogWindow"] = {"window": child_request.window, **helper.bound_window(child_request, x11)}
                result["dialogGone"] = False
        except Exception as error:
            result["dialogCaptureRefusal"] = {"errorType": type(error).__name__[:64]}
        require(root_check() == root_window, "Diagnostic Root window changed")
        result["rootStable"] = True
    except Exception as error:
        result["captureRefusal"] = {"errorType": type(error).__name__[:64]}
    return result


def perform_mcp_decline(root, request, child_request, helper, x11, atspi, root_record, actual, binding):
    # Pinned modules/mcp/.../hosted.rs: authorize declines with Err; serve_authorized
    # sends it and returns Ok, then run requests app.exit(0) if sending succeeded.
    # This source contract does not prove the native child's actual state/exit.
    before = decline_observation(request, child_request, helper, x11, root_record, actual, binding)

    def retain(error=None):
        try:
            diagnostic = {"readOnly": True, "authorization": False, "actionCount": 0, "nativeAcceptance": False,
                          "normalExitVerified": False, "timing": "around-one-consent-call-no-retry",
                          "helperCallCount": 1, "actionMayHaveRun": error is None or isinstance(error, helper.ActionError),
                          "before": before,
                          "after": decline_observation(request, child_request, helper, x11, root_record, actual, binding),
                          "exceptionChain": exception_causes(error)}
            require(len((json.dumps(diagnostic, ensure_ascii=True, indent=2) + "\n").encode()) <= 32768,
                    "Decline diagnostic exceeds bound")
            B.save_json(root / "mcp-decline-post-click.json", diagnostic)
        except Exception as capture_error:
            print(json.dumps({"declineCaptureRefusal": type(capture_error).__name__[:64]}), file=sys.stderr)

    try:
        result = helper.perform(child_request, atspi, helper.Proc(), x11, binding)
    except Exception as error:
        retain(error)
        raise
    retain()
    return result


def consent(root, action, request, helper, x11, atspi, root_record):
    app, choice = action.split("-", 1)
    require(app in APPS and (choice in ("decline", "approve") or action == "setup-capture"), "Unknown native consent action")
    gtk_component = B.SELECTED_CANDIDATE in (B.GTK3_CANDIDATE, B.CURRENT_CANDIDATE)
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
                    if action == "mcp-decline":
                        result = perform_mcp_decline(root, request, req, helper, x11, atspi, root_record, actual, binding)
                    else:
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
    require(action in CONTROLS or action in SOURCE_SEQUENCE or action in ("confirm-close-mcp", "navigation", "setup-declined", "mcp-declined", "setup-ready",
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
        if action in ("mcp-ready", "save-guide", "mcp-saved") and B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE:
            return source_guide(root, action, owner, Atspi)
        if B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE:
            if action == "confirm-close-mcp":
                return confirm_mcp_close(root, owner, Atspi)
            if action in SOURCE_SEQUENCE:
                return source_sequence(root, action, owner, Atspi)
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
    except Exception as error:
        if isinstance(error, TreeRefusal):
            retain_tree_refusal(root, action, error)
        retain_failure_site(root, action, error)
        raise
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
              "componentOrder": list(COMPONENT_ORDER),
              "candidate": B.SELECTED_CANDIDATE, "productSource": B.SOURCE, "privateSource": B.PRIVATE_SOURCE,
              "productScope": ("534465a sealed-updater/helper-bearing DEB candidate; native operation/update/migration acceptance unproven"
                               if B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE else
                               "4f3744d GTK3 baseline; excludes router fix b154e36; not final release acceptance"),
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
        for app in COMPONENT_ORDER:
            report["phase"] = "open-" + app
            call(root, env_child, "view-" + app, child, start, xid, capture, report)
            declined = call(root, env_child, app + "-decline", child, start, xid, capture, report)
            report["backends"].append(declined["native"])
            call(root, env_child, app + "-declined", child, start, xid, capture, report)
            wait_backend_gone(declined["native"], helper, capture)
            fixture_check(root, before, saved=report.get("mcpNativePreferenceVerified", False))
            report["phase"] = "retry-" + app
            call(root, env_child, "retry", child, start, xid, capture, report)
            approved = call(root, env_child, app + "-approve", child, start, xid, capture, report)
            require(approved["native"]["pid"] != declined["native"]["pid"], "Retry did not create a distinct owned backend")
            report["backends"].append(approved["native"])
            report["phase"] = app + "-operation"
            call(root, env_child, app + "-ready", child, start, xid, capture, report)
            fixture_check(root, before, saved=report.get("mcpNativePreferenceVerified", False))
            if app == "setup":
                call(root, env_child, "requirements", child, start, xid, capture, report)
                call(root, env_child, "setup-checked" if B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE else "setup-ready", child, start, xid, capture, report)
                report["setupNativeRequirementsVerified"] = True
            else:
                call(root, env_child, "save-guide", child, start, xid, capture, report)
                call(root, env_child, "mcp-saved", child, start, xid, capture, report)
                report["preferenceAfterSave"] = fixture_check(root, before, saved=True)
                report["mcpNativePreferenceVerified"] = True
                if B.SELECTED_CANDIDATE == B.CURRENT_CANDIDATE:
                    report["phase"] = "close-mcp-view"
                    call(root, env_child, "close-mcp", child, start, xid, capture, report)
                    call(root, env_child, "confirm-close-mcp", child, start, xid, capture, report)
                    call(root, env_child, "mcp-closed", child, start, xid, capture, report)
                    wait_backend_gone(approved["native"], helper, capture)
                    report["mcpBackendAbsentAfterViewClose"] = True
                    fixture_check(root, before, saved=True)
                    call(root, env_child, "return-apps", child, start, xid, capture, report)
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
    require(B.SELECTED_CANDIDATE in (B.GTK3_CANDIDATE, B.CURRENT_CANDIDATE),
            "Old component native dispatches are held; reviewed GTK3 assembly required")
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
