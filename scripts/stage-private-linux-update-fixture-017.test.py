"""Synthetic data-only staging checks. No signatures, candidate processes or native installs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import warnings
import zipfile
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('stage017', Path(__file__).with_name('stage-private-linux-update-fixture-017.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class StageTests(unittest.TestCase):
    def sample(self, root, fault=''):
        plan = {'hubVersion': '0.1.17', 'platform': 'linux', 'arch': 'x86_64', 'acceptanceOnly': True,
                **{k: False for k in ('nativeGuiAccepted', 'migrationAccepted', 'authenticationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady')}}
        body = json.dumps(plan, indent=2).encode()
        plan_file = root / 'plan.json'
        plan_file.write_bytes(body)
        file = root / 'input.zip'
        with zipfile.ZipFile(file, 'w') as archive:
            for name in sorted(p.NAMES):
                if fault == 'missing' and name == 'derivation017.minisig':
                    continue
                value = body if name == 'plan.json' else ('synthetic ' + name).encode()
                if fault == 'plan' and name == 'plan.json':
                    value += b' '
                member = zipfile.ZipInfo(name)
                if fault == 'link' and name == 'runtime017.json':
                    member.create_system = 3
                    member.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(member, value)
            if fault in ('extra', 'traversal'):
                archive.writestr('unexpected' if fault == 'extra' else '../outside', b'no')
            if fault == 'duplicate':
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    archive.writestr('runtime017.json', b'duplicate')
        raw = file.read_bytes()
        return file, hashlib.sha256(raw).hexdigest(), len(raw), plan_file, hashlib.sha256(body).hexdigest(), root / 'staged', root

    def test_exact017_members_and_independent_plan_stage_as_data_only_and_refuse_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.sample(Path(temp).resolve())
            result = p.stage(*args)
            self.assertFalse(result['signaturesVerified'])
            self.assertFalse(result['releaseReady'])
            output = args[5]
            self.assertEqual({file.relative_to(output).as_posix() for file in output.rglob('*') if file.is_file()}, p.NAMES)
            with self.assertRaises(ValueError):
                p.stage(*args)

    def test_unknown_missing_duplicate_redirected_or_different_plan_members_refuse(self):
        for fault in ('missing', 'extra', 'traversal', 'duplicate', 'link', 'plan'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                args = self.sample(Path(temp).resolve(), fault)
                with self.assertRaises(ValueError):
                    p.stage(*args)
                self.assertFalse(args[5].exists())
                self.assertFalse((args[6].parent / 'outside').exists())

    def test_byte_pins_bounds_and_hardlinks_refuse_before_output(self):
        for fault in ('hash', 'plan-hash', 'size', 'hardlink'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                args = list(self.sample(Path(temp).resolve()))
                if fault == 'hash':
                    args[1] = 'a' * 64
                if fault == 'plan-hash':
                    args[4] = 'a' * 64
                if fault == 'size':
                    args[2] = p.MAX_ZIP + 1
                if fault == 'hardlink':
                    import os
                    os.link(args[0], args[6] / 'linked.zip')
                with self.assertRaises(ValueError):
                    p.stage(*args)
                self.assertFalse(args[5].exists())

    def test_named_and_fd_ctime_are_separately_stable_not_assumed_to_have_same_windows_meaning(self):
        from types import SimpleNamespace
        values = dict(st_dev=1, st_ino=2, st_size=3, st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_mtime_ns=4)
        named = SimpleNamespace(**values, st_ctime_ns=5)
        opened = SimpleNamespace(**values, st_ctime_ns=6)
        self.assertEqual(p.opened_identity(named), p.opened_identity(opened))
        self.assertNotEqual(p.identity(named), p.identity(opened))
        opened.st_ctime_ns += 1
        self.assertNotEqual(p.identity(opened)[-1], 6, 'Each full FD identity still includes ctime for post-read checks')

    def test_windows_baseline_stager_retains_exact_four_pins_and_refuses_wrong_digest_or_unknown_paths(self):
        for fault in ('', 'digest', 'traversal'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                source = root / 'baseline.zip'
                members = {key: ('synthetic ' + key).encode() for key in p.BASELINE}
                with zipfile.ZipFile(source, 'w') as archive:
                    for key, (name, _) in p.BASELINE.items():
                        archive.writestr(name, members[key])
                    if fault == 'traversal':
                        archive.writestr('../outside', b'no')
                pin = lambda raw: {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                expected = {'zip': pin(source.read_bytes()), 'files': {key: pin(raw) for key, raw in members.items()}}
                if fault == 'digest':
                    expected['files']['rawHub']['sha256'] = 'a' * 64
                with patch.object(p.sys, 'platform', 'win32'):
                    if fault:
                        with self.assertRaises(ValueError):
                            p.stage_baseline(source, expected, root / 'staged')
                    else:
                        self.assertFalse(p.stage_baseline(source, expected, root / 'staged')['releaseReady'])
                        self.assertEqual({file.name for file in (root / 'staged').iterdir()}, {value[1] for value in p.BASELINE.values()})


if __name__ == '__main__':
    unittest.main(verbosity=2)
