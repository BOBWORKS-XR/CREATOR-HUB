import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("transaction_probe", Path(__file__).with_name("linux-deb-helper-transaction-probe.py"))
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


class TransactionTests(unittest.TestCase):
    def test_exact_hosted_lane_and_unprivileged_admission(self):
        p.admission(p.EXPECTED, "Linux", "x86_64", 1000)
        for key in p.EXPECTED:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**p.EXPECTED, key: ""}, "Linux", "x86_64", 1000)
        for system, arch, uid in (("Windows", "x86_64", 1000), ("Linux", "aarch64", 1000), ("Linux", "x86_64", 0)):
            with self.assertRaises(RuntimeError):
                p.admission(p.EXPECTED, system, arch, uid)
        for key in ("FLATPAK_ID", "APPIMAGE", "APPDIR", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"):
            with self.assertRaises(RuntimeError):
                p.admission({**p.EXPECTED, key: "injected"}, "Linux", "x86_64", 1000)

    def success(self):
        return {"experimentalTransactionCompiled": True, "installationEnabled": False, "nativeAcceptance": False,
            "status": "experimental-transaction-verified", "packageTransactionStarted": True,
            "manualRepairRequired": False, "retainedFilesVerified": 9, "omittedFilesVerified": 5,
            "version": p.fixture.NEW, "candidate": p.PRIVATE + "/mcp-2.7.7-preparation-" + "a" * 32 + "/runtime-only.deb"}

    def test_exact_success_only_never_promotes_refusal_or_incomplete_result(self):
        expected = self.success()
        self.assertEqual(p.helper_result(0, json.dumps(expected), b""), expected)
        for key, value in (("status", "refused"), ("installationEnabled", True), ("nativeAcceptance", True),
                ("retainedFilesVerified", 8), ("omittedFilesVerified", 4), ("candidate", "/tmp/untrusted.deb"),
                ("version", "2.7.8"), ("packageTransactionStarted", False)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.helper_result(0, json.dumps({**expected, key: value}), b"")
        for code, stderr in ((2, b""), (0, b"warning")):
            with self.assertRaises(RuntimeError):
                p.helper_result(code, json.dumps(expected), stderr)

    def test_repeat_requires_specific_prior_attempt_not_just_any_refusal(self):
        expected = {**self.success(), "status": "manual-repair-required", "manualRepairRequired": True,
            "packageTransactionStarted": None, "packageTransactionMayHaveStarted": True,
            "reason": "An earlier transaction attempt is recorded; no automatic retry or rollback"}
        p.helper_result(2, json.dumps(expected), b"", repeat=True)
        for key, value in (("reason", "Diversions/statoverrides not supported"), ("packageTransactionStarted", False),
                ("packageTransactionMayHaveStarted", False), ("status", "refused")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.helper_result(2, json.dumps({**expected, key: value}), b"", repeat=True)

    def test_fixed_pins_finite_helper_args_and_false_production_gates(self):
        self.assertEqual(p.RETIRE, ["/usr/bin/sudo", "-n", "/usr/libexec/creator-hub-deb-retirement-helper", "retire-mcp-2.7.7"])
        self.assertEqual((p.fixture.REUSE_RUN, p.fixture.REUSE_ARTIFACT), (38642404016, 11929999662))
        self.assertEqual(p.fixture.PACKAGE_SHA, "db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b")
        self.assertEqual((len(p.fixture.RUNTIME), len(p.fixture.RETIRED)), (9, 5))
        self.assertGreaterEqual(len(p.GATES), 17)
        self.assertFalse(any(dict.fromkeys(p.GATES, False).values()))
        self.assertTrue(p.STAGE.fullmatch("mcp-2.7.7-preparation-" + "a" * 32))
        self.assertIsNone(p.STAGE.fullmatch("../untrusted"))

    def test_cargo_hard_link_is_copied_to_a_fresh_strict_single_link_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, alias, staged = root / "cargo-binary", root / "deps-binary", root / "helper-install-image"
            content = b"synthetic compiled helper bytes\n"
            source.write_bytes(content)
            p.os.link(source, alias)
            self.assertEqual(source.stat().st_nlink, 2)
            with self.assertRaisesRegex(RuntimeError, "single-link"):
                p.fixture.fingerprint(source)
            copied = p.stage_built_helper(source, staged)
            self.assertEqual(staged.stat().st_nlink, 1)
            self.assertEqual(copied["sha256"], p.hashlib.sha256(content).hexdigest())
            self.assertEqual(copied["bytes"], len(content))
            self.assertEqual(alias.read_bytes(), content)
            self.assertEqual(source.stat().st_nlink, 2)
            with self.assertRaises(FileExistsError):
                p.stage_built_helper(source, staged)
            # The strict resource/image fingerprint is still unchanged.
            p.os.link(staged, root / "invalid-installed-image-alias")
            with self.assertRaisesRegex(RuntimeError, "single-link"):
                p.fixture.fingerprint(staged)

    def test_first_refusal_is_captured_once_and_never_retried_or_promoted(self):
        with tempfile.TemporaryDirectory() as temporary:
            probe = p.Probe.__new__(p.Probe)
            probe.root = Path(temporary)
            (probe.root / "before.json").write_text("{}")
            probe.global_state = Mock()
            refusal = {**self.success(), "status": "refused", "packageTransactionStarted": False,
                       "reason": "Diversions/statoverrides not supported"}
            probe.command = Mock(return_value=(2, json.dumps(refusal).encode(), b""))
            with self.assertRaises(RuntimeError):
                probe.retire()
            probe.global_state.assert_called_once_with("pre-retire")
            probe.command.assert_called_once_with("retire-helper", p.RETIRE, allowed=(0, 2), timeout=None)
            self.assertFalse((probe.root / "retire.json").exists())
            with self.assertRaises(RuntimeError):
                probe.repeat()
            self.assertEqual(probe.command.call_count, 1)

    def test_repeat_proves_marker_preservation_and_rechecks_installed_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            probe = p.Probe.__new__(p.Probe)
            probe.root = Path(temporary)
            success = self.success()
            (probe.root / "retire.json").write_text(json.dumps(success))
            (probe.root / "after.json").write_text("{}")
            probe.private_listing = Mock(return_value=b"protected stage manifest")
            probe.snapshot = Mock()
            refusal = {**success, "status": "manual-repair-required", "manualRepairRequired": True,
                "packageTransactionStarted": None, "packageTransactionMayHaveStarted": True,
                "reason": "An earlier transaction attempt is recorded; no automatic retry or rollback"}
            marker = ("Stage: " + success["candidate"] + "\n").encode()
            probe.command = Mock(side_effect=[(0, marker, b""), (2, json.dumps(refusal).encode(), b""), (0, marker, b"")])
            probe.repeat()
            probe.snapshot.assert_called_once_with("after-repeat")
            self.assertEqual(sum(call.args[0] == "repeat-helper" for call in probe.command.call_args_list), 1)
            self.assertEqual(json.loads((probe.root / "repeat.json").read_text()), refusal)

    def test_global_diversions_captured_but_unknown_type_preserved_without_repair(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "database"
            database.mkdir()
            raw = b"/original\n/diverted\npackage\n"
            (database / "diversions").write_bytes(raw)
            (database / "statoverride").mkdir()
            probe = p.Probe.__new__(p.Probe)
            probe.root = root
            probe.command = Mock(return_value=(0, raw, b""))
            with patch.object(p, "Path", side_effect=lambda name: database if name == "/var/lib/dpkg" else Path(name)):
                observed = probe.global_state("fixture")
            self.assertEqual(observed["diversions"]["capturedSha256"], p.hashlib.sha256(raw).hexdigest())
            self.assertTrue(observed["statoverride"]["unknownTypePreserved"])
            self.assertEqual((database / "diversions").read_bytes(), raw)
            self.assertTrue((database / "statoverride").is_dir())
            self.assertEqual(probe.command.call_count, 6)
            self.assertTrue(all(p.HELPER not in call.args[1] for call in probe.command.call_args_list))

    def test_global_state_captures_exact_helper_metadata_query_bytes_and_exit(self):
        showformat = "--showformat=${Installed-Size}\n${Maintainer}\n${Priority}\n${Depends}\n${Description}\n${Conffiles}${Triggers-Pending}${Triggers-Awaited}${Multi-Arch}${Pre-Depends}${Breaks}${Conflicts}${Replaces}${Provides}"
        self.assertIn(json.dumps(showformat), (p.REPO / "native/linux-deb-retirement/src/linux.rs").read_text())
        for code, stdout, stderr in ((0, b"description\n continuation\nno", b""), (2, b"partial\n", b"query diagnostic\n")):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                probe = p.Probe.__new__(p.Probe)
                probe.root = root

                def run(argv, **kwargs):
                    if argv == ["/usr/bin/dpkg-query", "--show", showformat, p.fixture.PACKAGE]:
                        kwargs["stdout"].write(stdout)
                        kwargs["stderr"].write(stderr)
                        return SimpleNamespace(returncode=code)
                    return SimpleNamespace(returncode=0)

                with patch.object(p, "Path", side_effect=lambda name: root / "absent-database" if name == "/var/lib/dpkg" else Path(name)), \
                        patch.object(p.subprocess, "run", side_effect=run) as commands:
                    observed = probe.global_state("pre-retire")
                self.assertEqual(observed["package-metadata"], {"captureExitCode": code})
                captured = root / "pre-retire-package-metadata"
                self.assertEqual(captured.with_suffix(".stdout").read_bytes(), stdout)
                self.assertEqual(captured.with_suffix(".stderr").read_bytes(), stderr)
                self.assertEqual(json.loads((root / "pre-retire-package-metadata-command.json").read_text()),
                    {"argv": ["/usr/bin/dpkg-query", "--show", showformat, p.fixture.PACKAGE], "exitCode": code})
                self.assertTrue(all(call.args[0][0] in ("/usr/bin/dpkg-query", "/usr/bin/dpkg-divert",
                    "/usr/bin/dpkg-statoverride", "/usr/bin/dpkg") for call in commands.call_args_list))

    def test_post_repeat_snapshot_uses_fresh_capture_names_for_all_nine_and_five(self):
        with tempfile.TemporaryDirectory() as temporary:
            probe = p.Probe.__new__(p.Probe)
            probe.root = Path(temporary)
            row = {"bytes": 1, "sha256": "same", "md5": "same", "mode": 0o644, "uid": 0, "gid": 0}
            probe.plan = Mock(return_value={"files": dict.fromkeys(p.fixture.RUNTIME, row)})
            captures = set()
            listing = (p.REPO / "native/linux-deb-retirement/tests/fixtures/compatibility.list").read_text().encode()

            def command(label, argv, **kwargs):
                self.assertNotIn(label, captures, "A second snapshot must not overwrite/fail an earlier capture")
                captures.add(label)
                if label.endswith("-state"):
                    return 0, f"{p.fixture.PACKAGE}\t{p.fixture.NEW}\tamd64\tinstall ok installed\n".encode(), b""
                if label.endswith("-list"):
                    return 0, listing, b""
                if "-omitted-owner-" in label:
                    self.assertEqual(kwargs["allowed"], (1,))
                    return 1, b"", b"no path found"
                if "-owner-" in label:
                    return 0, f"{p.fixture.PACKAGE}: {argv[-1]}\n".encode(), b""
                return 0, b"", b""

            probe.command = command
            with patch.object(p.fixture, "fingerprint", return_value=row), patch.object(p.os.path, "lexists", return_value=False):
                probe.snapshot("after")
                probe.snapshot("after-repeat")
            self.assertEqual(sum("-omitted-owner-" in label for label in captures), 10)
            self.assertTrue((probe.root / "after.json").is_file())
            self.assertTrue((probe.root / "after-repeat.json").is_file())

    def test_success_requires_complete_protected_evidence_but_early_refusal_is_not_retried(self):
        for success, missing in ((True, None), (True, "stage-0-dpkg-stderr"), (False, "private-manifest")):
            with self.subTest(success=success, missing=missing), tempfile.TemporaryDirectory() as temporary:
                probe = p.Probe.__new__(p.Probe)
                probe.root = Path(temporary)
                (probe.root / "report.json").write_text(json.dumps({"helperMechanismAccepted": success}))
                (probe.root / "private-stages.stdout").write_text("mcp-2.7.7-preparation-" + "a" * 32 + "\n")
                probe.global_state = Mock(return_value={})
                probe.command = Mock(side_effect=lambda label, argv, **kwargs: (1 if label == missing else 0, b"", b""))
                if success and missing:
                    with self.assertRaisesRegex(RuntimeError, "lacks complete diagnostics"):
                        probe.diagnostics()
                else:
                    probe.diagnostics()
                saved = json.loads((probe.root / "diagnostics.json").read_text())
                self.assertEqual(saved["evidenceComplete"], missing is None)
                self.assertFalse(any(saved["productionGates"].values()))
                self.assertTrue(all(p.HELPER not in call.args[1] for call in probe.command.call_args_list))
                self.assertTrue((probe.root / "report.json").is_file())

    def metadata_info(self, mode=None, uid=0):
        return SimpleNamespace(st_mode=p.stat.S_IFDIR | 0o755 if mode is None else mode,
            st_uid=uid, st_gid=123, st_dev=7, st_ino=81, st_nlink=4, st_size=4096,
            st_mtime_ns=1234567890123, st_ctime_ns=1234567890456)

    def metadata_probe(self, root):
        probe = p.Probe.__new__(p.Probe)
        probe.root = root
        probe.command = Mock(return_value=(0, b"Debian 'dpkg' version 1.21.1 (amd64).\n", b""))
        probe.global_state = Mock(side_effect=AssertionError("Privileged global collector must not run"))
        return probe

    def test_metadata_diagnostic_captures_exact_parent_failure_fields_without_admission_or_privilege(self):
        with tempfile.TemporaryDirectory() as temporary:
            probe = self.metadata_probe(Path(temporary))
            rows = {name: self.metadata_info() for name in ("/", "/usr", "/usr/share")}
            # A synthetic failing mode, not a claim about the uncaptured runner mode.
            rows["/usr/share"] = self.metadata_info(p.stat.S_IFDIR | 0o775)
            with patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=1001), create=True), \
                    patch.object(p.Path, "lstat", autospec=True, side_effect=lambda path: rows[path.as_posix()]) as lstat:
                observed = probe.metadata_diagnostic()
            self.assertEqual([call.args[0].as_posix() for call in lstat.call_args_list], ["/", "/usr", "/usr/share"])
            share = observed["paths"]["/usr/share"]
            self.assertEqual(share, {"type": "directory", "mode": p.stat.S_IFDIR | 0o775,
                "permissionsOctal": "0775", "uid": 0, "gid": 123, "dev": 7, "ino": 81,
                "nlink": 4, "size": 4096, "mtimeNs": 1234567890123, "ctimeNs": 1234567890456,
                "helperParentChecks": {"directory": True, "rootOwned": True, "modeMaskClear": False},
                "disallowedModeBitsOctal": "0020"})
            self.assertTrue(observed["captureComplete"], "Capturing a refusal is not a capture failure")
            self.assertFalse(observed["packageTransactionStarted"])
            self.assertFalse(observed["nativeAcceptance"])
            self.assertFalse(any(observed["productionGates"].values()))
            self.assertEqual(observed["dpkgVersion"]["exitCode"], 0)
            self.assertIn("1.21.1", observed["dpkgVersion"]["stdout"])
            self.assertEqual(json.loads((probe.root / "metadata-diagnostic.json").read_text()), observed)
            probe.command.assert_called_once_with("metadata-diagnostic-dpkg-version", ["/usr/bin/dpkg", "--version"],
                allowed=(0, 1, 2), timeout=10)
            probe.global_state.assert_not_called()
            self.assertEqual(rows["/usr/share"].st_mode, p.stat.S_IFDIR | 0o775)

    def test_metadata_diagnostic_preserves_lstat_symlink_owner_and_special_mode_evidence(self):
        cases = [(p.stat.S_IFLNK | 0o777, 0, "symlink", False, True, "0022"),
                 (p.stat.S_IFDIR | 0o755, 1001, "directory", True, False, "0000"),
                 (p.stat.S_IFDIR | 0o2755, 0, "directory", True, True, "2000")]
        for mode, uid, kind, directory, root, bits in cases:
            with self.subTest(mode=oct(mode), uid=uid), tempfile.TemporaryDirectory() as temporary:
                probe = self.metadata_probe(Path(temporary))
                info = self.metadata_info(mode, uid)
                with patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=1001), create=True), \
                        patch.object(p.Path, "lstat", return_value=info), \
                        patch.object(p.Path, "resolve", side_effect=AssertionError("Never follow diagnostic paths")):
                    observed = probe.metadata_diagnostic()
                share = observed["paths"]["/usr/share"]
                self.assertEqual((share["type"], share["uid"], share["disallowedModeBitsOctal"]), (kind, uid, bits))
                self.assertEqual(share["helperParentChecks"], {"directory": directory, "rootOwned": root,
                    "modeMaskClear": bits == "0000"})
                self.assertTrue(observed["captureComplete"])

    def test_metadata_diagnostic_saves_partial_capture_then_refuses_missing_failed_or_oversized_evidence(self):
        for failure in ("lstat", "dpkg-exit", "dpkg-timeout", "dpkg-oversized"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                probe = self.metadata_probe(Path(temporary))
                if failure == "dpkg-exit":
                    probe.command.return_value = (1, b"", b"unavailable")
                elif failure == "dpkg-timeout":
                    probe.command.side_effect = p.subprocess.TimeoutExpired(["/usr/bin/dpkg", "--version"], 10)
                elif failure == "dpkg-oversized":
                    probe.command.return_value = (0, b"x" * (16 * 1024 + 1), b"")

                def lstat(path):
                    if failure == "lstat" and path.as_posix() == "/usr/share":
                        raise PermissionError(13, "fixture denied", "/usr/share")
                    return self.metadata_info()

                with patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=1001), create=True), \
                        patch.object(p.Path, "lstat", autospec=True, side_effect=lstat), \
                        self.assertRaisesRegex(RuntimeError, "capture incomplete"):
                    probe.metadata_diagnostic()
                observed = json.loads((probe.root / "metadata-diagnostic.json").read_text())
                self.assertFalse(observed["captureComplete"])
                self.assertTrue(observed["captureErrors"])
                self.assertEqual(set(observed["paths"]), {"/", "/usr", "/usr/share"})
                self.assertFalse(any(observed["productionGates"].values()))
                if failure == "lstat":
                    self.assertEqual(observed["paths"]["/usr/share"]["errno"], 13)
                elif failure == "dpkg-exit":
                    self.assertEqual(observed["dpkgVersion"]["exitCode"], 1)
                elif failure == "dpkg-oversized":
                    self.assertTrue(observed["dpkgVersion"]["truncated"])
                    self.assertEqual(len(observed["dpkgVersion"]["stdout"]), 16 * 1024)
                probe.global_state.assert_not_called()

    def test_metadata_diagnostic_refuses_real_or_effective_root_before_reads(self):
        for uid, euid in ((0, 0), (0, 1001), (1001, 0)):
            probe = self.metadata_probe(Path("unused"))
            probe.save = Mock()
            with patch.multiple(p.os, getuid=Mock(return_value=uid), geteuid=Mock(return_value=euid), create=True), \
                    patch.object(p.Path, "lstat") as lstat, self.assertRaisesRegex(RuntimeError, "Unprivileged"):
                probe.metadata_diagnostic()
            lstat.assert_not_called()
            probe.command.assert_not_called()
            probe.save.assert_not_called()

    def test_metadata_diagnostic_cli_is_fixed_and_never_routes_to_transaction(self):
        probe = Mock()
        probe.metadata_diagnostic.return_value = {"captureComplete": True}
        with patch.object(p, "Probe", return_value=probe), patch.object(p.sys, "argv", ["probe", "metadata-diagnostic"]), \
                patch("builtins.print") as output:
            p.main()
        probe.metadata_diagnostic.assert_called_once_with()
        self.assertEqual(probe.method_calls, [unittest.mock.call.metadata_diagnostic()])
        output.assert_called_once_with('{"captureComplete": true}')
        for args in (["probe"], ["probe", "metadata-diagnostic", "/other"], ["probe", "metadata_diagnostic"]):
            with patch.object(p, "Probe") as constructor, patch.object(p.sys, "argv", args), \
                    self.assertRaises(RuntimeError):
                p.main()
            constructor.assert_not_called()

    def provision_fixture(self, root, mode=None, uid=0):
        probe = self.metadata_probe(root)
        rows = {name: self.metadata_info() for name in ("/", "/usr", "/usr/share")}
        rows["/usr/share"] = self.metadata_info(p.stat.S_IFDIR | 0o777 if mode is None else mode, uid)
        keys = ("mode", "uid", "gid", "dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs")
        attrs = ("st_mode", "st_uid", "st_gid", "st_dev", "st_ino", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        env = {**p.EXPECTED, "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "9", "GITHUB_RUN_ATTEMPT": "1"}
        captured = {"captureComplete": True, "sourceRevision": env["GITHUB_SHA"], "runId": "9", "runAttempt": "1",
            "paths": {name: dict(zip(keys, (getattr(info, attr) for attr in attrs))) for name, info in rows.items()}}
        (root / "metadata-diagnostic.json").write_text(json.dumps(captured))
        return probe, rows, env

    def test_fixture_exact_0777_tightens_only_fixed_parent_and_preserves_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            probe, rows, env = self.provision_fixture(Path(temporary))
            def chmod(label, argv, **kwargs):
                self.assertEqual(argv, ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "--", "0755", "/usr/share"])
                rows["/usr/share"].st_mode = p.stat.S_IFDIR | 0o755
                rows["/usr/share"].st_ctime_ns += 1
                return 0, b"", b""
            probe.command.side_effect = chmod
            with patch.dict(p.os.environ, env, clear=True), patch.object(p.platform, "system", return_value="Linux"), \
                    patch.object(p.platform, "machine", return_value="x86_64"), \
                    patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=1001), create=True), \
                    patch.object(p.Path, "lstat", autospec=True, side_effect=lambda path: rows[path.as_posix()]), \
                    patch.object(p.os, "listdir", return_value=["b", "a"]) as listing:
                result = probe.provision_metadata_fixture()
            probe.command.assert_called_once_with("metadata-fixture-chmod",
                ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "--", "0755", "/usr/share"], timeout=10)
            self.assertTrue(all(call.args == ("/usr/share",) for call in listing.call_args_list))
            before = json.loads((probe.root / "metadata-fixture-before.json").read_text())
            after = json.loads((probe.root / "metadata-fixture-after.json").read_text())
            self.assertEqual(before["entries"], after["entries"])
            for name in ("/", "/usr"):
                self.assertEqual(before["paths"][name], after["paths"][name])
            self.assertTrue(result["fixtureStateVerified"])
            self.assertFalse(result["nativeAcceptance"])
            self.assertFalse(any(result["productionGates"].values()))

    def test_fixture_already_0755_is_a_complete_noop(self):
        with tempfile.TemporaryDirectory() as temporary:
            probe, rows, env = self.provision_fixture(Path(temporary), p.stat.S_IFDIR | 0o755)
            with patch.dict(p.os.environ, env, clear=True), patch.object(p.platform, "system", return_value="Linux"), \
                    patch.object(p.platform, "machine", return_value="x86_64"), \
                    patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=1001), create=True), \
                    patch.object(p.Path, "lstat", autospec=True, side_effect=lambda path: rows[path.as_posix()]), \
                    patch.object(p.os, "listdir", return_value=["a"]):
                with patch.object(p, "Probe", return_value=probe), \
                        patch.object(p.sys, "argv", ["probe", "provision-metadata-fixture"]), patch("builtins.print"):
                    p.main()
            probe.command.assert_not_called()
            before = json.loads((probe.root / "metadata-fixture-before.json").read_text())
            after = json.loads((probe.root / "metadata-fixture-after.json").read_text())
            self.assertEqual(before["paths"], after["paths"])
            self.assertEqual(before["entries"], after["entries"])
            self.assertFalse(after["chmodRequested"])
            self.assertTrue(after["fixtureStateVerified"])

    def test_fixture_unexpected_state_or_drift_refuses_without_other_path_repair(self):
        cases = ("mode", "special-mode", "symlink", "uid", "capture-drift", "pre-drift", "post-inode",
                 "post-entries", "post-root", "user-pc", "wrong-branch", "effective-root")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                mode = {"mode": p.stat.S_IFDIR | 0o775, "special-mode": p.stat.S_IFDIR | 0o2777,
                    "symlink": p.stat.S_IFLNK | 0o777}.get(case)
                probe, rows, env = self.provision_fixture(Path(temporary), mode, 1001 if case == "uid" else 0)
                names, reads = ["a"], []
                if case == "capture-drift":
                    rows["/usr/share"].st_ino += 1
                if case == "wrong-branch":
                    env["GITHUB_REF"] = "refs/heads/main"
                def lstat(path):
                    name = path.as_posix()
                    if name == "/usr/share":
                        reads.append(name)
                        if case == "pre-drift" and len(reads) == 2:
                            rows[name].st_ino += 1
                    return rows[name]
                def chmod(*args, **kwargs):
                    rows["/usr/share"].st_mode = p.stat.S_IFDIR | 0o755
                    if case == "post-inode":
                        rows["/usr/share"].st_ino += 1
                    if case == "post-entries":
                        names.append("unexpected")
                    if case == "post-root":
                        rows["/"].st_ctime_ns += 1
                    return 0, b"", b""
                probe.command.side_effect = chmod
                with patch.dict(p.os.environ, env, clear=True), \
                        patch.object(p.platform, "system", return_value="Windows" if case == "user-pc" else "Linux"), \
                        patch.object(p.platform, "machine", return_value="x86_64"), \
                        patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=0 if case == "effective-root" else 1001), create=True), \
                        patch.object(p.Path, "lstat", autospec=True, side_effect=lstat) as observed, \
                        patch.object(p.os, "listdir", side_effect=lambda path: names[:]), self.assertRaises(RuntimeError):
                    probe.provision_metadata_fixture()
                self.assertEqual(probe.command.call_count, 1 if case.startswith("post-") else 0)
                if case in ("user-pc", "wrong-branch", "effective-root"):
                    observed.assert_not_called()
                if case.startswith("post-"):
                    after = json.loads((probe.root / "metadata-fixture-after.json").read_text())
                    self.assertFalse(after["fixtureStateVerified"])
                    self.assertFalse(any(after["productionGates"].values()))

    def test_container_admission_requires_exact_image_and_fixture_uid(self):
        env = {"CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE": p.CONTAINER_IMAGE, "RUNNER_TEMP": "/__w/_temp"}
        p.container_admission(env, 1001, 1001, True)
        for configured, uid, euid, marker in ((env, 0, 0, True), (env, 1000, 1000, True),
                (env, 1001, 0, True), (env, 1001, 1001, False), ({}, 1001, 1001, True),
                ({**env, "CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE": "ubuntu:22.04"}, 1001, 1001, True),
                ({**env, "RUNNER_TEMP": "/home/runner/work/_temp"}, 1001, 1001, True)):
            with self.subTest(uid=uid, euid=euid, marker=marker), self.assertRaises(RuntimeError):
                p.container_admission(configured, uid, euid, marker)

    def test_container_identity_records_actual_versions_without_acceptance(self):
        probe = self.metadata_probe(Path("unused"))
        versions = {"dpkg": b"Debian dpkg 1.21.1 (amd64)\n", "rustc": b"rustc 1.99.0 (fixture)\n",
                    "cargo": b"cargo 1.99.0 (fixture)\n", "node": b"v24.17.0\n"}
        probe.command.side_effect = lambda label, argv, **kw: (0, versions[label.removeprefix("container-")], b"")
        probe.save = Mock(side_effect=lambda label, value: value)
        with patch.dict(p.os.environ, {**p.EXPECTED, "CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE": p.CONTAINER_IMAGE,
                "RUNNER_TEMP": "/__w/_temp"}, clear=True), \
                patch.multiple(p.os, getuid=Mock(return_value=1001), geteuid=Mock(return_value=1001), create=True), \
                patch.object(p.Path, "is_file", return_value=True), \
                patch.object(p.Path, "read_text", return_value='ID=ubuntu\nVERSION_ID="22.04"\n'):
            observed = probe.container_identity()
            self.assertEqual(observed["configuredContainerImage"], p.CONTAINER_IMAGE)
            self.assertEqual(observed["imageSourceUrl"], p.CONTAINER_SOURCE)
            self.assertEqual(observed["observedTagIndexDigest"], p.CONTAINER_INDEX)
            self.assertEqual(observed["runnerTemp"], "/__w/_temp")
            self.assertEqual(observed["evidenceDirectory"], str(probe.root))
            self.assertEqual(observed["versions"]["dpkg"]["stdout"], versions["dpkg"].decode())
            self.assertEqual((observed["uid"], observed["euid"]), (1001, 1001))
            self.assertFalse(observed["nativeAcceptance"])
            self.assertFalse(any(observed["productionGates"].values()))
            versions["node"] = b"v24.16.0\n"
            with self.assertRaisesRegex(RuntimeError, "Exact container toolchain"):
                probe.container_identity()
        probe.save.assert_called_once()
        probe.global_state.assert_not_called()

    def test_preflight_cli_keeps_evidence_out_of_sdk_transaction_namespace(self):
        for phase, method, preflight in (("container-identity", "container_identity", True),
                ("metadata-diagnostic", "metadata_diagnostic", True),
                ("provision-metadata-fixture", "provision_metadata_fixture", True),
                ("prepare", "prepare", False), ("install", "install", False), ("diagnostics", "diagnostics", False)):
            probe = Mock()
            getattr(probe, method).return_value = {}
            with self.subTest(phase=phase), patch.object(p, "Probe", return_value=probe) as constructor, \
                    patch.object(p.sys, "argv", ["probe", phase]), patch("builtins.print"):
                p.main()
            constructor.assert_called_once_with(preflight=preflight)
            getattr(probe, method).assert_called_once_with()

    def test_preflight_constructor_does_not_occupy_sdk_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            real_stat, real_read = p.Path.stat, p.Path.read_text
            def fixture_stat(path, *args, **kwargs):
                actual = real_stat(path, *args, **kwargs)
                return self.metadata_info(p.stat.S_IFDIR | 0o700, 1001) if path == root / "linux-deb-helper-preflight" else actual
            def fixture_read(path, *args, **kwargs):
                return 'ID=ubuntu\nVERSION_ID="22.04"\n' if path == Path("/etc/os-release") else real_read(path, *args, **kwargs)
            with patch.dict(p.os.environ, {**p.EXPECTED, "RUNNER_TEMP": str(root)}, clear=True), \
                    patch.object(p.platform, "system", return_value="Linux"), \
                    patch.object(p.platform, "machine", return_value="x86_64"), \
                    patch.object(p.os, "getuid", return_value=1001, create=True), \
                    patch.object(p.Path, "stat", autospec=True, side_effect=fixture_stat), \
                    patch.object(p.Path, "read_text", autospec=True, side_effect=fixture_read):
                probe = p.Probe(preflight=True)
            self.assertEqual(probe.root, root / "linux-deb-helper-preflight")
            self.assertTrue(probe.root.is_dir())
            sdk_root = root / "linux-deb-helper-transaction"
            self.assertFalse(sdk_root.exists())
            sdk_root.mkdir()  # The SDK's create-new directory operation must still succeed.

    def test_workflow_is_one_pinned_container_push_job_preflight_first_and_helper_only(self):
        workflow = (p.REPO / ".github/workflows/linux-deb-helper-transaction-014.yml").read_text()
        self.assertIn("branches: [validation/linux-deb-helper-transaction-014]", workflow)
        self.assertIn("paths: ['.github/workflows/linux-deb-helper-transaction-014.yml']", workflow)
        self.assertEqual(workflow.count("runs-on:"), 1)
        self.assertIn("runs-on: ubuntu-22.04", workflow)
        self.assertEqual(workflow.count(p.CONTAINER_IMAGE), 2)
        self.assertIn("shell: sudo -H -u fixture -E env PATH=", workflow)
        self.assertIn("CARGO_HOME: /opt/creator-cargo", workflow)
        self.assertIn("RUSTUP_HOME: /opt/creator-rustup", workflow)
        self.assertIn("      DEBIAN_FRONTEND: noninteractive", workflow)
        self.assertLess(workflow.index("apt-get install -y --no-install-recommends"), workflow.index("actions/checkout"))
        self.assertLess(workflow.index("actions/checkout"), workflow.index("'/usr/bin/chown'"))
        self.assertIn("assert targets == expected", workflow)
        self.assertIn("path.resolve(strict=True) == path", workflow)
        self.assertIn("'-R', '-P', '--no-dereference'", workflow)
        self.assertIn("--default-toolchain 1.99.0 --component clippy --component rustfmt", workflow)
        self.assertIn("ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917", workflow)
        self.assertIn("--check --strict", workflow)
        self.assertIn("github.repository_id == '1364807512'", workflow)
        self.assertIn("github.event_name == 'push'", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("artifact-ids: '11929999662'", workflow)
        self.assertIn("run-id: '38642404016'", workflow)
        self.assertLess(workflow.index("transaction.test.py"), workflow.index("actions/download-artifact"))
        self.assertLess(workflow.index("transaction-sdk.test.cjs"), workflow.index("npm ci"))
        metadata_gate = workflow.index("host_metadata_read_only_preflight")
        self.assertLess(metadata_gate, workflow.index("actions/download-artifact"))
        self.assertLess(metadata_gate, workflow.index("npm ci"))
        self.assertIn("-- --ignored --exact --nocapture", workflow)
        self.assertIn("--all-targets --all-features -- -D warnings", workflow)
        metadata_capture = workflow.index("probe.py metadata-diagnostic")
        self.assertNotIn("probe.py provision-metadata-fixture", workflow)
        self.assertLess(workflow.index("probe.py container-identity"), metadata_capture)
        self.assertLess(workflow.index("transaction.test.py"), metadata_capture)
        self.assertLess(metadata_capture, workflow.index("cargo test --locked"))
        self.assertLess(metadata_capture, metadata_gate)
        self.assertLess(metadata_capture, workflow.index("actions/download-artifact"))
        self.assertLess(metadata_capture, workflow.index("npm ci"))
        self.assertIn("/__w/_temp/linux-deb-helper-transaction/*.json", workflow)
        self.assertIn("/__w/_temp/linux-deb-helper-preflight/*.json", workflow)
        self.assertIn("if: always()", workflow)
        self.assertIn("probe.py diagnostics", workflow)
        for forbidden in ("workflow_dispatch:", "matrix:", "macos-", "windows-", "secrets.", "contents: write", "npm run build", "cargo tauri",
                          "--privileged", "--cap-add", "volumes:", "apt-get upgrade", "apt-get dist-upgrade", "chmod /usr", "chown /usr"):
            self.assertNotIn(forbidden, workflow)
        self.assertNotRegex(workflow, r"(?:chmod|chown)[^\n]*/usr(?:/|\b)")
        source = Path(p.__file__).read_text()
        for forbidden in ("shell=True", "--force-", "--purge", "--remove", "kill(", "rmtree(", "unlink("):
            self.assertNotIn(forbidden, source)
        self.assertIn('timeout=None', source)
        self.assertIn('"--features", "experimental-transaction"', source)
        self.assertIn('"--manifest-path", "native/linux-deb-retirement/Cargo.toml"', source)

    def test_artifact_globs_use_container_paths_for_every_line_not_host_runner_context(self):
        workflow = (p.REPO / ".github/workflows/linux-deb-helper-transaction-014.yml").read_text()
        upload = workflow.split("uses: actions/upload-artifact@v4", 1)[1]
        paths = [line.strip() for line in upload.split("path: |", 1)[1].splitlines() if line.strip()]
        expected = [f"/__w/_temp/linux-deb-helper-{directory}/*.{extension}"
            for directory in ("preflight", "transaction") for extension in ("json", "stdout", "stderr")]
        self.assertEqual(paths, expected)
        self.assertNotIn("${{ runner.temp }}", upload)
        self.assertNotIn("/home/runner/work", upload)
        self.assertIn("path: /__w/_temp/linux-deb-helper-transaction-input", workflow)


if __name__ == "__main__":
    unittest.main()
