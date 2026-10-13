"""Bounded build-input extraction only; no signature, execution or acceptance."""
import argparse
import hashlib
import os
from pathlib import Path
import stat
import zipfile

NAMES = {
    'modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json',
    'routing/router.json', 'routing/router.minisig',
    'routing/runtime.json', 'routing/runtime.minisig',
    'handoff.json', 'handoff.minisig',
}
MAX_ZIP = 300 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(file):
    require(file.is_absolute() and str(file) == os.path.normpath(file), 'Canonical absolute path required')
    for part in [file, *file.parents]:
        try:
            require(not stat.S_ISLNK(part.lstat().st_mode), 'Redirected ancestor refused')
        except FileNotFoundError:
            pass


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mode,
            info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def stage(source, digest, expected_size, output, scope):
    require(os.name == 'posix', 'Native Unix extraction required')
    canonical(source)
    canonical(output)
    canonical(scope)
    require(source.is_relative_to(scope) and output.is_relative_to(scope)
            and source != scope and output != scope, 'Owned runner temporary scope required')
    require(not output.exists(), 'Output is immutable')
    require(len(digest) == 64 and all(c in '0123456789abcdef' for c in digest), 'Exact ZIP SHA-256 required')
    require(0 < expected_size <= MAX_ZIP, 'Bounded ZIP size required')
    named = source.lstat()
    require(stat.S_ISREG(named.st_mode) and named.st_nlink == 1 and named.st_size == expected_size, 'Exact regular single-link ZIP required')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        before = os.fstat(file.fileno())
        require(identity(before) == identity(named), 'ZIP replaced before capture')
        actual = hashlib.sha256()
        count = 0
        for block in iter(lambda: file.read(65536), b''):
            count += len(block)
            require(count <= expected_size, 'ZIP grew beyond bound')
            actual.update(block)
        require(count == expected_size and actual.hexdigest() == digest, 'ZIP hash differs')
        file.seek(0)
        with zipfile.ZipFile(file) as archive:
            entries = archive.infolist()
            require(len(entries) == len(NAMES) and {e.filename for e in entries} == NAMES, 'Exact nine-file handoff required')
            for entry in entries:
                mode = entry.external_attr >> 16
                require(not entry.is_dir() and (stat.S_IFMT(mode) in (0, stat.S_IFREG))
                        and not (entry.flag_bits & 1), 'Special or encrypted ZIP member refused')
                limit = 256 * 1024 * 1024 if entry.filename == 'modules.tar.gz' else 4096 if entry.filename.endswith('.minisig') else 128 * 1024
                require(0 < entry.file_size <= limit, 'Member exceeds bound')
            output.mkdir(mode=0o700)
            for entry in entries:
                destination = output / entry.filename
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                canonical(destination)
                count = 0
                with archive.open(entry) as member, destination.open('xb') as target:
                    for block in iter(lambda: member.read(65536), b''):
                        count += len(block)
                        require(count <= entry.file_size, 'Inflated member exceeds declared bound')
                        target.write(block)
                require(count == entry.file_size, 'Truncated member')
                destination.chmod(0o644)
        canonical(source)
        require(identity(before) == identity(os.fstat(file.fileno())) == identity(source.lstat()), 'ZIP changed during extraction')


def main():
    env = os.environ
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and env.get('GITHUB_REPOSITORY') == 'BOBWORKS-XR/CREATOR-HUB'
            and env.get('RUNNER_OS') in ('Linux', 'macOS'), 'Explicit native GitHub runner required')
    parser = argparse.ArgumentParser()
    parser.add_argument('zip', type=Path)
    parser.add_argument('sha256')
    parser.add_argument('bytes', type=int)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    stage(args.zip, args.sha256, args.bytes, args.output, Path(env['RUNNER_TEMP']).resolve(strict=True))
    print('Exact handoff ZIP staged. Signatures, native operation and release remain unverified.')


if __name__ == '__main__':
    main()
