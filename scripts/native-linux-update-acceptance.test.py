"""Source and isolated-fixture tests only; no installed app or native acceptance."""
import ast
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


p = load("linux_update_prerequisites", HERE / "native-linux-update-acceptance.py")
c = p.components()
fixtures = load("update_existing_root_fixtures", HERE / "native-linux-root-probe.test.py")


class ControlTests(unittest.TestCase):
    def fixture(self):
        f = fixtures.OwnershipTests()
        owner = f.fixture()
        fixtures.p.owned_walk(f.window, owner, f.atspi)
        f.atspi.Role.HEADING = 78
        f.web.children.clear()
        f.heading = fixtures.AxNode(43, 78, "Creator Hub update", parent=f.web)
        f.button = fixtures.AxNode(43, 43, "Update Hub", parent=f.web, verb="press")
        return f, owner

    def test_fixed_control_uses_existing_two_strict_walks_and_one_action(self):
        f, owner = self.fixture()
        with mock.patch.object(p, "components", return_value=c), mock.patch.object(c, "own_tree", wraps=c.own_tree) as walk:
            result = p.press_update_control("update-hub", owner, f.atspi)
        self.assertEqual(walk.call_count, 2)
        f.button.action.do_action.assert_called_once_with(0)
        self.assertEqual(result["actionCount"], 1)
        self.assertTrue(all(result[k] is False for k in p.FALSE_GATES))

    def test_check_updates_is_fixed_not_an_arbitrary_selector(self):
        f, owner = self.fixture()
        f.button.name = "Check for updates"
        with mock.patch.object(p, "components", return_value=c):
            p.press_update_control("check-updates", owner, f.atspi)
        f.button.action.do_action.assert_called_once_with(0)
        with self.assertRaisesRegex(RuntimeError, "Unreviewed"):
            p.press_update_control("Allow", owner, f.atspi)

    def test_original_external_semantic_parent_still_refuses_before_input(self):
        f, owner = self.fixture()
        f.button.parent = fixtures.AxNode(43, 20)
        with mock.patch.object(p, "components", return_value=c), self.assertRaises(c.TreeRefusal):
            p.press_update_control("update-hub", owner, f.atspi)
        f.button.action.do_action.assert_not_called()

    def test_foreign_button_heading_missing_disabled_wrong_role_or_verb_refuse(self):
        changes = (
            lambda f: setattr(f.button, "pid", 99),
            lambda f: setattr(f.heading, "name", "Other section"),
            lambda f: setattr(f.heading, "role", 20),
            lambda f: setattr(f.button, "states", {1}),
            lambda f: setattr(f.button, "role", 20),
            lambda f: setattr(f.button.action, "get_action_name", lambda _: "click"),
            lambda f: setattr(f.button.action, "get_n_actions", lambda: 2),
        )
        for change in changes:
            f, owner = self.fixture()
            change(f)
            with mock.patch.object(p, "components", return_value=c), self.assertRaises(RuntimeError):
                p.press_update_control("update-hub", owner, f.atspi)
            f.button.action.do_action.assert_not_called()

    def test_duplicate_or_replaced_control_refuses(self):
        f, owner = self.fixture()
        other = fixtures.AxNode(43, 43, "Update Hub", parent=f.web, verb="press")
        with mock.patch.object(p, "components", return_value=c), self.assertRaisesRegex(RuntimeError, "unique"):
            p.press_update_control("update-hub", owner, f.atspi)
        other.action.do_action.assert_not_called()
        f.web.children.remove(other)
        same = lambda first, second: first is second and first is not f.button
        with mock.patch.object(p, "components", return_value=c), mock.patch.object(owner, "same_node", side_effect=same), \
                self.assertRaises(RuntimeError):
            p.press_update_control("update-hub", owner, f.atspi)
        f.button.action.do_action.assert_not_called()

    def test_uncertain_action_is_never_retried_or_accepted(self):
        for outcome in (False, RuntimeError("native transport failure")):
            f, owner = self.fixture()
            if outcome is False:
                f.button.action.do_action.return_value = False
            else:
                f.button.action.do_action.side_effect = outcome
            with mock.patch.object(p, "components", return_value=c), self.assertRaises(f.helper.ActionError):
                p.press_update_control("update-hub", owner, f.atspi)
            f.button.action.do_action.assert_called_once_with(0)


class PreservationTests(unittest.TestCase):
    def fixture(self, root):
        for name in p.PRESERVED_FILES:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'{"isolated-fixture":"retained"}\n')
        body = b'{"before-native-save":"retained"}\n'
        name = "launcher-config.json." + hashlib.sha256(body).hexdigest() + ".bak"
        directory = root / p.BACKUPS
        directory.mkdir()
        (directory / name).write_bytes(body)
        return directory / name

    def test_hashes_exact_fixture_and_content_addressed_backups_without_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            backup = self.fixture(root)
            before = p.preservation_snapshot(root, c.B)
            self.assertEqual(before[p.BACKUPS + "/" + backup.name]["sha256"], hashlib.sha256(backup.read_bytes()).hexdigest())
            result = p.require_preserved(root, before, c.B)
            self.assertEqual(result["preservedFixtureFiles"], 6)
            self.assertFalse(result["signedUpdateAccepted"])

    def test_each_changed_setting_or_backup_refuses(self):
        for member in (*p.PRESERVED_FILES, "backup"):
            with self.subTest(member=member), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                backup = self.fixture(root)
                before = p.preservation_snapshot(root, c.B)
                (backup if member == "backup" else root / member).write_bytes(b"changed")
                with self.assertRaises(RuntimeError):
                    p.require_preserved(root, before, c.B)

    def test_missing_empty_unknown_or_falsely_content_addressed_backup_refuses(self):
        for variant in ("missing", "empty", "unknown", "wrong-hash", "extra-directory"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                backup = self.fixture(root)
                if variant in ("missing", "empty"):
                    backup.unlink()
                    if variant == "missing":
                        backup.parent.rmdir()
                elif variant == "unknown":
                    backup.rename(backup.parent / "unreviewed.json")
                elif variant == "wrong-hash":
                    backup.write_bytes(b"not its filename hash")
                else:
                    (backup.parent / "unreviewed-directory").mkdir()
                with self.assertRaises(RuntimeError):
                    p.preservation_snapshot(root, c.B)

    def test_restore_ticket_is_not_mistaken_for_preserved_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.fixture(root)
            before = p.preservation_snapshot(root, c.B)
            ticket = root / "home/data/CreatorHub/hub-updates/hosted-restore.json"
            ticket.parent.mkdir()
            ticket.write_bytes(b"not proof of real view restoration")
            p.require_preserved(root, before, c.B)
            self.assertNotIn(str(ticket.relative_to(root)).replace("\\", "/"), before)

    def test_backup_inventory_is_bounded_before_reading_file_contents(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            backup = self.fixture(root)
            for index in range(32):
                (backup.parent / ("extra-" + str(index))).touch()
            with self.assertRaisesRegex(RuntimeError, "exceeds bound"):
                p.preservation_snapshot(root, c.B)


class SourceTests(unittest.TestCase):
    def test_verifier_links_real_production_code_and_never_windows_only_verify_release(self):
        source = p.release_verifier_source()
        root = HERE.parent
        for member in ("catalog.rs", "update_target.rs", "catalog-key.pub"):
            self.assertIn("../src/" + member, source)
            self.assertTrue((root / "src-tauri/src" / member).is_file())
        for contract in ("catalog::verify_signed_target", "catalog::release_url", "target.updater_key()",
                         "target.descriptor()", "release.required_hub_version()", "key.verify(&bytes, &signature, false)",
                         "changed_descriptor", "changed_package", '"0.1.14"', '"0.1.15"'):
            self.assertIn(contract, source)
        for absent in ("verify_signed_id(", "verify-release", "linux_update::install", "request_restart", "Command::"):
            self.assertNotIn(absent, source)

    def test_generated_example_parses_with_rustfmt_without_resolving_modules(self):
        if not shutil.which("rustfmt"):
            self.skipTest("Rust syntax parser unavailable; no Rust compile or runtime claimed")
        result = subprocess.run(["rustfmt", "--edition", "2021", "--config", "skip_children=true", "--emit", "stdout"],
                                input=p.release_verifier_source(), text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_generated_negative_controls_use_real_signature_and_target_apis(self):
        source = p.release_verifier_source()
        self.assertIn('catalog::verify_signed_target("creator-hub", &changed_descriptor, &detached, false, target).is_ok()', source)
        self.assertIn('catalog::verify_signed_target("creator-hub", &descriptor, &detached, false, foreign).is_ok()', source)
        self.assertIn("key.verify(&changed_package, &signature, false).is_ok()", source)
        self.assertIn('"releaseInputsVerified": true', source)
        self.assertIn('"nativeAcceptance": false', source)

    def test_actual_current_updater_remains_signature_then_suspend_then_linux_install_then_restart(self):
        source = (HERE.parent / "src-tauri/src/self_update.rs").read_text(encoding="utf8")
        install = source[source.index("pub async fn install_hub_update("):source.index("#[cfg(test)]")]
        ordered = ("let installed = installed_location(&handle)?;", "let approved = handle.dialog()",
                   "if !approved", "let installer = download(", "key.verify(&bytes, &signature, false)",
                   "suspend_for_update(", "crate::linux_update::install(", "Outcome::Cancelled", "handle.request_restart()")
        positions = [install.index(value) for value in ordered]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('return Ok("Hub update cancelled at system authorization.', install)

    def test_preservation_paths_follow_actual_native_sources(self):
        root = HERE.parent
        backup = (root / "modules/mcp/launcher/src-tauri/src/settings_backup.rs").read_text(encoding="utf8")
        self.assertIn('const DIRECTORY: &str = ".creator-hub-settings-backups"', backup)
        self.assertIn('{name}.{:x}.bak', backup)
        for member, tokens in {"preferences.rs": ('child_dir("preferences")', '"hub-preferences.json"'),
                               "usage_terms.rs": ('child_dir("consent")', '"hub-usage-terms.json"')}.items():
            source = (root / "src-tauri/src" / member).read_text(encoding="utf8")
            for token in tokens:
                self.assertIn(token, source)

    def test_cli_reports_blocked_nonzero_and_has_no_probe_or_install_mode(self):
        output = io.StringIO()
        with mock.patch.object(p, "components", return_value=c), mock.patch("sys.stdout", output):
            self.assertEqual(p.main(["prerequisites"]), 2)
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(len(report["missing"]), 7)
        self.assertTrue(all(report[key] is False for key in p.FALSE_GATES))
        for args in ([], ["probe"], ["install"], ["--allow-unbound"], ["prerequisites", "override"]):
            with self.assertRaises(RuntimeError):
                p.main(args)

    def test_existing_native_dialog_allowlist_is_not_widened(self):
        tree = ast.parse((HERE / "native-unix-window.py").read_text(encoding="utf8"))
        buttons = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == "BUTTONS" for t in n.targets))
        self.assertNotIn("Update Creator Hub", buttons)
        self.assertNotIn("Authentication Required", buttons)


if __name__ == "__main__":
    unittest.main()
