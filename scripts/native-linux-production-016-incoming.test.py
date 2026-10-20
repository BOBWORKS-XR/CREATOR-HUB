"""Pure fixtures and source/workflow contracts only. Never installs or opens GUI."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("incoming016", HERE / "native-linux-production-016-incoming.py")
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)
ROOT = HERE.parent
WORKFLOW = ROOT / ".github/workflows/native-linux-production-016-incoming.yml"
REFUSAL = (ValueError, RuntimeError)


def environment(scenario="fresh16"):
    return dict(GITHUB_ACTIONS="true", GITHUB_REPOSITORY="BOBWORKS-XR/CREATOR-HUB", GITHUB_REPOSITORY_ID="1364807512",
                GITHUB_REF=p.BRANCH, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_WORKFLOW_REF=p.WORKFLOW,
                RUNNER_ENVIRONMENT="github-hosted", RUNNER_OS="Linux", RUNNER_ARCH="X64", GITHUB_SHA="a" * 40,
                GITHUB_RUN_ID="1", GITHUB_RUN_ATTEMPT="1", GITHUB_WORKSPACE=str(ROOT), RUNNER_TEMP="/fixture",
                CREATOR_INCOMING_016_EXECUTE="true", CREATOR_INCOMING_016_SCENARIO=scenario,
                CREATOR_NATIVE_LINUX_PRODUCTION_016="1")


def api():
    asset = dict(id=p.BASELINE["assetId"], name=p.BASELINE["name"], size=p.BASELINE["size"],
                 digest="sha256:" + p.BASELINE["sha256"], state="uploaded",
                 browser_download_url="https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.12/" + p.BASELINE["name"])
    return dict(inspectionRun=dict(id=p.INSPECTION["run"], run_attempt=1, workflow_id=p.INSPECTION["workflow"],
                                  head_sha=p.PROFILE["assembly"]["sourceCommit"], head_branch="validation/native-linux-production-016",
                                  path=".github/workflows/native-linux-production-016.yml", event="workflow_dispatch",
                                  repository=dict(id=1364807512), status="completed", conclusion="success"),
                inspectionJob=dict(id=p.INSPECTION["job"], run_id=p.INSPECTION["run"], run_attempt=1, status="completed", conclusion="success"),
                inspectionArtifact=dict(id=p.INSPECTION["artifact"], name="native-linux-production-016-inspection-39348205069-1",
                                        size_in_bytes=p.INSPECTION["size"], digest="sha256:" + p.INSPECTION["sha256"], expired=False,
                                        workflow_run=dict(id=p.INSPECTION["run"], head_sha=p.PROFILE["assembly"]["sourceCommit"],
                                                          repository_id=1364807512, head_repository_id=1364807512)),
                release=dict(id=p.BASELINE["releaseId"], tag_name="v0.1.12", draft=False, prerelease=False, assets=[copy.deepcopy(asset)]), asset=asset,
                tag=dict(ref="refs/tags/v0.1.12", object=dict(type="tag", sha=p.BASELINE["tagObject"])),
                tagObject=dict(sha=p.BASELINE["tagObject"], tag="v0.1.12", object=dict(type="commit", sha=p.BASELINE["source"],
                    url="https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/git/commits/" + p.BASELINE["source"])))


def binding():
    legacy = []
    for product, repo, tag, name in zip(("mcp", "setup"), ("CREATOR-WORKS-UNITY-MCP", "CREATOR-PROJECT-SETUP"),
            ("v2.7.7", "v0.3.7"), ("Creator.Works.MCP_2.7.7_amd64.deb", "Creator.Project.Setup_0.3.7_amd64.deb")):
        size, sha = p.P.S.LEGACY[product]
        legacy.append(dict(assetId=123, releaseId=456, product=product, repo=repo, tag=tag, name=name, size=size, sha256=sha))
    value = dict(schemaVersion=1, cohort=p.P.COHORT, inspectionOnly=True, profile=copy.deepcopy(p.PROFILE),
                 api=dict(schemaVersion=1, cohort=p.P.COHORT, harnessSource="a" * 40, assembly=copy.deepcopy(p.PROFILE["assembly"]),
                          privatePayload=copy.deepcopy(p.P.PRIVATE), privateSourcePaths=dict.fromkeys(p.P.PRIVATE_PATHS, "b" * 40),
                          legacy=legacy, **p.P.FLAGS),
                 productionProof=dict(compiledFeatures=list(p.P.FEATURES), sourceCommit=p.PROFILE["assembly"]["sourceCommit"],
                                      sourceTree=p.PROFILE["assembly"]["sourceTree"], rawHub=copy.deepcopy(p.PROFILE["pins"]["rawHub"]),
                                      hub=copy.deepcopy(p.PROFILE["pins"]["hub"]), rawToPackaged="exact-tauri-bundle-marker-deb", **p.P.FLAGS),
                 packageFiles={p.HUB[1:]: {**p.PROFILE["pins"]["hub"], "mode": 0o755}}, resourceFiles={}, **p.P.FLAGS)
    return value


class FakeDriver:
    def __init__(self):
        self.commands = []
        self.open = ""
        self.version = "0.1.12"
        self.result = ["false"] * 3

    def read(self, selector, endpoint="text"):
        if selector == "#usage-terms-dialog":
            return self.open
        if selector == ".footer-version":
            return self.version
        raise AssertionError((selector, endpoint))

    def call(self, method, endpoint, payload):
        self.commands.append((method, endpoint, payload))
        return self.result if endpoint == "/execute/sync" else None


class DirectPagesDriver:
    guide = '#feature-mcp [data-field="guide-dialog"]'
    start = '#feature-mcp [data-field="guide-start"]'

    def __init__(self, *, fresh=True, missing=False, title="Connect your AI to Unity", failed_click=False, stalled_close=False):
        self.fresh, self.missing, self.title, self.failed_click = fresh, missing, title, failed_click
        self.stalled_close = stalled_close
        self.feature = None
        self.clicks, self.commands = [], []
        self.guide_reads = self.close_reads = 0
        self.opened = self.started = self.closed = False

    def elements(self, selector):
        if selector == "iframe,object,embed":
            return []
        if selector == "#project-list .project-row":
            return [] if self.fresh else ["selected", "other"]
        if selector == '#project-list .project-row[data-mcp-selected="true"]':
            return [] if self.fresh else ["selected"]
        if selector == "#project-list .project-empty":
            return ["empty"] if self.fresh else []
        if selector == '#feature-mcp .feature-project[data-selected="true"]':
            return [] if self.fresh else ["selected"]
        if selector in ("#view-projects", "#feature-mcp", "#feature-setup", self.guide,
                        '#suite-menu [data-view="mcp"]', '#suite-menu [data-view="setup"]'):
            return ["owned"]
        raise AssertionError(selector)

    def read(self, selector, endpoint="text"):
        if selector == self.guide:
            if endpoint == "displayed":
                self.guide_reads += 1
                if not self.missing and self.guide_reads >= 3:
                    self.opened = True
                return self.opened and not self.closed
            if endpoint == "attribute/open":
                if self.started:
                    self.close_reads += 1
                    if self.close_reads >= 3 and not self.stalled_close:
                        self.closed = True
                return "" if self.opened and not self.closed else None
        values = {
            ("#convergence-dialog", "attribute/open"): None,
            ("#view-projects", "attribute/aria-busy"): "false",
            ("#projects-home-title", "text"): "Projects",
            ("#view-hub", "displayed"): False,
            ("#update-settings", "attribute/open"): "",
            ('#project-list .project-row[data-mcp-selected="true"]', "text"): "selected-project",
            ('#feature-mcp .feature-project[data-selected="true"]', "text"): "Selected incoming project",
            ("#feature-mcp-guide-title", "text"): self.title,
            (self.start, "text"): "Set up a connection",
        }
        for name in p.PREF_IDS:
            values[("#" + name, "property/checked")] = self.fresh
            values[("#" + name, "displayed")] = True
        for feature in ("mcp", "setup"):
            prefix = "#feature-" + feature
            values[(prefix, "attribute/aria-busy")] = "false"
            values[(prefix + ' [data-field="status"]', "text")] = "Ready"
            values[(prefix + ' [data-field="error"]', "text")] = ""
            values[(prefix + ' [data-field="controls"]', "attribute/disabled")] = None
        if (selector, endpoint) in values:
            return values[(selector, endpoint)]
        if endpoint == "displayed" and self.elements(selector):
            return True
        raise AssertionError((selector, endpoint))

    def click(self, selector):
        self.clicks.append(selector)
        if selector == "#suite-trigger":
            if self.fresh and self.feature == "mcp" and not self.closed:
                raise AssertionError("Fresh guide still blocks the owned shell")
            return
        if selector in ('#suite-menu [data-view="mcp"]', '#suite-menu [data-view="setup"]'):
            self.feature = "mcp" if '"mcp"' in selector else "setup"
            return
        if selector == self.start:
            if not self.fresh or not self.opened or self.started:
                raise AssertionError("Guide action was absent, unready or repeated")
            self.started = True
            if self.failed_click:
                raise RuntimeError("Guide click outcome unknown")
            return
        raise AssertionError(selector)

    def call(self, method, endpoint):
        self.commands.append((method, endpoint))
        if (method, endpoint) != ("GET", "/window/handles"):
            raise AssertionError("Only owned window observation is allowed")
        return ["owned"]


class DirectPages(unittest.TestCase):
    @staticmethod
    def wait(check):
        for _ in range(20):
            if check():
                return
        raise RuntimeError("Read-only readiness deadline")

    def run_pages(self, driver, scenario="fresh16"):
        return p.direct_pages(driver, SimpleNamespace(wait=self.wait), scenario)

    def test_fresh_async_guide_is_started_once_and_closed_before_setup(self):
        for _ in ("initial16", "reopened16"):
            driver = DirectPagesDriver()
            result = self.run_pages(driver)
            self.assertEqual(driver.clicks, ["#suite-trigger", '#suite-menu [data-view="mcp"]',
                                             driver.start, "#suite-trigger", '#suite-menu [data-view="setup"]'])
            self.assertGreaterEqual(driver.guide_reads, 3)
            self.assertGreaterEqual(driver.close_reads, 3)
            self.assertTrue(driver.closed)
            self.assertEqual(result, dict(projects=True, mcp=True, setup=True, preferences=dict.fromkeys(p.PREF_KEYS, True)))
            self.assertEqual(driver.commands, [("GET", "/window/handles")] * 2)

    def test_missing_guide_times_out_without_click_or_shell_fallback(self):
        driver = DirectPagesDriver(missing=True)
        with self.assertRaisesRegex(RuntimeError, "Read-only readiness deadline"):
            self.run_pages(driver)
        self.assertEqual(driver.clicks, ["#suite-trigger", '#suite-menu [data-view="mcp"]'])

    def test_unclosed_guide_never_repeats_start_or_opens_setup(self):
        driver = DirectPagesDriver(stalled_close=True)
        with self.assertRaisesRegex(RuntimeError, "Read-only readiness deadline"):
            self.run_pages(driver)
        self.assertEqual(driver.clicks, ["#suite-trigger", '#suite-menu [data-view="mcp"]', driver.start])
        self.assertFalse(driver.closed)
        self.assertFalse(driver.commands)

    def test_mismatched_dialog_and_uncertain_click_are_not_retried(self):
        for arguments, message in ((dict(title="Unexpected guide"), "Unexpected fresh MCP guide"),
                                   (dict(failed_click=True), "Guide click outcome unknown")):
            with self.subTest(arguments=arguments):
                driver = DirectPagesDriver(**arguments)
                with self.assertRaisesRegex(RuntimeError, message):
                    self.run_pages(driver)
                self.assertLessEqual(driver.clicks.count(driver.start), 1)
                self.assertEqual(driver.clicks.count("#suite-trigger"), 1)
                self.assertFalse(driver.commands)

    def test_public012_route_does_not_open_or_dismiss_a_fresh_guide(self):
        driver = DirectPagesDriver(fresh=False)
        result = self.run_pages(driver, "public012-to16")
        self.assertEqual(driver.clicks, ["#suite-trigger", '#suite-menu [data-view="mcp"]',
                                         "#suite-trigger", '#suite-menu [data-view="setup"]'])
        self.assertEqual(driver.guide_reads, 0)
        self.assertEqual(result["preferences"], dict.fromkeys(p.PREF_KEYS, False))


class Admission(unittest.TestCase):
    def test_only_two_manual_exact_hosted_scenarios(self):
        for scenario in p.SCENARIOS:
            self.assertEqual(p.admission(environment(scenario), system="linux", uid=1000), scenario)
        for key, value in (("GITHUB_REF", "refs/heads/validation/linux-integrated-pages"),
                           ("GITHUB_EVENT_NAME", "push"), ("GITHUB_WORKFLOW_REF", p.WORKFLOW.replace("incoming", "migration")),
                           ("CREATOR_INCOMING_016_EXECUTE", "false"), ("CREATOR_INCOMING_016_SCENARIO", "migration-approve"),
                           ("RUNNER_ENVIRONMENT", "self-hosted"), ("RUNNER_ARCH", "ARM64"), ("LD_PRELOAD", "/fixture/x"),
                           ("NODE_OPTIONS", ""), ("APPIMAGE", "/fixture/x")):
            with self.subTest(key=key):
                with self.assertRaises(REFUSAL):
                    p.admission({**environment(), key: value}, system="linux", uid=1000)

    def test_original_inspection_and_public_tag_are_independently_bound(self):
        p.validate_api(api())
        mutations = (("inspectionRun", "head_sha", "c" * 40), ("inspectionRun", "run_attempt", True),
                     ("inspectionRun", "conclusion", "failure"), ("inspectionJob", "run_id", 9),
                     ("inspectionArtifact", "digest", "sha256:" + "0" * 64), ("inspectionArtifact", "expired", True),
                     ("release", "draft", True), ("release", "id", 9), ("asset", "id", 9), ("asset", "size", 8))
        for section, field, value in mutations:
            changed = api()
            changed[section][field] = value
            with self.subTest(section=section, field=field), self.assertRaises(REFUSAL):
                p.validate_api(changed)
        for mutate in (lambda x: x["tag"]["object"].update(sha="0" * 40),
                       lambda x: x["tagObject"]["object"].update(sha="0" * 40),
                       lambda x: x["release"]["assets"].append(copy.deepcopy(x["asset"]))):
            changed = api()
            mutate(changed)
            with self.assertRaises(REFUSAL):
                p.validate_api(changed)

    def test_frozen_c13_profile_and_false_gates_cannot_be_relabelled(self):
        p.validate_binding(binding(), environment())
        for mutate in (lambda x: x["profile"]["assembly"].update(sourceCommit="d" * 40),
                       lambda x: x["profile"]["assembly"].update(runAttempt=True),
                       lambda x: x["profile"]["pins"]["hub"].update(size=1),
                       lambda x: x.update(releaseReady=True),
                       lambda x: x["productionProof"].update(compiledFeatures=["integrated-features"]),
                       lambda x: x["packageFiles"][p.HUB[1:]].update(mode=0o777)):
            changed = binding()
            mutate(changed)
            with self.assertRaises(REFUSAL):
                p.validate_binding(changed, environment())

    def test_seal_binds_scenario_source_context_api_driver_and_binding(self):
        env = environment()
        raw, fresh_api = json.dumps(binding()).encode(), json.dumps(api()).encode()
        original_admission = p.admission
        with mock.patch.object(p, "admission", side_effect=lambda env: original_admission(env, system="linux", uid=1000)):
            request = p.execution_request(env, raw, fresh_api, b"driver")
            p.check_request(request, env, raw, fresh_api, b"driver")
            for altered in (b"different-driver",):
                with self.assertRaises(REFUSAL):
                    p.check_request(request, env, raw, fresh_api, altered)
            with self.assertRaises(REFUSAL):
                p.check_request(request, environment("public012-to16"), raw, fresh_api, b"driver")
            for field in ("sources", "context", "binding", "api"):
                changed = copy.deepcopy(request)
                changed[field] = {}
                with self.assertRaises(REFUSAL):
                    p.check_request(changed, env, raw, fresh_api, b"driver")


class StorageAndPreservation(unittest.TestCase):
    def test_only_fixed_old_keys_under_unaccepted_terms_and_one_reload(self):
        d = FakeDriver()
        p.initialize_old_storage(d)
        self.assertEqual(d.commands, [("POST", "/execute/sync", {"script": p.INITIALIZE_012_STORAGE, "args": []}), ("POST", "/refresh", {})])
        self.assertEqual(p.INITIALIZE_012_STORAGE.count("localStorage.setItem("), 3)
        for key in p.PREF_KEYS:
            self.assertIn("localStorage.setItem('" + key + "', 'false')", p.INITIALIZE_012_STORAGE)
        for forbidden in ("__TAURI__", "invoke", "fetch", "cookie", "arguments", "eval", "Function", "__CREATOR"):
            self.assertNotIn(forbidden, p.INITIALIZE_012_STORAGE)

    def test_wrong_old_version_closed_terms_and_uncertain_write_never_retry(self):
        for field, value in (("version", "0.1.16"), ("open", None), ("result", ["false", "true", "false"])):
            d = FakeDriver()
            setattr(d, field, value)
            with self.assertRaises(REFUSAL):
                p.initialize_old_storage(d)
            self.assertFalse(any(row[1] == "/refresh" for row in d.commands))
            self.assertLessEqual(len(d.commands), 1)

    def test_old_terms_are_genuine_ui_localstorage_not_a_native_file_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            d = FakeDriver()
            d.click = mock.Mock(side_effect=lambda selector: setattr(d, "open", None) if selector == "#usage-terms-continue" else None)
            def wait(check):
                self.assertTrue(check())
            observed = p.terms(d, home, wait, accept=True, old=True)
            self.assertTrue(observed["genuineOldTermsUiAccepted"])
            self.assertFalse((home / p.TERMS).exists())
            self.assertEqual(d.click.call_args_list, [mock.call("#usage-terms-checkbox"), mock.call("#usage-terms-continue")])
            self.assertNotIn("creator-usage-terms.hub", p.INITIALIZE_012_STORAGE)

    def test_incoming_observes_automatic_legacy_terms_import_without_a_second_click(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            file = home / p.TERMS
            file.parent.mkdir(parents=True)
            p.save(file, dict(schemaVersion=1, policyVersion="2026-09-28-v1", acceptedAtMs=time.time_ns() // 1000000))
            before = p.fingerprint(file)
            d = FakeDriver()
            d.open = None
            d.click = mock.Mock()
            self.assertEqual(p.terms(d, home, lambda check: self.assertTrue(check()), accept=False), before)
            d.click.assert_not_called()

    def test_failed_terms_action_does_not_repeat_or_synthesize_acceptance(self):
        with tempfile.TemporaryDirectory() as temp:
            d = FakeDriver()
            d.click = mock.Mock()
            def deadline(check):
                if not check():
                    raise RuntimeError("read-only deadline")
            with self.assertRaisesRegex(RuntimeError, "read-only deadline"):
                p.terms(d, Path(temp).resolve(), deadline, accept=True, old=True)
            self.assertEqual(d.click.call_count, 2)

    def test_fresh_has_no_creator_preferences_terms_or_project_selection_seed(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            before = p.fixtures(home, "fresh16")
            self.assertEqual(set(before), {"unrelated/keep.json"})
            for name in (p.CONFIG, p.TERMS, p.PREFERENCES, p.JOURNAL):
                self.assertFalse((home / name).exists())
            self.assertEqual(p.preserved(home, before), before)

    def test_incoming_unknown_fields_selected_project_and_client_bytes_stay_exact(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            before = p.fixtures(home, "public012-to16")
            config = p.parse(p.read(home / p.CONFIG))
            self.assertEqual(config["active_channel_id"], "selected")
            self.assertEqual(config["unknownConfig"], {"nested": [12, 16]})
            self.assertEqual(len(config["channels"]), 2)
            self.assertEqual(p.preserved(home, before), before)
            self.assertFalse((home / p.PREFERENCES).exists())
            with (home / p.CONFIG).open("ab") as stream:
                stream.write(b" ")
            with self.assertRaises(REFUSAL):
                p.preserved(home, before)

    def test_unknown_migration_or_backup_is_not_ignored(self):
        for name in ("config/creator-works-mcp/.creator-hub-product-settings", "data/CreatorHub/client-migrations-v1", "unknown.bak"):
            with tempfile.TemporaryDirectory() as temp:
                home = Path(temp).resolve()
                before = p.fixtures(home, "fresh16")
                file = home / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b"foreign")
                with self.assertRaises(REFUSAL):
                    p.preserved(home, before)

    def test_native_record_must_match_observed_boolean_preferences_not_unknown_format(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            file = home / p.PREFERENCES
            file.parent.mkdir(parents=True)
            valid = dict(schemaVersion=1, preview=False, autoDownload=False, restoreHostedViews=False)
            file.write_text(json.dumps(valid))
            p.native_preferences(home, False)
            for bad in ({**valid, "preview": 0}, {**valid, "unknown": "kept"}, {**valid, "autoDownload": True}):
                file.write_text(json.dumps(bad))
                with self.assertRaises(REFUSAL):
                    p.native_preferences(home, False)

    def test_read_refuses_oversize_before_read_and_detects_same_bytes_new_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp).resolve() / "fixture"
            file.write_bytes(b"protected")
            with self.assertRaises(REFUSAL):
                p.read(file, 2)
            before = p.fingerprint(file)
            replacement = file.with_name("replacement")
            replacement.write_bytes(b"protected")
            os.replace(replacement, file)
            self.assertNotEqual(p.fingerprint(file), before)

    def test_dynamic_absence_is_readiness_not_element_lookup_failure(self):
        d = mock.Mock()
        d.elements.return_value = []
        self.assertFalse(p.present(d, "#fixed"))
        d.read.assert_not_called()
        d.elements.return_value = ["one", "two"]
        with self.assertRaises(REFUSAL):
            p.present(d, "#fixed")

    def test_native_tree_refuses_legacy_backends_not_system_webkit_children(self):
        for executable in ("/usr/bin/creator-works-mcp-launcher", "/usr/bin/creator-project-setup", "/usr/lib/Creator Works MCP/server/runtime/node", "/fixture/node"):
            self.assertTrue(p.legacy_process({"executable": executable}))
        for executable in (p.HUB, "/usr/bin/WebKitWebDriver", "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess"):
            self.assertFalse(p.legacy_process({"executable": executable}))


class PhaseGraph(unittest.TestCase):
    def baseline_audit(self, *, control=None, name="usr/bin/creator-hub", mode=0o755, kind=tarfile.REGTYPE, image=None, extra_control=False):
        if image is None:
            image = bytearray(64)
            image[:7] = b"\x7fELF\x02\x01\x01"
            image[16:18] = (3).to_bytes(2, "little")
            image[18:20] = (62).to_bytes(2, "little")
        control = control or b"Package: creator-hub\nVersion: 0.1.12\nArchitecture: amd64\n"
        def archive(rows):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for name, body, mode, kind in rows:
                    member = tarfile.TarInfo(name)
                    member.size, member.mode, member.uid, member.gid, member.type = len(body), mode, 0, 0, kind
                    tar.addfile(member, io.BytesIO(body))
            return output.getvalue()
        rows = [("control", control, 0o644, tarfile.REGTYPE), ("md5sums", b"", 0o644, tarfile.REGTYPE)]
        if extra_control:
            rows.append(("postinst", b"#!/bin/sh\nexit 0\n", 0o755, tarfile.REGTYPE))
        control_tar = archive(rows)
        data_tar = archive([(name, bytes(image), mode, kind)])
        def inspect(args, **kwargs):
            self.assertEqual(args[0], "/usr/bin/dpkg-deb")
            self.assertIn(args[1], ("--ctrl-tarfile", "--fsys-tarfile"))
            kwargs["stdout"].write(control_tar if args[1] == "--ctrl-tarfile" else data_tar)
            return SimpleNamespace(returncode=0, stderr=b"")
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp).resolve() / "synthetic-public.deb"
            package.write_bytes(b"synthetic carrier; only mocked inspectors may read it")
            synthetic_pin = p.pin(package.read_bytes())
            with mock.patch.dict(p.BASELINE, synthetic_pin), mock.patch.object(p.subprocess, "run", side_effect=inspect):
                return p.audit_baseline(package)

    def test_public_baseline_is_inspected_offline_before_any_install_or_execution(self):
        inspected = self.baseline_audit()
        self.assertEqual(set(inspected), {"usr/bin/creator-hub"})
        self.assertEqual(inspected["usr/bin/creator-hub"]["mode"], 0o755)

    def test_public_baseline_refuses_maintainer_scripts_wrong_identity_links_paths_and_nonelf(self):
        for arguments in (dict(extra_control=True), dict(control=b"Package: other\nVersion: 0.1.12\nArchitecture: amd64\n"),
                          dict(control=b"Package: creator-hub\nVersion: 0.1.12\nArchitecture: arm64\n"),
                          dict(name="etc/foreign"), dict(mode=0o4777), dict(kind=tarfile.SYMTYPE), dict(image=b"not ELF")):
            with self.subTest(arguments=arguments), self.assertRaises(REFUSAL):
                self.baseline_audit(**arguments)

    def test_reopen_failure_retains_all_false_gates_and_never_retries(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            result = base / p.RESULT
            home = result / "home"
            home.mkdir(parents=True)
            before = p.fixtures(home, "fresh16")
            p.save(result / "before.json", before)
            stage = base / p.STAGE
            stage.mkdir()
            p.save(stage / "binding.json", binding())
            env = {**environment(), "RUNNER_TEMP": str(base), "HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"),
                   "XDG_DATA_HOME": str(home / "data"), "XDG_CACHE_HOME": str(home / "cache")}
            def observe(folder, selected_home, selected_binding, **kwargs):
                if kwargs.get("reopened"):
                    raise RuntimeError("owned close outcome unknown")
                (home / p.TERMS).parent.mkdir(parents=True)
                p.save(home / p.TERMS, dict(schemaVersion=1, policyVersion="2026-09-28-v1", acceptedAtMs=1))
                (home / p.PREFERENCES).parent.mkdir(parents=True)
                p.save(home / p.PREFERENCES, dict(schemaVersion=1, preview=True, autoDownload=True, restoreHostedViews=True))
                return dict(root=dict(pid=100), normalCloseObserved=True)
            original_read = p.read
            def fixture_read(file, limit=262144, **kwargs):
                return original_read(file, limit)  # Fixture metadata is not a native POSIX acceptance claim.
            neutral = SimpleNamespace(page_journal=lambda home, previous: {"data": {"revision": 1, "records": []}})
            with mock.patch.object(p, "admission", return_value="fresh16"), mock.patch.object(p.os, "getuid", return_value=1000, create=True), \
                 mock.patch.object(p, "read", side_effect=fixture_read), mock.patch.object(p, "installed"), \
                 mock.patch.object(p, "session", side_effect=observe) as sessions, mock.patch.object(p, "load", return_value=neutral), \
                 mock.patch.object(p, "recheck_request"), mock.patch.object(p, "invoke_broker") as installer:
                with self.assertRaisesRegex(RuntimeError, "owned close outcome unknown"):
                    p.run_session(env)
            self.assertEqual(sessions.call_count, 2)
            installer.assert_not_called()
            report = p.parse(original_read(result / "report.json"))
            self.assertTrue(all(report[k] is False for k in p.FLAGS))
            self.assertEqual(report["error"], "owned close outcome unknown")

    def test_existing_root_install_state_cannot_be_adopted_or_replayed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            occupied = base / "existing"
            occupied.mkdir()
            env = {**environment(), "RUNNER_TEMP": str(base)}
            raw = json.dumps(binding()).encode()
            def inputs(file, *args, **kwargs):
                if str(file).endswith("binding.json"):
                    return raw
                if str(file).endswith("incoming-016-request.json"):
                    return b"{}"
                return b"fixture"
            with mock.patch.object(p, "admission", return_value="fresh16"), mock.patch.object(p, "HERE", Path(env["GITHUB_WORKSPACE"]) / "scripts"), \
                 mock.patch.object(p, "BASE", occupied), mock.patch.object(p.os, "getuid", return_value=0, create=True), \
                 mock.patch.object(p.os, "geteuid", return_value=0, create=True), mock.patch.object(p, "read", side_effect=inputs), \
                 mock.patch.object(p, "check_request"), mock.patch.object(p, "tool") as tools:
                with self.assertRaisesRegex(RuntimeError, "Existing installer state refused"):
                    p.broker(env, "install-first")
            tools.assert_not_called()

    def test_a_second_install_is_never_admitted_in_fresh_lane(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {**environment(), "RUNNER_TEMP": str(Path(temp).resolve())}
            raw = json.dumps(binding()).encode()
            def inputs(file, *args, **kwargs):
                return raw if str(file).endswith("binding.json") else b"{}" if str(file).endswith("incoming-016-request.json") else b"fixture"
            with mock.patch.object(p, "admission", return_value="fresh16"), mock.patch.object(p, "HERE", Path(env["GITHUB_WORKSPACE"]) / "scripts"), \
                 mock.patch.object(p.os, "getuid", return_value=0, create=True), mock.patch.object(p.os, "geteuid", return_value=0, create=True), \
                 mock.patch.object(p, "read", side_effect=inputs), mock.patch.object(p, "check_request"), mock.patch.object(p, "tool") as tools:
                with self.assertRaisesRegex(RuntimeError, "No second install in fresh lane"):
                    p.broker(env, "install16")
            tools.assert_not_called()


class SourceAndWorkflow(unittest.TestCase):
    def test_source_uses_neutral_primitives_not_historical_admission_or_migration(self):
        source = Path(p.__file__).read_text()
        for bad in (".admission(env,", "neutral.run(", "neutral.fixtures(", "configure_candidate(", "inspect-retained-", "[HELPER,", "pkexec", "chpasswd", "shell=True", "os.kill(", ".kill(", "execute_async"):
            self.assertNotIn(bad, source)
        self.assertEqual(source.count('"/execute/sync"'), 1)
        for required in ("P.V.verify(", "P.S.inspect_deb(", "check_request(request", "os.pidfd_open(", "helpers.bound_window(", "native.native_process(", "native.client_ids(x11) == [window]", "normalCloseObserved", "readiness.capture_failure(", "readiness.page_journal("):
            self.assertIn(required, source)
        self.assertIn('save(BASE / (phase + "-started.json")', source)
        self.assertNotIn("unlink(", source)
        self.assertNotIn("rmtree(", source)

    def test_workflow_yaml_js_python_and_bash_parse_and_manual_context_guards(self):
        js = """const fs=require('node:fs'),vm=require('node:vm'),{yaml}=require('playwright-core/lib/utilsBundle');
const doc=yaml.parseDocument(fs.readFileSync(process.argv[1],'utf8'),{uniqueKeys:true});
if(doc.errors.length)throw doc.errors[0]; const value=doc.toJS();
for(const step of value.jobs.incoming.steps)if(step.with?.script)new vm.Script('(async()=>{'+step.with.script+'})');
console.log(JSON.stringify(value));"""
        done = subprocess.run(["node", "-e", js, str(WORKFLOW)], cwd=ROOT, capture_output=True, check=True, timeout=30)
        workflow = json.loads(done.stdout)
        self.assertEqual(workflow["on"]["push"]["branches"], ["validation/native-linux-production-016"])
        inputs = workflow["on"]["workflow_dispatch"]["inputs"]
        self.assertEqual(inputs["scenario"]["options"], list(p.SCENARIOS))
        self.assertIs(inputs["execute_incoming"]["default"], False)
        self.assertEqual(workflow["permissions"], {"contents": "read", "actions": "read"})
        job = workflow["jobs"]["incoming"]
        self.assertEqual(job["runs-on"], "ubuntu-22.04")
        for guard in ("github.event_name == 'workflow_dispatch'", "inputs.execute_incoming == true", p.WORKFLOW):
            self.assertIn(guard, job["if"])
        self.assertNotIn("runner.", json.dumps(job.get("env", {})))
        bash = "C:/Program Files/Git/bin/bash.exe" if sys.platform == "win32" else "/bin/bash"
        for step in job["steps"]:
            if "run" not in step:
                continue
            script = step["run"]
            subprocess.run([bash, "-n"], input=script.encode(), capture_output=True, check=True, timeout=30)
            if "<<'PY'" in script:
                python = script.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
                compile(python, "workflow-export.py", "exec")
        source = WORKFLOW.read_text()
        for bad in ("cargo build", "cargo tauri", "publish", "sign_file", "workflow_run:", "self-hosted", "macos-", "execute_migration"):
            self.assertNotIn(bad, source)
        self.assertIn("cargo install tauri-driver --version 2.1.0 --locked", source)
        self.assertIn("native-linux-production-016-stage.py", source)
        self.assertIn("production.run({github, context, profile})", source)
        for file in (Path(p.__file__), Path(__file__)):
            compile(file.read_text(), str(file), "exec")


if __name__ == "__main__":
    unittest.main()
