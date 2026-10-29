"""Disposable WebKitGTK localStorage checkpoint experiment; never opens real HOME."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

DB = "tauri_localhost_0.localstorage"
LIMIT = 8 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def webkit(root):
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2
    manager = WebKit2.WebsiteDataManager(base_data_directory=str(root / "data"), base_cache_directory=str(root / "cache"))
    context = WebKit2.WebContext.new_with_website_data_manager(manager)
    security = context.get_security_manager()
    security.register_uri_scheme_as_local("tauri")
    security.register_uri_scheme_as_secure("tauri")
    view = WebKit2.WebView.new_with_context(context)
    window = Gtk.Window(); window.add(view); window.show_all()
    view.load_html("<script>try{localStorage.setItem('fixture-preference','preserved-synthetic-value');"
                   "localStorage.setItem('fixture-second','second-synthetic-value');document.title='FIXTURE_OK'"
                   "}catch(e){document.title='FIXTURE_ERROR:'+e}</script>", "tauri://localhost/")
    start = time.monotonic()
    def poll():
        paths = list((root / "data").rglob("*.localstorage"))
        if len(paths) == 1 and view.get_title() == "FIXTURE_OK":
            path = paths[0]
            if path.name == DB and all(Path(str(path) + s).is_file() for s in ("-wal", "-shm")):
                print(json.dumps({"ready": str(path.relative_to(root)), "pid": os.getpid()}), flush=True)
                return False
        if time.monotonic() - start > 25:
            print(json.dumps({"error": "readiness", "title": view.get_title(),
                              "paths": [str(p.relative_to(root)) for p in paths]}), flush=True)
            Gtk.main_quit(); return False
        return True
    def stop(source, condition):
        sys.stdin.readline()
        Gtk.main_quit()
        return False
    GLib.timeout_add(100, poll)
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, stop)
    Gtk.main(); window.destroy()


def actor(path):
    con = sqlite3.connect(path, timeout=3)
    print("ready " + str(os.getpid()), flush=True)
    for line in sys.stdin:
        if line.strip() == "change":
            con.execute("UPDATE ItemTable SET value=? WHERE key=?", (b"synthetic-changed", "fixture-preference"))
            con.commit(); print("changed", flush=True)
        elif line.strip() == "quit":
            break
        else:
            raise RuntimeError("unknown actor command")
    con.close()


def file_state(path, *, content=True):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and
            stat.S_IMODE(st.st_mode) & 0o077 == 0 and st.st_size <= LIMIT, "file ownership/shape refused")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        f = os.fstat(fd)
        def stamp(x):
            return (x.st_dev, x.st_ino, x.st_mode, x.st_uid, x.st_gid, x.st_nlink, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
        require(stamp(st) == stamp(f), "file changed at open")
        raw = b""
        if content:
            while len(raw) <= LIMIT:
                chunk = os.read(fd, 65536)
                if not chunk: break
                raw += chunk
            require(len(raw) == st.st_size, "file read size refused")
        require(stamp(os.fstat(fd)) == stamp(st) == stamp(path.lstat()), "file changed while reading")
        return {"stamp": stamp(st), "sha256": hashlib.sha256(raw).hexdigest() if content else None}
    finally:
        os.close(fd)


def inventory(directory):
    require(directory.is_dir() and not directory.is_symlink() and directory.resolve() == directory,
            "storage directory identity refused")
    names = {p.name for p in directory.iterdir()}
    require(names == {DB, DB + "-wal", DB + "-shm"}, "unknown/missing storage file")
    return {name: file_state(directory / name, content=name != DB + "-shm") for name in sorted(names)}


def snapshot(db, concurrent=None):
    before = inventory(db.parent)
    source = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=0)
    target = sqlite3.connect(":memory:")
    try:
        source.execute("PRAGMA query_only=ON")
        source.execute("PRAGMA trusted_schema=OFF")
        deadline = time.monotonic() + 5
        fired = False
        def progress(status, remaining, total):
            nonlocal fired
            require(time.monotonic() < deadline, "backup deadline")
            if concurrent is not None and not fired:
                fired = True; concurrent()
        source.backup(target, pages=1, progress=progress, sleep=0)
        require(target.execute("PRAGMA quick_check").fetchall() == [("ok",)], "integrity refused")
        schema = target.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
        require(all(r[0] in ("table", "index") and r[2] == "ItemTable" for r in schema), "unknown schema")
        columns = target.execute("PRAGMA table_info(ItemTable)").fetchall()
        rows = target.execute("SELECT key,value FROM ItemTable ORDER BY key").fetchall()
        require(len(rows) == 2 and all(type(k) is str and type(v) is bytes for k, v in rows), "unknown rows")
        logical = {"schema": schema, "columns": columns, "rows": [[k, v.hex()] for k, v in rows]}
    finally:
        target.close(); source.close()
    after = inventory(db.parent)
    for name in before:
        if name == DB + "-shm":
            require(before[name]["stamp"][:7] == after[name]["stamp"][:7], "SHM identity changed")
        else:
            require(before[name] == after[name], "database or WAL drift")
    return {"files": before, "logical": logical}


def stop(proc):
    if proc.poll() is None:
        try:
            proc.stdin.write("quit\n"); proc.stdin.flush(); proc.communicate(timeout=10)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            proc.kill(); proc.communicate(timeout=5)
    else:
        proc.communicate(timeout=5)


def main():
    with tempfile.TemporaryDirectory(prefix="webkit-checkpoint-synthetic-") as tmp:
        root = Path(tmp).resolve()
        web = subprocess.Popen([sys.executable, "-I", "-B", __file__, "webkit", str(root)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        writer = None
        try:
            ready = json.loads(web.stdout.readline())
            require("ready" in ready and ready["pid"] == web.pid, "WebKit fixture not ready: " + str(ready))
            db = root / ready["ready"]
            require(db.name == DB and db.resolve().is_relative_to(root), "unexpected DB identity")
            baseline = snapshot(db)
            second = snapshot(db)
            require(baseline == second, "unchanged checkpoint mismatch")
            print(json.dumps({"checkpoint": "unchanged", "relativePath": ready["ready"], "snapshot": baseline}, sort_keys=True), flush=True)
            writer = subprocess.Popen([sys.executable, "-I", "-B", __file__, "actor", str(db)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            require(writer.stdout.readline().strip() == "ready " + str(writer.pid) and writer.pid != os.getpid(), "writer binding")
            def mutate():
                writer.stdin.write("change\n"); writer.stdin.flush()
                require(writer.stdout.readline().strip() == "changed", "writer commit unproven")
            try:
                snapshot(db, concurrent=mutate)
                raise AssertionError("concurrent commit was accepted")
            except RuntimeError as e:
                require(str(e) == "database or WAL drift", "unexpected refusal: " + str(e))
                print(json.dumps({"checkpoint": "concurrent-commit", "refusal": str(e), "writerPid": writer.pid}), flush=True)
            after = snapshot(db)
            require(after["logical"] != baseline["logical"], "committed change missing")
            require(after["files"][DB] == baseline["files"][DB], "main database changed across checkpoints")
            print(json.dumps({"checkpoint": "after-commit", "logicalChanged": True,
                              "mainIdentityAndBytesUnchanged": True, "snapshot": after}, sort_keys=True), flush=True)
            unknown = db.parent / "unknown-fixture-file"
            unknown.write_bytes(b"synthetic")
            try:
                try: snapshot(db); raise AssertionError("unknown file accepted")
                except RuntimeError as e: require(str(e) == "unknown/missing storage file", "wrong unknown-file refusal")
            finally: unknown.unlink()
            print(json.dumps({"checkpoint": "unknown-file", "refused": True}), flush=True)
        finally:
            if writer is not None: stop(writer)
            stop(web)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "webkit": webkit(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "actor": actor(sys.argv[2])
    else: main()
