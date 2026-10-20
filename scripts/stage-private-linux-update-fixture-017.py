"""Bounded data-only staging of the distinct private017 input; no signature or acceptance claim."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

NAMES = {'modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json', 'routing/router.json', 'routing/router.minisig',
         'routing/runtime.json', 'routing/runtime.minisig', 'handoff.json', 'handoff.minisig', 'plan.json',
         'runtime017.json', 'runtime017.minisig', 'derivation017.json', 'derivation017.minisig',
         'baseline016.zip', 'baseline016-api.json', 'root017-api.json'}
MAX_ZIP = 1024 * 1024 * 1024
BASELINE = {'deb': ('native-packages/Creator Hub_0.1.16_amd64.deb', 'baseline016.deb'),
            'rawHub': ('creator-hub', 'creator-hub'), 'manifest': ('builtin-manifest.json', 'builtin-manifest.json'),
            'assemblyReceipt': ('signed-unix-assembly.json', 'signed-unix-assembly.json')}


def require(value, message):
    if not value:
        raise ValueError(message)


def canonical(file):
    require(file.is_absolute() and str(file) == os.path.normpath(file), 'Canonical absolute path required')
    for part in [file, *file.parents]:
        try:
            require(not stat.S_ISLNK(part.lstat().st_mode), 'Redirected ancestor refused')
        except FileNotFoundError:
            pass


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns


def opened_identity(info):
    # Windows path stat exposes creation time as ctime; fd stat exposes change time.
    # Compare the same object fields across views, then retain each full identity
    # independently before/after the entire bounded read.
    return identity(info)[:-1]


def digest(value):
    require(type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value), 'Exact SHA256 required')


def pairs(items):
    out = {}
    for key, value in items:
        require(key not in out, 'Duplicate plan JSON key')
        out[key] = value
    return out


def stage(source, sha256, size, plan_file, plan_sha256, output, scope):
    for file in (source, plan_file, output, scope):
        canonical(file)
    require(all(file != scope and file.is_relative_to(scope) for file in (source, plan_file, output)), 'Owned runner temporary scope required')
    require(not output.exists() and output.parent.is_dir(), 'Fresh owned staging directory required')
    require(source != plan_file and not source.is_relative_to(output) and not plan_file.is_relative_to(output), 'Independent input paths required')
    digest(sha256)
    digest(plan_sha256)
    require(type(size) is int and 0 < size <= MAX_ZIP, 'Bounded ZIP size required')
    plan_stat = plan_file.lstat()
    require(stat.S_ISREG(plan_stat.st_mode) and plan_stat.st_nlink == 1 and 0 < plan_stat.st_size <= 128 * 1024, 'Bounded independent plan required')
    plan_bytes = plan_file.read_bytes()
    require(hashlib.sha256(plan_bytes).hexdigest() == plan_sha256 and identity(plan_stat) == identity(plan_file.lstat()), 'Independent plan pin differs')
    plan = json.loads(plan_bytes, object_pairs_hook=pairs, parse_constant=lambda _: require(False, 'Nonfinite JSON refused'))
    require(plan['hubVersion'] == '0.1.17' and plan['platform'] == 'linux' and plan['arch'] == 'x86_64', 'Only private017 Linux x64 data admitted')
    require(plan['acceptanceOnly'] is True and all(plan[name] is False for name in ('nativeGuiAccepted', 'migrationAccepted',
            'authenticationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady')), 'No acceptance or release relabel')
    named = source.lstat()
    require(stat.S_ISREG(named.st_mode) and named.st_nlink == 1 and named.st_size == size, 'Exact single-link ZIP required')
    fd = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as file:
        before = os.fstat(file.fileno())
        require(opened_identity(before) == opened_identity(named), 'ZIP replaced before opening')
        sha, count = hashlib.sha256(), 0
        for chunk in iter(lambda: file.read(65536), b''):
            count += len(chunk)
            require(count <= size, 'ZIP exceeded bound')
            sha.update(chunk)
        require(count == size and sha.hexdigest() == sha256, 'ZIP byte pin differs')
        file.seek(0)
        with zipfile.ZipFile(file) as archive:
            entries = archive.infolist()
            require(len(entries) == len(NAMES) and {entry.filename for entry in entries} == NAMES, 'Exact017 input member set required')
            expanded = 0
            for entry in entries:
                mode = entry.external_attr >> 16
                require(not entry.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG) and not entry.flag_bits & 1, 'Special or encrypted member refused')
                bound = 768 * 1024 * 1024 if entry.filename == 'baseline016.zip' else 256 * 1024 * 1024 if entry.filename == 'modules.tar.gz' else 4096 if entry.filename.endswith('.minisig') else 128 * 1024
                require(0 < entry.file_size <= bound, 'Input member exceeds bound')
                expanded += entry.file_size
                require(expanded <= MAX_ZIP, 'Expanded017 input exceeds bound')
            require(archive.read('plan.json') == plan_bytes, 'Signed ZIP plan differs from independent approved plan')
            output.mkdir(mode=0o700)
            for entry in entries:
                target = output / entry.filename
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                canonical(target)
                count = 0
                with archive.open(entry) as member, target.open('xb') as destination:
                    for chunk in iter(lambda: member.read(65536), b''):
                        count += len(chunk)
                        require(count <= entry.file_size, 'Inflated member exceeds bound')
                        destination.write(chunk)
                require(count == entry.file_size, 'Short ZIP member')
                target.chmod(0o600)
        canonical(source)
        canonical(plan_file)
        require(identity(before) == identity(os.fstat(file.fileno())) and identity(named) == identity(source.lstat()), 'ZIP changed during staging')
        require(identity(plan_stat) == identity(plan_file.lstat()) and plan_file.read_bytes() == plan_bytes, 'Plan changed during staging')
    return {'scope': 'private017-data-staging-only', 'planSha256': plan_sha256, 'signaturesVerified': False, 'releaseReady': False}


def stage_baseline(source, expected, output):
    """Windows signing preflight only; the Linux package verifier is not replaced."""
    require(sys.platform == 'win32', 'Fixed Windows baseline-staging entrypoint required')
    require(set(expected) == {'zip', 'files'} and set(expected['files']) == set(BASELINE), 'Exact baseline member pins required')
    for value in [expected['zip'], *expected['files'].values()]:
        require(set(value) == {'size', 'sha256'} and type(value['size']) is int and 0 < value['size'] <= 768 * 1024 * 1024, 'Bounded baseline pin required')
        digest(value['sha256'])
    require(all(value['size'] <= 256 * 1024 * 1024 for value in expected['files'].values()), 'Baseline member exceeds bound')
    for file in (source, output):
        canonical(file)
    require(not output.exists() and output.parent.is_dir() and not source.is_relative_to(output), 'Fresh baseline staging required')
    named = source.lstat()
    require(stat.S_ISREG(named.st_mode) and named.st_nlink == 1 and named.st_size == expected['zip']['size'], 'Exact single-link baseline ZIP required')
    fd = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(opened_identity(before) == opened_identity(named), 'Baseline replaced before opening')
        sha, count = hashlib.sha256(), 0
        for chunk in iter(lambda: stream.read(65536), b''):
            count += len(chunk)
            require(count <= named.st_size, 'Baseline ZIP exceeded bound')
            sha.update(chunk)
        require(count == named.st_size and sha.hexdigest() == expected['zip']['sha256'], 'Baseline ZIP differs')
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            names, expanded = set(), 0
            require(len(archive.infolist()) <= 256, 'Baseline ZIP inventory exceeds bound')
            for member in archive.infolist():
                name = member.filename.rstrip('/') if member.is_dir() else member.filename
                mode = member.external_attr >> 16
                require(name not in names and not name.startswith('/') and '\\' not in name
                        and all(part not in ('', '.', '..') for part in name.split('/')), 'Ambiguous baseline ZIP path')
                require(not member.flag_bits & 1 and stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'Special or encrypted baseline ZIP entry')
                names.add(name)
                expanded += member.file_size
                require(0 <= member.file_size <= 512 * 1024 * 1024 and expanded <= 512 * 1024 * 1024, 'Expanded baseline ZIP exceeds bound')
            for key, (name, _) in BASELINE.items():
                require(name in names and archive.getinfo(name).file_size == expected['files'][key]['size'], 'Missing or oversized baseline member')
            output.mkdir(mode=0o700)
            for key, (name, filename) in BASELINE.items():
                raw = archive.read(name)
                require(len(raw) == expected['files'][key]['size'] and hashlib.sha256(raw).hexdigest() == expected['files'][key]['sha256'], 'Baseline member differs')
                with (output / filename).open('xb') as target:
                    target.write(raw)
                (output / filename).chmod(0o600)
        canonical(source)
        require(identity(before) == identity(os.fstat(stream.fileno())) and identity(named) == identity(source.lstat()), 'Baseline changed during staging')
    return {'scope': 'pinned016-zip-staging-only', 'files': expected['files'], 'releaseReady': False}


if __name__ == '__main__':
    try:
        if sys.platform == 'win32':
            args = sys.argv[1:]
            require(len(args) == 4 and args[0] == '--stage-baseline', 'Use --stage-baseline ZIP EXPECTED_JSON NEW_DIRECTORY')
            expected_file = Path(args[2])
            canonical(expected_file)
            require(expected_file.is_file() and expected_file.stat().st_nlink == 1 and expected_file.stat().st_size <= 32768, 'Bounded baseline expected JSON required')
            expected = json.loads(expected_file.read_bytes(), object_pairs_hook=pairs)
            print(json.dumps(stage_baseline(Path(args[1]), expected, Path(args[3]))))
            sys.exit(0)
        env = os.environ
        require(env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_ENVIRONMENT') == 'github-hosted'
                and env.get('GITHUB_REPOSITORY') == 'BOBWORKS-XR/CREATOR-HUB' and env.get('GITHUB_REPOSITORY_ID') == '1364807512'
                and env.get('RUNNER_OS') == 'Linux' and env.get('RUNNER_ARCH') == 'X64'
                and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
                and env.get('GITHUB_REF') == 'refs/heads/validation/linux-private-update-fixture-017'
                and env.get('CREATOR_LINUX_PRIVATE_UPDATE_FIXTURE_017') == '1', 'Exact manual private017 runner required')
        args = sys.argv[1:]
        require(len(args) == 6, 'Use ZIP SHA256 BYTES PLAN PLAN_SHA256 NEW_DIRECTORY')
        print(json.dumps(stage(Path(args[0]), args[1], int(args[2]), Path(args[3]), args[4], Path(args[5]), Path(env['RUNNER_TEMP']).resolve(strict=True))))
    except Exception as error:
        print(str(error)[:1500], file=sys.stderr)
        sys.exit(2)
