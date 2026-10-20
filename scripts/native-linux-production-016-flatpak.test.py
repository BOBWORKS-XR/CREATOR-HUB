"""Pure controller/refusal tests. Never runs app, desktop, network or installer."""
import ast
import copy
import gzip
import hashlib
import http.client
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
from unittest.mock import Mock, patch
import zipfile
import warnings
from contextlib import contextmanager
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


class DriverReadiness(unittest.TestCase):
    def startup(self, *, driver_at=1, backend_at=3, statuses=(True,), change=None, transport_error=False):
        state = SimpleNamespace(tick=0, requests=[], statuses=iter(statuses), launches=[])
        state.rows = {
            100: dict(pid=100, parentPid=99, executable="/fixture/tools/bin/tauri-driver", uids=[1000] * 4,
                      startTime="100", kernelImageSha256="d" * 64),
            101: dict(pid=101, parentPid=100, executable="/usr/bin/WebKitWebDriver", uids=[1000] * 4,
                      startTime="101", kernelImageSha256="b" * 64),
        }
        child = SimpleNamespace(pid=100, poll=lambda: None)
        session = object.__new__(M.Session)
        session.root, session.app_env, session.report, session.helper = Path("/fixture"), {}, {}, None
        session.native = SimpleNamespace(native_process=lambda pid, _: copy.deepcopy(state.rows[pid]))
        def listener(pid, port):
            return (pid, port) == (100, 4444) and state.tick >= driver_at or (
                (pid, port) == (101, 4445) and state.tick >= backend_at)
        def wait(check):
            for _ in range(8):
                state.tick += 1
                if change:
                    change(state)
                if check():
                    return
            raise RuntimeError("Read-only readiness deadline; no mutation retried")
        def request(method, endpoint):
            session.driver.guard()
            state.requests.append((method, endpoint, state.tick))
            self.assertEqual((method, endpoint), ("GET", "/status"))
            if not listener(100, 4444) or not listener(101, 4445) or transport_error:
                raise http.client.RemoteDisconnected("Remote end closed connection without response")
            result = {"ready": next(state.statuses)}
            session.driver.guard()
            return result
        def launch(args, label, **kwargs):
            self.assertEqual(args, [str(session.root / "tools/bin/tauri-driver"), "--native-driver", "/usr/bin/WebKitWebDriver"])
            self.assertEqual(label, "webdriver")
            state.launches.append(args)
            return child
        def record(file):
            native = str(file) == "/usr/bin/WebKitWebDriver"
            self.assertTrue(native or file == session.root / "tools/bin/tauri-driver")
            return dict(size=64, sha256=("b" if native else "d") * 64, mode=0o755,
                        uid=0 if native else 1000, gid=0 if native else 1000)
        session.driver = SimpleNamespace(guard=lambda: None, request=request)
        session.wait, session.launch = wait, launch
        node = next(n for n in ast.parse(Path(M.__file__).read_text()).body if isinstance(n, ast.ClassDef) and n.name == "Session")
        body = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "setup").body
        start = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id in ("driver_file", "driver") for t in n.targets))
        end = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "value" for t in n.targets))
        code = compile(ast.Module(body=body[start:end], type_ignores=[]), "owned-setup-preflight", "exec")
        self.last_state = state
        with patch.object(M.os, "getuid", return_value=1000, create=True), patch.object(M.os, "getgid", return_value=1000, create=True), \
                patch.object(M.P, "record", side_effect=record), patch.object(M.P, "listener", side_effect=listener), \
                patch.object(M.P, "subtree", side_effect=lambda *args: copy.deepcopy(state.rows)):
            exec(code, {**vars(M), "self": session, "proxy": "http://127.0.0.1:1234"})
        return state, session

    def test_actual_setup_waits_for_both_staggered_listeners_before_status(self):
        for driver_at, backend_at in ((1, 3), (3, 1)):
            with self.subTest(driver_at=driver_at, backend_at=backend_at):
                state, session = self.startup(driver_at=driver_at, backend_at=backend_at)
                self.assertEqual(len(state.launches), 1)
                self.assertEqual(len(state.requests), 1)
                self.assertGreaterEqual(state.requests[0][2], max(driver_at, backend_at))
                self.assertEqual(session.report["setupTools"]["systemDriver"], state.rows[101])

    def test_missing_listener_never_sends_status_or_root_launch(self):
        for driver_at, backend_at in ((99, 1), (1, 99)):
            with self.subTest(driver_at=driver_at, backend_at=backend_at), self.assertRaisesRegex(RuntimeError, "Read-only readiness deadline"):
                self.startup(driver_at=driver_at, backend_at=backend_at)
            self.assertEqual(self.last_state.requests, [])
            self.assertEqual(len(self.last_state.launches), 1)

    def test_backend_image_parent_uid_start_and_driver_change_refuse(self):
        for pid, field, value in ((101, "kernelImageSha256", "x" * 64), (101, "parentPid", 999),
                                  (101, "uids", [0] * 4), (101, "startTime", "changed"), (100, "startTime", "replacement")):
            def changed(state):
                if state.tick == 2:
                    state.rows[pid][field] = value
            with self.subTest(pid=pid, field=field), self.assertRaises(RuntimeError):
                self.startup(driver_at=3, backend_at=3, change=changed)
            self.assertEqual(self.last_state.requests, [])

    def test_status_false_is_readonly_but_transport_uncertainty_is_not_retried(self):
        state, _ = self.startup(statuses=(False, True))
        self.assertEqual([(method, path) for method, path, _ in state.requests], [("GET", "/status")] * 2)
        with self.assertRaises(http.client.RemoteDisconnected):
            self.startup(transport_error=True)
        self.assertEqual(len(self.last_state.requests), 1)

    def test_tooling_guard_remains_combined_with_owned_root_window_guard(self):
        source = Path(M.__file__).read_text()
        tree = ast.parse(source)
        session = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Session")
        setup = next(n for n in session.body if isinstance(n, ast.FunctionDef) and n.name == "setup")
        guard = next(n for n in setup.body if isinstance(n, ast.FunctionDef) and n.name == "setup_guard")
        self.assertEqual([ast.unparse(n) for n in guard.body], ['tooling_guard()', 'self.owned_window(root, P.TITLE)'])
        self.assertIn("tooling_guard = self.driver.guard", ast.get_source_segment(source, setup))
        self.assertIn("self.driver.guard = setup_guard", ast.get_source_segment(source, setup))


class LauncherKeyboardTests(unittest.TestCase):
    @staticmethod
    def process(pid, parent, executable, full=True):
        record = {'pid': pid, 'parentPid': parent, 'startTime': str(pid), 'uids': [1001] * 4, 'executable': executable,
                  'image': {key: str(value) for key, value in dict(st_dev=1, st_ino=pid, st_size=64, st_mode=0o100755,
                            st_uid=0, st_gid=0, st_mtime_ns=5, st_ctime_ns=6).items()}}
        if full:
            record['kernelImageSha256'] = ('c' if pid == 14 else 'b') * 64
        return record

    def receipt(self, sequence, client, origin, window, *, partial=False):
        launch = self.process(origin['pid'], origin['parentPid'], '/usr/bin/bwrap')
        rows = [{'keycode': {'Escape': 9, 'Enter': 36, 'ShiftTabSpace': 23}[sequence] if index < 2 else 65,
                 'modifiers': modifiers, 'pressed': pressed, 'submissionAttempted': True, 'returnObserved': True,
                 'submitted': True, 'synchronized': True}
                for index, (_, modifiers, pressed) in enumerate((symbol, modifiers, pressed)
                    for symbol, modifiers in M.K.SEQUENCES[sequence] for pressed in (True, False))]
        result = {'schemaVersion': 1, 'mechanism': 'exact-xid-keyboard', 'pid': client['pid'], 'startTime': client['startTime'],
                  'window': window, 'intent': sequence, 'candidateAction': {'Escape': 'decline-or-close', 'Enter': 'default-open',
                    'ShiftTabSpace': 'get-native-hub'}[sequence], 'delivery': rows[:1] if partial else rows,
                  'deliveryComplete': not partial, 'launchProvenance': {'readOnly': True,
                    'popen': {key: origin[key] for key in M.K.CONTINUITY_FIELDS}, 'admittedLaunch': launch,
                    'systemImage': {'path': '/usr/bin/bwrap', 'image': launch['image'],
                                    'kernelImageSha256': launch['kernelImageSha256'], 'protectedRootOwned': True}},
                  'widgetFocusVerified': False, 'outcomeVerified': False, 'nativeVerificationRequired': True, 'releaseReady': False}
        if partial:
            result['refusal'] = 'Owned process exited after synchronized key press'
        return result

    @contextmanager
    def fixture(self, action='Cancel', phase='disclosure-cancel', missing=False, *, partial=None,
                changed_receipt=None, capture_failure=None, wrong_exit=None, preservation_failure=False,
                wrong_window=False, first_pre_exec=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = (HERE.parent / 'native/flatpak-native-activation/src/linux.rs').read_bytes()
            state = SimpleNamespace(code=None, captures=[], sends=[], closed=0, outcomes=[], origin_reads=0, companions=[])
            session = object.__new__(M.Session)
            session.root, session.helper, session.x11 = root, SimpleNamespace(), object()
            launch = self.process(10, 9, '/usr/bin/bwrap')
            client = self.process(14, 13, '/app/bin/creator-hub-flatpak-activate')
            native_root = self.process(40, 1, str(root / 'home/data/creator-hub-portable/generations' / ('e' * 64) / 'AppDir/usr/bin/creator-hub'))
            rows = {10: launch, 13: self.process(13, 10, '/usr/bin/bwrap'), 14: client, 40: native_root}
            def native_process(pid, helper, full=True):
                value = copy.deepcopy(rows[pid])
                if pid == 10:
                    state.origin_reads += 1
                    if first_pre_exec and state.origin_reads == 1:
                        value['executable'] = '/usr/bin/flatpak'
                if not full:
                    value.pop('kernelImageSha256', None)
                return value
            session.native = SimpleNamespace(native_process=native_process)
            session.review = {'flatpak': {'files': {'creator-hub-flatpak-activate': {'sha256': 'c' * 64}},
                'source': {'files': {'native/flatpak-native-activation/src/linux.rs': pin(source)}}},
                'portable': {'root': {'sha256': 'b' * 64}}, 'generation': 'e' * 64}
            child = SimpleNamespace(pid=10, poll=lambda: state.code, wait=lambda: state.code)
            session.children = []
            def launch_child(args, label):
                self.assertEqual(args, ['/usr/bin/flatpak', 'run', '--user', M.REF])
                self.assertEqual(label, phase)
                session.children.append(child)
                return child
            session.launch = launch_child
            session.helper = SimpleNamespace(parse_start=lambda *_: '10', Proc=lambda: SimpleNamespace(stat=lambda _: 'fixture-stat'))
            session.wait = lambda check, seconds=30: self.assertTrue(check(), 'Read-only readiness condition was not reached')
            session.disclosure = lambda: 'authenticated disclosure'
            session.click_dialog = Mock(side_effect=AssertionError('Launcher must never reach AX input'))
            session.host_owner = lambda: {'pid': 40, 'name': ':1.42'} if phase == 'warm' or phase == 'cold' and state.code is not None else None
            def dialog_window(): return 101 if missing and state.sends == ['Enter'] else 100
            session.windows = lambda: [200] if phase in ('cold', 'warm') and state.code is not None else [] if state.code is not None else (
                [200, dialog_window()] if phase == 'warm' else [dialog_window()])
            session.x11 = SimpleNamespace(inspect=lambda window: {'pid': 40 if window == 200 else 14,
                'client': 901 if window == 200 else 900, 'title': 'Creator Hub', 'mapped': True})
            session.owned_window = lambda process, title: 200 if process['pid'] == 40 else 999 if wrong_window else dialog_window()
            def preserved():
                if preservation_failure:
                    raise RuntimeError('Preserved fixture changed')
                state.outcomes.append('preserved')
                return {'retained': True}
            session.snapshot_preserved = preserved
            session.report = {'coldActivationAccepted': True, 'coldRoot': native_root, 'coldRootWindow': 200, 'coldHost1Owner': {'pid': 40, 'name': ':1.42'},
                              'coldRootXres': session.x11.inspect(200)}
            session.portal_calls = [{'url': M.PORTAL_URL, 'browserOpened': False, 'downloadAttempted': False, 'senderUid': 1001}]
            def bind_warm(helper, native, x11, observed, window, owner, owner_probe):
                # Integration adapter fixture only; real FD/XRes/Host1 binding is exercised in the helper suite.
                companion = object.__new__(M.K.WarmRoot)
                companion.helper, companion.native, companion.x11 = helper, native, x11
                companion.process, companion.window, companion.owner = copy.deepcopy(observed), window, copy.deepcopy(owner)
                companion.window_owner = copy.deepcopy(x11.inspect(window))
                companion.held = SimpleNamespace(close=lambda: None)
                def verify():
                    M.require(companion.held is not None and owner_probe() == companion.owner
                              and native.native_process(observed['pid'], helper) == observed
                              and x11.inspect(window) == companion.window_owner, 'Companion identity/Host1/window changed')
                companion.verify = verify
                companion.verify()
                state.companions.append(companion)
                return companion
            def capture(helper, native, x11, observed, origin, guard, window, *, warm_companion=None):
                state.captures.append(window)
                guard()
                self.assertEqual(observed, client)
                if capture_failure:
                    raise RuntimeError(capture_failure)
                M.require(window == dialog_window(), 'Wrong exact window')
                if warm_companion is None:
                    M.require(session.windows() == [window], 'Sole visible managed dialog required')
                else:
                    self.assertIs(type(warm_companion), M.K.WarmRoot)
                    warm_companion.verify()
                    M.require(session.windows() == [warm_companion.window, window], 'Exact two-owned-window stack required')
                def send(sequence):
                    state.sends.append(sequence)
                    guard()
                    record = self.receipt(sequence, client, origin, window, partial=partial == sequence)
                    if warm_companion is not None:
                        M.require(sequence == 'Enter', 'Warm disclosure Enter only')
                        warm_companion.verify()
                        record['warmCompanion'] = {'binding': warm_companion.evidence, 'managedWindows': [warm_companion.window, window]}
                    if changed_receipt:
                        changed_receipt(record)
                    if not missing or sequence == 'Escape':
                        state.code = wrong_exit if wrong_exit is not None else 1 if missing else 0
                    if partial == sequence:
                        raise M.K.InputRefused('terminal candidate', record)
                    return record
                def close(): state.closed += 1
                return SimpleNamespace(send=send, close=close)
            tree = {pid: {k: v for k, v in row.items() if k != 'kernelImageSha256'} for pid, row in rows.items() if pid != 40}
            with patch.object(M, 'bound', return_value=source) as source_read, patch.object(M.K, 'capture', side_effect=capture), \
                    patch.object(M.K, 'bind_warm_root', side_effect=bind_warm), \
                    patch.object(M.P, 'subtree', return_value=tree), patch.object(M.os, 'getuid', return_value=1001, create=True), \
                    patch.object(M.os, 'getpid', return_value=9), patch.object(M.os, 'readlink', return_value='mnt:[1]'):
                yield session, state, source_read
            session.click_dialog.assert_not_called()

    def test_source_button_mapping_is_finite_and_default_response_is_explicit(self):
        source = (HERE.parent / 'native/flatpak-native-activation/src/linux.rs').read_text()
        for question, action, sequence in (('disclosure', 'Cancel', 'Escape'),
                ('disclosure', 'Open Creator Hub', 'Enter'), ('disclosure', 'Get Native Hub', 'ShiftTabSpace'),
                ('missing', 'Close', 'Escape')):
            with self.subTest(question=question, action=action):
                mapping = M.launcher_button_mapping(source, question, action)
                self.assertEqual(mapping['sequence'], sequence)
                self.assertFalse(mapping['widgetFocusVerified'])
        for changed in (source.replace('ResponseType::Accept);', 'ResponseType::Cancel);'),
                        source.replace('("Get Native Hub", gtk::ResponseType::Other(1))', '("Other", gtk::ResponseType::Other(1))')):
            with self.assertRaises(RuntimeError):
                M.launcher_button_mapping(changed, 'disclosure', 'Open Creator Hub')
        with self.assertRaises(RuntimeError):
            M.launcher_button_mapping(source, 'missing', 'Get Native Hub')

    def test_complete_sequences_use_keyboard_only_then_independent_phase_outcomes(self):
        for action, phase, missing, sequences in (('Cancel', 'disclosure-cancel', False, ['Escape']),
                ('Open Creator Hub', 'missing-host', True, ['Enter', 'Escape']),
                ('Get Native Hub', 'portal-only', False, ['ShiftTabSpace']),
                ('Open Creator Hub', 'cold', False, ['Enter']), ('Open Creator Hub', 'warm', False, ['Enter'])):
            with self.subTest(phase=phase), self.fixture(action, phase, missing) as (session, state, source_read):
                session.flatpak(action, phase, missing)
                self.assertEqual(state.sends, sequences)
                self.assertEqual(state.closed, len(sequences))
                self.assertEqual(source_read.call_count, len(sequences))
                self.assertEqual(len(state.companions), 1 if phase == 'warm' else 0)
                for record in session.launcher_keys:
                    self.assertTrue(record['outcomeVerified']); self.assertTrue(record['preservedDataVerified'])
                    self.assertFalse(record['actionReturned']); self.assertFalse(record['releaseReady'])
                    self.assertFalse(record['keyboard']['widgetFocusVerified'])
                    self.assertEqual(record['ownedPhaseExit']['exitCode'], 1 if missing else 0)
                    original = M.parse((session.root / (record['phase'] + '-gtk.json')).read_bytes())
                    self.assertFalse(original['outcomeVerified']); self.assertNotIn('ownedPhaseExit', original)
                    self.assertEqual(original['keyboard'], record['keyboard'])
                expected_source = session.root / 'stage/source/native/flatpak-native-activation/src/linux.rs'
                self.assertTrue(all(call.args[0] == expected_source for call in source_read.call_args_list))

    def test_synced_terminal_escape_or_enter_partial_requires_separate_exit_and_state_proof(self):
        for action, phase, missing, partial in (('Cancel', 'disclosure-cancel', False, 'Escape'),
                ('Open Creator Hub', 'cold', False, 'Enter'), ('Open Creator Hub', 'missing-host', True, 'Escape')):
            with self.subTest(phase=phase), self.fixture(action, phase, missing, partial=partial) as (session, state, _):
                session.flatpak(action, phase, missing)
                last = session.launcher_keys[-1]
                self.assertTrue(last['outcomeVerified']); self.assertTrue(last['preservedDataVerified'])
                self.assertFalse(last['keyboard']['deliveryComplete'])
                self.assertEqual(last['deliveryClassification'], 'terminal-press-pending-owned-exit')
                self.assertEqual(state.sends.count(partial), 1)
                self.assertIn('refusal', last['keyboard'])

    def test_unknown_shift_tab_partial_and_intermediate_enter_never_retry_or_send_next_dialog(self):
        for action, phase, missing, partial in (('Get Native Hub', 'portal-only', False, 'ShiftTabSpace'),
                ('Open Creator Hub', 'missing-host', True, 'Enter')):
            with self.subTest(phase=phase), self.fixture(action, phase, missing, partial=partial) as (session, state, _):
                with self.assertRaises(RuntimeError):
                    session.flatpak(action, phase, missing)
                self.assertEqual(state.sends, [partial]); self.assertEqual(state.closed, 1)
                record = M.parse((session.root / (phase + '-outcome-gtk.json')).read_bytes())
                self.assertFalse(record['outcomeVerified']); self.assertFalse(record['keyboard']['deliveryComplete'])

    def test_partial_terminal_press_without_sync_or_owned_exit_stays_unknown(self):
        for flag in ('submissionAttempted', 'returnObserved', 'submitted', 'synchronized'):
            with self.subTest(flag=flag), self.fixture(partial='Escape',
                    changed_receipt=lambda record: record['delivery'][0].update({flag: False})) as (session, state, _):
                with self.assertRaises(RuntimeError):
                    session.flatpak('Cancel', 'disclosure-cancel')
                self.assertEqual(state.sends, ['Escape'])
                self.assertFalse(session.launcher_keys[0]['outcomeVerified'])
        with self.fixture(partial='Escape') as (session, state, _):
            def wait(check, seconds=30):
                if state.sends:
                    state.code = None
                M.require(check(), 'Owned Popen did not exit; no retry')
            session.wait = wait
            with self.assertRaisesRegex(RuntimeError, 'did not exit'):
                session.flatpak('Cancel', 'disclosure-cancel')
            record = M.parse((session.root / 'disclosure-cancel-outcome-gtk.json').read_bytes())
            self.assertFalse(record['outcomeVerified']); self.assertNotIn('ownedPhaseExit', record)
            self.assertEqual(state.sends, ['Escape'])

    def test_wrong_exit_and_changed_preserved_data_never_qualify_partial_or_complete_input(self):
        for partial in (None, 'Escape'):
            for failure in ('exit', 'preserved'):
                with self.subTest(partial=partial, failure=failure), self.fixture(partial=partial,
                        wrong_exit=2 if failure == 'exit' else None, preservation_failure=failure == 'preserved') as (session, state, _):
                    with self.assertRaises(RuntimeError):
                        session.flatpak('Cancel', 'disclosure-cancel')
                    record = M.parse((session.root / 'disclosure-cancel-outcome-gtk.json').read_bytes())
                    self.assertFalse(record['outcomeVerified']); self.assertIn('phaseFailure', record)
                    self.assertEqual(state.sends, ['Escape'])
                    self.assertEqual(record['ownedPhaseExit']['exitCode'], 2 if failure == 'exit' else 0)

    def test_wrong_window_or_focus_refuses_before_delivery_and_retains_receipt(self):
        for failure in ('window', 'focus'):
            with self.subTest(failure=failure), self.fixture(wrong_window=failure == 'window',
                    capture_failure='Exact focus changed' if failure == 'focus' else None) as (session, state, _):
                with self.assertRaises(RuntimeError):
                    session.flatpak('Cancel', 'disclosure-cancel')
                self.assertEqual(state.sends, [])
                record = M.parse((session.root / 'disclosure-cancel-outcome-gtk.json').read_bytes())
                self.assertFalse(record['actionAttempted']); self.assertFalse(record['outcomeVerified'])
                self.assertIn('refusal', record)

    def test_empty_wrong_target_unsynced_or_falsely_complete_receipt_never_reaches_outcome(self):
        changes = (lambda r: r.clear(), lambda r: r.update(window=999), lambda r: r.update(pid=99),
                   lambda r: r.update(delivery=[]), lambda r: r['delivery'][0].update(synchronized=False),
                   lambda r: r['delivery'].pop(), lambda r: r.update(widgetFocusVerified=True),
                   lambda r: r['launchProvenance']['systemImage'].update(protectedRootOwned=False))
        for change in changes:
            with self.subTest(change=change), self.fixture(changed_receipt=change) as (session, state, _):
                with self.assertRaises(RuntimeError):
                    session.flatpak('Cancel', 'disclosure-cancel')
                self.assertEqual(state.sends, ['Escape'])
                record = M.parse((session.root / 'disclosure-cancel-outcome-gtk.json').read_bytes())
                self.assertIn('keyboard', record); self.assertFalse(record['outcomeVerified'])
                self.assertNotIn('ownedPhaseExit', record)

    def test_original_pre_exec_continuity_is_retained_without_path_only_admission(self):
        with self.fixture(first_pre_exec=True) as (session, state, _):
            session.flatpak('Cancel', 'disclosure-cancel')
            self.assertEqual(session.flatpak_origin['executable'], '/usr/bin/flatpak')
            self.assertGreater(state.origin_reads, 1)
            self.assertEqual(session.launcher_keys[0]['keyboard']['launchProvenance']['admittedLaunch']['executable'], '/usr/bin/bwrap')
        for field, changed in (('startTime', '999'), ('parentPid', 99), ('uids', [1002] * 4)):
            with self.subTest(field=field), self.fixture() as (session, state, _):
                original = session.native.native_process(10, None, False)
                session.flatpak_origin = original
                session.flatpak_child = SimpleNamespace(pid=10, poll=lambda: None)
                session.children = [session.flatpak_child]
                session.flatpak_origin = {**original, field: changed}
                with self.assertRaises(RuntimeError):
                    session.flatpak_guard()
                self.assertEqual(state.sends, [])

    def test_exit_without_expected_portal_or_native_host_is_not_action_success(self):
        for phase in ('portal-only', 'cold'):
            action = 'Get Native Hub' if phase == 'portal-only' else 'Open Creator Hub'
            with self.subTest(phase=phase), self.fixture(action, phase) as (session, state, _):
                if phase == 'portal-only':
                    session.portal_calls = []
                elif phase == 'cold':
                    session.host_owner = lambda: None
                    session.wait = lambda check, seconds=30: M.require(check(), 'Expected read-only host outcome absent')
                with self.assertRaises(RuntimeError):
                    session.flatpak(action, phase)
                self.assertEqual(len(state.sends), 1)
                self.assertFalse(session.launcher_keys[0]['outcomeVerified'])

    def test_warm_dialog_uses_one_explicit_companion_without_hiding_or_changing_the_root(self):
        with self.fixture('Open Creator Hub', 'warm') as (session, state, _):
            session.flatpak('Open Creator Hub', 'warm')
            self.assertEqual(state.sends, ['Enter']); self.assertEqual(len(state.companions), 1)
            record = M.parse((session.root / 'warm-outcome-gtk.json').read_bytes())
            self.assertTrue(record['outcomeVerified'])
            self.assertEqual(record['keyboard']['warmCompanion']['managedWindows'], [200, 100])
            self.assertEqual(record['keyboard']['warmCompanion']['binding']['hostOwner'], session.report['coldHost1Owner'])
            self.assertEqual(record['keyboard']['warmCompanion']['binding']['root'], session.report['coldRoot'])
            self.assertIsNone(state.companions[0].held)

    def test_warm_outcome_requires_the_original_signed_root_even_if_exit_was_observed(self):
        with self.fixture('Open Creator Hub', 'warm') as (session, state, _):
            state.code = 0
            self.assertEqual(session.launcher_outcome('Open Creator Hub', 'warm', False), 'same-owned-native-root')
            session.report['coldRoot'] = {'different': 'instance'}
            with self.assertRaisesRegex(RuntimeError, 'replaced'):
                session.launcher_outcome('Open Creator Hub', 'warm', False)

    def test_warm_without_qualified_signed_cold_root_owner_or_xres_refuses_before_input(self):
        for mutation in ('not-qualified', 'hash', 'path', 'owner', 'window', 'xres', 'live-root'):
            with self.subTest(mutation=mutation), self.fixture('Open Creator Hub', 'warm') as (session, state, _):
                if mutation == 'not-qualified': session.report['coldActivationAccepted'] = False
                elif mutation == 'hash': session.report['coldRoot'] = {**session.report['coldRoot'], 'kernelImageSha256': 'd' * 64}
                elif mutation == 'path': session.report['coldRoot'] = {**session.report['coldRoot'], 'executable': '/other/AppDir/usr/bin/creator-hub'}
                elif mutation == 'owner': session.report['coldHost1Owner'] = {'pid': 40, 'name': ':1.43'}
                elif mutation == 'window': session.report['coldRootWindow'] = 201
                elif mutation == 'xres': session.report['coldRootXres'] = {**session.report['coldRootXres'], 'client': 902}
                else:
                    original = session.native.native_process
                    session.native.native_process = lambda pid, helper, full=True: {**original(pid, helper, full), 'startTime': '999'} if pid == 40 else original(pid, helper, full)
                with self.assertRaises(RuntimeError): session.flatpak('Open Creator Hub', 'warm')
                self.assertEqual(state.sends, [])
                self.assertEqual(state.captures, [])
                self.assertFalse(session.launcher_keys[0]['outcomeVerified'])
                self.assertTrue(all(companion.held is None for companion in state.companions))

    def test_companion_receipt_must_match_the_exact_binding_and_literal_two_window_order(self):
        mutations = (lambda record: record.pop('warmCompanion'),
                     lambda record: record['warmCompanion'].update(managedWindows=[100, 200]),
                     lambda record: record['warmCompanion']['binding']['hostOwner'].update(name=':1.43'),
                     lambda record: record['warmCompanion'].update(soleWindow=True))
        for change in mutations:
            with self.subTest(change=change), self.fixture('Open Creator Hub', 'warm', changed_receipt=change) as (session, state, _):
                with self.assertRaises(RuntimeError): session.flatpak('Open Creator Hub', 'warm')
                self.assertEqual(state.sends, ['Enter'])
                self.assertFalse(session.launcher_keys[0]['outcomeVerified'])
                self.assertIsNone(state.companions[0].held)

    def test_partial_warm_enter_only_qualifies_if_original_host1_owner_survives_phase_exit(self):
        for changed in (False, True):
            with self.subTest(changed=changed), self.fixture('Open Creator Hub', 'warm', partial='Enter') as (session, state, _):
                if changed:
                    session.host_owner = lambda: {'pid': 40, 'name': ':1.43' if state.code is not None else ':1.42'}
                    with self.assertRaisesRegex(RuntimeError, 'replaced'):
                        session.flatpak('Open Creator Hub', 'warm')
                else:
                    session.flatpak('Open Creator Hub', 'warm')
                record = session.launcher_keys[0]
                self.assertFalse(record['keyboard']['deliveryComplete'])
                self.assertIs(record['outcomeVerified'], not changed)
                self.assertEqual(record['ownedPhaseExit']['exitCode'], 0)
                self.assertEqual(state.sends, ['Enter'])

    def test_companion_is_not_created_for_a_different_warm_question_or_action(self):
        with self.fixture('Open Creator Hub', 'warm') as (session, state, _):
            session.flatpak_origin = session.native.native_process(10, None, False)
            session.flatpak_child = SimpleNamespace(pid=10, poll=lambda: None)
            session.children = [session.flatpak_child]
            session.launcher_keys = []
            with self.assertRaisesRegex(RuntimeError, 'warm disclosure Enter'):
                session.launcher_keyboard(session.native.native_process(14, None), 'missing', 'Close', 'warm', terminal=True)
            self.assertEqual(state.sends, []); self.assertEqual(state.companions, [])

    def test_helper_preflight_is_mandatory_before_any_download(self):
        workflow = (HERE.parent / M.WORKFLOW).read_text()
        command = 'python3 -B scripts/native-linux-flatpak-dialog-input.test.py'
        self.assertEqual(workflow.count(command), 1)
        self.assertLess(workflow.index(command), workflow.index('await lane.collect('))
        self.assertIn('native-linux-flatpak-dialog-input.py', Path(M.__file__).read_text())

    def test_unverified_launcher_source_or_wrong_signed_client_never_reaches_input(self):
        for failure in ('source', 'client', 'phase'):
            with self.subTest(failure=failure), self.fixture() as (session, state, source_read):
                if failure == 'source':
                    source_read.side_effect = RuntimeError('Source blob differs from producer pin')
                elif failure == 'client':
                    session.review['flatpak']['files']['creator-hub-flatpak-activate']['sha256'] = 'd' * 64
                with self.assertRaises(RuntimeError):
                    session.flatpak('Cancel', 'disclosure-cancel' if failure != 'phase' else 'arbitrary-phase')
                self.assertEqual(state.sends, [])
                self.assertEqual(state.captures, [])

    def test_native_root_dialog_still_has_direct_ax_pid_guard_and_no_keyboard_fallback(self):
        source = Path(M.__file__).read_text()
        session = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == 'Session')
        ax = ast.get_source_segment(source, next(n for n in session.body if isinstance(n, ast.FunctionDef) and n.name == 'click_dialog'))
        launcher = ast.get_source_segment(source, next(n for n in session.body if isinstance(n, ast.FunctionDef) and n.name == 'flatpak'))
        self.assertIn('ax_identity(peer, node.get_process_id(), process, ids, os.getuid())', ax)
        self.assertIn('interface.do_action(0)', ax)
        self.assertNotIn('K.capture', ax)
        self.assertNotIn('self.click_dialog', launcher)


class ControllerTests(unittest.TestCase):
    def test_verifier_reuses_exact_example_and_lock_without_dependencies_or_key_override(self):
        root = HERE.parent
        manifest = (root / M.VERIFIER_CRATE / 'Cargo.toml').read_text()
        self.assertIn('[[example]]\nname = "verify-package-input"\npath = "../../src-tauri/examples/verify-package-input.rs"', manifest)
        for name, expected in M.VERIFIER_PINS.items():
            raw = (root / name).read_bytes()
            if name == M.VERIFIER_KEY and sys.platform == 'win32':
                raw = raw.replace(b'\r\n', b'\n')  # Git's canonical key bytes, not a production normalization.
            self.assertEqual(pin(raw), expected)
        source = (root / M.VERIFIER_SOURCE).read_text()
        self.assertIn('key.verify(&bytes, &signature, false)?', source)
        self.assertIn('bounded(Path::new(&args[0]), 128 * 1024)', source)
        self.assertIn('include_str!("../src/catalog-key.pub")', source)
        self.assertEqual(M.VERIFIER_LIMIT, 128 * 1024)

    def verifier_input_fixture(self, root):
        repo, work = root / 'checkout', root / 'build'
        values = {M.VERIFIER_SOURCE: b'unchanged example', M.VERIFIER_KEY: b'compiled key',
                  M.VERIFIER_CRATE + '/Cargo.lock': b'locked dependencies', M.VERIFIER_CRATE + '/Cargo.toml': b'fixed example entry',
                  M.VERIFIER_CRATE + '/src/lib.rs': b'fixed native library'}
        inputs = {}
        for name, raw in values.items():
            original, copied = repo / name, work / 'source' / name
            for file in (original, copied):
                file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(raw)
            inputs[name] = {'pin': pin(raw), 'originalStamp': list(M.P.stamp(original.lstat())), 'copyStamp': list(M.P.stamp(copied.lstat()))}
        pins = {name: pin(values[name]) for name in M.VERIFIER_PINS}
        return repo, work, inputs, pins

    def test_verifier_snapshot_rechecks_exact_inputs_identity_unknown_files_and_single_links(self):
        for mutation in ('bytes', 'replacement', 'hardlink', 'extra', 'key-pin', 'missing-lib'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                repo, work, inputs, pins = self.verifier_input_fixture(Path(directory).resolve())
                copied = work / 'source' / M.VERIFIER_SOURCE
                uid = copied.lstat().st_uid
                with patch.object(M, 'HERE', repo / 'scripts'), patch.object(M, 'VERIFIER_PINS', pins), \
                        patch.object(M.os, 'getuid', return_value=uid, create=True):
                    M.verifier_inputs(work, inputs)
                    if mutation == 'bytes':
                        copied.write_bytes(b'changed source')
                    elif mutation == 'replacement':
                        replacement = work / 'replacement'; replacement.write_bytes(copied.read_bytes()); os.replace(replacement, copied)
                    elif mutation == 'hardlink':
                        os.link(copied, work / 'linked-source')
                    elif mutation == 'extra':
                        (work / 'source/unreviewed').write_bytes(b'unknown')
                    elif mutation == 'key-pin':
                        inputs[M.VERIFIER_KEY]['pin'] = pin(b'changed key')
                    else:
                        del inputs[M.VERIFIER_CRATE + '/src/lib.rs']
                    with self.assertRaises(RuntimeError):
                        M.verifier_inputs(work, inputs)

    def test_compiler_binding_requires_199_native_host_and_unchanged_images(self):
        compilers = {name: {'path': '/fixture/1.99.0-x86_64-unknown-linux-gnu/bin/' + name,
            'record': {'known': name}, 'stamp': [1], 'version': name + ' 1.99.0 (reviewed)\n' + (
                'release: 1.99.0\nhost: x86_64-unknown-linux-gnu\n' if name == 'rustc' else '')} for name in ('cargo', 'rustc')}
        with patch.object(M.P, 'record', side_effect=lambda file: {'known': file.name}), patch.object(Path, 'lstat', return_value=None), \
                patch.object(M.P, 'stamp', return_value=(1,)):
            M.verifier_compilers(compilers)
            for field, value in (('path', '/fixture/1.98.0-x86_64-unknown-linux-gnu/bin/rustc'), ('version', 'rustc 1.98.0'), ('stamp', [2])):
                changed = copy.deepcopy(compilers); changed['rustc'][field] = value
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    M.verifier_compilers(changed)

    def test_mocked_build_captures_real_two_link_cargo_output_into_strict_fresh_verifier(self):
        for mutation in ('none', 'during-read', 'destination-occupied'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve(); repo, work = root / 'checkout', root / 'verifier'
                values = {M.VERIFIER_SOURCE: b'unchanged example', M.VERIFIER_KEY: b'compiled key',
                          M.VERIFIER_CRATE + '/Cargo.lock': b'locked dependencies', M.VERIFIER_CRATE + '/Cargo.toml': b'fixed example entry',
                          M.VERIFIER_CRATE + '/src/lib.rs': b'fixed library'}
                for name, raw in values.items():
                    file = repo / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(raw)
                toolchain = root / '1.99.0-x86_64-unknown-linux-gnu/bin'; toolchain.mkdir(parents=True)
                for name in ('cargo', 'rustc'):
                    (toolchain / name).write_bytes(b'compiler fixture ' + name.encode())
                compiled = work / 'target/debug/examples/verify-package-input'
                alias = work / 'target/debug/examples/verify_package_input-hash'
                copied = work / 'verify-package-input'
                cargo_bytes = b'OWNED CARGO OUTPUT; this structural test never executes it'
                build_calls = []
                def command(args, **kwargs):
                    if args[:3] == ['/usr/bin/git', 'ls-tree', '-r']:
                        return ('\0'.join(sorted(values)) + '\0').encode()
                    if args[:2] == ['/usr/bin/git', 'show']:
                        return values[args[2].split(':', 1)[1]]
                    if args == ['/usr/bin/which', 'rustup']:
                        return str(root / 'rustup').encode() + b'\n'
                    if args[1:4] == ['which', '--toolchain', '1.99.0']:
                        return str(toolchain / args[-1]).encode() + b'\n'
                    if args[-1] == '-Vv':
                        name = Path(args[0]).name
                        return (name + ' 1.99.0 (fixture)\n' + ('release: 1.99.0\nhost: x86_64-unknown-linux-gnu\n' if name == 'rustc' else '')).encode()
                    self.assertEqual(args[:3], [str(toolchain / 'cargo'), 'build', '--locked'])
                    self.assertEqual(kwargs['cwd'], work / 'source')
                    build_calls.append(args)
                    compiled.parent.mkdir(parents=True); compiled.write_bytes(cargo_bytes); compiled.chmod(0o755)
                    os.link(compiled, alias)
                    self.assertEqual(original_lstat(compiled).st_nlink, 2)
                    if mutation == 'destination-occupied':
                        copied.write_bytes(b'unknown preexisting output')
                    return b''
                original_lstat, original_fstat, original_read, original_open = Path.lstat, M.os.fstat, M.os.read, M.os.open
                def native_open(file, flags, *args, **kwargs):
                    # Model Linux byte reads; Windows CRT otherwise translates saved JSON CRLFs.
                    return original_open(file, flags | (getattr(os, 'O_BINARY', 0) if sys.platform == 'win32' else 0), *args, **kwargs)
                def native_mode(value, path):
                    if sys.platform != 'win32':
                        return value
                    # NTFS lacks POSIX executable bits. Only mode is adapted; IDs, links and bytes are real.
                    mode = 0o700 if path == work else 0o755 if path in (compiled, alias, copied) else 0o600 if path == work / 'receipt.json' else None
                    if mode is None:
                        return value
                    fields = ('st_dev', 'st_ino', 'st_size', 'st_uid', 'st_gid', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')
                    return SimpleNamespace(**{name: getattr(value, name) for name in fields},
                                           st_mode=(stat.S_IFDIR if path == work else stat.S_IFREG) | mode)
                def lstat(path):
                    return native_mode(original_lstat(path), path)
                def fstat(fd):
                    value = original_fstat(fd)
                    for path in (compiled, copied, work / 'receipt.json'):
                        try:
                            if original_lstat(path).st_ino == value.st_ino:
                                return native_mode(value, path)
                        except FileNotFoundError:
                            pass
                    return value
                def read(fd, size):
                    data = original_read(fd, size)
                    if mutation == 'during-read' and data and compiled.exists() and original_fstat(fd).st_ino == original_lstat(compiled).st_ino:
                        with alias.open('ab') as stream:
                            stream.write(b'changed while held')
                    return data
                uid = original_lstat(repo).st_uid
                with patch.object(M, 'HERE', repo / 'scripts'), patch.object(M, 'verifier_root', return_value=work), \
                        patch.object(M, 'VERIFIER_PINS', {name: pin(values[name]) for name in M.VERIFIER_PINS}), \
                        patch.object(M, 'command', side_effect=command), patch.dict(M.os.environ, {'GITHUB_SHA': 'a' * 40, 'HOME': str(repo)}), \
                        patch.object(M.os, 'getuid', return_value=uid, create=True), patch.object(Path, 'lstat', lstat), \
                        patch.object(M.os, 'fstat', side_effect=fstat), patch.object(M.os, 'read', side_effect=read), \
                        patch.object(M.os, 'open', side_effect=native_open):
                    if mutation == 'none':
                        M.build_signature_verifier()
                        self.assertEqual(M.signature_verifier(), copied)
                        self.assertEqual(M.regular(copied, 64 * 1024 * 1024, 0o755), cargo_bytes)
                        self.assertEqual(original_lstat(copied).st_nlink, 1)
                        self.assertNotEqual(original_lstat(copied).st_ino, original_lstat(compiled).st_ino)
                        self.assertEqual(original_lstat(compiled).st_nlink, 2)
                        with self.assertRaises(RuntimeError):
                            M.regular(compiled, 64 * 1024 * 1024, 0o755)
                        alias.write_bytes(b'original aliases can change without changing the fresh copy')
                        self.assertEqual(M.regular(copied, 64 * 1024 * 1024, 0o755), cargo_bytes)
                    else:
                        with self.assertRaises((RuntimeError, FileExistsError)):
                            M.build_signature_verifier()
                        self.assertFalse((work / 'receipt.json').exists())
                        if mutation == 'destination-occupied':
                            self.assertEqual(copied.read_bytes(), b'unknown preexisting output')
                        else:
                            self.assertFalse(copied.exists())
                self.assertEqual(len(build_calls), 1)

    def test_signature_call_is_fixed_bounded_repeated_and_refuses_uncertain_or_changed_inputs(self):
        for outcome in ('valid', 'tool-refused', 'wrong-answer', 'metadata-changed', 'tool-changed', 'oversized'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve(); metadata, signature = root / 'metadata', root / 'metadata.minisig'
                raw = b'signed metadata' if outcome != 'oversized' else b'x' * (M.VERIFIER_LIMIT + 1)
                metadata.write_bytes(raw); signature.write_bytes(b'plain signature')
                tool, calls, checks = root / 'fixed-verifier', [], []
                def verifier():
                    checks.append('checked')
                    M.require(outcome != 'tool-changed' or len(checks) == 1, 'Verifier executable identity changed')
                    return tool
                def command(args, **kwargs):
                    calls.append(args)
                    self.assertEqual(args, [str(tool), str(metadata), str(signature)])
                    if outcome == 'tool-refused':
                        raise RuntimeError('Signature refused')
                    if outcome == 'metadata-changed':
                        metadata.write_bytes(b'changed after verification')
                    return b'wrong bytes' if outcome == 'wrong-answer' else (
                        'Verified trusted package signature: ' + hashlib.sha256(raw).hexdigest() + '. No activation or client changes.\n').encode()
                with patch.object(M, 'signature_verifier', side_effect=verifier), patch.object(M, 'command', side_effect=command), \
                        patch.object(M.os, 'getuid', return_value=metadata.lstat().st_uid, create=True):
                    if outcome == 'valid':
                        M.verify_catalogue_signature(metadata, signature)
                        self.assertEqual(len(checks), 2)
                    else:
                        with self.assertRaises(RuntimeError):
                            M.verify_catalogue_signature(metadata, signature)
                self.assertEqual(len(calls), 0 if outcome == 'oversized' else 1)

    def test_missing_verifier_receipt_stops_before_tool_execution(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(M, 'verifier_root', return_value=Path(directory).resolve()), \
                patch.object(M, 'command') as command:
            with self.assertRaises(FileNotFoundError):
                M.signature_verifier()
            command.assert_not_called()

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
            receipt = M.parse(next((root / 'evidence').glob('tool-*.json')).read_bytes())
            self.assertIsNone(receipt['exitCode'])

    def test_overlapping_outer_and_inner_tool_captures_get_distinct_reserved_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); seen = set()
            child = SimpleNamespace(pid=99, poll=lambda: 0, wait=lambda timeout: 0)
            def capture(child, evidence, label):
                if label in seen:
                    raise FileExistsError('Capture already owns this output prefix')
                seen.add(label)
                if len(seen) == 1:
                    self.assertEqual(M.command([str(root / 'inner-tool')]), b'fixture')
                return SimpleNamespace(items={'stdout': {'kept': b'fixture'}}, pump=lambda *args: None, close=lambda: None,
                    metadata=lambda: {'stdout': {'bytes': 7, 'eof': True, 'truncated': False}})
            with patch.object(M, 'locations', return_value=root), patch.object(M.os, 'getuid', return_value=root.stat().st_uid, create=True), \
                    patch.object(M.P, 'helpers', return_value=(None, SimpleNamespace(Capture=capture))), \
                    patch.object(M.subprocess, 'Popen', return_value=child):
                self.assertEqual(M.command([str(root / 'outer-tool')]), b'fixture')
            self.assertEqual(len(seen), 2)
            self.assertEqual(len(list((root / 'evidence').glob('tool-*.json'))), 2)

    def test_separate_execution_request_refuses_before_review_network_or_installation(self):
        with patch.dict(M.os.environ, {"EXECUTION_REQUEST": "inspect-only"}, clear=True), patch.object(M, "regular") as read, \
                patch.object(M, "bootstrap_transport_ready") as network, patch.object(M, "command") as command:
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
                return {"pid": 99, "name": ':1.99'}
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
            property=lambda window, name: (33, 32, [101]), dispose=lambda: None,
            inspect=lambda window: {'pid': 99, 'client': 901, 'title': 'Creator Hub', 'mapped': True})
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
                    patch.object(M, 'bootstrap_feed', return_value=SimpleNamespace(proxy='http://127.0.0.1:12345', finish=lambda: None)), \
                    patch.object(M, 'finish_bootstrap_feed'), \
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

    def test_tls_proxy_is_internal_loopback_only_and_not_inherited_by_native_activation(self):
        self.assertEqual(M.loopback_proxy('http://127.0.0.1:12345'), 'http://127.0.0.1:12345')
        for value in ('https://127.0.0.1:12345', 'http://localhost:12345', 'http://127.0.0.1:0',
                      'http://127.0.0.1:65536', 'http://user@127.0.0.1:12345', 'http://127.0.0.1:12345/path', None):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                M.loopback_proxy(value)
        with patch.dict(M.os.environ, {**ENV, 'HOME': '/real-home', 'GH_TOKEN': 'never-copy', 'HTTPS_PROXY': 'http://foreign'}, clear=True):
            clean = M.lab_environment(Path('/private/fixture'))
            self.assertNotIn('GH_TOKEN', clean); self.assertNotIn('HTTPS_PROXY', clean)
            self.assertEqual(clean['HOME'], str(Path('/private/fixture') / 'home'))

    def test_native_tls_guard_arms_before_publication_and_cleans_on_eof_failure_or_unexpected_control(self):
        root = Path('/private/fixture')
        arm = {'before': {'synthetic': True}, 'certificate': pin(b'public test certificate')}
        for outcome in ('normal-eof', 'parent-died-before-install', 'publish-failed', 'extra-control'):
            events = []
            def command(args, **kwargs):
                events.append('publish' if M.TLS_PUBLISH in args else 'refresh')
                if outcome == 'publish-failed':
                    raise RuntimeError('synthetic publication failure')
            def printed(raw, **kwargs):
                events.append(M.parse(raw)['kind'])
            incoming = [b'', b''] if outcome == 'parent-died-before-install' else [b'install\n', b'wrong' if outcome == 'extra-control' else b'']
            with self.subTest(outcome=outcome), patch.dict(M.os.environ, {'EXECUTION_REQUEST': M.REQUEST}, clear=True), \
                    patch.object(M, 'tls_lock'), patch.object(M, 'tls_arm', return_value=(arm, b'arm')), \
                    patch.object(M, 'trust_view', return_value=arm['before']), patch.object(M.os.path, 'lexists', return_value=False), \
                    patch.object(M, 'protected_trust_parent'), patch.object(M, 'bound', return_value=b'public test certificate'), \
                    patch.object(M, 'command', side_effect=command), patch.object(M, 'cleanup_owned_tls', side_effect=lambda *args: events.append('cleanup')) as cleanup, \
                    patch.object(M.os, 'fstat', return_value=SimpleNamespace(st_mode=stat.S_IFIFO)), \
                    patch.object(M.os, 'read', side_effect=incoming), patch.object(M.select, 'select', return_value=([0], [], [])), \
                    patch('builtins.print', side_effect=printed):
                if outcome == 'normal-eof':
                    M.tls_guard(root)
                    self.assertEqual(events, ['tls-cleanup-armed', 'publish', 'refresh', 'tls-installed', 'cleanup'])
                else:
                    with self.assertRaises(RuntimeError):
                        M.tls_guard(root)
                    self.assertEqual(events[0], 'tls-cleanup-armed')
                    self.assertEqual(events[-1], 'cleanup')
                    if outcome == 'parent-died-before-install':
                        self.assertNotIn('publish', events)
                cleanup.assert_called_once_with(root, arm, b'arm')

    def test_cleanup_without_publication_verifies_beforeimage_without_privileged_commands(self):
        root, before = Path('/private/fixture'), {'synthetic': True}
        arm = {'before': before, 'certificate': pin(b'public')}
        expected = {'schemaVersion': 1, 'profile': '016-bootstrap', 'cleanupVerified': True,
                    'publicDiscovery': False, 'releaseReady': False, 'scope': 'disposable-github-ci-only'}
        with patch.object(M, 'regular', return_value=b'arm'), patch.object(M, 'bound'), patch.object(M, 'protected_trust_parent'), \
                patch.object(M.os.path, 'lexists', return_value=False), patch.object(M, 'trust_view', return_value=before), \
                patch.object(Path, 'exists', return_value=False), patch.object(M, 'save') as save, patch.object(M, 'command') as command:
            self.assertEqual(M.cleanup_owned_tls(root, arm, b'arm'), expected)
            command.assert_not_called(); save.assert_called_once_with(root / 'tls-cleanup.json', expected)
        with patch.object(M, 'regular', return_value=b'changed arm'), patch.object(M, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'Cleanup authority changed'):
                M.cleanup_owned_tls(root, arm, b'arm')
            command.assert_not_called()

    def test_foreign_certificate_and_unrestored_trust_do_not_get_cleanup_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); destination = root / 'foreign.crt'; destination.write_bytes(b'foreign')
            arm = {'certificate': pin(b'expected'), 'before': {'synthetic': True}}
            original_stat = Path.lstat
            def lstat(file):
                if file == destination:
                    return SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_gid=0, st_nlink=1, st_size=7)
                return original_stat(file)
            with patch.object(M, 'TLS_DESTINATION', destination), patch.object(M, 'regular', return_value=b'arm'), \
                    patch.object(M, 'bound'), patch.object(M, 'protected_trust_parent'), patch.object(Path, 'lstat', lstat), \
                    patch.object(M, 'command') as command, patch.object(M, 'save') as save:
                with self.assertRaisesRegex(RuntimeError, 'Foreign/replaced'):
                    M.cleanup_owned_tls(root, arm, b'arm')
                self.assertEqual(destination.read_bytes(), b'foreign')
                command.assert_not_called(); save.assert_not_called()
            destination.unlink()
            with patch.object(M, 'TLS_DESTINATION', destination), patch.object(M, 'regular', return_value=b'arm'), \
                    patch.object(M, 'bound'), patch.object(M, 'protected_trust_parent'), patch.object(M, 'trust_view', return_value={'changed': True}), \
                    patch.object(M, 'save') as save:
                with self.assertRaisesRegex(RuntimeError, 'before-image was not restored'):
                    M.cleanup_owned_tls(root, arm, b'arm')
                save.assert_not_called()

    def test_lab_readiness_waits_for_a_complete_frame_not_a_partial_json_chunk(self):
        child = object.__new__(M.LabChild); child.lines = 0
        child.child = SimpleNamespace(pid=99, poll=lambda: None)
        output = {'stdout': {'kept': bytearray()}}
        frames = iter((b'{"kind":"ready"', b',"pid":99}\n'))
        child.capture = SimpleNamespace(items=output, pump=lambda *args: output['stdout']['kept'].extend(next(frames)))
        self.assertEqual(child.expect('ready'), {'kind': 'ready', 'pid': 99})

    def test_tls_lease_source_order_is_data_first_armed_before_install_and_cleanup_on_all_exits(self):
        source = Path(M.__file__).read_text()
        tree = ast.parse(source)
        functions = {node.name: ast.get_source_segment(source, node) for node in tree.body if isinstance(node, ast.FunctionDef)}
        prepare = functions['prepare_tls']
        ordered = ['verified_review(', 'bootstrap_inspect(', "'/usr/bin/openssl'", "'armed.json'", 'os.fsync(',
                   'guard = LabChild(', "guard.expect('tls-cleanup-armed')", "guard.send(b'install\\n')", "guard.expect('tls-installed'"]
        cursor = -1
        for item in ordered:
            cursor = prepare.index(item, cursor + 1)
        guard = functions['tls_guard']
        self.assertLess(guard.index("'tls-cleanup-armed'"), guard.index('TLS_PUBLISH,'))
        self.assertIn('finally:\n            cleanup_owned_tls(', guard)
        session = functions['session']
        self.assertLess(session.index('verified_review('), session.index('prepare_tls('))
        self.assertLess(session.index('prepare_tls('), session.index('"/usr/bin/xvfb-run"'))
        self.assertIn('finally:\n        try:\n            guard.finish()\n        finally:\n            verify_tls_cleanup(root)', session)

    def test_data_signature_and_repeated_review_precede_all_native_installs(self):
        tree = ast.parse(Path(M.__file__).read_text())
        functions = {node.name: ast.get_source_segment(Path(M.__file__).read_text(), node) for node in tree.body if isinstance(node, ast.FunctionDef)}
        stage = functions['stage']
        self.assertLess(stage.index('node("verify-staged")'), stage.index('build_signature_verifier('))
        self.assertLess(stage.index('build_signature_verifier('), stage.index('verify_catalogue_signature('))
        self.assertLess(stage.index('verify_catalogue_signature('), stage.index('verify_tar('))
        self.assertNotIn('flatpak", "--user", "install', stage)
        session = functions['session']
        boundaries = ['EXECUTION_REQUEST', 'verified_review(',
                      '"remote-add"', '"remote-info"', '"install"', '"--bundle"', '"--show-metadata"', '"/usr/bin/xvfb-run"']
        cursor = -1
        for value in boundaries:
            cursor = session.index(value, cursor + 1)
        review = functions['verified_review']
        self.assertLess(review.index('node("verify-staged"'), review.index('verify_catalogue_signature('))
        self.assertLess(review.index('verify_catalogue_signature('), review.index('verify_tar('))
        build = functions['build_signature_verifier']
        for required in ('"ls-tree"', 'commit + ":" + name', 'verifier_inputs(work, inputs)', 'verifier_compilers(compilers)',
                         '"--locked"', '"--no-default-features"', '"CARGO_HOME"', '"RUSTC"', '"--example", "verify-package-input"', 'cwd=source'):
            self.assertIn(required, build)
        self.assertNotIn('cargo install', build)
        run = functions['run_session']
        self.assertLess(run.index('verified_review('), run.index('Session(root, review)'))
        source = Path(M.__file__).read_text()
        setup = source[source.index('    def setup(self):'):source.index('    def review_resume_once(')]
        self.assertLess(setup.index('bootstrap_transport_ready('), setup.index('self.driver.request("POST", "/session"'))
        self.assertIn("'HTTPS_PROXY': proxy", setup)
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
        self.assertEqual(workflow.count('dtolnay/rust-toolchain@1.99.0'), 1)
        self.assertLess(workflow.index('dtolnay/rust-toolchain@1.99.0'), workflow.index('.py stage'))
        self.assertNotIn('--no-install-recommends minisign', workflow)
        self.assertLess(workflow.index('.py stage'), workflow.index('node --test scripts/linux-update-lab-feed.test.cjs'))
        self.assertIn('if: always()\n        run: /usr/bin/python3 -B scripts/native-linux-production-016-flatpak.py tls-cleanup', workflow)
        self.assertLess(workflow.index('.py tls-cleanup'), workflow.index('actions/upload-artifact'))
        for bad in ('contents: write', 'actions: write', 'gh release', 'build:unified', '--no-gpg-verify', '--filesystem=home',
                    'flatpak-spawn', '--socket=session-bus'):
            self.assertNotIn(bad, workflow)
        source = Path(M.__file__).read_text()
        for bad in ('execute/sync', 'execute_async', 'eval(', '.kill(', '.terminate(', 'os.kill(', 'pkill', '--command=', 'flatpak-spawn',
                    'CERT_NONE', 'check_hostname = False', 'danger_accept_invalid'):
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


class DiagnosticTests(unittest.TestCase):
    def test_trust_diff_keeps_only_bounded_public_metadata_and_never_claims_cleanup(self):
        before = {'system/original.pem': {'link': '/private/DO-NOT-RETAIN'},
                  'system/ca-certificates.crt': {**pin(b'old'), 'mode': 0o644, 'uid': 0, 'gid': 0}}
        after = {'system/creator-production-bootstrap016.pem': {'link': str(M.TLS_DESTINATION)},
                 'system/12345678.0': {'link': 'creator-production-bootstrap016.pem'},
                 'system/ca-certificates.crt': {**pin(b'changed'), 'mode': 0o644, 'uid': 0, 'gid': 0}}
        original = copy.deepcopy((before, after))
        result = M.trust_difference(before, after, True)
        self.assertEqual(result['counts'], {'added': 2, 'removed': 1, 'changed': 1})
        self.assertTrue(result['complete']); self.assertTrue(result['temporaryCertificateAbsent'])
        self.assertFalse(result['cleanupVerified']); self.assertTrue(result['readOnly'])
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))
        self.assertEqual(next(r for r in result['entries'] if r['name'].endswith('original.pem'))['before']['targetSha256'],
                         hashlib.sha256(b'/private/DO-NOT-RETAIN').hexdigest())
        self.assertEqual((before, after), original)
        limited = M.trust_difference({}, {f'system/{n}.pem': {'link': 'unknown'} for n in range(100)}, False)
        self.assertEqual(len(limited['entries']), 64); self.assertFalse(limited['complete'])
        self.assertLess(len(M.json_bytes(limited)), 65536)

    def test_trust_diff_skips_unchanged_unicode_names_and_redacts_changed_unknown_names(self):
        name = 'system/NetLock_Arany_=Class_Gold=_F\u0151tan\u00fas\u00edtv\u00e1ny.pem'
        private = 'system/DO-NOT-RETAIN=\u00e9.pem'
        before = {name: {'link': '/private/UNCHANGED-TARGET'}}
        after = {**before, private: {'link': '/private/CHANGED-TARGET'},
                 'system/creator-production-bootstrap016.pem': {'link': str(M.TLS_DESTINATION)}}
        result = M.trust_difference(before, after, True)
        self.assertEqual(result['counts'], {'added': 2, 'removed': 0, 'changed': 0})
        self.assertTrue(result['complete'])
        redacted = next(row for row in result['entries'] if row.get('nameRedacted'))
        self.assertNotIn('name', redacted)
        self.assertEqual(redacted['nameSha256'], hashlib.sha256(private.encode()).hexdigest())
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))
        self.assertNotIn('CHANGED-TARGET', json.dumps(result))
        self.assertNotIn('UNCHANGED-TARGET', json.dumps(result))
        limited = M.trust_difference({}, {f'system/{n}=DO-NOT-RETAIN\u00e9.pem': {'link': 'private'} for n in range(100)}, True)
        self.assertEqual(limited['counts']['added'], 100)
        self.assertEqual(len(limited['entries']), 64)
        self.assertFalse(limited['complete'])
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(limited))
        self.assertLess(len(M.json_bytes(limited)), 65536)

    def test_trust_bundle_pins_and_certificate_absence_do_not_depend_on_entry_names(self):
        bundle = {**pin(b'original bundle'), 'mode': 0o644, 'uid': 0, 'gid': 0}
        before = {'system/ca-certificates.crt': bundle, 'local/unchanged=\u00e9.crt': bundle}
        for changed in (False, True):
            after = {**before, 'system/unknown=\u00e9.pem': {'link': 'private/DO-NOT-RETAIN'}}
            if changed:
                after['system/ca-certificates.crt'] = {**bundle, **pin(b'different bundle')}
            result = M.trust_difference(before, after, not changed)
            self.assertEqual(result['bundle']['before'], pin(b'original bundle'))
            self.assertEqual(result['bundle']['after'], pin(b'different bundle' if changed else b'original bundle'))
            self.assertIs(result['bundle']['bytesEqual'], not changed)
            self.assertIs(result['temporaryCertificateAbsent'], not changed)
            self.assertFalse(result['cleanupVerified'])
        missing = M.trust_difference({}, {}, True)
        self.assertEqual(missing['bundle'], {'before': None, 'after': None, 'bytesEqual': False})
        redirected = M.trust_difference(before, {**before, 'system/ca-certificates.crt': {'link': '/private/DO-NOT-RETAIN'}}, True)
        self.assertEqual(redirected['bundle'], {'before': pin(b'original bundle'), 'after': None, 'bytesEqual': False})
        self.assertEqual(redirected['counts']['changed'], 1)
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(redirected))

    def test_cleanup_with_unchanged_unicode_ca_still_retains_diff_and_original_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            before = {'system/unchanged=\u00e9.pem': {'link': 'private/DO-NOT-RETAIN'}}
            after = {**before, 'system/creator-production-bootstrap016.pem': {'link': str(M.TLS_DESTINATION)}}
            arm = {'before': before, 'certificate': pin(b'public')}
            with patch.object(M, 'regular', return_value=b'arm'), patch.object(M, 'bound'), \
                    patch.object(M, 'protected_trust_parent'), patch.object(M.os.path, 'lexists', return_value=False), \
                    patch.object(M, 'trust_view', return_value=after), patch.object(M, 'command') as command:
                with self.assertRaisesRegex(RuntimeError, '^CI trust before-image was not restored$'):
                    M.cleanup_owned_tls(root, arm, b'arm')
                command.assert_not_called()
            result = json.loads((root / 'tls-trust-diff-1-gtk.json').read_text())
            self.assertTrue(result['temporaryCertificateAbsent'])
            self.assertEqual(result['counts']['added'], 1)
            self.assertFalse(result['cleanupVerified'])

    def test_cleanup_retains_first_two_diffs_but_still_raises_original_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); before = {'system/old.pem': {'link': 'original'}}
            after = {**before, 'system/creator-production-bootstrap016.pem': {'link': str(M.TLS_DESTINATION)}}
            arm = {'before': before, 'certificate': pin(b'public')}
            with patch.object(M, 'regular', return_value=b'arm'), patch.object(M, 'bound'), \
                    patch.object(M, 'protected_trust_parent'), patch.object(M.os.path, 'lexists', return_value=False), \
                    patch.object(M, 'trust_view', return_value=after), patch.object(M, 'command') as command:
                for _ in range(3):
                    with self.assertRaisesRegex(RuntimeError, 'CI trust before-image was not restored'):
                        M.cleanup_owned_tls(root, arm, b'arm')
                command.assert_not_called()
            files = sorted(root.iterdir())
            self.assertEqual([f.name for f in files], ['tls-trust-diff-1-gtk.json', 'tls-trust-diff-2-gtk.json'])
            self.assertTrue(all(json.loads(f.read_text())['counts']['added'] == 1 for f in files))
            with patch.object(M, 'regular', return_value=b'arm'), patch.object(M, 'bound'), \
                    patch.object(M, 'protected_trust_parent'), patch.object(M.os.path, 'lexists', return_value=False), \
                    patch.object(M, 'trust_view', return_value=after), patch.object(M, 'trust_difference', side_effect=RuntimeError('DO-NOT-RETAIN')):
                with self.assertRaisesRegex(RuntimeError, '^CI trust before-image was not restored$'):
                    M.cleanup_owned_tls(root, arm, b'arm')

    def test_runtime_path_filter_does_not_export_foreign_names_or_arguments(self):
        runtime = '/private/fixture/runtime'
        for name in ('/run/flatpak/at-spi-bus', '/run/flatpak/bus',
                     runtime + '/.dbus-proxy/a11y-bus-proxy-Ab1234', '/run/user/1001/.dbus-proxy/session-bus-proxy-ABC123'):
            self.assertEqual(M.proxy_runtime_path(name, runtime, 1001), name)
        for name in ('/private/DO-NOT-RETAIN', runtime + '/.dbus-proxy/../secret', 'unix:path=/private/secret',
                     '/run/user/1002/.dbus-proxy/a11y-bus-proxy-Ab1234'):
            self.assertIsNone(M.proxy_runtime_path(name, runtime, 1001))
        raw = (b'Num RefCount Protocol Flags Type St Inode Path\n'
               b'0000: 00000002 00000000 00010000 0001 01 50 /private/DO-NOT-RETAIN\n'
               b'0000: 00000002 00000000 00010000 0001 01 51 /private/fixture/runtime/.dbus-proxy/a11y-bus-proxy-Ab1234\n'
               b'0000: 00000002 00000000 00010000 0001 01 52 /private/FOREIGN-ROW\n')
        rows = M.proxy_unix_rows(raw, {50, 51}, runtime, 1001)
        self.assertEqual([r['inode'] for r in rows], [50, 51]); self.assertNotIn('DO-NOT-RETAIN', json.dumps(rows))
        self.assertNotIn('FOREIGN-ROW', json.dumps(rows)); self.assertIn('pathSha256', rows[0])
        self.assertEqual(rows[1]['runtimePath'], runtime + '/.dbus-proxy/a11y-bus-proxy-Ab1234')
        with self.assertRaises(RuntimeError): M.proxy_unix_rows(b'x' * (512 * 1024 + 1), set(), runtime, 1001)

    def proxy_fixture(self):
        rows = {pid: {'pid': pid, 'parentPid': parent, 'startTime': str(pid), 'uids': [1001] * 4,
                      'executable': image, 'image': {'st_size': '64'}} for pid, parent, image in
                ((10, 9, '/usr/bin/flatpak'), (11, 10, '/usr/bin/bwrap'),
                 (12, 11, '/usr/bin/xdg-dbus-proxy'), (13, 10, '/usr/bin/bwrap'),
                 (14, 13, '/app/bin/creator-hub-flatpak-activate'))}
        session = object.__new__(M.Session); session.root = Path('/private/fixture'); session.helper = None
        session.flatpak_launch = copy.deepcopy(rows[10])
        session.flatpak_popen = {'pid': 10, 'startTime': '10'}
        def process(pid, helper, full=True):
            value = copy.deepcopy(rows[pid])
            if full: value['kernelImageSha256'] = str(pid % 10) * 64
            return value
        session.native = SimpleNamespace(native_process=process)
        return session, rows, process(14, None), {'owner': ':1.0', 'pid': 12, 'uid': 1001}

    def test_proxy_capture_records_exact_owned_topology_without_granting_input(self):
        session, rows, client, peer = self.proxy_fixture()
        details = {'namespacePids': [14, 2], 'sockets': [], 'unixRows': [], 'runtimeObjects': []}
        with patch.object(M.P, 'subtree', return_value=rows), patch.object(M, 'proxy_process_io', return_value=details) as io_capture, \
                patch.object(M.os, 'getuid', return_value=1001, create=True):
            result = session.proxy_attribution(client, peer)
        self.assertTrue(result['stable']); self.assertFalse(result['inputPermitted']); self.assertFalse(result['qualified'])
        self.assertEqual(result['launch']['pid'], 10); self.assertEqual(result['peer']['pid'], 12)
        self.assertEqual([(r['pid'], r['parentPid']) for r in result['subtree']], [(10, 9), (11, 10), (12, 11), (13, 10), (14, 13)])
        self.assertEqual(io_capture.call_count, 2)
        with self.assertRaises(RuntimeError): M.ax_identity(peer, 12, client, [14, 2], 1001)

    def test_proxy_capture_distinguishes_previously_ambiguous_failure_stages(self):
        for failure in ('client-identity', 'launch-identity', 'subtree'):
            session, rows, client, peer = self.proxy_fixture()
            process = session.native.native_process
            launch_reads = []
            def read(pid, helper, full=True):
                if pid == 10 and not full:
                    launch_reads.append(pid)
                    if failure == 'launch-identity' and len(launch_reads) == 2:
                        raise RuntimeError('/private/DO-NOT-RETAIN')
                if failure == 'client-identity' and pid == 14:
                    raise RuntimeError('/private/DO-NOT-RETAIN')
                return process(pid, helper, full)
            session.native.native_process = read
            with self.subTest(failure=failure), patch.object(M.os, 'getuid', return_value=1001, create=True), \
                    patch.object(M.P, 'subtree', side_effect=RuntimeError('/private/DO-NOT-RETAIN') if failure == 'subtree' else None,
                                 return_value=rows):
                result = session.proxy_attribution(client, peer)
            self.assertEqual(result['failureStage'], failure)
            self.assertIn(result['failureStage'], M.PROXY_CAPTURE_STAGES)
            self.assertEqual(result['unavailable'], 'RuntimeError')
            self.assertFalse(result['expectedLaunch']['verified'])
            self.assertFalse(result['currentLaunch']['verified'])
            self.assertEqual(result['popenIdentity'], {'pid': 10, 'startTime': '10', 'verified': False})
            self.assertEqual(result['currentLaunch']['kernelImageSha256'], '0' * 64)
            self.assertTrue(result['proofProgress']['currentLaunchRecorded'])
            self.assertFalse(result['proofProgress']['subtreeCaptured'])
            self.assertFalse(result['stable']); self.assertFalse(result['inputPermitted'])
            self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))

    def test_proxy_capture_retains_redacted_partial_launch_records_without_blessing_replacement(self):
        session, rows, client, peer = self.proxy_fixture()
        session.flatpak_launch['executable'] = '/private/DO-NOT-RETAIN/expected'
        rows[10]['executable'] = '/private/DO-NOT-RETAIN/current'
        with patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.P, 'subtree') as subtree:
            result = session.proxy_attribution(client, peer)
        self.assertEqual(result['failureStage'], 'launch-identity')
        self.assertFalse(result['proofProgress']['currentLaunchMatchesExpected'])
        self.assertTrue(result['proofProgress']['clientStable'])
        self.assertNotIn('executable', result['expectedLaunch'])
        self.assertNotIn('executable', result['currentLaunch'])
        self.assertEqual(result['currentLaunch']['executableSha256'], hashlib.sha256(rows[10]['executable'].encode()).hexdigest())
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))
        self.assertFalse(result['currentLaunch']['verified']); self.assertFalse(result['qualified'])
        subtree.assert_not_called()

    def test_proxy_launch_capture_requires_independent_popen_and_bounds_current_image_reads(self):
        for failure in ('missing-popen', 'wrong-pid', 'reused-start', 'foreign-uid', 'oversize-image'):
            session, rows, client, peer = self.proxy_fixture()
            process = session.native.native_process
            if failure == 'missing-popen': session.flatpak_popen = None
            if failure == 'wrong-pid': session.flatpak_popen['pid'] = 999
            if failure == 'reused-start': rows[10]['startTime'] = '99'
            if failure == 'foreign-uid': rows[10]['uids'] = [1002] * 4
            if failure == 'oversize-image': rows[10]['image'] = {'st_size': str(64 * 1024 * 1024 + 1)}
            session.native.native_process = Mock(side_effect=process)
            with self.subTest(failure=failure), patch.object(M.os, 'getuid', return_value=1001, create=True), \
                    patch.object(M.P, 'subtree') as subtree:
                result = session.proxy_attribution(client, peer)
            self.assertFalse(result['stable']); self.assertFalse(result['inputPermitted']); self.assertFalse(result['qualified'])
            self.assertFalse(result['expectedLaunch']['verified'])
            subtree.assert_not_called()
            if failure in ('missing-popen', 'wrong-pid'):
                self.assertEqual(result['failureStage'], 'expected-launch')
                session.native.native_process.assert_not_called()
            elif failure == 'reused-start':
                self.assertEqual(result['failureStage'], 'launch-identity')
                self.assertEqual(result['currentLaunch']['startTime'], '99')
                self.assertFalse(result['currentLaunch']['verified'])
            else:
                self.assertEqual(result['failureStage'], 'current-launch')
                self.assertNotIn('currentLaunch', result)
                self.assertEqual(session.native.native_process.call_args_list, [unittest.mock.call(10, None, False)])

    def test_proxy_snapshot_copies_only_bounded_public_metadata_and_fixed_stage_categories(self):
        session, rows, _, _ = self.proxy_fixture()
        row = rows[10]
        row['executable'] = '/private/DO-NOT-RETAIN'
        row['rawArgv'] = ['DO-NOT-RETAIN']
        row['image']['private'] = 'DO-NOT-RETAIN'
        result = M.proxy_process_snapshot(row)
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))
        self.assertFalse(result['verified'])
        row['uids'][0] = 999
        row['image']['st_size'] = '999'
        self.assertEqual(result['uids'], [1001] * 4)
        self.assertEqual(result['image'], {'st_size': '64'})
        for mutation in ('path-limit', 'metadata-limit', 'uid-type'):
            invalid = copy.deepcopy(row)
            if mutation == 'path-limit': invalid['executable'] = 'x' * 4097
            if mutation == 'metadata-limit': invalid['image']['st_size'] = '1' * 21
            if mutation == 'uid-type': invalid['uids'][0] = True
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                M.proxy_process_snapshot(invalid)
        source = ast.parse((HERE / 'native-linux-production-016-flatpak.py').read_text(encoding='utf8'))
        capture = next(node for node in ast.walk(source) if isinstance(node, ast.FunctionDef) and node.name == 'proxy_attribution')
        stages = set()
        for node in ast.walk(capture):
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'stage' for target in node.targets):
                if isinstance(node.value, ast.Constant): stages.add(node.value.value)
                else: stages.update((node.value.body.value, node.value.orelse.value))
        self.assertEqual(stages, set(M.PROXY_CAPTURE_STAGES))

    def test_proxy_capture_partial_owned_subtree_progress_is_bounded_and_not_input_authority(self):
        session, rows, client, peer = self.proxy_fixture()
        rows[11]['executable'] = '/private/DO-NOT-RETAIN'
        class PrivateFailure(RuntimeError):
            pass
        with patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.P, 'subtree', return_value=rows), \
                patch.object(M, 'proxy_process_io', side_effect=PrivateFailure('/private/DO-NOT-RETAIN')):
            result = session.proxy_attribution(client, peer)
        self.assertEqual(result['failureStage'], 'client-io')
        self.assertEqual(result['unavailable'], 'OtherError')
        self.assertTrue(result['proofProgress']['subtreeCaptured'])
        self.assertTrue(result['proofProgress']['subtreeContainsClientAndPeer'])
        self.assertFalse(result['proofProgress']['subtreeRechecked'])
        self.assertEqual(len(result['subtree']), 5)
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(result)); self.assertNotIn('PrivateFailure', json.dumps(result))
        self.assertLess(len(M.json_bytes(result)), 65536)
        self.assertFalse(result['stable']); self.assertFalse(result['qualified']); self.assertFalse(result['inputPermitted'])

    def test_proxy_capture_refuses_foreign_reused_denied_or_oversize_topology_without_raw_error(self):
        for failure in ('foreign', 'reuse', 'denied', 'oversize'):
            session, rows, client, peer = self.proxy_fixture()
            changed = copy.deepcopy(rows)
            if failure == 'foreign': peer['pid'] = 999
            if failure == 'reuse': changed[12]['startTime'] = 'reused'
            if failure == 'oversize': rows.update({n: {**rows[11], 'pid': n} for n in range(20, 40)})
            captures = [rows, changed] if failure == 'reuse' else [rows, rows]
            with self.subTest(failure=failure), patch.object(M.P, 'subtree', side_effect=captures), \
                    patch.object(M, 'proxy_process_io', side_effect=PermissionError('DO-NOT-RETAIN') if failure == 'denied' else None,
                                 return_value={'sockets': [], 'runtimeObjects': []}) as capture, \
                    patch.object(M.os, 'getuid', return_value=1001, create=True):
                result = session.proxy_attribution(client, peer)
            self.assertFalse(result['stable']); self.assertFalse(result['inputPermitted']); self.assertFalse(result['qualified'])
            self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))
            if failure in ('foreign', 'oversize'): capture.assert_not_called()

    def test_proxy_capture_drops_oversize_payload_instead_of_retaining_a_failed_trace(self):
        session, rows, client, peer = self.proxy_fixture()
        with patch.object(M.P, 'subtree', return_value=rows), \
                patch.object(M, 'proxy_process_io', return_value={'sockets': [], 'private': 'DO-NOT-RETAIN' * 10000}), \
                patch.object(M.os, 'getuid', return_value=1001, create=True):
            result = session.proxy_attribution(client, peer)
        self.assertEqual(result['unavailable'], 'OutputLimit'); self.assertFalse(result['stable'])
        self.assertFalse(result['inputPermitted']); self.assertFalse(result['qualified']); self.assertFalse(result['peerPairingProven'])
        self.assertNotIn('DO-NOT-RETAIN', json.dumps(result)); self.assertLess(len(M.json_bytes(result)), 4096)
        self.assertFalse(result['expectedLaunch']['verified']); self.assertFalse(result['currentLaunch']['verified'])

    def test_proxy_proc_reader_captures_only_owned_socket_fds_and_runtime_objects(self):
        runtime = '/private/fixture/runtime'
        status = b'Name:\tDO-NOT-RETAIN\nNSpid:\t14\t2\n'
        unix = (b'Num RefCount Protocol Flags Type St Inode Path\n'
                b'0000: 00000002 00000000 00010000 0001 01 50 /private/DO-NOT-RETAIN\n'
                b'0000: 00000002 00000000 00010000 0001 01 51 /private/fixture/runtime/.dbus-proxy/a11y-bus-proxy-Ab1234\n')
        for mutation in ('none', 'fd-replaced', 'namespace-changed', 'too-many-fds'):
            opened, link_reads, mount_reads = {}, {}, []
            def info(file):
                name = file.as_posix(); mode = stat.S_IFLNK if '/fd/' in name else stat.S_IFSOCK if '/root/' in name else stat.S_IFREG
                return SimpleNamespace(st_dev=1, st_ino=5, st_size=0, st_mode=mode | 0o600,
                                       st_uid=1001, st_gid=1001, st_mtime_ns=1, st_ctime_ns=2)
            def open_file(file, flags):
                name = file.as_posix(); self.assertIn(name, ('/proc/14/status', '/proc/14/net/unix'))
                self.assertEqual(flags, M.os.O_RDONLY | M.os.O_NOFOLLOW | M.os.O_CLOEXEC | M.os.O_NONBLOCK)
                descriptor = 10000 + len(opened); opened[descriptor] = file; return descriptor
            def stream(descriptor, mode):
                self.assertEqual(mode, 'rb'); file = opened[descriptor]
                class Stream(io.BytesIO):
                    def fileno(self): return descriptor
                    def close(self): opened.pop(descriptor, None); super().close()
                return Stream(status if file.name == 'status' else unix)
            def readlink(file):
                name = file.as_posix(); link_reads[name] = link_reads.get(name, 0) + 1
                if name.endswith('/ns/mnt'):
                    mount_reads.append(name)
                    return 'mnt:[11]' if mutation == 'namespace-changed' and len(mount_reads) > 1 else 'mnt:[10]'
                if name.endswith('/fd/0'): return '/private/DO-NOT-RETAIN'
                return 'socket:[99]' if mutation == 'fd-replaced' and link_reads[name] > 1 else 'socket:[50]' if name.endswith('/3') else 'socket:[51]'
            class Scan:
                def __enter__(self):
                    return iter(SimpleNamespace(name=str(n)) for n in (range(129) if mutation == 'too-many-fds' else (0, 3, 4)))
                def __exit__(self, *_): pass
            with self.subTest(mutation=mutation), patch.object(Path, 'lstat', info), \
                    patch.object(M.os, 'O_NOFOLLOW', 0x100000, create=True), patch.object(M.os, 'O_CLOEXEC', 0x200000, create=True), \
                    patch.object(M.os, 'O_NONBLOCK', 0x400000, create=True), patch.object(M.os, 'open', side_effect=open_file), \
                    patch.object(M.os, 'fdopen', side_effect=stream), patch.object(M.os, 'fstat', side_effect=lambda fd: info(opened[fd])), \
                    patch.object(M.os, 'readlink', side_effect=readlink), patch.object(M.os, 'scandir', return_value=Scan()):
                if mutation == 'none':
                    value = M.proxy_process_io(14, runtime, 1001)
                    self.assertEqual(value['namespacePids'], [14, 2])
                    self.assertEqual(value['sockets'], [{'fd': 3, 'inode': 50}, {'fd': 4, 'inode': 51}])
                    self.assertEqual(len(value['runtimeObjects']), 3)
                    self.assertTrue(all(v['socket'] for v in value['runtimeObjects']))
                    self.assertNotIn('DO-NOT-RETAIN', json.dumps(value))
                else:
                    with self.assertRaises(RuntimeError): M.proxy_process_io(14, runtime, 1001)
            self.assertFalse(opened, 'Diagnostic proc reader leaked an FD')

    def test_real_dialog_refusal_stays_action_free_even_with_stable_proxy_diagnostics(self):
        session, rows, client, peer = self.proxy_fixture()
        app = SimpleNamespace(app=SimpleNamespace(bus_name=':1.0'), path='/org/a11y/atspi/accessible/root',
                              clear_cache=lambda: None, get_process_id=lambda: 12, get_name=lambda: 'creator-hub-flatpak-activate')
        refs, bus = SimpleNamespace(resolve=lambda _: peer), Mock()
        session.native.native_ax_references = lambda: (refs, bus)
        session.native.process_uids = lambda _: [1001] * 4
        session.helper = SimpleNamespace(children=lambda *_: [app])
        session.owned_window = Mock(side_effect=AssertionError('No input may be reached'))
        def wait(check, seconds):
            self.assertFalse(check()); raise RuntimeError('Read-only readiness deadline; no mutation retried')
        session.wait = wait
        atspi = SimpleNamespace(init=lambda: None, set_timeout=lambda *_: None, get_desktop=lambda _: None)
        modules = {'gi': SimpleNamespace(require_version=lambda *_: None), 'gi.repository': SimpleNamespace(Atspi=atspi)}
        with tempfile.TemporaryDirectory() as directory:
            session.root = Path(directory).resolve()
            with patch.dict(sys.modules, modules), patch.object(Path, 'read_bytes', return_value=b'NSpid:\t14\t2\n'), \
                    patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.P, 'subtree', return_value=rows), \
                    patch.object(M, 'proxy_process_io', return_value={'sockets': [], 'runtimeObjects': []}):
                with self.assertRaisesRegex(RuntimeError, 'Read-only readiness deadline'):
                    session.click_dialog(client, [], [], 'Cancel', 'disclosure-cancel')
            evidence = json.loads((session.root / 'disclosure-cancel-gtk.json').read_text())
        self.assertFalse(evidence['actionAttempted']); self.assertFalse(evidence['actionReturned'])
        self.assertTrue(evidence['proxyAttribution']['stable']); self.assertFalse(evidence['proxyAttribution']['qualified'])
        self.assertFalse(evidence['proxyAttribution']['peerPairingProven'])
        session.owned_window.assert_not_called(); bus.close_sync.assert_called_once_with(None)

    def test_existing_portal_pid_refusal_captures_proxy_but_still_returns_access_denied(self):
        session, rows, client, peer = self.proxy_fixture()
        session.portal_client, session.report = client, {}
        callback, bus = [], Mock()
        def call(*args):
            return SimpleNamespace(unpack=lambda: (1001 if args[3] == 'GetConnectionUnixUser' else 12 if args[3] == 'GetConnectionUnixProcessID' else 1,))
        bus.call_sync.side_effect = call
        bus.register_object.side_effect = lambda *args: callback.append(args[2]) or 1
        gio = SimpleNamespace(bus_get_sync=lambda *_: bus, BusType=SimpleNamespace(SESSION=1), DBusCallFlags=SimpleNamespace(NONE=0),
                              DBusNodeInfo=SimpleNamespace(new_for_xml=lambda _: SimpleNamespace(interfaces=[None])))
        glib = SimpleNamespace(Variant=lambda _, value: SimpleNamespace(unpack=lambda: value), VariantType=SimpleNamespace(new=lambda v: v))
        modules = {'gi.repository': SimpleNamespace(Gio=gio, GLib=glib)}
        with patch.dict(sys.modules, modules), patch.object(M.os, 'getuid', return_value=1001, create=True), \
                patch.object(M.P, 'subtree', return_value=rows), patch.object(M, 'proxy_process_io', return_value={'sockets': [], 'runtimeObjects': []}):
            _, _, calls = M.portal_capture(session)
            invocation = Mock()
            callback[0](bus, ':1.0', '', '', 'OpenURI', SimpleNamespace(unpack=lambda: ('', M.PORTAL_URL, {})), invocation)
        self.assertEqual(calls, []); invocation.return_value.assert_not_called()
        invocation.return_dbus_error.assert_called_once_with('org.freedesktop.DBus.Error.AccessDenied', 'Portal sender is not the bound signed launcher')
        self.assertTrue(session.report['portalAttribution']['stable']); self.assertFalse(session.report['portalAttribution']['inputPermitted'])
        self.assertFalse(session.report['portalAttribution']['qualified']); self.assertFalse(session.report['portalAttribution']['peerPairingProven'])
        capture = session.report['portalSenderRefusal']
        self.assertEqual(capture['failureStage'], 'sender-binding')
        self.assertEqual(capture['sender']['pid'], 12); self.assertEqual(capture['expectedClient']['pid'], 14)
        self.assertEqual(capture['observedSender']['executable'], '/usr/bin/xdg-dbus-proxy')
        self.assertTrue(capture['stable']); self.assertFalse(capture['authorityGranted']); self.assertFalse(capture['inputPermitted'])

    def test_portal_diagnostic_denied_or_replaced_image_is_unknown_and_does_not_grant_authority(self):
        for failure in ('denied', 'replaced', 'oversized'):
            session, rows, client, peer = self.proxy_fixture()
            session.portal_client = client
            native = session.native.native_process
            calls = []
            def observed(pid, helper, full=True):
                if pid == peer['pid']:
                    calls.append(full)
                    if failure == 'denied':
                        raise PermissionError('/private/DO-NOT-RETAIN')
                value = native(pid, helper, full)
                if pid == peer['pid'] and failure == 'oversized':
                    value['image']['st_size'] = str(64 * 1024 * 1024 + 1)
                if pid == peer['pid'] and failure == 'replaced' and len(calls) >= 3:
                    value['startTime'] = '999'
                return value
            session.native.native_process = observed
            with self.subTest(failure=failure), patch.object(M.os, 'getuid', return_value=1001, create=True):
                result = session.portal_sender_refusal(peer, 'sender-binding')
            self.assertFalse(result['stable']); self.assertFalse(result['authorityGranted']); self.assertFalse(result['inputPermitted'])
            self.assertIn('unavailable', result); self.assertNotIn('DO-NOT-RETAIN', json.dumps(result))
            self.assertLess(len(M.json_bytes(result)), 16384)
            if failure == 'oversized':
                self.assertEqual(calls, [False], 'Oversized peer image was hashed')


class AliasCleanupTests(unittest.TestCase):
    HASH = '99383ae7.0'
    PEM = 'creator-production-bootstrap016.pem'
    CERT = '/usr/local/share/ca-certificates/creator-production-bootstrap016.crt'

    @staticmethod
    def info(ino, mode, size=0, uid=0, nlink=1):
        return SimpleNamespace(st_dev=1, st_ino=ino, st_mode=mode, st_uid=uid, st_gid=uid,
                               st_nlink=nlink, st_size=size, st_mtime_ns=1, st_ctime_ns=2)

    def proof(self):
        links = {self.HASH: self.PEM, self.PEM: self.CERT}
        return {'directory': [1, 10, stat.S_IFDIR | 0o755, 0, 0], 'bundle': pin(b'original bundle'),
                'links': {name: list(M.P.stamp(self.info(20 + index, stat.S_IFLNK | 0o777, len(target)))) + [1]
                          for index, (name, target) in enumerate(links.items())}}

    @contextmanager
    def controller(self, failure=None):
        root = Path('/private/fixture')
        before = {'system/ca-certificates.crt': {**pin(b'original bundle'), 'mode': 0o644, 'uid': 0, 'gid': 0},
                  'system/original.pem': {'link': 'untouched'}}
        after = {**before, 'system/' + self.HASH: {'link': self.PEM}, 'system/' + self.PEM: {'link': self.CERT}}
        state = {'marker': False, 'certificate': False, 'trust': copy.deepcopy(after), 'commands': [], 'events': [], 'saved': {}}
        consume = M.consume_tls_alias_attempt
        def mark(*args):
            def opened(path, flags, mode=0o777, **kwargs):
                if Path(path).name == 'alias-cleanup-attempted.json':
                    self.assertTrue(flags & M.os.O_EXCL); self.assertTrue(flags & M.os.O_CREAT)
                    self.assertFalse(state['marker']); state['marker'] = True
                    if failure == 'open-race': raise FileExistsError('another attempt owns this marker')
                    state['events'].append('marker-open'); return 500
                self.assertEqual(Path(path), root / 'lab-tls')
                state['events'].append('parent-open'); return 501
            def sync(fd):
                state['events'].append('file-fsync' if fd == 500 else 'parent-fsync')
                if failure == ('file-fsync' if fd == 500 else 'parent-fsync'):
                    raise OSError('injected fsync failure')
            parent = self.info(50, stat.S_IFDIR | 0o700, uid=1001)
            marker = self.info(51, stat.S_IFREG | 0o600, uid=1001)
            def write(fd, raw):
                if failure == 'write-error': raise OSError('uncertain write')
                return len(raw) - (failure == 'short-write')
            with patch.object(M.os, 'getuid', return_value=1001, create=True), \
                    patch.object(M.os, 'O_NOFOLLOW', 0, create=True), patch.object(M.os, 'O_CLOEXEC', 0, create=True), \
                    patch.object(M.os, 'O_DIRECTORY', 0, create=True), patch.object(M.os, 'open', side_effect=opened), \
                    patch.object(M.os, 'write', side_effect=write), \
                    patch.object(M.os, 'fchmod', create=True), patch.object(M.os, 'fsync', side_effect=sync), \
                    patch.object(M.os, 'fstat', side_effect=lambda fd: marker if fd == 500 else parent), \
                    patch.object(M.os, 'stat', return_value=self.info(52, stat.S_IFREG | 0o600, uid=1001) if failure == 'marker-replaced' else marker), \
                    patch.object(M.os, 'close'), patch.object(Path, 'lstat', return_value=parent), \
                    patch.object(Path, 'resolve', side_effect=lambda *a, **k: root / 'lab-tls'):
                return consume(*args)
        def command(argv, **kwargs):
            self.assertEqual(argv[:6], ['/usr/bin/sudo', '-n', '/usr/bin/python3', '-B', '-c', M.TLS_ALIAS_REMOVE])
            self.assertEqual(len(argv), 7)
            self.assertEqual(json.loads(argv[6]), self.proof())
            self.assertTrue(state['marker'])
            self.assertIn('file-fsync', state['events']); self.assertIn('parent-fsync', state['events'])
            state['events'].append('helper'); state['commands'].append(argv)
            if failure == 'partial':
                del state['trust']['system/' + self.HASH]
                raise RuntimeError('helper outcome unknown')
            if failure == 'final-mismatch':
                state['trust'] = {**before, 'system/foreign.pem': {'link': 'foreign'}}
            else:
                state['trust'] = copy.deepcopy(before)
            return b''
        def exists(path):
            return state['marker'] if Path(path).name == 'alias-cleanup-attempted.json' else state['certificate']
        arm = {'before': before, 'certificate': pin(b'public')}
        with patch.object(M, 'regular', return_value=b'arm'), patch.object(M, 'bound'), \
                patch.object(M, 'protected_trust_parent'), patch.object(M, 'capture_tls_aliases', return_value=self.proof(),
                    side_effect=RuntimeError('capture outcome unknown') if failure == 'capture-error' else None) as capture, \
                patch.object(M, 'consume_tls_alias_attempt', side_effect=mark), patch.object(M, 'command', side_effect=command), \
                patch.object(M.os.path, 'lexists', side_effect=exists), patch.object(M, 'trust_view', side_effect=lambda: copy.deepcopy(state['trust'])), \
                patch.object(M, 'save', side_effect=lambda p, v: state['saved'].update({Path(p).name: v})):
            yield root, arm, state, capture

    def test_exact_pair_fsyncs_exclusive_marker_before_helper_and_repeated_calls_are_read_only(self):
        with self.controller() as (root, arm, state, capture):
            result = M.cleanup_owned_tls(root, arm, b'arm')
            self.assertTrue(result['cleanupVerified'])
            self.assertEqual(state['events'], ['parent-open', 'marker-open', 'file-fsync', 'parent-fsync', 'helper'])
            M.cleanup_owned_tls(root, arm, b'arm')
            self.assertEqual(len(state['commands']), 1); self.assertEqual(capture.call_count, 1)

    def test_partial_helper_failure_consumes_attempt_and_never_adopts_remaining_alias(self):
        with self.controller('partial') as (root, arm, state, capture):
            with self.assertRaisesRegex(RuntimeError, 'outcome unknown'):
                M.cleanup_owned_tls(root, arm, b'arm')
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, 'consumed'):
                    M.cleanup_owned_tls(root, arm, b'arm')
            self.assertIn('system/' + self.PEM, state['trust'])
            self.assertEqual(len(state['commands']), 1); self.assertEqual(capture.call_count, 1)
            self.assertNotIn('tls-cleanup.json', state['saved'])

    def test_uncertain_capture_also_consumes_attempt_without_allowing_later_recapture(self):
        with self.controller('capture-error') as (root, arm, state, capture):
            with self.assertRaisesRegex(RuntimeError, 'capture outcome unknown'):
                M.cleanup_owned_tls(root, arm, b'arm')
            self.assertTrue(state['marker']); self.assertFalse(state['commands'])
            with self.assertRaisesRegex(RuntimeError, 'consumed'):
                M.cleanup_owned_tls(root, arm, b'arm')
            self.assertEqual(capture.call_count, 1)

    def test_marker_write_or_fsync_failure_prevents_helper_and_consumes_existing_marker(self):
        for failure in ('open-race', 'write-error', 'short-write', 'file-fsync', 'parent-fsync', 'marker-replaced'):
            with self.subTest(failure=failure), self.controller(failure) as (root, arm, state, capture):
                with self.assertRaises((RuntimeError, OSError)):
                    M.cleanup_owned_tls(root, arm, b'arm')
                self.assertTrue(state['marker']); self.assertFalse(state['commands'])
                with self.assertRaisesRegex(RuntimeError, 'consumed'):
                    M.cleanup_owned_tls(root, arm, b'arm')
                self.assertEqual(capture.call_count, 1)

    def test_consumed_marker_never_mutates_even_if_certificate_reappears_or_restoration_is_complete(self):
        with self.controller() as (root, arm, state, capture):
            state['marker'] = True; state['certificate'] = True
            with self.assertRaisesRegex(RuntimeError, 'consumed'):
                M.cleanup_owned_tls(root, arm, b'arm')
            self.assertFalse(state['commands']); self.assertFalse(state['events']); capture.assert_not_called()
            state['certificate'] = False; state['trust'] = copy.deepcopy(arm['before'])
            self.assertTrue(M.cleanup_owned_tls(root, arm, b'arm')['cleanupVerified'])
            self.assertFalse(state['saved']); self.assertFalse(state['events']); self.assertFalse(state['commands'])

    def test_final_beforeimage_mismatch_fails_and_cannot_run_helper_again(self):
        with self.controller('final-mismatch') as (root, arm, state, capture):
            with self.assertRaisesRegex(RuntimeError, 'before-image'):
                M.cleanup_owned_tls(root, arm, b'arm')
            with self.assertRaisesRegex(RuntimeError, 'consumed'):
                M.cleanup_owned_tls(root, arm, b'arm')
            self.assertEqual(len(state['commands']), 1)
            self.assertIn('system/foreign.pem', state['trust'])
            self.assertNotIn('tls-cleanup.json', state['saved'])

    def test_capture_refuses_original_foreign_partial_and_changed_bundle_before_any_attempt(self):
        before = {'system/ca-certificates.crt': {**pin(b'original bundle'), 'mode': 0o644, 'uid': 0, 'gid': 0}}
        after = {**before, 'system/' + self.HASH: {'link': self.PEM}, 'system/' + self.PEM: {'link': self.CERT}}
        for failure in ('original', 'unknown', 'partial', 'target', 'bundle'):
            original, current = copy.deepcopy(before), copy.deepcopy(after)
            if failure == 'original': original['system/' + self.PEM] = current['system/' + self.PEM]
            if failure == 'unknown': current['system/foreign.pem'] = {'link': 'foreign'}
            if failure == 'partial': del current['system/' + self.HASH]
            if failure == 'target': current['system/' + self.PEM] = {'link': 'foreign'}
            if failure == 'bundle': current['system/ca-certificates.crt'].update(pin(b'different'))
            with self.subTest(failure=failure), patch.object(M, 'protected_trust_parent') as parent:
                with self.assertRaises(RuntimeError): M.capture_tls_aliases(original, current)
                parent.assert_not_called()

    def test_actual_capture_binds_both_link_identities_and_refuses_metadata_or_bundle_races(self):
        before = {'system/ca-certificates.crt': {**pin(b'original bundle'), 'mode': 0o644, 'uid': 0, 'gid': 0}}
        targets = {self.HASH: self.PEM, self.PEM: self.CERT}
        after = {**before, **{'system/' + name: {'link': target} for name, target in targets.items()}}
        for mutation in ('none', 'uid', 'hardlink', 'replacement', 'directory', 'certificate', 'bundle'):
            reads = {}
            def info(file):
                reads[file.name] = reads.get(file.name, 0) + 1
                if file.name == 'certs': return self.info(11 if mutation == 'directory' and reads[file.name] > 1 else 10, stat.S_IFDIR | 0o755)
                index = list(targets).index(file.name)
                return self.info(99 if mutation == 'replacement' and reads[file.name] > 1 else 20 + index,
                                 stat.S_IFLNK | 0o777, len(targets[file.name]), uid=1002 if mutation == 'uid' else 0,
                                 nlink=2 if mutation == 'hardlink' else 1)
            with self.subTest(mutation=mutation), patch.object(M, 'protected_trust_parent'), \
                    patch.object(Path, 'lstat', info), patch.object(M.os, 'readlink', side_effect=lambda p: targets[p.name]), \
                    patch.object(M.os.path, 'lexists', return_value=mutation == 'certificate'), \
                    patch.object(M.P, 'record', return_value={**before['system/ca-certificates.crt'], **(pin(b'changed') if mutation == 'bundle' else {})}), \
                    patch.object(M.os, 'unlink') as unlink, patch.object(M, 'command') as command:
                if mutation == 'none': self.assertEqual(M.capture_tls_aliases(before, after), self.proof())
                else:
                    with self.assertRaises(RuntimeError): M.capture_tls_aliases(before, after)
                unlink.assert_not_called(); command.assert_not_called()

    def helper_fixture(self, mutation=None):
        # Executes the actual fixed helper against a fake kernel/filesystem, never native trust.
        import builtins
        target = {self.HASH: self.PEM, self.PEM: self.CERT}
        nodes = {name: SimpleNamespace(info=self.info(20 + i, stat.S_IFLNK | 0o777, len(value)), target=value)
                 for i, (name, value) in enumerate(target.items())}
        directory = self.info(10, stat.S_IFDIR | 0o755)
        directory_path = [copy.deepcopy(directory)]
        bundle = self.info(30, stat.S_IFREG | 0o644, len(b'original bundle'))
        proof = self.proof(); held, unlinked, closed, events = {}, [], [], []
        offsets, sequence = {}, [100]
        if mutation == 'uid': nodes[self.PEM].info.st_uid = 1002
        if mutation == 'hardlink': nodes[self.PEM].info.st_nlink = 2
        if mutation == 'target': nodes[self.PEM].target = 'foreign'
        if mutation == 'regular': nodes[self.PEM].info.st_mode = stat.S_IFREG | 0o644
        if mutation == 'extra-proof': proof['path'] = '/private/DO-NOT-ACCESS'
        if mutation == 'directory-uid': directory_path[0].st_uid = 1002
        if mutation == 'directory-mode': directory_path[0].st_mode |= 0o002
        if mutation == 'bundle-mode': bundle.st_mode |= 0o022
        def key(path): return str(path).replace('\\', '/')
        def opened(path, flags, mode=0o777, *, dir_fd=None):
            name = key(path); sequence[0] += 1; fd = sequence[0]
            if name == '/etc/ssl/certs': value = SimpleNamespace(info=directory, target=None, kind='directory')
            elif name == 'ca-certificates.crt': value = SimpleNamespace(info=bundle, target=None, kind='bundle')
            else:
                self.assertIn(name, target); self.assertTrue(flags & fake.O_PATH); self.assertTrue(flags & fake.O_NOFOLLOW)
                value = SimpleNamespace(info=copy.deepcopy(nodes[name].info), target=nodes[name].target, kind=name)
            held[fd] = value; offsets[fd] = 0
            if mutation == 'held-replacement' and name == self.PEM: nodes[name].info.st_ino += 1
            if mutation == 'directory-replaced' and name == self.PEM: directory_path[0].st_ino += 1
            return fd
        def stat_at(path, *, dir_fd=None, follow_symlinks=True):
            name = key(path)
            if name in target: return copy.deepcopy(nodes[name].info)
            if name == 'ca-certificates.crt': return copy.deepcopy(bundle)
            if name == '/etc/ssl/certs': return copy.deepcopy(directory_path[0])
            return copy.deepcopy(directory)
        def unlink(name, *, dir_fd):
            self.assertIn(name, target); unlinked.append(name); del nodes[name]
            if len(unlinked) == 1 and mutation == 'between-unlinks': nodes[self.PEM].info.st_ino += 1
            if len(unlinked) == 1 and mutation == 'interrupted': raise OSError('interrupted after first unlink')
            if len(unlinked) == 2 and mutation == 'reappeared':
                nodes[self.HASH] = SimpleNamespace(info=self.info(999, stat.S_IFLNK | 0o777, 7), target='foreign')
        def read(fd, limit):
            raw = b'different bundle' if mutation == 'bundle' else b'original bundle'
            position = offsets[fd]; offsets[fd] += limit
            return raw[position:position + limit]
        def close(fd): closed.append(fd); held.pop(fd)
        fake = SimpleNamespace(getuid=lambda: 1001 if mutation == 'not-root' else 0, geteuid=lambda: 0, open=opened, stat=stat_at,
            lstat=stat_at, fstat=lambda fd: copy.deepcopy(held[fd].info), read=read, unlink=unlink, close=close,
            fsync=lambda fd: events.append('directory-fsync'), listdir=lambda fd: list(nodes) + ['ca-certificates.crt'],
            readlink=lambda name, dir_fd=None: held[dir_fd].target if name == '' else nodes[name].target,
            path=SimpleNamespace(lexists=lambda path: mutation == 'certificate' if key(path) == self.CERT else key(path).rsplit('/', 1)[-1] in nodes,
                                 realpath=lambda path: key(path)),
            O_RDONLY=0, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, O_CLOEXEC=0x40000, O_PATH=0x80000)
        imports = builtins.__import__
        def imported(name, *args, **kwargs):
            if name == 'os': return fake
            if name == 'sys': return SimpleNamespace(argv=['fixed-helper', json.dumps(proof)])
            return imports(name, *args, **kwargs)
        error = None
        try:
            exec(compile(M.TLS_ALIAS_REMOVE, '<fixed-alias-helper>', 'exec'),
                 {'__builtins__': {**vars(builtins), '__import__': imported}})
        except (RuntimeError, AssertionError, OSError, KeyError) as failure:
            error = failure
        return SimpleNamespace(error=error, nodes=nodes, unlinked=unlinked, held=held, closed=closed, events=events)

    def test_fixed_privileged_helper_parses_and_unlinks_only_held_exact_pair_in_order(self):
        ast.parse(M.TLS_ALIAS_REMOVE)
        result = self.helper_fixture()
        self.assertIsNone(result.error)
        self.assertEqual(result.unlinked, [self.HASH, self.PEM]); self.assertFalse(result.held)
        self.assertIn('directory-fsync', result.events)
        self.assertNotIn('--fresh', M.TLS_ALIAS_REMOVE)
        self.assertNotIn('update-ca-certificates', M.TLS_ALIAS_REMOVE)

    def test_fixed_helper_refuses_foreign_replaced_or_changed_inputs_without_unlink(self):
        for mutation in ('uid', 'hardlink', 'target', 'regular', 'held-replacement', 'certificate', 'bundle',
                         'directory-uid', 'directory-mode', 'directory-replaced', 'bundle-mode', 'extra-proof', 'not-root'):
            with self.subTest(mutation=mutation):
                result = self.helper_fixture(mutation)
                self.assertIsNotNone(result.error); self.assertFalse(result.unlinked); self.assertFalse(result.held)

    def test_fixed_helper_interruption_or_race_between_unlinks_never_removes_replacement(self):
        for mutation in ('between-unlinks', 'interrupted'):
            with self.subTest(mutation=mutation):
                result = self.helper_fixture(mutation)
                self.assertIsNotNone(result.error); self.assertEqual(result.unlinked, [self.HASH])
                self.assertIn(self.PEM, result.nodes); self.assertFalse(result.held)

    def test_fixed_helper_refuses_reappearance_without_retrying_or_removing_foreign_link(self):
        result = self.helper_fixture('reappeared')
        self.assertIsNotNone(result.error); self.assertEqual(result.unlinked, [self.HASH, self.PEM])
        self.assertEqual(result.nodes[self.HASH].target, 'foreign'); self.assertFalse(result.held)


if __name__ == '__main__':
    unittest.main(verbosity=2)
