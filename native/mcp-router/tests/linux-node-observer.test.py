"""Pure synthetic kernel-record tests; no process launch, key or Linux claim."""
import ast
import copy
from contextlib import ExitStack
import importlib.util
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("synthetic_linux_node_observer", HERE / "linux-node-observer.py")
O = importlib.util.module_from_spec(spec)
spec.loader.exec_module(O)


def fixture():
    fixed = O.loader()
    expected = {"routerPid": 100, "callerPid": 90, "uid": 1001, "gid": 1001, "routerPath": "/owned/fixture-driver",
                "routerImage": {"size": 123, "sha256": "a" * 64},
                "nodePath": "/owned/runtime-generations/linux-x86_64/" + "a" * 64 + "/mcp/server/runtime/node",
                "nodeImage": {"size": 456, "sha256": "b" * 64},
                "serverPath": "/owned/runtime-generations/linux-x86_64/" + "a" * 64 + "/mcp/server/creator-works-mcp.mjs",
                "sourceSha256": "c" * 64}
    image = {"dev": 1, "ino": 2, "mode": stat.S_IFREG | 0o500, "uid": 1001, "gid": 1001,
             "nlink": 0, "size": 456, "mtimeNs": "1", "ctimeNs": "1"}
    router = {"pid": 100, "parentPid": 90, "startTime": "1000", "uids": [1001] * 4, "gids": [1001] * 4,
              "executable": expected["routerPath"], "imagePin": expected["routerImage"],
              "argv": [expected["routerPath"], "connect", "/owned", "/owned/TEST-PUBLIC-KEY.txt"]}
    supervisor = {**copy.deepcopy(router), "pid": 101, "parentPid": 100, "startTime": "1001"}
    node = {"pid": 102, "parentPid": 101, "startTime": "1002", "uids": [1001] * 4, "gids": [1001] * 4,
            "executable": O.MEMFD, "imagePin": expected["nodeImage"], "image": image,
            "fd4Image": copy.deepcopy(image), "fd4Link": O.MEMFD, "seals": 15,
            "argv": [expected["nodePath"], "--input-type=module", "--eval", fixed,
                     expected["serverPath"], expected["sourceSha256"]]}
    return {"router": router, "supervisor": supervisor, "serverNode": node}, expected, fixed


class ObserverTests(unittest.TestCase):
    def test_exact_synthetic_ancestry_argv_seals_and_images_pass_with_acceptance_false(self):
        snapshot, expected, fixed = fixture()
        result = O.validate_snapshot(snapshot, expected, fixed)
        self.assertTrue(result["passed"])
        self.assertTrue(result["syntheticFixtureOnly"])
        for name in ("qualified", "nativeAdmissionAccepted", "liveMcpProtocolAccepted", "payloadSwapAccepted", "releaseReady"):
            self.assertIs(result[name], False)

    def test_explicit_gid_is_bound_without_assuming_uid_equals_gid(self):
        snapshot, expected, fixed = fixture(); expected["gid"] = 2002
        for row in snapshot.values(): row["gids"] = [2002] * 4
        snapshot["serverNode"]["image"]["gid"] = snapshot["serverNode"]["fd4Image"]["gid"] = 2002
        self.assertTrue(O.validate_snapshot(snapshot, expected, fixed)["passed"])

    def test_stale_a_rejects_same_node_semver_toolnames_and_same_server_path(self):
        a, expected_a, fixed = fixture()
        expected_b = copy.deepcopy(expected_a)
        expected_b["sourceSha256"] = "d" * 64
        metadata_a = {"node": expected_a["nodeImage"], "version": "2.7.7", "tools": ["get_bridge_status", "list_unity_projects"]}
        metadata_b = {"node": expected_b["nodeImage"], "version": "2.7.7", "tools": ["get_bridge_status", "list_unity_projects"]}
        self.assertEqual(metadata_a, metadata_b)
        self.assertEqual(expected_a["serverPath"], expected_b["serverPath"])
        with self.assertRaisesRegex(RuntimeError, "source digest"):
            O.validate_snapshot(a, expected_b, fixed)

    def test_sdk_client_wrapper_is_not_the_router_launched_server_node(self):
        snapshot, expected, fixed = fixture()
        snapshot["serverNode"].update(parentPid=90, executable=expected["nodePath"],
                                      argv=[expected["nodePath"], "-e", "SDK_WRAPPER", "3", "4", "5"])
        with self.assertRaises(RuntimeError):
            O.validate_snapshot(snapshot, expected, fixed)

    def test_each_loader_argument_and_server_digest_are_independently_required(self):
        for index in range(6):
            snapshot, expected, fixed = fixture()
            snapshot["serverNode"]["argv"][index] += "-wrong"
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                O.validate_snapshot(snapshot, expected, fixed)
        snapshot, expected, fixed = fixture()
        snapshot["serverNode"]["argv"] = ["creator-works-mcp"]
        with self.assertRaises(RuntimeError):
            O.validate_snapshot(snapshot, expected, fixed)

    def test_uid_parent_start_order_and_router_or_node_image_drift_refuse(self):
        for role, key, value in (
            ("router", "pid", 999), ("router", "parentPid", 1), ("supervisor", "parentPid", 90),
            ("serverNode", "parentPid", 100), ("serverNode", "uids", [1001, 0, 0, 0]),
            ("serverNode", "startTime", "1"), ("router", "imagePin", {"size": 123, "sha256": "0" * 64}),
            ("serverNode", "imagePin", {"size": 456, "sha256": "0" * 64}),
        ):
            snapshot, expected, fixed = fixture()
            snapshot[role][key] = value
            with self.subTest(role=role, key=key), self.assertRaises(RuntimeError):
                O.validate_snapshot(snapshot, expected, fixed)

    def test_fd4_identity_memfd_and_all_four_required_seals_are_mandatory(self):
        for seals in (0, 7, 11, 13, 14):
            snapshot, expected, fixed = fixture(); snapshot["serverNode"]["seals"] = seals
            with self.subTest(seals=seals), self.assertRaises(RuntimeError):
                O.validate_snapshot(snapshot, expected, fixed)
        for key, value in (("fd4Link", "/ordinary/node"), ("executable", "/ordinary/node")):
            snapshot, expected, fixed = fixture(); snapshot["serverNode"][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                O.validate_snapshot(snapshot, expected, fixed)
        snapshot, expected, fixed = fixture(); snapshot["serverNode"]["fd4Image"]["ino"] += 1
        with self.assertRaises(RuntimeError):
            O.validate_snapshot(snapshot, expected, fixed)

    def test_memfd_owner_mode_and_links_refuse_even_with_same_node_hash(self):
        for key, value in (("uid", 0), ("gid", 0), ("mode", stat.S_IFREG | 0o700), ("nlink", 1)):
            snapshot, expected, fixed = fixture()
            snapshot["serverNode"]["image"][key] = snapshot["serverNode"]["fd4Image"][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                O.validate_snapshot(snapshot, expected, fixed)

    def test_proc_parsers_are_bounded_and_do_not_use_process_argv_self_report(self):
        fields = ["S", "90", *(["0"] * 17), "1000", "0"]
        self.assertEqual(O.parse_stat(("100 (name ) with spaces) " + " ".join(fields)).encode(), 100),
                         {"pid": 100, "parentPid": 90, "startTime": "1000"})
        self.assertEqual(O.parse_argv(b"one\0two\0"), ["one", "two"])
        for raw in (b"", b"one", b"one\0\0", b"x" * 65537):
            with self.subTest(raw=raw[:16]), self.assertRaises(RuntimeError): O.parse_argv(raw)
        with self.assertRaises(RuntimeError): O.parse_stat(b"101 (name) S 1", 100)

    def test_source_drift_refuses_without_accepting_an_alternate_loader(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / "tests").mkdir(); (root / "src").mkdir()
            for name in O.SOURCE_PINS:
                raw = (HERE.parent / "src" / name).read_bytes()
                (root / "src" / name).write_bytes(raw + (b"\n" if name == "unix_exec.rs" else b""))
            with patch.object(O, "HERE", root / "tests"), self.assertRaisesRegex(RuntimeError, "source changed"):
                O.loader()

    def test_contract_unknown_fields_noncanonical_paths_and_unpinned_images_refuse(self):
        for mutate in (
            lambda c: c.update(extra=True), lambda c: c.update(routerPid=True),
            lambda c: c.update(serverPath="/owned/../server.mjs"), lambda c: c.update(nodePath="/other/node"),
            lambda c: c["nodeImage"].update(size=0), lambda c: c.update(sourceSha256="unknown"),
        ):
            _, expected, _ = fixture(); mutate(expected)
            with self.subTest(contract=expected), self.assertRaises(Exception): O.contract(expected)

    def test_collector_follows_only_two_bounded_direct_child_edges_and_rechecks_all(self):
        snapshot, expected, fixed = fixture(); calls = []
        class Reader:
            def __init__(self, stack, contract): self.rows = {v["pid"]: v for v in snapshot.values()}
            def snapshot(self, pid, pin, *, server=False): calls.append(("snapshot", pid, server)); return self.rows[pid]
            def children(self, pid): calls.append(("children", pid)); return {100: [101], 101: [102]}[pid]
            def recheck(self, pid): calls.append(("recheck", pid))
        with patch.object(O, "ProcReader", Reader):
            self.assertTrue(O.observe(expected)["passed"])
        self.assertEqual([c for c in calls if c[0] == "snapshot"],
                         [("snapshot", 100, False), ("snapshot", 101, False), ("snapshot", 102, True)])
        self.assertEqual([c[1] for c in calls if c[0] == "recheck"], [100, 101, 102])

    def test_collector_refuses_extra_children_and_recheck_failure_without_fallback(self):
        snapshot, expected, _ = fixture()
        class Reader:
            def __init__(self, stack, contract): pass
            def snapshot(self, pid, pin, *, server=False): return next(row for row in snapshot.values() if row["pid"] == pid)
            def children(self, pid): return [101, 999]
            def recheck(self, pid): raise RuntimeError("identity drift")
        with patch.object(O, "ProcReader", Reader), self.assertRaisesRegex(RuntimeError, "One private supervisor"):
            O.observe(expected)
        with patch.object(Reader, "children", lambda self, pid: {100: [101], 101: [102]}[pid]), \
                patch.object(O, "ProcReader", Reader), self.assertRaisesRegex(RuntimeError, "identity drift"):
            O.observe(expected)

    def test_observer_does_not_read_environ_or_launch_signal_mutate_or_sleep(self):
        text = (HERE / "linux-node-observer.py").read_text()
        self.assertNotIn("/environ", text)
        parsed = ast.parse(text)
        calls = {ast.unparse(n.func) for n in ast.walk(parsed) if isinstance(n, ast.Call)}
        self.assertFalse(calls & {"os.kill", "os.system", "subprocess.run", "subprocess.Popen", "time.sleep", "os.chmod", "os.chown"})
        opens = [n for n in ast.walk(parsed) if isinstance(n, ast.Call) and ast.unparse(n.func) == "os.open"]
        self.assertEqual(len(opens), 1)
        self.assertEqual(ast.unparse(opens[0].args[1]), "os.O_RDONLY | os.O_CLOEXEC")

    def test_current_proc_exe_and_fd4_must_still_match_held_descriptors(self):
        for changed in ("exe", "fd4", "seals", "exited"):
            snapshot, _, _ = fixture(); row = snapshot["serverNode"]
            identity = {k: row[k] for k in ("pid", "parentPid", "startTime", "uids", "gids", "executable", "argv")}
            reader = object.__new__(O.ProcReader)
            reader.held = {102: {"pidfd": 90, "exe": 11, "fd4": 12, "row": row, "identity": identity}}
            reader.fcntl = SimpleNamespace(F_GET_SEALS=1, fcntl=lambda fd, op: 14 if changed == "seals" and fd == 14 else 15)
            def image(fd):
                value = copy.deepcopy(row["image"])
                if (changed == "exe" and fd == 13) or (changed == "fd4" and fd == 14): value["ino"] += 1
                return value
            poll = SimpleNamespace(register=lambda *a: None, poll=lambda *a: [1] if changed == "exited" else [])
            with self.subTest(changed=changed), patch.object(O.select, "poll", return_value=poll, create=True), \
                    patch.object(O.select, "POLLIN", 1, create=True), \
                    patch.object(reader, "identity", return_value=identity), patch.object(reader, "image", side_effect=image), \
                    patch.object(reader, "opened", side_effect=[13, 14]), patch.object(O.os, "readlink", return_value=O.MEMFD), \
                    self.assertRaises(RuntimeError):
                reader.recheck(102)


if __name__ == "__main__":
    unittest.main()
