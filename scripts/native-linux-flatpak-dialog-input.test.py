"""Pure exact-window input fixtures; no X server, native app or device access."""
import copy
import ctypes as C
from contextlib import ExitStack
import importlib.util
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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
        api.tree = lambda window: {456: (500, []), 500: (50, [456]), 50: (0, state["stack"])}[window]
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


class WarmCompanionTests(unittest.TestCase):
    def setUp(self):
        M._ATTEMPTS.clear()
        self.root = process(321, 1, '90', '/approved/AppDir/usr/bin/creator-hub')
        self.owner = {'name': ':1.40', 'pid': 321}
        self.xres = {'pid': 321, 'client': 901, 'title': 'Creator Hub', 'mapped': True}
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
            return M.bind_warm_root(None, self.native, self.x11, self.root, 789, self.owner, self.owner_probe, image_open=self.image_open)

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
