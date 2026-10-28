"""Pure/temp continuation contracts. No native app, auth, trust or package changes."""
import ast
import base64
import copy
import gzip
import hashlib
import io
from contextlib import ExitStack, contextmanager
import importlib.util
import json
import os
import queue
from pathlib import Path
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location("continuation_test_" + name.replace("-", "_"), HERE / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = value
    spec.loader.exec_module(value)
    return value


C = module("native-linux-migrated-update")
T = module("native-linux-production-016-update.test")
U, M = C.U, C.M


@unittest.skipUnless(hasattr(C.select, "poll") and hasattr(os, "pidfd_open"), "Linux pidfd only")
class RefusedProcessObservationTests(unittest.TestCase):
    def setUp(self):
        self.first = {"processes": [{"pid": 2000000000, "startTime": "10"}, {"pid": 2000000001, "startTime": "11"}],
            "terminalProcesses": []}

    def test_observes_bound_exits_without_authorizing_anything(self):
        poller = Mock(); poller.poll.side_effect = [[(71, C.select.POLLIN)], [(72, C.select.POLLIN)]]
        empty = {"processes": [], "terminalProcesses": []}
        with patch.object(M, "native_process_inventory", side_effect=[self.first, self.first, empty]), \
                patch.object(C.os, "pidfd_open", side_effect=[71, 72]), patch.object(C.os, "close") as close, \
                patch.object(C.select, "poll", return_value=poller), patch.object(U, "run_tool", return_value=b"State=inactive\n"):
            result = C.observe_refused_fixture_processes(self.first, Mock(), Mock())
        self.assertEqual(result["observedExit"], [{"pid": 2000000000, "startTime": "10"}, {"pid": 2000000001, "startTime": "11"}])
        self.assertEqual(result["finalInventory"], empty)
        self.assertFalse(result["authorityGranted"]); self.assertFalse(result["inputPermitted"])
        self.assertFalse(result["pidfdExitIsNormalExit"]); self.assertEqual(close.call_count, 2)

    def test_inventory_drift_refuses_and_closes_bound_fds(self):
        changed = {"processes": [{"pid": 2000000000, "startTime": "different"}], "terminalProcesses": []}
        with patch.object(M, "native_process_inventory", side_effect=[self.first, changed]), \
                patch.object(C.os, "pidfd_open", side_effect=[71, 72]), patch.object(C.os, "close") as close, \
                patch.object(U, "run_tool") as run:
            result = C.observe_refused_fixture_processes(self.first, Mock(), Mock())
        self.assertEqual(result["unavailable"]["type"], "RuntimeError")
        self.assertEqual(close.call_count, 2); run.assert_not_called()
        self.assertFalse(result["authorityGranted"])

    def test_deadline_keeps_original_processes_pending(self):
        poller = Mock(); poller.poll.return_value = []
        with patch.object(M, "native_process_inventory", return_value=self.first), \
                patch.object(C.os, "pidfd_open", side_effect=[71, 72]), patch.object(C.os, "close"), \
                patch.object(C.select, "poll", return_value=poller), patch.object(U, "run_tool", return_value=b""):
            result = C.observe_refused_fixture_processes(self.first, Mock(), Mock())
        self.assertEqual(len(result["pendingAtDeadline"]), 2)
        self.assertEqual(result["observedExit"], []); self.assertFalse(result["authorityGranted"])

    def test_real_owned_child_exits_on_eof_and_is_observed_without_signalling(self):
        child = C.subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.buffer.read()"],
            stdin=C.subprocess.PIPE, stdout=C.subprocess.DEVNULL, stderr=C.subprocess.DEVNULL)
        native, helper = U.load("native-linux-root-probe"), U.load("native-unix-window")
        identity = native.native_process(child.pid, helper)
        first = {"processes": [{"pid": child.pid, "startTime": identity["startTime"],
            "executable": identity["executable"]}], "terminalProcesses": []}
        def metadata(*_args, **_kwargs):
            if not child.stdin.closed: child.stdin.close()
            return b""
        try:
            with patch.object(M, "UID", os.getuid()), patch.object(M, "native_process_inventory", return_value=first), \
                    patch.object(U, "run_tool", side_effect=metadata):
                result = C.observe_refused_fixture_processes(first, native, helper)
            self.assertEqual(result["observedExit"], [{"pid": child.pid, "startTime": identity["startTime"]}])
            actor = result["actorEvidence"][0]
            self.assertEqual(actor["uid"], [os.getuid()] * 4); self.assertEqual(actor["gid"], [os.getgid()] * 4)
            self.assertTrue(actor["cgroup"]); self.assertEqual(actor["kernelImageSha256"], identity["kernelImageSha256"])
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertFalse(result["authorityGranted"])
        finally:
            if not child.stdin.closed: child.stdin.close()
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)


@unittest.skipUnless(hasattr(C.select, "poll") and hasattr(os, "pidfd_open"), "Linux pidfd only")
class FixtureReapingKernelTests(unittest.TestCase):
    def test_exit_notification_does_not_imply_reaping(self):
        child = C.subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.buffer.read()"],
            stdin=C.subprocess.PIPE, stdout=C.subprocess.DEVNULL, stderr=C.subprocess.DEVNULL)
        procfd = pidfd = None
        try:
            helper = U.load("native-unix-window")
            path = Path("/proc") / str(child.pid)
            procfd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            pidfd = os.pidfd_open(child.pid, 0)
            with patch.object(M, "UID", os.getuid()):
                origin = M.inventory_process_snapshot(procfd, path, child.pid, helper)
                child.stdin.close()
                poller = C.select.poll(); poller.register(pidfd, C.select.POLLIN)
                self.assertTrue(poller.poll(5000))
                first = M.inventory_process_snapshot(procfd, path, child.pid, helper)
                second = M.inventory_process_snapshot(procfd, path, child.pid, helper)
                proof = M.inventory_terminal_record(child.pid, origin, first, second)
                self.assertEqual(proof["classification"], "terminal")
                self.assertEqual(first["state"], "Z")
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertFalse(path.exists())
        finally:
            if procfd is not None: os.close(procfd)
            if pidfd is not None: os.close(pidfd)
            if not child.stdin.closed: child.stdin.close()
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)


class FixtureQuiescenceTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{"pid": pid, "startTime": str(pid + 1), "executable": "/usr/lib/systemd/systemd",
            "argvSha256": str(pid - 1000) * 64, "legacyBackend": False} for pid in (1000, 1001)]
        self.initial = {"processes": self.rows, "terminalProcesses": []}
        self.empty = {"processes": [], "terminalProcesses": []}
        request = {"schemaVersion": 1, "operation": "global-uid-inventory", "harnessSource": "a" * 40,
            "scenario": "migration-approve", "sequence": 1, "nonce": "b" * 64}
        self.prior = {"scope": "production-016-disposable-migration", "scenario": "migration-approve",
            "scenarioPassed": True, "fixtureRelocked": True, "harnessSource": "a" * 40,
            "sessionWrapper": {"returnCode": 0, "deadlineExpired": False,
                "pipes": {name: {"eof": True, "truncated": False} for name in ("stdout", "stderr")}},
            "lastInventory": {"request": request, "ok": True, "processes": copy.deepcopy(self.rows), "terminalProcesses": []}}

    def test_only_original_completed_manager_pair_is_eligible(self):
        self.assertEqual(set(C.fixture_quiescence_validate(self.initial, self.prior)), {1000, 1001})
        for mutation in ("new_actor", "changed_start", "unfinished_wrapper", "terminal"):
            with self.subTest(mutation=mutation):
                initial, prior = copy.deepcopy(self.initial), copy.deepcopy(self.prior)
                if mutation == "new_actor": initial["processes"][0]["pid"] = 999
                if mutation == "changed_start": initial["processes"][0]["startTime"] = "999"
                if mutation == "unfinished_wrapper": prior["sessionWrapper"]["returnCode"] = 1
                if mutation == "terminal": initial["terminalProcesses"] = [{}]
                with self.assertRaises(RuntimeError): C.fixture_quiescence_validate(initial, prior)

    def test_empty_inventory_needs_no_observation(self):
        with patch.object(C, "_fixture_quiescence_properties") as properties:
            self.assertEqual(C.fixture_quiescence(self.empty, {}, Mock(), Mock()), self.empty)
            properties.assert_not_called()

    @unittest.skipUnless(hasattr(C.select, "poll") and hasattr(os, "pidfd_open"), "Linux pidfd only")
    def test_foreign_unit_or_live_session_refuses_before_opening_any_pidfd(self):
        valid = {"Id": "user@21314.service", "LoadState": "loaded", "User": "21314", "PAMName": "systemd-user",
            "MainPID": "1000", "InvocationID": "c" * 32, "ControlGroup": "/user.slice/user-21314.slice/user@21314.service",
            "ActiveState": "active", "SubState": "running"}
        user = {"UID": "21314", "Linger": "no", "Sessions": "", "State": "closing"}
        for mutation in ("foreign_main", "foreign_group", "missing_invocation", "live_session", "linger"):
            with self.subTest(mutation=mutation):
                unit, state = copy.deepcopy(valid), copy.deepcopy(user)
                if mutation == "foreign_main": unit["MainPID"] = "2222"
                if mutation == "foreign_group": unit["ControlGroup"] = "/unrelated"
                if mutation == "missing_invocation": unit["InvocationID"] = ""
                if mutation == "live_session": state["Sessions"] = "c1"
                if mutation == "linger": state["Linger"] = "yes"
                with patch.object(C, "_fixture_quiescence_properties", side_effect=[unit, state]), \
                        patch.object(C.os, "pidfd_open") as open_pid:
                    with self.assertRaises(RuntimeError): C.fixture_quiescence(self.initial, self.prior, Mock(), Mock())
                open_pid.assert_not_called()

    @unittest.skipUnless(hasattr(C.select, "poll") and hasattr(os, "pidfd_open"), "Linux pidfd only")
    def test_bound_exit_then_zombie_then_empty_requires_unfiltered_inventory(self):
        unit = {"Id": "user@21314.service", "LoadState": "loaded", "User": "21314", "PAMName": "systemd-user",
            "MainPID": "1000", "InvocationID": "c" * 32, "ControlGroup": "/user.slice/user-21314.slice/user@21314.service",
            "ActiveState": "active", "SubState": "running"}
        user = {"UID": "21314", "Linger": "no", "Sessions": "", "State": "closing"}
        snapshots = {pid: {"pid": pid, "startTime": str(pid + 1), "parentPid": 1 if pid == 1000 else 1000,
            "state": "S", "Uid": [M.UID] * 4, "Gid": [M.UID] * 4, "procDirectory": {"ino": pid}}
            for pid in (1000, 1001)}
        zombie = {**snapshots[1001], "parentPid": 1, "state": "Z"}
        terminal = {"pid": 1001, "classification": "terminal", "origin": zombie, "before": zombie, "after": zombie}
        poller = Mock(); poller.poll.side_effect = [[], [], [], [(71, C.select.POLLIN)], [], [],
            [(72, C.select.POLLIN)], [], [], []]
        calls = {1000: 0, 1001: 0}
        def actor(row, *_):
            pid = row["pid"]; calls[pid] += 1
            value = dict(snapshots[pid])
            if pid == 1001 and calls[pid] >= 3: value["parentPid"] = 1
            return value
        evidence = {}
        with patch.object(C, "_fixture_quiescence_properties", side_effect=[unit, user, unit]), \
                patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFREG | 0o755)), \
                patch.object(M, "read_file", return_value=b"protected"), patch.object(C.os, "pidfd_open", side_effect=[71, 72]), \
                patch.object(C.os, "open", side_effect=[81, 82]), patch.object(C.os, "close") as close, \
                patch.object(C, "_fixture_quiescence_actor", side_effect=actor), \
                patch.object(M, "native_process_inventory", side_effect=[self.initial, {"processes": [self.rows[1]], "terminalProcesses": []},
                    {"processes": [], "terminalProcesses": [terminal]}, self.empty]), \
                patch.object(M, "inventory_terminal_record", return_value=terminal), patch.object(C.select, "poll", return_value=poller):
            final = C.fixture_quiescence(self.initial, self.prior, Mock(), Mock(), evidence=evidence)
        self.assertEqual(final, self.empty); self.assertEqual(close.call_count, 4)
        self.assertIn("pam-reparented", [row["event"] for row in evidence["fixtureQuiescence"]["events"]])

    @unittest.skipUnless(hasattr(C.select, "poll") and hasattr(os, "pidfd_open"), "Linux pidfd only")
    def test_new_actor_refuses_and_records_reason_without_authority(self):
        unit = {"Id": "user@21314.service", "LoadState": "loaded", "User": "21314", "PAMName": "systemd-user",
            "MainPID": "1000", "InvocationID": "c" * 32, "ControlGroup": "/user.slice/user-21314.slice/user@21314.service",
            "ActiveState": "active", "SubState": "running"}
        user = {"UID": "21314", "Linger": "no", "Sessions": "", "State": "closing"}
        snapshots = {pid: {"pid": pid, "startTime": str(pid + 1), "parentPid": 1 if pid == 1000 else 1000,
            "state": "S", "Uid": [M.UID] * 4, "Gid": [M.UID] * 4, "procDirectory": {"ino": pid}}
            for pid in (1000, 1001)}
        extra = {"processes": self.rows + [{"pid": 1002}], "terminalProcesses": []}
        poller = Mock(); poller.poll.return_value = []
        evidence = {}
        with patch.object(C, "_fixture_quiescence_properties", side_effect=[unit, user, unit]), \
                patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFREG | 0o755)), \
                patch.object(M, "read_file", return_value=b"protected"), patch.object(C.os, "pidfd_open", side_effect=[71, 72]), \
                patch.object(C.os, "open", side_effect=[81, 82]), patch.object(C.os, "close") as close, \
                patch.object(C, "_fixture_quiescence_actor", side_effect=lambda row, *_: snapshots[row["pid"]]), \
                patch.object(M, "native_process_inventory", return_value=extra), patch.object(C.select, "poll", return_value=poller):
            with self.assertRaisesRegex(RuntimeError, "Unknown live fixture actor"):
                C.fixture_quiescence(self.initial, self.prior, Mock(), Mock(), evidence=evidence)
        self.assertEqual(close.call_count, 4)
        self.assertEqual(evidence["fixtureQuiescence"]["status"], "refused")
        self.assertFalse(evidence["fixtureQuiescence"]["authorityGranted"])

    @unittest.skipUnless(hasattr(C.select, "poll") and hasattr(os, "pidfd_open"), "Linux pidfd only")
    def test_partial_pidfd_failure_closes_bound_handles_and_refuses(self):
        unit = {"Id": "user@21314.service", "LoadState": "loaded", "User": "21314", "PAMName": "systemd-user",
            "MainPID": "1000", "InvocationID": "c" * 32, "ControlGroup": "/user.slice/user-21314.slice/user@21314.service",
            "ActiveState": "active", "SubState": "running"}
        user = {"UID": "21314", "Linger": "no", "Sessions": "", "State": "closing"}
        snapshot = {"pid": 1000, "startTime": "1001", "parentPid": 1, "state": "S", "Uid": [M.UID] * 4,
            "Gid": [M.UID] * 4, "procDirectory": {"ino": 1000}}
        evidence = {}
        with patch.object(C, "_fixture_quiescence_properties", side_effect=[unit, user]), \
                patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFREG | 0o755)), \
                patch.object(M, "read_file", return_value=b"protected"), \
                patch.object(C.os, "pidfd_open", side_effect=[71, OSError("pidfd failed")]), \
                patch.object(C.os, "open", return_value=81), patch.object(C.os, "close") as close, \
                patch.object(C, "_fixture_quiescence_actor", return_value=snapshot):
            with self.assertRaisesRegex(OSError, "pidfd failed"):
                C.fixture_quiescence(self.initial, self.prior, Mock(), Mock(), evidence=evidence)
        self.assertEqual({call.args[0] for call in close.call_args_list}, {71, 81})
        self.assertEqual(evidence["fixtureQuiescence"]["status"], "refused")
        self.assertFalse(evidence["fixtureQuiescence"]["authorityGranted"])


@unittest.skipUnless(hasattr(C.select, "poll") and Path("/usr/bin/systemctl").is_file(), "Linux systemd tool only")
class FixturePropertyReaderTests(unittest.TestCase):
    def run_client(self, output, stderr="", status=0):
        spawn = C.subprocess.Popen
        invoked, children = [], []
        code = "import sys; sys.stdout.write(%r); sys.stderr.write(%r); sys.exit(%d)" % (output, stderr, status)
        def substitute(command, **options):
            invoked.append(command)
            options["cwd"] = "/"
            child = spawn([sys.executable, "-c", code], **options)
            children.append(child)
            return child
        try:
            with patch.object(C.subprocess, "Popen", side_effect=substitute):
                result = C._fixture_quiescence_properties("unit", C.time.monotonic() + 10)
        finally:
            for child in children: child.wait(timeout=5)
        self.assertEqual(invoked[0][0], "/usr/bin/systemctl")
        self.assertIn("user@21314.service", invoked[0])
        self.assertIn("--property=InvocationID", invoked[0])
        return result

    def test_parses_complete_fixed_properties(self):
        value = "Id=user@21314.service\nLoadState=loaded\nUser=21314\nPAMName=systemd-user\nMainPID=42\n" \
                "InvocationID=" + "a" * 32 + "\nControlGroup=/user.slice\nActiveState=active\nSubState=running\n"
        parsed = self.run_client(value)
        self.assertEqual(parsed["MainPID"], "42"); self.assertEqual(parsed["InvocationID"], "a" * 32)

    def test_missing_duplicate_and_stderr_are_refused(self):
        complete = "Id=user@21314.service\nLoadState=loaded\nUser=21314\nPAMName=systemd-user\nMainPID=42\n" \
                   "InvocationID=" + "a" * 32 + "\nControlGroup=/user.slice\nActiveState=active\nSubState=running\n"
        for output, stderr in ((complete.replace("MainPID=42\n", ""), ""),
                               (complete + "MainPID=42\n", ""), (complete, "failure")):
            with self.subTest(output=output, stderr=stderr):
                with self.assertRaises((RuntimeError, AssertionError)): self.run_client(output, stderr)
        for output, status in ((complete, 2), ("x" * 8193, 0)):
            with self.subTest(length=len(output), status=status):
                with self.assertRaises((RuntimeError, AssertionError)): self.run_client(output, status=status)


class WatcherKernel:
    """Only the Linux notification/FD boundary is replaced on Windows."""
    def __init__(self, parent):
        self.parent, self.before = parent, C.directory(parent, M.UID)
        self.wd, self.closed, self.wakes = 7, False, 0
        self.events = queue.Queue()

    def check_parent(self):
        if C.directory(self.parent, M.UID) != self.before:
            raise RuntimeError("Ready parent drift")

    def wait(self, deadline):
        try: value = self.events.get(timeout=max(0, deadline - C.time.monotonic()))
        except queue.Empty: raise TimeoutError("Ready deadline expired")
        if isinstance(value, Exception): raise value
        return value

    def pending(self):
        try: return self.events.get_nowait()
        except queue.Empty: return b""

    def wake(self):
        self.wakes += 1
        self.events.put(RuntimeError("Ready watcher closed before capture"))

    def close(self):
        self.closed = True


def watcher_event(mask=0x80, name=b"mcp-route-update.json", *, wd=7, cookie=1):
    raw = name + b"\0" if name else b""
    raw += b"\0" * (-len(raw) % 4)
    return struct.pack("=iIII", wd, mask, cookie, len(raw)) + raw


def environment():
    return {**T.environment(), "GITHUB_REF": M.BRANCH, "GITHUB_WORKFLOW_REF": M.WORKFLOW,
            "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1", "CREATOR_MIGRATION_016_EXECUTE": "true",
            "CREATOR_MIGRATION_016_SCENARIO": "migration-approve", "CREATOR_MIGRATED_UPDATE_EXECUTE": "true",
            "UPDATE_PROFILE_SHA256": C.PROFILE_SHA, "GITHUB_WORKSPACE": "/unit/workspace", "RUNNER_TEMP": "/unit/temp",
            "CONTROLLER_NODE": "/unit/node"}


def completed():
    report = {**M.FLAGS, "scenario": "migration-approve", "harnessSource": "a" * 40,
              "scenarioPassed": True, "normalReopenObserved": True}
    broker = {**report, "scope": "production-016-disposable-migration", "fixtureRelocked": True,
              "sessionWrapper": {"returnCode": 0, "deadlineExpired": False,
                                 "pipes": {k: {"eof": True, "truncated": False} for k in ("stdout", "stderr")}}}
    batch = {"policy": 1, "phase": "cleanup", "outcome": "complete", "review_key": "b" * 64, "retry_blocked": False}
    return broker, report, batch


def append_reads(journal, nonce):
    return {"revision": 1, "records": journal["records"] + [
        {"session": nonce * 64, "id": index, "command": command, "outcome": "returned-ok"}
        for index, command in ((3, "load_config"), (4, "discover_unity_projects"))]}


def native_report():
    report = {**U.FALSE, "scope": "continuous-migrated-home-private017-lifecycle-only",
              "beforeMigrationConnectionContinued": False, "privateTargetQualification": U.private_target_qualification(),
              "nativeActions": ["Update Hub"], "systemActions": ["Authenticate"], "automaticSuccessor": {"pid": 30},
              "mcpProtocol": T.mcp_receipt(), "initialBitmap": {"nonblank": True}, "successorBitmap": {"nonblank": True}}
    for name in ("initial16Verified", "nativeConfirmationObserved", "settingsPreserved", "runtimeSurvived", "normalFinalClose",
                 "oldNormalExit", "automaticRestartObserved", "installed17Verified", "fresh17UiVersion", "directPagesObserved",
                 "targetRetirementHelperVerified", "migrationEvidencePreserved", "homePreserved", "journalPrefixPreserved"):
        report[name] = True
    report["oldRetirementHelperRestored"] = U.private_target_qualification()["privateDebApprovalRestoresOldRetirementHelper"]
    for name in ("initialProjects", "successorProjects"):
        report[name] = {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}
    for name, version in (("htmlWebDriver", "0.1.16"), ("successorHtmlWebDriver", "0.1.17")):
        report[name] = {"probePassed": True, "inputCountAtProbe": 0, "detached": True,
                        "toolsClosedAfterRootExit": True, "documentVersion": version}
    return report


def broker_report():
    return {**U.FALSE, "nativePassed": True, "preservationPassed": True, "fixtureRelocked": True,
            "tlsCleanup": {"temporaryCertificateRemoved": True, "originalTrustRestored": True},
            "transportClosed": True, "sessionExit": 0, "privateTargetQualification": U.private_target_qualification()}


@contextmanager
def temp_home():
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
        home = Path(temporary).resolve()
        uid = home.stat().st_uid
        real_directory = C.directory
        if os.name == "nt":
            # Windows has no POSIX ownership/mode semantics. All byte/link/open
            # checks remain real; separate native-mode cases are not claimed.
            def directory(path, owner):
                info = path.lstat()
                U.require(path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode), "Canonical directory required")
                return {"dev": info.st_dev, "ino": info.st_ino, "uid": owner, "gid": owner, "mode": 0o700}
            stack.enter_context(patch.object(C, "directory", side_effect=directory))
        else:
            home.chmod(0o700)
            real_directory(home, uid)
        for name in ("config/.creator-hub-settings-backups/settings.bak", "config/settings.json",
                     "data/creator-hub/client-migrations-v1/metadata.json", "data/creator-hub/client-migrations-v1/log",
                     "data/creator-hub/client-migrations-v1/review.json", "data/creator-hub/client-migrations-v1/result.json",
                     "data/CreatorHub/convergence/move-v1.json", M.JOURNAL, "current-project/Assets/keep.txt"):
            path = home / name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.write_bytes(name.encode())
        yield home, uid


class SourceBindingTests(unittest.TestCase):
    def bound(self):
        stack = ExitStack()
        for key, value in (("OUTGOING_SOURCE", "f" * 40), ("PROFILE_SHA", "f" * 64)):
            stack.enter_context(patch.object(C, key, value))
        stack.enter_context(patch.dict(U.FIXED["17"], source=C.TARGET, tree=C.TARGET_TREE))
        return stack

    def test_exact_current_baseline_target_generation_and_qualified_harness(self):
        self.assertEqual(C.PRODUCT, "085131ba6f3050a795fd513139a34975658ba321")
        self.assertEqual(C.PRODUCT_TREE, "feccbd2ca251f75f95bca1730e458605f1b3558c")
        self.assertEqual(C.BASELINE_RUN, 40541756470)
        self.assertEqual(C.MIGRATION_PROFILE_SHA, "054116bc3f24876edf9bcc57c401d88faeb00482bced3d4fd8e7d91f72fc57b4")
        self.assertEqual(C.TARGET, "dce183ec0a0f23210d83b064c04ecc8b6af999fe")
        self.assertEqual(C.TARGET_TREE, "6d881eade5b3178913012d3a6c6632bd41b0e849")
        self.assertEqual(C.SUCCESSOR_GENERATION, "782895334a70092d5c8f456a7be1eb76fcdd72b40e502877bd52988bd84daca7")
        self.assertEqual(C.OUTGOING_SOURCE, "1ab093b6a46ad862bb3d22d982ed292793386353")
        self.assertEqual(C.PROFILE_SHA, "02aeb5653fcd0dde0576907b7f480b895ea8c3e509cf2954ad2944ee8ef78fcb")
        self.assertNotIn(C.OUTGOING_SOURCE, (C.PRODUCT, C.TARGET))
        C.require_bound_continuation()

    def test_unbound_refuses_before_context_reads_or_privilege(self):
        for action in (lambda: C.admission(environment()), lambda: C.profile(b"{}"),
                       lambda: C.prepare(environment()), lambda: C.broker(environment())):
            with self.subTest(action=action), patch.object(C, "OUTGOING_SOURCE", "UNBOUND"), \
                    patch.object(M, "admission") as migration, patch.object(U, "read") as read, \
                    patch.object(U, "save") as save, patch.object(C.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "binding is unbound"):
                    action()
                for mock in (migration, read, save, run):
                    mock.assert_not_called()

    def test_each_binding_and_exact_target_source_tree_required(self):
        with self.bound():
            C.require_bound_continuation()
            for key in ("OUTGOING_SOURCE", "PROFILE_SHA", "SUCCESSOR_GENERATION"):
                for value in (None, "", "UNBOUND", "0", 1):
                    with self.subTest(key=key, value=value), patch.object(C, key, value), self.assertRaises(RuntimeError):
                        C.require_bound_continuation()
            for key, value in (("source", "75a99ff4a267064aaa3ac9e30039bc91dc791d89"),
                               ("tree", "5f62bf4bc1ba85eb293ca9a5a30330b06b6b4351")):
                with self.subTest(key=key), patch.dict(U.FIXED["17"], {key: value}), self.assertRaises(RuntimeError):
                    C.require_bound_continuation()

    def test_profile_delegates_strict_validation_then_refuses_mixed_old_baseline(self):
        raw = b"unit-only"
        value = {"baseline": {"source": C.PRODUCT, "tree": C.PRODUCT_TREE, "run": C.BASELINE_RUN}}
        with self.bound(), patch.object(C, "PROFILE_SHA", U.pin(raw)["sha256"]), \
                patch.object(U, "parse", return_value={"unit": True}), patch.object(U, "validate_profile", return_value=value) as validate:
            self.assertIs(C.profile(raw), value)
            validate.assert_called_once_with({"unit": True}, "deb-approve")
            for key, old in (("source", "a89ed2b90278b33bebd0b4ba29d87904d2fe683b"),
                             ("tree", "0" * 40), ("run", 40403377032)):
                with self.subTest(key=key), patch.dict(value["baseline"], {key: old}), self.assertRaises(RuntimeError):
                    C.profile(raw)
            validate.side_effect = RuntimeError("shared signature/member/profile refusal")
            with self.assertRaisesRegex(RuntimeError, "shared signature/member/profile refusal"):
                C.profile(raw)


class SourceMenuTests(unittest.TestCase):
    def test_verified_phase_call_sites_bind_exact_source_and_image_before_html(self):
        tree = ast.parse(Path(C.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        text = ast.unparse(session)
        calls = [n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "U.bind_source_menu"]
        self.assertEqual([ast.unparse(n) for n in calls], [
            "U.bind_source_menu(surface, value['baseline']['source'], value['baseline']['hub'])",
            "U.bind_source_menu(replacement, U.FIXED['17']['source'], U.FIXED['17']['hub'])"])
        self.assertLess(text.index("old = U.phase_identity("), text.index("U.bind_source_menu(surface,"))
        self.assertLess(text.index("U.bind_source_menu(surface,"), text.index("html = U.HtmlPages("))
        self.assertLess(text.index("U.observe_successor("), text.index("U.bind_source_menu(replacement,"))
        self.assertLess(text.index("U.bind_source_menu(replacement,"), text.index("replacement_html = U.HtmlPages("))

    def test_real_menu_helpers_keep_current_and_historical_source_families_exact(self):
        fixtures = T.LiveSourceMenuWiring
        current = {"hub": "Home Projects and updates", "mcp": "MCP AI bridge for Unity",
                   "setup": "Setup / Repair Unity + Creator SDK project setup and repair"}
        for source in (C.PRODUCT, C.TARGET, *U.HISTORICAL_MENU_SOURCES):
            with self.subTest(source=source):
                surface = fixtures.surface(source, bound=False)
                U.bind_source_menu(surface, source, {"size": 11, "sha256": "a" * 64})
                menu = U.bound_source_menu(surface)
                self.assertEqual(menu["source"], source)
                self.assertEqual(menu["ready"], current if source in (C.PRODUCT, C.TARGET) else fixtures.OLD_READY)
                with patch.object(U, "phase_processes"), patch.object(U, "feature_ready", side_effect=fixtures.ready):
                    self.assertTrue(U.direct_pages(surface, []))
                    U.navigate_home(surface)
                self.assertEqual(surface.presses, ["navigation-mcp", "navigation-setup", "navigation-home"])

    def test_real_menu_helper_refuses_unknown_source_wrong_image_and_wrong_labels(self):
        fixtures = T.LiveSourceMenuWiring
        for source, pin in (("f" * 40, {"size": 11, "sha256": "a" * 64}),
                            ("0.1.16", {"size": 11, "sha256": "a" * 64}),
                            (C.PRODUCT, {"size": 12, "sha256": "a" * 64}),
                            (C.TARGET, {"size": 11, "sha256": "b" * 64})):
            surface = fixtures.surface(C.PRODUCT, bound=False)
            with self.subTest(source=source, pin=pin), self.assertRaises(RuntimeError):
                U.bind_source_menu(surface, source, pin)
            self.assertFalse(hasattr(surface, "menu_binding"))
            self.assertEqual(surface.inputs, [])
        for source in (C.PRODUCT, C.TARGET):
            surface = fixtures.surface(source, labels=fixtures.OLD_READY, bound=False)
            U.bind_source_menu(surface, source, {"size": 11, "sha256": "a" * 64})
            with self.subTest(source=source), self.assertRaisesRegex(RuntimeError, "One exact Home"):
                U.navigate_home(surface)
            self.assertEqual(surface.presses, [])


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        # Synthetic authority only inside these existing execution-context cases.
        binding = SourceBindingTests().bound()
        binding.__enter__()
        self.addCleanup(binding.close)

    def admit(self, env):
        with patch.object(M.sys, "platform", "linux"), patch.object(M.os, "getuid", return_value=1001, create=True):
            C.admission(env)

    def test_actual_migration_context_and_explicit_second_optin(self):
        env = environment(); before = dict(env); self.admit(env); self.assertEqual(env, before)
        with self.assertRaises(RuntimeError): U.admission(env, system="linux", machine="x86_64")
        with self.assertRaises(RuntimeError): self.admit({**env, "GITHUB_REF": U.BRANCH, "GITHUB_WORKFLOW_REF": U.WORKFLOW})

    def test_missing_wrong_context_or_approval_refused(self):
        for key in ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CREATOR_MIGRATED_UPDATE_EXECUTE",
                    "CREATOR_MIGRATION_016_EXECUTE", "CREATOR_MIGRATION_016_SCENARIO", "UPDATE_EXECUTE", "UPDATE_SCENARIO", "UPDATE_PROFILE_SHA256"):
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.admit({**environment(), key: ""})

    def test_injection_refused_even_empty(self):
        for key in ("HTTPS_PROXY", "LD_PRELOAD", "TAURI_TEST", "PYTHONPATH", "NODE_OPTIONS", "SSL_CERT_FILE", "CREATOR_HUB_SIGNING_KEY_PATH"):
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.admit({**environment(), key: ""})

    def test_children_keep_real_workflow_and_home_without_inheriting_extra_env(self):
        env = {**environment(), "UNREVIEWED": "private"}
        for child in (C.child_environment(env), C.transport_environment(env)):
            self.assertEqual(child["GITHUB_WORKFLOW_REF"], M.WORKFLOW)
            self.assertEqual(child["GITHUB_REF"], M.BRANCH)
            self.assertNotIn("UNREVIEWED", child)
        command = C.session_command(env)
        self.assertIn("--uid=" + M.USER, command)
        self.assertIn("--property=PAMName=login", command)
        self.assertEqual(command[-2:], [str(C.CONTROL / "scripts/native-linux-migrated-update.py"), "session"])
        self.assertNotIn("useradd", " ".join(command))
        self.assertEqual(C.transport_environment(env)["HOME"], str(C.HOME))

    def test_context_binds_boot_run_attempt_source_and_both_profiles(self):
        before = C.context(environment(), "unit-boot")
        for key in ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_REF"):
            self.assertNotEqual(before, C.context({**environment(), key: "changed"}, "unit-boot"))
        self.assertNotEqual(before, C.context(environment(), "other-boot"))
        self.assertEqual(before["product"], C.PRODUCT)
        self.assertEqual(before["migrationProfile"], C.MIGRATION_PROFILE_SHA)
        self.assertEqual(before["outgoingProfile"], C.PROFILE_SHA)

    def test_intent_rechecks_every_actual_source_and_refuses_drift(self):
        pins = {name: U.pin(U.read(HERE / name, 2 * 1024**2)) for name in C.sources()}
        value = {"schemaVersion": 1, "context": C.context(environment(), "boot"), "sources": pins}
        real_read = U.read
        def read(file, *args, **kwargs):
            return json.dumps(value).encode() if file == C.INTENT else real_read(file, *args, **kwargs)
        with patch.object(C, "admission"), patch.object(C, "boot_id", return_value="boot"), patch.object(U, "read", side_effect=read):
            self.assertEqual(C.intent(environment()), value)
            for name in ("native-linux-migrated-update.py", "native-linux-production-016-update.py", "native-linux-production-016-migration.py"):
                with self.subTest(source=name):
                    original = value["sources"][name]["sha256"]
                    value["sources"][name]["sha256"] = "0" * 64
                    with self.assertRaisesRegex(RuntimeError, "Independent bytes differ"): C.intent(environment())
                    value["sources"][name]["sha256"] = original


class MigrationGateTests(unittest.TestCase):
    def test_only_complete_cleanup_after_normal_reopen_and_relock(self):
        C.migration_gate(*completed())

    def test_incomplete_failed_unknown_or_retry_blocked_refused(self):
        for group, key, value in ((0, "scenarioPassed", False), (0, "fixtureRelocked", False), (1, "normalReopenObserved", False),
                                  (1, "harnessSource", "c" * 40), (2, "outcome", "started"), (2, "phase", "connections"),
                                  (2, "retry_blocked", True), (2, "retry_blocked", 0), (2, "review_key", ""), (2, "policy", True)):
            values = completed(); values[group][key] = value
            with self.subTest(group=group, key=key), self.assertRaises(RuntimeError): C.migration_gate(*values)
        for name in ("refusal", "recovery", "relockRefusal", "captureRefused", "disposableTeardownRequired"):
            for group in (0, 1):
                values = completed(); values[group][name] = False
                with self.assertRaises(RuntimeError): C.migration_gate(*values)

    def test_missing_extra_batch_fields_and_claim_promotions_refused(self):
        for name in completed()[2]:
            values = completed(); del values[2][name]
            with self.assertRaises(RuntimeError): C.migration_gate(*values)
        values = completed(); values[2]["extra"] = True
        with self.assertRaises(RuntimeError): C.migration_gate(*values)
        for name in M.FLAGS:
            values = completed(); values[1][name] = True
            with self.assertRaises(RuntimeError): C.migration_gate(*values)

    def test_normal_wrapper_and_complete_pipes_required(self):
        for key, value in (("returnCode", None), ("returnCode", False), ("returnCode", 1), ("deadlineExpired", True)):
            values = completed(); values[0]["sessionWrapper"][key] = value
            with self.assertRaises(RuntimeError): C.migration_gate(*values)
        for stream in ("stdout", "stderr"):
            for key, value in (("eof", False), ("truncated", True)):
                values = completed(); values[0]["sessionWrapper"]["pipes"][stream][key] = value
                with self.assertRaises(RuntimeError): C.migration_gate(*values)


class PreservationTests(unittest.TestCase):
    def test_full_temp_snapshot_includes_backups_history_and_projects(self):
        with temp_home() as (home, uid):
            before = C.tree(home, uid)
            for suffix in ("metadata.json", "log", "review.json", "result.json"):
                self.assertIn("data/creator-hub/client-migrations-v1/" + suffix, before)
            self.assertIn("config/.creator-hub-settings-backups/settings.bak", before)
            self.assertIn("current-project/Assets/keep.txt", before)
            C.compare_tree(before, C.tree(home, uid))

    def test_change_deletion_or_same_bytes_new_inode_refused(self):
        for operation in ("change", "delete", "replace"):
            with self.subTest(operation=operation), temp_home() as (home, uid):
                before = C.tree(home, uid); path = home / "config/settings.json"
                if operation == "change": path.write_bytes(b"changed")
                if operation == "delete": path.unlink()
                if operation == "replace":
                    other = home / "config/new"; other.write_bytes(path.read_bytes()); os.replace(other, path)
                with self.assertRaises(RuntimeError): C.compare_tree(before, C.tree(home, uid))

    def test_only_cache_additions_allowed_never_new_backups(self):
        for name, accepted in (("cache/item", True), ("data/creator-hub-update-cache/item", True),
                               ("config/new", False), ("cache/new.bak", False), ("cache/backup.json", False)):
            with self.subTest(name=name), temp_home() as (home, uid):
                before = C.tree(home, uid); path = home / name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.write_bytes(b"new")
                if accepted: C.compare_tree(before, C.tree(home, uid))
                else:
                    with self.assertRaises(RuntimeError): C.compare_tree(before, C.tree(home, uid))

    def test_hardlink_refused(self):
        with temp_home() as (home, uid):
            os.link(home / "config/settings.json", home / "alias")
            with self.assertRaises(RuntimeError): C.tree(home, uid)

    def test_symlink_refused_when_host_supports_it(self):
        with temp_home() as (home, uid):
            try: (home / "alias").symlink_to(home / "config/settings.json")
            except OSError as error: self.skipTest("Symlink creation unavailable: " + str(error.winerror if hasattr(error, "winerror") else error.errno))
            with self.assertRaises(RuntimeError): C.tree(home, uid)

    def test_entry_and_total_byte_bounds_refuse(self):
        with temp_home() as (home, uid):
            for name, value in (("MAX_ENTRIES", 2), ("MAX_TOTAL", 1)):
                with patch.object(C, name, value), self.assertRaises(RuntimeError): C.tree(home, uid)

    def test_journal_only_exception_does_not_allow_owner_or_device_change(self):
        with temp_home() as (home, uid):
            before = C.tree(home, uid); after = copy.deepcopy(before)
            after[M.JOURNAL].update(size=42, sha256="a" * 64, ino=123)
            C.compare_tree(before, after, journal=M.JOURNAL)
            for key in ("uid", "gid", "dev", "mode", "kind"):
                altered = copy.deepcopy(after); altered[M.JOURNAL][key] = "changed"
                with self.assertRaises(RuntimeError): C.compare_tree(before, altered, journal=M.JOURNAL)

    def test_exact_two_new_read_pairs_preserve_prefix(self):
        before = append_reads({"revision": 1, "records": []}, "a")
        after = append_reads(append_reads(before, "b"), "c")
        self.assertEqual(C.final_journal(before, after), after)
        for mutation in (lambda x: x["records"][0].update(outcome="changed"), lambda x: x["records"].pop(),
                         lambda x: x["records"][-1].update(id=5), lambda x: x["records"][-1].update(command="save_config"),
                         lambda x: x["records"][-1].update(outcome="accepted"), lambda x: x["records"][-1].update(session="b" * 64)):
            value = copy.deepcopy(after); mutation(value)
            with self.assertRaises(RuntimeError): C.final_journal(before, value)


class StagingTests(unittest.TestCase):
    @contextmanager
    def reviewed(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            folder = Path(temporary).resolve(); value = T.profile(); old, new, baseline = T.compared_packages()
            value["baseline"] = baseline
            receipt = {"hubVersion": "0.1.16", "assemblyCommit": baseline["source"], "compiledFeatures": U.FEATURES,
                       "portableHostBuild": {"sourceCommit": baseline["source"], "sourceTree": baseline["tree"], "compiledFeatures": U.FEATURES, "rawHub": baseline["raw"]},
                       "productionMigration": {"sourceCommit": baseline["source"], "sourceTree": baseline["tree"], "compiledFeatures": U.FEATURES, "rawHub": baseline["raw"]},
                       "privateModulesRecompiled": False, "privateModulesResigned": False, "releaseReady": False}
            descriptor = {"appId": "creator-hub", "version": "0.1.17", "platform": "linux", "architecture": "x86_64", "packageType": "deb",
                          "assetName": "Creator_Hub_0.1.17_amd64-acceptance-only.deb", "byteLength": U.FIXED["17"]["deb"]["size"],
                          "sha256": U.FIXED["17"]["deb"]["sha256"], "executableSha256": U.FIXED["17"]["hub"]["sha256"]}
            latest = {"version": "0.1.17", "platforms": {"linux-x86_64-deb": {
                "signature": base64.b64encode(b"untrusted comment: unit signature").decode(),
                "url": "https://github.com/" + U.REPO + "/releases/download/v0.1.17/" + descriptor["assetName"]}}}
            for name in value["objects"]:
                path = U.object_path(folder, value, name); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"unit bytes")
            for name, obj in (("debDescriptor17", descriptor), ("assemblyReceipt16", receipt), ("latest17", latest)):
                U.object_path(folder, value, name).write_text(json.dumps(obj))
            original_load = U.load
            shared = original_load("private-linux-update-fixture-017-package-verify")
            package = SimpleNamespace(base_reader=lambda: SimpleNamespace(verify=Mock()), inspect=Mock(side_effect=[old, new]),
                                      validate_expected=shared.validate_expected, baseline_members=shared.baseline_members,
                                      LIMIT=shared.LIMIT, ARCHIVE=shared.ARCHIVE)
            marker = Mock()
            def load(name):
                if name == "private-linux-update-fixture-017-package-verify": return package
                if name == "native-linux-root-probe": return SimpleNamespace(verify_deb_marker=marker)
                return original_load(name)
            stack.enter_context(patch.object(U, "load", side_effect=load))
            stack.enter_context(patch.object(U, "packaged_root", return_value=b"unit ELF"))
            signatures = stack.enter_context(patch.object(U, "signature"))
            resources = stack.enter_context(patch.object(U, "baseline_mcp_inputs"))
            yield SimpleNamespace(folder=folder, value=value, signatures=signatures, resources=resources, marker=marker)

    def test_shared_review_retains_all_packages_resources_and_markers(self):
        with self.reviewed() as f:
            review = U.review_staged_packages(f.folder, f.value, "unit-verifier", "deb-approve")
            self.assertTrue(review["signaturesVerified"])
            self.assertEqual(review["privateTargetQualification"], U.private_target_qualification())
            f.signatures.assert_called_once_with(U.object_path(f.folder, f.value, "debDescriptor17"), U.object_path(f.folder, f.value, "debSignature17"), "unit-verifier")
            f.resources.assert_called_once(); self.assertEqual(f.marker.call_count, 2)

    def test_shared_review_refuses_route_descriptor_compile_or_signature_gap(self):
        for object_name, mutate in (("debDescriptor17", lambda x: x.update(assetName="other.deb")),
                                    ("latest17", lambda x: x["platforms"]["linux-x86_64-deb"].update(url="https://foreign/installer")),
                                    ("assemblyReceipt16", lambda x: x.update(privateModulesResigned=True)),
                                    ("assemblyReceipt16", lambda x: x["productionMigration"].update(sourceCommit="f" * 40))):
            with self.subTest(object=object_name), self.reviewed() as f:
                path = U.object_path(f.folder, f.value, object_name); value = json.loads(path.read_bytes()); mutate(value); path.write_text(json.dumps(value))
                with self.assertRaises(RuntimeError): U.review_staged_packages(f.folder, f.value, "unit-verifier", "deb-approve")
        with self.reviewed() as f:
            f.signatures.side_effect = RuntimeError("signature refused")
            with self.assertRaisesRegex(RuntimeError, "signature refused"): U.review_staged_packages(f.folder, f.value, "unit-verifier", "deb-approve")

    def test_both_callers_use_the_same_review_without_copy(self):
        for path, name in ((HERE / "native-linux-production-016-update.py", "stage"), (HERE / "native-linux-migrated-update.py", "verify_inputs")):
            tree = ast.parse(path.read_text()); fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            calls = [ast.unparse(n.func).split(".")[-1] for n in ast.walk(fn) if isinstance(n, ast.Call)]
            self.assertEqual(calls.count("review_staged_packages"), 1)
            self.assertNotIn("compare_update_packages", calls)
            self.assertIn("stage_zip", calls)


class OutcomeTests(unittest.TestCase):
    def test_installed_target_helper_disclosure_comes_from_the_review_not_old_source75(self):
        tree = ast.parse(Path(C.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        assignment = next(n for n in ast.walk(session) if isinstance(n, ast.Assign)
                          and any(ast.unparse(t) == "report['oldRetirementHelperRestored']" for t in n.targets))
        for restored in (False, True):
            report = {}
            reviewed = {"privateTargetQualification": {"privateDebApprovalRestoresOldRetirementHelper": restored}}
            exec(compile(ast.Module(body=[assignment], type_ignores=[]), "unit-helper-disclosure", "exec"),
                 {"report": report, "reviewed": reviewed})
            self.assertIs(report["oldRetirementHelperRestored"], restored)
        text = ast.unparse(session)
        self.assertLess(text.index("U.verify_installed(reviewed, '17')"), text.index(ast.unparse(assignment)))

    def test_native_scoped_success_requires_all_original_update_proofs(self):
        report = native_report(); self.assertTrue(C.continuation_outcome(report))
        for name in ("settingsPreserved", "runtimeSurvived", "normalFinalClose", "migrationEvidencePreserved", "homePreserved", "journalPrefixPreserved"):
            with self.subTest(name=name), self.assertRaises(RuntimeError): C.continuation_outcome({**report, name: False})
        for name, value in (("systemActions", ["Authenticate", "Authenticate"]), ("nativeActions", []), ("beforeMigrationConnectionContinued", True),
                            ("releaseReady", True), ("mcpProtocol", {}), ("successorProjects", {}),
                            ("targetRetirementHelperVerified", False),
                            ("oldRetirementHelperRestored", not report["oldRetirementHelperRestored"])):
            with self.subTest(name=name), self.assertRaises(RuntimeError): C.continuation_outcome({**report, name: value})

    def test_broker_requires_complete_cleanup_without_masking_original_failure(self):
        record = broker_report(); self.assertTrue(C.broker_outcome(record))
        for name, value in (("nativePassed", False), ("preservationPassed", False), ("fixtureRelocked", False),
                            ("tlsCleanup", None), ("transportClosed", False), ("sessionExit", None), ("sessionExit", False),
                            ("refusal", {}), ("cleanupRefused", False), ("recovery", "unknown"), ("releaseReady", True)):
            with self.subTest(name=name), self.assertRaises(RuntimeError): C.broker_outcome({**record, name: value})

    def test_controller_never_reseeds_reinstalls_or_manually_starts_successor(self):
        tree = ast.parse((HERE / "native-linux-migrated-update.py").read_text())
        calls = [ast.unparse(n.func).split(".")[-1] for n in ast.walk(tree) if isinstance(n, ast.Call)]
        self.assertFalse(set(calls) & {"fixtures", "fixture", "create_account", "prepare_existing_route", "bootstrap16", "kill", "killpg"})
        native = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        launches = [n for n in ast.walk(native) if isinstance(n, ast.Call) and ast.unparse(n.func) == "subprocess.Popen"]
        self.assertEqual(sum("/usr/bin/creator-hub" in ast.unparse(n.args[0]) for n in launches), 1)
        self.assertEqual(sum(isinstance(n, ast.Call) and ast.unparse(n.func) == "U.observe_successor" for n in ast.walk(native)), 1)
        self.assertIn("BoundRoute", calls)


class TransitionCompositionTests(unittest.TestCase):
    def setUp(self):
        # Reuse V4's real temporary-file reads; do not stub its receipt validator.
        self.fixture = T.TransitionConsumerTests(methodName="runTest")
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        self.binding = patch.object(C, "U", T.M)
        self.binding.start(); self.addCleanup(self.binding.stop)

    def report(self):
        value = native_report()
        value["mcpProtocol"] = copy.deepcopy(self.fixture.value)
        return value

    def compose(self, report):
        return C.transition_continuation_outcome(report, self.fixture.inventories, None, self.fixture.paths)

    def test_legitimate_a_b_fixture_requires_new_composer_and_old_still_refuses(self):
        report = self.report()
        with self.assertRaisesRegex(RuntimeError, "Complete MCP preservation receipt required"):
            C.continuation_outcome(report)
        self.assertTrue(self.compose(report))
        self.assertEqual(report["mcpProtocol"], self.fixture.value)
        self.assertFalse(report["beforeMigrationConnectionContinued"])
        self.assertFalse(report["mcpProtocol"]["payloadSwapAccepted"])

    def test_transition_composer_retains_each_migration_check(self):
        changes = [("scope", "foreign"), ("beforeMigrationConnectionContinued", True),
                   ("migrationEvidencePreserved", False), ("homePreserved", False), ("journalPrefixPreserved", False)]
        for phase in ("initialProjects", "successorProjects"):
            for key, bad in (("projectsObserved", False), ("termsReaccepted", True), ("migrationReplayed", True)):
                changes.append((phase, {**self.report()[phase], key: bad}))
        for name, bad in changes:
            with self.subTest(name=name, value=bad):
                report = self.report(); report[name] = bad
                with self.assertRaisesRegex(RuntimeError, "Complete migrated-HOME continuation evidence required"):
                    self.compose(report)

    def test_transition_composer_cannot_skip_root_evidence(self):
        report = self.report(); report["settingsPreserved"] = False
        with self.assertRaisesRegex(RuntimeError, "Full initial/consent/preservation/close proof required"):
            self.compose(report)

    def test_transition_composer_rechecks_actual_completed_not_success_booleans(self):
        f = self.fixture
        f.put(f.record, f.encode({**f.completed, "phase": {"Attempting": f.target("b")}}))
        with self.assertRaises(RuntimeError): self.compose(self.report())

    def test_transition_composer_rechecks_installed_b_not_success_booleans(self):
        f = self.fixture
        f.put(f.b_descriptor / "runtime.minisig", b"changed after wrapper guard")
        with self.assertRaises(RuntimeError): self.compose(self.report())

    def test_migration_statement_hash_and_session_broker_remain_unwired(self):
        tree = ast.parse(Path(C.__file__).read_text())
        functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        def digest(nodes):
            return hashlib.sha256(ast.dump(ast.Module(body=nodes, type_ignores=[]), include_attributes=False).encode()).hexdigest()
        self.assertEqual(digest(functions["_continuation_checks"].body), "41c46e5056ea2ea35a863b8c616ce0a93f8eabbbcf31eb96b12ca6999371262f")
        self.assertEqual([ast.unparse(n) for n in functions["continuation_outcome"].body], [
            "U.outcome('deb-approve', report)", "_continuation_checks(report)", "return True"])
        self.assertEqual([ast.unparse(n) for n in functions["transition_continuation_outcome"].body], [
            "U.transition_outcome(report, inventories, verifier, protected_paths)", "_continuation_checks(report)", "return True"])
        for name, expected in {"native_session": "668324417896fae68b96cb399e2b8a44f6038bbf13a3958702f9b61b17a428b7",
            "broker": "254824158ff3b04595c879e1a89600795a5e647f073daeb410fd0015868751b0",
            "main": "14e5672d720e9629731549ced856680b7724a70d3c827e8554829dff871645a9",
            "admission": "d66104f08132ae0df06d1b49a0c1e239961f42fad2acfee66a0febc5c171b107"}.items():
            self.assertEqual(digest([historical_wm_inverse(functions[name]) if name == "native_session" else functions[name]]), expected, name)


class SuccessorStateTests(unittest.TestCase):
    def manifest(self):
        files = {"mcp/server/creator-works-mcp.mjs": b"unit MCP", "mcp/server/runtime/node": b"unit node"}
        entry = {"executable": "mcp/server/runtime/node", "version": "2.7.7", "files": {k: U.pin(v)["sha256"] for k, v in sorted(files.items())}}
        manifest = {"schemaVersion": 1, "platform": "linux", "arch": "x86_64", "modules": {"mcp": entry, "setup": {"files": {}}},
                    "managedRouting": {"files": {}}, "payloadArchive": {"schemaVersion": 1, "file": "modules.tar.gz",
                        "files": {name: {"size": len(body), "mode": 0o755 if name.endswith("node") else 0o644} for name, body in files.items()},
                        "unpackedSize": sum(map(len, files.values()))}}
        generation = hashlib.sha256(json.dumps(entry, separators=(",", ":")).encode()).hexdigest()
        return manifest, files, generation

    def test_complete_existing_generation_is_retained_with_original_inodes(self):
        manifest, _, generation = self.manifest()
        with patch.object(C, "SUCCESSOR_GENERATION", generation):
            expected = C.generation_entries(manifest)
            before = {".": {"dev": 1, "ino": 2}, "original-backup": {"sha256": "a" * 64},
                      **{name: {**row, "dev": 1, "ino": i + 10, "uid": M.UID, "gid": M.UID}
                         for i, (name, row) in enumerate(expected.items())}}
            original = copy.deepcopy(before)
            C.retained_generation(before, expected)
            self.assertEqual(before, original)
            changed = copy.deepcopy(before)
            changed[next(name for name in expected if name.endswith("node"))]["ino"] += 100
            with self.assertRaisesRegex(RuntimeError, "Original protected bytes/identity changed"):
                C.compare_tree(before, changed, generation=expected, require_generation=True)

    def test_retained_generation_refuses_absence_partial_extra_or_wrong_bytes_owner_mode(self):
        manifest, _, generation = self.manifest()
        with patch.object(C, "SUCCESSOR_GENERATION", generation):
            expected = C.generation_entries(manifest)
            before = {".": {"dev": 1, "ino": 2},
                      **{name: {**row, "dev": 1, "ino": i + 10, "uid": M.UID, "gid": M.UID}
                         for i, (name, row) in enumerate(expected.items())}}
            prefix = C.GENERATION_PARENT + generation
            for value in ({".": before["."]}, {k: v for k, v in before.items() if k != prefix},
                          {**before, prefix + "/unreviewed": {}}):
                with self.subTest(entries=list(value)), self.assertRaises(RuntimeError):
                    C.retained_generation(value, expected)
            for name in expected:
                for key, bad in (("mode", 0o777), ("uid", 0), ("dev", 2), ("sha256", "0" * 64)):
                    if key not in before[name]:
                        continue
                    value = copy.deepcopy(before)
                    value[name][key] = bad
                    with self.subTest(name=name, key=key), self.assertRaises(RuntimeError):
                        C.retained_generation(value, expected)
        session = ast.unparse(next(n for n in ast.parse(Path(C.__file__).read_text()).body
                                  if isinstance(n, ast.FunctionDef) and n.name == "broker"))
        call = "retained_generation(sealed['home'], sealed['successorGeneration'])"
        self.assertEqual(session.count(call), 1)
        self.assertLess(session.index(call), session.index("U.verify_installed("))
        self.assertLess(session.index(call), session.index("U.prepare_tls("))

    def test_exact_successor_manifest_generation_and_contents_only(self):
        manifest, files, generation = self.manifest()
        with patch.object(C, "SUCCESSOR_GENERATION", generation):
            allowed = C.generation_entries(manifest); prefix = C.GENERATION_PARENT + generation
            before = {".": {"dev": 1, "ino": 2}, "old-backup": {"sha256": "a" * 64}}
            after = {**before, **{name: {**expected, "dev": 1, "ino": i + 10, "uid": M.UID, "gid": M.UID} for i, (name, expected) in enumerate(allowed.items())}}
            C.compare_tree(before, before, generation=allowed)
            C.compare_tree(before, after, generation=allowed, require_generation=True)
            for name in allowed:
                incomplete = copy.deepcopy(after); incomplete.pop(name)
                with self.subTest(missing=name), self.assertRaises(RuntimeError): C.compare_tree(before, incomplete, generation=allowed, require_generation=True)
            for name, key, value in ((prefix, "mode", 0o777), (prefix + "/mcp/server/runtime/node", "sha256", "a" * 64),
                                     (prefix + "/mcp/server/runtime/node", "uid", 0), (prefix + "/mcp/server/runtime/node", "mode", 0o644),
                                     ("old-backup", "sha256", "b" * 64)):
                changed = copy.deepcopy(after); changed[name][key] = value
                with self.assertRaises(RuntimeError): C.compare_tree(before, changed, generation=allowed)
            for extra in (prefix + "/extra", C.GENERATION_PARENT + "0" * 64, C.GENERATION_PARENT + ".staging-unit"):
                with self.assertRaises(RuntimeError): C.compare_tree(before, {**after, extra: {}}, generation=allowed)
        with self.assertRaisesRegex(RuntimeError, "Unreviewed successor"): C.generation_entries(manifest)

    def test_generation_is_bound_to_pinned_embedded_manifest_archive_and_package(self):
        manifest, files, generation = self.manifest()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, body in files.items():
                item = tarfile.TarInfo(name); item.size = len(body); item.mode = manifest["payloadArchive"]["files"][name]["mode"]
                archive.addfile(item, io.BytesIO(body))
        archive = gzip.compress(buffer.getvalue(), mtime=0); archive_pin = U.pin(archive)
        manifest["payloadArchive"].update(archive_pin)
        raw = json.dumps(manifest).encode(); root_body = b"unit ELF" + raw
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary).resolve(); root = folder / "members/assembly17/payload"; root.mkdir(parents=True)
            for name, body in (("builtin-manifest.json", raw), ("modules.tar.gz", archive), ("creator-hub", root_body)):
                (root / name).write_bytes(body)
            profile = {"objects": {"raw17": {"artifact": "assembly17", "member": "payload/creator-hub"}},
                       "artifacts": {"assembly17": {"files": {"payload/builtin-manifest.json": U.pin(raw), "payload/modules.tar.gz": archive_pin}}}}
            packages = {"usr/lib/Creator Hub/modules.tar.gz": archive_pin}
            fixed = {**U.FIXED, "17": {**U.FIXED["17"], "raw": U.pin(root_body), "archive": archive_pin}}
            with patch.object(U, "FIXED", fixed), patch.object(C, "SUCCESSOR_GENERATION", generation):
                self.assertEqual(C.successor_generation(folder, profile, packages), C.generation_entries(manifest))
                with self.assertRaises(RuntimeError): C.successor_generation(folder, profile, {"usr/lib/Creator Hub/modules.tar.gz": U.pin(b"different")})
                (root / "modules.tar.gz").write_bytes(archive + b"changed")
                with self.assertRaises(RuntimeError): C.successor_generation(folder, profile, packages)

    def test_existing_cache_mutation_still_refused(self):
        before = {".": {"dev": 1}, "cache/existing": {"sha256": "a" * 64}}
        with self.assertRaises(RuntimeError): C.compare_tree(before, {**before, "cache/existing": {"sha256": "b" * 64}})

    def test_exact_false_preference_consent_never_changes_preference(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); path = home / U.PREFS; path.parent.mkdir(parents=True)
            raw = b'{"restoreHostedViews":false,"preserved":"unit"}'; path.write_bytes(raw)
            self.assertEqual(C.update_question(home), "Update Creator Hub to 0.1.17?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."
                "\n\nHub will close these idle views: Creator Project Setup. Unsaved form entries will be discarded. "
                "Automatic reopening is turned off. You can open them again from Hub. Standalone apps and MCP connections will stay open.")
            self.assertEqual(path.read_bytes(), raw)
            self.assertIn("They will reopen after Hub restarts.", U.question(False))
            for value in (True, None, 0, "false"):
                path.write_text(json.dumps({"restoreHostedViews": value}))
                with self.assertRaises(RuntimeError): C.update_question(home)


class InterfaceTests(unittest.TestCase):
    def test_real_tls_helper_filters_context_before_any_mutation(self):
        env = {**environment(), "UNREVIEWED": "not-forwarded"}
        real_context = U.clean_context
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                contexts = []
                def capture(values, **kwargs):
                    context = real_context(values, **kwargs)
                    contexts.append(context)
                    return context
                with patch.object(U, "clean_context", side_effect=capture), \
                     patch.object(Path, "mkdir", side_effect=RuntimeError("unit boundary before TLS files")) as mkdir:
                    with self.assertRaisesRegex(RuntimeError, "unit boundary before TLS files"):
                        U.prepare_tls(env, migrated=migrated)
                expected = C.child_environment(env) if migrated else {
                    **{key: env[key] for key in U.ENVIRONMENT}, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
                self.assertEqual(contexts, [expected])
                mkdir.assert_called_once_with(mode=0o700)
                self.assertNotIn("UNREVIEWED", contexts[0])
                self.assertEqual(contexts[0]["GITHUB_WORKFLOW_REF"], M.WORKFLOW)

    def test_real_transport_helper_admits_context_without_cross_import_or_child(self):
        env = {**environment(), "UNREVIEWED": "not-forwarded"}
        root = Path("/unit/transport")
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                with patch.object(U, "PipeChild", side_effect=RuntimeError("unit boundary before process creation")) as child:
                    with self.assertRaisesRegex(RuntimeError, "unit boundary before process creation"):
                        U.start_transport(env, root, "deb", {}, migrated=migrated)
                control, _ = U.update_channel(migrated)
                operation = "update-migrated-016-017" if migrated else "update-016-017"
                expected = C.transport_environment(env) if migrated else {
                    **{key: env[key] for key in U.ENVIRONMENT}, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
                    "RUNNER_TEMP": str(U.BASE / "result"), "HOME": str(U.BASE / "result/home")}
                child.assert_called_once_with([env["CONTROLLER_NODE"], str(control / "scripts/linux-update-lab-feed.cjs"),
                    operation, "deb", str(root)], expected, "transport", synthetic=True)
                self.assertNotIn("UNREVIEWED", expected)
                self.assertEqual(expected["GITHUB_REF"], M.BRANCH)
        for name in ("native-linux-migrated-update", "../native-linux-migrated-update"):
            with self.assertRaisesRegex(RuntimeError, "Only reviewed neutral source"):
                U.load(name)
        self.assertTrue({"native-linux-production-016-update.py", "native-linux-production-016-migration.py"}
                        <= set(U.SOURCES) <= set(C.sources()))

    def test_legacy_paths_unchanged_and_unknown_channels_refused(self):
        self.assertEqual(U.update_channel(), (U.BASE, U.BASE / "result"))
        self.assertEqual(M.inventory_paths(), (M.BASE, M.BASE / "result"))
        self.assertEqual(U.update_channel(True), M.inventory_paths("migrated-update"))
        for value in (1, "true", None, {}):
            with self.assertRaises(RuntimeError): U.update_channel(value)
        for value in ("other", "../result", 1):
            with self.assertRaises(RuntimeError): M.inventory_paths(value)

    def test_inventory_new_channel_requires_update_approval_not_other_scenarios(self):
        M.InventoryClient("a" * 40, "deb-approve", cohort="update", channel="migrated-update")
        for cohort, scenario in (("migration", "migration-approve"), ("update", "deb-auth-cancel"), ("update", "portable-approve")):
            with self.assertRaises(RuntimeError): M.InventoryClient("a" * 40, scenario, cohort=cohort, channel="migrated-update")

    def test_continuation_inventory_roundtrip_never_reuses_old_mailboxes(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            base = Path(temporary).resolve(); control, result = base / "migrated-update", base / "result/migrated-update"
            control.mkdir(); result.mkdir(parents=True)
            old = base / "inventory-response-1.json"; old.write_bytes(b"original evidence")
            actor = [M.UID]
            stack.enter_context(patch.object(M, "BASE", base))
            stack.enter_context(patch.multiple(M.os, getuid=lambda: actor[0], geteuid=lambda: actor[0], create=True))
            stack.enter_context(patch.object(M, "inventory_channel"))
            stack.enter_context(patch.object(M, "native_process_inventory", return_value={"processes": [], "terminalProcesses": []}))
            real_read = M.read_file
            stack.enter_context(patch.object(M, "read_file", side_effect=lambda path, limit, **kwargs: real_read(path, limit)))
            state, record = {"sequence": 1, "nonces": set()}, {}
            def wait(predicate):
                actor[0] = 0
                try: M.serve_inventory(state, record, "a" * 40, "deb-approve", None, None, cohort="update", channel="migrated-update")
                finally: actor[0] = M.UID
                self.assertTrue(predicate())
            client = M.InventoryClient("a" * 40, "deb-approve", cohort="update", channel="migrated-update")
            self.assertTrue(client.sample(wait)["ok"])
            self.assertEqual(old.read_bytes(), b"original evidence")
            self.assertTrue((control / "inventory-response-1.json").exists())
            self.assertTrue((result / "inventory-request-1.json").exists())
            client.sequence = 1
            with self.assertRaisesRegex(RuntimeError, "cannot be adopted"): client.sample(wait)
            with self.assertRaisesRegex(RuntimeError, "cannot be retried"): client.sample(wait)

    def test_copied_source_drift_is_rechecked_before_input_authority(self):
        original = {"context": {}, "sources": {"controller.py": U.pin(b"original")}}
        with tempfile.TemporaryDirectory() as temporary:
            control = Path(temporary).resolve(); scripts = control / "scripts"; scripts.mkdir()
            (scripts / "controller.py").write_bytes(b"changed")
            with patch.object(C, "CONTROL", control), patch.object(C, "intent", return_value=original), patch.object(U, "protected_ancestry"):
                real_bound = U.bound
                def bound(path, expected, limit, **kwargs): return real_bound(path, expected, limit)
                with patch.object(U, "bound", side_effect=bound), self.assertRaisesRegex(RuntimeError, "Independent bytes differ"):
                    C.recheck_sources(environment(), original)


class BrokerTests(unittest.TestCase):
    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary).resolve(); base = root / "fixture"; (base / "result").mkdir(parents=True)
            workspace = root / "workspace"; source = workspace / "scripts"; source.mkdir(parents=True)
            controller = source / "native-linux-migrated-update.py"; controller.write_bytes(b"unit-only controller")
            node = root / "node"; node.write_bytes(b"unit-only node")
            driver = root / "native-linux-production-016-driver/bin/tauri-driver"; driver.parent.mkdir(parents=True); driver.write_bytes(b"unit-only driver")
            verifier = root / "verifier"; verifier.write_bytes(b"unit-only verifier")
            qualification = {"tool": {"pin": U.pin(verifier.read_bytes())}}
            original = {"context": {"source": "a" * 40}, "sources": {controller.name: U.pin(controller.read_bytes())},
                        "driver": U.pin(driver.read_bytes()), "node": U.pin(node.read_bytes()), "verifier": qualification}
            before = {"revision": 1, "records": []}; after = append_reads(append_reads(before, "b"), "c")
            prefix = C.GENERATION_PARENT + C.SUCCESSOR_GENERATION
            generation = {prefix: {"kind": "directory", "mode": 0o700}}
            home = {".": {"dev": 1, "ino": 2}, prefix: {**generation[prefix], "dev": 1, "ino": 3, "uid": M.UID, "gid": M.UID}}
            sealed = {"context": original["context"], "accountUid": M.UID, "home": home, "journal": before}
            env = {**environment(), "GITHUB_WORKSPACE": str(workspace), "RUNNER_TEMP": str(root), "CONTROLLER_NODE": str(node)}
            control, output = base / "migrated-update", base / "result/migrated-update"
            for name, value in (("BASE", base), ("HERE", source), ("CONTROL", control), ("OUTPUT", output)):
                stack.enter_context(patch.object(C, name, value))
            stack.enter_context(patch.object(U, "TLS_CERT", root / "unused-ca"))
            stack.enter_context(patch.multiple(C.os, getuid=lambda: 0, geteuid=lambda: 0, chown=lambda *a: None, create=True))
            stack.enter_context(patch.object(C, "intent", return_value=original))
            stack.enter_context(patch.object(C, "directory"))
            stack.enter_context(patch.object(C, "adopt", return_value=sealed))
            stack.enter_context(patch.object(M, "native_process_inventory", return_value={"processes": [], "terminalProcesses": []}))
            stack.enter_context(patch.object(U, "offline_verifier", return_value=(verifier, qualification)))
            stack.enter_context(patch.object(C, "verify_inputs", return_value=({"baseline": {}}, {"successorGeneration": generation, "baseline": {}})))
            stack.enter_context(patch.object(U, "verify_installed"))
            stack.enter_context(patch.object(C, "preserve"))
            preserved = stack.enter_context(patch.object(C, "verify_preservation"))
            stack.enter_context(patch.object(M, "journal", return_value=after))
            real_read = U.read
            stack.enter_context(patch.object(U, "read", side_effect=lambda path, limit=262144, **kwargs: real_read(path, limit)))
            credential, account = [], ["L"]
            def credential_action(action, secret=None):
                credential.append(action)
                if action == "provision": account[0] = "P"
                if action == "lock": account[0] = "L"
                return account[0]
            polkit = SimpleNamespace(fixture_credential=credential_action, verify_files=Mock(), admin_config=Mock(), credential_tools=Mock())
            logs = Mock(); logs.metadata.return_value = {k: {"eof": True, "truncated": False} for k in ("stdout", "stderr")}
            if failure == "output": logs.metadata.return_value["stderr"]["eof"] = False
            native = SimpleNamespace(Capture=Mock(return_value=logs))
            modules = {"native-linux-polkit-probe": polkit, "native-linux-root-probe": native,
                       "native-unix-window": Mock(), "native-linux-update-mcp": U.load("native-linux-update-mcp")}
            stack.enter_context(patch.object(U, "load", side_effect=lambda name: modules[name]))
            def prepare_transport(*args):
                path = output / "transport"; path.mkdir(); return path, {}
            stack.enter_context(patch.object(U, "prepare_transport", side_effect=prepare_transport))
            inspected = {"fromVersion": "0.1.16", "targetVersion": "0.1.17", "publicDiscovery": False, "releaseReady": False}
            stack.enter_context(patch.object(C.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(inspected).encode(), stderr=b"")))
            lab, guard = Mock(), Mock(); lab.proxy = "http://127.0.0.1:1234"
            if failure in ("cleanup", "original-and-cleanup"): guard.finish.side_effect = RuntimeError("unit cleanup refused")
            stack.enter_context(patch.object(U, "prepare_tls", return_value=guard))
            stack.enter_context(patch.object(U, "start_transport", return_value=lab))
            stack.enter_context(patch.object(U, "tls_cleanup", return_value={"temporaryCertificateRemoved": True, "originalTrustRestored": True}))
            stack.enter_context(patch.object(U, "validate_transport_report", return_value={}))
            child = Mock(); child.stdin = io.BytesIO(); child.poll.return_value = 1 if failure in ("native", "original-and-cleanup") else 0
            def launch(*args, **kwargs):
                report = {**native_report(), "harnessSource": env["GITHUB_SHA"], "scenarioPassed": True}
                (output / "report.json").write_text(json.dumps(report)); (output / "transport/lab-transport.json").write_text("{}")
                return child
            spawn = stack.enter_context(patch.object(C.subprocess, "Popen", side_effect=launch))
            if failure:
                with self.assertRaises(RuntimeError): C.broker(env)
            else:
                C.broker(env)
            record = json.loads((control / "broker.json").read_bytes())
            self.assertEqual(credential, ["status", "provision", "status", "lock", "status"])
            self.assertEqual(account[0], "L"); spawn.assert_called_once(); guard.finish.assert_called_once()
            self.assertEqual(record["scenarioPassed"], failure is None)
            self.assertEqual(record["continuousMigratedUserAccepted"], failure is None)
            if failure == "original-and-cleanup": self.assertIn("Continuation failed/unknown", record["refusal"]["message"])
            if failure is None: self.assertTrue(preserved.call_args.kwargs["require_generation"])
            self.assertFalse(record["releaseReady"])
            with self.assertRaisesRegex(RuntimeError, "Existing continuation"): C.broker(env)
            self.assertEqual(json.loads((control / "broker.json").read_bytes()), record)

    def test_mocked_success_finishes_cleanup_and_refuses_retry(self): self.exercise()

    def test_mocked_native_failure_preserves_failed_fixture_and_still_relocks(self): self.exercise("native")

    def test_mocked_cleanup_failure_cannot_pass(self): self.exercise("cleanup")

    def test_mocked_incomplete_output_cannot_pass(self): self.exercise("output")

    def test_mocked_cleanup_failure_never_replaces_original_failure(self): self.exercise("original-and-cleanup")


class TransitionHomeTests(unittest.TestCase):
    def setUp(self):
        self.f = T.TransitionConsumerTests(methodName="runTest")
        self.addCleanup(self.f.doCleanups); self.f.setUp()
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(C, "U", T.M))
        self.stack.enter_context(patch.object(C, "HOME", self.f.home))
        self.stack.enter_context(patch.object(C, "BASE", self.f.directory))
        self.home, self.u = self.f.home, T.M
        for path in (self.f.b_root, self.f.b_descriptor):
            self.assertTrue(path.resolve().is_relative_to(self.home))
            shutil.rmtree(path)
        self.f.record.unlink()
        history = self.f.active.parent / "history"
        for path in history.iterdir(): path.unlink()
        history.rmdir()
        self.f.linux_files.clear()
        for path in (self.home, *self.home.rglob("*")):
            self.metadata(path, 0o755 if path.is_dir() else 0o644)
        self.metadata(self.home, 0o700)
        self.G, self.R = C.GENERATION_PARENT.rstrip("/"), self.f.mcp.ROUTE_BASE
        self.D, self.E = "data/creator-hub-update-cache/deb", "data/creator-hub-update-cache/deb/records"
        for name in ("data/creator-hub-update-cache", self.D, self.E): self.mkdir(name, 0o700)
        self.mcp, self.routing, self.manifests, self.manifest_pins, self.archives = {}, {}, {}, {}, {}
        self.contents = {}
        for side in ("a", "b"):
            bodies = {**self.f.bodies[side], "setup/creator-project-setup": b"unchanged unit setup"}
            entry = json.loads(bodies["routing/runtime.json"])["module"]
            routing = {"executable": "routing/creator-hub-mcp-router", "version": "0.1.16" if side == "a" else "0.1.17",
                       "files": {n: self.f.inventories[side][n]["sha256"] for n in self.f.mcp.ROUTING_FILES}}
            setup = {"executable": "setup/creator-project-setup", "version": "0.3.7",
                     "files": {"setup/creator-project-setup": self.u.pin(bodies["setup/creator-project-setup"])["sha256"]}}
            metadata = {n: {"size": len(raw), "mode": 0o755 if n in (entry["executable"], setup["executable"],
                "mcp/server/runtime/node", "routing/creator-hub-mcp-router") else 0o644} for n, raw in bodies.items()}
            packed = io.BytesIO()
            with gzip.GzipFile(fileobj=packed, mode="wb", mtime=0) as zipped, tarfile.open(fileobj=zipped, mode="w|") as archive:
                for name, raw in sorted(bodies.items()):
                    row = tarfile.TarInfo(name); row.size = len(raw); row.mode = metadata[name]["mode"]
                    archive.addfile(row, io.BytesIO(raw))
            self.archives[side] = packed.getvalue()
            manifest = {"schemaVersion": 1, "platform": "linux", "arch": "x86_64", "modules": {"mcp": entry, "setup": setup},
                "managedRouting": {"protocol": 1, "files": routing["files"]}, "payloadArchive": {"schemaVersion": 1,
                    "file": "modules.tar.gz", **self.u.pin(self.archives[side]), "files": metadata,
                    "unpackedSize": sum(len(x) for x in bodies.values())}}
            self.manifests[side] = self.f.encode(manifest)
            self.manifest_pins[side] = self.u.pin(self.manifests[side])
            self.mcp[side], self.routing[side] = self.generation(entry), self.generation(routing)
            self.contents[side] = (bodies, metadata, setup)
        self.publish_generation("a", "mcp"); self.publish_generation("a", "routing")
        setup = self.contents["a"][2]
        self.publish_entry(self.generation(setup), setup, "a")
        self.mkdir(self.R, 0o700); self.mkdir(self.R + "/descriptors", 0o700)
        self.mkdir(self.R + "/descriptors/" + self.f.target("a")["descriptorSha256"], 0o700)
        self.mkdir(self.R + "/router-v1", 0o700)
        for name in ("runtime.json", "runtime.minisig"):
            self.put(self.R + "/descriptors/" + self.f.target("a")["descriptorSha256"] + "/" + name,
                     self.f.bodies["a"]["routing/" + name], 0o600)
        for name in ("creator-hub-mcp-router", "router.json", "router.minisig"):
            self.put(self.R + "/router-v1/" + name, self.f.bodies["a"]["routing/" + name], 0o500 if name.startswith("creator-") else 0o600)
        self.put(self.R + "/active.json", self.f.previous, 0o600)
        for name in (self.G + "/prepare.lock", self.R + "/activate.lock", self.R + "/router-prepare.lock", "data/CreatorHub/operation.lock"):
            self.put(name, b"", 0o600)
        for index in range(6): self.put(f"config/client-{index}/.creator-hub-settings-backups/original.bak", bytes([index]), 0o600)
        for name in ("config/launcher.json", "data/CreatorHub/preferences/hub-preferences.json", ".claude.json",
                     ".codex/config.toml", "data/creator-hub/client-migrations-v1/retained.json", "current-project/Assets/keep.txt", "cache/original"):
            self.put(name, b"unit protected original", 0o600)
        self.journal = append_reads({"revision": 1, "records": []}, "a")
        self.put(M.JOURNAL, self.f.encode(self.journal), 0o600)
        self.package = b"unit signed DEB bytes"
        release = json.loads(self.f.release)
        release.update(assetName="CreatorHub_0.1.17_amd64.deb", byteLength=len(self.package), sha256=self.u.pin(self.package)["sha256"],
                       identityProtocol=1, lifecycleProtocol=1, minHubVersion="0.1.16")
        self.release, self.signature = self.f.encode(release), self.f.detached
        (self.f.directory / "mcp-transition-input/b/release.json").write_bytes(self.release)
        self.cache_package = self.D + "/hub-" + release["sha256"] + ".deb"
        self.before = {"home": C.tree(self.home, M.UID), "journal": copy.deepcopy(self.journal)}

    @staticmethod
    def generation(entry):
        raw = json.dumps({"executable": entry["executable"], "version": entry["version"], "files": dict(sorted(entry["files"].items()))}, separators=(",", ":")).encode()
        return hashlib.sha256(raw).hexdigest()

    def metadata(self, path, mode):
        kind = stat.S_IFDIR if path.is_dir() else stat.S_IFREG
        self.f.linux_files[path] = {"st_mode": kind | mode, "st_uid": M.UID, "st_gid": M.UID}

    def mkdir(self, name, mode=0o755):
        path = self.home / name
        path.mkdir(parents=True, exist_ok=True)
        for current in (path, *path.parents):
            if current == self.home.parent: break
            if current not in self.f.linux_files: self.metadata(current, 0o755)
        self.metadata(path, mode)
        return path

    def put(self, name, raw, mode=0o644, *, replace=False):
        path = self.home / name
        self.mkdir(path.parent.relative_to(self.home).as_posix(), self.f.linux_files.get(path.parent, {}).get("st_mode", 0o755) & 0o777)
        if replace:
            temporary = path.with_name("unit-atomic-replacement")
            temporary.write_bytes(raw); os.replace(temporary, path)
        else:
            path.write_bytes(raw)
        self.metadata(path, mode)
        return path

    def publish_entry(self, generation, entry, side):
        self.mkdir(self.G + "/" + generation, 0o700)
        bodies, metadata, _ = self.contents[side]
        for name in entry["files"]: self.put(self.G + "/" + generation + "/" + name, bodies[name], metadata[name]["mode"])

    def publish_generation(self, side, kind):
        manifest = json.loads(self.manifests[side])
        entry = manifest["modules"]["mcp"] if kind == "mcp" else {"executable": "routing/creator-hub-mcp-router",
            "version": "0.1.16" if side == "a" else "0.1.17", "files": manifest["managedRouting"]["files"]}
        self.publish_entry(self.generation(entry), entry, side)

    def cache(self):
        self.mkdir("data/creator-hub-update-cache", 0o700); self.mkdir(self.D, 0o700); self.mkdir(self.E, 0o700)
        self.put(self.E + "/0.1.17.json", self.release); self.put(self.E + "/0.1.17.minisig", self.signature)
        self.put(self.cache_package, self.package)

    def record(self, phase, **changes):
        self.cache()
        self.put(self.E + "/mcp-route-update.lock", b"", 0o600)
        value = {"schemaVersion": 1, "fromVersion": "0.1.16", "installed": "/usr/bin/creator-hub", "release": list(self.release),
                 "signature": list(self.signature), "previous": list(self.f.previous), "phase": phase, **changes}
        self.put(self.E + "/mcp-route-update.json", self.f.encode(value), 0o600, replace=True)

    def publish_b(self):
        self.publish_generation("b", "mcp"); self.publish_generation("b", "routing")
        descriptor = self.R + "/descriptors/" + self.f.target("b")["descriptorSha256"]
        self.mkdir(descriptor, 0o700)
        for name in ("runtime.json", "runtime.minisig"): self.put(descriptor + "/" + name, self.f.bodies["b"]["routing/" + name], 0o600)
        self.mkdir(self.R + "/history", 0o700)
        self.put(self.R + "/history/" + self.u.pin(self.f.previous)["sha256"] + ".json", self.f.previous, 0o600)

    def complete_b(self):
        self.publish_b()
        self.put(self.R + "/active.json", self.f.encode({"schemaVersion": 1, **self.f.target("b")}), 0o600, replace=True)
        self.record({"Completed": self.f.target("b")})
        self.put(M.JOURNAL, self.f.encode(append_reads(append_reads(self.journal, "b"), "c")), 0o600, replace=True)

    def guard(self):
        return C.TransitionHomePreservation(self.before, self.manifests, self.manifest_pins, self.archives, self.f.inventories, None)

    def completed_guard(self):
        guard = self.guard(); self.record("Ready"); guard.check()
        self.record({"Attempting": self.f.target("b")}); guard.check()
        self.complete_b()
        return guard

    def test_old_gate_still_rejects_real_filesystem_a_to_b(self):
        self.complete_b()
        with self.assertRaisesRegex(RuntimeError, "Original protected bytes/identity changed"):
            C.compare_tree(self.before["home"], C.tree(self.home, M.UID), journal=M.JOURNAL)

    def test_real_filesystem_transition_preserves_all_originals_and_completes(self):
        guard = self.completed_guard(); guard.finish(); guard.finish()
        after = C.tree(self.home, M.UID)
        for name, expected in self.before["home"].items():
            if name not in (M.JOURNAL, self.R + "/active.json"): self.assertEqual(after[name], expected, name)

    def test_complete_mcp_without_routing_generation_refuses(self):
        guard = self.completed_guard()
        path = self.home / self.G / self.routing["b"]
        self.assertTrue(path.resolve().is_relative_to(self.home)); shutil.rmtree(path)
        with self.assertRaises(RuntimeError): guard.finish()

    def test_missing_history_refuses(self):
        guard = self.completed_guard()
        path = self.home / self.R / "history" / (self.u.pin(self.f.previous)["sha256"] + ".json")
        path.unlink()
        with self.assertRaises(RuntimeError): guard.finish()

    def test_extra_generation_webcache_and_fake_supersession_refuse(self):
        for name in (self.G + "/" + "f" * 64 + "/extra", "cache/unexplained-new", self.E + "/mcp-route-history-" + "e" * 64 + ".json"):
            with self.subTest(name=name):
                guard = self.guard()
                if name.startswith(self.E + "/"): self.cache()
                self.put(name, b"foreign")
                with self.assertRaisesRegex(RuntimeError, "no prefix exemption"): guard.check()
                (self.home / name).unlink()
                for directory in sorted((p for p in (self.home / self.G).iterdir() if p.name == "f" * 64), reverse=True): directory.rmdir()

    def test_original_same_bytes_new_inode_refuses(self):
        guard = self.guard()
        name = "config/client-0/.creator-hub-settings-backups/original.bak"
        self.put(name, (self.home / name).read_bytes(), 0o600, replace=True)
        with self.assertRaises(RuntimeError): guard.check()

    def test_new_payload_mode_refuses(self):
        guard = self.completed_guard()
        node = self.home / self.G / self.mcp["b"] / "mcp/server/runtime/node"
        self.f.linux_files[node]["st_mode"] = stat.S_IFREG | 0o777
        with self.assertRaises(RuntimeError): guard.finish()

    def test_early_b_and_unobserved_ready_refuse(self):
        guard = self.guard(); self.complete_b()
        with self.assertRaises(RuntimeError): guard.finish()

    def test_stale_cas_and_unknown_attempting_do_not_authorize_b(self):
        guard = self.guard(); self.record("Ready", previous=list(b"stale CAS"))
        with self.assertRaises(RuntimeError): guard.check()

    def test_ready_and_attempting_keep_original_active_identity(self):
        guard = self.guard(); self.record("Ready"); guard.check()
        self.record({"Attempting": self.f.target("b")}); guard.check()
        self.put(self.R + "/active.json", self.f.encode({"schemaVersion": 1, **self.f.target("b")}), 0o600, replace=True)
        with self.assertRaises(RuntimeError): guard.check()

    def test_completed_same_bytes_replacement_refuses(self):
        guard = self.completed_guard(); guard.finish()
        path = self.home / self.E / "mcp-route-update.json"
        self.put(self.E + "/mcp-route-update.json", path.read_bytes(), 0o600, replace=True)
        with self.assertRaises(RuntimeError): guard.check()

    def test_bound_manifest_byte_pin_mismatch_refuses(self):
        self.manifests["b"] += b" "
        with self.assertRaises(RuntimeError): self.guard()

    def test_final_partial_and_unrelated_cache_paths_refuse(self):
        guard = self.completed_guard()
        self.put(self.cache_package[:-4] + ".part", b"partial")
        with self.assertRaises(RuntimeError): guard.finish()

    def test_exact_cache_progress_without_new_handoff_is_not_final_success(self):
        guard = self.guard(); self.cache()
        self.put(self.cache_package[:-4] + ".part", self.package[:3])
        self.put(self.E + "/0.1.17.pending", self.release[:5])
        guard.check()
        with self.assertRaises(RuntimeError): guard.finish()

    def test_missing_payload_refuses(self):
        guard = self.completed_guard()
        node = self.home / self.G / self.mcp["b"] / "mcp/server/runtime/node"
        node.unlink()
        with self.assertRaises(RuntimeError): guard.finish()

    def test_missing_descriptor_member_refuses(self):
        guard = self.completed_guard()
        (self.home / self.R / "descriptors" / self.f.target("b")["descriptorSha256"] / "runtime.minisig").unlink()
        with self.assertRaises(RuntimeError): guard.finish()

    def test_extra_member_inside_published_generation_refuses(self):
        guard = self.completed_guard()
        self.put(self.G + "/" + self.routing["b"] + "/routing/extra.json", b"foreign", 0o644)
        with self.assertRaises(RuntimeError): guard.finish()

    def test_new_payload_foreign_uid_refuses(self):
        guard = self.completed_guard()
        node = self.home / self.G / self.mcp["b"] / "mcp/server/runtime/node"
        self.f.linux_files[node]["st_uid"] = 0
        with self.assertRaises(RuntimeError): guard.finish()

    def test_new_payload_real_hardlink_refuses(self):
        guard = self.completed_guard()
        node = self.home / self.G / self.mcp["b"] / "mcp/server/runtime/node"
        outside = self.f.directory / "unit-outside-hardlink"
        os.link(node, outside)
        self.addCleanup(outside.unlink)
        with self.assertRaises(RuntimeError): guard.finish()

    def test_original_preferences_and_backup_bytes_cannot_change(self):
        guard = self.guard()
        self.put("data/CreatorHub/preferences/hub-preferences.json", b"changed preference", 0o600)
        with self.assertRaises(RuntimeError): guard.check()

    def test_retained_router_metadata_same_bytes_new_inode_refuses(self):
        guard = self.completed_guard()
        path = self.home / self.R / "router-v1/router.minisig"
        self.put(self.R + "/router-v1/router.minisig", path.read_bytes(), 0o600, replace=True)
        with self.assertRaises(RuntimeError): guard.finish()

    def test_active_b_must_be_atomic_not_in_place(self):
        guard = self.guard(); self.record("Ready"); guard.check()
        self.publish_b()
        self.put(self.R + "/active.json", self.f.encode({"schemaVersion": 1, **self.f.target("b")}), 0o600)
        self.record({"Completed": self.f.target("b")})
        self.put(M.JOURNAL, self.f.encode(append_reads(append_reads(self.journal, "b"), "c")), 0o600, replace=True)
        with self.assertRaisesRegex(RuntimeError, "atomic active A->B"): guard.finish()

    def test_reverse_active_after_completed_refuses(self):
        guard = self.completed_guard(); guard.finish()
        self.put(self.R + "/active.json", self.f.previous, 0o600, replace=True)
        with self.assertRaises(RuntimeError): guard.check()

    def test_failure_is_spent_after_stale_cas_even_if_file_is_repaired(self):
        guard = self.guard(); self.record("Ready", previous=list(b"stale"))
        with self.assertRaises(RuntimeError): guard.check()
        self.record("Ready")
        with self.assertRaisesRegex(RuntimeError, "no repair/retry"): guard.check()

    def test_unknown_attempting_without_ready_refuses(self):
        guard = self.guard(); self.record({"Attempting": self.f.target("b")})
        with self.assertRaisesRegex(RuntimeError, "prior Ready"): guard.check()

    def test_prior_handoff_cannot_be_adopted_or_superseded(self):
        self.record("Ready")
        self.before["home"] = C.tree(self.home, M.UID)
        with self.assertRaisesRegex(RuntimeError, "no supersession"): self.guard()

    def test_archive_tamper_and_changed_setup_entry_are_refused(self):
        self.archives["b"] += b"foreign bytes"
        with self.assertRaises(RuntimeError): self.guard()

    def test_changed_setup_entry_needs_separate_closure_even_when_bytes_equal(self):
        value = json.loads(self.manifests["b"]); value["modules"]["setup"]["version"] = "0.3.8"
        self.manifests["b"] = self.f.encode(value); self.manifest_pins["b"] = self.u.pin(self.manifests["b"])
        with self.assertRaisesRegex(RuntimeError, "Setup entry needs"): self.guard()

    def test_b016_payload_b_donor_manifest_cannot_substitute_for_native_a(self):
        # Both native A and the packaging donor can be Hub016; files, not that
        # version label, must bind native A to its independent signed inventory.
        donor = json.loads(self.manifests["a"])
        donor["modules"]["mcp"] = json.loads(self.manifests["b"])["modules"]["mcp"]
        self.manifests["a"] = self.f.encode(donor); self.manifest_pins["a"] = self.u.pin(self.manifests["a"])
        with self.assertRaisesRegex(RuntimeError, "signed inventories differ"): self.guard()

    def test_coherent_payload_b_donor_inventory_cannot_be_native_a(self):
        donor = dict(self.f.bodies["b"])
        runtime = json.loads(donor["routing/runtime.json"]); runtime["hubVersion"] = "0.1.16"
        donor["routing/runtime.json"] = self.f.encode(runtime)
        self.f.inventories["a"] = {name: self.u.pin(raw) for name, raw in donor.items()}
        for name, raw in donor.items():
            (self.f.directory / "mcp-transition-input/a" / name).write_bytes(raw)
        with self.assertRaisesRegex(RuntimeError, "Different signed server generation required"): self.guard()

    def test_journal_extra_pair_or_changed_prefix_refuses(self):
        guard = self.completed_guard()
        value = append_reads(append_reads(append_reads(self.journal, "b"), "c"), "d")
        self.put(M.JOURNAL, self.f.encode(value), 0o600, replace=True)
        with self.assertRaises(RuntimeError): guard.finish()

    def test_journal_prefix_numeric_id_cannot_be_replaced_by_boolean(self):
        self.journal["records"][0]["id"] = 1
        self.put(M.JOURNAL, self.f.encode(self.journal), 0o600, replace=True)
        self.before = {"home": C.tree(self.home, M.UID), "journal": copy.deepcopy(self.journal)}
        guard = self.guard()
        changed = copy.deepcopy(self.journal); changed["records"][0]["id"] = True
        self.put(M.JOURNAL, self.f.encode(changed), 0o600, replace=True)
        with self.assertRaisesRegex(RuntimeError, "journal prefix"): guard.check()

    def test_fully_published_b_output_inode_cannot_change_after_first_observation(self):
        guard = self.completed_guard(); guard.finish()
        name = self.G + "/" + self.mcp["b"] + "/mcp/server/runtime/node"
        self.put(name, (self.home / name).read_bytes(), 0o755, replace=True)
        with self.assertRaisesRegex(RuntimeError, "output identity changed"): guard.check()

    def test_existing_valid_b_cache_is_retained_not_reconstructed(self):
        self.publish_b()
        self.before["home"] = C.tree(self.home, M.UID)
        guard = self.guard(); self.record("Ready"); guard.check()
        self.put(self.R + "/active.json", self.f.encode({"schemaVersion": 1, **self.f.target("b")}), 0o600, replace=True)
        self.record({"Completed": self.f.target("b")})
        self.put(M.JOURNAL, self.f.encode(append_reads(append_reads(self.journal, "b"), "c")), 0o600, replace=True)
        guard.finish()

    def test_fast_ready_atomic_capture_then_complete_without_full_scan(self):
        guard = self.guard(); self.record("Ready")
        before = C.tree(self.home, M.UID)
        reader = self.u.transition_file
        with patch.object(C, "tree", side_effect=AssertionError("No in-flight HOME scan")), \
                patch.object(self.u, "transition_file", wraps=reader) as reads:
            self.assertIsNone(guard.capture_ready())
        self.assertEqual({call.args[0] for call in reads.call_args_list},
                         {self.f.record, self.f.active})
        self.assertEqual(guard._ready, reader(self.f.record, mode=0o600))
        self.assertEqual(len(guard._ready["file"]["identity"]), 9)
        self.assertEqual(C.tree(self.home, M.UID), before)
        self.record({"Attempting": self.f.target("b")}); guard.check()
        self.complete_b(); guard.finish(); guard.finish()

    def test_fast_ready_missing_record_refuses_and_spends_capture(self):
        guard = self.guard()
        with self.assertRaises(FileNotFoundError): guard.capture_ready()
        self.record("Ready")
        with self.assertRaisesRegex(RuntimeError, "refusal"): guard.capture_ready()
        with self.assertRaisesRegex(RuntimeError, "refusal"): guard.check()
        self.assertIsNone(guard._ready)

    def test_fast_ready_attempting_cannot_substitute(self):
        guard = self.guard(); self.record({"Attempting": self.f.target("b")})
        with self.assertRaisesRegex(RuntimeError, "Ready/Completed"): guard.capture_ready()
        self.assertIsNone(guard._ready)

    def test_fast_ready_early_completed_cannot_substitute(self):
        guard = self.guard(); self.record({"Completed": self.f.target("b")})
        with self.assertRaisesRegex(RuntimeError, "Ready/Completed"): guard.capture_ready()
        self.assertIsNone(guard._ready)

    def test_fast_ready_foreign_release_target_refuses(self):
        guard = self.guard()
        release = json.loads(self.release); release["executableSha256"] = "f" * 64
        self.record("Ready", release=list(self.f.encode(release)))
        with self.assertRaisesRegex(RuntimeError, "Ready/Completed"): guard.capture_ready()

    def test_fast_ready_foreign_signature_refuses(self):
        guard = self.guard(); self.record("Ready", signature=list(b"foreign signature"))
        with self.assertRaisesRegex(RuntimeError, "Ready/Completed"): guard.capture_ready()

    def test_fast_ready_foreign_installed_path_refuses(self):
        guard = self.guard(); self.record("Ready", installed="/tmp/creator-hub")
        with self.assertRaisesRegex(RuntimeError, "Ready/Completed"): guard.capture_ready()

    def test_fast_ready_stale_original_cas_refuses(self):
        guard = self.guard(); self.record("Ready", previous=list(b"stale receipt"))
        with self.assertRaisesRegex(RuntimeError, "Ready/Completed"): guard.capture_ready()

    def test_fast_ready_actual_active_b_refuses_even_with_valid_ready_intent(self):
        guard = self.guard(); self.record("Ready")
        self.put(self.R + "/active.json", self.f.encode({"schemaVersion": 1, **self.f.target("b")}), 0o600, replace=True)
        with self.assertRaisesRegex(RuntimeError, "actual active A"): guard.capture_ready()

    def test_fast_ready_actual_active_a_same_bytes_new_inode_refuses(self):
        guard = self.guard(); self.record("Ready")
        self.put(self.R + "/active.json", self.f.previous, 0o600, replace=True)
        with self.assertRaisesRegex(RuntimeError, "actual active A"): guard.capture_ready()

    def test_fast_ready_record_mutation_between_actual_reads_refuses(self):
        guard = self.guard(); self.record("Ready")
        reader = self.u.transition_file
        changed = False
        def read(path, *args, **kwargs):
            nonlocal changed
            value = reader(path, *args, **kwargs)
            if path == self.f.record and not changed:
                changed = True
                self.record("Ready", installed="/tmp/foreign")
            return value
        with patch.object(self.u, "transition_file", side_effect=read):
            with self.assertRaisesRegex(RuntimeError, "Ready changed"): guard.capture_ready()
        self.assertIsNone(guard._ready)
        self.record("Ready")
        with self.assertRaisesRegex(RuntimeError, "refusal"): guard.capture_ready()

    def test_fast_ready_same_bytes_atomic_replacement_between_reads_refuses(self):
        guard = self.guard(); self.record("Ready")
        reader = self.u.transition_file
        changed = False
        def read(path, *args, **kwargs):
            nonlocal changed
            value = reader(path, *args, **kwargs)
            if path == self.f.record and not changed:
                changed = True
                self.put(self.E + "/mcp-route-update.json", bytes(value["raw"]), 0o600, replace=True)
            return value
        with patch.object(self.u, "transition_file", side_effect=read):
            with self.assertRaisesRegex(RuntimeError, "Ready changed"): guard.capture_ready()
        self.assertIsNone(guard._ready)

    def test_fast_ready_all_nine_handoff_identity_fields_are_compared(self):
        guards = [self.guard() for _ in range(9)]
        self.record("Ready"); reader = self.u.transition_file
        for field, guard in enumerate(guards):
            with self.subTest(identityField=field):
                count = 0
                def read(path, *args, **kwargs):
                    nonlocal count
                    value = reader(path, *args, **kwargs)
                    if path == self.f.record:
                        count += 1
                        if count == 2:
                            # Negative reader-fault injection, never positive evidence.
                            value["file"]["identity"][field] += 1
                    return value
                with patch.object(self.u, "transition_file", side_effect=read):
                    with self.assertRaisesRegex(RuntimeError, "Ready changed"): guard.capture_ready()
                self.assertIsNone(guard._ready)

    def test_fast_ready_all_nine_active_identity_fields_are_compared(self):
        guards = [self.guard() for _ in range(9)]
        self.record("Ready"); reader = self.u.transition_file
        for field, guard in enumerate(guards):
            with self.subTest(identityField=field):
                def read(path, *args, **kwargs):
                    value = reader(path, *args, **kwargs)
                    if path == self.f.active: value["file"]["identity"][field] += 1
                    return value
                with patch.object(self.u, "transition_file", side_effect=read):
                    with self.assertRaisesRegex(RuntimeError, "actual active A"): guard.capture_ready()
                self.assertIsNone(guard._ready)

    def test_fast_ready_active_mutation_during_capture_refuses(self):
        guard = self.guard(); self.record("Ready")
        reader = self.u.transition_file
        changed = False
        def read(path, *args, **kwargs):
            nonlocal changed
            value = reader(path, *args, **kwargs)
            if path == self.f.active and not changed:
                changed = True
                self.put(self.R + "/active.json", self.f.previous, 0o600, replace=True)
            return value
        with patch.object(self.u, "transition_file", side_effect=read):
            with self.assertRaisesRegex(RuntimeError, "actual active A"): guard.capture_ready()
        self.assertIsNone(guard._ready)

    def test_fast_ready_same_bytes_handoff_replacement_during_last_active_read_refuses(self):
        guard = self.guard(); self.record("Ready")
        reader = self.u.transition_file
        active_reads = 0
        def read(path, *args, **kwargs):
            nonlocal active_reads
            value = reader(path, *args, **kwargs)
            if path == self.f.active:
                active_reads += 1
                if active_reads == 2:
                    self.put(self.E + "/mcp-route-update.json", self.f.record.read_bytes(), 0o600, replace=True)
            return value
        with patch.object(self.u, "transition_file", side_effect=read):
            with self.assertRaisesRegex(RuntimeError, "Ready changed"): guard.capture_ready()
        self.assertIsNone(guard._ready)

    def test_fast_ready_successful_capture_cannot_repeat(self):
        guard = self.guard(); self.record("Ready"); guard.capture_ready()
        with self.assertRaisesRegex(RuntimeError, "spent"): guard.capture_ready()
        with self.assertRaisesRegex(RuntimeError, "refusal"): guard.finish()

    def test_fast_ready_prior_quiescent_capture_is_already_spent(self):
        guard = self.guard(); self.record("Ready"); guard.check()
        with self.assertRaisesRegex(RuntimeError, "spent"): guard.capture_ready()

    def test_fast_ready_previous_preservation_refusal_cannot_reset(self):
        guard = self.guard(); self.put("config/launcher.json", b"changed", 0o600)
        with self.assertRaises(RuntimeError): guard.check()
        self.record("Ready")
        with patch.object(self.u, "transition_file", side_effect=AssertionError("No new read after refusal")):
            with self.assertRaisesRegex(RuntimeError, "refusal"): guard.capture_ready()

    def test_fast_ready_has_no_raw_or_authority_argument(self):
        guard = self.guard(); self.record("Ready")
        with self.assertRaises(TypeError): guard.capture_ready(bytes(self.f.record.read_bytes()))
        with self.assertRaises(TypeError): guard.capture_ready(approved=True)
        self.assertIsNone(guard.capture_ready())
        with self.assertRaisesRegex(RuntimeError, "Actual Completed"): guard.finish()

    def test_fast_ready_capture_does_not_approve_unrelated_home_change(self):
        guard = self.guard(); self.record("Ready")
        self.put("config/launcher.json", b"changed", 0o600)
        self.assertIsNone(guard.capture_ready())
        with self.assertRaisesRegex(RuntimeError, "Original protected"): guard.check()

    def test_fast_ready_later_same_bytes_ready_inode_replacement_refuses(self):
        guard = self.guard(); self.record("Ready"); guard.capture_ready()
        self.put(self.E + "/mcp-route-update.json", self.f.record.read_bytes(), 0o600, replace=True)
        with self.assertRaisesRegex(RuntimeError, "Ready identity"): guard.check()

    def test_fast_ready_later_complete_still_requires_full_b_closure(self):
        guard = self.guard(); self.record("Ready"); guard.capture_ready()
        self.complete_b()
        (self.home / self.G / self.mcp["b"] / "mcp/server/runtime/node").unlink()
        with self.assertRaisesRegex(RuntimeError, "Complete exact published"): guard.finish()

    @contextmanager
    def watcher_role(self, uid):
        with ExitStack() as stack:
            stack.enter_context(patch.object(C.sys, "platform", "linux"))
            for name in ("getuid", "geteuid", "getgid", "getegid"):
                stack.enter_context(patch.object(C.os, name, return_value=uid, create=True))
            yield

    @contextmanager
    def watcher_kernel(self):
        kernels = []
        def create(parent):
            value = WatcherKernel(parent); kernels.append(value); return value
        with patch.object(C, "_ReadyInotify", side_effect=create, create=True): yield kernels

    def watcher_protocol(self):
        module = self.u.load("native-linux-update-mcp")
        def verified(home, binding):
            active = self.u.parse(self.u.read(home / self.R / "active.json", 16384))
            self.assertEqual(active, {"schemaVersion": 1, **self.f.target("a")})
            return (home / self.R / "router-v1/creator-hub-mcp-router",
                    home / self.G / self.mcp["a"] / "mcp/server/creator-works-mcp.mjs")
        migration = SimpleNamespace(UID=M.UID, P=self.u, keys=self.u.keys,
            read_file=self.u.read, verified_route=verified)
        verify = lambda body, sig: self.u.signature(body, sig, None)
        hashes = {side: {n: p["sha256"] for n, p in self.f.inventories[side].items()} for side in ("a", "b")}
        before = module.BoundRoute(migration, self.home, hashes["a"], verify)
        source = self.f.directory / "mcp-transition-input/b"
        route = module.TransitionRoute(before, source, hashes["b"], (source / "release.json", source / "release.minisig"))
        fixture = module.TransitionFixture(route, self.f.evidence,
            {"HOME": str(self.home), "XDG_DATA_HOME": str(self.home / "data"), "XDG_CONFIG_HOME": str(self.home / "config"),
             "CREATOR_WORKS_TOOL_GROUPS": "none", "CREATOR_WORKS_CONFIG_OWNER": "creator-hub-v1"},
            self.f.paths, None, None, None)
        protocol = self.u.TransitionProtocolCapture(fixture, self.f.inventories, None, self.f.paths)
        # Model an already-started SDK lease; no child/app is launched by this slice.
        fixture.started, fixture.connection = True, object()
        return protocol

    def test_watcher_fixture_uses_actual_protocol_and_route_capture_methods(self):
        protocol = self.watcher_protocol(); guard = self.guard(); self.record("Ready")
        protocol.capture_ready(); guard.capture_ready()
        self.assertEqual(protocol.captures["ready"], guard._ready)

    def test_watcher_broker_atomic_rename_captures_actual_ready_and_joins(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5)
            with patch.object(C.subprocess, "Popen", side_effect=AssertionError("No child")), \
                    patch.object(C, "tree", side_effect=AssertionError("No HOME scan")):
                self.assertIsNone(watch.arm())
                self.assertFalse(watch._thread.daemon)
                self.record("Ready"); kernels[0].events.put(watcher_event())
                result = watch.wait(); watch.close()
            self.assertEqual(result, self.u.transition_file(self.f.record, mode=0o600))
            self.assertTrue(kernels[0].closed); self.assertFalse(watch._thread.is_alive())
            result["raw"][0] ^= 1
            self.assertEqual(watch.wait(), guard._ready)

    def test_watcher_session_calls_both_exact_capture_methods(self):
        protocol = self.watcher_protocol(); guard = self.guard()
        with self.watcher_role(M.UID), self.watcher_kernel() as kernels:
            watch = C.SessionReadyWatcher(guard, protocol, C.time.monotonic() + 5); watch.arm()
            self.record("Ready"); kernels[0].events.put(watcher_event())
            self.assertEqual(watch.wait(), protocol.captures["ready"])
            self.assertEqual(protocol.captures["ready"], guard._ready)
            self.assertTrue(protocol.ready_started); self.assertTrue(kernels[0].closed)

    def test_watcher_session_and_broker_have_independent_actual_captures(self):
        protocol = self.watcher_protocol(); ordinary, root = self.guard(), self.guard()
        with self.watcher_kernel() as kernels:
            with self.watcher_role(M.UID): session = C.SessionReadyWatcher(ordinary, protocol, C.time.monotonic() + 5); session.arm()
            with self.watcher_role(0): broker = C.BrokerReadyWatcher(root, C.time.monotonic() + 5); broker.arm()
            self.record("Ready")
            for kernel in kernels: kernel.events.put(watcher_event())
            left, right = session.wait(), broker.wait()
            self.assertEqual(left, right); self.assertIsNot(left, right)
            self.assertIsNot(ordinary._ready, root._ready)

    def test_watcher_wrong_roles_platform_and_types_refuse_before_kernel(self):
        guard = self.guard(); deadline = C.time.monotonic() + 5
        with self.watcher_kernel() as kernels:
            with self.watcher_role(M.UID):
                with self.assertRaises(RuntimeError): C.BrokerReadyWatcher(guard, deadline)
            with self.watcher_role(0):
                with self.assertRaises(RuntimeError): C.SessionReadyWatcher(guard, object(), deadline)
                with self.assertRaises(RuntimeError): C.BrokerReadyWatcher(object(), deadline)
            with patch.object(C.sys, "platform", "win32"):
                with self.assertRaises(RuntimeError): C.BrokerReadyWatcher(guard, deadline)
            self.assertEqual(kernels, [])

    def test_watcher_exact_protocol_rejects_foreign_inputs_and_callbacks(self):
        protocol = self.watcher_protocol(); guard = self.guard()
        with self.watcher_role(M.UID):
            with self.assertRaises(RuntimeError): C.SessionReadyWatcher(guard, SimpleNamespace(**protocol.__dict__), C.time.monotonic() + 5)
            protocol.expected = copy.deepcopy(protocol.expected); protocol.expected["release"] = b"foreign"
            with self.assertRaises(RuntimeError): C.SessionReadyWatcher(guard, protocol, C.time.monotonic() + 5)
            with self.assertRaises(TypeError): C.SessionReadyWatcher(guard, protocol, C.time.monotonic() + 5, callback=lambda: True)

    def test_watcher_deadline_must_be_finite_bounded_and_not_boolean(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            for value in (True, float("inf"), float("nan"), 0, C.time.monotonic() + 901):
                with self.subTest(value=value):
                    with self.assertRaises(RuntimeError): C.BrokerReadyWatcher(guard, value)
            self.assertEqual(kernels, [])

    def test_watcher_existing_ready_is_not_adopted_at_arm(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); self.record("Ready")
            with self.assertRaises(RuntimeError): watch.arm()
            self.assertTrue(guard._refused); self.assertEqual(kernels, [])

    def test_watcher_missing_parent_is_not_created_or_replaced_by_ancestor_watch(self):
        guard = self.guard(); self.f.record.parent.rmdir()
        with self.watcher_role(0), self.watcher_kernel():
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5)
            with self.assertRaises(FileNotFoundError): watch.arm()
            self.assertFalse(self.f.record.parent.exists()); self.assertTrue(guard._refused)

    def test_watcher_role_change_before_arm_refuses(self):
        guard = self.guard()
        with self.watcher_kernel():
            with self.watcher_role(0): watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5)
            with self.watcher_role(M.UID):
                try:
                    with self.assertRaises(RuntimeError): watch.arm()
                finally: watch.close()

    def test_watcher_handoff_path_change_before_arm_refuses(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel():
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5)
            guard.handoff = self.R + "/foreign.json"
            try:
                with self.assertRaises(RuntimeError): watch.arm()
            finally: watch.close()

    def test_watcher_protocol_change_before_arm_refuses(self):
        protocol = self.watcher_protocol(); guard = self.guard()
        with self.watcher_role(M.UID), self.watcher_kernel():
            watch = C.SessionReadyWatcher(guard, protocol, C.time.monotonic() + 5)
            protocol.expected = copy.deepcopy(protocol.expected); protocol.expected["release"] = b"foreign"
            try:
                with self.assertRaises(RuntimeError): watch.arm()
            finally: watch.close()

    def test_watcher_calls_class_bound_capture_methods_not_instance_callbacks(self):
        protocol = self.watcher_protocol(); guard = self.guard()
        protocol.capture_ready = Mock(side_effect=AssertionError("No instance protocol callback"))
        guard.capture_ready = Mock(side_effect=AssertionError("No instance guard callback"))
        with self.watcher_role(M.UID), self.watcher_kernel() as kernels:
            watch = C.SessionReadyWatcher(guard, protocol, C.time.monotonic() + 5); watch.arm()
            self.record("Ready"); kernels[0].events.put(watcher_event())
            self.assertEqual(watch.wait(), guard._ready)
        protocol.capture_ready.assert_not_called(); guard.capture_ready.assert_not_called()

    def test_watcher_overflow_is_fatal_even_when_actual_ready_exists(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); self.record("Ready")
            kernels[0].events.put(watcher_event(0x4000, b"", wd=-1, cookie=0))
            with self.assertRaisesRegex(RuntimeError, "overflow"): watch.wait()
            self.assertIsNone(guard._ready); self.assertTrue(guard._refused); self.assertTrue(kernels[0].closed)

    def test_watcher_missed_ready_attempting_is_not_reconstructed_or_retried(self):
        protocol = self.watcher_protocol(); guard = self.guard()
        with self.watcher_role(M.UID), self.watcher_kernel() as kernels:
            watch = C.SessionReadyWatcher(guard, protocol, C.time.monotonic() + 5); watch.arm()
            self.record({"Attempting": self.f.target("b")}); kernels[0].events.put(watcher_event())
            with self.assertRaises(RuntimeError): watch.wait()
            self.assertTrue(protocol.spent); self.assertTrue(guard._refused)
            self.record("Ready")
            with self.assertRaises(RuntimeError): watch.arm()
            with self.assertRaises(RuntimeError): watch.wait()

    def test_watcher_missed_completed_is_not_ready(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm()
            self.record({"Completed": self.f.target("b")}); kernels[0].events.put(watcher_event())
            with self.assertRaises(RuntimeError): watch.wait()
            self.assertIsNone(guard._ready)

    def test_watcher_non_atomic_target_write_refuses(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); self.record("Ready")
            kernels[0].events.put(watcher_event(0x100))
            with self.assertRaisesRegex(RuntimeError, "atomic"): watch.wait()
            self.assertIsNone(guard._ready)

    def test_watcher_two_queued_target_renames_refuse_ambiguous_capture(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); self.record("Ready")
            kernels[0].events.put(watcher_event() + watcher_event(cookie=2))
            with self.assertRaisesRegex(RuntimeError, "ambiguous"): watch.wait()
            self.assertIsNone(guard._ready)

    def test_watcher_parent_replacement_refuses(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm()
            parent = self.f.record.parent; parent.rename(parent.with_name("old-records"))
            self.mkdir(self.E, 0o700); kernels[0].events.put(watcher_event(0x800, b"", cookie=0))
            with self.assertRaises(RuntimeError): watch.wait()
            self.assertIsNone(guard._ready); self.assertTrue(guard._refused)

    def test_watcher_watch_removal_is_fatal(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm()
            kernels[0].events.put(watcher_event(0x8000, b"", cookie=0))
            with self.assertRaisesRegex(RuntimeError, "watch"): watch.wait()
            self.assertTrue(kernels[0].closed)

    def test_watcher_malformed_and_wrong_watch_events_refuse(self):
        with self.assertRaises(RuntimeError): C._ready_event_batch(b"short", 7)
        with self.assertRaises(RuntimeError): C._ready_event_batch(watcher_event(wd=8), 7)
        with self.assertRaises(RuntimeError): C._ready_event_batch(watcher_event(cookie=0), 7)
        self.assertFalse(C._ready_event_batch(watcher_event(name=b"unrelated.json"), 7))

    def test_watcher_unrelated_event_never_becomes_ready_authority(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm()
            kernels[0].events.put(watcher_event(name=b"unrelated.json"))
            kernels[0].events.put(TimeoutError("unit Ready deadline"))
            with self.assertRaises(TimeoutError): watch.wait()
            self.assertIsNone(guard._ready); self.assertTrue(guard._refused)

    def test_watcher_same_bytes_record_replaced_during_capture_refuses(self):
        guard = self.guard(); reader = self.u.transition_file; changed = False
        def read(path, *args, **kwargs):
            nonlocal changed
            value = reader(path, *args, **kwargs)
            if path == self.f.record and not changed:
                changed = True; self.put(self.E + "/mcp-route-update.json", bytes(value["raw"]), 0o600, replace=True)
            return value
        with self.watcher_role(0), self.watcher_kernel() as kernels, patch.object(self.u, "transition_file", side_effect=read):
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); self.record("Ready")
            kernels[0].events.put(watcher_event())
            with self.assertRaisesRegex(RuntimeError, "Ready changed"): watch.wait()
            self.assertTrue(kernels[0].closed)

    def test_watcher_close_before_ready_joins_and_latches_missing_capture(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); watch.close()
            with self.assertRaises(RuntimeError): watch.wait()
            self.assertFalse(watch._thread.is_alive()); self.assertTrue(kernels[0].closed); self.assertTrue(guard._refused)

    def test_watcher_post_capture_overflow_does_not_publish_success(self):
        guard = self.guard(); reader = self.u.transition_file; injected = False
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); self.record("Ready")
            def read(path, *args, **kwargs):
                nonlocal injected
                value = reader(path, *args, **kwargs)
                if path == self.f.record and not injected:
                    injected = True; kernels[0].events.put(watcher_event(0x4000, b"", wd=-1, cookie=0))
                return value
            with patch.object(self.u, "transition_file", side_effect=read):
                kernels[0].events.put(watcher_event())
                with self.assertRaisesRegex(RuntimeError, "overflow"): watch.wait()
            self.assertTrue(guard._refused)

    def watcher_thread_start_failure(self, uid):
        guard = self.guard()
        protocol = self.watcher_protocol() if uid else None
        failure = RuntimeError("unit Thread.start refused")
        with self.watcher_role(uid), ReadyKernelTests().kernel_api() as api, \
                patch.object(C.threading.Thread, "start", side_effect=failure) as started, \
                patch.object(C.threading.Thread, "join", side_effect=AssertionError("Unstarted thread cannot join")) as joined:
            deadline = C.time.monotonic() + 5
            watch = (C.SessionReadyWatcher(guard, protocol, deadline) if uid
                     else C.BrokerReadyWatcher(guard, deadline))
            with self.assertRaisesRegex(RuntimeError, "Thread.start refused"):
                watch.arm()
            unstarted = watch._thread
            self.assertFalse(unstarted.is_alive())
            self.assertTrue(guard._refused)
            self.assertIsNone(guard._ready)
            self.assertIsNone(watch._result)
            self.assertIs(watch._error, failure)
            if protocol is not None:
                self.assertTrue(protocol.spent)
                self.assertFalse(protocol.ready_started)
            self.assertCountEqual([call.args[0] for call in api.closed.call_args_list], [71, 72, 73, 74])
            self.assertTrue(all(getattr(watch._kernel, name) is None
                                for name in ("fd", "parent_fd", "stop_read", "stop_write")))
            watch.close()
            with self.assertRaisesRegex(RuntimeError, "attempt is spent"):
                watch.arm()
            self.assertIs(watch._thread, unstarted)
            self.assertIs(watch._error, failure)
            started.assert_called_once_with()
            joined.assert_not_called()
            api.write.assert_not_called()
            self.assertCountEqual([call.args[0] for call in api.closed.call_args_list], [71, 72, 73, 74])

    def test_watcher_thread_start_failure_session_closes_exact_owned_fds(self):
        self.watcher_thread_start_failure(M.UID)

    def test_watcher_thread_start_failure_broker_closes_exact_owned_fds(self):
        self.watcher_thread_start_failure(0)

    def test_watcher_cleanup_failure_cannot_publish_captured_ready(self):
        guard = self.guard()
        with self.watcher_role(0), self.watcher_kernel() as kernels:
            watch = C.BrokerReadyWatcher(guard, C.time.monotonic() + 5); watch.arm(); self.record("Ready")
            def fail_close():
                kernels[0].closed = True
                raise OSError("unit notifier close refused")
            kernels[0].close = fail_close
            kernels[0].events.put(watcher_event())
            with self.assertRaisesRegex(OSError, "close refused"): watch.wait()
            self.assertFalse(watch._thread.is_alive()); self.assertTrue(guard._refused)


class ReadyKernelTests(unittest.TestCase):
    @contextmanager
    def kernel_api(self, add_result=8):
        row = {"dev": 1, "ino": 2, "uid": M.UID, "gid": M.UID, "mode": 0o700}
        libc = SimpleNamespace(inotify_init1=Mock(return_value=72), inotify_add_watch=Mock(return_value=add_result))
        poll = Mock(); poll.poll.return_value = [(72, 1)]
        with ExitStack() as stack:
            stack.enter_context(patch.object(C.sys, "platform", "linux"))
            stack.enter_context(patch.object(C, "directory", return_value=row))
            stack.enter_context(patch.object(C.ctypes, "CDLL", return_value=libc))
            stack.enter_context(patch.object(C.ctypes, "get_errno", return_value=13))
            opened = stack.enter_context(patch.object(C.os, "open", return_value=71))
            closed = stack.enter_context(patch.object(C.os, "close"))
            stack.enter_context(patch.object(C.os, "pipe2", return_value=(73, 74), create=True))
            stack.enter_context(patch.object(C.os, "fstat", return_value=SimpleNamespace(
                st_dev=1, st_ino=2, st_uid=M.UID, st_gid=M.UID, st_mode=stat.S_IFDIR | 0o700)))
            read = stack.enter_context(patch.object(C.os, "read", return_value=watcher_event(wd=8)))
            write = stack.enter_context(patch.object(C.os, "write", return_value=1))
            stack.enter_context(patch.object(C.select, "poll", return_value=poll, create=True))
            stack.enter_context(patch.object(C.select, "POLLIN", 1, create=True))
            for name, value in (("O_DIRECTORY", 0x10000), ("O_NOFOLLOW", 0x20000), ("O_CLOEXEC", 0x80000), ("O_NONBLOCK", 0x800)):
                stack.enter_context(patch.object(C.os, name, value, create=True))
            yield SimpleNamespace(libc=libc, poll=poll, opened=opened, closed=closed, read=read, write=write)

    def test_watcher_kernel_flags_poll_wakeup_and_idempotent_fd_close(self):
        with self.kernel_api() as api:
            notifier = C._ReadyInotify(Path("/unit/records"))
            api.libc.inotify_init1.assert_called_once_with(0x800 | 0x80000)
            self.assertEqual(api.libc.inotify_add_watch.call_args.args[2], 0xFCE | 0x1000000 | 0x2000000)
            self.assertTrue(C._ready_event_batch(notifier.wait(C.time.monotonic() + 5), 8))
            notifier.wake(); api.write.assert_called_once_with(74, b"x")
            notifier.close(); notifier.close()
            self.assertCountEqual([c.args[0] for c in api.closed.call_args_list], [71, 72, 73, 74])

    def test_watcher_kernel_registration_failure_closes_every_acquired_fd(self):
        with self.kernel_api(add_result=-1) as api:
            with self.assertRaises(OSError): C._ReadyInotify(Path("/unit/records"))
            self.assertCountEqual([c.args[0] for c in api.closed.call_args_list], [71, 72, 73, 74])

    def test_watcher_kernel_poll_deadline_preserves_cleanup(self):
        with self.kernel_api() as api:
            notifier = C._ReadyInotify(Path("/unit/records")); api.poll.poll.return_value = []
            try:
                with self.assertRaises(TimeoutError): notifier.wait(C.time.monotonic() + 5)
            finally: notifier.close()
            self.assertEqual(api.closed.call_count, 4)

    @unittest.skipUnless(sys.platform == "linux", "Linux inotify temporary fixture only")
    def test_watcher_real_kernel_rename_and_fd_cleanup(self):
        libc = C.ctypes.CDLL(None, use_errno=True)
        if not all(hasattr(libc, n) for n in ("inotify_init1", "inotify_add_watch")):
            self.skipTest("inotify libc API unavailable")
        with tempfile.TemporaryDirectory() as folder, patch.object(C.M, "UID", os.geteuid()):
            parent = Path(folder).resolve(); parent.chmod(0o700)
            notifier = C._ReadyInotify(parent)
            fds = (notifier.fd, notifier.parent_fd, notifier.stop_read, notifier.stop_write)
            try:
                pending = parent / "unit-temp"; pending.write_bytes(b"unit-only")
                os.replace(pending, parent / "mcp-route-update.json")
                self.assertTrue(C._ready_event_batch(notifier.wait(C.time.monotonic() + 5), notifier.wd))
                notifier.check_parent()
            finally: notifier.close()
            for fd in fds:
                with self.assertRaises(OSError): os.fstat(fd)


class ChangedCaseAdmissionTests(unittest.TestCase):
    @contextmanager
    def bindings(self, raw=None):
        with patch.multiple(C, CHANGED_PROFILE_SHA=U.pin(raw)["sha256"] if raw else "1" * 64,
                CHANGED_INCOMING_PROFILE_SHA="2" * 64,
                CHANGED_DELIVERY=(777, "unit-carrier.zip", 123, "4" * 64), create=True):
            yield

    def profile_value(self):
        value = T.profile()
        value["baseline"] = U.actual017_a1_data()
        for role, fixed in (("assembly16", value["baseline"]), ("assembly17", U.actual017_target_data())):
            value["artifacts"][role].update({k: copy.deepcopy(fixed[k]) for k in ("source", "tree", "run", "job", "artifact", "zip")})
            for name in ("raw", "deb"):
                value["artifacts"][role]["files"][value["objects"][name + role[-2:]]["member"]] = fixed[name]
            count = 23 if role == "assembly16" else 8
            while len(value["artifacts"][role]["files"]) < count:
                value["artifacts"][role]["files"]["synthetic-metadata-" + str(len(value["artifacts"][role]["files"]))] = {"size": 1, "sha256": "e" * 64}
        value["deliveries"]["signedDeb17"].update(asset=777, name="unit-carrier.zip", zip={"size": 123, "sha256": "4" * 64})
        for name in ("installer17", "installerSignature17", "outerPlan17", "outerApi17", "outerReceipt17"):
            member = "unit-" + name
            pin = (U.actual017_target_data()["deb"] if name == "installer17" else
                   {"size": 4909, "sha256": "fcc6587c46677a59bcdfec35c74fdd2b21da6d207fc045e0169f92eec84425d4"} if name == "outerPlan17" else
                   {"size": 1, "sha256": "f" * 64})
            value["deliveries"]["signedDeb17"]["files"][member] = pin
            value["objects"][name] = {"artifact": "signedDeb17", "member": member}
        return value

    def test_changed_missing_bindings_refuse_before_input_privilege_or_process(self):
        for name in ("changed_admission", "changed_prepare", "changed_session", "changed_broker", "changed_export"):
            with self.subTest(name=name), patch.object(U, "read") as read, \
                    patch.object(C.os, "geteuid", create=True) as uid, patch.object(C.subprocess, "Popen") as child:
                with self.assertRaisesRegex(RuntimeError, "UNBOUND"):
                    getattr(C, name)(environment())
                read.assert_not_called(); uid.assert_not_called(); child.assert_not_called()

    def test_changed_admission_retains_original_workflow_and_no_overrides(self):
        env = {**environment(), "UPDATE_PROFILE_SHA256": "1" * 64, "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256": "3" * 64}
        before = copy.deepcopy(U.FIXED)
        with self.bindings(), patch.object(U, "actual017_reopened_html_pages", create=True), \
                patch.object(M, "admission", return_value="migration-approve"):
            self.assertIsNone(C.changed_admission(env))
            for bad in ({"UPDATE_SCENARIO": "deb-native-cancel"}, {"UPDATE_PROFILE_SHA256": C.PROFILE_SHA},
                        {"CREATOR_MIGRATED_UPDATE_EXECUTE": "false"}, {"PYTHONPATH": "/foreign"}):
                with self.subTest(bad=bad), self.assertRaises(RuntimeError): C.changed_admission({**env, **bad})
        self.assertEqual(U.FIXED, before)

    def test_changed_profile_keeps_donor_separate_from_native_a1(self):
        value = self.profile_value(); raw = json.dumps(value).encode()
        with self.bindings(raw): self.assertEqual(C.changed_profile(raw), value)
        value["baseline"]["source"] = "f00cd4433e261f8d968b7c88c068dae59ec970a6"
        value["baseline"]["hub"]["sha256"] = "6fb2983c212b6bcd79f616019eca1b7f2f1daa3454d72cee7e6dc19bdc0dd5c9"
        raw = json.dumps(value).encode()
        with self.bindings(raw), self.assertRaisesRegex(RuntimeError, "donor"):
            C.changed_profile(raw)

    def test_changed_profile_rejects_old_actual_mixed_and_extra_roles(self):
        for mutate in (lambda p: p["artifacts"]["assembly17"].update(source=C.TARGET),
                       lambda p: p["deliveries"]["signedDeb17"].update(asset=682573088),
                       lambda p: p["artifacts"].update(extra=copy.deepcopy(p["artifacts"]["assembly17"]))):
            value = self.profile_value(); mutate(value); raw = json.dumps(value).encode()
            with self.bindings(raw), self.assertRaises(RuntimeError): C.changed_profile(raw)

    def test_changed_session_command_has_exact_mode_and_truthful_source(self):
        env = {**environment(), "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256": "3" * 64}
        with patch.object(C, "changed_admission", return_value=None, create=True):
            command = C.changed_session_command(env)
        self.assertEqual(command[-4:], ["/usr/bin/python3", "-B", str(C.CONTROL / "scripts/native-linux-migrated-update.py"), "session-changed-mcp"])
        self.assertIn("--setenv=GITHUB_SHA=" + env["GITHUB_SHA"], command)
        self.assertFalse(any(U.actual017_a1_data()["source"] in part for part in command))

    def test_changed_missing_reopened_factory_refuses_before_migration_or_input(self):
        env = {**environment(), "UPDATE_PROFILE_SHA256": "1" * 64, "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256": "3" * 64}
        with self.bindings(), patch.object(U, "actual017_reopened_html_pages", None, create=True), \
                patch.object(M, "admission", return_value="migration-approve") as migration, patch.object(U, "read") as read:
            with self.assertRaisesRegex(RuntimeError, "factory"):
                C.changed_admission(env)
            migration.assert_not_called(); read.assert_not_called()

    def acquisition_value(self, profile, env):
        current = T.delivery_api(profile, env)["run"]
        current["path"] = ".github/workflows/native-linux-production-016-migration.yml"
        current["head_branch"] = M.BRANCH.removeprefix("refs/heads/")
        carrier = profile["deliveries"]["signedDeb17"]
        return {"schemaVersion": 1, "source": env["GITHUB_SHA"], "run": int(env["GITHUB_RUN_ID"]),
                "attempt": int(env["GITHUB_RUN_ATTEMPT"]), "profileSha256": "1" * 64,
                "sourceReceiptSha256": "3" * 64, "harnessRun": current,
                "proof": {role: T.api(value) for role, value in profile["artifacts"].items()},
                "release": {"id": U.PRIVATE_RELEASE, "tag_name": U.PRIVATE_TAG, "draft": True},
                "asset": {"id": carrier["asset"], "name": carrier["name"], "size": carrier["zip"]["size"],
                          "digest": "sha256:" + carrier["zip"]["sha256"], "state": "uploaded"}, "dataOnly": True, **U.FALSE}

    def test_changed_acquisition_requires_original_current_run_api_not_context_string(self):
        env = {**environment(), "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256": "3" * 64}
        profile = self.profile_value(); value = self.acquisition_value(profile, env)
        with self.bindings():
            self.assertEqual(C.changed_acquisition(json.dumps(value).encode(), profile, env), value)
            for key, bad in (("head_sha", "f" * 40), ("path", ".github/workflows/native-linux-production-016-update.yml"),
                             ("head_branch", "validation/foreign"), ("conclusion", "success")):
                foreign = copy.deepcopy(value); foreign["harnessRun"][key] = bad
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    C.changed_acquisition(json.dumps(foreign).encode(), profile, env)

    def test_changed_acquisition_cannot_omit_source_api_or_cross_receipt_digest(self):
        env = {**environment(), "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256": "3" * 64}
        profile = self.profile_value()
        for change in ("missing-api", "source-receipt", "asset", "acceptance"):
            value = self.acquisition_value(profile, env)
            if change == "missing-api": del value["harnessRun"]
            elif change == "source-receipt": value["sourceReceiptSha256"] = "f" * 64
            elif change == "asset": value["asset"]["id"] = 682573088
            else: value["releaseReady"] = True
            with self.bindings(), self.subTest(change=change), self.assertRaises(RuntimeError):
                C.changed_acquisition(json.dumps(value).encode(), profile, env)


class ChangedCaseOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.f = T.Actual017OutcomeTests(methodName="runTest"); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(C, "U", T.M))

    def report(self):
        value = {**native_report(), **self.f.report(), "scope": "continuous-migrated-home-private017-lifecycle-only",
                 "case": "a1-actual017-changed-mcp", "beforeMigrationConnectionContinued": False}
        for name in ("homePreserved", "journalPrefixPreserved", "migrationEvidencePreserved"): value[name] = True
        for name in ("initialProjects", "successorProjects", "reopenedProjects"):
            value[name] = {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}
        image = self.f.report()["installed17"]["hub"]
        value["automaticSuccessor"] = dict(pid=400, startTime="4000", parentPid=100, uids=[M.UID] * 4,
            executable="/usr/bin/creator-hub", kernelImageSha256=image["sha256"], image={"st_size": image["size"]})
        value["reopenedRoot"] = {**value["automaticSuccessor"], "pid": 401, "startTime": "4001"}
        a1 = self.f.report()["installed16"]["hub"]
        value["initialRoot"] = {**value["automaticSuccessor"], "pid": 399, "startTime": "3999",
                                "kernelImageSha256": a1["sha256"], "image": {"st_size": a1["size"]}}
        for name, pid, owner in (("initialBus", 399, ":1.1"), ("automaticBus", 400, ":1.2"), ("reopenedBus", 401, ":1.3")):
            value[name] = {"pid": pid, "uid": M.UID, "owner": owner}
        value["secondB"] = dict(pid=401, exitCode=0, automaticBExitCode=0, projectsOnly=True,
            completedBefore=value["mcpProtocol"]["captures"]["completed"], completedAfter=value["mcpProtocol"]["captures"]["completed"],
            journalBefore={"revision": 1, "records": []}, journalAfter={"revision": 1, "records": []})
        value["reopenedHtmlWebDriver"] = dict(probePassed=False, probeReadOnly=False,
            projectsDocumentVerified=True, inputCountAtDocumentCheck=0, inputAttempts=[],
            launchRole="manual-second-b-projects", automaticRestartProof=False, detached=True,
            toolsClosedAfterRootExit=True, documentVersion="0.1.17", originalRoot=value["reopenedRoot"],
            manualExit={"pid": 401, "startTime": "4001", "exitCode": 0})
        return value

    def consume(self, value):
        return C.changed_outcome(value, self.f.f.inventories, None, self.f.f.paths)

    def test_changed_real_a_b_proof_accepted_only_by_fixed_new_composer(self):
        value = self.report(); before = copy.deepcopy(value)
        self.assertTrue(self.consume(value)); self.assertEqual(value, before)
        with self.assertRaises(RuntimeError): C.continuation_outcome(value)
        with self.assertRaises(RuntimeError): C.transition_continuation_outcome(value, self.f.f.inventories, None, self.f.f.paths)

    def test_changed_second_b_is_required_not_optional_or_reused_a(self):
        for key, bad in (("secondB", None), ("reopenedRoot", self.report()["automaticSuccessor"]),
                         ("reopenedProjects", {}), ("automaticRestartObserved", False), ("reopenedHtmlWebDriver", {})):
            value = self.report(); value[key] = bad
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.consume(value)

    def test_changed_second_b_exit_journal_and_completed_identity_are_exact(self):
        for key, bad in (("exitCode", 1), ("exitCode", False), ("automaticBExitCode", 1), ("projectsOnly", False),
                         ("journalAfter", {"revision": 1, "records": [{}]}), ("completedAfter", {"passed": True})):
            value = self.report(); value["secondB"][key] = bad
            with self.subTest(key=key, bad=bad), self.assertRaises(RuntimeError): self.consume(value)

    def test_changed_composer_does_not_trust_completed_or_installed_booleans(self):
        f = self.f.f
        value = self.report(); f.put(f.record, f.encode({**f.completed, "phase": {"Attempting": f.target("b")}}))
        with self.assertRaises(RuntimeError): self.consume(value)

    def test_changed_composer_rechecks_installed_b_not_provided_success(self):
        value = self.report(); self.f.f.put(self.f.f.b_descriptor / "runtime.minisig", b"tampered")
        with self.assertRaises(RuntimeError): self.consume(value)

    def test_changed_second_b_requires_real_distinct_root_session_bus_evidence(self):
        for key, bad in (("reopenedBus", {"pid": 401, "uid": M.UID, "owner": ":1.2"}),
                         ("automaticBus", {"pid": 399, "uid": M.UID, "owner": ":1.2"}), ("initialBus", {})):
            value = self.report(); value[key] = bad
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.consume(value)

    def test_changed_second_b_accepts_actual_manual_document_and_own_exit_evidence(self):
        fixture = T.Actual017ReopenedProjectsTests(methodName="runTest"); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        state = fixture.manual(); html = fixture.construct(state)
        state.child.wait.side_effect = lambda **_: setattr(state.child.poll, "return_value", -15)
        with fixture.running(state), patch.object(html, "retain_logs"):
            html.start(); html.detach(); state.original.poll.return_value = 0; html.finish_tools()
        value = self.report()
        for name, record in (("initialRoot", state.previous.html.previous.surface.record),
                             ("automaticSuccessor", state.previous.surface.record), ("reopenedRoot", state.surface.record)):
            value[name] = copy.deepcopy(record)
        for name, root in (("initialBus", "initialRoot"), ("automaticBus", "automaticSuccessor"), ("reopenedBus", "reopenedRoot")):
            value[name]["pid"] = value[root]["pid"]
        value["secondB"]["pid"] = state.original.pid
        value["reopenedHtmlWebDriver"] = copy.deepcopy(html.evidence)
        self.assertFalse(html.evidence["probePassed"]); self.assertNotIn("inputCountAtProbe", html.evidence)
        self.assertTrue(self.consume(value))

    def test_changed_second_b_cannot_claim_generic_probe_automatic_role_or_foreign_exit(self):
        for key, bad in (("probePassed", True), ("probeReadOnly", True), ("projectsDocumentVerified", False),
                         ("inputCountAtDocumentCheck", False), ("inputCountAtDocumentCheck", 1),
                         ("inputAttempts", ["view-mcp"]), ("launchRole", "automatic"), ("automaticRestartProof", True),
                         ("manualExit", {"pid": 400, "startTime": "4000", "exitCode": 0}),
                         ("manualExit", {"pid": 401, "startTime": "4001", "exitCode": False}),
                         ("originalRoot", self.report()["automaticSuccessor"]), ("inputCountAtProbe", 0), ("adoptedExit", {})):
            value = self.report(); value["reopenedHtmlWebDriver"][key] = bad
            with self.subTest(key=key, bad=bad), self.assertRaises(RuntimeError): self.consume(value)

    def test_changed_second_b_keeps_exact_two_pair_home_and_read_only_journal_checks(self):
        functions = {n.name: n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n, ast.FunctionDef)}
        source = ast.unparse(functions["changed_session"])
        self.assertIn("final_journal(sealed['journal'], M.journal(HOME))", source)
        self.assertIn("M.journal(HOME) == journal_before", source)
        guard = ast.unparse(next(n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n, ast.ClassDef) and n.name == "TransitionHomePreservation"))
        self.assertIn("final_journal(self.journal, current)", guard)
        before = append_reads({"revision": 1, "records": []}, "a")
        final = append_reads(append_reads(before, "b"), "c")
        self.assertEqual(C.final_journal(before, final), final)
        with self.assertRaises(RuntimeError): C.final_journal(before, append_reads(final, "d"))

    def test_changed_projects_helper_uses_actual_manual_closed_request_contract(self):
        fixture = T.Actual017ReopenedProjectsTests(methodName="runTest"); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        state = fixture.manual(); html = fixture.construct(state); home = Path("/fixed/migrated-home")
        element_key = "element-6066-11e4-a52e-4f735466cecf"
        state.changed["#project-list .project-row:elements"] = [{element_key: "row-current"}, {element_key: "row-missing"}]
        for selected, name in (("true", "current-project"), ("false", "missing-project")):
            state.changed['#project-list .project-row[data-mcp-selected="' + selected + '"] .project-info small:text'] = str(home / name)
        report = {}
        with fixture.running(state):
            html.start()
            with patch.object(C.U, "read", return_value=b'{"restoreHostedViews":false}'):
                C.projects(html, home, report, "reopenedProjects")
            for selector in ("#project-list .project-row ", "#project-list .project-row[data-mcp-selected='true']",
                             '#project-list .project-row[data-mcp-selected="TRUE"]', "#feature-mcp", "#feature-setup"):
                before = len(state.requests)
                with self.subTest(selector=selector), self.assertRaises(RuntimeError): html.d.elements(selector)
                self.assertEqual(len(state.requests), before)
        self.assertEqual(report, {"reopenedProjects": {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}})
        self.assertEqual(html.evidence["inputAttempts"], [])


class ChangedCaseStagingTests(unittest.TestCase):
    def home_fixture(self):
        value = TransitionHomeTests(methodName="runTest"); value.setUp(); self.addCleanup(value.doCleanups)
        return value

    def test_changed_extracts_actual_fourteen_b_inputs_from_verified_original_archive(self):
        fixture = self.home_fixture()
        inventory, bodies = C.changed_resources(fixture.manifests["b"], fixture.archives["b"])
        self.assertEqual(inventory, fixture.f.inventories["b"])
        self.assertEqual(len(inventory), 14)
        for name, raw in bodies.items(): self.assertEqual(U.pin(raw), inventory[name])
        self.assertNotIn("setup/creator-project-setup", bodies)

    def test_changed_archive_side_mix_and_missing_member_refuse(self):
        fixture = self.home_fixture()
        with self.assertRaises(RuntimeError): C.changed_resources(fixture.manifests["b"], fixture.archives["a"])
        manifest = json.loads(fixture.manifests["b"])
        del manifest["modules"]["mcp"]["files"]["mcp/server/creator-works-mcp.mjs"]
        with self.assertRaises(RuntimeError): C.changed_resources(json.dumps(manifest).encode(), fixture.archives["b"])

    @contextmanager
    def root_staging(self):
        lstat, fstat = Path.lstat, os.fstat
        def owned(value):
            # Model only Linux ownership/directory permissions, not file identity/content.
            row = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
            row.update(st_uid=0, st_gid=0)
            if stat.S_ISDIR(value.st_mode): row["st_mode"] = stat.S_IFDIR | 0o755
            return SimpleNamespace(**row)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve() / "sealed"
            with patch.multiple(C.os, getuid=lambda: 0, geteuid=lambda: 0, create=True), \
                    patch.object(U, "protected_ancestry") as ancestry, \
                    patch.object(Path, "lstat", lambda file: owned(lstat(file))), \
                    patch.object(C.os, "fstat", lambda fd: owned(fstat(fd))):
                yield root, ancestry

    def test_changed_staging_exclusive_exact_bytes_0444_without_permission_repair(self):
        with self.root_staging() as (root, ancestry):
            C.changed_publish_files(root, {"routing/runtime.json": b"actual temp bytes", "mcp/server/a.mjs": b"source"})
            ancestry.assert_called_once_with(root.parent)
            for name, raw in (("routing/runtime.json", b"actual temp bytes"), ("mcp/server/a.mjs", b"source")):
                self.assertEqual(U.read(root / name, uid=0, mode=0o444), raw)
                self.assertEqual((root / name).stat().st_nlink, 1)
            with self.assertRaises(FileExistsError): C.changed_publish_files(root, {"foreign": b"replacement"})
            self.assertFalse((root / "foreign").exists())

    def test_changed_staging_wrong_mode_or_new_hardlink_refuses(self):
        real_write = U.write
        for change in ("mode", "hardlink"):
            with self.subTest(change=change), self.root_staging() as (root, _):
                def write(file, raw, mode):
                    real_write(file, raw, mode)
                    if change == "mode": file.chmod(0o644)
                    else: os.link(file, root / "unexpected-link")
                with patch.object(U, "write", side_effect=write), self.assertRaises(RuntimeError):
                    C.changed_publish_files(root, {"runtime.json": b"bytes"})

    def test_changed_staging_foreign_uid_is_not_repaired(self):
        with self.root_staging() as (root, _):
            actual_lstat = Path.lstat
            def info(file):
                value = actual_lstat(file)
                if file.name != "runtime.json": return value
                row = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
                return SimpleNamespace(**{**row, "st_uid": 999, "st_gid": 999})
            with patch.object(Path, "lstat", info), self.assertRaisesRegex(RuntimeError, "Bounded owned nonlinked"):
                C.changed_publish_files(root, {"runtime.json": b"bytes"})

    def test_changed_staging_escape_and_nonroot_refuse(self):
        with self.root_staging() as (root, _), self.assertRaises(RuntimeError):
            C.changed_publish_files(root, {"../escaped": b"bytes"})
        with patch.multiple(C.os, getuid=lambda: M.UID, geteuid=lambda: M.UID, create=True), \
                patch.object(Path, "mkdir") as mkdir, self.assertRaises(RuntimeError):
            C.changed_publish_files(Path("/unit/sealed"), {"file": b"bytes"})
        mkdir.assert_not_called()


class ChangedCaseSourceTests(unittest.TestCase):
    def test_changed_plumbing_is_additive_and_does_not_rewrite_product_source_env(self):
        tree = ast.parse(Path(C.__file__).read_bytes())
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        expected = {"admission": "d66104f08132ae0df06d1b49a0c1e239961f42fad2acfee66a0febc5c171b107",
                    "main": "14e5672d720e9629731549ced856680b7724a70d3c827e8554829dff871645a9"}
        for name, digest in expected.items():
            raw = ast.dump(ast.Module(body=[functions[name]], type_ignores=[]), include_attributes=False).encode()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), digest)
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or not node.name.startswith("changed_"): continue
            for assign in ast.walk(node):
                if isinstance(assign, ast.Assign):
                    self.assertNotIn("U.FIXED", " ".join(ast.unparse(target) for target in assign.targets))
                    self.assertNotIn("env['GITHUB_SHA']", " ".join(ast.unparse(target) for target in assign.targets))

    def test_changed_session_wires_both_captures_and_included_owned_second_b(self):
        tree = ast.parse(Path(C.__file__).read_bytes()); functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        source = ast.unparse(functions["changed_session"])
        for text in ("U.TransitionProtocolCapture", "changed_arm_session", "U.actual017_authorize", "U.observe_successor",
                     "U.actual017_reopened_html_pages", "protocol.complete()", "protocol.finish()", "U.actual017_verify_installed", "Gio.BusType.SESSION"):
            self.assertIn(text, source)
        self.assertNotIn("complete_mcp_protocol", source)
        self.assertNotIn("mcp_protocol_receipt(", source)
        self.assertLess(source.index("changed_arm_session"), source.index("html.click('#hub-update-button'"))
        self.assertLess(source.index("replacement_html.finish_tools()"), source.index("reopened = subprocess.Popen"))
        self.assertNotIn("reopened_html.direct_pages", source)
        self.assertNotIn("reopened_html.home", source)
        broker = ast.unparse(functions["changed_broker"])
        self.assertIn("BrokerReadyWatcher", broker); self.assertIn("U.actual017_pending_proof", broker)
        self.assertGreaterEqual(broker.count("changed_outcome("), 2)
        self.assertGreaterEqual(broker.count("home_guard.finish()"), 2)

    def test_changed_automatic_successor_observed_exactly_once_separate_from_historical(self):
        tree = ast.parse(Path(C.__file__).read_bytes())
        native = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "changed_session")
        def check(node):
            calls = [n for n in ast.walk(node) if isinstance(n, ast.Call)]
            self.assertEqual(sum(ast.unparse(n.func) == "U.observe_successor" for n in calls), 1)
            launches = [n for n in calls if ast.unparse(n.func) == "subprocess.Popen"]
            self.assertEqual(sum("/usr/bin/creator-hub" in ast.unparse(n.args[0]) for n in launches), 2)
        check(native)
        duplicate = copy.deepcopy(native)
        duplicate.body.append(ast.Expr(value=ast.Call(func=ast.Attribute(value=ast.Name(id="U", ctx=ast.Load()), attr="observe_successor", ctx=ast.Load()), args=[], keywords=[])))
        with self.assertRaises(AssertionError): check(duplicate)


class ChangedCaseVerifierTests(unittest.TestCase):
    def report(self, mode):
        target = U.actual017_target_data()
        flags = ("nativeGuiAccepted", "migrationAccepted", "authenticationAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady",
                 "privateModulesRecompiled", "privateModulesResigned", "rootRecompiled", "applicationLaunched", "approvedForStable", "approvedForPrerelease")
        return {"scope": "private-linux-deb-update-017", "mode": mode, "sourceVersion": "0.1.16", "targetVersion": "0.1.17",
                "deb": target["deb"], "rawHub": target["raw"], "installedHub": target["hub"], "fullResourcesVerified": True,
                "signaturesVerified": mode == "verify", "acceptanceOnly": True, **dict.fromkeys(flags, False)}

    def test_changed_fixed_verifier_report_distinguishes_inspect_and_signed_verify(self):
        for mode in ("inspect", "verify"):
            value = self.report(mode)
            self.assertEqual(C.changed_fixture_report(json.dumps(value).encode(), mode), value)
        value = self.report("inspect")
        with self.assertRaises(RuntimeError): C.changed_fixture_report(json.dumps(value).encode(), "verify")

    def test_changed_verifier_wrong_installed_image_claimed_signatures_and_scope_refuse(self):
        for key, bad in (("installedHub", U.actual017_target_data()["raw"]), ("signaturesVerified", False),
                         ("fullResourcesVerified", False), ("approvedForStable", True), ("scope", "foreign")):
            value = self.report("verify"); value[key] = bad
            with self.subTest(key=key), self.assertRaises(RuntimeError): C.changed_fixture_report(json.dumps(value).encode(), "verify")

    def test_changed_builder_refuses_root_before_source_or_commands(self):
        with patch.object(C, "changed_admission"), patch.multiple(C.os, getuid=lambda: 0, geteuid=lambda: 0, create=True), \
                patch.object(C, "changed_source_receipt") as source, patch.object(C.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Nonroot"):
                C.changed_build_installer_verifier(environment())
            source.assert_not_called(); run.assert_not_called()

    def test_changed_verifier_missing_actual_build_receipt_cannot_run_tool(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(C.subprocess, "run") as run:
            with self.assertRaises(FileNotFoundError): C.changed_installer_verifier({**environment(), "RUNNER_TEMP": folder})
            run.assert_not_called()

    def test_changed_builder_and_verifier_keep_exact_source_and_cli_contract(self):
        functions = {n.name: n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n, ast.FunctionDef)}
        builder = ast.unparse(functions["changed_build_installer_verifier"])
        for expected in ("'--example', 'private-deb017-dea67'", "'--example', 'private-deb017-dea67-guards'", "'--locked'", "'--no-default-features'", "actual_b017_guard_regressions"):
            self.assertIn(expected, builder)
        self.assertNotIn("'--bin'", builder)
        verifier = ast.unparse(functions["changed_verify_installer_signature"])
        self.assertEqual([a.arg for a in functions["changed_verify_installer_signature"].args.args], ["folder", "value", "original"])
        self.assertIn("'inspect'", verifier); self.assertIn("'verify'", verifier)
        self.assertIn("obj('deb17'), obj('raw17'), manifest, modules", verifier)
        self.assertNotIn("U.signature(", verifier)
        self.assertEqual(C.CHANGED_INSTALLER_SOURCES["src-tauri/examples/private-deb017-dea67.rs"],
            {"size": 20520, "sha256": "e9f6b5de863cb6c8004c0db741c58bcab1d6656e236b34c26429225263ca719f"})
        self.assertEqual(C.CHANGED_PROFILE_SHA, "1fd56c76f100422e2c380e19cfc5dfb9da4ecf05a6348efdba99bbaebb5cd792")

    def test_changed_linux_oracle_and_real_guard_inputs_precede_guard_execution(self):
        functions = {n.name: n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n, ast.FunctionDef)}
        source = ast.unparse(functions["changed_build_installer_verifier"])
        self.assertIn("((unit, 23), (guards, 6))", source)
        self.assertNotIn("((unit, 22)", source)
        self.assertLess(source.index("U.stage_zip("), source.index("guards = command("))
        for name in ("ACTUAL_B017_ROOT", "B017_PUBLIC_BODY", "B017_PUBLIC_SIGNATURE"):
            self.assertLess(source.index(name), source.index("guards = command("))
        self.assertIn("'actual_b017_guard_regressions'], guard_env", source)
        proof = (HERE.parent / "src-tauri/src/update_target.rs").read_text()
        self.assertIn('#[cfg(target_os = "linux")]\n    #[test]\n    fn tauri_inherited_restart_selection_is_refused_for_system_packages', proof)

    def test_changed_linux_unit_oracle_exact_source_count_common22_plus_linux1(self):
        inputs = ("src-tauri/examples/private-deb017-dea67.rs", "src-tauri/src/catalog.rs", "src-tauri/src/update_target.rs")
        counts = []
        for name, expected in zip(inputs, (4, 10, 9)):
            raw = (HERE.parent / name).read_bytes()
            self.assertEqual(U.pin(raw), C.CHANGED_INSTALLER_SOURCES[name])
            count = raw.count(b"#[test]"); self.assertEqual(count, expected); counts.append(count)
        target = (HERE.parent / inputs[-1]).read_bytes()
        linux_only = b'#[cfg(target_os = "linux")]\n    #[test]'
        self.assertEqual(target.count(linux_only), 1)
        self.assertEqual(sum(counts), 23); self.assertEqual(sum(counts) - target.count(linux_only), 22)


class ChangedCaseExportTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, foreign=None):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            runner = Path(folder).resolve(); base = runner / "native"; base.mkdir()
            control = base / "control"; control.mkdir(); output = base / "session"; output.mkdir()
            tool = runner / "native-linux-production-016-actual017-verifier"; (tool / "logs").mkdir(parents=True)
            stack.enter_context(patch.multiple(C, BASE=base, CONTROL=control, OUTPUT=output, INTENT=base / "intent.json"))
            stack.enter_context(patch.object(C, "changed_admission"))
            stack.enter_context(patch.multiple(C.os, getuid=lambda: 0, geteuid=lambda: 0, chown=lambda *args: None, create=True))
            actual_lstat, actual_stat, actual_read = Path.lstat, Path.stat, C.U.read
            runner_uid = 1001
            def owner(file):
                if file == foreign: return 9876
                return runner_uid if file.is_relative_to(tool) or not file.is_relative_to(base) else M.UID
            def modeled(file, value):
                return SimpleNamespace(**{**{n: getattr(value, n) for n in dir(value) if n.startswith("st_")}, "st_uid": owner(file)})
            stack.enter_context(patch.object(Path, "lstat", lambda file: modeled(file, actual_lstat(file))))
            stack.enter_context(patch.object(Path, "stat", lambda file, *args, **kwargs: modeled(file, actual_stat(file, *args, **kwargs))))
            reads = []
            def read(file, maximum=262144, *, uid=None, mode=None):
                # Model only Linux UID at this boundary; retain actual canonical/link/size/stable-read guards.
                self.assertEqual(uid, owner(file)); reads.append((file, maximum))
                with patch.object(Path, "lstat", actual_lstat), patch.object(Path, "stat", actual_stat):
                    return actual_read(file, maximum, mode=mode)
            stack.enter_context(patch.object(C.U, "read", side_effect=read))
            yield runner, base, output, tool, reads

    def export(self, runner):
        C.changed_export({"RUNNER_TEMP": str(runner)})
        folder = runner / "native-linux-migrated-update-evidence"
        return folder, json.loads((folder / "export.json").read_bytes())["files"]

    def test_changed_export_retains_actual_reopened_projects_driver_pair(self):
        with self.fixture() as (runner, _, output, _, _):
            expected = {}
            for name in ("reopened-projects-html-driver.stdout", "reopened-projects-html-driver.stderr"):
                expected[str(output / name)] = name.encode(); (output / name).write_bytes(name.encode())
            folder, rows = self.export(runner)
            exported = {row["source"]: (folder / row["member"]).read_bytes() for row in rows if "member" in row}
            self.assertEqual(exported, expected)
            self.assertFalse(any("reopened-html-driver." in row["source"] for row in rows))

    def test_changed_failed_build_export_keeps_fixed_runner_logs_and_explicit_missing(self):
        labels = ("rustup", "cargo-path", "cargo-version", "rustc-path", "rustc-version", "build", "unit", "guards", "inspect", "verify")
        with self.fixture() as (runner, _, _, tool, reads):
            expected = {}
            for label in labels[:6]:
                for suffix in ("stdout", "stderr", "json"):
                    file = tool / "logs" / (label + "." + suffix)
                    raw = ("compiler error" if label == "build" and suffix == "stderr" else file.name).encode()
                    file.write_bytes(raw); expected[str(file)] = raw
            (tool / "unapproved.key").write_bytes(b"must not export")
            (tool / "private-deb017-dea67").write_bytes(b"must not export ELF")
            folder, rows = self.export(runner)
            sources = {row["source"]: row for row in rows if row["source"].startswith(str(tool))}
            exact = {str(tool / "logs" / (label + "." + suffix)) for label in labels for suffix in ("stdout", "stderr", "json")} | {str(tool / "receipt.json"), str(tool / "logs/cargo-output.json")}
            self.assertEqual(set(sources), exact)
            for source in exact:
                row = sources[source]
                if source in expected: self.assertEqual((folder / row["member"]).read_bytes(), expected[source])
                else: self.assertEqual(row, {"source": source, "missing": True})
            self.assertTrue(all(maximum == 2 * 1024**2 for _, maximum in reads))

    def test_changed_export_runner_receipt_is_finite_not_other_tool_inputs(self):
        with self.fixture() as (runner, _, _, tool, _):
            (tool / "receipt.json").write_bytes(b'{"releaseReady":false}')
            folder, rows = self.export(runner)
            row = next(row for row in rows if row["source"] == str(tool / "receipt.json"))
            self.assertEqual((folder / row["member"]).read_bytes(), b'{"releaseReady":false}')

    def test_changed_export_runner_owner_not_admitted_for_native_evidence(self):
        with self.fixture() as (runner, base, _, _, _):
            file = base / "intent.json"; file.write_bytes(b"native")
            actual = Path.lstat
            def info(path):
                value = actual(path)
                return SimpleNamespace(**{**vars(value), "st_uid": 1001}) if path == file else value
            with patch.object(Path, "lstat", info), self.assertRaisesRegex(RuntimeError, "Foreign export owner"):
                self.export(runner)

    def test_changed_export_foreign_runner_log_or_oversize_or_link_refuses(self):
        for defect in ("owner", "size", "link"):
            with self.subTest(defect=defect), self.fixture() as (runner, _, _, tool, _):
                file = tool / "logs/build.stderr"; file.write_bytes(b"error")
                if defect == "owner":
                    actual = Path.lstat
                    def info(path):
                        value = actual(path)
                        return SimpleNamespace(**{**vars(value), "st_uid": 9876}) if path == file else value
                    with patch.object(Path, "lstat", info), self.assertRaisesRegex(RuntimeError, "Foreign.*owner"):
                        self.export(runner)
                else:
                    if defect == "size": file.write_bytes(b"x" * (2 * 1024**2 + 1))
                    else: os.link(file, tool / "not-exported-link")
                    with self.assertRaisesRegex(RuntimeError, "Bounded owned nonlinked"):
                        self.export(runner)


class ChangedCargoCopyTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, linked=True):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            temporary = Path(folder).resolve(); workspace = temporary / "workspace"; workspace.mkdir()
            runner = temporary / "runner"; runner.mkdir()
            root = runner / "native-linux-production-016-actual017-verifier"; root.mkdir(); (root / "logs").mkdir()
            file = workspace / "src-tauri/target/release/examples/private-deb017-dea67"; file.parent.mkdir(parents=True)
            raw = bytearray(64); raw[:7] = b"\x7fELF\x02\x01\x01"; raw[18:20] = b"\x3e\x00"; raw = bytes(raw)
            file.write_bytes(raw)
            if linked: os.link(file, file.with_name("private-deb017-dea67-hashed"))
            state = SimpleNamespace(env={"GITHUB_WORKSPACE": str(workspace), "RUNNER_TEMP": str(runner)}, file=file,
                workspace=workspace, runner=runner, root=root, copied=root / "private-deb017-dea67", raw=raw,
                modes={}, owners={}, kinds={}, opened=[], fds={})
            lstat, fstat, opened, closed = Path.lstat, os.fstat, os.open, os.close
            def modeled(path, info):
                values = {n: getattr(info, n) for n in dir(info) if n.startswith("st_")}
                mode = 0o700 if path in (root, root / "logs") else 0o755 if stat.S_ISDIR(info.st_mode) or path in (file, state.copied) else stat.S_IMODE(info.st_mode)
                values.update(st_uid=state.owners.get(path, 1001), st_gid=1001,
                    st_mode=state.kinds.get(path, stat.S_IFMT(info.st_mode)) | state.modes.get(path, mode))
                return SimpleNamespace(**values)
            def open_file(path, *args, **kwargs):
                fd = opened(path, *args, **kwargs); state.fds[fd] = Path(path); state.opened.append(Path(path)); return fd
            def close_file(fd):
                try: return closed(fd)
                finally: state.fds.pop(fd, None)
            stack.enter_context(patch.multiple(C.os, getuid=lambda:1001, geteuid=lambda:1001, create=True))
            stack.enter_context(patch.object(Path, "lstat", lambda path: modeled(path, lstat(path))))
            stack.enter_context(patch.object(C.os, "fstat", lambda fd: modeled(state.fds[fd], fstat(fd))))
            stack.enter_context(patch.object(C.os, "open", side_effect=open_file))
            stack.enter_context(patch.object(C.os, "close", side_effect=close_file))
            yield state
            self.assertFalse(state.fds, "Owned file descriptors must close on success and refusal")

    def test_linked_cargo_output_is_copied_to_exclusive_single_link_elf(self):
        with self.fixture() as f:
            self.assertEqual(f.file.lstat().st_nlink, 2)
            with self.assertRaisesRegex(RuntimeError, "Bounded owned nonlinked"):
                U.read(f.file, 64 * 1024**2, uid=1001, mode=0o755)
            opening = C.os.open
            def observed(path, *args, **kwargs):
                if Path(path) == f.file:
                    diagnostic = f.root / "logs/cargo-output.json"
                    self.assertTrue(diagnostic.exists(), "Stat diagnostic must precede source open")
                return opening(path, *args, **kwargs)
            with patch.object(C.os, "open", side_effect=observed):
                copied, raw = C.changed_copy_cargo_verifier(f.env)
            self.assertEqual(copied, f.copied); self.assertEqual(raw, f.raw)
            self.assertEqual(U.read(copied, 64 * 1024**2, uid=1001, mode=0o755), f.raw)
            self.assertEqual(copied.lstat().st_nlink, 1); self.assertEqual(f.file.lstat().st_nlink, 2)
            diagnostic = f.root / "logs/cargo-output.json"
            value = json.loads(diagnostic.read_bytes())
            self.assertEqual(set(value), {"path", "kind", "mode", "uid", "gid", "nlink", "size", "stamp"})
            self.assertEqual({k:v for k,v in value.items() if k != "stamp"},
                dict(path=str(f.file), kind="regular", mode=0o755, uid=1001, gid=1001, nlink=2, size=len(f.raw)))
            self.assertEqual(stat.S_IMODE(diagnostic.lstat().st_mode), 0o444)

    def test_single_link_cargo_output_also_copies_without_relaxing_global_reader(self):
        with self.fixture(linked=False) as f:
            self.assertEqual(C.changed_copy_cargo_verifier(f.env), (f.copied, f.raw))
            os.link(f.copied, f.root / "private-hardlink")
            with self.assertRaisesRegex(RuntimeError, "Bounded owned nonlinked"):
                U.read(f.copied, uid=1001, mode=0o755)

    def test_copy_refuses_foreign_output_or_ancestry_owner(self):
        for role in ("file", "parent", "workspace", "private", "runner"):
            with self.subTest(role=role), self.fixture() as f:
                path = {"file":f.file, "parent":f.file.parent, "workspace":f.workspace, "private":f.root, "runner":f.runner}[role]
                f.owners[path] = 9999
                with self.assertRaises(RuntimeError): C.changed_copy_cargo_verifier(f.env)
                self.assertFalse(f.copied.exists()); self.assertNotIn(f.file, f.opened)

    def test_copy_refuses_source_mode_and_nonprivate_root_and_nonregular_output(self):
        for defect in ("mode", "private-mode", "directory", "symlink"):
            with self.subTest(defect=defect), self.fixture() as f:
                if defect == "mode": f.modes[f.file] = 0o644
                elif defect == "private-mode": f.modes[f.root] = 0o755
                elif defect == "directory": f.kinds[f.file] = stat.S_IFDIR
                else: f.kinds[f.file] = stat.S_IFLNK
                with self.assertRaises(RuntimeError): C.changed_copy_cargo_verifier(f.env)
                self.assertFalse(f.copied.exists()); self.assertNotIn(f.file, f.opened)

    def test_copy_refuses_noncanonical_source_root_or_destination_ancestor(self):
        for key in ("GITHUB_WORKSPACE", "RUNNER_TEMP"):
            with self.subTest(key=key), self.fixture() as f:
                original = Path(f.env[key]); f.env[key] = str(original / ".." / original.name)
                with self.assertRaises(RuntimeError): C.changed_copy_cargo_verifier(f.env)
                self.assertNotIn(f.file, f.opened)
        with self.fixture() as f:
            f.kinds[f.file.parent] = stat.S_IFLNK
            with self.assertRaises(RuntimeError): C.changed_copy_cargo_verifier(f.env)
            self.assertNotIn(f.file, f.opened)

    def test_copy_refuses_preexisting_private_output_without_overwrite(self):
        with self.fixture() as f:
            f.copied.write_bytes(b"owned but already spent")
            with self.assertRaises(RuntimeError): C.changed_copy_cargo_verifier(f.env)
            self.assertEqual(f.copied.read_bytes(), b"owned but already spent")

    def test_copy_refuses_zero_or_overflow_before_source_open(self):
        for size in (0, 64 * 1024**2 + 1):
            with self.subTest(size=size), self.fixture() as f:
                with f.file.open("wb") as stream: stream.truncate(size)
                with self.assertRaises(RuntimeError): C.changed_copy_cargo_verifier(f.env)
                self.assertNotIn(f.file, f.opened); self.assertFalse(f.copied.exists())

    def test_copy_refuses_held_descriptor_drift_and_named_file_replacement(self):
        for defect in ("held", "named"):
            with self.subTest(defect=defect), self.fixture() as f:
                original_open, original_lstat = C.os.open, Path.lstat
                replaced = False
                def info(path):
                    value = original_lstat(path)
                    if path == f.file and replaced:
                        return SimpleNamespace(**{**vars(value), "st_ino": value.st_ino + 1})
                    return value
                def open_file(path, *args, **kwargs):
                    nonlocal replaced
                    fd = original_open(path, *args, **kwargs)
                    if Path(path) == f.file:
                        if defect == "held": os.link(f.file, f.file.with_name("new-hardlink"))
                        elif os.name == "nt":
                            # Windows disallows rename over the open source; model only the named inode boundary.
                            replaced = True
                        else:
                            replacement = f.file.with_name("replacement"); replacement.write_bytes(f.raw); os.replace(replacement, f.file)
                    return fd
                with patch.object(Path, "lstat", info), patch.object(C.os, "open", side_effect=open_file), self.assertRaises(RuntimeError):
                    C.changed_copy_cargo_verifier(f.env)
                self.assertFalse(f.copied.exists())

    def test_copy_rechecks_source_nlink_and_private_single_link_after_write(self):
        for defect in ("source-link", "private-link", "parent-drift"):
            with self.subTest(defect=defect), self.fixture() as f:
                original_write = U.write
                def write(path, raw, mode=0o600):
                    original_write(path, raw, mode)
                    if path == f.copied:
                        if defect == "source-link": os.link(f.file, f.file.with_name("new-link"))
                        elif defect == "private-link": os.link(f.copied, f.root / "new-link")
                        else: f.modes[f.file.parent] = 0o700
                with patch.object(U, "write", side_effect=write), self.assertRaises(RuntimeError):
                    C.changed_copy_cargo_verifier(f.env)

    def test_copy_refuses_short_or_overlong_capture(self):
        for raw in (b"short", b"x" * 65):
            with self.subTest(size=len(raw)), self.fixture() as f:
                with patch.object(C.os, "read", side_effect=[raw, b""]), self.assertRaises(RuntimeError):
                    C.changed_copy_cargo_verifier(f.env)
                self.assertFalse(f.copied.exists())

    def test_copy_refuses_non_elf_or_wrong_architecture_before_private_publish(self):
        for defect in ("format", "architecture"):
            with self.subTest(defect=defect), self.fixture() as f:
                raw = bytearray(f.raw)
                if defect == "format": raw[:2] = b"MZ"
                else: raw[18:20] = b"\xb7\x00"
                f.file.write_bytes(raw)
                with self.assertRaisesRegex(RuntimeError, "ELF"): C.changed_copy_cargo_verifier(f.env)
                self.assertFalse(f.copied.exists())

    def test_copy_nonroot_role_and_fixed_no_path_callback_api(self):
        import inspect
        self.assertEqual(list(inspect.signature(C.changed_copy_cargo_verifier).parameters), ["env"])
        with patch.multiple(C.os, getuid=lambda:0, geteuid=lambda:0, create=True), patch.object(U, "save") as save:
            with self.assertRaisesRegex(RuntimeError, "Nonroot"): C.changed_copy_cargo_verifier({})
            save.assert_not_called()

    def test_builder_keeps_oracles_and_uses_private_copy_only_after_exact_qualification(self):
        functions = {n.name:n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n, ast.FunctionDef)}
        source = ast.unparse(functions["changed_build_installer_verifier"])
        self.assertIn("((unit, 23), (guards, 6))", source)
        self.assertLess(source.index("((unit, 23), (guards, 6))"), source.index("changed_copy_cargo_verifier(env)"))
        self.assertLess(source.index("changed_copy_cargo_verifier(env)"), source.index("command('inspect'"))
        self.assertNotIn("U.read(built", source); self.assertNotIn("U.write(tool, body", source)

    def test_fixed_runner_cargo_stat_diagnostic_is_exported_without_extra_paths(self):
        export = ChangedCaseExportTests(methodName="runTest")
        with export.fixture() as (runner, _, _, tool, _):
            file = tool / "logs/cargo-output.json"; raw = b'{"path":"fixed-cargo-output","nlink":2}'
            file.write_bytes(raw); file.chmod(0o444)
            (tool / "logs/cargo-other.json").write_bytes(b"not admitted")
            folder, rows = export.export(runner)
            retained = [row for row in rows if "member" in row]
            self.assertEqual(len(retained), 1); self.assertEqual(retained[0]["source"], str(file))
            self.assertEqual((folder / retained[0]["member"]).read_bytes(), raw)


class ChangedCaseTransportTests(unittest.TestCase):
    def test_changed_transport_uses_separate_fixed_operation_and_carries_source_digest(self):
        env = {**environment(), "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256": "3" * 64, "UNREVIEWED": "not-forwarded"}
        with patch.object(C, "changed_admission"), \
                patch.object(U, "PipeChild", side_effect=RuntimeError("unit boundary before child")) as child, \
                patch.object(U, "read") as read:
            context = C.changed_transport_environment(env); root = U.transport_path(context)
            with self.assertRaisesRegex(RuntimeError, "before child"):
                C.changed_start_transport(env, root, {})
        child.assert_called_once_with([env["CONTROLLER_NODE"], str(C.CONTROL / "scripts/linux-update-lab-feed.cjs"),
            "update-changed-mcp-016-017", "deb", str(root)], context, "transport", synthetic=True)
        self.assertEqual(context["CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256"], "3" * 64)
        self.assertEqual(context["GITHUB_SHA"], env["GITHUB_SHA"])
        self.assertNotIn("UNREVIEWED", context); read.assert_not_called()


class HomeDirectoryDiagnosticTests(unittest.TestCase):
    @contextmanager
    def fixture(self, **changes):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            home = Path(folder).resolve() / "home"; home.mkdir()
            path = home / "data/bad"; path.mkdir(parents=True)
            actual = path.lstat(); uid = actual.st_uid
            fields = {key:getattr(actual,key) for key in ("st_dev","st_ino","st_mode","st_uid","st_gid","st_nlink","st_size","st_mtime_ns","st_ctime_ns")}
            fields.update(st_mode=stat.S_IFDIR | 0o775,st_uid=uid,st_gid=uid)
            fields.update(changes); before = SimpleNamespace(**fields)
            calls = []
            def lstat(candidate):
                self.assertEqual(candidate,path); calls.append(candidate)
                self.assertEqual(len(calls),1,"Diagnostic must not replace cached stat with another query")
                return before
            stack.enter_context(patch.object(C,"HOME",home))
            stack.enter_context(patch.object(C.M,"UID",uid))
            stack.enter_context(patch.object(Path,"lstat",lstat))
            stack.enter_context(patch.object(Path,"resolve",lambda candidate,strict=False:candidate))
            yield SimpleNamespace(home=home,path=path,before=before,uid=uid,calls=calls,fields=fields)

    def error(self, f):
        original_require = C.require; errors = []
        def checked(value,message):
            try: original_require(value,message)
            except RuntimeError as error: errors.append(error); raise
        with patch.object(C,"require",side_effect=checked), self.assertRaisesRegex(RuntimeError,"^Owned canonical directory required$") as raised:
            C.directory(f.path,f.uid)
        self.assertIs(raised.exception,errors[0]); self.assertEqual(len(f.calls),1)
        return raised.exception

    def broker_handler(self, error, record):
        tree = ast.parse(Path(C.__file__).read_bytes())
        broker = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="changed_broker")
        handler = next(n.handlers[0] for n in broker.body if isinstance(n,ast.Try) and n.handlers)
        function = ast.FunctionDef(name="actual_broker_failure",args=ast.arguments(posonlyargs=[],args=[ast.arg(arg="error"),ast.arg(arg="record")],kwonlyargs=[],kw_defaults=[],defaults=[]),
            body=[ast.Try(body=[ast.Raise(exc=ast.Name(id="error",ctx=ast.Load()))],handlers=[copy.deepcopy(handler)],orelse=[],finalbody=[]),
                  ast.Return(value=ast.Name(id="failure",ctx=ast.Load()))],decorator_list=[])
        namespace = dict(vars(C)); exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),"actual-broker-error-handler","exec"),namespace)
        return namespace["actual_broker_failure"](error,record)

    def test_same_refusal_keeps_exact_cached_lstat_fixture_path_uid_and_exception(self):
        with self.fixture() as f:
            error = self.error(f)
            self.assertIs(error._directory_diagnostic_origin,C._DIRECTORY_DIAGNOSTIC_ORIGIN)
            self.assertEqual(error.directory_refusal,{"relativePath":"data/bad","expectedUid":f.uid,"lstat":f.fields})
            record = {}; self.assertIs(self.broker_handler(error,record),error)
            self.assertEqual(record["refusal"],{"type":"RuntimeError","message":"Owned canonical directory required"})
            value = record["directoryRefusal"]
            self.assertEqual(value["lstat"],f.fields); self.assertEqual(value["relativePath"],"data/bad")
            self.assertEqual(value["expectedUid"],f.uid)
            self.assertTrue(value["cachedStatOnly"]); self.assertTrue(value["diagnosticOnly"])
            self.assertIs(value["authorityGranted"],False); self.assertIs(value["inputPermitted"],False)
            self.assertIs(value["releaseReady"],False); self.assertFalse(value["canonicalResultCaptured"])

    def test_consumer_performs_no_queries_and_keeps_original_snapshot_not_later_values(self):
        with self.fixture() as f:
            error = self.error(f); original = copy.deepcopy(error.directory_refusal)
            f.before.st_uid = 9999; f.before.st_mode = stat.S_IFREG | 0o777
            with patch.object(Path,"lstat",side_effect=AssertionError("No later stat")), \
                    patch.object(Path,"resolve",side_effect=AssertionError("No later resolve")):
                record = {}; C.changed_retain_directory_refusal(record,error)
            self.assertEqual(record["directoryRefusal"]["lstat"],original["lstat"])

    def test_missing_forged_origin_wrong_error_type_or_message_never_exports(self):
        class Foreign(RuntimeError): pass
        for defect in ("missing","foreign","none","type","message"):
            with self.subTest(defect=defect), self.fixture() as f:
                error = self.error(f)
                if defect=="missing": del error._directory_diagnostic_origin
                elif defect=="foreign": error._directory_diagnostic_origin=object()
                elif defect=="none": error._directory_diagnostic_origin=None
                elif defect=="type":
                    other=Foreign(str(error));other.__dict__.update(error.__dict__);error=other
                else: error.args=("Different refusal",)
                record={};C.changed_retain_directory_refusal(record,error)
                self.assertNotIn("directoryRefusal",record)

    def test_malformed_capture_path_uid_stat_and_overflow_never_exports(self):
        changes = [("relativePath","../outside"),("relativePath","/outside"),("relativePath","data//bad"),
                   ("relativePath","x"*513),("expectedUid",True),("expectedUid",9876),("lstat",None),
                   ("stat-key","private"),("st_uid",True),("st_mode",-1),("st_ino",2**128),("st_mtime_ns","later stat")]
        for key,value in changes:
            with self.subTest(key=key), self.fixture() as f:
                error=self.error(f);raw=error.directory_refusal
                if key=="stat-key":raw["lstat"][value]=123
                elif key.startswith("st_"):raw["lstat"][key]=value
                else:raw[key]=value
                record={};C.changed_retain_directory_refusal(record,error)
                self.assertNotIn("directoryRefusal",record)

    def test_existing_capture_and_record_are_never_overwritten_or_reauthenticated(self):
        with self.fixture() as f:
            error=self.error(f);record={};C.changed_retain_directory_refusal(record,error)
            first=copy.deepcopy(record["directoryRefusal"])
            error.directory_refusal["lstat"]["st_uid"]=9999
            C.changed_retain_directory_refusal(record,error)
            self.assertEqual(record["directoryRefusal"],first)
            before=copy.deepcopy(error.directory_refusal)
            f.calls.clear()
            def again(value,message):
                if not value:raise error
            with patch.object(C,"require",side_effect=again),self.assertRaises(RuntimeError) as raised:
                C.directory(f.path,f.uid)
            self.assertIs(raised.exception,error);self.assertEqual(error.directory_refusal,before)
        with self.fixture() as f:
            error=RuntimeError("Owned canonical directory required");error.directory_refusal={"foreign":"not sealed"}
            def again(value,message):
                if not value:raise error
            with patch.object(C,"require",side_effect=again),self.assertRaises(RuntimeError):C.directory(f.path,f.uid)
            self.assertFalse(hasattr(error,"_directory_diagnostic_origin"))

    def test_capture_failures_never_mask_original_error_or_change_refusal(self):
        with self.fixture() as f:
            error=self.error(f);dumps=C.json.dumps
            def failed(value,*args,**kwargs):
                if type(value)is dict and value.get("scope")=="cached-home-directory-refusal":raise OSError("Optional diagnostic failed")
                return dumps(value,*args,**kwargs)
            record={}
            with patch.object(C.json,"dumps",side_effect=failed):self.assertIs(self.broker_handler(error,record),error)
            self.assertEqual(record["refusal"]["message"],str(error));self.assertTrue(record["directoryRefusalUnavailable"])
        with self.fixture() as f:
            del f.before.st_dev
            error=self.error(f)
            self.assertFalse(hasattr(error,"_directory_diagnostic_origin"))

    def test_directory_acceptance_and_all_original_predicates_match_frozen_preimage(self):
        original = ast.parse(Path(C.__file__).read_bytes())
        # The original predicate is retained verbatim inside the diagnostic try.
        function=next(n for n in original.body if isinstance(n,ast.FunctionDef)and n.name=="directory")
        guard=next(n for n in ast.walk(function)if isinstance(n,ast.Call)and ast.unparse(n.func)=="require")
        self.assertEqual(ast.unparse(guard.args[0]),"path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISDIR(before.st_mode) and (before.st_uid == before.st_gid == uid) and (not before.st_mode & 18)")
        for defect in (None,"uid","gid","writable","kind","canonical"):
            with self.subTest(defect=defect),self.fixture(st_mode=stat.S_IFDIR|0o700) as f:
                if defect=="uid":f.before.st_uid+=1
                elif defect=="gid":f.before.st_gid+=1
                elif defect=="writable":f.before.st_mode|=0o020
                elif defect=="kind":f.before.st_mode=stat.S_IFREG|0o700
                if defect=="canonical":
                    with patch.object(Path,"resolve",return_value=f.home),self.assertRaisesRegex(RuntimeError,"Owned canonical directory required"):
                        C.directory(f.path,f.uid)
                elif defect is None:
                    self.assertEqual(C.directory(f.path,f.uid),{"dev":f.before.st_dev,"ino":f.before.st_ino,"uid":f.uid,"gid":f.uid,"mode":0o700})
                else:
                    with self.assertRaisesRegex(RuntimeError,"Owned canonical directory required"):C.directory(f.path,f.uid)

    def test_existing_finite_broker_json_export_retains_diagnostic_without_other_files(self):
        with self.fixture() as f:
            error=self.error(f);record={};self.broker_handler(error,record)
        export=ChangedCaseExportTests(methodName="runTest")
        with export.fixture() as(runner,base,_,_,_):
            file=base/"control/broker.json";raw=json.dumps(record).encode();file.write_bytes(raw)
            folder,rows=export.export(runner)
            retained=[r for r in rows if"member"in r]
            self.assertEqual(len(retained),1);self.assertEqual(retained[0]["source"],str(file))
            self.assertEqual((folder/retained[0]["member"]).read_bytes(),raw)
            self.assertLessEqual(len(raw),8192)


def historical_wm_inverse(value):
    value=copy.deepcopy(value)
    assert isinstance(value,ast.FunctionDef) and value.name=="native_session"
    assignments=[n for n in ast.walk(value)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=="wm_env"for t in n.targets)]
    assert len(assignments)==1
    assert ast.unparse(assignments[0].value)=="M.window_manager_environment(dict(os.environ), 'migrated')"
    calls=[n for n in ast.walk(value)if isinstance(n,ast.Call)and n.args and isinstance(n.args[0],ast.List)and n.args[0].elts and isinstance(n.args[0].elts[0],ast.Constant)and n.args[0].elts[0].value=="/usr/bin/openbox"]
    assert len(calls)==2 and assignments[0].lineno+1==min(n.lineno for n in calls)
    removed=0
    for node in ast.walk(value):
        for key in("body","orelse","finalbody"):
            block=getattr(node,key,None)
            if type(block)is list and assignments[0]in block:block.remove(assignments[0]);removed+=1
    assert removed==1
    for call in calls:
        env=[k for k in call.keywords if k.arg=="env"]
        assert len(env)==1 and ast.unparse(env[0].value)=="wm_env"
        call.keywords.remove(env[0])
    return value


class ChangedWindowManagerCacheTests(unittest.TestCase):
    def test_both_c_cases_actual_wm_start_exit_use_same_fixed_helper_env(self):
        functions={n.name:n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n,ast.FunctionDef)}
        for function,role in(("native_session","migrated"),("changed_session","changed-mcp")):
            with self.subTest(function=function):self.check_actual_wm(functions[function],role)

    def check_actual_wm(self,run,role):
        assignment=next(n for n in ast.walk(run)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=="wm_env"for t in n.targets))
        spawn=next(n for n in ast.walk(run)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=="wm"for t in n.targets))
        stop=next(n for n in ast.walk(run)if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and ast.unparse(n.value.func)=="subprocess.run"and n.value.args and ast.literal_eval(n.value.args[0])==["/usr/bin/openbox","--exit"])
        with tempfile.TemporaryDirectory()as folder:
            base=Path(folder).resolve();(base/"result/migrated-update/tmp").mkdir(parents=True,mode=0o700);(base/"result/home").mkdir(mode=0o700)
            env={"HOME":str(base/"result/home"),"XDG_CACHE_HOME":str(base/"result/home/cache"),"TMPDIR":str(base/"result/migrated-update/tmp"),"DISPLAY":":99"}
            namespace=dict(vars(C))
            with patch.object(C.M,"BASE",base),patch.dict(os.environ,env,clear=True),patch.object(C.subprocess,"Popen")as popen,patch.object(C.subprocess,"run")as exit:
                exec(compile(ast.fix_missing_locations(ast.Module(body=copy.deepcopy([assignment,spawn,stop]),type_ignores=[])),"actual-changed-wm-statements","exec"),namespace)
                self.assertEqual(popen.call_args.kwargs["env"],namespace["wm_env"])
                self.assertEqual(exit.call_args.kwargs["env"],namespace["wm_env"])
                self.assertEqual(namespace["wm_env"]["XDG_CACHE_HOME"],str(base/"result/migrated-update/tmp"/("openbox-"+role+"-cache")))
                self.assertEqual(os.environ["XDG_CACHE_HOME"],env["XDG_CACHE_HOME"])

    def test_every_openbox_invocation_in_m_and_c_has_fixed_private_environment(self):
        for file,expected in((Path(C.__file__),4),(Path(C.M.__file__),2)):
            calls=[n for n in ast.walk(ast.parse(file.read_bytes()))if isinstance(n,ast.Call)and n.args and isinstance(n.args[0],ast.List)
                and n.args[0].elts and isinstance(n.args[0].elts[0],ast.Constant)and n.args[0].elts[0].value=="/usr/bin/openbox"]
            self.assertEqual(len(calls),expected)
            for call in calls:self.assertIn(("env","wm_env"),[(k.arg,ast.unparse(k.value))for k in call.keywords])

    def test_historical_wm_only_inverse_retains_old_exact_hash_and_refuses_other_edits(self):
        native=next(n for n in ast.parse(Path(C.__file__).read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=="native_session")
        def check(value):
            value=historical_wm_inverse(value)
            digest=hashlib.sha256(ast.dump(ast.Module(body=[value],type_ignores=[]),include_attributes=False).encode()).hexdigest()
            self.assertEqual(digest,"668324417896fae68b96cb399e2b8a44f6038bbf13a3958702f9b61b17a428b7")
        check(native)
        wrong=copy.deepcopy(native)
        assignment=next(n for n in ast.walk(wrong)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=="wm_env"for t in n.targets))
        assignment.value.args[-1]=ast.Constant(value="migration")
        with self.assertRaises(AssertionError):check(wrong)
        changed=copy.deepcopy(native);changed.body.append(ast.Pass())
        with self.assertRaises(AssertionError):check(changed)


class CachedInitialInventoryTests(unittest.TestCase):
    def statements(self):
        tree = ast.parse(Path(C.__file__).read_bytes())
        broker = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "changed_broker")
        body = next(node for node in broker.body if isinstance(node, ast.Try)).body
        index = next(i for i, node in enumerate(body) if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == "initial_uid_inventory" for target in node.targets))
        statements = copy.deepcopy(body[index:index + 4])
        expected = ast.parse('require(initial_uid_inventory == {"processes": [], "terminalProcesses": []}, '
                             '"Original fixture processes remain; never adopt or signal")').body[0]
        self.assertIsInstance(statements[2], ast.If)
        self.assertEqual(ast.dump(statements[3]), ast.dump(expected))
        return compile(ast.fix_missing_locations(ast.Module(body=statements, type_ignores=[])), "actual-cached-inventory-guard", "exec")

    def namespace(self, inventory):
        capture = Mock(return_value=inventory)
        return {"M": SimpleNamespace(native_process_inventory=capture), "native": object(), "helper": object(),
                "record": {}, "require": C.require, "BASE": Path("/fixture"),
                "U": SimpleNamespace(read=Mock(return_value=b"{}"), parse=Mock(return_value={})),
                "fixture_quiescence": Mock(return_value=inventory)}, capture

    def test_empty_inventory_is_captured_once_and_passes_original_guard(self):
        value = {"processes": [], "terminalProcesses": []}
        namespace, capture = self.namespace(value)
        exec(self.statements(), namespace)
        capture.assert_called_once_with(namespace["native"], namespace["helper"])
        self.assertIs(namespace["record"]["initialUidInventory"], value)
        self.assertEqual(set(namespace["record"]), {"initialUidInventory"})

    def test_live_inventory_is_retained_unfiltered_and_original_refusal_is_kept(self):
        value = {"processes": [{"pid": 42, "startTime": "123", "executable": "/usr/lib/systemd/systemd",
                               "argvSha256": "a" * 64, "legacyBackend": False}], "terminalProcesses": []}
        namespace, capture = self.namespace(value)
        with self.assertRaisesRegex(RuntimeError, "^Original fixture processes remain; never adopt or signal$"):
            exec(self.statements(), namespace)
        capture.assert_called_once()
        self.assertIs(namespace["record"]["initialUidInventory"], value)
        self.assertEqual(set(namespace["record"]), {"initialUidInventory"})

    def test_terminal_inventory_is_retained_and_not_ignored(self):
        value = {"processes": [], "terminalProcesses": [{"pid": 42, "state": "Z", "startTime": "123"}]}
        namespace, capture = self.namespace(value)
        with self.assertRaisesRegex(RuntimeError, "^Original fixture processes remain; never adopt or signal$"):
            exec(self.statements(), namespace)
        capture.assert_called_once()
        self.assertIs(namespace["record"]["initialUidInventory"], value)

    def test_inventory_failure_remains_the_same_first_exception_without_extra_queries(self):
        namespace, capture = self.namespace(None)
        original = RuntimeError("original inventory failure")
        capture.side_effect = original
        with self.assertRaises(RuntimeError) as caught:
            exec(self.statements(), namespace)
        self.assertIs(caught.exception, original)
        capture.assert_called_once()
        self.assertEqual(namespace["record"], {})


if __name__ == "__main__":
    unittest.main()
