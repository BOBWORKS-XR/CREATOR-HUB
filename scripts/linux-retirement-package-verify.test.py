import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import tarfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("retirement_package", ROOT / "scripts/linux-retirement-package-verify.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
POLICY = (ROOT / "packaging/linux/com.creatorworks.hub.deb-retirement.policy").read_bytes()
PRODUCTION_POLICY = (ROOT / "packaging/linux/com.creatorworks.hub.deb-retirement.production-016.policy").read_bytes()
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


def integrated_rows():
    return rows() + [(name, b"", tarfile.DIRTYPE, 0o755, 0, 0) for name in sorted(v.SERVICE_PARENTS)] + [
        (v.SERVICE, v.SERVICE_BYTES, tarfile.REGTYPE, 0o644, 0, 0)]


def integrated_control(description=None):
    text = v.INTEGRATED_DESCRIPTION if description is None else description
    return control(("Package: creator-hub\nVersion: 0.1.14\nArchitecture: amd64\nDescription: " + text
                    + "\nDepends: policykit-1, libwebkit2gtk-4.1-0, libgtk-3-0\n").encode())


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

    def test_integrated_description_matches_the_actual_template_exactly_without_changing_old_profile(self):
        recipe = json.loads((ROOT / "packaging/linux/tauri-integrated-candidate.json").read_text())
        self.assertEqual(v.INTEGRATED_DESCRIPTION, recipe["bundle"]["shortDescription"] + "\n " + recipe["bundle"]["longDescription"])
        v.control(archive(integrated_control()), "0.1.14", v.INTEGRATED_PROFILE)
        v.control(archive(control()), "0.1.14")
        for text in ("Foreign Hub", "TEST ONLY - fixture", v.INTEGRATED_DESCRIPTION + " ",
                     v.INTEGRATED_DESCRIPTION.replace("Creator Hub", "Creator Hub TEST ONLY")):
            with self.subTest(description=text), self.assertRaises(ValueError):
                v.control(archive(integrated_control(text)), "0.1.14", v.INTEGRATED_PROFILE)
        with self.assertRaises(ValueError):
            v.control(archive(control()), "0.1.14", v.INTEGRATED_PROFILE)
        with self.assertRaises(ValueError):
            v.control(archive(integrated_control()), "0.1.14")
        for old, new in ((b"creator-hub", b"foreign"), (b"amd64", b"arm64"), (b"0.1.14", b"0.1.15"),
                         (b"policykit-1, ", b""), (b"libgtk-3-0", b"")):
            bad = integrated_control()[0][1].replace(old, new)
            with self.subTest(change=new), self.assertRaises(ValueError):
                v.control(archive(control(bad)), "0.1.14", v.INTEGRATED_PROFILE)

    def test_integrated_control_never_admits_scripts_triggers_or_transaction_overrides(self):
        for name in ("preinst", "postinst", "prerm", "postrm", "conffiles", "triggers"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                v.control(archive(integrated_control() + [(name, b"never executed", tarfile.REGTYPE, 0o755, 0, 0)]),
                          "0.1.14", v.INTEGRATED_PROFILE)
        for key in ("Pre-Depends", "Conflicts", "Breaks", "Replaces", "Conffiles", "Version"):
            bad = integrated_control()[0][1] + f"{key}: foreign\n".encode()
            with self.subTest(key=key), self.assertRaises(ValueError):
                v.control(archive(control(bad)), "0.1.14", v.INTEGRATED_PROFILE)

    def test_integrated_data_requires_exact_service_in_addition_to_unchanged_helper_policy_checks(self):
        result = v.data(archive(integrated_rows()), sha(HELPER), sha(POLICY), v.INTEGRATED_PROFILE)
        self.assertEqual(set(result), {"/" + name for name in (v.HELPER, v.POLICY, v.SERVICE)})
        self.assertEqual(v.SERVICE_BYTES, (ROOT / "native/flatpak-native-activation/com.creatorworks.hub.Host.service").read_bytes())
        self.assertEqual(result["/" + v.SERVICE], {"sha256": sha(v.SERVICE_BYTES), "size": len(v.SERVICE_BYTES), "mode": 0o644, "uid": 0, "gid": 0})
        for target in (v.HELPER, v.POLICY, v.SERVICE, *v.SERVICE_PARENTS):
            with self.subTest(missing=target), self.assertRaises(ValueError):
                v.data(archive([row for row in integrated_rows() if row[0] != target]), sha(HELPER), sha(POLICY), v.INTEGRATED_PROFILE)
            for field, value in ((3, 0o777), (4, 1001), (5, 1001)):
                modified = integrated_rows()
                position = [row[0] for row in modified].index(target)
                changed = list(modified[position]); changed[field] = value; modified[position] = tuple(changed)
                with self.subTest(target=target, field=field), self.assertRaises(ValueError):
                    v.data(archive(modified), sha(HELPER), sha(POLICY), v.INTEGRATED_PROFILE)
        for target in (v.HELPER, v.POLICY, v.SERVICE):
            modified = [(name, b"changed" if name == target else body, kind, mode, uid, gid)
                        for name, body, kind, mode, uid, gid in integrated_rows()]
            with self.subTest(bytes=target), self.assertRaises(ValueError):
                v.data(archive(modified), sha(HELPER), sha(POLICY), v.INTEGRATED_PROFILE)
        for name in ("usr/share/dbus-1/services/foreign.service", "usr/share/dbus-1/system.d/foreign.conf",
                     "usr/share/polkit-1/actions/foreign.policy", "usr/libexec/foreign", "etc/dbus-1/foreign.conf"):
            with self.subTest(extra=name), self.assertRaises(ValueError):
                v.data(archive(integrated_rows() + [(name, b"foreign", tarfile.REGTYPE, 0o644, 0, 0)]),
                       sha(HELPER), sha(POLICY), v.INTEGRATED_PROFILE)

    def test_explicit_profile_reaches_both_control_and_data_without_changing_default_result_shape(self):
        for profile, input_control, input_data in ((v.DEFAULT_PROFILE, control(), rows()),
                                                   (v.INTEGRATED_PROFILE, integrated_control(), integrated_rows())):
            def query(command, **kwargs):
                self.assertEqual(command[0], "/usr/bin/dpkg-deb")
                self.assertIn(command[1], ("--ctrl-tarfile", "--fsys-tarfile"))
                kwargs["stdout"].write(archive(input_control if command[1] == "--ctrl-tarfile" else input_data).read())
                return subprocess.CompletedProcess(command, 0, stderr=b"")
            with mock.patch.object(v.subprocess, "run", side_effect=query) as called:
                result = v.verify("not-installed.deb", sha(HELPER), sha(POLICY), "0.1.14", profile)
            self.assertEqual(called.call_count, 2)
            self.assertEqual(set(result), {"files", "profile"} if profile == v.INTEGRATED_PROFILE else {"files"})
            if profile == v.INTEGRATED_PROFILE:
                self.assertEqual(result["profile"], profile)
        with mock.patch.object(v.subprocess, "run") as called:
            with self.assertRaises(ValueError):
                v.verify("not-installed.deb", sha(HELPER), sha(POLICY), "0.1.14", "foreign")
            called.assert_not_called()

    def test_combined_profile_is_compatible_with_production_activation_inspection_but_old_candidate_is_not(self):
        spec = importlib.util.spec_from_file_location("activation_package", ROOT / "scripts/flatpak-native-helper-package.py")
        activation = importlib.util.module_from_spec(spec); spec.loader.exec_module(activation)
        activation.inspect_control(archive(integrated_control()), "0.1.14")
        with self.assertRaises(ValueError):
            activation.inspect_control(archive(control()), "0.1.14")
        image = bytearray(64); image[:7] = b"\x7fELF\x02\x01\x01"; image[18:20] = b"\x3e\x00"
        combined = integrated_rows() + [("usr/bin/creator-hub", bytes(image), tarfile.REGTYPE, 0o755, 0, 0)]
        self.assertEqual(len(v.data(archive(combined), sha(HELPER), sha(POLICY), v.INTEGRATED_PROFILE)), 3)
        self.assertEqual(set(activation.inspect_data(archive(combined), sha(image))), {v.SERVICE, "usr/bin/creator-hub"})


class ProductionAudit(unittest.TestCase):
    def production_rows(self):
        return [(name, PRODUCTION_POLICY if name == v.POLICY else body, kind, mode, uid, gid)
                for name, body, kind, mode, uid, gid in integrated_rows()]

    def production_control(self):
        return control(integrated_control()[0][1].replace(b"0.1.14", b"0.1.16"))

    def audit(self, data):
        return v.data(archive(data), sha(HELPER), sha(PRODUCTION_POLICY), v.PRODUCTION_PROFILE)

    def test_exact_production_policy_and_service_do_not_admit_development_relabelling(self):
        v.policy(PRODUCTION_POLICY, v.PRODUCTION_PROFILE)
        self.assertEqual(len(self.audit(self.production_rows())), 3)
        v.control(archive(self.production_control()), "0.1.16", v.PRODUCTION_PROFILE)
        for body, profile in ((POLICY, v.PRODUCTION_PROFILE), (PRODUCTION_POLICY, v.DEFAULT_PROFILE),
                              (PRODUCTION_POLICY, v.INTEGRATED_PROFILE)):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                v.policy(body, profile)
        with self.assertRaises(ValueError):
            v.data(archive(integrated_rows()), sha(HELPER), sha(POLICY), v.PRODUCTION_PROFILE)
        with self.assertRaises(ValueError):
            v.control(archive(integrated_control()), "0.1.14", v.PRODUCTION_PROFILE)
        recipe = json.loads((ROOT / "packaging/linux/tauri-production-migration-016.json").read_text())
        self.assertEqual(recipe["build"]["features"], ["linux-production-migration", "integrated-features", "experimental-flatpak-host"])
        self.assertEqual(v.INTEGRATED_DESCRIPTION, recipe["bundle"]["shortDescription"] + "\n " + recipe["bundle"]["longDescription"])

    def test_production_consent_cannot_be_generalized_or_grant_cached_or_extra_authority(self):
        for tag, value in (("vendor", "other"), ("action/description", "TEST ONLY"), ("action/message", "Approve anything"),
                           ("action/defaults/allow_active", "auth_admin_keep"), ("action/defaults/allow_any", "yes"),
                           ("action/defaults/allow_inactive", "auth_self"), ("action/annotate", "/bin/sh")):
            root = ET.fromstring(PRODUCTION_POLICY); root.find(tag).text = value
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                v.policy(ET.tostring(root), v.PRODUCTION_PROFILE)
        for kind in ("annotation", "second-action", "nested-consent"):
            root = ET.fromstring(PRODUCTION_POLICY); action = root.find("action")
            if kind == "annotation":
                ET.SubElement(action, "annotate", {"key": "org.freedesktop.policykit.exec.argv1"}).text = "retire-mcp-2.7.7"
            elif kind == "second-action":
                root.append(copy.deepcopy(action))
            else:
                ET.SubElement(action.find("message"), "nested").text = "extra"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                v.policy(ET.tostring(root), v.PRODUCTION_PROFILE)

    def test_production_keeps_exact_ownership_and_forbids_other_helpers_policies_or_maintainer_scripts(self):
        rows_ = self.production_rows()
        for target in (v.HELPER, v.POLICY, v.SERVICE, *v.PARENTS, *v.SERVICE_PARENTS):
            with self.subTest(missing=target), self.assertRaises(ValueError):
                self.audit([row for row in rows_ if row[0] != target])
            for field, value in ((3, 0o777), (3, 0o4755), (4, 1001), (5, 1001)):
                modified = list(rows_); index = [row[0] for row in modified].index(target)
                changed = list(modified[index]); changed[field] = value; modified[index] = tuple(changed)
                with self.subTest(target=target, field=field), self.assertRaises(ValueError):
                    self.audit(modified)
        for name in ("usr/libexec/other-helper", "usr/share/polkit-1/actions/other.policy", "etc/polkit-1/override",
                     "usr/share/dbus-1/services/foreign.service"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.audit(rows_ + [(name, b"extra", tarfile.REGTYPE, 0o644, 0, 0)])
        for name in ("preinst", "postinst", "prerm", "postrm", "conffiles", "triggers"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                v.control(archive(self.production_control() + [(name, b"never executed", tarfile.REGTYPE, 0o755, 0, 0)]),
                          "0.1.16", v.PRODUCTION_PROFILE)

    def test_production_verify_requires016_before_queries_and_returns_explicit_profile(self):
        with mock.patch.object(v.subprocess, "run") as called:
            with self.assertRaises(ValueError):
                v.verify("never-opened.deb", sha(HELPER), sha(PRODUCTION_POLICY), "0.1.14", v.PRODUCTION_PROFILE)
            called.assert_not_called()

        def query(command, **kwargs):
            kwargs["stdout"].write(archive(self.production_control() if command[1] == "--ctrl-tarfile" else self.production_rows()).read())
            return subprocess.CompletedProcess(command, 0, stderr=b"")

        with mock.patch.object(v.subprocess, "run", side_effect=query) as called:
            report = v.verify("not-installed.deb", sha(HELPER), sha(PRODUCTION_POLICY), "0.1.16", v.PRODUCTION_PROFILE)
        self.assertEqual(called.call_count, 2)
        self.assertEqual(report["profile"], v.PRODUCTION_PROFILE)
        self.assertEqual(set(report), {"files", "profile"})


if __name__ == "__main__":
    unittest.main()
