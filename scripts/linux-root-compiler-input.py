"""Fixed compiler hash inputs only: no execution, signing, installation or extraction-all."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PINS = json.loads(Path(__file__).with_suffix('.json').read_bytes())


def require(value, message):
    if not value:
        raise ValueError(message)


def pin(body):
    return {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def check(body, expected):
    require(pin(body) == {k: expected[k] for k in ('size', 'sha256')}, 'Byte pin differs')


def regular(path, root):
    require(path.is_relative_to(root), 'Path escaped owned root')
    current = root
    require(not current.is_symlink() and current.is_dir(), 'Real root required')
    for part in path.relative_to(root).parts:
        current = current / part
        require(not current.is_symlink(), 'Redirected input refused')
    require(stat.S_ISREG(path.lstat().st_mode), 'Regular file required')


def check_source(root=ROOT):
    require(not (root / 'src-tauri-handoff-tests').exists(), 'Scaffold must not be source')
    require(len(PINS['sourcePins']) == 48, 'Exact source closure required')
    for name, expected in {**PINS['sourcePins'], **PINS['contextPins']}.items():
        file = root / name
        regular(file, root)
        raw = file.read_bytes()
        if expected['normalizeLf']:
            raw = raw.replace(b'\r\n', b'\n')
        check(raw, expected)
    tests = (root / 'src-tauri/src/mcp_update_handoff.test.rs').read_text()
    require('#[ignore' not in tests, 'Ignored handoff test refused')
    names = sorted('mcp_update_handoff::tests::' + n for n in re.findall(r'#\[test\]\s*fn\s+(\w+)', tests))
    require(names == PINS['expectedTests'] and len(names) == 45, 'Linux test source inventory differs')
    validate_resources(root, materialized=False)
    return {'sourceClosure': 48, 'expectedLinuxRootTests': 45, 'scaffoldExcluded': True}


def check_git_context(root=ROOT):
    def git(*args):
        return subprocess.check_output(['git', '--no-optional-locks', *args], cwd=root, text=True).strip()
    parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split()
    require(len(parents) == 2 and parents[1] == PINS['compilerSource'], 'One direct frozen072 parent required')
    require(git('rev-parse', PINS['compilerSource'] + '^{tree}') == PINS['compilerTree'], 'Frozen product tree differs')
    require(git('status', '--porcelain=v1', '--untracked-files=normal') == '', 'Clean source checkout required')
    changes = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').splitlines()
    require(sorted(changes) == PINS['ciDelta'], 'Exact reviewed CI child delta required')


def stage_archive(archive, output, *, selected_pins=None, server_pins=None):
    archive, output = Path(archive), Path(output)
    selected_pins = PINS['selected'] if selected_pins is None else selected_pins
    server_pins = {} if server_pins is None else server_pins
    require(not output.exists() and not output.is_symlink(), 'Output already exists')
    require(output.parent.resolve(strict=True) == output.parent, 'Owned real output parent required')
    before = archive.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == PINS['zip']['size'], 'Regular exact ZIP required')
    stamp = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
    fd = os.open(archive, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    selected = {}
    with os.fdopen(fd, 'rb') as stream:
        require(stamp(os.fstat(stream.fileno())) == stamp(before), 'ZIP changed before open')
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        require(digest.hexdigest() == PINS['zip']['sha256'], 'Raw ZIP digest differs')
        stream.seek(0)
        with zipfile.ZipFile(stream) as zipped:
            entries = zipped.infolist()
            require(len(entries) == 3 and {i.filename for i in entries} == {'modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'}, 'Exact ZIP members required')
            for info in entries:
                require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'ZIP encoding refused')
                require(not stat.S_ISLNK(info.external_attr >> 16), 'ZIP link refused')
                require(info.file_size <= (PINS['tar']['size'] if info.filename == 'modules.tar.gz' else 65536), 'ZIP member exceeds bound')
            prepared = json.loads(zipped.read('prepared-unix.json'))
            require(prepared['source']['sourceCommit'] == PINS['source'] and prepared['source']['runId'] == PINS['runId'], 'Producer source differs')
            require(prepared['unsigned'] is True and prepared['privateKeyIncluded'] is False, 'Unsigned input required')
            compressed = zipped.read('modules.tar.gz')
            check(compressed, PINS['tar'])
        expected_names = set(prepared['files'])
        require(len(expected_names) == 13, 'Fixed prepared inventory required')
        for name, expected in server_pins.items():
            require(prepared['files'].get('modules/mcp/server/' + name) == expected, 'Eight producer resource pins required')
        seen, server_seen, total = set(), set(), 0
        with tarfile.open(fileobj=io.BytesIO(compressed), mode='r|gz') as tar:
            for item in tar:
                name = item.name
                require(str(PurePosixPath(name)) == name and not name.startswith('/') and '..' not in PurePosixPath(name).parts and '\\' not in name, 'Noncanonical TAR name')
                require(item.isfile() and name in expected_names and name not in seen, 'Unexpected TAR member/type')
                seen.add(name); total += item.size
                require(total <= 161 * 1024 * 1024 and item.size == prepared['files'][name]['size'], 'TAR size differs')
                if name.startswith('modules/mcp/server/'):
                    relative = name.removeprefix('modules/mcp/server/')
                    if relative in selected_pins or relative in server_pins:
                        expected = selected_pins.get(relative, server_pins.get(relative))
                        require(prepared['files'][name] == expected, 'Selected metadata differs')
                        raw = tar.extractfile(item).read(expected['size'] + 1)
                        check(raw, expected)
                        if relative in server_pins:
                            server_seen.add(relative)
                        if relative in selected_pins:
                            selected[relative] = raw
        require(seen == expected_names and set(selected) == set(selected_pins), 'Missing exact selected input')
        require(server_seen == set(server_pins), 'Missing producer resource bytes')
        require(stamp(os.fstat(stream.fileno())) == stamp(before) and stamp(archive.lstat()) == stamp(before), 'ZIP changed during read')
    output.mkdir(mode=0o700)
    for name, raw in selected.items():
        file = output / name; file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with file.open('xb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    return {'files': {n: pin(raw) for n, raw in selected.items()}, 'rawBytesOnly': True, 'executed': False, 'signed': False}


def no_release(root=ROOT):
    require(not os.path.lexists(root / 'modules/mcp/release'), 'Release layout must remain absent through the MCP suite')


def closed_files(directory, root):
    require(directory.is_dir() and not directory.is_symlink(), 'Real tracked directory required')
    result = set()
    for parent, dirs, files in os.walk(directory, followlinks=False):
        require(all(not (Path(parent) / n).is_symlink() for n in dirs), 'Redirected directory refused')
        for name in files:
            file = Path(parent) / name; regular(file, root)
            result.add(file.relative_to(root).as_posix())
    return result


def validate_resources(root=ROOT, *, materialized):
    require(not os.environ.get('TAURI_CONFIG'), 'Resource config override refused')
    r = PINS['tauriResources']; config_file = root / r['config']['path']
    regular(config_file, root); check(config_file.read_bytes(), r['config'])
    config = json.loads(config_file.read_bytes())
    require(len(r['producer']) == 8 and len(r['inputs']) == 6 and len(r['releaseFiles']) == 5 and len(r['tracked']) == 4, 'Finite producer/resource closure required')
    require(len(r['map']) == 9 and len(set(r['map'].values())) == 9 and config['bundle']['resources'] == r['map'], 'Complete nine-resource map required')
    require(len(r['icons']) == 5 and len(r['frontend']) == 25, 'Exact icons/frontend closure required')
    icon_names = [str(Path(n).relative_to(config_file.parent.relative_to(root))).replace('\\', '/') for n in r['icons']]
    require(config['bundle']['icon'] == icon_names, 'Five declared icons differ')
    frontend = Path(os.path.abspath(config_file.parent / config['build']['frontendDist']))
    require(config['build']['frontendDist'] == r['frontendDist'] and frontend == root / r['frontendRoot'], 'Fixed tracked frontend required')
    require(closed_files(frontend, root) == set(r['frontend']), 'Exact 25 tracked frontend files required')
    for name, expected in {**r['icons'], **r['frontend']}.items():
        regular(root / name, root); check((root / name).read_bytes(), expected)
    for name, producer in r['tracked'].items():
        regular(root / name, root); check((root / name).read_bytes(), r['producer'][producer])
    release = root / 'modules/mcp/release'
    resolved = {Path(os.path.abspath(config_file.parent / n)) for n in r['map']}
    expected = {release / n for n in r['releaseFiles']} | {root / n for n in r['tracked']}
    require(resolved == expected, 'All nine map resolutions must be fixed')
    if materialized:
        require(closed_files(release, root) == {'modules/mcp/release/' + n for n in r['releaseFiles']}, 'Exact five release files required')
        for file in resolved:
            regular(file, root)
            name = file.relative_to(root).as_posix()
            if name in r['tracked']:
                producer = r['tracked'][name]
            else:
                producer = r['releaseFiles'][file.relative_to(release).as_posix()]
                require(file.lstat().st_nlink == 1, 'Release resources must be regular independent copies')
            check(file.read_bytes(), r['producer'][producer])
        node, alias = (release / 'runtime/node').stat(), (release / 'runtime/node.exe').stat()
        require((node.st_dev, node.st_ino) != (alias.st_dev, alias.st_ino), 'Node alternate must be a regular independent copy')
    return {'resourceMap': 9, 'producerPins': 8, 'icons': 5, 'frontend': 25, 'trackedMatches': 4}


def verify_initial_four(directory):
    require(closed_files(directory, directory) == set(PINS['selected']), 'Initial four-input scope changed')
    for name, expected in PINS['selected'].items():
        check((directory / name).read_bytes(), expected)


def stage_resources(archive, temporary, initial_four, root=ROOT):
    no_release(root); validate_resources(root, materialized=False); verify_initial_four(initial_four)
    r = PINS['tauriResources']
    selected = {name: r['producer'][name] for name in r['inputs']}
    stage_archive(archive, temporary, selected_pins=selected, server_pins=r['producer'])
    release = root / 'modules/mcp/release'; release.mkdir(mode=0o700)
    for name, producer in r['releaseFiles'].items():
        source, target = temporary / producer, release / name
        regular(source, temporary); target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with source.open('rb') as original, target.open('xb') as output:
            for block in iter(lambda: original.read(65536), b''):
                output.write(block)
            output.flush(); os.fsync(output.fileno())
        if os.name == 'posix': target.chmod(r['producer'][producer]['mode'])
    result = validate_resources(root, materialized=True); verify_initial_four(initial_four)
    return {**result, 'selectedRawInputs': 6, 'releaseFiles': 5, 'initialFourUnchanged': True, 'executed': False, 'apiRequests': 0, 'signed': False}


def inventory(file):
    text = Path(file).read_text()
    names = [line.removesuffix(': test') for line in text.splitlines() if line.startswith('mcp_update_handoff::tests::')]
    require(sorted(names) == PINS['expectedTests'] and len(names) == 45, 'Actual Root Linux test inventory differs')
    return {'actualRootHandoffTests': len(names)}


if __name__ == '__main__':
    require(len(sys.argv) in (2, 3), 'Fixed mode only')
    if sys.argv[1] == 'source' and len(sys.argv) == 2:
        check_git_context()
        result = check_source()
    elif sys.argv[1] == 'stage' and len(sys.argv) == 2:
        directory = Path(os.environ['RUNNER_TEMP']).resolve(strict=True) / 'root-linux-compiler-input-40580977821'
        result = stage_archive(directory / 'original.zip', directory / 'payload')
    elif sys.argv[1] == 'no-release' and len(sys.argv) == 2:
        no_release(); result = {'releaseAbsent': True}
    elif sys.argv[1] == 'resources' and len(sys.argv) == 2:
        temporary = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        original = temporary / 'root-linux-compiler-input-40580977821'
        result = stage_resources(original / 'original.zip', temporary / PINS['tauriResources']['temporaryDirectory'], original / 'payload')
    elif sys.argv[1] == 'inventory' and len(sys.argv) == 3:
        result = inventory(sys.argv[2])
    else:
        raise ValueError('Unsupported mode')
    print(json.dumps(result, sort_keys=True))
