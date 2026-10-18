"""Portable harness regressions. These do not perform native installation."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("installed_candidate", HERE / "native-linux-installed-candidate.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def binding():
    return dict(
        run=dict(id=p.RUN, run_attempt=p.ATTEMPT, head_sha=p.SOURCE, repository=dict(id=p.REPOSITORY_ID),
                 status="completed", conclusion="success", event="workflow_dispatch",
                 head_branch="validation/linux-retirement-candidate-014", path=".github/workflows/unix-managed-assembly.yml"),
        artifact=dict(id=p.ARTIFACT, name=p.ARTIFACT_NAME, expired=False, size_in_bytes=p.ZIP_PIN[0],
                      digest="sha256:" + p.ZIP_PIN[1], workflow_run=dict(id=p.RUN, head_sha=p.SOURCE,
                      repository_id=p.REPOSITORY_ID, head_repository_id=p.REPOSITORY_ID)),
        job=dict(id=p.JOB, run_id=p.RUN, run_attempt=p.ATTEMPT, conclusion="success", name="assembly (linux, ubuntu-22.04)"),
        commit=dict(sha=p.SOURCE, tree=dict(sha=p.TREE)),
        baseline=dict(id=p.BASELINE_ASSET, name=p.BASELINE_NAME, size=p.BASELINE_PIN[0], state="uploaded",
                      browser_download_url=p.BASELINE_URL),
        baselineRelease=dict(tag_name="v0.1.12", draft=False, prerelease=False))


def admitted_env():
    return dict(GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted", RUNNER_OS="Linux", RUNNER_ARCH="X64",
                GITHUB_REPOSITORY=p.REPOSITORY, GITHUB_REPOSITORY_ID=str(p.REPOSITORY_ID),
                GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/validation/linux-installed-candidate-014",
                CREATOR_LINUX_INSTALLED_CANDIDATE="1", CREATOR_LINUX_INSTALLED_IMAGE=p.IMAGE,
                CREATOR_LINUX_INSTALL_LANE="fresh", RUNNER_TEMP=str(p.TEMP), GITHUB_WORKSPACE=str(p.WORKSPACE),
                HOME=str(p.HOME), XDG_CONFIG_HOME=str(p.HOME / ".config"), XDG_DATA_HOME=str(p.HOME / ".local/share"),
                GITHUB_SHA="a" * 40)


def tar_bytes(rows):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as writer:
        for name, body, mode, kind, uid, gid in rows:
            member = tarfile.TarInfo(name)
            member.mode, member.type, member.uid, member.gid = mode, kind, uid, gid
            member.size = len(body) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = "/tmp/redirect"
            writer.addfile(member, io.BytesIO(body) if member.isfile() else None)
    data.seek(0)
    return data


def control_rows():
    return [("control", b"Package: creator-hub\nVersion: 0.1.12\nArchitecture: amd64\nDepends: libwebkit2gtk-4.1-0, libgtk-3-0\nDescription: Creator Hub app manager\n (none)\n", 0o644, tarfile.REGTYPE, 0, 0),
            ("md5sums", b"synthetic\n", 0o644, tarfile.REGTYPE, 0, 0)]


class SourceBinding(unittest.TestCase):
    def test_exact_candidate_and_baseline_binding(self):
        p.validate_source(binding())
        self.assertEqual(p.pins()["zipSha256"], "904b51a0192027ba667702feb4a00721ad2d392fe473540b1f87121c6cacb3de")
        self.assertEqual(p.PROTECTED[p.HUB][1], "3357f024e3caff3e7563e702838b7e15e08bb8effd7915413e25c444d485ea7d")
        self.assertNotEqual(p.PROTECTED[p.HUB][1], "178cd9b2623c14cac7c6d7cc475c816ddc1f9f3f5bcf5bb9fb3467cc7a795414")

    def test_each_producer_identity_and_status_is_required(self):
        changes = [("run", "id", 1), ("run", "run_attempt", 2), ("run", "head_sha", "b" * 40),
                   ("run", "event", "push"), ("run", "head_branch", "main"), ("run", "path", "other.yml"),
                   ("run", "status", "in_progress"), ("run", "conclusion", "failure"),
                   ("artifact", "id", 1), ("artifact", "name", "replacement"), ("artifact", "expired", True),
                   ("artifact", "size_in_bytes", p.ZIP_PIN[0] + 1), ("artifact", "digest", "sha256:" + "0" * 64),
                   ("job", "id", 1), ("job", "run_id", 1), ("job", "run_attempt", 2),
                   ("job", "name", "non-native"), ("job", "conclusion", "failure"),
                   ("commit", "sha", "b" * 40), ("baseline", "id", 1), ("baseline", "name", "other.deb"),
                   ("baseline", "size", 1), ("baseline", "state", "new"), ("baseline", "browser_download_url", "https://invalid/"),
                   ("baselineRelease", "draft", True), ("baselineRelease", "prerelease", True)]
        for section, key, value in changes:
            bad = binding()
            bad[section][key] = value
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                p.validate_source(bad)
        for section, key in (("run", "id"), ("artifact", "size_in_bytes"), ("job", "run_attempt"), ("baseline", "id")):
            bad = binding()
            bad[section][key] = float(bad[section][key])
            with self.subTest(noncanonical=key), self.assertRaises(ValueError):
                p.validate_source(bad)

    def test_artifact_repository_tree_and_run_cannot_drift(self):
        for key in ("id", "head_sha", "repository_id", "head_repository_id"):
            bad = binding()
            bad["artifact"]["workflow_run"][key] = 1
            with self.subTest(key=key), self.assertRaises(ValueError):
                p.validate_source(bad)
        bad = binding()
        bad["commit"]["tree"]["sha"] = "c" * 40
        with self.assertRaises(ValueError):
            p.validate_source(bad)
        bad = binding()
        bad["run"]["repository"]["id"] = 1
        with self.assertRaises(ValueError):
            p.validate_source(bad)

    def test_json_duplicate_keys_refused(self):
        with self.assertRaises(ValueError):
            p.unique_json('{"run":{},"run":{}}')


class Admission(unittest.TestCase):
    def test_only_explicit_two_disposable_lanes(self):
        for event in ("workflow_dispatch", "push"):
            for lane in ("fresh", "public12"):
                env = admitted_env()
                env["GITHUB_EVENT_NAME"] = event
                env["CREATOR_LINUX_INSTALL_LANE"] = lane
                p.admission(env, "linux", "x86_64")

    def test_push_bootstrap_keeps_finite_event_branch_repository_and_optin_admission(self):
        for event in ("pull_request", "pull_request_target", "schedule", "workflow_run", "repository_dispatch", "", "push "):
            env = admitted_env()
            env["GITHUB_EVENT_NAME"] = event
            with self.subTest(event=event), self.assertRaises(ValueError):
                p.admission(env, "linux", "x86_64")
        for key in ("GITHUB_REF", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "CREATOR_LINUX_INSTALLED_CANDIDATE"):
            env = admitted_env()
            env["GITHUB_EVENT_NAME"] = "push"
            env[key] = "unexpected"
            with self.subTest(key=key), self.assertRaises(ValueError):
                p.admission(env, "linux", "x86_64")

    def test_each_required_environment_key_is_checked(self):
        for key in admitted_env():
            env = admitted_env()
            env[key] = "unexpected"
            with self.subTest(key=key), self.assertRaises(ValueError):
                p.admission(env, "linux", "x86_64")

    def test_other_platforms_sandboxes_gui_sessions_refused(self):
        for system, machine in (("win32", "AMD64"), ("darwin", "arm64"), ("linux", "aarch64")):
            with self.assertRaises(ValueError):
                p.admission(admitted_env(), system, machine)
        for key in ("APPIMAGE", "APPDIR", "FLATPAK_ID", "DISPLAY", "WAYLAND_DISPLAY"):
            env = admitted_env()
            env[key] = "present"
            with self.subTest(key=key), self.assertRaises(ValueError):
                p.admission(env, "linux", "x86_64")


class ArchiveInspection(unittest.TestCase):
    def test_public12_control_has_no_executable_control_members(self):
        result = p.control_inventory(tar_bytes(control_rows()), "0.1.12", p.verifier())
        self.assertEqual(result["fields"]["Package"], "creator-hub")
        self.assertEqual(set(result), {"control", "md5sums", "fields"})

    def test_maintainer_scripts_triggers_conffiles_links_and_duplicates_refuse(self):
        for name in ("preinst", "postinst", "prerm", "postrm", "conffiles", "triggers", "control"):
            rows = control_rows() + [(name, b"never executed", 0o644, tarfile.REGTYPE, 0, 0)]
            with self.subTest(name=name), self.assertRaises(ValueError):
                p.control_inventory(tar_bytes(rows), "0.1.12", p.verifier())
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            rows = control_rows()
            rows[0] = ("control", b"", 0o644, kind, 0, 0)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                p.control_inventory(tar_bytes(rows), "0.1.12", p.verifier())

    def test_wrong_control_identity_relationships_or_permissions_refuse(self):
        original = control_rows()[0][1]
        for body in (original.replace(b"0.1.12", b"0.1.14"), original.replace(b"amd64", b"arm64"),
                     original.replace(b"creator-hub", b"other"), original + b"Version: 0.1.12\n",
                     original + b"Replaces: creator-project-setup\n", original + b"Pre-Depends: other\n"):
            rows = control_rows()
            rows[0] = ("control", body, 0o644, tarfile.REGTYPE, 0, 0)
            with self.assertRaises(ValueError):
                p.control_inventory(tar_bytes(rows), "0.1.12", p.verifier())
        for mode, uid, gid in ((0o755, 0, 0), (0o644, 1001, 0), (0o644, 0, 1001)):
            rows = control_rows()
            rows[0] = ("control", original, mode, tarfile.REGTYPE, uid, gid)
            with self.assertRaises(ValueError):
                p.control_inventory(tar_bytes(rows), "0.1.12", p.verifier())

    def test_data_inventory_binds_every_file_size_hash_mode_and_owner(self):
        rows = [("usr", b"", 0o755, tarfile.DIRTYPE, 0, 0),
                (p.HUB[1:], b"synthetic-not-executed", 0o755, tarfile.REGTYPE, 0, 0)]
        result = p.data_inventory(tar_bytes(rows), p.verifier())
        self.assertEqual(result["files"][p.HUB], dict(size=22, sha256=hashlib.sha256(rows[1][1]).hexdigest(),
                                                    mode=0o755, uid=0, gid=0))
        self.assertEqual(result["directories"], {"/usr": dict(mode=0o755, uid=0, gid=0)})

    def test_data_traversal_etc_links_and_write_special_modes_refuse(self):
        for name, mode, kind, uid in (("etc/config", 0o644, tarfile.REGTYPE, 0),
                                     ("usr/../tmp/file", 0o644, tarfile.REGTYPE, 0),
                                     ("usr/bin/creator-hub", 0o4755, tarfile.REGTYPE, 0),
                                     ("usr/bin/creator-hub", 0o777, tarfile.REGTYPE, 0),
                                     ("usr/bin/creator-hub", 0o755, tarfile.REGTYPE, 1001),
                                     ("usr/bin/creator-hub", 0o755, tarfile.SYMTYPE, 0)):
            with self.subTest(name=name, mode=mode, kind=kind), self.assertRaises(ValueError):
                p.data_inventory(tar_bytes([(name, b"unexpected", mode, kind, uid, 0)]), p.verifier())

    def zip_check(self, extras=(), wrong_deb=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, target = root / "original.zip", root / "candidate.deb"
            body = b"synthetic-deb-not-installed"
            with zipfile.ZipFile(source, "w") as writer:
                writer.writestr(p.DEB_MEMBER, b"changed" if wrong_deb else body)
                for name, kind in extras:
                    info = zipfile.ZipInfo("placeholder")
                    # Preserve actual raw wire backslashes even on CPython Windows.
                    info.filename = info.orig_filename = name
                    info.create_system = 3
                    info.external_attr = (kind | 0o644) << 16
                    with warnings.catch_warnings():
                        warnings.filterwarnings("ignore", message="Duplicate name:", category=UserWarning)
                        writer.writestr(info, b"unexpected")
            raw = source.read_bytes()
            with patch.object(p, "ZIP_PIN", (len(raw), hashlib.sha256(raw).hexdigest())), \
                    patch.object(p, "DEB_PIN", (len(body), hashlib.sha256(body).hexdigest())):
                p.stage_zip(source, target)
                self.assertEqual(target.read_bytes(), body)

    def test_only_exact_deb_is_staged_from_verified_original_zip(self):
        self.zip_check([("modules/not-executed", stat.S_IFREG)])

    def test_zip_backslashes_traversal_links_duplicates_and_wrong_deb_refuse(self):
        for name, kind in (("modules\\bad", stat.S_IFREG), ("../escape", stat.S_IFREG),
                           ("/absolute", stat.S_IFREG), ("usr//bad", stat.S_IFREG),
                           ("modules/link", stat.S_IFLNK), ("modules/pipe", stat.S_IFIFO),
                           (p.DEB_MEMBER, stat.S_IFREG)):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.zip_check([(name, kind)])
        with self.assertRaises(ValueError):
            self.zip_check(wrong_deb=True)

    def test_candidate_audit_reuses_strict_existing_verifier_before_other_inspection(self):
        strict = p.verifier()
        with patch.object(p, "pinned", return_value={}), patch.object(p, "verifier", return_value=strict), \
                patch.object(strict, "verify", side_effect=ValueError("strict refusal")) as audit, \
                patch.object(p.subprocess, "run") as command:
            with self.assertRaisesRegex(ValueError, "strict refusal"):
                p.audit_deb(Path("/not-executed/candidate.deb"), "0.1.14")
            audit.assert_called_once_with(str(Path("/not-executed/candidate.deb")), p.PROTECTED[p.HELPER][1],
                                          p.PROTECTED[p.POLICY][1], "0.1.14")
            command.assert_not_called()


class Preservation(unittest.TestCase):
    def test_fixture_bytes_cover_settings_three_clients_unknown_entries_backups_and_unity(self):
        fixtures = p.fixture_bytes()
        self.assertEqual(len(fixtures), 14)
        desktop = json.loads(fixtures[".config/Claude/claude_desktop_config.json"])
        self.assertIn("unrelated-kept", desktop["mcpServers"])
        self.assertEqual(desktop["mcpServers"]["creator-works"]["env"]["UNITY_PROJECT_PATH"],
                         str(p.HOME / "Projects/Unity Fixture"))
        backup = next(name for name in fixtures if name.endswith(".bak"))
        self.assertEqual(fixtures[backup], fixtures[".config/creator-works-mcp/launcher-config.json"])
        self.assertIn(hashlib.sha256(fixtures[backup]).hexdigest(), backup)
        self.assertIn("Projects/Unity Fixture/Assets/DoNotChange.cs", fixtures)

    def test_unchanged_whole_home_including_directory_and_file_identity_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            before = p.seed_fixtures(home)
            self.assertEqual(p.require_preserved(home, before), before)
            self.assertIn(".codex/config.toml", before)
            with self.assertRaises(FileExistsError):
                p.seed_fixtures(home)

    def test_changed_bytes_added_file_removed_file_or_replacement_refuse(self):
        for change in ("bytes", "added", "removed", "replaced"):
            with tempfile.TemporaryDirectory() as directory:
                home = Path(directory).resolve()
                before = p.seed_fixtures(home)
                target = home / ".codex/config.toml"
                if change == "bytes":
                    target.write_bytes(b"changed")
                elif change == "added":
                    (home / ".codex/new-file").write_bytes(b"added")
                elif change == "removed":
                    target.unlink()
                else:
                    original = target.read_bytes()
                    temporary = target.with_suffix(".replacement")
                    temporary.write_bytes(original)
                    temporary.replace(target)
                with self.subTest(change=change), self.assertRaises(ValueError):
                    p.require_preserved(home, before)

    @unittest.skipIf(os.name == "nt", "Native POSIX permission/link semantics")
    def test_changed_permission_hardlink_and_directory_symlink_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            before = p.seed_fixtures(home)
            target = home / ".codex/config.toml"
            target.chmod(0o644)
            with self.assertRaises(ValueError):
                p.require_preserved(home, before)
            target.chmod(0o600)
            os.link(target, home / "hardlink")
            with self.assertRaises(ValueError):
                p.snapshot(home)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            (home / "linked").symlink_to(home, target_is_directory=True)
            with self.assertRaises(ValueError):
                p.snapshot(home)


class InstalledVerification(unittest.TestCase):
    def test_installed_file_hash_mode_uid_gid_size_must_all_match(self):
        wanted = dict(size=12, sha256="a" * 64, mode=0o755, uid=0, gid=0)
        inventory = dict(files={p.HUB: wanted}, directories={})
        parent = SimpleNamespace(lstat=lambda: SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0))
        with patch.object(p, "ordinary", return_value=parent), patch.object(p, "record", return_value=wanted):
            self.assertEqual(p.installed_records(inventory)[p.HUB], wanted)
        for key in wanted:
            wrong = {**wanted, key: "b" * 64 if key == "sha256" else wanted[key] + 1}
            with self.subTest(key=key), patch.object(p, "record", return_value=wrong), self.assertRaises(ValueError):
                p.installed_records(inventory)

    def test_unprotected_installed_ancestor_refuses_even_matching_file(self):
        wanted = dict(size=12, sha256="a" * 64, mode=0o755, uid=0, gid=0)
        for mode, uid in ((0o777, 0), (0o755, 1001), (stat.S_IFLNK | 0o755, 0)):
            parent = SimpleNamespace(lstat=lambda: SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid, st_gid=0))
            with self.subTest(mode=mode, uid=uid), patch.object(p, "ordinary", return_value=parent), \
                    patch.object(p, "record", return_value=wanted), self.assertRaises(ValueError):
                p.installed_records(dict(files={p.HUB: wanted}, directories={}))

    def test_install_checks_again_and_stops_without_repair_or_retry(self):
        audited = {"fixture": True}
        with patch.object(p, "audit_deb", return_value=audited), patch.object(p, "capture", return_value=(1, b"", b"failed")) as command:
            with self.assertRaisesRegex(ValueError, "no repair"):
                p.install(Path("/fixed/candidate.deb"), audited, "0.1.14", "candidate14-install")
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[1], ["/usr/bin/sudo", "--non-interactive", "--", "/usr/bin/dpkg", "--install", str(Path("/fixed/candidate.deb"))])
        with patch.object(p, "audit_deb", return_value={"changed": True}), patch.object(p, "capture") as command:
            with self.assertRaises(ValueError):
                p.install(Path("/fixed/candidate.deb"), audited, "0.1.14", "candidate14-install")
            command.assert_not_called()

    def test_dpkg_status_must_be_fully_configured_exact_version_architecture(self):
        for code, out, err in ((0, b"install ok installed\n0.1.12\namd64\n", b""),
                               (0, b"install ok unpacked\n0.1.14\namd64\n", b""),
                               (0, b"install ok installed\n0.1.14\narm64\n", b""), (1, b"", b"")):
            with patch.object(p, "capture", return_value=(code, out, err)), self.assertRaises(ValueError):
                p.package_status("0.1.14", "fixture")
        with patch.object(p, "capture", return_value=(0, b"install ok installed\n0.1.14\namd64\n", b"")):
            p.package_status("0.1.14", "fixture")

    def test_nonempty_dpkg_verify_output_cannot_pass(self):
        audited = {"fixture": True}
        with patch.object(p, "audit_deb", return_value=audited), \
                patch.object(p, "package_status"), patch.object(p, "installed_records") as installed, \
                patch.object(p, "capture", side_effect=[(0, b"", b""), (0, b"??5?????? /usr/bin/creator-hub\n", b"")]):
            with self.assertRaisesRegex(ValueError, "dpkg verification"):
                p.install(Path("/fixed/candidate.deb"), audited, "0.1.14", "candidate14-install")
            installed.assert_not_called()

    def test_diagnostics_capture_actual_not_expected_protected_bytes_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(p, "ROOT", Path(directory).resolve()), patch.object(p, "record", return_value={"sha256": "actual-mismatch"}), \
                    patch.object(p, "capture", return_value=(1, b"", b"")) as command:
                p.diagnostics()
                report = json.loads((Path(directory) / "final-protected.json").read_text())
                self.assertTrue(all(row["sha256"] == "actual-mismatch" for row in report["protected"].values()))
                self.assertTrue(all(report[key] is False for key in p.FALSE_GATES))
                self.assertEqual(command.call_count, 2)

    def test_timeout_retains_logs_and_receipt_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            def timeout(args, **kwargs):
                kwargs["stdout"].write(b"partial output\n")
                kwargs["stderr"].write(b"partial error\n")
                raise subprocess.TimeoutExpired(args, 1)
            with patch.object(p, "ROOT", Path(directory).resolve()), patch.object(p.subprocess, "run", side_effect=timeout) as command:
                with self.assertRaises(subprocess.TimeoutExpired):
                    p.capture("fixture-timeout", ["not-executed"], 1)
                receipt = json.loads((Path(directory) / "fixture-timeout.json").read_text())
                self.assertTrue(receipt["timedOut"])
                self.assertEqual((Path(directory) / "fixture-timeout.stdout").read_bytes(), b"partial output\n")
                self.assertEqual(command.call_count, 1)


class FlowOrchestration(unittest.TestCase):
    def exercise(self, lane, corrupt=False):
        # Only mocked commands; never impersonates native install evidence.
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory).resolve()
            home = temp / "home"
            home.mkdir()
            (temp / "linux-installed-candidate-source.json").write_text(json.dumps(binding()))
            audited = dict(data=dict(files={}, directories={}))
            protected = {str(temp / "not-installed" / Path(name).name): pin for name, pin in p.PROTECTED.items()}
            installed = {name: dict(size=pin[0], sha256=pin[1], mode=pin[2], uid=0, gid=0)
                         for name, pin in protected.items()}

            def installation(*args):
                if corrupt:
                    (home / ".codex/config.toml").write_bytes(b"unexpected mutation")
                return installed

            def command(label, *args):
                return (0, b"mock toolchain, not native evidence\n", b"") if label.endswith("-toolchain") else (1, b"", b"")

            with patch.object(p, "TEMP", temp), patch.object(p, "ROOT", temp / "capture"), \
                    patch.object(p, "HOME", home), patch.object(p, "PROTECTED", protected), patch.object(p, "native_admission"), \
                    patch.object(p, "stage_zip"), patch.object(p, "audit_deb", return_value=audited), \
                    patch.object(p, "capture", side_effect=command), \
                    patch.object(p, "install", side_effect=installation) as install_, \
                    patch.object(p, "diagnostics") as diagnostic, \
                    patch.dict(os.environ, {"CREATOR_LINUX_INSTALL_LANE": lane, "GITHUB_SHA": "a" * 40}):
                if corrupt:
                    with self.assertRaisesRegex(ValueError, "Fixture bytes"):
                        p.run()
                else:
                    p.run()
                report = json.loads((temp / "capture/report.json").read_text())
                diagnostic.assert_called_once()
                versions = [call.args[2] for call in install_.call_args_list]
                self.assertEqual(versions, ["0.1.12", "0.1.14"] if lane == "public12" and not corrupt else
                                 ["0.1.12"] if lane == "public12" else ["0.1.14"])
                self.assertEqual(report["freshInstallAccepted"], lane == "fresh" and not corrupt)
                self.assertEqual(report["manualPreviousPublicUpgradeAccepted"], lane == "public12" and not corrupt)
                self.assertEqual(report["settingsFixturesPreserved"], not corrupt)
                self.assertTrue(all(report[key] is False for key in p.FALSE_GATES))

    def test_fresh_lane_does_not_install_baseline(self):
        self.exercise("fresh")

    def test_previous_public_lane_requires_actual_baseline_install_before_candidate(self):
        self.exercise("public12")

    def test_preservation_refusal_captures_failure_and_never_sets_acceptance(self):
        for lane in ("fresh", "public12"):
            with self.subTest(lane=lane):
                self.exercise(lane, corrupt=True)


class WorkflowBoundaries(unittest.TestCase):
    def test_two_independent_matrix_jobs_finite_triggers_and_no_product_build(self):
        workflow = (HERE.parent / ".github/workflows/linux-installed-candidate-014.yml").read_text()
        self.assertIn("lane: [fresh, public12]", workflow)
        self.assertIn("fail-fast: false", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        for prohibited in ("windows-latest", "macos-", "npm ci", "cargo build", "tauri build", "pkexec", "--remove", "--purge", "apt-get -f"):
            self.assertNotIn(prohibited, workflow)
        self.assertIn("if: always()", workflow)
        self.assertIn("--show", Path(p.__file__).read_text())
        self.assertIn("baselineRelease", workflow)
        self.assertIn("downloadArtifact", workflow)

    def test_branch_only_three_path_push_bootstrap_avoids_unregistered_dispatch_404(self):
        # A new workflow not on default must not depend solely on workflow_dispatch.
        workflow = (HERE.parent / ".github/workflows/linux-installed-candidate-014.yml").read_text()
        push = workflow.split("  push:\n", 1)[1].split("\n\npermissions:", 1)[0]
        self.assertEqual(push, "    branches: [validation/linux-installed-candidate-014]\n"
                         "    paths:\n"
                         "      - scripts/native-linux-installed-candidate.py\n"
                         "      - scripts/native-linux-installed-candidate.test.py\n"
                         "      - .github/workflows/linux-installed-candidate-014.yml")
        self.assertIn("  workflow_dispatch:\n", workflow)
        guard = ("github.repository == 'BOBWORKS-XR/CREATOR-HUB' && github.repository_id == '1364807512' && "
                 "(github.event_name == 'workflow_dispatch' || github.event_name == 'push') && "
                 "github.ref == 'refs/heads/validation/linux-installed-candidate-014'")
        self.assertIn("    if: " + guard + "\n", workflow)
        bootstrap = workflow.split("      - uses: actions/checkout@", 1)[0]
        self.assertIn('case "$GITHUB_EVENT_NAME" in workflow_dispatch|push) ;; *) exit 1 ;; esac', bootstrap)
        self.assertIn('test "$GITHUB_REF" = refs/heads/validation/linux-installed-candidate-014', bootstrap)
        self.assertIn("assert.ok(['workflow_dispatch','push'].includes(context.eventName));", workflow)
        self.assertIn("assert.equal(context.ref,'refs/heads/validation/linux-installed-candidate-014');", workflow)

    def test_all_non_install_acceptance_claims_remain_false(self):
        self.assertTrue(p.FALSE_GATES)
        self.assertTrue(all(value is False for value in p.FALSE_GATES.values()))
        self.assertIn("signedUpdateAccepted", p.FALSE_GATES)
        self.assertIn("migrationAccepted", p.FALSE_GATES)
        self.assertIn("nativeGuiAccepted", p.FALSE_GATES)
        source = Path(p.__file__).read_text()
        self.assertNotIn("Popen(", source)
        self.assertNotIn("request_restart", source)


if __name__ == "__main__":
    unittest.main()
