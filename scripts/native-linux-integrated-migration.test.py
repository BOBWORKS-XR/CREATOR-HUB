"""Portable contracts only: no installation, application launch or native input."""
import ast
import copy
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace
import zipfile

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


def archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        for name, value in entries:
            entry = zipfile.ZipInfo()
            entry.filename = name
            z.writestr(entry, value)
    buffer.seek(0)
    return buffer


def ready_session():
    session = object.__new__(M.Session)
    uid = 1000
    intermediary = {"pid": 101, "parentPid": 90, "uids": [uid] * 4, "executable": "/fixture/tauri-driver", "kernelImageSha256": "a" * 64}
    native = {"pid": 102, "parentPid": 101, "uids": [uid] * 4, "executable": "/usr/bin/WebKitWebDriver", "kernelImageSha256": "b" * 64}
    session.child = mock.Mock(pid=101)
    session.child.poll.return_value = None
    session.driver_process = intermediary
    session.native_driver, session.native_pidfd = None, None
    session.system_driver = {"sha256": "b" * 64}
    session.logs, session.driver = mock.Mock(), mock.Mock(last_request=None)
    session.logs.metadata.return_value = {"stdout": {"eof": True, "truncated": False}}
    session.driver.request.return_value = {"ready": True, "message": "ready"}
    session.pages, session.native, session.helper = mock.Mock(), mock.Mock(), object()
    session.pages.subtree.return_value = {101: intermediary, 102: native}
    session.native.native_process.side_effect = lambda pid, _: copy.deepcopy({101: intermediary, 102: native}[pid])
    session.pages.listener.return_value = True
    session.label, session.report = "first", {"first": {"cleanupErrors": []}}
    return session


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

    def test_real_legacy_windows_zip_naming_on_both_python_platforms(self):
        canonical = "Creator-Works-MCP-2.7.7/creator-works-mcp.mjs"
        raw = canonical.replace("/", "\\")
        for separator in ("/", "\\"):
            with tempfile.TemporaryDirectory() as directory, mock.patch.object(zipfile.os, "sep", separator):
                data = archive([(raw, b"pinned")])
                with zipfile.ZipFile(data) as z:
                    self.assertEqual(z.infolist()[0].orig_filename, raw)
                    self.assertEqual(z.infolist()[0].filename, raw if separator == "/" else canonical)
                data.seek(0)
                M.stage_archive(data, Path(directory), {canonical: ("server.mjs", 6, M.digest(b"pinned"))}, legacy_windows=True)
                self.assertEqual((Path(directory) / "server.mjs").read_bytes(), b"pinned")

    def test_archive_foreign_paths_aliases_and_pin_changes_still_refuse(self):
        canonical = "Creator-Works-MCP-2.7.7/creator-works-mcp.mjs"
        raw = canonical.replace("/", "\\")
        for foreign in (canonical, "C:\\server", "\\absolute", "Creator-Works-MCP-2.7.7\\..\\other",
                        "Creator-Works-MCP-2.7.7\\.\\other", "Creator-Works-MCP-2.7.7\\\\other",
                        "Creator-Works-MCP-2.7.7\\mixed/name", raw):
            with self.subTest(foreign=foreign), tempfile.TemporaryDirectory() as directory, self.assertRaises(RuntimeError):
                M.stage_archive(archive([(raw, b"pinned"), (foreign, b"x")]), Path(directory),
                                {canonical: ("server.mjs", 6, M.digest(b"pinned"))}, legacy_windows=True)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            for selected, legacy in (({canonical: ("server.mjs", 6, "0" * 64)}, True),
                                     ({canonical: ("server.mjs", 6, M.digest(b"pinned"))}, False),
                                     ({canonical: ("../escape", 6, M.digest(b"pinned"))}, True),
                                     ({"other": ("server.mjs", 6, M.digest(b"pinned"))}, True)):
                with self.assertRaises(RuntimeError):
                    M.stage_archive(archive([(raw, b"pinned")]), out, selected, legacy_windows=legacy)
            self.assertEqual(list(out.iterdir()), [])

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

    def test_both_owned_listeners_and_status_ready_required_before_session(self):
        s = ready_session()
        with mock.patch.object(M.os, "getuid", return_value=1000, create=True), mock.patch.object(M.os, "pidfd_open", return_value=77, create=True) as opened:
            s.pages.listener.side_effect = lambda pid, port: (pid, port) == (101, 4444)
            self.assertFalse(s.drivers_ready())
            s.driver.request.assert_not_called()
            s.pages.listener.return_value, s.pages.listener.side_effect = True, None
            s.driver.request.return_value = {"ready": False}
            self.assertFalse(s.drivers_ready())
            s.driver.request.return_value = {"ready": True}
            self.assertTrue(s.drivers_ready())
            opened.assert_called_once_with(102)
            self.assertTrue(all(call.args == ("GET", "/status") for call in s.driver.request.call_args_list))
            self.assertEqual(s.report["first"]["preSessionReadiness"]["status"], {"ready": True})
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        start = source.split("    def _start(self):", 1)[1].split("    def process_guard", 1)[0]
        self.assertLess(start.index("pages.wait(self.drivers_ready)"), start.index('self.driver.request("POST", "/session"'))
        self.assertEqual(source.count('self.driver.request("POST", "/session"'), 1)

    def test_native_driver_foreign_uid_image_parent_or_changed_listener_refuses(self):
        for field, value in (("uids", [999] * 4), ("kernelImageSha256", "0" * 64), ("parentPid", 999)):
            s = ready_session()
            s.pages.subtree.return_value[102][field] = value
            with self.subTest(field=field), mock.patch.object(M.os, "getuid", return_value=1000, create=True), self.assertRaises(RuntimeError):
                s.drivers_ready()
            s.driver.request.assert_not_called()
        s = ready_session()
        s.pages.listener.side_effect = [True, True, True, False]
        with mock.patch.object(M.os, "getuid", return_value=1000, create=True), mock.patch.object(M.os, "pidfd_open", return_value=77, create=True), self.assertRaises(RuntimeError):
            s.drivers_ready()

    def test_constructor_preserves_initial_failure_and_drains_bounded_logs(self):
        original = http.client.RemoteDisconnected("original session disconnect")
        report = {}
        capture = mock.Mock()
        capture.metadata.side_effect = [{"stderr": {"eof": False}}, {"stderr": {"eof": True}}, {"stderr": {"eof": True}}]
        def fail(session):
            session.child = mock.Mock()
            session.child.poll.return_value = 3
            session.logs = capture
            session.driver = SimpleNamespace(last_request={"method": "POST", "route": "/session"})
            raise original
        with mock.patch.object(M.Session, "_start", fail), self.assertRaises(http.client.RemoteDisconnected) as caught:
            M.Session(None, {}, None, None, None, report, "first")
        self.assertIs(caught.exception, original)
        self.assertEqual(report["first"]["initialError"]["type"], "RemoteDisconnected")
        self.assertEqual(report["first"]["driverExitCode"], 3)
        self.assertFalse(report["first"]["nativeDriverExit"]["bound"])
        capture.pump.assert_called_once_with(0.02)
        report = {}
        with mock.patch.object(M.Session, "_start", fail), mock.patch.object(M.Session, "capture_startup_failure", side_effect=RuntimeError("capture failed")), self.assertRaises(http.client.RemoteDisconnected) as caught:
            M.Session(None, {}, None, None, None, report, "first")
        self.assertIs(caught.exception, original)
        self.assertEqual(report["first"]["cleanupErrors"][0]["phase"], "startup-capture")

    def test_bound_native_exit_observation_does_not_invent_grandchild_wait_status(self):
        s = ready_session()
        s.native_driver, s.native_pidfd = s.pages.subtree.return_value[102], 77
        s.child.poll.return_value = 1
        with mock.patch.object(M.select, "select", return_value=([77], [], [])), mock.patch.object(M.os, "close") as close:
            s.capture_startup_failure()
        self.assertEqual(s.report["first"]["nativeDriverExit"], {"bound": True, "exitObserved": True, "exitCode": None, "waitStatusAvailable": False})
        self.assertEqual(s.report["first"]["driverExitCode"], 1)
        close.assert_called_once_with(77)
        self.assertIsNone(s.native_pidfd)

    def test_cleanup_timeout_cannot_replace_original_session_failure(self):
        original = http.client.RemoteDisconnected("original session disconnect")
        pages, native, report = mock.Mock(), mock.Mock(), {}
        native.run_tool.return_value = (0, b"")
        wm = mock.Mock()
        wm.wait.side_effect = subprocess.TimeoutExpired(["/usr/bin/openbox"], 10)
        with mock.patch.object(M, "Session", side_effect=original), mock.patch.object(M.subprocess, "Popen", return_value=wm), mock.patch.object(M.subprocess, "run"), self.assertRaises(http.client.RemoteDisconnected) as caught:
            M.run({"hub": {}}, Path("/fixture"), pages, object(), native, report)
        self.assertIs(caught.exception, original)
        self.assertEqual(report["cleanupErrors"][0]["type"], "TimeoutExpired")
        self.assertNotIn("migrationAccepted", report)

    def test_completed_html_required_and_continue_clicked_exactly_once(self):
        values = {("#convergence-title", "text"): "Migration complete",
                  ("#convergence-summary", "text"): "Migration complete. Use MCP and Project Setup in Creator Hub. Your reviewed settings and backups are kept. No standalone installation was removed.",
                  ("#convergence-dialog", "attribute/aria-busy"): "false", ("#convergence-dialog", "attribute/open"): "",
                  ("#convergence-later", "text"): "Continue in Hub", ("#convergence-later", "enabled"): True,
                  ("#convergence-error", "text"): ""}
        values.update({("#convergence-" + name, "property/hidden"): True for name in ("prepare", "connections", "retire", "refresh")})
        for altered in (None, *values):
            state, driver, pages = dict(values), mock.Mock(), mock.Mock()
            if altered is not None:
                state[altered] = False if type(state[altered]) is bool else "changed"
                if altered == ("#convergence-dialog", "attribute/open"):
                    state[altered] = None
            driver.read.side_effect = lambda selector, endpoint="text": state[(selector, endpoint)]
            driver.click.side_effect = lambda _: state.update({("#convergence-dialog", "attribute/open"): None})
            def ready(check):
                M.require(check(), "Read-only completed-state check did not pass")
            pages.wait.side_effect = ready
            if altered is None:
                receipt = M.continue_completed_guide(driver, pages)
                driver.click.assert_called_once_with("#convergence-later")
                self.assertEqual(receipt["continueActionCount"], 1)
                self.assertEqual(receipt["title"], "Migration complete")
                self.assertEqual(pages.wait.call_count, 2)
            else:
                with self.subTest(altered=altered), self.assertRaises(RuntimeError):
                    M.continue_completed_guide(driver, pages)
                driver.click.assert_not_called()
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        run = source.split("def run(", 1)[1]
        self.assertLess(run.index("continue_completed_guide(d, pages)"), run.index('report["afterMigration"] = preserved'))
        self.assertFalse(M.FALSE_GATES["standaloneRemovalAccepted"])

    def test_protocol_uses_official_sdk_codec_initialize_list_and_eof_only(self):
        sdk_path = str(HERE.parent / "modules/mcp/package.json")
        script = M.PROTOCOL_JS + "\n" + r"""
const { PassThrough } = require('node:stream');
const sdk = createRequire(SDK_PATH), codec = sdk('@modelcontextprotocol/sdk/shared/stdio.js');
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
(async () => {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const transport = new EofTransport(input, output, diagnostics, codec), requests = new codec.ReadBuffer();
  input.on('data', chunk => {
    requests.append(chunk);
    for (let message; (message = requests.readMessage()) !== null;) {
      let value;
      if (message.method === 'initialize') value = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'creator-works-mcp', version: '2.7.7' } };
      else if (message.method === 'tools/list') value = { tools: CORE.map(name => ({ name, inputSchema: { type: 'object' } })) };
      else { assert.equal(message.method, 'notifications/initialized'); continue; }
      const bytes = Buffer.from(codec.serializeMessage({ jsonrpc: '2.0', id: message.id, result: value }));
      output.write(bytes.subarray(0, 7)); output.write(bytes.subarray(7));
    }
  });
  input.on('finish', () => { output.end(); diagnostics.end(); });
  const client = new Client({ name: 'portable-memory-only', version: '1' });
  await client.connect(transport, { timeout: 1000 });
  const tools = await client.listTools({}, { timeout: 1000 });
  await client.close();
  const receipt = result(client, tools, transport);
  assert.equal(receipt.signalsRequested, false); assert.equal(receipt.eofSent, true);
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 999, method: 'tools/call' }));
  assert.throws(() => result({ getServerVersion: () => ({ name: 'foreign', version: '2.7.7' }) }, tools, transport));
  assert.throws(() => result(client, { ...tools, nextCursor: 'more' }, transport));
  assert.throws(() => result(client, { tools: tools.tools.slice(1) }, transport));
  assert.throws(() => result(client, { tools: [...tools.tools.slice(1), { name: 'foreign' }] }, transport));
  console.log('Official SDK memory handshake, fragmented codec, finite methods and EOF PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
""".replace("SDK_PATH", json.dumps(sdk_path))
        checked = subprocess.run(["node", "--check"], input=M.PROTOCOL_JS, text=True, capture_output=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        completed = subprocess.run(["node", "-e", script], text=True, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("EOF PASS", completed.stdout)
        self.assertNotIn("StdioClientTransport", M.PROTOCOL_JS)
        self.assertNotIn("child_process", M.PROTOCOL_JS)
        self.assertNotIn(".kill(", M.PROTOCOL_JS)

    def test_protocol_requires_exact_router_supervisor_sealed_node_tree(self):
        peers = {
            101: {"pid": 101, "parentPid": 90, "executable": "/route/router", "kernelImageSha256": "a" * 64, "uids": [1000] * 4},
            102: {"pid": 102, "parentPid": 101, "executable": "/route/router", "kernelImageSha256": "a" * 64, "uids": [1000] * 4},
            103: {"pid": 103, "parentPid": 102, "executable": "/memfd:creator-hub-node (deleted)", "kernelImageSha256": "b" * 64, "uids": [1000] * 4}}
        actual = M.validate_protocol_processes(peers, 101, "/route/router", "a" * 64, "b" * 64, 1000, 90)
        self.assertEqual(actual["node"]["pid"], 103)
        for pid in peers:
            for field, value in (("parentPid", 999), ("executable", "/usr/bin/creator-hub"), ("kernelImageSha256", "0" * 64), ("uids", [999] * 4)):
                altered = copy.deepcopy(peers); altered[pid][field] = value
                with self.subTest(pid=pid, field=field), self.assertRaises(RuntimeError):
                    M.validate_protocol_processes(altered, 101, "/route/router", "a" * 64, "b" * 64, 1000, 90)
        with self.assertRaises(RuntimeError):
            M.validate_protocol_processes({**peers, 104: peers[103]}, 101, "/route/router", "a" * 64, "b" * 64, 1000, 90)

    def test_protocol_is_after_normal_close_and_preservation_is_rechecked(self):
        source = (HERE / "native-linux-integrated-migration.py").read_text()
        run = source.split("def run(", 1)[1]
        self.assertLess(run.index("session.close(); session = None"), run.index("protocol_smoke(root"))
        self.assertLess(run.index("protocol_smoke(root"), run.index('report["afterProtocol"] = preserved'))
        self.assertLess(run.index('report["afterProtocol"] = preserved'), run.index('"reopened"'))
        smoke = source.split("def protocol_smoke(", 1)[1].split("def run(", 1)[0]
        self.assertIn('report["first"]["normalCloseObserved"] is True', smoke)
        self.assertIn("validate_protocol_processes", smoke)
        self.assertIn("pass_fds=fds", smoke)
        self.assertIn("finish_protocol_processes(child, pidfds", smoke)
        self.assertIn('os.getuid(), 0o500)', smoke)
        self.assertNotIn(".kill(", smoke)
        self.assertNotIn(".terminate(", smoke)
        self.assertNotIn("pidfd_send_signal", smoke)
        lock = (HERE.parent / "modules/mcp/package-lock.json").read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(M.digest(lock), M.SDK_LOCK_SHA)
        workflow = WORKFLOW.read_text()
        self.assertIn(M.SDK_LOCK_SHA, workflow)
        self.assertIn("npm ci --prefix modules/mcp --ignore-scripts --no-audit --no-fund", workflow)

    def test_protocol_reaps_own_router_before_requiring_proc_absence(self):
        child, pages, order = mock.Mock(), mock.Mock(), []
        def reap(**kwargs):
            self.assertEqual(kwargs, {"timeout": 0})
            order.append("reaped-router")
            return 0
        child.wait.side_effect = reap
        pages.wait.side_effect = lambda check, _: M.require(check(), "Exit not observed")
        identities = {name: {"pid": pid} for name, pid in (("router", 101), ("supervisor", 102), ("node", 103))}
        def exists(path):
            self.assertIn("reaped-router", order)
            order.append(str(path))
            return False
        with mock.patch.object(M.select, "select", side_effect=lambda fds, *_: (fds, [], [])), mock.patch.object(Path, "exists", exists):
            result = M.finish_protocol_processes(child, {"router": 7, "supervisor": 8, "node": 9}, identities, pages)
        self.assertEqual(result, {"routerExitCode": 0, "pidfdExitObserved": {"router": True, "supervisor": True, "node": True}})
        self.assertEqual(order[0], "reaped-router")
        child.wait.assert_called_once_with(timeout=0)
        with mock.patch.object(M.select, "select", return_value=([], [], [])), self.assertRaises(RuntimeError):
            M.finish_protocol_processes(child, {"router": 7}, identities, pages)

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
        for required in (M.SOURCE, M.HELPER_SOURCE, M.OLD["source"], M.OLD["sha256"], M.OLD["serverSha256"], "39134487363", "12139109123", "63874630", "3ac7fdd5cedf85df41844c32c7dcdeb180ca14fc66a7f6e274c1ace5fc5e39b8"):
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
