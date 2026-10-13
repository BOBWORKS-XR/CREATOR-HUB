import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('stage-signed-unix-handoff.py')
spec = importlib.util.spec_from_file_location('stage_handoff', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(os.name == 'posix', 'Native Unix file identity is required')
class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.zip = self.root / 'input.zip'
        self.output = self.root / 'output'

    def write(self, change=None):
        with zipfile.ZipFile(self.zip, 'w') as archive:
            for name in sorted(module.NAMES):
                info = zipfile.ZipInfo(name)
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                if change:
                    change(info)
                archive.writestr(info, b'never executed')
        return hashlib.sha256(self.zip.read_bytes()).hexdigest(), self.zip.stat().st_size

    def call(self, digest, size):
        module.stage(self.zip, digest, size, self.output, self.root)

    def test_exact_input_is_staged_without_execution_and_cannot_replace_output(self):
        digest, size = self.write()
        self.call(digest, size)
        self.assertEqual({str(p.relative_to(self.output)).replace('\\', '/') for p in self.output.rglob('*') if p.is_file()}, module.NAMES)
        with self.assertRaisesRegex(ValueError, 'immutable'):
            self.call(digest, size)

    def test_hash_or_size_changes_refuse_before_output(self):
        digest, size = self.write()
        for d, s in [('a' * 64, size), (digest, size + 1)]:
            with self.assertRaises(ValueError):
                self.call(d, s)
            self.assertFalse(self.output.exists())

    def test_link_member_refuses_before_output(self):
        digest, size = self.write(lambda i: setattr(i, 'external_attr', (stat.S_IFLNK | 0o777) << 16) if i.filename == 'handoff.json' else None)
        with self.assertRaisesRegex(ValueError, 'Special'):
            self.call(digest, size)
        self.assertFalse(self.output.exists())

    def test_extra_and_duplicate_members_refuse_before_output(self):
        for name in ['../escape', 'handoff.json']:
            self.write()
            with zipfile.ZipFile(self.zip, 'a') as archive:
                archive.writestr(name, b'extra')
            with self.assertRaisesRegex(ValueError, 'nine-file'):
                self.call(hashlib.sha256(self.zip.read_bytes()).hexdigest(), self.zip.stat().st_size)
            self.assertFalse(self.output.exists())

    def test_cli_refuses_user_pc_before_input_inspection(self):
        env = {'PATH': '', 'GITHUB_ACTIONS': 'false'}
        result = subprocess.run([sys.executable, str(SCRIPT), 'never-read'], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('runner required', result.stderr)


if __name__ == '__main__':
    unittest.main()
