import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("helper_fixtures", Path(__file__).with_name("linux-deb-helper-fixtures-probe.py"))
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


class FixtureProbeTests(unittest.TestCase):
    def test_admission_requires_every_exact_field_and_unprivileged_native_host(self):
        env = dict(p.EXPECTED)
        p.admission(env, "Linux", "x86_64", 1000)
        for key in env:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**env, key: ""}, "Linux", "x86_64", 1000)
        for system, arch, uid in [("Windows", "x86_64", 1000), ("Linux", "aarch64", 1000), ("Linux", "x86_64", 0), ("Linux", "x86_64", -1)]:
            with self.assertRaises(RuntimeError):
                p.admission(env, system, arch, uid)
        for key in ("FLATPAK_ID", "APPIMAGE", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**env, key: "injected"}, "Linux", "x86_64", 1000)

    def test_all_production_gates_start_and_stay_false(self):
        report = p.initial_report("a" * 40)
        self.assertFalse(report["fixtureChecksPassed"])
        self.assertGreaterEqual(len(report["productionGates"]), 10)
        self.assertTrue(all(value is False for value in report["productionGates"].values()))
        report["fixtureChecksPassed"] = True
        self.assertTrue(all(value is False for value in report["productionGates"].values()))

    def test_capture_preserves_original_bytes_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            report = p.initial_report("a" * 40)

            def failure(argv, **kwargs):
                kwargs["stdout"].write(b"original\r\nstdout\x00")
                kwargs["stderr"].write(b"original failure\n")
                return subprocess.CompletedProcess(argv, 7)

            with mock.patch.object(p.subprocess, "run", side_effect=failure), self.assertRaises(RuntimeError):
                p.capture(root, report, "fixture", ["not-executed"])
            self.assertEqual(report["commands"][0]["exitCode"], 7)
            self.assertEqual((root / "fixture.stdout").read_bytes(), b"original\r\nstdout\x00")
            self.assertEqual((root / "fixture.stderr").read_bytes(), b"original failure\n")
            self.assertFalse(report["fixtureChecksPassed"])

    def test_syntax_and_pure_preflight_precede_all_version_or_native_commands(self):
        report = p.initial_report("a" * 40)
        labels = []

        def stop(root, report, label, argv):
            labels.append(label)
            if label == "pure-preflight":
                raise RuntimeError("stop before any tools or native fixtures")

        with mock.patch.object(p, "capture", side_effect=stop), self.assertRaises(RuntimeError):
            p.run(Path("not-created"), report)
        self.assertEqual(labels, ["syntax-shell", "syntax-node", "pure-preflight"])


if __name__ == "__main__":
    unittest.main()
