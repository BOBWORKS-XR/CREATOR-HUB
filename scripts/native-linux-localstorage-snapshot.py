"""Bounded synthetic-UID SQLite reader used by the private native test harness."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import sqlite3
import stat
import subprocess
import sys
import tempfile
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
    metadata = {name: database.execute("PRAGMA " + name).fetchone()[0]
                for name in ("application_id", "user_version", "schema_version", "encoding", "page_size", "auto_vacuum", "default_cache_size")}
    require(type(metadata["application_id"]) is int and type(metadata["user_version"]) is int
            and type(metadata["schema_version"]) is int and type(metadata["page_size"]) is int
            and type(metadata["auto_vacuum"]) is int and type(metadata["default_cache_size"]) is int
            and type(metadata["encoding"]) is str,
            "Unknown persistent SQLite metadata")
    state = hashlib.sha256(b"synthetic-localstorage-schema-rows-metadata-v2\0")
    canonical = json.dumps([schema, metadata], sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    state.update(len(canonical).to_bytes(8, "big")); state.update(canonical)
    count = total = 0
    for key, value in database.execute("SELECT key,value FROM ItemTable ORDER BY key"):
        require(type(key) is str and type(value) is bytes, "Unknown localStorage value type")
        key = key.encode("utf-8"); count += 1; total += len(key) + len(value)
        require(count <= 4096 and total <= MAX_DATABASE and len(key) <= 65536 and len(value) <= MAX_DATABASE,
                "localStorage row bound exceeded")
        for item in (key, value): state.update(len(item).to_bytes(8, "big")); state.update(item)
    return state.hexdigest()


def stable_file(path, uid):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == before.st_gid == uid
                and not stat.S_IMODE(before.st_mode) & 0o022 and 0 <= before.st_size <= 64 * 1024 * 1024,
                "Synthetic SQLite source identity refused")
        def stamp(value):
            return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid, value.st_nlink,
                    value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(stamp(path.lstat()) == stamp(before), "SQLite source replaced at open")
        chunks = []
        remaining = before.st_size + 1
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk: break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        require(len(data) == before.st_size and stamp(os.fstat(fd)) == stamp(before)
                and stamp(path.lstat()) == stamp(before), "SQLite source changed while copying")
        return stamp(before), data
    finally:
        os.close(fd)


def independent_digest(path, uid, expected, directory):
    wal = Path(str(path) + "-wal")
    main_identity, main = stable_file(path, uid)
    wal_identity, wal_bytes = stable_file(wal, uid)
    directory = Path(directory)
    info = directory.lstat()
    require(directory.is_absolute() and stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == uid
            and stat.S_IMODE(info.st_mode) == 0o700 and not any(directory.iterdir()), "Private scratch directory refused")
    scratch = directory / path.name
    for dest, raw in ((scratch, main), (Path(str(scratch) + "-wal"), wal_bytes)):
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle: handle.write(raw)
    require(not os.path.lexists(str(scratch) + "-shm"), "Scratch SHM unexpectedly exists")
    copy = sqlite3.connect(scratch.as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        copy.execute("PRAGMA query_only=ON")
        copy.execute("PRAGMA trusted_schema=OFF")
        require(digest(copy) == expected, "Independent SQLite snapshot differs")
    finally:
        copy.close()
    after_main, after_main_bytes = stable_file(path, uid)
    after_wal, after_wal_bytes = stable_file(wal, uid)
    require((main_identity, main, wal_identity, wal_bytes) ==
            (after_main, after_main_bytes, after_wal, after_wal_bytes), "SQLite source changed during independent snapshot")


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
        result = digest(target)
        print("DIGEST " + result, flush=True)
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
        self.copier = None
        self.scratch = None
        self.scratch_identity = None
        self.scratch_container = None
        self.container_identity = None
        self.container_owner = None
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
        result = line[7:].decode("ascii")
        self._copy_snapshot(result)
        return result

    def _copy_snapshot(self, result):
        require(self.scratch_container is None and self.copier is None, "Scratch capture cannot be reused")
        self.scratch_container = Path(tempfile.mkdtemp(prefix="synthetic-localstorage-copy-"))
        outer = self.scratch_container.lstat()
        self.container_identity = (outer.st_dev, outer.st_ino)
        self.container_owner = (outer.st_uid, outer.st_gid)
        os.chmod(self.scratch_container, 0o711)
        self.scratch = self.scratch_container / "copy"
        self.scratch.mkdir(mode=0o700)
        initial = self.scratch.lstat()
        self.scratch_identity = (initial.st_dev, initial.st_ino)
        if os.geteuid() == 0: os.chown(self.scratch, self.uid, self.uid)
        info = self.scratch.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == self.uid
                and stat.S_IMODE(info.st_mode) == 0o700, "Private scratch ownership refused")
        require((info.st_dev, info.st_ino) == self.scratch_identity, "Scratch directory replaced")
        kwargs = {"user": self.uid, "group": self.uid, "extra_groups": []} if os.geteuid() == 0 else {}
        self.copier = subprocess.Popen([sys.executable, "-I", "-S", "-B", str(self.script), "copy",
                                        str(self.path), str(self.uid), str(self.scratch)], stdin=subprocess.PIPE,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, **kwargs)
        self.copier.communicate(input=(result + "\n").encode("ascii"), timeout=self.timeout)
        require(self.copier.returncode == 0 and self.process.poll() is None, "Independent SQLite snapshot refused")

    def _scratch_cleanup(self):
        if self.scratch_container is None: return
        outer = self.scratch_container.lstat()
        require(stat.S_ISDIR(outer.st_mode) and (outer.st_dev, outer.st_ino) == self.container_identity
                and (outer.st_uid, outer.st_gid) == self.container_owner and stat.S_IMODE(outer.st_mode) in (0o700, 0o711),
                "Scratch container identity changed")
        if self.scratch is not None and os.path.lexists(self.scratch):
            info = self.scratch.lstat()
            require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == self.scratch_identity
                    and (info.st_uid, info.st_gid) in ((self.uid, self.uid), (os.geteuid(), os.getegid()))
                    and stat.S_IMODE(info.st_mode) == 0o700, "Scratch directory identity changed")
            fd = os.open(self.scratch, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                opened = os.fstat(fd)
                require((opened.st_dev, opened.st_ino) == self.scratch_identity, "Scratch directory replaced")
                allowed = {self.path.name, self.path.name + "-wal", self.path.name + "-shm", self.path.name + "-journal"}
                with os.scandir(fd) as entries:
                    names = [entry.name for entry in entries if entry.is_file(follow_symlinks=False) and entry.name in allowed]
                require(set(os.listdir(fd)) == set(names), "Unknown scratch entry refused")
                for name in names: os.unlink(name, dir_fd=fd)
                require(not os.listdir(fd), "Scratch directory not empty")
            finally: os.close(fd)
            require((self.scratch.lstat().st_dev, self.scratch.lstat().st_ino) == self.scratch_identity,
                    "Scratch directory replaced during cleanup")
            os.rmdir(self.scratch)
        require((self.scratch_container.lstat().st_dev, self.scratch_container.lstat().st_ino) == self.container_identity,
                "Scratch container replaced during cleanup")
        os.rmdir(self.scratch_container)
        self.scratch = self.scratch_container = None

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
        errors = []
        try:
            if self.copier is not None and self.copier.poll() is None:
                self.copier.kill(); self.copier.wait(timeout=self.timeout)
            if normal:
                require(proc.poll() is None, "SQLite helper exited during inventory")
                proc.stdin.write(b"CLOSE\n"); proc.stdin.flush()
                require(proc.wait(timeout=self.timeout) == 0, "SQLite helper exit refused")
                with selectors.DefaultSelector() as selector:
                    selector.register(proc.stdout, selectors.EVENT_READ)
                    require(not self.buffer and selector.select(self.timeout)
                            and os.read(proc.stdout.fileno(), 1) == b"", "SQLite helper output/EOF refused")
        except BaseException as error:
            errors.append(error)
        finally:
            try:
                if self.copier is not None and self.copier.poll() is None:
                    self.copier.kill(); self.copier.wait(timeout=self.timeout)
            except BaseException as error: errors.append(error)
            if self.copier is not None and self.copier.stdin is not None:
                try: self.copier.stdin.close()
                except BrokenPipeError: pass
                except BaseException as error: errors.append(error)
            try:
                if proc.poll() is None:
                    proc.kill(); proc.wait(timeout=self.timeout)
            except BaseException as error: errors.append(error)
            for stream in (proc.stdin, proc.stdout):
                try: stream.close()
                except BaseException as error: errors.append(error)
            self.process = None
            if self.copier is None or self.copier.poll() is not None:
                try: self._scratch_cleanup()
                except BaseException as error: errors.append(error)
        if errors: raise errors[0]

    def __exit__(self, kind, value, traceback):
        self._cleanup(kind is None)


if __name__ == "__main__":
    require(len(sys.argv) in (4, 5) and sys.argv[1] in ("reader", "copy") and sys.argv[3].isdigit(), "Only fixed helper modes are supported")
    uid = int(sys.argv[3])
    if sys.argv[1] == "reader":
        require(len(sys.argv) == 4, "Reader arguments refused")
        child(Path(sys.argv[2]), uid)
    else:
        require(len(sys.argv) == 5 and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == uid,
                "Synthetic copy UID/GID required")
        path = Path(sys.argv[2])
        require(path.is_absolute() and path.name == "tauri_localhost_0.localstorage", "Unexpected database path")
        raw = sys.stdin.buffer.readline(66)
        require(len(raw) == 65 and raw.endswith(b"\n") and all(c in b"0123456789abcdef" for c in raw[:-1]),
                "Copy digest request refused")
        independent_digest(path, uid, raw[:-1].decode("ascii"), Path(sys.argv[4]))
