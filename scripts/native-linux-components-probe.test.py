"""Pure/temp contracts only. No application, installer, desktop or user data."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


p = load("components_probe_test_subject", HERE / "native-linux-components-probe.py")
fixtures = load("components_root_pure_fixtures", HERE / "native-linux-root-probe.test.py")


class ContractTests(unittest.TestCase):
    def test_exact_previous_product_and_root_helper_no_rebuild(self):
        self.assertEqual(p.B.SOURCE, "5bb05a21d73c0fc3b2839cbcbd4322832b24aead")
        self.assertEqual(p.B.RUN, 38630742955)
        self.assertEqual(p.B.ARTIFACT, 11927495507)
        self.assertEqual(hashlib.sha256((HERE / "native-linux-root-probe.py").read_bytes()).hexdigest(), p.ROOT_SHA)
        self.assertTrue(all(value is False for value in p.FALSE_GATES.values()))

    def test_each_admission_guard_precedes_native_operations(self):
        env = fixtures.runner_fixture() | {"CREATOR_LINUX_COMPONENTS_PROBE": "1"}
        p.admission(env, "linux", "x86_64")
        for key in env:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({k: v for k, v in env.items() if k != key}, "linux", "x86_64")
        for key in ("FLATPAK_ID", "APPIMAGE", "APPDIR"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission(env | {key: "foreign"}, "linux", "x86_64")
        source = (HERE / "native-linux-components-probe.py").read_text().split("def main():")[1]
        self.assertLess(source.index("admission("), source.index("ordinary("))

    def test_environment_stays_finite_and_auth_free(self):
        env = p.B.child_env({"GITHUB_TOKEN": "secret", "NODE_OPTIONS": "inject", "LD_PRELOAD": "inject",
                             "PYTHONPATH": "inject", "PATH": "foreign"}, Path("/fixture"))
        self.assertEqual(env["PATH"], "/usr/bin:/bin")
        for key in ("GITHUB_TOKEN", "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH"):
            self.assertNotIn(key, env)

    def test_manifest_contract_uses_actual_hash_and_separate_archive_size_mode(self):
        manifest = {"modules": {}, "payloadArchive": {"files": {}}}
        for app, pin in p.APPS.items():
            name = app + "/image"
            manifest["modules"][app] = {"executable": name, "files": {name: pin["hash"]}}
            manifest["payloadArchive"]["files"][name] = {"size": pin["size"], "mode": 0o755}
        with mock.patch.object(p.B, "bounded_read", return_value=json.dumps(manifest).encode()):
            self.assertEqual(p.manifest_pins(Path("/fixture")), manifest)
        for field, value in (("size", 1), ("mode", 0o644)):
            changed = copy.deepcopy(manifest)
            changed["payloadArchive"]["files"]["setup/image"][field] = value
            with mock.patch.object(p.B, "bounded_read", return_value=json.dumps(changed).encode()), self.assertRaises(RuntimeError):
                p.manifest_pins(Path("/fixture"))

    def test_no_arbitrary_selector_ipc_state_injection_or_process_kill(self):
        source = (HERE / "native-linux-components-probe.py").read_text()
        for forbidden in (".kill(", ".terminate(", "os.kill(", "killall", "pkill", "xdotool", "shell=True",
                          "execute_script", "localStorage", "accept_usage_terms", "__CREATOR_HOSTED_TERMS_ACCEPTED__",
                          "--no-sandbox", "WEBKIT_DISABLE_SANDBOX", "wm_close=True"):
            self.assertNotIn(forbidden, source)
        self.assertIn("helper.KernelBinding(parsed, helper.Proc())", source)
        self.assertIn('B.process_uids(actual["pid"]) == uid_before', source)
        self.assertEqual(set(p.CONTROLS), {"view-setup", "view-mcp", "retry", "requirements", "skip-migration", "save-guide"})

    def test_workflow_uses_complete_reviewed_candidate_without_changing_api_binding_guards(self):
        body = (HERE.parent / ".github/workflows/native-linux-components-014.yml").read_text()
        for literal in (p.B.GTK3_CANDIDATE, p.B.GTK3_PREPARATION["source"], p.B.GTK3_PREPARATION["handoffSha256"],
                        "sha=pins.SOURCE,tree=pins.TREE", "runId=pins.RUN,artifactId=pins.ARTIFACT",
                        "zipSize=pins.ZIP_SIZE,zipSha=pins.ZIP_SHA", "pins.ARTIFACT_NAME", "job.id,pins.JOB",
                        "run.run_attempt,pins.ATTEMPT", "job.run_attempt,pins.ATTEMPT", "pins.helperSha256",
                        "Buffer.isBuffer(data)||data instanceof ArrayBuffer", "persist-credentials: false", "if: always()",
                        "ubuntu-22.04", "CREATOR_LINUX_COMPONENTS_PROBE", "validation/linux-components-014",
                        "native-linux-components-probe.py\" probe", "linux-root-probe/*.json", "linux-root-input.zip"):
            self.assertIn(literal, body)
        self.assertLess(body.index("native-linux-components-probe.test.py"), body.index("downloadArtifact("))
        self.assertLess(body.index("candidate-pins >"), body.index("getWorkflowRun("))
        self.assertLess(body.index("assert.equal(commit.tree.sha,tree)"), body.index("downloadArtifact("))
        self.assertLess(body.index("native-linux-root-probe.py stage"), body.index("native-linux-root-probe.py install"))
        for forbidden in ("cargo build", "npm run build", "secrets."):
            self.assertNotIn(forbidden, body)

    def test_removed_unpublished_zenity_draft_has_no_runtime_code_or_inputs(self):
        source = (HERE / "native-linux-components-probe.py").read_text()
        for removed in ("system_zenity", "inventory_zenity", "zenity_proof", "ZENITY", "import shutil"):
            self.assertNotIn(removed, source)
        self.assertIn("helper.Request.sealed(args, parsed)", source)
        self.assertIn("helper.perform(req, atspi, helper.Proc(), x11, binding)", source)

    def test_pending_assembly_blocks_component_cli_before_any_staging_or_native_read(self):
        subject = load("components_pending_candidate", HERE / "native-linux-components-probe.py")
        subject.B.GTK3_REVIEWED_PINS = None
        with mock.patch.object(subject, "admission"), mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(subject.B, "ordinary") as paths, mock.patch.object(subject.subprocess, "Popen") as spawn, \
                self.assertRaisesRegex(RuntimeError, "outer assembly pins unavailable"):
            subject.main()
        paths.assert_not_called()
        spawn.assert_not_called()
        self.assertEqual(subject.B.SELECTED_CANDIDATE, subject.B.ORIGINAL_CANDIDATE)

    def test_explicit_old_candidate_is_held_not_used_as_component_cli_fallback(self):
        subject = load("components_old_candidate_held", HERE / "native-linux-components-probe.py")
        with mock.patch.object(subject, "admission"), \
                mock.patch.dict(os.environ, {"CREATOR_LINUX_ROOT_CANDIDATE": subject.B.ORIGINAL_CANDIDATE}, clear=True), \
                mock.patch.object(subject.B, "ordinary") as paths, self.assertRaisesRegex(RuntimeError, "dispatches are held"):
            subject.main()
        paths.assert_not_called()

    def test_compact_capture_upload_precedes_separate_original_zip_and_keeps_refusals(self):
        body = (HERE.parent / ".github/workflows/native-linux-components-014.yml").read_text()
        compact = body.split("      - name: Retain compact owned capture first", 1)[1]
        compact, original = compact.split("      - name: Retain original immutable package evidence separately", 1)
        self.assertNotIn("linux-root-input.zip", compact)
        self.assertNotIn("linux-root-probe/input/", compact)
        for suffix in ("*.json", "*.stdout", "*.stderr", "root-window.png"):
            self.assertIn("linux-root-probe/" + suffix, compact)
        self.assertIn("if: always()", compact)
        self.assertIn("linux-root-input.zip", original)
        self.assertIn("input/signed-unix-assembly.json", original)
        self.assertIn("if: always()", original)


class OwnershipTests(unittest.TestCase):
    def fixture(self):
        f = fixtures.OwnershipTests()
        owner = f.fixture()
        fixtures.p.owned_walk(f.window, owner, f.atspi)
        f.web.children.clear()
        f.button = fixtures.AxNode(43, 43, p.APPS["setup"]["view"], parent=f.web, verb="press")
        return f, owner

    def test_fixed_control_one_native_press_after_two_complete_walks(self):
        f, owner = self.fixture()
        result = p.press("view-setup", owner, f.atspi)
        self.assertEqual(result["actionCount"], 1)
        f.button.action.do_action.assert_called_once_with(0)

    def test_builtin_retry_is_observed_retry_opening_not_companion_open_in_hub(self):
        f, owner = self.fixture()
        f.button.name = "Open in Hub"
        with self.assertRaisesRegex(RuntimeError, "Retry opening"):
            p.press("retry", owner, f.atspi)
        f.button.action.do_action.assert_not_called()
        f.button.name = "Retry opening"
        self.assertEqual(p.press("retry", owner, f.atspi)["button"], "Retry opening")
        f.button.action.do_action.assert_called_once_with(0)

    def test_contained_semantic_parent_is_allowed_but_external_parent_is_refused(self):
        f, owner = self.fixture()
        f.button.parent = f.container
        self.assertIn(f.button, p.own_tree(f.window, owner, f.atspi))
        f.button.parent = fixtures.AxNode(43, 20)
        with self.assertRaisesRegex(RuntimeError, "escaped"):
            p.press("view-setup", owner, f.atspi)
        f.button.action.do_action.assert_not_called()

    def test_foreign_pid_nested_window_duplicate_ref_and_extra_renderer_refused(self):
        for change in ("pid", "window", "duplicate"):
            f, owner = self.fixture()
            if change == "pid":
                f.button.pid = 99
            elif change == "window":
                f.button.role = f.atspi.Role.WINDOW
            else:
                f.web.children.append(f.button)
            with self.subTest(change=change), self.assertRaises((RuntimeError, KeyError)):
                p.press("view-setup", owner, f.atspi)
            f.button.action.do_action.assert_not_called()

    def test_pid_reuse_root_uid_or_renderer_image_changed_refused(self):
        for pid, field, value in ((42, "startTime", "999"), (42, "uids", [0]*4),
                                  (43, "parentPid", 1), (43, "kernelImageSha256", "f"*64)):
            f, owner = self.fixture()
            f.records[pid][field] = value
            with self.subTest(pid=pid, field=field), self.assertRaises(RuntimeError):
                p.press("view-setup", owner, f.atspi)
            f.button.action.do_action.assert_not_called()

    def test_wrong_name_role_action_duplicate_or_disabled_control_refused(self):
        for change in ("name", "role", "verb", "disabled", "duplicate"):
            f, owner = self.fixture()
            if change == "name":
                f.button.name = "Launch project"
            elif change == "role":
                f.button.role = f.atspi.Role.LINK
            elif change == "verb":
                f.button.action.get_action_name = lambda _: "click"
            elif change == "disabled":
                f.button.states = {1}
            else:
                fixtures.AxNode(43, 43, f.button.name, parent=f.web, verb="press")
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.press("view-setup", owner, f.atspi)
            f.button.action.do_action.assert_not_called()

    def test_changed_second_walk_refuses_before_effect(self):
        f, owner = self.fixture()
        first = p.own_tree(f.window, owner, f.atspi)
        second = list(first[:-1]) + [fixtures.AxNode(43, 43, f.button.name, verb="press")]
        with mock.patch.object(p, "own_tree", side_effect=[first, second]), self.assertRaisesRegex(RuntimeError, "changed"):
            p.press("view-setup", owner, f.atspi)
        f.button.action.do_action.assert_not_called()


class NativeReceiptTests(unittest.TestCase):
    def test_procfs_children_is_bounded_without_an_ordinary_file_size_assumption(self):
        opener = mock.Mock(return_value=io.BytesIO(b"43 44 "))
        self.assertEqual(p.proc_children(42, opener), [43, 44])
        opener.assert_called_once_with("/proc/42/task/42/children", "rb")
        self.assertEqual(p.proc_children(42, lambda *_: io.BytesIO(b"")), [])
        for body in (b"1 ", b"42 ", b"43 43 ", b"0", b"01", b"43\x00", b"9 "*33, b"9"*4097):
            with self.subTest(body=body[:20]), self.assertRaises(RuntimeError):
                p.proc_children(42, lambda *_: io.BytesIO(body))

    def fixture(self):
        parent = {"pid": 42, "startTime": "100", "uids": [os.getuid()]*4 if hasattr(os, "getuid") else [1000]*4,
                  "executable": str(Path("/usr/bin/creator-hub").resolve())}
        actual = {"pid": 43, "startTime": "110", "uids": list(parent["uids"]), "parentPid": 42,
                  "kernelImageSha256": p.APPS["setup"]["hash"]}
        image = {"device": "1", "inode": "2", "size": p.APPS["setup"]["size"], "seals": 15,
                 "sha256": p.APPS["setup"]["hash"]}
        return parent, actual, image

    def test_observed_receipt_is_accepted_only_with_independent_product_pins(self):
        parent, actual, image = self.fixture()
        with mock.patch.object(p.os, "getuid", return_value=parent["uids"][0], create=True):
            result = p.receipt(parent, actual, image, "setup")
        helper = p.B.load_helper()
        pins = ["42", "100", p.B.INSTALLED_HUB_PIN[1], p.APPS["setup"]["hash"], p.B.SOURCE, str(p.B.RUN)]
        self.assertEqual(helper.Receipt.parse(result, pins).child_pid, 43)
        with self.assertRaises(RuntimeError):
            helper.Receipt.parse(result, pins[:-1] + ["1"])

    def test_wrong_parent_uid_hash_size_or_missing_seals_cannot_authorize_dialog(self):
        for which, field, value in (("child", "parentPid", 99), ("child", "uids", [0]*4),
                                    ("image", "sha256", "f"*64), ("image", "size", 1), ("image", "seals", 7)):
            parent, actual, image = self.fixture()
            if field == "uids":
                value = [parent["uids"][0] + 1]*4
            (actual if which == "child" else image)[field] = value
            with mock.patch.object(p.os, "getuid", return_value=parent["uids"][0], create=True), self.subTest(field=field), self.assertRaises(RuntimeError):
                p.receipt(parent, actual, image, "setup")

    def test_native_consent_uses_live_binding_and_explicit_fd_cleanup_not_context_manager(self):
        parent, actual, image = self.fixture()
        parent["kernelImageSha256"] = p.B.INSTALLED_HUB_PIN[1]
        request = types.SimpleNamespace(pid=42, start="100", sha256=p.B.INSTALLED_HUB_PIN[1], executable=parent["executable"])
        helper, binding = p.B.load_helper(), types.SimpleNamespace(close=mock.Mock())
        with mock.patch.object(p.os, "getuid", return_value=parent["uids"][0], create=True), \
                mock.patch.object(p.B, "native_process", return_value=parent), \
                mock.patch.object(p.B, "process_uids", return_value=parent["uids"]), \
                mock.patch.object(p.B, "save_json") as save, \
                mock.patch.object(p, "direct_backend", return_value=(actual, image)), \
                mock.patch.object(p, "dialog_window", return_value=77), \
                mock.patch.object(helper, "identity"), \
                mock.patch.object(helper, "KernelBinding", return_value=binding) as bind, \
                mock.patch.object(helper, "perform", return_value={"actionCount": 1}) as perform:
            result = p.consent(Path("/fixture"), "setup-decline", request, helper, object(), object(), parent)
        self.assertEqual(result["choice"], "decline")
        self.assertEqual([c.args[0].action for c in perform.call_args_list], ["snapshot", "click"])
        self.assertEqual(perform.call_args_list[1].args[0].button, "Not now")
        bind.assert_called_once()
        binding.close.assert_called_once()
        save.assert_called_once()

    def test_deadline_retains_read_only_observation_without_input_or_timing_change(self):
        parent, _actual, _image = self.fixture()
        request = types.SimpleNamespace(pid=42)
        helper = types.SimpleNamespace(perform=mock.Mock())
        with mock.patch.object(p.time, "monotonic", side_effect=[0, 21]), \
                mock.patch.object(p, "owned_windows", return_value=[]), \
                mock.patch.object(p.B, "save_json") as save, self.assertRaisesRegex(RuntimeError, "readiness deadline"):
            p.consent(Path("/fixture"), "setup-decline", request, helper, object(), object(), parent)
        helper.perform.assert_not_called()
        self.assertFalse(save.call_args.args[1]["authorization"])
        self.assertTrue(save.call_args.args[1]["readOnly"])

    def test_backend_absence_is_not_fabricated_exit_zero_and_pid_reuse_refuses(self):
        helper = types.SimpleNamespace(Proc=lambda: types.SimpleNamespace(exists=lambda _: False))
        self.assertTrue(p.backend_gone({"pid": 42, "startTime": "100"}, helper))
        helper.Proc = lambda: types.SimpleNamespace(exists=lambda _: True, stat=lambda _: "fixture")
        helper.parse_start = lambda *_args, **_kwargs: "999"
        with self.assertRaisesRegex(RuntimeError, "reused"):
            p.backend_gone({"pid": 42, "startTime": "100"}, helper)


class FixtureTests(unittest.TestCase):
    def test_empty_ax_name_uses_only_bounded_native_read_only_text(self):
        interface = types.SimpleNamespace(get_character_count=mock.Mock(return_value=len(p.RECIPE)),
                                          get_text=mock.Mock(return_value=p.RECIPE))
        node = types.SimpleNamespace(get_role=lambda: 72, get_state_set=lambda: types.SimpleNamespace(contains=lambda _: True),
                                     get_text_iface=lambda: interface)
        atspi = types.SimpleNamespace(Role=types.SimpleNamespace(PARAGRAPH=72), StateType=types.SimpleNamespace(SHOWING=1))
        self.assertEqual(p.node_text(node, atspi), p.RECIPE)
        interface.get_text.assert_called_once_with(0, len(p.RECIPE))
        snap = {"nodes": [{"name": "", "text": p.RECIPE, "showing": True}]}
        self.assertIn(p.RECIPE, p.shown_names(snap))
        interface.get_character_count = mock.Mock(return_value=2049)
        interface.get_text.reset_mock()
        with self.assertRaisesRegex(RuntimeError, "character bound"):
            p.node_text(node, atspi)
        interface.get_text.assert_not_called()
        interface.get_character_count = mock.Mock(side_effect=[len(p.RECIPE), 1])
        with self.assertRaisesRegex(RuntimeError, "changed"):
            p.node_text(node, atspi)

    @unittest.skipIf(os.name == "nt", "Native private modes/inodes are Linux contracts")
    def test_only_native_guide_preference_change_allowed_and_fixtures_retained(self):
        with tempfile.TemporaryDirectory(prefix="component-pure-") as folder:
            root = Path(folder).resolve()
            for name in ("home/config", "home/data"):
                (root / name).mkdir(parents=True)
            before = p.fixture(root)
            p.fixture_check(root, before)
            path = root / "home/config/creator-works-mcp/launcher-config.json"
            value = dict(before["config"], connection_guide_version=1)
            # Pure fixture mutation stands in for returned real product bytes,
            # never for native acceptance (the runner performs the real input).
            path.write_text(json.dumps(value))
            self.assertEqual(p.fixture_check(root, before, saved=True)["connectionGuideVersion"], 1)
            value["auto_start"] = True
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError, "beyond exact"):
                p.fixture_check(root, before, saved=True)

    def test_ready_requires_real_requirements_recipe_and_platform_not_just_version(self):
        def snap(names):
            return {"nodes": [{"name": name, "showing": True} for name in names]}
        self.assertFalse(p.ready_snapshot(snap(["Setup 0.3.7"]), "setup-ready"))
        self.assertTrue(p.ready_snapshot(snap(["Setup 0.3.7", p.RECIPE, "linux", "Unity Hub or Unity CLI"]), "setup-ready"))
        self.assertFalse(p.ready_snapshot(snap(["MCP 2.7.7"]), "mcp-ready"))
        self.assertTrue(p.ready_snapshot(snap(["MCP 2.7.7", "Connect your AI to Unity", "Use existing controls"]), "mcp-ready"))


if __name__ == "__main__":
    unittest.main()
