import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("setup_fixture", Path(__file__).with_name("linux-setup-helper-transaction-probe.py"))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class SetupFixtureTests(unittest.TestCase):
    def success(self):
        return {"status": "experimental-transaction-verified", "experimentalTransactionCompiled": True,
                "installationEnabled": False, "nativeAcceptance": False, "product": "setup",
                "package": probe.PACKAGE, "version": probe.NEW, "packageTransactionStarted": True,
                "manualRepairRequired": False, "retainedFilesVerified": 0, "omittedFilesVerified": 5,
                "tombstoneFilesVerified": 1, "retryPolicy": "attempt marker retained; no automatic retry",
                "candidate": probe.PRIVATE + "/setup-0.3.7-preparation-" + "a" * 32 + "/gui-tombstone.deb"}

    def test_fixed_setup_success_and_only_its_private_candidate(self):
        value = self.success()
        self.assertEqual(probe.helper_result(0, json.dumps(value).encode(), b""), value)
        for key, changed in (("product", "mcp"), ("package", "other"), ("version", "0.3.8"),
                ("retainedFilesVerified", 9), ("tombstoneFilesVerified", 0), ("omittedFilesVerified", 4),
                ("installationEnabled", True), ("nativeAcceptance", True), ("manualRepairRequired", True),
                ("packageTransactionStarted", False), ("candidate", "/tmp/gui-tombstone.deb"),
                ("candidate", probe.PRIVATE + "/../other/gui-tombstone.deb"), ("retryPolicy", "retry")):
            with self.subTest(key=key, changed=changed), self.assertRaises(Exception):
                probe.helper_result(0, json.dumps({**value, key: changed}).encode(), b"")
        for code, stderr in ((2, b""), (0, b"warning")):
            with self.assertRaises(Exception):
                probe.helper_result(code, json.dumps(value).encode(), stderr)

    def test_repeat_requires_unknown_prior_attempt_not_arbitrary_failure(self):
        value = {"status": "manual-repair-required", "experimentalTransactionCompiled": True,
                 "installationEnabled": False, "nativeAcceptance": False, "manualRepairRequired": True,
                 "packageTransactionStarted": None, "packageTransactionMayHaveStarted": True,
                 "reason": "An earlier transaction attempt is recorded; manual review"}
        self.assertEqual(probe.helper_result(2, json.dumps(value).encode(), b"", repeat=True), value)
        for key, changed in (("reason", "other failure"), ("packageTransactionStarted", False),
                             ("packageTransactionMayHaveStarted", False), ("manualRepairRequired", False)):
            with self.subTest(key=key), self.assertRaises(Exception):
                probe.helper_result(2, json.dumps({**value, key: changed}).encode(), b"", repeat=True)

    def test_complete_package_paths_preserve_original_and_tombstone_root_difference(self):
        original = probe.package_paths(probe.FILES, False)
        retained = probe.package_paths({probe.NOTICE: None}, True)
        self.assertNotIn("/.", original)
        self.assertEqual(retained, {"/.", "/usr", "/usr/share", "/usr/share/doc",
                                   "/usr/share/doc/creator-project-setup", "/" + probe.NOTICE})
        self.assertNotIn("/", original | retained)
        self.assertEqual(len(probe.FILES), 5)
        self.assertTrue(all("/" + name in original and not name.startswith("home/") for name in probe.FILES))

    def test_fixed_mutation_has_no_external_package_or_path_input(self):
        self.assertEqual(probe.RETIRE, ["/usr/bin/sudo", "-n", "/usr/libexec/creator-hub-deb-retirement-helper", "retire-setup-0.3.7"])
        self.assertNotEqual(probe.PRIVATE, probe.base.PRIVATE)
        self.assertTrue(all(flag is False for flag in dict.fromkeys(probe.base.GATES, False).values()))

    def test_workflow_pins_setup_before_install_and_keeps_failure_evidence(self):
        workflow = (probe.base.REPO / ".github/workflows/linux-deb-helper-transaction-014.yml").read_text()
        download = workflow.index("Download exact published Setup")
        run = workflow.index("run: node scripts/linux-deb-helper-transaction-sdk.cjs")
        self.assertLess(download, run)
        self.assertIn(probe.PACKAGE_SHA, workflow[download:run])
        self.assertIn("= 5966970", workflow[download:run])
        self.assertIn("releases/download/v0.3.7/" + probe.ASSET, workflow[download:run])
        self.assertIn("python3 -B scripts/linux-setup-helper-transaction.test.py", workflow[:download])
        self.assertIn("if: always()\n        run: python3 -B scripts/linux-setup-helper-transaction-probe.py diagnostics", workflow)
        for suffix in ("json", "stdout", "stderr"):
            self.assertIn("/__w/_temp/linux-deb-helper-transaction/setup/*." + suffix, workflow)


if __name__ == "__main__":
    unittest.main()
