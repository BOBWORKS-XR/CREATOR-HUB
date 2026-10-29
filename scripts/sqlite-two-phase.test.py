"""Synthetic feasibility test only; no product, live HOME, or real settings."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import time
import unittest
from unittest.mock import patch


TABLE = "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)"
DB = "tauri_localhost_0.localstorage"
OTHER = "protected-settings.json"
LIMIT = 8 * 1024 * 1024


def require(condition, message):
    if not condition: raise RuntimeError(message)


def stamp(info):
    return tuple(getattr(info, key) for key in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))


def checked(root, name, uid, *, content=True):
    path = root / name
    info = path.lstat()
    require(path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and info.st_uid == uid and info.st_gid == (os.getgid() if hasattr(os, "getgid") else info.st_gid) and info.st_size <= LIMIT,
            "file identity/owner/size refused")
    if os.name == "posix": require(stat.S_IMODE(info.st_mode) & 0o077 == 0, "file permission refused")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        require(stamp(os.fstat(fd)) == stamp(info), "file open drift")
        if content:
            with os.fdopen(fd, "rb", closefd=False) as stream: raw = stream.read(LIMIT + 1)
            require(len(raw) == info.st_size, "short or oversized read")
        else: raw = None
        require(stamp(os.fstat(fd)) == stamp(info) and stamp(path.lstat()) == stamp(info), "file read drift")
    finally: os.close(fd)
    return (stamp(info), hashlib.sha256(raw).hexdigest() if raw is not None else None)


def shm_identity(row):
    info, _ = row
    return info[:7]


def home(root, phase, uid):
    info = root.lstat()
    require(root.resolve(strict=True) == root and stat.S_ISDIR(info.st_mode) and info.st_uid == uid
            and info.st_gid == (os.getgid() if hasattr(os, "getgid") else info.st_gid), "directory identity/owner refused")
    if os.name == "posix": require(stat.S_IMODE(info.st_mode) & 0o077 == 0, "directory permissions refused")
    names = {p.name for p in root.iterdir()}
    expected = {DB, OTHER} | ({DB + "-wal", DB + "-shm"} if phase == "active" else set())
    require(names == expected, "unknown/missing HOME entry refused")
    result = {n: checked(root, n, uid, content=(n != DB + "-shm")) for n in sorted(names)}
    result["."] = (stamp(info), None)
    return result


def logical(database):
    rows = database.execute("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").fetchall()
    require(rows == [("index", "sqlite_autoindex_ItemTable_1", "ItemTable", None),
                     ("table", "ItemTable", "ItemTable", TABLE)], "unknown schema refused")
    count = database.execute("SELECT COUNT(*) FROM ItemTable").fetchone()[0]
    require(type(count) is int and 0 <= count <= 1024, "row count refused")
    digest = hashlib.sha256()
    for key, value in database.execute("SELECT key, value FROM ItemTable ORDER BY key"):
        require(type(key) is str and type(value) is bytes, "row type refused")
        raw = key.encode("utf-8")
        require(len(raw) <= 4096 and len(value) <= 65536, "row size refused")
        for part in (raw, value): digest.update(len(part).to_bytes(8, "big")); digest.update(part)
    return digest.hexdigest()


def capture(root, phase, *, uid, quiescent=False, concurrent=None):
    require(phase in ("baseline", "active", "final"), "unknown phase")
    if phase != "active": require(quiescent is True, "quiescence unproven")
    before = home(root, phase, uid)
    uri = (root / DB).as_uri() + ("?mode=ro" if phase == "active" else "?mode=ro&immutable=1")
    source = sqlite3.connect(uri, uri=True, timeout=0)
    target = sqlite3.connect(":memory:")
    try:
        source.execute("PRAGMA query_only=ON")
        source.execute("PRAGMA trusted_schema=OFF")
        pages = source.execute("PRAGMA page_count").fetchone()[0]
        page_size = source.execute("PRAGMA page_size").fetchone()[0]
        require(type(pages) is int and type(page_size) is int and 0 <= pages * page_size <= LIMIT, "database size refused")
        deadline = time.monotonic() + 3
        fired = False
        def progress(status, remaining, total):
            nonlocal fired
            require(time.monotonic() < deadline, "backup deadline")
            if concurrent is not None and not fired:
                fired = True; concurrent()
        source.backup(target, pages=1, progress=progress, sleep=0)
        require(target.execute("PRAGMA quick_check").fetchall() == [("ok",)], "database integrity refused")
        result = logical(target)
    finally:
        target.close(); source.close()
    after = home(root, phase, uid)
    require(before.keys() == after.keys(), "HOME inventory drift")
    for name in before:
        if name == DB + "-shm":
            require(shm_identity(before[name]) == shm_identity(after[name]), "SHM identity drift")
        else:
            require(before[name] == after[name], "protected source drift")
    return result, before[OTHER]


def verify(root, phase, expected, **kwargs):
    require(capture(root, phase, **kwargs) == expected, "effective settings or protected file changed")


class TwoPhase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="two-phase-synthetic-")
        self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name).resolve()
        self.uid = os.getuid() if hasattr(os, "getuid") else self.root.stat().st_uid
        self.db = self.root / DB; self.other = self.root / OTHER
        self.other.write_bytes(b"synthetic-protected-settings"); os.chmod(self.other, 0o600)
        connection = sqlite3.connect(self.db); connection.execute(TABLE)
        connection.execute("INSERT INTO ItemTable VALUES (?, ?)", ("synthetic.preference", b"preserved"))
        connection.commit(); connection.close(); os.chmod(self.db, 0o600)

    def baseline(self): return capture(self.root, "baseline", uid=self.uid, quiescent=True)

    def active_writer(self):
        connection = sqlite3.connect(self.db); self.addCleanup(connection.close)
        self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("SELECT key FROM ItemTable").fetchall()
        return connection

    def test_unchanged_baseline_active_and_final_match(self):
        baseline = self.baseline(); writer = self.active_writer()
        verify(self.root, "active", baseline, uid=self.uid)
        writer.close()
        verify(self.root, "final", baseline, uid=self.uid, quiescent=True)

    def test_committed_wal_change_rejected_by_logical_comparison(self):
        baseline = self.baseline(); writer = self.active_writer()
        writer.execute("UPDATE ItemTable SET value=?", (b"changed",)); writer.commit()
        with self.assertRaisesRegex(RuntimeError, "effective settings"): verify(self.root, "active", baseline, uid=self.uid)

    def test_committed_unchanged_wal_is_included_and_synthetic_shm_may_change(self):
        baseline = self.baseline(); writer = self.active_writer()
        old = sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True)
        try:
            old.execute("BEGIN"); old.execute("SELECT value FROM ItemTable").fetchall()
            writer.execute("INSERT INTO ItemTable VALUES (?, ?)", ("synthetic.transient", b"temporary"))
            writer.execute("DELETE FROM ItemTable WHERE key=?", ("synthetic.transient",)); writer.commit()
            self.assertGreater((self.root / (DB + "-wal")).stat().st_size, 0)
            verify(self.root, "active", baseline, uid=self.uid)
        finally: old.close()

    def test_concurrent_commit_during_backup_refuses(self):
        self.baseline(); writer = self.active_writer()
        def mutate(): writer.execute("UPDATE ItemTable SET value=?", (b"concurrent",)); writer.commit()
        with self.assertRaisesRegex(RuntimeError, "protected source drift"):
            capture(self.root, "active", uid=self.uid, concurrent=mutate)

    def test_unknown_additions_and_other_settings_tamper_refuse(self):
        baseline = self.baseline(); self.active_writer()
        (self.root / "unknown").write_bytes(b"unknown")
        with self.assertRaisesRegex(RuntimeError, "unknown/missing"): capture(self.root, "active", uid=self.uid)
        (self.root / "unknown").unlink(); self.other.write_bytes(b"changed"); os.chmod(self.other, 0o600)
        with self.assertRaisesRegex(RuntimeError, "protected file"): verify(self.root, "active", baseline, uid=self.uid)

    def test_unknown_schema_owner_and_quiescence_refuse(self):
        with self.assertRaisesRegex(RuntimeError, "quiescence"): capture(self.root, "baseline", uid=self.uid)
        with self.assertRaisesRegex(RuntimeError, "owner"): capture(self.root, "baseline", uid=self.uid + 1, quiescent=True)
        connection = sqlite3.connect(self.db); connection.execute("CREATE TABLE unfamiliar (value TEXT)"); connection.commit(); connection.close()
        with self.assertRaisesRegex(RuntimeError, "unknown schema"): self.baseline()

    def test_missing_sidecar_and_symlink_refuse(self):
        self.baseline(); writer = self.active_writer(); writer.close()
        with self.assertRaisesRegex(RuntimeError, "unknown/missing"): capture(self.root, "active", uid=self.uid)
        if os.name != "posix": return
        self.other.unlink(); self.other.symlink_to(self.db)
        with self.assertRaisesRegex(RuntimeError, "identity"): self.baseline()

    def test_corrupt_database_refuses_without_snapshot(self):
        self.db.write_bytes(b"not a SQLite database"); os.chmod(self.db, 0o600)
        with self.assertRaises(sqlite3.DatabaseError): self.baseline()

    def test_unavailable_snapshot_refuses(self):
        with patch.object(sqlite3, "connect", side_effect=sqlite3.OperationalError("unavailable")):
            with self.assertRaises(sqlite3.OperationalError): self.baseline()

    @unittest.skipUnless(os.name == "posix", "hard-link and replacement identity require POSIX")
    def test_hardlink_and_same_bytes_replacement_refuse(self):
        baseline = self.baseline()
        with tempfile.TemporaryDirectory(prefix="synthetic-external-link-") as temporary:
            os.link(self.db, Path(temporary) / "linked.sqlite")
            with self.assertRaisesRegex(RuntimeError, "identity"): self.baseline()
        writer = self.active_writer()
        replacement = self.root / "replacement"; replacement.write_bytes(self.other.read_bytes()); os.chmod(replacement, 0o600)
        os.replace(replacement, self.other)
        with self.assertRaisesRegex(RuntimeError, "protected file"): verify(self.root, "active", baseline, uid=self.uid)
        writer.close()


if __name__ == "__main__": unittest.main(verbosity=2)
