"""Finite, manual integrated14 -> signed15 lab CAPTURE. No credential input.

Root's native confirmation is captured, source-checked twice, then pressed once.
The original stock authentication graph is read only; no password/Cancel action.
No product rebuild, JavaScript execution, native-IPC mock, public feed or release.
"""
import hashlib
from functools import lru_cache
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import select
import stat
import subprocess
import sys
import time
from types import SimpleNamespace
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BASE = Path('/opt/creator-integrated-update')
USER, UID = 'creator-polkit-fixture', 21314
BRANCH = 'refs/heads/validation/linux-integrated-update'
SOURCE = '5065fb1112b9e96978e40e64503fa979f559baae'
HUB = '/usr/bin/creator-hub'
ASSET = 'Creator_Hub_0.1.15_amd64-acceptance-only.deb'
DESCRIPTOR = 'creator-hub-linux-x86_64-deb.json'
PINS = {
    'descriptor': 'bbc44a1443f861bda3e927727834f14fb5af487f5290a03616335228335f8290',
    'descriptorSignature': '3199977b6ccd8911ded3691145f9c3a939105c8b4f0aa805679b10e04c64ed9b',
    'installer': '4cbd1488e0568e79ad8a9bc47d445cbbb344abc2c72045cde2dd3cd5e72fb36d',
    'manifest': 'f260bcd30e8ce5d3f20189ddbb1b2ba2c33186be71b83e3937af68f1dcc1ca5c',
    'executable': 'fc18fd79ab9fd1f9456b1f124acaba2390ea3501e1617e3f91dea082d9ce7a56',
}
INPUTS = {
    'baseline.zip': (182723403, '71a2a4e42a1b1e2fe5e1e64f363f7d3c06444b03b5d2177b2e4565ad8a710c4c'),
    'target.zip': (71852017, '37762440d9a72c83d48205b743d6e45a3e3e56526c02d117a9a5ce6c7328ac0b'),
    'signed.zip': (63839087, 'ac07b5053a808672b064de36c3f7d3362fc106b38b33c1330397b1d927931fb9'),
}
DEB14 = (63874630, '8f9ff4b4694d00150bf86f7a5befc6a1cfc80610d55212b717d602ceb84fe86c')
ELF14 = (27369792, '3ac7fdd5cedf85df41844c32c7dcdeb180ca14fc66a7f6e274c1ace5fc5e39b8')
DEB15 = (63874030, PINS['installer'])
ELF15 = (27363616, PINS['executable'])
SERVER = (1621513, '62d410eba4d81646a35ee274b5904a17287026bdc4d765426d6cf3b07d04141a')
SIGNED_FILES = {ASSET: DEB15, DESCRIPTOR: (513, PINS['descriptor']),
                DESCRIPTOR + '.minisig': (318, PINS['descriptorSignature']),
                'latest.json': (745, PINS['manifest']),
                'signing-receipt.json': (715, '548df7807437d3ab2ce885c0a5e261e02bc02a4dd7308f82334726734f87bb79')}
SCRIPTS = ('native-linux-integrated-update.py', 'native-linux-integrated-pages.py',
           'native-linux-root-probe.py', 'native-unix-window.py', 'native-linux-polkit-probe.py', 'linux-update-lab-feed.cjs')
TITLE = 'Update Creator Hub'
QUESTION = 'Update Creator Hub to 0.1.15?\n\nHub will close and reopen. Your projects, apps and settings will stay in place.'
FALSE_GATES = dict.fromkeys(('publicDiscovery', 'signedUpdateAccepted', 'restartAccepted', 'migrationAccepted',
                            'flatpakAccepted', 'releaseReady', 'systemAuthenticationAccepted'), False)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def pages():
    return load('native-linux-integrated-pages')


def admission(env, system, machine, *, native=False):
    fixed = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'BOBWORKS-XR/CREATOR-HUB',
             'GITHUB_REPOSITORY_ID': '1364807512', 'GITHUB_REF': BRANCH, 'RUNNER_ENVIRONMENT': 'github-hosted',
             'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'CREATOR_LINUX_INTEGRATED_UPDATE': '1'}
    require(system == 'linux' and machine == 'x86_64' and all(env.get(k) == v for k, v in fixed.items()),
            'Exact disposable integrated-update branch required')
    require(env.get('GITHUB_EVENT_NAME') in (('workflow_dispatch',) if native else ('push', 'workflow_dispatch')),
            'Native capture is manual only')
    require(re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', '')) and
            all(re.fullmatch(r'[1-9][0-9]*', env.get(k, '')) for k in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')), 'CI source/run required')
    require(not any(re.match(r'^(LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|WEBKIT_|TAURI_|CREATOR_HUB_SIGNING_)', k)
                    or k.lower().endswith('proxy') for k in env), 'Inherited runtime/trust/proxy/signing injection refused')
    require(not any(env.get(k) for k in ('FLATPAK_ID', 'APPIMAGE', 'APPDIR')), 'Native DEB context only')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def exact(file, pin, limit=256 * 1024 * 1024):
    value = pages().record(Path(file), limit)
    require((value['size'], value['sha256']) == pin, 'Immutable input differs: ' + str(file))
    return value


def evidence(file, value, limit=32768):
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
    require(0 < len(raw) <= limit, 'Evidence exceeds fixed bound')
    with Path(file).open('xb') as stream:
        os.chmod(file, 0o600)
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    require(Path(file).read_bytes() == raw, 'Evidence readback differs; no action authorized')
    return {'file': Path(file).name, 'size': len(raw), 'sha256': digest(raw)}


def zip_select(file, destination, selected, *, exact_names=False):
    """Fixed names only; never extract ZIP pathnames or permissions."""
    with zipfile.ZipFile(file) as archive:
        entries = archive.infolist()
        require(0 < len(entries) <= 64 and sum(e.file_size for e in entries) <= 768 * 1024 * 1024, 'Archive inventory bound')
        names = set()
        for item in entries:
            name = item.filename
            require(name not in names and '\\' not in name and ':' not in name and not name.startswith('/')
                    and all(p not in ('', '.', '..') for p in name.rstrip('/').split('/'))
                    and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR)
                    and 0 <= item.file_size <= 256 * 1024 * 1024 and not item.flag_bits & 1, 'Unsafe archive entry')
            names.add(name)
        require(set(selected) == names if exact_names else set(selected) <= names, 'Unexpected/missing input members')
        for name, (output, size, sha) in selected.items():
            item = archive.getinfo(name)
            require(not item.is_dir() and item.file_size == size, 'Selected member size differs')
            raw = archive.read(item)
            require(len(raw) == size and digest(raw) == sha, 'Selected member hash differs')
            with (destination / output).open('xb') as stream:
                os.chmod(destination / output, 0o600); stream.write(raw)


def stage(temp):
    incoming = temp / 'integrated-update-input'
    for name, pin in INPUTS.items():
        exact(incoming / name, pin)
    output = temp / 'integrated-update-stage'; output.mkdir(mode=0o700)
    zip_select(incoming / 'baseline.zip', output, {
        'native-packages/Creator Hub_0.1.14_amd64.deb': ('native14.deb', *DEB14),
        'modules/mcp/server/creator-works-mcp.mjs': ('creator-works-mcp.mjs', *SERVER)})
    zip_select(incoming / 'target.zip', output, {'native-packages/Creator Hub_0.1.15_amd64.deb': ('original15.deb', *DEB15)})
    signed = output / 'signed'; signed.mkdir(mode=0o700)
    zip_select(incoming / 'signed.zip', signed, {name: (name, *pin) for name, pin in SIGNED_FILES.items()}, exact_names=True)
    receipt = pages().parse((signed / 'signing-receipt.json').read_bytes())
    require(receipt['artifactRun'] == 39134454264 and receipt['artifactId'] == 12139297945
            and receipt['acceptanceOnly'] is True and receipt['targetVersion'] == '0.1.15' and receipt['pins'] == PINS
            and all(receipt[k] is False for k in ('signedUpdateAccepted', 'restartAccepted', 'releaseReady')), 'Signed input receipt differs')


def protected(file):
    file = Path(file)
    for item in (file, *file.parents):
        info = item.lstat()
        resolved = item.resolve(strict=True)
        require(resolved == item and info.st_uid == info.st_gid == 0
                and not info.st_mode & 0o7022, 'Protected fixed source/ancestor required: ' + json.dumps({
                    'path': str(item), 'uid': info.st_uid, 'gid': info.st_gid,
                    'mode': format(stat.S_IMODE(info.st_mode), '04o'),
                    'resolvedPath': str(resolved), 'redirect': resolved != item}, separators=(',', ':')))
    return file


def path_preflight(env):
    """Metadata only, before inputs or fixture preparation; never repair ancestry."""
    report = {'readOnly': True, 'guardPassed': False, 'paths': []}
    for item in (Path('/'), Path('/opt'), BASE, BASE / 'scripts', BASE / 'binding.json'):
        row = {'path': str(item)}
        try:
            info = item.lstat()
            row.update(exists=True, uid=info.st_uid, gid=info.st_gid, mode=format(stat.S_IMODE(info.st_mode), '04o'))
            try:
                resolved = item.resolve(strict=True)
                row.update(resolvedPath=str(resolved), redirect=resolved != item)
            except OSError as error:
                row['resolveErrno'] = error.errno
        except OSError as error:
            row.update(exists=False, lstatErrno=error.errno)
        report['paths'].append(row)
    try:
        protected(Path('/opt'))
        report['guardPassed'] = True
    except Exception as error:
        report['error'] = {'type': type(error).__name__, 'message': str(error)[:4096]}
        raise
    finally:
        original = sys.exc_info()[1]
        try:
            raw = json.dumps(report, separators=(',', ':'), allow_nan=False)
            require(len(raw.encode()) <= 8192, 'Path metadata diagnostic exceeds fixed bound')
            print(raw, flush=True)
            evidence(Path(env['RUNNER_TEMP']) / 'integrated-update-path-preflight.json', report, 8192)
        except Exception as error:
            if original is None:
                raise
            print('Path diagnostic save failed: ' + type(error).__name__, file=sys.stderr, flush=True)


def tighten_opt(env):
    """Only the observed disposable-runner /opt 0777 -> 0755 setup correction."""
    def inspect(item, modes):
        info = item.lstat()
        row = {'path': str(item), 'dev': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid,
               'mode': format(stat.S_IMODE(info.st_mode), '04o'), 'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns}
        resolved = item.resolve(strict=True)
        require(resolved == item and stat.S_ISDIR(info.st_mode)
                and info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) in modes,
                'Exact root-owned nonlinked CI directory/mode required: ' + json.dumps({**row,
                    'resolvedPath': str(resolved), 'redirect': resolved != item, 'directory': stat.S_ISDIR(info.st_mode)}, separators=(',', ':')))
        return row

    root, opt = Path('/'), Path('/opt')
    report = {'ciOnly': True, 'changed': False, 'chmodAttemptCount': 0, 'guardPassed': False}
    try:
        admission(env, sys.platform, platform.machine() if sys.platform == 'linux' else '', native=False)
        before_root, before_opt = inspect(root, (0o755,)), inspect(opt, (0o755, 0o777))
        report['before'] = {'root': before_root, 'opt': before_opt}
        require(inspect(root, (0o755,)) == before_root and inspect(opt, (0o755, 0o777)) == before_opt,
                'CI directory metadata changed before tightening')
        if before_opt['mode'] == '0777':
            report['chmodAttemptCount'] = 1
            command(['/usr/bin/sudo', '-n', '/usr/bin/chmod', '0755', '/opt'])
            report['changed'] = True
        after_root, after_opt = inspect(root, (0o755,)), inspect(opt, (0o755,))
        report['after'] = {'root': after_root, 'opt': after_opt}
        require(after_root == before_root and all(after_opt[k] == v for k, v in before_opt.items() if k not in ('mode', 'ctimeNs')),
                'CI root/opt identity or metadata changed during tightening')
        protected(opt)
        report['guardPassed'] = True
    except Exception as error:
        report['error'] = {'type': type(error).__name__, 'message': str(error)[:4096]}
        raise
    finally:
        original = sys.exc_info()[1]
        try:
            raw = json.dumps(report, separators=(',', ':'), allow_nan=False)
            require(len(raw.encode()) <= 8192, 'CI tightening diagnostic exceeds fixed bound')
            print(raw, flush=True)
            evidence(Path(env['RUNNER_TEMP']) / 'integrated-update-opt-tightening.json', report, 8192)
        except Exception as error:
            if original is None:
                raise
            print('CI tightening diagnostic save failed: ' + type(error).__name__, file=sys.stderr, flush=True)


def command(args, **kwargs):
    return subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, timeout=60, **kwargs).stdout


def copy_owned(source, target, uid, mode):
    before = pages().record(source)
    with Path(source).open('rb') as incoming, Path(target).open('xb') as out:
        while block := incoming.read(65536):
            out.write(block)
    os.chmod(target, mode); os.chown(target, uid, uid)
    require(pages().record(target)['sha256'] == before['sha256'] and pages().record(source) == before, 'Staged file changed')


def prepare(env):
    require(os.getuid() == os.geteuid() == 0 and not BASE.exists(), 'Fresh fixed root preparation only')
    temp = Path(env['RUNNER_TEMP']).resolve(); stage_dir = temp / 'integrated-update-stage'
    exact(stage_dir / 'native14.deb', DEB14); exact(HUB, ELF14)
    for name, pin in SIGNED_FILES.items():
        exact(stage_dir / 'signed' / name, pin)
    import pwd
    import grp
    for lookup, key in ((pwd.getpwnam, USER), (pwd.getpwuid, UID), (grp.getgrnam, USER), (grp.getgrgid, UID)):
        try:
            lookup(key)
        except KeyError:
            continue
        require(False, 'Refusing an existing synthetic identity')
    command(['/usr/sbin/useradd', '--uid', str(UID), '--user-group', '--create-home', '--home-dir', '/var/lib/' + USER, '--shell', '/bin/bash', USER])
    command(['/usr/sbin/usermod', '--append', '--groups', 'sudo', USER])
    require(command(['/usr/bin/passwd', '-S', USER]).decode().split()[:2] == [USER, 'L'], 'Synthetic account must remain locked')
    BASE.mkdir(mode=0o755); (BASE / 'scripts').mkdir(mode=0o755); (BASE / 'bin').mkdir(mode=0o755)
    for name in SCRIPTS:
        copy_owned(HERE / name, BASE / 'scripts' / name, 0, 0o644)
    for name, source in [('node', Path(env['CREATOR_LAB_NODE'])), ('tauri-driver', temp / 'integrated-update-driver/bin/tauri-driver')]:
        require(source.is_absolute() and source.read_bytes()[:7] == b'\x7fELF\x02\x01\x01', 'Native x86_64 test tool required')
        copy_owned(source, BASE / 'bin' / name, 0, 0o755)
    root = BASE / 'result'; root.mkdir(mode=0o700); os.chown(root, UID, UID)
    for name in ('input', 'creator-linux-update-lab', 'creator-linux-update-lab/inputs', 'creator-linux-update-lab/ephemeral-tls'):
        file = root / name; file.mkdir(mode=0o700); os.chown(file, UID, UID)
    copy_owned(stage_dir / 'native14.deb', root / 'input/native14.deb', UID, 0o600)
    copy_owned(stage_dir / 'creator-works-mcp.mjs', root / 'input/creator-works-mcp.mjs', UID, 0o600)
    config, before = pages().fixtures(root, root / 'input/creator-works-mcp.mjs')
    entries = [root / part for part in ('home', 'runtime', 'tmp')]
    entries.extend((root / 'home').rglob('*'))
    require(len(entries) <= 64 and all(not item.is_symlink() for item in entries), 'Finite fresh synthetic fixture only')
    for item in entries:
        os.chown(item, UID, UID)
    before = {name: pages().record(root / 'home' / name) for name in before}
    evidence(BASE / 'fixture.json', {'config': config, 'before': before}); os.chmod(BASE / 'fixture.json', 0o644)
    lab = root / 'creator-linux-update-lab'
    for name in SIGNED_FILES:
        copy_owned(stage_dir / 'signed' / name, lab / 'inputs' / name, UID, 0o600)
    evidence(lab / 'config.json', {'schemaVersion': 1, 'targetVersion': '0.1.15', 'directory': str(lab / 'inputs'), 'pins': PINS})
    os.chown(lab / 'config.json', UID, UID)
    tls = lab / 'ephemeral-tls'
    config = tls / 'tls.cnf'
    config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=api.github.com\n[ext]\nsubjectAltName=DNS:api.github.com,DNS:github.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
    command(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', str(config), '-keyout', str(tls / 'private.pem'), '-out', str(tls / 'public.crt')])
    for name in ('tls.cnf', 'private.pem', 'public.crt'):
        os.chmod(tls / name, 0o600); os.chown(tls / name, UID, UID)
    trust = Path('/usr/local/share/ca-certificates/creator-integrated-update-lab.crt')
    copy_owned(tls / 'public.crt', trust, 0, 0o644)
    command(['/usr/sbin/update-ca-certificates'])
    files = {name: pages().record(BASE / 'scripts' / name)['sha256'] for name in SCRIPTS}
    evidence(BASE / 'binding.json', {'source': env['GITHUB_SHA'], 'files': files,
             'tools': {name: pages().record(BASE / 'bin' / name) for name in ('node', 'tauri-driver')},
             'tlsCertificateSha256': pages().record(trust)['sha256']})
    os.chmod(BASE / 'binding.json', 0o644)


def binding(env):
    require(HERE == BASE / 'scripts', 'Installed fixed driver only')
    value = pages().parse(protected(BASE / 'binding.json').read_bytes())
    require(value['source'] == env['GITHUB_SHA'] and set(value['files']) == set(SCRIPTS), 'Fixed test source binding differs')
    for name, sha in value['files'].items():
        require(pages().record(protected(HERE / name))['sha256'] == sha, 'Installed test source changed')
    for name, expected in value['tools'].items():
        require(pages().record(protected(BASE / 'bin' / name)) == expected, 'Native test tool changed')
    return value


def locked_account():
    import pwd
    import grp
    value = pwd.getpwnam(USER)
    require((value.pw_uid, value.pw_gid, value.pw_dir, value.pw_shell) == (UID, UID, '/var/lib/' + USER, '/bin/bash')
            and set(os.getgrouplist(USER, UID)) == {UID, grp.getgrnam('sudo').gr_gid}, 'Exact synthetic administrator required')
    require(command(['/usr/bin/passwd', '-S', USER]).decode().split()[:2] == [USER, 'L'], 'Synthetic account must remain locked')


def transport_proof(value):
    require(value['pins'] == PINS and all(value[k] is False for k in ('publicDiscovery', 'signaturesVerifiedByHarness',
            'signedUpdateAccepted', 'restartAccepted', 'releaseReady')), 'Transport cannot establish update acceptance')
    prefix = '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/'
    expected = {('github.com', prefix + name): sha for name, sha in ((DESCRIPTOR, PINS['descriptor']),
                (DESCRIPTOR + '.minisig', PINS['descriptorSignature']), (ASSET, PINS['installer']), ('latest.json', PINS['manifest']))}
    actual = {(row['host'], row['path']): row['sha256'] for row in value['requests']}
    require(all(actual.get(key) == sha for key, sha in expected.items()), 'Actual signed metadata and installer requests were not all served')


def session_command(env):
    keep = ('GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_EVENT_NAME',
            'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'CREATOR_LINUX_INTEGRATED_UPDATE')
    root = BASE / 'result'
    values = {k: env[k] for k in keep}
    values.update(PATH='/usr/bin:/bin', LANG='C', LC_ALL='C', HOME=str(root / 'home'), USER=USER,
                  RUNNER_TEMP=str(root), XDG_RUNTIME_DIR=str(root / 'runtime'), XDG_CONFIG_HOME=str(root / 'home/config'),
                  XDG_DATA_HOME=str(root / 'home/data'), XDG_CACHE_HOME=str(root / 'home/cache'), TMPDIR=str(root / 'tmp'), GDK_BACKEND='x11', NO_AT_BRIDGE='0')
    return ['/usr/bin/systemd-run', '--wait', '--pipe', '--collect', '--quiet', '--unit=creator-integrated-update-capture',
            '--uid=' + USER, '--property=PAMName=login', '--property=Type=exec', '--property=RuntimeMaxSec=240', '--property=LimitCORE=0',
            '--property=WorkingDirectory=' + str(BASE), *('--setenv=' + k + '=' + v for k, v in values.items()),
            '/usr/bin/dbus-run-session', '--', '/usr/bin/xvfb-run', '-a', '-s', '-screen 0 1280x1000x24',
            '/usr/bin/python3', '-B', str(BASE / 'scripts/native-linux-integrated-update.py'), 'session']


def child_ids(pid):
    tasks = list(Path(f'/proc/{pid}/task').iterdir())
    require(len(tasks) <= 128, 'Thread count bound')
    result = set()
    for task in tasks:
        try:
            raw = (task / 'children').read_bytes()
        except FileNotFoundError:
            continue
        require(len(raw) <= 8192 and re.fullmatch(rb'[0-9 ]*', raw), 'Child list bound')
        result.update(map(int, raw.split()))
    require(len(result) <= 64, 'Child count bound')
    return result


def pending_request(root, helper, native, polkit):
    source = root / 'root-process.json'
    if not source.exists():
        return None
    require(source.resolve(strict=True) == source and source.stat().st_uid == UID and source.stat().st_size <= 16384, 'Fixed synthetic Root receipt required')
    try:
        saved = pages().parse(source.read_bytes())
    except ValueError:
        return None  # Exclusive first write may not yet be complete; read only.
    require(type(saved.get('pid')) is int and 1 < saved['pid'] <= 4194304, 'Bounded Root PID required')
    require(native.native_process(saved['pid'], helper) == saved and saved['executable'] == HUB
            and saved['kernelImageSha256'] == ELF14[1] and saved['uids'] == [UID] * 4, 'Root kernel binding differs')
    matches = []
    for pid in child_ids(saved['pid']):
        try:
            raw = Path(f'/proc/{pid}/cmdline').read_bytes()
        except FileNotFoundError:
            continue
        require(len(raw) <= 8192, 'Child command bound')
        if raw.split(b'\0', 1)[0] != b'/usr/bin/pkexec':
            continue
        require(raw == b'/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0', 'Unexpected DPKG request')
        process = native.native_process(pid, helper)
        require(process['parentPid'] == saved['pid'] and process['executable'] == '/usr/bin/pkexec'
                and process['kernelImageSha256'] == polkit.FILES['/usr/bin/pkexec'][3]
                and process['uids'][0] in (0, UID) and process['uids'][1:] == [0, 0, 0], 'Setuid installer ownership differs')
        import fcntl
        fd = os.open(f'/proc/{pid}/fd/0', os.O_RDONLY | os.O_CLOEXEC)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_size == DEB15[0] and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == 15, 'Sealed15 stdin differs')
            sha, offset = hashlib.sha256(), 0
            while offset < before.st_size:
                block = os.pread(fd, min(65536, before.st_size - offset), offset)
                require(block, 'Short sealed read'); sha.update(block); offset += len(block)
            require(sha.hexdigest() == DEB15[1] and pages().stamp(os.fstat(fd)) == pages().stamp(before) and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == 15
                    and native.native_process(pid, helper) == process and native.native_process(saved['pid'], helper) == saved, 'Pending package/process changed')
            matches.append({'root': saved, 'pkexec': process, 'program': '/usr/bin/dpkg', 'stdinBytes': before.st_size,
                            'stdinSha256': sha.hexdigest(), 'seals': 15, 'readOnly': True, 'authorization': False})
        finally:
            os.close(fd)
    require(len(matches) <= 1, 'Ambiguous DPKG requests')
    return matches[0] if matches else None


def gtk_contract(rows, frame, atspi):
    require(0 < len(rows) <= 64 and rows[0]['role'] == int(atspi.Role.ALERT) and rows[0]['name'] == 'Information', 'Exact GTK Information alert required')
    for name in (TITLE, QUESTION):
        found = [r for r in rows if r['role'] == int(atspi.Role.LABEL) and r['name'] == name]
        require(len(found) == 1 and all(found[0][k] for k in ('showing', 'enabled', 'sensitive')), 'Exact visible updater context required')
    buttons = [r for r in rows if r['role'] == int(atspi.Role.PUSH_BUTTON)]
    require(len(buttons) == 2 and {r['name'] for r in buttons} == {'Update Hub', 'Not now'}, 'Exact two updater controls required')
    for row in buttons:
        require(all(row[k] for k in ('showing', 'enabled', 'sensitive')) and not row['defunct'] and not row['busy'], 'GTK button not actionable')
        x, y, width, height = row['rect']
        require(width > 0 and height > 0 and frame[0] <= x and frame[1] <= y
                and x + width <= frame[0] + frame[2] and y + height <= frame[1] + frame[3], 'GTK control outside native frame')


def capture_root_dialog(root, owner, helper, native, x11, atspi, polkit, main_window, *, approve):
    require(type(approve) is bool, 'Explicit finite confirmation mode required')
    refs, bus = native.native_ax_references()
    request = None
    last = {'root': owner, 'readOnly': True, 'authorization': False}
    try:
        def snapshot():
            nonlocal request
            require(native.native_process(owner['pid'], helper) == owner, 'Root changed before GTK capture')
            windows = polkit.windows(owner['pid'], helper, x11)
            dialogs = [w for w in windows if w['title'] == TITLE]
            last['nativeWindows'] = windows
            require(len(dialogs) == 1 and len(windows) == 2 and main_window in windows
                    and main_window['window'] != dialogs[0]['window'], 'One original Root frame and one updater dialog required')
            info = dialogs[0]; frame = x11.frame_rectangle(info['window'])
            last.update(native=info, frame=list(frame))
            request = helper.Request('snapshot', owner['pid'], owner['startTime'], HUB, ELF14[1], info['window'], TITLE, 'ALERT', gtk_message_info_frame=frame)
            require(helper.bound_window(request, x11) == {k: v for k, v in info.items() if k != 'window'}, 'GTK XRes differs')
            window = helper.select_window(request, atspi)
            own = SimpleNamespace(root=owner, renderer=None)
            rows, targets, seen, pending = [], {}, set(), [(window, None, 0)]
            while pending:
                node, parent, depth = pending.pop(); node.clear_cache()
                require(node.get_process_id() == owner['pid'] and depth < 16 and len(rows) < 64, 'Foreign/oversized GTK tree')
                wire = tuple(refs.identity(node, own))
                require(wire not in seen, 'Cyclic/duplicate GTK node'); seen.add(wire)
                if parent is not None:
                    actual = node.get_parent()
                    require(actual is not None and actual.get_process_id() == owner['pid'] and tuple(refs.identity(actual, own)) == parent,
                            'GTK Parent differs from fresh forward edge')
                    require(node.get_role() not in {getattr(atspi.Role, k) for k in ('APPLICATION', 'FRAME', 'WINDOW', 'DIALOG', 'ALERT')}, 'Nested GTK window')
                role, states = int(node.get_role()), node.get_state_set()
                require(role != int(atspi.Role.PASSWORD_TEXT) and not states.contains(atspi.StateType.EDITABLE), 'Editable/password field in updater confirmation')
                name = node.get_name()
                require(type(name) is str and len(name) <= 512, 'GTK name bound')
                row = {'reference': list(wire), 'parent': list(parent) if parent else None, 'role': role, 'name': name,
                       **{k.lower(): states.contains(getattr(atspi.StateType, k)) for k in ('SHOWING', 'ENABLED', 'SENSITIVE', 'DEFUNCT', 'BUSY')}}
                if role == int(atspi.Role.PUSH_BUTTON):
                    component = node.get_component_iface(); require(component is not None, 'GTK control geometry absent')
                    rect = component.get_extents(atspi.CoordType.SCREEN)
                    row['rect'] = [rect.x, rect.y, rect.width, rect.height]; targets[name] = node
                rows.append(row)
                kids = helper.fresh_close_children(node, min(32, 64 - len(rows) - len(pending)))
                pending.extend((child, wire, depth + 1) for child in reversed(kids))
            last['rows'] = rows
            gtk_contract(rows, frame, atspi); refs.recheck()
            require(native.native_process(owner['pid'], helper) == owner and polkit.windows(owner['pid'], helper, x11) == windows
                    and x11.frame_rectangle(info['window']) == frame, 'GTK capture changed')
            return {'native': info, 'frame': list(frame), 'rows': rows, 'root': owner, 'aliases': dict(refs.aliases)}, targets
        first, _ = snapshot()
        proof = evidence(root / 'root-confirmation.json', {'readOnly': True, 'authorization': False, **first})
        surface_dir = root / 'physical-root-confirmation'; surface_dir.mkdir(mode=0o700)
        surface = native.bitmap(request, surface_dir, helper, x11)
        second, targets = snapshot()
        require(first == second, 'Two complete native GTK observations differ')
        result = {'capture': proof, 'surface': surface, 'actionCount': 0, 'questionSourceChecked': True}
        if approve:
            target = targets['Update Hub']; helper.ready(target, atspi)
            action = target.get_action_iface()
            require(action is not None and action.get_n_actions() == 1 and action.get_action_name(0) == 'click', 'One GTK click action required')
            require(native.native_process(owner['pid'], helper) == owner and helper.bound_window(request, x11) == {k: v for k, v in first['native'].items() if k != 'window'}, 'GTK owner changed before press')
            refs.recheck()
            result['actionAttemptCount'] = 1
            returned = None
            try:
                returned = action.do_action(0)
            finally:
                evidence(root / 'root-confirmation-action.json', {'actionAttemptCount': 1, 'returned': returned, 'retry': False, 'capture': proof})
            require(returned, 'Single native confirmation click failed; no retry')
            result['actionCount'] = 1
        return result
    except Exception as error:
        last['refusal'] = {'type': type(error).__name__, 'message': str(error)[:500]}
        evidence(root / 'root-confirmation-refusal.json', last, 65536)
        raise
    finally:
        bus.close_sync(None)


def start_feed(root, env, native):
    lab = root / 'creator-linux-update-lab'
    import base64
    key = (lab / 'ephemeral-tls/private.pem').read_bytes(); cert = (lab / 'ephemeral-tls/public.crt').read_bytes()
    require(0 < len(key) <= 65536 and 0 < len(cert) <= 65536, 'Ephemeral TLS size bound')
    child_env = {k: v for k, v in env.items() if k in ('GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'CREATOR_LINUX_INTEGRATED_UPDATE')}
    child_env.update(PATH='/usr/bin:/bin', RUNNER_TEMP=str(root), CREATOR_LINUX_UPDATE_LAB_FEED='1')
    child = subprocess.Popen([str(BASE / 'bin/node'), str(HERE / 'linux-update-lab-feed.cjs'), str(lab / 'config.json'), str(lab / 'transport-report.json')],
                             env=child_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child.stdin.write(json.dumps({'key': base64.b64encode(key).decode(), 'cert': base64.b64encode(cert).decode()}).encode()); child.stdin.close()
    capture = native.Capture(child, root, 'feed')
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        capture.pump(0.05)
        raw = (root / 'feed.stdout').read_bytes()
        require(len(raw) <= 2048, 'Feed startup output bound')
        if b'\n' in raw:
            value = pages().parse(raw)
            require(child.poll() is None and value['kind'] == 'linux-lab-feed-ready' and value['labDiscovery'] is True
                    and value['publicDiscovery'] is value['releaseReady'] is False
                    and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', value['proxyUrl'])
                    and int(value['proxyUrl'].rsplit(':', 1)[1]) <= 65535, 'Unexpected guarded feed readiness')
            return child, capture, value['proxyUrl']
        require(child.poll() is None, 'Guarded feed exited before readiness')
    raise RuntimeError('Guarded feed readiness deadline; no retry')


def session(env):
    require(os.getuid() == os.geteuid() == UID, 'Locked synthetic-user session only')
    binding(env)
    p = pages(); helper, native = p.helpers(); polkit = load('native-linux-polkit-probe')
    import gi
    gi.require_version('Atspi', '2.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Atspi, Gio, GLib, Gdk
    Gdk.init([])
    Atspi.set_timeout(1500, 1500)
    root = BASE / 'result'
    fixture = p.parse(protected(BASE / 'fixture.json').read_bytes())
    config, before = fixture['config'], fixture['before']
    report = {**FALSE_GATES, 'mode': 'capture', 'source': SOURCE, 'harnessCommit': env['GITHUB_SHA'],
              'passwordWriteAttempts': 0, 'authenticateActionAttempts': 0, 'systemCancelAttempts': 0,
              'rootConfirmationAccepted': False, 'disposableTeardownRequired': True}
    x11, d = helper.X11(), p.Driver()
    feed = feed_log = driver = logs = agent = agent_log = wm = wm_log = None
    bus = None
    try:
        report['phase'] = 'verify-installed14-and-stock-files'
        exact(HUB, ELF14)
        require(command(['/usr/bin/dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}', 'creator-hub']) == b'creator-hub\t0.1.14\tamd64\tinstalled', 'Installed14 state differs')
        require(command(['/usr/bin/dpkg', '--verify', 'creator-hub']) == b'', 'Installed package differs')
        report['systemFiles'] = polkit.verify_files(root)
        system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        report['session'] = polkit.session(system, os.getpid(), GLib)
        wm = subprocess.Popen(['/usr/bin/openbox', '--sm-disable'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        wm_log = native.Capture(wm, root, 'wm')
        p.wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), '_NET_SUPPORTING_WM_CHECK'))
        parent = native.native_process(os.getpid(), helper)
        report['phase'] = 'start-owned-stock-agent'
        agent = subprocess.Popen([polkit.AGENT], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        agent_log = native.Capture(agent, root, 'agent')
        agent_id = native.native_process(agent.pid, helper)
        report['agent'] = agent_id
        polkit.own_agent(agent, agent_id, parent, helper)
        endpoint = None
        def agent_ready():
            nonlocal endpoint
            agent_log.pump()
            endpoint = polkit.agent_bus_identity(system, agent_id, GLib)
            return endpoint is not None
        p.wait(agent_ready)
        report['agentBus'] = endpoint
        report['phase'] = 'guarded-lab-and-driver'
        feed, feed_log, proxy = start_feed(root, env, native)
        driver_env = dict(env, HTTPS_PROXY=proxy)
        driver = subprocess.Popen([str(BASE / 'bin/tauri-driver'), '--native-driver', '/usr/bin/WebKitWebDriver'], env=driver_env,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        logs = native.Capture(driver, root, 'driver')
        p.wait(lambda: p.listener(driver.pid, 4444))
        p.wait(lambda: d.request('GET', '/status').get('ready') is True)
        value = d.request('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': HUB, 'args': []}}}})
        d.session = value['sessionId']
        require(re.fullmatch(r'[A-Za-z0-9_-]{1,128}', d.session), 'Invalid native session')
        tree = p.subtree(driver.pid, helper, native)
        roots = [v for v in tree.values() if v['executable'] == HUB]
        require(len(roots) == 1, 'One owned Root required')
        owned = native.native_process(roots[0]['pid'], helper)
        require(owned['kernelImageSha256'] == ELF14[1], 'Running14 differs')
        native_driver = native.native_process(owned['parentPid'], helper)
        require(native_driver['pid'] in tree and native_driver['executable'] == '/usr/bin/WebKitWebDriver'
                and native_driver['parentPid'] == driver.pid and native_driver['kernelImageSha256'] == p.record('/usr/bin/WebKitWebDriver')['sha256'], 'Native driver ownership differs')
        driver_id = native.native_process(driver.pid, helper)
        require(driver_id['kernelImageSha256'] == p.record(BASE / 'bin/tauri-driver')['sha256'], 'Driver bytes differ')
        p.wait(lambda: len(polkit.windows(owned['pid'], helper, x11)) == 1)
        window = polkit.windows(owned['pid'], helper, x11)[0]
        request = helper.Request('snapshot', owned['pid'], owned['startTime'], HUB, ELF14[1], window['window'], p.TITLE, 'FRAME')
        baseline_xres = helper.bound_window(request, x11)
        report['root'] = owned; evidence(root / 'root-process.json', owned)
        modal_allowed = False
        def guard():
            logs.pump(); wm_log.pump(); feed_log.pump()
            require(driver.poll() is None and feed.poll() is None and native.native_process(owned['pid'], helper) == owned
                    and native.native_process(driver.pid, helper) == driver_id and native.native_process(native_driver['pid'], helper) == native_driver,
                    'Owned process chain changed')
            require(p.listener(driver.pid, 4444) and p.listener(native_driver['pid'], 4445), 'Owned driver socket changed')
            require(helper.bound_window(request, x11) == baseline_xres, 'Root XRes changed')
            windows = polkit.windows(owned['pid'], helper, x11)
            require(windows == [window] or modal_allowed and len(windows) == 2 and window in windows
                    and all(w == window or w['title'] == TITLE for w in windows), 'Unexpected owned GTK window')
            require(set(native.client_ids(x11)) == {w['window'] for w in windows}, 'Foreign native window before input')
        d.guard = guard
        report['phase'] = 'native-terms-and-migration-defer'
        require(not d.elements('iframe,object,embed') and len(d.call('GET', '/window/handles')) == 1, 'Not a single integrated Root')
        p.wait(lambda: d.read('#usage-terms-dialog', 'attribute/open') is not None)
        d.click('#usage-terms-checkbox'); d.click('#usage-terms-continue')
        p.wait(lambda: d.read('#usage-terms-dialog', 'attribute/open') is None)
        p.defer_migration(d)
        terms = root / 'home/data/CreatorHub/consent/hub-usage-terms.json'
        report['termsBefore'] = p.record(terms)
        report['phase'] = 'signed15-discovery'
        p.wait(lambda: d.read('#check-updates', 'enabled') is True)
        d.click('#check-updates')
        p.wait(lambda: d.read('#hub-update-status') in ('Version 0.1.15 is available.', 'Version 0.1.15 is ready to install.') and d.read('#hub-update-button', 'enabled') is True)
        require(d.read('#hub-update-warning') == '', 'Update warning present')
        report['signedLabDiscoveryObserved'] = True
        modal_allowed = True
        report['phase'] = 'capture-and-press-root-confirmation-once'
        d.click('#hub-update-button')
        p.wait(lambda: len(polkit.windows(owned['pid'], helper, x11)) == 2)
        report['rootConfirmation'] = capture_root_dialog(root, owned, helper, native, x11, Atspi, polkit, window, approve=True)
        p.wait(lambda: len(polkit.windows(owned['pid'], helper, x11)) == 1)
        report['rootConfirmationAccepted'] = True
        refs, bus = native.native_ax_references()
        report['phase'] = 'read-only-original-authentication-capture'
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            logs.pump(0.02); feed_log.pump(); agent_log.pump()
            polkit.own_agent(agent, agent_id, parent, helper)
            require(native.native_process(owned['pid'], helper) == owned and polkit.agent_bus_identity(system, agent_id, GLib) == endpoint, 'Root/agent/system bus changed')
            require(all(polkit.session(system, pid, GLib)['object'] == report['session']['object'] for pid in (owned['pid'], agent.pid)), 'Root/agent logind session differs')
            windows = polkit.windows(agent.pid, helper, x11)
            require(len(windows) <= 1, 'Ambiguous authentication windows')
            if not windows:
                continue
            graph = polkit.raw_ax(agent_id, helper, Atspi, refs)
            if graph is None:
                continue
            proof = BASE / 'pending-dpkg.json'
            if not proof.exists():
                continue
            kernel = p.parse(protected(proof).read_bytes())
            require(kernel['root'] == owned and kernel['stdinSha256'] == PINS['installer'] and kernel['seals'] == 15, 'Original pending DPKG proof differs')
            require(windows == polkit.windows(agent.pid, helper, x11) and polkit.agent_bus_identity(system, agent_id, GLib) == endpoint, 'Authentication graph/window changed')
            surface_dir = root / 'physical-authentication'; surface_dir.mkdir(mode=0o700)
            auth_request = helper.Request('snapshot', agent_id['pid'], agent_id['startTime'], polkit.AGENT, agent_id['kernelImageSha256'],
                                          windows[0]['window'], windows[0]['title'], 'DIALOG')
            surface = native.bitmap(auth_request, surface_dir, helper, x11)
            report['authenticationCapture'] = evidence(root / 'authentication-original.json', {'readOnly': True, 'authorization': False,
                'actionCount': 0, 'agent': agent_id, 'systemBus': endpoint, 'native': windows,
                'frame': list(x11.frame_rectangle(windows[0]['window'])), 'surface': surface, 'ax': graph, 'kernelDpkgRequest': kernel}, 131072)
            report['authenticationDialogCaptured'] = True
            report['axToXidAssociationVerified'] = False
            break
        require(report.get('authenticationDialogCaptured'), 'Original authentication capture deadline; no Cancel/password input')
        p.preserved(root / 'home', before, config, 'core')
        require(p.record(terms) == report['termsBefore'], 'Terms changed')
        exact(HUB, ELF14)
        report['fixturesPreserved'] = True
        report['phase'] = 'captured-stop-before-credential-or-cancel-input'
    except Exception as error:
        report['error'] = {'type': type(error).__name__, 'message': str(error)[:1000]}
        if 'request' in locals():
            try:
                surface = root / 'physical-capture'; surface.mkdir(mode=0o700)
                report['surface'] = native.bitmap(request, surface, helper, x11)
            except Exception as capture_error:
                report['surfaceError'] = str(capture_error)[:500]
        raise
    finally:
        if feed is not None:
            try:
                feed.terminate(); feed.wait(timeout=10); feed_log.pump()
                transport = root / 'creator-linux-update-lab/transport-report.json'
                if transport.exists():
                    report['transport'] = p.parse(transport.read_bytes())
                    if report.get('authenticationDialogCaptured'):
                        transport_proof(report['transport'])
            except Exception as error:
                report['feedCleanupError'] = str(error)[:500]
        if bus is not None:
            bus.close_sync(None)
        # Do not kill/close Root or its blocked system request. systemd owns teardown
        # of this disposable session after the original read-only capture is saved.
        for log in (logs, feed_log, wm_log, agent_log):
            if log is not None:
                log.pump(); log.close()
        x11.dispose()
        evidence(root / 'report.json', report, 262144)
        if report.get('feedCleanupError') and 'error' not in report:
            raise RuntimeError('Guarded transport proof/shutdown failed; capture report retained')


def broker(env):
    require(os.getuid() == os.geteuid() == 0, 'Fixed root read-only observer required')
    binding(env)
    locked_account()
    p = pages(); helper, native = p.helpers(); polkit = load('native-linux-polkit-probe')
    root = BASE / 'result'
    evidence(BASE / 'capture-once.json', {'source': env['GITHUB_SHA'], 'captureOnly': True})
    child = subprocess.Popen(session_command(env), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    capture = native.Capture(child, root, 'session')
    proof = None
    try:
        deadline = time.monotonic() + 260
        while child.poll() is None and time.monotonic() < deadline:
            capture.pump(0.05)
            if proof is None:
                proof = pending_request(root, helper, native, polkit)
                if proof is not None:
                    evidence(BASE / 'pending-dpkg.json', proof); os.chmod(BASE / 'pending-dpkg.json', 0o644)
        require(child.poll() == 0 and proof is not None, 'One original capture session did not complete; no retry')
        locked_account()
    finally:
        capture.pump(); capture.close()
        evidence(BASE / 'broker-report.json', {**FALSE_GATES, 'sessionExit': child.poll(), 'pendingDpkgObserved': proof is not None,
                 'passwordProvisioned': False, 'credentialActionCount': 0, 'disposableTeardownRequired': True})


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ('path-tighten', 'path-preflight', 'stage', 'prepare', 'broker', 'session'), 'Finite path-tighten/path-preflight/stage/prepare/broker/session only')
    action = sys.argv[1]
    admission(os.environ, sys.platform, platform.machine() if sys.platform == 'linux' else '', native=action not in ('path-tighten', 'path-preflight'))
    if action == 'path-tighten':
        tighten_opt(os.environ)
        path_preflight(os.environ)
    elif action == 'path-preflight':
        path_preflight(os.environ)
    elif action == 'stage':
        require(os.getuid() == os.geteuid() != 0, 'Runner staging only')
        stage(Path(os.environ['RUNNER_TEMP']).resolve())
    else:
        {'prepare': prepare, 'broker': broker, 'session': session}[action](os.environ)


if __name__ == '__main__':
    main()
