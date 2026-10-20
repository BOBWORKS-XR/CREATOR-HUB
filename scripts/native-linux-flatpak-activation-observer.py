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


def sender_snapshot(name, original, client, read, peer, redact, *, budget):
    """Compare observations only. A pathname or ancestry match grants no authority."""
    result = dict(qualified=False, inputPermitted=False, stable=False, correlatesToOriginalPopen=False)
    try:
        require(unique(name))
        result['originalPopen'], result['expectedClient'] = redact(original), redact(client)
        budget()
        credentials = peer(name)
        require(type(credentials) is dict and set(credentials) == {'name', 'pid', 'uid'} and credentials['name'] == name
                and type(credentials['pid']) is int and 1 < credentials['pid'] < 2**31
                and type(credentials['uid']) is int and credentials['uid'] == original['uids'][0])
        result['peer'] = credentials

        def capture(pid, full=False):
            budget()
            row = read(pid, False)
            require(row['pid'] == pid and row['uids'] == original['uids'] and len(row['uids']) == 4
                    and len(set(row['uids'])) == 1 and type(row['startTime']) is str
                    and re.fullmatch(r'[1-9][0-9]{0,19}', row['startTime'])
                    and type(row['parentPid']) is int and 0 < row['parentPid'] < 2**31)
            if full:
                require(0 < int(row['image']['st_size']) <= 64 * 1024 * 1024)
                complete = read(pid, True)
                require({k: v for k, v in complete.items() if k != 'kernelImageSha256'} == row)
                return complete
            return row

        def walk(pid, output):
            rows, seen = [], set()
            for index in range(MAX_ANCESTORS):
                require(pid > 1 and pid not in seen)
                seen.add(pid)
                row = capture(pid, full=index < 2)
                output.append(redact(row)); rows.append(row)
                if pid == original['pid']:
                    require(all(row[key] == original[key] for key in ('pid', 'parentPid', 'startTime', 'uids')))
                    return rows
                require(int(row['startTime']) >= int(original['startTime']))
                pid = row['parentPid']
            raise ValueError()

        result['senderAncestors'], result['clientAncestors'] = [], []
        sender_rows = walk(credentials['pid'], result['senderAncestors'])
        client_rows = walk(client['pid'], result['clientAncestors'])
        require(sender_rows[0]['executable'] == '/usr/bin/xdg-dbus-proxy'
                and {k: v for k, v in client_rows[0].items() if k != 'kernelImageSha256'}
                == {k: v for k, v in client.items() if k != 'kernelImageSha256'})
        result['senderAfter'], result['clientAfter'] = [], []
        for rows, output in ((sender_rows, result['senderAfter']), (client_rows, result['clientAfter'])):
            for row in rows:
                current = capture(row['pid'], full='kernelImageSha256' in row)
                output.append(redact(current))
                require(current == row)
        require(peer(name) == credentials)
        result.update(stable=True, correlatesToOriginalPopen=True)
    except Exception as error:
        result['unavailable'] = type(error).__name__ if type(error) in (
            ValueError, KeyError, TypeError, RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, OSError) else 'OtherError'
    try:
        return bounded(result, 24576)
    except Exception:
        return dict(qualified=False, inputPermitted=False, stable=False, correlatesToOriginalPopen=False, unavailable='OutputLimit')


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

    def budget(self):
        require(not self.stop.is_set() and time.monotonic() <= self.transcript.deadline)

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
                        result = sender_snapshot(record['sender'], self.original, self.client, self.read, self.peer,
                                                 self.redact, budget=self.budget)
                        with self.lock:
                            self.sender = result
        except Exception as error:
            with self.lock:
                self.failure = type(error).__name__ if type(error) in (ValueError, RuntimeError, OSError) else 'OtherError'

    def close(self):
        with self.lock:
            if self.final is not None:
                return copy.deepcopy(self.final)
            self.closed = True
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
        self.transcript.close()
        result = self.transcript.snapshot()
        with self.lock:
            result.update(armed=self.armed, callbackMessages=self.total, pendingAtClose=len(self.pending),
                          workerStopped=self.worker is None or not self.worker.is_alive(), cleanupRequested=True,
                          busIdentityMatched=self.bus_identity_matched, observedHeaders=copy.deepcopy(self.headers))
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
