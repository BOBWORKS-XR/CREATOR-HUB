"""Disposable Linux-only SQLite experiment, using the observed WebKit schema."""
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

NAME = "tauri_localhost_0.localstorage"
TABLE = "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)"
LIMIT = 8 * 1024 * 1024


def require(value, message):
    if not value: raise RuntimeError(message)


def checked(path, content=True):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == st.st_gid == os.getuid()
            and st.st_nlink == 1 and not st.st_mode & 0o022 and st.st_size <= LIMIT, "unsafe file")
    stamp = lambda x: tuple(getattr(x, k) for k in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(stamp(os.fstat(fd)) == stamp(st), "open drift")
        raw = b""
        if content:
            while True:
                chunk = os.read(fd, 65536)
                if not chunk: break
                raw += chunk
                require(len(raw) <= LIMIT, "file too large")
            require(len(raw) == st.st_size, "short read")
        require(stamp(os.fstat(fd)) == stamp(st) == stamp(path.lstat()), "read drift")
        return stamp(st), hashlib.sha256(raw).hexdigest() if content else None
    finally: os.close(fd)


def inventory(home, active):
    st = home.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == st.st_gid == os.getuid()
            and not st.st_mode & 0o077 and home.resolve() == home, "unsafe HOME")
    expected = {NAME, "protected.json"} | ({NAME + "-wal", NAME + "-shm"} if active else set())
    require({p.name for p in home.iterdir()} == expected, "unknown or missing HOME entry")
    return {n: checked(home / n, n != NAME + "-shm") for n in sorted(expected)}


def verify_checkpoint(before, after, baseline, actual):
    for name in (NAME, NAME + "-wal", "protected.json"):
        require(before[name] == after[name], "protected bytes or identity drift")
    require(before[NAME + "-shm"][0][:7] == after[NAME + "-shm"][0][:7], "SHM identity drift")
    require(baseline == actual, "logical contents changed")


def reader(db, scratch):
    source = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=2)
    source.execute("PRAGMA query_only=ON")
    source.execute("PRAGMA trusted_schema=OFF")
    source.execute("BEGIN")
    source.execute("SELECT count(*) FROM sqlite_schema").fetchone()
    print("ready " + str(os.getpid()), flush=True)
    require(sys.stdin.readline().strip() == "backup", "backup command missing")
    fd = os.open(scratch, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    target = sqlite3.connect(scratch.as_uri() + "?mode=rw", uri=True, timeout=2)
    try:
        fired = False
        def progress(status, remaining, total):
            nonlocal fired
            if not fired:
                fired = True; print("step", flush=True)
                require(sys.stdin.readline().strip() == "continue", "resume missing")
        source.backup(target, pages=1, progress=progress, sleep=0)
        require(target.execute("PRAGMA quick_check").fetchall() == [("ok",)], "integrity")
        schema = target.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
        require(schema == [("index", "sqlite_autoindex_ItemTable_1", "ItemTable", None),
                           ("table", "ItemTable", "ItemTable", TABLE)], "unknown schema")
        rows = target.execute("SELECT key,value FROM ItemTable ORDER BY key").fetchall()
        require(all(type(k) is str and type(v) is bytes for k, v in rows), "unknown row type")
        print(json.dumps({"schema": schema, "rows": [[k, v.hex()] for k, v in rows]}), flush=True)
        require(sys.stdin.readline().strip() == "close", "close command missing")
    finally:
        target.close(); source.close()


def writer(db):
    con = sqlite3.connect(db, timeout=3)
    con.execute("UPDATE ItemTable SET value=? WHERE key=?", (b"changed", "one"))
    con.commit(); con.close()
    print("committed", flush=True)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux POSIX fixture")
class Backup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-uid-backup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "home"; self.home.mkdir(mode=0o700)
        self.scratch = self.root / "scratch"; self.scratch.mkdir(mode=0o700)
        self.db = self.home / NAME
        (self.home / "protected.json").write_bytes(b"original-other-settings")
        os.chmod(self.home / "protected.json", 0o600)
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        con.execute(TABLE)
        self.rows = [("one", b"original"), ("other", b""), ("unicode-\u2603", b"\x00\xff")]
        con.executemany("INSERT INTO ItemTable VALUES (?,?)", self.rows); con.commit(); con.close()
        os.chmod(self.db, 0o600)
        self.before = inventory(self.home, False)
        self.process = None
        self.addCleanup(self.stop)

    def start(self):
        self.process = subprocess.Popen([sys.executable, "-I", "-S", "-B", __file__, "reader", str(self.db), str(self.scratch / "copy.sqlite")],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(self.process.stdout.readline().strip(), "ready " + str(self.process.pid))
        self.assertNotEqual(self.process.pid, os.getpid())
        current = inventory(self.home, True)
        self.assertEqual(current[NAME], self.before[NAME])
        self.assertEqual(current["protected.json"], self.before["protected.json"])
        self.assertEqual(current[NAME + "-wal"][0][6], 0)
        return current

    def backup(self, during=None):
        self.process.stdin.write("backup\n"); self.process.stdin.flush()
        self.assertEqual(self.process.stdout.readline().strip(), "step")
        if during: during()
        self.process.stdin.write("continue\n"); self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def stop(self):
        if self.process is None: return
        if self.process.poll() is None:
            try:
                self.process.stdin.write("close\n"); self.process.stdin.flush()
                self.process.communicate(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.kill(); self.process.communicate(timeout=5)
        else: self.process.communicate(timeout=5)

    def test_cold_open_backup_all_rows_under_synthetic_uid(self):
        before = self.start(); data = self.backup(); after = inventory(self.home, True)
        self.assertEqual(data["rows"], [[k, v.hex()] for k, v in sorted(self.rows)])
        verify_checkpoint(before, after, data, data)
        print(json.dumps({"result": "cold-synthetic-uid-backup", "rowCount": len(data["rows"]),
                          "sourceReaderPid": self.process.pid, "walBytes": before[NAME + "-wal"][0][6],
                          "mainAndWalExact": True, "protectedExact": True}), flush=True)

    def test_distinct_writer_during_backup_creates_detectable_wal_drift(self):
        before = self.start()
        def mutate():
            run = subprocess.run([sys.executable, "-I", "-S", "-B", __file__, "writer", str(self.db)],
                                 capture_output=True, text=True, timeout=10, check=True)
            self.assertEqual(run.stdout.strip(), "committed")
        data = self.backup(during=mutate); after = inventory(self.home, True)
        self.assertEqual(data["rows"], [[k, v.hex()] for k, v in sorted(self.rows)])
        with self.assertRaisesRegex(RuntimeError, "protected bytes or identity drift"):
            verify_checkpoint(before, after, data, data)
        self.assertEqual(before[NAME], after[NAME]); self.assertEqual(before["protected.json"], after["protected.json"])
        print(json.dumps({"result": "writer-drift-detected", "oldReadSnapshot": True, "walChanged": True}), flush=True)

    def test_logical_change_and_unrelated_tamper_are_refused(self):
        before = self.start(); data = self.backup(); after = inventory(self.home, True)
        changed = json.loads(json.dumps(data)); changed["rows"][1][1] = "ff"
        with self.assertRaisesRegex(RuntimeError, "logical contents changed"):
            verify_checkpoint(before, after, data, changed)
        (self.home / "protected.json").write_bytes(b"changed-other-settings")
        tampered = inventory(self.home, True)
        with self.assertRaisesRegex(RuntimeError, "protected bytes or identity drift"):
            verify_checkpoint(before, tampered, data, data)

    def test_sidecar_identity_change_is_refused(self):
        before = self.start(); data = self.backup()
        wal = self.home / (NAME + "-wal")
        replacement = self.scratch / "replacement"
        replacement.write_bytes(wal.read_bytes()); os.chmod(replacement, 0o600)
        os.replace(replacement, wal)
        after = inventory(self.home, True)
        with self.assertRaisesRegex(RuntimeError, "protected bytes or identity drift"):
            verify_checkpoint(before, after, data, data)

    def test_unknown_home_addition_refused(self):
        self.start()
        (self.home / "unknown").write_bytes(b"unknown")
        with self.assertRaisesRegex(RuntimeError, "unknown or missing HOME entry"): inventory(self.home, True)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "reader": reader(Path(sys.argv[2]), Path(sys.argv[3]))
    elif len(sys.argv) == 3 and sys.argv[1] == "writer": writer(Path(sys.argv[2]))
    else: unittest.main(verbosity=2)
