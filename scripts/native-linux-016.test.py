"""Pure 016 harness regressions. No packages, product, native GUI or network run."""
import ast
import copy
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


S = load("native-linux-016-stage")
P = load("native-linux-016-pages")
REAL_FINGERPRINT = P.fingerprint


def log_fixture_fingerprint(file):
    value = REAL_FINGERPRINT(file)
    # Windows chmod does not expose Unix owner-only bits. Model just those
    # metadata bits here; Linux preflight measures the real mode unchanged.
    if sys.platform == "win32":
        value["mode"] = 0o600
    return value


def profile():
    return {"schemaVersion": 1, "mode": "pages", "assembly": {"sourceCommit": "a" * 40,
            "runId": 1, "runAttempt": 1, "jobId": 2, "artifactId": 3, "zipBytes": 40, "zipSha256": "b" * 64},
            "pins": {key: {"size": 1, "sha256": "c" * 64} for key in S.PINS}}


def pin(raw):
    return {"size": len(raw), "sha256": S.digest(raw)}


def tar(rows):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data, mode, kind in rows:
            row = tarfile.TarInfo(name)
            row.uid = row.gid = 0
            row.mode, row.type = mode, kind
            row.size = len(data) if kind == tarfile.REGTYPE else 0
            archive.addfile(row, io.BytesIO(data))
    return output.getvalue()


def resources():
    rows = [("mcp/server/creator-works-mcp.mjs", b"// fixture\n", 0o644, tarfile.REGTYPE),
            ("setup/creator-project-setup", b"fake setup", 0o755, tarfile.REGTYPE),
            ("routing/creator-hub-mcp-router", b"fake router", 0o755, tarfile.REGTYPE)]
    raw = gzip.compress(tar(rows))
    hashes = {name: S.digest(data) for name, data, _, _ in rows}
    manifest = {"modules": {"mcp": {"files": {rows[0][0]: hashes[rows[0][0]]}},
                             "setup": {"files": {rows[1][0]: hashes[rows[1][0]]}}},
                "managedRouting": {"files": {rows[2][0]: hashes[rows[2][0]]}},
                "payloadArchive": {"schemaVersion": 1, "file": "modules.tar.gz", **pin(raw),
                                   "files": {name: {"size": len(data), "mode": mode} for name, data, mode, _ in rows},
                                   "unpackedSize": sum(len(row[1]) for row in rows)}}
    return raw, manifest, rows


class Wait:
    @staticmethod
    def wait(condition, *_):
        if not condition():
            raise RuntimeError("Fixture condition did not pass")


class Driver:
    def __init__(self, reopened=False):
        self.open, self.clicked, self.feature = not reopened, [], None

    def read(self, selector, field="text"):
        if selector == "#view-projects":
            return True
        if selector == "#view-hub":
            return False
        if selector == "#projects-home-title":
            return "Projects"
        if selector == "#unified-home-updater":
            return True
        if selector == "#convergence-dialog":
            return "" if self.open else None
        if selector == "#convergence-title":
            return "Move to Hub"
        if selector == "#convergence-move":
            return True
        if selector == "#convergence-later":
            return "Not now"
        if selector == "#convergence-error":
            return ""
        if selector in ("#convergence-prepare", "#convergence-connections", "#convergence-retire"):
            return False
        if selector.startswith("#project-list"):
            return True if field == "displayed" else "Selected for MCP MCP bridge not installed"
        if selector.startswith("#suite-menu"):
            return True
        if selector == "#feature-" + str(self.feature):
            return "false"
        if selector.endswith('[data-field="status"]'):
            return "Ready"
        if selector.endswith('[data-field="error"]'):
            return ""
        if selector.endswith('[data-field="controls"]'):
            return None
        if selector.endswith(".feature-project-select"):
            return "true"
        if selector.endswith(".feature-project-meta"):
            return "Selected for MCP Bridge not installed"
        raise AssertionError((selector, field))

    def click(self, selector):
        self.clicked.append(selector)
        if selector == "#convergence-later":
            self.open = False
        if selector.startswith("#suite-menu"):
            self.feature = "mcp" if '"mcp"' in selector else "setup"

    def call(self, method, route):
        assert (method, route) == ("GET", "/window/handles")
        return ["one"]

    def elements(self, selector):
        if selector == '#project-list .project-row[data-mcp-selected="true"]':
            return ["selected"]
        assert selector == "iframe,object,embed"
        return []


class Pure016(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "Real Unix owner/mode/link and FIFO guards execute in native Linux preflight")
    def test_page_journal_refuses_links_fifo_and_oversize_before_open(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); file = home / P.JOURNAL; file.parent.mkdir(parents=True)
            target = home / "target"; target.write_bytes(b"{}"); target.chmod(0o644)
            for kind in ("symlink", "fifo", "oversize"):
                if kind == "symlink":
                    file.symlink_to(target)
                elif kind == "fifo":
                    os.mkfifo(file)
                else:
                    with file.open("wb") as output:
                        output.truncate(65537)
                    file.chmod(0o644)
                with self.subTest(kind=kind), patch.object(P.os, "open", side_effect=AssertionError("Must refuse before open")), \
                        self.assertRaises(RuntimeError):
                    P.page_journal(home, {"revision": 1, "records": []})
                file.unlink()

    def test_page_journal_allows_only_exact_successful_reads_and_preserves_earlier_records(self):
        def append(previous, session):
            return {"revision": 1, "records": previous["records"] + [
                {"session": session, "id": operation, "command": command, "outcome": "returned-ok"}
                for command, operation in (("load_config", 3), ("discover_unity_projects", 4))]}
        empty = {"revision": 1, "records": []}; first = append(empty, "a" * 64); second = append(first, "b" * 64)
        P.validate_page_journal(first, empty); P.validate_page_journal(second, first)
        for mutation in (lambda v: v.update(revision=True), lambda v: v.update(extra=True),
                         lambda v: v["records"][0].update(command="save_config"),
                         lambda v: v["records"][0].update(id=True),
                         lambda v: v["records"][0].update(outcome="accepted"),
                         lambda v: v["records"][0].update(outcome="returned-error"),
                         lambda v: v["records"][0].update(extra=True),
                         lambda v: v["records"][1].update(session="b" * 64),
                         lambda v: v["records"].append(v["records"][0])):
            bad = copy.deepcopy(first); mutation(bad)
            with self.assertRaises(RuntimeError):
                P.validate_page_journal(bad, empty)
        changed = copy.deepcopy(second); changed["records"][0]["outcome"] = "returned-error"
        with self.assertRaisesRegex(RuntimeError, "Earlier outcome"):
            P.validate_page_journal(changed, first)
        with self.assertRaisesRegex(RuntimeError, "session"):
            P.validate_page_journal(append(first, "a" * 64), first)

    def test_preservation_failure_retains_exact_changed_fixture_identity_and_text(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); file = home / "synthetic.json"
            file.write_text('{"kept":1}', encoding="utf-8")
            before = {"synthetic.json": P.fingerprint(file)}
            file.write_text('{"kept":2}', encoding="utf-8")
            evidence = {}
            with self.assertRaisesRegex(RuntimeError, "changed: synthetic.json"):
                P.preserved(home, before, evidence)
            self.assertEqual(evidence["changed"], ["synthetic.json"])
            self.assertEqual(evidence["files"]["synthetic.json"], P.fingerprint(file))
            self.assertEqual(evidence["changedSyntheticText"]["synthetic.json"], '{"kept":2}')
            self.assertEqual(file.read_text(encoding="utf-8"), '{"kept":2}')

    def test_dynamic_single_visible_waits_for_presence_not_strict_element_read(self):
        d = Driver(); calls = []
        def absent(selector):
            calls.append(selector)
            return []
        d.elements = absent
        self.assertFalse(P.single_visible(d, "not-created"))
        self.assertEqual(calls, ["not-created"])
        d.elements = lambda _: ["first", "second"]
        with self.assertRaisesRegex(RuntimeError, "Ambiguous readiness"):
            P.single_visible(d, "not-created")
        d = Driver()
        self.assertTrue(P.single_visible(d, '#project-list .project-row[data-mcp-selected="true"]'))

    def test_failure_ui_is_read_only_fixed_scoped_and_bounded(self):
        class DiagnosticDriver:
            def elements(self, selector):
                return ["selected"] if selector != "#convergence-error" else []
            def read(self, selector, endpoint):
                return "x" * 4096
        result = P.failure_ui(DiagnosticDriver())
        self.assertEqual(result["#convergence-error"], None)
        self.assertEqual(result["projectRows"], 1)
        self.assertEqual(result["selectedRows"], 1)
        self.assertEqual(len(result["#project-status"]), 2048)
        self.assertLess(len(json.dumps(result)), 12000)

    def test_ui_capture_failure_does_not_skip_owned_bitmap_or_mask_original_error(self):
        result = {"error": "original operation refused"}; calls = []
        def bitmap():
            calls.append("owned bitmap")
            return {"nonblank": True}
        with patch.object(P, "failure_ui", side_effect=RuntimeError("driver unavailable")):
            P.capture_failure(None, result, bitmap)
        self.assertEqual(calls, ["owned bitmap"])
        self.assertEqual(result["failureUiError"], "driver unavailable")
        self.assertEqual(result["failureSurface"], {"nonblank": True})
        self.assertEqual(result["error"], "original operation refused")
        with patch.object(P, "failure_ui", return_value={"projectRows": 1}):
            P.capture_failure(None, result, lambda: (_ for _ in ()).throw(RuntimeError("ownership refused")))
        self.assertEqual(result["failureSurfaceError"], "ownership refused")
        self.assertEqual(result["error"], "original operation refused")

    def test_startup_wait_absent_empty_singleton_without_action_retry(self):
        class X11:
            display = 1
            class x:
                @staticmethod
                def XDefaultRootWindow(display):
                    assert display == 1
                    return 2
            def property(self, root, name):
                self.asserted = (root, name)
                return self.value
        x11 = X11(); evidence = {"attempts": 0}; guards = []
        for value, expected in ((None, None), ((33, 32, []), None), ((33, 32, [123]), 123)):
            x11.value = value
            self.assertEqual(P.startup_client_id(x11, lambda: guards.append("checked"), evidence), expected)
            self.assertEqual(x11.asserted, (2, "_NET_CLIENT_LIST_STACKING"))
            self.assertEqual(evidence["property"], None if value is None else
                             {"type": 33, "format": 32, "count": len(value[2]), "data": value[2]})
            self.assertTrue(evidence["identitiesVerified"])
        self.assertEqual(evidence["attempts"], 3)
        self.assertEqual(len(guards), 6)

    def test_startup_wait_rejects_malformed_and_multiple_windows(self):
        class X11:
            display = 1
            class x:
                XDefaultRootWindow = staticmethod(lambda _: 2)
            def property(self, *_):
                return self.value
        x11 = X11()
        for value in ((6, 32, []), (33, 8, b"text"), (33, 32, [1, 2]), (33, 32, [1, 1]),
                      (33, 32, [False]), (33, 32, [0]), (33, 32, [2**32]), (33, 32, (1,)),
                      [33, 32, []], (33, 32)):
            x11.value = value; evidence = {"attempts": 0}
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "startup WM"):
                P.startup_client_id(x11, lambda: None, evidence)
            self.assertIn("startup WM", evidence["error"])
            json.dumps(evidence)

    def test_startup_wait_records_process_drift_and_query_refusal(self):
        class X11:
            display = 1
            class x:
                XDefaultRootWindow = staticmethod(lambda _: 2)
            def property(self, *_):
                if self.error:
                    raise RuntimeError("bounded X query refused")
                return (33, 32, [])
        x11 = X11()
        for fail_at in (1, 2):
            calls = []
            def guard():
                calls.append(True)
                if len(calls) == fail_at:
                    raise RuntimeError("process identity changed")
            x11.error = False; evidence = {"attempts": 0}
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                P.startup_client_id(x11, guard, evidence)
            self.assertFalse(evidence["identitiesVerified"])
            self.assertEqual(evidence["attempts"], 1)
        x11.error = True; evidence = {"attempts": 0}
        with self.assertRaisesRegex(RuntimeError, "X query refused"):
            P.startup_client_id(x11, lambda: None, evidence)
        self.assertEqual(evidence["error"], "bounded X query refused")
        self.assertFalse(evidence["identitiesVerified"])

    def test_startup_wait_deadline_keeps_last_empty_observation(self):
        pages = load("native-linux-integrated-pages")
        class X11:
            display = 1
            class x:
                XDefaultRootWindow = staticmethod(lambda _: 2)
            def property(self, *_):
                return (33, 32, [])
        evidence = {"attempts": 0}
        with patch.object(pages.time, "monotonic", side_effect=[0, 0, 2]), patch.object(pages.time, "sleep"), \
                self.assertRaisesRegex(RuntimeError, "readiness deadline"):
            pages.wait(lambda: P.startup_client_id(X11(), lambda: None, evidence), 1)
        self.assertEqual(evidence["attempts"], 1)
        self.assertEqual(evidence["property"], {"type": 33, "format": 32, "count": 0, "data": []})
        self.assertTrue(evidence["identitiesVerified"])

    def test_profile_exact_fields_modes_pins(self):
        S.profile(profile())
        for mode in ("pages", "migration-cancel"):
            p = profile(); p["mode"] = mode; S.profile(p)
        for mutation in (lambda p: p.update(mode="migration-approve"), lambda p: p.update(version="0.1.15"),
                         lambda p: p["assembly"].update(runAttempt=True), lambda p: p["assembly"].update(zipBytes=301 * 1024**2),
                         lambda p: p["assembly"].update(sourceCommit="x" * 40), lambda p: p["pins"]["hub"].update(size=0),
                         lambda p: p["pins"]["hub"].update(path="/tmp/app")):
            with self.subTest(mutation=mutation):
                p = profile(); mutation(p)
                with self.assertRaises(RuntimeError):
                    S.profile(p)

    def test_strict_json(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'):
            with self.assertRaises(RuntimeError):
                S.parse(raw)

    def test_safe_archive_paths(self):
        for name in ("../x", "/usr/bin/x", "a//b", "a/./b", "a\\b", "a:\\b", "x\n", ""):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                S.safe_name(name)

    def test_modules_exact_inventory(self):
        raw, manifest, rows = resources()
        hashes = S.modules(io.BytesIO(raw), manifest)
        self.assertEqual(hashes[rows[0][0]], S.digest(rows[0][1]))
        self.assertEqual(len(hashes), 3)

    def test_modules_colliding_maps_refused(self):
        raw, manifest, rows = resources()
        manifest["modules"]["setup"]["files"][rows[0][0]] = S.digest(rows[0][1])
        with self.assertRaises(RuntimeError):
            S.modules(io.BytesIO(raw), manifest)

    def test_modules_after_end_marker_refused(self):
        raw, manifest, _ = resources()
        hidden = gzip.compress(gzip.decompress(raw) + b"hidden payload")
        with self.assertRaises(RuntimeError):
            S.modules(io.BytesIO(hidden), manifest)

    def test_modules_wrong_digest_mode_owner_and_links(self):
        raw, manifest, rows = resources()
        bad = copy.deepcopy(manifest); bad["modules"]["mcp"]["files"][rows[0][0]] = "0" * 64
        with self.assertRaises(RuntimeError):
            S.modules(io.BytesIO(raw), bad)
        for mode, kind in ((0o777, tarfile.REGTYPE), (0o644, tarfile.SYMTYPE)):
            changed = [(rows[0][0], rows[0][1], mode, kind), *rows[1:]]
            with self.assertRaises(RuntimeError):
                S.modules(io.BytesIO(gzip.compress(tar(changed))), manifest)

    def test_zip_independent_pins_before_write(self):
        selected = {name: key.encode() for key, name in S.MEMBERS.items()}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for name, data in selected.items():
                archive.writestr(name, data)
        p = profile(); p["assembly"].update(zipBytes=len(output.getvalue()), zipSha256=S.digest(output.getvalue()))
        for key, name in S.MEMBERS.items():
            p["pins"][key] = pin(selected[name])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); file = root / "source.zip"; file.write_bytes(output.getvalue())
            target = root / "valid"; target.mkdir()
            S.stage_zip(file, target, p)
            self.assertEqual(len(list(target.iterdir())), len(selected))
            bad = copy.deepcopy(p); bad["pins"]["deb"]["sha256"] = "0" * 64
            target = root / "invalid"; target.mkdir()
            with self.assertRaises(RuntimeError):
                S.stage_zip(file, target, bad)
            self.assertEqual(list(target.iterdir()), [])

    def test_deb_installed_elf_resources_all_independently_bound(self):
        p = profile(); embedded = b'{"manifest":"fixture"}'
        values = {name: key.encode() for key, name in S.DEB_MEMBERS.items()}
        values[S.DEB_MEMBERS["hub"]] = b"\x7fELF\x02\x01" + embedded
        for key, name in S.DEB_MEMBERS.items():
            p["pins"][key] = pin(values[name])
        rows = [(name, data, 0o755 if name in (S.DEB_MEMBERS["hub"], S.DEB_MEMBERS["helper"]) else 0o644, tarfile.REGTYPE)
                for name, data in values.items()]
        self.assertEqual(len(S.inspect_deb(tar(rows), p, embedded, {})), len(rows))
        with self.assertRaises(RuntimeError):
            S.inspect_deb(tar(rows), p, b"other manifest", {})
        with self.assertRaises(RuntimeError):
            S.inspect_deb(tar(rows + [("usr/bin/unknown", b"unknown", 0o755, tarfile.REGTYPE)]), p, embedded, {})

    def test_fixtures_real_hub_setup_paths_sdk_and_unique_cancel_project(self):
        # Unknown Hub fields are not GUI-valid; the prior retirement-only fixture
        # deliberately exercises preservation of unsupported/future preferences.
        with tempfile.TemporaryDirectory() as directory, patch.object(P, "fingerprint", lambda f: pin(f.read_bytes())):
            root = Path(directory); before = P.fixtures(root, "migration-cancel"); home = root / "home"
            prefs = S.parse((home / "data/CreatorHub/preferences/hub-preferences.json").read_bytes())
            self.assertEqual(set(prefs), {"schemaVersion", "preview", "autoDownload", "restoreHostedViews"})
            self.assertIn("data/CreatorProjectSetup/editor-roots.json", before)
            current = S.parse((home / "config/creator-works-mcp/launcher-config.json").read_bytes())
            legacy = S.parse((home / "config/banter-mcp/launcher-config.json").read_bytes())
            self.assertEqual(current["active_channel_id"], "current")
            self.assertFalse(current["auto_start"]); self.assertTrue(legacy["auto_start"])
            self.assertEqual(len(current["channels"]), 1); self.assertEqual(len(legacy["channels"]), 2)
            self.assertNotEqual(legacy["channels"][0]["unity_project_path"], legacy["channels"][1]["unity_project_path"])
            sdk = S.parse((home / "current-project/Packages/manifest.json").read_bytes())
            self.assertEqual(sdk["dependencies"], {"com.sidequest.creator-sdk": "4.0.14"})
            self.assertTrue((home / "legacy-project/ProjectSettings/ProjectVersion.txt").is_file())

    def test_one_guide_cancel_clicks_once_never_approve(self):
        d = Driver(); self.assertEqual(P.current_ui(d, Wait, "migration-cancel", False), {"oneGuideDeferred": True, "reminderSuppressionObserved": False})
        self.assertEqual(d.clicked, ["#convergence-later"])
        d = Driver(reopened=True); P.current_ui(d, Wait, "migration-cancel", True)
        self.assertEqual(d.clicked, [])

    def test_reopen_does_not_accept_a_temporarily_closed_guide_before_startup(self):
        d = Driver(reopened=True); read = d.read
        def pending(selector, field="text"):
            if selector.startswith("#project-list"):
                d.open = True
            return read(selector, field)
        d.read = pending
        with self.assertRaisesRegex(RuntimeError, "reopened after startup"):
            P.current_ui(d, Wait, "migration-cancel", True)
        self.assertEqual(d.clicked, [])

    def test_owned_empty_startup_logs_include_stat_size_and_digest(self):
        class Capture:
            def pump(self):
                pass
            def metadata(self):
                return {name: {"bytes": len(raw), "retainedBytes": len(raw), "eof": True, "truncated": False}
                        for name, raw in values.items()}
        values = {"stdout": b"", "stderr": b"could not create default EGL display\n"}
        with tempfile.TemporaryDirectory() as directory, patch.object(P, "fingerprint", side_effect=log_fixture_fingerprint), \
                patch.object(P.os, "getuid", return_value=0 if sys.platform == "win32" else os.getuid(), create=True), \
                patch.object(P.os, "getgid", return_value=0 if sys.platform == "win32" else os.getgid(), create=True):
            root = Path(directory)
            for name, raw in values.items():
                file = root / ("driver." + name); S.write(file, raw)
            P.check_logs(Capture()); report = P.log_evidence(Capture(), root)
            for name, raw in values.items():
                self.assertEqual(report[name]["file"]["sha256"], S.digest(raw))
                self.assertEqual(report[name]["file"]["size"], len(raw))
                self.assertEqual(report[name]["file"]["mode"], 0o600)
                self.assertEqual(report[name]["limitBytes"], 262144)

    def test_owned_overflow_is_bounded_reported_retained_and_fails(self):
        class Capture:
            def pump(self):
                pass
            def metadata(self):
                return {name: {"bytes": P.LOG_LIMIT + 1, "retainedBytes": P.LOG_LIMIT, "eof": False, "truncated": True}
                        for name in ("stdout", "stderr")}
        with tempfile.TemporaryDirectory() as directory, patch.object(P, "fingerprint", side_effect=log_fixture_fingerprint), \
                patch.object(P.os, "getuid", return_value=0 if sys.platform == "win32" else os.getuid(), create=True), \
                patch.object(P.os, "getgid", return_value=0 if sys.platform == "win32" else os.getgid(), create=True):
            root = Path(directory)
            for name in ("stdout", "stderr"):
                S.write(root / ("driver." + name), b"x" * P.LOG_LIMIT)
            with self.assertRaisesRegex(RuntimeError, "exceeded 256 KiB"):
                P.check_logs(Capture())
            report = P.log_evidence(Capture(), root)
            self.assertTrue(report["stderr"]["truncated"])
            self.assertEqual(report["stderr"]["bytes"], P.LOG_LIMIT + 1)
            self.assertEqual(report["stderr"]["file"]["size"], P.LOG_LIMIT)

    def test_readiness_and_native_guards_have_no_driver_calls_or_mutators(self):
        tree = ast.parse((HERE / "native-linux-016-pages.py").read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "session")
        guards = {n.name: n for n in ast.walk(session) if isinstance(n, ast.FunctionDef)
                  and n.name in ("bootstrap_guard", "session_guard", "guard")}
        self.assertEqual(set(guards), {"bootstrap_guard", "session_guard", "guard"})
        allowed = {"check_logs", "require", "bootstrap_guard", "child.poll", "native.native_process", "pages.listener",
                   "native.client_ids", "helper.bound_window", "pages.subtree"}
        for name, node in guards.items():
            for call in (n for n in ast.walk(node) if isinstance(n, ast.Call)):
                self.assertIn(ast.unparse(call.func), allowed, name)
        source = ast.unparse(session)
        self.assertLess(source.index("d.guard = bootstrap_guard"), source.index("pages.wait(available)"))
        self.assertLess(source.index("d.guard = session_guard"), source.index("d.request('POST', '/session'"))

    def test_reused_driver_status_request_checks_guards_on_both_sides_without_network(self):
        driver_module = load("native-linux-integrated-pages")
        d = driver_module.Driver(); calls = []
        raw = b'{"value":{"ready":true}}'
        class Response:
            status, headers = 200, {"Content-Length": str(len(raw))}
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, limit):
                return raw[:limit]
        class HTTP:
            def open(self, request, timeout):
                calls.append((request.method, request.full_url)); return Response()
        d.guard = lambda: calls.append("guard"); d.http = HTTP()
        self.assertEqual(d.request("GET", "/status"), {"ready": True})
        self.assertEqual(calls, ["guard", ("GET", "http://127.0.0.1:4444/status"), "guard"])

    def test_current_pages_use_menu_and_selection_bridge_labels(self):
        d = Driver(); self.assertEqual(P.current_ui(d, Wait, "pages", False), {"mcp": {"ready": True}, "setup": {"ready": True}})
        self.assertEqual(d.clicked, ["#convergence-later", "#suite-trigger", '#suite-menu [data-view="mcp"]',
                                     "#suite-trigger", '#suite-menu [data-view="setup"]'])

    def test_obsolete_guide_wrong_page_nested_document_refused(self):
        for selector, value in (("#convergence-title", "Move to unified Creator Hub"), ("#convergence-prepare", True),
                                ("#projects-home-title", "Apps")):
            d = Driver(); original = d.read
            d.read = lambda s, field="text": value if s == selector else original(s, field)
            with self.assertRaises(RuntimeError):
                P.current_ui(d, Wait, "migration-cancel", False)
        d = Driver(); d.elements = lambda _: ["nested"]
        with self.assertRaises(RuntimeError):
            P.current_ui(d, Wait, "pages", False)

    def test_acceptance_flags_do_not_claim_approval_update_restart_flatpak_release(self):
        self.assertTrue(all(value is False for value in P.FLAGS.values()))
        source = (HERE / "native-linux-016-pages.py").read_text()
        for flag in ("migrationAccepted", "nativeMigrationCancellationAccepted", "standaloneRetirementAccepted", "signedUpdateAccepted", "automaticRestartAccepted", "flatpakAccepted", "releaseReady"):
            self.assertNotIn(f'report["{flag}"] = True', source)
        self.assertIn('"migrationApprovalImplemented": False', source)

    def test_new_python_ast_and_neutral_helper_boundary(self):
        for name in ("native-linux-016-stage", "native-linux-016-pages", "native-linux-016.test"):
            ast.parse((HERE / (name + ".py")).read_text(), filename=name)
        source = (HERE / "native-linux-016-pages.py").read_text()
        for forbidden in ("pages.run(", "pages.admission(", "pages.fixtures(", "pages.defer_migration(", "#entry-mcp", "execute/sync", "force-kill", "SIGKILL"):
            self.assertNotIn(forbidden, source)
        self.assertIn("Gdk.init([])", source)
        self.assertIn('driver_identity["kernelImageSha256"] == driver_pin["sha256"]', source)

    def test_pre_apt_neutral_transport_process_capture_method_contracts(self):
        # Parse, do not import or execute the native/platform helpers.
        def functions(file, owner=None):
            tree = ast.parse((HERE / file).read_text())
            body = tree.body if owner is None else next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == owner).body
            return {n.name: [arg.arg for arg in n.args.args] for n in body if isinstance(n, ast.FunctionDef)}
        actual = functions("native-linux-integrated-pages.py", "Driver")
        for method, args in {"read": ["self", "selector", "endpoint"], "click": ["self", "selector"],
                             "elements": ["self", "selector"], "call": ["self", "method", "suffix", "value"],
                             "request": ["self", "method", "suffix", "payload", "limit"]}.items():
            self.assertEqual(actual[method], args)
        actual = functions("native-linux-integrated-pages.py")
        for method, args in {"wait": ["check", "seconds"], "pinned": ["file", "expected", "uid", "mode"],
                             "listener": ["pid", "port"], "subtree": ["pid", "helper", "native"]}.items():
            self.assertEqual(actual[method], args)
        actual = functions("native-linux-root-probe.py")
        self.assertEqual(actual["bitmap"], ["request", "root", "helper", "x11"])
        self.assertEqual(actual["native_process"], ["pid", "helper", "full"])
        self.assertEqual(functions("native-unix-window.py", "X11")["close_window"], ["self", "window", "expected"])
        source = (HERE / "native-linux-root-probe.py").read_text()
        self.assertIn("MAX_LOG, MAX_JSON = 262144, 196608", source)
        self.assertEqual(functions("native-linux-root-probe.py", "Capture")["pump"], ["self", "wait"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
