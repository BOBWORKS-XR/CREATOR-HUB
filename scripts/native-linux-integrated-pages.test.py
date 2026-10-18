"""Portable, synthetic tests only: no GUI, driver, install or native libraries."""
import copy
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("integrated_pages", HERE / "native-linux-integrated-pages.py")
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
ENV = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/validation/linux-integrated-pages",
       "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
       "CREATOR_LINUX_INTEGRATED_PAGES": "1", "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}


class Response:
    def __init__(self, body=b'{"value":null}', status=200, length=None):
        self.body, self.status = body, status
        self.headers = {} if length is None else {"Content-Length": length}
        self.reads = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, size):
        self.reads.append(size)
        return self.body[:size]


class PagesTests(unittest.TestCase):
    def test_only_exact_disposable_branch_admission(self):
        M.admission(ENV, "linux", "x86_64")
        M.admission({**ENV, "GITHUB_EVENT_NAME": "push"}, "linux", "x86_64")
        for key in ENV:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: "wrong"}, "linux", "x86_64")
        for event in ("pull_request", "schedule"):
            with self.subTest(event=event), self.assertRaises(RuntimeError):
                M.admission({**ENV, "GITHUB_EVENT_NAME": event}, "linux", "x86_64")

    def test_native_platform_is_not_an_environment_override(self):
        for system, machine in (("win32", "x86_64"), ("linux", "aarch64"), ("darwin", "x86_64")):
            with self.subTest(system=system, machine=machine), self.assertRaises(RuntimeError):
                M.admission(ENV, system, machine)

    def test_inherited_runtime_injections_refuse(self):
        for key in ("LD_PRELOAD", "PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "WEBKIT_INSPECTOR_SERVER",
                    "TAURI_WEBVIEW_AUTOMATION", "TAURI_SIGNING_PRIVATE_KEY", "CREATOR_HUB_SIGNING_KEY", "SSL_CERT_FILE"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**ENV, key: "refused"}, "linux", "x86_64")

    def test_main_refuses_before_any_file_process_or_native_import(self):
        with patch.dict(M.os.environ, ENV, clear=True), patch.object(M.sys, "platform", "win32"), \
                patch.object(M, "helpers") as helpers, patch.object(M, "record") as record, \
                patch.object(M.subprocess, "Popen") as launch:
            with self.assertRaises(RuntimeError):
                M.main()
            helpers.assert_not_called(); record.assert_not_called(); launch.assert_not_called()

    def test_duplicate_nonfinite_and_invalid_json_reject(self):
        for raw in (b'{"value":1,"value":2}', b'{"value":NaN}', b'{"value":Infinity}', b'not json'):
            with self.subTest(raw=raw), self.assertRaises((RuntimeError, ValueError)):
                M.parse(raw)

    def driver(self, response):
        driver = M.Driver()
        driver.http = Mock()
        driver.http.open.return_value = response
        driver.guard = Mock()
        return driver

    def test_http_is_loopback_bounded_and_guarded_without_retries(self):
        response = Response(b'{"value":{"ready":true}}')
        driver = self.driver(response)
        self.assertEqual(driver.request("GET", "/status"), {"ready": True})
        args, kwargs = driver.http.open.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:4444/status")
        self.assertEqual(kwargs, {"timeout": 15})
        self.assertEqual(response.reads, [131073])
        self.assertEqual(driver.guard.call_count, 2)
        self.assertEqual(driver.http.open.call_count, 1)

    def test_null_success_is_not_a_process_exit_claim(self):
        self.assertIsNone(self.driver(Response()).request("DELETE", "/session/one"))

    def test_http_outcomes_reject_overflow_truncation_errors_and_unknown_shapes(self):
        for response in (Response(b'x' * 131073), Response(b''), Response(b'{"value":null}', length="999999"),
                         Response(length="invalid"), Response(length="1"), Response(status=204),
                         Response(b'{"value":{"error":"invalid session id"}}'), Response(b'{"unexpected":true}'),
                         Response(b'[]'), Response(b'{"value":null,"value":true}')):
            with self.subTest(response=response), self.assertRaises((RuntimeError, ValueError)):
                self.driver(response).request("POST", "/session/one/element/two/click", {})

    def test_unknown_mutation_outcome_is_never_retried(self):
        driver = self.driver(Response())
        driver.http.open.side_effect = TimeoutError("unknown click outcome")
        with self.assertRaises(TimeoutError):
            driver.request("POST", "/session/one/element/two/click", {})
        self.assertEqual(driver.http.open.call_count, 1)

    def test_redirect_and_proxy_routes_are_not_admitted(self):
        with self.assertRaises(RuntimeError):
            M.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "http://elsewhere/")
        with patch.object(M.urllib.request, "build_opener") as build:
            M.Driver()
            self.assertEqual(build.call_args.args[0].proxies, {})

    def test_bad_path_verb_and_oversized_input_refuse_before_http(self):
        for method, suffix, body in (("PUT", "/status", None), ("GET", "//elsewhere:80/", None),
                                     ("GET", "/../status", None), ("POST", "/session", {"large": "x" * 16385})):
            driver = self.driver(Response())
            with self.subTest(suffix=suffix), self.assertRaises(RuntimeError):
                driver.request(method, suffix, body)
            driver.http.open.assert_not_called()

    def test_finite_element_inventory_and_exact_selection(self):
        driver = M.Driver()
        driver.call = Mock(return_value=[{"element-6066-11e4-a52e-4f735466cecf": "node-1"}])
        self.assertEqual(driver.element("#one"), "node-1")
        for value in ([], [None], {}, [{"wrong": "node-1"}], [{"element-6066-11e4-a52e-4f735466cecf": "../bad"}],
                      [{"element-6066-11e4-a52e-4f735466cecf": "node-1"}] * 65):
            driver.call.return_value = value
            with self.subTest(value=value), self.assertRaises((RuntimeError, AttributeError)):
                driver.element("#one")

    def test_click_requires_visible_and_enabled_without_click_retry(self):
        driver = M.Driver(); driver.read = Mock(side_effect=[True, False]); driver.call = Mock()
        with self.assertRaises(RuntimeError):
            driver.click("#one")
        driver.call.assert_not_called()

    def test_feature_status_requires_ready_without_error_and_enabled(self):
        M.feature_status("Ready", "", True)
        for value in (("Checking", "", True), ("Ready", "error", True), ("Ready", "", False),
                      ("Ready", "", 1), ("Ready", "x" * 2049, True), (None, "", True)):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                M.feature_status(*value)

    def test_parent_pin_numeric_type_hash_owner_mode_are_exact(self):
        expected = {"size": 123, "sha256": "b" * 64}
        actual = {**expected, "uid": 17, "gid": 23, "mode": 0o755}
        with patch.object(M, "record", return_value=actual), patch.object(M.os, "getgid", return_value=23, create=True):
            self.assertEqual(M.pinned("unused", expected, 17, 0o755), actual)
            for update in ({"size": True}, {"sha256": "bad"}, {"size": 124}):
                with self.subTest(update=update), self.assertRaises(RuntimeError):
                    M.pinned("unused", {**expected, **update}, 17, 0o755)
            for uid, mode in ((0, 0o755), (17, 0o777)):
                with self.assertRaises(RuntimeError):
                    M.pinned("unused", expected, uid, mode)

    def test_file_identity_excludes_read_access_time_but_keeps_inode_and_ns_times(self):
        fields = dict(st_dev=1, st_ino=2, st_size=3, st_mode=0o100600, st_uid=4, st_gid=5,
                      st_mtime_ns=6, st_ctime_ns=7, st_atime_ns=8)
        self.assertEqual(M.stamp(SimpleNamespace(**fields)), M.stamp(SimpleNamespace(**{**fields, "st_atime_ns": 99})))
        for key in ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns"):
            with self.subTest(key=key):
                self.assertNotEqual(M.stamp(SimpleNamespace(**fields)), M.stamp(SimpleNamespace(**{**fields, key: 99})))

    def test_fixture_preservation_allows_only_intended_options_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config, before = M.fixtures(root, root / "real-packaged-server.mjs")
            self.assertIsNone(config["active_channel_id"]); self.assertIs(config["auto_start"], False)
            self.assertFalse(config["channels"][0]["enabled"])
            self.assertFalse((root / "home/data/CreatorHub/consent/hub-usage-terms.json").exists())
            M.preserved(root / "home", before, config, "core")
            file = root / "home" / M.CONFIG
            file.write_text(json.dumps({**config, "tool_groups": "read"}), encoding="utf8")
            M.preserved(root / "home", before, config, "read")
            for key, value in (("active_channel_id", "retained"), ("auto_start", True), ("unknownConfig", {}), ("channels", [])):
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    file.write_text(json.dumps({**config, "tool_groups": "read", key: value}), encoding="utf8")
                    M.preserved(root / "home", before, config, "read")
            file.write_text(json.dumps({**config, "tool_groups": "read"}), encoding="utf8")
            (root / "home/config/Claude/claude_desktop_config.json").write_text("{}", encoding="utf8")
            with self.assertRaises(RuntimeError):
                M.preserved(root / "home", before, config, "read")

    def test_png_header_bounds_before_native_decoding(self):
        header = b'\x89PNG\r\n\x1a\n\0\0\0\rIHDR'
        self.assertEqual(M.png_dimensions(header + struct.pack(">II", 940, 580) + b'\0' * 9), (940, 580))
        for data in (b'', header, b'x' * 40, header + struct.pack(">II", 9000, 9000) + b'\0' * 9,
                     header + struct.pack(">II", 940, 580) + b'\0' * (6 * 1024 * 1024)):
            with self.subTest(size=len(data)), self.assertRaises(RuntimeError):
                M.png_dimensions(data)

    def test_source_uses_real_terms_shared_settings_and_direct_pages(self):
        source = (HERE / "native-linux-integrated-pages.py").read_text()
        usage = (HERE.parent / "src/usage-terms.js").read_text()
        native = (HERE.parent / "src-tauri/src/usage_terms.rs").read_text()
        mcp = (HERE.parent / "src/features/mcp.js").read_text()
        self.assertIn(M.POLICY, usage); self.assertIn(M.POLICY, native)
        self.assertIn('join("hub-usage-terms.json")', native)
        self.assertIn('tool_groups: $(\'groups\').value', mcp)
        self.assertIn("if (channel)", mcp)
        self.assertNotIn('/execute', source); self.assertNotIn('do_action', source)
        self.assertNotIn('accept-terms', source); self.assertNotIn('TAURI_WEBVIEW_AUTOMATION=', source)
        self.assertIn('rootExitCode": None', source)
        self.assertLess(source.index('x11.close_window('), source.index('d.call("DELETE", "")'))
        self.assertIn('if report["normalCloseObserved"] and d.session:', source)
        self.assertIn('native.pixel_metrics(', source)
        self.assertTrue(all(v is False for v in M.FALSE_GATES.values()))


if __name__ == "__main__":
    unittest.main()
