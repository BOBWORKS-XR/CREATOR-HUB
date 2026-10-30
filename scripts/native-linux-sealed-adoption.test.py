"""Root-only disposable test of the actual changed broker/adoption sealing order."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sealed_adoption_controller", HERE / "native-linux-migrated-update.py")
C = importlib.util.module_from_spec(spec); sys.modules[spec.name] = C; spec.loader.exec_module(C)


def diagnose_existing_baseline(value, message):
    if not value and message == "Existing baseline HOME drift":
        scope = sys._getframe(1).f_locals
        before, first = scope["baseline"], scope["first"]
        names = (C._LOCAL_DB, C._LOCAL_WAL, C._LOCAL_SHM)
        result = {"membership": set(first) == set(before),
                  "main": first.get(names[0]) == before.get(names[0]),
                  "wal": first.get(names[1]) == before.get(names[1]),
                  "other": all(first.get(k) == row for k, row in before.items() if k not in names),
                  "shmIdentity": scope["identities"][names[2]] == C.localstorage_identity(before[names[2]], names[2]),
                  "shmNormalized": scope["shm_digest"] == scope["baseline_shm"]}
        print("EXISTING_BASELINE_DIAGNOSTIC " + json.dumps(result, sort_keys=True), flush=True)
    return C.U.require(value, message)


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root runner")
class SealedAdoption(unittest.TestCase):
    def test_actual_broker_adopts_with_uid_inaccessible_workspace(self):
        self.adopt_fixture(existing=False)

    def test_actual_broker_adopts_committed_wal_as_synthetic_uid(self):
        self.adopt_fixture(existing=True)

    def adopt_fixture(self, existing):
        uid = C.M.UID
        self.assertEqual(uid, 21314)
        with tempfile.TemporaryDirectory(prefix="sealed-adoption-", dir="/") as temp, ExitStack() as stack:
            if existing: stack.enter_context(patch.object(C, "require", new=diagnose_existing_baseline))
            root = Path(temp).resolve(); os.chmod(root, 0o755)
            workspace = root / "workspace"; workspace.mkdir(mode=0o700)
            source = workspace / "scripts"; source.mkdir(mode=0o755)
            pins = {}
            for name in C.changed_sources():
                raw = (HERE / name).read_bytes(); dest = source / name
                dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(raw); os.chmod(dest, 0o444)
                pins[name] = C.U.pin(raw)
            helper = source / "native-linux-localstorage-snapshot.py"
            probe = subprocess.run([sys.executable, "-I", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).read_bytes()", str(helper)],
                                   user=uid, group=uid, extra_groups=[], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            self.assertNotEqual(probe.returncode, 0, "synthetic UID must not read workspace helper")
            self.assertIn(b"PermissionError", probe.stderr)
            base = root / "fixture"; base.mkdir(mode=0o755)
            result = base / "result"; result.mkdir(mode=0o700); os.chown(result, uid, uid)
            home = result / "home"; home.mkdir(mode=0o700); os.chown(home, uid, uid)
            def owned(relative, raw):
                target = home / relative; target.parent.mkdir(parents=True, exist_ok=True)
                for parent in (target.parent, *target.parent.parents):
                    if parent == result: break
                    os.chown(parent, uid, uid); os.chmod(parent, 0o700)
                target.write_bytes(raw); os.chown(target, uid, uid); os.chmod(target, 0o600)
                return target
            encode = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
            journal_raw = encode({"revision": 1, "records": []})
            owned(C.M.JOURNAL, journal_raw)
            owned(C.U.PREFS, encode({"restoreHostedViews": False}))
            owned("data/CreatorHub/convergence/move-v1.json", encode({}))
            owned("config/client/.creator-hub-settings-backups/original.bak", b"synthetic")
            owned("data/creator-hub/client-migrations-v1/history.json", b"synthetic")
            db = owned(C._LOCAL_DB, b"")
            con = sqlite3.connect(db); con.execute("PRAGMA journal_mode=WAL")
            con.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)")
            con.execute("INSERT INTO ItemTable VALUES (?,?)", ("synthetic", b"original")); con.commit(); con.close()
            os.chown(db, uid, uid); os.chmod(db, 0o600)
            if existing:
                writer = "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE ItemTable SET value=? WHERE key='synthetic'\", (b'committed-in-wal',)); c.commit(); os._exit(0)"
                subprocess.run([sys.executable, "-I", "-S", "-c", writer, str(db)], user=uid, group=uid,
                               extra_groups=[], check=True, timeout=10)
                self.assertGreater(Path(str(db) + "-wal").stat().st_size, 0)
                main_only = sqlite3.connect(db.as_uri() + "?immutable=1", uri=True)
                try: self.assertEqual(main_only.execute("SELECT value FROM ItemTable WHERE key='synthetic'").fetchone(), (b"original",))
                finally: main_only.close()
            binding_raw = encode({"profile": {}})
            (base / "binding.json").write_bytes(binding_raw); os.chmod(base / "binding.json", 0o644)
            (base / "execution-request.json").write_bytes(encode({})); os.chmod(base / "execution-request.json", 0o644)
            (base / "broker.json").write_bytes(encode({})); os.chmod(base / "broker.json", 0o644)
            report = {"harnessSource": "a" * 40, "bindingSha256": C.U.pin(binding_raw)["sha256"],
                      "operationJournals": {"reopened": {"file": C.U.pin(journal_raw)}}}
            report_path = result / "report.json"; report_path.write_bytes(encode(report)); os.chown(report_path, uid, uid); os.chmod(report_path, 0o600)
            inputdir = root / "runner/native-linux-production-016-input"; inputdir.mkdir(parents=True)
            profile = inputdir / "profile.json"; profile.write_bytes(encode({}))
            original = {"context": {}, "sources": pins, "incoming": C.U.pin(profile.read_bytes())}
            control, output = base / "migrated-update", result / "migrated-update"
            for name, value in (("BASE", base), ("CONTROL", control), ("OUTPUT", output), ("HOME", home), ("HERE", source), ("TRANSACTIONS", ())):
                stack.enter_context(patch.object(C, name, value))
            stack.enter_context(patch.object(C.U, "TLS_CERT", root / "unused-cert"))
            stack.enter_context(patch.object(C, "changed_admission")); stack.enter_context(patch.object(C, "changed_intent", return_value=original))
            stack.enter_context(patch.object(C, "migration_gate")); stack.enter_context(patch.object(C, "changed_incoming_profile", return_value={}))
            stack.enter_context(patch.object(C.M, "check_request")); stack.enter_context(patch.object(C.M, "installed"))
            stack.enter_context(patch.object(C.M, "journal", return_value={"revision": 1, "records": []}))
            stack.enter_context(patch.object(C, "captured_reports", return_value={})); stack.enter_context(patch.object(C, "legacy_state", return_value={}))
            polkit = SimpleNamespace(fixture_credential=Mock(return_value="L"))
            stack.enter_context(patch.object(C.U, "load", side_effect=lambda name: {"native-linux-polkit-probe": polkit,
                "native-linux-root-probe": SimpleNamespace(), "native-unix-window": SimpleNamespace()}[name]))
            inventory = stack.enter_context(patch.object(C.M, "native_process_inventory", return_value={"processes": [], "terminalProcesses": []}))
            stack.enter_context(patch.object(C.U, "offline_verifier", side_effect=RuntimeError("fixture-stop-after-adopt")))
            stack.enter_context(patch.object(C.U, "tls_cleanup", return_value={}))
            env = {"GITHUB_WORKSPACE": str(workspace), "GITHUB_SHA": "a" * 40, "RUNNER_TEMP": str(root / "runner")}
            original_ancestry = C.U.protected_ancestry
            def ancestry_diagnostic(path):
                try:
                    return original_ancestry(path)
                except Exception:
                    for directory in (Path(path), *Path(path).parents):
                        info = directory.lstat()
                        print("ancestry", str(directory), info.st_uid, info.st_gid, oct(info.st_mode & 0o7777), flush=True)
                    raise
            stack.enter_context(patch.object(C.U, "protected_ancestry", side_effect=ancestry_diagnostic))
            with self.assertRaisesRegex(RuntimeError, "fixture-stop-after-adopt"): C.changed_broker(env)
            inventory.assert_called_once()
            sealed = control / "scripts/native-linux-localstorage-snapshot.py"
            self.assertEqual(sealed.stat().st_uid, 0); self.assertEqual(sealed.stat().st_mode & 0o777, 0o444)
            self.assertEqual(C.U.pin(sealed.read_bytes()), pins[sealed.name])
            record = json.loads((control / "broker.json").read_bytes())
            self.assertEqual(record["initialUidInventory"], {"processes": [], "terminalProcesses": []})
            self.assertEqual(record["refusal"]["message"], "fixture-stop-after-adopt")
            self.assertFalse(record["scenarioPassed"])


if __name__ == "__main__": unittest.main(verbosity=2)
