"""Disposable synthetic SQLite only. No application HOME or user data."""
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


def snapshot(root, db):
    result = {}
    for suffix in ("", "-wal", "-shm"):
        path = root / (db.name + suffix)
        if path.exists():
            raw = path.read_bytes(); info = path.stat()
            result[suffix or "main"] = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                                       "dev": info.st_dev, "ino": info.st_ino, "mtimeNs": info.st_mtime_ns}
    return result


class BackupSafety(unittest.TestCase):
    def test_ro_backup_with_live_wal_and_older_reader_reports_source_mutation(self):
        with tempfile.TemporaryDirectory(prefix="sqlite-backup-safety-") as temporary:
            root = Path(temporary).resolve(); db = root / "synthetic.sqlite"
            writer = sqlite3.connect(db)
            old = source = destination = None
            try:
                self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
                writer.execute("INSERT INTO settings VALUES ('synthetic', 'before')"); writer.commit()
                old = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
                old.execute("BEGIN"); self.assertEqual(old.execute("SELECT value FROM settings").fetchone()[0], "before")
                writer.execute("UPDATE settings SET value='after'"); writer.commit()
                before = snapshot(root, db)
                source = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
                source.execute("PRAGMA query_only=ON")
                destination = sqlite3.connect(root / "synthetic-backup.sqlite")
                source.backup(destination)
                self.assertEqual(destination.execute("SELECT value FROM settings").fetchone()[0], "after")
                destination.close(); destination = None
                source.close(); source = None
                after = snapshot(root, db)
                changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
                print(json.dumps({"scope": "synthetic-ro-backup-with-old-reader", "sqliteVersion": sqlite3.sqlite_version,
                                  "changedSourceComponents": changed, "backupIncludedCommittedWal": True,
                                  "oldReaderStillSeesOriginal": old.execute("SELECT value FROM settings").fetchone()[0] == "before"}, sort_keys=True))
                self.assertEqual(before["main"], after["main"]); self.assertEqual(before["-wal"], after["-wal"])
            finally:
                if destination is not None: destination.close()
                if source is not None: source.close()
                if old is not None: old.close()
                writer.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
