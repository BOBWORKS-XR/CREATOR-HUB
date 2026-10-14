"""Pure fixture tests. No native UI, profile, process or application launch."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('flatpak_gui_probe', Path(__file__).with_name('flatpak-gui-probe.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class Fixtures(unittest.TestCase):
    def test_exact_current_pins(self):
        self.assertEqual(p.PINS['runId'], 38624468436)
        self.assertEqual(p.PINS['bundle']['sha256'], '09582f687b5bc0c84f370f122b949a7adf2112910bd64f23287c205ea66fb976')
        self.assertEqual(p.PAIR['pins']['sourceCommit'], '7eb00ad8a61db307c71bb95459ac85b7a957088d')

    def test_duplicate_json_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            p.unique_json('{"a":1,"a":2}')

    def test_zip_exact_member_and_corruption(self):
        body, stream = b'pinned fixture', io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            z.writestr('exact/member', body)
        with zipfile.ZipFile(stream) as z:
            self.assertEqual(p.zip_member(z, 'exact/member', p.record(body)), body)
            for pin in ({'size': 1, 'sha256': p.record(body)['sha256']}, {'size': len(body), 'sha256': '0' * 64}):
                with self.assertRaises(RuntimeError):
                    p.zip_member(z, 'exact/member', pin)

    def test_zip_symlink_refuses(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            entry = zipfile.ZipInfo('link')
            entry.external_attr = 0o120777 << 16
            z.writestr(entry, b'target')
        with zipfile.ZipFile(stream) as z, self.assertRaisesRegex(RuntimeError, 'type'):
            p.zip_member(z, 'link', p.record(b'target'))

    def test_ancestry_binding_and_reused_pid(self):
        processes = {20: {'pid': 20, 'parent': 10, 'start': '4'}, 10: {'pid': 10, 'parent': 1, 'start': '3'}}
        p.descendant(20, processes[10], processes.__getitem__)
        for ancestor in ({'pid': 10, 'start': '99'}, {'pid': 30, 'start': '3'}):
            with self.assertRaises(RuntimeError):
                p.descendant(20, ancestor, processes.__getitem__)

    def test_proc_names_containing_parenthesis(self):
        body = '20 (Hub (test)) S 10 ' + ' '.join(['0'] * 17) + ' 123 0'
        self.assertEqual(p.parse_stat(body, 20), {'pid': 20, 'parent': 10, 'start': '123'})
        with self.assertRaises(RuntimeError):
            p.parse_stat(body.replace(') S ', ') Z '), 20)

    def test_terms_requires_actual_heading_version_and_button(self):
        text = 'Terms of use and risk acknowledgement\nCreator Suite Terms v2026-09-28\nAccept and continue'
        self.assertFalse(p.terms_text(text)['inputAccepted'])
        for fragment in ('Creator Hub', 'Terms of use and risk acknowledgement', 'Accept and continue', ''):
            with self.assertRaises(RuntimeError):
                p.terms_text(fragment)

    def test_actual_captured_ocr_does_not_manufacture_terms_proof(self):
        fixture = p.unique_json(Path(__file__).with_name('flatpak-gui-probe-ocr-38643675124.json').read_bytes())
        self.assertEqual(p.record(fixture['ocrText'].encode()), fixture['ocr'])
        self.assertEqual(fixture['runId'], 38643675124)
        self.assertEqual(fixture['expectedParserOutcome'], 'refuse')
        with self.assertRaisesRegex(RuntimeError, 'Rendered terms not proven by OCR'):
            p.terms_text(fixture['ocrText'])

    def test_environment_drops_injection_auth_and_adds_no_app_permissions(self):
        env = p.child_environment(Path('/owned'))
        self.assertEqual(env['FLATPAK_USER_DIR'], str(Path('/owned') / 'installation'))
        self.assertFalse(any(key in env for key in ('GH_TOKEN', 'GITHUB_TOKEN', 'LD_PRELOAD', 'WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY')))

    def test_admission_refuses_live_pc_flatpak_and_injection(self):
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
               'GITHUB_REPOSITORY': 'BOBWORKS-XR/CREATOR-HUB', 'GITHUB_REPOSITORY_ID': '1364807512',
               'CREATOR_FLATPAK_GUI_PROBE': '1', 'RUNNER_TEMP': str(Path(tempfile.gettempdir()).resolve())}
        p.admission(env, 'linux', 'x86_64')
        for key, value in [('FLATPAK_ID', 'app'), ('LD_PRELOAD', '/injected'), ('WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS', '1'), ('RUNNER_ENVIRONMENT', 'self-hosted')]:
            with self.assertRaises(RuntimeError):
                p.admission({**env, key: value}, 'linux', 'x86_64')

    def test_archive_member_hash_mode_type_missing_and_extra(self):
        names = ['mcp/' + str(n) for n in range(13)] + ['setup/exe', 'routing/exe']
        hashes = {name: hashlib.sha256(name.encode()).hexdigest() for name in names}
        binding = {'files': {name: {'size': len(name), 'mode': 0o644} for name in names}, 'unpackedSize': sum(map(len, names))}
        descriptor = {'modules': {'mcp': {'files': {n: h for n, h in hashes.items() if n.startswith('mcp/')}},
                                  'setup': {'files': {'setup/exe': hashes['setup/exe']}}},
                      'managedRouting': {'files': {'routing/exe': hashes['routing/exe']}}, 'payloadArchive': binding}
        for mutation in ('none', 'hash', 'mode', 'link', 'missing', 'extra'):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.USTAR_FORMAT) as z:
                for name in names[:-1] if mutation == 'missing' else names + (['extra'] if mutation == 'extra' else []):
                    entry = tarfile.TarInfo(name)
                    body = name.encode()
                    entry.size, entry.mode = len(body), 0o644
                    if name == names[0]:
                        if mutation == 'hash':
                            body = b'X' * len(body)
                        if mutation == 'mode':
                            entry.mode = 0o755
                        if mutation == 'link':
                            entry.type, entry.linkname, entry.size = tarfile.SYMTYPE, 'target', 0
                    z.addfile(entry, io.BytesIO(body))
            body = stream.getvalue()
            d = copy.deepcopy(descriptor)
            d['payloadArchive'].update(p.record(body))
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / 'modules.tar.gz'
                file.write_bytes(body)
                if mutation == 'none':
                    self.assertEqual(p.verify_archive(file, d)['members'], 15)
                else:
                    with self.assertRaises(RuntimeError):
                        p.verify_archive(file, d)

    def test_no_force_close_or_runtime_injection_in_probe(self):
        source = Path(p.__file__).read_text()
        self.assertNotIn('.kill(', source)
        self.assertNotIn('.terminate(', source)
        self.assertNotIn('RLIMIT_FSIZE', source)
        self.assertNotIn('preexec_fn', source)
        self.assertIn('x11.check_close(xid)', source)
        self.assertEqual(source.count("subprocess.Popen(['/usr/bin/flatpak', 'run'"), 1)
        self.assertTrue(all(value is False for value in p.FLAGS.values()))

    def test_bounded_logging_truncates_only_retained_output_not_child_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            log = p.BoundedLog(Path(directory) / 'out', 4)
            log.consume(b'hello')
            log.consume(b' world')
            result = log.summary()
            self.assertEqual((Path(directory) / 'out').read_bytes(), b'hell')
            self.assertEqual(result['sourceBytes'], 11)
            self.assertEqual(result['sourceSha256'], hashlib.sha256(b'hello world').hexdigest())
            self.assertTrue(result['truncated'])
            self.assertFalse(result['eof'])
            log.stream.close()

    def test_small_log_limit_does_not_limit_owned_installer_fixture_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = {'commands': []}
            script = "from pathlib import Path; Path('owned-object').write_bytes(b'x'*131072); print('written')"
            result = p.command(root, report, None, 'fixture', [sys.executable, '-B', '-c', script], limit=32)
            self.assertEqual(result, 'written')
            self.assertEqual((root / 'owned-object').stat().st_size, 131072)
            self.assertTrue(all(log['eof'] for log in report['commands'][0]['outputCapture']))

    def test_setup_node_path_is_explicit_not_assumed_system_node(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory).resolve()
            executable = cache / 'node/24.17.0/x64/bin/node'
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b'fixture only, never executed')
            env = {'RUNNER_TOOL_CACHE': str(cache), 'CREATOR_FLATPAK_GUI_NODE': str(executable)}
            self.assertEqual(p.node_executable(env), str(executable))
            for value in ('', '/usr/bin/node', str(cache / 'node/24.16.0/x64/bin/node')):
                with self.assertRaises(RuntimeError):
                    p.node_executable({**env, 'CREATOR_FLATPAK_GUI_NODE': value})
            self.assertNotIn("['/usr/bin/node'", Path(p.__file__).read_text())


if __name__ == '__main__':
    unittest.main()
