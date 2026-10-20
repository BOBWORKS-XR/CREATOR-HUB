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
import re
import stat
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

    def candidates(self, uid, budget):
        count, found = 0, []
        with os.scandir('/proc') as entries:
            for entry in entries:
                if not re.fullmatch(r'[1-9][0-9]{0,9}', entry.name):
                    continue
                count += 1
                require(count <= self.MAX_PIDS and int(entry.name) < 2**31)
                budget()
                before = entry.stat(follow_symlinks=False)
                require(stat.S_ISDIR(before.st_mode))
                if before.st_uid != uid:
                    continue
                target = os.readlink('/proc/' + entry.name + '/exe')
                require(len(target) <= 4096 and self.stamp(entry.stat(follow_symlinks=False)) == self.stamp(before))
                if target == '/usr/bin/xdg-dbus-proxy':
                    found.append(int(entry.name))
                    require(len(found) <= 4)
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
        candidates, scanned = proc.candidates(original['uids'][0], budget)
        require(type(candidates) is list and 0 < len(candidates) <= 4 and len(set(candidates)) == len(candidates)
                and type(scanned) is int and len(candidates) <= scanned <= ProxyAssociationProc.MAX_PIDS)
        value.update(scannedPids=scanned, candidateCount=len(candidates))
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
        value.update(complete=True, associationObserved=len(associations) == 1)
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
