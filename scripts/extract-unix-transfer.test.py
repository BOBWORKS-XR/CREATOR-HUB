import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import warnings
import zipfile

SCRIPT = Path(__file__).with_name('extract-unix-transfer.py').resolve()
spec = importlib.util.spec_from_file_location('extract_unix_transfer', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def setUp(self):
        artifacts = SCRIPT.parent.parent / 'artifacts'
        artifacts.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='transfer-python-test-', dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'original.zip'
        self.output = self.root / 'acquired'
        self.bodies = {name: ('Never execute this payload: ' + name).encode() for name in module.NAMES}

    def write(self, names=None, kind=stat.S_IFREG, compression=zipfile.ZIP_DEFLATED):
        with warnings.catch_warnings(), zipfile.ZipFile(self.source, 'w', compression=compression) as archive:
            warnings.simplefilter('ignore', UserWarning)
            for name in sorted(module.NAMES) if names is None else names:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (kind | 0o644) << 16
                entry.compress_type = compression
                archive.writestr(entry, self.bodies.get(name, b'unknown'))
        return self.pin()

    def pin(self):
        return hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source.stat().st_size

    def call(self, digest=None, size=None, **changes):
        digest, size = self.pin() if digest is None else (digest, size)
        return module.extract(changes.get('source', self.source), digest, size,
                              changes.get('output', self.output), changes.get('scope', self.root))

    def central(self, name, change):
        body = bytearray(self.source.read_bytes())
        offset = body.index(b'PK\x01\x02')
        while True:
            n, extra, comment = struct.unpack_from('<HHH', body, offset + 28)
            if body[offset + 46:offset + 46 + n].decode() == name:
                change(body, offset)
                self.source.write_bytes(body)
                return self.pin()
            offset += 46 + n + extra + comment
            self.assertEqual(body[offset:offset + 4], b'PK\x01\x02')

    def test_exact_original_bytes_and_result_no_overwrite(self):
        digest, size = self.write()
        original = self.source.read_bytes()
        self.assertEqual(self.call(digest, size), module.RESULT)
        self.assertEqual({p.name for p in self.output.iterdir()}, module.NAMES)
        for name, body in self.bodies.items():
            self.assertEqual((self.output / name).read_bytes(), body)
        self.assertEqual(self.source.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, 'immutable'):
            self.call(digest, size)
        self.assertEqual(self.source.read_bytes(), original)

    def test_named_and_held_file_identity_agree_on_the_actual_host(self):
        self.write()
        flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0)
        with os.fdopen(os.open(self.source, flags), 'rb') as held:
            self.assertEqual(module.identity(self.source.lstat()), module.identity(os.fstat(held.fileno())))

    def test_stored_and_deflated_zip_supported(self):
        for compression in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]:
            with self.subTest(compression=compression):
                self.write(compression=compression)
                self.assertEqual(self.call(output=self.root / str(compression)), module.RESULT)

    def test_pin_failures_refuse_before_creating_output(self):
        digest, size = self.write()
        for d, s in [('f' * 64, size), (digest, size + 1), (digest.upper(), size),
                     (digest, 0), (digest, module.MAX_ZIP + 1), (digest, True)]:
            with self.subTest(d=d, size=s), self.assertRaises(ValueError):
                self.call(d, s)
            self.assertFalse(self.output.exists())

    def test_missing_extra_duplicate_traversal_backslash_and_directory_names(self):
        names = sorted(module.NAMES)
        for altered in [names[:-1], [*names, 'extra'], [*names, names[0]],
                        ['../modules.tar.gz', *names[1:]],
                        ['nested\\modules.tar.gz', *names[1:]],
                        ['modules.tar.gz/', *names[1:]]]:
            with self.subTest(names=altered):
                self.write(altered)
                with self.assertRaisesRegex(ValueError, 'three-file'):
                    self.call()
                self.assertFalse(self.output.exists())

    def test_nul_wire_name_cannot_be_normalized_to_an_allowed_member(self):
        self.write()
        self.central('prepared-unix.json', lambda b, o: b.__setitem__(o + 46 + 16, 0))
        with self.assertRaisesRegex(ValueError, 'three-file'):
            self.call()
        self.assertFalse(self.output.exists())

    def test_special_members_and_dos_directories_refuse_before_output(self):
        for kind in [stat.S_IFLNK, stat.S_IFDIR, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFBLK, stat.S_IFSOCK]:
            with self.subTest(kind=kind):
                self.write(kind=kind)
                with self.assertRaisesRegex(ValueError, 'Special'):
                    self.call()
                self.assertFalse(self.output.exists())
        self.write()
        self.central('modules.tar.gz', lambda b, o: struct.pack_into('<I', b, o + 38, (stat.S_IFREG | 0o644) << 16 | 0x10))
        with self.assertRaisesRegex(ValueError, 'Special'):
            self.call()
        self.assertFalse(self.output.exists())

    def test_encrypted_flags_refuse_before_output(self):
        for flag in [1, 64]:
            self.write()
            self.central('modules.tar.gz', lambda b, o: struct.pack_into('<H', b, o + 8, flag))
            with self.assertRaisesRegex(ValueError, 'Encrypted'):
                self.call()
            self.assertFalse(self.output.exists())

    def test_oversized_empty_and_unsupported_members_refuse_before_output(self):
        for name, length in [('modules.tar.gz', module.MAX_TAR + 1),
                             ('prepared-unix.json', module.MAX_META + 1), ('transfer-binding.json', 0)]:
            self.write()
            self.central(name, lambda b, o: struct.pack_into('<I', b, o + 24, length))
            with self.assertRaisesRegex(ValueError, 'bound'):
                self.call()
            self.assertFalse(self.output.exists())
        self.write()
        self.central('modules.tar.gz', lambda b, o: struct.pack_into('<H', b, o + 10, zipfile.ZIP_BZIP2))
        with self.assertRaisesRegex(ValueError, 'compression'):
            self.call()
        self.assertFalse(self.output.exists())

    def test_hardlinked_zip_refuses_without_changes(self):
        self.write()
        alias = self.root / 'alias.zip'
        os.link(self.source, alias)
        before = self.source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'single-link'):
            self.call()
        self.assertFalse(self.output.exists())
        self.assertEqual(alias.read_bytes(), before)

    def test_scope_and_noncanonical_paths_refuse_before_output(self):
        self.write()
        other = self.root / 'other'
        other.mkdir()
        for changes in [{'scope': other}, {'source': str(self.root) + os.sep + '..' + os.sep + self.root.name + os.sep + 'original.zip'},
                        {'output': str(self.root) + os.sep + '.' + os.sep + 'output'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.call(**changes)
            self.assertFalse(self.output.exists())

    def test_windows_reparse_attribute_refuses_even_without_symlink_mode(self):
        self.write()
        original = Path.lstat

        def attributes(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == self.root:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
            return info

        with mock.patch.object(Path, 'lstat', attributes), self.assertRaisesRegex(ValueError, 'reparse'):
            self.call()
        self.assertFalse(self.output.exists())

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows junction check')
    def test_actual_windows_junction_in_source_or_output_path_is_refused(self):
        self.write()
        link = self.root / 'junction'
        subprocess.run(['node', '-e', "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')",
                        str(self.root), str(link)], check=True, capture_output=True)
        try:
            for changes in [{'source': link / 'original.zip'}, {'output': link / 'output'}]:
                with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'reparse'):
                    self.call(**changes)
            self.assertFalse(self.output.exists())
        finally:
            os.rmdir(link)

    def test_source_identity_changed_after_hash_refuses_before_output(self):
        self.write()
        original = module.members

        def changed(archive):
            entries = original(archive)
            info = self.source.stat()
            os.utime(self.source, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000000))
            return entries

        with mock.patch.object(module, 'members', changed), self.assertRaisesRegex(ValueError, 'ZIP changed'):
            self.call()
        self.assertFalse(self.output.exists())

    def test_held_change_time_drift_refuses_even_when_named_identity_matches(self):
        self.write()
        original = os.fstat
        calls = 0

        def changed(fd):
            nonlocal calls
            info = original(fd)
            calls += 1
            if calls > 1:
                values = {name: getattr(info, name) for name in [
                    'st_dev', 'st_ino', 'st_size', 'st_mode', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns']}
                for name in ['st_birthtime_ns', 'st_file_attributes']:
                    if hasattr(info, name):
                        values[name] = getattr(info, name)
                values['st_ctime_ns'] += 1
                return SimpleNamespace(**values)
            return info

        with mock.patch.object(os, 'fstat', changed), self.assertRaisesRegex(ValueError, 'ZIP changed'):
            self.call()
        self.assertFalse(self.output.exists())

    def test_exclusive_write_keeps_a_foreign_file_appearing_after_review(self):
        self.write()
        original = zipfile.ZipFile.open
        collision = sorted(module.NAMES)[0]

        def replaced(archive, entry, *args, **kwargs):
            if entry.filename == collision:
                (self.output / collision).write_bytes(b'foreign evidence')
            return original(archive, entry, *args, **kwargs)

        with mock.patch.object(zipfile.ZipFile, 'open', replaced), self.assertRaises(FileExistsError):
            self.call()
        self.assertEqual((self.output / collision).read_bytes(), b'foreign evidence')

    def test_crc_failure_keeps_partial_output_and_original_zip(self):
        self.write(compression=zipfile.ZIP_STORED)
        with zipfile.ZipFile(self.source) as archive:
            entry = archive.infolist()[0]
        body = bytearray(self.source.read_bytes())
        n, extra = struct.unpack_from('<HH', body, entry.header_offset + 26)
        body[entry.header_offset + 30 + n + extra] ^= 1
        self.source.write_bytes(body)
        original = self.source.read_bytes()
        with self.assertRaises(zipfile.BadZipFile):
            self.call()
        self.assertTrue(self.output.is_dir())
        self.assertEqual(self.source.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, 'immutable'):
            self.call()

    def test_inflated_or_truncated_stream_cannot_report_success(self):
        self.write()
        for body, message in [(b'x' * 1024, 'exceeds bound'), (b'x', 'Truncated')]:
            output = self.root / message.replace(' ', '-')
            with mock.patch.object(zipfile.ZipFile, 'open', return_value=io.BytesIO(body)), self.assertRaisesRegex(ValueError, message):
                self.call(output=output)
            self.assertTrue(output.is_dir(), 'Failure evidence must not be deleted')
            self.assertEqual(self.source.read_bytes()[:4], b'PK\x03\x04')

    def test_source_drift_during_streaming_preserves_partial_output_but_refuses(self):
        self.write()
        original = zipfile.ZipFile.open

        def changed(archive, entry, *args, **kwargs):
            result = original(archive, entry, *args, **kwargs)
            info = self.source.stat()
            os.utime(self.source, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000000))
            return result

        with mock.patch.object(zipfile.ZipFile, 'open', changed), self.assertRaisesRegex(ValueError, 'ZIP changed'):
            self.call()
        self.assertTrue(self.output.is_dir())

    def test_late_output_mutation_is_preserved_and_refused(self):
        self.write()
        original = zipfile.ZipFile.open
        names = sorted(module.NAMES)

        def changed(archive, entry, *args, **kwargs):
            if entry.filename == names[-1]:
                (self.output / names[0]).write_bytes(b'foreign later change')
            return original(archive, entry, *args, **kwargs)

        with mock.patch.object(zipfile.ZipFile, 'open', changed), self.assertRaisesRegex(ValueError, 'Output file changed'):
            self.call()
        self.assertEqual((self.output / names[0]).read_bytes(), b'foreign later change')

    def test_cli_uses_fixed_artifacts_scope_and_identical_json_contract(self):
        digest, size = self.write()
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), str(self.source), digest, str(size), str(self.output)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), module.RESULT)
        refused = subprocess.run([sys.executable, '-B', str(SCRIPT), str(self.source), digest, str(size), str(self.root.parent.parent / 'not-artifacts')],
                                 capture_output=True, text=True, timeout=10)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(refused.stdout, '')
        self.assertIn('artifacts directory', refused.stderr)


if __name__ == '__main__':
    unittest.main()
