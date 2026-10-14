"""Portable, passive preflight only. No dpkg, downloads, or native execution."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
import sys

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("linux-deb-retention-probe.py")
spec = importlib.util.spec_from_file_location("deb_retention", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
ENV = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
    "RUNNER_ARCH": "X64", "GITHUB_REPOSITORY": probe.REPO, "GITHUB_REPOSITORY_ID": "1364807512",
    "GITHUB_REF": probe.BRANCH, "CREATOR_LINUX_DEB_RETENTION": "1", "GITHUB_EVENT_NAME": "push"}


def archive(entries):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w") as target:
        for name, kind, mode in entries:
            info = tarfile.TarInfo(name)
            info.type, info.mode = kind, mode
            data = b"unchanged runtime\n"
            if kind == tarfile.REGTYPE:
                info.size = len(data)
                target.addfile(info, io.BytesIO(data))
            else:
                info.linkname = "elsewhere"
                target.addfile(info)
    result.seek(0)
    return result


class Preflight(unittest.TestCase):
    def test_parse_all_owned_python(self):
        for p in (SCRIPT, Path(__file__)):
            ast.parse(p.read_text())

    def test_disposable_guard_rejects_every_missing_or_changed_field(self):
        probe.admission(ENV, "Linux", "x86_64")
        for key in ENV:
            for replacement in (None, "wrong"):
                env = copy.copy(ENV)
                if replacement is None:
                    env.pop(key)
                else:
                    env[key] = replacement
                with self.assertRaises(RuntimeError, msg=key):
                    probe.admission(env, "Linux", "x86_64")
        for system, machine in (("Windows", "AMD64"), ("Darwin", "x86_64"), ("Linux", "aarch64")):
            with self.assertRaises(RuntimeError):
                probe.admission(ENV, system, machine)
        for key in ("FLATPAK_ID", "APPIMAGE", "APPDIR"):
            with self.assertRaises(RuntimeError):
                probe.admission({**ENV, key: "active"}, "Linux", "x86_64")

    def test_real_pins_and_original9_contract(self):
        pins = json.loads((SCRIPT.parents[1] / "docs/evidence/legacy-unix-public-package-pins-014.json").read_text())
        p = next(p for p in pins["packages"] if p["asset"] == probe.ASSET)
        self.assertEqual(p["packageSha256"], probe.PACKAGE_SHA)
        self.assertEqual(p["packageBytes"], probe.PACKAGE_BYTES)
        self.assertEqual(len(probe.RUNTIME), 9)
        self.assertEqual(len(probe.RETIRED), 5)
        self.assertFalse(probe.RUNTIME & probe.RETIRED)
        self.assertEqual({m["member"] for m in p["members"] if m["member"].startswith(probe.SERVER)}, probe.RUNTIME)
        self.assertEqual({m["member"] for m in p["control"]}, {"control", "md5sums"})
        self.assertTrue(all(v is False for v in probe.FALSE_GATES.values()))

    def test_control_and_md5_use_explicit_record_boundaries(self):
        self.assertEqual(probe.control_fields(b"Package: example\nVersion: 1\nDescription: short\n long\n")["Description"], "short\n long")
        for data in (b"Package: one\nPackage: two\n", b"Package: one\n\nPackage: two\n"):
            with self.assertRaises(RuntimeError):
                probe.control_fields(data)
        name = probe.SERVER + "runtime/node.exe"
        sums = f"{'a' * 32}  {name}\n".encode()
        self.assertEqual(probe.md5_entries(sums), {name: "a" * 32})
        with self.assertRaises(RuntimeError):
            probe.md5_entries(sums + sums)

    def test_streamed_payload_includes_both_aliases_and_rejects_extra_missing_links(self):
        entries = [(name, tarfile.REGTYPE, 0o755 if "/runtime/node" in name else 0o644) for name in sorted(probe.RUNTIME)]
        result = probe.payload(archive(entries), probe.RUNTIME)
        self.assertEqual(set(result), probe.RUNTIME)
        self.assertEqual(result[probe.SERVER + "runtime/node.exe"]["sha256"], hashlib.sha256(b"unchanged runtime\n").hexdigest())
        cases = [entries[:-1], entries + entries[:1], entries + [("usr/bin/extra", tarfile.REGTYPE, 0o755)],
                 [("../escape", tarfile.REGTYPE, 0o644)] + entries,
                 [("/absolute", tarfile.REGTYPE, 0o644)] + entries]
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            cases.append([(entries[0][0], kind, 0o644)] + entries[1:])
        cases.append([(entries[0][0], tarfile.REGTYPE, 0o4755)] + entries[1:])
        for entries in cases:
            with self.assertRaises(RuntimeError):
                probe.payload(archive(entries), probe.RUNTIME)


if __name__ == "__main__":
    unittest.main()
