"""Pure/temp/source tests only; no app, root broker, account, installer or UI run."""
import ast
import copy
import contextlib
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import yaml

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORKFLOW = ROOT / ".github/workflows/native-linux-update-flow-014.yml"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


p = load("update_flow_pure_subject", HERE / "native-linux-update-flow.py")


def runner():
    return {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
        "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": p.BRANCH,
        "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "12345",
        "CREATOR_LINUX_UPDATE_FLOW": "1", "CREATOR_LINUX_UPDATE_FLOW_MODE": "capture", "CREATOR_LINUX_ROOT_PROBE": "1",
        "CREATOR_UNIX_WINDOW_TEST": "1", "CREATOR_LINUX_COMPONENTS_PROBE": "1", "CREATOR_LINUX_UPDATE_DISCOVERY": "1",
        "CREATOR_LINUX_ROOT_CANDIDATE": "retirement-534465a", "CREATOR_DISCOVERY_NODE": "/fixed/node"}


def record(phase=None, pid=42, supervisor=40, start="101"):
    phase = phase or p.Phase14()
    return {"pid": pid, "parentPid": supervisor, "uids": [21314]*4, "executable": p.EXE, "startTime": start,
        "image": {"st_size": str(phase.length), "st_dev": "1", "st_ino": str(pid), "st_uid": "0", "st_mode": "33261"},
        "kernelImageSha256": phase.digest}


class AdmissionTests(unittest.TestCase):
    def test_only_exact_manual_capture_context(self):
        p.admission(runner(), "linux", "x86_64")
        for key in runner():
            if key in ("CREATOR_DISCOVERY_NODE", "CREATOR_LINUX_UPDATE_FLOW_MODE"):
                continue
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({k: v for k, v in runner().items() if k != key}, "linux", "x86_64")

    def test_push_and_foreign_source_context_never_run_native(self):
        for key, value in (("GITHUB_EVENT_NAME", "push"), ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", "refs/heads/main"),
                ("GITHUB_REF", "refs/heads/validation/linux-polkit-admin-014"), ("GITHUB_REPOSITORY_ID", "1"),
                ("GITHUB_SHA", "not-a-sha"), ("GITHUB_RUN_ID", "01")):
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                p.admission(runner() | {key: value}, "linux", "x86_64")

    def test_other_platform_and_injection_refuse(self):
        for key in ("LD_PRELOAD", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "TAURI_SIGNING_PRIVATE_KEY",
                    "FLATPAK_ID", "APPIMAGE", "APPDIR"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission(runner() | {key: "synthetic-only"}, "linux", "x86_64")
        for system, machine in (("win32", "x86_64"), ("linux", "aarch64")):
            with self.assertRaises(RuntimeError):
                p.admission(runner(), system, machine)

    def test_only_source_bound_finite_modes_not_runtime_captured_input_authority(self):
        self.assertEqual(p.REVIEWED_DPKG_INPUT_PROFILE["program"], "/usr/bin/dpkg")
        for mode in p.MODES:
            p.admission(runner() | {"CREATOR_LINUX_UPDATE_FLOW_MODE": mode}, "linux", "x86_64")
        for mode in ("", "authenticate", "other"):
            with self.subTest(mode=mode), mock.patch.object(p, "dependencies") as deps, self.assertRaises(RuntimeError):
                p.admission(runner() | {"CREATOR_LINUX_UPDATE_FLOW_MODE": mode}, "linux", "x86_64")
            deps.assert_not_called()

    def test_default_mode_is_capture_not_implicit_authentication(self):
        self.assertEqual(p.mode({}), "capture")

    def test_json_duplicate_nonfinite_overflow_and_oversize_refuse(self):
        self.assertEqual(p.exact_json(b'{"version":15,"value":0.25}'), {"version": 15, "value": 0.25})
        for data in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e999}', b" "*1048577, b"", b"\xff"):
            with self.subTest(data=data[:24]), self.assertRaises((RuntimeError, ValueError)):
                p.exact_json(data)


class FrozenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.directory = Path(cls.temp.name).resolve()
        for name in p.FROZEN:
            raw = subprocess.check_output(["git", "show", p.FROZEN_SOURCE + ":scripts/" + name], cwd=ROOT)
            (cls.directory / name).write_bytes(raw)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_all_six_independent_reviewed_hashes_match_the_exact_git_source(self):
        self.assertEqual(len(p.FROZEN), 6)
        p.verify_frozen(self.directory)
        for name, (length, digest) in p.FROZEN.items():
            raw = (self.directory/name).read_bytes()
            self.assertEqual((len(raw), hashlib.sha256(raw).hexdigest()), (length, digest))

    def test_changed_frozen_source_refuses_before_import(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            for name in p.FROZEN:
                shutil.copyfile(self.directory/name, directory/name)
            (directory / "native-linux-update-discovery.py").write_bytes(b"raise RuntimeError('must never execute')\n")
            with self.assertRaisesRegex(RuntimeError, "Frozen dependency"):
                p.verify_frozen(directory)

    def test_frozen_real_loaders_keep_separate_original_and_current_candidate_modules(self):
        with mock.patch.object(p, "frozen_directory", return_value=self.directory), mock.patch.object(p, "_dependencies", None):
            d, b, c, polkit = p.dependencies()
            self.assertIs(b, c.B)
            self.assertEqual(b.SOURCE, "534465a86554e95b909bf9c7decbbb29cbca5267")
            self.assertEqual(d.TARGET["source"], "eef90658c4d9e6743c6c25f67e00ad36c783ca6e")
            self.assertEqual(polkit.COMMAND[2], "/usr/bin/true")
            self.assertEqual(polkit.base().SELECTED_CANDIDATE, polkit.base().ORIGINAL_CANDIDATE)
            for name, sha in d.candidate_pins()["testHelpers"].items():
                self.assertEqual(sha, p.FROZEN[name][1])

    def test_loader_has_no_runtime_frozen_source_or_branch_override(self):
        source = (HERE / "native-linux-update-flow.py").read_text()
        self.assertNotIn("CREATOR_FROZEN_PATH", source)
        self.assertNotIn('os.environ["GITHUB_REF"] =', source)
        self.assertNotIn("polkit.QUESTION =", source)
        self.assertNotIn("INSTALLED_HUB_PIN =", source)


class PhaseTests(unittest.TestCase):
    def test_exact_phase14_and15_different_size_and_hash(self):
        for phase in (p.Phase14(), p.Phase15()):
            value = record(phase)
            self.assertIs(p.phase_identity(phase, value, 40), value)
        self.assertEqual(p.Phase15().length, 22048768)
        self.assertNotEqual(p.Phase14().digest, p.Phase15().digest)

    def test_cannot_replace_a_phase_pin_with_constructor_data(self):
        for phase in (p.Phase14(digest="f"*64), p.Phase15(length=1)):
            with self.assertRaises(RuntimeError):
                p.phase_identity(phase, record(phase), 40)

    def test_wrong_uid_start_image_path_parent_and_length_refuse(self):
        for key, value in (("uids", [0]*4), ("startTime", "01"), ("pid", True), ("executable", p.EXE + " (deleted)"),
                ("kernelImageSha256", p.Phase15().digest), ("parentPid", 41), ("image", {"st_size": "1"})):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.phase_identity(p.Phase14(), record() | {key: value}, 40)

    def test_only_fresh_adopted_phase15_successor(self):
        old = record(pid=41, start="100")
        new = record(p.Phase15())
        self.assertIs(p.successor_identity(new, old, 40, {30}), new)
        for bad in (new | {"pid": 41}, new | {"startTime": "100"}, new | {"parentPid": 99}, new | {"pid": 30}):
            with self.assertRaises(RuntimeError):
                p.successor_identity(bad, old, 40, {30})

    def test_deleted_old_image_is_not_adopted_as_new_root(self):
        with self.assertRaises(RuntimeError):
            p.successor_identity(record(p.Phase14()) | {"executable": p.EXE + " (deleted)"}, record(pid=41), 40, set())

    def test_single_instance_bus_owner_is_exact_phase_pid_and_uid(self):
        polkit = types.SimpleNamespace(bus_identity=mock.Mock(return_value={"owner": ":1.4", "pid": 42, "uid": 21314}))
        result = p.single_instance_owner("session-bus", polkit, "glib", record())
        self.assertEqual(result["pid"], 42)
        polkit.bus_identity.assert_called_once_with("session-bus", "com.creatorworks.hub.SingleInstance", "glib")
        for wrong in ({"pid": 43, "uid": 21314}, {"pid": 42, "uid": 0}):
            polkit.bus_identity.return_value = wrong
            with self.assertRaises(RuntimeError):
                p.single_instance_owner("session-bus", polkit, "glib", record())

    def test_installed15_requires_package_root_image_and_clean_dpkg_verify(self):
        b = types.SimpleNamespace(installed_state=mock.Mock(return_value="creator-hub\t0.1.15\tamd64\tinstalled\n"),
            pinned=mock.Mock(return_value={"sha256": p.Phase15().digest}), run_tool=mock.Mock(return_value=(0,b"")))
        with mock.patch.object(p, "protected") as protected:
            result = p.installed15(Path("/fixture"), b)
        protected.assert_called_once_with(Path(p.EXE))
        self.assertTrue(result["dpkgVerifyPassed"])
        self.assertFalse(result["signedUpdateAccepted"])
        b.pinned.assert_called_once_with(Path(p.EXE), (22048768, p.Phase15().digest), 0o755)
        b.run_tool.return_value = (0, b"changed package member")
        with mock.patch.object(p, "protected"), self.assertRaises(RuntimeError):
            p.installed15(Path("/fixture"), b)


class RestartObserverTests(unittest.TestCase):
    def fixture(self):
        child = mock.Mock(pid=41, returncode=0)
        child.poll.side_effect = [None, 0]
        old, new = record(pid=41, start="100"), record(p.Phase15())
        b = types.SimpleNamespace(native_process=mock.Mock(return_value=new))
        return child, old, new, b, mock.Mock()

    def test_subreaper_set_and_readback_are_both_required(self):
        class Prctl:
            def __init__(self):
                self.calls = []
            def __call__(self, option, value, *_args):
                self.calls.append(option)
                if option == 37:
                    ctypes.cast(value, ctypes.POINTER(ctypes.c_int))[0] = 1
                return 0
        prctl = Prctl()
        with mock.patch.object(p.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=prctl)), \
                mock.patch.object(p.signal, "SIGCHLD", 17, create=True), mock.patch.object(p.signal, "getsignal", return_value=p.signal.SIG_DFL):
            p.enable_subreaper()
        self.assertEqual(prctl.calls, [36, 37])

    def test_subreaper_failure_refuses_without_launch(self):
        with mock.patch.object(p.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=mock.Mock(return_value=-1))), \
                mock.patch.object(p.subprocess, "Popen") as spawn, self.assertRaises(RuntimeError):
            p.enable_subreaper()
        spawn.assert_not_called()

    def test_automatic_child_observed_only_after_old_zero_exit_no_spawn(self):
        child, old, new, b, capture = self.fixture()
        with mock.patch.object(p.os, "getpid", return_value=40), mock.patch.object(p, "direct_children", return_value={30, 42}), \
                mock.patch.object(p.subprocess, "Popen") as spawn:
            result = p.wait_successor(child, old, {30}, b, mock.Mock(), capture)
        self.assertEqual(result, new)
        spawn.assert_not_called()

    def test_old_failure_refuses_without_successor_or_fallback(self):
        child, old, _new, b, capture = self.fixture()
        child.poll.side_effect, child.returncode = None, 1
        child.poll.return_value = 1
        with mock.patch.object(p.subprocess, "Popen") as spawn, self.assertRaises(RuntimeError):
            p.wait_successor(child, old, set(), b, mock.Mock(), capture)
        spawn.assert_not_called()
        b.native_process.assert_not_called()

    def test_missing_successor_times_out_without_relaunch_or_signal(self):
        child, old, _new, b, capture = self.fixture()
        child.poll.side_effect = None
        child.poll.return_value = 0
        with mock.patch.object(p, "direct_children", return_value={30}), mock.patch.object(p.subprocess, "Popen") as spawn, \
                self.assertRaisesRegex(RuntimeError, "no manual relaunch"):
            p.wait_successor(child, old, {30}, b, mock.Mock(), capture, timeout=0.01)
        spawn.assert_not_called()
        child.send_signal.assert_not_called()

    def test_stale_wrong_hash_and_multiple_successors_refuse(self):
        for change in ("hash", "baseline", "multiple"):
            child, old, new, b, capture = self.fixture()
            child.poll.side_effect = None
            child.poll.return_value = 0
            baseline = {42} if change == "baseline" else set()
            if change == "hash":
                b.native_process.return_value = new | {"kernelImageSha256": "f"*64}
            if change == "multiple":
                b.native_process.side_effect = [new, new | {"pid": 43}]
            children = {42, 43} if change == "multiple" else {42}
            with self.subTest(change=change), mock.patch.object(p.os, "getpid", return_value=40), \
                    mock.patch.object(p, "direct_children", return_value=children), self.assertRaises(RuntimeError):
                p.wait_successor(child, old, baseline, b, mock.Mock(), capture, timeout=0.01)

    def test_normal_close_waits_only_exact_adopted_pid(self):
        value = record(p.Phase15())
        owner = types.SimpleNamespace(root=value)
        request = types.SimpleNamespace(pid=42, sha256=p.Phase15().digest)
        b = types.SimpleNamespace(perform_owned=mock.Mock(return_value={"actionCount": 1}))
        with mock.patch.object(p.os, "getpid", return_value=40), mock.patch.object(p.os, "waitpid", return_value=(42, 0)) as wait, \
                mock.patch.object(p.os, "WNOHANG", 1, create=True), mock.patch.object(p.os, "waitstatus_to_exitcode", return_value=0, create=True):
            result = p.finish_successor(value, request, owner, b, mock.Mock(), mock.Mock(), mock.Mock())
        self.assertEqual(result["exitCode"], 0)
        wait.assert_called_once_with(42, 1)


class ConfirmationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Existing synthetic graph only, never a native UI/session.
        cls.existing = load("update_flow_existing_graphs", HERE / "native-linux-update-discovery.test.py")

    def fixture(self):
        return self.existing.ConfirmationCancelTests().fixture()

    def invoke(self, f):
        b, c = self.existing.b, self.existing.c
        original = b.RootOwnership
        def owner(*args, **kwargs):
            return original(*args, **kwargs, reader=f.reader, system_check=lambda: dict(f.system))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "updater-confirmation-contract.json").write_text(json.dumps(f.contract))
            (root / "ax-ownership.json").write_text("{}")
            with mock.patch.object(b, "native_ax_references", return_value=(f.references, f.bus)), \
                    mock.patch.object(b, "RootOwnership", side_effect=owner), \
                    mock.patch.object(c, "owned_windows", return_value=[f.native]):
                return p.confirmation_approve(root, f.request, f.helper, f.x11, f.atspi, f.saved, b, c)

    def test_one_update_hub_action_not_cancel(self):
        f = self.fixture()
        result = self.invoke(f)
        self.assertTrue(result["confirmationAccepted"])
        f.approve.action.do_action.assert_called_once_with(0)
        f.cancel.action.do_action.assert_not_called()
        f.bus.close_sync.assert_called_once_with(None)

    def test_unknown_dialog_root_tree_question_geometry_and_verb_refuse_before_input(self):
        for change in ("pid", "uid", "question", "duplicate", "nested", "frame", "action"):
            f = self.fixture()
            if change == "pid":
                f.approve.pid = 99
            elif change == "uid":
                f.records[42]["uids"] = [0]*4
            elif change == "question":
                f.alert.children[0].children[1].name = "Unrelated update"
            elif change == "duplicate":
                f.alert.children.append(f.alert.children[0])
            elif change == "nested":
                f.approve.role = 16
            elif change == "frame":
                f.contract["nativeFrame"][2] = 0
            else:
                f.approve.action.get_action_name = lambda _i: "press"
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.invoke(f)
            f.approve.action.do_action.assert_not_called()
            f.cancel.action.do_action.assert_not_called()

    def test_uncertain_action_is_one_attempt_not_retried(self):
        f = self.fixture()
        f.approve.action.do_action.side_effect = OSError("synthetic uncertain return")
        with self.assertRaisesRegex(RuntimeError, "uncertain"):
            self.invoke(f)
        f.approve.action.do_action.assert_called_once_with(0)
        f.cancel.action.do_action.assert_not_called()


class KernelObserverTests(unittest.TestCase):
    def fixture(self):
        root_record = record(pid=41, start="100")
        supervisor = {"pid": 40, "uids": [21314]*4}
        pkexec = {"pid": 51, "parentPid": 41, "executable": "/usr/bin/pkexec", "uids": [21314, 0, 0, 0],
                  "kernelImageSha256": "f"*64}
        base, receipt = mock.MagicMock(), mock.Mock()
        base.__truediv__.return_value = receipt
        receipt.exists.return_value = True
        receipt.resolve.return_value = receipt
        receipt.stat.return_value = types.SimpleNamespace(st_uid=21314, st_size=2000)
        receipt.read_bytes.return_value = json.dumps({"root": root_record}).encode()
        def native(pid, _helper, full=True):
            value = copy.deepcopy({41: root_record, 40: supervisor, 51: pkexec}[pid])
            if not full:
                value.pop("kernelImageSha256", None)
            return value
        b = types.SimpleNamespace(load_helper=mock.Mock(), native_process=mock.Mock(side_effect=native), process_uids=mock.Mock(return_value=[21314]*4))
        polkit = types.SimpleNamespace(FILES={"/usr/bin/pkexec": ("pkexec", "version", 1, "f"*64, 0o4755)})
        seals = types.SimpleNamespace(F_GET_SEALS=1034, fcntl=mock.Mock(return_value=15))
        image = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_size=62212268, st_dev=1, st_ino=22)
        digest = mock.Mock()
        digest.hexdigest.return_value = "98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796"
        command = b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0"
        supervisor_command = b"/usr/bin/python3\0-B\0/opt/creator-polkit-fixture/scripts/native-linux-update-flow.py\0session\0"
        return types.SimpleNamespace(**locals())

    @contextlib.contextmanager
    def patches(self, f):
        with contextlib.ExitStack() as stack:
            for target, name, value, create in ((p, "BASE", f.base, False), (p.os, "getuid", lambda: 0, True),
                    (p.os, "geteuid", lambda: 0, True), (p.os, "O_CLOEXEC", 524288, True)):
                stack.enter_context(mock.patch.object(target, name, value, create=create))
            stack.enter_context(mock.patch.dict(sys.modules, {"fcntl": f.seals}))
            stack.enter_context(mock.patch.object(p, "direct_children", return_value={51}))
            f.read_command = stack.enter_context(mock.patch.object(p, "proc_bytes", side_effect=lambda path, _limit:
                f.supervisor_command if "/40/" in str(path).replace("\\", "/") else f.command))
            stack.enter_context(mock.patch.object(p.os, "open", return_value=7))
            stack.enter_context(mock.patch.object(p.os, "fstat", return_value=f.image))
            stack.enter_context(mock.patch.object(p.os, "close"))
            f.pread = stack.enter_context(mock.patch.object(p.os, "pread", side_effect=lambda _fd, size, _offset: b"x"*size, create=True))
            stack.enter_context(mock.patch.object(p.hashlib, "sha256", return_value=f.digest))
            yield

    def test_exact_readonly_root_child_sealed_package_receipt_no_auth_claim(self):
        f = self.fixture()
        with self.patches(f):
            result = p.pending_dpkg_proof(f.b, f.polkit, {})
            p.os.open.assert_called_once()
            self.assertEqual(p.os.open.call_args.args[1], p.os.O_RDONLY | p.os.O_CLOEXEC)
        self.assertEqual(result["program"], "/usr/bin/dpkg")
        self.assertEqual(result["stdinBytes"], 62212268)
        self.assertTrue(result["readOnly"])
        self.assertEqual(result["seals"], 15)
        for key in p.FALSE_GATES:
            self.assertIs(result[key], False)

    def test_foreign_uid_or_stale_root_refuse_before_reading_setuid_image(self):
        for change in ("uid", "pid", "stale"):
            f = self.fixture()
            if change == "uid":
                f.b.process_uids.return_value = [0]*4
            elif change == "pid":
                f.receipt.read_bytes.return_value = b'{"root":{"pid":"../../foreign"}}'
            else:
                f.root_record["startTime"] = "102"
            with self.subTest(change=change), self.patches(f), self.assertRaises(RuntimeError):
                p.pending_dpkg_proof(f.b, f.polkit, {})
            if change in ("uid", "pid"):
                f.b.native_process.assert_not_called()

    def test_new_empty_receipt_is_readiness_not_a_forged_identity(self):
        f = self.fixture()
        f.receipt.read_bytes.return_value = b""
        with self.patches(f):
            self.assertIsNone(p.pending_dpkg_proof(f.b, f.polkit, {}))
        f.b.native_process.assert_not_called()

    def test_foreign_supervisor_or_arbitrary_installer_arguments_refuse(self):
        for change in ("supervisor", "arguments", "pkexec-parent", "pkexec-image"):
            f = self.fixture()
            if change == "supervisor":
                f.supervisor_command = b"/usr/bin/python3\0unreviewed.py\0"
            elif change == "arguments":
                f.command = b"/usr/bin/pkexec\0/bin/sh\0"
            elif change == "pkexec-parent":
                f.pkexec["parentPid"] = 99
            else:
                f.pkexec["kernelImageSha256"] = "e"*64
            with self.subTest(change=change), self.patches(f), self.assertRaises(RuntimeError):
                p.pending_dpkg_proof(f.b, f.polkit, {})
            f.pread.assert_not_called()

    def test_missing_seal_wrong_size_wrong_bytes_and_short_read_refuse(self):
        for change in ("seals", "size", "digest", "short"):
            f = self.fixture()
            if change == "seals":
                f.seals.fcntl.return_value = 7
            elif change == "size":
                f.image.st_size = 1
            elif change == "digest":
                f.digest.hexdigest.return_value = "e"*64
            with self.subTest(change=change), self.patches(f):
                if change == "short":
                    f.pread.side_effect = None
                    f.pread.return_value = b""
                with self.assertRaises(RuntimeError):
                    p.pending_dpkg_proof(f.b, f.polkit, {})

    def test_file_replacement_and_process_replacement_during_proof_refuse(self):
        for change in ("inode", "process"):
            f = self.fixture()
            with self.subTest(change=change), self.patches(f):
                if change == "inode":
                    p.os.fstat.side_effect = [f.image, types.SimpleNamespace(**(vars(f.image) | {"st_ino": 23}))]
                else:
                    original = f.b.native_process.side_effect
                    count = 0
                    def replace(pid, helper, full=True):
                        nonlocal count
                        value = original(pid, helper, full)
                        if pid == 51:
                            count += 1
                            if count == 2:
                                value["parentPid"] = 99
                        return value
                    f.b.native_process.side_effect = replace
                with self.assertRaises(RuntimeError):
                    p.pending_dpkg_proof(f.b, f.polkit, {})

    def test_initial_full_root_hash_once_not_every_idle_poll(self):
        f = self.fixture()
        state = {}
        with self.patches(f), mock.patch.object(p, "direct_children", return_value=set()):
            self.assertIsNone(p.pending_dpkg_proof(f.b, f.polkit, state))
            self.assertIsNone(p.pending_dpkg_proof(f.b, f.polkit, state))
        calls = [call for call in f.b.native_process.call_args_list if call.args[0] == 41 and call.kwargs.get("full", True)]
        self.assertEqual(len(calls), 1)


class PreservationAndSourceTests(unittest.TestCase):
    def test_exact_client_project_paths_are_synthetic_no_program_exec(self):
        self.assertEqual(len(p.SENTINELS), 5)
        for name, raw in p.SENTINELS.items():
            self.assertFalse(Path(name).is_absolute())
            self.assertNotIn("..", Path(name).parts)
            self.assertIsInstance(raw, bytes)
        self.assertIn("home/config/Claude/claude_desktop_config.json", p.SENTINELS)
        self.assertIn("fixture-project/Assets/preserve.txt", p.SENTINELS)

    def test_preservation_tracks_bytes_mode_and_inode_and_detects_changes(self):
        b = types.SimpleNamespace(file_record=mock.Mock(side_effect=lambda file, _limit: {"path": str(file), "sha256": "a"*64, "inode": "1", "mode": 384}))
        before = p.preservation(Path("/fixed"), b)
        self.assertEqual(len(before), 9)
        self.assertEqual(before, p.preservation(Path("/fixed"), b))
        b.file_record.side_effect = lambda file, _limit: {"path": str(file), "sha256": "b"*64, "inode": "1", "mode": 384}
        self.assertNotEqual(before, p.preservation(Path("/fixed"), b))

    def test_checkpoint_never_claims_native_auth_install_or_restart(self):
        value = p.checkpoint()
        self.assertEqual(value["admittedNativeModes"], list(p.MODES))
        for flag in p.FALSE_GATES:
            self.assertIs(value[flag], False)
        self.assertIn("actual signed15 installation", value["pending"])

    def test_session_command_contains_no_secret_ref_override_or_arbitrary_program(self):
        env = runner() | {"GITHUB_TOKEN": "do-not-forward", "HOME": "/real/home", "LD_PRELOAD": "do-not-forward"}
        command = p.session_command(env)
        self.assertIn("--uid=creator-polkit-fixture", command)
        self.assertIn("--property=PAMName=login", command)
        self.assertIn("--setenv=GITHUB_REF=" + p.BRANCH, command)
        self.assertNotIn("do-not-forward", " ".join(command))
        self.assertNotIn("/real/home", " ".join(command))
        self.assertTrue(command[-1].endswith("native-linux-update-flow.py session"))

    def test_only_broker_provisions_and_only_product_installs_or_relaunches(self):
        source = (HERE / "native-linux-update-flow.py").read_text()
        tree = ast.parse(source)
        capture = ast.get_source_segment(source, next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_capture"))
        broker = ast.get_source_segment(source, next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "broker"))
        for forbidden in ("set_text_contents", "chpasswd", "token_hex", 'fixture_credential("provision"', 'subprocess.Popen(["/usr/bin/pkexec"'):
            self.assertNotIn(forbidden, capture)
        self.assertEqual(broker.count('fixture_credential("provision", secret)'), 1)
        self.assertIn('if selected_mode == "approve":', broker)
        self.assertIn('relock = True', broker)
        self.assertIn('fixture_credential("lock")', broker)
        self.assertEqual(capture.count('subprocess.Popen([EXE]'), 1)
        for call in ("wait_successor(", "installed15(", "successor_ui(", "finish_successor(", "approval_complete("):
            self.assertIn(call, capture)
        for forbidden in ("shell=True", "execute_script", "localStorage", "--no-sandbox", "os.kill(", ".kill(", ".terminate(", ".send_signal("):
            self.assertFalse(forbidden in source, forbidden)
        for call in (n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "waitpid"):
            self.assertFalse(isinstance(call.args[0], ast.UnaryOp), "Never reap an arbitrary/negative PID")
        self.assertIn('report["capturedQuestionProvenAsDpkg"] = False', capture)
        self.assertIn('report["disposableSessionTeardownRequired"] = True', capture)

    def test_readonly_root_observer_requires_full_seals_exact_package_and_direct_child(self):
        source = (HERE / "native-linux-update-flow.py").read_text()
        tree = ast.parse(source)
        function = ast.get_source_segment(source, next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "pending_dpkg_proof"))
        for text in ('direct_children(actual["pid"])', 'process["parentPid"] == actual["pid"]', "fcntl.F_GET_SEALS) == 15",
                     "os.pread(", "62212268", "98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796", 'full=False', 'if "root14" not in state'):
            self.assertIn(text, function)
        for forbidden in ("O_WRONLY", "O_RDWR", "O_TRUNC", "O_CREAT", "os.write", "Popen(", "send_signal"):
            self.assertNotIn(forbidden, function)


class DpkgInputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.existing = load("flow_polkit_graph_fixtures", HERE / "native-linux-polkit-probe.test.py")
        cls.temp = tempfile.TemporaryDirectory()
        directory = Path(cls.temp.name).resolve()
        for name in p.FROZEN:
            (directory/name).write_bytes(subprocess.check_output(["git", "show", p.FROZEN_SOURCE+":scripts/"+name], cwd=ROOT))
        with mock.patch.object(p, "frozen_directory", return_value=directory), mock.patch.object(p, "_dependencies", None):
            cls.polkit = p.dependencies()[3]

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def fixture(self, authenticate=True):
        f = self.existing.AuthenticateTests().fixture() if authenticate else self.existing.CancelTests().fixture()
        f.question.name = p.REVIEWED_DPKG_INPUT_PROFILE["question"]
        f.profile = lambda: p.dpkg_profile(f.agent, f.helper, f.atspi, f.refs, f.x11, f.native, f.geometry,
            self.polkit, authenticate=authenticate)
        return f

    def test_dpkg_only_exact_graph_once_without_frozen_true_profile_mutation(self):
        f = self.fixture()
        attempt = {}
        with mock.patch.object(self.polkit, "windows", return_value=f.native):
            p.perform_system_input("approve", self.polkit, f.profile, mock.Mock(), attempt, f.secret)
        f.editable.set_text_contents.assert_called_once_with("a"*64)
        f.authenticate.action.do_action.assert_called_once_with(0)
        f.password.get_name.assert_not_called()
        f.password.get_text_iface.assert_not_called()
        f.combo.get_action_iface.assert_not_called()
        self.assertEqual(self.polkit.COMMAND[2], "/usr/bin/true")
        self.assertNotEqual(self.polkit.QUESTION, p.REVIEWED_DPKG_INPUT_PROFILE["question"])
        self.assertEqual(attempt["outcome"], "unknown-no-retry")
        self.assertNotIn("a"*64, json.dumps(attempt))

    def test_cancel_once_never_requests_a_secret_or_authentication_action(self):
        f, attempt = self.fixture(False), {}
        with mock.patch.object(self.polkit, "windows", return_value=f.native):
            p.perform_system_input("system-cancel", self.polkit, f.profile, mock.Mock(), attempt, None)
        f.cancel.action.do_action.assert_called_once_with(0)
        f.authenticate.get_action_iface.assert_not_called()
        f.password.get_name.assert_not_called()
        self.assertEqual(attempt["passwordWriteAttempts"], 0)

    def test_foreign_question_selection_pid_frame_parent_or_busy_refuses_before_write(self):
        for change in ("true-question", "other-selection", "foreign-selection", "frame", "parent", "busy", "password-role"):
            f, attempt = self.fixture(), {}
            if change == "true-question":
                f.question.name = self.polkit.QUESTION
            elif change == "other-selection":
                f.selection.get_selected_child.return_value = f.other
            elif change == "foreign-selection":
                f.selected.pid = 99
            elif change == "frame":
                f.x11.frame_rectangle.return_value = (0, 0, 1, 1)
            elif change == "parent":
                f.question.parent = f.app
            elif change == "busy":
                f.authenticate.states.add(f.atspi.StateType.BUSY)
            else:
                f.geometry["passwordReference"] = [f.password.app.bus_name, f.password.path]
                f.password.role = f.atspi.Role.TEXT
            with self.subTest(change=change), mock.patch.object(self.polkit, "windows", return_value=f.native), self.assertRaises(RuntimeError):
                p.perform_system_input("approve", self.polkit, f.profile, mock.Mock(), attempt, f.secret)
            f.editable.set_text_contents.assert_not_called()
            f.authenticate.action.do_action.assert_not_called()
            f.password.get_name.assert_not_called()

    def test_guard_refusal_never_adopts_an_old_request(self):
        f, attempt = self.fixture(), {}
        with mock.patch.object(self.polkit, "windows", return_value=f.native), self.assertRaises(RuntimeError):
            p.perform_system_input("approve", self.polkit, f.profile, mock.Mock(side_effect=RuntimeError("stale request")), attempt, f.secret)
        f.editable.set_text_contents.assert_not_called()

    def test_ambiguous_password_or_click_is_one_attempt_and_never_retried(self):
        for stage in ("write", "click"):
            f, attempt = self.fixture(), {}
            target = f.editable.set_text_contents if stage == "write" else f.authenticate.action.do_action
            target.side_effect = OSError("public unit secret must not reach receipt " + "a"*64)
            with mock.patch.object(self.polkit, "windows", return_value=f.native), self.assertRaisesRegex(RuntimeError, "no retry") as error:
                p.perform_system_input("approve", self.polkit, f.profile, mock.Mock(), attempt, f.secret)
            self.assertNotIn("a"*64, str(error.exception))
            self.assertEqual(attempt["passwordWriteAttempts"], 1)
            self.assertEqual(attempt["authenticateActionAttempts"], int(stage == "click"))
            with self.assertRaisesRegex(RuntimeError, "already attempted"):
                p.perform_system_input("approve", self.polkit, f.profile, mock.Mock(), attempt, f.secret)
            self.assertEqual(target.call_count, 1)

    def test_capture_or_cancel_with_secret_never_authorizes_input(self):
        polkit = mock.Mock()
        for mode, secret in (("capture", None), ("system-cancel", bytearray(b"a"*64))):
            with self.assertRaises(RuntimeError):
                p.perform_system_input(mode, polkit, mock.Mock(), mock.Mock(), {}, secret)
        polkit.cancel_once.assert_not_called()
        polkit.authenticate_once.assert_not_called()


class SecretAndProofTests(unittest.TestCase):
    @contextlib.contextmanager
    def stdin(self, *, uid=21314, owner=0, kind=stat.S_IFIFO, data=b"a"*64+b"\n"):
        with mock.patch.object(p.os, "getuid", return_value=uid, create=True), mock.patch.object(p.os, "geteuid", return_value=uid, create=True), \
                mock.patch.object(p.os, "fstat", return_value=types.SimpleNamespace(st_mode=kind|0o600, st_uid=owner)), \
                mock.patch.object(p.os, "read", side_effect=[data, b""]) as read, mock.patch.object(p.os, "close") as close:
            yield read, close

    def test_only_approve_reads_bounded_anonymous_root_pipe_then_closes(self):
        with self.stdin() as (read, close):
            value = p.read_secret(runner() | {"CREATOR_LINUX_UPDATE_FLOW_MODE": "approve"})
        self.assertEqual(value, bytearray(b"a"*64))
        self.assertTrue(all(call.args[1] <= 66 for call in read.call_args_list))
        close.assert_called_once_with(0)
        p.wipe(value)
        self.assertEqual(value, bytearray(64))

    def test_wrong_uid_owner_file_mode_or_capture_never_reads_stdin(self):
        for changes in ({"uid": 1000}, {"owner": 21314}, {"kind": stat.S_IFREG}, {"kind": stat.S_IFCHR}):
            with self.subTest(changes=changes), self.stdin(**changes) as (read, _close), self.assertRaises(RuntimeError):
                p.read_secret(runner() | {"CREATOR_LINUX_UPDATE_FLOW_MODE": "approve"})
            read.assert_not_called()
        with self.stdin() as (read, _close), self.assertRaises(RuntimeError):
            p.read_secret(runner())
        read.assert_not_called()

    def test_wrong_frame_or_read_exception_is_static_and_closes_pipe(self):
        for raw in (b"a"*63+b"\n", b"a"*64+b"\nextra", b"G"*64+b"\n", b"a"*64):
            with self.stdin(data=raw) as (_read, close), self.assertRaisesRegex(RuntimeError, "Synthetic stdin refused"):
                p.read_secret(runner() | {"CREATOR_LINUX_UPDATE_FLOW_MODE": "approve"})
            close.assert_called_once_with(0)

    def test_fresh_sequence_bound_proof_not_static_capture(self):
        proof, b = {"pkexec": {"pid": 51, "startTime": "123"}, "seals": 15}, mock.Mock()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(p, "BASE", Path(temp)), mock.patch.object(p, "protected"):
            (Path(temp)/"dpkg-input-1.json").write_bytes(json.dumps({"index": 1, "proof": proof}).encode())
            counter = [0]
            p.refreshed_dpkg(Path(temp), b, proof, counter, mock.Mock())
            self.assertEqual(counter, [1])
            self.assertEqual(b.write_new.call_count, 1)

    def test_stale_sequence_changed_request_and_exhausted_guards_refuse(self):
        for change in ("sequence", "process", "budget"):
            proof, b = {"pid": 51, "seals": 15}, mock.Mock()
            with tempfile.TemporaryDirectory() as temp, mock.patch.object(p, "BASE", Path(temp)), mock.patch.object(p, "protected"):
                response = {"index": 2 if change == "sequence" else 1, "proof": proof | ({"pid": 52} if change == "process" else {})}
                (Path(temp)/"dpkg-input-1.json").write_bytes(json.dumps(response).encode())
                with self.assertRaises(RuntimeError):
                    p.refreshed_dpkg(Path(temp), b, proof, [5] if change == "budget" else [0], mock.Mock())
            if change == "budget":
                b.write_new.assert_not_called()


class CompletionTests(unittest.TestCase):
    def complete(self):
        return {"mode": "approve", "systemInput": {"passwordWriteAttempts": 1, "authenticateActionAttempts": 1, "authenticateActionReturned": True},
            "installed15": {"dpkgVerifyPassed": True}, "automaticRestartObserved": True, "fresh15UiVerified": True,
            "settingsPreserved": True, "selectedProjectPreserved": True, "unrelatedRuntime": {"survived": True},
            "normalClose15": {"exitCode": 0}, **p.FALSE_GATES}

    def test_only_complete_approval_grants_scoped_not_public_or_flatpak_acceptance(self):
        report = self.complete()
        p.approval_complete(report)
        self.assertTrue(report["scopedFlowPassed"])
        for flag in p.FALSE_GATES:
            self.assertIs(report[flag], False)

    def test_each_missing_native_obligation_prevents_a_partial_pass(self):
        for key in ("installed15", "automaticRestartObserved", "fresh15UiVerified", "settingsPreserved", "selectedProjectPreserved", "unrelatedRuntime", "normalClose15"):
            value = self.complete()
            value.pop(key)
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.approval_complete(value)
            self.assertNotIn("scopedFlowPassed", value)
        for change in ("mode", "write", "action", "uncertain", "close"):
            value = self.complete()
            if change == "mode":
                value["mode"] = "capture"
            elif change == "close":
                value["normalClose15"]["exitCode"] = 1
            else:
                value["systemInput"][{"write": "passwordWriteAttempts", "action": "authenticateActionAttempts", "uncertain": "authenticateActionReturned"}[change]] = 0
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.approval_complete(value)

    def test_unrelated_runtime_must_survive_with_same_pid_start_image_and_parent(self):
        process, expected = mock.Mock(pid=55), record(pid=55)
        process.poll.return_value = None
        b = types.SimpleNamespace(native_process=mock.Mock(return_value=expected))
        with mock.patch.object(p.os, "getpid", return_value=40):
            self.assertTrue(p.runtime_identity(process, expected, b, None)["survived"])
            for change in ({"startTime": "102"}, {"kernelImageSha256": "f"*64}, {"parentPid": 1}):
                b.native_process.return_value = expected | change
                with self.assertRaises(RuntimeError):
                    p.runtime_identity(process, expected, b, None)
            process.poll.return_value = 0
            with self.assertRaises(RuntimeError):
                p.runtime_identity(process, expected, b, None)

    def test_dismissal_uses_complete_tree_and_refuses_replacement_dialog(self):
        polkit, native = mock.Mock(), [{"window": 77, "pid": 21}]
        def complete(_x, _h, _target, observation):
            observation.update(complete=True, absent=True)
        polkit.native_window_absence.side_effect = complete
        polkit.windows.return_value = []
        self.assertTrue(p.wait_dismissal(polkit, None, None, native, mock.Mock(), mock.Mock())["absent"])
        polkit.windows.return_value = [{"window": 88}]
        with self.assertRaisesRegex(RuntimeError, "reappeared"):
            p.wait_dismissal(polkit, None, None, native, mock.Mock(), mock.Mock())

    def test_seed_selection_and_preferences_are_inside_new_fixture_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root/"home/config/creator-works-mcp/launcher-config.json"
            def new(path, data):
                with path.open("xb") as output:
                    output.write(data)
            def fixture(_root):
                config.parent.mkdir(parents=True)
                new(config, b'{"channels":[],"active_channel_id":null,"auto_start":false}')
                return {"synthetic": True}
            b = types.SimpleNamespace(write_new=new, bounded_read=lambda path, _n: path.read_bytes())
            p.seed(root, b, types.SimpleNamespace(fixture=fixture))
            self.assertEqual(p.selected_project(root, b)["activeChannel"], "update-flow-project")
            prefs = root/"home/data/CreatorHub/preferences/hub-preferences.json"
            self.assertIs(json.loads(prefs.read_bytes())["autoDownload"], False)
            raw = json.loads(config.read_bytes())
            raw["active_channel_id"] = "other"
            config.write_bytes(json.dumps(raw).encode())
            with self.assertRaisesRegex(RuntimeError, "Selected project"):
                p.selected_project(root, b)


class BrokerTests(unittest.TestCase):
    def fixture(self, mode="approve"):
        env = runner() | {"CREATOR_LINUX_UPDATE_FLOW_MODE": mode}
        account = types.SimpleNamespace(pw_uid=p.UID, pw_gid=p.UID, pw_dir="/var/lib/creator-polkit-fixture", pw_shell="/bin/bash")
        state, calls, held = {"password": "L"}, [], []
        def credential(operation, secret=None):
            calls.append(operation)
            if operation == "status":
                return state["password"]
            if operation == "provision":
                self.assertEqual(secret, bytearray(b"a"*64))
                held.append(secret)
                state["password"] = "P"
            if operation == "lock":
                state["password"] = "L"
        polkit = types.SimpleNamespace(credential_tools=mock.Mock(), fixture_credential=mock.Mock(side_effect=credential), admin_config=mock.Mock(return_value={"publicPolicy": "unchanged"}))
        result = {"testSource": env["GITHUB_SHA"], "mode": mode, "scopedFlowPassed": mode == "approve", "scopedCancellationPassed": mode == "system-cancel"}
        output, receipt, guard = mock.Mock(), mock.Mock(), mock.Mock()
        output.resolve.return_value = output
        output.stat.return_value = types.SimpleNamespace(st_uid=p.UID, st_gid=p.UID, st_mode=stat.S_IFDIR|0o700)
        output.__truediv__ = mock.Mock(side_effect=lambda name: receipt if name.endswith("update-flow-report.json") else guard)
        receipt.exists.return_value = True
        receipt.resolve.return_value = receipt
        receipt.lstat.return_value = types.SimpleNamespace(st_mode=stat.S_IFREG|0o600, st_uid=p.UID, st_nlink=1, st_size=500)
        receipt.read_bytes.side_effect = lambda: json.dumps(result).encode()
        guard.exists.return_value = False
        base = mock.MagicMock()
        base.__truediv__.side_effect = lambda name: output if name == "result" else Path("/mock")/name
        b = types.SimpleNamespace(write_new=mock.Mock(), save_json=mock.Mock())
        session = mock.Mock()
        session.poll.side_effect = [None, 0, 0]
        session.stdin.write.side_effect = lambda data: held.append(data) or len(data)
        proof = {"root14": record(), "program": "/usr/bin/dpkg", "seals": 15}
        fakepwd = types.SimpleNamespace(getpwnam=mock.Mock(return_value=account))
        fakegrp = types.SimpleNamespace(getgrnam=mock.Mock(return_value=types.SimpleNamespace(gr_gid=27)))
        resource = types.SimpleNamespace(RLIMIT_CORE=4, setrlimit=mock.Mock())
        return types.SimpleNamespace(**locals())

    @contextlib.contextmanager
    def patches(self, f):
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(sys.modules, {"pwd": f.fakepwd, "grp": f.fakegrp, "resource": f.resource}))
            stack.enter_context(mock.patch.object(p, "admission"))
            stack.enter_context(mock.patch.object(p, "fixture_binding", return_value={"source": f.env["GITHUB_SHA"]}))
            stack.enter_context(mock.patch.object(p, "BASE", f.base))
            stack.enter_context(mock.patch.object(p, "dependencies", return_value=(None, f.b, None, f.polkit)))
            stack.enter_context(mock.patch.object(p.os, "getuid", return_value=0, create=True))
            stack.enter_context(mock.patch.object(p.os, "geteuid", return_value=0, create=True))
            stack.enter_context(mock.patch.object(p.os, "getgrouplist", return_value=[21314, 27], create=True))
            stack.enter_context(mock.patch.object(p.os, "fstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR|0o666, st_rdev=3)))
            stack.enter_context(mock.patch.object(p.os, "stat", return_value=types.SimpleNamespace(st_rdev=3)))
            stack.enter_context(mock.patch.object(p.os.path, "lexists", return_value=False))
            stack.enter_context(mock.patch.object(p.os, "chmod"))
            stack.enter_context(mock.patch.object(p.secrets, "token_hex", return_value="a"*64))
            stack.enter_context(mock.patch.object(p.time, "sleep"))
            f.spawn = stack.enter_context(mock.patch.object(p.subprocess, "Popen", return_value=f.session))
            f.observer = stack.enter_context(mock.patch.object(p, "pending_dpkg_proof", return_value=f.proof))
            yield

    def saved(self, f):
        return next(call.args[1] for call in f.b.save_json.call_args_list if str(call.args[0]).endswith("update-flow-broker.json"))

    def test_only_approve_provisions_once_pipes_once_wipes_and_relocks(self):
        f = self.fixture()
        with self.patches(f):
            value = p.broker(f.env)
        self.assertEqual(f.calls, ["status", "provision", "status", "lock", "status"])
        f.session.stdin.write.assert_called_once()
        self.assertEqual(f.spawn.call_args.kwargs["stdin"], subprocess.PIPE)
        self.assertEqual(len(f.held), 2)
        self.assertTrue(all(value == bytearray(len(value)) for value in f.held))
        self.assertTrue(value["fixtureRelocked"])
        self.assertTrue(value["scopedFlowPassed"])
        self.assertNotIn("a"*64, json.dumps(value))
        self.assertNotIn("a"*64, json.dumps(f.spawn.call_args.args))
        self.assertTrue(all(value[flag] is False for flag in p.FALSE_GATES))

    def test_capture_and_system_cancel_stay_locked_with_devnull_no_secret_generation(self):
        for mode in ("capture", "system-cancel"):
            f = self.fixture(mode)
            with self.subTest(mode=mode), self.patches(f):
                value = p.broker(f.env)
                p.secrets.token_hex.assert_not_called()
            self.assertEqual(f.calls, ["status", "status"])
            f.session.stdin.write.assert_not_called()
            self.assertEqual(f.spawn.call_args.kwargs["stdin"], subprocess.DEVNULL)
            self.assertFalse(value["passwordProvisioned"])

    def test_ambiguous_provision_still_relocks_without_session_or_retry(self):
        f = self.fixture()
        original = f.polkit.fixture_credential.side_effect
        def ambiguous(operation, secret=None):
            result = original(operation, secret)
            if operation == "provision":
                raise RuntimeError("Synthetic provisioning refused")
            return result
        f.polkit.fixture_credential.side_effect = ambiguous
        with self.patches(f), self.assertRaises(RuntimeError):
            p.broker(f.env)
        f.spawn.assert_not_called()
        self.assertEqual(f.calls, ["status", "provision", "lock", "status"])
        self.assertTrue(self.saved(f)["fixtureRelocked"])
        self.assertEqual(f.held[0], bytearray(64))

    def test_original_session_refusal_survives_observer_dead_root_and_relock_failure(self):
        f = self.fixture()
        f.result["refusal"] = {"type": "RuntimeError", "message": "Original owned graph refused"}
        original = f.polkit.fixture_credential.side_effect
        def refuse_lock(operation, secret=None):
            if operation == "lock":
                raise RuntimeError("lock unavailable")
            return original(operation, secret)
        f.polkit.fixture_credential.side_effect = refuse_lock
        with self.patches(f):
            f.observer.side_effect = RuntimeError("Owned process is not live")
            with self.assertRaises(RuntimeError):
                p.broker(f.env)
        saved = self.saved(f)
        self.assertEqual(saved["sessionRefusal"], f.result["refusal"])
        self.assertIn("not live", saved["observerRefusal"]["message"])
        self.assertIn("relockRefusal", saved)
        self.assertFalse(saved["scopedFlowPassed"])
        self.assertIn("unknown-no-retry", saved["recovery"])

    def test_changed_account_never_locks_a_replacement_identity(self):
        f = self.fixture()
        f.fakepwd.getpwnam.side_effect = [f.account, types.SimpleNamespace(**(vars(f.account)|{"pw_uid": 1000}))]
        with self.patches(f), self.assertRaises(RuntimeError):
            p.broker(f.env)
        self.assertNotIn("lock", f.calls)
        self.assertFalse(self.saved(f)["fixtureRelocked"])

    def test_locked_or_partial_approval_receipt_never_adopts_install_outcome(self):
        f = self.fixture()
        f.result["scopedFlowPassed"] = False
        with self.patches(f), self.assertRaises(RuntimeError):
            p.broker(f.env)
        self.assertTrue(self.saved(f)["fixtureRelocked"])
        self.assertFalse(self.saved(f)["scopedFlowPassed"])
        self.assertEqual(f.spawn.call_count, 1)


class FreshUiTests(unittest.TestCase):
    def fixture(self):
        value = record(p.Phase15())
        refs, bus, frame = mock.Mock(), mock.Mock(), mock.Mock()
        frame.get_role.return_value, frame.get_name.return_value = 23, "Creator Hub"
        frame.get_state_set.return_value.contains.side_effect = lambda state: state in (1, 2, 3)
        app = mock.Mock()
        app.get_process_id.return_value = value["pid"]
        helper = mock.Mock()
        helper.children.side_effect = lambda node, _bound: [app] if node == "desktop" else [frame]
        helper.bound_window.return_value = {"pid": 42, "client": 9, "mapped": True, "title": "Creator Hub"}
        helper.Request.side_effect = lambda _a, pid, start, exe, sha, window, title, role: types.SimpleNamespace(
            pid=pid, start=start, executable=exe, sha256=sha, window=window, title=title, role=role)
        atspi = types.SimpleNamespace(Role=types.SimpleNamespace(FRAME=23), get_desktop=lambda _i: "desktop",
            StateType=types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5))
        owner = types.SimpleNamespace(renderer={"pid": 43}, recheck=mock.Mock())
        snapshot = {"nodes": [{"name": "0.1.15", "showing": True}]}
        b = types.SimpleNamespace(TITLE="Creator Hub", native_ax_references=mock.Mock(return_value=(refs, bus)),
            native_process=mock.Mock(return_value=value), RootOwnership=mock.Mock(return_value=owner), snapshot_owned=mock.Mock(return_value=snapshot))
        c = types.SimpleNamespace(owned_windows=mock.Mock(return_value=[{"window": 88, "mapped": True, "title": "Creator Hub"}]))
        polkit = types.SimpleNamespace(dbus_call=mock.Mock(return_value=[True]), bus_identity=mock.Mock(return_value={"pid": 42, "uid": 21314}))
        return types.SimpleNamespace(**locals())

    def invoke(self, f):
        return p.successor_ui(f.value, 77, f.b, f.c, f.polkit, f.helper, None, f.atspi, "session-bus", None, mock.Mock(), {"system": "pin"})

    def test_fresh_phase15_binds_new_pid_xid_ax_aliases_and_renderer(self):
        f = self.fixture()
        request, owner, bus, _snapshot = self.invoke(f)
        self.assertEqual(request.sha256, p.Phase15().digest)
        self.assertEqual(request.window, 88)
        f.b.native_ax_references.assert_called_once_with()
        self.assertIs(f.b.RootOwnership.call_args.kwargs["references"], f.refs)
        self.assertIs(owner, f.owner)
        self.assertIs(bus, f.bus)
        f.bus.close_sync.assert_not_called()

    def test_old_xid_foreign_bus_changed_pid_or_multiple_windows_refuse(self):
        for change in ("xid", "bus", "process", "multiple", "renderer"):
            f = self.fixture()
            if change == "xid":
                f.c.owned_windows.return_value[0]["window"] = 77
            elif change == "bus":
                f.polkit.bus_identity.return_value["pid"] = 99
            elif change == "process":
                f.b.native_process.return_value = f.value | {"startTime": "999"}
            elif change == "multiple":
                f.c.owned_windows.return_value *= 2
            else:
                f.owner.renderer = None
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.invoke(f)
            f.bus.close_sync.assert_called_once_with(None)

    def test_loading_or_wrong_version_never_calls_acceptance_or_performs_input(self):
        f = self.fixture()
        f.snapshot["nodes"][0]["name"] = "0.1.14"
        with mock.patch.object(p.time, "monotonic", side_effect=[0, 0, 26]), self.assertRaisesRegex(RuntimeError, "deadline"):
            self.invoke(f)
        f.b.RootOwnership.assert_called_once()
        f.bus.close_sync.assert_called_once_with(None)


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code = r"""
        const fs=require('node:fs'),{yaml}=require('./node_modules/playwright-core/lib/utilsBundle.js');
        const doc=yaml.parseDocument(fs.readFileSync(process.argv[1],'utf8'),{uniqueKeys:true});
        if(doc.errors.length)throw doc.errors[0];
        const w=doc.toJS(),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        for(const j of Object.values(w.jobs))for(const s of j.steps)if(s.uses?.startsWith('actions/github-script@'))new AsyncFunction('github','context','core',s.with.script);
        process.stdout.write(JSON.stringify(w));
        """
        result = subprocess.run([shutil.which("node") or "node", "-e", code, str(WORKFLOW)], cwd=ROOT, capture_output=True, check=True, timeout=15)
        cls.workflow = json.loads(result.stdout)

    def test_bootstrap_push_runs_pure_preflight_only_native_and_stage_manual(self):
        w = self.workflow
        self.assertEqual(w["on"]["push"]["branches"], [p.BRANCH.removeprefix("refs/heads/")])
        self.assertEqual(set(w["on"]["push"]["paths"]), {"scripts/native-linux-update-flow.py", "scripts/native-linux-update-flow.test.py", ".github/workflows/native-linux-update-flow-014.yml"})
        self.assertEqual(w["on"]["workflow_dispatch"]["inputs"]["mode"]["options"], list(p.MODES))
        self.assertIn("github.event_name == 'push' || github.event_name == 'workflow_dispatch'", w["jobs"]["preflight"]["if"])
        for name in ("native", "stage-input"):
            self.assertIn("github.event_name == 'workflow_dispatch'", w["jobs"][name]["if"])
            self.assertNotIn("'push'", w["jobs"][name]["if"])

    def test_private_get_permission_only_stage_native_has_no_token_sign_or_publish(self):
        jobs = self.workflow["jobs"]
        self.assertEqual(jobs["stage-input"]["permissions"], {"contents": "write", "actions": "read"})
        self.assertEqual(jobs["native"]["permissions"], {"contents": "read", "actions": "read"})
        native = json.dumps(jobs["native"])
        for forbidden in ("github-script", "GITHUB_TOKEN", "secrets.", "cargo build", "npm run build"):
            self.assertNotIn(forbidden, native)
        text = WORKFLOW.read_text()
        for forbidden in ("createRelease", "updateRelease", "uploadReleaseAsset", "deleteReleaseAsset", "NOPASSWD", "polkit.addRule", "sudoers", "rules.d"):
            self.assertNotIn(forbidden, text)

    def test_shallow_preflight_fetches_only_exact_frozen_source_before_fixture_tests(self):
        commands = [step["run"] for step in self.workflow["jobs"]["preflight"]["steps"] if "run" in step]
        fetch = "git fetch --no-tags --depth=1 origin " + p.FROZEN_SOURCE
        self.assertEqual(commands.count(fetch), 1)
        tests = next(i for i, command in enumerate(commands) if "native-linux-update-flow.test.py" in command)
        self.assertLess(commands.index(fetch), tests)

    def test_complete_frozen_checkout_and_stage_bindings(self):
        text = WORKFLOW.read_text()
        self.assertEqual(text.count("ref: " + p.FROZEN_SOURCE), 2)
        for literal in ("artifact.digest,`sha256:${digest}`", "commit.tree.sha,tree", "release.draft,true", "after.draft,true", "linux-flow-current-source.json",
                        "linux-root-source-binding.json", "linux-discovery-target-binding.json", "r.PRIVATE_SOURCE", "pins.frozenFiles", "source.st_nlink"):
            if literal == "source.st_nlink":
                self.assertIn("info.st_nlink", text)
            else:
                self.assertIn(literal, text)
        self.assertNotIn("GITHUB_REF=refs/", text)
        for job in self.workflow["jobs"].values():
            self.assertEqual(job["runs-on"], "ubuntu-22.04")
            for step in job["steps"]:
                if step.get("uses", "").startswith("actions/checkout@"):
                    self.assertIs(step["with"]["persist-credentials"], False)

    def test_capture_gate_precedes_download_and_protected_source_precedes_broker(self):
        stage = self.workflow["jobs"]["stage-input"]["steps"]
        self.assertLess(next(i for i,s in enumerate(stage) if "native-linux-update-flow.py pins" in s.get("run", "")),
                        next(i for i,s in enumerate(stage) if s.get("uses", "").startswith("actions/github-script@")))
        native = json.dumps(self.workflow["jobs"]["native"]["steps"])
        self.assertLess(native.index("Install exact protected fixture source"), native.index("Manual fixed broker"))

    def test_all_three_modes_remain_finite_with_exact_frozen_inputs_and_full_flow_obligations(self):
        script = next(s["with"]["script"] for s in self.workflow["jobs"]["stage-input"]["steps"] if s.get("uses", "").startswith("actions/github-script@"))
        self.assertIn("['capture','system-cancel','approve'].includes(process.env.CREATOR_LINUX_UPDATE_FLOW_MODE)", script)
        for pin in ("534465a86554e95b909bf9c7decbbb29cbca5267", "eef90658c4d9e6743c6c25f67e00ad36c783ca6e", "12127943519"):
            self.assertIn(pin, script)
        source = (HERE/"native-linux-update-flow.py").read_text()
        self.assertNotIn("0.1.16", source)
        for code in ('"cancelled", child', '"updaterReadyAfterCancel"', '"scopedCancellationPassed"] = False',
                     '"system-input-attempt.json"', '"phase15-ui.json"'):
            self.assertIn(code, source)

    def test_artifact_export_is_finite_excludes_tls_and_actual_settings(self):
        steps = self.workflow["jobs"]["native"]["steps"]
        export = next(s for s in steps if s.get("name", "").startswith("Export only"))
        self.assertEqual(export["if"], "always()")
        for forbidden in ("private.pem", "ephemeral-tls", "passwd", "shadow", "home/config", "glob(", "rglob("):
            self.assertNotIn(forbidden, export["run"])
        self.assertIn("0 <= info.st_size <= 1048576", export["run"])
        upload = next(s for s in steps if s.get("uses", "").startswith("actions/upload-artifact@"))
        for forbidden in ("private.pem", "ephemeral-tls", "*.pem", "**", "/opt/creator-polkit-fixture/result"):
            self.assertNotIn(forbidden, upload["with"]["path"])

    def test_bash_embedded_python_and_actual_yaml_js_parse_without_execution(self):
        parsed = yaml.safe_load(WORKFLOW.read_text())
        self.assertEqual(set(parsed["jobs"]), set(self.workflow["jobs"]))
        bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path("/usr/bin/bash")
        self.assertTrue(bash.is_file())
        scripts = python_bodies = 0
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                if "run" not in step:
                    continue
                body = step["run"]
                result = subprocess.run([str(bash), "-n"], input=body.encode(), capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                scripts += 1
                for embedded in re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", body, re.S):
                    ast.parse(embedded)
                    python_bodies += 1
        self.assertEqual(scripts, 10)
        self.assertEqual(python_bodies, 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
