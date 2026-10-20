"""Pure contracts only: this suite never creates users or starts native units."""
import ast
import copy
import hashlib
import importlib.util
from pathlib import Path, PurePosixPath
import stat
import types
import unittest
from unittest.mock import patch

FILE = Path(__file__).with_name("native-linux-unit-start-ack.py")
SPEC = importlib.util.spec_from_file_location("unit_ack_probe", FILE)
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)
USER = "creator-ack-12345678901"


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
            "GITHUB_REF": p.BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": p.WORKFLOW,
            "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "12345678901", "GITHUB_RUN_ATTEMPT": "1",
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "CREATOR_UNIT_ACK_EXECUTE": "true", "GITHUB_WORKSPACE": "/work/repo"}


def properties(case="exec-pam"):
    _, kind, pam = next(row for row in p.CASES if row[0] == case)
    row = dict.fromkeys(p.PROPERTIES, "0")
    row.update(Id=p.unit_name(USER, case), LoadState="loaded", Transient="yes", InvocationID="a" * 32,
               User=USER, PAMName=pam, Type=kind, MainPID="123", ExecMainPID="123", ActiveState="activating", SubState="start",
               Result="success", TimeoutStartUSec="3s", TimeoutStopUSec="2s", RuntimeMaxUSec="12s")
    return row


def missing(case="exec-pam"):
    row = properties(case)
    row.update(LoadState="not-found", Transient="no", InvocationID="", MainPID="0", ExecMainPID="0")
    return row


def encoded(row):
    return ("\n".join(k + "=" + v for k, v in row.items()) + "\n").encode("ascii")


def metadata(uid, mode, size):
    return types.SimpleNamespace(st_dev=1, st_ino=2, st_mode=mode, st_nlink=1, st_uid=uid, st_gid=uid,
                                 st_size=size, st_mtime_ns=4, st_ctime_ns=5)


def proc_stat(start="456", parent="1", state="S"):
    fields = [state, parent] + ["0"] * 17 + [start] + ["0"] * 5
    return ("123 (sleep) " + " ".join(fields)).encode("ascii")


def status(uid=p.UID, gid=p.UID):
    return ("Uid:\t" + "\t".join([str(uid)] * 4) + "\nGid:\t" + "\t".join([str(gid)] * 4) + "\n").encode("ascii")


class Admission(unittest.TestCase):
    def test_exact_manual_root_context(self):
        self.assertEqual(p.admission(environment(), "linux", 0), USER)

    def test_each_authority_field_changed_refuses(self):
        for key in environment():
            if key == "GITHUB_WORKSPACE":
                continue
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**environment(), key: "wrong"}, "linux", 0)
        for platform, uid in (("win32", 0), ("linux", 1001)):
            with self.assertRaises(RuntimeError):
                p.admission(environment(), platform, uid)

    def test_runtime_injection_refuses(self):
        for key in ("LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PYTHONHOME"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**environment(), key: ""}, "linux", 0)

    def test_unique_literal_base_and_closed_cases(self):
        self.assertEqual(str(p.base_path(environment())).replace("\\", "/"), "/usr/lib/creator-unit-start-ack-12345678901-a1")
        for name in ("other", "../exec-pam", "exec-pam.service"):
            with self.assertRaises(RuntimeError):
                p.command(USER, name)
        with self.assertRaises(RuntimeError):
            p.unit_name("../../user", "exec-pam")


class UnitContract(unittest.TestCase):
    def test_three_commands_change_only_type_and_pam(self):
        bodies = []
        for case, kind, pam in p.CASES:
            cmd = p.command(USER, case)
            self.assertEqual(cmd[-2:], ["/usr/bin/sleep", "8"])
            self.assertIn("--property=TimeoutStartSec=3s", cmd)
            self.assertIn("--property=RuntimeMaxSec=12s", cmd)
            self.assertIn("--property=TimeoutStopSec=2s", cmd)
            self.assertIn("--property=Type=" + kind, cmd)
            self.assertIn("--property=PAMName=" + pam, cmd)
            self.assertNotIn("--collect", cmd)
            bodies.append([v for v in cmd if not v.startswith(("--unit=", "--property=Type=", "--property=PAMName="))])
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[1], bodies[2])
        self.assertLess(p.START_SECONDS, p.SLEEP_SECONDS)
        self.assertLess(p.SLEEP_SECONDS, p.RUNTIME_SECONDS)

    def test_property_parser_exact_keys_and_types(self):
        row = properties()
        self.assertEqual(p.parse_properties(encoded(row)), row)
        for raw in (encoded({**row, "extra": "1"}), encoded(row) + b"Type=exec\n",
                    encoded({k: v for k, v in row.items() if k != "Type"}), encoded(row).replace(b"exec", b"ex\x00ec"),
                    b"a" * (p.LIMIT + 1), "text"):
            with self.subTest(raw=type(raw).__name__), self.assertRaises((RuntimeError, UnicodeError)):
                p.parse_properties(raw)

    def test_all_cases_bind_user_pam_type_and_invocation(self):
        for case, _, _ in p.CASES:
            row = properties(case)
            self.assertEqual(p.bind_unit(row, row["Id"], USER, case), "a" * 32)
            for key in ("User", "Id", "PAMName", "Type", "InvocationID", "LoadState", "Transient", "TimeoutStartUSec",
                        "TimeoutStopUSec", "RuntimeMaxUSec"):
                with self.subTest(case=case, key=key), self.assertRaises(RuntimeError):
                    p.bind_unit({**row, key: "wrong"}, row["Id"], USER, case)
            with self.assertRaises(RuntimeError):
                p.bind_unit(row, row["Id"], USER, case, "b" * 32)

    def test_preexisting_units_always_refuse(self):
        with patch.object(p, "show", return_value=missing()):
            p.absent(p.unit_name(USER, "exec-pam"))
        for key, value in (("LoadState", "loaded"), ("Transient", "yes"), ("InvocationID", "a" * 32), ("MainPID", "123")):
            with patch.object(p, "show", return_value={**missing(), key: value}), self.assertRaises(RuntimeError):
                p.absent(p.unit_name(USER, "exec-pam"))

    def test_outcomes_are_exact_not_exitcode_alone(self):
        normal = "Finished with result: success\nMain processes terminated with: code=exited/status=0\n"
        timeout = "Finished with result: timeout\nMain processes terminated with: code=killed/status=TERM\n"
        self.assertEqual(p.outcome(0, normal), "normal-exit")
        self.assertEqual(p.outcome(1, timeout), "timeout")
        for code, text in ((0, ""), (0, timeout), (1, normal), (-15, timeout), (0, normal + normal),
                           (1, timeout.replace("TERM", "SEGV")), (1, timeout.replace("timeout", "exit-code"))):
            with self.assertRaises(RuntimeError):
                p.outcome(code, text)


class StagingAncestry(unittest.TestCase):
    def invoke(self, changes=None, redirect=None):
        changes = changes or {}
        visited = []
        class NativePath(PurePosixPath):
            def lstat(self):
                visited.append(str(self))
                return changes.get(str(self), metadata(0, stat.S_IFDIR | 0o755, 0))

            def resolve(self, strict=False):
                self_case.assertTrue(strict)
                return NativePath("/redirected") if str(self) == redirect else self
        self_case = self
        with patch.object(p, "Path", NativePath):
            result = p.staging_parent()
        self.assertEqual(visited, ["/usr/lib", "/usr", "/"])
        return str(result)

    def test_fixed_usr_lib_and_complete_protected_chain_pass(self):
        self.assertEqual(self.invoke(), "/usr/lib")

    def test_writable_parent_at_each_level_refuses(self):
        for path in ("/usr/lib", "/usr", "/"):
            for mode in (0o777, 0o775, 0o757):
                with self.subTest(path=path, mode=oct(mode)), self.assertRaisesRegex(RuntimeError, "staging ancestry"):
                    self.invoke({path: metadata(0, stat.S_IFDIR | mode, 0)})

    def test_symlink_non_directory_foreign_owner_or_group_refuses(self):
        foreign_group = metadata(0, stat.S_IFDIR | 0o755, 0)
        foreign_group.st_gid = 1001
        for info in (metadata(1001, stat.S_IFDIR | 0o755, 0), foreign_group,
                     metadata(0, stat.S_IFLNK | 0o755, 0), metadata(0, stat.S_IFREG | 0o755, 0)):
            with self.assertRaisesRegex(RuntimeError, "staging ancestry"):
                self.invoke({"/usr/lib": info})
        for path in ("/usr/lib", "/usr", "/"):
            with self.subTest(redirect=path), self.assertRaisesRegex(RuntimeError, "staging ancestry"):
                self.invoke(redirect=path)

    def test_guard_precedes_exclusive_fresh_directory_and_no_shared_repair(self):
        tree = ast.parse(FILE.read_bytes(), feature_version=(3, 10))
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)]
        guard = next(n for n in calls if isinstance(n.func, ast.Name) and n.func.id == "staging_parent")
        mkdir = next(n for n in calls if isinstance(n.func, ast.Attribute) and n.func.attr == "mkdir")
        self.assertLess(guard.lineno, mkdir.lineno)
        self.assertNotIn("exist_ok", [kw.arg for kw in mkdir.keywords])
        source = FILE.read_text(encoding="utf-8")
        self.assertIn("not os.path.lexists(base)", source)
        self.assertIn("os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW", source)
        self.assertFalse(any(isinstance(n.func, ast.Attribute) and n.func.attr in ("chmod", "fchmod", "chown", "fchown")
                             for n in ast.walk(tree) if isinstance(n, ast.Call)))


class KernelSleep(unittest.TestCase):
    def invoke(self, *, stats=None, statuses=None, link="/usr/bin/sleep", image_change=False, proc_change=False):
        image = metadata(0, stat.S_IFREG | 0o755, 10)
        proc = metadata(p.UID, stat.S_IFDIR | 0o555, 0)
        pin = {"stamp": list(p.stamp(image)), "sha256": hashlib.sha256(b"sleepimage").hexdigest()}
        stats, statuses = iter(stats or [proc_stat(), proc_stat()]), iter(statuses or [status(), status()])
        def read(fd, limit):
            if fd == 11:
                return next(stats)
            if fd == 12:
                return next(statuses)
            self.assertEqual(fd, 13)
            return b"changed" if image_change else b"sleepimage"
        def opened(file, flags, **kwargs):
            return {"stat": 11, "status": 12, "exe": 13}.get(str(file), 10)
        changed_proc = copy.copy(proc)
        changed_proc.st_ino += 1
        with patch.object(p.os, "open", side_effect=opened), patch.object(p.os, "close"), \
                patch.object(p.os, "fstat", side_effect=lambda fd: image if fd == 13 else proc), \
                patch.object(p.os, "readlink", return_value=link), patch.object(p, "read_fd", side_effect=read), \
                patch.object(p.Path, "lstat", return_value=changed_proc if proc_change else proc), \
                patch.object(p, "tool_pin", return_value=pin), \
                patch.object(p.os, "O_NOFOLLOW", 0, create=True), patch.object(p.os, "O_DIRECTORY", 0, create=True), \
                patch.object(p.os, "O_NONBLOCK", 0, create=True):
            return p.native_sleep(123, pin)

    def test_actual_held_kernel_image_and_identity(self):
        result = self.invoke()
        self.assertTrue(result["kernelImageVerified"])
        self.assertEqual(result["pid"], 123)
        self.assertEqual(result["startTime"], "456")
        self.assertEqual(result["uids"], [p.UID] * 4)

    def test_preexec_is_not_running_sleep_evidence(self):
        self.assertIsNone(self.invoke(link="/usr/lib/systemd/systemd"))

    def test_pid_reuse_reparent_uid_gid_image_and_directory_change_refuse(self):
        for options in ({"stats": [proc_stat(), proc_stat(start="457")]},
                        {"stats": [proc_stat(), proc_stat(parent="9")]},
                        {"statuses": [status(), status(uid=0)]}, {"statuses": [status(gid=0)]},
                        {"image_change": True}, {"proc_change": True}, {"stats": [proc_stat(state="Z")]},
                        {"stats": [b"malformed"]}):
            with self.subTest(options=tuple(options)), self.assertRaises(RuntimeError):
                self.invoke(**options)


class Lifecycle(unittest.TestCase):
    def model(self, record, *, observed=True, changed=False, preexisting=False, case="exec-pam", normal=False):
        row, after = properties(case), properties(case)
        if normal:
            row.update(ActiveState="active", SubState="running")
            after.update(ActiveState="active", SubState="running")
        if changed:
            after["InvocationID"] = "b" * 32
        process = types.SimpleNamespace(returncode=None)
        summary = (b"Finished with result: success\nMain processes terminated with: code=exited/status=0\n" if normal else
                   b"Finished with result: timeout\nMain processes terminated with: code=killed/status=TERM\n")
        handle = (process, object(), {"stdout": bytearray(), "stderr": bytearray(summary)})
        process.poll = lambda: process.returncode
        count = 0
        def pump(*args):
            nonlocal count
            count += 1
            if count == 2:
                process.returncode = 0 if normal else 1
            return count == 2
        observed_record = {"pid": 123, "startTime": "456", "kernelImageVerified": True}
        rows = [row, after, missing(case) if normal else row] if observed else [row, row]
        with patch.object(p, "absent", side_effect=RuntimeError("preexisting") if preexisting else None), \
                patch.object(p, "tool_pin", return_value={"sha256": "a" * 64}), \
                patch.object(p, "start", return_value=handle) as launch, patch.object(p, "pump", side_effect=pump), \
                patch.object(p, "show", side_effect=rows), patch.object(p, "native_sleep", return_value=observed_record if observed else None), \
                patch.object(p, "close") as closed:
            try:
                p.run_case(USER, case, record)
            finally:
                self.assertEqual(launch.call_count, 0 if preexisting else 1)
                self.assertEqual(closed.call_count, 0 if preexisting else 1)

    def test_bound_running_sleep_timeout_receipt(self):
        record = {}
        self.model(record)
        self.assertTrue(record["completed"])
        self.assertEqual(record["outcome"], "timeout")
        self.assertEqual(record["execution"]["before"]["SubState"], "start")
        self.assertEqual(record["returnCode"], 1)

    def test_both_controls_normal_exit_even_if_terminal_unit_collected(self):
        for case in ("exec-no-pam", "simple-pam"):
            record = {}
            self.model(record, case=case, normal=True)
            self.assertTrue(record["completed"])
            self.assertEqual(record["outcome"], "normal-exit")
            self.assertEqual(record["terminal"]["LoadState"], "not-found")
            self.assertEqual(record["execution"]["before"]["PAMName"], "" if case == "exec-no-pam" else "login")

    def test_pam_preexec_hang_cannot_masquerade_as_exec_ack_timeout(self):
        record = {}
        with self.assertRaisesRegex(RuntimeError, "No bound running sleep"):
            self.model(record, observed=False)
        self.assertFalse(record["executionObserved"])
        self.assertNotIn("completed", record)
        self.assertIn("Finished with result: timeout", record["stderr"])

    def test_changed_invocation_refuses_no_retry(self):
        with self.assertRaisesRegex(RuntimeError, "invocation replaced"):
            self.model({}, changed=True)

    def test_preexisting_unit_no_launch(self):
        with self.assertRaisesRegex(RuntimeError, "preexisting"):
            self.model({}, preexisting=True)

    def test_source_has_no_product_gui_network_signal_or_service_cleanup(self):
        source = FILE.read_text(encoding="utf-8")
        tree = ast.parse(source, feature_version=(3, 10))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
        self.assertFalse(any(isinstance(c.func, ast.Attribute) and c.func.attr in
                             ("kill", "terminate", "send_signal", "killpg", "rmtree", "urlopen") for c in calls))
        for executable in ("/usr/bin/creator-hub", "pkexec", "flatpak", "Unity", "tauri-driver"):
            self.assertNotIn(executable, source)
        self.assertNotIn("import signal", source)
        self.assertNotIn("--collect", source)
        self.assertNotIn("reset-failed", " ".join(c.value for c in ast.walk(tree) if isinstance(c, ast.Constant) and isinstance(c.value, str)))


class FreshAccountAndTools(unittest.TestCase):
    def nss(self):
        account = types.SimpleNamespace(pw_uid=p.UID, pw_gid=p.UID, pw_shell="/usr/sbin/nologin", pw_dir="/nonexistent", pw_name=USER)
        group = types.SimpleNamespace(gr_gid=p.UID, gr_name=USER)
        passwd = types.SimpleNamespace(getpwnam=unittest.mock.Mock(side_effect=[KeyError(), account]),
                                      getpwuid=unittest.mock.Mock(side_effect=[KeyError(), account]))
        groups = types.SimpleNamespace(getgrnam=unittest.mock.Mock(side_effect=[KeyError(), group]),
                                      getgrgid=unittest.mock.Mock(side_effect=[KeyError(), group]))
        return passwd, groups

    def test_fresh_account_no_home_locked_before_units(self):
        passwd, groups = self.nss()
        with patch.object(p, "pwd", passwd), patch.object(p, "grp", groups), patch.object(p, "absent") as absent, \
                patch.object(p, "bounded", side_effect=[b"", (USER + " L 2026-10-20 0 99999 7 -1\n").encode()]) as tool:
            p.fresh_user(USER)
        self.assertEqual(absent.call_count, 3)
        cmd = tool.call_args_list[0].args[0]
        self.assertEqual(cmd[0], "/usr/sbin/useradd")
        self.assertIn("--no-create-home", cmd)
        self.assertEqual(cmd[cmd.index("--password") + 1], "!")
        self.assertEqual(tool.call_args_list[1].args[0], ["/usr/bin/passwd", "-S", USER])

    def test_each_preexisting_nss_name_or_uid_refuses_before_useradd(self):
        for root, attribute in (("pwd", "getpwnam"), ("pwd", "getpwuid"), ("grp", "getgrnam"), ("grp", "getgrgid")):
            passwd, groups = self.nss()
            getattr(passwd if root == "pwd" else groups, attribute).side_effect = None
            with patch.object(p, "pwd", passwd), patch.object(p, "grp", groups), patch.object(p, "bounded") as tool, \
                    self.assertRaisesRegex(RuntimeError, "Preexisting"):
                p.fresh_user(USER)
            tool.assert_not_called()

    def test_unlocked_status_refuses(self):
        passwd, groups = self.nss()
        with patch.object(p, "pwd", passwd), patch.object(p, "grp", groups), patch.object(p, "absent"), \
                patch.object(p, "bounded", side_effect=[b"", (USER + " P 2026-10-20 0 99999 7 -1\n").encode()]), \
                self.assertRaisesRegex(RuntimeError, "Locked account"):
            p.fresh_user(USER)

    def test_stalled_tool_bounded_and_closed_without_signal(self):
        process = types.SimpleNamespace(returncode=None)
        handle = (process, object(), {"stdout": bytearray(), "stderr": bytearray()})
        with patch.object(p, "tool_pin", return_value={}), patch.object(p, "start", return_value=handle) as launch, \
                patch.object(p, "pump", return_value=False), patch.object(p.time, "monotonic", side_effect=[0, 3]), \
                patch.object(p, "close") as closed, self.assertRaisesRegex(RuntimeError, "deadline exceeded"):
            p.bounded(["/usr/bin/systemctl", "--system"])
        self.assertEqual(launch.call_count, 1)
        closed.assert_called_once_with(handle)

    def test_tool_identity_change_refuses(self):
        handle = (types.SimpleNamespace(returncode=0), object(), {"stdout": bytearray(), "stderr": bytearray()})
        with patch.object(p, "tool_pin", side_effect=[{"sha256": "a"}, {"sha256": "b"}]), \
                patch.object(p, "start", return_value=handle), patch.object(p, "pump", return_value=True), \
                patch.object(p, "close"), self.assertRaisesRegex(RuntimeError, "failed/changed"):
            p.bounded(["/usr/bin/systemctl", "--system"])

    def test_tool_output_has_fixed_per_stream_bound(self):
        key = types.SimpleNamespace(fileobj=types.SimpleNamespace(fileno=lambda: 1), data="stderr")
        selector = types.SimpleNamespace(select=lambda wait: [(key, 1)])
        handle = (types.SimpleNamespace(poll=lambda: None), selector, {"stderr": bytearray(b"a" * p.LIMIT)})
        with patch.object(p.os, "read", return_value=b"b"), self.assertRaisesRegex(RuntimeError, "output bound exceeded"):
            p.pump(handle)


if __name__ == "__main__":
    unittest.main()
