"""Passive-observer tests; optional real GI uses a new disposable private bus only."""
import ast
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('activation_observer', HERE / 'native-linux-flatpak-activation-observer.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def message(msg_kind=1, **changes):
    kind = msg_kind
    record = dict(kind=kind, sender=':1.40' if kind == 1 else ':1.31', destination=M.NAME if kind == 1 else ':1.40',
                  serial=20 if kind == 1 else 30, replySerial=0 if kind == 1 else 20, flags=0 if kind == 1 else 1, empty=True)
    if kind == 1:
        record.update(path=M.PATH, interface=M.INTERFACE, member='Start')
    record.update(changes)
    return record


def process(pid, parent, path='/usr/bin/xdg-dbus-proxy', start=None, full=False):
    record = dict(pid=pid, parentPid=parent, startTime=str(start or pid), uids=[1001] * 4, executable=path,
                  image=dict(st_size='64', st_uid='0', st_gid='0', st_mode=str(0o100755)))
    if full:
        record['kernelImageSha256'] = 'a' * 64
    return record


def invocation_stat(inode, mode, size=64):
    return SimpleNamespace(st_dev=1, st_ino=inode, st_mode=mode, st_uid=0, st_gid=0,
                           st_nlink=1, st_size=size, st_mtime_ns=1, st_ctime_ns=1)


@contextmanager
def invocation_fixture():
    caller = dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10')
    rows = {19: {**caller, 'state': 'S'},
            20: dict(pid=20, parentPid=19, startTime='20', state='S', uids=[1001, 0, 0, 0], executable='/usr/bin/sudo'),
            21: dict(pid=21, parentPid=20, startTime='21', state='R', uids=[0] * 4, executable='/usr/bin/python3.10')}
    state = SimpleNamespace(caller=caller, rows=rows, reads=[], links=[], events=[], exited=set(), replaced=set(), image_bad=False,
                            permission=None, close_error=False, images={})
    stats = {'python': invocation_stat(10, stat.S_IFREG | 0o755), 'sudo': invocation_stat(11, stat.S_IFREG | 0o4755)}
    def package(kind, budget):
        def snapshot():
            state.events.append(('image', kind)); budget()
            if state.image_bad: raise ValueError('fixed synthetic package mutation')
            return ('a' if kind == 'python' else 'b') * 64
        image = SimpleNamespace(path='/usr/bin/python3.10' if kind == 'python' else '/usr/bin/sudo',
            identity=M.ProxyAssociationProc.stamp(stats[kind]), digest=('a' if kind == 'python' else 'b') * 64,
            snapshot=Mock(side_effect=snapshot), close=Mock())
        state.images[kind] = image
        return image
    def read(directory, name, maximum):
        pid = directory - 1000; state.reads.append((pid, name))
        if state.permission is not None: raise state.permission
        row = rows[pid]
        if name == 'stat':
            return (f'{pid} (PRIVATE_COMM) {row["state"]} {row["parentPid"]} ' + '0 ' * 17 + row['startTime'] + '\n').encode(), []
        assert name == 'status'
        return ('Uid:\t' + ' '.join(str(v) for v in row['uids']) + '\n').encode(), []
    def opened(name, flags, **options):
        if name == 'exe': return 2000 + options['dir_fd'] - 1000
        assert str(name).startswith('/proc/')
        return 1000 + int(str(name).rsplit('/', 1)[1])
    def info(fd):
        pid = fd - 2000
        original = stats['python' if pid in (19, 21) else 'sudo']
        return invocation_stat(999, original.st_mode) if pid in state.replaced else original
    def linked(name, *, dir_fd):
        assert name == 'exe'; state.links.append(dir_fd - 1000)
        return rows[dir_fd - 1000]['executable']
    def closed(fd):
        state.events.append(('close', fd))
        if state.close_error: raise OSError('fixed synthetic close failure')
    with patch.object(M.os, 'O_DIRECTORY', 0, create=True), patch.object(M.os, 'O_NOFOLLOW', 0, create=True), \
            patch.object(M.os, 'O_NONBLOCK', 0, create=True), \
            patch.object(M.os, 'O_CLOEXEC', 0, create=True), patch.object(M.os, 'getpid', return_value=21), \
            patch.object(M.os, 'pidfd_open', side_effect=lambda pid: 3000 + pid, create=True), \
            patch.object(M.os, 'open', side_effect=opened), patch.object(M.os, 'close', side_effect=closed), \
            patch.object(M.os, 'fstat', side_effect=info), patch.object(M.os, 'stat', side_effect=lambda name, dir_fd: info(dir_fd + 1000)), \
            patch.object(M.os, 'readlink', side_effect=linked), patch.object(M.ProxyAssociationProc, 'read_at', side_effect=read), \
            patch.object(M.select, 'select', side_effect=lambda fds, *_: ([fd for fd in fds if fd - 3000 in state.exited], [], [])), \
            patch.object(M, 'InvocationImage', side_effect=package, create=True):
        yield state


class InvocationGuardTests(unittest.TestCase):
    def test_direct_worker_caller_path_keeps_held_identity_without_any_sudo_exemption(self):
        with invocation_fixture() as state:
            state.rows[21]['parentPid'] = 19
            with M.InvocationChain(state.caller) as held:
                rows = held.receipt()
                self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['parentPid'], 19)
                self.assertEqual(rows[0]['executableKind'], 'python'); self.assertEqual(rows[0]['uids'], [0] * 4)
                self.assertEqual(set(held.held), {19, 21}); self.assertEqual(set(state.images), {'python'})
                M.validate_probe(dict(operation=M.PROBE_OPERATION, complete=True, uid=1001, candidateCount=0,
                    scopedProcessCount=1, caller=state.caller, invocation=rows, readOnly=True, inputPermitted=False,
                    authorityGranted=False, releaseReady=False), {'caller': state.caller})
                @contextmanager
                def scan(path):
                    yield [SimpleNamespace(name=str(pid), stat=lambda **opts: SimpleNamespace(st_mode=stat.S_IFDIR | 0o555))
                           for pid in (19, 20, 21)]
                with patch.object(M.os, 'scandir', side_effect=scan), \
                        patch.object(M, 'root_uid_tuple', side_effect=lambda pid: state.rows[pid]['uids']), \
                        patch.object(M, 'root_process', return_value=state.caller), self.assertRaises(ValueError):
                    M.complete_uid_inventory(lambda: None, invocation=held)
                self.assertNotIn(20, state.links)
            self.assertEqual(len([e for e in state.events if e[0] == 'close']), 6)
            state.images['python'].close.assert_called_once()

    def test_direct_chain_keeps_worker_caller_uid_exe_image_pidfd_and_parent_guards(self):
        for mutation in ('worker-uid', 'worker-exe', 'worker-image', 'caller-uid', 'caller-start', 'caller-exe',
                         'caller-exit', 'worker-parent'):
            with self.subTest(mutation=mutation), invocation_fixture() as state:
                state.rows[21]['parentPid'] = 19
                with M.InvocationChain(state.caller) as held:
                    if mutation == 'worker-uid': state.rows[21]['uids'] = [1001, 0, 0, 0]
                    if mutation == 'worker-exe': state.rows[21]['executable'] = '/private/python'
                    if mutation == 'worker-image': state.replaced.add(21)
                    if mutation == 'caller-uid': state.rows[19]['uids'] = [1001, 0, 0, 0]
                    if mutation == 'caller-start': state.rows[19]['startTime'] = '999'
                    if mutation == 'caller-exe': state.rows[19]['executable'] = '/private/python'
                    if mutation == 'caller-exit': state.exited.add(19)
                    if mutation == 'worker-parent': state.rows[21]['parentPid'] = 20
                    with self.assertRaises(ValueError): held.recheck()

    def test_verified_native_tuple_is_sealed_before_inventory_with_held_image_and_proc_guards(self):
        with invocation_fixture() as state, M.InvocationChain(state.caller) as held:
            self.assertEqual(held.mixed_process(20, [1001, 0, 0, 0]), M.InvocationChain.process(state.rows[20]))
            self.assertEqual(set(held.held), {19, 20, 21})
            self.assertEqual(held.receipt()[0]['uids'], [0] * 4)
            self.assertGreaterEqual(state.images['sudo'].snapshot.call_count, 3)
            self.assertFalse(any(event[0] == 'close' for event in state.events))
        self.assertEqual(len([e for e in state.events if e[0] == 'close']), 9)
        for image in state.images.values(): image.close.assert_called_once()

    def test_all_root_mixed_and_combined_sudo_chains_have_identical_held_guards(self):
        root, mixed = [0] * 4, [1001, 0, 0, 0]
        for variants in ((root,), (mixed,), (root, root), (mixed, mixed), (root, mixed), (mixed, root)):
            with self.subTest(variants=variants), invocation_fixture() as state:
                state.rows[20]['uids'] = variants[0]
                if len(variants) == 2:
                    state.rows[22] = dict(pid=22, parentPid=20, startTime='20', state='S',
                                          uids=variants[1], executable='/usr/bin/sudo')
                    state.rows[21]['parentPid'] = 22
                with M.InvocationChain(state.caller) as held:
                    rows = held.receipt()
                    self.assertEqual(rows[0]['uids'], root); self.assertEqual(rows[0]['executableKind'], 'python')
                    self.assertEqual([row['uids'] for row in rows[1:]], list(reversed(variants)))
                    self.assertTrue(all(row['executableKind'] == 'sudo' and row['imageSha256'] == 'b' * 64 for row in rows[1:]))
                    held.recheck()
                    M.validate_probe(dict(operation=M.PROBE_OPERATION, complete=True, uid=1001, candidateCount=0,
                        scopedProcessCount=4, caller=state.caller, invocation=rows, readOnly=True, inputPermitted=False,
                        authorityGranted=False, releaseReady=False), {'caller': state.caller})
                    for pid in (19, 20, 21, *([22] if len(variants) == 2 else [])):
                        self.assertIn(pid, state.links)

    def test_transition_between_the_two_allowed_sudo_tuples_still_refuses_after_binding(self):
        root, mixed = [0] * 4, [1001, 0, 0, 0]
        for before, after in ((root, mixed), (mixed, root)):
            with self.subTest(before=before), invocation_fixture() as state:
                state.rows[20]['uids'] = before
                with M.InvocationChain(state.caller) as held:
                    state.rows[20]['uids'] = after
                    with self.assertRaises(ValueError): held.recheck()

    def test_both_sudo_tuples_keep_executable_image_pidfd_and_live_identity_guards(self):
        for initial in ([0] * 4, [1001, 0, 0, 0]):
            for mutation in ('exe', 'kernel', 'exit', 'parent', 'start', 'permission'):
                with self.subTest(initial=initial, mutation=mutation), invocation_fixture() as state:
                    state.rows[20]['uids'] = initial
                    with M.InvocationChain(state.caller) as held:
                        if mutation == 'exe': state.rows[20]['executable'] = '/private/foreign'
                        if mutation == 'kernel': state.replaced.add(20)
                        if mutation == 'exit': state.exited.add(20)
                        if mutation == 'parent': state.rows[20]['parentPid'] = 88
                        if mutation == 'start': state.rows[20]['startTime'] = '999'
                        if mutation == 'permission': state.permission = PermissionError('fixed proc denial')
                        with self.assertRaises((ValueError, PermissionError)): held.recheck()

    def test_every_other_mixed_sudo_tuple_refuses_even_with_the_verified_image(self):
        rejected = [[1001 if bits & (1 << index) else 0 for index in range(4)] for bits in range(16)]
        rejected = [ids for ids in rejected if ids not in ([0] * 4, [1001, 0, 0, 0])]
        rejected.extend([[1002 if index == position else 0 for index in range(4)] for position in range(4)])
        self.assertEqual(len(rejected), 18)
        for ids in rejected:
            with self.subTest(ids=ids), invocation_fixture() as state:
                state.rows[20]['uids'] = ids
                with self.assertRaises(ValueError) as caught: M.InvocationChain(state.caller)
                hop = caught.exception.proxy_caller_diagnostic['hops'][-1]
                self.assertEqual(caught.exception.proxy_caller_diagnostic['predicate'], 'hop-credentials')
                self.assertEqual(hop['executableKind'], 'sudo'); self.assertEqual(hop['uids'], ids)

    def test_pid_reuse_parent_uid_executable_kernel_image_and_exit_all_refuse(self):
        for mutation in ('start', 'parent', 'uid', 'exe', 'kernel', 'package', 'exit', 'permission', 'caller'):
            with self.subTest(mutation=mutation), invocation_fixture() as state, M.InvocationChain(state.caller) as held:
                if mutation == 'start': state.rows[20]['startTime'] = '999'
                if mutation == 'parent': state.rows[20]['parentPid'] = 88
                if mutation == 'uid': state.rows[20]['uids'] = [1001] * 4
                if mutation == 'exe': state.rows[20]['executable'] = '/private/foreign'
                if mutation == 'kernel': state.replaced.add(20)
                if mutation == 'package': state.image_bad = True
                if mutation == 'exit': state.exited.add(20)
                if mutation == 'permission': state.permission = PermissionError('fixed synthetic proc denial')
                if mutation == 'caller': state.rows[19]['startTime'] = '999'
                with self.assertRaises((ValueError, PermissionError)):
                    held.mixed_process(20, [1001, 0, 0, 0])

    def test_mixed_tuple_is_not_enough_without_exact_held_sudo_pid_and_image(self):
        with invocation_fixture() as state, M.InvocationChain(state.caller) as held:
            for pid, ids in ((88, [1001, 0, 0, 0]), (21, [1001, 0, 0, 0]),
                             (20, [1002, 0, 0, 0]), (20, [1001, 0, 1001, 0]), (20, [1001, False, 0, 0])):
                with self.subTest(pid=pid, ids=ids), self.assertRaises(ValueError): held.mixed_process(pid, ids)
        with invocation_fixture() as state:
            state.replaced.add(20)
            with self.assertRaises(ValueError): M.InvocationChain(state.caller)

    def test_complete_inventory_revalidates_only_exact_chain_and_never_exempts_other_mixed_processes(self):
        for failure in (None, 'unknown-mixed', 'changed-second-scan', 'permission'):
            with self.subTest(failure=failure), invocation_fixture() as state, M.InvocationChain(state.caller) as held:
                scans = []
                @contextmanager
                def scan(path):
                    self.assertEqual(path, '/proc'); scans.append(1)
                    if failure == 'changed-second-scan' and len(scans) == 2: state.rows[20]['startTime'] = '999'
                    values = (19, 20, 21, 88) if failure in ('unknown-mixed', 'permission') else (19, 20, 21)
                    yield [SimpleNamespace(name=str(pid), stat=lambda **opts: SimpleNamespace(st_mode=stat.S_IFDIR | 0o555)) for pid in values]
                def uids(pid):
                    if pid == 88:
                        if failure == 'permission': raise PermissionError('fixed unknown proc denial')
                        return [1001, 0, 0, 0]
                    return state.rows[pid]['uids']
                with patch.object(M.os, 'scandir', side_effect=scan), patch.object(M, 'root_uid_tuple', side_effect=uids), \
                        patch.object(M, 'root_process', return_value=state.caller):
                    if failure is None:
                        proxies, rows = M.complete_uid_inventory(lambda: None, invocation=held)
                        self.assertEqual(proxies, []); self.assertEqual(set(rows), {19, 20})
                        self.assertEqual(rows[20]['uids'], [1001, 0, 0, 0]); self.assertEqual(len(scans), 2)
                    else:
                        with self.assertRaises((ValueError, PermissionError)):
                            M.complete_uid_inventory(lambda: None, invocation=held)

    def test_closed_chain_and_original_error_through_cleanup_never_authorize(self):
        with invocation_fixture() as state:
            held = M.InvocationChain(state.caller); held.close()
            with self.assertRaises(ValueError): held.mixed_process(20, [1001, 0, 0, 0])
            with self.assertRaises(ValueError): held.recheck()
        with invocation_fixture() as state:
            original = PermissionError('fixed proc refusal'); state.permission = original; state.close_error = True
            with self.assertRaises(PermissionError) as caught: M.InvocationChain(state.caller)
            self.assertIs(caught.exception, original); self.assertTrue(original.invocation_cleanup_failed)

    def test_probe_receipt_rejects_unknown_uids_roles_images_and_reparenting(self):
        with invocation_fixture() as state, M.InvocationChain(state.caller) as held:
            value = dict(operation=M.PROBE_OPERATION, complete=True, uid=1001, candidateCount=0, scopedProcessCount=2,
                caller=state.caller, invocation=held.receipt(), readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False)
            M.validate_probe(value, {'caller': state.caller})
            for mutate in (lambda v: v['invocation'][1].update(uids=[1001, 0, 0, 1001]),
                           lambda v: v['invocation'][0].update(uids=[1001, 0, 0, 0]),
                           lambda v: v['invocation'][1].update(executableKind='python'),
                           lambda v: v['invocation'][1].update(imageSha256='unknown'),
                           lambda v: v['invocation'][1].update(parentPid=99)):
                changed = copy.deepcopy(value); mutate(changed)
                with self.assertRaises(ValueError): M.validate_probe(changed, {'caller': state.caller})


class InventoryFailureTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, failure='zombie', second=False):
        state = SimpleNamespace(events=[], scans=0, error=None)
        def active(): return not second or state.scans == 2
        def read(directory, name, maximum):
            state.events.append(('read', name))
            if failure == 'permission' and active(): raise state.error
            if name == 'stat':
                kind = 'Z' if failure == 'zombie' and active() else 'S'
                return (f'1912 (PRIVATE_COMM) {kind} 18 ' + '0 ' * 17 + '123\n').encode(), []
            if failure == 'uid-record' and active(): return b'PRIVATE_STATUS\n', []
            ids = [1001, 0, 0, 0] if failure == 'process-uids' and active() else [1001] * 4
            if failure == 'uid-range' and active(): ids = [1001, 2**31, 0, 0]
            return ('Uid:\t' + ' '.join(map(str, ids)) + '\n').encode(), []
        @contextmanager
        def scan(path):
            state.scans += 1; state.events.append(('scan', path))
            yield [SimpleNamespace(name='1912', stat=lambda **kw: SimpleNamespace(st_mode=stat.S_IFDIR | 0o555))]
        def linked(name, **kw):
            state.events.append(('link', name))
            return '/PRIVATE/EXECUTABLE (deleted)' if failure == 'executable' and active() else '/usr/bin/python3.10'
        state.error = PermissionError('PRIVATE_ORIGINAL_MESSAGE')
        with patch.object(M.os, 'O_DIRECTORY', 0, create=True), patch.object(M.os, 'O_NOFOLLOW', 0, create=True), \
                patch.object(M.os, 'O_CLOEXEC', 0, create=True), patch.object(M.os, 'open', return_value=7), \
                patch.object(M.os, 'close', side_effect=lambda fd: state.events.append(('close', fd))), \
                patch.object(M.os, 'scandir', side_effect=scan), patch.object(M.os, 'readlink', side_effect=linked), \
                patch.object(M.ProxyAssociationProc, 'read_at', side_effect=read):
            yield state

    def test_first_failed_state_predicate_retains_exact_source_and_same_read_metadata(self):
        with self.fixture() as state:
            with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None)
        value = caught.exception.proxy_inventory_diagnostic
        self.assertEqual((value['scan'], value['entryPid'], value['entryUids']), (1, 1912, [1001] * 4))
        self.assertEqual((value['function'], value['predicate'], value['field']),
                         ('root_process.identity', 'process-shape', 'stat'))
        self.assertEqual(value['subject'], dict(pid=1912, parentPid=18, startTime='123', uids=[1001] * 4,
                                               state='Z', executableKind='unread'))
        self.assertTrue(Path(M.__file__).read_text().splitlines()[value['line'] - 1].lstrip().startswith('require(text.startswith'))
        self.assertEqual(state.events, [('scan', '/proc'), ('read', 'status'), ('close', 7),
                                       ('read', 'stat'), ('read', 'status'), ('close', 7)])
        self.assertNotIn('PRIVATE', M.json.dumps(value)); self.assertLess(len(M.json.dumps(value)), 2048)
        self.assertTrue(value['readOnly'])
        for field in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[field], False)

    def test_uid_shape_range_and_executable_refusals_keep_original_order_and_unreached_fields(self):
        for failure, predicate in (('uid-record', 'uid-record'), ('uid-range', 'uid-range'), ('executable', 'executable-shape')):
            with self.subTest(failure=failure), self.fixture(failure=failure) as state:
                with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None)
            value = caught.exception.proxy_inventory_diagnostic
            self.assertEqual(value['predicate'], predicate); self.assertEqual(value['subject']['pid'], 1912)
            self.assertIsNone(value['subject']['state']); self.assertIsNone(value['subject']['parentPid'])
            self.assertIsNone(value['subject']['startTime']); self.assertNotIn('PRIVATE', M.json.dumps(value))
            self.assertEqual(value['subject']['executableKind'], 'other' if failure == 'executable' else 'unread')
            if failure != 'executable':
                self.assertIsNone(value['entryUids'])
                self.assertEqual(state.events, [('scan', '/proc'), ('read', 'status'), ('close', 7)])
            else:
                self.assertEqual(state.events.count(('link', 'exe')), 1)

    def test_permission_keeps_original_exception_and_does_not_read_executable_or_retry(self):
        with self.fixture(failure='permission') as state:
            with self.assertRaises(PermissionError) as caught: M.complete_uid_inventory(lambda: None)
        self.assertIs(caught.exception, state.error)
        value = caught.exception.proxy_inventory_diagnostic
        self.assertEqual((value['scan'], value['entryPid'], value['subject']['pid']), (1, 1912, 1912))
        self.assertEqual(value['function'], 'root_uid_tuple'); self.assertEqual(value['field'], 'status')
        self.assertIsNone(value['entryUids']); self.assertIsNone(value['subject']['uids'])
        self.assertEqual(state.events, [('scan', '/proc'), ('read', 'status'), ('close', 7)])
        self.assertNotIn('PRIVATE', M.json.dumps(value))

    def test_real_read_at_failure_reports_only_fixed_field_without_additional_open(self):
        original = PermissionError('PRIVATE_PATH_AND_MESSAGE')
        @contextmanager
        def scan(path): yield [SimpleNamespace(name='1912', stat=lambda **kw: SimpleNamespace(st_mode=stat.S_IFDIR))]
        with patch.object(M.os, 'O_DIRECTORY', 0, create=True), patch.object(M.os, 'O_NOFOLLOW', 0, create=True), \
                patch.object(M.os, 'O_CLOEXEC', 0, create=True), patch.object(M.os, 'O_NONBLOCK', 0, create=True), \
                patch.object(M.os, 'scandir', side_effect=scan), patch.object(M.os, 'open', return_value=7) as opens, \
                patch.object(M.os, 'close') as closes, patch.object(M.os, 'stat', side_effect=original) as stats:
            with self.assertRaises(PermissionError) as caught: M.complete_uid_inventory(lambda: None)
        self.assertIs(caught.exception, original)
        value = original.proxy_inventory_diagnostic
        self.assertEqual((value['function'], value['predicate'], value['field']), ('ProxyAssociationProc.read_at', 'proc-read', 'status'))
        self.assertEqual(value['subject']['pid'], 1912); self.assertIsNone(value['subject']['uids'])
        self.assertEqual((opens.call_count, closes.call_count, stats.call_count), (1, 1, 1))

    def test_second_scan_failure_and_success_have_no_extra_proc_reads_or_retries(self):
        with self.fixture(second=True) as state:
            with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None)
        self.assertEqual(caught.exception.proxy_inventory_diagnostic['scan'], 2)
        self.assertEqual(state.scans, 2); self.assertEqual(state.events.count(('link', 'exe')), 2)
        with self.fixture(failure=None) as state, patch.object(M, 'inventory_failure') as diagnostic:
            self.assertEqual(M.complete_uid_inventory(lambda: None)[0], [])
            diagnostic.assert_not_called()
        self.assertEqual(state.scans, 2); self.assertEqual(state.events.count(('link', 'exe')), 4)
        self.assertEqual(state.events.count(('read', 'status')), 6)

    def test_entry_uid_metadata_is_not_inherited_from_the_previous_process(self):
        original = PermissionError('PRIVATE_SECOND_ENTRY')
        @contextmanager
        def scan(path):
            yield [SimpleNamespace(name=str(pid), stat=lambda **kw: SimpleNamespace(st_mode=stat.S_IFDIR)) for pid in (1911, 1912)]
        with patch.object(M.os, 'scandir', side_effect=scan), \
                patch.object(M, 'root_uid_tuple', side_effect=[[1002] * 4, original]) as reads, \
                patch.object(M, 'root_process') as processes:
            with self.assertRaises(PermissionError) as caught: M.complete_uid_inventory(lambda: None)
        self.assertIs(caught.exception, original); self.assertEqual(reads.call_count, 2); processes.assert_not_called()
        value = original.proxy_inventory_diagnostic
        self.assertEqual(value['entryPid'], 1912); self.assertIsNone(value['entryUids']); self.assertIsNone(value['subject'])

    def test_diagnostic_capture_and_validator_have_no_proc_io_or_authority_calls(self):
        source = Path(M.__file__).read_text()
        functions = {node.name: node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
        for name in ('inventory_failure', 'inventory_diagnostic'):
            text = ast.get_source_segment(source, functions[name])
            for forbidden in ('os.', 'sys.', 'Path(', 'read_at(', 'readlink(', 'open(', 'pidfd', 'subprocess', 'time.', 'print('):
                self.assertNotIn(forbidden, text)
        self.assertIn('row[0] is trace.tb_frame.f_code', ast.get_source_segment(source, functions['inventory_failure']))

    def test_nested_held_recheck_subject_is_not_replaced_with_scanned_entry(self):
        with invocation_fixture() as state, M.InvocationChain(state.caller) as held:
            @contextmanager
            def scan(path): yield [SimpleNamespace(name='20', stat=lambda **kw: SimpleNamespace(st_mode=stat.S_IFDIR))]
            def ids(pid):
                state.rows[19]['startTime'] = '999'
                return [1001, 0, 0, 0]
            with patch.object(M.os, 'scandir', side_effect=scan), patch.object(M, 'root_uid_tuple', side_effect=ids):
                with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None, invocation=held)
            value = caught.exception.proxy_inventory_diagnostic
            self.assertEqual((value['entryPid'], value['entryUids']), (20, [1001, 0, 0, 0]))
            self.assertEqual((value['function'], value['predicate']), ('InvocationChain.recheck', 'invocation-identity'))
            self.assertEqual(value['subject'], dict(pid=19, parentPid=18, startTime='999', uids=[1001] * 4,
                                                   state='S', executableKind='python'))
            self.assertFalse(hasattr(caught.exception, 'proxy_snapshot_pid'))

    def test_unknown_mixed_process_still_refuses_with_same_read_unverified_kind(self):
        with invocation_fixture() as state, M.InvocationChain(state.caller) as held:
            @contextmanager
            def scan(path): yield [SimpleNamespace(name='1912', stat=lambda **kw: SimpleNamespace(st_mode=stat.S_IFDIR))]
            with patch.object(M.os, 'scandir', side_effect=scan), \
                    patch.object(M, 'root_uid_tuple', return_value=[1001, 0, 0, 0]):
                with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None, invocation=held)
            value = caught.exception.proxy_inventory_diagnostic
            self.assertEqual((value['function'], value['predicate']), ('InvocationChain.mixed_process', 'mixed-membership'))
            self.assertEqual(value['subject']['pid'], 1912); self.assertEqual(value['subject']['uids'], [1001, 0, 0, 0])
            self.assertEqual(value['subject']['executableKind'], 'unread'); self.assertNotIn(1912, state.links)

    def test_first_failure_is_detached_and_serialization_failure_never_masks_or_retries(self):
        with self.fixture() as state:
            with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None)
        original, value = caught.exception, copy.deepcopy(caught.exception.proxy_inventory_diagnostic)
        M.inventory_failure(original, 2, 99, [0] * 4)
        self.assertEqual(original.proxy_inventory_diagnostic, value)
        for failure in (OSError('PRIVATE_SERIALIZATION'), ValueError('PRIVATE_SERIALIZATION')):
            with self.subTest(failure=type(failure)), self.fixture(failure='permission') as state, \
                    patch.object(M, 'inventory_diagnostic', side_effect=failure) as serialize:
                with self.assertRaises(PermissionError) as caught: M.complete_uid_inventory(lambda: None)
                self.assertIs(caught.exception, state.error); serialize.assert_called_once()
                self.assertFalse(hasattr(caught.exception, 'proxy_inventory_diagnostic'))
                self.assertEqual(state.scans, 1)

    def test_root_refusal_transports_only_valid_bounded_inventory_metadata_and_preserves_original(self):
        with self.fixture():
            with self.assertRaises(ValueError) as caught: M.complete_uid_inventory(lambda: None)
        detail = caught.exception.proxy_inventory_diagnostic
        for invalid in (None, 'extra', 'path', 'oversize', 'serialize'):
            error = ValueError('PRIVATE_ORIGINAL_MESSAGE')
            error.proxy_snapshot_stage = 'complete-uid-inventory'
            value = copy.deepcopy(detail)
            if invalid == 'extra': value['argv'] = 'PRIVATE'
            if invalid == 'path': value['subject']['executableKind'] = '/PRIVATE/EXECUTABLE'
            if invalid == 'oversize': value['subject']['startTime'] = '1' * 4096
            error.proxy_inventory_diagnostic = value
            out = io.StringIO()
            with self.subTest(invalid=invalid), ExitStack() as stack:
                for name in ('SIGALRM', 'ITIMER_REAL'): stack.enter_context(patch.object(M.signal, name, 0, create=True))
                for name in ('signal', 'setitimer'): stack.enter_context(patch.object(M.signal, name, create=True))
                for name in ('getuid', 'geteuid'): stack.enter_context(patch.object(M.os, name, return_value=0, create=True))
                stack.enter_context(patch.dict(M.os.environ, {'SUDO_UID': '1001'}))
                stack.enter_context(patch.object(M, 'PROXY_TOOL', Path(M.__file__)))
                stack.enter_context(patch.object(M.sys, 'argv', ['observer.py', 'root-inventory-probe']))
                stack.enter_context(patch.object(M.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(
                    M.json.dumps({'codeSha256': 'b' * 64}).encode()))))
                stack.enter_context(patch.object(M.sys, 'stdout', out))
                stack.enter_context(patch.object(M, 'probe_request'))
                stack.enter_context(patch.object(M, 'protected_tool'))
                probe = stack.enter_context(patch.object(M, 'inventory_probe', side_effect=error))
                if invalid == 'serialize':
                    stack.enter_context(patch.object(M, 'inventory_diagnostic', side_effect=OSError('PRIVATE')))
                with self.assertRaises(SystemExit) as raised: M.root_snapshot_main()
                self.assertIs(raised.exception.__context__, error); probe.assert_called_once()
            receipt = M.json.loads(out.getvalue())
            self.assertEqual(receipt['ok'], False); self.assertEqual(receipt['stage'], 'complete-uid-inventory')
            self.assertEqual(receipt.get('inventoryFailure'), detail if invalid is None else None)
            self.assertNotIn('PRIVATE', out.getvalue()); self.assertLess(len(out.getvalue()), 2300)


class MixedPostFailureTests(unittest.TestCase):
    @contextmanager
    def fixture(self, failure=None, *, fresh=False, held=False, active=True):
        pid = 1686
        row = dict(pid=pid, parentPid=20, startTime='123', uids=[1001, 0, 0, 0], state='S')
        caller = dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, state='S')
        worker = dict(pid=21, parentPid=20, startTime='21', uids=[0] * 4, state='R')
        supervisor = dict(pid=20, parentPid=19, startTime='20', uids=[1001, 0, 0, 0], state='S')
        system = invocation_stat(50, stat.S_IFREG | 0o4755)
        directory = invocation_stat(51, stat.S_IFDIR | 0o555, 0)
        state = SimpleNamespace(reads=[], events=[], closes=[], checks=0, budgets=0, selections=0, row=row,
                                image=system, directory=directory, stat_reads=0, fail=failure)
        def budget():
            state.budgets += 1; state.events.append('budget')
            if failure == 'deadline-before' or failure == 'deadline-after' and state.checks == 2:
                raise ValueError('PRIVATE_EXPIRED')
        def checked():
            state.checks += 1; state.events.append('fixed-check'); budget()
            if failure == 'fixed-before' or failure == 'fixed-after' and state.checks == 2:
                raise ValueError('PRIVATE_FIXED_IMAGE')
        image = SimpleNamespace(identity=M.ProxyAssociationProc.stamp(system), digest='b' * 64,
                                check=Mock(side_effect=checked), close=Mock())
        chain = SimpleNamespace(budget=budget, caller=caller, images={} if fresh else {'sudo': image},
            held={21: dict(row=worker, kind='python'), 20: dict(row=supervisor, kind='sudo'), 19: dict(row=caller, kind='python')})
        if held: chain.held[pid] = dict(row=copy.deepcopy(row), kind='python', directory=7, pidfd=9)
        state.chain, state.reference = chain, image
        def opened(name, flags, **kw):
            state.events.append(('open', name))
            if failure == 'permission': raise PermissionError('PRIVATE_PROC_PATH')
            self.assertIn(name, (f'/proc/{pid}', 'exe'))
            return 8 if name == 'exe' else 7
        def fstat(fd):
            if fd == 7: return directory
            self.assertEqual(fd, 8)
            if failure == 'nonregular': return invocation_stat(50, stat.S_IFIFO | 0o644)
            if failure == 'unlinked': return SimpleNamespace(**{**vars(system), 'st_nlink': 0})
            if failure == 'oversize': return invocation_stat(50, system.st_mode, 64 * 1024**2 + 1)
            if failure == 'kernel-change' and state.stat_reads == 2:
                return invocation_stat(999, system.st_mode)
            return invocation_stat(999, stat.S_IFREG | 0o755) if failure == 'other' else system
        def named(name, **kw):
            if name == 'exe': return fstat(8)
            self.assertEqual(name, f'/proc/{pid}')
            if failure == 'directory-change' and state.stat_reads == 2:
                return invocation_stat(999, directory.st_mode, 0)
            return directory
        def read(fd, name, maximum):
            self.assertEqual(fd, 7); state.reads.append(name); state.events.append(('read', name))
            ids = list(row['uids'])
            if name == 'stat':
                state.stat_reads += 1
                parent, start, kind = row['parentPid'], row['startTime'], row['state']
                if failure == 'start-after' and state.stat_reads == 2: start = '999'
                if failure == 'parent-after' and state.stat_reads == 2: parent = 99
                if failure == 'dead': kind = 'Z'
                return (f'{pid} (PRIVATE_COMM) {kind} {parent} ' + '0 ' * 17 + start + '\n').encode(), []
            if failure == 'uid-before' or failure == 'uid-after' and state.stat_reads == 2: ids = [1001, 0, 1001, 0]
            return ('Uid:\t' + ' '.join(map(str, ids)) + '\n').encode(), []
        def selected(fds, *args):
            self.assertEqual(fds, [9]); state.selections += 1
            return ([9] if failure == 'exited-before' or failure == 'exited-after' and state.selections == 2 else [], [], [])
        def closed(fd):
            state.closes.append(fd)
            if failure == 'close': raise OSError('PRIVATE_CLOSE')
        with ExitStack() as stack:
            for name in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_NONBLOCK'):
                stack.enter_context(patch.object(M.os, name, 0, create=True))
            stack.enter_context(patch.object(M, 'ROOT_DIAGNOSTIC_ACTIVE', active))
            state.factory = stack.enter_context(patch.object(M, 'InvocationImage', return_value=image))
            state.pidfd = stack.enter_context(patch.object(M.os, 'pidfd_open', return_value=9, create=True))
            state.opens = stack.enter_context(patch.object(M.os, 'open', side_effect=opened))
            stack.enter_context(patch.object(M.os, 'close', side_effect=closed))
            stack.enter_context(patch.object(M.os, 'fstat', side_effect=fstat))
            stack.enter_context(patch.object(M.os, 'stat', side_effect=named))
            stack.enter_context(patch.object(M.os, 'readlink', side_effect=AssertionError('No executable path read')))
            stack.enter_context(patch.object(M.os, 'read', side_effect=AssertionError('No candidate bytes')))
            stack.enter_context(patch.object(M.os, 'pread', side_effect=AssertionError('No candidate bytes'), create=True))
            stack.enter_context(patch.object(M.ProxyAssociationProc, 'read_at', side_effect=read))
            stack.enter_context(patch.object(M.select, 'select', side_effect=selected))
            yield state

    def capture(self, state):
        error = ValueError('PRIVATE_ORIGINAL_REFUSAL')
        M.capture_mixed_failure(error, state.chain, 1686, [1001, 0, 0, 0], False, None)
        return error, error.proxy_mixed_diagnostic

    def test_exact_refused_pid_snapshot_verifies_fixed_sudo_but_never_grants_original_membership(self):
        with self.fixture() as state:
            original, value = self.capture(state)
            self.assertFalse(value['heldMembership']); self.assertIsNone(value['heldKind'])
            self.assertEqual(value['subjectPid'], 1686); self.assertEqual(value['observedUids'], [1001, 0, 0, 0])
            self.assertEqual([r['pid'] for r in value['heldChain']], [21, 20, 19])
            self.assertEqual(value['caller']['pid'], 19)
            self.assertEqual([r['parentPid'] for r in value['heldChain']], [20, 19, 18])
            post = value['postFailure']
            self.assertTrue(post['postFailureReadOnly']); self.assertEqual(post['classification'], 'verifiedsudo')
            self.assertEqual(post['before'], post['after']); self.assertTrue(post['live'])
            self.assertEqual(post['fixedSudoImage'], post['kernelImage']); self.assertEqual(post['fixedSudoSha256'], 'b' * 64)
            self.assertEqual(state.reads, ['stat', 'status', 'stat', 'status'])
            self.assertEqual(state.closes, [8, 7, 9]); state.factory.assert_not_called(); state.reference.close.assert_not_called()
            self.assertEqual(state.selections, 2); self.assertNotIn('PRIVATE', M.json.dumps(value))
            for name in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[name], False)
            M.capture_mixed_failure(original, state.chain, 20, [0] * 4, True, 'sudo')
            self.assertIs(original.proxy_mixed_diagnostic, value); self.assertEqual(len(state.reads), 4)

    def test_other_image_metadata_is_not_hashed_or_adopted_and_fresh_reference_is_fixed_sudo_only(self):
        with self.fixture('other', fresh=True) as state:
            _, value = self.capture(state)
            self.assertEqual(value['postFailure']['classification'], 'other')
            self.assertNotEqual(value['postFailure']['kernelImage'], value['postFailure']['fixedSudoImage'])
            state.factory.assert_called_once_with('sudo', state.chain.budget); state.reference.close.assert_called_once()
            self.assertEqual(state.reads, ['stat', 'status', 'stat', 'status'])

    def test_real_image_constructor_cleanup_failure_is_retained_without_replacing_original_refusal(self):
        image_class = M.InvocationImage
        for cleanup_fails in (False, True):
            with self.subTest(cleanup_fails=cleanup_fails), self.fixture(fresh=True) as state:
                proc_open, proc_fstat, proc_stat = M.os.open.side_effect, M.os.fstat.side_effect, M.os.stat.side_effect
                with InvocationImageTests().fixture() as package:
                    package_open, package_fstat, package_stat = M.os.open.side_effect, M.os.fstat.side_effect, M.os.stat.side_effect
                    package.file.st_mode = stat.S_IFREG | 0o755
                    def opened(name, flags, **kw):
                        return (proc_open if name in ('/proc/1686', 'exe') else package_open)(name, flags, **kw)
                    def fstat(fd): return (proc_fstat if fd in (7, 8) else package_fstat)(fd)
                    def named(name, **kw):
                        return (proc_stat if name in ('/proc/1686', 'exe') else package_stat)(name, **kw)
                    def closed(fd):
                        if cleanup_fails and fd == 4: raise OSError('PRIVATE_IMAGE_CLOSE')
                    package.close.side_effect = closed
                    with patch.object(M, 'InvocationImage', image_class), patch.object(M.os, 'open', side_effect=opened), \
                            patch.object(M.os, 'fstat', side_effect=fstat), patch.object(M.os, 'stat', side_effect=named):
                        original, value = self.capture(state)
                    post = value['postFailure']
                    self.assertEqual(post['classification'], 'unavailable')
                    self.assertEqual(post['stage'], 'fixed-sudo-image'); self.assertEqual(post['unavailable'], 'ValueError')
                    self.assertIs(post['cleanupConfirmed'], not cleanup_fails)
                    self.assertEqual([call.args[0] for call in package.close.call_args_list], [4, 3, 2, 1, 7, 9])
                    self.assertEqual(package.reads, []); self.assertEqual(state.reads, ['stat', 'status'])
                    self.assertIsNone(post['fixedSudoImage']); self.assertIsNone(post['kernelImage'])
                    self.assertEqual(str(original), 'PRIVATE_ORIGINAL_REFUSAL'); self.assertNotIn('PRIVATE', M.json.dumps(value))
                    for name in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[name], False)
                    state.factory.assert_not_called(); state.reference.close.assert_not_called()

    def test_post_failure_reads_are_disabled_outside_root_worker_and_held_fds_are_never_closed(self):
        with self.fixture(active=False) as state:
            _, value = self.capture(state)
            self.assertEqual(value['postFailure']['stage'], 'root-worker-only')
            self.assertEqual(value['postFailure']['classification'], 'unavailable')
            self.assertEqual(state.budgets, 0); state.opens.assert_not_called(); state.pidfd.assert_not_called()
            self.assertEqual(state.reads, [])
        with self.fixture(held=True) as state:
            value = M.mixed_post_failure(state.chain, 1686, [1001, 0, 0, 0])
            self.assertEqual(value['classification'], 'verifiedsudo')
            self.assertEqual(state.closes, [8]); state.pidfd.assert_not_called()
            self.assertEqual([call.args[0] for call in state.opens.call_args_list], ['exe'])

    def test_fd_uid_start_parent_image_liveness_permission_and_deadline_negatives_never_qualify(self):
        cases = ('uid-before', 'uid-after', 'start-after', 'parent-after', 'dead', 'kernel-change', 'directory-change',
                 'fixed-before', 'fixed-after', 'exited-before', 'exited-after', 'permission', 'deadline-before', 'deadline-after',
                 'nonregular', 'unlinked', 'oversize', 'close')
        for failure in cases:
            with self.subTest(failure=failure), self.fixture(failure) as state:
                original, value = self.capture(state)
                post = value['postFailure']
                self.assertEqual(post['classification'], 'unavailable'); self.assertLessEqual(state.stat_reads, 2)
                self.assertLessEqual(state.selections, 2); self.assertNotIn('PRIVATE', M.json.dumps(value))
                self.assertEqual(str(original), 'PRIVATE_ORIGINAL_REFUSAL')
                if failure == 'uid-before': self.assertEqual(post['before']['uids'], [1001, 0, 1001, 0])
                if failure == 'dead': self.assertEqual(post['before']['state'], 'Z')
                if failure == 'deadline-before': state.pidfd.assert_not_called(); state.opens.assert_not_called()
                if failure == 'close': self.assertFalse(post['cleanupConfirmed']); self.assertEqual(state.closes, [8, 7, 9])

    def test_held_pid_reuse_is_unavailable_without_reopening_or_closing_the_original_chain_fds(self):
        with self.fixture(held=True) as state:
            state.chain.held[1686]['row']['startTime'] = '122'
            post = M.mixed_post_failure(state.chain, 1686, [1001, 0, 0, 0])
            self.assertEqual(post['classification'], 'unavailable'); self.assertEqual(post['before']['startTime'], '123')
            self.assertEqual(post['stage'], 'identity-before'); state.opens.assert_not_called(); state.pidfd.assert_not_called()
            self.assertEqual(state.closes, []); self.assertEqual(state.reads, ['stat', 'status'])

    def test_successful_post_failure_image_capture_still_raises_the_original_membership_refusal(self):
        for failure in (None, 'other', 'permission', 'deadline-before'):
            with self.subTest(failure=failure), self.fixture(failure) as state:
                state.chain.recheck = Mock(side_effect=AssertionError('No admission after refusal'))
                with self.assertRaisesRegex(ValueError, 'Finite diagnostic contract refused') as caught:
                    M.InvocationChain.mixed_process(state.chain, 1686, [1001, 0, 0, 0])
                state.chain.recheck.assert_not_called()
                detail = caught.exception.proxy_mixed_diagnostic
                self.assertFalse(detail['heldMembership']); self.assertIsNone(detail['heldKind'])
                self.assertEqual(detail['postFailure']['classification'], 'verifiedsudo' if failure is None else
                                 'other' if failure == 'other' else 'unavailable')

    def test_post_snapshot_final_deadline_is_strict_at_boundary_and_never_extended(self):
        for delta in (-1, 0, 1):
            with self.subTest(delta=delta), self.fixture() as state:
                clock = [1]
                state.chain.budget = lambda: M.require(clock[0] < 100)
                original = state.reference.check.side_effect
                def check():
                    original()
                    if state.checks == 2: clock[0] = 100 + delta
                state.reference.check.side_effect = check
                post = M.mixed_post_failure(state.chain, 1686, [1001, 0, 0, 0])
                self.assertEqual(post['classification'], 'verifiedsudo' if delta == -1 else 'unavailable')
                self.assertEqual(state.stat_reads, 2); self.assertEqual(state.closes, [8, 7, 9])

    def test_original_guard_evaluation_order_and_lookup_counts_are_unchanged(self):
        class Held(dict):
            def __contains__(self, key): events.append(('contains', key)); return super().__contains__(key)
            def __getitem__(self, key): events.append(('getitem', key)); return super().__getitem__(key)
        for pid, ids, expected, membership, kind in (
                (True, [1001, 0, 0, 0], [], None, None),
                (1686, [1001, 0, 0, 0], [('contains', 1686)], False, None),
                (21, [1001, 0, 0, 0], [('contains', 21), ('getitem', 21)], True, 'python'),
                (20, (1001, 0, 0, 0), [('contains', 20), ('getitem', 20)], True, 'sudo')):
            events = []
            chain = M.InvocationChain.__new__(M.InvocationChain)
            chain.held = Held({20: {'kind': 'sudo'}, 21: {'kind': 'python'}})
            with self.subTest(pid=pid), patch.object(M, 'capture_mixed_failure') as capture, \
                    patch.object(chain, 'recheck', side_effect=AssertionError('No retry/recheck after refusal')):
                with self.assertRaises(ValueError) as caught: chain.mixed_process(pid, ids)
                self.assertEqual(events, expected)
                capture.assert_called_once_with(caught.exception, chain, pid, ids, membership, kind)

    def test_snapshot_or_serialization_failure_cannot_replace_original_and_valid_calls_do_not_capture(self):
        with invocation_fixture() as state, M.InvocationChain(state.caller) as held, \
                patch.object(M, 'capture_mixed_failure') as capture:
            held.mixed_process(20, [1001, 0, 0, 0]); capture.assert_not_called()
        for function in ('mixed_post_failure', 'mixed_diagnostic'):
            with self.subTest(function=function), self.fixture() as state, \
                    patch.object(M, function, side_effect=OSError('PRIVATE_SECONDARY')):
                error = ValueError('PRIVATE_ORIGINAL')
                M.capture_mixed_failure(error, state.chain, 1686, [1001, 0, 0, 0], False, None)
                self.assertFalse(hasattr(error, 'proxy_mixed_diagnostic')); self.assertEqual(str(error), 'PRIVATE_ORIGINAL')

    def test_root_entry_gates_reads_after_source_admission_transports_typed_capture_and_resets_on_refusal(self):
        with self.fixture() as state:
            error, detail = self.capture(state)
        error.proxy_snapshot_stage = 'complete-uid-inventory'
        for source_fails in (False, True):
            output, events = io.StringIO(), []
            def protected(*args):
                self.assertFalse(M.ROOT_DIAGNOSTIC_ACTIVE); events.append('source')
                if source_fails: raise PermissionError('PRIVATE_SOURCE')
            def failed_probe(request):
                self.assertTrue(M.ROOT_DIAGNOSTIC_ACTIVE); events.append('probe'); raise error
            with self.subTest(source_fails=source_fails), ExitStack() as stack:
                stack.enter_context(patch.object(M, 'ROOT_DIAGNOSTIC_ACTIVE', False))
                for name in ('SIGALRM', 'ITIMER_REAL'): stack.enter_context(patch.object(M.signal, name, 0, create=True))
                for name in ('signal', 'setitimer'): stack.enter_context(patch.object(M.signal, name, create=True))
                for name in ('getuid', 'geteuid'): stack.enter_context(patch.object(M.os, name, return_value=0, create=True))
                stack.enter_context(patch.dict(M.os.environ, {'SUDO_UID': '1001'}))
                stack.enter_context(patch.object(M, 'PROXY_TOOL', Path(M.__file__)))
                stack.enter_context(patch.object(M.sys, 'argv', ['observer.py', 'root-inventory-probe']))
                stack.enter_context(patch.object(M.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b'{"codeSha256":"fixed"}'))))
                stack.enter_context(patch.object(M.sys, 'stdout', output))
                stack.enter_context(patch.object(M, 'probe_request'))
                stack.enter_context(patch.object(M, 'protected_tool', side_effect=protected))
                probe = stack.enter_context(patch.object(M, 'inventory_probe', side_effect=failed_probe))
                with self.assertRaises(SystemExit) as raised: M.root_snapshot_main()
                if not source_fails: self.assertIs(raised.exception.__context__, error)
                self.assertFalse(M.ROOT_DIAGNOSTIC_ACTIVE)
                self.assertEqual(probe.call_count, 0 if source_fails else 1)
            result = M.json.loads(output.getvalue())
            self.assertEqual(result['ok'], False)
            self.assertEqual(result.get('mixedFailure'), None if source_fails else detail)
            self.assertNotIn('PRIVATE', output.getvalue()); self.assertLess(len(output.getvalue()), 6144)

    def test_post_snapshot_has_no_sampling_retry_execution_or_candidate_content_read_calls(self):
        source = Path(M.__file__).read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'mixed_post_failure')
        text = ast.get_source_segment(source, node)
        self.assertFalse(any(isinstance(n, ast.While) for n in ast.walk(node)))
        for forbidden in ('readlink(', 'os.read(', 'os.pread(', 'subprocess', 'cmdline', 'environ', '.recheck(', 'sleep(', 'kill('):
            self.assertNotIn(forbidden, text)
        self.assertEqual(text.count("identity('before')"), 1); self.assertEqual(text.count("identity('after')"), 1)
        self.assertIn("InvocationImage('sudo', chain.budget)", text)


class ForeignSudoTests(unittest.TestCase):
    @contextmanager
    def fixture(self, kind='sudo'):
        caller = dict(pid=2490, parentPid=2484, startTime='4537', uids=[1001] * 4, executable='/usr/bin/python3.10')
        record = dict(pid=1629, parentPid=1616, startTime='1515', uids=[1001, 0, 0, 0], executable='/usr/bin/' + kind, state='S')
        state = SimpleNamespace(rows={1629: record}, exited=set(), replaced=set(), proc_replaced=set(), missing=set(),
            reads=[], links=[], closes=[], scans=0, clock=99, image_bad=False, close_bad=False, on_scan=None,
            kernel_kinds={1629: kind}, fd_rows={})
        systems = {'sudo': invocation_stat(4887, stat.S_IFREG | 0o4755, 232416),
                   'fusermount3': invocation_stat(4888, stat.S_IFREG | 0o4755, 35128)}
        directory = invocation_stat(8726, stat.S_IFDIR | 0o555, 0)
        def budget(): M.require(state.clock < 100)
        images = {}
        for image_kind, system in systems.items():
            def snapshot(image_kind=image_kind):
                budget(); M.require(not state.image_bad)
                return ('5b0e68c5523dff0c71aec912775d66fe8bc885f4778978489b2adc04c51ea715'
                        if image_kind == 'sudo' else 'f' * 64)
            images[image_kind] = SimpleNamespace(path='/usr/bin/' + image_kind, identity=M.ProxyAssociationProc.stamp(system),
                digest=snapshot(), snapshot=Mock(side_effect=snapshot), close=Mock())
        owned = {2492: dict(pid=2492, parentPid=2491, startTime='4546', uids=[0] * 4, executable='/usr/bin/python3.10', state='R'),
                 2491: dict(pid=2491, parentPid=2490, startTime='4545', uids=[1001, 0, 0, 0], executable='/usr/bin/sudo', state='S'),
                 2490: {**caller, 'state': 'S'}}
        chain_class = M.InvocationChain
        invocation = SimpleNamespace(held={pid: dict(row=row, kind='sudo' if pid == 2491 else 'python') for pid, row in owned.items()},
                                     recheck=Mock(), process=chain_class.process)
        invocation.mixed_process = Mock(side_effect=lambda pid, ids: chain_class.mixed_process(invocation, pid, ids))
        invocation.receipt = Mock(return_value=[{**{k: owned[pid][k] for k in ('pid', 'parentPid', 'startTime', 'uids', 'state')},
            'executableKind': kind, 'imageSha256': ('a' if kind == 'python' else 'b') * 64} for pid, kind in ((2492, 'python'), (2491, 'sudo'))])
        state.invocation, state.caller, state.image, state.budget = invocation, caller, images[kind], budget
        state.images = images
        def opened(name, flags, **kw):
            if name == 'exe':
                pid = state.fd_rows[kw['dir_fd']][0]; fd = 20000 + pid
                state.fd_rows[fd] = (pid, True); return fd
            self.assertTrue(str(name).startswith('/proc/'))
            pid = int(str(name).rsplit('/', 1)[1]); fd = 10000 + pid
            state.fd_rows[fd] = (pid, False); return fd
        def fstat(fd):
            pid, kernel = state.fd_rows[fd]
            if pid in state.missing: raise FileNotFoundError('PRIVATE_PROC')
            value = systems[state.kernel_kinds.get(pid, kind)] if kernel else directory
            return invocation_stat(999, value.st_mode, value.st_size) if kernel and pid in state.replaced else value
        def named(name, **kw):
            if name == 'exe': return fstat(kw['dir_fd'] + 10000)
            pid = int(str(name).rsplit('/', 1)[1])
            return invocation_stat(999, directory.st_mode, 0) if pid in state.proc_replaced else fstat(10000 + pid)
        def read(fd, name, maximum):
            pid = fd - 10000; state.reads.append((pid, name))
            if pid in state.missing: raise FileNotFoundError('PRIVATE_PROC')
            row = state.rows[pid]
            if name == 'stat':
                return (f'{pid} (PRIVATE_COMM) {row["state"]} {row["parentPid"]} ' + '0 ' * 17 + row['startTime'] + '\n').encode(), []
            self.assertEqual(name, 'status')
            return ('Uid:\t' + ' '.join(map(str, row['uids'])) + '\n').encode(), []
        def linked(name, *, dir_fd):
            self.assertEqual(name, 'exe'); state.links.append(dir_fd - 10000); return state.rows[dir_fd - 10000]['executable']
        def closed(fd):
            state.closes.append(fd)
            if state.close_bad: raise OSError('PRIVATE_CLOSE')
        @contextmanager
        def scan(path):
            self.assertEqual(path, '/proc'); state.scans += 1
            if state.on_scan is not None: state.on_scan(state.scans)
            yield [SimpleNamespace(name=str(pid), stat=lambda **kw: directory) for pid in (*owned, *state.rows)]
        with ExitStack() as stack:
            for name in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_NONBLOCK'):
                stack.enter_context(patch.object(M.os, name, 0, create=True))
            state.factory = stack.enter_context(patch.object(M, 'InvocationImage', side_effect=lambda image_kind, budget: images[image_kind]))
            state.pidfd = stack.enter_context(patch.object(M.os, 'pidfd_open', side_effect=lambda pid: 30000 + pid, create=True))
            state.opens = stack.enter_context(patch.object(M.os, 'open', side_effect=opened))
            stack.enter_context(patch.object(M.os, 'fstat', side_effect=fstat))
            stack.enter_context(patch.object(M.os, 'stat', side_effect=named))
            stack.enter_context(patch.object(M.os, 'readlink', side_effect=linked))
            stack.enter_context(patch.object(M.os, 'close', side_effect=closed))
            stack.enter_context(patch.object(M.os, 'read', side_effect=AssertionError('No foreign content')))
            stack.enter_context(patch.object(M.os, 'pread', side_effect=AssertionError('No foreign content'), create=True))
            stack.enter_context(patch.object(M.ProxyAssociationProc, 'read_at', side_effect=read))
            stack.enter_context(patch.object(M.select, 'select', side_effect=lambda fds, *_: ([fd for fd in fds if fd - 30000 in state.exited], [], [])))
            stack.enter_context(patch.object(M.os, 'scandir', side_effect=scan))
            stack.enter_context(patch.object(M, 'root_uid_tuple', side_effect=lambda pid: owned[pid]['uids'] if pid in owned else state.rows[pid]['uids']))
            stack.enter_context(patch.object(M, 'root_process', side_effect=lambda pid: copy.deepcopy(caller if pid == 2490 else {k: v for k, v in state.rows[pid].items() if k != 'state'})))
            yield state

    def test_recorded_fusermount3_is_counted_but_never_invocation_proxy_or_input_authority(self):
        with self.fixture('fusermount3') as state:
            state.rows = {12585: dict(pid=12585, parentPid=12580, startTime='14649', state='S',
                uids=[1001, 0, 0, 0], executable='/usr/bin/fusermount3'),
                40: dict(pid=40, parentPid=1, startTime='40', state='S', uids=[1001] * 4, executable='/usr/bin/xdg-dbus-proxy')}
            self.assertEqual(M.hashlib.sha256(state.rows[12585]['executable'].encode()).hexdigest(),
                '8d282fa1bb15ebecf8211d9592a3daeba380ac27fd9264f98b9ca0fad41fe8c1')
            owned = copy.deepcopy(state.invocation.held)
            with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                candidates, rows = M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                self.assertEqual(candidates, [40]); self.assertIn(12585, rows); self.assertEqual(state.scans, 2)
                self.assertEqual(rows[12585], {k: v for k, v in state.rows[12585].items() if k != 'state'})
                self.assertEqual(state.invocation.held, owned); self.assertEqual(set(foreign.held), {12585})
                state.factory.assert_called_once_with('fusermount3', state.budget)
                with self.assertRaises(ValueError): state.invocation.mixed_process(12585, [1001, 0, 0, 0])
            state.image.close.assert_called_once()
        state = RootAssociationTests().fixture()
        state.data['proxy']['executable'] = '/usr/bin/fusermount3'
        with self.assertRaises(ValueError): state.build_associated()

    def test_sudo_and_fuse_share_the_same_cap_and_hold_distinct_protected_images(self):
        with self.fixture() as state:
            state.rows[12585] = {**state.rows[1629], 'pid': 12585, 'executable': '/usr/bin/fusermount3'}
            state.kernel_kinds[12585] = 'fusermount3'
            with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                candidates, rows = M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                self.assertEqual(candidates, []); self.assertEqual(set(rows), {2490, 2491, 1629, 12585})
                self.assertEqual(set(foreign.held), {1629, 12585}); self.assertEqual(foreign.MAX_ROWS, 4)
                self.assertEqual([call.args[0] for call in state.factory.call_args_list], ['sudo', 'fusermount3'])
            for image in state.images.values(): image.close.assert_called_once()

    def test_combined_sudo_fuse_cap_cannot_be_doubled_and_closes_both_images(self):
        with self.fixture() as state:
            with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                for pid, kind in ((1629, 'sudo'), (1630, 'fusermount3'), (1631, 'sudo'), (1632, 'fusermount3')):
                    state.rows[pid] = {**state.rows[1629], 'pid': pid, 'executable': '/usr/bin/' + kind}
                    state.kernel_kinds[pid] = kind
                    foreign.observe(pid, [1001, 0, 0, 0])
                opened = state.opens.call_count
                with self.assertRaises(ValueError): foreign.observe(1633, [1001, 0, 0, 0])
                self.assertEqual(state.opens.call_count, opened); self.assertEqual(len(foreign.held), 4)
            self.assertEqual(len(state.closes), 12)
            for image in state.images.values(): image.close.assert_called_once()

    def test_fuse_image_cleanup_uncertainty_keeps_the_original_error_and_closes_sudo(self):
        for original in (None, ValueError('PRIVATE_ORIGINAL')):
            with self.subTest(original=original), self.fixture() as state:
                state.rows[1630] = {**state.rows[1629], 'pid': 1630, 'executable': '/usr/bin/fusermount3'}
                state.kernel_kinds[1630] = 'fusermount3'
                state.images['fusermount3'].close.side_effect = OSError('PRIVATE_CLOSE')
                with self.assertRaises(OSError if original is None else ValueError) as caught:
                    with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                        foreign.observe(1629, [1001, 0, 0, 0]); foreign.observe(1630, [1001, 0, 0, 0])
                        if original is not None: raise original
                if original is not None: self.assertIs(caught.exception, original)
                self.assertTrue(caught.exception.invocation_cleanup_failed)
                detail = getattr(caught.exception, 'proxy_foreign_diagnostic', None)
                if detail is not None: self.assertIsNot(detail['cleanupConfirmed'], True)
                self.assertEqual(len(state.closes), 6)
                for image in state.images.values(): image.close.assert_called_once()

    def test_fuse_path_cannot_substitute_sudo_or_an_unverified_kernel_image(self):
        for failure in ('sudo-image', 'replaced', 'selection-race'):
            with self.subTest(failure=failure), self.fixture('fusermount3') as state:
                if failure == 'sudo-image': state.kernel_kinds[1629] = 'sudo'
                if failure == 'replaced': state.replaced.add(1629)
                linked = M.os.readlink.side_effect
                calls = []
                def changed(name, **kw):
                    calls.append(name)
                    return '/usr/bin/sudo' if len(calls) > 1 else linked(name, **kw)
                with patch.object(M.os, 'readlink', side_effect=changed) if failure == 'selection-race' else ExitStack():
                    with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                        with self.assertRaises(ValueError): foreign.observe(1629, [1001, 0, 0, 0])
                state.image.close.assert_called_once(); state.invocation.mixed_process.assert_not_called()

    def test_fuse_second_scan_and_final_recheck_refuse_drift_without_skipping(self):
        for failure in ('uid', 'parent', 'start', 'path', 'kernel', 'proc-name', 'exit', 'gone', 'zombie', 'package', 'deadline'):
            for boundary in ('scan-two', 'final-recheck'):
                with self.subTest(failure=failure, boundary=boundary), self.fixture('fusermount3') as state:
                    def change():
                        if failure == 'uid': state.rows[1629]['uids'] = [1001] * 4
                        if failure == 'parent': state.rows[1629]['parentPid'] += 1
                        if failure == 'start': state.rows[1629]['startTime'] = '999'
                        if failure == 'path': state.rows[1629]['executable'] = '/usr/bin/sudo'
                        if failure == 'kernel': state.replaced.add(1629)
                        if failure == 'proc-name': state.proc_replaced.add(1629)
                        if failure == 'exit': state.exited.add(1629)
                        if failure == 'gone': state.missing.add(1629)
                        if failure == 'zombie': state.rows[1629]['state'] = 'Z'
                        if failure == 'package': state.image_bad = True
                        if failure == 'deadline': state.clock = 100
                    with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                        if boundary == 'scan-two':
                            state.on_scan = lambda number: change() if number == 2 else None
                            with self.assertRaises((ValueError, FileNotFoundError)):
                                M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                        else:
                            M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                            change()
                            with self.assertRaises((ValueError, FileNotFoundError)): foreign.recheck()
                    state.image.close.assert_called_once()

    def test_fixed_foreign_image_selection_never_opens_an_unknown_package_or_alias(self):
        for path in ('/usr/bin/false', '/bin/fusermount3', '/usr/bin/fusermount3 (deleted)', '/PRIVATE/fusermount3'):
            with self.subTest(path=path), self.fixture('fusermount3') as state:
                state.rows[1629]['executable'] = path
                with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                    with self.assertRaises(ValueError): foreign.observe(1629, [1001, 0, 0, 0])
                state.factory.assert_not_called()
                self.assertEqual(state.closes, [11629, 31629])

    def test_fuse_does_not_expand_invocation_kinds_or_start_sender_authority(self):
        with invocation_fixture() as state:
            chain = M.InvocationChain.__new__(M.InvocationChain)
            with self.assertRaises(ValueError): chain.retain(1629, 'fusermount3', caller=False)
            self.assertEqual(state.reads, []); self.assertEqual(state.events, [])
        state = RootAssociationTests().fixture(); baseline = state.build_associated(); baseline.begin_input()
        try:
            value = baseline.observe(':1.40', lambda name: dict(name=name, pid=12585, uid=1001), budget=lambda: None)
            self.assertFalse(value['stable']); self.assertFalse(value['inputPermitted']); self.assertFalse(value['qualified'])
            self.assertEqual(value['failureStage'], 'live-sender-credentials')
        finally: baseline.close()

    def test_fuse_probe_receipt_remains_non_authorizing_and_excludes_foreign_invocation(self):
        with self.fixture('fusermount3') as state, patch.object(M.Path, 'resolve', return_value='/usr/bin/python3.10'), patch.object(M, 'InvocationChain') as chain:
            chain.return_value.__enter__.return_value = state.invocation
            request = dict(schemaVersion=1, operation=M.PROBE_OPERATION, harnessSource='a' * 40, codeSha256='b' * 64,
                sequence=1, nonce='c' * 64, expiresNs=100, caller=state.caller)
            value = M.inventory_probe(request, clock=lambda: state.clock)
            M.validate_probe(value, request)
            self.assertEqual(value['candidateCount'], 0); self.assertEqual(value['scopedProcessCount'], 3)
            self.assertEqual([r['pid'] for r in value['invocation']], [2492, 2491])
            for key in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[key], False)

    def test_recorded_foreign_sudo_is_fully_counted_but_never_invocation_candidate_or_authority(self):
        with self.fixture() as state:
            state.rows[40] = dict(pid=40, parentPid=1, startTime='40', uids=[1001] * 4, executable='/usr/bin/xdg-dbus-proxy', state='S')
            owned = copy.deepcopy(state.invocation.held)
            with self.assertRaises(ValueError): state.invocation.mixed_process(1629, [1001, 0, 0, 0])
            state.invocation.mixed_process.reset_mock()
            with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                candidates, rows = M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                self.assertEqual(candidates, [40]); self.assertEqual(set(rows), {2490, 2491, 1629, 40}); self.assertEqual(state.scans, 2)
                self.assertEqual(rows[1629], {k: v for k, v in state.rows[1629].items() if k != 'state'})
                self.assertEqual(set(foreign.held), {1629}); self.assertEqual(state.invocation.held, owned)
                self.assertEqual([call.args[0] for call in state.invocation.mixed_process.call_args_list], [2491, 2491])
                self.assertEqual(state.closes, [])
                foreign.recheck(); self.assertEqual(state.closes, [])
                state.factory.assert_called_once_with('sudo', state.budget)
            self.assertEqual(state.closes, [21629, 11629, 31629]); state.image.close.assert_called_once()
            self.assertEqual(state.invocation.held, owned)
            with self.assertRaises(ValueError): state.invocation.mixed_process(1629, [1001, 0, 0, 0])
        state = RootAssociationTests().fixture()
        state.data['proxy']['uids'] = [1001, 0, 0, 0]
        with self.assertRaises(ValueError): state.build_associated()

    def test_only_exact_unheld_numeric_uid_tuple_can_open_a_foreign_observation(self):
        for pid, ids in ((2490, [1001, 0, 0, 0]), (True, [1001, 0, 0, 0]),
                         (1629, [0] * 4), (1629, [1001] * 4), (1629, [1001, False, 0, 0]),
                         (1629, [1002, 0, 0, 0]), (1629, [1001, 0, 1001, 0]), (1629, (1001, 0, 0, 0))):
            with self.subTest(pid=pid, ids=ids), self.fixture() as state, M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                with self.assertRaises(ValueError): foreign.observe(pid, ids)
                state.opens.assert_not_called(); state.pidfd.assert_not_called(); state.factory.assert_not_called()

    def test_observed_foreign_pid_cannot_become_a_start_sender_even_with_the_same_reported_uid(self):
        state = RootAssociationTests().fixture(); baseline = state.build_associated(); baseline.begin_input()
        try:
            value = baseline.observe(':1.40', lambda name: dict(name=name, pid=1629, uid=1001), budget=lambda: None)
            self.assertFalse(value['stable']); self.assertFalse(value['inputPermitted']); self.assertFalse(value['qualified'])
            self.assertEqual(value['failureStage'], 'live-sender-credentials')
        finally: baseline.close()

    def test_uid_pid_parent_start_image_named_proc_exit_and_disappearance_drift_all_refuse(self):
        for failure in ('uid', 'parent', 'start', 'exe', 'kernel', 'proc-name', 'exit', 'gone', 'zombie', 'package', 'deadline'):
            with self.subTest(failure=failure), self.fixture() as state, M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                foreign.observe(1629, [1001, 0, 0, 0])
                if failure == 'uid': state.rows[1629]['uids'] = [1001] * 4
                if failure == 'parent': state.rows[1629]['parentPid'] = 999
                if failure == 'start': state.rows[1629]['startTime'] = '999'
                if failure == 'exe': state.rows[1629]['executable'] = '/PRIVATE/foreign'
                if failure == 'kernel': state.replaced.add(1629)
                if failure == 'proc-name': state.proc_replaced.add(1629)
                if failure == 'exit': state.exited.add(1629)
                if failure == 'gone': state.missing.add(1629)
                if failure == 'zombie': state.rows[1629]['state'] = 'Z'
                if failure == 'package': state.image_bad = True
                if failure == 'deadline': state.clock = 100
                with self.assertRaises((ValueError, FileNotFoundError)): foreign.recheck()

    def test_initial_unknown_image_and_unreadable_subject_are_never_adopted(self):
        for failure in ('exe', 'kernel', 'gone', 'permission'):
            with self.subTest(failure=failure), self.fixture() as state, M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                if failure == 'exe': state.rows[1629]['executable'] = '/PRIVATE/foreign'
                if failure == 'kernel': state.replaced.add(1629)
                if failure == 'gone': state.missing.add(1629)
                with patch.object(M.ProxyAssociationProc, 'read_at', side_effect=PermissionError()) if failure == 'permission' else ExitStack():
                    with self.assertRaises((ValueError, FileNotFoundError, PermissionError)): foreign.observe(1629, [1001, 0, 0, 0])
                state.invocation.mixed_process.assert_not_called()

    def test_second_complete_scan_never_skips_churn_or_changed_foreign_rows(self):
        for failure in ('missing', 'new', 'uid', 'start'):
            with self.subTest(failure=failure), self.fixture() as state, M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                def change(number):
                    if number != 2: return
                    if failure == 'missing': del state.rows[1629]
                    if failure == 'new': state.rows[1630] = {**state.rows[1629], 'pid': 1630, 'startTime': '1516'}
                    if failure == 'uid': state.rows[1629]['uids'] = [1001] * 4
                    if failure == 'start': state.rows[1629]['startTime'] = '1516'
                state.on_scan = change
                with self.assertRaises((ValueError, KeyError)): M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)

    def test_foreign_fd_budget_and_closed_holder_refuse_without_reopening_or_retry(self):
        with self.fixture() as state:
            foreign = M.ForeignSudoObservations(state.invocation, state.budget)
            with foreign:
                for pid in range(1629, 1629 + foreign.MAX_ROWS):
                    state.rows[pid] = {**state.rows[1629], 'pid': pid}; foreign.observe(pid, [1001, 0, 0, 0])
                count = state.opens.call_count
                with self.assertRaises(ValueError): foreign.observe(99, [1001, 0, 0, 0])
                self.assertEqual(state.opens.call_count, count)
            foreign.close(); self.assertEqual(len(state.closes), foreign.MAX_ROWS * 3)
            with self.assertRaises(ValueError): foreign.recheck()
            with self.assertRaises(ValueError): foreign.observe(1629, [1001, 0, 0, 0])

    def test_cleanup_uncertainty_blocks_success_and_preserves_an_original_error(self):
        for original in (None, PermissionError('PRIVATE_ORIGINAL')):
            with self.subTest(original=original), self.fixture() as state:
                foreign = M.ForeignSudoObservations(state.invocation, state.budget)
                with self.assertRaises(OSError if original is None else PermissionError) as caught:
                    with foreign:
                        foreign.observe(1629, [1001, 0, 0, 0]); state.close_bad = True
                        if original is not None: raise original
                if original is not None: self.assertIs(caught.exception, original)
                self.assertTrue(caught.exception.invocation_cleanup_failed)
                self.assertEqual(state.closes, [21629, 11629, 31629]); state.image.close.assert_called_once()

    def test_deadline_boundary_and_post_inventory_identity_drift_stay_strict(self):
        for clock in (99, 100, 101):
            with self.subTest(clock=clock), self.fixture() as state, M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                state.clock = clock
                if clock == 99: foreign.recheck()
                else:
                    with self.assertRaises(ValueError): foreign.recheck()
        with self.fixture() as state, M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
            M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
            state.rows[1629]['parentPid'] += 1
            with self.assertRaises(ValueError): foreign.recheck()

    def test_final_request_rechecks_foreign_state_and_does_not_extend_snapshot_deadline(self):
        state = RootAssociationTests().fixture()
        with patch.object(M, 'ForeignSudoObservations') as holder:
            observed = holder.return_value.__enter__.return_value
            observed.recheck.side_effect = [None] * 4 + [ValueError('final foreign recheck')]
            with self.assertRaisesRegex(ValueError, 'final foreign recheck'): RootAssociationTests().run_snapshot(state)
            self.assertEqual(observed.recheck.call_count, 5)
            holder.return_value.__exit__.assert_called_once()

    def test_actual_probe_path_keeps_foreign_row_out_of_receipt_and_all_authority_flags_false(self):
        with self.fixture() as state, patch.object(M.Path, 'resolve', return_value='/usr/bin/python3.10'), patch.object(M, 'InvocationChain') as chain:
            chain.return_value.__enter__.return_value = state.invocation
            request = dict(schemaVersion=1, operation=M.PROBE_OPERATION, harnessSource='a' * 40, codeSha256='b' * 64,
                sequence=1, nonce='c' * 64, expiresNs=100, caller=state.caller)
            value = M.inventory_probe(request, clock=lambda: state.clock)
            M.validate_probe(value, request)
            self.assertEqual(value['candidateCount'], 0); self.assertEqual(value['scopedProcessCount'], 3)
            self.assertEqual([r['pid'] for r in value['invocation']], [2492, 2491]); self.assertEqual(state.scans, 2)
            for key in ('inputPermitted', 'authorityGranted', 'releaseReady'): self.assertIs(value[key], False)
            self.assertEqual(state.closes, [21629, 11629, 31629, 32490]); state.image.close.assert_called_once()

    def test_real_fixed_image_constructor_and_full_hash_checks_are_used_without_foreign_content_reads(self):
        image_class = M.InvocationImage
        for kind in ('sudo', 'fusermount3'):
            with self.subTest(kind=kind), self.fixture(kind) as state:
                self.real_fixed_foreign_image(state, kind, image_class)

    def real_fixed_foreign_image(self, state, kind, image_class):
        proc_open, proc_fstat, proc_stat, proc_close = M.os.open.side_effect, M.os.fstat.side_effect, M.os.stat.side_effect, M.os.close.side_effect
        with InvocationImageTests().fixture(kind) as package:
            package_open, package_fstat, package_stat, package_read = M.os.open.side_effect, M.os.fstat.side_effect, M.os.stat.side_effect, M.os.pread.side_effect
            def opened(name, flags, **kw):
                return (proc_open if name == 'exe' or str(name).startswith('/proc/') else package_open)(name, flags, **kw)
            def fstat(fd): return package.file if fd == 21629 else proc_fstat(fd) if fd >= 10000 else package_fstat(fd)
            def named(name, **kw):
                return package.file if name == 'exe' else proc_stat(name, **kw) if str(name).startswith('/proc/') else package_stat(name, **kw)
            def read(fd, count, offset): self.assertEqual(fd, 4); return package_read(fd, count, offset)
            package.close.side_effect = lambda fd: proc_close(fd) if fd >= 10000 else None
            with patch.object(M, 'InvocationImage', image_class), patch.object(M.os, 'open', side_effect=opened), \
                    patch.object(M.os, 'fstat', side_effect=fstat), patch.object(M.os, 'stat', side_effect=named), \
                    patch.object(M.os, 'pread', side_effect=read):
                with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                    foreign.observe(1629, [1001, 0, 0, 0]); foreign.recheck()
                    self.assertIsInstance(foreign.image, image_class)
                    self.assertEqual(foreign.image.digest, M.hashlib.sha256(package.raw).hexdigest())
            self.assertGreater(len(package.reads), 2); self.assertEqual(state.closes, [21629, 11629, 31629])
            self.assertEqual([c.args[0] for c in package.close.call_args_list], [21629, 11629, 31629, 4, 3, 2, 1])

    def test_no_retry_signals_command_environment_or_candidate_content_reads_in_foreign_holder(self):
        source = Path(M.__file__).read_text(); tree = ast.parse(source)
        node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ForeignSudoObservations')
        text = ast.get_source_segment(source, node)
        self.assertFalse(any(isinstance(n, ast.While) for n in ast.walk(node)))
        for forbidden in ('os.read(', 'os.pread(', 'subprocess', 'cmdline', 'environ', 'sleep(', 'kill(', '.retain(', 'mixed_post_failure('):
            self.assertNotIn(forbidden, text)
        self.assertIn("kinds = {'/usr/bin/sudo': 'sudo', '/usr/bin/fusermount3': 'fusermount3'}", text)
        self.assertIn("InvocationImage(kind, self.budget)", text)

    def test_foreign_cap_diagnostic_has_exact_count_member_uid_and_no_unreached_image_claim(self):
        with self.fixture() as state:
            for pid in range(1630, 1634): state.rows[pid] = {**state.rows[1629], 'pid': pid}
            with self.assertRaises(ValueError) as caught:
                with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                    M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
            detail = caught.exception.proxy_foreign_diagnostic
            self.assertEqual((detail['function'], detail['stage'], detail['heldCount'], detail['limit']),
                             ('ForeignSudoObservations.observe', 'cap', 4, 4))
            self.assertEqual(detail['subject'], dict(pid=1633, parentPid=None, startTime=None,
                uids=[1001, 0, 0, 0], state=None, executableKind='unread', executablePathSha256=None))
            self.assertIs(detail['invocationMember'], False); self.assertIs(detail['foreignMember'], False)
            self.assertTrue(detail['cleanupConfirmed']); self.assertEqual(state.pidfd.call_count, 4)
            self.assertEqual(caught.exception.proxy_inventory_diagnostic['entryPid'], 1633)
            self.assertNotIn('PRIVATE', M.json.dumps(detail)); self.assertLess(len(M.json.dumps(detail)), 8192)
            self.assertTrue(Path(M.__file__).read_text().splitlines()[detail['line'] - 1].strip().startswith('require((_f_count'))

    def test_foreign_diagnostic_distinguishes_kernel_proc_live_and_process_failures_without_extra_reads(self):
        cases = (('exe', 'protected-image'), ('kernel', 'kernel-identity'), ('proc', 'proc-before'),
                 ('exit', 'pidfd-live'), ('zombie', 'process-shape'), ('uid', 'process-shape'), ('permission', 'stat-read'))
        for case, stage in cases:
            with self.subTest(case=case), self.fixture() as state:
                if case == 'exe': state.rows[1629]['executable'] = '/PRIVATE/foreign'
                if case == 'kernel': state.replaced.add(1629)
                if case == 'proc': state.proc_replaced.add(1629)
                if case == 'exit': state.exited.add(1629)
                if case == 'zombie': state.rows[1629]['state'] = 'Z'
                if case == 'uid': state.rows[1629]['uids'] = [1001] * 4
                read_error = PermissionError('PRIVATE_ORIGINAL')
                with patch.object(M.ProxyAssociationProc, 'read_at', side_effect=read_error) if case == 'permission' else ExitStack():
                    with self.assertRaises((ValueError, PermissionError)) as caught:
                        with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                            if case == 'uid': foreign.observe(1629, [1001, 0, 0, 0])  # Status changed since the entry UID read.
                            else: M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                detail = caught.exception.proxy_foreign_diagnostic
                self.assertEqual(detail['stage'], stage); self.assertTrue(detail['cleanupConfirmed'])
                self.assertEqual(detail['subject']['pid'], 1629)
                self.assertNotIn('PRIVATE', M.json.dumps(detail))
                self.assertEqual(state.opens.call_count, 0 if case == 'exit' else 1 if case == 'exe' else 2)
                self.assertEqual(state.reads, [] if case in ('proc', 'exit', 'permission', 'exe') else [(1629, 'stat'), (1629, 'status')])
                self.assertEqual(state.links, [] if case == 'exit' else [1629, 1629] if case == 'kernel' else [1629])
                if case == 'exe':
                    self.assertFalse(detail['checks']['executable_match'])
                    self.assertEqual(detail['subject']['executableKind'], 'other')
                    self.assertEqual(detail['subject']['executablePathSha256'], M.hashlib.sha256(b'/PRIVATE/foreign').hexdigest())
                    self.assertIsNone(detail['stamps']['kernelHeld'])
                if case == 'kernel':
                    self.assertEqual(detail['subject']['executableKind'], 'sudo')
                    self.assertNotEqual(detail['stamps']['kernelHeld'], detail['stamps']['protectedImage'])
                    self.assertIsNone(detail['stamps']['kernelNamed'])
                if case == 'proc': self.assertNotEqual(detail['stamps']['procHeldBefore'], detail['stamps']['procNamedBefore'])
                if case == 'zombie': self.assertFalse(detail['checks']['state'])
                if case == 'uid': self.assertFalse(detail['checks']['uids']); self.assertNotIn('state', detail['checks'])
                if case == 'permission': self.assertIs(caught.exception, read_error)

    def test_foreign_row_mutation_is_distinct_and_first_failure_is_not_overwritten_by_cleanup(self):
        with self.fixture() as state:
            def changed(number):
                if number == 2: state.rows[1629]['parentPid'] = 999
            state.on_scan = changed
            with self.assertRaises(ValueError) as caught:
                with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                    M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
            detail = caught.exception.proxy_foreign_diagnostic
            self.assertEqual((detail['stage'], detail['subject']['parentPid']), ('row-recheck', 999))
            self.assertFalse(detail['checks']['row_match']); self.assertTrue(detail['cleanupConfirmed'])
            before = copy.deepcopy(detail)
            with patch.object(M, 'foreign_diagnostic', side_effect=AssertionError('No second capture')):
                M.capture_foreign_failure(caught.exception)
            self.assertEqual(caught.exception.proxy_foreign_diagnostic, before)

    def test_foreign_close_failure_retains_first_refusal_and_cleanup_uncertainty(self):
        for original in (False, True):
            with self.subTest(original=original), self.fixture() as state:
                with self.assertRaises((ValueError, OSError)) as caught:
                    with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                        foreign.observe(1629, [1001, 0, 0, 0]); state.close_bad = True
                        if original:
                            state.rows[1629]['state'] = 'Z'; foreign.recheck()
                detail = caught.exception.proxy_foreign_diagnostic
                self.assertEqual(detail['stage'], 'process-shape' if original else 'close')
                self.assertFalse(detail['cleanupConfirmed']); self.assertTrue(caught.exception.invocation_cleanup_failed)
                self.assertEqual(state.closes, [21629, 11629, 31629]); state.image.close.assert_called_once()

    def test_foreign_diagnostic_failure_never_masks_original_or_repeats_proc_reads(self):
        with self.fixture() as state, patch.object(M, 'foreign_diagnostic', side_effect=TypeError('PRIVATE_SERIALIZE')):
            state.rows[1629]['state'] = 'Z'
            with self.assertRaises(ValueError) as caught:
                with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                    M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
            self.assertFalse(hasattr(caught.exception, 'proxy_foreign_diagnostic'))
            self.assertEqual(caught.exception.proxy_inventory_diagnostic['entryPid'], 1629)
        self.assertEqual(state.reads, [(1629, 'stat'), (1629, 'status')]); self.assertEqual(state.links, [1629])

    def test_foreign_original_probe_budget_boundary_uses_one_existing_clock_read(self):
        with self.fixture() as state, patch.object(M.Path, 'resolve', return_value='/usr/bin/python3.10'), patch.object(M, 'InvocationChain') as chain:
            chain.return_value.__enter__.return_value = state.invocation
            clock = Mock(side_effect=[99, 99, 100])  # request, empty-holder pre-scan check, first observe
            request = dict(schemaVersion=1, operation=M.PROBE_OPERATION, harnessSource='a' * 40, codeSha256='b' * 64,
                sequence=1, nonce='c' * 64, expiresNs=100, caller=state.caller)
            with self.assertRaises(ValueError) as caught: M.inventory_probe(request, clock=clock)
            detail = caught.exception.proxy_foreign_diagnostic
            self.assertEqual(detail['clock'], dict(nowNs=100, expiresNs=100))
            self.assertEqual(detail['function'], 'inventory_probe.budget'); self.assertEqual(clock.call_count, 3)
            self.assertIsNone(detail['heldCount']); self.assertTrue(detail['cleanupConfirmed'])
            state.factory.assert_not_called(); state.pidfd.assert_called_once_with(state.caller['pid'])

    def test_foreign_real_protected_image_failure_keeps_named_held_stamps_and_constructor_cleanup_marker(self):
        image_class = M.InvocationImage
        for cleanup_fails in (False, True):
            with self.subTest(cleanup_fails=cleanup_fails), self.fixture() as state:
                proc_open, proc_fstat, proc_stat, proc_close = M.os.open.side_effect, M.os.fstat.side_effect, M.os.stat.side_effect, M.os.close.side_effect
                with InvocationImageTests().fixture() as package:
                    package_open, package_fstat, package_stat = M.os.open.side_effect, M.os.fstat.side_effect, M.os.stat.side_effect
                    def opened(name, flags, **kw):
                        return (proc_open if name == 'exe' or str(name).startswith('/proc/') else package_open)(name, flags, **kw)
                    def fstat(fd): return proc_fstat(fd) if fd >= 10000 else package_fstat(fd)
                    def named(name, **kw):
                        result = (proc_stat if name == 'exe' or str(name).startswith('/proc/') else package_stat)(name, **kw)
                        if str(name) == 'sudo': return invocation_stat(999, result.st_mode, result.st_size)
                        return result
                    def closed(fd):
                        if fd >= 10000: return proc_close(fd)
                        if cleanup_fails: raise OSError('PRIVATE_IMAGE_CLOSE')
                    package.close.side_effect = closed
                    with patch.object(M, 'InvocationImage', image_class), patch.object(M.os, 'open', side_effect=opened), \
                            patch.object(M.os, 'fstat', side_effect=fstat), patch.object(M.os, 'stat', side_effect=named):
                        with self.assertRaises(ValueError) as caught:
                            with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                                M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
                    detail = caught.exception.proxy_foreign_diagnostic
                    self.assertEqual((detail['function'], detail['stage']), ('InvocationImage.check', 'image-file'))
                    self.assertNotEqual(detail['stamps']['protectedImage'], detail['stamps']['protectedNamed'])
                    self.assertEqual(detail['stamps']['fileObserved'], detail['stamps']['protectedImage'])
                    self.assertEqual(detail['cleanupConfirmed'], not cleanup_fails)
                    self.assertEqual(package.reads, []); self.assertEqual(state.reads, []); self.assertEqual(state.links, [1629])
                    self.assertEqual(state.closes, [11629, 31629]); self.assertNotIn('PRIVATE', M.json.dumps(detail))

    def test_foreign_refusal_root_serialization_keeps_original_context_and_all_cached_metadata(self):
        with self.fixture() as state:
            state.rows[1629]['executable'] = '/usr/bin/bwrap'
            with self.assertRaises(ValueError) as caught:
                with M.ForeignSudoObservations(state.invocation, state.budget) as foreign:
                    M.complete_uid_inventory(state.budget, invocation=state.invocation, foreign=foreign)
        error, output = caught.exception, io.StringIO()
        with ExitStack() as stack:
            for name in ('SIGALRM', 'ITIMER_REAL'): stack.enter_context(patch.object(M.signal, name, 0, create=True))
            for name in ('signal', 'setitimer'): stack.enter_context(patch.object(M.signal, name, create=True))
            for name in ('getuid', 'geteuid'): stack.enter_context(patch.object(M.os, name, return_value=0, create=True))
            stack.enter_context(patch.dict(M.os.environ, {'SUDO_UID': '1001'}))
            stack.enter_context(patch.object(M, 'PROXY_TOOL', Path(M.__file__)))
            stack.enter_context(patch.object(M.sys, 'argv', ['observer.py', 'root-inventory-probe']))
            stack.enter_context(patch.object(M.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b'{"codeSha256":"fixed"}'))))
            stack.enter_context(patch.object(M.sys, 'stdout', output)); stack.enter_context(patch.object(M, 'probe_request'))
            stack.enter_context(patch.object(M, 'protected_tool')); stack.enter_context(patch.object(M, 'inventory_probe', side_effect=error))
            with self.assertRaises(SystemExit) as raised: M.root_snapshot_main()
            self.assertIs(raised.exception.__context__, error)
        value = M.json.loads(output.getvalue())
        self.assertFalse(value['ok']); self.assertEqual(value['foreignFailure'], error.proxy_foreign_diagnostic)
        self.assertEqual(value['foreignFailure']['subject']['executableKind'], 'bwrap')
        self.assertFalse(value['foreignFailure']['authorityGranted']); self.assertNotIn('PRIVATE', output.getvalue())
        self.assertLess(len(output.getvalue().encode()), 16384)

    def test_foreign_policy_preserves_shared_inventory_and_diagnostic_read_contracts(self):
        # Unchanged inventory/association ASTs remain bound to the retained 29515016 source.
        # The fixed sudo/FUSE image policy is exercised separately, not falsely asserted unchanged.
        expected = {'inventory_probe': '561d4966cb785c874b19291a1340a4c58b7d67560c3c35b10913b1f963b4e822',
            'association_snapshot': '4077170e6a6c843f1b391fcfdc2a70fd52c76bd01229fa6b105f121708288780',
            'association_snapshot_held': 'cc7be1fd9217d87afbc0d387b75f330968cb997e6bdf8688beaaaa35ed8d0231'}
        expected_policy = {'ForeignSudoObservations': '8e7e6ab5649082fe6d346d4deed633a0892e059b5957b8e1307a07016fb94aff',
            'InvocationImage': '0ea708e4bf5feb3f99092f4f8d9923054b4e00e83f60666938ecdea36682290a',
            'InvocationChain': '35cf24dfaf4121d41da107abd6a0a8b014b9fa02794e0276c2816d566cee94f0'}
        class StripDiagnostic(ast.NodeTransformer):
            def visit_Assign(self, node):
                if all(isinstance(n, ast.Name) and n.id == '_foreign_stage' for n in node.targets): return None
                return self.generic_visit(node)
            def visit_NamedExpr(self, node):
                if isinstance(node.target, ast.Name) and (node.target.id.startswith('_f_') or node.target.id == '_inventory_now'):
                    return self.visit(node.value)
                return self.generic_visit(node)
            def visit_Expr(self, node):
                if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id in (
                        'capture_foreign_failure', 'finish_foreign_cleanup'): return None
                return self.generic_visit(node)
            def visit_If(self, node):
                node = self.generic_visit(node)
                return node if node.body else None
        tree = ast.parse(Path(M.__file__).read_text(), feature_version=(3, 10))
        for name, digest in {**expected, **expected_policy}.items():
            node = StripDiagnostic().visit(next(n for n in tree.body if getattr(n, 'name', None) == name))
            self.assertEqual(M.hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest(), digest, name)
        for name in ('capture_foreign_failure', 'foreign_diagnostic', 'finish_foreign_cleanup'):
            node = next(n for n in tree.body if getattr(n, 'name', None) == name)
            for call in (n for n in ast.walk(node) if isinstance(n, ast.Call)):
                self.assertNotIn(ast.unparse(call.func), ('os.open', 'os.stat', 'os.fstat', 'os.readlink', 'os.read', 'os.pread',
                    'os.pidfd_open', 'select.select', 'time.monotonic_ns', 'time.monotonic', 'budget', 'self.budget'))


class InvocationImageTests(unittest.TestCase):
    @contextmanager
    def fixture(self, kind='sudo'):
        state = SimpleNamespace(raw=b'ELF' + b'x' * 61, replacement=False, alias_changed=False, reads=[])
        state.file = invocation_stat(10, stat.S_IFREG | (0o755 if kind == 'python' else 0o4755))
        state.alias = invocation_stat(11, stat.S_IFLNK | 0o777) if kind == 'python' else state.file
        dirs = {fd: invocation_stat(fd, stat.S_IFDIR | 0o755, 4096) for fd in (1, 2, 3)}
        class FixedPath:
            def __init__(self, path): self.path = str(path)
            def __str__(self): return self.path
            def __eq__(self, other): return isinstance(other, FixedPath) and self.path == other.path
            @property
            def parent(self): return FixedPath(self.path.rsplit('/', 1)[0])
            @property
            def name(self): return self.path.rsplit('/', 1)[1]
            def resolve(self, **kwargs): return FixedPath('/usr/bin/python3.10' if kind == 'python' else '/usr/bin/' + kind)
            def lstat(self):
                if state.alias_changed: return invocation_stat(999, state.alias.st_mode)
                return state.alias
        def opened(name, flags, **kwargs):
            return {'/': 1, 'usr': 2, 'bin': 3, 'sudo': 4, 'fusermount3': 4, 'python3.10': 4}[name]
        def named(name, **kwargs):
            fd = opened(name, 0)
            if fd in dirs: return dirs[fd]
            return invocation_stat(999, state.file.st_mode) if state.replacement else state.file
        def read(fd, count, offset): state.reads.append((count, offset)); return state.raw[offset:offset + count]
        with patch.object(M, 'Path', FixedPath), patch.object(M.os, 'O_DIRECTORY', 0, create=True), \
                patch.object(M.os, 'O_NOFOLLOW', 0, create=True), patch.object(M.os, 'O_NONBLOCK', 0, create=True), \
                patch.object(M.os, 'O_CLOEXEC', 0, create=True), patch.object(M.os, 'open', side_effect=opened), \
                patch.object(M.os, 'close') as close, patch.object(M.os, 'fstat', side_effect=lambda fd: dirs.get(fd, state.file)), \
                patch.object(M.os, 'stat', side_effect=named), patch.object(M.os, 'pread', side_effect=read, create=True):
            state.close = close
            yield state

    def test_fixed_package_bytes_and_named_identity_are_held_and_rechecked(self):
        for kind in ('python', 'sudo', 'fusermount3'):
            with self.subTest(kind=kind), self.fixture(kind) as state:
                image = M.InvocationImage(kind, lambda: None)
                self.assertEqual(image.snapshot(), M.hashlib.sha256(state.raw).hexdigest())
                self.assertEqual(str(image.path), '/usr/bin/python3.10' if kind == 'python' else '/usr/bin/' + kind)
                self.assertTrue(all(count <= 65536 for count, offset in state.reads))
                image.close(); self.assertEqual(state.close.call_count, 4)

    def test_foreign_writable_special_wrong_mode_oversized_package_never_admitted(self):
        for kind in ('sudo', 'fusermount3'):
            for defect in ('uid', 'gid', 'write', 'special', 'not-setuid', 'oversize'):
                with self.subTest(kind=kind, defect=defect), self.fixture(kind) as state:
                    if defect == 'uid': state.file.st_uid = 1001
                    if defect == 'gid': state.file.st_gid = 1001
                    if defect == 'write': state.file.st_mode |= 0o020
                    if defect == 'special': state.file.st_mode = stat.S_IFIFO | 0o4755
                    if defect == 'not-setuid': state.file.st_mode = stat.S_IFREG | 0o755
                    if defect == 'oversize': state.file.st_size = 64 * 1024**2 + 1
                    with self.assertRaises(ValueError): M.InvocationImage(kind, lambda: None)
                    self.assertEqual(state.reads, [])

    def test_same_path_replacement_alias_or_same_stamp_byte_mutation_refuses(self):
        for kind in ('sudo', 'fusermount3'):
            for defect in ('named', 'alias', 'bytes'):
                with self.subTest(kind=kind, defect=defect), self.fixture(kind) as state:
                    image = M.InvocationImage(kind, lambda: None)
                    try:
                        if defect == 'named': state.replacement = True
                        if defect == 'alias': state.alias_changed = True
                        if defect == 'bytes': state.raw = b'changed' + state.raw[7:]
                        with self.assertRaises(ValueError): image.snapshot()
                    finally: image.close()


class TranscriptTests(unittest.TestCase):
    def test_exact_empty_call_and_matching_reply_are_diagnostic_only(self):
        capture = M.Transcript(':1.31', clock=lambda: 1)
        capture.add(message()); capture.add(message(2))
        value = capture.snapshot()
        self.assertTrue(value['callReplyMatched'])
        self.assertFalse(value['qualified']); self.assertFalse(value['inputPermitted'])
        self.assertFalse(value['releaseReady'])
        self.assertEqual(value['call']['serial'], value['reply']['replySerial'])
        self.assertEqual(value['call']['flags'], 0)
        self.assertEqual(value['reply']['flags'], 1)

    def test_cancel_with_existing_root_and_exit_zero_is_not_activation_evidence(self):
        capture = M.Transcript(':1.31', clock=lambda: 1)
        self.assertFalse(capture.snapshot()['callReplyMatched'])
        self.assertFalse(capture.snapshot()['qualified'])

    def test_wrong_reply_and_extra_calls_never_match(self):
        for mutation in (dict(sender=':1.32'), dict(destination=':1.41'), dict(replySerial=21), dict(empty=False), dict(kind=3),
                         *(dict(flags=flags) for flags in (0, 2, 3, 4, 8, -1, False))):
            with self.subTest(mutation=mutation):
                capture = M.Transcript(':1.31', clock=lambda: 1)
                capture.add(message()); capture.add(message(2, **mutation))
                self.assertFalse(capture.snapshot()['callReplyMatched'])
        for second in (message(), message(serial=21), message(2)):
            with self.subTest(second=second):
                capture = M.Transcript(':1.31', clock=lambda: 1)
                capture.add(message()); capture.add(message(2)); capture.add(second)
                self.assertFalse(capture.snapshot()['callReplyMatched'])

    def test_bad_call_deadline_and_budgets_stay_unknown(self):
        for change in (dict(destination=':1.32'), dict(empty=False), dict(member='Other'),
                       *(dict(flags=flags) for flags in (1, 2, 3, 4, 8, -1, False)),
                       dict(serial=True), dict(sender='not-unique'), dict(privateBody='DO NOT RETAIN')):
            with self.subTest(change=change):
                capture = M.Transcript(':1.31', clock=lambda: 1)
                capture.add(message(**change))
                value = capture.snapshot()
                self.assertFalse(value['callReplyMatched'])
                self.assertNotIn('DO NOT RETAIN', str(value))
        clock = [1]
        capture = M.Transcript(':1.31', clock=lambda: clock[0])
        clock[0] += M.SECONDS + 1
        capture.add(message())
        self.assertFalse(capture.snapshot()['callReplyMatched'])
        self.assertTrue(capture.snapshot()['deadlineExceeded'])

    def test_close_is_idempotent_and_late_messages_are_not_adopted(self):
        capture = M.Transcript(':1.31', clock=lambda: 1)
        capture.add(message()); capture.close(); before = capture.snapshot()
        capture.add(message(2)); capture.close()
        self.assertEqual(before, capture.snapshot())


class BindingTests(unittest.TestCase):
    def fixture(self, change=None):
        original = process(10, 9, '/usr/bin/bwrap')
        client = process(14, 13, '/app/bin/creator-hub-flatpak-activate')
        records = {10: original, 11: process(11, 10, '/usr/bin/bwrap'), 12: process(12, 11),
                   13: process(13, 10, '/usr/bin/bwrap'), 14: client}
        calls = []
        def read(pid, full=False):
            calls.append((pid, full))
            result = copy.deepcopy(records[pid])
            if full:
                result['kernelImageSha256'] = 'a' * 64
            if change:
                change(result, calls)
            return result
        peer = lambda name: {'name': name, 'pid': 12, 'uid': 1001}
        redact = lambda row: {key: value for key, value in row.items() if key != 'executable'}
        return original, client, read, peer, redact, records

    def test_same_launch_proxy_and_signed_client_chains_are_recorded_not_adopted(self):
        args = self.fixture()
        result = M.sender_snapshot(':1.40', *args[:5], budget=lambda: None)
        self.assertTrue(result['correlatesToOriginalPopen']); self.assertTrue(result['stable'])
        self.assertFalse(result['qualified']); self.assertFalse(result['inputPermitted'])
        self.assertEqual([row['pid'] for row in result['senderAncestors']], [12, 11, 10])
        self.assertEqual([row['pid'] for row in result['clientAncestors']], [14, 13, 10])

    def test_mismatch_reuse_cycles_uid_and_image_changes_remain_unknown(self):
        def changed_start(row, calls):
            if row['pid'] == 12 and len(calls) > 4: row['startTime'] = '999'
        for change in ('outside', 'cycle', 'uid', 'image', 'peer', 'start'):
            with self.subTest(change=change):
                args = list(self.fixture(changed_start if change == 'start' else None))
                if change == 'outside': args[5][11]['parentPid'] = 9
                if change == 'cycle': args[5][11]['parentPid'] = 12
                if change == 'uid': args[5][12]['uids'] = [2000] * 4
                if change == 'image': args[5][12]['executable'] = '/tmp/not-a-proxy'
                if change == 'peer':
                    count = [0]
                    def peer(name):
                        count[0] += 1
                        return dict(name=name, pid=12 if count[0] == 1 else 15, uid=1001)
                    args[3] = peer
                result = M.sender_snapshot(':1.40', *args[:5], budget=lambda: None)
                self.assertFalse(result['correlatesToOriginalPopen']); self.assertFalse(result['qualified'])

    def test_missing_process_and_budget_error_preserve_bounded_progress(self):
        args = list(self.fixture())
        del args[5][12]
        result = M.sender_snapshot(':1.40', *args[:5], budget=lambda: None)
        self.assertEqual(result['peer']['pid'], 12)
        self.assertFalse(result['stable'])
        self.assertLess(len(str(result)), 4096)
        result = M.sender_snapshot(':1.40', *self.fixture()[:5], budget=lambda: (_ for _ in ()).throw(RuntimeError('SECRET')))
        self.assertNotIn('SECRET', str(result)); self.assertFalse(result['stable'])

    def test_pre_first_read_cancellation_is_distinct_from_a_process_value_failure(self):
        args = list(self.fixture())
        reads = Mock(wraps=args[2]); args[2] = reads
        count = [0]
        def budget():
            count[0] += 1
            if count[0] == 2: raise ValueError('PRIVATE')
        status = dict(closed=True, stopRequested=True, deadlineExceeded=False, cancelled=True)
        result = M.sender_snapshot(':1.40', *args[:5], budget=budget, diagnostic_state=lambda: status)
        self.assertEqual(result['failureStage'], 'sender.0.budget')
        self.assertEqual(result['stateAtFailure'], status)
        self.assertNotIn('firstSenderRead', result); self.assertEqual(result['senderAncestors'], [])
        reads.assert_not_called(); self.assertNotIn('PRIVATE', str(result))

    def test_first_same_read_values_are_retained_before_shape_or_value_rejection(self):
        for change, stage in ((lambda row: row.update(uids=(1001,) * 4), 'uids-match'),
                              (lambda row: row.update(startTime=12), 'start-type'),
                              (lambda row: row.update(parentPid=0), 'parent-range'),
                              (lambda row: row['image'].update(st_size='not-numeric'), 'image-size-parse')):
            with self.subTest(stage=stage):
                def alter(row, calls):
                    if row['pid'] == 12: change(row)
                args = self.fixture(alter)
                status = dict(closed=False, stopRequested=False, deadlineExceeded=False, cancelled=False)
                result = M.sender_snapshot(':1.40', *args[:5], budget=lambda: None, diagnostic_state=lambda: status)
                self.assertEqual(result['failureStage'], 'sender.0.' + stage)
                first = result['firstSenderRead']
                self.assertEqual(first['requestedPid'], 12)
                self.assertEqual(first['pid']['value'], 12)
                self.assertEqual(first['stateAfterRead'], status)
                self.assertEqual(result['senderAncestors'], [])
                self.assertFalse(result['qualified']); self.assertFalse(result['stable'])
                if stage == 'uids-match':
                    self.assertEqual(first['uids']['type'], 'tuple')
                    self.assertEqual(first['uids']['values'], [1001] * 4)
                if stage == 'image-size-parse': self.assertNotIn('not-numeric', str(first))

    def test_first_full_read_identity_mismatch_keeps_original_metadata_not_a_new_read(self):
        args = list(self.fixture())
        reader, calls = args[2], []
        def read(pid, full=False):
            row = reader(pid, full); calls.append((pid, full))
            if full and pid == 12: row['image']['st_size'] = '65'
            return row
        args[2] = read
        result = M.sender_snapshot(':1.40', *args[:5], budget=lambda: None)
        self.assertEqual(result['failureStage'], 'sender.0.full-identity')
        self.assertEqual(result['firstSenderRead']['image']['st_size']['value'], '64')
        self.assertEqual(calls, [(12, False), (12, True)])
        self.assertEqual(result['senderAncestors'], [])

    def test_read_failure_has_exact_stage_without_claiming_process_values(self):
        args = list(self.fixture()); args[2] = Mock(side_effect=PermissionError('PRIVATE READ'))
        result = M.sender_snapshot(':1.40', *args[:5], budget=lambda: None)
        self.assertEqual(result['failureStage'], 'sender.0.read')
        self.assertNotIn('firstSenderRead', result); self.assertNotIn('PRIVATE READ', str(result))
        args[2].assert_called_once_with(12, False)


class PreInputLineageTests(unittest.TestCase):
    def fixture(self):
        rows = {pid: process(pid, parent, path, full=True) for pid, parent, path in (
            (10, 9, '/usr/bin/bwrap'), (11, 10, '/usr/bin/bwrap'), (12, 11, '/usr/bin/xdg-dbus-proxy'),
            (13, 10, '/usr/bin/bwrap'), (14, 13, '/app/bin/creator-hub-flatpak-activate'))}
        for pid, row in rows.items():
            row['image'].update(st_dev='1', st_ino=str(pid), st_gid='0', st_mtime_ns='5', st_ctime_ns='6')
        state = SimpleNamespace(rows=rows, reads=[], dead=set(), closed=[], images=[], guard=Mock())
        def read(pid, full=False):
            state.reads.append((pid, full))
            if pid not in rows: raise FileNotFoundError()
            row = copy.deepcopy(rows[pid])
            if not full: row.pop('kernelImageSha256')
            return row
        def image(pid):
            held = SimpleNamespace(snapshot=lambda: (copy.deepcopy(rows[pid]['image']), 'a' * 64), close=Mock())
            # A held FD survives its process; its snapshot does not reopen /proc/PID/exe.
            stamp = copy.deepcopy(rows[pid]['image'])
            held.snapshot = lambda: (copy.deepcopy(stamp), 'a' * 64)
            state.images.append(held)
            return held
        system = SimpleNamespace(snapshot=lambda: (copy.deepcopy(rows[12]['image']), 'a' * 64), close=Mock())
        state.system = system
        tree = {pid: {k: copy.deepcopy(v) for k, v in row.items() if k != 'kernelImageSha256'} for pid, row in rows.items()}
        def build(**options):
            return M.OwnedLineage(rows[10], rows[14], tree, read, lambda row: copy.deepcopy(row),
                image_open=image, system_image=system, pidfds=SimpleNamespace(open=lambda pid: pid,
                    ready=lambda fd: fd in state.dead, close=lambda fd: state.closed.append(fd)),
                guard=state.guard, budget=options.pop('budget', lambda: None), **options)
        state.build, state.tree = build, tree
        return state

    def test_preinput_seal_and_live_bus_sender_do_not_reopen_historical_parents(self):
        state = self.fixture(); baseline = state.build(); baseline.begin_input()
        del state.rows[11]; del state.rows[13]; state.dead.update((11, 13))
        state.reads.clear()
        value = baseline.observe(':1.40', lambda name: dict(name=name, pid=12, uid=1001), budget=lambda: None)
        self.assertTrue(value['stable']); self.assertTrue(value['correlatesToOriginalPopen'])
        self.assertTrue(value['sealedBeforeInput']); self.assertFalse(value['qualified'])
        self.assertEqual({pid for pid, _ in state.reads}, {12})
        self.assertEqual(value['historicalAncestors'][1]['lifetime'], 'pidfd-signalled-exit')
        baseline.close(); baseline.close()
        self.assertEqual(len(state.closed), 5)
        self.assertTrue(all(held.close.call_count == 1 for held in state.images))

    def test_baseline_missing_proxy_foreign_ancestry_and_ambiguous_entries_fail_closed(self):
        for mutation in ('missing', 'outside', 'cycle', 'uid', 'hash', 'duplicate'):
            state = self.fixture()
            if mutation == 'missing': state.tree.pop(12)
            if mutation == 'outside': state.tree[11]['parentPid'] = state.rows[11]['parentPid'] = 99
            if mutation == 'cycle': state.tree[11]['parentPid'] = state.rows[11]['parentPid'] = 12
            if mutation == 'uid': state.tree[12]['uids'] = state.rows[12]['uids'] = [1002] * 4
            if mutation == 'hash': state.rows[12]['kernelImageSha256'] = 'b' * 64
            if mutation == 'duplicate': state.tree[20] = copy.deepcopy(state.tree[12])
            with self.subTest(mutation=mutation), self.assertRaises((ValueError, KeyError)):
                state.build()
            self.assertTrue(all(held.close.call_count == 1 for held in state.images))

    def test_before_input_drift_or_already_exited_process_prevents_seal(self):
        for mutation in ('start', 'parent', 'uid', 'image', 'exit'):
            state = self.fixture(); baseline = state.build()
            if mutation == 'exit': state.dead.add(11)
            elif mutation == 'image': state.rows[11]['image']['st_ino'] = '999'
            else: state.rows[11][{'start': 'startTime', 'parent': 'parentPid', 'uid': 'uids'}[mutation]] = (
                '999' if mutation == 'start' else 99 if mutation == 'parent' else [1002] * 4)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): baseline.begin_input()
            baseline.close()

    def test_wrong_sender_reuse_exec_reparent_credentials_and_missing_live_proxy_stay_unknown(self):
        for mutation in ('wrong-pid', 'uid', 'start', 'parent', 'image', 'exit', 'gone', 'credentials'):
            state = self.fixture(); baseline = state.build(); baseline.begin_input()
            credentials = dict(name=':1.40', pid=12, uid=1001)
            if mutation == 'wrong-pid': credentials['pid'] = 22
            elif mutation == 'uid': credentials['uid'] = 1002
            elif mutation == 'exit': state.dead.add(12)
            elif mutation == 'gone': del state.rows[12]
            elif mutation == 'image': state.rows[12]['kernelImageSha256'] = 'b' * 64
            elif mutation in ('start', 'parent'): state.rows[12]['startTime' if mutation == 'start' else 'parentPid'] = '999' if mutation == 'start' else 99
            count = [0]
            def peer(name):
                count[0] += 1
                return {**credentials, 'pid': 22} if mutation == 'credentials' and count[0] > 1 else credentials
            value = baseline.observe(':1.40', peer, budget=lambda: None)
            with self.subTest(mutation=mutation):
                self.assertFalse(value['stable']); self.assertFalse(value['correlatesToOriginalPopen'])
            baseline.close()

    def test_unsealed_replayed_and_expired_observations_cannot_attribute(self):
        state = self.fixture(); baseline = state.build()
        peer = lambda name: dict(name=name, pid=12, uid=1001)
        self.assertFalse(baseline.observe(':1.40', peer, budget=lambda: None)['stable'])
        baseline.begin_input()
        self.assertFalse(baseline.observe(':1.40', peer, budget=lambda: (_ for _ in ()).throw(ValueError()))['stable'])
        self.assertFalse(baseline.observe(':1.40', peer, budget=lambda: None)['stable'])
        baseline.close()

    def test_session_and_a11y_candidates_are_sealed_but_only_exact_bus_peer_pid_is_selected(self):
        for selected in (12, 15):
            state = self.fixture()
            row = copy.deepcopy(state.rows[12]); row.update(pid=15, startTime='15')
            state.rows[15] = row
            state.tree[15] = {k: copy.deepcopy(v) for k, v in row.items() if k != 'kernelImageSha256'}
            baseline = state.build(); baseline.begin_input()
            value = baseline.observe(':1.40', lambda name: dict(name=name, pid=selected, uid=1001), budget=lambda: None)
            self.assertTrue(value['stable']); self.assertEqual(value['senderAncestors'][0]['pid'], selected)
            self.assertEqual(set(baseline.chains), {12, 15})
            baseline.close()

    def test_all_candidates_need_owned_ancestry_and_the_candidate_set_is_finite(self):
        for mutation in ('outside', 'too-many'):
            state = self.fixture()
            for pid in range(15, 16 if mutation == 'outside' else 19):
                row = copy.deepcopy(state.rows[12]); row.update(pid=pid, startTime=str(pid), parentPid=99 if mutation == 'outside' else 11)
                state.rows[pid] = row
                state.tree[pid] = {k: copy.deepcopy(v) for k, v in row.items() if k != 'kernelImageSha256'}
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): state.build()
            self.assertTrue(all(held.close.call_count == 1 for held in state.images))

    def test_preinput_failure_stage_retains_only_same_read_redacted_operands_without_extra_reads(self):
        cases = ('candidate-count', 'expected-shape', 'tree-match', 'held-image', 'system-image', 'guard', 'budget')
        for case in cases:
            state = self.fixture(); diagnostic = {}
            if case == 'candidate-count': state.tree.pop(12)
            if case == 'expected-shape': state.rows[14]['uids'] = tuple(state.rows[14]['uids'])
            if case == 'tree-match': state.tree[14]['startTime'] = '999'
            if case == 'held-image': state.rows[14]['kernelImageSha256'] = 'b' * 64
            if case == 'system-image': state.system.snapshot = lambda: (copy.deepcopy(state.rows[12]['image']), 'b' * 64)
            if case == 'guard': state.guard.side_effect = lambda: (_ for _ in ()).throw(ValueError('PRIVATE FAILURE'))
            options = {'budget': lambda: (_ for _ in ()).throw(ValueError('PRIVATE DEADLINE'))} if case == 'budget' else {}
            status = dict(closed=False, stopRequested=False, deadlineExceeded=case == 'budget', cancelled=False)
            with self.subTest(case=case), self.assertRaises(ValueError):
                state.build(diagnostic=diagnostic, diagnostic_state=lambda: status, **options)
            stages = {'candidate-count': 'candidate-count', 'expected-shape': 'expected-client-validation',
                'tree-match': 'walk.row-match', 'held-image': 'walk.held-image-match',
                'system-image': 'candidate-system-image-match', 'guard': 'initial-owned-launch-guard', 'budget': 'initial-budget'}
            self.assertEqual(diagnostic['failureStage'], stages[case])
            self.assertEqual(diagnostic['treeCount'], len(state.tree))
            self.assertFalse(diagnostic['inputPermitted']); self.assertFalse(diagnostic['authorityGranted'])
            self.assertNotIn('PRIVATE FAILURE', str(diagnostic))
            self.assertNotIn('PRIVATE DEADLINE', str(diagnostic))
            self.assertEqual(diagnostic['stateAtFailure'], status)
            self.assertLessEqual(len(M.json.dumps(diagnostic).encode()), 16384)
            if case == 'expected-shape': self.assertEqual(diagnostic['expectedClient']['fieldTypes']['uids'], 'tuple')
            if case == 'held-image':
                self.assertEqual(diagnostic['currentRow']['kernelImageSha256'], 'b' * 64)
                self.assertEqual(diagnostic['observedImage']['kernelImageSha256'], 'a' * 64)
                self.assertEqual(state.reads, [(14, True)])
            if case == 'system-image':
                self.assertEqual(diagnostic['failurePid'], 12)
                self.assertEqual(diagnostic['expectedRowAtFailure']['kernelImageSha256'], 'a' * 64)
                self.assertEqual(diagnostic['observedImage']['kernelImageSha256'], 'b' * 64)

    def test_diagnostic_failure_cannot_mask_primary_error_or_change_native_read_sequence(self):
        for broken_state in (False, True):
            state = self.fixture(); diagnostic = {}
            original = ValueError('PRIVATE ORIGINAL')
            state.guard.side_effect = original
            flags = dict(closed=False, stopRequested=False, deadlineExceeded=False, cancelled=False)
            def status():
                if broken_state: raise RuntimeError('PRIVATE DIAGNOSTIC')
                return flags
            with patch.object(M, 'lineage_inputs', side_effect=RuntimeError('PRIVATE REDACTION')) if not broken_state else ExitStack():
                with self.assertRaises(ValueError) as raised:
                    state.build(diagnostic=diagnostic, diagnostic_state=status)
            self.assertIs(raised.exception, original)
            self.assertEqual(state.reads, [])
            self.assertEqual(diagnostic['failureStage'], 'initial-owned-launch-guard')
            self.assertNotIn('PRIVATE', M.json.dumps(diagnostic)); self.assertFalse(diagnostic['inputPermitted'])

    def test_diagnostic_rows_never_retain_arbitrary_paths_fields_or_oversized_values(self):
        row = copy.deepcopy(self.fixture().rows[12])
        row.update(executable='/private/SECRET-file', unexpected='PRIVATE VALUE', kernelImageSha256='INVALID SECRET')
        row['image']['st_size'] = 'PRIVATE SIZE'
        row['image']['unexpected'] = 'SECRET IMAGE'
        value = M.lineage_inputs(row, row, {pid: row for pid in range(100)})
        raw = M.json.dumps(value)
        for private in ('SECRET', 'PRIVATE', 'unexpected'): self.assertNotIn(private, raw)
        self.assertEqual(value['treeCount'], 100); self.assertTrue(value['treeTruncated'])
        self.assertGreater(len(value['tree']), 0); self.assertLessEqual(len(value['tree']), 16)
        self.assertFalse(value['inputPermitted'])


class RootAssociationTests(unittest.TestCase):
    def fixture(self):
        state = ProxyAssociationTests().fixture()
        state.rows[13]['image'] = copy.deepcopy(state.rows[10]['image'])
        state.tree[13]['image'] = copy.deepcopy(state.rows[10]['image'])
        state.private = dict(instanceId='123', infoSha256='b' * 64, originalPid=10,
            directories=[[1, n, stat.S_IFDIR | 0o700, 1001, 1001, 2] for n in (1, 2, 3)],
            infoIdentity=[1, 2, stat.S_IFREG | 0o644, 1001, 1001, 1, 200, 5, 6],
            pidIdentity=[1, 3, stat.S_IFREG | 0o644, 1001, 1001, 1, 2, 5, 6])
        state.tree_rows = [copy.deepcopy(state.rows[pid]) for pid in (14, 13, 10)]
        state.data = dict(complete=True, uid=1001, candidateCount=1, scopedProcessCount=8,
            original=copy.deepcopy(state.rows[10]), client=copy.deepcopy(state.rows[14]), tree=copy.deepcopy(state.tree_rows),
            proxy=copy.deepcopy(state.rows[12]), flatpakInfo={k: state.info[k] for k in ('sha256', 'fields')},
            privateInstance=copy.deepcopy(state.private), pipes=[dict(appPid=13, appFd=7, proxyFd=8, inode=900)])
        state.instance = SimpleNamespace(snapshot=Mock(side_effect=lambda: copy.deepcopy(state.private)), close=Mock())
        state.snapshots = Mock(side_effect=lambda tree: copy.deepcopy(state.data))
        state.request = dict(schemaVersion=1, operation='flatpak-proxy-snapshot-uid1001', harnessSource='a' * 40,
            codeSha256='e' * 64, sequence=1, nonce='f' * 64, expiresNs=2_000_000_000,
            original=state.rows[10], client=state.rows[14], tree=state.tree_rows,
            caller=dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10'))
        def build():
            with patch.object(M, 'PrivateInstance', return_value=state.instance):
                return M.AssociatedProxyLineage(state.rows[10], state.rows[14], state.tree, state.reader, lambda r: copy.deepcopy(r),
                    snapshot=state.snapshots, image_open=state.image_open, system_image=state.system, pidfds=state.pidfds,
                    guard=state.guard, budget=lambda: None)
        state.build_associated = build
        return state

    def test_external_association_seals_without_fabricating_proxy_ancestry(self):
        state = self.fixture(); baseline = state.build_associated(); baseline.begin_input()
        self.assertEqual(state.snapshots.call_count, 2)
        for pid in (10, 13, 14): del state.rows[pid]
        value = baseline.observe(':1.40', lambda n: dict(name=n, pid=12, uid=1001), budget=lambda: None)
        self.assertTrue(value['stable']); self.assertTrue(value['sealedBeforeInput'])
        self.assertEqual([r['pid'] for r in value['senderAncestors']], [12])
        self.assertEqual(value['externalAssociation']['tree'][-1]['pid'], 10)
        self.assertFalse(value['qualified']); self.assertFalse(value['inputPermitted'])
        baseline.close(); state.instance.close.assert_called_once()

    def test_complete_snapshot_and_all_fixed_association_fields_are_mandatory(self):
        for change in (lambda d: d.update(complete=False), lambda d: d.update(uid=True),
                       lambda d: d.update(candidateCount=0), lambda d: d.update(extra=1),
                       lambda d: d['privateInstance'].update(originalPid=99),
                       lambda d: d['privateInstance'].update(infoSha256='c' * 64),
                       lambda d: d['flatpakInfo']['fields'].update(app='foreign.app'),
                       lambda d: d['proxy'].update(uids=[1002] * 4),
                       lambda d: d['proxy'].update(executable='/usr/bin/other'),
                       lambda d: d['pipes'][0].update(appPid=99)):
            state = self.fixture(); change(state.data)
            with self.assertRaises(ValueError): state.build_associated()

    def test_preinput_root_recheck_mutation_unknown_or_expired_stops_input(self):
        for mutation in ('instance', 'pipe', 'proxy', 'complete', 'error'):
            state = self.fixture(); baseline = state.build_associated()
            if mutation == 'instance': state.data['privateInstance']['pidIdentity'][-1] += 1
            if mutation == 'pipe': state.data['pipes'][0]['inode'] += 1
            if mutation == 'proxy': state.data['proxy']['startTime'] = '999'
            if mutation == 'complete': state.data['complete'] = False
            if mutation == 'error': state.snapshots.side_effect = TimeoutError()
            with self.assertRaises((ValueError, TimeoutError)): baseline.begin_input()
            self.assertFalse(baseline.started); baseline.close()

    def test_subsequent_start_credentials_must_match_exact_sealed_proxy_once(self):
        for credential in (dict(name=':1.40', pid=99, uid=1001), dict(name=':1.40', pid=12, uid=1002)):
            state = self.fixture(); baseline = state.build_associated(); baseline.begin_input()
            self.assertFalse(baseline.observe(':1.40', lambda n: credential, budget=lambda: None)['stable'])
            self.assertFalse(baseline.observe(':1.40', lambda n: dict(name=n, pid=12, uid=1001), budget=lambda: None)['stable'])
            baseline.close()

    def test_root_request_is_finite_typed_and_never_accepts_paths_payload_or_expiry(self):
        state = self.fixture(); M.root_request(state.request, 1_000_000_000)
        for change in (lambda r: r.update(sequence=True), lambda r: r.update(expiresNs=1),
                       lambda r: r.update(operation='global-uid-inventory'), lambda r: r.update(path='/tmp/other'),
                       lambda r: r.update(sequence=4), lambda r: r.update(nonce='bad'),
                       lambda r: r.pop('caller'), lambda r: r['caller'].update(pid=True),
                       lambda r: r['caller'].update(uids=[1001, 0, 0, 0]),
                       lambda r: r['caller'].update(executable='/private/python3.10'),
                       lambda r: r['tree'][0].update(parentPid=99)):
            request = copy.deepcopy(state.request); change(request)
            with self.assertRaises(ValueError): M.root_request(request, 1_000_000_000)

    def run_snapshot(self, state, inventory=None):
        scoped = {pid: {k: v for k, v in row.items() if k not in ('image', 'kernelImageSha256')}
                  for pid, row in state.rows.items()}
        with patch.object(M.os, 'pidfd_open', side_effect=lambda p: p, create=True), \
                patch.object(M.select, 'select', return_value=([], [], [])), patch.object(M.os, 'close'), \
                patch.object(M, 'PrivateInstance', return_value=state.instance), patch.object(M, 'InvocationChain'):
            return M.association_snapshot(state.request, proc=state.proc, read=state.reader,
                inventory=inventory or Mock(return_value=([12], scoped)), clock=lambda: 1_000_000_000)

    def test_root_snapshot_proves_both_endpoints_same_info_and_stable_rechecks(self):
        state = self.fixture(); value = self.run_snapshot(state)
        M.validate_association(value, state.rows[10], state.rows[14], state.tree_rows)
        self.assertTrue(value['complete']); self.assertEqual(value['pipes'][0]['inode'], 900)
        self.assertNotIn('identity', value['flatpakInfo'])
        self.assertNotIn('cmdline', str(value)); self.assertNotIn('environ', str(value))

    def test_root_snapshot_wrong_info_direction_duplicate_matching_or_changed_scan_refuses(self):
        for mutation in ('info', 'direction', 'duplicate', 'scan', 'unreadable'):
            state = self.fixture()
            scoped = {pid: {k: v for k, v in row.items() if k not in ('image', 'kernelImageSha256')}
                      for pid, row in state.rows.items()}
            inventory = Mock(return_value=([12], scoped))
            if mutation == 'info':
                state.proc.info.side_effect = lambda pid: {**copy.deepcopy(state.info), 'sha256': 'e' * 64} if pid == 12 else state.info
            if mutation == 'direction': state.pipes[12][0][0]['access'] = 'read'
            if mutation == 'scan': inventory.side_effect = [([12], scoped), ([12], {**scoped, 99: {}})]
            if mutation == 'unreadable': inventory.side_effect = PermissionError()
            if mutation == 'duplicate':
                state.rows[15] = {**copy.deepcopy(state.rows[12]), 'pid': 15, 'startTime': '15'}
                state.pipes[15] = copy.deepcopy(state.pipes[12])
                scoped[15] = {k: v for k, v in state.rows[15].items() if k not in ('image', 'kernelImageSha256')}
                inventory.return_value = ([12, 15], scoped)
            with self.subTest(mutation=mutation), self.assertRaises((ValueError, PermissionError)):
                self.run_snapshot(state, inventory)

    def test_root_entrypoint_and_client_code_remain_proc_only_not_candidate_execution(self):
        source = Path(M.__file__).read_text()
        tree = ast.parse(source)
        names = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        root_code = '\n'.join(ast.get_source_segment(source, names[n]) for n in
                              ('root_snapshot_main', 'root_process', 'association_snapshot', 'complete_proxy_inventory'))
        for forbidden in ('cmdline', 'environ[', 'subprocess', 'exec(', 'eval(', 'chmod(', 'unlink('):
            self.assertNotIn(forbidden, root_code.replace('no cmdline', 'no command line'))
        self.assertIn("os.environ.get('SUDO_UID')", root_code)
        self.assertIn('protected_tool', root_code)

    def test_complete_root_inventory_never_skips_permission_disappearance_or_changed_uid_set(self):
        entries = [SimpleNamespace(name=str(pid), stat=Mock(return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o700,
                    st_uid=1001))) for pid in (12, 925)]
        def scan(_):
            context = Mock(); context.__enter__ = Mock(return_value=iter(entries)); context.__exit__ = Mock(return_value=False)
            return context
        for error in (PermissionError(), FileNotFoundError(), ProcessLookupError()):
            with patch.object(M.os, 'scandir', side_effect=scan), patch.object(M, 'root_uid_tuple', return_value=[1001] * 4), \
                    patch.object(M, 'root_process', side_effect=error):
                with self.assertRaises(type(error)): M.complete_proxy_inventory(lambda: None)
        reads = [dict(pid=12, executable='/usr/bin/xdg-dbus-proxy'), dict(pid=925, executable='/usr/bin/other'),
                 dict(pid=12, executable='/usr/bin/xdg-dbus-proxy'), dict(pid=925, executable='/usr/bin/changed')]
        with patch.object(M.os, 'scandir', side_effect=scan), patch.object(M, 'root_uid_tuple', return_value=[1001] * 4), \
                patch.object(M, 'root_process', side_effect=reads):
            with self.assertRaises(ValueError): M.complete_proxy_inventory(lambda: None)

    def test_root_owned_proc_directory_cannot_hide_actual_target_uid_or_mixed_credentials(self):
        entry = SimpleNamespace(name='12', stat=Mock(return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)))
        def scan(_):
            context = Mock(); context.__enter__ = Mock(return_value=iter([entry])); context.__exit__ = Mock(return_value=False)
            return context
        row = dict(pid=12, startTime='12', parentPid=1, uids=[1001] * 4, executable='/usr/bin/xdg-dbus-proxy')
        with patch.object(M.os, 'scandir', side_effect=scan), patch.object(M, 'root_uid_tuple', return_value=[1001] * 4), \
                patch.object(M, 'root_process', return_value=row):
            self.assertEqual(M.complete_proxy_inventory(lambda: None), ([12], {12: row}))
        with patch.object(M.os, 'scandir', side_effect=scan), patch.object(M, 'root_uid_tuple', return_value=[1001, 0, 0, 0]):
            with self.assertRaises(ValueError): M.complete_proxy_inventory(lambda: None)

    def test_probe_zero_proxy_inventory_cannot_supply_an_association(self):
        row = dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10')
        request = dict(schemaVersion=1, operation=M.PROBE_OPERATION, harnessSource='a' * 40, codeSha256='b' * 64,
                       sequence=1, nonce='c' * 64, expiresNs=2_000_000_000, caller=row)
        chain = [dict(pid=21, parentPid=20, startTime='21', state='R', uids=[0] * 4, executableKind='python', imageSha256='a' * 64),
                 dict(pid=20, parentPid=19, startTime='20', state='S', uids=[1001, 0, 0, 0], executableKind='sudo', imageSha256='b' * 64)]
        with patch.object(M.Path, 'resolve', return_value='/usr/bin/python3.10'), \
                patch.object(M.os, 'pidfd_open', return_value=7, create=True), patch.object(M.os, 'close'), \
                patch.object(M.select, 'select', return_value=([], [], [])), \
                patch.object(M, 'InvocationChain') as held, \
                patch.object(M, 'complete_uid_inventory', return_value=([], {19: row})):
            held.return_value.__enter__.return_value.receipt.return_value = chain
            value = M.inventory_probe(request, clock=lambda: 1_000_000_000)
            M.validate_probe(value, request)
            self.assertEqual(value['candidateCount'], 0)
            self.assertTrue(value['complete']); self.assertTrue(value['readOnly'])
            for key in ('inputPermitted', 'authorityGranted', 'releaseReady'):
                self.assertIs(value[key], False)
            with self.assertRaises(ValueError): M.root_request(request, 1_000_000_000)
            with self.assertRaises(ValueError): M.validate_association(value, {}, {}, [])
            for key, changed in (('complete', False), ('candidateCount', True), ('uid', True),
                                 ('authorityGranted', True), ('proxy', {})):
                with self.subTest(key=key), self.assertRaises(ValueError): M.validate_probe({**value, key: changed}, request)
        with patch.object(M, 'complete_uid_inventory', return_value=([], {19: row})):
            with self.assertRaises(ValueError): M.complete_proxy_inventory(lambda: None)

    def test_probe_request_is_separate_closed_source_nonce_expiry_and_caller_schema(self):
        request = dict(schemaVersion=1, operation=M.PROBE_OPERATION, harnessSource='a' * 40, codeSha256='b' * 64,
                       sequence=1, nonce='c' * 64, expiresNs=2_000_000_000,
                       caller=dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10'))
        with patch.object(M.Path, 'resolve', return_value='/usr/bin/python3.10'):
            M.probe_request(request, 1_000_000_000)
            for change in (lambda r: r.update(operation='flatpak-proxy-snapshot-uid1001'),
                           lambda r: r.update(expiresNs=1), lambda r: r.update(expiresNs=7_000_000_000),
                           lambda r: r.update(sequence=2), lambda r: r.update(nonce='bad'),
                           lambda r: r.update(tree=[]), lambda r: r['caller'].update(pid=True),
                           lambda r: r['caller'].update(uids=[1001, 0, 0, 0]),
                           lambda r: r['caller'].update(executable='/tmp/unknown')):
                changed = copy.deepcopy(request); change(changed)
                with self.assertRaises(ValueError): M.probe_request(changed, 1_000_000_000)

    def test_probe_refuses_changed_caller_chain_exit_and_incomplete_uid_inventory(self):
        caller = dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10')
        request = dict(schemaVersion=1, operation=M.PROBE_OPERATION, harnessSource='a' * 40, codeSha256='b' * 64,
                       sequence=1, nonce='c' * 64, expiresNs=2_000_000_000, caller=caller)
        for failure in ('chain', 'caller', 'exit', 'permission', 'expired'):
            with self.subTest(failure=failure), patch.object(M.Path, 'resolve', return_value='/usr/bin/python3.10'), \
                    patch.object(M.os, 'pidfd_open', return_value=7, create=True), patch.object(M.os, 'close'), \
                    patch.object(M.select, 'select', return_value=([7], [], []) if failure == 'exit' else ([], [], [])), \
                    patch.object(M, 'InvocationChain') as held, \
                    patch.object(M, 'complete_uid_inventory', side_effect=PermissionError() if failure == 'permission' else None,
                                 return_value=([], {19: {} if failure == 'caller' else caller})):
                if failure == 'chain': held.return_value.__enter__.return_value.recheck.side_effect = ValueError()
                clock = Mock(side_effect=[1_000_000_000, 3_000_000_000]) if failure == 'expired' else lambda: 1_000_000_000
                with self.assertRaises((ValueError, PermissionError)) as caught: M.inventory_probe(request, clock=clock)
                if failure == 'exit':
                    self.assertEqual(caught.exception.proxy_snapshot_stage, 'probe-caller-chain')
                    self.assertEqual(caught.exception.proxy_caller_diagnostic, dict(predicate='caller-pidfd-live',
                        hops=[dict(pid=19, parentPid=None, startTime=None, uids=None, state=None,
                                   expectedKind='python', executableKind='unread')]))

    def test_probe_invocation_only_follows_fixed_sudo_parent_chain_to_actual_caller(self):
        for failure in (None, 'foreign-exe', 'mixed-uid', 'sudo-other-uid', 'caller-replaced', 'permission', 'zombie'):
            with self.subTest(failure=failure), invocation_fixture() as state:
                original = PermissionError('PRIVATE_PROC_FAILURE')
                if failure == 'foreign-exe': state.rows[20]['executable'] = '/PRIVATE_FOREIGN_EXECUTABLE'
                if failure == 'mixed-uid': state.rows[21]['uids'] = [1001, 0, 0, 0]
                if failure == 'sudo-other-uid': state.rows[20]['uids'] = [1001, 0, 0, 1001]
                if failure == 'caller-replaced': state.rows[19]['startTime'] = '99'
                if failure == 'permission': state.permission = original
                if failure == 'zombie': state.rows[21]['state'] = 'Z'
                if failure is None:
                    rows = M.probe_caller_chain(state.caller)
                    self.assertEqual([r['pid'] for r in rows], [21, 20])
                    self.assertEqual(rows[1]['uids'], [1001, 0, 0, 0])
                    self.assertEqual(rows[1]['executableKind'], 'sudo')
                    self.assertEqual(rows[1]['imageSha256'], 'b' * 64)
                else:
                    with self.assertRaises((ValueError, PermissionError)) as caught: M.probe_caller_chain(state.caller)
                    detail = caught.exception.proxy_caller_diagnostic
                    self.assertLessEqual(len(M.json.dumps(detail)), 4096)
                    self.assertNotIn('PRIVATE', M.json.dumps(detail))
                    hop = detail['hops'][-1]
                    if failure in ('mixed-uid', 'sudo-other-uid'):
                        self.assertEqual(detail['predicate'], 'hop-credentials')
                        self.assertEqual(hop['executableKind'], 'python' if failure == 'mixed-uid' else 'sudo')
                        self.assertEqual(hop['pid'], 21 if failure == 'mixed-uid' else 20)
                        self.assertIn(hop['pid'], state.links)
                    elif failure == 'foreign-exe':
                        self.assertEqual(detail['predicate'], 'hop-executable')
                        self.assertEqual((hop['expectedKind'], hop['executableKind']), ('sudo', 'other'))
                    elif failure == 'caller-replaced':
                        self.assertEqual(detail['predicate'], 'caller-identity'); self.assertEqual(hop['pid'], 19)
                    elif failure == 'permission':
                        self.assertIs(caught.exception, original)
                        self.assertEqual(detail['predicate'], 'hop-read'); self.assertIsNone(hop['state'])
                        self.assertEqual(state.reads, [(21, 'stat')]); self.assertEqual(state.links, [])
                    else:
                        self.assertEqual(detail['predicate'], 'hop-process-shape'); self.assertEqual(hop['state'], 'Z')
                        self.assertEqual(state.links, [])

    def test_optional_caller_proc_metadata_uses_only_existing_identity_reads(self):
        pid = 19
        raw = (f'{pid} (PRIVATE_NAME) S 18 ' + '0 ' * 17 + '19\n').encode()
        for attach in (False, True):
            row = M.probe_hop_detail(pid); reads = []
            def read(directory, name, maximum):
                reads.append(name)
                return (raw if name == 'stat' else b'Uid:\t1001 1001 1001 1001\n'), []
            with patch.object(M.os, 'O_DIRECTORY', 0, create=True), patch.object(M.os, 'O_NOFOLLOW', 0, create=True), \
                    patch.object(M.os, 'O_CLOEXEC', 0, create=True), patch.object(M.os, 'open', return_value=7), \
                    patch.object(M.os, 'close'), patch.object(M.os, 'readlink', return_value='/usr/bin/python3.10') as links, \
                    patch.object(M.ProxyAssociationProc, 'read_at', side_effect=read):
                value = M.root_process(pid, **({'probe_diagnostic': row} if attach else {}))
            self.assertEqual(value, dict(pid=19, parentPid=18, startTime='19', uids=[1001] * 4, executable='/usr/bin/python3.10'))
            self.assertEqual(reads, ['stat', 'status', 'stat', 'status']); self.assertEqual(links.call_count, 2)
            if attach:
                self.assertEqual(row['state'], 'S'); self.assertEqual(row['uids'], [1001] * 4)
                self.assertNotIn('PRIVATE', M.json.dumps(row))

    def test_probe_hop_metadata_is_bounded_and_never_contains_raw_state_or_names(self):
        value = M.probe_hop_detail(19, ['PRIVATE_STATE', '1' * 100] + ['0'] * 17 + ['2' * 100], [(b'1' * 5000,) * 4])
        self.assertEqual(value['state'], 'other'); self.assertIsNone(value['uids'])
        self.assertIsNone(value['parentPid']); self.assertIsNone(value['startTime'])
        self.assertNotIn('PRIVATE', M.json.dumps(value)); self.assertLess(len(M.json.dumps(value)), 512)

    def test_failed_caller_identity_retains_same_read_state_and_uids_without_executable_reads(self):
        for state, ids in (('Z', [1001] * 4), ('S', [1001, 0, 0, 0])):
            row = M.probe_hop_detail(19)
            raw = (f'19 (PRIVATE_NAME) {state} 18 ' + '0 ' * 17 + '19\n').encode()
            with self.subTest(state=state), patch.object(M.os, 'O_DIRECTORY', 0, create=True), \
                    patch.object(M.os, 'O_NOFOLLOW', 0, create=True), patch.object(M.os, 'O_CLOEXEC', 0, create=True), \
                    patch.object(M.os, 'open', return_value=7), patch.object(M.os, 'close'), \
                    patch.object(M.os, 'readlink') as links, \
                    patch.object(M.ProxyAssociationProc, 'read_at', side_effect=[(raw, []),
                        (('Uid:\t' + ' '.join(str(uid) for uid in ids) + '\n').encode(), [])]) as reads:
                with self.assertRaises(ValueError): M.root_process(19, probe_diagnostic=row)
                self.assertEqual(reads.call_count, 2); links.assert_not_called()
            self.assertEqual(row, dict(pid=19, parentPid=18, startTime='19', state=state,
                                       uids=ids, executableKind='unread'))
            self.assertNotIn('PRIVATE', M.json.dumps(row))

    def test_root_watchdog_is_armed_before_any_stdin_read_and_exits_only_itself(self):
        state, events = self.fixture(), []
        stream = Mock()
        stream.buffer.read.side_effect = lambda bound: (events.append('read'), M.json.dumps(state.request).encode())[1]
        with patch.object(M.signal, 'SIGALRM', 14, create=True), patch.object(M.signal, 'ITIMER_REAL', 0, create=True), \
                patch.object(M.signal, 'signal') as install, \
                patch.object(M.signal, 'setitimer', side_effect=lambda *a: events.append('watchdog'), create=True), \
                patch.object(M.os, '_exit') as exit_self, patch.object(M.os, 'getuid', return_value=0, create=True), \
                patch.object(M.os, 'geteuid', return_value=0, create=True), \
                patch.dict(M.os.environ, {'SUDO_UID': '1001'}), \
                patch.object(M, 'PROXY_TOOL', Path(M.__file__)), patch.object(M.sys, 'argv', ['observer.py', 'root-proxy-snapshot']), \
                patch.object(M.sys, 'stdin', stream), patch.object(M.sys, 'stdout', io.StringIO()), \
                patch.object(M.time, 'monotonic_ns', return_value=1_000_000_000), \
                patch.object(M, 'protected_tool'), patch.object(M, 'association_snapshot', return_value=state.data):
            M.root_snapshot_main()
            self.assertEqual(events, ['watchdog', 'read'])
            stream.buffer.read.assert_called_once_with(32769)
            install.call_args.args[1](14, None); exit_self.assert_called_once_with(124)

    def test_root_probe_entrypoint_never_requests_launcher_or_association_authority(self):
        request = dict(operation=M.PROBE_OPERATION, codeSha256='b' * 64)
        out = io.StringIO()
        with patch.object(M.signal, 'SIGALRM', 14, create=True), patch.object(M.signal, 'ITIMER_REAL', 0, create=True), \
                patch.object(M.signal, 'signal'), patch.object(M.signal, 'setitimer', create=True), \
                patch.object(M.os, 'getuid', return_value=0, create=True), patch.object(M.os, 'geteuid', return_value=0, create=True), \
                patch.dict(M.os.environ, {'SUDO_UID': '1001'}), patch.object(M, 'PROXY_TOOL', Path(M.__file__)), \
                patch.object(M.sys, 'argv', ['observer.py', 'root-inventory-probe']), \
                patch.object(M.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(M.json.dumps(request).encode()))), \
                patch.object(M.sys, 'stdout', out), patch.object(M, 'protected_tool') as code, \
                patch.object(M, 'probe_request') as validate, patch.object(M, 'inventory_probe', return_value={'candidateCount': 0}) as probe, \
                patch.object(M, 'root_request', side_effect=AssertionError('No launcher request')), \
                patch.object(M, 'association_snapshot', side_effect=AssertionError('No association')):
            M.root_snapshot_main()
            validate.assert_called_once(); probe.assert_called_once_with(request)
            self.assertEqual(code.call_count, 2)
            self.assertEqual(M.json.loads(out.getvalue())['snapshot'], {'candidateCount': 0})

    def test_root_probe_original_refusal_transports_only_bounded_caller_operands(self):
        detail = dict(predicate='hop-credentials', hops=[dict(pid=21, parentPid=20, startTime='21',
            uids=[1001, 0, 0, 0], state='S', expectedKind='python', executableKind='unread')])
        for oversized in (False, True):
            error = ValueError('PRIVATE_ORIGINAL_ERROR')
            error.proxy_snapshot_stage = 'probe-caller-chain'
            error.proxy_caller_diagnostic = detail if not oversized else {'unknown': 'PRIVATE' * 1000}
            request = dict(operation=M.PROBE_OPERATION, codeSha256='b' * 64)
            out = io.StringIO()
            with self.subTest(oversized=oversized), patch.object(M.signal, 'SIGALRM', 14, create=True), \
                    patch.object(M.signal, 'ITIMER_REAL', 0, create=True), patch.object(M.signal, 'signal'), \
                    patch.object(M.signal, 'setitimer', create=True), \
                    patch.object(M.os, 'getuid', return_value=0, create=True), patch.object(M.os, 'geteuid', return_value=0, create=True), \
                    patch.dict(M.os.environ, {'SUDO_UID': '1001'}), patch.object(M, 'PROXY_TOOL', Path(M.__file__)), \
                    patch.object(M.sys, 'argv', ['observer.py', 'root-inventory-probe']), \
                    patch.object(M.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(M.json.dumps(request).encode()))), \
                    patch.object(M.sys, 'stdout', out), patch.object(M, 'protected_tool') as code, \
                    patch.object(M, 'probe_request'), patch.object(M, 'inventory_probe', side_effect=error), \
                    patch.object(M, 'association_snapshot', side_effect=AssertionError('No association')):
                with self.assertRaises(SystemExit) as caught: M.root_snapshot_main()
                self.assertEqual(caught.exception.code, 1)
                self.assertIs(caught.exception.__context__, error)
                code.assert_called_once_with('b' * 64)
            value = M.json.loads(out.getvalue())
            expected = dict(ok=False, unavailable='ValueError', stage='probe-caller-chain')
            if not oversized: expected['probeCaller'] = detail
            self.assertEqual(value, expected)
            self.assertNotIn('PRIVATE', out.getvalue()); self.assertLess(len(out.getvalue()), 4096)

    def test_private_instance_readback_replacement_and_size_are_guarded_without_writes(self):
        # Real Linux fd/proc coverage is separate; this checks the held instance
        # operand contract without creating a host runtime or invoking root.
        state = self.fixture()
        obj = M.PrivateInstance.__new__(M.PrivateInstance)
        obj.original, obj.info = state.rows[10], state.info
        obj.paths, obj.fds = [], [9]
        obj.stamps = state.private['directories']
        obj.expected = copy.deepcopy(state.private)
        obj.expected['directories'] = state.private['directories']
        info = state.private['infoIdentity']; pid = state.private['pidIdentity']
        raw = b'public-info'
        obj.info = {**state.info, 'sha256': M.hashlib.sha256(raw).hexdigest()}
        obj.expected['infoSha256'] = obj.info['sha256']
        with patch.object(M.ProxyAssociationProc, 'read_at', side_effect=[(raw, info), (b'10', pid)]):
            self.assertEqual(obj.snapshot(), obj.expected)
        with patch.object(M.ProxyAssociationProc, 'read_at', side_effect=[(raw, info), (b'99', pid)]):
            with self.assertRaises(ValueError): obj.snapshot()

    @unittest.skipUnless(sys.platform == 'linux' and os.getuid() == os.getgid(), 'Real Linux private-directory FD semantics')
    def test_real_unix_private_instance_holds_exact_info_pid_and_refuses_same_byte_replacement(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(M, 'PROXY_UID', os.getuid()):
            runtime = Path(folder).resolve() / 'runtime'; runtime.mkdir(mode=0o700)
            parent = runtime / '.flatpak'; parent.mkdir(mode=0o700)
            instance = parent / '123'; instance.mkdir(mode=0o700)
            raw = b'fixed public instance info\n'
            def create(name, body):
                with os.fdopen(os.open(instance / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
                    stream.write(body)
            create('info', raw); create('pid', b'10')
            info = dict(sha256=M.hashlib.sha256(raw).hexdigest(), fields=dict(instanceId='123'))
            held = M.PrivateInstance(info, dict(pid=10), runtime)
            try:
                before = held.snapshot()
                (instance / 'pid').rename(instance / 'retained-original-pid')
                create('pid', b'10')
                with self.assertRaises(ValueError): held.snapshot()
                self.assertEqual((instance / 'info').read_bytes(), raw)
                self.assertEqual(before['originalPid'], 10)
            finally:
                held.close()

    @unittest.skipUnless(sys.platform == 'linux', 'Real Linux own-proc metadata only')
    def test_real_unix_own_proc_identity_is_stable_without_command_or_environment_reads(self):
        with patch.object(M, 'PROXY_UID', os.getuid()):
            first = M.root_process(os.getpid())
            self.assertEqual(first, M.root_process(os.getpid()))
        self.assertEqual(set(first), {'pid', 'parentPid', 'startTime', 'uids', 'executable'})


class ProxyAssociationTests(unittest.TestCase):
    def fixture(self):
        state = PreInputLineageTests().fixture()
        state.tree.pop(11); state.tree.pop(12)
        state.rows[12]['parentPid'] = 99
        state.rows[12]['startTime'] = '11'
        state.info = dict(size=200, sha256='b' * 64, identity=[1, 2, 3],
                          fields=dict(app='com.creatorworks.hub', instanceId='123', appCommit='c' * 64, runtimeCommit='d' * 64))
        state.pipes = {10: ([], 'outer'), 13: ([dict(fd=7, inode=900, access='read')], 'app'),
                       12: ([dict(fd=8, inode=900, access='write')], 'proxy')}
        state.proc = SimpleNamespace(candidates=Mock(return_value=([12], 8)),
            info=Mock(side_effect=lambda pid: copy.deepcopy(state.info)),
            pipes=Mock(side_effect=lambda pid: copy.deepcopy(state.pipes[pid])))
        state.scan = dict(inventoryComplete=True, scanSkipped=0, skippedTypes={}, skipped=[], skippedTruncated=False)
        def candidates(uid, budget, *, diagnostic):
            diagnostic.update(copy.deepcopy(state.scan), scannedPids=state.proc.candidates.return_value[1])
            return state.proc.candidates.return_value
        state.proc.candidates.side_effect = candidates
        def read(pid, full=False):
            state.reads.append((pid, full))
            return copy.deepcopy(state.rows[pid])
        def image(pid):
            stamp = copy.deepcopy(state.rows[pid]['image']), state.rows[pid]['kernelImageSha256']
            held = SimpleNamespace(snapshot=Mock(return_value=stamp), close=Mock())
            state.images.append(held)
            return held
        state.reader, state.image_open = read, image
        state.pidfds = SimpleNamespace(open=Mock(side_effect=lambda pid: pid), ready=Mock(return_value=False),
                                       close=Mock(side_effect=state.closed.append))
        state.run = lambda **options: M.proxy_association_diagnostic(state.rows[10], state.rows[14], state.tree,
            state.reader, image_open=state.image_open, system_image=state.system, pidfds=state.pidfds,
            guard=state.guard, budget=options.pop('budget', lambda: None), proc=state.proc, **options)
        return state

    def test_external_proxy_shared_pipe_and_instance_are_diagnostic_not_lineage_admission(self):
        state = self.fixture(); value = state.run()
        self.assertTrue(value['complete']); self.assertTrue(value['associationObserved'])
        self.assertEqual(value['candidateCount'], 1)
        self.assertEqual(set(value['launcher']['flatpakInfo']), {'sha256', 'fields'})
        self.assertNotIn('identity', value['candidates'][0]['flatpakInfo'])
        self.assertEqual(value['candidates'][0]['sharedPipes'], [dict(appPid=13, appFd=7, proxyFd=8,
            inode=900, appAccess='read', proxyAccess='write')])
        for key in ('qualified', 'inputPermitted', 'authorityGranted', 'releaseReady'): self.assertFalse(value[key])
        self.assertCountEqual(state.closed, [14, 13, 10, 12])
        self.assertTrue(all(item.close.call_count == 1 for item in state.images))
        state.system.close.assert_called_once()
        diagnostic = {}
        with self.assertRaises(ValueError): state.build(diagnostic=diagnostic)
        self.assertEqual(diagnostic['failureStage'], 'candidate-count')

    def test_hash_instance_or_pipe_mismatch_never_observes_association(self):
        for change in ('hash', 'instance', 'inode', 'direction'):
            state = self.fixture()
            if change in ('hash', 'instance'):
                def info(pid):
                    value = copy.deepcopy(state.info)
                    if pid == 12:
                        if change == 'hash': value['sha256'] = 'e' * 64
                        else: value['fields']['instanceId'] = '456'
                    return value
                state.proc.info.side_effect = info
            elif change == 'inode': state.pipes[12][0][0]['inode'] = 901
            else: state.pipes[12][0][0]['access'] = 'read'
            with self.subTest(change=change):
                value = state.run()
                self.assertTrue(value['complete']); self.assertFalse(value['associationObserved'])

    def test_incomplete_scan_retains_accessible_proxy_evidence_but_never_association_or_authority(self):
        state = self.fixture()
        state.scan.update(inventoryComplete=False, scanSkipped=1, skippedTypes={'PermissionError': 1},
                          skipped=[dict(pid=99, uid=1001, operation='exe-readlink', type='PermissionError')])
        value = state.run()
        self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
        self.assertEqual(value['unavailable'], 'IncompleteInventory')
        self.assertFalse(value['inventory']['inventoryComplete']); self.assertEqual(value['inventory']['scanSkipped'], 1)
        self.assertTrue(value['candidates'][0]['infoMatchesLauncher'])
        self.assertEqual(value['candidates'][0]['sharedPipes'][0]['inode'], 900)
        for key in ('qualified', 'inputPermitted', 'authorityGranted', 'releaseReady'): self.assertFalse(value[key])
        with self.assertRaises(ValueError): state.build()

    def test_skipped_unknown_or_proxy_is_never_retained_or_given_an_association(self):
        for operation in ('pid-stat', 'exe-readlink', 'pid-stat-recheck'):
            state = self.fixture(); state.proc.candidates.return_value = [], 1
            state.scan.update(inventoryComplete=False, scanSkipped=1, skippedTypes={'PermissionError': 1},
                skipped=[dict(pid=12, uid=None if operation == 'pid-stat' else 1001, operation=operation, type='PermissionError')])
            with self.subTest(operation=operation):
                value = state.run()
                self.assertEqual(value['candidateCount'], 0); self.assertEqual(value['candidates'], [])
                self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
                self.assertEqual(value['failureStage'], 'candidate-inventory'); state.proc.info.assert_not_called()
                self.assertNotIn(12, state.closed)

    def test_incomplete_scan_does_not_exempt_changed_held_proxy(self):
        state = self.fixture()
        state.scan.update(inventoryComplete=False, scanSkipped=1, skippedTypes={'PermissionError': 1},
                          skipped=[dict(pid=99, uid=1001, operation='exe-readlink', type='PermissionError')])
        original, calls = state.proc.pipes.side_effect, {}
        def pipes(pid):
            calls[pid] = calls.get(pid, 0) + 1
            if pid == 12 and calls[pid] == 2: state.rows[12]['startTime'] = '999'
            return original(pid)
        state.proc.pipes.side_effect = pipes
        value = state.run()
        self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
        self.assertEqual(value['unavailable'], 'ValueError'); self.assertEqual(value['failureStage'], 'association-recheck')

    def test_foreign_uid_image_path_or_nonprotected_proxy_refuses_before_private_info(self):
        for change in ('uid', 'image', 'path', 'writable'):
            state = self.fixture()
            if change == 'uid': state.rows[12]['uids'] = [2000] * 4
            if change == 'image': state.rows[12]['kernelImageSha256'] = 'e' * 64
            if change == 'path': state.rows[12]['executable'] = '/private/FOREIGN'
            if change == 'writable': state.rows[12]['image']['st_mode'] = str(0o100777)
            with self.subTest(change=change):
                value = state.run()
                self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
                self.assertEqual(value['failureStage'], 'candidate-image')
                state.proc.info.assert_not_called()
                self.assertNotIn('FOREIGN', M.json.dumps(value))

    def test_candidate_count_inventory_and_output_are_finite(self):
        for candidates, scanned in (([], 1), ([12] * 2, 8), ([12, 15, 16, 17, 18], 8), ([12], 4097), ([12], True)):
            state = self.fixture(); state.proc.candidates.return_value = candidates, scanned
            with self.subTest(candidates=candidates, scanned=scanned):
                value = state.run()
                self.assertFalse(value['complete']); self.assertEqual(value['failureStage'], 'candidate-inventory')
                state.proc.info.assert_not_called()
        state = self.fixture(); state.pipes[12][0][0]['fd'] = '9' * 13000
        value = state.run()
        self.assertEqual(value['unavailable'], 'OutputLimit')
        self.assertLessEqual(len(M.json.dumps(value)), 12288)

    def test_mapping_info_process_image_and_pidfd_races_refuse(self):
        for change in ('mapping', 'info', 'process', 'image', 'pidfd', 'guard'):
            state = self.fixture(); calls = {}
            if change in ('mapping', 'info'):
                original = state.proc.pipes.side_effect if change == 'mapping' else state.proc.info.side_effect
                def read(pid):
                    calls[pid] = calls.get(pid, 0) + 1
                    value = original(pid)
                    if calls[pid] > 1:
                        if change == 'mapping': return value[0], 'replaced'
                        value['identity'] = [999]
                    return value
                (state.proc.pipes if change == 'mapping' else state.proc.info).side_effect = read
            if change == 'process':
                original = state.reader
                def read(pid, full):
                    value = original(pid, full)
                    if len(state.reads) > 8: value['startTime'] = '999'
                    return value
                state.reader = read
            if change == 'image':
                original = state.image_open
                def image(pid):
                    held = original(pid)
                    held.snapshot.side_effect = [held.snapshot.return_value, ({}, 'e' * 64)]
                    return held
                state.image_open = image
            if change == 'pidfd': state.pidfds.ready.side_effect = lambda fd: len(state.reads) > 8
            if change == 'guard': state.guard.side_effect = [None, RuntimeError('PRIVATE GUARD')]
            with self.subTest(change=change):
                value = state.run()
                self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
                self.assertNotIn('PRIVATE GUARD', M.json.dumps(value))

    def test_ambiguous_matching_proxies_and_cleanup_failure_are_unavailable(self):
        state = self.fixture(); state.rows[15] = copy.deepcopy(state.rows[12]); state.rows[15].update(pid=15, startTime='12')
        state.proc.candidates.return_value = [12, 15], 8
        state.pipes[15] = copy.deepcopy(state.pipes[12])
        value = state.run()
        self.assertEqual(value['failureStage'], 'association-ambiguity')
        self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
        state = self.fixture(); state.pidfds.close.side_effect = OSError('PRIVATE CLOSE')
        value = state.run()
        self.assertTrue(value['cleanupUnavailable']); self.assertFalse(value['associationObserved'])
        self.assertEqual(state.pidfds.close.call_count, 4); state.system.close.assert_called_once()
        self.assertNotIn('PRIVATE CLOSE', M.json.dumps(value))

    def test_process_change_during_final_fd_snapshot_is_not_marked_complete(self):
        state = self.fixture(); reads = {}
        original = state.proc.pipes.side_effect
        def pipes(pid):
            reads[pid] = reads.get(pid, 0) + 1
            if pid == 12 and reads[pid] == 2:
                state.rows[12]['startTime'] = '999'
            return original(pid)
        state.proc.pipes.side_effect = pipes
        value = state.run()
        self.assertFalse(value['complete']); self.assertFalse(value['associationObserved'])
        self.assertEqual(value['failureStage'], 'association-recheck')

    def test_budget_cannot_extend_or_replace_the_original_refusal(self):
        state = self.fixture(); value = state.run(budget=Mock(side_effect=ValueError('PRIVATE DEADLINE')))
        self.assertEqual(value['failureStage'], 'owned-launch'); state.proc.candidates.assert_not_called()
        self.assertNotIn('PRIVATE DEADLINE', M.json.dumps(value)); state.system.close.assert_called_once()


class ProxyAssociationProcTests(unittest.TestCase):
    def flags(self):
        stack = ExitStack()
        for name in ('O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC', 'O_DIRECTORY', 'O_ACCMODE'):
            stack.enter_context(patch.object(M.os, name, getattr(M.os, name, 3 if name == 'O_ACCMODE' else 0), create=True))
        return stack

    @staticmethod
    def info_raw():
        return ('[Application]\nname=com.creatorworks.hub\n[Instance]\ninstance-id=123\napp-commit=' + 'c' * 64
                + '\nruntime-commit=' + 'd' * 64 + '\n[Environment]\nPRIVATE=DO NOT OUTPUT\n').encode()

    def test_private_info_outputs_only_hash_fixed_fields_and_numeric_identity(self):
        proc = M.ProxyAssociationProc(); raw = self.info_raw()
        with self.flags(), patch.object(M.os, 'open', return_value=9), patch.object(M.os, 'close'), \
                patch.object(proc, 'read_at', return_value=(raw, (1, 2, 3))):
            value = proc.info(14)
        self.assertEqual(value['sha256'], M.hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['fields']['instanceId'], '123')
        self.assertNotIn('PRIVATE', M.json.dumps(value)); self.assertNotIn('DO NOT OUTPUT', M.json.dumps(value))
        for bad in (raw.replace(b'123', b'SECRET/path'), raw.replace(b'com.creatorworks.hub', b'foreign.app'),
                    raw.replace(b'app-commit=', b'app-commit=SECRET'), raw + b'[Application]\nname=other\n'):
            with self.flags(), patch.object(M.os, 'open', return_value=9), patch.object(M.os, 'close'), \
                    patch.object(proc, 'read_at', return_value=(bad, (1, 2, 3))), self.assertRaises(Exception):
                proc.info(14)

    def test_regular_info_size_type_and_mutation_guards_before_open(self):
        with tempfile.TemporaryDirectory() as directory, self.flags():
            path = Path(directory) / 'synthetic-info'; path.write_bytes(b'123')
            self.assertEqual(M.ProxyAssociationProc.read_at(None, str(path), 3, sized=True)[0], b'123')
            with patch.object(M.os, 'open', wraps=M.os.open) as opened, self.assertRaises(ValueError):
                M.ProxyAssociationProc.read_at(None, str(path), 2, sized=True)
            opened.assert_not_called()
            with self.assertRaises(ValueError): M.ProxyAssociationProc.read_at(None, str(path.parent), 65536, sized=True)
            changed = SimpleNamespace(**{key: getattr(path.stat(), key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid',
                'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}); changed.st_ino += 1
            with patch.object(M.os, 'fstat', return_value=changed), self.assertRaises(ValueError):
                M.ProxyAssociationProc.read_at(None, str(path), 3, sized=True)
            with self.assertRaises(ValueError): M.ProxyAssociationProc.read_at(None, str(path), 2)
            path.write_bytes(b'')
            with self.assertRaises(ValueError): M.ProxyAssociationProc.read_at(None, str(path), 3, sized=True)

    def test_pid_scan_filters_foreign_uid_and_bounds_candidates_and_total(self):
        proc = M.ProxyAssociationProc()
        def entry(pid, uid=1001):
            info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o555, st_dev=1, st_ino=pid, st_uid=uid, st_gid=uid,
                                   st_nlink=1, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
            return SimpleNamespace(name=str(pid), stat=lambda **_: info)
        def context(entries):
            from contextlib import nullcontext
            return nullcontext(iter(entries))
        with patch.object(M.os, 'scandir', return_value=context([entry(14, 2000), entry(15)])), \
                patch.object(M.os, 'readlink', return_value='/usr/bin/xdg-dbus-proxy') as link:
            self.assertEqual(proc.candidates(1001, lambda: None), ([15], 2))
            link.assert_called_once_with('/proc/15/exe')
        for entries in ([entry(pid) for pid in range(10, 15)], [entry(pid, 2000) for pid in range(10, 4107)]):
            with patch.object(M.os, 'scandir', return_value=context(entries)), \
                    patch.object(M.os, 'readlink', return_value='/usr/bin/xdg-dbus-proxy'), self.assertRaises(ValueError):
                proc.candidates(1001, lambda: None)
        with patch.object(M.os, 'scandir', return_value=context([entry(15)])), \
                patch.object(M.os, 'readlink', side_effect=FileNotFoundError()):
            diagnostic = {}
            self.assertEqual(proc.candidates(1001, lambda: None, diagnostic=diagnostic), ([], 1))
            self.assertFalse(diagnostic['inventoryComplete']); self.assertEqual(diagnostic['scanSkipped'], 1)

    def test_denied_and_disappeared_entries_record_only_fixed_operands_then_continue(self):
        from contextlib import nullcontext
        proc = M.ProxyAssociationProc()
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o555, st_dev=1, st_ino=2, st_uid=1001, st_gid=1001,
                               st_nlink=1, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
        entries = [SimpleNamespace(name='14', stat=Mock(return_value=info)),
                   SimpleNamespace(name='15', stat=Mock(side_effect=FileNotFoundError('PRIVATE/stat'))),
                   SimpleNamespace(name='16', stat=Mock(side_effect=[info, PermissionError('PRIVATE/recheck')])),
                   SimpleNamespace(name='17', stat=Mock(return_value=info)),
                   SimpleNamespace(name='18', stat=Mock(side_effect=ProcessLookupError('PRIVATE/process')))]
        def readlink(path):
            if path == '/proc/14/exe': raise PermissionError('PRIVATE/executable')
            return '/usr/bin/xdg-dbus-proxy'
        diagnostic = {}
        with patch.object(M.os, 'scandir', return_value=nullcontext(iter(entries))), \
                patch.object(M.os, 'readlink', side_effect=readlink):
            self.assertEqual(proc.candidates(1001, lambda: None, diagnostic=diagnostic), ([17], 5))
        self.assertFalse(diagnostic['inventoryComplete']); self.assertEqual(diagnostic['scanSkipped'], 4)
        self.assertEqual(diagnostic['skippedTypes'], {'PermissionError': 2, 'FileNotFoundError': 1, 'ProcessLookupError': 1})
        self.assertEqual(diagnostic['skipped'], [
            dict(pid=14, uid=1001, operation='exe-readlink', type='PermissionError'),
            dict(pid=15, uid=None, operation='pid-stat', type='FileNotFoundError'),
            dict(pid=16, uid=1001, operation='pid-stat-recheck', type='PermissionError'),
            dict(pid=18, uid=None, operation='pid-stat', type='ProcessLookupError')])
        self.assertNotIn('PRIVATE', M.json.dumps(diagnostic)); self.assertNotIn('exe', set(diagnostic['skipped'][0]))

    def test_skipped_detail_cap_counts_every_failure_and_does_not_expand_inventory_bound(self):
        from contextlib import nullcontext
        proc = M.ProxyAssociationProc()
        entries = [SimpleNamespace(name=str(pid), stat=Mock(side_effect=PermissionError('PRIVATE'))) for pid in range(10, 30)]
        diagnostic = {}
        with patch.object(M.os, 'scandir', return_value=nullcontext(iter(entries))):
            self.assertEqual(proc.candidates(1001, lambda: None, diagnostic=diagnostic), ([], 20))
        self.assertEqual(diagnostic['scanSkipped'], 20); self.assertEqual(len(diagnostic['skipped']), 16)
        self.assertTrue(diagnostic['skippedTruncated']); self.assertFalse(diagnostic['inventoryComplete'])
        self.assertEqual(diagnostic['skippedTypes'], {'PermissionError': 20})
        self.assertLess(len(M.json.dumps(diagnostic)), 4096); self.assertNotIn('PRIVATE', M.json.dumps(diagnostic))
        entries = [SimpleNamespace(name=str(pid), stat=Mock(side_effect=PermissionError())) for pid in range(10, 4107)]
        with patch.object(M.os, 'scandir', return_value=nullcontext(iter(entries))), self.assertRaises(ValueError):
            proc.candidates(1001, lambda: None)

    def test_metadata_mutation_other_io_errors_and_budget_are_not_skipped(self):
        from contextlib import nullcontext
        proc = M.ProxyAssociationProc()
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o555, st_dev=1, st_ino=2, st_uid=1001, st_gid=1001,
                               st_nlink=1, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
        changed = copy.copy(info); changed.st_ino = 999
        for cause in ('metadata', 'io', 'budget'):
            entry = SimpleNamespace(name='14', stat=Mock(side_effect=[info, changed] if cause == 'metadata' else None, return_value=info))
            diagnostic = {}
            with patch.object(M.os, 'scandir', return_value=nullcontext(iter([entry]))), \
                    patch.object(M.os, 'readlink', side_effect=OSError('PRIVATE IO') if cause == 'io' else None,
                                 return_value='/usr/bin/xdg-dbus-proxy'), \
                    self.assertRaises((ValueError, OSError)):
                proc.candidates(1001, Mock(side_effect=ValueError('PRIVATE BUDGET')) if cause == 'budget' else lambda: None,
                                diagnostic=diagnostic)
            self.assertFalse(diagnostic['inventoryComplete']); self.assertEqual(diagnostic['scanSkipped'], 0)

    def test_pipe_capture_has_no_other_targets_and_rejects_bad_fdinfo_and_mapping(self):
        proc = M.ProxyAssociationProc()
        identity = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_dev=1, st_ino=2, st_uid=1001, st_gid=1001,
                                   st_nlink=1, st_size=12, st_mtime_ns=1, st_ctime_ns=1)
        from contextlib import nullcontext
        for change in (None, 'flags', 'inode', 'mapping', 'count'):
            entries = [SimpleNamespace(name=str(i)) for i in (range(129) if change == 'count' else (1, 2))]
            raw = b'pos:\t0\nflags:\t02000001\nmnt_id:\t1\nino:\t900\n'
            if change == 'flags': raw = raw.replace(b'02000001', b'SECRET')
            if change == 'inode': raw = raw.replace(b'900', b'901')
            reads = {}
            def link(name, **_):
                reads[name] = reads.get(name, 0) + 1
                if name == '1': return 'pipe:[901]' if change == 'mapping' and reads[name] > 1 else 'pipe:[900]'
                return '/PRIVATE/secret-path'
            with self.flags(), patch.object(M.os, 'open', side_effect=[10, 11]), patch.object(M.os, 'close') as close, \
                    patch.object(M.os, 'scandir', side_effect=lambda _: nullcontext(iter(entries))), \
                    patch.object(M.os, 'stat', return_value=identity), patch.object(M.os, 'readlink', side_effect=link), \
                    patch.object(proc, 'read_at', return_value=(raw, ())) as read:
                if change:
                    with self.assertRaises(ValueError): proc.pipes(12)
                else:
                    value = proc.pipes(12)
                    self.assertEqual(value[0], [dict(fd=1, inode=900, access='write')])
                    self.assertNotIn('PRIVATE', str(value)); read.assert_called_once_with(11, '1', 4096)
                self.assertCountEqual([call.args[0] for call in close.call_args_list], [10, 11])


class GioAdapterTests(unittest.TestCase):
    @staticmethod
    def capture():
        return M.PassiveCapture(dict(name=':1.31', pid=40), process(10, 9, '/usr/bin/bwrap'),
            process(14, 13, '/app/bin/creator-hub-flatpak-activate'), Mock(), Mock(),
            lambda: dict(name=':1.31', pid=40), 'unix:path=/private-ci-bus', 1001)

    def test_finish_uses_only_remaining_original_budget_then_closes_without_a_retry(self):
        observer = self.capture()
        observer.transcript.deadline = 100
        observer.settled = Mock()
        with patch.object(M.time, 'monotonic', return_value=98), patch.object(observer, 'close', return_value={'closed': True}) as close:
            self.assertEqual(observer.finish_observation(), {'closed': True})
        observer.settled.wait.assert_called_once_with(2); close.assert_called_once_with()
        observer.settled.reset_mock()
        with patch.object(M.time, 'monotonic', return_value=101), patch.object(observer, 'close'):
            observer.finish_observation()
        observer.settled.wait.assert_called_once_with(0)

    def test_an_already_observed_call_prevents_input_and_an_unstopped_worker_keeps_attribution_unknown(self):
        state = PreInputLineageTests().fixture()
        observer = self.capture(); observer.baseline = state.build(); observer.armed = True
        observer.headers = [message()]
        with self.assertRaises(ValueError): observer.begin_input()
        self.assertFalse(observer.input_started)
        observer.worker = Mock(); observer.worker.is_alive.return_value = True
        value = observer.close()
        self.assertFalse(value['workerStopped']); self.assertFalse(value['qualified'])
        self.assertFalse(observer.baseline.closed)
        observer.baseline.close()

    def test_callback_never_reads_unrelated_message_body(self):
        observer = self.capture()
        unrelated = SimpleNamespace(get_message_type=lambda: 4, get_sender=lambda: ':1.50',
                                    get_body=lambda: self.fail('Unrelated body read'))
        self.assertIsNone(observer.filter(None, unrelated, True, None))
        self.assertEqual(observer.pending, [])

    @staticmethod
    def wire(record, body=None):
        return SimpleNamespace(get_message_type=lambda: record['kind'], get_sender=lambda: record['sender'],
            get_destination=lambda: record['destination'], get_path=lambda: record.get('path'),
            get_interface=lambda: record.get('interface'), get_member=lambda: record.get('member'),
            get_serial=lambda: record['serial'], get_reply_serial=lambda: record['replySerial'],
            get_flags=lambda: record['flags'], get_signature=lambda: '' if record['empty'] else 's',
            get_body=lambda: body)

    def test_header_queue_is_finite_and_never_unpacks_bodies(self):
        observer = self.capture()
        body = SimpleNamespace(unpack=lambda: self.fail('Body content read'))
        for _ in range(M.MAX_PENDING + 1):
            observer.filter(None, self.wire(message(empty=False), body), True, None)
        self.assertEqual(len(observer.headers), M.MAX_PENDING)
        self.assertEqual(observer.failure, 'PendingLimit')
        self.assertNotIn('unpack', str(observer.headers))
        self.assertTrue(all(row['empty'] is False for row in observer.headers))

    def test_global_message_limit_deadline_and_closed_capture_stop_without_fallback(self):
        unrelated = SimpleNamespace(get_message_type=lambda: 4, get_sender=lambda: ':1.50')
        observer = self.capture()
        for _ in range(M.MAX_MESSAGES + 1): observer.filter(None, unrelated, True, None)
        self.assertEqual(observer.failure, 'MessageLimit')
        observer = self.capture(); observer.transcript.deadline = 0
        observer.filter(None, unrelated, True, None)
        self.assertEqual(observer.failure, 'Deadline'); self.assertEqual(observer.headers, [])
        observer = self.capture(); observer.close(); before = copy.deepcopy(observer.headers)
        observer.filter(None, self.wire(message()), True, None)
        self.assertEqual(observer.headers, before)

    def test_worker_retains_denied_credential_progress_without_adopting_sender(self):
        observer = self.capture()
        observer.pending = [message(), message(2)]
        observer.peer = Mock(side_effect=PermissionError('PRIVATE'))
        budget = Mock(side_effect=[None, None, None, ValueError()])
        observer.budget = budget
        observer.run()
        self.assertFalse(observer.sender['stable']); self.assertFalse(observer.sender['qualified'])
        self.assertNotIn('PRIVATE', str(observer.sender))

    def test_close_releases_only_owned_connections_and_preserves_queued_headers(self):
        observer = self.capture()
        observer.monitor, observer.control = Mock(), Mock()
        observer.cancellable, observer.timer, observer.worker = Mock(), Mock(), Mock()
        observer.worker.is_alive.return_value = False
        observer.filter_id = 9
        observer.filter(None, self.wire(message()), True, None)
        value = observer.close()
        self.assertTrue(value['workerStopped']); self.assertTrue(value['cleanupRequested'])
        self.assertEqual(value['observedHeaders'], [message()])
        observer.monitor.remove_filter.assert_called_once_with(9)
        observer.cancellable.cancel.assert_called_once(); observer.worker.join.assert_called_once_with(timeout=0.75)
        observer.monitor.close.assert_called_once_with(None, None); observer.control.close.assert_called_once_with(None, None)
        self.assertFalse(value['qualified']); self.assertFalse(value['callReplyMatched'])
        self.assertEqual(observer.close(), value)
        observer.monitor.close.assert_called_once_with(None, None)

    def test_failed_or_still_running_cleanup_never_grants_authority(self):
        observer = self.capture()
        observer.monitor, observer.worker = Mock(), Mock()
        observer.worker.is_alive.return_value = True
        observer.monitor.close.side_effect = RuntimeError('PRIVATE CLOSE')
        value = observer.close()
        self.assertFalse(value['workerStopped']); self.assertFalse(value['qualified'])
        self.assertEqual(value['unavailable'], 'CloseUnavailable')
        self.assertNotIn('PRIVATE', str(value))

    def test_observed_f3_close_drains_captured_reply_without_input_or_credential_reads(self):
        observer = self.capture()
        observer.transcript.add(message())
        observer.headers = [message(), message(2)]
        observer.pending = [message(2)]
        observer.sender = dict(qualified=False, inputPermitted=False, stable=False,
                               correlatesToOriginalPopen=False, unavailable='ValueError')
        observer.peer = Mock(side_effect=AssertionError('No new credentials at close'))
        value = observer.close()
        self.assertEqual(value['messageCount'], 2); self.assertTrue(value['callReplyMatched'])
        self.assertEqual(value['pendingAtClose'], 1); self.assertEqual(value['drainedAtClose'], 1)
        self.assertEqual(value['pendingAfterClose'], 0)
        self.assertFalse(value['qualified']); self.assertFalse(value['senderObservation']['stable'])
        observer.peer.assert_not_called(); observer.read.assert_not_called()
        self.assertEqual(value['observedHeaders'], [message(), message(2)])

    def test_close_also_retains_a_reply_in_an_abandoned_worker_batch(self):
        observer = self.capture(); observer.transcript.add(message())
        observer.headers = [message(), message(2)]
        self.assertEqual(observer.pending, [])
        value = observer.close()
        self.assertTrue(value['callReplyMatched']); self.assertEqual(value['drainedAtClose'], 1)

    def test_close_cannot_recover_bad_replies_or_process_transcript_while_worker_is_live(self):
        for failure in ('wrong-reply', 'duplicate', 'deadline', 'worker-live'):
            with self.subTest(failure=failure):
                observer = self.capture(); observer.transcript.add(message())
                observer.headers = [message(), message(2, replySerial=99) if failure == 'wrong-reply' else message(2)]
                observer.pending = observer.headers[1:]
                if failure == 'duplicate': observer.headers.append(message(2))
                if failure == 'deadline': observer.transcript.deadline = 0
                if failure == 'worker-live':
                    observer.worker = Mock(); observer.worker.is_alive.return_value = True
                value = observer.close()
                self.assertFalse(value['callReplyMatched']); self.assertFalse(value['qualified'])
                if failure == 'worker-live':
                    self.assertEqual(value['drainedAtClose'], 0)
                    self.assertEqual(value['drainUnavailable'], 'WorkerStillRunning')
                if failure == 'deadline': self.assertTrue(value['deadlineExceeded'])

    def test_only_bus_introspection_and_monitor_setup_can_be_called(self):
        source = Path(M.__file__).read_text('utf8')
        ast.parse(source, feature_version=(3, 10))
        self.assertNotIn("'Start', GLib.Variant", source)
        self.assertNotIn('AddMatch', source)
        self.assertIn('BecomeMonitor', source)
        self.assertNotIn('XSendEvent', source)
        self.assertNotIn('subprocess', source)

    def test_real_adapter_contract_uses_separate_monitor_and_never_sends_host_methods(self):
        self.arm_fixture()

    def test_monitor_denial_or_wrong_bus_id_is_unknown_and_only_owned_connections_close(self):
        for failure in ('denied', 'bus-id'):
            with self.subTest(failure=failure): self.arm_fixture(failure)

    def arm_fixture(self, failure=None):
        observer = self.capture()
        calls, connections = [], []
        shared = Mock(name='existing-private-session')
        def call(role):
            def invoke(destination, path, interface, method, parameters, reply, flags, timeout, cancellable):
                calls.append((role, destination, path, interface, method, parameters, timeout))
                self.assertEqual(destination, 'org.freedesktop.DBus')
                self.assertEqual(path, '/org/freedesktop/DBus')
                self.assertLessEqual(timeout, 1000)
                if method == 'GetId': value = ('b' if failure == 'bus-id' and role == 'monitor' else 'a') * 32
                elif method == 'GetNameOwner': value = ':1.31'
                elif method == 'GetConnectionUnixProcessID': value = 40
                elif method == 'GetConnectionUnixUser': value = 1001
                elif method == 'BecomeMonitor':
                    if failure == 'denied': raise PermissionError('PRIVATE DENIAL')
                    return SimpleNamespace(unpack=lambda: ())
                else: self.fail('Unexpected outgoing method: ' + method)
                return SimpleNamespace(unpack=lambda: (value,))
            return invoke
        shared.call_sync.side_effect = call('shared')
        def connect(address, flags, auth, cancellable):
            self.assertEqual(address, observer.address); self.assertEqual(flags, 9); self.assertIsNone(auth)
            connection = Mock(name='control' if not connections else 'monitor')
            connection.call_sync.side_effect = call('control' if not connections else 'monitor')
            connection.add_filter.return_value = 7
            connections.append(connection)
            return connection
        cancellable, timer, worker = Mock(), Mock(), Mock()
        worker.is_alive.return_value = False
        gio = SimpleNamespace(Cancellable=SimpleNamespace(new=lambda: cancellable),
            DBusConnection=SimpleNamespace(new_for_address_sync=connect),
            DBusConnectionFlags=SimpleNamespace(AUTHENTICATION_CLIENT=1, MESSAGE_BUS_CONNECTION=8),
            DBusCallFlags=SimpleNamespace(NONE=0), BusType=SimpleNamespace(SESSION=1),
            bus_get_sync=lambda *_: shared)
        glib = SimpleNamespace(Variant=lambda kind, values: (kind, values), VariantType=SimpleNamespace(new=lambda kind: kind))
        with ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, {'gi': SimpleNamespace(), 'gi.repository': SimpleNamespace(Gio=gio, GLib=glib)}))
            stack.enter_context(patch.object(M.sys, 'platform', 'linux'))
            stack.enter_context(patch.object(M.os, 'getuid', return_value=1001, create=True))
            stack.enter_context(patch.object(M.os, 'geteuid', return_value=1001, create=True))
            stack.enter_context(patch.dict(M.os.environ, {'DBUS_SESSION_BUS_ADDRESS': observer.address}))
            stack.enter_context(patch.object(M.threading, 'Timer', return_value=timer))
            stack.enter_context(patch.object(M.threading, 'Thread', return_value=worker))
            if failure:
                with self.assertRaises((ValueError, PermissionError)): observer.arm()
            else:
                observer.arm()
                self.assertTrue(observer.armed); self.assertTrue(observer.bus_identity_matched)
                methods = [row[4] for row in calls]
                self.assertEqual(methods.count('BecomeMonitor'), 1)
                self.assertNotIn('Start', methods); self.assertNotIn('AddMatch', methods)
                setup = next(row for row in calls if row[4] == 'BecomeMonitor')
                self.assertEqual(setup[5][0], '(asu)'); self.assertEqual(setup[5][1][1], 0)
                self.assertEqual(len(setup[5][1][0]), 3)
                connections[1].add_filter.assert_called_once_with(observer.filter, None)
                worker.start.assert_called_once()
                with self.assertRaises(ValueError): observer.arm()
            value = observer.close()
            self.assertFalse(value['qualified']); self.assertFalse(value['inputPermitted'])
        shared.close.assert_not_called()
        for connection in connections: connection.close.assert_called_once_with(None, None)


class QueryDiagnosticTests(unittest.TestCase):
    @staticmethod
    def fixture():
        class RegisteredError(Exception):
            def __init__(self, *, domain='g-dbus-error-quark', code=3,
                         remote='org.freedesktop.DBus.Error.NameHasNoOwner'):
                super().__init__('PRIVATE ERROR TEXT')
                self.domain, self.code, self.remote = domain, code, remote
        observer = GioAdapterTests.capture()
        observer.Gio = SimpleNamespace(DBusCallFlags=SimpleNamespace(NONE=0),
            DBusError=SimpleNamespace(get_remote_error=Mock(side_effect=lambda error: error.remote)))
        observer.GLib = SimpleNamespace(Error=RegisteredError, Variant=lambda *args: args,
                                       VariantType=SimpleNamespace(new=lambda value: value))
        observer.control, observer.cancellable = Mock(), Mock()
        observer.budget = Mock()
        return observer, RegisteredError

    def test_peer_query_order_timeout_and_cancellable_are_unchanged(self):
        observer, _ = self.fixture()
        observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,)) for v in (':1.40', 12, 1001, ':1.40')]
        self.assertEqual(observer.peer(':1.40'), dict(name=':1.40', pid=12, uid=1001))
        calls = observer.control.call_sync.call_args_list
        self.assertEqual([call.args[3] for call in calls],
                         ['GetNameOwner', 'GetConnectionUnixProcessID', 'GetConnectionUnixUser', 'GetNameOwner'])
        self.assertTrue(all(call.args[7:] == (500, observer.cancellable) for call in calls))
        self.assertIsNone(observer.query_failure)

    def test_each_original_query_error_keeps_exact_step_metadata_and_exception_without_retry(self):
        values = (':1.40', 12, 1001, ':1.40')
        for index, step in enumerate(('owner-before', 'pid', 'uid', 'owner-after')):
            with self.subTest(step=step):
                observer, Error = self.fixture(); error = Error()
                observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,)) for v in values[:index]] + [error]
                with patch.object(M.time, 'monotonic_ns', side_effect=range(100, 120)):
                    with self.assertRaises(Error) as caught: observer.peer(':1.40')
                self.assertIs(caught.exception, error)
                self.assertEqual(observer.control.call_sync.call_count, index + 1)
                failure = observer.query_failure
                self.assertEqual(failure['step'], step); self.assertTrue(failure['registeredGIError'])
                self.assertEqual(failure['method'], ('GetNameOwner', 'GetConnectionUnixProcessID', 'GetConnectionUnixUser', 'GetNameOwner')[index])
                self.assertEqual((failure['domain'], failure['code']), ('g-dbus-error-quark', 3))
                self.assertEqual(failure['remoteErrorName'], 'org.freedesktop.DBus.Error.NameHasNoOwner')
                self.assertLess(failure['startedMonotonicNs'], failure['failedMonotonicNs'])
                self.assertNotIn('PRIVATE', str(failure)); self.assertNotIn(':1.40', str(failure))

    def test_local_timeout_remote_name_and_unknown_metadata_are_distinct_and_bounded(self):
        for remote in (None, 'org.freedesktop.DBus.Error.Timeout', 'org.freedesktop.DBus.Error.NoReply', 'PRIVATE.remote'):
            observer, Error = self.fixture()
            value = M.query_error_metadata(Error(domain='g-io-error-quark', code=24, remote=remote), observer.Gio, observer.GLib)
            self.assertEqual((value['domain'], value['code']), ('g-io-error-quark', 24))
            self.assertNotIn('PRIVATE', str(value))
            if remote == 'PRIVATE.remote': self.assertTrue(value['remoteErrorNameUnavailable'])
            else: self.assertEqual(value['remoteErrorName'], remote)
        observer, Error = self.fixture()
        value = M.query_error_metadata(Error(domain='PRIVATE.domain'), observer.Gio, observer.GLib)
        self.assertTrue(value['domainUnavailable']); self.assertNotIn('PRIVATE', str(value))
        duck = RuntimeError('PRIVATE'); duck.domain, duck.code, duck.remote = 'g-dbus-error-quark', 3, 'PRIVATE'
        observer.Gio.DBusError.get_remote_error.reset_mock()
        self.assertEqual(M.query_error_metadata(duck, observer.Gio, observer.GLib), {'registeredGIError': False})
        observer.Gio.DBusError.get_remote_error.assert_not_called()

    def test_diagnostic_clock_accessor_or_serialization_failure_preserves_original_query_error(self):
        for failure in ('clock', 'accessor', 'serialization'):
            with self.subTest(failure=failure):
                observer, Error = self.fixture(); error = Error()
                observer.control.call_sync.side_effect = error
                if failure == 'accessor': observer.Gio.DBusError.get_remote_error.side_effect = OSError('PRIVATE')
                with patch.object(M.time, 'monotonic_ns', side_effect=OSError('PRIVATE')) if failure == 'clock' else ExitStack(), \
                        patch.object(M, 'bounded', side_effect=ValueError('PRIVATE')) if failure == 'serialization' else ExitStack():
                    with self.assertRaises(Error) as caught: observer.peer(':1.40')
                self.assertIs(caught.exception, error); observer.control.call_sync.assert_called_once()
                self.assertNotIn('PRIVATE', str(observer.query_failure))
        observer, Error = self.fixture()
        observer.control.call_sync.side_effect = [Error(), Error(remote='org.freedesktop.DBus.Error.Timeout')]
        for _ in range(2):
            with self.assertRaises(Error): observer.peer(':1.40')
        self.assertEqual(observer.query_failure['remoteErrorName'], 'org.freedesktop.DBus.Error.NameHasNoOwner')

    def test_delayed_worker_after_disconnected_peer_still_refuses_without_new_process_reads(self):
        observer, Error = self.fixture()
        state = PreInputLineageTests().fixture()
        observer.baseline, observer.armed = state.build(), True
        observer.begin_input(); state.reads.clear()
        observer.control.call_sync.side_effect = Error()
        gate = threading.Event()
        observer.worker = threading.Thread(target=lambda: (gate.wait(2), observer.run()), daemon=True)
        observer.worker.start()
        try:
            observer.filter(None, GioAdapterTests.wire(message()), True, None)
            observer.filter(None, GioAdapterTests.wire(message(2)), True, None)
            exit_observed = M.time.monotonic_ns()
            state.dead.update(state.rows)
            gate.set()
            self.assertTrue(observer.settled.wait(2), 'Bounded synthetic worker did not settle')
            value = observer.close()
            self.assertTrue(value['callReplyMatched'])
            self.assertFalse(value['senderObservation']['stable']); self.assertFalse(value['qualified'])
            self.assertEqual(value['senderObservation']['failureStage'], 'live-sender-credentials')
            self.assertEqual(value['queryFailure']['remoteErrorName'], 'org.freedesktop.DBus.Error.NameHasNoOwner')
            self.assertGreaterEqual(value['queryFailure']['startedMonotonicNs'], exit_observed)
            self.assertLessEqual(value['timing']['callHeaderQueuedMonotonicNs'], exit_observed)
            observer.control.call_sync.assert_called_once(); self.assertEqual(state.reads, [])
        finally:
            gate.set(); observer.close()
            observer.worker.join(timeout=2)
            self.assertFalse(observer.worker.is_alive())


class ProxyRecheckDiagnosticTests(unittest.TestCase):
    CHECKS = ('pidfd-before', 'process-before', 'held-image', 'system-image', 'process-after', 'pidfd-after')

    def fixture(self, fail=None, raises=False):
        state = PreInputLineageTests().fixture()
        baseline = state.build(); baseline.begin_input()
        self.addCleanup(baseline.close)
        calls = []
        row = copy.deepcopy(state.rows[12])

        def observation(name, result):
            calls.append(name)
            if name == fail:
                if raises:
                    raise PermissionError('PRIVATE failure detail')
                if name.startswith('pidfd-'):
                    return True
                if type(result) is dict:
                    result['image']['st_ino'] = '999'
                    result['PRIVATE'] = 'PRIVATE value'
                else:
                    result = (result[0], 'b' * 64)
            return result

        pidfd_calls, read_calls = [0], [0]
        def ready(fd):
            pidfd_calls[0] += 1
            if pidfd_calls[0] > 2:
                return False
            return observation('pidfd-before' if pidfd_calls[0] == 1 else 'pidfd-after', False)
        def read(pid, full):
            self.assertEqual((pid, full), (12, True))
            read_calls[0] += 1
            return observation('process-before' if read_calls[0] == 1 else 'process-after', copy.deepcopy(row))
        baseline.pidfds.ready = ready
        baseline.read = read
        baseline.held[12].snapshot = lambda: observation('held-image', (copy.deepcopy(row['image']), row['kernelImageSha256']))
        baseline.system.snapshot = lambda: observation('system-image', (copy.deepcopy(row['image']), row['kernelImageSha256']))
        peer = Mock(side_effect=lambda name: dict(name=name, pid=12, uid=1001))
        return baseline, calls, peer

    def test_each_failed_operand_reports_only_fixed_fields_without_repeating_reads_or_accepting(self):
        for index, check in enumerate(self.CHECKS):
            with self.subTest(check=check):
                baseline, calls, peer = self.fixture(check)
                value = baseline.observe(':1.40', peer, budget=lambda: None)
                self.assertEqual(calls, list(self.CHECKS[:index + 1]))
                self.assertEqual(peer.call_count, 1)
                self.assertEqual(value['failureStage'], 'live-prebound-proxy')
                self.assertEqual(value['proxyRecheck']['check'], check)
                expected = ['image.st_ino', 'shape'] if check.startswith('process-') else ['kernelImageSha256']
                if check.startswith('pidfd-'):
                    self.assertNotIn('changedFields', value['proxyRecheck'])
                else:
                    self.assertEqual(value['proxyRecheck']['changedFields'], expected)
                for field in ('stable', 'qualified', 'inputPermitted', 'correlatesToOriginalPopen'):
                    self.assertIs(value[field], False)
                self.assertNotIn('historicalDisconnected', value)
                self.assertNotIn('PRIVATE', json.dumps(value))

    def test_os_exceptions_keep_exact_check_and_do_not_read_again_or_expose_exception_body(self):
        for index, check in enumerate(self.CHECKS):
            with self.subTest(check=check):
                baseline, calls, peer = self.fixture(check, raises=True)
                value = baseline.observe(':1.40', peer, budget=lambda: None)
                self.assertEqual(calls, list(self.CHECKS[:index + 1]))
                self.assertEqual(value['unavailable'], 'PermissionError')
                self.assertEqual(value['proxyRecheck']['check'], check)
                self.assertNotIn('changedFields', value['proxyRecheck'])
                self.assertNotIn('PRIVATE', json.dumps(value))
                self.assertEqual(peer.call_count, 1)

    def test_success_retains_operation_order_and_peer_recheck_without_failure_diagnostic(self):
        baseline, calls, peer = self.fixture()
        value = baseline.observe(':1.40', peer, budget=lambda: None)
        self.assertEqual(calls, list(self.CHECKS))
        self.assertEqual(peer.call_count, 2)
        self.assertTrue(value['stable']); self.assertTrue(value['correlatesToOriginalPopen'])
        self.assertNotIn('proxyRecheck', value)
        self.assertFalse(value['qualified']); self.assertFalse(value['inputPermitted'])

    def test_diagnostic_failure_cannot_mask_the_original_refusal(self):
        baseline, calls, peer = self.fixture('process-before')
        with patch.object(M, 'proxy_changed_fields', side_effect=RuntimeError('PRIVATE')):
            value = baseline.observe(':1.40', peer, budget=lambda: None)
        self.assertEqual(value['failureStage'], 'live-prebound-proxy')
        self.assertTrue(value['proxyRecheck']['captureUnavailable'])
        self.assertFalse(value['correlatesToOriginalPopen'])
        self.assertEqual(calls, list(self.CHECKS[:2])); self.assertEqual(peer.call_count, 1)
        self.assertNotIn('PRIVATE', json.dumps(value))

    def test_changed_field_summary_handles_shape_mismatches_without_returning_unknown_keys(self):
        self.assertEqual(M.proxy_changed_fields([], {}), ['shape'])
        self.assertEqual(M.proxy_changed_fields(({},), ({}, 'a')), ['shape'])
        self.assertEqual(M.proxy_changed_fields({'image': {'PRIVATE': 'value'}}, {'image': {}}), ['image.shape'])
        self.assertEqual(M.proxy_changed_fields({'image': []}, {'image': {}}), ['image.shape'])


class HistoricalDisconnectTests(unittest.TestCase):
    def fixture(self):
        observer, error = QueryDiagnosticTests.fixture()
        state = RootAssociationTests().fixture()
        observer.baseline = state.build_associated()
        observer.baseline.begin_input()
        observer.armed = observer.bus_identity_matched = True
        observer.monitor = Mock()
        observer.monitor.is_closed.return_value = observer.control.is_closed.return_value = False
        observer.cancellable.is_cancelled.return_value = False
        observer.bound_bus_connections = (observer.control, observer.monitor)
        observer.Gio.DBusError.NAME_HAS_NO_OWNER = 3
        observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,))
            for v in (':1.40', 12, 1001, ':1.40')] + [error()]
        state.reads.clear()
        self.addCleanup(observer.close)
        return observer, state, error

    @staticmethod
    def observe(observer):
        return observer.baseline.observe(':1.40', observer.peer, budget=observer.budget,
            recheck_peer=lambda name: observer.peer(name, historical=True))

    def test_recorded_second_owner_before_disconnect_is_historical_never_live_or_authorizing(self):
        observer, state, _ = self.fixture()
        value = self.observe(observer)
        self.assertIs(value['stable'], False)
        self.assertIs(value['connectionLive'], False)
        self.assertTrue(value['correlatesToOriginalPopen'])
        self.assertEqual(value['externalAssociation'], state.data)
        self.assertEqual(value['peer'], dict(name=':1.40', pid=12, uid=1001))
        self.assertEqual(value['historicalDisconnected'], dict(method='GetNameOwner', step='owner-before',
            registeredGIError=True, domain='g-dbus-error-quark', code=3,
            remoteErrorName='org.freedesktop.DBus.Error.NameHasNoOwner', initialCredentialsVerified=True,
            heldProxyRechecked=True, sameBusConnection=True))
        self.assertNotIn('unavailable', value); self.assertNotIn('failureStage', value)
        for name in ('qualified', 'inputPermitted'): self.assertIs(value[name], False)
        self.assertEqual(state.reads, [(12, True), (12, True)])
        self.assertEqual([call.args[3] for call in observer.control.call_sync.call_args_list],
            ['GetNameOwner', 'GetConnectionUnixProcessID', 'GetConnectionUnixUser', 'GetNameOwner', 'GetNameOwner'])
        self.assertTrue(all(call.args[7:] == (500, observer.cancellable)
                            for call in observer.control.call_sync.call_args_list))
        self.assertNotIn('PRIVATE', str(value))

    def test_disconnected_before_first_read_or_incomplete_initial_credentials_never_bind(self):
        values = (':1.40', 12, 1001, ':1.40')
        for index in range(4):
            with self.subTest(index=index):
                observer, state, error = self.fixture()
                observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,))
                    for v in values[:index]] + [error()]
                value = self.observe(observer)
                self.assertFalse(value['stable']); self.assertFalse(value['correlatesToOriginalPopen'])
                self.assertEqual(value['failureStage'], 'live-sender-credentials')
                self.assertNotIn('historicalDisconnected', value)
                self.assertEqual(observer.control.call_sync.call_count, index + 1)
                self.assertEqual(state.reads, [])

    def test_only_second_owner_before_exact_registered_no_owner_can_be_historical(self):
        values = (':1.40', 12, 1001, ':1.40')
        for case in ('pid', 'uid', 'owner-after', 'timeout', 'domain', 'code', 'remote', 'plain', 'getter'):
            with self.subTest(case=case):
                observer, _, error = self.fixture()
                extra = values[:{'pid': 1, 'uid': 2, 'owner-after': 3}.get(case, 0)]
                failure = error(domain='g-io-error-quark') if case == 'domain' else error(code=24) if case == 'code' else (
                    error(remote='org.freedesktop.DBus.Error.Timeout') if case in ('timeout', 'remote') else
                    RuntimeError('PRIVATE') if case == 'plain' else error())
                if case == 'getter': observer.Gio.DBusError.get_remote_error.side_effect = ValueError('PRIVATE')
                observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,)) for v in values + extra] + [failure]
                value = self.observe(observer)
                self.assertFalse(value['stable']); self.assertFalse(value['correlatesToOriginalPopen'])
                self.assertNotIn('historicalDisconnected', value)
                self.assertEqual(observer.control.call_sync.call_count, 5 + len(extra))

    def test_wrong_credentials_or_reused_changed_dead_proxy_refuse_before_disconnect_fallback(self):
        for case in ('name', 'pid', 'uid', 'start', 'parent', 'image', 'held-image', 'system-image', 'exit', 'gone'):
            with self.subTest(case=case):
                observer, state, error = self.fixture()
                values = (':1.41' if case == 'name' else ':1.40', 99 if case == 'pid' else 12,
                          1002 if case == 'uid' else 1001, ':1.40')
                observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,)) for v in values] + [error()]
                if case == 'start': state.rows[12]['startTime'] = '999'
                if case == 'parent': state.rows[12]['parentPid'] = 999
                if case == 'image': state.rows[12]['kernelImageSha256'] = 'f' * 64
                if case == 'held-image': observer.baseline.held[12].snapshot = lambda: ({}, 'f' * 64)
                if case == 'system-image': state.system.snapshot = lambda: ({}, 'f' * 64)
                if case == 'exit': state.pidfds.ready.return_value = True
                if case == 'gone': del state.rows[12]
                value = self.observe(observer)
                self.assertFalse(value['correlatesToOriginalPopen']); self.assertNotIn('historicalDisconnected', value)
                self.assertLessEqual(observer.control.call_sync.call_count, 4)

    def test_changed_closed_unmatched_bus_cancel_stop_or_expiry_cannot_be_historical(self):
        for case in ('unmatched', 'control-replaced', 'monitor-replaced', 'control-closed', 'monitor-closed',
                     'not-armed', 'closed', 'stop', 'cancel', 'expiry'):
            with self.subTest(case=case):
                observer, _, _ = self.fixture()
                if case == 'unmatched': observer.bus_identity_matched = False
                if case == 'control-replaced': observer.bound_bus_connections = (Mock(), observer.monitor)
                if case == 'monitor-replaced': observer.bound_bus_connections = (observer.control, Mock())
                if case == 'control-closed': observer.control.is_closed.return_value = True
                if case == 'monitor-closed': observer.monitor.is_closed.return_value = True
                if case == 'not-armed': observer.armed = False
                if case == 'closed': observer.closed = True
                if case == 'cancel': observer.cancellable.is_cancelled.return_value = True
                if case in ('stop', 'expiry'):
                    observer.budget = lambda: (_ for _ in ()).throw(ValueError())
                value = self.observe(observer)
                self.assertFalse(value['stable']); self.assertNotIn('historicalDisconnected', value)
                self.assertFalse(value['correlatesToOriginalPopen'])

    def test_replayed_observation_and_ancestry_only_lineage_cannot_use_historical_result(self):
        observer, _, _ = self.fixture()
        self.assertIn('historicalDisconnected', self.observe(observer))
        self.assertNotIn('historicalDisconnected', self.observe(observer))
        state = PreInputLineageTests().fixture()
        baseline = state.build(); baseline.begin_input()
        try:
            value = baseline.observe(':1.40', lambda name: dict(name=name, pid=12, uid=1001),
                budget=lambda: None, recheck_peer=lambda _: M.DISCONNECTED_PEER)
            self.assertFalse(value['stable']); self.assertNotIn('historicalDisconnected', value)
        finally:
            baseline.close()

    def test_passive_worker_passes_historical_context_only_after_first_credentials(self):
        observer, state, _ = self.fixture()
        observer.input_started = True
        observer.pending = [message(), message(2)]
        observer.headers = copy.deepcopy(observer.pending)
        observer.worker = threading.Thread(target=observer.run, daemon=True)
        observer.worker.start()
        try:
            self.assertTrue(observer.settled.wait(2))
            value = observer.close()
            self.assertTrue(value['callReplyMatched']); self.assertTrue(value['workerStopped'])
            self.assertFalse(value['senderObservation']['stable'])
            self.assertIn('historicalDisconnected', value['senderObservation'])
            self.assertFalse(value['authorityGranted']); self.assertFalse(value['inputPermitted'])
            self.assertEqual(state.reads, [(12, True), (12, True)])
        finally:
            observer.close()
            observer.worker.join(timeout=2)
            self.assertFalse(observer.worker.is_alive())

    def late_exit_fixture(self, *, signalled=True, failure=None):
        observer, state, error = self.fixture()
        observer.budget = lambda: M.PassiveCapture.budget(observer)
        original_read = observer.baseline.read
        reads = []
        def read(pid, image):
            reads.append((pid, image))
            if len(reads) == 2:
                state.pidfds.ready.return_value = signalled
                raise failure if failure is not None else FileNotFoundError('PRIVATE')
            return original_read(pid, image)
        observer.baseline.read = read
        state.pidfds.ready.reset_mock()
        return observer, state, error, reads

    def test_late_exit_needs_positive_held_pidfd_and_exact_disconnect_without_live_authority(self):
        observer, state, _, reads = self.late_exit_fixture()
        value = self.observe(observer)
        self.assertTrue(value['correlatesToOriginalPopen'])
        self.assertEqual(value['externalAssociation'], state.data)
        self.assertFalse(value['stable']); self.assertFalse(value['connectionLive'])
        self.assertFalse(value['qualified']); self.assertFalse(value['inputPermitted'])
        self.assertEqual(value['historicalDisconnected'], dict(method='GetNameOwner', step='owner-before',
            registeredGIError=True, domain='g-dbus-error-quark', code=3,
            remoteErrorName='org.freedesktop.DBus.Error.NameHasNoOwner', initialCredentialsVerified=True,
            heldProxyRechecked=False, sameBusConnection=True, lateProxyExit=dict(check='process-after',
                error='FileNotFoundError', priorChecksMatched=True, heldPidfdSignalled=True)))
        self.assertEqual(reads, [(12, True), (12, True)])
        self.assertEqual([c.args for c in state.pidfds.ready.call_args_list], [(observer.baseline.fds[12],)] * 3)
        self.assertEqual(observer.control.call_sync.call_count, 5)
        self.assertNotIn('PRIVATE', json.dumps(value)); self.assertNotIn('failureStage', value)
        replay = self.observe(observer)
        self.assertFalse(replay['correlatesToOriginalPopen']); self.assertNotIn('historicalDisconnected', replay)

    def test_late_missing_record_without_exit_or_other_read_errors_never_rechecks_peer(self):
        class OtherMissing(FileNotFoundError): pass
        for signal, failure in ((False, None), (1, None), (True, PermissionError()),
                                (True, ProcessLookupError()), (True, OSError()), (True, OtherMissing())):
            with self.subTest(signal=signal, failure=type(failure).__name__):
                observer, _, _, reads = self.late_exit_fixture(signalled=signal, failure=failure)
                value = self.observe(observer)
                self.assertFalse(value['correlatesToOriginalPopen']); self.assertFalse(value['stable'])
                self.assertNotIn('historicalDisconnected', value)
                self.assertEqual(value['failureStage'], 'live-prebound-proxy')
                self.assertEqual(value['proxyRecheck']['check'], 'process-after')
                self.assertEqual(observer.control.call_sync.call_count, 4)
                self.assertEqual(len(reads), 2)

    def test_late_exit_invalid_pidfd_or_changed_bus_cancel_expiry_or_live_owner_still_refuse(self):
        for case in ('pidfd', 'control-replaced', 'monitor-closed', 'control-closed', 'monitor-replaced',
                     'not-armed', 'unmatched', 'closed', 'stop', 'cancel', 'expiry', 'live-owner', 'wrong-error'):
            with self.subTest(case=case):
                observer, state, error, _ = self.late_exit_fixture()
                missing_read = observer.baseline.read
                def read(pid, image):
                    try:
                        return missing_read(pid, image)
                    except FileNotFoundError:
                        if case == 'pidfd': state.pidfds.ready.side_effect = OSError('PRIVATE')
                        if case == 'control-replaced': observer.bound_bus_connections = (Mock(), observer.monitor)
                        if case == 'monitor-closed': observer.monitor.is_closed.return_value = True
                        if case == 'control-closed': observer.control.is_closed.return_value = True
                        if case == 'monitor-replaced': observer.bound_bus_connections = (observer.control, Mock())
                        if case == 'not-armed': observer.armed = False
                        if case == 'unmatched': observer.bus_identity_matched = False
                        if case == 'closed': observer.closed = True
                        if case == 'stop': observer.stop.set()
                        if case == 'cancel': observer.cancellable.is_cancelled.return_value = True
                        if case == 'expiry': observer.transcript.deadline = 0
                        raise
                observer.baseline.read = read
                values = (':1.40', 12, 1001, ':1.40')
                if case == 'live-owner':
                    observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,)) for v in values * 2]
                if case == 'wrong-error':
                    observer.control.call_sync.side_effect = [SimpleNamespace(unpack=lambda v=v: (v,)) for v in values] + [error(code=24)]
                value = self.observe(observer)
                self.assertFalse(value['correlatesToOriginalPopen']); self.assertFalse(value['stable'])
                self.assertNotIn('historicalDisconnected', value); self.assertNotIn('PRIVATE', json.dumps(value))

    def test_returned_final_identity_mismatch_is_never_treated_as_late_exit(self):
        for key, changed in (('startTime', '999'), ('parentPid', 999), ('uids', [1002] * 4),
                             ('kernelImageSha256', 'f' * 64)):
            with self.subTest(key=key):
                observer, state, _ = self.fixture()
                original_read = observer.baseline.read
                reads = []
                def read(pid, image):
                    row = original_read(pid, image); reads.append(pid)
                    if len(reads) == 2:
                        state.pidfds.ready.return_value = True
                        return dict(row, **{key: changed})
                    return row
                observer.baseline.read = read
                value = self.observe(observer)
                self.assertFalse(value['correlatesToOriginalPopen']); self.assertNotIn('historicalDisconnected', value)
                self.assertEqual(value['proxyRecheck']['check'], 'process-after')
                self.assertEqual(observer.control.call_sync.call_count, 4)


class RealGioQueryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Linux held pidfd and disposable private bus')
    def test_real_child_exit_and_private_bus_disconnect_feed_only_the_late_historical_branch(self):
        import subprocess
        required = os.environ.get('CREATOR_FLATPAK_REAL_GI_REQUIRED') == 'true'
        if not hasattr(os, 'pidfd_open') or importlib.util.find_spec('gi') is None or not all(
                Path(p).is_file() for p in ('/usr/bin/dbus-run-session', '/usr/bin/dbus-daemon')):
            if required: self.fail('Required pidfd/private-bus tooling is unavailable')
            self.skipTest('Required pidfd/private-bus tooling unavailable')
        code = r'''
import importlib.util,json,os,select,signal,subprocess,sys,threading,time
from types import SimpleNamespace
from gi.repository import Gio,GLib
signal.alarm(10)
spec=importlib.util.spec_from_file_location('late_exit_test',sys.argv[1])
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t);m=t.M
address=os.environ['DBUS_SESSION_BUS_ADDRESS']
flags=Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
connections=[Gio.DBusConnection.new_for_address_sync(address,flags,None,None) for _ in range(2)]
for connection in connections: connection.set_exit_on_close(False)
control,monitor=connections
child_code="""import os,signal,sys
from gi.repository import Gio
signal.alarm(8)
flags=Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
c=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],flags,None,None)
c.set_exit_on_close(False)
print(c.get_unique_name(),flush=True)
sys.stdin.buffer.read(1)
c.close_sync(None)
"""
child=subprocess.Popen([sys.executable,'-I','-B','-c',child_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
fd=None
try:
    name=child.stdout.readline().decode().strip();assert m.unique(name)
    fd=os.pidfd_open(child.pid,0)
    assert not select.select([fd],[],[],0)[0]
    observer=m.PassiveCapture(dict(name=':1.999999',pid=os.getpid()),{},{},None,None,None,address,os.getuid())
    observer.Gio,observer.GLib,observer.control,observer.monitor=Gio,GLib,control,monitor
    observer.cancellable=Gio.Cancellable.new();observer.armed=observer.bus_identity_matched=True
    observer.bound_bus_connections=(control,monitor)
    lost=[]
    def owner_changed(*args):
        if args[5].unpack()==(name,name,''): lost.append(True)
    subscription=control.signal_subscribe('org.freedesktop.DBus','org.freedesktop.DBus','NameOwnerChanged',
        '/org/freedesktop/DBus',name,Gio.DBusSignalFlags.NONE,owner_changed)
    # Prior binding is a fixture; credentials, process exit and bus disconnect are real.
    row=t.process(child.pid,os.getpid(),full=True);row['uids']=[os.getuid()]*4
    baseline=object.__new__(m.AssociatedProxyLineage)
    baseline.lock=threading.Lock();baseline.closed=False;baseline.started=True;baseline.used=False
    baseline.original=baseline.client=row;baseline.rows={child.pid:row};baseline.redact=lambda value:dict(value)
    baseline.chains={child.pid:[child.pid]};baseline.client_chain=[child.pid]
    baseline.fds={child.pid:fd};baseline.pidfds=SimpleNamespace(ready=lambda held:bool(select.select([held],[],[],0)[0]))
    image=SimpleNamespace(snapshot=lambda:(row['image'],row['kernelImageSha256']))
    baseline.held={child.pid:image};baseline.system=image;baseline.association={'fixtureOnly':True}
    reads=[]
    def read(pid,image):
        assert pid==child.pid and image is True;reads.append(pid)
        if len(reads)==1:
            assert child.poll() is None
            return row.copy()
        assert len(reads)==2
        child.stdin.close();assert child.wait(timeout=3)==0
        deadline=time.monotonic()+2
        while not lost and time.monotonic()<deadline:
            GLib.MainContext.default().iteration(False);time.sleep(.001)
        assert lost
        with open('/proc/'+str(pid)+'/stat','rb') as stream: stream.read(1)
        raise AssertionError('Reaped fixture process unexpectedly exists')
    baseline.read=read
    value=baseline.observe(name,observer.peer,budget=observer.budget,
        recheck_peer=lambda name:observer.peer(name,historical=True))
    assert value.get('peer')==dict(name=name,pid=child.pid,uid=os.getuid()),json.dumps(value)
    assert len(reads)==2 and value['correlatesToOriginalPopen'] is True
    assert value['stable'] is False and value['connectionLive'] is False
    assert value['qualified'] is False and value['inputPermitted'] is False
    marker=value['historicalDisconnected']
    assert marker['heldProxyRechecked'] is False
    assert marker['lateProxyExit']==dict(check='process-after',error='FileNotFoundError',priorChecksMatched=True,heldPidfdSignalled=True)
    control.signal_unsubscribe(subscription)
    print(json.dumps(dict(realCredentials=True,heldPidfdExit=True,privateBusDisconnect=True,
        mockedPreInputSeal=True,nativeInput=False,releaseReady=False)))
finally:
    if child.stdin is not None and not child.stdin.closed: child.stdin.close()
    child.wait(timeout=3)
    child.stdout.close();child.stderr.close()
    if fd is not None: os.close(fd)
    for connection in reversed(connections):
        if not connection.is_closed(): connection.close_sync(None)
'''
        with tempfile.TemporaryDirectory(prefix='creator-private-late-exit-') as directory:
            root = Path(directory)
            for name in ('config', 'data', 'cache', 'runtime'): (root / name).mkdir(mode=0o700)
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'),
                   'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache'),
                   'XDG_RUNTIME_DIR': str(root / 'runtime'), 'LC_ALL': 'C.UTF-8'}
            result = subprocess.run(['/usr/bin/dbus-run-session', '--dbus-daemon=/usr/bin/dbus-daemon', '--',
                sys.executable, '-I', '-B', '-c', code, str(Path(__file__).resolve())],
                env=env, capture_output=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-4096:].decode('utf8', errors='replace'))
        self.assertLessEqual(len(result.stdout), 4096); self.assertLessEqual(len(result.stderr), 4096)
        self.assertEqual(json.loads(result.stdout), dict(realCredentials=True, heldPidfdExit=True,
            privateBusDisconnect=True, mockedPreInputSeal=True, nativeInput=False, releaseReady=False))

    @unittest.skipUnless(sys.platform == 'linux', 'Linux registered GI and disposable private bus')
    def test_verified_private_peer_disconnect_is_historical_only_on_second_owner_before(self):
        import subprocess
        required = os.environ.get('CREATOR_FLATPAK_REAL_GI_REQUIRED') == 'true'
        if importlib.util.find_spec('gi') is None or not all(Path(p).is_file() for p in ('/usr/bin/dbus-run-session', '/usr/bin/dbus-daemon')):
            if required: self.fail('Required registered GI/private-bus tooling is unavailable')
            self.skipTest('Registered GI/private-bus tooling unavailable')
        code = r'''
import importlib.util,json,os,signal,sys,time
from gi.repository import Gio,GLib
signal.alarm(5)
spec=importlib.util.spec_from_file_location('private_disconnect_probe',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
flags=Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
address=os.environ['DBUS_SESSION_BUS_ADDRESS']
connections=[Gio.DBusConnection.new_for_address_sync(address,flags,None,None) for _ in range(3)]
for connection in connections: connection.set_exit_on_close(False)
control,monitor,peer=connections
observer=m.PassiveCapture(dict(name=':1.999999',pid=os.getpid()),{},{},None,None,None,address,os.getuid())
observer.Gio,observer.GLib,observer.control,observer.monitor=Gio,GLib,control,monitor
observer.cancellable=Gio.Cancellable.new()
try:
    ids=[connection.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetId',
        None,GLib.VariantType.new('(s)'),Gio.DBusCallFlags.NONE,500,None).unpack()[0] for connection in connections]
    assert len(set(ids))==1
    observer.armed=observer.bus_identity_matched=True
    observer.bound_bus_connections=(control,monitor)
    name=peer.get_unique_name()
    lost=[]
    def owner_changed(*args):
        if args[5].unpack()==(name,name,''): lost.append(True)
    subscription=control.signal_subscribe('org.freedesktop.DBus','org.freedesktop.DBus','NameOwnerChanged',
        '/org/freedesktop/DBus',name,Gio.DBusSignalFlags.NONE,owner_changed)
    initial=observer.peer(name)
    assert initial==dict(name=name,pid=os.getpid(),uid=os.getuid())
    peer.close_sync(None)
    deadline=time.monotonic()+2
    while not lost and time.monotonic()<deadline:
        GLib.MainContext.default().iteration(False)
        time.sleep(.001)
    assert lost,'Owned private peer disconnect notification missing'
    assert observer.peer(name,historical=True) is m.DISCONNECTED_PEER
    failure=observer.query_failure
    assert failure['method']=='GetNameOwner' and failure['step']=='owner-before'
    assert failure['registeredGIError'] is True and failure['domain']=='g-dbus-error-quark' and failure['code']==3
    assert failure['remoteErrorName']=='org.freedesktop.DBus.Error.NameHasNoOwner'
    try: observer.peer(name)
    except GLib.Error: pass
    else: raise AssertionError('Disconnected before first read was accepted')
    control.signal_unsubscribe(subscription)
    print(json.dumps(dict(initialCredentialsVerified=True,privatePeerDisconnected=True,
        exactHistoricalResult=True,firstReadStillRefused=True,sharedBusUsed=False,nativeInput=False,releaseReady=False)))
finally:
    for connection in reversed(connections):
        if not connection.is_closed(): connection.close_sync(None)
'''
        with tempfile.TemporaryDirectory(prefix='creator-private-gi-disconnect-') as directory:
            root = Path(directory)
            for name in ('config', 'data', 'cache', 'runtime'): (root / name).mkdir(mode=0o700)
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'),
                   'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache'),
                   'XDG_RUNTIME_DIR': str(root / 'runtime'), 'LC_ALL': 'C.UTF-8'}
            result = subprocess.run(['/usr/bin/dbus-run-session', '--dbus-daemon=/usr/bin/dbus-daemon', '--',
                sys.executable, '-I', '-B', '-c', code, str(Path(M.__file__).resolve())],
                env=env, capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-4096:].decode('utf8', errors='replace'))
        self.assertLessEqual(len(result.stdout), 4096); self.assertLessEqual(len(result.stderr), 4096)
        value = M.json.loads(result.stdout)
        self.assertEqual(value, dict(initialCredentialsVerified=True, privatePeerDisconnected=True,
            exactHistoricalResult=True, firstReadStillRefused=True, sharedBusUsed=False, nativeInput=False, releaseReady=False))

    @unittest.skipUnless(sys.platform == 'linux', 'Linux registered GI and disposable private bus')
    def test_nonexistent_name_on_new_private_bus_retains_registered_error_and_timeout_distinction(self):
        import subprocess
        required = os.environ.get('CREATOR_FLATPAK_REAL_GI_REQUIRED') == 'true'
        if importlib.util.find_spec('gi') is None or not all(Path(p).is_file() for p in ('/usr/bin/dbus-run-session', '/usr/bin/dbus-daemon')):
            if required: self.fail('Required registered GI/private-bus tooling is unavailable')
            self.skipTest('Registered GI/private-bus tooling unavailable; mandatory post-provision probe required')
        code = r'''
import importlib.util,json,os,signal,sys
from gi.repository import Gio,GLib
signal.alarm(5)
spec=importlib.util.spec_from_file_location('private_query_probe',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
address=os.environ['DBUS_SESSION_BUS_ADDRESS']
assert address.startswith('unix:')
flags=Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
connection=Gio.DBusConnection.new_for_address_sync(address,flags,None,None)
connection.set_exit_on_close(False)
observer=object.__new__(m.PassiveCapture)
observer.Gio,observer.GLib,observer.control=Gio,GLib,connection
observer.cancellable=Gio.Cancellable.new();observer.budget=lambda:None;observer.query_failure=None
try:
    try: observer.query('GetNameOwner',':999999.999999','(s)',step='owner-before')
    except GLib.Error as error:
        assert isinstance(error,GLib.Error)
        value=observer.query_failure
        assert value['registeredGIError'] is True and value['domain']=='g-dbus-error-quark'
        assert value['code']==int(Gio.DBusError.NAME_HAS_NO_OWNER)
        assert value['remoteErrorName']=='org.freedesktop.DBus.Error.NameHasNoOwner'
        assert value['method']=='GetNameOwner' and value['step']=='owner-before'
        assert value['failedMonotonicNs']>=value['startedMonotonicNs']
        assert 'message' not in value
    else: raise AssertionError('Nonexistent private-bus name unexpectedly exists')
    timeout=GLib.Error.new_literal(Gio.io_error_quark(),'PRIVATE_SYNTHETIC_LOCAL_TIMEOUT',int(Gio.IOErrorEnum.TIMED_OUT))
    local=m.query_error_metadata(timeout,Gio,GLib)
    assert local['registeredGIError'] is True and local['domain']=='g-io-error-quark'
    assert local['code']==int(Gio.IOErrorEnum.TIMED_OUT) and local['remoteErrorName'] is None
    assert 'PRIVATE' not in str(local)
    print(json.dumps({'privateBusNameHasNoOwner':value,'registeredLocalTimeout':local,'sharedBusUsed':False,'nativeInput':False}))
finally:
    connection.close_sync(None)
'''
        with tempfile.TemporaryDirectory(prefix='creator-private-gi-query-') as directory:
            root = Path(directory)
            for name in ('config', 'data', 'cache', 'runtime'): (root / name).mkdir(mode=0o700)
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'),
                   'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache'),
                   'XDG_RUNTIME_DIR': str(root / 'runtime'), 'LC_ALL': 'C.UTF-8'}
            result = subprocess.run(['/usr/bin/dbus-run-session', '--dbus-daemon=/usr/bin/dbus-daemon', '--',
                sys.executable, '-I', '-B', '-c', code, str(Path(M.__file__).resolve())],
                env=env, capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-4096:].decode('utf8', errors='replace'))
        self.assertLessEqual(len(result.stdout), 8192); self.assertLessEqual(len(result.stderr), 4096)
        value = M.json.loads(result.stdout)
        self.assertFalse(value['sharedBusUsed']); self.assertFalse(value['nativeInput'])
        self.assertEqual(value['privateBusNameHasNoOwner']['remoteErrorName'], 'org.freedesktop.DBus.Error.NameHasNoOwner')


if __name__ == '__main__':
    unittest.main()
