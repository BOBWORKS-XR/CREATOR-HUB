"""Portable parser/ownership-contract tests; never launches GUI or installs tools."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("activation_fixture", HERE / "native-linux-flatpak-activation.py")
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
ENV = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
       "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": M.BRANCH,
       "CREATOR_FLATPAK_ACTIVATION_TEST": "1", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": "a" * 40,
       "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}


def tree():
    return [{"role": "alert", "name": "Information", "showing": True, "enabled": True},
            *[{"role": "label", "name": text, "showing": True, "enabled": True} for text in ("Open native Creator Hub?", M.disclosure())],
            *[{"role": "push button", "name": text, "showing": True, "enabled": True} for text in ("Cancel", "Get Native Hub", "Open Creator Hub")]]


class ActivationTests(unittest.TestCase):
    def test_exact_opt_in_manual_or_scoped_bootstrap(self):
        for event in ("push", "workflow_dispatch"):
            M.admission({**ENV, "GITHUB_EVENT_NAME": event}, "linux", "x86_64")
        for key in ENV:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: "wrong"}, "linux", "x86_64")

    def test_non_native_refusal_precedes_io_or_process_launch(self):
        with patch.dict(M.os.environ, ENV, clear=True), patch.object(M.sys, "platform", "win32"), \
                patch.object(M, "locations") as locate, patch.object(M.P, "helpers") as helpers, \
                patch.object(M.subprocess, "Popen") as launch:
            with self.assertRaises(RuntimeError):
                M.main()
            locate.assert_not_called(); helpers.assert_not_called(); launch.assert_not_called()

    def test_other_platform_arch_and_injection_refused(self):
        for system, arch in (("win32", "x86_64"), ("linux", "i686"), ("linux", "aarch64"), ("darwin", "x86_64")):
            with self.subTest(system=system), self.assertRaises(RuntimeError):
                M.admission(ENV, system, arch)
        for key in ("FLATPAK_ID", "LD_PRELOAD", "TAURI_WEBVIEW_AUTOMATION", "WEBKIT_INSPECTOR_SERVER", "PYTHONPATH", "NODE_OPTIONS", "BASH_ENV", "SSL_CERT_FILE"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: "refuse"}, "linux", "x86_64")

    def test_private_environment_is_built_before_dbus_without_credentials(self):
        root = Path("/owned/fixture")
        result = M.clean_environment(root, {**ENV, "GH_TOKEN": "never", "GITHUB_TOKEN": "never", "AWS_SECRET_ACCESS_KEY": "never", "HOME": "/real/profile", "http_proxy": "never"})
        self.assertFalse(set(result) & {"GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "http_proxy"})
        self.assertEqual(result["HOME"], str(root / "home"))
        self.assertEqual(result["FLATPAK_USER_DIR"], str(root / "installation"))
        self.assertEqual(result["XDG_CONFIG_HOME"], str(root / "home/config"))

    def test_source_bound_disclosure_is_explicit_about_scope(self):
        text = M.disclosure()
        for part in ("outside the Flatpak sandbox", "existing host settings", "DEB installation", "cannot install", "SteamOS"):
            self.assertIn(part, text)

    def test_only_exact_cancel_and_open_buttons_are_authorized(self):
        for action in ("Cancel", "Open Creator Hub"):
            index = M.dialog_contract(tree(), M.disclosure(), action)
            self.assertEqual(tree()[index]["name"], action)
        for action in ("Get Native Hub", "Accept", "", "Open"):
            with self.subTest(action=action), self.assertRaises(RuntimeError):
                M.dialog_contract(tree(), M.disclosure(), action)

    def test_ambiguous_foreign_disabled_or_incomplete_disclosure_rejects(self):
        variants = []
        for i, field, value in ((0, "role", "frame"), (1, "name", "Different question"), (2, "name", "Different risks"),
                                (5, "enabled", False), (5, "showing", False), (4, "name", "Open Creator Hub")):
            nodes = tree(); nodes[i][field] = value; variants.append(nodes)
        variants.extend([tree() + [tree()[1]], tree() + [{"role": "dialog", "name": "foreign"}], tree() * 9, []])
        for nodes in variants:
            with self.subTest(nodes=len(nodes)), self.assertRaises(RuntimeError):
                M.dialog_contract(nodes, M.disclosure(), "Open Creator Hub")

    def test_window_inventory_is_bounded_and_empty_is_not_a_failure(self):
        class X:
            display = None
            x = type("Display", (), {"XDefaultRootWindow": lambda _: 1})
            value = None
            def property(self, *args):
                return self.value
        x = X()
        self.assertEqual(M.empty_windows(x), [])
        x.value = (33, 32, [7]); self.assertEqual(M.empty_windows(x), [7])
        for value in ((33, 32, [7, 7]), (33, 32, list(range(9))), (6, 32, [7])):
            x.value = value
            with self.assertRaises(RuntimeError):
                M.empty_windows(x)

    def test_settings_snapshot_detects_even_semantically_equal_rewrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config, files = M.P.fixtures(root, root / "real-server.mjs")
            M.P.save(root / "fixtures.json", {"config": config, "files": files})
            self.assertEqual(M.snapshot_fixtures(root), files)
            path = root / "home" / M.P.CONFIG
            path.write_text(json.dumps(config, separators=(",", ":")), encoding="utf8")
            with self.assertRaises(RuntimeError):
                M.snapshot_fixtures(root)

    def stage_case(self, duplicate=False, extra=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        temp = Path(directory.name).resolve()
        package, server = b"package-fixture", b"server-fixture"
        digest = lambda value: {"size": len(value), "sha256": hashlib.sha256(value).hexdigest()}
        archive = temp / "flatpak-activation-input.zip"
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("native-packages/Creator Hub_0.1.14_amd64.deb", package)
            zipped.writestr("modules/mcp/server/creator-works-mcp.mjs", server)
            if duplicate:
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    zipped.writestr("modules/mcp/server/creator-works-mcp.mjs", server)
            if extra:
                item = zipfile.ZipInfo(extra)
                item.filename = extra
                zipped.writestr(item, b"not-extracted")
        with patch.dict(M.os.environ, {"RUNNER_TEMP": str(temp)}), patch.object(M.P, "pinned"), \
                patch.object(M, "PACKAGE", digest(package)), patch.object(M, "SERVER", digest(server)), \
                patch.object(M.os, "getuid", return_value=0, create=True):
            M.stage()
        return temp / "flatpak-activation"

    def test_stage_selects_only_two_inputs_and_creates_fresh_fixtures(self):
        root = self.stage_case(extra="unselected/safe.txt")
        self.assertEqual((root / "native.deb").read_bytes(), b"package-fixture")
        self.assertFalse((root / "unselected").exists())
        self.assertFalse((root / "home/data/CreatorHub/consent/hub-usage-terms.json").exists())
        self.assertFalse(M.P.parse((root / "fixtures.json").read_bytes())["config"]["auto_start"])

    def test_stage_refuses_duplicate_and_traversal_members(self):
        with self.assertRaises(RuntimeError):
            self.stage_case(duplicate=True)
        for name in ("../escape", "/absolute", "a\\b", "a/./b", "C:/redirect"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                self.stage_case(extra=name)

    def test_producer_pins_match_actual_current_direct_pages_workflow(self):
        pages = (HERE.parent / ".github/workflows/native-linux-integrated-pages.yml").read_text()
        workflow = (HERE.parent / ".github/workflows/native-linux-flatpak-activation.yml").read_text()
        for pin in (M.SOURCE, M.PACKAGE["sha256"], M.HUB["sha256"], M.SERVER["sha256"], M.ZIP["sha256"],
                    "39130359610", "12137857868", "117684180444", str(M.ZIP["size"])):
            self.assertIn(pin, pages)
            self.assertIn(pin, workflow if pin != M.SERVER["sha256"] else (HERE / "native-linux-flatpak-activation.py").read_text())
        for check in ("run.conclusion,'success'", "artifact.workflow_run.head_sha,source", "artifact.digest", "workflow_run.head_repository_id,1364807512"):
            self.assertIn(check, workflow)

    def test_workflow_keeps_validation_finite_and_explicit(self):
        source = (HERE.parent / ".github/workflows/native-linux-flatpak-activation.yml").read_text()
        self.assertIn("branches: [validation/linux-flatpak-activation]", source)
        self.assertEqual(source.count("      - scripts/native-linux-flatpak-activation."), 2)
        self.assertIn("contents: read", source); self.assertNotIn("contents: write", source)
        self.assertLess(source.index("remote-info --show-commit"), source.index("flatpak --user install"))
        self.assertLess(source.index("--show-commit \"${query[0]}\""), source.index("flatpak-builder --user"))
        for bad in ("gh release", "release:launcher", "build:unified", "--filesystem=home", "--socket=session-bus", "--allow=devel", "--host"):
            self.assertNotIn(bad, source)

    def test_no_generic_permission_expansion_and_no_webkit_ax_tree(self):
        source = (HERE / "native-linux-flatpak-activation.py").read_text()
        self.assertEqual(source.count("action.do_action(0)"), 1)
        self.assertIn('phase in', source.replace('sys.argv[2] in', 'phase in'))
        for bad in ("RootOwnership", "WEBKIT_SHA", "helper.button(", "helper.click(", "--command=", "flatpak-spawn", "/execute"):
            self.assertNotIn(bad, source)
        self.assertIn("len(objects) < 48", source)
        self.assertIn('x11.close_window(', source)
        self.assertLess(source.index('close_root(warm,'), source.index('d.call("DELETE", "")'))
        self.assertIn('"rootExitCode": None', source)
        self.assertTrue(all(value is False for value in M.GATES.values()))

    def test_ci_service_setup_only_tightens_exact_root_owned_ancestors(self):
        workflow = (HERE.parent / ".github/workflows/native-linux-flatpak-activation.yml").read_text()
        start = workflow.index("          import os,stat,subprocess\n")
        block = workflow[start:workflow.index("          PY\n", start)]
        tree = ast.parse("\n".join(line[10:] for line in block.splitlines()))
        tree.body = [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
        program = compile(tree, "exact-ci-service-setup", "exec")
        paths = ('/', '/usr', '/usr/share', '/usr/share/dbus-1', '/usr/share/dbus-1/services')

        def run(changed=None, replace_inode=False):
            records = {name: SimpleNamespace(st_uid=0, st_gid=0, st_dev=1, st_ino=i,
                st_mode=stat.S_IFDIR | (0o755 if i < 2 else 0o777)) for i, name in enumerate(paths)}
            if changed:
                name, key, value = changed
                setattr(records[name], key, value)
            calls = []

            class FakePath:
                def __init__(self, text):
                    self.text = text
                def resolve(self):
                    return self
                def lstat(self):
                    return copy.copy(records[self.text])

            def chmod(args, check):
                self.assertTrue(check)
                self.assertEqual(args[:4], ['/usr/bin/sudo', '-n', '/usr/bin/chmod', '0755'])
                self.assertIn(args[4], paths[2:])
                calls.append(args[4])
                records[args[4]].st_mode = stat.S_IFDIR | 0o755
                if replace_inode:
                    records[args[4]].st_ino += 1

            exec(program, {'os': SimpleNamespace(environ=ENV), 'stat': stat, 'Path': FakePath,
                           'subprocess': SimpleNamespace(run=chmod), 'print': lambda *a, **kw: None})
            return calls

        self.assertEqual(run(), list(paths[2:]))
        for changed in (('/', 'st_mode', stat.S_IFDIR | 0o777), ('/usr/share', 'st_uid', 1000),
                        ('/usr/share/dbus-1', 'st_gid', 1000), ('/usr/share/dbus-1/services', 'st_mode', stat.S_IFDIR | 0o775),
                        ('/usr/share/dbus-1/services', 'st_mode', stat.S_IFLNK | 0o777)):
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                run(changed)
        with self.assertRaises(AssertionError):
            run(replace_inode=True)

    def test_python310_syntax(self):
        ast.parse((HERE / "native-linux-flatpak-activation.py").read_text(), feature_version=(3, 10))


if __name__ == "__main__":
    unittest.main()
