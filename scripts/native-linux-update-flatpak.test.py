"""Offline composition tests. Mocked OS/provenance boundaries are not native acceptance."""
import ast
from contextlib import ExitStack
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('update_flatpak_test_module', HERE / 'native-linux-update-flatpak.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def pin(raw):
    return dict(size=len(raw), sha256=hashlib.sha256(raw).hexdigest())


def environment():
    return dict(UPDATE_SCENARIO=M.SCENARIO, UPDATE_EXECUTE='true', UPDATE_PROFILE_SHA256='b' * 64,
        GITHUB_ACTIONS='true', GITHUB_REPOSITORY='BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID='1364807512',
        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF='refs/heads/validation/native-linux-production-016-update',
        GITHUB_WORKFLOW_REF='BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-update.yml@refs/heads/validation/native-linux-production-016-update',
        GITHUB_SHA='a' * 40, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', RUNNER_ENVIRONMENT='github-hosted',
        RUNNER_OS='Linux', RUNNER_ARCH='X64', HOME=str(M.HOME), XDG_CONFIG_HOME=str(M.HOME / 'config'),
        XDG_DATA_HOME=str(M.HOME / 'data'), XDG_CACHE_HOME=str(M.HOME / 'cache'), XDG_RUNTIME_DIR=str(M.ROOT / 'runtime'),
        TMPDIR=str(M.ROOT / 'tmp'), DISPLAY=':91', DBUS_SESSION_BUS_ADDRESS='unix:path=/fixture-bus', XAUTHORITY='/fixture-xauth')


def installed():
    return dict(ref=M.REF, commit=M.COMMIT, runtime=M.RUNTIME, runtimeCommit='d' * 64, manualBundle=True, releaseReady=False)


def reviewed():
    return dict(signaturesVerified=True, flatpakLauncher=M.launcher_contract(), baseline={}, portable={
        v: dict(generation=char * 64, signature=pin(b'sig'), manifest=dict(version='0.1.' + v,
            sourceCommit=M.TARGET_SOURCE if v == '17' else 'c' * 40, sourceTree=M.TARGET_TREE,
            entries={'usr/bin/creator-hub': pin(b'host' + v.encode())})) for v, char in (('16', 'e'), ('17', 'f'))})


def fixture():
    # This fake module deliberately isolates provenance/OS operations. Tests below
    # assert their exact calls, not a real signed installation or authorization.
    u = ModuleType('outer_update_fixture')
    u.__file__, u.BASE, u.UID = str(M.BASE / 'scripts/native-linux-production-016-update.py'), M.BASE, M.UID
    u.STORE, u.HOST_SERVICE = 'data/creator-hub-portable', 'data/dbus-1/services/com.creatorworks.hub.Host.service'
    u.parse, u.pin = json.loads, pin
    u.admission = Mock(return_value=M.SCENARIO)
    u.portable_manifest, u.validate_pin, u.safe_name = Mock(), Mock(), Mock()
    profile = dict(artifacts={'flatpak16': M.launcher_contract()['producer']})
    profile_raw, api_raw = M.encoded(profile), M.encoded({'original': True})
    request = dict(context=environment(), scenario=M.SCENARIO, profile=pin(profile_raw), api=pin(api_raw),
        sources={name: pin(b'source') for name in (*M.EXTRA_SOURCES, 'native-linux-production-016-update.py')})
    u.source_names = Mock(return_value=tuple(request['sources']))
    before = {name: {**pin(b'keep'), 'dev': 1, 'ino': index, 'uid': M.UID, 'gid': M.UID, 'mode': 0o600}
              for index, name in enumerate(M.PROTECTED, 1)}
    before[M.RETENTION].update(pin(M.RETENTION_BYTES))
    completed = dict(scenario=M.SCENARIO, harnessSource='a' * 40,
        **dict.fromkeys(('initial16Verified', 'nativeConfirmationObserved', 'oldNormalExit', 'automaticRestartObserved',
           'installed17Verified', 'fresh17UiVersion', 'directPagesObserved', 'normalFinalClose'), True))
    request_raw, review_raw = M.encoded(request), M.encoded(reviewed())
    files = {M.BASE / 'request.json': request_raw, M.BASE / 'review.json': review_raw,
             M.BASE / 'inputs/profile.json': profile_raw, M.BASE / 'inputs/api.json': api_raw}
    u.read = Mock(side_effect=lambda path, *a, **k: files[path])
    u.bound = Mock(return_value=b'source')
    u.validate_profile = Mock(side_effect=lambda value, scenario: value)
    u.validate_all_api, u.verify_generation = Mock(), Mock()
    u.preserved = Mock(side_effect=lambda home, original: copy.deepcopy(original))
    u.portable_state = Mock(return_value=M.HOME / u.STORE / 'generations' / ('f' * 64) / 'AppDir')
    u.fingerprint = Mock(side_effect=lambda path: {'path': str(path), **pin(b'stable')})
    h = M._Handoff(M._SEAL, u, environment(), request_raw, review_raw, before, completed)
    return SimpleNamespace(u=u, h=h, env=environment(), request=request, before=before, completed=completed, files=files)


def mocked_context(env):
    stack = ExitStack()
    stack.enter_context(patch.object(M.sys, 'platform', 'linux'))
    stack.enter_context(patch.object(M.os, 'getuid', return_value=M.UID, create=True))
    stack.enter_context(patch.object(M.os, 'geteuid', return_value=M.UID, create=True))
    stack.enter_context(patch.object(M, 'HERE', M.BASE / 'scripts'))
    stack.enter_context(patch.dict(os.environ, env, clear=True))
    return stack


def session(f=None):
    f = f or fixture()
    result = object.__new__(M.UpdateSession)
    result.handoff, result.root, result.host_before = f.h, M.ROOT, None
    result.report = dict(scope=M.SCOPE, phase='starting', combinedAccepted=False, releaseReady=False)
    result.app_env = M.F.clean_environment(M.ROOT)
    result.captures, result.fds, result.children = [], [], []
    return result


class ContractTests(unittest.TestCase):
    def test_frozen_launcher_is_not_relabelled_and_contract_is_defensively_copied(self):
        value = M.launcher_contract()
        self.assertEqual((value['version'], value['source']['sourceCommit']), ('0.1.16', M.SOURCE_COMMIT))
        self.assertEqual(value['producer']['run'], 39348943839)
        self.assertEqual(value['producer']['artifact'], 12231574692)
        self.assertEqual(value['producer']['files'][M.BUNDLE], dict(size=199408,
            sha256='30904def15d0e3d5333af2d1bb2af9e6fcab8569578a4f6cc9595de08a34bf24'))
        self.assertEqual(len(value['source']['files']), 12)
        self.assertEqual(len(value['producer']['files']), 3)
        value['source']['files'].clear()
        self.assertEqual(len(M.launcher_contract()['source']['files']), 12)

    def test_helper_policy_is_two_fixed_readonly_operations_not_installation(self):
        commands = M.helper_commands()
        self.assertEqual(len(commands), 2)
        self.assertEqual([c[-1] for c in commands], ['root-inventory-probe-update016', 'root-proxy-snapshot-update016'])
        for command in commands:
            self.assertEqual(command[:-1], ('/usr/bin/python3', '-I', '-S', '-B',
                '/var/lib/creator-hub-flatpak-proxy-observer/observer.py'))
        tree = ast.parse(Path(M.__file__).read_text())
        self.assertFalse(any(isinstance(n, ast.Call) and ast.unparse(n.func) in (
            'F.run_session', 'F.prepare', 'F.root_inventory_preflight', 'os.chmod', 'os.chown', 'subprocess.run') for n in ast.walk(tree)))

    def test_initial_retention_seed_is_data_only_and_all_foreign_settings_remain_required(self):
        self.assertEqual(M.retention_fixture(), {M.RETENTION: M.RETENTION_BYTES})
        self.assertIn('config/Claude/claude_desktop_config.json', M.PROTECTED)
        self.assertIn('.codex/config.toml', M.PROTECTED)
        self.assertIn('other-project/Assets/keep.txt', M.PROTECTED)
        self.assertIn('data/CreatorHub/consent/hub-usage-terms.json', M.PROTECTED)

    def test_closed_context_rejects_other_scenario_workflow_paths_or_flatpak_authority(self):
        M.validate_environment(environment())
        bad = dict(UPDATE_SCENARIO='portable-approve', UPDATE_EXECUTE='false', GITHUB_REPOSITORY_ID='1',
            GITHUB_REF='refs/heads/main', GITHUB_WORKFLOW_REF='flatpak-workflow', RUNNER_ARCH='ARM64',
            HOME='/home/runner', XDG_RUNTIME_DIR='/tmp/runtime', XDG_DATA_HOME='/foreign', TMPDIR='/tmp',
            GITHUB_SHA='bad', DISPLAY='remote:1', DBUS_SESSION_BUS_ADDRESS='', EXECUTION_REQUEST='true',
            FLATPAK_ID='com.creatorworks.hub', FLATPAK_USER_DIR='/foreign')
        for key, value in bad.items():
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.validate_environment({**environment(), key: value})

    def test_pair_requires_signed_distinct_original16_and_exact17(self):
        f = fixture()
        M.validate_host_pair(f.u, reviewed())
        for mutation in ('signature', 'launcher', 'source', 'version', 'alias', 'extra', 'signature-shape'):
            value = reviewed()
            if mutation == 'signature': value['signaturesVerified'] = False
            if mutation == 'launcher': value['flatpakLauncher']['version'] = '0.1.17'
            if mutation == 'source': value['portable']['17']['manifest']['sourceCommit'] = M.SOURCE_COMMIT
            if mutation == 'version': value['portable']['17']['manifest']['version'] = '0.1.16'
            if mutation == 'alias': value['portable']['17']['generation'] = value['portable']['16']['generation']
            if mutation == 'extra': value['portable']['18'] = value['portable']['17']
            if mutation == 'signature-shape': value['portable']['17']['extra'] = True
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): M.validate_host_pair(f.u, value)

    def test_installed_receipt_and_page_proof_refuse_partial_foreign_or_fabricated_version(self):
        M.validate_installed(installed())
        for key, value in dict(ref='foreign', commit='0' * 64, runtimeCommit='bad', releaseReady=True, manualBundle=False).items():
            with self.subTest(key=key), self.assertRaises(RuntimeError): M.validate_installed({**installed(), key: value})
        proof = dict(version='0.1.17', root={'pid': 2}, directPagesObserved=True, bitmap={'nonblank': True}, ownedAxConnectionClosed=True)
        M.page_proof(proof, {'pid': 2})
        for key in proof:
            with self.subTest(key=key), self.assertRaises(RuntimeError): M.page_proof({**proof, key: None}, {'pid': 2})


class HandoffTests(unittest.TestCase):
    def test_readonly_recheck_binds_original_inputs_sources_and_preservation_without_flatpak_intent(self):
        f = fixture()
        with mocked_context(f.env): self.assertEqual(f.h.recheck(), f.before)
        self.assertEqual(f.u.bound.call_count, len(M.EXTRA_SOURCES) + 1 + 3 + 12)
        for call in f.u.bound.call_args_list[:len(M.EXTRA_SOURCES) + 1]:
            self.assertEqual(call.kwargs, dict(uid=0, mode=0o444))
        f.u.preserved.assert_called_once_with(M.HOME, f.before)
        self.assertNotIn('EXECUTION_REQUEST', json.loads(f.h._env))

    def test_handoff_is_immutable_sealed_defensive_and_not_an_environment_dump(self):
        f = fixture()
        env = {**f.env, 'UNRELATED_PRIVATE_VALUE': 'not-retained'}
        h = M._Handoff(M._SEAL, f.u, env, f.h._request, f.h._review, f.before, f.completed)
        self.assertNotIn(b'not-retained', h._env)
        f.before.clear(); f.completed.clear()
        self.assertTrue(json.loads(h._before)); self.assertTrue(json.loads(h._update))
        h.data()['portable'].clear(); self.assertTrue(h.data()['portable'])
        with self.assertRaises(AttributeError): h._claimed = True
        with self.assertRaises(RuntimeError): M._Handoff(object(), f.u, env, b'{}', b'{}', {}, {})
        with self.assertRaises(RuntimeError): M.after_update({'accepted': True}, lambda *a: {})

    def test_failed_claim_is_consumed_and_cannot_be_revived(self):
        f = fixture()
        with patch.object(M._Handoff, 'recheck', side_effect=RuntimeError('original')) as recheck:
            with self.assertRaisesRegex(RuntimeError, 'original'): f.h.claim()
            with self.assertRaisesRegex(RuntimeError, 'one-shot'): f.h.claim()
            recheck.assert_called_once()

    def test_wrong_uid_runtime_held_context_and_source_fail_before_any_input(self):
        for mutation in ('uid', 'effective-uid', 'runtime', 'display', 'bus', 'source', 'xauth', 'request', 'review', 'profile', 'source-read'):
            f = fixture()
            with self.subTest(mutation=mutation), mocked_context(f.env), ExitStack() as stack:
                if mutation in ('uid', 'effective-uid'):
                    stack.enter_context(patch.object(M.os, 'getuid' if mutation == 'uid' else 'geteuid', return_value=1001))
                if mutation in ('runtime', 'display', 'bus', 'source', 'xauth'):
                    key = {'runtime': 'XDG_RUNTIME_DIR', 'display': 'DISPLAY', 'bus': 'DBUS_SESSION_BUS_ADDRESS',
                           'source': 'GITHUB_SHA', 'xauth': 'XAUTHORITY'}[mutation]
                    os.environ[key] = {'display': ':92', 'source': 'c' * 40}.get(mutation, 'foreign')
                if mutation in ('request', 'review'): f.files[M.BASE / (mutation + '.json')] = b'{}'
                if mutation == 'profile': f.files[M.BASE / 'inputs/profile.json'] += b' '
                if mutation == 'source-read': f.u.bound.side_effect = RuntimeError('source-drift')
                with self.assertRaises(RuntimeError): f.h.recheck()
                f.u.preserved.assert_not_called()

    def test_narrowed_or_later_retention_baseline_and_preservation_drift_refuse(self):
        for mutation in ('omit-client', 'omit-sentinel', 'sentinel-bytes', 'preservation'):
            f = fixture(); before = copy.deepcopy(f.before)
            if mutation == 'omit-client': del before['.claude.json']
            if mutation == 'omit-sentinel': del before[M.RETENTION]
            if mutation == 'sentinel-bytes': before[M.RETENTION]['sha256'] = '0' * 64
            if mutation == 'preservation': f.u.preserved.side_effect = RuntimeError('original-data-drift')
            h = M._Handoff(M._SEAL, f.u, f.env, f.h._request, f.h._review, before, f.completed)
            with self.subTest(mutation=mutation), mocked_context(f.env), self.assertRaises(RuntimeError): h.recheck()

    def test_admit_requires_real_outer_admission_and_all_preceding_update_gates(self):
        f = fixture()
        with mocked_context(f.env), patch.object(M._Handoff, 'recheck'):
            self.assertIsInstance(M.admit(f.u, f.env, f.before, f.completed), M._Handoff)
            for key, value in f.completed.items():
                if value is True:
                    with self.subTest(key=key), self.assertRaises(RuntimeError):
                        M.admit(f.u, f.env, f.before, {**f.completed, key: False})
            f.u.admission.side_effect = RuntimeError('outer-still-closed')
            with self.assertRaisesRegex(RuntimeError, 'outer-still-closed'): M.admit(f.u, f.env, f.before, f.completed)

    def test_host_state_checks_both_generations_registration_selector_and_no_extra_generation(self):
        f = fixture()
        with patch.object(M._Handoff, 'recheck'), patch.object(Path, 'iterdir', return_value=iter([Path('e' * 64), Path('f' * 64)])):
            directory, state = f.h.host_state()
        self.assertEqual(directory, f.u.portable_state.return_value)
        f.u.portable_state.assert_called_once_with(M.HOME, reviewed(), '17', previous='e' * 64)
        self.assertEqual(f.u.verify_generation.call_count, 2)
        self.assertEqual(set(state), {f.u.STORE + '/current.json', f.u.HOST_SERVICE,
                                   f.u.STORE + '/activation-v1/creator-hub-portable-selector'})
        with patch.object(M._Handoff, 'recheck'), patch.object(Path, 'iterdir', return_value=iter([Path('f' * 64)])), self.assertRaises(RuntimeError):
            f.h.host_state()

    def test_observer_sources_are_exact_rootowned_updater_sources_and_not_a_forged_api_binding(self):
        f = fixture(); s = session(f)
        names = tuple('scripts/' + name for name in M.HARNESS)
        with patch.object(M._Handoff, 'recheck'):
            binding, sources = s.harness_sources(names)
            with self.assertRaises(RuntimeError): s.harness_sources(names[:-1])
            with self.assertRaises(RuntimeError): s.launcher_source('../foreign.rs')
        self.assertEqual(binding['profile'], M.PROFILE)
        self.assertEqual(binding['scenario'], M.SCENARIO)
        self.assertEqual(set(sources), set(names))
        self.assertEqual(f.u.bound.call_count, 8)
        self.assertEqual(s.evidence_root, M.EVIDENCE)
        self.assertNotEqual(s.evidence_root, s.root)

    def test_host_identity_is17_and_registration_drift_refuses(self):
        s = session(); directory = M.HOME / 'verified17/AppDir'
        with patch.object(M._Handoff, 'host_state', return_value=(directory, {'registered': 'original'})):
            digest, path = s.host_identity()
            self.assertEqual(digest, pin(b'host17')['sha256']); self.assertEqual(path, directory / 'usr/bin/creator-hub')
            s.host_before = {'registered': 'different'}
            with self.assertRaises(RuntimeError): s.host_identity()

    def test_adapter_disclosure_uses_original_frozen_source_without_weakening_baseline(self):
        f = fixture(); s = session(f)
        name = 'native/flatpak-native-activation/src/lib.rs'
        with patch.object(M._Handoff, 'recheck'):
            self.assertEqual(s.disclosure_source(), b'source')
        f.u.bound.assert_called_once_with(M.LAUNCHER_SOURCE / name, M.pins(M.SOURCE_ROWS)[name], 262144, uid=0, mode=0o644)


class RemovalTests(unittest.TestCase):
    def test_ref_inventory_is_bounded_exact_and_keeps_runtime_extensions(self):
        refs = {M.REF: M.COMMIT, M.RUNTIME: 'd' * 64, 'runtime/org.freedesktop.Platform.GL.default/x86_64/25.08': 'b' * 64}
        run = Mock(side_effect=lambda args: ('\n'.join(refs) + '\n').encode() if args[-1] == '--columns=ref' else refs[args[-1]].encode())
        self.assertEqual(M.ref_inventory(run), refs)
        self.assertEqual(run.call_count, 4)
        for raw in (b'', b'x' * 16385, (M.REF + '\n') .encode() * 33, b'app/foreign/x86_64/stable\n',
                    b'runtime/../../host/x86_64/stable\n', b'runtime/x/arm64/stable\n', b'\xff'):
            with self.subTest(raw=raw[:40]), self.assertRaises((RuntimeError, UnicodeError)): M.ref_inventory(lambda args: raw)

    def test_info_failure_is_not_treated_as_uninstalled(self):
        for bad in (b'bad', b'd' * 64 + b' extra', RuntimeError('command-failed')):
            def run(args):
                if args[-1] == '--columns=ref': return (M.RUNTIME + '\n').encode()
                if isinstance(bad, Exception): raise bad
                return bad
            with self.subTest(bad=type(bad).__name__), self.assertRaises(RuntimeError): M.ref_inventory(run)

    def test_command_gate_never_uses_default_home_or_unrestricted_flatpak(self):
        s = session()
        with patch.object(M._Handoff, 'recheck'), patch.object(M.F, 'command', return_value=b'ok') as command:
            s.flatpak_command(M.removal_command())
            self.assertEqual(command.call_args.kwargs['env']['FLATPAK_USER_DIR'], str(M.ROOT / 'installation'))
            for args in (['flatpak', 'uninstall', M.REF], [*M.removal_command(), '--delete-data'],
                         ['/usr/bin/flatpak', '--user', 'uninstall', '--all'],
                         ['/usr/bin/flatpak', '--user', 'info', '--show-commit', 'app/foreign/x86_64/stable']):
                with self.subTest(args=args), self.assertRaises(RuntimeError): s.flatpak_command(args)
            s.app_env['HOME'] = '/foreign'
            with self.assertRaises(RuntimeError): s.flatpak_command(M.removal_command())
            self.assertEqual(command.call_count, 1)

    def test_launcher_only_removal_retains_host_settings_and_all_runtime_commits(self):
        s = session(); s.report['normalCloseObserved'] = True
        s.windows, s.host_owner = lambda: [], lambda: None
        s.snapshot_preserved, s.flatpak_command = Mock(), Mock()
        s.installed_flatpak = installed
        before = {M.REF: M.COMMIT, M.RUNTIME: 'd' * 64}
        with patch.object(M, 'ref_inventory', side_effect=[before, {M.RUNTIME: 'd' * 64}]): s.remove_launcher(before)
        s.flatpak_command.assert_called_once_with(M.removal_command())
        self.assertNotIn('--delete-data', M.removal_command())
        self.assertEqual(s.snapshot_preserved.call_count, 2)
        self.assertTrue(s.report['nativeHostRetained']); self.assertTrue(s.report['settingsRetained'])
        self.assertFalse(s.report['nativeHelperRemovalAccepted']); self.assertFalse(s.report['combinedAccepted'])

    def test_live_host_missing_ref_runtime_drift_and_settings_change_block_removal_or_acceptance(self):
        for mutation in ('live', 'not-closed', 'missing', 'before-drift', 'runtime-changed', 'app-remains', 'settings'):
            s = session(); s.report['normalCloseObserved'] = mutation != 'not-closed'
            s.windows, s.host_owner = lambda: [], lambda: ({'pid': 1} if mutation == 'live' else None)
            s.snapshot_preserved, s.flatpak_command, s.installed_flatpak = Mock(), Mock(), installed
            before = {M.REF: M.COMMIT, M.RUNTIME: 'd' * 64}
            if mutation == 'missing': del before[M.REF]
            actual = {**before, 'extra': 'a'} if mutation == 'before-drift' else before
            after = before if mutation == 'app-remains' else {M.RUNTIME: 'e' * 64 if mutation == 'runtime-changed' else 'd' * 64}
            if mutation == 'settings': s.snapshot_preserved.side_effect = [None, RuntimeError('settings-changed')]
            with self.subTest(mutation=mutation), patch.object(M, 'ref_inventory', side_effect=[actual, after]), self.assertRaises(RuntimeError):
                s.remove_launcher(before)
            self.assertNotIn('launcherRemoved', s.report)
            self.assertLessEqual(s.flatpak_command.call_count, 1)
            if mutation in ('live', 'not-closed', 'missing', 'before-drift'): s.flatpak_command.assert_not_called()


class LifecycleTests(unittest.TestCase):
    def test_callback_requires_bound_outer_source_and_arbitrary_dto_never_authorizes(self):
        f = fixture()
        with self.assertRaises(RuntimeError): M.after_update(f.h, lambda *args: {})
        self.assertFalse(f.h._claimed)

    def run_flow(self, fail=None, cleanup=False, live=False):
        f = fixture(); events = []; s = session(f)
        s.report.update(launcherVersion='0.1.16', hostVersion='0.1.17', nativeHelperRemovalAccepted=False)
        s.host_before, s.installed_flatpak = None, installed
        s.flatpak_command = Mock()
        s.snapshot_preserved = lambda: events.append('preserve')
        s.dispose = Mock(side_effect=RuntimeError('cleanup') if cleanup else lambda: events.append('dispose'))
        if live: s.children = [SimpleNamespace(poll=lambda: None)]
        def step(name):
            def action(*args):
                events.append(name)
                if fail == name: raise RuntimeError('first-' + name)
                s.report[{'cold': 'coldActivationAccepted', 'warm': 'warmActivationAccepted',
                          'normal-close': 'normalCloseObserved', 'launcher-removal': 'launcherRemoved'}[name]] = True
                if name == 'launcher-removal': s.report.update(nativeHostRetained=True, settingsRetained=True)
            return action
        s.activate_cold, s.activate_warm = step('cold'), step('warm')
        s.normal_close, s.remove_launcher = step('normal-close'), step('launcher-removal')
        namespace = {'__name__': f.u.__name__}
        exec(compile('def inspect_pages(record, x11, evidence): return None', f.u.__file__, 'exec'), namespace)
        error, report = None, None
        with patch.object(M._Handoff, 'recheck'), patch.object(M._Handoff, 'host_state', return_value=(Path('/verified17'), {'stable': True})), \
                patch.object(M, 'UpdateSession', side_effect=RuntimeError('first-constructor') if fail == 'constructor' else lambda h: s), \
                patch.object(M, 'ref_inventory', return_value={M.REF: M.COMMIT, M.RUNTIME: 'd' * 64}), patch.object(M.F, 'save') as save:
            try: report = M.after_update(f.h, namespace['inspect_pages'])
            except RuntimeError as caught: error = caught
            with self.assertRaises(RuntimeError): M.after_update(f.h, namespace['inspect_pages'])
        return SimpleNamespace(events=events, error=error, report=report, save=save, session=s)

    def test_same_session_order_does_not_call_reseed_or_outer_mcp_protocol(self):
        result = self.run_flow()
        self.assertIsNone(result.error)
        self.assertEqual([e for e in result.events if e != 'preserve'], ['cold', 'warm', 'normal-close', 'launcher-removal', 'dispose'])
        self.assertEqual(result.events.count('preserve'), 8)
        self.assertEqual(result.report['phase'], 'complete')
        self.assertFalse(result.report['combinedAccepted']); self.assertFalse(result.report['releaseReady'])
        result.save.assert_called_once_with(M.EVIDENCE / 'report.json', result.session.report)

    def test_first_failure_stops_later_phases_never_retries_and_cleanup_cannot_mask_it(self):
        phases = ['constructor', 'cold', 'warm', 'normal-close', 'launcher-removal']
        for phase in phases:
            with self.subTest(phase=phase):
                result = self.run_flow(fail=phase, cleanup=True)
                self.assertEqual(str(result.error), 'first-' + phase)
                self.assertEqual([e for e in result.events if e != 'preserve'], phases[1:phases.index(phase) + 1])
                if phase != 'constructor':
                    self.assertEqual(result.session.report['phase'], 'failed')
                    result.session.dispose.assert_called_once()

    def test_live_launcher_or_cleanup_failure_never_completes(self):
        for kwargs in ({'live': True}, {'cleanup': True}):
            with self.subTest(kwargs=kwargs):
                result = self.run_flow(**kwargs)
                self.assertIsNotNone(result.error)
                self.assertEqual(result.session.report['phase'], 'failed')

    def test_cleanup_owns_only_its_capture_fds_and_newer_x11_connection(self):
        s = session(); events = []
        s.captures = [SimpleNamespace(close=lambda: events.append('capture'))]
        s.fds = [123]
        s.x11 = SimpleNamespace(dispose=lambda: events.append('inner-x11'))
        with patch.object(M.os, 'close', side_effect=lambda fd: events.append(('fd', fd))): s.dispose()
        self.assertEqual(events, ['capture', ('fd', 123), 'inner-x11']); self.assertEqual(s.fds, [])
        s.captures = [SimpleNamespace(close=Mock(side_effect=OSError('capture')))]
        s.x11.dispose = Mock()
        with self.assertRaises(RuntimeError): s.dispose()
        s.x11.dispose.assert_called_once()


class ActivationPrimitiveTests(unittest.TestCase):
    def cold(self, mutation=None):
        s = session(); root = dict(pid=224, startTime='1234', executable=str(M.HOME / 'host17'),
                                  kernelImageSha256='a' * 64, uids=[M.UID] * 4)
        owner, xres = dict(pid=224, uid=M.UID, owner=':1.42'), dict(pid=224, mapped=True, client=7)
        s.host_owner = Mock(side_effect=[None, owner, owner, owner, owner, owner])
        s.windows, s.flatpak = Mock(return_value=[]), Mock()
        s.wait = lambda condition: M.require(condition(), 'mock wait refused')
        s.host_identity = lambda: ('a' * 64, M.HOME / 'host17')
        s.process = Mock(return_value=root); s.stable = Mock(); s.owned_window = Mock(return_value=88)
        s.x11 = SimpleNamespace(inspect=Mock(return_value=xres))
        env = b'\0'.join(name.encode() + b'=' + str(path).encode() for name, path in (
            ('HOME', M.HOME), ('XDG_CONFIG_HOME', M.HOME / 'config'), ('XDG_DATA_HOME', M.HOME / 'data')))
        if mutation == 'wrong-home': env = b'HOME=/foreign'
        if mutation == 'env-large': env = b'x' * 32769
        if mutation == 'uid': root['uids'] = [1001] * 4
        if mutation == 'image': root['executable'] = '/host16'
        if mutation == 'xres': xres['pid'] = 999
        if mutation == 'before-image-drift': s.stable.side_effect = RuntimeError('identity-drift')
        def pages(record, x11, evidence):
            self.assertEqual(record, root); self.assertIs(x11, s.x11)
            self.assertEqual(evidence, M.EVIDENCE / 'cold-pages')
            if mutation == 'after-image-drift': s.stable.side_effect = RuntimeError('identity-drift')
            return dict(version='0.1.16' if mutation == 'page-version' else '0.1.17', root=record,
                directPagesObserved=mutation != 'missing-pages', bitmap={'nonblank': mutation != 'blank'},
                ownedAxConnectionClosed=mutation != 'open-ax')
        # windows is empty before activation, exactly one afterwards.
        s.windows.side_effect = [[], [88]]
        failure = None
        with patch.object(M.os, 'readlink', side_effect=['mnt:[1]', 'mnt:[2]' if mutation == 'namespace' else 'mnt:[1]']), \
                patch('builtins.open', return_value=io.BytesIO(env)), patch.object(Path, 'mkdir'):
            try: s.activate_cold(pages)
            except RuntimeError as error: failure = error
        return s, failure

    def test_cold_checks_real_host17_identity_home_window_and_page_callback_without_reseeding(self):
        s, error = self.cold()
        self.assertIsNone(error)
        s.flatpak.assert_called_once_with('Open Creator Hub', 'cold')
        self.assertTrue(s.report['coldActivationAccepted'])
        self.assertEqual(s.report['coldPages']['version'], '0.1.17')

    def test_cold_refuses_foreign_settings_or_changed_owned_image_namespace_pages_and_ax(self):
        for mutation in ('wrong-home', 'env-large', 'uid', 'image', 'namespace', 'xres', 'before-image-drift',
                         'after-image-drift', 'page-version', 'missing-pages', 'blank', 'open-ax'):
            with self.subTest(mutation=mutation):
                s, error = self.cold(mutation)
                self.assertIsNotNone(error)
                self.assertNotIn('coldActivationAccepted', s.report)

    def test_warm_reuses_original_host_window_and_frame_and_keeps_existing_attribution_method(self):
        s = session(); root, owner, xres = {'pid': 224, 'startTime': '1', 'executable': '/host17', 'kernelImageSha256': 'a' * 64}, {'pid': 224}, {'pid': 224}
        s.report.update(coldRoot=root, coldHost1Owner=owner, coldRootWindow=88, coldRootXres=xres)
        s.flatpak, s.stable = Mock(), Mock()
        s.host_owner, s.windows = lambda: owner, lambda: [88]
        s.x11 = SimpleNamespace(inspect=Mock(return_value=xres), display=1,
            x=SimpleNamespace(XDefaultRootWindow=lambda display: 1), property=Mock(return_value=(33, 32, [88])))
        s.helper = SimpleNamespace(Request=lambda *args: args)
        s.native = SimpleNamespace(bitmap=Mock(return_value={'nonblank': True}))
        s.wait = lambda check: M.require(check(), 'mock wait')
        with patch.object(Path, 'mkdir'): s.activate_warm()
        s.flatpak.assert_called_once_with('Open Creator Hub', 'warm')
        self.assertIs(M.UpdateSession.flatpak, M.F.Session.flatpak)
        self.assertIs(M.UpdateSession.consumed_warm_outcome, M.F.Session.consumed_warm_outcome)
        s.host_owner = lambda: {'pid': 999}
        with self.assertRaises(RuntimeError): s.activate_warm()

    def test_close_requires_all_owned_launcher_exits_and_no_remaining_window(self):
        for code in (0, 1, None):
            s = session(); s.report.update(coldRoot={'pid': 224}, coldRootWindow=88)
            s.close, s.wait = Mock(), lambda test: M.require(test(), 'mock wait')
            s.host_owner, s.windows = lambda: None, lambda: []
            s.children = [SimpleNamespace(poll=lambda: code)]
            with self.subTest(code=code):
                if code == 0:
                    s.normal_close(); self.assertTrue(s.report['normalCloseObserved'])
                else:
                    with self.assertRaises(RuntimeError): s.normal_close()
                    self.assertNotIn('normalCloseObserved', s.report)

    def test_partial_continuation_flags_cannot_claim_combined_or_release_acceptance(self):
        value = dict(scope=M.SCOPE, launcherVersion='0.1.16', hostVersion='0.1.17', combinedAccepted=False,
            releaseReady=False, nativeHelperRemovalAccepted=False,
            **dict.fromkeys(('coldActivationAccepted', 'warmActivationAccepted', 'normalCloseObserved',
                            'launcherRemoved', 'nativeHostRetained', 'settingsRetained'), True))
        M.continuation_proof(value)
        for key in value:
            with self.subTest(key=key), self.assertRaises(RuntimeError): M.continuation_proof({**value, key: None})


class OuterProvisioningTests(unittest.TestCase):
    def profile(self):
        p = M.launcher_contract()
        return dict(flatpakLauncher=p, artifacts={'flatpak16': copy.deepcopy(p['producer'])})

    def test_profile_requires_supplied_exact_original_not_a_relabelled_package(self):
        p = self.profile()
        M.validate_launcher_profile(p)
        M.validate_source_api(p, dict(sha=M.SOURCE_COMMIT, tree=dict(sha=M.SOURCE_TREE)))
        for mutate in (lambda p: p.pop('flatpakLauncher'),
                       lambda p: p['flatpakLauncher'].update(version='0.1.17'),
                       lambda p: p['artifacts']['flatpak16'].update(run=1),
                       lambda p: p['flatpakLauncher']['source'].update(sourceTree='0' * 40)):
            p = self.profile(); mutate(p)
            with self.assertRaises((RuntimeError, KeyError)): M.validate_launcher_profile(p)
        for value in ({}, dict(sha=M.SOURCE_COMMIT, tree=dict(sha='0' * 40))):
            with self.assertRaises(RuntimeError): M.validate_source_api(self.profile(), value)

    def test_sealed_handoff_rechecks_full_outer_closure_not_only_adapter_imports(self):
        f = fixture()
        f.u.source_names.return_value += ('missing-transitive.py',)
        with mocked_context(f.env), self.assertRaises(RuntimeError): f.h.recheck()
        f.u.bound.assert_not_called()

    def test_source_copy_checks_all_members_before_writing_and_never_invents_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve(); source, target = root / 'source', root / 'target'
            source.mkdir(); target.mkdir(); folder = source / 'flatpak-source'; folder.mkdir()
            p = self.profile()
            for name in p['flatpakLauncher']['source']['files']:
                file = folder / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(b'exact-fixture')
            u = SimpleNamespace(bound=Mock(return_value=b'exact-fixture'), write=Mock())
            M.copy_launcher_source(u, source, target, p)
            self.assertEqual(u.bound.call_count, 12); self.assertEqual(u.write.call_count, 12)
            self.assertTrue(all(c.args[1] == b'exact-fixture' for c in u.write.call_args_list))
            (folder / 'foreign').write_bytes(b'not allowed')
            with self.assertRaises(RuntimeError): M.launcher_sources(u, source, p)
            (folder / 'foreign').unlink(); (folder / 'LICENSE').unlink()
            with self.assertRaises(RuntimeError): M.launcher_sources(u, source, p)

    def test_pure_launcher_validation_uses_only_original_source_api_files_not_other_workflow(self):
        p = self.profile(); answer = {k: p['flatpakLauncher'][k] for k in ('source', 'commit')}
        u = SimpleNamespace(parse=json.loads, run_tool=Mock(return_value=M.encoded(answer)), bound=Mock())
        sealed = dict(nodeImage=pin(b'node'), sources={n: pin(b'source') for n in ('native-linux-production-016-flatpak.cjs', 'flatpak-native-production-016.cjs')})
        with patch.object(M, 'launcher_sources'):
            self.assertEqual(M.stage_launcher(u, Path('/inputs'), p,
                {'flatpakSource': dict(sha=M.SOURCE_COMMIT, tree=dict(sha=M.SOURCE_TREE))}, {'CONTROLLER_NODE': '/node'}, sealed), p['flatpakLauncher'])
        self.assertEqual(u.bound.call_count, 6)
        script = u.run_tool.call_args.args[0][2]
        self.assertIn('lane.flatpakAPI(', script); self.assertIn('lane.flatpakFiles(', script)
        for forbidden in ('lane.preflight(', 'lane.collect(', 'lane.portableFiles(', 'lane.admission('): self.assertNotIn(forbidden, script)
        u.run_tool.return_value = b'{}'
        with patch.object(M, 'launcher_sources'), self.assertRaises(RuntimeError):
            M.stage_launcher(u, Path('/inputs'), p, {'flatpakSource': dict(sha=M.SOURCE_COMMIT, tree=dict(sha=M.SOURCE_TREE))}, {'CONTROLLER_NODE': '/node'}, sealed)

    def test_policy_is_one_named_user_two_exact_readonly_commands_no_shell_or_wildcard(self):
        body = M.helper_policy().decode()
        self.assertEqual(body.count('NOPASSWD:'), 1)
        self.assertEqual(body, 'creator-polkit-fixture ALL=(root) NOPASSWD: ' + ', '.join(' '.join(c) for c in M.helper_commands()) + '\n')
        for forbidden in ('*', 'SETENV', '/bin/sh', 'root-proxy-snapshot,', 'uid1001', 'ALL,'):
            self.assertNotIn(forbidden, body)

    def install_context(self):
        u = SimpleNamespace(BASE=M.BASE, USER='creator-polkit-fixture', pin=pin, parse=json.loads,
            admission=Mock(return_value=M.SCENARIO), protected_ancestry=Mock(), write=Mock(), save=Mock(),
            bound=Mock(return_value=b'original-reader'), run_tool=Mock(return_value=b''),
            clean_context=Mock(return_value={'GITHUB_SHA': 'a' * 40}), read=Mock())
        sealed = dict(scenario=M.SCENARIO, context={'GITHUB_SHA': 'a' * 40}, sources={
            'native-linux-flatpak-activation-observer.py': pin(b'original-reader')})
        u.read.return_value = M.encoded(dict(harnessSource='a' * 40, context=M.CONTEXT, inventoryProbed=True, codeSha256=pin(b'original-reader')['sha256']))
        env = {'GITHUB_SHA': 'a' * 40}
        stack = ExitStack()
        stack.enter_context(patch.object(M.os, 'getuid', return_value=0, create=True))
        stack.enter_context(patch.object(M.os, 'geteuid', return_value=0, create=True))
        stack.enter_context(patch.object(M.os.path, 'lexists', return_value=False))
        stack.enter_context(patch.object(Path, 'mkdir'))
        return u, env, sealed, stack

    def test_root_helper_setup_rejects_foreign_authority_existing_policy_and_uid_before_writes(self):
        for kind in ('uid', 'scenario', 'source', 'existing', 'gui', 'other-workflow'):
            u, env, sealed, stack = self.install_context()
            with self.subTest(kind=kind), stack:
                if kind == 'uid': stack.enter_context(patch.object(M.os, 'getuid', return_value=1001))
                if kind == 'scenario': sealed['scenario'] = 'portable-approve'
                if kind == 'source': sealed['context']['GITHUB_SHA'] = 'b' * 40
                if kind == 'existing': stack.enter_context(patch.object(M.os.path, 'lexists', return_value=True))
                if kind == 'gui': env['DISPLAY'] = ':1'
                if kind == 'other-workflow': env['EXECUTION_REQUEST'] = 'true'
                with self.assertRaises(RuntimeError): M.install_observer(u, env, sealed)
                u.write.assert_not_called(); u.run_tool.assert_not_called()

    def test_setup_uses_explicit_modes_bounded_unprivileged_probe_and_preserves_first_failure(self):
        u, env, sealed, stack = self.install_context()
        with stack: M.install_observer(u, env, sealed)
        self.assertEqual([c.args[2] for c in u.write.call_args_list], [0o444, 0o440])
        calls = u.run_tool.call_args_list
        self.assertEqual(calls[0].args[0], ['/usr/sbin/visudo', '-c', '-f', str(M.OBSERVER_POLICY)])
        self.assertEqual(calls[1].args[0][:6], ['/usr/sbin/runuser', '--user', 'creator-polkit-fixture', '--', '/usr/bin/env', '-i'])
        self.assertEqual(calls[1].args[0][-1], 'flatpak-probe')
        self.assertEqual(calls[1].kwargs, dict(limit=32768, timeout=15))
        self.assertTrue(u.save.call_args.args[1]['probePassed'])
        for at in (0, 1):
            u, env, sealed, stack = self.install_context(); error = RuntimeError('original refusal')
            u.run_tool.side_effect = [b''] * at + [error]; u.save.side_effect = ValueError('receipt failure')
            with stack, self.assertRaisesRegex(RuntimeError, 'original refusal'): M.install_observer(u, env, sealed)
            self.assertFalse(u.save.call_args.args[1]['probePassed'])
            self.assertEqual(u.run_tool.call_count, at + 1)

    def test_probe_rejects_gui_foreign_workflow_wrong_uid_before_root_exchange(self):
        f = fixture()
        for name, value in (('DISPLAY', ':1'), ('EXECUTION_REQUEST', 'true'), ('DBUS_SESSION_BUS_ADDRESS', 'bus')):
            with mocked_context(f.env), patch.object(M.F, 'root_exchange') as exchange, self.assertRaises(RuntimeError):
                M.observer_probe(f.u, {name: value}, f.request)
            exchange.assert_not_called()

    def test_headless_probe_uses_exact_context_and_response_nonce_deadline_with_no_input_authority(self):
        for failure in (None, 'response', 'exit', 'stderr', 'expired', 'validation'):
            f = fixture(); f.u.save = Mock(); f.u.bound.return_value = b'pass'
            module = ModuleType('probe_fixture')
            context = SimpleNamespace(uid=M.UID, runtime=M.ROOT / 'runtime',
                probe_operation='flatpak-proxy-inventory-uid21314', probe_command='root-inventory-probe-update016')
            module.named_context = Mock(return_value=context)
            module.protected_tool, module.root_process, module.probe_request, module.validate_probe = Mock(), Mock(return_value={}), Mock(), Mock()
            module.PROXY_TOOL = M.OBSERVER_TOOL
            if failure == 'validation': module.validate_probe.side_effect = RuntimeError('snapshot refused')
            def exchange(tool, operation, raw, deadline):
                self.assertEqual((tool, operation), (M.OBSERVER_TOOL, context.probe_command))
                request = json.loads(raw)
                self.assertEqual(request['sequence'], 1); self.assertRegex(request['nonce'], '^[a-f0-9]{64}$')
                self.assertEqual(request['operation'], context.probe_operation)
                if failure == 'response': request['nonce'] = '0' * 64
                return SimpleNamespace(returncode=1 if failure == 'exit' else 0, stderr=b'fail' if failure == 'stderr' else b'',
                    stdout=M.encoded(dict(ok=True, request=request, snapshot={})))
            with mocked_context(f.env), patch.object(M, 'ModuleType', return_value=module), \
                 patch.object(M.F, 'root_exchange', side_effect=exchange) as rpc, \
                 patch.object(M.time, 'monotonic_ns', side_effect=[10, 11, 10**12 if failure == 'expired' else 12]):
                if failure:
                    with self.assertRaises(RuntimeError): M.observer_probe(f.u, {'GITHUB_SHA': 'a' * 40}, f.request)
                    f.u.save.assert_not_called()
                else:
                    M.observer_probe(f.u, {'GITHUB_SHA': 'a' * 40}, f.request)
                    proof = f.u.save.call_args.args[1]
                    self.assertTrue(proof['readOnly']); self.assertFalse(proof['inputPermitted']); self.assertFalse(proof['authorityGranted'])
                    self.assertEqual(module.protected_tool.call_count, 2)
                self.assertEqual(rpc.call_count, 1)

    def test_launcher_install_only_uses_private_home_original_bundle_and_observed_runtime(self):
        f = fixture(); f.u.save = Mock(); p = self.profile()
        f.u.read.side_effect = None
        proof = dict(scenario=M.SCENARIO, harnessSource='a' * 40, installed=True, probePassed=True,
            commands=[list(c) for c in M.helper_commands()], tool=f.request['sources']['native-linux-flatpak-activation-observer.py'], policy=pin(M.helper_policy()))
        f.u.read.return_value = M.encoded(proof)
        metadata = ('[Application]\nname=com.creatorworks.hub\nruntime=org.gnome.Platform/x86_64/50\n'
                    'sdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub-flatpak-activate\n[Context]\n'
                    'sockets=wayland;fallback-x11;\n[Session Bus Policy]\n' + M.F.NAME + '=talk\n').encode()
        for failure in (None, 'runtime', 'launcher', 'permissions', 'existing', 'policy'):
            f.u.save.reset_mock(); calls = []
            def command(args, *, env, timeout):
                calls.append(args)
                self.assertEqual(env['HOME'], str(M.HOME)); self.assertEqual(env['FLATPAK_USER_DIR'], str(M.ROOT / 'installation'))
                self.assertEqual(args[:2], ['/usr/bin/flatpak', '--user'])
                if args[2:4] == ['remote-info', '--show-ref']: return M.RUNTIME.encode()
                if args[2:4] == ['remote-info', '--show-commit']: return b'd' * 64
                if args[2:4] == ['info', '--show-commit']:
                    return ((b'e' if failure == 'runtime' else b'd') * 64 if args[-1] == M.RUNTIME else
                            (b'0' * 64 if failure == 'launcher' else M.COMMIT.encode()))
                if args[2:4] == ['info', '--show-metadata']: return metadata + (b'[Foreign]\nkey=true\n' if failure == 'permissions' else b'')
                return b''
            altered = copy.deepcopy(proof)
            if failure == 'policy': altered['policy']['sha256'] = '0' * 64
            f.u.read.return_value = M.encoded(altered)
            with mocked_context(f.env), patch.object(M.os.path, 'lexists', return_value=failure == 'existing'), patch.object(M.F, 'command', side_effect=command):
                if failure:
                    with self.assertRaises(RuntimeError): M.install_launcher(f.u, f.env, f.request, p)
                    f.u.save.assert_not_called()
                else:
                    M.install_launcher(f.u, f.env, f.request, p)
                    self.assertEqual(f.u.save.call_args.args[1], installed())
                    self.assertIn(str(M.BASE / 'inputs/members/flatpak16' / M.BUNDLE), calls[-3])
                if failure in ('existing', 'policy'): self.assertEqual(calls, [])

    def test_evidence_exports_only_bounded_lane_files_never_user_home_or_native_host(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root).resolve(); evidence = base / 'result/flatpak-evidence'; evidence.mkdir(parents=True)
            for name in ('report.json', 'cold.stdout', 'warm.stderr', 'cold-disclosure-gtk.json', 'warm-activation-observer-gtk.json'):
                (evidence / name).write_bytes(b'{}')
            u = SimpleNamespace(BASE=base)
            with patch.object(M, 'EVIDENCE', evidence):
                names = M.evidence_names(u)
                self.assertEqual(len(names), 8)
                (evidence / 'settings.json').write_bytes(b'private')
                with self.assertRaises(RuntimeError): M.evidence_names(u)


if __name__ == '__main__':
    unittest.main(verbosity=2)
