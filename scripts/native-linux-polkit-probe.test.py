"""Pure/temp contracts only. Never launches an agent, pkexec or native session."""
import ast
import copy
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
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

    def test_cancel_requires_exact_explicit_manual_mode_and_readonly_stays_default(self):
        self.assertEqual(p.capture_mode(runner()), "read-only")
        p.admission(runner() | {"GITHUB_EVENT_NAME": "workflow_dispatch", "CREATOR_LINUX_POLKIT_MODE": "cancel"}, "linux", "x86_64")
        p.admission(runner() | {"GITHUB_REF": p.ADMIN_BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "CREATOR_LINUX_POLKIT_MODE": "admin-capture"}, "linux", "x86_64")
        p.admission(runner() | {"GITHUB_REF": p.ADMIN_BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "CREATOR_LINUX_POLKIT_MODE": "authenticate"}, "linux", "x86_64")
        for event, mode in (("push", "cancel"), ("workflow_dispatch", "authenticate"), ("workflow_dispatch", ""),
                            ("workflow_dispatch", "cancel; true"), ("push", "admin-capture")):
            with self.subTest(event=event, mode=mode), self.assertRaises(RuntimeError):
                p.admission(runner() | {"GITHUB_EVENT_NAME": event, "CREATOR_LINUX_POLKIT_MODE": mode}, "linux", "x86_64")

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
        dialog = 'gtk_entry_set_visibility (GTK_ENTRY (dialog->priv->password_entry), FALSE)\nGTK_STOCK_CANCEL,\nGTK_RESPONSE_CANCEL\nGTK_RESPONSE_OK'
        dialog += '\nTEXT_COL, _("Select user...")\ngtk_combo_box_set_active (GTK_COMBO_BOX (combo), 0);\ng_strv_length (dialog->priv->users) > 1\ndialog->priv->selected_user = g_strdup (dialog->priv->users[0]);'
        authenticator = 'gtk_widget_destroy (authenticator->dialog);\ng_ascii_strncasecmp (request, "password:", 9)\nstrcmp (g_get_user_name (), authenticator->selected_user)'
        main_name = "polkit-gnome-0.105/src/main.c"
        dialog_name = "polkit-gnome-0.105/src/polkitgnomeauthenticationdialog.c"
        authenticator_name = "polkit-gnome-0.105/src/polkitgnomeauthenticator.c"
        default = '+      if (passwd->pw_uid == getuid ())\n+          dialog->priv->selected_user = g_strdup (dialog->priv->users[n]);\n+  gtk_combo_box_set_active (GTK_COMBO_BOX (combo), selected_index);'
        groups = [{main_name: main, dialog_name: dialog, authenticator_name: authenticator}, {"debian/patches/series": "\n".join([p.DEFAULT_USER_PATCH.removeprefix("debian/patches/"), "04-autorestart.patch"] + [f"other-{i}" for i in range(4)]),
            p.DEFAULT_USER_PATCH: default,
            "debian/patches/04-autorestart.patch": "src/main.c\nregister_client_to_gnome_session();",
            **{f"debian/patches/other-{i}": "other source change" for i in range(4)}}]
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
                mock.patch.object(p, "DEFAULT_USER_PATCH_SHA", hashlib.sha256(default.encode()).hexdigest()), \
                mock.patch.object(p.subprocess, "Popen") as spawn:
            result = p.source_contract(lambda name, _size: archives[name])
        spawn.assert_not_called()
        self.assertTrue(result["requiresRealLogindSession"])
        self.assertFalse(result["actualUpdaterAccepted"])
        self.assertNotIn("multiIdentityInitialLabel", result["identitySelection"])
        self.assertEqual(result["identitySelection"]["ubuntuDefault"], "current-user-if-administrator")
        self.assertEqual(result["identitySelection"]["upstreamPlaceholderLabel"], "Select user...")


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


class SystemFileObservationTests(unittest.TestCase):
    def test_original_mode_bytes_and_package_queries_survive_without_authorization(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp).resolve()
            image = output / "synthetic-system-file"
            image.write_bytes(b"synthetic input never executed")
            image.chmod(0o777)
            expected = ("fixture-package", "1", image.stat().st_size,
                        hashlib.sha256(image.read_bytes()).hexdigest(), 0o755)
            def tool(_output, _label, argv, **_options):
                return (0, b"fixture-package\t1\tamd64\tinstalled\n") if "-W" in argv else (0, ("fixture-package: " + str(image) + "\n").encode())
            with mock.patch.dict(p.FILES, {str(image): expected}, clear=True), mock.patch.object(b, "run_tool", side_effect=tool), \
                    mock.patch.object(p.subprocess, "Popen") as launch:
                p.system_file_observation(output)
            launch.assert_not_called()
            saved = json.loads((output / "system-files-observation.json").read_text())
            row = saved["files"][str(image)]
            self.assertEqual(row["mode"], image.stat().st_mode & 0o7777)
            self.assertEqual(row["expectedMode"], 0o755)
            self.assertEqual(row["file"]["sha256"], expected[3])
            self.assertEqual(row["packageRaw"], "fixture-package\t1\tamd64\tinstalled\n")
            self.assertEqual(row["ownerRaw"], "fixture-package: " + str(image) + "\n")
            self.assertFalse(row["authorization"])
            self.assertFalse(saved["authenticationAccepted"])

    def test_observation_failure_is_retained_and_cannot_replace_the_strict_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp).resolve()
            missing = str(output / "absent")
            with mock.patch.dict(p.FILES, {missing: ("fixture", "1", 1, "a" * 64, 0o755)}, clear=True), \
                    mock.patch.object(p.subprocess, "Popen") as launch, self.assertRaises(FileNotFoundError):
                p.verify_files(output)
            launch.assert_not_called()
            saved = json.loads((output / "system-files-observation.json").read_text())
            self.assertEqual(saved["files"][missing]["observationRefusal"], "FileNotFoundError")
        source = (HERE / "native-linux-polkit-probe.py").read_text()
        self.assertIn("b.pinned(path, (size, digest), mode)", source)
        self.assertIn('"Exact system file pin refused: " + filename', source)


class StockPolicyModeTests(unittest.TestCase):
    def package_fixture(self, mode=0o644, uid=0, changed_bytes=False):
        data = (b'<policyconfig><action id="org.freedesktop.policykit.exec"><defaults>'
                b'<allow_any>auth_admin</allow_any><allow_inactive>auth_admin</allow_inactive>'
                b'<allow_active>auth_admin</allow_active></defaults></action></policyconfig>')
        pin = ("polkitd", "0.105-33ubuntu0.2", len(data), hashlib.sha256(data).hexdigest(), 0o644)
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            member = tarfile.TarInfo("." + p.STOCK_POLICY)
            member.mode, member.uid, member.gid, member.size = mode, uid, 0, len(data)
            archive.addfile(member, io.BytesIO(data.replace(b"auth_admin", b"auth_other") if changed_bytes else data))
        return stream.getvalue(), pin

    def test_factory_archive_contract_proves_exact_root_owned_0644_policy(self):
        data, pin = self.package_fixture()
        with mock.patch.dict(p.FILES, {p.STOCK_POLICY: pin}):
            result = p.stock_policy_contract(data)
        self.assertEqual(result, {"path": p.STOCK_POLICY, "uid": 0, "gid": 0, "mode": 0o644,
                                  "size": pin[2], "sha256": pin[3]})

    def test_foreign_factory_mode_owner_or_hash_refuses(self):
        for mode, uid, changed in ((0o777, 0, False), (0o644, 1, False), (0o644, 0, True)):
            data, pin = self.package_fixture(mode, uid, changed)
            with self.subTest(mode=mode, uid=uid, changed=changed), mock.patch.dict(p.FILES, {p.STOCK_POLICY: pin}), self.assertRaises(RuntimeError):
                p.stock_policy_contract(data)

    def test_only_exact_captured_leaf_states_are_eligible(self):
        path = mock.MagicMock()
        path.__str__.return_value = p.STOCK_POLICY
        path.resolve.return_value = path
        pin = p.FILES[p.STOCK_POLICY]
        for mode in (0o644, 0o777):
            path.lstat.return_value = types.SimpleNamespace(st_mode=stat.S_IFREG | mode, st_nlink=1, st_uid=0, st_gid=0)
            p.stock_leaf(path, {"mode": mode, "size": pin[2], "sha256": pin[3]})
        for change in ("mode", "uid", "hardlink", "symlink", "hash", "path"):
            record = {"mode": 0o777, "size": pin[2], "sha256": pin[3]}
            info = {"st_mode": stat.S_IFREG | 0o777, "st_nlink": 1, "st_uid": 0, "st_gid": 0}
            path.__str__.return_value = p.STOCK_POLICY
            if change == "mode":
                info["st_mode"], record["mode"] = stat.S_IFREG | 0o755, 0o755
            elif change == "uid":
                info["st_uid"] = 1
            elif change == "hardlink":
                info["st_nlink"] = 2
            elif change == "symlink":
                info["st_mode"] = stat.S_IFLNK | 0o777
            elif change == "hash":
                record["sha256"] = "f" * 64
            else:
                path.__str__.return_value = "/unrelated/policy"
            path.lstat.return_value = types.SimpleNamespace(**info)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.stock_leaf(path, record)

    def test_wrong_factory_deb_pin_never_reaches_unpack_or_chmod(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.url = p.STOCK_ARCHIVE[0]
        response.read.return_value = b"foreign package bytes"
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(p.os, "getuid", return_value=1001, create=True), \
                mock.patch.object(p.urllib.request, "urlopen", return_value=response), \
                mock.patch.object(p.subprocess, "run") as unpack, mock.patch.object(b, "run_tool") as chmod, self.assertRaises(RuntimeError):
            p.secure_stock_policy(Path(temp).resolve())
        unpack.assert_not_called()
        chmod.assert_not_called()
        source = (HERE / "native-linux-polkit-probe.py").read_text().split("def secure_stock_policy(", 1)[1].split("def system_file_observation(", 1)[0]
        self.assertLess(source.index("stock_policy_contract(unpacked.stdout)"), source.index('"/usr/bin/chmod"'))
        self.assertLess(source.index("Exact stock leaf package provenance required"), source.index('"/usr/bin/chmod"'))
        self.assertEqual(source.count('"/usr/bin/chmod", "0644", "--", STOCK_POLICY'), 1)


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

    def test_identity_requires_system_bus_pid_uid_not_readable_introspection(self):
        with mock.patch.object(p, "bus_identity", side_effect=lambda _b, n, _g: self.identity(n)), \
                mock.patch.object(p, "dbus_call", side_effect=self.call) as calls:
            result = p.agent_bus_identity(None, {"pid": 21}, None)
        self.assertEqual(result["pid"], 21)
        self.assertEqual(result["objectPath"], p.AGENT_PATH)
        self.assertEqual(result["uid"], p.UID)
        self.assertEqual(result["authority"], self.identity("org.freedesktop.PolicyKit1"))
        self.assertEqual({c.args[4] for c in calls.call_args_list}, {"ListNames"})

    def test_original_introspection_refusal_is_retained_without_authorizing_or_substituting_an_agent(self):
        error = RuntimeError("GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: fixed Introspect request denied")
        def call(*args):
            if args[4] == "Introspect":
                raise error
            return self.call(*args)
        observation = {}
        with mock.patch.object(p, "bus_identity", side_effect=lambda _b, n, _g: self.identity(n)), \
                mock.patch.object(p, "dbus_call", side_effect=call) as calls:
            result = p.agent_bus_identity(None, {"pid": 21}, None, observation)
        self.assertEqual(result, self.identity(":1.3") | {"objectPath": p.AGENT_PATH,
            "authority": self.identity("org.freedesktop.PolicyKit1")})
        self.assertEqual(observation["candidates"], [{"owner": ":1.3", "pid": 21, "uid": p.UID,
            "objectPath": p.AGENT_PATH, "introspectionRefusal": {"type": "RuntimeError", "message": str(error)}}])
        self.assertFalse(observation["authorization"])
        self.assertFalse(observation["registrationProven"])
        self.assertNotIn("agentOperationObserved", result)
        self.assertEqual(observation["actionCount"], 0)
        self.assertEqual({c.args[4] for c in calls.call_args_list}, {"ListNames", "Introspect"})

    def test_actual_interface_observation_is_bounded_and_keeps_last_attempt_only(self):
        observation = {"stale": "must not accumulate retries"}
        with mock.patch.object(p, "bus_identity", side_effect=lambda _b, n, _g: self.identity(n)), \
                mock.patch.object(p, "dbus_call", side_effect=self.call):
            result = p.agent_bus_identity(None, {"pid": 21}, None, observation)
        self.assertIsNotNone(result)
        self.assertNotIn("stale", observation)
        self.assertEqual(observation["candidates"][0]["interfaces"], ["org.freedesktop.PolicyKit1.AuthenticationAgent"])
        self.assertEqual(len(observation["candidates"][0]["introspectionSha256"]), 64)
        self.assertTrue(observation["candidates"][0]["sourceInterfaceMatches"])
        self.assertFalse(observation["registrationProven"])
        self.assertFalse(observation["authorization"])
        self.assertLess(len(json.dumps(observation)), 4096)

    def test_unavailable_or_differing_introspection_never_changes_identity_or_claims_operation(self):
        for xml in ("<node/>", self.XML.replace('type="a{ss}"', 'type="s"'), "invalid XML", "x" * 32769):
            def call(*args):
                return (xml,) if args[4] == "Introspect" else self.call(*args)
            observation = {}
            with self.subTest(xml=xml[:32]), mock.patch.object(p, "bus_identity", side_effect=lambda _b, n, _g: self.identity(n)), \
                    mock.patch.object(p, "dbus_call", side_effect=call):
                result = p.agent_bus_identity(None, {"pid": 21}, None, observation)
                self.assertEqual(result, p.agent_bus_identity(None, {"pid": 21}, None))
            candidate = observation["candidates"][0]
            self.assertTrue("introspectionRefusal" in candidate or not candidate["sourceInterfaceMatches"])
            self.assertFalse(observation["registrationProven"])
            self.assertFalse(observation["authorization"])
            self.assertNotIn("agentOperationObserved", result)

    def test_foreign_pid_uid_authority_or_changed_endpoint_and_ambiguity_refuse(self):
        for change in ("pid", "uid", "authority-uid", "changed-owner", "authority-changed", "ambiguous"):
            seen = {"agent": 0, "authority": 0}
            def identity(_bus, name, _glib):
                result = self.identity(name)
                if name.startswith(":"):
                    seen["agent"] += 1
                    if change == "pid":
                        result["pid"] = 99
                    elif change == "uid":
                        result["uid"] = 0
                    elif change == "changed-owner" and seen["agent"] > 1:
                        result["pid"] = 99
                else:
                    seen["authority"] += 1
                    if change == "authority-uid":
                        result["uid"] = p.UID
                    elif change == "authority-changed" and seen["authority"] > 1:
                        result["owner"] = ":1.99"
                return result
            def call(*args):
                if args[4] == "ListNames" and change == "ambiguous":
                    return ([":1.3", ":1.4"],)
                return self.call(*args)
            with self.subTest(change=change), mock.patch.object(p, "bus_identity", side_effect=identity), mock.patch.object(p, "dbus_call", side_effect=call):
                if change == "pid":
                    self.assertIsNone(p.agent_bus_identity(None, {"pid": 21}, None))
                else:
                    with self.assertRaises(RuntimeError):
                        p.agent_bus_identity(None, {"pid": 21}, None)

    def test_identity_change_cannot_be_swallowed_as_an_optional_introspection_error(self):
        error = RuntimeError("GDBus.Error:org.freedesktop.DBus.Error.AccessDenied")
        for changed in (self.identity(":1.3") | {"pid": 99}, self.identity(":1.3") | {"uid": 0}):
            identities = [self.identity("org.freedesktop.PolicyKit1"), self.identity(":1.3"), changed]
            with self.subTest(changed=changed), mock.patch.object(p, "bus_identity", side_effect=identities), \
                    mock.patch.object(p, "dbus_call", side_effect=[([":1.3"],), error]), self.assertRaises(RuntimeError):
                p.agent_bus_identity(None, {"pid": 21}, None, {})

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
    def test_operation_claim_is_after_new_owned_prompt_and_fresh_identity_guards_only(self):
        source = (HERE / "native-linux-polkit-probe.py").read_text().split("def probe(env):", 1)[1].split("def deadline_expired", 1)[0]
        self.assertIn('"agentAttributed": False', source)
        self.assertIn('"agentOperationObserved": False', source)
        self.assertEqual(source.count('record["agentAttributed"] = True'), 1)
        self.assertEqual(source.count('record["agentOperationObserved"] = True'), 1)
        baseline = source.index('require(not windows(agent.pid, helper, x11)')
        request = source.index('request = subprocess.Popen(list(COMMAND)')
        capture = source.index('b.save_json(output / "original-gtk-contract.json"')
        role = source.index('n["showing"] and not n["defunct"]')
        kernel = source.index('own_agent(agent, identity, parent, helper)', role)
        session = source.index('"Real session binding changed"', kernel)
        binding = source.index('windows(agent.pid, helper, x11) == native and agent_bus_identity(system, identity, GLib) == endpoint', session)
        pending = source.index('require(request.poll() is None', binding)
        operation = source.index('record["agentOperationObserved"] = True')
        attributed = source.index('record["agentAttributed"] = True')
        complete = source.index('record["dialogContractCaptured"] = True')
        positions = [baseline, request, capture, role, kernel, session, binding, pending, operation, attributed, complete]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn('registered_agent(', source)

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


class FreshnessReaderTests(unittest.TestCase):
    def reader(self, *, uid=p.UID, present=False, error=None, owner=p.UID, mode=0o700):
        target, parent = mock.MagicMock(), mock.MagicMock()
        target.__str__.return_value = "/opt/creator-polkit-fixture/result/home"
        target.parent = parent
        parent.resolve.return_value = parent
        parent.lstat.return_value = types.SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=owner, st_gid=p.UID)
        target.lstat.side_effect = error if error is not None else (None if present else FileNotFoundError("absent"))
        def exit_code(code):
            raise SystemExit(code)
        output = io.StringIO()
        modules = {"os": types.SimpleNamespace(getuid=lambda: uid, geteuid=lambda: uid),
                   "pathlib": types.SimpleNamespace(Path=lambda path: target), "sys": types.SimpleNamespace(exit=exit_code)}
        with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
            exec(compile(p.FRESHNESS_CHECK, "<fixed-freshness-reader>", "exec"), {})
        return stopped.exception.code, json.loads(output.getvalue()), target

    def test_exact_owner_can_check_private_directory_and_only_missing_leaf_is_fresh(self):
        code, result, target = self.reader()
        self.assertEqual(code, 0)
        self.assertEqual(result, {"path": "/opt/creator-polkit-fixture/result/home", "uid": p.UID,
            "readOnly": True, "fresh": True, "resultUid": p.UID, "resultGid": p.UID, "resultMode": 0o700})
        target.lstat.assert_called_once()

    def test_permission_error_is_not_absence_and_retains_original_refusal(self):
        error = PermissionError(13, "Permission denied", "/opt/creator-polkit-fixture/result/home")
        code, result, _target = self.reader(error=error)
        self.assertEqual(code, 1)
        self.assertFalse(result["fresh"])
        self.assertEqual(result["refusal"], {"type": "PermissionError", "message": str(error)})

    def test_existing_or_dangling_leaf_never_counts_as_fresh(self):
        code, result, target = self.reader(present=True)
        self.assertEqual(code, 1)
        self.assertFalse(result["fresh"])
        target.lstat.assert_called_once()
        target.exists.assert_not_called()

    def test_wrong_actor_owner_or_permissions_never_probe_leaf(self):
        for change in ({"uid": 0}, {"uid": 1001}, {"owner": 1001}, {"mode": 0o755}):
            with self.subTest(change=change):
                code, result, target = self.reader(**change)
                self.assertEqual(code, 1)
                self.assertFalse(result["fresh"])
                target.lstat.assert_not_called()


class AdminCaptureTests(unittest.TestCase):
    def test_factory_admin_mapping_must_be_exact_root_owned_canonical_0644_without_any_chmod(self):
        path = mock.MagicMock()
        path.resolve.return_value = path
        path.lstat.return_value = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_gid=0, st_nlink=1)
        with mock.patch.object(p, "ADMIN_CONFIG", path), mock.patch.object(b, "pinned", return_value={"sha256": p.ADMIN_CONFIG_PIN[1]}) as pin, \
                mock.patch.object(b, "run_tool") as command:
            self.assertEqual(p.admin_config()["sha256"], p.ADMIN_CONFIG_PIN[1])
        pin.assert_called_once_with(path, p.ADMIN_CONFIG_PIN, 0o644)
        command.assert_not_called()
        for change in ("owner", "symlink", "hardlink", "pin"):
            path.lstat.return_value = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644,
                st_uid=1 if change == "owner" else 0, st_gid=0, st_nlink=2 if change == "hardlink" else 1)
            path.resolve.return_value = Path("/different") if change == "symlink" else path
            with self.subTest(change=change), mock.patch.object(p, "ADMIN_CONFIG", path), \
                    mock.patch.object(b, "pinned", side_effect=RuntimeError("factory bytes/mode differ")), self.assertRaises(RuntimeError):
                p.admin_config()

    def groups(self):
        before = {"root": {"gid": 0, "members": []}, "sudo": {"gid": 27, "members": ["packer"]},
                  "docker": {"gid": 120, "members": ["runner"]}, p.USER: {"gid": p.UID, "members": []}}
        after = copy.deepcopy(before)
        after["sudo"]["members"] = sorted(["packer", p.USER])
        return before, after

    def test_only_fresh_fixture_append_preserves_every_other_membership(self):
        before, after = self.groups()
        p.admin_group_delta(before, after)
        for change in ("remove-existing", "other-user", "other-group", "gid", "already-member", "missing-group"):
            original, changed = copy.deepcopy(before), copy.deepcopy(after)
            if change == "remove-existing":
                changed["sudo"]["members"].remove("packer")
            elif change == "other-user":
                changed["sudo"]["members"].append("foreign")
            elif change == "other-group":
                changed["docker"]["members"].remove("runner")
            elif change == "gid":
                changed["sudo"]["gid"] = 28
            elif change == "already-member":
                original["sudo"]["members"].append(p.USER)
            elif change == "missing-group":
                del changed["docker"]
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.admin_group_delta(original, changed)

    def test_group_inventory_selects_only_public_metadata_not_credential_fields(self):
        before, _after = self.groups()
        entries = [types.SimpleNamespace(gr_name=n, gr_gid=v["gid"], gr_mem=v["members"]) for n, v in before.items()]
        with mock.patch.dict(sys.modules, {"grp": types.SimpleNamespace(getgrall=lambda: entries)}):
            self.assertEqual(p.group_inventory(), before)
        entries.append(entries[0])
        with mock.patch.dict(sys.modules, {"grp": types.SimpleNamespace(getgrall=lambda: entries)}), self.assertRaises(RuntimeError):
            p.group_inventory()

    @contextlib.contextmanager
    def provision(self):
        before, after = self.groups()
        account = types.SimpleNamespace(pw_uid=p.UID, pw_gid=p.UID, pw_dir="/var/lib/creator-polkit-fixture", pw_shell="/bin/bash")
        env = runner() | {"GITHUB_REF": p.ADMIN_BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "CREATOR_LINUX_POLKIT_MODE": "admin-capture"}
        with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as stack:
            output = Path(temp).resolve()
            stack.enter_context(mock.patch.dict(sys.modules, {"pwd": types.SimpleNamespace(getpwnam=lambda _name: account)}))
            stack.enter_context(mock.patch.object(p.os, "getuid", return_value=1001, create=True))
            stack.enter_context(mock.patch.object(p.os, "geteuid", return_value=1001, create=True))
            memberships = stack.enter_context(mock.patch.object(p.os, "getgrouplist", side_effect=[[p.UID], [p.UID, 27]], create=True))
            stack.enter_context(mock.patch.object(p, "BASE", output / "fresh-fixture"))
            groups = stack.enter_context(mock.patch.object(p, "group_inventory", side_effect=[before, after]))
            policy = stack.enter_context(mock.patch.object(p, "admin_config", return_value={"sha256": p.ADMIN_CONFIG_PIN[1]}))
            freshness = {"path": "/opt/creator-polkit-fixture/result/home", "uid": p.UID, "readOnly": True,
                         "fresh": True, "resultUid": p.UID, "resultGid": p.UID, "resultMode": 0o700}
            def tool(_output, label, _argv, **_options):
                return (0 if freshness["fresh"] else 1, json.dumps(freshness).encode()) if label == "admin-capture-freshness" else (0, b"")
            command = stack.enter_context(mock.patch.object(b, "run_tool", autospec=True, side_effect=tool))
            yield types.SimpleNamespace(**locals())

    def test_provision_uses_one_fixed_append_only_command_no_password_or_policy_write(self):
        with self.provision() as f:
            result = p.prepare_admin_capture(f.env, f.output)
            f.command.assert_has_calls([
                mock.call(f.output, "admin-capture-freshness", ["/usr/bin/sudo", "-n", "--user", p.USER,
                    "/usr/bin/python3", "-B", "-c", p.FRESHNESS_CHECK], allowed=(0, 1), timeout=8),
                mock.call(f.output, "admin-capture-group-append",
                    ["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "sudo", p.USER], timeout=8)])
            self.assertEqual(f.command.call_count, 2)
            self.assertTrue(result["membershipVerified"])
            self.assertTrue(result["otherMembershipsPreserved"])
            self.assertFalse(result["passwordProvisioned"])
            self.assertFalse(result["policyChanged"])
            self.assertTrue(all(result[k] is False for k in p.FLAGS))
            self.assertEqual(json.loads((f.output / "polkit-admin-group-preflight.json").read_text()), result)

    def test_wrong_mode_reused_identity_memberships_or_policy_refuse_before_mutation(self):
        for change in ("mode", "event", "uid", "existing-membership", "already-used", "policy"):
            with self.subTest(change=change), self.provision() as f:
                if change == "mode":
                    f.env["CREATOR_LINUX_POLKIT_MODE"] = "cancel"
                elif change == "event":
                    f.env["GITHUB_EVENT_NAME"] = "push"
                elif change == "uid":
                    f.account.pw_uid = 999
                elif change == "existing-membership":
                    f.memberships.side_effect = [[p.UID, 27]]
                elif change == "already-used":
                    f.freshness.update(fresh=False, refusal={"type": "RuntimeError", "message": "already used"})
                else:
                    f.policy.side_effect = RuntimeError("stock config pin differs")
                with self.assertRaises(RuntimeError):
                    p.prepare_admin_capture(f.env, f.output)
                self.assertFalse(any(c.args[1] == "admin-capture-group-append" for c in f.command.call_args_list))
                if change in ("mode", "event", "uid", "existing-membership"):
                    f.command.assert_not_called()
                retained = json.loads((f.output / "polkit-admin-group-preflight.json").read_text())
                self.assertIn("refusal", retained)
                self.assertFalse(retained["membershipVerified"])

    def test_other_membership_changes_after_command_are_retained_not_repaired_or_retried(self):
        with self.provision() as f:
            f.after["sudo"]["members"].remove("packer")
            with self.assertRaises(RuntimeError):
                p.prepare_admin_capture(f.env, f.output)
            self.assertEqual(f.command.call_count, 2)
            retained = json.loads((f.output / "polkit-admin-group-preflight.json").read_text())
            self.assertFalse(retained["membershipVerified"])
            self.assertEqual(retained["phase"], "append-only-sudo")

    def test_provisioning_user_does_not_traverse_private_result_directory_regression(self):
        with self.provision() as f:
            base = mock.MagicMock()
            base.__truediv__.return_value.exists.side_effect = PermissionError("39117042294: private 0700 result/home")
            with mock.patch.object(p, "BASE", base):
                result = p.prepare_admin_capture(f.env, f.output)
            base.__truediv__.return_value.exists.assert_not_called()
            self.assertTrue(result["membershipVerified"])
            self.assertEqual(result["freshness"], f.freshness)

    def test_reader_permission_error_or_foreign_metadata_is_retained_and_blocks_append(self):
        for change in ("permission", "uid", "mode", "path"):
            with self.subTest(change=change), self.provision() as f:
                if change == "permission":
                    f.freshness.update(fresh=False, refusal={"type": "PermissionError", "message": "fixed private path refused"})
                elif change == "uid":
                    f.freshness["uid"] = 0
                elif change == "mode":
                    f.freshness["resultMode"] = 0o755
                else:
                    f.freshness["path"] = "/unrelated"
                with self.assertRaises(RuntimeError):
                    p.prepare_admin_capture(f.env, f.output)
                self.assertEqual(f.command.call_count, 1)
                retained = json.loads((f.output / "polkit-admin-group-preflight.json").read_text())
                self.assertEqual(retained["freshness"], f.freshness)
                self.assertFalse(retained["membershipVerified"])

    def test_observation_retains_actual_selector_labels_never_selects_or_reads_password(self):
        agent, helper, atspi, refs, app, _label, password, _edit = CaptureTests().fixture()
        atspi.Role.COMBO_BOX = 11
        selector = fixtures.AxNode(agent["pid"], 11, "Select user...", parent=app.children[0])
        selector.get_action_iface = mock.Mock(side_effect=AssertionError("Identity selection attempted"))
        raw = p.raw_ax(agent, helper, atspi, refs)
        result = p.admin_identity_observation(raw, atspi)
        self.assertEqual([row.get("name") for row in result["selectorNodes"]], ["Select user..."])
        self.assertFalse(result["identitySelected"])
        self.assertFalse(result["selectedIdentityVerified"])
        self.assertTrue(all(result[k] is False for k in p.FLAGS))
        selector.get_action_iface.assert_not_called()
        password.get_name.assert_not_called()
        password.get_text_iface.assert_not_called()
        self.assertNotIn("MUST NOT READ", json.dumps(result))
        raw["nodes"][-1] = next(row for row in raw["nodes"] if row["role"] == 40) | {"name": "must stay omitted"}
        with self.assertRaises(RuntimeError):
            p.admin_identity_observation(raw, atspi)


class CancelTests(unittest.TestCase):
    def fixture(self):
        helper = b.load_helper()
        atspi = types.SimpleNamespace(Role=types.SimpleNamespace(APPLICATION=75, DIALOG=16, ALERT=2, FRAME=23,
            WINDOW=69, LABEL=29, PASSWORD_TEXT=40, PUSH_BUTTON=43, TEXT=61), CoordType=types.SimpleNamespace(SCREEN=0),
            StateType=types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5, EDITABLE=6))
        app = fixtures.AxNode(21, 75, "polkit-gnome-authentication-agent-1")
        dialog = fixtures.AxNode(21, 16, "Authenticate", parent=app)
        question = fixtures.AxNode(21, 29, p.QUESTION, parent=dialog)
        password = fixtures.AxNode(21, 40, "NEVER READ", parent=dialog)
        cancel = fixtures.AxNode(21, 43, "Cancel", parent=dialog, verb="click")
        authenticate = fixtures.AxNode(21, 43, "Authenticate", parent=dialog, verb="click")
        for node in (app, dialog, question, password, cancel, authenticate):
            node.get_child_count = lambda n=node: len(n.children)
            node.get_child_at_index = lambda i, n=node: n.children[i]
            node.clear_cache = mock.Mock()
        desktop = types.SimpleNamespace(get_child_count=lambda: 1, get_child_at_index=lambda _i: app, clear_cache=mock.Mock())
        atspi.get_desktop = lambda _i: desktop
        frame = (10, 20, 600, 300)
        def component(bounds):
            return types.SimpleNamespace(get_extents=lambda _coord: types.SimpleNamespace(
                x=bounds[0], y=bounds[1], width=bounds[2], height=bounds[3]))
        dialog.get_component_iface = lambda: component(frame)
        cancel.get_component_iface = lambda: component((20, 260, 100, 30))
        authenticate.get_component_iface = lambda: component((130, 260, 100, 30))
        password.get_name = mock.Mock(side_effect=AssertionError("Password name read"))
        password.get_text_iface = mock.Mock(side_effect=AssertionError("Password text read"))
        password.get_action_iface = mock.Mock(side_effect=AssertionError("Password action read"))
        authenticate.get_action_iface = mock.Mock(side_effect=AssertionError("Authenticate action read"))
        cancel.get_action_iface = mock.Mock(return_value=cancel.action)
        refs = b.AxReferences(lambda name: {"owner": name, "pid": 21, "uid": p.UID})
        agent = {"pid": 21, "uids": [p.UID] * 4}
        native = [{"window": 77, "pid": 21, "client": 3, "title": "Authenticate", "mapped": True}]
        x11 = types.SimpleNamespace(frame_rectangle=mock.Mock(return_value=frame))
        record = {"mode": "cancel", "cancelActionAttempts": 0, **p.FLAGS}
        geometry = {}
        profile = lambda: p.cancel_profile(agent, helper, atspi, refs, x11, native, geometry)
        return types.SimpleNamespace(**locals())

    def test_fresh_exact_profiles_one_cancel_no_password_or_authenticate_access(self):
        f = self.fixture()
        guard = mock.Mock()
        with mock.patch.object(p, "windows", return_value=f.native):
            p.cancel_once(f.profile, guard, f.record)
        f.cancel.action.do_action.assert_called_once_with(0)
        f.cancel.get_action_iface.assert_called_once()
        f.authenticate.get_action_iface.assert_not_called()
        f.password.get_name.assert_not_called()
        f.password.get_text_iface.assert_not_called()
        f.password.get_action_iface.assert_not_called()
        self.assertGreaterEqual(f.dialog.clear_cache.call_count, 2)
        self.assertEqual(guard.call_count, 3)
        self.assertEqual(f.record["cancelActionAttempts"], 1)
        self.assertTrue(f.record["cancelProfile"]["axToXidAssociationVerified"])
        self.assertFalse(f.record["authenticationAccepted"])
        self.assertFalse(f.record["cancelAccepted"])

    def test_graph_change_after_identity_guard_is_rechecked_without_input(self):
        f = self.fixture()
        def guard():
            if f.dialog.clear_cache.call_count >= 2:
                f.cancel.name = "Authenticate"
        with mock.patch.object(p, "windows", return_value=f.native), self.assertRaises(RuntimeError):
            p.cancel_once(f.profile, guard, f.record)
        f.cancel.action.do_action.assert_not_called()
        f.cancel.get_action_iface.assert_not_called()

    def test_foreign_changed_graph_role_text_state_and_geometry_never_get_input(self):
        changes = ("pid", "bus-uid", "parent", "duplicate", "role", "question", "question-duplicate", "button-name",
                   "button-count", "password-role", "busy", "hidden", "frame", "frame-none", "frame-error", "control-bounds", "extra-window")
        for change in changes:
            f = self.fixture()
            if change == "pid":
                f.cancel.pid = 99
            elif change == "bus-uid":
                f.refs.resolve = lambda name: {"owner": name, "pid": 21, "uid": 0}
            elif change == "parent":
                f.question.parent = f.app
            elif change == "duplicate":
                f.dialog.children.append(f.question)
            elif change == "role":
                f.dialog.role = 2
            elif change == "question":
                f.question.name = "Run something else"
            elif change == "question-duplicate":
                f.authenticate.role, f.authenticate.name = 29, p.QUESTION
            elif change == "button-name":
                f.cancel.name = "Authenticate"
            elif change == "button-count":
                f.dialog.children.remove(f.authenticate)
            elif change == "password-role":
                f.password.role, f.password.states = 61, {1, 2, 3, 6}
            elif change == "busy":
                f.cancel.states.add(5)
            elif change == "hidden":
                f.password.states.remove(1)
            elif change == "frame":
                f.x11.frame_rectangle.return_value = (10, 21, 600, 300)
            elif change == "frame-none":
                f.x11.frame_rectangle.return_value = None
            elif change == "frame-error":
                f.x11.frame_rectangle.side_effect = RuntimeError("unknown frame extents")
            elif change == "control-bounds":
                f.cancel.get_component_iface = lambda: types.SimpleNamespace(get_extents=lambda _coord: types.SimpleNamespace(x=0, y=0, width=1, height=1))
            elif change == "extra-window":
                f.app.children.append(f.dialog)
            with self.subTest(change=change), mock.patch.object(p, "windows", return_value=f.native), self.assertRaises(RuntimeError):
                p.cancel_once(f.profile, mock.Mock(), f.record)
            f.cancel.action.do_action.assert_not_called()
            f.authenticate.get_action_iface.assert_not_called()
            f.password.get_name.assert_not_called()
            f.password.get_text_iface.assert_not_called()
            self.assertEqual(f.record["cancelActionAttempts"], 0)

    def test_native_window_or_fresh_graph_drift_refuses_before_action(self):
        for change in ("window", "graph", "frame", "kernel-bus-session"):
            f = self.fixture()
            def profile():
                result = f.profile()
                if change == "graph":
                    f.question.name = "Changed after first read"
                return result
            guard = mock.Mock(side_effect=[None, None, RuntimeError("fresh identity changed")]) if change == "kernel-bus-session" else mock.Mock()
            windows = [f.native, f.native, [f.native[0] | {"client": 9}]] if change == "window" else None
            if change == "frame":
                f.x11.frame_rectangle.side_effect = [f.frame, f.frame, (11, 20, 600, 300)]
            with self.subTest(change=change), mock.patch.object(p, "windows", side_effect=windows, return_value=f.native), self.assertRaises(RuntimeError):
                p.cancel_once(profile, guard, f.record)
            f.cancel.action.do_action.assert_not_called()
            self.assertEqual(f.record["cancelActionAttempts"], 0)

    def test_refused_or_uncertain_action_is_one_attempt_and_cannot_retry(self):
        for failure in (False, RuntimeError("native RPC result unknown")):
            f = self.fixture()
            if isinstance(failure, Exception):
                f.cancel.action.do_action.side_effect = failure
            else:
                f.cancel.action.do_action.return_value = failure
            with self.subTest(failure=str(failure)), mock.patch.object(p, "windows", return_value=f.native):
                with self.assertRaises(RuntimeError):
                    p.cancel_once(f.profile, mock.Mock(), f.record)
                with self.assertRaises(RuntimeError):
                    p.cancel_once(f.profile, mock.Mock(), f.record)
            f.cancel.action.do_action.assert_called_once_with(0)
            self.assertEqual(f.record["cancelActionAttempts"], 1)
            self.assertTrue(f.record["actionMayHaveRun"])
            self.assertFalse(f.record["cancelAccepted"])

    def test_readonly_mode_cannot_query_or_press_a_cancel_action(self):
        profile, guard = mock.Mock(), mock.Mock()
        with self.assertRaises(RuntimeError):
            p.cancel_once(profile, guard, {"mode": "read-only"})
        profile.assert_not_called()
        guard.assert_not_called()

    def test_action_alias_count_or_name_mismatch_refuses_without_input(self):
        for count, name in ((0, "click"), (2, "click"), (1, "press"), (1, "activate")):
            f = self.fixture()
            f.cancel.action.get_n_actions = lambda: count
            f.cancel.action.get_action_name = lambda _i: name
            with self.subTest(count=count, name=name), mock.patch.object(p, "windows", return_value=f.native), self.assertRaises(RuntimeError):
                p.cancel_once(f.profile, mock.Mock(), f.record)
            f.cancel.action.do_action.assert_not_called()

    def test_cancel_completion_requires_both_126_and_complete_native_absence(self):
        for exit_code, absent, accepted in ((126, True, True), (126, False, False), (None, True, False), (0, True, False), (127, True, False)):
            record = {"cancelAccepted": False}
            request, capture = mock.Mock(), mock.Mock()
            request.poll.return_value = exit_code
            def dismissal(_x, _h, _target, observation):
                observation.update(complete=True, absent=absent)
            with self.subTest(exit=exit_code, absent=absent), mock.patch.object(p.time, "monotonic", side_effect=[0, 1, 11]), \
                    mock.patch.object(p, "native_window_absence", side_effect=dismissal):
                if accepted:
                    p.wait_cancel(request, capture, mock.Mock(), None, None, 77, record)
                else:
                    with self.assertRaises(RuntimeError):
                        p.wait_cancel(request, capture, mock.Mock(), None, None, 77, record)
            self.assertEqual(record["cancelAccepted"], accepted)

    def test_post_cancel_identity_refusal_never_claims_cancel_acceptance(self):
        record = {"cancelAccepted": False}
        with mock.patch.object(p.time, "monotonic", side_effect=[0, 1]), mock.patch.object(p, "native_window_absence") as query, \
                self.assertRaises(RuntimeError):
            p.wait_cancel(mock.Mock(), mock.Mock(), mock.Mock(side_effect=RuntimeError("agent/session changed")), None, None, 77, record)
        query.assert_not_called()
        self.assertFalse(record["cancelAccepted"])


class AuthenticateTests(unittest.TestCase):
    def fixture(self):
        f = CancelTests().fixture()
        f.atspi.Role.COMBO_BOX, f.atspi.Role.MENU, f.atspi.Role.MENU_ITEM = 11, 33, 35
        combo = fixtures.AxNode(21, 11, p.USER, parent=f.dialog)
        menu = fixtures.AxNode(21, 33, parent=combo, states=(2, 3))
        placeholder = fixtures.AxNode(21, 35, "Select user...", parent=menu, states=())
        other = fixtures.AxNode(21, 35, "Ubuntu (packer)", parent=menu, states=(2, 3))
        selected = fixtures.AxNode(21, 35, p.USER, parent=menu, states=(2, 3))
        prompt = fixtures.AxNode(21, 29, "Password:", parent=f.dialog)
        for node in (combo, menu, placeholder, other, selected, prompt):
            node.get_child_count = lambda n=node: len(n.children)
            node.get_child_at_index = lambda i, n=node: n.children[i]
        selection = types.SimpleNamespace(get_n_selected_children=mock.Mock(return_value=1),
                                         get_selected_child=mock.Mock(return_value=selected))
        combo.get_selection_iface = mock.Mock(return_value=selection)
        combo.get_action_iface = mock.Mock(side_effect=AssertionError("Identity input forbidden"))
        for node in (combo, prompt, f.password):
            node.get_component_iface = lambda: f.component((20, 100, 200, 30))
        f.password.states.add(6)
        editable = types.SimpleNamespace(set_text_contents=mock.Mock(return_value=True))
        f.password.get_editable_text_iface = mock.Mock(return_value=editable)
        f.authenticate.get_action_iface = mock.Mock(return_value=f.authenticate.action)
        record = {"mode": "authenticate", "passwordWriteAttempts": 0, "authenticateActionAttempts": 0, **p.FLAGS}
        secret = bytearray(b"a" * 64)  # Public unit-test sentinel, never a real credential.
        profile = lambda: p.cancel_profile(f.agent, f.helper, f.atspi, f.refs, f.x11, f.native, f.geometry, authenticate=True)
        return types.SimpleNamespace(**(vars(f) | {k: v for k, v in locals().items() if k not in ("self", "f")}))

    def test_exact_selected_fixture_one_write_one_click_and_no_password_readback(self):
        f = self.fixture()
        with mock.patch.object(p, "windows", return_value=f.native):
            p.authenticate_once(f.profile, mock.Mock(), f.record, f.secret)
        f.editable.set_text_contents.assert_called_once_with("a" * 64)
        f.authenticate.action.do_action.assert_called_once_with(0)
        f.cancel.action.do_action.assert_not_called()
        f.combo.get_action_iface.assert_not_called()
        f.password.get_name.assert_not_called()
        f.password.get_text_iface.assert_not_called()
        self.assertTrue(f.record["authenticationProfile"]["selectedIdentityVerified"])
        self.assertTrue(f.record["authenticationProfile"]["axToXidAssociationVerified"])
        self.assertNotIn("a" * 64, json.dumps(f.record))
        self.assertFalse(f.record["authenticationAccepted"])
        for key in ("actualUpdaterAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady"):
            self.assertFalse(f.record[key])

    def test_password_fingerprint_identical_pre_post_write_without_content_or_count(self):
        f = self.fixture()
        f.password.get_character_count = mock.Mock(side_effect=AssertionError("Password character count read"))
        f.password.get_text = mock.Mock(side_effect=AssertionError("Password content read"))
        f.password.synthetic_character_count, f.password.synthetic_content = 0, ""
        def write(value):
            f.password.synthetic_character_count = len(value)
            f.password.synthetic_content = value
            return True
        f.editable.set_text_contents.side_effect = write
        with mock.patch.object(p, "windows", return_value=f.native):
            _controls, before = f.profile()
            p.authenticate_once(f.profile, mock.Mock(), f.record, f.secret)
            _controls, after = f.profile()
        self.assertEqual(f.password.synthetic_character_count, 64)
        self.assertEqual(before, after)
        password_row, = [row for row in after["graph"] if row["role"] == 40]
        self.assertEqual(set(password_row), {"reference", "parent", "role", "name", "showing", "enabled", "sensitive", "defunct", "busy"})
        self.assertIsNone(password_row["name"])
        self.assertNotIn("a" * 64, json.dumps([before, after, f.record]))
        for method in (f.password.get_name, f.password.get_text_iface, f.password.get_text, f.password.get_character_count):
            method.assert_not_called()
        self.assertEqual(after["selectedIdentity"], p.USER)
        self.assertEqual(after["selectedReference"], [f.selected.app.bus_name, f.selected.path])
        f.combo.get_action_iface.assert_not_called()

    def test_foreign_selection_graph_frame_or_password_refuses_before_secret_write(self):
        for change in ("selected-other", "selected-foreign", "selected-count", "selected-parent", "combo-name", "prompt",
                       "password-role", "password-not-editable", "frame", "frame-none", "pid", "password-bounds"):
            f = self.fixture()
            if change == "selected-other":
                f.selection.get_selected_child.return_value = f.other
            elif change == "selected-foreign":
                f.selected.pid = 99
            elif change == "selected-count":
                f.selection.get_n_selected_children.return_value = 2
            elif change == "selected-parent":
                f.selected.parent = f.dialog
            elif change == "combo-name":
                f.combo.name = "Ubuntu (packer)"
            elif change == "prompt":
                f.prompt.name = "Password for packer:"
            elif change == "password-role":
                f.password.role = 61
            elif change == "password-not-editable":
                f.password.states.remove(6)
            elif change == "frame":
                f.x11.frame_rectangle.return_value = (10, 21, 600, 300)
            elif change == "frame-none":
                f.x11.frame_rectangle.return_value = None
            elif change == "pid":
                f.authenticate.pid = 99
            else:
                f.password.get_component_iface = lambda: f.component((0, 0, 1, 1))
            with self.subTest(change=change), mock.patch.object(p, "windows", return_value=f.native), self.assertRaises(RuntimeError):
                p.authenticate_once(f.profile, mock.Mock(), f.record, f.secret)
            f.editable.set_text_contents.assert_not_called()
            f.authenticate.action.do_action.assert_not_called()
            f.password.get_name.assert_not_called()
            f.password.get_text_iface.assert_not_called()

    def test_post_write_selection_frame_or_kernel_drift_blocks_authenticate(self):
        for change in ("selection", "frame", "kernel-bus-session", "password-role"):
            f = self.fixture()
            def write(_value):
                if change == "selection":
                    f.selection.get_selected_child.return_value = f.other
                elif change == "frame":
                    f.x11.frame_rectangle.return_value = (11, 20, 600, 300)
                elif change == "password-role":
                    f.password.role = 61
                    f.password.states.remove(6)
                return True
            f.editable.set_text_contents.side_effect = write
            def guard():
                if change == "kernel-bus-session" and f.record["passwordWriteAttempts"]:
                    raise RuntimeError("changed identity")
            with self.subTest(change=change), mock.patch.object(p, "windows", return_value=f.native), self.assertRaises(RuntimeError):
                p.authenticate_once(f.profile, guard, f.record, f.secret)
            f.editable.set_text_contents.assert_called_once()
            f.authenticate.action.do_action.assert_not_called()
            f.password.get_name.assert_not_called()
            f.password.get_text_iface.assert_not_called()

    def test_ambiguous_write_or_click_is_static_and_never_retried(self):
        for where in ("write", "click"):
            for failure in (False, RuntimeError("a" * 64)):
                f = self.fixture()
                action = f.editable.set_text_contents if where == "write" else f.authenticate.action.do_action
                if isinstance(failure, Exception):
                    action.side_effect = failure
                else:
                    action.return_value = failure
                with self.subTest(where=where, failure=type(failure).__name__), mock.patch.object(p, "windows", return_value=f.native):
                    for _ in range(2):
                        with self.assertRaisesRegex(RuntimeError, "^Synthetic native authentication refused; no retry$"):
                            p.authenticate_once(f.profile, mock.Mock(), f.record, f.secret)
                f.editable.set_text_contents.assert_called_once()
                self.assertEqual(f.authenticate.action.do_action.call_count, 0 if where == "write" else 1)
                self.assertNotIn("a" * 64, json.dumps(f.record))

    def test_readonly_cancel_admin_capture_or_reused_attempt_cannot_write(self):
        for change in ({"mode": "read-only"}, {"mode": "cancel"}, {"mode": "admin-capture"},
                       {"passwordWriteAttempts": 1}, {"authenticateActionAttempts": 1}):
            profile = mock.Mock()
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                p.authenticate_once(profile, mock.Mock(), {"mode": "authenticate", **change}, bytearray(b"a" * 64))
            profile.assert_not_called()

    def test_unexpected_authenticate_action_contract_never_presses(self):
        for count, name in ((0, "click"), (2, "click"), (1, "press")):
            f = self.fixture()
            f.authenticate.action.get_n_actions = lambda: count
            f.authenticate.action.get_action_name = lambda _i: name
            with self.subTest(count=count, name=name), mock.patch.object(p, "windows", return_value=f.native), self.assertRaises(RuntimeError):
                p.authenticate_once(f.profile, mock.Mock(), f.record, f.secret)
            f.authenticate.action.do_action.assert_not_called()
            self.assertEqual(f.record["authenticateActionAttempts"], 0)

    def test_completion_requires_exit_zero_and_complete_independent_dismissal(self):
        for code, complete, absent, accepted in ((0, True, True, True), (0, False, True, False),
                (0, True, False, False), (None, True, True, False), (126, True, True, False)):
            record = {"mode": "authenticate", "authenticateActionAttempts": 1, "authenticateActionReturned": True, **p.FLAGS}
            request = mock.Mock()
            request.poll.return_value = code
            def query(_x, _h, _target, out):
                out.update(complete=complete, absent=absent)
            with self.subTest(code=code, complete=complete, absent=absent), \
                    mock.patch.object(p.time, "monotonic", side_effect=[0, 1, 11]), mock.patch.object(p.time, "sleep"), \
                    mock.patch.object(p, "native_window_absence", side_effect=query):
                if accepted:
                    p.wait_authenticate(request, mock.Mock(), None, None, 77, record)
                else:
                    with self.assertRaises(RuntimeError):
                        p.wait_authenticate(request, mock.Mock(), None, None, 77, record)
            self.assertEqual(record["authenticationAccepted"], accepted)
            self.assertFalse(record["actualUpdaterAccepted"])


class SecretTransportTests(unittest.TestCase):
    def env(self):
        return runner() | {"GITHUB_REF": p.ADMIN_BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "CREATOR_LINUX_POLKIT_MODE": "authenticate"}

    def test_independent_factory_password_binary_pins_are_exact(self):
        self.assertEqual(p.CREDENTIAL_TOOLS, {
            "/usr/sbin/chpasswd": (55464, "e0c190eb148040cc5f1e5dd6ec3b22b2592c3a71b89db67f019236fad7f6e92a", 0o755),
            "/usr/bin/passwd": (59976, "82fb3e989f9f224f1b1b5687109fa4c31fc60572876cd7c3486ff107d451b6ee", 0o4755)})

    def test_fixed_credential_tools_only_stdin_never_argv_env_output_or_error(self):
        for operation in ("status", "provision", "lock"):
            secret = bytearray(b"a" * 64) if operation == "provision" else None
            result = types.SimpleNamespace(returncode=0, stdout=(p.USER + " L 10/18/2026 0 99999 7 -1\n").encode())
            def run(argv, **options):
                self.assertNotIn("a" * 64, json.dumps([argv, options["env"]]))
                self.assertEqual(options["stderr"], subprocess.DEVNULL)
                if operation == "provision":
                    self.assertEqual(bytes(options["input"]), p.USER.encode() + b":" + secret + b"\n")
                    self.assertNotIn("stdin", options)
                else:
                    self.assertEqual(options["stdin"], subprocess.DEVNULL)
                    self.assertNotIn("input", options)
                self.assertEqual(options["stdout"], subprocess.PIPE if operation == "status" else subprocess.DEVNULL)
                return result
            with self.subTest(operation=operation), mock.patch.object(p.os, "getuid", return_value=0, create=True), \
                    mock.patch.object(p.os, "geteuid", return_value=0, create=True), mock.patch.object(p.subprocess, "run", autospec=True, side_effect=run) as child:
                p.fixture_credential(operation, secret)
            self.assertNotIn("sudo", child.call_args.args[0])
            if operation == "provision":
                self.assertEqual(set(child.call_args.kwargs["input"]), {0})

    def test_credential_exceptions_never_retain_payload_in_message(self):
        with mock.patch.object(p.os, "getuid", return_value=0, create=True), mock.patch.object(p.os, "geteuid", return_value=0, create=True), \
                mock.patch.object(p.subprocess, "run", side_effect=RuntimeError("a" * 64)), \
                self.assertRaisesRegex(RuntimeError, "^Synthetic credential operation refused$"):
            p.fixture_credential("provision", bytearray(b"a" * 64))

    def test_nonroot_or_unknown_operation_cannot_provision(self):
        for uid, operation in ((p.UID, "provision"), (0, "other-user")):
            with self.subTest(uid=uid, operation=operation), mock.patch.object(p.os, "getuid", return_value=uid, create=True), \
                    mock.patch.object(p.os, "geteuid", return_value=uid, create=True), mock.patch.object(p.subprocess, "run") as child, self.assertRaises(RuntimeError):
                p.fixture_credential(operation, bytearray(b"a" * 64))
            child.assert_not_called()

    def test_pipe_reader_bounded_fragmented_frame_and_no_files(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFIFO | 0o600, st_uid=0)
        with mock.patch.object(p.os, "getuid", return_value=p.UID, create=True), mock.patch.object(p.os, "geteuid", return_value=p.UID, create=True), \
                mock.patch.object(p.os, "fstat", return_value=info), mock.patch.object(p.os, "read", side_effect=[b"a" * 20, b"a" * 44 + b"\n", b""]) as read, \
                mock.patch.object(p.os, "close") as close:
            actual = p.read_synthetic_secret(self.env())
        self.assertEqual(actual, bytearray(b"a" * 64))
        self.assertEqual([c.args for c in read.call_args_list], [(0, 66), (0, 46), (0, 1)])
        close.assert_called_once_with(0)

    def test_reader_refuses_wrong_uid_mode_regular_file_or_foreign_pipe(self):
        for change in ("uid", "mode", "file", "owner"):
            info = types.SimpleNamespace(st_mode=stat.S_IFREG if change == "file" else stat.S_IFIFO, st_uid=p.UID if change == "owner" else 0)
            env = self.env() | ({"CREATOR_LINUX_POLKIT_MODE": "admin-capture"} if change == "mode" else {})
            with self.subTest(change=change), mock.patch.object(p.os, "getuid", return_value=0 if change == "uid" else p.UID, create=True), \
                    mock.patch.object(p.os, "geteuid", return_value=p.UID, create=True), mock.patch.object(p.os, "fstat", return_value=info), \
                    mock.patch.object(p.os, "read") as read, self.assertRaises(RuntimeError):
                p.read_synthetic_secret(env)
            read.assert_not_called()

    def test_reader_rejects_overlong_invalid_or_truncated_secret_without_echo(self):
        for frame in (b"a" * 66, b"a" * 63 + b"\n", b"z" * 64 + b"\n"):
            with self.subTest(size=len(frame)), mock.patch.object(p.os, "getuid", return_value=p.UID, create=True), \
                    mock.patch.object(p.os, "geteuid", return_value=p.UID, create=True), \
                    mock.patch.object(p.os, "fstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFIFO, st_uid=0)), \
                    mock.patch.object(p.os, "read", side_effect=[frame, b""]), mock.patch.object(p.os, "close"), \
                    self.assertRaisesRegex(RuntimeError, "^Synthetic stdin frame refused$"):
                p.read_synthetic_secret(self.env())

    def test_session_command_is_fixed_finite_secret_free_and_ignores_inherited_credentials(self):
        env = self.env() | {"PASSWORD": "a" * 64, "GITHUB_TOKEN": "foreign", "LD_PRELOAD": "foreign"}
        argv = p.authentication_session_command(env)
        self.assertEqual(argv[0], "/usr/bin/systemd-run")
        for item in ("--pipe", "--property=LimitCORE=0", "--property=PAMName=login", "--property=RuntimeMaxSec=100", "--uid=" + p.USER):
            self.assertIn(item, argv)
        self.assertIn("/usr/bin/openbox --sm-disable </dev/null >/dev/null 2>&1", argv[-1])
        self.assertNotIn("a" * 64, json.dumps(argv))
        self.assertNotIn("foreign", json.dumps(argv))
        with self.assertRaises(RuntimeError):
            p.authentication_session_command(runner())

    def test_core_dump_limit_uses_real_resource_signature(self):
        resource = types.SimpleNamespace(RLIMIT_CORE=4, setrlimit=mock.Mock(), getrlimit=mock.Mock(return_value=(0, 0)))
        with mock.patch.dict(sys.modules, {"resource": resource}):
            p.disable_core_dumps()
        resource.setrlimit.assert_called_once_with(4, (0, 0))


class RootBrokerTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        env = SecretTransportTests().env()
        account = types.SimpleNamespace(pw_uid=p.UID, pw_gid=p.UID, pw_dir="/var/lib/creator-polkit-fixture", pw_shell="/bin/bash")
        root = mock.MagicMock()
        root.__str__.return_value = "/opt/creator-polkit-fixture"
        output = mock.MagicMock()
        output.resolve.return_value = output
        output.stat.return_value = types.SimpleNamespace(st_uid=p.UID, st_gid=p.UID, st_mode=stat.S_IFDIR | 0o700)
        home = mock.Mock()
        home.lstat.side_effect = FileNotFoundError()
        output.__truediv__.return_value = home
        root.__truediv__.side_effect = lambda name: output if name == "result" else Path("/fixed") / name
        status = ["L", "P", "L"]
        calls, receipts = [], []
        def credential(operation, secret=None):
            calls.append(operation)
            if operation == "provision":
                self.assertEqual(secret, bytearray(b"a" * 64))
            if operation == "status":
                return status.pop(0)
        def session(argv, **options):
            self.assertEqual(bytes(options["input"]), b"a" * 64 + b"\n")
            self.assertEqual(options["stdout"], subprocess.DEVNULL)
            self.assertEqual(options["stderr"], subprocess.DEVNULL)
            self.assertNotIn("a" * 64, json.dumps([argv, options["env"]]))
            self.assertEqual(options["timeout"], 115)
            return types.SimpleNamespace(returncode=0)
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(p, "BASE", root))
            stack.enter_context(mock.patch.object(p, "admission", autospec=True))
            core = stack.enter_context(mock.patch.object(p, "disable_core_dumps", autospec=True))
            binding = stack.enter_context(mock.patch.object(p, "fixture_binding", autospec=True, return_value={"source": "a" * 40}))
            stack.enter_context(mock.patch.object(p.os, "getuid", return_value=0, create=True))
            stack.enter_context(mock.patch.object(p.os, "geteuid", return_value=0, create=True))
            stack.enter_context(mock.patch.object(p.os, "umask", return_value=0o022))
            incoming = stack.enter_context(mock.patch.object(p.os, "fstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=259)))
            stack.enter_context(mock.patch.object(p.os, "stat", return_value=types.SimpleNamespace(st_rdev=259)))
            stack.enter_context(mock.patch.dict(sys.modules, {"pwd": types.SimpleNamespace(getpwnam=lambda _name: account),
                "grp": types.SimpleNamespace(getgrnam=lambda _name: types.SimpleNamespace(gr_gid=27))}))
            groups = stack.enter_context(mock.patch.object(p.os, "getgrouplist", return_value=[p.UID, 27], create=True))
            policy = stack.enter_context(mock.patch.object(p, "admin_config", autospec=True, return_value={"sha256": p.ADMIN_CONFIG_PIN[1]}))
            tools = stack.enter_context(mock.patch.object(p, "credential_tools", autospec=True, return_value={"pinned": True}))
            fixed = stack.enter_context(mock.patch.object(p, "fixture_credential", autospec=True, side_effect=credential))
            once = stack.enter_context(mock.patch.object(b, "write_new", autospec=True))
            saved = stack.enter_context(mock.patch.object(b, "save_json", autospec=True, side_effect=lambda _path, data: receipts.append(copy.deepcopy(data))))
            entropy = stack.enter_context(mock.patch.object(p.secrets, "token_hex", return_value="a" * 64))
            command = stack.enter_context(mock.patch.object(p, "authentication_session_command", autospec=True, return_value=["/usr/bin/systemd-run", "--fixed-test-only"]))
            launched = stack.enter_context(mock.patch.object(p.subprocess, "run", autospec=True, side_effect=session))
            yield types.SimpleNamespace(**locals())

    def test_fixed_root_broker_anonymous_payload_finally_relocks_and_retains_no_secret(self):
        with self.fixture() as f:
            result = p.authenticate_session(f.env)
            f.core.assert_called_once()
            f.entropy.assert_called_once_with(32)
            self.assertEqual(f.calls, ["status", "provision", "status", "lock", "status"])
            f.once.assert_called_once_with(Path("/fixed/authentication-once.json"), json.dumps({"source": "a" * 40, "uid": p.UID}).encode(), 0o600)
            self.assertTrue(result["passwordProvisioned"])
            self.assertTrue(result["fixtureRelocked"])
            self.assertNotIn("a" * 64, json.dumps(f.receipts))
            self.assertEqual(set(f.launched.call_args.kwargs["input"]), {0})
            self.assertTrue(all(result[k] is False for k in p.FLAGS))
            self.assertLess(f.fixed.mock_calls.index(mock.call("status")), f.fixed.mock_calls.index(mock.call("lock")))

    def test_relock_failure_is_retained_statically_and_never_claims_success(self):
        with self.fixture() as f:
            original = f.fixed.side_effect
            def refused(operation, secret=None):
                if operation == "lock":
                    raise RuntimeError("a" * 64)
                return original(operation, secret)
            f.fixed.side_effect = refused
            with self.assertRaises(RuntimeError):
                p.authenticate_session(f.env)
            self.assertFalse(f.receipts[-1]["fixtureRelocked"])
            self.assertEqual(f.receipts[-1]["refusal"]["phase"], "fixture-relock")
            self.assertNotIn("a" * 64, json.dumps(f.receipts))

    def test_provision_or_session_failure_still_relocks_once_with_static_receipt(self):
        for where in ("provision", "session"):
            with self.subTest(where=where), self.fixture() as f:
                if where == "session":
                    f.launched.side_effect = RuntimeError("a" * 64)
                else:
                    original = f.fixed.side_effect
                    def failed(operation, secret=None):
                        if operation == "provision":
                            f.status[:] = ["L"]
                            raise RuntimeError("a" * 64)
                        return original(operation, secret)
                    f.fixed.side_effect = failed
                with self.assertRaises(RuntimeError):
                    p.authenticate_session(f.env)
                self.assertEqual(sum(c.args[0] == "lock" for c in f.fixed.call_args_list), 1)
                self.assertTrue(f.receipts[-1]["fixtureRelocked"])
                self.assertNotIn("a" * 64, json.dumps(f.receipts))
                self.assertEqual(f.receipts[-1]["refusal"]["phase"], "credential-session")
                if where == "provision":
                    f.launched.assert_not_called()

    def test_foreign_account_after_launch_is_not_locked_or_repaired(self):
        with self.fixture() as f:
            def changed(_argv, **_options):
                f.account.pw_uid = 99
                return types.SimpleNamespace(returncode=0)
            f.launched.side_effect = changed
            with self.assertRaises(RuntimeError):
                p.authenticate_session(f.env)
            self.assertNotIn("lock", f.calls)
            self.assertFalse(f.receipts[-1]["fixtureRelocked"])
            self.assertEqual(f.receipts[-1]["refusal"]["phase"], "fixture-relock")

    def test_wrong_mode_stdin_identity_reused_fixture_or_core_refuses_before_entropy(self):
        for change in ("mode", "stdin", "uid", "groups", "used", "core", "once"):
            with self.subTest(change=change), self.fixture() as f:
                if change == "mode":
                    f.env["CREATOR_LINUX_POLKIT_MODE"] = "admin-capture"
                elif change == "stdin":
                    f.incoming.return_value = types.SimpleNamespace(st_mode=stat.S_IFIFO, st_rdev=259)
                elif change == "uid":
                    f.account.pw_uid = 99
                elif change == "groups":
                    f.groups.return_value = [p.UID, 27, 999]
                elif change == "used":
                    f.home.lstat.side_effect = None
                elif change == "core":
                    f.core.side_effect = RuntimeError("core limit refused")
                else:
                    f.once.side_effect = FileExistsError("already used")
                with self.assertRaises((RuntimeError, FileExistsError)):
                    p.authenticate_session(f.env)
                f.entropy.assert_not_called()
                f.launched.assert_not_called()
                self.assertFalse(any(c.args[0] in ("provision", "lock") for c in f.fixed.call_args_list))

    def test_credential_tool_provenance_uses_real_existing_helper_signatures(self):
        targets = {}
        for filename in p.CREDENTIAL_TOOLS:
            target = mock.MagicMock()
            target.__str__.return_value = filename
            target.name = Path(filename).name
            target.resolve.return_value = target
            target.lstat.return_value = types.SimpleNamespace(st_uid=0, st_gid=0, st_nlink=1)
            targets[filename] = target
        def tool(_output, _label, command, allowed=(0,), timeout=15):
            self.assertEqual(timeout, 8)
            return (0, b"passwd\t1:4.8.1-2ubuntu2.2\tamd64\tinstalled\n") if "-W" in command else (0, ("passwd: " + command[-1] + "\n").encode())
        with mock.patch.object(p, "Path", side_effect=lambda name: targets[name]), \
                mock.patch.object(b, "pinned", autospec=True, return_value={"pinned": True}) as pinned, \
                mock.patch.object(b, "run_tool", autospec=True, side_effect=tool) as command:
            self.assertEqual(set(p.credential_tools(Path("/public-receipts"))), set(p.CREDENTIAL_TOOLS))
        self.assertEqual(pinned.call_count, 2)
        self.assertEqual(command.call_count, 4)


class NativeDismissalTests(unittest.TestCase):
    def fixture(self, tree):
        c = b.load_helper().C
        retained = []
        def query(_display, xid, root, parent, children, count):
            record = tree[xid]
            if record == "error":
                return 0
            parent._obj.value, root._obj.value = record[0], 1
            values = record[1]
            count._obj.value = len(values)
            if values:
                data = (c.c_ulong * len(values))(*values)
                retained.append(data)
                c.cast(children, c.POINTER(c.POINTER(c.c_ulong)))[0] = c.cast(data, c.POINTER(c.c_ulong))
            return 1
        x = types.SimpleNamespace(XDefaultRootWindow=lambda _display: 1, XQueryTree=mock.Mock(side_effect=query), XFree=mock.Mock())
        return types.SimpleNamespace(x=x, display=1, sync=mock.Mock()), types.SimpleNamespace(C=c)

    def test_native_server_tree_independently_reports_present_or_absent_without_ewmh(self):
        for present in (True, False):
            tree = {1: (0, [2]), 2: (1, [77] if present else [])}
            if present:
                tree[77] = (2, [])
            x11, helper = self.fixture(tree)
            observed = {}
            result = p.native_window_absence(x11, helper, 77, observed)
            self.assertIs(result, observed)
            self.assertTrue(result["complete"])
            self.assertEqual(result["absent"], not present)
            self.assertEqual(result["nodes"], 3 if present else 2)
            self.assertEqual(x11.x.XQueryTree.call_count, result["nodes"])
            self.assertEqual(x11.x.XFree.call_count, 2 if present else 1)

    def test_unknown_query_error_parent_drift_duplicates_or_inventory_bound_never_mean_dismissed(self):
        for tree in ({1: "error"}, {1: (0, [2]), 2: (99, [])}, {1: (0, [2, 2]), 2: (1, [])},
                     {1: (0, list(range(2, 67)))}):
            x11, helper = self.fixture(tree)
            observed = {}
            with self.subTest(tree=tree), self.assertRaises(RuntimeError):
                p.native_window_absence(x11, helper, 77, observed)
            self.assertFalse(observed["complete"])
            self.assertNotIn("absent", observed)

    def test_native_x_error_is_not_swallowed_as_a_destroyed_window(self):
        x11, helper = self.fixture({1: (0, [])})
        x11.sync.side_effect = RuntimeError("X resource query refused")
        observed = {}
        with self.assertRaises(RuntimeError):
            p.native_window_absence(x11, helper, 77, observed)
        self.assertFalse(observed["complete"])
        self.assertNotIn("absent", observed)


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
        self.assertIn(p.ADMIN_BRANCH, job["if"])
        self.assertNotIn("container", job)
        self.assertFalse(job["steps"][0]["with"]["persist-credentials"])

    def test_actual_skipped_admin_dispatch_regression_and_full_ref_event_mode_matrix(self):
        cases, expected, envs = [], [], []
        for ref in (p.BRANCH, p.ADMIN_BRANCH, "refs/heads/main"):
            for event in ("push", "workflow_dispatch", "pull_request"):
                for mode in (None, "read-only", "cancel", "admin-capture", "authenticate"):
                    effective = mode or "read-only"
                    allowed = (ref == p.BRANCH and ((event == "push" and effective == "read-only")
                        or (event == "workflow_dispatch" and effective in ("read-only", "cancel")))) \
                        or (ref == p.ADMIN_BRANCH and event == "workflow_dispatch" and effective in ("admin-capture", "authenticate"))
                    env = runner() | {"GITHUB_REF": ref, "GITHUB_EVENT_NAME": event}
                    if mode is not None:
                        env["CREATOR_LINUX_POLKIT_MODE"] = mode
                    context = {"github": {"repository": "BOBWORKS-XR/CREATOR-HUB", "repository_id": "1364807512", "ref": ref, "event_name": event},
                               "inputs": {} if mode is None else {"mode": mode}}
                    cases.append(context)
                    expected.append(allowed)
                    envs.append(env)
                    with self.subTest(ref=ref, event=event, mode=mode):
                        if allowed:
                            p.admission(env, "linux", "x86_64")
                        else:
                            with self.assertRaises(RuntimeError):
                                p.admission(env, "linux", "x86_64")
        for change in ({"repository": "foreign/repo"}, {"repository_id": "1"}):
            cases.append({"github": {"repository": "BOBWORKS-XR/CREATOR-HUB", "repository_id": "1364807512", "ref": p.ADMIN_BRANCH,
                                     "event_name": "workflow_dispatch", **change}, "inputs": {"mode": "admin-capture"}})
            expected.append(False)
        script = r"""
        const fs=require('node:fs'),vm=require('node:vm'),d=JSON.parse(fs.readFileSync(0,'utf8'));
        process.stdout.write(JSON.stringify(d.cases.map(c=>vm.runInNewContext(d.expression,c,{timeout:1000}))));
        """
        result = subprocess.run([shutil.which("node") or "node", "-e", script], input=json.dumps({
            "expression": self.workflow["jobs"]["contract"]["if"], "cases": cases}).encode(),
            capture_output=True, check=True, timeout=15)
        self.assertEqual(json.loads(result.stdout), expected)
        step = next(s for s in self.workflow["jobs"]["contract"]["steps"] if s.get("name") == "Secure only established hosted-runner policy ancestry")
        body = step["run"]
        guard = body[body.index('case "$GITHUB_REF:'):body.index("\nesac") + len("\nesac")]
        bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path("/usr/bin/bash")
        for env, allowed in zip(envs, expected):
            # Execute ONLY the case guard; no provisioning/native statements.
            child_env = {k: os.environ[k] for k in ("PATH", "SystemRoot") if k in os.environ}
            child_env.update({"GITHUB_REF": env["GITHUB_REF"], "GITHUB_EVENT_NAME": env["GITHUB_EVENT_NAME"],
                              "CREATOR_LINUX_POLKIT_MODE": env.get("CREATOR_LINUX_POLKIT_MODE", "read-only")})
            checked = subprocess.run([str(bash), "-c", guard], env=child_env, capture_output=True, timeout=10)
            with self.subTest(shell=child_env["GITHUB_REF"], event=child_env["GITHUB_EVENT_NAME"], mode=child_env["CREATOR_LINUX_POLKIT_MODE"]):
                self.assertEqual(checked.returncode, 0 if allowed else 1, checked.stderr.decode(errors="replace"))

    def test_cancel_is_explicit_dispatch_choice_not_automatic_push_or_authentication(self):
        choice = self.workflow["on"]["workflow_dispatch"]["inputs"]["mode"]
        self.assertEqual(choice, {"description": "Read-only capture, one Cancel, or explicit synthetic-admin authentication (never updater)",
            "type": "choice", "required": True, "default": "read-only", "options": ["read-only", "cancel", "admin-capture", "authenticate"]})
        self.assertEqual(self.workflow["jobs"]["contract"]["env"]["CREATOR_LINUX_POLKIT_MODE"], "${{ inputs.mode || 'read-only' }}")
        text = WORKFLOW.read_text()
        self.assertIn('cancel|admin-capture) test "$GITHUB_EVENT_NAME" = workflow_dispatch', text)
        self.assertIn('--setenv=CREATOR_LINUX_POLKIT_MODE="$CREATOR_LINUX_POLKIT_MODE"', text)

    def test_authenticate_uses_fixed_root_broker_with_empty_sudo_stdin_and_explicit_retention(self):
        text = WORKFLOW.read_text()
        self.assertIn('authenticate) test "$GITHUB_EVENT_NAME" = workflow_dispatch && test "$GITHUB_REF" = refs/heads/validation/linux-polkit-admin-014', text)
        self.assertIn('authenticate-session </dev/null', text)
        self.assertIn('sudo -n /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C', text)
        self.assertIn('passwd=1:4.8.1-2ubuntu2.2', text)
        self.assertIn('polkit-capture/authentication-provision.json', text)
        self.assertIn('--property=LimitCORE=0', text)
        for forbidden in ('sudo -S', 'set -x', 'PASSWORD=', '::add-mask::', 'tee ', 'env |'):
            self.assertNotIn(forbidden, text)
        source = (HERE / 'native-linux-polkit-probe.py').read_text()
        self.assertIn('native_output = subprocess.DEVNULL if authenticating else subprocess.PIPE', source)
        self.assertIn('agent_log = None if authenticating else b.Capture', source)
        self.assertIn('request_log = None if authenticating else b.Capture', source)
        self.assertIn('"phase": "native-authentication", "message": "Synthetic authentication refused; no retry"', source)
        self.assertIn('if record["mode"] == "authenticate" else', source)
        self.assertNotIn('print(secret', source)
        self.assertNotIn('print(payload', source)

    def test_admin_membership_preparation_is_after_fresh_creation_and_only_for_admin_capture(self):
        text = WORKFLOW.read_text()
        block = 'if test "$CREATOR_LINUX_POLKIT_MODE" = admin-capture || test "$CREATOR_LINUX_POLKIT_MODE" = authenticate; then\n            python3 -B scripts/native-linux-polkit-probe.py prepare-admin-capture\n          fi'
        self.assertEqual(text.count("prepare-admin-capture"), 1)
        self.assertIn(block, text)
        self.assertLess(text.index("Synthetic fixture identity already exists"), text.index("sudo useradd"))
        self.assertLess(text.index("sudo useradd"), text.index(block))
        self.assertLess(text.index(block), text.index("sudo systemd-run"))
        self.assertIn("polkit-admin-group-preflight.json", text)
        for suffix in ("json", "stdout", "stderr"):
            self.assertIn("${{ runner.temp }}/admin-capture-freshness." + suffix, text)
        source = (HERE / "native-linux-polkit-probe.py").read_text()
        admin_branch = source.split('if record["mode"] == "admin-capture":\n            record["adminIdentityObservation"]', 1)[1].split('if record["mode"] in ("cancel", "authenticate"):', 1)[0]
        self.assertNotIn("cancel_once", admin_branch)
        self.assertNotIn(".do_action(", admin_branch)
        self.assertNotIn("pw_passwd", source)

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
        ast.parse(p.FRESHNESS_CHECK)
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
        self.assertEqual(run_count, 8)
        self.assertEqual(python_count, 2)
        command = p.authentication_session_command(SecretTransportTests().env())
        checked = subprocess.run([str(bash), "-n"], input=command[-1].encode(), capture_output=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr.decode(errors="replace"))

    def test_source_has_only_explicit_authentication_no_agent_signals_or_product_install(self):
        source = (HERE / "native-linux-polkit-probe.py").read_text()
        for forbidden in (".send_signal(", ".terminate(", ".kill(",
                          "os.kill(", "shell=True", "stdin.write", "input(", "getspnam", "open('/etc/shadow", "helper.perform(",
                          "WM_DELETE_WINDOW", "b.install(", "execute_script", "__TAURI_INTERNALS__"):
            self.assertFalse(forbidden in source, forbidden)
        self.assertEqual(source.count(".do_action("), 2)
        self.assertEqual(source.count("get_action_iface("), 2)
        self.assertEqual(source.count("get_editable_text_iface("), 1)
        self.assertEqual(source.count(".set_text_contents("), 1)
        self.assertIn('if record["mode"] in ("cancel", "authenticate"):', source)
        self.assertIn('"original-gtk-contract.json"', source)
        self.assertIn('sensitive = role == atspi.Role.PASSWORD_TEXT', source)
        self.assertIn('"sessionTeardownRequired"] = True', source)
        self.assertIn("signal.alarm(60)", source)
        self.assertIn("system-files-observation.json", WORKFLOW.read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
