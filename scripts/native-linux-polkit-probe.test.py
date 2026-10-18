"""Pure/temp contracts only. Never launches an agent, pkexec or native session."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORKFLOW = ROOT / ".github/workflows/native-linux-polkit-contract-014.yml"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


p = load("polkit_probe_subject", HERE / "native-linux-polkit-probe.py")
b = p.base()
fixtures = load("polkit_pure_existing_fixtures", HERE / "native-linux-root-probe.test.py")


def runner():
    return fixtures.runner_fixture() | {"CREATOR_LINUX_POLKIT_PROBE": "1", "GITHUB_REF": p.BRANCH,
        "GITHUB_EVENT_NAME": "push", "GITHUB_SHA": "a" * 40}


class ContractTests(unittest.TestCase):
    def test_exact_native_admission_push_and_manual(self):
        for event in ("push", "workflow_dispatch"):
            p.admission(runner() | {"GITHUB_EVENT_NAME": event}, "linux", "x86_64")
        for key in runner():
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({k: v for k, v in runner().items() if k != key}, "linux", "x86_64")

    def test_wrong_platform_branch_repo_or_flatpak_refuses(self):
        for key, value in (("GITHUB_REF", "refs/heads/main"), ("GITHUB_REF", "refs/heads/validation/linux-installed-candidate-014"),
                           ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REPOSITORY_ID", "1"), ("FLATPAK_ID", "foreign")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission(runner() | {key: value}, "linux", "x86_64")
        for system, machine in (("win32", "x86_64"), ("linux", "aarch64")):
            with self.assertRaises(RuntimeError):
                p.admission(runner(), system, machine)

    def test_independently_pinned_agent_and_fixed_noop_command(self):
        self.assertEqual(p.FILES[p.AGENT], ("policykit-1-gnome", "0.105-7ubuntu3", 55448,
            "871825e1437644fbf8bde51b27b65e93f43e439df662183f012983258e45e48c", 0o755))
        self.assertEqual(p.COMMAND, ("/usr/bin/pkexec", "--disable-internal-agent", "/usr/bin/true"))
        self.assertEqual(p.FILES[p.COMMAND[0]][-1], 0o4755)
        self.assertEqual(p.FILES[p.COMMAND[2]][3], "94f5d1c6ad51bbd532bf2e702b3d28cb57ba8887435b4514a06e4ba0cd7fedba")
        self.assertTrue(all(value is False for value in p.FLAGS.values()))
        for name, digest in p.HELPERS.items():
            self.assertEqual(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), digest)

    def test_sanitized_private_child_environment_never_inherits_auth_or_injection(self):
        env = runner() | {"HOME": "/live", "GITHUB_TOKEN": "synthetic", "LD_PRELOAD": "foreign", "GTK_MODULES": "foreign",
                          "HTTP_PROXY": "foreign", "G_MESSAGES_DEBUG": "all", "PATH": "/foreign", "XDG_SESSION_ID": "fake"}
        actual = p.finite_environment(env, Path("/owned"))
        self.assertEqual(actual["HOME"], str(Path("/owned/home")))
        self.assertEqual(actual["PATH"], "/usr/bin:/bin")
        for key in ("GITHUB_TOKEN", "LD_PRELOAD", "GTK_MODULES", "HTTP_PROXY", "G_MESSAGES_DEBUG", "XDG_SESSION_ID"):
            self.assertNotIn(key, actual)
        self.assertEqual(actual["LC_ALL"], "C")

    def test_primary_source_bytes_reject_before_parsing_if_pin_differs(self):
        with mock.patch.object(p.tarfile, "open") as unpack, self.assertRaises(RuntimeError):
            p.source_contract(lambda _name, _limit: b"not the independently pinned Ubuntu source")
        unpack.assert_not_called()

    def test_source_contract_with_small_frozen_fixture_never_runs_code(self):
        main = 'polkit_unix_session_new_for_process_sync (getpid ()\nPOLKIT_AGENT_REGISTER_FLAGS_NONE\n' + p.AGENT_PATH + '\npolkit_agent_listener_register\ngoto out;'
        dialog = 'gtk_entry_set_visibility (GTK_ENTRY (dialog->priv->password_entry), FALSE)\nGTK_RESPONSE_CANCEL\nGTK_RESPONSE_OK'
        main_name = "polkit-gnome-0.105/src/main.c"
        dialog_name = "polkit-gnome-0.105/src/polkitgnomeauthenticationdialog.c"
        groups = [{main_name: main, dialog_name: dialog}, {"debian/patches/series": "\n".join(["04-autorestart.patch"] + [f"other-{i}" for i in range(5)]),
            "debian/patches/04-autorestart.patch": "src/main.c\nregister_client_to_gnome_session();",
            **{f"debian/patches/other-{i}": "other source change" for i in range(5)}}]
        archives = {}
        for i, group in enumerate(groups):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w:xz") as archive:
                for name, text in group.items():
                    data = text.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            archives[f"fixture-{i}.tar.xz"] = stream.getvalue()
        pins = {name: (len(raw), hashlib.sha256(raw).hexdigest()) for name, raw in archives.items()}
        files = {name: hashlib.sha256(text.encode()).hexdigest() for name, text in groups[0].items()}
        with mock.patch.dict(p.SOURCES, pins, clear=True), mock.patch.dict(p.SOURCE_FILES, files, clear=True), \
                mock.patch.object(p.subprocess, "Popen") as spawn:
            result = p.source_contract(lambda name, _size: archives[name])
        spawn.assert_not_called()
        self.assertTrue(result["requiresRealLogindSession"])
        self.assertFalse(result["actualUpdaterAccepted"])


class KernelTests(unittest.TestCase):
    def fixture(self):
        parent = {"pid": 20, "startTime": "100", "kernelImageSha256": "b"*64}
        agent = {"pid": 21, "parentPid": 20, "startTime": "101", "uids": [p.UID]*4,
                 "executable": p.AGENT, "kernelImageSha256": p.FILES[p.AGENT][3]}
        process = mock.Mock(pid=21)
        process.poll.return_value = None
        return process, parent, agent

    def test_same_parent_is_not_enough_without_full_independent_identity(self):
        process, parent, agent = self.fixture()
        with mock.patch.object(p.os, "getpid", return_value=20), mock.patch.object(b, "native_process", side_effect=[parent, agent]):
            p.own_agent(process, agent, parent, None)
        for key, value in (("startTime", "reused"), ("parentPid", 1), ("uids", [0]*4),
                           ("executable", "/tmp/same-name"), ("kernelImageSha256", "f"*64)):
            actual = agent | {key: value}
            with self.subTest(key=key), mock.patch.object(p.os, "getpid", return_value=20), \
                    mock.patch.object(b, "native_process", side_effect=[parent, actual]), self.assertRaises(RuntimeError):
                p.own_agent(process, agent, parent, None)

    def test_changed_held_parent_or_agent_exit_refuses(self):
        process, parent, agent = self.fixture()
        with mock.patch.object(b, "native_process", return_value=parent | {"startTime": "reused"}), self.assertRaises(RuntimeError):
            p.own_agent(process, agent, parent, None)
        process.poll.return_value = 1
        with mock.patch.object(b, "native_process") as read, self.assertRaises(RuntimeError):
            p.own_agent(process, agent, parent, None)
        read.assert_not_called()


class DbusTests(unittest.TestCase):
    XML = '<node><interface name="org.freedesktop.PolicyKit1.AuthenticationAgent"><method name="BeginAuthentication">' + ''.join(
        '<arg type="' + t + '" direction="in"/>' for t in ("s", "s", "s", "a{ss}", "s", "a(sa{sv})")) + \
        '</method><method name="CancelAuthentication"><arg type="s" direction="in"/></method></interface></node>'

    def identity(self, name):
        return {"owner": ":1.2", "pid": 9, "uid": 0} if name == "org.freedesktop.PolicyKit1" else {"owner": name, "pid": 21, "uid": p.UID}

    def call(self, _bus, _dest, object_path, _interface, method, *_args):
        if method == "ListNames":
            return ([":1.3"],)
        self.assertEqual(method, "Introspect")
        self.assertEqual(object_path, p.AGENT_PATH)
        return (self.XML,)

    def test_exact_registered_source_path_interface_and_system_bus_pid_uid(self):
        with mock.patch.object(p, "bus_identity", side_effect=lambda _b, n, _g: self.identity(n)), \
                mock.patch.object(p, "dbus_call", side_effect=self.call) as calls:
            result = p.registered_agent(None, {"pid": 21}, None)
        self.assertEqual(result["pid"], 21)
        self.assertEqual(result["objectPath"], p.AGENT_PATH)
        self.assertEqual(result["uid"], p.UID)
        self.assertEqual({c.args[4] for c in calls.call_args_list}, {"ListNames", "Introspect"})

    def test_foreign_pid_uid_changed_endpoint_or_wrong_method_contract_not_attributed(self):
        for change in ("pid", "uid", "methods", "changed-owner", "ambiguous"):
            def identity(_bus, name, _glib):
                result = self.identity(name)
                if name.startswith(":"):
                    if change == "pid":
                        result["pid"] = 99
                    elif change == "uid":
                        result["uid"] = 0
                return result
            def call(*args):
                if args[4] == "ListNames" and change == "ambiguous":
                    return ([":1.3", ":1.4"],)
                if args[4] == "Introspect" and change == "methods":
                    return (self.XML.replace('type="a{ss}"', 'type="s"'),)
                return self.call(*args)
            if change == "changed-owner":
                identities = [self.identity("org.freedesktop.PolicyKit1"), self.identity(":1.3"), self.identity(":1.3") | {"pid": 99}]
                mocked_identity = mock.Mock(side_effect=identities)
            else:
                mocked_identity = mock.Mock(side_effect=identity)
            with self.subTest(change=change), mock.patch.object(p, "bus_identity", mocked_identity), mock.patch.object(p, "dbus_call", side_effect=call):
                if change == "pid":
                    self.assertIsNone(p.registered_agent(None, {"pid": 21}, None))
                else:
                    with self.assertRaises(RuntimeError):
                        p.registered_agent(None, {"pid": 21}, None)

    def test_real_session_uid_and_remote_status_checked_not_environment_session_id(self):
        properties = {"Id": "c9", "User": (p.UID, "/user/fixture"), "Leader": 11, "Class": "background", "Type": "unspecified", "Remote": False, "State": "active"}
        with mock.patch.object(p, "bus_identity", return_value={"uid": 0}), \
                mock.patch.object(p, "dbus_call", side_effect=[("/org/freedesktop/login1/session/c9",), (properties,)]):
            self.assertEqual(p.session(None, 21, None)["User"][0], p.UID)
        for key, value in (("User", (1, "/other")), ("Remote", True)):
            with mock.patch.object(p, "bus_identity", return_value={"uid": 0}), \
                    mock.patch.object(p, "dbus_call", side_effect=[("/org/freedesktop/login1/session/c9",), (properties | {key: value},)]), \
                    self.assertRaises(RuntimeError):
                p.session(None, 21, None)


class CaptureTests(unittest.TestCase):
    def fixture(self):
        roles = types.SimpleNamespace(APPLICATION=75, DIALOG=16, ALERT=2, LABEL=29, TEXT=61, STATIC=116, PARAGRAPH=73, PASSWORD_TEXT=40)
        states = types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5, EDITABLE=6)
        app = fixtures.AxNode(21, 75, "agent")
        dialog = fixtures.AxNode(21, 16, "Authenticate", parent=app)
        label = fixtures.AxNode(21, 29, "Authentication is required", parent=dialog)
        label.get_text_iface = lambda: types.SimpleNamespace(get_character_count=lambda: 13, get_text=lambda _a, _b: "/usr/bin/true")
        entry = fixtures.AxNode(21, 40, "MUST NOT READ", parent=dialog)
        entry.get_name = mock.Mock(side_effect=AssertionError("Password name read"))
        entry.get_text_iface = mock.Mock(side_effect=AssertionError("Password text read"))
        edit = fixtures.AxNode(21, 61, "MUST NOT READ", parent=dialog, states=(1, 6))
        edit.get_name = mock.Mock(side_effect=AssertionError("Editable name read"))
        edit.get_text_iface = mock.Mock(side_effect=AssertionError("Editable text read"))
        helper = types.SimpleNamespace(children=lambda n, limit: n.children if len(n.children) <= limit else p.require(False, "bound"))
        desktop = types.SimpleNamespace(children=[app])
        atspi = types.SimpleNamespace(Role=roles, StateType=states, get_desktop=lambda _: desktop)
        refs = b.AxReferences(lambda name: {"owner": name, "pid": 21, "uid": p.UID})
        agent = {"pid": 21, "uids": [p.UID]*4}
        return agent, helper, atspi, refs, app, label, entry, edit

    def test_original_raw_gtk_roles_names_text_and_references_without_password_reads(self):
        agent, helper, atspi, refs, _app, _label, entry, edit = self.fixture()
        captured = p.raw_ax(agent, helper, atspi, refs)
        self.assertEqual(captured["actionCount"], 0)
        self.assertFalse(captured["authorization"])
        self.assertFalse(captured["axToXidAssociationVerified"])
        self.assertIn("Authenticate", [n.get("name") for n in captured["nodes"]])
        self.assertIn("/usr/bin/true", [n.get("text") for n in captured["nodes"]])
        self.assertNotIn("MUST NOT READ", json.dumps(captured))
        entry.get_name.assert_not_called()
        entry.get_text_iface.assert_not_called()
        edit.get_name.assert_not_called()
        edit.get_text_iface.assert_not_called()

    def test_foreign_ax_pid_or_bus_uid_refuse(self):
        for change in ("node-pid", "bus-uid"):
            agent, helper, atspi, refs, _app, label, _entry, _edit = self.fixture()
            if change == "node-pid":
                label.pid = 99
            else:
                refs.resolve = lambda name: {"owner": name, "pid": 21, "uid": 0}
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.raw_ax(agent, helper, atspi, refs)

    def test_duplicate_or_overlong_ax_data_refuses_without_input(self):
        for change in ("duplicate", "name", "text"):
            agent, helper, atspi, refs, app, label, _entry, _edit = self.fixture()
            if change == "duplicate":
                app.children.append(app.children[0])
            elif change == "name":
                label.name = "x" * 1025
            else:
                label.get_text_iface = lambda: types.SimpleNamespace(get_character_count=lambda: 2049)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.raw_ax(agent, helper, atspi, refs)

    def test_xres_must_match_claimed_agent_pid_regardless_of_window_title(self):
        x = types.SimpleNamespace(XDefaultRootWindow=lambda _: 1)
        x11 = types.SimpleNamespace(x=x, display=1, property=mock.Mock(side_effect=[(33, 32, [77]), (6, 32, [21])]),
            inspect=mock.Mock(return_value={"pid": 99, "client": 3, "title": "Authenticate", "mapped": True}))
        with self.assertRaisesRegex(RuntimeError, "foreign XRes"):
            p.windows(21, None, x11)

    def test_mapped_native_window_is_captured_without_title_authorization(self):
        x = types.SimpleNamespace(XDefaultRootWindow=lambda _: 1)
        x11 = types.SimpleNamespace(x=x, display=1, property=mock.Mock(side_effect=[(33, 32, [77]), (6, 32, [21])]),
            inspect=mock.Mock(return_value={"pid": 21, "client": 3, "title": "Unexpected native title", "mapped": True}))
        self.assertEqual(p.windows(21, None, x11)[0]["title"], "Unexpected native title")


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = r"""
        const fs=require('node:fs'),{yaml}=require('./node_modules/playwright-core/lib/utilsBundle.js');
        const d=yaml.parseDocument(fs.readFileSync(process.argv[1],'utf8'),{uniqueKeys:true});
        if(d.errors.length)throw d.errors[0];process.stdout.write(JSON.stringify(d.toJS()));
        """
        result = subprocess.run([shutil.which("node") or "node", "-e", source, str(WORKFLOW)], cwd=ROOT,
            capture_output=True, check=True, timeout=15)
        cls.workflow = json.loads(result.stdout)

    def test_exact_bootstrap_scope_manual_dispatch_and_readonly_job(self):
        w = self.workflow
        self.assertIn("workflow_dispatch", w["on"])
        self.assertEqual(w["on"]["push"]["branches"], [p.BRANCH.removeprefix("refs/heads/")])
        self.assertEqual(set(w["on"]["push"]["paths"]), {"scripts/native-linux-polkit-probe.py", "scripts/native-linux-polkit-probe.test.py",
            ".github/workflows/native-linux-polkit-contract-014.yml"})
        self.assertEqual(w["permissions"], {"contents": "read"})
        job = w["jobs"]["contract"]
        self.assertEqual(job["runs-on"], "ubuntu-22.04")
        self.assertIn(p.BRANCH, job["if"])
        self.assertIn("github.event_name == 'push' || github.event_name == 'workflow_dispatch'", job["if"])
        self.assertNotIn("container", job)
        self.assertFalse(job["steps"][0]["with"]["persist-credentials"])

    def test_real_pam_session_one_locked_account_no_policy_override_or_credential_read(self):
        text = WORKFLOW.read_text()
        self.assertIn("--property=PAMName=login", text)
        self.assertIn("sudo useradd --uid 21314 --user-group", text)
        self.assertIn("--uid=creator-polkit-fixture", text)
        self.assertIn("--property=RuntimeMaxSec=100", text)
        self.assertLess(text.index("source-contract >"), text.index("sudo apt-get update"))
        for forbidden in ("chpasswd", "passwd -", "/etc/shadow", "sudoers", "NOPASSWD", "polkit.addRule", "rules.d", "--setenv=GITHUB_TOKEN",
                          "LoadCredential", "SetCredential", "cargo build", "npm run build", "dpkg --install", "CREATOR_HUB_SIGNING"):
            self.assertNotIn(forbidden, text)

    def test_all_bash_embedded_python_and_sources_parse_without_execution(self):
        ast.parse((HERE / "native-linux-polkit-probe.py").read_text())
        ast.parse(Path(__file__).read_text())
        bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path("/usr/bin/bash")
        self.assertTrue(bash.is_file())
        python_count = run_count = 0
        for step in self.workflow["jobs"]["contract"]["steps"]:
            if "run" not in step:
                continue
            body = step["run"]
            checked = subprocess.run([str(bash), "-n"], input=body.encode(), capture_output=True, timeout=10)
            self.assertEqual(checked.returncode, 0, checked.stderr.decode(errors="replace"))
            run_count += 1
            for embedded in re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", body, re.S):
                ast.parse(embedded)
                python_count += 1
        self.assertEqual(run_count, 7)
        self.assertEqual(python_count, 2)

    def test_source_never_authenticates_signals_agent_or_installs_product(self):
        source = (HERE / "native-linux-polkit-probe.py").read_text()
        for forbidden in (".do_action(", "get_action_iface", "get_editable_text_iface", ".send_signal(", ".terminate(", ".kill(",
                          "os.kill(", "shell=True", "stdin.write", "input(", "getspnam", "open('/etc/shadow", "helper.perform(",
                          "WM_DELETE_WINDOW", "b.install(", "execute_script", "__TAURI_INTERNALS__"):
            self.assertNotIn(forbidden, source)
        self.assertIn('"original-gtk-contract.json"', source)
        self.assertIn('sensitive = role == atspi.Role.PASSWORD_TEXT', source)
        self.assertIn('"sessionTeardownRequired"] = True', source)
        self.assertIn("signal.alarm(60)", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
