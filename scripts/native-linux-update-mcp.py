"""Existing managed MCP connection checks for the disposable updater fixture.

Uses the migration fixture's reviewed SDK transport, not an EOF-only sentinel.
The caller must supply the original signed resource inventory and its existing
production-key verifier. Fixture seeding is exclusive to the fresh disposable
session; protocol checks never replace an existing route or edit settings.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess


TOOLS = sorted(("get_bridge_status", "get_unity_command_status", "list_unity_projects", "select_unity_project"))
SERVER = {"name": "creator-works-mcp", "version": "2.7.7"}
SDK_LOCK = "ded7a99b78aca304253d5287cc1b884a845afde083eb32d1a2abecd14468ba60"
PHASES = ("before-update", "after-update", "after-hub-close")
ROUTE_BASE = "data/creator-hub/mcp-route-v1/linux-x86_64"
MODULE_FILES = (
    "mcp/creator-works-mcp-launcher", "mcp/server/creator-works-mcp.mjs",
    "mcp/server/runtime/node", "mcp/server/runtime/LICENSE", "mcp/server/runtime/VERSION",
    "mcp/server/unity-extension/Editor/BanterMCPBridge.cs",
    "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png",
    "mcp/server/LICENSE", "mcp/server/THIRD_PARTY_NOTICES.md",
)
ROUTING_FILES = tuple("routing/" + name for name in (
    "creator-hub-mcp-router", "router.json", "router.minisig", "runtime.json", "runtime.minisig"))


def require(value, message):
    if not value:
        raise RuntimeError(message)


def same_process(before, after):
    fields = ("pid", "startTime", "parentPid", "uids", "kernelImageSha256")
    require(all(key in before and key in after and before[key] == after[key] for key in fields),
            "Existing MCP process identity changed")


def _protocol(value, checks):
    require(type(value) is dict and set(value) == {"checked", "checks", "tools", "signalsRequested"}
            and value["checked"] is True and type(value["checks"]) is int and value["checks"] == checks
            and value["tools"] == TOOLS and value["signalsRequested"] is False,
            "Real MCP listTools response required; EOF/liveness is not protocol evidence")


def _stamp(info):
    return tuple(getattr(info, name) for name in
                 ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))


def _record(path, reader, limit=2 * 1024**2):
    first = path.lstat()
    require(stat.S_ISREG(first.st_mode) and not path.is_symlink() and path.resolve(strict=True) == path,
            "MCP fixture file is redirected or nonregular")
    raw = reader(path, limit)
    require(_stamp(path.lstat()) == _stamp(first), "MCP fixture file changed during capture")
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "identity": _stamp(first)}


def _fixture_session(home, migration):
    require(os.name == "posix" and os.getuid() == os.geteuid() == migration.UID
            and home == Path("/opt/creator-polkit-fixture/result/home"),
            "Only the existing disposable updater session may seed MCP state")


def prepare_existing_route(migration, home, source, resource_files, verify_signature):
    """Seed only the fresh CI fixture, never adopt/repair an installed route.

    Like migration's synthetic client settings, this represents pre-update
    state. The real router independently verifies both signatures and payloads.
    It is not evidence that Hub installed, migrated or approved this setup.
    """
    home, source = Path(home), Path(source)
    _fixture_session(home, migration)
    require(type(resource_files) is dict and set(resource_files) == set(MODULE_FILES + ROUTING_FILES)
            and all(type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value) for value in resource_files.values()),
            "Complete original signed resource pins required before fixture setup")
    require(home.resolve(strict=True) == home and (home / "data").resolve(strict=True) == home / "data"
            and source.is_absolute() and source.resolve(strict=True) == source,
            "Canonical fixture home and verified resource source required")
    base = home / "data/creator-hub"
    require(not os.path.lexists(base), "Existing MCP fixture state is never adopted or overwritten")
    raw = {}
    for name in MODULE_FILES + ROUTING_FILES:
        raw[name] = migration.read_file(source / name, 128 * 1024**2)
        require(hashlib.sha256(raw[name]).hexdigest() == resource_files[name], "Original signed MCP input changed")
    require(sum(map(len, raw.values())) <= 256 * 1024**2, "Bounded MCP fixture source required")
    for name in ("runtime", "router"):
        require(verify_signature(source / ("routing/" + name + ".json"),
                                 source / ("routing/" + name + ".minisig")) is None,
                "Production-key signature verification required before fixture writes")
    require(all(migration.read_file(source / name, 128 * 1024**2) == body for name, body in raw.items()),
            "MCP input changed during signature verification; nothing was published")
    descriptor = migration.P.parse(raw["routing/runtime.json"])
    module = descriptor["module"]
    require(module["files"] == {name: resource_files[name] for name in MODULE_FILES}
            and descriptor["platform"] == "linux" and descriptor["arch"] == "x86_64"
            and descriptor["hubVersion"] == "0.1.16" and module["version"] == "2.7.7",
            "Exact baseline signed MCP payload required")
    canonical = json.dumps({"executable": module["executable"], "version": module["version"],
                            "files": dict(sorted(module["files"].items()))}, separators=(",", ":"), ensure_ascii=False).encode()
    generation, descriptor_id = hashlib.sha256(canonical).hexdigest(), hashlib.sha256(raw["routing/runtime.json"]).hexdigest()
    # Every parent is created explicitly private; inherited umask cannot expose
    # intermediate directories. Failure retains evidence, with no recursive cleanup.
    base.mkdir(mode=0o700)
    made = {base}
    def publish(relative, body, mode):
        target = base / relative
        parent = base
        for part in Path(relative).parts[:-1]:
            parent = parent / part
            if parent not in made:
                parent.mkdir(mode=0o700); made.add(parent)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, "wb") as output:
            require(output.write(body) == len(body), "MCP fixture publication incomplete")
            output.flush(); os.fsync(output.fileno())
    for name in MODULE_FILES:
        publish("runtime-generations/linux-x86_64/" + generation + "/" + name, raw[name],
                0o500 if name in ("mcp/creator-works-mcp-launcher", "mcp/server/runtime/node") else 0o400)
    prefix = "mcp-route-v1/linux-x86_64/"
    for name in ("runtime.json", "runtime.minisig"):
        publish(prefix + "descriptors/" + descriptor_id + "/" + name, raw["routing/" + name], 0o600)
    for name in ("creator-hub-mcp-router", "router.json", "router.minisig"):
        publish(prefix + "router-v1/" + name, raw["routing/" + name], 0o500 if name == "creator-hub-mcp-router" else 0o600)
    publish(prefix + "active.json", json.dumps({"schemaVersion": 1, "descriptorSha256": descriptor_id,
                                               "generation": generation}, separators=(",", ":")).encode(), 0o600)
    return BoundRoute(migration, home, resource_files, verify_signature)


class BoundRoute:
    def __init__(self, migration, home, resource_files, verify_signature):
        self.migration, self.home = migration, Path(home)
        require(self.home.is_absolute() and self.home.resolve(strict=True) == self.home,
                "Canonical isolated MCP fixture home required")
        require(type(resource_files) is dict and set(resource_files) == set(MODULE_FILES + ROUTING_FILES)
                and all(type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value) for value in resource_files.values()),
                "Complete original signed MCP/router resource inventory required")
        self.binding = {"resourceFiles": dict(resource_files)}
        self.verify_signature = verify_signature
        self.command, self.server = migration.verified_route(self.home, self.binding)
        self.command, self.server = Path(self.command), Path(self.server)
        require(self.command == self.home / ROUTE_BASE / "router-v1/creator-hub-mcp-router",
                "Only the existing stable managed router may be used")
        self.node = self.server.parent / "runtime/node"
        self.baseline = self._capture()

    def _capture(self):
        command, server = self.migration.verified_route(self.home, self.binding)
        require(Path(command) == self.command and Path(server) == self.server,
                "Existing managed MCP route changed")
        base = self.home / ROUTE_BASE
        active = self.migration.P.parse(self.migration.read_file(base / "active.json", 16384))
        descriptor = base / "descriptors" / active["descriptorSha256"]
        for directory, name in ((descriptor, "runtime"), (self.command.parent, "router")):
            # This is the caller's already source/key-bound offline verifier;
            # no persisted `verified: true` value grants execution permission.
            require(self.verify_signature(directory / (name + ".json"), directory / (name + ".minisig")) is None,
                    "MCP signature verifier must reject by exception, not a supplied approval flag")
        paths = (base / "active.json", descriptor / "runtime.json", descriptor / "runtime.minisig",
                 self.command.parent / "router.json", self.command.parent / "router.minisig")
        records = {path.relative_to(self.home).as_posix(): _record(path, self.migration.read_file) for path in paths}
        for path, name in ((descriptor / "runtime.json", "routing/runtime.json"),
                           (descriptor / "runtime.minisig", "routing/runtime.minisig"),
                           (self.command.parent / "router.json", "routing/router.json"),
                           (self.command.parent / "router.minisig", "routing/router.minisig")):
            require(records[path.relative_to(self.home).as_posix()]["sha256"] == self.binding["resourceFiles"][name],
                    "Signed MCP metadata changed during verification")
        records[self.command.relative_to(self.home).as_posix()] = _record(self.command, self.migration.read_file, 32 * 1024**2)
        require(records[self.command.relative_to(self.home).as_posix()]["sha256"] == self.binding["resourceFiles"]["routing/creator-hub-mcp-router"],
                "Retained router differs from the original signed package")
        require(self.migration.verified_route(self.home, self.binding) == (self.command, self.server),
                "Managed MCP route changed during capture")
        return records

    def recheck(self):
        require(self._capture() == self.baseline, "MCP route/settings identity changed during update")


def _connect(route, directory, environment, pages, helper, native):
    migration = route.migration
    lock = migration.read_file(Path("/opt/creator-polkit-fixture/sdk/package-lock.json"), 2 * 1024**2, uid=0, mode=0o644)
    require(hashlib.sha256(lock).hexdigest() == SDK_LOCK == migration.SDK_LOCK,
            "Original migration SDK lock and root-owned staged dependencies required")

    class UpdateSDK(migration.SDK):
        # Keep the original SDK protocol, bounded response/check/EOF methods.
        # Only launch initialization changes: both images come from this route,
        # not the separately installed legacy MCP paths used by migration tests.
        def __init__(self):
            self.pages, self.helper, self.native = pages, helper, native
            self.root = directory
            self.runtime = subprocess.Popen([str(route.command)], cwd=environment["HOME"], env=environment,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.runtime_identity = native.native_process(self.runtime.pid, helper)
            require(self.runtime_identity["parentPid"] == os.getpid()
                    and self.runtime_identity["uids"] == [migration.UID] * 4
                    and self.runtime_identity["kernelImageSha256"] == route.binding["resourceFiles"]["routing/creator-hub-mcp-router"],
                    "Owned MCP router kernel image/parent/UID differs")
            fds = [stream.fileno() for stream in (self.runtime.stdin, self.runtime.stdout, self.runtime.stderr)]
            self.child = subprocess.Popen([str(route.node), "-e", migration.SDK_JS, *map(str, fds)],
                                          cwd=environment["HOME"], env=environment, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=fds)
            self.child_identity = native.native_process(self.child.pid, helper)
            require(self.child_identity["parentPid"] == os.getpid()
                    and self.child_identity["uids"] == [migration.UID] * 4
                    and self.child_identity["kernelImageSha256"] == route.binding["resourceFiles"]["mcp/server/runtime/node"],
                    "Owned SDK Node kernel image/parent/UID differs")
            for stream in (self.runtime.stdin, self.runtime.stdout, self.runtime.stderr):
                stream.close()
            self.pidfd = os.pidfd_open(self.runtime.pid)
            self.capture = native.Capture(self.child, directory, "sdk")
            self.offset = 0
            self.handshake = self.response()
            require(self.handshake == {"ready": True, "server": SERVER}, "Real MCP SDK handshake required; EOF is not a connection")
            _protocol(self.check(), 1)

    route.recheck()
    return UpdateSDK()


class McpFixture:
    def __init__(self, route, evidence, environment, protected_paths, pages, helper, native):
        self.route, self.directory = route, Path(evidence)
        require(self.directory.is_absolute() and self.directory.resolve(strict=True) == self.directory
                and self.directory.is_dir(), "Canonical existing private MCP evidence directory required")
        self.environment = dict(environment)
        require(self.environment.get("HOME") == str(route.home)
                and self.environment.get("XDG_DATA_HOME") == str(route.home / "data")
                and self.environment.get("XDG_CONFIG_HOME") == str(route.home / "config")
                and self.environment.get("CREATOR_WORKS_TOOL_GROUPS") == "none"
                and self.environment.get("CREATOR_WORKS_CONFIG_OWNER") == "creator-hub-v1"
                and not any(key.upper() in ("NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH") for key in environment),
                "Fixed native MCP context without runtime overrides required")
        require(len(protected_paths) > 0 and len(protected_paths) <= 64 and len(set(protected_paths)) == len(protected_paths)
                and all(type(name) is str and name and not Path(name).is_absolute()
                        and all(part not in ("", ".", "..") for part in name.split("/")) for name in protected_paths),
                "Finite unchanged fixture file list required")
        self.paths = tuple(protected_paths)
        self.before = self._preserved()
        self.pages, self.helper, self.native = pages, helper, native
        self.connection = self.replacement = None
        self.checks, self.reconnected, self.closed = [], None, False
        self.started = self.reconnect_started = False

    def _preserved(self):
        return {name: _record(self.route.home / name, self.route.migration.read_file) for name in self.paths}

    def _guard(self):
        self.route.recheck()
        require(self._preserved() == self.before, "Unrelated fixture settings or project files changed")
        if self.connection is not None:
            self.connection.alive()
            same_process(self.original_router, self.connection.native.native_process(self.connection.runtime.pid, self.helper))
            same_process(self.original_sdk, self.connection.native.native_process(self.connection.child.pid, self.helper))

    def _new(self, name):
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        return _connect(self.route, directory, self.environment, self.pages, self.helper, self.native)

    def start(self):
        require(not self.started and not self.closed, "MCP fixture start cannot be repeated")
        self.started = True
        self._guard()
        self.connection = self._new("existing")
        require(self.connection.handshake == {"ready": True, "server": SERVER}, "Real MCP initialization required")
        self.original_router = copy.deepcopy(self.connection.runtime_identity)
        self.original_sdk = copy.deepcopy(self.connection.child_identity)
        return self.check("before-update")

    def check(self, phase):
        require(not self.closed and self.connection is not None and len(self.checks) < len(PHASES)
                and phase == PHASES[len(self.checks)], "MCP checks require each exact update phase once")
        self._guard()
        value = self.connection.check()
        _protocol(value, len(self.checks) + 2)
        self._guard()
        record = {"phase": phase, "handshake": copy.deepcopy(self.connection.handshake),
                  "protocol": copy.deepcopy(value), "router": copy.deepcopy(self.original_router),
                  "sdk": copy.deepcopy(self.original_sdk), "route": copy.deepcopy(self.route.baseline)}
        self.checks.append(record)
        return copy.deepcopy(record)

    def reconnect(self):
        require(not self.closed and len(self.checks) == len(PHASES) and not self.reconnect_started,
                "Reconnect requires the original connection to survive every phase; no retry")
        self.reconnect_started = True
        self._guard()
        self.replacement = self._new("reconnect")
        require(self.replacement.handshake == {"ready": True, "server": SERVER}, "Real MCP reconnect initialization required")
        require(self.replacement.runtime_identity["pid"] != self.original_router["pid"]
                and self.replacement.child_identity["pid"] != self.original_sdk["pid"],
                "Reconnect must establish fresh owned MCP and SDK processes")
        value = self.replacement.check()
        _protocol(value, 2)
        same_process(self.replacement.runtime_identity,
                     self.replacement.native.native_process(self.replacement.runtime.pid, self.helper))
        same_process(self.replacement.child_identity,
                     self.replacement.native.native_process(self.replacement.child.pid, self.helper))
        self._guard()  # Keep the original connection alive through reconnection.
        self.replacement.close()
        self._guard()
        self.reconnected = {"command": str(self.route.command), "handshake": copy.deepcopy(self.replacement.handshake),
                            "protocol": copy.deepcopy(value),
                            "router": copy.deepcopy(self.replacement.runtime_identity),
                            "sdk": copy.deepcopy(self.replacement.child_identity), "normalEofClose": True}
        return copy.deepcopy(self.reconnected)

    def close(self):
        require(not self.closed and self.reconnected is not None, "Do not close existing MCP before verified reconnection")
        self._guard()
        self.connection.close()
        self.closed = True
        self.route.recheck()
        require(self._preserved() == self.before, "MCP cleanup changed unrelated fixture files")
        return {"schemaVersion": 1, "scope": "existing-managed-mcp-update-protocol-only",
                "checks": copy.deepcopy(self.checks), "reconnect": copy.deepcopy(self.reconnected),
                "protectedBefore": copy.deepcopy(self.before), "protectedAfter": self._preserved(),
                "originalNormalEofClose": True, "signalsRequested": False,
                "liveAiAccepted": False, "unityAccepted": False, "releaseReady": False}
