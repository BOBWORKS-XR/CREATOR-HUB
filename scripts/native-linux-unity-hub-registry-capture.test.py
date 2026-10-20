"""Pure capture contracts. No download, Hub execution or native acceptance occurs here."""
import ast
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock
import urllib.error

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("hub_capture_under_test", HERE / "native-linux-unity-hub-registry-capture.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)

# Exact public text retained in official-hub-launch-files-3.22.3.json, SHA-256
# 4598fbbf04dd72ff30525697562e6851b0a6f7918d23d0d946b0661caa6142bf.
VENDOR_DESKTOP = b"""[Desktop Entry]
Name=Unity Hub
StartupWMClass=Unity Hub
Comment=The Official Unity Hub
GenericName=Unity Hub
Exec=unityhub %U
Icon=unityhub
Type=Application
Terminal=false
StartupNotify=true
Categories=Development;
MimeType=x-scheme-handler/unityhub;application/x-unityhub;

"""
VENDOR_WRAPPER = b"""#!/usr/bin/env bash

# Uncomment for debugging purposes:
# set -eux

UNPRIVILEGED_USERNS_ENABLED=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)
# Resolve the real install dir even when invoked through symlinks. The deb/rpm
# payload ships /usr/bin/unityhub as a RELATIVE symlink (../lib/unityhub/unityhub),
# which the previous hand-rolled readlink loop resolved against the caller's CWD
# instead of the symlink's directory \xe2\x80\x94 breaking `unityhub` from a terminal and the
# .desktop launcher. (It only ever worked through the fpm-era update-alternatives
# links, which were absolute.) `readlink -f` canonicalizes the whole chain; GNU
# coreutils is a given \xe2\x80\x94 this script only runs on Linux.
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# Disable the Chromium sandbox only where it cannot work: kernels without
# unprivileged user namespaces (sysctl missing or 0). Built as an array so an
# empty result contributes NO argv entry \xe2\x80\x94 the old quoted `$( ... && echo )`
# form always passed one argument, an empty string when userns is enabled.
LAUNCH_ARGS=()
if [[ $UNPRIVILEGED_USERNS_ENABLED == '' || $UNPRIVILEGED_USERNS_ENABLED == 0 ]]; then
  LAUNCH_ARGS+=('--no-sandbox')
fi

exec "$SCRIPT_DIR/unityhub-bin" "${LAUNCH_ARGS[@]}" "$@"
"""
# Role metadata from native payload-inventory.json, SHA-256
# 36d73d32c823c1a0a9a14f9205d7958ad03580f70c03a58a03844ea1ee2d1dd4.
RETAINED_ROLES = {
    "usr/share/applications/unityhub.desktop": {"kind": "file", "mode": 0o644, "archiveUid": 0, "archiveGid": 0,
        "size": 275, "sha256": "f841d4a8bcce4c7c6862d27b03721a828d3565182c5fc29a0a3b7a843733982b"},
    "usr/bin/unityhub": {"kind": "symlink", "mode": 0o777, "archiveUid": 0, "archiveGid": 0,
        "target": "../lib/unityhub/unityhub", "resolved": "usr/lib/unityhub/unityhub"},
    "usr/lib/unityhub/unityhub": {"kind": "file", "mode": 0o755, "archiveUid": 0, "archiveGid": 0,
        "size": 1272, "sha256": "c11cdd62708d2d35b1365dbdd9df1de0014d935aaee81c94d86b42e01ce11129"},
    "usr/lib/unityhub/unityhub-bin": {"kind": "file", "mode": 0o755, "archiveUid": 0, "archiveGid": 0,
        "size": 228605256, "sha256": "4d402a71bfa797a6bcbe29e5360abfb684d18358a0e631bdc0cb4f0de879b254"},
}


class Response(io.BytesIO):
    def __init__(self, raw, url, status=200, length=None):
        super().__init__(raw)
        self.url, self.status = url, status
        self.headers = {} if length is None else {"Content-Length": str(length)}

    def geturl(self):
        return self.url


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        # Windows pure byte fixtures do not establish Linux no-follow/UID behavior.
        for name in ("O_NOFOLLOW", "O_CLOEXEC", "O_NONBLOCK"):
            if not hasattr(C.os, name):
                patch = mock.patch.object(C.os, name, 0, create=True)
                patch.start()
                self.addCleanup(patch.stop)

    def env(self):
        return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": C.REPO, "GITHUB_REPOSITORY_ID": C.REPO_ID,
                "GITHUB_REF": C.BRANCH, "GITHUB_WORKFLOW_REF": C.WORKFLOW, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "UNITY_HUB_CAPTURE_REQUEST": C.REQUEST, "GITHUB_SHA": "a" * 40,
                "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": str(self.root),
                "GITHUB_WORKSPACE": str(HERE.parent)}

    def admit(self, env=None, **kwargs):
        C.admission(self.env() if env is None else env, system="Linux", machine="x86_64", uid=1001, euid=1001, **kwargs)

    def index(self, override=None, duplicate=False):
        fields = {"Package": C.PACKAGE, "Version": C.VERSION, "Architecture": "amd64", "Filename": C.DEB_MEMBER,
                  "Size": str(C.PINS["deb"][0]), "SHA256": C.PINS["deb"][1], "Installed-Size": "514709",
                  "Depends": "libgtk-3-0", "Pre-Depends": "", "Recommends": ""}
        fields.update(override or {})
        raw = ("\n".join(name + ": " + value for name, value in fields.items()) + "\n\n").encode()
        if duplicate:
            raw *= 2
        zipped = gzip.compress(raw, mtime=0)
        release = ("Suite: stable\nCodename: stable\nOrigin: Artifactory\nDate: Tue, 13 Oct 2026 21:12:32 UTC\nSHA256:\n "
                   + C.pin(zipped)["sha256"] + " " + str(len(zipped)) + " main/binary-amd64/Packages.gz\n").encode()
        pins = {"packages": (len(zipped), C.pin(zipped)["sha256"]), "packages-raw": (len(raw), C.pin(raw)["sha256"])}
        return release, zipped, pins

    def tar(self, members):
        path = self.root / "payload.tar"
        with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as archive:
            for name, kind, value, mode in members:
                entry = tarfile.TarInfo(name)
                entry.mode, entry.uid, entry.gid = mode, 0, 0
                entry.type = kind
                if kind == tarfile.REGTYPE:
                    entry.size = len(value)
                    archive.addfile(entry, io.BytesIO(value))
                else:
                    entry.linkname = value
                    archive.addfile(entry)
        return path

    def test_exact_manual_context(self):
        self.admit()

    def test_every_fixed_authority_field_is_required(self):
        for field in ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF", "GITHUB_WORKFLOW_REF",
                      "GITHUB_EVENT_NAME", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "UNITY_HUB_CAPTURE_REQUEST"):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.admit({**self.env(), field: "foreign"})

    def test_run_and_source_format(self):
        for field, value in (("GITHUB_SHA", "A" * 40), ("GITHUB_RUN_ID", "0"), ("GITHUB_RUN_ATTEMPT", "01")):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.admit({**self.env(), field: value})

    def test_root_other_platform_and_uid_transition_refused(self):
        for system, machine, uid, euid in (("Windows", "x86_64", 1, 1), ("Linux", "arm64", 1, 1),
                                          ("Linux", "x86_64", 0, 0), ("Linux", "x86_64", 1, 0)):
            with self.subTest(system=system, uid=uid), self.assertRaises(RuntimeError):
                C.admission(self.env(), system=system, machine=machine, uid=uid, euid=euid)

    def test_injection_and_proxy_variables_refused_even_empty(self):
        for name in ("LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "SSL_CERT_FILE", "CURL_CA_BUNDLE",
                     "UNITY_NO_CONSENT_PROMPT", "ELECTRON_DISABLE_SANDBOX", "CHROME_FLAGS", "https_proxy", "FLATPAK_ID"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                self.admit({**self.env(), name: ""})

    def test_inherited_refusal_reports_only_forbidden_names_never_values(self):
        with self.assertRaises(RuntimeError) as caught:
            self.admit({**self.env(), "CHROME_BIN": "DO_NOT_EXPORT_THIS_VALUE", "DISPLAY": "ALSO_PRIVATE"})
        message = str(caught.exception)
        self.assertTrue(message.startswith("Inherited injection or sandbox/trust override refused; "))
        details = json.loads(message.split("; ", 1)[1])
        self.assertEqual(details, {"forbiddenEnvNames": ["CHROME_BIN"], "omitted": 0})
        self.assertNotIn("DO_NOT_EXPORT", message)
        self.assertNotIn("ALSO_PRIVATE", message)
        self.assertNotIn("DISPLAY", message)

    def test_controller_still_refuses_chrome_locator_empty_or_populated(self):
        for value in ("", "/unused/runner/chrome", "PRIVATE_VALUE --no-sandbox"):
            with self.subTest(value=value), self.assertRaises(RuntimeError) as caught:
                self.admit({**self.env(), "CHROME_BIN": value})
            details = json.loads(str(caught.exception).split("; ", 1)[1])
            self.assertEqual(details["forbiddenEnvNames"], ["CHROME_BIN"])
            self.assertNotIn("PRIVATE_VALUE", str(caught.exception))

    def test_removing_only_chrome_locator_does_not_clear_other_refusals(self):
        for name in ("CHROME_FLAGS", "ELECTRON_DISABLE_SANDBOX", "LD_PRELOAD", "SSL_CERT_FILE", "https_proxy"):
            env = {**self.env(), "CHROME_BIN": "/unused/runner/chrome", name: ""}
            del env["CHROME_BIN"]
            with self.subTest(name=name), self.assertRaises(RuntimeError) as caught:
                self.admit(env)
            self.assertEqual(json.loads(str(caught.exception).split("; ", 1)[1])["forbiddenEnvNames"], [name])

    def test_inherited_name_diagnostic_is_bounded_and_control_safe(self):
        names = ["LD_" + "a" * 200, "LD_\nprivate", "LD_\udcff"] + ["CHROME_NAME_" + str(i) for i in range(20)]
        with self.assertRaises(RuntimeError) as caught:
            self.admit({**self.env(), **dict.fromkeys(names, "NEVER_LOG_VALUE")})
        message = str(caught.exception)
        details = json.loads(message.split("; ", 1)[1])
        self.assertLessEqual(len(message), 512)
        self.assertEqual(len(details["forbiddenEnvNames"]), 4)
        self.assertEqual(details["omitted"], len(names) - 4)
        self.assertNotIn("NEVER_LOG_VALUE", message)
        self.assertNotIn("\n", message)

    def test_irregular_forbidden_name_is_hashed_not_exported(self):
        name = "LD_\n" + "x" * 200
        with self.assertRaises(RuntimeError) as caught:
            self.admit({**self.env(), name: "PRIVATE"})
        details = json.loads(str(caught.exception).split("; ", 1)[1])
        self.assertEqual(details["forbiddenEnvNames"], ["sha256:" + C.hashlib.sha256(name.encode()).hexdigest()])
        self.assertNotIn(name, str(caught.exception))

    def test_original_inherited_rejection_predicate_is_unchanged(self):
        original = r"^(LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|SSL_CERT_|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|UNITY_|HUB_|ELECTRON_|CHROME_|FLATPAK_ID$)"
        names = ("DISPLAY", "CHROME_BIN", "CHROME_FLAGS", "chrome_bin", "ALL_PROXY", "no_proxy", "prefixPROXY",
                 "PYTHONPATH", "PYTHONPATH_EXTRA", "HUB_HOME", "ELECTRON_FLAGS", "UNITY_NO_CONSENT_PROMPT", "UNITY_HUB_CAPTURE_REQUEST")
        for name in names:
            env = self.env() if name == "UNITY_HUB_CAPTURE_REQUEST" else {**self.env(), name: ""}
            rejected = (re.match(original, name) and name != "UNITY_HUB_CAPTURE_REQUEST") or name.lower().endswith("proxy")
            with self.subTest(name=name):
                if rejected:
                    with self.assertRaises(RuntimeError):
                        self.admit(env)
                else:
                    self.admit(env)

    def test_actual_admit_entrypoint_has_no_setup_download_gui_or_environment_mutation(self):
        env = self.env()
        with mock.patch.dict(C.os.environ, env, clear=True), mock.patch.object(sys, "argv", [str(SPEC.origin), "admit"]), \
                mock.patch.object(C.platform, "system", return_value="Linux"), \
                mock.patch.object(C.platform, "machine", return_value="x86_64"), \
                mock.patch.object(C.os, "getuid", return_value=1001, create=True), \
                mock.patch.object(C.os, "geteuid", return_value=1001, create=True), \
                mock.patch.object(C.os, "mkdir", side_effect=AssertionError("No setup allowed")), \
                mock.patch.object(C.urllib.request, "build_opener", side_effect=AssertionError("No network allowed")), \
                mock.patch.object(C.subprocess, "Popen", side_effect=AssertionError("No process allowed")), \
                mock.patch.dict(sys.modules, {"gi": None}):
            runpy.run_path(str(SPEC.origin), run_name="__main__")
            self.assertEqual(dict(C.os.environ), env)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_private_closed_environment(self):
        value = C.environment(self.root)
        self.assertEqual(value["HOME"], str(self.root / "home"))
        self.assertEqual(value["XDG_CONFIG_HOME"], str(self.root / "home/config"))
        self.assertEqual(set(value), {"PATH", "LANG", "LC_ALL", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                                      "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"})

    def test_wrapper_restores_private_environment_after_dbus_and_xvfb(self):
        args = C.session_command(self.root)
        self.assertEqual(args[:4], ["/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a"])
        position = args.index("/usr/bin/env")
        for name, value in C.environment(self.root).items():
            self.assertIn(name + "=" + value, args[position + 1:])
        self.assertEqual(args[-2:], [str(HERE / "native-linux-unity-hub-registry-capture.py"), "observe"])

    def test_all_qualification_flags_are_false(self):
        self.assertGreaterEqual(len(C.FALSE), 8)
        self.assertTrue(all(value is False for value in C.FALSE.values()))

    def test_bounded_read_and_create_only_evidence(self):
        path = self.root / "evidence.json"
        C.write_new(path, b"abc")
        self.assertEqual(C.read(path, 3, C.pin(b"abc")), b"abc")
        with self.assertRaises(RuntimeError):
            C.read(path, 2)
        with self.assertRaises(FileExistsError):
            C.write_new(path, b"replacement")
        self.assertEqual(path.read_bytes(), b"abc")

    def test_json_limit_precedes_write(self):
        path = self.root / "too-large.json"
        with self.assertRaises(RuntimeError):
            C.save(path, {"value": "x" * 100}, 20)
        self.assertFalse(path.exists())

    def test_source_gate_binds_exact_five_files(self):
        with mock.patch.object(C, "file_pin", return_value=C.pin(b"source")) as check:
            result = C.source_gate(self.env())
        self.assertEqual(set(result), set(C.SOURCES))
        self.assertEqual(check.call_count, 5)

    def test_empty_desktop_uses_local_reader_not_nonempty_root_helper(self):
        _helper, native = C.helpers()
        x11 = mock.Mock()
        x11.property.return_value = (33, 32, [])
        with self.assertRaisesRegex(RuntimeError, "WM client inventory unavailable"):
            native.client_ids(x11)
        self.assertEqual(C.wm_client_ids(x11), [])
        self.assertEqual(x11.property.call_args.args[1], "_NET_CLIENT_LIST_STACKING")

    def test_nonempty_inventory_matches_unchanged_real_helper_contract(self):
        _helper, native = C.helpers()
        x11 = mock.Mock()
        x11.property.return_value = (33, 32, [100, 200])
        self.assertEqual(C.wm_client_ids(x11), native.client_ids(x11))

    def test_local_inventory_rejects_missing_malformed_duplicate_or_unbounded_ids(self):
        for value in (None, (6, 32, []), (33, 8, []), (33, 32), (33, 32, ""), (33, 32, [1, 1]),
                      (33, 32, [0]), (33, 32, [True]), (33, 32, [2**32]), (33, 32, list(range(1, 34)))):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                x11 = mock.Mock()
                x11.property.return_value = value
                C.wm_client_ids(x11)

    def test_real_request_parser_rejects_numeric_pid_and_accepts_strings(self):
        helper, _native = C.helpers()
        args = ["snapshot", "123", "456", str(self.root / "owned-hub"), C.pin(b"image")["sha256"], "100", "Unity Hub", "FRAME"]
        request = helper.Request.parse(args)
        self.assertEqual((request.pid, request.window, request.start), (123, 100, "456"))
        with self.assertRaises(TypeError):
            helper.Request.parse([args[0], 123, *args[2:]])

    def test_fixed_prerequisites_are_checked_without_launch_or_gui_initialization(self):
        gi, repository = types.ModuleType("gi"), types.ModuleType("gi.repository")
        gi.require_version = mock.Mock()
        repository.Atspi, repository.Gdk, repository.GdkX11 = mock.Mock(), mock.Mock(), mock.Mock()
        gi.repository = repository
        with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}), \
                mock.patch.object(C, "admission") as admit, \
                mock.patch.object(C, "system_tool", return_value=C.pin(b"system")) as check, \
                mock.patch.object(C.subprocess, "Popen") as launch:
            value = C.prerequisites(self.env())
        admit.assert_called_once_with(self.env())
        self.assertEqual([call.args[0] for call in check.call_args_list], [*C.SYSTEM_TOOLS, *C.GUI_TOOLS])
        self.assertEqual(gi.require_version.call_args_list, [mock.call("Atspi", "2.0"), mock.call("Gdk", "3.0"), mock.call("GdkX11", "3.0")])
        repository.Gdk.init.assert_not_called()
        launch.assert_not_called()
        self.assertFalse(value["candidateExecuted"])
        self.assertTrue(all(value[name] is False for name in C.FALSE))

    def test_prerequisite_authority_refusal_precedes_every_tool(self):
        with mock.patch.object(C, "admission", side_effect=RuntimeError("not an admitted runner")), \
                mock.patch.object(C, "system_tool") as check, self.assertRaises(RuntimeError):
            C.prerequisites(self.env())
        check.assert_not_called()

    def test_prerequisite_missing_tool_refuses_before_gi_import_or_launch(self):
        gi = types.ModuleType("gi")
        gi.require_version = mock.Mock()
        with mock.patch.dict(sys.modules, {"gi": gi}), mock.patch.object(C, "admission"), \
                mock.patch.object(C, "system_tool", side_effect=FileNotFoundError("missing tool")), \
                mock.patch.object(C.subprocess, "Popen") as launch, self.assertRaises(FileNotFoundError):
            C.prerequisites(self.env())
        gi.require_version.assert_not_called()
        launch.assert_not_called()

    def test_direct_pinned_download_without_network(self):
        raw = b"fixed public metadata"
        opener = mock.Mock()
        opener.open.return_value = Response(raw, C.URLS["key"][0], length=len(raw))
        with mock.patch.object(C.urllib.request, "build_opener", return_value=opener), \
                mock.patch.dict(C.PINS, {"key": (len(raw), C.pin(raw)["sha256"])}):
            self.assertEqual(C.download("key", self.root / "key"), C.pin(raw))
        self.assertEqual(opener.open.call_count, 1)

    def test_only_exact_observed_official_redirect(self):
        raw = b"key"
        opener = mock.Mock()
        redirect = urllib.error.HTTPError(C.URLS["key"][0], 302, "Found", {"Location": C.URLS["key"][1]}, io.BytesIO())
        opener.open.side_effect = [redirect, Response(raw, C.URLS["key"][1])]
        with mock.patch.object(C.urllib.request, "build_opener", return_value=opener), \
                mock.patch.dict(C.PINS, {"key": (len(raw), C.pin(raw)["sha256"])}):
            C.download("key", self.root / "key")
        self.assertEqual(opener.open.call_args_list[1].args[0], C.URLS["key"][1])

    def test_foreign_redirect_refused_before_file_creation(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(C.URLS["key"][0], 302, "Found",
                                                       {"Location": "https://example.invalid/key"}, io.BytesIO())
        with mock.patch.object(C.urllib.request, "build_opener", return_value=opener), self.assertRaises(RuntimeError):
            C.download("key", self.root / "key")
        self.assertFalse((self.root / "key").exists())
        self.assertEqual(opener.open.call_count, 1)

    def test_wrong_download_bytes_retain_failed_evidence(self):
        opener = mock.Mock()
        opener.open.return_value = Response(b"bad", C.URLS["key"][0])
        with mock.patch.object(C.urllib.request, "build_opener", return_value=opener), \
                mock.patch.dict(C.PINS, {"key": (3, C.pin(b"key")["sha256"])}), self.assertRaises(RuntimeError):
            C.download("key", self.root / "key")
        self.assertEqual((self.root / "key").read_bytes(), b"bad")

    def test_no_unknown_download_role(self):
        with mock.patch.object(C.urllib.request, "build_opener") as opener, self.assertRaises(RuntimeError):
            C.download("user-url", self.root / "key")
        opener.assert_not_called()

    def test_signed_index_exact_candidate(self):
        release, zipped, pins = self.index()
        with mock.patch.dict(C.PINS, pins):
            value = C.index_binding(release, zipped)
        self.assertEqual((value["Package"], value["Version"], value["Architecture"]), ("unityhub", "3.22.3", "amd64"))

    def test_signed_index_wrong_candidate_metadata(self):
        for field, value in (("Version", "3.22.2"), ("Architecture", "arm64"), ("Filename", "other.deb"),
                             ("Size", "1"), ("SHA256", "0" * 64), ("Installed-Size", "1")):
            release, zipped, pins = self.index({field: value})
            with self.subTest(field=field), mock.patch.dict(C.PINS, pins), self.assertRaises(RuntimeError):
                C.index_binding(release, zipped)

    def test_duplicate_candidate_refused(self):
        release, zipped, pins = self.index(duplicate=True)
        with mock.patch.dict(C.PINS, pins), self.assertRaises(RuntimeError):
            C.index_binding(release, zipped)

    def test_duplicate_deb822_field_and_body_refused(self):
        for raw in (b"Package: unityhub\nPackage: other\n", b"Package: unityhub\n\nbody"):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                C.stanza(raw)

    def test_stale_release_and_wrong_index_pin_refused(self):
        release, zipped, pins = self.index()
        for bad in (release.replace(b"13 Oct", b"12 Oct"), release.replace(C.pin(zipped)["sha256"].encode(), b"0" * 64)):
            with mock.patch.dict(C.PINS, pins), self.assertRaises(RuntimeError):
                C.index_binding(bad, zipped)

    def test_second_gzip_member_refused_even_with_matching_outer_hash(self):
        release, zipped, pins = self.index()
        new = zipped + gzip.compress(b"unexpected", mtime=0)
        release = release.replace(C.pin(zipped)["sha256"].encode(), C.pin(new)["sha256"].encode()).replace(
            (" " + str(len(zipped)) + " ").encode(), (" " + str(len(new)) + " ").encode())
        pins["packages"] = (len(new), C.pin(new)["sha256"])
        with mock.patch.dict(C.PINS, pins), self.assertRaises(RuntimeError):
            C.index_binding(release, new)

    def test_gpg_uses_new_private_public_only_keyring(self):
        fingerprint = C.FINGERPRINT
        status = ("[GNUPG:] VALIDSIG " + fingerprint + " 2026-10-13 1 0 4 0 1 10 01 " + fingerprint + "\n").encode()
        def read(path, *_args):
            return status if path.name == "apt-signature.stderr" else b"public bytes"
        with mock.patch.object(C, "download") as download, mock.patch.object(C, "read", side_effect=read), \
                mock.patch.object(C, "run_tool", side_effect=[self.root / "ring", self.root / "cleartext"]) as tool, \
                mock.patch.object(C, "index_binding", return_value={"verified": True}):
            self.assertEqual(C.verify_metadata(self.root), {"verified": True})
        self.assertEqual([call.args[0] for call in download.call_args_list], ["key", "inrelease", "packages"])
        self.assertIn("--no-options", tool.call_args_list[0].args[2])
        self.assertEqual(tool.call_args_list[0].kwargs["body"], b"public bytes")
        self.assertIn(str(self.root / "ring"), tool.call_args_list[1].args[2])

    def test_foreign_or_expired_signature_never_reaches_index_parser(self):
        good = "[GNUPG:] VALIDSIG " + C.FINGERPRINT + " 2026 1 0 4 0 1 10 01 " + C.FINGERPRINT + "\n"
        for status in (good.replace(C.FINGERPRINT, "0" * 40), good + "[GNUPG:] EXPKEYSIG key\n", good + good):
            with self.subTest(status=status[:60]), mock.patch.object(C, "download"), \
                    mock.patch.object(C, "read", side_effect=lambda path, *_: status.encode() if path.name == "apt-signature.stderr" else b"public"), \
                    mock.patch.object(C, "run_tool", return_value=self.root / "output"), \
                    mock.patch.object(C, "index_binding") as parse, self.assertRaises(RuntimeError):
                C.verify_metadata(self.root)
            parse.assert_not_called()

    def test_safe_inventory_and_expected_chrome_sandbox_mode(self):
        path = self.tar([("opt", tarfile.DIRTYPE, "", 0o755), ("opt/unityhub", tarfile.DIRTYPE, "", 0o755),
                         ("opt/unityhub/chrome-sandbox", tarfile.REGTYPE, b"sandbox", 0o4755)])
        records = C.inventory(path)
        self.assertEqual(records["opt/unityhub/chrome-sandbox"]["mode"], 0o4755)
        self.assertEqual(records["opt/unityhub/chrome-sandbox"]["sha256"], C.pin(b"sandbox")["sha256"])

    def test_archive_unsafe_paths(self):
        for name in ("../escape", "/absolute", "a/../b", "a//b", "a\\b", "a\nname"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                C.inventory(self.tar([(name, tarfile.REGTYPE, b"x", 0o644)]))

    def test_hardlink_device_and_unreviewed_special_mode_refused(self):
        for kind, mode in ((tarfile.LNKTYPE, 0o644), (tarfile.CHRTYPE, 0o600), (tarfile.REGTYPE, 0o4755),
                           (tarfile.REGTYPE, 0o2755), (tarfile.REGTYPE, 0o1755)):
            with self.subTest(kind=kind, mode=mode), self.assertRaises(RuntimeError):
                C.inventory(self.tar([("foreign", kind, b"x" if kind == tarfile.REGTYPE else "target", mode)]))

    def test_duplicate_archive_entry_refused(self):
        with self.assertRaises(RuntimeError):
            C.inventory(self.tar([("file", tarfile.REGTYPE, b"a", 0o644), ("file", tarfile.REGTYPE, b"b", 0o644)]))

    def test_link_escape_unresolved_cycle_and_write_through_refused(self):
        cases = [[("link", tarfile.SYMTYPE, "../escape", 0o777)],
                 [("link", tarfile.SYMTYPE, "missing", 0o777)],
                 [("a", tarfile.SYMTYPE, "b", 0o777), ("b", tarfile.SYMTYPE, "a", 0o777)],
                 [("dir", tarfile.REGTYPE, b"x", 0o644), ("dir/file", tarfile.REGTYPE, b"x", 0o644)]]
        for members in cases:
            with self.subTest(members=members), self.assertRaises(RuntimeError):
                C.inventory(self.tar(members))

    def test_no_unbounded_member_or_entry_count(self):
        path = self.tar([("file", tarfile.REGTYPE, b"xx", 0o644)])
        for name, bound in (("MAX_FILE", 1), ("MAX_TAR", 1), ("MAX_ENTRIES", 0)):
            with self.subTest(name=name), mock.patch.object(C, name, bound), self.assertRaises(RuntimeError):
                C.inventory(path)

    def vendor_launch_fixture(self, *, records=None, desktop=VENDOR_DESKTOP, wrapper=VENDOR_WRAPPER,
                              target="../lib/unityhub/unityhub", native_header=None):
        path = self.root / C.NATIVE
        path.parent.mkdir(parents=True, exist_ok=True)
        (self.root / C.DESKTOP).parent.mkdir(parents=True, exist_ok=True)
        (self.root / C.DESKTOP).write_bytes(desktop)
        (self.root / C.WRAPPER).write_bytes(wrapper)
        head = bytearray(20)
        head[:7], head[16:20] = b"\x7fELF\x02\x01\x01", b"\x03\x00\x3e\x00"
        path.write_bytes(head if native_header is None else native_header)
        link = self.root / C.LAUNCH_LINK
        real_lstat, real_pin = Path.lstat, C.file_pin
        def lstat(value):
            return types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777) if value == link else real_lstat(value)
        def check(value, limit, wanted=None):
            if value == path:
                native_pin = {key: RETAINED_ROLES[C.NATIVE][key] for key in ("size", "sha256")}
                self.assertEqual(wanted, native_pin)
                return native_pin
            return real_pin(value, limit, wanted)
        # Only the large ELF and link are mocked; both small public text files are truly hashed.
        with mock.patch.object(Path, "lstat", autospec=True, side_effect=lstat), \
                mock.patch.object(C.os, "readlink", return_value=target), mock.patch.object(C, "file_pin", side_effect=check):
            return C.launch_image(self.root, RETAINED_ROLES if records is None else records)

    def test_exact_retained_vendor_roles_and_text_pins(self):
        self.assertEqual(C.LAUNCH_ROLES, RETAINED_ROLES)
        for name, raw in ((C.DESKTOP, VENDOR_DESKTOP), (C.WRAPPER, VENDOR_WRAPPER)):
            self.assertEqual(C.pin(raw), {key: RETAINED_ROLES[name][key] for key in ("size", "sha256")})
        value = self.vendor_launch_fixture()
        self.assertEqual(value["relative"], C.NATIVE)
        self.assertEqual(value["wrapper"]["relative"], C.WRAPPER)

    def test_old_assumed_layout_and_changed_vendor_roles_refuse(self):
        for name, field, value in ((C.NATIVE, "size", 20), (C.NATIVE, "sha256", "0" * 64),
                                   (C.WRAPPER, "kind", "symlink"), (C.LAUNCH_LINK, "target", "/foreign/launcher")):
            records = json.loads(json.dumps(RETAINED_ROLES))
            records[name][field] = value
            with self.subTest(name=name, field=field), self.assertRaises(RuntimeError):
                self.vendor_launch_fixture(records=records)
        with self.assertRaises(RuntimeError):
            self.vendor_launch_fixture(records={"opt/unityhub/unityhub": RETAINED_ROLES[C.NATIVE]})

    def test_foreign_actual_symlink_and_changed_vendor_text_refuse(self):
        with self.assertRaises(RuntimeError):
            self.vendor_launch_fixture(target="/foreign/launcher")
        with self.assertRaises(RuntimeError):
            self.vendor_launch_fixture(desktop=VENDOR_DESKTOP.replace(b"Exec=unityhub %U", b"Exec=unityhub https://example.invalid"))
        with self.assertRaises(RuntimeError):
            self.vendor_launch_fixture(wrapper=VENDOR_WRAPPER + b"# changed\n")

    def test_native_header_is_checked_independently_of_inventory_pin(self):
        with self.assertRaisesRegex(RuntimeError, "Native x64 Hub ELF"):
            self.vendor_launch_fixture(native_header=b"not a native ELF file")

    def test_fixed_vendor_payload_refuses_an_added_sandbox_helper(self):
        records = json.loads(json.dumps(RETAINED_ROLES))
        records["usr/lib/unityhub/chrome-sandbox"] = {"kind": "file"}
        with self.assertRaisesRegex(RuntimeError, "Unexpected sandbox helper"):
            self.vendor_launch_fixture(records=records)

    def test_process_owner_uses_real_live_stat_parser_and_exact_uid_parent(self):
        real_helper, _ = C.helpers()
        child, proc, native = mock.Mock(), mock.Mock(), mock.Mock()
        child.pid, child.poll.return_value = 123, None
        def record(start="456", parent=None, state="S"):
            return "123 (vendor wrapper) " + " ".join([state, str(os.getpid() if parent is None else parent), *(["0"] * 17), start])
        helper = types.SimpleNamespace(Proc=lambda: proc, parse_start=real_helper.parse_start)
        proc.stat.return_value = record()
        native.process_uids.return_value = [1001] * 4
        with mock.patch.object(C.os, "getuid", return_value=1001, create=True):
            self.assertEqual(C.process_owner(child, helper, native), {"pid": 123, "startTime": "456", "parentPid": os.getpid(), "uids": [1001] * 4})
            for kind in ("start", "parent", "uid", "terminal"):
                proc.stat.side_effect = None
                proc.stat.return_value = record()
                native.process_uids.return_value = [1001] * 4
                if kind == "start":
                    proc.stat.side_effect = [record(), record(start="999")]
                elif kind == "parent":
                    proc.stat.return_value = record(parent=os.getpid() + 1)
                elif kind == "uid":
                    native.process_uids.return_value = [1001, 0, 1001, 1001]
                else:
                    proc.stat.return_value = record(state="Z")
                with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                    C.process_owner(child, helper, native)

    def test_kernel_exec_fd_hash_identity_and_finite_paths(self):
        path = self.root / "mock-image"
        path.write_bytes(b"held image")
        allowed = {"/usr/bin/env": C.pin(b"held image")}
        for kind in ("valid", "foreign", "hash", "links", "identity"):
            fd = os.open(path, os.O_RDONLY)
            real = os.fstat(fd)
            fields = {key: getattr(real, key) for key in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid",
                                                        "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")}
            snapshots = [real, real]
            if kind == "links":
                snapshots[0] = types.SimpleNamespace(**{**fields, "st_nlink": 2})
            if kind == "identity":
                snapshots[1] = types.SimpleNamespace(**{**fields, "st_ino": fields["st_ino"] + 1})
            pins = allowed if kind != "hash" else {"/usr/bin/env": {**allowed["/usr/bin/env"], "sha256": "0" * 64}}
            with self.subTest(kind=kind), mock.patch.object(C.os, "open", return_value=fd), \
                    mock.patch.object(C.os, "readlink", return_value="/foreign/image" if kind == "foreign" else "/usr/bin/env"), \
                    mock.patch.object(C.os, "fstat", side_effect=snapshots):
                if kind == "valid":
                    self.assertEqual(C.kernel_exec_image(123, pins), "/usr/bin/env")
                else:
                    with self.assertRaises(RuntimeError):
                        C.kernel_exec_image(123, pins)
            with self.assertRaises(OSError):
                os.fstat(fd)

    def exec_fixture(self, *, images=None, argv=None, owner_drift=None, native_drift=None, kernel_error=None, expired=False):
        child, helper, native, output, wm_output = (mock.Mock() for _ in range(5))
        child.pid = 123
        executable = self.root / "image" / C.NATIVE
        image_pin = C.pin(b"native")
        owner = {"pid": 123, "startTime": "456", "parentPid": os.getpid(), "uids": [1001] * 4}
        native.native_process.return_value = {**owner, "executable": str(executable), "kernelImageSha256": image_pin["sha256"], **(native_drift or {})}
        owner_calls = None if owner_drift is None else [owner, owner, {**owner, **owner_drift}]
        self.exec_native = native
        self.exec_child = child
        with mock.patch.object(C, "process_owner", return_value=owner, side_effect=owner_calls), \
                mock.patch.object(C, "kernel_exec_image", side_effect=kernel_error or (images if images is not None else ["/usr/bin/env", "/usr/bin/bash", str(executable)])), \
                mock.patch.object(C.time, "monotonic", return_value=2 if expired else 0), \
                mock.patch("builtins.open", mock.mock_open(read_data=os.fsencode(executable) + b"\0" if argv is None else argv)) as read:
            value = C.await_vendor_exec(child, executable, image_pin,
                {"/usr/bin/env": C.pin(b"env"), "/usr/bin/bash": C.pin(b"bash")}, helper, native, output, wm_output, 1)
        read.assert_called_once_with("/proc/123/cmdline", "rb")
        return value

    def test_owned_vendor_exec_allows_only_ordered_pinned_interpreters_then_native(self):
        process, proof = self.exec_fixture()
        self.assertEqual(process["pid"], 123)
        self.assertEqual(proof["observedImages"], ["/usr/bin/env", "/usr/bin/bash", str(self.root / "image" / C.NATIVE)])
        self.assertTrue(proof["nativeArgvExact"])

    def test_vendor_exec_already_native_still_requires_owner_and_argv(self):
        process, proof = self.exec_fixture(images=[str(self.root / "image" / C.NATIVE)])
        self.assertEqual(proof["owner"]["startTime"], process["startTime"])
        self.assertTrue(proof["nativeArgvExact"])

    def test_vendor_exec_refuses_argv_flags_urls_and_empty_arguments(self):
        executable = os.fsencode(self.root / "image" / C.NATIVE)
        for argv in (executable + b"\0--no-sandbox\0", executable + b"\0https://example.invalid\0", executable + b"\0\0", b""):
            with self.subTest(argv=argv), self.assertRaisesRegex(RuntimeError, "argv differs"):
                self.exec_fixture(argv=argv)

    def test_vendor_exec_refuses_pid_start_uid_or_parent_drift_before_acceptance(self):
        for drift in ({"pid": 124}, {"startTime": "999"}, {"parentPid": os.getpid() + 1}, {"uids": [0] * 4}):
            with self.subTest(drift=drift), self.assertRaises(RuntimeError):
                self.exec_fixture(owner_drift=drift)
            self.exec_native.native_process.assert_not_called()

    def test_vendor_exec_never_ignores_foreign_image_or_snapshot_error(self):
        with self.assertRaisesRegex(RuntimeError, "Unexpected owned exec image"):
            self.exec_fixture(kernel_error=RuntimeError("Unexpected owned exec image"))
        self.exec_native.native_process.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "regressed"):
            self.exec_fixture(images=["/usr/bin/bash", "/usr/bin/env"])
        with self.assertRaisesRegex(RuntimeError, "deadline"):
            self.exec_fixture(expired=True)
        self.exec_child.terminate.assert_not_called()
        self.exec_child.kill.assert_not_called()

    def test_vendor_exec_requires_final_native_kernel_pin_and_owner(self):
        for drift in ({"kernelImageSha256": "0" * 64}, {"executable": "/foreign/native"}, {"startTime": "999"}):
            with self.subTest(drift=drift), self.assertRaises(RuntimeError):
                self.exec_fixture(native_drift=drift)

    def test_stage_metadata_refusal_precedes_installer_download_and_tools(self):
        def mkdir(path):
            path.mkdir()
        with mock.patch.object(C, "admission"), mock.patch.object(C, "source_gate", return_value={}), \
                mock.patch.object(C, "root_path", return_value=self.root / "stage"), \
                mock.patch.object(C, "private_directory", side_effect=mkdir), \
                mock.patch.object(C, "verify_metadata", side_effect=RuntimeError("signature refusal")), \
                mock.patch.object(C, "download") as download, mock.patch.object(C, "run_tool") as tool, \
                self.assertRaisesRegex(RuntimeError, "signature refusal"):
            C.stage(self.env())
        download.assert_not_called()
        tool.assert_not_called()
        report = json.loads((self.root / "stage/evidence/stage.json").read_text())
        self.assertFalse(report["stageComplete"])
        self.assertFalse(report["candidateExecuted"])
        self.assertTrue(all(report[name] is False for name in C.FALSE))

    def test_missing_gui_dependency_is_retained_without_launch(self):
        (self.root / "evidence").mkdir()
        with mock.patch.object(C, "review_stage", return_value=(self.root, {})), \
                mock.patch.object(C, "system_tool", side_effect=RuntimeError("missing prerequisite")), \
                mock.patch.object(C.subprocess, "Popen") as launch, self.assertRaisesRegex(RuntimeError, "missing prerequisite"):
            C.session(self.env())
        launch.assert_not_called()
        report = json.loads((self.root / "evidence/session.json").read_text())
        self.assertIn("missing prerequisite", report["refusal"])
        self.assertTrue((self.root / "evidence/session-attempt.json").exists())

    def test_consumed_session_attempt_prevents_second_launch(self):
        (self.root / "evidence").mkdir()
        C.write_new(self.root / "evidence/session-attempt.json", b"{}")
        with mock.patch.object(C, "review_stage", return_value=(self.root, {})), \
                mock.patch.object(C.subprocess, "Popen") as launch, self.assertRaises(FileExistsError):
            C.session(self.env())
        launch.assert_not_called()

    def observe_fixture(self, *, bitmap_error=None, changed_before_close=False, sandboxes=None):
        """Mocks only: no ELF, display, native imports, screenshot or input is executed."""
        (self.root / "evidence").mkdir()
        C.save(self.root / "evidence/session-attempt.json", {"attemptConsumed": True})
        env = {**self.env(), **C.environment(self.root), "DISPLAY": ":99", "DBUS_SESSION_BUS_ADDRESS": "unix:mock"}
        staged = {"image": {"relative": C.NATIVE, **{key: RETAINED_ROLES[C.NATIVE][key] for key in ("size", "sha256")},
                  "wrapper": {"relative": C.WRAPPER, **{key: RETAINED_ROLES[C.WRAPPER][key] for key in ("size", "sha256")}}},
                  "sources": {"fixture": C.pin(b"source")}}
        helper, native, wm, child, x11 = (mock.Mock() for _ in range(5))
        wm.poll.return_value = None
        alive = [True]
        child.pid = 123
        child.poll.side_effect = lambda: None if alive[0] else 0
        process = {"pid": 123, "parentPid": os.getpid(), "uids": [1001] * 4, "startTime": "456",
                   "executable": str(self.root / "image" / C.NATIVE), "kernelImageSha256": staged["image"]["sha256"]}
        bound = {"pid": 123, "mapped": True, "client": 10, "title": "Unity Hub"}
        clients = iter([[], [100], []])
        x11.property.side_effect = lambda _window, name: (33, 32, next(clients)) if name == "_NET_CLIENT_LIST_STACKING" else (33, 32, [1])
        x11.inspect.return_value = bound
        helper.X11.return_value = x11
        real_helper, _real_native = C.helpers()
        helper.Request.parse = mock.Mock(wraps=real_helper.Request.parse)
        helper.parse_start = real_helper.parse_start
        helper.Proc.return_value.stat.return_value = "123 (vendor) " + " ".join(["S", str(os.getpid()), *(["0"] * 17), "456"])
        helper.perform.return_value = {"actionCount": 0, "nodes": []}
        native.client_ids.side_effect = AssertionError("Nonempty-only Root helper must not gate this local desktop")
        native.native_process.return_value = process
        native.process_uids.return_value = [1001] * 4
        native.bitmap.return_value = {"mockOnly": True}
        if bitmap_error:
            native.bitmap.side_effect = bitmap_error
        def close(*_args):
            self.assertTrue((self.root / "evidence/normal-close-intent.json").exists())
            alive[0] = False
        x11.close_window.side_effect = close
        if changed_before_close:
            native.native_process.side_effect = [process] * 4 + [{**process, "startTime": "999"}]
        gi, repository = types.ModuleType("gi"), types.ModuleType("gi.repository")
        gi.require_version = mock.Mock()
        repository.Atspi, repository.Gdk = mock.Mock(), mock.Mock()
        gi.repository = repository
        real_file_pin = C.file_pin
        def image_pin(path, limit, wanted=None):
            for role in (C.NATIVE, C.WRAPPER):
                if path == self.root / "image" / role:
                    value = {key: RETAINED_ROLES[role][key] for key in ("size", "sha256")}
                    self.assertEqual(wanted, value)
                    return value
            return real_file_pin(path, limit, wanted)
        sandbox = {"readOnly": True, "kernelSettings": {C.USERNS_SYSCTL: "1"}, "chromeSandbox": None}
        with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}), \
                mock.patch.object(C, "review_stage", return_value=(self.root, staged)), \
                mock.patch.object(C, "helpers", return_value=(helper, native)), \
                mock.patch.object(C, "sandbox_observation", return_value=sandbox, side_effect=sandboxes), \
                mock.patch.object(C, "system_tool", return_value=C.pin(b"system")), \
                mock.patch.object(C, "kernel_exec_image", return_value=str(self.root / "image" / C.NATIVE)), \
                mock.patch("builtins.open", mock.mock_open(read_data=os.fsencode(self.root / "image" / C.NATIVE) + b"\0")), \
                mock.patch.object(C, "file_pin", side_effect=image_pin), \
                mock.patch.object(C.os, "getuid", return_value=1001, create=True), \
                mock.patch.object(C, "source_gate", return_value=staged["sources"]), \
                mock.patch.object(C, "Drain") as output, mock.patch.object(C, "wait_exit", return_value=0), \
                mock.patch.object(C.subprocess, "Popen", side_effect=[wm, child]) as launch:
            output.return_value.metadata.return_value = {}
            failure = None
            try:
                C.observe(env)
            except RuntimeError as error:
                failure = error
        report = json.loads((self.root / "evidence/observation.json").read_text())
        return report, failure, helper, x11, launch

    def test_mocked_first_run_snapshot_only_then_one_owned_normal_close(self):
        report, failure, helper, x11, launch = self.observe_fixture()
        self.assertIsNone(failure)
        self.assertTrue(report["observationCaptured"])
        self.assertTrue(report["normalCloseObserved"])
        self.assertTrue(all(report[name] is False for name in C.FALSE))
        self.assertEqual(helper.Request.parse.call_args.args[0][0], "snapshot")
        self.assertTrue(all(type(value) is str for value in helper.Request.parse.call_args.args[0]))
        helper.perform.assert_called_once()
        x11.close_window.assert_called_once_with(100, mock.ANY)
        self.assertEqual(launch.call_args_list[1].args[0], [str(self.root / "image" / C.WRAPPER)])
        self.assertEqual(helper.Request.parse.call_args.args[0][3], str(self.root / "image" / C.NATIVE))
        self.assertTrue(report["wrapperExec"]["nativeArgvExact"])
        x11.dispose.assert_called_once()

    def test_mocked_bitmap_failure_stays_failed_with_one_normal_close(self):
        report, failure, helper, x11, _launch = self.observe_fixture(bitmap_error=RuntimeError("no owned pixels"))
        self.assertIsNotNone(failure)
        self.assertIn("no owned pixels", report["refusal"])
        self.assertFalse(report["observationCaptured"])
        self.assertTrue(report["normalCloseObserved"])
        x11.close_window.assert_called_once()
        helper.perform.assert_called_once()

    def test_mocked_changed_identity_blocks_normal_close_no_retry(self):
        report, failure, _helper, x11, _launch = self.observe_fixture(changed_before_close=True)
        self.assertIsNotNone(failure)
        self.assertIn("guard changed", report["teardownRefusal"])
        self.assertFalse(report["normalCloseAttempted"])
        self.assertFalse(report["normalCloseObserved"])
        x11.close_window.assert_not_called()

    def test_disabled_or_absent_userns_blocks_all_gui_launch(self):
        for value in (None, "0", "2"):
            with self.subTest(value=value):
                sandbox = {"kernelSettings": {C.USERNS_SYSCTL: value}, "chromeSandbox": None}
                with self.assertRaisesRegex(RuntimeError, "unprivileged_userns_clone=1"):
                    C.require_normal_sandbox(sandbox)
        report, failure, _helper, _x11, launch = self.observe_fixture(sandboxes=[
            {"kernelSettings": {C.USERNS_SYSCTL: "0"}, "chromeSandbox": None}])
        self.assertIsNotNone(failure)
        self.assertFalse(report["candidateExecuted"])
        launch.assert_not_called()

    def test_userns_rechecked_immediately_before_wrapper_and_refusal_never_launches_hub(self):
        report, failure, _helper, _x11, launch = self.observe_fixture(sandboxes=[
            {"kernelSettings": {C.USERNS_SYSCTL: "1"}, "chromeSandbox": None},
            {"kernelSettings": {C.USERNS_SYSCTL: None}, "chromeSandbox": None}])
        self.assertIsNotNone(failure)
        self.assertFalse(report["candidateExecuted"])
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(launch.call_args.args[0], ["/usr/bin/openbox", "--sm-disable"])

    def test_missing_native_prerequisite_retains_observation_without_launch(self):
        (self.root / "evidence").mkdir()
        C.save(self.root / "evidence/session-attempt.json", {})
        env = {**self.env(), **C.environment(self.root), "DISPLAY": ":99", "DBUS_SESSION_BUS_ADDRESS": "unix:mock"}
        with mock.patch.object(C, "review_stage", return_value=(self.root, {"sources": {}})), \
                mock.patch.object(C, "helpers", side_effect=ImportError("missing prerequisite")), \
                mock.patch.object(C, "source_gate", return_value={}), \
                mock.patch.object(C.subprocess, "Popen") as launch, self.assertRaises(ImportError):
            C.observe(env)
        launch.assert_not_called()
        report = json.loads((self.root / "evidence/observation.json").read_text())
        self.assertFalse(report["candidateExecuted"])
        self.assertIn("missing prerequisite", report["refusal"])

    def test_sandbox_metadata_is_read_only_not_operational_proof(self):
        with mock.patch("builtins.open", mock.mock_open(read_data="1024\n")):
            value = C.sandbox_observation(self.root)
        self.assertIsNone(value["chromeSandbox"])
        self.assertTrue(value["readOnly"])
        for field in ("userNamespaceOperationProven", "settingsChanged", "sandboxDisabled"):
            self.assertFalse(value[field])

    def test_ax_redacts_unknown_text_and_never_claims_add_or_login_success(self):
        def node(name):
            return dict(name=name, role="push button", showing=True, enabled=True, sensitive=True, defunct=False, busy=False)
        nodes = C.sanitize_ax({"actionCount": 0, "nodes": [node("Sign in"), node("person@example.invalid")]})
        self.assertEqual(nodes[0]["label"], "Sign in")
        self.assertIsNone(nodes[1]["label"])
        self.assertNotIn("person@", json.dumps(nodes))
        self.assertEqual(C.classify_ax(nodes), "sign-in-surface-observed-no-interaction")
        self.assertEqual(C.classify_ax(C.sanitize_ax({"actionCount": 0, "nodes": [node("Projects"), node("Add")]})),
                         "projects-and-add-visible-not-tested")

    def test_ax_input_or_excess_nodes_refused(self):
        for value in ({"actionCount": 1, "nodes": []}, {"actionCount": 0, "nodes": [{}] * 513}):
            with self.assertRaises(RuntimeError):
                C.sanitize_ax(value)

    def test_wait_deadline_never_signals_or_retries(self):
        child, output = mock.Mock(), mock.Mock()
        child.poll.return_value = None
        with mock.patch.object(C.time, "monotonic", side_effect=[0, 0, 2]), self.assertRaisesRegex(RuntimeError, "no retry"):
            C.wait_exit(child, output, 1)
        child.kill.assert_not_called()
        child.terminate.assert_not_called()

    def test_wait_requires_exit_and_complete_owned_streams(self):
        child, output = mock.Mock(), mock.Mock()
        child.poll.return_value = 0
        child.wait.return_value = 0
        output.complete.side_effect = [False, True]
        with mock.patch.object(C.time, "monotonic", side_effect=[0, 0, 0]):
            self.assertEqual(C.wait_exit(child, output, 1), 0)
        self.assertEqual(output.pump.call_count, 2)

    def test_owned_output_overflow_is_explicit_and_bounded(self):
        child, selector = mock.Mock(), mock.Mock()
        child.stdout.fileno.return_value = 100
        child.stderr.fileno.return_value = 101
        with mock.patch.object(C.selectors, "DefaultSelector", return_value=selector), mock.patch.object(C.os, "set_blocking", create=True):
            output = C.Drain(child, self.root, "owned", stdout_limit=3)
        row = output.rows["stdout"]
        selector.select.return_value = [(types.SimpleNamespace(data=row, fd=100, fileobj=child.stdout), None)]
        try:
            with mock.patch.object(C.os, "read", side_effect=[b"abc", b"d", b""]):
                for _ in range(3):
                    output.pump(0)
            with self.assertRaisesRegex(RuntimeError, "partial evidence retained"):
                output.check()
            evidence = output.metadata()["stdout"]
            self.assertEqual(evidence["bytesSeen"], 4)
            self.assertEqual(evidence["retainedBytes"], 3)
            self.assertTrue(evidence["overflow"])
            self.assertTrue(evidence["eof"])
            self.assertEqual(evidence["file"], C.pin(b"abc"))
        finally:
            output.close()

    def test_extracted_sandbox_is_reported_not_promoted_to_root(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o4755, st_uid=1001, st_gid=1001)
        with mock.patch("builtins.open", mock.mock_open(read_data="1024\n")), \
                mock.patch.object(C.os.path, "lexists", return_value=True), mock.patch.object(Path, "lstat", return_value=info):
            value = C.sandbox_observation(self.root)
        self.assertEqual(value["chromeSandbox"], {"uid": 1001, "gid": 1001, "mode": 0o4755, "rootOwned4755": False})
        self.assertFalse(value["userNamespaceOperationProven"])
        self.assertFalse(value["settingsChanged"])

    def test_python310_syntax_and_exact_helper_api(self):
        source = (HERE / "native-linux-unity-hub-registry-capture.py").read_text(encoding="utf8")
        ast.parse(source, feature_version=(3, 10))
        ast.parse(Path(__file__).read_text(encoding="utf8"), feature_version=(3, 10))
        self.assertIn('helper.Request.parse(["snapshot"', source)
        self.assertIn('native.bitmap(request, root / "evidence", helper, x11)', source)
        self.assertLess(source.index('write_new(root / "evidence/normal-close-intent.json"'), source.index('x11.close_window(request.window, bound)'))
        self.assertNotIn(".kill(", source)
        self.assertNotIn(".terminate(", source)
        self.assertNotIn("--no-sandbox", source)
        self.assertNotIn("--disable-setuid-sandbox", source)
        self.assertNotIn("os.chmod", source)
        self.assertNotIn("os.chown", source)

    def test_workflow_registration_skips_and_manual_gate_precedes_native(self):
        workflow = (HERE.parent / ".github/workflows/linux-unity-hub-registry-capture.yml").read_text(encoding="utf8")
        self.assertIn("branches: [validation/linux-unity-hub-registry-capture]", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("github.ref == '" + C.BRANCH + "'", workflow)
        self.assertIn("github.workflow_ref == '" + C.WORKFLOW + "'", workflow)
        self.assertIn("default: inspect-only", workflow)
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertLess(workflow.index("native-linux-unity-hub-registry-capture.test.py"), workflow.index("native-linux-unity-hub-registry-capture.py stage"))
        self.assertLess(workflow.index("native-linux-unity-hub-registry-capture.test.py"), workflow.index("sudo apt-get update"))
        self.assertLess(workflow.index("native-linux-unity-hub-registry-capture.py admit"), workflow.index("sudo apt-get update"))
        self.assertLess(workflow.index("native-linux-unity-hub-registry-capture.py admit"), workflow.index("native-linux-unity-hub-registry-capture.py stage"))
        self.assertLess(workflow.index("sudo apt-get update"), workflow.index("native-linux-unity-hub-registry-capture.py prerequisites"))
        self.assertLess(workflow.index("native-linux-unity-hub-registry-capture.py prerequisites"), workflow.index("native-linux-unity-hub-registry-capture.py stage"))
        self.assertLess(workflow.index("native-linux-unity-hub-registry-capture.py stage"), workflow.index("native-linux-unity-hub-registry-capture.py session"))
        commands = workflow.replace("\\\n", " ").splitlines()
        sudo_commands = [shlex.split(line.strip()) for line in commands if "sudo" in line]
        self.assertEqual(sudo_commands, [["sudo", "apt-get", "update"],
            ["sudo", "apt-get", "install", "-y", "--no-install-recommends", "xvfb", "openbox", "xauth", "dbus-x11",
             "python3-gi", "gir1.2-gtk-3.0", "gir1.2-atspi-2.0", "at-spi2-core", "libx11-6", "libxres1"]])
        tool_check = re.search(r"for tool in ([^\n]+); do", "\n".join(commands))
        self.assertIsNotNone(tool_check)
        self.assertEqual(shlex.split(tool_check.group(1)), ["/usr/bin/python3", "/usr/bin/gpg", "/usr/bin/gpgv",
            "/usr/bin/dpkg-deb", "/usr/bin/xauth", "/usr/bin/dbus-run-session", "/usr/bin/xvfb-run", "/usr/bin/Xvfb", "/usr/bin/openbox",
            "/usr/bin/env", "/usr/bin/bash", "/usr/bin/cat", "/usr/bin/dirname", "/usr/bin/readlink"])
        self.assertIn('test -x "$tool"', workflow)
        for forbidden in ("no-sandbox", "cargo ", "npm ", "contents: write", "sysctl", "chmod", "chown", "unshare", "dpkg --install"):
            self.assertNotIn(forbidden, workflow)
        self.assertNotIn("/inputs/", workflow)
        self.assertNotIn("/home/", workflow)
        for stream in ("hub.stdout", "hub.stderr", "session.stdout", "session.stderr"):
            self.assertIn("/evidence/" + stream, workflow)

    def test_each_workflow_phase_removes_only_runner_chrome_locator_before_python(self):
        workflow = (HERE.parent / ".github/workflows/linux-unity-hub-registry-capture.yml").read_text(encoding="utf8")
        script = "scripts/native-linux-unity-hub-registry-capture.py"
        commands = []
        for line in workflow.splitlines():
            if script + " " not in line:
                continue
            command = line.strip().removeprefix("run: ")
            commands.append(shlex.split(command))
        prefix = ["/usr/bin/env", "-u", "CHROME_BIN", "/usr/bin/python3", "-I", "-B", script]
        self.assertEqual(commands, [[*prefix, phase] for phase in ("admit", "prerequisites", "stage", "session")])
        self.assertEqual(workflow.count("/usr/bin/env -u CHROME_BIN"), 4)
        self.assertEqual(workflow.count("/usr/bin/env"), 5)  # Four invocations plus one fixed-tool availability check.
        self.assertIn("run: /usr/bin/python3 -I -B scripts/native-linux-unity-hub-registry-capture.test.py", workflow)
        for forbidden in ("GITHUB_ENV", "env -i", "env --ignore-environment", "unset ", "export ", "printenv", "/etc/environment"):
            self.assertNotIn(forbidden, workflow)


if __name__ == "__main__":
    unittest.main()
