"""Disposable Linux tests for the source-sealed held SQLite reader."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("native-linux-localstorage-snapshot.py")
spec = importlib.util.spec_from_file_location("localstorage_snapshot", SCRIPT)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


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

    def test_missing_or_replaced_wal_descriptor_refuses_and_reaps(self):
        with self.assertRaisesRegex(RuntimeError, "descriptor differs"):
            with module.HeldReader(self.db, self.uid, SCRIPT) as reader:
                identities = self.identities()
                reader.require_open_files([(identities[0][0], identities[0][1] + 1000000)])
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


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root runner")
class RootToSyntheticUidTests(unittest.TestCase):
    def test_root_reader_drops_uid_gid_and_reaps(self):
        uid = 21314
        with tempfile.TemporaryDirectory(prefix="root-held-reader-") as temporary:
            root = Path(temporary).resolve(); os.chown(root, uid, uid); os.chmod(root, 0o700)
            db = root / "tauri_localhost_0.localstorage"
            con = sqlite3.connect(db); con.execute("PRAGMA journal_mode=WAL"); con.execute(module.TABLE)
            con.execute("INSERT INTO ItemTable VALUES (?,?)", ("synthetic", b"preserved")); con.commit(); con.close()
            os.chown(db, uid, uid); os.chmod(db, 0o600)
            with module.HeldReader(db, uid, SCRIPT) as reader:
                proc = Path("/proc") / str(reader.process.pid)
                self.assertEqual(proc.stat().st_uid, uid)
                self.assertEqual(len(reader.capture()), 64)
                for suffix in ("-wal", "-shm"):
                    self.assertEqual(Path(str(db) + suffix).stat().st_uid, uid)
            self.assertIsNone(reader.process)


if __name__ == "__main__": unittest.main(verbosity=2)
