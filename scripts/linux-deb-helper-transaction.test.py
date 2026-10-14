import importlib.util
import json
from pathlib import Path
import tempfile
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
