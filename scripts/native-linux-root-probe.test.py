"""Pure/temp-only contracts. No Root, installer, user config or real UI is opened."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("native-linux-root-probe.py")
spec = importlib.util.spec_from_file_location("root_probe_under_test", SCRIPT)
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)


def source_fixture():
    return {
        "run": {"id": p.RUN, "run_attempt": 1, "head_sha": p.SOURCE, "status": "completed", "conclusion": "success",
                "repository": {"id": p.REPOSITORY_ID}, "event": "push", "head_branch": "validation/unix-assembly-014",
                "path": ".github/workflows/unix-managed-assembly.yml"},
        "artifact": {"id": p.ARTIFACT, "name": p.ARTIFACT_NAME, "expired": False, "size_in_bytes": p.ZIP_SIZE,
                     "digest": "sha256:" + p.ZIP_SHA,
                     "workflow_run": {"id": p.RUN, "head_sha": p.SOURCE, "repository_id": p.REPOSITORY_ID,
                                      "head_repository_id": p.REPOSITORY_ID}},
        "job": {"id": p.JOB, "run_id": p.RUN, "run_attempt": 1, "conclusion": "success", "name": "assembly (linux, ubuntu-22.04)"},
        "commit": {"sha": p.SOURCE, "tree": {"sha": p.TREE}}, "package": {"name": "creator-hub", "version": "0.1.14"},
        "tauri": {"version": "0.1.14", "productName": "Creator Hub", "identifier": "com.creatorworks.hub",
                  "app": {"windows": [{"title": p.TITLE}]}},
    }


def runner_fixture():
    return {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "GITHUB_REPOSITORY": p.REPOSITORY, "GITHUB_REPOSITORY_ID": str(p.REPOSITORY_ID),
            "CREATOR_LINUX_ROOT_PROBE": "1", "CREATOR_UNIX_WINDOW_TEST": "1"}


class SourceTests(unittest.TestCase):
    def test_exact_reviewed_source_and_original_artifact(self):
        p.validate_source(source_fixture())

    def test_each_source_binding_refuses_mutation(self):
        fields = [("run", "id"), ("run", "run_attempt"), ("run", "head_sha"), ("run", "conclusion"),
                  ("run", "event"), ("run", "head_branch"), ("run", "path"), ("artifact", "id"),
                  ("artifact", "name"), ("artifact", "size_in_bytes"), ("artifact", "digest"), ("artifact", "expired"),
                  ("job", "id"), ("job", "run_id"), ("job", "run_attempt"), ("job", "conclusion"),
                  ("commit", "sha"), ("package", "version"), ("tauri", "version"), ("tauri", "identifier")]
        for section, key in fields:
            with self.subTest(section=section, key=key):
                fixture = source_fixture()
                fixture[section][key] = "foreign"
                with self.assertRaises(RuntimeError):
                    p.validate_source(fixture)

    def test_foreign_tree_repository_artifact_source_and_window_refuse(self):
        for change in (lambda v: v["commit"]["tree"].update(sha="f" * 40),
                       lambda v: v["run"]["repository"].update(id=1),
                       lambda v: v["artifact"]["workflow_run"].update(head_repository_id=1),
                       lambda v: v["artifact"]["workflow_run"].update(head_sha="f" * 40),
                       lambda v: v["tauri"]["app"]["windows"][0].update(title="Other app")):
            fixture = source_fixture()
            change(fixture)
            with self.assertRaises(RuntimeError):
                p.validate_source(fixture)

    def test_boolean_attempt_is_not_canonical_integer(self):
        fixture = source_fixture()
        fixture["run"]["run_attempt"] = True
        with self.assertRaisesRegex(RuntimeError, "Canonical"):
            p.validate_source(fixture)

    def test_duplicate_json_cannot_override_source(self):
        with self.assertRaisesRegex(RuntimeError, "Duplicate"):
            p.unique_json('{"source":"reviewed","source":"foreign"}')

    def test_admission_refuses_every_missing_guard_and_non_native_context(self):
        env = runner_fixture()
        p.admission(env, "linux", "x86_64")
        for key in env:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.admission({k: v for k, v in env.items() if k != key}, "linux", "x86_64")
        for system, machine in (("win32", "x86_64"), ("linux", "aarch64")):
            with self.assertRaises(RuntimeError):
                p.admission(env, system, machine)
        for key in ("FLATPAK_ID", "APPIMAGE", "APPDIR"):
            with self.assertRaises(RuntimeError):
                p.admission({**env, key: "foreign"}, "linux", "x86_64")

    def test_environment_is_finite_private_and_has_no_injection_or_auth(self):
        env = {**runner_fixture(), "DISPLAY": ":99", "LD_PRELOAD": "foreign", "LD_LIBRARY_PATH": "foreign",
               "PYTHONPATH": "foreign", "GTK_MODULES": "foreign", "GIO_EXTRA_MODULES": "foreign",
               "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS": "1", "GITHUB_TOKEN": "not-a-real-token",
               "HOME": "/foreign", "XDG_CONFIG_HOME": "/foreign", "PATH": "/foreign"}
        actual = p.child_env(env, Path("/owned"))
        for key in ("LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "GTK_MODULES", "GIO_EXTRA_MODULES",
                    "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "GITHUB_TOKEN"):
            self.assertNotIn(key, actual)
        self.assertEqual(actual["PATH"], "/usr/bin:/bin")
        self.assertEqual(actual["HOME"], str(Path("/owned/home")))
        self.assertEqual(actual["XDG_CONFIG_HOME"], str(Path("/owned/home/config")))


def archive_fixture(root, modify=None):
    contents = {"mcp/gui": b"fixture-gui", "setup/gui": b"fixture-setup", "routing/creator-hub-mcp-router": b"fixture-router"}
    hashes = {k: hashlib.sha256(v).hexdigest() for k, v in contents.items()}
    manifest = {"platform": "linux", "arch": "x86_64",
                "modules": {"mcp": {"executable": "mcp/gui", "files": {"mcp/gui": hashes["mcp/gui"]}},
                            "setup": {"executable": "setup/gui", "files": {"setup/gui": hashes["setup/gui"]}}},
                "managedRouting": {"files": {"routing/creator-hub-mcp-router": hashes["routing/creator-hub-mcp-router"]}}}
    entries = []
    for name, data in contents.items():
        info = tarfile.TarInfo(name)
        info.size, info.mode = len(data), 0o755
        entries.append((info, data))
    if modify:
        modify(entries)
    path = root / "modules.tar.gz"
    with tarfile.open(path, "w:gz", format=tarfile.USTAR_FORMAT) as archive:
        for info, data in entries:
            archive.addfile(info, io.BytesIO(data) if info.isfile() else None)
    manifest["payloadArchive"] = {"schemaVersion": 1, "file": path.name, "size": path.stat().st_size,
                                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                  "unpackedSize": sum(map(len, contents.values())),
                                  "files": {k: {"size": len(v), "mode": 0o755} for k, v in contents.items()}}
    return path, manifest


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="creator-root-pure-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_temp_archive_full_inventory_hashes_and_modes_without_extract(self):
        path, manifest = archive_fixture(self.root)
        result = p.verify_archive(path, manifest)
        self.assertEqual(set(result), set(manifest["payloadArchive"]["files"]))
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_temp_archive_wrong_mode_refused(self):
        path, manifest = archive_fixture(self.root, lambda e: setattr(e[0][0], "mode", 0o644))
        with self.assertRaisesRegex(RuntimeError, "size/mode"):
            p.verify_archive(path, manifest)

    def test_temp_archive_duplicate_refused(self):
        path, manifest = archive_fixture(self.root, lambda e: e.append(e[0]))
        with self.assertRaisesRegex(RuntimeError, "duplicate"):
            p.verify_archive(path, manifest)

    def test_temp_archive_unexpected_path_refused(self):
        path, manifest = archive_fixture(self.root, lambda e: setattr(e[0][0], "name", "../foreign"))
        with self.assertRaisesRegex(RuntimeError, "Unexpected"):
            p.verify_archive(path, manifest)

    def test_temp_archive_link_refused(self):
        def link(entries):
            entries[0][0].type, entries[0][0].linkname = tarfile.SYMTYPE, "/foreign"
        path, manifest = archive_fixture(self.root, link)
        with self.assertRaisesRegex(RuntimeError, "linked"):
            p.verify_archive(path, manifest)

    def test_temp_archive_missing_entry_refused(self):
        path, manifest = archive_fixture(self.root, lambda e: e.pop())
        with self.assertRaisesRegex(RuntimeError, "Incomplete"):
            p.verify_archive(path, manifest)

    def test_temp_archive_changed_resource_refused(self):
        path, manifest = archive_fixture(self.root)
        manifest["modules"]["mcp"]["files"]["mcp/gui"] = "f" * 64
        with self.assertRaisesRegex(RuntimeError, "resource hash"):
            p.verify_archive(path, manifest)

    def test_temp_archive_outer_hash_and_platform_refused(self):
        path, manifest = archive_fixture(self.root)
        for change in (lambda m: m.update(platform="macos"), lambda m: m["payloadArchive"].update(sha256="f" * 64)):
            value = copy.deepcopy(manifest)
            change(value)
            with self.assertRaises(RuntimeError):
                p.verify_archive(path, value)

    def test_file_pin_changed_bytes_and_bound_refused(self):
        path = self.root / "fixture"
        path.write_bytes(b"fixture")
        pin = (7, hashlib.sha256(b"fixture").hexdigest())
        p.pinned(path, pin)
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "bytes differ"):
            p.pinned(path, pin)
        with self.assertRaisesRegex(RuntimeError, "bounded"):
            p.file_record(path, 6)

    @unittest.skipUnless(os.name == "posix", "Native mode/link semantics tested on disposable Linux")
    def test_file_modes_links_and_hardlinks_refused(self):
        path = self.root / "fixture"
        path.write_bytes(b"fixture")
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "mode"):
            p.file_record(path, 7, 0o755)
        link = self.root / "link"
        link.symlink_to(path)
        with self.assertRaisesRegex(RuntimeError, "unredirected"):
            p.file_record(link, 7)
        link.unlink()
        os.link(path, link)
        with self.assertRaisesRegex(RuntimeError, "single-link"):
            p.file_record(path, 7)

    def test_known_actual_deb_resource_layout_has_no_caller_target_input(self):
        actual = p.paths(Path("/owned"))
        self.assertEqual(actual["creator-hub"], Path("/usr/bin/creator-hub"))
        self.assertEqual(actual["modules.tar.gz"], Path("/usr/lib/Creator Hub/modules.tar.gz"))
        self.assertEqual(actual["builtin-manifest.json"], Path("/owned/input/builtin-manifest.json"))


class NativeAdapterTests(unittest.TestCase):
    def test_window_claim_does_not_authorize_foreign_xres(self):
        request = types.SimpleNamespace(pid=42)
        x11 = types.SimpleNamespace(property=lambda *_: (6, 32, [42]),
                                    inspect=lambda _: {"pid": 43, "client": 3, "title": p.TITLE, "mapped": True})
        with mock.patch.object(p, "client_ids", return_value=[77]), self.assertRaisesRegex(RuntimeError, "foreign XRes"):
            p.discover(request, None, x11)

    def test_only_exact_xres_pid_title_and_mapped_window_selected(self):
        request = types.SimpleNamespace(pid=42)
        info = {"pid": 42, "client": 3, "title": p.TITLE, "mapped": True}
        x11 = types.SimpleNamespace(property=lambda *_: (6, 32, [42]), inspect=lambda _: info)
        helper = types.SimpleNamespace(identity=mock.Mock(), Proc=lambda: None)
        with mock.patch.object(p, "client_ids", return_value=[77]):
            self.assertEqual(p.discover(request, helper, x11)["window"], 77)
            info["title"] = "Foreign"
            self.assertIsNone(p.discover(request, helper, x11))
            info.update(title=p.TITLE, mapped=False)
            self.assertIsNone(p.discover(request, helper, x11))

    def test_unclaimed_other_window_not_inspected_or_captured(self):
        x11 = types.SimpleNamespace(property=lambda *_: (6, 32, [43]), inspect=mock.Mock())
        with mock.patch.object(p, "client_ids", return_value=[77]):
            self.assertIsNone(p.discover(types.SimpleNamespace(pid=42), None, x11))
        x11.inspect.assert_not_called()

    def test_ambiguous_owned_windows_refused(self):
        x11 = types.SimpleNamespace(property=lambda *_: (6, 32, [42]),
                                    inspect=lambda _: {"pid": 42, "client": 3, "title": p.TITLE, "mapped": True})
        with mock.patch.object(p, "client_ids", return_value=[77, 78]), self.assertRaisesRegex(RuntimeError, "Ambiguous"):
            p.discover(types.SimpleNamespace(pid=42), None, x11)

    def test_foreign_accessible_is_diagnostic_not_adopted_or_walked(self):
        class Node:
            def __init__(self, pid):
                self.pid = pid
            def get_process_id(self):
                return self.pid
            def get_role(self):
                return 1
            def get_name(self):
                return "fixture"
        root, foreign = Node(42), Node(43)
        children = mock.Mock(side_effect=lambda node, _limit: [foreign] if node is root else self.fail("Foreign subtree walked"))
        helper = types.SimpleNamespace(select_window=lambda *_: root, children=children, MAX_NODES=512, MAX_CHILDREN=128, MAX_DEPTH=32)
        with mock.patch.object(p, "peer_record", return_value={"pid": 43, "authorization": False}):
            result = p.routing_diagnostic(types.SimpleNamespace(pid=42), helper, None)
        self.assertTrue(result["foreignSubtreeRefused"])
        self.assertFalse(result["authorization"])
        self.assertEqual(result["firstForeignPeer"]["pid"], 43)
        self.assertEqual(children.call_count, 1)

    def test_foreign_snapshot_refusal_is_not_retried(self):
        states = types.SimpleNamespace(contains=lambda state: state in (1, 2, 3))
        frame = types.SimpleNamespace(get_process_id=lambda: 42, get_name=lambda: p.TITLE,
                                      get_role=lambda: 1, get_state_set=lambda: states)
        root = types.SimpleNamespace(get_process_id=lambda: 42)
        desktop = object()
        helper = types.SimpleNamespace(identity=mock.Mock(), bound_window=mock.Mock(),
                                       children=lambda n, _: [root] if n is desktop else [frame])
        atspi = types.SimpleNamespace(get_desktop=lambda _: desktop, Role=types.SimpleNamespace(FRAME=1),
                                     StateType=types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5))
        with mock.patch.object(p, "snapshot_owned", side_effect=RuntimeError("Foreign accessibility subtree refused")) as snapshot:
            with self.assertRaisesRegex(RuntimeError, "Foreign"):
                p.snapshot_ready(types.SimpleNamespace(pid=42, title=p.TITLE), helper, atspi, None, None, None)
        self.assertEqual(snapshot.call_count, 1)

    def test_solid_or_alpha_only_bitmap_refused(self):
        for data, channels in ((b"\0\0\0" * 512, 3), (b"\xff\0\0" * 512, 3),
                               (b"\0\0\0\xff" * 512, 4)):
            with self.assertRaisesRegex(RuntimeError, "blank"):
                p.pixel_metrics(data, 32, 16, 32 * channels, channels)

    def test_nonblank_rgb_fixture_with_row_padding(self):
        row = b"".join(bytes([i * 8, i * 4, 255 - i * 8]) for i in range(32)) + b"pad"
        result = p.pixel_metrics(row * 16, 32, 16, 99, 3)
        self.assertTrue(result["nonblank"])
        self.assertEqual(result["colorsAtLeast"], 32)

    def test_pixel_bounds_and_undersized_buffers_refused(self):
        for args in ((b"", 32, 16, 96, 3), (b"", 1921, 1080, 5763, 3), (b"", 32, 16, 32, 1)):
            with self.assertRaisesRegex(RuntimeError, "Pixel buffer"):
                p.pixel_metrics(*args)

    def test_occluding_rectangles_not_edge_adjacent(self):
        self.assertTrue(p.intersects((10, 10, 100, 100), (109, 50, 100, 20)))
        self.assertFalse(p.intersects((10, 10, 100, 100), (110, 50, 100, 20)))

    def test_pipe_drain_retains_bounded_prefix_and_reports_all_bytes_eof(self):
        class Selector:
            def __init__(self):
                self.keys = {}
            def register(self, stream, _event, data):
                self.keys[stream] = types.SimpleNamespace(fileobj=stream, fd=stream.fileno(), data=data)
            def unregister(self, stream):
                del self.keys[stream]
            def select(self, _wait):
                return [(key, 1) for key in list(self.keys.values())]
            def close(self):
                pass
        streams = [mock.Mock(), mock.Mock()]
        streams[0].fileno.return_value, streams[1].fileno.return_value = 11, 12
        child = types.SimpleNamespace(stdout=streams[0], stderr=streams[1])
        chunks = {11: [b"a" * p.MAX_LOG, b"extra", b""], 12: [b"diagnostic", b"", b""]}
        with tempfile.TemporaryDirectory(prefix="creator-drain-pure-") as temp, \
                mock.patch.object(p.selectors, "DefaultSelector", Selector), mock.patch.object(p.os, "set_blocking"), \
                mock.patch.object(p.os, "read", side_effect=lambda fd, _: chunks[fd].pop(0)):
            capture = p.Capture(child, Path(temp), "fixture")
            try:
                for _ in range(3):
                    capture.pump()
                metadata = capture.metadata()
                self.assertEqual(metadata["stdout"]["bytes"], p.MAX_LOG + 5)
                self.assertEqual(metadata["stdout"]["retainedBytes"], p.MAX_LOG)
                self.assertTrue(metadata["stdout"]["truncated"])
                self.assertTrue(metadata["stdout"]["eof"])
                self.assertTrue(metadata["stderr"]["eof"])
            finally:
                capture.close()

    def test_worker_deadline_records_live_child_without_signal_or_retry(self):
        child = types.SimpleNamespace(pid=43, poll=mock.Mock(return_value=None))
        capture = types.SimpleNamespace(metadata=lambda: {k: {"bytes": 0, "eof": False} for k in ("stdout", "stderr")},
                                        close=mock.Mock())
        records = []
        with mock.patch.object(p.subprocess, "Popen", return_value=child) as spawn, \
                mock.patch.object(p, "Capture", return_value=capture), \
                mock.patch.object(p.time, "monotonic", side_effect=[0, 16, 16]):
            with self.assertRaisesRegex(RuntimeError, "deadline reached; no signal sent"):
                p.run_worker(Path("/fixture"), {}, "diagnose", 42, "123", 77, None, records)
        spawn.assert_called_once()
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["exitCode"])
        self.assertFalse(records[0]["stdout"]["eof"])
        self.assertEqual(records[0]["elapsedMs"], 16000)
        capture.close.assert_called_once()


def control_fixture(body=b"Package: creator-hub\nVersion: 0.1.14\nArchitecture: amd64\nDescription: fixture\n", extra=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        entry = tarfile.TarInfo("./control")
        entry.size, entry.mode = len(body), 0o644
        archive.addfile(entry, io.BytesIO(body))
        if extra:
            name, kind = extra
            entry = tarfile.TarInfo(name)
            entry.type, entry.size = kind, 1 if kind == tarfile.REGTYPE else 0
            if kind == tarfile.SYMTYPE:
                entry.linkname = "/foreign"
            archive.addfile(entry, io.BytesIO(b"x") if entry.isfile() else None)
    return stream.getvalue()


class DebTests(unittest.TestCase):
    def test_actual_control_stanza_without_hooks_is_inspected_not_executed(self):
        value = p.deb_control(control_fixture())
        self.assertEqual((value["package"], value["version"], value["architecture"]), ("creator-hub", "0.1.14", "amd64"))
        self.assertFalse(value["maintainerScriptsPresent"])
        self.assertEqual(set(value["members"]), {"control"})

    def test_other_package_version_arch_duplicate_or_second_stanza_refused(self):
        for body in (b"Package: foreign\nVersion: 0.1.14\nArchitecture: amd64\n",
                     b"Package: creator-hub\nVersion: 0.1.15\nArchitecture: amd64\n",
                     b"Package: creator-hub\nVersion: 0.1.14\nArchitecture: arm64\n",
                     b"Package: creator-hub\nPackage: creator-hub\nVersion: 0.1.14\nArchitecture: amd64\n",
                     b"Package: creator-hub\nVersion: 0.1.14\nArchitecture: amd64\n\nPackage: other\n"):
            with self.subTest(body=body), self.assertRaises(RuntimeError):
                p.deb_control(control_fixture(body))

    def test_unreviewed_maintainer_scripts_config_and_links_refused(self):
        for extra in (("postinst", tarfile.REGTYPE), ("preinst", tarfile.REGTYPE), ("conffiles", tarfile.REGTYPE),
                      ("md5sums", tarfile.SYMTYPE), ("../control", tarfile.REGTYPE)):
            with self.subTest(extra=extra), self.assertRaisesRegex(RuntimeError, "Unreviewed"):
                p.deb_control(control_fixture(extra=extra))

    def test_deb_bundle_marker_comparison_does_not_write_or_authorize_other_changes(self):
        raw = b"fixture__TAURI_BUNDLE_TYPE_VAR_UNKend"
        installed = b"fixture__TAURI_BUNDLE_TYPE_VAR_DEBend"
        p.verify_deb_marker(raw, installed)
        for other in (raw, installed + b"extra", installed.replace(b"fixture", b"changed")):
            with self.assertRaisesRegex(RuntimeError, "differs beyond"):
                p.verify_deb_marker(raw, other)
        with self.assertRaisesRegex(RuntimeError, "one original"):
            p.verify_deb_marker(raw + raw, installed)

    def test_preexisting_installation_refuses_before_any_package_tool_or_mutation(self):
        with tempfile.TemporaryDirectory(prefix="creator-deb-pure-") as temp, \
                mock.patch.object(p, "verify_inputs", return_value={}), \
                mock.patch.object(p.os.path, "lexists", return_value=True), mock.patch.object(p, "run_tool") as tool:
            with self.assertRaisesRegex(RuntimeError, "Existing native Hub paths refused"):
                p.install(Path(temp).resolve())
            tool.assert_not_called()
            report = json.loads((Path(temp) / "installation-report.json").read_text())
            self.assertFalse(report["debInstalled"])

    def test_source_guard_limits_installation_to_exact_sanitized_native_dpkg(self):
        source = SCRIPT.read_text()
        self.assertIn('"/usr/bin/sudo", "-n", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"', source)
        self.assertIn('"/usr/bin/dpkg", "--install", "--", str(deb)', source)
        self.assertNotIn("apt-get -f", source)
        self.assertNotIn("--force", source)
        self.assertIn("INSTALLED_HUB_PIN[1]", source)

    def test_installer_has_system_sbin_without_broadening_gui_environment(self):
        commands = []
        def tool(_root, label, command, **_kwargs):
            commands.append(command)
            if label == "preinstall-state":
                return 1, b""
            return (0, control_fixture()) if label == "deb-control" else (0, b"")
        with tempfile.TemporaryDirectory(prefix="creator-deb-pure-") as temp, \
                mock.patch.object(p, "verify_inputs", return_value={}), mock.patch.object(p, "verify_stage", return_value={}), \
                mock.patch.object(p.os.path, "lexists", return_value=False), mock.patch.object(p, "pinned", return_value={"sha256": p.DEB_PIN[1]}), \
                mock.patch.object(p, "run_tool", side_effect=tool), \
                mock.patch.object(p, "installed_state", return_value="creator-hub\t0.1.14\tamd64\tinstalled\n"):
            root = Path(temp).resolve()
            p.install(root)
        install = next(command for command in commands if command[0] == "/usr/bin/sudo")
        self.assertEqual(install, ["/usr/bin/sudo", "-n", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8",
                                   "/usr/bin/dpkg", "--install", "--", str(p.input_path(root, "native-packages/" + p.DEB_NAME))])
        self.assertEqual(p.child_env({}, root)["PATH"], "/usr/bin:/bin")


class SourceGuardTests(unittest.TestCase):
    def test_only_fixed_terms_action_authority_no_injection_or_kill_fallback(self):
        source = SCRIPT.read_text()
        for forbidden in (".kill(", ".terminate(", "os.kill(", "pkill", "killall", "xdotool",
                          "get_default_root_window", "eval(", "execute_script", "subprocess.run(",
                          "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "--no-sandbox", "shell=True"):
            self.assertNotIn(forbidden, source)
        self.assertEqual(source.count("interface.do_action(0)"), 1)
        self.assertEqual(source.count("ownership.x11.close_window("), 1)
        self.assertIn('action in ("check-terms", "accept-terms", "close")', source)
        self.assertNotIn("helper.walk(", source)
        self.assertNotIn("helper.perform(", source)
        self.assertNotIn("accept_usage_terms", source)
        self.assertNotIn("localStorage", source)
        helper = p.HELPER.read_text()
        self.assertIn('node.get_process_id() == request.pid, "Foreign accessibility subtree refused"', helper)
        self.assertIn("Gdk.pixbuf_get_from_window(window, 0, 0", source)
        self.assertIn('GdkX11.X11Window.foreign_new_for_display(display, request.window)', source)
        self.assertNotIn('Request.parse(["click"', source)

    def test_guard_precedes_paths_and_native_imports(self):
        source = SCRIPT.read_text().split("def main():", 1)[1]
        self.assertLess(source.index("admission("), source.index("ordinary("))
        self.assertLess(source.index("admission("), source.index("sys.argv"))
        self.assertTrue(all(v is False for v in p.FLAGS.values()))

    def test_workflow_has_exact_pins_and_no_rebuild_or_permission_expansion(self):
        workflow = SCRIPT.parents[1] / ".github/workflows/native-linux-root-probe-014.yml"
        text = workflow.read_text()
        for expected in (p.SOURCE, p.TREE, p.ZIP_SHA, str(p.RUN), str(p.JOB), str(p.ARTIFACT), str(p.ZIP_SIZE),
                         "ubuntu-22.04", "libwebkit2gtk-4.1-0", "dbus-run-session -- xvfb-run", "openbox --sm-disable",
                         "persist-credentials: false", "if: always()", "linux-root-probe/root-window.png"):
            self.assertIn(expected, text)
        self.assertLess(text.index("assert.equal(commit.tree.sha,tree)"), text.index("downloadArtifact("))
        self.assertLess(text.index("native-linux-root-probe.test.py"), text.index("downloadArtifact("))
        self.assertLess(text.index("native-linux-root-probe.py stage"), text.index("native-linux-root-probe.py install"))
        self.assertLess(text.index("Provision native GUI runtime"), text.index("native-linux-root-probe.py install"))
        self.assertLess(text.index("native-linux-root-probe.py install"), text.index("native-linux-root-probe.py\" probe"))
        for forbidden in ("cargo build", "npm run build", "dpkg -i", "apt-get install -y creator", "flatpak run",
                          "--filesystem=home", "--no-sandbox", "actions: write", "contents: write"):
            self.assertNotIn(forbidden, text)


class AxNode:
    def __init__(self, pid, role, name="", parent=None, states=(1, 2, 3), verb=None):
        self.pid, self.role, self.name, self.parent = pid, role, name, parent
        self.app = types.SimpleNamespace(bus_name=f":1.{pid}")
        self.path = f"/org/a11y/atspi/accessible/n{id(self)}"
        self.states, self.children = set(states), []
        self.action = types.SimpleNamespace(get_n_actions=lambda: 1, get_action_name=lambda _: verb,
                                            do_action=mock.Mock(return_value=True)) if verb else None
        if parent is not None:
            parent.children.append(self)

    def get_process_id(self):
        return self.pid

    def get_role(self):
        return self.role

    def get_role_name(self):
        return "fixture"

    def get_name(self):
        return self.name

    def get_parent(self):
        return self.parent

    def clear_cache(self):
        pass

    def get_state_set(self):
        return types.SimpleNamespace(contains=lambda state: state in self.states)

    def get_action_iface(self):
        return self.action


class OwnershipTests(unittest.TestCase):
    def fixture(self):
        root = {"pid": 42, "startTime": "100", "parentPid": 40, "uids": [1000] * 4,
                "executable": "/usr/bin/creator-hub", "kernelImageSha256": p.INSTALLED_HUB_PIN[1], "image": {"inode": "1"}}
        peer = {**copy.deepcopy(root), "pid": 43, "startTime": "110", "parentPid": 42,
                "executable": p.WEBKIT, "kernelImageSha256": p.WEBKIT_SHA, "image": {"inode": "2"}}
        self.records, self.system = {42: root, 43: peer}, {"sha256": p.WEBKIT_SHA}
        self.info = {"pid": 42, "client": 3, "title": p.TITLE, "mapped": True}
        self.request = types.SimpleNamespace(pid=42, start="100", executable=root["executable"],
                                              sha256=p.INSTALLED_HUB_PIN[1], title=p.TITLE, window=77)
        self.window = AxNode(42, 23, p.TITLE)
        self.container = AxNode(42, 20, parent=self.window)
        self.web = AxNode(43, 20, parent=self.container)
        self.heading = AxNode(43, 78, p.TERMS, parent=self.web)
        self.checkbox = AxNode(43, 7, p.TERMS_CHECKBOX, parent=self.web, verb="check")
        self.accept = AxNode(43, 43, p.TERMS_ACCEPT, parent=self.web, states=(1,), verb="press")
        self.atspi = types.SimpleNamespace(Role=types.SimpleNamespace(FRAME=23, WINDOW=69, APPLICATION=75, CHECK_BOX=7,
            PUSH_BUTTON=43, TOGGLE_BUTTON=62, RADIO_BUTTON=44, PAGE_TAB=37, LINK=88, COMBO_BOX=11),
            StateType=types.SimpleNamespace(SHOWING=1, ENABLED=2, SENSITIVE=3, DEFUNCT=4, BUSY=5, CHECKED=6, SELECTED=7))
        self.helper = types.SimpleNamespace(bound_window=lambda *_: dict(self.info), select_window=lambda *_: self.window,
            children=lambda n, limit: n.children if len(n.children) <= limit else p.require(False, "children bound"),
            ready=lambda n, a: p.require({1, 2, 3} <= n.states and not n.states.intersection({4, 5}), "not ready"),
            MAX_NODES=512, MAX_DEPTH=32, MAX_CHILDREN=128, ActionError=p.load_helper().ActionError)
        self.x11 = types.SimpleNamespace(check_close=mock.Mock(), close_window=mock.Mock())

        def read(pid, full):
            value = copy.deepcopy(self.records[pid])
            if not full:
                value.pop("kernelImageSha256")
            return value
        self.reader = mock.Mock(side_effect=read)
        self.bus_records = {f":1.{pid}": {"owner": f":1.{pid}", "pid": pid, "uid": 1000} for pid in (42, 43, 99)}
        self.references = p.AxReferences(lambda name: dict(self.bus_records[name]))
        self.ownership = p.RootOwnership(self.request, self.helper, self.x11, copy.deepcopy(root), dict(self.info),
                                          dict(self.system), reader=self.reader, system_check=lambda: dict(self.system),
                                          references=self.references)
        return self.ownership

    def test_only_measured_direct_child_is_bound_and_both_rechecked_per_node(self):
        binding = self.fixture()
        nodes = p.owned_walk(self.window, binding, self.atspi)
        self.assertEqual(len(nodes), 6)
        self.assertEqual(binding.renderer["pid"], 43)
        self.assertEqual(binding.renderer["parentPid"], 42)
        for pid in (42, 43):
            self.assertGreaterEqual(sum(c.args[0] == pid for c in self.reader.call_args_list), len(nodes))
        value = p.snapshot_owned(self.request, self.helper, self.atspi, binding)
        self.assertEqual({n["pid"] for n in value["nodes"]}, {42, 43})
        self.assertEqual(value["controls"][0]["actions"], ["check"])

    def test_wrong_parent_uid_custom_path_hash_or_older_child_refused_before_children(self):
        for field, value in (("parentPid", 99), ("uids", [1001] * 4), ("uids", [1000, 0, 1000, 1000]),
                             ("executable", "/tmp/WebKitWebProcess"), ("kernelImageSha256", "f" * 64), ("startTime", "99")):
            with self.subTest(field=field, value=value):
                binding = self.fixture()
                self.records[43][field] = value
                original = self.helper.children
                self.helper.children = mock.Mock(side_effect=original)
                with self.assertRaises(RuntimeError):
                    p.owned_walk(self.window, binding, self.atspi)
                self.assertFalse(any(c.args[0] is self.web for c in self.helper.children.call_args_list))

    def test_root_and_child_pid_reuse_uid_parent_and_kernel_image_drift_refused(self):
        for pid in (42, 43):
            for field, value in (("startTime", "999"), ("uids", [0] * 4), ("parentPid", 99),
                                 ("image", {"inode": "different"}), ("kernelImageSha256", "f" * 64)):
                with self.subTest(pid=pid, field=field):
                    binding = self.fixture()
                    p.owned_walk(self.window, binding, self.atspi)
                    self.records[pid][field] = value
                    with self.assertRaisesRegex(RuntimeError, "identity changed"):
                        binding.recheck(full=True)

    def test_system_hash_file_identity_and_xres_client_window_drift_refused(self):
        binding = self.fixture()
        self.system["sha256"] = "f" * 64
        with self.assertRaisesRegex(RuntimeError, "provenance changed"):
            binding.recheck(full=True)
        for field, value in (("pid", 99), ("client", 9), ("title", "Foreign"), ("mapped", False)):
            binding = self.fixture()
            self.info[field] = value
            with self.assertRaisesRegex(RuntimeError, "XRes window changed"):
                p.owned_walk(self.window, binding, self.atspi)

    def test_additional_peer_nested_foreign_window_and_escaped_ax_parent_refused(self):
        for kind in ("peer", "frame", "window", "application", "parent"):
            with self.subTest(kind=kind):
                binding = self.fixture()
                if kind == "peer":
                    AxNode(44, 20, parent=self.web)
                elif kind == "parent":
                    self.heading.parent = AxNode(43, 20)
                else:
                    AxNode(43, {"frame": 23, "window": 69, "application": 75}[kind], parent=self.web)
                with self.assertRaises(RuntimeError):
                    p.owned_walk(self.window, binding, self.atspi)

    def test_foreign_ax_root_is_never_traversed_even_if_title_matches(self):
        binding = self.fixture()
        for pid in (43, 99):
            with self.assertRaisesRegex(RuntimeError, "Foreign AX window"):
                p.owned_walk(AxNode(pid, 23, p.TITLE), binding, self.atspi)

    def test_pid_reuse_during_traversal_refuses_before_any_input(self):
        binding = self.fixture()
        original = self.helper.children
        def children(node, limit):
            if node is self.web:
                self.records[43]["startTime"] = "999"
            return original(node, limit)
        self.helper.children = children
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            p.perform_owned("check-terms", self.request, self.helper, self.atspi, binding)
        self.checkbox.action.do_action.assert_not_called()

    def test_reverse_parent_is_fresh_not_stale_cache_and_still_refuses_foreign(self):
        binding = self.fixture()
        self.heading.get_parent = mock.Mock(return_value=None)
        def refresh():
            self.heading.get_parent.return_value = self.web
        self.heading.clear_cache = mock.Mock(side_effect=refresh)
        p.owned_walk(self.window, binding, self.atspi)
        self.heading.clear_cache.assert_called_once_with()
        self.heading.clear_cache.side_effect = None
        self.heading.get_parent.return_value = AxNode(99, 23, "Foreign")
        with self.assertRaisesRegex(RuntimeError, "AX bus owner is not the bound"):
            p.owned_walk(self.window, binding, self.atspi)

    def test_webkit_well_known_and_unique_bus_aliases_need_same_owner_and_exact_path(self):
        binding = self.fixture()
        p.owned_walk(self.window, binding, self.atspi)
        alias = "org.webkit.WebProcess.fixture"
        self.bus_records[alias] = dict(self.bus_records[":1.43"])
        proxy = AxNode(43, 20)
        proxy.app.bus_name, proxy.path = alias, self.web.path
        self.assertIsNot(proxy, self.web)
        self.assertTrue(binding.same_node(proxy, self.web))
        proxy.path += "_other"
        self.assertFalse(binding.same_node(proxy, self.web))
        proxy.path = self.web.path
        self.bus_records[alias]["owner"] = ":1.444"
        with self.assertRaisesRegex(RuntimeError, "unique owner/PID/UID changed"):
            binding.recheck(full=True)

    def test_same_pid_path_but_other_bus_connection_is_not_same_ax_object(self):
        binding = self.fixture()
        p.owned_walk(self.window, binding, self.atspi)
        proxy = AxNode(43, 20)
        proxy.app.bus_name, proxy.path = ":1.444", self.web.path
        self.bus_records[":1.444"] = {"owner": ":1.444", "pid": 43, "uid": 1000}
        self.assertFalse(binding.same_node(proxy, self.web))

    def test_ax_alias_wrong_uid_pid_or_changed_owner_refuses(self):
        for field, value in (("uid", 0), ("pid", 99), ("owner", "not.unique")):
            with self.subTest(field=field):
                binding = self.fixture()
                self.bus_records[":1.42"][field] = value
                with self.assertRaises(RuntimeError):
                    p.owned_walk(self.window, binding, self.atspi)

    def test_changed_ax_window_path_refuses_even_same_pid_role_and_title(self):
        binding = self.fixture()
        p.owned_walk(self.window, binding, self.atspi)
        self.window.path += "_other"
        with self.assertRaisesRegex(RuntimeError, "wire identity changed"):
            p.owned_walk(self.window, binding, self.atspi)

    def test_malformed_ax_bus_or_object_path_and_alias_overflow_refuse(self):
        for field, value in (("bus", "tcp:foreign"), ("bus", "x" * 129), ("path", "/foreign"),
                             ("path", "/org/a11y/../foreign"), ("path", "/org/a11y/" + "x" * 257)):
            with self.subTest(field=field, value=value):
                binding = self.fixture()
                if field == "bus":
                    self.window.app.bus_name = value
                else:
                    self.window.path = value
                with self.assertRaisesRegex(RuntimeError, "Invalid bounded"):
                    p.owned_walk(self.window, binding, self.atspi)
        binding = self.fixture()
        self.window.app.bus_name = "not-a-bus-name"
        with self.assertRaisesRegex(RuntimeError, '"bus": "not-a-bus-name"'):
            p.owned_walk(self.window, binding, self.atspi)
        with self.assertRaisesRegex(RuntimeError, "inventory exceeds"):
            p.AxReferences(None, {str(i): {} for i in range(9)})

    def test_one_exact_unchecked_checkbox_action_not_arbitrary_click(self):
        binding = self.fixture()
        result = p.perform_owned("check-terms", self.request, self.helper, self.atspi, binding)
        self.assertEqual((result["actionCount"], result["verb"]), (1, "check"))
        self.checkbox.action.do_action.assert_called_once_with(0)
        self.accept.action.do_action.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "Unreviewed"):
            p.perform_owned("click", self.request, self.helper, self.atspi, binding)

    def test_only_checked_terms_accept_uses_source_proven_press(self):
        binding = self.fixture()
        self.checkbox.states.add(6)
        self.accept.states.update({2, 3})
        result = p.perform_owned("accept-terms", self.request, self.helper, self.atspi, binding)
        self.assertEqual(result["verb"], "press")
        self.accept.action.do_action.assert_called_once_with(0)

    def test_wrong_terms_action_role_label_state_or_duplicate_cannot_act(self):
        for kind in ("checked", "enabled", "verb", "role", "label", "duplicate", "no-heading"):
            with self.subTest(kind=kind):
                binding = self.fixture()
                if kind == "checked":
                    self.checkbox.states.add(6)
                elif kind == "enabled":
                    self.accept.states.add(2)
                elif kind == "verb":
                    self.checkbox.action.get_action_name = lambda _: "click"
                elif kind == "role":
                    self.checkbox.role = 43
                elif kind == "label":
                    self.checkbox.name = "Foreign"
                elif kind == "duplicate":
                    AxNode(43, 7, p.TERMS_CHECKBOX, parent=self.web, verb="check")
                else:
                    self.heading.name = "Foreign"
                with self.assertRaises(RuntimeError):
                    p.perform_owned("check-terms", self.request, self.helper, self.atspi, binding)
                self.checkbox.action.do_action.assert_not_called()

    def test_native_input_failure_is_action_uncertain_and_never_retried(self):
        binding = self.fixture()
        self.checkbox.action.do_action.return_value = False
        with self.assertRaises(self.helper.ActionError) as error:
            p.perform_owned("check-terms", self.request, self.helper, self.atspi, binding)
        self.assertTrue(error.exception.action_may_have_run)
        self.checkbox.action.do_action.assert_called_once_with(0)

    def test_close_only_exact_root_ewmh_after_full_renderer_traversal(self):
        binding = self.fixture()
        result = p.perform_owned("close", self.request, self.helper, self.atspi, binding)
        self.assertEqual(result["verb"], "WM_DELETE_WINDOW")
        self.x11.close_window.assert_called_once_with(77, self.info)
        self.checkbox.action.do_action.assert_not_called()

    def test_terminal_close_does_not_read_destroyed_ax_nodes_after_input(self):
        binding = self.fixture()
        def close(*_args):
            for node in (self.window, self.web, self.heading, self.checkbox, self.accept):
                node.get_name = mock.Mock(side_effect=AssertionError("AX read after terminal close"))
        self.x11.close_window.side_effect = close
        self.assertEqual(p.perform_owned("close", self.request, self.helper, self.atspi, binding)["actionCount"], 1)


class AcknowledgementTests(unittest.TestCase):
    def fixture(self, root, value):
        path = root / "home/data/CreatorHub/consent/hub-usage-terms.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(value))
        return path

    def test_only_current_native_record_created_after_actual_input_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="creator-ack-pure-") as temp:
            root = Path(temp).resolve()
            value = {"schemaVersion": 1, "policyVersion": p.POLICY, "acceptedAtMs": 100}
            self.fixture(root, value)
            with mock.patch.object(p.time, "time_ns", return_value=110000000):
                self.assertFalse(p.acknowledgement(root, 100)["seeded"])
                for minimum in (101,):
                    with self.assertRaises(RuntimeError):
                        p.acknowledgement(root, minimum)

    def test_old_foreign_future_boolean_or_extended_acknowledgement_refused(self):
        for change in ({"schemaVersion": True}, {"schemaVersion": 2}, {"policyVersion": "foreign"},
                       {"acceptedAtMs": True}, {"acceptedAtMs": 999999999999999}, {"foreign": 1}):
            with self.subTest(change=change), tempfile.TemporaryDirectory(prefix="creator-ack-pure-") as temp:
                root = Path(temp).resolve()
                self.fixture(root, {"schemaVersion": 1, "policyVersion": p.POLICY, "acceptedAtMs": 100, **change})
                with self.assertRaises(RuntimeError):
                    p.acknowledgement(root, 100)

    def test_preexisting_acknowledgement_refuses_before_any_native_input(self):
        with tempfile.TemporaryDirectory(prefix="creator-ack-pure-") as temp:
            root = Path(temp).resolve()
            self.fixture(root, {"schemaVersion": 1, "policyVersion": p.POLICY, "acceptedAtMs": 100})
            with mock.patch.object(p, "run_worker") as worker, self.assertRaisesRegex(RuntimeError, "absent"):
                p.accept_terms(root, {}, None, None, None, None, {})
            worker.assert_not_called()

    def test_exact_action_sequence_retains_only_record_created_by_fixture_app_callback(self):
        with tempfile.TemporaryDirectory(prefix="creator-ack-pure-") as temp:
            root, calls, report = Path(temp).resolve(), [], {"workers": []}
            value = {"schemaVersion": 1, "policyVersion": p.POLICY, "acceptedAtMs": 100}
            def worker(_root, _env, action, *_args):
                calls.append(action)
                if action == "accept-terms":
                    self.fixture(root, value)
                return {"action": action, "actionCount": 1}
            with mock.patch.object(p, "run_worker", side_effect=worker), \
                    mock.patch.object(p.time, "time_ns", return_value=100000000):
                p.accept_terms(root, {}, types.SimpleNamespace(pid=42), "123", 77, None, report)
            self.assertEqual(calls, ["check-terms", "accept-terms"])
            self.assertTrue(report["termsAcknowledgementAbsentBefore"])
            self.assertTrue(report["termsAcceptanceVerified"])
            self.assertEqual(json.loads((root / "native-terms-acknowledgement.json").read_text()), value)

    def test_uncertain_first_terms_action_never_retries_or_attempts_accept(self):
        with tempfile.TemporaryDirectory(prefix="creator-ack-pure-") as temp, \
                mock.patch.object(p, "run_worker", side_effect=RuntimeError("uncertain action")) as worker:
            with self.assertRaisesRegex(RuntimeError, "uncertain action"):
                p.accept_terms(Path(temp).resolve(), {}, types.SimpleNamespace(pid=42), "123", 77, None, {"workers": []})
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(worker.call_args.args[2], "check-terms")


class NativeIdentityTests(unittest.TestCase):
    def test_uid_parser_captures_all_four_without_echoing_status(self):
        for body, good in ((b"Name:\tfixture\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n", True),
                           (b"Uid:\t1000\t0\t1000\t1000\n", True), (b"Uid:\t1000\n", False),
                           (b"Uid:\t1\t1\t1\t1\nUid:\t2\t2\t2\t2\n", False), (b"x" * 16385, False)):
            with mock.patch("builtins.open", return_value=io.BytesIO(body)):
                if good:
                    self.assertEqual(len(p.process_uids(42)), 4)
                else:
                    with self.assertRaises(RuntimeError):
                        p.process_uids(42)

    def test_package_attribution_requires_exact_owner_version_and_unchanged_file(self):
        image = {"sha256": p.WEBKIT_SHA}
        expected_owner = (p.WEBKIT_PACKAGE + ": " + p.WEBKIT + "\n").encode()
        expected_package = ("libwebkit2gtk-4.1-0\t" + p.WEBKIT_VERSION + "\tamd64\tinstalled\n").encode()
        with mock.patch.object(p, "verify_system_webkit", return_value=image), \
                mock.patch.object(p, "run_tool", side_effect=[(0, expected_owner), (0, expected_package)]) as tool:
            value = p.system_webkit_provenance(Path("/owned"))
        self.assertEqual(value["sha256"], p.WEBKIT_SHA)
        self.assertEqual(tool.call_args_list[0].args[2], ["/usr/bin/dpkg-query", "-S", p.WEBKIT])
        for owner, package in ((b"foreign\n", expected_package), (expected_owner, b"foreign\n")):
            with mock.patch.object(p, "verify_system_webkit", return_value=image), \
                    mock.patch.object(p, "run_tool", side_effect=[(0, owner), (0, package)]), self.assertRaises(RuntimeError):
                p.system_webkit_provenance(Path("/owned"))
        with mock.patch.object(p, "verify_system_webkit", side_effect=[image, {"sha256": "f" * 64}]), \
                mock.patch.object(p, "run_tool", side_effect=[(0, expected_owner), (0, expected_package)]), \
                self.assertRaisesRegex(RuntimeError, "changed during"):
            p.system_webkit_provenance(Path("/owned"))

    def test_native_identity_rechecks_start_uid_parent_path_and_kernel_inode_around_hash(self):
        helper = p.load_helper()
        # /proc stat fields: state, ppid, ... starttime at index19 after comm.
        def record(start="100", parent="40"):
            return "42 (fixture) " + " ".join(["S", parent] + ["0"] * 17 + [start])
        image = {"inode": "1"}
        for changed in ("start", "uid", "parent", "path", "inode", None):
            with self.subTest(changed=changed):
                proc = types.SimpleNamespace(stat=mock.Mock(side_effect=[record(), record("999" if changed == "start" else "100",
                                                                                         "99" if changed == "parent" else "40")]),
                    executable=mock.Mock(side_effect=["/usr/bin/creator-hub", "/tmp/foreign" if changed == "path" else "/usr/bin/creator-hub"]),
                    digest=lambda _pid: p.INSTALLED_HUB_PIN[1])
                with mock.patch.object(helper, "Proc", return_value=proc), \
                        mock.patch.object(p, "process_uids", side_effect=[[1000] * 4, [0 if changed == "uid" else 1000] * 4]), \
                        mock.patch.object(p, "image_identity", side_effect=[image, {"inode": "2"} if changed == "inode" else image]):
                    if changed is None:
                        self.assertEqual(p.native_process(42, helper)["startTime"], "100")
                    else:
                        with self.assertRaisesRegex(RuntimeError, "changed during"):
                            p.native_process(42, helper)


class ParentTests(unittest.TestCase):
    def harness(self, temp, *, snapshot_refusal=False, terms=True, exit_code=0, truncated=False, bitmap_refusal=False):
        root = Path(temp).resolve()
        child = types.SimpleNamespace(pid=42, poll=mock.Mock(return_value=None), wait=mock.Mock())
        helper = types.SimpleNamespace(Proc=lambda: types.SimpleNamespace(exists=lambda _pid: False))
        actions = []

        class Captured:
            def __init__(self, *_):
                self.items = {k: {"eof": True} for k in ("stdout", "stderr")}
            def pump(self, *_):
                pass
            def close(self):
                pass
            def metadata(self):
                return {k: {"bytes": 0, "retainedBytes": 0, "eof": True, "truncated": truncated}
                        for k in ("stdout", "stderr")}

        def run_worker(_root, _env, action, _pid, _start, _xid, _capture, records):
            actions.append(action)
            records.append({"action": action, "exitCode": 1 if snapshot_refusal and action == "snapshot" else 0})
            if action == "discover":
                return {"window": 77, "properties": {"pid": 42, "client": 3, "title": p.TITLE, "mapped": True}}
            if action == "snapshot":
                if snapshot_refusal:
                    raise RuntimeError("Foreign accessibility subtree refused")
                return {"action": "snapshot", "actionCount": 0, "nodes": [{"name": p.TERMS if terms else "frame", "showing": True}]}
            if action == "diagnose":
                return {"foreignSubtreeRefused": True, "authorization": False, "firstForeignPeer": {"pid": 43}}
            if action == "bitmap":
                if bitmap_refusal:
                    raise RuntimeError("Owned bitmap is blank/insufficiently varied")
                return {"windowOnly": True, "nonblank": True, "diagnosticOnly": True}
            if action == "close":
                child.poll.return_value = exit_code
                return {"action": "close", "actionCount": 1, "termsVisibleBeforeAction": False}
            if action in ("check-terms", "accept-terms"):
                return {"action": action, "actionCount": 1}
            self.fail("Unexpected worker action")

        saved_ack = {"record": {"acceptedAtMs": 123}}
        def accept_terms(_root, _env, _child, _start, _xid, _capture, report):
            for action in ("check-terms", "accept-terms"):
                run_worker(_root, _env, action, 42, "123", 77, _capture, report["workers"])
            report.update(termsAcceptanceVerified=True, termsAcknowledgement=saved_ack)

        environment = {**runner_fixture(), "DISPLAY": ":99", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/fixture"}
        with mock.patch.object(p, "verify_stage", return_value={"debInstalled": False}), \
                mock.patch.object(p, "installed_state", return_value="creator-hub\t0.1.14\tamd64\tinstalled\n"), \
                mock.patch.object(p, "INSTALLED_HUB_PIN", p.PINS["creator-hub"]), \
                mock.patch.object(p, "load_helper", return_value=helper), \
                mock.patch.object(p, "check_process", return_value="123"), \
                mock.patch.object(p, "system_webkit_provenance", return_value={}), \
                mock.patch.object(p, "native_process", return_value={"pid": 42, "startTime": "123", "parentPid": os.getpid(),
                                                                    "uids": [1000] * 4, "kernelImageSha256": p.PINS["creator-hub"][1]}), \
                mock.patch.object(p.os, "getuid", return_value=1000, create=True), \
                mock.patch.object(p, "accept_terms", side_effect=accept_terms), \
                mock.patch.object(p, "acknowledgement", return_value=saved_ack), \
                mock.patch.object(p.subprocess, "Popen", return_value=child) as spawn, \
                mock.patch.object(p, "Capture", Captured), mock.patch.object(p, "run_worker", side_effect=run_worker):
            error = None
            try:
                p.probe(root, environment)
            except RuntimeError as caught:
                error = str(caught)
            report = json.loads((root / "report.json").read_text())
            self.assertEqual(spawn.call_args.args[0], [str(p.paths(root)["creator-hub"])])
        return report, error, actions, child

    def test_only_full_owned_snapshot_bitmap_and_parent_zero_reap_complete_capture(self):
        with tempfile.TemporaryDirectory(prefix="creator-parent-pure-") as temp:
            report, error, actions, child = self.harness(temp)
        self.assertIsNone(error)
        self.assertEqual(actions, ["discover", "snapshot", "bitmap", "check-terms", "accept-terms", "close"])
        self.assertTrue(report["normalExitVerified"])
        self.assertTrue(report["readOnlyCaptureCompleted"])
        self.assertTrue(report["termsAcceptanceVerified"])
        self.assertTrue(report["termsAcknowledgementRetainedAfterExit"])
        self.assertFalse(report["installationAccepted"])
        self.assertFalse(report["nativeGuiAccepted"])
        self.assertFalse(report["releaseReady"])
        child.wait.assert_called_once_with(timeout=0)

    def test_foreign_snapshot_keeps_original_refusal_and_never_attempts_close(self):
        with tempfile.TemporaryDirectory(prefix="creator-parent-pure-") as temp:
            report, error, actions, child = self.harness(temp, snapshot_refusal=True)
        self.assertIn("Original snapshot refusal preserved", error)
        self.assertEqual(actions, ["discover", "snapshot", "diagnose", "bitmap"])
        self.assertIn("Foreign accessibility", report["snapshotRefusal"])
        self.assertFalse(report["accessibilityDiagnostic"]["authorization"])
        self.assertTrue(report["bitmap"]["diagnosticOnly"])
        self.assertFalse(report["readOnlyCaptureCompleted"])
        self.assertFalse(report["normalExitVerified"])
        self.assertTrue(report["disposableSessionTeardownRequired"])
        child.wait.assert_not_called()

    def test_terms_missing_still_normally_closes_owned_frame_but_not_capture_pass(self):
        with tempfile.TemporaryDirectory(prefix="creator-parent-pure-") as temp:
            report, error, actions, _child = self.harness(temp, terms=False)
        self.assertEqual(actions[-1], "close")
        self.assertTrue(report["normalExitVerified"])
        self.assertFalse(report["readOnlyCaptureCompleted"])
        self.assertIn("terms node was not observed", error)

    def test_nonzero_exit_or_truncated_root_output_never_pass(self):
        for kwargs in ({"exit_code": 1}, {"truncated": True}):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory(prefix="creator-parent-pure-") as temp:
                report, error, _actions, _child = self.harness(temp, **kwargs)
                self.assertIsNotNone(error)
                self.assertFalse(report["readOnlyCaptureCompleted"])
                self.assertFalse(report["normalExitVerified"])

    def test_bitmap_failure_preserved_with_one_existing_helper_cleanup_close(self):
        with tempfile.TemporaryDirectory(prefix="creator-parent-pure-") as temp:
            report, error, actions, child = self.harness(temp, bitmap_refusal=True)
        self.assertIn("bitmap is blank", error)
        self.assertEqual(actions, ["discover", "snapshot", "bitmap", "close"])
        self.assertTrue(report["cleanupNormalCloseAttempted"])
        self.assertTrue(report["normalExitVerified"])
        self.assertFalse(report["readOnlyCaptureCompleted"])
        child.wait.assert_called_once_with(timeout=0)

    def test_prelaunch_verification_refuses_without_spawning(self):
        with tempfile.TemporaryDirectory(prefix="creator-parent-pure-") as temp, \
                mock.patch.object(p, "verify_stage", side_effect=RuntimeError("changed source")), \
                mock.patch.object(p.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "changed source"):
                p.probe(Path(temp).resolve(), {})
            spawn.assert_not_called()
            report = json.loads((Path(temp) / "report.json").read_text())
            self.assertEqual(report["phase"], "verify")
            self.assertFalse(report["readOnlyCaptureCompleted"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
