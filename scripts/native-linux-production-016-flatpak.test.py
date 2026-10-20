"""Pure controller/refusal tests. Never runs app, desktop, network or installer."""
import ast
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import warnings
from types import SimpleNamespace

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("production_flatpak_controller", HERE / "native-linux-production-016-flatpak.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
ENV = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
       "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_EVENT_NAME": "workflow_dispatch",
       "GITHUB_REF": M.BRANCH, "GITHUB_WORKFLOW_REF": "BOBWORKS-XR/CREATOR-HUB/" + M.WORKFLOW + "@" + M.BRANCH,
       "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}


def pin(raw):
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def tar_fixture(extra=None):
    # Explicit synthetic structural fixture, not an authenticated package.
    values = {"AppRun": b"#!/bin/sh\nexec usr/bin/creator-hub\n", "usr/bin/creator-hub": b"R" * 64,
              "usr/libexec/creator-hub-portable-selector": b"S" * 64}
    values["creator-hub-portable-host.json"] = M.json_bytes({"schemaVersion": 1, "version": "0.1.16",
        "activationInterface": "com.creatorworks.hub.Host1", "integratedFeatures": True, "startupImageBinding": 1,
        "executableSha256": hashlib.sha256(values["usr/bin/creator-hub"]).hexdigest()})
    entries = {name: {"kind": "file", "mode": 0o644 if name.endswith('.json') else 0o755, **pin(raw)} for name, raw in values.items()}
    for name in list(entries):
        for parent in Path(name).parents:
            if str(parent) != '.':
                entries[parent.as_posix()] = {"kind": "directory", "mode": 0o755}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, entry in sorted(entries.items()):
            info = tarfile.TarInfo(name); info.mode = entry["mode"]; info.uid = info.gid = 0
            if entry["kind"] == "directory":
                info.type = tarfile.DIRTYPE; archive.addfile(info)
            else:
                info.size = entry["size"]; archive.addfile(info, io.BytesIO(values[name]))
        if extra:
            archive.addfile(extra)
    raw = gzip.compress(stream.getvalue(), mtime=0)
    manifest = {"schemaVersion": 1, "appId": "creator-hub", "platform": "linux", "architecture": "x86_64", "version": "0.1.16",
                "sourceCommit": "a" * 40, "sourceTree": "b" * 40, "format": "appdir-tar-gzip-v1", "entrypoint": "usr/bin/creator-hub",
                "archive": {**pin(raw), "unpackedSize": sum(len(value) for value in values.values())}, "entries": entries}
    return raw, manifest


class ControllerTests(unittest.TestCase):
    def test_exact_native_dispatch_only_and_no_inherited_trust_or_runtime_override(self):
        M.admission(ENV, "linux", "x86_64", 1001)
        for key in ENV:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: "wrong"}, "linux", "x86_64", 1001)
        for system, machine, uid in (("win32", "x86_64", 1001), ("linux", "i686", 1001), ("linux", "x86_64", 0)):
            with self.assertRaises(RuntimeError):
                M.admission(ENV, system, machine, uid)
        for key in ("PYTHONPATH", "LD_PRELOAD", "APPIMAGE", "APPDIR", "SSL_CERT_FILE", "http_proxy", "NODE_OPTIONS", "FLATPAK_ID"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: "refuse"}, "linux", "x86_64", 1001)

    def test_main_refuses_before_path_or_process_access_off_native_runner(self):
        with patch.dict(M.os.environ, ENV, clear=True), patch.object(M.sys, "platform", "win32"), \
                patch.object(M, "locations") as locations, patch.object(M, "command") as command:
            with self.assertRaises(RuntimeError):
                M.main()
            locations.assert_not_called(); command.assert_not_called()

    def test_private_environment_does_not_copy_host_home_credentials_or_appimage_hints(self):
        root = Path("/private/fixture")
        result = M.clean_environment(root)
        self.assertEqual(result["HOME"], str(root / "home"))
        self.assertEqual(result["FLATPAK_USER_DIR"], str(root / "installation"))
        for forbidden in ("GH_TOKEN", "GITHUB_TOKEN", "APPIMAGE", "APPDIR", "SSL_CERT_FILE", "https_proxy"):
            self.assertNotIn(forbidden, result)

    def test_zip_checks_complete_inventory_before_creating_any_output(self):
        def zipped(names):
            stream = io.BytesIO()
            with warnings.catch_warnings(), zipfile.ZipFile(stream, "w") as archive:
                warnings.simplefilter('ignore', UserWarning)
                for name in names:
                    archive.writestr(name, b"fixture")
            return stream.getvalue()
        expected = {"known.json": pin(b"fixture")}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            M.stage_zip(zipped(["known.json"]), expected, root / "accepted")
            self.assertEqual((root / "accepted/known.json").read_bytes(), b"fixture")
            for i, names in enumerate((["../known.json"], ["known.json", "extra"], ["known.json", "known.json"], ["/known.json"])):
                with self.subTest(names=names), self.assertRaises(RuntimeError):
                    M.stage_zip(zipped(names), expected, root / str(i))
                self.assertFalse((root / str(i)).exists())

    def test_signed_tar_full_inventory_and_first_install_profile(self):
        raw, manifest = tar_fixture()
        result = M.verify_tar(raw, manifest)
        self.assertEqual(result, {"entries": len(manifest["entries"]), "unpackedBytes": manifest["archive"]["unpackedSize"]})
        for field, value in (("version", "0.1.14"), ("format", "other")):
            changed = copy.deepcopy(manifest); changed[field] = value
            with self.assertRaises(RuntimeError):
                M.verify_tar(raw, changed)
        changed = copy.deepcopy(manifest); changed["entries"]["usr/bin/creator-hub"]["sha256"] = 'f' * 64
        with self.assertRaises(RuntimeError):
            M.verify_tar(raw, changed)

    def test_tar_links_extra_entries_gzip_concatenation_and_trailing_data_refuse(self):
        info = tarfile.TarInfo("foreign"); info.type = tarfile.SYMTYPE; info.linkname = "/etc/passwd"
        raw, manifest = tar_fixture(info)
        with self.assertRaises(RuntimeError):
            M.verify_tar(raw, manifest)
        raw, manifest = tar_fixture()
        for extra in (b"unreviewed", gzip.compress(b"hidden", mtime=0)):
            altered = raw + extra; changed = copy.deepcopy(manifest); changed["archive"].update(pin(altered))
            with self.assertRaises(RuntimeError):
                M.verify_tar(altered, changed)

    def test_kernel_namespace_tuple_does_not_turn_an_unrelated_ax_pid_into_authority(self):
        ids = M.namespace_ids(b"Name:\tapp\nNSpid:\t8862\t2\n", 8862)
        self.assertEqual(ids, [8862, 2])
        process = {"pid": 8862, "uids": [1001] * 4}
        peer = {"owner": ":1.9", "pid": 8862, "uid": 1001}
        M.ax_identity(peer, 8862, process, ids, 1001)
        M.ax_identity(peer, 2, process, ids, 1001)
        for value in ({**peer, "pid": 8859}, {**peer, "uid": 0}, {**peer, "owner": "org.fake"}):
            with self.assertRaises(RuntimeError):
                M.ax_identity(value, 2, process, ids, 1001)
        for raw in (b"NSpid:\t2\n", b"NSpid:\t8862\t0\n", b"NSpid:\t8862\nNSpid:\t8862\n", b"Name: app"):
            with self.assertRaises(RuntimeError):
                M.namespace_ids(raw, 8862)

    def test_dialog_requires_exact_question_buttons_and_actionable_single_target(self):
        rows = [{"role": "alert", "name": "Information", "showing": True, "enabled": True},
                {"role": "label", "name": "bound question", "showing": True, "enabled": True},
                *[{"role": "push button", "name": name, "showing": True, "enabled": True} for name in ("Approve", "Cancel")]]
        self.assertEqual(M.dialog_target(rows, ["bound question"], ["Approve", "Cancel"], "Cancel"), 3)
        for mutate in (lambda r: r.append(r[2]), lambda r: r[3].update(enabled=False), lambda r: r[1].update(name="different")):
            changed = copy.deepcopy(rows); mutate(changed)
            with self.assertRaises(RuntimeError):
                M.dialog_target(changed, ["bound question"], ["Approve", "Cancel"], "Cancel")

    def test_consent_text_binds_current_signed_generation_and_cancellation_scope(self):
        question = M.consent_text('a' * 64)
        for text in ('0.1.16', 'a' * 64, 'OUTSIDE the Flatpak sandbox', 'settings will not be imported', 'close this window normally',
                     'Cancel keeps Store creation, selection and registration unchanged.'):
            self.assertIn(text, question)
        with self.assertRaises(RuntimeError):
            M.consent_text('earlier generation')

    def test_recovery_question_is_one_source_bound_step_without_automatic_followup(self):
        source = (HERE.parent / 'src-tauri/src/native_support.rs').read_text()
        for step, text in M.RESUME_STEPS.items():
            self.assertIn(text, source)
            question = M.resume_text('a' * 64, step)
            self.assertIn(text, question); self.assertIn('Nothing is replayed or launched automatically.', question)
        with self.assertRaises(RuntimeError):
            M.resume_text('a' * 64, 'arbitrary-command')
        for apply in (False, True):
            calls, windows = [], [1, 2]
            session = object.__new__(M.Session)
            session.review = {'generation': 'a' * 64}
            session.driver = SimpleNamespace(read=lambda selector, endpoint='text': 'one step retained' if selector.endswith('status') else True,
                                             click=lambda selector: calls.append(('html', selector)))
            session.windows = lambda: windows
            session.wait = lambda check, seconds=30: self.assertTrue(check())
            def dialog(*args):
                calls.append(('gtk', args)); windows[:] = [1]
            session.click_dialog = dialog
            session.snapshot_preserved = lambda: calls.append(('preserved',))
            self.assertEqual(session.review_resume_once({'pid': 1}, 'register', apply=apply), 'one step retained')
            self.assertEqual(sum(call[0] == 'html' for call in calls), 1)
            self.assertEqual(sum(call[0] == 'gtk' for call in calls), 1)
            self.assertEqual(calls[1][1][3], 'Apply reviewed step' if apply else 'Cancel')

    def test_bounded_tool_timeout_does_not_send_any_signal_or_claim_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            child = SimpleNamespace(pid=99, poll=lambda: None)
            capture = SimpleNamespace(metadata=lambda: {'stdout': {'bytes': 0, 'eof': False, 'truncated': False}},
                                      close=lambda: None)
            native = SimpleNamespace(Capture=lambda *args: capture)
            with patch.object(M, 'locations', return_value=root), patch.object(M.os, 'getuid', return_value=root.stat().st_uid, create=True), \
                    patch.object(M.P, 'helpers', return_value=(None, native)), patch.object(M.subprocess, 'Popen', return_value=child) as launch, \
                    patch.object(M.time, 'monotonic', side_effect=[0, 2]):
                with self.assertRaisesRegex(RuntimeError, 'no signal sent'):
                    M.command([str(root / 'known-tool')], timeout=1)
                self.assertEqual(launch.call_count, 1)
            receipt = M.parse((root / 'evidence/tool-0.json').read_bytes())
            self.assertIsNone(receipt['exitCode'])

    def test_separate_execution_request_refuses_before_review_network_or_installation(self):
        with patch.dict(M.os.environ, {"EXECUTION_REQUEST": "inspect-only"}, clear=True), patch.object(M, "regular") as read, \
                patch.object(M, "public_transport_ready") as network, patch.object(M, "command") as command:
            with self.assertRaises(RuntimeError):
                M.session(Path('/never/read'))
            read.assert_not_called(); network.assert_not_called(); command.assert_not_called()

    def final_close_fixture(self, root, mutation):
        fixture = root / "retained-settings.json"
        fixture.write_bytes(b'original settings')
        before, events = fixture.read_bytes(), []
        state = {"running": False, "closed": False}
        environment = {"HOME": str(root / "home"), "FLATPAK_USER_DIR": str(root / "installation"),
                       "XDG_CONFIG_HOME": str(root / "home/config"), "XDG_DATA_HOME": str(root / "home/data")}
        review = {"generation": 'a' * 64, "portable": {"root": {"sha256": 'b' * 64}}}
        process = {"pid": 99, "startTime": 1, "kernelImageSha256": 'b' * 64,
                   "executable": str(root / "home/data/creator-hub-portable/generations" / review["generation"] / "AppDir/usr/bin/creator-hub")}
        session = SimpleNamespace(report={"phase": "starting", **M.GATES}, children=[], captures=[], fds=[])
        def preserved():
            events.append('preserved-after-exit' if state['closed'] else 'preserved-before-exit')
            M.require(fixture.read_bytes() == before, "Native fixture setting/project/client entry changed")
        def host_owner():
            if state['running']:
                return {"pid": 99}
            if state['closed']:
                events.append('host-released')
                if mutation == 'host-release':
                    fixture.write_bytes(b'changed on Host1 release')
            return None
        def flatpak(action, phase, **kwargs):
            if phase in ('cold', 'warm'):
                state['running'] = True
        def close(*args):
            events.append('root-exited'); state.update(running=False, closed=True)
            if mutation == 'close':
                fixture.write_bytes(b'changed during normal Root close')
        session.snapshot_preserved = preserved
        session.host_owner = host_owner
        session.flatpak = flatpak
        session.close = close
        session.windows = lambda: [101] if state['running'] else []
        session.wait = lambda check, seconds=30: self.assertTrue(check())
        session.launch = lambda *args: SimpleNamespace(wait=lambda timeout: 0)
        session.absent_installation = session.setup = lambda: None
        session.process = lambda *args: process
        session.owned_window = lambda *args: 101
        session.stable = lambda *args: None
        session.native = SimpleNamespace(bitmap=lambda *args: {"synthetic": True})
        session.helper = SimpleNamespace(Request=lambda *args: None)
        session.x11 = SimpleNamespace(display=None, x=SimpleNamespace(XDefaultRootWindow=lambda *args: 0),
            property=lambda window, name: (33, 32, [101]), dispose=lambda: None)
        context = SimpleNamespace(pending=lambda: False)
        repository = SimpleNamespace(Gio=None, GLib=SimpleNamespace(MainContext=SimpleNamespace(default=lambda: context)),
                                     Gdk=SimpleNamespace(init=lambda *args: None))
        gi = SimpleNamespace(require_version=lambda *args: None)
        modules = {'gi': gi, 'gi.repository': repository}
        original_read = Path.read_bytes
        environ = b'\0'.join(name.encode() + b'=' + environment[name].encode()
                             for name in ('HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'))
        def read_bytes(path):
            return environ if path == Path('/proc/99/environ') else original_read(path)
        def run():
            with patch.dict(M.os.environ, environment, clear=True), patch.dict(sys.modules, modules), \
                    patch.object(M, 'verified_review'), patch.object(M, 'Session', return_value=session), \
                    patch.object(M, 'portal_capture', return_value=(SimpleNamespace(unregister_object=lambda *args: None),
                        1, [{"url": M.PORTAL_URL}])), patch.object(M, 'verify_registration'), patch.object(M, 'command'), \
                    patch.object(M.os, 'readlink', return_value='mnt:[synthetic]'), patch.object(Path, 'read_bytes', read_bytes):
                M.run_session(root, review)
        return run, session, events

    def test_final_normal_close_preservation_is_checked_after_exit_and_host_release(self):
        with tempfile.TemporaryDirectory() as directory:
            run, session, events = self.final_close_fixture(Path(directory).resolve(), None)
            run()
            self.assertLess(events.index('root-exited'), events.index('host-released'))
            self.assertLess(events.index('host-released'), events.index('preserved-after-exit'))
            self.assertTrue(session.report['settingsPreserved'])
            self.assertTrue(session.report['normalCloseObserved'])
            self.assertEqual(session.report['phase'], 'complete')

    def test_close_time_settings_mutation_never_sets_final_success_flags(self):
        for mutation in ('close', 'host-release'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                run, session, events = self.final_close_fixture(root, mutation)
                with self.assertRaisesRegex(RuntimeError, 'Native fixture setting/project/client entry changed'):
                    run()
                report = M.parse((root / 'report.json').read_bytes())
                self.assertFalse(report['settingsPreserved'])
                self.assertFalse(report.get('normalCloseObserved', False))
                self.assertNotEqual(report['phase'], 'complete')
                self.assertTrue(report['disposableTeardownRequired'])
                self.assertIn('preserved-after-exit', events)

    def test_data_signature_and_repeated_review_precede_all_native_installs(self):
        tree = ast.parse(Path(M.__file__).read_text())
        functions = {node.name: ast.get_source_segment(Path(M.__file__).read_text(), node) for node in tree.body if isinstance(node, ast.FunctionDef)}
        stage = functions['stage']
        self.assertLess(stage.index('node("verify-staged")'), stage.index('"/usr/bin/minisign"'))
        self.assertLess(stage.index('"/usr/bin/minisign"'), stage.index('verify_tar('))
        self.assertNotIn('flatpak", "--user", "install', stage)
        session = functions['session']
        boundaries = ['EXECUTION_REQUEST', 'verified_review(',
                      '"remote-add"', '"remote-info"', '"install"', '"--bundle"', '"--show-metadata"', '"/usr/bin/xvfb-run"']
        cursor = -1
        for value in boundaries:
            cursor = session.index(value, cursor + 1)
        review = functions['verified_review']
        self.assertLess(review.index('node("verify-staged"'), review.index('"/usr/bin/minisign"'))
        self.assertLess(review.index('"/usr/bin/minisign"'), review.index('verify_tar('))
        run = functions['run_session']
        self.assertLess(run.index('verified_review('), run.index('Session(root, review)'))
        source = Path(M.__file__).read_text()
        setup = source[source.index('    def setup(self):'):source.index('    def review_resume_once(')]
        self.assertLess(setup.index('public_transport_ready('), setup.index('self.driver.request("POST", "/session"'))
        self.assertTrue(all(value is False for value in M.GATES.values()))

    def test_workflow_registers_push_but_native_job_is_manual_and_signature_gated(self):
        workflow = (HERE.parent / M.WORKFLOW).read_text()
        self.assertIn('branches: [validation/native-linux-production-016-flatpak]', workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn('default: inspect-only', workflow)
        self.assertIn('contents: read', workflow); self.assertIn('actions: read', workflow)
        self.assertLess(workflow.index('.cjs preflight'), workflow.index('await lane.collect('))
        self.assertLess(workflow.index('.py stage'), workflow.index('cargo install tauri-driver'))
        self.assertLess(workflow.index('.py stage'), workflow.index('.py session'))
        self.assertEqual(workflow.count("if: inputs.execution_request == '" + M.REQUEST + "'"), 4)
        for bad in ('contents: write', 'actions: write', 'gh release', 'build:unified', '--no-gpg-verify', 'openssl', '--filesystem=home',
                    'flatpak-spawn', '--socket=session-bus'):
            self.assertNotIn(bad, workflow)
        source = Path(M.__file__).read_text()
        for bad in ('execute/sync', 'execute_async', 'eval(', '.kill(', '.terminate(', 'os.kill(', 'pkill', '--command=', 'flatpak-spawn', 'openssl'):
            self.assertNotIn(bad, source)

    def test_workflow_yaml_and_each_bash_block_parse_without_execution(self):
        try:
            import yaml
        except ImportError:
            if os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux':
                self.fail('Native workflow parser is mandatory')
            self.skipTest('PyYAML is unavailable locally; native parser remains mandatory')
        workflow = yaml.safe_load((HERE.parent / M.WORKFLOW).read_text())
        self.assertEqual(set(workflow['jobs']), {'bootstrap'})
        self.assertEqual(workflow['permissions'], {'contents': 'read', 'actions': 'read'})
        blocks = [row['run'] for row in workflow['jobs']['bootstrap']['steps'] if 'run' in row]
        self.assertGreater(len(blocks), 5)
        bash = Path('/bin/bash')
        if not bash.is_file():
            if os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux':
                self.fail('Native Bash parser is mandatory')
            return
        import subprocess
        for block in blocks:
            result = subprocess.run([str(bash), '-n'], input=block, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
