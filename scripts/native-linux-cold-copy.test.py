"""Disposable cold-main copy experiment; never uses a real HOME."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest

SCHEMA = "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)"
NAME = "tauri_localhost_0.localstorage"
LIMIT = 8 * 1024 * 1024


def require(value, message):
    if not value: raise RuntimeError(message)


def absent(db):
    require(not os.path.lexists(str(db) + "-wal") and not os.path.lexists(str(db) + "-shm"), "sidecar appeared")
    require(not os.path.lexists(str(db) + "-journal"), "unexpected journal")


def stamp(st):
    return tuple(getattr(st, k) for k in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))


def read_main(db):
    st = db.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.getuid() and st.st_size <= LIMIT, "main identity refused")
    fd = os.open(db, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(stamp(os.fstat(fd)) == stamp(st), "main open drift")
        parts = []
        while True:
            part = os.read(fd, 65536)
            if not part: break
            parts.append(part)
        raw = b"".join(parts)
        require(len(raw) == st.st_size and stamp(os.fstat(fd)) == stamp(st) == stamp(db.lstat()), "main read drift")
        return stamp(st), hashlib.sha256(raw).hexdigest(), raw
    finally:
        os.close(fd)


def capture(db, scratch, *, before_verify=None, before_sidecar_recheck=None):
    absent(db)
    before = read_main(db)
    fd = os.open(scratch, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as f:
            f.write(before[2]); f.flush()
    finally:
        os.close(fd)
    if before_verify: before_verify()
    after = read_main(db)
    require(before == after, "source drift")
    if before_sidecar_recheck: before_sidecar_recheck()
    absent(db)
    con = sqlite3.connect(scratch.as_uri() + "?mode=ro", uri=True, timeout=0)
    try:
        con.execute("PRAGMA query_only=ON")
        require(con.execute("PRAGMA quick_check").fetchall() == [("ok",)], "integrity refused")
        require(con.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall() == [
            ("index", "sqlite_autoindex_ItemTable_1", "ItemTable", None), ("table", "ItemTable", "ItemTable", SCHEMA)], "unknown schema")
        rows = con.execute("SELECT key,value FROM ItemTable ORDER BY key").fetchall()
        require(all(type(k) is str and type(v) is bytes for k, v in rows), "unknown row type")
        return rows
    finally: con.close()


def writer(db):
    con = sqlite3.connect(db, timeout=3)
    require(con.execute("PRAGMA journal_mode").fetchone()[0] == "wal", "writer WAL required")
    con.execute("UPDATE ItemTable SET value=? WHERE key=?", (b"changed", "fixture"))
    con.commit(); con.close()
    print("committed-and-closed", flush=True)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux POSIX test")
class ColdCopy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cold-copy-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "home"; self.home.mkdir(mode=0o700)
        self.scratchdir = self.root / "scratch"; self.scratchdir.mkdir(mode=0o700)
        self.db = self.home / NAME
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        con.execute(SCHEMA)
        con.execute("INSERT INTO ItemTable VALUES (?,?)", ("fixture", b"original"))
        con.commit(); con.close(); os.chmod(self.db, 0o600)
        absent(self.db)

    def mutate(self):
        run = subprocess.run([sys.executable, "-I", "-S", "-B", __file__, "--writer", str(self.db)],
                             capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(run.stdout.strip(), "committed-and-closed")
        absent(self.db)

    def test_unchanged_copy_and_exclusive_scratch(self):
        before = read_main(self.db)
        out = self.scratchdir / "copy"
        self.assertEqual(capture(self.db, out), [("fixture", b"original")])
        self.assertEqual(read_main(self.db), before)
        absent(self.db)
        with self.assertRaises(FileExistsError): capture(self.db, out)

    def test_distinct_writer_before_final_main_verify_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "source drift"):
            capture(self.db, self.scratchdir / "copy", before_verify=self.mutate)

    def test_writer_between_final_main_verify_and_sidecar_recheck_is_not_detected(self):
        rows = capture(self.db, self.scratchdir / "copy", before_sidecar_recheck=self.mutate)
        absent(self.db)
        live = sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True, timeout=0)
        try: current = live.execute("SELECT key,value FROM ItemTable").fetchall()
        finally: live.close()
        self.assertEqual(rows, [("fixture", b"original")])
        self.assertEqual(current, [("fixture", b"changed")])
        print(json.dumps({"counterexample": "commit-and-checkpoint-between-final-main-check-and-sidecar-check",
                          "captureAccepted": True, "capture": "original", "actual": "changed"}), flush=True)

    def test_unknown_schema_and_existing_sidecars_refuse(self):
        con = sqlite3.connect(self.db); con.execute("CREATE TABLE unknown (v TEXT)"); con.commit(); con.close()
        with self.assertRaisesRegex(RuntimeError, "unknown schema"): capture(self.db, self.scratchdir / "copy")
        Path(str(self.db) + "-wal").write_bytes(b"unexpected")
        with self.assertRaisesRegex(RuntimeError, "sidecar appeared"): capture(self.db, self.scratchdir / "copy2")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--writer": writer(sys.argv[2])
    else: unittest.main(verbosity=2)
