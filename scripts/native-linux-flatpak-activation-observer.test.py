"""Pure passive-observer tests: no bus, app, native input or credentials read."""
import ast
import copy
import importlib.util
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch
from contextlib import ExitStack
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
        def build():
            return M.OwnedLineage(rows[10], rows[14], tree, read, lambda row: copy.deepcopy(row),
                image_open=image, system_image=system, pidfds=SimpleNamespace(open=lambda pid: pid,
                    ready=lambda fd: fd in state.dead, close=lambda fd: state.closed.append(fd)),
                guard=state.guard, budget=lambda: None)
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
