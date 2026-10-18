"""Portable contracts only: no installation, application launch or native input."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("integrated_migration", HERE / "native-linux-integrated-migration.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
WORKFLOW = HERE.parent / ".github/workflows/native-linux-integrated-migration.yml"


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
            "GITHUB_REF": M.BRANCH, "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "CREATOR_INTEGRATED_MIGRATION": "1", "GITHUB_EVENT_NAME": "push", "GITHUB_SHA": "a" * 40}


def graph(profile):
    frame = [10, 20, 600, 400]
    values = [(2, profile[1]), (29, profile[0]), (29, profile[2]), (43, profile[3]), (43, profile[4])]
    return [{"ref": [":1.7", "/node/" + str(i)], "parent": None if i == 0 else [":1.7", "/node/0"],
             "pid": 123, "role": role, "name": name, "ready": True, "frame": frame if i == 0 else None}
            for i, (role, name) in enumerate(values)]


class Tests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/tmp/fixture/home")
        self.descriptor = {"module": {"executable": "mcp/creator-works-mcp-launcher", "version": "2.7.7", "files": {"z": "2" * 64, "a": "1" * 64}}}
        self.profiles = M.profiles(self.home, self.descriptor)

    def test_exact_disposable_admission_and_both_bootstrap_events(self):
        for event in ("push", "workflow_dispatch"):
            M.admission({**environment(), "GITHUB_EVENT_NAME": event}, "linux", "x86_64")
        for key in environment():
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: "wrong"}, "linux", "x86_64")
        for system, arch in (("win32", "x86_64"), ("darwin", "arm64"), ("linux", "aarch64")):
            with self.assertRaises(RuntimeError):
                M.admission(environment(), system, arch)

    def test_runtime_and_credential_injection_refused(self):
        for key in ("LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "TAURI_CONFIG", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "SSL_CERT_FILE", "CREATOR_HUB_SIGNING_KEY", "FLATPAK_ID"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: "x"}, "linux", "x86_64")

    def test_fixed_five_dialog_profiles_not_runtime_authority(self):
        self.assertEqual(len(self.profiles), 5)
        self.assertEqual([p[3] for p in self.profiles], ["Back up and continue", "Enable managed routing", "Move selected connections", "Move server path", "Finish migration"])
        for p in self.profiles:
            M.validate_graph(p, graph(p), 123, (10, 20, 600, 400))

    def test_foreign_changed_or_ambiguous_graph_never_authorizes(self):
        p = self.profiles[0]
        for mutate in (lambda g: g[1].update(pid=999), lambda g: g[2].update(name="changed question"),
                       lambda g: g[0].update(frame=[0, 0, 1, 1]), lambda g: g[3].update(ready=False),
                       lambda g: g[3].update(name=p[4]), lambda g: g[1].update(parent=[":2.1", "/foreign"]),
                       lambda g: g[1].update(ref=g[0]["ref"]), lambda g: g[1].update(role=40),
                       lambda g: g.append(copy.deepcopy(g[-1]))):
            g = graph(p); mutate(g)
            with self.assertRaises(RuntimeError):
                M.validate_graph(p, g, 123, (10, 20, 600, 400))

    def test_missing_button_question_title_and_changed_role_refuse(self):
        p = self.profiles[2]
        for i in range(len(graph(p))):
            g = graph(p); del g[i]
            with self.subTest(index=i), self.assertRaises(RuntimeError):
                M.validate_graph(p, g, 123, (10, 20, 600, 400))
        g = graph(p); g[0]["role"] = 16
        with self.assertRaises(RuntimeError):
            M.validate_graph(p, g, 123, (10, 20, 600, 400))

    def test_generation_matches_rust_struct_order_and_sorted_file_map(self):
        router, server, generation = M.route_paths(self.home, self.descriptor)
        raw = json.dumps({"executable": "mcp/creator-works-mcp-launcher", "version": "2.7.7", "files": {"a": "1" * 64, "z": "2" * 64}}, separators=(",", ":")).encode()
        self.assertEqual(generation, hashlib.sha256(raw).hexdigest())
        self.assertEqual(router, self.home / "data/creator-hub/mcp-route-v1/linux-x86_64/router-v1/creator-hub-mcp-router")
        self.assertEqual(server, self.home / "data/creator-hub/runtime-generations/linux-x86_64" / generation / "mcp/server/creator-works-mcp.mjs")

    def test_completed_journal_requires_exact_original_after_and_current_bytes(self):
        before, after, target = b"original", b"approved route", "/tmp/fixture/config"
        pending = {"schema": 1, "files": [{"client": "Codex", "path": target, "before_sha256": M.digest(before), "after_sha256": M.digest(after)}]}
        M.completed_journal(pending, copy.deepcopy(pending), before, after, after, {target})
        for a, b, c in ((b"changed", after, after), (before, b"changed", after), (before, after, b"changed")):
            with self.assertRaises(RuntimeError):
                M.completed_journal(pending, pending, a, b, c, {target})
        for mutate in (lambda p: p.update(schema=2), lambda p: p.update(files=[]), lambda p: p.update(future=True),
                       lambda p: p["files"][0].update(path="/foreign")):
            changed = copy.deepcopy(pending); mutate(changed)
            with self.assertRaises(RuntimeError):
                M.completed_journal(changed, changed, before, after, after, {target})
        with self.assertRaises(RuntimeError):
            M.completed_journal(pending, {}, before, after, after, {target})

    def test_old_release_is_fixed_and_no_frozen_updateflow_reuse(self):
        self.assertEqual(M.OLD["serverSize"], 1221209)
        self.assertEqual(M.OLD["serverSha256"], "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149")
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        self.assertNotIn("native-linux-update-flow", source)
        self.assertNotIn("skip-migration", source)
        self.assertNotIn("defer_migration", source)
        self.assertNotIn("/screenshot", source)
        self.assertNotIn("/execute", source)
        self.assertTrue(all(v is False for v in M.FALSE_GATES.values()))

    def test_approvals_are_double_walk_identity_guarded_and_capture_before_action(self):
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        body = source.split("    def approve(self, profile):", 1)[1].split("    def migrate_step", 1)[0]
        self.assertEqual(body.count("action.do_action(0)"), 1)
        self.assertIn("first == second", body)
        self.assertIn("owner.recheck(full=True)", body)
        self.assertIn("x11.frame_rectangle(xid) == frame", body)
        self.assertIn("owner.same_node(node.get_parent(), parent)", body)
        self.assertLess(body.index("gtk-"), body.index("action.do_action(0)"))
        self.assertEqual(body.count("validate_graph(profile"), 2)
        self.assertNotIn("get_text", body)
        self.assertNotIn("set_text", body)

    def test_normal_close_precedes_driver_cleanup_and_reopen_uses_new_pid(self):
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        body = source.split("    def close(self):", 1)[1].split("def run(", 1)[0]
        self.assertLess(body.index("x11.close_window"), body.index("child.terminate"))
        self.assertLess(body.index('normalCloseObserved"] = True'), body.index("pidfd_send_signal"))
        self.assertNotIn("os.kill(", source)
        self.assertIn('session.owned["pid"] != report["first"]["root"]["pid"]', source)
        self.assertIn('report["afterReopen"] == report["afterMigration"] == report["afterClose"]', source)

    def test_native_gtk_only_and_real_helper_constructor_contract(self):
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        self.assertNotIn("verify_system_webkit", source)
        self.assertIn('node.get_process_id() == request.pid', source)
        self.assertIn('"--verify", "libgtk-3-0"', source)
        self.assertIn("system_check=lambda: self.pages.record(self.gtk_file)", source)
        helper = ast.parse((HERE / "native-linux-root-probe.py").read_text())
        cls = next(n for n in helper.body if isinstance(n, ast.ClassDef) and n.name == "RootOwnership")
        constructor = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "__init__")
        self.assertTrue({"system_check", "references"} <= {a.arg for a in constructor.args.args})

    def test_workflow_branch_permissions_producer_and_legacy_pins(self):
        import yaml
        value = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(value["on"]["push"]["branches"], [M.BRANCH.removeprefix("refs/heads/")])
        self.assertEqual(set(value["on"]["push"]["paths"]), {".github/workflows/native-linux-integrated-migration.yml", "scripts/native-linux-integrated-migration.py", "scripts/native-linux-integrated-migration.test.py"})
        self.assertEqual(value["permissions"], {"contents": "read", "actions": "read"})
        job = value["jobs"]["migration"]
        self.assertEqual(job["runs-on"], "ubuntu-22.04")
        self.assertIn(M.BRANCH, job["if"])
        text = WORKFLOW.read_text()
        for required in (M.SOURCE, M.HELPER_SOURCE, M.OLD["source"], M.OLD["sha256"], M.OLD["serverSha256"], "39130359610", "12137857868", "63874886", "97717cf5b454315598ac3addaf59d98b7a27c2fdff710563412cfa6b8ec3e0ea"):
            self.assertIn(required, text)
        self.assertNotIn("contents: write", text)
        self.assertNotIn("gh release", text)
        self.assertNotIn("--no-sandbox", text)

    def test_python_yaml_bash_and_embedded_javascript_syntax(self):
        import yaml
        ast.parse((HERE / "native-linux-integrated-migration.py").read_text())
        value = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)
        bash = shutil.which("bash") if os.name != "nt" else "C:/Program Files/Git/bin/bash.exe"
        self.assertTrue(bash and Path(bash).is_file(), "Bash required for preflight")
        for step in value["jobs"]["migration"]["steps"]:
            if "run" in step:
                result = subprocess.run([bash, "-n"], input=step["run"], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                for block in re.findall(r"python3 -B - <<'PY'\n(.*?)\nPY", step["run"], re.S):
                    ast.parse(block)
            if "script" in step.get("with", {}):
                result = subprocess.run(["node", "--check"], input="async function fixture(){\n" + step["with"]["script"] + "\n}", text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
