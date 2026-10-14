import importlib.util
import os
from pathlib import Path
import platform
import unittest

SPEC = importlib.util.spec_from_file_location("sealed", Path(__file__).with_name("linux-sealed-update-probe.py"))
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


class ProbeTests(unittest.TestCase):
    def environment(self):
        return {"CREATOR_LINUX_SEALED_UPDATE_PROBE": "1", "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
                "GITHUB_REF": "refs/heads/validation/linux-sealed-update-014"}

    def test_each_workflow_admission_field_is_required(self):
        valid = self.environment()
        p.admission(valid, "Linux", "x86_64", 1000)
        for key in valid:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**valid, key: ""}, "Linux", "x86_64", 1000)
        for system, arch, uid in [("Windows", "x86_64", 1000), ("Linux", "aarch64", 1000), ("Linux", "x86_64", 0)]:
            with self.assertRaises(RuntimeError):
                p.admission(valid, system, arch, uid)

    def test_no_loader_injection_or_flatpak(self):
        for key in ["FLATPAK_ID", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({**self.environment(), key: "injected"}, "Linux", "x86_64", 1000)

    def test_privileged_invocation_has_no_mutable_path_shell_or_password_fallback(self):
        self.assertEqual(p.PKEXEC_ARGS, ["/usr/bin/pkexec", "--disable-internal-agent", "/usr/bin/dpkg", "--install", "/proc/self/fd/0"])
        self.assertEqual(p.POLICY.as_posix(), "/etc/polkit-1/rules.d/49-creator-sealed-update-probe.rules")
        source = Path(p.__file__).read_text()
        self.assertNotIn("sudo -S", source)
        self.assertNotIn("shell=True", source)
        for gate in ["actualUserAuthenticationAccepted", "cancellationAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady"]:
            self.assertIn('"' + gate + '": False', source)

    @unittest.skipUnless(platform.system() == "Linux", "Linux kernel seals required")
    def test_real_seals_refuse_writes_shrink_growth_and_preserve_content(self):
        import fcntl
        with p.sealed_package(b"native fixture bytes") as stream:
            self.assertEqual(fcntl.fcntl(stream.fileno(), fcntl.F_GET_SEALS), 15)
            self.assertEqual(stream.read(), b"native fixture bytes")
        self.assertTrue(stream.closed)


if __name__ == "__main__":
    unittest.main()
