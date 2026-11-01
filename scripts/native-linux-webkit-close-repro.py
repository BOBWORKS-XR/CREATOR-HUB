"""Disposable WebKit WAL close/reopen observation; never opens a user HOME."""
import hashlib
import json
import os
from pathlib import Path
import select
import sqlite3
import subprocess
import sys
import tempfile
import time

NAME = "tauri_localhost_0.localstorage"


def emit(event, **data):
    print(json.dumps({"event": event, **data}, sort_keys=True), flush=True)


def webkit(root, seed):
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
    action = "localStorage.setItem('fixture-one','alpha');localStorage.setItem('fixture-two','beta');" if seed else ""
    html = "<script>try{" + action + "document.title=(localStorage.getItem('fixture-one')==='alpha'&&localStorage.getItem('fixture-two')==='beta')?'READY':'BAD'}catch(e){document.title='ERROR'}</script>"
    view.load_html(html, "tauri://localhost/")
    started = time.monotonic(); announced = False
    def poll():
        nonlocal announced
        paths = list((root / "data").rglob(NAME)) if (root / "data").exists() else []
        if not announced and len(paths) == 1 and view.get_title() == "READY" and all(Path(str(paths[0])+s).is_file() for s in ("-wal", "-shm")):
            announced = True; emit("webkit-ready", path=str(paths[0].relative_to(root)), pid=os.getpid()); return False
        if time.monotonic() - started > 30:
            emit("webkit-timeout", title=view.get_title(), count=len(paths)); Gtk.main_quit(); return False
        return True
    def stop(source, condition):
        sys.stdin.readline(); Gtk.main_quit(); return False
    GLib.timeout_add(100, poll); GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, stop)
    Gtk.main(); window.destroy()
    if not announced: raise RuntimeError("WebKit did not become ready")


def file_state(path):
    st = path.lstat()
    if not path.is_file() or path.is_symlink() or st.st_nlink != 1 or st.st_uid != os.getuid():
        raise RuntimeError("unexpected synthetic file identity")
    data = path.read_bytes(); end = path.lstat()
    fields = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_uid, x.st_gid, x.st_nlink, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
    if fields(st) != fields(end) or len(data) != st.st_size: raise RuntimeError("file changed during read")
    return {"dev": st.st_dev, "ino": st.st_ino, "mode": st.st_mode & 0o7777, "uid": st.st_uid, "gid": st.st_gid,
            "nlink": st.st_nlink, "size": st.st_size, "sha256": hashlib.sha256(data).hexdigest()}, data


def capture(db):
    names = [db, Path(str(db)+"-wal"), Path(str(db)+"-shm")]
    present = [p.is_file() for p in names]
    emit("presence", main=present[0], wal=present[1], shm=present[2])
    if not all(present): raise RuntimeError("required original main/WAL/SHM absent; no substitution")
    rows = [file_state(p) for p in names]
    return {"main": rows[0][0], "wal": rows[1][0], "shm": rows[2][0]}, rows[2][1]


def logical(db):
    source = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=3)
    dest = sqlite3.connect(":memory:")
    try:
        source.execute("PRAGMA query_only=ON"); source.execute("BEGIN")
        source.execute("SELECT count(*) FROM sqlite_schema").fetchone()
        source.backup(dest, pages=64, sleep=0.01)
        integrity = dest.execute("PRAGMA quick_check").fetchall()
        schema = dest.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
        rows = dest.execute("SELECT key,value FROM ItemTable ORDER BY key").fetchall()
        if integrity != [("ok",)] or sorted(k for k,v in rows) != ["fixture-one", "fixture-two"]: raise RuntimeError("synthetic rows not committed")
        return {"integrity": integrity, "schema": schema, "rows": [[k, bytes(v).hex()] for k,v in rows]}
    finally:
        dest.close(); source.close()


def start(root, seed):
    p = subprocess.Popen([sys.executable, "-I", "-B", __file__, "child", str(root), "seed" if seed else "reopen"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    if not select.select([p.stdout], [], [], 40)[0]:
        p.kill(); p.wait(timeout=5); raise RuntimeError("WebKit child deadline")
    line = p.stdout.readline(); event = json.loads(line)
    emit("child-event", value=event)
    if event.get("event") != "webkit-ready": p.kill(); p.wait(timeout=5); raise RuntimeError("WebKit readiness refused")
    return p, root / event["path"]


def stop(p):
    if p.poll() is None:
        try: p.communicate(input="close\n", timeout=15)
        except subprocess.TimeoutExpired: p.kill(); p.communicate(timeout=5); raise RuntimeError("WebKit close deadline")
    if p.returncode != 0: raise RuntimeError("WebKit child failed")


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "child":
        webkit(Path(sys.argv[2]), sys.argv[3] == "seed"); return
    emit("versions", sqlite=sqlite3.sqlite_version, python=sys.version.split()[0])
    if sqlite3.sqlite_version != "3.37.2": raise RuntimeError("SQLite version differs from pinned fixture version")
    with tempfile.TemporaryDirectory(prefix="webkit-close-repro-") as td:
        root = Path(td).resolve(); p = None
        try:
            p, db = start(root, True)
            deadline = time.monotonic() + 20
            while True:
                try: seeded = logical(db); break
                except RuntimeError:
                    if time.monotonic() >= deadline: raise
                    time.sleep(.2)
            emit("seed-logical", snapshot=seeded)
            stop(p); p = None
            baseline, shm_before = capture(db); emit("after-first-close", files=baseline)
            before = logical(db); preopen, shm_preopen = capture(db)
            emit("observer-close", files=preopen, main_equal=baseline["main"]==preopen["main"], wal_equal=baseline["wal"]==preopen["wal"],
                 shm_offsets=[i for i,(a,b) in enumerate(zip(shm_before,shm_preopen)) if a!=b])
            p, reopened_db = start(root, False)
            if reopened_db != db: raise RuntimeError("WebKit origin/database changed")
            reopened, shm_reopened = capture(db)
            emit("after-reopen-before-observer", files=reopened, main_equal=preopen["main"]==reopened["main"],
                 wal_equal=preopen["wal"]==reopened["wal"], shm_offsets=[i for i,(a,b) in enumerate(zip(shm_preopen,shm_reopened)) if a!=b])
            after = logical(db); post, shm_post = capture(db)
            emit("logical-comparison", before=before, after=after, equal=before==after, seed_equal=seeded==before,
                 main_equal=reopened["main"]==post["main"], wal_equal=reopened["wal"]==post["wal"],
                 shm_offsets=[i for i,(a,b) in enumerate(zip(shm_reopened,shm_post)) if a!=b])
            if before != after: raise RuntimeError("logical contents drift")
            stop(p); p = None
            emit("done", scope="standalone synthetic WebKit only")
        finally:
            if p is not None: stop(p)


if __name__ == "__main__":
    main()
