"""Run the existing isolated cold-baseline guard test with bounded lifecycle evidence."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

source = Path.cwd() / "scripts/native-linux-migrated-update.test.py"
spec = importlib.util.spec_from_file_location("cold_guard_existing_test", source)
tests = importlib.util.module_from_spec(spec); sys.modules[spec.name] = tests; spec.loader.exec_module(tests)
C = tests.C
exits = []
original_load = C.load
original_init = C.TransitionHomePreservation.__init__


def traced_load(name, **kwargs):
    module = original_load(name, **kwargs)
    if name == "native-linux-localstorage-snapshot":
        original_exit = module.HeldReader.__exit__
        def traced_exit(reader, *args):
            process = reader.process
            result = original_exit(reader, *args)
            exits.append({"pid": process.pid, "exitCode": process.poll(), "reaped": reader.process is None})
            return result
        module.HeldReader.__exit__ = traced_exit
    return module


def traced_init(guard, adopted, *args):
    if "localstorage" in adopted:
        if len(exits) != 1 or exits[0]["exitCode"] != 0 or not exits[0]["reaped"]:
            raise AssertionError("cold reader did not exit before guard constructor")
        identities = adopted["localstorage"]["identities"]
        for name in C._LOCAL_SIDECARS:
            info = (C.HOME / name).lstat()
            if (info.st_dev, info.st_ino, info.st_uid, info.st_gid) != tuple(identities[name][k] for k in ("dev", "ino", "uid", "gid")):
                raise AssertionError("cold sidecar identity differs before constructor")
        print(json.dumps({"coldHelperExitedBeforeConstructor": True, "helperExit": exits[0],
                          "bothSidecarsExistWithCapturedIdentity": True,
                          "fixtureOtherConnections": "none-created"}, sort_keys=True), flush=True)
    return original_init(guard, adopted, *args)


if not sys.platform.startswith("linux") or os.getuid() == 0:
    raise RuntimeError("ordinary disposable Linux fixture required")
with patch.object(C, "load", side_effect=traced_load), patch.object(C.TransitionHomePreservation, "__init__", traced_init):
    case = tests.TransitionHomeTests("test_real_held_reader_integrates_with_complete_home_guard")
    outcome = unittest.TextTestRunner(verbosity=2).run(case)
if not outcome.wasSuccessful() or not exits or exits[0]["exitCode"] != 0:
    raise RuntimeError("cold guard boundary fixture failed")
