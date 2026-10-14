"""One pinned Flatpak GUI launch. No auth, UI injection, navigation or force-close."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tarfile
import threading
import time
import zipfile

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / 'flatpak-gui-probe-pins.json').read_text())
PAIR = json.loads((HERE.parent / 'packaging/flatpak/replacement-014-inputs.json').read_text())['replacement']
ID = 'com.creatorworks.hub'
FLAGS = dict.fromkeys(('nativeLinuxAccepted', 'flatpakGuiAccepted', 'hostIntegrationAccepted', 'mcpAccepted',
                       'migrationAccepted', 'signedUpdateAccepted', 'releaseReady', 'updateReady'), False)
RESOURCE_SCRIPT = "p=$(readlink -f '/app/bin/../lib/Creator Hub'); test \"$p\" = '/app/lib/Creator Hub' && printf '%s\\n' \"$p\" && sha256sum \"$p/modules.tar.gz\""


def require(value, message):
    if not value:
        raise RuntimeError(message)


def unique_json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(body, object_pairs_hook=pairs)


def record(body):
    return {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def read(file, limit):
    file = Path(file)
    require(not file.is_symlink() and file.is_file() and 0 < file.stat().st_size <= limit, 'Bounded regular file required: ' + str(file))
    with file.open('rb') as stream:
        body = stream.read(limit + 1)
    require(0 < len(body) <= limit, 'Read bound exceeded')
    return body


def write(file, body):
    with Path(file).open('xb') as stream:
        stream.write(body)
    Path(file).chmod(0o600)


def save(file, value):
    body = (json.dumps(value, indent=2) + '\n').encode()
    require(len(body) <= 131072, 'Report bound exceeded')
    write(file, body)


def admission(env=None, system=None, machine=None):
    env = os.environ if env is None else env
    require((system or sys.platform) == 'linux' and (machine or platform.machine()) == 'x86_64', 'Native Linux x64 only')
    for key, value in {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
                       'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': 'BOBWORKS-XR/CREATOR-HUB',
                       'GITHUB_REPOSITORY_ID': '1364807512', 'CREATOR_FLATPAK_GUI_PROBE': '1'}.items():
        require(env.get(key) == value, 'Disposable runner admission: ' + key)
    require(not env.get('FLATPAK_ID') and Path(env.get('RUNNER_TEMP', '')).is_absolute(), 'Native owned runner temp required')
    forbidden = ('LD_', 'WEBKIT_', 'JSC_', 'GTK_MODULES', 'GIO_EXTRA_MODULES', 'NODE_OPTIONS', 'BASH_ENV')
    require(not any(k.startswith(forbidden) for k in env), 'Runtime injection/renderer overrides refused')


def zip_member(archive, name, pin):
    members = archive.infolist()
    require(len(members) <= 128 and len({m.filename for m in members}) == len(members), 'Duplicate/oversized ZIP index')
    entry = archive.getinfo(name)
    kind = stat.S_IFMT(entry.external_attr >> 16)
    require(not entry.is_dir() and kind in (0, stat.S_IFREG) and not entry.flag_bits & 1, 'ZIP member type/encryption refused')
    require(0 < entry.file_size == pin['size'] <= 268435456, 'ZIP member size differs')
    with archive.open(entry) as stream:
        body = stream.read(pin['size'] + 1)
    require(record(body) == pin, 'ZIP member hash differs: ' + name)
    return body


def verify_archive(file, descriptor):
    binding = descriptor['payloadArchive']
    require(record(read(file, 268435456)) == {'size': binding['size'], 'sha256': binding['sha256']}, 'Module archive binding differs')
    hashes = {**descriptor['modules']['mcp']['files'], **descriptor['modules']['setup']['files'], **descriptor['managedRouting']['files']}
    require(set(hashes) == set(binding['files']) and len(hashes) == 15, 'Exact current module inventory required')
    seen, total = set(), 0
    with tarfile.open(file, 'r|gz') as archive:
        for member in archive:
            name = member.name
            require(name in hashes and name not in seen and member.isreg() and not member.pax_headers, 'Foreign/duplicate/nonregular archive member')
            pin = binding['files'][name]
            require(member.size == pin['size'] and member.mode == pin['mode'] and 0 < member.size <= 268435456, 'Module size/mode differs')
            total += member.size
            require(total <= 536870912, 'Archive total bound exceeded')
            body = archive.extractfile(member).read(member.size + 1)
            require(len(body) == member.size and hashlib.sha256(body).hexdigest() == hashes[name], 'Module hash differs')
            seen.add(name)
    require(seen == set(hashes) and total == binding['unpackedSize'], 'Missing archive member/size')
    return {'members': len(seen), 'unpackedSize': total, 'hashesAndModesVerified': True, 'executed': False}


def stage(input_zip, root):
    require(not root.exists(), 'Fresh probe directory required')
    require(record(read(input_zip, PINS['artifact']['size'])) == PINS['artifact'], 'Original package ZIP differs')
    root.mkdir(mode=0o700)
    for name in ('input', 'home', 'config', 'data', 'cache', 'runtime', 'tmp', 'empty-gnupg', 'installation'):
        (root / name).mkdir(mode=0o700)
    prefix = PINS['prefix']
    with zipfile.ZipFile(input_zip) as archive:
        original = zip_member(archive, prefix + '/flatpak-report.json', PINS['report'])
        report = unique_json(original)
        require(report['suitePassed'] is True and report['packageReplacementVerified'] is True, 'Successful original replacement required')
        require(report['builds'][1]['provenance'] == PAIR['pins'] and report['builds'][1]['bundle'] == PINS['bundle'], 'Current payload provenance differs')
        require(report['builds'][1]['commit'] == PINS['appCommit'] and report['runtimeCommit'] == PINS['runtimeCommit'], 'Original deployment/runtime differs')
        write(root / 'input/original-report.json', original)
        write(root / 'input/current.flatpak', zip_member(archive, prefix + '/creator-hub-1.flatpak', PINS['bundle']))
        # The outer ZIP is pinned in full; these bounded metadata bytes are also checked semantically.
        entry = archive.getinfo('flatpak-replacement-stage/flatpak-stage.json')
        require(0 < entry.file_size <= 65536, 'Bounded original stage required')
        stage_bytes = zip_member(archive, entry.filename, record(archive.read(entry)))
        original_stage = unique_json(stage_bytes)
        require(original_stage['provenance'] == PAIR['pins'], 'Original stage source differs')
        write(root / 'input/stage.json', stage_bytes)
        nested = zip_member(archive, 'flatpak-replacement-input.zip', {'size': PAIR['artifactSize'], 'sha256': PAIR['pins']['inputArtifactSha256']})
    with zipfile.ZipFile(io.BytesIO(nested)) as archive:
        descriptor = zip_member(archive, 'builtin-manifest.json', PAIR['pins']['files']['builtin-manifest.json'])
        write(root / 'input/builtin-manifest.json', descriptor)
        receipt = zip_member(archive, 'signed-unix-assembly.json', PAIR['assemblyReceipt'])
        value = unique_json(receipt)
        require(value['assemblyCommit'] == PAIR['pins']['sourceCommit'] and value['hubVersion'] == '0.1.14', 'Assembly receipt differs')
        write(root / 'input/assembly-receipt.json', receipt)
    save(root / 'stage-report.json', {'scope': 'immutable-current-flatpak-gui-only', 'artifact': PINS['artifact'],
                                    'bundle': PINS['bundle'], 'productSource': PAIR['pins']['sourceCommit'], **FLAGS})


def child_environment(root, session=False):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
           'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'),
           'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'TMPDIR': str(root / 'tmp'),
           'GNUPGHOME': str(root / 'empty-gnupg'), 'FLATPAK_USER_DIR': str(root / 'installation'),
           'FLATPAK_FANCY_OUTPUT': '0', 'FLATPAK_TTY_PROGRESS': '0'}
    if session:
        require(re.fullmatch(r':[0-9]{1,5}(?:\.[0-9]+)?', os.environ.get('DISPLAY', '')), 'Local Xvfb display required')
        for key in ('DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'):
            require(os.environ.get(key), 'Private session missing: ' + key)
            env[key] = os.environ[key]
        env['GDK_BACKEND'] = 'x11'
    return env


class BoundedLog:
    """Drain native output without constraining the child's own filesystem writes."""
    def __init__(self, file, limit):
        self.file, self.limit = Path(file), limit
        self.stream = self.file.open('xb')
        self.file.chmod(0o600)
        self.count, self.kept, self.tail = 0, 0, b''
        self.digest, self.lock, self.complete = hashlib.sha256(), threading.Lock(), False

    def consume(self, body):
        with self.lock:
            self.count += len(body)
            self.digest.update(body)
            self.tail = (self.tail + body)[-8192:]
            retained = body[:max(0, self.limit - self.kept)]
            self.stream.write(retained)
            self.stream.flush()
            self.kept += len(retained)

    def start(self, pipe):
        def drain():
            try:
                while True:
                    body = pipe.read1(65536)
                    if not body:
                        break
                    self.consume(body)
            finally:
                with self.lock:
                    self.complete = True
                    self.stream.close()
                pipe.close()
        self.thread = threading.Thread(target=drain, daemon=True)
        self.thread.start()
        return self

    def summary(self):
        with self.lock:
            return {'sourceBytes': self.count, 'sourceSha256': self.digest.hexdigest(), 'retainedBytes': self.kept,
                    'truncated': self.count > self.limit, 'eof': self.complete,
                    'tail': self.tail.decode('utf8', 'replace')}

    def finish(self):
        self.thread.join(timeout=2)
        return self.summary()


def command(root, report, env, label, argv, timeout=30, limit=65536):
    start = time.monotonic()
    stdout, stderr = root / (label + '.stdout'), root / (label + '.stderr')
    child = subprocess.Popen(argv, env=env, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    logs = [BoundedLog(stdout, limit).start(child.stdout), BoundedLog(stderr, limit).start(child.stderr)]
    try:
        status = child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # No kill fallback, even for diagnostic commands. Preserve the PID and partial logs.
        status = None
    captures = [log.finish() for log in logs]
    a, b = stdout.read_bytes(), stderr.read_bytes()
    report['commands'].append({'label': label, 'argv': argv, 'status': status, 'pid': child.pid,
                               'elapsedMs': round((time.monotonic() - start) * 1000), 'stdout': record(a), 'stderr': record(b),
                               'outputCapture': captures,
                               'stderrTail': b[-4096:].decode('utf8', 'replace') if status != 0 else ''})
    require(status == 0, 'Command failed/timed out: ' + label)
    require(all(item['eof'] and not item['truncated'] for item in captures), 'Command log bound/EOF differs: ' + label)
    return a.decode('utf8').strip()


def deployment(root, report, env, label):
    def info(option):
        return command(root, report, env, label + '-' + option, ['/usr/bin/flatpak', 'info', '--user', '--show-' + option, PINS['ref']])
    require(info('ref') == PINS['ref'] and info('commit') == PINS['appCommit'], 'Pinned installed ref/commit differs')
    location = Path(info('location'))
    require(location.is_absolute() and location.is_relative_to(root / 'installation') and location.resolve() == location, 'Deployment escaped isolated store')
    metadata, permissions = info('metadata'), info('permissions')
    for name, body in (('metadata', metadata), ('permissions', permissions)):
        target = root / (name + '.txt')
        if target.exists():
            require(read(target, 65536).decode() == body, 'Installed metadata/permissions drift')
        else:
            write(target, body.encode())
    require(command(root, report, env, label + '-runtime', ['/usr/bin/flatpak', 'info', '--system', '--show-commit', PINS['runtime']]) == PINS['runtimeCommit'], 'Pinned Platform commit unavailable/different')
    command(root, report, env, label + '-bytes', ['/usr/bin/node', str(HERE / 'flatpak-gui-probe.cjs'), 'verify-deployment', str(root), str(location)])
    return location


def parse_stat(body, pid):
    require(body.startswith(str(pid) + ' ('), 'Process PID differs')
    fields = body[body.rfind(')') + 2:].split()
    require(len(fields) >= 20 and fields[0] not in ('Z', 'X'), 'Process is not live')
    return {'pid': pid, 'parent': int(fields[1]), 'start': fields[19]}


def proc(pid):
    with (Path('/proc') / str(pid) / 'stat').open('rb') as stream:
        body = stream.read(8193)
    require(0 < len(body) <= 8192, 'Bounded proc stat required')
    return parse_stat(body.decode(), pid)


def descendant(pid, ancestor, lookup=proc):
    seen = set()
    for _ in range(32):
        require(pid > 1 and pid not in seen, 'Foreign/cyclic process ancestry')
        seen.add(pid)
        item = lookup(pid)
        if pid == ancestor['pid']:
            require(item['start'] == ancestor['start'], 'Launcher PID reused')
            return
        pid = item['parent']
    raise RuntimeError('Process ancestry bound exceeded')


def bind(pid, launcher, location, expected=None):
    before = proc(pid)
    descendant(pid, launcher)
    image = Path('/proc') / str(pid) / 'exe'
    require(record(image.read_bytes()) == PAIR['pins']['files']['creator-hub'], 'Live window owner is not pinned Hub ELF')
    deployed = location / 'files/bin/creator-hub'
    require((image.stat().st_dev, image.stat().st_ino) == (deployed.stat().st_dev, deployed.stat().st_ino), 'Live ELF is not exact installed inode')
    require(record(read(Path('/proc') / str(pid) / 'root/app/lib/Creator Hub/modules.tar.gz', 268435456)) == PAIR['pins']['files']['modules.tar.gz'], 'Live namespace resources differ')
    require(proc(pid) == before, 'Hub identity changed while binding')
    if expected is not None:
        require(before == expected, 'Hub PID reused or reparented')
    return before


def terms_text(text):
    normalized = re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()
    require(len(text.encode()) <= 32768, 'OCR output bound exceeded')
    require(all(phrase in normalized for phrase in ('terms of use and risk acknowledgement', 'accept and continue',
                                                   'creator suite terms')), 'Rendered terms not proven by OCR')
    return {'termsHeading': True, 'termsVersionLabel': True, 'continueButton': True, 'inputAccepted': False}


def bitmap(root, window, name):
    import gi
    gi.require_version('Gdk', '3.0')
    gi.require_version('GdkX11', '3.0')
    from gi.repository import Gdk, GdkX11
    Gdk.init([])
    display = Gdk.Display.get_default()
    native = GdkX11.X11Window.foreign_new_for_display(display, window) if window else Gdk.get_default_root_window()
    require(native is not None, 'Screenshot window unavailable')
    width, height = native.get_width(), native.get_height()
    require(200 <= width <= 1280 and 150 <= height <= 800, 'Screenshot dimensions out of bounds')
    image = Gdk.pixbuf_get_from_window(native, 0, 0, width, height)
    require(image is not None, 'Screenshot pixels unavailable')
    pixels = image.get_pixels()
    colors = set()
    for y in range(0, height, 3):
        for x in range(0, width, 3):
            offset = y * image.get_rowstride() + x * image.get_n_channels()
            colors.add(bytes(pixels[offset:offset + 3]))
    image.savev(str(root / name), 'png', [], [])
    return {'width': width, 'height': height, 'sampledColors': len(colors), 'file': record(read(root / name, 8388608))}


def probe(root):
    report = {'schemaVersion': 1, 'scope': 'one-current-flatpak-terms-gui-capture-only', **FLAGS,
              'commands': [], 'launchCount': 0, 'suitePassed': False, 'normalCloseReaped': False,
              'liveHubArchiveConsumptionObserved': False, 'resourceScope': 'source-derived canonical path + normal-sandbox hash read',
              'harnessCommit': os.environ['GITHUB_SHA'], 'productCommit': PAIR['pins']['sourceCommit']}
    env = child_environment(root, True)
    child, manager, x11, bound = None, None, None, None
    try:
        report['phase'] = 'install-and-preflight'
        require(record(read(root / 'input/current.flatpak', 268435456)) == PINS['bundle'], 'Bundle changed before install')
        source = unique_json(read(root.parent / 'flatpak-gui-source.json', 1048576))
        require(source['source']['normalCloseSourceAvailable'] is True and source['source']['productSource'] == PAIR['pins']['sourceCommit'], 'Source-bound close route absent')
        command(root, report, env, 'install', ['/usr/bin/flatpak', 'install', '--user', '--bundle', '--noninteractive', '--assumeyes', '--no-deps', '--no-related', str(root / 'input/current.flatpak')], 120)
        location = deployment(root, report, env, 'before')
        descriptor = unique_json(read(root / 'input/builtin-manifest.json', 65536))
        report['archive'] = verify_archive(location / 'files/lib/Creator Hub/modules.tar.gz', descriptor)
        for flag, args in [('elf-program-headers', ['-lW']), ('elf-needed', ['-dW']), ('elf-symbol-versions', ['-VW'])]:
            command(root, report, env, flag, ['/usr/bin/readelf', *args, str(location / 'files/bin/creator-hub')], limit=131072)
        resource_output = command(root, report, env, 'resource-lookup', ['/usr/bin/flatpak', 'run', '--user', '--command=sh', PINS['ref'], '-c', RESOURCE_SCRIPT])
        require(resource_output == '/app/lib/Creator Hub\n' + PAIR['pins']['files']['modules.tar.gz']['sha256'] + '  /app/lib/Creator Hub/modules.tar.gz', 'Sandbox resource path/hash differs')
        report['resourceLookupProbePassed'] = True
        manager = subprocess.Popen(['/usr/bin/openbox', '--sm-disable'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        manager_log = BoundedLog(root / 'openbox.log', 65536).start(manager.stdout)
        spec = importlib.util.spec_from_file_location('flatpak_x11_primitives', HERE / 'native-unix-window.py')
        helper = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = helper
        spec.loader.exec_module(helper)
        x11 = helper.X11()  # Only native XRes/EWMH primitives; no helper admission override.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if x11.property(x11.x.XDefaultRootWindow(x11.display), '_NET_SUPPORTING_WM_CHECK'):
                break
            time.sleep(0.1)
        report['phase'] = 'one-normal-flatpak-launch'
        child = subprocess.Popen(['/usr/bin/flatpak', 'run', '--user', PINS['ref']], env=env, cwd=root,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        hub_logs = [BoundedLog(root / name, 1048576).start(pipe)
                    for name, pipe in (('hub.stdout', child.stdout), ('hub.stderr', child.stderr))]
        report['launchCount'] = 1
        report['launchPid'] = child.pid
        launcher = proc(child.pid)
        report['launchIdentity'] = launcher
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('Actual Flatpak launch exited before owned GUI: status ' + str(child.returncode))
            clients = x11.property(x11.x.XDefaultRootWindow(x11.display), '_NET_CLIENT_LIST')
            if clients:
                require(clients[1] == 32 and len(clients[2]) <= 32, 'Window inventory exceeds bound')
                matches = []
                for xid in clients[2]:
                    details = x11.inspect(xid)
                    if details['title'] == PINS['title']:
                        identity = bind(details['pid'], launcher, location)
                        matches.append((xid, details, identity))
                require(len(matches) <= 1, 'Ambiguous owned Hub windows')
                if matches:
                    bound = matches[0]
                    break
            time.sleep(0.1)
        require(bound, 'Owned Hub window deadline; no guessed window or force-close')
        xid, details, identity = bound
        report['ownedWindow'] = {'xid': xid, **details, 'process': identity, 'liveElfSha256': PAIR['pins']['files']['creator-hub']['sha256']}
        # Capture the actual client, not title-bar/background pixels; no runtime injection.
        time.sleep(2)
        require(x11.inspect(xid) == details, 'Window changed before screenshot')
        bind(details['pid'], launcher, location, identity)
        report['bitmap'] = bitmap(root, xid, 'terms-window.png')
        require(report['bitmap']['sampledColors'] >= 32, 'Owned client pixels are blank')
        text = command(root, report, env, 'terms-ocr', ['/usr/bin/tesseract', str(root / 'terms-window.png'), 'stdout', '--psm', '11'], limit=32768)
        report['terms'] = terms_text(text)
        report['phase'] = 'owned-terms-captured'
    except Exception as error:
        report['error'] = str(error)[:2000]
        report['classification'] = 'unverified; inspect exact command and native stderr before attribution'
    finally:
        if bound and child and child.poll() is None:
            try:
                xid, details, identity = bound
                bind(details['pid'], launcher, location, identity)
                require(x11.inspect(xid) == details, 'Owned window changed before close')
                x11.check_close(xid)  # Requires WM_DELETE_WINDOW; no kill fallback.
                x11.close_window(xid, details)
                report['normalCloseRequested'] = True
                report['launchExitStatus'] = child.wait(timeout=15)
                report['normalCloseReaped'] = report['launchExitStatus'] == 0
            except Exception as error:
                report['closeIncomplete'] = str(error)[:1000]
        if child:
            report['launchExitStatus'] = child.poll()
            report['leftRunningAtReport'] = child.poll() is None
            captures = [log.finish() for log in hub_logs]
            for name, capture in zip(('hub.stdout', 'hub.stderr'), captures):
                report[name] = capture
            report['logCaptureComplete'] = all(item['eof'] and not item['truncated'] for item in captures)
        try:
            report['desktopDiagnostic'] = bitmap(root, 0, 'desktop-diagnostic.png')
        except Exception as error:
            report['desktopCaptureError'] = str(error)[:500]
        if 'location' in locals():
            try:
                require(deployment(root, report, env, 'after') == location, 'Deployment changed after launch')
                require(record(read(root / 'input/current.flatpak', 268435456)) == PINS['bundle'], 'Bundle changed during probe')
                report['deploymentRecheckedAfter'] = True
            except Exception as error:
                report['afterError'] = str(error)[:1000]
        report['suitePassed'] = bool(report.get('terms') and report['normalCloseReaped'] and report.get('deploymentRecheckedAfter')
                                     and report.get('logCaptureComplete') and not report.get('error'))
        save(root / 'gui-report.json', report)  # Save before owned desktop session teardown.
        if x11:
            x11.dispose()
        if manager:
            try:
                subprocess.run(['/usr/bin/openbox', '--exit'], env=env, timeout=5, check=False)
                manager.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            manager_log.finish()
    print(json.dumps({key: report.get(key) for key in ('phase', 'suitePassed', 'launchCount', 'launchExitStatus', 'error', 'normalCloseReaped')}))
    return 0 if report['suitePassed'] else 1


def main():
    admission()
    root = Path(os.path.realpath(os.environ['RUNNER_TEMP'])) / 'flatpak-gui-probe'
    require(root.parent.is_dir() and root.parent.resolve() == root.parent, 'Ordinary runner temp required')
    if sys.argv[1:] == ['stage']:
        stage(root.parent / 'flatpak-gui-input.zip', root)
        return 0
    require(sys.argv[1:] == ['probe'] and root.is_dir() and root.resolve() == root, 'Use stage or probe')
    return probe(root)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error)[:2000], file=sys.stderr)
        sys.exit(1)
