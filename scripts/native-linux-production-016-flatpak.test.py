"""Pure controller/refusal tests. Never runs app, desktop, network or installer."""
import ast
import builtins
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
from contextlib import contextmanager, nullcontext
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
                wrong_window=False, first_pre_exec=False, focus_diagnostic=None):
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
            call = dict(kind=1, sender=':1.40', destination=M.NAME, serial=19, replySerial=0, flags=0, empty=True,
                        path='/com/creatorworks/hub/Host', interface='com.creatorworks.hub.Host1', member='Start')
            reply = dict(kind=2, sender=':1.42', destination=':1.40', serial=20, replySerial=19, flags=1, empty=True)
            state.observer_result = dict(readOnly=True, qualified=False, inputPermitted=False, authorityGranted=False,
                releaseReady=False, armed=True, inputStarted=True, workerStopped=True, busIdentityMatched=True,
                closed=True, callReplyMatched=True, deadlineExceeded=False, messageCount=2,
                call=call, reply=reply, observedHeaders=[copy.deepcopy(call), copy.deepcopy(reply)],
                senderObservation=dict(qualified=False, inputPermitted=False, stable=True, sealedBeforeInput=True,
                    correlatesToOriginalPopen=True, originalPopen=M.proxy_process_snapshot(launch),
                    expectedClient=M.proxy_process_snapshot(client), peer=dict(name=':1.40', pid=12, uid=1001),
                    senderAncestors=[M.proxy_process_snapshot(self.process(12, 11, '/usr/bin/xdg-dbus-proxy')),
                                     M.proxy_process_snapshot(launch)]))
            state.observer_events = []
            def passive(client, attempt):
                # Trusted observer adapter fixture; actual baseline/credential guards have their own pure suite.
                self.assertEqual(state.sends, [])
                state.observer_events.append('armed')
                def finish():
                    state.observer_events.append('finished')
                    return copy.deepcopy(state.observer_result)
                return dict(capture=SimpleNamespace(begin_input=lambda: state.observer_events.append('before-input'),
                        finish_observation=finish, close=finish), record=dict(readOnly=True, qualified=False,
                            inputPermitted=False, authorityGranted=False, releaseReady=False))
            session.start_warm_activation_diagnostic = passive
            state.fresh_disposed, state.old_disposed, state.x_events = 0, False, []
            native_inspect = session.x11.inspect
            session.x11.error = False
            def old_dispose():
                state.old_disposed = True
                state.x_events.append('dispose-old')
            session.x11.dispose = old_dispose
            def fresh():
                self.assertTrue(state.old_disposed)
                self.assertGreater(state.closed, 0)
                self.assertTrue(all(companion.held is None for companion in state.companions))
                state.x_events.append('open-fresh')
                def dispose():
                    state.fresh_disposed += 1
                    state.x_events.append('dispose-fresh')
                return SimpleNamespace(display=2, x=SimpleNamespace(XDefaultRootWindow=lambda _: 50),
                    property=lambda *_: (33, 32, session.windows()), inspect=native_inspect, dispose=dispose)
            session.helper.X11 = fresh
            session.portal_calls = [{'url': M.PORTAL_URL, 'browserOpened': False, 'downloadAttempted': False, 'senderUid': 1001}]
            def bind_warm(helper, native, x11, observed, window, owner, owner_probe, *, cold_xres):
                # Integration adapter fixture only; real FD/XRes/Host1 binding is exercised in the helper suite.
                self.assertEqual(cold_xres, session.report['coldRootXres'])
                M.require(x11.inspect(window) == cold_xres, 'Qualified cold XRes record changed before companion binding')
                companion = object.__new__(M.K.WarmRoot)
                companion.helper, companion.native, companion.x11 = helper, native, x11
                companion.process, companion.window, companion.owner = copy.deepcopy(observed), window, copy.deepcopy(owner)
                companion.window_owner = copy.deepcopy(cold_xres)
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
                    raise capture_failure if isinstance(capture_failure, Exception) else RuntimeError(capture_failure)
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
                    if focus_diagnostic is not None:
                        session.x11.error = True
                        error = M.K.InputRefused(record.get('refusal', 'Owned X resource query was refused'), record)
                        error.focus_diagnostic = copy.deepcopy(focus_diagnostic)
                        raise error
                    if partial == sequence:
                        raise M.K.InputRefused('terminal candidate', record)
                    return record
                def close(): state.closed += 1
                return SimpleNamespace(send=send, close=close, binding=SimpleNamespace(launch=launch, verify=guard))
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

    def test_pre_input_focus_diagnostic_is_separate_from_delivery_and_original_error_survives(self):
        error = RuntimeError('Focus is not the exact owned top-level XID')
        error.focus_diagnostic = {'readOnly': True, 'inputPermitted': False, 'authorityGranted': False,
                                  'releaseReady': False, 'complete': False, 'stable': False,
                                  'original': {'target': 100, 'focus': 101, 'revert': 1}}
        with self.fixture(capture_failure=error) as (session, state, _):
            with self.assertRaises(RuntimeError) as raised:
                session.flatpak('Cancel', 'disclosure-cancel')
            self.assertIs(raised.exception, error)
            record = M.parse((session.root / 'disclosure-cancel-gtk.json').read_bytes())
            self.assertEqual(record['focusDiagnostic'], error.focus_diagnostic)
            self.assertEqual(state.sends, [])
            self.assertNotIn('keyboard', record); self.assertNotIn('deliveryClassification', record)
            self.assertFalse(record['actionAttempted']); self.assertFalse(record['outcomeVerified'])
            self.assertEqual(record['refusal'], str(error))

    def test_invalid_diagnostic_does_not_replace_original_refusal_or_grant_input(self):
        for value in ({'readOnly': True, 'inputPermitted': True}, {'readOnly': True, 'payload': 'x' * 40000}, {'payload': object()}):
            error = RuntimeError('original focus refusal'); error.focus_diagnostic = value
            with self.subTest(value=list(value)), self.fixture(capture_failure=error) as (session, state, _):
                with self.assertRaises(RuntimeError) as raised:
                    session.flatpak('Cancel', 'disclosure-cancel')
                self.assertIs(raised.exception, error)
                record = M.parse((session.root / 'disclosure-cancel-gtk.json').read_bytes())
                self.assertNotIn('focusDiagnostic', record)
                self.assertEqual(state.sends, []); self.assertFalse(record['actionAttempted'])

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
            self.assertEqual(record['keyboard']['warmCompanion']['binding']['xres'], session.report['coldRootXres'])
            self.assertIsNone(state.companions[0].held)

    def test_warm_controller_passes_the_actual_cold_development_preview_title(self):
        with self.fixture('Open Creator Hub', 'warm') as (session, state, _):
            inspect = session.x11.inspect
            session.x11.inspect = lambda window: {**inspect(window), 'title': 'Creator Hub - Development Preview'} if window == 200 else inspect(window)
            session.report['coldRootXres'] = session.x11.inspect(200)
            session.flatpak('Open Creator Hub', 'warm')
            self.assertEqual(state.sends, ['Enter'])
            record = M.parse((session.root / 'warm-outcome-gtk.json').read_bytes())
            self.assertTrue(record['outcomeVerified'])
            self.assertEqual(record['keyboard']['warmCompanion']['binding']['xres'], session.report['coldRootXres'])

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


class WarmPassiveDiagnosticTests(unittest.TestCase):
    @staticmethod
    def actual_partial(record):
        record['deliveryComplete'] = False
        record['delivery'][1]['synchronized'] = False
        record['refusal'] = 'Owned X resource query was refused'

    def test_actual_two_row_refusal_is_unchanged_and_observer_is_armed_before_single_input(self):
        with LauncherKeyboardTests().fixture('Open Creator Hub', 'warm', changed_receipt=self.actual_partial) as (session, state, _):
            events = []
            value = dict(readOnly=True, qualified=False, inputPermitted=False, authorityGranted=False,
                         releaseReady=False, callReplyMatched=True)
            capture = SimpleNamespace(begin_input=lambda: None, close=lambda: events.append('closed') or value)
            def start(client, attempt):
                self.assertEqual(state.sends, []); events.append('armed')
                return dict(capture=capture, record=dict(readOnly=True, qualified=False, inputPermitted=False,
                                                       authorityGranted=False, releaseReady=False))
            with patch.object(session, 'start_warm_activation_diagnostic', side_effect=start):
                with self.assertRaisesRegex(RuntimeError, 'Incomplete keyboard delivery is unknown; no retry'):
                    session.flatpak('Open Creator Hub', 'warm')
            self.assertEqual(state.sends, ['Enter']); self.assertEqual(events, ['armed', 'closed'])
            original = M.parse((session.root / 'warm-gtk.json').read_bytes())
            self.assertFalse(original['keyboard']['deliveryComplete']); self.assertFalse(original['outcomeVerified'])
            self.assertNotIn('ownedPhaseExit', original)
            self.assertEqual([row['synchronized'] for row in original['keyboard']['delivery']], [True, False])
            saved = M.parse((session.root / 'warm-activation-observer-gtk.json').read_bytes())
            self.assertTrue(saved['observation']['callReplyMatched']); self.assertFalse(saved['qualified'])

    def test_cleanup_error_or_forged_authority_never_masks_primary_refusal(self):
        for failure in ('close', 'authority'):
            with self.subTest(failure=failure), LauncherKeyboardTests().fixture('Open Creator Hub', 'warm',
                    changed_receipt=self.actual_partial) as (session, state, _):
                capture = Mock()
                capture.close.side_effect = RuntimeError('PRIVATE ERROR') if failure == 'close' else None
                capture.close.return_value = dict(readOnly=True, qualified=True, inputPermitted=False,
                                                 authorityGranted=False, releaseReady=False)
                context = dict(capture=capture, record=dict(readOnly=True, qualified=False, inputPermitted=False,
                                                          authorityGranted=False, releaseReady=False))
                with patch.object(session, 'start_warm_activation_diagnostic', return_value=context):
                    with self.assertRaisesRegex(RuntimeError, 'Incomplete keyboard delivery is unknown; no retry'):
                        session.flatpak('Open Creator Hub', 'warm')
                value = (session.root / 'warm-activation-observer-gtk.json').read_text()
                self.assertNotIn('PRIVATE ERROR', value)
                record = M.parse(value)
                self.assertFalse(record['qualified']); self.assertIn('captureUnavailable', record)
                self.assertEqual(state.sends, ['Enter']); capture.close.assert_called_once()

    def test_nonwarm_does_not_arm_observer_or_add_an_input_path(self):
        with LauncherKeyboardTests().fixture('Open Creator Hub', 'cold') as (session, state, _):
            with patch.object(session, 'start_warm_activation_diagnostic') as start:
                session.flatpak('Open Creator Hub', 'cold')
            start.assert_not_called(); self.assertEqual(state.sends, ['Enter'])

    def test_missing_independent_harness_inventory_does_not_import_new_helper(self):
        with LauncherKeyboardTests().fixture('Open Creator Hub', 'warm') as (session, state, _):
            binding = dict(harnessSource='a' * 40, profile=M.PROFILE, **M.GATES)
            with patch.dict(M.os.environ, {'GITHUB_SHA': 'a' * 40}), patch.object(M, 'regular', return_value=M.json_bytes(binding)), \
                    patch.object(M.importlib.util, 'module_from_spec') as load:
                result = M.Session.start_warm_activation_diagnostic(session, LauncherKeyboardTests.process(14, 13, '/app/bin/creator-hub-flatpak-activate'))
            self.assertIsNone(result['capture']); self.assertIn('unavailable', result['record'])
            load.assert_not_called(); self.assertEqual(state.sends, [])

    def test_source_binding_uses_exact_captured_bytes_and_preserves_old_classifier(self):
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Session')
        start = next(node for node in session.body if isinstance(node, ast.FunctionDef) and node.name == 'start_warm_activation_diagnostic')
        source = ast.get_source_segment(Path(M.__file__).read_text(), start)
        self.assertIn("set(binding['harnessFiles']) == set(names)", source)
        self.assertIn("compile(sources[name], module.__file__, 'exec')", source)
        self.assertNotIn('exec_module', source)
        classifier = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'keyboard_delivery')
        self.assertIn('len(rows) == 1', ast.get_source_segment(Path(M.__file__).read_text(), classifier))


class WarmConsumedTerminalTests(unittest.TestCase):
    @staticmethod
    def partial(record):
        record['deliveryComplete'] = False
        record['delivery'][1]['synchronized'] = False
        record['refusal'] = 'Owned X resource query was refused'

    @staticmethod
    def focus():
        return dict(schemaVersion=1, kind='x11-keyboard-refusal', readOnly=True, inputPermitted=False,
            authorityGranted=False, releaseReady=False, latchSet=True, truncated=False, captureUnavailable=False,
            submissionCaptureUnavailable=False,
            events=[dict(errorCode=3, requestCode=25, minorCode=0, serial=202, resourceId=100, sameDisplay=True, stage='release-sync')],
            submissions=[dict(window=100, keycode=36, modifiers=0, pressed=True, latchBeforeSubmit=False, nextRequest=101,
                              latchBeforeSync=False, latchAfterSync=False, syncReturned=True),
                         dict(window=100, keycode=36, modifiers=0, pressed=False, latchBeforeSubmit=False, nextRequest=202,
                              latchBeforeSync=False, latchAfterSync=True, syncReturned=False)])

    @contextmanager
    def fixture(self, *, focus=None, **options):
        with LauncherKeyboardTests().fixture('Open Creator Hub', 'warm', changed_receipt=self.partial,
                focus_diagnostic=self.focus() if focus is None else focus, **options) as value:
            yield value

    def test_exact_native_release_error_is_only_a_candidate_until_all_independent_outcomes_pass(self):
        with self.fixture() as (session, state, _):
            original_x = session.x11
            session.flatpak('Open Creator Hub', 'warm')
            self.assertEqual(state.sends, ['Enter']); self.assertEqual(state.closed, 1)
            original = M.parse((session.root / 'warm-gtk.json').read_bytes())
            outcome = M.parse((session.root / 'warm-outcome-gtk.json').read_bytes())
            self.assertEqual(original['deliveryClassification'], 'warm-consumed-terminal-candidate')
            self.assertFalse(original['keyboard']['deliveryComplete']); self.assertFalse(original['outcomeVerified'])
            self.assertEqual(original['refusal'], 'Owned X resource query was refused')
            self.assertEqual(original['keyboard'], outcome['keyboard'])
            self.assertEqual(original['focusDiagnostic'], outcome['focusDiagnostic'])
            self.assertTrue(outcome['outcomeVerified']); self.assertTrue(outcome['preservedDataVerified'])
            self.assertEqual(outcome['outcomeProof'], 'attributed-start-same-owned-native-root')
            self.assertFalse(outcome['releaseReady']); self.assertFalse(outcome['actionReturned'])
            self.assertTrue(original_x.error); self.assertIsNot(session.x11, original_x)
            self.assertEqual(state.x_events, ['dispose-old', 'open-fresh'])
            self.assertEqual(state.observer_events, ['armed', 'before-input', 'finished'])

    def test_wrong_serial_xid_display_opcode_extra_error_or_dirty_latch_never_reaches_exit_proof(self):
        changes = [lambda f: f['events'][0].update(serial=201), lambda f: f['events'][0].update(resourceId=999),
            lambda f: f['events'][0].update(sameDisplay=False), lambda f: f['events'][0].update(errorCode=9),
            lambda f: f['events'][0].update(requestCode=24), lambda f: f['events'][0].update(minorCode=1),
            lambda f: f['events'][0].update(stage='release-submit'), lambda f: f['events'].append(copy.deepcopy(f['events'][0])),
            lambda f: f.update(truncated=True), lambda f: f.update(captureUnavailable=True),
            lambda f: f.update(submissionCaptureUnavailable=True), lambda f: f['submissions'][0].update(latchAfterSync=True),
            lambda f: f['submissions'][1].update(latchBeforeSubmit=True), lambda f: f['submissions'][1].update(latchBeforeSync=True),
            lambda f: f['submissions'][0].update(syncReturned=False), lambda f: f['submissions'][1].update(nextRequest=101),
            lambda f: f['submissions'][1].update(window=999), lambda f: f['submissions'][1].update(keycode=37),
            lambda f: f['submissions'][1].update(extra=True), lambda f: f['events'][0].update(serial=True)]
        for change in changes:
            focus = self.focus(); change(focus)
            with self.subTest(change=change), self.fixture(focus=focus) as (session, state, _):
                with self.assertRaises(RuntimeError): session.flatpak('Open Creator Hub', 'warm')
                self.assertEqual(state.sends, ['Enter']); self.assertFalse(session.launcher_keys[0]['outcomeVerified'])
                self.assertNotIn('ownedPhaseExit', session.launcher_keys[0]); self.assertEqual(state.x_events, [])

    def test_cancel_exit_zero_missing_reply_wrong_sender_or_unsealed_history_never_qualifies(self):
        changes = [lambda r: r.update(callReplyMatched=False), lambda r: r.pop('call'), lambda r: r.pop('reply'),
            lambda r: r['reply'].update(replySerial=99), lambda r: r['reply'].update(sender=':1.99'),
            lambda r: r['reply'].update(flags=0), lambda r: r.update(deadlineExceeded=True), lambda r: r.update(unknown=True),
            lambda r: r.update(workerStopped=False), lambda r: r.update(inputStarted=False),
            lambda r: r['senderObservation'].update(stable=False), lambda r: r['senderObservation'].update(sealedBeforeInput=False),
            lambda r: r['senderObservation']['peer'].update(name=':1.99'),
            lambda r: r['senderObservation']['peer'].update(pid=99), lambda r: r['senderObservation']['peer'].update(uid=1002),
            lambda r: r['senderObservation']['originalPopen'].update(startTime='999'),
            lambda r: r['senderObservation']['expectedClient'].update(kernelImageSha256='f' * 64)]
        for change in changes:
            with self.subTest(change=change), self.fixture() as (session, state, _):
                change(state.observer_result)
                with self.assertRaises(RuntimeError): session.flatpak('Open Creator Hub', 'warm')
                self.assertEqual(state.code, 0); self.assertEqual(state.sends, ['Enter'])
                self.assertFalse(session.launcher_keys[0]['outcomeVerified']); self.assertEqual(state.x_events, [])

    def test_original_owned_exit_preservation_root_host_and_window_are_independent_requirements(self):
        for failure in ('exit', 'preserved', 'root', 'host', 'window'):
            with self.subTest(failure=failure), self.fixture(wrong_exit=2 if failure == 'exit' else None,
                    preservation_failure=failure == 'preserved') as (session, state, _):
                old_wait = session.wait
                def wait(check, seconds=30):
                    if state.sends:
                        if failure == 'root': session.stable = Mock(side_effect=RuntimeError('Root identity changed'))
                        if failure == 'host': session.host_owner = lambda: dict(name=':1.99', pid=40)
                        if failure == 'window': session.windows = lambda: [200, 999]
                    return old_wait(check, seconds)
                session.wait = wait
                with self.assertRaises(RuntimeError): session.flatpak('Open Creator Hub', 'warm')
                self.assertFalse(session.launcher_keys[0]['outcomeVerified']); self.assertEqual(state.sends, ['Enter'])
                if failure in ('root', 'host', 'window'):
                    self.assertEqual(state.x_events, ['dispose-old', 'open-fresh', 'dispose-fresh'])

    def test_missing_preinput_baseline_blocks_input_and_does_not_open_fresh_x(self):
        with self.fixture() as (session, state, _):
            session.start_warm_activation_diagnostic = lambda *_: dict(capture=None, record={'unavailable': 'NoBaseline'})
            with self.assertRaisesRegex(RuntimeError, 'no input'): session.flatpak('Open Creator Hub', 'warm')
            self.assertEqual(state.sends, []); self.assertEqual(state.x_events, [])

    def test_complete_warm_enter_also_needs_attributed_start_not_just_existing_root(self):
        with LauncherKeyboardTests().fixture('Open Creator Hub', 'warm') as (session, state, _):
            state.observer_result['callReplyMatched'] = False
            with self.assertRaises(RuntimeError): session.flatpak('Open Creator Hub', 'warm')
            self.assertEqual(state.code, 0); self.assertFalse(session.launcher_keys[0]['outcomeVerified'])


class RootInventoryPreflightTests(unittest.TestCase):
    @contextmanager
    def fixture(self, change=None, failure=None):
        names = ('scripts/native-linux-production-016-flatpak.py', 'scripts/native-linux-production-016-flatpak.test.py',
                 'scripts/native-linux-flatpak-activation-observer.py', 'scripts/native-linux-flatpak-activation-observer.test.py',
                 'scripts/native-linux-flatpak-dialog-input.py', 'scripts/native-linux-flatpak-dialog-input.test.py',
                 'scripts/native-unix-window.py', 'scripts/native-unix-window.test.py')
        sources = {name: (HERE.parent / name).read_bytes() for name in names}
        proof = dict(schemaVersion=1, profile=M.PROFILE, harnessSource='a' * 40,
                     harnessFiles={name: pin(raw) for name, raw in sources.items()}, **M.GATES)
        if change: change(proof)
        state = SimpleNamespace(events=[], reports=[], proof=proof)
        def execute(code, namespace):
            builtins.exec(code, namespace)
            state.module = SimpleNamespace(**namespace)
            namespace['Path'] = lambda path: SimpleNamespace(resolve=lambda **options: '/usr/bin/python3.10')
            namespace['protected_tool'] = Mock(side_effect=lambda digest: state.events.append('protected'))
            namespace['root_process'] = Mock(return_value=dict(pid=19, parentPid=18, startTime='19',
                uids=[1001] * 4, executable='/usr/bin/python3.10'))
        def read_bound(file, expected, maximum):
            state.events.append('bound'); raw = sources[file.relative_to(HERE.parent).as_posix()]
            self.assertEqual(expected, pin(raw)); return raw
        def exchange(tool, operation, raw, deadline):
            state.events.append('root-worker')
            self.assertEqual(operation, 'root-inventory-probe')
            request = M.parse(raw)
            data = dict(operation='flatpak-uid-inventory-probe-1001', complete=True, uid=1001, candidateCount=0,
                        scopedProcessCount=2, caller=request['caller'],
                        invocation=[dict(pid=21, parentPid=20, startTime='21', state='R', uids=[0] * 4,
                                         executableKind='python', imageSha256='a' * 64),
                                    dict(pid=20, parentPid=19, startTime='20', state='S', uids=[1001, 0, 0, 0],
                                         executableKind='sudo', imageSha256='b' * 64)],
                        readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False)
            if failure == 'timeout':
                error = TimeoutError(); error.root_proxy_diagnostic = dict(readOnly=True, inputPermitted=False,
                    authorityGranted=False, releaseReady=False, cleanupUnconfirmed=True, exitObserved=False)
                raise error
            if failure == 'authority': data['authorityGranted'] = True
            if failure == 'replay': request['nonce'] = 'd' * 64
            return SimpleNamespace(returncode=0, stdout=M.json_bytes(dict(request=request, ok=True, snapshot=data)), stderr=b'')
        with patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'geteuid', return_value=1001, create=True), \
                patch.dict(M.os.environ, {**ENV, 'EXECUTION_REQUEST': M.REQUEST}, clear=True), \
                patch.object(M.Path, 'exists', return_value=False), patch.object(M, 'regular', return_value=M.json_bytes(proof)), \
                patch.object(M, 'bound', side_effect=read_bound) as bounded, \
                patch.object(M, 'exec', side_effect=execute, create=True), patch.object(M, 'root_exchange', side_effect=exchange) as worker, \
                patch.object(M, 'output', side_effect=lambda path, raw: state.reports.append((path, M.parse(raw)))):
            state.worker, state.bounded = worker, bounded
            yield state

    def test_actual_preflight_operation_verifies_all_eight_sources_then_protected_worker_and_zero_proxy_receipt(self):
        with self.fixture() as state:
            root = Path('/fixed')
            M.root_inventory_preflight(root)
            self.assertEqual(state.events, ['bound'] * 8 + ['protected', 'root-worker', 'protected'])
            path, report = state.reports[0]
            self.assertEqual(path, root.parent / 'native-linux-flatpak-root-preflight.json')
            self.assertTrue(report['inventoryProbed']); self.assertEqual(report['inventory']['candidateCount'], 0)
            self.assertNotIn('proxy', report['inventory']); self.assertNotIn('tree', report['inventory'])
            for name in (*M.GATES, 'inputPermitted', 'authorityGranted'): self.assertIs(report[name], False)

    def test_probe_receipt_accepts_both_verified_sudo_uid_shapes_only(self):
        for ids, accepted in (([0] * 4, True), ([1001, 0, 0, 0], True),
                              ([1001, 0, 1001, 0], False), ([1002, 0, 0, 0], False)):
            with self.subTest(ids=ids), self.fixture() as state:
                original_exchange = state.worker.side_effect
                def exchange(*args):
                    result = original_exchange(*args)
                    answer = M.parse(result.stdout); answer['snapshot']['invocation'][1]['uids'] = ids
                    result.stdout = M.json_bytes(answer)
                    return result
                state.worker.side_effect = exchange
                if accepted:
                    M.root_inventory_preflight(Path('/fixed'))
                else:
                    with self.assertRaises(ValueError): M.root_inventory_preflight(Path('/fixed'))
                report = state.reports[0][1]
                self.assertIs(report['inventoryProbed'], accepted)
                self.assertEqual(state.worker.call_count, 1)
                for name in (*M.GATES, 'inputPermitted', 'authorityGranted'): self.assertIs(report[name], False)

    def test_direct_worker_caller_probe_receipt_remains_non_authorizing(self):
        with self.fixture() as state:
            original_exchange = state.worker.side_effect
            def exchange(*args):
                result = original_exchange(*args)
                answer = M.parse(result.stdout)
                answer['snapshot']['invocation'] = answer['snapshot']['invocation'][:1]
                answer['snapshot']['invocation'][0]['parentPid'] = answer['request']['caller']['pid']
                result.stdout = M.json_bytes(answer)
                return result
            state.worker.side_effect = exchange
            M.root_inventory_preflight(Path('/fixed'))
            report = state.reports[0][1]
            self.assertTrue(report['inventoryProbed']); self.assertEqual(len(report['inventory']['invocation']), 1)
            for name in (*M.GATES, 'inputPermitted', 'authorityGranted'): self.assertIs(report[name], False)

    def test_unknown_missing_source_or_authority_flag_stops_before_any_sudo(self):
        for change in (lambda p: p['harnessFiles'].pop('scripts/native-unix-window.py'),
                       lambda p: p.update(harnessSource='b' * 40), lambda p: p.update(releaseReady=True),
                       lambda p: p.update(extra=True)):
            with self.fixture(change) as state:
                with self.assertRaises(RuntimeError): M.root_inventory_preflight(Path('/fixed'))
                state.worker.assert_not_called(); state.bounded.assert_not_called()

    def test_expired_replayed_authorizing_or_unconfirmed_cleanup_probe_cannot_pass(self):
        for failure in ('replay', 'authority', 'timeout'):
            with self.subTest(failure=failure), self.fixture(failure=failure) as state:
                with self.assertRaises((RuntimeError, ValueError, TimeoutError)): M.root_inventory_preflight(Path('/fixed'))
                report = state.reports[0][1]
                self.assertFalse(report['inventoryProbed']); self.assertFalse(report['releaseReady'])
                if failure == 'timeout': self.assertTrue(report['workerCleanup']['cleanupUnconfirmed'])
                self.assertEqual(state.worker.call_count, 1)

    def test_inspect_only_existing_artifact_root_or_wrong_uid_never_enters_probe(self):
        for field in ('request', 'root', 'uid'):
            with self.subTest(field=field), self.fixture() as state:
                with patch.dict(M.os.environ, {'EXECUTION_REQUEST': 'inspect-only'} if field == 'request' else {}), \
                        patch.object(M.Path, 'exists', return_value=field == 'root'), \
                        patch.object(M.os, 'getuid', return_value=21314 if field == 'uid' else 1001, create=True):
                    with self.assertRaises(RuntimeError): M.root_inventory_preflight(Path('/fixed'))
                state.worker.assert_not_called(); state.bounded.assert_not_called()

    def test_main_routes_preflight_before_any_artifact_root_stat(self):
        with patch.dict(M.os.environ, ENV, clear=True), patch.object(M.sys, 'platform', 'linux'), \
                patch.object(M.platform, 'machine', return_value='x86_64'), \
                patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'geteuid', return_value=1001, create=True), \
                patch.object(M.sys, 'argv', ['controller.py', 'root-preflight']), patch.object(M, 'locations', return_value=Path('/fixed')), \
                patch.object(M.Path, 'lstat', side_effect=AssertionError('Premature artifact-root access')), \
                patch.object(M, 'root_inventory_preflight') as probe:
            M.main(); probe.assert_called_once_with(Path('/fixed'))

    def test_probe_failure_receipt_error_does_not_mask_original_and_no_runtime_is_created(self):
        with self.fixture(failure='timeout'), patch.object(M, 'output', side_effect=OSError('fixed synthetic refusal')):
            with self.assertRaises(TimeoutError) as raised: M.root_inventory_preflight(Path('/fixed'))
            self.assertEqual(raised.exception.root_preflight_receipt_error, 'OSError')
        source = Path(M.__file__).read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'root_inventory_preflight')
        code = ast.get_source_segment(source, node)
        for forbidden in ('mkdir(', 'PROXY_RUNTIME', 'PrivateInstance', 'association_snapshot(', '.chmod(', 'makedirs('):
            self.assertNotIn(forbidden, code)
        workflow = (HERE.parent / M.WORKFLOW).read_text()
        self.assertIn('${{ runner.temp }}/native-linux-flatpak-root-preflight.json', workflow)
        self.assertIn('${{ runner.temp }}/native-linux-flatpak-root-source.json', workflow)

    def test_root_probe_permission_failure_retains_only_typed_original_scan_metadata(self):
        with self.fixture() as state:
            result = SimpleNamespace(returncode=1, stderr=b'', stdout=M.json_bytes(
                dict(ok=False, unavailable='PermissionError', stage='complete-uid-inventory', pid=925)))
            with patch.object(M, 'root_exchange', return_value=result):
                with self.assertRaises(RuntimeError): M.root_inventory_preflight(Path('/fixed'))
            self.assertEqual(state.reports[0][1]['workerCleanup'], dict(readOnly=True, inputPermitted=False,
                authorityGranted=False, releaseReady=False, type='PermissionError', stage='complete-uid-inventory', pid=925))

    def test_root_probe_caller_refusal_retains_same_read_operands_without_passing_or_retry(self):
        detail = dict(predicate='hop-credentials', hops=[dict(pid=21, parentPid=20, startTime='21',
            uids=[1001, 0, 0, 0], state='S', expectedKind='python', executableKind='unread')])
        with self.fixture() as state:
            state.worker.side_effect = None
            state.worker.return_value = SimpleNamespace(returncode=1, stderr=b'', stdout=M.json_bytes(
                dict(ok=False, unavailable='ValueError', stage='probe-caller-chain', probeCaller=detail)))
            with self.assertRaisesRegex(RuntimeError, 'no input'): M.root_inventory_preflight(Path('/fixed'))
            self.assertEqual(state.worker.call_count, 1)
            report = state.reports[0][1]
            self.assertFalse(report['inventoryProbed']); self.assertNotIn('inventory', report)
            self.assertEqual(report['workerCleanup'], dict(readOnly=True, inputPermitted=False,
                authorityGranted=False, releaseReady=False, type='ValueError', stage='probe-caller-chain', probeCaller=detail))
            for name in M.GATES: self.assertIs(report[name], False)

    def test_caller_diagnostic_schema_is_closed_bounded_and_detached_from_worker_record(self):
        detail = dict(predicate='hop-executable', hops=[dict(pid=21, parentPid=20, startTime='21',
            uids=[0] * 4, state='S', expectedKind='python', executableKind='other')])
        answer = dict(ok=False, unavailable='ValueError', stage='probe-caller-chain', probeCaller=detail)
        error = M.root_worker_refusal(answer)
        self.assertEqual(error.root_proxy_diagnostic['probeCaller'], detail)
        detail['hops'][0]['pid'] = 99
        self.assertEqual(error.root_proxy_diagnostic['probeCaller']['hops'][0]['pid'], 21)
        changes = (
            lambda d: d.update(extra='PRIVATE'), lambda d: d.update(predicate='PRIVATE'),
            lambda d: d.update(hops=[]), lambda d: d.update(hops=d['hops'] * 6),
            lambda d: d['hops'][0].update(extra='PRIVATE'), lambda d: d['hops'][0].update(pid=True),
            lambda d: d['hops'][0].update(parentPid=True), lambda d: d['hops'][0].update(startTime='1' * 5000),
            lambda d: d['hops'][0].update(uids=[True] * 4), lambda d: d['hops'][0].update(uids=[2**32] * 4),
            lambda d: d['hops'][0].update(state='PRIVATE'), lambda d: d['hops'][0].update(expectedKind='PRIVATE'),
            lambda d: d['hops'][0].update(executableKind='PRIVATE'))
        for change in changes:
            changed = copy.deepcopy(detail); change(changed)
            with self.subTest(change=change):
                refused = M.root_worker_refusal({**answer, 'probeCaller': changed})
                self.assertEqual(refused.root_proxy_diagnostic, dict(readOnly=True, inputPermitted=False,
                    authorityGranted=False, releaseReady=False, type='ValueError', stage='probe-caller-chain'))
                self.assertNotIn('PRIVATE', str(refused.root_proxy_diagnostic))
                self.assertIn('no input', str(refused))

    def inventory_failure(self):
        return dict(readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False,
            phase='complete-uid-inventory', scan=1, entryPid=1912, entryUids=[1001, 0, 0, 0],
            function='InvocationChain.recheck', predicate='invocation-identity', field='invocation', line=1001,
            subject=dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, state='S', executableKind='python'))

    def test_inventory_refusal_retains_distinct_entry_and_subject_without_authority_or_retry(self):
        detail = self.inventory_failure()
        with self.fixture() as state:
            state.worker.side_effect = None
            state.worker.return_value = SimpleNamespace(returncode=1, stderr=b'', stdout=M.json_bytes(
                dict(ok=False, unavailable='ValueError', stage='complete-uid-inventory', inventoryFailure=detail)))
            with self.assertRaisesRegex(RuntimeError, 'no input'): M.root_inventory_preflight(Path('/fixed'))
            state.worker.assert_called_once()
            report = state.reports[0][1]
            self.assertFalse(report['inventoryProbed']); self.assertNotIn('inventory', report)
            value = report['workerCleanup']['inventoryFailure']
            self.assertEqual(value, detail); self.assertEqual((value['entryPid'], value['subject']['pid']), (1912, 19))
            for name in M.GATES: self.assertIs(report[name], False)
            for name in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[name], False)

    def test_inventory_diagnostic_whitelist_is_closed_typed_bounded_and_copied(self):
        detail = self.inventory_failure()
        answer = dict(ok=False, unavailable='ValueError', stage='complete-uid-inventory', inventoryFailure=detail)
        error = M.root_worker_refusal(answer)
        detail['subject']['pid'] = 99; detail['entryUids'][0] = 0
        self.assertEqual(error.root_proxy_diagnostic['inventoryFailure']['subject']['pid'], 19)
        self.assertEqual(error.root_proxy_diagnostic['inventoryFailure']['entryUids'], [1001, 0, 0, 0])
        changes = (
            lambda d: d.update(extra='PRIVATE'), lambda d: d.update(function='PRIVATE'),
            lambda d: d.update(predicate='PRIVATE'), lambda d: d.update(field='PRIVATE'),
            lambda d: d.update(phase='PRIVATE'), lambda d: d.update(scan=True), lambda d: d.update(scan=3),
            lambda d: d.update(entryPid=True), lambda d: d.update(entryPid=2**31),
            lambda d: d.update(entryUids=[True] * 4), lambda d: d.update(entryUids=[2**32] * 4),
            lambda d: d.update(line=True), lambda d: d.update(line=100000),
            lambda d: d.update(readOnly=False), lambda d: d.update(inputPermitted=True),
            lambda d: d.update(authorityGranted=0), lambda d: d.update(releaseReady=True),
            lambda d: d['subject'].update(extra='PRIVATE'), lambda d: d['subject'].update(pid=True),
            lambda d: d['subject'].update(parentPid=True), lambda d: d['subject'].update(startTime='1' * 4096),
            lambda d: d['subject'].update(uids=[True] * 4), lambda d: d['subject'].update(state='PRIVATE'),
            lambda d: d['subject'].update(executableKind='PRIVATE'))
        for change in changes:
            changed = self.inventory_failure(); change(changed)
            with self.subTest(change=change):
                error = M.root_worker_refusal({**answer, 'inventoryFailure': changed})
                self.assertEqual(error.root_proxy_diagnostic, dict(readOnly=True, inputPermitted=False,
                    authorityGranted=False, releaseReady=False, type='ValueError', stage='complete-uid-inventory'))
                self.assertNotIn('PRIVATE', str(error.root_proxy_diagnostic)); self.assertIn('no input', str(error))
        unavailable = self.inventory_failure()
        unavailable.update(scan=2, entryPid=None, entryUids=None, subject=None)
        self.assertEqual(M.root_worker_refusal({**answer, 'inventoryFailure': unavailable}).root_proxy_diagnostic['inventoryFailure'], unavailable)

    def test_inventory_diagnostic_serialization_failure_keeps_original_refusal_and_existing_metadata(self):
        answer = dict(ok=False, unavailable='PermissionError', stage='complete-uid-inventory', pid=1912,
                      inventoryFailure=self.inventory_failure())
        with patch.object(M, 'json_bytes', side_effect=OSError('PRIVATE_SERIALIZATION')):
            error = M.root_worker_refusal(answer)
        self.assertEqual(error.root_proxy_diagnostic, dict(readOnly=True, inputPermitted=False, authorityGranted=False,
            releaseReady=False, type='PermissionError', stage='complete-uid-inventory', pid=1912))
        self.assertIn('no input', str(error)); self.assertNotIn('PRIVATE', str(error.root_proxy_diagnostic))

    def test_probe_accepts_only_before_expiry_including_after_final_protected_source_check(self):
        for delta in (-1, 0, 1, 'protected-check'):
            with self.subTest(delta=delta), self.fixture() as state:
                clock = [1_000_000_000]
                exchange = state.worker.side_effect
                def reply(*args):
                    result = exchange(*args)
                    clock[0] = M.parse(args[2])['expiresNs'] + (delta if type(delta) is int else -1)
                    return result
                state.worker.side_effect = reply
                execute = M.exec.side_effect
                def load(code, namespace):
                    execute(code, namespace)
                    protected = namespace['protected_tool']
                    def recheck(digest):
                        protected(digest)
                        if delta == 'protected-check' and protected.call_count == 2:
                            clock[0] = 5_000_000_000
                    namespace['protected_tool'] = recheck
                M.exec.side_effect = load
                with patch.object(M.time, 'monotonic_ns', side_effect=lambda: clock[0]):
                    if delta == -1:
                        M.root_inventory_preflight(Path('/fixed'))
                        self.assertTrue(state.reports[0][1]['inventoryProbed'])
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'probe expired'): M.root_inventory_preflight(Path('/fixed'))
                        self.assertFalse(state.reports[0][1]['inventoryProbed'])
                self.assertEqual(state.worker.call_count, 1)


class RootWorkerExchangeTests(unittest.TestCase):
    @contextmanager
    def child(self, *, running=False, overflow=None, closed_after=None, read_failure=False, eof=True, poll_advance=0.0):
        class Stream:
            def __init__(self, fd): self.fd, self.closed = fd, False
            def fileno(self): return self.fd
            def close(self): self.closed = True
        state = SimpleNamespace(clock=0.0, reads={1: 0, 2: 0}, submitted=bytearray())
        child = SimpleNamespace(stdin=Stream(0), stdout=Stream(1), stderr=Stream(2), args=['fixed'],
                                returncode=None if running else 0,
                                kill=Mock(side_effect=PermissionError()), wait=Mock(side_effect=AssertionError('Unbounded wait')),
                                terminate=Mock(side_effect=PermissionError()))
        state.child = child
        def poll():
            state.clock += poll_advance
            if closed_after is not None and child.stdin.closed and state.clock >= closed_after:
                child.returncode = 124
            return child.returncode
        child.poll = Mock(side_effect=poll)
        def selected(readers, writers, exceptional, timeout):
            state.clock += max(.001, timeout)
            return readers, writers, []
        def read(fd, amount):
            if read_failure: raise PermissionError()
            if not eof: raise BlockingIOError()
            state.reads[fd] += 1
            raw = (b'x' * 40000 if overflow == 'stdout' else b'{}') if fd == 1 else (b'e' * 3000 if overflow == 'stderr' else b'')
            position = (state.reads[fd] - 1) * 4096
            return raw[position:position + amount]
        def write(fd, raw):
            self.assertEqual(fd, 0); state.submitted.extend(raw); return len(raw)
        with patch.object(M.subprocess, 'Popen', return_value=child) as launch, \
                patch.object(M.os, 'set_blocking', create=True) as blocking, patch.object(M.os, 'read', side_effect=read), \
                patch.object(M.os, 'write', side_effect=write), patch.object(M.select, 'select', side_effect=selected), \
                patch.object(M.time, 'monotonic', side_effect=lambda: state.clock), patch.object(M, 'ROOT_WORKERS_UNKNOWN', []):
            state.launch, state.blocking = launch, blocking
            yield state
            child.kill.assert_not_called(); child.terminate.assert_not_called(); child.wait.assert_not_called()

    def test_fixed_isolated_command_drains_and_observes_exit_without_signal_or_wait(self):
        with self.child() as state:
            result = M.root_exchange(Path('/protected/observer.py'), 'root-proxy-snapshot', b'fixed-request', 1)
            self.assertEqual((result.stdout, result.stderr, result.returncode), (b'{}', b'', 0))
            self.assertEqual(state.submitted, b'fixed-request')
            argv, options = state.launch.call_args.args[0], state.launch.call_args.kwargs
            self.assertEqual(argv, ['/usr/bin/sudo', '-n', '--', '/usr/bin/python3', '-I', '-S', '-B',
                                    str(Path('/protected/observer.py')), 'root-proxy-snapshot'])
            self.assertEqual(options['env'], dict(PATH='/usr/bin:/bin', LANG='C.UTF-8', LC_ALL='C.UTF-8'))
            self.assertTrue(options['start_new_session']); self.assertTrue(options['close_fds'])
            self.assertEqual(state.blocking.call_count, 3)
            self.assertTrue(all(stream.closed for stream in (state.child.stdin, state.child.stdout, state.child.stderr)))

    def test_timeout_root_kill_eperm_cannot_enter_unbounded_wait_and_cleanup_unknown_blocks_input(self):
        with self.child(running=True, eof=False) as state:
            with self.assertRaises(TimeoutError) as raised:
                M.root_exchange(Path('/protected/observer.py'), 'root-proxy-snapshot', b'fixed-request', .1)
            value = raised.exception.root_proxy_diagnostic
            self.assertLess(state.clock, .4)
            self.assertIs(value['exitObserved'], False); self.assertIs(value['cleanupUnconfirmed'], True)
            for key in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[key], False)
            self.assertEqual(M.ROOT_WORKERS_UNKNOWN, [state.child])
            adapter = RootProxySnapshotTests().fixture().adapter
            with patch.object(M, 'root_exchange', side_effect=raised.exception):
                with self.assertRaises(TimeoutError): adapter([])
            self.assertTrue(adapter.blocked)

    def test_timeout_may_observe_own_worker_exit_but_still_refuses_and_never_retries(self):
        with self.child(running=True, closed_after=.15) as state:
            with self.assertRaises(TimeoutError) as raised:
                M.root_exchange(Path('/protected/observer.py'), 'root-inventory-probe', b'fixed-request', .1)
            value = raised.exception.root_proxy_diagnostic
            self.assertTrue(value['exitObserved']); self.assertFalse(value['cleanupUnconfirmed'])
            self.assertEqual(M.ROOT_WORKERS_UNKNOWN, [])

    def test_both_pipe_eofs_without_observed_worker_exit_remains_unknown(self):
        with self.child(running=True) as state:
            with self.assertRaises(TimeoutError) as raised:
                M.root_exchange(Path('/protected/observer.py'), 'root-inventory-probe', b'fixed-request', .1)
            value = raised.exception.root_proxy_diagnostic
            self.assertTrue(value['stdoutEof']); self.assertTrue(value['stderrEof'])
            self.assertFalse(value['exitObserved']); self.assertTrue(value['cleanupUnconfirmed'])

    def test_complete_response_at_or_after_exchange_deadline_refuses_but_just_before_passes(self):
        for deadline, poll_advance, accepted in ((.03, 0, False), (.03, .001, False), (.040000001, 0, True)):
            with self.subTest(deadline=deadline, poll_advance=poll_advance), self.child(poll_advance=poll_advance) as state:
                if accepted:
                    result = M.root_exchange(Path('/protected/observer.py'), 'root-proxy-snapshot', b'fixed-request', deadline)
                    self.assertEqual(result.returncode, 0); self.assertEqual(state.clock, .04)
                    self.assertAlmostEqual(deadline - state.clock, 1e-9, places=15)
                else:
                    with self.assertRaises(TimeoutError) as raised:
                        M.root_exchange(Path('/protected/observer.py'), 'root-proxy-snapshot', b'fixed-request', deadline)
                    self.assertGreaterEqual(state.clock, deadline)
                    self.assertFalse(raised.exception.root_proxy_diagnostic['inputPermitted'])

    def test_pipe_overflow_or_read_failure_keeps_original_error_with_bounded_cleanup(self):
        for failure in ('stdout', 'stderr', 'read'):
            with self.subTest(failure=failure), self.child(overflow=failure, read_failure=failure == 'read') as state:
                with self.assertRaises((RuntimeError, PermissionError)) as raised:
                    M.root_exchange(Path('/protected/observer.py'), 'root-proxy-snapshot', b'fixed-request', 1)
                self.assertLess(state.clock, 1.3)
                self.assertIn('cleanupUnconfirmed', raised.exception.root_proxy_diagnostic)
                self.assertEqual(state.launch.call_count, 1)

    def test_exchange_never_uses_run_context_manager_kill_or_unbounded_wait(self):
        source = ast.get_source_segment(Path(M.__file__).read_text(), next(n for n in ast.parse(Path(M.__file__).read_text()).body
            if isinstance(n, ast.FunctionDef) and n.name == 'root_exchange'))
        for forbidden in ('subprocess.run', 'with subprocess', '.wait(', '.kill(', '.terminate(', 'os.kill(', '.communicate('):
            self.assertNotIn(forbidden, source)


class RootProxySnapshotTests(unittest.TestCase):
    def fixture(self):
        module = SimpleNamespace(PROXY_RUNTIME=Path('/fixed/runtime'), PROXY_TOOL=Path('/protected/observer.py'),
            protected_tool=Mock(), root_request=Mock(), validate_association=Mock(),
            root_process=Mock(return_value=dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10')))
        capture = SimpleNamespace(budget=Mock(), transcript=SimpleNamespace(deadline=M.time.monotonic() + 10))
        original, client = {'pid': 10}, {'pid': 14}
        with patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'geteuid', return_value=1001, create=True):
            adapter = M.RootProxySnapshot(module, Path('/fixed'), 'a' * 40, 'b' * 64, original, client, capture,
                                         dict(appCommit='c' * 64, runtimeCommit='d' * 64))
        data = dict(complete=True, flatpakInfo=dict(fields=dict(appCommit='c' * 64, runtimeCommit='d' * 64)))
        def run(tool, operation, raw, deadline):
            request = M.parse(raw)
            return SimpleNamespace(returncode=0, stderr=b'', stdout=M.json_bytes(dict(request=request, ok=True, snapshot=data)))
        return SimpleNamespace(adapter=adapter, module=module, capture=capture, run=run, data=data)

    def test_fixed_protected_python_snapshot_reply_and_installed_commits(self):
        state = self.fixture()
        with patch.object(M, 'root_exchange', side_effect=state.run) as run:
            self.assertEqual(state.adapter([{'pid': 14}]), state.data)
        tool, operation, raw, deadline = run.call_args.args
        self.assertEqual((tool, operation), (state.module.PROXY_TOOL, 'root-proxy-snapshot'))
        request = M.parse(raw)
        self.assertEqual(request['caller'], state.module.root_process.return_value)
        state.module.root_process.assert_called_once_with(M.os.getpid())
        self.assertLessEqual(request['expiresNs'] - M.time.monotonic_ns(), 4 * 10**9)
        self.assertEqual(deadline, request['expiresNs'] / 10**9)
        state.module.protected_tool.assert_has_calls([unittest.mock.call('b' * 64), unittest.mock.call('b' * 64)])
        self.assertEqual(state.adapter.sequence, 2)

    def test_actual_caller_identity_failure_blocks_before_exchange_and_cannot_retry(self):
        state = self.fixture(); original = PermissionError('fixed caller proc refusal')
        state.module.root_process.side_effect = original
        with patch.object(M, 'root_exchange') as worker:
            with self.assertRaises(PermissionError) as raised: state.adapter([])
            self.assertIs(raised.exception, original)
            self.assertTrue(state.adapter.blocked)
            with self.assertRaisesRegex(RuntimeError, 'cannot be retried'): state.adapter([])
            worker.assert_not_called()

    def test_replayed_wrong_source_nonce_or_sequence_never_unblocks_retry(self):
        for field in ('nonce', 'sequence', 'harnessSource', 'codeSha256'):
            state = self.fixture()
            def run(*args):
                result = state.run(*args)
                value = M.parse(result.stdout); value['request'][field] = 99 if field == 'sequence' else '0' * 64
                result.stdout = M.json_bytes(value); return result
            with patch.object(M, 'root_exchange', side_effect=run) as child:
                with self.assertRaises(RuntimeError): state.adapter([])
                with self.assertRaisesRegex(RuntimeError, 'cannot be retried'): state.adapter([])
                self.assertEqual(child.call_count, 1)

    def test_unknown_timeout_incomplete_or_wrong_installed_commit_remains_blocked(self):
        for failure in ('timeout', 'incomplete', 'wrong-runtime', 'stderr', 'oversize'):
            state = self.fixture()
            if failure == 'incomplete': state.module.validate_association.side_effect = ValueError()
            if failure == 'wrong-runtime': state.data['flatpakInfo']['fields']['runtimeCommit'] = 'e' * 64
            def run(*args):
                if failure == 'timeout': raise TimeoutError()
                result = state.run(*args)
                if failure == 'stderr': result.stderr = b'refused'
                if failure == 'oversize': result.stdout = b'x' * 32769
                return result
            with patch.object(M, 'root_exchange', side_effect=run):
                with self.assertRaises((RuntimeError, ValueError, TimeoutError)): state.adapter([])
            self.assertTrue(state.adapter.blocked)

    def test_nonfinite_uid_and_runtime_never_start_a_root_child(self):
        state = self.fixture()
        with patch.object(M.os, 'getuid', return_value=21314, create=True), patch.object(M.os, 'geteuid', return_value=21314, create=True):
            with self.assertRaisesRegex(RuntimeError, 'UID1001'):
                M.RootProxySnapshot(state.module, Path('/fixed'), 'a' * 40, 'b' * 64, {}, {}, state.capture,
                                    dict(appCommit='c' * 64, runtimeCommit='d' * 64))

    def test_association_response_expiry_recheck_blocks_boundary_and_expired_without_retry(self):
        for delta, accepted in ((-1, True), (0, False), (1, False)):
            state = self.fixture()
            clock = [1_000_000_000]
            state.capture.transcript.deadline = 15
            def run(*args):
                result = state.run(*args)
                clock[0] = M.parse(args[2])['expiresNs'] + delta
                return result
            with self.subTest(delta=delta), patch.object(M.time, 'monotonic_ns', side_effect=lambda: clock[0]), \
                    patch.object(M, 'root_exchange', side_effect=run) as worker:
                if accepted:
                    self.assertEqual(state.adapter([]), state.data)
                    self.assertFalse(state.adapter.blocked); self.assertEqual(state.adapter.sequence, 2)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'snapshot expired'): state.adapter([])
                    self.assertTrue(state.adapter.blocked); self.assertEqual(state.adapter.sequence, 1)
                    with self.assertRaisesRegex(RuntimeError, 'cannot be retried'): state.adapter([])
                    self.assertEqual(worker.call_count, 1)

    def test_final_protected_source_recheck_cannot_carry_association_past_expiry(self):
        state = self.fixture(); clock = [1_000_000_000]
        state.capture.transcript.deadline = 15
        def protected(_):
            if state.module.protected_tool.call_count == 2:
                clock[0] = 5_000_000_000
        state.module.protected_tool.side_effect = protected
        with patch.object(M.time, 'monotonic_ns', side_effect=lambda: clock[0]), patch.object(M, 'root_exchange', side_effect=state.run):
            with self.assertRaisesRegex(RuntimeError, 'snapshot expired'): state.adapter([])
        self.assertTrue(state.adapter.blocked); self.assertEqual(state.adapter.sequence, 1)

    def test_root_refusal_retains_only_same_read_numeric_pid_fixed_stage_and_type(self):
        state = self.fixture()
        answer = dict(ok=False, unavailable='PermissionError', stage='complete-uid-inventory', pid=925)
        result = SimpleNamespace(returncode=1, stderr=b'', stdout=M.json_bytes(answer))
        with patch.object(M, 'root_exchange', return_value=result) as child:
            with self.assertRaises(RuntimeError) as raised: state.adapter([])
        value = raised.exception.root_proxy_diagnostic
        self.assertEqual(value, dict(readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False,
                                    type='PermissionError', stage='complete-uid-inventory', pid=925))
        self.assertTrue(state.adapter.blocked); child.assert_called_once()

    def test_terminal_attribution_requires_bound_association_validator_not_fake_ancestry(self):
        spec = importlib.util.spec_from_file_location('association_wire_test', HERE / 'native-linux-flatpak-activation-observer.py')
        observer = importlib.util.module_from_spec(spec); spec.loader.exec_module(observer)
        fixture = LauncherKeyboardTests()
        original = fixture.process(10, 9, '/usr/bin/bwrap')
        parent = fixture.process(13, 10, '/usr/bin/bwrap')
        parent['image'] = copy.deepcopy(original['image'])
        client = fixture.process(14, 13, '/app/bin/creator-hub-flatpak-activate')
        proxy = fixture.process(12, 99, '/usr/bin/xdg-dbus-proxy')
        tree = [client, parent, original]
        association = dict(complete=True, uid=1001, candidateCount=1, scopedProcessCount=8, original=original,
            client=client, tree=tree, proxy=proxy, flatpakInfo=dict(sha256='e' * 64,
                fields=dict(app='com.creatorworks.hub', instanceId='123', appCommit='c' * 64, runtimeCommit='d' * 64)),
            privateInstance=dict(instanceId='123', infoSha256='e' * 64, originalPid=10,
                directories=[[1, n, stat.S_IFDIR | 0o700, 1001, 1001, 2] for n in (1, 2, 3)],
                infoIdentity=[1, 2, stat.S_IFREG | 0o644, 1001, 1001, 1, 200, 5, 6],
                pidIdentity=[1, 3, stat.S_IFREG | 0o644, 1001, 1001, 1, 2, 5, 6]),
            pipes=[dict(appPid=13, appFd=30, proxyFd=32, inode=29948)])
        owner = dict(name=':1.30', pid=40)
        call = dict(kind=1, sender=':1.40', destination=M.NAME, serial=1, replySerial=0, flags=0, empty=True,
                    path='/com/creatorworks/hub/Host', interface='com.creatorworks.hub.Host1', member='Start')
        reply = dict(kind=2, sender=owner['name'], destination=call['sender'], serial=2, replySerial=1, flags=1, empty=True)
        sender = dict(qualified=False, inputPermitted=False, stable=True, sealedBeforeInput=True, correlatesToOriginalPopen=True,
            peer=dict(name=':1.40', pid=12, uid=1001), originalPopen=M.proxy_process_snapshot(original),
            expectedClient=M.proxy_process_snapshot(client), senderAncestors=[M.proxy_process_snapshot(proxy)],
            clientAncestors=[M.proxy_process_snapshot(r) for r in tree], externalAssociation=association)
        value = {k: True for k in ('readOnly', 'armed', 'inputStarted', 'workerStopped', 'busIdentityMatched', 'closed', 'callReplyMatched')}
        value.update({k: False for k in ('qualified', 'inputPermitted', 'authorityGranted', 'releaseReady', 'deadlineExceeded')})
        value.update(messageCount=2, call=call, reply=reply, senderObservation=sender, observedHeaders=[call, reply])
        record = dict(observation=value)
        M.attributed_warm_activation(record, client, original, owner, association_validator=observer.validate_association)
        with self.assertRaises(RuntimeError): M.attributed_warm_activation(record, client, original, owner)
        for change in (lambda r: r['observation']['senderObservation']['externalAssociation'].update(complete=False),
                       lambda r: r['observation']['senderObservation']['peer'].update(pid=99),
                       lambda r: r['observation']['senderObservation']['externalAssociation']['pipes'][0].update(appPid=99),
                       lambda r: r['observation']['senderObservation'].pop('externalAssociation')):
            changed = copy.deepcopy(record); change(changed)
            with self.assertRaises((RuntimeError, ValueError)):
                M.attributed_warm_activation(changed, client, original, owner, association_validator=observer.validate_association)

    def test_workflow_installs_only_bound_observer_and_runs_real_root_probe_before_collection(self):
        text = (HERE.parent / '.github/workflows/native-linux-production-016-flatpak.yml').read_text()
        root = '/var/lib/creator-hub-flatpak-proxy-observer'
        self.assertEqual(text.count('sudo /usr/bin/mkdir -m 0755 ' + root), 1)
        self.assertEqual(text.count('sudo /usr/bin/install -o root -g root -m 0444 scripts/native-linux-flatpak-activation-observer.py'), 1)
        self.assertLess(text.index('await lane.collectHarness'), text.index('sudo /usr/bin/mkdir'))
        self.assertLess(text.index('sudo /usr/bin/install'), text.index('flatpak.py root-preflight'))
        self.assertLess(text.index('flatpak.py root-preflight'), text.index('await lane.collect('))
        self.assertIn("if: inputs.execution_request == '" + M.REQUEST + "'", text[:text.index('await lane.collectHarness')])
        self.assertIn('result.testsRun == 2 and not result.skipped and result.wasSuccessful()', text)
        self.assertIn('test_real_unix_private_instance_holds_exact_info_pid_and_refuses_same_byte_replacement', text)
        self.assertIn('test_real_unix_own_proc_identity_is_stable_without_command_or_environment_reads', text)
        self.assertLess(text.index('result.testsRun == 2'), text.index('await lane.collect('))
        self.assertNotIn('mkdir -p ' + root, text)
        self.assertNotIn('sudo python3 scripts/native-linux-flatpak-activation-observer.py', text)


class WarmLineageWiringTests(unittest.TestCase):
    def test_refused_proxy_capture_reuses_bound_operands_and_checks_both_existing_guards(self):
        session = object.__new__(M.Session)
        attempt = SimpleNamespace(binding=SimpleNamespace(launch={'pid': 10}, verify=Mock()))
        capture = SimpleNamespace(read=Mock(), budget=Mock())
        module, protected, target_guard = SimpleNamespace(proxy_association_diagnostic=Mock()), Mock(), Mock()
        client, tree = {'pid': 14}, {10: {}}
        def diagnostic(*args, **kwargs):
            self.assertEqual(args, (attempt.binding.launch, client, tree, capture.read))
            self.assertIs(kwargs['system_image'], protected)
            self.assertIs(kwargs['pidfds'], M.ObserverPidfds)
            self.assertIs(kwargs['image_open'], M.K.HeldImage)
            self.assertIs(kwargs['budget'], capture.budget)
            kwargs['guard']()
            return {'readOnly': True, 'qualified': False, 'inputPermitted': False, 'authorityGranted': False,
                    'releaseReady': False, 'complete': True, 'associationObserved': True}
        module.proxy_association_diagnostic.side_effect = diagnostic
        with patch.object(M, 'PortalImage', return_value=protected) as opened:
            value = session.capture_refused_proxy_association(module, attempt, client, tree, capture, target_guard)
        opened.assert_called_once_with('proxy'); attempt.binding.verify.assert_called_once(); target_guard.assert_called_once()
        self.assertFalse(value['inputPermitted']); self.assertFalse(value['qualified'])

    def test_actual_captured_observer_import_seals_live_tree_and_never_rereads_parent_after_input(self):
        with LauncherKeyboardTests().fixture('Open Creator Hub', 'warm') as (session, state, _):
            fixture = LauncherKeyboardTests()
            rows = {pid: fixture.process(pid, parent, path) for pid, parent, path in (
                (10, 9, '/usr/bin/bwrap'), (11, 10, '/usr/bin/bwrap'), (12, 11, '/usr/bin/xdg-dbus-proxy'),
                (13, 10, '/usr/bin/bwrap'), (14, 13, '/app/bin/creator-hub-flatpak-activate'))}
            rows[40] = session.report['coldRoot']
            tree = {pid: {k: copy.deepcopy(v) for k, v in row.items() if k != 'kernelImageSha256'} for pid, row in rows.items() if pid != 40}
            reads, images, opened, closed, held = [], {}, [], [], []
            def read(pid, helper, full=True):
                reads.append((pid, full))
                if pid not in rows: raise FileNotFoundError()
                return copy.deepcopy(rows[pid] if full else {k: v for k, v in rows[pid].items() if k != 'kernelImageSha256'})
            def image(pid):
                expected = copy.deepcopy(rows[pid]['image']), rows[pid]['kernelImageSha256']
                result = SimpleNamespace(snapshot=lambda: copy.deepcopy(expected), close=Mock())
                images[pid] = result; held.append(result)
                return result
            names = ('scripts/native-linux-production-016-flatpak.py', 'scripts/native-linux-production-016-flatpak.test.py',
                'scripts/native-linux-flatpak-activation-observer.py', 'scripts/native-linux-flatpak-activation-observer.test.py',
                'scripts/native-linux-flatpak-dialog-input.py', 'scripts/native-linux-flatpak-dialog-input.test.py',
                'scripts/native-unix-window.py', 'scripts/native-unix-window.test.py')
            source = {name: (HERE.parent / name).read_bytes() for name in names}
            binding = dict(harnessSource='a' * 40, harnessFiles={name: pin(raw) for name, raw in source.items()}, profile=M.PROFILE, **M.GATES)
            session.flatpak_child = SimpleNamespace(pid=10)
            session.native.native_process = read
            attempt = SimpleNamespace(binding=SimpleNamespace(launch=rows[10], verify=Mock()))
            connections = []
            def call_sync(destination, path, interface, method, params, reply, flags, timeout, cancelled):
                values = {'GetId': 'a' * 32, 'GetNameOwner': ':1.42', 'GetConnectionUnixProcessID': 40, 'GetConnectionUnixUser': 1001}
                self.assertEqual(destination, 'org.freedesktop.DBus')
                if method == 'BecomeMonitor': return SimpleNamespace(unpack=lambda: ())
                self.assertIn(method, values)
                return SimpleNamespace(unpack=lambda: (values[method],))
            shared = SimpleNamespace(call_sync=call_sync)
            def connect(*_):
                value = Mock(); value.call_sync.side_effect = call_sync; value.add_filter.return_value = 7
                connections.append(value); return value
            gio = SimpleNamespace(Cancellable=SimpleNamespace(new=Mock), DBusCallFlags=SimpleNamespace(NONE=0),
                DBusConnectionFlags=SimpleNamespace(AUTHENTICATION_CLIENT=1, MESSAGE_BUS_CONNECTION=8),
                DBusConnection=SimpleNamespace(new_for_address_sync=connect), BusType=SimpleNamespace(SESSION=1), bus_get_sync=lambda *_: shared)
            glib = SimpleNamespace(Variant=lambda *v: v, VariantType=SimpleNamespace(new=lambda v: v))
            worker = Mock(); worker.is_alive.return_value = False
            system = SimpleNamespace(snapshot=lambda: (copy.deepcopy(rows[12]['image']), rows[12]['kernelImageSha256']), close=Mock())
            with patch.dict(sys.modules, {'gi': SimpleNamespace(), 'gi.repository': SimpleNamespace(Gio=gio, GLib=glib)}), \
                    patch.object(M.sys, 'platform', 'linux'), patch.object(M.os, 'geteuid', return_value=1001, create=True), \
                    patch.dict(M.os.environ, {'GITHUB_SHA': 'a' * 40, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/private-ci-bus'}), \
                    patch.object(M, 'regular', return_value=M.json_bytes(binding)), \
                    patch.object(M, 'bound', side_effect=lambda path, *_: source[path.relative_to(HERE.parent).as_posix()]), \
                    patch.object(M.P, 'subtree', return_value=tree), patch.object(M.K, 'HeldImage', side_effect=image), \
                    patch.object(M, 'PortalImage', return_value=system), \
                    patch.object(M.ObserverPidfds, 'open', side_effect=lambda pid: opened.append(pid) or pid), \
                    patch.object(M.ObserverPidfds, 'ready', return_value=False), \
                    patch.object(M.ObserverPidfds, 'close', side_effect=closed.append), \
                    patch('threading.Timer', return_value=Mock()), patch('threading.Thread', return_value=worker):
                pending = M.Session.start_warm_activation_diagnostic(session, rows[14], attempt)
                self.assertNotIn('unavailable', pending['record'])
                capture = pending['capture']; capture.begin_input()
                self.assertEqual(set(opened), {10, 11, 12, 13, 14})
                del rows[11]; del rows[13]; reads.clear()
                observed = capture.baseline.observe(':1.40', lambda name: dict(name=name, pid=12, uid=1001), budget=capture.budget)
                self.assertTrue(observed['stable']); self.assertEqual({pid for pid, _ in reads}, {12})
                M.Session.finish_warm_activation_diagnostic(session, pending)
                self.assertEqual(system.close.call_count, 1)
                # Pure source-bound refusal captures: neither case executes input or native GI.
                rows.update({11: fixture.process(11, 10, '/usr/bin/bwrap'), 13: fixture.process(13, 10, '/usr/bin/bwrap')})
                system.snapshot = lambda: (copy.deepcopy(rows[12]['image']), 'f' * 64)
                refused = M.Session.start_warm_activation_diagnostic(session, rows[14], attempt)
                self.assertEqual(refused['record']['unavailable'], 'ValueError')
                self.assertEqual(refused['record']['setupFailureStage'], 'pre-input-lineage-create')
                self.assertEqual(refused['record']['preInputBaseline']['failureStage'], 'candidate-system-image-match')
                self.assertEqual(refused['record']['preInputBaseline']['failurePid'], 12)
                self.assertFalse(refused['record']['setupStateAtFailure']['deadlineExceeded'])
                self.assertIsNone(refused['capture'].baseline)
                M.Session.finish_warm_activation_diagnostic(session, refused)
                self.assertFalse(refused['record']['observation']['armed']); self.assertFalse(refused['record']['observation']['inputStarted'])
                self.assertEqual(refused['record']['observation']['callbackMessages'], 0)
                self.assertEqual(system.close.call_count, 2)
                system.snapshot = lambda: (copy.deepcopy(rows[12]['image']), rows[12]['kernelImageSha256'])
                # No descendant proxy now requires the separate finite root adapter;
                # refusal there cannot fall back to incomplete unprivileged evidence.
                proxy = tree.pop(12)
                connections_before = len(connections)
                session.review = {'flatpak': {'commit': 'c' * 64}}
                for broken in (False, True):
                    installed = dict(ref=M.REF, runtime=M.RUNTIME, commit='c' * 64, runtimeCommit='d' * 64)
                    with patch.object(M.Session, 'capture_refused_proxy_association') as diagnostic, \
                            patch.object(M, 'regular', return_value=M.json_bytes(installed)), \
                            patch.object(M, 'RootProxySnapshot', side_effect=ValueError('PRIVATE ROOT REFUSAL') if broken
                                         else TimeoutError('PRIVATE ROOT DEADLINE')) as adapter:
                        # Keep the independently bound source inventory for its initial read.
                        def regular(path, *_):
                            return M.json_bytes(installed) if path.name == 'installed-flatpak.json' else M.json_bytes(binding)
                        with patch.object(M, 'regular', side_effect=regular):
                            refused = M.Session.start_warm_activation_diagnostic(session, rows[14], attempt)
                    diagnostic.assert_not_called(); adapter.assert_called_once()
                    self.assertEqual(refused['record']['unavailable'], 'ValueError' if broken else 'TimeoutError')
                    self.assertEqual(refused['record']['setupFailureStage'], 'external-instance-admission')
                    self.assertEqual(refused['record']['preInputBaseline']['candidateCount'], 0)
                    self.assertIsNone(refused['capture'].baseline)
                    M.Session.finish_warm_activation_diagnostic(session, refused)
                    self.assertFalse(refused['record']['observation']['armed'])
                    self.assertFalse(refused['record']['observation']['inputStarted'])
                    self.assertEqual(len(connections), connections_before)
                    self.assertNotIn('PRIVATE ROOT', M.json_bytes(refused['record']).decode())
                    self.assertNotIn('externalProxyDiagnostic', refused['record'])
                tree[12] = proxy
                def arm_refusal(*_): raise ValueError('PRIVATE ARM ERROR')
                gio.DBusConnection.new_for_address_sync = arm_refusal
                refused = M.Session.start_warm_activation_diagnostic(session, rows[14], attempt)
                self.assertEqual(refused['record']['setupFailureStage'], 'observer-arm')
                self.assertNotIn('failureStage', refused['record']['preInputBaseline'])
                self.assertIsNotNone(refused['capture'].baseline)
                M.Session.finish_warm_activation_diagnostic(session, refused)
                self.assertNotIn('PRIVATE ARM ERROR', M.json_bytes(refused['record']).decode())
            self.assertCountEqual(closed, opened)
            self.assertTrue(all(item.close.call_count == 1 for item in held))
            self.assertEqual(system.close.call_count, 3)  # Both external-adapter refusals precede image opening.


class LauncherReadinessDiagnosticTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, map_state=0, override=0, foreign=False, query_failure=False):
        with LauncherKeyboardTests().fixture() as (session, state, source_read):
            original = RuntimeError('Owned X window is not a managed visible window')
            observations = {'stack': (33, 32, [100]), 'map': map_state, 'override': override, 'reads': 0}
            inspect = Mock(side_effect=original)
            session.x11.inspect = inspect
            session.x11.x = SimpleNamespace(XDefaultRootWindow=lambda _: 50)
            session.x11.display = 99
            session.x11.property = lambda window, name: copy.deepcopy(observations['stack']) if name == '_NET_CLIENT_LIST_STACKING' else (33, 32, [100 if name == '_NET_ACTIVE_WINDOW' else 60])
            def attributes(window):
                self.assertEqual(window, 100)
                observations['reads'] += 1
                if query_failure: raise PermissionError('PRIVATE QUERY ERROR')
                return SimpleNamespace(map_state=observations['map'], override_redirect=observations['override'], class_=1, root=50)
            queries = SimpleNamespace(attributes=Mock(side_effect=attributes),
                xres_identity=Mock(return_value={'pid': 99 if foreign else 14, 'client': 900}),
                submit=Mock(side_effect=AssertionError('No diagnostic input')),
                snapshot=Mock(side_effect=AssertionError('No managed/title query in diagnostic')))
            with patch.object(M.K, 'NativeWindow', return_value=queries) as constructor:
                yield session, state, original, inspect, observations, queries, constructor

    def failed(self, session, original):
        with self.assertRaises(RuntimeError) as raised:
            session.flatpak('Cancel', 'disclosure-cancel')
        self.assertIs(raised.exception, original)
        return M.parse((session.root / 'disclosure-cancel-readiness-gtk.json').read_bytes())

    def test_initial_visibility_refusal_retains_bounded_raw_observations_without_input_or_retry(self):
        with self.fixture() as (session, state, original, inspect, observations, queries, constructor):
            with patch.object(session, 'stable', wraps=session.stable) as stable, \
                    patch.object(session, 'flatpak_guard', wraps=session.flatpak_guard) as guard:
                record = self.failed(session, original)
            self.assertEqual(stable.call_count, 4); self.assertEqual(guard.call_count, 4)
            self.assertEqual(record['failingXid'], 100); self.assertEqual(record['originalCandidates'], [100])
            self.assertEqual(record['expectedClient']['pid'], 14)
            self.assertEqual(record['before']['candidate']['attributes'], {'map_state': 0, 'override_redirect': 0, 'class': 1, 'root': 50})
            self.assertEqual(record['before'], record['after'])
            self.assertEqual(record['before']['candidate']['xres'], {'pid': 14, 'client': 900})
            self.assertTrue(record['complete']); self.assertTrue(record['stable'])
            self.assertTrue(record['observationsAfterRefusal']); self.assertFalse(record['refusalAttributesCaptured'])
            for flag in ('inputPermitted', 'authorityGranted', 'readinessAccepted', 'actionAttempted', 'releaseReady'):
                self.assertIs(record[flag], False)
            self.assertEqual(state.sends, []); self.assertEqual(state.captures, [])
            inspect.assert_called_once_with(100); constructor.assert_called_once()
            self.assertEqual(observations['reads'], 2)
            queries.submit.assert_not_called(); queries.snapshot.assert_not_called()
            self.assertFalse((session.root / 'disclosure-cancel-gtk.json').exists())

    def test_original_query_error_types_are_never_caught_as_readiness_or_retried(self):
        for error in (RuntimeError('Owned X window is unavailable'), PermissionError('original query denied'), OSError('original query failed')):
            with self.subTest(kind=type(error).__name__), self.fixture() as (session, state, _, inspect, observations, queries, _):
                inspect.side_effect = error
                with self.assertRaises(type(error)) as raised: session.flatpak('Cancel', 'disclosure-cancel')
                self.assertIs(raised.exception, error)
                record = M.parse((session.root / 'disclosure-cancel-readiness-gtk.json').read_bytes())
                self.assertEqual(record['originalExceptionType'], type(error).__name__)
                self.assertFalse(record['readinessAccepted']); self.assertFalse(record['inputPermitted'])
                self.assertEqual(state.sends, []); inspect.assert_called_once()
                queries.submit.assert_not_called()

    def test_unviewable_override_redirect_and_query_unknown_remain_fatal(self):
        for map_state, override, failure in ((0, 0, False), (1, 0, False), (2, 1, False), (2, 0, True)):
            with self.subTest(map_state=map_state, override=override, failure=failure), self.fixture(
                    map_state=map_state, override=override, query_failure=failure) as (session, state, original, inspect, _, queries, _):
                record = self.failed(session, original)
                self.assertEqual(record['complete'], not failure)
                self.assertFalse(record['readinessAccepted']); self.assertEqual(state.sends, [])
                self.assertNotIn('PRIVATE', json.dumps(record)); inspect.assert_called_once()
                queries.submit.assert_not_called()

    def test_foreign_candidate_exports_raw_xres_but_never_process_or_window_content(self):
        with self.fixture(foreign=True) as (session, state, original, inspect, _, queries, _):
            native = session.native.native_process
            with patch.object(session.native, 'native_process', wraps=native) as reads:
                record = self.failed(session, original)
            self.assertEqual(record['before']['candidate']['xres'], {'pid': 99, 'client': 900})
            self.assertTrue(record['before']['candidate']['processRedacted'])
            self.assertNotIn('process', record['before']['candidate'])
            self.assertFalse(record['stable'])
            self.assertNotIn(99, [call.args[0] for call in reads.call_args_list])
            inspect.assert_called_once_with(100); queries.snapshot.assert_not_called()

    def test_failed_diagnostic_or_receipt_write_preserves_original_refusal(self):
        for stage in ('constructor', 'capture', 'write'):
            with self.subTest(stage=stage), self.fixture() as (session, state, original, inspect, _, queries, constructor):
                if stage == 'constructor': constructor.side_effect = RuntimeError('PRIVATE CONSTRUCTOR')
                if stage == 'capture': queries.xres_identity.side_effect = PermissionError('PRIVATE XRES')
                with patch.object(M, 'save', side_effect=OSError('PRIVATE WRITE')) if stage == 'write' else nullcontext():
                    with self.assertRaises(RuntimeError) as raised: session.flatpak('Cancel', 'disclosure-cancel')
                self.assertIs(raised.exception, original)
                self.assertEqual(state.sends, []); inspect.assert_called_once()
                if stage != 'write':
                    record = M.parse((session.root / 'disclosure-cancel-readiness-gtk.json').read_bytes())
                    self.assertFalse(record['complete']); self.assertFalse(record['stable'])
                    self.assertNotIn('PRIVATE', json.dumps(record))

    def test_wm_map_or_xres_drift_is_evidence_not_readiness_or_authority(self):
        with self.fixture() as (session, state, original, inspect, observations, queries, _):
            initial = queries.attributes.side_effect
            def changed(window):
                attrs = initial(window)
                observations.update(map=2, stack=(33, 32, [100, 101]))
                return attrs
            queries.attributes.side_effect = changed
            record = self.failed(session, original)
            self.assertEqual(record['before']['candidate']['attributes']['map_state'], 0)
            self.assertEqual(record['after']['candidate']['attributes']['map_state'], 2)
            self.assertNotEqual(record['before']['wm'], record['after']['wm'])
            self.assertFalse(record['stable']); self.assertFalse(record['inputPermitted'])
            self.assertEqual(state.sends, []); inspect.assert_called_once()

    def test_expected_process_drift_and_bounds_stop_diagnostics_without_masking_refusal(self):
        for failure in ('process', 'popen', 'bounds'):
            with self.subTest(failure=failure), self.fixture() as (session, state, original, inspect, observations, queries, _):
                if failure == 'process':
                    session.stable = Mock(side_effect=RuntimeError('PRIVATE IDENTITY'))
                if failure == 'popen': session.flatpak_guard = Mock(side_effect=RuntimeError('PRIVATE POPEN'))
                if failure == 'bounds': session.windows = lambda: list(range(100, 109))
                record = self.failed(session, original)
                self.assertFalse(record['complete']); self.assertFalse(record['stable'])
                self.assertFalse(record['inputPermitted']); self.assertNotIn('PRIVATE', json.dumps(record))
                self.assertEqual(state.sends, []); inspect.assert_called_once()

    def test_late_identity_change_is_unknown_and_existing_evidence_is_never_overwritten(self):
        with self.fixture() as (session, state, original, inspect, _, queries, _):
            stable, calls = session.stable, []
            def changed(client):
                calls.append(None)
                if len(calls) == 4: raise RuntimeError('PRIVATE LATE IDENTITY')
                return stable(client)
            session.stable = changed
            record = self.failed(session, original)
            self.assertFalse(record['complete']); self.assertFalse(record['stable'])
            self.assertTrue(record['after']['expectedClientVerifiedBefore'])
            self.assertFalse(record['after']['expectedClientVerifiedAfter'])
            self.assertEqual(state.sends, []); inspect.assert_called_once()
        with self.fixture() as (session, state, original, inspect, _, queries, _):
            receipt = session.root / 'disclosure-cancel-readiness-gtk.json'
            receipt.write_bytes(b'original retained evidence')
            with self.assertRaises(RuntimeError) as raised: session.flatpak('Cancel', 'disclosure-cancel')
            self.assertIs(raised.exception, original)
            self.assertEqual(receipt.read_bytes(), b'original retained evidence')
            self.assertEqual(state.sends, []); inspect.assert_called_once()


class LauncherOriginalVisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('shared_visibility_guard_tests', HERE / 'native-unix-window.test.py')
        cls.shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.shared)

    def refused(self, map_state=0, override=0, *, alter=None, helper_origin=True, diagnostic_failure=None, foreign=False):
        source, _ = self.shared.XResTests().native_fixture()
        raw_reads, errors = [], []
        def attributes(display, window, pointer):
            raw_reads.append(window)
            attrs = self.shared.C.cast(pointer, self.shared.C.POINTER(self.shared.h.WindowAttributes)).contents
            attrs.map_state, attrs.override_redirect, attrs.class_ = map_state, override, 1
            return 1
        source.x.XGetWindowAttributes = attributes
        with LauncherReadinessDiagnosticTests().fixture(map_state=2, override=0, foreign=foreign,
                query_failure=diagnostic_failure == 'query') as (session, state, _, inspect, observations, queries, constructor):
            if helper_origin:
                session.helper._VISIBILITY_DIAGNOSTIC_ORIGIN = self.shared.h._VISIBILITY_DIAGNOSTIC_ORIGIN
            def exact_guard(window):
                try:
                    source.inspect(window)
                except RuntimeError as error:
                    errors.append(error)
                    if alter is not None: alter(error)
                    raise
            inspect.side_effect = exact_guard
            if diagnostic_failure == 'constructor': constructor.side_effect = RuntimeError('PRIVATE DIAGNOSTIC')
            with self.assertRaises(RuntimeError) as raised:
                session.flatpak('Cancel', 'disclosure-cancel')
            self.assertIs(raised.exception, errors[0])
            record = M.parse((session.root / 'disclosure-cancel-readiness-gtk.json').read_bytes())
            self.assertEqual(raw_reads, [100]); inspect.assert_called_once_with(100)
            self.assertEqual(state.sends, []); self.assertEqual(state.captures, [])
            for flag in ('inputPermitted', 'authorityGranted', 'readinessAccepted', 'actionAttempted', 'releaseReady'):
                self.assertIs(record[flag], False)
            self.assertNotIn('PRIVATE', json.dumps(record))
            return record, raised.exception

    def test_exact_original_unmapped_or_override_attributes_are_separate_from_later_healthy_observations(self):
        for map_state, override in ((0, 0), (1, 0), (2, 1)):
            with self.subTest(map_state=map_state, override=override):
                record, error = self.refused(map_state, override)
                self.assertEqual(str(error), 'Owned X window is not a managed visible window')
                self.assertTrue(record['refusalAttributesCaptured'])
                self.assertEqual(record['originalRefusalAttributes'],
                    {'window': 100, 'map_state': map_state, 'override_redirect': override, 'class': 1})
                self.assertEqual(record['before']['candidate']['attributes']['map_state'], 2)
                self.assertEqual(record['before']['candidate']['attributes']['override_redirect'], 0)
                self.assertTrue(record['observationsAfterRefusal'])

    def test_original_attributes_survive_post_refusal_capture_failure(self):
        for failure in ('constructor', 'query'):
            with self.subTest(failure=failure):
                record, error = self.refused(diagnostic_failure=failure)
                self.assertTrue(record['refusalAttributesCaptured'])
                self.assertEqual(record['originalRefusalAttributes'], error.window_visibility_refusal)
                self.assertFalse(record['complete'])
                self.assertEqual(str(error), 'Owned X window is not a managed visible window')

    def test_missing_forged_or_inconsistent_metadata_is_ignored_without_masking_original_error(self):
        changes = (lambda e: delattr(e, 'window_visibility_refusal'), lambda e: delattr(e, '_visibility_diagnostic_origin'),
                   lambda e: setattr(e, '_visibility_diagnostic_origin', object()),
                   lambda e: e.window_visibility_refusal.update(window=101),
                   lambda e: e.window_visibility_refusal.update(map_state=2, override_redirect=0),
                   lambda e: e.window_visibility_refusal.update(inputPermitted=1),
                   lambda e: e.window_visibility_refusal.update(map_state=False),
                   lambda e: e.window_visibility_refusal.update(**{'class': 'PRIVATE'}),
                   lambda e: e.window_visibility_refusal.update(**{'class': 2**31}),
                   lambda e: setattr(e, 'args', ('Owned X window is unavailable',)))
        for change in changes:
            with self.subTest(change=change):
                record, _ = self.refused(alter=change)
                self.assertFalse(record['refusalAttributesCaptured'])
                self.assertNotIn('originalRefusalAttributes', record)
                self.assertTrue(record['complete'])
        record, _ = self.refused(helper_origin=False)
        self.assertFalse(record['refusalAttributesCaptured'])
        self.assertNotIn('originalRefusalAttributes', record)

    def test_original_attribute_capture_never_claims_foreign_window_ownership(self):
        record, _ = self.refused(foreign=True)
        self.assertTrue(record['refusalAttributesCaptured'])
        self.assertTrue(record['before']['candidate']['processRedacted'])
        self.assertFalse(record['before']['candidate']['matchesExpectedPid'])
        self.assertFalse(record['stable'])


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
                    patch.object(M, 'RealPortalCapture', return_value=SimpleNamespace(calls=[{'url': M.PORTAL_URL}],
                        poll=lambda: None, evidence=lambda: {'synthetic': True}, close=lambda: None)), \
                    patch.object(M, 'verify_registration'), patch.object(M, 'command'), \
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
        self.assertEqual(workflow.count("if: inputs.execution_request == '" + M.REQUEST + "'"), 6)
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


class NativeSetupConsentTests(unittest.TestCase):
    generation = 'a' * 64

    def receipt_rows(self):
        # Native 39409484679 row shape, with only the generation replaced by synthetic data.
        body = ('Install Creator Hub native support 0.1.16?\n\nThis installs and registers the verified generation '
                + self.generation + ' in your private native data directory. The Hub window runs OUTSIDE the Flatpak sandbox '
                'and uses your existing native settings.\n\nYour projects, MCP connections and settings will not be imported, '
                'replaced or migrated here. After installation, close this window normally and reopen Hub from Flatpak. '
                'No app will be launched or restarted automatically.\n\nCancel keeps Store creation, selection and registration unchanged.')
        pairs = [('alert', 'Information'), ('filler', ''), ('filler', ''), ('icon', 'Information'), ('filler', ''),
                 ('label', 'Install native support'), ('label', body), ('filler', ''), ('filler', ''),
                 ('push button', 'Install native support'), ('push button', 'Cancel')]
        return [{'role': role, 'name': name, 'showing': True, 'enabled': True} for role, name in pairs]

    def callsite_contracts(self):
        tree = ast.parse(Path(M.__file__).read_text('utf8'))
        session = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Session')
        setup = next(node for node in session.body if isinstance(node, ast.FunctionDef) and node.name == 'setup')
        calls = [node for node in ast.walk(setup) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                 and node.func.attr == 'click_dialog']
        self.assertEqual(len(calls), 2)
        result = {}
        for call in calls:
            self.assertEqual(len(call.args), 6)
            labels = call.args[1]
            self.assertIsInstance(labels, ast.List)
            self.assertEqual(len(labels.elts), 2, 'Setup must expect the exact GTK title and body')
            title = ast.literal_eval(labels.elts[0])
            self.assertEqual(title, 'Install native support')
            self.assertEqual(ast.dump(labels.elts[1], include_attributes=False), ast.dump(ast.parse(
                'consent_text(self.review["generation"])', mode='eval').body, include_attributes=False))
            phase, action = ast.literal_eval(call.args[4]), ast.literal_eval(call.args[3])
            self.assertNotIn(phase, result)
            self.assertEqual(ast.literal_eval(call.args[5]), title)
            result[phase] = ([title, M.consent_text(self.generation)], ast.literal_eval(call.args[2]), action)
        self.assertEqual(set(result), {'setup-cancel', 'setup-approve'})
        return result

    def test_both_actual_setup_callsite_contracts_match_redacted_native_receipt(self):
        rows = self.receipt_rows()
        contracts = self.callsite_contracts()
        for phase, index in (('setup-cancel', 10), ('setup-approve', 9)):
            labels, buttons, action = contracts[phase]
            self.assertEqual(action, 'Cancel' if phase == 'setup-cancel' else 'Install native support')
            self.assertEqual(M.dialog_target(rows, labels, buttons, action), index)

    def test_title_and_577_character_body_are_exactly_source_bound(self):
        rows = self.receipt_rows()
        self.assertEqual(len(rows[6]['name']), 577)
        self.assertEqual(rows[6]['name'], M.consent_text(self.generation))
        source = (HERE.parent / 'src-tauri/src/native_support.rs').read_text('utf8')
        self.assertIn('.title("Install native support")', source)
        template = rows[6]['name'].replace('0.1.16?', '{}?').replace(self.generation, '{}')
        self.assertIn(json.dumps(template), source)

    def test_extra_duplicate_missing_or_changed_title_body_and_generation_refuse(self):
        mutations = (lambda rows: rows.append({'role': 'label', 'name': 'extra', 'showing': True, 'enabled': True}),
                     lambda rows: rows.append(copy.deepcopy(rows[5])), lambda rows: rows.append(copy.deepcopy(rows[6])),
                     lambda rows: rows.pop(5), lambda rows: rows.pop(6),
                     lambda rows: rows[5].update(name='Different native question'),
                     lambda rows: rows[6].update(name=rows[6]['name'] + ' '),
                     lambda rows: rows[6].update(name=rows[6]['name'].replace(self.generation, 'b' * 64)))
        for phase, (labels, buttons, action) in self.callsite_contracts().items():
            for index, mutate in enumerate(mutations):
                with self.subTest(phase=phase, mutation=index), self.assertRaisesRegex(RuntimeError, 'Exact source-bound native question'):
                    rows = self.receipt_rows(); mutate(rows)
                    M.dialog_target(rows, labels, buttons, action)

    def test_missing_extra_duplicate_changed_or_disabled_buttons_still_refuse(self):
        for phase, (labels, buttons, action) in self.callsite_contracts().items():
            target = 10 if phase == 'setup-cancel' else 9
            mutations = (lambda rows: rows.pop(9), lambda rows: rows.append(copy.deepcopy(rows[9])),
                         lambda rows: rows.append({'role': 'push button', 'name': 'extra', 'showing': True, 'enabled': True}),
                         lambda rows: rows[9].update(name='Other approval'),
                         lambda rows: rows[target].update(enabled=False), lambda rows: rows[target].update(showing=False))
            for index, mutate in enumerate(mutations):
                with self.subTest(phase=phase, mutation=index), self.assertRaises(RuntimeError):
                    rows = self.receipt_rows(); mutate(rows)
                    M.dialog_target(rows, labels, buttons, action)


class ReadinessClientTests(unittest.TestCase):
    @contextmanager
    def fixture(self, change=None):
        names = (M.DESCRIPTOR, M.DESCRIPTOR + '.minisig', M.MANIFEST, M.MANIFEST + '.minisig')
        bodies = {name: ('signed fixture ' + str(index)).encode() for index, name in enumerate(names)}
        review = {'signed': {'files': {name: pin(raw) for name, raw in bodies.items()}}}
        root, proxy = Path('/private/fixture'), 'http://127.0.0.1:12345'
        image = Mock(pin=({'synthetic': 'protected curl'}, 'a' * 64))
        image.snapshot.return_value = image.pin
        calls = []
        def command(args, **kwargs):
            calls.append((args, kwargs))
            name = names[len(calls) - 1]
            metadata = {'http_code': 200, 'http_connect': 200, 'http_version': '1.1', 'num_redirects': 0,
                        'ssl_verify_result': 0, 'url_effective': 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/' + name}
            raw = bodies[name] + b'\n' + M.json_bytes(metadata)
            return change(raw, metadata, bodies[name]) if change else raw
        with patch.object(M, 'PortalImage', return_value=image) as image_open, patch.object(M, 'command', side_effect=command) as run, \
                patch.object(M.socket, 'create_connection', side_effect=AssertionError('Pure test must not open any socket')):
            yield SimpleNamespace(root=root, proxy=proxy, image=image, image_open=image_open,
                                  run=run, calls=calls, review=review, bodies=bodies)

    def test_fixed_curl_http11_exact_urls_system_tls_and_no_redirects_or_user_configuration(self):
        before = {**ENV, 'HTTPS_PROXY': 'http://foreign', 'NO_PROXY': '*', 'CURL_CA_BUNDLE': '/foreign', 'GH_TOKEN': 'never-copy'}
        with patch.dict(M.os.environ, before, clear=True), self.fixture() as f:
            M.bootstrap_transport_ready(f.root, f.review, f.proxy)
            self.assertEqual(dict(M.os.environ), before)
            f.image_open.assert_called_once_with('curl')
            self.assertEqual(len(f.calls), 4)
            self.assertEqual(f.image.snapshot.call_count, 8)
            f.image.close.assert_called_once()
            for (args, kwargs), (name, body) in zip(f.calls, f.bodies.items()):
                expected = ['/usr/bin/curl', '--disable', '--silent', '--show-error', '--fail', '--http1.1',
                    '--proto', '=https', '--proto-redir', '=https', '--no-location', '--max-redirs', '0', '--retry', '0',
                    '--proxy', f.proxy, '--noproxy', '', '--tlsv1.2', '--connect-timeout', '10', '--max-time', '30',
                    '--max-filesize', str(len(body)), '--write-out', '\n%{json}', '--url',
                    'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/' + name]
                self.assertEqual(args, expected)
                self.assertEqual(kwargs, {'env': M.clean_environment(f.root), 'timeout': 35, 'limit': len(body) + 16384})
                for forbidden in ('--insecure', '-k', '--location', '--http1.0', '--proxy-http1.0', '--cacert', '--config'):
                    self.assertNotIn(forbidden, args)
                for key in ('CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'GH_TOKEN', 'NO_PROXY'):
                    self.assertNotIn(key, kwargs['env'])

    def test_http10_redirect_wrong_url_and_tls_verification_fail_without_fallback(self):
        for field, value in (('http_version', '1.0'), ('http_code', 302), ('http_connect', 407), ('num_redirects', 1),
                             ('url_effective', 'https://foreign.invalid/'), ('ssl_verify_result', 60), ('ssl_verify_result', False)):
            def change(_raw, metadata, body):
                return body + b'\n' + M.json_bytes({**metadata, field: value})
            with self.subTest(field=field, value=value), self.fixture(change) as f:
                with self.assertRaises(RuntimeError):
                    M.bootstrap_transport_ready(f.root, f.review, f.proxy)
                self.assertEqual(len(f.calls), 1); f.image.close.assert_called_once()

    def test_missing_malformed_oversized_metadata_and_wrong_size_or_hash_fail(self):
        changes = (lambda raw, metadata, body: body, lambda raw, metadata, body: body + b'\nnot-json',
                   lambda raw, metadata, body: body + b'\n' + M.json_bytes({}),
                   lambda raw, metadata, body: body + b'\n' + b'x' * 16385,
                   lambda raw, metadata, body: body[:-1] + b'\n' + M.json_bytes(metadata),
                   lambda raw, metadata, body: body + b'x\n' + M.json_bytes(metadata),
                   lambda raw, metadata, body: b'x' * len(body) + b'\n' + M.json_bytes(metadata))
        for change in changes:
            with self.subTest(change=change), self.fixture(change) as f:
                with self.assertRaises((RuntimeError, ValueError)):
                    M.bootstrap_transport_ready(f.root, f.review, f.proxy)
                self.assertEqual(len(f.calls), 1); f.image.close.assert_called_once()

    def test_missing_unprotected_or_changed_curl_never_gets_a_readiness_pass(self):
        with self.fixture() as f:
            f.image_open.side_effect = FileNotFoundError('/usr/bin/curl')
            with self.assertRaises(FileNotFoundError):
                M.bootstrap_transport_ready(f.root, f.review, f.proxy)
            f.run.assert_not_called()
        with self.fixture() as f:
            f.image.snapshot.side_effect = RuntimeError('Unprotected curl image')
            with self.assertRaisesRegex(RuntimeError, 'Unprotected'):
                M.bootstrap_transport_ready(f.root, f.review, f.proxy)
            f.run.assert_not_called(); f.image.close.assert_called_once()
        with self.fixture() as f:
            f.image.snapshot.side_effect = [f.image.pin, ({'changed': True}, 'b' * 64)]
            with self.assertRaises(RuntimeError):
                M.bootstrap_transport_ready(f.root, f.review, f.proxy)
            self.assertEqual(len(f.calls), 1); f.image.close.assert_called_once()

    def test_curl_uses_only_the_existing_protected_system_image_boundary(self):
        directory = SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)
        content = SimpleNamespace(st_dev=1, st_ino=3, st_size=64, st_mode=stat.S_IFREG | 0o755, st_uid=0, st_gid=0,
                                  st_mtime_ns=1, st_ctime_ns=2, st_nlink=1)
        with patch.object(M.os, 'O_NOFOLLOW', 0x20000, create=True), patch.object(M.os, 'O_DIRECTORY', 0x10000, create=True), \
                patch.object(M.os, 'O_CLOEXEC', 0x80000, create=True), patch.object(M.os, 'O_NONBLOCK', 0x800, create=True), \
                patch.object(M.os, 'open', side_effect=[10, 11, 12, 13]) as opened, patch.object(M.os, 'close') as close, \
                patch.object(M.os, 'fstat', side_effect=lambda fd: content if fd == 13 else directory), \
                patch.object(M.os, 'stat', side_effect=lambda name, **_: content if name == 'curl' else directory), \
                patch.object(M.K.HeldImage, 'snapshot', return_value=({'synthetic': 'held image'}, 'a' * 64)):
            image = M.PortalImage('curl')
            self.assertEqual(image.path.replace('\\', '/'), '/usr/bin/curl')
            self.assertEqual([call.args[0] for call in opened.call_args_list], ['/', 'usr', 'bin', 'curl'])
            self.assertTrue(all(call.args[1] & M.os.O_NOFOLLOW for call in opened.call_args_list))
            with patch.object(M.os, 'fstat', side_effect=lambda fd: SimpleNamespace(**{**vars(content), 'st_mode': stat.S_IFREG | 0o777})
                              if fd == 13 else directory), self.assertRaises(RuntimeError):
                image.snapshot()
            image.close()
            self.assertEqual([call.args[0] for call in close.call_args_list], [13, 12, 11, 10])
        with patch.object(M.os, 'open') as opened, patch.object(M.os, 'execve') as execute:
            with self.assertRaises(RuntimeError):
                M.PortalImage('/tmp/curl')
            with self.assertRaises(RuntimeError):
                M.portal_provider('curl')
            opened.assert_not_called(); execute.assert_not_called()

    def test_client_failure_is_not_retried_and_never_changes_system_trust(self):
        with self.fixture() as f, patch.object(M, 'prepare_tls') as trust:
            f.run.side_effect = RuntimeError('curl certificate or transfer failure')
            with self.assertRaisesRegex(RuntimeError, 'curl certificate'):
                M.bootstrap_transport_ready(f.root, f.review, f.proxy)
            self.assertEqual(f.run.call_count, 1); trust.assert_not_called(); f.image.close.assert_called_once()

    def test_foreign_proxy_and_invalid_pin_refuse_before_any_transfer(self):
        for proxy in ('http://localhost:12345', 'http://127.0.0.1:0', 'http://foreign:443'):
            with self.subTest(proxy=proxy), self.fixture() as f, self.assertRaises(RuntimeError):
                M.bootstrap_transport_ready(f.root, f.review, proxy)
            f.run.assert_not_called()
        for bad in ({'size': True, 'sha256': 'a' * 64}, {'size': 2 * 1024 * 1024 + 1, 'sha256': 'a' * 64},
                    {'size': 5, 'sha256': 'wrong'}):
            with self.subTest(pin=bad), self.fixture() as f:
                f.review['signed']['files'][M.DESCRIPTOR] = bad
                with self.assertRaises(RuntimeError):
                    M.bootstrap_transport_ready(f.root, f.review, f.proxy)
                f.run.assert_not_called()


class RealPortalTests(unittest.TestCase):
    @contextmanager
    def capture_fixture(self, frames=None):
        capture = object.__new__(M.RealPortalCapture)
        events, channel = [], Mock()
        channel.getsockopt.return_value = M.struct.pack('3i', 31, 1001, 1001)
        channel.sendall.side_effect = lambda raw: events.append(('send', M.parse(raw)['kind']))
        listener = Mock()
        listener.accept.side_effect = [(channel, None), BlockingIOError(), BlockingIOError(), BlockingIOError()]
        worker = {'pid': 31, 'parentPid': 20, 'startTime': '300', 'uids': [1001] * 4,
                  'executable': '/usr/bin/python3.10', 'image': {'st_size': '64'}, 'kernelImageSha256': 'a' * 64}
        def native_process(_pid, _helper, full=True):
            return {key: copy.deepcopy(value) for key, value in worker.items() if full or key != 'kernelImageSha256'}
        capture.session = SimpleNamespace(native=SimpleNamespace(native_process=native_process), helper=None)
        capture.images = {'python': SimpleNamespace(path=worker['executable'], pin=(worker['image'], 'a' * 64))}
        capture.providers = {'portal': SimpleNamespace(child=SimpleNamespace(pid=20), process={'pid': 20, 'startTime': '200'})}
        capture.source_pin, capture.nonce = pin(b'exact source'), 'a' * 64
        capture.listener, capture.channel = listener, None
        capture.worker_image, capture.state = None, 'listening'
        capture.connections, capture.armed, capture.deadline = 0, True, 100
        capture.calls, capture.receipt = [], {'workerCompleted': False}
        capture.guard = Mock(side_effect=lambda: events.append(('guard', 'provider')))
        capture.protected_state = Mock(side_effect=lambda: events.append(('guard', 'settings')))
        capture.worker_guard = Mock(side_effect=lambda: events.append(('guard', 'worker')))
        capture.receive = Mock(side_effect=frames if frames is not None else [
            {'kind': 'ready', 'nonce': capture.nonce, 'url': M.PORTAL_URL}, {'kind': 'complete', 'nonce': capture.nonce}])
        with patch.object(M.os, 'getuid', return_value=1001, create=True), \
                patch.object(M.os, 'getgid', return_value=1001, create=True), \
                patch.object(M.socket, 'SO_PEERCRED', 17, create=True), patch.object(M.socket, 'SO_PASSCRED', 16, create=True), \
                patch.object(M.time, 'monotonic', return_value=1), patch.object(M.K, 'HeldImage', return_value=Mock()):
            yield capture, channel, events

    def test_desktop_handler_is_explicit_and_only_accepts_the_expected_url(self):
        raw = M.portal_desktop('/owned/source/controller.py', 'a' * 64)
        self.assertIn(b'Exec=/usr/bin/python3 -I -S -B "/owned/source/controller.py" _portal_capture ', raw)
        self.assertIn(b'DBusActivatable=false\n', raw)
        self.assertIn(b'MimeType=x-scheme-handler/https;\n', raw)
        self.assertNotIn(b'BROWSER', raw)
        for source in ('relative.py', '/owned/%u.py', '/owned/line\nbreak.py'):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                M.portal_desktop(source, 'a' * 64)
        for args in (['_portal_capture', 'a' * 64, M.PORTAL_URL + '?extra'],
                     ['_portal_capture', 'a' * 64, 'https://other.invalid/'],
                     ['_portal_capture', 'short', M.PORTAL_URL],
                     ['_portal_capture', 'a' * 64, M.PORTAL_URL, 'extra']):
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                M.portal_worker_args(args)
        self.assertEqual(M.portal_worker_args(['_portal_capture', 'a' * 64, M.PORTAL_URL]), 'a' * 64)

    def test_portal_parent_is_exact_not_a_provider_name_or_uid_exemption(self):
        process = {'pid': 31, 'startTime': '300', 'parentPid': 20, 'uids': [1001] * 4,
                   'executable': '/usr/bin/python3.10', 'kernelImageSha256': 'a' * 64, 'image': {}}
        M.portal_worker_identity(process, (31, 1001, 1001), 20, '/usr/bin/python3.10', 'a' * 64, 1001, 1001)
        M.portal_worker_identity(process, (31, 1001, 2000), 20, '/usr/bin/python3.10', 'a' * 64, 1001, 2000)
        for key, changed in (('parentPid', 1), ('parentPid', 21), ('uids', [1002] * 4),
                             ('executable', '/usr/bin/xdg-dbus-proxy'), ('kernelImageSha256', 'b' * 64)):
            with self.subTest(key=key, changed=changed), self.assertRaises(RuntimeError):
                M.portal_worker_identity({**process, key: changed}, (31, 1001, 1001), 20, '/usr/bin/python3.10', 'a' * 64, 1001, 1001)
        for credentials in ((32, 1001, 1001), (31, 1002, 1001), (31, 1001, 1002)):
            with self.assertRaises(RuntimeError):
                M.portal_worker_identity(process, credentials, 20, '/usr/bin/python3.10', 'a' * 64, 1001, 1001)

    def test_worker_frames_are_finite_and_replay_is_not_completion(self):
        M.portal_frame({'kind': 'ready', 'nonce': 'a' * 64, 'url': M.PORTAL_URL}, 'ready', 'a' * 64)
        M.portal_frame({'kind': 'complete', 'nonce': 'a' * 64}, 'complete', 'a' * 64)
        for frame, kind in (({'kind': 'ready', 'nonce': 'a' * 64, 'url': M.PORTAL_URL}, 'complete'),
                            ({'kind': 'complete', 'nonce': 'b' * 64}, 'complete'),
                            ({'kind': 'complete', 'nonce': 'a' * 64, 'extra': True}, 'complete')):
            with self.assertRaises(RuntimeError):
                M.portal_frame(frame, kind, 'a' * 64)

    def test_real_worker_must_finish_bounded_handshake_before_any_success(self):
        with self.capture_fixture() as (capture, channel, events):
            capture.poll()
            self.assertEqual(capture.state, 'await-complete')
            self.assertEqual(capture.calls, [])
            self.assertFalse(capture.receipt['workerCompleted'])
            self.assertEqual(M.parse(channel.sendall.call_args.args[0])['kind'], 'ack')
            capture.poll()
            self.assertEqual(capture.state, 'complete')
            self.assertEqual([row for row in events if row[0] == 'send'], [('send', 'ack'), ('send', 'release')])
            for index, row in enumerate(events):
                if row[0] == 'send':
                    self.assertEqual(events[index - 1], ('guard', 'worker'))
            self.assertTrue(capture.receipt['workerCompleted'])
            self.assertTrue(capture.receipt['protectedStateVerified'])
            self.assertEqual(capture.receipt['portalParent'], {'pid': 20, 'startTime': '200'})
            self.assertEqual(capture.calls, [{'url': M.PORTAL_URL, 'browserOpened': False,
                                             'downloadAttempted': False, 'senderUid': 1001}])
            capture.complete()

    def test_launcher_exit_without_worker_or_ack_without_complete_is_not_success(self):
        for frames in ([None], [{'kind': 'ready', 'nonce': 'a' * 64, 'url': M.PORTAL_URL}, None]):
            with self.subTest(frames=frames), self.capture_fixture(frames) as (capture, channel, _):
                if len(frames) == 2:
                    capture.poll()
                with self.assertRaisesRegex(RuntimeError, 'exit alone'):
                    capture.complete()
                self.assertFalse(capture.receipt['workerCompleted']); self.assertEqual(capture.calls, [])
                self.assertNotIn('release', [M.parse(call.args[0])['kind'] for call in channel.sendall.call_args_list])

    def test_duplicate_or_unarmed_invocation_stops_without_a_second_ack(self):
        with self.capture_fixture() as (capture, channel, _):
            capture.poll(); capture.poll()
            other = Mock()
            capture.listener.accept.side_effect = None
            capture.listener.accept.return_value = (other, None)
            with self.assertRaisesRegex(RuntimeError, 'repeated'):
                capture.poll()
            other.close.assert_called_once(); other.sendall.assert_not_called()
            self.assertEqual(len(capture.calls), 1)
            self.assertEqual(channel.sendall.call_count, 2)
        with self.capture_fixture() as (capture, channel, _):
            capture.armed = False
            with self.assertRaises(RuntimeError):
                capture.poll()
            channel.close.assert_called_once(); channel.sendall.assert_not_called()

    def test_unknown_changed_identity_and_settings_stop_before_ack_or_release(self):
        for stage in ('ready', 'complete'):
            for failure in ('worker', 'provider'):
                with self.subTest(stage=stage, failure=failure), self.capture_fixture() as (capture, channel, _):
                    if stage == 'complete':
                        capture.poll()
                    guard = capture.worker_guard if failure == 'worker' else capture.guard
                    guard.side_effect = RuntimeError('bound evidence changed')
                    before = channel.sendall.call_count
                    with self.assertRaisesRegex(RuntimeError, 'bound evidence changed'):
                        capture.poll()
                    self.assertEqual(channel.sendall.call_count, before)
                    self.assertFalse(capture.receipt['workerCompleted']); self.assertEqual(capture.calls, [])
        with self.capture_fixture() as (capture, channel, _):
            capture.poll()
            capture.protected_state.side_effect = RuntimeError('settings changed')
            capture.worker_guard.side_effect = lambda: capture.protected_state()
            with self.assertRaisesRegex(RuntimeError, 'settings changed'):
                capture.complete()
            self.assertEqual(capture.calls, [])

    def test_foreign_peer_and_replayed_ready_never_complete(self):
        for credentials in ((32, 1002, 1001), (31, 1001, 2000)):
            with self.subTest(credentials=credentials), self.capture_fixture() as (capture, channel, _):
                channel.getsockopt.return_value = M.struct.pack('3i', *credentials)
                with self.assertRaises(RuntimeError):
                    capture.poll()
                channel.sendall.assert_not_called(); self.assertEqual(capture.calls, [])
        with self.capture_fixture([{'kind': 'ready', 'nonce': 'a' * 64, 'url': M.PORTAL_URL}] * 2) as (capture, channel, _):
            capture.poll()
            with self.assertRaises(RuntimeError):
                capture.poll()
            self.assertEqual(channel.sendall.call_count, 1); self.assertEqual(capture.calls, [])

    def test_unknown_or_oversized_peer_is_refused_before_executable_hashing(self):
        for changed in ({'parentPid': 1}, {'executable': '/foreign'}, {'uids': [2000] * 4},
                        {'image': {'st_size': str(M.K.MAX_IMAGE + 1)}}):
            with self.subTest(changed=changed), self.capture_fixture() as (capture, channel, _):
                native = capture.session.native.native_process
                calls = []
                def observe(pid, helper, full=True):
                    calls.append(full)
                    self.assertFalse(full, 'Unqualified worker was hashed')
                    return {**native(pid, helper, False), **changed}
                capture.session.native.native_process = observe
                with self.assertRaises(RuntimeError):
                    capture.poll()
                self.assertEqual(calls, [False]); channel.sendall.assert_not_called()

    def test_receive_requires_per_message_kernel_credentials_and_rejects_fds_or_truncation(self):
        capture = object.__new__(M.RealPortalCapture)
        capture.channel, capture.credentials = Mock(), (31, 1001, 1001)
        raw = M.json_bytes({'kind': 'complete', 'nonce': 'a' * 64})
        with patch.object(M.socket, 'SCM_CREDENTIALS', 2, create=True), \
                patch.object(M.socket, 'MSG_CMSG_CLOEXEC', 0x40000000, create=True), \
                patch.object(M.socket, 'CMSG_SPACE', return_value=32, create=True), \
                patch.object(M.socket, 'MSG_CTRUNC', 8, create=True), \
                patch.object(M.socket, 'SCM_RIGHTS', 1, create=True), patch.object(M.os, 'close') as close:
            valid = (M.socket.SOL_SOCKET, M.socket.SCM_CREDENTIALS, M.struct.pack('3i', *capture.credentials))
            capture.channel.recvmsg.return_value = (raw, [valid], 0, None)
            self.assertEqual(capture.receive(), M.parse(raw))
            cases = [(raw, [], 0, None), (b'', [], 0, None), (raw, [valid], M.socket.MSG_TRUNC, None),
                     (raw, [valid], M.socket.MSG_CTRUNC, None), (raw, [valid, valid], 0, None),
                     (raw, [(M.socket.SOL_SOCKET, 2, M.struct.pack('3i', 32, 1001, 1001))], 0, None),
                     (raw, [(M.socket.SOL_SOCKET, 1, M.struct.pack('i', 90))], 0, None)]
            for packet in cases:
                with self.subTest(packet=packet), self.assertRaises(RuntimeError):
                    capture.channel.recvmsg.return_value = packet
                    capture.receive()
            close.assert_called_once_with(90)
            capture.channel.recvmsg.side_effect = BlockingIOError()
            self.assertIsNone(capture.receive())

    def test_exact_worker_argv_and_source_are_rechecked_while_peer_is_held(self):
        worker = {'pid': 31, 'parentPid': 20, 'startTime': '300', 'uids': [1001] * 4,
                  'executable': '/usr/bin/python3.10', 'image': {}, 'kernelImageSha256': 'a' * 64}
        capture = object.__new__(M.RealPortalCapture)
        capture.guard, capture.protected_state = Mock(), Mock()
        capture.credentials, capture.worker = (31, 1001, 1001), copy.deepcopy(worker)
        capture.providers = {'portal': SimpleNamespace(child=SimpleNamespace(pid=20))}
        python = SimpleNamespace(path=worker['executable'], pin=({}, 'a' * 64), recheck=Mock())
        capture.images, capture.worker_image = {'python': python}, Mock(snapshot=lambda: python.pin)
        capture.source, capture.nonce = Path('/owned/controller.py'), 'b' * 64
        native = SimpleNamespace(native_process=Mock(return_value=copy.deepcopy(worker)))
        capture.session = SimpleNamespace(native=native, helper=None, stable=Mock())
        argv = ['/usr/bin/python3', '-I', '-S', '-B', str(capture.source), '_portal_capture', capture.nonce, M.PORTAL_URL]
        raw = b'\0'.join(os.fsencode(arg) for arg in argv) + b'\0'
        source = Mock(); source.__enter__ = Mock(return_value=source); source.__exit__ = Mock(return_value=False)
        with patch('builtins.open', return_value=source), patch.object(M.os, 'getuid', return_value=1001, create=True), \
                patch.object(M.os, 'getgid', return_value=1001, create=True):
            source.read.return_value = raw
            capture.worker_guard()
            capture.session.stable.assert_called_once_with(worker)
            for changed in (raw + b'extra\0', raw.replace(b'controller.py', b'other.py'), raw.replace(b'-B', b'-c')):
                source.read.return_value = changed
                with self.assertRaisesRegex(RuntimeError, 'source/argv'):
                    capture.worker_guard()
            source.read.return_value = raw
            for field, value in (('parentPid', 1), ('startTime', '301'), ('kernelImageSha256', 'c' * 64)):
                native.native_process.return_value = {**worker, field: value}
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    capture.worker_guard()

    def test_provider_owner_and_kernel_bytes_are_exact_owned_popen_not_name_only(self):
        provider = object.__new__(M.PortalProvider)
        process = {'pid': 20, 'parentPid': 10, 'startTime': '200', 'uids': [1001] * 4,
                   'image': {}, 'kernelImageSha256': 'a' * 64, 'executable': '/usr/libexec/xdg-desktop-portal'}
        stripped = {key: value for key, value in process.items() if key != 'kernelImageSha256'}
        provider.child, provider.start = SimpleNamespace(pid=20, poll=lambda: None), '200'
        provider.image = SimpleNamespace(path=process['executable'], pin=({}, 'a' * 64), recheck=Mock())
        provider.session = SimpleNamespace(helper=None, stable=Mock(), native=SimpleNamespace(
            native_process=lambda _pid, _helper, full=True: copy.deepcopy(process if full else stripped)))
        provider.bus_owner = Mock(return_value={'name': ':1.10', 'pid': 20, 'uid': 1001})
        with patch.object(M.os, 'getuid', return_value=1001, create=True), patch.object(M.os, 'getpid', return_value=10):
            self.assertTrue(provider.bind())
            for owner in ({'name': ':1.11', 'pid': 21, 'uid': 1001}, {'name': ':1.10', 'pid': 20, 'uid': 1002}):
                provider.bus_owner.return_value = owner
                with self.assertRaises(RuntimeError):
                    provider.bind()
            provider.bus_owner.return_value = provider.owner
            for field, value in (('startTime', '201'), ('kernelImageSha256', 'c' * 64), ('image', {'changed': True})):
                provider.session.native.native_process = lambda _pid, _helper, full=True: (
                    {**process, field: value} if full else copy.deepcopy(stripped))
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    provider.bind()

    def test_only_portal_has_source_bound_subreaper_and_no_worker_exec_or_network(self):
        calls, value = [], SimpleNamespace(value=0)
        def prctl(operation, *_):
            calls.append(operation)
            if operation == 37:
                value.value = 1
            return 0
        libc = SimpleNamespace(prctl=Mock(side_effect=prctl))
        with patch.object(M.ctypes, 'CDLL', return_value=libc), patch.object(M.ctypes, 'c_int', return_value=value), \
                patch.object(M.ctypes, 'addressof', return_value=1), patch.object(M.os, 'execve') as execute:
            M.portal_provider('portal')
            self.assertEqual(calls, [36, 37])
            execute.assert_called_once_with('/usr/libexec/xdg-desktop-portal', ['/usr/libexec/xdg-desktop-portal'], dict(os.environ))
            calls.clear(); execute.reset_mock()
            M.portal_provider('gtk')
            self.assertEqual(calls, [])
            with self.assertRaises(RuntimeError):
                M.portal_provider('/untrusted/provider')
        source = (HERE / 'native-linux-production-016-flatpak.py').read_text('utf8')
        tree = ast.parse(source)
        worker = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'portal_worker')
        worker_source = ast.get_source_segment(source, worker)
        self.assertIn('socket.AF_UNIX', worker_source)
        for forbidden in ('AF_INET', 'execve', 'subprocess', 'write(', 'command(', 'urllib', 'BROWSER'):
            self.assertNotIn(forbidden, worker_source)
        session = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'run_session')
        self.assertIn('RealPortalCapture(session)', ast.get_source_segment(source, session))
        self.assertNotIn('= portal_capture(session)', ast.get_source_segment(source, session))
        workflow = (HERE.parent / '.github/workflows/native-linux-production-016-flatpak.yml').read_text('utf8')
        self.assertIn('xdg-desktop-portal xdg-desktop-portal-gtk desktop-file-utils', workflow)

    def test_capture_worker_waits_for_both_acknowledgements_without_network_or_retry(self):
        for fault in (None, 'foreign-server', 'wrong-ack', 'wrong-release', 'timeout'):
            with self.subTest(fault=fault):
                channel = Mock()
                channel.__enter__ = Mock(return_value=channel); channel.__exit__ = Mock(return_value=False)
                credentials = (41, 2000 if fault == 'foreign-server' else 1001, 1001)
                channel.getsockopt.return_value = M.struct.pack('3i', *credentials)
                nonce = 'a' * 64
                channel.recv.side_effect = [M.json_bytes({'kind': 'wrong' if fault == 'wrong-ack' else 'ack', 'nonce': nonce}),
                                           M.json_bytes({'kind': 'wrong' if fault == 'wrong-release' else 'release', 'nonce': nonce})]
                if fault == 'timeout':
                    channel.recv.side_effect = TimeoutError('bounded ACK deadline')
                with patch.object(M.socket, 'socket', return_value=channel) as factory, \
                        patch.object(M.socket, 'AF_UNIX', 1, create=True), \
                        patch.object(M.socket, 'SO_PEERCRED', 17, create=True), \
                        patch.object(M.socket, 'SOCK_SEQPACKET', 5, create=True), \
                        patch.object(M.os, 'getuid', return_value=1001, create=True), \
                        patch.object(M.os, 'getgid', return_value=1001, create=True):
                    if fault:
                        with self.assertRaises((RuntimeError, TimeoutError)):
                            M.portal_worker(Path('/private'), ['_portal_capture', nonce, M.PORTAL_URL])
                    else:
                        M.portal_worker(Path('/private'), ['_portal_capture', nonce, M.PORTAL_URL])
                    factory.assert_called_once_with(M.socket.AF_UNIX, M.socket.SOCK_SEQPACKET)
                channel.connect.assert_called_once_with(M.portal_socket_path(Path('/private')))
                sent = [M.parse(call.args[0])['kind'] for call in channel.sendall.call_args_list]
                self.assertEqual(sent, [] if fault == 'foreign-server' else ['ready'] if fault in ('wrong-ack', 'timeout')
                                 else ['ready', 'complete'])

    def test_portal_image_recheck_refuses_writable_substitution_or_redirected_ancestry(self):
        image = object.__new__(M.PortalImage)
        directory = SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)
        content = SimpleNamespace(st_dev=1, st_ino=3, st_size=64, st_mode=stat.S_IFREG | 0o755, st_uid=0, st_gid=0,
                                  st_mtime_ns=1, st_ctime_ns=2, st_nlink=1)
        image.fd, image.name, image.alias = 11, 'xdg-desktop-portal', None
        image.parents = [(None, '/', 10, M.K.ProtectedBwrap.directory_stamp(directory))]
        image.identity = M.K.image_stamp(content)
        with patch.object(M.os, 'fstat', side_effect=lambda fd: directory if fd == 10 else content), \
                patch.object(M.os, 'stat', side_effect=lambda name, **_: directory if name == '/' else content):
            image.recheck()
            for field, changed in (('st_mode', stat.S_IFREG | 0o777), ('st_uid', 1001), ('st_ino', 4), ('st_nlink', 0)):
                value = SimpleNamespace(**{**vars(content), field: changed})
                with self.subTest(field=field), patch.object(M.os, 'fstat', side_effect=lambda fd: directory if fd == 10 else value), \
                        self.assertRaises(RuntimeError):
                    image.recheck()
            for field, changed in (('st_mode', stat.S_IFDIR | 0o777), ('st_ino', 99), ('st_uid', 1001)):
                value = SimpleNamespace(**{**vars(directory), field: changed})
                with self.subTest(field=field), patch.object(M.os, 'stat', return_value=value), self.assertRaises(RuntimeError):
                    image.recheck()


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
