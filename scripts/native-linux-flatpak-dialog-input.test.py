"""Pure exact-window input fixtures; no X server, native app or device access."""
import copy
import ctypes as C
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("flatpak_dialog_input", Path(__file__).with_name("native-linux-flatpak-dialog-input.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class Binding:
    def __init__(self):
        self.process = {"pid": 123, "startTime": "100"}
        self.provenance = {"readOnly": True, "fixture": True}
        self.checks, self.failure, self.closed = 0, None, False

    def verify(self):
        self.checks += 1
        if self.failure:
            raise RuntimeError(self.failure)

    def close(self):
        self.closed = True


class Window:
    def __init__(self):
        self.state = {"owner": {"pid": 123, "client": 900, "title": "Creator Hub", "mapped": True},
                      "frame": (10, 20, 600, 350), "focus": 456, "soleWindow": True, "unobscured": True}
        self.sent, self.observations, self.flushes = [], 0, 0
        self.failure, self.hook, self.result = None, lambda: None, 1

    def snapshot(self, _window):
        self.observations += 1
        if self.failure:
            raise RuntimeError(self.failure)
        return copy.deepcopy(self.state)

    def keycode(self, keysym):
        return {0xff1b: 9, 0xff0d: 36, 0xff09: 23, 0x20: 65}[keysym]

    def submit(self, window, code, modifiers, pressed):
        self.sent.append((window, code, modifiers, pressed))
        self.hook()
        return self.result

    def sync(self):
        self.flushes += 1


class InputTests(unittest.TestCase):
    def setUp(self):
        M._ATTEMPTS.clear()
        self.binding, self.window = Binding(), Window()

    def attempt(self, window=456):
        return M.KeyboardAttempt(self.binding, self.window, window)

    def test_only_three_fixed_sequences_are_delivered_to_exact_window(self):
        expected = {"Escape": [(9, 0, True), (9, 0, False)],
                    "Enter": [(36, 0, True), (36, 0, False)],
                    "ShiftTabSpace": [(23, 1, True), (23, 1, False), (65, 0, True), (65, 0, False)]}
        for sequence, strokes in expected.items():
            with self.subTest(sequence=sequence):
                M._ATTEMPTS.clear()
                binding, window = Binding(), Window()
                attempt = M.KeyboardAttempt(binding, window, 456)
                initial = binding.checks, window.observations
                result = attempt.send(sequence)
                self.assertEqual(window.sent, [(456, *stroke) for stroke in strokes])
                self.assertGreaterEqual(binding.checks - initial[0], 2 * len(strokes))
                self.assertGreaterEqual(window.observations - initial[1], 2 * len(strokes))
                self.assertEqual(window.flushes, len(strokes))
                self.assertTrue(result["deliveryComplete"])
                self.assertEqual(len(result["delivery"]), len(strokes))
                self.assertFalse(result["widgetFocusVerified"])
                self.assertFalse(result["outcomeVerified"])
                self.assertFalse(result["releaseReady"])
                self.assertTrue(result["nativeVerificationRequired"])
                self.assertEqual(result["candidateAction"], {"Escape": "decline-or-close", "Enter": "default-open", "ShiftTabSpace": "get-native-hub"}[sequence])

    def test_invalid_sequences_never_reach_input_and_burn_attempt(self):
        for value in ("Tab", "Return", "Get Native Hub", "", "Escape\x00", "a" * 5000, 1, True, None, ["Escape"]):
            with self.subTest(value=str(value)[:32]):
                M._ATTEMPTS.clear()
                binding, window = Binding(), Window()
                attempt = M.KeyboardAttempt(binding, window, 456)
                with self.assertRaises(M.InputRefused) as error:
                    attempt.send(value)
                self.assertFalse(error.exception.receipt["deliveryComplete"])
                self.assertEqual(window.sent, [])
                with self.assertRaisesRegex(M.InputRefused, "already reserved"):
                    attempt.send("Escape")

    def test_window_types_special_destinations_and_wrong_initial_focus_refuse(self):
        for xid in (True, 0, 1, -1, 2**32, "456", None, 456.0):
            with self.subTest(xid=xid), self.assertRaises(RuntimeError):
                self.attempt(xid)
        for focus in (0, 1, 999, 457, True, "456"):
            with self.subTest(focus=focus):
                self.window.state["focus"] = focus
                with self.assertRaises(RuntimeError):
                    self.attempt()
        self.assertEqual(self.window.sent, [])

    def test_identity_window_focus_occlusion_and_types_are_rechecked_before_input(self):
        mutations = (lambda b, w: setattr(b, "failure", "PID reused"),
                     lambda b, w: w.state["owner"].update(pid=999),
                     lambda b, w: w.state["owner"].update(pid=True),
                     lambda b, w: w.state["owner"].update(client=901),
                     lambda b, w: w.state["owner"].update(mapped=1),
                     lambda b, w: w.state["owner"].update(title="other question"),
                     lambda b, w: w.state.update(focus=457),
                     lambda b, w: w.state.update(soleWindow=False),
                     lambda b, w: w.state.update(unobscured=False),
                     lambda b, w: w.state.update(unobscured=1),
                     lambda b, w: w.state.update(frame=(10, 20, 601, 350)),
                     lambda b, w: w.state.update(frame=(10, 20, True, 350)))
        for mutate in mutations:
            M._ATTEMPTS.clear()
            binding, window = Binding(), Window()
            attempt = M.KeyboardAttempt(binding, window, 456)
            mutate(binding, window)
            with self.assertRaises(M.InputRefused) as error:
                attempt.send("Enter")
            self.assertEqual(window.sent, [])
            self.assertEqual(error.exception.receipt["delivery"], [])

    def test_partial_delivery_preserves_intent_and_never_retries_or_releases_elsewhere(self):
        attempt = self.attempt()
        self.window.hook = lambda: self.window.state.update(focus=999)
        with self.assertRaises(M.InputRefused) as error:
            attempt.send("ShiftTabSpace")
        receipt = error.exception.receipt
        self.assertEqual(self.window.sent, [(456, 23, 1, True)])
        self.assertTrue(receipt["delivery"][0]["submitted"])
        self.assertFalse(receipt["deliveryComplete"])
        self.assertFalse(receipt["outcomeVerified"])
        count = self.binding.checks, self.window.observations
        with self.assertRaises(M.InputRefused):
            attempt.send("Escape")
        self.assertEqual((self.binding.checks, self.window.observations), count)
        with self.assertRaises(M.InputRefused):
            M.KeyboardAttempt(Binding(), Window(), 456).send("Escape")

    def test_send_failure_and_flush_failure_never_mean_outcome_or_allow_retry(self):
        for mode in ("refused", "exception", "flush"):
            M._ATTEMPTS.clear()
            window = Window()
            if mode == "refused":
                window.result = 0
            elif mode == "exception":
                window.hook = lambda: (_ for _ in ()).throw(RuntimeError("send failed"))
            else:
                window.sync = lambda: (_ for _ in ()).throw(RuntimeError("flush failed"))
            attempt = M.KeyboardAttempt(Binding(), window, 456)
            with self.assertRaises(M.InputRefused) as error:
                attempt.send("Escape")
            self.assertEqual(len(window.sent), 1)
            self.assertEqual(len(error.exception.receipt["delivery"]), 1)
            self.assertTrue(error.exception.receipt["delivery"][0]["submissionAttempted"])
            self.assertEqual(error.exception.receipt["delivery"][0]["returnObserved"], mode != "exception")
            self.assertFalse(error.exception.receipt["deliveryComplete"])
            self.assertFalse(error.exception.receipt["outcomeVerified"])
            with self.assertRaises(M.InputRefused):
                attempt.send("Escape")

    def test_concurrent_attempt_objects_cannot_replay_the_same_owned_window(self):
        attempts = [self.attempt(), self.attempt()]
        barrier, results = threading.Barrier(2), []
        def run(attempt):
            barrier.wait(timeout=5)
            try:
                attempt.send("Enter")
                results.append("submitted")
            except M.InputRefused:
                results.append("refused")
        threads = [threading.Thread(target=run, args=(attempt,)) for attempt in attempts]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(sorted(results), ["refused", "submitted"])
        self.assertEqual(len(self.window.sent), 2)

    def test_ledger_is_bounded_and_receipts_do_not_share_mutable_state(self):
        M._ATTEMPTS.update((i, "1", 2) for i in range(M.MAX_ATTEMPTS))
        with self.assertRaises(M.InputRefused):
            self.attempt().send("Escape")
        self.assertEqual(self.window.sent, [])
        M._ATTEMPTS.clear()
        attempt = self.attempt()
        result = attempt.send("Escape")
        result["delivery"].clear()
        self.assertEqual(len(attempt.receipt["delivery"]), 2)
        attempt.close()
        self.assertTrue(self.binding.closed)
        with self.assertRaises(M.InputRefused):
            attempt.send("Enter")


def process(pid=123, parent=122, start="100", executable="/app/bin/creator-hub-flatpak-activate", full=True):
    value = {"pid": pid, "parentPid": parent, "startTime": start, "uids": [1001] * 4, "executable": executable,
             "image": {key: str(value) for key, value in dict(st_dev=1, st_ino=pid, st_size=100, st_mode=0o100755,
                        st_uid=0, st_gid=0, st_mtime_ns=5, st_ctime_ns=6).items()}}
    if full:
        value["kernelImageSha256"] = "a" * 64
    return value


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.child = process()
        self.origin = process(120, 119, "90", "/usr/bin/flatpak", False)
        self.launch = process(120, 119, "90", "/usr/bin/bwrap")
        self.launch["kernelImageSha256"] = "b" * 64
        self.rows = {123: self.child, 122: process(122, 120, "95", "/usr/bin/bwrap", False), 120: self.launch}
        self.held = SimpleNamespace(snapshot=lambda: (copy.deepcopy(self.child["image"]), "a" * 64), close=lambda: None)
        self.image = SimpleNamespace(snapshot=self.held.snapshot, close=lambda: None)
        self.launch_image = SimpleNamespace(snapshot=lambda: (copy.deepcopy(self.launch["image"]), "b" * 64), close=lambda: None)
        self.system = SimpleNamespace(snapshot=self.launch_image.snapshot, close=lambda: None)
        def native_process(pid, helper, full=True):
            row = copy.deepcopy(self.rows[pid])
            if not full:
                row.pop("kernelImageSha256", None)
            return row
        self.native = SimpleNamespace(native_process=native_process)
        self.calls = 0

    def guard(self):
        self.calls += 1

    def bind(self, origin=None):
        return M.OwnedLauncher(None, self.native, self.child, self.origin if origin is None else origin, self.guard,
                               image_open=lambda pid: self.image if pid == 123 else self.launch_image,
                               system_open=lambda: self.system)

    def test_pre_exec_and_already_post_exec_snapshots_bind_one_protected_bwrap(self):
        for origin in (self.origin, self.launch, {k: v for k, v in self.launch.items() if k != "kernelImageSha256"}):
            with self.subTest(original=origin["executable"]):
                binding = self.bind(origin)
                self.assertEqual(binding.launch, self.launch)
                self.assertEqual(binding.provenance["popen"], {k: origin[k] for k in M.CONTINUITY_FIELDS})
                self.assertEqual(binding.provenance["systemImage"]["path"], "/usr/bin/bwrap")
                self.assertEqual(binding.provenance["systemImage"]["kernelImageSha256"], "b" * 64)
                self.assertTrue(binding.provenance["readOnly"])
                binding.verify()
                binding.close()

    def test_original_pid_start_parent_uid_and_liveness_must_remain_owned(self):
        for change in ({"pid": 121}, {"parentPid": 118}, {"startTime": "89"}, {"uids": [1002] * 4},
                       {"executable": "/tmp/bwrap"}):
            self.setUp()
            origin = copy.deepcopy(self.origin); origin.update(change)
            with self.subTest(change=change), self.assertRaises((RuntimeError, KeyError)):
                self.bind(origin)
        self.setUp()
        binding = self.bind()
        binding.launch_guard = lambda: (_ for _ in ()).throw(RuntimeError("Owned Popen is no longer live"))
        with self.assertRaisesRegex(RuntimeError, "no longer live"):
            binding.verify()

    def test_system_image_substitution_wrong_hash_or_protected_open_failure_refuses(self):
        for field, value in (("st_ino", "999"), ("st_dev", "2"), ("st_mode", str(0o100777)), ("st_uid", "1001")):
            self.setUp()
            changed = copy.deepcopy(self.launch["image"]); changed[field] = value
            self.system.snapshot = lambda: (changed, "b" * 64)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.bind()
        self.setUp(); self.system.snapshot = lambda: (self.launch["image"], "c" * 64)
        with self.assertRaises(RuntimeError):
            self.bind()
        self.setUp()
        self.system.snapshot = lambda: (_ for _ in ()).throw(RuntimeError("Unprotected bwrap"))
        with self.assertRaisesRegex(RuntimeError, "Unprotected bwrap"):
            self.bind()

    def test_later_exec_reparent_pid_reuse_and_unrelated_signed_client_refuse(self):
        for change in ({"executable": "/usr/bin/flatpak"}, {"kernelImageSha256": "c" * 64},
                       {"parentPid": 118}, {"startTime": "91"}, {"uids": [1002] * 4}):
            self.setUp(); binding = self.bind(); self.rows[120].update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                binding.verify()
        self.setUp(); self.rows[122]["parentPid"] = 777
        self.rows[777] = process(777, 1, "80", "/usr/bin/bwrap", False)
        with self.assertRaises((RuntimeError, KeyError)):
            self.bind()

    def test_admission_requires_post_exec_now_and_an_exact_already_recorded_snapshot(self):
        self.rows[120] = copy.deepcopy(self.origin)
        self.rows[120]["kernelImageSha256"] = "d" * 64
        with self.assertRaises(RuntimeError):
            self.bind()
        self.setUp()
        original = copy.deepcopy(self.launch); original["image"]["st_ino"] = "999"
        with self.assertRaisesRegex(RuntimeError, "Recorded post-exec bwrap changed"):
            self.bind(original)

    def test_live_popen_fd_replacement_refuses_even_if_process_adapter_stays_unchanged(self):
        binding = self.bind()
        other = SimpleNamespace(snapshot=lambda: (self.launch["image"], "c" * 64), close=lambda: None)
        binding.image_open = lambda pid: self.image if pid == 123 else other
        with self.assertRaisesRegex(RuntimeError, "Live Popen"):
            binding.verify()

    def test_system_and_held_popen_images_are_rechecked_and_all_fds_close(self):
        binding = self.bind()
        before = copy.deepcopy(binding.provenance)
        for image in (binding.system, binding.launch_held):
            prior = image.snapshot
            image.snapshot = lambda: (self.launch["image"], "c" * 64)
            with self.assertRaises(RuntimeError):
                binding.verify()
            image.snapshot = prior
        binding.provenance["systemImage"]["path"] = "/untrusted"
        self.assertEqual(binding.provenance, before)
        closed = []
        binding.held.close = lambda: closed.append("client")
        binding.launch_held.close = lambda: closed.append("popen")
        binding.system.close = lambda: closed.append("system")
        binding.close(); binding.close()
        self.assertEqual(sorted(closed), ["client", "popen", "system"])

    def test_real_binding_refuses_later_image_change_before_any_keyboard_event(self):
        M._ATTEMPTS.clear()
        binding, window = self.bind(), Window()
        attempt = M.KeyboardAttempt(binding, window, 456)
        self.rows[120]["kernelImageSha256"] = "c" * 64
        with self.assertRaises(M.InputRefused):
            attempt.send("Enter")
        self.assertEqual(window.sent, [])
        self.assertFalse(attempt.receipt["deliveryComplete"])
        self.assertEqual(attempt.receipt["launchProvenance"]["admittedLaunch"]["executable"], "/usr/bin/bwrap")

    def test_held_image_live_image_owned_launch_and_ancestry_are_all_rechecked(self):
        binding = self.bind()
        before = self.calls
        binding.verify()
        self.assertGreater(self.calls, before)
        for mutate in (lambda: self.rows[123].update(startTime="101"),
                       lambda: self.rows[123].update(parentPid=777),
                       lambda: self.rows[122].update(startTime="96"),
                       lambda: self.rows[122].update(parentPid=999),
                       lambda: self.rows[120].update(startTime="91"),
                       lambda: self.rows[123].update(uids=[1002] * 4)):
            self.setUp(); binding = self.bind(); mutate()
            with self.assertRaises((RuntimeError, KeyError)):
                binding.verify()

    def test_held_fd_or_current_executable_change_refuses(self):
        for which in ("held", "current"):
            self.setUp(); binding = self.bind()
            changed = copy.deepcopy(self.child["image"]); changed["st_ino"] = "999"
            fake = SimpleNamespace(snapshot=lambda: (changed, "b" * 64), close=lambda: None)
            if which == "held":
                binding.held = fake
            else:
                binding.image_open = lambda pid: fake
            with self.assertRaises(RuntimeError):
                binding.verify()

    def test_invalid_or_unowned_launcher_inputs_refuse(self):
        for change in ({"pid": True}, {"startTime": 100}, {"uids": [True] * 4}, {"executable": "/other/app"}):
            self.setUp(); self.child.update(change)
            with self.assertRaises(RuntimeError):
                self.bind()
        self.setUp(); self.rows[122]["parentPid"] = 123
        with self.assertRaises(RuntimeError):
            self.bind()


class NativeApiTests(unittest.TestCase):
    def test_event_is_addressed_to_exact_xid_owner_without_propagation_or_global_injection(self):
        calls = []
        def send(display, window, propagate, mask, pointer):
            event = C.cast(pointer, C.POINTER(M.KeyEnvelope)).contents.key
            calls.append((display, window, propagate, mask, event.window, event.type, event.keycode, event.state))
            return 1
        api = object.__new__(M.NativeWindow)
        api.x11 = SimpleNamespace(display=99, x=SimpleNamespace(XSendEvent=send, XDefaultRootWindow=lambda display: 50))
        api.send_event = send
        self.assertEqual(api.submit(456, 23, 1, True), 1)
        self.assertEqual(calls, [(99, 456, 0, 0, 456, 2, 23, 1)])
        for window, code, modifiers, pressed in ((1, 23, 1, True), (50, 23, 1, True), (456, True, 1, True), (456, 23, 4, True), (456, 23, 1, 1)):
            with self.assertRaises(RuntimeError):
                api.submit(window, code, modifiers, pressed)
        self.assertEqual(len(calls), 1)

    def native_fixture(self):
        api = object.__new__(M.NativeWindow)
        state = {"clients": (33, 32, [456]), "focus": 456, "focusCalls": 0, "stack": [500, 999],
                 "frame": (10, 20, 600, 350), "overlay": SimpleNamespace(x=1000, y=20, width=20, height=20,
                                                                        border=0, map_state=2, class_=1)}
        x11 = SimpleNamespace(display=99, x=SimpleNamespace(XDefaultRootWindow=lambda display: 50),
            property=lambda window, name: state["clients"],
            inspect=lambda window: {"pid": 123, "client": 900, "title": "Creator Hub", "mapped": True},
            frame_rectangle=lambda window: state["frame"], sync=lambda: None)
        api.x11 = x11
        api.attributes = lambda window: SimpleNamespace(width=1920, height=1080) if window == 50 else state["overlay"]
        api.tree = lambda window: {456: (500, []), 500: (50, [456]), 50: (0, state["stack"])}.get(window, (50, []))
        def focus(display, result, revert):
            state["focusCalls"] += 1
            C.cast(result, C.POINTER(C.c_ulong))[0] = state["focus"]
            return 1
        api.get_focus = focus
        return api, state

    def test_actual_snapshot_rejects_extra_windows_offscreen_and_obscuring_drawables(self):
        api, state = self.native_fixture()
        M.validate_target(api.snapshot(456), {"pid": 123}, 456)
        mutations = (lambda s: s.update(clients=(33, 32, [456, 789])),
                     lambda s: s.update(frame=(1900, 20, 600, 350)),
                     lambda s: s.update(focus=457),
                     lambda s: s.update(stack=[999]),
                     lambda s: setattr(s["overlay"], "x", 30))
        for mutate in mutations:
            api, state = self.native_fixture(); mutate(state)
            with self.assertRaises(RuntimeError):
                api.snapshot(456)
        api, state = self.native_fixture()
        state["stack"] = [999, 500]
        state["overlay"].x = 30
        self.assertTrue(api.snapshot(456)["unobscured"])

    def test_actual_snapshot_rechecks_focus_after_final_window_queries(self):
        api, state = self.native_fixture()
        def property_read(window, name):
            if state["focusCalls"]:
                state["focus"] = 999
            return state["clients"]
        api.x11.property = property_read
        with self.assertRaises(RuntimeError):
            api.snapshot(456)

    def test_native_key_mapping_must_roundtrip_and_never_accepts_arbitrary_keys(self):
        api = object.__new__(M.NativeWindow)
        api.x11 = SimpleNamespace(display=99, sync=lambda: None)
        api.to_code = lambda display, symbol: 9
        api.to_symbol = lambda display, code, level: 0xff1b
        self.assertEqual(api.keycode(0xff1b), 9)
        for key in (True, 0, "Escape", 0x61, 0xff0d):
            with self.assertRaises(RuntimeError):
                api.keycode(key)
        api.to_code = lambda display, symbol: 0
        with self.assertRaises(RuntimeError):
            api.keycode(0xff1b)

    def test_pure_rectangle_and_occlusion_contract_rejects_overlap_and_type_confusion(self):
        self.assertTrue(M.intersects((10, 20, 600, 350), (20, 30, 10, 10)))
        self.assertFalse(M.intersects((10, 20, 600, 350), (610, 20, 10, 10)))
        for frame in ((-1, 20, 600, 350), (10, 20, True, 350), (10, 20, 0, 350), (10, 20, 8193, 350), [10, 20, 600, 350]):
            window = Window(); window.state["frame"] = frame
            with self.assertRaises(RuntimeError):
                M.KeyboardAttempt(Binding(), window, 456)

    def test_factory_refuses_non_linux_before_loading_native_apis(self):
        with patch.object(M.sys, "platform", "win32"), self.assertRaises(RuntimeError):
            M.capture(None, None, None, {}, {}, None, 456)


class DirectChildFocusTests(unittest.TestCase):
    def setUp(self):
        M._ATTEMPTS.clear()
        # Native 39395026033: stable same-client direct child, not a timing guess.
        self.target, self.child, self.root, self.frame = 8388611, 8388612, 1293, 6291556
        self.owner = {'pid': 7296, 'client': 8388608, 'title': 'Creator Hub', 'mapped': True}
        self.state = {'focus': self.child, 'revert': 2, 'active': (33, 32, [self.target]),
                      'clients': (33, 32, [self.target]), 'stack': [self.frame, 8388609],
                      'parent': self.target, 'xres': {'pid': 7296, 'client': 8388608},
                      'targetXres': {'pid': 7296, 'client': 8388608}, 'geometry': (368, 367, 546, 286),
                      'overlay': SimpleNamespace(x=1500, y=20, width=20, height=20, border=0, map_state=2, class_=1)}
        self.api = object.__new__(M.NativeWindow)
        self.api.x11 = SimpleNamespace(display=99, x=SimpleNamespace(XDefaultRootWindow=lambda _: self.root),
            property=lambda window, name: self.state['active'] if name == '_NET_ACTIVE_WINDOW' else self.state['clients'],
            inspect=lambda window: copy.deepcopy(self.owner), frame_rectangle=lambda window: self.state['geometry'], sync=lambda: None)
        self.api.attributes = lambda window: SimpleNamespace(width=1920, height=1080) if window == self.root else self.state['overlay']
        self.tree_reads, self.xres_reads, self.sent = [], [], []
        def tree(window):
            self.tree_reads.append(window)
            return {self.target: (self.frame, [self.child]), self.child: (self.state['parent'], []),
                    self.frame: (self.root, [self.target]), self.root: (0, self.state['stack'])}.get(window, (self.root, []))
        self.api.tree = tree
        def xres(window):
            self.xres_reads.append(window)
            return copy.deepcopy(self.state['targetXres'] if window == self.target else self.state['xres'])
        self.api.xres_identity = xres
        def focus(display, result, revert):
            C.cast(result, C.POINTER(C.c_ulong))[0] = self.state['focus']
            C.cast(revert, C.POINTER(C.c_int))[0] = self.state['revert']
            return 1
        self.api.get_focus = focus
        self.api.keycode = lambda symbol: {0xff1b: 9, 0xff0d: 36, 0xff09: 23, 0x20: 65}[symbol]
        self.hook = lambda: None
        def submit(window, code, modifiers, pressed):
            self.sent.append((window, code, modifiers, pressed)); self.hook()
            return 1
        self.api.submit = submit
        self.binding = Binding()
        self.binding.process = process(7296, 7295, '22221')

    def expected_proof(self):
        return {'window': self.child, 'parent': self.target, 'root': self.root, 'pid': 7296,
                'client': 8388608, 'activeWindow': self.target, 'revert': 2}

    def test_actual_native_direct_child_shape_is_retained_and_delivery_still_targets_toplevel(self):
        snapshot = self.api.snapshot(self.target)
        self.assertEqual(snapshot['focus'], self.child)
        self.assertEqual(snapshot['directChildFocus'], self.expected_proof())
        M.validate_target(snapshot, self.binding.process, self.target)
        attempt = M.KeyboardAttempt(self.binding, self.api, self.target)
        receipt = attempt.send('Escape')
        self.assertEqual(attempt.baseline['directChildFocus'], self.expected_proof())
        self.assertEqual(self.sent, [(self.target, 9, 0, True), (self.target, 9, 0, False)])
        self.assertTrue(receipt['deliveryComplete']); self.assertFalse(receipt['outcomeVerified'])
        self.assertNotIn('directChildFocus', receipt)
        self.assertGreaterEqual(self.binding.checks, 8)

    def test_original_top_level_path_requires_no_child_or_active_window_queries(self):
        self.state['focus'] = self.target
        property_read = self.api.x11.property
        def prop(window, name):
            self.assertNotEqual(name, '_NET_ACTIVE_WINDOW')
            return property_read(window, name)
        self.api.x11.property = prop
        snapshot = self.api.snapshot(self.target)
        self.assertEqual(set(snapshot), {'owner', 'frame', 'focus', 'soleWindow', 'unobscured'})
        self.assertEqual(snapshot['focus'], self.target); self.assertEqual(self.xres_reads, [])
        M.validate_target(snapshot, self.binding.process, self.target)
        attempt = M.KeyboardAttempt(self.binding, self.api, self.target)
        attempt.send('Escape')
        self.assertEqual(self.binding.checks, 6)
        self.assertEqual(self.sent, [(self.target, 9, 0, True), (self.target, 9, 0, False)])
        self.assertEqual(self.xres_reads, [])

    def test_foreign_client_pid_target_binding_and_non_direct_parent_never_reach_input(self):
        mutations = (lambda: self.state['xres'].update(client=8388609), lambda: self.state['xres'].update(pid=7297),
                     lambda: self.state['targetXres'].update(client=8388609), lambda: self.state['targetXres'].update(pid=7297),
                     lambda: self.state.update(parent=999), lambda: self.state.update(parent=self.frame),
                     lambda: self.state.update(parent=self.child), lambda: self.state.update(parent=8388613),
                     lambda: self.state.update(parent=float(self.target)))
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp(); mutate()
                with self.assertRaises(RuntimeError): M.KeyboardAttempt(self.binding, self.api, self.target)
                self.assertEqual(self.sent, [])

    def test_sentinels_desktop_root_and_sibling_are_not_queried_or_admitted_as_children(self):
        for focus in (0, 1, self.root, self.frame):
            with self.subTest(focus=focus):
                self.state['focus'] = focus; self.tree_reads.clear(); self.xres_reads.clear()
                with self.assertRaises(RuntimeError): self.api.snapshot(self.target)
                self.assertEqual(self.sent, []); self.assertEqual(self.xres_reads, [])
                if focus in (0, 1): self.assertNotIn(focus, self.tree_reads)

    def test_active_window_must_be_exact_managed_target_not_child_or_another_window(self):
        for active in (None, (33, 32, [self.child]), (33, 32, [999]), (33, 32, [self.target, 999]),
                       (6, 32, [self.target]), [33, 32, [self.target]]):
            with self.subTest(active=active):
                self.state['active'] = active
                with self.assertRaises(RuntimeError): self.api.snapshot(self.target)
                self.assertEqual(self.sent, [])

    def test_direct_child_proof_schema_types_identity_and_raw_focus_are_exact(self):
        snapshot = self.api.snapshot(self.target)
        mutations = (lambda v: v['directChildFocus'].update(extra=True), lambda v: v.pop('directChildFocus'),
                     lambda v: v['directChildFocus'].pop('root'), lambda v: v['directChildFocus'].update(parent=self.frame),
                     lambda v: v['directChildFocus'].update(window=self.target), lambda v: v['directChildFocus'].update(pid=7297),
                     lambda v: v['directChildFocus'].update(client=8388609), lambda v: v['directChildFocus'].update(activeWindow=self.child),
                     lambda v: v['directChildFocus'].update(root=self.child), lambda v: v['directChildFocus'].update(revert=True),
                     lambda v: v['directChildFocus'].update(revert=3), lambda v: v['directChildFocus'].update(pid=2**31),
                     lambda v: v['directChildFocus'].update(client=2**32), lambda v: v['directChildFocus'].update(root=True),
                     lambda v: v.update(focus=0), lambda v: v.update(focus=2**32),
                     lambda v: v.update(focus=True), lambda v: v.update(focus=self.target))
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = copy.deepcopy(snapshot); mutate(value)
                with self.assertRaises(RuntimeError): M.validate_target(value, self.binding.process, self.target)

    def test_child_focus_revert_ancestry_xres_and_active_window_are_rechecked_within_snapshot(self):
        mutations = (lambda: self.state.update(focus=self.target), lambda: self.state.update(focus=8388613),
                     lambda: self.state.update(revert=1), lambda: self.state.update(parent=self.frame),
                     lambda: self.state['xres'].update(client=8388609), lambda: self.state.update(active=(33, 32, [999])))
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp(); read = self.api.get_focus; calls = []
                def focus(*args):
                    calls.append(None)
                    if len(calls) == 2: mutate()
                    return read(*args)
                self.api.get_focus = focus
                with self.assertRaises(RuntimeError): self.api.snapshot(self.target)
                self.assertEqual(self.sent, [])

    def test_process_and_window_drift_before_key_or_between_strokes_never_retry_or_release_elsewhere(self):
        mutations = (lambda: setattr(self.binding, 'failure', 'PID/start/UID/image changed'),
                     lambda: self.state.update(parent=self.frame), lambda: self.state.update(focus=self.target),
                     lambda: self.state.update(active=(33, 32, [999])), lambda: self.state.update(geometry=(369, 367, 546, 286)),
                     lambda: self.state.update(clients=(33, 32, [self.target, 999])),
                     lambda: (setattr(self.state['overlay'], 'x', 400), setattr(self.state['overlay'], 'y', 400)))
        for mutate in mutations:
            for partial in (False, True):
                with self.subTest(mutate=mutate, partial=partial):
                    self.setUp(); attempt = M.KeyboardAttempt(self.binding, self.api, self.target)
                    if partial: self.hook = mutate
                    else: mutate()
                    with self.assertRaises(M.InputRefused) as raised: attempt.send('Escape')
                    self.assertEqual(len(self.sent), 1 if partial else 0)
                    self.assertEqual(len(raised.exception.receipt['delivery']), 1 if partial else 0)
                    with self.assertRaises(M.InputRefused): attempt.send('Escape')
                    self.assertEqual(len(self.sent), 1 if partial else 0)

    def test_real_owned_binding_detects_pid_start_uid_and_image_drift_after_final_child_query(self):
        mutations = (lambda row: row.update(startTime='999'), lambda row: row.update(parentPid=999),
                     lambda row: row.update(uids=[1002] * 4), lambda row: row.update(kernelImageSha256='c' * 64),
                     lambda row: row['image'].update(st_ino='999'))
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp(); signed = LauncherTests(); signed.setUp()
                self.owner['pid'] = self.state['xres']['pid'] = self.state['targetXres']['pid'] = 123
                binding = signed.bind()
                read, calls = self.api.get_focus, []
                def focus(*args):
                    calls.append(None)
                    if len(calls) == 4: mutate(signed.rows[123])
                    return read(*args)
                self.api.get_focus = focus
                try:
                    with self.assertRaises(RuntimeError): M.KeyboardAttempt(binding, self.api, self.target)
                    self.assertEqual(len(calls), 4); self.assertEqual(self.sent, [])
                finally:
                    binding.close()

    def test_different_otherwise_valid_direct_child_cannot_replace_the_frozen_focus(self):
        for partial in (False, True):
            with self.subTest(partial=partial):
                self.setUp(); original_tree = self.api.tree
                self.api.tree = lambda window: (self.target, []) if window == 8388613 else original_tree(window)
                attempt = M.KeyboardAttempt(self.binding, self.api, self.target)
                change = lambda: self.state.update(focus=8388613)
                if partial: self.hook = change
                else: change()
                with self.assertRaises(M.InputRefused): attempt.send('Escape')
                self.assertEqual(len(self.sent), 1 if partial else 0)
                self.assertEqual(attempt.baseline['focus'], self.child)
                with self.assertRaises(M.InputRefused): attempt.send('Escape')
                self.assertEqual(len(self.sent), 1 if partial else 0)


class FocusDiagnosticTests(unittest.TestCase):
    def setUp(self):
        M._ATTEMPTS.clear()
        self.api, self.state = NativeApiTests().native_fixture()
        self.state.update(focus=457, active=999)
        self.binding = SimpleNamespace(process=process(), helper=None, checks=0)
        def verify():
            self.binding.checks += 1
        self.binding.verify = verify
        self.binding.native = SimpleNamespace(native_process=lambda *_: process(full=False), process_uids=lambda _: [1001] * 4)
        self.api.x11.property = lambda window, name: (33, 32, [self.state['active']]) if name == '_NET_ACTIVE_WINDOW' else self.state['clients']
        self.queries = []
        def tree(window):
            self.queries.append(window)
            return {457: (456, []), 456: (500, [457]), 500: (50, [456]), 50: (0, self.state['stack'])}[window]
        self.api.tree = tree
        self.api.xres_identity = lambda window: {'pid': 123, 'client': 900}
        self.directory = SimpleNamespace(st_mode=0o40500, st_uid=1001, st_gid=1001, st_dev=1, st_ino=123)
        original_stat = M.os.stat
        self.stat_patch = patch.object(M.os, 'stat', side_effect=lambda path, *args, **kwargs:
            self.directory if str(path).startswith('/proc/') else original_stat(path, *args, **kwargs))
        self.stat_patch.start(); self.addCleanup(self.stat_patch.stop)
        self.uid_patch = patch.object(M.os, 'getuid', return_value=1001, create=True)
        self.uid_patch.start(); self.addCleanup(self.uid_patch.stop)

    def refused(self):
        with self.assertRaisesRegex(RuntimeError, 'Focus is not the exact owned top-level XID') as raised:
            self.api.snapshot(456)
        return raised.exception

    def test_original_focus_child_chain_and_two_stable_observations_are_diagnostic_only(self):
        error = self.refused()
        M.retain_focus_diagnostic(error, self.binding, self.api, 456)
        value = error.focus_diagnostic
        self.assertEqual(value['original']['focus'], 457)
        self.assertEqual(value['original']['target'], 456)
        self.assertEqual(value['before']['focusParents'][0]['parent'], 456)
        self.assertEqual(value['before'], value['after'])
        self.assertTrue(value['complete']); self.assertTrue(value['stable'])
        self.assertGreaterEqual(self.binding.checks, 4)
        self.assertTrue(value['readOnly']); self.assertFalse(value['inputPermitted'])
        self.assertFalse(value['authorityGranted']); self.assertFalse(value['releaseReady'])
        self.assertNotIn('executable', value['before']['focusParents'][0]['xres']['process'])
        self.assertLessEqual(len(json.dumps(value)), 32768)

    def test_sentinel_focus_never_queries_a_window_or_process(self):
        for sentinel, label in ((0, 'None'), (1, 'PointerRoot')):
            with self.subTest(sentinel=sentinel):
                self.setUp(); self.state['focus'] = sentinel
                self.api.xres_identity = Mock(side_effect=AssertionError('No sentinel XRes query'))
                self.refused()
                value = self.api.focus_diagnostic(self.binding, 456)
                self.assertEqual(value['before']['focusSentinel'], label)
                self.assertEqual(value['before']['focusParents'], [])
                self.assertFalse(any(v in (0, 1) for v in self.queries))
                self.api.xres_identity.assert_not_called()

    def test_later_focus_or_target_change_is_recorded_but_never_becomes_authority(self):
        self.refused(); self.state['focus'] = 456
        value = self.api.focus_diagnostic(self.binding, 456)
        self.assertEqual(value['original']['focus'], 457)
        self.assertEqual(value['after']['focus'], 456)
        self.assertFalse(value['stable']); self.assertFalse(value['inputPermitted'])
        self.state['frame'] = (11, 20, 600, 350)
        self.assertFalse(self.api.focus_diagnostic(self.binding, 456)['stable'])

    def test_foreign_uid_never_reads_process_details_or_window_titles(self):
        self.refused()
        self.directory.st_uid = 1002
        self.binding.native.native_process = Mock(side_effect=AssertionError('No foreign process read'))
        self.binding.native.process_uids = Mock(side_effect=AssertionError('No foreign UID detail read'))
        self.api.x11.inspect = lambda window: {'pid': 123, 'client': 900, 'title': 'Creator Hub', 'mapped': True} if window == 456 else (_ for _ in ()).throw(AssertionError('No foreign title'))
        value = self.api.focus_diagnostic(self.binding, 456)
        self.assertTrue(value['complete'])
        self.assertFalse(value['stable'])
        self.assertTrue(value['before']['focusParents'][0]['xres']['processRedacted'])
        self.binding.native.native_process.assert_not_called()
        self.binding.native.process_uids.assert_not_called()

    def test_target_title_is_redacted_and_process_failure_preserves_original_exception(self):
        error = self.refused()
        self.api.x11.inspect = lambda _: {'pid': 123, 'client': 900, 'title': 'PRIVATE FOREIGN TITLE', 'mapped': True}
        M.retain_focus_diagnostic(error, self.binding, self.api, 456)
        self.assertNotIn('PRIVATE', json.dumps(error.focus_diagnostic))
        self.assertFalse(error.focus_diagnostic['complete'])
        self.assertEqual(str(error), 'Focus is not the exact owned top-level XID')
        self.binding.verify = Mock(side_effect=PermissionError('PRIVATE ERROR'))
        M.retain_focus_diagnostic(error, self.binding, self.api, 456)
        self.assertNotIn('PRIVATE', json.dumps(error.focus_diagnostic))
        self.assertFalse(error.focus_diagnostic['complete'])
        self.assertEqual(str(error), 'Focus is not the exact owned top-level XID')

    def test_focus_active_window_and_exact_target_rechecks_cannot_become_input_authority(self):
        self.refused()
        original_focus, count = self.api.get_focus, []
        def focus(*args):
            count.append(None)
            if len(count) == 2: self.state.update(focus=456, active=999)
            return original_focus(*args)
        self.api.get_focus = focus
        value = self.api.focus_diagnostic(self.binding, 456)
        self.assertEqual(value['before']['focus'], 457); self.assertEqual(value['after']['focus'], 456)
        self.assertEqual(value['after']['activeWindow'], (33, 32, [999]))
        self.assertFalse(value['stable']); self.assertFalse(value['inputPermitted'])
        self.binding.verify = Mock(side_effect=[None, RuntimeError('target changed')])
        value = self.api.focus_diagnostic(self.binding, 456)
        self.assertFalse(value['complete']); self.assertFalse(value['stable'])
        self.assertNotIn('after', value)

    def test_bounds_cycles_denied_and_changed_process_are_incomplete_not_accepted(self):
        for failure in ('cycle', 'depth', 'denied', 'uid', 'pid-reuse', 'oversize'):
            with self.subTest(failure=failure):
                self.setUp(); self.refused()
                if failure == 'cycle': self.api.tree = lambda window: (window, [])
                if failure == 'depth': self.api.tree = lambda window: (window + 1, [])
                if failure == 'denied': self.api.tree = Mock(side_effect=PermissionError('PRIVATE'))
                if failure == 'uid': self.binding.native.process_uids = lambda _: [1002] * 4
                if failure == 'pid-reuse':
                    calls = []
                    def changed(*_):
                        row = process(full=False); calls.append(None)
                        if len(calls) > 1: row['startTime'] = '999'
                        return row
                    self.binding.native.native_process = changed
                if failure == 'oversize': self.state['clients'] = (33, 32, list(range(1000)))
                value = self.api.focus_diagnostic(self.binding, 456)
                self.assertFalse(value['complete']); self.assertFalse(value['stable'])
                self.assertFalse(value['inputPermitted']); self.assertNotIn('PRIVATE', json.dumps(value))

    def test_no_diagnostic_without_a_focus_refusal_and_capture_failure_never_replaces_error(self):
        error = RuntimeError('original')
        M.retain_focus_diagnostic(error, self.binding, self.api, 456)
        self.assertFalse(hasattr(error, 'focus_diagnostic'))
        self.refused(); self.api.focus_diagnostic = Mock(side_effect=RuntimeError('diagnostic failed'))
        M.retain_focus_diagnostic(error, self.binding, self.api, 456)
        self.assertEqual(str(error), 'original')
        self.assertFalse(hasattr(error, 'focus_diagnostic'))

    def test_factory_retains_constructor_refusal_and_closes_binding_without_sending(self):
        self.binding.provenance, self.binding.close = {'readOnly': True}, Mock()
        original_snapshot, errors = self.api.snapshot, []
        def snapshot(window):
            try:
                return original_snapshot(window)
            except RuntimeError as error:
                errors.append(error)
                raise
        self.api.snapshot = snapshot
        self.api.submit = Mock(side_effect=AssertionError('No input during capture'))
        with patch.object(M.sys, 'platform', 'linux'), patch.object(M.platform, 'machine', return_value='x86_64'), \
                patch.object(M.os, 'geteuid', return_value=1001, create=True), \
                patch.object(M, 'OwnedLauncher', return_value=self.binding) as constructor, \
                patch.object(M, 'NativeWindow', return_value=self.api):
            with self.assertRaisesRegex(RuntimeError, 'Focus is not the exact owned top-level XID') as raised:
                M.capture(None, self.binding.native, self.api.x11, self.binding.process, {}, lambda: None, 456)
        self.assertIs(raised.exception, errors[0])
        self.assertEqual(raised.exception.focus_diagnostic['original']['focus'], 457)
        constructor.assert_called_once(); self.binding.close.assert_called_once(); self.api.submit.assert_not_called()

    def test_pre_input_send_refusal_retains_diagnostic_without_changing_receipt_or_retrying(self):
        self.binding.provenance, self.binding.close = {'readOnly': True}, Mock()
        self.state['focus'] = 456
        self.api.keycode = lambda _: 9
        self.api.submit = Mock(side_effect=AssertionError('No input after focus refusal'))
        attempt = M.KeyboardAttempt(self.binding, self.api, 456)
        self.state['focus'] = 457
        with self.assertRaises(M.InputRefused) as raised:
            attempt.send('Escape')
        self.assertEqual(raised.exception.receipt['delivery'], [])
        self.assertNotIn('focusDiagnostic', raised.exception.receipt)
        self.assertEqual(raised.exception.focus_diagnostic['original']['focus'], 457)
        reads = self.state['focusCalls']
        with self.assertRaises(M.InputRefused):
            attempt.send('Escape')
        self.assertEqual(self.state['focusCalls'], reads)
        self.api.submit.assert_not_called()

    def test_post_submission_refusal_does_not_run_new_focus_capture(self):
        binding, window = Binding(), Window()
        window.focus_diagnostic = Mock(side_effect=AssertionError('No capture after any key submission'))
        attempt = M.KeyboardAttempt(binding, window, 456)
        window.hook = lambda: window.state.update(focus=999)
        with self.assertRaises(M.InputRefused) as raised:
            attempt.send('Escape')
        self.assertEqual(len(raised.exception.receipt['delivery']), 1)
        self.assertFalse(hasattr(raised.exception, 'focus_diagnostic'))
        window.focus_diagnostic.assert_not_called()

    def test_raw_xres_query_never_reads_titles_and_checks_fixed_pid_format(self):
        class Spec(C.Structure):
            _fields_ = [('client', C.c_ulong), ('mask', C.c_uint)]
        class Value(C.Structure):
            _fields_ = [('spec', Spec), ('length', C.c_long), ('value', C.c_void_p)]
        item = (Value * 1)(Value(Spec(900, 2), 4, 1))
        observations = {'status': 0, 'count': 1, 'pid': 123}
        def query(display, count, specification, result_count, values):
            self.assertEqual(display, 99); self.assertEqual(count, 1)
            spec = C.cast(specification, C.POINTER(Spec)).contents
            self.assertEqual((spec.client, spec.mask), (457, 2))
            C.cast(result_count, C.POINTER(C.c_long))[0] = observations['count']
            C.cast(values, C.POINTER(C.POINTER(Value)))[0] = C.cast(item, C.POINTER(Value))
            return observations['status']
        api = object.__new__(M.NativeWindow)
        api.helper = SimpleNamespace(ClientSpec=Spec, ClientValue=Value)
        api.x11 = SimpleNamespace(display=99, res=SimpleNamespace(XResQueryClientIds=query,
            XResGetClientPid=lambda _: observations['pid'], XResClientIdsDestroy=Mock()), sync=lambda: None)
        self.assertEqual(api.xres_identity(457), {'pid': 123, 'client': 900})
        for key, value in (('status', 1), ('count', 2), ('pid', 1)):
            with self.subTest(key=key):
                old = observations[key]; observations[key] = value
                with self.assertRaises(RuntimeError): api.xres_identity(457)
                observations[key] = old
        self.assertEqual(api.x11.res.XResClientIdsDestroy.call_count, 4)


class WarmCompanionTests(unittest.TestCase):
    def setUp(self):
        M._ATTEMPTS.clear()
        self.root = process(321, 1, '90', '/approved/AppDir/usr/bin/creator-hub')
        self.owner = {'name': ':1.40', 'pid': 321}
        self.xres = {'pid': 321, 'client': 901, 'title': 'Creator Hub', 'mapped': True}
        self.cold_xres = copy.deepcopy(self.xres)
        self.counts = {'native': 0, 'owner': 0, 'image': 0, 'xres': 0}
        self.images = []
        self.held_result = lambda: (copy.deepcopy(self.root['image']), 'a' * 64)
        self.current_result = lambda: (copy.deepcopy(self.root['image']), 'a' * 64)
        def inspect(window):
            self.assertEqual(window, 789)
            self.counts['xres'] += 1
            return copy.deepcopy(self.xres)
        self.x11 = SimpleNamespace(display=99, inspect=inspect)
        def native(pid, helper, full=True):
            self.assertEqual(pid, 321)
            self.counts['native'] += 1
            return copy.deepcopy(self.root)
        self.native = SimpleNamespace(native_process=native)

    def owner_probe(self):
        self.counts['owner'] += 1
        return copy.deepcopy(self.owner)

    def image_open(self, pid):
        self.assertEqual(pid, 321)
        self.counts['image'] += 1
        held = not self.images
        image = SimpleNamespace(closed=False)
        image.snapshot = lambda: self.held_result() if held else self.current_result()
        image.close = lambda: setattr(image, 'closed', True)
        self.images.append(image)
        return image

    def bind(self):
        with patch.object(M.sys, 'platform', 'linux'), patch.object(M.platform, 'machine', return_value='x86_64'), \
                patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'geteuid', return_value=1001, create=True):
            return M.bind_warm_root(None, self.native, self.x11, self.root, 789, self.owner, self.owner_probe,
                                    cold_xres=self.cold_xres, image_open=self.image_open)

    def attempt(self):
        companion = self.bind()
        window, binding = Window(), Binding()
        window.state.update(soleWindow=False, warmCompanion=companion.evidence, managedWindows=[789, 456])
        return M.KeyboardAttempt(binding, window, 456, warm_companion=companion), companion, window

    def test_companion_cannot_be_constructed_as_a_generic_allowlist(self):
        with self.assertRaises(RuntimeError):
            M.WarmRoot(None, None, None, {}, 789, {}, None)
        for value in ({}, [], [789], True, SimpleNamespace()):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                M.KeyboardAttempt(Binding(), Window(), 456, warm_companion=value)

    def test_one_warm_enter_rechecks_root_image_xres_and_host_owner_before_each_event(self):
        attempt, companion, window = self.attempt()
        before = copy.deepcopy(self.counts)
        receipt = attempt.send('Enter')
        self.assertEqual(window.sent, [(456, 36, 0, True), (456, 36, 0, False)])
        for key in self.counts:
            self.assertGreaterEqual(self.counts[key] - before[key], 6, key)
        self.assertEqual(receipt['warmCompanion'], {'binding': companion.evidence, 'managedWindows': [789, 456]})
        self.assertFalse(attempt.baseline['soleWindow'])
        self.assertTrue(receipt['deliveryComplete']); self.assertFalse(receipt['outcomeVerified'])
        attempt.close(); attempt.close()
        self.assertTrue(all(image.closed for image in self.images))
        with self.assertRaises(RuntimeError): companion.verify()

    def test_actual_cold_receipt_title_is_bound_without_a_title_allowlist(self):
        # Run 39411925207 qualified this cold window before warm admission refused its branding.
        self.root['pid'] = self.owner['pid'] = 7460
        self.xres = {'pid': 7460, 'client': 14680064, 'title': 'Creator Hub - Development Preview', 'mapped': True}
        self.cold_xres = copy.deepcopy(self.xres)
        self.native.native_process = lambda pid, helper: copy.deepcopy(self.root)
        self.image_open = lambda pid: SimpleNamespace(snapshot=lambda: self.current_result(), close=lambda: None)
        companion = self.bind()
        self.assertEqual(companion.evidence['xres'], self.cold_xres)
        companion.verify()
        self.cold_xres['title'] = 'Caller mutated the retained record'
        self.assertEqual(companion.evidence['xres']['title'], 'Creator Hub - Development Preview')
        companion.close()

    def test_cold_record_must_be_exact_before_any_image_or_input_is_opened(self):
        mutations = ({'pid': 322}, {'pid': True}, {'client': 902}, {'client': True}, {'client': 2**32},
                     {'title': 'Creator Hub - Development Preview'}, {'title': ''}, {'title': 'x' * 4097},
                     {'mapped': False}, {'mapped': 1}, {'extra': True})
        for change in mutations:
            self.setUp(); self.cold_xres.update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError): self.bind()
            self.assertEqual(self.images, [])
        for value in (None, [], {}, {'pid': 321}):
            self.setUp(); self.cold_xres = value
            with self.subTest(value=value), self.assertRaises(RuntimeError): self.bind()
            self.assertEqual(self.images, [])

    def test_cold_record_is_required_even_when_live_window_matches_old_title(self):
        with patch.object(M.sys, 'platform', 'linux'), patch.object(M.platform, 'machine', return_value='x86_64'), \
                patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'geteuid', return_value=1001, create=True):
            with self.assertRaises(TypeError):
                M.bind_warm_root(None, self.native, self.x11, self.root, 789, self.owner, self.owner_probe, image_open=self.image_open)
        self.assertEqual(self.images, [])

    def test_companion_never_authorizes_escape_shift_tab_or_repeated_attempt(self):
        for sequence in ('Escape', 'ShiftTabSpace'):
            self.setUp()
            attempt, companion, window = self.attempt()
            with self.subTest(sequence=sequence), self.assertRaises(M.InputRefused):
                attempt.send(sequence)
            self.assertEqual(window.sent, [])
            with self.assertRaises(M.InputRefused): attempt.send('Enter')
            attempt.close()

    def test_changed_root_pid_start_uid_image_or_process_exit_refuses_before_input(self):
        for change in ({'pid': 322}, {'parentPid': 2}, {'startTime': '91'}, {'uids': [1002] * 4},
                       {'kernelImageSha256': 'b' * 64}, {'executable': '/other/AppDir/usr/bin/creator-hub'}):
            self.setUp(); attempt, companion, window = self.attempt(); self.root.update(change)
            with self.subTest(change=change), self.assertRaises(M.InputRefused): attempt.send('Enter')
            self.assertEqual(window.sent, []); attempt.close()
        self.setUp(); attempt, companion, window = self.attempt()
        self.native.native_process = lambda *_: (_ for _ in ()).throw(ProcessLookupError('Root exited'))
        with self.assertRaises(M.InputRefused): attempt.send('Enter')
        self.assertEqual(window.sent, []); attempt.close()

    def test_changed_xres_xid_visibility_or_host1_owner_refuses_before_input(self):
        changes = (lambda: self.xres.update(pid=322), lambda: self.xres.update(client=902),
                   lambda: self.xres.update(mapped=False), lambda: self.xres.update(title='Different Root'),
                   lambda: self.owner.update(name=':1.41'), lambda: self.owner.update(pid=322))
        for change in changes:
            self.setUp(); attempt, companion, window = self.attempt(); change()
            with self.subTest(change=change), self.assertRaises(M.InputRefused): attempt.send('Enter')
            self.assertEqual(window.sent, []); attempt.close()
        self.setUp(); attempt, companion, window = self.attempt()
        self.x11.inspect = lambda _: (_ for _ in ()).throw(RuntimeError('Root XID unavailable'))
        with self.assertRaises(M.InputRefused): attempt.send('Enter')
        self.assertEqual(window.sent, []); attempt.close()

    def test_changed_held_or_live_root_fd_refuses_without_path_only_adoption(self):
        for which in ('held', 'current'):
            self.setUp(); attempt, companion, window = self.attempt()
            changed = lambda: (copy.deepcopy(self.root['image']), 'b' * 64)
            if which == 'held': self.held_result = changed
            else: self.current_result = changed
            with self.subTest(which=which), self.assertRaises(M.InputRefused): attempt.send('Enter')
            self.assertEqual(window.sent, []); attempt.close()

    def test_companion_change_after_keypress_retains_partial_and_never_releases_or_retries(self):
        attempt, companion, window = self.attempt()
        window.hook = lambda: self.owner.update(name=':1.41')
        with self.assertRaises(M.InputRefused) as error: attempt.send('Enter')
        self.assertEqual(window.sent, [(456, 36, 0, True)])
        self.assertFalse(error.exception.receipt['deliveryComplete'])
        self.assertTrue(error.exception.receipt['delivery'][0]['synchronized'])
        with self.assertRaises(M.InputRefused): attempt.send('Enter')
        attempt.close()

    def test_two_window_mode_never_ignores_target_focus_occlusion_or_extra_windows(self):
        changes = (lambda window: window.state.update(focus=789), lambda window: window.state.update(unobscured=False),
                   lambda window: window.state.update(managedWindows=[789, 456, 999]),
                   lambda window: window.state.update(managedWindows=[456, 789]),
                   lambda window: window.state.update(soleWindow=True))
        for change in changes:
            self.setUp(); attempt, companion, window = self.attempt(); change(window)
            with self.subTest(change=change), self.assertRaises(M.InputRefused): attempt.send('Enter')
            self.assertEqual(window.sent, []); attempt.close()

    def native_fixture(self):
        api, state = NativeApiTests().native_fixture()
        target = api.x11.inspect
        self.x11 = api.x11
        api.x11.inspect = lambda window: copy.deepcopy(self.xres) if window == 789 else target(window)
        companion = self.bind()
        api.warm_companion = companion
        state['clients'] = (33, 32, [789, 456]); state['stack'] = [800, 500, 999]
        old_tree = api.tree
        api.tree = lambda window: (800, []) if window == 789 else (50, [789]) if window == 800 else old_tree(window)
        return api, state, companion

    def test_native_snapshot_requires_exact_two_windows_and_companion_below_target(self):
        api, state, companion = self.native_fixture()
        value = api.snapshot(456)
        M.validate_target(value, {'pid': 123}, 456, warm_companion=companion)
        self.assertFalse(value['soleWindow']); self.assertEqual(value['managedWindows'], [789, 456])
        changes = (lambda: state.update(clients=(33, 32, [789, 456, 999])),
                   lambda: state.update(clients=(33, 32, [456, 789])),
                   lambda: state.update(clients=(33, 32, [456])),
                   lambda: state.update(stack=[500, 800, 999]),
                   lambda: state.update(focus=789), lambda: setattr(state['overlay'], 'x', 30))
        for index in range(len(changes)):
            self.setUp(); api, state, companion = self.native_fixture()
            changes[index]()
            with self.subTest(change=index), self.assertRaises(RuntimeError): api.snapshot(456)
            companion.close()

    def test_exact_two_window_snapshot_is_not_accepted_without_companion_authority(self):
        api, state, companion = self.native_fixture()
        with self.assertRaises(RuntimeError): M.validate_target(api.snapshot(456), {'pid': 123}, 456)
        api.warm_companion = None
        with self.assertRaises(RuntimeError): api.snapshot(456)
        companion.close()

    def test_capture_rejects_foreign_session_same_target_or_wrong_uid_before_native_input_setup(self):
        companion = self.bind()
        client = process()
        cases = ((SimpleNamespace(), self.x11, client, 456), (self.native, SimpleNamespace(), client, 456),
                 (self.native, self.x11, {**client, 'pid': 321}, 456),
                 (self.native, self.x11, client, 789), (self.native, self.x11, {**client, 'uids': [1002] * 4}, 456))
        for native, x11, target, window in cases:
            with self.subTest(target=target['pid'], window=window), patch.object(M.sys, 'platform', 'linux'), \
                    patch.object(M.platform, 'machine', return_value='x86_64'), \
                    patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'geteuid', return_value=1001, create=True), \
                    patch.object(M, 'OwnedLauncher') as launcher:
                with self.assertRaises(RuntimeError):
                    M.capture(None, native, x11, target, {}, lambda: None, window, warm_companion=companion)
                launcher.assert_not_called()
        companion.close()

    def test_companion_admission_failure_closes_held_and_current_images(self):
        self.current_result = lambda: (copy.deepcopy(self.root['image']), 'b' * 64)
        with self.assertRaises(RuntimeError): self.bind()
        self.assertTrue(self.images)
        self.assertTrue(all(image.closed for image in self.images))

    def test_actual_window_snapshot_rechecks_companion_xres_after_focus_queries(self):
        api, state, companion = self.native_fixture()
        focus = api.get_focus
        def changed(*args):
            result = focus(*args)
            self.xres['client'] = 902
            return result
        api.get_focus = changed
        with self.assertRaises(RuntimeError): api.snapshot(456)
        companion.close()

    def test_default_receipt_keys_remain_exactly_the_original_sole_window_contract(self):
        attempt = M.KeyboardAttempt(Binding(), Window(), 456)
        self.assertEqual(set(attempt.receipt), {'schemaVersion', 'mechanism', 'pid', 'startTime', 'window', 'intent', 'candidateAction',
            'delivery', 'deliveryComplete', 'launchProvenance', 'widgetFocusVerified', 'outcomeVerified', 'nativeVerificationRequired', 'releaseReady'})
        self.assertEqual(set(attempt.baseline), {'owner', 'frame', 'focus', 'soleWindow', 'unobscured'})
        self.assertTrue(attempt.baseline['soleWindow'])

    def test_root_owner_role_and_bounds_are_checked_before_any_image_is_held(self):
        for mutation in (lambda: self.root.update(executable='/app/bin/creator-hub-flatpak-activate'),
                         lambda: self.root['image'].update(st_size=str(M.MAX_IMAGE + 1)),
                         lambda: self.owner.update(name='com.creatorworks.hub.Host'), lambda: self.owner.update(pid=322)):
            self.setUp(); mutation()
            with self.assertRaises(RuntimeError): self.bind()
            self.assertEqual(self.images, [])


class HeldImageTests(unittest.TestCase):
    def setUp(self):
        self.body = b"\x7fELF\x02" + b"signed fixture" * 3
        self.metadata = SimpleNamespace(st_dev=1, st_ino=8, st_size=len(self.body), st_mode=0o100755,
            st_uid=0, st_gid=0, st_mtime_ns=5, st_ctime_ns=6, st_nlink=1)
        self.image = object.__new__(M.HeldImage)
        self.image.fd = 77

    def snapshot(self, stats=None, reader=None):
        with patch.object(M.os, "fstat", side_effect=stats or [self.metadata, self.metadata]), \
                patch.object(M.os, "pread", side_effect=reader or (lambda fd, count, offset: self.body[offset:offset + count]), create=True):
            return self.image.snapshot()

    def test_held_kernel_fd_is_bounded_hashed_and_stable(self):
        image, digest = self.snapshot()
        self.assertEqual(image["st_ino"], "8")
        self.assertEqual(digest, M.hashlib.sha256(self.body).hexdigest())
        changed = copy.copy(self.metadata); changed.st_ctime_ns += 1
        with self.assertRaises(RuntimeError):
            self.snapshot([self.metadata, changed])
        with self.assertRaises(RuntimeError):
            self.snapshot(reader=lambda fd, count, offset: self.body[:5] if count == 5 else b"")

    def test_oversized_non_executable_non_elf_and_close_are_bounded(self):
        for field, value in (("st_size", M.MAX_IMAGE + 1), ("st_size", 0), ("st_mode", 0o100644), ("st_mode", 0o040755)):
            changed = copy.copy(self.metadata); setattr(changed, field, value)
            with self.subTest(field=field, value=value), self.assertRaises(RuntimeError):
                self.snapshot([changed])
        with self.assertRaises(RuntimeError):
            self.snapshot(reader=lambda fd, count, offset: b"wrong")
        with patch.object(M.os, "close") as close:
            self.image.close(); self.image.close()
            close.assert_called_once_with(77)


class ProtectedBwrapTests(unittest.TestCase):
    def setUp(self):
        self.body = b"\x7fELF\x02" + b"protected system image" * 3
        self.metadata = {fd: SimpleNamespace(st_dev=1, st_ino=fd, st_size=len(self.body),
            st_mode=0o040755 if fd < 43 else 0o100755, st_uid=0, st_gid=0,
            st_mtime_ns=5, st_ctime_ns=6, st_nlink=1) for fd in range(40, 44)}
        self.named = {"/": 40, "usr": 41, "bin": 42, "bwrap": 43}
        self.opened, self.closed, self.stats = [], [], []
        self.named_changes, self.fail_open, self.read_hook = {}, None, lambda: None

    def fixture(self):
        stack = ExitStack()
        stack.enter_context(patch.object(M.sys, "platform", "linux"))
        flags = {"O_RDONLY": 0, "O_WRONLY": 1, "O_RDWR": 2, "O_CREAT": 64, "O_TRUNC": 512,
                 "O_CLOEXEC": 0x80000, "O_NOFOLLOW": 0x20000, "O_DIRECTORY": 0x10000, "O_NONBLOCK": 0x800}
        for name, value in flags.items():
            stack.enter_context(patch.object(M.os, name, value, create=True))
        def opened(name, flags, **kw):
            fd = self.named[name]
            self.assertEqual(kw, {} if name == "/" else {"dir_fd": fd - 1})
            self.assertEqual(flags, 0xa0000 | (0x10000 if name != "bwrap" else 0x800))
            if name == self.fail_open:
                raise OSError("No-follow open refused")
            self.opened.append(fd)
            return fd
        def named(name, **kw):
            self.assertIs(kw.pop("follow_symlinks"), False)
            fd = self.named[name]
            self.assertEqual(kw, {} if name == "/" else {"dir_fd": fd - 1})
            self.stats.append(name)
            return copy.copy(self.named_changes.get(name, self.metadata[fd]))
        def read(fd, count, offset):
            self.assertEqual(fd, 43)
            result = self.body[offset:offset + count]
            self.read_hook()
            return result
        stack.enter_context(patch.object(M.os, "open", side_effect=opened))
        stack.enter_context(patch.object(M.os, "fstat", side_effect=lambda fd: copy.copy(self.metadata[fd])))
        stack.enter_context(patch.object(M.os, "stat", side_effect=named))
        stack.enter_context(patch.object(M.os, "pread", side_effect=read, create=True))
        stack.enter_context(patch.object(M.os, "close", side_effect=self.closed.append))
        return stack

    def test_fixed_fd_anchored_read_only_system_image_captures_live_metadata_and_hash(self):
        with self.fixture():
            image = M.ProtectedBwrap()
            actual, digest = image.snapshot()
            self.assertEqual(self.opened, [40, 41, 42, 43])
            self.assertEqual(actual["st_ino"], "43")
            self.assertEqual(digest, M.hashlib.sha256(self.body).hexdigest())
            self.assertEqual(set(self.stats), {"/", "usr", "bin", "bwrap"})
            with self.assertRaises(TypeError):
                M.ProtectedBwrap("/other/bwrap")
            image.close(); image.close()
            self.assertEqual(self.closed, [43, 42, 41, 40])
            with self.assertRaises(RuntimeError):
                image.snapshot()

    def test_foreign_or_writable_ancestry_and_nonordinary_executable_refuse(self):
        changes = ((40, "st_uid", 1001), (41, "st_mode", 0o040777), (42, "st_gid", 1001),
                   (42, "st_mode", 0o120777), (43, "st_uid", 1001), (43, "st_gid", 1001),
                   (43, "st_mode", 0o100775), (43, "st_mode", 0o104755),
                   (43, "st_mode", 0o010755), (43, "st_mode", 0o100644), (43, "st_nlink", 0))
        for fd, field, value in changes:
            self.setUp(); setattr(self.metadata[fd], field, value)
            with self.subTest(fd=fd, field=field, value=value), self.fixture():
                with self.assertRaises(RuntimeError):
                    M.ProtectedBwrap()
                self.assertEqual(sorted(self.closed), sorted(self.opened))

    def test_redirected_or_substituted_named_ancestor_and_file_refuse(self):
        for name in ("/", "usr", "bin", "bwrap"):
            self.setUp()
            changed = copy.copy(self.metadata[self.named[name]]); changed.st_ino += 100
            self.named_changes[name] = changed
            with self.subTest(name=name), self.fixture():
                with self.assertRaises(RuntimeError):
                    M.ProtectedBwrap()
                self.assertEqual(sorted(self.closed), sorted(self.opened))

    def test_later_named_or_held_image_replacement_and_during_hash_change_refuse(self):
        for kind in ("named", "held", "during-read"):
            self.setUp()
            with self.subTest(kind=kind), self.fixture():
                image = M.ProtectedBwrap()
                changed = copy.copy(self.metadata[43]); changed.st_ino += 1
                if kind == "named":
                    self.named_changes["bwrap"] = changed
                elif kind == "held":
                    self.metadata[43] = changed
                else:
                    self.read_hook = lambda: self.named_changes.update(bwrap=changed)
                with self.assertRaises(RuntimeError):
                    image.snapshot()
                image.close()

    def test_open_failure_closes_only_acquired_fds_without_fallback(self):
        for name in ("/", "usr", "bin", "bwrap"):
            self.setUp(); self.fail_open = name
            with self.subTest(name=name), self.fixture():
                with self.assertRaises(OSError):
                    M.ProtectedBwrap()
                self.assertEqual(sorted(self.closed), sorted(self.opened))

    def test_directory_metadata_read_failure_still_closes_the_newly_opened_fd(self):
        with self.fixture(), patch.object(M.os, "fstat", side_effect=OSError("Metadata denied")):
            with self.assertRaises(OSError):
                M.ProtectedBwrap()
        self.assertEqual(self.closed, self.opened)
        self.assertEqual(self.closed, [40])


if __name__ == "__main__":
    unittest.main(verbosity=2)
