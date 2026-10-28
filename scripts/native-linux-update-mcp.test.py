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
        # Exact modes in the independently reviewed Linux payload archive.
        self.payload_modes = {
            "mcp/creator-works-mcp-launcher": 0o755,
            "mcp/server/creator-works-mcp.mjs": 0o644,
            "mcp/server/runtime/node": 0o755,
            "mcp/server/runtime/LICENSE": 0o644,
            "mcp/server/runtime/VERSION": 0o644,
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs": 0o644,
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png": 0o644,
            "mcp/server/LICENSE": 0o644,
            "mcp/server/THIRD_PARTY_NOTICES.md": 0o644,
        }
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
        if os.name == "nt":
            patch.object(M.os, "fchmod", return_value=None, create=True).start()

    def seed(self, verifier=lambda *_: None):
        return M.prepare_existing_route(MIG, self.home, self.source, self.pins, self.payload_modes, verifier)

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

    def test_generation_payload_modes_match_reviewed_archive_exactly(self):
        original_open = os.open
        with patch.object(M.os, "open", wraps=original_open) as opened:
            self.seed()
        generation_base = self.home / "data/creator-hub/runtime-generations/linux-x86_64"
        requested = {}
        for call in opened.call_args_list:
            if len(call.args) == 3 and call.args[1] & os.O_CREAT:
                target = Path(call.args[0])
                if generation_base in target.parents:
                    name = Path(*target.relative_to(generation_base).parts[1:]).as_posix()
                    requested[name] = call.args[2]
        self.assertEqual(requested, self.payload_modes)
        if os.name == "posix":
            files = [file for file in generation_base.rglob("*") if file.is_file()]
            self.assertEqual(len(files), len(self.payload_modes))
            for file in files:
                name = Path(*file.relative_to(generation_base).parts[1:]).as_posix()
                self.assertEqual(file.stat().st_mode & 0o7777, self.payload_modes[name])
            self.assertTrue(all(directory.stat().st_mode & 0o7777 == 0o700
                                for directory in generation_base.rglob("*") if directory.is_dir()))

    def test_mode_inventory_refuses_missing_extra_noninteger_or_unreviewed_bits_before_writes(self):
        for kind in ("missing", "extra", "bool", "writable", "readonly"):
            modes = dict(self.payload_modes)
            if kind == "missing": modes.pop("mcp/server/runtime/node")
            elif kind == "extra": modes["unrelated"] = 0o644
            else: modes["mcp/server/runtime/node"] = {"bool": True, "writable": 0o777, "readonly": 0o500}[kind]
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                M.prepare_existing_route(MIG, self.home, self.source, self.pins, modes, lambda *_: None)
            self.assertFalse((self.home / "data/creator-hub").exists())

    def test_exact_modes_are_applied_only_to_exclusively_created_held_file_descriptors(self):
        fchmod = os.fchmod
        with patch.object(M.os, "fchmod", wraps=fchmod) as set_mode:
            self.seed()
        self.assertEqual(len(set_mode.call_args_list), len(M.MODULE_FILES) + 6)
        self.assertEqual([call.args[1] for call in set_mode.call_args_list[:len(M.MODULE_FILES)]],
                         [self.payload_modes[name] for name in M.MODULE_FILES])
        self.assertTrue(all(type(call.args[0]) is int for call in set_mode.call_args_list))


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


class TransitionTests(FixtureBase):
    def setUp(self):
        super().setUp()
        target = tempfile.TemporaryDirectory()
        self.addCleanup(target.cleanup)
        self.source = Path(target.name).resolve()
        self.b_files = dict(self.route_files.files)
        self.b_files["mcp/server/creator-works-mcp.mjs"] += b":unit-only-B"
        module = {"executable": "mcp/creator-works-mcp-launcher", "version": "2.7.7",
                  "files": {name: sha(raw) for name, raw in sorted(self.b_files.items())}}
        self.b_generation = sha(json.dumps(module, separators=(",", ":"), ensure_ascii=False).encode())
        self.b_descriptor = json.dumps({"schemaVersion": 1, "product": "com.creatorworks.hub.mcp-runtime",
            "hubVersion": "0.1.17", "platform": "linux", "arch": "x86_64", "module": module}).encode()
        raw = dict(self.b_files)
        raw["routing/runtime.json"] = self.b_descriptor
        raw["routing/runtime.minisig"] = b"runtime-test-signature"
        for name in ("creator-hub-mcp-router", "router.json", "router.minisig"):
            raw["routing/" + name] = (self.route.command.parent / name).read_bytes()
        self.b_resources = {name: sha(body) for name, body in raw.items()}
        for name, body in raw.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        # Synthetic unit data with the existing mocked signature callback only.
        # These bytes/signatures are not real release artifacts or admission pins.
        self.release = json.dumps({"schemaVersion": 1, "appId": "creator-hub", "version": "0.1.17",
            "platform": "linux", "architecture": "x86_64", "packageType": "deb", "installerProtocol": 1,
            "executableSha256": sha(b"unit-only-root-B")}).encode()
        self.release_pair = (self.source / "release.json", self.source / "release.minisig")
        self.release_pair[0].write_bytes(self.release)
        self.release_pair[1].write_bytes(b"unit-only-release-signature")
        self.active = self.home / M.ROUTE_BASE / "active.json"
        self.old_active = self.active.read_bytes()
        self.handoff = self.home / "data/creator-hub-update-cache/deb/records/mcp-route-update.json"
        self.target = {"descriptorSha256": sha(self.b_descriptor), "generation": self.b_generation}
        self.ready = {"schemaVersion": 1, "fromVersion": "0.1.16", "installed": "/usr/bin/creator-hub",
                      "release": list(self.release), "signature": list(self.release_pair[1].read_bytes()),
                      "previous": list(self.old_active), "phase": "Ready"}
        self.completed = {**self.ready, "phase": {"Completed": self.target}}

    def make(self):
        self.transition = M.TransitionRoute(self.route, self.source, self.b_resources, self.release_pair)
        self.fixture = M.TransitionFixture(self.transition, self.evidence, self.env,
            ["unrelated/keep.json", "config/client.json"], None, None, None)

    def record(self, value):
        raw = json.dumps(value, separators=(",", ":")).encode()
        self.handoff.parent.mkdir(parents=True, exist_ok=True)
        self.handoff.write_bytes(raw)
        return raw

    def install_b(self, *, capture_ready=True):
        if capture_ready and hasattr(self, "transition") and self.transition.ready_capture is None:
            self.record(self.ready)
            self.ready_raw = bytes(self.transition.capture_ready()["raw"])
        base = self.home / "data/creator-hub/runtime-generations/linux-x86_64" / self.b_generation
        for name, body in self.b_files.items():
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        descriptor = self.home / M.ROUTE_BASE / "descriptors" / sha(self.b_descriptor)
        descriptor.mkdir(parents=True)
        (descriptor / "runtime.json").write_bytes(self.b_descriptor)
        (descriptor / "runtime.minisig").write_bytes(b"runtime-test-signature")
        history = self.home / M.ROUTE_BASE / "history" / (sha(self.old_active) + ".json")
        history.parent.mkdir()
        history.write_bytes(self.old_active)
        self.active.write_bytes(json.dumps({"schemaVersion": 1, **self.target}, separators=(",", ":")).encode())
        return self.record(self.completed)

    def complete(self):
        completed = self.install_b()
        return self.fixture.complete(self.ready_raw, completed)

    def test_legitimate_completed_edge_keeps_live_a_and_reconnects_b_without_seed_or_acceptance(self):
        self.make(); self.fixture.start()
        self.complete()
        self.fixture.check("after-update"); self.fixture.check("after-hub-close")
        self.fixture.reconnect()
        self.assertFalse(self.original.closed)
        receipt = self.fixture.close()
        self.assertEqual(receipt["scope"], "existing-managed-mcp-transition-contract-only")
        self.assertEqual(receipt["transition"]["inventories"],
                         {"a": self.route_files.resources, "b": self.b_resources})
        self.assertEqual(bytes(receipt["transition"]["handoff"]["ready"]),
                         json.dumps(self.ready, separators=(",", ":")).encode())
        self.assertEqual(bytes(receipt["transition"]["handoff"]["completed"]), self.handoff.read_bytes())
        self.assertEqual(self.transition.server.parent.parent.parent.name, self.b_generation)
        self.assertFalse(receipt["payloadSwapAccepted"])
        self.assertFalse(receipt["releaseReady"])

    def test_early_b_refuses_before_completed_and_before_next_protocol(self):
        self.make(); self.fixture.start(); self.install_b()
        with self.assertRaises(RuntimeError): self.transition.recheck()
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")
        self.assertEqual(self.original.count, 2)
        self.assertFalse(self.original.closed)

    def test_ready_or_attempting_is_not_completed_and_the_attempt_is_spent(self):
        self.make(); self.fixture.start(); self.install_b()
        raw = self.record({**self.completed, "phase": {"Attempting": self.target}})
        with self.assertRaises(RuntimeError):
            self.fixture.complete(self.ready_raw, raw)
        with self.assertRaises(RuntimeError):
            self.fixture.complete(self.ready_raw, self.record(self.completed))
        self.assertFalse(self.original.closed)

    def test_stale_cas_previous_cannot_authorize_a_to_b(self):
        self.make(); self.fixture.start(); self.install_b()
        raw = self.record({**self.completed, "previous": list(b"stale")})
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)

    def test_foreign_completed_target_cannot_adopt_actual_b(self):
        self.make(); self.fixture.start(); self.install_b()
        raw = self.record({**self.completed, "phase": {"Completed": {**self.target, "generation": "f" * 64}}})
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)

    def test_reverse_b_to_a_refuses_after_completed(self):
        self.make(); self.fixture.start(); self.complete()
        self.active.write_bytes(self.old_active)
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")

    def test_completed_bytes_must_be_the_actual_current_record(self):
        self.make(); self.fixture.start(); raw = self.install_b()
        self.record({**self.completed, "failure": "unknown"})
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)

    def test_changed_immutable_fields_and_failure_cannot_pass(self):
        self.make(); self.fixture.start(); self.install_b()
        raw = self.record({**self.completed, "fromVersion": "0.1.15", "failure": "unknown"})
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)

    def test_old_a_payload_identity_remains_immutable_after_completed(self):
        self.make(); self.fixture.start(); self.complete()
        self.route_files.server.write_bytes(b"changed old A")
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")

    def test_missing_old_history_refuses_without_retry_or_repair(self):
        self.make(); self.fixture.start(); self.install_b()
        (self.home / M.ROUTE_BASE / "history" / (sha(self.old_active) + ".json")).unlink()
        with self.assertRaises(FileNotFoundError):
            self.fixture.complete(self.ready_raw, self.handoff.read_bytes())
        self.assertFalse(self.original.closed)

    def test_signature_refusal_or_boolean_never_binds_target(self):
        self.route.verify_signature = Mock(side_effect=lambda body, sig: True if body.is_relative_to(self.source) else None)
        with self.assertRaises(RuntimeError): self.make()
        self.connect.assert_not_called()

    def test_b_signature_exception_is_preserved(self):
        def verify(body, sig):
            if body.is_relative_to(self.source):
                raise RuntimeError("unit signature refusal")
        self.route.verify_signature = verify
        with self.assertRaisesRegex(RuntimeError, "unit signature refusal"): self.make()
        self.connect.assert_not_called()

    def test_ready_alone_and_old_completed_are_not_a_new_operation(self):
        self.make(); self.fixture.start(); self.install_b()
        raw = self.record(self.ready)
        with self.assertRaises(RuntimeError): self.fixture.complete(raw, raw)

    def test_unknown_existing_handoff_refuses_at_initial_binding(self):
        self.record(self.completed)
        with self.assertRaises(RuntimeError): self.make()
        self.connect.assert_not_called()

    def test_b_inventory_is_closed_and_does_not_adopt_observed_values(self):
        self.b_resources["unreviewed"] = "f" * 64
        with self.assertRaises(RuntimeError): self.make()
        self.connect.assert_not_called()

    def test_same_hub_version_collision_refuses_even_with_different_server_bytes(self):
        descriptor = json.loads(self.b_descriptor)
        descriptor["hubVersion"] = "0.1.16"
        raw = json.dumps(descriptor).encode()
        (self.source / "routing/runtime.json").write_bytes(raw)
        self.b_resources["routing/runtime.json"] = sha(raw)
        release = json.loads(self.release); release["version"] = "0.1.16"
        self.release_pair[0].write_bytes(json.dumps(release).encode())
        with self.assertRaisesRegex(RuntimeError, "higher Hub version"): self.make()
        self.connect.assert_not_called()

    def test_provided_boolean_is_not_completion_and_cannot_be_retried(self):
        self.make(); self.fixture.start()
        with self.assertRaises(RuntimeError): self.fixture.complete(True, True)
        with self.assertRaises(RuntimeError): self.complete()
        self.assertIsNone(self.transition.current)
        self.assertFalse(self.original.closed)

    def test_late_actual_record_race_never_leaves_an_adopted_b_state(self):
        self.make(); self.fixture.start(); raw = self.install_b()
        def change(body, signature):
            if body == self.home / M.ROUTE_BASE / "descriptors" / sha(self.b_descriptor) / "runtime.json":
                self.record({**self.completed, "failure": "concurrent change"})
        self.transition.verify_signature = change
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)
        self.assertIsNone(self.transition.current)
        self.assertIsNone(self.transition.proof)
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")

    def test_actual_record_reader_requires_native_owner_and_private_mode(self):
        self.make(); self.fixture.start(); self.complete()
        with patch.object(MIG, "read_file", wraps=MIG.read_file) as reader:
            self.transition.recheck()
        reads = [c for c in reader.call_args_list if c.args[0] in (self.handoff, self.active)]
        self.assertTrue(reads)
        self.assertTrue(all(c.kwargs.get("uid") == MIG.UID and c.kwargs.get("mode") == 0o600
                            for c in reads if c.kwargs))

    def test_real_adapter_initialization_selects_b_node_path_and_stable_router(self):
        self.make(); self.fixture.start(); self.complete()
        self.route = self.transition
        result, processes = AdapterTests.adapter(self, {"ready": True, "server": M.SERVER})
        self.assertEqual(processes[0][0], [str(self.transition.command)])
        self.assertEqual(processes[1][0][:3], [str(self.transition.node), "-e", MIG.SDK_JS])
        self.assertIn(self.b_generation, str(self.transition.node))
        self.assertIsInstance(result, MIG.SDK)

    def test_target_source_change_after_binding_refuses_before_adoption(self):
        self.make(); self.fixture.start(); raw = self.install_b()
        (self.source / "routing/runtime.json").write_bytes(b"changed")
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)

    def test_original_process_change_still_refuses_and_eof_is_not_protocol(self):
        self.make(); self.fixture.start(); self.complete()
        self.original.records[101]["startTime"] = "changed"
        with self.assertRaises(RuntimeError): self.fixture.check("after-update")
        self.assertEqual(self.original.count, 2)

    def test_foreign_active_c_cannot_pass_even_with_completed_b(self):
        self.make(); self.fixture.start(); raw = self.install_b()
        self.active.write_bytes(json.dumps({"schemaVersion": 1, **self.target, "generation": "f" * 64}).encode())
        with self.assertRaises(RuntimeError): self.fixture.complete(self.ready_raw, raw)

    def test_provided_expected_ready_without_actual_capture_cannot_adopt_b(self):
        self.make(); self.fixture.start(); raw = self.install_b(capture_ready=False)
        with self.assertRaisesRegex(RuntimeError, "actual one-shot capture"):
            self.fixture.complete(json.dumps(self.ready).encode(), raw)
        self.assertIsNone(self.transition.current)

    def test_reencoded_ready_is_not_the_original_actual_capture(self):
        self.make(); self.fixture.start(); raw = self.install_b()
        with self.assertRaisesRegex(RuntimeError, "actual one-shot capture"):
            self.fixture.complete(json.dumps(self.ready, indent=2).encode(), raw)

    def test_same_bytes_completed_replacement_with_new_inode_is_refused(self):
        self.make(); self.fixture.start(); self.complete()
        raw, original = self.handoff.read_bytes(), self.handoff.stat()
        replacement = self.handoff.with_name("unit-replacement.json")
        replacement.write_bytes(raw)
        replacement.chmod(original.st_mode & 0o777)
        os.replace(replacement, self.handoff)
        self.assertNotEqual(original.st_ino, self.handoff.stat().st_ino)
        self.assertEqual(self.handoff.read_bytes(), raw)
        with self.assertRaisesRegex(RuntimeError, "Completed.*identity"):
            self.transition.recheck()

    def test_future_changed_node_or_router_is_outside_this_finite_gate(self):
        for name in ("mcp/server/runtime/node", "routing/creator-hub-mcp-router"):
            with self.subTest(name=name):
                resources = dict(self.b_resources)
                resources[name] = sha(b"unit-only-future-image")
                with self.assertRaisesRegex(RuntimeError, "unchanged Node/router"):
                    M.TransitionRoute(self.route, self.source, resources, self.release_pair)

    def test_live_b_observer_runs_after_protocol_before_eof_with_a_still_alive(self):
        self.make(); self.fixture.start(); self.complete()
        self.fixture.check("after-update"); self.fixture.check("after-hub-close")
        observed = []
        def capture(connection):
            self.assertIs(connection, self.next)
            self.assertEqual(connection.count, 2)
            self.assertFalse(connection.closed)
            self.assertFalse(self.original.closed)
            observed.append(connection.runtime.pid)
        self.fixture.reconnect_observed(capture)
        self.assertEqual(observed, [201])
        self.assertTrue(self.next.closed)
        self.assertFalse(self.original.closed)
        self.fixture.close()

    def test_observer_failure_is_spent_without_eof_success_or_reconnect_retry(self):
        self.make(); self.fixture.start(); self.complete()
        self.fixture.check("after-update"); self.fixture.check("after-hub-close")
        def refuse(connection):
            raise ValueError("original observer refusal")
        with self.assertRaisesRegex(ValueError, "original observer refusal"):
            self.fixture.reconnect_observed(refuse)
        with self.assertRaises(RuntimeError): self.fixture.reconnect_observed(refuse)
        self.assertIsNone(self.fixture.reconnected)
        self.assertFalse(self.original.closed)


ORIGINAL_CONNECT = M._connect
ORIGINAL_SEED_ADMISSION = M._fixture_session


if __name__ == "__main__":
    unittest.main()
