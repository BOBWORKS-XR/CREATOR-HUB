"""Portable parser/ownership-contract tests; never launches GUI or installs tools."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
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
        self.assertEqual(M.BRANCH, "refs/heads/validation/linux-flatpak-activation-next")
        for event in ("push", "workflow_dispatch"):
            M.admission({**ENV, "GITHUB_EVENT_NAME": event}, "linux", "x86_64")
        with self.assertRaises(RuntimeError):
            M.admission({**ENV, "GITHUB_REF": "refs/heads/validation/linux-flatpak-activation"}, "linux", "x86_64")
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
                    "39134487363", "12139109123", "117696169938", str(M.ZIP["size"])):
            self.assertIn(pin, pages)
            self.assertIn(pin, workflow if pin != M.SERVER["sha256"] else (HERE / "native-linux-flatpak-activation.py").read_text())
        for check in ("run.conclusion,'success'", "artifact.workflow_run.head_sha,source", "artifact.digest", "workflow_run.head_repository_id,1364807512"):
            self.assertIn(check, workflow)

    def test_workflow_keeps_validation_finite_and_explicit(self):
        source = (HERE.parent / ".github/workflows/native-linux-flatpak-activation.yml").read_text()
        self.assertIn("branches: [validation/linux-flatpak-activation-next]", source)
        self.assertIn("github.ref == '" + M.BRANCH + "'", source)
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

    def test_real_packager_receives_single_link_snapshot_of_hardlinked_build(self):
        workflow = (HERE.parent / ".github/workflows/native-linux-flatpak-activation.yml").read_text()
        script = workflow.split("          node - <<'NODE'\n", 1)[1].split("          NODE\n", 1)[0]
        script = "\n".join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory).resolve()
            root = temp / 'flatpak-activation'
            compiled = root / 'launcher-build/release/creator-hub-flatpak-activate'
            compiled.parent.mkdir(parents=True)
            raw = bytearray(64)
            raw[:7] = bytes([127, 69, 76, 70, 2, 1, 1]); raw[16] = 3; raw[18] = 62
            compiled.write_bytes(raw)
            os.link(compiled, compiled.parent / 'cargo-output-alias')
            self.assertEqual(compiled.stat().st_nlink, 2)
            result = subprocess.run(['node', '-'], input=script, text=True, capture_output=True, timeout=15,
                cwd=HERE.parent, env={**os.environ, 'RUNNER_TEMP': str(temp), 'GITHUB_SHA': 'a' * 40})
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            snapshot = root / 'launcher-input'
            self.assertEqual(snapshot.stat().st_nlink, 1)
            self.assertEqual(snapshot.read_bytes(), raw)
            self.assertEqual(compiled.stat().st_nlink, 2)
            staged = root / 'stage/flatpak-input/bin/creator-hub-flatpak-activate'
            self.assertEqual(staged.read_bytes(), raw)
            self.assertEqual(M.P.parse((root / 'launcher-input.json').read_bytes())['compiled']['nlink'], 2)
            captured = M.P.parse((root / 'launcher-compiled-stat.json').read_bytes())
            self.assertEqual((captured['nlink'], captured['size'], captured['regular']), (2, len(raw), True))
            self.assertLess(script.index("'launcher-compiled-stat.json'"), script.index('assert.ok(before.isFile()'))

    def test_actual_exported_sections_parser_rejects_malformed_duplicate_and_overflow(self):
        script = r"""
        const assert=require('node:assert/strict'),p=require('./scripts/flatpak-disposable.cjs');
        assert.equal(typeof p.parseSections,'function');
        assert.deepEqual(p.parseSections('[Application]\nname=com.creatorworks.hub\n'),{Application:{name:'com.creatorworks.hub'}});
        for(const input of ['key=value\n','[Application]\nmissing-separator\n','[Application]\n=value\n',
          '[Application]\n[Application]\n','[Context]\nsockets=wayland;\nsockets=fallback-x11;\n',
          '[Context]\nvalue='+'x'.repeat(65536),'[Context]\nvalue='+'\u00e9'.repeat(32768)])
          assert.throws(()=>p.parseSections(input));
        """
        result = subprocess.run(['node', '-'], input=script, text=True, capture_output=True, timeout=15, cwd=HERE.parent)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

    def test_actual_installed_metadata_block_executes_with_real_exported_parser(self):
        workflow = (HERE.parent / ".github/workflows/native-linux-flatpak-activation.yml").read_text()
        script = workflow.split("          node - <<'NODE'\n")[2].split("          NODE\n", 1)[0]
        script = "\n".join(line[10:] for line in script.splitlines())
        context = '[Context]\nsockets=fallback-x11;wayland;\n'
        policy = '[Session Bus Policy]\ncom.creatorworks.hub.Host=talk\n'
        metadata = ('[Application]\nname=com.creatorworks.hub\nruntime=org.gnome.Platform/x86_64/50\n'
                    'sdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub-flatpak-activate\n\n' + context + '\n' + policy)
        permissions = context + '\n' + policy
        cases = [('captured-format', metadata, permissions, 'b' * 64, True),
                 ('implicit-x11', metadata, permissions.replace('fallback-x11;wayland;', 'fallback-x11;wayland;x11;'), 'b' * 64, True),
                 ('duplicate-section', metadata + '\n[Application]\n', permissions, 'b' * 64, False),
                 ('duplicate-key', metadata, permissions.replace('sockets=', 'sockets=wayland;\nsockets='), 'b' * 64, False),
                 ('malformed', metadata, permissions + '\nmalformed\n', 'b' * 64, False),
                 ('overflow', metadata + '#' + 'x' * 65536, permissions, 'b' * 64, False),
                 ('foreign-command', metadata.replace('command=creator-hub-flatpak-activate', 'command=foreign'), permissions, 'b' * 64, False),
                 ('foreign-runtime', metadata.replace('Platform/x86_64/50', 'Platform/x86_64/49'), permissions, 'b' * 64, False),
                 ('broad-filesystem', metadata, permissions.replace('[Context]\n', '[Context]\nfilesystems=home;\n'), 'b' * 64, False),
                 ('network', metadata, permissions.replace('[Context]\n', '[Context]\nshared=network;\n'), 'b' * 64, False),
                 ('foreign-bus', metadata, permissions.replace('com.creatorworks.hub.Host=talk', 'org.example.Foreign=talk'), 'b' * 64, False),
                 ('system-bus', metadata, permissions + '\n[System Bus Policy]\norg.example.Foreign=talk\n', 'b' * 64, False),
                 ('bad-commit', metadata, permissions, 'unknown', False)]
        for name, meta, perms, commit, accepted in cases:
            with self.subTest(case=name), tempfile.TemporaryDirectory() as directory:
                temp = Path(directory).resolve(); root = temp / 'flatpak-activation'
                (root / 'stage').mkdir(parents=True)
                (root / 'installed-metadata.txt').write_text(meta, encoding='utf8')
                (root / 'installed-permissions.txt').write_text(perms, encoding='utf8')
                (root / 'installed-commit.txt').write_text(commit + '\n', encoding='utf8')
                provenance = {'launcherSha256': 'a' * 64, 'launcherSize': 596584, 'sourceCommit': 'c' * 40}
                (root / 'stage/flatpak-native-activation-stage.json').write_text(json.dumps({'provenance': provenance}), encoding='utf8')
                result = subprocess.run(['node', '-'], input=script, text=True, capture_output=True, timeout=15,
                    cwd=HERE.parent, env={**os.environ, 'RUNNER_TEMP': str(temp)})
                binding = root / 'launcher-binding.json'
                if accepted:
                    self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                    receipt = M.P.parse(binding.read_bytes())
                    self.assertEqual(receipt, {'commit': commit, 'sha256': 'a' * 64, 'size': 596584,
                        'sourceCommit': 'c' * 40, 'permissions': ['--socket=wayland', '--socket=fallback-x11', '--talk-name=com.creatorworks.hub.Host'],
                        'publisherSignatureAccepted': False, 'releaseReady': False})
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(binding.exists())

    def identity_case(self, role=None, field=None, value=None, inspection_error=False):
        context = {name: {'pid': pid, 'startTime': '10', 'parentPid': 1, 'uids': [1001] * 4,
            'executable': '/usr/bin/flatpak' if name == 'cli' else '/app/bin/creator-hub-flatpak-activate',
            'image': {'st_ino': '100', 'st_ctime_ns': '20'}, 'kernelImageSha256': 'a' * 64}
            for name, pid in (('cli', 123), ('launcher', 124))}
        observed = {entry['pid']: {key: copy.deepcopy(val) for key, val in entry.items() if key != 'kernelImageSha256'}
                    for entry in context.values()}
        if role:
            target = observed[context[role]['pid']]
            if field.startswith('image.'):
                target['image'][field.split('.', 1)[1]] = value
            else:
                target[field] = value
        calls, actions = [], []
        def capture(pid, helper, full):
            self.assertIs(full, False)
            calls.append(pid)
            if inspection_error and pid == 124:
                raise RuntimeError('private diagnostic message must not be logged')
            return observed[pid]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def guarded_action():
                M.stable_pair(SimpleNamespace(native_process=capture), None, context, root, 'cancel')
                actions.append('click')
            if role:
                with self.assertRaisesRegex(RuntimeError, '^Owned process identity changed$'):
                    guarded_action()
                self.assertEqual(actions, [])
                report = M.P.parse((root / 'cancel-identity-refusal.json').read_bytes())
                self.assertTrue(all(report[key] is False for key in M.GATES))
                return report, calls
            guarded_action()
            self.assertEqual(actions, ['click'])
            self.assertFalse((root / 'cancel-identity-refusal.json').exists())
            return None, calls

    def test_identity_diagnostic_captures_cli_transition_and_still_refuses_before_action(self):
        report, calls = self.identity_case('cli', 'executable', '/usr/bin/bwrap')
        self.assertEqual(report['failedRole'], 'cli')
        self.assertEqual(report['records']['cli']['changes'], [{'field': 'executable',
            'expected': '/usr/bin/flatpak', 'actual': '/usr/bin/bwrap'}])
        self.assertEqual(report['records']['launcher']['changes'], [])
        self.assertEqual(calls, [123, 124])

    def test_identity_diagnostic_captures_launcher_image_stamp_and_unchanged_cli(self):
        report, calls = self.identity_case('launcher', 'image.st_ctime_ns', '21')
        self.assertEqual(report['failedRole'], 'launcher')
        self.assertEqual(report['records']['launcher']['changes'], [{'field': 'image.st_ctime_ns', 'expected': '20', 'actual': '21'}])
        self.assertEqual(report['records']['cli']['changes'], [])
        self.assertEqual(calls, [123, 124, 123])

    def test_identity_diagnostic_bounds_values_and_does_not_log_unknown_fields(self):
        report, _ = self.identity_case('cli', 'executable', '/' + 'x' * 12000)
        self.assertLess(len(json.dumps(report)), 24576)
        self.assertEqual(report['records']['cli']['changes'][0]['actual']['jsonLength'], 12003)
        delta = M.identity_deltas({'pid': 123, 'unexpected': 'private data'}, {'pid': 123})
        self.assertTrue(delta['recordShapeChanged'])
        self.assertNotIn('private data', json.dumps(delta))
        report, _ = self.identity_case('cli', 'executable', '/usr/bin/bwrap', inspection_error=True)
        self.assertEqual(report['records']['launcher']['inspectionError'], 'RuntimeError')
        self.assertNotIn('private diagnostic', json.dumps(report))

    def test_unchanged_identity_keeps_original_hash_exclusion_and_writes_no_diagnostic(self):
        _, calls = self.identity_case()
        self.assertEqual(calls, [123, 124])

    def test_bootstrap_freezes_only_after_native_mapping_before_worker_with_existing_input_guards(self):
        source = (HERE / 'native-linux-flatpak-activation.py').read_text()
        self.assertLess(source.index('bwrap = protected_bwrap(native)'), source.index('cli = launch(["/usr/bin/flatpak"'))
        self.assertLess(source.index('require(properties["mapped"]'), source.index('bootstrap.freeze(after)'))
        self.assertLess(source.index('bootstrap.freeze(after)'), source.index('"cli": frozen_cli'))
        worker = source[source.index('def gtk_worker'):source.index('def exercise')]
        self.assertLess(worker.index('check()\n'), worker.index('native.native_ax_references()'))
        self.assertIn('stable_pair(native, helper, context, root, phase)', worker)
        self.assertIn('reported_pid == peer["pid"]', worker)
        self.assertIn('if app.get_process_id() in peers:', worker)
        self.assertLess(worker.index('report["lastAxReference"]'), worker.index('require(peer["pid"] in peers'))
        self.assertIn('report["kernelNamespacePids"] = ids', worker)
        self.assertIn('peer["pid"] in peers and peer["uid"] == os.getuid()', worker)
        self.assertEqual(worker.count('action.do_action(0)'), 1)

    def gtk_peer_case(self, peer=None, reported_pid=8859, replace_owner_at=None, replaced_image=False,
                      capture_only=False, changed_window=False):
        controller, caller = 8752, 1001
        records = {pid: {'pid': pid, 'startTime': str(pid), 'parentPid': parent, 'uids': [caller] * 4,
            'executable': executable, 'image': {'st_ino': str(pid), 'st_size': '100'},
            'kernelImageSha256': 'a' * 64} for pid, parent, executable in (
                (8844, controller, M.BWRAP), (8859, 8844, M.PROXY),
                (8862, 8844, '/app/bin/creator-hub-flatpak-activate'))}
        context = {'controller': controller, 'cli': records[8844], 'launcher': records[8862],
            'proxies': [records[8859]], 'window': 7,
            'xres': {'pid': 8862, 'mapped': True, 'title': 'Creator Hub'}, 'action': 'Cancel'}
        peer = peer or {'owner': ':1.42', 'pid': reported_pid, 'uid': caller}
        resolutions, clicks, saves = [], [], []
        text = M.disclosure()
        state = SimpleNamespace(contains=lambda _: True)
        action = SimpleNamespace(get_n_actions=lambda: 1, get_action_name=lambda _: 'click',
            do_action=lambda _: clicks.append('Cancel') or True)
        rectangle = SimpleNamespace(x=10, y=20, width=400, height=240)

        def node(index, role, name):
            return SimpleNamespace(app=SimpleNamespace(bus_name='org.example.Owned'),
                path=f'/org/a11y/accessible/{index}', get_process_id=lambda: reported_pid,
                get_role=lambda: role, get_role_name=lambda: role, get_name=lambda: name,
                clear_cache=lambda: None, get_state_set=lambda: state, get_action_iface=lambda: action,
                get_component_iface=lambda: SimpleNamespace(get_extents=lambda _: rectangle))

        application = node('root', 'application', 'creator-hub-flatpak-activate')
        foreign = node('foreign', 'application', 'creator-hub')
        foreign.get_process_id = lambda: 8768
        foreign.app.bus_name = 'org.example.Foreign'
        nodes = [node(index, item['role'], item['name']) for index, item in enumerate(tree())]
        desktop = object()
        def children(parent, bound):
            result = [foreign, application] if parent is desktop else [nodes[0]] if parent is application else nodes[1:] if parent is nodes[0] else []
            self.assertLessEqual(len(result), bound)
            return result

        def resolve(name):
            self.assertEqual(name, 'org.example.Owned')
            resolutions.append(name)
            result = copy.deepcopy(peer)
            if replace_owner_at is not None and len(resolutions) >= replace_owner_at:
                result['owner'] = ':1.43'
            return result

        def native_process(pid, helper, full=False):
            result = copy.deepcopy(records[pid])
            if replaced_image and pid == 8859:
                result['image']['st_ino'] = 'replaced'
            if not full:
                result.pop('kernelImageSha256')
            return result

        x11 = SimpleNamespace(inspect=lambda _: {**context['xres'], **({'pid': 9999} if changed_window else {})},
            frame_rectangle=lambda _: (10, 20, 400, 240), dispose=lambda: None)
        native = SimpleNamespace(native_process=native_process,
            native_ax_references=lambda: (SimpleNamespace(resolve=resolve), SimpleNamespace(close_sync=lambda _: None)))
        helper = SimpleNamespace(X11=lambda: x11, children=children)
        atspi = SimpleNamespace(init=lambda: None, set_timeout=lambda *args: None, get_desktop=lambda _: desktop,
            Role=SimpleNamespace(ALERT='alert'), StateType=SimpleNamespace(SHOWING=1, ENABLED=2),
            CoordType=SimpleNamespace(SCREEN=0))
        modules = {'gi': SimpleNamespace(require_version=lambda *args: None), 'gi.repository': SimpleNamespace(Atspi=atspi)}
        def read(path):
            if str(path).replace('\\', '/') == '/proc/8862/status':
                return b'Name:\tcreator-hub\nNSpid:\t8862\t2\n'
            self.assertEqual(path.name, 'cancel-context.json')
            return json.dumps(context).encode()

        with patch.dict(sys.modules, modules), patch.object(M.P, 'helpers', return_value=(helper, native)), \
                patch.object(M.P, 'subtree', return_value={pid: {k: v for k, v in record.items() if k != 'kernelImageSha256'}
                    for pid, record in records.items()}), patch.object(M.P, 'save', side_effect=lambda path, value: saves.append(copy.deepcopy(value))), \
                patch.object(Path, 'read_bytes', autospec=True, side_effect=read), \
                patch.object(M.os, 'getppid', return_value=controller), patch.object(M.os, 'getuid', return_value=caller, create=True), \
                patch.object(M, 'AX_IDENTITY_CAPTURE_ONLY', capture_only), patch.object(M, 'capture_ax_peers') as capture:
            capture.return_value = {'diagnosticOnly': True, 'inputPermitted': False}
            try:
                M.gtk_worker(Path('/owned/fixture'), 'cancel')
            except RuntimeError:
                pass
        self.assertEqual(len(saves), 1)
        if not changed_window:
            self.assertEqual(saves[0]['kernelNamespacePids'], [8862, 2])
        self.assertTrue(all(saves[0][key] is False for key in M.GATES))
        return saves[0], clicks, resolutions

    def test_owned_ax_proxy_uses_bus_pid_not_launcher_namespace_pid(self):
        report, clicks, resolutions = self.gtk_peer_case()
        self.assertNotIn('error', report)
        self.assertEqual(clicks, ['Cancel'])
        self.assertTrue(report['actionAttempted'] and report['actionReturned'])
        self.assertGreater(len(resolutions), 2)
        self.assertEqual(report['lastAxReference']['peer'], {'owner': ':1.42', 'pid': 8859, 'uid': 1001})

    def test_owned_launcher_ax_peer_still_requires_exact_host_bus_pid(self):
        report, clicks, _ = self.gtk_peer_case(reported_pid=8862)
        self.assertNotIn('error', report)
        self.assertEqual(clicks, ['Cancel'])

    def test_foreign_ax_peer_uid_or_unbound_namespace_pid_cannot_authorize_input(self):
        owner_error = 'GTK AX owner is not the kernel-bound launcher/proxy'
        selection_error = 'Exact native GTK disclosure missing/ambiguous'
        variants = [(dict(peer={'owner': ':1.42', 'pid': 9999, 'uid': 1001}), owner_error),
                    (dict(peer={'owner': ':1.42', 'pid': 8859, 'uid': 1002}), owner_error),
                    (dict(peer={'owner': ':1.42', 'pid': 8862, 'uid': 1001}), owner_error),
                    (dict(reported_pid=2), selection_error), (dict(reported_pid=9999), selection_error)]
        for changed, error in variants:
            with self.subTest(changed=changed):
                report, clicks, _ = self.gtk_peer_case(**changed)
                self.assertEqual(report['error'], error)
                self.assertEqual(clicks, [])
                self.assertFalse(report['actionAttempted'] or report['actionReturned'])

    def test_replaced_ax_owner_image_or_native_window_refuses_before_input(self):
        variants = [(dict(replace_owner_at=2), 'GTK AX owner changed'),
                    (dict(replace_owner_at=9), 'GTK alias changed before input'),
                    (dict(replaced_image=True), 'Owned process identity changed'),
                    (dict(changed_window=True), 'GTK native window changed')]
        for changed, error in variants:
            with self.subTest(changed=changed):
                report, clicks, _ = self.gtk_peer_case(**changed)
                self.assertEqual(report['error'], error)
                self.assertEqual(clicks, [])
                self.assertFalse(report['actionAttempted'] or report['actionReturned'])

    def test_read_only_capture_remains_default_and_never_attempts_input(self):
        self.assertTrue(M.AX_IDENTITY_CAPTURE_ONLY)
        report, clicks, resolutions = self.gtk_peer_case(capture_only=True)
        self.assertEqual(clicks, [])
        self.assertEqual(resolutions, [])
        self.assertIn('no GTK input permitted', report['error'])
        self.assertFalse(report['actionAttempted'] or report['actionReturned'])

    def ax_capture_case(self, foreign_bus_uid=False, foreign_kernel_uid=False, replace_owner=False, replace_process=False):
        caller, controller = 1001, 8752
        records = {pid: {'pid': pid, 'startTime': str(pid), 'parentPid': parent, 'uids': [caller] * 4,
            'executable': executable, 'image': {'st_size': '100', 'st_ino': str(pid)},
            'kernelImageSha256': 'a' * 64} for pid, parent, executable in (
                (controller, 1, '/usr/bin/python3'), (8844, controller, M.BWRAP), (8859, 8844, M.PROXY))}
        peer_pid = 9999 if foreign_kernel_uid else 8859
        app = SimpleNamespace(app=SimpleNamespace(bus_name='org.example.Owned'),
            path='/org/a11y/accessible/root', get_process_id=lambda: peer_pid)
        resolutions, reads = [], []
        def resolve(name):
            resolutions.append(name)
            return {'owner': ':1.43' if replace_owner and len(resolutions) > 1 else ':1.42',
                    'pid': peer_pid, 'uid': 1002 if foreign_bus_uid else caller}

        def native_process(pid, helper, full=True):
            reads.append(pid)
            result = copy.deepcopy(records[pid])
            if replace_process and pid == 8859 and reads.count(pid) >= 4:
                result['startTime'] = 'replaced'
            if not full:
                result.pop('kernelImageSha256')
            return result

        native = SimpleNamespace(native_process=native_process,
            process_uids=lambda pid: [1002 if pid == 9999 else caller] * 4)
        subtree = {pid: {k: v for k, v in record.items() if k != 'kernelImageSha256'}
            for pid, record in records.items() if pid != controller}
        with patch.object(M.P, 'subtree', return_value=subtree):
            report = M.capture_ax_peers([app], SimpleNamespace(resolve=resolve), native, None,
                records[8844], controller, caller)
        self.assertTrue(report['diagnosticOnly'])
        self.assertFalse(report['inputPermitted'])
        self.assertTrue(all(report[key] is False for key in M.GATES))
        return report, reads

    def test_read_only_capture_records_owned_proxy_peer_and_controller_ancestry(self):
        report, _ = self.ax_capture_case()
        app = report['applications'][0]
        self.assertTrue(app['associationObserved'])
        self.assertNotIn('error', app)
        self.assertEqual(app['reportedPid'], app['kernelPeer']['pid'])
        self.assertEqual([peer['pid'] for peer in app['ancestry']['chain']], [8859, 8844, 8752])
        self.assertEqual(app['ancestry']['boundary'], {'pid': 8752, 'reason': 'owned-controller'})
        self.assertEqual([peer['pid'] for peer in report['ownedCliSubtree']], [8844, 8859])
        self.assertEqual(report['hashBytesRead'], 300)

    def test_read_only_capture_refuses_foreign_bus_and_kernel_uids(self):
        for changed in (dict(foreign_bus_uid=True), dict(foreign_kernel_uid=True)):
            with self.subTest(changed=changed):
                report, reads = self.ax_capture_case(**changed)
                app = report['applications'][0]
                self.assertNotIn('associationObserved', app)
                self.assertNotIn('kernelPeer', app)
                self.assertIn('error', app)
                self.assertNotIn(9999, reads)

    def test_read_only_capture_refuses_replaced_owner_and_same_pid_process(self):
        for changed in (dict(replace_owner=True), dict(replace_process=True)):
            with self.subTest(changed=changed):
                report, _ = self.ax_capture_case(**changed)
                app = report['applications'][0]
                self.assertNotIn('associationObserved', app)
                self.assertIn('changed', app['error'])

    def bootstrap_fixture(self):
        image = {'st_dev': '1', 'st_ino': '200', 'st_size': '100', 'st_mode': str(stat.S_IFREG | 0o755),
                 'st_uid': '0', 'st_gid': '0', 'st_mtime_ns': '10', 'st_ctime_ns': '20'}
        protected = {'path': M.BWRAP, 'image': image, 'file': {'size': 100, 'sha256': 'b' * 64, 'uid': 0, 'gid': 0, 'mode': 0o755}}
        before = {'pid': 123, 'startTime': '30', 'parentPid': 122, 'uids': [1001] * 4, 'executable': '/usr/bin/flatpak',
                  'image': {**image, 'st_ino': '199'}, 'kernelImageSha256': 'a' * 64}
        after = {**copy.deepcopy(before), 'executable': M.BWRAP, 'image': copy.deepcopy(image), 'kernelImageSha256': 'b' * 64}
        return before, protected, after

    def test_exact_bootstrap_transition_is_one_use_and_frozen_record_is_independent(self):
        before, protected, after = self.bootstrap_fixture()
        binding = M.CliBootstrap(before, protected, 1001, 122)
        frozen = binding.freeze(after)
        self.assertEqual(frozen, after)
        after['image']['st_ino'] = 'mutated'
        self.assertEqual(frozen['image']['st_ino'], '200')
        with self.assertRaisesRegex(RuntimeError, 'already consumed'):
            binding.freeze(frozen)
        native = SimpleNamespace(native_process=lambda *args: {key: val for key, val in frozen.items() if key != 'kernelImageSha256'})
        M.stable(native, None, frozen)
        native.native_process = lambda *args: {key: val for key, val in after.items() if key != 'kernelImageSha256'}
        with self.assertRaisesRegex(RuntimeError, 'Owned process identity changed'):
            M.stable(native, None, frozen)

    def test_bootstrap_rejects_foreign_executable_hash_image_pid_start_parent_and_every_uid(self):
        before, protected, after = self.bootstrap_fixture()
        variants = []
        for field, value in (('executable', '/tmp/bwrap'), ('executable', '/usr/bin/flatpak'), ('kernelImageSha256', 'c' * 64),
                             ('pid', 999), ('startTime', '31'), ('parentPid', 121)):
            changed = copy.deepcopy(after); changed[field] = value; variants.append(changed)
        changed = copy.deepcopy(after); changed['image']['st_ino'] = '201'; variants.append(changed)
        for index in range(4):
            changed = copy.deepcopy(after); changed['uids'][index] = 0; variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed):
                binding = M.CliBootstrap(before, protected, 1001, 122)
                with self.assertRaises(RuntimeError):
                    binding.freeze(changed)
                with self.assertRaisesRegex(RuntimeError, 'already consumed'):
                    binding.freeze(after)
        for field, value in (('executable', M.BWRAP), ('parentPid', 121), ('uids', [0] * 4)):
            changed = copy.deepcopy(before); changed[field] = value
            with self.assertRaises(RuntimeError):
                M.CliBootstrap(changed, protected, 1001, 122)

    def test_fixed_bwrap_measurement_requires_root_owned_protected_ancestors_and_executable_elf(self):
        paths = ('/usr/libexec/flatpak-bwrap', '/usr/libexec', '/usr', '/')
        def measure(changed=None, bad_header=False, image_changed=False):
            infos = {name: SimpleNamespace(st_dev=1, st_ino=index, st_uid=0, st_gid=0,
                st_mode=(stat.S_IFREG if index == 0 else stat.S_IFDIR) | 0o755) for index, name in enumerate(paths)}
            if changed:
                name, field, value = changed; setattr(infos[name], field, value)
            header = bytearray(64); header[:7] = bytes((127, 69, 76, 70, 2, 1, 1)); header[16] = 3; header[18] = 62
            if bad_header:
                header[18] = 3
            class FakePath:
                def __init__(self, name): self.name = name
                @property
                def parents(self): return [FakePath(name) for name in paths[1:]]
                def lstat(self): return infos[self.name]
                def resolve(self, strict): return self
                def open(self, mode): return io.BytesIO(header)
                def __str__(self): return self.name
            calls = []
            def image(name):
                self.assertEqual(name, M.BWRAP); calls.append(name)
                return {'st_ino': '2' if image_changed and len(calls) == 2 else '1'}
            with patch.object(M, 'Path', FakePath), patch.object(M.P, 'record', return_value={
                    'size': 100, 'sha256': 'b' * 64, 'uid': 0, 'gid': 0, 'mode': 0o755}):
                return M.protected_bwrap(SimpleNamespace(image_identity=image))
        self.assertEqual(measure()['path'], M.BWRAP)
        for changed in ((paths[0], 'st_uid', 1001), (paths[0], 'st_gid', 1001),
                        (paths[0], 'st_mode', stat.S_IFLNK | 0o755), (paths[0], 'st_mode', stat.S_IFREG | 0o4755),
                        (paths[1], 'st_mode', stat.S_IFDIR | 0o777), (paths[2], 'st_gid', 1001),
                        (paths[3], 'st_uid', 1001)):
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                measure(changed)
        with self.assertRaises(RuntimeError): measure(bad_header=True)
        with self.assertRaises(RuntimeError): measure(image_changed=True)

    def test_python310_syntax(self):
        ast.parse((HERE / "native-linux-flatpak-activation.py").read_text(), feature_version=(3, 10))


if __name__ == "__main__":
    unittest.main()
