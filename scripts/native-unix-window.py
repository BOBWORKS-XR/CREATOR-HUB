"""One owned Linux/X11 GUI request, with explicit pathname or sealed-child binding."""
import ctypes as C
import hashlib
import json
import os
import platform
import re
import socket
import stat as S
import sys
from dataclasses import dataclass

MAX_NODES, MAX_CHILDREN, MAX_DEPTH = 512, 128, 32
REQUIRED_SEALS = 0x0f
# Diagnostic producer identity only; this never authorizes a window or action.
_VISIBILITY_DIAGNOSTIC_ORIGIN = object()
_BOUND_WINDOW_DIAGNOSTIC_ORIGIN = object()
ROOT_CLOSE_TITLE = "Close hosted app?"
ROOT_CLOSE_BODY = ("Close this hosted app view? Unsaved form entries in this view will be discarded. "
                   "Project files and the standalone app are unchanged.")
BUTTONS = {
    "Open MCP in Creator Hub?": {"Not now", "Enable MCP controls", "Open read-only preview"},
    "Open Setup in Creator Hub?": {"Not now", "Open in Hub"},
    "Enable managed MCP routing": {"Not now", "Enable managed routing"},
    ROOT_CLOSE_TITLE: {"Close view", "Keep open"},
}
GTK_INFO_BUTTONS = {
    "Open Setup in Creator Hub?": {"Not now", "Open in Hub"},
    "Open MCP in Creator Hub?": {"Not now", "Enable MCP controls"},
    "Enable managed MCP routing": {"Not now", "Enable managed routing"},
    ROOT_CLOSE_TITLE: {"Close view", "Keep open"},
}


def validate_gtk_frame(title, role, frame, sealed):
    if title == ROOT_CLOSE_TITLE:
        require(not sealed and frame is not None, "Root close requires pathname ownership and an explicit native GTK frame")
    if frame is None:
        return
    allowed = {"Open Setup in Creator Hub?", "Open MCP in Creator Hub?"} if sealed else {"Enable managed MCP routing", ROOT_CLOSE_TITLE}
    require(title in allowed and role == "ALERT" and type(frame) is tuple and len(frame) == 4
            and all(type(v) is int for v in frame) and all(0 <= v <= 8192 for v in frame[:2])
            and all(0 < v <= 8192 for v in frame[2:]), "Exact pinned GTK message/geometry contract required")


def require(value, message):
    if not value:
        raise RuntimeError(message)


class ActionError(RuntimeError):
    action_may_have_run = True


def pathname_only(executable):
    require(not executable.startswith(("/memfd:", "memfd:")) and not executable.endswith(" (deleted)"),
            "Sealed memfd/deleted images require owned-launcher kernel binding; pathname helper refuses")


def ensure_runner(env, system, machine):
    require(system == "linux" and machine in ("x86_64", "aarch64"), "Native Linux runner required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and env.get("RUNNER_OS") == "Linux" and env.get("CREATOR_UNIX_WINDOW_TEST") == "1",
            "Explicitly opted-in disposable GitHub-hosted runner required")
    require(env.get("RUNNER_ARCH") == ("X64" if machine == "x86_64" else "ARM64"), "Runner architecture differs")
    require(not env.get("FLATPAK_ID"), "Flatpak hosting is outside this helper")


@dataclass(frozen=True)
class Request:
    action: str
    pid: int
    start: str
    executable: str
    sha256: str
    window: int
    title: str
    role: str
    button: str = ""
    receipt: object = None
    gtk_message_info_frame: tuple | None = None

    @property
    def accessibility_name(self):
        return "Information" if self.gtk_message_info_frame is not None else self.title

    @classmethod
    def parse(cls, args, *, gtk_message_info_frame=None):
        require(len(args) in (8, 9), "Use ACTION PID START EXE SHA256 XID TITLE ROLE [BUTTON]")
        action, pid, start, executable, digest, window, title, role = args[:8]
        button = args[8] if len(args) == 9 else ""
        require(action in ("snapshot", "click", "close"), "Unknown action")
        require(re.fullmatch(r"[1-9][0-9]{0,9}", pid) and 1 < int(pid) < 2**31, "Invalid target PID")
        require(re.fullmatch(r"[1-9][0-9]{0,19}", start), "Invalid process start time")
        pathname_only(executable)
        require(os.path.isabs(executable) and os.path.normpath(executable) == executable, "Exact absolute executable path required")
        require(re.fullmatch(r"[a-f0-9]{64}", digest), "Invalid executable SHA256")
        require(re.fullmatch(r"(?:[1-9][0-9]*|0x[0-9a-fA-F]+)", window), "Invalid window resource ID")
        xid = int(window, 16 if window.startswith("0x") else 10)
        require(0 < xid <= 0xffffffff, "Window resource ID out of range")
        require(0 < len(title.encode("utf8")) <= 256 and not re.search(r"[\x00-\x1f\x7f]", title), "Invalid exact window title")
        require(role in ("FRAME", "DIALOG", "ALERT"), "Expected exact window role required")
        require(not button if action != "click" else button in BUTTONS.get(title, set()), "Permission title/button pair is not allowlisted")
        require(action != "click" or role in ("DIALOG", "ALERT"), "Permission action requires a native dialog")
        require(action != "close" or role == "FRAME", "Normal close requires the owned main frame")
        validate_gtk_frame(title, role, gtk_message_info_frame, sealed=False)
        return cls(action, int(pid), start, executable, digest, xid, title, role, button, None, gtk_message_info_frame)

    @classmethod
    def sealed(cls, args, receipt, *, gtk_message_info_frame=None):
        require(len(args) in (4, 5), "Use ACTION XID TITLE ROLE [BUTTON] after sealed receipt pins")
        action, window, title, role = args[:4]
        control = args[4] if len(args) == 5 else ""
        # Reuse only the action/window/control parser; no backend source pathname is invented.
        require(action in ("snapshot", "click", "close"), "Unknown action")
        require(re.fullmatch(r"(?:[1-9][0-9]*|0x[0-9a-fA-F]+)", window), "Invalid window resource ID")
        xid = int(window, 16 if window.startswith("0x") else 10)
        require(0 < xid <= 0xffffffff, "Window resource ID out of range")
        require(0 < len(title.encode("utf8")) <= 256 and not re.search(r"[\x00-\x1f\x7f]", title), "Invalid exact window title")
        require(role in ("FRAME", "DIALOG", "ALERT"), "Expected exact window role required")
        require(not control if action != "click" else control in BUTTONS.get(title, set()), "Permission title/button pair is not allowlisted")
        require(action != "click" or role in ("DIALOG", "ALERT"), "Permission action requires a native dialog")
        require(action != "close" or role == "FRAME", "Normal close requires the owned main frame")
        validate_gtk_frame(title, role, gtk_message_info_frame, sealed=True)
        return cls(action, receipt.child_pid, receipt.child_start, "", receipt.child_hash, xid, title, role, control, receipt,
                   gtk_message_info_frame)


def exact_keys(value, keys):
    require(type(value) is dict and set(value) == set(keys.split()), "Unexpected/missing launcher receipt fields")


def file_identity(value):
    # Reading may update atime; only identity/content/security metadata is stable here.
    return tuple(getattr(value, field) for field in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
                                                    "st_size", "st_mtime_ns", "st_ctime_ns"))


def decimal(value, positive=False):
    require(type(value) is str and re.fullmatch(r"0|[1-9][0-9]{0,19}", value)
            and int(value) < 2**64 and (not positive or int(value) > 0), "Invalid canonical receipt integer")
    return value


@dataclass(frozen=True)
class Receipt:
    parent_pid: int
    parent_start: str
    parent_executable: str
    parent_hash: str
    child_pid: int
    child_start: str
    child_hash: str
    device: str
    inode: str
    size: int
    source_commit: str
    source_run: int

    @classmethod
    def parse(cls, value, pins):
        require(len(pins) == 6, "Expected independent PARENT_PID PARENT_START PARENT_SHA CHILD_SHA COMMIT RUN pins")
        parent_pid, parent_start, parent_hash, child_hash, commit, run = pins
        require(re.fullmatch(r"[1-9][0-9]{0,9}", parent_pid) and 1 < int(parent_pid) < 2**31, "Invalid independently owned parent PID")
        decimal(parent_start, True)
        for digest in (parent_hash, child_hash):
            require(re.fullmatch(r"[a-f0-9]{64}", digest), "Invalid independently reviewed executable hash")
        require(re.fullmatch(r"[a-f0-9]{40}", commit), "Invalid independently reviewed source commit")
        require(re.fullmatch(r"[1-9][0-9]{0,15}", run) and int(run) <= 2**53 - 1, "Invalid independently reviewed run ID")
        exact_keys(value, "schemaVersion kind source parent child")
        require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
                and value["kind"] == "creator-hub-owned-sealed-child", "Unsupported launcher receipt")
        source, parent, child = value["source"], value["parent"], value["child"]
        exact_keys(source, "commit runId")
        exact_keys(parent, "pid startTime executable sha256")
        exact_keys(child, "pid startTime image")
        image = child["image"]
        exact_keys(image, "device inode size sha256 requiredSeals")
        require(type(source["runId"]) is int and source == {"commit": commit, "runId": int(run)}, "Receipt source differs from independent pins")
        require(type(parent["pid"]) is int and parent["pid"] == int(parent_pid)
                and parent["startTime"] == parent_start and parent["sha256"] == parent_hash, "Receipt launcher differs from owned parent pins")
        require(type(parent["executable"]) is str and os.path.isabs(parent["executable"])
                and os.path.normpath(parent["executable"]) == parent["executable"], "Exact parent executable path required")
        pathname_only(parent["executable"])
        require(type(child["pid"]) is int and 1 < child["pid"] < 2**31 and child["pid"] != parent["pid"], "Invalid sealed child PID")
        decimal(child["startTime"], True)
        require(image["sha256"] == child_hash, "Receipt child hash differs from reviewed payload")
        require(type(image["size"]) is int and 5 <= image["size"] <= 256 * 1024 * 1024, "Invalid sealed image size")
        require(type(image["requiredSeals"]) is int and image["requiredSeals"] == REQUIRED_SEALS, "Complete source-contract seals required")
        return cls(parent["pid"], parent_start, parent["executable"], parent_hash, child["pid"], child["startTime"], child_hash,
                   decimal(image["device"]), decimal(image["inode"], True), image["size"], commit, int(run))


def read_receipt(file, root, pins):
    require(os.path.isabs(file) and os.path.realpath(file) == file and os.path.realpath(root) == root
            and os.path.commonpath([file, root]) == root and file != root, "Owned receipt must be an unredirected runner-temp file")
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate launcher receipt key")
            result[key] = value
        return result
    fd = os.open(file, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(S.S_ISREG(before.st_mode) and S.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
                and before.st_uid == os.getuid() and 0 < before.st_size <= 8192, "Private owned bounded receipt required")
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read(8193)
        require(len(data) == before.st_size and file_identity(os.fstat(fd)) == file_identity(before), "Launcher receipt changed while reading")
        return Receipt.parse(json.loads(data.decode("utf8"), object_pairs_hook=pairs), pins)
    finally:
        os.close(fd)


class OpenImage:
    def __init__(self, fd):
        self.fd = fd

    def snapshot(self):
        import fcntl
        require(all(hasattr(fcntl, name) for name in ("F_GET_SEALS", "F_SEAL_WRITE", "F_SEAL_GROW", "F_SEAL_SHRINK", "F_SEAL_SEAL")),
                "Kernel seal query API unavailable")
        require(fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL == REQUIRED_SEALS, "Unexpected kernel seal ABI")
        before = os.fstat(self.fd)
        seals = fcntl.fcntl(self.fd, fcntl.F_GET_SEALS)
        require(seals & REQUIRED_SEALS == REQUIRED_SEALS, "Executable FD lacks required seals")
        require(S.S_ISREG(before.st_mode) and before.st_nlink == 0 and S.S_IMODE(before.st_mode) == 0o500
                and 5 <= before.st_size <= 256 * 1024 * 1024, "Unexpected anonymous executable FD properties")
        require(os.pread(self.fd, 5, 0) == b"\x7fELF\x02", "Approved 64-bit ELF executable required")
        digest, offset = hashlib.sha256(), 0
        while offset < before.st_size:
            chunk = os.pread(self.fd, min(65536, before.st_size - offset), offset)
            require(chunk, "Executable FD was truncated")
            digest.update(chunk)
            offset += len(chunk)
        require(file_identity(os.fstat(self.fd)) == file_identity(before) and fcntl.fcntl(self.fd, fcntl.F_GET_SEALS) == seals,
                "Executable FD changed while hashing")
        return {"device": str(before.st_dev), "inode": str(before.st_ino), "size": before.st_size,
                "sha256": digest.hexdigest(), "seals": seals}

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class KernelBinding:
    def __init__(self, receipt, proc):
        self.receipt, self.proc, self.held, self.baseline = receipt, proc, None, None
        self.parent = Request("snapshot", receipt.parent_pid, receipt.parent_start, receipt.parent_executable,
                              receipt.parent_hash, 0, "", "FRAME")
        try:
            self.check_parent()
            self.check_child(proc.stat(receipt.child_pid))
            self.held = proc.open_image(receipt.child_pid)
            self.verify()
        except Exception as error:
            try:
                self.close()
            except Exception as cleanup:
                raise RuntimeError(f"{error}; owned image FD cleanup failed: {cleanup}") from error
            raise

    def check_parent(self):
        identity(self.parent, self.proc)

    def check_child(self, record, live=True):
        require(parse_start(record, self.receipt.child_pid, require_live=live) == self.receipt.child_start, "Sealed child PID/start changed")
        fields = record[record.rfind(")") + 2:].split()
        require(fields[1].isdigit() and int(fields[1]) == self.receipt.parent_pid, "Sealed child direct PPID differs from owned launcher")

    def check_image(self, image):
        actual = image.snapshot()
        r = self.receipt
        require(actual["device"] == r.device and actual["inode"] == r.inode and actual["size"] == r.size,
                "Sealed executable FD dev/inode/size changed")
        require(actual["sha256"] == r.child_hash and actual["seals"] & REQUIRED_SEALS == REQUIRED_SEALS,
                "Sealed executable hash/seals changed")
        if self.baseline is None:
            self.baseline = dict(actual)
        require(actual == self.baseline, "Sealed descriptor identity changed from held-FD baseline")
        self.last_image = actual
        return actual

    def parent_and_image(self):
        self.check_parent()
        return self.check_image(self.held)

    def verify(self):
        self.parent_and_image()
        self.check_child(self.proc.stat(self.receipt.child_pid))
        # A held FD alone is insufficient: execve may have replaced the live child's image.
        with self.proc.open_image(self.receipt.child_pid) as current:
            self.check_image(current)
        self.check_child(self.proc.stat(self.receipt.child_pid))
        self.check_parent()

    def close(self):
        if self.held is not None:
            held, self.held = self.held, None
            held.close()


def parse_start(record, pid, require_live=True):
    require(len(record) <= 4096 and record.startswith(f"{pid} ("), "Invalid owned process stat")
    end = record.rfind(")")
    require(end > record.find("("), "Invalid process command field")
    fields = record[end + 2:].split()
    require(len(fields) >= 20 and fields[19].isdigit(), "Invalid owned process start field")
    require(not require_live or fields[0] not in ("Z", "X"), "Owned process is not live")
    return fields[19]


class Proc:
    def open_image(self, pid):
        return OpenImage(os.open(f"/proc/{pid}/exe", os.O_RDONLY | os.O_CLOEXEC))

    def exists(self, pid):
        return os.path.exists(f"/proc/{pid}")

    def stat(self, pid):
        with open(f"/proc/{pid}/stat", encoding="utf8") as stream:
            return stream.read(4097)

    def executable(self, pid):
        return os.readlink(f"/proc/{pid}/exe")

    def digest(self, pid):
        digest = hashlib.sha256()
        with open(f"/proc/{pid}/exe", "rb") as stream:
            require(0 < os.fstat(stream.fileno()).st_size <= 256 * 1024 * 1024, "Owned executable exceeds bound")
            total = 0
            while chunk := stream.read(65536):
                total += len(chunk)
                require(total <= 256 * 1024 * 1024, "Owned executable exceeds bound")
                digest.update(chunk)
        return digest.hexdigest()


def identity(request, proc, binding=None):
    if request.receipt is not None:
        require(binding is not None and request.receipt == binding.receipt and request.executable == ""
                and request.pid == binding.receipt.child_pid and request.start == binding.receipt.child_start
                and request.sha256 == binding.receipt.child_hash, "Explicit matching owned-launcher kernel binding required")
        binding.verify()
        return
    require(parse_start(proc.stat(request.pid), request.pid) == request.start, "Owned process start time changed")
    executable = proc.executable(request.pid)
    pathname_only(executable)
    require(executable == request.executable, "Owned executable path changed")
    require(proc.digest(request.pid) == request.sha256, "Owned executable hash changed")
    require(proc.executable(request.pid) == request.executable, "Owned executable path changed during verification")
    require(parse_start(proc.stat(request.pid), request.pid) == request.start, "Owned process changed during verification")


def ready(node, atspi):
    states = node.get_state_set()
    require(all(states.contains(getattr(atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE")),
            "Owned control/window is hidden or not enabled")
    require(not any(states.contains(getattr(atspi.StateType, s)) for s in ("DEFUNCT", "BUSY")), "Owned control/window is not actionable")


def children(node, limit=MAX_CHILDREN):
    count = node.get_child_count()
    require(0 <= count <= limit, "Accessibility child count exceeds bound")
    return [node.get_child_at_index(i) for i in range(count)]


def fresh_close_children(node, limit):
    node.clear_cache()
    count = node.get_child_count()
    require(type(count) is int and 0 <= count <= limit, "Root close child count exceeds bound")
    result = []
    for index in range(count):
        node.clear_cache()
        child = node.get_child_at_index(index)
        require(child is not None, "Root close child disappeared")
        result.append(child)
    node.clear_cache()
    require(node.get_child_count() == count, "Root close children changed during fresh read")
    return result


def select_window(request, atspi):
    # Inspect only application PID metadata until the sole owned root is selected.
    get_children = fresh_close_children if request.title == ROOT_CLOSE_TITLE else children
    roots = [app for app in get_children(atspi.get_desktop(0), 128) if app.get_process_id() == request.pid]
    require(len(roots) == 1, "Owned accessibility application is missing or ambiguous")
    windows = get_children(roots[0], 32)
    if request.title == ROOT_CLOSE_TITLE:
        for node in windows:
            node.clear_cache()
    require(request.gtk_message_info_frame is None or request.receipt is None or len(windows) == 1,
            "Expected one sealed backend AX top-level")
    require(request.gtk_message_info_frame is None or all(n.get_process_id() == request.pid for n in windows),
            "Foreign GTK message AX top-level refused")
    matches = [node for node in windows
               if node.get_name() == request.accessibility_name and node.get_role() == getattr(atspi.Role, request.role)]
    require(len(matches) == 1, "Exact owned accessibility window is missing or ambiguous")
    window = matches[0]
    require(window.get_process_id() == request.pid, "Accessibility window is not owned")
    ready(window, atspi)
    if request.gtk_message_info_frame is not None:
        component = window.get_component_iface()
        require(component is not None, "Native AX window geometry unavailable")
        rectangle = component.get_extents(atspi.CoordType.SCREEN)
        actual = (rectangle.x, rectangle.y, rectangle.width, rectangle.height)
        require(all(type(v) is int for v in actual) and actual == request.gtk_message_info_frame,
                f"Exact AX/native frame differs: {actual} != {request.gtk_message_info_frame}")
    return window


def walk(window, request):
    nodes, pending = [], [(window, 0)]
    while pending:
        node, depth = pending.pop()
        require(node is not None and len(nodes) < MAX_NODES and depth < MAX_DEPTH, "Accessibility tree exceeds bounds")
        require(node.get_process_id() == request.pid, "Foreign accessibility subtree refused")
        nodes.append(node)
        budget = min(MAX_CHILDREN, MAX_NODES - len(nodes) - len(pending))
        pending.extend((child, depth + 1) for child in reversed(children(node, budget)))
    return nodes


def root_close_tree(window, request, atspi, owner):
    """Exact native GTK profile only; no remote WebKit/semantic-parent exemption."""
    def wire(node):
        owner.node(node)
        canonical = owner.references.identity(node, owner)
        name, path = node.app.bus_name, node.path
        require(type(name) is str and 0 < len(name) <= 255 and type(path) is str and 0 < len(path) <= 256,
                "Bounded Root close AX wire identity required")
        require(type(canonical) is list and len(canonical) == 2, "Canonical Root close bus/object binding required")
        return tuple(canonical)
    owner.recheck(full=True)
    root_wire = wire(window)
    nodes, graph, seen, pending = [], [], set(), [(window, None, 0)]
    while pending:
        node, parent, depth = pending.pop()
        require(node is not None and len(nodes) < 64 and depth < 16, "Root close GTK tree exceeds bound")
        node.clear_cache()
        require(node.get_process_id() == request.pid, "Foreign Root close GTK node")
        reference, role, name = wire(node), node.get_role(), node.get_name()
        require(reference[0] == root_wire[0] and reference not in seen, "Foreign/duplicate/cyclic Root close AX wire")
        require(type(name) is str and len(name) <= 512, "Root close GTK name exceeds bound")
        if parent is not None:
            require(role not in {getattr(atspi.Role, key, -1) for key in ("FRAME", "WINDOW", "DIALOG", "ALERT", "APPLICATION")},
                    "Nested Root close GTK window")
            node.clear_cache()
            actual_parent = node.get_parent()
            known = None if actual_parent is None else owner.references.aliases.get(actual_parent.app.bus_name)
            require(known is not None and (known["owner"], actual_parent.path) == parent,
                    "Root close GTK Parent differs from forward edge")
        seen.add(reference)
        nodes.append(node)
        graph.append((reference, parent, int(role), name))
        kids = fresh_close_children(node, min(32, 64 - len(nodes) - len(pending)))
        pending.extend((child, reference, depth + 1) for child in reversed(kids))
    owner.recheck(full=True)
    return nodes, graph


def gtk_message_context(request, nodes, atspi):
    if request.gtk_message_info_frame is None:
        return
    windows = {getattr(atspi.Role, name, -1) for name in ("FRAME", "WINDOW", "DIALOG", "ALERT", "APPLICATION")}
    require(all(n.get_role() not in windows for n in nodes[1:]), "Nested GTK accessibility window refused")
    if request.title == "Open Setup in Creator Hub?":
        body = ("Run Project Setup inside this Creator Hub window?\n\n" + request.receipt.parent_executable
                + "\n\nThis preview uses your existing Setup operations. It does not install an app or change shortcuts. Only continue if you just chose Project Setup in Hub.")
    elif request.title == "Open MCP in Creator Hub?":
        body = ("Enable the normal MCP controls in this running Creator Hub?\n\n" + request.receipt.parent_executable
                + "\nSHA-256: " + request.receipt.parent_hash
                + "\n\nThis permits launcher settings, selected AI-client configuration and Unity bridge changes when you use their controls. Only approve the Hub you intentionally opened. "
                + "The direct parent and private pipes are checked. This fingerprint is a file snapshot, not a publisher signature or an immutable executable lock. "
                + "This does not install updates, adopt shortcuts, or stop any client.")
    elif request.title == ROOT_CLOSE_TITLE:
        require(request.receipt is None, "Root close cannot use sealed child ownership")
        body = ROOT_CLOSE_BODY
    else:
        require(request.title == "Enable managed MCP routing" and request.receipt is None, "Unknown GTK message context")
        body = ("Enable Creator Hub's managed MCP connection?\n\nA signed retained router will keep AI-client command paths stable across compatible Hub updates. "
                + "Existing client settings are not changed by this action. Moving their connections still requires your approval. Old apps and Unity projects stay in place.")
    for text in (request.title, body):
        labels = [node for node in nodes if node.get_role() == atspi.Role.LABEL and node.get_name() == text]
        require(len(labels) == 1, "Exact unique GTK context label required")
        ready(labels[0], atspi)
    controls = [node for node in nodes if node.get_role() == atspi.Role.PUSH_BUTTON]
    require(len(controls) == 2 and {n.get_name() for n in controls} == GTK_INFO_BUTTONS[request.title],
            "Exact two GTK permission controls required")


def button(request, nodes, atspi):
    gtk_message_context(request, nodes, atspi)
    matches = [node for node in nodes if node.get_role() == atspi.Role.PUSH_BUTTON and node.get_name() == request.button]
    require(len(matches) == 1, "Expected one exact owned permission button")
    node = matches[0]
    ready(node, atspi)
    interface = node.get_action_iface()
    # Accessible.get_name is label-only; this explicit Action alias avoids the GI collision.
    require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click",
            "Expected exactly one native click action")
    return node, interface


def window_comparison(window, expected, observed):
    """Diagnostic-only summaries of already-read values; never queries or authorizes X11."""
    require(type(window) is int and 0 < window < 2**32, "Diagnostic XID exceeds bound")
    def summary(info, unbound_client=False):
        require(type(info) is dict and type(info.get("pid")) is int and 1 < info["pid"] < 2**31
                and (unbound_client and info.get("client") is None or
                     type(info.get("client")) is int and 0 <= info["client"] < 2**32)
                and type(info.get("mapped")) is bool and type(info.get("title")) is str
                and len(info["title"].encode("utf8")) <= 256, "Window diagnostic exceeds bound")
        return {"xid": window, "pid": info["pid"], "client": info["client"], "mapped": info["mapped"],
                "titleSha256": hashlib.sha256(info["title"].encode("utf8")).hexdigest()}
    before, after = summary(expected, True), summary(observed)
    return {"diagnosticOnly": True, "expected": before, "observed": after,
            "matches": {"xid": True, "pid": before["pid"] == after["pid"],
                        "client": None if before["client"] is None else before["client"] == after["client"],
                        "mapped": before["mapped"] == after["mapped"],
                        "title": before["titleSha256"] == after["titleSha256"]},
            "clientPositive": after["client"] > 0}


def bound_window(request, x11):
    info = x11.inspect(request.window)
    try:
        require(info["pid"] == request.pid, "XRes window is not owned by target PID")
        require(info["title"] == request.title and info["mapped"], "Exact visible X window differs")
        require(info["client"] > 0, "Missing XRes client identity")
    except RuntimeError as error:
        try:
            # The request binds no exact client ID; a later capture can retain its known client separately.
            error.bound_window_diagnostic = window_comparison(request.window,
                {"pid": request.pid, "client": None, "title": request.title, "mapped": True}, info)
            error._bound_window_diagnostic_origin = _BOUND_WINDOW_DIAGNOSTIC_ORIGIN
        except Exception:
            pass  # Preserve the original refusal even when its optional diagnostic is unavailable.
        raise
    if request.gtk_message_info_frame is not None:
        require(x11.frame_rectangle(request.window) == request.gtk_message_info_frame, "Native dialog frame changed")
    return info


def perform(request, atspi, proc, x11, binding=None, *, root_close_owner=None):
    """Adapters exist for pure unit fixtures; main constructs only native implementations."""
    validate_gtk_frame(request.title, request.role, request.gtk_message_info_frame, sealed=request.receipt is not None)
    root_close = request.title == ROOT_CLOSE_TITLE
    if root_close:
        require(binding is None and root_close_owner is not None and request.action in ("snapshot", "click")
                and (not request.button if request.action == "snapshot" else request.button in GTK_INFO_BUTTONS[ROOT_CLOSE_TITLE]),
                "Exact pathname-owned Root close request required")
        require(all(getattr(root_close_owner.request, key) == getattr(request, key)
                    for key in ("pid", "start", "executable", "sha256")), "Root close owner identity differs")
        root_close_owner.recheck(full=True)
    identity(request, proc, binding)
    owned = bound_window(request, x11)
    window = select_window(request, atspi)
    nodes, graph = root_close_tree(window, request, atspi, root_close_owner) if root_close else (walk(window, request), None)
    gtk_message_context(request, nodes, atspi)
    result = {"pid": request.pid, "startTime": request.start, "executable": request.executable,
              "executableSha256": request.sha256, "window": str(request.window), "title": request.title,
              "executableBinding": "pathname-and-running-proc-image-hash",
              "role": request.role, "xresClient": str(owned["client"]), "action": request.action,
              "actionCount": 0, "normalExitVerified": False, "releaseReady": False}
    if request.gtk_message_info_frame is not None:
        result.update(axName=request.accessibility_name, nativeFrame=list(request.gtk_message_info_frame))
    if binding is not None:
        r = binding.receipt
        result.update(executable=None, executableBinding="sealed-proc-fd-and-owned-launcher", kernelImage=dict(binding.last_image),
                      launcher={"pid": r.parent_pid, "startTime": r.parent_start, "executableSha256": r.parent_hash},
                      source={"commit": r.source_commit, "runId": r.source_run})
    if request.action == "snapshot":
        result["nodes"] = [{"role": int(n.get_role()), "name": (n.get_name() or "")[:256],
                            **{s.lower(): n.get_state_set().contains(getattr(atspi.StateType, s))
                               for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}} for n in nodes]
        identity(request, proc, binding)
        require(bound_window(request, x11) == owned and select_window(request, atspi) == window, "Owned window drifted during snapshot")
        if root_close:
            root_close_owner.recheck(full=True)
    else:
        selected = button(request, nodes, atspi)[0] if request.action == "click" else None
        if request.action == "close":
            x11.check_close(request.window)
        # Re-read the actual window/control and process immediately before the single effect.
        identity(request, proc, binding)
        require(bound_window(request, x11) == owned, "Owned X window changed before action")
        require(select_window(request, atspi) == window, "Owned accessibility window changed before action")
        if selected is not None:
            current_nodes, current_graph = root_close_tree(window, request, atspi, root_close_owner) if root_close else (walk(window, request), None)
            require(not root_close or graph == current_graph, "Fresh Root close GTK graph changed")
            current, interface = button(request, current_nodes, atspi)
            require(current == selected, "Owned permission button changed before action")
        if binding is not None:
            # Repeat the kernel/launcher proof at the final input boundary, not only at discovery.
            binding.verify()
            require(bound_window(request, x11) == owned and select_window(request, atspi) == window,
                    "Owned sealed-child window changed immediately before action")
            if selected is not None:
                current, interface = button(request, walk(window, request), atspi)
                require(current == selected, "Owned permission button changed immediately before action")
        try:
            if root_close:
                root_close_owner.recheck(full=True)
            if selected is not None:
                require(interface.do_action(0), "Native click was refused; do not retry")
                result["button"] = request.button
            else:
                x11.close_window(request.window, owned)
            result["actionCount"] = 1
            if root_close:
                root_close_owner.recheck(full=True)
            # Terminal actions may destroy the process. Only its parent can reap exit status.
            try:
                if binding is not None:
                    binding.parent_and_image()
                record = proc.stat(request.pid)
                require(parse_start(record, request.pid, require_live=False) == request.start, "Owned process changed after action")
                if binding is not None:
                    binding.check_child(record, live=False)
                if record[record.rfind(")") + 2:].split()[0] in ("Z", "X"):
                    result["processAfter"] = "not-live-unverified-exit"
                else:
                    identity(request, proc, binding)
                    result["processAfter"] = "live-verified"
            except FileNotFoundError:
                if binding is not None:
                    # Missing parent/image is never mistaken for an expected terminal child exit.
                    binding.parent_and_image()
                require(not proc.exists(request.pid), "Owned process identity became unavailable")
                result["processAfter"] = "absent-unverified-exit"
        except Exception as error:
            raise ActionError(str(error)) from error
    require(len(json.dumps(result).encode("utf8")) <= 196608, "Owned snapshot exceeds output bound")
    return result


class ClientSpec(C.Structure):
    _fields_ = [("client", C.c_ulong), ("mask", C.c_uint)]


class ClientValue(C.Structure):
    _fields_ = [("spec", ClientSpec), ("length", C.c_long), ("value", C.c_void_p)]


class WindowAttributes(C.Structure):
    _fields_ = [(name, kind) for name, kind in (
        ("x", C.c_int), ("y", C.c_int), ("width", C.c_int), ("height", C.c_int), ("border", C.c_int), ("depth", C.c_int),
        ("visual", C.c_void_p), ("root", C.c_ulong), ("class_", C.c_int), ("bit_gravity", C.c_int), ("win_gravity", C.c_int),
        ("backing_store", C.c_int), ("backing_planes", C.c_ulong), ("backing_pixel", C.c_ulong), ("save_under", C.c_int),
        ("colormap", C.c_ulong), ("map_installed", C.c_int), ("map_state", C.c_int), ("all_event_masks", C.c_long),
        ("your_event_mask", C.c_long), ("do_not_propagate_mask", C.c_long), ("override_redirect", C.c_int), ("screen", C.c_void_p))]


class MessageData(C.Union):
    _fields_ = [("b", C.c_char * 20), ("s", C.c_short * 10), ("l", C.c_long * 5)]


class Message(C.Structure):
    _fields_ = [("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int), ("display", C.c_void_p),
                ("window", C.c_ulong), ("message_type", C.c_ulong), ("format", C.c_int), ("data", MessageData)]


class Event(C.Union):
    _fields_ = [("message", Message), ("padding", C.c_long * 24)]


class XErrorEvent(C.Structure):
    # Xlib.h's LP64 layout; fixed-width longs also let pure fixtures verify the ABI on Windows.
    _fields_ = [("type", C.c_int), ("display", C.c_void_p), ("resourceid", C.c_uint64),
                ("serial", C.c_uint64), ("error_code", C.c_ubyte),
                ("request_code", C.c_ubyte), ("minor_code", C.c_ubyte)]


X_ERROR_STAGES = ("unmarked", "target-guard", "keycode", "press-submit", "release-submit", "press-sync", "release-sync")


class X11:
    def __init__(self):
        require(re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", os.environ.get("DISPLAY", "")), "Local runner DISPLAY required")
        require(C.sizeof(C.c_long) == 8, "Native LP64 X11 ABI required")
        self.x = C.CDLL("libX11.so.6")
        self.res = C.CDLL("libXRes.so.1")
        signatures = {
            "XOpenDisplay": ([C.c_char_p], C.c_void_p), "XCloseDisplay": ([C.c_void_p], C.c_int),
            "XConnectionNumber": ([C.c_void_p], C.c_int), "XSync": ([C.c_void_p, C.c_int], C.c_int),
            "XSetErrorHandler": ([C.c_void_p], C.c_void_p), "XDefaultRootWindow": ([C.c_void_p], C.c_ulong),
            "XInternAtom": ([C.c_void_p, C.c_char_p, C.c_int], C.c_ulong), "XFree": ([C.c_void_p], C.c_int),
            "XGetWindowAttributes": ([C.c_void_p, C.c_ulong, C.POINTER(WindowAttributes)], C.c_int),
            "XTranslateCoordinates": ([C.c_void_p, C.c_ulong, C.c_ulong, C.c_int, C.c_int,
                                       C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong)], C.c_int),
            "XGetWindowProperty": ([C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong,
                                   C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_void_p)], C.c_int),
            "XSendEvent": ([C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(Event)], C.c_int),
        }
        for name, (args, result) in signatures.items():
            getattr(self.x, name).argtypes, getattr(self.x, name).restype = args, result
        for name, args, result in (
            ("XResQueryExtension", [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)], C.c_int),
            ("XResQueryVersion", [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)], C.c_int),
            ("XResQueryClientIds", [C.c_void_p, C.c_long, C.POINTER(ClientSpec), C.POINTER(C.c_long), C.POINTER(C.POINTER(ClientValue))], C.c_int),
            ("XResGetClientPid", [C.POINTER(ClientValue)], C.c_int),
            ("XResClientIdsDestroy", [C.c_long, C.POINTER(ClientValue)], None)):
            getattr(self.res, name).argtypes, getattr(self.res, name).restype = args, result
        self.display = self.x.XOpenDisplay(None)
        require(self.display, "Cannot open runner X display")
        self.error = False
        self.error_events, self.error_events_truncated, self.error_capture_unavailable = [], False, False
        self.x_error_stage = "unmarked"
        self.handler = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)(self._error)
        self.previous_handler = self.x.XSetErrorHandler(C.cast(self.handler, C.c_void_p))
        try:
            with socket.socket(fileno=os.dup(self.x.XConnectionNumber(self.display))) as connection:
                require(connection.family == socket.AF_UNIX, "Local Unix-socket X display required")
            major, minor, event, error = (C.c_int() for _ in range(4))
            require(self.res.XResQueryExtension(self.display, C.byref(event), C.byref(error)), "XRes extension required")
            require(self.res.XResQueryVersion(self.display, C.byref(major), C.byref(minor))
                    and major.value == 1 and minor.value >= 2, "XRes 1.2 required")
        except Exception:
            self.dispose()
            raise

    def _error(self, _display, _event):
        self.error = True
        try:
            if not hasattr(self, "error_events"):
                self.error_events = []
            if len(self.error_events) >= 8:
                self.error_events_truncated = True
                return 0
            require(_event and C.sizeof(XErrorEvent) == 40
                    and [getattr(XErrorEvent, name).offset for name in
                         ("display", "resourceid", "serial", "error_code", "request_code", "minor_code")]
                    == [8, 16, 24, 32, 33, 34], "Diagnostic XErrorEvent ABI unavailable")
            event = C.cast(_event, C.POINTER(XErrorEvent)).contents
            stage = getattr(self, "x_error_stage", "unmarked")
            self.error_events.append(dict(errorCode=int(event.error_code), requestCode=int(event.request_code),
                minorCode=int(event.minor_code), serial=int(event.serial), resourceId=int(event.resourceid),
                sameDisplay=_display == self.display and event.display == self.display,
                stage=stage if stage in X_ERROR_STAGES else "unmarked"))
        except Exception:
            self.error_capture_unavailable = True
        return 0

    def error_diagnostic(self):
        value = dict(schemaVersion=1, kind="x11-protocol-error", readOnly=True, inputPermitted=False,
            authorityGranted=False, releaseReady=False, latchSet=self.error is True,
            events=getattr(self, "error_events", [])[:8],
            truncated=getattr(self, "error_events_truncated", False),
            captureUnavailable=getattr(self, "error_capture_unavailable", False))
        raw = json.dumps(value, allow_nan=False)
        require(len(raw.encode()) <= 4096, "Bounded X error diagnostic required")
        return json.loads(raw)

    def sync(self):
        self.x.XSync(self.display, 0)
        try:
            require(not self.error, "Owned X resource query was refused")
        except RuntimeError as error:
            try:
                error.focus_diagnostic = self.error_diagnostic()
            except Exception:
                pass
            raise

    def atom(self, name):
        return self.x.XInternAtom(self.display, name.encode("ascii"), 1)

    def property(self, window, name):
        atom = self.atom(name)
        if not atom:
            return None
        kind, fmt, count, remaining, value = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong(), C.c_void_p()
        status = self.x.XGetWindowProperty(self.display, window, atom, 0, 256, 0, 0,
                                          C.byref(kind), C.byref(fmt), C.byref(count), C.byref(remaining), C.byref(value))
        try:
            self.sync()
            require(status == 0 and not remaining.value and count.value <= 256, "X property exceeds bound or was refused")
            if not kind.value:
                return None
            require(value and fmt.value in (8, 32), "Unexpected X property format")
            data = (C.string_at(value, count.value) if fmt.value == 8 else
                    list(C.cast(value, C.POINTER(C.c_ulong))[:count.value]))
            return kind.value, fmt.value, data
        finally:
            if value:
                self.x.XFree(value)

    def inspect(self, window):
        self.error = False
        attrs = WindowAttributes()
        require(self.x.XGetWindowAttributes(self.display, window, C.byref(attrs)), "Owned X window is unavailable")
        self.sync()
        try:
            require(attrs.map_state == 2 and not attrs.override_redirect, "Owned X window is not a managed visible window")
        except RuntimeError as error:
            try:
                raw = {'window': window, 'map_state': attrs.map_state, 'override_redirect': attrs.override_redirect, 'class': attrs.class_}
                if type(window) is int and 0 <= window < 2**32 and all(
                        type(raw[key]) is int and -(2**31) <= raw[key] < 2**31 for key in ('map_state', 'override_redirect', 'class')):
                    error.window_visibility_refusal = raw
                    error._visibility_diagnostic_origin = _VISIBILITY_DIAGNOSTIC_ORIGIN
            except Exception:
                pass  # Preserve the same visibility refusal if metadata cannot be attached.
            raise
        count, values = C.c_long(), C.POINTER(ClientValue)()
        spec = ClientSpec(window, 2)
        status = self.res.XResQueryClientIds(self.display, 1, C.byref(spec), C.byref(count), C.byref(values))
        try:
            self.sync()
            # This XRes API returns Success (zero), unlike QueryVersion's Bool.
            require(status == 0 and count.value == 1 and values, "No unique XRes socket-client PID")
            item = values[0]
            require(item.spec.mask == 2 and item.length == 4 and item.value, "Invalid XRes PID value")
            pid = self.res.XResGetClientPid(C.byref(values[0]))
            require(pid > 1 and item.spec.client > 0, "No live local XRes PID")
            client = item.spec.client
        finally:
            if values and 0 <= count.value <= 16:
                self.res.XResClientIdsDestroy(count, values)
        title = self.property(window, "_NET_WM_NAME") or self.property(window, "WM_NAME")
        require(title and title[1] == 8 and title[0] in (31, self.atom("UTF8_STRING")), "Exact native X title unavailable")
        require(self.x.XGetWindowAttributes(self.display, window, C.byref(attrs)), "Owned X window disappeared")
        self.sync()
        require(not attrs.override_redirect, "Owned X window became unmanaged")
        return {"pid": pid, "client": client, "title": title[2].decode("utf8"), "mapped": attrs.map_state == 2}

    def frame_rectangle(self, window):
        # GTK's native window Component reports gdk_window_get_frame_extents.
        # EWMH defines the four WM-added borders in client-window coordinates.
        extents = self.property(window, "_NET_FRAME_EXTENTS")
        require(extents and extents[:2] == (6, 32) and len(extents[2]) == 4
                and all(type(v) is int and 0 <= v <= 8192 for v in extents[2]), "Exact WM frame extents unavailable")
        attrs, screen = WindowAttributes(), WindowAttributes()
        root = self.x.XDefaultRootWindow(self.display)
        require(self.x.XGetWindowAttributes(self.display, window, C.byref(attrs))
                and self.x.XGetWindowAttributes(self.display, root, C.byref(screen)), "Native frame geometry unavailable")
        x, y, child = C.c_int(), C.c_int(), C.c_ulong()
        require(self.x.XTranslateCoordinates(self.display, window, root, 0, 0, C.byref(x), C.byref(y), C.byref(child)),
                "Native frame origin unavailable")
        self.sync()
        left, right, top, bottom = extents[2]
        result = (x.value-left, y.value-top, attrs.width+left+right, attrs.height+top+bottom)
        require(attrs.map_state == 2 and not attrs.override_redirect and attrs.width > 0 and attrs.height > 0
                and 0 < screen.width <= 8192 and 0 < screen.height <= 8192
                and result[0] >= 0 and result[1] >= 0 and result[0]+result[2] <= screen.width
                and result[1]+result[3] <= screen.height, "Native dialog frame is not wholly visible/bounded")
        require(self.property(window, "_NET_FRAME_EXTENTS") == extents, "WM frame extents changed during read")
        return result

    def check_close(self, window):
        root = self.x.XDefaultRootWindow(self.display)
        wm = self.property(root, "_NET_SUPPORTING_WM_CHECK")
        require(wm and wm[0:2] == (33, 32) and len(wm[2]) == 1 and wm[2][0] > 0, "Normal EWMH window manager required")
        require(self.property(wm[2][0], "_NET_SUPPORTING_WM_CHECK") == wm, "Window manager readiness differs")
        supported, protocols = self.property(root, "_NET_SUPPORTED"), self.property(window, "WM_PROTOCOLS")
        require(supported and supported[0:2] == (4, 32) and self.atom("_NET_CLOSE_WINDOW") in supported[2], "Normal WM close is unsupported")
        require(protocols and protocols[0:2] == (4, 32) and self.atom("WM_DELETE_WINDOW") in protocols[2], "No normal delete protocol; kill fallback forbidden")

    def close_window(self, window, expected):
        self.check_close(window)
        require(self.inspect(window) == expected, "Owned X window changed immediately before normal close")
        event = Event()
        event.message.type, event.message.display, event.message.window = 33, self.display, window
        event.message.message_type, event.message.format = self.atom("_NET_CLOSE_WINDOW"), 32
        event.message.data.l[0], event.message.data.l[1] = 0, 2
        require(self.x.XSendEvent(self.display, self.x.XDefaultRootWindow(self.display), 0,
                                 (1 << 19) | (1 << 20), C.byref(event)), "Normal WM close request refused")
        self.sync()

    def dispose(self):
        if self.display:
            self.x.XCloseDisplay(self.display)
            self.x.XSetErrorHandler(self.previous_handler)
            self.display = None


def main():
    # This must precede parsing, GI import, native-library loading and all /proc/app reads.
    ensure_runner(os.environ, sys.platform, platform.machine())
    args = sys.argv[1:]
    if args and args[0] == "--sealed-receipt":
        require(len(args) in (12, 13), "Use --sealed-receipt FILE PARENT_PID PARENT_START PARENT_SHA CHILD_SHA COMMIT RUN ACTION XID TITLE ROLE [BUTTON]")
        receipt = read_receipt(args[1], os.environ["RUNNER_TEMP"], args[2:8])
        request = Request.sealed(args[8:], receipt)
    else:
        request = Request.parse(args)
    proc, x11, binding, failure = Proc(), None, None, None
    try:
        if request.receipt is not None:
            binding = KernelBinding(request.receipt, proc)
        identity(request, proc, binding)
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(3000, 3000)
        x11 = X11()
        result = perform(request, Atspi, proc, x11, binding)
    except Exception as error:
        failure = error
        raise
    finally:
        errors = []
        for resource, close in ((x11, "dispose"), (binding, "close")):
            if resource is not None:
                try:
                    getattr(resource, close)()
                except Exception as error:
                    errors.append(str(error))
        if errors:
            message = f"{failure}; " if failure else ""
            message += "Owned helper resource cleanup failed: " + "; ".join(errors)
            error_type = ActionError if getattr(failure, "action_may_have_run", False) or failure is None else RuntimeError
            raise error_type(message) from failure
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {str(error)[:1000]}",
                          "actionMayHaveRun": bool(getattr(error, "action_may_have_run", False)),
                          "normalExitVerified": False, "releaseReady": False}), file=sys.stderr)
        sys.exit(1)
