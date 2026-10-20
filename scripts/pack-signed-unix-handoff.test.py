import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("pack_handoff", Path(__file__).with_name("pack-signed-unix-handoff.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "signed"
        self.source.mkdir()
        (self.source / "routing").mkdir()
        for name in module.contract.NAMES:
            (self.source / name).write_bytes(("synthetic " + name).encode("ascii"))
        self.output = self.root / "canonical.zip"

    def test_exact_names_and_original_bytes_survive_windows_and_unix(self):
        result = module.pack(self.source, self.output)
        self.assertTrue(result["containerLayoutVerified"])
        self.assertTrue(result["fileBytesPreserved"])
        self.assertFalse(result["releaseReady"])
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual({i.orig_filename for i in archive.infolist()}, module.contract.NAMES)
            for item in module.zip_members(archive):
                self.assertEqual(archive.read(item), (self.source / item.orig_filename).read_bytes())

    def test_observed_compress_archive_backslash_wrapper_refuses_on_windows_too(self):
        with zipfile.ZipFile(self.output, "x") as archive:
            for name in module.contract.NAMES:
                info = zipfile.ZipInfo(name)
                info.filename = info.orig_filename = name.replace("/", "\\")
                archive.writestr(info, b"fixture")
        with zipfile.ZipFile(self.output) as archive:
            with self.assertRaisesRegex(ValueError, "POSIX wire"):
                module.zip_members(archive)

    def test_missing_extra_and_duplicate_entries_refuse(self):
        for extra in ("other.txt", "handoff.json"):
            file = self.root / (extra.replace(".", "-") + ".zip")
            with zipfile.ZipFile(file, "x") as archive:
                for name in module.contract.NAMES:
                    archive.writestr(name, b"fixture")
                archive.writestr(extra, b"extra")
            with zipfile.ZipFile(file) as archive:
                with self.assertRaisesRegex(ValueError, "POSIX wire"):
                    module.zip_members(archive)
        (self.source / "handoff.minisig").unlink()
        with self.assertRaisesRegex(ValueError, "nine-file source"):
            module.pack(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_existing_output_and_unlisted_source_are_preserved(self):
        self.output.write_bytes(b"preserve original evidence")
        with self.assertRaisesRegex(ValueError, "New output"):
            module.pack(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"preserve original evidence")
        extra = self.source / "unexpected.txt"
        extra.write_bytes(b"preserve")
        with self.assertRaisesRegex(ValueError, "Unexpected source file"):
            module.pack(self.source, self.root / "new.zip")
        self.assertEqual(extra.read_bytes(), b"preserve")

    def test_native_staging_precedes_dependencies_and_compilation(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/unix-managed-assembly.yml").read_text(encoding="utf8")
        stage = workflow.index("- name: Stage exactly nine bounded files")
        self.assertLess(workflow.index("python3 -B scripts/pack-signed-unix-handoff.test.py"), stage)
        for later in ("- uses: actions/setup-node", "- uses: dtolnay/rust-toolchain", "- run: npm ci", "cargo test --release"):
            self.assertLess(stage, workflow.index(later))


if __name__ == "__main__":
    unittest.main()
