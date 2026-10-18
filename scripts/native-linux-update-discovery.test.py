"""Pure/temp-only discovery contracts. No native app, install, trust or UI input."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORKFLOW = ROOT / ".github/workflows/native-linux-update-discovery-014.yml"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


p = load("linux_discovery_test_subject", HERE / "native-linux-update-discovery.py")
c = p.components()
b = c.B
fixtures = load("linux_discovery_root_fixtures", HERE / "native-linux-root-probe.test.py")


def runner():
    return fixtures.runner_fixture() | {"CREATOR_LINUX_UPDATE_DISCOVERY": "1", "CREATOR_LINUX_COMPONENTS_PROBE": "1",
        "CREATOR_LINUX_ROOT_CANDIDATE": b.CURRENT_CANDIDATE, "GITHUB_REF": p.BRANCH, "GITHUB_EVENT_NAME": "push",
        "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "12345", "RUNNER_TEMP": "/fixture"}


def target_binding():
    t = p.TARGET
    return {"run": {"id": t["run"], "run_attempt": t["attempt"], "head_sha": t["source"], "status": "completed",
        "conclusion": "success", "event": "push", "head_branch": "validation/linux-outer-update-fixture-014",
        "path": ".github/workflows/linux-outer-update-fixture-014.yml", "repository": {"id": b.REPOSITORY_ID}},
        "artifact": {"id": t["artifact"], "name": t["name"], "expired": False, "size_in_bytes": t["zipBytes"],
            "digest": "sha256:" + t["zipSha256"], "workflow_run": {"id": t["run"], "head_sha": t["source"],
            "repository_id": b.REPOSITORY_ID, "head_repository_id": b.REPOSITORY_ID}},
        "job": {"id": t["job"], "run_id": t["run"], "run_attempt": 1, "name": "target", "conclusion": "success"},
        "commit": {"sha": t["source"], "tree": {"sha": t["tree"]}},
        "draft": {"id": 411494394, "tag_name": "v0.1.13-validation", "draft": True},
        "assets": [{"id": a, "size": size, "digest": "sha256:" + sha, "name": name, "state": "uploaded"}
                   for a, size, sha, name in p.METADATA.values()]}


class AdmissionTests(unittest.TestCase):
    def test_only_exact_native_runner_current_candidate_push_or_dispatch(self):
        for event in ("push", "workflow_dispatch"):
            p.admission(runner() | {"GITHUB_EVENT_NAME": event}, "linux", "x86_64")
        for field in runner():
            if field in ("RUNNER_TEMP", "GITHUB_RUN_ID"):
                continue
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.admission({k: v for k, v in runner().items() if k != field}, "linux", "x86_64")

    def test_foreign_contexts_injection_or_unregistered_default_dispatch_refuse(self):
        for field, value in (("GITHUB_REF", "refs/heads/main"), ("GITHUB_REF", "refs/heads/validation/linux-current-components-014"),
                ("GITHUB_EVENT_NAME", "pull_request"), ("CREATOR_LINUX_ROOT_CANDIDATE", b.ORIGINAL_CANDIDATE),
                ("GITHUB_REPOSITORY_ID", "1"), ("FLATPAK_ID", "foreign"), ("APPIMAGE", "foreign"),
                ("LD_PRELOAD", "foreign"), ("NODE_TLS_REJECT_UNAUTHORIZED", "0"), ("SSL_CERT_FILE", "foreign"),
                ("TAURI_SIGNING_PRIVATE_KEY", "synthetic-only")):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.admission(runner() | {field: value}, "linux", "x86_64")
        for system, machine in (("win32", "x86_64"), ("linux", "aarch64")):
            with self.assertRaises(RuntimeError):
                p.admission(runner(), system, machine)

    def test_pins_are_complete_current_root_and_actual_frozen_target(self):
        pins = p.candidate_pins()
        self.assertEqual(pins["root"]["SOURCE"], "534465a86554e95b909bf9c7decbbb29cbca5267")
        self.assertEqual(pins["root"]["RUN"], 39042746816)
        self.assertEqual(pins["target"]["source"], "eef90658c4d9e6743c6c25f67e00ad36c783ca6e")
        self.assertEqual(pins["target"]["bytes"], 62212268)
        self.assertEqual(p.ASSET, "Creator_Hub_0.1.15_amd64-acceptance-only.deb")
        self.assertEqual(p.DESCRIPTOR, "creator-hub-linux-x86_64-deb.json")
        for name, digest in pins["testHelpers"].items():
            self.assertEqual(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), digest)
        self.assertTrue(all(v is False for v in p.FALSE_GATES.values()))

    def test_only_local_child_environment_gets_validated_https_proxy(self):
        base = runner() | {"HOME": "/live", "GITHUB_TOKEN": "synthetic", "HTTP_PROXY": "http://foreign",
                           "NO_PROXY": "*", "ALL_PROXY": "foreign", "SSL_CERT_FILE": "foreign", "NODE_OPTIONS": "foreign"}
        root = Path("/isolated")
        original = b.child_env(base, root)
        actual = p.child_environment(base, root, "http://127.0.0.1:37219")
        self.assertEqual(actual, original | {"HTTPS_PROXY": "http://127.0.0.1:37219"})
        self.assertEqual(actual["HOME"], str(root / "home"))
        self.assertEqual(base["HOME"], "/live")
        for value in ("https://127.0.0.1:123", "http://localhost:123", "http://[::1]:123", "http://127.0.0.1:0",
                      "http://127.0.0.1:65536", "http://127.0.0.1:0123", "http://127.0.0.1:123/",
                      "http://user@127.0.0.1:123", "http://127.0.0.2:123", None):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                p.child_environment(base, root, value)


class CaptureTests(unittest.TestCase):
    def test_raw_capture_schema_has_truncation_only_in_metadata(self):
        capture = b.Capture.__new__(b.Capture)
        capture.items = {"stdout": {"bytes": 2, "eof": True, "kept": bytearray(b"{}")}}
        self.assertNotIn("truncated", capture.items["stdout"])
        metadata = capture.metadata()["stdout"]
        self.assertTrue(metadata["eof"])
        self.assertFalse(metadata["truncated"])
        capture.items["stdout"]["bytes"] = b.MAX_LOG + 1
        self.assertTrue(capture.metadata()["stdout"]["truncated"])
        self.assertIn('for v in output.metadata().values()', Path(p.__file__).read_text())

    def worker_call(self, body):
        original = subprocess.Popen
        commands = []

        def fixture_child(command, **options):
            commands.append(command)
            return original([sys.executable, "-c", body], **options)

        report = {"workers": []}
        with tempfile.TemporaryDirectory() as temp, mock.patch.dict(os.environ, runner()), \
                mock.patch.object(p.subprocess, "Popen", side_effect=fixture_child):
            result = p.call(Path(temp), runner(), "check-updates", types.SimpleNamespace(pid=123), "456", 789,
                            types.SimpleNamespace(pump=lambda: None), report)
        self.assertEqual(commands[0][3:5], ["worker", "check-updates"])
        return result, report

    @unittest.skipIf(os.name == "nt", "POSIX pipe selector; executed in Linux preflight")
    def test_actual_capture_item_schema_uses_metadata_for_truncation(self):
        result, report = self.worker_call('print(\'{"action":"check-updates","actionCount":1}\')')
        self.assertEqual(result, {"action": "check-updates", "actionCount": 1})
        self.assertEqual(report["workers"][0]["exitCode"], 0)
        for item in report["workers"][0]["output"].values():
            self.assertTrue(item["eof"])
            self.assertFalse(item["truncated"])

    @unittest.skipIf(os.name == "nt", "POSIX pipe selector; executed in Linux preflight")
    def test_actual_capture_truncated_worker_output_refuses_before_json(self):
        with self.assertRaisesRegex(RuntimeError, "Worker EOF/size refused"):
            self.worker_call(f'import sys; sys.stdout.write("x" * {b.MAX_LOG + 1})')


class InputTests(unittest.TestCase):
    def test_exact_metadata_producer_binding(self):
        p.validate_target_binding(target_binding())

    def test_every_target_api_pin_refuses_mutation(self):
        fixture = target_binding()
        paths = [(section, key) for section in ("run", "artifact", "job", "commit", "draft")
                 for key, value in fixture[section].items() if not isinstance(value, dict)]
        paths += [(section, sub, key) for section, sub in (("run", "repository"), ("artifact", "workflow_run"), ("commit", "tree"))
                  for key in fixture[section][sub]]
        for parts in paths:
            value = copy.deepcopy(fixture)
            record = value
            for part in parts[:-1]:
                record = record[part]
            record[parts[-1]] = "foreign"
            with self.subTest(parts=parts), self.assertRaises((RuntimeError, KeyError, TypeError)):
                p.validate_target_binding(value)

    def test_metadata_membership_count_state_hash_and_canonical_types(self):
        for field in ("id", "size", "digest", "name", "state"):
            value = target_binding()
            value["assets"][0][field] = "foreign"
            with self.subTest(field=field), self.assertRaises((RuntimeError, TypeError)):
                p.validate_target_binding(value)
        for parts in (("run", "run_attempt"), ("job", "run_attempt"), ("draft", "draft"), ("artifact", "expired")):
            value = target_binding()
            value[parts[0]][parts[1]] = 1 if parts[1] in ("draft", "expired") else True
            with self.subTest(parts=parts), self.assertRaises(RuntimeError):
                p.validate_target_binding(value)
        for operation in (lambda a: a.pop(), lambda a: a.append(copy.deepcopy(a[0]))):
            value = target_binding()
            operation(value["assets"])
            with self.assertRaises(RuntimeError):
                p.validate_target_binding(value)

    def stage_fixture(self, directory, names=None, mode=stat.S_IFREG | 0o644, change_hash=False):
        data = b"synthetic DEB bytes - never installed"
        archive = directory / "linux-discovery-target-original.zip"
        with zipfile.ZipFile(archive, "w") as zipped:
            for name in names or ["producer/product/artifacts/linux-outer-update-15/native-packages/Creator Hub_0.1.15_amd64.deb"]:
                entry = zipfile.ZipInfo(name)
                entry.create_system, entry.external_attr = 3, mode << 16
                zipped.writestr(entry, data)
        metadata = {name: (i + 1, len(raw), hashlib.sha256(raw).hexdigest(), name)
                    for i, (name, raw) in enumerate(((p.DESCRIPTOR, b"descriptor"), (p.DESCRIPTOR + ".minisig", b"signature"), ("latest.json", b"manifest")))}
        for name, (_id, _size, _digest, _remote) in metadata.items():
            (directory / ("linux-discovery-" + name)).write_bytes((b"descriptor" if name == p.DESCRIPTOR else b"signature" if name.endswith("minisig") else b"manifest"))
        (directory / "linux-discovery-target-binding.json").write_text(json.dumps(target_binding()))
        target = {"zipBytes": archive.stat().st_size, "zipSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                  "bytes": len(data), "installer": "f" * 64 if change_hash else hashlib.sha256(data).hexdigest()}
        return metadata, target, data

    def test_stages_exact_single_member_without_install_or_private_signing(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            metadata, target, data = self.stage_fixture(directory)
            with mock.patch.dict(p.TARGET, target), mock.patch.dict(p.METADATA, metadata, clear=True), \
                    mock.patch.object(p, "validate_target_binding") as validate, mock.patch.object(p.subprocess, "Popen") as spawn:
                result = p.stage_target(directory)
            validate.assert_called_once()
            spawn.assert_not_called()
            self.assertEqual((directory / "creator-linux-update-lab/inputs" / p.ASSET).read_bytes(), data)
            self.assertTrue(result["targetInputsStaged"])
            self.assertFalse(result["targetInstalled"])
            self.assertFalse(result["releaseReady"])

    def test_unsafe_ambiguous_linked_or_changed_zip_member_is_not_staged(self):
        tail = "/native-packages/Creator Hub_0.1.15_amd64.deb"
        for names, mode, changed in ((["../escape" + tail], stat.S_IFREG | 0o644, False),
                (["one" + tail, "two" + tail], stat.S_IFREG | 0o644, False),
                (["one" + tail], stat.S_IFLNK | 0o777, False), (["one" + tail], stat.S_IFREG | 0o644, True)):
            with self.subTest(names=names, mode=mode, changed=changed), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp).resolve()
                metadata, target, _data = self.stage_fixture(directory, names, mode, changed)
                with mock.patch.dict(p.TARGET, target), mock.patch.dict(p.METADATA, metadata, clear=True), \
                        mock.patch.object(p, "validate_target_binding"), self.assertRaises(RuntimeError):
                    p.stage_target(directory)
                self.assertFalse((directory / "creator-linux-update-lab/inputs" / p.ASSET).exists())


class NativeControlTests(unittest.TestCase):
    def fixture(self, action="check-updates", heading_role=83):
        f = fixtures.OwnershipTests()
        owner = f.fixture()
        f.web.children = []
        f.atspi.Role.HEADING = 83
        wanted_id, wanted_name = p.CONTROLS[action]
        f.heading = fixtures.AxNode(43, heading_role, "Creator Hub update", parent=f.web)
        f.button = fixtures.AxNode(43, 43, wanted_name, parent=f.web, verb="press")
        f.heading.attrs = {"id": "hub-update-title", "tag": "h2", "computed-role": "heading", "toolkit": "WebKitGTK"}
        f.button.attrs = {"id": wanted_id, "tag": "button", "computed-role": "button", "toolkit": "WebKitGTK"}
        for node in (f.window, f.container, f.web, f.heading, f.button):
            node.get_attributes = lambda node=node: getattr(node, "attrs", {})
        owner.node(f.web)
        owner.references.window = owner.references.identity(f.window, owner)
        return f, owner

    def test_two_owned_walks_one_canonical_source_button_press_for_each_action(self):
        for action in p.CONTROLS:
            f, owner = self.fixture(action)
            with mock.patch.object(c, "own_tree", wraps=c.own_tree) as walks:
                result = p.press_control(action, owner, f.atspi)
            self.assertEqual(walks.call_count, 2)
            f.button.action.do_action.assert_called_once_with(0)
            self.assertEqual(result["domId"], p.CONTROLS[action][0])
            self.assertFalse(result["nativeConfirmationInputAuthorized"])

    def test_heading82_only_exact_h2_id_attributes_and_pinned_producer(self):
        f, owner = self.fixture(heading_role=82)
        p.press_control("check-updates", owner, f.atspi)
        f.button.action.do_action.assert_called_once()
        for key, value in (("id", "other-title"), ("tag", "h1"), ("computed-role", "group"), ("toolkit", "other")):
            f, owner = self.fixture(heading_role=82)
            f.heading.attrs[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.press_control("check-updates", owner, f.atspi)
            f.button.action.do_action.assert_not_called()
        f, owner = self.fixture(heading_role=82)
        with mock.patch.object(b, "WEBKIT_VERSION", "foreign"), self.assertRaisesRegex(RuntimeError, "Heading82"):
            p.press_control("check-updates", owner, f.atspi)
        f.button.action.do_action.assert_not_called()

    def test_ambiguous_id_name_role_tag_action_and_disabled_refuse(self):
        for change in ("duplicate", "name", "role", "tag", "action", "disabled", "hidden", "heading-name"):
            f, owner = self.fixture()
            if change == "duplicate":
                node = fixtures.AxNode(43, 43, f.button.name, parent=f.web, verb="press")
                node.get_attributes = lambda: dict(f.button.attrs)
            elif change == "name":
                f.button.name = "other"
            elif change == "role":
                f.button.role = 88
            elif change == "tag":
                f.button.attrs["tag"] = "a"
            elif change == "action":
                f.button.action.get_action_name = lambda _: "click"
            elif change == "disabled":
                f.button.states = {1}
            elif change == "hidden":
                f.button.states = {2, 3}
            else:
                f.heading.name = "Other heading"
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.press_control("check-updates", owner, f.atspi)
            f.button.action.do_action.assert_not_called()

    def test_changed_canonical_reference_between_walks_refuses(self):
        f, owner = self.fixture()
        first = c.own_tree(f.window, owner, f.atspi)
        other = fixtures.AxNode(43, 43, f.button.name, parent=f.web, verb="press")
        other.get_attributes = lambda: dict(f.button.attrs)
        second = [n if n is not f.button else other for n in first]
        with mock.patch.object(c, "own_tree", side_effect=[first, second]), self.assertRaisesRegex(RuntimeError, "changed"):
            p.press_control("check-updates", owner, f.atspi)
        f.button.action.do_action.assert_not_called()
        other.action.do_action.assert_not_called()

    def test_pid_reuse_uid_image_foreign_parent_and_escaped_tree_refuse(self):
        for change in ("pid", "uid", "image", "foreign-parent", "escaped"):
            f, owner = self.fixture()
            if change == "pid":
                f.records[42]["startTime"] = "101"
            elif change == "uid":
                f.records[42]["uids"] = [0] * 4
            elif change == "image":
                f.records[43]["kernelImageSha256"] = "f" * 64
            else:
                f.button.parent = fixtures.AxNode(99 if change == "foreign-parent" else 43, 20)
            with self.subTest(change=change), mock.patch.object(c, "capture_refusal_hit_test"), self.assertRaises(RuntimeError):
                p.press_control("check-updates", owner, f.atspi)
            f.button.action.do_action.assert_not_called()

    def test_uncertain_press_is_never_retried(self):
        f, owner = self.fixture()
        f.button.action.do_action.side_effect = OSError("uncertain")
        with self.assertRaisesRegex(f.helper.ActionError, "no retry"):
            p.press_control("check-updates", owner, f.atspi)
        f.button.action.do_action.assert_called_once()

    def status_fixture(self):
        f, owner = self.fixture("open-confirmation")
        f.atspi.Role.STATUS_BAR = 54
        status = fixtures.AxNode(43, 54, parent=f.web, states=(2, 3))
        status.attrs = {"id": "hub-update-status", "tag": "p", "computed-role": "status", "toolkit": "WebKitGTK"}
        status.get_attributes = lambda: status.attrs
        status.body = "Version 0.1.15 is ready to install."
        status.text = types.SimpleNamespace(get_character_count=lambda: len(status.body),
                                          get_text=lambda start, end: status.body[start:end])
        status.get_text_iface = lambda: status.text
        return f, owner, status

    def test_exact_source_status_read_is_not_paragraph_or_visible_input_fallback(self):
        f, owner, status = self.status_fixture()
        result = p.update_status(c.own_tree(f.window, owner, f.atspi), owner, f.atspi)
        self.assertEqual(result, {"text": status.body, "showing": False, "readOnly": True})
        f.button.action.do_action.assert_not_called()
        self.assertEqual(status.role, 54)

    def test_status_foreign_context_duplicate_role_oversize_and_changed_length_refuse(self):
        for change in ("foreign", "duplicate", "role", "tag", "computed-role", "toolkit", "oversize", "changed", "defunct"):
            f, owner, status = self.status_fixture()
            nodes = c.own_tree(f.window, owner, f.atspi)
            if change == "foreign":
                status.pid = 99
            elif change == "duplicate":
                nodes.append(status)
            elif change == "role":
                status.role = 72
            elif change in ("tag", "computed-role", "toolkit"):
                status.attrs[change] = "other"
            elif change == "oversize":
                status.body = "x" * 513
            elif change == "changed":
                status.text.get_character_count = mock.Mock(side_effect=[len(status.body), len(status.body) + 1])
            elif change == "defunct":
                status.states.add(4)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.update_status(nodes, owner, f.atspi)
            f.button.action.do_action.assert_not_called()


class ConfirmationCancelTests(unittest.TestCase):
    def fixture(self):
        f = fixtures.OwnershipTests()
        owner = f.fixture()
        f.atspi.Role.ALERT, f.atspi.Role.DIALOG, f.atspi.Role.LABEL = 2, 16, 29
        frame = (10, 20, 500, 300)
        f.alert = fixtures.AxNode(42, 2, "Information")
        group = fixtures.AxNode(42, 20, parent=f.alert)
        question = "Update Creator Hub to 0.1.15?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."
        title = fixtures.AxNode(42, 29, "Update Creator Hub", parent=group)
        body = fixtures.AxNode(42, 29, question, parent=group)
        f.approve = fixtures.AxNode(42, 43, "Update Hub", parent=group, verb="click")
        f.cancel = fixtures.AxNode(42, 43, "Not now", parent=group, verb="click")
        desktop = fixtures.AxNode(0, 75)
        app = fixtures.AxNode(42, 75, parent=desktop)
        app.children = [f.window, f.alert]
        f.atspi.get_desktop = lambda _: desktop
        f.atspi.CoordType = types.SimpleNamespace(SCREEN=0)
        for node in (desktop, app, f.window, f.alert, group, title, body, f.approve, f.cancel):
            node.get_child_count = lambda node=node: len(node.children)
            node.get_child_at_index = lambda index, node=node: node.children[index]
        f.alert.get_component_iface = lambda: types.SimpleNamespace(get_extents=lambda _: types.SimpleNamespace(
            x=frame[0], y=frame[1], width=frame[2], height=frame[3]))
        native_helper = b.load_helper()
        f.helper.Request = native_helper.Request
        f.helper.select_window, f.helper.ready = native_helper.select_window, native_helper.ready
        f.helper.bound_window = lambda request, _: dict(f.info) if request.window == 77 else dict(f.xres)
        f.xres = {"pid": 42, "client": 3, "title": "Update Creator Hub", "mapped": True}
        f.native = {"window": 78, **f.xres}
        f.dismissed = False
        f.cancel.action.do_action.side_effect = lambda _: setattr(f, "dismissed", True) or True
        f.saved = {"root": owner.root, "systemWebKit": {"file": f.system}}
        f.contract = {"root": owner.root, "native": f.native, "nativeFrame": list(frame), "xres": f.xres, "actionCount": 0}
        f.bus = types.SimpleNamespace(close_sync=mock.Mock())
        return f

    def invoke(self, f):
        original_owner = b.RootOwnership

        def ownership(*args, **kwargs):
            return original_owner(*args, **kwargs, reader=f.reader, system_check=lambda: dict(f.system))

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "updater-confirmation-contract.json").write_text(json.dumps(f.contract))
            (root / "ax-ownership.json").write_text("{}")
            with mock.patch.object(b, "native_ax_references", return_value=(f.references, f.bus)), \
                    mock.patch.object(b, "RootOwnership", side_effect=ownership), \
                    mock.patch.object(b, "native_process", return_value=f.saved["root"]), \
                    mock.patch.object(c, "owned_windows", side_effect=lambda *_: [] if f.dismissed else [f.native]):
                return p.cancel_confirmation(root, f.request, f.helper, f.x11, f.atspi, f.saved)

    def test_native_cancel_exact_geometry_root_bus_context_and_one_click(self):
        f = self.fixture()
        result = self.invoke(f)
        self.assertTrue(result["confirmationCancellationInputAuthorized"])
        self.assertTrue(result["axToXidAssociationVerified"])
        self.assertTrue(result["dialogDismissed"])
        self.assertFalse(result["signedUpdateAccepted"])
        self.assertFalse(result["confirmationAccepted"])
        f.cancel.action.do_action.assert_called_once_with(0)
        f.approve.action.do_action.assert_not_called()
        f.bus.close_sync.assert_called_once_with(None)

    def test_foreign_nested_duplicate_wrong_context_or_native_geometry_refuse_before_input(self):
        for change in ("foreign", "nested", "duplicate", "context", "geometry", "action", "pid", "uid"):
            f = self.fixture()
            if change == "foreign":
                f.cancel.pid = 43
            elif change == "nested":
                f.cancel.role = 23
            elif change == "duplicate":
                f.alert.children.append(f.alert.children[0])
            elif change == "context":
                f.alert.children[0].children[1].name = "Other question"
            elif change == "geometry":
                f.contract["nativeFrame"][2] += 1
            elif change == "action":
                f.cancel.action.get_action_name = lambda _: "press"
            elif change == "pid":
                f.records[42]["startTime"] = "101"
            else:
                f.records[42]["uids"] = [0] * 4
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.invoke(f)
            f.cancel.action.do_action.assert_not_called()
            f.approve.action.do_action.assert_not_called()

    def test_uncertain_cancellation_is_not_retried(self):
        f = self.fixture()
        f.cancel.action.do_action.side_effect = OSError("synthetic uncertain action")
        with self.assertRaisesRegex(f.helper.ActionError, "no retry"):
            self.invoke(f)
        f.cancel.action.do_action.assert_called_once_with(0)
        f.approve.action.do_action.assert_not_called()

    def test_changed_canonical_target_between_complete_walks_refuses(self):
        f = self.fixture()
        select = f.helper.select_window
        count = 0

        def replace(request, atspi):
            nonlocal count
            count += 1
            if count == 3:
                f.cancel.path += "changed"
            return select(request, atspi)

        f.helper.select_window = replace
        with self.assertRaisesRegex(RuntimeError, "changed between fresh walks"):
            self.invoke(f)
        f.cancel.action.do_action.assert_not_called()
        f.approve.action.do_action.assert_not_called()


class ReadOnlyCaptureTests(unittest.TestCase):
    def fixture(self):
        request = types.SimpleNamespace(pid=42, start="100", executable="/usr/bin/creator-hub", sha256="a"*64, window=77)
        root = {"pid": 42, "startTime": "100", "uids": [1000]*4, "parentPid": 40}
        native = {"window": 78, "title": "Update Creator Hub", "pid": 42, "client": 3, "mapped": True}
        helper = types.SimpleNamespace(Request=mock.Mock(return_value=types.SimpleNamespace(window=78)),
                                       bound_window=mock.Mock(return_value={"pid": 42, "client": 3, "mapped": True}))
        x11 = types.SimpleNamespace(property=mock.Mock(return_value=77), frame_rectangle=mock.Mock(return_value=(10, 20, 500, 300)))
        observation = {"verified": True, "authorization": False, "actionCount": 0, "axToXidAssociationVerified": False,
            "nodes": [{"windowIndex": 0, "showing": True, "pid": 42, "role": role, "name": name} for role, name in
                      ((2, "Information"), (29, "Update Creator Hub to 0.1.15?\n\nHub will close and reopen."), (43, "Update Hub"), (43, "Not now"))]}
        return request, root, native, helper, x11, observation

    def test_root_gtk_information_alert_captured_without_authorizing_any_input(self):
        request, root, native, helper, x11, observation = self.fixture()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(b, "native_process", return_value=root), \
                mock.patch.object(c, "owned_windows", return_value=[native]), mock.patch.object(c, "backend_ax_observation", return_value=observation):
            result = p.capture_dialog(Path(temp).resolve(), request, helper, x11, None, {"root": root})
            captured = json.loads((Path(temp)/"updater-confirmation-contract.json").read_text())
        self.assertTrue(result["dialogContractCaptured"])
        self.assertEqual(result["actionCount"], 0)
        self.assertFalse(result["axToXidAssociationVerified"])
        self.assertFalse(captured["authorization"])
        self.assertFalse(captured["nativeConfirmationInputAuthorized"])
        self.assertEqual(captured["ax"], observation)
        helper.Request.assert_called_once_with("snapshot", 42, "100", request.executable, request.sha256, 78, native["title"], "ALERT")

    def test_title_alone_wrong_context_split_ax_top_levels_or_unverified_owner_refuse(self):
        for change in ("title-only", "split", "unverified", "ambiguous"):
            request, root, native, helper, x11, observation = self.fixture()
            if change == "title-only":
                observation["nodes"] = observation["nodes"][:1]
            elif change == "split":
                observation["nodes"][-1]["windowIndex"] = 1
            elif change == "unverified":
                observation["verified"] = False
            else:
                native = [native, native | {"window": 79}]
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp, \
                    mock.patch.object(b, "native_process", return_value=root), \
                    mock.patch.object(c, "owned_windows", return_value=native if isinstance(native, list) else [native]), \
                    mock.patch.object(c, "backend_ax_observation", return_value=observation), self.assertRaises(RuntimeError):
                p.capture_dialog(Path(temp).resolve(), request, helper, x11, None, {"root": root})

    def test_reused_root_and_foreign_xres_refuse_before_ax_capture(self):
        request, root, native, helper, x11, observation = self.fixture()
        for changed_root, bound_error in ((root | {"startTime": "reused"}, None), (root, RuntimeError("Foreign XRes"))):
            helper.bound_window.side_effect = bound_error
            with tempfile.TemporaryDirectory() as temp, mock.patch.object(b, "native_process", return_value=changed_root), \
                    mock.patch.object(c, "owned_windows", return_value=[native]), mock.patch.object(c, "backend_ax_observation") as read, \
                    self.assertRaises(RuntimeError):
                p.capture_dialog(Path(temp).resolve(), request, helper, x11, None, {"root": root})
            read.assert_not_called()

    def test_absent_window_deadline_retains_readonly_refusal(self):
        request, root, _native, helper, x11, _observation = self.fixture()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(p.time, "monotonic", side_effect=[0, 21]), self.assertRaises(RuntimeError):
            p.capture_dialog(Path(temp).resolve(), request, helper, x11, None, {"root": root})
            self.fail("Deadline must not authorize input")


class LifecycleTests(unittest.TestCase):
    def test_only_held_lab_child_receives_stop_signal_and_output_is_closed(self):
        process, capture = mock.Mock(), mock.Mock()
        process.poll.side_effect = [None, 0, 0]
        capture.items = {"stdout": {"eof": True}, "stderr": {"eof": True}}
        capture.metadata.return_value = {"bounded": True}
        result = p.stop_feed(process, capture)
        process.send_signal.assert_called_once_with(p.signal.SIGTERM)
        process.wait.assert_called_once_with(timeout=0)
        capture.close.assert_called_once()
        self.assertFalse(result["teardownRequired"])

    def test_startup_refusal_stops_retained_feed_child_before_app_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            node = root / "node"
            node.write_bytes(b"synthetic image never executed")
            process, output = mock.Mock(), mock.Mock()
            process.poll.return_value = None
            output.items = {"stdout": {"kept": b'{"wrong":"ready"}\n'}}
            with mock.patch.object(p.subprocess, "Popen", return_value=process) as spawn, \
                    mock.patch.object(b, "Capture", return_value=output), mock.patch.object(b, "bounded_read", return_value=b"synthetic PEM"), \
                    mock.patch.object(p, "stop_feed", return_value={"exitCode": 0}) as stop, self.assertRaises(RuntimeError):
                p.start_feed(root, root, runner() | {"CREATOR_DISCOVERY_NODE": str(node)}, root/"key", root/"cert")
            stop.assert_called_once_with(process, output)
            self.assertEqual(spawn.call_count, 1)
            self.assertIn("linux-update-lab-feed.cjs", spawn.call_args.args[0][1])
            self.assertNotIn(b"synthetic PEM", (root / "feed-start-refusal.json").read_bytes())
            control = json.loads(process.stdin.write.call_args.args[0])
            self.assertEqual(set(control), {"key", "cert"})

    def test_source_has_no_approval_install15_signing_endpoint_injection_or_root_signals(self):
        source = (HERE / "native-linux-update-discovery.py").read_text()
        ast.parse(source)
        self.assertEqual(source.count("interface.do_action(0)"), 2)
        self.assertIn('n.get_name() == "Not now"', source)
        self.assertNotIn('n.get_name() == "Update Hub"', source)
        self.assertEqual(source.count(".send_signal("), 1)
        self.assertIn("process.send_signal(signal.SIGTERM)", source)
        for forbidden in ("child.send_signal", "child.kill", ".terminate(", "os.kill(", "shell=True", "execute_script",
                          "localStorage", "--no-sandbox", "cargo build", "sign_file", "helper.perform(", "check=False"):
            self.assertNotIn(forbidden, source)
        capture = ast.get_source_segment(source, next(n for n in ast.parse(source).body
            if isinstance(n, ast.FunctionDef) and n.name == "capture_dialog"))
        self.assertNotIn("do_action", capture)
        self.assertNotIn("press_control", capture)
        self.assertIn('"stopped-before-native-confirmation-input"', source)
        self.assertIn('b.install(temp / "linux-root-probe")', source)
        self.assertNotIn('b.install(lab', source)
        main = source.split("def main():", 1)[1]
        self.assertLess(main.index("admission("), main.index("ordinary("))


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        const fs=require('node:fs'),{yaml}=require('./node_modules/playwright-core/lib/utilsBundle.js');
        const doc=yaml.parseDocument(fs.readFileSync(process.argv[1],'utf8'),{uniqueKeys:true});
        if(doc.errors.length)throw doc.errors[0];
        const w=doc.toJS();const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        for(const j of Object.values(w.jobs))for(const s of j.steps)if(s.uses?.startsWith('actions/github-script@'))new AsyncFunction('github','context','core',s.with.script);
        process.stdout.write(JSON.stringify(w));
        """
        result = subprocess.run([shutil.which("node") or "node", "-e", script, str(WORKFLOW)], cwd=ROOT,
                                capture_output=True, check=True, timeout=15)
        cls.workflow = json.loads(result.stdout)

    def test_actual_default_branch_404_bootstrap_is_exact_push_three_files_plus_manual(self):
        trigger = self.workflow["on"]
        self.assertIn("workflow_dispatch", trigger)
        self.assertEqual(trigger["push"]["branches"], [p.BRANCH.removeprefix("refs/heads/")])
        self.assertEqual(set(trigger["push"]["paths"]), {"scripts/native-linux-update-discovery.py",
            "scripts/native-linux-update-discovery.test.py", ".github/workflows/native-linux-update-discovery-014.yml"})
        for job in self.workflow["jobs"].values():
            self.assertIn(p.BRANCH, job["if"])
            self.assertIn("github.event_name == 'push' || github.event_name == 'workflow_dispatch'", job["if"])
            self.assertIn("github.repository_id == '1364807512'", job["if"])

    def test_draft_read_permissions_only_input_job_no_mutating_api_or_tokens_in_native_job(self):
        jobs = self.workflow["jobs"]
        self.assertEqual(set(jobs), {"stage-input", "native"})
        self.assertEqual(jobs["stage-input"]["permissions"], {"contents": "write", "actions": "read"})
        self.assertEqual(jobs["native"]["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(jobs["native"]["needs"], "stage-input")
        native = json.dumps(jobs["native"])
        self.assertNotIn("github-script", native)
        self.assertNotIn("GITHUB_TOKEN", native)
        self.assertNotIn("secrets.", native)
        text = WORKFLOW.read_text()
        for forbidden in ("createRelease", "updateRelease", "uploadReleaseAsset", "deleteReleaseAsset", "workflow_dispatch: {", "cargo build", "npm run build"):
            self.assertNotIn(forbidden, text)
        for job in jobs.values():
            self.assertEqual(job["runs-on"], "ubuntu-22.04")
            self.assertNotIn("container", job)
            checkout = next(s for s in job["steps"] if s.get("uses", "").startswith("actions/checkout@"))
            self.assertFalse(checkout["with"]["persist-credentials"])

    def test_frozen_source_binding_both_archives_and_private_assets_checked_before_native(self):
        text = WORKFLOW.read_text()
        for literal in (p.TARGET["source"], "r.SOURCE", "r.PRIVATE_SOURCE", "commit.tree.sha,tree", "artifact.digest,`sha256:${digest}`",
                        "downloadArtifact(", "getReleaseAsset(", "release.draft,true", "after.draft,true", "asset_id:id",
                        "Buffer.isBuffer(data)||data instanceof ArrayBuffer", "pins.testHelpers", "linux-root-source-binding.json",
                        "linux-discovery-target-binding.json", "linux-discovery-target-original.zip", "linux-discovery-" ):
            self.assertIn(literal, text)
        self.assertLess(text.index("native-linux-update-discovery.test.py\n"), text.index("downloadArtifact("))
        self.assertLess(text.index("native-linux-update-discovery.py stage"), text.index("native-linux-update-discovery.py install14"))

    def test_ephemeral_tls_never_uploaded_and_no_auth_policy_override(self):
        job = self.workflow["jobs"]["native"]
        upload = next(s for s in job["steps"] if s.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertEqual(upload["if"], "always()")
        for forbidden in ("ephemeral-tls", "private.pem", "*.pem", "config.json", "**"):
            self.assertNotIn(forbidden, upload["with"]["path"])
        self.assertIn("updater-confirmation", (HERE/"native-linux-update-discovery.py").read_text())
        run = next(s["run"] for s in job["steps"] if s.get("name") == "Secure exact hosted-runner policy ancestry only")
        self.assertIn("('/usr/share', '/usr/share/polkit-1', '/usr/share/polkit-1/actions')", run)
        for forbidden in ("chmod -R", "sudoers", "polkit.addRule", "rules.d", "pkexec", "NOPASSWD"):
            self.assertNotIn(forbidden, WORKFLOW.read_text())

    def test_all_bash_bodies_and_embedded_python_compile_without_execution(self):
        bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path("/usr/bin/bash")
        self.assertTrue(bash.is_file(), "Bash syntax preflight is required")
        count = python_count = 0
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                if "run" not in step:
                    continue
                body = step["run"]
                checked = subprocess.run([str(bash), "-n"], input=body.encode(), capture_output=True, timeout=10)
                self.assertEqual(checked.returncode, 0, checked.stderr.decode(errors="replace"))
                count += 1
                for embedded in re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", body, re.S):
                    ast.parse(embedded)
                    python_count += 1
        self.assertEqual(count, 7)
        self.assertEqual(python_count, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
