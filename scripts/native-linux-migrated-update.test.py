"""Pure/temp continuation contracts. No native app, auth, trust or package changes."""
import ast
import base64
import copy
import gzip
import hashlib
import io
from contextlib import ExitStack, contextmanager
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location("continuation_test_" + name.replace("-", "_"), HERE / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = value
    spec.loader.exec_module(value)
    return value


C = module("native-linux-migrated-update")
T = module("native-linux-production-016-update.test")
U, M = C.U, C.M


def environment():
    return {**T.environment(), "GITHUB_REF": M.BRANCH, "GITHUB_WORKFLOW_REF": M.WORKFLOW,
            "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1", "CREATOR_MIGRATION_016_EXECUTE": "true",
            "CREATOR_MIGRATION_016_SCENARIO": "migration-approve", "CREATOR_MIGRATED_UPDATE_EXECUTE": "true",
            "UPDATE_PROFILE_SHA256": C.PROFILE_SHA, "GITHUB_WORKSPACE": "/unit/workspace", "RUNNER_TEMP": "/unit/temp",
            "CONTROLLER_NODE": "/unit/node"}


def completed():
    report = {**M.FLAGS, "scenario": "migration-approve", "harnessSource": "a" * 40,
              "scenarioPassed": True, "normalReopenObserved": True}
    broker = {**report, "scope": "production-016-disposable-migration", "fixtureRelocked": True,
              "sessionWrapper": {"returnCode": 0, "deadlineExpired": False,
                                 "pipes": {k: {"eof": True, "truncated": False} for k in ("stdout", "stderr")}}}
    batch = {"policy": 1, "phase": "cleanup", "outcome": "complete", "review_key": "b" * 64, "retry_blocked": False}
    return broker, report, batch


def append_reads(journal, nonce):
    return {"revision": 1, "records": journal["records"] + [
        {"session": nonce * 64, "id": index, "command": command, "outcome": "returned-ok"}
        for index, command in ((3, "load_config"), (4, "discover_unity_projects"))]}


def native_report():
    report = {**U.FALSE, "scope": "continuous-migrated-home-private017-lifecycle-only",
              "beforeMigrationConnectionContinued": False, "privateTargetQualification": U.private_target_qualification(),
              "nativeActions": ["Update Hub"], "systemActions": ["Authenticate"], "automaticSuccessor": {"pid": 30},
              "mcpProtocol": T.mcp_receipt(), "initialBitmap": {"nonblank": True}, "successorBitmap": {"nonblank": True}}
    for name in ("initial16Verified", "nativeConfirmationObserved", "settingsPreserved", "runtimeSurvived", "normalFinalClose",
                 "oldNormalExit", "automaticRestartObserved", "installed17Verified", "fresh17UiVersion", "directPagesObserved",
                 "targetRetirementHelperVerified", "migrationEvidencePreserved", "homePreserved", "journalPrefixPreserved"):
        report[name] = True
    report["oldRetirementHelperRestored"] = U.private_target_qualification()["privateDebApprovalRestoresOldRetirementHelper"]
    for name in ("initialProjects", "successorProjects"):
        report[name] = {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}
    for name, version in (("htmlWebDriver", "0.1.16"), ("successorHtmlWebDriver", "0.1.17")):
        report[name] = {"probePassed": True, "inputCountAtProbe": 0, "detached": True,
                        "toolsClosedAfterRootExit": True, "documentVersion": version}
    return report


def broker_report():
    return {**U.FALSE, "nativePassed": True, "preservationPassed": True, "fixtureRelocked": True,
            "tlsCleanup": {"temporaryCertificateRemoved": True, "originalTrustRestored": True},
            "transportClosed": True, "sessionExit": 0, "privateTargetQualification": U.private_target_qualification()}


@contextmanager
def temp_home():
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
        home = Path(temporary).resolve()
        uid = home.stat().st_uid
        real_directory = C.directory
        if os.name == "nt":
            # Windows has no POSIX ownership/mode semantics. All byte/link/open
            # checks remain real; separate native-mode cases are not claimed.
            def directory(path, owner):
                info = path.lstat()
                U.require(path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode), "Canonical directory required")
                return {"dev": info.st_dev, "ino": info.st_ino, "uid": owner, "gid": owner, "mode": 0o700}
            stack.enter_context(patch.object(C, "directory", side_effect=directory))
        else:
            home.chmod(0o700)
            real_directory(home, uid)
        for name in ("config/.creator-hub-settings-backups/settings.bak", "config/settings.json",
                     "data/creator-hub/client-migrations-v1/metadata.json", "data/creator-hub/client-migrations-v1/log",
                     "data/creator-hub/client-migrations-v1/review.json", "data/creator-hub/client-migrations-v1/result.json",
                     "data/CreatorHub/convergence/move-v1.json", M.JOURNAL, "current-project/Assets/keep.txt"):
            path = home / name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.write_bytes(name.encode())
        yield home, uid


class AdmissionTests(unittest.TestCase):
    def admit(self, env):
        with patch.object(M.sys, "platform", "linux"), patch.object(M.os, "getuid", return_value=1001, create=True):
            C.admission(env)

    def test_actual_migration_context_and_explicit_second_optin(self):
        env = environment(); before = dict(env); self.admit(env); self.assertEqual(env, before)
        with self.assertRaises(RuntimeError): U.admission(env, system="linux", machine="x86_64")
        with self.assertRaises(RuntimeError): self.admit({**env, "GITHUB_REF": U.BRANCH, "GITHUB_WORKFLOW_REF": U.WORKFLOW})

    def test_missing_wrong_context_or_approval_refused(self):
        for key in ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CREATOR_MIGRATED_UPDATE_EXECUTE",
                    "CREATOR_MIGRATION_016_EXECUTE", "CREATOR_MIGRATION_016_SCENARIO", "UPDATE_EXECUTE", "UPDATE_SCENARIO", "UPDATE_PROFILE_SHA256"):
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.admit({**environment(), key: ""})

    def test_injection_refused_even_empty(self):
        for key in ("HTTPS_PROXY", "LD_PRELOAD", "TAURI_TEST", "PYTHONPATH", "NODE_OPTIONS", "SSL_CERT_FILE", "CREATOR_HUB_SIGNING_KEY_PATH"):
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.admit({**environment(), key: ""})

    def test_children_keep_real_workflow_and_home_without_inheriting_extra_env(self):
        env = {**environment(), "UNREVIEWED": "private"}
        for child in (C.child_environment(env), C.transport_environment(env)):
            self.assertEqual(child["GITHUB_WORKFLOW_REF"], M.WORKFLOW)
            self.assertEqual(child["GITHUB_REF"], M.BRANCH)
            self.assertNotIn("UNREVIEWED", child)
        command = C.session_command(env)
        self.assertIn("--uid=" + M.USER, command)
        self.assertIn("--property=PAMName=login", command)
        self.assertEqual(command[-2:], [str(C.CONTROL / "scripts/native-linux-migrated-update.py"), "session"])
        self.assertNotIn("useradd", " ".join(command))
        self.assertEqual(C.transport_environment(env)["HOME"], str(C.HOME))

    def test_context_binds_boot_run_attempt_source_and_both_profiles(self):
        before = C.context(environment(), "unit-boot")
        for key in ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_REF"):
            self.assertNotEqual(before, C.context({**environment(), key: "changed"}, "unit-boot"))
        self.assertNotEqual(before, C.context(environment(), "other-boot"))
        self.assertEqual(before["product"], C.PRODUCT)
        self.assertEqual(before["migrationProfile"], C.MIGRATION_PROFILE_SHA)
        self.assertEqual(before["outgoingProfile"], C.PROFILE_SHA)

    def test_intent_rechecks_every_actual_source_and_refuses_drift(self):
        pins = {name: U.pin(U.read(HERE / name, 2 * 1024**2)) for name in C.sources()}
        value = {"schemaVersion": 1, "context": C.context(environment(), "boot"), "sources": pins}
        real_read = U.read
        def read(file, *args, **kwargs):
            return json.dumps(value).encode() if file == C.INTENT else real_read(file, *args, **kwargs)
        with patch.object(C, "admission"), patch.object(C, "boot_id", return_value="boot"), patch.object(U, "read", side_effect=read):
            self.assertEqual(C.intent(environment()), value)
            for name in ("native-linux-migrated-update.py", "native-linux-production-016-update.py", "native-linux-production-016-migration.py"):
                with self.subTest(source=name):
                    original = value["sources"][name]["sha256"]
                    value["sources"][name]["sha256"] = "0" * 64
                    with self.assertRaisesRegex(RuntimeError, "Independent bytes differ"): C.intent(environment())
                    value["sources"][name]["sha256"] = original


class MigrationGateTests(unittest.TestCase):
    def test_only_complete_cleanup_after_normal_reopen_and_relock(self):
        C.migration_gate(*completed())

    def test_incomplete_failed_unknown_or_retry_blocked_refused(self):
        for group, key, value in ((0, "scenarioPassed", False), (0, "fixtureRelocked", False), (1, "normalReopenObserved", False),
                                  (1, "harnessSource", "c" * 40), (2, "outcome", "started"), (2, "phase", "connections"),
                                  (2, "retry_blocked", True), (2, "retry_blocked", 0), (2, "review_key", ""), (2, "policy", True)):
            values = completed(); values[group][key] = value
            with self.subTest(group=group, key=key), self.assertRaises(RuntimeError): C.migration_gate(*values)
        for name in ("refusal", "recovery", "relockRefusal", "captureRefused", "disposableTeardownRequired"):
            for group in (0, 1):
                values = completed(); values[group][name] = False
                with self.assertRaises(RuntimeError): C.migration_gate(*values)

    def test_missing_extra_batch_fields_and_claim_promotions_refused(self):
        for name in completed()[2]:
            values = completed(); del values[2][name]
            with self.assertRaises(RuntimeError): C.migration_gate(*values)
        values = completed(); values[2]["extra"] = True
        with self.assertRaises(RuntimeError): C.migration_gate(*values)
        for name in M.FLAGS:
            values = completed(); values[1][name] = True
            with self.assertRaises(RuntimeError): C.migration_gate(*values)

    def test_normal_wrapper_and_complete_pipes_required(self):
        for key, value in (("returnCode", None), ("returnCode", False), ("returnCode", 1), ("deadlineExpired", True)):
            values = completed(); values[0]["sessionWrapper"][key] = value
            with self.assertRaises(RuntimeError): C.migration_gate(*values)
        for stream in ("stdout", "stderr"):
            for key, value in (("eof", False), ("truncated", True)):
                values = completed(); values[0]["sessionWrapper"]["pipes"][stream][key] = value
                with self.assertRaises(RuntimeError): C.migration_gate(*values)


class PreservationTests(unittest.TestCase):
    def test_full_temp_snapshot_includes_backups_history_and_projects(self):
        with temp_home() as (home, uid):
            before = C.tree(home, uid)
            for suffix in ("metadata.json", "log", "review.json", "result.json"):
                self.assertIn("data/creator-hub/client-migrations-v1/" + suffix, before)
            self.assertIn("config/.creator-hub-settings-backups/settings.bak", before)
            self.assertIn("current-project/Assets/keep.txt", before)
            C.compare_tree(before, C.tree(home, uid))

    def test_change_deletion_or_same_bytes_new_inode_refused(self):
        for operation in ("change", "delete", "replace"):
            with self.subTest(operation=operation), temp_home() as (home, uid):
                before = C.tree(home, uid); path = home / "config/settings.json"
                if operation == "change": path.write_bytes(b"changed")
                if operation == "delete": path.unlink()
                if operation == "replace":
                    other = home / "config/new"; other.write_bytes(path.read_bytes()); os.replace(other, path)
                with self.assertRaises(RuntimeError): C.compare_tree(before, C.tree(home, uid))

    def test_only_cache_additions_allowed_never_new_backups(self):
        for name, accepted in (("cache/item", True), ("data/creator-hub-update-cache/item", True),
                               ("config/new", False), ("cache/new.bak", False), ("cache/backup.json", False)):
            with self.subTest(name=name), temp_home() as (home, uid):
                before = C.tree(home, uid); path = home / name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.write_bytes(b"new")
                if accepted: C.compare_tree(before, C.tree(home, uid))
                else:
                    with self.assertRaises(RuntimeError): C.compare_tree(before, C.tree(home, uid))

    def test_hardlink_refused(self):
        with temp_home() as (home, uid):
            os.link(home / "config/settings.json", home / "alias")
            with self.assertRaises(RuntimeError): C.tree(home, uid)

    def test_symlink_refused_when_host_supports_it(self):
        with temp_home() as (home, uid):
            try: (home / "alias").symlink_to(home / "config/settings.json")
            except OSError as error: self.skipTest("Symlink creation unavailable: " + str(error.winerror if hasattr(error, "winerror") else error.errno))
            with self.assertRaises(RuntimeError): C.tree(home, uid)

    def test_entry_and_total_byte_bounds_refuse(self):
        with temp_home() as (home, uid):
            for name, value in (("MAX_ENTRIES", 2), ("MAX_TOTAL", 1)):
                with patch.object(C, name, value), self.assertRaises(RuntimeError): C.tree(home, uid)

    def test_journal_only_exception_does_not_allow_owner_or_device_change(self):
        with temp_home() as (home, uid):
            before = C.tree(home, uid); after = copy.deepcopy(before)
            after[M.JOURNAL].update(size=42, sha256="a" * 64, ino=123)
            C.compare_tree(before, after, journal=M.JOURNAL)
            for key in ("uid", "gid", "dev", "mode", "kind"):
                altered = copy.deepcopy(after); altered[M.JOURNAL][key] = "changed"
                with self.assertRaises(RuntimeError): C.compare_tree(before, altered, journal=M.JOURNAL)

    def test_exact_two_new_read_pairs_preserve_prefix(self):
        before = append_reads({"revision": 1, "records": []}, "a")
        after = append_reads(append_reads(before, "b"), "c")
        self.assertEqual(C.final_journal(before, after), after)
        for mutation in (lambda x: x["records"][0].update(outcome="changed"), lambda x: x["records"].pop(),
                         lambda x: x["records"][-1].update(id=5), lambda x: x["records"][-1].update(command="save_config"),
                         lambda x: x["records"][-1].update(outcome="accepted"), lambda x: x["records"][-1].update(session="b" * 64)):
            value = copy.deepcopy(after); mutation(value)
            with self.assertRaises(RuntimeError): C.final_journal(before, value)


class StagingTests(unittest.TestCase):
    @contextmanager
    def reviewed(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            folder = Path(temporary).resolve(); value = T.profile(); old, new, baseline = T.compared_packages()
            value["baseline"] = baseline
            receipt = {"hubVersion": "0.1.16", "assemblyCommit": baseline["source"], "compiledFeatures": U.FEATURES,
                       "portableHostBuild": {"sourceCommit": baseline["source"], "sourceTree": baseline["tree"], "compiledFeatures": U.FEATURES, "rawHub": baseline["raw"]},
                       "productionMigration": {"sourceCommit": baseline["source"], "sourceTree": baseline["tree"], "compiledFeatures": U.FEATURES, "rawHub": baseline["raw"]},
                       "privateModulesRecompiled": False, "privateModulesResigned": False, "releaseReady": False}
            descriptor = {"appId": "creator-hub", "version": "0.1.17", "platform": "linux", "architecture": "x86_64", "packageType": "deb",
                          "assetName": "Creator_Hub_0.1.17_amd64-acceptance-only.deb", "byteLength": U.FIXED["17"]["deb"]["size"],
                          "sha256": U.FIXED["17"]["deb"]["sha256"], "executableSha256": U.FIXED["17"]["hub"]["sha256"]}
            latest = {"version": "0.1.17", "platforms": {"linux-x86_64-deb": {
                "signature": base64.b64encode(b"untrusted comment: unit signature").decode(),
                "url": "https://github.com/" + U.REPO + "/releases/download/v0.1.17/" + descriptor["assetName"]}}}
            for name in value["objects"]:
                path = U.object_path(folder, value, name); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"unit bytes")
            for name, obj in (("debDescriptor17", descriptor), ("assemblyReceipt16", receipt), ("latest17", latest)):
                U.object_path(folder, value, name).write_text(json.dumps(obj))
            original_load = U.load
            shared = original_load("private-linux-update-fixture-017-package-verify")
            package = SimpleNamespace(base_reader=lambda: SimpleNamespace(verify=Mock()), inspect=Mock(side_effect=[old, new]),
                                      validate_expected=shared.validate_expected, baseline_members=shared.baseline_members,
                                      LIMIT=shared.LIMIT, ARCHIVE=shared.ARCHIVE)
            marker = Mock()
            def load(name):
                if name == "private-linux-update-fixture-017-package-verify": return package
                if name == "native-linux-root-probe": return SimpleNamespace(verify_deb_marker=marker)
                return original_load(name)
            stack.enter_context(patch.object(U, "load", side_effect=load))
            stack.enter_context(patch.object(U, "packaged_root", return_value=b"unit ELF"))
            signatures = stack.enter_context(patch.object(U, "signature"))
            resources = stack.enter_context(patch.object(U, "baseline_mcp_inputs"))
            yield SimpleNamespace(folder=folder, value=value, signatures=signatures, resources=resources, marker=marker)

    def test_shared_review_retains_all_packages_resources_and_markers(self):
        with self.reviewed() as f:
            review = U.review_staged_packages(f.folder, f.value, "unit-verifier", "deb-approve")
            self.assertTrue(review["signaturesVerified"])
            self.assertEqual(review["privateTargetQualification"], U.private_target_qualification())
            f.signatures.assert_called_once_with(U.object_path(f.folder, f.value, "debDescriptor17"), U.object_path(f.folder, f.value, "debSignature17"), "unit-verifier")
            f.resources.assert_called_once(); self.assertEqual(f.marker.call_count, 2)

    def test_shared_review_refuses_route_descriptor_compile_or_signature_gap(self):
        for object_name, mutate in (("debDescriptor17", lambda x: x.update(assetName="other.deb")),
                                    ("latest17", lambda x: x["platforms"]["linux-x86_64-deb"].update(url="https://foreign/installer")),
                                    ("assemblyReceipt16", lambda x: x.update(privateModulesResigned=True)),
                                    ("assemblyReceipt16", lambda x: x["productionMigration"].update(sourceCommit="f" * 40))):
            with self.subTest(object=object_name), self.reviewed() as f:
                path = U.object_path(f.folder, f.value, object_name); value = json.loads(path.read_bytes()); mutate(value); path.write_text(json.dumps(value))
                with self.assertRaises(RuntimeError): U.review_staged_packages(f.folder, f.value, "unit-verifier", "deb-approve")
        with self.reviewed() as f:
            f.signatures.side_effect = RuntimeError("signature refused")
            with self.assertRaisesRegex(RuntimeError, "signature refused"): U.review_staged_packages(f.folder, f.value, "unit-verifier", "deb-approve")

    def test_both_callers_use_the_same_review_without_copy(self):
        for path, name in ((HERE / "native-linux-production-016-update.py", "stage"), (HERE / "native-linux-migrated-update.py", "verify_inputs")):
            tree = ast.parse(path.read_text()); fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            calls = [ast.unparse(n.func).split(".")[-1] for n in ast.walk(fn) if isinstance(n, ast.Call)]
            self.assertEqual(calls.count("review_staged_packages"), 1)
            self.assertNotIn("compare_update_packages", calls)
            self.assertIn("stage_zip", calls)


class OutcomeTests(unittest.TestCase):
    def test_native_scoped_success_requires_all_original_update_proofs(self):
        report = native_report(); self.assertTrue(C.continuation_outcome(report))
        for name in ("settingsPreserved", "runtimeSurvived", "normalFinalClose", "migrationEvidencePreserved", "homePreserved", "journalPrefixPreserved"):
            with self.subTest(name=name), self.assertRaises(RuntimeError): C.continuation_outcome({**report, name: False})
        for name, value in (("systemActions", ["Authenticate", "Authenticate"]), ("nativeActions", []), ("beforeMigrationConnectionContinued", True),
                            ("releaseReady", True), ("mcpProtocol", {}), ("successorProjects", {})):
            with self.subTest(name=name), self.assertRaises(RuntimeError): C.continuation_outcome({**report, name: value})

    def test_broker_requires_complete_cleanup_without_masking_original_failure(self):
        record = broker_report(); self.assertTrue(C.broker_outcome(record))
        for name, value in (("nativePassed", False), ("preservationPassed", False), ("fixtureRelocked", False),
                            ("tlsCleanup", None), ("transportClosed", False), ("sessionExit", None), ("sessionExit", False),
                            ("refusal", {}), ("cleanupRefused", False), ("recovery", "unknown"), ("releaseReady", True)):
            with self.subTest(name=name), self.assertRaises(RuntimeError): C.broker_outcome({**record, name: value})

    def test_controller_never_reseeds_reinstalls_or_manually_starts_successor(self):
        tree = ast.parse((HERE / "native-linux-migrated-update.py").read_text())
        calls = [ast.unparse(n.func).split(".")[-1] for n in ast.walk(tree) if isinstance(n, ast.Call)]
        self.assertFalse(set(calls) & {"fixtures", "fixture", "create_account", "prepare_existing_route", "bootstrap16", "kill", "killpg"})
        native = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        launches = [n for n in ast.walk(native) if isinstance(n, ast.Call) and ast.unparse(n.func) == "subprocess.Popen"]
        self.assertEqual(sum("/usr/bin/creator-hub" in ast.unparse(n.args[0]) for n in launches), 1)
        self.assertEqual(calls.count("observe_successor"), 1)
        self.assertIn("BoundRoute", calls)


class SuccessorStateTests(unittest.TestCase):
    def manifest(self):
        files = {"mcp/server/creator-works-mcp.mjs": b"unit MCP", "mcp/server/runtime/node": b"unit node"}
        entry = {"executable": "mcp/server/runtime/node", "version": "2.7.7", "files": {k: U.pin(v)["sha256"] for k, v in sorted(files.items())}}
        manifest = {"schemaVersion": 1, "platform": "linux", "arch": "x86_64", "modules": {"mcp": entry, "setup": {"files": {}}},
                    "managedRouting": {"files": {}}, "payloadArchive": {"schemaVersion": 1, "file": "modules.tar.gz",
                        "files": {name: {"size": len(body), "mode": 0o755 if name.endswith("node") else 0o644} for name, body in files.items()},
                        "unpackedSize": sum(map(len, files.values()))}}
        generation = hashlib.sha256(json.dumps(entry, separators=(",", ":")).encode()).hexdigest()
        return manifest, files, generation

    def test_exact_successor_manifest_generation_and_contents_only(self):
        manifest, files, generation = self.manifest()
        with patch.object(C, "SUCCESSOR_GENERATION", generation):
            allowed = C.generation_entries(manifest); prefix = C.GENERATION_PARENT + generation
            before = {".": {"dev": 1, "ino": 2}, "old-backup": {"sha256": "a" * 64}}
            after = {**before, **{name: {**expected, "dev": 1, "ino": i + 10, "uid": M.UID, "gid": M.UID} for i, (name, expected) in enumerate(allowed.items())}}
            C.compare_tree(before, before, generation=allowed)
            C.compare_tree(before, after, generation=allowed, require_generation=True)
            for name in allowed:
                incomplete = copy.deepcopy(after); incomplete.pop(name)
                with self.subTest(missing=name), self.assertRaises(RuntimeError): C.compare_tree(before, incomplete, generation=allowed, require_generation=True)
            for name, key, value in ((prefix, "mode", 0o777), (prefix + "/mcp/server/runtime/node", "sha256", "a" * 64),
                                     (prefix + "/mcp/server/runtime/node", "uid", 0), (prefix + "/mcp/server/runtime/node", "mode", 0o644),
                                     ("old-backup", "sha256", "b" * 64)):
                changed = copy.deepcopy(after); changed[name][key] = value
                with self.assertRaises(RuntimeError): C.compare_tree(before, changed, generation=allowed)
            for extra in (prefix + "/extra", C.GENERATION_PARENT + "0" * 64, C.GENERATION_PARENT + ".staging-unit"):
                with self.assertRaises(RuntimeError): C.compare_tree(before, {**after, extra: {}}, generation=allowed)
        with self.assertRaisesRegex(RuntimeError, "Unreviewed successor"): C.generation_entries(manifest)

    def test_generation_is_bound_to_pinned_embedded_manifest_archive_and_package(self):
        manifest, files, generation = self.manifest()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, body in files.items():
                item = tarfile.TarInfo(name); item.size = len(body); item.mode = manifest["payloadArchive"]["files"][name]["mode"]
                archive.addfile(item, io.BytesIO(body))
        archive = gzip.compress(buffer.getvalue(), mtime=0); archive_pin = U.pin(archive)
        manifest["payloadArchive"].update(archive_pin)
        raw = json.dumps(manifest).encode(); root_body = b"unit ELF" + raw
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary).resolve(); root = folder / "members/assembly17/payload"; root.mkdir(parents=True)
            for name, body in (("builtin-manifest.json", raw), ("modules.tar.gz", archive), ("creator-hub", root_body)):
                (root / name).write_bytes(body)
            profile = {"objects": {"raw17": {"artifact": "assembly17", "member": "payload/creator-hub"}},
                       "artifacts": {"assembly17": {"files": {"payload/builtin-manifest.json": U.pin(raw), "payload/modules.tar.gz": archive_pin}}}}
            packages = {"usr/lib/Creator Hub/modules.tar.gz": archive_pin}
            fixed = {**U.FIXED, "17": {**U.FIXED["17"], "raw": U.pin(root_body), "archive": archive_pin}}
            with patch.object(U, "FIXED", fixed), patch.object(C, "SUCCESSOR_GENERATION", generation):
                self.assertEqual(C.successor_generation(folder, profile, packages), C.generation_entries(manifest))
                with self.assertRaises(RuntimeError): C.successor_generation(folder, profile, {"usr/lib/Creator Hub/modules.tar.gz": U.pin(b"different")})
                (root / "modules.tar.gz").write_bytes(archive + b"changed")
                with self.assertRaises(RuntimeError): C.successor_generation(folder, profile, packages)

    def test_existing_cache_mutation_still_refused(self):
        before = {".": {"dev": 1}, "cache/existing": {"sha256": "a" * 64}}
        with self.assertRaises(RuntimeError): C.compare_tree(before, {**before, "cache/existing": {"sha256": "b" * 64}})

    def test_exact_false_preference_consent_never_changes_preference(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); path = home / U.PREFS; path.parent.mkdir(parents=True)
            raw = b'{"restoreHostedViews":false,"preserved":"unit"}'; path.write_bytes(raw)
            self.assertEqual(C.update_question(home), "Update Creator Hub to 0.1.17?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."
                "\n\nHub will close these idle views: Creator Project Setup. Unsaved form entries will be discarded. "
                "Automatic reopening is turned off. You can open them again from Hub. Standalone apps and MCP connections will stay open.")
            self.assertEqual(path.read_bytes(), raw)
            self.assertIn("They will reopen after Hub restarts.", U.question(False))
            for value in (True, None, 0, "false"):
                path.write_text(json.dumps({"restoreHostedViews": value}))
                with self.assertRaises(RuntimeError): C.update_question(home)


class InterfaceTests(unittest.TestCase):
    def test_real_tls_helper_filters_context_before_any_mutation(self):
        env = {**environment(), "UNREVIEWED": "not-forwarded"}
        real_context = U.clean_context
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                contexts = []
                def capture(values, **kwargs):
                    context = real_context(values, **kwargs)
                    contexts.append(context)
                    return context
                with patch.object(U, "clean_context", side_effect=capture), \
                     patch.object(Path, "mkdir", side_effect=RuntimeError("unit boundary before TLS files")) as mkdir:
                    with self.assertRaisesRegex(RuntimeError, "unit boundary before TLS files"):
                        U.prepare_tls(env, migrated=migrated)
                expected = C.child_environment(env) if migrated else {
                    **{key: env[key] for key in U.ENVIRONMENT}, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
                self.assertEqual(contexts, [expected])
                mkdir.assert_called_once_with(mode=0o700)
                self.assertNotIn("UNREVIEWED", contexts[0])
                self.assertEqual(contexts[0]["GITHUB_WORKFLOW_REF"], M.WORKFLOW)

    def test_real_transport_helper_admits_context_without_cross_import_or_child(self):
        env = {**environment(), "UNREVIEWED": "not-forwarded"}
        root = Path("/unit/transport")
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                with patch.object(U, "PipeChild", side_effect=RuntimeError("unit boundary before process creation")) as child:
                    with self.assertRaisesRegex(RuntimeError, "unit boundary before process creation"):
                        U.start_transport(env, root, "deb", {}, migrated=migrated)
                control, _ = U.update_channel(migrated)
                operation = "update-migrated-016-017" if migrated else "update-016-017"
                expected = C.transport_environment(env) if migrated else {
                    **{key: env[key] for key in U.ENVIRONMENT}, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
                    "RUNNER_TEMP": str(U.BASE / "result"), "HOME": str(U.BASE / "result/home")}
                child.assert_called_once_with([env["CONTROLLER_NODE"], str(control / "scripts/linux-update-lab-feed.cjs"),
                    operation, "deb", str(root)], expected, "transport", synthetic=True)
                self.assertNotIn("UNREVIEWED", expected)
                self.assertEqual(expected["GITHUB_REF"], M.BRANCH)
        for name in ("native-linux-migrated-update", "../native-linux-migrated-update"):
            with self.assertRaisesRegex(RuntimeError, "Only reviewed neutral source"):
                U.load(name)
        self.assertTrue({"native-linux-production-016-update.py", "native-linux-production-016-migration.py"}
                        <= set(U.SOURCES) <= set(C.sources()))

    def test_legacy_paths_unchanged_and_unknown_channels_refused(self):
        self.assertEqual(U.update_channel(), (U.BASE, U.BASE / "result"))
        self.assertEqual(M.inventory_paths(), (M.BASE, M.BASE / "result"))
        self.assertEqual(U.update_channel(True), M.inventory_paths("migrated-update"))
        for value in (1, "true", None, {}):
            with self.assertRaises(RuntimeError): U.update_channel(value)
        for value in ("other", "../result", 1):
            with self.assertRaises(RuntimeError): M.inventory_paths(value)

    def test_inventory_new_channel_requires_update_approval_not_other_scenarios(self):
        M.InventoryClient("a" * 40, "deb-approve", cohort="update", channel="migrated-update")
        for cohort, scenario in (("migration", "migration-approve"), ("update", "deb-auth-cancel"), ("update", "portable-approve")):
            with self.assertRaises(RuntimeError): M.InventoryClient("a" * 40, scenario, cohort=cohort, channel="migrated-update")

    def test_continuation_inventory_roundtrip_never_reuses_old_mailboxes(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            base = Path(temporary).resolve(); control, result = base / "migrated-update", base / "result/migrated-update"
            control.mkdir(); result.mkdir(parents=True)
            old = base / "inventory-response-1.json"; old.write_bytes(b"original evidence")
            actor = [M.UID]
            stack.enter_context(patch.object(M, "BASE", base))
            stack.enter_context(patch.multiple(M.os, getuid=lambda: actor[0], geteuid=lambda: actor[0], create=True))
            stack.enter_context(patch.object(M, "inventory_channel"))
            stack.enter_context(patch.object(M, "native_process_inventory", return_value={"processes": [], "terminalProcesses": []}))
            real_read = M.read_file
            stack.enter_context(patch.object(M, "read_file", side_effect=lambda path, limit, **kwargs: real_read(path, limit)))
            state, record = {"sequence": 1, "nonces": set()}, {}
            def wait(predicate):
                actor[0] = 0
                try: M.serve_inventory(state, record, "a" * 40, "deb-approve", None, None, cohort="update", channel="migrated-update")
                finally: actor[0] = M.UID
                self.assertTrue(predicate())
            client = M.InventoryClient("a" * 40, "deb-approve", cohort="update", channel="migrated-update")
            self.assertTrue(client.sample(wait)["ok"])
            self.assertEqual(old.read_bytes(), b"original evidence")
            self.assertTrue((control / "inventory-response-1.json").exists())
            self.assertTrue((result / "inventory-request-1.json").exists())
            client.sequence = 1
            with self.assertRaisesRegex(RuntimeError, "cannot be adopted"): client.sample(wait)
            with self.assertRaisesRegex(RuntimeError, "cannot be retried"): client.sample(wait)

    def test_copied_source_drift_is_rechecked_before_input_authority(self):
        original = {"context": {}, "sources": {"controller.py": U.pin(b"original")}}
        with tempfile.TemporaryDirectory() as temporary:
            control = Path(temporary).resolve(); scripts = control / "scripts"; scripts.mkdir()
            (scripts / "controller.py").write_bytes(b"changed")
            with patch.object(C, "CONTROL", control), patch.object(C, "intent", return_value=original), patch.object(U, "protected_ancestry"):
                real_bound = U.bound
                def bound(path, expected, limit, **kwargs): return real_bound(path, expected, limit)
                with patch.object(U, "bound", side_effect=bound), self.assertRaisesRegex(RuntimeError, "Independent bytes differ"):
                    C.recheck_sources(environment(), original)


class BrokerTests(unittest.TestCase):
    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary).resolve(); base = root / "fixture"; (base / "result").mkdir(parents=True)
            workspace = root / "workspace"; source = workspace / "scripts"; source.mkdir(parents=True)
            controller = source / "native-linux-migrated-update.py"; controller.write_bytes(b"unit-only controller")
            node = root / "node"; node.write_bytes(b"unit-only node")
            driver = root / "native-linux-production-016-driver/bin/tauri-driver"; driver.parent.mkdir(parents=True); driver.write_bytes(b"unit-only driver")
            verifier = root / "verifier"; verifier.write_bytes(b"unit-only verifier")
            qualification = {"tool": {"pin": U.pin(verifier.read_bytes())}}
            original = {"context": {"source": "a" * 40}, "sources": {controller.name: U.pin(controller.read_bytes())},
                        "driver": U.pin(driver.read_bytes()), "node": U.pin(node.read_bytes()), "verifier": qualification}
            before = {"revision": 1, "records": []}; after = append_reads(append_reads(before, "b"), "c")
            sealed = {"context": original["context"], "accountUid": M.UID, "home": {}, "journal": before}
            env = {**environment(), "GITHUB_WORKSPACE": str(workspace), "RUNNER_TEMP": str(root), "CONTROLLER_NODE": str(node)}
            control, output = base / "migrated-update", base / "result/migrated-update"
            for name, value in (("BASE", base), ("HERE", source), ("CONTROL", control), ("OUTPUT", output)):
                stack.enter_context(patch.object(C, name, value))
            stack.enter_context(patch.object(U, "TLS_CERT", root / "unused-ca"))
            stack.enter_context(patch.multiple(C.os, getuid=lambda: 0, geteuid=lambda: 0, chown=lambda *a: None, create=True))
            stack.enter_context(patch.object(C, "intent", return_value=original))
            stack.enter_context(patch.object(C, "directory"))
            stack.enter_context(patch.object(C, "adopt", return_value=sealed))
            stack.enter_context(patch.object(M, "native_process_inventory", return_value={"processes": [], "terminalProcesses": []}))
            stack.enter_context(patch.object(U, "offline_verifier", return_value=(verifier, qualification)))
            stack.enter_context(patch.object(C, "verify_inputs", return_value=({"baseline": {}}, {"successorGeneration": {}, "baseline": {}})))
            stack.enter_context(patch.object(U, "verify_installed"))
            stack.enter_context(patch.object(C, "preserve"))
            preserved = stack.enter_context(patch.object(C, "verify_preservation"))
            stack.enter_context(patch.object(M, "journal", return_value=after))
            real_read = U.read
            stack.enter_context(patch.object(U, "read", side_effect=lambda path, limit=262144, **kwargs: real_read(path, limit)))
            credential, account = [], ["L"]
            def credential_action(action, secret=None):
                credential.append(action)
                if action == "provision": account[0] = "P"
                if action == "lock": account[0] = "L"
                return account[0]
            polkit = SimpleNamespace(fixture_credential=credential_action, verify_files=Mock(), admin_config=Mock(), credential_tools=Mock())
            logs = Mock(); logs.metadata.return_value = {k: {"eof": True, "truncated": False} for k in ("stdout", "stderr")}
            if failure == "output": logs.metadata.return_value["stderr"]["eof"] = False
            native = SimpleNamespace(Capture=Mock(return_value=logs))
            modules = {"native-linux-polkit-probe": polkit, "native-linux-root-probe": native,
                       "native-unix-window": Mock(), "native-linux-update-mcp": U.load("native-linux-update-mcp")}
            stack.enter_context(patch.object(U, "load", side_effect=lambda name: modules[name]))
            def prepare_transport(*args):
                path = output / "transport"; path.mkdir(); return path, {}
            stack.enter_context(patch.object(U, "prepare_transport", side_effect=prepare_transport))
            inspected = {"fromVersion": "0.1.16", "targetVersion": "0.1.17", "publicDiscovery": False, "releaseReady": False}
            stack.enter_context(patch.object(C.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(inspected).encode(), stderr=b"")))
            lab, guard = Mock(), Mock(); lab.proxy = "http://127.0.0.1:1234"
            if failure in ("cleanup", "original-and-cleanup"): guard.finish.side_effect = RuntimeError("unit cleanup refused")
            stack.enter_context(patch.object(U, "prepare_tls", return_value=guard))
            stack.enter_context(patch.object(U, "start_transport", return_value=lab))
            stack.enter_context(patch.object(U, "tls_cleanup", return_value={"temporaryCertificateRemoved": True, "originalTrustRestored": True}))
            stack.enter_context(patch.object(U, "validate_transport_report", return_value={}))
            child = Mock(); child.stdin = io.BytesIO(); child.poll.return_value = 1 if failure in ("native", "original-and-cleanup") else 0
            def launch(*args, **kwargs):
                report = {**native_report(), "harnessSource": env["GITHUB_SHA"], "scenarioPassed": True}
                (output / "report.json").write_text(json.dumps(report)); (output / "transport/lab-transport.json").write_text("{}")
                return child
            spawn = stack.enter_context(patch.object(C.subprocess, "Popen", side_effect=launch))
            if failure:
                with self.assertRaises(RuntimeError): C.broker(env)
            else:
                C.broker(env)
            record = json.loads((control / "broker.json").read_bytes())
            self.assertEqual(credential, ["status", "provision", "status", "lock", "status"])
            self.assertEqual(account[0], "L"); spawn.assert_called_once(); guard.finish.assert_called_once()
            self.assertEqual(record["scenarioPassed"], failure is None)
            self.assertEqual(record["continuousMigratedUserAccepted"], failure is None)
            if failure == "original-and-cleanup": self.assertIn("Continuation failed/unknown", record["refusal"]["message"])
            if failure is None: self.assertTrue(preserved.call_args.kwargs["require_generation"])
            self.assertFalse(record["releaseReady"])
            with self.assertRaisesRegex(RuntimeError, "Existing continuation"): C.broker(env)
            self.assertEqual(json.loads((control / "broker.json").read_bytes()), record)

    def test_mocked_success_finishes_cleanup_and_refuses_retry(self): self.exercise()

    def test_mocked_native_failure_preserves_failed_fixture_and_still_relocks(self): self.exercise("native")

    def test_mocked_cleanup_failure_cannot_pass(self): self.exercise("cleanup")

    def test_mocked_incomplete_output_cannot_pass(self): self.exercise("output")

    def test_mocked_cleanup_failure_never_replaces_original_failure(self): self.exercise("original-and-cleanup")


if __name__ == "__main__":
    unittest.main()
