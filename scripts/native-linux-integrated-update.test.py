"""Portable synthetic contracts only. No app, installer, credentials or sockets."""
import ast
import copy
import ctypes as C
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

    def test_protected_refusal_reports_exact_checked_metadata_without_relaxing_guard(self):
        for uid, gid, mode, redirect in ((0, 0, 0o777, False), (1001, 0, 0o755, False),
                                         (0, 1001, 0o755, False), (0, 0, 0o4755, False), (0, 0, 0o755, True)):
            info = SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFDIR | mode)
            with self.subTest(uid=uid, gid=gid, mode=mode, redirect=redirect), \
                    patch.object(Path, 'lstat', return_value=info), \
                    patch.object(Path, 'resolve', autospec=True, side_effect=lambda item, strict: Path('/foreign') if redirect else item):
                with self.assertRaisesRegex(RuntimeError, '^Protected fixed source/ancestor required: ') as raised:
                    M.protected(Path('/opt'))
                row = json.loads(str(raised.exception).split(': ', 1)[1])
                self.assertEqual(row, {'path': str(Path('/opt')), 'uid': uid, 'gid': gid, 'mode': format(mode, '04o'),
                                      'resolvedPath': str(Path('/foreign') if redirect else Path('/opt')), 'redirect': redirect})
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o755)), \
                patch.object(Path, 'resolve', autospec=True, side_effect=lambda item, strict: item):
            self.assertEqual(M.protected(Path('/opt')), Path('/opt'))

    def preflight_metadata(self, *, mode=0o755, save_error=None):
        def metadata(item):
            if item == M.BASE or M.BASE in item.parents:
                raise FileNotFoundError(2, 'not present')
            return SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | (mode if item == Path('/opt') else 0o755))
        with patch.object(Path, 'lstat', autospec=True, side_effect=metadata), \
                patch.object(Path, 'resolve', autospec=True, side_effect=lambda item, strict: item), \
                patch.object(Path, 'open') as opening, patch.object(Path, 'read_bytes') as reading, \
                patch.object(M.os, 'chmod') as chmod, patch.object(M, 'command') as command, \
                patch.object(M, 'evidence', side_effect=save_error) as save, patch('builtins.print'):
            if mode == 0o755 and save_error is None:
                M.path_preflight({'RUNNER_TEMP': '/tmp'})
            else:
                with self.assertRaises(RuntimeError if mode != 0o755 else OSError) as raised:
                    M.path_preflight({'RUNNER_TEMP': '/tmp'})
                if mode != 0o755:
                    self.assertTrue(str(raised.exception).startswith('Protected fixed source/ancestor required: '))
            opening.assert_not_called(); reading.assert_not_called(); chmod.assert_not_called(); command.assert_not_called()
            return save.call_args.args[1]

    def test_early_preflight_is_bounded_metadata_only_and_absence_is_not_a_fixture_read(self):
        report = self.preflight_metadata()
        self.assertTrue(report['guardPassed']); self.assertTrue(report['readOnly'])
        self.assertEqual(len(report['paths']), 5)
        self.assertEqual(report['paths'][1], {'path': str(Path('/opt')), 'exists': True, 'uid': 0, 'gid': 0,
                                            'mode': '0755', 'resolvedPath': str(Path('/opt')), 'redirect': False})
        self.assertEqual(report['paths'][-1], {'path': str(M.BASE / 'binding.json'), 'exists': False, 'lstatErrno': 2})
        self.assertLess(len(json.dumps(report).encode()), 8192)

    def test_unsafe_ancestry_refuses_and_diagnostic_save_failure_cannot_replace_original_error(self):
        report = self.preflight_metadata(mode=0o777)
        self.assertFalse(report['guardPassed'])
        self.assertEqual(report['paths'][1]['mode'], '0777')
        self.assertEqual(report['error']['type'], 'RuntimeError')
        self.preflight_metadata(mode=0o777, save_error=OSError('cleanup failed'))
        self.preflight_metadata(save_error=OSError('save failed'))

    def opt_fixture(self, *, mode=0o777, changes=None, before_change=None, after_change=None, redirect=False, save_error=None):
        root = dict(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o755, st_dev=10, st_ino=1, st_mtime_ns=11, st_ctime_ns=12)
        opt = {**root, 'st_mode': stat.S_IFDIR | mode, 'st_ino': 2}
        if changes:
            opt.update(changes)
        count = 0
        def metadata(item):
            nonlocal count
            if item == Path('/'):
                count += 1
                if count == 2 and before_change:
                    before_change(root, opt)
                return SimpleNamespace(**root)
            self.assertEqual(item, Path('/opt'))
            return SimpleNamespace(**opt)
        def chmod(args):
            self.assertEqual(args, ['/usr/bin/sudo', '-n', '/usr/bin/chmod', '0755', '/opt'])
            opt['st_mode'] = stat.S_IFDIR | 0o755; opt['st_ctime_ns'] += 1
            if after_change:
                after_change(root, opt)
        with patch.object(M.sys, 'platform', 'linux'), patch.object(M.platform, 'machine', return_value='x86_64'), \
                patch.object(Path, 'lstat', autospec=True, side_effect=metadata), \
                patch.object(Path, 'resolve', autospec=True, side_effect=lambda item, strict: Path('/foreign') if redirect and item == Path('/opt') else item), \
                patch.object(M, 'command', side_effect=chmod) as command, patch.object(M.os, 'chmod') as local_chmod, \
                patch.object(Path, 'read_bytes') as reading, patch.object(M, 'evidence', side_effect=save_error) as save, patch('builtins.print'):
            try:
                M.tighten_opt({**ENV, 'RUNNER_TEMP': '/tmp'})
                error = None
            except Exception as caught:
                error = caught
            local_chmod.assert_not_called(); reading.assert_not_called()
            return error, save.call_args.args[1], command

    def test_only_observed_opt_0777_is_tightened_once_with_stable_root_and_inode(self):
        error, report, command = self.opt_fixture()
        self.assertIsNone(error); command.assert_called_once_with(['/usr/bin/sudo', '-n', '/usr/bin/chmod', '0755', '/opt'])
        self.assertTrue(report['guardPassed']); self.assertTrue(report['changed']); self.assertEqual(report['chmodAttemptCount'], 1)
        self.assertEqual(report['before']['root'], report['after']['root'])
        self.assertEqual(report['before']['opt']['mode'], '0777'); self.assertEqual(report['after']['opt']['mode'], '0755')
        for key in ('uid', 'gid', 'dev', 'inode', 'mtimeNs'):
            self.assertEqual(report['before']['opt'][key], report['after']['opt'][key])
        error, report, command = self.opt_fixture(mode=0o755)
        self.assertIsNone(error); command.assert_not_called()
        self.assertEqual(report['before'], report['after']); self.assertFalse(report['changed'])
        self.assertLess(len(json.dumps(report).encode()), 8192)

    def test_opt_nonroot_link_unknown_mode_and_preaction_root_changes_never_chmod(self):
        cases = [{'changes': {'st_uid': 1001}}, {'changes': {'st_gid': 1001}}, {'redirect': True},
                 {'changes': {'st_mode': stat.S_IFLNK | 0o777}}, {'mode': 0o775}, {'mode': 0o1777}, {'mode': 0o700}]
        for key in ('st_uid', 'st_gid', 'st_dev', 'st_ino', 'st_mode', 'st_mtime_ns', 'st_ctime_ns'):
            cases.append({'before_change': lambda root, opt, key=key: root.update({key: root[key] + 1})})
            cases.append({'before_change': lambda root, opt, key=key: opt.update({key: opt[key] + 1})})
        for args in cases:
            with self.subTest(args=args):
                error, report, command = self.opt_fixture(**args)
                self.assertIsInstance(error, RuntimeError); command.assert_not_called()
                self.assertFalse(report['guardPassed']); self.assertEqual(report['chmodAttemptCount'], 0)

    def test_postchmod_root_or_opt_identity_changes_refuse_and_original_error_survives_save_failure(self):
        for target in ('root', 'opt'):
            keys = ('st_uid', 'st_gid', 'st_dev', 'st_ino', 'st_mode', 'st_mtime_ns') + (('st_ctime_ns',) if target == 'root' else ())
            for key in keys:
                with self.subTest(target=target, key=key):
                    def change(root, opt):
                        value = root if target == 'root' else opt
                        value[key] += 1
                    error, report, command = self.opt_fixture(after_change=change)
                    self.assertIsInstance(error, RuntimeError); self.assertFalse(report['guardPassed'])
                    self.assertEqual(command.call_count, 1)
        error, report, command = self.opt_fixture(mode=0o775, save_error=OSError('save failed'))
        self.assertIsInstance(error, RuntimeError); command.assert_not_called()

    def test_opt_tightening_rejects_foreign_context_before_metadata_or_sudo(self):
        with patch.object(M.sys, 'platform', 'win32'), patch.object(Path, 'lstat') as lstat, \
                patch.object(M, 'command') as command, patch.object(M, 'evidence'), patch('builtins.print'):
            with self.assertRaises(RuntimeError): M.tighten_opt({**ENV, 'RUNNER_TEMP': '/tmp'})
            lstat.assert_not_called(); command.assert_not_called()

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
        update = Node('/update', ROLE.PUSH_BUTTON, 'Update Hub', rect=(340, 540, 80, 25))
        cancel = Node('/cancel', ROLE.PUSH_BUTTON, 'Not now', rect=(450, 540, 80, 25))
        tree = Node('/alert', ROLE.ALERT, 'Information', [Node('/title', ROLE.LABEL, M.TITLE), Node('/question', ROLE.LABEL, M.QUESTION), update, cancel])
        owner = {'pid': 222, 'startTime': '123', 'executable': M.HUB, 'uids': [M.UID] * 4, 'kernelImageSha256': M.ELF14[1]}
        frame = {'window': 101, 'pid': 222, 'title': 'Creator Hub - Development Preview', 'client': 50, 'mapped': True}
        dialog = {'window': 102, 'pid': 222, 'title': M.TITLE, 'client': 50, 'mapped': True}
        refs = Mock(); refs.aliases = {':1.2': {'pid': 222, 'uid': M.UID, 'owner': ':1.2'}}
        refs.identity.side_effect = lambda node, _: [':1.2', node.path]
        native = Mock(); native.native_process.return_value = owner; native.native_ax_references.return_value = (refs, Mock())
        native.client_ids.return_value = [101, 102]
        native.file_record.return_value = {'size': 12, 'sha256': 'a' * 64}
        bindings = {101: frame, 102: dialog}
        helper = Mock()
        helper.Request.side_effect = lambda action, pid, start, executable, sha256, window, title, role, **kwargs: SimpleNamespace(
            action=action, pid=pid, start=start, executable=executable, sha256=sha256, window=window, title=title, role=role, **kwargs)
        helper.bound_window.side_effect = lambda request, _: {k: v for k, v in bindings[request.window].items() if k != 'window'}
        helper.select_window.return_value = tree
        def children(node, limit):
            M.require(len(node.kids) <= limit, 'Child bound')
            return list(node.kids)
        helper.fresh_close_children.side_effect = children
        frames = {101: (170, 110, 942, 605), 102: (325, 420, 631, 184)}
        x11 = Mock(); x11.frame_rectangle.side_effect = lambda xid: frames[xid]
        polkit = Mock(); polkit.windows.return_value = [frame, dialog]
        pixels = Mock(return_value=(b'\x89PNG\r\n\x1a\nfixture', {'nonblank': True}))
        return SimpleNamespace(update=update, cancel=cancel, tree=tree, owner=owner, helper=helper, native=native,
                               x11=x11, polkit=polkit, refs=refs, main=frame, dialog=dialog, frames=frames,
                               bindings=bindings, pixels=pixels, visibility=Mock())

    def capture(self, f, *, approve=True, file=None):
        if file is None:
            directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup); file = Path(directory.name)
        with patch.object(M, 'dialog_unobscured', f.visibility), patch.object(M, 'dialog_frame_pixels', f.pixels):
            return M.capture_root_dialog(file, f.owner, f.helper, f.native, f.x11, AT, f.polkit, f.main, approve=approve)

    def test_two_complete_source_bound_root_snapshots_precede_exactly_one_press(self):
        f = self.gtk(); result = self.capture(f)
        self.assertEqual(result['actionCount'], 1); self.assertTrue(result['questionSourceChecked'])
        f.update.action.do_action.assert_called_once_with(0); f.cancel.action.do_action.assert_not_called()
        self.assertEqual(f.helper.select_window.call_count, 2)
        self.assertEqual(result['surface']['pair']['windows'], [f.main, f.dialog])
        self.assertEqual(result['surface']['rectangle'], [325, 420, 631, 184])
        f.native.bitmap.assert_not_called(); f.pixels.assert_called_once_with([325, 420, 631, 184], f.native)
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
        f = self.gtk()
        def changed_frame(*_):
            if f.helper.select_window.call_count == 2:
                f.frames[102] = (326, 420, 631, 184)
            return f.tree
        f.helper.select_window.side_effect = changed_frame
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

    def test_owned_main_modal_pair_binds_both_xres_windows_and_frames(self):
        f = self.gtk()
        pair = M.confirmation_pair(f.owner, f.main, f.dialog, f.helper, f.native, f.x11, f.polkit)
        self.assertEqual(pair['windows'], [f.main, f.dialog])
        self.assertEqual(pair['frames'], [list(f.frames[101]), list(f.frames[102])])
        self.assertEqual([call.args[0].window for call in f.helper.bound_window.call_args_list], [101, 102])
        self.assertEqual([call.args[0].pid for call in f.helper.bound_window.call_args_list], [222, 222])

    def test_foreign_extra_replaced_and_reordered_modal_windows_refuse_before_pixels_or_input(self):
        changes = [lambda f: f.native.client_ids.configure_mock(return_value=[101, 102, 999]),
                   lambda f: f.polkit.windows.configure_mock(return_value=[f.dialog, f.main]),
                   lambda f: f.polkit.windows.configure_mock(return_value=[f.main, {**f.dialog, 'window': 999}]),
                   lambda f: f.dialog.update(pid=333), lambda f: f.dialog.update(client=51),
                   lambda f: f.native.native_process.configure_mock(return_value={**f.owner, 'startTime': '124'}),
                   lambda f: f.helper.bound_window.configure_mock(side_effect=lambda *_: {'pid': 999})]
        for change in changes:
            with self.subTest(change=change):
                f = self.gtk(); change(f)
                with self.assertRaises(RuntimeError): self.capture(f)
                f.pixels.assert_not_called(); f.update.action.do_action.assert_not_called()

    def test_modal_pair_replacement_during_pixels_never_publishes_image_or_presses(self):
        f = self.gtk()
        def replace(*_):
            f.native.client_ids.return_value = [101, 999]
            return b'png', {'nonblank': True}
        f.pixels.side_effect = replace
        with self.assertRaisesRegex(RuntimeError, 'confirmation window'): self.capture(f)
        f.native.write_new.assert_not_called(); f.update.action.do_action.assert_not_called()

    def test_ambiguous_confirmation_action_is_recorded_once_without_retry(self):
        f = self.gtk(); f.update.action.do_action.side_effect = RuntimeError('Unknown native click result')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, 'Unknown native click result'): self.capture(f, file=root)
            record = json.loads((root / 'root-confirmation-action.json').read_bytes())
            self.assertEqual(record['actionAttemptCount'], 1); self.assertIsNone(record['returned']); self.assertFalse(record['retry'])
        f.update.action.do_action.assert_called_once_with(0); f.cancel.action.do_action.assert_not_called()

    def test_modal_bitmap_refuses_a_request_for_the_other_owned_window(self):
        f = self.gtk()
        first = {'native': f.dialog, 'frame': list(f.frames[102]),
                 'pair': M.confirmation_pair(f.owner, f.main, f.dialog, f.helper, f.native, f.x11, f.polkit)}
        request = f.helper.Request('snapshot', 222, '123', M.HUB, M.ELF14[1], 101, M.TITLE, 'ALERT')
        with self.assertRaisesRegex(RuntimeError, 'capture request differs'):
            M.confirmation_bitmap(Path('unused'), request, f.owner, f.main, first, f.helper, f.native, f.x11, f.polkit)
        f.native.write_new.assert_not_called()

    def visibility(self, frame, *, occluder=False, offscreen=False):
        class Attributes(C.Structure):
            _fields_ = [(name, C.c_int) for name in ('x', 'y', 'width', 'height', 'border', 'map_state', 'class_')]
        helper, x11 = Mock(), Mock(); helper.WindowAttributes = Attributes
        x = x11.x; x.XDefaultRootWindow.return_value = 1
        arrays = []
        def tree(_display, xid, root, parent, children, count):
            p, ids = {102: (1002, []), 1002: (1, []), 1: (0, [1001, 1002] + ([1003] if occluder else []))}[xid]
            C.cast(root, C.POINTER(C.c_ulong))[0] = 1
            C.cast(parent, C.POINTER(C.c_ulong))[0] = p
            C.cast(count, C.POINTER(C.c_uint))[0] = len(ids)
            array = (C.c_ulong * len(ids))(*ids); arrays.append(array)
            C.cast(children, C.POINTER(C.POINTER(C.c_ulong)))[0] = C.cast(array, C.POINTER(C.c_ulong))
            return 1
        def attrs(_display, xid, value):
            v = C.cast(value, C.POINTER(Attributes)).contents
            v.x, v.y, v.width, v.height, v.border, v.map_state, v.class_ = (
                (0, 0, 600 if offscreen else 1280, 1000, 0, 2, 1) if xid == 1 else (400, 430, 100, 100, 0, 2, 1))
            return 1
        x.XQueryTree.side_effect = tree; x.XGetWindowAttributes.side_effect = attrs
        return M.dialog_unobscured(SimpleNamespace(window=102), frame, helper, x11)

    def test_actual_small_modal_frame_is_visible_but_occlusion_and_screen_overflow_refuse(self):
        self.visibility([325, 420, 631, 184])
        for args in ({'occluder': True}, {'offscreen': True}):
            with self.subTest(args=args), self.assertRaises(RuntimeError): self.visibility([325, 420, 631, 184], **args)
        for frame in ([-1, 0, 100, 100], [0, 0, 0, 100], [0, 950, 100, 100]):
            with self.subTest(frame=frame), self.assertRaises(RuntimeError): self.visibility(frame)

    def authentication(self):
        f = self.gtk()
        f.agent = {'pid': 333, 'startTime': '456', 'parentPid': 111, 'executable': '/fixed/polkit-agent',
                   'kernelImageSha256': 'b' * 64, 'uids': [M.UID] * 4}
        f.auth = {'window': 201, 'pid': 333, 'client': 60, 'title': 'Authenticate', 'mapped': True}
        f.bindings[201] = f.auth; f.frames[201] = (300, 300, 640, 350)
        f.polkit.AGENT = f.agent['executable']; f.polkit.FILES = {f.polkit.AGENT: ('package', 'version', 123, 'b' * 64, 0o755)}
        f.native.native_process.side_effect = lambda pid, _: {222: f.owner, 333: f.agent}[pid]
        f.native.client_ids.return_value = [101, 201]
        f.polkit.windows.side_effect = lambda pid, *_: {222: [f.main], 333: [f.auth]}[pid]
        f.auth_request = f.helper.Request('snapshot', 333, '456', f.agent['executable'], 'b' * 64, 201, 'Authenticate', 'DIALOG')
        return f

    def auth_capture(self, f):
        first = {'native': f.auth, 'frame': list(f.frames[201]),
                 'pair': M.authentication_pair(f.owner, f.main, f.agent, f.auth, f.helper, f.native, f.x11, f.polkit)}
        with patch.object(M, 'dialog_unobscured', f.visibility), patch.object(M, 'dialog_frame_pixels', f.pixels):
            return M.authentication_bitmap(Path('unused'), f.auth_request, f.owner, f.main, f.agent, first,
                                           f.helper, f.native, f.x11, f.polkit)

    def test_authentication_pair_captures_only_owned_agent_dialog_without_input_or_acceptance(self):
        f = self.authentication(); result = self.auth_capture(f)
        self.assertEqual(result['pair']['windows'], [f.main, f.auth])
        self.assertEqual(result['rectangle'], [300, 300, 640, 350])
        self.assertEqual(result['actionCount'], 0); self.assertFalse(result['authorization']); self.assertTrue(result['readOnly'])
        self.assertEqual(f.pixels.call_count, 1); self.assertEqual(f.visibility.call_count, 2)
        self.assertEqual([call.args[0].pid for call in f.helper.bound_window.call_args_list], [222, 333] * 3)
        f.native.bitmap.assert_not_called(); f.update.action.do_action.assert_not_called(); f.cancel.action.do_action.assert_not_called()

    def test_authentication_foreign_replaced_or_extra_windows_and_processes_refuse_before_capture(self):
        changes = [lambda f: f.native.client_ids.configure_mock(return_value=[101, 201, 999]),
                   lambda f: f.polkit.windows.configure_mock(side_effect=lambda pid, *_: [{**f.main, 'window': 999}] if pid == 222 else [f.auth]),
                   lambda f: f.auth.update(pid=444), lambda f: f.auth.update(client=50), lambda f: f.auth.update(title='Other'),
                   lambda f: f.agent.update(executable='/foreign/program'), lambda f: f.agent.update(kernelImageSha256='c' * 64),
                   lambda f: f.agent.update(uids=[0] * 4),
                   lambda f: f.native.native_process.configure_mock(side_effect=lambda pid, _: {**f.agent, 'startTime': '457'} if pid == 333 else f.owner),
                   lambda f: f.helper.bound_window.configure_mock(side_effect=lambda *_: {'pid': 999})]
        for change in changes:
            with self.subTest(change=change):
                f = self.authentication(); change(f)
                with self.assertRaises(RuntimeError): self.auth_capture(f)
                f.pixels.assert_not_called(); f.native.write_new.assert_not_called()

    def test_authentication_pair_change_during_pixels_refuses_before_retaining_image(self):
        changes = [lambda f: f.native.client_ids.configure_mock(return_value=[101, 999]),
                   lambda f: f.native.native_process.configure_mock(side_effect=lambda pid, _: {**f.agent, 'startTime': '457'} if pid == 333 else f.owner),
                   lambda f: f.frames.update({201: (301, 300, 640, 350)}),
                   lambda f: f.helper.bound_window.configure_mock(side_effect=lambda *_: {'pid': 999})]
        for change in changes:
            with self.subTest(change=change):
                f = self.authentication()
                def replace(*_):
                    change(f)
                    return b'png', {'nonblank': True}
                f.pixels.side_effect = replace
                with self.assertRaises(RuntimeError): self.auth_capture(f)
                f.native.write_new.assert_not_called()

    def test_authentication_capture_request_must_bind_the_fixed_agent_and_exact_dialog(self):
        for key, value in (('window', 101), ('pid', 222), ('start', '457'), ('sha256', 'c' * 64), ('role', 'FRAME')):
            with self.subTest(key=key):
                f = self.authentication(); setattr(f.auth_request, key, value)
                with self.assertRaisesRegex(RuntimeError, 'capture request differs'): self.auth_capture(f)
                f.pixels.assert_not_called(); f.native.write_new.assert_not_called()

    def test_session_uses_finite_authentication_pair_capture_not_the_singleton_bitmap(self):
        source = (HERE / 'native-linux-integrated-update.py').read_text()
        tree = ast.parse(source)
        session = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'session')
        calls = [node for node in ast.walk(session) if isinstance(node, ast.Call)]
        self.assertEqual(sum(isinstance(call.func, ast.Name) and call.func.id == 'authentication_bitmap' for call in calls), 1)
        generic = [call for call in calls if isinstance(call.func, ast.Attribute) and call.func.attr == 'bitmap']
        self.assertEqual(len(generic), 1)  # Only the best-effort failure screenshot retains the singleton policy.
        body = ast.get_source_segment(source, session)
        self.assertIn("report['axToXidAssociationVerified'] = False", body)
        self.assertNotIn('do_action', body)

    def original_report(self, raw, **changes):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'report.json').write_bytes(raw)
            info = {'st_mode': stat.S_IFREG | 0o600, 'st_nlink': 1, 'st_uid': M.UID, 'st_size': len(raw), **changes}
            with patch.object(Path, 'lstat', return_value=SimpleNamespace(**info)), \
                    patch.object(Path, 'resolve', autospec=True, side_effect=lambda file, strict: file):
                return M.original_session_failure(root)

    def test_original_session_report_allows_incomplete_owned_writes_then_retains_exact_error(self):
        for raw in (b'', b'{"phase":', b'{}'):
            with self.subTest(raw=raw): self.assertIsNone(self.original_report(raw))
        failure = {'phase': 'capture-and-press-root-confirmation-once',
                   'error': {'type': 'RuntimeError', 'message': 'Other managed windows present; bitmap refused'}}
        self.assertEqual(self.original_report(json.dumps(failure).encode()), failure)

    def test_original_session_report_refuses_foreign_links_oversize_and_invalid_error_shape(self):
        raw = b'{"phase":"capture","error":{"type":"RuntimeError","message":"original"}}'
        for changes in ({'st_uid': 0}, {'st_nlink': 2}, {'st_mode': stat.S_IFLNK | 0o777}, {'st_size': 262145}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError): self.original_report(raw, **changes)
        with self.assertRaises(RuntimeError): self.original_report(b'{"phase":"capture","error":{"message":"missing type"}}')

    def broker_failure(self, *, original=True, observer=False, pump_error=False, close_error=False, save_error=False):
        failure = {'phase': 'capture-and-press-root-confirmation-once',
                   'error': {'type': 'RuntimeError', 'message': 'Other managed windows present; bitmap refused'}}
        child, capture, native, helper, polkit = Mock(), Mock(), Mock(), Mock(), Mock()
        polls = iter((None, None, 1, 1)); child.poll.side_effect = lambda: next(polls, 1)
        native.Capture.return_value = capture
        if pump_error:
            def pump(*args):
                if not args: raise OSError('drain failed')
            capture.pump.side_effect = pump
        if close_error:
            capture.close.side_effect = OSError('close failed')
        errors = iter((None, failure if original else None)) if observer else iter((failure if original else None,) * 2)
        records = {}
        def save(file, value):
            records[file.name] = copy.deepcopy(value)
            if save_error and file.name == 'broker-report.json': raise OSError('diagnostic save failed')
        pending_error = RuntimeError('Owned process is not live')
        with patch.object(M.os, 'getuid', return_value=0, create=True), patch.object(M.os, 'geteuid', return_value=0, create=True), \
                patch.object(M, 'binding'), patch.object(M, 'locked_account'), patch.object(M, 'load', return_value=polkit), \
                patch.object(M, 'pages', return_value=SimpleNamespace(helpers=lambda: (helper, native))), \
                patch.object(M, 'session_command', return_value=['synthetic-session']), patch.object(M.subprocess, 'Popen', return_value=child) as launch, \
                patch.object(M, 'original_session_failure', side_effect=lambda _: next(errors, failure if original else None)), \
                patch.object(M, 'pending_request', side_effect=pending_error if observer else None) as pending, \
                patch.object(M, 'evidence', side_effect=save), patch('builtins.print'):
            with self.assertRaises(RuntimeError) as raised: M.broker(ENV)
        launch.assert_called_once(); capture.close.assert_called_once_with()
        child.terminate.assert_not_called(); child.kill.assert_not_called()
        return raised.exception, records['broker-report.json'], pending, pending_error

    def test_broker_stops_observation_when_original_session_failure_is_already_recorded(self):
        error, report, pending, _ = self.broker_failure()
        self.assertIn('Other managed windows present; bitmap refused', str(error)); pending.assert_not_called()
        self.assertEqual(report['originalSessionFailure']['phase'], 'capture-and-press-root-confirmation-once')
        self.assertEqual(report['sessionExit'], 1); self.assertFalse(report['pendingDpkgObserved'])
        self.assertTrue(all(report[key] is False for key in M.FALSE_GATES))

    def test_broker_original_session_error_wins_over_observer_cleanup_and_diagnostic_save_errors(self):
        for args in ({}, {'pump_error': True}, {'close_error': True}, {'pump_error': True, 'close_error': True, 'save_error': True}):
            with self.subTest(args=args):
                error, report, pending, observer = self.broker_failure(observer=True, **args)
                self.assertIn('Other managed windows present; bitmap refused', str(error)); self.assertIs(error.__cause__, observer)
                self.assertEqual(report['observerError']['message'], 'Owned process is not live'); pending.assert_called_once()
                self.assertEqual(report['originalSessionFailure']['error']['message'], 'Other managed windows present; bitmap refused')
                self.assertEqual(report['credentialActionCount'], 0); self.assertFalse(report['passwordProvisioned'])
                if args.get('pump_error') or args.get('close_error'): self.assertIn('cleanupError', report)

    def test_broker_retains_observer_error_when_no_original_session_error_exists(self):
        error, report, pending, observer = self.broker_failure(original=False, observer=True, close_error=True)
        self.assertIs(error, observer); pending.assert_called_once()
        self.assertNotIn('originalSessionFailure', report); self.assertIn('cleanupError', report)

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
        for job in ('preflight', 'native'):
            steps = workflow['jobs'][job]['steps']
            diagnostic = next(i for i, step in enumerate(steps) if step.get('run', '').endswith(' path-tighten'))
            self.assertEqual(diagnostic, 1)  # checkout then metadata; no input download/install first
            upload = steps[diagnostic + 1]
            self.assertEqual(upload['if'], 'always()')
            self.assertEqual(upload['with']['path'].splitlines(), ['${{ runner.temp }}/integrated-update-path-preflight.json',
                                                                 '${{ runner.temp }}/integrated-update-opt-tightening.json'])
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
