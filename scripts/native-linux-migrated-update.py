"""One same-runner migrated-HOME DEB update, never a fresh fixture or retry.

The original migration finishes and relocks its account before this controller
may adopt anything. Unbound successor inputs confer no execution authority.
Inputs are independently pinned original ZIPs; this module never downloads them.
"""
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BASE = Path("/opt/creator-polkit-fixture")
CONTROL, OUTPUT, HOME = BASE / "migrated-update", BASE / "result/migrated-update", BASE / "result/home"
INTENT = Path("/var/lib/creator-migrated-update-intent.json")
PRODUCT = "085131ba6f3050a795fd513139a34975658ba321"
PRODUCT_TREE = "feccbd2ca251f75f95bca1730e458605f1b3558c"
BASELINE_RUN = 40541756470
TARGET = "dce183ec0a0f23210d83b064c04ecc8b6af999fe"
TARGET_TREE = "6d881eade5b3178913012d3a6c6632bd41b0e849"
OUTGOING_SOURCE = "1ab093b6a46ad862bb3d22d982ed292793386353"
PROFILE_SHA = "02aeb5653fcd0dde0576907b7f480b895ea8c3e509cf2954ad2944ee8ef78fcb"
MIGRATION_PROFILE_SHA = "054116bc3f24876edf9bcc57c401d88faeb00482bced3d4fd8e7d91f72fc57b4"
SUCCESSOR_GENERATION = "782895334a70092d5c8f456a7be1eb76fcdd72b40e502877bd52988bd84daca7"
GENERATION_PARENT = "data/creator-hub/runtime-generations/linux-x86_64/"
EXTRA_ENV = ("CREATOR_NATIVE_LINUX_PRODUCTION_016", "CREATOR_MIGRATION_016_EXECUTE",
             "CREATOR_MIGRATION_016_SCENARIO", "CREATOR_MIGRATED_UPDATE_EXECUTE")
REPORTS = ("broker.json", "binding.json", "execution-request.json", "source-binding.json", "legacy-files.json",
           "result/report.json", "result/before.json", "result/first/session.json", "result/reopened/session.json",
           "result/old-sdk/sdk-result.json", "result/legacy-reconnect/sdk-result.json", "result/managed-reconnect/sdk-result.json")
TRANSACTIONS = (Path("/var/lib/creator-hub-deb-retirement"), Path("/var/lib/creator-hub-deb-retirement-setup"))
MAX_ENTRIES, MAX_TOTAL = 4096, 512 * 1024**2


def load(name):
    spec = importlib.util.spec_from_file_location("migrated_" + name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


U = load("native-linux-production-016-update")
M = load("native-linux-production-016-migration")
require = U.require


def require_bound_continuation():
    require(all(type(value) is str and re.fullmatch(pattern, value) for value, pattern in (
        (OUTGOING_SOURCE, r"[a-f0-9]{40}"), (PROFILE_SHA, r"[a-f0-9]{64}"), (SUCCESSOR_GENERATION, r"[a-f0-9]{64}"))),
        "Continuation producer/delivery binding is unbound; no migration or update may start")
    require(U.FIXED["17"]["source"] == TARGET and U.FIXED["17"]["tree"] == TARGET_TREE,
            "Outgoing target source/tree is not bound to the exact successor")


def admission(env):
    require_bound_continuation()
    require(M.admission(env) == "migration-approve", "Only actual complete migration approval may continue")
    require(env.get("CREATOR_MIGRATED_UPDATE_EXECUTE") == "true" and env.get("UPDATE_EXECUTE") == "true"
            and env.get("UPDATE_SCENARIO") == "deb-approve" and env.get("UPDATE_PROFILE_SHA256") == PROFILE_SHA,
            "Separate explicit migrated-user DEB approval required")
    require(all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
            and not any(re.match(r"^(LD_|DYLD_|PYTHON|TAURI_|WEBKIT_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)", k)
                        or k.lower().endswith("proxy") for k in env), "Inherited override or incomplete run identity refused")


def child_environment(env):
    return {**{k: env[k] for k in U.ENVIRONMENT + EXTRA_ENV}, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}


def transport_environment(env):
    return {**child_environment(env), "RUNNER_TEMP": str(OUTPUT), "HOME": str(HOME)}


def boot_id():
    with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as stream:
        value = stream.read(38).strip()
    require(re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value), "Bounded kernel boot identity required")
    return value


def context(env, boot):
    return {"source": env["GITHUB_SHA"], "run": env["GITHUB_RUN_ID"], "attempt": env["GITHUB_RUN_ATTEMPT"],
            "workflow": env["GITHUB_WORKFLOW_REF"], "boot": boot, "product": PRODUCT,
            "migrationProfile": MIGRATION_PROFILE_SHA, "outgoingProfile": PROFILE_SHA, "outgoingHarness": OUTGOING_SOURCE,
            "targetSource": TARGET}


def sources():
    return tuple(sorted(set(M.SOURCES) | set(U.SOURCES) | {Path(__file__).name}))


def directory(path, uid):
    before = path.lstat()
    require(path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISDIR(before.st_mode)
            and before.st_uid == before.st_gid == uid and not before.st_mode & 0o022,
            "Owned canonical directory required")
    return {"dev": before.st_dev, "ino": before.st_ino, "uid": before.st_uid,
            "gid": before.st_gid, "mode": stat.S_IMODE(before.st_mode)}


def tree(root, uid):
    """Full bounded ordinary-file inventory, including hidden backups/history."""
    rows, pending, total = {".": {"kind": "directory", **directory(root, uid)}}, [root], 0
    while pending:
        parent = pending.pop()
        parent_identity = directory(parent, uid)
        with os.scandir(parent) as entries:
            for entry in entries:
                require(len(rows) < MAX_ENTRIES, "Protected tree entry bound exceeded")
                path = parent / entry.name
                name = path.relative_to(root).as_posix()
                require(len(name.encode()) <= 512 and entry.name not in (".", "..") and "\\" not in entry.name,
                        "Noncanonical protected tree entry")
                info = path.lstat()
                if stat.S_ISDIR(info.st_mode):
                    rows[name] = {"kind": "directory", **directory(path, uid)}
                    pending.append(path)
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == info.st_gid == uid,
                            "Links/special or foreign protected files refused")
                    require(0 <= info.st_size <= 256 * 1024**2 and total + info.st_size <= MAX_TOTAL,
                            "Protected tree byte bound exceeded")
                    body = U.read(path, 256 * 1024**2, uid=uid)
                    require(U.stamp(path.lstat()) == U.stamp(info), "Protected file changed while hashing")
                    total += len(body)
                    rows[name] = {"kind": "file", **U.pin(body), "dev": info.st_dev, "ino": info.st_ino,
                                  "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode)}
        require(directory(parent, uid) == parent_identity, "Protected directory changed during inventory")
    return rows


def compare_tree(before, after, *, journal=None, generation=None, require_generation=False):
    require(before.keys() <= after.keys(), "An original protected entry disappeared")
    for name, expected in before.items():
        current = after[name]
        if name == journal:
            require(all(current[k] == expected[k] for k in ("kind", "dev", "uid", "gid", "mode")), "Journal owner/mode/filesystem changed")
        else:
            require(current == expected, "Original protected bytes/identity changed: " + name)
    allowed = {} if generation is None else generation
    prefix = GENERATION_PARENT + SUCCESSOR_GENERATION
    require(not allowed or prefix in allowed and all(name == prefix or name.startswith(prefix + "/") for name in allowed),
            "Only the exact reviewed successor generation may be added")
    added_generation = set(after).intersection(allowed)
    if added_generation or require_generation:
        require(bool(allowed) and added_generation == set(allowed), "Complete manifest-derived successor generation required")
        for name, expected in allowed.items():
            current = after[name]
            require(all(current.get(key) == value for key, value in expected.items())
                    and current["dev"] == before["."]["dev"] and current["uid"] == current["gid"] == M.UID,
                    "Successor runtime bytes/mode/owner differ: " + name)
    # Additions are not silently generalized to new history/settings formats.
    for name in after.keys() - before.keys():
        if name in allowed:
            continue
        require(name == "data/creator-hub-update-cache" or name.startswith("data/creator-hub-update-cache/")
                or name == "cache" or name.startswith("cache/"), "Unexpected new protected state: " + name)
        require(not name.endswith(".bak") and "backup" not in name.lower(), "Unexpected backup creation during update")


def retained_generation(before, expected):
    """085 and dce share this generation; never reconstruct or partially adopt it."""
    prefix = GENERATION_PARENT + SUCCESSOR_GENERATION
    require({name for name in before if name == prefix or name.startswith(prefix + "/")} == set(expected),
            "Complete exact existing runtime generation required")
    compare_tree(before, before, generation=expected, require_generation=True)


def migration_gate(broker, report, batch):
    require(broker.get("scope") == "production-016-disposable-migration"
            and broker.get("scenario") == report.get("scenario") == "migration-approve"
            and broker.get("harnessSource") == report.get("harnessSource")
            and broker.get("scenarioPassed") is report.get("scenarioPassed") is True
            and broker.get("fixtureRelocked") is True and report.get("normalReopenObserved") is True,
            "Completed actual migration/reopen and account relock required")
    wrapper = broker.get("sessionWrapper", {})
    require(wrapper.get("returnCode") == 0 and type(wrapper.get("returnCode")) is int
            and wrapper.get("deadlineExpired") is False, "Migration wrapper did not finish normally")
    require(set(wrapper.get("pipes", {})) == {"stdout", "stderr"}
            and all(row.get("eof") is True and row.get("truncated") is False for row in wrapper["pipes"].values()),
            "Original migration output is incomplete")
    for value in (broker, report):
        require(not any(k in value for k in ("refusal", "recovery", "relockRefusal", "captureRefused", "disposableTeardownRequired"))
                and all(value.get(k) is False for k in M.FLAGS), "Failed/incomplete migration cannot be adopted")
    U.keys(batch, ("policy", "phase", "outcome", "review_key", "retry_blocked"))
    require(type(batch["policy"]) is int and batch["policy"] == 1 and batch["phase"] == "cleanup"
            and batch["outcome"] == "complete" and batch["retry_blocked"] is False
            and re.fullmatch(r"[a-f0-9]{64}", batch["review_key"]), "Cleanup incomplete or retry-blocked")


def journal_step(previous, current):
    return M.journal_delta(previous, current, phase="mcp-page")


def profile(raw):
    require_bound_continuation()
    require(U.pin(raw)["sha256"] == PROFILE_SHA, "Only the independently approved outgoing profile is admitted")
    value = U.validate_profile(U.parse(raw), "deb-approve")
    require(value["baseline"]["source"] == PRODUCT and value["baseline"]["tree"] == PRODUCT_TREE
            and value["baseline"]["run"] == BASELINE_RUN,
            "Only the exact current product/assembly may continue")
    return value


def prepare(env):
    admission(env)
    require(os.getuid() == os.geteuid() == 0 and not os.path.lexists(BASE) and not os.path.lexists(INTENT),
            "Intent must precede the one fresh migration, never adopt/retry another runner")
    U.protected_ancestry(INTENT.parent)
    incoming = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-input/profile.json"
    require(U.pin(U.read(incoming, 65536))["sha256"] == MIGRATION_PROFILE_SHA, "Exact migration profile required")
    folder = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-input"
    raw = U.read(folder / "profile.json", 65536)
    value = profile(raw)
    require({p.name for p in folder.iterdir()} == {"profile.json", *(name + ".zip" for name in U.input_roles(value))},
            "Only original pinned ZIPs and approved profile may be staged")
    pins = {"profile.json": U.pin(raw)}
    for name, expected in U.input_roles(value).items():
        pins[name + ".zip"] = U.pin(U.bound(folder / (name + ".zip"), expected["zip"], U.MAX_ZIP))
    verifier, qualification = U.offline_verifier(env)
    driver = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
    driver_pin = U.pin(U.read(driver, 64 * 1024**2, mode=0o755))
    intent = {"schemaVersion": 1, "context": context(env, boot_id()), "inputs": pins,
              "sources": {name: U.pin(U.read(HERE / name, 2 * 1024**2)) for name in sources()},
              "verifier": qualification, "driver": driver_pin, "node": U.pin(U.read(Path(env["CONTROLLER_NODE"]), 128 * 1024**2, mode=0o755))}
    U.save(INTENT, intent, 0o644)


def intent(env):
    admission(env)
    value = U.parse(U.read(INTENT, 65536, uid=0, mode=0o644))
    require(value["schemaVersion"] == 1 and value["context"] == context(env, boot_id())
            and set(value["sources"]) == set(sources()), "Original boot/run/source intent differs")
    for name, expected in value["sources"].items():
        U.bound(HERE / name, expected, 2 * 1024**2)
    return value


def captured_reports():
    return {name: file_identity(BASE / name, 2 * 1024**2) for name in REPORTS}


def file_identity(path, maximum):
    info = path.lstat()
    require(info.st_uid == info.st_gid and info.st_uid in (0, M.UID), "Foreign preservation evidence")
    raw = U.read(path, maximum, uid=info.st_uid)
    require(U.stamp(path.lstat()) == U.stamp(info), "Preserved file changed during capture")
    return {**U.pin(raw), "dev": info.st_dev, "ino": info.st_ino, "uid": info.st_uid,
            "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode)}


def legacy_state():
    original = U.parse(U.read(BASE / "legacy-files.json", 65536, uid=0, mode=0o644))
    U.keys(original, ("mcp", "setup"))
    state = {}
    for product, files in original.items():
        require(type(files) is dict and 0 < len(files) <= 64, "Bounded original legacy inventory required")
        for name, pin in files.items():
            U.safe_name(name)
            path = Path("/") / name
            if product == "mcp" and name.startswith("usr/lib/Creator Works MCP/server/"):
                require(U.pin(U.read(path, U.MAX_FILE, uid=0, mode=pin["mode"])) == {k: pin[k] for k in ("size", "sha256")},
                        "Original retained runtime changed")
                state[name] = file_identity(path, U.MAX_FILE)
            else:
                require(not os.path.lexists(path), "A retired standalone GUI returned")
                state[name] = None
    notice = Path("/usr/share/creator-project-setup/retired-by-creator-hub.txt")
    state[str(notice)] = file_identity(notice, 1024)
    require(state[str(notice)]["sha256"] == "a04ca21391c408ec055d22ba7defecd8278a0682e0d398538d77fbfb3605c5bb",
            "Retained Setup notice differs")
    return state


def adopt(env, original):
    broker = U.parse(U.read(BASE / "broker.json", 1048576, uid=0, mode=0o644))
    report = U.parse(U.read(BASE / "result/report.json", 1048576, uid=M.UID, mode=0o600))
    batch = U.parse(U.read(HOME / "data/CreatorHub/convergence/move-v1.json", 8192, uid=M.UID))
    migration_gate(broker, report, batch)
    require(report["harnessSource"] == env["GITHUB_SHA"], "Foreign migration source receipt")
    binding_raw = U.read(BASE / "binding.json", 1048576, uid=0, mode=0o644)
    binding = U.parse(binding_raw)
    M.check_request(U.parse(U.read(BASE / "execution-request.json", 16384, uid=0, mode=0o644)), env, binding_raw)
    require(report["bindingSha256"] == U.pin(binding_raw)["sha256"], "Migration report/input binding differs")
    profile_raw = U.read(Path(env["RUNNER_TEMP"]) / "native-linux-production-016-input/profile.json", 65536)
    require(U.pin(profile_raw)["sha256"] == MIGRATION_PROFILE_SHA and binding["profile"] == U.parse(profile_raw),
            "Migration package/profile differs from the pre-migration intent")
    M.installed(binding, (True, True))
    polkit = U.load("native-linux-polkit-probe")
    require(polkit.fixture_credential("status") == "L", "Completed migration account is not locked")
    require(U.parse(U.read(HOME / U.PREFS))["restoreHostedViews"] is False, "Migrated Projects startup required")
    before = tree(HOME, M.UID)
    require(any(".creator-hub-settings-backups/" in name for name in before)
            and any("client-migrations-v1/" in name for name in before), "Actual migration backups/client history missing")
    journal = M.journal(HOME)
    require(report["operationJournals"]["reopened"]["file"] == U.pin(U.read(HOME / M.JOURNAL, 65536)), "Final migration journal changed")
    return {"schemaVersion": 1, "context": original["context"], "reports": captured_reports(), "home": before,
            "journal": journal, "transactions": {str(path): tree(path, 0) for path in TRANSACTIONS},
            "batch": batch, "binding": binding, "accountUid": M.UID, "legacy": legacy_state()}


def verify_preservation(sealed, *, privileged=True, require_generation=False):
    require(type(privileged) is bool and os.getuid() == os.geteuid() == (0 if privileged else M.UID),
            "Preservation reader must match its fixed phase")
    require(captured_reports() == sealed["reports"], "Original migration evidence was changed")
    compare_tree(sealed["home"], tree(HOME, M.UID), journal=M.JOURNAL,
                 generation=sealed["successorGeneration"], require_generation=require_generation)
    if privileged:
        require(set(sealed["transactions"]) == {str(path) for path in TRANSACTIONS}, "Exact retirement state paths required")
        for path, before in sealed["transactions"].items():
            after = tree(Path(path), 0)
            require(after == before, "Original retirement transaction/backup changed")
    require(legacy_state() == sealed["legacy"], "Original retained runtime/GUI absence changed")
    require(U.parse(U.read(HOME / "data/CreatorHub/convergence/move-v1.json", 8192)) == sealed["batch"], "Migration cleanup state changed")


def preserve(sealed, previous=None, *, privileged=True):
    verify_preservation(sealed, privileged=privileged)
    current = M.journal(HOME)
    if previous is None:
        require(current == sealed["journal"], "Original journal changed before continuation")
    else:
        journal_step(previous, current)
    return current


def final_journal(previous, current):
    U.keys(current, ("revision", "records"))
    require(type(current["records"]) is list and len(current["records"]) == len(previous["records"]) + 4,
            "Exactly two source-defined MCP page read pairs required")
    intermediate = {"revision": current["revision"], "records": current["records"][:-2]}
    journal_step(previous, intermediate)
    journal_step(intermediate, current)
    return current


def verify_inputs(env, original):
    source = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-input"
    folder = CONTROL / "inputs"
    folder.mkdir(mode=0o755)
    for name, expected in original["inputs"].items():
        U.write(folder / name, U.bound(source / name, expected, U.MAX_ZIP), 0o444)
    value = profile(U.read(folder / "profile.json", 65536))
    members = folder / "members"; members.mkdir(mode=0o755)
    for name, expected in U.input_roles(value).items():
        U.stage_zip(folder / (name + ".zip"), expected, members / name)
    verifier = (CONTROL / "scripts/verify-package-input", original["verifier"])
    review = U.review_staged_packages(folder, value, verifier, "deb-approve")
    review["successorGeneration"] = successor_generation(folder, value, review["deb17"])
    # Publishing data-only inputs changes neither HOME nor installed files.
    for path in (members, *members.rglob("*")):
        require(not path.is_symlink() and path.lstat().st_uid == 0, "Foreign staged input")
        os.chmod(path, 0o755 if path.is_dir() else 0o444)
    return value, review


def generation_entries(manifest):
    U.keys(manifest["modules"]["mcp"], ("executable", "version", "files"))
    entry = manifest["modules"]["mcp"]
    canonical = json.dumps({"executable": entry["executable"], "version": entry["version"],
                            "files": dict(sorted(entry["files"].items()))}, separators=(",", ":"), ensure_ascii=False).encode()
    require(hashlib.sha256(canonical).hexdigest() == SUCCESSOR_GENERATION, "Unreviewed successor runtime generation")
    prefix = GENERATION_PARENT + SUCCESSOR_GENERATION
    expected = {prefix: {"kind": "directory", "mode": 0o700}}
    for name, sha in entry["files"].items():
        U.safe_name(name)
        require(name.startswith("mcp/") and re.fullmatch(r"[a-f0-9]{64}", sha), "Unexpected successor runtime member")
        metadata = manifest["payloadArchive"]["files"][name]
        U.keys(metadata, ("size", "mode"))
        U.validate_pin({"size": metadata["size"], "sha256": sha})
        require(type(metadata["mode"]) is int and metadata["mode"] in (0o644, 0o755), "Unexpected successor member mode")
        relative = prefix + "/" + name
        expected[relative] = {"kind": "file", "size": metadata["size"], "sha256": sha, "mode": metadata["mode"]}
        parent = relative.rsplit("/", 1)[0]
        while parent != prefix:
            expected[parent] = {"kind": "directory", "mode": 0o755}
            parent = parent.rsplit("/", 1)[0]
    return expected


def successor_generation(folder, value, package_files):
    artifact = value["artifacts"]["assembly17"]
    relative = Path(value["objects"]["raw17"]["member"]).parent
    root = folder / "members/assembly17"
    manifest_name, archive_name = (relative / name for name in ("builtin-manifest.json", "modules.tar.gz"))
    raw = U.bound(root / manifest_name, artifact["files"][manifest_name.as_posix()], 128 * 1024)
    manifest = U.parse(raw)
    require(manifest["schemaVersion"] == 1 and manifest["platform"] == "linux" and manifest["arch"] == "x86_64"
            and raw in U.bound(U.object_path(folder, value, "raw17"), U.FIXED["17"]["raw"]), "Successor manifest is not embedded in exact017 Root")
    archive = U.bound(root / archive_name, artifact["files"][archive_name.as_posix()])
    require(U.pin(archive) == U.FIXED["17"]["archive"]
            == {k: package_files["usr/lib/Creator Hub/modules.tar.gz"][k] for k in ("size", "sha256")}
            == {k: manifest["payloadArchive"][k] for k in ("size", "sha256")}, "Successor resource archive/package/manifest differs")
    U.load("native-linux-016-stage").modules(io.BytesIO(archive), manifest)
    return generation_entries(manifest)


def update_question(home):
    require(U.parse(U.read(home / U.PREFS))["restoreHostedViews"] is False, "Original no-reopen preference must remain false")
    return ("Update Creator Hub to 0.1.17?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."
            "\n\nHub will close these idle views: Creator Project Setup. Unsaved form entries will be discarded. "
            "Automatic reopening is turned off. You can open them again from Hub. "
            "Standalone apps and MCP connections will stay open.")


def session_command(env):
    values = child_environment(env)
    values.update(HOME=str(HOME), USER=M.USER, RUNNER_TEMP=str(OUTPUT), XDG_CONFIG_HOME=str(HOME / "config"),
                  XDG_DATA_HOME=str(HOME / "data"), XDG_CACHE_HOME=str(HOME / "cache"),
                  XDG_RUNTIME_DIR=str(OUTPUT / "runtime"), TMPDIR=str(OUTPUT / "tmp"), GDK_BACKEND="x11", NO_AT_BRIDGE="0")
    return ["/usr/bin/systemd-run", "--wait", "--pipe", "--collect", "--quiet", "--unit=creator-migrated-update-fixture",
            "--uid=" + M.USER, "--property=PAMName=login", "--property=Type=exec", "--property=LimitCORE=0",
            "--property=WorkingDirectory=" + str(BASE), *("--setenv=" + k + "=" + v for k, v in values.items()),
            "/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a", "--server-args=-screen 0 1280x1000x24",
            "/usr/bin/env", *(k + "=" + values[k] for k in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME")),
            "/usr/bin/python3", "-B", str(CONTROL / "scripts" / Path(__file__).name), "session"]


def runtime_binding(env):
    original = intent(env)
    require(HERE == CONTROL / "scripts", "Only the sealed continuation controller may run child phases")
    U.protected_ancestry(CONTROL)
    for name, expected in original["sources"].items():
        U.bound(HERE / name, expected, 2 * 1024**2, uid=0, mode=0o444)
    value = U.parse(U.read(CONTROL / "state.json", 2 * 1024**2, uid=0, mode=0o644))
    require(value["context"] == original["context"] and value["accountUid"] == M.UID,
            "Original continuation state/run changed")
    return original, value


def recheck_sources(env, original):
    require(intent(env) == original, "Continuation checkout source/context drift")
    U.protected_ancestry(CONTROL / "scripts")
    for name, expected in original["sources"].items():
        U.bound(CONTROL / "scripts" / name, expected, 2 * 1024**2, uid=0, mode=0o444)
    sealed = U.parse(U.read(CONTROL / "state.json", 2 * 1024**2, uid=0, mode=0o644))
    require(sealed["context"] == original["context"] and sealed["accountUid"] == M.UID, "Protected original state changed")
    return sealed


def projects(html, home, report, phase):
    require(html.probed and not html.detached, "Owned probed HTML target required")
    U.wait(lambda: html.optional("#view-projects", "attribute/aria-busy") == "false")
    require(html.optional("#usage-terms-dialog", "attribute/open") is None
            and html.optional("#convergence-dialog", "attribute/open") is None
            and html.d.read("#projects-home-title") == "Projects"
            and html.d.read("#view-projects", "displayed") is True
            and U.parse(U.read(home / U.PREFS))["restoreHostedViews"] is False,
            "Migrated Projects state did not survive; no fallback consent/dismissal")
    require(not html.d.elements("iframe,object,embed"), "Unexpected separate page document")
    require(len(html.d.elements("#project-list .project-row")) == 2, "Migrated Projects inventory differs")
    for selected, name in (("true", "current-project"), ("false", "missing-project")):
        selector = '#project-list .project-row[data-mcp-selected="' + selected + '"]'
        require(len(html.d.elements(selector)) == 1 and html.d.read(selector + " .project-info small") == str(home / name),
                "Migrated Projects selection/path changed")
    report[phase] = {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}


def continuation_outcome(report):
    U.outcome("deb-approve", report)
    require(report.get("scope") == "continuous-migrated-home-private017-lifecycle-only"
            and report.get("beforeMigrationConnectionContinued") is False
            and report.get("migrationEvidencePreserved") is True and report.get("homePreserved") is True
            and report.get("journalPrefixPreserved") is True
            and all(report.get(phase) == {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}
                    for phase in ("initialProjects", "successorProjects")), "Complete migrated-HOME continuation evidence required")
    return True


def native_session(env):
    original, sealed = runtime_binding(env)
    require(os.getuid() == os.geteuid() == M.UID and env.get("HOME") == str(HOME), "Only the original migrated UID/HOME may continue")
    require(all(env.get(k) == str(HOME / leaf) for k, leaf in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"))),
            "Original migrated XDG settings required")
    preserve(sealed, privileged=False)
    reviewed = U.parse(U.read(CONTROL / "review.json", 2 * 1024**2, uid=0, mode=0o644))
    require(reviewed["signaturesVerified"] is True and reviewed["baseline"]["source"] == PRODUCT
            and reviewed["privateTargetQualification"] == U.private_target_qualification(), "Signed continuation review required")
    value = profile(U.read(CONTROL / "inputs/profile.json", 65536))
    private = U.read_private_control()
    require(re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", private["proxyUrl"])
            and int(private["proxyUrl"].rsplit(":", 1)[1]) < 65536 and private["secret"] is not None, "Exact private approval control required")
    secret = bytearray(private["secret"].encode()); proxy = private["proxyUrl"]; del private
    import gi
    gi.require_version("Atspi", "2.0"); gi.require_version("Gdk", "3.0")
    from gi.repository import Atspi, Gdk, Gio, GLib
    Gdk.init([]); Atspi.init(); Atspi.set_timeout(1500, 1500)
    pages, helper, native, polkit, flow = (U.load(name) for name in
        ("native-linux-integrated-pages", "native-unix-window", "native-linux-root-probe", "native-linux-polkit-probe", "native-linux-update-flow"))
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(36, 1, 0, 0, 0) == 0 and signal.getsignal(signal.SIGCHLD) != signal.SIG_IGN, "Owned automatic successor requires subreaper")
    subreaper = ctypes.c_int()
    require(libc.prctl(37, ctypes.byref(subreaper), 0, 0, 0) == 0 and subreaper.value == 1, "Subreaper not confirmed")
    report = {"schemaVersion": 1, "scope": "continuous-migrated-home-private017-lifecycle-only", "scenario": "deb-approve",
              "harnessSource": env["GITHUB_SHA"], "fromSource": PRODUCT, "toSource": U.FIXED["17"]["source"],
              "privateTargetQualification": U.private_target_qualification(), "beforeMigrationConnectionContinued": False,
              "nativeActions": [], "systemActions": [], "initialPageActionAttempts": [], "successorPageActionAttempts": [],
              "automaticSuccessor": None, "oldRetirementHelperRestored": False, "targetRetirementHelperVerified": False,
              "scenarioPassed": False, **U.FALSE}
    html = replacement_html = surface = replacement = None
    root_output = None
    failure = None
    try:
        x11 = helper.X11()
        wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wm_identity = U.kernel_record(wm.pid, native, helper)
        U.wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"))
        require(U.windows(x11) == [], "Private display is not empty")
        app_env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(HOME),
                   "XDG_CONFIG_HOME": str(HOME / "config"), "XDG_DATA_HOME": str(HOME / "data"), "XDG_CACHE_HOME": str(HOME / "cache"),
                   "XDG_RUNTIME_DIR": env["XDG_RUNTIME_DIR"], "TMPDIR": env["TMPDIR"], "GDK_BACKEND": "x11", "NO_AT_BRIDGE": "0",
                   "HTTPS_PROXY": proxy, "NO_PROXY": "localhost,127.0.0.1,::1",
                   **{k: env[k] for k in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY") if k in env}}
        automation, port = U.html_automation_environment(app_env)
        mcp = U.load("native-linux-update-mcp")
        verifier = (CONTROL / "scripts/verify-package-input", original["verifier"])
        _, resource_files, _ = U.baseline_mcp_inputs(CONTROL / "inputs", value, reviewed["deb16"], verifier)
        route = mcp.BoundRoute(M, HOME, resource_files, lambda body, sig: U.signature(body, sig, verifier))
        evidence = OUTPUT / "mcp"; evidence.mkdir(mode=0o700)
        protected = (U.CONFIG, M.LEGACY, U.PREFS, U.TERMS, ".claude.json", ".codex/config.toml")
        connection = mcp.McpFixture(route, evidence,
            {**{k: v for k, v in app_env.items() if k not in ("HTTPS_PROXY", "NO_PROXY")},
             "CREATOR_WORKS_TOOL_GROUPS": "none", "CREATOR_WORKS_CONFIG_OWNER": "creator-hub-v1"}, protected, pages, helper, native)
        report["mcpChecks"] = [connection.start()]
        system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None); bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        parent = U.kernel_record(os.getpid(), native, helper)
        polkit.source_contract(); session_identity = polkit.session(system, os.getpid(), GLib)
        agent = subprocess.Popen([polkit.AGENT], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=app_env)
        agent_record = U.kernel_record(agent.pid, native, helper)
        polkit.own_agent(agent, agent_record, parent, helper)
        require(polkit.session(system, agent.pid, GLib) == session_identity, "Agent left the owned logind session")
        endpoint = U.wait(lambda: polkit.agent_bus_identity(system, agent_record, GLib))
        report["installed16"] = U.verify_installed(reviewed, "16")
        root_output = U.RootPipeDrainer()
        try:
            initial = subprocess.Popen(["/usr/bin/creator-hub"], stdin=subprocess.DEVNULL,
                stdout=root_output.target("stdout"), stderr=root_output.target("stderr"), env=automation, umask=0o022)
        finally:
            root_output.release_writers()
        old = U.phase_identity(U.kernel_record(initial.pid, native, helper), value["baseline"]["hub"], "/usr/bin/creator-hub", os.getpid(), M.UID)
        report["initialRoot"] = old; U.save(OUTPUT / "root.json", old)
        old_bus = U.verify_bus(old, bus, polkit, GLib, portable=False)
        inventory = M.InventoryClient(env["GITHUB_SHA"], "deb-approve", cohort="update", channel="migrated-update")
        surface = U.Surface(old, x11, helper, native, Atspi, inventory=inventory)
        U.bind_source_menu(surface, value["baseline"]["source"], value["baseline"]["hub"])
        html = U.HtmlPages(surface, initial, pages, original["driver"], port, app_env, report.setdefault("htmlWebDriver", {}), migrated=True)
        html.start(); projects(html, HOME, report, "initialProjects")
        require(M.journal(HOME) == sealed["journal"], "Projects startup changed migrated journal")
        html.direct_pages(report["initialPageActionAttempts"])
        first_journal = preserve(sealed, sealed["journal"], privileged=False)
        report["initialBitmap"] = U.phase_bitmap(surface, "migrated-update/initial-bitmap")
        html.home()
        U.wait(lambda: html.optional("#hub-update-status") in ("Version 0.1.17 is available.", "Version 0.1.17 is ready to install."), 90)
        require(html.d.read("#hub-update-button", "enabled") is True, "Actual signed update action is not ready")
        baseline = U.children(os.getpid()); report["initial16Verified"] = True
        html.click("#hub-update-button", [], "hub-update-button")
        modal = U.Surface(old, x11, helper, native, Atspi, title="Update Creator Hub", dialog=True)
        report["nativeConfirmationObserved"] = True
        try:
            require(set(U.windows(x11)) == {surface.window, modal.window}, "Only exact Hub/consent pair may receive input")
            html.detach()
            modal.dialog_action(update_question(HOME), ("Update Hub", "Not now"), "Update Hub", report["nativeActions"])
        finally:
            modal.bus.close_sync(None)
        U.wait(lambda: modal.window not in U.windows(x11), 30)
        U.authorize(surface, agent, agent_record, parent, endpoint, system, GLib, Atspi, polkit, flow, helper, native, secret, report, migrated=True)
        successor, rejected = U.observe_successor(old, U.FIXED["17"]["hub"], "/usr/bin/creator-hub", os.getpid(), baseline, native, helper, old_child=initial)
        report["automaticSuccessor"], report["nonliveRejected"] = successor, rejected
        U.verify_bus(successor, bus, polkit, GLib, portable=False, previous=old_bus)
        replacement = U.Surface(successor, x11, helper, native, Atspi, inventory=inventory)
        U.bind_source_menu(replacement, U.FIXED["17"]["source"], U.FIXED["17"]["hub"])
        html.finish_tools()
        replacement_html = U.HtmlPages(replacement, initial, pages, original["driver"], port, app_env,
            report.setdefault("successorHtmlWebDriver", {}), previous=html, migrated=True)
        replacement_html.start(); projects(replacement_html, HOME, report, "successorProjects")
        require(M.journal(HOME) == first_journal, "Successor Projects startup modified existing history")
        report["directPagesObserved"] = replacement_html.direct_pages(report["successorPageActionAttempts"])
        preserve(sealed, first_journal, privileged=False)
        replacement_html.home()
        U.wait(lambda: replacement_html.optional("#hub-update-status") == "You are using Hub 0.1.17. No newer update was found.", 90)
        report["fresh17UiVersion"] = True
        report["successorBitmap"] = U.phase_bitmap(replacement, "migrated-update/successor-bitmap")
        report["installed17"] = U.verify_installed(reviewed, "17")
        report["oldRetirementHelperRestored"] = reviewed["privateTargetQualification"]["privateDebApprovalRestoresOldRetirementHelper"]
        report["targetRetirementHelperVerified"] = report["installed17Verified"] = report["automaticRestartObserved"] = True
        replacement_html.detach(); report["mcpChecks"].append(connection.check("after-update"))
        replacement.close(); replacement_html.finish_tools()
        require(initial.returncode == 0, "Original Root exit was not normal")
        report["oldNormalExit"] = report["normalFinalClose"] = True
        U.complete_mcp_protocol(connection, report, migrated=True)
        require(U.windows(x11) == [] and U.kernel_record(wm.pid, native, helper) == wm_identity, "Final visible process/WM identity differs")
        final_journal = M.journal(HOME)
        expected = M.journal_delta(first_journal, final_journal, phase="mcp-page")
        require(expected == final_journal, "Unexpected final journal")
        # Recheck immutable bytes after EOF reconnect and normal app close as well.
        verify_preservation(sealed, privileged=False, require_generation=True)
        report.update(settingsPreserved=True, homePreserved=True, journalPrefixPreserved=True, migrationEvidencePreserved=True)
        polkit.own_agent(agent, agent_record, parent, helper)
        agent.terminate(); agent.wait(timeout=10)
        subprocess.run(["/usr/bin/openbox", "--exit"], stdin=subprocess.DEVNULL, check=True)
        wm.wait(timeout=10)
        report["scenarioPassed"] = continuation_outcome(report)
    except Exception as error:
        failure = error
        report.update(scenarioPassed=False, disposableTeardownRequired=True, recovery="unknown-no-retry-disposable-runner-teardown",
                      refusal={"type": type(error).__name__, "message": str(error)[:1000]})
    finally:
        M.wipe(secret)
        for adapter in (html, replacement_html):
            if adapter is not None and adapter.logs is not None:
                try:
                    adapter.retain_logs(); adapter.logs.close()
                except Exception as error:
                    failure = failure or error; report["captureRefused"] = True
        for current in (surface, replacement):
            if current is not None:
                try:
                    current.bus.close_sync(None)
                except Exception as error:
                    failure = failure or error
        if failure is not None:
            report.update(scenarioPassed=False, disposableTeardownRequired=True, recovery="unknown-no-retry-disposable-runner-teardown")
        U.save(OUTPUT / "report.json", report)
    if failure is not None:
        raise failure


def broker_outcome(record):
    require(record.get("nativePassed") is True and record.get("preservationPassed") is True
            and record.get("fixtureRelocked") is True and record.get("tlsCleanup") == {
                "temporaryCertificateRemoved": True, "originalTrustRestored": True}
            and record.get("transportClosed") is True and record.get("sessionExit") == 0
            and type(record.get("sessionExit")) is int and record.get("privateTargetQualification") == U.private_target_qualification()
            and not any(k in record for k in ("refusal", "cleanupRefused", "recovery"))
            and all(record.get(k) is False for k in U.FALSE), "Incomplete continuation cleanup cannot pass")
    return True


def broker(env):
    original = intent(env)
    require(os.getuid() == os.geteuid() == 0 and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts",
            "Continuation broker must run once from the bound checkout")
    require(not os.path.lexists(CONTROL) and not os.path.lexists(OUTPUT)
            and not os.path.lexists(BASE / "tls") and not os.path.lexists(U.TLS_CERT), "Existing continuation/trust state; no retry")
    directory(BASE, 0); directory(BASE / "result", M.UID)
    CONTROL.mkdir(mode=0o755); OUTPUT.mkdir(mode=0o700); os.chown(OUTPUT, M.UID, M.UID)
    record = {"schemaVersion": 1, "scope": "continuous-migrated-home-private017-lifecycle-only",
              "context": original["context"], "scenarioPassed": False, "continuousMigratedUserAccepted": False,
              "privateTargetQualification": U.private_target_qualification(), "fixtureRelocked": False, **U.FALSE}
    polkit, native, helper = (U.load(name) for name in ("native-linux-polkit-probe", "native-linux-root-probe", "native-unix-window"))
    secret = payload = guard = lab = child = logs = sealed = None
    relock, failure = False, None
    try:
        sealed = adopt(env, original)
        require(M.native_process_inventory(native, helper) == {"processes": [], "terminalProcesses": []},
                "Earlier fixture processes remain; never adopt or signal them")
        scripts = CONTROL / "scripts"; scripts.mkdir(mode=0o755)
        for name, expected in original["sources"].items():
            U.write(scripts / name, U.bound(HERE / name, expected, 2 * 1024**2), 0o444)
        verifier, qualification = U.offline_verifier(env)
        require(qualification == original["verifier"], "Original verifier qualification changed")
        U.write(scripts / "verify-package-input", U.bound(verifier, qualification["tool"]["pin"], 64 * 1024**2), 0o755)
        driver = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
        U.write(scripts / "tauri-driver", U.bound(driver, original["driver"], 64 * 1024**2), 0o755)
        U.bound(Path(env["CONTROLLER_NODE"]), original["node"], 128 * 1024**2, mode=0o755)
        value, review = verify_inputs(env, original)
        sealed["successorGeneration"] = review["successorGeneration"]
        retained_generation(sealed["home"], sealed["successorGeneration"])
        U.save(CONTROL / "state.json", sealed, 0o644)
        U.save(CONTROL / "review.json", review, 0o644)
        U.verify_installed(review, "16")
        for name in ("runtime", "tmp"):
            path = OUTPUT / name; path.mkdir(mode=0o700); os.chown(path, M.UID, M.UID)
        transport_env = transport_environment(env)
        transport, pins = U.prepare_transport(CONTROL / "inputs", value, transport_env)
        for path in (transport.parent, transport, *transport.rglob("*")):
            require(not path.is_symlink(), "Redirected continuation transport")
            os.chown(path, M.UID, M.UID)
        inspected = subprocess.run([env["CONTROLLER_NODE"], str(scripts / "linux-update-lab-feed.cjs"),
            "update-migrated-016-017-inspect", "deb", str(transport)], user=M.UID, group=M.UID, extra_groups=[],
            env=transport_env, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=False)
        require(inspected.returncode == 0 and 0 < len(inspected.stdout) <= 65536 and len(inspected.stderr) <= 8192,
                "Closed continuation transport preflight refused")
        inspected_report = U.parse(inspected.stdout)
        require(inspected_report["fromVersion"] == "0.1.16" and inspected_report["targetVersion"] == "0.1.17"
                and inspected_report["publicDiscovery"] is inspected_report["releaseReady"] is False, "Transport scope differs")
        polkit.verify_files(BASE); polkit.admin_config(); polkit.credential_tools(BASE)
        require(polkit.fixture_credential("status") == "L", "Original account is no longer locked")
        preserve(sealed)
        guard = U.prepare_tls(env, migrated=True)
        lab = U.start_transport(env, transport, "deb", {"nodeImage": original["node"]}, migrated=True)
        secret = bytearray(secrets.token_hex(32).encode()); relock = True
        polkit.fixture_credential("provision", secret)
        require(polkit.fixture_credential("status") == "P", "Original synthetic account provisioning refused")
        payload = bytearray((json.dumps({"secret": secret.decode(), "proxyUrl": lab.proxy}) + "\n").encode())
        child = subprocess.Popen(session_command(env), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 cwd=BASE, env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
        logs = native.Capture(child, CONTROL, "session")
        require(child.stdin.write(payload) == len(payload), "Private continuation frame delivery uncertain")
        child.stdin.close(); M.wipe(secret); M.wipe(payload)
        state, index, deadline = {"sequence": 1, "nonces": set()}, 1, time.monotonic() + 900
        while child.poll() is None and time.monotonic() < deadline:
            logs.pump(0.02)
            require(not any(row["truncated"] for row in logs.metadata().values()), "Continuation output exceeded bound")
            M.serve_inventory(state, record, env["GITHUB_SHA"], "deb-approve", native, helper, cohort="update", channel="migrated-update")
            path = OUTPUT / f"input-{index}.json"
            if os.path.lexists(path):
                raw = U.read(path, 256, uid=M.UID, mode=0o600)
                if raw.endswith(b"\n"):
                    require(index <= 12 and U.parse(raw) == {"index": index}, "Unexpected continuation input sequence")
                    # Rebind protected sources and original run immediately before input authority.
                    require(recheck_sources(env, original) == sealed, "Protected original state drift")
                    verify_preservation(sealed)
                    root = U.parse(U.read(OUTPUT / "root.json", 16384, uid=M.UID, mode=0o600))
                    proof = U.pending_proof(root, native, helper, polkit, value["baseline"], migrated=True)
                    M.publish(CONTROL / f"input-{index}.json", {"index": index, "proof": proof}, mode=0o644)
                    index += 1
        record["sessionExit"] = child.poll()
        require(record["sessionExit"] == 0, "Continuation failed/unknown; no retry, signal or manual successor")
        result = U.parse(U.read(OUTPUT / "report.json", 2 * 1024**2, uid=M.UID, mode=0o600))
        require(result["harnessSource"] == env["GITHUB_SHA"] and result["scenarioPassed"] is True and continuation_outcome(result),
                "Native continuation report incomplete")
        record["nativePassed"] = True
        U.verify_installed(review, "17")
        final_journal(sealed["journal"], M.journal(HOME)); verify_preservation(sealed, require_generation=True)
        record["preservationPassed"] = True
        lab.finish(close_message=True); lab = None
        transport_report = U.parse(U.read(transport / "lab-transport.json", 65536, uid=M.UID, mode=0o600))
        record["transport"] = U.validate_transport_report(transport_report, pins, "deb-approve")
        record["transportClosed"] = True
    except Exception as error:
        failure = error
        record["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
    finally:
        M.wipe(secret); M.wipe(payload)
        for owned, close_message in ((lab, True), (guard, False)):
            if owned is not None:
                try:
                    owned.finish(close_message=close_message)
                except Exception as error:
                    failure = failure or error; record["cleanupRefused"] = True
        try:
            record["tlsCleanup"] = U.tls_cleanup(env)
        except Exception as error:
            failure = failure or error; record["cleanupRefused"] = True
        try:
            if relock:
                polkit.fixture_credential("lock")
            require(polkit.fixture_credential("status") == "L", "Original account relock unproven")
            record["fixtureRelocked"] = True
        except Exception as error:
            failure = failure or error; record["cleanupRefused"] = True
        if logs is not None:
            try:
                logs.pump(); record["logs"] = logs.metadata()
                require(all(row["eof"] and not row["truncated"] for row in record["logs"].values()), "Continuation output incomplete")
                logs.close()
            except Exception as error:
                failure = failure or error; record["cleanupRefused"] = True
        if failure is None:
            try:
                verify_preservation(sealed, require_generation=True); final_journal(sealed["journal"], M.journal(HOME))
                record["scenarioPassed"] = record["continuousMigratedUserAccepted"] = broker_outcome(record)
            except Exception as error:
                failure = error
        if failure is not None:
            record.update(scenarioPassed=False, continuousMigratedUserAccepted=False,
                          recovery="unknown-no-retry-disposable-runner-teardown")
        U.save(CONTROL / "broker.json", record, 0o644)
    if failure is not None:
        raise failure


def export(env):
    admission(env)
    require(os.getuid() == os.geteuid() == 0, "Root-only bounded continuation export")
    output = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-evidence"
    require(output.parent.resolve() == output.parent and not os.path.lexists(output), "Exclusive continuation export required")
    uid = output.parent.stat().st_uid
    output.mkdir(mode=0o700); os.chown(output, uid, uid)
    files = [INTENT, *(CONTROL / name for name in ("broker.json", "state.json", "review.json", "session.stdout", "session.stderr")),
             *(OUTPUT / name for name in ("report.json", "root.json", "mcp-protocol.json", "html-driver.stdout", "html-driver.stderr",
                "successor-html-driver.stdout", "successor-html-driver.stderr", "initial-bitmap/root-window.png", "successor-bitmap/root-window.png"))]
    for name in ("existing", "reconnect"):
        files.extend(OUTPUT / "mcp" / name / leaf for leaf in ("sdk.stdout", "sdk.stderr", "sdk-result.json"))
    for index, file in enumerate(files):
        if not os.path.lexists(file):
            continue
        info = file.lstat(); require(info.st_uid in (0, M.UID), "Foreign evidence owner")
        raw = U.read(file, 16 * 1024**2 if file.suffix == ".png" else 2 * 1024**2)
        target = output / (str(index) + "__" + file.name)
        U.write(target, raw); os.chown(target, uid, uid)


def main():
    require(len(sys.argv) == 2, "One fixed continuation phase required")
    phase = sys.argv[1]
    require(phase in ("prepare", "broker", "session", "_tls-guard", "export"), "Unknown continuation phase")
    env = dict(os.environ)
    if phase == "_tls-guard":
        runtime_binding(env); U.tls_guard(env)
    else:
        {"prepare": prepare, "broker": broker, "session": native_session, "export": export}[phase](env)


if __name__ == "__main__":
    main()
