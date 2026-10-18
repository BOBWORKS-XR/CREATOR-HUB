"""Portable synthetic contracts only. No app, installer, credentials or sockets."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('integrated_update', HERE / 'native-linux-integrated-update.py')
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)
ENV = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'BOBWORKS-XR/CREATOR-HUB', 'GITHUB_REPOSITORY_ID': '1364807512',
       'GITHUB_REF': M.BRANCH, 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'RUNNER_ENVIRONMENT': 'github-hosted',
       'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'CREATOR_LINUX_INTEGRATED_UPDATE': '1',
       'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
ROLE = SimpleNamespace(ALERT=1, LABEL=2, PUSH_BUTTON=3, PASSWORD_TEXT=4, APPLICATION=5, FRAME=6, WINDOW=7, DIALOG=8)
AT = SimpleNamespace(Role=ROLE, CoordType=SimpleNamespace(SCREEN=0), StateType=SimpleNamespace(
    SHOWING='SHOWING', ENABLED='ENABLED', SENSITIVE='SENSITIVE', DEFUNCT='DEFUNCT', BUSY='BUSY', EDITABLE='EDITABLE'))


class Node:
    def __init__(self, path, role, name, children=(), pid=222, rect=(150, 350, 80, 25)):
        self.path, self.role, self.name, self.kids, self.pid, self.rect = path, role, name, list(children), pid, rect
        self.parent = None
        self.states = {'SHOWING', 'ENABLED', 'SENSITIVE'}
        self.action = Mock(); self.action.get_n_actions.return_value = 1; self.action.get_action_name.return_value = 'click'
        self.action.do_action.return_value = True
        for node in children: node.parent = self

    def clear_cache(self): pass
    def get_process_id(self): return self.pid
    def get_role(self): return self.role
    def get_name(self): return self.name
    def get_parent(self): return self.parent
    def get_state_set(self): return SimpleNamespace(contains=lambda state: state in self.states)
    def get_action_iface(self): return self.action
    def get_component_iface(self):
        return SimpleNamespace(get_extents=lambda _: SimpleNamespace(x=self.rect[0], y=self.rect[1], width=self.rect[2], height=self.rect[3]))


class Contracts(unittest.TestCase):
    def test_admission_is_native_manual_exact_branch_and_injection_free(self):
        M.admission(ENV, 'linux', 'x86_64', native=True)
        M.admission({**ENV, 'GITHUB_EVENT_NAME': 'push'}, 'linux', 'x86_64')
        for key in ENV:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: 'foreign'}, 'linux', 'x86_64', native=True)
        for system, machine in [('win32', 'x86_64'), ('darwin', 'arm64'), ('linux', 'aarch64')]:
            with self.assertRaises(RuntimeError): M.admission(ENV, system, machine, native=True)
        for key in ('LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
                    'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'http_proxy',
                    'TAURI_SIGNING_PRIVATE_KEY', 'WEBKIT_INSPECTOR_SERVER', 'CREATOR_HUB_SIGNING_KEY', 'FLATPAK_ID'):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: 'forbidden'}, 'linux', 'x86_64', native=True)
        with self.assertRaises(RuntimeError): M.admission({**ENV, 'GITHUB_EVENT_NAME': 'push'}, 'linux', 'x86_64', native=True)

    def test_main_refuses_foreign_context_before_files_imports_and_processes(self):
        with patch.dict(M.os.environ, ENV, clear=True), patch.object(M.sys, 'platform', 'win32'), \
                patch.object(M.sys, 'argv', ['probe', 'prepare']), patch.object(M, 'pages') as pages, patch.object(M.subprocess, 'Popen') as launch:
            with self.assertRaises(RuntimeError): M.main()
            pages.assert_not_called(); launch.assert_not_called()

    def test_no_approve_cancel_password_mode_is_available(self):
        for mode in ('approve', 'system-cancel', 'authenticate', 'retry', 'install15'):
            with patch.object(M.sys, 'argv', ['probe', mode]), patch.object(M, 'admission') as admit:
                with self.assertRaises(RuntimeError): M.main()
                admit.assert_not_called()
        self.assertTrue(all(value is False for value in M.FALSE_GATES.values()))

    def test_pins_are_current_integrated_producers_not_old_fixture(self):
        self.assertEqual(M.SOURCE, '5065fb1112b9e96978e40e64503fa979f559baae')
        self.assertEqual(M.ELF14, (27369792, '3ac7fdd5cedf85df41844c32c7dcdeb180ca14fc66a7f6e274c1ace5fc5e39b8'))
        self.assertEqual(M.DEB15, (63874030, '4cbd1488e0568e79ad8a9bc47d445cbbb344abc2c72045cde2dd3cd5e72fb36d'))
        self.assertEqual(set(M.SIGNED_FILES), {M.ASSET, M.DESCRIPTOR, M.DESCRIPTOR + '.minisig', 'latest.json', 'signing-receipt.json'})
        self.assertNotIn('534465', (HERE / 'native-linux-integrated-update.py').read_text())
        self.assertNotIn('native-linux-update-flow', (HERE / 'native-linux-integrated-update.py').read_text())

    def test_evidence_is_exclusive_bounded_read_back_before_native_action(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'receipt.json'
            value = {'preInput': True, 'actionCount': 0}
            record = M.evidence(file, value)
            self.assertEqual(record['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertEqual(record['size'], len(file.read_bytes()))
            with self.assertRaises(FileExistsError): M.evidence(file, value)
            other = Path(directory) / 'large.json'
            with self.assertRaises(RuntimeError): M.evidence(other, {'x': 'x' * 32768})
            self.assertFalse(other.exists())
            with patch.object(Path, 'read_bytes', return_value=b'changed'), self.assertRaises(RuntimeError):
                M.evidence(Path(directory) / 'changed.json', value)

    def archive(self, entries, *, exact=False, selected=None):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        root = Path(directory.name); archive = root / 'input.zip'; output = root / 'out'; output.mkdir()
        with zipfile.ZipFile(archive, 'w') as stream:
            for name, data, mode in entries:
                info = zipfile.ZipInfo(name); info.external_attr = mode << 16
                stream.writestr(info, data)
        selected = selected or {'input': ('fixed', 3, hashlib.sha256(b'abc').hexdigest())}
        M.zip_select(archive, output, selected, exact_names=exact)
        return output

    def test_zip_uses_fixed_names_not_archive_paths_or_permissions(self):
        output = self.archive([('input', b'abc', stat.S_IFREG | 0o777)])
        self.assertEqual((output / 'fixed').read_bytes(), b'abc')
        for name, data, mode in [('input', b'bad', stat.S_IFREG), ('input', b'abc', stat.S_IFLNK),
                                 ('../input', b'abc', stat.S_IFREG), ('/input', b'abc', stat.S_IFREG),
                                 ('x\\input', b'abc', stat.S_IFREG)]:
            with self.subTest(name=name, mode=mode), self.assertRaises(RuntimeError): self.archive([(name, data, mode)])
        with self.assertRaises(RuntimeError): self.archive([('input', b'abc', stat.S_IFREG), ('extra', b'x', stat.S_IFREG)], exact=True)
        with self.assertRaises(RuntimeError): self.archive([('input', b'abc', stat.S_IFREG), ('input', b'abc', stat.S_IFREG)])

    def gtk(self):
        update = Node('/update', ROLE.PUSH_BUTTON, 'Update Hub')
        cancel = Node('/cancel', ROLE.PUSH_BUTTON, 'Not now', rect=(270, 350, 80, 25))
        tree = Node('/alert', ROLE.ALERT, 'Information', [Node('/title', ROLE.LABEL, M.TITLE), Node('/question', ROLE.LABEL, M.QUESTION), update, cancel])
        owner = {'pid': 222, 'startTime': '123', 'executable': M.HUB, 'uids': [M.UID] * 4, 'kernelImageSha256': M.ELF14[1]}
        frame = {'window': 101, 'pid': 222, 'title': 'Creator Hub - Development Preview', 'client': 50, 'mapped': True}
        dialog = {'window': 102, 'pid': 222, 'title': M.TITLE, 'client': 50, 'mapped': True}
        refs = Mock(); refs.aliases = {':1.2': {'pid': 222, 'uid': M.UID, 'owner': ':1.2'}}
        refs.identity.side_effect = lambda node, _: [':1.2', node.path]
        native = Mock(); native.native_process.return_value = owner; native.native_ax_references.return_value = (refs, Mock())
        native.bitmap.return_value = {'diagnosticOnly': True, 'nonblank': True}
        helper = Mock(); helper.Request.return_value = Mock(); helper.bound_window.return_value = {k: v for k, v in dialog.items() if k != 'window'}
        helper.select_window.return_value = tree
        def children(node, limit):
            M.require(len(node.kids) <= limit, 'Child bound')
            return list(node.kids)
        helper.fresh_close_children.side_effect = children
        x11 = Mock(); x11.frame_rectangle.return_value = (100, 100, 400, 300)
        polkit = Mock(); polkit.windows.return_value = [frame, dialog]
        return SimpleNamespace(update=update, cancel=cancel, tree=tree, owner=owner, helper=helper, native=native, x11=x11, polkit=polkit, refs=refs, main=frame)

    def capture(self, f, *, approve=True, file=None):
        if file is None:
            directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup); file = Path(directory.name)
        return M.capture_root_dialog(file, f.owner, f.helper, f.native, f.x11, AT, f.polkit, f.main, approve=approve)

    def test_two_complete_source_bound_root_snapshots_precede_exactly_one_press(self):
        f = self.gtk(); result = self.capture(f)
        self.assertEqual(result['actionCount'], 1); self.assertTrue(result['questionSourceChecked'])
        f.update.action.do_action.assert_called_once_with(0); f.cancel.action.do_action.assert_not_called()
        self.assertEqual(f.helper.select_window.call_count, 2)
        f = self.gtk(); self.assertEqual(self.capture(f, approve=False)['actionCount'], 0)
        f.update.action.do_action.assert_not_called()

    def test_context_pid_parent_duplicate_hidden_editable_and_geometry_refuse_before_press(self):
        changes = [lambda f: setattr(f.tree.kids[1], 'name', 'Different question'),
                   lambda f: setattr(f.update, 'pid', 333), lambda f: setattr(f.update, 'parent', None),
                   lambda f: f.tree.kids.append(f.update), lambda f: f.update.states.remove('SHOWING'),
                   lambda f: f.update.states.add('EDITABLE'), lambda f: setattr(f.update, 'role', ROLE.PASSWORD_TEXT),
                   lambda f: setattr(f.update, 'rect', (0, 0, 80, 25)), lambda f: setattr(f.tree.kids[0], 'role', ROLE.FRAME),
                   lambda f: setattr(f.cancel, 'name', 'Authenticate')]
        for change in changes:
            f = self.gtk(); change(f)
            with self.subTest(change=change), self.assertRaises(RuntimeError): self.capture(f)
            f.update.action.do_action.assert_not_called()

    def test_changed_frame_graph_bus_or_evidence_never_authorizes_a_press(self):
        f = self.gtk(); f.x11.frame_rectangle.side_effect = [(100, 100, 400, 300), (100, 100, 400, 300), (101, 100, 400, 300), (101, 100, 400, 300)]
        with self.assertRaises(RuntimeError): self.capture(f)
        f.update.action.do_action.assert_not_called()
        f = self.gtk(); f.refs.recheck.side_effect = RuntimeError('bus changed')
        with self.assertRaises(RuntimeError): self.capture(f)
        f.update.action.do_action.assert_not_called()
        f = self.gtk()
        with patch.object(M, 'evidence', side_effect=OSError('evidence failed')), self.assertRaises(OSError): self.capture(f)
        f.update.action.do_action.assert_not_called()
        f = self.gtk(); f.update.action.do_action.return_value = False
        with self.assertRaises(RuntimeError): self.capture(f)
        f.update.action.do_action.assert_called_once_with(0)

    def test_original_root_xres_frame_cannot_be_replaced_by_another_same_pid_frame(self):
        f = self.gtk()
        other = {**f.main, 'window': 999}
        f.polkit.windows.return_value = [other, f.polkit.windows.return_value[1]]
        with self.assertRaises(RuntimeError): self.capture(f)
        f.update.action.do_action.assert_not_called()

    def test_only_action_alias_click_and_one_action_are_admitted(self):
        for name, count in [('press', 1), ('click', 2), ('', 0)]:
            f = self.gtk(); f.update.action.get_action_name.return_value = name; f.update.action.get_n_actions.return_value = count
            with self.assertRaises(RuntimeError): self.capture(f)
            f.update.action.do_action.assert_not_called()

    def test_session_is_finite_locked_user_pam_logind_no_password_or_auth_mode(self):
        command = M.session_command(ENV)
        self.assertEqual(command[:2], ['/usr/bin/systemd-run', '--wait'])
        for flag in ('--uid=creator-polkit-fixture', '--property=PAMName=login', '--property=LimitCORE=0', '--property=RuntimeMaxSec=240'):
            self.assertIn(flag, command)
        self.assertEqual(command[-2:], [str(M.BASE / 'scripts/native-linux-integrated-update.py'), 'session'])
        self.assertNotIn('HTTPS_PROXY', ' '.join(command))

    def test_transport_requires_all_four_exact_native_fetched_signed_resources_without_acceptance(self):
        prefix = '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/'
        value = {'pins': M.PINS, **dict.fromkeys(('publicDiscovery', 'signaturesVerifiedByHarness', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady'), False),
                 'requests': [{'host': 'github.com', 'path': prefix + name, 'sha256': sha} for name, sha in (
                     (M.DESCRIPTOR, M.PINS['descriptor']), (M.DESCRIPTOR + '.minisig', M.PINS['descriptorSignature']),
                     (M.ASSET, M.PINS['installer']), ('latest.json', M.PINS['manifest']))]}
        M.transport_proof(value)
        for key in ('publicDiscovery', 'signaturesVerifiedByHarness', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady'):
            with self.assertRaises(RuntimeError): M.transport_proof({**value, key: True})
        for index in range(4):
            changed = copy.deepcopy(value); changed['requests'][index]['sha256'] = 'c' * 64
            with self.assertRaises(RuntimeError): M.transport_proof(changed)
        with self.assertRaises(RuntimeError): M.transport_proof({**value, 'requests': value['requests'][:-1]})

    def test_locked_account_contract_reads_status_only_and_rejects_foreign_memberships(self):
        user = SimpleNamespace(pw_uid=M.UID, pw_gid=M.UID, pw_dir='/var/lib/' + M.USER, pw_shell='/bin/bash')
        fake_pwd = SimpleNamespace(getpwnam=Mock(return_value=user)); fake_grp = SimpleNamespace(getgrnam=Mock(return_value=SimpleNamespace(gr_gid=27)))
        with patch.dict(sys.modules, pwd=fake_pwd, grp=fake_grp), \
                patch.object(M.os, 'getgrouplist', return_value=[M.UID, 27], create=True), patch.object(M, 'command', return_value=(M.USER + ' L metadata').encode()) as command:
            M.locked_account()
            command.assert_called_once_with(['/usr/bin/passwd', '-S', M.USER])
            with patch.object(M.os, 'getgrouplist', return_value=[M.UID, 27, 999]), self.assertRaises(RuntimeError): M.locked_account()
            command.return_value = (M.USER + ' P metadata').encode()
            with self.assertRaises(RuntimeError): M.locked_account()

    def test_workflow_parses_all_inline_python_javascript_and_bash_without_execution(self):
        import yaml
        file = HERE.parent / '.github/workflows/native-linux-integrated-update.yml'
        workflow = yaml.safe_load(file.read_text())
        self.assertEqual(set(workflow['jobs']), {'preflight', 'input', 'native'})
        self.assertEqual(workflow['jobs']['native']['permissions']['contents'], 'read')
        self.assertEqual(workflow['jobs']['input']['permissions']['contents'], 'write')
        self.assertEqual(workflow['jobs']['native']['if'], "github.event_name == 'workflow_dispatch'")
        trigger = workflow.get('on', workflow.get(True))
        self.assertIsNone(trigger['workflow_dispatch'])  # no mode/version/path override inputs
        bash = shutil.which('bash')
        if sys.platform == 'win32':
            git_bash = Path('C:/Program Files/Git/bin/bash.exe')
            bash = str(git_bash) if git_bash.exists() else bash
        self.assertIsNotNone(bash, 'Bash syntax checker required for workflow preflight')
        for job in workflow['jobs'].values():
            for step in job['steps']:
                if 'run' in step:
                    checked = subprocess.run([bash, '-n'], input=step['run'], text=True, capture_output=True)
                    self.assertEqual(checked.returncode, 0, checked.stderr)
                    for source in re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", step['run'], re.S): ast.parse(source)
                script = step.get('with', {}).get('script')
                if script:
                    checked = subprocess.run(['node', '--check'], input='async function check(){\n' + script + '\n}', text=True, capture_output=True)
                    self.assertEqual(checked.returncode, 0, checked.stderr)
        source = file.read_text()
        for value in ('39134487363', '39134454264', '12139109123', '12139297945', '653651716', *[v[1] for v in M.INPUTS.values()]):
            self.assertIn(value, source)
        for forbidden in ('chpasswd', 'testing.startLoopbackTransport', 'native-linux-update-flow.py', 'catalog-key', 'releases.updateRelease', 'createRelease'):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
