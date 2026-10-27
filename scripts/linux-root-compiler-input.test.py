"""Synthetic data-only refusals, not Linux compilation or API acceptance."""
import copy
import importlib.util
import io
import json
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


if __name__ == '__main__': unittest.main()
