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
    def test_mcp_is_checked_first_without_omitting_setup_or_allowing_caller_order(self):
        self.assertEqual(p.COMPONENT_ORDER, ("mcp", "setup"))
        self.assertEqual(set(p.COMPONENT_ORDER), set(p.APPS))
        source = (HERE / "native-linux-components-probe.py").read_text()
        self.assertIn("for app in COMPONENT_ORDER:", source)
        self.assertNotIn('getenv("COMPONENT_ORDER"', source)

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
        self.assertIn("helper.Request.sealed(args, parsed, gtk_message_info_frame=frame)", source)
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

    def test_reviewed_gtk3_export_binds_new_backend_hash_and_current_helper_without_native_access(self):
        subject = load("components_gtk3_reviewed_candidate", HERE / "native-linux-components-probe.py")
        value = subject.configure_component_candidate(subject.B.GTK3_CANDIDATE)
        self.assertEqual(value["SOURCE"], "4f3744d5707ed5cd26c2e5a1b10a7d45a5e8d10b")
        self.assertEqual(value["helperSha256"], hashlib.sha256((HERE / "native-linux-root-probe.py").read_bytes()).hexdigest())
        self.assertEqual(subject.APPS["setup"]["hash"], "c960edfdd2f86d1ef994ef639b0d3e1b35041acb78935bf5d61dd7f69f32978c")
        self.assertEqual(subject.APPS["setup"]["size"], 16554072)
        self.assertEqual(subject.APPS["mcp"]["hash"], p.APPS["mcp"]["hash"])
        source = (HERE / "native-linux-components-probe.py").read_text()
        self.assertIn("excludes router fix b154e36", source)

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

    def test_parent_refusal_captures_original_owned_edges_without_text_or_action(self):
        f, owner = self.fixture()
        external = fixtures.AxNode(43, 20)
        f.button.parent = external
        with self.assertRaises(p.TreeRefusal) as caught:
            p.press("view-setup", owner, f.atspi)
        observation = caught.exception.observation
        self.assertFalse(observation["authorization"])
        self.assertEqual(observation["actionCount"], 0)
        self.assertEqual(observation["missingCount"], 1)
        row = observation["missing"][0]
        self.assertEqual(row["node"], owner.references.identity(f.button, owner))
        self.assertEqual(row["parent"], owner.references.identity(external, owner))
        self.assertEqual(row["getChildrenParent"], owner.references.identity(f.web, owner))
        self.assertNotIn(row["parent"], observation["collectedReferences"])
        self.assertNotIn("name", row)
        self.assertNotIn("text", row)
        f.button.action.do_action.assert_not_called()

    def test_parent_capture_is_bounded_and_foreign_parent_still_refuses_without_capture(self):
        f, owner = self.fixture()
        external = fixtures.AxNode(43, 20)
        for _ in range(40):
            node = fixtures.AxNode(43, 29, parent=f.web)
            node.parent = external
        with self.assertRaises(p.TreeRefusal) as caught:
            p.own_tree(f.window, owner, f.atspi)
        observation = caught.exception.observation
        self.assertEqual(observation["missingCount"], 40)
        self.assertEqual(len(observation["missing"]), 8)
        self.assertEqual(len(observation["collectedReferences"]), 32)
        self.assertTrue(observation["missingTruncated"])
        self.assertTrue(observation["referencesTruncated"])
        self.assertLessEqual(len(json.dumps(observation).encode("utf8")), 32768)
        f, owner = self.fixture()
        f.button.parent = fixtures.AxNode(99, 20)
        with self.assertRaises((RuntimeError, KeyError)) as caught:
            p.press("view-setup", owner, f.atspi)
        self.assertNotIsInstance(caught.exception, p.TreeRefusal)
        f.button.action.do_action.assert_not_called()

    def test_capture_save_failure_does_not_replace_original_tree_refusal(self):
        error = p.TreeRefusal({"authorization": False, "actionCount": 0})
        with mock.patch.object(p.B, "save_json", side_effect=OSError("private path detail")), \
                mock.patch.object(p.sys, "stderr") as stderr:
            p.retain_tree_refusal(Path("/fixture"), "setup-ready", error)
        self.assertEqual(str(error), "Component AX parent escaped bound subtree")
        self.assertIn("OSError", str(stderr.write.call_args_list))
        self.assertNotIn("private path detail", str(stderr.write.call_args_list))

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
    def task_listing(self, *tids):
        listing = mock.MagicMock()
        listing.__enter__.return_value = [types.SimpleNamespace(name=str(tid), is_dir=lambda **_: True) for tid in tids]
        return listing

    def test_worker_thread_child_is_not_lost_when_leader_has_no_child(self):
        files = {"/proc/42/task/42/children": b"", "/proc/42/task/45/children": b"43 "}
        def opener(path, _mode):
            return io.BytesIO(files[path])
        with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42, 45)):
            self.assertEqual(p.proc_children(42, opener), [43])

    def test_procfs_children_is_bounded_without_an_ordinary_file_size_assumption(self):
        opener = mock.Mock(return_value=io.BytesIO(b"43 44 "))
        with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42)):
            self.assertEqual(p.proc_children(42, opener), [43, 44])
        opener.assert_called_once_with("/proc/42/task/42/children", "rb")
        with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42)):
            self.assertEqual(p.proc_children(42, lambda *_: io.BytesIO(b"")), [])
        for body in (b"1 ", b"42 ", b"43 43 ", b"0", b"01", b"43\x00", b"9 "*33, b"9"*4097):
            with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42)), \
                    self.subTest(body=body[:20]), self.assertRaises(RuntimeError):
                p.proc_children(42, lambda *_: io.BytesIO(body))

    def test_task_inventory_and_aggregate_child_bounds_and_vanished_worker(self):
        for tids in ((45,), (42, 42), (42, "bad"), (42, 0), tuple(range(42, 299))):
            with mock.patch.object(p.os, "scandir", return_value=self.task_listing(*tids)), \
                    self.subTest(tids=tids[:3]), self.assertRaises(RuntimeError):
                p.proc_children(42, lambda *_: io.BytesIO(b""))
        linked = self.task_listing(42)
        linked.__enter__.return_value[0].is_dir = mock.Mock(return_value=False)
        with mock.patch.object(p.os, "scandir", return_value=linked), self.assertRaises(RuntimeError):
            p.proc_children(42, lambda *_: io.BytesIO(b""))
        linked.__enter__.return_value[0].is_dir.assert_called_once_with(follow_symlinks=False)
        def gone(path, _mode):
            if path == "/proc/42/task/45/children":
                raise FileNotFoundError("Exited worker fixture")
            return io.BytesIO(b"43 ")
        with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42, 45)):
            self.assertEqual(p.proc_children(42, gone), [43])
        with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42)), \
                self.assertRaisesRegex(RuntimeError, "leader disappeared"):
            p.proc_children(42, mock.Mock(side_effect=FileNotFoundError("Exited Root fixture")))
        def many(path, _mode):
            children = range(100, 132) if path == "/proc/42/task/42/children" else range(132, 164)
            return io.BytesIO((" ".join(map(str, children)) + " ").encode())
        with mock.patch.object(p.os, "scandir", return_value=self.task_listing(42, 45)), self.assertRaisesRegex(RuntimeError, "aggregate"):
            p.proc_children(42, many)

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
                mock.patch.object(helper, "bound_window", return_value={"pid": 43, "client": 3}), \
                mock.patch.object(helper, "KernelBinding", return_value=binding) as bind, \
                mock.patch.object(helper, "perform", return_value={"actionCount": 1}) as perform:
            result = p.consent(Path("/fixture"), "setup-decline", request, helper, object(), object(), parent)
        self.assertEqual(result["choice"], "decline")
        self.assertEqual([c.args[0].action for c in perform.call_args_list], ["snapshot", "click"])
        self.assertEqual(perform.call_args_list[1].args[0].button, "Not now")
        bind.assert_called_once()
        binding.close.assert_called_once()
        self.assertEqual(save.call_count, 2)
        self.assertFalse(save.call_args_list[0].args[1]["authorization"])
        self.assertEqual(save.call_args.args[0].name, "setup-decline-backend.json")

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

    def test_strict_snapshot_refusal_retains_backend_window_and_ax_without_input(self):
        parent, actual, image = self.fixture()
        parent["kernelImageSha256"] = p.B.INSTALLED_HUB_PIN[1]
        request = types.SimpleNamespace(pid=42, start="100", sha256=p.B.INSTALLED_HUB_PIN[1], executable=parent["executable"])
        helper, binding = p.B.load_helper(), types.SimpleNamespace(close=mock.Mock())
        xres = {"pid": 43, "client": 3, "title": p.APPS["setup"]["title"], "mapped": True}
        def fail_snapshot(*_args):
            self.assertEqual(save.call_count, 1, "Native identity must survive even if AX read blocks/refuses")
            raise RuntimeError("Exact owned accessibility window is missing or ambiguous")
        with mock.patch.object(p.os, "getuid", return_value=parent["uids"][0], create=True), \
                mock.patch.object(p.B, "native_process", return_value=parent), \
                mock.patch.object(p.B, "process_uids", return_value=parent["uids"]), \
                mock.patch.object(p.B, "save_json") as save, \
                mock.patch.object(p, "direct_backend", return_value=(actual, image)), \
                mock.patch.object(p, "dialog_window", return_value=77), \
                mock.patch.object(helper, "identity"), \
                mock.patch.object(helper, "bound_window", return_value=xres), \
                mock.patch.object(helper, "KernelBinding", return_value=binding), \
                mock.patch.object(p, "backend_ax_observation", create=True, return_value={"verified": True}) as observation, \
                mock.patch.object(helper, "perform", side_effect=fail_snapshot) as perform, \
                self.assertRaisesRegex(RuntimeError, "Exact owned accessibility window is missing or ambiguous"):
            p.consent(Path("/fixture"), "setup-decline", request, helper, object(), object(), parent)
        self.assertEqual(perform.call_count, 1)
        self.assertEqual(perform.call_args.args[0].action, "snapshot")
        self.assertEqual(perform.call_args.args[0].role, "DIALOG")
        self.assertEqual(save.call_count, 2)
        before, failure = [call.args[1] for call in save.call_args_list]
        self.assertEqual(before["native"], actual)
        self.assertEqual(before["kernelImage"], image)
        self.assertEqual(before["xres"], {"window": 77, **xres})
        self.assertFalse(before["authorization"])
        self.assertEqual(failure["ax"], {"verified": True})
        self.assertIn("accessibility window", failure["strictSnapshotError"])
        observation.assert_called_once()
        binding.close.assert_called_once()

    def test_capture_only_stops_without_input_even_when_strict_snapshot_passes(self):
        parent, actual, image = self.fixture()
        request = types.SimpleNamespace(pid=42, start="100", sha256=p.B.INSTALLED_HUB_PIN[1], executable=parent["executable"])
        helper, binding = p.B.load_helper(), types.SimpleNamespace(close=mock.Mock())
        with mock.patch.object(p.os, "getuid", return_value=parent["uids"][0], create=True), \
                mock.patch.object(p.B, "native_process", return_value=parent), \
                mock.patch.object(p.B, "process_uids", return_value=parent["uids"]), \
                mock.patch.object(p.B, "save_json") as save, \
                mock.patch.object(p, "direct_backend", return_value=(actual, image)), \
                mock.patch.object(p, "dialog_window", return_value=77), \
                mock.patch.object(helper, "identity"), \
                mock.patch.object(helper, "bound_window", return_value={"pid": 43, "client": 3}), \
                mock.patch.object(helper, "KernelBinding", return_value=binding), \
                mock.patch.object(p, "backend_ax_observation", return_value={"verified": True}), \
                mock.patch.object(helper, "perform", return_value={"actionCount": 0}) as perform, \
                self.assertRaisesRegex(RuntimeError, "Capture-only stop before component consent input"):
            p.consent(Path("/fixture"), "setup-capture", request, helper, object(), object(), parent)
        self.assertEqual(perform.call_count, 1)
        self.assertEqual(perform.call_args.args[0].action, "snapshot")
        self.assertEqual(save.call_count, 2)
        self.assertEqual(save.call_args.args[0].name, "setup-capture-backend-ax.json")
        self.assertFalse(save.call_args.args[1]["authorization"])
        binding.close.assert_called_once()

    def test_capture_only_cli_has_no_fallthrough_to_component_flow(self):
        subject = load("components_capture_only", HERE / "native-linux-components-probe.py")
        with mock.patch.object(subject, "admission"), mock.patch.dict(os.environ, {"RUNNER_TEMP": "/fixture"}, clear=True), \
                mock.patch.object(subject.B, "ordinary", return_value=Path("/fixture")), \
                mock.patch.object(subject.sys, "argv", ["probe", "capture-only"]), \
                mock.patch.object(subject, "probe", return_value={"phase": "capture"}) as probe, \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            subject.main()
        self.assertTrue(probe.call_args.kwargs["capture_only"])
        source = (HERE / "native-linux-components-probe.py").read_text().split("def probe(", 1)[1].split("def main(", 1)[0]
        capture = source.split("if capture_only:", 1)[1].split('for app in COMPONENT_ORDER:', 1)[0]
        self.assertIn('"setup-capture"', capture)
        self.assertIn("raise RuntimeError", capture)

    def diagnostic_fixture(self):
        parent, actual, _image = self.fixture()
        helper = p.B.load_helper()
        request = types.SimpleNamespace(action="snapshot", receipt=object(), pid=43, window=77,
                                        title=p.APPS["setup"]["title"], role="DIALOG")
        desktop = fixtures.AxNode(0, 14)
        app = fixtures.AxNode(43, 75, parent=desktop)
        window = fixtures.AxNode(43, 2, "Information", parent=app)
        label = fixtures.AxNode(43, 29, p.APPS["setup"]["title"], parent=window)
        button = fixtures.AxNode(43, 43, "Not now", parent=window, verb="click")
        for node in (desktop, app, window, label, button):
            node.get_child_count = lambda node=node: len(node.children)
            node.get_child_at_index = lambda index, node=node: node.children[index]
        atspi = types.SimpleNamespace(get_desktop=lambda _: desktop,
                                     StateType=types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5))
        return parent, actual, helper, request, desktop, app, window, button, atspi

    def test_read_only_ax_diagnostic_records_alert_and_different_name_not_input_authority(self):
        parent, actual, helper, request, _desktop, _app, _window, button, atspi = self.diagnostic_fixture()
        with mock.patch.object(helper, "identity") as identity, \
                mock.patch.object(helper, "bound_window", return_value={"pid": 43, "client": 3}), \
                mock.patch.object(p.B, "native_process", side_effect=[parent, actual, parent, actual]), \
                mock.patch.object(helper, "perform") as perform:
            result = p.backend_ax_observation(request, helper, object(), atspi, object(), parent, actual)
        self.assertTrue(result["verified"])
        self.assertTrue(result["readOnly"])
        self.assertFalse(result["authorization"])
        self.assertFalse(result["axToXidAssociationVerified"])
        self.assertEqual(result["windows"][0]["role"], 2)
        self.assertEqual(result["windows"][0]["name"], "Information")
        self.assertIn("Not now", [node["name"] for node in result["nodes"]])
        self.assertEqual(request.role, "DIALOG")
        self.assertEqual(identity.call_count, 2)
        perform.assert_not_called()
        button.action.do_action.assert_not_called()
        source = (HERE / "native-linux-components-probe.py").read_text().split("def backend_ax_observation(", 1)[1].split("def routing_permission(", 1)[0]
        for forbidden in (".perform(", "Request.sealed", "do_action(", "get_action_iface", "time.sleep"):
            self.assertNotIn(forbidden, source)

    def test_ax_registration_absence_and_ambiguity_are_retained_without_guessing_role(self):
        for count in (0, 2):
            parent, actual, helper, request, desktop, app, _window, button, atspi = self.diagnostic_fixture()
            desktop.children = [app]*count
            with mock.patch.object(helper, "identity"), \
                    mock.patch.object(helper, "bound_window", return_value={"pid": 43, "client": 3}), \
                    mock.patch.object(p.B, "native_process", side_effect=[parent, actual, parent, actual]):
                result = p.backend_ax_observation(request, helper, object(), atspi, object(), parent, actual)
            self.assertEqual(result["applicationCount"], count)
            self.assertEqual(result["nodes"], [])
            self.assertEqual(result["verified"], count == 0)
            self.assertFalse(result["authorization"])
            button.action.do_action.assert_not_called()

    def test_ax_diagnostic_foreign_nodes_drift_and_size_bounds_refuse_not_authorize(self):
        for change in ("foreign", "uid", "start", "image", "ppid", "window", "size"):
            parent, actual, helper, request, _desktop, _app, window, button, atspi = self.diagnostic_fixture()
            changed = copy.deepcopy(actual)
            xres = {"pid": 43, "client": 3}
            if change == "foreign":
                button.pid = 99
                button.get_name = mock.Mock(side_effect=AssertionError("Foreign name must not be read"))
            elif change in ("uid", "start", "image", "ppid"):
                field, value = {"uid": ("uids", [9999]*4), "start": ("startTime", "999"),
                                "image": ("kernelImageSha256", "f"*64), "ppid": ("parentPid", 99)}[change]
                changed[field] = value
            elif change == "size":
                window.children = [button]*(helper.MAX_CHILDREN+1)
            with mock.patch.object(helper, "identity"), \
                    mock.patch.object(helper, "bound_window", side_effect=[xres, {**xres, "client": 9}] if change == "window" else [xres, xres]), \
                    mock.patch.object(p.B, "native_process", side_effect=[parent, actual, parent, changed]):
                result = p.backend_ax_observation(request, helper, object(), atspi, object(), parent, actual)
            self.assertFalse(result["verified"], change)
            self.assertIn("captureRefusal", result, change)
            self.assertFalse(result["authorization"])
            button.action.do_action.assert_not_called()
            if change == "foreign":
                button.get_name.assert_not_called()

    def test_backend_absence_is_not_fabricated_exit_zero_and_pid_reuse_refuses(self):
        helper = types.SimpleNamespace(Proc=lambda: types.SimpleNamespace(exists=lambda _: False))
        self.assertTrue(p.backend_gone({"pid": 42, "startTime": "100"}, helper))
        helper.Proc = lambda: types.SimpleNamespace(exists=lambda _: True, stat=lambda _: "fixture")
        helper.parse_start = lambda *_args, **_kwargs: "999"
        with self.assertRaisesRegex(RuntimeError, "reused"):
            p.backend_gone({"pid": 42, "startTime": "100"}, helper)


class SetupGtkContractTests(unittest.TestCase):
    def fixture(self):
        subject = load("captured_setup_gtk_contract", HERE / "native-linux-components-probe.py")
        subject.configure_component_candidate(subject.B.GTK3_CANDIDATE)
        parent, actual, image = NativeReceiptTests().fixture()
        parent["kernelImageSha256"] = subject.B.INSTALLED_HUB_PIN[1]
        actual["kernelImageSha256"] = image["sha256"] = subject.APPS["setup"]["hash"]
        image["size"] = subject.APPS["setup"]["size"]
        helper = subject.B.load_helper()
        with mock.patch.object(subject.os, "getuid", return_value=parent["uids"][0], create=True):
            value = subject.receipt(parent, actual, image, "setup")
        pins = ["42", "100", subject.B.INSTALLED_HUB_PIN[1], subject.APPS["setup"]["hash"], subject.B.SOURCE, str(subject.B.RUN)]
        parsed = helper.Receipt.parse(value, pins)
        binding = types.SimpleNamespace(receipt=parsed, verify=mock.Mock(), parent_and_image=mock.Mock(),
                                        check_child=mock.Mock(), close=mock.Mock(), last_image=image)
        records = {42: copy.deepcopy(parent), 43: copy.deepcopy(actual)}
        proc = types.SimpleNamespace(exists=lambda pid: pid in records,
            stat=lambda pid: f"{pid} (fixture) S {40 if pid == 42 else 42} " + "0 "*17 + records[pid]["startTime"],
            executable=lambda pid: records[pid]["executable"], digest=lambda pid: records[pid]["kernelImageSha256"])
        desktop = fixtures.AxNode(0, 14)
        app = fixtures.AxNode(43, 75, parent=desktop)
        window = fixtures.AxNode(43, 2, "Information", parent=app)
        window.get_component_iface = lambda: types.SimpleNamespace(get_extents=lambda _: types.SimpleNamespace(x=10, y=20, width=600, height=240))
        heading = fixtures.AxNode(43, 29, subject.APPS["setup"]["title"], parent=window)
        body = fixtures.AxNode(43, 29, "Run Project Setup inside this Creator Hub window?\n\n" + parent["executable"]
            + "\n\nThis preview uses your existing Setup operations. It does not install an app or change shortcuts. Only continue if you just chose Project Setup in Hub.", parent=window)
        approve = fixtures.AxNode(43, 43, "Open in Hub", parent=window, verb="click")
        decline = fixtures.AxNode(43, 43, "Not now", parent=window, verb="click")
        for node in (desktop, app, window, heading, body, approve, decline):
            node.get_child_count = lambda node=node: len(node.children)
            node.get_child_at_index = lambda index, node=node: node.children[index]
        atspi = types.SimpleNamespace(get_desktop=lambda _: desktop,
            Role=types.SimpleNamespace(ALERT=2, DIALOG=16, LABEL=29, PUSH_BUTTON=43),
            StateType=types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5),
            CoordType=types.SimpleNamespace(SCREEN=0))
        info = {"pid": 43, "client": 3, "title": subject.APPS["setup"]["title"], "mapped": True}
        x11 = types.SimpleNamespace(inspect=lambda _: dict(info), frame_rectangle=lambda _: (10, 20, 600, 240))
        request = helper.Request("snapshot", 42, "100", parent["executable"], parent["kernelImageSha256"], 1, subject.B.TITLE, "FRAME")
        return types.SimpleNamespace(p=subject, parent=parent, actual=actual, image=image, helper=helper, binding=binding,
            parsed=parsed, proc=proc, records=records, window=window, heading=heading, body=body, approve=approve,
            decline=decline, atspi=atspi, x11=x11, request=request, info=info)

    def test_captured_alert_information_with_title_label_passes_snapshot_without_consent(self):
        f = self.fixture()
        with mock.patch.object(f.p.os, "getuid", return_value=f.parent["uids"][0], create=True), \
                mock.patch.object(f.p.B, "native_process", side_effect=lambda pid, *_args: copy.deepcopy(f.records[pid])), \
                mock.patch.object(f.p.B, "process_uids", return_value=f.parent["uids"]), \
                mock.patch.object(f.p.B, "save_json") as save, \
                mock.patch.object(f.p, "direct_backend", return_value=(f.actual, f.image)), \
                mock.patch.object(f.p, "dialog_window", return_value=77), \
                mock.patch.object(f.helper, "Proc", return_value=f.proc), \
                mock.patch.object(f.helper, "KernelBinding", return_value=f.binding), \
                self.assertRaisesRegex(RuntimeError, "Capture-only stop before component consent input"):
            f.p.consent(Path("/fixture"), "setup-capture", f.request, f.helper, f.x11, f.atspi, f.parent)
        snapshot = save.call_args.args[1]["strictSnapshot"]
        self.assertEqual(snapshot["role"], "ALERT")
        self.assertEqual(snapshot["axName"], "Information")
        self.assertEqual(snapshot["title"], "Open Setup in Creator Hub?")
        self.assertEqual(snapshot["actionCount"], 0)
        f.approve.action.do_action.assert_not_called()
        f.decline.action.do_action.assert_not_called()

    def test_root_routing_requires_snapshot_before_exact_native_approval(self):
        f = self.fixture()
        def perform(req, *_args):
            self.assertEqual(save.call_count, 1 if req.action == "snapshot" else 2)
            self.assertEqual(req.role, "ALERT")
            self.assertEqual(req.accessibility_name, "Information")
            self.assertEqual(req.title, "Enable managed MCP routing")
            self.assertEqual(req.gtk_message_info_frame, (10, 20, 600, 240))
            return {"actionCount": 0 if req.action == "snapshot" else 1}
        with mock.patch.object(f.p.B, "native_process", return_value=f.parent), \
                mock.patch.object(f.p.B, "save_json") as save, \
                mock.patch.object(f.helper, "bound_window", return_value={"pid": 42, "client": 3}), \
                mock.patch.object(f.helper, "perform", side_effect=perform) as effect:
            result = f.p.routing_permission(Path("/fixture"), f.request, f.helper, f.x11, f.atspi, f.parent, 99)
        self.assertEqual([c.args[0].action for c in effect.call_args_list], ["snapshot", "click"])
        self.assertEqual(effect.call_args.args[0].button, "Enable managed routing")
        self.assertIsNone(effect.call_args.args[0].receipt)
        self.assertEqual(result["input"]["actionCount"], 1)

    def test_root_routing_snapshot_refusal_retains_owner_and_ax_without_input(self):
        f = self.fixture()
        with mock.patch.object(f.p.B, "save_json") as save, \
                mock.patch.object(f.helper, "bound_window", return_value={"pid": 42, "client": 3}), \
                mock.patch.object(f.p, "backend_ax_observation", return_value={"verified": False}) as observation, \
                mock.patch.object(f.helper, "perform", side_effect=RuntimeError("Strict native AX refusal")) as effect, \
                self.assertRaisesRegex(RuntimeError, "Strict native AX refusal"):
            f.p.routing_permission(Path("/fixture"), f.request, f.helper, f.x11, f.atspi, f.parent, 99)
        self.assertEqual(effect.call_count, 1)
        self.assertEqual(effect.call_args.args[0].action, "snapshot")
        self.assertEqual(save.call_count, 2)
        self.assertEqual(save.call_args.args[0].name, "managed-routing-ax-refusal.json")
        self.assertFalse(save.call_args.args[1]["authorization"])
        observation.assert_called_once()


class TextObservationTests(unittest.TestCase):
    def fixture(self):
        role = types.SimpleNamespace(PARAGRAPH=73, TEXT=61, STATIC=117, LABEL=29, SECTION=85, HEADING=83)
        state = types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, BUSY=4, DEFUNCT=5, EDITABLE=6)
        atspi = types.SimpleNamespace(Role=role, StateType=state)

        def node(key, text=None, children=(), node_role=73):
            interface = None if text is None else types.SimpleNamespace(
                get_character_count=mock.Mock(return_value=len(text)), get_text=mock.Mock(return_value=text))
            value = types.SimpleNamespace(key=key, pid=43, children=list(children), text=interface,
                get_role=lambda: node_role, get_role_name=lambda: "paragraph", get_name=lambda: "",
                get_process_id=lambda: value.pid,
                get_state_set=lambda: types.SimpleNamespace(contains=lambda s: s in (1, 2, 3)),
                get_interfaces=mock.Mock(return_value=["Accessible"] + (["Text"] if text is not None else [])),
                get_attributes=mock.Mock(return_value={"tag": "p"}), get_text_iface=mock.Mock(return_value=interface),
                get_hypertext_iface=mock.Mock(return_value=None), get_child_count=mock.Mock(side_effect=lambda: len(value.children)),
                get_child_at_index=mock.Mock(side_effect=lambda i: value.children[i]), get_action_iface=mock.Mock())
            return value

        def owned(value):
            p.require(value.pid == 43, "Foreign fixture node")

        owner = types.SimpleNamespace(node=mock.Mock(side_effect=owned), recheck=mock.Mock(),
            evidence=lambda: {"fixture": True}, references=types.SimpleNamespace(
                identity=lambda n, _owner: [":1.43", n.key]))
        return atspi, owner, node

    def test_unavailable_empty_and_nonempty_text_remain_distinct_not_authority(self):
        atspi, owner, node = self.fixture()
        nodes = [node("absent"), node("empty", ""), node("present", "Exact visible state")]
        result = p.text_interface_observation(nodes, owner, atspi)
        self.assertTrue(result["verified"])
        self.assertFalse(result["authorization"])
        self.assertEqual(result["actionCount"], 0)
        self.assertEqual(result["nodes"][0]["text"], {"available": False})
        self.assertEqual(result["nodes"][1]["text"]["characterCount"], 0)
        self.assertEqual(result["nodes"][1]["text"]["value"], "")
        self.assertEqual(result["nodes"][2]["text"]["value"], "Exact visible state")
        self.assertTrue(result["nodes"][2]["text"]["stable"])
        for value in nodes:
            value.get_action_iface.assert_not_called()
        owner.recheck.assert_any_call(full=True)

    def test_child_text_on_section_is_recorded_but_never_used_as_decline_authority(self):
        atspi, owner, node = self.fixture()
        child = node("inline", "Opening Setup in Hub was declined.", node_role=85)
        parent = node("paragraph", "", [child])
        parent.get_hypertext_iface.return_value = types.SimpleNamespace(get_n_links=lambda: 1)
        result = p.text_interface_observation([parent, child], owner, atspi)
        self.assertTrue(result["verified"])
        self.assertEqual(result["nodes"][0]["children"], {"count": 1, "indices": [1]})
        self.assertEqual(result["nodes"][0]["hypertext"], {"available": True, "linkCount": 1})
        self.assertEqual(result["nodes"][1]["text"]["value"], "Opening Setup in Hub was declined.")
        self.assertFalse(result["nodes"][1]["readinessTextRole"])
        snapshot = {"nodes": [{"name": "Retry opening", "text": "", "showing": True}],
                    "textInterfaceObservation": result}
        self.assertFalse(p.ready_snapshot(snapshot, "setup-declined"))
        snapshot["nodes"].append({"name": "Could not open Project Setup", "showing": True})
        self.assertFalse(p.ready_snapshot(snapshot, "setup-declined"))

    def test_probe_error_is_explicit_not_empty_text_and_other_probes_survive(self):
        atspi, owner, node = self.fixture()
        value = node("error", "known")
        value.get_text_iface.side_effect = RuntimeError("Do not echo arbitrary remote diagnostic content")
        result = p.text_interface_observation([value], owner, atspi)
        self.assertEqual(result["nodes"][0]["text"], {"errorType": "RuntimeError"})
        self.assertEqual(result["nodes"][0]["attributes"]["values"], {"tag": "p"})
        self.assertNotIn("Do not echo", json.dumps(result))

    def test_foreign_or_out_of_tree_child_refused_before_child_content_read(self):
        for foreign in (False, True):
            atspi, owner, node = self.fixture()
            child = node("escaped", "not owned")
            if foreign:
                child.pid = 999
            parent = node("parent", "", [child])
            result = p.text_interface_observation([parent], owner, atspi)
            self.assertIn("errorType", result["nodes"][0]["children"])
            child.get_text_iface.assert_not_called()
            child.get_attributes.assert_not_called()
            self.assertFalse(result["authorization"])

    def test_counts_output_bounds_and_drift_are_recorded_without_unbounded_reads(self):
        for kind in ("text", "attributes", "interfaces", "hypertext", "children", "text-drift"):
            atspi, owner, node = self.fixture()
            value = node("bounded", "small")
            if kind == "text":
                value.text.get_character_count.return_value = 2049
            elif kind == "attributes":
                value.get_attributes.return_value = {"oversized": "x" * 2049}
            elif kind == "interfaces":
                value.get_interfaces.return_value = ["Text"] * 33
            elif kind == "hypertext":
                value.get_hypertext_iface.return_value = types.SimpleNamespace(get_n_links=lambda: -1)
            elif kind == "children":
                value.get_child_count.return_value = 129
                value.get_child_count.side_effect = None
            else:
                value.text.get_character_count.side_effect = [5, 4]
            result = p.text_interface_observation([value], owner, atspi)
            field = "text" if kind == "text-drift" else kind
            self.assertIn("errorType", result["nodes"][0][field], kind)
            if kind == "text":
                value.text.get_text.assert_not_called()
            self.assertFalse(result["authorization"])

    def test_budget_identity_and_node_bounds_refuse_not_authorize(self):
        atspi, owner, node = self.fixture()
        value = node("owned", "small")
        with mock.patch.object(p.time, "monotonic", side_effect=[0, 6]):
            result = p.text_interface_observation([value], owner, atspi)
        self.assertFalse(result["verified"])
        value.get_interfaces.assert_not_called()
        owner.recheck.side_effect = RuntimeError("changed")
        self.assertFalse(p.text_interface_observation([value], owner, atspi)["verified"])
        owner.recheck.side_effect = None
        self.assertFalse(p.text_interface_observation([value] * 65, owner, atspi)["verified"])

    def test_hidden_editable_and_unknown_roles_do_not_read_text_values(self):
        for role, states in ((73, (2, 3)), (73, (1, 2, 3, 6)), (999, (1, 2, 3))):
            atspi, owner, node = self.fixture()
            value = node("not-static-visible", "not for collection", node_role=role)
            value.get_state_set = lambda: types.SimpleNamespace(contains=lambda s: s in states)
            result = p.text_interface_observation([value], owner, atspi)
            self.assertTrue(result["verified"])
            self.assertTrue(result["nodes"][0]["text"]["available"])
            self.assertNotIn("value", result["nodes"][0]["text"])
            value.text.get_text.assert_not_called()

    def test_output_bound_retains_explicit_partial_diagnostic_not_success(self):
        atspi, owner, node = self.fixture()
        nodes = [node(str(i), "x" * 2048) for i in range(20)]
        result = p.text_interface_observation(nodes, owner, atspi)
        self.assertFalse(result["verified"])
        self.assertIn("captureRefusal", result)
        self.assertLess(len(result["nodes"]), len(nodes))
        self.assertLessEqual(len(json.dumps(result).encode("utf8")), 32768)

    def test_failure_only_capture_retains_original_snapshot_before_optional_diagnostics(self):
        source = (HERE / "native-linux-components-probe.py").read_text()
        branch = source.split('if action == "failure-snapshot":')[1].split('if action in ("setup-ready"')[0]
        self.assertLess(branch.index('"failure-ui-snapshot.json"'), branch.index("text_interface_observation("))
        self.assertIn('"failure-text-interfaces.json"', branch)
        diagnostic = source.split("def text_interface_observation(")[1].split("def fixed_control(")[0]
        for forbidden in ("get_action_iface", "do_action", "get_uri", "get_object", "EditableText", "ready_snapshot("):
            self.assertNotIn(forbidden, diagnostic)


class FixtureTests(unittest.TestCase):
    def test_captured_webkit_paragraph_differs_from_client_enum_but_reads_exact_decline(self):
        atspi, owner, make_node = TextObservationTests().fixture()
        node = make_node("builtin-detail", "Opening Setup in Hub was declined.", node_role=72)
        node.get_attributes.return_value = {"tag": "p", "computed-role": "paragraph", "toolkit": "WebKitGTK"}
        self.assertNotEqual(node.get_role(), atspi.Role.PARAGRAPH)
        text = p.node_text(node, atspi)
        self.assertEqual(text, "Opening Setup in Hub was declined.")
        node.text.get_text.assert_called_once_with(0, len(text))
        snapshot = {"nodes": [{"name": "", "text": text, "showing": True}]}
        self.assertTrue(p.ready_snapshot(snapshot, "setup-declined"))
        self.assertFalse(p.ready_snapshot(snapshot, "mcp-declined"))
        observation = p.text_interface_observation([node], owner, atspi)
        self.assertTrue(observation["verified"])
        self.assertTrue(observation["nodes"][0]["readinessTextRole"])
        self.assertEqual(observation["nodes"][0]["text"]["value"], text)
        self.assertFalse(observation["authorization"])
        node.get_action_iface.assert_not_called()

    def test_numeric_role_or_claimed_attributes_alone_never_enable_compatibility(self):
        for role, attributes, states in (
            (72, {"tag": "p"}, (1, 2, 3)),
            (72, {"tag": "p", "computed-role": "paragraph", "toolkit": "Other"}, (1, 2, 3)),
            (72, {"tag": "footer", "computed-role": "paragraph", "toolkit": "WebKitGTK"}, (1, 2, 3)),
            (999, {"tag": "p", "computed-role": "paragraph", "toolkit": "WebKitGTK"}, (1, 2, 3)),
            (72, {"tag": "p", "computed-role": "paragraph", "toolkit": "WebKitGTK"}, (2, 3)),
            (72, {"tag": "p", "computed-role": "paragraph", "toolkit": "WebKitGTK"}, (1, 2, 3, 6)),
        ):
            atspi, _, make_node = TextObservationTests().fixture()
            node = make_node("refused", "Opening Setup in Hub was declined.", node_role=role)
            node.get_attributes.return_value = attributes
            node.get_state_set = lambda: types.SimpleNamespace(contains=lambda state: state in states)
            self.assertEqual(p.node_text(node, atspi), "")
            node.text.get_text.assert_not_called()

    def test_empty_ax_name_uses_only_bounded_native_read_only_text(self):
        interface = types.SimpleNamespace(get_character_count=mock.Mock(return_value=len(p.RECIPE)),
                                          get_text=mock.Mock(return_value=p.RECIPE))
        node = types.SimpleNamespace(get_role=lambda: 73, get_state_set=lambda: types.SimpleNamespace(contains=lambda _: True),
                                     get_text_iface=lambda: interface)
        atspi = types.SimpleNamespace(Role=types.SimpleNamespace(PARAGRAPH=73), StateType=types.SimpleNamespace(SHOWING=1))
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
