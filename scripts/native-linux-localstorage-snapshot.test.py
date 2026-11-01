"""Disposable Linux tests for the source-sealed held SQLite reader."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("native-linux-localstorage-snapshot.py")
spec = importlib.util.spec_from_file_location("localstorage_snapshot", SCRIPT)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class CanonicalDigestTests(unittest.TestCase):
    def test_persistent_metadata_is_bound(self):
        database = sqlite3.connect(":memory:")
        try:
            database.execute(module.TABLE)
            database.execute("INSERT INTO ItemTable VALUES (?,?)", ("one", b"value"))
            original = module.digest(database)
            database.execute("PRAGMA user_version=1")
            self.assertNotEqual(original, module.digest(database))
            database.execute("PRAGMA user_version=0")
            database.execute("PRAGMA application_id=1234")
            self.assertNotEqual(original, module.digest(database))
        finally: database.close()

    def test_unknown_schema_or_row_type_is_refused(self):
        database = sqlite3.connect(":memory:")
        try:
            database.execute(module.TABLE)
            database.execute("INSERT INTO ItemTable VALUES (?,?)", ("one", "not-a-blob"))
            with self.assertRaisesRegex(RuntimeError, "Unknown localStorage value type"): module.digest(database)
            database.execute("DELETE FROM ItemTable")
            database.execute("CREATE TABLE unknown (data BLOB)")
            with self.assertRaisesRegex(RuntimeError, "Unknown localStorage schema"): module.digest(database)
        finally: database.close()


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux-only fixture")
class HeldReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="held-reader-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.uid = os.getuid()
        self.db = self.root / "tauri_localhost_0.localstorage"
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute(module.TABLE)
        con.executemany("INSERT INTO ItemTable VALUES (?,?)", [("one", b"original"), ("two", b"\x00\xff")])
        con.commit(); con.close(); os.chmod(self.db, 0o600)

    def identities(self):
        return [(p.stat().st_dev, p.stat().st_ino) for p in (self.db, Path(str(self.db) + "-wal"))]

    def test_digest_and_descriptor_binding(self):
        with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
            identities = self.identities(); reader.require_open_files(identities)
            first = reader.capture(); reader.require_open_files(identities)
            self.assertEqual(len(first), 64)
        self.assertIsNone(reader.process)

    def test_scratch_recovers_committed_wal_and_matches_live(self):
        writer = sqlite3.connect(self.db)
        try:
            writer.execute("UPDATE ItemTable SET value=? WHERE key='one'", (b"wal-value",)); writer.commit()
            wal = Path(str(self.db) + "-wal")
            self.assertGreater(wal.stat().st_size, 0)
            with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
                value = reader.capture()
                expected = sqlite3.connect(":memory:")
                try:
                    writer.backup(expected)
                    self.assertEqual(value, module.digest(expected))
                finally: expected.close()
        finally: writer.close()

    def test_missing_shm_is_reconstructed_without_changing_main_or_wal(self):
        writer = "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE ItemTable SET value=? WHERE key='one'\", (b'wal-only',)); c.commit(); os._exit(0)"
        subprocess.run([sys.executable, "-I", "-S", "-c", writer, str(self.db)], check=True, timeout=10)
        wal = Path(str(self.db) + "-wal"); shm = Path(str(self.db) + "-shm")
        self.assertGreater(wal.stat().st_size, 0)
        main_before = module.stable_file(self.db, self.uid); wal_before = module.stable_file(wal, self.uid)
        shm.unlink()
        with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
            actual = reader.capture()
            expected = sqlite3.connect(":memory:")
            try:
                expected.execute(module.TABLE)
                expected.executemany("INSERT INTO ItemTable VALUES (?,?)", [("one", b"wal-only"), ("two", b"\x00\xff")])
                self.assertEqual(actual, module.digest(expected))
            finally: expected.close()
        self.assertEqual(module.stable_file(self.db, self.uid), main_before)
        self.assertEqual(module.stable_file(wal, self.uid), wal_before)

    def test_scratch_rejects_different_logical_snapshot(self):
        with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
            reader.capture()
            with self.assertRaisesRegex(RuntimeError, "Independent SQLite snapshot differs"):
                module.independent_digest(None, self.db, self.uid, "0" * 64)

    def test_scratch_rejects_same_bytes_wal_replacement(self):
        with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
            expected = reader.capture()
            stable = module.stable_file
            replaced = []
            def replace_after_read(path, uid):
                result = stable(path, uid)
                if path.name.endswith("-wal") and not replaced:
                    replacement = self.root / "replacement-wal"
                    replacement.write_bytes(result[1]); os.chmod(replacement, 0o600)
                    os.replace(replacement, path); replaced.append(True)
                return result
            with patch.object(module, "stable_file", side_effect=replace_after_read):
                with self.assertRaisesRegex(RuntimeError, "SQLite source changed during independent snapshot"):
                    module.independent_digest(None, self.db, self.uid, expected)
            self.assertEqual(replaced, [True])

    def test_missing_or_replaced_wal_descriptor_refuses_and_reaps(self):
        with self.assertRaisesRegex(RuntimeError, "descriptor differs"):
            with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
                identities = self.identities(); reader.require_open_files(identities)
                wal = Path(str(self.db) + "-wal")
                replacement = self.root / "replacement"; replacement.write_bytes(wal.read_bytes())
                os.replace(replacement, wal)
                reader.require_open_files(self.identities())
        self.assertIsNone(reader.process)

    def test_concurrent_commit_changes_wal_while_reader_is_held(self):
        with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
            wal = Path(str(self.db) + "-wal")
            before = wal.read_bytes(); first = reader.capture()
            writer = sqlite3.connect(self.db, timeout=1)
            try:
                writer.execute("UPDATE ItemTable SET value=? WHERE key='one'", (b"changed",)); writer.commit()
                self.assertNotEqual(before, wal.read_bytes())
            finally: writer.close()
            self.assertEqual(len(first), 64)

    def test_helper_timeout_is_bounded_and_reaped(self):
        slow = self.root / "slow.py"; slow.write_text("import time; time.sleep(30)\n")
        reader = module.HeldReader(self.db, self.uid, slow, timeout=0.2)
        with self.assertRaisesRegex(RuntimeError, "helper deadline"):
            with reader: pass
        self.assertIsNone(reader.process)

    def test_unknown_schema_refused(self):
        con = sqlite3.connect(self.db); con.execute("CREATE TABLE unfamiliar (value TEXT)"); con.commit(); con.close()
        reader = module.HeldReader(self.db, self.uid, SCRIPT)
        with self.assertRaises(RuntimeError):
            with reader: reader.capture()
        self.assertIsNone(reader.process)

    def test_sqlite_lock_failure_refuses_and_reaps(self):
        lock = sqlite3.connect(self.db, timeout=1)
        lock.execute("PRAGMA locking_mode=EXCLUSIVE")
        lock.execute("BEGIN EXCLUSIVE")
        reader = module.HeldReader(self.db, self.uid, SCRIPT, timeout=3)
        try:
            with self.assertRaises(RuntimeError):
                with reader: reader.capture()
            self.assertIsNone(reader.process)
        finally:
            lock.rollback(); lock.close()


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root runner")
class RootToSyntheticUidTests(unittest.TestCase):
    def test_root_reader_drops_uid_gid_and_reaps(self):
        uid = 21314
        with tempfile.TemporaryDirectory(prefix="root-held-reader-") as temporary:
            root = Path(temporary).resolve(); os.chmod(root, 0o755)
            sealed = root / "sealed-helper.py"; shutil.copyfile(SCRIPT, sealed); os.chmod(sealed, 0o444)
            home = root / "home"; home.mkdir(mode=0o700); os.chown(home, uid, uid)
            db = home / "tauri_localhost_0.localstorage"
            con = sqlite3.connect(db); con.execute("PRAGMA journal_mode=WAL"); con.execute(module.TABLE)
            con.execute("INSERT INTO ItemTable VALUES (?,?)", ("synthetic", b"preserved")); con.commit(); con.close()
            os.chown(db, uid, uid); os.chmod(db, 0o600)
            try:
                with module.HeldReader(db, uid, sealed) as reader:
                    proc = Path("/proc") / str(reader.process.pid)
                    self.assertEqual(proc.stat().st_uid, uid)
                    paths = (db, Path(str(db) + "-wal"))
                    reader.require_open_files([(p.stat().st_dev, p.stat().st_ino) for p in paths])
                    self.assertEqual(len(reader.capture()), 64)
                    reader.require_open_files([(p.stat().st_dev, p.stat().st_ino) for p in paths])
                    for suffix in ("-wal", "-shm"):
                        self.assertEqual(Path(str(db) + suffix).stat().st_uid, uid)
            except Exception:
                diagnostic = subprocess.run([sys.executable, "-I", "-S", "-B", str(sealed), "reader", str(db), str(uid)],
                    input=b"CAPTURE\nCLOSE\n", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
                    user=uid, group=uid, extra_groups=[])
                print("fixture child diagnostic:", diagnostic.returncode, diagnostic.stderr.decode(errors="replace")[:2000], flush=True)
                raise
            self.assertIsNone(reader.process)


if __name__ == "__main__": unittest.main(verbosity=2)
