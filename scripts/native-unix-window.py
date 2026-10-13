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
BUTTONS = {
    "Open MCP in Creator Hub?": {"Not now", "Enable MCP controls", "Open read-only preview"},
    "Open Setup in Creator Hub?": {"Not now", "Open in Hub"},
    "Enable managed MCP routing": {"Not now", "Enable managed routing"},
}


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

    @classmethod
    def parse(cls, args):
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
        return cls(action, int(pid), start, executable, digest, xid, title, role, button)

    @classmethod
    def sealed(cls, args, receipt):
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
        return cls(action, receipt.child_pid, receipt.child_start, "", receipt.child_hash, xid, title, role, control, receipt)


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


def select_window(request, atspi):
    # Inspect only application PID metadata until the sole owned root is selected.
    roots = [app for app in children(atspi.get_desktop(0), 128) if app.get_process_id() == request.pid]
    require(len(roots) == 1, "Owned accessibility application is missing or ambiguous")
    matches = [node for node in children(roots[0], 32)
               if node.get_name() == request.title and node.get_role() == getattr(atspi.Role, request.role)]
    require(len(matches) == 1, "Exact owned accessibility window is missing or ambiguous")
    window = matches[0]
    require(window.get_process_id() == request.pid, "Accessibility window is not owned")
    ready(window, atspi)
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


def button(request, nodes, atspi):
    matches = [node for node in nodes if node.get_role() == atspi.Role.PUSH_BUTTON and node.get_name() == request.button]
    require(len(matches) == 1, "Expected one exact owned permission button")
    node = matches[0]
    ready(node, atspi)
    interface = node.get_action_iface()
    # Accessible.get_name is label-only; this explicit Action alias avoids the GI collision.
    require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click",
            "Expected exactly one native click action")
    return node, interface


def bound_window(request, x11):
    info = x11.inspect(request.window)
    require(info["pid"] == request.pid, "XRes window is not owned by target PID")
    require(info["title"] == request.title and info["mapped"], "Exact visible X window differs")
    require(info["client"] > 0, "Missing XRes client identity")
    return info


def perform(request, atspi, proc, x11, binding=None):
    """Adapters exist for pure unit fixtures; main constructs only native implementations."""
    identity(request, proc, binding)
    owned = bound_window(request, x11)
    window = select_window(request, atspi)
    nodes = walk(window, request)
    result = {"pid": request.pid, "startTime": request.start, "executable": request.executable,
              "executableSha256": request.sha256, "window": str(request.window), "title": request.title,
              "executableBinding": "pathname-and-running-proc-image-hash",
              "role": request.role, "xresClient": str(owned["client"]), "action": request.action,
              "actionCount": 0, "normalExitVerified": False, "releaseReady": False}
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
    else:
        selected = button(request, nodes, atspi)[0] if request.action == "click" else None
        if request.action == "close":
            x11.check_close(request.window)
        # Re-read the actual window/control and process immediately before the single effect.
        identity(request, proc, binding)
        require(bound_window(request, x11) == owned, "Owned X window changed before action")
        require(select_window(request, atspi) == window, "Owned accessibility window changed before action")
        if selected is not None:
            current, interface = button(request, walk(window, request), atspi)
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
            if selected is not None:
                require(interface.do_action(0), "Native click was refused; do not retry")
                result["button"] = request.button
            else:
                x11.close_window(request.window, owned)
            result["actionCount"] = 1
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


class X11:
    def __init__(self):
        require(re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", os.environ.get("DISPLAY", "")), "Local runner DISPLAY required")
        require(C.sizeof(C.c_long) == 8, "Native LP64 X11 ABI required")
        self.x = C.CDLL("libX11.so.6")
        self.res = C.CDLL("libXres.so.1")
        signatures = {
            "XOpenDisplay": ([C.c_char_p], C.c_void_p), "XCloseDisplay": ([C.c_void_p], C.c_int),
            "XConnectionNumber": ([C.c_void_p], C.c_int), "XSync": ([C.c_void_p, C.c_int], C.c_int),
            "XSetErrorHandler": ([C.c_void_p], C.c_void_p), "XDefaultRootWindow": ([C.c_void_p], C.c_ulong),
            "XInternAtom": ([C.c_void_p, C.c_char_p, C.c_int], C.c_ulong), "XFree": ([C.c_void_p], C.c_int),
            "XGetWindowAttributes": ([C.c_void_p, C.c_ulong, C.POINTER(WindowAttributes)], C.c_int),
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
        return 0

    def sync(self):
        self.x.XSync(self.display, 0)
        require(not self.error, "Owned X resource query was refused")

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
        require(attrs.map_state == 2 and not attrs.override_redirect, "Owned X window is not a managed visible window")
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
