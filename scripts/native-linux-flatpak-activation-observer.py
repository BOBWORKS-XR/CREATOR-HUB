"""Finite private-CI Host1 diagnostics. Import-only; never grants input or acceptance.

Gio filters run on its message thread: only bounded headers are queued there.
Credential/proc reads run on one diagnostic worker, never in that callback.
Primary contracts: docs.gtk.org/gio/method.DBusConnection.add_filter.html and
dbus.freedesktop.org/doc/dbus-specification.html#bus-messages-become-monitor.
"""
import copy
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import sys
import threading
import time

NAME = 'com.creatorworks.hub.Host'
PATH = '/com/creatorworks/hub/Host'
INTERFACE = 'com.creatorworks.hub.Host1'
SECONDS, MAX_MESSAGES, MAX_PENDING, MAX_ANCESTORS, MAX_OUTPUT = 15, 64, 8, 12, 32768
PROXY_TOOL = Path('/var/lib/creator-hub-flatpak-proxy-observer/observer.py')
PROXY_RUNTIME = Path('/home/runner/work/_temp/native-linux-production-016-flatpak/runtime')
PROXY_UID = 1001
ROOT_WORKER_SECONDS = 5
PROBE_OPERATION = 'flatpak-uid-inventory-probe-1001'


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


def lineage_row(row):
    """Metadata from an existing read only; arbitrary paths, keys and strings are omitted."""
    def kind(value):
        return type(value).__name__ if type(value) in (dict, list, tuple, str, int, bool, type(None)) else 'other'
    def number(value):
        return type(value) is int and 0 <= value < 2**64 or type(value) is str and re.fullmatch(r'[0-9]{1,20}', value) is not None
    value = {'type': kind(row)}
    if type(row) is not dict:
        return value
    fields = ('pid', 'parentPid', 'startTime', 'uids', 'executable', 'image', 'kernelImageSha256')
    value.update(fieldTypes={key: kind(row[key]) for key in fields if key in row},
                 missingFields=[key for key in fields if key not in row], extraFieldCount=len(set(row) - set(fields)))
    for key in ('pid', 'parentPid', 'startTime'):
        if number(row.get(key)):
            value[key] = row[key]
    if type(row.get('uids')) in (list, tuple):
        value['uidCount'] = len(row['uids'])
        if len(row['uids']) <= 4 and all(type(uid) is int and 0 <= uid < 2**31 for uid in row['uids']):
            value['uids'] = list(row['uids'])
    if row.get('executable') in ('/usr/bin/flatpak', '/usr/bin/bwrap', '/usr/libexec/flatpak-bwrap',
                                 '/usr/bin/xdg-dbus-proxy', '/app/bin/creator-hub-flatpak-activate'):
        value['executable'] = row['executable']
    if type(row.get('kernelImageSha256')) is str and re.fullmatch(r'[a-f0-9]{64}', row['kernelImageSha256']):
        value['kernelImageSha256'] = row['kernelImageSha256']
    image = row.get('image')
    if type(image) is dict:
        keys = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_mtime_ns', 'st_ctime_ns')
        value.update(image={key: image[key] for key in keys if key in image and number(image[key])},
            imageTypes={key: kind(image[key]) for key in keys if key in image},
            missingImageFields=[key for key in keys if key not in image], extraImageFieldCount=len(set(image) - set(keys)))
    return value


def lineage_inputs(original, client, tree):
    value = dict(readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False,
                 expectedOriginal=lineage_row(original), expectedClient=lineage_row(client),
                 treeType=type(tree).__name__ if type(tree) in (dict, list, tuple, str, int, bool, type(None)) else 'other', tree=[])
    if type(tree) is dict:
        value['treeCount'] = len(tree)
        value['candidateCount'] = sum(row.get('executable') == '/usr/bin/xdg-dbus-proxy'
            for row in tree.values() if type(row) is dict) if len(tree) <= 64 else None
        for key, row in tree.items():
            if len(value['tree']) == 16:
                break
            entry = {'record': lineage_row(row)}
            if type(key) is int and 0 <= key < 2**31:
                entry['treeKey'] = key
            value['tree'].append(entry)
        value['treeTruncated'] = len(value['tree']) < len(tree)
    # Reserve space for the failing read and image operands inside the existing receipt bound.
    while len(json.dumps(value, ensure_ascii=True).encode()) > 12288 and value['tree']:
        value['tree'].pop(); value['treeTruncated'] = True
    return bounded(value, 14336)


class ProxyAssociationProc:
    """Fixed /proc metadata only. Never opens an application FD, cmdline or environ."""
    MAX_PIDS, MAX_FDS, MAX_INFO = 4096, 128, 65536

    @staticmethod
    def stamp(info):
        return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid',
                     'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))

    @classmethod
    def read_at(cls, parent, name, maximum, *, sized=False):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and (not sized or 0 < before.st_size <= maximum))
        fd = os.open(name, flags, dir_fd=parent)
        try:
            require(cls.stamp(os.fstat(fd)) == cls.stamp(before))
            body = bytearray()
            while len(body) <= maximum:
                chunk = os.read(fd, min(8192, maximum + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
            require(len(body) <= maximum and (not sized or len(body) == before.st_size)
                    and cls.stamp(os.fstat(fd)) == cls.stamp(before)
                    and cls.stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == cls.stamp(before))
            return bytes(body), cls.stamp(before)
        finally:
            os.close(fd)

    def candidates(self, uid, budget, *, diagnostic=None):
        count, found = 0, []
        scan = dict(inventoryComplete=False, scannedPids=0, scanSkipped=0, skippedTypes={}, skipped=[], skippedTruncated=False)
        if diagnostic is not None:
            require(type(diagnostic) is dict)
            diagnostic.update(scan)
            scan = diagnostic
        with os.scandir('/proc') as entries:
            for entry in entries:
                if not re.fullmatch(r'[1-9][0-9]{0,9}', entry.name):
                    continue
                count += 1
                require(count <= self.MAX_PIDS and int(entry.name) < 2**31)
                scan['scannedPids'] = count
                budget()
                observed_uid, operation = None, 'pid-stat'
                try:
                    before = entry.stat(follow_symlinks=False)
                    require(stat.S_ISDIR(before.st_mode) and type(before.st_uid) is int and 0 <= before.st_uid < 2**32)
                    observed_uid = before.st_uid
                    if observed_uid != uid:
                        continue
                    operation = 'exe-readlink'
                    target = os.readlink('/proc/' + entry.name + '/exe')
                    operation = 'pid-stat-recheck'
                    require(len(target) <= 4096 and self.stamp(entry.stat(follow_symlinks=False)) == self.stamp(before))
                except (PermissionError, FileNotFoundError, ProcessLookupError) as error:
                    kind = 'PermissionError' if isinstance(error, PermissionError) else (
                        'FileNotFoundError' if isinstance(error, FileNotFoundError) else 'ProcessLookupError')
                    scan['scanSkipped'] += 1
                    scan['skippedTypes'][kind] = scan['skippedTypes'].get(kind, 0) + 1
                    if len(scan['skipped']) < 16:
                        scan['skipped'].append(dict(pid=int(entry.name), uid=observed_uid, operation=operation, type=kind))
                    else:
                        scan['skippedTruncated'] = True
                    continue
                if target == '/usr/bin/xdg-dbus-proxy':
                    found.append(int(entry.name))
                    require(len(found) <= 4)
        scan['inventoryComplete'] = scan['scanSkipped'] == 0
        return sorted(found), count

    def info(self, pid):
        # /proc/PID/root is an intentional kernel magic link; the final leaf is not followed.
        root = os.open(f'/proc/{pid}/root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            raw, stamp = self.read_at(root, '.flatpak-info', self.MAX_INFO, sized=True)
        finally:
            os.close(root)
        parser = configparser.ConfigParser(interpolation=None, strict=True)
        parser.read_string(raw.decode('utf-8'))
        require(not parser.defaults() and parser.get('Application', 'name') == 'com.creatorworks.hub')
        fields = {'app': 'com.creatorworks.hub', 'instanceId': parser.get('Instance', 'instance-id')}
        require(re.fullmatch(r'[0-9]{1,20}', fields['instanceId']))
        for key, output in (('app-commit', 'appCommit'), ('runtime-commit', 'runtimeCommit')):
            value = parser.get('Instance', key)
            require(re.fullmatch(r'[a-f0-9]{64}', value))
            fields[output] = value
        return dict(size=len(raw), sha256=hashlib.sha256(raw).hexdigest(), fields=fields, identity=list(stamp))

    def pipes(self, pid):
        directory = os.open(f'/proc/{pid}/fd', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        info = None
        try:
            info = os.open(f'/proc/{pid}/fdinfo', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            def names():
                rows = []
                with os.scandir(directory) as entries:
                    for entry in entries:
                        require(len(rows) < self.MAX_FDS and re.fullmatch(r'[0-9]{1,10}', entry.name))
                        rows.append(entry.name)
                return sorted(rows, key=int)
            before, mappings, pipes = names(), [], []
            for name in before:
                stamp = self.stamp(os.stat(name, dir_fd=directory, follow_symlinks=False))
                require(stat.S_ISLNK(stamp[2]))
                target = os.readlink(name, dir_fd=directory)
                require(len(target) <= 4096)
                match = re.fullmatch(r'pipe:\[([0-9]{1,20})\]', target)
                if match:
                    raw, _ = self.read_at(info, name, 4096)
                    flags = re.findall(rb'^flags:\s*([0-7]{1,12})\s*$', raw, re.M)
                    inode = re.findall(rb'^ino:\s*([0-9]{1,20})\s*$', raw, re.M)
                    require(len(flags) == len(inode) == 1 and int(inode[0]) == int(match[1]))
                    access = int(flags[0], 8) & os.O_ACCMODE
                    require(access in (os.O_RDONLY, os.O_WRONLY, os.O_RDWR) and len(pipes) < 16)
                    pipes.append(dict(fd=int(name), inode=int(match[1]),
                                      access={os.O_RDONLY: 'read', os.O_WRONLY: 'write', os.O_RDWR: 'read-write'}[access]))
                require(self.stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)) == stamp
                        and os.readlink(name, dir_fd=directory) == target)
                mappings.append((name, stamp, hashlib.sha256(target.encode()).hexdigest()))
            require(names() == before)
            return pipes, hashlib.sha256(json.dumps(mappings).encode()).hexdigest()
        finally:
            try:
                if info is not None:
                    os.close(info)
            finally:
                os.close(directory)


def proxy_association_diagnostic(original, client, tree, read, *, image_open, system_image, pidfds,
                                 guard, budget, proc=None):
    """Corroborating evidence for a refused launch; never an alternative lineage admission."""
    value = dict(readOnly=True, qualified=False, inputPermitted=False, authorityGranted=False, releaseReady=False,
                 complete=False, associationObserved=False, candidates=[])
    inventory = dict(inventoryComplete=False, scannedPids=0, scanSkipped=0, skippedTypes={}, skipped=[], skippedTruncated=False)
    value['inventory'] = inventory
    proc = ProxyAssociationProc() if proc is None else proc
    held, fds, rows, stage = {}, {}, {}, 'owned-launch'
    try:
        guard(); budget()
        OwnedLineage.validate(original); OwnedLineage.validate(client)
        require(type(tree) is dict and 0 < len(tree) <= 64 and original['executable'] == '/usr/bin/bwrap'
                and client['executable'] == '/app/bin/creator-hub-flatpak-activate' and original['uids'] == client['uids'])

        def retain(pid, expected=None):
            budget()
            require(type(pid) is int and 1 < pid < 2**31 and pid not in rows and len(rows) < 16)
            fds[pid] = pidfds.open(pid)
            held[pid] = image_open(pid)
            row = read(pid, True)
            OwnedLineage.validate(row)
            require(row['pid'] == pid and row['uids'] == original['uids']
                    and (expected is None or {k: v for k, v in row.items() if k != 'kernelImageSha256'} == expected)
                    and held[pid].snapshot() == (row['image'], row['kernelImageSha256'])
                    and not pidfds.ready(fds[pid]) and read(pid, True) == row)
            rows[pid] = copy.deepcopy(row)

        chain, pid = [], client['pid']
        for _ in range(MAX_ANCESTORS):
            require(pid in tree and pid not in chain)
            retain(pid, tree[pid]); chain.append(pid)
            if pid == original['pid']:
                break
            require(rows[pid]['executable'] == ('/app/bin/creator-hub-flatpak-activate' if pid == client['pid'] else '/usr/bin/bwrap'))
            parent = rows[pid]['parentPid']
            require(parent in tree and int(tree[parent]['startTime']) <= int(rows[pid]['startTime']))
            pid = parent
        require(chain[-1] == original['pid'] and rows[original['pid']] == original and rows[client['pid']] == client)
        stage = 'candidate-inventory'
        candidates, scanned = proc.candidates(original['uids'][0], budget, diagnostic=inventory)
        require(type(inventory['scanSkipped']) is int and 0 <= inventory['scanSkipped'] <= ProxyAssociationProc.MAX_PIDS
                and type(inventory['inventoryComplete']) is bool
                and inventory['inventoryComplete'] == (inventory['scanSkipped'] == 0)
                and inventory['scannedPids'] == scanned)
        if type(candidates) is list:
            value.update(scannedPids=scanned, candidateCount=len(candidates))
        require(type(candidates) is list and 0 < len(candidates) <= 4 and len(set(candidates)) == len(candidates)
                and type(scanned) is int and len(candidates) <= scanned <= ProxyAssociationProc.MAX_PIDS)
        protected = system_image.snapshot()
        for pid in candidates:
            stage = 'candidate-image'
            retain(pid)
            row = rows[pid]
            require(row['executable'] == '/usr/bin/xdg-dbus-proxy'
                    and (row['image'], row['kernelImageSha256']) == protected
                    and int(row['image']['st_uid']) == int(row['image']['st_gid']) == 0
                    and stat.S_ISREG(int(row['image']['st_mode'])) and not int(row['image']['st_mode']) & 0o7022)
        def recheck():
            guard(); budget()
            require(system_image.snapshot() == protected)
            for pid, row in rows.items():
                budget()
                require(not pidfds.ready(fds[pid]) and read(pid, True) == row
                        and held[pid].snapshot() == (row['image'], row['kernelImageSha256'])
                        and read(pid, True) == row and not pidfds.ready(fds[pid]))
            guard(); budget()
        stage = 'instance-and-pipe-snapshot'
        recheck()
        launcher_info = proc.info(client['pid'])
        bwraps = [pid for pid in chain if rows[pid]['executable'] == '/usr/bin/bwrap']
        first_pipes = {pid: proc.pipes(pid) for pid in (*bwraps, *candidates)}
        infos = {pid: proc.info(pid) for pid in candidates}
        def public_info(info):
            return dict(sha256=info['sha256'], fields={key: info['fields'][key]
                        for key in ('app', 'instanceId', 'appCommit', 'runtimeCommit')})
        value['launcher'] = dict(process=copy.deepcopy(client), flatpakInfo=public_info(launcher_info))
        value['appBwraps'] = [dict(process=rows[pid], pipes=first_pipes[pid][0]) for pid in bwraps]
        associations = []
        for pid in candidates:
            info = infos[pid]
            matches = [dict(appPid=app, appFd=left['fd'], proxyFd=right['fd'], inode=left['inode'],
                            appAccess=left['access'], proxyAccess=right['access'])
                       for app in bwraps for left in first_pipes[app][0] for right in first_pipes[pid][0]
                       if left['inode'] == right['inode'] and left['access'] == 'read' and right['access'] == 'write']
            require(len(matches) <= 16)
            same_info = info['sha256'] == launcher_info['sha256'] and info['fields'] == launcher_info['fields']
            value['candidates'].append(dict(process=rows[pid], flatpakInfo=public_info(info), pipes=first_pipes[pid][0],
                                            infoMatchesLauncher=same_info, sharedPipes=matches))
            if same_info and matches:
                require(len({entry['inode'] for entry in matches}) == 1)
                associations.append(pid)
        stage = 'association-recheck'
        recheck()
        require(proc.info(client['pid']) == launcher_info)
        require(all(proc.pipes(pid) == snapshot for pid, snapshot in first_pipes.items())
                and all(proc.info(pid) == info for pid, info in infos.items()))
        recheck()
        stage = 'association-ambiguity'
        require(len(associations) <= 1)
        guard(); budget()
        value.update(complete=inventory['inventoryComplete'],
                     associationObserved=inventory['inventoryComplete'] and len(associations) == 1)
        if not inventory['inventoryComplete']:
            value['unavailable'] = 'IncompleteInventory'
    except Exception as error:
        value.update(complete=False, associationObserved=False, failureStage=stage,
                     unavailable=type(error).__name__ if type(error) in (ValueError, KeyError, TypeError, RuntimeError,
                         PermissionError, FileNotFoundError, ProcessLookupError, OSError) else 'OtherError')
    finally:
        cleanup = False
        for item, close in [(item, lambda x: x.close()) for item in held.values()] + [(fd, pidfds.close) for fd in fds.values()] + [(system_image, lambda x: x.close())]:
            try:
                close(item)
            except Exception:
                cleanup = True
        if cleanup:
            value.update(complete=False, associationObserved=False, cleanupUnavailable=True)
    try:
        return bounded(value, 12288)
    except Exception:
        return dict(readOnly=True, qualified=False, inputPermitted=False, authorityGranted=False, releaseReady=False,
                    complete=False, associationObserved=False, unavailable='OutputLimit')


class PrivateInstance:
    """Hold only the fixed CI runtime's instance directories and public identity files."""
    def __init__(self, info, original, runtime=PROXY_RUNTIME):
        require(type(runtime) is Path or isinstance(runtime, Path))
        self.fds, self.stamps, self.runtime = [], [], runtime
        try:
            instance = info['fields']['instanceId']
            require(re.fullmatch(r'[0-9]{1,20}', instance))
            paths = (runtime, runtime / '.flatpak', runtime / '.flatpak' / instance)
            for path in paths:
                before = path.lstat()
                require(path.resolve(strict=True) == path and stat.S_ISDIR(before.st_mode)
                        and before.st_uid == before.st_gid == PROXY_UID and not before.st_mode & 0o7022)
                require(path != runtime or stat.S_IMODE(before.st_mode) == 0o700)
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                self.fds.append(fd); self.stamps.append(ProxyAssociationProc.stamp(before))
                require(ProxyAssociationProc.stamp(os.fstat(fd)) == self.stamps[-1])
            self.paths, self.info, self.original = paths, copy.deepcopy(info), copy.deepcopy(original)
            self.expected = self.snapshot()
        except Exception:
            self.close(); raise

    def snapshot(self):
        for path, fd, stamp in zip(self.paths, self.fds, self.stamps):
            # Directory timestamps can change as Flatpak manages other instances;
            # directory identity/permissions, not unrelated child churn, are held.
            for current in (os.fstat(fd), path.lstat()):
                require(ProxyAssociationProc.stamp(current)[:7] == stamp[:7])
        raw, info_stamp = ProxyAssociationProc.read_at(self.fds[-1], 'info', 65536, sized=True)
        pid, pid_stamp = ProxyAssociationProc.read_at(self.fds[-1], 'pid', 32, sized=True)
        for stamp in (info_stamp, pid_stamp):
            require(stamp[3] == stamp[4] == PROXY_UID and stamp[5] == 1 and not stamp[2] & 0o7022)
        require(pid == str(self.original['pid']).encode() and hashlib.sha256(raw).hexdigest() == self.info['sha256'])
        value = dict(instanceId=self.info['fields']['instanceId'], infoSha256=self.info['sha256'],
                     originalPid=self.original['pid'], directories=[list(s[:6]) for s in self.stamps],
                     infoIdentity=list(info_stamp), pidIdentity=list(pid_stamp))
        if hasattr(self, 'expected'):
            require(value == self.expected)
        return value

    def close(self):
        for fd in self.fds:
            os.close(fd)
        self.fds = []


def root_request(value, now):
    require(type(value) is dict and set(value) == {'schemaVersion', 'operation', 'harnessSource', 'codeSha256',
            'sequence', 'nonce', 'expiresNs', 'original', 'client', 'tree', 'caller'}
            and type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['operation'] == 'flatpak-proxy-snapshot-uid1001'
            and type(value['sequence']) is int and 1 <= value['sequence'] <= 3
            and type(value['expiresNs']) is int and now < value['expiresNs'] <= now + ROOT_WORKER_SECONDS * 10**9
            and re.fullmatch(r'[a-f0-9]{40}', value['harnessSource'])
            and all(type(value[k]) is str and re.fullmatch(r'[a-f0-9]{64}', value[k]) for k in ('nonce', 'codeSha256')))
    validate_caller(value['caller'])
    for row in (value['original'], value['client']):
        OwnedLineage.validate(row); require(row['uids'] == [PROXY_UID] * 4)
    require(value['original']['executable'] == '/usr/bin/bwrap'
            and value['client']['executable'] == '/app/bin/creator-hub-flatpak-activate'
            and type(value['tree']) is list and 1 < len(value['tree']) <= MAX_ANCESTORS
            and len({r['pid'] for r in value['tree']}) == len(value['tree']))
    for row in value['tree']:
        OwnedLineage.validate(row); require(row['uids'] == [PROXY_UID] * 4)
    require(value['tree'][0] == value['client'] and value['tree'][-1] == value['original'])
    for child, parent in zip(value['tree'], value['tree'][1:]):
        require(child['parentPid'] == parent['pid'] and parent['executable'] == '/usr/bin/bwrap'
                and int(parent['startTime']) <= int(child['startTime'])
                and parent['image'] == value['original']['image']
                and parent['kernelImageSha256'] == value['original']['kernelImageSha256'])


def probe_hop_detail(pid, tail=(), ids=()):
    value = dict(pid=pid, parentPid=None, startTime=None, uids=None, state=None, executableKind='unread')
    try:
        if len(tail) >= 20:
            if re.fullmatch(r'[0-9]{1,10}', tail[1]) and int(tail[1]) < 2**31:
                value['parentPid'] = int(tail[1])
            if re.fullmatch(r'[0-9]{1,20}', tail[19]):
                value['startTime'] = tail[19]
            value['state'] = tail[0] if tail[0] in ('R', 'S', 'D', 'Z', 'X', 'x', 'T', 't', 'K', 'W', 'P', 'I') else 'other'
        if len(ids) == 1:
            observed = [int(uid) for uid in ids[0]]
            if len(observed) == 4 and all(0 <= uid < 2**32 for uid in observed):
                value['uids'] = observed
    except (ValueError, TypeError, OverflowError):
        pass
    return value


def inventory_failure(error, scan, entry_pid=None, entry_uids=None):
    """Retain the first failure's fixed code location and explicitly typed existing operands only."""
    try:
        if getattr(error, 'proxy_inventory_attempted', False):
            return
        error.proxy_inventory_attempted = True
        frames, trace, count = [], error.__traceback__, 0
        while trace is not None and count < 32:
            count += 1
            match = next((row for row in INVENTORY_FAILURE_FUNCTIONS if row[0] is trace.tb_frame.f_code), None)
            if match is not None:
                frames.append((match, trace.tb_frame.f_locals, trace.tb_lineno))
            trace = trace.tb_next
        if trace is not None or not frames:
            return
        (unused, function, predicate, field), operands, line = frames[-1]
        predicate = operands.get('_inventory_predicate', predicate)
        field = {'process-shape': 'stat', 'process-uids': 'status', 'executable-read': 'exe',
                 'executable-shape': 'exe', 'entry-directory': 'proc', 'uid-read': 'status'}.get(predicate, field)
        if function == 'ProxyAssociationProc.read_at':
            field = operands.get('name') if operands.get('name') in ('stat', 'status') else 'unavailable'
        subject = None
        for (unused, name, _, _), local, _ in reversed(frames):
            if name not in ('root_process', 'root_process.identity', 'root_uid_tuple',
                            'InvocationChain.identity', 'InvocationChain.recheck', 'InvocationChain.mixed_process'):
                continue
            pid = local.get('pid')
            if type(pid) is not int or not 1 < pid < 2**31:
                continue
            subject = probe_hop_detail(pid, local.get('tail', ()), local.get('ids', ()))
            row = local.get('row') if name == 'InvocationChain.recheck' else None
            if type(row) is dict and row.get('pid') == pid:
                for key in ('parentPid', 'startTime', 'uids', 'state'):
                    subject[key] = row.get(key)
            ids = local.get('ids')
            if type(ids) is list and len(ids) == 4 and all(type(uid) is int and 0 <= uid < 2**32 for uid in ids):
                subject['uids'] = list(ids)
            executable = row.get('executable') if type(row) is dict else local.get('executable')
            if type(executable) is str:
                subject['executableKind'] = ('python' if re.fullmatch(r'/usr/bin/python3\.[0-9]{1,2}', executable)
                    else {'/usr/bin/sudo': 'sudo', '/usr/bin/bwrap': 'bwrap', '/usr/bin/xdg-dbus-proxy': 'proxy',
                          '/app/bin/creator-hub-flatpak-activate': 'launcher'}.get(executable, 'other'))
            break
        value = dict(readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False,
            phase='complete-uid-inventory', scan=scan, entryPid=entry_pid, entryUids=entry_uids,
            function=function, predicate=predicate, field=field, line=line, subject=subject)
        error.proxy_inventory_diagnostic = inventory_diagnostic(value)
    except Exception:
        pass  # Diagnostics must never replace the original refusal, including serialization failures.


def inventory_diagnostic(value):
    require(type(value) is dict and set(value) == {'readOnly', 'inputPermitted', 'authorityGranted', 'releaseReady',
        'phase', 'scan', 'entryPid', 'entryUids', 'function', 'predicate', 'field', 'line', 'subject'}
        and value['readOnly'] is True and all(value[k] is False for k in ('inputPermitted', 'authorityGranted', 'releaseReady'))
        and value['phase'] == 'complete-uid-inventory' and type(value['scan']) is int and value['scan'] in (1, 2)
        and (value['entryPid'] is None or type(value['entryPid']) is int and 1 < value['entryPid'] < 2**31)
        and value['function'] in tuple(row[1] for row in INVENTORY_FAILURE_FUNCTIONS)
        and value['predicate'] in ('proc-read', 'uid-record', 'uid-range', 'process-read', 'process-shape', 'process-uids',
            'executable-read', 'executable-shape', 'process-stability', 'image-read', 'image-identity', 'image-bytes',
            'invocation-recheck', 'invocation-identity', 'mixed-membership', 'mixed-identity', 'scan-open', 'scan-budget',
            'entry-directory', 'uid-read', 'mixed-invocation', 'proxy-count', 'scan-equality', 'deadline')
        and value['field'] in ('stat', 'status', 'exe', 'proc', 'invocation', 'inventory', 'clock', 'unavailable')
        and type(value['line']) is int and 0 < value['line'] < 100000)
    def uids(ids):
        return ids is None or type(ids) is list and len(ids) == 4 and all(type(uid) is int and 0 <= uid < 2**32 for uid in ids)
    require(uids(value['entryUids']))
    subject = value['subject']
    if subject is not None:
        require(type(subject) is dict and set(subject) == {'pid', 'parentPid', 'startTime', 'uids', 'state', 'executableKind'}
            and type(subject['pid']) is int and 1 < subject['pid'] < 2**31
            and (subject['parentPid'] is None or type(subject['parentPid']) is int and 0 <= subject['parentPid'] < 2**31)
            and (subject['startTime'] is None or type(subject['startTime']) is str and re.fullmatch(r'[0-9]{1,20}', subject['startTime']))
            and uids(subject['uids']) and subject['state'] in (None, 'R', 'S', 'D', 'Z', 'X', 'x', 'T', 't', 'K', 'W', 'P', 'I', 'other')
            and subject['executableKind'] in ('unread', 'other', 'python', 'sudo', 'bwrap', 'proxy', 'launcher'))
    return bounded(value, 2048)


def root_process(pid, full=False, *, probe_diagnostic=None):
    """Read kernel proc identity only; no cmdline, environment or candidate imports."""
    require(type(pid) is int and 1 < pid < 2**31)
    directory = os.open(f'/proc/{pid}', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        def identity():
            _inventory_predicate = 'process-read'
            raw, _ = ProxyAssociationProc.read_at(directory, 'stat', 4096)
            status, _ = ProxyAssociationProc.read_at(directory, 'status', 16384)
            text = raw.decode('utf-8'); tail = text[text.rfind(')') + 2:].split()
            ids = re.findall(rb'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$', status, re.M)
            if probe_diagnostic is not None:
                kind = probe_diagnostic['executableKind']
                probe_diagnostic.update(probe_hop_detail(pid, tail, ids), executableKind=kind)
            _inventory_predicate = 'process-shape'
            require(text.startswith(str(pid) + ' (') and len(tail) >= 20 and tail[0] not in ('Z', 'X'))
            _inventory_predicate = 'process-uids'
            require(len(ids) == 1 and [int(x) for x in ids[0]] == [PROXY_UID] * 4)
            return dict(pid=pid, parentPid=int(tail[1]), startTime=tail[19], uids=[PROXY_UID] * 4)
        before = identity()
        _inventory_predicate = 'executable-read'
        executable = os.readlink('exe', dir_fd=directory)
        _inventory_predicate = 'executable-shape'
        require(0 < len(executable) <= 4096 and not executable.endswith(' (deleted)'))
        if not full:
            _inventory_predicate = 'process-stability'
            require(identity() == before and os.readlink('exe', dir_fd=directory) == executable)
            return {**before, 'executable': executable}
        require(executable in ('/usr/bin/bwrap', '/usr/bin/xdg-dbus-proxy', '/app/bin/creator-hub-flatpak-activate'))
        image_fd = os.open('exe', os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        try:
            image = os.fstat(image_fd)
            require(stat.S_ISREG(image.st_mode) and image.st_nlink > 0 and 0 < image.st_size <= 64 * 1024**2)
            digest, size = hashlib.sha256(), 0
            while chunk := os.read(image_fd, 65536):
                size += len(chunk); require(size <= image.st_size); digest.update(chunk)
            require(size == image.st_size and ProxyAssociationProc.stamp(os.fstat(image_fd)) == ProxyAssociationProc.stamp(image)
                    and ProxyAssociationProc.stamp(os.stat('exe', dir_fd=directory)) == ProxyAssociationProc.stamp(image)
                    and identity() == before and os.readlink('exe', dir_fd=directory) == executable)
            keys = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_mtime_ns', 'st_ctime_ns')
            return {**before, 'executable': executable, 'image': {k: str(getattr(image, k)) for k in keys},
                    'kernelImageSha256': digest.hexdigest()}
        finally:
            os.close(image_fd)
    except Exception as error:
        error.proxy_snapshot_pid = pid
        raise
    finally:
        os.close(directory)


def root_uid_tuple(pid):
    directory = os.open(f'/proc/{pid}', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        status, _ = ProxyAssociationProc.read_at(directory, 'status', 16384)
        ids = re.findall(rb'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$', status, re.M)
        _inventory_predicate = 'uid-record'
        require(len(ids) == 1)
        result = [int(v) for v in ids[0]]
        _inventory_predicate = 'uid-range'
        require(all(0 <= uid < 2**31 for uid in result))
        return result
    finally:
        os.close(directory)


def complete_uid_inventory(budget, *, invocation=None):
    def scan(number):
        _inventory_predicate = 'invocation-recheck'
        if invocation is not None:
            invocation.recheck()
        rows, count = {}, 0
        _inventory_predicate = 'scan-open'
        with os.scandir('/proc') as entries:
            for entry in entries:
                if not re.fullmatch(r'[1-9][0-9]{0,9}', entry.name):
                    continue
                _inventory_predicate = 'scan-budget'
                count += 1; budget(); require(count <= ProxyAssociationProc.MAX_PIDS)
                entry_uids = None
                try:
                    _inventory_predicate = 'entry-directory'
                    info = entry.stat(follow_symlinks=False)
                    require(stat.S_ISDIR(info.st_mode))
                    # proc_pid(5): non-dumpable processes' proc entries can be root-owned.
                    _inventory_predicate = 'uid-read'
                    ids = root_uid_tuple(int(entry.name)); entry_uids = ids
                    if PROXY_UID in ids:
                        if ids == [PROXY_UID] * 4:
                            _inventory_predicate = 'process-read'
                            rows[int(entry.name)] = root_process(int(entry.name))
                        else:
                            _inventory_predicate = 'mixed-invocation'
                            require(invocation is not None)
                            rows[int(entry.name)] = invocation.mixed_process(int(entry.name), ids)
                except Exception as error:
                    inventory_failure(error, number, int(entry.name), entry_uids)
                    raise
        _inventory_predicate = 'invocation-recheck'
        if invocation is not None:
            invocation.recheck()
        return rows
    number = 1
    try:
        first = scan(number); proxies = sorted(pid for pid, row in first.items() if row['executable'] == '/usr/bin/xdg-dbus-proxy')
        _inventory_predicate = 'proxy-count'
        require(len(proxies) <= 4)
        number = 2; _inventory_predicate = 'scan-equality'
        require(scan(number) == first)  # No skipped, opaque, zombie or disappeared process is adopted.
    except Exception as error:
        inventory_failure(error, number)
        raise
    return proxies, first


def complete_proxy_inventory(budget, *, invocation=None):
    proxies, rows = complete_uid_inventory(budget, invocation=invocation)
    require(0 < len(proxies) <= 4)
    return proxies, rows


def validate_caller(row):
    require(type(row) is dict and set(row) == {'pid', 'parentPid', 'startTime', 'uids', 'executable'}
            and type(row['pid']) is int and 1 < row['pid'] < 2**31
            and type(row['parentPid']) is int and 0 < row['parentPid'] < 2**31
            and type(row['startTime']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', row['startTime'])
            and type(row['uids']) is list and len(row['uids']) == 4
            and all(type(uid) is int and uid == PROXY_UID for uid in row['uids'])
            and type(row['executable']) is str and re.fullmatch(r'/usr/bin/python3\.[0-9]{1,2}', row['executable']))


def probe_request(value, now):
    require(type(value) is dict and set(value) == {'schemaVersion', 'operation', 'harnessSource', 'codeSha256',
            'sequence', 'nonce', 'expiresNs', 'caller'}
            and type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['operation'] == PROBE_OPERATION and type(value['sequence']) is int and value['sequence'] == 1
            and type(value['expiresNs']) is int and now < value['expiresNs'] <= now + ROOT_WORKER_SECONDS * 10**9
            and type(value['harnessSource']) is str and re.fullmatch(r'[a-f0-9]{40}', value['harnessSource'])
            and all(type(value[k]) is str and re.fullmatch(r'[a-f0-9]{64}', value[k]) for k in ('nonce', 'codeSha256')))
    validate_caller(value['caller'])
    require(value['caller']['executable'] == str(Path('/usr/bin/python3').resolve(strict=True)))


class InvocationImage:
    """Held fixed system package image, never a request-supplied executable."""
    def __init__(self, kind, budget):
        require(kind in ('python', 'sudo'))
        self.kind, self.budget, self.fd, self.parents = kind, budget, None, []
        self.alias = Path('/usr/bin/python3' if kind == 'python' else '/usr/bin/sudo')
        self.alias_identity = ProxyAssociationProc.stamp(self.alias.lstat())
        require(self.alias_identity[3] == self.alias_identity[4] == 0)
        self.path = self.alias.resolve(strict=True)
        require(self.path.parent == Path('/usr/bin') and (self.path == self.alias if kind == 'sudo'
                else re.fullmatch(r'python3\.[0-9]{1,2}', self.path.name)))
        try:
            parent = None
            for name in ('/', 'usr', 'bin'):
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                             **({'dir_fd': parent} if parent is not None else {}))
                self.parents.append((parent, name, fd, self.directory(os.fstat(fd))))
                parent = fd
            self.fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
            self.identity = ProxyAssociationProc.stamp(os.fstat(self.fd))
            self.digest = self.snapshot()
        except Exception as error:
            try:
                self.close()
            except Exception:
                error.invocation_cleanup_failed = True
            raise

    @staticmethod
    def directory(info):
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o7022)
        return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid

    def check(self):
        self.budget()
        require(self.fd is not None and self.alias.resolve(strict=True) == self.path
                and ProxyAssociationProc.stamp(self.alias.lstat()) == self.alias_identity)
        for parent, name, fd, expected in self.parents:
            require(self.directory(os.fstat(fd)) == expected == self.directory(os.stat(name, follow_symlinks=False,
                    **({'dir_fd': parent} if parent is not None else {}))))
        info = os.fstat(self.fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink >= 1
                and stat.S_IMODE(info.st_mode) == (0o4755 if self.kind == 'sudo' else 0o755)
                and 0 < info.st_size <= 64 * 1024**2 and ProxyAssociationProc.stamp(info) == self.identity
                == ProxyAssociationProc.stamp(os.stat(self.path.name, dir_fd=self.parents[-1][2], follow_symlinks=False)))

    def snapshot(self):
        self.check(); digest, offset = hashlib.sha256(), 0
        while offset < self.identity[6]:
            self.budget(); raw = os.pread(self.fd, min(65536, self.identity[6] - offset), offset)
            require(raw); digest.update(raw); offset += len(raw)
        require(not os.pread(self.fd, 1, offset))
        self.check()
        result = digest.hexdigest()
        require(not hasattr(self, 'digest') or result == self.digest)
        return result

    def close(self):
        failure = None
        for fd in ([self.fd] if self.fd is not None else []) + [row[2] for row in reversed(self.parents)]:
            try: os.close(fd)
            except Exception as error: failure = failure or error
        self.fd, self.parents = None, []
        if failure is not None: raise failure


class InvocationChain:
    """This worker -> optional protected sudo ancestors -> the exact unprivileged caller."""
    def __init__(self, caller, budget=lambda: None):
        self.caller, self.budget, self.images, self.held, self.rows = copy.deepcopy(caller), budget, {}, {}, []
        self.detail = dict(predicate='chain-limit', hops=[])
        try:
            validate_caller(caller)
            pid = os.getpid()
            for _ in range(5):
                kind = 'python' if not self.rows or pid == caller['pid'] else 'sudo'
                row = self.retain(pid, kind, caller=pid == caller['pid'])
                if pid == caller['pid']:
                    self.detail['predicate'] = 'caller-identity'
                    require(1 <= len(self.rows) <= 4 and self.process(row) == caller)
                    self.recheck()
                    return
                self.rows.append(row); pid = row['parentPid']
            self.detail['predicate'] = 'chain-limit'
            raise ValueError('Fixed invoking caller chain unavailable')
        except Exception as error:
            try:
                error.proxy_caller_diagnostic = bounded(self.detail, 4096)
            except Exception:
                pass
            try:
                self.close()
            except Exception:
                error.invocation_cleanup_failed = True
            raise

    @staticmethod
    def process(row):
        return {key: row[key] for key in ('pid', 'parentPid', 'startTime', 'uids', 'executable')}

    def identity(self, pid, directory, hop):
        _inventory_predicate = 'process-read'
        self.detail['predicate'] = 'hop-read'; self.budget()
        raw, _ = ProxyAssociationProc.read_at(directory, 'stat', 4096)
        status, _ = ProxyAssociationProc.read_at(directory, 'status', 16384)
        text = raw.decode('utf-8'); tail = text[text.rfind(')') + 2:].split()
        ids = re.findall(rb'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$', status, re.M)
        hop.update(probe_hop_detail(pid, tail, ids))
        self.detail['predicate'] = 'hop-process-shape'
        _inventory_predicate = 'process-shape'
        require(text.startswith(str(pid) + ' (') and len(tail) >= 20 and tail[0] not in ('Z', 'X')
                and len(ids) == 1 and hop['parentPid'] is not None and hop['startTime'] is not None)
        self.detail['predicate'] = 'hop-executable'
        _inventory_predicate = 'executable-read'
        executable = os.readlink('exe', dir_fd=directory)
        return dict(pid=pid, parentPid=int(tail[1]), startTime=tail[19], state=tail[0],
                    uids=[int(uid) for uid in ids[0]], executable=executable)

    def retain(self, pid, kind, *, caller):
        require(pid not in self.held and type(pid) is int and 1 < pid < 2**31)
        hop = probe_hop_detail(pid); hop['expectedKind'] = kind; self.detail['hops'].append(hop)
        held = self.held[pid] = dict(fds=[], hop=hop, kind=kind, caller=caller)
        self.detail['predicate'] = 'hop-read'
        held['pidfd'] = os.pidfd_open(pid); held['fds'].append(held['pidfd'])
        held['directory'] = os.open(f'/proc/{pid}', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        held['fds'].append(held['directory'])
        row = self.identity(pid, held['directory'], hop)
        if kind not in self.images:
            self.images[kind] = InvocationImage(kind, self.budget)
        image = self.images[kind]
        hop['executableKind'] = kind if row['executable'] == str(image.path) else 'other'
        require(row['executable'] == str(image.path))
        held['kernel'] = os.open('exe', os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=held['directory'])
        held['fds'].append(held['kernel'])
        require(ProxyAssociationProc.stamp(os.fstat(held['kernel'])) == image.identity)
        image.snapshot()
        self.detail['predicate'] = 'hop-credentials'
        # Preserve all-root sudo as well as the observed supervisor real UID, under identical image/proc guards.
        # https://raw.githubusercontent.com/sudo-project/sudo/SUDO_1_9_9/src/exec_nopty.c
        expected_uids = (([PROXY_UID] * 4,) if caller else ([0] * 4,) if kind == 'python'
                         else ([0] * 4, [PROXY_UID, 0, 0, 0]))
        require(row['uids'] in expected_uids)
        held['row'] = row
        return row

    def recheck(self):
        _inventory_predicate = 'invocation-recheck'
        require(self.caller['pid'] in self.held and self.images and 1 <= len(self.rows) <= 4)
        for pid, held in self.held.items():
            _inventory_predicate = 'process-read'
            row = self.identity(pid, held['directory'], held['hop']); image = self.images[held['kind']]
            held['hop']['executableKind'] = held['kind'] if row['executable'] == str(image.path) else 'other'
            _inventory_predicate = 'invocation-identity'
            require({k: v for k, v in row.items() if k != 'state'} == {k: v for k, v in held['row'].items() if k != 'state'}
                    and ProxyAssociationProc.stamp(os.fstat(held['kernel'])) == image.identity
                    == ProxyAssociationProc.stamp(os.stat('exe', dir_fd=held['directory']))
                    and not select.select([held['pidfd']], [], [], 0)[0])
            _inventory_predicate = 'image-bytes'
            image.snapshot()
        self.budget()

    def mixed_process(self, pid, ids):
        _inventory_predicate = 'mixed-membership'
        require(type(pid) is int and pid in self.held and self.held[pid]['kind'] == 'sudo'
                and type(ids) is list and all(type(uid) is int for uid in ids) and ids == [PROXY_UID, 0, 0, 0])
        self.recheck()
        _inventory_predicate = 'mixed-identity'
        row = self.held[pid]['row']; require(row['uids'] == ids)
        return self.process(row)

    def receipt(self):
        return [{**{k: row[k] for k in ('pid', 'parentPid', 'startTime', 'state', 'uids')},
                 'executableKind': 'python' if index == 0 else 'sudo',
                 'imageSha256': self.images['python' if index == 0 else 'sudo'].digest}
                for index, row in enumerate(self.rows)]

    def close(self):
        failure = None
        for held in self.held.values():
            for fd in reversed(held['fds']):
                try: os.close(fd)
                except Exception as error: failure = failure or error
        for image in self.images.values():
            try: image.close()
            except Exception as error: failure = failure or error
        self.held, self.images = {}, {}
        if failure is not None: raise failure

    def __enter__(self): return self

    def __exit__(self, kind, value, traceback):
        try:
            self.close()
        except Exception:
            if value is None: raise
            value.invocation_cleanup_failed = True


def probe_caller_chain(caller):
    with InvocationChain(caller) as invocation:
        return invocation.receipt()


def inventory_probe(request, *, clock=time.monotonic_ns):
    probe_request(request, clock())
    def budget():
        require(clock() < request['expiresNs'])
    fd = os.pidfd_open(request['caller']['pid'])
    stage = 'probe-caller-chain'
    try:
        with InvocationChain(request['caller'], budget) as invocation:
            try:
                require(not select.select([fd], [], [], 0)[0])
            except Exception as error:
                hop = probe_hop_detail(request['caller']['pid'])
                hop['expectedKind'] = 'python'
                error.proxy_caller_diagnostic = dict(predicate='caller-pidfd-live', hops=[hop])
                raise
            stage = 'complete-uid-inventory'
            proxies, rows = complete_uid_inventory(budget, invocation=invocation)
            require(rows.get(request['caller']['pid']) == request['caller'])
            stage = 'probe-recheck'
            invocation.recheck()
            require(not select.select([fd], [], [], 0)[0])
            budget()
            return dict(operation=PROBE_OPERATION, complete=True, uid=PROXY_UID, candidateCount=len(proxies),
                        scopedProcessCount=len(rows), caller=request['caller'], invocation=invocation.receipt(),
                        readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False)
    except Exception as error:
        error.proxy_snapshot_stage = stage
        raise
    finally:
        os.close(fd)


def validate_probe(value, request):
    require(type(value) is dict and set(value) == {'operation', 'complete', 'uid', 'candidateCount', 'scopedProcessCount',
            'caller', 'invocation', 'readOnly', 'inputPermitted', 'authorityGranted', 'releaseReady'}
            and value['operation'] == PROBE_OPERATION and value['complete'] is True
            and type(value['uid']) is int and value['uid'] == PROXY_UID
            and type(value['candidateCount']) is int and 0 <= value['candidateCount'] <= 4
            and type(value['scopedProcessCount']) is int and 0 < value['scopedProcessCount'] <= ProxyAssociationProc.MAX_PIDS
            and value['candidateCount'] <= value['scopedProcessCount'] and value['caller'] == request['caller']
            and value['readOnly'] is True
            and all(value[k] is False for k in ('inputPermitted', 'authorityGranted', 'releaseReady'))
            and type(value['invocation']) is list and 1 <= len(value['invocation']) <= 4)
    rows = value['invocation']
    for index, row in enumerate(rows):
        require(type(row) is dict and set(row) == {'pid', 'parentPid', 'startTime', 'state', 'uids', 'executableKind', 'imageSha256'}
                and all(type(row[k]) is int and 1 < row[k] < 2**31 for k in ('pid', 'parentPid'))
                and type(row['startTime']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', row['startTime'])
                and type(row['uids']) is list and all(type(uid) is int for uid in row['uids'])
                and row['uids'] in (([0] * 4,) if index == 0 else ([0] * 4, [PROXY_UID, 0, 0, 0]))
                and row['executableKind'] == ('python' if index == 0 else 'sudo')
                and type(row['imageSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', row['imageSha256'])
                and type(row['state']) is str and row['state'] in ('R', 'S', 'D', 'I', 'T', 't', 'P'))
    require(len({r['pid'] for r in rows}) == len(rows) and rows[-1]['parentPid'] == request['caller']['pid']
            and all(a['parentPid'] == b['pid'] for a, b in zip(rows, rows[1:])))


def association_snapshot(request, *, proc=None, read=root_process, inventory=complete_proxy_inventory,
                         runtime=PROXY_RUNTIME, clock=time.monotonic_ns):
    root_request(request, clock())
    with InvocationChain(request['caller'], lambda: require(clock() < request['expiresNs'])) as invocation:
        def current(budget):
            invocation.recheck()
            result = inventory(budget, invocation=invocation) if inventory is complete_proxy_inventory else inventory(budget)
            invocation.recheck()
            return result
        return association_snapshot_held(request, proc=proc, read=read, inventory=current, runtime=runtime, clock=clock)


def association_snapshot_held(request, *, proc, read, inventory, runtime, clock):
    root_request(request, clock())
    proc = ProxyAssociationProc() if proc is None else proc
    def budget():
        require(clock() < request['expiresNs'])
    fds, instance, stage = [], None, 'complete-uid-inventory'
    try:
        candidates, scoped = inventory(budget)
        require(type(scoped) is dict and 0 < len(scoped) <= ProxyAssociationProc.MAX_PIDS
                and type(candidates) is list and 0 < len(candidates) <= 4 and len(set(candidates)) == len(candidates))
        rows = {}
        stage = 'held-process-identities'
        for pid in [r['pid'] for r in request['tree']] + candidates:
            budget(); fd = os.pidfd_open(pid); fds.append(fd)
            require(not select.select([fd], [], [], 0)[0])
            rows[pid] = read(pid, True); OwnedLineage.validate(rows[pid])
            require({k: v for k, v in rows[pid].items() if k not in ('image', 'kernelImageSha256')} == scoped.get(pid))
        require(all(rows[r['pid']] == r for r in request['tree']))
        stage = 'private-instance-and-pipes'
        info = proc.info(request['client']['pid'])
        instance = PrivateInstance(info, request['original'], runtime)
        private = instance.snapshot()
        bwraps = [r['pid'] for r in request['tree'] if r['executable'] == '/usr/bin/bwrap']
        pipes = {pid: proc.pipes(pid) for pid in (*bwraps, *candidates)}
        infos = {pid: proc.info(pid) for pid in candidates}
        matches = []
        for pid in candidates:
            row = rows[pid]; mode = int(row['image']['st_mode'])
            require(row['uids'] == [PROXY_UID] * 4 and row['executable'] == '/usr/bin/xdg-dbus-proxy'
                    and int(row['image']['st_uid']) == int(row['image']['st_gid']) == 0
                    and stat.S_ISREG(mode) and not mode & 0o7022)
            if infos[pid]['sha256'] != info['sha256'] or infos[pid]['fields'] != info['fields']:
                continue
            links = [dict(appPid=app, appFd=a['fd'], proxyFd=b['fd'], inode=a['inode'])
                     for app in bwraps for a in pipes[app][0] for b in pipes[pid][0]
                     if a['inode'] == b['inode'] and a['access'] == 'read' and b['access'] == 'write']
            require(len(links) <= 16)
            if links:
                require(len({m['inode'] for m in links}) == 1)
                matches.append((pid, links))
        stage = 'unique-associated-proxy'
        require(len(matches) == 1)
        stage = 'complete-association-recheck'
        require(inventory(budget) == (candidates, scoped) and instance.snapshot() == private
                and proc.info(request['client']['pid']) == info
                and all(proc.info(pid) == infos[pid] for pid in candidates)
                and all(proc.pipes(pid) == old for pid, old in pipes.items())
                and all(read(pid, True) == row for pid, row in rows.items())
                and all(not select.select([fd], [], [], 0)[0] for fd in fds))
        budget()
        pid, links = matches[0]
        return bounded(dict(complete=True, uid=PROXY_UID, candidateCount=len(candidates), scopedProcessCount=len(scoped),
            original=request['original'], client=request['client'], tree=request['tree'], proxy=rows[pid],
            flatpakInfo=dict(sha256=info['sha256'], fields=info['fields']), privateInstance=private,
            pipes=links), 24576)
    except Exception as error:
        error.proxy_snapshot_stage = stage
        raise
    finally:
        if instance is not None:
            instance.close()
        for fd in fds:
            os.close(fd)


def protected_tool(expected=None):
    for path in (PROXY_TOOL.parent, *PROXY_TOOL.parent.parents):
        info = path.lstat()
        require(path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode)
                and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o7022)
    directory = os.open(PROXY_TOOL.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        raw, stamp = ProxyAssociationProc.read_at(directory, PROXY_TOOL.name, 1024 * 1024, sized=True)
        require(stamp[3] == stamp[4] == 0 and stamp[5] == 1 and stat.S_IMODE(stamp[2]) == 0o444)
        digest = hashlib.sha256(raw).hexdigest()
        require(expected is None or digest == expected)
        return digest
    finally:
        os.close(directory)


# Only these exact code objects may supply a diagnostic location or selected operands.
INVENTORY_FAILURE_FUNCTIONS = (
    (ProxyAssociationProc.read_at.__func__.__code__, 'ProxyAssociationProc.read_at', 'proc-read', 'unavailable'),
    (root_process.__code__, 'root_process', 'process-read', 'proc'),
    (root_uid_tuple.__code__, 'root_uid_tuple', 'uid-read', 'status'),
    (complete_uid_inventory.__code__, 'complete_uid_inventory', 'scan-open', 'inventory'),
    (InvocationChain.identity.__code__, 'InvocationChain.identity', 'process-read', 'proc'),
    (InvocationChain.recheck.__code__, 'InvocationChain.recheck', 'invocation-recheck', 'invocation'),
    (InvocationChain.mixed_process.__code__, 'InvocationChain.mixed_process', 'mixed-membership', 'invocation'),
    (InvocationImage.check.__code__, 'InvocationImage.check', 'image-identity', 'exe'),
    (InvocationImage.snapshot.__code__, 'InvocationImage.snapshot', 'image-bytes', 'exe'),
    *((next(code for code in owner.__code__.co_consts if getattr(code, 'co_name', None) == nested),
       label, predicate, field) for owner, nested, label, predicate, field in (
        (root_process, 'identity', 'root_process.identity', 'process-read', 'proc'),
        (complete_uid_inventory, 'scan', 'complete_uid_inventory.scan', 'scan-open', 'inventory'),
        (inventory_probe, 'budget', 'inventory_probe.budget', 'deadline', 'clock'),
        (association_snapshot_held, 'budget', 'association_snapshot_held.budget', 'deadline', 'clock'))),
)


def root_snapshot_main():
    # This sole root entry point imports only stdlib and reads only fixed proc/runtime paths.
    # A missing stdin EOF cannot leave a privileged helper alive indefinitely.
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.setitimer(signal.ITIMER_REAL, ROOT_WORKER_SECONDS)
    try:
        require(os.getuid() == os.geteuid() == 0 and os.environ.get('SUDO_UID') == str(PROXY_UID)
                and Path(__file__) == PROXY_TOOL and sys.argv[1:] in (['root-proxy-snapshot'], ['root-inventory-probe']))
        raw = sys.stdin.buffer.read(32769); require(len(raw) <= 32768)
        def pairs(items):
            result = {}
            for key, value in items:
                require(key not in result); result[key] = value
            return result
        request = json.loads(raw, object_pairs_hook=pairs)
        probe = sys.argv[1:] == ['root-inventory-probe']
        (probe_request if probe else root_request)(request, time.monotonic_ns())
        protected_tool(request['codeSha256'])
        data = inventory_probe(request) if probe else association_snapshot(request)
        protected_tool(request['codeSha256'])
        answer = dict(request=request, ok=True, snapshot=data)
        sys.stdout.write(json.dumps(bounded(answer), allow_nan=False, ensure_ascii=True))
    except Exception as error:
        refusal = dict(ok=False, unavailable=type(error).__name__, stage=getattr(error, 'proxy_snapshot_stage', 'root-entry'))
        pid = getattr(error, 'proxy_snapshot_pid', None)
        if type(pid) is int and 1 < pid < 2**31:
            refusal['pid'] = pid
        detail = getattr(error, 'proxy_caller_diagnostic', None)
        if type(detail) is dict:
            try:
                refusal['probeCaller'] = bounded(detail, 4096)
            except Exception:
                pass
        detail = getattr(error, 'proxy_inventory_diagnostic', None)
        if type(detail) is dict:
            try:
                refusal['inventoryFailure'] = inventory_diagnostic(detail)
            except Exception:
                pass
        sys.stdout.write(json.dumps(refusal))
        raise SystemExit(1)


class OwnedLineage:
    """Seal live ancestry before input; never infer a later ancestor's exit from /proc errors."""
    def __init__(self, original, client, tree, read, redact, *, image_open, system_image, pidfds, guard, budget,
                 diagnostic=None, diagnostic_state=None):
        self.original, self.client, self.tree = copy.deepcopy(original), copy.deepcopy(client), copy.deepcopy(tree)
        self.read, self.redact, self.pidfds, self.guard, self.budget = read, redact, pidfds, guard, budget
        self.system, self.rows, self.held, self.fds, self.chains = system_image, {}, {}, {}, {}
        self.started, self.used, self.closed = False, False, False
        self.lock = threading.RLock()
        self.diagnostic, self.diagnostic_state = diagnostic, diagnostic_state
        self.stage, self.stage_pid, self.last_row, self.last_image = 'tree-shape', None, None, None
        try:
            require(type(tree) is dict and 0 < len(tree) <= 64
                    and all(type(pid) is int and type(row) is dict and row.get('pid') == pid for pid, row in tree.items()))
            self.checkpoint('expected-original-validation'); self.validate(original)
            self.checkpoint('expected-client-validation'); self.validate(client)
            self.checkpoint('expected-process-match')
            require(original['executable'] == '/usr/bin/bwrap' and client['executable'] == '/app/bin/creator-hub-flatpak-activate'
                    and original['uids'] == client['uids'] and original['pid'] != client['pid'])
            self.checkpoint('initial-owned-launch-guard'); self.guard()
            self.checkpoint('initial-budget'); self.budget()
            candidates = [pid for pid, row in tree.items() if row.get('executable') == '/usr/bin/xdg-dbus-proxy']
            self.checkpoint('candidate-count')
            require(0 < len(candidates) <= 4)
            self.client_chain = self.walk(client['pid'], image_open)
            self.checkpoint('expected-full-record-match')
            require(self.rows[client['pid']] == client and self.rows[original['pid']] == original)
            for pid in candidates:
                self.chains[pid] = self.walk(pid, image_open)
                self.checkpoint('candidate-system-image-read', pid)
                observed = self.system.snapshot()
                self.last_image = self.stage, observed
                self.checkpoint('candidate-system-image-match', pid)
                require((self.rows[pid]['image'], self.rows[pid]['kernelImageSha256']) == observed)
            self.verify_live()
        except Exception as error:
            self.capture_failure(error)
            self.close()
            raise

    def checkpoint(self, stage, pid=None):
        self.stage, self.stage_pid = stage, pid

    def capture_failure(self, error):
        if type(self.diagnostic) is not dict:
            return
        try:
            value = lineage_inputs(self.original, self.client, self.tree)
            value.update(failureStage=self.stage, failureType=type(error).__name__ if type(error) in (
                ValueError, KeyError, TypeError, RuntimeError, PermissionError, FileNotFoundError, ProcessLookupError, OSError) else 'OtherError')
            if self.stage_pid is not None:
                value['failurePid'] = self.stage_pid
                if self.stage_pid in self.rows:
                    value['expectedRowAtFailure'] = lineage_row(self.rows[self.stage_pid])
            if self.last_row is not None:
                value['currentRowAt'], row = self.last_row
                value['currentRow'] = lineage_row(row)
                if type(row) is dict and type(row.get('pid')) is int and row['pid'] in self.tree:
                    value['treeRowForCurrent'] = lineage_row(self.tree[row['pid']])
            if self.last_image is not None:
                value['observedImageAt'], image = self.last_image
                if type(image) is tuple and len(image) == 2:
                    value['observedImage'] = lineage_row(dict(image=image[0], kernelImageSha256=image[1]))
            if self.diagnostic_state is not None:
                try:
                    state = self.diagnostic_state()
                    if type(state) is dict and set(state) == {'closed', 'stopRequested', 'deadlineExceeded', 'cancelled'} \
                            and all(type(v) is bool for v in state.values()):
                        value['stateAtFailure'] = state
                except Exception:
                    value['stateCaptureUnavailable'] = True
            self.diagnostic.update(bounded(value, 16384))
        except Exception:
            self.diagnostic.update(readOnly=True, inputPermitted=False, authorityGranted=False, releaseReady=False,
                                   failureStage=self.stage, captureUnavailable=True)

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
            self.checkpoint('walk.budget', pid)
            self.budget()
            self.checkpoint('walk.membership', pid)
            require(pid in self.tree and pid not in chain)
            if pid not in self.rows:
                self.checkpoint('walk.retained-node-limit', pid)
                require(len(self.rows) < 16)
                self.checkpoint('walk.pidfd-open', pid)
                fd = self.pidfds.open(pid)
                self.fds[pid] = fd
                self.checkpoint('walk.image-open', pid)
                held = image_open(pid)
                self.held[pid] = held
                self.checkpoint('walk.full-read', pid)
                row = self.read(pid, True)
                self.last_row = self.stage, row
                self.checkpoint('walk.row-validation', pid)
                self.validate(row)
                self.checkpoint('walk.row-match', pid)
                require(row['pid'] == pid and row['uids'] == self.original['uids']
                        and {k: v for k, v in row.items() if k != 'kernelImageSha256'} == self.tree[pid])
                self.checkpoint('walk.pidfd-live', pid); require(not self.pidfds.ready(fd))
                self.checkpoint('walk.held-image-read', pid)
                observed = held.snapshot()
                self.last_image = self.stage, observed
                self.checkpoint('walk.held-image-match', pid)
                require(observed == (row['image'], row['kernelImageSha256']))
                self.checkpoint('walk.full-recheck', pid)
                current = self.read(pid, True)
                self.last_row = self.stage, current
                require(current == row)
                self.checkpoint('walk.pidfd-recheck', pid); require(not self.pidfds.ready(fd))
                self.rows[pid] = copy.deepcopy(row)
            row = self.rows[pid]
            chain.append(pid)
            if pid == self.original['pid']:
                self.checkpoint('walk.original-match', pid)
                require(row == self.original)
                return chain
            parent = row['parentPid']
            self.checkpoint('walk.parent-order', pid)
            require(parent in self.tree and int(self.tree[parent]['startTime']) <= int(row['startTime']))
            pid = parent
        self.checkpoint('walk.ancestor-limit', pid)
        raise ValueError('Finite pre-input ancestry exceeded')

    def verify_live(self):
        self.checkpoint('verify.preconditions')
        require(not self.closed and not self.started)
        self.checkpoint('verify.owned-launch-guard')
        self.guard()
        for pid, row in self.rows.items():
            self.checkpoint('verify.budget', pid)
            self.budget()
            self.checkpoint('verify.pidfd-live', pid); require(not self.pidfds.ready(self.fds[pid]))
            self.checkpoint('verify.full-read', pid)
            current = self.read(pid, True); self.last_row = self.stage, current
            require(current == row)
            self.checkpoint('verify.held-image-read', pid)
            observed = self.held[pid].snapshot(); self.last_image = self.stage, observed
            self.checkpoint('verify.held-image-match', pid)
            require(observed == (row['image'], row['kernelImageSha256']))
            self.checkpoint('verify.full-recheck', pid)
            current = self.read(pid, True); self.last_row = self.stage, current
            require(current == row)
            self.checkpoint('verify.pidfd-recheck', pid); require(not self.pidfds.ready(self.fds[pid]))
        for pid in self.chains:
            self.checkpoint('verify.system-image-read', pid)
            observed = self.system.snapshot(); self.last_image = self.stage, observed
            self.checkpoint('verify.system-image-match', pid)
            require(observed == (self.rows[pid]['image'], self.rows[pid]['kernelImageSha256']))
        self.checkpoint('verify.final-owned-launch-guard'); self.guard()
        self.checkpoint('verify.final-budget'); self.budget()

    def begin_input(self):
        with self.lock:
            try:
                self.verify_live()
                self.started = True
            except Exception as error:
                self.capture_failure(error)
                raise

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


class AssociatedProxyLineage(OwnedLineage):
    """Seal an external proxy by a complete root snapshot, never invented ancestry."""
    def __init__(self, original, client, tree, read, redact, *, snapshot, image_open, system_image, pidfds,
                 guard, budget, diagnostic=None, diagnostic_state=None):
        self.original, self.client, self.tree = copy.deepcopy(original), copy.deepcopy(client), copy.deepcopy(tree)
        self.read, self.redact, self.pidfds, self.guard, self.budget = read, redact, pidfds, guard, budget
        self.system, self.rows, self.held, self.fds, self.chains = system_image, {}, {}, {}, {}
        self.started, self.used, self.closed = False, False, False
        self.lock = threading.RLock()
        self.diagnostic, self.diagnostic_state = diagnostic, diagnostic_state
        self.stage, self.stage_pid, self.last_row, self.last_image = 'association-owned-chain', None, None, None
        self.snapshot_source, self.association, self.instance = snapshot, None, None
        try:
            self.validate(original); self.validate(client)
            require(original['uids'] == client['uids'] == [PROXY_UID] * 4)
            self.client_chain = self.walk(client['pid'], image_open)
            request_tree = [self.rows[pid] for pid in self.client_chain]
            self.checkpoint('association-root-snapshot')
            data = snapshot(request_tree)
            validate_association(data, original, client, request_tree)
            self.association = copy.deepcopy(data)
            pid, row = data['proxy']['pid'], data['proxy']
            self.fds[pid] = pidfds.open(pid)
            self.held[pid] = image_open(pid)
            require(read(pid, True) == row and self.held[pid].snapshot() == (row['image'], row['kernelImageSha256'])
                    and system_image.snapshot() == (row['image'], row['kernelImageSha256'])
                    and not pidfds.ready(self.fds[pid]))
            self.rows[pid], self.chains[pid] = copy.deepcopy(row), [pid]
            self.instance = PrivateInstance(dict(sha256=data['flatpakInfo']['sha256'], fields=data['flatpakInfo']['fields']), original)
            require(self.instance.snapshot() == data['privateInstance'])
            OwnedLineage.verify_live(self)
        except Exception as error:
            self.capture_failure(error); self.close(); raise

    def verify_live(self):
        OwnedLineage.verify_live(self)
        self.checkpoint('association-complete-root-recheck')
        current = self.snapshot_source([self.rows[pid] for pid in self.client_chain])
        validate_association(current, self.original, self.client, [self.rows[pid] for pid in self.client_chain])
        require(current == self.association and self.instance.snapshot() == current['privateInstance'])
        OwnedLineage.verify_live(self)

    def observe(self, name, peer, *, budget):
        value = super().observe(name, peer, budget=budget)
        if value.get('stable') is True:
            value['externalAssociation'] = copy.deepcopy(self.association)
        return bounded(value, 24576)

    def close(self):
        try:
            if self.instance is not None:
                self.instance.close(); self.instance = None
        finally:
            super().close()


def validate_association(data, original, client, tree):
    require(type(data) is dict and set(data) == {'complete', 'uid', 'candidateCount', 'scopedProcessCount', 'original',
            'client', 'tree', 'proxy', 'flatpakInfo', 'privateInstance', 'pipes'}
            and data['complete'] is True and type(data['uid']) is int and data['uid'] == PROXY_UID
            and type(data['candidateCount']) is int and 1 <= data['candidateCount'] <= 4
            and type(data['scopedProcessCount']) is int and data['candidateCount'] <= data['scopedProcessCount'] <= 4096
            and data['original'] == original and data['client'] == client and data['tree'] == tree)
    require(type(tree) is list and 1 < len(tree) <= MAX_ANCESTORS and tree[0] == client and tree[-1] == original
            and len({r['pid'] for r in tree}) == len(tree))
    for row in tree:
        OwnedLineage.validate(row); require(row['uids'] == [PROXY_UID] * 4)
    for child, parent in zip(tree, tree[1:]):
        require(child['parentPid'] == parent['pid'] and parent['executable'] == '/usr/bin/bwrap'
                and int(parent['startTime']) <= int(child['startTime'])
                and parent['image'] == original['image'] and parent['kernelImageSha256'] == original['kernelImageSha256'])
    OwnedLineage.validate(data['proxy'])
    row = data['proxy']; image = row['image']
    require(row['executable'] == '/usr/bin/xdg-dbus-proxy' and row['uids'] == [PROXY_UID] * 4
            and int(image['st_uid']) == int(image['st_gid']) == 0 and stat.S_ISREG(int(image['st_mode']))
            and not int(image['st_mode']) & 0o7022 and row['pid'] not in {r['pid'] for r in tree})
    info, private = data['flatpakInfo'], data['privateInstance']
    require(type(info) is dict and set(info) == {'sha256', 'fields'} and re.fullmatch(r'[a-f0-9]{64}', info['sha256'])
            and type(info['fields']) is dict and set(info['fields']) == {'app', 'instanceId', 'appCommit', 'runtimeCommit'}
            and info['fields']['app'] == 'com.creatorworks.hub' and re.fullmatch(r'[0-9]{1,20}', info['fields']['instanceId'])
            and all(re.fullmatch(r'[a-f0-9]{64}', info['fields'][k]) for k in ('appCommit', 'runtimeCommit')))
    require(type(private) is dict and set(private) == {'instanceId', 'infoSha256', 'originalPid', 'directories', 'infoIdentity', 'pidIdentity'}
            and private['instanceId'] == info['fields']['instanceId'] and private['infoSha256'] == info['sha256']
            and type(private['originalPid']) is int and private['originalPid'] == original['pid']
            and type(private['directories']) is list and len(private['directories']) == 3
            and all(type(s) is list and len(s) == 6 and all(type(v) is int and 0 <= v < 2**64 for v in s) for s in private['directories'])
            and all(type(private[k]) is list and len(private[k]) == 9
                    and all(type(v) is int and 0 <= v < 2**64 for v in private[k]) for k in ('infoIdentity', 'pidIdentity')))
    links = data['pipes']
    require(type(links) is list and 0 < len(links) <= 16)
    for link in links:
        require(type(link) is dict and set(link) == {'appPid', 'appFd', 'proxyFd', 'inode'}
                and all(type(v) is int and 0 <= v < 2**64 for v in link.values())
                and link['appPid'] in {r['pid'] for r in tree if r['executable'] == '/usr/bin/bwrap'}
                and link['appFd'] < 2**31 and link['proxyFd'] < 2**31 and link['inode'] > 0)
    require(len({p['inode'] for p in links}) == 1)


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
        require(type(self.baseline) in (OwnedLineage, AssociatedProxyLineage) and self.armed)
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
    if sys.argv[1:] in (['root-proxy-snapshot'], ['root-inventory-probe']):
        root_snapshot_main()
    else:
        raise SystemExit('Import-only passive CI diagnostics; no standalone bus or input interface')
