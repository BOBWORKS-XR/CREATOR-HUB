"""Bounded synthetic-UID SQLite reader used by the private native test harness."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import sqlite3
import subprocess
import sys
import time

TABLE = "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)"
SCHEMA = [("index", "sqlite_autoindex_ItemTable_1", "ItemTable", None),
          ("table", "ItemTable", "ItemTable", TABLE)]
MAX_DATABASE = 16 * 1024 * 1024


def require(value, message):
    if not value: raise RuntimeError(message)


def digest(database):
    require(database.execute("PRAGMA quick_check").fetchall() == [("ok",)], "SQLite integrity refused")
    schema = database.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
    require(schema == SCHEMA, "Unknown localStorage schema")
    state = hashlib.sha256(b"synthetic-localstorage-schema-rows-v1\0")
    canonical = json.dumps(schema, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    state.update(len(canonical).to_bytes(8, "big")); state.update(canonical)
    count = total = 0
    for key, value in database.execute("SELECT key,value FROM ItemTable ORDER BY key"):
        require(type(key) is str and type(value) is bytes, "Unknown localStorage value type")
        key = key.encode("utf-8"); count += 1; total += len(key) + len(value)
        require(count <= 4096 and total <= MAX_DATABASE and len(key) <= 65536 and len(value) <= MAX_DATABASE,
                "localStorage row bound exceeded")
        for item in (key, value): state.update(len(item).to_bytes(8, "big")); state.update(item)
    return state.hexdigest()


def child(path, uid):
    require(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == uid,
            "Synthetic reader UID/GID required")
    require(path.is_absolute() and path.name == "tauri_localhost_0.localstorage", "Unexpected database path")
    source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
    target = None
    try:
        source.execute("PRAGMA query_only=ON")
        source.execute("PRAGMA trusted_schema=OFF")
        require(source.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal", "WAL mode required")
        source.execute("SELECT count(*) FROM sqlite_schema").fetchone()
        print("OPEN", flush=True)
        require(sys.stdin.buffer.readline(32) == b"CAPTURE\n", "Capture request refused")
        source.execute("BEGIN")
        source.execute("SELECT count(*) FROM sqlite_schema").fetchone()
        size = source.execute("PRAGMA page_count").fetchone()[0] * source.execute("PRAGMA page_size").fetchone()[0]
        require(type(size) is int and 0 < size <= MAX_DATABASE, "SQLite size refused")
        target = sqlite3.connect(":memory:")
        target.execute("PRAGMA trusted_schema=OFF")
        source.backup(target, pages=64, sleep=0.01)
        print("DIGEST " + digest(target), flush=True)
        require(sys.stdin.buffer.readline(32) == b"CLOSE\n", "Close request refused")
    finally:
        if target is not None: target.close()
        source.close()


class HeldReader:
    """The caller inventories before capture and again before releasing this reader."""
    def __init__(self, path, uid, script, timeout=10):
        require(type(uid) is int and uid > 0 and type(timeout) in (int, float) and 0 < timeout <= 30,
                "Invalid reader bounds")
        self.path, self.uid, self.script, self.timeout = Path(path), uid, Path(script), timeout
        self.process = None
        self.buffer = b""

    def _line(self):
        deadline = time.monotonic() + self.timeout
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                require(remaining > 0 and selector.select(remaining), "SQLite helper deadline")
                part = os.read(self.process.stdout.fileno(), 128)
                require(part and len(self.buffer) + len(part) <= 256, "SQLite helper output refused")
                self.buffer += part
        line, self.buffer = self.buffer.split(b"\n", 1)
        return line

    def __enter__(self):
        uid = os.geteuid()
        require(uid in (0, self.uid), "Foreign reader controller")
        kwargs = {"user": self.uid, "group": self.uid, "extra_groups": []} if uid == 0 else {}
        require(uid == 0 or os.getuid() == os.getgid() == os.getegid() == self.uid, "Synthetic caller identity refused")
        self.process = subprocess.Popen([sys.executable, "-I", "-S", "-B", str(self.script), "reader", str(self.path), str(self.uid)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, **kwargs)
        try:
            require(self._line() == b"OPEN", "SQLite helper open refused")
            return self
        except BaseException:
            self._cleanup(False)
            raise

    def capture(self):
        require(self.process is not None and self.process.poll() is None, "SQLite helper exited")
        self.process.stdin.write(b"CAPTURE\n"); self.process.stdin.flush()
        line = self._line()
        require(len(line) == 71 and line.startswith(b"DIGEST ") and all(c in b"0123456789abcdef" for c in line[7:]),
                "SQLite helper digest refused")
        return line[7:].decode("ascii")

    def require_open_files(self, identities):
        require(self.process is not None and self.process.poll() is None, "SQLite helper exited")
        proc = Path("/proc") / str(self.process.pid)
        require(proc.stat().st_uid == self.uid, "SQLite helper kernel UID differs")
        observed = set()
        with os.scandir(proc / "fd") as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=True)
                observed.add((info.st_dev, info.st_ino))
        require(set(identities).issubset(observed), "SQLite helper database/WAL descriptor differs")

    def _cleanup(self, normal):
        proc = self.process
        if proc is None: return
        try:
            if normal:
                require(proc.poll() is None, "SQLite helper exited during inventory")
                proc.stdin.write(b"CLOSE\n"); proc.stdin.flush()
                require(proc.wait(timeout=self.timeout) == 0, "SQLite helper exit refused")
                with selectors.DefaultSelector() as selector:
                    selector.register(proc.stdout, selectors.EVENT_READ)
                    require(not self.buffer and selector.select(self.timeout)
                            and os.read(proc.stdout.fileno(), 1) == b"", "SQLite helper output/EOF refused")
        finally:
            if proc.poll() is None:
                proc.kill(); proc.wait(timeout=self.timeout)
            proc.stdin.close(); proc.stdout.close()
            self.process = None

    def __exit__(self, kind, value, traceback):
        self._cleanup(kind is None)


if __name__ == "__main__":
    require(len(sys.argv) == 4 and sys.argv[1] == "reader" and sys.argv[3].isdigit(), "Only fixed reader mode is supported")
    child(Path(sys.argv[2]), int(sys.argv[3]))
