"""Linux-only disposable two-process WAL tests. No real HOME is accessed."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

fixture_path = Path(__file__).with_name("two-phase.test.py")
if not fixture_path.exists():
    fixture_path = Path(__file__).parent.parent / "journal-sqlite-two-phase-74" / "two-phase.test.py"
spec = importlib.util.spec_from_file_location("synthetic_two_phase", fixture_path)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def writer(path):
    db = sqlite3.connect(path, timeout=3)
    assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
    db.execute("PRAGMA wal_autocheckpoint=0")
    db.execute("SELECT * FROM ItemTable").fetchall()
    print("ready " + str(os.getpid()), flush=True)
    for line in sys.stdin:
        if line.strip() == "commit":
            db.execute("UPDATE ItemTable SET value=?", (b"changed",))
            db.commit()
            print("committed", flush=True)
        elif line.strip() == "quit":
            break
        else:
            raise RuntimeError("unknown fixture command")
    db.close()


@unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux POSIX behavior")
class DistinctProcess(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="distinct-synthetic-home-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.uid = os.getuid()
        self.db = self.root / fixture.DB
        other = self.root / fixture.OTHER
        other.write_bytes(b"synthetic-protected-settings")
        os.chmod(other, 0o600)
        conn = sqlite3.connect(self.db)
        conn.execute(fixture.TABLE)
        conn.execute("INSERT INTO ItemTable VALUES (?, ?)", ("synthetic.preference", b"preserved"))
        conn.commit()
        conn.close()
        os.chmod(self.db, 0o600)
        self.baseline = fixture.capture(self.root, "baseline", uid=self.uid, quiescent=True)
        self.proc = subprocess.Popen([sys.executable, "-I", "-S", "-B", __file__, "--writer", str(self.db)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop)
        ready = self.proc.stdout.readline().strip().split()
        self.assertEqual(ready, ["ready", str(self.proc.pid)])
        self.assertNotEqual(self.proc.pid, os.getpid())

    def stop(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write("quit\n"); self.proc.stdin.flush()
                self.proc.communicate(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.proc.kill(); self.proc.communicate(timeout=5)
        else:
            self.proc.communicate(timeout=5)

    def commit(self):
        self.proc.stdin.write("commit\n"); self.proc.stdin.flush()
        self.assertEqual(self.proc.stdout.readline().strip(), "committed")

    def test_distinct_process_wal_commit_is_included_and_refused(self):
        fixture.verify(self.root, "active", self.baseline, uid=self.uid)
        self.commit()
        with self.assertRaisesRegex(RuntimeError, "effective settings"):
            fixture.verify(self.root, "active", self.baseline, uid=self.uid)

    def test_distinct_process_commit_during_backup_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "protected source drift"):
            fixture.capture(self.root, "active", uid=self.uid, concurrent=self.commit)

    def test_real_wal_path_replacement_during_backup_is_refused(self):
        wal = self.root / (fixture.DB + "-wal")
        before = wal.stat()
        with tempfile.TemporaryDirectory(prefix="distinct-replacement-") as external:
            replacement = Path(external) / "wal"
            replacement.write_bytes(wal.read_bytes())
            os.chmod(replacement, 0o600)
            replaced = []
            def replace():
                os.replace(replacement, wal)
                self.assertNotEqual(before.st_ino, wal.stat().st_ino)
                replaced.append(True)
            with self.assertRaises((RuntimeError, sqlite3.DatabaseError)) as refusal:
                fixture.capture(self.root, "active", uid=self.uid, concurrent=replace)
            self.assertEqual(replaced, [True], "replacement must actually occur during backup")
            if isinstance(refusal.exception, RuntimeError):
                self.assertIn("protected source drift", str(refusal.exception))
            print("actual WAL replacement refused:", type(refusal.exception).__name__, str(refusal.exception), flush=True)

    def test_success_does_not_prevent_later_distinct_process_commit(self):
        fixture.verify(self.root, "active", self.baseline, uid=self.uid)
        self.commit()
        with self.assertRaisesRegex(RuntimeError, "effective settings"):
            fixture.verify(self.root, "active", self.baseline, uid=self.uid)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--writer":
        writer(sys.argv[2])
    else:
        unittest.main(verbosity=2)
