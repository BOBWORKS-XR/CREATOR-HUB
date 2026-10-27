"""Explicit disposable production-016 migration scenarios; never release authority.

The separate inspection lane remains data-only. No mode in its binding grants
permission to execute this controller. broker/session are fixed internal roles,
not path, command, package or scenario overrides.
"""
import copy
import base64
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import threading
import io
import time
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BRANCH = "refs/heads/validation/native-linux-production-016"
WORKFLOW = "BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@" + BRANCH
SCENARIOS = ("migration-guide-cancel", "migration-first-system-cancel",
             "migration-second-system-cancel", "migration-approve")
BASE = Path("/opt/creator-polkit-fixture")
USER, UID = "creator-polkit-fixture", 21314
HUB = "/usr/bin/creator-hub"
HELPER = "/usr/libexec/creator-hub-deb-retirement-helper"
# Finite union of read-only helper paths in pins.rs, setup.rs and linux/{metadata,setup}.rs.
HELPER_INSPECTION_FILES = (
    "/usr/bin/dpkg", "/usr/bin/dpkg-query",
    "/var/lib/dpkg/diversions", "/var/lib/dpkg/statoverride",
    "/var/lib/dpkg/info/creator-works-mcp.list", "/var/lib/dpkg/info/creator-works-mcp.md5sums",
    "/var/lib/dpkg/info/creator-project-setup.list", "/var/lib/dpkg/info/creator-project-setup.md5sums",
    "/usr/bin/creator-works-mcp-launcher",
    "/usr/lib/Creator Works MCP/server/LICENSE", "/usr/lib/Creator Works MCP/server/THIRD_PARTY_NOTICES.md",
    "/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs",
    "/usr/lib/Creator Works MCP/server/runtime/LICENSE", "/usr/lib/Creator Works MCP/server/runtime/VERSION",
    "/usr/lib/Creator Works MCP/server/runtime/node", "/usr/lib/Creator Works MCP/server/runtime/node.exe",
    "/usr/lib/Creator Works MCP/server/unity-extension/Editor/BanterMCPBridge.cs",
    "/usr/lib/Creator Works MCP/server/unity-extension/Editor/CreatorWorksMCPLogo.png",
    "/usr/share/applications/Creator Works MCP.desktop",
    "/usr/share/icons/hicolor/128x128/apps/creator-works-mcp-launcher.png",
    "/usr/share/icons/hicolor/256x256@2/apps/creator-works-mcp-launcher.png",
    "/usr/share/icons/hicolor/32x32/apps/creator-works-mcp-launcher.png",
    "/usr/bin/creator-project-setup", "/usr/share/applications/Creator Project Setup.desktop",
    "/usr/share/icons/hicolor/32x32/apps/creator-project-setup.png",
    "/usr/share/icons/hicolor/256x256@2/apps/creator-project-setup.png",
    "/usr/share/icons/hicolor/128x128/apps/creator-project-setup.png",
    "/usr/share/creator-project-setup/retired-by-creator-hub.txt",
)
HELPER_INSPECTION_DIRS = ("/var/lib/dpkg/info", "/var/lib/dpkg/updates",
                          "/var/lib/creator-hub-deb-retirement", "/var/lib/creator-hub-deb-retirement-setup")
CI_SHARED_DIRECTORIES = ("/usr/share/applications", "/usr/share/icons", "/usr/share/icons/hicolor",
                         "/usr/share/icons/hicolor/128x128", "/usr/share/icons/hicolor/128x128/apps",
                          "/usr/share/icons/hicolor/32x32", "/usr/share/icons/hicolor/32x32/apps",
                          "/usr/share/dict", "/usr/share/man", "/usr/share/man/man1",
                          "/usr/share/vim", "/usr/share/vim/vim82", "/usr/share/vim/vim82/doc", "/usr/share/aclocal")
METADATA_DATABASES = ("/var/lib/dpkg/diversions", "/var/lib/dpkg/statoverride")
METADATA_BYTES = 4 * 1024 * 1024
METADATA_GRAPH_BYTES = 384 * 1024
POLICY = "/usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy"
TITLE = "Creator Hub - Development Preview"
CONFIG = "config/creator-works-mcp/launcher-config.json"
LEGACY = "config/banter-mcp/launcher-config.json"
JOURNAL = "config/creator-works-mcp/hosted-operation-outcomes.json"
JOURNAL_COMMANDS = frozenset((
    "begin_ui_operation", "finish_ui_operation", "load_config", "save_config", "product_settings_status",
    "review_product_settings", "review_convergence_server", "discover_unity_projects", "get_onboarding_status",
    "add_project", "one_click_setup", "review_existing_client_connection", "review_existing_client_connections",
    "pending_client_recovery", "recover_client_connection", "get_project_sdk_profile", "get_unity_extension_status",
    "update_configured_unity_extensions", "update_codex_mcp_config", "update_claude_mcp_config",
    "update_claude_desktop_mcp_config", "remove_claude_desktop_mcp_config", "update_antigravity_mcp_config",
    "update_opencode_mcp_config", "remove_codex_mcp_config", "remove_claude_mcp_config", "remove_antigravity_mcp_config",
    "remove_opencode_mcp_config", "install_unity_extension", "set_unity_custom_scripts", "set_unity_allow_all_tests",
    "get_project_feedback_settings", "set_project_feedback_settings",
))
JOURNAL_OUTCOMES = frozenset(("accepted", "returned-ok", "returned-error", "unknown-acknowledged"))
TERMS = "data/CreatorHub/consent/hub-usage-terms.json"
MCP_VERSION, SETUP_VERSION = "2.7.7-1+hub.retention016.1", "0.3.7-1+hub.retention016.1"
OLD_NODE = "/usr/lib/Creator Works MCP/server/runtime/node"
OLD_SERVER = "/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs"
NODE_SHA = "62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527"
SDK_LOCK = "ded7a99b78aca304253d5287cc1b884a845afde083eb32d1a2abecd14468ba60"
FLAGS = dict.fromkeys(("migrationAccepted", "signedUpdateAccepted", "automaticRestartAccepted",
                       "flatpakAccepted", "actualAiAccepted", "unityInteropAccepted", "releaseReady"), False)
SOURCES = (Path(__file__).name, "native-linux-production-016-stage.py", "native-linux-016-stage.py",
           "linux-retirement-package-verify.py", "native-linux-integrated-pages.py",
           "native-linux-root-probe.py", "native-unix-window.py", "native-linux-polkit-probe.py")
ENVIRONMENT = ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF",
               "GITHUB_EVENT_NAME", "GITHUB_SHA", "GITHUB_WORKFLOW_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
               "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "GITHUB_WORKSPACE",
               "CREATOR_NATIVE_LINUX_PRODUCTION_016", "CREATOR_MIGRATION_016_EXECUTE", "CREATOR_MIGRATION_016_SCENARIO")


def require(value, message):
    if not value:
        raise RuntimeError(message)


def load(name):
    spec = importlib.util.spec_from_file_location("migration016_" + name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


P = load("native-linux-production-016-stage")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def keys(value, names):
    require(type(value) is dict and set(value) == set(names), "Unknown/missing execution fields")


def admission(env, *, system=None, uid=None):
    system = sys.platform if system is None else system
    uid = os.getuid() if uid is None else uid
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
                "GITHUB_REF": BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": WORKFLOW,
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1", "CREATOR_MIGRATION_016_EXECUTE": "true"}
    require(system == "linux" and type(uid) is int and uid >= 0 and all(env.get(k) == v for k, v in expected.items()),
            "Exact manually opted-in production migration workflow required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Exact harness source required")
    scenario = env.get("CREATOR_MIGRATION_016_SCENARIO")
    require(scenario in SCENARIOS, "One finite scenario required")
    require(not any(k.startswith(("LD_", "DYLD_", "WEBKIT_", "TAURI_")) or k in
                    ("PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "SSL_CERT_FILE", "SSL_CERT_DIR") for k in env), "Injected runtime refused")
    require(not any(env.get(k) for k in ("APPIMAGE", "APPDIR", "FLATPAK_ID")), "Native DEB execution only")
    return scenario


def read_file(file, limit=262144, *, uid=None, mode=None):
    require(file.is_absolute() and file.resolve() == file, "Canonical nonlinked input required")
    for ancestor in file.parents:
        require(not ancestor.is_symlink(), "Redirected input ancestor")
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit
            and (uid is None or before.st_uid == uid) and (mode is None or stat.S_IMODE(before.st_mode) == mode), "Bounded ordinary input metadata differs")
    fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_nlink", "st_uid", "st_gid", "st_mtime_ns")
    # Linux execution compares change-time too. Windows stat/fstat expose
    # different ctime semantics; use their common creation-time when available.
    fields += (("st_ctime_ns",) if os.name != "nt" else
               (("st_birthtime_ns",) if hasattr(before, "st_birthtime_ns") else ()))
    stamp = lambda value: tuple(getattr(value, k) for k in fields)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(file, flags), "rb") as stream:
        require(stamp(os.fstat(stream.fileno())) == stamp(before), "Input replaced before read")
        raw = stream.read(limit + 1)
        require(len(raw) == before.st_size and stamp(os.fstat(stream.fileno())) == stamp(before), "Input changed during read")
    require(stamp(file.lstat()) == stamp(before), "Input pathname changed")
    return raw


def save(file, value, mode=0o600):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
    require(len(raw) <= 1048576, "Receipt bound exceeded")
    P.write(file, raw, mode)


def production_contract(value):
    expected = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                "mcpVersion": MCP_VERSION, "setupVersion": SETUP_VERSION, "nativeAcceptance": False, "externalQualificationRequired": True}
    require(type(value) is dict and value == expected
            and type(value["protocolVersion"]) is int and value["nativeAcceptance"] is False
            and value["externalQualificationRequired"] is True, "Strict unqualified production protocol 2 required")


def validate_binding(binding, harness):
    keys(binding, ("schemaVersion", "cohort", "inspectionOnly", "profile", "api", "productionProof", "packageFiles", "resourceFiles", *P.FLAGS))
    require(type(binding["schemaVersion"]) is int and binding["schemaVersion"] == 1 and binding["cohort"] == P.COHORT
            and binding["inspectionOnly"] is True and all(binding[k] is False for k in P.FLAGS), "Inspection cannot self-authorize native execution")
    profile = P.profile(binding["profile"])
    P.api_binding(binding["api"], profile, harness)
    proof = binding["productionProof"]
    keys(proof, ("cohort", "sourceCommit", "sourceTree", "compiledFeatures", "rawHub", "hub", "productionContract", "rawToPackaged", *P.FLAGS))
    require(proof["cohort"] == P.COHORT and proof["sourceCommit"] == profile["assembly"]["sourceCommit"]
            and proof["sourceTree"] == profile["assembly"]["sourceTree"] and proof["compiledFeatures"] == P.FEATURES
            and proof["rawHub"] == profile["pins"]["rawHub"] and proof["hub"] == profile["pins"]["hub"]
            and proof["rawToPackaged"] == "exact-tauri-bundle-marker-deb" and all(proof[k] is False for k in P.FLAGS), "Exact new production Root proof required")
    production_contract(proof["productionContract"])
    require(type(binding["packageFiles"]) is dict and 4 <= len(binding["packageFiles"]) <= 256, "Bounded installed inventory required")
    for name, pin in binding["packageFiles"].items():
        P.S.safe_name(name); keys(pin, ("size", "sha256", "mode"))
        require(not name.startswith("etc/") and type(pin["size"]) is int and 0 <= pin["size"] <= 256 * 1024 * 1024
                and type(pin["mode"]) is int and pin["mode"] in (0o644, 0o755)
                and type(pin["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]), "Unreviewed installed inventory field")
    require(type(binding["resourceFiles"]) is dict and 0 < len(binding["resourceFiles"]) <= 64, "Bounded signed resource map required")
    for name, sha in binding["resourceFiles"].items():
        P.S.safe_name(name)
        require(type(sha) is str and re.fullmatch(r"[a-f0-9]{64}", sha), "Invalid signed resource hash")
    for name, mode in (("hub", 0o755), ("helper", 0o755), ("policy", 0o644), ("service", 0o644)):
        value = binding["packageFiles"].get(P.S.DEB_MEMBERS[name])
        require(value == {**profile["pins"][name], "mode": mode}, "Installed package binding differs")
    return profile


def execution_request(env, binding_raw):
    scenario = admission(env)
    binding = P.parse(binding_raw)
    validate_binding(binding, env["GITHUB_SHA"])
    return {"schemaVersion": 1, "cohort": "production-016-migration-execution", "scenario": scenario,
            "workflowRef": WORKFLOW, "harnessSource": env["GITHUB_SHA"], "bindingSha256": digest(binding_raw)}


def check_request(request, env, binding_raw):
    keys(request, ("schemaVersion", "cohort", "scenario", "workflowRef", "harnessSource", "bindingSha256"))
    require(type(request["schemaVersion"]) is int and request == execution_request(env, binding_raw), "Execution request changed or is not this workflow's intent")
    return request["scenario"]


JOURNAL_PHASE_COMMANDS = {
    "migration-projects": ("review_existing_client_connections", "review_convergence_server"),
    "projects-only": (),
    "mcp-page": ("load_config", "discover_unity_projects"),
}


def journal_delta(previous, current, *, phase):
    require(type(phase) is str and phase in JOURNAL_PHASE_COMMANDS, "Finite journal navigation phase required")
    for value in (previous, current):
        keys(value, ("revision", "records"))
        require(type(value["revision"]) is int and value["revision"] == 1 and type(value["records"]) is list
                and len(value["records"]) <= 32, "Bounded operation journal required")
    old = previous["records"]
    require(current["records"][:len(old)] == old, "Earlier operation records changed")
    tail = current["records"][len(old):]
    expected = JOURNAL_PHASE_COMMANDS[phase]
    require(len(tail) == len(expected), "Unexpected operation journal append count")
    session = None
    last = 0
    for record, command in zip(tail, expected):
        keys(record, ("session", "id", "command", "outcome"))
        require(type(record["session"]) is str and re.fullmatch(r"[a-f0-9]{64}", record["session"])
                and type(record["id"]) is int and last < record["id"] <= 64
                and record["command"] == command and record["outcome"] == "returned-ok", "Only source-required completed operations may append")
        session = session or record["session"]
        require(record["session"] == session and not any(r["session"] == session for r in old), "Operation session reused/changed")
        last = record["id"]
    if phase == "mcp-page":
        require([r["id"] for r in tail] == [3, 4], "New Root's two read operation IDs differ")
    return current


def observe_journal(previous, home, report, phase):
    require(phase in ("first", "reopened"), "Finite journal observation phase required")
    raw = read_file(home / JOURNAL, 65536, uid=UID)
    capture = {"diagnosticOnly": True, "validationAuthority": False,
               "file": {"size": len(raw), "sha256": digest(raw)}}
    report.setdefault("operationJournals", {})[phase] = capture
    current = P.parse(raw)

    def public_name(value, allowed):
        if type(value) is str and value in allowed:
            return value
        return {"redacted": True, **({"sha256": digest(value.encode("utf-8", "surrogatepass"))} if type(value) is str else {})}

    def summary(value):
        value = value if type(value) is dict else {}
        revision, rows = value.get("revision"), value.get("records")
        result = {"revision": revision if type(revision) is int and 0 <= revision <= 0xffffffff else None,
                  "count": len(rows) if type(rows) is list else None, "records": [],
                  "omittedRecords": max(0, len(rows) - 32) if type(rows) is list else 0}
        for record in rows[:32] if type(rows) is list else []:
            if type(record) is not dict:
                result["records"].append({"shapeValid": False})
                continue
            session, identifier = record.get("session"), record.get("id")
            result["records"].append({
                "shapeValid": set(record) == {"session", "id", "command", "outcome"},
                "session": session if type(session) is str and re.fullmatch(r"[a-f0-9]{64}", session) else None,
                "id": identifier if type(identifier) is int and 0 < identifier <= 9_007_199_254_740_991 else None,
                "command": public_name(record.get("command"), JOURNAL_COMMANDS),
                "outcome": public_name(record.get("outcome"), JOURNAL_OUTCOMES),
            })
        return result

    old = previous.get("records") if type(previous) is dict else None
    new = current.get("records") if type(current) is dict else None
    lists = type(old) is list and type(new) is list
    capture.update(previous=summary(previous), current=summary(current),
                   prefixEqual=new[:len(old)] == old if lists else None,
                   appendCount=len(new) - len(old) if lists else None)
    return current, raw


def observed_journal_delta(previous, home, report, phase):
    current, _raw = observe_journal(previous, home, report, phase)
    # Projects navigation does not initialize the lazily mounted MCP page.
    expected_phase = "migration-projects" if phase == "first" else "projects-only"
    report["operationJournals"][phase].update(expectedPhase=expected_phase, expectedCommands=list(JOURNAL_PHASE_COMMANDS[expected_phase]))
    return journal_delta(previous, current, phase=expected_phase)


def observed_cancel_journal(baseline, original_raw, home, report, phase):
    current, raw = observe_journal(baseline, home, report, phase)
    require(current == baseline, "Guide cancellation changed operation journal records")
    expected = {"size": len(original_raw), "sha256": digest(original_raw)}
    require(raw == original_raw and report["operationJournals"][phase]["file"] == expected,
            "Guide cancellation changed original operation journal bytes or file pin")
    return current


def retention_state(scenario):
    require(scenario in SCENARIOS, "Unknown scenario")
    return (scenario in (SCENARIOS[2], SCENARIOS[3]), scenario == SCENARIOS[3])


def execute_scenario(scenario, consent, authorization, cancel_check, review_connections):
    require(scenario in SCENARIOS, "Unknown scenario; no action permitted")
    consent(scenario != SCENARIOS[0])
    if scenario == SCENARIOS[0]:
        cancel_check()
        return
    review_connections()
    authorization("mcp", scenario in SCENARIOS[2:])
    if scenario in SCENARIOS[2:]:
        authorization("setup", scenario == SCENARIOS[3])


def inspection(value, product, retained):
    version = (MCP_VERSION if product == "mcp" else SETUP_VERSION) if retained else ("2.7.7" if product == "mcp" else "0.3.7")
    expected = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                "status": "inspected-retained-read-only" if retained else "inspected-read-only", "nativeAcceptance": False,
                "externalQualificationRequired": True, "product": product, "package": "creator-works-mcp" if product == "mcp" else "creator-project-setup",
                "packageState": "compatibility" if retained else "original", "version": version, "readOnly": True,
                "baselineMatches": not retained, "compatibilityMatches": retained, "snapshotAuthoritative": False,
                "packageTransactionStarted": False, "retainedFilesVerified": 9 if retained and product == "mcp" else 0,
                "tombstoneFilesVerified": 1 if retained and product == "setup" else 0, "omittedFilesVerified": 5 if retained else 0}
    require(value == expected and all(type(value[k]) is type(v) for k, v in expected.items()), "Strict per-product production inspection required")


def policy_question(raw):
    root = ET.fromstring(raw)
    actions = root.findall("action")
    require(root.tag == "policyconfig" and len(actions) == 1 and actions[0].get("id") == "com.creatorworks.hub.deb-retirement", "One production authentication action required")
    action = actions[0]
    require([action.findtext("defaults/" + k) for k in ("allow_any", "allow_inactive", "allow_active")] == ["auth_admin"] * 3
            and [(v.get("key"), v.text) for v in action.findall("annotate")] == [("org.freedesktop.policykit.exec.path", HELPER)], "No authorization shortcut or different executable allowed")
    question = action.findtext("message")
    require(type(question) is str and 0 < len(question) <= 1024, "Source-bound policy message required")
    return question


def helper_namespace():
    paths = set()
    for name in (*HELPER_INSPECTION_FILES, *HELPER_INSPECTION_DIRS):
        leaf = PurePosixPath(name)
        paths.update(map(str, (leaf, *leaf.parents)))
    require(len(paths) <= 96, "Fixed helper diagnostic namespace exceeds bound")
    entries = []
    for path in sorted(paths):
        try:
            info = os.lstat(path)
            kind = {stat.S_IFDIR: "directory", stat.S_IFREG: "file", stat.S_IFLNK: "symlink"}.get(stat.S_IFMT(info.st_mode), "other")
            entries.append({"path": path, "type": kind, "uid": info.st_uid, "gid": info.st_gid,
                            "mode": stat.S_IMODE(info.st_mode), "modeOctal": f"{stat.S_IMODE(info.st_mode):04o}",
                            "nlink": info.st_nlink, "size": info.st_size, "dev": info.st_dev, "ino": info.st_ino,
                            "mtimeNs": info.st_mtime_ns, "ctimeNs": info.st_ctime_ns})
        except OSError as error:
            entries.append({"path": path, "error": type(error).__name__, "errno": error.errno})
    return {"scope": "fixed-helper-inspection-paths-only", "observedAtNs": time.time_ns(), "entries": entries}


def metadata_stamp(info):
    return tuple(getattr(info, key) for key in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))


def metadata_row(path, info):
    return {"path": path, "type": {stat.S_IFDIR: "directory", stat.S_IFREG: "file", stat.S_IFLNK: "symlink"}.get(stat.S_IFMT(info.st_mode), "other"),
            "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode), "nlink": info.st_nlink,
            "dev": info.st_dev, "ino": info.st_ino, "size": info.st_size, "mtimeNs": info.st_mtime_ns, "ctimeNs": info.st_ctime_ns}


def metadata_paths(database, raw):
    # Match metadata.rs's bounded record grammar, not translated dpkg --list output.
    require(database in METADATA_DATABASES and len(raw) <= METADATA_BYTES, "Unknown/oversized metadata database")
    text = raw.decode("utf-8")
    require(not text or text.endswith("\n"), "Truncated metadata database")
    lines = text[:-1].split("\n") if text else []
    require(len(lines) <= 24576 and all(line and len(line.encode()) <= 4095
            and not any(ord(c) < 32 or ord(c) == 127 for c in line) for line in lines), "Malformed/oversized metadata record")
    def endpoint(index, field, value):
        require(value.startswith("/") and len(value.encode()) <= 4095
                and (value == "/" or all(part not in ("", ".", "..") for part in value[1:].split("/"))), "Noncanonical metadata path")
        return {"database": database, "record": index, "field": field, "path": value}
    if database == METADATA_DATABASES[0]:
        require(len(lines) % 3 == 0, "Incomplete diversion triple")
        for index in range(0, len(lines), 3):
            require(lines[index + 2] == ":" or re.fullmatch(r"[a-z0-9][a-z0-9+.-]{1,254}", lines[index + 2]), "Invalid diversion package label")
            yield endpoint(index // 3, "from", lines[index])
            yield endpoint(index // 3, "to", lines[index + 1])
    else:
        for index, line in enumerate(lines):
            fields = line.split(" ", 3)
            require(len(fields) == 4, "Incomplete statoverride record")
            for value in fields[:2]:
                if value.startswith("#"):
                    require(re.fullmatch(r"0|[1-9][0-9]{0,9}", value[1:]) and int(value[1:]) < 0xffffffff, "Invalid numeric metadata identity")
                else:
                    require(re.fullmatch(r"[a-z_][a-z0-9_-]{0,254}", value), "Unsupported metadata identity")
            require(re.fullmatch(r"[0-7]{1,4}", fields[2]), "Invalid statoverride mode")
            yield endpoint(index, "path", fields[3])


class MetadataCaptureLimit(RuntimeError):
    pass


def helper_metadata():
    graph = {"scope": "whole-dpkg-metadata-parent-graph", "readOnly": True, "validationAuthority": False,
             "complete": True, "observedAtNs": time.time_ns(), "databases": [], "records": [], "nodes": [], "issues": []}
    database_handles, absent_databases, observed = [], [], {}
    steps = 0
    def issue(error, record=None):
        graph["complete"] = False
        graph["issues"].append({"record": record, "type": type(error).__name__, "reason": str(error)[:256]})
        budget()
    def budget():
        if len(graph["nodes"]) > 1024 or len(graph["records"]) > 1024 or len(graph["issues"]) > 64 or steps > 16384 \
                or len(json.dumps(graph, ensure_ascii=False, allow_nan=False).encode()) > METADATA_GRAPH_BYTES:
            raise MetadataCaptureLimit("Metadata diagnostic graph budget exceeded")
    def named(parent, name):
        return os.lstat("/") if parent is None else os.stat(name, dir_fd=parent, follow_symlinks=False)
    def opened(name, parent, flags, handles):
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, **({"dir_fd": parent} if parent is not None else {}))
        try:
            info = os.fstat(fd)
            try:
                name_info = named(parent, name)
            except OSError as error:
                raise RuntimeError("Metadata FD pathname unavailable after opening") from error
            require(metadata_stamp(info) == metadata_stamp(name_info), "Metadata FD/name identity changed")
            handles.append((fd, parent, name, metadata_stamp(info)))
            return fd, info
        except Exception:
            os.close(fd)
            raise
    def stable(handles):
        for fd, parent, name, before in handles:
            require(metadata_stamp(os.fstat(fd)) == before == metadata_stamp(named(parent, name)), "Metadata namespace changed/replaced")
    def close(handles):
        for fd, _, _, _ in reversed(handles):
            os.close(fd)
    def node(path, info, role):
        identity = metadata_stamp(info) if info is not None else None
        if path in observed:
            index, before = observed[path]
            require(before == identity, "Metadata path changed between records")
            row = graph["nodes"][index]
        else:
            index = len(graph["nodes"])
            row = metadata_row(path, info) if info is not None else {"path": path, "absentFinal": True}
            row["roles"] = []
            graph["nodes"].append(row)
            observed[path] = index, identity
        if role not in row["roles"]:
            row["roles"].append(role)
        if role == "parent":
            row["parentPredicateMatches"] = stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o7022 == 0
        budget()
        return index
    def walk(record):
        nonlocal steps
        handles, checks = [], []
        try:
            current = PurePosixPath("/")
            fd, root = opened("/", None, os.O_PATH | os.O_DIRECTORY, handles)
            directories = {"/": fd}
            record["walk"] = [node("/", root, "parent")]
            pending, links, count = list(PurePosixPath(record["path"]).parts), 0, 0
            while pending:
                count += 1
                steps += 1
                budget()
                require(count <= 1024, "Metadata parent walk too long")
                part = pending.pop(0)
                if part == "/":
                    current, fd = PurePosixPath("/"), directories["/"]
                    continue
                if part == ".":
                    continue
                if part == "..":
                    current = current.parent
                    fd = directories[str(current)]
                    continue
                path, last = str(current / part), not pending
                try:
                    info = os.stat(part, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    require(last, "Missing intermediate metadata parent")
                    record["walk"].append(node(path, None, "endpoint"))
                    checks.append((fd, part, None))
                    record["resolved"] = path
                    break
                checks.append((fd, part, metadata_stamp(info)))
                role = "alias" if stat.S_ISLNK(info.st_mode) else "endpoint" if last else "parent"
                index = node(path, info, role)
                record["walk"].append(index)
                if role == "alias":
                    links += 1
                    target = os.readlink(part, dir_fd=fd)
                    require(target and len(target.encode("utf-8")) <= 4095
                            and not any(ord(c) < 32 or ord(c) == 127 for c in target), "Unsupported metadata alias target")
                    row = graph["nodes"][index]
                    if "target" in row:
                        require(row["target"] == target, "Metadata alias changed")
                    row["target"] = target
                    budget()
                    require(links <= 40 and info.st_uid == 0 and info.st_nlink == 1, "Untrusted/looping metadata alias")
                    expanded = list(PurePosixPath(target).parts)
                    if target.startswith("/"):
                        expanded[0] = "/"
                    elif target == "." or target.startswith("./"):
                        expanded.insert(0, ".")
                    pending = expanded + pending
                    continue
                require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), "Unsupported metadata target type")
                current = PurePosixPath(path)
                if pending:
                    fd, opened_info = opened(part, fd, os.O_PATH | os.O_DIRECTORY, handles)
                    require(metadata_stamp(opened_info) == metadata_stamp(info), "Metadata parent replaced before opening")
                    directories[path] = fd
                else:
                    record["resolved"] = path
            record.setdefault("resolved", str(current))
            stable(handles)
            for parent, name, before in checks:
                try:
                    after = metadata_stamp(os.stat(name, dir_fd=parent, follow_symlinks=False))
                except FileNotFoundError:
                    after = None
                require(before == after, "Metadata entry changed/replaced during walk")
            record["complete"] = True
            budget()
        finally:
            close(handles)
    try:
        raw_databases = []
        for path in METADATA_DATABASES:
            entry = {"path": path}
            graph["databases"].append(entry)
            try:
                fd, info = opened("/", None, os.O_PATH | os.O_DIRECTORY, database_handles)
                for part in PurePosixPath(path).parts[1:-1]:
                    require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_mode & 0o7022 == 0, "Unprotected metadata database parent")
                    fd, info = opened(part, fd, os.O_PATH | os.O_DIRECTORY, database_handles)
                require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_mode & 0o7022 == 0, "Unprotected metadata database parent")
                try:
                    source, info = opened(PurePosixPath(path).name, fd, os.O_RDONLY, database_handles)
                except FileNotFoundError:
                    entry["absent"] = True
                    absent_databases.append((fd, PurePosixPath(path).name))
                    raw_databases.append((path, b""))
                    continue
                entry["identity"] = metadata_row(path, info)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == info.st_gid == 0
                        and info.st_mode & 0o7022 == 0 and 0 <= info.st_size <= METADATA_BYTES, "Unprotected/oversized metadata database")
                chunks, size = [], 0
                while True:
                    chunk = os.read(source, min(65536, METADATA_BYTES + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    require(size <= METADATA_BYTES, "Metadata database read limit exceeded")
                raw = b"".join(chunks)
                require(len(raw) == info.st_size, "Metadata database size changed during read")
                stable(database_handles)
                entry.update(bytes=len(raw), sha256=digest(raw))
                raw_databases.append((path, raw))
            except MetadataCaptureLimit:
                raise
            except Exception as error:
                issue(error)
        for path, raw in raw_databases:
            try:
                for record in metadata_paths(path, raw):
                    record["complete"] = False
                    graph["records"].append(record)
                    budget()
                    try:
                        walk(record)
                    except MetadataCaptureLimit:
                        raise
                    except Exception as error:
                        issue(error, len(graph["records"]) - 1)
            except MetadataCaptureLimit:
                raise
            except Exception as error:
                issue(error)
        stable(database_handles)
        for parent, name in absent_databases:
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise RuntimeError("Absent metadata database appeared during capture")
    except MetadataCaptureLimit as error:
        graph.update(complete=False, nodes=[], records=[], issues=[{"type": type(error).__name__, "reason": str(error)}])
    except Exception as error:
        graph["complete"] = False
        graph["issues"].append({"type": type(error).__name__, "reason": str(error)[:256]})
    finally:
        close(database_handles)
    if len(json.dumps(graph, ensure_ascii=False, allow_nan=False).encode()) > METADATA_GRAPH_BYTES:
        graph.update(complete=False, nodes=[], records=[], issues=[{"type": "MetadataCaptureLimit", "reason": "Metadata diagnostic graph budget exceeded"}])
    return graph


def helper_identity():
    observed = {"path": HELPER}
    try:
        file = Path(HELPER)
        info = file.lstat()
        fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_nlink", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")
        observed.update(size=info.st_size, mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid,
                        dev=info.st_dev, ino=info.st_ino, nlink=info.st_nlink)
        raw = read_file(file, 256 * 1024 * 1024)
        after = file.lstat()
        require(all(getattr(info, key) == getattr(after, key) for key in fields), "Helper identity changed during diagnostic read")
        observed["sha256"] = digest(raw)
    except Exception as error:
        observed["unavailable"] = type(error).__name__
    return observed


def tool(args, *, allowed=(0,), helper_pin=None):
    helper = bool(args) and args[0] == HELPER
    if helper:
        require(len(args) == 2 and args[1] in ("inspect", "inspect-retained-mcp-2.7.7", "inspect-setup-0.3.7", "inspect-retained-setup-0.3.7")
                and allowed == (0,), "Only fixed read-only helper inspections with successful exit required")
        keys(helper_pin, ("size", "sha256"))
        require(type(helper_pin["size"]) is int and 0 < helper_pin["size"] <= 256 * 1024 * 1024
                and type(helper_pin["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", helper_pin["sha256"]), "Exact helper byte pin required")
    else:
        require(helper_pin is None, "Helper diagnostics cannot capture another command")
    namespace_before = helper_namespace() if helper else None
    metadata_before = helper_metadata() if helper else None
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}, check=False)
    accepted = len(result.stdout) <= 262144 and len(result.stderr) <= 262144 and result.returncode in allowed
    if helper and not accepted:
        namespace_after = helper_namespace()
        metadata_after = helper_metadata()
        def output(raw):
            return {"bytes": len(raw), "sha256": digest(raw), "excerpt": raw[:2048].decode("utf-8", "replace"), "truncated": len(raw) > 2048}
        reason = None
        try:
            if len(result.stdout) <= 262144:
                report = P.parse(result.stdout)
                if type(report) is dict and type(report.get("reason")) is str:
                    reason = report["reason"][:1024]
        except Exception:
            pass
        caller = dict(uid=os.getuid(), euid=os.geteuid(), gid=os.getgid(), egid=os.getegid())
        destination = BASE if caller["euid"] == 0 else BASE / "result"
        save(destination / "helper-inspection-failure.json", {"schemaVersion": 1, "readOnly": True, "retryPermitted": False,
             "argv": args, "exitCode": result.returncode, "caller": caller,
             "namespaceBefore": namespace_before, "namespaceAfter": namespace_after,
             "metadataBefore": metadata_before, "metadataAfter": metadata_after,
             "helperExpected": {"path": HELPER, **helper_pin, "mode": 0o755, "uid": 0, "gid": 0},
             "helperActual": helper_identity(), "stdout": output(result.stdout), "stderr": output(result.stderr), "reasonExcerpt": reason})
    require(accepted, "Finite native inspection refused; no retry: " + args[0])
    return result.stdout


def installed(binding, retained=(False, False)):
    for name, pin in binding["packageFiles"].items():
        file = Path("/") / name
        raw = read_file(file, 256 * 1024 * 1024, uid=0, mode=pin["mode"])
        require(len(raw) == pin["size"] and digest(raw) == pin["sha256"] and file.stat().st_gid == 0, "Installed 016 resource differs: " + name)
    for package, version in (("creator-hub", "0.1.16"), ("creator-works-mcp", MCP_VERSION if retained[0] else "2.7.7"),
                             ("creator-project-setup", SETUP_VERSION if retained[1] else "0.3.7")):
        require(tool(["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", package])
                == f"{package}\t{version}\tamd64\tinstall ok installed\n".encode(), "Package state differs")
        require(not tool(["/usr/bin/dpkg", "--verify", package]), "Installed package integrity differs")
    for product, keep in zip(("mcp", "setup"), retained):
        action = ("inspect-retained-mcp-2.7.7" if keep else "inspect") if product == "mcp" else ("inspect-retained-setup-0.3.7" if keep else "inspect-setup-0.3.7")
        inspection(P.parse(tool([HELPER, action], helper_pin=binding["profile"]["pins"]["helper"])), product, keep)
    original = P.parse(read_file(BASE / "legacy-files.json", 65536, uid=0, mode=0o644))
    for product, keep in zip(("mcp", "setup"), retained):
        for name, pin in original[product].items():
            file = Path("/") / name
            remains = not keep or (product == "mcp" and name.startswith("usr/lib/Creator Works MCP/server/"))
            if remains:
                raw = read_file(file, 256 * 1024 * 1024, uid=0, mode=pin["mode"])
                require(len(raw) == pin["size"] and digest(raw) == pin["sha256"], "Original retained runtime bytes changed")
            else:
                require(not os.path.lexists(file), "Retired GUI file remains")
    if retained[1]:
        notice = read_file(Path("/usr/share/creator-project-setup/retired-by-creator-hub.txt"), 1024, uid=0, mode=0o644)
        require(digest(notice) == "a04ca21391c408ec055d22ba7defecd8278a0682e0d398538d77fbfb3605c5bb", "Exact Setup notice missing")
    return policy_question(read_file(Path(POLICY), 16384, uid=0, mode=0o644))


def fixture(root):
    home = root / "home"
    for part in ("home", "home/config", "home/data", "home/cache", "runtime", "tmp"):
        (root / part).mkdir(mode=0o700)
    project = home / "current-project"
    current = {"channels": [{"id": "current", "name": "Current retained project", "unity_project_path": str(project), "scene_path": None,
                             "enabled": True, "unknownChannel": "keep"}], "active_channel_id": "current", "mcp_server_path": OLD_SERVER,
               "auto_start": False, "tool_groups": "core", "enable_custom_scripts": False, "allow_all_tests": False,
               "automatic_update_checks": False, "connection_guide_version": 1, "unknownConfig": {"keep": 16}}
    legacy = copy.deepcopy(current)
    legacy["channels"][0]["id"] = "duplicate"
    legacy["channels"].append({"id": "missing", "name": "Earlier unique project", "unity_project_path": str(home / "missing-project"), "scene_path": None, "enabled": False})
    legacy["auto_start"] = True
    codex = ('# preserved unrelated options\nmodel = "keep-model"\n[mcp_servers.unrelated]\ncommand = "/bin/false"\n'
             '[mcp_servers.creator-works]\ncommand = ' + json.dumps(OLD_NODE) + '\nargs = [' + json.dumps(OLD_SERVER) + ']\n'
             'enabled = false\nstartup_timeout_sec = 37\n[mcp_servers.creator-works.env]\nCUSTOM = "preserve"\nUNITY_PROJECT_PATH = ' + json.dumps(str(project)) + '\n')
    claude = {"mcpServers": {"unrelated": {"command": "/bin/false"}, "creator-works": {"command": OLD_NODE, "args": [OLD_SERVER],
              "env": {"UNITY_PROJECT_PATH": str(project), "CUSTOM": "keep"}}}, "unknownClient": {"keep": 16}}
    values = {CONFIG: current, LEGACY: legacy, JOURNAL: {"revision": 1, "records": []}, ".codex/config.toml": codex, ".claude.json": claude,
              "config/Claude/claude_desktop_config.json": {"mcpServers": {"unrelated": {"command": "/bin/false"}}},
              "data/CreatorProjectSetup/editor-roots.json": ["/opt/016-no-editor"],
              "data/CreatorHub/preferences/hub-preferences.json": {"schemaVersion": 1, "preview": False, "autoDownload": False, "restoreHostedViews": False}}
    for name in ("current-project", "missing-project"):
        values.update({name + "/Packages/manifest.json": {"dependencies": {}}, name + "/Assets/keep.txt": "protected content\n",
                       name + "/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.21f1\n"})
    before = {}
    for name, value in values.items():
        file = home / name
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        raw = value.encode() if type(value) is str else json.dumps(value).encode()
        P.write(file, raw)
        before[name] = raw
    return before


def route(home):
    base = home / "data/creator-hub"
    active = P.parse(read_file(base / "mcp-route-v1/linux-x86_64/active.json", 16384))
    keys(active, ("schemaVersion", "descriptorSha256", "generation"))
    require(type(active["schemaVersion"]) is int and active["schemaVersion"] == 1
            and all(re.fullmatch(r"[a-f0-9]{64}", active[k]) for k in ("descriptorSha256", "generation")), "Finite active route required")
    return (base / "mcp-route-v1/linux-x86_64/router-v1/creator-hub-mcp-router",
            base / "runtime-generations/linux-x86_64" / active["generation"] / "mcp/server/creator-works-mcp.mjs")


def preserved(home, before, *, transferred, binding=None):
    changed = {CONFIG, LEGACY, JOURNAL, ".codex/config.toml", ".claude.json"} if transferred else {JOURNAL}
    for name, raw in before.items():
        if name not in changed:
            require(read_file(home / name) == raw, "Unrelated/current preference or project changed: " + name)
    if not transferred:
        require(not list(home.rglob("*.bak")), "Guide cancellation created migration backups")
        for name in ("data/CreatorHub/convergence/review-v1.json", "data/CreatorHub/convergence/move-v1.json",
                     "data/creator-hub/mcp-route-v1", "data/creator-hub/client-migrations-v1", "config/creator-works-mcp/.creator-hub-product-settings"):
            require(not (home / name).exists(), "Guide cancellation advanced migration")
        return
    require(binding is not None, "Production resource binding required after transfer")
    router, server = verified_route(home, binding)
    expected = P.parse(before[CONFIG])
    expected["channels"].append(P.parse(before[LEGACY])["channels"][1])
    expected["mcp_server_path"] = str(server)
    require(P.parse(read_file(home / CONFIG)) == expected and P.parse(read_file(home / LEGACY)) == expected,
            "Import did not preserve current preferences/selection and exact deduplicated projects")
    try:
        import tomllib as toml
    except ImportError:
        import toml
    codex = toml.loads(read_file(home / ".codex/config.toml").decode())
    wanted = toml.loads(before[".codex/config.toml"].decode())
    entry = wanted["mcp_servers"]["creator-works"]
    entry.update(command=str(router), args=[])
    entry["env"]["CREATOR_WORKS_CONFIG_OWNER"] = "creator-hub-v1"
    require(codex == wanted and b"# preserved unrelated options" in read_file(home / ".codex/config.toml"), "Unrelated Codex entry/options changed")
    claude = P.parse(before[".claude.json"])
    entry = claude["mcpServers"]["creator-works"]
    entry.update(command=str(router), args=[])
    entry["env"]["CREATOR_WORKS_CONFIG_OWNER"] = "creator-hub-v1"
    require(P.parse(read_file(home / ".claude.json")) == claude, "Unrelated Claude Code entries/options changed")
    for name in (CONFIG, LEGACY, JOURNAL, ".codex/config.toml", ".claude.json", "data/CreatorProjectSetup/editor-roots.json"):
        original = home / name
        backup = original.parent / ".creator-hub-settings-backups" / (original.name + "." + digest(before[name]) + ".bak")
        require(read_file(backup, uid=os.getuid(), mode=0o600) == before[name], "Exact original backup missing: " + name)


def neutral():
    pages = load("native-linux-integrated-pages")
    helper, native = pages.helpers()
    return pages, helper, native, load("native-linux-polkit-probe")


GUIDE = "Move your existing setup to this Creator Hub?\n\n- Back up settings first; add missing projects without duplicates and keep current preferences and selection.\n- Move verified existing AI connections to this Hub's signed runtime; keep other client entries.\n- Retire only verified standalone app entries; keep settings, Unity projects, backups and old runtime files.\n\n"
GUIDE_SUMMARY = "1 missing project(s); 2 known standalone app location(s). Custom launchers that need an old GUI or its registration are not converted.\n\nOnly exact MCP 2.7.7 and Project Setup 0.3.7 DEBs are eligible. Linux requests administrator authentication separately for each app after settings and connections transfer. Cancelling a later system prompt does not undo earlier cleanup or the completed transfer. Unknown outcomes require review, never automatic retry. All nine old MCP Node/server/license/bridge files stay at their existing paths. Setup keeps one fixed non-executable retirement notice.\n\nContinuing also accepts the unknown custom-GUI integration risk: custom integrations requiring an old app window or its desktop registration may stop working and are not converted. Cancel if you need those integrations."
GUIDE_END = "\n\nCustom or unverified connections and servers need separate review. Busy apps are not force-closed. Cancel changes no settings or installations."
CONNECTION_REVIEW_TITLE = "Review unverified MCP connections"


def connection_review(home, before, binding):
    names = (".codex/config.toml", ".claude.json", "config/Claude/claude_desktop_config.json")
    for name in names:
        require(read_file(home / name, uid=UID, mode=0o600) == before[name], "Client before-image changed before native approval: " + name)
    for name in (".gemini/config/mcp_config.json", "config/opencode/opencode.jsonc"):
        require(not os.path.lexists(home / name), "Unexpected additional migration client")
    try:
        import tomllib as toml
    except ImportError:
        import toml
    configs = (("Codex", toml.loads(before[names[0]].decode())["mcp_servers"]),
               ("Claude Code", P.parse(before[names[1]])["mcpServers"]))
    project = str(home / "current-project")
    details = []
    for client, servers in configs:
        require(set(servers) == {"unrelated", "creator-works"}, "Only exact synthetic client entries may be reviewed")
        entry = servers["creator-works"]
        require(entry["command"] == OLD_NODE and entry["args"] == [OLD_SERVER] and entry["env"]["UNITY_PROJECT_PATH"] == project,
                "Synthetic connection target/project changed")
        details.append(f"{client}\nCommand: {OLD_NODE}\nServer: {OLD_SERVER}\nProject kept: {project}")
    router, _server = verified_route(home, binding)
    question = ("These existing connections could not be publisher-verified:\n\n" + "\n\n".join(details)
                + f"\n\nMove them to the verified Hub router at {router}? Names and ownership markers are not proof. Continue only for your Creator Works connections. Exact backups, client options and other servers are kept. Cancel stops migration before changing any of these clients.")
    return {"question": question, "router": str(router), "beforeImages": {
        name: {"size": len(before[name]), "sha256": digest(before[name])} for name in names}}


def approve_connection_review(profile, guard, record):
    require(record.get("actionAttempts", 0) == 0, "Connection review already attempted; no replay")
    guard()
    _button, before = profile()
    record["profile"] = before
    guard()
    _button, current = profile()
    require(current == before, "Connection review changed between independent walks")
    guard()
    button, current = profile()
    require(current == before, "Final connection review changed")
    action = button.get_action_iface()
    require(action is not None and action.get_n_actions() == 1 and action.get_action_name(0) == "click", "One owned connection-review click required")
    guard()
    record.update(button="Move reviewed connections", actionAttempts=1, actionMayHaveRun=True)
    require(action.do_action(0), "Connection review outcome uncertain; never retry")
    record["actionReturned"] = True


def inside(bounds, frame):
    require(type(bounds) in (tuple, list) and type(frame) in (tuple, list) and len(bounds) == len(frame) == 4
            and all(type(v) is int for v in (*bounds, *frame)), "Integer native geometry required")
    x, y, w, h = bounds
    fx, fy, fw, fh = frame
    require(w > 0 and h > 0 and fw > 0 and fh > 0 and x >= fx and y >= fy and x + w <= fx + fw and y + h <= fy + fh,
            "Control escaped independently owned native frame")


def authentication_details_labels(rows):
    details = [row for row in rows if row["role"] == 62 and row["name"] == "Details"]
    if not details:
        return frozenset()
    require(len(details) == 1 and rows[0]["role"] == 16 and rows[0]["name"] == "Authenticate"
            and details[0]["ready"] is True, "One ready authentication Details expander required")
    by_reference = {tuple(row["reference"]): row for row in rows}
    container = by_reference[tuple(details[0]["parent"])]
    require(container["role"] == 20 and container["name"] == ""
            and container["parent"] == rows[0]["reference"], "Authentication Details container changed")
    # Pinned polkit-gnome 0.105 plus the exact 016 policy, replayed from run 39466691322.
    # Only these informational labels may be hidden; no prompt or action is exempt.
    expected = ((62, "Details", None), (20, "", 0), (39, "", 1), (39, "", 2),
                (29, "Creator Works", 3), (88, "", 4), (29, "Vendor:", 3),
                (29, "com.creatorworks.hub.deb-retirement", 3), (88, "", 7), (29, "Action:", 3))
    children = {}
    for row in rows[1:]:
        children.setdefault(tuple(row["parent"]), []).append(row)
    pending, branch, seen = [details[0]], [], set()
    while pending:
        row = pending.pop(); reference = tuple(row["reference"])
        require(reference not in seen and len(branch) < len(expected), "Unexpected authentication Details descendant")
        seen.add(reference); branch.append(row)
        pending.extend(reversed(children.get(reference, [])))
    require(len(branch) == len(expected), "Incomplete authentication Details subtree")
    for row, (role, name, parent) in zip(branch, expected):
        require(row["role"] == role and row["name"] == name
                and (parent is None or row["parent"] == branch[parent]["reference"]),
                "Authentication Details role/text/parent changed")
    return frozenset(tuple(row["reference"]) for row in branch if row["role"] == 29)


def graph_contract(rows, *, pid, title, question, password=False, connection_review=False):
    require(not (password and connection_review), "Distinct finite native dialog contracts required")
    require(type(rows) is list and 1 <= len(rows) <= 64 and rows[0]["role"] in (2, 16), "Bounded native alert/dialog required")
    require(rows[0]["name"] == title and all(row["pid"] == pid for row in rows), "Foreign or different native dialog")
    require(len({tuple(row["reference"]) for row in rows}) == len(rows), "Duplicate native AX reference")
    references = {tuple(row["reference"]) for row in rows}
    require(all(tuple(row["parent"]) in references for row in rows[1:]), "Native AX parent escaped dialog")
    labels = [row["name"] for row in rows if row["role"] == 29]
    require(labels.count(question) == 1, "Exact source-bound native question missing/ambiguous")
    buttons = [row["name"] for row in rows if row["role"] == 43]
    expected_buttons = {"Move reviewed connections", "Keep existing"} if connection_review else {"Cancel", "Authenticate"} if password else {"Move to Hub", "Not now"}
    require(len(buttons) == 2 and set(buttons) == expected_buttons, "Unexpected native action set")
    if connection_review:
        require(labels == [CONNECTION_REVIEW_TITLE, question], "Unexpected extra connection-review text")
        primary, secondary = [row for row in rows if row["role"] == 29]
        parent = next(row for row in rows if tuple(row["reference"]) == tuple(primary["parent"]))
        require(tuple(primary["parent"]) == tuple(secondary["parent"]) and parent["role"] == 20,
                "Connection-review heading and question must share their native container")
    protected = [row for row in rows if row["role"] == 40]
    require(len(protected) == (1 if password else 0) and all(row["name"] is None for row in protected), "Password must never be read")
    informational = authentication_details_labels(rows) if password else frozenset()
    require(all(row["ready"] for row in rows if row["role"] in (2, 16, 29, 40, 43)
                and tuple(row["reference"]) not in informational), "Native controls are not ready")


def connection_review_graph_diagnostic(rows, *, pid, question):
    # Synthetic CI graph only. No new AX calls, raw question/configuration, or unknown label bodies.
    require(type(rows) is list and 1 <= len(rows) <= 64 and type(pid) is int and 1 < pid < 2**31
            and type(question) is str and len(question) <= 4096, "Diagnostic graph exceeds bound")
    references = []
    for row in rows:
        keys(row, ("reference", "parent", "pid", "role", "name", "ready"))
        require(row["pid"] == pid and type(row["role"]) is int and 0 <= row["role"] < 65536
                and type(row["ready"]) is bool, "Diagnostic graph owner/metadata differs")
        for field in ("reference", "parent"):
            value = row[field]
            require(type(value) is list and len(value) == 2 and all(type(v) is str and len(v) <= 256 for v in value),
                    "Diagnostic graph reference exceeds bound")
        references.append(tuple(row["reference"]))
    require(len(set(references)) == len(rows), "Diagnostic graph reference duplicated")
    indexes = {reference: i for i, reference in enumerate(references)}
    known = ("", "Warning", CONNECTION_REVIEW_TITLE, "Move reviewed connections", "Keep existing")
    nodes, questions, extras, text_bytes = [], [], [], 0
    for index, row in enumerate(rows):
        parent = indexes.get(tuple(row["parent"]))
        require(index == 0 or parent is not None, "Diagnostic graph parent escaped")
        name = row["name"]
        if name is None:
            summary = {"kind": "unread"}
        else:
            require(type(name) is str and len(name) <= 4096, "Diagnostic name exceeds bound")
            raw = name.encode("utf-8"); text_bytes += len(raw)
            require(text_bytes <= 65536, "Diagnostic text budget exceeded")
            summary = ({"kind": "known", "text": name} if name in known else
                       {"kind": "expected-question" if name == question else "redacted",
                        "chars": len(name), "utf8Bytes": len(raw), "sha256": digest(raw)})
        if row["role"] == 29:
            (questions if name == question else extras).append(index)
        nodes.append({"index": index, "parentIndex": parent, "role": row["role"], "ready": row["ready"], "name": summary})
    value = {"schemaVersion": 1, "scope": "synthetic-connection-review-016", "diagnosticOnly": True,
        "inputPermitted": False, "authorityGranted": False, "releaseReady": False, "rootPid": pid,
        "nodeCount": len(nodes), "questionIndexes": questions, "extraLabelIndexes": extras, "nodes": nodes}
    require(len(json.dumps(value, allow_nan=False).encode()) <= 32768, "Diagnostic output budget exceeded")
    return value


def connection_review_graph_contract(rows, *, pid, question, record):
    try:
        graph_contract(rows, pid=pid, title="Warning", question=question, connection_review=True)
    except RuntimeError as error:
        if type(error) is RuntimeError and str(error) == "Unexpected extra connection-review text" and type(record) is dict:
            try:
                if "refusedGraph" not in record:
                    record["refusedGraph"] = connection_review_graph_diagnostic(rows, pid=pid, question=question)
            except Exception as capture_error:
                record["graphCaptureUnavailable"] = {"type": type(capture_error).__name__[:100]}
        raise


def authentication_readiness_diagnostic(rows, observations, *, pid, question):
    require(type(rows) is list and 1 <= len(rows) <= 64 and type(observations) is list
            and len(observations) == len(rows) and type(pid) is int and 1 < pid < 2**31
            and type(question) is str and len(question) <= 4096, "Readiness diagnostic exceeds bound")
    references = []
    for row in rows:
        keys(row, ("reference", "parent", "pid", "role", "name", "ready"))
        require(row["pid"] == pid and type(row["role"]) is int and 0 <= row["role"] < 65536
                and type(row["ready"]) is bool, "Readiness diagnostic owner/metadata differs")
        for field in ("reference", "parent"):
            require(type(row[field]) is list and len(row[field]) == 2
                    and all(type(v) is str and len(v) <= 256 for v in row[field]), "Readiness reference exceeds bound")
        references.append(tuple(row["reference"]))
    require(len(set(references)) == len(rows), "Readiness reference duplicated")
    indexes = {reference: i for i, reference in enumerate(references)}
    nodes, failed, text_bytes = [], [], 0
    for index, (row, observed) in enumerate(zip(rows, observations)):
        keys(observed, ("reference", "states"))
        require(observed["reference"] == row["reference"], "Readiness observation reference differs")
        keys(observed["states"], ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY"))
        require(all(v is None or type(v) is bool for v in observed["states"].values()), "Invalid same-read state observation")
        parent = indexes.get(tuple(row["parent"]))
        require(index == 0 or parent is not None, "Readiness parent escaped")
        name = row["name"]
        require(name is None if row["role"] == 40 else type(name) is str and len(name) <= 4096,
                "Readiness text exceeds bound or password was read")
        summary = {"kind": "unread"}
        if name is not None:
            raw = name.encode("utf-8"); text_bytes += len(raw)
            require(text_bytes <= 65536, "Readiness text budget exceeded")
            summary = ({"kind": "known", "text": name} if name in ("", "Authenticate", "Cancel", "Password:", "Details", "Action:", "Vendor:") else
                       {"kind": "expected-question" if name == question else "redacted",
                        "chars": len(name), "utf8Bytes": len(raw), "sha256": digest(raw)})
        nodes.append({"index": index, "reference": list(row["reference"]), "parentIndex": parent, "role": row["role"],
                      "name": summary, "ready": row["ready"], "states": dict(observed["states"])})
        if row["role"] in (2, 16, 29, 40, 43) and not row["ready"]:
            failed.append(index)
    value = {"schemaVersion": 1, "scope": "synthetic-authorization-readiness-016", "diagnosticOnly": True,
             "inputPermitted": False, "authorityGranted": False, "releaseReady": False,
             "agentPid": pid, "failedIndexes": failed, "nodes": nodes}
    require(len(json.dumps(value, allow_nan=False).encode()) <= 32768, "Readiness output budget exceeded")
    return value


def authentication_graph_contract(rows, *, pid, question, observations, record):
    try:
        graph_contract(rows, pid=pid, title="Authenticate", question=question, password=True)
    except RuntimeError as error:
        if type(error) is RuntimeError and str(error) == "Native controls are not ready" and type(record) is dict:
            try:
                if "readinessRefusal" not in record:
                    record["readinessRefusal"] = authentication_readiness_diagnostic(rows, observations, pid=pid, question=question)
            except Exception as capture_error:
                record.setdefault("readinessCaptureUnavailable", {"type": type(capture_error).__name__[:100]})
        raise


def ax_graph(atspi, helper, native, refs, owner, frame, *, protected=None, observations=None):
    apps = [node for node in helper.fresh_close_children(atspi.get_desktop(0), 64) if node.get_process_id() == owner.root["pid"]]
    require(len(apps) == 1, "One attributed AX application required")
    tops = helper.fresh_close_children(apps[0], 8)
    candidates = [node for node in tops if node.get_role() in (atspi.Role.ALERT, atspi.Role.DIALOG)]
    require(len(candidates) == 1, "One native AX dialog required")
    pending, rows, nodes = [(candidates[0], None, 0)], [], []
    parent_ref = tuple(refs.identity(apps[0], owner))
    while pending:
        node, parent, depth = pending.pop()
        require(len(rows) < 64 and depth < 12 and node.get_process_id() == owner.root["pid"], "AX graph escaped native owner/bounds")
        node.clear_cache()
        reference = tuple(refs.identity(node, owner))
        if hasattr(owner, "node"):
            owner.node(node)
        actual = node.get_parent()
        require(actual is not None and tuple(refs.identity(actual, owner)) == (parent_ref if parent is None else parent), "Native reverse parent changed")
        role, states = int(node.get_role()), node.get_state_set()
        require(depth == 0 or role not in {int(getattr(atspi.Role, name)) for name in ("ALERT", "DIALOG", "FRAME", "WINDOW", "APPLICATION")}, "Nested native window refused")
        is_password = role == int(atspi.Role.PASSWORD_TEXT)
        if protected is not None:
            require(protected.get("reference") != reference or is_password, "Previously protected node changed role; no name read")
            if is_password:
                require(protected.get("reference", reference) == reference, "Password reference changed")
                protected["reference"] = reference
        require(is_password or not states.contains(atspi.StateType.EDITABLE), "Unexpected editable native node")
        name = None if is_password else node.get_name()
        require(name is None if is_password else type(name) is str and len(name) <= 4096, "Native text exceeds bound")
        def contains(value):
            result = states.contains(getattr(atspi.StateType, value))
            if observations is not None:
                evaluated[value] = result
            return result
        evaluated = dict.fromkeys(("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY"))
        ready = all(contains(value) for value in ("SHOWING", "ENABLED", "SENSITIVE"))
        ready = ready and not any(contains(value) for value in ("DEFUNCT", "BUSY"))
        rows.append({"reference": list(reference), "parent": list(parent_ref if parent is None else parent),
                     "pid": owner.root["pid"], "role": role, "name": name, "ready": ready})
        if observations is not None:
            # Preserve short-circuit evaluation: None means not queried, never a guessed state.
            observations.append({"reference": list(reference), "states": evaluated})
        nodes.append(node)
        if len(rows) == 1 or role in (40, 43):
            rect = node.get_component_iface().get_extents(atspi.CoordType.SCREEN)
            bounds = (rect.x, rect.y, rect.width, rect.height)
            if len(rows) == 1:
                require(bounds == frame, "Native AX/XRes frame mismatch")
            else:
                inside(bounds, frame)
        pending.extend((child, reference, depth + 1) for child in reversed(helper.fresh_close_children(node, min(16, 64 - len(rows) - len(pending)))))
    return rows, nodes


class Session:
    PROGRESS_BOUNDARIES = ("startup", "tooling", "driver-spawn", "listeners-ready", "status-ready",
        "session-create", "session-created", "root-bound", "window-wait", "window-bound", "startup-ready",
        "reopen-terms", "finish-ui", "projects-wait", "home-observed", "close", "closed")

    def __init__(self, root, binding, *, reopened=False, inventory=None):
        self.root, self.binding = root, binding
        self.inventory = inventory
        self.dialogs = set()
        self.logs = None
        self.evidence = {"normalCloseObserved": False, "reopened": reopened}
        self._progress_lock, self._progress_started = threading.RLock(), time.monotonic()
        self._receipt_raw, self._receipt_inode, self._progress_blocked = None, None, False
        self.checkpoint("startup")
        try:
            self.start()
        except Exception as error:
            self.evidence["startupRefused"] = {"type": type(error).__name__, "message": str(error)[:1000]}
            self.retain_failure(error)
            if self.logs is not None:
                try:
                    self.logs.pump()
                    self.evidence["logs"] = self.logs.metadata()
                except Exception:
                    self.evidence["captureRefused"] = True
                finally:
                    try:
                        self.logs.close()
                    except Exception:
                        self.evidence["captureRefused"] = True
            self.checkpoint()
            raise

    def persist_evidence(self):
        file = self.root / "session.json"
        raw = json.dumps(self.evidence, ensure_ascii=False, allow_nan=False).encode()
        require(len(raw) <= 1048576, "Session receipt bound exceeded")
        previous = getattr(self, "_receipt_raw", None)
        if previous is None:
            P.write(file, raw, 0o600)
        else:
            info = file.lstat()
            require((info.st_dev, info.st_ino) == self._receipt_inode
                    and read_file(file, 1048576, uid=os.getuid() if os.name == "posix" else None,
                                  mode=0o600 if os.name == "posix" else None) == previous,
                    "Session diagnostic receipt changed")
            temporary = file.with_name("session.json.progress-new")
            P.write(temporary, raw, 0o600)
            os.replace(temporary, file)
        info = file.lstat()
        self._receipt_raw, self._receipt_inode = raw, (info.st_dev, info.st_ino)

    def checkpoint(self, boundary=None, *, guard=None, request=None):
        # One replaceable diagnostic snapshot in the already-exported receipt; never an input authority.
        if not hasattr(self, "_progress_lock"):
            return
        with self._progress_lock:
            if self._progress_blocked:
                return
            try:
                progress = self.evidence.setdefault("progress", {"schemaVersion": 1, "diagnosticOnly": True,
                    "authorityGranted": False, "releaseReady": False, "sequence": 0, "guards": {}})
                elapsed = int((time.monotonic() - self._progress_started) * 1000)
                require(0 <= elapsed <= 86400000 and progress["sequence"] < 65536, "Session progress budget exceeded")
                progress.update(sequence=progress["sequence"] + 1, elapsedMs=elapsed)
                if boundary is not None:
                    require(boundary in self.PROGRESS_BOUNDARIES, "Unknown diagnostic session boundary")
                    progress["boundary"] = boundary
                if guard is not None:
                    name, phase = guard
                    require(name in ("bootstrap", "driver", "root", "window") and phase in ("entered", "completed"),
                            "Unknown diagnostic guard boundary")
                    progress["guards"][name] = {"phase": phase, "elapsedMs": elapsed}
                current = request if request is not None else getattr(getattr(self, "d", None), "last_request", None)
                if current is not None:
                    require(type(current) is dict and set(current) == {"method", "route", "phase"}
                            and current["method"] in ("GET", "POST", "DELETE") and type(current["route"]) is str
                            and len(current["route"]) <= 512 and re.fullmatch(r"/[A-Za-z0-9_./-]+", current["route"])
                            and ".." not in current["route"]
                            and current["phase"] in ("entered", "before-guard", "http", "after-guard", "returned"),
                            "Invalid diagnostic request metadata")
                    progress["activeRequest"] = dict(current)
                require(len(json.dumps(progress).encode()) <= 4096, "Session progress snapshot exceeds bound")
                self.persist_evidence()
            except Exception:
                self.evidence["progressCaptureUnavailable"] = True
                self._progress_blocked = True

    def retain_failure(self, error):
        self.evidence.setdefault("firstFailure", {"type": type(error).__name__[:100], "message": str(error)[:1000]})
        self.checkpoint()

    def observe_request(self, request):
        def observed(method, route, *args, **kwargs):
            self.checkpoint(request={"method": method, "route": route, "phase": "entered"})
            try:
                value = request(method, route, *args, **kwargs)
            except Exception as error:
                self.retain_failure(error)
                raise
            self.checkpoint()
            return value
        return observed

    def start(self):
        root, binding = self.root, self.binding
        self.checkpoint("tooling")
        self.pages, self.helper, self.native, self.polkit = neutral()
        self.d, self.x11 = self.pages.Driver(), self.helper.X11()
        self.d.request = self.observe_request(self.d.request)
        self.native_driver = self.pages.record("/usr/bin/WebKitWebDriver")
        require(self.native_driver["uid"] == self.native_driver["gid"] == 0 and self.native_driver["mode"] == 0o755, "Protected WebKit driver required")
        driver = BASE / "bin/tauri-driver"
        pin = P.parse(read_file(BASE / "driver.json", uid=0, mode=0o644))
        self.pages.pinned(driver, pin, 0, 0o755)
        self.checkpoint("driver-spawn")
        self.child = subprocess.Popen([str(driver), "--native-driver", "/usr/bin/WebKitWebDriver"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.logs = self.native.Capture(self.child, root, "driver")
        self.driver_identity = self.native.native_process(self.child.pid, self.helper)
        require(self.driver_identity["kernelImageSha256"] == pin["sha256"], "Running test driver differs")
        self.evidence["driver"] = self.driver_identity
        def bootstrap_guard():
            self.checkpoint(guard=("bootstrap", "entered"))
            self.logs.pump()
            require(self.child.poll() is None and self.native.native_process(self.child.pid, self.helper) == self.driver_identity, "Driver changed/exited")
            require(not any(row["truncated"] for row in self.logs.metadata().values()), "Bounded driver log overflow")
            self.checkpoint(guard=("bootstrap", "completed"))
        self.d.guard = bootstrap_guard
        backend = None
        def sockets_ready():
            nonlocal backend
            bootstrap_guard()
            peers = self.pages.subtree(self.child.pid, self.helper, self.native)
            backends = [item for item in peers.values() if item["executable"] == "/usr/bin/WebKitWebDriver" and item["parentPid"] == self.child.pid]
            require(len(backends) <= 1 and (backend is None or len(backends) == 1), "Owned native driver disappeared or duplicated")
            if not backends:
                return False
            current = self.native.native_process(backends[0]["pid"], self.helper)
            require(current["parentPid"] == self.child.pid and current["uids"] == [UID] * 4
                    and current["kernelImageSha256"] == self.native_driver["sha256"], "Native driver image/parent/UID differs")
            require(backend is None or current == backend, "Native driver identity changed during startup")
            backend = current
            ready = self.pages.listener(self.child.pid, 4444) and self.pages.listener(backend["pid"], 4445)
            bootstrap_guard()
            return ready
        # The intermediary forwards /status before WebKit has necessarily bound.
        self.pages.wait(sockets_ready)
        self.backend = backend
        self.evidence["backend"] = self.backend
        self.checkpoint("listeners-ready")
        def bound_driver_guard():
            self.checkpoint(guard=("driver", "entered"))
            bootstrap_guard()
            self.backend_guard()
            require(self.pages.listener(self.child.pid, 4444), "Owned driver socket changed")
            self.checkpoint(guard=("driver", "completed"))
        self.d.guard = bound_driver_guard
        self.pages.wait(lambda: self.d.request("GET", "/status")["ready"] is True)
        self.checkpoint("status-ready")
        self.checkpoint("session-create")
        response = self.d.request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": HUB, "args": []}}}})
        self.d.session = response["sessionId"]
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.d.session), "Invalid native driver session")
        self.checkpoint("session-created")
        roots = [item for item in self.pages.subtree(self.child.pid, self.helper, self.native).values() if item["executable"] == HUB]
        require(len(roots) == 1, "One driver-owned 016 Root required")
        self.owned = self.native.native_process(roots[0]["pid"], self.helper)
        require(self.owned["kernelImageSha256"] == binding["profile"]["pins"]["hub"]["sha256"]
                and self.owned["parentPid"] == self.backend["pid"], "Actual 016 kernel image/parent differs")
        self.evidence["root"] = self.owned
        self.checkpoint("root-bound")
        self.pidfd = os.pidfd_open(self.owned["pid"])
        def mapped():
            self.process_guard()
            value = self.x11.property(self.x11.x.XDefaultRootWindow(self.x11.display), "_NET_CLIENT_LIST_STACKING")
            return bool(startup_inventory(value))
        self.checkpoint("window-wait")
        self.pages.wait(mapped)
        self.window = self.native.client_ids(self.x11)[0]
        self.request = self.helper.Request("snapshot", self.owned["pid"], self.owned["startTime"], HUB,
                                           self.owned["kernelImageSha256"], self.window, TITLE, "FRAME")
        self.xres = self.helper.bound_window(self.request, self.x11)
        self.checkpoint("window-bound")
        self.gtk_file = Path("/usr/lib/x86_64-linux-gnu/libgtk-3.so.0").resolve(strict=True)
        self.gtk = self.pages.record(self.gtk_file)
        require(self.gtk["uid"] == self.gtk["gid"] == 0 and not self.gtk["mode"] & 0o022, "Protected GTK required")
        require(not tool(["/usr/bin/dpkg", "--verify", "libgtk-3-0"]), "GTK package changed")
        require(re.fullmatch(rb"3\.24\.33-[^\t\n]+\tamd64\tinstalled", tool(["/usr/bin/dpkg-query", "-W", "-f=${Version}\t${Architecture}\t${db:Status-Status}", "libgtk-3-0"])), "Unreviewed GTK native geometry")
        self.d.guard = self.guard
        self.guard()
        self.evidence.update(root=self.owned, xres=self.xres)
        self.checkpoint("startup-ready")

    def backend_guard(self):
        require(self.native.native_process(self.backend["pid"], self.helper) == self.backend and self.pages.listener(self.backend["pid"], 4445), "Native driver changed")

    def process_guard(self):
        self.checkpoint(guard=("root", "entered"))
        self.logs.pump()
        require(not any(row["truncated"] for row in self.logs.metadata().values()), "Driver logs exceeded capture bound")
        require(self.child.poll() is None and self.native.native_process(self.child.pid, self.helper) == self.driver_identity
                and self.native.native_process(self.owned["pid"], self.helper) == self.owned and self.pages.listener(self.child.pid, 4444), "Owned process/socket changed")
        self.backend_guard()
        self.evidence["processSamples"] = self.evidence.get("processSamples", 0) + 1
        try:
            require(self.inventory is not None, "Fresh root inventory channel required")
            answer = self.inventory.sample(self.pages.wait)
            self.logs.pump()
            require(not any(row["truncated"] for row in self.logs.metadata().values()), "Driver logs exceeded capture bound")
            require(self.child.poll() is None and self.native.native_process(self.child.pid, self.helper) == self.driver_identity
                    and self.native.native_process(self.owned["pid"], self.helper) == self.owned and self.pages.listener(self.child.pid, 4444), "Owned process/socket changed")
            self.backend_guard()
            self.evidence["lastNativeProcesses"] = answer["processes"]
            self.evidence["lastTerminalProcesses"] = answer["terminalProcesses"]
            self.evidence["lastInventoryRequest"] = answer["request"]
        except PermissionError as error:
            try:
                self.evidence["processInventoryRefusal"] = inventory_permission_capture(error, self.helper)
            except Exception as capture_error:
                self.evidence["processInventoryRefusal"] = {"errno": error.errno, "readOnly": True, "stable": False, "unavailable": type(capture_error).__name__}
            raise
        self.checkpoint(guard=("root", "completed"))

    def guard(self):
        self.checkpoint(guard=("window", "entered"))
        self.process_guard()
        require(self.helper.bound_window(self.request, self.x11) == self.xres, "Owned Root window changed")
        windows = self.native.client_ids(self.x11)
        require(self.window in windows and len(windows) <= 1 + len(self.dialogs), "Unexpected native window")
        for window in windows:
            if window != self.window:
                observed = self.x11.inspect(window)
                require((observed["pid"], observed["title"]) in self.dialogs and observed["mapped"], "Foreign native dialog")
        self.checkpoint(guard=("window", "completed"))

    def consent(self, approve):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(1500, 1500)
        self.pages.wait(lambda: any(self.x11.inspect(w)["title"] == "Move to Hub" for w in self.native.client_ids(self.x11) if w != self.window))
        self.guard()
        extra = [w for w in self.native.client_ids(self.x11) if w != self.window]
        require(len(extra) == 1, "One native guide consent required")
        window = extra[0]
        frame = self.x11.frame_rectangle(window)
        require(type(frame) is tuple and len(frame) == 4 and all(type(v) is int for v in frame), "Native consent geometry missing")
        request = self.helper.Request("snapshot", self.owned["pid"], self.owned["startTime"], HUB, self.owned["kernelImageSha256"], window, "Move to Hub", "ALERT")
        xres = self.helper.bound_window(request, self.x11)
        refs, bus = self.native.native_ax_references()
        try:
            owner = self.native.RootOwnership(request, self.helper, self.x11, self.owned, xres, self.gtk,
                                               references=refs, system_check=lambda: self.pages.record(self.gtk_file))
            def capture():
                self.guard()
                owner.recheck(full=True)
                graph, nodes = ax_graph(Atspi, self.helper, self.native, refs, owner, frame)
                graph_contract(graph, pid=request.pid, title="Information", question=GUIDE + GUIDE_SUMMARY + GUIDE_END)
                return graph, nodes
            first, _ = capture()
            second, nodes = capture()
            require(first == second and self.x11.frame_rectangle(window) == frame, "Native consent changed between independent walks")
            name = "Move to Hub" if approve else "Not now"
            targets = [node for node, row in zip(nodes, second) if row["role"] == 43 and row["name"] == name]
            require(len(targets) == 1, "Ambiguous native consent action")
            action = targets[0].get_action_iface()
            require(action is not None and action.get_n_actions() == 1 and action.get_action_name(0) == "click", "One native action required")
            owner.recheck(full=True)
            self.evidence["guide"] = {"graph": first, "xres": xres, "frame": frame, "button": name, "actionAttempts": 1}
            require(action.do_action(0), "Consent outcome uncertain; never retry")
            self.pages.wait(lambda: window not in self.native.client_ids(self.x11))
        finally:
            bus.close_sync(None)

    def review_connections(self, home, before, binding):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(1500, 1500)
        require("connectionReview" not in self.evidence, "Connection review must not be repeated")
        self.dialogs = {(self.owned["pid"], CONNECTION_REVIEW_TITLE)}
        self.pages.wait(lambda: any(self.x11.inspect(w)["title"] == CONNECTION_REVIEW_TITLE for w in self.native.client_ids(self.x11) if w != self.window))
        self.guard()
        extra = [w for w in self.native.client_ids(self.x11) if w != self.window]
        require(len(extra) == 1, "One exact unverified-connection review required")
        window = extra[0]
        frame = self.x11.frame_rectangle(window)
        request = self.helper.Request("snapshot", self.owned["pid"], self.owned["startTime"], HUB,
                                      self.owned["kernelImageSha256"], window, CONNECTION_REVIEW_TITLE, "ALERT")
        xres = self.helper.bound_window(request, self.x11)
        expected = connection_review(home, before, binding)
        refs, bus = self.native.native_ax_references()
        record = self.evidence["connectionReview"] = {}
        try:
            owner = self.native.RootOwnership(request, self.helper, self.x11, self.owned, xres, self.gtk,
                                               references=refs, system_check=lambda: self.pages.record(self.gtk_file))
            def guard():
                self.guard()
                owner.recheck(full=True)
                require(connection_review(home, before, binding) == expected, "Reviewed before-images or verified router changed")
            def profile():
                guard()
                graph, nodes = ax_graph(Atspi, self.helper, self.native, refs, owner, frame)
                connection_review_graph_contract(graph, pid=request.pid, question=expected["question"], record=record)
                require(self.x11.frame_rectangle(window) == frame, "Connection-review native frame changed")
                button = next(node for node, row in zip(nodes, graph) if row["role"] == 43 and row["name"] == "Move reviewed connections")
                return button, {"graph": graph, "xres": xres, "frame": frame, **expected}
            approve_connection_review(profile, guard, record)
            dismissal = record["nativeDismissal"] = {}
            try:
                self.pages.wait(lambda: self.native_target_absent(window, dismissal))
            except Exception as error:
                self.retain_dismissal_refusal(error, record, window, xres, frame)
                raise
        finally:
            bus.close_sync(None)
        self.dialogs.clear()

    def native_target_absent(self, target, observation):
        self.process_guard()
        require(self.helper.bound_window(self.request, self.x11) == self.xres, "Owned Root window changed")
        result = self.polkit.native_window_absence(self.x11, self.helper, target, observation)
        self.process_guard()
        require(self.helper.bound_window(self.request, self.x11) == self.xres, "Owned Root window changed")
        return result["absent"]

    def retain_dismissal_refusal(self, error, record, target, xres, frame):
        self.retain_failure(error)
        flags = {"diagnosticOnly": True, "inputPermitted": False, "authorityGranted": False, "releaseReady": False}
        try:
            # Cached bindings and the existing error latch only: never query, clear, or retry X11.
            value = {**flags, "scope": "connection-review-dismissal", "cachedBindingsOnly": True,
                "serialSource": "XErrorEvent.serial; compare independently sampled nativeDismissal.requestSerial when present",
                "root": {key: self.owned[key] for key in
                         ("pid", "parentPid", "startTime", "uids", "executable", "kernelImageSha256")},
                "mainWindow": {"xid": self.window, "xres": self.xres},
                "dialog": {"xid": target, "xres": xres, "frame": list(frame)}}
            try:
                latched = self.x11.error_diagnostic()
                require(len(json.dumps(latched, allow_nan=False).encode()) <= 4096, "Latched X error capture exceeds bound")
                value["xError"] = latched
            except Exception as capture_error:
                value["xError"] = {"captureUnavailable": True, "type": type(capture_error).__name__[:100]}
            raw = json.dumps(value, allow_nan=False)
            require(len(raw.encode()) <= 8192, "Dismissal diagnostic exceeds bound")
            record["nativeDismissalFailure"] = json.loads(raw)
        except Exception as capture_error:
            record["nativeDismissalFailure"] = {**flags, "captureUnavailable": True, "type": type(capture_error).__name__[:100]}
        self.checkpoint()

    def close(self):
        self.checkpoint("close")
        self.guard()
        backend_fd = os.pidfd_open(self.backend["pid"])
        try:
            self.backend_guard()
            self.x11.close_window(self.window, self.helper.bound_window(self.request, self.x11))
            self.pages.wait(lambda: bool(select.select([self.pidfd], [], [], 0)[0]) and not Path(f"/proc/{self.owned['pid']}").exists(), 15)
            self.evidence["normalCloseObserved"] = True
            self.dispose_tools(backend_fd)
        finally:
            os.close(backend_fd)
        self.logs.pump()
        self.evidence["logs"] = self.logs.metadata()
        require(not any(row["truncated"] for row in self.logs.metadata().values()), "Driver log overflow")
        self.checkpoint("closed")
        self.persist_evidence()
        self.logs.close()
        os.close(self.pidfd)
        self.x11.dispose()

    def dispose_tools(self, backend_fd):
        # Root already exited normally; either owned tool may have exited too.
        if self.child.poll() is None:
            require(self.native.native_process(self.child.pid, self.helper) == self.driver_identity, "Driver changed before disposal")
            self.child.terminate()
        self.child.wait(timeout=10)
        if not select.select([backend_fd], [], [], 0)[0]:
            try:
                current = self.native.native_process(self.backend["pid"], self.helper)
            except RuntimeError as error:
                if type(error) is not RuntimeError or str(error) != "Owned process is not live" or self.evidence.get("normalCloseObserved") is not True:
                    raise
                # A terminal stat is not thread-group exit; the bound pidfd must become ready.
            else:
                require(current == self.backend, "Native driver changed before disposal")
                signal.pidfd_send_signal(backend_fd, signal.SIGTERM)
            self.pages.wait(lambda: bool(select.select([backend_fd], [], [], 0)[0]), 10)


def publish(file, value, mode=0o600):
    temporary = file.with_name(file.name + ".new")
    save(temporary, value, mode)
    require(not os.path.lexists(file), "One-shot receipt already exists")
    temporary.rename(file)


def startup_inventory(value):
    if value is None:
        return []
    require(type(value) is tuple and len(value) == 3 and value[:2] == (33, 32) and type(value[2]) is list
            and len(value[2]) <= 1 and all(type(v) is int and 0 < v <= 0xffffffff for v in value[2]), "Unexpected pre-map native window inventory")
    return value[2]


def no_legacy_backend(identity, command):
    require(type(command) is bytes and 0 < len(command) <= 8192 and command.endswith(b"\0"), "Bounded native process arguments required")
    image = Path(identity["executable"].removesuffix(" (deleted)")).name.removeprefix("memfd:")
    require(image not in ("creator-works-mcp", "creator-works-mcp-launcher", "creator-project-setup")
            and b"--creator-hub-host" not in command.split(b"\0"), "A separate MCP/Setup GUI or legacy host backend started")


class InventoryDirectoryRefusal(RuntimeError):
    def __init__(self, message, observation):
        super().__init__(message)
        self.observation = observation


def inventory_directory_guard(pid, path, origin, opened, named, phase):
    require(type(pid) is int and 0 < pid <= 2147483647
            and phase in ("initial", "final"), "Fixed inventory observation scope required")
    if (stat.S_ISDIR(origin.st_mode) and origin.st_uid == UID
            and metadata_stamp(opened) == metadata_stamp(origin) == metadata_stamp(named)):
        return
    message = "Inventory proc directory changed" + (" during observation" if phase == "final" else "")
    # Preserve only the values from the failed comparison, not a fresh retry.
    raise InventoryDirectoryRefusal(message, {
        "scope": "failed-inventory-directory-comparison-only", "pid": pid, "phase": phase,
        "readOnly": True, "validationAuthority": False,
        "origin": metadata_row(path.as_posix(), origin),
        "opened": metadata_row(path.as_posix(), opened), "named": metadata_row(path.as_posix(), named),
    })


def inventory_process_snapshot(directory, path, pid, helper):
    info = os.fstat(directory)
    inventory_directory_guard(pid, path, info, info, path.lstat(), "initial")
    def read(leaf, limit):
        before = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit, "Nonordinary inventory proc metadata")
        with os.fdopen(os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory), "rb") as stream:
            require(metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Inventory proc FD changed")
            raw = stream.read(limit + 1)
            require(len(raw) <= limit and metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Inventory proc metadata changed/oversized")
        require(metadata_stamp(os.stat(leaf, dir_fd=directory, follow_symlinks=False)) == metadata_stamp(before), "Inventory proc pathname changed")
        return raw
    raw = read("stat", 4096).decode("utf-8")
    start = helper.parse_start(raw, pid, require_live=False)
    fields = raw[raw.rfind(")") + 2:].split()
    require(fields[0] in tuple("RSDTtZXKWPI") and fields[1].isdigit() and int(fields[1]) <= 2147483647,
            "Unknown inventory proc state/parent")
    status, ids = read("status", 16384), {}
    for name in ("Uid", "Gid"):
        matches = re.findall(rb"^" + name.encode() + rb":\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.M)
        require(len(matches) == 1, "Inventory credential tuple unavailable")
        ids[name] = [int(value) for value in matches[0]]
    inventory_directory_guard(pid, path, info, os.fstat(directory), path.lstat(), "final")
    return {"pid": pid, "startTime": start, "parentPid": int(fields[1]), "state": fields[0],
            "procDirectory": metadata_row(path.as_posix(), info), **ids}


def inventory_terminal_record(pid, origin, before, after):
    for row in (origin, before, after):
        keys(row, ("pid", "startTime", "parentPid", "state", "procDirectory", "Uid", "Gid"))
        directory = row["procDirectory"]
        keys(directory, ("path", "type", "uid", "gid", "mode", "nlink", "dev", "ino", "size", "mtimeNs", "ctimeNs"))
        require(type(row["pid"]) is int and row["pid"] == pid and type(row["startTime"]) is str
                and re.fullmatch(r"[0-9]{1,20}", row["startTime"]) and type(row["parentPid"]) is int
                and 0 <= row["parentPid"] <= 2147483647 and row["state"] in tuple("RSDTtZXKWPI")
                and row["Uid"] == row["Gid"] == [UID] * 4
                and all(type(value) is int for name in ("Uid", "Gid") for value in row[name])
                and directory["path"] == f"/proc/{pid}" and directory["type"] == "directory"
                and directory["uid"] == directory["gid"] == UID
                and all(type(value) is int for name, value in directory.items() if name not in ("path", "type")), "Invalid terminal identity evidence")
    require(type(pid) is int and 1 <= pid <= 2147483647 and before == after and before["state"] in ("Z", "X")
            and {k: v for k, v in origin.items() if k != "state"} == {k: v for k, v in before.items() if k != "state"},
            "Terminal state/identity was not stable")
    return {"pid": pid, "classification": "terminal", "origin": origin, "before": before, "after": after}


def native_process_inventory(native, helper):
    candidates = [file for file in Path("/proc").iterdir() if file.name.isdecimal()]
    require(len(candidates) <= 8192, "Native PID inventory exceeds bound")
    found, terminal = [], []
    for file in candidates:
        directory = None
        try:
            if file.stat().st_uid != UID:
                continue
            require(re.fullmatch(r"[1-9][0-9]{0,9}", file.name) and int(file.name) <= 2147483647, "Invalid inventory PID")
            pid = int(file.name)
            directory = os.open(file, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            origin = inventory_process_snapshot(directory, file, pid, helper)
            def classify(first):
                last = inventory_process_snapshot(directory, file, pid, helper)
                proof = inventory_terminal_record(pid, origin, first, last)
                require(len(found) + len(terminal) < 64, "Synthetic native process inventory exceeds bound")
                terminal.append(proof)
            if origin["state"] in ("Z", "X"):
                classify(origin)
                continue
            try:
                identity = native.native_process(pid, helper, False)
                require(identity["pid"] == pid and identity["startTime"] == origin["startTime"]
                        and identity["parentPid"] == origin["parentPid"] and identity["uids"] == origin["Uid"], "Native process differs from bound inventory origin")
                if identity["uids"] != [UID] * 4:
                    after = inventory_process_snapshot(directory, file, pid, helper)
                    require(after["state"] not in ("Z", "X")
                            and {k: v for k, v in origin.items() if k != "state"} == {k: v for k, v in after.items() if k != "state"}
                            and native.native_process(pid, helper, False) == identity, "Mixed-UID inventory process changed")
                    continue  # Setuid authorization stays separately bound; this is not a terminal/legacy-free claim.
                command = proc_bytes(file / "cmdline", 8192)
                no_legacy_backend(identity, command)
                require(native.native_process(pid, helper, False) == identity, "Native process changed during inventory")
            except RuntimeError as error:
                # Only this liveness refusal permits fresh terminal proof against the held origin.
                if type(error) is not RuntimeError or str(error) != "Owned process is not live":
                    raise
                classify(inventory_process_snapshot(directory, file, pid, helper))
                continue
            after = inventory_process_snapshot(directory, file, pid, helper)
            if after["state"] in ("Z", "X"):
                classify(after)
                continue
            require({k: v for k, v in origin.items() if k != "state"} == {k: v for k, v in after.items() if k != "state"},
                    "Live inventory origin changed")
        except (FileNotFoundError, ProcessLookupError):
            continue
        finally:
            if directory is not None:
                os.close(directory)
        require(len(found) + len(terminal) < 64, "Synthetic native process inventory exceeds bound")
        found.append({"pid": identity["pid"], "startTime": identity["startTime"], "executable": identity["executable"],
                      "argvSha256": digest(command), "legacyBackend": False})
    return {"processes": sorted(found, key=lambda row: row["pid"]), "terminalProcesses": sorted(terminal, key=lambda row: row["pid"])}


INVENTORY_MAX_SAMPLES = 2048
INVENTORY_COHORTS = {
    "migration": SCENARIOS,
    "update": ("deb-native-cancel", "deb-auth-cancel", "deb-approve", "portable-native-cancel", "portable-approve"),
}


def inventory_channel():
    for path in (BASE, *BASE.parents):
        info = path.lstat()
        require(path.resolve() == path and stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
                and not info.st_mode & 0o7022, "Inventory response ancestor is not root-protected")
    path = BASE / "result"
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == UID
            and stat.S_IMODE(info.st_mode) == 0o700, "Inventory request directory is not the private fixture directory")


def inventory_request(value, harness, scenario, sequence, *, cohort="migration"):
    keys(value, ("schemaVersion", "operation", "harnessSource", "scenario", "sequence", "nonce"))
    require(type(harness) is str and re.fullmatch(r"[a-f0-9]{40}", harness)
            and type(cohort) is str and cohort in INVENTORY_COHORTS and scenario in INVENTORY_COHORTS[cohort]
            and type(sequence) is int and 1 <= sequence <= INVENTORY_MAX_SAMPLES
            and type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
            and value["operation"] == "global-uid-inventory" and value["harnessSource"] == harness
            and value["scenario"] == scenario and type(value["sequence"]) is int and value["sequence"] == sequence
            and type(value["nonce"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["nonce"]), "Fresh finite inventory request differs")


def inventory_answer(value, request, *, cohort="migration"):
    keys(value, ("request", "ok", "processes", "terminalProcesses"))
    inventory_request(value["request"], request["harnessSource"], request["scenario"], request["sequence"], cohort=cohort)
    require(value["request"] == request and value["ok"] is True and type(value["processes"]) is list
            and type(value["terminalProcesses"]) is list and len(value["processes"]) + len(value["terminalProcesses"]) <= 64,
            "Fresh root inventory answer refused")
    previous = 0
    for row in value["processes"]:
        keys(row, ("pid", "startTime", "executable", "argvSha256", "legacyBackend"))
        require(type(row["pid"]) is int and previous < row["pid"] <= 2147483647
                and type(row["startTime"]) is str and re.fullmatch(r"[0-9]{1,20}", row["startTime"])
                and type(row["executable"]) is str and row["executable"].startswith("/")
                and len(row["executable"].encode("utf-8")) <= 4096 and not re.search(r"[\x00-\x1f\x7f]", row["executable"])
                and type(row["argvSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", row["argvSha256"])
                and row["legacyBackend"] is False, "Invalid root inventory record")
        previous = row["pid"]
    active, previous = {row["pid"] for row in value["processes"]}, 0
    for row in value["terminalProcesses"]:
        keys(row, ("pid", "classification", "origin", "before", "after"))
        require(type(row["pid"]) is int and previous < row["pid"] <= 2147483647 and row["pid"] not in active
                and row == inventory_terminal_record(row["pid"], row["origin"], row["before"], row["after"]), "Invalid terminal inventory record")
        previous = row["pid"]


class InventoryClient:
    def __init__(self, harness, scenario, *, cohort="migration"):
        self.harness, self.scenario, self.sequence = harness, scenario, 1
        self.cohort = cohort
        self.nonces, self.blocked, self.lock = set(), False, threading.Lock()

    def sample(self, wait):
        # Native consent and its initiating WebDriver call can guard concurrently.
        with self.lock:
            require(not self.blocked, "Unresolved inventory request cannot be retried")
            self.blocked = True
            require(os.getuid() == os.geteuid() == UID, "Only the fixture may request an inventory")
            inventory_channel()
            value = {"schemaVersion": 1, "operation": "global-uid-inventory", "harnessSource": self.harness,
                     "scenario": self.scenario, "sequence": self.sequence, "nonce": secrets.token_hex(32)}
            inventory_request(value, self.harness, self.scenario, self.sequence, cohort=self.cohort)
            require(value["nonce"] not in self.nonces, "Inventory nonce reused")
            self.nonces.add(value["nonce"])
            request = BASE / f"result/inventory-request-{self.sequence}.json"
            response = BASE / f"inventory-response-{self.sequence}.json"
            require(not any(os.path.lexists(path) for file in (request, response) for path in (file, file.with_name(file.name + ".new"))),
                    "Existing inventory transport cannot be adopted")
            publish(request, value)
            wait(lambda: os.path.lexists(response))
            inventory_channel()
            answer = P.parse(read_file(response, 524288, uid=0, mode=0o644))
            inventory_answer(answer, value, cohort=self.cohort)
            self.sequence += 1
            self.blocked = False
            return answer


def serve_inventory(state, record, harness, scenario, native, helper, *, cohort="migration"):
    require(os.getuid() == os.geteuid() == 0, "Root-only global inventory observer")
    inventory_channel()
    sequence = state["sequence"]
    response = BASE / f"inventory-response-{sequence}.json"
    require(not any(os.path.lexists(path) for path in (response, response.with_name(response.name + ".new"))),
            "Unknown root inventory response exists")
    request = BASE / f"result/inventory-request-{sequence}.json"
    if not os.path.lexists(request):
        return False
    try:
        raw = read_file(request, 512, uid=UID, mode=0o600)
        value = P.parse(raw)
        inventory_request(value, harness, scenario, sequence, cohort=cohort)
        require(value["nonce"] not in state["nonces"], "Inventory nonce replay refused")
        state["nonces"].add(value["nonce"])
        inventory = native_process_inventory(native, helper)
        keys(inventory, ("processes", "terminalProcesses"))
        answer = {"request": value, "ok": True, **inventory}
        inventory_answer(answer, value, cohort=cohort)
        require(len(json.dumps(answer, ensure_ascii=False, allow_nan=False).encode()) <= 524288, "Root inventory response exceeds bound")
        require(read_file(request, 512, uid=UID, mode=0o600) == raw, "Inventory request changed during observation")
        inventory_channel()
        publish(response, answer, mode=0o644)
        state["sequence"] += 1
        record["inventorySamples"] = record.get("inventorySamples", 0) + 1
        record["lastInventory"] = answer
        return True
    except Exception as error:
        record["inventoryRefusal"] = {"sequence": sequence, "type": type(error).__name__, "message": str(error)[:1000]}
        if isinstance(error, PermissionError):
            try:
                record["inventoryRefusal"]["processInventoryRefusal"] = inventory_permission_capture(error, helper)
            except Exception as capture_error:
                record["inventoryRefusal"]["processInventoryRefusal"] = {"stable": False, "unavailable": type(capture_error).__name__}
        raise


def inventory_permission_capture(error, helper):
    result = {"errno": error.errno, "readOnly": True, "stable": False, "before": None, "after": None}
    match = re.fullmatch(r"/proc/([1-9][0-9]{0,9})/exe", str(error.filename))
    if not match:
        return {**result, "unavailable": "Unexpected failed proc path"}
    result["pid"] = pid = int(match[1])
    path, directory = Path(f"/proc/{pid}"), None
    try:
        directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        def read(leaf, limit):
            before = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit, "Nonordinary proc observation")
            with os.fdopen(os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory), "rb") as stream:
                require(metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Proc observation replaced before read")
                raw = stream.read(limit + 1)
                require(len(raw) <= limit and metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Proc observation changed/oversized")
            require(metadata_stamp(os.stat(leaf, dir_fd=directory, follow_symlinks=False)) == metadata_stamp(before), "Proc observation pathname changed")
            return raw
        for phase in ("before", "after"):
            info = os.fstat(directory)
            require(stat.S_ISDIR(info.st_mode) and metadata_stamp(info) == metadata_stamp(path.lstat()), "Proc directory identity changed")
            process = read("stat", 4096).decode("utf-8")
            start = helper.parse_start(process, pid)
            status, ids = read("status", 16384), {}
            for field in ("Uid", "Gid"):
                matches = re.findall(rb"^" + field.encode() + rb":\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.M)
                require(len(matches) == 1, "Exact proc credential tuple unavailable")
                ids[field] = [int(value) for value in matches[0]]
            require(metadata_stamp(os.fstat(directory)) == metadata_stamp(info) == metadata_stamp(path.lstat()), "Proc directory changed during observation")
            result[phase] = {"procDirectory": metadata_row(str(path), info), "startTime": start,
                             "parentPid": int(process[process.rfind(")") + 2:].split()[1]), **ids}
        result["stable"] = result["before"] == result["after"]
    except Exception as capture_error:
        result["unavailable"] = type(capture_error).__name__
    finally:
        if directory is not None:
            os.close(directory)
    return result


def failed_process_attribution(child, helper):
    result = {"scope": "failed-pid-and-immediate-parent-only", "readOnly": True,
              "validationAuthority": False, "stable": False, "status": "unknown"}
    def error_row(error):
        return {"type": type(error).__name__, "errno": error.errno if isinstance(error, OSError) else None}
    def observe(pid, expected=None, *, executable=True):
        row, directory = {"pid": pid, "stable": False, "status": "unknown"}, None
        try:
            path = Path(f"/proc/{pid}")
            directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            def read(leaf, limit):
                before = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
                require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit,
                        "Nonordinary bounded proc metadata")
                with os.fdopen(os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory), "rb") as stream:
                    require(metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Proc metadata FD changed")
                    raw = stream.read(limit + 1)
                    require(len(raw) <= limit and metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Proc metadata changed/oversized")
                require(metadata_stamp(os.stat(leaf, dir_fd=directory, follow_symlinks=False)) == metadata_stamp(before), "Proc metadata pathname changed")
                return raw
            def snapshot():
                info = os.fstat(directory)
                require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == UID
                        and metadata_stamp(info) == metadata_stamp(path.lstat()), "Fixture proc directory changed")
                raw = read("stat", 4096).decode("utf-8")
                start, parent = helper.parse_start(raw, pid), int(raw[raw.rfind(")") + 2:].split()[1])
                allowed = ("Name", "State", "PPid", "Uid", "Gid", "Threads", "NoNewPrivs",
                           "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "Seccomp")
                fields = {}
                for line in read("status", 16384).splitlines():
                    key, separator, value = line.partition(b":")
                    if key not in tuple(name.encode("ascii") for name in allowed):
                        continue
                    name, value = key.decode("ascii"), value.strip().decode("utf-8")
                    require(separator and name not in fields and 0 < len(value) <= 256, "Ambiguous status field")
                    if name in ("Uid", "Gid"):
                        require(re.fullmatch(r"[0-9]{1,10}(?:[ \t]+[0-9]{1,10}){3}", value), "Invalid credential tuple")
                        value = [int(part) for part in value.split()]
                    elif name.startswith("Cap"):
                        require(re.fullmatch(r"[a-fA-F0-9]{1,16}", value), "Invalid capability metadata")
                    elif name not in ("Name", "State"):
                        require(re.fullmatch(r"[0-9]{1,20}", value), "Invalid numeric status metadata")
                        value = int(value)
                    else:
                        require(not re.search(r"[\x00-\x1f\x7f]", value), "Control character in status metadata")
                    fields[name] = value
                require(set(fields) == set(allowed) and fields["Uid"] == fields["Gid"] == [UID] * 4
                        and fields["PPid"] == parent, "Exact fixture status unavailable")
                require(metadata_stamp(os.fstat(directory)) == metadata_stamp(info) == metadata_stamp(path.lstat()), "Proc directory changed")
                return {"procDirectory": metadata_row(path.as_posix(), info), "startTime": start,
                        "parentPid": parent, "Uid": fields["Uid"], "Gid": fields["Gid"]}, fields
            row["before"], row["statusBefore"] = snapshot()
            require(expected is None or row["before"] == expected, "Retained failure tuple changed")
            if executable:
                try:
                    # Follow only this kernel magiclink through the held proc FD, never its reported pathname.
                    target = os.readlink("exe", dir_fd=directory)
                    require(target.startswith("/") and len(target.encode("utf-8")) <= 4096
                            and not re.search(r"[\x00-\x1f\x7f]", target), "Unbounded executable path")
                    with os.fdopen(os.open("exe", os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory), "rb") as stream:
                        before = os.fstat(stream.fileno())
                        require(stat.S_ISREG(before.st_mode) and 0 <= before.st_size <= 64 * 1024 * 1024, "Nonordinary/oversized executable")
                        require(metadata_stamp(os.stat("exe", dir_fd=directory, follow_symlinks=True)) == metadata_stamp(before), "Executable target changed")
                        sha, total = hashlib.sha256(), 0
                        while True:
                            raw = stream.read(min(1048576, 64 * 1024 * 1024 - total + 1))
                            if not raw:
                                break
                            total += len(raw)
                            require(total <= 64 * 1024 * 1024, "Executable stream exceeded bound")
                            sha.update(raw)
                        after = os.fstat(stream.fileno())
                        require(total == before.st_size and metadata_stamp(before) == metadata_stamp(after)
                                == metadata_stamp(os.stat("exe", dir_fd=directory, follow_symlinks=True))
                                and os.readlink("exe", dir_fd=directory) == target, "Executable changed during capture")
                    row["executable"] = {"status": "captured", "path": target, "sha256": sha.hexdigest(),
                                         "before": metadata_row(target, before), "after": metadata_row(target, after)}
                except Exception as error:
                    row["executable"] = {"status": "unknown", "error": error_row(error)}
            row["after"], row["statusAfter"] = snapshot()
            require(row["before"] == row["after"], "Process identity changed during capture")
            row["stable"] = True
            if not executable or row["executable"]["status"] == "captured":
                row["status"] = "captured"
        except Exception as error:
            row["error"] = error_row(error)
        finally:
            if directory is not None:
                os.close(directory)
        return row
    try:
        require(os.getuid() == os.geteuid() == 0, "Root-only failure attribution")
        code = child.poll() if child is not None else None
        require(type(code) is int and code != 0, "Just-failed session child required")
        candidates = []
        for role in ("first", "reopened"):
            file = BASE / "result" / role / "session.json"
            if os.path.lexists(file):
                receipt = P.parse(read_file(file, 65536, uid=UID, mode=0o600))
                if receipt.get("startupRefused", {}).get("type") == "PermissionError":
                    candidates.append((role, receipt["processInventoryRefusal"]))
        require(len(candidates) == 1, "One failed-session receipt required")
        role, capture = candidates[0]
        pid, expected = capture["pid"], capture["before"]
        require(type(pid) is int and 1 <= pid <= 2147483647 and type(capture["errno"]) is int
                and capture["errno"] in (1, 13) and capture["readOnly"] is True and capture["stable"] is True
                and expected == capture["after"], "Unstable or non-permission failure tuple")
        for saved in (expected, capture["after"]):
            keys(saved, ("procDirectory", "startTime", "parentPid", "Uid", "Gid"))
            keys(saved["procDirectory"], ("path", "type", "uid", "gid", "mode", "nlink", "dev", "ino", "size", "mtimeNs", "ctimeNs"))
            require(all(type(value) is int for key, value in saved["procDirectory"].items() if key not in ("path", "type"))
                    and all(type(value) is int for name in ("Uid", "Gid") for value in saved[name])
                    and type(saved["parentPid"]) is int and type(saved["startTime"]) is str,
                    "Failure tuple types differ")
        require(expected["Uid"] == expected["Gid"] == [UID] * 4
                and type(expected["parentPid"]) is int and 1 <= expected["parentPid"] <= 2147483647
                and expected["parentPid"] != pid and type(expected["startTime"]) is str
                and re.fullmatch(r"[0-9]{1,20}", expected["startTime"])
                and expected["procDirectory"]["path"] == f"/proc/{pid}"
                and expected["procDirectory"]["uid"] == expected["procDirectory"]["gid"] == UID,
                "Exact fixture failure identity required")
        result.update(receipt=role, errno=capture["errno"])
        result["failed"] = observe(pid, expected)
        require(result["failed"]["stable"], "Failed PID identity unavailable")
        result["parent"] = observe(expected["parentPid"])
        result["failedRecheck"] = observe(pid, expected, executable=False)
        if all(result[name]["status"] == "captured" for name in ("failed", "parent", "failedRecheck")):
            result.update(status="captured", stable=True)
    except Exception as error:
        result["error"] = error_row(error)
    return result


def verified_route(home, binding):
    router, server = route(home)
    active = P.parse(read_file(home / "data/creator-hub/mcp-route-v1/linux-x86_64/active.json", 16384))
    expected = binding["resourceFiles"]
    require(active["descriptorSha256"] == expected["routing/runtime.json"], "Active descriptor is not the inspected signed runtime")
    directory = home / "data/creator-hub/mcp-route-v1/linux-x86_64/descriptors" / active["descriptorSha256"]
    raw = read_file(directory / "runtime.json")
    require(digest(raw) == expected["routing/runtime.json"] and digest(read_file(directory / "runtime.minisig")) == expected["routing/runtime.minisig"], "Retained runtime metadata/signature differ")
    descriptor = P.parse(raw)
    module = descriptor["module"]
    canonical = json.dumps({"executable": module["executable"], "version": module["version"], "files": dict(sorted(module["files"].items()))}, separators=(",", ":"), ensure_ascii=False).encode()
    require(digest(canonical) == active["generation"], "Retained generation is not the bound module")
    base = home / "data/creator-hub/runtime-generations/linux-x86_64" / active["generation"]
    require(type(module["files"]) is dict and 0 < len(module["files"]) <= 64, "Bounded runtime inventory required")
    for name, sha in module["files"].items():
        P.S.safe_name(name)
        require(expected[name] == sha and digest(read_file(base / name, 256 * 1024 * 1024)) == sha, "Retained payload differs from original signed inventory")
    metadata = router.parent / "router.json"
    require(digest(read_file(metadata)) == expected["routing/router.json"]
            and digest(read_file(router.parent / "router.minisig")) == expected["routing/router.minisig"], "Router metadata/signature differ")
    identity = P.parse(read_file(metadata))
    require(digest(read_file(router, 32 * 1024 * 1024, uid=UID, mode=0o500)) == identity["sha256"], "Retained router image differs")
    return router, server


def legacy_inventory(file, product):
    rows, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(P.S.deb_records(file)), mode="r:") as archive:
        for row in archive:
            name = row.name.removeprefix("./").rstrip("/")
            if name in ("", "."):
                require(row.isdir(), "Legacy archive root differs"); continue
            P.S.safe_name(name)
            require(row.uid == row.gid == 0 and (row.isfile() or row.isdir()) and not row.mode & 0o7022, "Legacy package member type/ownership differs")
            if row.isdir():
                continue
            require(name not in rows and len(rows) < 32 and 0 <= row.size <= 256 * 1024 * 1024, "Legacy inventory bound/duplicate")
            raw = archive.extractfile(row).read(row.size + 1)
            total += len(raw)
            require(len(raw) == row.size and total <= 512 * 1024 * 1024, "Legacy inventory truncated/oversized")
            rows[name] = {"size": row.size, "sha256": digest(raw), "mode": row.mode}
    require(len(rows) == (14 if product == "mcp" else 5), "Exact original legacy file count differs")
    if product == "mcp":
        require(sum(name.startswith("usr/lib/Creator Works MCP/server/") for name in rows) == 9, "Exact original retained runtime count differs")
    return rows


def pending_command(raw, target):
    require(target in ("mcp", "setup"), "Finite retirement target required")
    argument = "retire-mcp-2.7.7" if target == "mcp" else "retire-setup-0.3.7"
    require(raw == b"\0".join(value.encode() for value in ("/usr/bin/pkexec", "--disable-internal-agent", HELPER, argument)) + b"\0",
            "Pending request is not the exact production retirement command")


def proc_bytes(file, limit):
    with file.open("rb") as stream:
        raw = stream.read(limit + 1)
    require(len(raw) <= limit, "Kernel observation exceeds bound")
    return raw


def proof_request(value, scenario):
    keys(value, ("index", "target"))
    require(type(value["index"]) is int and 1 <= value["index"] <= 48 and value["target"] in ("mcp", "setup"), "Bounded one-shot input proof required")
    require(scenario != SCENARIOS[0] and (value["target"] != "setup" or scenario in SCENARIOS[2:]), "Scenario does not authorize this target")


def observe_request(value, context, binding, helper, native, polkit):
    require(os.getuid() == 0, "Read-only root observer required for setuid procfs")
    root = P.parse(read_file(BASE / "result/root.json", 16384, uid=UID, mode=0o600))
    require(type(root.get("pid")) is int and 1 < root["pid"] < 2**22 and root.get("uids") == [UID] * 4, "Bounded synthetic Root identity required")
    actual = native.native_process(root["pid"], helper)
    require(actual == root and root["executable"] == HUB and root["kernelImageSha256"] == binding["profile"]["pins"]["hub"]["sha256"], "Observed Root is not the inspected 016 image")
    backend = native.native_process(root["parentPid"], helper)
    driver = native.native_process(backend["parentPid"], helper)
    driver_pin = P.parse(read_file(BASE / "driver.json", uid=0, mode=0o644))
    require(backend["uids"] == driver["uids"] == [UID] * 4 and backend["executable"] == "/usr/bin/WebKitWebDriver"
            and driver["executable"] == str(BASE / "bin/tauri-driver") and driver["kernelImageSha256"] == driver_pin["sha256"], "Root driver ancestry differs")
    supervisor = native.native_process(driver["parentPid"], helper)
    require(supervisor["uids"] == [UID] * 4 and proc_bytes(Path(f"/proc/{supervisor['pid']}/cmdline"), 8192)
            == b"/usr/bin/python3\0-B\0/opt/creator-polkit-fixture/scripts/native-linux-production-016-migration.py\0session\0",
            "Root is not owned by the fixed synthetic session")
    require(supervisor["pid"] == context.setdefault("supervisor", supervisor)["pid"], "Session supervisor changed")
    policy = read_file(Path(POLICY), 16384, uid=0, mode=0o644)
    require(digest(policy) == binding["profile"]["pins"]["policy"]["sha256"], "Production policy changed before native input")
    helper_raw = read_file(Path(HELPER), 256 * 1024 * 1024, uid=0, mode=0o755)
    require(digest(helper_raw) == binding["profile"]["pins"]["helper"]["sha256"], "Production helper changed before native input")
    if value["target"] == "setup":
        inspection(P.parse(tool([HELPER, "inspect-retained-mcp-2.7.7"], helper_pin=binding["profile"]["pins"]["helper"])), "mcp", True)
    children = set()
    for task in Path(f"/proc/{root['pid']}/task").iterdir():
        try:
            raw = (task / "children").read_bytes()
        except FileNotFoundError:
            continue
        require(len(raw) <= 8192 and re.fullmatch(rb"[0-9 ]*", raw), "Bounded child inventory required")
        children.update(map(int, raw.split()))
    require(len(children) <= 32, "Root child inventory exceeds bound")
    matches = []
    for pid in sorted(children):
        try:
            with Path(f"/proc/{pid}/cmdline").open("rb") as stream:
                raw = stream.read(8193)
        except (ProcessLookupError, FileNotFoundError):
            continue
        require(len(raw) <= 8192, "Pending command bound exceeded")
        if raw.split(b"\0", 1)[0] != b"/usr/bin/pkexec":
            continue
        pending_command(raw, value["target"])
        process = native.native_process(pid, helper)
        require(process["parentPid"] == root["pid"] and process["executable"] == "/usr/bin/pkexec"
                and process["kernelImageSha256"] == polkit.FILES["/usr/bin/pkexec"][3]
                and process["uids"] == [UID, 0, 0, 0], "Different setuid request image/ownership")
        descriptor = os.stat(f"/proc/{pid}/fd/0")
        require(stat.S_ISCHR(descriptor.st_mode) and descriptor.st_rdev == os.stat("/dev/null").st_rdev,
                "Migration requests use null stdin, not the old sealed updater package")
        require(native.native_process(pid, helper) == process and native.native_process(root["pid"], helper) == root, "Pending process changed during observation")
        matches.append({"root": root, "pkexec": process, "target": value["target"], "policySha256": digest(policy), "readOnly": True})
    require(len(matches) == 1, "One exact pending Root retirement request required")
    return matches[0]


HELPER_DIAGNOSTIC_PHASES = ("mcp-dismissed", "setup-window-wait-failed")
HELPER_DIAGNOSTIC_FLAGS = {"diagnosticOnly": True, "authorityGranted": False, "inputPermitted": False, "releaseReady": False}


def helper_diagnostic_stage(record, stage):
    if record is not None:
        record["stage"] = stage


def helper_diagnostic_request(value, phase, harness, scenario, index):
    keys(value, ("phase", "harnessSource", "scenario", "inputIndex", "mcpDismissedNs", "setupWaitStartedNs", "observedNs"))
    require(phase in HELPER_DIAGNOSTIC_PHASES and value["phase"] == phase
            and value["harnessSource"] == harness and scenario in SCENARIOS[2:] and value["scenario"] == scenario
            and type(value["inputIndex"]) is int and value["inputIndex"] == index and 1 <= index <= 48,
            "Diagnostic event is not bound to the recorded MCP input")
    for key in ("mcpDismissedNs", "observedNs"):
        require(type(value[key]) is int and 0 < value[key] < 2**63, "Invalid diagnostic clock")
    if phase == HELPER_DIAGNOSTIC_PHASES[0]:
        require(value["setupWaitStartedNs"] is None and value["observedNs"] == value["mcpDismissedNs"], "Invalid dismissal clock")
    else:
        start = value["setupWaitStartedNs"]
        require(type(start) is int and value["mcpDismissedNs"] <= start <= value["observedNs"], "Invalid wait clock")


def helper_diagnostic_read(directory, leaf, limit):
    require(leaf in ("stat", "wchan", "io", "children") and type(limit) is int and 0 < limit <= 4096,
            "Fixed diagnostic proc leaf required")
    before = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit,
            "Nonordinary diagnostic proc leaf")
    with os.fdopen(os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory), "rb") as stream:
        require(metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Diagnostic proc FD changed")
        raw = stream.read(limit + 1)
        require(len(raw) <= limit and metadata_stamp(os.fstat(stream.fileno())) == metadata_stamp(before), "Diagnostic proc read changed/oversized")
    require(metadata_stamp(os.stat(leaf, dir_fd=directory, follow_symlinks=False)) == metadata_stamp(before), "Diagnostic proc path changed")
    return raw


def helper_diagnostic_sample(pid, expected, native, helper, diagnostic=None):
    helper_diagnostic_stage(diagnostic, "proc-directory")
    require(type(pid) is int and 1 < pid < 2**22, "Bounded diagnostic PID required")
    path = Path(f"/proc/{pid}")
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(directory)
        require(stat.S_ISDIR(before.st_mode) and before.st_uid in (0, UID)
                and metadata_stamp(before) == metadata_stamp(path.lstat()), "Diagnostic process directory changed")
        identity = native.native_process(pid, helper, False)
        require(identity == {k: v for k, v in expected.items() if k != "kernelImageSha256"}, "Diagnostic process identity changed")
        helper_diagnostic_stage(diagnostic, "proc-stat")
        raw = helper_diagnostic_read(directory, "stat", 4096).decode("ascii")
        fields = raw[raw.rfind(")") + 2:].split()
        require(helper.parse_start(raw, pid) == identity["startTime"] and len(fields) >= 20
                and fields[0] in tuple("RSDTtKWPI") and fields[1] == str(identity["parentPid"])
                and all(re.fullmatch(r"[0-9]{1,20}", fields[i]) for i in (11, 12)), "Diagnostic stat identity/counters differ")
        helper_diagnostic_stage(diagnostic, "proc-wchan")
        wchan = helper_diagnostic_read(directory, "wchan", 128).decode("ascii").strip()
        require(re.fullmatch(r"[A-Za-z0-9_]{1,127}", wchan), "Invalid diagnostic wait channel")
        helper_diagnostic_stage(diagnostic, "proc-io")
        io_values = {}
        for line in helper_diagnostic_read(directory, "io", 4096).splitlines():
            match = re.fullmatch(rb"(rchar|wchar|syscr|syscw|read_bytes|write_bytes|cancelled_write_bytes): ([0-9]{1,20})", line)
            require(match is not None and match[1].decode() not in io_values, "Invalid diagnostic I/O counters")
            io_values[match[1].decode()] = int(match[2])
        require(len(io_values) == 7, "Incomplete diagnostic I/O counters")
        helper_diagnostic_stage(diagnostic, "proc-children")
        children = set()
        tasks = os.open("task", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            with os.scandir(tasks) as entries:
                for count, entry in enumerate(entries):
                    require(count < 64 and re.fullmatch(r"[1-9][0-9]{0,6}", entry.name), "Diagnostic thread bound exceeded")
                    task = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=tasks)
                    try:
                        body = helper_diagnostic_read(task, "children", 4096)
                        require(re.fullmatch(rb"[0-9 ]*", body), "Invalid diagnostic children")
                        children.update(map(int, body.split()))
                        require(len(children) <= 8 and all(1 < child < 2**22 and child != pid for child in children), "Diagnostic child bound exceeded")
                    finally:
                        os.close(task)
        finally:
            os.close(tasks)
        helper_diagnostic_stage(diagnostic, "proc-continuity")
        require(native.native_process(pid, helper, False) == identity
                and metadata_stamp(os.fstat(directory)) == metadata_stamp(before) == metadata_stamp(path.lstat()),
                "Diagnostic process changed during sample")
        return {"identity": expected, "state": fields[0], "wchan": wchan, "cpuTicks": {"user": int(fields[11]), "system": int(fields[12])},
                "io": io_values, "observedNs": time.monotonic_ns()}, sorted(children)
    finally:
        os.close(directory)


def helper_diagnostic_processes(proof, binding, native, helper, diagnostic=None):
    helper_diagnostic_stage(diagnostic, "process-binding")
    root, authorized = proof["root"], proof["pkexec"]
    require(proof["target"] == "mcp" and authorized["parentPid"] == root["pid"], "Recorded MCP ancestry required")
    def recheck_root():
        helper_diagnostic_stage(diagnostic, "hub-identity")
        require(native.native_process(root["pid"], helper, False) == {k: v for k, v in root.items() if k != "kernelImageSha256"},
                "Recorded Hub changed before diagnostic")
    recheck_root()
    rows, pending, seen = [], [(authorized["pid"], None)], set()
    while pending:
        pid, parent = pending.pop(0)
        helper_diagnostic_stage(diagnostic, "descendant-bound")
        require(type(pid) is int and 1 < pid < 2**22 and pid not in seen and len(seen) < 8, "Diagnostic descendant bound/cycle")
        seen.add(pid)
        helper_diagnostic_stage(diagnostic, "process-identity")
        identity = native.native_process(pid, helper, False)
        image = identity["image"]
        helper_diagnostic_stage(diagnostic, "image-bound")
        require(0 < int(image["st_size"]) <= 16 * 1024 * 1024 and int(image["st_uid"]) == int(image["st_gid"]) == 0
                and not int(image["st_mode"]) & 0o022, "Diagnostic image is not bounded/protected")
        if parent is None:
            helper_diagnostic_stage(diagnostic, "authorized-identity")
            require(identity["startTime"] == authorized["startTime"] and identity["parentPid"] == root["pid"]
                    and ((identity["executable"] == HELPER and identity["uids"] == [0] * 4)
                         or (identity["executable"] == "/usr/bin/pkexec" and identity["uids"] == authorized["uids"])),
                    "Recorded authorized process changed or is foreign")
        else:
            helper_diagnostic_stage(diagnostic, "descendant-identity")
            require(identity["parentPid"] == parent["pid"] and int(identity["startTime"]) >= int(parent["startTime"])
                    and identity["uids"] == [0] * 4, "Foreign diagnostic descendant")
        helper_diagnostic_stage(diagnostic, "image-hash")
        full = native.native_process(pid, helper)
        require({k: v for k, v in full.items() if k != "kernelImageSha256"} == identity, "Diagnostic image changed while hashing")
        if parent is None:
            helper_diagnostic_stage(diagnostic, "authorized-image-pin")
            expected_hash = binding["profile"]["pins"]["helper"]["sha256"] if identity["executable"] == HELPER else authorized["kernelImageSha256"]
            require(full["kernelImageSha256"] == expected_hash, "Authorized diagnostic image differs")
        row, children = helper_diagnostic_sample(pid, full, native, helper, diagnostic)
        rows.append(row)
        helper_diagnostic_stage(diagnostic, "descendant-bound")
        require(len(seen) + len(pending) + len(children) <= 8, "Diagnostic descendant bound exceeded")
        pending.extend((child, identity) for child in children)
    recheck_root()
    helper_diagnostic_stage(diagnostic, "final-identity")
    for row in rows:
        require(native.native_process(row["identity"]["pid"], helper, False)
                == {k: v for k, v in row["identity"].items() if k != "kernelImageSha256"}, "Diagnostic ancestry changed after collection")
    return rows


def collect_helper_diagnostics(context, record, env, binding, native, helper):
    # Separate, non-authoritative mailbox: never replies to or advances input RPC.
    for number, phase in enumerate(HELPER_DIAGNOSTIC_PHASES, 1):
        path = BASE / f"result/helper-diagnostic-{number}.json"
        rows = record.setdefault("helperDiagnostics", {})
        if phase in rows or not os.path.lexists(path):
            continue
        row = rows[phase] = {**HELPER_DIAGNOSTIC_FLAGS, "status": "unavailable", "stage": "channel", "brokerObservedNs": time.monotonic_ns()}
        try:
            require(os.getuid() == os.geteuid() == 0, "Root-only diagnostic observer")
            inventory_channel()
            row["stage"] = "request-read"
            request = P.parse(read_file(path, 1024, uid=UID, mode=0o600))
            row["stage"] = "request-binding"
            index, proof = context["mcpDiagnosticProof"]
            helper_diagnostic_request(request, phase, env["GITHUB_SHA"], record["scenario"], index)
            if number == 2:
                require(request["mcpDismissedNs"] == rows[HELPER_DIAGNOSTIC_PHASES[0]]["request"]["mcpDismissedNs"], "Diagnostic dismissal event changed")
            row["request"] = request
            row["binding"] = {"root": proof["root"], "authorizedMcp": proof["pkexec"]}
            row["stage"] = "process-binding"
            processes = helper_diagnostic_processes(proof, binding, native, helper, row)
            row["stage"] = "receipt-bound"
            require(len(json.dumps(processes, allow_nan=False).encode()) <= 32768, "Diagnostic receipt exceeds bound")
            row.update(status="captured", stage="complete", processes=processes)
        except Exception as error:
            row["errorType"] = type(error).__name__[:100]


def serve_helper_diagnostics(context, record, env, binding, native, helper):
    try:
        collect_helper_diagnostics(context, record, env, binding, native, helper)
    except Exception as error:
        record.setdefault("helperDiagnosticChannelRefusal", {**HELPER_DIAGNOSTIC_FLAGS, "stage": "channel", "errorType": type(error).__name__[:100]})


class Authorization:
    def __init__(self, session, agent, identity, parent, endpoint, system, atspi, glib, question, counter, sdk, session_identity):
        self.s, self.agent, self.identity, self.parent = session, agent, identity, parent
        self.endpoint, self.system, self.atspi, self.glib = copy.deepcopy(endpoint), system, atspi, glib
        self.session_identity = copy.deepcopy(session_identity)
        self.question, self.counter, self.sdk = question, counter, sdk
        self.records = []
        self.mcp_dismissed_ns = None

    def helper_diagnostic(self, phase, wait_started=None):
        rows = self.s.evidence.setdefault("helperDiagnostics", {})
        if phase in rows:
            return
        row = rows[phase] = {**HELPER_DIAGNOSTIC_FLAGS, "status": "unavailable"}
        try:
            number = HELPER_DIAGNOSTIC_PHASES.index(phase) + 1
            observed = self.mcp_dismissed_ns if number == 1 else time.monotonic_ns()
            request = {"phase": phase, "harnessSource": os.environ["GITHUB_SHA"], "scenario": os.environ["CREATOR_MIGRATION_016_SCENARIO"],
                       "inputIndex": self.counter[0], "mcpDismissedNs": self.mcp_dismissed_ns,
                       "setupWaitStartedNs": wait_started, "observedNs": observed}
            helper_diagnostic_request(request, phase, request["harnessSource"], request["scenario"], self.counter[0])
            publish(BASE / f"result/helper-diagnostic-{number}.json", request)
            row.update(status="queued", request=request)
        except Exception as error:
            row["errorType"] = type(error).__name__[:100]

    def recheck_input_context(self):
        s, p = self.s, self.s.polkit
        s.guard()
        p.own_agent(self.agent, self.identity, self.parent, s.helper)
        require(p.bus_identity(self.system, self.endpoint["owner"], self.glib)
                == {k: self.endpoint[k] for k in ("owner", "pid", "uid")}, "Agent endpoint changed")
        require(p.bus_identity(self.system, "org.freedesktop.PolicyKit1", self.glib) == self.endpoint["authority"], "Original system authority changed")
        for pid in (self.parent["pid"], self.identity["pid"], s.owned["pid"]):
            require(p.session(self.system, pid, self.glib) == self.session_identity, "Original local authentication session changed")
        self.sdk.alive()

    def input_guard(self, target, record):
        self.recheck_input_context()
        self.counter[0] += 1
        value = {"index": self.counter[0], "target": target}
        proof_request(value, os.environ["CREATOR_MIGRATION_016_SCENARIO"])
        publish(BASE / f"result/input-{value['index']}.json", value)
        response = BASE / f"input-{value['index']}.json"
        self.s.pages.wait(response.exists)
        answer = P.parse(read_file(response, 32768, uid=0, mode=0o644))
        require(answer["request"] == value and answer["ok"] is True and answer["proof"]["root"] == self.s.owned
                and answer["proof"]["target"] == target, "Fresh kernel input proof refused")
        # The read-only broker wait can outlive a polkit or logind change.
        self.recheck_input_context()
        record["lastKernelProof"] = answer["proof"]

    def act(self, target, authenticate, secret):
        s, p = self.s, self.s.polkit
        s.dialogs = {(self.identity["pid"], "Authenticate")}
        wait_started = time.monotonic_ns()
        try:
            s.pages.wait(lambda: bool(p.windows(self.identity["pid"], s.helper, s.x11)), 30)
        except Exception:
            if target == "setup" and self.mcp_dismissed_ns is not None:
                self.helper_diagnostic(HELPER_DIAGNOSTIC_PHASES[1], wait_started)
            raise
        windows = p.windows(self.identity["pid"], s.helper, s.x11)
        require(len(windows) == 1, "One owned authentication window required")
        refs, bus = s.native.native_ax_references()
        protected, geometry = {}, {}
        record = {"target": target, "mode": "authenticate" if authenticate else "cancel", "passwordRead": False}
        self.records.append(record)
        s.evidence["authorization"] = self.records
        def guard():
            self.input_guard(target, record)
        def profile():
            require(p.windows(self.identity["pid"], s.helper, s.x11) == windows, "Authentication window changed")
            frame = s.x11.frame_rectangle(windows[0]["window"])
            owner = type("Owner", (), {"root": self.identity, "renderer": None})()
            refs.recheck()
            observations = []
            graph, nodes = ax_graph(self.atspi, s.helper, s.native, refs, owner, frame, protected=protected, observations=observations)
            authentication_graph_contract(graph, pid=self.identity["pid"], question=self.question, observations=observations, record=record)
            selected = None
            if authenticate:
                combos = [(node, row) for node, row in zip(nodes, graph) if row["role"] == int(self.atspi.Role.COMBO_BOX)]
                require(len(combos) == 1 and combos[0][1]["name"] == USER, "Only the fixed synthetic administrator may be selected")
                selection = combos[0][0].get_selection_iface()
                require(selection is not None and selection.get_n_selected_children() == 1, "One administrator selection required")
                selected = selection.get_selected_child(0)
                selected.clear_cache()
                require(selected.get_process_id() == self.identity["pid"] and selected.get_role() == self.atspi.Role.MENU_ITEM
                        and selected.get_name() == USER and any(row["reference"] == list(refs.identity(selected, owner))
                                                              and row["name"] == USER for row in graph), "Selected identity escaped the bound graph")
            receipt = {"graph": graph, "native": windows, "frame": frame, "passwordRead": False,
                       "selectedIdentity": USER if authenticate else None, "selectedIdentityVerified": authenticate}
            password = next(node for node, row in zip(nodes, graph) if row["role"] == 40)
            button = next(node for node, row in zip(nodes, graph) if row["role"] == 43 and row["name"] == ("Authenticate" if authenticate else "Cancel"))
            refs.recheck()
            require(s.x11.frame_rectangle(windows[0]["window"]) == frame, "Authentication frame changed")
            return ((password, button) if authenticate else button), receipt
        try:
            if authenticate:
                p.authenticate_once(profile, guard, record, secret)
            else:
                p.cancel_once(profile, guard, record)
            dismissal = {}
            s.pages.wait(lambda: s.native_target_absent(windows[0]["window"], dismissal), 30)
            record["nativeDismissal"] = dismissal
            if target == "mcp" and authenticate:
                self.mcp_dismissed_ns = time.monotonic_ns()
                self.helper_diagnostic(HELPER_DIAGNOSTIC_PHASES[0])
        finally:
            bus.close_sync(None)
        s.dialogs.clear()


SDK_JS = r"""
const assert = require('node:assert/strict'), fs = require('node:fs'), readline = require('node:readline');
const {createRequire} = require('node:module');
const sdk = createRequire('/opt/creator-polkit-fixture/sdk/package.json');
const {Client} = sdk('@modelcontextprotocol/sdk/client/index.js');
const {ReadBuffer,serializeMessage} = sdk('@modelcontextprotocol/sdk/shared/stdio.js');
const [input,output,diagnostics] = process.argv.slice(1).map(n => {assert.match(n,/^[0-9]{1,3}$/);return Number(n);});
const stdin = fs.createWriteStream(null,{fd:input,autoClose:true});
const stdout = fs.createReadStream(null,{fd:output,autoClose:true});
const stderr = fs.createReadStream(null,{fd:diagnostics,autoClose:true});
let total=0, errors=0, eof=false, ended=false, checks=0;
const codec=new ReadBuffer();
const transport={
 async start(){
  stdout.on('data',chunk=>{try{total+=chunk.length;assert.ok(total<=524288);codec.append(chunk);let m;while((m=codec.readMessage())!==null)this.onmessage?.(m);}catch(e){this.onerror?.(e);}});
  stdout.on('end',()=>{ended=true;this.onclose?.();});stdout.on('error',e=>this.onerror?.(e));
  stderr.on('data',chunk=>{errors+=chunk.length;if(errors>65536)this.onerror?.(Error('Bounded diagnostics exceeded'));});
  stderr.on('error',e=>this.onerror?.(e));stdin.on('error',e=>this.onerror?.(e));
 },
 async send(message){assert.ok(['initialize','notifications/initialized','tools/list'].includes(message.method));const raw=serializeMessage(message);assert.ok(Buffer.byteLength(raw)<=16384);await new Promise((ok,no)=>stdin.write(raw,e=>e?no(e):ok()));},
 async close(){if(!eof){eof=true;stdin.end();}const deadline=Date.now()+10000;while(!ended&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,20));assert.ok(ended,'EOF-only shutdown deadline');}
};
const client = new Client({name:'production-016-migration-sdk',version:'1'});
(async()=>{
 await client.connect(transport,{timeout:10000,maxTotalTimeout:10000});
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
 emit({ready:true,server:client.getServerVersion()});
 for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
  assert.ok(line.length<=32);const command=JSON.parse(line);assert.deepEqual(Object.keys(command),['op']);
  if(command.op==='check'){
   assert.ok(++checks<=8);const tools=await client.listTools({},{timeout:10000,maxTotalTimeout:10000});
   assert.deepEqual(client.getServerVersion(),{name:'creator-works-mcp',version:'2.7.7'});
   const names=tools.tools.map(t=>t.name).sort();assert.deepEqual(names,['get_bridge_status','get_unity_command_status','list_unity_projects','select_unity_project']);
   emit({checked:true,checks,tools:names,signalsRequested:false});
  }else{assert.equal(command.op,'close');await client.close();emit({closed:true,eofSent:eof,ended,signalsRequested:false,stdoutBytes:total,stderrBytes:errors});return;}
 }
 throw Error('Missing explicit EOF close command');
})().catch(error=>{stdin.end();process.stderr.write(String(error.message).slice(0,500));process.exitCode=1;});
"""


class SDK:
    def __init__(self, root, command, args, environment):
        self.pages, self.helper, self.native, _ = neutral()
        self.root = root
        self.runtime = subprocess.Popen([str(command), *args], cwd=environment["HOME"], env=environment,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.runtime_identity = self.native.native_process(self.runtime.pid, self.helper)
        require(self.runtime_identity["parentPid"] == os.getpid() and self.runtime_identity["uids"] == [UID] * 4, "Owned runtime required")
        if str(command) == OLD_NODE:
            require(self.runtime_identity["kernelImageSha256"] == NODE_SHA, "Original Node kernel image differs")
        else:
            require(self.runtime_identity["kernelImageSha256"] == digest(read_file(command, 256 * 1024 * 1024)), "Managed router kernel image differs")
        fds = [stream.fileno() for stream in (self.runtime.stdin, self.runtime.stdout, self.runtime.stderr)]
        self.child = subprocess.Popen([OLD_NODE, "-e", SDK_JS, *map(str, fds)], cwd=environment["HOME"], env=environment,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=fds)
        self.child_identity = self.native.native_process(self.child.pid, self.helper)
        require(self.child_identity["kernelImageSha256"] == NODE_SHA and self.child_identity["parentPid"] == os.getpid(), "Owned SDK Node differs")
        for stream in (self.runtime.stdin, self.runtime.stdout, self.runtime.stderr):
            stream.close()
        self.pidfd = os.pidfd_open(self.runtime.pid)
        self.capture = self.native.Capture(self.child, root, "sdk")
        self.offset = 0
        ready = self.response()
        require(ready == {"ready": True, "server": {"name": "creator-works-mcp", "version": "2.7.7"}}, "Actual SDK/server handshake differs")
        self.check()

    def alive(self):
        require(self.runtime.poll() is None and not select.select([self.pidfd], [], [], 0)[0], "Existing MCP runtime exited during migration")
        current = self.native.native_process(self.runtime.pid, self.helper)
        for key in ("pid", "startTime", "parentPid", "uids", "kernelImageSha256"):
            require(current[key] == self.runtime_identity[key], "MCP runtime kernel identity changed")
        require(self.child.poll() is None, "SDK transport exited unexpectedly")

    def response(self):
        result = None
        def ready():
            nonlocal result
            self.capture.pump(0.02)
            require(not any(v["truncated"] for v in self.capture.metadata().values()), "SDK log bound exceeded")
            raw = bytes(self.capture.items["stdout"]["kept"])
            end = raw.find(b"\n", self.offset)
            if end >= 0:
                require(end - self.offset <= 16384, "SDK response exceeds bound")
                result = P.parse(raw[self.offset:end]); self.offset = end + 1
                return True
            require(self.child.poll() is None, "SDK helper ended without its bounded receipt")
            return False
        self.pages.wait(ready, 20)
        return result

    def check(self):
        self.alive()
        require(self.child.stdin.write(b'{"op":"check"}\n') == 15, "SDK control delivery uncertain; no retry")
        self.child.stdin.flush()
        value = self.response()
        require(value.get("checked") is True and value.get("signalsRequested") is False, "SDK listTools failed")
        self.alive()
        return value

    def close(self):
        self.alive()
        require(self.child.stdin.write(b'{"op":"close"}\n') == 15, "SDK EOF request delivery uncertain")
        self.child.stdin.flush()
        value = self.response()
        require(value.get("closed") is True and value.get("eofSent") is True and value.get("ended") is True
                and value.get("signalsRequested") is False, "SDK did not close through EOF only")
        self.child.stdin.close()
        self.pages.wait(lambda: self.child.poll() is not None and self.runtime.poll() is not None, 15)
        require(self.child.wait(timeout=0) == self.runtime.wait(timeout=0) == 0, "SDK/runtime did not exit normally")
        self.capture.pump(); self.capture.close(); os.close(self.pidfd)
        save(self.root / "sdk-result.json", value)


def journal(home):
    return P.parse(read_file(home / JOURNAL, 65536, uid=UID))


def home_observation(d, home):
    require(d.read("#platform-status") == "Linux" and d.read("#platform-status", "displayed") is True,
            "Actual native platform label is not visible Linux")
    require(d.read(".footer-version") == "0.1.16" and d.read(".footer-version", "displayed") is True
            and " ".join(d.read("#page-title").split()) == "CREATOR HUB", "Visible Hub identity/version differs")
    for selector, visible in (("#view-projects", True), ("#projects-home-title", True), ("#unified-home-updater", True),
                              ("#view-hub", False), ("#view-hosted", False), ("#view-native-features", False)):
        require(d.read(selector, "displayed") is visible, "Actual integrated Projects layout differs: " + selector)
    require(d.read("#projects-home-title") == "Projects" and d.read("#unified-home-updater #hub-update-title") == "Creator Hub update"
            and d.read("#view-projects", "attribute/aria-busy") == "false", "Projects/updater UI is not ready")
    require(len(d.elements("#project-list .project-row")) == 2
            and len(d.elements('#project-list .project-row[data-mcp-selected="true"]')) == 1
            and len(d.elements("#project-list .project-selected")) == 1, "Project list duplicated or selected project is ambiguous")
    rows = []
    for selected, name in ((True, "current-project"), (False, "missing-project")):
        selector = '#project-list .project-row[data-mcp-selected="' + str(selected).lower() + '"]'
        require(d.read(selector, "displayed") is True and d.read(selector + " .project-info small") == str(home / name), "Visible saved project differs")
        require(d.read(selector + " .project-bridge-warning") == "MCP bridge not installed"
                and d.read(selector + " .project-bridge-warning", "displayed") is True, "Actual bridge badge does not match protected project files")
        if selected:
            require(d.read(selector + " .project-selected") == "Selected for MCP"
                    and d.read(selector + " .project-selected", "displayed") is True, "Selected project badge is not visible")
        require(d.read(selector, "css/display") == "flex" and d.read(selector, "css/padding-top") == "14px"
                and d.read(selector, "css/padding-bottom") == "14px"
                and d.read(selector + " .project-tags", "css/font-size") == "11px", "Actual compact Projects styling differs")
        rect = d.read(selector, "rect")
        keys(rect, ("x", "y", "width", "height"))
        require(all(type(v) in (int, float) and math.isfinite(v) for v in rect.values())
                and rect["width"] > 0 and rect["height"] > 0, "Project row is blank or unbounded")
        rows.append({"selected": selected, "project": name, "bridge": "MCP bridge not installed", "rect": rect})
    first, second = sorted(rows, key=lambda row: row["rect"]["y"])
    require(first["rect"]["y"] + first["rect"]["height"] <= second["rect"]["y"], "Native project rows overlap")
    require(not d.elements("iframe,object,embed") and len(d.call("GET", "/window/handles")) == 1, "A separate module document/window appeared")
    return {"platform": "Linux", "product": "Creator Hub", "version": "0.1.16", "compactProjects": True, "rows": rows}


def diagnostic_event(event, metadata=None):
    # Independent of the session receipt lock: a stalled guard must not block
    # this one bounded, best-effort write to the already captured stderr pipe.
    try:
        raw = json.dumps({"migrationDiagnostic": event, "diagnosticOnly": True, "authorityGranted": False,
                          "releaseReady": False, **(metadata or {})}, separators=(",", ":"), allow_nan=False).encode() + b"\n"
        if len(raw) <= 4096 and select.select([], [2], [], 0)[1]:
            os.write(2, raw)
    except Exception:
        pass


class ProjectsDiagnostic:
    def __init__(self, enabled):
        self.enabled, self.timer, self.active = enabled, None, False

    def __enter__(self):
        if self.enabled:
            try:
                require(threading.current_thread() is threading.main_thread(), "Only own main thread stack")
                self.ident, self.started = threading.main_thread().ident, time.monotonic()
                self.active = True
                diagnostic_event("projects-entered")
                self.timer = threading.Timer(10, self.capture)
                self.timer.daemon = True
                self.timer.start()
            except Exception as error:
                diagnostic_event("projects-stack-unavailable", {"errorType": type(error).__name__[:80]})
        return self

    def capture(self):
        frame = None
        try:
            if not self.active:
                return
            frame = sys._current_frames().get(self.ident)
            require(frame is not None, "Own main frame unavailable")
            rows = []
            for _ in range(16):
                if frame is None:
                    break
                name, function = Path(frame.f_code.co_filename).name, frame.f_code.co_name
                known = name in SOURCES or name in ("threading.py", "socket.py", "selectors.py", "request.py", "client.py", "select.py")
                rows.append({"source": name if known else "redacted",
                             "function": function if known and re.fullmatch(r"[A-Za-z_<>][A-Za-z0-9_<>.]{0,79}", function) else "redacted",
                             "line": min(1000000, max(0, frame.f_lineno))})
                frame = frame.f_back
            if self.active:
                diagnostic_event("projects-main-stack", {"pid": os.getpid(), "mainThreadIdent": self.ident,
                    "elapsedMs": min(86400000, max(0, int((time.monotonic() - self.started) * 1000))),
                    "frames": rows, "framesTruncated": frame is not None})
        except Exception as error:
            diagnostic_event("projects-stack-unavailable", {"errorType": type(error).__name__[:80]})
        finally:
            del frame

    def __exit__(self, kind, error, traceback):
        if self.enabled:
            self.active = False
            try:
                if self.timer is not None:
                    self.timer.cancel()
            except Exception as capture_error:
                diagnostic_event("projects-stack-cancel-unavailable", {"errorType": type(capture_error).__name__[:80]})
            diagnostic_event("projects-completed" if kind is None else "projects-failed",
                             {} if kind is None else {"errorType": kind.__name__[:80]})
        return False


def finish_ui(session, scenario, *, reopened=False):
    d, pages = session.d, session.pages
    session.checkpoint("finish-ui")
    if reopened:
        if d.elements("#convergence-dialog") and d.read("#convergence-dialog", "attribute/open") is not None:
            require(scenario != SCENARIOS[3], "Completed migration guide reopened")
            pages.wait(lambda: d.read("#convergence-dialog", "attribute/aria-busy") == "false")
            d.click("#convergence-later")
    else:
        pages.wait(lambda: d.read("#convergence-dialog", "attribute/aria-busy") == "false", 45)
        if scenario == SCENARIOS[3]:
            require(d.read("#convergence-title") == "Move complete", "Full approval was not reported complete")
        elif scenario != SCENARIOS[0]:
            require("cancel" in d.read("#convergence-error").lower() and d.read("#convergence-title") != "Move complete",
                    "System cancellation was hidden or falsely completed")
        d.click("#convergence-later")
    pages.wait(lambda: d.read("#convergence-dialog", "attribute/open") is None)
    session.checkpoint("projects-wait")
    with ProjectsDiagnostic(not reopened):
        pages.wait(lambda: d.read("#view-projects", "attribute/aria-busy") == "false")
        # Synthetic projects deliberately declare no SDK. Use the existing native
        # filter action, rather than pretending an SDK or bridge was installed.
        if d.read("#project-sdk", "property/value") != "all":
            d.click('#project-sdk option[value="all"]')
        pages.wait(lambda: bool(d.elements('#project-list .project-row[data-mcp-selected="true"]')))
        session.evidence["home"] = home_observation(d, BASE / "result/home")
    session.checkpoint("home-observed")
    session.guard()
    folder = session.root / "home-bitmap"
    folder.mkdir(mode=0o700)
    bitmap = session.native.bitmap(session.request, folder, session.helper, session.x11)
    session.guard()
    require(bitmap["nonblank"] is True and bitmap["windowOnly"] is True
            and bitmap["xid"] == session.request.window and bitmap["xres"] == session.xres, "Exact owned home pixels required")
    png = read_file(folder / "root-window.png", 16 * 1024 * 1024, uid=UID, mode=0o600)
    require(len(png) == bitmap["image"]["size"] and digest(png) == bitmap["image"]["sha256"], "Owned home bitmap bytes changed")
    dimensions = pages.png_dimensions(png)
    require(dimensions == (bitmap["width"], bitmap["height"]) == tuple(bitmap["rectangle"][2:]), "Owned home bitmap geometry differs")
    P.write(session.root / "home.png", png)
    require(read_file(session.root / "home.png", 16 * 1024 * 1024, uid=UID, mode=0o600) == png, "Retained home bitmap bytes changed")
    session.evidence["homeScreenshot"] = {"size": len(png), "sha256": digest(png), "dimensions": dimensions, "nativeBitmap": bitmap}


def batch_outcome(home, scenario):
    path = home / "data/CreatorHub/convergence/move-v1.json"
    if scenario == SCENARIOS[0]:
        require(not path.exists(), "Guide cancellation wrote the migration batch")
        return
    value = P.parse(read_file(path, 8192, uid=UID))
    keys(value, ("policy", "phase", "outcome", "review_key", "retry_blocked"))
    require(type(value["policy"]) is int and value["policy"] == 1 and value["phase"] == "cleanup"
            and re.fullmatch(r"[a-f0-9]{64}", value["review_key"])
            and value["outcome"] == ("complete" if scenario == SCENARIOS[3] else "stopped"), "Durable cleanup outcome differs")
    if scenario != SCENARIOS[3]:
        require(value["retry_blocked"] is True, "Interrupted cleanup permits automatic batch replay")


def secure_ancestry():
    rows = []
    for name in ("/", "/usr", "/opt", "/usr/share", "/usr/share/polkit-1", "/usr/share/polkit-1/actions"):
        file = Path(name); before = file.lstat()
        require(file.resolve() == file and stat.S_ISDIR(before.st_mode) and before.st_uid == before.st_gid == 0, "Ordinary root-owned fixture ancestry required")
        allowed = (0o755,) if name in ("/", "/usr") else (0o755, 0o777)
        require(stat.S_IMODE(before.st_mode) in allowed, "Unknown hosted-runner mode; no recursive repair")
        if stat.S_IMODE(before.st_mode) == 0o777:
            os.chmod(file, 0o755)
        after = file.lstat()
        require((before.st_dev, before.st_ino, before.st_uid, before.st_gid) == (after.st_dev, after.st_ino, 0, 0)
                and stat.S_IMODE(after.st_mode) == 0o755, "Fixture ancestry identity changed")
        rows.append({"path": name, "before": stat.S_IMODE(before.st_mode), "after": 0o755})
    return rows


def protected_sources(env):
    require(HERE == BASE / "scripts", "Only fixed root-installed controller may run a session")
    binding = P.parse(read_file(BASE / "source-binding.json", 32768, uid=0, mode=0o644))
    keys(binding, ("harnessSource", "files"))
    require(binding["harnessSource"] == env["GITHUB_SHA"] and set(binding["files"]) == set(SOURCES), "Harness source binding differs")
    for name, pin in binding["files"].items():
        raw = read_file(HERE / name, uid=0, mode=0o644)
        require(len(raw) == pin["size"] and digest(raw) == pin["sha256"], "Protected controller/neutral source changed")
    for file in (BASE, HERE):
        for ancestor in (file, *file.parents):
            info = ancestor.lstat()
            require(ancestor.resolve() == ancestor and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o7022,
                    "Controller ancestor is not root-protected")


def fixture_directory_row(path, info):
    return {"path": path, "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode),
            "type": "directory" if stat.S_ISDIR(info.st_mode) else "other", "dev": info.st_dev,
            "ino": info.st_ino, "nlink": info.st_nlink}


def harden_fixture_directory(path, original):
    require(path in CI_SHARED_DIRECTORIES, "Only fixed CI shared directories may be hardened")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    handles = []
    try:
        parent = None
        for part in ("/", *PurePosixPath(path).parts[1:]):
            fd = os.open(part, flags, **({"dir_fd": parent} if parent is not None else {}))
            try:
                current = os.fstat(fd)
            except Exception:
                os.close(fd)
                raise
            handles.append((fd, parent, part, current))
            parent = fd
        leaf = handles[-1][3]
        require((leaf.st_dev, leaf.st_ino) == (original.st_dev, original.st_ino), "CI directory inode changed before opening")
        def verify(mode):
            for index, (fd, parent, part, before) in enumerate(handles):
                current = os.fstat(fd)
                named = os.stat(part, dir_fd=parent, follow_symlinks=False) if parent is not None else os.lstat("/")
                require(stat.S_ISDIR(current.st_mode) and stat.S_ISDIR(named.st_mode)
                        and current.st_uid == current.st_gid == named.st_uid == named.st_gid == 0
                        and (current.st_dev, current.st_ino) == (before.st_dev, before.st_ino) == (named.st_dev, named.st_ino)
                        and stat.S_IMODE(current.st_mode) == stat.S_IMODE(named.st_mode) == (mode if index == len(handles) - 1 else 0o755),
                        "CI directory alias, ownership, mode or inode changed")
        verify(stat.S_IMODE(original.st_mode))
        if stat.S_IMODE(original.st_mode) == 0o777:
            os.fchmod(handles[-1][0], 0o755)
        verify(0o755)
    finally:
        for fd, _, _, _ in reversed(handles):
            os.close(fd)


def harden_fixture_directories(env, *, paths=CI_SHARED_DIRECTORIES):
    require(type(paths) is tuple and paths == CI_SHARED_DIRECTORIES, "No CI directory path overrides")
    admission(env)
    require(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0
            and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "Exact root checkout fixture broker required")
    base = BASE.lstat()
    require(BASE.resolve() == BASE and stat.S_ISDIR(base.st_mode) and base.st_uid == base.st_gid == 0
            and stat.S_IMODE(base.st_mode) == 0o755, "Fresh protected CI fixture base required")
    before_file, after_file = BASE / "fixture-directory-hardening-before.json", BASE / "fixture-directory-hardening-after.json"
    require(not any(os.path.lexists(file) for file in (before_file, after_file, BASE / "result")), "CI hardening cannot reuse an existing fixture phase")
    raw = read_file(BASE / "binding.json", 1048576, uid=0, mode=0o644)
    check_request(P.parse(read_file(BASE / "execution-request.json", 16384, uid=0, mode=0o644)), env, raw)
    source = P.parse(read_file(BASE / "source-binding.json", 32768, uid=0, mode=0o644))
    require(source["harnessSource"] == env["GITHUB_SHA"] and set(source["files"]) == set(SOURCES), "Fresh CI source binding required")
    originals = {path: os.lstat(path) for path in paths}
    proof = {"schemaVersion": 1, "scope": "disposable-ci-shared-directory-hardening-only", "harnessSource": env["GITHUB_SHA"], **FLAGS}
    save(before_file, {**proof, "directories": [fixture_directory_row(path, info) for path, info in originals.items()]})
    completed, failure = [], None
    try:
        require(all(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
                    and stat.S_IMODE(info.st_mode) in (0o755, 0o777) for info in originals.values()), "Unknown CI shared-directory type, owner or mode")
        for path in paths:
            harden_fixture_directory(path, originals[path])
            completed.append(path)
    except Exception as error:
        failure = error
        raise
    finally:
        rows = []
        for path in paths:
            try:
                rows.append(fixture_directory_row(path, os.lstat(path)))
            except OSError as error:
                rows.append({"path": path, "error": type(error).__name__, "errno": error.errno})
        save(after_file, {**proof, "completed": failure is None and len(completed) == len(paths), "completedPaths": completed,
                          "failureType": type(failure).__name__ if failure else None, "directories": rows})


def install_fixture(env):
    require(os.getuid() == os.geteuid() == 0 and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "Root broker must start in the exact checked-out source")
    temp = Path(env["RUNNER_TEMP"])
    require(temp.resolve() == temp, "Canonical original runner temp required")
    request_path = temp / "native-linux-production-016-migration-request.json"
    raw = read_file(temp / "native-linux-production-016-stage/binding.json", mode=0o600)
    binding = P.parse(raw)
    request = P.parse(read_file(request_path, 16384, uid=request_path.parent.stat().st_uid, mode=0o600))
    scenario = check_request(request, env, raw)
    require(not os.path.lexists(BASE), "Fresh fixed fixture base required; no adoption/cleanup")
    for package, executable in (("creator-hub", HUB), ("creator-works-mcp", "/usr/bin/creator-works-mcp-launcher"), ("creator-project-setup", "/usr/bin/creator-project-setup")):
        result = subprocess.run(["/usr/bin/dpkg-query", "-W", "-f=${Status}", package], capture_output=True, check=False)
        require(result.returncode == 1 and not result.stdout and not os.path.lexists(executable), "Pre-existing package refused; never restore packages between scenarios")
    ancestry = secure_ancestry()
    BASE.mkdir(mode=0o755)
    for name in ("scripts", "inputs", "bin", "sdk"):
        (BASE / name).mkdir(mode=0o755)
    source_pins = {}
    for name in SOURCES:
        body = read_file(HERE / name)
        P.write(BASE / "scripts" / name, body, 0o644)
        source_pins[name] = {"size": len(body), "sha256": digest(body)}
    save(BASE / "source-binding.json", {"harnessSource": env["GITHUB_SHA"], "files": source_pins}, 0o644)
    P.write(BASE / "binding.json", raw, 0o644)
    save(BASE / "execution-request.json", request, 0o644)
    save(BASE / "ancestry.json", {"disposableRunnerOnly": True, "directories": ancestry}, 0o644)
    driver = read_file(temp / "native-linux-production-016-driver/bin/tauri-driver", 64 * 1024 * 1024, mode=0o755)
    P.write(BASE / "bin/tauri-driver", driver, 0o755)
    save(BASE / "driver.json", {"size": len(driver), "sha256": digest(driver)}, 0o644)
    source = Path(env["GITHUB_WORKSPACE"]) / "modules/mcp"
    require(digest(read_file(source / "package-lock.json", 2 * 1024 * 1024)) == SDK_LOCK, "Independent SDK lock changed")
    for name in ("package.json", "package-lock.json"):
        P.write(BASE / "sdk" / name, read_file(source / name, 2 * 1024 * 1024), 0o644)
    modules = source / "node_modules"
    require(modules.resolve() == modules and modules.is_dir(), "Declared npm-ci SDK dependency tree required")
    count, total = 0, 0
    for file in modules.rglob("*"):
        relative = file.relative_to(modules)
        if ".bin" in relative.parts:
            continue
        require(not file.is_symlink(), "Linked SDK inputs refused")
        destination = BASE / "sdk/node_modules" / relative
        if file.is_dir():
            destination.mkdir(mode=0o755, parents=True, exist_ok=True)
            continue
        body = read_file(file, 16 * 1024 * 1024)
        count += 1; total += len(body)
        require(count <= 20000 and total <= 256 * 1024 * 1024, "SDK tool source inventory exceeds bound")
        destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        P.write(destination, body, 0o644)
    for name, source_path, pin in (("mcp.deb", temp / "native-linux-production-016-input/mcp.deb", {"size": P.S.LEGACY["mcp"][0], "sha256": P.S.LEGACY["mcp"][1]}),
                                   ("setup.deb", temp / "native-linux-production-016-input/setup.deb", {"size": P.S.LEGACY["setup"][0], "sha256": P.S.LEGACY["setup"][1]}),
                                   ("hub.deb", temp / "native-linux-production-016-stage/deb.deb", binding["profile"]["pins"]["deb"])):
        body = read_file(source_path, 256 * 1024 * 1024, mode=0o600)
        require(len(body) == pin["size"] and digest(body) == pin["sha256"], "Package changed before root-owned handoff")
        P.write(BASE / "inputs" / name, body, 0o600)
    # No maintainer scripts are added by this harness. The inspected Hub and
    # independently pinned original public DEBs are installed once, in order.
    save(BASE / "legacy-files.json", {product: legacy_inventory(BASE / "inputs" / (product + ".deb"), product) for product in ("mcp", "setup")}, 0o644)
    harden_fixture_directories(env)
    tool(["/usr/bin/dpkg", "--install", str(BASE / "inputs/mcp.deb"), str(BASE / "inputs/setup.deb"), str(BASE / "inputs/hub.deb")])
    installed(binding)
    import pwd
    import grp
    for reader, key in ((pwd.getpwnam, USER), (pwd.getpwuid, UID), (grp.getgrnam, USER), (grp.getgrgid, UID)):
        try:
            reader(key)
        except KeyError:
            continue
        raise RuntimeError("Pre-existing synthetic account/group refused")
    tool(["/usr/sbin/useradd", "--uid", str(UID), "--user-group", "--create-home", "--home-dir", "/var/lib/creator-polkit-fixture",
          "--shell", "/bin/bash", "--groups", "sudo", USER])
    (BASE / "result").mkdir(mode=0o700); os.chown(BASE / "result", UID, UID)
    return binding, scenario


def session_command(env):
    # Headless matrix 39487763403: exec+PAM timed out; simple+PAM exited zero.
    # Retain PAM and independent kernel/UID proofs; the FD mechanism is unproven.
    values = {key: env[key] for key in ENVIRONMENT}
    values.update(HOME=str(BASE / "result/home"), USER=USER, RUNNER_TEMP=str(BASE / "result"),
                  XDG_RUNTIME_DIR=str(BASE / "result/runtime"), LANG="C", LC_ALL="C", GDK_BACKEND="x11", NO_AT_BRIDGE="0")
    return ["/usr/bin/systemd-run", "--wait", "--pipe", "--collect", "--unit=creator-production-migration-016-fixture",
            "--uid=" + USER, "--property=PAMName=login", "--property=Type=simple", "--property=LimitCORE=0", "--property=WorkingDirectory=" + str(BASE),
            *("--setenv=" + key + "=" + value for key, value in values.items()),
            "/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a", "--server-args=-screen 0 1280x1000x24",
            "/usr/bin/python3", "-B", str(BASE / "scripts" / Path(__file__).name), "session"]


def wipe(value):
    if value is not None:
        value[:] = b"\0" * len(value)


def capture_wrapper(record, child, logs, started, deadline):
    value = {"diagnosticOnly": True, "authorityGranted": False, "releaseReady": False, "drainPumps": 0}
    record["sessionWrapper"] = value
    try:
        now = time.monotonic()
        value.update(pid=child.pid, returnCode=child.poll(),
                     elapsedMs=None if started is None else max(0, min(86400000, int((now - started) * 1000))),
                     deadlineExpired=None if deadline is None else now >= deadline,
                     remainingMs=None if deadline is None else max(0, min(540000, int((deadline - now) * 1000))))
        # Only drain owned output after exit, never extend a live session's wait
        # or run another input/guard. Preserve EOF=false if descendants hold pipes.
        if value["returnCode"] is not None and logs is not None:
            until = time.monotonic() + 1
            try:
                for _ in range(16):
                    if time.monotonic() >= until or all(row["eof"] for row in logs.metadata().values()):
                        break
                    value["drainPumps"] += 1
                    logs.pump(0.05)
            except Exception as error:
                value["drainErrorType"] = type(error).__name__[:80]
        try:
            metadata = logs.metadata()
            pipes = {}
            for name in ("stdout", "stderr"):
                row = metadata[name]
                require(all(type(row[key]) is int and 0 <= row[key] <= 16777216 for key in ("bytes", "retainedBytes"))
                        and all(type(row[key]) is bool for key in ("eof", "truncated")), "Bounded pipe metadata required")
                pipes[name] = {key: row[key] for key in ("bytes", "retainedBytes", "eof", "truncated")}
            value["pipes"] = pipes
            value["pipeClosed"] = {name: getattr(child, name).closed is True for name in ("stdout", "stderr")}
        except Exception as error:
            value["pipeErrorType"] = type(error).__name__[:80]
    except Exception as error:
        value["errorType"] = type(error).__name__[:80]
    diagnostic_event("wrapper-observed", value)


UNIT_NAME = "creator-production-migration-016-fixture.service"
UNIT_PROPERTIES = ("Id", "LoadState", "Transient", "MainPID", "ExecMainPID", "User", "PAMName",
    "ActiveState", "SubState", "Result", "Type", "TimeoutStartUSec", "TimeoutStopUSec", "RuntimeMaxUSec", "WatchdogUSec",
    "ExecMainCode", "ExecMainStatus", "ExecMainStartTimestamp", "ExecMainStartTimestampMonotonic",
    "ExecMainExitTimestamp", "ExecMainExitTimestampMonotonic", "InvocationID", "ControlGroup")


def unit_tool_pin(name):
    require(name in ("systemctl", "systemd-run"), "Fixed unit diagnostic tools only")
    file = Path("/usr/bin") / name
    for entry in (file, *file.parents):
        info = entry.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode), "Unprotected unit diagnostic tool")
    return digest(read_file(file, 16 * 1024 * 1024, uid=0, mode=0o755))


def unit_command(kind):
    require(kind in ("unit", "version"), "Fixed read-only unit diagnostic operation required")
    pin = unit_tool_pin("systemctl")
    command = ["/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", "show", "--all",
               "--property=" + (",".join(UNIT_PROPERTIES) if kind == "unit" else "Version")]
    if kind == "unit": command.append(UNIT_NAME)
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd=BASE, env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
    streams, output = [child.stdout, child.stderr], {child.stdout: bytearray(), child.stderr: bytearray()}
    try:
        for stream in streams: os.set_blocking(stream.fileno(), False)
        deadline = time.monotonic() + 2
        while (streams or child.poll() is None) and time.monotonic() < deadline:
            for stream in select.select(streams, [], [], min(0.02, max(0, deadline - time.monotonic())))[0]:
                raw = os.read(stream.fileno(), min(4096, 16385 - len(output[stream])))
                output[stream].extend(raw)
                require(len(output[stream]) <= 16384, "Unit diagnostic output exceeds bound")
                if not raw: streams.remove(stream)
        require(not streams and child.poll() == 0, "Unit diagnostic unavailable or deadline")
        require(unit_tool_pin("systemctl") == pin, "Unit diagnostic tool changed")
        return bytes(output[child.stdout])
    finally:
        # Never signal the unit, wrapper or even this diagnostic child. A hung
        # read-only client is unavailable and left to disposable runner teardown.
        child.stdout.close(); child.stderr.close()


def unit_properties(raw):
    require(type(raw) is bytes and len(raw) <= 16384, "Bounded unit properties required")
    try: lines = raw.decode("ascii").splitlines()
    except UnicodeError: raise RuntimeError("Non-ASCII unit properties") from None
    values = {}
    for line in lines:
        name, separator, value = line.partition("=")
        require(separator and name in UNIT_PROPERTIES and name not in values and len(value) <= 4096
                and all(32 <= ord(c) < 127 for c in value), "Unknown/duplicate/malformed unit property")
        values[name] = value
    keys(values, UNIT_PROPERTIES)
    return values


class UnitDiagnostics:
    def __init__(self, record, native, helper):
        self.native, self.helper, self.sealed = native, helper, None
        self.attempted, self.last_sample = set(), -1
        self.data = {"diagnosticOnly": True, "authorityGranted": False, "releaseReady": False, "snapshots": [],
                     "managerVersion": {"status": "unavailable"}}
        record["unitDiagnostics"] = self.data

    def process(self, pid, uid):
        require(type(pid) is int and 1 < pid < 2**22, "Bounded diagnostic actor required")
        value = self.native.native_process(pid, self.helper)
        require(value["uids"] == [uid] * 4 and int(value["image"]["st_uid"]) == 0
                and int(value["image"]["st_gid"]) == 0 and int(value["image"]["st_mode"]) == 0o100755,
                "Unit actor credentials/image protection differ")
        require(value["kernelImageSha256"] == digest(read_file(Path(value["executable"]), 64 * 1024 * 1024, uid=0, mode=0o755)),
                "Unit actor differs from protected named image")
        return value

    def capture(self, phase, child, state=None):
        if phase not in ("initial", "projects-entry", "terminal") or phase in self.attempted or len(self.attempted) >= 3:
            return
        if phase == "terminal":
            for missed in ("initial", "projects-entry"):
                if missed not in self.attempted:
                    self.attempted.add(missed)
                    self.data["snapshots"].append({"phase": missed, "status": "unavailable", "bindingVerified": False,
                                                   "stage": "boundary-not-observed"})
        self.attempted.add(phase)
        row = {"phase": phase, "status": "unavailable", "bindingVerified": False}
        self.data["snapshots"].append(row)
        stage = "unit-read-before"
        try:
            row["wrapperReturnCode"] = child.poll()
            before = unit_properties(unit_command("unit")); row["before"] = before
            require(before["Id"] == UNIT_NAME and before["LoadState"] == "loaded" and before["Transient"] == "yes"
                    and before["User"] == USER and before["PAMName"] == "login"
                    and re.fullmatch(r"[a-f0-9]{32}", before["InvocationID"]) and before["InvocationID"] != "0" * 32,
                    "Unknown/collected unit identity")
            if self.sealed is None:
                stage = "initial-wrapper-binding"
                require(phase == "initial" and child.poll() is None and type(state) is dict, "Initial owned unit binding unavailable")
                wrapper = self.process(child.pid, 0)
                row["wrapperObserved"] = wrapper
                require(wrapper["parentPid"] == os.getpid() and wrapper["executable"] == "/usr/bin/systemd-run"
                        and wrapper["kernelImageSha256"] == unit_tool_pin("systemd-run"), "Original unit wrapper differs")
                stage = "unit-main-binding"
                main = self.process(int(before["MainPID"]), UID)
                row["mainObserved"] = main
                require(before["ExecMainPID"] == str(main["pid"]) and main["executable"] == "/usr/bin/dbus-run-session"
                        and int(main["startTime"]) >= int(wrapper["startTime"]), "Unit main process differs")
                stage = "session-driver-binding"
                driver = self.process(state["driver"]["pid"], UID)
                pin = P.parse(read_file(BASE / "driver.json", uid=0, mode=0o644))
                require(driver == state["driver"] and driver["executable"] == str(BASE / "bin/tauri-driver")
                        and driver["kernelImageSha256"] == pin["sha256"], "Unit session driver differs")
                stage = "session-supervisor-binding"
                supervisor = self.process(driver["parentPid"], UID)
                require(proc_bytes(Path(f"/proc/{supervisor['pid']}/cmdline"), 8192)
                        == b"/usr/bin/python3\0-B\0/opt/creator-polkit-fixture/scripts/native-linux-production-016-migration.py\0session\0",
                        "Fixed diagnostic session required")
                stage = "session-ancestry-binding"
                chain, seen, actor = [], set(), supervisor
                for _ in range(8):
                    require(actor["pid"] not in seen, "Cyclic diagnostic ancestry")
                    seen.add(actor["pid"]); chain.append(actor)
                    if actor["pid"] == main["pid"]: break
                    actor = self.process(actor["parentPid"], UID)
                require(chain[-1] == main, "Unit main is not the owned session ancestor")
                sealed = {"invocation": before["InvocationID"], "wrapper": wrapper, "main": main, "chain": chain, "driver": driver}
            else:
                stage = "sealed-invocation-binding"
                sealed = self.sealed
                require(before["InvocationID"] == sealed["invocation"] and before["ExecMainPID"] == str(sealed["main"]["pid"]),
                        "Unit invocation/main changed")
            stage = "unit-read-after"
            after = unit_properties(unit_command("unit")); row["after"] = after
            identity = ("Id", "LoadState", "Transient", "MainPID", "ExecMainPID", "User", "PAMName", "InvocationID", "ControlGroup")
            require(all(before[key] == after[key] for key in identity), "Unit identity changed during capture")
            stage = "kernel-binding-recheck"
            if child.poll() is None:
                require(self.process(child.pid, 0) == sealed["wrapper"], "Owned wrapper changed")
            if before["MainPID"] != "0":
                require(before["MainPID"] == str(sealed["main"]["pid"])
                        and all(self.process(actor["pid"], UID) == actor for actor in sealed["chain"]), "Owned unit ancestry changed")
            else:
                require(phase == "terminal" and self.sealed is not None and child.poll() is not None, "Unproved unit main exit")
            self.sealed = sealed
            row.update(status="captured", bindingVerified=True, wrapper=sealed["wrapper"], main=sealed["main"], ancestry=sealed["chain"])
        except Exception as error:
            row.update(stage=stage, errorType=type(error).__name__[:80])
        if phase == "initial":
            try:
                raw = unit_command("version")
                require(len(raw) <= 256 and re.fullmatch(rb"Version=[A-Za-z0-9_.+(): -]{1,200}\n", raw), "Bounded manager version required")
                self.data["managerVersion"] = {"status": "captured", "value": raw.decode("ascii")[8:-1]}
            except Exception as error:
                self.data["managerVersion"] = {"status": "unavailable", "errorType": type(error).__name__[:80]}

    def poll(self, child):
        if "projects-entry" in self.attempted:
            return
        try:
            file = BASE / "result/first/session.json"
            if not file.exists(): return
            state = P.parse(read_file(file, 65536, uid=UID, mode=0o600))
            if type(state.get("driver")) is not dict: return
            if "initial" not in self.attempted: self.capture("initial", child, state)
            if state.get("progress", {}).get("boundary") in ("projects-wait", "home-observed"):
                self.capture("projects-entry", child, state)
        except Exception as error:
            self.data.setdefault("observationUnavailable", {"errorType": type(error).__name__[:80]})


def broker(env):
    scenario = admission(env)
    require(os.getuid() == os.geteuid() == 0, "Root fixture broker only")
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    binding, scenario = install_fixture(env)
    pages, helper, native, polkit = neutral()
    # These unchanged primitives enforce the stock independent Ubuntu hashes,
    # ordinary admin mapping and fixed synthetic credential tool/account.
    polkit.verify_files(BASE)
    polkit.admin_config()
    polkit.credential_tools(BASE)
    require(polkit.fixture_credential("status") == "L", "Fresh locked synthetic account required")
    secret = payload = logs = child = None
    record = {"scope": "production-016-disposable-migration", "scenario": scenario, "harnessSource": env["GITHUB_SHA"],
              "inputProofs": 0, "fixtureRelocked": False, "scenarioPassed": False, **FLAGS}
    context, relock, failure = {}, False, None
    wrapper_started, deadline = None, None
    inventory_state = {"sequence": 1, "nonces": set()}
    unit_diagnostics = UnitDiagnostics(record, native, helper)
    try:
        if scenario in SCENARIOS[2:]:
            secret = bytearray(secrets.token_hex(32).encode("ascii"))
            relock = True
            polkit.fixture_credential("provision", secret)
            require(polkit.fixture_credential("status") == "P", "Synthetic provisioning failed")
            payload = bytearray(secret + b"\n")
        wrapper_started = time.monotonic()
        child = subprocess.Popen(session_command(env), stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=BASE,
                                 env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
        logs = native.Capture(child, BASE, "session")
        if payload is not None:
            require(child.stdin.write(payload) == 65, "Synthetic credential pipe delivery uncertain")
            child.stdin.close(); wipe(payload); wipe(secret)
        index, deadline = 1, time.monotonic() + 540
        while child.poll() is None and time.monotonic() < deadline:
            logs.pump()
            require(not any(row["truncated"] for row in logs.metadata().values()), "Session diagnostic capture exceeded bound")
            serve_inventory(inventory_state, record, env["GITHUB_SHA"], scenario, native, helper)
            if record.get("inventorySamples", 0) != unit_diagnostics.last_sample:
                unit_diagnostics.last_sample = record.get("inventorySamples", 0)
                unit_diagnostics.poll(child)
            request = BASE / f"result/input-{index}.json"
            if request.exists():
                value = P.parse(read_file(request, 256, uid=UID, mode=0o600))
                proof_request(value, scenario)
                require(value["index"] == index, "Input proof sequence changed")
                proof = observe_request(value, context, binding, helper, native, polkit)
                if value["target"] == "mcp":
                    context["mcpDiagnosticProof"] = (index, copy.deepcopy(proof))
                publish(BASE / f"input-{index}.json", {"request": value, "ok": True, "proof": proof})
                os.chmod(BASE / f"input-{index}.json", 0o644)
                index += 1
                record["inputProofs"] += 1
            serve_helper_diagnostics(context, record, env, binding, native, helper)
            time.sleep(0.05)
        capture_wrapper(record, child, logs, wrapper_started, deadline)
        require(child.poll() == 0, "Synthetic session failed/unknown; no signal or retry requested")
        result = P.parse(read_file(BASE / "result/report.json", 1048576, uid=UID, mode=0o600))
        require(result["scenario"] == scenario and result["harnessSource"] == env["GITHUB_SHA"] and result["scenarioPassed"] is True
                and all(result[k] is False for k in FLAGS), "Independent session result incomplete")
        require((record["inputProofs"] == 0) == (scenario == SCENARIOS[0]), "Authorization request count differs")
        record["scenarioPassed"] = True
    except Exception as error:
        failure = error
        record["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        if type(error) is InventoryDirectoryRefusal:
            record["inventorySnapshotRefusal"] = error.observation
        if "sessionWrapper" not in record:
            capture_wrapper(record, child, logs, wrapper_started, deadline)
        try:
            record["failedProcessAttribution"] = failed_process_attribution(child, helper)
        except Exception as capture_error:
            record["failedProcessAttribution"] = {"status": "unknown", "readOnly": True, "validationAuthority": False,
                                                  "error": {"type": type(capture_error).__name__}}
    finally:
        wipe(secret); wipe(payload)
        unit_diagnostics.capture("terminal", child)
        serve_helper_diagnostics(context, record, env, binding, native, helper)
        if logs is not None:
            try:
                logs.pump()
                record["logs"] = logs.metadata()
                require(not any(row["truncated"] for row in record["logs"].values()), "Session diagnostic capture exceeded bound")
            except Exception:
                failure = failure or RuntimeError("Session diagnostic capture refused")
                record["captureRefused"] = True
            finally:
                try:
                    logs.close()
                except Exception:
                    failure = failure or RuntimeError("Session capture close refused")
        try:
            if relock:
                polkit.fixture_credential("lock")
            require(polkit.fixture_credential("status") == "L", "Synthetic relock not proven")
            record["fixtureRelocked"] = True
        except Exception:
            failure = failure or RuntimeError("Synthetic relock refused; disposable teardown required")
            record["relockRefusal"] = True
        if failure is not None:
            record["scenarioPassed"] = False
            record["recovery"] = "unknown-no-retry-disposable-runner-teardown"
        save(BASE / "broker.json", record, 0o644)
    require(failure is None, "Disposable migration broker refused; retain original reports")


def run_session(env):
    scenario = admission(env)
    require(os.getuid() == os.geteuid() == UID, "Only fixed synthetic user may drive native input")
    protected_sources(env)
    binding_raw = read_file(BASE / "binding.json", 1048576, uid=0, mode=0o644)
    binding = P.parse(binding_raw)
    check_request(P.parse(read_file(BASE / "execution-request.json", 16384, uid=0, mode=0o644)), env, binding_raw)
    root, home = BASE / "result", BASE / "result/home"
    require(not os.path.lexists(home) and env.get("HOME") == str(home), "Fresh isolated fixture HOME required")
    before = fixture(root)
    save(root / "before.json", {name: {"size": len(raw), "sha256": digest(raw)} for name, raw in before.items()})
    for key, part in (("HOME", "home"), ("XDG_CONFIG_HOME", "home/config"), ("XDG_DATA_HOME", "home/data"),
                      ("XDG_CACHE_HOME", "home/cache"), ("XDG_RUNTIME_DIR", "runtime"), ("TMPDIR", "tmp")):
        env[key] = str(root / part); os.environ[key] = str(root / part)
    os.umask(0o077)
    secret = None
    pages, helper, native, polkit = neutral()
    import gi
    gi.require_version("Gdk", "3.0"); gi.require_version("Atspi", "2.0")
    from gi.repository import Gdk, Atspi, Gio, GLib
    Gdk.init([]); Atspi.set_timeout(1500, 1500)
    parent = native.native_process(os.getpid(), helper)
    system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    session_identity = polkit.session(system, os.getpid(), GLib)
    agent = subprocess.Popen([polkit.AGENT], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    agent_identity = native.native_process(agent.pid, helper)
    polkit.own_agent(agent, agent_identity, parent, helper)
    endpoint = None
    def agent_ready():
        nonlocal endpoint
        polkit.own_agent(agent, agent_identity, parent, helper)
        endpoint = polkit.agent_bus_identity(system, agent_identity, GLib)
        return endpoint is not None
    pages.wait(agent_ready)
    require(polkit.session(system, agent.pid, GLib)["object"] == session_identity["object"], "Agent logind session differs")
    wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wm_identity = native.native_process(wm.pid, helper)
    display = helper.X11()
    def wm_ready():
        require(wm.poll() is None and native.native_process(wm.pid, helper) == wm_identity, "Owned WM changed before mapping")
        return bool(display.property(display.x.XDefaultRootWindow(display.display), "_NET_SUPPORTING_WM_CHECK"))
    pages.wait(wm_ready); display.dispose()
    sdk_env = {"HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
               "XDG_CACHE_HOME": str(home / "cache"), "XDG_RUNTIME_DIR": str(root / "runtime"), "TMPDIR": str(root / "tmp"),
               "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "UNITY_PROJECT_PATH": str(home / "current-project"), "CREATOR_WORKS_TOOL_GROUPS": "none"}
    report = {"scenario": scenario, "harnessSource": env["GITHUB_SHA"], "bindingSha256": digest(binding_raw),
              "scenarioPassed": False, "normalReopenObserved": False, **FLAGS}
    session = old_sdk = None
    try:
        if scenario in SCENARIOS[2:]:
            secret = bytearray(sys.stdin.buffer.read(66))
            require(len(secret) == 65 and secret[-1] == 10 and re.fullmatch(b"[0-9a-f]{64}", secret[:-1]), "Exact synthetic credential pipe frame required")
            secret.pop()
        question = installed(binding)
        sdk_dir = root / "old-sdk"; sdk_dir.mkdir(mode=0o700)
        old_sdk = SDK(sdk_dir, Path(OLD_NODE), [OLD_SERVER], sdk_env)
        first = root / "first"; first.mkdir(mode=0o700)
        inventory = InventoryClient(env["GITHUB_SHA"], scenario)
        session = Session(first, binding, inventory=inventory)
        publish(root / "root.json", session.owned)
        require(polkit.session(system, session.owned["pid"], GLib)["object"] == session_identity["object"], "Root is not in the synthetic authentication session")
        pages.wait(lambda: session.d.read("#usage-terms-dialog", "attribute/open") is not None)
        accepted_after = time.time_ns() // 1000000
        session.d.click("#usage-terms-checkbox"); session.d.click("#usage-terms-continue")
        pages.wait(lambda: session.d.read("#usage-terms-dialog", "attribute/open") is None)
        terms = read_file(home / TERMS, 8192, uid=UID)
        consent = P.parse(terms)
        keys(consent, ("schemaVersion", "policyVersion", "acceptedAtMs"))
        require(consent["schemaVersion"] == 1 and consent["policyVersion"] == "2026-09-28-v1"
                and type(consent["acceptedAtMs"]) is int and accepted_after <= consent["acceptedAtMs"] <= time.time_ns() // 1000000, "Terms persistence differs")
        pages.wait(lambda: session.d.read("#convergence-dialog", "attribute/open") is not None)
        require(session.d.read("#convergence-title") == "Move to Hub" and session.d.read("#convergence-move", "enabled") is True, "Current single-guide action missing")
        baseline = journal(home)
        require(baseline == P.parse(before[JOURNAL]), "Unexpected pre-Move journal writes")
        authorizer = Authorization(session, agent, agent_identity, parent, endpoint, system, Atspi, GLib, question, [0], old_sdk, session_identity)
        def consent_action(approve):
            session.dialogs = {(session.owned["pid"], "Move to Hub")}
            session.d.guard = session.process_guard
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as worker:
                    click = worker.submit(session.d.click, "#convergence-move")
                    session.consent(approve)
                    click.result(timeout=20)
            finally:
                session.d.guard = session.guard
            session.dialogs.clear()
        def cancelled():
            preserved(home, before, transferred=False)
            require(journal(home) == baseline, "Guide cancellation wrote an MCP operation outcome")
        execute_scenario(scenario, consent_action, lambda target, approve: authorizer.act(target, approve, secret), cancelled,
                         lambda: session.review_connections(home, before, binding))
        report["authorization"] = authorizer.records
        finish_ui(session, scenario)
        if scenario == SCENARIOS[0]:
            current = observed_cancel_journal(baseline, before[JOURNAL], home, report, "first")
        else:
            current = observed_journal_delta(baseline, home, report, "first")
        preserved(home, before, transferred=scenario != SCENARIOS[0], binding=binding); batch_outcome(home, scenario)
        installed(binding, retention_state(scenario))
        report["oldRuntimeAfterMigration"] = old_sdk.check()
        report["first"] = session.evidence
        session.close(); session = None
        report["oldRuntimeAfterClose"] = old_sdk.check()
        expected_after = {name: read_file(home / name) for name in before if name != JOURNAL}
        second = root / "reopened"; second.mkdir(mode=0o700)
        session = Session(second, binding, reopened=True, inventory=inventory)
        require(read_file(home / TERMS) == terms and session.owned["pid"] != report["first"]["root"]["pid"], "Normal reopen or terms retention failed")
        session.checkpoint("reopen-terms")
        pages.wait(lambda: session.d.read("#usage-terms-dialog", "attribute/open") is None)
        finish_ui(session, scenario, reopened=True)
        if scenario == SCENARIOS[0]:
            observed_cancel_journal(baseline, before[JOURNAL], home, report, "reopened")
        else:
            observed_journal_delta(current, home, report, "reopened")
        for name, raw in expected_after.items():
            require(read_file(home / name) == raw, "Reopen repeated migration or changed settings: " + name)
        preserved(home, before, transferred=scenario != SCENARIOS[0], binding=binding); batch_outcome(home, scenario)
        installed(binding, retention_state(scenario))
        report["oldRuntimeAfterReopen"] = old_sdk.check()
        report["reopened"] = session.evidence
        session.close(); session = None
        commands = [(Path(OLD_NODE), [OLD_SERVER], "legacy-reconnect")]
        if scenario != SCENARIOS[0]:
            commands.append((route(home)[0], [], "managed-reconnect"))
        for command, args, name in commands:
            directory = root / name; directory.mkdir(mode=0o700)
            environment = sdk_env if str(command) == OLD_NODE else {**sdk_env, "CREATOR_WORKS_CONFIG_OWNER": "creator-hub-v1"}
            client = SDK(directory, command, args, environment)
            client.check(); client.close()
        old_sdk.close(); old_sdk = None
        report.update(normalReopenObserved=True, scenarioPassed=True)
    except Exception as error:
        report["refusal"] = {"type": type(error).__name__, "message": str(error)[:1500]}
        report["disposableTeardownRequired"] = True
        if session is not None:
            session.retain_failure(error)
            report["lastSession"] = session.evidence
            try:
                session.process_guard()
                report["failureUi"] = {name: session.d.read("#convergence-" + name)[:8192] for name in ("title", "error", "progress")}
            except Exception:
                report["captureRefused"] = True
        raise
    finally:
        wipe(secret)
        diagnostic_event("report-save-entered")
        try:
            save(root / "report.json", report)
        except Exception as error:
            diagnostic_event("report-save-failed", {"errorType": type(error).__name__[:80]})
            raise
        else:
            diagnostic_event("report-save-completed")
        # Unknown product/package outcomes are left for disposable runner teardown.
        if report["scenarioPassed"]:
            polkit.own_agent(agent, agent_identity, parent, helper)
            agent.terminate(); agent.wait(timeout=10)
            subprocess.run(["/usr/bin/openbox", "--exit"], stdin=subprocess.DEVNULL, check=True)
            wm.wait(timeout=10)


def main():
    env = dict(os.environ)
    admission(env)
    if sys.argv[1:] == []:
        require(os.getuid() > 0 and os.getuid() != UID, "Unprivileged workflow preparation only")
        temp = Path(env["RUNNER_TEMP"])
        require(temp.resolve() == temp, "Canonical runner temp required")
        raw = P.read_owned(temp / "native-linux-production-016-stage/binding.json", 1048576)
        save(temp / "native-linux-production-016-migration-request.json", execution_request(env, raw))
    elif sys.argv[1:] == ["broker"]:
        broker(env)
    elif sys.argv[1:] == ["session"]:
        run_session(env)
    else:
        raise RuntimeError("No execution path, scenario or command overrides")


if __name__ == "__main__":
    main()
