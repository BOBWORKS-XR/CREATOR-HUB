"""Pure in-memory DEB member checks. No dpkg, installation or desktop activation."""
import ast
import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("flatpak_helper_package_subject", HERE / "flatpak-native-helper-package.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def archive(rows):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        for name, raw, mode, kind in rows:
            member = tarfile.TarInfo(name)
            member.type, member.mode, member.uid, member.gid = kind, mode, 0, 0
            member.size = len(raw) if kind == tarfile.REGTYPE else 0
            tar.addfile(member, io.BytesIO(raw) if member.size else None)
    output.seek(0)
    return output


def data_rows():
    elf = bytearray(64)
    elf[:7] = b"\x7fELF\x02\x01\x01"
    elf[18:20] = b"\x3e\x00"
    rows = [(name, b"", 0o755, tarfile.DIRTYPE) for name in sorted(p.PARENTS)]
    rows += [(p.SERVICE, p.SERVICE_BYTES, 0o644, tarfile.REGTYPE), ("usr/bin/creator-hub", bytes(elf), 0o755, tarfile.REGTYPE)]
    return rows, hashlib.sha256(elf).hexdigest()


def control_rows(description="Creator Hub native application", version="0.1.14"):
    control = f"Package: creator-hub\nVersion: {version}\nArchitecture: amd64\nDescription: {description}\n".encode()
    return [("control", control, 0o644, tarfile.REGTYPE), ("md5sums", b"fixture\n", 0o644, tarfile.REGTYPE)]


class PackageTests(unittest.TestCase):
    def test_exact_unmodified_shared_strict_member_reader(self):
        self.assertEqual(hashlib.sha256((HERE / "linux-retirement-package-verify.py").read_bytes()).hexdigest(), p.MEMBERS_SHA)

    def test_exact_service_and_signed_expected_root_member(self):
        rows, digest = data_rows()
        result = p.inspect_data(archive(rows), digest)
        self.assertEqual(set(result), {p.SERVICE, "usr/bin/creator-hub"})
        self.assertEqual(result[p.SERVICE]["mode"], 0o644)
        self.assertEqual(result[p.SERVICE]["uid"], 0)

    def test_wrong_root_image_service_bytes_or_file_mode_refuse(self):
        for change in ("elf", "service", "mode", "parent", "missing"):
            rows, digest = data_rows()
            if change == "elf":
                digest = "f"*64
            elif change == "service":
                rows[-2] = (p.SERVICE, p.SERVICE_BYTES + b"User=root\n", 0o644, tarfile.REGTYPE)
            elif change == "mode":
                rows[-2] = (p.SERVICE, p.SERVICE_BYTES, 0o666, tarfile.REGTYPE)
            elif change == "parent":
                rows[0] = (rows[0][0], b"", 0o777, tarfile.DIRTYPE)
            else:
                rows = rows[:-2] + rows[-1:]
            with self.subTest(change=change), self.assertRaises(ValueError):
                p.inspect_data(archive(rows), digest)

    def test_link_duplicate_traversal_foreign_service_and_system_policy_refuse(self):
        for name, kind in ((p.SERVICE, tarfile.SYMTYPE), (p.SERVICE, tarfile.REGTYPE), ("../escape", tarfile.REGTYPE),
                ("usr/share/dbus-1/services/foreign.service", tarfile.REGTYPE), ("etc/dbus-1/foreign.conf", tarfile.REGTYPE)):
            rows, digest = data_rows()
            rows.append((name, b"foreign", 0o644, kind))
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                p.inspect_data(archive(rows), digest)

    def test_exact_control_identity_no_maintainer_scripts(self):
        self.assertEqual(p.inspect_control(archive(control_rows()), "0.1.14")["architecture"], "amd64")
        for name in ("postinst", "prerm", "triggers", "conffiles"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                p.inspect_control(archive(control_rows() + [(name,b"do not execute",0o755,tarfile.REGTYPE)]),"0.1.14")

    def test_test_only_or_other_version_never_installable(self):
        for rows in (control_rows("TEST ONLY - candidate"), control_rows(version="0.1.15")):
            with self.assertRaises(ValueError):
                p.inspect_control(archive(rows), "0.1.14")

    def test_inspector_does_not_authenticate_caller_digest_or_install(self):
        source = (HERE / "flatpak-native-helper-package.py").read_text()
        ast.parse(source)
        self.assertIn('"signatureVerifiedByInspector": False', source)
        self.assertIn('"nativeRootWiringAccepted": False', source)
        self.assertIn('"/usr/bin/dpkg-deb"', source)
        self.assertIn('"--ctrl-tarfile", "--fsys-tarfile"', source)
        for forbidden in ("pkexec", "sudo", '"--install"', "systemctl", "shell=True", "auth.json", "Popen("):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
