"""Pure tests only. No native application, auth, trust-store or package writes."""
import ast
from contextlib import ExitStack, contextmanager
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("production016_update_tested", HERE / "native-linux-production-016-update.py")
M = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = M; SPEC.loader.exec_module(M)


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": M.REPO, "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": M.BRANCH,
            "GITHUB_WORKFLOW_REF": M.WORKFLOW, "GITHUB_EVENT_NAME": "workflow_dispatch", "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "UPDATE_SCENARIO": "deb-approve", "UPDATE_EXECUTE": "true", "UPDATE_PROFILE_SHA256": "a" * 64}


def profile(portable=False):
    # Synthetic unit-only identities, deliberately not historical c13 defaults.
    baseline = {"version": "0.1.16", "source": "d" * 40, "tree": "e" * 40, "run": 501, "job": 502, "artifact": 503,
                "zip": {"size": 504, "sha256": "d" * 64}, "features": M.FEATURES}
    for index, name in enumerate(("raw", "deb", "hub", "archive", "helper", "policy", "service")):
        baseline[name] = {"size": 100 + index, "sha256": str(index) * 64}
    result = {"schemaVersion": 1, "profile": M.PROFILE, "fromVersion": "0.1.16", "toVersion": "0.1.17", "baseline": baseline, "artifacts": {}, "deliveries": {}, "objects": {}}
    for version, branch, workflow in (("16", "validation/linux-integrated-candidate-016", "unix-managed-assembly"),
                                     ("17", "validation/linux-private-update-fixture-017", "private-linux-update-fixture-017")):
        fixed = baseline if version == "16" else M.FIXED[version]
        artifact = {key: copy.deepcopy(fixed[key]) for key in ("source", "tree", "run", "job", "artifact", "zip")}
        artifact.update(branch=branch, workflow=".github/workflows/" + workflow + ".yml", attempt=1, name="assembly" + version,
                        files={"creator-hub": fixed["raw"], "Creator Hub_0.1." + version + "_amd64.deb": fixed["deb"]})
        result["artifacts"]["assembly" + version] = artifact
        result["objects"]["raw" + version] = {"artifact": "assembly" + version, "member": "creator-hub"}
        result["objects"]["deb" + version] = {"artifact": "assembly" + version, "member": "Creator Hub_0.1." + version + "_amd64.deb"}
    result["artifacts"]["assembly16"]["files"]["signed-unix-assembly.json"] = {"size": 100, "sha256": "a" * 64}
    result["objects"]["assemblyReceipt16"] = {"artifact": "assembly16", "member": "signed-unix-assembly.json"}
    def add(role, names, workflow="private-unix-carrier", branch="validation/private-unix-carrier"):
        result["artifacts"][role] = {"source": "b" * 40, "tree": "c" * 40, "run": 200, "attempt": 1, "job": 201, "artifact": 202,
            "name": role, "zip": {"size": 100, "sha256": "c" * 64}, "branch": branch, "workflow": ".github/workflows/" + workflow + ".yml", "files": {}}
        for name in names:
            member = name + ".json"
            result["artifacts"][role]["files"][member] = {"size": 1, "sha256": "f" * 64}
            result["objects"][name] = {"artifact": role, "member": member}
    def delivery(role, names):
        item = {"asset": 658078066 if role == "signedDeb17" else int(role[-2:]),
                "name": M.delivery_name(result, role), "zip": {"size": 64362879, "sha256": "252f14b4b119412d4c0017b18479077c3050228f17725464688545a5fd298a6f"}, "files": {}}
        for name in names:
            member = name + ".json"; item["files"][member] = {"size": 1, "sha256": "f" * 64}
            result["objects"][name] = {"artifact": role, "member": member}
        result["deliveries"][role] = item
    if portable:
        add("portable16", ["appimage16", "archive16", "portableManifest16"], "linux-016-portable-production", "validation/linux-016-portable-production")
        add("portable17", ["archive17", "portableManifest17"], "private-linux-portable-fixture-017", "validation/private-linux-portable-fixture-017")
        delivery("signedPortable16", ["portableDescriptor16", "portableSignature16", "manifestSignature16"])
        delivery("signedPortable17", ["portableDescriptor17", "portableSignature17", "manifestSignature17"])
    else:
        delivery("signedDeb17", ["debDescriptor17", "debSignature17", "latest17"])
    return result


def api(expected):
    run = {"id": expected["run"], "run_attempt": 1, "head_sha": expected["source"], "head_branch": expected["branch"],
           "path": expected["workflow"], "event": "workflow_dispatch", "status": "completed", "conclusion": "success",
           "repository": {"id": 1364807512, "full_name": M.REPO}, "head_repository": {"id": 1364807512, "full_name": M.REPO}}
    return {"run": run, "commit": {"sha": expected["source"], "tree": {"sha": expected["tree"]}},
            "job": {"id": expected["job"], "run_id": expected["run"], "run_attempt": 1, "head_sha": expected["source"], "status": "completed", "conclusion": "success", "labels": ["ubuntu-22.04"]},
            "artifact": {"id": expected["artifact"], "name": expected["name"], "expired": False, "size_in_bytes": expected["zip"]["size"],
                         "digest": "sha256:" + expected["zip"]["sha256"], "workflow_run": {key: run[key] for key in ("id", "head_sha", "head_branch")}}}


def delivery_api(p, env):
    run = {"id": int(env["GITHUB_RUN_ID"]), "run_attempt": 1, "head_sha": env["GITHUB_SHA"], "head_branch": M.BRANCH.removeprefix("refs/heads/"),
           "path": ".github/workflows/native-linux-production-016-update.yml", "event": "workflow_dispatch", "status": "in_progress", "conclusion": None,
           "repository": {"id": 1364807512, "full_name": M.REPO}, "head_repository": {"id": 1364807512, "full_name": M.REPO}}
    assets = {role: {"id": v["asset"], "name": v["name"], "size": v["zip"]["size"], "digest": "sha256:" + v["zip"]["sha256"], "state": "uploaded"} for role, v in p["deliveries"].items()}
    return {"run": run, "job": {"name": "stage-input", "run_id": run["id"], "run_attempt": 1, "head_sha": run["head_sha"],
            "status": "completed", "conclusion": "success", "labels": ["ubuntu-22.04"]},
            "artifact": {"id": 70, "name": "native-linux-production-016-update-inputs-123-1", "expired": False, "size_in_bytes": 100,
            "digest": "sha256:" + "a" * 64, "workflow_run": {k: run[k] for k in ("id", "head_sha", "head_branch")}}}


def manifest(version="17", icons=False):
    files = {"AppRun": b"runner", "usr/bin/creator-hub": b"hub", "usr/libexec/creator-hub-portable-selector": b"selector"}
    directories = ["usr", "usr/bin", "usr/libexec"]
    if icons:
        directories.extend(("usr/share", "usr/share/icons", "usr/share/icons/hicolor",
                            "usr/share/icons/hicolor/256x256@2", "usr/share/icons/hicolor/256x256@2/apps"))
        files["usr/share/icons/hicolor/256x256@2/apps/creator-hub.png"] = b"icon"
    entries = {name: {"kind": "directory", "mode": 0o755} for name in directories}
    entries.update({name: {"kind": "file", "mode": 0o755, **M.pin(body)} for name, body in files.items()})
    body = io.BytesIO()
    with tarfile.open(fileobj=body, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, row in sorted(entries.items()):
            member = tarfile.TarInfo(name); member.mode = row["mode"]
            member.type = tarfile.DIRTYPE if row["kind"] == "directory" else tarfile.REGTYPE
            member.size = len(files.get(name, b"")); tar.addfile(member, io.BytesIO(files[name]) if name in files else None)
    raw = gzip.compress(body.getvalue())
    value = {"schemaVersion": 1, "appId": "creator-hub", "platform": "linux", "architecture": "x86_64", "version": "0.1." + version,
             "sourceCommit": M.FIXED[version]["source"], "sourceTree": M.FIXED[version]["tree"], "format": "appdir-tar-gzip-v1",
             "entrypoint": M.ROOT_ENTRY, "entries": entries, "archive": {**M.pin(raw), "unpackedSize": sum(map(len, files.values()))}}
    return value, raw


def compared_packages():
    baseline = profile()["baseline"]
    helper = "usr/libexec/creator-hub-deb-retirement-helper"
    archive = "usr/lib/Creator Hub/modules.tar.gz"
    policy = "usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy"
    service = "usr/share/dbus-1/services/com.creatorworks.hub.Host.service"
    elf = (b"\x7fELF\x02\x01\x01" + b"\0" * 11 + b"\x3e\x00").hex()
    def member(pin, mode, md5):
        return {"kind": "file", "mode": mode, "uid": 0, "gid": 0, **pin, "md5": md5 * 32, "header": elf}
    old = {"fields": {"Package": "creator-hub", "Version": "0.1.16", "Architecture": "amd64", "Installed-Size": "100", "Depends": "fixed"},
           "files": {M.ROOT_ENTRY: member(baseline["hub"], 0o755, "0"), archive: member(baseline["archive"], 0o644, "1"),
                     helper: member(baseline["helper"], 0o755, "2"), policy: member(baseline["policy"], 0o644, "3"), service: member(baseline["service"], 0o644, "4"),
                     "usr/share/icons/creator-hub.png": member({"size": 50, "sha256": "8" * 64}, 0o644, "8")}}
    new = copy.deepcopy(old); new["fields"].update(Version="0.1.17", **{"Installed-Size": "101"})
    new["files"][M.ROOT_ENTRY] = member(M.FIXED["17"]["hub"], 0o755, "5")
    new["files"][archive] = member(M.FIXED["17"]["archive"], 0o644, "6")
    new["files"][helper] = member({"size": 1167744, "sha256": "501e97da9c93d370caa750c46f4c3f272d546281e8e2eeedfaf4f01193d644be"}, 0o755, "7")
    for package in (old, new): package["md5sums"] = {name: value["md5"] for name, value in package["files"].items()}
    return old, new, baseline


def portable_stage_inputs(folder):
    p = profile(True); old, new, baseline = compared_packages(); p["baseline"] = baseline
    bodies = {name: b"unused fixture member" for name in p["objects"]}
    receipt = {"hubVersion": "0.1.16", "assemblyCommit": baseline["source"], "compiledFeatures": M.FEATURES,
               "portableHostBuild": {"sourceCommit": baseline["source"], "sourceTree": baseline["tree"], "compiledFeatures": M.FEATURES, "rawHub": baseline["raw"]},
               "productionMigration": {"sourceCommit": baseline["source"], "sourceTree": baseline["tree"], "compiledFeatures": M.FEATURES, "rawHub": baseline["raw"]},
               "privateModulesRecompiled": False, "privateModulesResigned": False, "releaseReady": False}
    bodies["assemblyReceipt16"] = json.dumps(receipt).encode()
    for version in ("16", "17"):
        value, tar = manifest()
        value.update(version="0.1." + version, sourceCommit=baseline["source"] if version == "16" else M.FIXED["17"]["source"],
                     sourceTree=baseline["tree"] if version == "16" else M.FIXED["17"]["tree"])
        raw = json.dumps(value).encode()
        descriptor = {"appId": "creator-hub", "version": "0.1." + version, "platform": "linux", "architecture": "x86_64", "packageType": "portable-appdir",
                      "manifest": {"assetName": "creator-hub-linux-x86_64-0.1." + version + ".portable-manifest.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
                      "archive": {"assetName": "creator-hub-linux-x86_64-0.1." + version + ".appdir.tar.gz", "byteLength": len(tar), "sha256": hashlib.sha256(tar).hexdigest()},
                      "executableSha256": value["entries"][M.ROOT_ENTRY]["sha256"], "restartProtocol": 1}
        bodies.update({"portableManifest" + version: raw, "archive" + version: tar, "portableDescriptor" + version: json.dumps(descriptor).encode(),
                       "portableSignature" + version: b"fixture signature", "manifestSignature" + version: b"fixture signature"})
    for role, item in M.input_roles(p).items():
        content = {name: b"unused fixture member" for name in item["files"]}
        for name, ref in p["objects"].items():
            if ref["artifact"] == role: content[ref["member"]] = bodies[name]
        for name, body in content.items(): item["files"][name] = M.pin(body)
        with zipfile.ZipFile(folder / (role + ".zip"), "w") as archive:
            for name, body in content.items(): archive.writestr(name, body)
        item["zip"] = M.pin((folder / (role + ".zip")).read_bytes())
    M.save(folder / "profile.json", p); M.save(folder / "api.json", {})
    return p, old, new


def offline_verifier_inputs(folder):
    pages = M.load("native-linux-integrated-pages")
    workspace = folder / "workspace"; work = folder / "native-linux-production-016-verifier"
    workspace.mkdir(); work.mkdir(mode=0o700); (work / "source").mkdir()
    names = (*M.VERIFIER_PINS, "native/linux-portable-deployment/Cargo.toml", "native/linux-portable-deployment/src/lib.rs")
    inputs = {}
    for name in names:
        raw = (HERE.parent / name).read_bytes().replace(b"\r\n", b"\n")
        if name in M.VERIFIER_PINS:
            if M.pin(raw) != M.VERIFIER_PINS[name]: raise AssertionError("Frozen public verifier input changed")
        original, copied = workspace / name, work / "source" / name
        for file in (original, copied):
            file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(raw)
        inputs[name] = {"pin": M.pin(raw), "originalStamp": list(pages.stamp(original.lstat())), "copyStamp": list(pages.stamp(copied.lstat()))}
    compilers = {}
    for name in ("cargo", "rustc"):
        file = folder / "toolchains/1.99.0-x86_64-unknown-linux-gnu/bin" / name
        file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes((name + " fixture bytes; never executed").encode()); file.chmod(0o755)
        compilers[name] = {"path": str(file), "record": pages.record(file), "stamp": list(pages.stamp(file.lstat())), "version": name + " 1.99.0 (unit-only)"}
    tool = work / "verify-package-input"; tool.write_bytes(b"\x7fELFfixture tool; never executed"); tool.chmod(0o755)
    receipt = {"schemaVersion": 1, "scope": "ci-only-offline-signature-verifier", "harnessSource": "a" * 40, "inputs": inputs,
               "compilers": compilers, "tool": {"pin": M.pin(tool.read_bytes()), "stamp": list(pages.stamp(tool.lstat()))}, "releaseReady": False}
    M.save(work / "receipt.json", receipt)
    return tool, receipt, {**environment(), "RUNNER_TEMP": str(folder), "GITHUB_WORKSPACE": str(workspace)}


class Pure(unittest.TestCase):
    def startup_surface(self, *, guide=True, first=True, closes=True, later_name="Not now", delayed_guide=False, inventory_completes=True, inventory_count=2):
        offered = "before-guide" if delayed_guide else "guide"
        state = SimpleNamespace(phase="terms" if first else offered if guide else "home", actions=[], reads=[], closing_reads=0,
                                offer_reads=0, inventory_reads=0)
        def source(source_id, *, optional=False):
            state.reads.append((state.phase, source_id))
            if source_id == "convergence-later" and state.phase == "before-guide":
                state.offer_reads += 1
                if state.offer_reads == 3:
                    state.phase = "guide"
            visible = ((source_id in ("usage-terms-checkbox", "usage-terms-continue") and state.phase == "terms")
                       or (source_id in ("convergence-dialog", "convergence-later") and state.phase in ("guide", "closing"))
                       or (source_id in ("projects-home-title", "project-status", "refresh-projects")
                           and state.phase in ("before-guide", "home-loading", "home")))
            if source_id == "convergence-dialog" and state.phase == "closing" and closes:
                state.closing_reads += 1
                if state.closing_reads == 2:
                    state.phase = "home-loading"; visible = False
            if source_id == "project-status" and state.phase == "home-loading":
                state.inventory_reads += 1
                if state.inventory_reads == 3 and inventory_completes:
                    state.phase = "home"
            if not visible:
                self.assertTrue(optional, "Unexpected required control lookup")
                return None
            row = {"name": later_name if source_id == "convergence-later" else source_id,
                   "enabled": state.phase == "home", "sensitive": True, "busy": False}
            if source_id == "project-status":
                row["text"] = (f"{inventory_count} known projects. SDK labels reflect package declarations, not build validation."
                               if state.phase == "home" else "Reading known project locations..." if state.phase == "home-loading" else "")
            return (row, None)
        def click(source_id, actions):
            self.assertNotIn(source_id, state.actions)
            self.assertIsNotNone(source(source_id))
            state.actions.append(source_id); actions.append(source_id)
            if source_id == "usage-terms-continue":
                state.phase = offered if guide else "home"
            elif source_id == "convergence-later":
                state.phase = "closing"
        def bounded_wait(check, *args):
            for _ in range(4):
                result = check()
                if result:
                    return result
            raise RuntimeError("Test readiness deadline; no repeated input")
        def snapshot():
            if state.phase == "home-loading":
                state.inventory_reads += 1
                if state.inventory_reads == 3 and inventory_completes:
                    state.phase = "home"
            rows = [] if state.phase != "home" else [{"name": name, "role": 43, "tag": "button", "toolkit": "WebKitGTK",
                    "showing": True, "enabled": True, "sensitive": True, "busy": False, "defunct": False}
                    for name in ("Open selected-project", "Open other-project")]
            return rows, []
        return SimpleNamespace(source=source, click=click, snapshot=snapshot, atspi=SimpleNamespace(Role=SimpleNamespace(PUSH_BUTTON=43))), state, bounded_wait

    def test_startup_defers_observed_modal_once_before_waiting_for_inert_home(self):
        surface, state, waiting = self.startup_surface()
        with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read", return_value=b'{"autoDownload":false}'):
            actions = M.startup_ui(surface, Path("/fixture/home"), first=True)
        self.assertEqual(actions, ["usage-terms-checkbox", "usage-terms-continue", "convergence-later"])
        self.assertEqual(state.actions, actions)
        self.assertEqual(state.closing_reads, 2)
        self.assertFalse(any(phase not in ("home-loading", "home") and name == "projects-home-title" for phase, name in state.reads))
        self.assertEqual(state.phase, "home")
        self.assertEqual(state.inventory_reads, 3)

    def test_startup_does_not_adopt_home_before_delayed_guide_in_either_initial_lane(self):
        for first in (True, False):
            with self.subTest(first=first):
                surface, state, waiting = self.startup_surface(first=first, delayed_guide=True)
                with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read", return_value=b'{"autoDownload":false}'):
                    actions = M.startup_ui(surface, Path("/fixture/home"), first=first)
                expected = (["usage-terms-checkbox", "usage-terms-continue"] if first else []) + ["convergence-later"]
                self.assertEqual(actions, expected); self.assertEqual(state.actions, expected)
                self.assertEqual(state.offer_reads, 3); self.assertEqual(state.closing_reads, 2)
                self.assertEqual(state.phase, "home")
                self.assertFalse(any(phase == "before-guide" and name == "projects-home-title" for phase, name in state.reads))

    def test_startup_stuck_modal_refuses_without_home_lookup_or_second_deferral(self):
        surface, state, waiting = self.startup_surface(first=False, closes=False)
        with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read") as read:
            with self.assertRaisesRegex(RuntimeError, "Test readiness deadline"):
                M.startup_ui(surface, Path("/fixture/home"), first=False)
        self.assertEqual(state.actions, ["convergence-later"])
        self.assertFalse(any(name == "projects-home-title" for _, name in state.reads))
        read.assert_not_called()

    def test_startup_refuses_missing_seeded_offer_in_both_initial_lanes(self):
        for first in (True, False):
            surface, state, waiting = self.startup_surface(first=first, guide=False)
            with self.subTest(first=first), patch.object(M, "wait", side_effect=waiting), patch.object(M, "read", return_value=b'{"autoDownload":false}') as read:
                with self.assertRaisesRegex(RuntimeError, "Test readiness deadline"):
                    M.startup_ui(surface, Path("/fixture/home"), first=first)
            self.assertEqual(state.actions, ["usage-terms-checkbox", "usage-terms-continue"] if first else [])
            read.assert_not_called()

    def test_startup_requires_completed_inventory_after_deferral_not_heading_or_false_busy_alone(self):
        surface, state, waiting = self.startup_surface(first=False, inventory_completes=False)
        with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read", return_value=b'{"autoDownload":false}') as read:
            with self.assertRaisesRegex(RuntimeError, "Test readiness deadline"):
                M.startup_ui(surface, Path("/fixture/home"), first=False)
        self.assertEqual(state.actions, ["convergence-later"])
        self.assertEqual(state.phase, "home-loading")
        read.assert_not_called()

    def test_startup_uses_exact_fixture_open_controls_without_live_region_text_or_filter_changes(self):
        for first in (True, False):
            with self.subTest(first=first):
                surface, state, waiting = self.startup_surface(first=first)
                source = surface.source
                def default_sdk_source(source_id, *, optional=False):
                    self.assertNotIn(source_id, ("project-sdk", "project-status"), "Do not change filters or depend on uncaptured live-region text")
                    return source(source_id, optional=optional)
                surface.source = default_sdk_source
                with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read", return_value=b'{"autoDownload":false}'):
                    actions = M.startup_ui(surface, Path("/fixture/home"), first=first)
                self.assertEqual(actions, (["usage-terms-checkbox", "usage-terms-continue"] if first else []) + ["convergence-later"])
                self.assertEqual(state.actions, actions)
                self.assertEqual(state.phase, "home")

    def test_startup_requires_unique_ready_source_bound_fixture_open_controls_and_refresh(self):
        for case in ("missing", "unrelated", "duplicate", "foreign-toolkit", "wrong-role", "hidden", "disabled", "insensitive", "busy", "defunct", "refresh-disabled"):
            with self.subTest(case=case):
                surface, state, waiting = self.startup_surface(first=False)
                snapshot, source = surface.snapshot, surface.source
                def changed_snapshot():
                    rows, nodes = snapshot()
                    if rows:
                        if case == "missing": rows.pop()
                        elif case == "unrelated": rows[0]["name"] = "Open unrelated-project"
                        elif case == "duplicate": rows.append(dict(rows[0]))
                        elif case == "foreign-toolkit": rows[0]["toolkit"] = "foreign"
                        elif case == "wrong-role": rows[0]["role"] = 29
                        elif case == "hidden": rows[0]["showing"] = False
                        elif case == "disabled": rows[0]["enabled"] = False
                        elif case == "insensitive": rows[0]["sensitive"] = False
                        elif case in ("busy", "defunct"): rows[0][case] = True
                    return rows, nodes
                def changed_source(source_id, **kwargs):
                    value = source(source_id, **kwargs)
                    if case == "refresh-disabled" and source_id == "refresh-projects" and value:
                        value[0]["enabled"] = False
                    return value
                surface.snapshot, surface.source = changed_snapshot, changed_source
                with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read") as read:
                    with self.assertRaisesRegex(RuntimeError, "Test readiness deadline|Duplicate fixture|Fixture project Open control differs"):
                        M.startup_ui(surface, Path("/fixture/home"), first=False)
                self.assertEqual(state.actions, ["convergence-later"])
                read.assert_not_called()

    def test_snapshot_reads_observed_status_role_with_existing_text_bounds_and_protection(self):
        roles = SimpleNamespace(PASSWORD_TEXT=75, LABEL=29, TEXT=61, STATIC=116, PARAGRAPH=73, STATUS_BAR=54)
        states = SimpleNamespace(**{name: name.lower() for name in ("EDITABLE", "SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY", "PRESSED")})
        for case in ("project-status", "hub-update-status", "native-support-status", "no-interface", "editable", "hidden", "oversize", "changed"):
            with self.subTest(case=case):
                body = ("1 known projects. SDK labels reflect package declarations, not build validation."
                        if case == "project-status" else "Version 0.1.17 is available.")
                lengths, calls = [], []
                def count():
                    lengths.append(True)
                    return 4097 if case == "oversize" else len(body) + (1 if case == "changed" and len(lengths) > 1 else 0)
                def text_iface():
                    calls.append(True)
                    return None if case == "no-interface" else SimpleNamespace(get_character_count=count, get_text=lambda start, end: body[start:end])
                state = SimpleNamespace(contains=lambda name: name in ("enabled", "sensitive")
                                        or name == "showing" and case != "hidden" or name == "editable" and case == "editable")
                node = SimpleNamespace(get_role=lambda: 54, get_state_set=lambda: state,
                                       get_attributes=lambda: {"id": case, "tag": "p", "toolkit": "WebKitGTK"},
                                       get_name=lambda: "", get_text_iface=text_iface)
                surface = object.__new__(M.Surface)
                surface.atspi = SimpleNamespace(Role=roles, StateType=states)
                surface.references = SimpleNamespace(identity=lambda n, owner: (":1.4", "/org/a11y/fixture"))
                surface.walk = lambda: [node]
                if case in ("oversize", "changed"):
                    with self.assertRaisesRegex(RuntimeError, "Bounded UI text|UI text changed"):
                        surface.snapshot()
                else:
                    rows, _ = surface.snapshot()
                    if case in ("editable", "hidden"):
                        self.assertNotIn("text", rows[0]); self.assertEqual(calls, [])
                    elif case == "no-interface":
                        self.assertFalse(rows[0]["textInterfaceAvailable"]); self.assertNotIn("text", rows[0])
                    else:
                        self.assertTrue(rows[0]["textInterfaceAvailable"])
                        self.assertEqual(rows[0]["text"], body); self.assertEqual(calls, [True])

    def test_startup_preserves_auto_download_guard_after_reviewed_deferral(self):
        for auto_download in (False, True):
            surface, state, waiting = self.startup_surface(first=False)
            with self.subTest(auto_download=auto_download), patch.object(M, "wait", side_effect=waiting), \
                    patch.object(M, "read", return_value=json.dumps({"autoDownload": auto_download}).encode()):
                if auto_download:
                    with self.assertRaisesRegex(RuntimeError, "Automatic download must remain disabled"):
                        M.startup_ui(surface, Path("/fixture/home"), first=False)
                else:
                    self.assertEqual(M.startup_ui(surface, Path("/fixture/home"), first=False), ["convergence-later"])
            self.assertEqual(state.actions, ["convergence-later"])

    def test_startup_refuses_unreviewed_deferral_label_or_repeated_terms_without_input(self):
        for first, label in ((False, "Continue in Hub"), (True, "Not now")):
            surface, state, waiting = self.startup_surface(first=first, later_name=label)
            with self.subTest(first=first, label=label), patch.object(M, "wait", side_effect=waiting), patch.object(M, "read") as read:
                with self.assertRaisesRegex(RuntimeError, "Accepted native terms unexpectedly repeated" if first else "Unexpected migration/recovery UI"):
                    M.startup_ui(surface, Path("/fixture/home"), first=False)
            self.assertEqual(state.actions, [])
            read.assert_not_called()

    @contextmanager
    def ancestry_diagnostic_fixture(self, change=None):
        names = ("/", "/opt", "/opt/creator-polkit-fixture", "/opt/creator-polkit-fixture/result",
                 "/opt/creator-polkit-fixture/result/home", "/opt/creator-polkit-fixture/result/home/data",
                 "/opt/creator-polkit-fixture/result/home/data/CreatorHub",
                 "/opt/creator-polkit-fixture/result/home/data/CreatorHub/hub-portable-updates",
                 "/opt/creator-polkit-fixture/result/home/data/creator-hub-portable",
                 "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache",
                 "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache/portable",
                 "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache/portable/records",
                 "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache/deb",
                 "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache/deb/records")
        nodes = {name: SimpleNamespace(st_dev=1, st_ino=index + 1,
                                       st_mode=stat.S_IFDIR | (0o700 if index >= 9 else 0o777 if index in (6, 7) else 0o755),
                                      st_uid=0 if index < 3 else M.UID, st_gid=0 if index < 3 else M.UID,
                                      st_nlink=1, st_size=0, st_mtime_ns=1, st_ctime_ns=1) for index, name in enumerate(names)}
        creator, private_cache = names[6], names[9]
        if change == "link": nodes[creator].st_mode = stat.S_IFLNK | 0o777
        if change == "missing": del nodes[creator]
        if change == "new-link": nodes[private_cache].st_mode = stat.S_IFLNK | 0o777
        if change == "new-missing": del nodes[private_cache]
        handles, opened, counts = {}, [], {}
        def named(name, *, dir_fd=None, follow_symlinks):
            self.assertFalse(follow_symlinks)
            path = name if dir_fd is None else handles[dir_fd].rstrip("/") + "/" + name
            counts[path] = counts.get(path, 0) + 1
            if path not in nodes: raise FileNotFoundError(path)
            value = copy.copy(nodes[path])
            if change == "replaced" and path == "/" and counts[path] > 1: value.st_ino += 100
            if change == "new-replaced" and path == private_cache and counts[path] > 1: value.st_ino += 100
            return value
        def open_dir(name, flags, *, dir_fd=None):
            self.assertEqual(flags, M.os.O_RDONLY | M.os.O_DIRECTORY | M.os.O_NOFOLLOW | M.os.O_CLOEXEC)
            path = name if dir_fd is None else handles[dir_fd].rstrip("/") + "/" + name
            self.assertTrue(stat.S_ISDIR(nodes[path].st_mode)); opened.append(path)
            fd = 10000 + len(opened); handles[fd] = path; return fd
        def held(fd):
            value = copy.copy(nodes[handles[fd]])
            if change == "new-open-replaced" and handles[fd] == private_cache: value.st_ino += 100
            return value
        with ExitStack() as stack:
            for name, value in (("O_DIRECTORY", 0x100000), ("O_NOFOLLOW", 0x200000), ("O_CLOEXEC", 0x400000)):
                stack.enter_context(patch.object(M.os, name, value, create=True))
            stack.enter_context(patch.object(M.os, "stat", side_effect=named))
            stack.enter_context(patch.object(M.os, "open", side_effect=open_dir))
            stack.enter_context(patch.object(M.os, "fstat", side_effect=held))
            stack.enter_context(patch.object(M.os, "close", side_effect=lambda fd: handles.pop(fd)))
            stack.enter_context(patch.object(M.os, "readlink", side_effect=AssertionError("No link targets may be read")))
            for name in ("chmod", "chown", "umask", "mkdir", "makedirs"):
                stack.enter_context(patch.object(M.os, name, side_effect=AssertionError("Diagnostics cannot create directories or modify permissions"), create=True))
            yield nodes, opened
        self.assertEqual(handles, {}, "Diagnostic directory FDs leaked")

    def test_portable_ancestry_captures_exact_mode_uid_inode_chains_without_permission_changes(self):
        with self.ancestry_diagnostic_fixture() as (nodes, opened):
            before = copy.deepcopy(nodes)
            result = M.portable_ancestry_metadata()
            self.assertEqual(nodes, before)
        self.assertEqual([row["path"] for row in result], list(nodes))
        self.assertEqual(opened, list(nodes))
        self.assertEqual(len(result), 14)
        cache = next(row for row in result if row["path"].endswith("hub-portable-updates"))
        self.assertEqual(cache["mode"], "0777")
        self.assertEqual(set(cache), {"path", "present", "directory", "uid", "gid", "mode", "dev", "ino"})
        for row in result[9:]:
            self.assertEqual(row["mode"], "0700")
            self.assertEqual((row["uid"], row["gid"]), (M.UID, M.UID))
            self.assertEqual(set(row), set(cache))

    def test_portable_ancestry_does_not_follow_missing_linked_or_replaced_ancestors(self):
        for change in ("missing", "link", "replaced"):
            with self.subTest(change=change), self.ancestry_diagnostic_fixture(change) as (_, opened):
                if change == "replaced":
                    with self.assertRaisesRegex(RuntimeError, "identity changed"):
                        M.portable_ancestry_metadata()
                else:
                    result = M.portable_ancestry_metadata()
                    cache = next(row for row in result if row["path"].endswith("hub-portable-updates"))
                    self.assertEqual(cache["unavailable"], "AncestorNotDirectory")
                    self.assertFalse(any(path.endswith("hub-portable-updates") for path in opened))
                    self.assertTrue(all(row["mode"] == "0700" for row in result[9:]))

    def test_portable_ancestry_missing_new_cache_is_observed_without_creation_or_scope_promotion(self):
        with self.ancestry_diagnostic_fixture("new-missing") as (nodes, opened), \
                patch.object(M, "owned_process_umask", return_value={"pid": 42, "startTime": "7", "umask": "0002"}), patch.object(M, "save"):
            before = copy.deepcopy(nodes)
            result = M.capture_portable_ancestry("before-launch", {}, None, None)
            self.assertEqual(nodes, before)
        rows = result["entries"]
        self.assertEqual(len(rows), 14)
        self.assertEqual(rows[9], {"path": "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache", "present": False})
        self.assertTrue(all(row["unavailable"] == "AncestorNotDirectory" for row in rows[10:]))
        self.assertFalse(any("/creator-hub-update-cache" in path for path in opened))
        self.assertTrue(result["readOnly"]); self.assertFalse(result["qualified"])
        self.assertTrue(all(result[name] is False for name in M.FALSE))
        self.assertLessEqual(len(json.dumps(result).encode()), 8192)

    def test_portable_ancestry_new_cache_links_and_replacements_are_not_followed_or_adopted(self):
        for change in ("new-link", "new-replaced", "new-open-replaced"):
            with self.subTest(change=change), self.ancestry_diagnostic_fixture(change) as (nodes, opened):
                before = copy.deepcopy(nodes)
                if change == "new-link":
                    result = M.portable_ancestry_metadata()
                    self.assertFalse(result[9]["directory"])
                    self.assertTrue(all(row["unavailable"] == "AncestorNotDirectory" for row in result[10:]))
                    self.assertFalse(any("/creator-hub-update-cache" in path for path in opened))
                else:
                    with self.assertRaisesRegex(RuntimeError, "changed"):
                        M.portable_ancestry_metadata()
                    if change == "new-open-replaced":
                        self.assertFalse(any(path.endswith("creator-hub-update-cache/portable") for path in opened))
                self.assertEqual(nodes, before)

    def test_owned_process_umask_reads_only_bounded_status_and_rechecks_identity(self):
        process = {"pid": 42, "startTime": "7", "uids": [M.UID] * 4}
        for case in ("valid", "missing", "duplicate", "oversize", "reused", "replaced"):
            raw = b"Name:\tDO-NOT-RETAIN\nUmask:\t0002\n"
            if case == "missing": raw = b"Name:\tDO-NOT-RETAIN\n"
            if case == "duplicate": raw += b"Umask:\t0022\n"
            if case == "oversize": raw += b"x" * 16385
            chunks = [raw[:4], raw[4:], b""]
            info = SimpleNamespace(st_dev=1, st_ino=1, st_mode=stat.S_IFREG | 0o444, st_uid=M.UID, st_gid=M.UID,
                                   st_nlink=1, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
            replacement = copy.copy(info); replacement.st_ino = 2
            def open_status(path, flags):
                self.assertEqual(path.as_posix(), "/proc/42/status")
                self.assertEqual(flags, M.os.O_RDONLY | M.os.O_NOFOLLOW | M.os.O_NONBLOCK | M.os.O_CLOEXEC)
                return 10000
            with self.subTest(case=case), ExitStack() as stack:
                for name, value in (("O_NOFOLLOW", 0x100000), ("O_NONBLOCK", 0x200000), ("O_CLOEXEC", 0x400000)):
                    stack.enter_context(patch.object(M.os, name, value, create=True))
                stack.enter_context(patch.object(M, "kernel_record", side_effect=[process, {**process, "startTime": "8"}] if case == "reused" else None, return_value=process))
                stack.enter_context(patch.object(Path, "lstat", side_effect=[info, replacement] if case == "replaced" else None, return_value=info))
                stack.enter_context(patch.object(M.os, "open", side_effect=open_status))
                stack.enter_context(patch.object(M.os, "fstat", return_value=info))
                def read_status(fd, limit):
                    self.assertEqual(fd, 10000); self.assertLessEqual(limit, 16385)
                    value = chunks.pop(0); part, rest = value[:limit], value[limit:]
                    if rest: chunks.insert(0, rest)
                    return part
                stack.enter_context(patch.object(M.os, "read", side_effect=read_status))
                closed = stack.enter_context(patch.object(M.os, "close"))
                if case == "valid":
                    result = M.owned_process_umask(process, None, None)
                    self.assertEqual(result, {"pid": 42, "startTime": "7", "umask": "0002"})
                    self.assertNotIn("DO-NOT-RETAIN", json.dumps(result))
                else:
                    with self.assertRaises(RuntimeError): M.owned_process_umask(process, None, None)
                closed.assert_called_once_with(10000)

    def test_portable_ancestry_diagnostic_is_independent_false_and_cannot_mask_failure(self):
        with patch.object(M, "portable_ancestry_metadata", side_effect=PermissionError("DO-NOT-RETAIN")), \
                patch.object(M, "owned_process_umask", return_value={"pid": 42, "startTime": "7", "umask": "0002"}), patch.object(M, "save", side_effect=FileExistsError):
            result = M.capture_portable_ancestry("after-refusal", {}, None, None)
        self.assertEqual(result["ancestryUnavailable"], "PermissionError")
        self.assertEqual(result["process"]["umask"], "0002")
        self.assertTrue(result["readOnly"]); self.assertFalse(result["qualified"])
        self.assertTrue(all(result[name] is False for name in M.FALSE))
        self.assertNotIn("DO-NOT-RETAIN", json.dumps(result))
        with patch.object(M, "portable_ancestry_metadata", return_value=[]), patch.object(M, "owned_process_umask", side_effect=RuntimeError("secret")), patch.object(M, "save") as save:
            result = M.capture_portable_ancestry("before-launch", {}, None, None)
        self.assertEqual(result["processUnavailable"], "RuntimeError")
        save.assert_called_once_with(M.BASE / "result/portable-ancestry-before-launch.json", result)

    def test_portable_ancestry_capture_hooks_and_export_are_fixed_and_after_refusal_has_owned_root(self):
        tree = ast.parse(Path(M.__file__).read_text())
        session = ast.unparse(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session"))
        self.assertLess(session.index("capture_portable_ancestry('before-launch', parent, native, helper)"), session.index("bootstrap16("))
        exporter = ast.unparse(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "export_evidence"))
        for name in ("before-launch", "after-refusal"):
            self.assertIn("result/portable-ancestry-" + name + ".json", exporter)
        surface = SimpleNamespace(record={"pid": 42}, native=object(), helper=object(), snapshot=lambda: ([], []))
        with patch.object(M, "capture_portable_ancestry") as capture, patch.object(M, "phase_bitmap"), patch.object(M, "save"):
            M.capture_bootstrap_failure(surface, [])
        capture.assert_called_once_with("after-refusal", surface.record, surface.native, surface.helper)

    @unittest.skipUnless(os.name == "posix", "Real directory FDs and proc status require Unix")
    def test_unix_portable_ancestry_held_fd_capture_preserves_writable_fixture_mode_and_reads_own_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cache = root / "opt/creator-polkit-fixture/result/home/data/CreatorHub/hub-portable-updates"
            cache.mkdir(parents=True); cache.chmod(0o775)
            original_open, original_stat = os.open, os.stat
            def opened(name, flags, **kwargs):
                return original_open(root if name == "/" else name, flags, **kwargs)
            def named(name, **kwargs):
                return original_stat(root if name == "/" else name, **kwargs)
            with patch.object(M.os, "open", side_effect=opened), patch.object(M.os, "stat", side_effect=named):
                absent = M.portable_ancestry_metadata()
            private_cache = root / "opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache"
            self.assertFalse(private_cache.exists())
            self.assertEqual(absent[9], {"path": "/opt/creator-polkit-fixture/result/home/data/creator-hub-update-cache", "present": False})
            for name in ("", "portable", "portable/records", "deb", "deb/records"):
                (private_cache / name).mkdir(mode=0o700)
            with patch.object(M.os, "open", side_effect=opened), patch.object(M.os, "stat", side_effect=named):
                result = M.portable_ancestry_metadata()
            self.assertEqual(len(result), 14)
            self.assertTrue(all(row["mode"] == "0700" for row in result[9:]))
            self.assertEqual(next(row for row in result if row["path"].endswith("hub-portable-updates"))["mode"], "0775")
            self.assertEqual(stat.S_IMODE(cache.stat().st_mode), 0o775)
            self.assertFalse((private_cache.parent / "creator-hub-portable").exists())
            process = {"pid": os.getpid(), "startTime": "unit", "uids": [os.getuid()] * 4}
            with patch.object(M, "UID", os.getuid()), patch.object(M, "kernel_record", return_value=process):
                self.assertRegex(M.owned_process_umask(process, None, None)["umask"], r"^[0-7]{4}$")

    def test_bootstrap_failure_capture_is_owned_bounded_and_independent_without_new_input(self):
        rows = [{"id": "native-support-status", "text": "Synthetic download refused", "showing": True}]
        for snapshot_fails, bitmap_fails in ((False, False), (True, False), (False, True)):
            surface = SimpleNamespace(record={"pid": 17}, snapshot=lambda: (rows, []))
            if snapshot_fails:
                surface.snapshot = lambda: (_ for _ in ()).throw(RuntimeError("DO-NOT-RETAIN"))
            with self.subTest(snapshot_fails=snapshot_fails, bitmap_fails=bitmap_fails), \
                    patch.object(M, "phase_bitmap", side_effect=RuntimeError("DO-NOT-RETAIN") if bitmap_fails else None,
                                 return_value={"nonblank": True, "windowOnly": True}) as bitmap, patch.object(M, "save") as save:
                result = M.capture_bootstrap_failure(surface, ["usage-terms-checkbox", "usage-terms-continue", "native-support-install"])
            bitmap.assert_called_once_with(surface, "bootstrap-failure-bitmap")
            self.assertTrue(result["readOnly"]); self.assertFalse(result["qualified"])
            self.assertEqual(result["actions"].count("native-support-install"), 1)
            self.assertNotIn("DO-NOT-RETAIN", json.dumps(result))
            if not snapshot_fails:
                self.assertEqual(result["snapshot"], rows)
            save.assert_called_once_with(M.BASE / "result/bootstrap-failure-ui.json", result)
        with patch.object(M, "phase_bitmap", side_effect=RuntimeError("unavailable")), patch.object(M, "save", side_effect=FileExistsError):
            M.capture_bootstrap_failure(SimpleNamespace(record={}, snapshot=lambda: ([], [])), [])

    def test_bootstrap_dialog_deadline_captures_local_surface_and_preserves_original_error(self):
        for diagnostic_fails in (False, True):
            actions = []
            root = {"pid": 42, "uids": [M.UID] * 4, "executable": "/fixture/AppDir/usr/bin/creator-hub", "kernelImageSha256": "a" * 64}
            surface = SimpleNamespace(source=lambda *a, **k: ({}, None), click=lambda name, supplied: (actions.append(name), supplied.append(name)))
            original = RuntimeError("Original native dialog readiness deadline")
            review = {"portable": {"16": {"manifest": {"entries": {M.ROOT_ENTRY: {"sha256": "a" * 64}}}}}}
            with self.subTest(diagnostic_fails=diagnostic_fails), patch.object(M, "object_path", return_value=Path("/fixture/source")), \
                    patch.object(M, "object_pin", return_value={}), patch.object(M, "bound"), \
                    patch.object(M.subprocess, "Popen", return_value=SimpleNamespace(pid=42, poll=lambda: None)), \
                    patch.object(M, "kernel_record", return_value=root), patch.object(M, "children", return_value=[]), \
                    patch.object(M, "wait", side_effect=lambda check, *a: check()), \
                    patch.object(M, "Surface", side_effect=[surface, original]) as surfaces, \
                    patch.object(M, "capture_bootstrap_failure", side_effect=PermissionError("diagnostic refused") if diagnostic_fails else None) as capture:
                with self.assertRaises(RuntimeError) as failure:
                    M.bootstrap16(Path("/fixture"), {}, review, {"HOME": "/fixture/home"}, None, None, None, None)
            self.assertIs(failure.exception, original)
            self.assertEqual(actions, ["usage-terms-checkbox", "usage-terms-continue", "native-support-install"])
            self.assertEqual(surfaces.call_count, 2)
            self.assertEqual(surfaces.call_args.kwargs["title"], "Install native support")
            capture.assert_called_once_with(surface, actions)

    def transport_diagnostic_fixture(self, portable=True):
        input_profile = profile(portable)
        scenario = "portable-native-cancel" if portable else "deb-native-cancel"
        files = {name: M.object_pin(input_profile, role) for name, role in M.transport_files(input_profile, scenario).items()}
        mode = "portable" if portable else "deb"
        value = {"schemaVersion": 1, "scope": "linux-" + mode + "-production016-to-private017-lab-transport", "mode": mode,
                 "fromVersion": "0.1.16", "targetVersion": "0.1.17", "labDiscovery": True,
                 **dict.fromkeys(("publicDiscovery", "nativeAcceptanceTested", "baselineActuallyTested", "signaturesVerifiedByHarness",
                                  "signedUpdateAccepted", "migrationAccepted", "restartAccepted", "restoredViewsAccepted", "liveAiAcceptance", "releaseReady"), False),
                 "pins": files, "connectionCount": 1, "requestCount": 1, "receivedHttpBytes": 128,
                 "reservedResponseBytes": 256, "rejectedRequestCount": 0, "closeReason": "caller", "requests": []}
        return value, {"files": files}, scenario

    def test_closed_transport_diagnostic_keeps_partial_known_requests_without_claiming_acceptance(self):
        value, pins, scenario = self.transport_diagnostic_fixture()
        member = next(iter(pins["files"]))
        directory, name = member.split("/", 1)
        value["requests"] = [{"host": "github.com", "path": "/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/" + name,
                              "sha256": pins["files"][member]["sha256"]}]
        original = copy.deepcopy(value)
        result = M.closed_transport_diagnostic(value, pins, scenario)
        self.assertEqual(result["requests"], value["requests"])
        self.assertTrue(result["readOnly"]); self.assertFalse(result["qualified"])
        self.assertNotIn("pins", result); self.assertEqual(value, original)
        with self.assertRaises(RuntimeError):
            M.validate_transport_report(value, pins, scenario)
        tree = ast.parse(Path(M.__file__).read_text())
        exporter = ast.unparse(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "export_evidence"))
        for name in ("result/bootstrap-failure-ui.json", "result/bootstrap-failure-bitmap/root-window.png", "result/transport-diagnostic.json"):
            self.assertIn(name, exporter)

    def test_closed_transport_diagnostic_refuses_secrets_foreign_routes_changed_pins_and_bounds(self):
        for mutate in (lambda v: v.update(key="DO-NOT-RETAIN"), lambda v: v.update(closeReason="DO-NOT-RETAIN"),
                       lambda v: v.update(requestCount=True), lambda v: v.update(connectionCount=2**40),
                       lambda v: v.update(requests=[{"host": "foreign", "path": "/secret", "sha256": "a" * 64}]),
                       lambda v: v.update(requests=[{"host": "api.github.com", "path": "/secret", "sha256": "a" * 64}]),
                       lambda v: v.update(requests=[{"host": "api.github.com", "path": "/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10", "sha256": "a" * 64}] * 12),
                       lambda v: v.update(pins={})):
            value, pins, scenario = self.transport_diagnostic_fixture()
            mutate(value)
            with self.assertRaises(RuntimeError):
                M.closed_transport_diagnostic(value, pins, scenario)

    def public_tool_failure(self, argv, *, output=b"installer output\n", error=b"dependency failure\n", code=1, **kwargs):
        def child(actual, **options):
            self.assertEqual(actual, argv)
            options["stdout"].write(output); options["stderr"].write(error)
            return SimpleNamespace(returncode=code)
        with patch.object(M.subprocess, "run", side_effect=child), patch("builtins.print") as printed:
            with self.assertRaises(RuntimeError) as failure:
                M.run_tool(argv, **kwargs)
        return failure.exception, [json.loads(call.args[0]) for call in printed.call_args_list]

    def test_exact_baseline_install_failure_captures_public_output_without_argv_or_context(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            command = ["/usr/bin/dpkg", "--install", str(M.BASE / "inputs/members/assembly16/native-packages/Creator Hub_0.1.16_amd64.deb")]
            failure, logs = self.public_tool_failure(command)
            self.assertEqual(str(failure), "Fixed tool failed: dpkg")
            self.assertEqual(len(logs), 1)
            evidence = logs[0]
            self.assertEqual(evidence["tool"], "baseline-dpkg-install")
            self.assertEqual(evidence["returncode"], 1)
            self.assertEqual(evidence["failureType"], "NonzeroExit")
            self.assertEqual(evidence["stderr"], {"bytes": 19, "truncated": False, "text": "dependency failure\n"})
            self.assertEqual(evidence["stdout"]["text"], "installer output\n")
            self.assertNotIn("argv", evidence); self.assertNotIn("env", evidence); self.assertNotIn("stdin", evidence)
            files = list(M.BASE.glob("public-tool-failure-*.json")); self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text()), evidence)

    def test_public_ca_failure_is_bounded_and_overflow_keeps_original_refusal(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            failure, logs = self.public_tool_failure(["/usr/sbin/update-ca-certificates"], output=b"o" * 10000, error=b"e" * 65537)
            self.assertEqual(str(failure), "Bounded tool diagnostics exceeded")
            self.assertEqual(logs[0]["failureType"], "DiagnosticLimitExceeded")
            for stream, size in (("stdout", 10000), ("stderr", 65537)):
                self.assertEqual(logs[0][stream]["bytes"], size)
                self.assertTrue(logs[0][stream]["truncated"])
                self.assertEqual(len(logs[0][stream]["text"]), 8192)
            self.assertEqual(logs[0]["tool"], "update-ca-certificates")

    def test_other_tools_input_environment_and_foreign_install_paths_never_capture_output(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            for command, kwargs in ((["/usr/bin/passwd", "--stdin", M.USER], {"input": b"private"}),
                                    (["/usr/bin/dpkg", "--install", "/foreign.deb"], {}),
                                    (["/usr/sbin/update-ca-certificates", "--fresh"], {}),
                                    (["/usr/sbin/update-ca-certificates"], {"input": b"private"}),
                                    (["/usr/sbin/update-ca-certificates"], {"env": {"PRIVATE": "secret"}})):
                with self.subTest(command=command, options=tuple(kwargs)):
                    _, logs = self.public_tool_failure(command, output=b"secret stdout", error=b"secret stderr", **kwargs)
                    self.assertFalse(logs)
            self.assertFalse(list(M.BASE.iterdir()))

    def test_public_tool_timeout_and_existing_evidence_preserve_original_error(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            command = ["/usr/sbin/update-ca-certificates"]
            original = subprocess.TimeoutExpired(command, 90)
            def child(actual, **options):
                options["stderr"].write(b"bounded timeout detail")
                raise original
            with patch.object(M.subprocess, "run", side_effect=child), patch("builtins.print") as printed:
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    M.run_tool(command)
            self.assertIs(caught.exception, original)
            evidence = json.loads(printed.call_args_list[0].args[0])
            self.assertEqual(evidence["failureType"], "TimeoutExpired")
            self.assertIsNone(evidence["returncode"])
            self.assertEqual(evidence["stderr"]["text"], "bounded timeout detail")
            file = next(M.BASE.glob("public-tool-failure-*.json")); before = file.read_bytes()
            failure, _ = self.public_tool_failure(command)
            self.assertEqual(str(failure), "Fixed tool failed: update-ca-certificates")
            self.assertEqual(file.read_bytes(), before)

    def test_public_tool_success_emits_no_diagnostic_and_export_is_finite(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            def child(argv, **options):
                options["stdout"].write(b"success")
                return SimpleNamespace(returncode=0)
            with patch.object(M.subprocess, "run", side_effect=child), patch("builtins.print") as printed:
                self.assertEqual(M.run_tool(["/usr/sbin/update-ca-certificates"]), b"success")
            printed.assert_not_called(); self.assertFalse(list(M.BASE.iterdir()))
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        exporter = ast.unparse(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "export_evidence"))
        self.assertIn("public-tool-failure-", exporter)
        self.assertIn("baseline-dpkg-install|update-ca-certificates", exporter)
        self.assertIn("len(diagnostics) <= 8", exporter)
        self.assertIn("tls-restore-failure-", exporter)
        broker = ast.unparse(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "broker"))
        self.assertIn("record['tlsCleanupError']", broker)
        self.assertIn("'type': type(error).__name__", broker)

    def test_exact_dpkg_and_ca_commands_get_fixed_root_path_without_losing_failure_capture(self):
        source = (HERE.parent / "src-tauri/src/linux_update.rs").read_text()
        self.assertEqual(re.search(r'\.env\("PATH",\s*"([^"]+)"\)', source)[1], M.ROOT_TOOL_PATH)
        self.assertEqual(M.ROOT_TOOL_PATH, "/usr/sbin:/usr/bin:/sbin:/bin")
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            commands = (["/usr/bin/dpkg", "--install", str(M.BASE / "inputs/members/assembly16/native-packages/Creator Hub_0.1.16_amd64.deb")],
                        ["/usr/sbin/update-ca-certificates"])
            for command in commands:
                with self.subTest(command=command):
                    def child(actual, **options):
                        self.assertEqual(actual, command)
                        if options["env"] != {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}:
                            options["stderr"].write(b"dpkg: error: 2 expected programs not found in PATH or not executable\n"
                                                    if actual[0] == "/usr/bin/dpkg" else b"test CA updater: required root helper PATH missing\n")
                            return SimpleNamespace(returncode=2)
                        return SimpleNamespace(returncode=0)
                    with patch.object(M.subprocess, "run", side_effect=child), patch.dict(os.environ, {"PATH": "/foreign", "PRIVATE": "not inherited"}):
                        self.assertEqual(M.run_tool(command), b"")
                    failure, logs = self.public_tool_failure(command, code=2, error=b"public failure retained\n")
                    self.assertIn("Fixed tool failed:", str(failure))
                    self.assertEqual(logs[0]["returncode"], 2)
                    self.assertEqual(logs[0]["stderr"]["text"], "public failure retained\n")

    def test_root_path_is_not_given_to_other_commands_or_supplied_input_environment(self):
        for command, kwargs in ((["/usr/bin/dpkg", "--verify", "creator-hub"], {}),
                                (["/usr/bin/dpkg", "--install", "/foreign.deb"], {}),
                                (["/usr/sbin/update-ca-certificates", "--fresh"], {}),
                                (["/usr/bin/openssl", "version"], {}),
                                (["/usr/sbin/update-ca-certificates"], {"input": b"not a public invocation"}),
                                (["/usr/sbin/update-ca-certificates"], {"env": {"PATH": "/explicit", "LANG": "C"}})):
            with self.subTest(command=command, options=tuple(kwargs)):
                def child(actual, **options):
                    self.assertEqual(options["env"], kwargs.get("env") or {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
                    return SimpleNamespace(returncode=0)
                with patch.object(M.subprocess, "run", side_effect=child):
                    M.run_tool(command, **kwargs)

    def test_native_home_mismatch_reports_only_four_approved_synthetic_paths_before_same_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); home = base / "result/home"; account = base / "synthetic-account"
            expected = {key: str(home / leaf) for key, leaf in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items()}
            env = {**expected, "HOME": str(account), "UNRELATED_SECRET": "NEVER-EXPORT"}; original = dict(env)
            path_type = M.Path
            def path(value): return account if value == "/var/lib/creator-polkit-fixture" else path_type(value)
            with patch.object(M, "BASE", base), patch.object(M, "Path", side_effect=path), patch.object(M, "admission", return_value="deb-native-cancel"), \
                 patch.object(M.os, "getuid", return_value=M.UID, create=True), patch.object(M.os, "geteuid", return_value=M.UID, create=True), \
                 patch.object(M, "read", side_effect=AssertionError("No request or UI read before the home guard")) as read, patch("builtins.print") as printed:
                with self.assertRaisesRegex(RuntimeError, "^Exact isolated native home required$"):
                    M.native_session(env)
            self.assertEqual(env, original); read.assert_not_called(); self.assertEqual(printed.call_count, 1)
            call = printed.call_args; self.assertEqual(call.kwargs, {"flush": True}); raw = call.args[0]; evidence = json.loads(raw)
            self.assertLessEqual(len(raw.encode()), 4096); self.assertEqual(evidence["kind"], "production016-native-home-mismatch")
            self.assertEqual(set(evidence["paths"]), set(expected)); self.assertNotIn("UNRELATED_SECRET", raw); self.assertNotIn("NEVER-EXPORT", raw)
            for key, row in evidence["paths"].items():
                self.assertEqual(row["expected"], expected[key]); self.assertEqual(row["actual"], {"present": True, "path": env[key]})

    def test_native_home_mismatch_redacts_outside_noncanonical_missing_and_oversize_values_without_env_dump(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); home = base / "result/home"
            for oversized in (False, True):
                env = {"HOME": str(base / ("x" * 5000)) if oversized else "/home/REAL_ACCOUNT_PRIVATE_SENTINEL",
                       "XDG_CONFIG_HOME": str(home / ".." / "foreign"), "XDG_DATA_HOME": str(base) + "-foreign/private"}
                with self.subTest(oversized=oversized), patch.object(M, "BASE", base), \
                     patch.object(M.Path, "resolve", side_effect=AssertionError("Do not resolve outside/noncanonical/oversized paths")), patch("builtins.print") as printed:
                    M.native_home_guard_diagnostic(env, home)
                raw = printed.call_args.args[0]; evidence = json.loads(raw)
                self.assertLessEqual(len(raw.encode()), 4096); self.assertNotIn("REAL_ACCOUNT_PRIVATE_SENTINEL", raw); self.assertNotIn("x" * 100, raw)
                for key, row in evidence["paths"].items():
                    actual = row["actual"]
                    self.assertEqual(actual["present"], key in env)
                    if key in env:
                        self.assertEqual(actual, {"present": True, "redacted": True, "sha256": hashlib.sha256(os.fsencode(env[key])).hexdigest()})
                    else:
                        self.assertEqual(actual, {"present": False})

    def test_native_home_guard_success_stays_silent_and_failed_diagnostic_cannot_change_refusal(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); home = base / "result/home"
            env = {key: str(home / leaf) for key, leaf in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items()}
            with patch.object(M, "BASE", base), patch.object(M, "admission", return_value="deb-native-cancel"), \
                 patch.object(M.os, "getuid", return_value=M.UID, create=True), patch.object(M.os, "geteuid", return_value=M.UID, create=True), \
                 patch.object(M, "read", side_effect=RuntimeError("stopped after unchanged home guard")), patch("builtins.print") as printed:
                with self.assertRaisesRegex(RuntimeError, "stopped after unchanged home guard"):
                    M.native_session(env)
                printed.assert_not_called()
                env["HOME"] = ""
                printed.side_effect = OSError("diagnostic stdout unavailable")
                with self.assertRaisesRegex(RuntimeError, "^Exact isolated native home required$"):
                    M.native_session(env)

    def test_final_session_env_restores_observed_runner_config_drift_and_preserves_pam_bus_display(self):
        context = {**environment(), "GITHUB_WORKSPACE": str(HERE.parent), "RUNNER_TEMP": "/runner/temp", "CONTROLLER_NODE": "/usr/bin/node"}
        command = M.system_session_command(context)
        actual = dict(value[len("--setenv="):].split("=", 1) for value in command if value.startswith("--setenv="))
        home = M.BASE / "result/home"
        expected = {key: str(home / leaf) for key, leaf in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items()}
        actual.update(XDG_CONFIG_HOME="/home/runner/.config", XDG_SESSION_ID="fixture-session", XDG_RUNTIME_DIR="/run/user/21314",
                      DBUS_SESSION_BUS_ADDRESS="unix:path=/fixture/session-bus", DISPLAY=":99", XAUTHORITY="/fixture/xauthority")
        self.assertEqual(hashlib.sha256(actual["XDG_CONFIG_HOME"].encode()).hexdigest(), "e2ff4a7c39c2d65a96232a967bd04842c9fedf27daddc7680b06afa98c1702ca")
        self.assertEqual({key: value for key, value in actual.items() if key in expected and key != "XDG_CONFIG_HOME"},
                         {key: value for key, value in expected.items() if key != "XDG_CONFIG_HOME"})
        untouched = {key: value for key, value in actual.items() if key not in expected}
        if "/usr/bin/env" in command:
            stage = command[command.index("/usr/bin/env") + 1:command.index("/usr/bin/python3")]
            actual.update(dict(value.split("=", 1) for value in stage))
        with patch.object(M, "admission", return_value="deb-native-cancel"), \
             patch.object(M.os, "getuid", return_value=M.UID, create=True), patch.object(M.os, "geteuid", return_value=M.UID, create=True), \
             patch.object(M, "read", side_effect=RuntimeError("stopped at original sealed request read")) as read, patch("builtins.print"):
            with self.assertRaisesRegex(RuntimeError, "^stopped at original sealed request read$"):
                M.native_session(actual)
            self.assertEqual({key: actual[key] for key in expected}, expected)
            self.assertEqual({key: value for key, value in actual.items() if key not in expected}, untouched)
            read.reset_mock(); actual["XDG_CONFIG_HOME"] = "/late/foreign/config"
            with self.assertRaisesRegex(RuntimeError, "^Exact isolated native home required$"):
                M.native_session(actual)
            read.assert_not_called()

    def test_final_four_env_assignments_follow_dbus_xvfb_and_never_clear_or_adopt_other_values(self):
        context = {**environment(), "GITHUB_WORKSPACE": str(HERE.parent), "RUNNER_TEMP": "/runner/temp", "CONTROLLER_NODE": "/usr/bin/node",
                   "HOME": "/caller/foreign", "XDG_CONFIG_HOME": "/caller/foreign/config"}
        original = dict(context); command = M.system_session_command(context)
        self.assertIn("--property=PAMName=login", command); self.assertIn("--uid=" + M.USER, command)
        self.assertLess(command.index("/usr/bin/dbus-run-session"), command.index("/usr/bin/xvfb-run"))
        self.assertLess(command.index("/usr/bin/xvfb-run"), command.index("/usr/bin/env"))
        stage = command.index("/usr/bin/env"); target = command.index("/usr/bin/python3")
        self.assertEqual(command[stage + 1:target], ["HOME=" + str(M.BASE / "result/home"), "XDG_CONFIG_HOME=" + str(M.BASE / "result/home/config"),
                                                  "XDG_DATA_HOME=" + str(M.BASE / "result/home/data"), "XDG_CACHE_HOME=" + str(M.BASE / "result/home/cache")])
        self.assertNotIn("-i", command[stage:target]); self.assertEqual(command[target + 1:], ["-B", str(M.BASE / "scripts" / M.Path(M.__file__).name), "session"])
        self.assertEqual(context, original)

    def parent_fixture(self, *, mode=0o777, fault=None, context=None, log_error=None, guard_only=False):
        root = dict(st_dev=10, st_ino=1, st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o755)
        opt = {**root, "st_ino": 2, "st_mode": stat.S_IFDIR | mode}
        named, handles, changes, output = {"/": root, "/opt": opt}, {}, [], []
        if fault == "owner": opt["st_uid"] = 1001
        if fault == "group": opt["st_gid"] = 1001
        if fault == "symlink": opt["st_mode"] = stat.S_IFLNK | 0o777
        if fault == "root-mode": root["st_mode"] = stat.S_IFDIR | 0o777
        def lstat(file):
            key = "/" if file == Path("/") or file == "/" else "/opt"
            self.assertIn(file, (Path("/"), Path("/opt"), "/", "/opt"))
            return SimpleNamespace(**named[key])
        def opened(name, flags, **kwargs):
            self.assertTrue(flags & M.os.O_DIRECTORY and flags & M.os.O_NOFOLLOW and flags & M.os.O_CLOEXEC)
            if name == "/":
                self.assertFalse(kwargs); handles[10] = named["/"]; return 10
            self.assertEqual(name, "opt"); self.assertEqual(kwargs, {"dir_fd": 10})
            if fault == "before-open": named["/opt"]["st_ino"] += 1
            handles[11] = named["/opt"]
            if fault == "after-open": named["/opt"] = {**opt, "st_ino": 99}
            return 11
        def chmod(fd, value):
            self.assertEqual((fd, value), (11, 0o755)); changes.append((fd, value))
            handles[fd]["st_mode"] = stat.S_IFDIR | value
            if fault == "after-chmod": named["/opt"] = {**opt, "st_ino": 99}
        def stat_at(name, **kwargs):
            self.assertEqual((name, kwargs), ("opt", {"dir_fd": 10, "follow_symlinks": False}))
            return SimpleNamespace(**named["/opt"])
        def printed(raw, **kwargs):
            self.assertEqual(kwargs, {"flush": True}); value = json.loads(raw); output.append(value)
            self.assertLess(len(raw.encode()), 8192)
            if value["phase"] == log_error: raise OSError("diagnostic sink refused")
        env = {**environment(), "GITHUB_WORKSPACE": str(HERE.parent), **(context or {})}
        with ExitStack() as stack:
            for manager in (
                patch.object(M.sys, "platform", "linux"), patch.object(M.platform, "machine", return_value="x86_64"),
                patch.object(M.os, "getuid", return_value=M.UID if fault == "nonroot" else 0, create=True), patch.object(M.os, "geteuid", return_value=0, create=True),
                patch.object(M.os, "getgid", return_value=0, create=True), patch.object(M.os, "getegid", return_value=0, create=True),
                patch.object(M.os.path, "lexists", return_value=fault == "reused"),
                patch.object(Path, "lstat", autospec=True, side_effect=lstat),
                patch.object(Path, "resolve", autospec=True, side_effect=lambda file, strict: Path("/foreign") if fault == "redirect" and file == Path("/opt") else file),
                patch.object(M.os, "O_DIRECTORY", 0x10000, create=True), patch.object(M.os, "O_NOFOLLOW", 0x20000, create=True),
                patch.object(M.os, "O_CLOEXEC", 0x40000, create=True), patch.object(M.os, "open", side_effect=opened),
                patch.object(M.os, "fstat", side_effect=lambda fd: SimpleNamespace(**handles[fd])),
                patch.object(M.os, "stat", side_effect=stat_at), patch.object(M.os, "lstat", side_effect=lstat),
                patch.object(M.os, "fchmod", side_effect=chmod, create=True), patch.object(M.os, "close", side_effect=lambda fd: handles.pop(fd)),
                patch.object(M.os, "chmod", side_effect=AssertionError("No path-based permission changes")),
                patch.object(M.os, "chown", side_effect=AssertionError("No ownership repair"), create=True),
                patch.object(M, "run_tool", side_effect=AssertionError("No installation or external command")), patch("builtins.print", side_effect=printed)
            ): stack.enter_context(manager)
            try:
                result, error = (M.protected_ancestry(M.BASE.parent) if guard_only else M.prepare_fixture_parent(env)), None
            except Exception as caught:
                result, error = None, caught
        self.assertFalse(handles, "Every opened directory FD must close")
        return SimpleNamespace(result=result, error=error, changes=changes, output=output)

    def test_fixed_ci_parent_0777_tightens_once_then_original_ancestry_guard_passes(self):
        value = self.parent_fixture()
        self.assertIsNone(value.error); self.assertEqual(value.changes, [(11, 0o755)])
        self.assertTrue(value.result["guardPassed"])
        self.assertEqual([item["phase"] for item in value.output], ["before", "after"])
        self.assertEqual(value.result["before"][1]["mode"], "0777")
        self.assertEqual(value.result["after"][1]["mode"], "0755")
        self.assertEqual(value.result["before"][0], value.result["after"][0])
        value = self.parent_fixture(mode=0o755)
        self.assertIsNone(value.error); self.assertFalse(value.changes)
        self.assertEqual(value.result["before"], value.result["after"])

    def test_original_ancestry_guard_still_refuses_writable_parent_without_preparation(self):
        value = self.parent_fixture(guard_only=True)
        self.assertIsInstance(value.error, RuntimeError); self.assertIn("Protected root-owned directory required", str(value.error))
        self.assertFalse(value.changes); self.assertFalse(value.output)
        self.assertIsNone(self.parent_fixture(mode=0o755, guard_only=True).error)

    def test_fixed_ci_parent_unknown_modes_ownership_links_and_reuse_never_chmod(self):
        for fault in ("owner", "group", "symlink", "redirect", "root-mode", "reused"):
            with self.subTest(fault=fault):
                value = self.parent_fixture(fault=fault)
                self.assertIsInstance(value.error, RuntimeError); self.assertFalse(value.changes)
        for mode in (0o775, 0o1777, 0o700, 0o4755):
            with self.subTest(mode=mode):
                value = self.parent_fixture(mode=mode)
                self.assertIsInstance(value.error, RuntimeError); self.assertFalse(value.changes)
                self.assertEqual(value.output[0]["before"][1]["mode"], format(mode, "04o"))

    def test_fixed_ci_parent_fd_and_named_inode_races_refuse_without_adopting_foreign_directories(self):
        for fault in ("before-open", "after-open", "after-chmod"):
            with self.subTest(fault=fault):
                value = self.parent_fixture(fault=fault)
                self.assertIsInstance(value.error, RuntimeError)
                self.assertEqual(len(value.changes), 1 if fault == "after-chmod" else 0)
                self.assertFalse(value.output[-1]["guardPassed"])

    def test_fixed_ci_parent_context_and_diagnostic_failures_do_not_permit_permission_changes(self):
        value = self.parent_fixture(context={"GITHUB_EVENT_NAME": "push"})
        self.assertIsInstance(value.error, RuntimeError); self.assertFalse(value.changes); self.assertFalse(value.output)
        value = self.parent_fixture(log_error="before")
        self.assertIsInstance(value.error, OSError); self.assertFalse(value.changes)
        value = self.parent_fixture(mode=0o775, log_error="after")
        self.assertIsInstance(value.error, RuntimeError); self.assertIn("Unknown fixed CI directory", str(value.error)); self.assertFalse(value.changes)
        for options in ({"fault": "nonroot"}, {"context": {"GITHUB_WORKSPACE": "/foreign"}}):
            value = self.parent_fixture(**options)
            self.assertIsInstance(value.error, RuntimeError); self.assertFalse(value.changes); self.assertFalse(value.output)

    def test_parent_preparation_and_unchanged_guard_precede_all_fixture_and_install_writes(self):
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        broker = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "broker")
        code = ast.unparse(broker)
        self.assertLess(code.index("prepare_fixture_parent(env)"), code.index("protected_ancestry(BASE.parent)"))
        self.assertLess(code.index("protected_ancestry(BASE.parent)"), code.index("BASE.mkdir("))
        self.assertLess(code.index("protected_ancestry(BASE.parent)"), code.index("prepare_tls("))
        self.assertLess(code.index("protected_ancestry(BASE.parent)"), code.index("'/usr/bin/dpkg', '--install'"))

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Existing Node runtime required; do not skip workflow parsing")
        parser = r'''
        const fs=require('node:fs'),{yaml}=require('playwright-core/lib/utilsBundle');
        const d=yaml.parseDocument(fs.readFileSync(process.argv[1],'utf8'),{uniqueKeys:true});
        if(d.errors.length) throw d.errors[0];
        const w=d.toJS(), AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        for(const j of Object.values(w.jobs)) for(const s of j.steps||[]) if(s.with?.script) new AsyncFunction('github','context','core',s.with.script);
        process.stdout.write(JSON.stringify(w));
        '''
        result = subprocess.run([node, "-e", parser, str(HERE.parent / ".github/workflows/native-linux-production-016-update.yml")],
                                cwd=HERE.parent, capture_output=True, timeout=20)
        if result.returncode or len(result.stdout) > 256 * 1024:
            raise RuntimeError("Workflow YAML/embedded JS parse failed: " + result.stderr.decode(errors="replace")[:2000])
        cls.workflow = json.loads(result.stdout)

    def test_clean_import_has_no_optional_dependency_or_side_effect(self):
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", "import runpy; runpy.run_path(" + repr(str(HERE / "native-linux-production-016-update.py")) + ",run_name='import_only')"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode()); self.assertEqual(result.stdout, b"")

    def test_all_five_and_only_five_scenarios(self):
        self.assertEqual(len(M.SCENARIOS), 5)
        for scenario in M.SCENARIOS:
            env = environment(); env["UPDATE_SCENARIO"] = scenario
            self.assertEqual(M.admission(env, system="linux", machine="x86_64"), scenario)
        with self.assertRaises(RuntimeError):
            M.admission({**environment(), "UPDATE_SCENARIO": "capture"}, system="linux", machine="x86_64")

    def test_exact_context_and_opt_in(self):
        for key in ("GITHUB_REF", "GITHUB_WORKFLOW_REF", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY_ID", "UPDATE_EXECUTE", "RUNNER_ENVIRONMENT"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: "foreign"}, system="linux", machine="x86_64")

    def test_injection_refused_even_empty(self):
        for key in ("LD_LIBRARY_PATH", "PYTHONPATH", "HTTPS_PROXY", "NODE_OPTIONS", "SSL_CERT_FILE", "APPIMAGE", "BASH_ENV"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: ""}, system="linux", machine="x86_64")

    def test_profiles_have_no_policy_overrides(self):
        for portable, scenario in ((False, "deb-approve"), (True, "portable-approve")):
            self.assertEqual(M.validate_profile(profile(portable), scenario)["toVersion"], "0.1.17")
        p = profile(); p["publicKey"] = "test"
        with self.assertRaises(RuntimeError): M.validate_profile(p, "deb-approve")

    def test_baseline_mandatory_no_historical_fallback(self):
        p = profile(); del p["baseline"]
        with self.assertRaises(RuntimeError): M.validate_profile(p, "deb-approve")
        self.assertEqual(set(M.FIXED), {"17"})
        M.validate_profile(profile(), "deb-approve")
        p = profile(); p["baseline"]["source"] = "c" * 40
        with self.assertRaises(RuntimeError): M.validate_profile(p, "deb-approve")

    def test_finite_package_comparison_accepts_each_own_pinned_helper_without_mutating_evidence(self):
        old, new, baseline = compared_packages(); original = copy.deepcopy((old, new, baseline))
        receipt = M.compare_update_packages(old, new, baseline)
        self.assertEqual((old, new, baseline), original)
        self.assertEqual(receipt["targetRetirementHelper"], M.FIXED["17"]["helper"])
        self.assertTrue(receipt["privateDebApprovalRestoresOldRetirementHelper"])
        self.assertFalse(receipt["targetFixNativeAcceptance"])
        self.assertFalse(receipt["futurePublic017Qualified"])
        self.assertFalse(receipt["final016HelperFixRetained"])

    def test_finite_package_comparison_rejects_unknown_helper_even_with_consistent_checksums(self):
        for field, value in (("size", 1167745), ("sha256", "a" * 64), ("mode", 0o777), ("uid", 1), ("kind", "directory")):
            old, new, baseline = compared_packages(); helper = "usr/libexec/creator-hub-deb-retirement-helper"
            new["files"][helper][field] = value
            with self.subTest(field=field), self.assertRaises((RuntimeError, ValueError)): M.compare_update_packages(old, new, baseline)
        p = profile(); p["targetHelper"] = {"size": 1, "sha256": "a" * 64}
        with self.assertRaises(RuntimeError): M.validate_profile(p, "deb-approve")

    def test_finite_package_comparison_preserves_policy_service_other_member_and_control_guards(self):
        for path in ("usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy", "usr/share/dbus-1/services/com.creatorworks.hub.Host.service", "usr/share/icons/creator-hub.png"):
            old, new, baseline = compared_packages(); new["files"][path]["sha256"] = "a" * 64
            with self.subTest(path=path), self.assertRaises(RuntimeError): M.compare_update_packages(old, new, baseline)
        for mutate in (lambda p: p["fields"].update(Depends="foreign"), lambda p: p["fields"].update(Version="0.1.18"),
                       lambda p: p["files"].update(extra={"kind": "directory", "mode": 0o755, "uid": 0, "gid": 0, "size": 0}),
                       lambda p: p["md5sums"].update({M.ROOT_ENTRY: "f" * 32}),
                       lambda p: p["files"][M.ROOT_ENTRY].update(sha256="a" * 64)):
            old, new, baseline = compared_packages(); mutate(new)
            with self.assertRaises((RuntimeError, ValueError)): M.compare_update_packages(old, new, baseline)

    def test_shared017_comparison_still_refuses_helper_delta(self):
        old, new, baseline = compared_packages()
        expected = {"baseline": {k: baseline[k] for k in ("deb", "hub", "helper", "policy", "service")},
                    "candidate": {k: M.FIXED["17"][k] for k in ("deb", "hub", "archive")}}
        shared = M.load("private-linux-update-fixture-017-package-verify")
        with self.assertRaisesRegex(ValueError, "Only Root and module archive bytes may change"):
            shared.compare(old, new, expected)

    def test_actual_portable_stage_keeps_signature_tuple_after_package_inspection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); folder = root / "inputs"; folder.mkdir()
            p, old, new = portable_stage_inputs(folder)
            tool = root / "verifier"; tool.write_bytes(b"fixture ELF"); tool.chmod(0o755)
            verifier = (tool, {"tool": {"pin": M.pin(tool.read_bytes())}})
            shared = M.load("private-linux-update-fixture-017-package-verify")
            inspected, signatures = [], []
            def inspect(path, expected, base, version):
                inspected.append((version, expected["helper"]))
                self.assertEqual(expected["helper"], p["baseline"]["helper"] if version == "0.1.16" else M.FIXED["17"]["helper"])
                return old if version == "0.1.16" else new
            package = SimpleNamespace(base_reader=lambda: SimpleNamespace(verify=lambda *a: None), inspect=inspect,
                                      validate_expected=shared.validate_expected, baseline_members=shared.baseline_members, LIMIT=shared.LIMIT, ARCHIVE=shared.ARCHIVE)
            def load(name):
                if name == "private-linux-update-fixture-017-package-verify": return package
                if name == "native-linux-root-probe": return SimpleNamespace(verify_deb_marker=lambda *a: None)
                raise AssertionError("Unexpected imported native code")
            real_read = M.read
            def read(file, maximum=262144, **kwargs):
                if os.name == "nt": kwargs.pop("mode", None)
                return real_read(file, maximum, **kwargs)
            def verified(argv, **kwargs):
                self.assertEqual(argv[0], str(tool)); signatures.append(Path(argv[1]).name)
                return ("Verified trusted package signature: " + hashlib.sha256(real_read(Path(argv[1]), 128 * 1024)).hexdigest() + ". No activation or client changes.\n").encode()
            with patch.object(M, "admission", return_value="portable-approve"), patch.object(M, "request", return_value={"verifier": verifier[1]}), \
                 patch.object(M, "offline_verifier", return_value=verifier), patch.object(M.os, "geteuid", return_value=1, create=True), \
                 patch.object(M, "read", side_effect=read), patch.object(M, "load", side_effect=load), \
                 patch.object(M, "packaged_root", return_value=b"fixture packaged ELF"), patch.object(M, "run_tool", side_effect=verified):
                M.stage(folder, {**environment(), "UPDATE_SCENARIO": "portable-approve"})
            self.assertEqual(len(inspected), 2); self.assertEqual(len(signatures), 4)
            review = M.parse((folder / "review.json").read_bytes())
            self.assertEqual(set(review["portable"]), {"16", "17"})
            self.assertEqual(review["privateTargetQualification"], M.private_target_qualification())

    def test_published_bootstrap_alias_stays_executable_and_no_other_file_is_promoted(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); p = profile(True)
            source = M.object_path(folder, p, "appimage16"); source.parent.mkdir(parents=True); source.write_bytes(b"fixture AppImage")
            ref = p["objects"]["appimage16"]; p["artifacts"][ref["artifact"]]["files"][ref["member"]] = M.pin(source.read_bytes())
            alias = folder / "Creator.Hub.Native.Support_0.1.16_amd64.AppImage"; alias.write_bytes(source.read_bytes()); alias.chmod(0o755)
            nested = source.parent / alias.name; nested.write_bytes(b"not an executable exception")
            for file in (folder, *folder.rglob("*")): file.chmod(M.published_input_mode(file, folder, p))
            self.assertEqual(M.published_input_mode(alias, folder, p), 0o755)
            self.assertEqual(M.published_input_mode(nested, folder, p), 0o644)
            self.assertEqual(M.published_input_mode(alias, folder, profile()), 0o644)
            if os.name == "posix": self.assertEqual(alias.stat().st_mode & 0o777, 0o755)
            real_read = M.read
            def read(file, maximum=262144, **kwargs):
                kwargs.pop("uid", None)
                if os.name == "nt": kwargs.pop("mode", None)
                return real_read(file, maximum, **kwargs)
            class LaunchBoundary(Exception): pass
            with patch.object(M, "read", side_effect=read), patch.object(M.subprocess, "Popen", side_effect=LaunchBoundary) as launch:
                with self.assertRaises(LaunchBoundary): M.bootstrap16(folder, p, {}, {}, None, None, None, None)
                self.assertEqual(launch.call_args.args[0], [str(alias), "--appimage-extract-and-run"])

    def test_private_delivery_is_fixed_role_name_asset_and_zip(self):
        for key, value in (("asset", 1), ("name", "foreign.zip"), ("zip", {"size": 1, "sha256": "a" * 64})):
            p = profile(); p["deliveries"]["signedDeb17"][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): M.validate_profile(p, "deb-approve")

    def test_portable_signature_deliveries_are_separate_and_source_bound(self):
        p = profile(True); M.validate_profile(p, "portable-approve")
        self.assertEqual(set(p["deliveries"]), {"signedPortable16", "signedPortable17"})
        p["deliveries"]["signedPortable16"]["name"] = "signed-private-portable016-carrier-39352300183.zip"
        with self.assertRaises(RuntimeError): M.validate_profile(p, "portable-approve")

    def test_same_run_delivery_requires_successful_data_job_and_fixed_draft(self):
        p, env = profile(), environment(); M.validate_delivery_api(delivery_api(p, env), p, env)
        mutations = [("run", "head_sha", "f" * 40), ("run", "status", "completed"), ("job", "name", "update"),
                     ("job", "conclusion", "failure"), ("job", "head_sha", "b" * 40), ("artifact", "expired", True)]
        for group, key, value in mutations:
            proof = delivery_api(p, env); proof[group][key] = value
            with self.subTest(group=group, key=key), self.assertRaises(RuntimeError): M.validate_delivery_api(proof, p, env)

    def test_delivery_refuses_wrong_asset_bytes_membership_and_foreign_run(self):
        p, env = profile(), environment()
        for mutate in (lambda x: x["artifact"].update(digest="not-a-digest"), lambda x: x["artifact"]["workflow_run"].update(id=1)):
            proof = delivery_api(p, env); mutate(proof)
            with self.assertRaises(RuntimeError): M.validate_delivery_api(proof, p, env)

    def test_data_receipt_bound_to_scenario_profile_run_source(self):
        p, env = profile(), environment(); receipt = M.delivery_receipt(p, env)
        self.assertEqual(receipt["profileSha256"], env["UPDATE_PROFILE_SHA256"])
        self.assertEqual(receipt["assets"]["signedDeb17"]["asset"], 658078066)
        self.assertTrue(all(receipt[key] is False for key in M.FALSE))
        self.assertNotEqual(receipt, M.delivery_receipt(p, {**env, "GITHUB_SHA": "c" * 40}))

    def test_workflow_write_token_never_checks_out_extracts_or_executes_candidate(self):
        self.assertEqual(set(self.workflow["jobs"]), {"stage-input", "update"})
        data, native = self.workflow["jobs"]["stage-input"], self.workflow["jobs"]["update"]
        self.assertEqual(data["permissions"], {"contents": "write", "actions": "read"})
        self.assertEqual(native["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(native["needs"], "stage-input")
        self.assertEqual(len(data["steps"]), 2)
        self.assertTrue(all("run" not in step and "checkout" not in step.get("uses", "") for step in data["steps"]))
        script = data["steps"][0]["with"]["script"]
        for forbidden in ("child_process", "execFile", "extract", "unzip", "eval(", "new Function", "updateRelease", "uploadReleaseAsset", "deleteReleaseAsset"):
            self.assertNotIn(forbidden, script)
        self.assertIn("release_id:411494394", script)
        self.assertIn("658078066", script)
        self.assertEqual(self.workflow["on"]["push"]["branches"], ["validation/native-linux-production-016-update"])
        for job in self.workflow["jobs"].values():
            self.assertIn("inputs.execute_update == true", job["if"])
            self.assertNotIn("runner.", json.dumps(job.get("env", {})))

    def test_every_workflow_shell_and_python_heredoc_parses(self):
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "/bin/bash"
        if not Path(bash).is_file(): raise RuntimeError("Existing Bash required; no parse skip")
        parsed = 0
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                if "run" not in step: continue
                command = step["run"]
                self.assertNotIn("${{ inputs.", command)
                result = subprocess.run([bash, "-n"], input=command.encode(), capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                if "<<'PY'" in command:
                    source = command.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]; ast.parse(source)
                parsed += 1
        self.assertGreaterEqual(parsed, 9)

    def test_workflow_uses_locked_source_verifier_not_unavailable_minisign(self):
        commands = "\n".join(s.get("run", "") for s in self.workflow["jobs"]["update"]["steps"])
        self.assertNotIn("minisign", commands)
        self.assertIn("update.py verifier", commands)
        self.assertIn("/usr/bin/python3 -I -S", commands)
        self.assertNotIn("pip install", commands)
        source = (HERE / "native-linux-production-016-update.py").read_text()
        self.assertIn('load("native-linux-production-016-flatpak")', source)

    def test_main_verifier_real_shared_builder_and_command_create_fresh_tool_evidence(self):
        shared = M.load("native-linux-production-016-flatpak")
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); parent = folder / "native-linux-production-016-flatpak"
            calls = []
            class Captured:
                def __init__(self, child, evidence, label):
                    self.items = {"stdout": {"kept": bytearray()}, "stderr": {"kept": bytearray()}}
                    self.evidence = evidence; calls.append((evidence, label))
                def pump(self, *args): pass
                def metadata(self): return {key: {"eof": True, "truncated": False, "bytes": 0} for key in self.items}
                def close(self): pass
            child = SimpleNamespace(pid=42, poll=lambda: 0, wait=lambda **kw: 0)
            real_lstat = Path.lstat
            def lstat(path, *a, **k):
                info = real_lstat(path, *a, **k)
                # Windows does not report POSIX mkdir(0700) mode bits. Native
                # Linux runs the same regression with real owner/mode checks.
                if os.name == "nt" and path == parent:
                    return SimpleNamespace(st_uid=info.st_uid, st_mode=stat.S_IFDIR | 0o700)
                return info
            with patch.dict(os.environ, {**environment(), "RUNNER_TEMP": str(folder)}, clear=True), \
                 patch.object(sys, "argv", [str(HERE / "native-linux-production-016-update.py"), "verifier"]), \
                 patch.object(M, "admission", return_value="deb-native-cancel"), patch.object(M, "load", return_value=shared), \
                 patch.object(M.os, "getuid", return_value=folder.stat().st_uid, create=True), \
                 patch.object(M.os, "geteuid", return_value=folder.stat().st_uid, create=True), patch.object(Path, "lstat", lstat), \
                 patch.object(shared, "Path", side_effect=lambda p: PurePosixPath(p) if p == "/usr/bin/git" else Path(p)), \
                 patch.object(shared.P, "helpers", return_value=(None, SimpleNamespace(Capture=Captured))), \
                 patch.object(shared.subprocess, "Popen", return_value=child) as spawn:
                self.assertFalse(parent.exists())
                # Real builder -> real command -> in-memory child/capture. The
                # empty mock Git result is refused; no Git/Cargo/native runs.
                with self.assertRaisesRegex(RuntimeError, "Bounded complete verifier source inventory required"):
                    M.main()
                self.assertTrue(parent.is_dir()); self.assertTrue((parent / "evidence").is_dir())
                self.assertEqual(len(calls), 1); self.assertEqual(calls[0][0], parent / "evidence")
                self.assertEqual(spawn.call_args.args[0][0:2], ["/usr/bin/git", "ls-tree"])
                receipts = list((parent / "evidence").glob("tool-*.json")); self.assertEqual(len(receipts), 1)
                self.assertEqual(M.parse(receipts[0].read_bytes())["exitCode"], 0)

    def test_verifier_setup_refuses_existing_or_redirected_parent_without_chown(self):
        shared = M.load("native-linux-production-016-flatpak")
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); parent = folder / "native-linux-production-016-flatpak"; parent.mkdir()
            with patch.dict(os.environ, {"RUNNER_TEMP": str(folder)}), patch.object(M, "load", return_value=shared), \
                 patch.object(M.os, "getuid", return_value=folder.stat().st_uid, create=True), \
                 patch.object(M.os, "geteuid", return_value=folder.stat().st_uid, create=True), \
                 patch.object(shared, "build_signature_verifier", side_effect=AssertionError("No build on pre-existing state")), \
                 patch.object(M.os, "chown", side_effect=AssertionError("No ownership repair"), create=True):
                with self.assertRaises(RuntimeError): M.build_offline_verifier(os.environ)
            self.assertEqual(list(parent.iterdir()), [])

    def test_readonly_verifier_receipt_reused_by_runner_and_root_without_owner_repair(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); tool, receipt, env = offline_verifier_inputs(folder)
            real_load, real_read = M.load, M.read
            def load(name):
                self.assertEqual(name, "native-linux-integrated-pages")
                return real_load(name)
            def read(file, maximum=262144, **kwargs):
                if os.name == "nt": kwargs.pop("mode", None)
                return real_read(file, maximum, **kwargs)
            before = M.pin((tool.parent / "receipt.json").read_bytes())
            answers = []
            with patch.object(M, "load", side_effect=load), patch.object(M, "read", side_effect=read), \
                 patch.object(M.os, "chown", side_effect=AssertionError("No chown of builder-owned verifier state"), create=True):
                for uid in (folder.stat().st_uid, 0):
                    with patch.object(M.os, "getuid", return_value=uid, create=True), patch.object(M.os, "geteuid", return_value=uid, create=True):
                        answers.append(M.offline_verifier(env))
            self.assertEqual(answers[0], answers[1]); self.assertEqual(answers[0][0], tool)
            self.assertEqual(answers[0][1], {"receipt": before, "tool": receipt["tool"]})
            self.assertEqual(M.pin((tool.parent / "receipt.json").read_bytes()), before)
            tool.write_bytes(b"\x7fELFforeign replacement")
            with patch.object(M, "read", side_effect=read), self.assertRaises(RuntimeError): M.offline_verifier(env)

    def test_builder_and_shared_reader_must_agree_with_new3_tool_location(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); parent = folder / "native-linux-production-016-flatpak"
            tool = folder / "native-linux-production-016-verifier/verify-package-input"
            shared = SimpleNamespace(locations=lambda: parent, verifier_root=lambda: tool.parent,
                                     build_signature_verifier=lambda: None, signature_verifier=lambda: tool)
            real_lstat = Path.lstat
            def lstat(path, *a, **k):
                info = real_lstat(path, *a, **k)
                return SimpleNamespace(st_uid=info.st_uid, st_mode=stat.S_IFDIR | 0o700) if os.name == "nt" and path == parent else info
            with patch.object(M, "load", return_value=shared), patch.object(M, "offline_verifier", return_value=(folder / "foreign-tool", {})), \
                 patch.object(M.os, "getuid", return_value=folder.stat().st_uid, create=True), \
                 patch.object(M.os, "geteuid", return_value=folder.stat().st_uid, create=True), patch.object(Path, "lstat", lstat):
                with self.assertRaisesRegex(RuntimeError, "same tool"): M.build_offline_verifier({"RUNNER_TEMP": str(folder)})

    def test_neutral_dependency_import_closure(self):
        script = ("import runpy; m=runpy.run_path(" + repr(str(HERE / "native-linux-production-016-update.py"))
                  + ",run_name='import_only'); [m['load'](n[:-3]) for n in m['SOURCES'] if n.endswith('.py') and n != 'native-linux-production-016-update.py']")
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", script], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))

    def test_signature_requires_exact_answer_and_unchanged_bytes_tool(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); body, sig, tool = (folder / n for n in ("body", "sig", "tool"))
            body.write_bytes(b"metadata"); sig.write_bytes(b"detached"); tool.write_bytes(b"ELF")
            expected = {"tool": {"pin": M.pin(b"ELF")}}
            answer = ("Verified trusted package signature: " + hashlib.sha256(b"metadata").hexdigest() + ". No activation or client changes.\n").encode()
            real_bound = M.bound
            def bounded(file, pin, maximum, **kwargs): return real_bound(file, pin, maximum)
            with patch.object(M, "bound", side_effect=bounded), patch.object(M, "run_tool", return_value=answer):
                M.signature(body, sig, (tool, expected))
            for result in (b"", answer + b"extra"):
                with patch.object(M, "bound", side_effect=bounded), patch.object(M, "run_tool", return_value=result), self.assertRaises(RuntimeError):
                    M.signature(body, sig, (tool, expected))
            def mutate(*a, **k): body.write_bytes(b"modified"); return answer
            with patch.object(M, "bound", side_effect=bounded), patch.object(M, "run_tool", side_effect=mutate), self.assertRaises(RuntimeError):
                M.signature(body, sig, (tool, expected))

    def test_large_installer_is_not_sent_to_metadata_verifier(self):
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        stage = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "stage")
        calls = [ast.unparse(n) for n in ast.walk(stage) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "signature"]
        self.assertEqual(len(calls), 3)
        self.assertFalse(any("deb17" in call for call in calls))

    def test_live_process_counter_changes_are_not_identity_changes(self):
        first = [b"S", b"2"] + [b"0"] * 18; first[19] = b"100"
        second = list(first); second[11] = b"1"
        native = SimpleNamespace(native_process=lambda *a: {"pid": 4})
        with patch.object(M, "alive_stat", side_effect=[first, second]): self.assertEqual(M.kernel_record(4, native, None), {"pid": 4})
        second[19] = b"101"
        with patch.object(M, "alive_stat", side_effect=[first, second]), self.assertRaises(RuntimeError): M.kernel_record(4, native, None)

    def test_pair_recheck_refuses_replaced_or_foreign_window(self):
        surface = M.Surface.__new__(M.Surface)
        surface.stable = lambda: None; surface.xres = {"pid": 10}; surface.request = None; surface.window = 5
        surface.main_window = (4, {"pid": 10, "title": M.TITLE, "mapped": True, "client": 3})
        surface.renderer = None; surface.references = SimpleNamespace(recheck=lambda: None)
        surface.helper = SimpleNamespace(bound_window=lambda *a: {"pid": 10})
        values = {"pid": 10, "title": M.TITLE, "mapped": True, "client": 3}
        surface.x11 = SimpleNamespace(inspect=lambda _: values)
        with patch.object(M, "windows", return_value=[4, 5]): surface.recheck()
        for ids in ([4, 6], [4, 5, 7]):
            with patch.object(M, "windows", return_value=ids), self.assertRaises(RuntimeError): surface.recheck()
        values["pid"] = 11
        with patch.object(M, "windows", return_value=[4, 5]), self.assertRaises(RuntimeError): surface.recheck()

    def test_authority_and_session_checked_after_every_broker_wait(self):
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        authorize = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "authorize")
        guard = next(n for n in authorize.body if isinstance(n, ast.FunctionDef) and n.name == "guard")
        calls = [n.func.id for n in ast.walk(guard) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]
        self.assertEqual(calls.count("recheck_endpoint"), 2)
        self.assertEqual(calls.count("wait"), 1)

    def test_preserved_fixture_includes_shared_clients_and_unknown_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve(); before = M.fixtures(home); M.preserved(home, before)
            for name in (".claude.json", ".codex/config.toml", "config/Code/User/mcp.json", "config/Claude/claude_desktop_config.json", M.PREFS, M.CONFIG):
                self.assertIn(name, before)
            (home / ".codex/config.toml").write_text("changed")
            with self.assertRaises(RuntimeError): M.preserved(home, before)

    def test_original_assembly_cannot_be_relabelled(self):
        for side in ("16", "17"):
            for key in ("source", "tree", "run", "job", "artifact", "zip"):
                p = profile(); p["artifacts"]["assembly" + side][key] = "changed"
                with self.subTest(side=side, key=key), self.assertRaises((RuntimeError, TypeError)):
                    M.validate_profile(p, "deb-approve")

    def test_wrong_actual_root_or_deb_refused(self):
        for name in ("deb16", "deb17", "raw16", "raw17"):
            p = profile(); ref = p["objects"][name]
            p["artifacts"][ref["artifact"]]["files"][ref["member"]] = {"size": 1, "sha256": "a" * 64}
            with self.subTest(name=name), self.assertRaises(RuntimeError): M.validate_profile(p, "deb-approve")

    def test_portable_uses_distinct_manifests_not_deb_elf(self):
        p = profile(True); p["objects"]["portableManifest17"] = p["objects"]["raw17"]
        with self.assertRaises(RuntimeError): M.validate_profile(p, "portable-approve")

    def test_api_binds_full_source_tree_job_run_and_zip(self):
        expected = profile()["artifacts"]["assembly16"]; M.validate_api(api(expected), expected)
        for group, key in (("run", "head_sha"), ("run", "path"), ("run", "conclusion"), ("job", "run_attempt"), ("artifact", "digest"), ("artifact", "expired")):
            proof = api(expected); proof[group][key] = "foreign"
            with self.subTest(group=group, key=key), self.assertRaises(RuntimeError): M.validate_api(proof, expected)

    def test_foreign_repository_and_tree_refused(self):
        expected = profile()["artifacts"]["assembly16"]
        for mutate in (lambda x: x["run"]["head_repository"].update(id=1), lambda x: x["commit"]["tree"].update(sha="a" * 40)):
            proof = api(expected); mutate(proof)
            with self.assertRaises(RuntimeError): M.validate_api(proof, expected)

    def test_duplicate_json_nonfinite_and_paths_refused(self):
        for value in (b'{"x":1,"x":2}', b'{"x":NaN}'):
            with self.assertRaises(RuntimeError): M.parse(value)
        for name in ("", ".", "..", "../x", "/x", "a//b", "a/./b", "a\\b", "a:b", "a\x00b",
                     "/@x", "C:/@x", "@x/", "@x//y", "@x/./y", "@x/../y", "a\uff20b", "a@b\n"):
            with self.assertRaises(RuntimeError): M.safe_name(name)

    def test_actual_portable_icon_paths_with_ascii_at_are_canonical(self):
        for version in ("16", "17"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temp:
                value, raw = manifest(icons=True)
                baseline = profile()["baseline"]
                expected = baseline if version == "16" else M.FIXED["17"]
                value.update(version="0.1." + version, sourceCommit=expected["source"], sourceTree=expected["tree"])
                M.portable_manifest(value, version, baseline)
                file = Path(temp).resolve() / "archive.tar.gz"; file.write_bytes(raw)
                M.verify_tar(file, value)

    def test_portable_ascii_at_does_not_admit_case_aliases(self):
        value, _ = manifest(icons=True)
        name = "usr/share/icons/hicolor/256x256@2/apps/creator-hub.png"
        value["entries"][name.upper()] = copy.deepcopy(value["entries"][name])
        with self.assertRaisesRegex(RuntimeError, "Bounded unique complete inventory"):
            M.portable_manifest(value, "17")

    def test_complete_signed_manifest_and_tar(self):
        value, raw = manifest(); M.portable_manifest(value, "17")
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp).resolve() / "archive.tar.gz"; file.write_bytes(raw)
            M.verify_tar(file, value)

    def test_manifest_missing_parent_extra_policy_and_bad_mode_refused(self):
        for mutate in (lambda x: x["entries"].pop("usr/bin"), lambda x: x.update(allowLinks=True),
                       lambda x: x["entries"][M.ROOT_ENTRY].update(mode=0o777), lambda x: x.update(version="0.1.16")):
            value, _ = manifest(); mutate(value)
            with self.assertRaises(RuntimeError): M.portable_manifest(value, "17")

    def test_archive_concatenation_truncation_and_trailing_data_refused(self):
        for change in (lambda x: x + x, lambda x: x[:-10], lambda x: x + b"foreign"):
            value, raw = manifest(); raw = change(raw); value["archive"].update(M.pin(raw))
            with tempfile.TemporaryDirectory() as temp:
                file = Path(temp).resolve() / "archive"; file.write_bytes(raw)
                with self.assertRaises(RuntimeError): M.verify_tar(file, value)

    def test_archive_byte_hash_refused(self):
        value, raw = manifest(); value["entries"][M.ROOT_ENTRY]["sha256"] = "a" * 64
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp).resolve() / "archive"; file.write_bytes(raw)
            with self.assertRaises(RuntimeError): M.verify_tar(file, value)

    def test_zip_inventory_extras_links_duplicates_refused(self):
        for variant in ("extra", "link", "duplicate"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve(); file = root / "archive.zip"
                with zipfile.ZipFile(file, "w") as archive:
                    item = zipfile.ZipInfo("one"); item.external_attr = ((0o120777 if variant == "link" else 0o100644) << 16)
                    archive.writestr(item, b"one")
                    if variant != "link": archive.writestr("two" if variant == "extra" else "one", b"one")
                expected = {"zip": M.pin(file.read_bytes()), "files": {"one": M.pin(b"one")}}
                with self.assertRaises(RuntimeError): M.stage_zip(file, expected, root / "out")

    def test_bounded_read_refuses_oversize_before_open(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp).resolve() / "file"; file.write_bytes(b"large")
            with patch.object(M.os, "open", side_effect=AssertionError("must not open")):
                with self.assertRaises(RuntimeError): M.read(file, 2)

    @unittest.skipUnless(os.name == "posix", "Native nofollow/FIFO semantics")
    def test_symlink_fifo_and_replacement_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); file = root / "file"; file.write_bytes(b"safe")
            link = root / "link"; link.symlink_to(file); fifo = root / "fifo"; os.mkfifo(fifo)
            for p in (link, fifo):
                with self.assertRaises(RuntimeError): M.read(p)

    def test_phase_identity_new_pid_parent_image_version_bound(self):
        pin = M.FIXED["17"]["hub"]
        old = {"pid": 20, "startTime": "100"}
        value = {"pid": 21, "startTime": "101", "parentPid": 2, "uids": [M.UID] * 4, "executable": "/usr/bin/creator-hub", "kernelImageSha256": pin["sha256"], "image": {"st_size": str(pin["size"])}}
        M.phase_identity(value, pin, "/usr/bin/creator-hub", 2, M.UID, previous=old, baseline=[9])
        for delta in ({"pid": 20}, {"parentPid": 3}, {"startTime": "99"}, {"uids": [0] * 4}, {"kernelImageSha256": profile()["baseline"]["hub"]["sha256"]}):
            with self.subTest(delta=delta), self.assertRaises(RuntimeError): M.phase_identity({**value, **delta}, pin, "/usr/bin/creator-hub", 2, M.UID, previous=old)

    def test_exact_sealed_installer_command_only(self):
        M.pending_command(b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0")
        for raw in (b"pkexec\0dpkg\0", b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/tmp/installer.deb\0"):
            with self.assertRaises(RuntimeError): M.pending_command(raw)

    def test_observer_never_launches_or_signals_successor(self):
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        observer = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "observe_successor")
        calls = [n.func.attr for n in ast.walk(observer) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        self.assertFalse(set(calls) & {"Popen", "run", "kill", "killpg", "terminate", "send_signal", "waitpid"})

    def test_selection_requires_exact_prior_generation(self):
        old, new = "a" * 64, "b" * 64
        M.selection({"schemaVersion": 1, "generation": new, "version": "0.1.17", "previousGeneration": old}, new, old)
        with self.assertRaises(RuntimeError): M.selection({"schemaVersion": 1, "generation": new, "version": "0.1.17", "previousGeneration": None}, new, old)

    def test_scoped_pass_requires_all_native_evidence(self):
        common = {**M.FALSE, "initialBitmap": {"nonblank": True}, "successorBitmap": {"nonblank": True},
                  "privateTargetQualification": M.private_target_qualification(), **dict.fromkeys(("initial16Verified", "nativeConfirmationObserved", "settingsPreserved", "runtimeSurvived", "normalFinalClose"), True)}
        for scenario in M.SCENARIOS:
            evidence = {**common, "nativeActions": ["Not now" if scenario.endswith("native-cancel") else "Update Hub"],
                        "systemActions": ["Authenticate"] if scenario == "deb-approve" else ["Cancel"] if scenario == "deb-auth-cancel" else [],
                        "oldSelectionUnchanged": True, "initialRootSurvived": True, "automaticSuccessor": None, "sealed17Observed": True,
                        "oldRetirementHelperRestored": scenario == "deb-approve"}
            if scenario.endswith("approve"):
                evidence.update(dict.fromkeys(("oldNormalExit", "automaticRestartObserved", "installed17Verified", "fresh17UiVersion", "directPagesObserved"), True)); evidence["automaticSuccessor"] = {"pid": 2}
            self.assertTrue(M.outcome(scenario, evidence))
            with self.assertRaises(RuntimeError): M.outcome(scenario, {**evidence, "normalFinalClose": False})
            with self.assertRaises(RuntimeError): M.outcome(scenario, {**evidence, "releaseReady": True})
            altered = copy.deepcopy(evidence); altered["privateTargetQualification"]["futurePublic017Qualified"] = True
            with self.assertRaises(RuntimeError): M.outcome(scenario, altered)
            with self.assertRaises(RuntimeError): M.outcome(scenario, {**evidence, "oldRetirementHelperRestored": scenario != "deb-approve"})

    def test_scope_cannot_accept_second_authorization_or_missing_ui(self):
        evidence = {**M.FALSE, **dict.fromkeys(("initial16Verified", "nativeConfirmationObserved", "settingsPreserved", "runtimeSurvived", "normalFinalClose", "oldNormalExit", "automaticRestartObserved", "installed17Verified", "fresh17UiVersion", "directPagesObserved"), True),
                    "nativeActions": ["Update Hub"], "systemActions": ["Authenticate", "Authenticate"], "automaticSuccessor": {"pid": 2}}
        with self.assertRaises(RuntimeError): M.outcome("deb-approve", evidence)

    def test_transport_preparation_exact_layout_and_no_tls(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); source, destination = base / "source", base / "destination"; source.mkdir(); destination.mkdir()
            p, env = profile(), {**environment(), "RUNNER_TEMP": str(destination)}
            roles = M.transport_files(p, "deb-approve")
            for index, name in enumerate(roles.values()):
                ref = p["objects"][name]; body = ("role" + str(index)).encode()
                file = M.object_path(source, p, name); file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(body)
                M.input_roles(p)[ref["artifact"]]["files"][ref["member"]] = M.pin(body)
            folder, pins = M.prepare_transport(source, p, env)
            self.assertEqual({f.name for f in folder.iterdir()}, {"inputs", "transport-pins.json"})
            self.assertEqual({f.relative_to(folder / "inputs").as_posix() for f in (folder / "inputs").rglob("*") if f.is_file()}, set(roles))
            self.assertEqual(M.parse((folder / "transport-pins.json").read_bytes()), pins)
            with self.assertRaises(FileExistsError): M.prepare_transport(source, p, env)

    def test_carrier_complete_inventory_and_receipt_before_any_inner_decode(self):
        for variant in ("valid", "wrong-receipt", "extra", "symlink"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp).resolve(); p = profile(True); env = {**environment(), "UPDATE_SCENARIO": "portable-approve"}
                bodies = {role + ".zip": (role + "-original-zip").encode() for role in p["deliveries"]}
                for role, expected in p["deliveries"].items(): expected["zip"] = M.pin(bodies[role + ".zip"])
                raw = (json.dumps(p) + "\n").encode(); env["UPDATE_PROFILE_SHA256"] = hashlib.sha256(raw).hexdigest()
                (folder / "profile.json").write_bytes(raw)
                receipt = M.delivery_receipt(p, env)
                if variant == "wrong-receipt": receipt["harnessSource"] = "f" * 40
                bodies["delivery-proof.json"] = (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()
                if variant == "extra": bodies["unexpected"] = b"refuse"
                with zipfile.ZipFile(folder / "carrier.zip", "w") as archive:
                    for name, body in bodies.items():
                        item = zipfile.ZipInfo(name); item.external_attr = ((0o120777 if variant == "symlink" and name.endswith(".zip") else 0o100644) << 16)
                        archive.writestr(item, body)
                proof = {role: api(item) for role, item in p["artifacts"].items()}; proof["private"] = delivery_api(p, env)
                zipped = M.pin((folder / "carrier.zip").read_bytes())
                proof["private"]["artifact"].update(size_in_bytes=zipped["size"], digest="sha256:" + zipped["sha256"])
                (folder / "api.json").write_text(json.dumps(proof))
                if variant == "valid":
                    M.unpack_carrier(folder, env)
                    for role in p["deliveries"]: self.assertEqual((folder / (role + ".zip")).read_bytes(), bodies[role + ".zip"])
                else:
                    with self.assertRaises(RuntimeError): M.unpack_carrier(folder, env)
                    self.assertFalse(any((folder / (role + ".zip")).exists() for role in p["deliveries"]))

    def test_data_job_executes_only_mocked_download_and_closed_receipt(self):
        node = shutil.which("node")
        p = profile(True)
        for role, value in p["deliveries"].items(): value["zip"] = M.pin(role.encode())
        raw = json.dumps(p); env = environment(); env["UPDATE_PROFILE_SHA256"] = hashlib.sha256(raw.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as temp:
            # Execute only the data-only JS against in-memory GitHub API mocks;
            # writes are confined to this unit-test temporary directory.
            runner = r'''
            const fs=require('node:fs'),path=require('node:path');
            const p=JSON.parse(process.env.INPUT_PROFILE), assets=Object.entries(p.deliveries).map(([r,v])=>({id:v.asset,name:v.name,size:v.zip.size,digest:'sha256:'+v.zip.sha256,state:'uploaded'}));
            const github={rest:{repos:{
              getRelease:async q=>{if(q.release_id!==411494394)throw Error('foreign release');return {data:{id:411494394,tag_name:'v0.1.13-validation',draft:true}}},
              listReleaseAssets:async()=>({data:assets}),
              getReleaseAsset:async q=>{const row=assets.find(v=>v.id===q.asset_id);if(!row)throw Error('foreign asset');
                return {data:q.headers ? Buffer.from(Object.entries(p.deliveries).find(([r,v])=>v.asset===q.asset_id)[0]) : row}}
            }}};
            const context={sha:process.env.TEST_SOURCE,runId:123};
            const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
            new AsyncFunction('github','context','core',process.env.TEST_SCRIPT)(github,context,{}).catch(e=>{console.error(e);process.exitCode=1});
            '''
            child_env = {**os.environ, "RUNNER_TEMP": temp, "INPUT_PROFILE": raw, "INPUT_PROFILE_SHA256": env["UPDATE_PROFILE_SHA256"],
                         "INPUT_SCENARIO": "portable-approve", "GITHUB_RUN_ATTEMPT": "1", "TEST_SOURCE": env["GITHUB_SHA"],
                         "TEST_SCRIPT": self.workflow["jobs"]["stage-input"]["steps"][0]["with"]["script"]}
            result = subprocess.run([node, "-e", runner], env=child_env, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            actual = (Path(temp) / "production016-update-data-only/delivery-proof.json").read_bytes()
            expected = (json.dumps(M.delivery_receipt(p, env), sort_keys=True, indent=2) + "\n").encode()
            self.assertEqual(actual, expected)

    def test_transport_receipt_never_adopts_extra_asset_or_failed_requests(self):
        prefix = "/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/"
        names = ("creator-hub-linux-x86_64-deb.json", "creator-hub-linux-x86_64-deb.json.minisig")
        pins = {"files": {"deb17/" + n: {"size": 1, "sha256": "a" * 64} for n in names}}
        receipt = {"fromVersion": "0.1.16", "targetVersion": "0.1.17", "publicDiscovery": False, "releaseReady": False,
                   "schemaVersion": 1, "mode": "deb", "scope": "linux-deb-production016-to-private017-lab-transport", "pins": pins["files"],
                   **dict.fromkeys(("nativeAcceptanceTested", "signaturesVerifiedByHarness", "signedUpdateAccepted", "migrationAccepted", "restartAccepted"), False),
                   "closeReason": "caller", "rejectedRequestCount": 0, "requests": [{"host": "github.com", "path": prefix + n, "sha256": "a" * 64} for n in names]}
        M.validate_transport_report(receipt, pins, "deb-native-cancel")
        for mutate in (lambda v: v.update(rejectedRequestCount=1), lambda v: v.update(closeReason="timeout"),
                       lambda v: v["requests"].append({"host": "foreign.test", "path": "/x", "sha256": "a" * 64})):
            value = copy.deepcopy(receipt); mutate(value)
            with self.assertRaises(RuntimeError): M.validate_transport_report(value, pins, "deb-native-cancel")

    def test_tls_cleanup_refuses_foreign_stamp_before_unlink(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); (base / "tls").mkdir(); cert = base / "public.crt"; cert.write_bytes(b"owned")
            published = {"certificate": M.pin(b"owned"), "stamp": ["foreign"]}
            (base / "tls/published.json").write_text(json.dumps(published))
            real_read = M.read
            def narrow_read(file, maximum, **kwargs): return real_read(file, maximum)
            with patch.object(M, "BASE", base), patch.object(M, "TLS_CERT", cert), patch.object(M, "tls_arm", return_value={"certificate": M.pin(b"owned")}), \
                 patch.object(M, "read", side_effect=narrow_read), patch.object(M.os, "unlink", side_effect=AssertionError("No unlink authority")), self.assertRaises(RuntimeError):
                M.tls_cleanup_locked(environment())

    def test_tls_cleanup_rebuilds_after_proven_owned_unlink_interruption(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); (base / "tls").mkdir(); cert = base / "public.crt"
            expected = M.pin(b"owned"); (base / "tls/published.json").write_text(json.dumps({"certificate": expected, "stamp": []}))
            real_read = M.read
            with patch.object(M, "BASE", base), patch.object(M, "TLS_CERT", cert), patch.object(M, "tls_arm", return_value={"certificate": expected, "before": {"original": True}}), \
                 patch.object(M, "read", side_effect=lambda file, maximum, **kwargs: real_read(file, maximum)), \
                 patch.object(M, "cleanup_owned_trust_aliases") as aliases, \
                 patch.object(M, "trust_snapshot", return_value={"original": True}), patch.object(M, "run_tool", return_value=b"") as command:
                self.assertTrue(M.tls_cleanup_locked(environment())["originalTrustRestored"])
                aliases.assert_called_once()
                command.assert_called_once_with(["/usr/sbin/update-ca-certificates"], timeout=60)

    def trust_fixture(self):
        bundle = M.pin(b"synthetic CA bytes never exported")
        return {"entries": {"ca-certificates.crt": {"mode": 0o644, "bytes": bundle},
                            "root.pem": {"link": "/synthetic/target-not-exported.crt"},
                            "java": {"kind": "directory", "mode": 0o755}}, "bundle": bundle}

    @contextmanager
    def trust_alias_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); folder = base / "trust"; folder.mkdir(); (base / "tls").mkdir()
            pem, hashed = "creator-production016-update.pem", "99383ae7.0"
            def info(ino, mode, size=0):
                return SimpleNamespace(st_dev=12, st_ino=ino, st_mode=mode, st_uid=0, st_gid=0, st_nlink=1,
                                       st_size=size, st_mtime_ns=100, st_ctime_ns=100)
            directory = info(1, stat.S_IFDIR | 0o755)
            links = {pem: {"target": str(M.TLS_CERT), "info": info(2, stat.S_IFLNK | 0o777)},
                     hashed: {"target": pem, "info": info(3, stat.S_IFLNK | 0o777)},
                     "foreign.pem": {"target": "/preserved/foreign.crt", "info": info(4, stat.S_IFLNK | 0o777)}}
            before = {"entries": {"foreign.pem": {"link": "/preserved/foreign.crt"}}, "bundle": M.pin(b"original bundle")}
            arm = {"certificate": M.pin(b"synthetic public certificate"), "before": before}
            published = {"certificate": arm["certificate"], "stamp": [1, 2, 3]}
            (base / "tls/published.json").write_text(json.dumps(published))
            originals = {name: getattr(os, name) for name in ("open", "close", "stat", "lstat", "fstat", "fsync", "listdir", "readlink", "unlink")}
            original_read, original_save, original_lexists = M.read, M.save, os.path.lexists
            state = SimpleNamespace(base=base, folder=folder, pem=pem, hashed=hashed, links=links, arm=arm, published=published,
                                    removed=[], events=[], fault=None, counts={}, handles={}, counter=100002, directory=directory)
            def opened(file, flags, mode=0o777, *, dir_fd=None):
                if file == folder or file == base / "tls":
                    fd = 100000 if file == folder else 100001
                    self.assertEqual(flags, os.O_RDONLY | M.os.O_DIRECTORY | M.os.O_NOFOLLOW | M.os.O_CLOEXEC)
                    state.handles[fd] = directory; return fd
                if dir_fd == 100000:
                    self.assertEqual(flags, M.os.O_PATH | M.os.O_NOFOLLOW | M.os.O_CLOEXEC)
                    if state.fault == "replace-at-open" and file == hashed:
                        state.links[file] = {"target": pem, "info": info(99, stat.S_IFLNK | 0o777)}
                    fd = state.counter; state.counter += 1; state.handles[fd] = copy.deepcopy(state.links[file]); return fd
                return originals["open"](file, flags, mode, **({"dir_fd": dir_fd} if dir_fd is not None else {}))
            def lstat(file, **kwargs):
                return state.directory if file == folder else originals["lstat"](file, **kwargs)
            def stat_at(file, **kwargs):
                if kwargs.get("dir_fd") == 100000:
                    self.assertEqual(kwargs, {"dir_fd": 100000, "follow_symlinks": False})
                    return state.links[file]["info"]
                if file == folder: return state.directory
                return originals["stat"](file, **kwargs)
            def fstat(fd):
                held = state.handles.get(fd)
                return held["info"] if isinstance(held, dict) else held if held is not None else originals["fstat"](fd)
            def readlink(name, **kwargs):
                fd = kwargs.get("dir_fd")
                if name == "" and fd in state.handles: return state.handles[fd]["target"]
                if fd == 100000:
                    count = state.counts[name] = state.counts.get(name, 0) + 1
                    if state.fault == "retarget-before-unlink" and name == hashed and count == 4:
                        state.links[name] = {"target": "/foreign/replacement", "info": info(88, stat.S_IFLNK | 0o777)}
                    return state.links[name]["target"]
                return originals["readlink"](name, **kwargs)
            def unlink(name, **kwargs):
                if kwargs.get("dir_fd") == 100000:
                    self.assertIn("journal-fsynced", state.events)
                    self.assertIn(name, (pem, hashed)); state.removed.append(name); del state.links[name]
                    if state.fault == "interrupt-after-hash" and name == hashed: raise OSError("interrupted after owned hash unlink")
                    return
                return originals["unlink"](name, **kwargs)
            def closed(fd):
                if fd in state.handles: del state.handles[fd]
                else: originals["close"](fd)
            def fsync(fd):
                if fd == 100001: state.events.append("journal-fsynced")
                else: originals["fsync"](fd)
            def read(file, maximum=262144, **kwargs):
                if Path(file).parent == base / "tls": kwargs.pop("uid", None); kwargs.pop("mode", None)
                return original_read(file, maximum, **kwargs)
            def save(file, value, mode=0o600):
                original_save(file, value, mode)
                if file == base / "tls/aliases.json": state.events.append("journal-saved")
            def snapshot():
                return {"entries": {name: {"link": row["target"]} for name, row in state.links.items()}, "bundle": before["bundle"]}
            with ExitStack() as stack:
                for manager in (patch.object(M, "BASE", base), patch.object(M, "TLS_TRUST", folder),
                                patch.object(M, "protected_ancestry", side_effect=lambda path: self.assertIn(path, (folder, base / "tls"))),
                                patch.object(M.os, "getuid", return_value=0, create=True), patch.object(M.os, "geteuid", return_value=0, create=True),
                                patch.object(M.os, "O_DIRECTORY", getattr(os, "O_DIRECTORY", 0), create=True),
                                patch.object(M.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True),
                                patch.object(M.os, "O_CLOEXEC", getattr(os, "O_CLOEXEC", 0), create=True),
                                patch.object(M.os, "O_PATH", getattr(os, "O_PATH", 0x200000), create=True),
                                patch.object(M.os, "open", side_effect=opened), patch.object(M.os, "lstat", side_effect=lstat),
                                patch.object(M.Path, "lstat", autospec=True, side_effect=lstat),
                                patch.object(M.os, "stat", side_effect=stat_at), patch.object(M.os, "fstat", side_effect=fstat),
                                patch.object(M.os, "readlink", side_effect=readlink), patch.object(M.os, "unlink", side_effect=unlink),
                                patch.object(M.os, "close", side_effect=closed), patch.object(M.os, "fsync", side_effect=fsync),
                                patch.object(M.os, "listdir", side_effect=lambda fd: list(state.links) if fd == 100000 else originals["listdir"](fd)),
                                patch.object(M.os.path, "lexists", side_effect=lambda file: False if file == M.TLS_CERT else original_lexists(file)),
                                patch.object(M, "read", side_effect=read), patch.object(M, "save", side_effect=save),
                                patch.object(M, "tls_arm", return_value=arm), patch.object(M, "trust_snapshot", side_effect=snapshot)):
                    stack.enter_context(manager)
                yield state
                self.assertFalse(state.handles, "All held alias/directory FDs must close")

    def test_actual_two_dangling_aliases_fail_old_behavior_then_exact_cleanup_restores_snapshot(self):
        with self.trust_alias_fixture() as fixture, patch.object(M, "run_tool", return_value=b"") as command, patch("builtins.print"):
            with patch.object(M, "cleanup_owned_trust_aliases"), self.assertRaisesRegex(RuntimeError, "Original CI trust snapshot not restored"):
                M.tls_cleanup_locked(environment())
            command.reset_mock()
            self.assertTrue(M.tls_cleanup_locked(environment())["originalTrustRestored"])
            self.assertEqual(fixture.removed, [fixture.hashed, fixture.pem])
            self.assertEqual(set(fixture.links), {"foreign.pem"})
            command.assert_called_once_with(["/usr/sbin/update-ca-certificates"], timeout=60)
            self.assertLess(fixture.events.index("journal-saved"), fixture.events.index("journal-fsynced"))

    def test_alias_fixture_covers_path_lstat_with_python310_cached_stat_accessor(self):
        cached_stat = os.stat
        def path_stat(path, *, follow_symlinks=True):
            return cached_stat(path, follow_symlinks=follow_symlinks)
        with patch.object(M.Path, "stat", autospec=True, side_effect=path_stat), self.trust_alias_fixture() as fixture:
            M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
            self.assertEqual(fixture.removed, [fixture.hashed, fixture.pem])

    def test_alias_cleanup_refuses_original_foreign_type_target_extra_and_identity_changes_before_unlink(self):
        for fault in ("original-pem", "original-hash", "original-removed", "foreign-owner", "hardlink", "regular-pem", "wrong-target", "wrong-hash", "extra-link", "extra-hash", "wrong-publication", "replace-at-open", "retarget-before-unlink", "directory-owner"):
            with self.subTest(fault=fault), self.trust_alias_fixture() as fixture:
                if fault in ("original-pem", "original-hash"):
                    name = fixture.pem if fault == "original-pem" else fixture.hashed
                    fixture.arm["before"]["entries"][name] = {"link": fixture.links[name]["target"]}
                if fault == "foreign-owner": fixture.links[fixture.pem]["info"].st_uid = 1001
                if fault == "original-removed": del fixture.links["foreign.pem"]
                if fault == "hardlink": fixture.links[fixture.pem]["info"].st_nlink = 2
                if fault == "regular-pem": fixture.links[fixture.pem]["info"].st_mode = stat.S_IFREG | 0o644
                if fault == "wrong-target": fixture.links[fixture.pem]["target"] = "/foreign.crt"
                if fault == "wrong-hash": fixture.links[fixture.hashed]["target"] = "/foreign.pem"
                if fault == "extra-link": fixture.links["unexpected.pem"] = copy.deepcopy(fixture.links[fixture.pem])
                if fault == "extra-hash": fixture.links["12345678.0"] = copy.deepcopy(fixture.links[fixture.hashed])
                if fault == "wrong-publication": fixture.published["certificate"] = M.pin(b"foreign certificate")
                if fault == "directory-owner": fixture.directory.st_uid = 1001
                fixture.fault = fault
                with self.assertRaises(RuntimeError): M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
                self.assertFalse(fixture.removed)

    def test_alias_cleanup_foreign_journal_appearing_before_publication_is_never_overwritten_or_adopted(self):
        with self.trust_alias_fixture() as fixture:
            save = M.save; file = fixture.base / "tls/aliases.json"
            def publish(path, value, mode=0o600):
                if path == file: file.write_bytes(b"foreign journal appeared")
                save(path, value, mode)
            with patch.object(M, "save", side_effect=publish), self.assertRaises(FileExistsError):
                M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
            self.assertEqual(file.read_bytes(), b"foreign journal appeared")
            self.assertFalse(fixture.removed)

    def test_alias_cleanup_partial_unlink_resumes_only_journaled_original_link_identities(self):
        with self.trust_alias_fixture() as fixture:
            fixture.fault = "interrupt-after-hash"
            with self.assertRaises(OSError): M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
            proof = (fixture.base / "tls/aliases.json").read_bytes()
            self.assertEqual(fixture.removed, [fixture.hashed]); fixture.fault = None
            M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
            M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
            self.assertEqual(fixture.removed, [fixture.hashed, fixture.pem])
            self.assertEqual((fixture.base / "tls/aliases.json").read_bytes(), proof)

    def test_alias_cleanup_partial_retry_never_adopts_reappeared_replaced_or_foreign_journal(self):
        for fault in ("reappeared", "replaced", "foreign-journal"):
            with self.subTest(fault=fault), self.trust_alias_fixture() as fixture:
                old_hash = copy.deepcopy(fixture.links[fixture.hashed]); fixture.fault = "interrupt-after-hash"
                with self.assertRaises(OSError): M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
                fixture.fault = None
                if fault == "reappeared":
                    old_hash["info"].st_ino += 100; fixture.links[fixture.hashed] = old_hash
                if fault == "replaced": fixture.links[fixture.pem]["info"].st_ino += 100
                if fault == "foreign-journal":
                    file = fixture.base / "tls/aliases.json"; proof = json.loads(file.read_text()); proof["certificate"] = M.pin(b"foreign")
                    file.write_text(json.dumps(proof))
                with self.assertRaises(RuntimeError): M.cleanup_owned_trust_aliases(fixture.arm, fixture.published)
                self.assertEqual(fixture.removed, [fixture.hashed])

    def test_alias_cleanup_unrelated_trust_drift_still_refuses_exact_before_image_without_foreign_unlink(self):
        with self.trust_alias_fixture() as fixture, patch.object(M, "run_tool", return_value=b""), patch("builtins.print"):
            fixture.links["foreign.pem"]["target"] = "/changed/foreign.crt"
            with self.assertRaisesRegex(RuntimeError, "Original CI trust snapshot not restored"):
                M.tls_cleanup_locked(environment())
            self.assertEqual(fixture.removed, [fixture.hashed, fixture.pem])
            self.assertEqual(fixture.links["foreign.pem"]["target"], "/changed/foreign.crt")

    @unittest.skipUnless(sys.platform == "linux" and hasattr(os, "O_PATH"), "Actual Linux held-symlink syscalls required")
    def test_unix_alias_pair_uses_real_held_symlinks_and_preserves_foreign_target(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); folder = base / "trust"; folder.mkdir(mode=0o755); (base / "tls").mkdir(mode=0o700)
            pem = folder / "creator-production016-update.pem"; hashed = folder / "99383ae7.0"; foreign = folder / "foreign.pem"
            pem.symlink_to(M.TLS_CERT); hashed.symlink_to(pem.name); foreign.symlink_to("/preserved/foreign.crt")
            arm = {"certificate": M.pin(b"synthetic certificate"), "before": {"entries": {foreign.name: {"link": os.readlink(foreign)}}, "bundle": M.pin(b"bundle")}}
            published = {"certificate": arm["certificate"], "stamp": [1, 2, 3]}
            actual = {name: getattr(os, name) for name in ("stat", "lstat", "fstat")}; lexists = os.path.lexists
            def root_metadata(info):
                # Only fixture ownership is injected; fd/readlink/unlink syscalls are real.
                values = {name: getattr(info, name) for name in ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")}
                return SimpleNamespace(**values, st_uid=0, st_gid=0)
            with patch.object(M, "BASE", base), patch.object(M, "TLS_TRUST", folder), \
                 patch.object(M, "protected_ancestry", side_effect=lambda path: self.assertIn(path, (folder, base / "tls"))), \
                 patch.object(M.os, "getuid", return_value=0), patch.object(M.os, "geteuid", return_value=0), \
                 patch.object(M.os, "stat", side_effect=lambda *args, **kwargs: root_metadata(actual["stat"](*args, **kwargs))), \
                 patch.object(M.os, "lstat", side_effect=lambda *args, **kwargs: root_metadata(actual["lstat"](*args, **kwargs))), \
                 patch.object(M.Path, "lstat", autospec=True, side_effect=lambda path: root_metadata(actual["lstat"](path))), \
                 patch.object(M.os, "fstat", side_effect=lambda fd: root_metadata(actual["fstat"](fd))), \
                 patch.object(M.os.path, "lexists", side_effect=lambda file: False if file == M.TLS_CERT else lexists(file)):
                M.cleanup_owned_trust_aliases(arm, published)
                M.cleanup_owned_trust_aliases(arm, published)
                self.assertFalse(pem.is_symlink()); self.assertFalse(hashed.is_symlink())
                self.assertEqual(os.readlink(foreign), "/preserved/foreign.crt")

    def test_tls_before_image_roundtrip_keeps_exact_equality_and_no_diagnostic(self):
        before = self.trust_fixture(); restored = M.parse(json.dumps(before, sort_keys=True).encode())
        self.assertEqual(restored, before)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); (base / "tls").mkdir()
            with patch.object(M, "BASE", base), patch.object(M, "TLS_CERT", base / "absent.crt"), \
                 patch.object(M, "tls_arm", return_value={"before": restored}), patch.object(M, "trust_snapshot", return_value=before), \
                 patch.object(M, "run_tool", side_effect=AssertionError("No trust rebuild without publication")), patch("builtins.print") as printed:
                self.assertTrue(M.tls_cleanup_locked(environment())["originalTrustRestored"])
            printed.assert_not_called(); self.assertFalse(list(base.glob("tls-restore-failure-*.json")))

    def test_tls_bundle_link_mode_and_inventory_drift_remain_refused_with_metadata_only(self):
        before = self.trust_fixture()
        for change in ("bundle", "regular", "link", "mode", "added", "removed"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                base = Path(temp).resolve(); (base / "tls").mkdir(); after = copy.deepcopy(before)
                if change == "bundle": after["bundle"] = M.pin(b"changed synthetic CA bytes never exported")
                if change == "regular": after["entries"]["ca-certificates.crt"]["bytes"] = M.pin(b"changed regular CA bytes never exported")
                if change == "link": after["entries"]["root.pem"]["link"] = "/changed/target-not-exported.crt"
                if change == "mode": after["entries"]["java"]["mode"] = 0o700
                if change == "added": after["entries"]["added.pem"] = {"link": "/added/target-not-exported.crt"}
                if change == "removed": del after["entries"]["root.pem"]
                with patch.object(M, "BASE", base), patch.object(M, "TLS_CERT", base / "absent.crt"), \
                     patch.object(M, "tls_arm", return_value={"before": before}), patch.object(M, "trust_snapshot", return_value=after), \
                     patch.object(M, "run_tool", side_effect=AssertionError("No normalization or retry")), patch("builtins.print"):
                    with self.assertRaisesRegex(RuntimeError, "Original CI trust snapshot not restored"):
                        M.tls_cleanup_locked(environment())
                file = next(base.glob("tls-restore-failure-*.json")); raw = file.read_bytes(); evidence = M.parse(raw)
                self.assertTrue(evidence["certificateAbsent"])
                self.assertEqual(evidence["beforeBundle"], before["bundle"])
                self.assertEqual(evidence["afterBundle"], after["bundle"])
                self.assertEqual(evidence["changeCount"], 0 if change == "bundle" else 1)
                self.assertNotIn(b"synthetic CA bytes", raw); self.assertNotIn(b"target-not-exported", raw)
                self.assertEqual(before, self.trust_fixture(), "Diagnostics cannot replace the original before-image")

    def test_tls_difference_caps_entry_metadata_without_exposing_link_targets(self):
        before = self.trust_fixture(); after = copy.deepcopy(before)
        for index in range(48): after["entries"][f"added-{index:02}.pem"] = {"link": "/do-not-export/CA-target"}
        evidence = M.trust_restore_difference(before, after, True)
        self.assertEqual(evidence["addedCount"], 48); self.assertEqual(evidence["changeCount"], 48)
        self.assertTrue(evidence["truncated"]); self.assertEqual(len(evidence["changes"]), 32)
        self.assertLessEqual(len(json.dumps(evidence).encode()), 128 * 1024)
        self.assertNotIn("do-not-export", json.dumps(evidence))
        self.assertEqual(len(after["entries"]), 51); self.assertEqual(before, self.trust_fixture())

    def test_tls_certificate_presence_and_diagnostic_write_failure_cannot_mask_or_accept_drift(self):
        before = self.trust_fixture()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve(); (base / "tls").mkdir()
            with patch.object(M, "BASE", base), patch.object(M, "TLS_CERT", base / "absent.crt"), \
                 patch.object(M, "tls_arm", return_value={"before": before}), patch.object(M, "trust_snapshot", return_value=before), \
                 patch.object(M.os.path, "lexists", side_effect=(False, True)), patch("builtins.print"):
                with self.assertRaisesRegex(RuntimeError, "Original CI trust snapshot not restored"):
                    M.tls_cleanup_locked(environment())
            file = next(base.glob("tls-restore-failure-*.json")); original = file.read_bytes()
            self.assertFalse(M.parse(original)["certificateAbsent"])
            after = copy.deepcopy(before); after["bundle"] = M.pin(b"changed")
            with patch.object(M, "BASE", base), patch.object(M, "TLS_CERT", base / "absent.crt"), \
                 patch.object(M, "tls_arm", return_value={"before": before}), patch.object(M, "trust_snapshot", return_value=after), \
                 patch.object(M, "save", side_effect=OSError("diagnostic sink refused")), patch("builtins.print", side_effect=OSError("stderr refused")):
                with self.assertRaisesRegex(RuntimeError, "Original CI trust snapshot not restored"):
                    M.tls_cleanup_locked(environment())
            self.assertEqual(file.read_bytes(), original)

    def test_broker_preserves_original_session_failure_through_cleanup(self):
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        broker = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "broker")
        code = ast.unparse(broker)
        self.assertIn("failure = failure or error", code)
        self.assertIn("record['sessionRefusal']", code)
        self.assertIn("raise failure", code)
        self.assertNotIn("terminate(", code); self.assertNotIn("kill(", code)
        self.assertLess(code.index("stage(BASE / 'inputs', env)"), code.index("create_account()"))
        self.assertLess(code.index("prepare_transport("), code.index("prepare_tls("))

    def test_hidden_duplicate_root_or_legacy_backend_refused(self):
        values = [{"pid": 12, "startTime": "120", "executable": "/usr/bin/creator-hub"}, {"pid": 13, "executable": "/usr/bin/python3.10"}]
        answer = {"processes": values, "terminalProcesses": []}
        surface = SimpleNamespace(pid=12, record={"startTime": "120", "executable": "/usr/bin/creator-hub"},
                                  recheck=unittest.mock.Mock(), inventory=SimpleNamespace(sample=unittest.mock.Mock(return_value=answer)))
        M.phase_processes(surface)
        for name in ("creator-hub", "creator-works-mcp-launcher", "creator-project-setup", "creator-mcp-launcher"):
            values[1]["executable"] = "/usr/bin/" + name
            with self.subTest(name=name), self.assertRaises(RuntimeError): M.phase_processes(surface)

    def test_shared_inventory_brackets_every_sample_with_fresh_full_root_guards(self):
        for failure in (None, "before", "sample", "after", "missing-channel", "terminal-only", "wrong-root", "wrong-start", "wrong-image"):
            events = []
            answer = {"processes": [{"pid": 12, "startTime": "120", "executable": "/usr/bin/creator-hub"}], "terminalProcesses": []}
            if failure == "terminal-only": answer = {"processes": [], "terminalProcesses": [{"pid": 12}]}
            if failure == "wrong-root": answer["processes"][0]["pid"] = 13
            if failure == "wrong-start": answer["processes"][0]["startTime"] = "121"
            if failure == "wrong-image": answer["processes"][0]["executable"] = "/foreign/creator-hub"
            original = PermissionError(13, "synthetic", "/proc/5519/exe")
            def check(*, full):
                self.assertTrue(full); events.append("guard")
                if failure == ("before" if len(events) == 1 else "after"):
                    raise RuntimeError("Bound Root changed")
            def sample(wait):
                self.assertIs(wait, M.wait); events.append("sample")
                if failure == "sample": raise original
                return answer
            surface = SimpleNamespace(pid=12, record={"startTime": "120", "executable": "/usr/bin/creator-hub"},
                                      recheck=check, inventory=None if failure == "missing-channel" else SimpleNamespace(sample=sample))
            with self.subTest(failure=failure):
                if failure is None:
                    M.phase_processes(surface)
                    self.assertIs(surface.last_inventory, answer)
                elif failure == "sample":
                    with self.assertRaises(PermissionError) as raised: M.phase_processes(surface)
                    self.assertIs(raised.exception, original)
                else:
                    with self.assertRaises(RuntimeError): M.phase_processes(surface)
                self.assertEqual(events, ["guard"] if failure in ("before", "missing-channel") else
                                 ["guard", "sample"] if failure == "sample" else ["guard", "sample", "guard"])
                if failure is not None: self.assertFalse(hasattr(surface, "last_inventory"))

    def test_initial_and_successor_use_one_inventory_client_without_retaining_old_root(self):
        answers = [{"request": {"sequence": sequence}, "processes": [{"pid": pid, "startTime": str(pid), "executable": "/usr/bin/creator-hub"}],
                    "terminalProcesses": []} for sequence, pid in ((1, 12), (2, 14))]
        client = SimpleNamespace(sample=unittest.mock.Mock(side_effect=answers))
        for answer in answers:
            surface = SimpleNamespace(pid=answer["processes"][0]["pid"], record=answer["processes"][0], recheck=unittest.mock.Mock(), inventory=client)
            M.phase_processes(surface)
            self.assertEqual(surface.last_inventory["request"]["sequence"], answer["request"]["sequence"])
        self.assertEqual(client.sample.call_count, 2)

    def test_permission_protected_uid_process_uses_root_reply_not_unprivileged_enumeration(self):
        original = PermissionError(13, "synthetic protected process", "/proc/5519/exe")
        answer = {"processes": [{"pid": 12, "startTime": "120", "executable": "/usr/bin/creator-hub"},
                                {"pid": 5519, "startTime": "90", "executable": "/usr/bin/fixture-observer"}], "terminalProcesses": []}
        surface = SimpleNamespace(pid=12, record=answer["processes"][0], recheck=unittest.mock.Mock(), helper=None,
                                  native=SimpleNamespace(native_process=unittest.mock.Mock(side_effect=original)),
                                  inventory=SimpleNamespace(sample=unittest.mock.Mock(return_value=answer)))
        path_type = M.Path
        protected = SimpleNamespace(name="5519", stat=lambda: SimpleNamespace(st_uid=M.UID))
        with patch.object(M, "Path", side_effect=lambda p: SimpleNamespace(iterdir=lambda: [protected]) if p == "/proc" else path_type(p)):
            M.phase_processes(surface)
        surface.native.native_process.assert_not_called()
        surface.inventory.sample.assert_called_once_with(M.wait)
        self.assertIs(surface.last_inventory, answer)

    def test_inventory_import_checks_every_sealed_dependency_before_protected_load(self):
        events = []
        sealed = {"sources": {name: {"size": 1, "sha256": "a" * 64} for name in M.INVENTORY_IMPORTS}}
        module = SimpleNamespace(BASE=M.BASE, UID=M.UID, INVENTORY_COHORTS={"update": M.SCENARIOS})
        def bound(file, expected, maximum, *, uid, mode):
            self.assertEqual(file, M.BASE / "scripts" / file.name)
            self.assertEqual(expected, sealed["sources"][file.name]); self.assertEqual((maximum, uid, mode), (2 * 1024**2, 0, 0o444))
            events.append(file.name)
        def spec(name, path):
            self.assertEqual(path, M.BASE / "scripts/native-linux-production-016-migration.py")
            self.assertEqual(events, list(M.INVENTORY_IMPORTS)); events.append("spec")
            return SimpleNamespace(name=name, loader=SimpleNamespace(exec_module=lambda target: events.append("exec")))
        with patch.object(M, "protected_ancestry") as protected, patch.object(M, "bound", side_effect=bound), \
                patch.object(M.importlib.util, "spec_from_file_location", side_effect=spec), \
                patch.object(M.importlib.util, "module_from_spec", return_value=module):
            self.assertIs(M.inventory_observer(sealed), module)
        protected.assert_called_once_with(M.BASE / "scripts")
        self.assertEqual(events, [*M.INVENTORY_IMPORTS, "spec", "exec"])

    def test_missing_tampered_or_writable_inventory_sources_never_reach_module_execution(self):
        sealed = {"sources": {name: {"size": 1, "sha256": "a" * 64} for name in M.INVENTORY_IMPORTS}}
        for missing in M.INVENTORY_IMPORTS:
            changed = copy.deepcopy(sealed); del changed["sources"][missing]
            with self.subTest(missing=missing), patch.object(M, "protected_ancestry"), patch.object(M, "bound"), \
                    patch.object(M.importlib.util, "spec_from_file_location") as spec:
                with self.assertRaises(KeyError): M.inventory_observer(changed)
                spec.assert_not_called()
        for failure in ("ancestry", *M.INVENTORY_IMPORTS):
            def bound(file, *args, **kwargs):
                if file.name == failure: raise RuntimeError("Independent bytes differ")
            with self.subTest(failure=failure), patch.object(M, "protected_ancestry", side_effect=RuntimeError("Unprotected source") if failure == "ancestry" else None), \
                    patch.object(M, "bound", side_effect=bound), patch.object(M.importlib.util, "spec_from_file_location") as spec:
                with self.assertRaises(RuntimeError): M.inventory_observer(sealed)
                spec.assert_not_called()

    def test_inventory_observer_refuses_wrong_fixed_root_uid_or_update_scenario_table(self):
        sealed = {"sources": {name: {"size": 1, "sha256": "a" * 64} for name in M.INVENTORY_IMPORTS}}
        for failure in ("base", "uid", "migration-label", "extra-update"):
            module = SimpleNamespace(BASE=M.BASE, UID=M.UID, INVENTORY_COHORTS={"update": M.SCENARIOS})
            if failure == "base": module.BASE = Path("/foreign")
            if failure == "uid": module.UID += 1
            if failure == "migration-label": module.INVENTORY_COHORTS["update"] = ("migration-guide-cancel",)
            if failure == "extra-update": module.INVENTORY_COHORTS["update"] += ("unknown-update",)
            spec = SimpleNamespace(name="inventory_mismatch_fixture", loader=SimpleNamespace(exec_module=lambda _: None))
            with self.subTest(failure=failure), patch.object(M, "protected_ancestry"), patch.object(M, "bound"), \
                    patch.object(M.importlib.util, "spec_from_file_location", return_value=spec), \
                    patch.object(M.importlib.util, "module_from_spec", return_value=module):
                with self.assertRaisesRegex(RuntimeError, "Fixed shared update inventory cohort differs"):
                    M.inventory_observer(sealed)

    def test_inventory_dependency_closure_imports_from_only_the_copied_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary).resolve()
            for name in M.INVENTORY_IMPORTS:
                self.assertIn(name, M.SOURCES)
                (folder / name).write_bytes((HERE / name).read_bytes())
            spec = importlib.util.spec_from_file_location("sealed_inventory_fixture", folder / M.INVENTORY_IMPORTS[0])
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            for dependency in (module, module.P, module.P.S, module.P.V):
                self.assertEqual(Path(dependency.__file__).parent, folder)
            self.assertEqual(module.INVENTORY_COHORTS["update"], M.SCENARIOS)

    def test_updater_inventory_wiring_keeps_actual_cohort_shared_scanner_and_auth_loop(self):
        tree = ast.parse(Path(M.__file__).read_text())
        funcs = {n.name: ast.unparse(n) for n in tree.body if isinstance(n, ast.FunctionDef)}
        phase = funcs["phase_processes"]
        self.assertNotIn("/proc", phase); self.assertNotIn("except", phase)
        self.assertLess(phase.index("surface.recheck(full=True)"), phase.index("surface.inventory.sample(wait)"))
        self.assertEqual(phase.count("surface.recheck(full=True)"), 2)
        session = funcs["native_session"]
        self.assertEqual(session.count("observer.InventoryClient(env['GITHUB_SHA'], scenario, cohort='update')"), 1)
        self.assertEqual(session.count("inventory=inventory"), 2)
        broker = funcs["broker"]
        self.assertIn("observer = inventory_observer(sealed)", broker)
        self.assertLess(broker.index("observer.serve_inventory("), broker.index("target = BASE / 'result'"))
        self.assertIn("cohort='update'", broker); self.assertIn("pending_proof(root, native, helper, polkit, profile['baseline'])", broker)
        self.assertNotIn("native_process_inventory", broker)

    def test_question_is_distinct_portable_and_deb_source_contract(self):
        self.assertIn("registered helper", M.question(True)); self.assertNotIn("registered helper", M.question(False))
        self.assertIn("0.1.17", M.question(False)); self.assertIn("open Hub tool page will reopen", M.question(True))

    def test_deb_question_matches_production_retained_setup_notice(self):
        source = (HERE.parent / "src-tauri/src/self_update.rs").read_text()
        catalog = (HERE.parent / "src-tauri/src/catalog.rs").read_text()
        quoted = r'("(?:[^"\\]|\\.)*")'
        notice_source = source.split("fn view_notice(", 1)[1].split("fn cache_path(", 1)[0]
        restore = json.loads(re.search(r'if restore_views\s*\{\s*' + quoted, notice_source)[1])
        notice = json.loads(re.search(r'format!\(' + quoted + r', views\.iter\(\)', notice_source)[1])
        setup = json.loads(re.search(r'Self::Setup => ' + quoted, catalog.split("pub fn name(", 1)[1])[1])
        outer = json.loads(re.search(r'handle\.dialog\(\)\.message\(format!\(' + quoted + r', release\.version, view_notice\)', source)[1])
        expected = outer.replace("{}", "0.1.17", 1).replace("{}", notice.replace("{}", setup).replace("{reopening}", restore), 1)
        self.assertEqual(M.question(False), expected)
        self.assertIn("Hub will close these idle views: Creator Project Setup.", expected)
        self.assertNotIn("Your open Hub tool page will reopen.", M.question(False))
        self.assertIn("Your open Hub tool page will reopen.", M.question(True))


if __name__ == "__main__":
    unittest.main()
