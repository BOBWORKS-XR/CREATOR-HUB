"""Pure authority/parser/FD tests. No downloaded CLI or application is executed."""
import ast
from contextlib import ExitStack, contextmanager
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("unity_registry_probe", HERE / "native-linux-unity-cli-registry-probe.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
ROOT = HERE.parent


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": M.REPO, "GITHUB_REPOSITORY_ID": M.REPO_ID,
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": M.BRANCH, "GITHUB_WORKFLOW_REF": M.WORKFLOW,
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "UNITY_REGISTRY_PROBE_REQUEST": M.REQUEST, "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}


def elf():
    raw = bytearray(128)
    raw[:7] = b"\x7fELF\x02\x01\x01"
    raw[16:20] = b"\x03\x00\x3e\x00"
    return bytes(raw)


def asset(raw):
    return {"filename": M.ASSET["filename"], **M.pin(raw)}


def portable_flags(stack):
    for name in ("O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC"):
        if not hasattr(os, name):
            stack.enter_context(patch.object(os, name, 0, create=True))


class Authority(unittest.TestCase):
    def test_exact_manual_nonroot_context(self):
        self.assertEqual(M.admission(environment(), "Linux", "x86_64", 1000, 1000), 1000)

    def test_each_authority_field_is_mandatory(self):
        for name in environment():
            with self.subTest(name=name):
                env = environment(); env[name] = "wrong"
                with self.assertRaises(RuntimeError):
                    M.admission(env, "Linux", "x86_64", 1000, 1000)

    def test_os_arch_root_and_elevation_refused(self):
        for args in (("Windows", "x86_64", 1000, 1000), ("Linux", "aarch64", 1000, 1000),
                     ("Linux", "x86_64", 0, 0), ("Linux", "x86_64", 1000, 0), ("Linux", "x86_64", True, True)):
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                M.admission(environment(), *args)

    def test_environment_injection_refused(self):
        for key in ("LD_PRELOAD", "DYLD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME", "SSL_CERT_FILE", "SSL_CERT_DIR",
                    "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "UNITY_ACCESS_TOKEN", "HUB_TOKEN", "https_proxy", "ALL_PROXY"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: "unused"}, "Linux", "x86_64", 1000, 1000)
        with self.assertRaises(RuntimeError):
            M.admission({**environment(), "UNITY_NO_CONSENT_PROMPT": "1"}, "Linux", "x86_64", 1000, 1000)

    def test_noncanonical_run_identity_refused(self):
        for key, value in (("GITHUB_SHA", "A" * 40), ("GITHUB_RUN_ID", "01"), ("GITHUB_RUN_ATTEMPT", "0")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: value}, "Linux", "x86_64", 1000, 1000)

    def test_child_environment_is_closed_and_disposable(self):
        root = Path("/synthetic/private")
        env = M.child_environment(root)
        self.assertEqual(set(env), {"PATH", "LANG", "LC_ALL", "NO_COLOR", "TERM", "HOME", "XDG_CONFIG_HOME",
                                    "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "UNITY_NO_CONSENT_PROMPT"})
        self.assertEqual(env["PATH"], "/usr/bin:/bin")
        self.assertEqual(env["UNITY_NO_CONSENT_PROMPT"], "1")
        self.assertIn('.env("UNITY_NO_CONSENT_PROMPT", "1")', (ROOT / "src-tauri/src/projects.rs").read_text(encoding="utf-8"))
        for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"):
            self.assertTrue(Path(env[key]).is_relative_to(root))

    def test_manifest_and_url_are_fixed_primary_pins(self):
        manifest = json.loads((ROOT / M.MANIFEST).read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "1.0.0-beta.9")
        self.assertEqual(M.ASSET, manifest["binaries"]["linux-x64"])
        self.assertEqual(M.ASSET["size"], 23515432)
        self.assertEqual(M.ASSET["sha256"], "8c0d6e2435449c8be7f0e6b2ce6330bfc5f17a98aec4b659c859940455dd0fe5")
        self.assertEqual(M.URL, "https://public-cdn.cloud.unity3d.com/hub/prod/cli/1.0.0-beta.9/unity-linux-x64")

    def test_only_six_finite_read_commands(self):
        self.assertEqual(M.COMMANDS, (("version", ("--version",)), ("help", ("--help",)),
                         ("projects-help", ("projects", "--help")), ("list-help", ("projects", "list", "--help")),
                         ("add-help-only", ("projects", "add", "--help")),
                         ("list", ("projects", "list", "--json", "--non-interactive", "--no-banner", "--no-pager"))))

    def test_all_acceptance_claims_stay_false(self):
        self.assertEqual(M.FALSE, {"nonemptyRegistryAccepted": False, "automaticDiscoveryAccepted": False,
                                  "unityEditorAccepted": False, "hubUiFixtureAccepted": False, "releaseReady": False})


class Output(unittest.TestCase):
    def test_actual_version_required(self):
        M.validate_output("version", (M.VERSION + "\n").encode())
        for value in (b"1.0.0-beta.8", b"Unity CLI", b"prefix 1.0.0-beta.9"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                M.validate_output("version", value)

    def test_each_command_specific_help(self):
        for role, text in (("help", "Usage: unity [options]\nprojects"),
                           ("projects-help", "Usage: unity projects [subcommand]\nlist add"),
                           ("list-help", "Usage: unity projects list [options]"),
                           ("add-help-only", "Usage: unity projects add [path]")):
            with self.subTest(role=role):
                M.validate_output(role, text.encode())

    def test_generic_help_does_not_adopt_unknown_subcommand(self):
        for role in ("projects-help", "list-help", "add-help-only"):
            with self.subTest(role=role), self.assertRaises(RuntimeError):
                M.validate_output(role, b"Usage: unity [options]\nprojects list add")

    def test_missing_required_project_commands_refused(self):
        for role, text in (("help", b"Usage: unity"), ("projects-help", b"Usage: unity projects\nlist")):
            with self.subTest(role=role), self.assertRaises(RuntimeError):
                M.validate_output(role, text)

    def test_only_successful_empty_list_is_execution_evidence(self):
        M.validate_output("list", b'{"success":true,"data":[]}')
        for value in ({"success": False, "data": []}, {"success": True, "data": [{}]},
                      {"success": True, "data": {}}, {"success": 1, "data": []}, []):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                M.validate_output("list", json.dumps(value).encode())

    def test_unknown_role_invalid_json_utf8_and_controls_refused(self):
        for role, value in (("unknown", b"ok"), ("list", b"not JSON"), ("help", b"\xff"), ("help", b"\x1b[0m")):
            with self.subTest(role=role, value=value), self.assertRaises((RuntimeError, ValueError)):
                M.validate_output(role, value)


class Response(io.BytesIO):
    def __init__(self, raw, *, url=None, status=200, length=None):
        super().__init__(raw)
        self.status, self.url = status, M.URL if url is None else url
        self.headers = {} if length is None else {"Content-Length": str(length)}

    def geturl(self):
        return self.url


class Download(unittest.TestCase):
    def perform(self, response, raw=None):
        raw = elf() if raw is None else raw
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            portable_flags(stack)
            stack.enter_context(patch.object(M, "ASSET", asset(raw)))
            opener = Mock(); opener.open.return_value = response
            builder = stack.enter_context(patch.object(M.urllib.request, "build_opener", return_value=opener))
            target = Path(temporary) / "new-fixed-helper"
            M.download(target)
            self.assertEqual(target.read_bytes(), raw)
            opener.open.assert_called_once_with(M.URL, timeout=30)
            self.assertEqual(builder.call_args.args[0].proxies, {})
            self.assertIsInstance(builder.call_args.args[1], M.NoRedirect)

    def test_exact_https_bytes_and_no_proxy(self):
        self.perform(Response(elf(), length=len(elf())))

    def test_redirects_refused(self):
        with self.assertRaises(RuntimeError):
            M.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://foreign.invalid")

    def test_wrong_status_url_length_and_bytes_refused(self):
        for kw in ({"status": 301}, {"url": M.URL + "?other"}, {"length": 1}):
            with self.subTest(kw=kw), self.assertRaises(RuntimeError):
                self.perform(Response(elf(), **kw))
        for raw in (elf()[:-1], elf() + b"x", b"x" * len(elf())):
            with self.subTest(size=len(raw)), self.assertRaises(RuntimeError):
                self.perform(Response(raw))

    def test_existing_target_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            portable_flags(stack)
            target = Path(temporary) / "foreign"; target.write_bytes(b"original")
            stack.enter_context(patch.object(M, "ASSET", asset(elf())))
            opener = Mock(); opener.open.return_value = Response(elf())
            stack.enter_context(patch.object(M.urllib.request, "build_opener", return_value=opener))
            with self.assertRaises(FileExistsError):
                M.download(target)
            self.assertEqual(target.read_bytes(), b"original")

    def test_zero_write_refused_and_fd_closed(self):
        with patch.object(M.os, "write", return_value=0), self.assertRaises(RuntimeError):
            self.perform(Response(elf()))

    def test_deadline_refused_without_retry(self):
        with patch.object(M.time, "monotonic", side_effect=(0, 121)), self.assertRaises(RuntimeError):
            self.perform(Response(elf()))


class FakeMemfd:
    """Exercise the sealing/readback code on Windows without executing any ELF."""
    def __init__(self, raw=None):
        self.raw = bytearray()
        self.position, self.mode, self.seals, self.closed = 0, 0o777, 0, []
        self.source = Mock(); self.source.check.return_value = elf() if raw is None else raw
        self.control = SimpleNamespace(F_SEAL_SEAL=1, F_SEAL_SHRINK=2, F_SEAL_GROW=4, F_SEAL_WRITE=8,
                                       F_ADD_SEALS=1033, F_GET_SEALS=1034, fcntl=self.fcntl)

    def info(self, fd):
        return SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFREG | self.mode, st_uid=1000, st_gid=1000,
                               st_nlink=0, st_size=len(self.raw), st_mtime_ns=1, st_ctime_ns=1)

    def write(self, fd, raw):
        count = min(len(raw), 13)
        self.raw.extend(raw[:count]); return count

    def seek(self, fd, offset, kind):
        self.position = offset; return offset

    def read(self, fd, size):
        raw = bytes(self.raw[self.position:self.position + size]); self.position += len(raw); return raw

    def chmod(self, fd, mode):
        self.mode = mode

    def fcntl(self, fd, action, value=None):
        if action == self.control.F_ADD_SEALS:
            self.seals = value; return 0
        return self.seals

    def install(self, stack):
        stack.enter_context(patch.dict(sys.modules, {"fcntl": self.control}))
        stack.enter_context(patch.object(M, "ASSET", asset(elf())))
        for name, value in {"MFD_CLOEXEC": 1, "MFD_ALLOW_SEALING": 2, "memfd_create": Mock(return_value=412),
                            "fstat": self.info, "write": self.write, "lseek": self.seek, "read": self.read,
                            "fchmod": Mock(side_effect=self.chmod), "get_inheritable": Mock(return_value=False),
                            "close": self.closed.append}.items():
            stack.enter_context(patch.object(M.os, name, value, create=True))


class Sealing(unittest.TestCase):
    def test_verified_source_captured_sealed_readback_and_retained(self):
        kernel = FakeMemfd()
        with ExitStack() as stack:
            kernel.install(stack)
            image = M.SealedImage(kernel.source, 1000)
            M.os.memfd_create.assert_called_once_with("creator-unity-registry", 3)
            M.os.fchmod.assert_called_once_with(412, 0o700)
            self.assertEqual(kernel.raw, elf())
            self.assertEqual(image.seals, 15)
            self.assertEqual(kernel.seals, 15)
            self.assertGreaterEqual(kernel.source.check.call_count, 3)
            image.check(); image.close(); image.close()
            self.assertEqual(kernel.closed, [412])
            kernel.source.close.assert_not_called()

    def test_unverified_source_refused_before_memfd_creation(self):
        kernel = FakeMemfd(b"foreign")
        with ExitStack() as stack:
            kernel.install(stack)
            with self.assertRaises(RuntimeError):
                M.SealedImage(kernel.source, 1000)
            M.os.memfd_create.assert_not_called()

    def test_incomplete_seals_refused_and_new_fd_closed(self):
        kernel = FakeMemfd()
        with ExitStack() as stack:
            kernel.install(stack)
            kernel.control.fcntl = lambda fd, action, value=None: 7
            with self.assertRaises(RuntimeError):
                M.SealedImage(kernel.source, 1000)
            self.assertEqual(kernel.closed, [412])

    def test_memfd_mode_failure_refused_and_source_never_chmod(self):
        kernel = FakeMemfd()
        with ExitStack() as stack:
            kernel.install(stack)
            M.os.fchmod.side_effect = OSError("refused")
            with self.assertRaises(OSError):
                M.SealedImage(kernel.source, 1000)
            self.assertEqual(kernel.closed, [412])
            self.assertEqual(M.os.fchmod.call_args.args, (412, 0o700))

    def test_memfd_zero_write_refused(self):
        kernel = FakeMemfd()
        with ExitStack() as stack:
            kernel.install(stack)
            stack.enter_context(patch.object(M.os, "write", return_value=0))
            with self.assertRaises(RuntimeError):
                M.SealedImage(kernel.source, 1000)
            self.assertEqual(kernel.closed, [412])

    def test_memfd_readback_mismatch_refused(self):
        kernel = FakeMemfd()
        with ExitStack() as stack:
            kernel.install(stack)
            stack.enter_context(patch.object(M.os, "read", side_effect=(b"wrong", b"")))
            with self.assertRaises(RuntimeError):
                M.SealedImage(kernel.source, 1000)
            self.assertEqual(kernel.closed, [412])

    def test_source_replacement_after_capture_refused(self):
        kernel = FakeMemfd()
        kernel.source.check.side_effect = (elf(), RuntimeError("source replaced"))
        with ExitStack() as stack:
            kernel.install(stack)
            with self.assertRaisesRegex(RuntimeError, "source replaced"):
                M.SealedImage(kernel.source, 1000)
            self.assertEqual(kernel.closed, [412])

    def test_memfd_inheritance_or_identity_change_refused(self):
        kernel = FakeMemfd()
        with ExitStack() as stack:
            kernel.install(stack)
            image = M.SealedImage(kernel.source, 1000)
            M.os.get_inheritable.return_value = True
            with self.assertRaises(RuntimeError):
                image.check()
            M.os.get_inheritable.return_value = False
            kernel.mode = 0o777
            with self.assertRaises(RuntimeError):
                image.check()
            image.close()

    def test_memfd_timestamp_drift_refused_despite_unchanged_bytes_seals_and_flags(self):
        for field in ("st_mtime_ns", "st_ctime_ns"):
            kernel = FakeMemfd()
            with self.subTest(field=field), ExitStack() as stack:
                kernel.install(stack)
                image = M.SealedImage(kernel.source, 1000)
                try:
                    original = M.identity(image.before)
                    changed = kernel.info(412)
                    setattr(changed, field, getattr(changed, field) + 1)
                    with patch.object(M.os, "fstat", return_value=changed):
                        with self.assertRaisesRegex(RuntimeError, "Owned immutable close-on-exec memfd required"):
                            image.check()
                    self.assertEqual(M.identity(image.before), original)
                    self.assertEqual(bytes(kernel.raw), elf())
                    self.assertEqual(kernel.seals, 15)
                    M.os.get_inheritable.assert_called()
                    self.assertFalse(M.os.get_inheritable.return_value)
                    kernel.source.check.assert_called()
                finally:
                    image.close()

    def test_x64_elf_type_header_and_complete_hash_required(self):
        for offset, value in ((0, 0), (4, 1), (5, 2), (16, 1), (18, 0)):
            raw = bytearray(elf()); raw[offset] = value
            with self.subTest(offset=offset), patch.object(M, "ASSET", asset(raw)), self.assertRaises(RuntimeError):
                M.verified_elf(raw)
        with patch.object(M, "ASSET", asset(elf())), self.assertRaises(RuntimeError):
            M.verified_elf(elf()[:-1])

    @unittest.skipUnless(sys.platform == "linux" and hasattr(os, "memfd_create"), "Linux memfd only; no ELF execution")
    def test_real_unix_memfd_seals_refuse_write_resize_and_no_source_change(self):
        import fcntl
        with tempfile.TemporaryDirectory() as temporary, patch.object(M, "ASSET", asset(elf())):
            directory = Path(temporary) / "private"
            M.private_directory(directory, os.getuid())
            path = directory / "source"
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o500)
            os.write(fd, elf()); os.close(fd)
            before = M.identity(path.lstat())
            source = M.HeldBinary(path, os.getuid())
            try:
                image = M.SealedImage(source, os.getuid())
                try:
                    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
                    def snapshot():
                        info = os.fstat(image.fd)
                        raw = os.pread(image.fd, len(elf()) + 1, 0)
                        return {"identity": {key: getattr(info, key) for key in fields}, **M.pin(raw),
                                "seals": fcntl.fcntl(image.fd, fcntl.F_GET_SEALS),
                                "closeOnExec": not os.get_inheritable(image.fd)}
                    diagnostic = {"scope": "pure-sealed-memfd-denied-syscalls", "candidateExecuted": False,
                                  "releaseReady": False, "before": snapshot(), "attempts": []}
                    try:
                        for name, action in (("write", lambda: os.write(image.fd, b"x")),
                                             ("shrink", lambda: os.ftruncate(image.fd, 1)),
                                             ("grow", lambda: os.ftruncate(image.fd, 1024))):
                            row = {"operation": name, "before": snapshot()}
                            diagnostic["attempts"].append(row)
                            with self.assertRaises(OSError) as refused:
                                action()
                            row.update(errno=refused.exception.errno, after=snapshot())
                            diagnostic["after"] = row["after"]
                            self.assertEqual(refused.exception.errno, errno.EPERM)
                            info = os.fstat(image.fd)
                            self.assertEqual(M.identity(info)[:-2], M.identity(image.before)[:-2])
                            self.assertEqual(stat.S_IMODE(info.st_mode), 0o700)
                            self.assertEqual(info.st_uid, os.getuid()); self.assertEqual(info.st_nlink, 0)
                            self.assertEqual(info.st_size, len(elf()))
                            self.assertEqual(os.pread(image.fd, len(elf()) + 1, 0), elf())
                            self.assertEqual(row["after"]["seals"], 15); self.assertTrue(row["after"]["closeOnExec"])
                            # Denied writes may still update kernel timestamps. Never
                            # refresh the captured baseline or weaken the runtime guard.
                            drifted = M.identity(info)[-2:] != M.identity(image.before)[-2:]
                            row["timestampDriftFromCapture"] = drifted
                            if drifted:
                                with self.assertRaisesRegex(RuntimeError, "Owned immutable close-on-exec memfd required"):
                                    image.check()
                                row["guardResult"] = "refused-metadata-drift"
                            else:
                                image.check()
                                row["guardResult"] = "accepted-unchanged-metadata"
                        self.assertEqual(M.identity(path.lstat()), before)
                        self.assertEqual(path.read_bytes(), elf())
                    finally:
                        raw = json.dumps(diagnostic, sort_keys=True, separators=(",", ":"), allow_nan=False)
                        self.assertLessEqual(len(raw.encode("utf-8")), 8192)
                        print("memfd-denied-syscalls " + raw, flush=True)
                finally:
                    image.close()
            finally:
                source.close()


class Execution(unittest.TestCase):
    def invoke(self, *, code=0, timeout=False, output=None):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary); (root / "home").mkdir(); (root / "evidence").mkdir()
            tool = Mock(fd=412)
            child = Mock(pid=42)
            child.wait.side_effect = (M.subprocess.TimeoutExpired("fixed", 45), 0) if timeout else None
            child.wait.return_value = code
            child.__enter__ = Mock(return_value=child); child.__exit__ = Mock(return_value=False)
            popen = stack.enter_context(patch.object(M.subprocess, "Popen", return_value=child))
            stack.enter_context(patch.object(M, "read_regular", side_effect=((M.VERSION + "\n").encode()
                                                                          if output is None else output, b"")))
            if timeout:
                with self.assertRaisesRegex(RuntimeError, "Owned helper deadline"):
                    M.run_fixed(tool, M.COMMANDS[0], root)
                child.kill.assert_called_once_with()
                self.assertEqual(child.wait.call_count, 2)
            elif code != 0 or output is not None:
                with self.assertRaises(RuntimeError):
                    M.run_fixed(tool, M.COMMANDS[0], root)
            else:
                result = M.run_fixed(tool, M.COMMANDS[0], root)
                self.assertEqual(result["role"], "version")
                self.assertEqual(tool.check.call_count, 2)
                child.kill.assert_not_called()
            return popen.call_args

    def test_only_held_memfd_exec_with_closed_environment_and_cloexec_callback(self):
        call = self.invoke()
        self.assertEqual(call.args, (["/proc/self/fd/412", "--version"],))
        self.assertEqual(call.kwargs["executable"], "/proc/self/fd/412")
        self.assertEqual(call.kwargs["pass_fds"], (412,))
        self.assertIs(call.kwargs["shell"], False)
        self.assertIs(call.kwargs["close_fds"], True)
        self.assertEqual(call.kwargs["stdin"], M.subprocess.DEVNULL)
        self.assertIs(call.kwargs["preexec_fn"].func, M.child_limits)
        self.assertEqual(call.kwargs["preexec_fn"].args, (412,))

    def test_timeout_signals_only_owned_child_once(self):
        self.invoke(timeout=True)

    def test_failed_or_wrong_version_not_adopted(self):
        self.invoke(code=1)
        self.invoke(output=b"1.0.0-beta.8")

    def test_unapproved_add_command_refused_before_spawn(self):
        with patch.object(M.subprocess, "Popen") as popen, self.assertRaises(RuntimeError):
            M.run_fixed(Mock(), ("add", ("projects", "add", "/synthetic/project")), Path("unused"))
        popen.assert_not_called()

    def test_child_restores_cloexec_and_applies_output_limits(self):
        resource = SimpleNamespace(RLIMIT_CORE=4, RLIMIT_FSIZE=1, setrlimit=Mock())
        with patch.dict(sys.modules, {"resource": resource}), patch.object(M.os, "set_inheritable") as setter:
            M.child_limits(412)
        setter.assert_called_once_with(412, False)
        self.assertEqual(resource.setrlimit.call_args_list[0].args, (4, (0, 0)))
        self.assertEqual(resource.setrlimit.call_args_list[1].args, (1, (M.STDOUT_LIMIT, M.STDOUT_LIMIT)))


class Files(unittest.TestCase):
    def test_bounded_regular_read_and_foreign_hash_refusal(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            portable_flags(stack)
            path = Path(temporary) / "fixture"; path.write_bytes(b"exact")
            self.assertEqual(M.read_regular(path, 5, M.pin(b"exact")), b"exact")
            with self.assertRaises(RuntimeError):
                M.read_regular(path, 4)
            with self.assertRaises(RuntimeError):
                M.read_regular(path, 5, M.pin(b"other"))
            with self.assertRaises(RuntimeError):
                M.read_regular(path.parent, 1024)

    def test_exclusive_private_creation_no_existing_mode_repair(self):
        path = Mock()
        path.lstat.return_value = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1000)
        path.resolve.return_value = path
        with patch.object(M.os, "mkdir") as mkdir:
            M.private_directory(path, 1000)
            mkdir.assert_called_once_with(path, 0o700)
        with patch.object(M.os, "mkdir", side_effect=FileExistsError), self.assertRaises(FileExistsError):
            M.private_directory(path, 1000)

    def test_new_wrong_mode_owner_or_alias_refused(self):
        for mode, uid, same in ((0o775, 1000, True), (0o700, 1001, True), (0o700, 1000, False)):
            path = Mock(); path.lstat.return_value = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid)
            path.resolve.return_value = path if same else Mock()
            with self.subTest(mode=mode, uid=uid), patch.object(M.os, "mkdir"), self.assertRaises(RuntimeError):
                M.private_directory(path, 1000)

    def test_held_source_verified_and_kept_open_without_source_chmod(self):
        kernel = FakeMemfd(); kernel.raw.extend(elf()); kernel.mode = 0o500
        info = kernel.info(412); info.st_nlink = 1
        path = Mock(); path.lstat.return_value = info
        with ExitStack() as stack:
            kernel.install(stack); portable_flags(stack)
            stack.enter_context(patch.object(M.os, "open", return_value=412))
            stack.enter_context(patch.object(M.os, "fstat", return_value=info))
            source = M.HeldBinary(path, 1000)
            self.assertEqual(source.check(), elf())
            self.assertEqual(kernel.closed, [])
            M.os.fchmod.assert_not_called()
            source.close(); self.assertEqual(kernel.closed, [412])

    def test_source_link_special_foreign_owner_mode_or_size_refused_before_open(self):
        kernel = FakeMemfd(); kernel.raw.extend(elf()); kernel.mode = 0o500
        info = vars(kernel.info(412)); info["st_nlink"] = 1
        for changes in ({"st_nlink": 2}, {"st_mode": stat.S_IFLNK | 0o500}, {"st_mode": stat.S_IFIFO | 0o500},
                        {"st_uid": 1001}, {"st_mode": stat.S_IFREG | 0o777}, {"st_size": 1}):
            path = Mock(); path.lstat.return_value = SimpleNamespace(**{**info, **changes})
            with self.subTest(changes=changes), patch.object(M, "ASSET", asset(elf())), \
                    patch.object(M.os, "open") as opened, self.assertRaises(RuntimeError):
                M.HeldBinary(path, 1000)
            opened.assert_not_called()

    def test_named_source_replacement_refused_and_fd_closed(self):
        kernel = FakeMemfd(); kernel.raw.extend(elf()); kernel.mode = 0o500
        info = kernel.info(412); info.st_nlink = 1
        replaced = SimpleNamespace(**{**vars(info), "st_ino": 999})
        path = Mock(); path.lstat.side_effect = (info, replaced)
        with ExitStack() as stack:
            kernel.install(stack); portable_flags(stack)
            stack.enter_context(patch.object(M.os, "open", return_value=412))
            stack.enter_context(patch.object(M.os, "fstat", return_value=info))
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                M.HeldBinary(path, 1000)
            self.assertEqual(kernel.closed, [412])

    def test_source_changed_bytes_refused_and_fd_closed(self):
        kernel = FakeMemfd(); kernel.raw.extend(b"x" * len(elf())); kernel.mode = 0o500
        info = kernel.info(412); info.st_nlink = 1
        path = Mock(); path.lstat.return_value = info
        with ExitStack() as stack:
            kernel.install(stack); portable_flags(stack)
            stack.enter_context(patch.object(M.os, "open", return_value=412))
            stack.enter_context(patch.object(M.os, "fstat", return_value=info))
            with self.assertRaises(RuntimeError):
                M.HeldBinary(path, 1000)
            self.assertEqual(kernel.closed, [412])


class Orchestration(unittest.TestCase):
    def perform(self, failure=None):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            env = {**environment(), "GITHUB_WORKSPACE": str(ROOT), "RUNNER_TEMP": temporary}
            source = Mock(before=SimpleNamespace(st_dev=1, st_ino=2))
            image = Mock(before=SimpleNamespace(st_dev=3, st_ino=4, st_uid=1000, st_mode=stat.S_IFREG | 0o700), seals=15)
            stack.enter_context(patch.object(M, "admission", return_value=1000))
            stack.enter_context(patch.object(M, "source_binding", return_value={"fixed": {"sha256": "a" * 64}}))
            stack.enter_context(patch.object(M, "protected_parent"))
            stack.enter_context(patch.object(M, "private_directory", side_effect=lambda path, uid: os.mkdir(path, 0o700)))
            download = stack.enter_context(patch.object(M, "download"))
            held = stack.enter_context(patch.object(M, "HeldBinary", return_value=source))
            sealed = stack.enter_context(patch.object(M, "SealedImage", return_value=image))
            run = stack.enter_context(patch.object(M, "run_fixed", side_effect=failure,
                                                  return_value={"synthetic": "mocked-no-execution"}))
            if failure is None:
                M.execute(env)
            else:
                with self.assertRaisesRegex(RuntimeError, "fixed command refusal"):
                    M.execute(env)
            report = json.loads((Path(temporary) / "linux-unity-registry-probe/evidence/report.json").read_bytes())
            self.assertEqual(report["probeCompleted"], failure is None)
            self.assertEqual(report["genuineNonemptyFixture"], "deferred")
            for name in M.FALSE:
                self.assertIs(report[name], False)
            self.assertEqual(report["tool"]["execution"], "sealed-memfd-cloexec")
            self.assertTrue(report["tool"]["sourceRetained"])
            download.assert_called_once()
            held.assert_called_once()
            sealed.assert_called_once_with(source, 1000)
            source.close.assert_called_once(); image.close.assert_called_once()
            for call in run.call_args_list:
                self.assertIs(call.args[0], image)
            self.assertEqual(run.call_count, len(M.COMMANDS) if failure is None else 1)
            self.assertLess(len(json.dumps(report)), 16384)

    def test_complete_mock_stage_requires_sealed_image_not_source_file_fd(self):
        self.perform()

    def test_failure_receipt_never_promotes_acceptance_or_retries(self):
        self.perform(failure=RuntimeError("fixed command refusal"))

    def test_context_refusal_precedes_any_directory_download_or_execution(self):
        with patch.object(M, "private_directory") as mkdir, patch.object(M, "download") as download, \
                patch.object(M, "run_fixed") as run, self.assertRaises(RuntimeError):
            M.execute({})
        mkdir.assert_not_called(); download.assert_not_called(); run.assert_not_called()


class SourceContracts(unittest.TestCase):
    def test_controller_and_tests_parse_python310_without_execution(self):
        for name in ("native-linux-unity-cli-registry-probe.py", "native-linux-unity-cli-registry-probe.test.py"):
            ast.parse((HERE / name).read_text(encoding="utf-8"), feature_version=(3, 10))

    def test_single_finite_process_launch_and_no_installs_or_chmod_existing(self):
        tree = ast.parse((HERE / "native-linux-unity-cli-registry-probe.py").read_text(encoding="utf-8"))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
        attrs = [node.func.attr for node in calls if isinstance(node.func, ast.Attribute)]
        self.assertEqual(attrs.count("Popen"), 1)
        for name in ("run", "call", "check_call", "check_output", "chmod", "umask", "execve", "execv"):
            self.assertNotIn(name, attrs)
        self.assertNotIn("os.system", [ast.unparse(node.func) for node in calls])
        chmods = [node for node in calls if isinstance(node.func, ast.Attribute) and node.func.attr == "fchmod"]
        self.assertEqual(len(chmods), 1)
        self.assertEqual(ast.unparse(chmods[0]), "os.fchmod(self.fd, 448)")
        self.assertEqual(len([node for node in calls if isinstance(node.func, ast.Attribute)
                              and node.func.attr == "build_opener"]), 1)

    def test_root_snapshot_sealing_protocol_matches_probe(self):
        text = (ROOT / "src-tauri/src/projects.rs").read_text(encoding="utf-8")
        start = text.index("mod linux_registry_image {")
        image = text[start:text.index("fn linux_helper_elf", start)]
        for exact in ("libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING", "libc::F_SEAL_WRITE", "libc::F_SEAL_GROW",
                      "libc::F_SEAL_SHRINK", "libc::F_SEAL_SEAL", "libc::fchmod(sealed.as_raw_fd(), 0o700)",
                      "libc::F_ADD_SEALS", "libc::F_GET_SEALS", '"/proc/self/fd/{}"', "source.recheck(path)?"):
            self.assertIn(exact, image)
        self.assertIn("src-tauri/src/projects.rs", M.SOURCES)

    def test_workflow_yaml_exact_manual_only_closed_authority(self):
        import yaml
        text = (ROOT / ".github/workflows/linux-unity-registry-probe.yml").read_text(encoding="utf-8")
        workflow = yaml.load(text, Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow["on"]), {"push", "workflow_dispatch"})
        self.assertEqual(workflow["on"]["push"], {"branches": ["validation/linux-unity-registry-probe"]})
        request = workflow["on"]["workflow_dispatch"]["inputs"]["execution_request"]
        self.assertEqual(request["default"], "inspect-only")
        self.assertEqual(request["options"], ["inspect-only", M.REQUEST, M.REGISTRATION_REQUEST])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertEqual(set(workflow["jobs"]), {"probe"})
        job = workflow["jobs"]["probe"]
        self.assertEqual(job["runs-on"], "ubuntu-22.04")
        self.assertEqual(job["timeout-minutes"], "10")
        for exact in ("github.repository == '" + M.REPO + "'", "github.repository_id == '" + M.REPO_ID + "'",
                      "github.event_name == 'workflow_dispatch'", "github.ref == '" + M.BRANCH + "'",
                      "github.workflow_ref == '" + M.WORKFLOW + "'", "inputs.execution_request == '" + M.REQUEST + "'"):
            self.assertIn(exact, job["if"])
        self.assertIn("(inputs.execution_request == '" + M.REQUEST + "' || inputs.execution_request == '" + M.REGISTRATION_REQUEST + "')", job["if"])
        self.assertEqual(job["env"], {"UNITY_REGISTRY_PROBE_REQUEST": "${{ inputs.execution_request }}"})
        steps = job["steps"]
        self.assertEqual(len(steps), 5)
        self.assertEqual(steps[0]["with"], {"ref": "${{ github.sha }}", "persist-credentials": "false"})
        self.assertEqual([step["run"] for step in steps if "run" in step], [
            "/usr/bin/python3 -I -B scripts/native-linux-unity-cli-registry-probe.test.py",
            "/usr/bin/python3 -I -B scripts/native-linux-unity-cli-registry-probe.py probe",
            "/usr/bin/python3 -I -B scripts/native-linux-unity-cli-registry-probe.py registration-pagination"])
        self.assertEqual(steps[2]["if"], "inputs.execution_request == '" + M.REQUEST + "'")
        self.assertEqual(steps[3]["if"], "inputs.execution_request == '" + M.REGISTRATION_REQUEST + "'")
        self.assertEqual(steps[-1]["if"], "always()")
        self.assertEqual(steps[-1]["with"]["path"].splitlines(), ["${{ runner.temp }}/linux-unity-registry-probe/evidence/",
                                                               "${{ runner.temp }}/linux-unity-registry-pagination-probe/evidence/"])
        self.assertNotIn("secrets.", text)
        self.assertNotIn("contents: write", text)
        self.assertNotIn("runner.", json.dumps(job["env"]))
        with self.assertRaises(RuntimeError):
            M.admission({**environment(), "GITHUB_EVENT_NAME": "push"}, "Linux", "x86_64", 1000, 1000)


class Registration(unittest.TestCase):
    @staticmethod
    def envelope(rows=None, **changes):
        return json.dumps({"success": True, "command": "projects", "data": [] if rows is None else rows,
                           "errors": [], "warnings": [], **changes}).encode()

    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            portable_flags(stack)
            root = Path(temporary).resolve() / M.REGISTRATION_ROOT
            root.mkdir(mode=0o700)
            for relative in ("home", "home/config", "home/data", "home/cache", "evidence", "runtime", "tmp", "tool"):
                (root / relative).mkdir(mode=0o700)
            if sys.platform == "win32":
                # Windows filesystem modes are not Unix permission evidence.
                stack.enter_context(patch.object(M, "private_directory", side_effect=lambda path, uid: os.mkdir(path, 0o700)))
            yield root

    def test_mode_admission_exact_context_and_cross_request_refusal(self):
        env = {**environment(), "UNITY_REGISTRY_PROBE_REQUEST": M.REGISTRATION_REQUEST}
        self.assertEqual(M.registration_admission(env, "Linux", "x86_64", 1000, 1000), 1000)
        with self.assertRaises(RuntimeError):
            M.admission(env, "Linux", "x86_64", 1000, 1000)
        for name in env:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                M.registration_admission({**env, name: "wrong"}, "Linux", "x86_64", 1000, 1000)
        with self.assertRaises(RuntimeError):
            M.registration_admission(environment(), "Linux", "x86_64", 1000, 1000)

    def test_registration_context_refuses_root_foreign_platform_and_injection(self):
        env = {**environment(), "UNITY_REGISTRY_PROBE_REQUEST": M.REGISTRATION_REQUEST}
        for args in (("Linux", "x86_64", 0, 0), ("Linux", "x86_64", 1000, 0),
                     ("Linux", "aarch64", 1000, 1000), ("Windows", "x86_64", 1000, 1000)):
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                M.registration_admission(env, *args)
        for name in ("LD_PRELOAD", "PYTHONPATH", "SSL_CERT_FILE", "https_proxy", "UNITY_NO_CONSENT_PROMPT", "HUB_TOKEN"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                M.registration_admission({**env, name: "unused"}, "Linux", "x86_64", 1000, 1000)

    def test_main_routes_only_two_exact_phases_without_fallback(self):
        env = environment()
        with patch.object(M, "execute") as readonly, patch.object(M, "execute_registration") as registration:
            M.main(["probe"], env); readonly.assert_called_once_with(env); registration.assert_not_called()
            M.main(["registration-pagination"], env); registration.assert_called_once_with(env)
            for argv in ([], ["inspect"], ["probe", "registration-pagination"], ["registration-pagination", "/foreign"]):
                with self.subTest(argv=argv), self.assertRaises(RuntimeError):
                    M.main(argv, env)
            self.assertEqual(readonly.call_count, 1); self.assertEqual(registration.call_count, 1)

    def test_exact_thirteen_new_synthetic_projects_and_fixed_file_bytes(self):
        self.assertEqual(M.PROJECT_NAMES, tuple("probe-project-" + str(n).zfill(2) for n in range(1, 14)))
        self.assertEqual(M.PROJECT_FILES, {
            "Assets/Probe.txt": b"Synthetic Creator Hub CLI pagination fixture; no Editor execution.\n",
            "Packages/manifest.json": b'{"dependencies":{}}\n',
            "ProjectSettings/ProjectVersion.txt": b"m_EditorVersion: 6000.3.21f1\n"})
        with self.fixture() as root:
            M.seed_projects(root, 0 if sys.platform == "win32" else os.getuid())
            self.assertEqual(set(path.name for path in (root / "home/projects").iterdir()), set(M.PROJECT_NAMES))
            for project in M.registration_paths(root):
                files = {path.relative_to(project).as_posix(): path.read_bytes() for path in project.rglob("*") if path.is_file()}
                self.assertEqual(files, M.PROJECT_FILES)
            with self.assertRaises(FileExistsError):
                M.seed_projects(root, 0 if sys.platform == "win32" else os.getuid())

    def test_path_derivation_refuses_relative_wrong_root_traversal_or_alias(self):
        with self.fixture() as root:
            paths = M.registration_paths(root)
            self.assertEqual(len(set(paths)), 13)
            self.assertTrue(all(path.parent == root / "home/projects" for path in paths))
            for path in (Path("relative") / M.REGISTRATION_ROOT, root.parent, root / ".." / M.REGISTRATION_ROOT):
                with self.subTest(path=path), self.assertRaises(RuntimeError):
                    M.registration_paths(path)
        fake = Mock()
        fake.is_absolute.return_value = True; fake.name = M.REGISTRATION_ROOT; fake.parts = ("/", M.REGISTRATION_ROOT)
        fake.resolve.return_value = Mock()
        with self.assertRaises(RuntimeError):
            M.registration_paths(fake)

    def test_fixed_add_has_only_thirteen_known_absolute_paths_and_exact_flags(self):
        with self.fixture() as root, patch.object(M, "project_inventory") as inventory, \
                patch.object(M.os, "getuid", return_value=1000, create=True), patch.object(M, "_run_command") as command:
            paths = tuple(str(path) for path in M.registration_paths(root))
            add = ("register", ("projects", "add", *paths, *M.COMMANDS[-1][1][2:]))
            M.run_registration_fixed(Mock(), add, root)
            self.assertEqual(command.call_args.args[1], add)
            self.assertEqual(len(paths), 13); inventory.assert_called_once_with(root, 1000)
            M.run_registration_fixed(Mock(), ("list-current", M.COMMANDS[-1][1]), root)
            M.run_registration_fixed(Mock(), ("list-all", (*M.COMMANDS[-1][1], "--all")), root)
            self.assertEqual(command.call_args.args[1][1], (*M.COMMANDS[-1][1], "--all"))

    def test_foreign_missing_duplicate_extra_path_flag_and_command_refused_before_launch(self):
        with self.fixture() as root, patch.object(M, "_run_command") as command:
            paths = tuple(str(path) for path in M.registration_paths(root))
            flags = M.COMMANDS[-1][1][2:]
            bad = (("register", ("projects", "add", *paths[:-1], *flags)),
                   ("register", ("projects", "add", *paths, "/foreign", *flags)),
                   ("register", ("projects", "add", *paths[:-1], paths[0], *flags)),
                   ("register", ("projects", "add", *paths[:-1], paths[-1] + "/../foreign", *flags)),
                   ("register", ("projects", "add", *paths, *flags, "--force")),
                   ("hub-help", ("hub", "install")), ("list-all", ("projects", "list", "--watch")))
            for specification in bad:
                with self.subTest(specification=specification), self.assertRaises(RuntimeError):
                    M.run_registration_fixed(Mock(), specification, root)
            command.assert_not_called()

    def test_unsafe_fixture_inventory_refuses_before_any_registration_input(self):
        with self.fixture() as root, patch.object(M, "project_inventory", side_effect=RuntimeError("unsafe fixture")), \
                patch.object(M.os, "getuid", return_value=1000, create=True), patch.object(M, "_run_command") as command:
            add = ("register", ("projects", "add", *(str(path) for path in M.registration_paths(root)), *M.COMMANDS[-1][1][2:]))
            with self.assertRaisesRegex(RuntimeError, "unsafe fixture"):
                M.run_registration_fixed(Mock(), add, root)
            command.assert_not_called()

    def test_default_subset_vs_all_thirteen_and_unpaged_json_both_valid_observations(self):
        with self.fixture() as root:
            rows = [{"path": str(path)} for path in M.registration_paths(root)]
            every = M.listed_projects(self.envelope(rows), root, all_projects=True)
            self.assertEqual(every, set(M.PROJECT_NAMES))
            self.assertEqual(len(M.listed_projects(self.envelope(rows[:10]), root, all_projects=False)), 10)
            self.assertEqual(M.listed_projects(self.envelope(rows), root, all_projects=False), every)

    def test_duplicate_foreign_noncanonical_unknown_shape_and_incomplete_all_refused(self):
        with self.fixture() as root:
            row = {"path": str(M.registration_paths(root)[0])}
            for rows in ([row, row], [{"path": "/foreign"}], [{"path": row["path"] + "/../other"}],
                         [{"path": 1}], [{"projectPath": row["path"]}], {}):
                with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                    M.listed_projects(self.envelope(rows), root, all_projects=False)
            with self.assertRaises(RuntimeError):
                M.listed_projects(self.envelope([row]), root, all_projects=True)

    def test_partial_failed_warning_duplicate_json_and_oversize_response_refused(self):
        for changes in ({"success": False}, {"success": 1}, {"errors": ["partial"]}, {"warnings": ["skipped"]}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                M.registration_json(self.envelope(**changes))
        for raw in (b'{"success":false,"success":true,"errors":[],"warnings":[]}', b"NaN", b"\xff", b"\x1b",
                    b" " * (M.STDOUT_LIMIT + 1)):
            with self.subTest(size=len(raw)), self.assertRaises((RuntimeError, ValueError)):
                M.registration_json(raw)

    def sequence(self, failure=None, default_count=10):
        with self.fixture() as root, ExitStack() as stack:
            calls = []
            report = {"commands": [], "registrationAttempted": False, "registrationReturnedSuccess": False,
                      "projectContentsUnchanged": False, "paginationCompared": False, **M.FALSE}
            help_text = b"Usage: unity [options] [command]\n  hub  Manage the Unity Hub application\n"
            list_help = b"Usage: unity projects list [options]\n  --all  Print all projects without paging\n  --limit <n> Projects per page (default: 10)\n"
            (root / "evidence/help.stdout").write_bytes(help_text)
            (root / "evidence/list-help.stdout").write_bytes(list_help)
            original_reader = M.read_regular
            # Sequence policy is independent of Windows' lstat/fstat timestamp
            # projection; the strict FD reader has separate real/mocked tests.
            help_outputs = {root / "evidence/help.stdout": help_text, root / "evidence/list-help.stdout": list_help}
            stack.enter_context(patch.object(M, "read_regular", side_effect=lambda path, limit, expected=None:
                help_outputs[path] if path in help_outputs else original_reader(path, limit, expected)))
            stack.enter_context(patch.object(M, "run_fixed", return_value={"mockedReadOnly": True}))
            inventory = stack.enter_context(patch.object(M, "project_inventory", return_value={"fixture": {"kind": "file", "hash": "unchanged"}}))
            if failure == "project-change":
                inventory.side_effect = ({"fixture": "before"}, {"fixture": "after"})
            if failure == "add-and-inventory":
                inventory.side_effect = ({"fixture": "before"}, RuntimeError("later inventory failure"))
            def run(tool, specification, passed_root):
                self.assertEqual(root, passed_root)
                calls.append(specification)
                role = specification[0]
                record = {"role": role, "exitCode": 0}
                if role == "hub-help":
                    raw = b"Usage: unity hub [command]\n"
                elif role == "list-before":
                    raw = self.envelope()
                elif role == "register":
                    if failure == "exit": record["exitCode"] = 1
                    raw = self.envelope(errors=["partial"] if failure in ("partial", "add-and-inventory") else [])
                else:
                    paths = M.registration_paths(root)
                    raw = self.envelope([{"path": str(path)} for path in (paths[:default_count] if role == "list-current" else paths)])
                return record, raw
            stack.enter_context(patch.object(M, "run_registration_fixed", side_effect=run))
            if failure is None:
                M.registration_sequence(Mock(), root, 0 if sys.platform == "win32" else os.getuid(), report)
                self.assertTrue(report["paginationCompared"]); self.assertTrue(report["projectContentsUnchanged"])
                self.assertEqual(report["currentCount"], default_count); self.assertEqual(report["allCount"], 13)
                self.assertEqual(len(report["omittedFixtureIds"]), 13 - default_count)
                self.assertEqual(report["jsonDefaultOmittedFixtures"], default_count != 13)
                self.assertEqual([call[0] for call in calls], ["hub-help", "list-before", "register", "list-current", "list-all"])
            else:
                with self.assertRaises(RuntimeError) as raised:
                    M.registration_sequence(Mock(), root, 0 if sys.platform == "win32" else os.getuid(), report)
                if failure == "add-and-inventory":
                    self.assertIn("partial result", str(raised.exception))
                self.assertFalse(report["paginationCompared"])
                if failure != "project-change":
                    self.assertEqual([call[0] for call in calls], ["hub-help", "list-before", "register"], str(raised.exception))
                if failure != "project-change":
                    self.assertFalse(report["registrationReturnedSuccess"])
            self.assertEqual(sum(call[0] == "register" for call in calls), 1)
            self.assertTrue(report["registrationAttempted"])
            self.assertTrue(all(report[name] is False for name in M.FALSE))
            return report

    def test_registration_then_compare_no_retry_or_root_acceptance(self):
        self.sequence()

    def test_unpaged_json_observed_without_forcing_ten_count(self):
        self.sequence(default_count=13)

    def test_failed_and_partial_registration_stop_before_both_lists(self):
        for failure in ("exit", "partial", "add-and-inventory"):
            with self.subTest(failure=failure):
                report = self.sequence(failure=failure)
                self.assertTrue("projectInventoryAfter" in report or "projectInventoryRefusal" in report)

    def test_project_change_prevents_comparison_acceptance(self):
        report = self.sequence(failure="project-change")
        self.assertFalse(report["projectContentsUnchanged"])

    def test_actual_help_must_advertise_pagination_and_hub_before_any_mutation(self):
        with self.fixture() as root, patch.object(M, "run_fixed"), patch.object(M, "seed_projects") as seed, \
                patch.object(M, "run_registration_fixed") as run:
            (root / "evidence/help.stdout").write_bytes(b"Usage: unity\n")
            with self.assertRaises(RuntimeError):
                M.registration_sequence(Mock(), root, 1000, {"commands": []})
            seed.assert_not_called(); run.assert_not_called()
            (root / "evidence/help.stdout").write_bytes(b"Usage: unity\n  hub Manage the Unity Hub application\n")
            (root / "evidence/list-help.stdout").write_bytes(b"Usage: unity projects list\n")
            with self.assertRaises(RuntimeError):
                M.registration_sequence(Mock(), root, 1000, {"commands": []})
            seed.assert_not_called(); run.assert_not_called()

    def test_source_fixture_and_root_current_arguments_remain_explicit(self):
        source = (ROOT / "src-tauri/src/projects.rs").read_text(encoding="utf-8")
        self.assertIn('cli(&["projects", "list"])', source)
        self.assertIn('.args(["--json", "--non-interactive", "--no-banner", "--no-pager"])', source)
        self.assertIn('entry["path"].as_str()', source)
        controller = (HERE / "native-linux-unity-cli-registry-probe.py").read_text(encoding="utf-8")
        self.assertNotIn('"projects-v1.json"', controller)
        self.assertNotIn('"projects-v2.json"', controller)
        self.assertNotIn('"hub", "install"', controller)

    def test_actual_registration_launcher_uses_sealed_fd_exact_argv_and_closed_child_env(self):
        with self.fixture() as root, patch.object(M, "project_inventory"), \
                patch.object(M.os, "getuid", return_value=1000, create=True), \
                patch.object(M, "read_regular", side_effect=(self.envelope(), b"")), \
                patch.object(M.subprocess, "Popen") as spawn:
            child = Mock(pid=42); child.wait.return_value = 0; spawn.return_value = child
            image = Mock(fd=412)
            args = ("projects", "add", *(str(path) for path in M.registration_paths(root)), *M.COMMANDS[-1][1][2:])
            record, raw = M.run_registration_fixed(image, ("register", args), root)
            self.assertEqual(spawn.call_args.args, (["/proc/self/fd/412", *args],))
            self.assertEqual(spawn.call_args.kwargs["pass_fds"], (412,))
            self.assertEqual(spawn.call_args.kwargs["env"], M.child_environment(root))
            self.assertFalse(spawn.call_args.kwargs["shell"])
            self.assertEqual(image.check.call_count, 2)
            self.assertEqual(record["exitCode"], 0); self.assertEqual(raw, self.envelope())
            child.wait.assert_called_once_with(timeout=M.COMMAND_SECONDS); child.kill.assert_not_called()

    def test_registration_context_failure_precedes_all_creations_and_downloads(self):
        with patch.object(M, "private_directory") as directory, patch.object(M, "download") as download, \
                patch.object(M, "registration_sequence") as sequence, self.assertRaises(RuntimeError):
            M.execute_registration(environment())
        directory.assert_not_called(); download.assert_not_called(); sequence.assert_not_called()

    def test_new_mode_stage_success_and_failure_receipts_keep_all_acceptance_false(self):
        for failed in (False, True):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
                portable_flags(stack)
                env = {**environment(), "UNITY_REGISTRY_PROBE_REQUEST": M.REGISTRATION_REQUEST,
                       "GITHUB_WORKSPACE": str(ROOT), "RUNNER_TEMP": str(Path(temporary).resolve())}
                source = Mock(before=SimpleNamespace(st_dev=1, st_ino=2))
                image = Mock(before=SimpleNamespace(st_dev=3, st_ino=4, st_uid=1000, st_mode=stat.S_IFREG | 0o700), seals=15)
                stack.enter_context(patch.object(M, "registration_admission", return_value=1000))
                binding = stack.enter_context(patch.object(M, "source_binding", return_value={"fixed": "source"}))
                stack.enter_context(patch.object(M, "protected_parent"))
                stack.enter_context(patch.object(M, "private_directory", side_effect=lambda path, uid: os.mkdir(path, 0o700)))
                download = stack.enter_context(patch.object(M, "download"))
                stack.enter_context(patch.object(M, "HeldBinary", return_value=source))
                sealed = stack.enter_context(patch.object(M, "SealedImage", return_value=image))
                def sequence(tool, root, uid, report):
                    self.assertIs(tool, image)
                    self.assertEqual(root, Path(env["RUNNER_TEMP"]) / M.REGISTRATION_ROOT)
                    report["registrationAttempted"] = True
                    if failed:
                        raise RuntimeError("partial registration")
                    report.update(registrationReturnedSuccess=True, paginationCompared=True, projectContentsUnchanged=True)
                stack.enter_context(patch.object(M, "registration_sequence", side_effect=sequence))
                if failed:
                    with self.assertRaisesRegex(RuntimeError, "partial registration"):
                        M.execute_registration(env)
                else:
                    M.execute_registration(env)
                report = json.loads((Path(env["RUNNER_TEMP"]) / M.REGISTRATION_ROOT / "evidence/report.json").read_bytes())
                self.assertEqual(report["scope"], "cli-generated-registry-pagination-only")
                self.assertEqual(report["probeCompleted"], not failed)
                self.assertEqual(report["paginationCompared"], not failed)
                self.assertEqual(report["genuineNonemptyFixture"], "deferred")
                self.assertTrue(all(report[name] is False for name in M.FALSE))
                self.assertEqual(report["tool"]["execution"], "sealed-memfd-cloexec")
                sealed.assert_called_once_with(source, 1000)
                source.close.assert_called_once(); image.close.assert_called_once()
                download.assert_called_once(); self.assertEqual(binding.call_count, 1 if failed else 2)

    @unittest.skipUnless(sys.platform == "linux", "Native Unix mode/link/inventory proof only; no CLI execution")
    def test_real_unix_exact_project_inventory_rejects_links_extras_and_changed_content(self):
        with self.fixture() as root:
            uid = os.getuid()
            M.seed_projects(root, uid)
            before = M.project_inventory(root, uid)
            self.assertEqual(len([v for v in before.values() if v["kind"] == "file"]), 39)
            self.assertEqual(M.project_inventory(root, uid), before)
            project = M.registration_paths(root)[0]
            extra = project / "Assets/extra.txt"; extra.write_bytes(b"unknown")
            with self.assertRaises(RuntimeError):
                M.project_inventory(root, uid)
            extra.unlink()
            path = project / "Assets/Probe.txt"; path.write_bytes(b"changed")
            with self.assertRaises(RuntimeError):
                M.project_inventory(root, uid)
            path.unlink(); path.symlink_to(project / "ProjectSettings/ProjectVersion.txt")
            with self.assertRaises(RuntimeError):
                M.project_inventory(root, uid)


if __name__ == "__main__":
    unittest.main()
