"""Pure fixture-driver regressions; no GTK, X11, proc or live apps are accessed."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_unix_window_fixture", Path(__file__).with_name("native-unix-window-fixture.py"))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


def pins():
    return {"pid": 123, "startTime": "9876", "executable": "/usr/bin/python3.12", "sha256": "a" * 64}


def window():
    return {"pid": 123, "kind": "window", "phase": 1, "title": f.TITLE, "role": "DIALOG", "xid": 456}


def receipt(action="snapshot"):
    pin, win = pins(), window()
    return {"pid": pin["pid"], "startTime": pin["startTime"], "executable": pin["executable"],
            "executableSha256": pin["sha256"], "executableBinding": "pathname-and-running-proc-image-hash",
            "window": str(win["xid"]), "title": win["title"], "role": win["role"], "xresClient": "789",
            "action": action, "actionCount": 0 if action == "snapshot" else 1,
            "normalExitVerified": False, "releaseReady": False, "button": f.DECLINE,
            "nodes": [{"name": win["title"]}]}


class FixtureTests(unittest.TestCase):
    def test_explicit_disposable_linux_x11_optin_only(self):
        env = dict(GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted", RUNNER_OS="Linux", RUNNER_ARCH="X64",
                   CREATOR_UNIX_WINDOW_TEST="1", CREATOR_UNIX_WINDOW_FIXTURE="1", GDK_BACKEND="x11", NO_AT_BRIDGE="0", DISPLAY=":99")
        f.runner_guard(env, "linux", "x86_64")
        f.runner_guard({**env, "RUNNER_ARCH": "ARM64"}, "linux", "aarch64")
        for name, value in (("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"), ("RUNNER_OS", "Windows"),
                            ("RUNNER_ARCH", "ARM64"), ("CREATOR_UNIX_WINDOW_TEST", ""), ("CREATOR_UNIX_WINDOW_FIXTURE", ""),
                            ("GDK_BACKEND", "wayland"), ("NO_AT_BRIDGE", "1"), ("DISPLAY", "localhost:99"), ("FLATPAK_ID", "fixture")):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                f.runner_guard({**env, name: value}, "linux", "x86_64")
        for system, arch in (("win32", "x86_64"), ("darwin", "aarch64"), ("linux", "i686")):
            with self.assertRaises(RuntimeError):
                f.runner_guard(env, system, arch)

    def test_main_refuses_local_before_files_gi_proc_or_processes(self):
        for env, system in (({}, "linux"), ({"RUNNER_ENVIRONMENT": "self-hosted"}, "linux"), ({}, "win32")):
            with patch.dict(os.environ, env, clear=True), patch.object(sys, "platform", system), \
                 patch.object(Path, "read_text", side_effect=AssertionError("No file read")), \
                 patch.object(f, "process_record", side_effect=AssertionError("No proc read")), \
                 patch.object(f.subprocess, "Popen", side_effect=AssertionError("No process")), \
                 patch.dict(sys.modules, {"gi": None}), self.assertRaises(RuntimeError):
                f.main()

    def test_child_window_requires_exact_xid_phase_role_and_title(self):
        f.validate_window(window(), 1, f.TITLE, "DIALOG")
        for field, value in (("xid", True), ("xid", 0), ("xid", 2**32), ("phase", 2), ("role", "FRAME"), ("title", "Other")):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                f.validate_window({**window(), field: value}, 1, f.TITLE, "DIALOG")

    def test_callbacks_require_actual_decline_then_one_approval(self):
        for phase, label in ((1, f.DECLINE), (2, f.APPROVE)):
            value = {"phase": phase, "button": label, "count": phase, "accepted": phase == 2}
            f.validate_callback(value, phase, label)
            for field, wrong in (("count", 0), ("count", True), ("phase", 3), ("phase", True),
                                 ("button", "Other"), ("accepted", not (phase == 2))):
                with self.subTest(phase=phase, field=field), self.assertRaises(RuntimeError):
                    f.validate_callback({**value, field: wrong}, phase, label)

    def test_helper_receipts_cannot_claim_product_or_normal_exit(self):
        for action in ("snapshot", "click", "close"):
            value = receipt(action)
            f.validate_helper(value, action, pins(), window(), f.DECLINE)
            for field, wrong in (("pid", 124), ("startTime", "9999"), ("executable", "/different"),
                                 ("executableSha256", "b" * 64), ("window", "457"), ("role", "FRAME"),
                                 ("actionCount", 7), ("releaseReady", True), ("normalExitVerified", True),
                                 ("xresClient", "0"), ("executableBinding", "sealed-proc-fd-and-owned-launcher")):
                with self.subTest(action=action, field=field), self.assertRaises(RuntimeError):
                    f.validate_helper({**value, field: wrong}, action, pins(), window(), f.DECLINE)
        with self.assertRaises(RuntimeError):
            f.validate_helper({**receipt("click"), "button": f.APPROVE}, "click", pins(), window(), f.DECLINE)
        with self.assertRaises(RuntimeError):
            f.validate_helper({**receipt(), "nodes": []}, "snapshot", pins(), window())
        with self.assertRaises(RuntimeError):
            f.validate_helper({**receipt(), "error": "XRes ABI failure"}, "snapshot", pins(), window())

    def test_owned_pid_start_parent_path_hash_drift_refuses(self):
        child = types.SimpleNamespace(pid=123, poll=lambda: None)
        for record, path, digest in ((("9876", os.getpid() + 1), "/usr/bin/python3.12", "a" * 64),
                                     (("9999", os.getpid()), "/usr/bin/python3.12", "a" * 64),
                                     (("9876", os.getpid()), "/different", "a" * 64),
                                     (("9876", os.getpid()), "/usr/bin/python3.12", "b" * 64)):
            with patch.object(f, "process_record", return_value=record), patch.object(f.os, "readlink", return_value=path), \
                 patch.object(f, "digest", return_value=digest), self.assertRaises(RuntimeError):
                f.check_owned(child, pins())
        with patch.object(f, "process_record", side_effect=[("9876", os.getpid()), ("9999", os.getpid())]), \
             patch.object(f.os, "readlink", return_value=pins()["executable"]), patch.object(f, "digest", return_value=pins()["sha256"]), \
             self.assertRaises(RuntimeError):
            f.check_owned(child, pins())

    def test_failed_cleanup_overrides_pass_without_masking_original_failure(self):
        for status in ("passed", "failed"):
            report = {"status": status, "normalExitVerified": True, "error": "original ABI failure", "releaseReady": False}
            f.failed_cleanup(report, ["owned child survived"])
            self.assertEqual(report["status"], "failed")
            self.assertFalse(report["normalExitVerified"])
            self.assertEqual(report["error"], "original ABI failure")
            self.assertFalse(report["releaseReady"])

    def test_event_protocol_is_owned_ordered_and_bounded(self):
        child = types.SimpleNamespace(pid=123, stdout=types.SimpleNamespace(fileno=lambda: 10))
        for value, expected in (({"kind": "window", "pid": 124}, "window"), ({"kind": "callback", "pid": 123}, "window")):
            reader = f.Events(child)
            reader.pending = json.dumps(value).encode() + b"\n"
            with self.assertRaises(RuntimeError):
                reader.next(expected)
            self.assertEqual(reader.records, [value])
        reader = f.Events(child)
        with patch.object(f.select, "select", return_value=([], [], [])), self.assertRaisesRegex(RuntimeError, "deadline"):
            reader.next("window")
        reader = f.Events(child)
        reader.total = 32768
        with patch.object(f.select, "select", return_value=([10], [], [])), patch.object(f.os, "read", return_value=b"x"), \
             self.assertRaisesRegex(RuntimeError, "bound"):
            reader.next("window")


if __name__ == "__main__":
    unittest.main(verbosity=2)
