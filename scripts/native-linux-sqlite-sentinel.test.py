"""Synthetic SQLite/HOME experiment only. Never opens any application data."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest


def file_pin(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("Synthetic HOME entry is not an ordinary file")
    raw = path.read_bytes()
    after = path.lstat()
    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns")
    if tuple(getattr(before, k) for k in fields) != tuple(getattr(after, k) for k in fields):
        raise RuntimeError("Synthetic HOME entry changed during read")
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "uid": before.st_uid, "gid": before.st_gid, "mode": stat.S_IMODE(before.st_mode)}


def snapshot(root):
    return {p.relative_to(root).as_posix(): file_pin(p) for p in sorted(root.iterdir())}


def require_unchanged(baseline, current):
    if baseline != current:
        raise RuntimeError("Synthetic HOME preservation refused")


class SyntheticSentinel(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sqlite-sentinel-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.db = self.root / "tauri_localhost_0.localstorage"
        self.writer = sqlite3.connect(self.db)
        self.addCleanup(self.writer.close)
        self.assertEqual(self.writer.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.writer.execute("INSERT INTO settings VALUES (?, ?)", ("synthetic", "before"))
        self.writer.commit()
        self.sentinel = sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True)
        self.addCleanup(self.sentinel.close)
        self.sentinel.execute("PRAGMA query_only=ON")
        self.sentinel.execute("BEGIN")
        self.assertEqual(self.sentinel.execute("SELECT value FROM settings").fetchone()[0], "before")
        self.baseline = snapshot(self.root)
        self.assertEqual(set(self.baseline), {self.db.name, self.db.name + "-wal", self.db.name + "-shm"})
        self.assertGreater(self.baseline[self.db.name + "-wal"]["size"], 0)

    def test_committed_wal_change_fails_closed_while_read_transaction_keeps_old_value(self):
        before_main = self.baseline[self.db.name]
        self.writer.execute("UPDATE settings SET value=? WHERE key=?", ("after", "synthetic"))
        self.writer.commit()
        current = snapshot(self.root)
        self.assertEqual(current[self.db.name], before_main)
        self.assertNotEqual(current[self.db.name + "-wal"]["sha256"], self.baseline[self.db.name + "-wal"]["sha256"])
        self.assertEqual(self.sentinel.execute("SELECT value FROM settings").fetchone()[0], "before")
        reader = sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True)
        try: self.assertEqual(reader.execute("SELECT value FROM settings").fetchone()[0], "after")
        finally: reader.close()
        with self.assertRaisesRegex(RuntimeError, "preservation refused"): require_unchanged(self.baseline, current)

    def test_unknown_addition_is_not_exempt(self):
        (self.root / "unknown-new-file").write_bytes(b"synthetic")
        with self.assertRaisesRegex(RuntimeError, "preservation refused"):
            require_unchanged(self.baseline, snapshot(self.root))

    def test_writer_close_does_not_checkpoint_or_remove_wal_while_sentinel_reads(self):
        self.writer.close()
        current = snapshot(self.root)
        self.assertEqual(current[self.db.name], self.baseline[self.db.name])
        self.assertEqual(current[self.db.name + "-wal"], self.baseline[self.db.name + "-wal"])
        self.assertIn(self.db.name + "-shm", current)
        self.assertEqual(self.sentinel.execute("SELECT value FROM settings").fetchone()[0], "before")
        changed = sorted(name for name in self.baseline if current.get(name) != self.baseline[name])
        print(json.dumps({"scope": "synthetic-writer-close", "changedAfterWriterClose": changed,
                          "committedWalStillPresent": True}, sort_keys=True))
        if changed:
            with self.assertRaisesRegex(RuntimeError, "preservation refused"): require_unchanged(self.baseline, current)
        else:
            require_unchanged(self.baseline, current)

    def test_read_only_second_connection_observes_wal_without_assuming_sidecar_stability(self):
        other = sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True)
        try: self.assertEqual(other.execute("SELECT value FROM settings").fetchone()[0], "before")
        finally: other.close()
        current = snapshot(self.root)
        changed = sorted(name for name in self.baseline if current.get(name) != self.baseline[name])
        print(json.dumps({"scope": "synthetic-sqlite-only", "sqliteVersion": sqlite3.sqlite_version,
                          "baselineWalBytes": self.baseline[self.db.name + "-wal"]["size"],
                          "changedBySecondReader": changed, "sourceSettingPreserved": True}, sort_keys=True))
        self.assertEqual(current[self.db.name], self.baseline[self.db.name])
        self.assertEqual(current[self.db.name + "-wal"], self.baseline[self.db.name + "-wal"])
        if changed:
            with self.assertRaisesRegex(RuntimeError, "preservation refused"): require_unchanged(self.baseline, current)
        else:
            require_unchanged(self.baseline, current)


class SyntheticColdStart(unittest.TestCase):
    def test_read_only_sentinel_prepares_sidecars_without_changing_closed_database(self):
        with tempfile.TemporaryDirectory(prefix="sqlite-cold-sentinel-") as temporary:
            root = Path(temporary).resolve(); db = root / "tauri_localhost_0.localstorage"
            writer = sqlite3.connect(db)
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
            writer.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            writer.execute("INSERT INTO settings VALUES (?, ?)", ("synthetic", "before")); writer.commit(); writer.close()
            closed = snapshot(root); self.assertEqual(set(closed), {db.name})
            sentinel = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
            try:
                sentinel.execute("PRAGMA query_only=ON"); sentinel.execute("BEGIN")
                self.assertGreaterEqual(sentinel.execute("SELECT count(*) FROM sqlite_schema").fetchone()[0], 1)
                baseline = snapshot(root)
                self.assertEqual(baseline[db.name], closed[db.name])
                self.assertEqual(set(baseline), {db.name, db.name + "-wal", db.name + "-shm"})
                self.assertEqual(baseline[db.name + "-wal"]["size"], 0)
                self.assertEqual(sentinel.execute("SELECT value FROM settings").fetchone()[0], "before")
                second = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
                try: self.assertEqual(second.execute("SELECT value FROM settings").fetchone()[0], "before")
                finally: second.close()
                changed = sorted(name for name in baseline if snapshot(root).get(name) != baseline[name])
                print(json.dumps({"scope": "synthetic-cold-start", "baseUnchanged": True,
                                  "sidecarsPresentBeforeBaseline": True, "walBytes": 0,
                                  "changedAfterSecondReader": changed}, sort_keys=True))
            finally:
                sentinel.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
