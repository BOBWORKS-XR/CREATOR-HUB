"""Finite private-CI Host1 diagnostics. Import-only; never grants input or acceptance.

Gio filters run on its message thread: only bounded headers are queued there.
Credential/proc reads run on one diagnostic worker, never in that callback.
Primary contracts: docs.gtk.org/gio/method.DBusConnection.add_filter.html and
dbus.freedesktop.org/doc/dbus-specification.html#bus-messages-become-monitor.
"""
import copy
import json
import os
import re
import sys
import threading
import time

NAME = 'com.creatorworks.hub.Host'
PATH = '/com/creatorworks/hub/Host'
INTERFACE = 'com.creatorworks.hub.Host1'
SECONDS, MAX_MESSAGES, MAX_PENDING, MAX_ANCESTORS, MAX_OUTPUT = 15, 64, 8, 12, 32768


def require(value):
    if not value:
        raise ValueError('Finite diagnostic contract refused')


def unique(value):
    return type(value) is str and len(value) <= 255 and re.fullmatch(r':[0-9]+\.[0-9]+', value) is not None


def bounded(value, maximum=MAX_OUTPUT):
    require(len(json.dumps(value, allow_nan=False, ensure_ascii=True).encode()) <= maximum)
    return copy.deepcopy(value)


class Transcript:
    def __init__(self, owner, *, clock=time.monotonic):
        require(unique(owner))
        self.owner, self.clock, self.deadline = owner, clock, clock() + SECONDS
        self.lock = threading.Lock()
        self.value = dict(readOnly=True, qualified=False, inputPermitted=False, authorityGranted=False,
                          releaseReady=False, callReplyMatched=False, deadlineExceeded=False,
                          closed=False, messageCount=0)

    def add(self, record):
        with self.lock:
            if self.value['closed']:
                return
            self.value['messageCount'] += 1
            try:
                if self.clock() > self.deadline:
                    self.value['deadlineExceeded'] = True
                    raise ValueError()
                require(self.value['messageCount'] <= MAX_PENDING and not self.value.get('unknown'))
                fields = {'kind', 'sender', 'destination', 'serial', 'replySerial', 'flags', 'empty'}
                require(type(record) is dict and type(record.get('kind')) is int and record['kind'] in (1, 2, 3))
                if record['kind'] == 1:
                    fields |= {'path', 'interface', 'member'}
                require(set(record) == fields and unique(record['sender'])
                        and type(record['serial']) is int and 0 < record['serial'] < 2**32
                        and type(record['replySerial']) is int and 0 <= record['replySerial'] < 2**32
                        and type(record['flags']) is int and record['empty'] is True)
                if record['kind'] == 1:
                    require(record['flags'] == 0 and 'call' not in self.value and record['sender'] != self.owner and record['replySerial'] == 0
                            and record['destination'] in (NAME, self.owner) and record['path'] == PATH
                            and record['interface'] == INTERFACE and record['member'] == 'Start')
                    self.value['call'] = bounded(record, 2048)
                else:
                    call = self.value.get('call')
                    # GLib 2.72 g_dbus_message_new_method_reply sets NO_REPLY_EXPECTED (1).
                    require(record['kind'] == 2 and record['flags'] == 1 and call is not None and 'reply' not in self.value
                            and record['sender'] == self.owner and record['destination'] == call['sender']
                            and record['replySerial'] == call['serial'])
                    self.value['reply'] = bounded(record, 2048)
                    self.value['callReplyMatched'] = True
            except Exception:
                self.value.update(unknown=True, callReplyMatched=False)

    def close(self):
        with self.lock:
            self.value['closed'] = True

    def snapshot(self):
        with self.lock:
            return bounded(self.value)


def sender_snapshot(name, original, client, read, peer, redact, *, budget, diagnostic_state=None):
    """Compare observations only. A pathname or ancestry match grants no authority."""
    result = dict(qualified=False, inputPermitted=False, stable=False, correlatesToOriginalPopen=False)
    stage = 'sender-name'

    def state():
        try:
            value = diagnostic_state() if diagnostic_state is not None else None
            require(type(value) is dict and set(value) == {'closed', 'stopRequested', 'deadlineExceeded', 'cancelled'}
                    and all(type(flag) is bool for flag in value.values()))
            return copy.deepcopy(value)
        except Exception:
            return {'unavailable': True}

    def operands(row, pid):
        # Retain numeric operands from this read, never executable paths or arbitrary strings.
        def scalar(value):
            kind = type(value)
            item = {'type': kind.__name__ if kind in (int, str, bool, list, tuple, dict, type(None)) else 'other'}
            if kind is bool or kind is int and -(2**63) <= value < 2**64:
                item['value'] = value
            elif kind is str and re.fullmatch(r'[0-9]{1,20}', value):
                item['value'] = value
            else:
                item['valueOmitted'] = True
            return item
        def uids(value):
            item = scalar(value)
            if type(value) in (list, tuple):
                item['count'] = len(value)
                if len(value) <= 4 and all(type(uid) is int and 0 <= uid < 2**31 for uid in value):
                    item['values'] = list(value)
            return item
        value = {'requestedPid': pid, 'stateAfterRead': state(), 'rowType': scalar(row)['type']}
        if type(row) is dict:
            for key in ('pid', 'parentPid', 'startTime'):
                value[key] = scalar(row[key]) if key in row else {'missing': True}
            value['uids'] = uids(row.get('uids'))
            image = row.get('image')
            if type(image) is dict:
                value['image'] = {key: scalar(image[key]) for key in (
                    'st_size', 'st_uid', 'st_gid', 'st_mode', 'st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns') if key in image}
        return bounded(value, 4096)

    try:
        require(unique(name))
        stage = 'expected-process-records'
        result['originalPopen'], result['expectedClient'] = redact(original), redact(client)
        stage = 'credentials-budget'
        result['stateBeforeOperation'] = state()
        budget()
        stage = 'credentials-read'
        credentials = peer(name)
        stage = 'credentials-validation'
        require(type(credentials) is dict and set(credentials) == {'name', 'pid', 'uid'} and credentials['name'] == name
                and type(credentials['pid']) is int and 1 < credentials['pid'] < 2**31
                and type(credentials['uid']) is int and credentials['uid'] == original['uids'][0])
        result['peer'] = credentials

        def capture(pid, full=False, *, label):
            nonlocal stage
            stage = label + '.budget'
            result['stateBeforeOperation'] = state()
            budget()
            stage = label + '.read'
            row = read(pid, False)
            if label == 'sender.0':
                try:
                    result['firstSenderRead'] = operands(row, pid)
                except Exception:
                    result['firstSenderRead'] = {'unavailable': True}
            stage = label + '.pid-match'
            require(row['pid'] == pid)
            stage = label + '.uids-match'
            require(row['uids'] == original['uids'])
            stage = label + '.uids-count'
            require(len(row['uids']) == 4)
            stage = label + '.uids-uniform'
            require(len(set(row['uids'])) == 1)
            stage = label + '.start-type'
            require(type(row['startTime']) is str)
            stage = label + '.start-value'
            require(re.fullmatch(r'[1-9][0-9]{0,19}', row['startTime']))
            stage = label + '.parent-type'
            require(type(row['parentPid']) is int)
            stage = label + '.parent-range'
            require(0 < row['parentPid'] < 2**31)
            if full:
                stage = label + '.image-size-parse'
                size = int(row['image']['st_size'])
                stage = label + '.image-size-range'
                require(0 < size <= 64 * 1024 * 1024)
                stage = label + '.full-read'
                complete = read(pid, True)
                stage = label + '.full-identity'
                require({k: v for k, v in complete.items() if k != 'kernelImageSha256'} == row)
                return complete
            return row

        def walk(pid, output, label):
            nonlocal stage
            rows, seen = [], set()
            for index in range(MAX_ANCESTORS):
                tag = f'{label}.{index}'
                stage = tag + '.ancestor-pid'
                require(pid > 1 and pid not in seen)
                seen.add(pid)
                row = capture(pid, full=index < 2, label=tag)
                stage = tag + '.append'
                output.append(redact(row)); rows.append(row)
                if pid == original['pid']:
                    stage = tag + '.original-continuity'
                    require(all(row[key] == original[key] for key in ('pid', 'parentPid', 'startTime', 'uids')))
                    return rows
                stage = tag + '.start-order'
                require(int(row['startTime']) >= int(original['startTime']))
                pid = row['parentPid']
            stage = label + '.ancestor-limit'
            raise ValueError()

        result['senderAncestors'], result['clientAncestors'] = [], []
        sender_rows = walk(credentials['pid'], result['senderAncestors'], 'sender')
        client_rows = walk(client['pid'], result['clientAncestors'], 'client')
        stage = 'sender-client-identity'
        require(sender_rows[0]['executable'] == '/usr/bin/xdg-dbus-proxy'
                and {k: v for k, v in client_rows[0].items() if k != 'kernelImageSha256'}
                == {k: v for k, v in client.items() if k != 'kernelImageSha256'})
        result['senderAfter'], result['clientAfter'] = [], []
        for label, rows, output in (('sender-recheck', sender_rows, result['senderAfter']),
                                    ('client-recheck', client_rows, result['clientAfter'])):
            for index, row in enumerate(rows):
                tag = f'{label}.{index}'
                current = capture(row['pid'], full='kernelImageSha256' in row, label=tag)
                stage = tag + '.append'
                output.append(redact(current))
                stage = tag + '.identity'
                require(current == row)
        stage = 'credentials-recheck'
        require(peer(name) == credentials)
        result.update(stable=True, correlatesToOriginalPopen=True)
    except Exception as error:
        result['failureStage'], result['stateAtFailure'] = stage, state()
        result['unavailable'] = type(error).__name__ if type(error) in (
            ValueError, KeyError, TypeError, RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, OSError) else 'OtherError'
    try:
        return bounded(result, 24576)
    except Exception:
        return dict(qualified=False, inputPermitted=False, stable=False, correlatesToOriginalPopen=False, unavailable='OutputLimit')


class OwnedLineage:
    """Seal live ancestry before input; never infer a later ancestor's exit from /proc errors."""
    def __init__(self, original, client, tree, read, redact, *, image_open, system_image, pidfds, guard, budget):
        self.original, self.client, self.tree = copy.deepcopy(original), copy.deepcopy(client), copy.deepcopy(tree)
        self.read, self.redact, self.pidfds, self.guard, self.budget = read, redact, pidfds, guard, budget
        self.system, self.rows, self.held, self.fds, self.chains = system_image, {}, {}, {}, {}
        self.started, self.used, self.closed = False, False, False
        self.lock = threading.RLock()
        try:
            require(type(tree) is dict and 0 < len(tree) <= 64
                    and all(type(pid) is int and type(row) is dict and row.get('pid') == pid for pid, row in tree.items()))
            self.validate(original); self.validate(client)
            require(original['executable'] == '/usr/bin/bwrap' and client['executable'] == '/app/bin/creator-hub-flatpak-activate'
                    and original['uids'] == client['uids'] and original['pid'] != client['pid'])
            self.guard(); self.budget()
            candidates = [pid for pid, row in tree.items() if row.get('executable') == '/usr/bin/xdg-dbus-proxy']
            require(0 < len(candidates) <= 4)
            self.client_chain = self.walk(client['pid'], image_open)
            require(self.rows[client['pid']] == client and self.rows[original['pid']] == original)
            for pid in candidates:
                self.chains[pid] = self.walk(pid, image_open)
                require((self.rows[pid]['image'], self.rows[pid]['kernelImageSha256']) == self.system.snapshot())
            self.verify_live()
        except Exception:
            self.close()
            raise

    @staticmethod
    def validate(row):
        require(type(row) is dict and set(row) == {'pid', 'parentPid', 'startTime', 'uids', 'executable', 'image', 'kernelImageSha256'}
                and all(type(row[k]) is int and 1 < row[k] < 2**31 for k in ('pid',))
                and type(row['parentPid']) is int and 0 < row['parentPid'] < 2**31
                and type(row['startTime']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', row['startTime'])
                and type(row['uids']) is list and len(row['uids']) == 4
                and all(type(uid) is int and 0 < uid < 2**31 for uid in row['uids']) and len(set(row['uids'])) == 1
                and type(row['executable']) is str and row['executable'].startswith('/') and len(row['executable']) <= 4096
                and not any(c in row['executable'] for c in ('\0', '\n', '\r')) and not row['executable'].endswith(' (deleted)')
                and type(row['kernelImageSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', row['kernelImageSha256']))
        image = row['image']
        require(type(image) is dict and set(image) == {'st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_mtime_ns', 'st_ctime_ns'}
                and all(type(v) is str and re.fullmatch(r'[0-9]{1,20}', v) for v in image.values())
                and 0 < int(image['st_size']) <= 64 * 1024 * 1024)

    def walk(self, pid, image_open):
        chain = []
        for _ in range(MAX_ANCESTORS):
            self.budget()
            require(pid in self.tree and pid not in chain)
            if pid not in self.rows:
                require(len(self.rows) < 16)
                fd = self.pidfds.open(pid)
                self.fds[pid] = fd
                held = image_open(pid)
                self.held[pid] = held
                row = self.read(pid, True)
                self.validate(row)
                require(row['pid'] == pid and row['uids'] == self.original['uids']
                        and {k: v for k, v in row.items() if k != 'kernelImageSha256'} == self.tree[pid]
                        and not self.pidfds.ready(fd)
                        and held.snapshot() == (row['image'], row['kernelImageSha256'])
                        and self.read(pid, True) == row and not self.pidfds.ready(fd))
                self.rows[pid] = copy.deepcopy(row)
            row = self.rows[pid]
            chain.append(pid)
            if pid == self.original['pid']:
                require(row == self.original)
                return chain
            parent = row['parentPid']
            require(parent in self.tree and int(self.tree[parent]['startTime']) <= int(row['startTime']))
            pid = parent
        raise ValueError('Finite pre-input ancestry exceeded')

    def verify_live(self):
        require(not self.closed and not self.started)
        self.guard()
        for pid, row in self.rows.items():
            self.budget()
            require(not self.pidfds.ready(self.fds[pid]) and self.read(pid, True) == row
                    and self.held[pid].snapshot() == (row['image'], row['kernelImageSha256'])
                    and self.read(pid, True) == row and not self.pidfds.ready(self.fds[pid]))
        for pid in self.chains:
            require(self.system.snapshot() == (self.rows[pid]['image'], self.rows[pid]['kernelImageSha256']))
        self.guard(); self.budget()

    def begin_input(self):
        with self.lock:
            self.verify_live()
            self.started = True

    def observe(self, name, peer, *, budget):
        with self.lock:
            value = dict(qualified=False, inputPermitted=False, stable=False, correlatesToOriginalPopen=False)
            stage = 'sealed-baseline'
            try:
                require(not self.closed and self.started and not self.used)
                self.used = True
                require(unique(name)); budget()
                stage = 'live-sender-credentials'
                credentials = peer(name)
                require(type(credentials) is dict and set(credentials) == {'name', 'pid', 'uid'} and credentials['name'] == name
                        and type(credentials['pid']) is int and type(credentials['uid']) is int
                        and credentials['uid'] == self.original['uids'][0])
                matches = [pid for pid in self.chains if pid == credentials['pid']]
                require(len(matches) == 1)
                pid, row = matches[0], self.rows[matches[0]]
                value.update(peer=copy.deepcopy(credentials), sealedBeforeInput=True,
                    originalPopen=self.redact(self.original), expectedClient=self.redact(self.client),
                    senderAncestors=[self.redact(self.rows[p]) for p in self.chains[pid]],
                    clientAncestors=[self.redact(self.rows[p]) for p in self.client_chain])
                stage = 'live-prebound-proxy'
                budget()
                require(not self.pidfds.ready(self.fds[pid]) and self.read(pid, True) == row
                        and self.held[pid].snapshot() == (row['image'], row['kernelImageSha256'])
                        and self.system.snapshot() == (row['image'], row['kernelImageSha256'])
                        and self.read(pid, True) == row and not self.pidfds.ready(self.fds[pid]))
                stage = 'sender-credentials-recheck'
                budget(); require(peer(name) == credentials); budget()
                # These are lifetime observations, not replacements for the sealed ancestry proof.
                value['historicalAncestors'] = [dict(pid=p, startTime=self.rows[p]['startTime'],
                    lifetime='pidfd-signalled-exit' if self.pidfds.ready(self.fds[p]) else 'not-signalled') for p in self.chains[pid]]
                value.update(stable=True, correlatesToOriginalPopen=True)
            except Exception as error:
                value.update(failureStage=stage, unavailable=type(error).__name__ if type(error) in (
                    ValueError, KeyError, RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, OSError) else 'OtherError')
            return bounded(value, 24576)

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                for image in self.held.values():
                    image.close()
            finally:
                try:
                    for fd in self.fds.values():
                        self.pidfds.close(fd)
                finally:
                    self.system.close()


class PassiveCapture:
    def __init__(self, owner, original, client, read, redact, target_guard, address, uid):
        require(type(owner) is dict and set(owner) == {'name', 'pid'} and unique(owner['name'])
                and type(owner['pid']) is int and owner['pid'] > 1)
        self.owner, self.expected_owner = owner['name'], copy.deepcopy(owner)
        self.original, self.client, self.read, self.redact = copy.deepcopy(original), copy.deepcopy(client), read, redact
        self.target_guard, self.address, self.uid = target_guard, address, uid
        self.transcript = Transcript(self.owner)
        self.lock, self.wake, self.stop = threading.Lock(), threading.Event(), threading.Event()
        self.pending, self.headers, self.total, self.closed, self.failure = [], [], 0, False, None
        self.monitor, self.control, self.filter_id, self.worker, self.timer, self.cancellable = None, None, None, None, None, None
        self.sender, self.armed, self.bus_identity_matched, self.final = None, False, False, None
        self.baseline, self.input_started, self.settled = None, False, threading.Event()

    def begin_input(self):
        require(type(self.baseline) is OwnedLineage and self.armed)
        self.baseline.begin_input()
        with self.lock:
            require(not self.closed and not self.stop.is_set() and not self.headers and not self.input_started)
            self.budget()
            self.input_started = True

    def finish_observation(self):
        # Wait only for this already-armed observation, inside its original fifteen-second budget.
        self.settled.wait(max(0, self.transcript.deadline - time.monotonic()))
        return self.close()

    def budget(self):
        require(not self.stop.is_set() and time.monotonic() <= self.transcript.deadline)

    def diagnostic_state(self):
        with self.lock:
            closed = self.closed
        return dict(closed=closed, stopRequested=self.stop.is_set(),
                    deadlineExceeded=time.monotonic() > self.transcript.deadline,
                    cancelled=False if self.cancellable is None else self.cancellable.is_cancelled())

    def query(self, method, value, kind):
        self.budget()
        require(method in ('GetNameOwner', 'GetConnectionUnixProcessID', 'GetConnectionUnixUser'))
        Gio, GLib = self.Gio, self.GLib
        return self.control.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', method,
            GLib.Variant('(s)', (value,)), GLib.VariantType.new(kind), Gio.DBusCallFlags.NONE, 500, self.cancellable).unpack()[0]

    def peer(self, name):
        require(unique(name) and self.query('GetNameOwner', name, '(s)') == name)
        value = dict(name=name, pid=self.query('GetConnectionUnixProcessID', name, '(u)'),
                     uid=self.query('GetConnectionUnixUser', name, '(u)'))
        require(self.query('GetNameOwner', name, '(s)') == name)
        return value

    def target(self):
        require(self.target_guard() == self.expected_owner and self.query('GetNameOwner', NAME, '(s)') == self.owner)
        value = self.peer(self.owner)
        require(value == dict(name=self.owner, pid=self.expected_owner['pid'], uid=self.uid))

    def arm(self):
        require(not self.closed and not self.armed and self.control is None)
        from gi.repository import Gio, GLib
        require(sys.platform == 'linux' and os.getuid() == os.geteuid() == self.uid and self.uid > 0
                and type(self.address) is str and self.address.startswith('unix:') and len(self.address) <= 4096
                and not any(c in self.address for c in (';', '\n', '\r', '\0'))
                and self.address == os.environ.get('DBUS_SESSION_BUS_ADDRESS'))
        self.Gio, self.GLib = Gio, GLib
        self.cancellable = Gio.Cancellable.new()
        self.timer = threading.Timer(SECONDS, self.cancellable.cancel)
        self.timer.daemon = True; self.timer.start()
        flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
        self.control = Gio.DBusConnection.new_for_address_sync(self.address, flags, None, self.cancellable)
        self.control.set_exit_on_close(False)
        self.target()
        self.monitor = Gio.DBusConnection.new_for_address_sync(self.address, flags, None, self.cancellable)
        self.monitor.set_exit_on_close(False)
        def bus_id(connection):
            self.budget()
            value = connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetId', None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 500, self.cancellable).unpack()[0]
            require(type(value) is str and re.fullmatch(r'[a-f0-9]{32}', value))
            return value
        expected_bus = bus_id(Gio.bus_get_sync(Gio.BusType.SESSION, self.cancellable))
        require(bus_id(self.control) == expected_bus == bus_id(self.monitor))
        self.bus_identity_matched = True
        rules = [f"type='method_call',path='{PATH}',interface='{INTERFACE}',member='Start'",
                 f"type='method_return',sender='{self.owner}'", f"type='error',sender='{self.owner}'"]
        # Dedicated connection only; monitoring never calls Start or changes policy.
        self.monitor.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.Monitoring',
            'BecomeMonitor', GLib.Variant('(asu)', (rules, 0)), GLib.VariantType.new('()'),
            Gio.DBusCallFlags.NONE, 1000, self.cancellable)
        self.filter_id = self.monitor.add_filter(self.filter, None)
        self.target()
        self.armed = True
        self.worker = threading.Thread(target=self.run, name='owned-Host1-diagnostic', daemon=True)
        self.worker.start()

    def filter(self, _connection, message, incoming, _data):
        if not incoming:
            return message
        with self.lock:
            if self.closed or self.stop.is_set():
                return None
            if time.monotonic() > self.transcript.deadline:
                self.failure = 'Deadline'; self.stop.set(); self.wake.set()
                return None
            self.total += 1
            if self.total > MAX_MESSAGES:
                self.failure = 'MessageLimit'; self.stop.set(); self.wake.set()
                return None
        try:
            kind, sender = int(message.get_message_type()), message.get_sender()
            if kind == 1:
                if (message.get_path(), message.get_interface(), message.get_member()) != (PATH, INTERFACE, 'Start'):
                    return None
                if message.get_destination() not in (NAME, self.owner):
                    return None
            elif kind not in (2, 3) or sender != self.owner:
                return None
            destination = message.get_destination()
            require(unique(sender) and (unique(destination) or destination == NAME))
            # Inspect only whether the selected call/reply has an empty body; never unpack bodies.
            signature = message.get_signature()
            empty = signature in (None, '')
            if empty:
                body = message.get_body()
                empty = body is None or (body.get_type_string() == '()' and body.n_children() == 0)
            record = dict(kind=kind, sender=sender, destination=destination, serial=int(message.get_serial()),
                          replySerial=int(message.get_reply_serial()), flags=int(message.get_flags()), empty=empty)
            if kind == 1:
                record.update(path=PATH, interface=INTERFACE, member='Start')
            record = bounded(record, 2048)
            with self.lock:
                if not self.closed and len(self.headers) < MAX_PENDING:
                    self.headers.append(record)
                    self.pending.append(record)
                elif not self.closed:
                    self.failure = 'PendingLimit'; self.stop.set()
            self.wake.set()
        except Exception:
            with self.lock:
                self.failure = 'HeaderUnavailable'; self.stop.set()
            self.wake.set()
        # Monitoring messages must never reach normal method-call dispatch/reply machinery.
        return None

    def run(self):
        try:
            while not self.stop.is_set():
                self.budget()
                self.wake.wait(0.02); self.wake.clear()
                with self.lock:
                    records, self.pending = self.pending, []
                for record in records:
                    self.budget(); self.transcript.add(record)
                    value = self.transcript.snapshot()
                    if record['kind'] == 1 and value.get('call') == record and self.sender is None:
                        if self.baseline is not None:
                            result = self.baseline.observe(record['sender'], self.peer, budget=self.budget) if self.input_started else dict(
                                qualified=False, inputPermitted=False, stable=False, correlatesToOriginalPopen=False, unavailable='BeforeInput')
                        else:
                            result = sender_snapshot(record['sender'], self.original, self.client, self.read, self.peer,
                                                     self.redact, budget=self.budget, diagnostic_state=self.diagnostic_state)
                        with self.lock:
                            self.sender = result
                    if self.transcript.snapshot().get('unknown') or self.sender is not None and self.transcript.snapshot().get('reply'):
                        self.settled.set()
        except Exception as error:
            with self.lock:
                self.failure = type(error).__name__ if type(error) in (ValueError, RuntimeError, OSError) else 'OtherError'
            self.settled.set()
        finally:
            if self.closed and self.baseline is not None:
                self.baseline.close()

    def close(self):
        with self.lock:
            if self.final is not None:
                return copy.deepcopy(self.final)
            self.closed = True
            pending_at_close, headers_at_close = len(self.pending), copy.deepcopy(self.headers)
        self.stop.set(); self.wake.set()
        if self.cancellable is not None:
            self.cancellable.cancel()
        if self.worker is not None:
            self.worker.join(timeout=0.75)
        if self.timer is not None:
            self.timer.cancel()
        for connection in (self.monitor, self.control):
            if connection is not None:
                try:
                    if connection is self.monitor and self.filter_id is not None:
                        connection.remove_filter(self.filter_id); self.filter_id = None
                    connection.close(None, None)
                except Exception:
                    with self.lock:
                        self.failure = self.failure or 'CloseUnavailable'
        stopped = self.worker is None or not self.worker.is_alive()
        if stopped and self.baseline is not None:
            self.baseline.close()
        drained, drain_unavailable = 0, None
        if not stopped:
            drain_unavailable = 'WorkerStillRunning'
        else:
            # No new bus/proc reads: process only the frozen, unprocessed header suffix.
            before = self.transcript.snapshot()
            prefix = [before[key] for key in ('call', 'reply') if key in before]
            if before.get('unknown'):
                drain_unavailable = 'TranscriptUnknown'
            elif len(headers_at_close) > MAX_PENDING or before['messageCount'] != len(prefix) or headers_at_close[:len(prefix)] != prefix:
                drain_unavailable = 'CapturedPrefixMismatch'
            else:
                for record in headers_at_close[len(prefix):]:
                    self.transcript.add(record)
                    drained += 1
                with self.lock:
                    self.pending = []
        self.transcript.close()
        result = self.transcript.snapshot()
        with self.lock:
            result.update(armed=self.armed, callbackMessages=self.total, pendingAtClose=pending_at_close,
                          drainedAtClose=drained, pendingAfterClose=len(self.pending),
                          workerStopped=stopped, cleanupRequested=True,
                          inputStarted=self.input_started, busIdentityMatched=self.bus_identity_matched, observedHeaders=copy.deepcopy(self.headers))
            if drain_unavailable is not None:
                result['drainUnavailable'] = drain_unavailable
            if self.sender is not None:
                result['senderObservation'] = copy.deepcopy(self.sender)
            if self.failure:
                result['unavailable'] = self.failure
        result = bounded(result)
        with self.lock:
            self.final = result
        return copy.deepcopy(result)


if __name__ == '__main__':
    raise SystemExit('Import-only passive CI diagnostics; no standalone bus or input interface')
