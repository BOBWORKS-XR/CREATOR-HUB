"""Pure unit fixtures only; no Hub, router, credentials or device execution."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


M = load("update_mcp_fixture_tested", "native-linux-update-mcp.py")
MIG = load("update_mcp_migration_reuse", "native-linux-production-016-migration.py")
READ = MIG.read_file


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(pid, image):
    return {"pid": pid, "parentPid": os.getpid(), "startTime": str(pid * 10),
            "uids": [MIG.UID] * 4, "kernelImageSha256": image}


class RouteFiles:
    def __init__(self, home):
        self.home = home
        self.files = {name: ("synthetic-not-executable:" + name).encode() for name in M.MODULE_FILES}
        module = {"executable": "mcp/creator-works-mcp-launcher", "version": "2.7.7",
                  "files": {name: sha(raw) for name, raw in sorted(self.files.items())}}
        canonical = json.dumps(module, separators=(",", ":"), ensure_ascii=False).encode()
        generation = sha(canonical)
        descriptor = json.dumps({"schemaVersion": 1, "product": "com.creatorworks.hub.mcp-runtime",
                                 "hubVersion": "0.1.16", "platform": "linux", "arch": "x86_64", "module": module}).encode()
        router = b"synthetic-not-executable:router"
        self.resources = {**module["files"], "routing/runtime.json": sha(descriptor),
                          "routing/runtime.minisig": sha(b"runtime-test-signature"),
                          "routing/router.json": sha(json.dumps({"sha256": sha(router)}).encode()),
                          "routing/router.minisig": sha(b"router-test-signature"),
                          "routing/creator-hub-mcp-router": sha(router)}
        self.command = home / M.ROUTE_BASE / "router-v1/creator-hub-mcp-router"
        base = home / M.ROUTE_BASE
        values = {base / "active.json": json.dumps({"schemaVersion": 1, "descriptorSha256": sha(descriptor), "generation": generation}).encode(),
                  base / "descriptors" / sha(descriptor) / "runtime.json": descriptor,
                  base / "descriptors" / sha(descriptor) / "runtime.minisig": b"runtime-test-signature",
                  self.command: router, self.command.parent / "router.json": json.dumps({"sha256": sha(router)}).encode(),
                  self.command.parent / "router.minisig": b"router-test-signature"}
        for name, raw in self.files.items():
            values[home / "data/creator-hub/runtime-generations/linux-x86_64" / generation / name] = raw
        for file, raw in values.items():
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(raw)
        self.server = home / "data/creator-hub/runtime-generations/linux-x86_64" / generation / "mcp/server/creator-works-mcp.mjs"


class FakeConnection:
    def __init__(self, route, pid=101):
        self.runtime_identity = identity(pid, route.binding["resourceFiles"]["routing/creator-hub-mcp-router"])
        self.child_identity = identity(pid + 1, route.binding["resourceFiles"]["mcp/server/runtime/node"])
        self.records = {pid: copy.deepcopy(self.runtime_identity), pid + 1: copy.deepcopy(self.child_identity)}
        self.runtime, self.child = SimpleNamespace(pid=pid), SimpleNamespace(pid=pid + 1)
        self.native = SimpleNamespace(native_process=lambda value, _: copy.deepcopy(self.records[value]))
        self.closed, self.count = False, 1
        self.handshake = {"ready": True, "server": M.SERVER}
        self.answer = None

    def alive(self):
        if self.closed:
            raise RuntimeError("Connection is not live")

    def check(self):
        self.alive()
        self.count += 1
        return self.answer if self.answer is not None else {"checked": True, "checks": self.count,
                                                           "tools": M.TOOLS, "signalsRequested": False}

    def close(self):
        self.closed = True


class FixtureBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.route_files = RouteFiles(self.home)
        # OS owner/mode enforcement is native acceptance; these files are unit-only data.
        self.reader = patch.object(MIG, "read_file", lambda p, limit=262144, **kw: READ(p, limit))
        self.reader.start(); self.addCleanup(self.reader.stop)
        self.verify = Mock(return_value=None)
        self.route = M.BoundRoute(MIG, self.home, self.route_files.resources, self.verify)
        for name in ("unrelated/keep.json", "config/client.json"):
            file = self.home / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(b"unchanged\r\n")
        self.evidence = self.home / "evidence"; self.evidence.mkdir()
        self.env = {"HOME": str(self.home), "XDG_DATA_HOME": str(self.home / "data"),
                    "XDG_CONFIG_HOME": str(self.home / "config"), "CREATOR_WORKS_TOOL_GROUPS": "none",
                    "CREATOR_WORKS_CONFIG_OWNER": "creator-hub-v1"}
        self.fixture = M.McpFixture(self.route, self.evidence, self.env,
                                    ["unrelated/keep.json", "config/client.json"], None, None, None)
        self.original, self.next = FakeConnection(self.route), FakeConnection(self.route, 201)
        self.connect = patch.object(M, "_connect", side_effect=[self.original, self.next]).start()
        self.addCleanup(patch.stopall)

    def through_update(self):
        self.fixture.start(); self.fixture.check("after-update"); self.fixture.check("after-hub-close")


class FixtureTests(FixtureBase):
    def test_real_protocol_phase_records_reconnect_then_eof_without_changing_files(self):
        before = (self.home / "unrelated/keep.json").read_bytes()
        self.through_update()
        self.fixture.reconnect()
        self.assertFalse(self.original.closed)
        self.assertTrue(self.next.closed)
        receipt = self.fixture.close()
        self.assertEqual([row["phase"] for row in receipt["checks"]], list(M.PHASES))
        self.assertEqual(receipt["protectedBefore"], receipt["protectedAfter"])
        self.assertEqual(receipt["reconnect"]["command"], str(self.route.command))
        self.assertFalse(receipt["releaseReady"])
        self.assertFalse(receipt["liveAiAccepted"])
        self.assertEqual((self.home / "unrelated/keep.json").read_bytes(), before)

    def test_eof_liveness_or_non_mcp_responses_cannot_pass(self):
        for answer in ({"eofSent": True}, {"checked": True}, {"checked": True, "checks": 2, "tools": [], "signalsRequested": False},
                       {"checked": True, "checks": True, "tools": M.TOOLS, "signalsRequested": False},
                       {"checked": True, "checks": 2, "tools": M.TOOLS, "signalsRequested": False, "extra": True}):
            with self.subTest(answer=answer), self.assertRaises(RuntimeError):
                M._protocol(answer, 2)

    def test_bad_original_router_or_sdk_identity_stops_before_protocol_request(self):
        self.fixture.start()
        for pid, field, bad in ((101, "startTime", "reused"), (101, "kernelImageSha256", "a" * 64),
                                (101, "uids", [0] * 4), (102, "parentPid", 999), (102, "kernelImageSha256", "b" * 64)):
            previous = copy.deepcopy(self.original.records[pid])
            self.original.records[pid][field] = bad
            count = self.original.count
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.fixture.check("after-update")
            self.assertEqual(self.original.count, count)
            self.original.records[pid] = previous

    def test_reconnect_failure_does_not_close_existing_connection_or_allow_retry(self):
        self.through_update()
        self.next.answer = {"eofSent": True}
        with self.assertRaises(RuntimeError): self.fixture.reconnect()
        self.assertFalse(self.original.closed)
        with self.assertRaises(RuntimeError): self.fixture.reconnect()
        with self.assertRaises(RuntimeError): self.fixture.close()
        self.assertEqual(self.connect.call_count, 2)

    def test_failed_spawn_is_spent_without_retry(self):
        self.connect.side_effect = RuntimeError("spawn failed")
        with self.assertRaises(RuntimeError): self.fixture.start()
        with self.assertRaises(RuntimeError): self.fixture.start()
        self.assertEqual(self.connect.call_count, 1)

    def test_unrelated_file_change_refuses_before_next_mcp_command(self):
        self.fixture.start()
        (self.home / "unrelated/keep.json").write_bytes(b"external change")
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")
        self.assertEqual(self.original.count, 2)
        self.assertEqual((self.home / "unrelated/keep.json").read_bytes(), b"external change")

    def test_same_router_changed_bytes_or_path_is_not_adopted_on_reconnect(self):
        self.through_update()
        self.route.command.write_bytes(b"another router")
        with self.assertRaises(RuntimeError): self.fixture.reconnect()
        self.assertEqual(self.connect.call_count, 1)
        self.assertFalse(self.original.closed)

    def test_signature_refusal_and_boolean_approval_never_authorize_route(self):
        for verifier in (Mock(side_effect=RuntimeError("invalid signature")), Mock(return_value=True)):
            with self.assertRaises(RuntimeError):
                M.BoundRoute(MIG, self.home, self.route_files.resources, verifier)

    def test_route_inventory_missing_extra_or_wrong_hash_refuses(self):
        for kind in ("missing", "extra", "wrong"):
            pins = dict(self.route_files.resources)
            if kind == "missing": del pins["routing/runtime.json"]
            elif kind == "extra": pins["unknown"] = "a" * 64
            else: pins["routing/creator-hub-mcp-router"] = "a" * 64
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                M.BoundRoute(MIG, self.home, pins, self.verify)

    def test_runtime_override_or_wrong_native_home_refuses_before_spawn(self):
        for key, value in (("NODE_OPTIONS", "--require=evil"), ("NODE_PATH", "evil"), ("LD_PRELOAD", "evil"),
                           ("LD_LIBRARY_PATH", "evil"), ("HOME", str(self.home / "other")), ("CREATOR_WORKS_TOOL_GROUPS", "all")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.McpFixture(self.route, self.evidence, {**self.env, key: value}, ["unrelated/keep.json"], None, None, None)
        self.connect.assert_not_called()

    def test_wrong_phase_repeated_checks_and_early_close_cannot_qualify(self):
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")
        self.fixture.start()
        with self.assertRaises(RuntimeError): self.fixture.check("before-update")
        with self.assertRaises(RuntimeError): self.fixture.close()
        self.assertFalse(self.original.closed)

    def test_returned_records_cannot_mutate_retained_baseline(self):
        record = self.fixture.start(); record["router"]["pid"] = 0
        self.assertEqual(self.fixture.checks[0]["router"]["pid"], 101)

    def test_eof_sentinel_cannot_replace_initial_sdk_handshake(self):
        self.original.handshake = {"eofSent": True, "ended": True}
        with self.assertRaises(RuntimeError): self.fixture.start()
        with self.assertRaises(RuntimeError): self.fixture.start()

    def test_reconnect_new_process_identity_is_checked_and_original_survives(self):
        self.through_update()
        self.next.records[201]["kernelImageSha256"] = "f" * 64
        with self.assertRaises(RuntimeError): self.fixture.reconnect()
        self.assertFalse(self.original.closed)
        self.assertIsNone(self.fixture.reconnected)

    def test_reconnect_cannot_adopt_original_connection(self):
        self.through_update()
        self.connect.side_effect = [self.original]
        with self.assertRaises(RuntimeError): self.fixture.reconnect()
        self.assertFalse(self.original.closed)


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        fixture = RouteFiles(self.root / "data-fixture")
        self.source = self.root / "source"; self.source.mkdir()
        self.home = self.root / "target-home"; (self.home / "data").mkdir(parents=True)
        (self.home / "unrelated.txt").write_bytes(b"preserve-exactly")
        self.pins = fixture.resources
        for name, raw in fixture.files.items():
            target = self.source / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(raw)
        for name in ("creator-hub-mcp-router", "router.json", "router.minisig"):
            target = self.source / "routing" / name; target.parent.mkdir(exist_ok=True)
            target.write_bytes((fixture.command.parent / name).read_bytes())
        for name in ("runtime.json", "runtime.minisig"):
            original = fixture.home / M.ROUTE_BASE / "descriptors" / self.pins["routing/runtime.json"] / name
            (self.source / "routing" / name).write_bytes(original.read_bytes())
        self.addCleanup(patch.stopall)
        patch.object(MIG, "read_file", lambda p, limit=262144, **kw: READ(p, limit)).start()
        patch.object(M, "_fixture_session", return_value=None).start()
        patch.object(M.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True).start()

    def seed(self, verifier=lambda *_: None):
        return M.prepare_existing_route(MIG, self.home, self.source, self.pins, verifier)

    def test_seed_copies_only_signed_fixture_bytes_and_real_router_rechecks_them(self):
        route = self.seed()
        self.assertEqual(route.binding["resourceFiles"], self.pins)
        self.assertEqual(route.command.read_bytes(), (self.source / "routing/creator-hub-mcp-router").read_bytes())
        self.assertEqual((self.home / "unrelated.txt").read_bytes(), b"preserve-exactly")
        self.assertFalse(any(self.home.rglob("*.bak")))
        with self.assertRaises(RuntimeError): self.seed()

    def test_invalid_signature_or_changed_source_never_creates_store(self):
        def refuse(*_): raise RuntimeError("bad signature")
        with self.assertRaises(RuntimeError): self.seed(refuse)
        self.assertFalse((self.home / "data/creator-hub").exists())
        def change(*_): (self.source / "mcp/server/runtime/node").write_bytes(b"changed")
        with self.assertRaises(RuntimeError): self.seed(change)
        self.assertFalse((self.home / "data/creator-hub").exists())

    def test_foreign_existing_fixture_is_not_adopted_or_deleted(self):
        base = self.home / "data/creator-hub"; base.mkdir(); (base / "foreign").write_bytes(b"keep")
        with self.assertRaises(RuntimeError): self.seed()
        self.assertEqual((base / "foreign").read_bytes(), b"keep")

    def test_real_seed_admission_refuses_this_non_native_non_fixture_path(self):
        with self.assertRaises(RuntimeError): ORIGINAL_SEED_ADMISSION(self.home, MIG)


class AdapterTests(FixtureBase):
    def adapter(self, ready=None, bad_image=None):
        processes = []
        class Stream(io.BytesIO):
            next_fd = 10
            def __init__(self):
                super().__init__()
                self.fd = Stream.next_fd; Stream.next_fd += 1
            def fileno(self): return self.fd
        def popen(argv, **kwargs):
            pid = 301 + len(processes)
            process = SimpleNamespace(pid=pid, stdin=Stream(), stdout=Stream(), stderr=Stream())
            processes.append((argv, kwargs, process))
            return process
        def observed(pid, _):
            digest = self.route.binding["resourceFiles"]["routing/creator-hub-mcp-router" if pid == 301 else "mcp/server/runtime/node"]
            return identity(pid, "f" * 64 if pid == bad_image else digest)
        native = SimpleNamespace(native_process=observed, Capture=Mock())
        staged_reader = MIG.read_file
        def read(p, *args, **kw):
            if p.as_posix().endswith("/sdk/package-lock.json"):
                # Reproduce the original LF bytes staged by the Linux checkout;
                # the local Windows worktree may have Git's CRLF conversion.
                return (HERE.parent / "modules/mcp/package-lock.json").read_text(encoding="utf-8").encode()
            return staged_reader(p, *args, **kw)
        with patch.object(M, "_connect", ORIGINAL_CONNECT), \
             patch.object(MIG, "read_file", side_effect=read), \
             patch.object(M.subprocess, "Popen", side_effect=popen), \
             patch.object(M.os, "pidfd_open", return_value=9, create=True), \
             patch.object(MIG.SDK, "response", return_value=ready), \
             patch.object(MIG.SDK, "check", return_value={"checked": True, "checks": 1, "tools": M.TOOLS, "signalsRequested": False}):
            result = M._connect(self.route, self.evidence, self.env, None, None, native)
        return result, processes

    def test_adapter_uses_exact_migration_sdk_and_verified_node_not_python_sentinel(self):
        result, processes = self.adapter({"ready": True, "server": M.SERVER})
        self.assertEqual(processes[0][0], [str(self.route.command)])
        self.assertEqual(processes[1][0][:3], [str(self.route.node), "-e", MIG.SDK_JS])
        self.assertEqual(processes[1][1]["pass_fds"], [10, 11, 12])
        self.assertIsInstance(result, MIG.SDK)

    def test_adapter_rejects_eof_wrong_server_version_and_extra_ready_fields(self):
        for ready in (None, {"ready": True}, {"ready": True, "server": {"name": "not-mcp", "version": "2.7.7"}},
                      {"ready": True, "server": {"name": "creator-works-mcp", "version": "0"}},
                      {"ready": True, "server": M.SERVER, "eofSent": True}):
            with self.subTest(ready=ready), self.assertRaises(RuntimeError): self.adapter(ready)

    def test_adapter_refuses_wrong_router_or_sdk_kernel_image(self):
        for pid in (301, 302):
            with self.subTest(pid=pid), self.assertRaises(RuntimeError): self.adapter({"ready": True, "server": M.SERVER}, pid)


ORIGINAL_CONNECT = M._connect
ORIGINAL_SEED_ADMISSION = M._fixture_session


if __name__ == "__main__":
    unittest.main()
