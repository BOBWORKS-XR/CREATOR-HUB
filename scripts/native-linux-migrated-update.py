"""One same-runner migrated-HOME DEB update, never a fresh fixture or retry.

The original migration finishes and relocks its account before this controller
may adopt anything. Unbound successor inputs confer no execution authority.
Inputs are independently pinned original ZIPs; this module never downloads them.
"""
import ctypes
import copy
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import select
import signal
import stat
import struct
import subprocess
import sys
import threading
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
    return tuple(sorted((set(M.SOURCES) - {"fixtures/journal-a-native-incoming.UNBOUND.json"}) | set(U.SOURCES) | {Path(__file__).name}))


def changed_sources():
    return tuple(sorted(set(sources()) | {"fixtures/journal-a-native-incoming.UNBOUND.json", "native-linux-localstorage-snapshot.py"}))


def changed_seal_sources(scripts, pins):
    require(set(pins) == set(changed_sources()), "Exact changed continuation source list required")
    (scripts / "fixtures").mkdir(mode=0o755)
    U.protected_ancestry(scripts / "fixtures")
    for name, expected in pins.items():
        U.write(scripts / name, U.bound(HERE / name, expected, 2 * 1024**2), 0o444)


_DIRECTORY_DIAGNOSTIC_ORIGIN = object()


def directory(path, uid):
    before = path.lstat()
    try:
        require(path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISDIR(before.st_mode)
                and before.st_uid == before.st_gid == uid and not before.st_mode & 0o022,
                "Owned canonical directory required")
    except RuntimeError as error:
        try:
            # Original lstat only; never reread, repair or reinterpret this refusal.
            relative = path.relative_to(HOME).as_posix()
            if (type(error) is RuntimeError and str(error) == "Owned canonical directory required"
                    and type(uid) is int and uid == M.UID and len(relative.encode()) <= 512
                    and "\\" not in relative and (relative == "." or all(part not in ("", ".", "..") for part in relative.split("/")))
                    and not hasattr(error, "directory_refusal") and not hasattr(error, "_directory_diagnostic_origin")):
                cached = {key: getattr(before, key) for key in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid",
                    "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")}
                error.directory_refusal = {"relativePath": relative, "expectedUid": uid, "lstat": cached}
                error._directory_diagnostic_origin = _DIRECTORY_DIAGNOSTIC_ORIGIN
        except Exception:
            pass  # Optional metadata cannot replace the same directory failure.
        raise
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


def transition_home_closure(manifests, manifest_pins, archives, inventories, verifier):
    """Pins must come from the independent Root/member review, never HOME."""
    for value in (manifests, manifest_pins, archives): U.keys(value, ("a", "b"))
    expected = U.review_transition_inputs(inventories, verifier)
    mcp = U.load("native-linux-update-mcp")
    parsed, groups = {}, {}
    def entries(entry, metadata):
        U.keys(entry, ("executable", "version", "files"))
        canonical = json.dumps({"executable": entry["executable"], "version": entry["version"],
            "files": dict(sorted(entry["files"].items()))}, separators=(",", ":"), ensure_ascii=False).encode()
        prefix = GENERATION_PARENT + hashlib.sha256(canonical).hexdigest()
        rows = {prefix: {"kind": "directory", "mode": 0o700}}
        for name, sha in entry["files"].items():
            U.safe_name(name)
            row = metadata[name]
            rows[prefix + "/" + name] = {"kind": "file", "size": row["size"], "sha256": sha, "mode": row["mode"]}
            parent = (prefix + "/" + name).rsplit("/", 1)[0]
            while parent != prefix:
                rows[parent] = {"kind": "directory", "mode": 0o755}
                parent = parent.rsplit("/", 1)[0]
        return prefix, rows
    for side in ("a", "b"):
        U.validate_pin(manifest_pins[side], 128 * 1024)
        raw, archive = manifests[side], archives[side]
        require(type(raw) is bytes and U.pin(raw) == manifest_pins[side], "Independent manifest byte pin differs")
        manifest = U.parse(raw)
        require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1
                and manifest["platform"] == "linux" and manifest["arch"] == "x86_64", "Exact Linux manifest required")
        U.keys(manifest["modules"], ("mcp", "setup")); U.keys(manifest["managedRouting"], ("protocol", "files"))
        require(type(manifest["managedRouting"]["protocol"]) is int and manifest["managedRouting"]["protocol"] == 1,
                "Exact routing protocol required")
        entry = manifest["modules"]["mcp"]
        U.keys(entry, ("executable", "version", "files"))
        require(entry["executable"] == "mcp/creator-works-mcp-launcher" and entry["version"] == mcp.SERVER["version"]
                and entry["files"] == {n: inventories[side][n]["sha256"] for n in mcp.MODULE_FILES}
                and manifest["managedRouting"]["files"] == {n: inventories[side][n]["sha256"] for n in mcp.ROUTING_FILES},
                "Manifest and independently signed inventories differ")
        binding = manifest["payloadArchive"]
        U.validate_pin({k: binding[k] for k in ("size", "sha256")})
        require(type(archive) is bytes and U.pin(archive) == {k: binding[k] for k in ("size", "sha256")}, "Bound archive differs")
        U.load("native-linux-016-stage").modules(io.BytesIO(archive), manifest)
        for name in mcp.MODULE_FILES + mcp.ROUTING_FILES:
            require(binding["files"][name]["size"] == inventories[side][name]["size"], "Resource size binding differs")
        setup = manifest["modules"]["setup"]
        U.keys(setup, ("executable", "version", "files"))
        require(setup["executable"] in setup["files"] and all(n.startswith("setup/") for n in setup["files"]), "Exact Setup entry required")
        routing = {"executable": "routing/creator-hub-mcp-router", "version": expected["sides"][side]["hubVersion"],
                   "files": manifest["managedRouting"]["files"]}
        groups[side] = {name: entries(value, binding["files"]) for name, value in (("mcp", entry), ("routing", routing), ("setup", setup))}
        require(groups[side]["mcp"][0] == GENERATION_PARENT + expected["sides"][side]["generation"], "Signed MCP generation differs")
        parsed[side] = manifest
    setup = parsed["a"]["modules"]["setup"]
    require(setup == parsed["b"]["modules"]["setup"] and all(
        parsed["a"]["payloadArchive"]["files"][n] == parsed["b"]["payloadArchive"]["files"][n] for n in setup["files"]),
        "A changed Setup entry needs a separate exact closure review")
    release = U.parse(expected["release"])
    U.keys(release, ("schemaVersion", "appId", "version", "platform", "architecture", "packageType", "assetName", "byteLength",
                     "sha256", "executableSha256", "identityProtocol", "lifecycleProtocol", "installerProtocol", "minHubVersion"))
    U.validate_pin({"size": release["byteLength"], "sha256": release["sha256"]})
    return expected, groups, release


_HOME_PATH_REFUSAL_ORIGIN = object()

_LOCAL_DB = "data/com.creatorworks.hub/localstorage/tauri_localhost_0.localstorage"
_LOCAL_WAL, _LOCAL_SHM = _LOCAL_DB + "-wal", _LOCAL_DB + "-shm"
_LOCAL_SIDECARS = frozenset((_LOCAL_WAL, _LOCAL_SHM))
_LOCAL_IDENTITY = ("kind", "dev", "ino", "uid", "gid", "mode")


def localstorage_identity(row, name):
    require(row["kind"] == "file" and row["uid"] == row["gid"] == M.UID and not row["mode"] & 0o022,
            "Owned localStorage sidecar required")
    require(name in _LOCAL_SIDECARS, "Unknown localStorage sidecar")
    result = {key: row[key] for key in _LOCAL_IDENTITY}
    if name == _LOCAL_SHM: result["size"] = row["size"]
    return result


def localstorage_observe(callback, *, baseline=None):
    """Hold the SQLite read transaction across the guard's full HOME inventory."""
    module = load("native-linux-localstorage-snapshot")
    with module.HeldReader(HOME / _LOCAL_DB, M.UID, HERE / "native-linux-localstorage-snapshot.py") as reader:
        first = tree(HOME, M.UID)
        require(all(name in first for name in (_LOCAL_DB, _LOCAL_WAL, _LOCAL_SHM)), "Exact localStorage files required")
        identities = {name: localstorage_identity(first[name], name) for name in _LOCAL_SIDECARS}
        opened = [(first[name]["dev"], first[name]["ino"]) for name in (_LOCAL_DB, _LOCAL_WAL)]
        reader.require_open_files(opened)
        if baseline is not None:
            require(set(first) == set(baseline) | _LOCAL_SIDECARS and not set(baseline) & _LOCAL_SIDECARS,
                    "Cold baseline sidecars differ")
            require(all(first[name] == row for name, row in baseline.items()), "Cold baseline HOME drift")
            require(first[_LOCAL_WAL]["size"] == 0, "Cold baseline WAL is not empty")
        result = reader.capture()
        after = tree(HOME, M.UID)
        require(all(name in after for name in (_LOCAL_DB, _LOCAL_WAL, _LOCAL_SHM)), "localStorage entry disappeared")
        require(first[_LOCAL_DB] == after[_LOCAL_DB] and first[_LOCAL_WAL] == after[_LOCAL_WAL],
                "localStorage database/WAL drift")
        require(all(localstorage_identity(after[name], name) == identities[name] for name in _LOCAL_SIDECARS),
                "localStorage sidecar identity drift")
        reader.require_open_files(opened)
        if baseline is not None:
            require(set(after) == set(baseline) | _LOCAL_SIDECARS
                    and all(after[name] == row for name, row in baseline.items()), "Cold baseline HOME changed")
        return callback(after, result, identities)


class TransitionHomePreservation:
    """Read-only preservation only; no admission, activation or protocol writer."""
    def __init__(self, adopted, manifests, manifest_pins, archives, inventories, verifier):
        require(HOME == U.BASE / "result/home" and M.UID == U.UID and HOME.resolve(strict=True) == HOME,
                "Exact original HOME/UID context required")
        self.expected, self.groups, release = transition_home_closure(manifests, manifest_pins, archives, inventories, verifier)
        self.before, self.journal = copy.deepcopy(adopted["home"]), copy.deepcopy(adopted["journal"])
        self.localstorage = copy.deepcopy(adopted.get("localstorage"))
        self._journal_mode = self.before[M.JOURNAL]["mode"]
        initial = tree(HOME, M.UID)
        if self.localstorage is None:
            require(initial == self.before, "Original adopted HOME drifted")
        else:
            require(set(initial) == set(self.before) | _LOCAL_SIDECARS
                    and not set(self.before) & _LOCAL_SIDECARS
                    and all(initial[name] == row for name, row in self.before.items()), "Original adopted HOME drifted")
            require(all(localstorage_identity(initial[name], name) == self.localstorage["identities"][name]
                        for name in _LOCAL_SIDECARS), "Original sidecar identity drift")
        self.R, self.E, self.D = "data/creator-hub/mcp-route-v1/linux-x86_64", "data/creator-hub-update-cache/deb/records", "data/creator-hub-update-cache/deb"
        self.active, self.handoff = self.R + "/active.json", self.E + "/mcp-route-update.json"
        require(not os.path.lexists(HOME / self.handoff), "Fresh gate refuses prior handoff; no supersession")
        self.a_capture = U.transition_file(HOME / self.active, 16384, mode=0o600)
        self.previous = bytes(self.a_capture["raw"])
        active = U.parse(self.previous)
        target = lambda side: {k: self.expected["sides"][side][k] for k in ("descriptorSha256", "generation")}
        require(type(active.get("schemaVersion")) is int and active == {"schemaVersion": 1, **target("a")}, "Actual signed A required")
        self.target = target("b")
        self.static = {name: {"kind": "directory", "mode": 0o700} for name in ("data/creator-hub-update-cache", self.D, self.E)}
        for name, raw in ((release["version"] + ".json", self.expected["release"]), (release["version"] + ".minisig", self.expected["signature"])):
            self.static[self.E + "/" + name] = {"kind": "file", "mode": 0o644, **U.pin(raw)}
        self.package = self.D + "/hub-" + release["sha256"] + ".deb"
        self.static[self.package] = {"kind": "file", "mode": 0o644, "size": release["byteLength"], "sha256": release["sha256"]}
        self.lock = self.E + "/mcp-route-update.lock"
        self.static[self.lock] = {"kind": "file", "mode": 0o600, **U.pin(b"")}
        self.descriptor = self.R + "/descriptors/" + self.target["descriptorSha256"]
        descriptor = {self.descriptor: {"kind": "directory", "mode": 0o700}}
        for name in ("runtime.json", "runtime.minisig"):
            descriptor[self.descriptor + "/" + name] = {"kind": "file", "mode": 0o600, **inventories["b"]["routing/" + name]}
        self.b_groups = [self.groups["b"][name] for name in ("mcp", "routing")] + [(self.descriptor, descriptor)]
        self.history = self.R + "/history/" + hashlib.sha256(self.previous).hexdigest() + ".json"
        self.static[self.R + "/history"] = {"kind": "directory", "mode": 0o700}
        self.static[self.history] = {"kind": "file", "mode": 0o600, **U.pin(self.previous)}
        self.pending, self.partial = self.E + "/" + release["version"] + ".pending", self.package[:-4] + ".part"
        require(self.pending not in self.before and self.partial not in self.before, "Existing transition temporary needs review")
        for name, (prefix, rows) in self.groups["a"].items():
            self._group(self.before, prefix, rows, required=name != "setup")
        original = {self.R: {"kind": "directory", "mode": 0o700}, self.R + "/descriptors": {"kind": "directory", "mode": 0o700},
                    self.R + "/router-v1": {"kind": "directory", "mode": 0o700}}
        for name in ("creator-hub-mcp-router", "router.json", "router.minisig"):
            original[self.R + "/router-v1/" + name] = {"kind": "file", "mode": 0o500 if name.startswith("creator-") else 0o600,
                                                        **inventories["a"]["routing/" + name]}
        d_a = self.R + "/descriptors/" + self.expected["sides"]["a"]["descriptorSha256"]
        original[d_a] = {"kind": "directory", "mode": 0o700}
        for name in ("runtime.json", "runtime.minisig"):
            original[d_a + "/" + name] = {"kind": "file", "mode": 0o600, **inventories["a"]["routing/" + name]}
        self._rows(self.before, original, required=True)
        for name in (GENERATION_PARENT + "prepare.lock", self.R + "/activate.lock", self.R + "/router-prepare.lock", "data/CreatorHub/operation.lock"):
            row = self.before[name]
            require(row["kind"] == "file" and row["size"] == 0 and not row["mode"] & 0o022, "Original empty lock required")
        for prefix, rows in self.b_groups: self._group(self.before, prefix, rows, required=False)
        self._rows(self.before, self.static, required=False)
        self._journal()
        self.allowed = set(self.static) | {self.handoff, self.pending, self.partial}
        if self.localstorage is not None: self.allowed.update(_LOCAL_SIDECARS)
        for _, rows in self.b_groups: self.allowed.update(rows)
        self.b_additions = set().union(*(set(rows) for _, rows in self.b_groups), {self.R + "/history", self.history})
        self._ready = self._record = self._active_b = None
        self._phase, self._seen, self._refused = None, {}, False

    def _rows(self, snapshot, expected, *, required):
        for name, wanted in expected.items():
            if name not in snapshot:
                require(not required, "Missing exact transition member: " + name)
                continue
            row = snapshot[name]
            nested_generation = (name.startswith(GENERATION_PARENT) and wanted == {"kind": "directory", "mode": 0o755})
            mode = row.get("mode")
            secure_mode = (nested_generation and type(mode) is int and mode & 0o700 == 0o700 and mode & ~0o755 == 0)
            require(all(row.get(k) == v or k == "mode" and secure_mode for k, v in wanted.items())
                    and row["dev"] == self.before["."]["dev"]
                    and row["uid"] == row["gid"] == M.UID, "Transition bytes/mode/owner/filesystem differ: " + name)

    def _group(self, snapshot, prefix, expected, *, required):
        present = {n for n in snapshot if n == prefix or n.startswith(prefix + "/")}
        require(not present and not required or present == set(expected), "Complete exact published generation/descriptor required")
        self._rows(snapshot, expected, required=bool(present) or required)

    def _journal(self):
        current = U.parse(U.read(HOME / M.JOURNAL, 65536, uid=M.UID))
        U.keys(current, ("revision", "records"))
        require(type(current["revision"]) is int and current["revision"] == 1 and type(current["records"]) is list, "Exact operation journal required")
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        require(canonical(current["records"][:len(self.journal["records"])]) == canonical(self.journal["records"]),
                "Original journal prefix changed, including JSON value types")
        count = len(current["records"]) - len(self.journal["records"])
        require(count in (0, 2, 4), "Only the original two MCP read pairs may append")
        if count == 0: require(current == self.journal, "Original journal changed")
        elif count == 2: journal_step(self.journal, current)
        else: final_journal(self.journal, current)
        return current

    def capture_ready(self):
        """Capture actual Ready only; full HOME preservation still needs check()."""
        require(not self._refused, "Preservation refusal is retained; no repair/retry")
        try:
            require(self._ready is None and self._phase is None, "Ready capture is spent; no replay/adoption")
            capture = U.transition_file(HOME / self.handoff, mode=0o600)
            U.transition_handoff(capture, self.expected, "Ready", self.previous)
            require(U.transition_file(HOME / self.active, 16384, mode=0o600) == self.a_capture,
                    "Original actual active A changed before Ready capture")
            require(U.transition_file(HOME / self.active, 16384, mode=0o600) == self.a_capture,
                    "Original actual active A changed during Ready capture")
            require(U.transition_file(HOME / self.handoff, mode=0o600) == capture,
                    "Ready changed during actual capture")
            self._ready = copy.deepcopy(capture)
            self._phase, self._record = "Ready", copy.deepcopy(capture)
        except Exception:
            self._refused = True
            raise

    def check(self, *, checkpoint="unspecified"):
        require(not self._refused, "Preservation refusal is retained; no repair/retry")
        try:
            self._check(checkpoint)
        except Exception:
            self._refused = True
            raise

    def _check(self, checkpoint):
        if self.localstorage is None:
            return self._check_inventory(checkpoint, tree(HOME, M.UID))
        def verify(after, result, identities):
            require(result == self.localstorage["sha256"] and identities == self.localstorage["identities"],
                    "Original localStorage logical contents or identity changed")
            return self._check_inventory(checkpoint, after)
        return localstorage_observe(verify)

    def _check_inventory(self, checkpoint, after):
        require(self.before.keys() <= after.keys(), "An original protected entry disappeared")
        capture, phase = None, None
        if os.path.lexists(HOME / self.handoff):
            capture = U.transition_file(HOME / self.handoff, mode=0o600)
            phase = U.parse(bytes(capture["raw"]))["phase"]
            require(phase in ("Ready", {"Attempting": self.target}, {"Completed": self.target}), "Unknown handoff phase")
            U.transition_handoff(capture, self.expected, phase, self.previous)
            require(after[self.handoff]["mode"] == 0o600, "Private handoff mode required")
            if phase == "Ready":
                require(self._phase in (None, "Ready") and (self._ready is None or capture == self._ready), "Ready identity/regression differs")
            else:
                require(self._ready is not None, "Actual prior Ready capture required")
                require(self._phase != {"Completed": self.target} or phase == self._phase, "Completed cannot regress")
                if self._phase == phase: require(capture == self._record, "Handoff phase identity changed")
        else:
            require(self._phase is None, "Observed handoff disappeared")
        complete = phase == {"Completed": self.target}
        active = U.transition_file(HOME / self.active, 16384, mode=0o600)
        if complete:
            value = U.parse(bytes(active["raw"]))
            require(type(value.get("schemaVersion")) is int and value == {"schemaVersion": 1, **self.target}
                    and after[self.active]["mode"] == 0o600 and after[self.active]["dev"] == self.before[self.active]["dev"]
                    and after[self.active]["ino"] != self.before[self.active]["ino"], "Only exact atomic active A->B is allowed")
            require(self._active_b is None or active == self._active_b, "Committed active B identity changed")
        else:
            require(active == self.a_capture, "Only original A is allowed before actual Completed")
        for name, wanted in self.before.items():
            if name == self.active and complete: continue
            if name == M.JOURNAL:
                fields = ("kind", "dev", "uid", "gid", "mode")
                old_mode, new_mode = self._journal_mode, after[name]["mode"]
                private_tightening = new_mode == 0o600 and old_mode in (0o644, 0o664, 0o666)
                require(all(after[name][k] == wanted[k] for k in fields if k != "mode")
                        and (new_mode == old_mode or private_tightening),
                        "Journal ownership/mode/filesystem changed: " + json.dumps(
                            {"before": {k: wanted[k] for k in fields}, "lastMode": old_mode,
                             "after": {k: after[name][k] for k in fields}},
                            sort_keys=True, separators=(",", ":")))
            else:
                require(after[name] == wanted, "Original protected bytes/identity changed: " + name)
        additions = after.keys() - self.before.keys()
        try:
            require(additions <= self.allowed, "Unexpected new HOME path; no prefix exemption")
        except RuntimeError as error:
            try:
                unknown = sorted(additions - self.allowed)
                paths = [name for name in unknown if type(name) is str and 0 < len(name.encode("utf-8")) <= 256
                         and not name.startswith("/") and "\\" not in name and all(ord(c) >= 32 and ord(c) != 127 for c in name)
                         and all(part not in ("", ".", "..") for part in name.split("/"))][:8]
                checkpoints = ("unspecified", "session-entry", "pre-update-input", "arm-before-input", "session-preservation", "broker-preservation")
                handoff = "none" if phase is None else "ready" if phase == "Ready" else "attempting" if phase == {"Attempting": self.target} else "completed"
                error.home_path_refusal = {"checkpoint": checkpoint if checkpoint in checkpoints else "unspecified", "handoffPhase": handoff,
                                           "paths": paths, "omittedCount": len(unknown) - len(paths), "authorityGranted": False}
                error._home_path_refusal_origin = _HOME_PATH_REFUSAL_ORIGIN
            except Exception:
                pass
            raise
        if phase not in ({"Attempting": self.target}, {"Completed": self.target}):
            require(not additions.intersection(self.b_additions), "No B publication before actual Attempting")
        for prefix, rows in self.b_groups: self._group(after, prefix, rows, required=complete)
        self._rows(after, self.static, required=False)
        if self.R + "/history" in additions or complete:
            self._rows(after, {k: self.static[k] for k in (self.R + "/history", self.history)}, required=True)
        if complete:
            require(self.pending not in after and self.partial not in after, "Final pending/partial files refused")
            self._rows(after, {k: v for k, v in self.static.items() if k not in (self.R + "/history", self.history)}, required=True)
        for name in (self.pending, self.partial):
            if name not in after: continue
            row = after[name]
            require(phase is None and row["kind"] == "file" and row["mode"] == 0o644, "Only pre-handoff exact cache progress allowed")
            if name == self.pending:
                raw = U.read(HOME / name, 32768, uid=M.UID, mode=0o644)
                require(self.expected["release"].startswith(raw) or self.expected["signature"].startswith(raw), "Pending metadata prefix differs")
            else:
                wanted = self.static[self.package]
                require(row["size"] <= wanted["size"] and (row["size"] < wanted["size"] or row["sha256"] == wanted["sha256"]), "Bounded signed-package partial differs")
        self._journal()
        for name, wanted in self._seen.items(): require(after.get(name) == wanted, "Published transition output identity changed")
        require(U.transition_file(HOME / self.active, 16384, mode=0o600) == active, "Active changed during snapshot")
        require(os.path.lexists(HOME / self.handoff) == (capture is not None), "Handoff changed during snapshot")
        if capture is not None: require(U.transition_file(HOME / self.handoff, mode=0o600) == capture, "Handoff changed during snapshot")
        self._seen.update({n: copy.deepcopy(after[n]) for n in additions
                           if n not in (self.pending, self.partial, self.handoff) and n not in _LOCAL_SIDECARS})
        if phase == "Ready" and self._ready is None: self._ready = copy.deepcopy(capture)
        if complete and self._active_b is None: self._active_b = copy.deepcopy(active)
        self._journal_mode = after[M.JOURNAL]["mode"]
        self._phase, self._record = copy.deepcopy(phase), copy.deepcopy(capture)

    def finish(self):
        self.check()
        try:
            require(self._phase == {"Completed": self.target}, "Actual Completed required; preservation progress is not success")
            final_journal(self.journal, self._journal())
        except Exception:
            self._refused = True
            raise


_READY_NAME = b"mcp-route-update.json"
_READY_MASK = 0xFCE


def _ready_event_batch(raw, wd):
    require(type(raw) is bytes and 0 < len(raw) <= 65536, "Bounded inotify event batch required")
    offset, found = 0, 0
    while offset < len(raw):
        require(len(raw) - offset >= 16, "Truncated inotify header")
        watch, mask, cookie, length = struct.unpack_from("=iIII", raw, offset)
        offset += 16
        require(length <= 4096 and length <= len(raw) - offset, "Truncated/oversized inotify name")
        encoded = raw[offset:offset + length]; offset += length
        if encoded:
            name, separator, padding = encoded.partition(b"\0")
            require(separator and not padding.strip(b"\0"), "Invalid inotify name padding")
        else:
            name = b""
        require(not mask & 0x4000, "Ready watch overflow; observation lost")
        require(watch == wd and not mask & ~(_READY_MASK | 0x40000000), "Foreign/invalidated Ready watch")
        require(name and not mask & (0x400 | 0x800), "Ready parent/watch changed")
        if name == _READY_NAME:
            require(mask == 0x80 and cookie > 0, "Only exact atomic Ready publication may trigger capture")
            found += 1
            require(found == 1, "Ready publication is ambiguous in queued events")
    return found == 1


class _ReadyInotify:
    """Private Linux FD boundary; never a product lock, signal or child."""
    def __init__(self, parent):
        require(sys.platform == "linux", "Linux Ready notifier only")
        self.parent, self.identity = parent, directory(parent, M.UID)
        require(self.identity["mode"] == 0o700, "Exact private Ready parent required")
        self.parent_fd = self.fd = self.stop_read = self.stop_write = None
        self._fd_lock = threading.Lock()
        try:
            self.parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.check_parent()
            libc = ctypes.CDLL(None, use_errno=True)
            libc.inotify_init1.argtypes, libc.inotify_init1.restype = [ctypes.c_int], ctypes.c_int
            libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            libc.inotify_add_watch.restype = ctypes.c_int
            self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
            if self.fd < 0:
                self.fd = None
                raise OSError(ctypes.get_errno(), "Cannot initialize Ready inotify")
            self.stop_read, self.stop_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
            self.wd = libc.inotify_add_watch(self.fd, os.fsencode(parent), _READY_MASK | 0x1000000 | 0x2000000)
            if self.wd < 0: raise OSError(ctypes.get_errno(), "Cannot watch exact Ready parent")
            self.check_parent()
        except Exception as error:
            try: self.close()
            except Exception as cleanup: raise error from cleanup
            raise

    def check_parent(self):
        named, held = directory(self.parent, M.UID), os.fstat(self.parent_fd)
        row = {"dev": held.st_dev, "ino": held.st_ino, "uid": held.st_uid,
               "gid": held.st_gid, "mode": stat.S_IMODE(held.st_mode)}
        require(stat.S_ISDIR(held.st_mode) and row == named == self.identity, "Ready parent drift")

    def pending(self):
        try: raw = os.read(self.fd, 65536)
        except BlockingIOError: return b""
        require(raw, "Unexpected Ready inotify EOF")
        return raw

    def wait(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError("Ready deadline expired")
        poll = select.poll()
        poll.register(self.fd, select.POLLIN); poll.register(self.stop_read, select.POLLIN)
        events = poll.poll(math.ceil(remaining * 1000))
        if not events: raise TimeoutError("Ready deadline expired")
        for fd, mask in events:
            require(fd in (self.fd, self.stop_read) and mask == select.POLLIN, "Ready notifier FD refused")
            if fd == self.stop_read: raise RuntimeError("Ready watcher closed before capture")
        raw = self.pending()
        require(raw, "Ready notification disappeared")
        return raw

    def wake(self):
        with self._fd_lock:
            if self.stop_write is not None: os.write(self.stop_write, b"x")

    def close(self):
        first = None
        with self._fd_lock:
            for name in ("fd", "parent_fd", "stop_read", "stop_write"):
                fd = getattr(self, name); setattr(self, name, None)
                if fd is not None:
                    try: os.close(fd)
                    except Exception as error: first = first or error
        if first is not None: raise first


class _NativeReadyWatcher:
    def __init__(self, guard, protocol, deadline):
        self.guard, self.protocol, self.deadline = guard, protocol, deadline
        self._validate_context()
        self._kernel = self._thread = self._error = self._result = None
        self._armed, self._started = False, threading.Event()

    def _validate_context(self):
        guard, protocol, deadline = self.guard, self.protocol, self.deadline
        require(type(self) in (SessionReadyWatcher, BrokerReadyWatcher), "Only two fixed Ready watcher roles")
        require(sys.platform == "linux" and M.UID == U.UID and M.UID > 0, "Native Linux Ready watcher only")
        self._session = type(self) is SessionReadyWatcher
        uid = M.UID if self._session else 0
        require(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == uid, "Exact Ready controller UID/GID required")
        require(type(guard) is TransitionHomePreservation
                and guard.handoff == "data/creator-hub-update-cache/deb/records/mcp-route-update.json"
                and guard.active == "data/creator-hub/mcp-route-v1/linux-x86_64/active.json"
                and HOME == U.BASE / "result/home", "Exact original HOME guard required")
        require(type(deadline) in (int, float) and math.isfinite(deadline)
                and 0 < deadline - time.monotonic() <= 900, "Finite existing Ready deadline required")
        if self._session:
            require(type(protocol) is U.TransitionProtocolCapture and protocol.expected == guard.expected
                    and protocol.captures == {"activeA": guard.a_capture}
                    and protocol.spent is False and protocol.ready_started is False
                    and protocol.fixture.started is True and protocol.fixture.connection is not None,
                    "Exact bound started protocol capture required")
        else:
            require(protocol is None, "Broker captures only its own actual HOME Ready")

    def _latch(self, error):
        self._error = self._error or error
        if type(self.guard) is TransitionHomePreservation: self.guard._refused = True
        if type(self.protocol) is U.TransitionProtocolCapture: self.protocol.spent = True

    def arm(self):
        try:
            require(self._error is None and not self._armed, "Ready watcher attempt is spent")
            self._validate_context()
            require(not self.guard._refused and self.guard._ready is None
                    and self.guard._phase is None, "Ready watcher attempt is spent")
            self._armed = True
            require(not os.path.lexists(HOME / self.guard.handoff), "Ready must be absent before watcher arm")
            self._kernel = _ReadyInotify((HOME / self.guard.handoff).parent)
            require(not os.path.lexists(HOME / self.guard.handoff), "Ready appeared while arming; no adoption")
            self._kernel.check_parent()
            self._thread = threading.Thread(target=self._run, name="creator-ready-watch", daemon=False)
            self._thread.start()
            require(self._started.wait(max(0, self.deadline - time.monotonic())), "Ready watcher did not arm by deadline")
            if self._error is not None: raise self._error
        except Exception as error:
            self._latch(error)
            self.close()
            raise

    def _run(self):
        try:
            self._kernel.check_parent(); self._started.set()
            total = 0
            while True:
                raw = self._kernel.wait(self.deadline)
                total += len(raw); require(total <= 1024**2, "Ready watch event bound exceeded")
                self._kernel.check_parent()
                if _ready_event_batch(raw, self._kernel.wd): break
            if time.monotonic() >= self.deadline: raise TimeoutError("Ready capture missed deadline")
            if self.protocol is not None: U.TransitionProtocolCapture.capture_ready(self.protocol)
            TransitionHomePreservation.capture_ready(self.guard)
            if self.protocol is not None:
                require(self.protocol.captures["ready"] == self.guard._ready, "Independent session Ready captures differ")
            while True:
                raw = self._kernel.pending()
                if not raw: break
                total += len(raw); require(total <= 1024**2, "Ready watch event bound exceeded")
                require(not _ready_event_batch(raw, self._kernel.wd), "Ready changed while collecting capture")
            self._kernel.check_parent()
            require(U.transition_file(HOME / self.guard.handoff, mode=0o600) == self.guard._ready,
                    "Actual Ready changed after capture")
            if time.monotonic() >= self.deadline: raise TimeoutError("Ready capture missed deadline")
            self._result = copy.deepcopy(self.guard._ready)
        except Exception as error:
            self._latch(error)
        finally:
            try: self._kernel.close()
            except Exception as error: self._latch(error)
            self._started.set()

    def wait(self):
        require(self._armed and self._thread is not None, "Ready watcher was not armed")
        self._thread.join(max(0, self.deadline - time.monotonic()))
        if self._thread.is_alive():
            self._latch(TimeoutError("Ready deadline expired; worker cleanup unknown"))
            self._kernel.wake()
            self._thread.join(max(0, self.deadline - time.monotonic()))
        require(not self._thread.is_alive(), "Ready worker cleanup unknown; no acceptance")
        if self._error is not None: raise self._error
        require(self._result is not None, "Actual Ready capture is missing")
        return copy.deepcopy(self._result)

    def close(self):
        if self._thread is not None and self._thread.is_alive():
            self._kernel.wake()
            self._thread.join(max(0, self.deadline - time.monotonic()))
            if self._thread.is_alive():
                self._latch(RuntimeError("Ready worker cleanup unknown"))
                raise self._error
        if self._kernel is not None:
            self._kernel.close()


class SessionReadyWatcher(_NativeReadyWatcher):
    def __init__(self, guard, protocol, deadline):
        super().__init__(guard, protocol, deadline)


class BrokerReadyWatcher(_NativeReadyWatcher):
    def __init__(self, guard, deadline):
        super().__init__(guard, None, deadline)


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
    if html.projects_filter_value() != "all":
        html.click('#project-sdk option[value="all"]', report.setdefault(phase + "FilterActions", []), "projects-filter-all")
    require(html.projects_filter_value() == "all", "Expected all-projects filter required")
    require(len(html.d.elements("#project-list .project-row")) == 2, "Migrated Projects inventory differs")
    for selected, name in (("true", "current-project"), ("false", "missing-project")):
        selector = '#project-list .project-row[data-mcp-selected="' + selected + '"]'
        require(len(html.d.elements(selector)) == 1 and html.d.read(selector + " .project-info small") == str(home / name),
                "Migrated Projects selection/path changed")
    report[phase] = {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}


def _continuation_checks(report):
    require(report.get("scope") == "continuous-migrated-home-private017-lifecycle-only"
            and report.get("beforeMigrationConnectionContinued") is False
            and report.get("migrationEvidencePreserved") is True and report.get("homePreserved") is True
            and report.get("journalPrefixPreserved") is True
            and all(report.get(phase) == {"projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}
                    for phase in ("initialProjects", "successorProjects")), "Complete migrated-HOME continuation evidence required")


def continuation_outcome(report):
    U.outcome("deb-approve", report)
    _continuation_checks(report)
    return True


def transition_continuation_outcome(report, inventories, verifier, protected_paths):
    U.transition_outcome(report, inventories, verifier, protected_paths)
    _continuation_checks(report)
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
        wm_env = M.window_manager_environment(dict(os.environ), "migrated")
        wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=wm_env)
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
        subprocess.run(["/usr/bin/openbox", "--exit"], stdin=subprocess.DEVNULL, check=True, env=wm_env)
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


CHANGED_PROFILE_SHA = "ef2b5a589d934bf48306ddfd53d133513f3ab4d22b9622672f76887cb7acb095"
CHANGED_INCOMING_PROFILE_SHA = "08f2df3b8139f00f5bd5b84619218228c7878d62ae0e4ec180fdcaaec6b87fc3"
CHANGED_SOURCE_RECEIPT_ENV = "CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256"
CHANGED_DELIVERY = (689113479, "signed-private-deb017-carrier-40903331594.zip", 64479116,
                    "9719b4d8d205b4d8a61c0b4bb77c056110a227e7f0a8aa9aba23f7787da7bbde")
CHANGED_CASE = "a1-actual017-changed-mcp"
CHANGED_PROTECTED = (U.CONFIG, M.LEGACY, U.PREFS, U.TERMS, ".claude.json", ".codex/config.toml")
CHANGED_INSTALLER_SOURCES = {
    "src-tauri/examples/private-deb017-dea67.rs": {"size": 20520, "sha256": "d7c8eab95b36846a7a8a1d1aed0745c91af37b73f5dbfeed2c453711f7566803"},
    "src-tauri/src/catalog-key.pub": {"size": 119, "sha256": "23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308"},
    "src-tauri/src/catalog.rs": {"size": 21838, "sha256": "9274a9663878d8ba58557cb8175d483357ab10cf95f0b0818ceb78170febe666"},
    "src-tauri/src/update_target.rs": {"size": 12219, "sha256": "d02b0f173d7203e7e39b0ac1e2ef3b10d1738fcd5af7f2ce6a537d68110a26f9"},
    "src-tauri/Cargo.toml": {"size": 2488, "sha256": "aec159f9b59205603ff2ff65fab868341b6fa3146abc72fdea36b949cb963e1a"},
    "src-tauri/Cargo.lock": {"size": 144663, "sha256": "a9adc1d441d9de2db6ea7b09cdeada20657daa07563f1719e3814a134e9e8764"},
    "src-tauri/build.rs": {"size": 3499, "sha256": "4894c38042003c92d278055a00f2fe490ae7ea24485bce91ecfa5202d8b48680"},
    "src-tauri/tauri.conf.json": {"size": 1646, "sha256": "0e28e4262e8d259a08a9c0cf815f5af34b7ae1e0e361e47f3162e6d76bdf5e66"},
}
CHANGED_INSTALLER_GUARD = {"size": 26150, "sha256": "dfe54cfa1b93c380bc1ed3699a0696db683ea60890f186da61cfb8b7612dffc8"}


def changed_require_bound():
    require(all(type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value) for value in
                (CHANGED_PROFILE_SHA, CHANGED_INCOMING_PROFILE_SHA))
            and type(CHANGED_DELIVERY) is tuple and len(CHANGED_DELIVERY) == 4,
            "Changed-payload production profile/carrier/source receipt UNBOUND; no input or privilege")
    asset, name, size, sha = CHANGED_DELIVERY
    require(type(asset) is int and asset > 0 and type(name) is str and re.fullmatch(r"[A-Za-z0-9._-]+\.zip", name)
            and type(size) is int and 0 < size <= U.MAX_ZIP and type(sha) is str and re.fullmatch(r"[a-f0-9]{64}", sha),
            "Changed-payload exact carrier UNBOUND")


def changed_admission(env):
    changed_require_bound()
    require(type(env.get(CHANGED_SOURCE_RECEIPT_ENV)) is str and re.fullmatch(r"[a-f0-9]{64}", env[CHANGED_SOURCE_RECEIPT_ENV]),
            "External independently reviewed test-source receipt UNBOUND")
    require(callable(U.__dict__.get("actual017_reopened_html_pages")), "Reviewed fixed reopened-B factory is not integrated")
    require(M.admission(env) == "migration-approve", "Only completed A1 migration approval may continue")
    require(env.get("CREATOR_MIGRATED_UPDATE_EXECUTE") == env.get("UPDATE_EXECUTE") == "true"
            and env.get("UPDATE_SCENARIO") == "deb-approve" and env.get("UPDATE_PROFILE_SHA256") == CHANGED_PROFILE_SHA,
            "Exact separately opted-in changed-payload approval required")
    require(all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
            and not any(re.match(r"^(LD_|DYLD_|PYTHON|TAURI_|WEBKIT_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)", k)
                        or k.lower().endswith("proxy") for k in env), "Inherited override or incomplete run identity refused")


def changed_context(env):
    return {"case": CHANGED_CASE, "source": env["GITHUB_SHA"], "run": env["GITHUB_RUN_ID"],
            "attempt": env["GITHUB_RUN_ATTEMPT"], "workflow": env["GITHUB_WORKFLOW_REF"], "boot": boot_id(),
            "incomingProfile": CHANGED_INCOMING_PROFILE_SHA, "outgoingProfile": CHANGED_PROFILE_SHA,
            "sourceReceipt": env[CHANGED_SOURCE_RECEIPT_ENV], "fromSource": U.actual017_a1_data()["source"],
            "targetSource": U.actual017_target_data()["source"], "donorSource": "c5bd13a5145aa54a50f28f073e1543826a210a4e"}


def changed_incoming_profile(raw):
    require(U.pin(raw)["sha256"] == CHANGED_INCOMING_PROFILE_SHA, "Exact independent A1 incoming profile required")
    value = M.P.profile(U.parse(raw)); a1 = U.actual017_a1_data()
    assembly = value["assembly"]
    expected = {"sourceCommit": a1["source"], "sourceTree": a1["tree"], "runId": a1["run"], "runAttempt": 1,
                "jobId": a1["job"], "artifactId": a1["artifact"], "zipBytes": a1["zip"]["size"], "zipSha256": a1["zip"]["sha256"]}
    require(assembly == expected and value["mode"] == "pages", "Actual incoming A1, not B016 donor, required")
    for key, field in (("rawHub", "raw"), ("hub", "hub"), ("deb", "deb"), ("modulesArchive", "archive"),
                       ("helper", "helper"), ("policy", "policy"), ("service", "service")):
        require(value["pins"][key] == a1[field], "Incoming A1 byte pin differs")
    return value


def changed_profile(raw):
    changed_require_bound()
    require(U.pin(raw)["sha256"] == CHANGED_PROFILE_SHA, "Exact changed-payload outgoing profile required")
    value = U.parse(raw)
    U.keys(value, ("schemaVersion", "profile", "fromVersion", "toVersion", "baseline", "artifacts", "deliveries", "objects"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["profile"] == U.PROFILE
            and value["fromVersion"] == "0.1.16" and value["toVersion"] == "0.1.17", "Closed actual017 DEB profile required")
    baseline, target = value["baseline"], U.actual017_target_data()
    a1 = U.actual017_a1_data(); U.keys(baseline, tuple(a1))
    require(all(type(baseline[k]) is type(v) and baseline[k] == v for k, v in a1.items()),
            "Joined execution baseline is exact A1, never the B016 packaging donor")
    for key in ("zip", "raw", "deb", "hub", "archive", "helper", "policy", "service"):
        U.validate_pin(baseline[key], U.MAX_ZIP if key == "zip" else U.MAX_FILE)
    U.keys(value["artifacts"], ("assembly16", "assembly17")); U.keys(value["deliveries"], ("signedDeb17",))
    U.keys(value["objects"], ("deb16", "deb17", "raw16", "raw17", "assemblyReceipt16", "debDescriptor17", "debSignature17", "latest17",
                            "installer17", "installerSignature17", "outerPlan17", "outerApi17", "outerReceipt17"))
    for role, expected, branch, workflow in (("assembly16", baseline, "validation/journal-a-assembly-016", "unix-managed-assembly"),
            ("assembly17", target, "validation/linux-private-update-fixture-017", "private-linux-update-fixture-017")):
        row = value["artifacts"][role]
        U.keys(row, ("source", "tree", "branch", "workflow", "run", "attempt", "job", "artifact", "name", "zip", "files"))
        require(all(type(row[k]) is type(expected[k]) and row[k] == expected[k]
                    for k in ("source", "tree", "run", "job", "artifact", "zip"))
                and type(row["attempt"]) is int and row["attempt"] == 1
                and all(type(row[k]) is int and row[k] > 0 for k in ("run", "job", "artifact"))
                and all(type(row[k]) is str and re.fullmatch(r"[a-f0-9]{40}", row[k]) for k in ("source", "tree"))
                and row["branch"] == branch and row["workflow"] == ".github/workflows/" + workflow + ".yml"
                and re.fullmatch(r"[A-Za-z0-9._-]{1,160}", row["name"]), "Exact A1/actual017 original producer required")
        U.validate_pin(row["zip"], U.MAX_ZIP)
        require(type(row["files"]) is dict and len(row["files"]) == (23 if role == "assembly16" else 8), "Complete actual A1/B017 23/8 original member maps required")
    delivery = value["deliveries"]["signedDeb17"]
    U.keys(delivery, ("asset", "name", "zip", "files"))
    asset, name, size, sha = CHANGED_DELIVERY
    require(type(delivery["asset"]) is int and delivery["asset"] == asset and delivery["name"] == name
            and delivery["zip"] == {"size": size, "sha256": sha} and len(delivery["files"]) == 8, "Exact eight-member actual017 signed carrier required")
    for row in U.input_roles(value).values():
        require(type(row["files"]) is dict and 0 < len(row["files"]) <= 32
                and len({n.lower() for n in row["files"]}) == len(row["files"]), "Complete finite original ZIP inventory required")
        for name, expected in row["files"].items(): U.safe_name(name); U.validate_pin(expected)
    for name, row in value["objects"].items():
        U.keys(row, ("artifact", "member"))
        require(row["artifact"] in U.input_roles(value) and row["member"] in U.input_roles(value)[row["artifact"]]["files"], "Object outside exact ZIP")
        if name in ("deb16", "raw16", "deb17", "raw17"):
            expected = baseline if name.endswith("16") else target
            require(row["artifact"] == "assembly" + name[-2:] and U.object_pin(value, name) == expected[name[:-2]], "Original Root/package object differs")
        else:
            require(row["artifact"] == ("assembly16" if name == "assemblyReceipt16" else "signedDeb17"), "Signed metadata/provenance role differs")
    require(len({(r["artifact"], r["member"]) for r in value["objects"].values()}) == len(value["objects"]), "Object aliases refused")
    require(U.object_pin(value, "installer17") == target["deb"], "Carrier installer must match actual original B017 DEB")
    require(U.object_pin(value, "outerPlan17") == {"size": 4789, "sha256": "bab785cdbce7faee4a9ab9cca9fea9b27ca9268b2f73483024286f03c1531401"}, "Exact canonical outer plan required")
    return value


def changed_acquisition(raw, value, env):
    proof = U.parse(raw)
    U.keys(proof, ("schemaVersion", "source", "run", "attempt", "profileSha256", "sourceReceiptSha256", "harnessRun", "proof", "release", "asset", "dataOnly", *U.FALSE))
    require(type(proof["schemaVersion"]) is int and proof["schemaVersion"] == 1 and proof["source"] == env["GITHUB_SHA"]
            and type(proof["run"]) is int and proof["run"] == int(env["GITHUB_RUN_ID"])
            and type(proof["attempt"]) is int and proof["attempt"] == int(env["GITHUB_RUN_ATTEMPT"])
            and proof["profileSha256"] == CHANGED_PROFILE_SHA and proof["sourceReceiptSha256"] == env[CHANGED_SOURCE_RECEIPT_ENV]
            and proof["dataOnly"] is True
            and all(proof[k] is False for k in U.FALSE), "Original data-only acquisition identity differs")
    current = proof["harnessRun"]
    require(type(current) is dict and all(current.get(k) == v for k, v in {
        "id": int(env["GITHUB_RUN_ID"]), "run_attempt": int(env["GITHUB_RUN_ATTEMPT"]), "head_sha": env["GITHUB_SHA"],
        "head_branch": M.BRANCH.removeprefix("refs/heads/"), "path": ".github/workflows/native-linux-production-016-migration.yml",
        "event": "workflow_dispatch", "conclusion": None}.items()) and current.get("status") in ("queued", "in_progress")
        and all(current.get(k, {}).get("id") == 1364807512 and current[k].get("full_name") == U.REPO
                for k in ("repository", "head_repository")), "Original current workflow API/source differs")
    U.keys(proof["proof"], ("assembly16", "assembly17"))
    for role, expected in value["artifacts"].items(): U.validate_api(proof["proof"][role], expected)
    release, asset = proof["release"], proof["asset"]
    require(release.get("id") == U.PRIVATE_RELEASE and release.get("tag_name") == U.PRIVATE_TAG and release.get("draft") is True,
            "Exact private draft provenance required")
    expected = value["deliveries"]["signedDeb17"]
    require(all(asset.get(k) == v for k, v in {"id": expected["asset"], "name": expected["name"], "state": "uploaded",
            "size": expected["zip"]["size"], "digest": "sha256:" + expected["zip"]["sha256"]}.items()), "Actual signed carrier API differs")
    return proof


def changed_source_receipt(env):
    file = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-input/source-receipt.json"
    raw = U.bound(file, {"size": file.lstat().st_size, "sha256": env[CHANGED_SOURCE_RECEIPT_ENV]}, 2 * 1024**2)
    value = U.parse(raw); U.keys(value, ("schemaVersion", "source", "tree", "files"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["source"] == env["GITHUB_SHA"]
            and type(value["tree"]) is str and re.fullmatch(r"[a-f0-9]{40}", value["tree"]), "Exact externally reviewed test source required")
    workspace = Path(env["GITHUB_WORKSPACE"])
    for args, expected in ((["rev-parse", "HEAD"], value["source"]), (["rev-parse", "HEAD^{tree}"], value["tree"])):
        require(U.run_tool(["/usr/bin/git", "-C", str(workspace), *args], limit=4096).decode().strip() == expected, "Actual checkout source/tree differs")
    listed = U.run_tool(["/usr/bin/git", "-C", str(workspace), "ls-tree", "-r", "--name-only", "HEAD"], limit=512 * 1024).decode().splitlines()
    require(type(value["files"]) is dict and 0 < len(value["files"]) <= 4096 and set(value["files"]) == set(listed), "Complete finite source export receipt required")
    for name, expected in value["files"].items(): U.safe_name(name); U.bound(workspace / name, expected, 16 * 1024**2)
    for name in changed_sources(): require("scripts/" + name in value["files"], "Missing execution source")
    for name, expected in U.MCP_OBSERVER_PINS.items():
        require(value["files"].get("native/mcp-router/" + name) == expected, "Exact separately reviewed observer source missing")
    for name, expected in CHANGED_INSTALLER_SOURCES.items():
        require(value["files"].get(name) == expected, "Exact portable actual017 verifier source closure missing")
    require(value["files"].get("src-tauri/examples/private-deb017-dea67-guards.rs") == CHANGED_INSTALLER_GUARD,
            "Exact standalone fixture qualification tests missing")
    return raw, value


def changed_prepare(env):
    changed_admission(env)
    source_raw, source = changed_source_receipt(env)
    require(os.getuid() == os.geteuid() == 0 and not os.path.lexists(BASE) and not os.path.lexists(INTENT), "Fresh pre-migration intent required")
    U.protected_ancestry(INTENT.parent)
    incoming = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-input/profile.json"
    incoming_raw = U.read(incoming, 65536); changed_incoming_profile(incoming_raw)
    folder = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-input"
    raw = U.read(folder / "profile.json", 65536); value = changed_profile(raw)
    expected_names = {"profile.json", "source-receipt.json", "acquisition.json", "assembly17.zip", "signedDeb17.zip"}
    require({p.name for p in folder.iterdir()} == expected_names, "Only exact profiles, source/acquisition receipts and original ZIPs required")
    changed_acquisition(U.read(folder / "acquisition.json", 2 * 1024**2), value, env)
    pins = {name: U.pin(U.read(folder / name, 2 * 1024**2)) for name in ("profile.json", "source-receipt.json", "acquisition.json")}
    for name in ("assembly17", "signedDeb17"):
        pins[name + ".zip"] = U.pin(U.bound(folder / (name + ".zip"), U.input_roles(value)[name]["zip"], U.MAX_ZIP))
    U.bound(incoming.parent / "assembly.zip", U.actual017_a1_data()["zip"], U.MAX_ZIP)
    verifier, qualification = U.offline_verifier(env)
    installer_tool, installer_qualification = changed_installer_verifier(env)
    driver = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
    node = U.read(Path(env["CONTROLLER_NODE"]), 128 * 1024**2, mode=0o755)
    require(node[:4] == b"\x7fELF", "Exact provisioned native Node required")
    value = {"schemaVersion": 1, "context": changed_context(env), "inputs": pins, "incoming": U.pin(incoming_raw),
             "sourceReceipt": U.pin(source_raw), "sourceTree": source["tree"], "verifier": qualification, "installerVerifier": installer_qualification,
             "sources": {name: source["files"]["scripts/" + name] for name in changed_sources()},
             "observerSources": dict(U.MCP_OBSERVER_PINS), "driver": U.pin(U.read(driver, 64 * 1024**2, mode=0o755)), "node": U.pin(node)}
    U.save(INTENT, value, 0o644)


def changed_intent(env):
    changed_admission(env)
    value = U.parse(U.read(INTENT, 65536, uid=0, mode=0o644))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["context"] == changed_context(env)
            and set(value["sources"]) == set(changed_sources()) and value["observerSources"] == U.MCP_OBSERVER_PINS,
            "Original changed-payload run/boot/source intent differs")
    for name, expected in value["sources"].items(): U.bound(HERE / name, expected, 2 * 1024**2)
    return value


def changed_adopt(env, original):
    broker = U.parse(U.read(BASE / "broker.json", 1048576, uid=0, mode=0o644))
    report = U.parse(U.read(BASE / "result/report.json", 1048576, uid=M.UID, mode=0o600))
    batch = U.parse(U.read(HOME / "data/CreatorHub/convergence/move-v1.json", 8192, uid=M.UID))
    migration_gate(broker, report, batch)
    require(report["harnessSource"] == env["GITHUB_SHA"], "Foreign migration test source")
    raw = U.read(BASE / "binding.json", 1048576, uid=0, mode=0o644); binding = U.parse(raw)
    M.check_request(U.parse(U.read(BASE / "execution-request.json", 16384, uid=0, mode=0o644)), env, raw)
    require(report["bindingSha256"] == U.pin(raw)["sha256"], "Actual migration binding differs")
    incoming_raw = U.read(Path(env["RUNNER_TEMP"]) / "native-linux-production-016-input/profile.json", 65536)
    require(binding["profile"] == changed_incoming_profile(incoming_raw) and U.pin(incoming_raw) == original["incoming"], "Actual A1 incoming profile changed")
    M.installed(binding, (True, True))
    require(U.load("native-linux-polkit-probe").fixture_credential("status") == "L", "Original migration account must be locked")
    require(U.parse(U.read(HOME / U.PREFS))["restoreHostedViews"] is False, "Original migrated Projects startup required")
    before = tree(HOME, M.UID)
    require(_LOCAL_DB in before and not set(before) & _LOCAL_SIDECARS, "Cold localStorage baseline required")
    localstorage = localstorage_observe(lambda after, value, identities: {"sha256": value, "identities": identities}, baseline=before)
    require(any(".creator-hub-settings-backups/" in n for n in before) and any("client-migrations-v1/" in n for n in before), "Original backups/client histories missing")
    journal = M.journal(HOME)
    require(report["operationJournals"]["reopened"]["file"] == U.pin(U.read(HOME / M.JOURNAL, 65536)), "Final original migration journal changed")
    require(not os.path.lexists(HOME / "data/creator-hub-update-cache/deb/records/mcp-route-update.json"), "No seeded/prior handoff may be adopted")
    return {"schemaVersion": 1, "context": original["context"], "reports": captured_reports(), "home": before, "journal": journal, "localstorage": localstorage,
            "transactions": {str(p): tree(p, 0) for p in TRANSACTIONS}, "batch": batch, "binding": binding, "accountUid": M.UID, "legacy": legacy_state()}


def _changed_migration_preservation(sealed, guard):
    require(type(guard) is TransitionHomePreservation and guard.before == sealed["home"] and guard.journal == sealed["journal"], "Exact independently constructed HOME guard required")
    require(captured_reports() == sealed["reports"], "Original migration reports changed")
    require(legacy_state() == sealed["legacy"], "Original retained runtime/GUI absence changed")
    require(U.parse(U.read(HOME / "data/CreatorHub/convergence/move-v1.json", 8192)) == sealed["batch"], "Original migration cleanup state changed")


def changed_session_preservation(sealed, guard, *, checkpoint="session-preservation"):
    require(os.getuid() == os.geteuid() == M.UID, "Ordinary-UID preservation only")
    _changed_migration_preservation(sealed, guard); guard.check(checkpoint=checkpoint)


def changed_broker_preservation(sealed, guard):
    require(os.getuid() == os.geteuid() == 0, "Root broker preservation only")
    _changed_migration_preservation(sealed, guard)
    require(set(sealed["transactions"]) == {str(p) for p in TRANSACTIONS}, "Exact retirement paths required")
    for name, before in sealed["transactions"].items(): require(tree(Path(name), 0) == before, "Original retirement state changed")
    guard.check(checkpoint="broker-preservation")


def changed_resources(manifest_raw, archive_raw):
    import gzip
    import tarfile
    manifest = U.parse(manifest_raw)
    hashes = U.load("native-linux-016-stage").modules(io.BytesIO(archive_raw), manifest)
    mcp = U.load("native-linux-update-mcp")
    names = mcp.MODULE_FILES + mcp.ROUTING_FILES
    require(set(names) == set(manifest["modules"]["mcp"]["files"]) | set(manifest["managedRouting"]["files"]), "Exact fourteen MCP/routing inputs required")
    inventory = {name: {"size": manifest["payloadArchive"]["files"][name]["size"], "sha256": hashes[name]} for name in names}
    bodies = {}
    # The complete stream is validated above before this bounded second read.
    with gzip.GzipFile(fileobj=io.BytesIO(archive_raw), mode="rb") as decoded, tarfile.open(fileobj=decoded, mode="r|") as archive:
        for member in archive:
            if member.name not in inventory: continue
            expected = inventory[member.name]
            stream = archive.extractfile(member)
            raw = stream.read(expected["size"] + 1)
            require(U.pin(raw) == expected, "Exact original resource bytes required")
            bodies[member.name] = raw
    require(set(bodies) == set(names), "Missing original archive resource")
    return inventory, bodies


def changed_publish_files(root, bodies):
    require(os.getuid() == os.geteuid() == 0, "Root-only exclusive sealed input staging")
    U.protected_ancestry(root.parent)
    root.mkdir(mode=0o755)
    for name, raw in sorted(bodies.items()):
        U.safe_name(name)
        target = root / name
        for parent in reversed(target.parents):
            if parent == root or not parent.is_relative_to(root): continue
            if not os.path.lexists(parent): parent.mkdir(mode=0o755)
            directory(parent, 0)
        U.write(target, raw, 0o444)
        U.bound(target, U.pin(raw), U.MAX_FILE, uid=0, mode=0o444)
    require({p.relative_to(root).as_posix() for p in root.rglob("*") if not p.is_dir()} == set(bodies), "Sealed input closure differs")
    for parent in (root, *(p for p in root.rglob("*") if p.is_dir())): directory(parent, 0)


def changed_verify_inputs(env, original):
    source = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-input"
    folder = CONTROL / "inputs"; folder.mkdir(mode=0o755)
    for name, expected in original["inputs"].items(): U.write(folder / name, U.bound(source / name, expected, U.MAX_ZIP), 0o444)
    value = changed_profile(U.read(folder / "profile.json", 65536, uid=0, mode=0o444))
    changed_acquisition(U.read(folder / "acquisition.json", 2 * 1024**2, uid=0, mode=0o444), value, env)
    incoming_raw = U.bound(Path(env["RUNNER_TEMP"]) / "native-linux-production-016-input/profile.json", original["incoming"], 65536)
    incoming = changed_incoming_profile(incoming_raw); U.write(folder / "incoming-profile.json", incoming_raw, 0o444)
    a_zip = U.bound(Path(env["RUNNER_TEMP"]) / "native-linux-production-016-input/assembly.zip", U.actual017_a1_data()["zip"], U.MAX_ZIP)
    U.write(folder / "assembly16.zip", a_zip, 0o444)
    members = folder / "members"; members.mkdir(mode=0o700)
    for role, expected in U.input_roles(value).items(): U.stage_zip(folder / (role + ".zip"), expected, members / role)
    verifier = (CONTROL / "scripts/verify-package-input", original["verifier"])
    obj = lambda name: U.object_path(folder, value, name)
    U.signature(obj("debDescriptor17"), obj("debSignature17"), verifier)
    target, a1 = U.actual017_target_data(), U.actual017_a1_data()
    release_raw = U.read(obj("debDescriptor17"), 32768); release = U.parse(release_raw)
    require(all(release.get(k) == v for k, v in {"schemaVersion": 1, "appId": "creator-hub", "version": "0.1.17",
        "platform": "linux", "architecture": "x86_64", "packageType": "deb", "installerProtocol": 1,
        "assetName": "Creator_Hub_0.1.17_amd64-acceptance-only.deb", "byteLength": target["deb"]["size"],
        "sha256": target["deb"]["sha256"], "executableSha256": target["hub"]["sha256"]}.items()), "Signed actual017 native release differs")
    import base64
    latest = U.parse(U.read(obj("latest17"), 32768)); U.keys(latest["platforms"], ("linux-x86_64-deb",))
    entry = latest["platforms"]["linux-x86_64-deb"]
    require(latest["version"] == "0.1.17" and entry["url"] == "https://github.com/" + U.REPO + "/releases/download/v0.1.17/" + release["assetName"], "Exact actual017 updater route required")
    package_signature = U.read(obj("installerSignature17"), 4096)
    require(0 < len(package_signature) <= 4096 and package_signature.startswith(b"untrusted comment:")
            and base64.b64encode(package_signature).decode() == entry["signature"], "Exact native installer signature/latest equality required")
    installer = U.bound(obj("installer17"), target["deb"])
    require(installer == U.bound(obj("deb17"), target["deb"]), "Actual signed carrier installer/original B017 DEB bytes differ")
    fixture_verification = changed_verify_installer_signature(folder, value, original)
    reader = U.load("private-linux-update-fixture-017-package-verify"); base = reader.base_reader()
    old = reader.inspect(obj("deb16"), {k: a1[k] for k in ("deb", "hub", "helper", "policy", "service")}, base, "0.1.16")
    new = reader.inspect(obj("deb17"), {k: target[k] for k in ("deb", "hub", "archive", "helper", "policy", "service")}, base, "0.1.17")
    qualification = U.actual017_compare_update_packages(old, new, a1)
    a_receipt = U.parse(U.read(obj("assemblyReceipt16"), 2 * 1024**2))
    require(a_receipt["assemblyCommit"] == a1["source"] and a_receipt["compiledFeatures"] == U.FEATURES
            and a_receipt["portableHostBuild"]["sourceCommit"] == a1["source"] and a_receipt["portableHostBuild"]["sourceTree"] == a1["tree"]
            and a_receipt["portableHostBuild"]["rawHub"] == a1["raw"] and a_receipt["productionMigration"]["sourceCommit"] == a1["source"]
            and a_receipt["productionMigration"]["sourceTree"] == a1["tree"] and a_receipt["productionMigration"]["rawHub"] == a1["raw"]
            and a_receipt["privateModulesRecompiled"] is a_receipt["privateModulesResigned"] is a_receipt["releaseReady"] is False,
            "Actual native A1 compile/source proof differs")
    donor_review = changed_packaging_provenance(folder, value)
    donor_review["linuxFixtureVerification"] = fixture_verification
    native = U.load("native-linux-root-probe")
    native.verify_deb_marker(U.bound(obj("raw16"), a1["raw"]), U.packaged_root(obj("deb16"), a1["hub"]))
    native.verify_deb_marker(U.bound(obj("raw17"), target["raw"]), U.packaged_root(obj("deb17"), target["hub"]))
    relative = Path(value["objects"]["raw17"]["member"]).parent
    b_root = members / "assembly17"
    a_relative = Path(value["objects"]["raw16"]["member"]).parent
    manifests = {"a": U.bound(members / "assembly16" / a_relative / "builtin-manifest.json", incoming["pins"]["manifest"], 128 * 1024),
                 "b": U.bound(b_root / relative / "builtin-manifest.json", value["artifacts"]["assembly17"]["files"][(relative / "builtin-manifest.json").as_posix()], 128 * 1024)}
    archives = {"a": U.bound(members / "assembly16" / a_relative / "modules.tar.gz", a1["archive"]), "b": U.bound(b_root / relative / "modules.tar.gz", target["archive"])}
    require(manifests["a"] in U.bound(obj("raw16"), a1["raw"])
            and manifests["b"] in U.bound(obj("raw17"), target["raw"]), "Both original manifests must be embedded in independently pinned raw Roots")
    for side, package in (("a", old), ("b", new)):
        require(U.pin(archives[side]) == {k: package["files"]["usr/lib/Creator Hub/modules.tar.gz"][k] for k in ("size", "sha256")}, "Original archive/package differs")
    sealed_root = BASE / "mcp-transition-input"; sealed_root.mkdir(mode=0o755)
    inventories, metadata = {}, {}
    for side in ("a", "b"):
        inventories[side], bodies = changed_resources(manifests[side], archives[side])
        if side == "b": bodies.update({"release.json": release_raw, "release.minisig": U.read(obj("debSignature17"), 4096)})
        changed_publish_files(sealed_root / side, bodies)
        metadata[side + "-manifest.json"], metadata[side + "-modules.tar.gz"] = manifests[side], archives[side]
    changed_publish_files(CONTROL / "metadata", metadata)
    observer = {}
    for name, expected in original["observerSources"].items():
        observer[name] = U.bound(Path(env["GITHUB_WORKSPACE"]) / "native/mcp-router" / name, expected, 2 * 1024**2)
    changed_publish_files(BASE / "mcp-node-observer", observer); U.transition_observer_source()
    transition = {"inventories": inventories, "metadata": {name: U.pin(raw) for name, raw in metadata.items()}}
    reviewed = {"baseline": a1, "deb16": old["files"], "deb17": new["files"], "portable": {}, "signaturesVerified": True,
                "privateTargetQualification": qualification, **U.FALSE}
    return value, reviewed, transition, donor_review


def changed_copy_cargo_verifier(env):
    """Only the fixed owned Cargo output may have multiple links; the private copy may not."""
    require(os.getuid() == os.geteuid() and os.getuid() > 0, "Nonroot owned Cargo output copy required")
    uid = os.getuid()
    workspace, temporary = Path(env["GITHUB_WORKSPACE"]), Path(env["RUNNER_TEMP"])
    root = temporary / "native-linux-production-016-actual017-verifier"
    require(workspace.is_absolute() and temporary.is_absolute() and workspace.resolve(strict=True) == workspace
            and temporary.resolve(strict=True) == temporary and root.resolve(strict=True) == root,
            "Canonical fixed Cargo workspace/private verifier root required")
    file = workspace / "src-tauri/target/release/examples/private-deb017-dea67"
    copied = root / "private-deb017-dea67"
    directories = {}
    for start, bound in ((file.parent, workspace), (root / "logs", temporary)):
        for parent in (start, *start.parents):
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink() and info.st_uid == uid,
                    "Owned canonical Cargo/private output ancestry required")
            if parent == root: require(stat.S_IMODE(info.st_mode) == 0o700, "Private verifier root700 required")
            directories[parent] = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
            if parent == bound: break
        else: raise RuntimeError("Fixed Cargo/private ancestry boundary missing")
    before = file.lstat()
    kind = "regular" if stat.S_ISREG(before.st_mode) else "directory" if stat.S_ISDIR(before.st_mode) else "symlink" if stat.S_ISLNK(before.st_mode) else "other"
    U.save(root / "logs/cargo-output.json", {"path": str(file), "kind": kind, "mode": stat.S_IMODE(before.st_mode),
        "uid": before.st_uid, "gid": before.st_gid, "nlink": before.st_nlink, "size": before.st_size, "stamp": list(U.stamp(before))}, 0o444)
    require(stat.S_ISREG(before.st_mode) and not file.is_symlink() and before.st_uid == uid
            and before.st_nlink >= 1 and stat.S_IMODE(before.st_mode) == 0o755
            and 0 < before.st_size <= 64 * 1024**2, "Owned bounded Cargo executable required")
    require(not os.path.lexists(copied), "Exclusive private verifier output required")
    # Cargo can hardlink the named example to its hashed output. No other reader is relaxed.
    identity = lambda info: (U.stamp(info), info.st_nlink)
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        require(identity(os.fstat(fd)) == identity(before), "Cargo executable changed during open")
        chunks, total = [], 0
        while total <= before.st_size:
            part = os.read(fd, min(1024 * 1024, before.st_size + 1 - total))
            if not part: break
            chunks.append(part); total += len(part)
        require(total == before.st_size and identity(os.fstat(fd)) == identity(before)
                and identity(file.lstat()) == identity(before), "Cargo executable changed during capture")
        body = b"".join(chunks)
        require(body[:7] == b"\x7fELF\x02\x01\x01" and body[18:20] == b"\x3e\x00", "Compiled Linux x86_64 ELF required, not Windows PE")
        U.write(copied, body, 0o755)
        require(U.read(copied, 64 * 1024**2, uid=uid, mode=0o755) == body
                and identity(os.fstat(fd)) == identity(before) and identity(file.lstat()) == identity(before),
                "Fresh single-link verifier copy or Cargo executable changed")
        for parent, expected in directories.items():
            info = parent.lstat()
            require((info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid) == expected,
                    "Cargo/private output ancestry changed during copy")
        return copied, body
    finally:
        os.close(fd)


def changed_build_installer_verifier(env):
    """Nonroot fixed-example tooling only; never builds or launches the Hub binary."""
    changed_admission(env)
    require(os.getuid() == os.geteuid() and os.getuid() > 0 and sys.platform == "linux", "Nonroot Linux test-tool builder only")
    changed_source_receipt(env)
    workspace = Path(env["GITHUB_WORKSPACE"])
    folder = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-input"
    value = changed_profile(U.read(folder / "profile.json", 65536))
    changed_acquisition(U.read(folder / "acquisition.json", 2 * 1024**2), value, env)
    root = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-actual017-verifier"
    require(root.parent.resolve(strict=True) == root.parent and not os.path.lexists(root), "Fresh fixed test-tool work directory required")
    root.mkdir(mode=0o700); (root / "source").mkdir(mode=0o700); (root / "logs").mkdir(mode=0o700)
    pages = U.load("native-linux-integrated-pages")
    input_pins = {**CHANGED_INSTALLER_SOURCES, "src-tauri/examples/private-deb017-dea67-guards.rs": CHANGED_INSTALLER_GUARD}
    inputs = {}
    for name, expected in input_pins.items():
        original = workspace / name; raw = U.bound(original, expected, 2 * 1024**2)
        copied = root / "source" / name; copied.parent.mkdir(mode=0o700, parents=True, exist_ok=True); U.write(copied, raw, 0o644)
        inputs[name] = {"pin": expected, "originalStamp": list(pages.stamp(original.lstat())), "copyStamp": list(pages.stamp(copied.lstat()))}
    deadline = time.monotonic() + 180
    def command(label, argv, context=None):
        remaining = deadline - time.monotonic(); require(remaining > 0, "Installer verifier qualification deadline expired")
        started = time.monotonic()
        with __import__("tempfile").TemporaryFile() as out, __import__("tempfile").TemporaryFile() as err:
            try:
                result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd=workspace,
                    env=context or dict(os.environ), timeout=remaining, check=False)
                status, failure = result.returncode, None
            except Exception as error:
                status, failure = None, error
            require(out.tell() <= 2 * 1024**2 and err.tell() <= 2 * 1024**2, "Bounded verifier build output exceeded")
            out.seek(0); stdout = out.read(); err.seek(0); stderr = err.read()
        U.write(root / "logs" / (label + ".stdout"), stdout); U.write(root / "logs" / (label + ".stderr"), stderr)
        U.save(root / "logs" / (label + ".json"), {"argv": argv, "exitCode": status, "elapsed": time.monotonic() - started,
            "stdout": U.pin(stdout), "stderr": U.pin(stderr), "error": None if failure is None else type(failure).__name__})
        if failure is not None: raise failure
        require(type(status) is int and status == 0, "Fixed verifier build/qualification command refused: " + label)
        return stdout
    rustup = Path(command("rustup", ["/usr/bin/which", "rustup"]).decode().strip())
    require(rustup.is_absolute(), "Fixed workflow Rust resolver required")
    compilers = {}
    for name in ("cargo", "rustc"):
        file = Path(command(name + "-path", [str(rustup), "which", "--toolchain", "1.99.0", name]).decode().strip())
        require(file.name == name and file.parent.name == "bin" and file.parent.parent.name == "1.99.0-x86_64-unknown-linux-gnu", "Exact Linux toolchain required")
        compilers[name] = {"path": str(file), "record": pages.record(file), "stamp": list(pages.stamp(file.lstat())),
                           "version": command(name + "-version", [str(file), "-Vv"]).decode()}
        require(compilers[name]["version"].startswith(name + " 1.99.0 "), "Exact compiler version required")
    compile_env = {"PATH": str(Path(compilers["cargo"]["path"]).parent) + ":/usr/bin:/bin", "HOME": str(Path.home()),
                   "CARGO_HOME": str(Path.home() / ".cargo"), "RUSTC": compilers["rustc"]["path"], "LANG": "C", "LC_ALL": "C"}
    common = ["--release", "--locked", "--no-default-features", "--jobs", "2", "--manifest-path", str(workspace / "src-tauri/Cargo.toml"),
              "--target-dir", str(workspace / "src-tauri/target")]
    command("build", [compilers["cargo"]["path"], "build", *common, "--example", "private-deb017-dea67"], compile_env)
    unit = command("unit", [compilers["cargo"]["path"], "test", *common, "--example", "private-deb017-dea67"], compile_env)
    qualified = root / "qualification"; qualified.mkdir(mode=0o700)
    for role in ("assembly17", "signedDeb17"):
        U.stage_zip(folder / (role + ".zip"), U.input_roles(value)[role], qualified / role)
    target_root = qualified / "assembly17"; prefix = Path(value["objects"]["raw17"]["member"]).parent
    signed_root = qualified / "signedDeb17" / Path(value["objects"]["outerPlan17"]["member"]).parent
    arguments = [str(target_root / value["objects"]["deb17"]["member"]), str(target_root / value["objects"]["raw17"]["member"]),
                 str(target_root / prefix / "builtin-manifest.json"), str(target_root / prefix / "modules.tar.gz")]
    target = U.actual017_target_data()
    manifest_raw = U.bound(Path(arguments[2]), value["artifacts"]["assembly17"]["files"][(prefix / "builtin-manifest.json").as_posix()], 128 * 1024)
    require(manifest_raw in U.bound(Path(arguments[1]), target["raw"]), "Guard fixture must use the actual original B017 raw Root")
    _, public = changed_resources(manifest_raw, U.bound(Path(arguments[3]), target["archive"]))
    public_root = qualified / "guard-public"; public_root.mkdir(mode=0o700)
    public_body, public_signature = public_root / "runtime.json", public_root / "runtime.minisig"
    require(U.pin(public["routing/runtime.json"]) == target["runtime"]
            and U.pin(public["routing/runtime.minisig"]) == target["runtimeSignature"], "Exact actual017 public runtime/signature required for guard tests")
    U.write(public_body, public["routing/runtime.json"], 0o644); U.write(public_signature, public["routing/runtime.minisig"], 0o644)
    guard_env = {**compile_env, "ACTUAL_B017_ROOT": arguments[1], "B017_PUBLIC_BODY": str(public_body), "B017_PUBLIC_SIGNATURE": str(public_signature)}
    guards = command("guards", [compilers["cargo"]["path"], "test", *common, "--example", "private-deb017-dea67-guards", "actual_b017_guard_regressions"], guard_env)
    for raw, count in ((unit, 23), (guards, 6)):
        require(re.search(rb"test result: ok\. " + str(count).encode() + rb" passed; 0 failed; 0 ignored;", raw), "Exact Linux fixture unit/guard test evidence required")
    tool, body = changed_copy_cargo_verifier(env)
    inspected = changed_fixture_report(command("inspect", [str(tool), "inspect", *arguments], compile_env), "inspect")
    verified = changed_fixture_report(command("verify", [str(tool), "verify", *arguments, str(signed_root)], compile_env), "verify")
    changed_source_receipt(env)
    for name, row in inputs.items():
        for file, stamp in ((workspace / name, row["originalStamp"]), (root / "source" / name, row["copyStamp"])):
            U.bound(file, row["pin"], 2 * 1024**2); require(list(pages.stamp(file.lstat())) == stamp, "Verifier source changed during build")
    for row in compilers.values():
        require(pages.record(Path(row["path"])) == row["record"] and list(pages.stamp(Path(row["path"]).lstat())) == row["stamp"], "Compiler identity changed during build")
    U.save(root / "receipt.json", {"schemaVersion": 1, "scope": "ci-only-actual017-offline-verifier", "harnessSource": env["GITHUB_SHA"],
        "inputs": inputs, "compilers": compilers, "tool": {"pin": U.pin(body), "stamp": list(pages.stamp(tool.lstat()))},
        "qualification": {"unitTests": 23, "guardTests": 6, "inspect": inspected, "verify": verified}, "releaseReady": False})
    return changed_installer_verifier(env)


def changed_installer_verifier(env):
    """Existing receipt format, fixed actual017 source closure, Linux ELF only."""
    root = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-actual017-verifier"
    raw = U.read(root / "receipt.json", 128 * 1024, mode=0o600); value = U.parse(raw)
    U.keys(value, ("schemaVersion", "scope", "harnessSource", "inputs", "compilers", "tool", "qualification", "releaseReady"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
            and value["scope"] == "ci-only-actual017-offline-verifier" and value["harnessSource"] == env["GITHUB_SHA"]
            and value["releaseReady"] is False, "Exact actual Linux verifier build receipt required")
    all_sources = {**CHANGED_INSTALLER_SOURCES, "src-tauri/examples/private-deb017-dea67-guards.rs": CHANGED_INSTALLER_GUARD}
    U.keys(value["inputs"], tuple(all_sources))
    require({p.relative_to(root / "source").as_posix() for p in (root / "source").rglob("*") if not p.is_dir()}
            == set(all_sources), "Complete fixed verifier source snapshot required")
    pages = U.load("native-linux-integrated-pages")
    for name, expected in all_sources.items():
        row = value["inputs"][name]; U.keys(row, ("pin", "originalStamp", "copyStamp"))
        require(row["pin"] == expected, "Actual017 verifier compiler-input bytes differ")
        for file, stamp in ((Path(env["GITHUB_WORKSPACE"]) / name, row["originalStamp"]), (root / "source" / name, row["copyStamp"])):
            U.bound(file, expected, 2 * 1024**2)
            require(list(pages.stamp(file.lstat())) == stamp, "Verifier source identity drift")
    U.keys(value["compilers"], ("cargo", "rustc"))
    for name, row in value["compilers"].items():
        U.keys(row, ("path", "record", "stamp", "version")); file = Path(row["path"])
        require(file.name == name and file.parent.name == "bin" and file.parent.parent.name == "1.99.0-x86_64-unknown-linux-gnu"
                and row["version"].startswith(name + " 1.99.0 ") and pages.record(file) == row["record"]
                and list(pages.stamp(file.lstat())) == row["stamp"], "Exact Linux compiler/build identity required")
    U.keys(value["tool"], ("pin", "stamp"))
    file = root / "private-deb017-dea67"
    body = U.bound(file, value["tool"]["pin"], 64 * 1024**2, mode=0o755)
    require(body[:7] == b"\x7fELF\x02\x01\x01" and body[18:20] == b"\x3e\x00"
            and list(pages.stamp(file.lstat())) == value["tool"]["stamp"], "Native x86_64 Linux verifier required, never Windows PE")
    proof = value["qualification"]; U.keys(proof, ("unitTests", "guardTests", "inspect", "verify"))
    require(type(proof["unitTests"]) is type(proof["guardTests"]) is int and proof["unitTests"] == 23 and proof["guardTests"] == 6, "Exact unit qualification required")
    for name, count in (("unit", 23), ("guards", 6)):
        output = U.read(root / "logs" / (name + ".stdout"), 2 * 1024**2, mode=0o600)
        record = U.parse(U.read(root / "logs" / (name + ".json"), 65536, mode=0o600))
        require(type(record["exitCode"]) is int and record["exitCode"] == 0 and record["stdout"] == U.pin(output)
                and re.search(rb"test result: ok\. " + str(count).encode() + rb" passed; 0 failed; 0 ignored;", output), "Original successful Rust qualification logs required")
    for mode in ("inspect", "verify"):
        output = U.read(root / "logs" / (mode + ".stdout"), 65536, mode=0o600)
        record = U.parse(U.read(root / "logs" / (mode + ".json"), 65536, mode=0o600))
        require(type(record["exitCode"]) is int and record["exitCode"] == 0 and record["stdout"] == U.pin(output)
                and changed_fixture_report(output, mode) == proof[mode], "Actual original four-role verification evidence required")
    return file, {"receipt": U.pin(raw), "tool": value["tool"], "sources": dict(CHANGED_INSTALLER_SOURCES), "qualificationSource": CHANGED_INSTALLER_GUARD}


def changed_fixture_report(raw, mode):
    value = U.parse(raw); target = U.actual017_target_data()
    flags = ("nativeGuiAccepted", "migrationAccepted", "authenticationAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady",
             "privateModulesRecompiled", "privateModulesResigned", "rootRecompiled", "applicationLaunched", "approvedForStable", "approvedForPrerelease")
    U.keys(value, ("scope", "mode", "sourceVersion", "targetVersion", "deb", "rawHub", "installedHub", "fullResourcesVerified", "signaturesVerified", "acceptanceOnly", *flags))
    require(mode in ("inspect", "verify") and value["scope"] == "private-linux-deb-update-017" and value["mode"] == mode
            and value["sourceVersion"] == "0.1.16" and value["targetVersion"] == "0.1.17"
            and value["deb"] == target["deb"] and value["rawHub"] == target["raw"] and value["installedHub"] == target["hub"]
            and value["fullResourcesVerified"] is True and value["signaturesVerified"] is (mode == "verify")
            and value["acceptanceOnly"] is True and all(value[k] is False for k in flags), "Exact actual017 fixture verification required")
    return value


def changed_verify_installer_signature(folder, value, original):
    qualification = original["installerVerifier"]
    require(qualification["sources"] == CHANGED_INSTALLER_SOURCES, "Original Linux compiled closure differs")
    tool = CONTROL / "scripts/private-deb017-dea67"
    target = U.actual017_target_data(); obj = lambda name: U.object_path(folder, value, name)
    prefix = Path(value["objects"]["raw17"]["member"]).parent
    b_root = folder / "members/assembly17"
    manifest, modules = b_root / prefix / "builtin-manifest.json", b_root / prefix / "modules.tar.gz"
    signed = obj("outerPlan17").parent
    require(all(U.object_path(folder, value, name).parent == signed for name in
        ("debDescriptor17", "debSignature17", "latest17", "installer17", "installerSignature17", "outerApi17", "outerReceipt17")),
        "One exact signed-carrier directory required")
    inputs = {obj("deb17"): target["deb"], obj("raw17"): target["raw"], manifest: value["artifacts"]["assembly17"]["files"][(prefix / "builtin-manifest.json").as_posix()],
              modules: target["archive"]}
    for name, expected in value["deliveries"]["signedDeb17"]["files"].items(): inputs[folder / "members/signedDeb17" / name] = expected
    held = {file: list(U.stamp(file.lstat())) for file in (*inputs, tool)}
    def recheck():
        for file, expected in inputs.items():
            U.bound(file, expected, U.MAX_FILE, uid=0)
            require(list(U.stamp(file.lstat())) == held[file], "Original verification input identity changed")
        body = U.bound(tool, qualification["tool"]["pin"], 64 * 1024**2, uid=0, mode=0o755)
        require(body[:7] == b"\x7fELF\x02\x01\x01" and body[18:20] == b"\x3e\x00" and list(U.stamp(tool.lstat())) == held[tool], "Copied native Linux verifier changed")
    native_args = [str(inputs_path) for inputs_path in (obj("deb17"), obj("raw17"), manifest, modules)]
    recheck()
    inspected = changed_fixture_report(U.run_tool([str(tool), "inspect", *native_args], timeout=180, limit=65536), "inspect")
    recheck()
    verified = changed_fixture_report(U.run_tool([str(tool), "verify", *native_args, str(signed)], timeout=180, limit=65536), "verify")
    recheck()
    return {"inspect": inspected, "verify": verified, "tool": qualification["tool"]["pin"], "buildReceipt": qualification["receipt"]}


def changed_packaging_provenance(folder, value):
    obj = lambda name: U.object_path(folder, value, name)
    plan = U.parse(U.bound(obj("outerPlan17"), U.object_pin(value, "outerPlan17"), 65536))
    api = U.parse(U.bound(obj("outerApi17"), U.object_pin(value, "outerApi17"), 2 * 1024**2))
    receipt = U.parse(U.bound(obj("outerReceipt17"), U.object_pin(value, "outerReceipt17"), 65536))
    target = U.actual017_target_data(); source = {"sourceCommit": target["source"], "sourceTree": target["tree"]}
    require(plan["profile"] == receipt["profile"] == "private-linux-deb-update-017" and plan["rootSource"] == receipt["rootSource"] == source
            and plan["signed017"] == {"planSha256": "fa04b1e9b636acd0177ed7d5ffe3b40eab955e40768f5b7f74682fd84864de6b"}, "Exact actual017 outer/inner source plan required")
    U.keys(plan["files"], ("root", "archive", "manifest", "receipt", "expected", "integrity", "deb", "api"))
    files = value["artifacts"]["assembly17"]["files"]
    for row in plan["files"].values():
        U.keys(row, ("member", "size", "sha256"))
        require(files.get(row["member"]) == {k: row[k] for k in ("size", "sha256")}, "Outer plan/original B017 member binding differs")
    U.validate_api({k: api["producer"][k] for k in ("run", "job", "artifact", "commit")}, value["artifacts"]["assembly17"])
    require(plan["producer"] == receipt["producer"] == {"runId": target["run"], "runAttempt": 1, "jobId": target["job"],
        "workflowId": 390024116, "artifactId": target["artifact"], "zip": target["zip"]}, "Exact original producer/signing receipt required")
    assembly_row = plan["files"]["receipt"]
    assembly_raw = U.bound(folder / "members/assembly17" / assembly_row["member"], {k: assembly_row[k] for k in ("size", "sha256")}, 65536)
    assembly = U.parse(assembly_raw)
    require(assembly["rootSource"] == source and assembly["rawHub"] == target["raw"] and assembly["packagedHub"] == target["hub"]
            and assembly["deb"] == target["deb"] and assembly["archive"] == target["archive"] and assembly["compiledFeatures"] == U.FEATURES,
            "Actual B017 assembly/image/resource evidence differs")
    donor = assembly["baseline016"]
    expected_assembly = {"sourceCommit": "c5bd13a5145aa54a50f28f073e1543826a210a4e", "sourceTree": "6c6953a0b4901b56eeadb4647d7dde34a375761a",
        "runId": 40897895423, "runAttempt": 1, "jobId": 123532047652, "artifactId": 12907149456, "zipBytes": 184009187,
        "zipSha256": "7e940fa78f6ad2f45b979136d964cb75bce35b0d6589683bca8751a06045f3af"}
    require(donor["assembly"] == expected_assembly and donor["pins"]["hub"] == {"size": 29088152,
            "sha256": "d6c1515395df40fa67bdf09736be83613329dd8c15f42ada4474c7c8960be941"}, "Separate B016 packaging provenance missing")
    expected_api = {"source": expected_assembly["sourceCommit"], "tree": expected_assembly["sourceTree"], "run": expected_assembly["runId"],
        "job": expected_assembly["jobId"], "artifact": expected_assembly["artifactId"], "zip": {"size": expected_assembly["zipBytes"], "sha256": expected_assembly["zipSha256"]},
        "name": "signed-unix-hub-linux-40897895423-1", "branch": "validation/linux-integrated-candidate-016", "workflow": ".github/workflows/unix-managed-assembly.yml"}
    U.validate_api(api["lineage"]["baseline"], expected_api)
    require(api["lineage"]["root"]["commit"]["sha"] == target["source"]
            and api["lineage"]["root"]["commit"]["tree"]["sha"] == target["tree"], "Root source lineage differs")
    original = assembly["original016"]["source"]
    require(all(original.get(k) == v for k, v in {"repository": U.REPO, "repositoryId": 1364807512,
            "workflow": ".github/workflows/unix-managed-payload.yml", "event": "push",
            "sourceCommit": "c5bd13a5145aa54a50f28f073e1543826a210a4e", "buildCommit": "c5bd13a5145aa54a50f28f073e1543826a210a4e",
            "sourceTree": "6c6953a0b4901b56eeadb4647d7dde34a375761a", "runId": 40891664484, "runAttempt": 1}.items())
            and all(api["lineage"]["original"]["run"].get(k) == v for k, v in {"id": original["runId"], "run_attempt": 1,
                "head_sha": original["sourceCommit"], "head_branch": "validation/unix-payload-016", "path": original["workflow"],
                "event": "push", "status": "completed", "conclusion": "success"}.items())
            and api["lineage"]["original"]["commit"]["sha"] == original["sourceCommit"]
            and api["lineage"]["original"]["commit"]["tree"]["sha"] == original["sourceTree"], "Original signed B payload provenance missing")
    require(receipt["planSha256"] == U.object_pin(value, "outerPlan17")["sha256"] and receipt["descriptor"] == U.object_pin(value, "debDescriptor17")
            and receipt["installer"] == target["deb"] and receipt["installedHub"] == target["hub"] and receipt["latest"] == U.object_pin(value, "latest17")
            and type(receipt["authorizedBodiesSigned"]) is int and receipt["authorizedBodiesSigned"] == 2
            and receipt["privateKeyIncluded"] is False and receipt["offlineInputsVerified"] is True, "Original outer signing receipt differs")
    flags = ("nativeGuiAccepted", "migrationAccepted", "authenticationAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady")
    for record in (assembly, api["lineage"], receipt):
        require(record["acceptanceOnly"] is True and all(record[k] is False for k in flags), "Provenance cannot grant native/release acceptance")
    return {"role": "packaging-provenance-only-not-native-A", "baseline016": donor, "assembly": U.pin(assembly_raw),
            "outerPlan": U.object_pin(value, "outerPlan17"), "outerApi": U.object_pin(value, "outerApi17"), "outerReceipt": U.object_pin(value, "outerReceipt17"),
            "windowsToolPinsAreProvenanceOnly": True, "donorPackageReverifiedHere": False}


def changed_transition_inputs(sealed, verifier):
    transition = sealed["transition"]
    U.keys(transition, ("inventories", "metadata"))
    U.keys(transition["metadata"], ("a-manifest.json", "a-modules.tar.gz", "b-manifest.json", "b-modules.tar.gz"))
    values = {name: U.bound(CONTROL / "metadata" / name, pin, U.MAX_FILE, uid=0, mode=0o444)
              for name, pin in transition["metadata"].items()}
    manifests = {side: values[side + "-manifest.json"] for side in ("a", "b")}
    archives = {side: values[side + "-modules.tar.gz"] for side in ("a", "b")}
    pins = {side: transition["metadata"][side + "-manifest.json"] for side in ("a", "b")}
    expected, _, _ = transition_home_closure(manifests, pins, archives, transition["inventories"], verifier)
    require(expected["sides"]["b"]["generation"] == U.actual017_target_data()["generation"], "Exact signed B generation required")
    return manifests, pins, archives, copy.deepcopy(transition["inventories"])


def changed_guard(sealed, verifier):
    manifests, pins, archives, inventories = changed_transition_inputs(sealed, verifier)
    return TransitionHomePreservation(sealed, manifests, pins, archives, inventories, verifier)


def changed_runtime_binding(env):
    original = changed_intent(env)
    require(HERE == CONTROL / "scripts", "Only exact sealed changed-payload scripts may run")
    U.protected_ancestry(HERE / "fixtures")
    for name, expected in original["sources"].items(): U.bound(HERE / name, expected, 2 * 1024**2, uid=0, mode=0o444)
    U.bound(CONTROL / "inputs/source-receipt.json", original["sourceReceipt"], 2 * 1024**2, uid=0, mode=0o444)
    sealed = U.parse(U.read(CONTROL / "state.json", 2 * 1024**2, uid=0, mode=0o644))
    require(sealed["context"] == original["context"] and sealed["accountUid"] == M.UID, "Exact original changed-payload state required")
    U.transition_observer_source()
    return original, sealed


def changed_recheck(env, original, sealed):
    require(changed_intent(env) == original, "Changed-payload source/context drift")
    U.protected_ancestry(CONTROL / "scripts/fixtures")
    for name, expected in original["sources"].items(): U.bound(CONTROL / "scripts" / name, expected, 2 * 1024**2, uid=0, mode=0o444)
    require(U.parse(U.read(CONTROL / "state.json", 2 * 1024**2, uid=0, mode=0o644)) == sealed, "Protected original state drift")
    U.transition_observer_source()


def changed_child_environment(env):
    changed_admission(env)
    return {**child_environment(env), CHANGED_SOURCE_RECEIPT_ENV: env[CHANGED_SOURCE_RECEIPT_ENV]}


def changed_session_command(env):
    changed_admission(env)
    values = changed_child_environment(env)
    values.update(HOME=str(HOME), USER=M.USER, RUNNER_TEMP=str(OUTPUT), XDG_CONFIG_HOME=str(HOME / "config"),
                  XDG_DATA_HOME=str(HOME / "data"), XDG_CACHE_HOME=str(HOME / "cache"),
                  XDG_RUNTIME_DIR=str(OUTPUT / "runtime"), TMPDIR=str(OUTPUT / "tmp"), GDK_BACKEND="x11", NO_AT_BRIDGE="0")
    return ["/usr/bin/systemd-run", "--wait", "--pipe", "--collect", "--quiet", "--unit=creator-migrated-update-fixture",
            "--uid=" + M.USER, "--property=PAMName=login", "--property=Type=exec", "--property=LimitCORE=0",
            "--property=WorkingDirectory=" + str(BASE), *("--setenv=" + k + "=" + v for k, v in values.items()),
            "/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a", "--server-args=-screen 0 1280x1000x24",
            "/usr/bin/env", *(k + "=" + values[k] for k in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME")),
            "/usr/bin/python3", "-B", str(CONTROL / "scripts/native-linux-migrated-update.py"), "session-changed-mcp"]


def changed_prepare_tls(env):
    changed_admission(env)
    values = changed_child_environment(env)
    folder = BASE / "tls"; folder.mkdir(mode=0o700)
    require(not os.path.lexists(U.TLS_CERT), "Pre-existing test CA refused")
    before = U.trust_snapshot(); U.write(folder / "tls.cnf", U.TLS_CONFIG)
    U.run_tool(["/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", str(folder / "tls.cnf"),
                "-keyout", str(folder / "private.pem"), "-out", str(folder / "public.crt")])
    for name in ("private.pem", "public.crt"):
        os.chmod(folder / name, 0o600); U.read(folder / name, 65536, uid=0, mode=0o600)
    arm = {"schemaVersion": 1, "harnessSource": env["GITHUB_SHA"], "scenario": env["UPDATE_SCENARIO"], "profileSha256": env["UPDATE_PROFILE_SHA256"],
           "certificate": U.pin(U.read(folder / "public.crt", 65536, uid=0, mode=0o600)), "before": before}
    U.save(folder / "armed.json", arm); U.write(folder / "cleanup.lock", b"owned")
    fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    child = U.PipeChild(["/usr/bin/python3", "-B", str(CONTROL / "scripts/native-linux-migrated-update.py"), "_tls-guard-changed-mcp"], values, "tls-guard")
    try:
        require(child.ready()["kind"] == "tls-cleanup-armed", "Cleanup lease was not armed")
        child.send(b"install\n"); require(child.ready()["kind"] == "tls-installed", "Temporary trust installation unproven")
        return child
    except Exception:
        child.finish(); raise


def changed_arm_session(env, original, sealed, guard, protocol, deadline):
    changed_session_preservation(sealed, guard, checkpoint="arm-before-input")
    U.save(OUTPUT / "ready-arm.json", {"context": original["context"]})
    def acknowledged():
        if not os.path.lexists(CONTROL / "ready-armed.json"): return None
        value = U.parse(U.read(CONTROL / "ready-armed.json", 16384, uid=0, mode=0o644))
        require(value == {"context": original["context"]}, "Foreign broker watch acknowledgement")
        return True
    U.wait(acknowledged, min(30, max(0, deadline - time.monotonic())))
    watcher = SessionReadyWatcher(guard, protocol, deadline); watcher.arm()
    return watcher


def changed_transport_environment(env):
    result = changed_child_environment(env)
    result["RUNNER_TEMP"], result["HOME"] = str(OUTPUT), str(HOME)
    return result


def changed_start_transport(env, root, request_value):
    changed_admission(env)
    require(root == U.transport_path(changed_transport_environment(env)), "Exact changed transport path required")
    argv = [env["CONTROLLER_NODE"], str(CONTROL / "scripts/linux-update-lab-feed.cjs"), "update-changed-mcp-016-017", "deb", str(root)]
    child = U.PipeChild(argv, changed_transport_environment(env), "transport", synthetic=True)
    try:
        native, helper = U.load("native-linux-root-probe"), U.load("native-unix-window")
        image = U.kernel_record(child.child.pid, native, helper)
        require(image["parentPid"] == os.getpid() and image["uids"] == [M.UID] * 4
                and image["executable"] == env["CONTROLLER_NODE"] and image["kernelImageSha256"] == request_value["nodeImage"]["sha256"],
                "Lab Node image/UID/parent changed")
        import base64
        key = bytearray(U.read(BASE / "tls/private.pem", 65536, uid=0, mode=0o600))
        try:
            control = bytearray((json.dumps({"key": base64.b64encode(key).decode(),
                "cert": base64.b64encode(U.read(BASE / "tls/public.crt", 65536, uid=0, mode=0o600)).decode()}) + "\n").encode())
            try: child.send(bytes(control))
            finally: control[:] = b"\0" * len(control)
        finally: key[:] = b"\0" * len(key)
        value = child.ready()
        U.keys(value, ("kind", "pid", "mode", "proxyUrl", "publicDiscovery", "nativeAcceptanceTested", "signaturesVerifiedByHarness", "releaseReady"))
        require(value["kind"] == "update-016-017-ready" and value["mode"] == "deb"
                and all(value[k] is False for k in ("publicDiscovery", "nativeAcceptanceTested", "signaturesVerifiedByHarness", "releaseReady"))
                and type(value["proxyUrl"]) is str and re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", value["proxyUrl"])
                and int(value["proxyUrl"].rsplit(":", 1)[1]) < 65536, "Closed owned changed transport readiness differs")
        child.proxy = value["proxyUrl"]
        return child
    except Exception:
        child.finish(); raise


def changed_outcome(report, inventories, verifier, protected_paths):
    U.actual017_transition_outcome(report, inventories, verifier, protected_paths)
    _continuation_checks(report)
    require(report.get("case") == CHANGED_CASE and report.get("reopenedProjects") == {
        "projectsObserved": True, "termsReaccepted": False, "migrationReplayed": False}, "Included Projects-only second B required")
    initial, prior, current = report.get("initialRoot", {}), report["automaticSuccessor"], report.get("reopenedRoot", {})
    U.phase_identity(initial, U.actual017_a1_data()["hub"], "/usr/bin/creator-hub", prior["parentPid"], M.UID)
    U.phase_identity(prior, U.actual017_target_data()["hub"], "/usr/bin/creator-hub", initial["parentPid"], M.UID, previous=initial)
    U.phase_identity(current, U.actual017_target_data()["hub"], "/usr/bin/creator-hub", prior["parentPid"], M.UID, previous=prior)
    owners = []
    for name, process in (("initialBus", initial), ("automaticBus", prior), ("reopenedBus", current)):
        binding = report.get(name, {})
        require(type(binding.get("pid")) is int and binding["pid"] == process["pid"]
                and type(binding.get("uid")) is int and binding["uid"] == M.UID
                and type(binding.get("owner")) is str and re.fullmatch(r":[0-9]+\.[0-9]+", binding["owner"]), "Exact Root SESSION bus evidence required")
        owners.append(binding["owner"])
    require(len(set(owners)) == 3, "Each Root phase requires its own real SESSION bus owner")
    proof = report.get("secondB"); require(type(proof) is dict, "Second B proof required")
    require(proof.get("pid") == current["pid"] and type(proof.get("exitCode")) is int and proof["exitCode"] == 0
            and type(proof.get("automaticBExitCode")) is int and proof["automaticBExitCode"] == 0 and proof.get("projectsOnly") is True
            and proof.get("journalBefore") == proof.get("journalAfter") and type(proof.get("journalBefore")) is dict
            and proof.get("completedBefore") == proof.get("completedAfter") == report["mcpProtocol"]["captures"]["completed"],
            "Second B normal exits/Completed/journal proof differs")
    U.transition_capture(proof["completedAfter"], Path(proof["completedAfter"]["path"]), current=True)
    html = report.get("reopenedHtmlWebDriver", {})
    exit_record = html.get("manualExit", {})
    require(html.get("launchRole") == "manual-second-b-projects" and html.get("automaticRestartProof") is False
            and html.get("projectsDocumentVerified") is True and html.get("probePassed") is html.get("probeReadOnly") is False
            and type(html.get("inputCountAtDocumentCheck")) is int and html["inputCountAtDocumentCheck"] == 0
            and html.get("inputAttempts") in ([], ["projects-filter-all"])
            and html["inputAttempts"] == report.get("reopenedProjectsFilterActions", [])
            and "inputCountAtProbe" not in html and "adoptedExit" not in html
            and html.get("originalRoot") == current and type(exit_record.get("exitCode")) is int
            and exit_record == {"pid": current["pid"], "startTime": current["startTime"], "exitCode": 0}
            and html.get("detached") is html.get("toolsClosedAfterRootExit") is True and html.get("documentVersion") == "0.1.17",
            "Exact manual Projects document/own normal close required")
    return True


def changed_retain_home_path_refusal(record, error):
    try:
        if (type(error) is RuntimeError and str(error) == "Unexpected new HOME path; no prefix exemption"
                and getattr(error, "_home_path_refusal_origin", None) is _HOME_PATH_REFUSAL_ORIGIN):
            value = error.home_path_refusal
            require(type(value) is dict and len(json.dumps(value, ensure_ascii=True).encode()) <= 16384,
                    "Bounded HOME path diagnostic required")
            record["homePathRefusal"] = copy.deepcopy(value)
    except Exception:
        pass


def changed_session(env):
    changed_admission(env)
    original, sealed = changed_runtime_binding(env)
    require(os.getuid() == os.geteuid() == M.UID and env.get("HOME") == str(HOME)
            and all(env.get(k) == str(HOME / leaf) for k, leaf in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"))),
            "Only the original ordinary UID/HOME/XDG may continue")
    verifier = (CONTROL / "scripts/verify-package-input", original["verifier"])
    guard = changed_guard(sealed, verifier); changed_session_preservation(sealed, guard, checkpoint="session-entry")
    reviewed = U.parse(U.read(CONTROL / "review.json", 2 * 1024**2, uid=0, mode=0o644))
    require(reviewed["baseline"] == U.actual017_a1_data() and reviewed["privateTargetQualification"] == U.actual017_private_target_qualification()
            and reviewed["signaturesVerified"] is True, "Exact independent A1/actual017 review required")
    manifests, manifest_pins, archives, inventories = changed_transition_inputs(sealed, verifier)
    target, a1 = U.actual017_target_data(), U.actual017_a1_data()
    private = U.read_private_control()
    require(re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", private["proxyUrl"])
            and int(private["proxyUrl"].rsplit(":", 1)[1]) < 65536 and private["secret"] is not None, "Exact private continuation control required")
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
    report = {"schemaVersion": 1, "scope": "continuous-migrated-home-private017-lifecycle-only", "case": CHANGED_CASE,
              "scenario": "deb-approve", "harnessSource": env["GITHUB_SHA"], "fromSource": a1["source"], "toSource": target["source"],
              "privateTargetQualification": U.actual017_private_target_qualification(), "beforeMigrationConnectionContinued": False,
              "nativeActions": [], "systemActions": [], "initialPageActionAttempts": [], "successorPageActionAttempts": [],
              "automaticSuccessor": None, "oldRetirementHelperRestored": False, "targetRetirementHelperVerified": False,
              "scenarioPassed": False, **U.FALSE}
    html = replacement_html = reopened_html = surface = replacement = reopened_surface = watcher = protocol = None
    root_diagnostics = reopened_diagnostics = None
    failure = None
    try:
        x11 = helper.X11()
        wm_env = M.window_manager_environment(dict(os.environ), "changed-mcp")
        wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=wm_env)
        wm_identity = U.kernel_record(wm.pid, native, helper)
        U.wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"))
        require(U.windows(x11) == [], "Private display must be empty")
        app_env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(HOME),
                   "XDG_CONFIG_HOME": str(HOME / "config"), "XDG_DATA_HOME": str(HOME / "data"), "XDG_CACHE_HOME": str(HOME / "cache"),
                   "XDG_RUNTIME_DIR": env["XDG_RUNTIME_DIR"], "TMPDIR": env["TMPDIR"], "GDK_BACKEND": "x11", "NO_AT_BRIDGE": "0",
                   "HTTPS_PROXY": proxy, "NO_PROXY": "localhost,127.0.0.1,::1",
                   **{k: env[k] for k in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY") if k in env}}
        automation, port = U.html_automation_environment(app_env)
        mcp = U.load("native-linux-update-mcp")
        verify = lambda body, sig: U.signature(body, sig, verifier)
        before = mcp.BoundRoute(M, HOME, {n: pin["sha256"] for n, pin in inventories["a"].items()}, verify)
        b_source = BASE / "mcp-transition-input/b"
        route = mcp.TransitionRoute(before, b_source, {n: pin["sha256"] for n, pin in inventories["b"].items()},
                                    (b_source / "release.json", b_source / "release.minisig"))
        evidence = BASE / "result/mcp"; evidence.mkdir(mode=0o700)
        fixture = mcp.TransitionFixture(route, evidence,
            {**{k: v for k, v in app_env.items() if k not in ("HTTPS_PROXY", "NO_PROXY")},
             "CREATOR_WORKS_TOOL_GROUPS": "none", "CREATOR_WORKS_CONFIG_OWNER": "creator-hub-v1"}, CHANGED_PROTECTED, pages, helper, native)
        protocol = U.TransitionProtocolCapture(fixture, inventories, verifier, CHANGED_PROTECTED)
        report["mcpChecks"] = [protocol.start()]
        system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None); bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        parent = U.kernel_record(os.getpid(), native, helper)
        polkit.source_contract(); session_identity = polkit.session(system, os.getpid(), GLib)
        agent = subprocess.Popen([polkit.AGENT], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=app_env)
        agent_record = U.kernel_record(agent.pid, native, helper)
        polkit.own_agent(agent, agent_record, parent, helper)
        require(polkit.session(system, agent.pid, GLib) == session_identity, "Agent left owned logind session")
        endpoint = U.wait(lambda: polkit.agent_bus_identity(system, agent_record, GLib))
        report["installed16"] = U.verify_installed(reviewed, "16")
        root_output = U.RootPipeDrainer()
        try:
            initial = subprocess.Popen(["/usr/bin/creator-hub"], stdin=subprocess.DEVNULL,
                stdout=root_output.target("stdout"), stderr=root_output.target("stderr"), env=automation, umask=0o022)
        finally: root_output.release_writers()
        root_diagnostics = U.RootEndpointDiagnostics(initial, port, native, helper, report, root_output)
        old = U.phase_identity(U.kernel_record(initial.pid, native, helper), a1["hub"], "/usr/bin/creator-hub", os.getpid(), M.UID)
        report["initialRoot"] = old; U.save(OUTPUT / "root.json", old)
        old_bus = U.verify_bus(old, bus, polkit, GLib, portable=False)
        report["initialBus"] = old_bus
        inventory = M.InventoryClient(env["GITHUB_SHA"], "deb-approve", cohort="update", channel="migrated-update")
        surface = U.Surface(old, x11, helper, native, Atspi, inventory=inventory)
        U.bind_source_menu(surface, a1["source"], a1["hub"])
        html = U.actual017_html_pages(surface, initial, pages, original["driver"], port, app_env,
            report.setdefault("htmlWebDriver", {}), root_diagnostics=root_diagnostics)
        html.start(); projects(html, HOME, report, "initialProjects")
        require(M.journal(HOME) == sealed["journal"], "Initial Projects changed original journal")
        html.direct_pages(report["initialPageActionAttempts"])
        first_journal = M.journal(HOME); journal_step(sealed["journal"], first_journal)
        report["initialBitmap"] = U.phase_bitmap(surface, "migrated-update/initial-bitmap")
        html.home()
        U.wait(lambda: html.optional("#hub-update-status") in ("Version 0.1.17 is available.", "Version 0.1.17 is ready to install."), 90)
        require(html.d.read("#hub-update-button", "enabled") is True, "Actual completed signed update Check required")
        changed_session_preservation(sealed, guard, checkpoint="pre-update-input")
        watcher = changed_arm_session(env, original, sealed, guard, protocol, sealed["deadline"])
        baseline = U.children(os.getpid()); report["initial16Verified"] = True
        html.click("#hub-update-button", [], "hub-update-button")
        modal = U.Surface(old, x11, helper, native, Atspi, title="Update Creator Hub", dialog=True)
        report["nativeConfirmationObserved"] = True
        try:
            require(set(U.windows(x11)) == {surface.window, modal.window}, "Only exact Hub/consent pair may receive input")
            html.detach()
            modal.dialog_action(update_question(HOME), ("Update Hub", "Not now"), "Update Hub", report["nativeActions"])
        finally: modal.bus.close_sync(None)
        U.wait(lambda: modal.window not in U.windows(x11), 30)
        U.actual017_authorize(surface, agent, agent_record, parent, endpoint, system, GLib, Atspi, polkit, flow, helper, native, secret, report)
        successor, rejected = U.observe_successor(old, target["hub"], "/usr/bin/creator-hub", os.getpid(), baseline, native, helper, old_child=initial)
        report["automaticSuccessor"], report["nonliveRejected"] = successor, rejected
        successor_bus = U.verify_bus(successor, bus, polkit, GLib, portable=False, previous=old_bus)
        report["automaticBus"] = successor_bus
        replacement = U.Surface(successor, x11, helper, native, Atspi, inventory=inventory)
        U.bind_source_menu(replacement, target["source"], target["hub"])
        html.finish_tools()
        replacement_html = U.actual017_html_pages(replacement, initial, pages, original["driver"], port, app_env,
            report.setdefault("successorHtmlWebDriver", {}), previous=html)
        replacement_html.start(); projects(replacement_html, HOME, report, "successorProjects")
        require(M.journal(HOME) == first_journal, "Automatic B Projects changed journal")
        captured_ready = watcher.wait(); watcher.close()
        U.save(OUTPUT / "handoff-ready.json", captured_ready)
        def completed():
            raw = U.transition_file(HOME / guard.handoff, mode=0o600)
            phase = U.parse(bytes(raw["raw"]))["phase"]
            U.transition_handoff(raw, protocol.expected, phase, protocol.fixture.route.previous)
            require(phase in ("Ready", {"Attempting": guard.target}, {"Completed": guard.target}), "Unknown handoff outcome")
            return phase == {"Completed": guard.target}
        U.wait(completed)
        report["mcpChecks"].append(protocol.complete())
        U.save(OUTPUT / "handoff-completed.json", protocol.captures["completed"])
        changed_session_preservation(sealed, guard)
        report["directPagesObserved"] = replacement_html.direct_pages(report["successorPageActionAttempts"])
        final_journal(sealed["journal"], M.journal(HOME))
        replacement_html.home()
        U.wait(lambda: replacement_html.optional("#hub-update-status") == "You are using Hub 0.1.17. No newer update was found.", 90)
        report["fresh17UiVersion"] = True
        report["successorBitmap"] = U.phase_bitmap(replacement, "migrated-update/successor-bitmap")
        report["installed17"] = U.actual017_verify_installed(reviewed)
        report["targetRetirementHelperVerified"] = report["installed17Verified"] = report["automaticRestartObserved"] = True
        replacement_html.detach(); replacement.close(); replacement_html.finish_tools()
        require(initial.returncode == 0, "Original A1 exit was not normal")
        report["oldNormalExit"] = True
        adopted_exit = report["successorHtmlWebDriver"]["adoptedExit"]
        require(report["automaticRestartObserved"] is True and adopted_exit["pid"] == successor["pid"]
                and type(adopted_exit["exitCode"]) is int and adopted_exit["exitCode"] == 0,
                "Automatic restart and normal B exit must precede manual reopen")
        changed_session_preservation(sealed, guard)
        journal_before = M.journal(HOME); completed_before = U.transition_file(HOME / guard.handoff, mode=0o600)
        require(completed_before == protocol.captures["completed"], "Actual Completed changed before owned reopen")
        reopen_output = U.RootPipeDrainer()
        try:
            reopened = subprocess.Popen(["/usr/bin/creator-hub"], stdin=subprocess.DEVNULL,
                stdout=reopen_output.target("stdout"), stderr=reopen_output.target("stderr"), env=automation, umask=0o022)
        finally: reopen_output.release_writers()
        reopened_report = report.setdefault("reopenedRootDiagnostics", {})
        reopened_diagnostics = U.RootEndpointDiagnostics(reopened, port, native, helper, reopened_report, reopen_output)
        fresh = U.phase_identity(U.kernel_record(reopened.pid, native, helper), target["hub"], "/usr/bin/creator-hub", os.getpid(), M.UID, previous=successor)
        report["reopenedBus"] = U.verify_bus(fresh, bus, polkit, GLib, portable=False, previous=successor_bus)
        reopened_surface = U.Surface(fresh, x11, helper, native, Atspi, inventory=inventory)
        U.bind_source_menu(reopened_surface, target["source"], target["hub"])
        # Singer's fixed owned-B factory is required; never reuse A's Popen/context.
        reopened_html = U.actual017_reopened_html_pages(reopened_surface, reopened, pages, original["driver"], port, app_env,
            report.setdefault("reopenedHtmlWebDriver", {}), previous=replacement_html, root_diagnostics=reopened_diagnostics)
        reopened_html.start(); projects(reopened_html, HOME, report, "reopenedProjects")
        require(M.journal(HOME) == journal_before, "Projects-only reopen appended a third journal pair")
        changed_session_preservation(sealed, guard)
        reopened_html.detach(); reopened_surface.close(); U.wait(lambda: reopened.poll() is not None)
        require(type(reopened.returncode) is int and reopened.returncode == 0, "Owned reopened B must exit normally")
        reopened_html.finish_tools()
        completed_after = U.transition_file(HOME / guard.handoff, mode=0o600)
        require(completed_after == completed_before, "Completed identity changed during second B")
        report["reopenedRoot"] = fresh
        adopted_exit = report["successorHtmlWebDriver"]["adoptedExit"]
        require(adopted_exit["pid"] == successor["pid"] and type(adopted_exit["exitCode"]) is int and adopted_exit["exitCode"] == 0, "Automatic B normal exit required before reopen")
        report["secondB"] = {"pid": reopened.pid, "exitCode": reopened.returncode, "automaticBExitCode": adopted_exit["exitCode"],
            "projectsOnly": True, "completedBefore": completed_before, "completedAfter": completed_after,
            "journalBefore": journal_before, "journalAfter": M.journal(HOME)}
        report["normalFinalClose"] = True
        proof = protocol.finish()
        U.mcp_transition_protocol_receipt(proof, inventories, verifier, CHANGED_PROTECTED)
        report["mcpProtocol"], report["mcpChecks"], report["mcpReconnect"] = proof, proof["protocol"]["checks"], proof["protocol"]["reconnect"]
        report["runtimeSurvived"] = True
        guard.finish(); changed_session_preservation(sealed, guard)
        report.update(settingsPreserved=True, homePreserved=True, journalPrefixPreserved=True, migrationEvidencePreserved=True)
        require(U.windows(x11) == [] and U.kernel_record(wm.pid, native, helper) == wm_identity, "Final visible process/WM identity differs")
        polkit.own_agent(agent, agent_record, parent, helper)
        agent.terminate(); agent.wait(timeout=10)
        subprocess.run(["/usr/bin/openbox", "--exit"], stdin=subprocess.DEVNULL, check=True, env=wm_env); wm.wait(timeout=10)
        U.actual017_verify_installed(reviewed)
        report["scenarioPassed"] = changed_outcome(report, inventories, verifier, CHANGED_PROTECTED)
    except Exception as error:
        failure = error
        report.update(scenarioPassed=False, disposableTeardownRequired=True, recovery="unknown-no-retry-disposable-runner-teardown",
                      refusal={"type": type(error).__name__, "message": str(error)[:1000]})
        changed_retain_home_path_refusal(report, error)
    finally:
        M.wipe(secret)
        if watcher is not None:
            try: watcher.close()
            except Exception as error: failure = failure or error; report["cleanupRefused"] = True
        for adapter in (html, replacement_html, reopened_html):
            if adapter is not None and adapter.logs is not None:
                try: adapter.retain_logs(); adapter.logs.close()
                except Exception as error: failure = failure or error; report["captureRefused"] = True
        for diagnostic in (root_diagnostics, reopened_diagnostics):
            if diagnostic is not None:
                try: diagnostic.finish()
                except Exception as error: diagnostic.unavailable("finalCapture", error)
        for current in (surface, replacement, reopened_surface):
            if current is not None:
                try: current.bus.close_sync(None)
                except Exception as error: failure = failure or error
        if failure is not None: report.update(scenarioPassed=False, disposableTeardownRequired=True, recovery="unknown-no-retry-disposable-runner-teardown")
        U.save(OUTPUT / "report.json", report)
    if failure is not None: raise failure


def changed_broker_outcome(record):
    require(record.get("case") == CHANGED_CASE and record.get("nativePassed") is record.get("preservationPassed") is True
            and record.get("fixtureRelocked") is True and record.get("tlsCleanup") == {"temporaryCertificateRemoved": True, "originalTrustRestored": True}
            and record.get("transportClosed") is True and type(record.get("sessionExit")) is int and record["sessionExit"] == 0
            and record.get("privateTargetQualification") == U.actual017_private_target_qualification()
            and not any(k in record for k in ("refusal", "cleanupRefused", "recovery")) and all(record.get(k) is False for k in U.FALSE),
            "Changed-payload independent cleanup/outcome incomplete")
    return True


def changed_retain_directory_refusal(record, error):
    if "directoryRefusal" in record: return
    try:
        raw = getattr(error, "directory_refusal", None)
        if not (type(error) is RuntimeError and str(error) == "Owned canonical directory required"
                and getattr(error, "_directory_diagnostic_origin", None) is _DIRECTORY_DIAGNOSTIC_ORIGIN
                and type(raw) is dict and set(raw) == {"relativePath", "expectedUid", "lstat"}
                and type(raw["expectedUid"]) is int and raw["expectedUid"] == M.UID
                and type(raw["relativePath"]) is str and len(raw["relativePath"].encode()) <= 512
                and "\\" not in raw["relativePath"] and (raw["relativePath"] == "." or all(
                    part not in ("", ".", "..") for part in raw["relativePath"].split("/")))): return
        cached = raw["lstat"]
        keys = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        if not (type(cached) is dict and set(cached) == set(keys)
                and all(type(value) is int for value in cached.values())
                and all(0 <= cached[key] < 2**64 for key in ("st_dev", "st_ino", "st_nlink", "st_size"))
                and all(0 <= cached[key] < 2**32 for key in ("st_mode", "st_uid", "st_gid"))
                and all(-(2**63) <= cached[key] < 2**63 for key in ("st_mtime_ns", "st_ctime_ns"))): return
        value = {"schemaVersion": 1, "scope": "cached-home-directory-refusal", "diagnosticOnly": True,
            "readOnly": True, "cachedStatOnly": True, "authorityGranted": False, "inputPermitted": False,
            "releaseReady": False, "root": "fixture-home", "canonicalResultCaptured": False, **raw}
        encoded = json.dumps(value, allow_nan=False)
        require(len(encoded.encode()) <= 8192, "Cached directory diagnostic exceeds bound")
        record.setdefault("directoryRefusal", json.loads(encoded))
    except Exception:
        record.setdefault("directoryRefusalUnavailable", True)


def fixture_quiescence_validate(initial, prior):
    """Pure eligibility check; prior is the validated original M broker receipt."""
    require(type(initial) is dict and set(initial) == {"processes", "terminalProcesses"}
            and type(initial["processes"]) is list and type(initial["terminalProcesses"]) is list,
            "Fixture quiescence inventory shape differs")
    if initial == {"processes": [], "terminalProcesses": []}:
        return {}
    require(not initial["terminalProcesses"] and len(initial["processes"]) == 2,
            "Only the original live fixture manager pair may settle")
    require(type(prior) is dict and prior.get("scope") == "production-016-disposable-migration"
            and prior.get("scenario") == "migration-approve" and prior.get("scenarioPassed") is True
            and prior.get("fixtureRelocked") is True, "Completed original fixture receipt required")
    wrapper = prior.get("sessionWrapper", {})
    require(type(wrapper) is dict and type(wrapper.get("returnCode")) is int
            and wrapper["returnCode"] == 0 and wrapper.get("deadlineExpired") is False
            and all(wrapper.get("pipes", {}).get(name, {}).get("eof") is True
                    and wrapper["pipes"][name].get("truncated") is False for name in ("stdout", "stderr")),
            "Original PAM wrapper must have completed with bounded EOF")
    answer = prior.get("lastInventory", {})
    require(type(answer) is dict and type(answer.get("request")) is dict,
            "Original session process inventory required")
    M.inventory_answer(answer, answer["request"])
    require(answer["request"]["harnessSource"] == prior.get("harnessSource")
            and answer["request"]["scenario"] == prior["scenario"], "Foreign original inventory receipt")
    expected, previous = {}, 0
    for row in initial["processes"]:
        require(type(row) is dict, "Ordinary original fixture actor required")
        U.keys(row, ("pid", "startTime", "executable", "argvSha256", "legacyBackend"))
        require(type(row["pid"]) is int and previous < row["pid"] <= 2147483647
                and type(row["startTime"]) is str and re.fullmatch(r"[0-9]{1,20}", row["startTime"])
                and row["executable"] == "/usr/lib/systemd/systemd" and row["legacyBackend"] is False
                and type(row["argvSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", row["argvSha256"])
                and row in answer["processes"], "Unknown or changed fixture actor; never adopt")
        expected[row["pid"]] = dict(row); previous = row["pid"]
    return expected


def _fixture_quiescence_properties(kind, deadline, *, evidence=None, phase=None):
    result = {"kind": kind if kind in ("unit", "user") else "unavailable",
              "phase": phase if phase in ("unit-before", "session-closure", "unit-after") else "unavailable",
              "pid": None, "exitCode": None, "status": "entered", "capturedBytes": 0,
              "stdout": {"unavailable": True}, "stderr": {"unavailable": True}}
    budget = 0
    try:
        if evidence is not None and len(evidence) < 3:
            budget = max(0, 8192 - sum(row.get("capturedBytes", 0) for row in evidence))
            evidence.append(result)
    except Exception:
        pass
    try:
        values = _fixture_quiescence_read_properties(kind, deadline, result, budget)
        result["status"] = "complete"
        return values
    except Exception as error:
        try: result.update(status="refused", errorType=type(error).__name__[:80])
        except Exception: pass
        raise


def _fixture_quiescence_read_properties(kind, deadline, result, budget):
    """Fixed system-bus reads with bounded pipes; never signal even a diagnostic client."""
    unit = "user@" + str(M.UID) + ".service"
    names = {
        "unit": ("Id", "LoadState", "User", "PAMName", "MainPID", "InvocationID", "ControlGroup", "ActiveState", "SubState"),
        "user": ("UID", "State", "Sessions", "Linger"),
    }
    require(kind in names and time.monotonic() < deadline, "Fixture property observation deadline")
    tool = Path("/usr/bin/systemctl" if kind == "unit" else "/usr/bin/loginctl")
    for entry in (tool, *tool.parents):
        info = entry.lstat()
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode),
                "Protected fixture property tool required")
    pin = U.pin(M.read_file(tool, 16 * 1024**2, uid=0, mode=0o755))
    command = [str(tool), "--no-pager", "--no-ask-password", "--all"]
    command += ["--system", "show", unit] if kind == "unit" else ["show-user", str(M.UID)]
    command += ["--property=" + name for name in names[kind]]
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd=BASE, env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
    result["pid"] = child.pid
    streams = [child.stdout, child.stderr]
    output = {stream: bytearray() for stream in streams}
    until = min(deadline, time.monotonic() + 2)
    try:
        for stream in streams: os.set_blocking(stream.fileno(), False)
        while streams or child.poll() is None:
            require(time.monotonic() < until, "Fixture property client deadline; no signal or retry")
            ready = select.select(streams, [], [], min(0.05, max(0, until - time.monotonic())))[0]
            for stream in ready:
                raw = os.read(stream.fileno(), min(4096, 8193 - len(output[stream])))
                output[stream].extend(raw)
                require(len(output[stream]) <= 8192, "Fixture property output exceeds bound")
                if not raw: streams.remove(stream)
        require(child.poll() == 0 and not output[child.stderr], "Fixture property client refused")
        require(U.pin(M.read_file(tool, 16 * 1024**2, uid=0, mode=0o755)) == pin
                and time.monotonic() < deadline, "Fixture property tool changed or deadline")
        values = {}
        for line in bytes(output[child.stdout]).decode("ascii").splitlines():
            name, separator, value = line.partition("=")
            require(separator and name in names[kind] and name not in values and len(value) <= 512
                    and all(32 <= ord(char) < 127 for char in value), "Malformed fixture properties")
            values[name] = value
        U.keys(values, names[kind])
        return values
    finally:
        # Only these fixed property commands may contribute raw output. Hex keeps
        # malformed bytes exact; the shared budget is in original bytes, not text.
        try:
            result["exitCode"] = child.poll()
            for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
                retained = bytes(output[stream][:min(8192, budget)])
                budget -= len(retained)
                result["capturedBytes"] += len(retained)
                result[name] = {"encoding": "hex", "data": retained.hex(), "eof": stream not in streams,
                                "truncated": len(retained) < len(output[stream]),
                                "incomplete": stream in streams}
        except Exception:
            result["captureUnavailable"] = True
        # A stuck read-only root client is left for disposable runner teardown, never killed.
        pending_error, close_error = sys.exc_info()[0] is not None, None
        for stream in (child.stdout, child.stderr):
            try: stream.close()
            except Exception as error: close_error = close_error or error
        if close_error is not None and not pending_error: raise close_error


def _fixture_quiescence_actor(row, native, helper, procfd, expected_image, deadline):
    require(time.monotonic() < deadline, "Fixture actor observation deadline")
    path = Path("/proc") / str(row["pid"])
    before = M.inventory_process_snapshot(procfd, path, row["pid"], helper)
    require(before["startTime"] == row["startTime"] and before["Uid"] == before["Gid"] == [M.UID] * 4,
            "Original fixture identity required")
    require(before["state"] not in ("Z", "X"), "Fixture actor exited during observation")
    fd = os.open("cgroup", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=procfd)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 <= info.st_size <= 4096,
                "Ordinary bounded fixture cgroup required")
        raw = os.read(fd, 4097)
        require(len(raw) <= 4096 and M.metadata_stamp(os.fstat(fd)) == M.metadata_stamp(info)
                == M.metadata_stamp(os.stat("cgroup", dir_fd=procfd, follow_symlinks=False)), "Fixture cgroup changed")
    finally:
        os.close(fd)
    cgroup = "/user.slice/user-" + str(M.UID) + ".slice/user@" + str(M.UID) + ".service/init.scope"
    require(raw == ("0::" + cgroup + "\n").encode("ascii"), "Unknown fixture actor cgroup")
    image = native.native_process(row["pid"], helper)
    command = M.proc_bytes(path / "cmdline", 8192)
    after = M.inventory_process_snapshot(procfd, path, row["pid"], helper)
    require(after["startTime"] == row["startTime"] and after["Uid"] == after["Gid"] == [M.UID] * 4,
            "Original fixture identity required")
    require(after["state"] not in ("Z", "X"), "Fixture actor exited during observation")
    require({k: v for k, v in before.items() if k != "state"} == {k: v for k, v in after.items() if k != "state"}
            and after["state"] not in ("Z", "X") and image["pid"] == row["pid"]
            and image["startTime"] == row["startTime"] and image["parentPid"] == before["parentPid"]
            and image["uids"] == [M.UID] * 4 and image["executable"] == row["executable"]
            and int(image["image"]["st_uid"]) == int(image["image"]["st_gid"]) == 0
            and int(image["image"]["st_mode"]) == 0o100755 and image["kernelImageSha256"] == expected_image["sha256"]
            and int(image["image"]["st_size"]) == expected_image["size"]
            and type(command) is bytes and 0 < len(command) <= 8192 and command.endswith(b"\0")
            and U.pin(command)["sha256"] == row["argvSha256"] and time.monotonic() < deadline,
            "Fixture actor identity/image/arguments changed")
    return before


def fixture_quiescence(initial, prior, native, helper, *, evidence=None):
    """Settle only the original manager pair; return an unfiltered final inventory."""
    started = time.monotonic()
    deadline = started + 30
    diagnostic = {"schemaVersion": 1, "scope": "original-fixture-quiescence", "diagnosticOnly": True,
                  "readOnly": True, "authorityGranted": False, "inputPermitted": False, "releaseReady": False,
                  "deadlineSeconds": 30, "status": "entered", "stage": "eligibility", "samples": 0,
                  "events": [], "propertyResults": [], "truncated": False}
    eligible, fds, procfds, snapshots = {}, {}, {}, {}

    def note(event, pid=None):
        try:
            require(event in ("eligible", "empty", "properties-bound", "actor-bound", "binding-complete",
                    "pidfd-exit", "pam-reparented", "terminal-observed", "inventory-gap", "reaped", "complete", "refusal", "cleanup-refusal"),
                    "Fixed quiescence diagnostic event required")
            if len(diagnostic["events"]) >= 24:
                diagnostic["truncated"] = True
                return
            row = {"event": event, "sample": diagnostic["samples"],
                   "elapsedMs": max(0, min(86400000, int((time.monotonic() - started) * 1000)))}
            if pid is not None:
                require(pid in eligible, "Only original diagnostic identities allowed")
                row.update(pid=pid, startTime=eligible[pid]["startTime"])
            diagnostic["events"].append(row)
        except Exception:
            diagnostic["captureUnavailable"] = True

    try:
        eligible = fixture_quiescence_validate(initial, prior)
        note("eligible")
        if not eligible:
            diagnostic["status"] = "complete"
            note("empty")
            return initial
        diagnostic["stage"] = "unit-before"
        unit = _fixture_quiescence_properties("unit", deadline, evidence=diagnostic["propertyResults"], phase="unit-before")
        control = "/user.slice/user-" + str(M.UID) + ".slice/user@" + str(M.UID) + ".service"
        require(unit["Id"] == "user@" + str(M.UID) + ".service" and unit["LoadState"] == "loaded"
                and unit["User"] == str(M.UID) and unit["PAMName"] == "systemd-user"
                and unit["ActiveState"] == "active" and unit["SubState"] == "running"
                and re.fullmatch(r"[a-f0-9]{32}", unit["InvocationID"]) and unit["InvocationID"] != "0" * 32
                and unit["ControlGroup"] == control and re.fullmatch(r"[1-9][0-9]{0,9}", unit["MainPID"]),
                "Exact original fixture user-manager invocation required")
        manager = int(unit["MainPID"])
        require(manager in eligible, "Unbound fixture manager; never adopt")
        pam = next(pid for pid in eligible if pid != manager)
        diagnostic.update(managerPid=manager, pamPid=pam, invocationId=unit["InvocationID"], stage="session-closure")
        user = _fixture_quiescence_properties("user", deadline, evidence=diagnostic["propertyResults"], phase="session-closure")
        require(user["UID"] == str(M.UID) and user["Linger"] == "no" and user["Sessions"] == ""
                and user["State"] == "closing", "Original fixture PAM sessions must be closed without linger")
        note("properties-bound")
        diagnostic["stage"] = "image"
        binary = Path("/usr/lib/systemd/systemd")
        for entry in (binary, *binary.parents):
            info = entry.lstat()
            require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode),
                    "Protected fixture systemd image required")
        expected_image = U.pin(M.read_file(binary, 16 * 1024**2, uid=0, mode=0o755))
        diagnostic["stage"] = "actor-binding"
        for pid, row in eligible.items():
            fds[pid] = os.pidfd_open(pid, 0)
            procfds[pid] = os.open(Path("/proc") / str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            snapshots[pid] = _fixture_quiescence_actor(row, native, helper, procfds[pid], expected_image, deadline)
            note("actor-bound", pid)
        require(snapshots[manager]["parentPid"] == 1 and snapshots[pam]["parentPid"] == manager,
                "Original fixture manager/PAM parent relation differs")
        diagnostic["stage"] = "unit-after"
        require(_fixture_quiescence_properties("unit", deadline, evidence=diagnostic["propertyResults"], phase="unit-after") == unit,
                "Fixture user-manager invocation changed during binding")
        note("binding-complete")
        poller, exited = select.poll(), set()
        for fd in fds.values(): poller.register(fd, select.POLLIN)

        def events(milliseconds):
            for fd, flags in poller.poll(milliseconds):
                require(fd in fds.values() and flags & select.POLLIN and not flags & (select.POLLERR | select.POLLNVAL),
                        "Uncertain fixture pidfd event")
                pid = next(pid for pid, held in fds.items() if held == fd)
                require(pid not in exited, "Duplicate fixture exit event")
                exited.add(pid); poller.unregister(fd)
                note("pidfd-exit", pid)

        pam_reparented, terminal_seen, reaped_seen, gap_seen = False, set(), set(), set()
        for _ in range(600):
            diagnostic["stage"] = "inventory"
            require(time.monotonic() < deadline, "Fixture quiescence deadline; no signal or retry")
            exited_before_scan = set(exited)
            current = M.native_process_inventory(native, helper)
            diagnostic["samples"] += 1
            events(0)
            require(type(current) is dict and set(current) == {"processes", "terminalProcesses"}
                    and type(current["processes"]) is list and type(current["terminalProcesses"]) is list,
                    "Fixture inventory shape changed")
            seen = set()
            for row in current["processes"]:
                pid = row.get("pid")
                require(pid in eligible and pid not in seen and row == eligible[pid], "Unknown live fixture actor; never adopt")
                seen.add(pid)
                if pid in exited: continue
                diagnostic["stage"] = "live-actor"
                try:
                    observed = _fixture_quiescence_actor(row, native, helper, procfds[pid], expected_image, deadline)
                except (FileNotFoundError, ProcessLookupError):
                    events(0)
                    require(pid in exited, "Fixture actor disappeared without pidfd exit proof")
                    continue
                except RuntimeError as error:
                    if type(error) is not RuntimeError or str(error) not in (
                            "Fixture actor exited during observation", "Owned process is not live"):
                        raise
                    events(0)
                    require(pid in exited, "Fixture actor terminal without pidfd exit proof")
                    continue
                events(0)
                expected = {k: v for k, v in snapshots[pid].items() if k != "state"}
                reparented_now = pid == pam and observed["parentPid"] == 1
                if reparented_now:
                    require(manager in exited, "Live fixture PAM reparenting requires the held manager exit event")
                if pid == pam and (pam_reparented or reparented_now):
                    expected["parentPid"] = 1
                require({k: v for k, v in observed.items() if k != "state"}
                        == expected, "Live fixture actor identity changed")
                if reparented_now and not pam_reparented:
                    pam_reparented = True
                    note("pam-reparented", pid)
            for row in current["terminalProcesses"]:
                diagnostic["stage"] = "terminal-proof"
                pid = row.get("pid")
                require(pid in eligible and pid not in seen and pid in exited
                        and row == M.inventory_terminal_record(pid, row["origin"], row["before"], row["after"]),
                        "Unknown or unproven terminal fixture actor")
                seen.add(pid)
                for observed in (row["origin"], row["before"], row["after"]):
                    require(observed["startTime"] == eligible[pid]["startTime"]
                            and observed["procDirectory"] == snapshots[pid]["procDirectory"]
                            and observed["parentPid"] in ((1,) if pid == manager else (manager, 1))
                            and (pid == manager or observed["parentPid"] == manager or manager in exited)
                            and (pid != pam or not pam_reparented or observed["parentPid"] == 1),
                            "Terminal fixture identity changed")
                if pid not in terminal_seen:
                    note("terminal-observed", pid); terminal_seen.add(pid)
            missing_without_exit = set(eligible) - seen - exited
            if missing_without_exit:
                for pid in sorted(missing_without_exit - gap_seen): note("inventory-gap", pid)
                gap_seen.update(missing_without_exit)
                diagnostic["stage"] = "inventory-gap-wait"
                events(min(50, max(1, math.ceil((deadline - time.monotonic()) * 1000))))
                continue
            for pid in sorted((set(eligible) - seen - reaped_seen) & exited_before_scan):
                note("reaped", pid); reaped_seen.add(pid)
            if current == {"processes": [], "terminalProcesses": []}:
                if exited_before_scan != set(eligible):
                    continue
                require(time.monotonic() < deadline, "Fixture quiescence deadline")
                diagnostic.update(status="complete", stage="empty-inventory")
                note("complete")
                return current
            # Readable pidfds are unregistered; timed polls pace bounded reaping observations, never a blind settling sleep.
            diagnostic["stage"] = "event-wait"
            events(min(50, max(1, math.ceil((deadline - time.monotonic()) * 1000))))
        raise RuntimeError("Fixture quiescence observation bound exceeded")
    except Exception as error:
        try:
            diagnostic.update(status="refused", refusal={"type": type(error).__name__[:80], "message": str(error)[:300]})
            note("refusal")
        except Exception:
            diagnostic["captureUnavailable"] = True
        raise
    finally:
        pending_error, close_error = sys.exc_info()[0] is not None, None
        for fd in (*procfds.values(), *fds.values()):
            try: os.close(fd)
            except OSError as error: close_error = close_error or error
        if close_error is not None:
            diagnostic.update(status="refused", cleanupUnavailable=True)
            note("cleanup-refusal")
        if evidence is not None:
            try:
                diagnostic["elapsedMs"] = max(0, min(86400000, int((time.monotonic() - started) * 1000)))
                raw = json.dumps(diagnostic, ensure_ascii=True, allow_nan=False)
                if len(raw.encode()) > 32768:
                    diagnostic["events"] = []
                    diagnostic["truncated"] = True
                    raw = json.dumps(diagnostic, ensure_ascii=True, allow_nan=False)
                if len(raw.encode()) <= 32768:
                    evidence["fixtureQuiescence"] = json.loads(raw)
                else:
                    evidence["fixtureQuiescenceUnavailable"] = True
            except Exception:
                pass  # Optional evidence must not replace the original barrier result/refusal.
        if close_error is not None and not pending_error: raise close_error


def observe_refused_fixture_processes(initial, native, helper):
    """Read-only evidence after refusal; never grants continuation authority."""
    result = {"diagnosticOnly": True, "authorityGranted": False, "inputPermitted": False,
              "releaseReady": False, "observedExit": [], "pidfdExitIsNormalExit": False}
    fds = []
    try:
        require(type(initial) is dict and set(initial) == {"processes", "terminalProcesses"}
                and not initial["terminalProcesses"] and 0 < len(initial["processes"]) <= 8,
                "Bounded original live inventory required")
        require(M.native_process_inventory(native, helper) == initial, "Original inventory changed before observation")
        for row in initial["processes"]:
            fd = os.pidfd_open(row["pid"], 0)
            fds.append((fd, row["pid"], row["startTime"]))
        require(M.native_process_inventory(native, helper) == initial, "Original inventory changed during pidfd binding")
        result["actorEvidence"] = []
        for row in initial["processes"]:
            actor = {"pid": row["pid"], "startTime": row["startTime"]}
            procfd = None
            try:
                path = Path("/proc") / str(row["pid"])
                procfd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                before = M.inventory_process_snapshot(procfd, path, row["pid"], helper)
                require(before["startTime"] == row["startTime"] and before["Uid"] == before["Gid"] == [M.UID] * 4,
                        "Observed actor identity differs")
                with os.fdopen(os.open("cgroup", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=procfd), "rb") as stream:
                    raw = stream.read(4097)
                require(len(raw) <= 4096, "Observed actor cgroup exceeds bound")
                image = native.native_process(row["pid"], helper)
                after = M.inventory_process_snapshot(procfd, path, row["pid"], helper)
                require(before == after and image["startTime"] == row["startTime"] and image["executable"] == row["executable"],
                        "Observed actor changed during capture")
                actor.update(parentPid=before["parentPid"], uid=before["Uid"], gid=before["Gid"],
                    state=before["state"], cgroup=raw.decode("utf-8", errors="replace"),
                    kernelImageSha256=image["kernelImageSha256"])
            except Exception as error:
                actor["unavailable"] = type(error).__name__
            finally:
                if procfd is not None: os.close(procfd)
            result["actorEvidence"].append(actor)
        commands = {
            "unitBefore": ["/usr/bin/systemctl", "show", "user@" + str(M.UID) + ".service",
                "--property=MainPID,InvocationID,ControlGroup,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus"],
            "userBefore": ["/usr/bin/loginctl", "show-user", str(M.UID), "--property=UID,State,Sessions,Linger"],
        }
        for label, command in commands.items():
            try:
                result[label] = U.run_tool(command, timeout=5, limit=8192).decode("utf-8", errors="replace")
            except Exception as error:
                result[label + "Unavailable"] = type(error).__name__
        poller = select.poll()
        pending = {fd: (pid, start) for fd, pid, start in fds}
        for fd in pending: poller.register(fd, select.POLLIN)
        deadline = time.monotonic() + 25
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0: break
            events = poller.poll(max(1, math.ceil(remaining * 1000)))
            if not events: break
            for fd, flags in events:
                require(fd in pending and flags & select.POLLIN and not flags & (select.POLLERR | select.POLLNVAL),
                        "Uncertain pidfd event")
                pid, start = pending.pop(fd)
                poller.unregister(fd)
                result["observedExit"].append({"pid": pid, "startTime": start})
        result["pendingAtDeadline"] = [{"pid": pid, "startTime": start} for pid, start in pending.values()]
        try:
            result["finalInventory"] = M.native_process_inventory(native, helper)
        except Exception as error:
            result["finalInventoryUnavailable"] = type(error).__name__
        for label, command in commands.items():
            try:
                result[label.replace("Before", "After")] = U.run_tool(command, timeout=5, limit=8192).decode("utf-8", errors="replace")
            except Exception as error:
                result[label.replace("Before", "After") + "Unavailable"] = type(error).__name__
    except Exception as error:
        result["unavailable"] = {"type": type(error).__name__, "message": str(error)[:300]}
    finally:
        for fd, _, _ in fds:
            try: os.close(fd)
            except OSError: result["fdCloseUnavailable"] = True
    return result


def continuation_system_checks(polkit):
    directory(CONTROL, 0)
    output = CONTROL / "system-checks"
    output.mkdir(mode=0o700)
    directory(output, 0)
    polkit.verify_files(output)
    polkit.admin_config()
    polkit.credential_tools(output)


def changed_broker(env):
    changed_admission(env)
    original = changed_intent(env)
    require(os.getuid() == os.geteuid() == 0 and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "One root broker from exact reviewed checkout required")
    require(not os.path.lexists(CONTROL) and not os.path.lexists(OUTPUT) and not os.path.lexists(BASE / "mcp-transition-input")
            and not os.path.lexists(BASE / "mcp-node-observer") and not os.path.lexists(BASE / "result/mcp")
            and not os.path.lexists(BASE / "tls") and not os.path.lexists(U.TLS_CERT), "Fresh continuation only; no adoption/retry")
    directory(BASE, 0); directory(BASE / "result", M.UID)
    CONTROL.mkdir(mode=0o755); OUTPUT.mkdir(mode=0o700); os.chown(OUTPUT, M.UID, M.UID)
    record = {"schemaVersion": 1, "scope": "continuous-migrated-home-private017-lifecycle-only", "case": CHANGED_CASE,
              "context": original["context"], "scenarioPassed": False, "changedPayloadSameHomeAccepted": False,
              "privateTargetQualification": U.actual017_private_target_qualification(), "fixtureRelocked": False, **U.FALSE}
    polkit, native, helper = (U.load(name) for name in ("native-linux-polkit-probe", "native-linux-root-probe", "native-unix-window"))
    secret = payload = tls = lab = child = logs = sealed = home_guard = watcher = result = None
    relock, failure = False, None
    try:
        sealed = changed_adopt(env, original)
        initial_uid_inventory = M.native_process_inventory(native, helper)
        record["initialUidInventory"] = initial_uid_inventory
        if initial_uid_inventory != {"processes": [], "terminalProcesses": []}:
            prior = U.parse(U.read(BASE / "broker.json", 1048576, uid=0, mode=0o644))
            initial_uid_inventory = fixture_quiescence(initial_uid_inventory, prior, native, helper, evidence=record)
        require(initial_uid_inventory == {"processes": [], "terminalProcesses": []}, "Original fixture processes remain; never adopt or signal")
        scripts = CONTROL / "scripts"; scripts.mkdir(mode=0o755)
        changed_seal_sources(scripts, original["sources"])
        verifier_file, qualification = U.offline_verifier(env)
        require(qualification == original["verifier"], "Original verifier qualification changed")
        U.write(scripts / "verify-package-input", U.bound(verifier_file, qualification["tool"]["pin"], 64 * 1024**2), 0o755)
        verifier = (scripts / "verify-package-input", qualification)
        installer_file, installer_qualification = changed_installer_verifier(env)
        require(installer_qualification == original["installerVerifier"], "Original Linux actual017 verifier qualification drift")
        U.write(scripts / "private-deb017-dea67", U.bound(installer_file, installer_qualification["tool"]["pin"], 64 * 1024**2), 0o755)
        driver = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
        U.write(scripts / "tauri-driver", U.bound(driver, original["driver"], 64 * 1024**2), 0o755)
        U.bound(Path(env["CONTROLLER_NODE"]), original["node"], 128 * 1024**2, mode=0o755)
        value, review, transition, donor = changed_verify_inputs(env, original)
        sealed["transition"], sealed["deadline"] = transition, time.monotonic() + 900
        U.save(CONTROL / "state.json", sealed, 0o644); U.save(CONTROL / "review.json", review, 0o644)
        U.save(CONTROL / "donor-review.json", donor, 0o644)
        U.verify_installed(review, "16")
        home_guard = changed_guard(sealed, verifier); changed_broker_preservation(sealed, home_guard)
        _, _, _, inventories = changed_transition_inputs(sealed, verifier)
        for name in ("runtime", "tmp"):
            p = OUTPUT / name; p.mkdir(mode=0o700); os.chown(p, M.UID, M.UID)
        transport_env = changed_transport_environment(env)
        transport, pins = U.prepare_transport(CONTROL / "inputs", value, transport_env)
        for p in (transport.parent, transport, *transport.rglob("*")):
            require(not p.is_symlink(), "Redirected owned transport"); os.chown(p, M.UID, M.UID)
        # The neighboring carrier/profile admission must qualify this exact tuple.
        inspected = subprocess.run([env["CONTROLLER_NODE"], str(scripts / "linux-update-lab-feed.cjs"),
            "update-changed-mcp-016-017-inspect", "deb", str(transport)], user=M.UID, group=M.UID, extra_groups=[],
            env=transport_env, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=False)
        require(inspected.returncode == 0 and 0 < len(inspected.stdout) <= 65536 and len(inspected.stderr) <= 8192, "Exact changed carrier transport preflight refused")
        inspected_report = U.parse(inspected.stdout)
        require(inspected_report["fromVersion"] == "0.1.16" and inspected_report["targetVersion"] == "0.1.17"
                and inspected_report["publicDiscovery"] is inspected_report["releaseReady"] is False, "Transport scope differs")
        continuation_system_checks(polkit)
        require(polkit.fixture_credential("status") == "L", "Original synthetic account is not locked")
        changed_broker_preservation(sealed, home_guard)
        tls = changed_prepare_tls(env)
        lab = changed_start_transport(env, transport, {"nodeImage": original["node"]})
        secret = bytearray(secrets.token_hex(32).encode()); relock = True
        polkit.fixture_credential("provision", secret)
        require(polkit.fixture_credential("status") == "P", "Owned account provisioning refused")
        payload = bytearray((json.dumps({"secret": secret.decode(), "proxyUrl": lab.proxy}) + "\n").encode())
        child = subprocess.Popen(changed_session_command(env), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 cwd=BASE, env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
        logs = native.Capture(child, CONTROL, "session")
        require(child.stdin.write(payload) == len(payload), "Private continuation frame delivery uncertain")
        child.stdin.close(); M.wipe(secret); M.wipe(payload)
        state, index = {"sequence": 1, "nonces": set()}, 1
        while child.poll() is None and time.monotonic() < sealed["deadline"]:
            logs.pump(0.02); require(not any(row["truncated"] for row in logs.metadata().values()), "Continuation output exceeded bound")
            M.serve_inventory(state, record, env["GITHUB_SHA"], "deb-approve", native, helper, cohort="update", channel="migrated-update")
            if watcher is None and os.path.lexists(OUTPUT / "ready-arm.json"):
                request = U.parse(U.read(OUTPUT / "ready-arm.json", 16384, uid=M.UID, mode=0o600))
                require(request == {"context": original["context"]}, "Foreign Ready arm request")
                changed_recheck(env, original, sealed); changed_broker_preservation(sealed, home_guard)
                watcher = BrokerReadyWatcher(home_guard, sealed["deadline"]); watcher.arm()
                U.save(CONTROL / "ready-armed.json", {"context": original["context"]}, 0o644)
            if watcher is not None and watcher._error is not None: raise watcher._error
            file = OUTPUT / f"input-{index}.json"
            if os.path.lexists(file):
                raw = U.read(file, 256, uid=M.UID, mode=0o600)
                if raw.endswith(b"\n"):
                    require(watcher is not None and index <= 12 and U.parse(raw) == {"index": index}, "Only original finite watched input sequence allowed")
                    changed_recheck(env, original, sealed); changed_broker_preservation(sealed, home_guard)
                    root = U.parse(U.read(OUTPUT / "root.json", 16384, uid=M.UID, mode=0o600))
                    proof = U.actual017_pending_proof(root, native, helper, polkit, U.actual017_a1_data())
                    M.publish(CONTROL / f"input-{index}.json", {"index": index, "proof": proof}, mode=0o644); index += 1
        record["sessionExit"] = child.poll()
        require(type(record["sessionExit"]) is int and record["sessionExit"] == 0, "Changed continuation failed/unknown; no retry or manual substitute")
        require(watcher is not None, "Independent broker Ready watcher missing")
        ready = watcher.wait(); watcher.close(); U.save(CONTROL / "handoff-ready.json", ready, 0o644)
        result = U.parse(U.read(OUTPUT / "report.json", 2 * 1024**2, uid=M.UID, mode=0o600))
        require(result["harnessSource"] == env["GITHUB_SHA"] and result["scenarioPassed"] is True
                and ready == result["mcpProtocol"]["captures"]["ready"], "Independent actual broker/session Ready captures differ")
        changed_outcome(result, inventories, verifier, CHANGED_PROTECTED)
        home_guard.finish(); changed_broker_preservation(sealed, home_guard)
        completed = U.transition_file(HOME / home_guard.handoff, mode=0o600)
        require(completed == result["mcpProtocol"]["captures"]["completed"] == home_guard._record, "Independent actual Completed differs")
        U.save(CONTROL / "handoff-completed.json", completed, 0o644)
        U.actual017_verify_installed(review)
        record["nativePassed"] = record["preservationPassed"] = True
        lab.finish(close_message=True); lab = None
        transport_report = U.parse(U.read(transport / "lab-transport.json", 65536, uid=M.UID, mode=0o600))
        record["transport"] = U.validate_transport_report(transport_report, pins, "deb-approve"); record["transportClosed"] = True
    except Exception as error:
        failure = error; record["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        changed_retain_home_path_refusal(record, error)
        changed_retain_directory_refusal(record, error)
        if str(error) == "Original fixture processes remain; never adopt or signal" and "initialUidInventory" in record:
            try:
                record["refusedProcessObservation"] = observe_refused_fixture_processes(record["initialUidInventory"], native, helper)
            except Exception:
                record["refusedProcessObservationUnavailable"] = True
    finally:
        M.wipe(secret); M.wipe(payload)
        if watcher is not None:
            try: watcher.close()
            except Exception as error: failure = failure or error; record["cleanupRefused"] = True
        for owned, close_message in ((lab, True), (tls, False)):
            if owned is not None:
                try: owned.finish(close_message=close_message)
                except Exception as error: failure = failure or error; record["cleanupRefused"] = True
        try: record["tlsCleanup"] = U.tls_cleanup(env)
        except Exception as error: failure = failure or error; record["cleanupRefused"] = True
        try:
            if relock: polkit.fixture_credential("lock")
            require(polkit.fixture_credential("status") == "L", "Original account relock unproven"); record["fixtureRelocked"] = True
        except Exception as error: failure = failure or error; record["cleanupRefused"] = True
        if logs is not None:
            try:
                logs.pump(); record["logs"] = logs.metadata()
                require(all(row["eof"] and not row["truncated"] for row in record["logs"].values()), "Continuation output incomplete")
                logs.close()
            except Exception as error: failure = failure or error; record["cleanupRefused"] = True
        if failure is None:
            try:
                changed_recheck(env, original, sealed); changed_transition_inputs(sealed, verifier)
                U.actual017_verify_installed(review); changed_outcome(result, inventories, verifier, CHANGED_PROTECTED)
                home_guard.finish(); changed_broker_preservation(sealed, home_guard)
                require(U.transition_file(HOME / home_guard.handoff, mode=0o600) == completed, "Completed changed after cleanup")
                record["scenarioPassed"] = record["changedPayloadSameHomeAccepted"] = changed_broker_outcome(record)
            except Exception as error: failure = error
        if failure is not None:
            record.update(scenarioPassed=False, changedPayloadSameHomeAccepted=False, recovery="unknown-no-retry-disposable-runner-teardown")
        U.save(CONTROL / "broker.json", record, 0o644)
    if failure is not None: raise failure


def changed_export(env):
    changed_admission(env)
    require(os.getuid() == os.geteuid() == 0, "Root-only finite changed-payload evidence export")
    output = Path(env["RUNNER_TEMP"]) / "native-linux-migrated-update-evidence"
    require(output.parent.resolve() == output.parent and not os.path.lexists(output), "Exclusive evidence export required")
    uid = output.parent.stat().st_uid; output.mkdir(mode=0o700); os.chown(output, uid, uid)
    files = [INTENT, *(BASE / name for name in REPORTS),
        *(CONTROL / name for name in ("broker.json", "state.json", "review.json", "donor-review.json", "session.stdout", "session.stderr", "handoff-ready.json", "handoff-completed.json",
          "inputs/source-receipt.json", "inputs/acquisition.json", "inputs/incoming-profile.json", "inputs/profile.json")),
        *(OUTPUT / name for name in ("report.json", "root.json", "handoff-ready.json", "handoff-completed.json", "html-driver.stdout", "html-driver.stderr",
          "successor-html-driver.stdout", "successor-html-driver.stderr", "reopened-projects-html-driver.stdout", "reopened-projects-html-driver.stderr", "initial-bitmap/root-window.png", "successor-bitmap/root-window.png")),
        BASE / "result/mcp-transition-protocol.json"]
    polkit = U.load("native-linux-polkit-probe")
    labels = [kind + Path(name).name for name in polkit.FILES
              for kind in ("observed-package-", "observed-owner-", "package-", "owner-")]
    labels += [kind + Path(name).name for name in polkit.CREDENTIAL_TOOLS
               for kind in ("credential-package-", "credential-owner-")]
    for check_dir in (BASE, CONTROL / "system-checks"):
        files.append(check_dir / "system-files-observation.json")
        files.extend(check_dir / (label + "." + suffix) for label in labels for suffix in ("json", "stdout", "stderr"))
    for name in ("aBefore", "aAfter", "aDuringB", "b"): files.append(BASE / "result/mcp" / ("observer-" + name + ".json"))
    for role in ("existing", "reconnect"):
        files.extend(BASE / "result/mcp" / role / leaf for leaf in ("sdk.stdout", "sdk.stderr", "sdk-result.json"))
    tool = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-actual017-verifier"
    tool_files = [tool / "logs" / (label + "." + suffix)
        for label in ("rustup", "cargo-path", "cargo-version", "rustc-path", "rustc-version", "build", "unit", "guards", "inspect", "verify")
        for suffix in ("stdout", "stderr", "json")]
    tool_files.append(tool / "receipt.json")
    tool_files.append(tool / "logs/cargo-output.json")
    files.extend(tool_files)
    inventory = []
    for index, file in enumerate(files):
        if not os.path.lexists(file): inventory.append({"source": str(file), "missing": True}); continue
        info = file.lstat()
        if file in tool_files: require(info.st_uid == uid, "Foreign runner tooling export owner")
        else: require(info.st_uid in (0, M.UID), "Foreign export owner")
        raw = U.read(file, 16 * 1024**2 if file.suffix == ".png" else 2 * 1024**2, uid=info.st_uid)
        name = str(index) + "__" + file.name; U.write(output / name, raw); os.chown(output / name, uid, uid)
        inventory.append({"source": str(file), "member": name, **U.pin(raw)})
    U.save(output / "export.json", {"case": CHANGED_CASE, "files": inventory, **U.FALSE}); os.chown(output / "export.json", uid, uid)


def changed_dispatch():
    require(len(sys.argv) == 2 and sys.argv[1] in ("prepare-changed-mcp", "session-changed-mcp", "broker-changed-mcp", "export-changed-mcp", "_tls-guard-changed-mcp"), "One fixed changed-payload phase required")
    env = dict(os.environ)
    if sys.argv[1] == "_tls-guard-changed-mcp":
        changed_runtime_binding(env); U.tls_guard(env)
    else:
        {"prepare-changed-mcp": changed_prepare, "session-changed-mcp": changed_session,
         "broker-changed-mcp": changed_broker, "export-changed-mcp": changed_export}[sys.argv[1]](env)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] in ("prepare-changed-mcp", "session-changed-mcp", "broker-changed-mcp", "export-changed-mcp", "_tls-guard-changed-mcp"):
        changed_dispatch()
    else:
        main()
