"""Import-only, single-attempt keyboard candidate for the owned Flatpak launcher.

The caller retains its independently owned launch guard and verifies the dialog
phase and actual outcome. X focus is NOT GTK widget focus. In particular,
ShiftTabSpace is only a source-backed candidate, pending native qualification.
This module never uses AX, global keyboard injection, focus changes or a retry.
"""
import copy
import ctypes as C
import hashlib
import json
import os
import platform
import re
import stat
import sys
import threading

MAX_IMAGE = 64 * 1024 * 1024
MAX_ATTEMPTS = 256
IMAGE_FIELDS = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")
CONTINUITY_FIELDS = ("pid", "parentPid", "startTime", "uids")
SEQUENCES = {
    "Escape": ((0xff1b, 0),),
    "Enter": ((0xff0d, 0),),
    "ShiftTabSpace": ((0xff09, 1), (0x20, 0)),
}
_ATTEMPTS = set()
_RESERVATION_LOCK = threading.Lock()
_WARM_ROOT_AUTHORITY = object()


def require(value, message):
    if not value:
        raise RuntimeError(message)


def xid(value):
    require(type(value) is int and 1 < value < 2**32, "An explicit ordinary XID is required")
    return value


def image_stamp(value):
    return tuple(getattr(value, key) for key in (*IMAGE_FIELDS, "st_nlink"))


class HeldImage:
    def __init__(self, pid):
        require(type(pid) is int and 1 < pid < 2**31, "Exact kernel PID required")
        # /proc/PID/exe is intentionally the kernel link, never a caller pathname.
        self.fd = os.open(f"/proc/{pid}/exe", os.O_RDONLY | os.O_CLOEXEC)

    def snapshot(self):
        before = os.fstat(self.fd)
        require(stat.S_ISREG(before.st_mode) and before.st_mode & 0o111 and 5 <= before.st_size <= MAX_IMAGE,
                "Bounded executable kernel FD required")
        require(os.pread(self.fd, 5, 0) == b"\x7fELF\x02", "64-bit ELF kernel image required")
        digest, offset = hashlib.sha256(), 0
        while offset < before.st_size:
            chunk = os.pread(self.fd, min(65536, before.st_size - offset), offset)
            require(chunk, "Kernel image truncated")
            digest.update(chunk)
            offset += len(chunk)
        require(image_stamp(os.fstat(self.fd)) == image_stamp(before), "Held kernel image changed")
        return {key: str(getattr(before, key)) for key in IMAGE_FIELDS}, digest.hexdigest()

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)


class ProtectedBwrap(HeldImage):
    """Read-only system provenance, anchored at /; no caller-selected pathname."""
    def __init__(self):
        require(sys.platform == "linux", "Native Linux protected system image required")
        self.fd, self.directories = None, []
        try:
            flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY
            parent = None
            for name in ("/", "usr", "bin"):
                fd = os.open(name, flags, **({"dir_fd": parent} if parent is not None else {}))
                self.directories.append((parent, name, fd, None))
                info = os.fstat(fd)
                self.directories[-1] = parent, name, fd, self.directory_stamp(info)
                self.protected_directory(info)
                parent = fd
            self.fd = os.open("bwrap", os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            self.file_identity = image_stamp(os.fstat(self.fd))
            self.snapshot()
        except Exception:
            self.close()
            raise

    @staticmethod
    def directory_stamp(info):
        return tuple(getattr(info, key) for key in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid"))

    @staticmethod
    def protected_directory(info):
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                "Protected root-owned bwrap ancestry required")

    def recheck(self):
        require(self.fd is not None and len(self.directories) == 3, "Protected bwrap binding is closed")
        for parent, name, fd, expected in self.directories:
            held = os.fstat(fd)
            named = os.stat(name, follow_symlinks=False, **({"dir_fd": parent} if parent is not None else {}))
            self.protected_directory(held)
            require(self.directory_stamp(held) == expected == self.directory_stamp(named), "Protected bwrap ancestry changed")
        held = os.fstat(self.fd)
        named = os.stat("bwrap", dir_fd=self.directories[-1][2], follow_symlinks=False)
        require(stat.S_ISREG(held.st_mode) and held.st_uid == held.st_gid == 0 and held.st_mode & 0o111
                and not held.st_mode & 0o7022 and held.st_nlink >= 1,
                "Protected root-owned ordinary bwrap executable required")
        require(image_stamp(held) == self.file_identity == image_stamp(named), "Protected bwrap pathname/image changed")

    def snapshot(self):
        self.recheck()
        result = super().snapshot()
        self.recheck()
        return result

    def close(self):
        try:
            super().close()
        finally:
            while self.directories:
                os.close(self.directories.pop()[2])


def validate_process(value, *, full):
    keys = {"pid", "parentPid", "startTime", "uids", "executable", "image"}
    require(type(value) is dict and set(value) == keys | ({"kernelImageSha256"} if full else set()), "Exact process record required")
    require(all(type(value[key]) is int and 1 <= value[key] < 2**31 for key in ("pid", "parentPid"))
            and value["pid"] > 1 and type(value["startTime"]) is str
            and re.fullmatch(r"[1-9][0-9]{0,19}", value["startTime"]), "Exact PID/parent/start tuple required")
    require(type(value["uids"]) is list and len(value["uids"]) == 4
            and all(type(v) is int and 0 < v < 2**31 for v in value["uids"])
            and len(set(value["uids"])) == 1, "Ordinary owned process UID tuple required")
    image = value["image"]
    require(type(image) is dict and set(image) == set(IMAGE_FIELDS)
            and all(type(v) is str and re.fullmatch(r"[0-9]{1,20}", v) for v in image.values()), "Exact kernel image metadata required")
    require(type(value["executable"]) is str and value["executable"].startswith("/")
            and len(value["executable"]) <= 4096 and "\x00" not in value["executable"]
            and not value["executable"].endswith(" (deleted)"), "Exact live executable path required")
    if full:
        require(type(value["kernelImageSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["kernelImageSha256"]),
                "Reviewed kernel image hash required")


class OwnedLauncher:
    """Native adapters are supplied by the trusted controller; fixtures may fake them."""
    def __init__(self, helper, native, process, owned_launch, launch_guard, *, image_open=HeldImage, system_open=ProtectedBwrap):
        validate_process(process, full=True)
        require(type(owned_launch) is dict, "Owned launch record required")
        validate_process(owned_launch, full="kernelImageSha256" in owned_launch)
        require(process["executable"] == "/app/bin/creator-hub-flatpak-activate"
                and owned_launch["executable"] in ("/usr/bin/flatpak", "/usr/bin/bwrap") and process["pid"] != owned_launch["pid"]
                and process["uids"] == owned_launch["uids"] and callable(launch_guard), "Exact owned Flatpak launch required")
        self.helper, self.native, self.launch_guard = helper, native, launch_guard
        self.process, self.origin = copy.deepcopy(process), copy.deepcopy(owned_launch)
        self.image_open, self.held, self.chain = image_open, None, None
        self.launch, self.launch_held, self.system = None, None, None
        try:
            self.launch_guard()
            self.system = system_open()
            current = self.native.native_process(self.origin["pid"], helper)
            validate_process(current, full=True)
            require(current["executable"] == "/usr/bin/bwrap" and all(
                current[key] == self.origin[key] for key in CONTINUITY_FIELDS), "Owned Popen continuity changed before bwrap admission")
            if self.origin["executable"] == "/usr/bin/bwrap":
                require(all(current[key] == value for key, value in self.origin.items()), "Recorded post-exec bwrap changed")
            expected = current["image"], current["kernelImageSha256"]
            require(self.system.snapshot() == expected, "Popen kernel image differs from protected system bwrap")
            self.launch_held = image_open(current["pid"])
            require(self.launch_held.snapshot() == expected, "Popen changed while holding bwrap image")
            self.launch = copy.deepcopy(current)
            require(self.native.native_process(process["pid"], helper) == self.process, "Launcher changed before holding image")
            self.held = image_open(process["pid"])
            self.verify()
        except Exception:
            self.close()
            raise

    @property
    def provenance(self):
        return {"readOnly": True, "popen": {key: copy.deepcopy(self.origin[key]) for key in CONTINUITY_FIELDS},
                "admittedLaunch": copy.deepcopy(self.launch), "systemImage": {"path": "/usr/bin/bwrap",
                "image": copy.deepcopy(self.launch["image"]), "kernelImageSha256": self.launch["kernelImageSha256"],
                "protectedRootOwned": True}}

    def verify_launch(self):
        require(self.launch is not None and self.system is not None and self.launch_held is not None, "Owned bwrap binding is closed")
        self.launch_guard()
        require(self.native.native_process(self.launch["pid"], self.helper) == self.launch, "Admitted Popen PID/start/parent/UID/image changed")
        expected = self.launch["image"], self.launch["kernelImageSha256"]
        require(self.system.snapshot() == expected and self.launch_held.snapshot() == expected, "Protected or held bwrap image changed")
        current = self.image_open(self.launch["pid"])
        try:
            require(current.snapshot() == expected, "Live Popen no longer has its admitted bwrap executable")
        finally:
            current.close()
        require(self.native.native_process(self.launch["pid"], self.helper) == self.launch, "Popen changed during verification")
        self.launch_guard()

    def ancestry(self):
        current, seen, rows = self.process, {self.process["pid"]}, []
        for _ in range(16):
            parent = current["parentPid"]
            require(parent not in seen, "Cyclic owned launcher ancestry")
            seen.add(parent)
            full = parent == self.launch["pid"]
            row = self.native.native_process(parent, self.helper, full)
            validate_process(row, full=full)
            require(row["pid"] == parent and row["uids"] == self.process["uids"]
                    and int(row["startTime"]) <= int(current["startTime"]), "Launcher left its owned ancestry")
            rows.append(row)
            if parent == self.launch["pid"]:
                require(row == self.launch, "Independently owned Flatpak launch changed")
                return rows
            current = row
        raise RuntimeError("Owned launcher ancestry exceeds bound")

    def verify(self):
        require(self.held is not None, "Held launcher image is closed")
        self.verify_launch()
        require(self.native.native_process(self.process["pid"], self.helper) == self.process, "Launcher PID/start/image/UID changed")
        expected = self.process["image"], self.process["kernelImageSha256"]
        require(self.held.snapshot() == expected, "Held launcher executable changed")
        current = self.image_open(self.process["pid"])
        try:
            require(current.snapshot() == expected, "Live launcher no longer has its held executable")
        finally:
            current.close()
        rows = self.ancestry()
        if self.chain is None:
            self.chain = copy.deepcopy(rows)
        require(rows == self.chain and self.ancestry() == self.chain, "Owned launcher ancestry changed")
        require(self.native.native_process(self.process["pid"], self.helper) == self.process, "Launcher changed during verification")
        self.verify_launch()

    def close(self):
        for name in ("held", "launch_held", "system"):
            held = getattr(self, name)
            if held is not None:
                setattr(self, name, None)
                held.close()


class WarmRoot:
    """Opaque, single native Root companion; never a window/process allowlist."""
    def __init__(self, helper, native, x11, process, window, owner, owner_probe, *, _authority=None, image_open=HeldImage):
        require(_authority is _WARM_ROOT_AUTHORITY, "Use the finite native Root binding factory")
        validate_process(process, full=True)
        require(process['executable'].endswith('/AppDir/usr/bin/creator-hub')
                and 5 <= int(process['image']['st_size']) <= MAX_IMAGE, "Exact bounded native portable Root required")
        require(type(owner) is dict and set(owner) == {'name', 'pid'} and type(owner['pid']) is int
                and owner['pid'] == process['pid'] and type(owner['name']) is str
                and len(owner['name']) <= 255 and re.fullmatch(r':[0-9]+\.[0-9]+', owner['name']) and callable(owner_probe),
                "Exact Host1 unique owner must belong to this native Root")
        self.helper, self.native, self.x11 = helper, native, x11
        self.process, self.window, self.owner = copy.deepcopy(process), xid(window), copy.deepcopy(owner)
        self.owner_probe, self.image_open, self.held = owner_probe, image_open, None
        try:
            self.window_owner = self.window_identity()
            self.held = image_open(process['pid'])
            self.verify()
        except Exception:
            self.close()
            raise

    def window_identity(self):
        value = self.x11.inspect(self.window)
        require(type(value) is dict and set(value) == {'pid', 'client', 'title', 'mapped'}
                and type(value['pid']) is int and value['pid'] == self.process['pid']
                and type(value['client']) is int and value['client'] > 0
                and value['title'] == 'Creator Hub' and value['mapped'] is True,
                "Exact mapped XRes-owned native Root companion required")
        return value

    @property
    def evidence(self):
        return {'readOnly': True, 'root': copy.deepcopy(self.process), 'window': self.window,
                'xres': copy.deepcopy(self.window_owner), 'hostOwner': copy.deepcopy(self.owner)}

    def verify(self):
        require(self.held is not None, "Native Root companion is closed")
        require(self.owner_probe() == self.owner, "Native Host1 owner changed")
        require(self.native.native_process(self.process['pid'], self.helper) == self.process, "Native Root PID/start/UID/image changed")
        expected = self.process['image'], self.process['kernelImageSha256']
        require(self.held.snapshot() == expected, "Held native Root executable changed")
        current = self.image_open(self.process['pid'])
        try:
            require(current.snapshot() == expected, "Native Root no longer has its held executable")
        finally:
            current.close()
        require(self.window_identity() == self.window_owner, "Native Root XRes/XID binding changed")
        require(self.native.native_process(self.process['pid'], self.helper) == self.process
                and self.owner_probe() == self.owner and self.window_identity() == self.window_owner,
                "Native Root companion changed during recheck")

    def close(self):
        if self.held is not None:
            held, self.held = self.held, None
            held.close()


def bind_warm_root(helper, native, x11, process, window, owner, owner_probe, *, image_open=HeldImage):
    """Caller binds the signed cold generation and closes this token on any failure."""
    require(sys.platform == 'linux' and platform.machine() == 'x86_64' and os.geteuid() == os.getuid() > 0,
            "Unprivileged native Linux x86_64 controller required")
    require(type(process) is dict and process.get('uids') == [os.getuid()] * 4, "Native Root/controller UID differs")
    return WarmRoot(helper, native, x11, process, window, owner, owner_probe,
                    _authority=_WARM_ROOT_AUTHORITY, image_open=image_open)


class KeyEvent(C.Structure):
    _fields_ = [(name, kind) for name, kind in (
        ("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int), ("display", C.c_void_p),
        ("window", C.c_ulong), ("root", C.c_ulong), ("subwindow", C.c_ulong), ("time", C.c_ulong),
        ("x", C.c_int), ("y", C.c_int), ("x_root", C.c_int), ("y_root", C.c_int),
        ("state", C.c_uint), ("keycode", C.c_uint), ("same_screen", C.c_int))]


class KeyEnvelope(C.Union):
    _fields_ = [("key", KeyEvent), ("padding", C.c_long * 24)]


def intersects(a, b):
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def rectangle(value):
    require(type(value) is tuple and len(value) == 4 and all(type(v) is int for v in value)
            and all(0 <= v <= 8192 for v in value[:2]) and all(0 < v <= 8192 for v in value[2:])
            and value[2] * value[3] <= 1920 * 1080, "Wholly bounded native dialog rectangle required")
    return value


class NativeWindow:
    def __init__(self, helper, x11, *, warm_companion=None):
        require(C.sizeof(C.c_long) == 8 and C.sizeof(KeyEnvelope) == 192, "Linux LP64 X11 event ABI required")
        self.helper, self.x11 = helper, x11
        require(warm_companion is None or type(warm_companion) is WarmRoot, "One opaque native Root companion required")
        self.warm_companion = warm_companion
        # Independent function wrappers do not change the shared helper's argtypes.
        def function(name, result, *arguments):
            return C.CFUNCTYPE(result, *arguments)((name, x11.x))
        self.get_focus = function("XGetInputFocus", C.c_int, C.c_void_p, C.POINTER(C.c_ulong), C.POINTER(C.c_int))
        self.query_tree = function("XQueryTree", C.c_int, C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong),
                                   C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ulong)), C.POINTER(C.c_uint))
        self.to_code = function("XKeysymToKeycode", C.c_ubyte, C.c_void_p, C.c_ulong)
        self.to_symbol = function("XKeycodeToKeysym", C.c_ulong, C.c_void_p, C.c_ubyte, C.c_int)
        self.send_event = function("XSendEvent", C.c_int, C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(KeyEnvelope))

    def attributes(self, window):
        value = self.helper.WindowAttributes()
        require(self.x11.x.XGetWindowAttributes(self.x11.display, window, C.byref(value)), "Native geometry unavailable")
        self.sync()
        return value

    def tree(self, window):
        root, parent, count, values = C.c_ulong(), C.c_ulong(), C.c_uint(), C.POINTER(C.c_ulong)()
        try:
            require(self.query_tree(self.x11.display, window, C.byref(root), C.byref(parent), C.byref(values), C.byref(count)),
                    "Native window tree unavailable")
            self.sync()
            require(root.value == self.x11.x.XDefaultRootWindow(self.x11.display) and count.value <= 256,
                    "Native window tree exceeds bound")
            return parent.value, list(values[:count.value]) if values else []
        finally:
            if values:
                self.x11.x.XFree(values)

    def check_focus(self, window, focus, revert, owner, frame, clients, message):
        if focus != window:
            self._focus_refusal = {'target': window, 'focus': focus, 'revert': revert,
                'targetXres': self.redacted_owner(owner), 'targetFrame': frame, 'managedStack': copy.deepcopy(clients)}
        require(focus == window, message)

    @staticmethod
    def redacted_owner(value):
        return {'pid': value['pid'], 'client': value['client'], 'mapped': value['mapped'],
                'titleMatchesExpected': value['title'] == 'Creator Hub'}

    def xres_identity(self, window):
        # Unlike inspect(), this never requests titles or widget/window content.
        count, values = C.c_long(), C.POINTER(self.helper.ClientValue)()
        spec = self.helper.ClientSpec(xid(window), 2)
        status = self.x11.res.XResQueryClientIds(self.x11.display, 1, C.byref(spec), C.byref(count), C.byref(values))
        try:
            self.sync()
            require(status == 0 and count.value == 1 and values, 'Diagnostic XRes identity unavailable')
            item = values[0]
            require(item.spec.mask == 2 and item.length == 4 and item.value, 'Diagnostic XRes PID format differs')
            pid = self.x11.res.XResGetClientPid(C.byref(item))
            require(type(pid) is int and 1 < pid < 2**31 and 0 < item.spec.client < 2**32, 'Diagnostic XRes PID/client invalid')
            return {'pid': pid, 'client': item.spec.client}
        finally:
            if values and 0 <= count.value <= 16:
                self.x11.res.XResClientIdsDestroy(count, values)

    def diagnostic_process(self, window, binding):
        value = self.xres_identity(window)
        pid = value['pid']
        before = os.stat(f'/proc/{pid}', follow_symlinks=False)
        require(stat.S_ISDIR(before.st_mode), 'Diagnostic process directory unavailable')
        if before.st_uid != os.getuid():
            return {**value, 'processRedacted': True}
        require(binding.native.process_uids(pid) == [os.getuid()] * 4, 'Diagnostic process UID differs')
        record = binding.native.native_process(pid, binding.helper, False)
        validate_process(record, full=False)
        require(record['pid'] == pid and record['uids'] == [os.getuid()] * 4
                and int(record['image']['st_size']) <= MAX_IMAGE, 'Diagnostic process identity differs')
        after = os.stat(f'/proc/{pid}', follow_symlinks=False)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
        require(all(getattr(before, key) == getattr(after, key) for key in fields)
                and binding.native.native_process(pid, binding.helper, False) == record
                and self.xres_identity(window) == value, 'Diagnostic process/window changed')
        return {**value, 'processRedacted': False,
                'process': {key: copy.deepcopy(record[key]) for key in (*CONTINUITY_FIELDS, 'image')}}

    def diagnostic_parents(self, window, root, binding=None):
        rows, seen = [], set()
        for _ in range(8):
            if window == root:
                return rows
            xid(window)
            require(window not in seen, 'Diagnostic window ancestry is cyclic')
            seen.add(window)
            parent, _children = self.tree(window)
            row = {'window': window, 'parent': parent}
            if binding is not None:
                row['xres'] = self.diagnostic_process(window, binding)
            rows.append(row)
            window = parent
        require(window == root, 'Diagnostic window ancestry exceeds bound')
        return rows

    def focus_observation(self, result, window, binding):
        root = self.x11.x.XDefaultRootWindow(self.x11.display)
        owner = self.x11.inspect(window)
        result['targetXres'] = self.redacted_owner(owner)
        require(owner['pid'] == binding.process['pid'] and owner['title'] == 'Creator Hub' and owner['mapped'] is True,
                'Diagnostic target is no longer the exact owned dialog')
        result['targetFrame'] = rectangle(self.x11.frame_rectangle(window))
        focus, revert = C.c_ulong(), C.c_int()
        require(self.get_focus(self.x11.display, C.byref(focus), C.byref(revert)), 'Diagnostic focus unavailable')
        self.sync()
        require(0 <= focus.value < 2**32 and revert.value in (0, 1, 2), 'Diagnostic focus format differs')
        result.update(focus=focus.value, revert=revert.value)
        for name, key, limit in (('_NET_ACTIVE_WINDOW', 'activeWindow', 1), ('_NET_CLIENT_LIST_STACKING', 'managedStack', 64)):
            value = self.x11.property(root, name)
            require(value is None or type(value) is tuple and len(value) == 3 and value[:2] == (33, 32)
                    and type(value[2]) is list and len(value[2]) <= limit
                    and all(type(v) is int and 0 <= v < 2**32 for v in value[2]), 'Diagnostic window property exceeds bound')
            result[key] = copy.deepcopy(value)
        _parent, stack = self.tree(root)
        require(len(stack) <= 64, 'Diagnostic root stacking exceeds bound')
        result['rootStack'] = stack
        result['targetParents'] = self.diagnostic_parents(window, root)
        result['focusSentinel'] = {0: 'None', 1: 'PointerRoot', root: 'DesktopRoot'}.get(focus.value)
        result['focusParents'] = [] if result['focusSentinel'] is not None else self.diagnostic_parents(focus.value, root, binding)
        require(self.x11.inspect(window) == owner, 'Diagnostic target XRes changed')

    def focus_diagnostic(self, binding, window):
        original = getattr(self, '_focus_refusal', None)
        if original is None or original['target'] != window:
            return None
        result = {'schemaVersion': 1, 'readOnly': True, 'authorityGranted': False, 'inputPermitted': False,
                  'releaseReady': False, 'complete': False, 'stable': False, 'original': copy.deepcopy(original)}
        try:
            require(binding.process['uids'] == [os.getuid()] * 4, 'Diagnostic target UID differs')
            result['targetProcess'] = {key: copy.deepcopy(binding.process[key]) for key in (*CONTINUITY_FIELDS, 'image', 'kernelImageSha256')}
            for label in ('before', 'after'):
                binding.verify()
                result[label] = {}
                self.focus_observation(result[label], window, binding)
                binding.verify()
            result['complete'] = True
            result['stable'] = result['before'] == result['after'] and all(
                result['before'][key] == original[key] for key in ('focus', 'revert', 'targetXres', 'targetFrame', 'managedStack')) and all(
                row['xres']['processRedacted'] is False for row in result['before']['focusParents'])
        except Exception as error:
            result['unavailable'] = type(error).__name__ if type(error) in (
                RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, ValueError, KeyError, TypeError, OSError) else 'OtherError'
        require(len(json.dumps(result, separators=(',', ':'), allow_nan=False)) <= 32768, 'Diagnostic output exceeds bound')
        return result

    def snapshot(self, window):
        xid(window)
        root = self.x11.x.XDefaultRootWindow(self.x11.display)
        require(window != root, "Desktop root is not a dialog")
        clients = self.x11.property(root, "_NET_CLIENT_LIST_STACKING")
        companion = getattr(self, 'warm_companion', None)
        if companion is None:
            require(type(clients) is tuple and clients == (33, 32, [window]), "Sole visible managed dialog required")
        else:
            require(type(companion) is WarmRoot and companion.x11 is self.x11 and companion.window != window
                    and type(clients) is tuple and clients == (33, 32, [companion.window, window]),
                    "Exactly native Root then topmost launcher dialog required")
            require(companion.window_identity() == companion.window_owner, "Native Root XRes binding changed")
        owner, frame = self.x11.inspect(window), rectangle(self.x11.frame_rectangle(window))
        screen = self.attributes(root)
        require(0 < screen.width <= 8192 and 0 < screen.height <= 8192
                and frame[0] + frame[2] <= screen.width and frame[1] + frame[3] <= screen.height, "Dialog is off-screen")
        ancestor, seen = window, {window}
        for _ in range(8):
            parent, _children = self.tree(ancestor)
            if parent == root:
                break
            require(type(parent) is int and parent > 1 and parent not in seen, "Ambiguous WM ancestry")
            seen.add(parent); ancestor = parent
        else:
            raise RuntimeError("WM ancestry exceeds bound")
        _parent, stack = self.tree(root)
        require(stack.count(ancestor) == 1, "Dialog WM frame is absent/ambiguous")
        if companion is not None:
            companion_frame, seen = companion.window, {companion.window}
            for _ in range(8):
                parent, _children = self.tree(companion_frame)
                if parent == root:
                    break
                require(type(parent) is int and parent > 1 and parent not in seen, "Ambiguous native Root WM ancestry")
                seen.add(parent); companion_frame = parent
            else:
                raise RuntimeError("Native Root WM ancestry exceeds bound")
            require(stack.count(companion_frame) == 1 and stack.index(companion_frame) < stack.index(ancestor),
                    "Native Root must remain below the launcher dialog")
        for other in stack[stack.index(ancestor) + 1:]:
            geometry = self.attributes(other)
            if geometry.map_state == 2 and geometry.class_ == 1:
                require(not intersects(frame, (geometry.x - geometry.border, geometry.y - geometry.border,
                                               geometry.width + 2 * geometry.border, geometry.height + 2 * geometry.border)),
                        "Mapped drawable obscures owned dialog")
        focus, revert = C.c_ulong(), C.c_int()
        require(self.get_focus(self.x11.display, C.byref(focus), C.byref(revert)), "Native input focus unavailable")
        self.sync()
        # Child focus is deliberately unsupported until separately kernel-bound.
        self.check_focus(window, focus.value, revert.value, owner, frame, clients, "Focus is not the exact owned top-level XID")
        require(self.x11.inspect(window) == owner and self.x11.frame_rectangle(window) == frame
                and self.x11.property(root, "_NET_CLIENT_LIST_STACKING") == clients, "Owned window changed during snapshot")
        require(self.get_focus(self.x11.display, C.byref(focus), C.byref(revert)), "Native input focus recheck unavailable")
        self.sync()
        self.check_focus(window, focus.value, revert.value, owner, frame, clients, "Native focus changed during window capture")
        result = {"owner": owner, "frame": frame, "focus": focus.value, "soleWindow": companion is None, "unobscured": True}
        if companion is not None:
            require(companion.window_identity() == companion.window_owner, "Native Root window changed during capture")
            result.update(warmCompanion=companion.evidence, managedWindows=[companion.window, window])
        return result

    def keycode(self, symbol):
        require(type(symbol) is int and symbol in {key for sequence in SEQUENCES.values() for key, _modifiers in sequence},
                "Only fixed dialog key symbols are supported")
        code = self.to_code(self.x11.display, symbol)
        require(type(code) is int and 8 <= code <= 255 and self.to_symbol(self.x11.display, code, 0) == symbol,
                "Exact unmodified key mapping unavailable")
        self.sync()
        return code

    def submit(self, window, code, modifiers, pressed):
        xid(window)
        require(type(code) is int and 8 <= code <= 255 and type(modifiers) is int and modifiers in (0, 1)
                and type(pressed) is bool, "Fixed typed key event required")
        root = self.x11.x.XDefaultRootWindow(self.x11.display)
        require(window != root, "Desktop root cannot receive keyboard input")
        event = KeyEnvelope()
        event.key.type, event.key.display = (2 if pressed else 3), self.x11.display
        event.key.send_event, event.key.window = 1, window
        event.key.root = root
        event.key.keycode, event.key.state, event.key.same_screen = code, modifiers, 1
        # Xlib mask=0 delivers only to the creating client; never InputFocus,
        # PointerWindow, the desktop root, an ancestor, or a desktop-global device.
        return self.send_event(self.x11.display, window, 0, 0, C.byref(event))

    def sync(self):
        self.x11.sync()


def validate_target(value, process, window, *, warm_companion=None):
    require(warm_companion is None or type(warm_companion) is WarmRoot, "One opaque native Root companion required")
    fields = {"owner", "frame", "focus", "soleWindow", "unobscured"}
    if warm_companion is not None:
        fields |= {'warmCompanion', 'managedWindows'}
    require(type(value) is dict and set(value) == fields, "Exact target snapshot required")
    owner = value["owner"]
    require(type(owner) is dict and set(owner) == {"pid", "client", "title", "mapped"}
            and type(owner["pid"]) is int and owner["pid"] == process["pid"]
            and type(owner["client"]) is int and owner["client"] > 0
            and owner["title"] == "Creator Hub" and owner["mapped"] is True, "Exact XRes-owned visible launcher dialog required")
    rectangle(value["frame"])
    require(type(value["focus"]) is int and value["focus"] == window
            and value["soleWindow"] is (warm_companion is None) and value["unobscured"] is True, "Exact sole unobscured focused window required")
    if warm_companion is not None:
        require(value['warmCompanion'] == warm_companion.evidence and value['managedWindows'] == [warm_companion.window, window],
                "Exact two-owned-window companion evidence required")


def retain_focus_diagnostic(error, binding, api, window):
    try:
        value = api.focus_diagnostic(binding, window)
        if value is not None:
            error.focus_diagnostic = value
    except Exception:
        pass  # Diagnostics must never replace the original refusal.


class InputRefused(RuntimeError):
    def __init__(self, message, receipt):
        super().__init__(message)
        self.receipt = copy.deepcopy(receipt)
        self.receipt["refusal"] = message[:256]


class KeyboardAttempt:
    def __init__(self, binding, window_api, window, *, warm_companion=None):
        self.window, self.binding, self.api = xid(window), binding, window_api
        require(warm_companion is None or type(warm_companion) is WarmRoot, "One opaque native Root companion required")
        self.warm_companion = warm_companion
        self.process = copy.deepcopy(binding.process)
        require(type(self.process["pid"]) is int and self.process["pid"] > 1 and type(self.process["startTime"]) is str
                and re.fullmatch(r"[1-9][0-9]{0,19}", self.process["startTime"]), "Exact attempt process identity required")
        self.key = self.process["pid"], self.process["startTime"], window
        self.closed, self.used, self.baseline = False, False, None
        self._receipt = {"schemaVersion": 1, "mechanism": "exact-xid-keyboard", "pid": self.key[0], "startTime": self.key[1],
                         "window": window, "intent": None, "candidateAction": None, "delivery": [], "deliveryComplete": False,
                          "launchProvenance": copy.deepcopy(binding.provenance),
                         "widgetFocusVerified": False, "outcomeVerified": False, "nativeVerificationRequired": True, "releaseReady": False}
        if warm_companion is not None:
            self._receipt['warmCompanion'] = {'binding': warm_companion.evidence, 'managedWindows': [warm_companion.window, window]}
        self.guard()

    @property
    def receipt(self):
        return copy.deepcopy(self._receipt)

    def guard(self):
        require(not self.closed, "Keyboard attempt is closed")
        if self.warm_companion is not None:
            self.warm_companion.verify()
        self.binding.verify()
        before = self.api.snapshot(self.window)
        validate_target(before, self.process, self.window, warm_companion=self.warm_companion)
        if self.warm_companion is not None:
            self.warm_companion.verify()
        self.binding.verify()
        after = self.api.snapshot(self.window)
        validate_target(after, self.process, self.window, warm_companion=self.warm_companion)
        require(before == after and (self.baseline is None or after == self.baseline), "Owned input target changed")
        if self.warm_companion is not None:
            self.warm_companion.verify()
        if self.baseline is None:
            self.baseline = copy.deepcopy(after)

    def send(self, sequence):
        with _RESERVATION_LOCK:
            require_open = not self.closed and not self.used and self.key not in _ATTEMPTS and len(_ATTEMPTS) < MAX_ATTEMPTS
            if not require_open:
                raise InputRefused("Keyboard attempt already reserved or unavailable; no retry", self.receipt)
            self.used = True
            _ATTEMPTS.add(self.key)
        try:
            require(type(sequence) is str and sequence in SEQUENCES, "Only Escape, Enter or ShiftTabSpace is supported")
            require(self.warm_companion is None or sequence == 'Enter', "Native Root companion is only for warm disclosure Enter")
            self._receipt["intent"] = sequence
            self._receipt["candidateAction"] = {"Escape": "decline-or-close", "Enter": "default-open", "ShiftTabSpace": "get-native-hub"}[sequence]
            codes = [(self.api.keycode(symbol), modifiers) for symbol, modifiers in SEQUENCES[sequence]]
            for code, modifiers in codes:
                require(type(code) is int and 8 <= code <= 255, "Invalid native keycode")
                for pressed in (True, False):
                    self.guard()
                    row = {"keycode": code, "modifiers": modifiers, "pressed": pressed, "submissionAttempted": True,
                           "returnObserved": False, "submitted": False, "synchronized": False}
                    self._receipt["delivery"].append(row)
                    returned = self.api.submit(self.window, code, modifiers, pressed)
                    row["returnObserved"] = True
                    row["submitted"] = type(returned) is int and returned != 0
                    require(row["submitted"], "Exact-window event submission was refused; outcome unknown")
                    self.api.sync()
                    row["synchronized"] = True
            self._receipt["deliveryComplete"] = True
            return self.receipt
        except Exception as error:
            refused = InputRefused(str(error), self.receipt)
            if not self._receipt['delivery']:
                retain_focus_diagnostic(refused, self.binding, self.api, self.window)
            raise refused from error

    def close(self):
        if not self.closed:
            self.closed = True
            try:
                self.binding.close()
            finally:
                if self.warm_companion is not None:
                    self.warm_companion.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def capture(helper, native, x11, process, owned_launch, launch_guard, window, *, warm_companion=None):
    """Call only after the parent controller's production/disposable-run admission.

    launch_guard must recheck the independently owned Popen/session liveness and
    original PID/start/parent/UID continuity, not require its pre-exec image to
    survive exec-to-bwrap or adopt an existing process. The helper independently
    pins and freezes the protected post-exec image. No AX peer is admitted here.
    Retain either the returned receipt or InputRefused.receipt; neither is an
    application acknowledgement. A process/window disappearing after key-down
    can leave a partial delivery, which must not cause a retry or fallback input.
    warm_companion is only the separately bound native Root for warm Enter; it
    never authorizes another target or a general set of desktop windows.
    """
    require(sys.platform == "linux" and platform.machine() == "x86_64" and os.geteuid() == os.getuid() > 0,
            "Unprivileged native Linux x86_64 controller required")
    require(type(process) is dict and process.get("uids") == [os.getuid()] * 4, "Controller/launcher UID differs")
    require(warm_companion is None or type(warm_companion) is WarmRoot, "One opaque native Root companion required")
    if warm_companion is not None:
        require(warm_companion.helper is helper and warm_companion.native is native and warm_companion.x11 is x11
                and warm_companion.process['pid'] != process['pid'] and warm_companion.process['uids'] == process['uids']
                and warm_companion.window != window, "Companion must be this session's distinct native Root/window")
        warm_companion.verify()
    binding, api = None, None
    try:
        binding = OwnedLauncher(helper, native, process, owned_launch, launch_guard)
        api = NativeWindow(helper, x11, warm_companion=warm_companion)
        return KeyboardAttempt(binding, api, window, warm_companion=warm_companion)
    except Exception as error:
        if api is not None:
            retain_focus_diagnostic(error, binding, api, window)
        try:
            if binding is not None:
                binding.close()
        finally:
            if warm_companion is not None:
                warm_companion.close()
        raise


if __name__ == "__main__":
    raise SystemExit("Import-only helper: no standalone desktop input interface")
