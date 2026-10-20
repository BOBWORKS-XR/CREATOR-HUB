"""Synthetic archive/delta tests only; no dpkg, installation or native execution."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("private017_package", Path(__file__).with_name("private-linux-update-fixture-017-package-verify.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def elf(label):
    header = bytearray(64)
    header[:7] = b"\x7fELF\x02\x01\x01"
    header[18:20] = b"\x3e\x00"
    return bytes(header) + label


def tar(files, mutate=None):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.GNU_FORMAT) as archive:
        parents = set()
        for name in files:
            parents.update(str(x) for x in Path(name).parents if str(x) != ".")
        for name in sorted(parents):
            member = tarfile.TarInfo(name.replace("\\", "/"))
            member.type = tarfile.DIRTYPE
            member.mode = 0o755
            archive.addfile(member)
        for name, (raw, mode) in files.items():
            member = tarfile.TarInfo(name)
            member.mode, member.size = mode, len(raw)
            if mutate:
                mutate(member)
            archive.addfile(member, io.BytesIO(raw))
    return out.getvalue()


def sample():
    base = p.base_reader()
    policy = (Path(__file__).parent.parent / "packaging/linux/com.creatorworks.hub.deb-retirement.production-016.policy").read_bytes()
    old = {p.ROOT: (elf(b"actual Root16"), 0o755), p.ARCHIVE: (b"original module archive", 0o644),
           base.HELPER: (elf(b"original helper"), 0o755), base.POLICY: (policy, 0o644), base.SERVICE: (base.SERVICE_BYTES, 0o644)}
    new = {**old, p.ROOT: (elf(b"actual compiled Root17"), 0o755), p.ARCHIVE: (b"new archive with runtime17", 0o644)}
    packages = []
    for version, files in (("0.1.16", old), ("0.1.17", new)):
        raw = tar(files)
        base.data(io.BytesIO(raw), p.record(old[base.HELPER][0])["sha256"], p.record(policy)["sha256"], base.PRODUCTION_PROFILE)
        records = p.data(io.BytesIO(raw), base)
        fields = {"Package": "creator-hub", "Version": version, "Architecture": "amd64", "Installed-Size": "8",
                  "Description": base.INTEGRATED_DESCRIPTION, "Depends": "policykit-1, libwebkit2gtk-4.1-0, libgtk-3-0"}
        packages.append({"fields": fields, "files": records, "md5sums": {name: item["md5"] for name, item in records.items() if item["kind"] == "file"}})
    expected = {"baseline": {"deb": p.record(b"synthetic baseline DEB"), "hub": p.record(old[p.ROOT][0]),
                             "helper": p.record(old[base.HELPER][0]), "policy": p.record(policy), "service": p.record(base.SERVICE_BYTES)},
                "candidate": {"deb": p.record(b"synthetic candidate DEB"), "hub": p.record(new[p.ROOT][0]), "archive": p.record(new[p.ARCHIVE][0])}}
    return base, old, new, packages, expected


class PackageTests(unittest.TestCase):
    def test_only_root_archive_and_version_size_delta_are_allowed_and_never_accept_release(self):
        _, _, _, packages, expected = sample()
        report = p.compare(*packages, expected)
        self.assertTrue(report["helperPolicyServicePreserved"])
        for name in ("nativeGuiAccepted", "migrationAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady"):
            self.assertFalse(report[name])

    def test_original016_package_control_guard_stays_strict(self):
        base, _, _, packages, _ = sample()
        for version in ("0.1.16", "0.1.17"):
            fields = {**packages[0]["fields"], "Version": version}
            body = ("\n".join(f"{k}: {v}" for k, v in fields.items()) + "\n").encode()
            raw = tar({"control": (body, 0o644), "md5sums": (b"", 0o644)})
            if version == "0.1.16":
                base.control(io.BytesIO(raw), version, base.PRODUCTION_PROFILE)
            else:
                with self.assertRaisesRegex(ValueError, "exact 016"):
                    base.control(io.BytesIO(raw), version, base.PRODUCTION_PROFILE)

    def test_relabelled_root_and_changed_privileged_or_unrelated_members_refuse(self):
        base, _, _, packages, expected = sample()
        def relabel(changed):
            changed[1]["files"][p.ROOT] = copy.deepcopy(changed[0]["files"][p.ROOT])
            changed[1]["md5sums"][p.ROOT] = changed[0]["md5sums"][p.ROOT]
        for mutate in (relabel, lambda x: x[1]["fields"].update(Version="0.1.16"),
                       lambda x: x[1]["fields"].update(Depends="unreviewed"),
                       lambda x: x[1]["fields"].update(Conflicts="other-app"),
                       lambda x: x[1]["files"][base.POLICY].update(sha256="a" * 64),
                       lambda x: x[1]["files"][base.SERVICE].update(mode=0o777),
                       lambda x: x[1]["files"].update({"extra": x[1]["files"][p.ROOT]}),
                       lambda x: x[1]["md5sums"].update({p.ROOT: "0" * 32})):
            changed = copy.deepcopy(packages)
            mutate(changed)
            pins = copy.deepcopy(expected)
            if changed[1]["files"][p.ROOT] == changed[0]["files"][p.ROOT]:
                pins["candidate"]["hub"] = pins["baseline"]["hub"]
            with self.assertRaises(ValueError):
                p.compare(*changed, pins)

    def test_links_suid_unowned_files_unknown_control_and_checksum_duplicates_refuse(self):
        base, old, _, _, _ = sample()
        for change in (lambda m: setattr(m, "mode", 0o4755), lambda m: setattr(m, "uid", 1000),
                       lambda m: setattr(m, "type", tarfile.SYMTYPE)):
            with self.assertRaises(ValueError):
                p.data(io.BytesIO(tar(old, change)), base)
        for files in ({"postinst": (b"not executed", 0o644)},
                      {"control": (b"Package: creator-hub\n", 0o644), "md5sums": (b"0" * 32 + b"  a\n" + b"0" * 32 + b"  a\n", 0o644)}):
            with self.assertRaises(ValueError):
                p.control(io.BytesIO(tar(files)), base)

    def test_invalid_expectations_refuse_before_dpkg_and_do_not_change_production_source(self):
        _, _, _, _, expected = sample()
        expected["candidate"]["hub"]["size"] = True
        with patch.object(p.sys, "platform", "linux"), patch.object(p.subprocess, "run", side_effect=AssertionError("No child")), self.assertRaises(ValueError):
            p.verify("/never/read", "/never/read", expected)
        self.assertEqual(hashlib.sha256((Path(__file__).parent / "linux-retirement-package-verify.py").read_bytes()).hexdigest(), p.BASE_SHA)

    def test_pinned_baseline_zip_stages_only_four_members_and_refuses_duplicate_or_changed_input(self):
        for wrong in (None, "duplicate", "digest", "traversal"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                members = {key: ("synthetic " + key).encode() for key in p.ZIP_FILES}
                file = root / "baseline.zip"
                with zipfile.ZipFile(file, "w") as archive:
                    for key, (name, _) in p.ZIP_FILES.items():
                        archive.writestr(name, members[key])
                    if wrong == "duplicate":
                        import warnings
                        with warnings.catch_warnings():
                            warnings.simplefilter("ignore", UserWarning)
                            archive.writestr("creator-hub", b"duplicate")
                    if wrong == "traversal":
                        archive.writestr("../outside", b"not extracted")
                expected = {"zip": p.record(file.read_bytes()), "files": {key: p.record(value) for key, value in members.items()}}
                if wrong == "digest":
                    expected["files"]["rawHub"]["sha256"] = "f" * 64
                output = root / "staged"
                if wrong:
                    with self.assertRaises(ValueError):
                        p.stage_zip(file, expected, output)
                    self.assertFalse((root / "outside").exists())
                else:
                    self.assertFalse(p.stage_zip(file, expected, output)["releaseReady"])
                    self.assertEqual({f.name for f in output.iterdir()}, {value[1] for value in p.ZIP_FILES.values()})
                    for key, (_, name) in p.ZIP_FILES.items():
                        self.assertEqual((output / name).read_bytes(), members[key])


if __name__ == "__main__":
    unittest.main(verbosity=2)
