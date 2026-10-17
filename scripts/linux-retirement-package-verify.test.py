import copy
import hashlib
import importlib.util
import io
import pathlib
import tarfile
import unittest
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("retirement_package", ROOT / "scripts/linux-retirement-package-verify.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
POLICY = (ROOT / "packaging/linux/com.creatorworks.hub.deb-retirement.policy").read_bytes()
HELPER = b"\x7fELF\x02\x01" + b"\x00" * 12 + b"\x3e\x00" + b"fixture-not-executed" * 4
sha = lambda value: hashlib.sha256(value).hexdigest()


def archive(rows):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as writer:
        for name, bytes_, kind, mode, uid, gid in rows:
            member = tarfile.TarInfo(name)
            member.type, member.mode, member.uid, member.gid = kind, mode, uid, gid
            member.size = len(bytes_) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = "/tmp/redirect"
            writer.addfile(member, io.BytesIO(bytes_) if member.isfile() else None)
    output.seek(0)
    return output


def rows():
    return [(name, b"", tarfile.DIRTYPE, 0o755, 0, 0) for name in sorted(v.PARENTS)] + [
        (v.HELPER, HELPER, tarfile.REGTYPE, 0o755, 0, 0),
        (v.POLICY, POLICY, tarfile.REGTYPE, 0o644, 0, 0)]


def control(body=None):
    body = body if body is not None else b"Package: creator-hub\nVersion: 0.1.14\nArchitecture: amd64\nDescription: TEST ONLY - fixture\nDepends: policykit-1, libwebkit2gtk-4.1-0, libgtk-3-0\n"
    return [("control", body, tarfile.REGTYPE, 0o644, 0, 0),
            ("md5sums", b"fixture", tarfile.REGTYPE, 0o644, 0, 0)]


class PackageAudit(unittest.TestCase):
    def audit(self, input_rows):
        return v.data(archive(input_rows), sha(HELPER), sha(POLICY))

    def test_exact_root_owned_helper_and_auth_admin_policy(self):
        result = self.audit(rows())
        self.assertEqual(set(result), {"/" + v.HELPER, "/" + v.POLICY})
        self.assertEqual(result["/" + v.HELPER], {"sha256": sha(HELPER), "size": len(HELPER), "mode": 0o755, "uid": 0, "gid": 0})
        self.assertEqual(result["/" + v.POLICY]["mode"], 0o644)
        v.policy(POLICY)

    def test_wrong_uid_gid_special_bits_or_write_modes_refuse(self):
        for target in (v.HELPER, v.POLICY, *v.PARENTS):
            position = [row[0] for row in rows()].index(target)
            for field, value in ((3, 0o777), (3, 0o4755), (4, 1001), (5, 1001)):
                bad = rows()
                modified = list(bad[position])
                modified[field] = value
                bad[position] = tuple(modified)
                with self.subTest(target=target, field=field), self.assertRaises(ValueError):
                    self.audit(bad)

    def test_missing_ancestors_helper_or_policy_are_not_authorized_by_other_files(self):
        for target in (v.HELPER, v.POLICY, *v.PARENTS):
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.audit([row for row in rows() if row[0] != target])

    def test_links_duplicates_traversal_and_special_members_refuse(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            bad = rows()
            bad[-2] = (v.HELPER, b"", kind, 0o755, 0, 0)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.audit(bad)
        for name in ("/tmp/file", "usr/../tmp/file", "usr//file", "usr/./file", v.HELPER):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.audit(rows() + [(name, b"unexpected", tarfile.REGTYPE, 0o644, 0, 0)])
        with self.assertRaises(ValueError):
            self.audit([(".", b"", tarfile.DIRTYPE, 0o777, 0, 0)] + rows())

    def test_other_authorization_files_privileged_helpers_and_system_config_refuse(self):
        for name in ("etc/dpkg/dpkg.cfg", "usr/share/polkit-1/actions/foreign.policy", "usr/libexec/another-helper",
                     "etc/polkit-1/localauthority/50-local.d/yes.pkla", "usr/share/polkit-1/rules.d/yes.rules"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.audit(rows() + [(name, b"unexpected", tarfile.REGTYPE, 0o644, 0, 0)])

    def test_changed_bytes_or_non_native_helper_refuse(self):
        for target in (v.HELPER, v.POLICY):
            bad = [(name, b"changed" if name == target else body, kind, mode, uid, gid)
                   for name, body, kind, mode, uid, gid in rows()]
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.audit(bad)
        bad_helper = b"#!/bin/sh\nnot-a-native-helper"
        bad = [(name, bad_helper if name == v.HELPER else body, kind, mode, uid, gid)
               for name, body, kind, mode, uid, gid in rows()]
        with self.assertRaisesRegex(ValueError, "ELF"):
            v.data(archive(bad), sha(bad_helper), sha(POLICY))

    def test_every_policy_default_requires_admin_without_cached_or_implicit_yes(self):
        root = ET.fromstring(POLICY)
        for original in root.findall("action"):
            for context in ("allow_any", "allow_inactive", "allow_active"):
                for value in ("yes", "auth_self", "auth_admin_keep", "auth_self_keep", "no"):
                    bad = copy.deepcopy(root)
                    action = next(node for node in bad.findall("action") if node.attrib == original.attrib)
                    action.find("defaults/" + context).text = value
                    with self.subTest(context=context, value=value), self.assertRaises(ValueError):
                        v.policy(ET.tostring(bad))

    def test_policy_has_one_exact_helper_path_and_no_unsupported_argv1_or_extra_authority(self):
        for change in ("path", "argument", "extra", "duplicate", "missing"):
            root = ET.fromstring(POLICY)
            first = root.find("action")
            if change == "path":
                first.findall("annotate")[0].text = "/bin/sh"
            elif change == "argument":
                ET.SubElement(first, "annotate", {"key": "org.freedesktop.policykit.exec.argv1"}).text = "retire-mcp-2.7.7"
            elif change == "extra":
                ET.SubElement(first, "annotate", {"key": "org.freedesktop.policykit.exec.allow_gui"}).text = "true"
            elif change == "duplicate":
                root.append(copy.deepcopy(first))
            else:
                root.remove(first)
            with self.subTest(change=change), self.assertRaises(ValueError):
                v.policy(ET.tostring(root))

    def test_control_requires_identity_dependencies_and_no_privileged_maintainer_scripts(self):
        v.control(archive(control()), "0.1.14")
        base = control()[0][1]
        for original, changed in ((b"creator-hub", b"foreign"), (b"amd64", b"arm64"), (b"0.1.14", b"0.1.15"),
                                  (b"TEST ONLY - ", b""), (b"policykit-1, ", b""), (b"libgtk-3-0", b""),
                                  (b"policykit-1", b"policykit-1 | unrelated")):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                v.control(archive(control(base.replace(original, changed))), "0.1.14")
        for name in ("preinst", "postinst", "prerm", "postrm", "conffiles", "triggers"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                v.control(archive(control() + [(name, b"never-run", tarfile.REGTYPE, 0o755, 0, 0)]), "0.1.14")
        with self.assertRaises(ValueError):
            v.control(archive(control(base + b"Version: 0.1.14\n")), "0.1.14")


if __name__ == "__main__":
    unittest.main()
