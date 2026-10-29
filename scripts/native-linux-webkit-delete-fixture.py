"""Standalone disposable WebKit/SQLite test. Never opens Creator Hub or user data."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time


def child(root, mode):
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2
    manager = WebKit2.WebsiteDataManager(base_data_directory=str(root / "data"), base_cache_directory=str(root / "cache"))
    context = WebKit2.WebContext.new_with_website_data_manager(manager)
    view = WebKit2.WebView.new_with_context(context)
    window = Gtk.Window(); window.add(view); window.show_all()
    action = "localStorage.setItem('fixture-preference','preserved-synthetic-value');" if mode == "seed" else ""
    page = "<html><head><script>try {" + action + "document.title=localStorage.getItem('fixture-preference') === 'preserved-synthetic-value' ? 'FIXTURE_OK' : 'FIXTURE_BAD';} catch(e) {document.title='FIXTURE_ERROR';}</script></head><body>fixture</body></html>"
    view.load_html(page, "http://127.0.0.1/")
    start = time.monotonic(); result = {}
    def poll():
        databases = list((root / "data").rglob("*.localstorage"))
        if len(databases) == 1 and view.get_title() == "FIXTURE_OK":
            db = databases[0]; raw = db.read_bytes()[:20]
            if len(raw) == 20 and raw[:16] == b"SQLite format 3\x00" and raw[18:20] == b"\x02\x02":
                files = [db.name + suffix for suffix in ("-wal", "-shm") if Path(str(db) + suffix).is_file()]
                if len(files) == 2:
                    result.update(title="FIXTURE_OK", headerWriteVersion=raw[18], headerReadVersion=raw[19],
                                  walPresent=True, shmPresent=True, dbRelative=db.relative_to(root).as_posix())
                    Gtk.main_quit(); return False
        if time.monotonic() - start > 20:
            result.update(error="timeout", title=view.get_title(), databases=len(databases)); Gtk.main_quit(); return False
        return True
    GLib.timeout_add(100, poll); Gtk.main(); window.destroy()
    print(json.dumps(result, sort_keys=True), flush=True)
    if "error" in result: raise RuntimeError("Standalone WebKit fixture did not reach expected state")


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "child":
        child(Path(sys.argv[2]), sys.argv[3]); return
    with tempfile.TemporaryDirectory(prefix="webkit-nonwal-fixture-") as temporary:
        root = Path(temporary).resolve()
        def launch(mode):
            result = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).resolve()), "child", str(root), mode],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, check=True)
            return json.loads(result.stdout)
        initial = launch("seed")
        db = root / initial["dbRelative"]
        assert db.is_relative_to(root) and db.is_file()
        connection = sqlite3.connect(db, timeout=10)
        try:
            before = connection.execute("SELECT key, value FROM ItemTable ORDER BY key").fetchall()
            assert len(before) == 1 and before[0][0] == "fixture-preference"
            assert connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower() == "delete"
            assert connection.execute("SELECT key, value FROM ItemTable ORDER BY key").fetchall() == before
        finally: connection.close()
        check = sqlite3.connect(db, timeout=10)
        try:
            offline_mode = check.execute("PRAGMA journal_mode").fetchone()[0].lower()
            assert offline_mode == "delete" and check.execute("SELECT key, value FROM ItemTable ORDER BY key").fetchall() == before
        finally: check.close()
        offline = db.read_bytes(); assert offline[:16] == b"SQLite format 3\x00" and offline[18:20] == b"\x01\x01"
        reopened = launch("read")
        assert reopened["dbRelative"] == initial["dbRelative"] and reopened["walPresent"] and reopened["shmPresent"]
        verify = sqlite3.connect(db, timeout=10)
        try:
            final_mode = verify.execute("PRAGMA journal_mode").fetchone()[0].lower()
            assert final_mode == "wal" and verify.execute("SELECT key, value FROM ItemTable ORDER BY key").fetchall() == before
        finally: verify.close()
        print(json.dumps({"scope": "standalone-disposable-webkit-only", "offlineMode": offline_mode,
                          "offlineDbSha256": hashlib.sha256(offline).hexdigest(), "reopenedMode": final_mode,
                          "preferencePreserved": True, "initial": initial, "reopened": reopened}, sort_keys=True))


if __name__ == "__main__":
    main()
