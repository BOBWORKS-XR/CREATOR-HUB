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
            self.assertEqual(probe.command.call_count, 5)
            self.assertTrue(all(p.HELPER not in call.args[1] for call in probe.command.call_args_list))

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

    def test_workflow_is_one_push_only_job_preflight_first_and_helper_only(self):
        workflow = (p.REPO / ".github/workflows/linux-deb-helper-transaction-014.yml").read_text()
        self.assertIn("branches: [validation/linux-deb-helper-transaction-014]", workflow)
        self.assertIn("paths: ['.github/workflows/linux-deb-helper-transaction-014.yml']", workflow)
        self.assertEqual(workflow.count("runs-on:"), 1)
        self.assertIn("runs-on: ubuntu-22.04", workflow)
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
        self.assertLess(workflow.index("transaction.test.py"), metadata_capture)
        self.assertLess(metadata_capture, workflow.index("cargo test --locked"))
        self.assertLess(metadata_capture, metadata_gate)
        self.assertLess(metadata_capture, workflow.index("actions/download-artifact"))
        self.assertLess(metadata_capture, workflow.index("npm ci"))
        self.assertIn("${{ runner.temp }}/linux-deb-helper-transaction/*.json", workflow)
        self.assertIn("if: always()", workflow)
        self.assertIn("probe.py diagnostics", workflow)
        for forbidden in ("workflow_dispatch:", "matrix:", "macos-", "windows-", "secrets.", "contents: write", "npm run build", "cargo tauri"):
            self.assertNotIn(forbidden, workflow)
        source = Path(p.__file__).read_text()
        for forbidden in ("shell=True", "--force-", "--purge", "--remove", "kill(", "rmtree(", "unlink("):
            self.assertNotIn(forbidden, source)
        self.assertIn('timeout=None', source)
        self.assertIn('"--features", "experimental-transaction"', source)
        self.assertIn('"--manifest-path", "native/linux-deb-retirement/Cargo.toml"', source)


if __name__ == "__main__":
    unittest.main()
