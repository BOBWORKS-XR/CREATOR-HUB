"""Synthetic data-only refusals, not Linux compilation or API acceptance."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('compiler_input', Path(__file__).with_name('linux-root-compiler-input.py'))
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)


class InputTests(unittest.TestCase):
    def archive(self, directory, variant='ok'):
        pins = copy.deepcopy(I.PINS)
        bodies = {name: ('fixture:' + name).encode() for name in pins['selected']}
        files = {'modules/mcp/server/' + n: {**I.pin(b), 'mode': 420} for n, b in bodies.items()}
        for i in range(9):
            files['unselected-' + str(i)] = {**I.pin(b'not-selected'), 'mode': 420}
        pins['selected'] = {n: files['modules/mcp/server/' + n] for n in bodies}
        if variant == 'payload': pins['selected']['runtime/node']['sha256'] = '0' * 64
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
            for index, name in enumerate(files):
                if variant == 'missing' and index == 0: continue
                body = bodies.get(name.removeprefix('modules/mcp/server/'), b'not-selected')
                info = tarfile.TarInfo('../escape' if variant == 'traversal' and index == 0 else name)
                info.size = len(body)
                if variant == 'link' and index == 0: info.type = tarfile.SYMTYPE; info.linkname = '/foreign'
                tar.addfile(info, io.BytesIO(body))
        compressed = buffer.getvalue(); pins['tar'] = I.pin(compressed)
        prepared = {'source': {'sourceCommit': pins['source'], 'runId': pins['runId']}, 'unsigned': True, 'privateKeyIncluded': False, 'files': files}
        if variant == 'source': prepared['source']['sourceCommit'] = 'wrong'
        file = directory / 'input.zip'
        with zipfile.ZipFile(file, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr('modules.tar.gz', compressed)
            zipped.writestr('prepared-unix.json', json.dumps(prepared))
            zipped.writestr('transfer-binding.json', '{}')
            if variant == 'zip-traversal': zipped.writestr('../foreign', 'not-selected')
        pins['zip'] = I.pin(file.read_bytes())
        if variant == 'zip-hash': pins['zip']['sha256'] = '0' * 64
        return pins, file, directory / 'payload'

    def test_actual_product_source_context_and_45_linux_test_names(self):
        self.assertEqual(I.check_source()['expectedLinuxRootTests'], 45)

    def test_mutated_mcp_backend_ui_and_raw_signed_data_are_refused(self):
        read = Path.read_bytes
        for name in [next(iter(I.PINS['sourcePins'])), 'src-tauri/src/main.rs', 'src/mcp-route-update.js', 'tests/fixtures/root-handoff/creator-hub-linux-x86_64-deb.json']:
            def changed(file):
                return b'changed' if file == I.ROOT / name else read(file)
            with self.subTest(name=name), patch.object(Path, 'read_bytes', changed), self.assertRaises(ValueError): I.check_source()

    def test_frozen_product_parent_tree_cleanliness_and_five_file_delta(self):
        def answers(*args, **kwargs):
            command = args[0][2:]
            if command[0] == 'rev-list': return 'new ' + I.PINS['compilerSource']
            if command[0] == 'rev-parse': return I.PINS['compilerTree']
            if command[0] == 'status': return ''
            return '\n'.join(I.PINS['ciDelta'])
        with patch.object(I.subprocess, 'check_output', side_effect=answers): I.check_git_context()
        for fail in ['rev-list', 'rev-parse', 'status', 'diff-tree']:
            def wrong(*args, **kwargs): return 'wrong' if args[0][2] == fail else answers(*args, **kwargs)
            with self.subTest(fail=fail), patch.object(I.subprocess, 'check_output', side_effect=wrong), self.assertRaises(ValueError): I.check_git_context()

    def test_only_four_selected_raw_files_are_written_and_not_executed(self):
        with tempfile.TemporaryDirectory() as temp:
            pins, archive, out = self.archive(Path(temp).resolve())
            with patch.object(I, 'PINS', pins): result = I.stage_archive(archive, out)
            self.assertFalse(result['executed']); self.assertFalse(result['signed'])
            self.assertEqual(sorted(p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()), sorted(pins['selected']))
            for name in pins['selected']: self.assertEqual(out.joinpath(name).read_bytes(), ('fixture:' + name).encode())

    def test_bad_zip_source_tar_types_missing_and_payload_pins_refuse_before_output(self):
        for variant in ['zip-hash', 'zip-traversal', 'source', 'traversal', 'link', 'missing', 'payload']:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                pins, archive, out = self.archive(Path(temp).resolve(), variant)
                with patch.object(I, 'PINS', pins), self.assertRaises(ValueError): I.stage_archive(archive, out)
                self.assertFalse(out.exists())

    def test_existing_output_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            pins, archive, out = self.archive(Path(temp).resolve()); out.mkdir(); (out / 'retained').write_bytes(b'old')
            with patch.object(I, 'PINS', pins), self.assertRaises(ValueError): I.stage_archive(archive, out)
            self.assertEqual((out / 'retained').read_bytes(), b'old')

    def test_actual_inventory_rejects_zero_scaffold_missing_duplicate_and_extra_tests(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'inventory'
            names = I.PINS['expectedTests']
            file.write_text('\n'.join(n + ': test' for n in names)); self.assertEqual(I.inventory(file)['actualRootHandoffTests'], 45)
            for values in [[], names[:-1], names + [names[0]], names + ['mcp_update_handoff::tests::foreign']]:
                file.write_text('\n'.join(n + ': test' for n in values))
                with self.assertRaises(ValueError): I.inventory(file)


class ResourceTests(unittest.TestCase):
    def fixture(self, directory, variant='ok'):
        root, temporary, initial = directory / 'workspace', directory / 'six-inputs', directory / 'initial-four'
        root.mkdir(); initial.mkdir()
        pins = copy.deepcopy(I.PINS); r = pins['tauriResources']
        bodies = {name: (b'24.17.0\n' if name == 'runtime/VERSION' else ('producer:' + name).encode()) for name in r['producer']}
        r['producer'] = {name: {**I.pin(raw), 'mode': 493 if name == 'runtime/node' else 420} for name, raw in bodies.items()}
        pins['selected'] = {name: r['producer'][name] for name in pins['selected']}
        for name, raw in bodies.items():
            if name in pins['selected']:
                file = initial / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(raw)
        for name, producer in r['tracked'].items():
            file = root / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(bodies[producer])
        for field in ['icons', 'frontend']:
            for name in r[field]:
                file = root / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(('tracked:' + name).encode()); r[field][name] = I.pin(file.read_bytes())
        config_file = root / r['config']['path']; config_file.parent.mkdir(parents=True, exist_ok=True)
        config = {'build': {'frontendDist': '../src'}, 'bundle': {'resources': r['map'], 'icon': [Path(n).relative_to(config_file.parent.relative_to(root)).as_posix() for n in r['icons']]}}
        config_file.write_text(json.dumps(config)); r['config'].update(I.pin(config_file.read_bytes()))
        files = {'modules/mcp/server/' + n: p for n, p in r['producer'].items()}
        for index in range(5): files['unselected-' + str(index)] = {**I.pin(b'unselected'), 'mode': 420}
        tarbytes = io.BytesIO()
        with tarfile.open(fileobj=tarbytes, mode='w:gz') as tar:
            for name, expected in files.items():
                role = name.removeprefix('modules/mcp/server/'); raw = bodies.get(role, b'unselected')
                if variant == 'missing-version' and role == 'runtime/VERSION': continue
                if variant in ['runtime/VERSION', 'runtime/LICENSE'] and role == variant: raw = raw[:-1] + b'X'
                item = tarfile.TarInfo(name); item.size = len(raw); tar.addfile(item, io.BytesIO(raw))
        compressed = tarbytes.getvalue(); pins['tar'] = I.pin(compressed)
        archive = directory / 'original.zip'
        prepared = {'source': {'sourceCommit': pins['source'], 'runId': pins['runId']}, 'unsigned': True, 'privateKeyIncluded': False, 'files': files}
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr('modules.tar.gz', compressed); zipped.writestr('prepared-unix.json', json.dumps(prepared)); zipped.writestr('transfer-binding.json', '{}')
        pins['zip'] = I.pin(archive.read_bytes())
        return pins, archive, temporary, initial, root

    def test_complete_nine_map_five_icons_25_frontend_and_independent_alias(self):
        with tempfile.TemporaryDirectory() as temp:
            pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
            before = {n: (initial / n).read_bytes() for n in pins['selected']}
            with patch.object(I, 'PINS', pins):
                result = I.stage_resources(archive, temporary, initial, root)
                self.assertEqual(result['resourceMap'], 9); self.assertEqual(result['selectedRawInputs'], 6)
                self.assertEqual(result['icons'], 5); self.assertEqual(result['frontend'], 25)
            release = root / 'modules/mcp/release'
            self.assertEqual((release / 'runtime/node').read_bytes(), (release / 'runtime/node.exe').read_bytes())
            self.assertNotEqual((release / 'runtime/node').stat().st_ino, (release / 'runtime/node.exe').stat().st_ino)
            self.assertEqual(len([p for p in release.rglob('*') if p.is_file()]), 5)
            self.assertEqual({n: (initial / n).read_bytes() for n in pins['selected']}, before)

    def test_missing_version_or_wrong_version_and_license_refuse_before_release(self):
        for variant in ['missing-version', 'runtime/VERSION', 'runtime/LICENSE']:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve(), variant)
                with patch.object(I, 'PINS', pins), self.assertRaises(ValueError): I.stage_resources(archive, temporary, initial, root)
                self.assertFalse((root / 'modules/mcp/release').exists())

    def test_missing_tracked_input_icon_frontend_or_complete_map_refuses(self):
        for kind in ['tracked', 'icons', 'frontend', 'map']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
                if kind == 'map':
                    config_file = root / pins['tauriResources']['config']['path']; value = json.loads(config_file.read_bytes())
                    value['bundle']['resources'].pop('../../release/runtime/node.exe'); config_file.write_text(json.dumps(value)); pins['tauriResources']['config'].update(I.pin(config_file.read_bytes()))
                else: (root / next(iter(pins['tauriResources'][kind]))).unlink()
                with patch.object(I, 'PINS', pins), self.assertRaises((ValueError, FileNotFoundError)): I.stage_resources(archive, temporary, initial, root)
                self.assertFalse(temporary.exists())

    def test_wrong_materialized_version_license_or_alias_is_not_repaired(self):
        for name in ['runtime/VERSION', 'runtime/LICENSE', 'runtime/node.exe']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
                with patch.object(I, 'PINS', pins):
                    I.stage_resources(archive, temporary, initial, root)
                    file = root / 'modules/mcp/release' / name; file.write_bytes(b'wrong')
                    with self.assertRaises(ValueError): I.validate_resources(root, materialized=True)
                    self.assertEqual(file.read_bytes(), b'wrong')

    def test_preexisting_release_or_resource_temporary_refuses_without_overwrite(self):
        for scope in ['release', 'temporary']:
            with self.subTest(scope=scope), tempfile.TemporaryDirectory() as temp:
                pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
                directory = root / 'modules/mcp/release' if scope == 'release' else temporary
                directory.mkdir(); (directory / 'retained').write_bytes(b'unchanged')
                with patch.object(I, 'PINS', pins), self.assertRaises(ValueError): I.stage_resources(archive, temporary, initial, root)
                self.assertEqual((directory / 'retained').read_bytes(), b'unchanged')

    def test_resource_stage_has_no_subprocess_execution_or_network_api_reuse(self):
        import socket
        with tempfile.TemporaryDirectory() as temp:
            pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
            with patch.object(I, 'PINS', pins), patch.object(I.subprocess, 'check_output', side_effect=AssertionError('No subprocess')) as process, \
                    patch.object(socket, 'socket', side_effect=AssertionError('No network')) as network:
                result = I.stage_resources(archive, temporary, initial, root)
                self.assertFalse(result['executed']); self.assertEqual(result['apiRequests'], 0)
                process.assert_not_called(); network.assert_not_called()

    def test_hardlinked_alias_and_extra_release_files_are_refused(self):
        for mode in ['hardlink', 'extra']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
                with patch.object(I, 'PINS', pins):
                    I.stage_resources(archive, temporary, initial, root)
                    release = root / 'modules/mcp/release'
                    if mode == 'hardlink': (release / 'runtime/node.exe').unlink(); os.link(release / 'runtime/node', release / 'runtime/node.exe')
                    else: (release / 'extra').write_bytes(b'not allowed')
                    with self.assertRaises(ValueError): I.validate_resources(root, materialized=True)

    def test_unexpected_frontend_or_config_override_is_refused(self):
        for mode in ['frontend', 'override']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                pins, archive, temporary, initial, root = self.fixture(Path(temp).resolve())
                if mode == 'frontend': (root / pins['tauriResources']['frontendRoot'] / 'unexpected').write_bytes(b'not tracked')
                with patch.object(I, 'PINS', pins), patch.dict(os.environ, {'TAURI_CONFIG': '{}' if mode == 'override' else ''}), self.assertRaises(ValueError):
                    I.stage_resources(archive, temporary, initial, root)


if __name__ == '__main__': unittest.main()
