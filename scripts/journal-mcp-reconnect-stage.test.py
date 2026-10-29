import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("stage", Path(__file__).with_name("journal-mcp-reconnect-stage.py"))
stage = importlib.util.module_from_spec(spec); spec.loader.exec_module(stage)


class Connection:
    def __init__(self, name, events, pid):
        self.name, self.events = name, events
        self.handshake = {"ready": True, "server": {"name": "synthetic"}}
        self.runtime_identity, self.child_identity = {"pid": pid}, {"pid": pid + 1}
        self.runtime, self.child = SimpleNamespace(pid=pid), SimpleNamespace(pid=pid + 1)
        self.native = SimpleNamespace(native_process=lambda pid, helper: {"pid": pid})
    def check(self): self.events.append(self.name + ":check"); return {"checks": 2}
    def alive(self): self.events.append(self.name + ":alive")
    def close(self): self.events.append(self.name + ":eof")


class Fixture:
    def __init__(self):
        self.events = []; self.connection = None; self.started = self.closed = False; self.helper = object()
        self.route = SimpleNamespace(server=Path("/test") / stage.EXPECTED_GENERATION / "mcp/server/creator-works-mcp.mjs",
            binding={"resourceFiles": {"mcp/server/creator-works-mcp.mjs": stage.EXPECTED_SERVER_SHA256}},
            recheck=lambda: self.events.append("guard"))
    def _preserved(self): return {"protected": "unchanged"}
    def _new(self, name):
        self.events.append(name + ":start")
        return Connection(name, self.events, 10 if name == "existing" else 20)


class Tests(unittest.TestCase):
    def test_public_entry_fails_before_any_stage(self):
        with self.assertRaisesRegex(RuntimeError, "signed delivery"): stage.run()

    def test_synthetic_sequence_is_scoped_and_eof_precedes_reconnect(self):
        fixture = Fixture()
        mcp = SimpleNamespace(SERVER={"name": "synthetic"}, _protocol=lambda value, count: self.assertEqual(value, {"checks": count}),
                              same_process=lambda before, after: self.assertEqual(before, after))
        result = stage._exercise(fixture, mcp, lambda connection, name: fixture.events.append(name + ":observe"))
        self.assertLess(fixture.events.index("existing:eof"), fixture.events.index("reconnect:start"))
        self.assertLess(fixture.events.index("reconnect:observe"), fixture.events.index("reconnect:eof"))
        self.assertTrue(all(result[key] is False for key in ("signaturesVerifiedHere", "sourceAdmissionVerified",
                        "nativeReconnectAccepted", "transitionAccepted", "releaseReady")))

    def test_wrong_generation_refuses_before_launch(self):
        fixture = Fixture(); fixture.route.server = Path("/wrong/mcp/server/creator-works-mcp.mjs")
        with self.assertRaisesRegex(RuntimeError, "generation"): stage._exercise(fixture, None, None)
        self.assertFalse(fixture.events)

    def test_failure_does_not_retry_or_start_reconnect(self):
        fixture = Fixture()
        mcp = SimpleNamespace(SERVER={"name": "synthetic"}, _protocol=lambda value, count: None,
                              same_process=lambda before, after: None)
        def fail(connection, name): raise RuntimeError("observer failure")
        with self.assertRaisesRegex(RuntimeError, "observer failure"): stage._exercise(fixture, mcp, fail)
        self.assertEqual(fixture.events.count("existing:start"), 1)
        self.assertNotIn("reconnect:start", fixture.events)
        self.assertNotIn("existing:eof", fixture.events)
        with self.assertRaisesRegex(RuntimeError, "Fresh unused"): stage._exercise(fixture, mcp, fail)


if __name__ == "__main__": unittest.main()
