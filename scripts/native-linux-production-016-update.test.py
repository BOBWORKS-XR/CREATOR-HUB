"""Pure preflight and explicit GI binding tests. No native application, auth, trust-store or package writes."""
import ast
from contextlib import ExitStack, contextmanager
import copy
import gzip
import hashlib
from html.parser import HTMLParser
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
from unittest.mock import Mock, patch
from types import ModuleType, SimpleNamespace
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


def mcp_receipt():
    # Synthetic unit data, never native preservation evidence.
    mcp = M.load("native-linux-update-mcp")
    def process(pid, image):
        return {"pid": pid, "startTime": str(pid * 10), "parentPid": 20,
                "uids": [M.UID] * 4, "kernelImageSha256": image * 64}
    checks = [{"phase": phase, "handshake": {"ready": True, "server": mcp.SERVER},
               "protocol": {"checked": True, "checks": index + 2, "tools": mcp.TOOLS, "signalsRequested": False},
               "router": process(30, "a"), "sdk": process(31, "b"), "route": {"unit-only": {"sha256": "c" * 64}}}
              for index, phase in enumerate(mcp.PHASES)]
    return {"schemaVersion": 1, "scope": "existing-managed-mcp-update-protocol-only", "checks": checks,
            "reconnect": {"command": str(M.BASE / "result/home" / mcp.ROUTE_BASE / "router-v1/creator-hub-mcp-router"),
                          "handshake": {"ready": True, "server": mcp.SERVER},
                          "protocol": {"checked": True, "checks": 2, "tools": mcp.TOOLS, "signalsRequested": False},
                          "router": process(40, "a"), "sdk": process(41, "b"), "normalEofClose": True},
            "protectedBefore": {"unit-only": "d" * 64}, "protectedAfter": {"unit-only": "d" * 64},
            "originalNormalEofClose": True, "signalsRequested": False,
            "liveAiAccepted": False, "unityAccepted": False, "releaseReady": False}


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
                surface.dialog = False
                surface.recheck = lambda **kwargs: None
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

    def synthetic_useradd_command(self):
        return ["/usr/sbin/useradd", "--uid", "21314", "--user-group", "--create-home", "--home-dir",
                "/var/lib/creator-polkit-fixture", "--shell", "/bin/bash", "--groups", "sudo", "creator-polkit-fixture"]

    def test_exact_synthetic_useradd_capture_matches_unchanged_create_account_call(self):
        command = self.synthetic_useradd_command()
        self.assertEqual(M.public_root_tool(command), "synthetic-useradd")
        tree = ast.parse(Path(M.__file__).read_text())
        account = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "create_account")
        calls = [n for n in ast.walk(account) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "run_tool"]
        self.assertEqual(len(calls), 1); self.assertFalse(calls[0].keywords)
        expression = ast.Expression(body=calls[0].args[0])
        self.assertEqual(eval(compile(expression, "fixed-create-account-command", "eval"),
                              {"__builtins__": {}, "str": str, "UID": M.UID, "USER": M.USER}), command)

    def test_synthetic_useradd_timeout_captures_bounded_output_without_execution_contract_change(self):
        command = self.synthetic_useradd_command()
        original = subprocess.TimeoutExpired(command, 90)
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            def child(actual, **options):
                self.assertEqual(actual, command)
                self.assertEqual(options["timeout"], 90)
                self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
                self.assertEqual(options["cwd"], "/"); self.assertFalse(options["check"])
                self.assertIsNone(options["input"]); self.assertEqual(options["stdin"], subprocess.DEVNULL)
                self.assertEqual(set(options), {"input", "stdin", "stdout", "stderr", "env", "cwd", "timeout", "check"})
                for label in ("stdout", "stderr"):
                    self.assertTrue(stat.S_ISREG(os.fstat(options[label].fileno()).st_mode))
                options["stdout"].write(b"public useradd stdout\n")
                options["stderr"].write(b"e" * 9000)
                raise original
            with patch.object(M.subprocess, "run", side_effect=child) as run, patch("builtins.print") as printed:
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    M.run_tool(command)
            self.assertIs(caught.exception, original); self.assertEqual(run.call_count, 1)
            self.assertEqual(len(printed.call_args_list), 1)
            evidence = json.loads(printed.call_args_list[0].args[0])
            self.assertEqual(evidence["tool"], "synthetic-useradd")
            self.assertEqual(evidence["pidScope"], "controller"); self.assertEqual(evidence["pid"], os.getpid())
            self.assertEqual(evidence["failureType"], "TimeoutExpired"); self.assertIsNone(evidence["returncode"])
            self.assertEqual(evidence["stdout"], {"bytes": len(b"public useradd stdout\n"), "truncated": False, "text": "public useradd stdout\n"})
            self.assertEqual(evidence["stderr"], {"bytes": 9000, "truncated": True, "text": "e" * 8192})
            self.assertFalse(set(evidence) & {"argv", "env", "stdin", "input", "childPid", "poll", "waitStatus"})
            files = list(M.BASE.iterdir()); self.assertEqual(len(files), 1)
            self.assertEqual(files[0].name, f"public-tool-failure-synthetic-useradd-{os.getpid()}.json")
            self.assertEqual(json.loads(files[0].read_text()), evidence)

    def test_synthetic_useradd_changed_argv_input_and_environment_never_expose_output(self):
        command = self.synthetic_useradd_command()
        variants = []
        for index, value in ((0, "/usr/bin/useradd"), (2, "21315"), (6, "/var/lib/foreign"),
                             (8, "/bin/sh"), (10, "sudo,adm"), (11, "foreign-user")):
            changed = command.copy(); changed[index] = value; variants.append(changed)
        variants.extend((command + ["--extra"], command[:-1],
                         command[:-1] + ["--password", "SYNTHETIC_PRIVATE_PASSWORD", command[-1]],
                         command[:-1] + ["-p", "SYNTHETIC_PRIVATE_PASSWORD", command[-1]],
                         [command[0], "--system", *command[1:]],
                         ["/usr/bin/passwd", "creator-polkit-fixture"]))
        cases = [(changed, {}) for changed in variants]
        cases.extend((command, kwargs) for kwargs in ({"input": b"SYNTHETIC_PRIVATE_INPUT"}, {"input": b""},
                     {"env": {"PRIVATE": "SYNTHETIC_PRIVATE_ENV"}}, {"env": {}},
                     {"env": {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}}))
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            for actual, kwargs in cases:
                with self.subTest(command=actual, options=tuple(kwargs)):
                    self.assertIsNone(M.public_root_tool(actual, **kwargs))
                    _, logs = self.public_tool_failure(actual, output=b"SYNTHETIC_PRIVATE_STDOUT",
                                                       error=b"SYNTHETIC_PRIVATE_STDERR", **kwargs)
                    self.assertFalse(logs)
                    self.assertFalse(list(M.BASE.iterdir()))

    def test_synthetic_useradd_nonzero_and_success_preserve_existing_outcomes(self):
        command = self.synthetic_useradd_command()
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            failure, logs = self.public_tool_failure(command, code=23)
            self.assertEqual(str(failure), "Fixed tool failed: useradd")
            self.assertEqual(len(logs), 1)
            self.assertEqual(logs[0]["returncode"], 23)
            self.assertEqual(logs[0]["pidScope"], "controller")
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "BASE", Path(temp).resolve()):
            def child(actual, **options):
                self.assertEqual(actual, command); self.assertEqual(options["timeout"], 90)
                self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
                options["stdout"].write(b"success")
                return SimpleNamespace(returncode=0)
            with patch.object(M.subprocess, "run", side_effect=child) as run, patch("builtins.print") as printed:
                self.assertEqual(M.run_tool(command), b"success")
            self.assertEqual(run.call_count, 1); printed.assert_not_called()
            self.assertFalse(list(M.BASE.iterdir()))

    def test_synthetic_useradd_timeout_publication_failure_preserves_original_exception(self):
        command = self.synthetic_useradd_command(); original = subprocess.TimeoutExpired(command, 90)
        def child(actual, **options):
            self.assertEqual(actual, command); options["stderr"].write(b"public timeout detail")
            raise original
        with patch.object(M.subprocess, "run", side_effect=child) as run, \
             patch.object(M, "save", side_effect=OSError("diagnostic sink unavailable")), \
             patch("builtins.print", side_effect=OSError("diagnostic stderr unavailable")):
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                M.run_tool(command)
        self.assertIs(caught.exception, original); self.assertEqual(run.call_count, 1)

    def test_synthetic_useradd_export_adds_only_fixed_name_and_preserves_original_limit(self):
        tree = ast.parse(Path(M.__file__).read_text())
        exporter = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "export_evidence")
        patterns = [n.args[0].value for n in ast.walk(exporter) if isinstance(n, ast.Call)
                    and ast.unparse(n.func) == "re.fullmatch" and isinstance(n.args[0], ast.Constant)]
        self.assertEqual(len(patterns), 1)
        for tool in ("baseline-dpkg-install", "update-ca-certificates", "synthetic-useradd"):
            self.assertIsNotNone(re.fullmatch(patterns[0], f"public-tool-failure-{tool}-123.json"))
        for name in ("public-tool-failure-useradd-123.json", "public-tool-failure-synthetic-useradd-extra-123.json",
                     "public-tool-failure-synthetic-useradd-0.json", "public-tool-failure-passwd-123.json"):
            self.assertIsNone(re.fullmatch(patterns[0], name))
        self.assertIn("len(diagnostics) <= 8", ast.unparse(exporter))
        self.assertIn("file.lstat().st_uid == 0", ast.unparse(exporter))

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
                 patch.object(M, "baseline_mcp_inputs") as mcp_inputs, \
                 patch.object(M, "packaged_root", return_value=b"fixture packaged ELF"), patch.object(M, "run_tool", side_effect=verified):
                M.stage(folder, {**environment(), "UPDATE_SCENARIO": "portable-approve"})
            mcp_inputs.assert_called_once_with(folder, p, old["files"], verifier)
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

    def test_workflow_html_driver_is_pinned_and_provisioned_for_exactly_three_deb_scenarios(self):
        steps = self.workflow["jobs"]["update"]["steps"]
        selected = [(index, step) for index, step in enumerate(steps)
                    if "cargo install tauri-driver" in step.get("run", "")]
        self.assertEqual(len(selected), 1)
        index, step = selected[0]
        condition = "inputs.scenario == 'deb-native-cancel' || inputs.scenario == 'deb-auth-cancel' || inputs.scenario == 'deb-approve'"
        self.assertEqual(step["if"], condition)
        admitted = re.findall(r"inputs\.scenario == '([^']+)'", step["if"])
        self.assertEqual(tuple(admitted), M.HTML_SCENARIOS)
        for scenario in M.SCENARIOS:
            self.assertEqual(scenario in admitted, scenario.startswith("deb-"))
        self.assertEqual(step["run"], 'cargo install tauri-driver --version 2.1.0 --locked --root "$RUNNER_TEMP/native-linux-production-016-driver"')
        profile = next(i for i, value in enumerate(steps)
                       if value.get("name") == "Bind independent profile and fresh API identities before downloading data")
        stage = next(i for i, value in enumerate(steps) if value.get("run", "").endswith("update.py stage"))
        self.assertLess(profile, index); self.assertLess(index, stage)

    def test_real_gi_binding_step_is_post_apt_site_enabled_and_before_ui(self):
        steps = self.workflow["jobs"]["update"]["steps"]
        command = "/usr/bin/python3 -I -B scripts/native-linux-production-016-update.test.py GenuineGiBinding"
        selected = [i for i, step in enumerate(steps) if step.get("run", "").strip() == command]
        self.assertEqual(len(selected), 1)
        provision = next(i for i, step in enumerate(steps) if "sudo apt-get install" in step.get("run", ""))
        self.assertIn("python3-gi", steps[provision]["run"])
        verifier = next(i for i, step in enumerate(steps) if step.get("run", "").endswith("update.py verifier"))
        self.assertLess(provision, selected[0]); self.assertLess(selected[0], verifier)
        self.assertEqual(set(steps[selected[0]]), {"name", "run"})
        pure = next(step["run"] for step in steps if step.get("name", "").startswith("Pure tests,"))
        self.assertIn("/usr/bin/python3 -I -S -B scripts/native-linux-production-016-update.test.py", pure)
        self.assertNotIn("GenuineGiBinding", pure)

    def test_selected_real_gi_runner_requires_exactly_one_success_and_zero_skips(self):
        tree = ast.parse(Path(__file__).read_text())
        main = next(n for n in tree.body if isinstance(n, ast.If) and ast.unparse(n.test) == "__name__ == '__main__'")
        selected = main.body[0]
        self.assertEqual(ast.unparse(selected.test), "sys.argv[1:] == ['GenuineGiBinding']")
        body = ast.Module(body=copy.deepcopy(selected.body), type_ignores=[])
        for count, success, skips, expected, exit_code in ((1, True, [], [], 0), (0, True, [], [], 1), (2, True, [], [], 1),
                (1, False, [], [], 1), (1, True, [("fixture", "unavailable")], [], 1), (1, True, [], [("fixture", "expected failure")], 1)):
            result = SimpleNamespace(testsRun=count, wasSuccessful=lambda: success, skipped=skips, expectedFailures=expected)
            runner = SimpleNamespace(run=lambda suite: result)
            fake_unittest = SimpleNamespace(defaultTestLoader=SimpleNamespace(loadTestsFromTestCase=lambda case: object()),
                                            TextTestRunner=lambda **kwargs: runner)
            def exit(value): raise SystemExit(value)
            with self.subTest(count=count, success=success, skips=len(skips)), self.assertRaises(SystemExit) as caught:
                exec(compile(body, "actual-real-gi-selection", "exec"),
                     {"unittest": fake_unittest, "GenuineGiBinding": object(), "sys": SimpleNamespace(exit=exit)})
            self.assertEqual(caught.exception.code, exit_code)

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
        common = {**M.FALSE, "initialBitmap": {"nonblank": True}, "successorBitmap": {"nonblank": True}, "mcpProtocol": mcp_receipt(),
                  "privateTargetQualification": M.private_target_qualification(), **dict.fromkeys(("initial16Verified", "nativeConfirmationObserved", "settingsPreserved", "runtimeSurvived", "normalFinalClose"), True)}
        for scenario in M.SCENARIOS:
            evidence = {**common, "nativeActions": ["Not now" if scenario.endswith("native-cancel") else "Update Hub"],
                        "systemActions": ["Authenticate"] if scenario == "deb-approve" else ["Cancel"] if scenario == "deb-auth-cancel" else [],
                        "oldSelectionUnchanged": True, "initialRootSurvived": True, "automaticSuccessor": None, "sealed17Observed": True,
                        "oldRetirementHelperRestored": scenario == "deb-approve"}
            if scenario.endswith("approve"):
                evidence.update(dict.fromkeys(("oldNormalExit", "automaticRestartObserved", "installed17Verified", "fresh17UiVersion", "directPagesObserved"), True)); evidence["automaticSuccessor"] = {"pid": 2}
            if scenario in M.HTML_SCENARIOS:
                phases = ("htmlWebDriver", "successorHtmlWebDriver") if scenario == "deb-approve" else ("htmlWebDriver",)
                for phase in phases:
                    evidence[phase] = dict(probePassed=True, inputCountAtProbe=0, detached=True, toolsClosedAfterRootExit=True,
                                           documentVersion="0.1.17" if phase == "successorHtmlWebDriver" else "0.1.16")
                for phase in phases:
                    for missing in evidence[phase]:
                        incomplete = copy.deepcopy(evidence); incomplete[phase].pop(missing)
                        with self.assertRaises(RuntimeError): M.outcome(scenario, incomplete)
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


class DirectMenuLabels(unittest.TestCase):
    LABELS = {
        "mcp": "M Creator Works MCP AI tools for Unity Included in Hub",
        "setup": "P Project Setup Unity + Creator SDK projects Included in Hub",
    }

    def selection(self, feature, rows):
        # Execute the actual navigation selection, without any native action.
        tree = ast.parse(Path(M.__file__).read_text())
        direct = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "direct_pages")
        loop = next(n for n in direct.body if isinstance(n, ast.For))
        labels = dict(ast.literal_eval(loop.iter))
        nodes = [object() for _ in rows]
        clicks = []
        surface = SimpleNamespace(atspi=SimpleNamespace(Role=SimpleNamespace(PUSH_BUTTON=43)),
            click=lambda control, actions: clicks.append((control, actions)), snapshot=lambda: (rows, nodes))
        function = ast.FunctionDef(name="actual_selection", args=ast.arguments(posonlyargs=[],
            args=[ast.arg(arg=n) for n in ("surface", "label")], kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=copy.deepcopy(loop.body[:4]) + [ast.Return(value=ast.Name(id="candidates", ctx=ast.Load()))], decorator_list=[])
        namespace = dict(vars(M))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "actual-menu-selection", "exec"), namespace)
        selected = namespace["actual_selection"](surface, labels[feature])
        self.assertEqual(clicks, [("suite-trigger", [])])
        return selected, nodes

    @staticmethod
    def row(name, **changes):
        return {"name": name, "role": 43, "showing": True, "enabled": True, "sensitive": True,
                "busy": False, "defunct": False, "tag": "button", "toolkit": "WebKitGTK", **changes}

    def test_actual_4d9_accessibility_names_select_only_the_intended_source_row(self):
        rows = [self.row(name) for name in self.LABELS.values()]
        for index, feature in enumerate(self.LABELS):
            selected, nodes = self.selection(feature, rows)
            self.assertEqual(len(selected), 1)
            self.assertIs(selected[0][1], nodes[index])

    def test_source_html_badges_titles_and_direct_feature_status_match_exact_labels(self):
        class Menu(HTMLParser):
            def __init__(self):
                super().__init__(); self.active, self.parts, self.labels = None, [], {}
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag == "button" and attrs.get("class") == "suite-item" and attrs.get("data-view") in self.LABELS:
                    self.assert_no_label(attrs)
                    self.active, self.parts = attrs["data-view"], []
            @staticmethod
            def assert_no_label(attrs):
                if "aria-label" in attrs: raise AssertionError("Accessible label override requires a new source contract")
            def handle_data(self, text):
                if self.active and text.strip(): self.parts.append(text.strip())
            def handle_endtag(self, tag):
                if tag == "button" and self.active:
                    if self.active in self.labels: raise AssertionError("Duplicate source menu row")
                    self.labels[self.active] = " ".join(self.parts); self.active = None
        Menu.LABELS = self.LABELS
        menu = Menu(); menu.feed((HERE.parent / "src/index.html").read_text(encoding="utf8"))
        self.assertEqual(set(menu.labels), set(self.LABELS))
        for feature, expected in self.LABELS.items():
            self.assertEqual(menu.labels[feature], expected.removesuffix("Included in Hub") + "Checking")
        source = (HERE.parent / "src/app.js").read_text(encoding="utf8")
        self.assertIn("const label = directFeatures ? state?.issue ? 'Unavailable' : 'Included in Hub'", source)
        self.assertIn("byId(`menu-status-${id}`).textContent = directFeatures ? label", source)

    def test_unknown_badges_status_suffixes_and_other_rows_are_not_alternatives(self):
        for feature, label in self.LABELS.items():
            wrong = [label[2:], "X" + label[1:], "M " + label, label + " extra", label.lower(),
                     *[label.replace("Included in Hub", status) for status in ("Checking", "Ready", "Unavailable", "Installed")],
                     self.LABELS["setup" if feature == "mcp" else "mcp"]]
            for name in wrong:
                with self.subTest(feature=feature, name=name), self.assertRaisesRegex(RuntimeError, "One exact first-party"):
                    self.selection(feature, [self.row(name)])

    def test_hidden_wrong_role_and_ambiguous_exact_rows_are_refused(self):
        for feature, label in self.LABELS.items():
            for rows in ([], [self.row(label, showing=False)], [self.row(label, role=11)],
                         [self.row(label), self.row(label)]):
                with self.subTest(feature=feature, rows=rows), self.assertRaisesRegex(RuntimeError, "One exact first-party"):
                    self.selection(feature, rows)

    def test_non_webkit_non_button_or_unready_exact_feature_rows_are_refused(self):
        for feature, label in self.LABELS.items():
            for change in ({"toolkit": "gtk"}, {"toolkit": "unknown"}, {"tag": "input"}, {"tag": "summary"},
                           {"enabled": False}, {"sensitive": False}, {"busy": True}, {"defunct": True}):
                with self.subTest(feature=feature, change=change), self.assertRaisesRegex(RuntimeError, "One exact first-party"):
                    self.selection(feature, [self.row(label, **change)])

    def test_source_selector_wire_identity_and_owned_root_rechecks_stay_before_input(self):
        tree = ast.parse(Path(M.__file__).read_text())
        direct = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "direct_pages")
        code = ast.unparse(direct)
        self.assertIn("surface.source('projects-home-title', optional=True)", code)
        self.assertIn("surface.click('suite-trigger', [])", code)
        self.assertIn("r == row and r['reference'] == ref", code)
        self.assertLess(code.index("surface.recheck(full=True)"), code.index("interface.do_action(0)"))
        self.assertIn("require(len(matches) == 1, 'Navigation changed before input')", code)
        self.assertIn("not any((r['tag'] in ('iframe', 'object', 'embed') for r in rows))", code)


class HtmlActionDiagnostics(unittest.TestCase):
    @staticmethod
    def surface():
        value = M.Surface.__new__(M.Surface)
        value.html_actions = []
        value.record, value.last = {"pid": 42}, []
        return value

    @staticmethod
    def row():
        return {"reference": [":1.4", "/owned/button"], "role": 43,
                "tag": "button", "toolkit": "WebKitGTK", "showing": True}

    def observe(self, interface, *, control="navigation-mcp"):
        surface = self.surface()
        node = SimpleNamespace(get_action_iface=lambda: interface)
        held, entry = surface.html_action_interface(node, self.row(), control)
        count, name = surface.html_action_operands(held, entry)
        return surface, held, count, name

    @staticmethod
    def interface(count=1, name="click", fail=None):
        calls = []
        def invoke(stage, result):
            calls.append(stage)
            if fail == stage:
                raise ValueError("SYNTHETIC_PRIVATE_ACTION_MARKER")
            return result
        return SimpleNamespace(get_n_actions=lambda: invoke("count", count),
            get_action_name=lambda index: invoke("name-" + str(index), name),
            do_action=lambda index: invoke("INPUT", True)), calls

    def test_missing_interface_retains_presence_without_count_or_name_calls(self):
        surface, interface, count, name = self.observe(None)
        self.assertIsNone(interface); self.assertIsNone(count); self.assertIsNone(name)
        self.assertEqual(surface.html_actions[0], {"control": "navigation-mcp",
            "rowSha256": hashlib.sha256(json.dumps(self.row(), sort_keys=True).encode()).hexdigest(),
            "interfacePresent": False, "count": None, "names": []})

    def test_exact_single_getter_values_are_retained_without_input_or_reread(self):
        for name in ("click", "press", "check", ""):
            interface, calls = self.interface(name=name)
            surface, held, count, observed = self.observe(interface)
            self.assertIs(held, interface); self.assertEqual((count, observed), (1, name))
            self.assertEqual(surface.html_actions[0]["names"], [{"index": 0, "value": name}])
            self.assertEqual(calls, ["count", "name-0"])

    def test_non_single_count_preserves_original_short_circuit(self):
        for count in (0, 2, -1, 4096, 10 ** 100):
            interface, calls = self.interface(count=count)
            surface, _, actual, name = self.observe(interface)
            self.assertEqual(actual, count); self.assertIsNone(name)
            self.assertEqual(surface.html_actions[0]["names"], [])
            self.assertEqual(calls, ["count"])
            self.assertLess(len(json.dumps(surface.html_actions)), 1024)

    def test_unknown_names_are_hash_only_and_oversized_names_are_bounded(self):
        private = "SYNTHETIC_PRIVATE_ACTION_MARKER\n"
        for name in (private, "x" * 4097, None, 17):
            interface, calls = self.interface(name=name)
            surface, _, count, actual = self.observe(interface)
            self.assertEqual((count, actual), (1, name))
            raw = json.dumps(surface.html_actions)
            self.assertNotIn(private.strip(), raw); self.assertNotIn("x" * 128, raw)
            self.assertLess(len(raw), 1024); self.assertEqual(calls, ["count", "name-0"])
            if name == private:
                self.assertEqual(surface.html_actions[0]["names"][0]["sha256"], hashlib.sha256(name.encode()).hexdigest())

    def test_getter_exceptions_are_fatal_and_redacted_with_partial_evidence(self):
        for stage in ("interface", "count", "name-0"):
            surface = self.surface(); interface, calls = self.interface(fail=stage)
            def get_interface():
                if stage == "interface": raise ValueError("SYNTHETIC_PRIVATE_ACTION_MARKER")
                return interface
            with self.subTest(stage=stage), self.assertRaisesRegex(RuntimeError, "Owned HTML action metadata unavailable") as error:
                held, entry = surface.html_action_interface(SimpleNamespace(get_action_iface=get_interface), self.row(), "navigation-mcp")
                surface.html_action_operands(held, entry)
            self.assertTrue(error.exception.__suppress_context__)
            self.assertNotIn("SYNTHETIC_PRIVATE_ACTION_MARKER", str(error.exception) + json.dumps(surface.html_actions))
            self.assertEqual(surface.html_actions[0]["error"]["stage"], stage)
            self.assertEqual(surface.html_actions[0]["error"]["type"], "ValueError")
            self.assertNotIn("INPUT", calls)

    def test_only_fixed_controls_and_bounded_observation_count_before_queries(self):
        surface = self.surface(); queries = []
        node = SimpleNamespace(get_action_iface=lambda: queries.append(True))
        with self.assertRaisesRegex(RuntimeError, "Bounded fixed HTML action diagnostic"):
            surface.html_action_interface(node, self.row(), "PRIVATE_UNKNOWN_CONTROL")
        surface.html_actions = [{}] * 64
        with self.assertRaisesRegex(RuntimeError, "Bounded fixed HTML action diagnostic"):
            surface.html_action_interface(node, self.row(), "navigation-home")
        self.assertEqual(queries, [])

    def guard_only(self, function, interface):
        tree = ast.parse(Path(M.__file__).read_text())
        original = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == function)
        body = next(n for n in original.body if isinstance(n, ast.For)).body if function == "direct_pages" else original.body
        index = next(i for i, node in enumerate(body) if "html_action_interface" in ast.unparse(node))
        end = next(i for i in range(index, len(body)) if "Navigation action differs" in ast.unparse(body[i]) or "Home action differs" in ast.unparse(body[i]))
        function_ast = ast.FunctionDef(name="actual_guard", args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=copy.deepcopy(body[index:end + 1]), decorator_list=[])
        surface = self.surface(); events = []
        surface.recheck = lambda full=False: events.append(("recheck", full))
        namespace = dict(vars(M), surface=surface, matches=[SimpleNamespace(get_action_iface=lambda: interface)], row=self.row(), feature="mcp")
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function_ast], type_ignores=[])), "actual-action-guard", "exec"), namespace)
        return namespace["actual_guard"], surface, events

    def test_captured_webkit_press_passes_both_navigation_guards_but_click_and_unknown_refuse(self):
        for function in ("direct_pages", "navigate_home"):
            # Native855 captured one MCP action named press; Home uses the same source-bound HTML button contract.
            for name, passed in (("press", True), ("click", False), ("unknown", False)):
                interface, calls = self.interface(name=name)
                guard, surface, events = self.guard_only(function, interface)
                if passed: guard()
                else:
                    with self.assertRaisesRegex(RuntimeError, "(?:Navigation|Home) action differs"): guard()
                self.assertEqual(events, [("recheck", True)])
                self.assertEqual(calls, ["count", "name-0"])
                self.assertEqual(len(surface.html_actions), 1)

    def test_navigation_absent_or_multi_action_interface_still_refuses_without_name_or_input(self):
        for function in ("direct_pages", "navigate_home"):
            for count in (None, 0, 2):
                interface, calls = self.interface(count=count)
                guard, surface, events = self.guard_only(function, None if count is None else interface)
                with self.assertRaisesRegex(RuntimeError, "(?:Navigation|Home) action differs"): guard()
                self.assertEqual(calls, [] if count is None else ["count"])
                self.assertEqual(surface.html_actions[0]["interfacePresent"], count is not None)
                self.assertEqual(events, [("recheck", True)])

    def test_unknown_exception_class_and_message_do_not_escape(self):
        class SYNTHETIC_PRIVATE_EXCEPTION_TYPE(Exception):
            pass
        def fail():
            raise SYNTHETIC_PRIVATE_EXCEPTION_TYPE("SYNTHETIC_PRIVATE_EXCEPTION_MESSAGE")
        surface = self.surface()
        with self.assertRaisesRegex(RuntimeError, "Owned HTML action metadata unavailable") as error:
            surface.html_action_interface(SimpleNamespace(get_action_iface=fail), self.row(), "navigation-home")
        raw = json.dumps(surface.html_actions) + str(error.exception)
        self.assertNotIn("SYNTHETIC_PRIVATE", raw)
        self.assertEqual(surface.html_actions[0]["error"], {"stage": "interface", "type": "other"})

    def test_source_click_admission_is_not_broadened_and_native_dialog_is_untouched(self):
        tree = ast.parse(Path(M.__file__).read_text())
        surface = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Surface")
        click = ast.unparse(next(n for n in surface.body if isinstance(n, ast.FunctionDef) and n.name == "click"))
        self.assertIn("('click', 'press')", click)
        self.assertIn("('check',)", click)
        self.assertLess(click.index("html_action_operands"), click.index("One reviewed source action required"))
        self.assertLess(click.index("self.recheck(full=True)"), click.index("action.do_action(0)"))
        dialog = ast.unparse(next(n for n in surface.body if isinstance(n, ast.FunctionDef) and n.name == "dialog_action"))
        self.assertNotIn("html_action", dialog)
        self.assertIn("interface.get_action_name(0) == 'click'", dialog)

    def test_existing_failure_ui_exports_action_metadata_without_another_walk(self):
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        final = next(n for n in session.body if isinstance(n, ast.Try)).finalbody
        export_loop = next(n for n in final if isinstance(n, ast.For) and ast.unparse(n.target) == "current")
        save_call = next(n for n in ast.walk(export_loop) if isinstance(n, ast.Call) and ast.unparse(n.func) == "save")
        surface = self.surface(); interface, _ = self.interface(name="press")
        surface, _, _, _ = self.observe(interface)
        surface.record, surface.last = {"pid": 42}, [self.row()]
        retained = eval(compile(ast.Expression(copy.deepcopy(save_call.args[1])), "actual-ui-export", "eval"), {"current": surface})
        self.assertEqual(retained, {"root": surface.record, "snapshot": surface.last,
                                   "htmlButtonActions": surface.html_actions, "axParentDiagnostic": None, "axSnapshotDiagnostic": None})
        self.assertNotIn("snapshot()", ast.unparse(save_call)); self.assertNotIn("walk()", ast.unparse(save_call))


class HomeMenuLabels(unittest.TestCase):
    LABEL = "H Creator Hub Projects"

    def select(self, rows):
        tree = ast.parse(Path(M.__file__).read_text())
        original = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "navigate_home")
        end = next(i for i, n in enumerate(original.body) if "One exact Home navigation control required" in ast.unparse(n))
        body = copy.deepcopy(original.body[:end + 1]) + [ast.Return(value=ast.Name(id="choices", ctx=ast.Load()))]
        function = ast.FunctionDef(name="select", args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="surface")],
            kwonlyargs=[], kw_defaults=[], defaults=[]), body=body, decorator_list=[])
        clicks, nodes = [], [object() for _ in rows]
        surface = SimpleNamespace(click=lambda control, actions: clicks.append((control, actions)),
            snapshot=lambda: (rows, nodes), atspi=SimpleNamespace(Role=SimpleNamespace(PUSH_BUTTON=43)))
        namespace = dict(vars(M))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "actual-home-selection", "exec"), namespace)
        result = namespace["select"](surface)
        self.assertEqual(clicks, [("suite-trigger", [])])
        return result

    def test_actual_captured_home_label_matches_only_exact_ready_webkit_html_button(self):
        row = DirectMenuLabels.row(self.LABEL)
        self.assertEqual(self.select([row])[0][0], row)

    def test_old_caption_unknown_badges_suffixes_and_ambiguous_home_are_refused(self):
        for name in ("Creator Hub Projects", "H Creator Hub Apps and projects", "Creator Hub Apps and projects",
                     "X Creator Hub Projects", self.LABEL + " extra", self.LABEL.lower()):
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "One exact Home"):
                self.select([DirectMenuLabels.row(name)])
        with self.assertRaisesRegex(RuntimeError, "One exact Home"):
            self.select([DirectMenuLabels.row(self.LABEL)] * 2)

    def test_foreign_or_unready_home_is_refused(self):
        for change in ({"toolkit": "gtk"}, {"toolkit": "unknown"}, {"tag": "input"}, {"tag": "summary"},
                       {"showing": False}, {"enabled": False}, {"sensitive": False}, {"busy": True}, {"defunct": True}):
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, "One exact Home"):
                self.select([DirectMenuLabels.row(self.LABEL, **change)])

    def test_source_home_badge_and_integrated_caption_rewrite_match_actual_capture(self):
        class Menu(HTMLParser):
            def __init__(self): super().__init__(); self.active = False; self.parts = []; self.labels = []
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag == "button" and "suite-item" in attrs.get("class", "").split() and attrs.get("data-view") == "hub":
                    if "aria-label" in attrs: raise AssertionError("Home accessibility override requires source review")
                    self.active = True; self.parts = []
            def handle_data(self, text):
                if self.active and text.strip(): self.parts.append(text.strip())
            def handle_endtag(self, tag):
                if tag == "button" and self.active: self.labels.append(" ".join(self.parts)); self.active = False
        menu = Menu(); menu.feed((HERE.parent / "src/index.html").read_text(encoding="utf8"))
        self.assertEqual(menu.labels, ["H Creator Hub Apps and projects"])
        source = (HERE.parent / "src/app.js").read_text(encoding="utf8")
        self.assertIn("if (directFeatures) {", source)
        self.assertIn("menu.querySelector('[data-view=\"hub\"] small').textContent = 'Projects';", source)
        self.assertEqual(menu.labels[0].replace("Apps and projects", "Projects"), self.LABEL)

    def test_home_refusal_rechecks_exact_row_and_wire_reference_before_action(self):
        source = ast.unparse(next(n for n in ast.parse(Path(M.__file__).read_text()).body
                                  if isinstance(n, ast.FunctionDef) and n.name == "navigate_home"))
        self.assertIn("value == row and value['reference'] == ref", source)
        self.assertLess(source.index("Home navigation changed"), source.index("html_action_interface"))
        self.assertLess(source.index("surface.recheck(full=True)"), source.index("action.do_action(0)"))

    def test_changed_menu_reference_refuses_before_interface_or_input(self):
        tree = ast.parse(Path(M.__file__).read_text())
        for function_name in ("direct_pages", "navigate_home"):
            original = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == function_name)
            statements = next(n for n in original.body if isinstance(n, ast.For)).body if function_name == "direct_pages" else original.body
            if function_name == "direct_pages":
                start = next(i for i, n in enumerate(statements) if isinstance(n, ast.Assign)
                             and isinstance(n.targets[0], ast.Tuple) and [v.id for v in n.targets[0].elts] == ["row", "node"])
            else:
                start = next(i for i, n in enumerate(statements) if isinstance(n, ast.Assign)
                             and isinstance(n.targets[0], ast.Tuple) and [v.id for v in n.targets[0].elts] == ["row", "_"])
            end = next(i for i, n in enumerate(statements) if "Navigation changed before input" in ast.unparse(n) or "Home navigation changed" in ast.unparse(n))
            function = ast.FunctionDef(name="identity", args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
                body=copy.deepcopy(statements[start:end + 1]), decorator_list=[])
            row = DirectMenuLabels.row(self.LABEL, reference=[":1.4", "/original"])
            changed = {**row, "reference": [":1.4", "/different"]}
            surface = SimpleNamespace(snapshot=lambda: ([changed], [object()]))
            namespace = dict(vars(M), candidates=[(row, object())], choices=[(row, object())], surface=surface)
            exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "actual-wire-refusal", "exec"), namespace)
            with self.subTest(function=function_name), self.assertRaisesRegex(RuntimeError, "(?:Navigation changed before input|Home navigation changed)"):
                namespace["identity"]()


class FixtureConfigCreationContext(unittest.TestCase):
    ACL = bytes.fromhex("0200000001000700ffffffff02000700e903000004000700ffffffff10000700ffffffff20000700ffffffff")

    @contextmanager
    def fixture(self, *, default=ACL, fault=None, error=None):
        paths = (M.BASE.parent, M.BASE, M.BASE / "result", M.BASE / "result/home", M.BASE / "result/home/config")
        named = {path: SimpleNamespace(st_dev=7, st_ino=100 + i, st_uid=0 if i < 2 else M.UID,
            st_gid=0 if i < 2 else M.UID, st_mode=stat.S_IFDIR | (0o755 if i < 2 else 0o700),
            st_nlink=2, st_size=4096, st_mtime_ns=1, st_ctime_ns=1) for i, path in enumerate(paths)}
        created = copy.copy(named[paths[-1]])
        state = {"default": default, "access": b"SYNTHETIC_ACCESS_ACL", "removed": [], "opened": [], "closed": [], "reads": []}
        held, fd_paths = {}, {}
        if fault == "foreign": named[paths[-1]].st_uid = 0
        if fault == "mode": named[paths[-1]].st_mode = stat.S_IFDIR | 0o777
        if fault == "symlink": named[paths[-1]].st_mode = stat.S_IFLNK | 0o777
        if fault == "parent-mode": named[paths[0]].st_mode = stat.S_IFDIR | 0o777
        if fault == "created-drift": created.st_ino += 1

        def opening(name, flags, **kwargs):
            path = Path(name) if not kwargs else fd_paths[kwargs["dir_fd"]] / name
            self.assertIn(path, paths)
            self.assertEqual(flags, os.O_RDONLY | M.os.O_DIRECTORY | M.os.O_NOFOLLOW | M.os.O_CLOEXEC)
            fd = 1000 + len(held); held[fd] = copy.copy(named[path]); fd_paths[fd] = path
            state["opened"].append(fd)
            if fault == "fd-drift" and path == paths[-1]: held[fd].st_ino += 1
            return fd

        def stating(name, *, dir_fd, follow_symlinks):
            self.assertFalse(follow_symlinks)
            return copy.copy(named[fd_paths[dir_fd] / name])

        def xattr(fd, name):
            self.assertEqual(fd_paths[fd], paths[-1]); state["reads"].append(name)
            self.assertIn(name, ("system.posix_acl_default", "system.posix_acl_access"))
            if error is not None: raise error
            if fault == "named-drift": named[paths[-1]].st_ino += 1
            if fault == "default-drift" and name.endswith("default") and state["reads"].count(name) == 2:
                state["default"] = b"changed default ACL"
            if fault == "access-before-drift" and name.endswith("access") and state["reads"].count(name) == 2:
                state["access"] = b"changed access ACL"
            value = state["default" if name.endswith("default") else "access"]
            if value is None: raise OSError(M.errno.ENODATA, "absent synthetic attribute")
            return value

        def removing(fd, name):
            self.assertEqual(fd_paths[fd], paths[-1]); self.assertEqual(name, "system.posix_acl_default")
            state["removed"].append((fd, name))
            if fault == "remove-error": raise PermissionError(13, "synthetic remove refusal")
            if fault != "default-remains": state["default"] = None
            for info in (named[paths[-1]], held[fd]):
                info.st_ctime_ns += 1
                if fault == "post-mode": info.st_mode = stat.S_IFDIR | 0o755
                if fault == "post-mtime": info.st_mtime_ns += 1
            if fault == "access-changed": state["access"] = b"changed access ACL"
            if fault == "post-parent": named[paths[1]].st_ino += 1

        class Entries:
            def __enter__(self):
                return iter(("SYNTHETIC_PRIVATE_NAME",) if fault == "nonempty" or (fault == "post-nonempty" and state["removed"]) else ())
            def __exit__(self, *args): pass

        with ExitStack() as stack:
            for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"):
                if not hasattr(M.os, name): stack.enter_context(patch.object(M.os, name, 0, create=True))
            if not hasattr(M.errno, "ENODATA"): stack.enter_context(patch.object(M.errno, "ENODATA", 61, create=True))
            for name in ("geteuid", "getegid"):
                stack.enter_context(patch.object(M.os, name, return_value=0, create=True))
            stack.enter_context(patch.object(Path, "is_absolute", side_effect=lambda self: self in paths, autospec=True))
            stack.enter_context(patch.object(Path, "resolve", side_effect=lambda self, **_: self / "redirected" if fault == "canonical" and self == M.BASE else self, autospec=True))
            stack.enter_context(patch.object(Path, "lstat", side_effect=lambda self: copy.copy(named[self]), autospec=True))
            stack.enter_context(patch.object(M.os, "open", side_effect=opening))
            stack.enter_context(patch.object(M.os, "stat", side_effect=stating))
            stack.enter_context(patch.object(M.os, "fstat", side_effect=lambda fd: copy.copy(held[fd])))
            stack.enter_context(patch.object(M.os, "close", side_effect=state["closed"].append))
            stack.enter_context(patch.object(M.os, "scandir", side_effect=lambda fd: Entries()))
            stack.enter_context(patch.object(M.os, "getxattr", side_effect=xattr, create=True))
            stack.enter_context(patch.object(M.os, "removexattr", side_effect=removing, create=True))
            for name in ("chmod", "fchmod", "chown", "umask", "mkdir", "makedirs", "setxattr"):
                stack.enter_context(patch.object(M.os, name, side_effect=AssertionError("Only owned config default ACL removal allowed"), create=True))
            try:
                yield created, state
            finally:
                self.assertEqual(state["closed"], list(reversed(state["opened"])))

    def test_known_44_byte_recipe_is_bound_to_actual_capture(self):
        self.assertEqual(M.pin(self.ACL), {"size": 44, "sha256": "ab93799aeaba2b0cf6f6e4a059b93930ac75d3d0452103c295737a79c6094ff3"})

    def test_known_acl_removes_only_held_new_config_default_and_preserves_access(self):
        with self.fixture() as (created, state):
            result = M.prepare_fixture_config(created)
        self.assertEqual(len(state["removed"]), 1)
        self.assertEqual(state["access"], b"SYNTHETIC_ACCESS_ACL")
        self.assertEqual(result["defaultAclBefore"], {"present": True, **M.pin(self.ACL)})
        self.assertEqual(result["defaultAclAfter"], {"present": False})
        self.assertTrue(result["accessAclUnchanged"]); self.assertTrue(result["changed"])
        self.assertEqual(result["mode"], "0700")
        self.assertNotIn("SYNTHETIC_ACCESS_ACL", json.dumps(result))

    def test_absent_default_acl_is_read_only_and_only_enodata_means_absent(self):
        with self.fixture(default=None) as (created, state):
            result = M.prepare_fixture_config(created)
        self.assertFalse(result["changed"]); self.assertFalse(state["removed"])
        self.assertEqual(result["defaultAclBefore"], {"present": False})
        for code in (1, 13, 95):
            with self.subTest(errno=code), self.fixture(error=OSError(code, "private")) as (created, state), self.assertRaises(OSError):
                M.prepare_fixture_config(created)
            self.assertFalse(state["removed"])

    def test_unknown_or_malformed_default_acl_refuses_without_mutation(self):
        values = (b"", b"x" * 44, self.ACL[:-1], b"\x03" + self.ACL[1:], self.ACL[:12] + b"\x02\x00\x06\x00" + self.ACL[16:],
                  self.ACL[:16] + b"\xea\x03\x00\x00" + self.ACL[20:], "not-bytes", b"x" * 65537)
        for raw in values:
            with self.subTest(value_type=type(raw).__name__), self.fixture(default=raw) as (created, state), self.assertRaises(RuntimeError):
                M.prepare_fixture_config(created)
            self.assertFalse(state["removed"])

    def test_nonempty_foreign_symlink_unsafe_ancestry_and_identity_changes_refuse_before_removal(self):
        for fault in ("canonical", "foreign", "mode", "symlink", "parent-mode", "created-drift", "fd-drift", "named-drift", "default-drift", "access-before-drift", "nonempty"):
            with self.subTest(fault=fault), self.fixture(fault=fault) as (created, state), self.assertRaises(RuntimeError):
                M.prepare_fixture_config(created)
            self.assertFalse(state["removed"])

    def test_removal_or_postcheck_failure_never_retries_or_changes_another_attribute(self):
        for fault in ("remove-error", "default-remains", "post-mode", "post-mtime", "access-changed", "post-parent", "post-nonempty"):
            with self.subTest(fault=fault), self.fixture(fault=fault) as (created, state), self.assertRaises((RuntimeError, OSError)):
                M.prepare_fixture_config(created)
            self.assertEqual(len(state["removed"]), 1)

    def test_broker_prepares_config_immediately_after_new_mkdir_before_descendants_or_root(self):
        tree = ast.parse(Path(M.__file__).read_text())
        broker = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "broker")
        calls = [n for n in ast.walk(broker) if isinstance(n, ast.Call) and ast.unparse(n.func) == "prepare_fixture_config"]
        self.assertEqual(len(calls), 1); self.assertEqual(ast.unparse(calls[0].args[0]), "file.lstat()")
        loop = next(n for n in ast.walk(broker) if isinstance(n, ast.For) and "home/config" in ast.unparse(n.iter))
        self.assertEqual(ast.unparse(loop.body[-1].test), "name == 'home/config'")
        code = ast.unparse(broker)
        self.assertLess(code.index("file.mkdir(mode=448)"), code.index("prepare_fixture_config("))
        self.assertLess(code.index("prepare_fixture_config("), code.index("prepare_tls("))
        self.assertIn("'fixtureConfigCreationContext': config_context", code)

    @unittest.skipUnless(sys.platform == "linux", "Requires Linux default ACLs in an owned pure child; no application or system account")
    def test_real_linux_inherited_exact_acl_0666_then_controlled_config_0644_with_surroundings_unchanged(self):
        worker = r'''
import errno, importlib.util, os, pathlib, stat, sys
source, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("fixture_acl_kernel", source)
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
acl = bytes.fromhex("0200000001000700ffffffff02000700e903000004000700ffffffff10000700ffffffff20000700ffffffff")
assert m.pin(acl)["sha256"] == "ab93799aeaba2b0cf6f6e4a059b93930ac75d3d0452103c295737a79c6094ff3"
assert root.resolve(strict=True) == root and root.stat().st_uid == os.geteuid() and stat.S_IMODE(root.stat().st_mode) == 0o700
uid = os.geteuid()
if uid != 0 and uid not in {os.getegid(), *os.getgroups()}:
    print("SKIP: current UID is unavailable as a fixture group; no ownership override attempted", file=sys.stderr)
    raise SystemExit(77)
def attr(path, name):
    try: return os.getxattr(path, name, follow_symlinks=False)
    except OSError as e:
        if e.errno != errno.ENODATA: raise
        return None
os.setxattr(root, "system.posix_acl_default", acl, follow_symlinks=False)
for case in ("control", "corrected", "unknown", "sibling"):
    base = root / case; base.mkdir(mode=0o755)
    for part in ("result", "result/home", "result/home/config"):
        path = base / part; path.mkdir(mode=0o700)
        # The real broker creates these with its synthetic UID as both owner and group.
        os.chown(path, uid, uid, follow_symlinks=False)
        assert (path.lstat().st_uid, path.lstat().st_gid) == (uid, uid)
original_mask = os.umask(0o022)
def journal(base):
    folder = base / "result/home/config/creator-works-mcp"; folder.mkdir(mode=0o700)
    temporary = folder / "journal.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o666)
    os.write(fd, b"{}"); os.fsync(fd); os.close(fd)
    target = folder / "hosted-operation-outcomes.json"; os.rename(temporary, target)
    return stat.S_IMODE(target.stat().st_mode)
try:
    assert journal(root / "control") == 0o666
    paths = [root, root / "corrected", root / "corrected/result", root / "corrected/result/home", root / "sibling", root / "control/result/home/config"]
    def snapshot(path):
        s = path.stat()
        return (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns,
                attr(path, "system.posix_acl_default"), attr(path, "system.posix_acl_access"))
    before = [snapshot(p) for p in paths]
    m.BASE, m.UID = root / "corrected", uid
    config = m.BASE / "result/home/config"
    access, previous_mode = attr(config, "system.posix_acl_access"), config.stat().st_mode
    assert attr(config, "system.posix_acl_default") == acl and not list(config.iterdir())
    result = m.prepare_fixture_config(config.lstat())
    assert result["changed"] and result["accessAclUnchanged"]
    assert attr(config, "system.posix_acl_default") is None and attr(config, "system.posix_acl_access") == access
    assert config.stat().st_mode == previous_mode and journal(m.BASE) == 0o644
    assert before == [snapshot(p) for p in paths]
    m.BASE = root / "unknown"; config = m.BASE / "result/home/config"
    other = acl[:16] + b"\xea\x03\x00\x00" + acl[20:]
    os.setxattr(config, "system.posix_acl_default", other, follow_symlinks=False)
    before_unknown = snapshot(config)
    try: m.prepare_fixture_config(config.lstat())
    except RuntimeError: pass
    else: raise AssertionError("Unknown ACL accepted")
    assert snapshot(config) == before_unknown and not list(config.iterdir())
    print("Real Linux exact inherited ACL: 0666 control -> 0644 corrected; access/ancestors/sibling unchanged; unknown refused")
finally:
    os.umask(original_mask)
'''
        with tempfile.TemporaryDirectory(prefix="creator-fixture-config-acl-") as folder:
            result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", worker, M.__file__, folder],
                                    stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        if result.returncode == 77:
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b"SKIP: current UID is unavailable as a fixture group; no ownership override attempted\n")
            self.skipTest("Current UID is not an available fixture group; no privilege or system group changes attempted")
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf8", errors="replace"))
        self.assertIn(b"0666 control -> 0644 corrected", result.stdout)

    def test_real_acl_worker_establishes_matching_group_or_explicitly_skips_without_privilege(self):
        tree = ast.parse(Path(__file__).read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
                      and n.name == "test_real_linux_inherited_exact_acl_0666_then_controlled_config_0644_with_surroundings_unchanged")
        worker = ast.parse(next(n.value.value for n in method.body if isinstance(n, ast.Assign)
                                and any(isinstance(t, ast.Name) and t.id == "worker" for t in n.targets)), feature_version=(3, 10))
        uid = next(n for n in worker.body if isinstance(n, ast.Assign) and ast.unparse(n.targets[0]) == "uid")
        gate = next(n for n in worker.body if isinstance(n, ast.If) and "os.getgroups()" in ast.unparse(n.test))
        code = compile(ast.Module(body=[uid, gate], type_ignores=[]), "real-acl-fixture-group-admission", "exec")
        for owner, group, supplementary, skipped in ((1000, 1000, [], False), (1000, 2000, [1000], False),
                                                       (0, 2000, [], False), (1000, 2000, [], True)):
            stderr = io.StringIO()
            namespace = {"os": SimpleNamespace(geteuid=lambda: owner, getegid=lambda: group, getgroups=lambda: supplementary),
                         "sys": SimpleNamespace(stderr=stderr)}
            with self.subTest(owner=owner, group=group, supplementary=supplementary):
                if skipped:
                    with self.assertRaises(SystemExit) as caught: exec(code, namespace)
                    self.assertEqual(caught.exception.code, 77)
                    self.assertEqual(stderr.getvalue(), "SKIP: current UID is unavailable as a fixture group; no ownership override attempted\n")
                else:
                    exec(code, namespace)
                    self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(namespace["uid"], owner)
        cases = next(n for n in worker.body if isinstance(n, ast.For) and ast.unparse(n.target) == "case")
        parts = next(n for n in cases.body if isinstance(n, ast.For))
        self.assertEqual(ast.literal_eval(parts.iter), ("result", "result/home", "result/home/config"))
        self.assertEqual([ast.unparse(n) for n in parts.body], ["path = base / part", "path.mkdir(mode=448)",
            "os.chown(path, uid, uid, follow_symlinks=False)", "assert (path.lstat().st_uid, path.lstat().st_gid) == (uid, uid)"])
        calls = [n for n in ast.walk(worker) if isinstance(n, ast.Call) and ast.unparse(n.func) == "os.chown"]
        self.assertEqual(len(calls), 1)
        self.assertLess(worker.body.index(gate), worker.body.index(cases))
        self.assertLess(worker.body.index(cases), next(i for i, n in enumerate(worker.body) if isinstance(n, ast.Try)))


class InitialRootCreationContext(unittest.TestCase):
    @staticmethod
    def launch_node():
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        matches = [n for n in ast.walk(session) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
                   and ast.unparse(n.value.func) == "subprocess.Popen" and n.value.args
                   and ast.unparse(n.value.args[0]) == "['/usr/bin/creator-hub']"]
        if len(matches) != 1:
            raise AssertionError("Exactly the existing initial Root launch is required")
        return tree, session, matches[0]

    @classmethod
    def launcher(cls, popen, scenario):
        _, _, node = cls.launch_node()
        body = ast.Module(body=[copy.deepcopy(node)], type_ignores=[])
        namespace = {"subprocess": SimpleNamespace(Popen=popen, DEVNULL=subprocess.DEVNULL), "scenario": scenario,
                     "HTML_SCENARIOS": M.HTML_SCENARIOS, "app_env": {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
                     "automation_env": {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TAURI_WEBVIEW_AUTOMATION": "true"}}
        exec(compile(ast.fix_missing_locations(body), "initial-owned-root-launch", "exec"), namespace)
        return namespace["initial"], namespace

    def test_only_existing_initial_root_launch_sets_child_mask_without_parent_mutation(self):
        child = object()
        for scenario in (M.HTML_SCENARIO, "deb-auth-cancel", "deb-approve"):
            launch = Mock(return_value=child)
            with patch.object(M.os, "umask", side_effect=AssertionError("No parent umask changes"), create=True):
                result, namespace = self.launcher(launch, scenario)
            self.assertIs(result, child)
            launch.assert_called_once()
            self.assertEqual(launch.call_args.args, (["/usr/bin/creator-hub"],))
            self.assertEqual(launch.call_args.kwargs, {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL, "env": namespace["automation_env"] if scenario in M.HTML_SCENARIOS else namespace["app_env"],
                "umask": 0o022})
        tree, _, original = self.launch_node()
        modified = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and any(k.arg == "umask" for k in n.keywords)]
        self.assertEqual(modified, [original.value])
        self.assertFalse(any(isinstance(n, ast.Call) and ast.unparse(n.func) == "os.umask" for n in ast.walk(tree)))

    @unittest.skipUnless(sys.platform == "linux", "Requires Linux file modes in an owned pure fixture child; no app or system unit")
    def test_linux_real_fresh_file_0644_under_adversarial_parent_mask_without_changing_parent(self):
        # Only this owned worker changes its mask; it executes the actual launch
        # expression with the Root command replaced by a fresh-file Python child.
        worker = r'''
import ast, os, pathlib, subprocess, sys
source, directory = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
tree = ast.parse(source.read_text())
session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
nodes = [n for n in ast.walk(session) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
         and ast.unparse(n.value.func) == "subprocess.Popen" and n.value.args
         and ast.unparse(n.value.args[0]) == "['/usr/bin/creator-hub']"]
assert len(nodes) == 1
original = os.umask(0)
try:
    control = directory / "adversarial-control"
    fd = os.open(control, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666); os.close(fd)
    assert control.stat().st_mode & 0o777 == 0o666, "Fixture must prove unmasked creation, without a restrictive inherited ACL"
    launches = []
    real_popen = subprocess.Popen
    def launch(command, **kwargs):
        assert command == ["/usr/bin/creator-hub"]
        assert kwargs["umask"] == 0o022
        launches.append(command)
        return real_popen([sys.executable, "-I", "-S", "-B", "-c",
            "import os,sys; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o666); os.close(f)",
            str(directory / "new-journal")], **kwargs)
    class Substitute:
        Popen = staticmethod(launch)
        DEVNULL = subprocess.DEVNULL
    namespace = {"subprocess": Substitute, "scenario": "deb-native-cancel", "HTML_SCENARIOS": ("deb-native-cancel", "deb-auth-cancel", "deb-approve"),
                 "app_env": {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
                 "automation_env": {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), "existing-initial-root", "exec"), namespace)
    assert namespace["initial"].wait(timeout=10) == 0
    assert launches == [["/usr/bin/creator-hub"]]
    assert (directory / "new-journal").stat().st_mode & 0o777 == 0o644
    assert os.umask(0) == 0, "Launching child must not alter the worker parent's adversarial mask"
    print("Owned fresh-file creation 0666 control -> 0644 child; parent mask unchanged; one launch; no app executed")
finally:
    os.umask(original)
'''
        with tempfile.TemporaryDirectory(prefix="creator-update-mask-") as folder:
            result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", worker, M.__file__, folder],
                                    stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf8", errors="replace"))
        self.assertIn(b"parent mask unchanged; one launch; no app executed", result.stdout)

    def test_exact_actual_0666_mode_still_refuses_before_any_journal_content_read(self):
        diagnostic = []
        fixture = JournalMetadataDiagnostics()
        with fixture.fixture(mode=0o666) as (home, reader), self.assertRaisesRegex(RuntimeError, "Read journal ownership/mode differs"):
            M.journal(home, diagnostics=diagnostic)
        reader.assert_not_called()
        self.assertEqual(diagnostic[0]["mode"], 0o666)
        self.assertIsNone(diagnostic[0]["recordCount"])

    @contextmanager
    def acl_fixture(self, *, raw=b"SYNTHETIC_PRIVATE_ACL_BYTES", error=None, fault=None):
        home = M.BASE / "result/home"
        paths = (home, home / "config", home / "config/creator-works-mcp")
        named = {p: SimpleNamespace(st_dev=1, st_ino=100 + index, st_uid=M.UID, st_gid=M.UID,
            st_mode=stat.S_IFDIR | 0o700, st_nlink=2, st_size=4096, st_mtime_ns=1, st_ctime_ns=1)
            for index, p in enumerate(paths)}
        held, opened, closed = {}, [], []
        if fault == "foreign": named[paths[1]].st_uid = 0
        if fault == "symlink": named[paths[1]].st_mode = stat.S_IFLNK | 0o777
        def open_dir(name, flags, **kwargs):
            path = Path(name) if not kwargs else paths[opened.index(kwargs["dir_fd"])] / name
            self.assertIn(path, paths)
            self.assertEqual(flags, os.O_RDONLY | M.os.O_DIRECTORY | M.os.O_NOFOLLOW | M.os.O_CLOEXEC)
            fd = 1000 + len(opened); opened.append(fd); held[fd] = copy.copy(named[path])
            if fault == "opened-drift" and path == paths[1]: held[fd].st_ino += 1
            return fd
        def stat_dir(name, *, dir_fd, follow_symlinks):
            self.assertFalse(follow_symlinks)
            return named[paths[opened.index(dir_fd)] / name]
        def xattr(fd, name):
            self.assertEqual(fd, opened[-1]); self.assertEqual(len(opened), 3)
            self.assertEqual(name, "system.posix_acl_default")
            if fault == "named-drift": named[paths[-1]] = SimpleNamespace(**{**vars(named[paths[-1]]), "st_ino": 999})
            if error is not None: raise error
            return raw
        with ExitStack() as stack:
            for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"):
                if not hasattr(M.os, name): stack.enter_context(patch.object(M.os, name, 0, create=True))
            if not hasattr(M.errno, "ENODATA"): stack.enter_context(patch.object(M.errno, "ENODATA", 61, create=True))
            stack.enter_context(patch.object(Path, "resolve", side_effect=lambda self, **_: self, autospec=True))
            stack.enter_context(patch.object(Path, "lstat", side_effect=lambda self: named[self], autospec=True))
            stack.enter_context(patch.object(M.os, "open", side_effect=open_dir))
            stack.enter_context(patch.object(M.os, "stat", side_effect=stat_dir))
            stack.enter_context(patch.object(M.os, "fstat", side_effect=lambda fd: held[fd]))
            stack.enter_context(patch.object(M.os, "close", side_effect=closed.append))
            reader = stack.enter_context(patch.object(M.os, "getxattr", side_effect=xattr, create=True))
            for name in ("chmod", "fchmod", "chown", "umask", "mkdir", "makedirs"):
                stack.enter_context(patch.object(M.os, name, side_effect=AssertionError("Diagnostic must not mutate"), create=True))
            try:
                yield home, reader
            finally:
                self.assertEqual(closed, list(reversed(opened)))

    def test_default_acl_observation_is_fixed_owned_fd_hash_only_without_mutation(self):
        secret = b"SYNTHETIC_PRIVATE_ACL_BYTES"
        with self.acl_fixture(raw=secret) as (home, reader):
            value = M.owned_journal_directory_acl(home)
        reader.assert_called_once()
        self.assertEqual(value, {"directory": "config/creator-works-mcp", "uid": M.UID, "gid": M.UID,
            "mode": 0o700, "defaultAcl": {"present": True, **M.pin(secret)}})
        self.assertNotIn(secret.decode(), json.dumps(value))

    def test_missing_acl_is_absent_but_unsupported_and_other_errors_are_not_absence(self):
        with self.acl_fixture(error=OSError(getattr(M.errno, "ENODATA", 61), "private")) as (home, _):
            self.assertEqual(M.owned_journal_directory_acl(home)["defaultAcl"], {"present": False})
        for code in (1, 13, 95):
            with self.acl_fixture(error=OSError(code, "private")) as (home, _), self.assertRaises(OSError):
                M.owned_journal_directory_acl(home)

    def test_foreign_symlink_fd_named_drift_and_unbounded_acl_refuse(self):
        for fault in ("foreign", "symlink", "opened-drift", "named-drift"):
            with self.subTest(fault=fault), self.acl_fixture(fault=fault) as (home, reader), self.assertRaises(RuntimeError):
                M.owned_journal_directory_acl(home)
            if fault != "named-drift": reader.assert_not_called()
        for raw in (b"", b"x" * 65537, "not-bytes"):
            with self.acl_fixture(raw=raw) as (home, _), self.assertRaises(RuntimeError):
                M.owned_journal_directory_acl(home)
        with self.acl_fixture() as (home, reader), self.assertRaises(RuntimeError):
            M.owned_journal_directory_acl(home / "other")
        reader.assert_not_called()

    def test_creation_diagnostics_before_input_and_after_refusal_are_bounded_and_readonly(self):
        process = {"pid": 42, "startTime": "7"}; report = {}
        with patch.object(M, "owned_process_umask", return_value={**process, "umask": "0022"}) as mask, \
                patch.object(M, "owned_journal_directory_acl", return_value={"defaultAcl": {"present": False}}) as acl, \
                patch.object(M, "kernel_record", return_value=process), patch.object(M, "save", side_effect=AssertionError("No extra evidence files")):
            for phase in ("before-first-input", "after-refusal"):
                value = M.capture_initial_creation_context(phase, M.BASE / "result/home", process, report, None, None)
                self.assertTrue(value["readOnly"]); self.assertTrue(value["complete"])
            M.capture_initial_creation_context("after-refusal", M.BASE / "result/home", process, report, None, None)
        self.assertEqual(mask.call_count, 2); self.assertEqual(acl.call_count, 2)
        self.assertEqual(len(report["creationContextDiagnostics"]), 2)
        self.assertLess(len(json.dumps(report)), 4096)

    def test_diagnostic_permission_error_and_owned_root_loss_cannot_hide_or_replace_first_failure(self):
        secret = "SYNTHETIC_PRIVATE_CREATION_MARKER"; process = {"pid": 42, "startTime": "7"}
        for fault in ("process", "acl", "final-owner"):
            report = {"refusal": {"type": "RuntimeError", "message": "Original journal refusal"}}
            before = copy.deepcopy(report["refusal"])
            with patch.object(M, "owned_process_umask", side_effect=RuntimeError(secret) if fault == "process" else None,
                              return_value={**process, "umask": "0000"}), \
                    patch.object(M, "owned_journal_directory_acl", side_effect=PermissionError(13, secret) if fault == "acl" else None,
                                 return_value={"defaultAcl": {"present": False}}) as acl, \
                    patch.object(M, "kernel_record", return_value={**process, "startTime": "8"} if fault == "final-owner" else process):
                value = M.capture_initial_creation_context("after-refusal", M.BASE / "result/home", process, report, None, None)
            self.assertFalse(value["complete"]); self.assertIn("unavailable", value)
            if fault == "process": acl.assert_not_called()
            if fault == "acl": self.assertEqual(value["unavailable"], {"type": "PermissionError", "errno": 13})
            self.assertNotIn(secret, json.dumps(report)); self.assertEqual(report["refusal"], before)

    def test_source_binds_diagnostic_before_inputs_and_after_primary_refusal_without_new_actions(self):
        tree, session, _ = self.launch_node()
        calls = [n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "capture_initial_creation_context"]
        self.assertEqual(len(calls), 2)
        before, after = sorted(calls, key=lambda n: n.lineno)
        self.assertEqual(before.args[0].value, "before-first-input"); self.assertEqual(after.args[0].value, "after-refusal")
        startup = next(n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "html.startup")
        ax_startup = next(n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "startup_ui")
        primary = next(n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "retain_refusal_diagnostic")
        self.assertLess(before.lineno, min(startup.lineno, ax_startup.lineno)); self.assertGreater(after.lineno, primary.lineno)
        for name in ("owned_journal_directory_acl", "capture_initial_creation_context"):
            function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            methods = {ast.unparse(n.func) for n in ast.walk(function) if isinstance(n, ast.Call)}
            self.assertFalse(methods & {"subprocess.Popen", "subprocess.run", "save", "os.umask", "os.chmod", "os.fchmod", "os.setxattr", "os.removexattr"})


class JournalMetadataDiagnostics(unittest.TestCase):
    @staticmethod
    def records(session="a" * 64):
        return [{"session": session, "id": index, "command": command, "outcome": "returned-ok"}
                for index, command in ((3, "load_config"), (4, "discover_unity_projects"))]

    @contextmanager
    def fixture(self, records=None, *, uid=None, gid=None, mode=0o644):
        rows = self.records() if records is None else records
        raw = json.dumps({"revision": 1, "records": rows}).encode()
        info = SimpleNamespace(st_uid=M.UID if uid is None else uid, st_gid=M.UID if gid is None else gid, st_mode=stat.S_IFREG | mode)
        with patch.object(Path, "lstat", return_value=info), patch.object(M, "read", return_value=raw) as reader:
            yield Path("synthetic-journal-home"), reader

    def test_ownership_failure_retains_only_already_read_stat_without_reading_contents(self):
        for change in ({"uid": 0}, {"gid": 0}, {"mode": 0o600}):
            evidence = []
            with self.fixture(**change) as (home, reader), self.assertRaisesRegex(RuntimeError, "Read journal ownership/mode differs"):
                M.journal(home, diagnostics=evidence)
            reader.assert_not_called()
            self.assertEqual(len(evidence), 1)
            self.assertEqual(evidence[0]["uid"], change.get("uid", M.UID))
            self.assertEqual(evidence[0]["gid"], change.get("gid", M.UID))
            self.assertEqual(evidence[0]["mode"], change.get("mode", 0o644))
            self.assertIsNone(evidence[0]["recordCount"]); self.assertEqual(evidence[0]["records"], [])

    def test_original_two_reads_ids_and_nonce_contract_still_passes_with_hash_only_sessions(self):
        evidence = []
        previous = {"revision": 1, "records": self.records()}
        records = previous["records"] + self.records("b" * 64)
        with self.fixture(records) as (home, reader):
            value = M.journal(home, previous, diagnostics=evidence)
        self.assertEqual(value["records"], records)
        self.assertEqual((evidence[0]["recordCount"], evidence[0]["prefixCount"], evidence[0]["appendCount"]), (4, 2, 2))
        self.assertEqual([r["id"] for r in evidence[0]["records"]], [3, 4, 3, 4])
        self.assertEqual(evidence[0]["records"][0]["command"], "load_config")
        self.assertEqual(evidence[0]["records"][0]["outcome"], "returned-ok")
        self.assertEqual(evidence[0]["records"][0]["sessionSha256"], hashlib.sha256(("a" * 64).encode()).hexdigest())
        self.assertNotIn("a" * 64, json.dumps(evidence)); self.assertNotIn("b" * 64, json.dumps(evidence))
        reader.assert_called_once()

    def test_zero_one_or_three_appends_still_refuse_after_diagnostic_retention(self):
        for rows in ([], self.records()[:1], self.records() + self.records()[:1]):
            evidence = []
            with self.fixture(rows) as (home, _), self.assertRaisesRegex(RuntimeError, "Exactly one native page read pair"):
                M.journal(home, diagnostics=evidence)
            self.assertEqual(evidence[0]["appendCount"], len(rows))
            self.assertEqual(len(evidence[0]["records"]), len(rows))

    def test_unknown_commands_outcomes_and_extra_fields_do_not_dump_values(self):
        rows = self.records(); secret = "SYNTHETIC_PRIVATE_JOURNAL_VALUE"
        rows[0].update(command=secret, outcome=secret, session=secret, args={"secret": secret}, results=secret, unknown=secret)
        evidence = []
        with self.fixture(rows) as (home, _), self.assertRaises(RuntimeError):
            M.journal(home, diagnostics=evidence)
        raw = json.dumps(evidence)
        self.assertNotIn(secret, raw)
        for field in ("args", "results", "unknown"): self.assertNotIn('"' + field + '"', raw)
        expected = hashlib.sha256(secret.encode()).hexdigest()
        self.assertEqual(evidence[0]["records"][0]["commandSha256"], expected)
        self.assertEqual(evidence[0]["records"][0]["outcomeSha256"], expected)
        self.assertEqual(evidence[0]["records"][0]["sessionSha256"], expected)

    def test_count_schema_and_large_values_remain_bounded_without_acceptance_change(self):
        rows = self.records() * 8 + [{"command": "x" * 4097, "outcome": {"private": True}, "session": "x" * 4097, "id": 10 ** 100}]
        evidence = []
        with self.fixture(rows) as (home, _), self.assertRaisesRegex(RuntimeError, "Bounded exact read journal schema"):
            M.journal(home, diagnostics=evidence)
        self.assertEqual(evidence[0]["recordCount"], 17)
        self.assertEqual(len(evidence[0]["records"]), 16)
        self.assertEqual(evidence[0]["omittedRecords"], 1)
        self.assertLess(len(json.dumps(evidence)), 8192)
        malformed = self.records(); malformed[0].update(command="x" * 4097, session="x" * 4097, id=10 ** 100)
        evidence = []
        with self.fixture(malformed) as (home, _), self.assertRaises(RuntimeError):
            M.journal(home, diagnostics=evidence)
        self.assertIsNone(evidence[0]["records"][0]["id"])
        self.assertNotIn("x" * 128, json.dumps(evidence))

    def test_all_original_prefix_id_command_outcome_and_nonce_refusals_remain(self):
        for change in ({"id": 0}, {"id": 4}, {"id": "3"}, {"command": "unexpected"}, {"outcome": "returned-error"}, {"session": "invalid"}):
            rows = self.records(); rows[0].update(change)
            with self.subTest(change=change), self.fixture(rows) as (home, _), self.assertRaises(RuntimeError):
                M.journal(home, diagnostics=[])
        previous = {"revision": 1, "records": self.records()}
        with self.fixture(self.records("b" * 64) + self.records("c" * 64)) as (home, _), self.assertRaisesRegex(RuntimeError, "Prior read outcomes changed"):
            M.journal(home, previous, diagnostics=[])
        with self.fixture(self.records() * 2) as (home, _), self.assertRaisesRegex(RuntimeError, "Fresh single-session read nonce"):
            M.journal(home, previous, diagnostics=[])

    def test_both_native_journal_calls_attach_diagnostics_to_existing_failure_report(self):
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        calls = [n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "journal"]
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual([(k.arg, ast.unparse(k.value)) for k in call.keywords], [("diagnostics", "report['journalDiagnostics']")])
        self.assertIn("'journalDiagnostics': []", ast.unparse(session))


class StartupPartialEvidence(unittest.TestCase):
    def test_startup_retains_attempts_and_phase_even_if_an_action_raises(self):
        surface, state, waiting = Pure().startup_surface()
        report = {"startupUi": []}; original = RuntimeError("Original action outcome unknown")
        click = surface.click
        def uncertain(control, actions):
            self.assertEqual(report["startupPhase"], control)
            click(control, actions)
            if control == "usage-terms-continue": raise original
        surface.click = uncertain
        with patch.object(M, "wait", side_effect=waiting), self.assertRaises(RuntimeError) as error:
            M.startup_ui(surface, Path("/fixture/home"), first=True, actions=report["startupUi"], progress=report)
        self.assertIs(error.exception, original)
        self.assertEqual(report["startupUi"], ["usage-terms-checkbox", "usage-terms-continue"])
        self.assertEqual(report["startupPhase"], "usage-terms-continue")
        self.assertEqual(surface.call_phase, "startup-ui:usage-terms-continue")
        self.assertEqual(state.actions, report["startupUi"])

    def test_first_lookup_refusal_preserves_original_exception_and_pre_wait_phase(self):
        report = {"startupUi": []}; surface, _, waiting = Pure().startup_surface()
        original = RuntimeError("Missing AX parent")
        def source(control, **kwargs):
            self.assertEqual(report["startupPhase"], "wait-usage-terms")
            self.assertEqual(control, "usage-terms-checkbox")
            raise original
        surface.source = source
        with patch.object(M, "wait", side_effect=waiting), self.assertRaises(RuntimeError) as error:
            M.startup_ui(surface, Path("/fixture/home"), first=True, actions=report["startupUi"], progress=report)
        self.assertIs(error.exception, original)
        self.assertEqual(report["startupUi"], [])
        self.assertEqual(report["startupPhase"], "wait-usage-terms")

    def test_progress_does_not_add_lookups_snapshots_waits_or_actions(self):
        results = []
        for attach in (False, True):
            surface, state, waiting = Pure().startup_surface(); report = {"startupUi": []}
            events = []; source, snapshot, click = surface.source, surface.snapshot, surface.click
            def observed_source(control, **kwargs):
                events.append(("source", control)); return source(control, **kwargs)
            def observed_snapshot(): events.append(("snapshot",)); return snapshot()
            def observed_click(control, actions):
                if attach: self.assertEqual(report["startupPhase"], control)
                events.append(("click", control)); return click(control, actions)
            surface.source, surface.snapshot, surface.click = observed_source, observed_snapshot, observed_click
            with patch.object(M, "wait", side_effect=waiting), patch.object(M, "read", return_value=b'{"autoDownload":false}'):
                result = M.startup_ui(surface, Path("/fixture/home"), first=True,
                                      **({"actions": report["startupUi"], "progress": report} if attach else {}))
            if attach:
                self.assertIs(result, report["startupUi"]); self.assertEqual(report["startupPhase"], "complete")
            results.append((events, state.actions, result))
        self.assertEqual(results[0], results[1])

    def test_caller_publishes_startup_and_page_action_lists_before_entering_functions(self):
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        source = ast.unparse(session)
        self.assertIn("'startupUi': []", source); self.assertIn("'startupPhase': 'not-started'", source)
        call = next(n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "startup_ui")
        options = {k.arg: ast.unparse(k.value) for k in call.keywords}
        self.assertEqual(options["actions"], "report['startupUi']"); self.assertEqual(options["progress"], "report")
        pages = [n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "direct_pages"]
        self.assertEqual(sorted(ast.unparse(n.args[1]) for n in pages),
                         ["report['initialPageActionAttempts']", "report['successorPageActionAttempts']"])


class HtmlAttachmentTests(unittest.TestCase):
    def fixture(self):
        pages_module = M.load("native-linux-integrated-pages")
        surface = SimpleNamespace(pid=12, window=20, record={"pid": 12, "startTime": "100", "parentPid": os.getpid(),
            "uids": [M.UID] * 4, "executable": "/usr/bin/creator-hub", "kernelImageSha256": "a" * 64, "image": {"st_size": "4"}},
            recheck=Mock(), native=SimpleNamespace(), helper=object(), x11=object())
        original = Mock(pid=12); original.poll.return_value = None
        child = Mock(pid=51); child.poll.return_value = None
        logs = Mock(); logs.metadata.return_value = {"stdout": {"truncated": False}, "stderr": {"truncated": False}}
        surface.native.Capture = Mock(return_value=logs)
        records = {51: dict(pid=51, parentPid=os.getpid(), uids=[M.UID] * 4, kernelImageSha256="a" * 64),
                   52: dict(pid=52, parentPid=51, uids=[M.UID] * 4, executable="/usr/bin/WebKitWebDriver", kernelImageSha256="b" * 64)}
        pages = SimpleNamespace(Driver=pages_module.Driver,
            record=Mock(return_value=dict(uid=0, gid=0, mode=0o755, sha256="b" * 64)),
            listener=Mock(return_value=True), subtree=Mock(return_value={52: records[52]}))
        html = M.HtmlPages(surface, original, pages, {"size": 4, "sha256": "a" * 64}, 41000, {"HOME": "/fixed"}, {})
        state = SimpleNamespace(html=html, surface=surface, original=original, child=child, pages=pages,
            records=records, logs=logs, requests=[], selectors={}, changed={}, input_error=None, delete_effect=None)
        def response(request, timeout):
            self.assertEqual(timeout, 15)
            route = request.full_url.removeprefix("http://127.0.0.1:4444")
            body = None if request.data is None else M.parse(request.data)
            state.requests.append((request.method, route, body))
            route = route.removeprefix("/session/owned-session")
            if request.method == "GET" and route == "/status": value = {"ready": True}
            elif request.method == "POST" and route == "/session": value = {"sessionId": "owned-session"}
            elif request.method == "GET" and route in ("/window/handles", "/title", "/url"):
                value = {"/window/handles": ["owned-window"], "/title": "Creator Hub", "/url": "tauri://localhost/"}[route]
                value = state.changed.get(route, value)
            elif request.method == "POST" and route == "/elements":
                selector = body["value"]
                token = "e-" + hashlib.sha256(selector.encode()).hexdigest()[:16]
                state.selectors[token] = selector
                value = [] if selector == "iframe,object,embed" else [{"element-6066-11e4-a52e-4f735466cecf": token}]
                value = state.changed.get(selector + ":elements", value)
            elif route.startswith("/element/"):
                token, endpoint = route[len("/element/"):].split("/", 1)
                selector = state.selectors[token]
                if request.method == "POST":
                    self.assertEqual(endpoint, "click")
                    if state.input_error is not None: raise state.input_error
                    value = None
                elif endpoint == "text":
                    value = {"#platform-status": "Linux", ".footer-version": "0.1.16", "#page-title": "CREATOR HUB"}.get(selector, "")
                elif endpoint in ("displayed", "enabled"): value = True
                elif endpoint == "name": value = "input" if selector == "#usage-terms-checkbox" else "button"
                elif endpoint == "attribute/type": value = "checkbox"
                else: raise AssertionError("Unmodeled read endpoint: " + endpoint)
                value = state.changed.get(selector + ":" + endpoint, value)
            elif request.method == "DELETE" and route == "":
                if state.delete_effect is not None: state.delete_effect()
                value = None
            else: raise AssertionError("Unmodeled finite WebDriver route: " + route)
            raw = json.dumps({"value": value}).encode()
            result = Mock(status=200, headers={"Content-Length": str(len(raw))})
            result.read.return_value = raw
            result.__enter__ = Mock(return_value=result); result.__exit__ = Mock(return_value=False)
            return result
        html.d.http = SimpleNamespace(open=response)
        return state

    @contextmanager
    def native_stubs(self, state):
        with patch.object(M, "bind_html_owner", return_value={"frame": [":1.1", "/frame"], "webRoot": [":1.2", "/web"]}), \
                patch.object(M, "windows", return_value=[20]), patch.object(M, "bound", return_value=b"\x7fELF"), \
                patch.object(M, "run_tool", return_value=b""), patch.object(M.subprocess, "Popen", return_value=state.child), \
                patch.object(M, "kernel_record", side_effect=lambda pid, *_: copy.deepcopy(state.records[pid])), \
                patch.object(M, "phase_processes") as inventory, \
                patch.object(M, "wait", side_effect=lambda check, *args, **kwargs: self.once(check)):
            yield inventory

    def once(self, check):
        value = check(); self.assertTrue(value); return value

    def test_no_input_probe_uses_real_driver_http_contract_and_exact_remote_attachment(self):
        state = self.fixture()
        with self.native_stubs(state) as inventory:
            state.html.start()
        self.assertTrue(state.html.probed); self.assertTrue(state.html.evidence["probePassed"])
        self.assertEqual(state.html.evidence["inputCountAtProbe"], 0)
        self.assertEqual(state.html.evidence["inputAttempts"], [])
        self.assertFalse(state.html.evidence["releaseReady"])
        sessions = [row[2] for row in state.requests if row[:2] == ("POST", "/session")]
        self.assertEqual(sessions, [{"capabilities": {"alwaysMatch": {
            "webkitgtk:browserOptions": {"targetAddress": "127.0.0.1:41000"}, "unhandledPromptBehavior": "ignore"}}}])
        self.assertFalse(any("/click" in route or "execute" in route or route.endswith("/url") and method == "POST"
                             for method, route, _ in state.requests))
        self.assertNotIn("tauri:options", json.dumps(sessions)); self.assertNotIn("binary", json.dumps(sessions))
        self.assertEqual(state.original.pid, state.surface.pid)
        inventory.assert_called_once_with(state.surface)
        self.assertGreaterEqual(state.surface.recheck.call_count, len(state.requests) * 2)
        with self.assertRaises(RuntimeError): state.html.start()

    def test_foreign_or_missing_document_and_nested_document_fail_before_any_input(self):
        for route, value in (("/title", "Other app"), ("/url", "https://foreign.example/"),
                             ("/window/handles", []), ("/window/handles", ["one", "two"]),
                             ("#page-title:text", "Other"),
                             ("iframe,object,embed:elements", [{"element-6066-11e4-a52e-4f735466cecf": "foreign"}])):
            state = self.fixture(); state.changed[route] = value
            with self.subTest(route=route), self.native_stubs(state), self.assertRaises(RuntimeError): state.html.start()
            self.assertFalse(state.html.evidence["probePassed"])
            self.assertEqual(state.html.evidence["inputAttempts"], [])
            self.assertFalse(any(path.endswith("/click") for _, path, _ in state.requests))
            with self.assertRaises(RuntimeError): state.html.click("#suite-trigger", [], "suite-trigger")

    def test_finite_route_boundary_refuses_script_navigation_foreign_sessions_and_unarmed_inputs(self):
        state = self.fixture()
        with self.assertRaises(RuntimeError): state.html.d.request("GET", "/status")
        self.assertEqual(state.requests, [])
        with self.native_stubs(state):
            state.html.start()
            before = len(state.requests)
            prefix = "/session/owned-session"
            for method, route, payload in (
                    ("POST", prefix + "/execute/sync", {"script": "forbidden"}),
                    ("POST", prefix + "/url", {"url": "https://foreign.example"}),
                    ("POST", prefix + "/actions", {}), ("DELETE", prefix + "/window", None),
                    ("POST", prefix + "/back", {}), ("GET", "/session/foreign/title", None),
                    ("GET", prefix + "/element/e/attribute/value", None),
                    ("POST", prefix + "/element/e/click", {}), ("DELETE", prefix, None),
                    ("POST", prefix + "/elements", {"using": "xpath", "value": "//button"}),
                    ("POST", "/session", {"capabilities": {"alwaysMatch": {}}})):
                with self.subTest(route=route), self.assertRaises(RuntimeError):
                    state.html.d.request(method, route, payload)
            self.assertEqual(len(state.requests), before)
            state.html.detach()
            after = len(state.requests)
            with self.assertRaises(RuntimeError): state.html.d.call("GET", "/title")
            self.assertEqual(len(state.requests), after)

    def test_changed_launch_capabilities_and_uncertain_attach_never_get_a_fallback_attempt(self):
        for options in ({"binary": "/usr/bin/creator-hub"}, {"args": []}, {"targetAddress": "127.0.0.1:9"}):
            state = self.fixture()
            with self.assertRaises(RuntimeError):
                state.html.d.request("POST", "/session", {"capabilities": {"alwaysMatch": {"webkitgtk:browserOptions": options}}})
            self.assertEqual(state.requests, []); self.assertFalse(state.html.session_sent)
        state = self.fixture()
        original_transport = state.html.transport
        def interrupted(method, route, *args, **kwargs):
            if (method, route) == ("POST", "/session"):
                raise RuntimeError("No compatible remote session")
            return original_transport(method, route, *args, **kwargs)
        with self.native_stubs(state), patch.object(state.html, "transport", side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, "No compatible remote session"):
                state.html.start()
            self.assertTrue(state.html.session_sent)
            self.assertFalse(state.html.probed)
            self.assertEqual(M.subprocess.Popen.call_count, 1)
            self.assertEqual(M.subprocess.Popen.call_args.args[0],
                             [str(M.BASE / "scripts/tauri-driver"), "--native-driver", "/usr/bin/WebKitWebDriver"])
            with self.assertRaises(RuntimeError): state.html.start()
            self.assertEqual(M.subprocess.Popen.call_count, 1)
        state.original.terminate.assert_not_called(); state.original.kill.assert_not_called()

    def test_own_root_endpoint_modal_renderer_and_popen_changes_are_fatal(self):
        for defect in ("pid", "exit", "endpoint", "foreign-window", "modal", "root-or-renderer"):
            state = self.fixture()
            if defect == "pid": state.original.pid = 13
            if defect == "exit": state.original.poll.return_value = 0
            if defect == "endpoint": state.pages.listener.return_value = False
            if defect == "root-or-renderer": state.surface.recheck.side_effect = RuntimeError("Bound renderer changed")
            with self.subTest(defect=defect), patch.object(M, "windows", return_value=[21] if defect == "foreign-window" else [20, 21] if defect == "modal" else [20]):
                with self.assertRaises(RuntimeError): state.html.root_guard()
            self.assertEqual(state.requests, [])

    def test_wrong_driver_image_or_parent_never_reaches_session_creation(self):
        for defect in ("driver-image", "driver-parent", "driver-uid", "native-image", "native-uid"):
            state = self.fixture()
            target = state.records[52 if defect.startswith("native") else 51]
            target[{"driver-image": "kernelImageSha256", "native-image": "kernelImageSha256",
                    "driver-parent": "parentPid", "driver-uid": "uids", "native-uid": "uids"}[defect]] = (
                [0] * 4 if defect.endswith("uid") else 999 if defect.endswith("parent") else "c" * 64)
            with self.subTest(defect=defect), self.native_stubs(state), self.assertRaises(RuntimeError): state.html.start()
            self.assertFalse(any(route == "/session" for _, route, _ in state.requests))

    def test_only_finite_stable_enabled_actual_html_buttons_receive_one_click(self):
        for defect in (None, "hidden", "disabled", "tag", "ambiguous", "replacement", "unknown-selector"):
            state = self.fixture()
            with self.native_stubs(state): state.html.start()
            actions = []
            selector = "#suite-trigger"
            if defect == "hidden": state.changed[selector + ":displayed"] = False
            if defect == "disabled": state.changed[selector + ":enabled"] = False
            if defect == "tag": state.changed[selector + ":name"] = "a"
            if defect == "ambiguous": state.changed[selector + ":elements"] = [{"element-6066-11e4-a52e-4f735466cecf": "a"}, {"element-6066-11e4-a52e-4f735466cecf": "b"}]
            if defect == "replacement":
                with self.native_stubs(state):
                    original = state.html.d.element(selector)
                state.html.d.element = Mock(side_effect=[original, "replaced-element"])
            if defect == "unknown-selector": selector = "#foreign"
            with self.native_stubs(state):
                if defect is None:
                    state.html.click(selector, actions, "suite-trigger")
                    self.assertEqual(actions, ["suite-trigger"])
                else:
                    with self.assertRaises(RuntimeError): state.html.click(selector, actions, "suite-trigger")
                    self.assertEqual(actions, [])
            self.assertEqual(sum(route.endswith("/click") for _, route, _ in state.requests), 0 if defect else 1)

    def test_uncertain_input_preserves_exception_and_blocks_another_attempt(self):
        state = self.fixture()
        with self.native_stubs(state): state.html.start()
        error = OSError("synthetic transport interruption"); state.input_error = error; actions = []
        with self.native_stubs(state):
            with self.assertRaises(OSError) as raised: state.html.click("#suite-trigger", actions, "suite-trigger")
            self.assertIs(raised.exception, error)
            with self.assertRaises(RuntimeError): state.html.click("#suite-trigger", actions, "suite-trigger")
        self.assertEqual(actions, ["suite-trigger"])
        self.assertEqual(sum(route.endswith("/click") for _, route, _ in state.requests), 1)

    def test_detach_does_not_close_root_and_tool_signals_require_its_zero_exit(self):
        state = self.fixture()
        with self.native_stubs(state):
            state.html.start(); state.html.detach()
            self.assertTrue(state.html.detached); self.assertIsNone(state.original.poll())
            with self.assertRaises(RuntimeError): state.html.detach()
            with self.assertRaises(RuntimeError): state.html.finish_tools()
            state.child.terminate.assert_not_called()
            state.original.poll.return_value = 1
            with self.assertRaises(RuntimeError): state.html.finish_tools()
            state.original.poll.return_value = 0
            with patch.object(state.html, "retain_logs"):
                state.html.finish_tools()
        state.original.terminate.assert_not_called(); state.original.kill.assert_not_called()
        state.child.terminate.assert_called_once(); self.assertTrue(state.html.evidence["toolsClosedAfterRootExit"])
        for defect in ("exit", "pid", "renderer-or-bus"):
            state = self.fixture()
            with self.subTest(defect=defect), self.native_stubs(state):
                state.html.start()
                def changed():
                    if defect == "exit": state.original.poll.return_value = 0
                    elif defect == "pid": state.original.pid = 13
                    else: state.surface.recheck.side_effect = RuntimeError("Original renderer/bus changed during detach")
                state.delete_effect = changed
                with self.assertRaises(RuntimeError): state.html.detach()
                self.assertFalse(state.html.detached)
                with self.assertRaises(RuntimeError): state.html.detach()
                with self.assertRaises(RuntimeError): state.html.finish_tools()
                self.assertEqual(sum(method == "DELETE" for method, _, _ in state.requests), 1)
                state.child.terminate.assert_not_called()
                state.original.terminate.assert_not_called(); state.original.kill.assert_not_called()

    def test_child_only_automation_configuration_never_mutates_parent_or_copies_unknown_flags(self):
        original = {"HOME": "/fixed", "HTTPS_PROXY": "http://127.0.0.1:1"}; before = dict(original)
        reservation = Mock(); reservation.getsockname.return_value = ("127.0.0.1", 41000)
        reservation.__enter__ = Mock(return_value=reservation); reservation.__exit__ = Mock(return_value=False)
        with patch.object(M.socket, "socket", return_value=reservation) as opened:
            actual, port = M.html_automation_environment(original)
            self.assertEqual(original, before); self.assertEqual(port, 41000)
            self.assertEqual(actual, {**before, "TAURI_WEBVIEW_AUTOMATION": "true", "WEBKIT_INSPECTOR_SERVER": "127.0.0.1:41000"})
            reservation.bind.assert_called_once_with(("127.0.0.1", 0))
            for key in ("TAURI_WEBVIEW_AUTOMATION", "WEBKIT_INSPECTOR_SERVER", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"):
                with self.assertRaises(RuntimeError): M.html_automation_environment({**original, key: "foreign"})
            self.assertEqual(opened.call_count, 1)

    def test_owned_log_digests_preserve_eof_counts_and_overflow_refusal(self):
        for defect in (None, "overflow", "size", "foreign-file"):
            state = self.fixture(); state.surface.native.MAX_LOG = 262144
            state.html.logs = state.logs
            state.logs.metadata.return_value = {name: dict(bytes=3, retainedBytes=3, eof=True, truncated=False)
                                                for name in ("stdout", "stderr")}
            if defect == "overflow": state.logs.metadata.return_value["stderr"].update(bytes=300000, truncated=True)
            if defect == "size": state.logs.metadata.return_value["stderr"]["retainedBytes"] = 2
            with self.subTest(defect=defect), patch.object(M, "read", side_effect=RuntimeError("owned file replaced") if defect == "foreign-file" else None,
                                                          return_value=b"log") as reader:
                if defect:
                    with self.assertRaises(RuntimeError): state.html.retain_logs()
                else:
                    state.html.retain_logs()
                    self.assertTrue(state.html.evidence["logs"]["stdout"]["eof"])
                    self.assertEqual(state.html.evidence["logs"]["stdout"]["file"], M.pin(b"log"))
                self.assertTrue(all(call.kwargs == {"uid": M.UID} and call.args[1] == 262144 for call in reader.call_args_list))

    def test_expected_update_modal_is_xres_bound_not_a_general_second_window_exception(self):
        state = self.fixture()
        state.surface.record.update(startTime="100", executable="/usr/bin/creator-hub", kernelImageSha256="a" * 64)
        state.surface.x11 = Mock(); state.surface.helper = Mock()
        state.surface.helper.bound_window.return_value = {"pid": 12, "title": "Update Creator Hub", "client": 4}
        state.html.expected_modal = "Update Creator Hub"
        with patch.object(M, "windows", return_value=[20, 21]):
            state.html.root_guard()
            self.assertEqual(state.surface.helper.Request.call_args.args[1:3], (12, "100"))
            self.assertEqual(state.surface.helper.Request.call_args.args[-2:], ("Update Creator Hub", "ALERT"))
            state.surface.helper.bound_window.return_value = {"pid": 13, "title": "Update Creator Hub", "client": 4}
            with self.assertRaises(RuntimeError): state.html.root_guard()
        state.html.expected_modal = None
        with patch.object(M, "windows", return_value=[20, 21]), self.assertRaises(RuntimeError): state.html.root_guard()
        state.surface.helper.bound_window.side_effect = RuntimeError("foreign PID/title/unmapped/XRes")
        state.html.expected_modal = "Update Creator Hub"
        with patch.object(M, "windows", return_value=[20, 21]), self.assertRaises(RuntimeError): state.html.root_guard()

    def test_native_ownership_envelope_stops_at_verified_webkit_root_not_menu_descendants(self):
        for defect in (None, "foreign", "parent", "cycle", "two-webviews", "unknown-gtk"):
            frame, filler, web = [Mock() for _ in range(3)]
            references = {id(frame): [":1.1", "/frame"], id(filler): [":1.1", "/filler"], id(web): [":1.2", "/web"]}
            for node, pid, role, parent in ((frame, 12, 23, None), (filler, 12, 20, frame), (web, 13, 20, filler)):
                node.get_process_id.return_value = pid; node.get_role.return_value = role
                node.get_parent.return_value = parent; node.get_toolkit_name.return_value = "gtk"
            extra = Mock(); references[id(extra)] = [":1.2", "/extra"]
            extra.get_process_id.return_value = 13; extra.get_parent.return_value = filler
            children = {id(frame): [filler], id(filler): [web]}
            if defect == "foreign": web.get_process_id.return_value = 99
            if defect == "parent": web.get_parent.return_value = extra
            if defect == "cycle": children[id(filler)] = [frame]
            if defect == "two-webviews": children[id(filler)] = [web, extra]
            if defect == "unknown-gtk": filler.get_role.return_value = 43
            surface = SimpleNamespace(pid=12, window=20, x11=object(), renderer=None, native_frame=Mock(return_value=frame), recheck=Mock(),
                references=SimpleNamespace(window=None, identity=lambda node, _: references[id(node)]), helper=SimpleNamespace())
            def bound(node):
                pid = node.get_process_id()
                M.require(pid in (12, 13), "Foreign renderer identity")
                if pid == 13: surface.renderer = {"pid": 13}
            surface.node = Mock(side_effect=bound)
            def known_children(node, limit):
                self.assertEqual(node.get_process_id(), 12, "Never enumerate WebKit HTML, including phantom MENU")
                return children[id(node)]
            surface.helper.fresh_close_children = Mock(side_effect=known_children)
            with self.subTest(defect=defect), patch.object(M, "windows", return_value=[20]):
                if defect:
                    with self.assertRaises(RuntimeError): M.bind_html_owner(surface)
                else:
                    result = M.bind_html_owner(surface)
                    self.assertEqual(result["webRoot"], [":1.2", "/web"])
                    self.assertEqual(surface.node.call_count, 3)
                    self.assertEqual(surface.helper.fresh_close_children.call_count, 2)
                    self.assertEqual(surface.recheck.call_count, 2)
                    self.assertTrue(all(call.kwargs == {"full": True} for call in surface.recheck.call_args_list))

    def test_changed_root_renderer_or_bus_at_probe_completion_cannot_enable_clicks(self):
        state = self.fixture()
        with self.native_stubs(state) as inventory:
            inventory.side_effect = RuntimeError("Fresh Root/renderer/bus proof failed")
            with self.assertRaises(RuntimeError): state.html.start()
            with self.assertRaises(RuntimeError): state.html.click("#suite-trigger", [], "suite-trigger")
        self.assertFalse(state.html.probed); self.assertEqual(state.html.evidence["inputAttempts"], [])

    def test_tampered_pinned_driver_stops_before_tool_launch_or_session(self):
        state = self.fixture()
        with self.native_stubs(state), patch.object(M, "bound", side_effect=RuntimeError("Independent bytes differ")), \
                patch.object(M.subprocess, "Popen") as launch, self.assertRaises(RuntimeError):
            state.html.start()
        launch.assert_not_called(); self.assertEqual(state.requests, [])

    def test_native_close_is_existing_xres_wm_delete_without_ax_tree_or_html_input(self):
        surface = object.__new__(M.Surface)
        surface.recheck, surface.x11 = Mock(), Mock()
        surface.helper, surface.request, surface.window = Mock(), object(), 20
        surface.walk = Mock(side_effect=AssertionError("HTML traversal must not be used to close"))
        surface.snapshot = Mock(side_effect=AssertionError("No HTML snapshot before normal close"))
        surface.close()
        surface.recheck.assert_called_once_with(full=True)
        surface.x11.close_window.assert_called_once_with(20, surface.helper.bound_window.return_value)
        surface.walk.assert_not_called(); surface.snapshot.assert_not_called()
        surface.recheck.side_effect = RuntimeError("Root/window/bus changed")
        with self.assertRaises(RuntimeError): surface.close()
        self.assertEqual(surface.x11.close_window.call_count, 1)

    def test_workflow_and_scope_keep_other_lanes_and_native_gtk_untouched(self):
        source = (HERE / "native-linux-production-016-update.py").read_text()
        workflow = (HERE.parent / ".github/workflows/native-linux-production-016-update.yml").read_text()
        self.assertIn("if scenario in HTML_SCENARIOS:", source)
        self.assertIn("HTML_SCENARIO = \"deb-native-cancel\"", source)
        self.assertEqual(M.HTML_SCENARIOS, ("deb-native-cancel", "deb-auth-cancel", "deb-approve"))
        self.assertIn("if: inputs.scenario == 'deb-native-cancel' || inputs.scenario == 'deb-auth-cancel' || inputs.scenario == 'deb-approve'", workflow)
        self.assertIn('cargo install tauri-driver --version 2.1.0 --locked --root "$RUNNER_TEMP/native-linux-production-016-driver"', workflow)
        self.assertLess(workflow.index("Bind independent profile"), workflow.index("cargo install tauri-driver"))
        self.assertLess(workflow.index("cargo install tauri-driver"), workflow.index("update.py stage"))
        self.assertIn("webkit2gtk-driver", workflow)
        self.assertIn('modal.dialog_action(question(portable)', source)
        self.assertIn('require(initial.returncode == 0, "Cancelled original Root/selector did not close normally")', source)
        self.assertIn('"result/html-driver.stdout", "result/html-driver.stderr"', source)
        tree = ast.parse(source)
        html = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "HtmlPages")
        literals = [n.value for n in ast.walk(html) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        for forbidden in ("/execute/sync", "/execute/async", "__TAURI_INTERNALS__", "invoke", "application", "binary"):
            self.assertNotIn(forbidden, literals)
        self.assertNotIn('surface.snapshot(', ast.unparse(html))
        self.assertIn("range(1, 9)", source)


class HtmlDebLifecycleTests(unittest.TestCase):
    def successor_fixture(self):
        owner = HtmlAttachmentTests()
        old = owner.fixture()
        with owner.native_stubs(old), patch.object(old.html, "retain_logs"):
            old.html.start(); old.html.detach()
            old.original.poll.return_value = 0
            old.html.finish_tools()
        state = owner.fixture()
        transport = state.html.d.http
        state.original = old.original
        record = {"pid": 77, "startTime": "101", "parentPid": os.getpid(), "uids": [M.UID] * 4,
                  "executable": "/usr/bin/creator-hub", "kernelImageSha256": M.FIXED["17"]["hub"]["sha256"],
                  "image": {"st_size": str(M.FIXED["17"]["hub"]["size"])}}
        state.surface.pid, state.surface.record = 77, record
        state.child.pid = 61
        state.records = {61: {**state.records[51], "pid": 61},
                         62: {**state.records[52], "pid": 62, "parentPid": 61}, 77: copy.deepcopy(record)}
        state.pages.subtree.return_value = {62: state.records[62]}
        state.html = M.HtmlPages(state.surface, state.original, state.pages, old.html.driver_pin, old.html.port,
                                 old.html.env, {}, previous=old.html)
        state.html.d.http = transport
        state.changed[".footer-version:text"] = "0.1.17"
        state.old, state.owner = old, owner
        return state

    def test_three_deb_requests_bind_driver_while_portable_requests_do_not(self):
        tree = ast.parse(Path(M.__file__).read_text())
        request = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "request")
        block = next(n for n in request.body if isinstance(n, ast.If) and ast.unparse(n.test) == "scenario in HTML_SCENARIOS")
        code = compile(ast.Module(body=[block], type_ignores=[]), "actual-driver-request-binding", "exec")
        for scenario in M.SCENARIOS:
            reader = Mock(return_value=b"\x7fELFfixed driver")
            namespace = {**vars(M), "scenario": scenario, "env": {"RUNNER_TEMP": "/fixed"}, "result": {}, "read": reader}
            exec(code, namespace)
            if scenario in M.HTML_SCENARIOS:
                self.assertEqual(namespace["result"]["htmlDriver"], {"version": "2.1.0", "pin": M.pin(reader.return_value)})
                self.assertEqual(reader.call_args.args, (Path("/fixed/native-linux-production-016-driver/bin/tauri-driver"), 64 * 1024**2))
                self.assertEqual(reader.call_args.kwargs, {"mode": 0o755})
            else:
                reader.assert_not_called(); self.assertEqual(namespace["result"], {})

    def test_fresh_successor_attachment_uses_same_inherited_port_and_separate_fixed_version(self):
        state = self.successor_fixture()
        old_count = len(state.old.requests)
        with state.owner.native_stubs(state): state.html.start()
        self.assertEqual(state.html.evidence["documentVersion"], "0.1.17")
        self.assertEqual(state.html.evidence["inputCountAtProbe"], 0)
        self.assertEqual(state.html.evidence["inputAttempts"], [])
        self.assertEqual(state.html.port, state.old.html.port)
        self.assertIsNot(state.html.d, state.old.html.d)
        self.assertEqual(sum((method, route) == ("POST", "/session") for method, route, _ in state.requests), 1)
        self.assertEqual(len(state.old.requests), old_count)
        self.assertFalse(any(route.endswith("/click") for _, route, _ in state.requests))
        with self.assertRaises(RuntimeError): state.old.html.d.call("GET", "/title")
        self.assertEqual(len(state.old.requests), old_count)
        state.pages.listener.assert_any_call(77, 41000)

    def test_missing_endpoint_or_wrong_successor_document_never_launches_replacement_or_inputs(self):
        for defect in ("endpoint", "old-version", "unknown-version", "origin", "title"):
            state = self.successor_fixture()
            if defect == "endpoint": state.pages.listener.return_value = False
            if defect == "old-version": state.changed[".footer-version:text"] = "0.1.16"
            if defect == "unknown-version": state.changed[".footer-version:text"] = "0.1.17-modified"
            if defect == "origin": state.changed["/url"] = "https://foreign.example/"
            if defect == "title": state.changed["/title"] = "Foreign app"
            with self.subTest(defect=defect), state.owner.native_stubs(state), self.assertRaises((RuntimeError, AssertionError)):
                state.html.start()
            self.assertFalse(state.html.probed)
            self.assertEqual(state.html.evidence["inputAttempts"], [])
            self.assertFalse(any(route.endswith("/click") for _, route, _ in state.requests))
            state.original.terminate.assert_not_called(); state.original.kill.assert_not_called()

    def test_handoff_requires_old_zero_exit_detach_teardown_and_frozen_phase(self):
        for defect in ("alive", "abnormal-exit", "attached", "tools-open", "old-record", "surface-pid", "surface-record"):
            state = self.successor_fixture()
            if defect == "alive": state.original.poll.return_value = None
            if defect == "abnormal-exit": state.original.poll.return_value = 1
            if defect == "attached": state.old.html.detached = False
            if defect == "tools-open": state.old.html.evidence["toolsClosedAfterRootExit"] = False
            if defect == "old-record": state.old.surface.record["startTime"] = "99"
            if defect == "surface-pid": state.surface.pid = 78
            if defect == "surface-record": state.surface.record["startTime"] = "102"
            with self.subTest(defect=defect), state.owner.native_stubs(state):
                with self.assertRaises(RuntimeError): state.html.start()
                M.subprocess.Popen.assert_not_called()
            self.assertEqual(state.requests, [])

    def test_successor_actual_kernel_pid_start_parent_uid_path_size_and_hash_must_match(self):
        for field, value in (("pid", 78), ("startTime", "102"), ("parentPid", 99), ("uids", [0] * 4),
                             ("executable", "/foreign/creator-hub"), ("kernelImageSha256", "0" * 64), ("image", {"st_size": "1"})):
            state = self.successor_fixture(); state.records[77][field] = value
            with self.subTest(field=field), state.owner.native_stubs(state), self.assertRaises(RuntimeError): state.html.start()
            self.assertEqual(state.requests, [])
        state = self.successor_fixture()
        state.surface.record["parentPid"] = 99
        state.records[77] = copy.deepcopy(state.surface.record)
        state.html.phase_record = json.dumps(state.surface.record, sort_keys=True)
        with state.owner.native_stubs(state), self.assertRaises(RuntimeError): state.html.start()

    def test_successor_detach_refuses_identity_loss_and_never_replays_delete(self):
        state = self.successor_fixture()
        with state.owner.native_stubs(state):
            state.html.start()
            state.delete_effect = lambda: state.records[77].update(startTime="102")
            with self.assertRaises(RuntimeError): state.html.detach()
            self.assertFalse(state.html.detached)
            with self.assertRaises(RuntimeError): state.html.detach()
            with self.assertRaises(RuntimeError): state.html.finish_tools()
        self.assertEqual(sum(method == "DELETE" for method, _, _ in state.requests), 1)
        state.child.terminate.assert_not_called(); state.original.terminate.assert_not_called()

    def test_successor_teardown_consumes_exact_actual_waitpid_zero_exit_once(self):
        state = self.successor_fixture()
        with state.owner.native_stubs(state), patch.object(state.html, "retain_logs"), \
                patch.object(M.os, "WNOHANG", 1, create=True), \
                patch.object(M.os, "waitpid", return_value=(77, 0), create=True) as waited:
            state.html.start(); state.html.detach(); state.html.finish_tools()
            waited.assert_called_once_with(77, 1)
            with self.assertRaises(RuntimeError): state.html.finish_tools()
            waited.assert_called_once()
        self.assertEqual(state.html.evidence["adoptedExit"], {"pid": 77, "startTime": "101", "exitCode": 0})
        self.assertTrue(state.html.evidence["toolsClosedAfterRootExit"])
        state.child.terminate.assert_called_once()
        state.original.terminate.assert_not_called(); state.original.kill.assert_not_called()

    def test_unknown_or_nonzero_adopted_exit_never_signals_tools_or_retries_waitpid(self):
        for result in ((77, 256), (78, 0), (0, 0), ChildProcessError("Not an owned child")):
            state = self.successor_fixture()
            with self.subTest(result=result), state.owner.native_stubs(state), \
                    patch.object(M.os, "WNOHANG", 1, create=True), \
                    patch.object(M.os, "waitstatus_to_exitcode", side_effect=lambda status: status >> 8, create=True), \
                    patch.object(M.os, "waitpid", side_effect=result if isinstance(result, BaseException) else None,
                                 return_value=result, create=True) as waited:
                state.html.start(); state.html.detach()
                with self.assertRaises((RuntimeError, ChildProcessError, AssertionError)): state.html.finish_tools()
                before = waited.call_count
                with self.assertRaises(RuntimeError): state.html.finish_tools()
                self.assertEqual(waited.call_count, before)
            state.child.terminate.assert_not_called()
            self.assertFalse(state.html.evidence["toolsClosedAfterRootExit"] if "toolsClosedAfterRootExit" in state.html.evidence else False)
            self.assertNotIn("adoptedExit", state.html.evidence)

    def test_successor_restoration_never_navigates_to_fake_the_restored_page(self):
        for offered in (False, True):
            state = self.successor_fixture(); html = state.html; open_guide = [offered]
            def optional(selector, endpoint="text"):
                if selector == "#usage-terms-dialog": return None
                if selector == "#convergence-dialog":
                    return "false" if endpoint == "attribute/aria-busy" else "" if open_guide[0] else None
                if selector == "#feature-setup": return True if endpoint == "displayed" else "false"
                raise AssertionError("Unexpected restoration lookup")
            text = {"#convergence-later": "Not now", "#feature-setup h2": "Project Setup",
                    '#feature-setup [data-field="status"]': "Ready", '#feature-setup [data-field="error"]': "",
                    '#feature-setup [data-field="controls"]': None}
            with self.subTest(offered=offered), state.owner.native_stubs(state):
                html.start()
                html.optional = Mock(side_effect=optional); html.d.read = Mock(side_effect=lambda selector, *args: text[selector])
                html.d.elements = Mock(return_value=[])
                def dismiss(selector, actions, label):
                    self.assertEqual((selector, label), ("#convergence-later", "convergence-later"))
                    actions.append(label); open_guide[0] = False
                html.click = Mock(side_effect=dismiss)
                report = {}; html.restored(report)
                self.assertEqual(report["restoredLastTool"], "setup")
                self.assertEqual(report["successorStartupUi"], ["convergence-later"] if offered else [])
                self.assertEqual(html.click.call_count, 1 if offered else 0)

    def test_successor_unexpected_terms_or_recovery_action_refuses_without_input(self):
        for terms in (False, True):
            state = self.successor_fixture(); html = state.html
            with self.subTest(terms=terms), state.owner.native_stubs(state):
                html.start()
                html.optional = Mock(side_effect=lambda selector, endpoint="text":
                    ("" if terms else None) if selector == "#usage-terms-dialog" else "false" if endpoint == "attribute/aria-busy" else "")
                html.d.read = Mock(return_value="Review recovery"); html.click = Mock()
                with self.assertRaises(RuntimeError): html.restored({})
                html.click.assert_not_called()

    def test_separate_successor_log_paths_have_the_same_bounds_and_fixed_export(self):
        state = self.successor_fixture(); state.surface.native.MAX_LOG = 262144; state.html.logs = state.logs
        state.logs.metadata.return_value = {name: {"retainedBytes": 3, "eof": True, "truncated": False} for name in ("stdout", "stderr")}
        with patch.object(M, "read", return_value=b"log") as reader: state.html.retain_logs()
        self.assertEqual([call.args[0] for call in reader.call_args_list],
                         [M.BASE / "result" / ("successor-html-driver." + name) for name in ("stdout", "stderr")])
        self.assertTrue(all(call.args[1] == 262144 and call.kwargs == {"uid": M.UID} for call in reader.call_args_list))
        source = Path(M.__file__).read_text()
        self.assertIn('"result/successor-html-driver.stdout", "result/successor-html-driver.stderr"', source)

    def test_actual_session_orders_detach_before_native_approval_and_fresh_attach_after_old_exit(self):
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        code = ast.unparse(session)
        self.assertLess(code.index("html.detach()"), code.index("modal.dialog_action("))
        self.assertLess(code.index("observe_successor("), code.index("html.finish_tools()"))
        self.assertLess(code.index("html.finish_tools()"), code.index("replacement_html = HtmlPages("))
        self.assertLess(code.index("replacement_html.start()"), code.index("replacement_html.restored("))
        self.assertLess(code.index("replacement_html.detach()"), code.index("replacement.close()"))
        self.assertLess(code.index("replacement.close()"), code.index("replacement_html.finish_tools()"))
        launch = [n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "subprocess.Popen"
                  and n.args and ast.unparse(n.args[0]) == "['/usr/bin/creator-hub']"]
        self.assertEqual(len(launch), 1)
        self.assertIn("automation_env if scenario in HTML_SCENARIOS else app_env", ast.unparse(launch[0]))
        self.assertEqual(code.count("html_automation_environment(app_env)"), 1)
        self.assertIn("previous=html", code)


class EnvelopeDiagnosticTests(unittest.TestCase):
    def fixture(self, *, ready_after=1, web_count=1):
        frame, filler, web, extra = [Mock() for _ in range(4)]
        refs = {id(frame): [":1.1", "/frame"], id(filler): [":1.1", "/filler"],
                id(web): [":1.2", "/web"], id(extra): [":1.2", "/extra"]}
        pids = {id(frame): 12, id(filler): 12, id(web): 13, id(extra): 13}
        for node, role, parent in ((frame, 23, None), (filler, 20, frame), (web, 20, filler), (extra, 20, filler)):
            node.get_process_id.return_value = pids[id(node)]
            node.get_role.return_value = role; node.get_toolkit_name.return_value = "gtk"
            node.get_parent.return_value = parent
        record = {"pid": 12, "startTime": "100", "parentPid": os.getpid(),
                  "uids": [M.UID] * 4, "executable": "/usr/bin/creator-hub",
                  "kernelImageSha256": "a" * 64, "image": {"st_size": "4"}}
        surface = SimpleNamespace(pid=12, record=record, window=20, x11=object(), renderer=None, recheck=Mock(),
            references=SimpleNamespace(window=None, identity=lambda node, owner: refs[id(node)]), helper=SimpleNamespace())
        state = SimpleNamespace(surface=surface, frame=frame, filler=filler, web=web, extra=extra,
                                frame_reads=0, ready=False, child_counts=[], now=0.0, sleeps=[])
        def native_frame():
            state.frame_reads += 1
            state.ready = ready_after is not None and state.frame_reads >= ready_after
            return frame
        surface.native_frame = Mock(side_effect=native_frame)
        def owner(node):
            pid = pids[id(node)]
            M.require(pid in (12, 13), "Foreign fixture node")
            if pid == 13: surface.renderer = {"pid": 13}
        surface.node = Mock(side_effect=owner)
        def children(node, limit):
            self.assertEqual(limit, 8)
            self.assertEqual(pids[id(node)], 12, "Never read HTML descendants")
            values = [filler] if node is frame else ([web, extra][:web_count] if state.ready else [])
            state.child_counts.append(len(values))
            return values
        surface.helper.fresh_close_children = Mock(side_effect=children)
        return state

    @contextmanager
    def acquisition(self, state):
        def sleep(seconds):
            self.assertGreater(seconds, 0); self.assertLessEqual(seconds, 0.05)
            state.sleeps.append(seconds); state.now += seconds
        with patch.object(M.time, "monotonic", side_effect=lambda: state.now), patch.object(M.time, "sleep", side_effect=sleep), \
                patch.object(M, "windows", return_value=[state.surface.window]) as inventory:
            yield inventory

    def test_zero_one_and_multiple_cardinality_are_retained_without_conflation(self):
        for ready_after, count in ((None, 1), (1, 1), (1, 2)):
            state = self.fixture(ready_after=ready_after, web_count=count); diagnostic = {}
            with self.subTest(ready_after=ready_after, count=count), self.acquisition(state):
                if ready_after == 1 and count == 1:
                    M.bind_html_owner(state.surface, diagnostic=diagnostic)
                    self.assertEqual(diagnostic["phase"], "bound")
                else:
                    with self.assertRaisesRegex(RuntimeError, "Native WebView readiness deadline" if ready_after is None else "One bound WebKit root required"):
                        M.bind_html_owner(state.surface, diagnostic=diagnostic)
                    self.assertEqual(diagnostic["phase"], "web-root-not-ready" if ready_after is None else "cardinality")
                expected = 0 if ready_after is None else count
                self.assertEqual(diagnostic["webRootCount"], expected)
                self.assertIs(diagnostic["rendererBound"], ready_after is not None)
                self.assertTrue(diagnostic["walkComplete"])
                if ready_after is None:
                    self.assertGreater(state.frame_reads, 1); self.assertLessEqual(state.frame_reads, 601)
                    self.assertEqual(diagnostic["outcome"], "deadline")
                    self.assertEqual(diagnostic["firstNotReady"]["webRootCount"], 0)
                else:
                    self.assertEqual(state.frame_reads, 1)
                self.assertEqual(diagnostic["nodes"][0], {"depth": 0, "reference": [":1.1", "/frame"],
                    "pid": 12, "role": 23, "toolkit": "gtk", "childCount": 1})
                self.assertEqual(diagnostic["nodes"][1]["childCount"], expected)
                for row in diagnostic["nodes"][2:]:
                    self.assertIsNone(row["role"]); self.assertIsNone(row["childCount"])
                    self.assertNotIn("toolkit", row)
                self.assertLess(len(json.dumps(diagnostic)), 4096)

    def test_diagnostics_use_only_original_getters_and_never_query_text_or_attributes(self):
        state = self.fixture(); diagnostic = {}
        with self.acquisition(state): M.bind_html_owner(state.surface, diagnostic=diagnostic)
        for node in (state.frame, state.filler):
            node.get_process_id.assert_called_once(); node.get_toolkit_name.assert_called_once()
            node.get_role.assert_called_once()
        self.assertEqual(state.web.get_process_id.call_count, 2)
        state.web.get_role.assert_not_called(); state.web.get_toolkit_name.assert_not_called()
        for node in (state.frame, state.filler, state.web, state.extra):
            node.get_name.assert_not_called(); node.get_description.assert_not_called()
            node.get_attributes.assert_not_called(); node.get_state_set.assert_not_called()
            node.get_child_count.assert_not_called(); node.get_child_at_index.assert_not_called()
        self.assertEqual(state.surface.helper.fresh_close_children.call_count, 2)

    def test_partial_child_read_keeps_same_exception_and_never_invents_zero_count(self):
        state = self.fixture(); diagnostic = {}
        original = RuntimeError("SYNTHETIC_PRIVATE_CHILD_ERROR")
        child_reader = state.surface.helper.fresh_close_children.side_effect
        def failed(node, limit):
            if node is state.filler: raise original
            return child_reader(node, limit)
        state.surface.helper.fresh_close_children.side_effect = failed
        with self.acquisition(state), self.assertRaises(RuntimeError) as caught:
            M.bind_html_owner(state.surface, diagnostic=diagnostic)
        self.assertIs(caught.exception, original)
        self.assertFalse(diagnostic["walkComplete"]); self.assertEqual(diagnostic["phase"], "node-children")
        self.assertIsNone(diagnostic["nodes"][-1]["childCount"])
        self.assertNotIn("SYNTHETIC_PRIVATE", json.dumps(diagnostic))
        self.assertEqual(state.frame_reads, 1)
        state.surface.recheck.assert_called_once_with(full=True)

    def test_unknown_toolkit_is_hashed_and_short_circuit_role_read_is_preserved(self):
        state = self.fixture(); diagnostic = {}
        private = "SYNTHETIC_PRIVATE_TOOLKIT"
        state.filler.get_toolkit_name.return_value = private
        with self.acquisition(state), self.assertRaisesRegex(RuntimeError, "Unknown native container before WebView"):
            M.bind_html_owner(state.surface, diagnostic=diagnostic)
        row = diagnostic["nodes"][-1]
        self.assertEqual(row["toolkitSha256"], hashlib.sha256(private.encode()).hexdigest())
        self.assertNotIn(private, json.dumps(diagnostic))
        self.assertFalse(diagnostic["walkComplete"]); state.filler.get_role.assert_not_called()
        self.assertIsNone(row["role"]); self.assertIsNone(row["childCount"])

    def test_envelope_refusal_survives_start_and_is_retained_before_any_tool_launch(self):
        state = self.fixture(ready_after=None)
        pages = M.load("native-linux-integrated-pages")
        html = M.HtmlPages(state.surface, Mock(pid=12), pages, {"size": 4, "sha256": "a" * 64}, 41000, {}, {})
        with self.acquisition(state), patch.object(M.subprocess, "Popen") as launch, self.assertRaisesRegex(RuntimeError, "Native WebView readiness deadline"):
            html.start()
        self.assertEqual(html.evidence["envelopeDiagnostic"]["webRootCount"], 0)
        self.assertFalse(html.evidence["envelopeDiagnostic"]["rendererBound"])
        self.assertEqual(html.evidence["phase"], "native-envelope")
        self.assertEqual(html.evidence["inputAttempts"], [])
        self.assertFalse(html.probed); launch.assert_not_called()

    def test_complete_zero_then_one_is_ready_under_one_original_deadline(self):
        state = self.fixture(ready_after=2); diagnostic = {}
        # The real strict reader makes both count reads in each coherent snapshot.
        reader = M.load("native-unix-window").fresh_close_children
        state.frame.get_child_count.return_value = 1
        state.frame.get_child_at_index.return_value = state.filler
        state.filler.get_child_count.side_effect = lambda: 1 if state.ready else 0
        state.filler.get_child_at_index.return_value = state.web
        state.surface.helper.fresh_close_children = Mock(side_effect=reader)
        with self.acquisition(state) as inventory:
            result = M.bind_html_owner(state.surface, diagnostic=diagnostic)
        self.assertEqual(result["webRoot"], [":1.2", "/web"])
        self.assertEqual((diagnostic["attempts"], diagnostic["notReadyCount"]), (2, 1))
        self.assertEqual(state.frame_reads, 2); self.assertEqual(state.sleeps, [0.05])
        self.assertEqual(state.surface.recheck.call_count, 4); self.assertEqual(inventory.call_count, 4)
        self.assertEqual(state.filler.get_child_count.call_count, 4)
        self.assertEqual(state.filler.get_child_at_index.call_count, 1)
        self.assertEqual(diagnostic["firstNotReady"]["nodes"][1]["childCount"], 0)
        self.assertEqual(diagnostic["nodes"][1]["childCount"], 1)
        self.assertIsNot(diagnostic["firstNotReady"]["nodes"], diagnostic["nodes"])
        self.assertEqual(diagnostic["outcome"], "bound")
        state.web.get_child_count.assert_not_called(); state.web.get_attributes.assert_not_called()

    def test_native_frame_loading_consumes_the_same_budget_not_an_additional_window(self):
        state = self.fixture(ready_after=2); diagnostic = {}
        def almost_expired_frame():
            state.frame_reads += 1; state.now = 29.99
            return None
        state.surface.native_frame.side_effect = almost_expired_frame
        with self.acquisition(state), self.assertRaisesRegex(RuntimeError, "Native WebView readiness deadline"):
            M.bind_html_owner(state.surface, diagnostic=diagnostic)
        self.assertEqual(state.frame_reads, 1); self.assertEqual(state.now, 30)
        self.assertEqual(diagnostic["firstNotReady"]["phase"], "frame-not-ready")
        self.assertEqual(diagnostic["firstNotReady"]["nodes"], [])
        self.assertEqual(state.surface.recheck.call_count, 2)

    def test_absent_frame_can_become_one_root_with_full_guards_on_both_reads(self):
        state = self.fixture(ready_after=2); diagnostic = {}
        original = state.surface.native_frame.side_effect
        def first_absent():
            frame = original()
            return None if state.frame_reads == 1 else frame
        state.surface.native_frame.side_effect = first_absent
        with self.acquisition(state): result = M.bind_html_owner(state.surface, diagnostic=diagnostic)
        self.assertEqual(result["webRoot"], [":1.2", "/web"])
        self.assertEqual(diagnostic["firstNotReady"]["phase"], "frame-not-ready")
        self.assertEqual(state.surface.recheck.call_count, 4)

    def test_zero_then_partial_foreign_multiple_or_frame_change_refuses_without_retry(self):
        for defect in ("partial", "foreign-node", "multiple", "frame-wire", "root-bus-loss", "foreign-window"):
            state = self.fixture(ready_after=2, web_count=2 if defect == "multiple" else 1); diagnostic = {}
            error = RuntimeError("Original finite ownership/read refusal")
            original_owner, original_children = state.surface.node.side_effect, state.surface.helper.fresh_close_children.side_effect
            if defect == "partial":
                def children(node, limit):
                    if state.frame_reads == 2 and node is state.filler: raise error
                    return original_children(node, limit)
                state.surface.helper.fresh_close_children.side_effect = children
            if defect == "foreign-node":
                def owner(node):
                    if node is state.web: raise error
                    return original_owner(node)
                state.surface.node.side_effect = owner
            if defect == "frame-wire":
                identity = state.surface.references.identity
                state.surface.references.identity = lambda node, owner: ([":1.1", "/changed"]
                    if state.frame_reads == 2 and node is state.frame else identity(node, owner))
            if defect == "root-bus-loss":
                calls = []
                def guard(**kwargs):
                    calls.append(kwargs)
                    if len(calls) == 3: raise error
                state.surface.recheck.side_effect = guard
            with self.subTest(defect=defect), self.acquisition(state) as inventory:
                if defect == "foreign-window": inventory.side_effect = [[20], [20], [20, 21]]
                with self.assertRaises(RuntimeError) as caught:
                    M.bind_html_owner(state.surface, diagnostic=diagnostic)
            if defect in ("partial", "foreign-node", "root-bus-loss"): self.assertIs(caught.exception, error)
            self.assertEqual(diagnostic["notReadyCount"], 1); self.assertEqual(diagnostic["attempts"], 2)
            self.assertEqual(state.sleeps, [0.05])
            self.assertEqual(diagnostic["firstNotReady"]["webRootCount"], 0)
            self.assertEqual(diagnostic["firstNotReady"]["nodes"][1]["childCount"], 0)
            self.assertIs(diagnostic["rendererBound"], defect == "multiple")

    def test_zero_after_an_existing_renderer_binding_is_never_startup_not_ready(self):
        state = self.fixture(ready_after=None); diagnostic = {}
        state.surface.renderer = {"pid": 13}
        with self.acquisition(state), self.assertRaisesRegex(RuntimeError, "WebKit root missing after a renderer was bound"):
            M.bind_html_owner(state.surface, diagnostic=diagnostic)
        self.assertEqual(state.frame_reads, 1); self.assertEqual(state.sleeps, [])
        self.assertIsNone(diagnostic["firstNotReady"])

    def test_foreign_modal_or_post_read_root_frame_loss_never_qualifies_or_launches(self):
        for defect in ("pre-window", "post-window", "post-root", "post-frame-wire"):
            state = self.fixture(); diagnostic = {}; error = RuntimeError("Bound Root ownership changed after read")
            if defect == "post-root":
                calls = []
                def root_guard(**kwargs):
                    calls.append(kwargs)
                    if len(calls) == 2: raise error
                state.surface.recheck.side_effect = root_guard
            if defect == "post-frame-wire":
                identity = state.surface.references.identity
                state.surface.references.identity = lambda node, owner: ([":1.1", "/foreign-frame"]
                    if diagnostic.get("phase") == "final-frame" else identity(node, owner))
            pages = M.load("native-linux-integrated-pages")
            html = M.HtmlPages(state.surface, Mock(pid=12), pages, {"size": 4, "sha256": "a" * 64}, 41000, {}, {"envelopeDiagnostic": diagnostic})
            with self.subTest(defect=defect), self.acquisition(state) as inventory, patch.object(M.subprocess, "Popen") as launch:
                if defect == "pre-window": inventory.return_value = [20, 21]
                if defect == "post-window": inventory.side_effect = [[20], [20, 21]]
                with self.assertRaises(RuntimeError) as caught: html.start()
            if defect == "post-root": self.assertIs(caught.exception, error)
            self.assertEqual(state.frame_reads, 0 if defect == "pre-window" else 1)
            self.assertEqual(diagnostic["notReadyCount"], 0); self.assertIsNone(diagnostic["firstNotReady"])
            self.assertFalse(html.probed); self.assertEqual(html.evidence["inputAttempts"], [])
            self.assertEqual(state.sleeps, []); launch.assert_not_called()

    def test_positive_result_after_pre_guard_post_guard_or_frame_budget_expiry_cannot_launch(self):
        for expiry in ("before-frame", "post-guard", "post-frame"):
            state = self.fixture(); diagnostic = {}
            calls = []
            def recheck(**kwargs):
                calls.append(kwargs)
                if len(calls) == (1 if expiry == "before-frame" else 2) and expiry != "post-frame": state.now = 30
            state.surface.recheck.side_effect = recheck
            if expiry == "post-frame":
                identity = state.surface.references.identity
                def timed_identity(node, owner):
                    if diagnostic.get("phase") == "final-frame": state.now = 30
                    return identity(node, owner)
                state.surface.references.identity = timed_identity
            pages = M.load("native-linux-integrated-pages")
            html = M.HtmlPages(state.surface, Mock(pid=12), pages, {"size": 4, "sha256": "a" * 64}, 41000, {}, {"envelopeDiagnostic": diagnostic})
            with self.subTest(expiry=expiry), self.acquisition(state), patch.object(M.subprocess, "Popen") as launch, \
                    self.assertRaisesRegex(RuntimeError, "Native WebView readiness deadline"):
                html.start()
            self.assertEqual(diagnostic["outcome"], "deadline")
            self.assertFalse(html.probed); self.assertEqual(html.evidence["inputAttempts"], [])
            self.assertEqual(state.frame_reads, 0 if expiry == "before-frame" else 1)
            self.assertEqual(diagnostic["notReadyCount"], 0); launch.assert_not_called()


class GenuineGiBinding(unittest.TestCase):
    def test_actual_gi_error_identity_and_readonly_metadata_conversion(self):
        if sys.argv[1:] != ["GenuineGiBinding"]:
            self.skipTest("Requires dedicated post-APT /usr/bin/python3 -I -B invocation; that selection rejects skips")
        self.assertTrue(sys.flags.isolated)
        self.assertFalse(sys.flags.no_site)
        self.assertTrue(sys.flags.dont_write_bytecode)
        from gi.repository import GLib
        from gi._error import GError
        self.assertIs(GLib.Error, GError)
        self.assertIs(sys.modules["gi._error"].GError, GError)
        for domain, code in (("atspi_error", 0), ("creator-gi-synthetic-other", 0), ("atspi_error", 1)):
            with self.subTest(domain=domain, code=code):
                error = GLib.Error("Synthetic pre-UI GI binding test", domain, code)
                self.assertIs(type(error), GError)
                self.assertIs(type(error.domain), str); self.assertEqual(error.domain, domain)
                self.assertIs(type(error.code), int); self.assertEqual(error.code, code)
                surface = M.Surface.__new__(M.Surface)
                surface.dialog, surface.last, surface.ax_snapshot_diagnostic = False, None, None
                surface.renderer, surface.references = {"pid": 43}, SimpleNamespace(window=(":1.1", "/synthetic-frame"))
                surface.call_phase = "pre-ui-genuine-gi"
                calls = []
                def walk(): calls.append("walk"); return []
                def metadata(nodes):
                    calls.append("metadata")
                    if calls.count("metadata") == 1: raise error
                    return [{"id": "synthetic-ready"}]
                surface.walk, surface._snapshot_rows = walk, metadata
                surface.recheck = lambda **kwargs: calls.append(("guard", kwargs))
                if domain == "atspi_error" and code == 0:
                    rows, _ = surface.snapshot()
                    self.assertEqual(rows, [{"id": "synthetic-ready"}])
                    self.assertEqual(calls, ["walk", "metadata", ("guard", {"full": True})] * 2)
                    retained = surface.ax_snapshot_diagnostic["firstIncomplete"]
                    self.assertEqual(retained["reason"], "disposed-accessible")
                    self.assertEqual(retained["refusalDiagnostic"]["glib"], {"domain": {"value": "atspi_error"}, "code": 0})
                else:
                    with self.assertRaises(GError) as caught: surface.snapshot()
                    self.assertIs(caught.exception, error)
                    self.assertEqual(calls, ["walk", "metadata"])
                    self.assertIsNone(surface.ax_snapshot_diagnostic)


class RefusalDiagnostics(unittest.TestCase):
    def glib(self):
        module = ModuleType("gi._error")
        class GError(RuntimeError):
            def __init__(self, domain="atspi_error", code=0):
                super().__init__("PRIVATE_EXCEPTION_BODY")
                self.domain, self.code = domain, code
            def __str__(self): raise AssertionError("Exception message must not be queried")
            def __getattribute__(self, name):
                if name in ("domain", "code"): raise AssertionError("Do not invoke exception attribute getters")
                return super().__getattribute__(name)
        module.GError = GError
        return module, GError

    def trace(self, error, *, file=None, function="failing_getter"):
        file = str(M.BASE / "scripts" / Path(M.__file__).name) if file is None else file
        namespace = {"error": error}
        source = "def " + function + "():\n    private_local = 'PRIVATE_LOCAL_VALUE'\n    raise error\n"
        exec(compile(source, file, "exec"), namespace)
        try: namespace[function]()
        except Exception as caught: return caught
        self.fail("Synthetic original error required")

    def test_known_owned_frame_function_line_and_actual_glib_fields_are_retained_without_locals(self):
        module, error_type = self.glib()
        original = self.trace(error_type())
        with patch.dict(sys.modules, {"gi._error": module}), patch.object(M, "read") as read, \
                patch.object(M.subprocess, "run") as run:
            value = M.refusal_diagnostic(original)
        self.assertEqual(value["frames"][-1], {"file": Path(M.__file__).name, "function": "failing_getter", "line": 3})
        self.assertEqual(value["glib"], {"domain": {"value": "atspi_error"}, "code": 0})
        self.assertFalse(value["truncated"]); self.assertNotIn("PRIVATE", json.dumps(value))
        read.assert_not_called(); run.assert_not_called()

    def test_foreign_filename_function_and_unknown_domain_are_hashed_not_dumped(self):
        module, error_type = self.glib()
        error = self.trace(error_type("PRIVATE_DOMAIN", 17), file="/PRIVATE_HOME/PRIVATE_FILE.py", function="PRIVATE_FUNCTION")
        with patch.dict(sys.modules, {"gi._error": module}): value = M.refusal_diagnostic(error)
        frame = value["frames"][-1]
        self.assertEqual(frame["file"], "other"); self.assertNotIn("function", frame)
        self.assertEqual(frame["functionSha256"], hashlib.sha256(b"PRIVATE_FUNCTION").hexdigest())
        self.assertEqual(value["glib"]["code"], 17)
        self.assertEqual(value["glib"]["domain"]["kind"], "redacted")
        self.assertNotIn("PRIVATE", json.dumps(value))

    def test_glib_requires_loaded_authentic_type_not_error_name_or_duck_typed_properties(self):
        module, _ = self.glib()
        class Error(RuntimeError):
            @property
            def domain(self): self.fail("Foreign domain getter queried")
            @property
            def code(self): self.fail("Foreign code getter queried")
        for loaded in (None, module):
            with self.subTest(loaded=loaded is not None), patch.dict(sys.modules, {"gi._error": loaded}):
                value = M.refusal_diagnostic(self.trace(Error("PRIVATE_ERROR")))
                self.assertNotIn("glib", value); self.assertNotIn("PRIVATE", json.dumps(value))

    def test_oversized_glib_domain_and_invalid_codes_remain_bounded_redacted_data(self):
        module, error_type = self.glib()
        for code in (True, "PRIVATE_CODE", 2**31, -(2**31) - 1):
            with self.subTest(code=type(code).__name__), patch.dict(sys.modules, {"gi._error": module}):
                value = M.refusal_diagnostic(self.trace(error_type("PRIVATE" * 10000, code)))
                self.assertIsNone(value["glib"]["code"])
                self.assertEqual(value["glib"]["domain"]["chars"], 70000)
                self.assertLessEqual(len(json.dumps(value).encode()), 8192)
                self.assertNotIn("PRIVATE", json.dumps(value))

    def test_deep_trace_is_finite_truncated_and_has_no_source_line_or_local_dump(self):
        error = RuntimeError("PRIVATE_BODY")
        def recurse(depth):
            local_secret = "PRIVATE_LOCAL"
            if depth: return recurse(depth - 1)
            raise error
        try: recurse(90)
        except RuntimeError as caught: value = M.refusal_diagnostic(caught)
        self.assertEqual(len(value["frames"]), 16); self.assertEqual(value["visitedFrames"], 64)
        self.assertTrue(value["truncated"]); self.assertNotIn("PRIVATE", json.dumps(value))
        self.assertLessEqual(len(json.dumps(value).encode()), 8192)

    def test_capture_failure_cannot_replace_original_and_first_diagnostic_is_never_overwritten(self):
        original = self.trace(RuntimeError("original failure")); record = {}
        with patch.object(M, "refusal_diagnostic", side_effect=ValueError("PRIVATE_CAPTURE_ERROR")):
            M.retain_refusal_diagnostic(record, original)
        self.assertEqual(record, {"refusalDiagnosticUnavailable": True})
        self.assertEqual(str(original), "original failure")
        record = {"refusalDiagnostic": {"first": True}}
        with patch.object(M, "refusal_diagnostic") as capture: M.retain_refusal_diagnostic(record, original)
        capture.assert_not_called(); self.assertEqual(record, {"refusalDiagnostic": {"first": True}})

    def test_actual_session_and_broker_error_handlers_keep_existing_refusal_and_original_exception(self):
        tree = ast.parse(Path(M.__file__).read_text())
        for name in ("native_session", "broker"):
            function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            handlers = [n for n in ast.walk(function) if isinstance(n, ast.ExceptHandler)
                        and any(isinstance(s, ast.Expr) and isinstance(s.value, ast.Call)
                                and ast.unparse(s.value.func) == "retain_refusal_diagnostic" for s in n.body)]
            self.assertEqual(len(handlers), 1)
            body = handlers[0].body
            end = next(i for i, s in enumerate(body) if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call)
                       and ast.unparse(s.value.func) == "retain_refusal_diagnostic")
            original = self.trace(RuntimeError("original source refusal")); record = {}
            namespace = {"error": original, "report": record, "record": record,
                         "retain_refusal_diagnostic": M.retain_refusal_diagnostic}
            with self.subTest(function=name):
                exec(compile(ast.Module(body=copy.deepcopy(body[:end + 1]), type_ignores=[]), "actual-refusal-handler", "exec"), namespace)
                self.assertIs(namespace["failure"], original)
                self.assertEqual(record["refusal"], {"type": "RuntimeError", "message": "original source refusal"})
                self.assertIn("refusalDiagnostic", record)


class DisposedAccessibleAcquisition(unittest.TestCase):
    def surface(self, *, dialog=False):
        surface = HtmlSnapshotAcquisition().surface(dialog=dialog)
        reads = []
        def walk(): reads.append("walk"); return [object()]
        surface.walk = walk
        return surface, reads

    def test_exact_registered_glib_type_domain_and_code_reacquires_metadata_only(self):
        module, error_type = RefusalDiagnostics().glib()
        surface, reads = self.surface(); rows = [{"id": "ready"}]
        def metadata(nodes):
            reads.append("metadata")
            if reads.count("metadata") == 1: raise error_type()
            return rows
        surface._snapshot_rows = metadata
        with patch.dict(sys.modules, {"gi._error": module}): result = surface.snapshot()
        self.assertIs(result[0], rows); self.assertEqual(reads, ["walk", "metadata"] * 2)
        self.assertEqual(surface.checks, [{"full": True}] * 2)
        first = surface.ax_snapshot_diagnostic["firstIncomplete"]
        self.assertEqual(first["reason"], "disposed-accessible")
        self.assertEqual((first["glibDomain"], first["glibCode"]), ("atspi_error", 0))
        self.assertEqual(first["refusalDiagnostic"]["glib"], {"domain": {"value": "atspi_error"}, "code": 0})
        self.assertEqual(surface.ax_snapshot_diagnostic["outcome"], "complete")
        self.assertNotIn("PRIVATE", json.dumps(surface.ax_snapshot_diagnostic))

    def test_real_metadata_serialization_discards_disposed_node_and_returns_fresh_rows(self):
        module, error_type = RefusalDiagnostics().glib(); surface, reads = self.surface()
        roles = SimpleNamespace(PASSWORD_TEXT=75, LABEL=29, TEXT=61, STATIC=116, PARAGRAPH=73, STATUS_BAR=54)
        states = SimpleNamespace(**{name: name for name in ("EDITABLE", "SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY", "PRESSED")})
        surface.atspi = SimpleNamespace(Role=roles, StateType=states)
        surface.references.identity = lambda node, owner: (":1.4", node.path)
        current = []
        def walk():
            reads.append("walk")
            disposed = not current
            def role():
                if disposed: raise error_type()
                return 43
            node = SimpleNamespace(path="/fresh" + str(len(current)), get_role=role,
                get_state_set=lambda: SimpleNamespace(contains=lambda name: name in ("SHOWING", "ENABLED", "SENSITIVE")),
                get_attributes=lambda: {"id": "ready", "tag": "button", "toolkit": "WebKitGTK"}, get_name=lambda: "Ready")
            current.append(node)
            return [node]
        surface.walk = walk
        with patch.dict(sys.modules, {"gi._error": module}): rows, nodes = surface.snapshot()
        self.assertEqual(reads, ["walk", "walk"]); self.assertIs(nodes[0], current[1]); self.assertIsNot(nodes[0], current[0])
        self.assertEqual(rows[0]["reference"], (":1.4", "/fresh1")); self.assertEqual(rows[0]["id"], "ready")
        self.assertEqual(rows[0]["role"], 43); self.assertFalse(rows[0]["defunct"])
        self.assertEqual(surface.ax_snapshot_diagnostic["firstIncomplete"]["glibCode"], 0)

    def test_wrong_registered_type_domain_code_or_provider_is_fatal_without_next_read(self):
        module, error_type = RefusalDiagnostics().glib()
        class Subclass(error_type): pass
        class Impostor(RuntimeError): pass
        Impostor.__name__, Impostor.__module__ = "Error", "gi.repository.GLib"
        class Domain(str): pass
        cases = [(module, Subclass()), (module, Impostor("atspi_error: The application no longer exists (0)")),
                 (module, error_type("other", 0)), (module, error_type(Domain("atspi_error"), 0)),
                 (module, error_type("atspi_error", 1)), (module, error_type("atspi_error", 2)),
                 (module, error_type("atspi_error", False)), (module, error_type("atspi_error", "0")),
                 (module, error_type("atspi_error", 0.0)), (None, error_type()),
                 (SimpleNamespace(GError=error_type), error_type())]
        for provider, original in cases:
            with self.subTest(type=type(original).__name__, provider=type(provider).__name__):
                surface, reads = self.surface()
                def metadata(nodes): reads.append("metadata"); raise original
                surface._snapshot_rows = metadata
                with patch.dict(sys.modules, {"gi._error": provider}), self.assertRaises(type(original)) as caught:
                    surface.snapshot()
                self.assertIs(caught.exception, original); self.assertEqual(reads, ["walk", "metadata"])
                self.assertIsNone(surface.ax_snapshot_diagnostic); self.assertEqual(surface.checks, [])

    def test_missing_preexisting_renderer_or_frame_binding_never_adopts(self):
        module, error_type = RefusalDiagnostics().glib()
        for missing in ("renderer", "frame"):
            surface, reads = self.surface(); original = error_type()
            if missing == "renderer": surface.renderer = None
            else: surface.references.window = None
            def metadata(nodes): reads.append("metadata"); raise original
            surface._snapshot_rows = metadata
            with self.subTest(missing=missing), patch.dict(sys.modules, {"gi._error": module}), self.assertRaises(error_type) as caught:
                surface.snapshot()
            self.assertIs(caught.exception, original); self.assertEqual(reads, ["walk", "metadata"])
            self.assertEqual(surface.checks, []); self.assertIsNone(surface.ax_snapshot_diagnostic)

    def owned_surface(self):
        surface, reads = self.surface()
        root = {"pid": 42, "startTime": "10", "parentPid": 41, "uids": [21314] * 4,
                "executable": "/fixture/root", "kernelImageSha256": "a" * 64}
        renderer = {**copy.deepcopy(root), "pid": 43, "startTime": "11", "parentPid": 42,
                    "executable": "/fixture/WebKitWebProcess", "kernelImageSha256": "b" * 64}
        surface.pid, surface.record, surface.root, surface.renderer = 42, root, root, renderer
        surface.xres, surface.main_window, surface.request, surface.x11 = {"client": 7}, None, object(), object()
        state = {"processes": {42: copy.deepcopy(root), 43: copy.deepcopy(renderer)},
                 "images": {42: copy.deepcopy(root), 43: copy.deepcopy(renderer)}, "xres": {"client": 7},
                 "bus": {":1.1": {"owner": ":1.1", "pid": 42, "uid": 21314},
                         ":1.4": {"owner": ":1.4", "pid": 43, "uid": 21314}}}
        def process(pid, helper, full=False):
            reads.append(("process", pid))
            if pid not in state["processes"]: raise RuntimeError("Owned process is not live")
            return state["processes"][pid]
        def xres(request, x11): reads.append("xres"); return state["xres"]
        def kernel(pid, native, helper): reads.append(("kernel", pid)); return state["images"][pid]
        native = M.load("native-linux-root-probe")
        def resolve(name): reads.append(("bus", name)); return state["bus"][name]
        surface.references = native.AxReferences(resolve, copy.deepcopy(state["bus"]), (":1.1", "/org/a11y/frame"))
        surface.native, surface.helper = SimpleNamespace(native_process=process), SimpleNamespace(bound_window=xres)
        surface.recheck = lambda **kwargs: M.Surface.recheck(surface, **kwargs)
        return surface, reads, state, kernel

    def test_real_full_recheck_precedes_next_walk_and_keeps_all_bindings(self):
        module, error_type = RefusalDiagnostics().glib()
        surface, reads, state, kernel = self.owned_surface(); original_renderer = surface.renderer; original_window = surface.references.window
        def metadata(nodes):
            reads.append("metadata")
            if reads.count("metadata") == 1: raise error_type()
            return [{"id": "ready"}]
        surface._snapshot_rows = metadata
        with patch.dict(sys.modules, {"gi._error": module}), patch.object(M, "alive_stat"), patch.object(M, "kernel_record", side_effect=kernel):
            surface.snapshot()
        first = reads.index("metadata"); second_walk = reads.index("walk", first)
        self.assertEqual(reads[first + 1:second_walk], [("process", 42), "xres", ("process", 43),
                         ("kernel", 42), ("kernel", 43), ("bus", ":1.1"), ("bus", ":1.4")])
        self.assertIs(surface.renderer, original_renderer); self.assertIs(surface.references.window, original_window)

    def test_full_guard_root_renderer_xres_or_bus_loss_is_fatal_before_second_acquisition(self):
        module, error_type = RefusalDiagnostics().glib()
        for defect in ("root-exit", "root-start", "root-uid", "root-kernel", "frame", "renderer-exit",
                       "renderer-parent", "renderer-start", "renderer-uid", "renderer-kernel", "app-owner", "renderer-owner"):
            with self.subTest(defect=defect):
                surface, reads, state, kernel = self.owned_surface()
                def metadata(nodes):
                    reads.append("metadata")
                    if defect == "root-exit": del state["processes"][42]
                    elif defect == "root-start": state["processes"][42]["startTime"] = "999"
                    elif defect == "root-uid": state["processes"][42]["uids"] = [1] * 4
                    elif defect == "root-kernel": state["images"][42]["kernelImageSha256"] = "c" * 64
                    elif defect == "frame": state["xres"] = {"client": 8}
                    elif defect == "renderer-exit": del state["processes"][43]
                    elif defect == "renderer-parent": state["processes"][43]["parentPid"] = 99
                    elif defect == "renderer-start": state["processes"][43]["startTime"] = "999"
                    elif defect == "renderer-uid": state["processes"][43]["uids"] = [1] * 4
                    elif defect == "renderer-kernel": state["images"][43]["kernelImageSha256"] = "c" * 64
                    elif defect == "app-owner": state["bus"][":1.1"]["owner"] = ":1.99"
                    elif defect == "renderer-owner": state["bus"][":1.4"]["pid"] = 99
                    raise error_type()
                surface._snapshot_rows = metadata
                with patch.dict(sys.modules, {"gi._error": module}), patch.object(M, "alive_stat"), \
                        patch.object(M, "kernel_record", side_effect=kernel), self.assertRaises(RuntimeError) as caught:
                    surface.snapshot()
                self.assertNotIsInstance(caught.exception, M._IncompleteHtmlSnapshot)
                self.assertNotIsInstance(caught.exception, error_type)
                self.assertEqual(reads.count("walk"), 1); self.assertEqual(reads.count("metadata"), 1)
                self.assertEqual(surface.last, ["previous-not-current"])
                self.assertEqual(surface.ax_snapshot_diagnostic["firstIncomplete"]["glibCode"], 0)

    def test_persistent_disposed_objects_exhaust_exact_eight_attempts_without_stale_result(self):
        module, error_type = RefusalDiagnostics().glib(); surface, reads = self.surface()
        def metadata(nodes): reads.append("metadata"); raise error_type()
        surface._snapshot_rows = metadata
        with patch.dict(sys.modules, {"gi._error": module}), self.assertRaisesRegex(RuntimeError, "snapshot attempt limit"):
            surface.snapshot()
        self.assertEqual(reads, ["walk", "metadata"] * 8)
        self.assertEqual(surface.ax_snapshot_diagnostic["incompleteReads"], 8)
        self.assertEqual(surface.ax_snapshot_diagnostic["outcome"], "attempt-limit")
        self.assertEqual(surface.last, ["previous-not-current"])

    def test_disposed_read_or_postguard_deadline_equality_never_starts_next_acquisition(self):
        module, error_type = RefusalDiagnostics().glib()
        for stage in ("read", "guard"):
            surface, reads = self.surface(); clock = [0]
            def metadata(nodes):
                reads.append("metadata")
                if stage == "read": clock[0] = 30
                raise error_type()
            def check(**kwargs): surface.checks.append(kwargs); clock[0] = 30
            surface._snapshot_rows, surface.recheck = metadata, check
            with self.subTest(stage=stage), patch.dict(sys.modules, {"gi._error": module}), \
                    patch.object(M.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaisesRegex(RuntimeError, "HTML AX snapshot deadline"):
                surface.snapshot()
            self.assertEqual(reads, ["walk", "metadata"])
            self.assertEqual(len(surface.checks), 0 if stage == "read" else 1)
            self.assertEqual(surface.last, ["previous-not-current"])

    def test_reacquired_graph_must_still_fully_pass_original_checks(self):
        module, error_type = RefusalDiagnostics().glib(); surface, reads = self.surface()
        original = RuntimeError("Duplicate/cyclic AX graph")
        def walk():
            reads.append("walk")
            if reads.count("walk") == 2: raise original
            return [object()]
        def metadata(nodes): reads.append("metadata"); raise error_type()
        surface.walk, surface._snapshot_rows = walk, metadata
        with patch.dict(sys.modules, {"gi._error": module}), self.assertRaises(RuntimeError) as caught:
            surface.snapshot()
        self.assertIs(caught.exception, original); self.assertEqual(reads, ["walk", "metadata", "walk"])
        self.assertEqual(surface.last, ["previous-not-current"])

    def test_gi_error_in_walk_native_dialog_or_close_is_never_reacquired(self):
        module, error_type = RefusalDiagnostics().glib()
        for phase in ("walk", "dialog", "close"):
            surface, reads = self.surface(dialog=phase == "dialog"); original = error_type()
            def fail(*args): reads.append("failure"); raise original
            surface._snapshot_rows = fail
            if phase == "walk": surface.walk = fail
            if phase == "close":
                surface.window, surface.request = 7, object()
                surface.helper = SimpleNamespace(bound_window=lambda *args: {"client": 7})
                surface.x11 = SimpleNamespace(close_window=fail)
            with self.subTest(phase=phase), patch.dict(sys.modules, {"gi._error": module}), self.assertRaises(error_type) as caught:
                surface.close() if phase == "close" else surface.snapshot()
            self.assertIs(caught.exception, original); self.assertEqual(reads.count("failure"), 1)
            self.assertIsNone(surface.ax_snapshot_diagnostic)

    def test_authentic_gi_error_from_input_is_not_caught_or_retried(self):
        module, error_type = RefusalDiagnostics().glib(); surface, reads = self.surface(); actions = []; original = error_type()
        surface.x11, surface.window, surface.html_actions = object(), 7, []
        def action(index): reads.append("input"); raise original
        node = SimpleNamespace(get_action_iface=lambda: SimpleNamespace(get_n_actions=lambda: 1, get_action_name=lambda index: "press", do_action=action))
        row = {"id": "suite-trigger", "reference": [":1.4", "/button"], "toolkit": "WebKitGTK", "tag": "button",
               "showing": True, "enabled": True, "sensitive": True, "busy": False, "defunct": False}
        surface.walk = lambda: [node]; surface._snapshot_rows = lambda nodes: [row]
        with patch.dict(sys.modules, {"gi._error": module}), patch.object(M, "windows", return_value=[7]), self.assertRaises(error_type) as caught:
            surface.click("suite-trigger", actions)
        self.assertIs(caught.exception, original); self.assertEqual(reads, ["input"])
        self.assertEqual(actions, ["suite-trigger"]); self.assertIsNone(surface.ax_snapshot_diagnostic)

    def test_diagnostic_failure_keeps_original_glib_error_fatal(self):
        module, error_type = RefusalDiagnostics().glib(); surface, reads = self.surface(); original = error_type()
        def metadata(nodes): reads.append("metadata"); raise original
        surface._snapshot_rows = metadata
        with patch.dict(sys.modules, {"gi._error": module}), patch.object(M, "refusal_diagnostic", side_effect=ValueError("PRIVATE")), self.assertRaises(error_type) as caught:
            surface.snapshot()
        self.assertIs(caught.exception, original); self.assertEqual(reads, ["walk", "metadata"])
        self.assertIsNone(surface.ax_snapshot_diagnostic)


class HtmlSnapshotAcquisition(unittest.TestCase):
    def surface(self, *, dialog=False):
        surface = M.Surface.__new__(M.Surface)
        surface.dialog, surface.last, surface.ax_snapshot_diagnostic = dialog, ["previous-not-current"], None
        surface.call_phase = "initial-pages:wait-mcp"
        surface.references = SimpleNamespace(window=(":1.4", "/frame"))
        surface.renderer = {"pid": 43}
        surface.checks = []
        surface.recheck = lambda **kwargs: surface.checks.append(kwargs)
        return surface

    def node(self, *, counts=(1, 1), children=None):
        calls, values = [], iter(counts)
        if children is None: children = [object()]
        def count(): calls.append("count"); return next(values)
        def child(index): calls.append(("child", index)); return children[index]
        return SimpleNamespace(clear_cache=lambda: calls.append("clear"), get_child_count=count,
                               get_child_at_index=child), calls

    def incomplete(self, reason="missing-child"):
        return M._IncompleteHtmlSnapshot(reason, {"site": "Surface.live_children", "nodeReference": (":1.4", "/fixture"),
            "depth": 1, "visitedCount": 1, "pendingCount": 0, "count": 1, "index": 0})

    def children(self, surface, node):
        return surface.live_children(node, 4, {"nodeReference": (":1.4", "/fixture"), "depth": 1,
                                              "visitedCount": 1, "pendingCount": 0})

    def test_local_live_children_preserves_exact_cache_count_index_sequence(self):
        surface = self.surface(); child = object(); node, calls = self.node(children=[child])
        self.assertEqual(self.children(surface, node), [child])
        self.assertEqual(calls, ["clear", "count", "clear", ("child", 0), "clear", "count"])

    def test_only_null_child_or_valid_changed_count_are_typed(self):
        for counts, children, reason in (((1, 1), [None], "missing-child"), ((1, 0), [object()], "changed-child-count")):
            with self.subTest(reason=reason):
                node, _ = self.node(counts=counts, children=children)
                with self.assertRaises(M._IncompleteHtmlSnapshot) as caught: self.children(self.surface(), node)
                self.assertEqual(caught.exception.reason, reason)
                self.assertNotIn("name", caught.exception.detail)

    def test_invalid_first_or_final_count_remains_fatal_not_incomplete(self):
        for counts in ((True,), (-1,), (5,), ("1",), (1, True), (1, -1), (1, 5), (1, "1")):
            with self.subTest(counts=counts):
                node, _ = self.node(counts=counts)
                with self.assertRaises(RuntimeError) as caught: self.children(self.surface(), node)
                self.assertNotIsInstance(caught.exception, M._IncompleteHtmlSnapshot)

    def test_child_query_error_is_not_translated_or_retried(self):
        original = RuntimeError("Root close child disappeared")
        node, _ = self.node(); node.get_child_at_index = lambda index: (_ for _ in ()).throw(original)
        with self.assertRaises(RuntimeError) as caught: self.children(self.surface(), node)
        self.assertIs(caught.exception, original)

    def test_incomplete_then_complete_discards_partial_and_rechecks_same_bindings(self):
        surface = self.surface(); original_renderer = surface.renderer; original_window = surface.references.window
        result = ([{"id": "ready"}], [object()]); calls = []
        def once():
            calls.append(surface._snapshot_deadline)
            if len(calls) == 1: raise self.incomplete()
            return result
        surface._snapshot_once = once
        with patch.object(M.time, "monotonic", return_value=10), patch.object(M.time, "sleep") as sleep:
            self.assertIs(surface.snapshot(), result)
        sleep.assert_not_called(); self.assertEqual(calls, [40, 40])
        self.assertIs(surface.last, result[0]); self.assertIs(surface.renderer, original_renderer)
        self.assertIs(surface.references.window, original_window)
        self.assertEqual(surface.checks, [{"full": True}] * 2)
        evidence = surface.ax_snapshot_diagnostic
        self.assertEqual((evidence["incompleteReads"], evidence["attempts"], evidence["outcome"]), (1, 2, "complete"))
        self.assertEqual(evidence["firstIncomplete"]["reason"], "missing-child")
        self.assertEqual(evidence["firstIncomplete"]["phase"], surface.call_phase)
        self.assertFalse(hasattr(surface, "_snapshot_deadline"))

    def test_eight_persistent_incomplete_reads_fail_without_stale_return(self):
        surface = self.surface(); calls = []
        def once(): calls.append(True); raise self.incomplete("missing-parent")
        surface._snapshot_once = once
        with patch.object(M.time, "monotonic", return_value=10), patch.object(M.time, "sleep") as sleep, \
                self.assertRaisesRegex(RuntimeError, "Incomplete owned HTML AX snapshot attempt limit"):
            surface.snapshot()
        self.assertEqual(len(calls), 8); sleep.assert_not_called()
        self.assertEqual(surface.last, ["previous-not-current"])
        self.assertEqual(surface.ax_snapshot_diagnostic["outcome"], "attempt-limit")
        self.assertEqual(surface.ax_snapshot_diagnostic["incompleteReads"], 8)

    def test_shared_absolute_deadline_cannot_be_reset_or_accept_late_result(self):
        for returns_late in (False, True):
            with self.subTest(returns_late=returns_late):
                surface = self.surface(); clock = [0]; calls = []
                def once():
                    calls.append(surface._snapshot_deadline); clock[0] = 31
                    if returns_late: return ([{"id": "late"}], [])
                    raise self.incomplete()
                surface._snapshot_once = once
                with patch.object(M.time, "monotonic", side_effect=lambda: clock[0]), \
                        self.assertRaisesRegex(RuntimeError, "HTML AX snapshot deadline"):
                    surface.snapshot()
                self.assertEqual(calls, [30]); self.assertEqual(surface.last, ["previous-not-current"])
                self.assertFalse(hasattr(surface, "_snapshot_deadline"))

    def test_deadline_equality_and_overrun_are_refused_after_read_and_after_guard(self):
        for stage in ("read", "guard"):
            for finished in (30, 31):
                with self.subTest(stage=stage, finished=finished):
                    surface = self.surface(); clock, reads, guards = [0], [], []
                    def once():
                        reads.append(True)
                        if stage == "read": clock[0] = finished
                        return ([{"id": "must-not-be-accepted"}], [])
                    def check(**kwargs): guards.append(kwargs); clock[0] = finished
                    surface._snapshot_once, surface.recheck = once, check
                    with patch.object(M.time, "monotonic", side_effect=lambda: clock[0]), \
                            self.assertRaisesRegex(RuntimeError, "HTML AX snapshot deadline"):
                        surface.snapshot()
                    self.assertEqual(reads, [True]); self.assertEqual(len(guards), 0 if stage == "read" else 1)
                    self.assertEqual(surface.last, ["previous-not-current"])

    def test_incomplete_postguard_deadline_refuses_before_second_read(self):
        surface = self.surface(); clock, reads = [0], []
        def once(): reads.append(True); raise self.incomplete()
        def check(**kwargs): clock[0] = 30
        surface._snapshot_once, surface.recheck = once, check
        with patch.object(M.time, "monotonic", side_effect=lambda: clock[0]), \
                self.assertRaisesRegex(RuntimeError, "HTML AX snapshot deadline"):
            surface.snapshot()
        self.assertEqual(reads, [True]); self.assertEqual(surface.ax_snapshot_diagnostic["incompleteReads"], 1)
        self.assertEqual(surface.last, ["previous-not-current"])

    def test_unknown_error_even_with_old_helper_message_is_never_reacquired(self):
        for error in (RuntimeError("Root close child disappeared"), RuntimeError("Missing AX parent"),
                      RuntimeError("Duplicate/cyclic AX graph"), ValueError("SYNTHETIC_PRIVATE")):
            with self.subTest(error=type(error).__name__):
                surface = self.surface(); calls = []
                def once(): calls.append(True); raise error
                surface._snapshot_once = once
                with self.assertRaises(type(error)) as caught: surface.snapshot()
                self.assertIs(caught.exception, error); self.assertEqual(calls, [True])
                self.assertIsNone(surface.ax_snapshot_diagnostic)

    def test_first_incomplete_is_saved_before_identity_guard_can_refuse(self):
        surface = self.surface(); calls = []
        original = RuntimeError("Bound Root changed")
        def once(): calls.append(True); raise self.incomplete()
        def refuse(**kwargs):
            self.assertEqual(surface.ax_snapshot_diagnostic["firstIncomplete"]["reason"], "missing-child")
            raise original
        surface._snapshot_once, surface.recheck = once, refuse
        with self.assertRaises(RuntimeError) as caught: surface.snapshot()
        self.assertIs(caught.exception, original); self.assertEqual(calls, [True])
        self.assertEqual(surface.last, ["previous-not-current"])

    def test_first_diagnostic_survives_later_acquisitions_without_new_node_queries(self):
        surface = self.surface(); result = ([], [])
        for reason in ("missing-child", "changed-child-count"):
            values = iter([self.incomplete(reason), result])
            def once():
                value = next(values)
                if isinstance(value, Exception): raise value
                return value
            surface._snapshot_once = once; surface.snapshot()
        self.assertEqual(surface.ax_snapshot_diagnostic["firstIncomplete"]["reason"], "missing-child")
        self.assertEqual(surface.ax_snapshot_diagnostic["incompleteReads"], 2)
        self.assertLess(len(json.dumps(surface.ax_snapshot_diagnostic)), 2048)

    def test_native_dialog_snapshot_does_not_reacquire_or_change_deadline(self):
        surface = self.surface(dialog=True); original = self.incomplete(); calls = []
        def once(): calls.append(True); raise original
        surface._snapshot_once = once
        with self.assertRaises(M._IncompleteHtmlSnapshot) as caught: surface.snapshot()
        self.assertIs(caught.exception, original); self.assertEqual(calls, [True])
        self.assertEqual(surface.checks, []); self.assertFalse(hasattr(surface, "_snapshot_deadline"))
        self.assertIsNone(surface.ax_snapshot_diagnostic)

    def test_uncertain_input_is_never_repeated_after_successful_read_reacquisition(self):
        for raises in (False, True):
            with self.subTest(raises=raises):
                surface = self.surface(); surface.x11, surface.window, surface.html_actions = object(), 7, []
                inputs, reads, actions = [], [], []
                original = RuntimeError("Uncertain action outcome")
                def action(index):
                    inputs.append(index)
                    if raises: raise original
                    return False
                interface = SimpleNamespace(get_n_actions=lambda: 1, get_action_name=lambda index: "press", do_action=action)
                node = SimpleNamespace(get_action_iface=lambda: interface)
                row = {"id": "suite-trigger", "reference": [":1.4", "/button"], "toolkit": "WebKitGTK", "tag": "button",
                       "showing": True, "enabled": True, "sensitive": True, "busy": False, "defunct": False}
                def once():
                    reads.append(True)
                    if len(reads) == 1: raise self.incomplete()
                    return ([row], [node])
                surface._snapshot_once = once
                with patch.object(M, "windows", return_value=[7]), self.assertRaises(RuntimeError) as caught:
                    surface.click("suite-trigger", actions)
                if raises: self.assertIs(caught.exception, original)
                else: self.assertEqual(str(caught.exception), "UI action uncertain; no retry")
                self.assertEqual(inputs, [0]); self.assertEqual(len(reads), 3); self.assertEqual(actions, ["suite-trigger"])
                with patch.object(M, "windows", return_value=[7]), self.assertRaisesRegex(RuntimeError, "No repeated UI action"):
                    surface.click("suite-trigger", actions)
                self.assertEqual(inputs, [0]); self.assertEqual(len(reads), 3)

    def test_retry_boundary_has_no_input_generic_exception_matching_or_sleep(self):
        tree = ast.parse(Path(M.__file__).read_text())
        surface = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Surface")
        snapshot = next(n for n in surface.body if isinstance(n, ast.FunctionDef) and n.name == "snapshot")
        catches = [ast.unparse(n.type) for n in ast.walk(snapshot) if isinstance(n, ast.ExceptHandler)]
        self.assertEqual(catches, ["_IncompleteHtmlSnapshot"])
        source = ast.unparse(snapshot)
        for forbidden in ("do_action", ".click(", "time.sleep", "str(error)", "self.renderer =", "self.references.window ="):
            self.assertNotIn(forbidden, source)


class PartialAxParentEvidence(unittest.TestCase):
    def fixture(self, *, parent_present=False, dialog=False):
        calls = []
        class Node:
            def __init__(self, ref, role, parent=None):
                self.ref, self.role, self.parent, self.children = ref, role, parent, []
            def clear_cache(self): calls.append((self.ref, "clear"))
            def get_process_id(self): calls.append((self.ref, "pid")); return 42
            def get_role(self): calls.append((self.ref, "role")); return self.role
            def get_parent(self): calls.append((self.ref, "parent")); return self.parent
            def get_child_count(self): calls.append((self.ref, "count")); return len(self.children)
            def get_child_at_index(self, index): calls.append((self.ref, "child", index)); return self.children[index]
            def get_name(self): raise AssertionError("PRIVATE_EDITABLE_NAME_MUST_NOT_BE_READ")
            def get_attributes(self): raise AssertionError("PRIVATE_ATTRIBUTES_MUST_NOT_BE_READ")
            def get_state_set(self): raise AssertionError("Additional state query refused")
        frame = Node("/frame", 2)
        child = Node("/child", 43, frame if parent_present else None)
        frame.children = [child]
        surface = M.Surface.__new__(M.Surface)
        surface.pid, surface.dialog, surface.last = 42, dialog, None
        surface.ax_snapshot_diagnostic = None
        surface.call_phase = "startup-ui:wait-usage-terms"
        surface.atspi = SimpleNamespace(Role=SimpleNamespace(APPLICATION=1, FRAME=2, WINDOW=3))
        surface.references = SimpleNamespace(window=None, identity=lambda node, owner: (":1.4", node.ref))
        surface.recheck = lambda **kwargs: calls.append(("surface", "recheck"))
        surface.node = lambda node: calls.append((node.ref, "ownership"))
        surface.native_frame = lambda: frame
        helper_tree = ast.parse((HERE / "native-unix-window.py").read_text())
        strict = next(n for n in helper_tree.body if isinstance(n, ast.FunctionDef) and n.name == "fresh_close_children")
        namespace = {"require": M.require}
        exec(compile(ast.Module(body=[strict], type_ignores=[]), "actual-strict-native-children", "exec"), namespace)
        def children(node, limit):
            calls.append((node.ref, "children")); return namespace["fresh_close_children"](node, limit)
        surface.helper = SimpleNamespace(fresh_close_children=children)
        return surface, calls, frame, child

    def test_native_dialog_missing_parent_keeps_same_read_context_and_original_refusal(self):
        surface, calls, _, _ = self.fixture(dialog=True); original_require = M.require
        original = RuntimeError("Missing AX parent")
        def require(value, message):
            if not value and message == "Missing AX parent": raise original
            original_require(value, message)
        with patch.object(M, "wait", side_effect=lambda check: check()), patch.object(M, "require", side_effect=require), self.assertRaises(RuntimeError) as error:
            surface.walk()
        self.assertIs(error.exception, original)
        evidence = surface.ax_parent_diagnostic
        self.assertEqual(evidence["phase"], "startup-ui:wait-usage-terms")
        self.assertEqual(evidence["site"], "Surface.walk/parent-presence")
        self.assertEqual(evidence["nodeReference"], (":1.4", "/child"))
        self.assertEqual(evidence["expectedParentReference"], (":1.4", "/frame"))
        self.assertFalse(evidence["actualParentPresent"])
        self.assertEqual((evidence["depth"], evidence["visitedCount"], evidence["pendingCount"], evidence["role"]), (1, 1, 0, 43))
        self.assertEqual(evidence["unreadFields"], ["state", "toolkit", "sourceId"])
        self.assertNotIn("PRIVATE", json.dumps(evidence)); self.assertLess(len(json.dumps(evidence)), 2048)
        self.assertEqual(calls.count(("/child", "role")), 1)
        self.assertEqual(calls.count(("/child", "parent")), 1)
        self.assertNotIn(("/child", "children"), calls)

    def test_html_missing_parent_is_typed_without_querying_additional_metadata(self):
        surface, calls, _, _ = self.fixture()
        with patch.object(M, "wait", side_effect=lambda check: check()), self.assertRaises(M._IncompleteHtmlSnapshot) as error:
            surface.walk()
        self.assertEqual(error.exception.reason, "missing-parent")
        self.assertEqual(error.exception.detail["nodeReference"], (":1.4", "/child"))
        self.assertEqual(calls.count(("/child", "parent")), 1)
        self.assertEqual(calls.count(("/child", "count")), 0)

    def test_actual_walk_reacquires_whole_graph_after_null_child_or_parent(self):
        for reason in ("missing-child", "missing-parent", "changed-child-count"):
            with self.subTest(reason=reason):
                surface, calls, frame, child = self.fixture(parent_present=True)
                attempts, counts = [], []
                def native_frame():
                    attempts.append(getattr(surface, "_snapshot_deadline", None))
                    frame.children = [None if reason == "missing-child" and len(attempts) == 1 else child]
                    child.parent = None if reason == "missing-parent" and len(attempts) == 1 else frame
                    return frame
                def child_count():
                    counts.append(True)
                    return 0 if reason == "changed-child-count" and len(attempts) == 1 and len(counts) == 2 else 1
                surface.native_frame, frame.get_child_count = native_frame, child_count
                surface._snapshot_once = lambda: ([{"id": "ready"}], surface.walk())
                with patch.object(M.time, "monotonic", return_value=10), \
                        patch.object(M, "wait", side_effect=lambda check, **kwargs: check()):
                    rows, nodes = surface.snapshot()
                self.assertEqual(nodes, [frame, child]); self.assertEqual(rows, [{"id": "ready"}])
                self.assertEqual(attempts, [40, 40])
                self.assertEqual(surface.ax_snapshot_diagnostic["firstIncomplete"]["reason"], reason)
                self.assertEqual(surface.ax_snapshot_diagnostic["outcome"], "complete")
                self.assertEqual(surface.references.window, (":1.4", "/frame"))

    def test_actual_walk_owner_cycle_nested_and_escaped_parent_refusals_are_not_retried(self):
        for defect in ("owner", "cycle", "nested", "escaped-parent", "duplicate", "bounds", "xerror", "wire-owner"):
            with self.subTest(defect=defect):
                surface, calls, frame, child = self.fixture(parent_present=True)
                attempts = []
                def native_frame(): attempts.append(True); return frame
                surface.native_frame = native_frame
                original = RuntimeError("Bound owner refused")
                old_node, old_identity = surface.node, surface.references.identity
                if defect == "owner":
                    def node(value):
                        old_node(value)
                        if value is child: raise original
                    surface.node = node
                elif defect == "wire-owner":
                    def identity(value, owner):
                        if value is child: raise original
                        return old_identity(value, owner)
                    surface.references.identity = identity
                elif defect == "cycle": child.children = [frame]
                elif defect == "nested": child.role = surface.atspi.Role.WINDOW
                elif defect == "escaped-parent": child.parent = SimpleNamespace(ref="/escaped")
                elif defect == "duplicate": frame.children = [child, child]
                elif defect == "bounds": frame.get_child_count = lambda: 513
                elif defect == "xerror":
                    def check(**kwargs): raise original
                    surface.recheck = check
                surface._snapshot_once = lambda: ([{"id": "must-not-return"}], surface.walk())
                with patch.object(M, "wait", side_effect=lambda check, **kwargs: check()), self.assertRaises(RuntimeError) as error:
                    surface.snapshot()
                self.assertNotIsInstance(error.exception, M._IncompleteHtmlSnapshot)
                self.assertLessEqual(len(attempts), 1); self.assertIsNone(surface.last)
                self.assertIsNone(surface.ax_snapshot_diagnostic)

    def test_native_dialog_child_enumeration_uses_unchanged_strict_helper(self):
        surface, _, _, _ = self.fixture(parent_present=True, dialog=True)
        original = RuntimeError("Root close child disappeared"); calls = []
        def strict(node, limit): calls.append(True); raise original
        surface.helper.fresh_close_children = strict
        surface.live_children = lambda *args: self.fail("HTML acquisition used in native dialog")
        with patch.object(M, "wait", side_effect=lambda check: check()), self.assertRaises(RuntimeError) as error:
            surface.walk()
        self.assertIs(error.exception, original); self.assertEqual(calls, [True])
        self.assertIsNone(surface.ax_snapshot_diagnostic)

    def test_valid_graph_retains_strict_fresh_checks_without_new_queries(self):
        surface, calls, frame, child = self.fixture(parent_present=True)
        with patch.object(M, "wait", side_effect=lambda check: check()): result = surface.walk()
        self.assertEqual(result, [frame, child])
        self.assertEqual(calls.count(("surface", "recheck")), 2)
        self.assertEqual(calls.count(("/child", "parent")), 1)
        self.assertIsNone(getattr(surface, "ax_parent_diagnostic", None))

    def test_nested_frame_wait_uses_remaining_absolute_admission_budget(self):
        surface, _, frame, child = self.fixture(parent_present=True)
        surface._snapshot_deadline = 40
        waits = []
        def waiting(check, *, seconds): waits.append(seconds); return check()
        with patch.object(M.time, "monotonic", return_value=11), patch.object(M, "wait", side_effect=waiting):
            self.assertEqual(surface.walk(), [frame, child])
        self.assertEqual(waits, [29])


class McpUpdateProtocol(unittest.TestCase):
    def resources(self, root):
        mcp = M.load("native-linux-update-mcp")
        raw = {name: ("unit-nonexecutable:" + name).encode() for name in mcp.MODULE_FILES + mcp.ROUTING_FILES + ("setup/unit",)}
        hashes = {name: hashlib.sha256(body).hexdigest() for name, body in raw.items()}
        entries = {name: {"size": len(body), "mode": 0o755 if name.endswith(("runtime/node", "mcp-launcher", "mcp-router")) else 0o644}
                   for name, body in raw.items()}
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            for name, body in raw.items():
                row = tarfile.TarInfo(name); row.size = len(body); row.mode = entries[name]["mode"]
                tar.addfile(row, io.BytesIO(body))
        archive_raw = archive.getvalue()
        manifest = {"platform": "linux", "arch": "x86_64",
                    "modules": {"mcp": {"files": {name: hashes[name] for name in mcp.MODULE_FILES}},
                                "setup": {"files": {"setup/unit": hashes["setup/unit"]}}},
                    "managedRouting": {"files": {name: hashes[name] for name in mcp.ROUTING_FILES}},
                    "payloadArchive": {"schemaVersion": 1, "file": "modules.tar.gz", "files": entries,
                                       "unpackedSize": sum(map(len, raw.values()))}}
        manifest_raw = json.dumps(manifest).encode()
        bodies = {"builtin-manifest.json": manifest_raw, "modules.tar.gz": archive_raw,
                  "creator-hub": b"unit-nonexecutable-root:" + manifest_raw,
                  **{"modules/" + name: body for name, body in raw.items()}}
        p = profile(); source = root / "members/assembly16"; source.mkdir(parents=True)
        for name, body in bodies.items():
            file = source / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(body)
            p["artifacts"]["assembly16"]["files"][name] = M.pin(body)
        p["baseline"]["archive"] = M.pin(archive_raw); p["baseline"]["raw"] = M.pin(bodies["creator-hub"])
        package = {"usr/lib/Creator Hub/modules.tar.gz": M.pin(archive_raw)}
        return p, package, source, hashes

    def test_original_zip_resources_match_embedded_manifest_archive_and_package_inventory(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "signature") as signature:
            folder = Path(temp).resolve(); p, package, source, hashes = self.resources(folder)
            directory, pins, modes = M.baseline_mcp_inputs(folder, p, package, ("tool", "evidence"))
            self.assertEqual(directory, source / "modules")
            self.assertEqual(pins, {k: v for k, v in hashes.items() if not k.startswith("setup/")})
            self.assertEqual(modes, {name: 0o755 if name in ("mcp/creator-works-mcp-launcher", "mcp/server/runtime/node") else 0o644
                                     for name in M.load("native-linux-update-mcp").MODULE_FILES})
            self.assertEqual(signature.call_count, 2)
            self.assertEqual([call.args[0].name for call in signature.call_args_list], ["runtime.json", "router.json"])
            self.assertFalse((folder / "extracted").exists())

    def test_changed_direct_resource_manifest_archive_or_package_refuses(self):
        for kind in ("direct", "manifest", "archive", "package", "missing"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp, patch.object(M, "signature") as signature:
                folder = Path(temp).resolve(); p, package, source, _ = self.resources(folder)
                if kind == "direct": (source / "modules/mcp/server/runtime/node").write_bytes(b"wrong")
                elif kind == "manifest":
                    file = source / "builtin-manifest.json"; file.write_bytes(b"{}"); p["artifacts"]["assembly16"]["files"][file.name] = M.pin(b"{}")
                elif kind == "archive": (source / "modules.tar.gz").write_bytes(b"wrong")
                elif kind == "package": package["usr/lib/Creator Hub/modules.tar.gz"]["sha256"] = "e" * 64
                else: del p["artifacts"]["assembly16"]["files"]["modules/routing/router.minisig"]
                with self.assertRaises((RuntimeError, KeyError)):
                    M.baseline_mcp_inputs(folder, p, package, ("tool", "evidence"))
                signature.assert_not_called()

    def test_source_signature_refusal_is_not_an_inventory_approval(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(M, "signature", side_effect=RuntimeError("invalid signature")):
            folder = Path(temp).resolve(); p, package, _, _ = self.resources(folder)
            with self.assertRaisesRegex(RuntimeError, "invalid signature"):
                M.baseline_mcp_inputs(folder, p, package, ("tool", "evidence"))

    def test_real_protocol_gate_rejects_eof_missing_phase_bad_identity_route_and_reconnect(self):
        self.assertEqual(M.mcp_protocol_receipt(mcp_receipt()), mcp_receipt())
        for kind in ("eof", "missing", "protocol", "identity", "route", "reconnect", "reused", "settings", "close", "promotion"):
            value = mcp_receipt()
            if kind == "eof": value = {"eofSent": True, "runtimeSurvived": True}
            elif kind == "missing": value["checks"].pop()
            elif kind == "protocol": value["checks"][1]["protocol"]["tools"] = []
            elif kind == "identity": value["checks"][1]["router"]["startTime"] = "reused"
            elif kind == "route": value["checks"][2]["route"] = {"wrong": {}}
            elif kind == "reconnect": value["reconnect"]["command"] += "-other"
            elif kind == "reused": value["reconnect"]["router"]["pid"] = value["checks"][0]["router"]["pid"]
            elif kind == "settings": value["protectedAfter"] = {"changed": True}
            elif kind == "close": value["originalNormalEofClose"] = False
            else: value["releaseReady"] = True
            with self.subTest(kind=kind), self.assertRaises(RuntimeError): M.mcp_protocol_receipt(value)

    def test_completion_calls_protocol_then_reconnect_then_original_eof_before_pass(self):
        receipt = mcp_receipt(); connection = Mock()
        connection.check.return_value = receipt["checks"][-1]
        connection.reconnect.return_value = receipt["reconnect"]; connection.close.return_value = receipt
        report = {"mcpChecks": receipt["checks"][:2]}
        with patch.object(M, "save") as save:
            M.complete_mcp_protocol(connection, report)
        self.assertEqual(connection.mock_calls, [unittest.mock.call.check("after-hub-close"), unittest.mock.call.reconnect(), unittest.mock.call.close()])
        save.assert_called_once_with(M.BASE / "result/mcp-protocol.json", receipt)
        self.assertTrue(report["runtimeSurvived"])
        self.assertEqual(report["mcpProtocol"], receipt)

    def test_completion_failure_never_claims_runtime_survived_or_retries(self):
        for failure in ("check", "reconnect", "close", "receipt", "save"):
            connection = Mock(); connection.close.return_value = mcp_receipt()
            if failure in ("check", "reconnect", "close"): getattr(connection, failure).side_effect = RuntimeError("original")
            if failure == "receipt": connection.close.return_value = {"eofSent": True}
            report = {"mcpChecks": []}
            with self.subTest(failure=failure), patch.object(M, "save", side_effect=RuntimeError("original") if failure == "save" else None), self.assertRaises(RuntimeError):
                M.complete_mcp_protocol(connection, report)
            self.assertNotIn("runtimeSurvived", report)
            self.assertLessEqual(connection.check.call_count, 1); self.assertLessEqual(connection.reconnect.call_count, 1)
            self.assertLessEqual(connection.close.call_count, 1)

    def test_real_sdk_staging_keeps_locked_inputs_and_unrelated_files_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); checkout, base = root / "checkout", root / "fixture"; base.mkdir()
            source = checkout / "modules/mcp"; (source / "node_modules/sdk").mkdir(parents=True)
            (source / "package.json").write_bytes(b"unit-package"); (source / "package-lock.json").write_bytes(b"placeholder")
            (source / "node_modules/sdk/index.js").write_bytes(b"unit-nonexecutable")
            (source / "node_modules/.bin").mkdir(); (source / "node_modules/.bin/ignored").write_bytes(b"never copy")
            unrelated = base / "keep"; unrelated.write_bytes(b"unchanged")
            reader = M.read
            lock = (HERE.parent / "modules/mcp/package-lock.json").read_text(encoding="utf-8").encode()
            def read(path, *args, **kw): return lock if Path(path) == source / "package-lock.json" else reader(path, *args, **kw)
            with patch.object(M, "BASE", base), patch.object(M, "read", side_effect=read):
                M.stage_mcp_sdk({"GITHUB_WORKSPACE": str(checkout)})
                with self.assertRaises(RuntimeError): M.stage_mcp_sdk({"GITHUB_WORKSPACE": str(checkout)})
            self.assertEqual((base / "sdk/package-lock.json").read_bytes(), lock)
            self.assertEqual((base / "sdk/node_modules/sdk/index.js").read_bytes(), b"unit-nonexecutable")
            self.assertFalse((base / "sdk/node_modules/.bin").exists())
            self.assertEqual(unrelated.read_bytes(), b"unchanged")

    def test_bad_sdk_lock_refuses_before_any_fixture_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); source = root / "modules/mcp"; source.mkdir(parents=True)
            (source / "package-lock.json").write_bytes(b"wrong lock")
            with patch.object(M, "BASE", root / "fixture"), self.assertRaises(RuntimeError):
                M.stage_mcp_sdk({"GITHUB_WORKSPACE": str(root)})
            self.assertFalse((root / "fixture").exists())

    def test_actual_session_inserts_protocol_before_launch_after_both_decisions_and_after_close(self):
        tree = ast.parse((HERE / "native-linux-production-016-update.py").read_text())
        session = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "native_session")
        code = ast.unparse(session)
        self.assertLess(code.index("connection.start()"), code.index("bootstrap16("))
        self.assertLess(code.index("connection.start()"), code.index("['/usr/bin/creator-hub']"))
        self.assertEqual(code.count("connection.check('after-update')"), 2)
        self.assertLess(code.index("connection.check('after-update')"), code.index("replacement.close()"))
        self.assertLess(code.rindex("connection.check('after-update')"), code.index("surface.close()"))
        self.assertLess(code.index("surface.close()"), code.index("complete_mcp_protocol(connection, report)"))
        self.assertLess(code.index("complete_mcp_protocol(connection, report)"), code.index("outcome(scenario, report)"))
        self.assertNotIn("sys.stdin.buffer.read()", code)
        self.assertIn("native-linux-update-mcp.py", M.SOURCES)
        seed = next(n for n in ast.walk(session) if isinstance(n, ast.Call) and ast.unparse(n.func) == "mcp.prepare_existing_route")
        self.assertEqual(ast.unparse(seed.args[4]), "payload_modes")

    def test_helper_preflight_locked_sdk_and_export_are_finite(self):
        workflow = (HERE.parent / ".github/workflows/native-linux-production-016-update.yml").read_text()
        self.assertLess(workflow.index("scripts/native-linux-update-mcp.test.py"), workflow.index("Bind independent profile"))
        self.assertIn("npm ci --prefix modules/mcp --ignore-scripts --no-audit --no-fund", workflow)
        code = (HERE / "native-linux-production-016-update.py").read_text()
        exported = ast.unparse(next(n for n in ast.parse(code).body if isinstance(n, ast.FunctionDef) and n.name == "export_evidence"))
        for path in ("result/mcp-protocol.json", "result/mcp/existing/sdk.stdout", "result/mcp/existing/sdk.stderr", "result/mcp/existing/sdk-result.json",
                     "result/mcp/reconnect/sdk.stdout", "result/mcp/reconnect/sdk.stderr", "result/mcp/reconnect/sdk-result.json"):
            self.assertIn(path, exported)
        self.assertNotIn("rglob", exported)


class FeatureReadinessEvidence(unittest.TestCase):
    def fixture(self, **overrides):
        values = {"heading": "Creator Works MCP", "status": "Ready", "error": "", "disabled": None, **overrides}
        calls = []
        suffixes = {"#feature-mcp h2": "heading", '#feature-mcp [data-field="status"]': "status",
                    '#feature-mcp [data-field="error"]': "error", '#feature-mcp [data-field="controls"]': "disabled"}
        def read(selector, property="text"):
            label = suffixes[selector]; calls.append((label, property))
            value = values[label]
            if isinstance(value, BaseException): raise value
            return value() if callable(value) else value
        page = SimpleNamespace(d=SimpleNamespace(read=read), evidence={})
        return page, calls

    def run_guard(self, page):
        return M.HtmlPages.require_feature_ready(page, "mcp", "Creator Works MCP")

    def test_ready_path_keeps_exact_four_original_reads_without_diagnostic_or_input(self):
        page, calls = self.fixture()
        self.run_guard(page)
        self.assertEqual(calls, [("heading", "text"), ("status", "text"), ("error", "text"), ("disabled", "attribute/disabled")])
        self.assertEqual(page.evidence, {})

    def test_needs_attention_retains_exact_status_and_fixed_failure_only_error(self):
        page, calls = self.fixture(status="Needs attention", error="Retained module mode changed. Nothing was opened.")
        with self.assertRaisesRegex(RuntimeError, "^Direct feature not Ready$"): self.run_guard(page)
        record = page.evidence["featureReadinessRefusal"]
        self.assertEqual(record["guardReads"]["status"]["value"], "Needs attention")
        self.assertNotIn("error", record["guardReads"])
        self.assertEqual(record["failureOnlyReads"]["error"]["value"], "Retained module mode changed. Nothing was opened.")
        self.assertEqual(calls, [("heading", "text"), ("status", "text"), ("error", "text")])
        self.assertFalse(record["guardPassed"]); self.assertFalse(record["inputAuthority"])

    def test_review_saved_settings_and_unknown_status_are_not_promoted_to_ready(self):
        for status in ("Review saved settings", "Checking Unity connection", "Unknown future status"):
            page, _ = self.fixture(status=status)
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, "^Direct feature not Ready$"): self.run_guard(page)
            self.assertEqual(page.evidence["featureReadinessRefusal"]["guardReads"]["status"]["value"], status)

    def test_heading_error_and_disabled_mismatches_preserve_short_circuit_order(self):
        for override, original in (({"heading": "wrong"}, ["heading"]),
                                   ({"error": "native read failed"}, ["heading", "status", "error"]),
                                   ({"disabled": "true"}, ["heading", "status", "error", "disabled"])):
            page, calls = self.fixture(**override)
            with self.subTest(override=override), self.assertRaisesRegex(RuntimeError, "^Direct feature not Ready$"): self.run_guard(page)
            row = page.evidence["featureReadinessRefusal"]
            self.assertEqual(list(row["guardReads"]), original)
            self.assertEqual([label for label, _ in calls[:len(original)]], original)
            self.assertLessEqual(len(calls), 4)

    def test_original_driver_exception_is_preserved_without_failure_only_queries(self):
        original = RuntimeError("original transport failure")
        page, calls = self.fixture(status=original)
        with self.assertRaises(RuntimeError) as caught: self.run_guard(page)
        self.assertIs(caught.exception, original)
        self.assertEqual(calls, [("heading", "text"), ("status", "text")])
        self.assertEqual(page.evidence["featureReadinessRefusal"]["failureOnlyReads"], {})

    def test_failure_only_read_error_cannot_replace_original_refusal(self):
        page, calls = self.fixture(status="Needs attention", error=RuntimeError("DO NOT RECORD CREDENTIAL CONTENT"))
        with self.assertRaisesRegex(RuntimeError, "^Direct feature not Ready$"): self.run_guard(page)
        record = page.evidence["featureReadinessRefusal"]
        self.assertEqual(record["failureOnlyReads"]["error"], {"unavailable": "RuntimeError"})
        self.assertNotIn("CREDENTIAL", json.dumps(record))
        self.assertEqual(len(calls), 3)

    def test_later_readiness_change_never_rechecks_or_accepts_the_failed_guard(self):
        page, calls = self.fixture(heading="wrong", status="Ready", error="")
        with self.assertRaisesRegex(RuntimeError, "^Direct feature not Ready$"): self.run_guard(page)
        row = page.evidence["featureReadinessRefusal"]
        self.assertEqual(row["failureOnlyReads"]["status"]["value"], "Ready")
        self.assertFalse(row["guardPassed"])
        self.assertEqual([label for label, _ in calls], ["heading", "status", "error"])

    def test_large_error_is_bounded_and_first_record_is_never_overwritten(self):
        page, _ = self.fixture(status="Needs attention", error="x" * 100000)
        with self.assertRaises(RuntimeError): self.run_guard(page)
        first = copy.deepcopy(page.evidence["featureReadinessRefusal"])
        field = first["failureOnlyReads"]["error"]
        self.assertEqual(field["chars"], 100000); self.assertEqual(len(field["prefix"]), 2048)
        self.assertTrue(field["truncated"]); self.assertNotIn("value", field)
        with self.assertRaises(RuntimeError): self.run_guard(page)
        self.assertEqual(page.evidence["featureReadinessRefusal"], first)

    def test_diagnostic_sink_failure_preserves_the_same_readiness_refusal(self):
        class Broken(dict):
            def setdefault(self, *args): raise RuntimeError("sink failed")
        page, _ = self.fixture(status="Needs attention"); page.evidence = Broken()
        with self.assertRaisesRegex(RuntimeError, "^Direct feature not Ready$"): self.run_guard(page)

    def test_capture_has_no_input_fallback_wait_or_transport_retry(self):
        method = next(n for n in ast.walk(ast.parse((HERE / "native-linux-production-016-update.py").read_text()))
                      if isinstance(n, ast.FunctionDef) and n.name == "require_feature_ready")
        calls = [ast.unparse(n.func) for n in ast.walk(method) if isinstance(n, ast.Call)]
        self.assertFalse(set(calls) & {"self.click", "wait", "time.sleep", "self.start", "self.optional", "subprocess.Popen"})
        self.assertEqual(calls.count("self.d.read"), 1)


if __name__ == "__main__":
    if sys.argv[1:] == ["GenuineGiBinding"]:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(GenuineGiBinding))
        sys.exit(0 if result.testsRun == 1 and result.wasSuccessful() and not result.skipped and not result.expectedFailures else 1)
    else:
        unittest.main()
