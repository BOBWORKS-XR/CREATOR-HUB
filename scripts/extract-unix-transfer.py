"""Bounded original three-file ZIP acquisition; never verifies or executes TARs."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

NAMES = {'modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'}
MAX_ZIP = 768 * 1024 * 1024
MAX_TAR = 256 * 1024 * 1024
MAX_META = 128 * 1024
BLOCK = 65536
RESULT = {'downloadedZipVerified': True, 'transferContentsVerified': False, 'releaseReady': False}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def redirected(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def canonical(value):
    raw = os.fspath(value)
    path = Path(raw)
    require(path.is_absolute() and raw == os.path.normpath(raw) and raw == str(path),
            'Canonical absolute paths required')
    if os.name == 'nt':
        require(len(path.drive) == 2 and path.drive[0].isalpha() and path.drive[1] == ':',
                'Local drive paths required')
        for name in path.parts[1:]:
            require(':' not in name and not name.endswith((' ', '.'))
                    and name.split('.')[0].upper() not in {
                        'CON', 'PRN', 'AUX', 'NUL',
                        *('COM' + str(n) for n in range(1, 10)),
                        *('LPT' + str(n) for n in range(1, 10))},
                    'Noncanonical Windows path refused')
    for part in [path, *path.parents]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        require(not redirected(info), 'Redirected or reparse path refused')
        if part != path:
            require(stat.S_ISDIR(info.st_mode), 'Ordinary directory ancestors required')
    return path


def identity(info):
    # Windows Python 3.13 lstat/fstat disagree on legacy ctime semantics;
    # their explicit birthtime, file IDs and last-write time agree.
    changed = info.st_birthtime_ns if os.name == 'nt' else info.st_ctime_ns
    return (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_nlink,
            info.st_mtime_ns, changed,
            getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def directory_identity(path):
    canonical(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not redirected(info), 'Ordinary directory required')
    return info.st_dev, info.st_ino, info.st_mode


def members(archive):
    entries = archive.infolist()
    require(len(entries) == 3 and {entry.orig_filename for entry in entries} == NAMES
            and all(entry.orig_filename == entry.filename for entry in entries),
            'Exact unique three-file POSIX ZIP names required')
    for entry in entries:
        limit = MAX_TAR if entry.filename == 'modules.tar.gz' else MAX_META
        require(not entry.is_dir() and not (entry.external_attr & 0x10)
                and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG),
                'Special ZIP member refused')
        require(not entry.flag_bits & (1 | 64), 'Encrypted ZIP member refused')
        require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                'Unsupported ZIP compression refused')
        require(0 < entry.file_size <= limit and 0 < entry.compress_size <= MAX_ZIP,
                'ZIP member exceeds bound')
    return entries


def extract(source, digest, expected_size, output, scope):
    source, output, scope = (canonical(value) for value in (source, output, scope))
    require(source.is_relative_to(scope) and source != scope
            and output.is_relative_to(scope) and output != scope,
            'Transfer extraction stays inside the checkout artifacts directory')
    directory_identity(scope)
    parent = directory_identity(output.parent)
    require(not output.exists(), 'Output is immutable')
    require(isinstance(digest, str) and len(digest) == 64
            and all(c in '0123456789abcdef' for c in digest), 'Exact ZIP SHA-256 required')
    require(type(expected_size) is int and 0 < expected_size <= MAX_ZIP, 'Bounded ZIP size required')
    named = source.lstat()
    require(stat.S_ISREG(named.st_mode) and not redirected(named)
            and named.st_nlink == 1 and named.st_size == expected_size and named.st_ino != 0,
            'Exact regular single-link ZIP required')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
    with os.fdopen(os.open(source, flags), 'rb') as incoming:
        before = os.fstat(incoming.fileno())
        require(identity(before) == identity(named), 'ZIP replaced before capture')

        def stable():
            canonical(source)
            held = os.fstat(incoming.fileno())
            require(before.st_ctime_ns == held.st_ctime_ns
                    and identity(before) == identity(held)
                    == identity(source.lstat()), 'ZIP changed during extraction')

        actual, total = hashlib.sha256(), 0
        for block in iter(lambda: incoming.read(BLOCK), b''):
            total += len(block)
            require(total <= expected_size, 'ZIP grew beyond bound')
            actual.update(block)
        require(total == expected_size and actual.hexdigest() == digest, 'ZIP size or hash differs')
        stable()
        incoming.seek(0)
        with zipfile.ZipFile(incoming) as archive:
            entries = members(archive)
            stable()
            require(directory_identity(output.parent) == parent, 'Output parent changed')
            output.mkdir(mode=0o700)
            binding = directory_identity(output)
            written = {}
            for entry in entries:
                stable()
                require(directory_identity(output) == binding, 'Output directory changed')
                destination = canonical(output / entry.filename)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
                with archive.open(entry) as member, os.fdopen(os.open(destination, flags, 0o600), 'wb') as target:
                    count = 0
                    limit = MAX_TAR if entry.filename == 'modules.tar.gz' else MAX_META
                    for block in iter(lambda: member.read(BLOCK), b''):
                        count += len(block)
                        require(count <= entry.file_size and count <= limit, 'Inflated ZIP member exceeds bound')
                        target.write(block)
                    require(count == entry.file_size, 'Truncated ZIP member')
                    target.flush()
                    os.fsync(target.fileno())
                    captured = os.fstat(target.fileno())
                    require(stat.S_ISREG(captured.st_mode) and captured.st_nlink == 1
                            and captured.st_size == count and captured.st_ino != 0,
                            'Output file changed during extraction')
                    written[entry.filename] = identity(captured)
                canonical(destination)
                require(identity(destination.lstat()) == written[entry.filename], 'Output file replaced')
            stable()
            require(directory_identity(output) == binding, 'Output directory changed')
            require({item.name for item in output.iterdir()} == NAMES, 'Output file set changed')
            for name, expected in written.items():
                canonical(output / name)
                require(identity((output / name).lstat()) == expected, 'Output file changed after extraction')
    return dict(RESULT)


def main():
    require(len(sys.argv) == 5, 'Use ABS_ZIP EXPECTED_SHA256 EXPECTED_BYTES ABS_NEW_OUTPUT')
    script = canonical(__file__)
    return extract(sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], script.parent.parent / 'artifacts')


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        sys.exit(f'Transfer ZIP extraction refused: {error}')
