"""Dependency-free fixtures; optional own-child Linux kernel test, never GUI/accounts."""
import contextlib
import ctypes as C
import importlib.util
import io
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_unix_window", Path(__file__).with_name("native-unix-window.py"))
h = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = h
spec.loader.exec_module(h)

ROLE = types.SimpleNamespace(FRAME=1, DIALOG=2, ALERT=3, PUSH_BUTTON=4, APPLICATION=5)
STATE = types.SimpleNamespace(**{name: name for name in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")})
EXE = os.path.abspath("fixture/creator-hub")
DIGEST = "a" * 64


def request(action="click"):
    return h.Request(action, 123, "9876", EXE, DIGEST, 456, "Open MCP in Creator Hub?", "DIALOG", "Not now" if action == "click" else "")


def stat(pid=123, start="9876", state="S", ppid=0):
    return f"{pid} (creator (hub) fixture) {state} " + " ".join([str(ppid)] + ["0"] * 17 + [start])


class Node:
    def __init__(self, name="", role=ROLE.PUSH_BUTTON, pid=123, children=None):
        self.name, self.role, self.pid = name, role, pid
        self.children = children or []
        self.states = {"SHOWING", "ENABLED", "SENSITIVE"}
        self.actions, self.verb, self.accept, self.calls = 1, "click", True, 0

    def get_name(self):
        return self.name

    def get_role(self):
        return self.role

    def get_process_id(self):
        return self.pid

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]

    def get_state_set(self):
        return self

    def contains(self, state):
        return state in self.states

    def get_action_iface(self):
        return self

    def get_n_actions(self):
        return self.actions

    def get_action_name(self, index):
        assert index == 0
        return self.verb

    def do_action(self, index):
        assert index == 0
        self.calls += 1
        return self.accept


class FakeProc:
    def __init__(self):
        self.start, self.path, self.hash, self.pid = "9876", EXE, DIGEST, 123
        self.state = "S"
        self.hash_calls, self.hook, self.absent, self.still_exists = 0, lambda: None, False, False

    def stat(self, _pid):
        if self.absent:
            raise FileNotFoundError("fixture process exited")
        return stat(self.pid, self.start, self.state)

    def executable(self, _pid):
        return self.path

    def digest(self, _pid):
        self.hash_calls += 1
        if self.hash_calls == 2:
            self.hook()
        return self.hash

    def exists(self, _pid):
        return self.still_exists


class FakeX11:
    def __init__(self):
        self.info = {"pid": 123, "client": 789, "title": "Open MCP in Creator Hub?", "mapped": True}
        self.inspections, self.closes, self.close_supported = 0, 0, True

    def inspect(self, _window):
        self.inspections += 1
        return dict(self.info)

    def check_close(self, _window):
        h.require(self.close_supported, "normal delete unavailable")

    def close_window(self, window, expected):
        self.check_close(window)
        h.require(self.inspect(window) == expected, "window changed before close")
        self.closes += 1


def fixture():
    control = Node("Not now")
    window = Node("Open MCP in Creator Hub?", ROLE.DIALOG, children=[control])
    app = Node("owned application", ROLE.APPLICATION, children=[window])
    desktop = Node("desktop", children=[app])
    api = types.SimpleNamespace(Role=ROLE, StateType=STATE, get_desktop=lambda _index: desktop)
    return api, FakeProc(), FakeX11(), control, window, app, desktop


class PolicyTests(unittest.TestCase):
    def test_runner_guard(self):
        env = dict(GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted", RUNNER_OS="Linux", RUNNER_ARCH="X64", CREATOR_UNIX_WINDOW_TEST="1")
        h.ensure_runner(env, "linux", "x86_64")
        h.ensure_runner({**env, "RUNNER_ARCH": "ARM64"}, "linux", "aarch64")
        for changes in ({"GITHUB_ACTIONS": "false"}, {"RUNNER_ENVIRONMENT": "self-hosted"},
                        {"RUNNER_OS": "Windows"}, {"RUNNER_ARCH": "ARM64"}, {"CREATOR_UNIX_WINDOW_TEST": ""}, {"FLATPAK_ID": "fixture"}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                h.ensure_runner({**env, **changes}, "linux", "x86_64")
        for system, machine in (("win32", "x86_64"), ("darwin", "arm64"), ("linux", "i686")):
            with self.subTest(system=system), self.assertRaises(RuntimeError):
                h.ensure_runner(env, system, machine)

    def test_main_refuses_before_gi_proc_or_x11_even_with_invalid_arguments(self):
        for env, system in (({}, "linux"), ({"RUNNER_ENVIRONMENT": "self-hosted"}, "linux"), ({}, "win32")):
            with self.subTest(env=env, system=system), patch.dict(os.environ, env, clear=True), patch.object(sys, "platform", system), \
                 patch.object(h.Proc, "stat", side_effect=AssertionError("No proc read")), \
                 patch.object(h, "X11", side_effect=AssertionError("No X11 load")), \
                 patch.object(h, "read_receipt", side_effect=AssertionError("No receipt read")), \
                 patch.object(sys, "argv", ["native-unix-window.py", "--sealed-receipt", "must-not-be-opened"]), \
                 patch.dict(sys.modules, {"gi": None}), self.assertRaises(RuntimeError):
                h.main()

    def test_parse_exact_contract_and_all_permission_pairs(self):
        base = ["snapshot", "123", "9876", EXE, DIGEST, "0x1c8", "Creator Hub", "FRAME"]
        self.assertEqual(h.Request.parse(base).window, 456)
        for title, buttons in h.BUTTONS.items():
            for name in buttons:
                self.assertEqual(h.Request.parse(["click", *base[1:6], title, "DIALOG", name]).button, name)
        for index, value in ((0, "kill"), (1, "1"), (1, "123x"), (2, "0"), (3, "relative"), (4, "bad"),
                             (5, "0"), (5, "4294967296"), (6, ""), (6, "bad\nname"), (7, "UNKNOWN")):
            args = list(base)
            args[index] = value
            with self.subTest(index=index, value=value), self.assertRaises(RuntimeError):
                h.Request.parse(args)
        for args in (["click", *base[1:], "Not now"], ["snapshot", *base[1:], "Not now"],
                     ["click", *base[1:6], "Open MCP in Creator Hub?", "FRAME", "Not now"],
                     ["click", *base[1:6], "Open MCP in Creator Hub?", "DIALOG", "Allow everything"]):
            with self.assertRaises(RuntimeError):
                h.Request.parse(args)

    def test_stat_parser_uses_last_parenthesis_and_exact_pid_field22(self):
        self.assertEqual(h.parse_start(stat(), 123), "9876")
        for value in (stat(pid=124), stat(start="bad"), stat(state="Z"), "123 (unclosed", "x" * 4097):
            with self.subTest(value=value[:30]), self.assertRaises(RuntimeError):
                h.parse_start(value, 123)

    def test_memfd_input_cannot_masquerade_as_a_source_path(self):
        args = ["snapshot", "123", "9876", "/memfd:creator-hub-module (deleted)", DIGEST, "456", "Creator Hub", "FRAME"]
        with self.assertRaisesRegex(RuntimeError, "owned-launcher kernel binding"):
            h.Request.parse(args)


class ActionTests(unittest.TestCase):
    def run_action(self, f, req=None):
        return h.perform(req or request(), *f[:3])

    def test_real_gi_name_collision_fixture_and_single_action(self):
        f = fixture()
        with self.assertRaises(TypeError):
            f[3].get_name(0)
        result = self.run_action(f)
        self.assertEqual(f[3].calls, 1)
        self.assertEqual(result["actionCount"], 1)
        self.assertEqual(result["processAfter"], "live-verified")
        self.assertFalse(result["normalExitVerified"])
        self.assertFalse(result["releaseReady"])

    def test_real_proc_memfd_refuses_even_with_matching_source_hash_pid_and_start(self):
        f = fixture()
        f[1].path = "/memfd:creator-hub-module (deleted)"
        with self.assertRaisesRegex(RuntimeError, "owned-launcher kernel binding"):
            self.run_action(f)
        self.assertEqual(f[3].calls, 0)
        self.assertEqual(f[2].inspections, 0)
        self.assertEqual(f[1].hash_calls, 0)

    def test_snapshot_is_only_the_owned_selected_window_no_text_or_unowned_data(self):
        f = fixture()
        foreign = Node("secret unrelated title", ROLE.APPLICATION, pid=999)
        foreign.get_name = lambda: self.fail("must not read unowned application name")
        foreign.get_child_count = lambda: self.fail("must not traverse unowned application")
        f[6].children.append(foreign)
        result = self.run_action(f, request("snapshot"))
        self.assertEqual(len(result["nodes"]), 2)
        self.assertNotIn("secret", str(result))
        self.assertEqual(f[3].calls, 0)
        self.assertNotIn("text", result["nodes"][0])

    def test_identity_and_controls_refuse_without_input(self):
        faults = {
            "pid": lambda f: setattr(f[1], "pid", 124), "start": lambda f: setattr(f[1], "start", "9999"),
            "path": lambda f: setattr(f[1], "path", EXE + "-foreign"), "hash": lambda f: setattr(f[1], "hash", "b" * 64),
            "deleted": lambda f: setattr(f[1], "path", EXE + " (deleted)"),
            "unowned X window": lambda f: f[2].info.update(pid=999), "X title": lambda f: f[2].info.update(title="wrong"),
            "X hidden": lambda f: f[2].info.update(mapped=False), "X client missing": lambda f: f[2].info.update(client=0),
            "duplicate root": lambda f: f[6].children.append(f[5]), "missing root": lambda f: f[6].children.clear(),
            "duplicate window": lambda f: f[5].children.append(f[4]), "window title": lambda f: setattr(f[4], "name", "wrong"),
            "window role": lambda f: setattr(f[4], "role", ROLE.FRAME), "unowned window": lambda f: setattr(f[4], "pid", 999),
            "duplicate button": lambda f: f[4].children.append(Node("Not now")), "button role": lambda f: setattr(f[3], "role", ROLE.FRAME),
            "label": lambda f: setattr(f[3], "name", "Not now please"), "foreign subtree": lambda f: setattr(f[3], "pid", 999),
            "hidden": lambda f: f[3].states.remove("SHOWING"), "disabled": lambda f: f[3].states.remove("ENABLED"),
            "insensitive": lambda f: f[3].states.remove("SENSITIVE"), "busy": lambda f: f[3].states.add("BUSY"),
            "defunct": lambda f: f[3].states.add("DEFUNCT"), "no action": lambda f: setattr(f[3], "actions", 0),
            "multiple actions": lambda f: setattr(f[3], "actions", 2), "wrong action": lambda f: setattr(f[3], "verb", "press"),
        }
        for name, fault in faults.items():
            f = fixture()
            fault(f)
            with self.subTest(fault=name), self.assertRaises(RuntimeError):
                self.run_action(f)
            self.assertEqual(f[3].calls, 0, name)
            self.assertEqual(f[2].closes, 0, name)

    def test_drift_immediately_before_action_is_rechecked(self):
        for name, fault in {
            "start": lambda f: setattr(f[1], "start", "9999"), "path": lambda f: setattr(f[1], "path", EXE + "-changed"),
            "hash": lambda f: setattr(f[1], "hash", "b" * 64), "label": lambda f: setattr(f[3], "name", "renamed"),
            "disabled": lambda f: f[3].states.remove("ENABLED"), "role": lambda f: setattr(f[3], "role", ROLE.FRAME),
            "duplicate": lambda f: f[4].children.append(Node("Not now")), "X PID": lambda f: f[2].info.update(pid=999),
            "X client": lambda f: f[2].info.update(client=999), "X title": lambda f: f[2].info.update(title="changed"),
        }.items():
            f = fixture()
            f[1].hook = lambda f=f, fault=fault: fault(f)
            with self.subTest(fault=name), self.assertRaises(RuntimeError):
                self.run_action(f)
            self.assertEqual(f[3].calls, 0, name)

    def test_refused_action_is_not_retried(self):
        f = fixture()
        f[3].accept = False
        with self.assertRaisesRegex(h.ActionError, "refused; do not retry"):
            self.run_action(f)
        self.assertEqual(f[3].calls, 1)

    def test_post_action_drift_fails_and_never_retries(self):
        f = fixture()
        action = f[3].do_action
        def drift(index):
            f[1].start = "1111"
            return action(index)
        f[3].do_action = drift
        with self.assertRaisesRegex(h.ActionError, "changed after action"):
            self.run_action(f)
        self.assertEqual(f[3].calls, 1)

    def test_terminal_action_absence_is_not_a_normal_exit_receipt(self):
        f = fixture()
        action = f[3].do_action
        def exits(index):
            f[1].absent = True
            return action(index)
        f[3].do_action = exits
        result = self.run_action(f)
        self.assertEqual(result["processAfter"], "absent-unverified-exit")
        self.assertFalse(result["normalExitVerified"])

    def test_terminal_zombie_still_requires_parent_exit_receipt(self):
        f = fixture()
        action = f[3].do_action
        def exits(index):
            f[1].state = "Z"
            return action(index)
        f[3].do_action = exits
        result = self.run_action(f)
        self.assertEqual(result["processAfter"], "not-live-unverified-exit")
        self.assertFalse(result["normalExitVerified"])

    def test_snapshot_identity_or_window_drift_refuses_owned_evidence(self):
        for fault in (lambda f: setattr(f[1], "start", "1111"), lambda f: f[2].info.update(client=999)):
            f = fixture()
            f[1].hook = lambda f=f, fault=fault: fault(f)
            with self.assertRaises(RuntimeError):
                self.run_action(f, request("snapshot"))
            self.assertEqual(f[3].calls, 0)

    def test_missing_exe_with_surviving_process_refuses(self):
        f = fixture()
        f[3].do_action = lambda _index: (setattr(f[1], "absent", True), setattr(f[1], "still_exists", True), True)[-1]
        with self.assertRaisesRegex(RuntimeError, "became unavailable"):
            self.run_action(f)

    def test_normal_close_is_one_request_never_an_exit_claim(self):
        f = fixture()
        f[4].role = ROLE.FRAME
        req = h.Request("close", 123, "9876", EXE, DIGEST, 456, f[4].name, "FRAME")
        result = self.run_action(f, req)
        self.assertEqual(f[2].closes, 1)
        self.assertEqual(result["actionCount"], 1)
        self.assertFalse(result["normalExitVerified"])
        f = fixture()
        f[4].role = ROLE.FRAME
        f[2].close_supported = False
        with self.assertRaises(RuntimeError):
            self.run_action(f, req)
        self.assertEqual(f[2].closes, 0)

    def test_tree_children_depth_nodes_and_foreign_subtree_bounds(self):
        f = fixture()
        f[4].children = [Node()] * 129
        with self.assertRaisesRegex(RuntimeError, "child count"):
            self.run_action(f, request("snapshot"))
        f = fixture()
        f[4].children = [f[4]]
        with self.assertRaisesRegex(RuntimeError, "bounds"):
            self.run_action(f, request("snapshot"))
        f = fixture()
        f[4].children = [Node(children=[Node() for _ in range(128)]) for _ in range(5)]
        with self.assertRaisesRegex(RuntimeError, "bound"):
            self.run_action(f, request("snapshot"))


class XResTests(unittest.TestCase):
    def test_remote_display_refuses_before_loading_native_libraries(self):
        for value in ("remote.example:0", "localhost:99", "", "unix:99"):
            with self.subTest(display=value), patch.dict(os.environ, {"DISPLAY": value}), \
                 patch.object(h.C, "CDLL", side_effect=AssertionError("No library load")), self.assertRaises(RuntimeError):
                h.X11()

    def native_fixture(self, status=0, count=1, mask=2, length=4, pid=123):
        x = object.__new__(h.X11)
        x.error, x.display = False, 1
        payload = C.c_uint32(pid)
        values = (h.ClientValue * 1)(h.ClientValue(h.ClientSpec(789, mask), length, C.cast(C.pointer(payload), C.c_void_p)))
        destroyed = []
        def attrs(_display, _window, pointer):
            value = C.cast(pointer, C.POINTER(h.WindowAttributes)).contents
            value.map_state = 2
            return 1
        def query(_display, _number, _spec, amount, output):
            C.cast(amount, C.POINTER(C.c_long))[0] = count
            C.cast(output, C.POINTER(C.POINTER(h.ClientValue)))[0] = C.cast(values, C.POINTER(h.ClientValue))
            return status
        x.x = types.SimpleNamespace(XGetWindowAttributes=attrs, XSync=lambda *_: 0)
        x.res = types.SimpleNamespace(XResQueryClientIds=query, XResGetClientPid=lambda _: pid,
                                     XResClientIdsDestroy=lambda n, v: destroyed.append(n.value))
        x.atom = lambda _: 99
        x.property = lambda _window, _name: (99, 8, b"Open MCP in Creator Hub?")
        x.references = payload, values
        return x, destroyed

    def test_xres_success_is_zero_with_four_byte_pid_and_owned_resource(self):
        x, destroyed = self.native_fixture()
        self.assertEqual(x.inspect(456)["pid"], 123)
        self.assertEqual(destroyed, [1])

    def test_xres_status_count_mask_length_and_pid_refusals(self):
        for change in ({"status": 1}, {"count": 0}, {"count": 2}, {"mask": 1}, {"length": 8}, {"pid": 0}):
            x, _ = self.native_fixture(**change)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                x.inspect(456)

    def test_normal_close_requires_wm_and_delete_protocol_never_kill_fallback(self):
        x = object.__new__(h.X11)
        x.display, x.x = 1, types.SimpleNamespace(XDefaultRootWindow=lambda _: 1)
        x.atom = lambda name: {"_NET_CLOSE_WINDOW": 7, "WM_DELETE_WINDOW": 8}[name]
        properties = {(1, "_NET_SUPPORTING_WM_CHECK"): (33, 32, [2]), (2, "_NET_SUPPORTING_WM_CHECK"): (33, 32, [2]),
                      (1, "_NET_SUPPORTED"): (4, 32, [7]), (456, "WM_PROTOCOLS"): (4, 32, [8])}
        x.property = lambda window, name: properties.get((window, name))
        x.check_close(456)
        for key in list(properties):
            saved = properties.pop(key)
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                x.check_close(456)
            properties[key] = saved

    def test_normal_close_sends_exactly_one_ewmh_request_and_rechecks_resource(self):
        x = object.__new__(h.X11)
        x.display, x.error = 1, False
        expected = {"pid": 123, "client": 789, "title": "Creator Hub", "mapped": True}
        x.check_close = lambda _window: None
        x.inspect = lambda _window: dict(expected)
        x.atom = lambda name: 7 if name == "_NET_CLOSE_WINDOW" else 0
        calls = []
        def send(_display, root, propagate, masks, pointer):
            event = C.cast(pointer, C.POINTER(h.Event)).contents.message
            calls.append((root, propagate, masks, event.type, event.window, event.message_type, event.format, list(event.data.l)))
            return 1
        x.x = types.SimpleNamespace(XDefaultRootWindow=lambda _: 1, XSendEvent=send, XSync=lambda *_: 0)
        x.close_window(456, expected)
        self.assertEqual(calls, [(1, 0, (1 << 19) | (1 << 20), 33, 456, 7, 32, [0, 2, 0, 0, 0])])
        calls.clear()
        x.inspect = lambda _: {**expected, "pid": 999}
        with self.assertRaisesRegex(RuntimeError, "immediately before normal close"):
            x.close_window(456, expected)
        self.assertEqual(calls, [])

    def test_x_send_refusal_is_not_retried(self):
        x = object.__new__(h.X11)
        x.display, x.error = 1, False
        expected = {"pid": 123, "client": 789, "title": "Creator Hub", "mapped": True}
        x.check_close, x.inspect = lambda _: None, lambda _: expected
        x.atom = lambda _: 7
        sends = []
        x.x = types.SimpleNamespace(XDefaultRootWindow=lambda _: 1, XSendEvent=lambda *args: (sends.append(args), 0)[1], XSync=lambda *_: 0)
        with self.assertRaisesRegex(RuntimeError, "close request refused"):
            x.close_window(456, expected)
        self.assertEqual(len(sends), 1)


class CliTests(unittest.TestCase):
    def test_local_cli_refuses_without_native_modules_or_process_reads(self):
        import subprocess
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("native-unix-window.py")), "invalid"],
                                env={**os.environ, "GITHUB_ACTIONS": "false", "CREATOR_UNIX_WINDOW_TEST": ""},
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        import json
        error = json.loads(result.stderr)
        self.assertFalse(error["actionMayHaveRun"])
        self.assertFalse(error["normalExitVerified"])
        self.assertFalse(error["releaseReady"])
        self.assertNotIn("gi", error["error"])


def receipt_fixture():
    value = {"schemaVersion": 1, "kind": "creator-hub-owned-sealed-child", "source": {"commit": "c" * 40, "runId": 9001},
             "parent": {"pid": 200, "startTime": "9999", "executable": EXE, "sha256": "b" * 64},
             "child": {"pid": 123, "startTime": "9876", "image": {"device": "1", "inode": "222", "size": 100,
                       "sha256": DIGEST, "requiredSeals": 15}}}
    pins = ["200", "9999", "b" * 64, DIGEST, "c" * 40, "9001"]
    return value, pins


class FakeImage:
    def __init__(self, properties):
        self.properties, self.closed = properties, False

    def snapshot(self):
        h.require(not self.closed, "held descriptor closed")
        return dict(self.properties)

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class KernelProc:
    def __init__(self):
        self.parent_start, self.parent_path, self.parent_hash = "9999", EXE, "b" * 64
        self.child_start, self.ppid, self.child_state = "9876", 200, "S"
        self.child_absent, self.parent_absent = False, False
        self.held = {"device": "1", "inode": "222", "size": 100, "sha256": DIGEST, "seals": 15}
        self.current = dict(self.held)
        self.opened, self.images = 0, []
        self.name = "arbitrary memfd label, never queried"

    def stat(self, pid):
        if pid == 200:
            if self.parent_absent:
                raise FileNotFoundError("fixture parent gone")
            return stat(200, self.parent_start)
        assert pid == 123
        if self.child_absent:
            raise FileNotFoundError("fixture child gone")
        return stat(123, self.child_start, self.child_state, self.ppid)

    def executable(self, pid):
        assert pid == 200, "Sealed child must never be authorized using its link/name/path"
        return self.parent_path

    def digest(self, pid):
        assert pid == 200, "Child must be hashed from its actual open FD"
        return self.parent_hash

    def exists(self, pid):
        return not (self.child_absent if pid == 123 else self.parent_absent)

    def open_image(self, pid):
        assert pid == 123
        self.opened += 1
        image = FakeImage(self.held if self.opened == 1 else self.current)
        self.images.append(image)
        return image


class ReceiptTests(unittest.TestCase):
    def test_new_schema_requires_independent_parent_payload_and_source_pins(self):
        value, pins = receipt_fixture()
        r = h.Receipt.parse(value, pins)
        request = h.Request.sealed(["click", "456", "Open MCP in Creator Hub?", "DIALOG", "Not now"], r)
        self.assertEqual(request.executable, "")
        self.assertEqual(request.receipt, r)
        for index, wrong in ((0, "201"), (1, "9998"), (2, "d" * 64), (3, "d" * 64), (4, "d" * 40), (5, "9002")):
            bad = list(pins)
            bad[index] = wrong
            with self.subTest(pin=index), self.assertRaises(RuntimeError):
                h.Receipt.parse(value, bad)

    def test_receipt_rejects_extra_source_path_weak_seals_and_lossy_inode_types(self):
        import copy
        value, pins = receipt_fixture()
        for label, mutate in {
            "source path spoof": lambda v: v["child"].update(executable=EXE),
            "memfd name authority": lambda v: v["child"]["image"].update(memfdName="creator-hub-gui"),
            "weak required seals": lambda v: v["child"]["image"].update(requiredSeals=7),
            "numeric inode": lambda v: v["child"]["image"].update(inode=222),
            "lossy device": lambda v: v["child"]["image"].update(device="01"),
            "zero inode": lambda v: v["child"]["image"].update(inode="0"),
            "self parent": lambda v: v["child"].update(pid=200),
            "sealed parent": lambda v: v["parent"].update(executable="/memfd:creator-hub (deleted)"),
            "deleted parent": lambda v: v["parent"].update(executable=EXE + " (deleted)"),
            "bool schema": lambda v: v.update(schemaVersion=True),
            "bool run": lambda v: v["source"].update(runId=True),
        }.items():
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.subTest(label=label), self.assertRaises(RuntimeError):
                h.Receipt.parse(changed, pins)

    def test_sealed_action_contract_does_not_expand_control_role_or_close_permissions(self):
        value, pins = receipt_fixture()
        r = h.Receipt.parse(value, pins)
        for args in (["kill", "456", "Creator Hub", "FRAME"],
                     ["click", "456", "Open MCP in Creator Hub?", "FRAME", "Not now"],
                     ["click", "456", "Open MCP in Creator Hub?", "DIALOG", "Allow everything"],
                     ["close", "456", "Open MCP in Creator Hub?", "DIALOG"]):
            with self.assertRaises(RuntimeError):
                h.Request.sealed(args, r)

    @unittest.skipUnless(sys.platform == "linux", "Linux private receipt file primitives")
    def test_private_receipt_read_no_symlinks_hardlinks_or_duplicate_keys(self):
        import json
        import tempfile
        value, pins = receipt_fixture()
        with tempfile.TemporaryDirectory(prefix="owned-launcher-receipt-") as root:
            root = os.path.realpath(root)
            file = os.path.join(root, "receipt.json")
            def write(data):
                with open(file, "w", encoding="utf8") as stream:
                    stream.write(data)
                os.chmod(file, 0o600)
            write(json.dumps(value))
            self.assertEqual(h.read_receipt(file, root, pins), h.Receipt.parse(value, pins))
            os.chmod(file, 0o644)
            with self.assertRaises(RuntimeError):
                h.read_receipt(file, root, pins)
            os.chmod(file, 0o600)
            link = os.path.join(root, "hardlink")
            os.link(file, link)
            with self.assertRaises(RuntimeError):
                h.read_receipt(file, root, pins)
            os.unlink(link)
            os.symlink(file, link)
            with self.assertRaises(RuntimeError):
                h.read_receipt(link, root, pins)
            write(json.dumps(value).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'))
            with self.assertRaisesRegex(RuntimeError, "Duplicate"):
                h.read_receipt(file, root, pins)


class SealedBindingTests(unittest.TestCase):
    def setup_fixture(self):
        f = fixture()
        value, pins = receipt_fixture()
        r, proc = h.Receipt.parse(value, pins), KernelProc()
        binding = h.KernelBinding(r, proc)
        self.addCleanup(binding.close)
        request = h.Request.sealed(["click", "456", "Open MCP in Creator Hub?", "DIALOG", "Not now"], r)
        return f, proc, binding, request

    def test_sealed_backend_action_uses_fd_and_parent_not_resource_path_or_memfd_label(self):
        f, proc, binding, req = self.setup_fixture()
        proc.name = "not the production memfd name"
        result = h.perform(req, f[0], proc, f[2], binding)
        self.assertEqual(f[3].calls, 1)
        self.assertIsNone(result["executable"])
        self.assertEqual(result["executableBinding"], "sealed-proc-fd-and-owned-launcher")
        self.assertEqual(result["kernelImage"]["inode"], "222")
        self.assertEqual(result["launcher"]["pid"], 200)
        self.assertEqual(result["processAfter"], "live-verified")
        self.assertFalse(result["normalExitVerified"])
        self.assertFalse(result["releaseReady"])

    def test_sealed_receipt_without_native_binding_cannot_fall_back_to_pathname(self):
        f, proc, _binding, req = self.setup_fixture()
        with self.assertRaisesRegex(RuntimeError, "kernel binding required"):
            h.perform(req, f[0], proc, f[2])
        self.assertEqual(f[3].calls, 0)

    def test_parent_reuse_parent_hash_path_ppid_and_fd_changes_fail_before_gui(self):
        faults = {
            "parent reuse": lambda p: setattr(p, "parent_start", "10000"),
            "parent path": lambda p: setattr(p, "parent_path", EXE + "-changed"),
            "parent bytes": lambda p: setattr(p, "parent_hash", "d" * 64),
            "wrong PPID": lambda p: setattr(p, "ppid", 201),
            "child reuse": lambda p: setattr(p, "child_start", "10000"),
            "held FD changed": lambda p: p.held.update(inode="333"),
            "held FD closed": lambda p: p.images[0].close(),
            "current FD changed": lambda p: p.current.update(inode="333"),
            "device": lambda p: p.current.update(device="2"),
            "hash": lambda p: p.current.update(sha256="d" * 64),
            "size": lambda p: p.current.update(size=101),
            "no seals": lambda p: p.current.update(seals=0),
            "held seals": lambda p: p.held.update(seals=7),
            "seal set drift": lambda p: p.current.update(seals=31),
        }
        for label, mutate in faults.items():
            f, proc, binding, req = self.setup_fixture()
            mutate(proc)
            with self.subTest(label=label), self.assertRaises(RuntimeError):
                h.perform(req, f[0], proc, f[2], binding)
            self.assertEqual(f[3].calls, 0)
            self.assertEqual(f[2].inspections, 0)

    def test_ppid_parent_reuse_and_fd_drift_at_input_boundary_fail_without_click(self):
        for mutate in (lambda p: setattr(p, "ppid", 201), lambda p: setattr(p, "parent_start", "10000"),
                       lambda p: p.current.update(inode="333"), lambda p: p.held.update(sha256="d" * 64)):
            f, proc, binding, req = self.setup_fixture()
            old = f[3].get_action_name
            def changes(index, mutate=mutate, proc=proc, old=old):
                mutate(proc)
                return old(index)
            f[3].get_action_name = changes
            with self.assertRaises(RuntimeError):
                h.perform(req, f[0], proc, f[2], binding)
            self.assertEqual(f[3].calls, 0)

    def test_post_action_parent_ppid_or_image_drift_fails_with_possible_input_receipt(self):
        for mutate in (lambda p: setattr(p, "ppid", 201), lambda p: setattr(p, "parent_start", "10000"),
                       lambda p: p.current.update(inode="333"), lambda p: p.held.update(seals=7)):
            f, proc, binding, req = self.setup_fixture()
            action = f[3].do_action
            def changes(index, mutate=mutate, proc=proc, action=action):
                mutate(proc)
                return action(index)
            f[3].do_action = changes
            with self.assertRaises(h.ActionError):
                h.perform(req, f[0], proc, f[2], binding)
            self.assertEqual(f[3].calls, 1)

    def test_terminal_child_cannot_hide_missing_or_reused_launcher(self):
        for parent_case in ("live", "missing", "reused"):
            f, proc, binding, req = self.setup_fixture()
            action = f[3].do_action
            def exits(index, parent_case=parent_case):
                proc.child_absent = True
                proc.parent_absent = parent_case == "missing"
                if parent_case == "reused":
                    proc.parent_start = "10000"
                return action(index)
            f[3].do_action = exits
            if parent_case != "live":
                with self.assertRaises(h.ActionError):
                    h.perform(req, f[0], proc, f[2], binding)
            else:
                result = h.perform(req, f[0], proc, f[2], binding)
                self.assertEqual(result["processAfter"], "absent-unverified-exit")
                self.assertFalse(result["normalExitVerified"])

    def test_failed_current_image_constructor_closes_held_fd(self):
        value, pins = receipt_fixture()
        r, proc = h.Receipt.parse(value, pins), KernelProc()
        proc.current.update(seals=0)
        with self.assertRaises(RuntimeError):
            h.KernelBinding(r, proc)
        self.assertTrue(all(image.closed for image in proc.images))


@unittest.skipUnless(sys.platform == "linux" and os.environ.get("CREATOR_UNIX_WINDOW_KERNEL_TEST") == "1",
                     "Opt-in owned Linux kernel fixture only; not a GUI/GitHub bypass")
class KernelOnlyTests(unittest.TestCase):
    def test_real_sealed_child_proc_fd_source_hash_inode_seals_and_normal_eof(self):
        import fcntl
        import hashlib
        import select
        import subprocess
        # Existing harmless tool bytes; no product parent impersonation or fake GitHub environment.
        source = Path("/usr/bin/cat").read_bytes()
        self.assertEqual(source[:5], b"\x7fELF\x02")
        fd = os.memfd_create("arbitrary-fixture-name-not-authority", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        child = None
        try:
            with os.fdopen(os.dup(fd), "wb") as stream:
                stream.write(source)
            os.fchmod(fd, 0o500)
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, h.REQUIRED_SEALS)
            for change in (lambda: os.write(fd, b"tamper"), lambda: os.ftruncate(fd, len(source) + 1)):
                with self.assertRaises(OSError):
                    change()
            child = subprocess.Popen(["owned-kernel-test-tool"], executable=f"/proc/self/fd/{fd}", pass_fds=(fd,),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child.stdin.write(b"kernel-ready\n")
            child.stdin.flush()
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], "Owned kernel fixture did not become ready")
            self.assertEqual(child.stdout.readline(), b"kernel-ready\n")
            proc = h.Proc()
            parent_pid, parent_path = os.getpid(), proc.executable(os.getpid())
            parent_start = h.parse_start(proc.stat(parent_pid), parent_pid)
            parent_hash = hashlib.sha256(Path(f"/proc/{parent_pid}/exe").read_bytes()).hexdigest()
            child_start = h.parse_start(proc.stat(child.pid), child.pid)
            observed = os.fstat(fd)
            value = {"schemaVersion":1,"kind":"creator-hub-owned-sealed-child","source":{"commit":"c"*40,"runId":9001},
                     "parent":{"pid":parent_pid,"startTime":parent_start,"executable":parent_path,"sha256":parent_hash},
                     "child":{"pid":child.pid,"startTime":child_start,"image":{"device":str(observed.st_dev),"inode":str(observed.st_ino),
                              "size":len(source),"sha256":hashlib.sha256(source).hexdigest(),"requiredSeals":15}}}
            pins = [str(parent_pid),parent_start,parent_hash,hashlib.sha256(source).hexdigest(),"c"*40,"9001"]
            receipt = h.Receipt.parse(value, pins)
            binding = h.KernelBinding(receipt, proc)
            try:
                binding.verify()
                self.assertEqual(binding.last_image["inode"], str(observed.st_ino))
                self.assertEqual(binding.last_image["seals"] & 15, 15)
            finally:
                binding.close()
        finally:
            os.close(fd)
            if child is not None:
                child.stdin.close()
                try:
                    self.assertEqual(child.wait(timeout=5), 0, "Owned kernel fixture did not exit normally on EOF")
                finally:
                    child.stdout.close()
                    child.stderr.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
