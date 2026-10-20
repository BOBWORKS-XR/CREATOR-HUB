import importlib.util
import os
from pathlib import Path
import platform
import unittest
import xml.etree.ElementTree as ET

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
        self.assertEqual(p.POLICY.as_posix(), "/usr/share/polkit-1/actions/org.creatorworks.hub.disposable-sealed-update-probe.policy")
        source = Path(p.__file__).read_text()
        self.assertNotIn("sudo -S", source)
        self.assertNotIn("shell=True", source)
        for gate in ["actualUserAuthenticationAccepted", "cancellationAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady"]:
            self.assertIn('"' + gate + '": False', source)

    def test_ubuntu_2204_policy_uses_documented_action_xml_not_unsupported_js_rules(self):
        action = ET.fromstring(p.policy_xml()).find("action")
        self.assertEqual(action.attrib, {"id": p.ACTION})
        self.assertEqual(action.find("annotate").attrib, {"key": "org.freedesktop.policykit.exec.path"})
        self.assertEqual(action.find("annotate").text, "/usr/bin/dpkg")
        self.assertEqual([n.text for n in action.find("defaults")], ["yes", "yes", "yes"])
        self.assertNotIn("polkit.addRule", p.policy_xml())
        self.assertNotIn("/rules.d/", p.POLICY.as_posix())
        self.assertIn("never install", action.find("message").text.lower())

    def test_0105_pkaction_success_exit_one_needs_exact_complete_action_and_no_error(self):
        stdout = (p.ACTION + ":\n  description:       Disposable sealed package mechanism test\n"
                  "  message:           Disposable runner only; never install this policy on a user PC\n"
                  "  vendor:            Creator Hub disposable test only\n"
                  "  vendor_url:        \n  icon:              \n  implicit any:      yes\n"
                  "  implicit inactive: yes\n  implicit active:   yes\n"
                  "  annotation:        org.freedesktop.policykit.exec.path -> /usr/bin/dpkg\n\n")
        record = {"stdout": stdout, "stderr": "", "exitCode": 1}
        self.assertTrue(p.action_observed(record, "pkexec version 0.105\n"))
        self.assertFalse(p.action_observed(record, "pkexec version 126\n"))
        for changed in [{"stderr": "Error"}, {"stdout": ""}, {"exitCode": 127},
                        {"stdout": stdout.replace("/usr/bin/dpkg", "/bin/sh")},
                        {"stdout": stdout.replace("vendor_url:        \n", "vendor_url:        https://foreign.invalid\n")},
                        {"stdout": stdout.replace("implicit any:      yes", "implicit any:      no")}]:
            with self.subTest(changed=changed):
                self.assertFalse(p.action_observed({**record, **changed}, "pkexec version 0.105\n"))

    @unittest.skipUnless(platform.system() == "Linux", "Linux kernel seals required")
    def test_real_seals_refuse_writes_shrink_growth_and_preserve_content(self):
        import fcntl
        with p.sealed_package(b"native fixture bytes") as stream:
            self.assertEqual(fcntl.fcntl(stream.fileno(), fcntl.F_GET_SEALS), 15)
            self.assertEqual(stream.read(), b"native fixture bytes")
        self.assertTrue(stream.closed)


if __name__ == "__main__":
    unittest.main()
