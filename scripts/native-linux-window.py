"""Interact only with an owned disposable-runner application's accessibility tree."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys

AUTO_DOWNLOAD = "Download verified updates automatically"


def process_start(pid, root=Path("/proc")):
    record = (root / str(pid) / "stat").read_text()
    require(len(record) < 4096 and record.startswith(f"{pid} ("), "Invalid owned process stat")
    require(record.rfind(")") > record.find("("), "Invalid owned process command field")
    fields = record[record.rfind(")") + 2:].split()
    require(len(fields) >= 20 and fields[19].isdigit(), "Invalid owned process start time")
    return fields[19]


def verify_process(pid, expected, start, root=Path("/proc")):
    require(process_start(pid, root) == start, "Owned process start time changed")
    digest = hashlib.sha256()
    with (root / str(pid) / "exe").open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    require(digest.hexdigest() == expected, "Owned process image changed")
    require(process_start(pid, root) == start, "Owned process changed during image verification")


def auto_download_control(nodes, atspi):
    matches = [node for node, _, _ in nodes
               if node.get_role() == atspi.Role.CHECK_BOX and node.get_name() == AUTO_DOWNLOAD
               and node.get_state_set().contains(atspi.StateType.SHOWING)]
    require(len(matches) == 1, "Expected one visible exact auto-download checkbox")
    node = matches[0]
    states = node.get_state_set()
    require(states.contains(atspi.StateType.ENABLED) and states.contains(atspi.StateType.SENSITIVE),
            "Auto-download checkbox is not hydrated/enabled")
    require(not any(states.contains(getattr(atspi.StateType, name))
                    for name in ("DEFUNCT", "BUSY", "INDETERMINATE")), "Auto-download checkbox is not actionable")
    return node


def auto_download_off(nodes, atspi, identity_check):
    node = auto_download_control(nodes, atspi)
    require(node.get_state_set().contains(atspi.StateType.CHECKED), "Auto-download must be ON before the single OFF action")
    interface = node.get_action_iface()
    # WebKit exposes one default checkbox action; its nonlocalized verb is "uncheck" when checked.
    # https://github.com/WebKit/WebKit/blob/main/Source/WebCore/accessibility/AccessibilityObject.cpp
    require(interface and interface.get_n_actions() == 1 and interface.get_name(0) == "uncheck",
            "Expected the unique native checkbox uncheck action")
    identity_check()
    require(auto_download_control(nodes, atspi).get_state_set().contains(atspi.StateType.CHECKED),
            "Auto-download changed before action")
    require(interface.do_action(0), "Native auto-download action was refused")
    identity_check()
    return {"name": AUTO_DOWNLOAD, "action": "uncheck", "actionCount": 1}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    require(sys.platform == "linux" and platform.machine() == "x86_64"
            and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("RUNNER_OS") == "Linux", "Disposable Linux runner required")
    require(len(sys.argv) == 5, "Use ACTION PID EXPECTED_EXE_SHA256 START_TIME")
    action, pid_text, expected, start = sys.argv[1:]
    require(action in ("snapshot", "test-terms-checkbox", "test-terms-accept", "test-auto-download-off"), "Unknown action")
    pid = int(pid_text)
    require(pid > 1 and re.fullmatch(r"[a-f0-9]{64}", expected) and start.isdigit(), "Invalid process identity")
    identity_check = lambda: verify_process(pid, expected, start)
    identity_check()

    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    desktop = Atspi.get_desktop(0)
    applications = []
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app.get_process_id() == pid:
            applications.append(app)
    require(len(applications) == 1, "Owned accessibility application is unavailable or ambiguous")
    nodes = []
    pending = [(applications[0], 0)]
    while pending:
        node, depth = pending.pop()
        require(len(nodes) < 1024 and depth < 40, "Accessibility tree exceeds bounds")
        name = node.get_name() or ""
        text = ""
        interface = node.get_text_iface()
        if interface:
            text = interface.get_text(0, min(interface.get_character_count(), 512))
        nodes.append((node, name, text or ""))
        children = node.get_child_count()
        require(children <= 256, "Too many accessible children")
        pending.extend((node.get_child_at_index(i), depth + 1) for i in range(children))
    identity_check()
    if action == "snapshot":
        result = {"pid": pid, "startTime": start, "nodes": [{"role": n.get_role_name(), "name": name[:512],
                                               "text": text, "checkbox": n.get_role() == Atspi.Role.CHECK_BOX,
                                               **{key: n.get_state_set().contains(getattr(Atspi.StateType, state))
                                                  for key, state in (("showing", "SHOWING"), ("enabled", "ENABLED"),
                                                                     ("sensitive", "SENSITIVE"), ("checked", "CHECKED"),
                                                                     ("busy", "BUSY"), ("defunct", "DEFUNCT"), ("mixed", "INDETERMINATE"))}}
                                              for n, name, text in nodes]}
        identity_check()
        print(json.dumps(result, ensure_ascii=True))
        return
    if action == "test-auto-download-off":
        require(os.environ.get("CREATOR_NATIVE_PREFERENCES_TEST") == "1", "Native preference regression scope required")
        result = auto_download_off(nodes, Atspi, identity_check)
        print(json.dumps({"pid": pid, "startTime": start, **result}))
        return
    require(os.environ.get("CREATOR_SYNTHETIC_TERMS_TEST") == "1", "Synthetic terms scope required")
    matches = []
    for node, name, _ in nodes:
        role = node.get_role()
        states = node.get_state_set()
        if not states.contains(Atspi.StateType.SHOWING):
            continue
        if action == "test-terms-checkbox" and role == Atspi.Role.CHECK_BOX and name.startswith("I have read and agree"):
            matches.append(node)
        if action == "test-terms-accept" and role == Atspi.Role.PUSH_BUTTON and name == "Accept and continue":
            matches.append(node)
    require(len(matches) == 1, "Expected one visible terms control")
    node = matches[0]
    if action == "test-terms-checkbox" and node.get_state_set().contains(Atspi.StateType.CHECKED):
        raise RuntimeError("Fresh terms checkbox is already checked")
    require(node.get_state_set().contains(Atspi.StateType.ENABLED), "Terms control is disabled")
    interface = node.get_action_iface()
    require(interface and interface.get_n_actions() > 0, "No accessible control action")
    identity_check()
    require(interface.do_action(0), "Native terms action was refused")
    identity_check()
    print(json.dumps({"pid": pid, "startTime": start, "action": action, "syntheticTestOnly": True, "customerConsent": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(f"Owned Linux UI probe failed: {type(error).__name__}: {error}")
