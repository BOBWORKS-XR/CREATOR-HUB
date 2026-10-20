"""Pure passive-observer tests: no bus, app, native input or credentials read."""
import ast
import copy
import importlib.util
import io
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


class InvocationImageTests(unittest.TestCase):
    @contextmanager
    def fixture(self, kind='sudo'):
        state = SimpleNamespace(raw=b'ELF' + b'x' * 61, replacement=False, alias_changed=False, reads=[])
        state.file = invocation_stat(10, stat.S_IFREG | (0o4755 if kind == 'sudo' else 0o755))
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
            def resolve(self, **kwargs): return FixedPath('/usr/bin/python3.10' if kind == 'python' else '/usr/bin/sudo')
            def lstat(self):
                if state.alias_changed: return invocation_stat(999, state.alias.st_mode)
                return state.alias
        def opened(name, flags, **kwargs):
            return {'/': 1, 'usr': 2, 'bin': 3, 'sudo': 4, 'python3.10': 4}[name]
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
        for kind in ('python', 'sudo'):
            with self.subTest(kind=kind), self.fixture(kind) as state:
                image = M.InvocationImage(kind, lambda: None)
                self.assertEqual(image.snapshot(), M.hashlib.sha256(state.raw).hexdigest())
                self.assertEqual(str(image.path), '/usr/bin/python3.10' if kind == 'python' else '/usr/bin/sudo')
                self.assertTrue(all(count <= 65536 for count, offset in state.reads))
                image.close(); self.assertEqual(state.close.call_count, 4)

    def test_foreign_writable_special_wrong_mode_oversized_package_never_admitted(self):
        for defect in ('uid', 'gid', 'write', 'special', 'not-setuid', 'oversize'):
            with self.subTest(defect=defect), self.fixture() as state:
                if defect == 'uid': state.file.st_uid = 1001
                if defect == 'gid': state.file.st_gid = 1001
                if defect == 'write': state.file.st_mode |= 0o020
                if defect == 'special': state.file.st_mode = stat.S_IFIFO | 0o4755
                if defect == 'not-setuid': state.file.st_mode = stat.S_IFREG | 0o755
                if defect == 'oversize': state.file.st_size = 64 * 1024**2 + 1
                with self.assertRaises(ValueError): M.InvocationImage('sudo', lambda: None)
                self.assertEqual(state.reads, [])

    def test_same_path_replacement_alias_or_same_stamp_byte_mutation_refuses(self):
        for defect in ('named', 'alias', 'bytes'):
            with self.subTest(defect=defect), self.fixture() as state:
                image = M.InvocationImage('sudo', lambda: None)
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


if __name__ == '__main__':
    unittest.main()
