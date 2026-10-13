"""Interact only with an owned disposable-runner application's accessibility tree."""
import hashlib
import json
import os
from pathlib import Path
import platform
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    require(sys.platform == "linux" and platform.machine() == "x86_64"
            and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("RUNNER_OS") == "Linux", "Disposable Linux runner required")
    require(len(sys.argv) == 4, "Use ACTION PID EXPECTED_EXE_SHA256")
    action, pid_text, expected = sys.argv[1:]
    require(action in ("snapshot", "test-terms-checkbox", "test-terms-accept"), "Unknown action")
    pid = int(pid_text)
    require(pid > 1 and len(expected) == 64, "Invalid process identity")
    image = Path(f"/proc/{pid}/exe")
    digest = hashlib.sha256()
    with image.open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    require(digest.hexdigest() == expected, "Owned process image changed")

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
    if action == "snapshot":
        print(json.dumps({"pid": pid, "nodes": [{"role": n.get_role_name(), "name": name[:512],
                                               "text": text, "showing": n.get_state_set().contains(Atspi.StateType.SHOWING)}
                                              for n, name, text in nodes]}, ensure_ascii=True))
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
    require(interface.do_action(0), "Native terms action was refused")
    print(json.dumps({"pid": pid, "action": action, "syntheticTestOnly": True, "customerConsent": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(f"Owned Linux UI probe failed: {type(error).__name__}: {error}")
