"""Pure/temp execution contracts only; never installs or opens a native app."""
import ast
import copy
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from contextlib import ExitStack, contextmanager
from unittest.mock import Mock, patch
from types import SimpleNamespace

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("migration016", HERE / "native-linux-production-016-migration.py")
M = importlib.util.module_from_spec(spec); sys.modules[spec.name] = M; spec.loader.exec_module(M)


def environment(scenario=None):
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
            "GITHUB_REF": M.BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": M.WORKFLOW,
            "GITHUB_SHA": "f" * 40, "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1", "CREATOR_MIGRATION_016_EXECUTE": "true",
            "CREATOR_MIGRATION_016_SCENARIO": scenario or M.SCENARIOS[0]}


def binding():
    pins = {key: {"size": 64, "sha256": "a" * 64} for key in M.P.PINS}
    profile = {"schemaVersion": 1, "cohort": M.P.COHORT, "mode": "pages", "pins": pins,
               "assembly": {"sourceCommit": "b" * 40, "sourceTree": "c" * 40, "runId": 1, "runAttempt": 1,
                            "jobId": 2, "artifactId": 3, "zipBytes": 64, "zipSha256": "d" * 64}}
    api = {"schemaVersion": 1, "cohort": M.P.COHORT, "harnessSource": "f" * 40, "assembly": profile["assembly"],
           "privatePayload": dict(M.P.PRIVATE), "privateSourcePaths": {key: "9" * 40 for key in M.P.PRIVATE_PATHS}, "legacy": [], **M.P.FLAGS}
    for product, repo, tag, name in (("mcp", "CREATOR-WORKS-UNITY-MCP", "v2.7.7", "Creator.Works.MCP_2.7.7_amd64.deb"),
                                    ("setup", "CREATOR-PROJECT-SETUP", "v0.3.7", "Creator.Project.Setup_0.3.7_amd64.deb")):
        size, sha = M.P.S.LEGACY[product]
        api["legacy"].append({"product": product, "repo": repo, "tag": tag, "name": name, "size": size, "sha256": sha, "assetId": 1, "releaseId": 2})
    contract = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                "mcpVersion": M.MCP_VERSION, "setupVersion": M.SETUP_VERSION, "nativeAcceptance": False, "externalQualificationRequired": True}
    proof = {"cohort": M.P.COHORT, "sourceCommit": profile["assembly"]["sourceCommit"], "sourceTree": profile["assembly"]["sourceTree"],
             "compiledFeatures": list(M.P.FEATURES), "rawHub": pins["rawHub"], "hub": pins["hub"], "productionContract": contract,
             "rawToPackaged": "exact-tauri-bundle-marker-deb", **M.P.FLAGS}
    return {"schemaVersion": 1, "cohort": M.P.COHORT, "inspectionOnly": True, "profile": profile, "api": api,
            "productionProof": proof, "packageFiles": {M.P.S.DEB_MEMBERS[name]: {**pins[name], "mode": mode} for name, mode in
                                                       (("hub", 0o755), ("helper", 0o755), ("policy", 0o644), ("service", 0o644))},
            "resourceFiles": {"mcp/server/creator-works-mcp.mjs": "8" * 64}, **M.P.FLAGS}


def records(session, commands, ids):
    return [{"session": session * 64, "id": number, "command": name, "outcome": "returned-ok"} for name, number in zip(commands, ids)]


@contextmanager
def hardening_fixture(uid=0):
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
        root = Path(temporary).resolve()
        env = {**environment(), "GITHUB_WORKSPACE": str(HERE.parent)}
        paths = {str(q) for name in M.CI_SHARED_DIRECTORIES for q in (M.PurePosixPath(name), *M.PurePosixPath(name).parents)}
        def info(inode, mode=0o755):
            return SimpleNamespace(st_mode=M.stat.S_IFDIR | mode, st_uid=0, st_gid=0, st_dev=1, st_ino=inode, st_nlink=3)
        fixture = SimpleNamespace(root=root, env=env, directories={name: info(i + 1, 0o777 if name in M.CI_SHARED_DIRECTORIES else 0o755)
                                  for i, name in enumerate(sorted(paths))}, base=info(100), fds={}, changes=[], race=None, raced=False)
        real_lstat, real_stat = os.lstat, os.stat
        def copied(meta):
            return SimpleNamespace(**vars(meta))
        def lstat(path, *args, **kwargs):
            if str(path) == str(root): return copied(fixture.base)
            if str(path) in fixture.directories: return copied(fixture.directories[str(path)])
            return real_lstat(path, *args, **kwargs)
        def name(part, fd=None):
            return "/" if fd is None else str(M.PurePosixPath(fixture.fds[fd][0]) / part)
        def opened(part, flags, *, dir_fd=None):
            self_path = name(part, dir_fd)
            assert flags & M.os.O_DIRECTORY and flags & M.os.O_NOFOLLOW and flags & M.os.O_CLOEXEC
            meta = fixture.directories[self_path]
            if not M.stat.S_ISDIR(meta.st_mode): raise OSError(40, "Synthetic alias or non-directory")
            fd = 10000 + len(fixture.fds)
            fixture.fds[fd] = (self_path, meta)
            return fd
        def named(part, *, dir_fd=None, follow_symlinks=True):
            if dir_fd is None:
                return lstat(part) if str(part) == str(root) or str(part) in fixture.directories else real_stat(part, follow_symlinks=follow_symlinks)
            assert follow_symlinks is False
            self_path = name(part, dir_fd)
            if self_path == fixture.race and not fixture.raced:
                replacement = copied(fixture.directories[self_path]); replacement.st_ino += 1000
                fixture.directories[self_path] = replacement; fixture.raced = True
            return copied(fixture.directories[self_path])
        def changed(fd, mode):
            self_path, meta = fixture.fds[fd]
            assert self_path in M.CI_SHARED_DIRECTORIES and mode == 0o755
            assert (root / "fixture-directory-hardening-before.json").is_file()
            fixture.changes.append(self_path); meta.st_mode = M.stat.S_IFDIR | mode
        for attr, value in (("BASE", root),): stack.enter_context(patch.object(M, attr, value))
        stack.enter_context(patch.object(M.sys, "platform", "linux"))
        stack.enter_context(patch.multiple(M.os, getuid=Mock(return_value=uid), geteuid=Mock(return_value=uid),
                                          getgid=Mock(return_value=uid), getegid=Mock(return_value=uid), create=True))
        stack.enter_context(patch.multiple(M.os, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, O_CLOEXEC=0x40000, create=True))
        raw = json.dumps(binding()).encode()
        request = M.execution_request(env, raw)
        proofs = {str(root / "binding.json"): raw, str(root / "execution-request.json"): json.dumps(request).encode(),
                  str(root / "source-binding.json"): json.dumps({"harnessSource": env["GITHUB_SHA"], "files": dict.fromkeys(M.SOURCES, {})}).encode()}
        stack.enter_context(patch.object(M, "read_file", side_effect=lambda path, *a, **k: proofs[str(path)]))
        for attr, value in (("lstat", lstat), ("stat", named), ("open", opened),
                            ("fstat", lambda fd: copied(fixture.fds[fd][1])), ("fchmod", changed),
                            ("close", lambda fd: fixture.fds.pop(fd))):
            stack.enter_context(patch.object(M.os, attr, value, create=True))
        yield fixture


@contextmanager
def metadata_fixture(*, diversions=None, overrides=None):
    if diversions is None:
        diversions = b"/usr/share/dict/words\n/usr/share/dict/words.pre-dictionaries-common\ndictionaries-common\n"
    if overrides is None:
        overrides = b"root root 4755 /unrelated/bin/tool\n"
    fixture = SimpleNamespace(nodes={}, bodies={}, links={}, fds={}, reads=[], opened=[], counter=100000,
                              on_read=None, on_stat=None, on_link=None, on_open=None)
    def put(path, kind=M.stat.S_IFDIR, mode=0o755, uid=0, gid=0, body=b"", target=None):
        fixture.nodes[path] = SimpleNamespace(st_dev=1, st_ino=len(fixture.nodes) + 1, st_mode=kind | mode,
                                             st_uid=uid, st_gid=gid, st_nlink=2 if kind == M.stat.S_IFDIR else 1,
                                             st_size=len(body), st_mtime_ns=2, st_ctime_ns=3)
        if kind == M.stat.S_IFREG:
            fixture.bodies[path] = body
        if target is not None:
            fixture.links[path] = target
        return fixture.nodes[path]
    fixture.put = put
    for path in ("/", "/var", "/var/lib", "/var/lib/dpkg", "/usr", "/usr/share", "/usr/share/dict",
                 "/unrelated", "/unrelated/bin"):
        put(path, mode=0o777 if path == "/usr/share/dict" else 0o755)
    put("/unrelated/bin/tool", M.stat.S_IFREG, 0o4755)
    for path, body in zip(M.METADATA_DATABASES, (diversions, overrides)):
        if body is not None:
            put(path, M.stat.S_IFREG, 0o644, body=body)
    def path_for(name, parent):
        return str(name) if parent is None else str(M.PurePosixPath(fixture.fds[parent][0]) / name)
    def named(name, *, dir_fd=None, follow_symlinks=False):
        assert not follow_symlinks
        path = path_for(name, dir_fd)
        if fixture.on_stat:
            fixture.on_stat(path)
        if path not in fixture.nodes:
            raise FileNotFoundError(2, "Synthetic absent metadata endpoint", path)
        return copy.copy(fixture.nodes[path])
    def opened(name, flags, *, dir_fd=None):
        path = path_for(name, dir_fd)
        assert flags & M.os.O_NOFOLLOW and flags & M.os.O_CLOEXEC and flags & M.os.O_NONBLOCK
        info = named(name, dir_fd=dir_fd)
        if M.stat.S_ISLNK(info.st_mode) or (flags & M.os.O_DIRECTORY and not M.stat.S_ISDIR(info.st_mode)):
            raise OSError(40, "Synthetic no-follow/type refusal", path)
        assert M.stat.S_ISDIR(info.st_mode) or path in M.METADATA_DATABASES, "No non-database file may be opened"
        fixture.counter += 1
        fd = fixture.counter
        fixture.fds[fd] = [path, fixture.nodes[path], fixture.bodies.get(path), 0]
        fixture.opened.append(path)
        if fixture.on_open:
            fixture.on_open(path)
        return fd
    def read(fd, count):
        path, _, body, offset = fixture.fds[fd]
        assert path in M.METADATA_DATABASES and 0 < count <= 65536
        fixture.reads.append(path)
        if fixture.on_read:
            fixture.on_read(path)
        result = body[offset:offset + count]
        fixture.fds[fd][3] += len(result)
        return result
    def readlink(name, *, dir_fd):
        path = path_for(name, dir_fd)
        result = fixture.links[path]
        if fixture.on_link:
            fixture.on_link(path)
        return result
    with ExitStack() as stack:
        stack.enter_context(patch.multiple(M.os, O_PATH=0x100000, O_DIRECTORY=0x200000, O_NOFOLLOW=0x400000,
                                          O_CLOEXEC=0x800000, O_NONBLOCK=0x1000000, create=True))
        for key, callback in (("open", opened), ("stat", named), ("lstat", named), ("read", read), ("readlink", readlink),
                              ("fstat", lambda fd: copy.copy(fixture.fds[fd][1])), ("close", lambda fd: fixture.fds.pop(fd))):
            stack.enter_context(patch.object(M.os, key, callback))
        for key in ("scandir", "listdir", "walk", "chmod", "fchmod"):
            stack.enter_context(patch.object(M.os, key, side_effect=AssertionError("No scan or permission changes"), create=True))
        stack.enter_context(patch.object(M.subprocess, "run", side_effect=AssertionError("No command execution")))
        stack.enter_context(patch.object(M, "read_file", side_effect=AssertionError("Only fixed database FD reads")))
        yield fixture
        assert not fixture.fds, "Diagnostic leaked an FD"


class MetadataTests(unittest.TestCase):
    def test_all_record_paths_capture_unrelated_unsafe_parents_without_validation_authority(self):
        with metadata_fixture() as f:
            before = {name: M.metadata_stamp(info) for name, info in f.nodes.items()}
            graph = M.helper_metadata()
            self.assertEqual(before, {name: M.metadata_stamp(info) for name, info in f.nodes.items()})
            self.assertEqual(set(f.reads), set(M.METADATA_DATABASES))
            self.assertEqual(set(f.opened) - set(M.METADATA_DATABASES), {"/", "/var", "/var/lib", "/var/lib/dpkg",
                                                                 "/usr", "/usr/share", "/usr/share/dict", "/unrelated", "/unrelated/bin"})
        self.assertTrue(graph["complete"])
        self.assertFalse(graph["validationAuthority"])
        self.assertTrue(graph["readOnly"])
        self.assertEqual(len(graph["records"]), 3)
        self.assertTrue(all(row["complete"] for row in graph["records"]))
        nodes = {row["path"]: row for row in graph["nodes"]}
        self.assertFalse(nodes["/usr/share/dict"]["parentPredicateMatches"])
        self.assertEqual(nodes["/usr/share/dict"]["mode"], 0o777)
        self.assertTrue(nodes["/usr/share/dict/words"]["absentFinal"])
        self.assertNotIn("parentPredicateMatches", nodes["/unrelated/bin/tool"])
        for row in graph["databases"]:
            self.assertEqual(row["sha256"], M.digest(f.bodies[row["path"]]))
        self.assertLess(len(json.dumps(graph).encode()), M.METADATA_GRAPH_BYTES)

    def test_relative_absolute_and_dotdot_aliases_are_explicit_bounded_graph_edges(self):
        with metadata_fixture(diversions=b"/alias/relative/words\n/absolute/other\nfixture\n") as f:
            f.put("/alias", M.stat.S_IFLNK, 0o777, target="usr/share")
            f.put("/usr/share/relative", M.stat.S_IFLNK, 0o777, target="./dict/../dict")
            f.put("/absolute", M.stat.S_IFLNK, 0o777, target="//usr/share/dict")
            graph = M.helper_metadata()
        self.assertTrue(graph["complete"], graph["issues"])
        self.assertEqual([row["resolved"] for row in graph["records"][:2]], ["/usr/share/dict/words", "/usr/share/dict/other"])
        aliases = {row["path"]: row["target"] for row in graph["nodes"] if "alias" in row["roles"]}
        self.assertEqual(aliases, {"/alias": "usr/share", "/usr/share/relative": "./dict/../dict", "/absolute": "//usr/share/dict"})

    def test_unresolved_looping_untrusted_and_changed_aliases_are_incomplete(self):
        for kind in ("missing", "loop", "foreign", "race", "control", "nonutf8"):
            with self.subTest(kind=kind), metadata_fixture(diversions=b"/alias/words\n/usr/share/dict/other\nfixture\n") as f:
                if kind != "missing":
                    f.put("/alias", M.stat.S_IFLNK, 0o777, uid=1 if kind == "foreign" else 0,
                          target={"loop": "alias", "control": "bad\nname", "nonutf8": "bad\udcff"}.get(kind, "/usr/share/dict"))
                if kind == "race":
                    def changed(path):
                        f.nodes[path] = copy.copy(f.nodes[path]); f.nodes[path].st_ino += 1
                    f.on_link = changed
                graph = M.helper_metadata()
                self.assertFalse(graph["complete"])
                self.assertFalse(graph["validationAuthority"])
                self.assertTrue(graph["issues"])
                self.assertFalse(graph["records"][0]["complete"])
                self.assertTrue(graph["records"][1]["complete"])

    def test_missing_fixed_database_is_observed_but_appearance_is_incomplete(self):
        with metadata_fixture() as f:
            del f.nodes[M.METADATA_DATABASES[0]]
            graph = M.helper_metadata()
            self.assertTrue(graph["complete"])
            self.assertTrue(graph["databases"][0]["absent"])
        with metadata_fixture() as f:
            missing = M.METADATA_DATABASES[0]
            original = f.nodes.pop(missing)
            def appeared(path):
                if path == "/unrelated/bin/tool":
                    f.nodes[missing] = original
            f.on_stat = appeared
            graph = M.helper_metadata()
            self.assertFalse(graph["complete"])
            self.assertTrue(any("appeared" in row["reason"] for row in graph["issues"]))

    def test_database_replacement_disappearance_and_namespace_alias_refuse_content_reads(self):
        for kind in ("before", "vanished-on-open", "during", "after", "disappeared", "parent-alias", "oversize", "special"):
            with self.subTest(kind=kind), metadata_fixture() as f:
                source = M.METADATA_DATABASES[0]
                def replace(path):
                    if path == source:
                        f.nodes[path] = copy.copy(f.nodes[path]); f.nodes[path].st_ino += 1
                if kind == "before":
                    f.on_open = replace
                elif kind == "vanished-on-open":
                    f.on_open = lambda path: f.nodes.pop(path, None) if path == source else None
                elif kind == "during":
                    f.on_read = replace
                elif kind == "after":
                    f.on_stat = lambda path: replace(source) if path == "/usr/share/dict" else None
                elif kind == "disappeared":
                    f.on_read = lambda path: f.nodes.pop(path, None) if path == source else None
                elif kind == "parent-alias":
                    f.put("/var/lib/dpkg", M.stat.S_IFLNK, 0o777, target="/elsewhere")
                elif kind == "oversize":
                    f.nodes[source].st_size = M.METADATA_BYTES + 1
                else:
                    f.nodes[source].st_mode = M.stat.S_IFIFO | 0o644
                graph = M.helper_metadata()
                self.assertFalse(graph["complete"])
                self.assertFalse(graph["validationAuthority"])
                self.assertTrue(graph["issues"])
                if kind in ("before", "vanished-on-open", "parent-alias", "oversize", "special"):
                    self.assertNotIn(source, f.reads)

    def test_database_read_growth_and_path_graph_limits_return_bounded_incomplete_receipts(self):
        with metadata_fixture() as f:
            f.nodes[M.METADATA_DATABASES[0]].st_size = 0
            graph = M.helper_metadata()
            self.assertFalse(graph["complete"])
        with metadata_fixture() as f:
            path = M.METADATA_DATABASES[0]
            f.bodies[path] = b"x" * (M.METADATA_BYTES + 1)
            f.nodes[path].st_size = M.METADATA_BYTES
            graph = M.helper_metadata()
            self.assertFalse(graph["complete"])
            self.assertTrue(any("read limit" in row["reason"] for row in graph["issues"]))
        rows = b"".join(f"/different-{i}/a\n/different-{i}/b\nfixture\n".encode() for i in range(40))
        with metadata_fixture(diversions=rows, overrides=b"") as f, patch.object(M, "METADATA_GRAPH_BYTES", 8192):
            for i in range(40):
                f.put("/different-" + str(i))
            graph = M.helper_metadata()
            self.assertFalse(graph["complete"])
            self.assertLessEqual(len(json.dumps(graph, ensure_ascii=False, allow_nan=False).encode()), 8192)
            self.assertTrue(any(row["type"] == "MetadataCaptureLimit" for row in graph["issues"]))

    def test_overlong_alias_and_source_per_record_step_bound_are_incomplete(self):
        for target in ("x" * 4096, "/" + "../" * 1025 + "words"):
            with metadata_fixture(diversions=b"/alias/words\n/usr/share/dict/other\nfixture\n") as f:
                f.put("/alias", M.stat.S_IFLNK, 0o777, target=target)
                graph = M.helper_metadata()
                self.assertFalse(graph["complete"])
                self.assertFalse(graph["records"][0]["complete"])
                self.assertTrue(graph["records"][1]["complete"])

    def test_source_bound_parser_rejects_malformed_truncated_oversize_and_noncanonical_records(self):
        for raw in (b"/a\n/b\nfixture", b"/a\n", b"/a\n/b\nA_BAD_PACKAGE\n", b"/a//b\n/c\nfixture\n",
                    b"/a/../b\n/c\nfixture\n", b"/a\n/b\nfixture\x00\n", b"\xff\n/b\nfixture\n", b"x" * (M.METADATA_BYTES + 1)):
            with self.subTest(raw=raw[:40]), self.assertRaises((RuntimeError, UnicodeError)):
                list(M.metadata_paths(M.METADATA_DATABASES[0], raw))
        for raw in (b"root root 755\n", b"#01 root 755 /x\n", b"#4294967295 root 755 /x\n", b"root root 888 /x\n",
                    b"root root 755 relative\n", b"root root 755 /a\tb\n"):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                list(M.metadata_paths(M.METADATA_DATABASES[1], raw))
        self.assertEqual(list(M.metadata_paths(M.METADATA_DATABASES[1], b"#0 _chrony 0755 /path with spaces\n"))[0]["path"], "/path with spaces")
        with self.assertRaises(RuntimeError):
            list(M.metadata_paths("/etc/other", b""))

    def test_fixed_database_list_and_parser_match_source_fixtures_without_nss_or_execution(self):
        root = HERE.parent / "native/linux-deb-retirement"
        source = (root / "src/linux/metadata.rs").read_text()
        declaration = re.search(r"const DATABASES:.*?= \[(.*?)\];", source).group(1)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', declaration)), M.METADATA_DATABASES)
        parsed = []
        for database, suffix in zip(M.METADATA_DATABASES, ("diversions", "statoverride")):
            raw = (root / "tests/fixtures" / ("38655921324." + suffix)).read_bytes()
            parsed.extend(M.metadata_paths(database, raw))
        self.assertTrue(any(row["path"] == "/usr/share/dict/words" for row in parsed))
        self.assertEqual(len(parsed), 30)


@contextmanager
def permission_capture_fixture(*, statuses=None, starts=("12345", "12345"), failure=None):
    uid = f"Uid:\t{M.UID}\t{M.UID}\t{M.UID}\t{M.UID}\n".encode()
    gid = f"Gid:\t{M.UID}\t{M.UID}\t{M.UID}\t{M.UID}\n".encode()
    fixture = SimpleNamespace(opened=[], reads=[], fds={}, phase=0, helper=M.load("native-unix-window"))
    status = list(statuses or (b"Name:\tDO_NOT_RETAIN\n" + uid + gid,) * 2)
    directory = SimpleNamespace(st_dev=1, st_ino=5152, st_mode=M.stat.S_IFDIR | 0o555, st_uid=M.UID, st_gid=M.UID,
                                st_nlink=9, st_size=0, st_mtime_ns=2, st_ctime_ns=3)
    regular = SimpleNamespace(**{**vars(directory), "st_ino": 600, "st_mode": M.stat.S_IFREG | 0o444, "st_nlink": 1})
    def info(leaf):
        if leaf == "stat" and failure == "symlink":
            return SimpleNamespace(**{**vars(regular), "st_mode": M.stat.S_IFLNK | 0o777})
        if leaf == "stat" and failure == "hardlink":
            return SimpleNamespace(**{**vars(regular), "st_nlink": 2})
        return copy.copy(regular)
    def opened(path, flags, *, dir_fd=None):
        assert flags & M.os.O_NOFOLLOW and flags & M.os.O_CLOEXEC and flags & M.os.O_NONBLOCK
        if dir_fd is None:
            assert path.as_posix() == "/proc/5152" and flags & M.os.O_DIRECTORY
            fd, path = 90, path.as_posix()
        else:
            assert dir_fd == 90 and path in ("stat", "status")
            fd = 100 + len(fixture.opened)
        fixture.opened.append(str(path)); fixture.fds[fd] = str(path)
        return fd
    def named(path, *, dir_fd=None, follow_symlinks=False):
        assert follow_symlinks is False
        assert (dir_fd is None and path.as_posix() == "/proc/5152") or (dir_fd == 90 and path in ("stat", "status"))
        value = copy.copy(directory) if dir_fd is None else info(path)
        if (dir_fd is None and failure == "dir-replaced") or (path == "stat" and failure == "path-replaced" and path in fixture.reads):
            value.st_ino += 1
        return value
    def fstat(fd):
        if fd == 90:
            return copy.copy(directory)
        value = info(fixture.fds[fd])
        if failure == "fd-replaced": value.st_ino += 1
        return value
    def fdopen(fd, mode):
        assert mode == "rb"
        leaf = fixture.fds[fd]
        if leaf == "stat":
            raw = ("5152 (DO_NOT_RETAIN) " + " ".join(["S", "4000", *["0"] * 17, starts[fixture.phase]])).encode()
        else:
            raw = status[fixture.phase]; fixture.phase += 1
            if failure == "oversized": raw += b"x" * 16385
            if failure == "missing-uid": raw = gid
        class Stream(io.BytesIO):
            def fileno(self): return fd
            def read(self, limit=-1):
                assert limit == (4097 if leaf == "stat" else 16385)
                fixture.reads.append(leaf); return super().read(limit)
            def close(self):
                fixture.fds.pop(fd, None); super().close()
        return Stream(raw)
    with ExitStack() as stack:
        stack.enter_context(patch.multiple(M.os, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, O_CLOEXEC=0x40000, O_NONBLOCK=0x80000, create=True))
        for name, value in (("open", opened), ("stat", named), ("lstat", named), ("fstat", fstat), ("fdopen", fdopen),
                            ("close", lambda fd: fixture.fds.pop(fd))):
            stack.enter_context(patch.object(M.os, name, value))
        stack.enter_context(patch.object(M.subprocess, "run", side_effect=AssertionError("No command execution")))
        yield fixture
        assert not fixture.fds, "Permission diagnostic leaked an FD"


@contextmanager
def attribution_fixture():
    fixture = SimpleNamespace(fds={}, opened=[], reads=[], links=[], next_fd=100, failure=None, phase={}, receipts={})
    fixture.helper = M.load("native-unix-window")
    def info(pid, leaf=None):
        value = SimpleNamespace(st_dev=23, st_ino=pid * 10 + {None: 0, "stat": 1, "status": 2, "exe": 3}[leaf],
                                st_mode=(M.stat.S_IFDIR | 0o555) if leaf is None else M.stat.S_IFREG | 0o444,
                                st_uid=M.UID, st_gid=M.UID, st_nlink=9 if leaf is None else 1,
                                st_size=len(image(pid)) if leaf == "exe" else 0, st_mtime_ns=2, st_ctime_ns=3)
        if leaf is None and fixture.failure == "directory-owner": value.st_uid = 0
        if leaf is None and fixture.failure == "directory-inode": value.st_ino += 1
        if leaf == "stat" and fixture.failure == "stat-link": value.st_mode = M.stat.S_IFLNK | 0o777
        return value
    def image(pid):
        return f"SYNTHETIC-ELF-{pid}".encode()
    def identity(pid):
        return {"procDirectory": M.metadata_row(f"/proc/{pid}", info(pid)), "startTime": str(pid * 10),
                "parentPid": 5175 if pid == 5176 else 5000, "Uid": [M.UID] * 4, "Gid": [M.UID] * 4}
    fixture.identity, fixture.image = identity, image
    fixture.capture = {"pid": 5176, "errno": 13, "readOnly": True, "stable": True,
                       "before": identity(5176), "after": identity(5176)}
    fixture.receipts["first"] = {"startupRefused": {"type": "PermissionError"}, "processInventoryRefusal": fixture.capture}
    def identify(path, fd=None):
        if fd is None:
            match = re.fullmatch(r"/proc/(5176|5175)", Path(path).as_posix())
            assert match, f"Unapproved proc path: {path}"
            return int(match[1]), None
        pid, directory = fixture.fds[fd]
        assert directory is None and path in ("stat", "status", "exe")
        return pid, path
    def opened(path, flags, *, dir_fd=None):
        pid, leaf = identify(path, dir_fd)
        assert flags & M.os.O_CLOEXEC and flags & M.os.O_NONBLOCK
        assert not flags & (M.os.O_WRONLY | M.os.O_RDWR | M.os.O_CREAT | M.os.O_TRUNC)
        assert bool(flags & M.os.O_NOFOLLOW) == (leaf != "exe")
        if leaf is None:
            assert flags & M.os.O_DIRECTORY
        if fixture.failure == "gone" and leaf is None: raise ProcessLookupError(3, "synthetic")
        if fixture.failure == "denied" and leaf == "exe": raise PermissionError(13, "synthetic")
        fixture.next_fd += 1; fd = fixture.next_fd
        fixture.fds[fd] = (pid, leaf); fixture.opened.append((pid, leaf))
        return fd
    def named(path, *, dir_fd=None, follow_symlinks=False):
        pid, leaf = identify(path, dir_fd)
        assert follow_symlinks == (leaf == "exe")
        value = info(pid, leaf)
        if fixture.failure == "path-replaced" and leaf == "exe" and (pid, leaf) in fixture.reads: value.st_ino += 1
        return value
    def fstat(fd):
        pid, leaf = fixture.fds[fd]; value = info(pid, leaf)
        if leaf == "exe":
            if fixture.failure == "oversized": value.st_size = 64 * 1024 * 1024 + 1
            if fixture.failure == "special": value.st_mode = M.stat.S_IFIFO | 0o444
            if fixture.failure == "fd-replaced" and (pid, leaf) in fixture.reads: value.st_ino += 1
        return value
    def raw(pid, leaf):
        current = identity(pid)
        phase = fixture.phase.get(pid, 0)
        if fixture.failure == "start" and pid == 5176: current["startTime"] = "99999"
        if fixture.failure == "parent" and pid == 5176: current["parentPid"] = 5001
        if fixture.failure == "parent-reused" and pid == 5175 and phase: current["startTime"] = "99999"
        if fixture.failure == "reparented" and pid == 5176 and phase >= 2: current["parentPid"] = 5001
        if leaf == "stat":
            return (f"{pid} (RAW-COMM-DO-NOT-EXPORT) " + " ".join(["S", str(current["parentPid"]), *["0"] * 17, current["startTime"]])).encode()
        if leaf == "exe": return image(pid)
        fixture.phase[pid] = phase + 1
        ids = {name: [M.UID] * 4 for name in ("Uid", "Gid")}
        if fixture.failure in ("uid", "gid") and pid == 5176: ids[fixture.failure.capitalize()][1] = 0
        result = (f"Name:\tfixture-{pid}\nState:\tS (sleeping)\nPPid:\t{current['parentPid']}\n" +
                  "".join(f"{key}:\t" + "\t".join(map(str, value)) + "\n" for key, value in ids.items()) +
                  "Threads:\t1\nNoNewPrivs:\t0\n" +
                  "".join(key + ":\t0000000000000000\n" for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")) +
                  "Seccomp:\t0\nUNAPPROVED:\tDO-NOT-EXPORT\n").encode()
        if fixture.failure == "status-duplicate": result += b"Name:\tduplicate\n"
        if fixture.failure == "status-oversized": result += b"x" * 16385
        return result
    def fdopen(fd, mode):
        assert mode == "rb"
        pid, leaf = fixture.fds[fd]
        class Stream(io.BytesIO):
            def fileno(self): return fd
            def read(self, limit=-1):
                assert 0 < limit <= 1048576
                fixture.reads.append((pid, leaf)); return super().read(limit)
            def close(self):
                fixture.fds.pop(fd, None); super().close()
        return Stream(raw(pid, leaf))
    def link(path, *, dir_fd):
        pid, leaf = identify(path, dir_fd); assert leaf == "exe"
        fixture.links.append(pid)
        return f"/synthetic/executable-{pid}" + ("-replaced" if fixture.failure == "link-replaced" and (pid, leaf) in fixture.reads else "")
    def receipt(path, limit, **kwargs):
        assert path in (M.BASE / "result/first/session.json", M.BASE / "result/reopened/session.json")
        assert limit == 65536 and kwargs == {"uid": M.UID, "mode": 0o600}
        return json.dumps(fixture.receipts[path.parent.name]).encode()
    with ExitStack() as stack:
        stack.enter_context(patch.multiple(M.os, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, O_CLOEXEC=0x40000,
                                          O_NONBLOCK=0x80000, getuid=lambda: 0, geteuid=lambda: 0, create=True))
        for name, value in (("open", opened), ("stat", named), ("lstat", named), ("fstat", fstat), ("fdopen", fdopen),
                            ("readlink", link), ("close", lambda fd: fixture.fds.pop(fd))):
            stack.enter_context(patch.object(M.os, name, value))
        stack.enter_context(patch.object(M.os.path, "lexists", side_effect=lambda path: Path(path).parent.name in fixture.receipts))
        stack.enter_context(patch.object(M, "read_file", side_effect=receipt))
        stack.enter_context(patch.object(M.subprocess, "run", side_effect=AssertionError("No execution")))
        yield fixture
        assert not fixture.fds, "Root attribution leaked an FD"


class FailedProcessAttributionTests(unittest.TestCase):
    def test_exact_failed_tuple_and_immediate_parent_only_with_held_executable_hashes(self):
        with attribution_fixture() as f:
            result = M.failed_process_attribution(Mock(poll=lambda: 1), f.helper)
            self.assertEqual({pid for pid, _ in f.opened}, {5176, 5175})
            self.assertEqual([pid for pid, leaf in f.opened if leaf == "exe"], [5176, 5175])
        self.assertEqual(result["status"], "captured")
        self.assertTrue(result["stable"]); self.assertTrue(result["readOnly"])
        self.assertFalse(result["validationAuthority"])
        allowed = {"Name", "State", "PPid", "Uid", "Gid", "Threads", "NoNewPrivs", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "Seccomp"}
        for role, pid in (("failed", 5176), ("parent", 5175)):
            row = result[role]
            self.assertEqual(row["before"], f.identity(pid)); self.assertEqual(row["after"], f.identity(pid))
            self.assertEqual(set(row["statusBefore"]), allowed); self.assertEqual(set(row["statusAfter"]), allowed)
            self.assertEqual(row["executable"]["sha256"], M.digest(f.image(pid)))
            self.assertEqual(row["executable"]["path"], f"/synthetic/executable-{pid}")
            self.assertEqual(row["executable"]["before"], row["executable"]["after"])
        output = json.dumps(result)
        for sentinel in ("DO-NOT-EXPORT", "RAW-COMM", "SYNTHETIC-ELF", "Dumpable", "cmdline", "environ"):
            self.assertNotIn(sentinel, output)
        self.assertLess(len(output.encode()), 32768)

    def test_receipt_must_be_unique_stable_and_the_just_failed_child_must_have_exited(self):
        for failure in ("missing", "ambiguous", "unstable", "mixed", "pid", "errno", "float-metadata", "float-after", "extra-metadata", "no-child", "running", "success"):
            with self.subTest(failure=failure), attribution_fixture() as f:
                child = Mock(poll=lambda: 1)
                if failure == "missing": f.receipts.clear()
                if failure == "ambiguous": f.receipts["reopened"] = copy.deepcopy(f.receipts["first"])
                if failure == "unstable": f.capture["after"]["startTime"] = "999"
                if failure == "mixed":
                    for phase in ("before", "after"): f.capture[phase]["Uid"][1] = 0
                if failure == "pid": f.capture["pid"] = True
                if failure == "errno": f.capture["errno"] = 2
                if failure == "float-metadata":
                    for phase in ("before", "after"): f.capture[phase]["procDirectory"]["mode"] = 365.0
                if failure == "float-after": f.capture["after"]["procDirectory"]["ctimeNs"] = 3.0
                if failure == "extra-metadata":
                    for phase in ("before", "after"): f.capture[phase]["procDirectory"]["extra"] = 1
                if failure == "no-child": child = None
                if failure == "running": child.poll = lambda: None
                if failure == "success": child.poll = lambda: 0
                result = M.failed_process_attribution(child, f.helper)
                self.assertEqual(result["status"], "unknown"); self.assertFalse(result["stable"])
                self.assertFalse(f.opened)

    def test_live_tuple_mismatch_blocks_executable_reads(self):
        for failure in ("uid", "gid", "start", "parent", "directory-owner", "directory-inode", "stat-link", "status-duplicate", "status-oversized"):
            with self.subTest(failure=failure), attribution_fixture() as f:
                f.failure = failure
                result = M.failed_process_attribution(Mock(poll=lambda: 1), f.helper)
                self.assertEqual(result["status"], "unknown"); self.assertFalse(result["stable"])
                self.assertFalse(any(leaf == "exe" for _, leaf in f.opened))

    def test_nonroot_broker_cannot_read_receipts_or_proc(self):
        with attribution_fixture() as f, patch.object(M.os, "geteuid", return_value=M.UID), patch.object(M, "read_file") as read:
            result = M.failed_process_attribution(Mock(poll=lambda: 1), f.helper)
            self.assertEqual(result["status"], "unknown"); self.assertFalse(f.opened)
            read.assert_not_called()

    def test_denied_gone_oversize_special_or_replaced_images_remain_unknown_and_close_fds(self):
        for failure in ("denied", "gone", "oversized", "special", "fd-replaced", "path-replaced", "link-replaced", "parent-reused", "reparented"):
            with self.subTest(failure=failure), attribution_fixture() as f:
                f.failure = failure
                result = M.failed_process_attribution(Mock(poll=lambda: 1), f.helper)
                self.assertEqual(result["status"], "unknown"); self.assertFalse(result["stable"])
                if failure == "denied": self.assertEqual(result["failed"]["executable"]["error"]["errno"], 13)
                if failure == "gone": self.assertEqual(result["failed"]["error"]["errno"], 3)
                if failure in ("oversized", "special"): self.assertFalse(any(leaf == "exe" for _, leaf in f.reads))
                if failure == "denied":
                    self.assertEqual(result["failed"]["before"], result["failed"]["after"])
                    self.assertEqual(result["parent"]["before"], result["parent"]["after"])

    def test_root_broker_capture_precedes_cleanup_and_never_replaces_original_failure(self):
        source = ast.parse((HERE / "native-linux-production-016-migration.py").read_text())
        broker = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "broker")
        handler = next(node for node in broker.body if isinstance(node, ast.Try)).handlers[0]
        block = compile(ast.fix_missing_locations(ast.Module(body=handler.body, type_ignores=[])), "broker-except", "exec")
        for diagnostic in ({"status": "unknown"}, RuntimeError("diagnostic-only failure")):
            original = RuntimeError("Synthetic session failed/unknown; no signal or retry requested")
            record = {"scenarioPassed": False, **M.FLAGS}
            callback = Mock(**({"side_effect": diagnostic} if isinstance(diagnostic, Exception) else {"return_value": diagnostic}))
            scope = {"error": original, "record": record, "child": Mock(), "helper": Mock(), "failed_process_attribution": callback}
            exec(block, scope)
            self.assertIs(scope["failure"], original); callback.assert_called_once_with(scope["child"], scope["helper"])
            self.assertEqual(record["refusal"], {"type": "RuntimeError", "message": str(original)})
            self.assertFalse(record["scenarioPassed"]); self.assertTrue(all(record[key] is False for key in M.FLAGS))
            self.assertIn("failedProcessAttribution", record)


@contextmanager
def inventory_rpc_fixture(*, cohort="migration", scenario=None):
    scenario = M.SCENARIOS[0] if scenario is None else scenario
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
        root = Path(temporary).resolve(); (root / "result").mkdir()
        actor = [M.UID]
        fixture = SimpleNamespace(root=root, actor=actor, state={"sequence": 1, "nonces": set()}, record={}, waits=0,
                                  before_service=None, after_service=None, missing=False)
        stack.enter_context(patch.object(M, "BASE", root))
        stack.enter_context(patch.multiple(M.os, getuid=lambda: actor[0], geteuid=lambda: actor[0], create=True))
        stack.enter_context(patch.object(M, "inventory_channel"))
        fixture.inventory = stack.enter_context(patch.object(M, "native_process_inventory", return_value={"processes": [
            {"pid": 12, "startTime": "120", "executable": "/usr/bin/creator-hub", "argvSha256": "a" * 64, "legacyBackend": False}], "terminalProcesses": []}))
        real_read = M.read_file
        def read(file, limit, *, uid, mode):
            is_request = file.parent == root / "result"
            assert file.name.startswith("inventory-request-" if is_request else "inventory-response-")
            assert (uid, mode, limit) == ((M.UID, 0o600, 512) if is_request else (0, 0o644, 524288))
            return real_read(file, limit)
        stack.enter_context(patch.object(M, "read_file", side_effect=read))
        def serve():
            actor[0] = 0
            try:
                return M.serve_inventory(fixture.state, fixture.record, "f" * 40, scenario, Mock(), Mock(), cohort=cohort)
            finally:
                actor[0] = M.UID
        fixture.serve = serve
        def wait(predicate):
            fixture.waits += 1
            if fixture.missing: raise TimeoutError("Missing fresh root inventory response")
            if fixture.before_service: fixture.before_service(fixture)
            serve()
            if fixture.after_service: fixture.after_service(fixture)
            assert predicate(), "Broker did not publish a response"
        fixture.wait = wait
        fixture.client = M.InventoryClient("f" * 40, scenario, cohort=cohort)
        yield fixture


class InventoryRpcTests(unittest.TestCase):
    def test_update_cohort_uses_real_finite_scenarios_without_changing_migration_wire(self):
        self.assertEqual(M.INVENTORY_COHORTS["migration"], M.SCENARIOS)
        self.assertEqual(M.INVENTORY_COHORTS["update"], (
            "deb-native-cancel", "deb-auth-cancel", "deb-approve", "portable-native-cancel", "portable-approve"))
        for scenario in M.INVENTORY_COHORTS["update"]:
            with self.subTest(scenario=scenario), inventory_rpc_fixture(cohort="update", scenario=scenario) as f:
                first = f.client.sample(f.wait); second = f.client.sample(f.wait)
                self.assertEqual(first["request"]["scenario"], scenario)
                self.assertEqual(set(first["request"]), {"schemaVersion", "operation", "harnessSource", "scenario", "sequence", "nonce"})
                self.assertEqual(second["request"]["sequence"], 2)
                self.assertNotEqual(first["request"]["nonce"], second["request"]["nonce"])
        value = {"schemaVersion": 1, "operation": "global-uid-inventory", "harnessSource": "f" * 40,
                 "scenario": M.SCENARIOS[0], "sequence": 1, "nonce": "a" * 64}
        M.inventory_request(value, "f" * 40, M.SCENARIOS[0], 1)

    def test_cohorts_refuse_cross_labels_unknown_overrides_and_default_update_adoption(self):
        for cohort, scenario in (("migration", "deb-approve"), ("update", M.SCENARIOS[0]),
                                 ("other", "deb-approve"), (None, "deb-approve"), ([], "deb-approve"),
                                 ("update", "portable-other")):
            value = {"schemaVersion": 1, "operation": "global-uid-inventory", "harnessSource": "f" * 40,
                     "scenario": scenario, "sequence": 1, "nonce": "a" * 64}
            with self.subTest(cohort=cohort, scenario=scenario), self.assertRaises(RuntimeError):
                M.inventory_request(value, "f" * 40, scenario, 1, cohort=cohort)
        with inventory_rpc_fixture(cohort="update", scenario="deb-approve") as f:
            answer = f.client.sample(f.wait)
            with self.assertRaises(RuntimeError): M.inventory_answer(answer, answer["request"])

    def test_update_channel_keeps_refusal_replay_and_concurrent_sequence_guards(self):
        with inventory_rpc_fixture(cohort="update", scenario="portable-approve") as f:
            with M.concurrent.futures.ThreadPoolExecutor(max_workers=2) as worker:
                answers = list(worker.map(lambda _: f.client.sample(f.wait), range(2)))
            self.assertEqual(sorted(a["request"]["sequence"] for a in answers), [1, 2])
            f.client.nonces.clear()
            with patch.object(M.secrets, "token_hex", return_value=answers[0]["request"]["nonce"]):
                with self.assertRaisesRegex(RuntimeError, "nonce replay"): f.client.sample(f.wait)
            self.assertEqual(f.inventory.call_count, 2)
            with self.assertRaisesRegex(RuntimeError, "cannot be retried"): f.client.sample(f.wait)
        for failure in ("source", "scenario", "nonce", "terminal-overlap", "permission"):
            with self.subTest(failure=failure), inventory_rpc_fixture(cohort="update", scenario="deb-native-cancel") as f:
                if failure == "permission":
                    original = PermissionError(13, "synthetic", "/proc/5519/exe")
                    f.inventory.side_effect = original
                    with patch.object(M, "inventory_permission_capture", return_value={"stable": False}):
                        with self.assertRaises(PermissionError) as raised: f.client.sample(f.wait)
                    self.assertIs(raised.exception, original)
                else:
                    def alter(state):
                        file = state.root / "inventory-response-1.json"; value = json.loads(file.read_bytes())
                        if failure == "source": value["request"]["harnessSource"] = "0" * 40
                        if failure == "scenario": value["request"]["scenario"] = M.SCENARIOS[0]
                        if failure == "nonce": value["request"]["nonce"] = "0" * 64
                        if failure == "terminal-overlap": value["terminalProcesses"] = [{"pid": 12}]
                        file.write_text(json.dumps(value))
                    f.after_service = alter
                    with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                with self.assertRaisesRegex(RuntimeError, "cannot be retried"): f.client.sample(f.wait)

    def test_fresh_global_samples_use_one_monotonic_channel_across_reopened_sessions(self):
        with inventory_rpc_fixture() as f:
            first = f.client.sample(f.wait); reopened = f.client.sample(f.wait)
            self.assertEqual([first["request"]["sequence"], reopened["request"]["sequence"]], [1, 2])
            self.assertNotEqual(first["request"]["nonce"], reopened["request"]["nonce"])
            self.assertEqual(f.inventory.call_count, 2)
            self.assertEqual(f.state["sequence"], 3); self.assertEqual(f.record["inventorySamples"], 2)
            self.assertEqual(f.record["lastInventory"], reopened)
            self.assertFalse(f.serve())
            self.assertEqual(f.inventory.call_count, 2, "Old request files must not replay")
            for answer in (first, reopened):
                self.assertEqual(answer["request"]["operation"], "global-uid-inventory")
                self.assertEqual(answer["request"]["harnessSource"], "f" * 40)
                self.assertEqual(answer["request"]["scenario"], M.SCENARIOS[0])
                self.assertEqual(set(answer), {"request", "ok", "processes", "terminalProcesses"})
            self.assertLess(len(json.dumps(reopened).encode()), 524288)

    def test_unknown_existing_response_missing_response_and_failed_channel_never_allow_input_or_retry(self):
        for failure in ("preseed", "missing", "wrong-nonce", "wrong-source", "wrong-scenario", "old-sequence", "extra", "false-ok"):
            with self.subTest(failure=failure), inventory_rpc_fixture() as f:
                if failure == "preseed": (f.root / "inventory-response-1.json").write_text("{}")
                if failure == "missing": f.missing = True
                def alter(state):
                    file = state.root / "inventory-response-1.json"; value = json.loads(file.read_bytes())
                    if failure == "wrong-nonce": value["request"]["nonce"] = "0" * 64
                    if failure == "wrong-source": value["request"]["harnessSource"] = "0" * 40
                    if failure == "wrong-scenario": value["request"]["scenario"] = M.SCENARIOS[1]
                    if failure == "old-sequence": value["request"]["sequence"] = 0
                    if failure == "extra": value["command"] = "unreviewed"
                    if failure == "false-ok": value["ok"] = False
                    file.write_text(json.dumps(value))
                if failure not in ("preseed", "missing"): f.after_service = alter
                with self.assertRaises((RuntimeError, TimeoutError)): f.client.sample(f.wait)
                calls = f.inventory.call_count
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                self.assertEqual(f.inventory.call_count, calls)

    def test_root_request_admission_rejects_arbitrary_selection_replay_wrong_binding_and_oversize(self):
        mutations = (lambda v: v.update(pid=123), lambda v: v.update(path="/tmp/anything"),
                     lambda v: v.update(command=["anything"]), lambda v: v.update(sequence=True),
                     lambda v: v.update(sequence=2), lambda v: v.update(nonce="x"),
                     lambda v: v.update(harnessSource="0" * 40), lambda v: v.update(scenario=M.SCENARIOS[1]),
                     lambda v: v.update(operation="execute"), lambda v: v.update(nonce="0" * 600))
        for mutate in mutations:
            with self.subTest(mutate=mutate), inventory_rpc_fixture() as f:
                def alter(state):
                    file = state.root / "result/inventory-request-1.json"; value = json.loads(file.read_bytes())
                    mutate(value); file.write_text(json.dumps(value))
                f.before_service = alter
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                f.inventory.assert_not_called()
        with inventory_rpc_fixture() as f:
            f.client.sample(f.wait)
            with patch.object(M.secrets, "token_hex", return_value=next(iter(f.state["nonces"]))):
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
            self.assertEqual(f.inventory.call_count, 1)

    def test_root_inventory_failure_preserves_original_refusal_and_permission_diagnostic(self):
        with inventory_rpc_fixture() as f:
            original = PermissionError(13, "synthetic", "/proc/12/exe")
            f.inventory.side_effect = original
            with patch.object(M, "inventory_permission_capture", return_value={"pid": 12, "stable": True}) as capture:
                with self.assertRaises(PermissionError) as raised: f.client.sample(f.wait)
                self.assertIs(raised.exception, original); capture.assert_called_once()
            self.assertEqual(f.record["inventoryRefusal"]["processInventoryRefusal"], {"pid": 12, "stable": True})
            self.assertFalse((f.root / "inventory-response-1.json").exists())

    def test_concurrent_native_consent_guards_are_serialized_not_exempted(self):
        with inventory_rpc_fixture() as f, M.concurrent.futures.ThreadPoolExecutor(max_workers=2) as worker:
            answers = list(worker.map(lambda _: f.client.sample(f.wait), range(2)))
            self.assertEqual(sorted(value["request"]["sequence"] for value in answers), [1, 2])
            self.assertEqual(f.inventory.call_count, 2)

    def test_both_sides_enforce_nonce_and_sequence_bounds_independently(self):
        with inventory_rpc_fixture() as f:
            value = f.client.sample(f.wait)
            f.client.nonces.clear()  # Prove the root observer does not rely on client replay protection.
            with patch.object(M.secrets, "token_hex", return_value=value["request"]["nonce"]):
                with self.assertRaisesRegex(RuntimeError, "nonce replay"): f.client.sample(f.wait)
            self.assertEqual(f.inventory.call_count, 1)
        with inventory_rpc_fixture() as f:
            f.client.sequence = M.INVENTORY_MAX_SAMPLES + 1
            with self.assertRaises(RuntimeError): f.client.sample(f.wait)
            f.inventory.assert_not_called()

    def test_protected_channel_rejects_redirected_unowned_or_writable_ancestors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); (root / "result").mkdir()
            real_resolve = Path.resolve
            for failure in (None, "owner", "group", "mode", "symlink", "request-owner", "request-mode", "redirected"):
                def info(path):
                    request = path == root / "result"
                    value = SimpleNamespace(st_uid=M.UID if request else 0, st_gid=M.UID if request else 0,
                                            st_mode=M.stat.S_IFDIR | (0o700 if request else 0o755))
                    if path == root:
                        if failure == "owner": value.st_uid = M.UID
                        if failure == "group": value.st_gid = M.UID
                        if failure == "mode": value.st_mode = M.stat.S_IFDIR | 0o775
                        if failure == "symlink": value.st_mode = M.stat.S_IFLNK | 0o777
                    if request:
                        if failure == "request-owner": value.st_uid = 0
                        if failure == "request-mode": value.st_mode = M.stat.S_IFDIR | 0o755
                    return value
                def resolve(path, *args, **kwargs):
                    return root / "unexpected" if path == root and failure == "redirected" else real_resolve(path, *args, **kwargs)
                with self.subTest(failure=failure), patch.object(M, "BASE", root), patch.object(Path, "lstat", info), patch.object(Path, "resolve", resolve):
                    if failure:
                        with self.assertRaises(RuntimeError): M.inventory_channel()
                    else:
                        M.inventory_channel()

    def test_actual_process_guard_samples_fresh_and_rechecks_ownership_after_wait_before_input(self):
        for failure in (None, "missing", "driver", "root", "backend", "stale-response"):
            with self.subTest(failure=failure), inventory_rpc_fixture() as f:
                rows = {pid: {"pid": pid, "startTime": str(pid), "parentPid": pid - 1, "kernelImageSha256": str(pid) * 32} for pid in (11, 12, 13)}
                s = object.__new__(M.Session)
                s.evidence, s.inventory, s.helper = {}, f.client, Mock()
                s.logs = Mock(); s.logs.metadata.return_value = {"stderr": {"truncated": False}}
                s.child = Mock(pid=11); s.child.poll.return_value = None
                s.driver_identity, s.backend, s.owned = [copy.deepcopy(rows[pid]) for pid in (11, 12, 13)]
                s.native = SimpleNamespace(native_process=lambda pid, _: copy.deepcopy(rows[pid]))
                s.pages = SimpleNamespace(listener=lambda *_: True, wait=f.wait)
                action = Mock()
                if failure == "missing": f.missing = True
                if failure in ("driver", "root", "backend"):
                    f.after_service = lambda _: rows[{"driver": 11, "backend": 12, "root": 13}[failure]].update(startTime="replacement")
                if failure == "stale-response":
                    def stale(state):
                        file = state.root / "inventory-response-1.json"
                        answer = json.loads(file.read_bytes()); answer["request"]["nonce"] = "0" * 64
                        file.write_text(json.dumps(answer))
                    f.after_service = stale
                def input_once():
                    s.process_guard(); action()
                if failure:
                    with self.assertRaises((RuntimeError, TimeoutError)): input_once()
                    action.assert_not_called()
                else:
                    input_once(); input_once()
                    self.assertEqual(action.call_count, 2); self.assertEqual(f.inventory.call_count, 2)
                    self.assertEqual(s.evidence["lastInventoryRequest"]["sequence"], 2)

    def test_production_wiring_uses_only_the_broker_loop_and_one_client_for_both_sessions(self):
        source = ast.parse((HERE / "native-linux-production-016-migration.py").read_text())
        functions = {node.name: node for node in source.body if isinstance(node, ast.FunctionDef)}
        callers = {node.name for node in source.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                   and any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "native_process_inventory" for call in ast.walk(node))}
        self.assertEqual(callers, {"serve_inventory"})
        loop = next(node for node in ast.walk(functions["broker"]) if isinstance(node, ast.While))
        served = [i for i, node in enumerate(loop.body) if any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                                                            and call.func.id == "serve_inventory" for call in ast.walk(node))]
        proof = next(i for i, node in enumerate(loop.body) if isinstance(node, ast.If))
        self.assertEqual(len(served), 1); self.assertLess(served[0], proof)
        calls = [node for node in ast.walk(functions["run_session"]) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        self.assertEqual(sum(call.func.id == "InventoryClient" for call in calls), 1)
        sessions = [call for call in calls if call.func.id == "Session"]
        self.assertEqual(len(sessions), 2)
        self.assertEqual([next(value.value.id for value in call.keywords if value.arg == "inventory") for call in sessions], ["inventory", "inventory"])

    def test_root_answer_malformed_records_request_mutation_and_transport_metadata_fail_closed(self):
        for failure in ("extra-record", "pid-duplicate", "too-many", "true-legacy", "changed-request", "response-owner"):
            with self.subTest(failure=failure), inventory_rpc_fixture() as f:
                row = copy.deepcopy(f.inventory.return_value["processes"][0])
                if failure == "extra-record": f.inventory.return_value["processes"] = [{**row, "args": "not-returnable"}]
                if failure == "pid-duplicate": f.inventory.return_value["processes"] = [row, row]
                if failure == "too-many": f.inventory.return_value["processes"] = [{**row, "pid": i + 1} for i in range(65)]
                if failure == "true-legacy": f.inventory.return_value["processes"] = [{**row, "legacyBackend": True}]
                if failure == "changed-request":
                    def change(*_):
                        file = f.root / "result/inventory-request-1.json"
                        value = json.loads(file.read_bytes()); value["nonce"] = "0" * 64
                        file.write_text(json.dumps(value)); return {"processes": [row], "terminalProcesses": []}
                    f.inventory.side_effect = change
                if failure == "response-owner":
                    original = M.read_file
                    def read(file, *args, **kwargs):
                        if file.parent == f.root: raise RuntimeError("Bounded ordinary input metadata differs")
                        return original(file, *args, **kwargs)
                    with patch.object(M, "read_file", side_effect=read), self.assertRaises(RuntimeError): f.client.sample(f.wait)
                else:
                    with self.assertRaises(RuntimeError): f.client.sample(f.wait)


@contextmanager
def global_inventory_fixture(rows, changed=None, *, observations=None, native_error=None, denied=False):
    original, real_path = M.native_process_inventory, M.Path
    real_os = {name: getattr(M.os, name) for name in ("open", "stat", "fstat", "fdopen", "close")}
    calls, fds, phases, reads = [], {}, {}, []
    helper = M.load("native-unix-window")
    observations = observations or {}
    def current(pid):
        values = observations.get(pid, [{}])
        return {"state": "S", "startTime": str(pid), "parentPid": 1, "uid": M.UID, "gid": M.UID,
                "inode": pid, **values[min(phases.get(pid, 0), len(values) - 1)]}
    def info(pid, leaf=None):
        value = current(pid)
        return SimpleNamespace(st_dev=23, st_ino=value["inode"] if leaf is None else pid + 10000,
                               st_mode=(M.stat.S_IFDIR | 0o555) if leaf is None else (M.stat.S_IFREG | 0o444),
                               st_uid=value["uid"], st_gid=value["gid"], st_nlink=9 if leaf is None else 1,
                               st_size=0, st_mtime_ns=2, st_ctime_ns=3)
    class Candidate:
        def __init__(self, pid): self.name = str(pid)
        def stat(self): return SimpleNamespace(st_uid=M.UID)
        def lstat(self): return info(int(self.name))
        def as_posix(self): return f"/proc/{self.name}"
        def __truediv__(self, leaf):
            assert leaf == "cmdline"
            return Path(f"/proc/{self.name}/cmdline")
    def path(value):
        return SimpleNamespace(iterdir=lambda: [Candidate(pid) for pid in rows]) if value == "/proc" else real_path(value)
    def process(pid, helper, full):
        assert full is False
        if M.os.getuid() != 0: raise PermissionError(13, "synthetic", f"/proc/{pid}/exe")
        calls.append(pid)
        if native_error is not None: raise native_error
        if current(pid)["state"] in ("Z", "X"): raise RuntimeError("Owned process is not live")
        row = rows[pid]
        value = {"pid": pid, "parentPid": 1, "uids": current(pid).get("uids", [M.UID] * 4), "startTime": str(pid), "executable": row[0]}
        if changed and calls.count(pid) > 1: value.update(changed)
        return value
    def command(file, limit):
        assert limit == 8192 and file.name == "cmdline"
        reads.append((int(file.parent.name), "cmdline"))
        return rows[int(file.parent.name)][1]
    def opened(file, flags, *args, dir_fd=None):
        if not isinstance(file, Candidate) and dir_fd not in fds:
            return real_os["open"](file, flags, *args, **({"dir_fd": dir_fd} if dir_fd is not None else {}))
        assert flags & M.os.O_NOFOLLOW and flags & M.os.O_CLOEXEC and flags & M.os.O_NONBLOCK
        if dir_fd is None:
            assert isinstance(file, Candidate) and flags & M.os.O_DIRECTORY
            pid, leaf = int(file.name), None
        else:
            pid, leaf = fds[dir_fd][0], file
            assert leaf in ("stat", "status")
        if denied: raise PermissionError(13, "synthetic", f"/proc/{pid}/stat")
        fd = 10000 + max([0, *fds]); fds[fd] = (pid, leaf)
        return fd
    def named(file, *args, dir_fd=None, follow_symlinks=True):
        if dir_fd not in fds:
            return real_os["stat"](file, *args, **({"dir_fd": dir_fd} if dir_fd is not None else {}), follow_symlinks=follow_symlinks)
        assert not follow_symlinks and file in ("stat", "status")
        return info(fds[dir_fd][0], file)
    def fdopen(fd, mode):
        if fd not in fds: return real_os["fdopen"](fd, mode)
        pid, leaf = fds[fd]; value = current(pid)
        if leaf == "stat":
            raw = (f"{value.get('statPid', pid)} (DO-NOT-EXPORT) " + " ".join([value["state"], str(value["parentPid"]), *["0"] * 17, value["startTime"]])).encode()
            if value.get("malformed"): raw = b"invalid stat"
        else:
            raw = ("Uid:\t" + "\t".join(map(str, value.get("uids", [value["uid"]] * 4))) +
                   "\nGid:\t" + "\t".join(map(str, value.get("gids", [value["gid"]] * 4))) + "\n").encode()
            phases[pid] = phases.get(pid, 0) + 1
        class Stream(io.BytesIO):
            def fileno(self): return fd
            def read(self, limit=-1):
                reads.append((pid, leaf)); return super().read(limit)
            def close(self):
                fds.pop(fd, None); super().close()
        return Stream(raw)
    with ExitStack() as stack:
        stack.enter_context(patch.object(M, "Path", side_effect=path))
        stack.enter_context(patch.object(M, "proc_bytes", side_effect=command))
        stack.enter_context(patch.multiple(M.os, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, O_CLOEXEC=0x40000, O_NONBLOCK=0x80000, create=True))
        for name, value in (("open", opened), ("stat", named), ("fstat", lambda fd: info(*fds[fd]) if fd in fds else real_os["fstat"](fd)),
                            ("fdopen", fdopen), ("close", lambda fd: fds.pop(fd) if fd in fds else real_os["close"](fd))):
            stack.enter_context(patch.object(M.os, name, value))
        native = SimpleNamespace(native_process=process)
        yield SimpleNamespace(sample=lambda: original(native, helper), calls=calls, reads=reads)
        assert not fds, "Global inventory leaked a proc FD"


class RootGlobalInventoryTests(unittest.TestCase):
    def test_ordinary_uid_with_mixed_groups_or_other_proc_gid_still_gets_full_live_inspection(self):
        for groups in ({"gids": [M.UID, 0, 0, 0]}, {"gid": 0}):
            with self.subTest(groups=groups), global_inventory_fixture({7000: (M.OLD_NODE, b"node\0server.mjs\0")},
                    observations={7000: [groups]}) as g, inventory_rpc_fixture() as f, \
                    patch.object(M, "no_legacy_backend", wraps=M.no_legacy_backend) as check:
                f.inventory.side_effect = lambda *_: g.sample()
                answer = f.client.sample(f.wait)
                self.assertEqual([row["pid"] for row in answer["processes"]], [7000])
                self.assertEqual(answer["terminalProcesses"], [])
                self.assertEqual(g.calls, [7000, 7000])
                self.assertEqual(g.reads.count((7000, "cmdline")), 1)
                check.assert_called_once()

    def test_live_legacy_with_varied_groups_is_never_excluded_or_accepted(self):
        for groups in ({"gids": [M.UID, 0, 0, 0]}, {"gid": 0}):
            for image, command in (("/usr/bin/creator-project-setup", b"setup\0"),
                                   ("/usr/bin/creator-works-mcp-launcher", b"mcp\0"),
                                   (M.OLD_NODE, b"node\0--creator-hub-host\0")):
                with self.subTest(groups=groups, image=image), global_inventory_fixture({7000: (image, command)},
                        observations={7000: [groups]}) as g, inventory_rpc_fixture() as f:
                    f.inventory.side_effect = lambda *_: g.sample()
                    with self.assertRaisesRegex(RuntimeError, "separate MCP/Setup GUI or legacy host backend"): f.client.sample(f.wait)
                    self.assertIn((7000, "cmdline"), g.reads)
                    self.assertFalse((f.root / "inventory-response-1.json").exists())

    def test_live_group_transitions_still_refuse_the_inventory(self):
        for groups in ({"gids": [M.UID, 0, 0, 0]}, {"gid": 0}):
            with self.subTest(groups=groups), global_inventory_fixture({7000: (M.OLD_NODE, b"node\0")},
                    observations={7000: [{}, groups]}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                self.assertFalse((f.root / "inventory-response-1.json").exists())

    def test_existing_stable_live_mixed_uid_case_is_kept_out_of_active_and_terminal_lists(self):
        mixed = [M.UID, 0, 0, 0]
        for groups in ({}, {"gids": mixed}, {"gid": 0}):
            with self.subTest(groups=groups), global_inventory_fixture({7000: ("/usr/bin/pkexec", b"not-read\0")},
                    observations={7000: [{"uids": mixed, **groups}]}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                answer = f.client.sample(f.wait)
                self.assertEqual(answer["processes"], []); self.assertEqual(answer["terminalProcesses"], [])
                self.assertEqual(g.calls, [7000, 7000])
                self.assertFalse(any(leaf == "cmdline" for _, leaf in g.reads))

    def test_mixed_uid_restoration_does_not_allow_credential_transitions_or_changed_identity(self):
        mixed, ordinary = [M.UID, 0, 0, 0], [M.UID] * 4
        cases = ([{"uids": ordinary}, {"uids": mixed}], [{"uids": mixed}, {"uids": ordinary}],
                 [{"uids": mixed}, {"uids": mixed, "startTime": "999"}],
                 [{"uids": mixed}, {"uids": mixed, "inode": 999}],
                 [{"uids": mixed}, {"uids": mixed, "gids": mixed}],
                 [{"uids": mixed}, {"uids": mixed, "state": "Z"}])
        for values in cases:
            with self.subTest(values=values), global_inventory_fixture({7000: ("/usr/bin/pkexec", b"not-read\0")},
                    observations={7000: values}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                self.assertFalse((f.root / "inventory-response-1.json").exists())

    def test_mixed_uid_or_gid_terminal_processes_still_cannot_form_terminal_proof(self):
        for state in ("Z", "X"):
            for credentials in ({"uids": [M.UID, 0, 0, 0]}, {"gids": [M.UID, 0, 0, 0]}, {"uids": [M.UID, 0, 0, 0], "gid": 0}):
                with self.subTest(state=state, credentials=credentials), global_inventory_fixture({7000: ("/unknown", b"")},
                        observations={7000: [{"state": state, **credentials}]}) as g, inventory_rpc_fixture() as f:
                    f.inventory.side_effect = lambda *_: g.sample()
                    with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                    self.assertFalse((f.root / "inventory-response-1.json").exists())

    def test_stable_terminal_states_are_separate_evidence_not_active_or_legacy_free(self):
        for state in ("Z", "X"):
            with self.subTest(state=state), global_inventory_fixture({7000: ("/unknown-terminal-image", b"")},
                    observations={7000: [{"state": state}, {"state": state}]}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                answer = f.client.sample(f.wait)
                self.assertEqual(answer["processes"], [])
                terminal = answer["terminalProcesses"][0]
                self.assertEqual(terminal["classification"], "terminal")
                self.assertEqual(terminal["before"], terminal["after"])
                self.assertEqual(terminal["before"]["state"], state)
                self.assertNotIn("legacyBackend", json.dumps(terminal)); self.assertFalse(g.calls)
                self.assertFalse(any(leaf == "cmdline" for _, leaf in g.reads))

    def test_exact_liveness_refusal_requires_two_terminal_observations_of_the_bound_origin(self):
        observations = {7000: [{"state": "S"}, {"state": "Z"}, {"state": "Z"}]}
        with global_inventory_fixture({7000: (M.OLD_NODE, b"node\0")}, observations=observations) as g, inventory_rpc_fixture() as f:
            f.inventory.side_effect = lambda *_: g.sample()
            answer = f.client.sample(f.wait)
            self.assertEqual(answer["processes"], [])
            terminal = answer["terminalProcesses"][0]
            self.assertEqual(terminal["origin"]["state"], "S")
            self.assertEqual(terminal["before"]["state"], "Z"); self.assertEqual(terminal["before"], terminal["after"])
            self.assertEqual(g.calls, [7000])

    def test_terminal_to_live_reused_malformed_changed_credentials_and_denied_are_not_exclusions(self):
        failures = ([{"state": "Z"}, {"state": "S"}], [{"state": "S"}, {"state": "Z", "startTime": "999"}],
                    [{"state": "Z"}, {"state": "Z", "inode": 999}], [{"state": "Z"}, {"state": "Z", "uid": 0}],
                    [{"state": "Z"}, {"state": "Z", "gid": 0}], [{"state": "Z", "statPid": 999}],
                    [{"state": "Z", "malformed": True}], [{"state": "?"}])
        for values in failures:
            with self.subTest(values=values), global_inventory_fixture({7000: (M.OLD_NODE, b"node\0")}, observations={7000: values}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                self.assertFalse((f.root / "inventory-response-1.json").exists())
        with global_inventory_fixture({7000: (M.OLD_NODE, b"node\0")}, denied=True) as g, inventory_rpc_fixture() as f:
            f.inventory.side_effect = lambda *_: g.sample()
            with patch.object(M, "inventory_permission_capture", return_value={"stable": False}), self.assertRaises(PermissionError): f.client.sample(f.wait)

    def test_unrelated_runtime_error_or_exact_liveness_error_while_live_still_fails(self):
        for error, values in ((RuntimeError("Unrelated native failure"), [{"state": "S"}, {"state": "Z"}]),
                              (RuntimeError("Owned process is not live"), [{"state": "S"}])):
            with self.subTest(error=error), global_inventory_fixture({7000: (M.OLD_NODE, b"node\0")},
                    observations={7000: values}, native_error=error) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                self.assertFalse((f.root / "inventory-response-1.json").exists())

    def test_normal_process_gone_still_uses_original_handling(self):
        for error in (FileNotFoundError("gone"), ProcessLookupError("gone")):
            with global_inventory_fixture({7000: (M.OLD_NODE, b"node\0")}, native_error=error) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                answer = f.client.sample(f.wait)
                self.assertEqual(answer["processes"], []); self.assertEqual(answer["terminalProcesses"], [])

    def test_terminal_wire_evidence_refuses_live_states_changed_identity_extra_claims_overlap_and_total_overflow(self):
        with global_inventory_fixture({7000: (M.OLD_NODE, b"")}, observations={7000: [{"state": "Z"}]}) as g, inventory_rpc_fixture() as f:
            f.inventory.side_effect = lambda *_: g.sample()
            original = f.client.sample(f.wait)
        for failure in ("live", "start", "inode", "uid", "extra", "overlap", "count"):
            answer = copy.deepcopy(original); terminal = answer["terminalProcesses"][0]
            if failure == "live":
                terminal["before"]["state"] = terminal["after"]["state"] = "S"
            if failure == "start": terminal["after"]["startTime"] = "reused"
            if failure == "inode": terminal["origin"]["procDirectory"]["ino"] += 1
            if failure == "uid": terminal["after"]["Uid"][0] = 0
            if failure == "extra": terminal["legacyBackend"] = False
            if failure in ("overlap", "count"):
                answer["processes"] = [{"pid": pid, "startTime": "1", "executable": M.OLD_NODE,
                                        "argvSha256": "a" * 64, "legacyBackend": False}
                                       for pid in ([7000] if failure == "overlap" else range(1, 65))]
            with self.subTest(failure=failure), self.assertRaises(RuntimeError): M.inventory_answer(answer, answer["request"])

    def test_terminal_inventory_never_relaxes_owned_hub_driver_or_backend_liveness(self):
        for target in (11, 12, 13):
            with self.subTest(target=target), global_inventory_fixture({target: (M.OLD_NODE, b"")},
                    observations={target: [{"state": "Z"}]}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                rows = {pid: {"pid": pid, "startTime": str(pid), "parentPid": pid - 1} for pid in (11, 12, 13)}
                stopped = [False]
                s = object.__new__(M.Session); s.evidence, s.inventory, s.helper = {}, f.client, Mock()
                s.logs = Mock(); s.logs.metadata.return_value = {"stderr": {"truncated": False}}
                s.child = Mock(pid=11); s.child.poll.return_value = None
                s.driver_identity, s.backend, s.owned = [copy.deepcopy(rows[pid]) for pid in (11, 12, 13)]
                def process(pid, _):
                    if stopped[0] and pid == target: raise RuntimeError("Owned process is not live")
                    return copy.deepcopy(rows[pid])
                s.native = SimpleNamespace(native_process=process)
                s.pages = SimpleNamespace(listener=lambda *_: True, wait=f.wait)
                f.after_service = lambda _: stopped.__setitem__(0, True)
                action = Mock()
                with self.assertRaisesRegex(RuntimeError, "Owned process is not live"):
                    s.process_guard(); action()
                action.assert_not_called()
                self.assertEqual(f.record["lastInventory"]["terminalProcesses"][0]["pid"], target)

    def test_permission_protected_non_legacy_process_is_freshly_inspected_by_root_not_skipped(self):
        rows = {5075: ("/usr/lib/systemd/systemd", b"synthetic-system-process\0"), 6000: (M.OLD_NODE, b"node\0server.mjs\0")}
        with global_inventory_fixture(rows) as g, inventory_rpc_fixture() as f:
            f.inventory.side_effect = lambda *_: g.sample()
            first, second = f.client.sample(f.wait), f.client.sample(f.wait)
            self.assertEqual([row["pid"] for row in first["processes"]], [5075, 6000])
            self.assertEqual(g.calls.count(5075), 4); self.assertEqual(g.calls.count(6000), 4)
            self.assertNotEqual(first["request"]["nonce"], second["request"]["nonce"])

    def test_out_of_tree_legacy_gui_or_host_backend_and_same_pid_changes_never_get_an_answer(self):
        for image, command, changed in (("/usr/bin/creator-project-setup", b"setup\0", None),
                                        ("/usr/bin/creator-works-mcp-launcher", b"mcp\0", None),
                                        (M.OLD_NODE, b"node\0--creator-hub-host\0", None),
                                        ("/usr/bin/creator-hub", b"hub\0", {"startTime": "reused"}),
                                        ("/usr/bin/creator-hub", b"hub\0", {"executable": "/changed-executable"})):
            with self.subTest(image=image, changed=changed), global_inventory_fixture({7000: (image, command)}, changed) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                self.assertFalse((f.root / "inventory-response-1.json").exists())
                self.assertEqual(f.record["inventoryRefusal"]["sequence"], 1)

    def test_existing_global_uid_64_process_limit_is_retained(self):
        for count in (64, 65):
            rows = {pid: (M.OLD_NODE, b"node\0server.mjs\0") for pid in range(1, count + 1)}
            with self.subTest(count=count), global_inventory_fixture(rows) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                if count == 65:
                    with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                    self.assertFalse((f.root / "inventory-response-1.json").exists())
                else:
                    self.assertEqual(len(f.client.sample(f.wait)["processes"]), 64)
        for count in (64, 65):
            rows = {pid: (M.OLD_NODE, b"node\0server.mjs\0") for pid in range(1, count + 1)}
            with self.subTest(mixed=count), global_inventory_fixture(rows, observations={count: [{"state": "Z"}]}) as g, inventory_rpc_fixture() as f:
                f.inventory.side_effect = lambda *_: g.sample()
                if count == 65:
                    with self.assertRaises(RuntimeError): f.client.sample(f.wait)
                else:
                    answer = f.client.sample(f.wait)
                    self.assertEqual(len(answer["processes"]), 63); self.assertEqual(len(answer["terminalProcesses"]), 1)


def captured_connection_review_graph(question):
    # Redacted topology from native 39447694176: title and secondary text share node 4.
    fields = [(None, 2, "Warning"), (0, 20, ""), (1, 20, ""), (2, 26, "Warning"), (2, 20, ""),
              (4, 29, "Review unverified MCP connections"), (4, 29, question), (1, 20, ""), (7, 20, ""),
              (8, 43, "Move reviewed connections"), (8, 43, "Keep existing")]
    return [{"reference": [":1.2", str(i)], "parent": [":1.2", "app" if parent is None else str(parent)],
             "pid": 123, "role": role, "name": name, "ready": True} for i, (parent, role, name) in enumerate(fields)]


class ConnectionReviewHeadingTests(unittest.TestCase):
    def test_captured_native_graph_exact_829_byte_question_and_primary_heading_are_accepted(self):
        home = "/opt/creator-polkit-fixture/result/home"
        router = home + "/data/creator-hub/mcp-route-v1/linux-x86_64/router-v1/creator-hub-mcp-router"
        details = [f"{client}\nCommand: {M.OLD_NODE}\nServer: {M.OLD_SERVER}\nProject kept: {home}/current-project"
                   for client in ("Codex", "Claude Code")]
        question = ("These existing connections could not be publisher-verified:\n\n" + "\n\n".join(details)
                    + f"\n\nMove them to the verified Hub router at {router}? Names and ownership markers are not proof. Continue only for your Creator Works connections. Exact backups, client options and other servers are kept. Cancel stops migration before changing any of these clients.")
        self.assertEqual(len(question.encode()), 829)
        self.assertEqual(M.digest(question.encode()), "2fea05922d3e65117e9ac66776ea14ef556276f7a91b18b20be702b22f233192")
        graph = captured_connection_review_graph(question)
        record = {}
        M.connection_review_graph_contract(graph, pid=123, question=question, record=record)
        self.assertEqual(record, {})

    def test_missing_changed_unknown_or_duplicate_primary_and_secondary_labels_refuse(self):
        graph = captured_connection_review_graph("exact question")
        for mutate in (lambda g: g[5].update(name="Changed heading"), lambda g: g.pop(5),
                       lambda g: g[6].update(name="Changed question"), lambda g: g.pop(6),
                       lambda g: g.append({**g[5], "reference": [":1.2", "extra"]}),
                       lambda g: g.append({**g[6], "reference": [":1.2", "extra"]}),
                       lambda g: g.append({**g[6], "reference": [":1.2", "extra"], "name": "Unknown text"}),
                       lambda g: (g[5].update(name="exact question"), g[6].update(name=M.CONNECTION_REVIEW_TITLE))):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.subTest(graph=bad), self.assertRaises(RuntimeError):
                M.graph_contract(bad, pid=123, title="Warning", question="exact question", connection_review=True)

    def test_parent_divergence_missing_parent_or_non_container_shared_parent_refuses(self):
        graph = captured_connection_review_graph("exact question")
        for mutate in (lambda g: g[6].update(parent=[":1.2", "8"]), lambda g: g[5].update(parent=[":1.2", "8"]),
                       lambda g: g[6].update(parent=[":1.2", "missing"]),
                       lambda g: (g[5].update(parent=[":1.2", "0"]), g[6].update(parent=[":1.2", "0"])),
                       lambda g: g[4].update(role=21)):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.subTest(graph=bad), self.assertRaises(RuntimeError):
                M.graph_contract(bad, pid=123, title="Warning", question="exact question", connection_review=True)

    def test_connection_ownership_buttons_references_and_readiness_checks_are_unchanged(self):
        graph = captured_connection_review_graph("exact question")
        for mutate in (lambda g: g[6].update(pid=999), lambda g: g[9].update(name="Other action"),
                       lambda g: g[10].update(reference=g[9]["reference"]), lambda g: g[5].update(ready=False),
                       lambda g: g[0].update(name="Information")):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.subTest(graph=bad), self.assertRaises(RuntimeError):
                M.graph_contract(bad, pid=123, title="Warning", question="exact question", connection_review=True)

    def test_password_and_generic_dialogs_do_not_require_connection_review_labels(self):
        for password in (False, True):
            values = [(2, "Information"), (29, "other question")]
            if password: values += [(40, None)]
            values += [(43, "Cancel" if password else "Move to Hub"), (43, "Authenticate" if password else "Not now")]
            graph = [{"reference": [":1.2", str(i)], "parent": [":1.2", "app" if i == 0 else "0"], "pid": 123,
                      "role": role, "name": name, "ready": True} for i, (role, name) in enumerate(values)]
            M.graph_contract(graph, pid=123, title="Information", question="other question", password=password)


class ConnectionDismissalDiagnosticsTests(unittest.TestCase):
    @contextmanager
    def fixture(self, mode="non-target"):
        common = M.load("native-linux-polkit-probe.test")
        options = {"mode": "absent", "changes": {"resourceid": 8388999}} if mode == "non-target" else {"mode": mode}
        x11, helper = common.NativeDismissalTests().fixture(**options)
        polkit = M.load("native-linux-polkit-probe")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(M.Session, "start"):
                session = M.Session(root, binding())
            session.helper, session.polkit, session.x11 = helper, polkit, x11
            session.pages = SimpleNamespace(wait=M.load("native-linux-integrated-pages").wait)
            session.owned = {"pid": 321, "parentPid": 320, "startTime": "123", "uids": [M.UID] * 4,
                             "executable": M.HUB, "kernelImageSha256": "b" * 64}
            session.window, session.xres = 40, {"pid": 321, "client": 80, "title": M.TITLE, "mapped": True}
            session.request = object()
            session.process_guard = Mock()
            helper.bound_window = Mock(return_value=session.xres)
            dialog = {"pid": 321, "client": 80, "title": M.CONNECTION_REVIEW_TITLE, "mapped": True}
            record = session.evidence["connectionReview"] = {"actionAttempts": 1, "actionReturned": True}
            yield SimpleNamespace(session=session, root=root, record=record, dialog=dialog)

    def invoke_actual_caller_tail(self, f):
        tree = ast.parse(Path(M.__file__).read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Session")
        method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "review_connections")
        body = next(n.body for n in method.body if isinstance(n, ast.Try))
        index = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == "dismissal" for t in n.targets))
        function = ast.FunctionDef(name="actual_tail", args=ast.arguments(posonlyargs=[],
            args=[ast.arg(arg=n) for n in ("self", "record", "window", "xres", "frame")], kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=copy.deepcopy(body[index:]), decorator_list=[])
        namespace = dict(vars(M))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "actual-dismissal-caller", "exec"), namespace)
        namespace["actual_tail"](f.session, f.record, 77, f.dialog, (10, 20, 30, 40))

    def test_non_target_native_error_still_refuses_and_retains_scoped_query_and_latch(self):
        with self.fixture() as f:
            real = f.session.polkit.native_window_absence
            def observed(*args):
                self.assertIs(f.record["nativeDismissal"], args[-1])
                return real(*args)
            with patch.object(f.session.polkit, "native_window_absence", side_effect=observed), \
                    self.assertRaises(RuntimeError):
                self.invoke_actual_caller_tail(f)
            self.assertEqual(f.record["nativeDismissal"], {"source": "exact-target-XQueryTree", "root": 1,
                "target": 77, "complete": False, "lastQuery": 77, "requestSerial": 501})
            capture = f.record["nativeDismissalFailure"]
            event = capture["xError"]["events"][0]
            self.assertEqual({k: event[k] for k in ("errorCode", "requestCode", "minorCode", "serial", "resourceId", "sameDisplay")},
                             {"errorCode": 3, "requestCode": 15, "minorCode": 0, "serial": 501, "resourceId": 8388999, "sameDisplay": True})
            self.assertEqual(capture["root"], f.session.owned)
            self.assertEqual(capture["mainWindow"], {"xid": 40, "xres": f.session.xres})
            self.assertEqual(capture["dialog"], {"xid": 77, "xres": f.dialog, "frame": [10, 20, 30, 40]})
            self.assertEqual(capture["serialSource"], "XErrorEvent.serial; compare independently sampled nativeDismissal.requestSerial when present")
            self.assertTrue(capture["cachedBindingsOnly"]); self.assertTrue(f.session.x11.error)
            for key in ("inputPermitted", "authorityGranted", "releaseReady"): self.assertIs(capture[key], False)
            f.session.x11.x.XNextRequest.assert_called_once_with(11)
            value = json.loads((f.root / "session.json").read_bytes())
            self.assertEqual(value["firstFailure"]["message"], "Owned X resource query was refused")
            self.assertEqual(value["connectionReview"], f.record)
            self.assertNotIn("absent", f.record["nativeDismissal"])

    def test_main_root_process_or_window_change_never_returns_absence(self):
        for where in ("process-before", "process-after", "window-before", "window-after"):
            with self.subTest(where=where), self.fixture("absent") as f:
                if where.startswith("process"):
                    f.session.process_guard.side_effect = ([RuntimeError("Root changed")] if where.endswith("before")
                                                          else [None, RuntimeError("Root changed")])
                else:
                    f.session.helper.bound_window.side_effect = ([{}] if where.endswith("before") else [f.session.xres, {}])
                with self.assertRaises(RuntimeError): self.invoke_actual_caller_tail(f)
                self.assertIn("firstFailure", f.session.evidence)
                if where.endswith("before"): f.session.x11.x.XQueryTree.assert_not_called()
                else:
                    self.assertTrue(f.record["nativeDismissal"]["absent"])
                    self.assertTrue(f.record["nativeDismissal"]["complete"])

    def test_capture_failure_does_not_mask_original_refusal_or_add_queries(self):
        with self.fixture() as f:
            clean = f.session.x11.error_diagnostic()
            with patch.object(f.session.x11, "error_diagnostic", side_effect=[clean,
                    ValueError("PRIVATE CAPTURE ERROR"), ValueError("PRIVATE CAPTURE ERROR")]), \
                    patch.object(f.session, "retain_dismissal_refusal", wraps=f.session.retain_dismissal_refusal) as retain, \
                    self.assertRaises(RuntimeError) as raised:
                self.invoke_actual_caller_tail(f)
            self.assertIs(raised.exception, retain.call_args.args[0])
            self.assertEqual(f.session.x11.x.XQueryTree.call_count, 1)
            capture = f.record["nativeDismissalFailure"]
            self.assertEqual(capture["xError"], {"captureUnavailable": True, "type": "ValueError"})
            self.assertNotIn("PRIVATE", json.dumps(capture))

    def test_cached_capture_is_detached_and_oversized_metadata_cannot_mask_refusal(self):
        for oversized in (False, True):
            with self.subTest(oversized=oversized), self.fixture() as f:
                if oversized: f.session.xres["title"] = "PRIVATE" * 2000
                with self.assertRaises(RuntimeError):
                    self.invoke_actual_caller_tail(f)
                capture = f.record["nativeDismissalFailure"]
                self.assertLessEqual(len(json.dumps(capture).encode()), 8192)
                if oversized:
                    self.assertTrue(capture["captureUnavailable"])
                    self.assertNotIn("PRIVATE", json.dumps(capture))
                else:
                    f.session.owned["uids"][0] = 0
                    f.session.x11.error_events[0]["serial"] = 999
                    self.assertEqual(capture["root"]["uids"], [M.UID] * 4)
                    self.assertEqual(capture["xError"]["events"][0]["serial"], 501)
                self.assertEqual(f.session.evidence["firstFailure"]["message"], "Owned X resource query was refused")

    def test_exact_target_absence_has_before_after_main_continuity_and_no_failure_capture(self):
        with self.fixture("absent") as f:
            self.invoke_actual_caller_tail(f)
            self.assertEqual(f.session.x11.x.XQueryTree.call_count, 1)
            self.assertEqual(f.session.process_guard.call_count, 2)
            self.assertEqual(f.session.helper.bound_window.call_count, 2)
            self.assertTrue(f.record["nativeDismissal"]["absent"])
            self.assertTrue(f.record["nativeDismissal"]["complete"])
            self.assertNotIn("nativeDismissalFailure", f.record)


class ConnectionReviewGraphCaptureTests(unittest.TestCase):
    def graph(self, extra="Warning"):
        question = "Command: /synthetic/client-node\nServer: /synthetic/server.mjs\nPRIVATE_CONFIG_ARGUMENT"
        rows = captured_connection_review_graph(question)
        rows.append({**rows[6], "reference": [":1.2", "11"], "name": extra})
        return question, rows

    def check(self, rows, question, record):
        return M.connection_review_graph_contract(rows, pid=123, question=question, record=record)

    def test_actual_extra_label_refusal_retains_only_bounded_already_read_redacted_graph(self):
        question, rows = self.graph()
        record = {}; original_rows = copy.deepcopy(rows)
        with patch.object(M, "read_file") as read, patch.object(M, "ax_graph") as walk, \
                patch.object(M.subprocess, "Popen") as spawn, self.assertRaisesRegex(RuntimeError, "^Unexpected extra connection-review text$"):
            self.check(rows, question, record)
        capture = record["refusedGraph"]
        self.assertEqual(rows, original_rows)
        self.assertEqual(capture["questionIndexes"], [6]); self.assertEqual(capture["extraLabelIndexes"], [5, 11])
        self.assertEqual(capture["nodes"][11]["name"], {"kind": "known", "text": "Warning"})
        self.assertEqual(capture["nodes"][11]["parentIndex"], 4)
        self.assertEqual(capture["nodes"][6]["name"]["kind"], "expected-question")
        self.assertNotIn("PRIVATE_CONFIG_ARGUMENT", json.dumps(capture)); self.assertNotIn("/synthetic/", json.dumps(capture))
        self.assertLessEqual(len(json.dumps(capture).encode()), 32768)
        for key in ("inputPermitted", "authorityGranted", "releaseReady"): self.assertIs(capture[key], False)
        self.assertTrue(capture["diagnosticOnly"])
        read.assert_not_called(); walk.assert_not_called(); spawn.assert_not_called()

    def test_unknown_labels_have_only_lengths_and_hash_never_body_or_configuration(self):
        extra = 'other-client --token=SECRET_VALUE /private/client.json\n{"command":"PRIVATE"}'
        question, rows = self.graph(extra)
        record = {}
        with self.assertRaisesRegex(RuntimeError, "Unexpected extra connection-review text"): self.check(rows, question, record)
        name = record["refusedGraph"]["nodes"][11]["name"]
        self.assertEqual(name, {"kind": "redacted", "chars": len(extra), "utf8Bytes": len(extra.encode()), "sha256": M.digest(extra.encode())})
        raw = json.dumps(record["refusedGraph"])
        for secret in ("SECRET_VALUE", "other-client", "PRIVATE", "client.json", "command"): self.assertNotIn(secret, raw)

    def test_success_and_other_refusals_have_no_diagnostic_and_matcher_stays_strict(self):
        question, rows = self.graph()
        record = {}; self.check(rows[:-1], question, record); self.assertEqual(record, {})
        for mutate in (lambda g: g[6].update(name="wrong question"), lambda g: g[0].update(pid=999),
                       lambda g: g[9].update(name="wrong action")):
            bad = copy.deepcopy(rows); mutate(bad); record = {}
            with patch.object(M, "connection_review_graph_diagnostic") as capture, self.assertRaises(RuntimeError):
                self.check(bad, question, record)
            self.assertEqual(record, {}); capture.assert_not_called()

    def test_capture_failure_preserves_identical_original_exception_and_omits_error_message(self):
        question, rows = self.graph(); original = RuntimeError("Unexpected extra connection-review text")
        record = {}
        with patch.object(M, "graph_contract", side_effect=original), \
                patch.object(M, "connection_review_graph_diagnostic", side_effect=ValueError("PRIVATE capture failure")), \
                self.assertRaises(RuntimeError) as raised:
            self.check(rows, question, record)
        self.assertIs(raised.exception, original)
        self.assertEqual(record, {"graphCaptureUnavailable": {"type": "ValueError"}})

    def test_capture_limits_and_malformed_or_foreign_rows_do_not_mask_original_refusal(self):
        question, rows = self.graph()
        for mutate in (lambda g: g.extend(copy.deepcopy(g) * 13), lambda g: g[11].update(name="x" * 4097),
                       lambda g: g[11].update(pid=999), lambda g: g[11].update(reference=g[6]["reference"]),
                       lambda g: g[11].update(parent=[":1.2", "foreign"]), lambda g: g[11].update(ready="yes")):
            bad = copy.deepcopy(rows); mutate(bad)
            with self.assertRaises(RuntimeError): M.connection_review_graph_diagnostic(bad, pid=123, question=question)
        class DifferentRuntimeError(RuntimeError): pass
        original = DifferentRuntimeError("Unexpected extra connection-review text")
        record = {}
        with patch.object(M, "graph_contract", side_effect=original), self.assertRaises(DifferentRuntimeError) as raised:
            self.check(rows, question, record)
        self.assertIs(raised.exception, original); self.assertEqual(record, {})

    def test_refusal_prevents_connection_action_and_production_uses_the_wrapper(self):
        question, rows = self.graph(); record = {}; button = Mock()
        def profile():
            self.check(rows, question, record)
            return button, {}
        with self.assertRaisesRegex(RuntimeError, "Unexpected extra connection-review text"):
            M.approve_connection_review(profile, Mock(), record)
        button.get_action_iface.assert_not_called(); self.assertNotIn("actionAttempts", record)
        tree = ast.parse(Path(M.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Session")
        method = next(n for n in session.body if isinstance(n, ast.FunctionDef) and n.name == "review_connections")
        calls = [n for n in ast.walk(method) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                 and n.func.id == "connection_review_graph_contract"]
        self.assertEqual(len(calls), 1)
        self.assertEqual({k.arg for k in calls[0].keywords}, {"pid", "question", "record"})

    def test_graph_is_persisted_with_primary_failure_in_existing_session_receipt(self):
        question, rows = self.graph()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(M.Session, "start"):
                session = M.Session(root, binding())
            record = session.evidence["connectionReview"] = {}
            try:
                self.check(rows, question, record)
            except RuntimeError as error:
                session.retain_failure(error)
            value = json.loads((root / "session.json").read_bytes())
            self.assertEqual(value["firstFailure"]["message"], "Unexpected extra connection-review text")
            self.assertEqual(value["connectionReview"]["refusedGraph"]["extraLabelIndexes"], [5, 11])
            self.assertEqual(list(root.iterdir()), [root / "session.json"])
            self.assertNotIn("PRIVATE_CONFIG_ARGUMENT", json.dumps(value))


class AuthorizationReadinessCaptureTests(unittest.TestCase):
    def fixture(self):
        question = "fixed synthetic retirement question"
        labels = [(16, "Authenticate"), (29, question), (40, None), (43, "Cancel"),
                  (43, "Authenticate"), (29, "PRIVATE unrelated details label")]
        rows = [{"reference": [":1.9", str(i)], "parent": [":1.9", "app" if i == 0 else "0"],
                 "pid": 123, "role": role, "name": name, "ready": i != 5}
                for i, (role, name) in enumerate(labels)]
        observations = [{"reference": row["reference"], "states": dict(zip(
            ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY"),
            (True, True, True, False, False) if row["ready"] else (False, None, None, None, None)))} for row in rows]
        return question, rows, observations

    def check(self, rows, observations, question, record):
        return M.authentication_graph_contract(rows, pid=123, question=question, observations=observations, record=record)

    def test_first_profile_refusal_retains_exact_role_reference_and_only_evaluated_state_bits(self):
        question, rows, observations = self.fixture(); record = {}; original = copy.deepcopy((rows, observations))
        with patch.object(M, "ax_graph") as walk, patch.object(M, "read_file") as read, \
                patch.object(M.subprocess, "Popen") as spawn, self.assertRaisesRegex(RuntimeError, "^Native controls are not ready$"):
            self.check(rows, observations, question, record)
        value = record["readinessRefusal"]
        self.assertEqual((rows, observations), original)
        self.assertEqual(value["failedIndexes"], [5])
        node = value["nodes"][5]
        self.assertEqual((node["role"], node["reference"], node["parentIndex"]), (29, [":1.9", "5"], 0))
        self.assertEqual(node["states"], {"SHOWING": False, "ENABLED": None, "SENSITIVE": None, "DEFUNCT": None, "BUSY": None})
        self.assertEqual(value["nodes"][2]["name"], {"kind": "unread"})
        self.assertEqual(value["nodes"][1]["name"]["kind"], "expected-question")
        self.assertNotIn("PRIVATE", json.dumps(value)); self.assertNotIn(question, json.dumps(value))
        self.assertLessEqual(len(json.dumps(value).encode()), 32768)
        for key in ("inputPermitted", "authorityGranted", "releaseReady"): self.assertIs(value[key], False)
        self.assertTrue(value["diagnosticOnly"])
        walk.assert_not_called(); read.assert_not_called(); spawn.assert_not_called()

    def test_no_capture_on_success_or_other_contract_failure_or_different_exception_type(self):
        question, rows, observations = self.fixture()
        rows[-1]["ready"] = True
        with patch.object(M, "authentication_readiness_diagnostic") as capture:
            record = {}; self.check(rows, observations, question, record)
            self.assertEqual(record, {}); capture.assert_not_called()
            rows[1]["name"] = "wrong question"
            with self.assertRaisesRegex(RuntimeError, "Exact source-bound native question"):
                self.check(rows, observations, question, record)
            self.assertEqual(record, {}); capture.assert_not_called()
            class Other(RuntimeError): pass
            original = Other("Native controls are not ready")
            with patch.object(M, "graph_contract", side_effect=original), self.assertRaises(Other) as raised:
                self.check(rows, observations, question, record)
            self.assertIs(raised.exception, original); capture.assert_not_called()

    def test_capture_failure_preserves_original_and_first_capture_is_not_replaced(self):
        question, rows, observations = self.fixture(); record = {}
        original = RuntimeError("Native controls are not ready")
        with patch.object(M, "graph_contract", side_effect=original), \
                patch.object(M, "authentication_readiness_diagnostic", side_effect=ValueError("PRIVATE capture error")), \
                self.assertRaises(RuntimeError) as raised:
            self.check(rows, observations, question, record)
        self.assertIs(raised.exception, original)
        self.assertEqual(record, {"readinessCaptureUnavailable": {"type": "ValueError"}})
        record = {"readinessRefusal": {"first": True}}
        with patch.object(M, "authentication_readiness_diagnostic") as capture, self.assertRaises(RuntimeError):
            self.check(rows, observations, question, record)
        capture.assert_not_called(); self.assertEqual(record, {"readinessRefusal": {"first": True}})

    def test_malformed_foreign_or_oversized_diagnostic_is_rejected(self):
        question, rows, observations = self.fixture()
        for mutate in (lambda r, o: r.extend(copy.deepcopy(r) * 12), lambda r, o: r[5].update(name="x" * 4097),
                       lambda r, o: r[5].update(pid=999), lambda r, o: r[5].update(parent=[":foreign", "outside"]),
                       lambda r, o: o[5].update(reference=o[0]["reference"]),
                       lambda r, o: o[5]["states"].update(ENABLED="PRIVATE"),
                       lambda r, o: o[5]["states"].update(OTHER=True)):
            r, o = copy.deepcopy((rows, observations)); mutate(r, o)
            with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                M.authentication_readiness_diagnostic(r, o, pid=123, question=question)

    def test_actual_first_cancel_profile_failure_persists_before_action_with_no_additional_walk(self):
        question, rows, observations = self.fixture(); native = M.load("native-linux-polkit-probe")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(M.Session, "start"):
                session = M.Session(root, binding())
            windows = [{"window": 42}]; bus, refs, button = Mock(), Mock(), Mock()
            session.polkit = SimpleNamespace(windows=Mock(return_value=windows), cancel_once=native.cancel_once)
            session.pages = SimpleNamespace(wait=lambda check, _seconds: check())
            session.x11 = SimpleNamespace(frame_rectangle=lambda _xid: (0, 0, 200, 100))
            session.native = SimpleNamespace(native_ax_references=lambda: (refs, bus))
            session.helper = Mock()
            authorizer = M.Authorization(session, Mock(), {"pid": 123}, {}, {}, Mock(), Mock(), Mock(), question, [0], Mock(), {})
            authorizer.input_guard = Mock()
            def walk(*_args, **kwargs):
                kwargs["observations"].extend(copy.deepcopy(observations))
                return rows, [button] * len(rows)
            with patch.object(M, "ax_graph", side_effect=walk) as walked:
                try:
                    authorizer.act("mcp", False, None)
                except RuntimeError as error:
                    session.retain_failure(error)
                else: self.fail("Original readiness refusal required")
            self.assertEqual(walked.call_count, 1); authorizer.input_guard.assert_called_once()
            button.get_action_iface.assert_not_called(); bus.close_sync.assert_called_once_with(None)
            value = json.loads((root / "session.json").read_bytes())
            self.assertEqual(value["firstFailure"]["message"], "Native controls are not ready")
            record = value["authorization"][0]
            self.assertEqual(record["readinessRefusal"]["failedIndexes"], [5])
            self.assertFalse(record["passwordRead"])
            for key in ("cancelProfile", "cancelActionAttempts", "passwordWriteAttempts", "actionMayHaveRun"):
                self.assertNotIn(key, record)

    def test_state_capture_preserves_exact_short_circuit_reads_and_unknown_bits(self):
        names = ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")
        for changed in (*names, None):
            calls = []
            def contains(name):
                calls.append(name)
                return (name in names[:3]) != (name == changed)
            states = SimpleNamespace(contains=contains)
            app, desktop = object(), object()
            dialog = SimpleNamespace(get_process_id=lambda: 123, get_role=lambda: 16, clear_cache=lambda: None,
                                     get_parent=lambda: app, get_state_set=lambda: states, get_name=lambda: "Authenticate",
                                     get_component_iface=lambda: SimpleNamespace(get_extents=lambda _: SimpleNamespace(x=0, y=0, width=200, height=100)))
            helper = SimpleNamespace(fresh_close_children=lambda node, _limit: [app] if node is desktop else [dialog] if node is app else [])
            atspi = SimpleNamespace(get_desktop=lambda _: desktop, Role=SimpleNamespace(ALERT=2, DIALOG=16, PASSWORD_TEXT=40),
                                    StateType=SimpleNamespace(EDITABLE="EDITABLE", **{name: name for name in names}),
                                    CoordType=SimpleNamespace(SCREEN=0))
            # Application attribution is queried before the bounded dialog walk.
            app = SimpleNamespace(get_process_id=lambda: 123)
            refs = SimpleNamespace(identity=lambda node, _owner: [":1.9", "app" if node is app else "dialog"])
            owner = SimpleNamespace(root={"pid": 123})
            with self.subTest(changed=changed):
                plain, _ = M.ax_graph(atspi, helper, Mock(), refs, owner, (0, 0, 200, 100))
                original_calls = list(calls); calls.clear(); observed = []
                captured, _ = M.ax_graph(atspi, helper, Mock(), refs, owner, (0, 0, 200, 100), observations=observed)
                self.assertEqual(captured, plain); self.assertEqual(calls, original_calls)
                expected_reads = ["EDITABLE", *names[:names.index(changed) + 1]] if changed is not None else ["EDITABLE", *names]
                self.assertEqual(calls, expected_reads)
                self.assertEqual(captured[0]["ready"], changed is None)
                expected = {name: ((name in names[:3]) != (name == changed)) if name in calls else None for name in names}
                self.assertEqual(observed, [{"reference": [":1.9", "dialog"], "states": expected}])

    def test_failed_first_profile_never_retries_or_reads_password(self):
        question, rows, observations = self.fixture(); native = M.load("native-linux-polkit-probe")
        button = Mock(); record = {"mode": "cancel"}
        def profile():
            self.check(rows, observations, question, record)
            return button, {}
        profile = Mock(side_effect=profile)
        with self.assertRaisesRegex(RuntimeError, "^Native controls are not ready$"):
            native.cancel_once(profile, Mock(), record)
        profile.assert_called_once(); button.get_action_iface.assert_not_called()
        self.assertNotIn("cancelActionAttempts", record)


class SessionProgressTests(unittest.TestCase):
    class Stall(BaseException):
        pass

    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(M.Session, "start"):
                session = M.Session(root, binding(), reopened=True)
            session.d = SimpleNamespace(last_request=None)
            yield session, root / "session.json"

    def receipt(self, file):
        value = json.loads(file.read_bytes())
        self.assertLessEqual(len(json.dumps(value["progress"]).encode()), 4096)
        self.assertTrue(value["progress"]["diagnosticOnly"])
        self.assertFalse(value["progress"]["authorityGranted"])
        self.assertFalse(value["progress"]["releaseReady"])
        return value

    def test_startup_stall_keeps_existing_exported_session_receipt_before_constructor_returns(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            cls = next(n for n in ast.parse(Path(M.__file__).read_text()).body if isinstance(n, ast.ClassDef) and n.name == "Session")
            start = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "start")
            index = next(i for i, node in enumerate(start.body) if isinstance(node, ast.Assign)
                         and any(isinstance(target, ast.Name) and target.id == "response" for target in node.targets))
            function = ast.FunctionDef(name="actual_session_create", args=ast.arguments(posonlyargs=[],
                args=[ast.arg(arg="self")], kwonlyargs=[], kw_defaults=[], defaults=[]),
                body=copy.deepcopy(start.body[index - 1:index + 1]), decorator_list=[])
            namespace = dict(vars(M))
            exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "actual-session-create", "exec"), namespace)
            def stalled(session):
                session.d = SimpleNamespace(last_request=None, request=session.observe_request(Mock(side_effect=self.Stall())))
                namespace["actual_session_create"](session)
            with patch.object(M.Session, "start", stalled), self.assertRaises(self.Stall):
                M.Session(root, binding(), reopened=True)
            value = self.receipt(root / "session.json")
            self.assertTrue(value["reopened"])
            self.assertFalse(value["normalCloseObserved"])
            self.assertEqual(value["progress"]["boundary"], "session-create")
            self.assertNotIn("firstFailure", value)

    def test_pending_request_and_guard_completion_survive_injected_transport_stall_without_retry(self):
        with self.fixture() as (session, file):
            driver = M.load("native-linux-integrated-pages").Driver()
            session.d = driver
            def guard():
                session.checkpoint(guard=("driver", "entered"))
                session.checkpoint(guard=("driver", "completed"))
            driver.guard = guard
            with patch.object(driver.http, "open", side_effect=self.Stall()) as opened, self.assertRaises(self.Stall):
                session.observe_request(driver.request)("POST", "/session", {"notRetained": "private-payload"})
            value = self.receipt(file)
            opened.assert_called_once()
            self.assertEqual(driver.last_request["phase"], "http")
            self.assertEqual(value["progress"]["activeRequest"], {"method": "POST", "route": "/session", "phase": "before-guard"})
            self.assertEqual(value["progress"]["guards"]["driver"]["phase"], "completed")
            self.assertNotIn("private-payload", file.read_text())
            self.assertNotIn("firstFailure", value)

    def test_guard_entry_survives_injected_guard_stall_without_completion_claim(self):
        with self.fixture() as (session, file):
            session.checkpoint("window-wait")
            session.logs = SimpleNamespace(pump=Mock(side_effect=self.Stall()))
            with self.assertRaises(self.Stall):
                session.process_guard()
            value = self.receipt(file)
            self.assertEqual(value["progress"]["boundary"], "window-wait")
            self.assertEqual(value["progress"]["guards"]["root"]["phase"], "entered")

    def test_replaced_inode_or_preexisting_temporary_receipt_is_never_overwritten_or_removed(self):
        for failure in ("inode", "temporary"):
            with self.subTest(failure=failure), self.fixture() as (session, file):
                if failure == "inode":
                    foreign = file.with_name("foreign.json")
                    foreign.write_bytes(file.read_bytes())
                    os.replace(foreign, file)
                    expected = file.read_bytes()
                else:
                    foreign = file.with_name("session.json.progress-new")
                    foreign.write_bytes(b"foreign temporary")
                    expected = file.read_bytes()
                session.checkpoint("session-created")
                self.assertTrue(session.evidence["progressCaptureUnavailable"])
                self.assertEqual(file.read_bytes(), expected)
                if failure == "temporary": self.assertEqual(foreign.read_bytes(), b"foreign temporary")

    def test_first_failure_is_on_disk_before_actual_optional_failure_ui_and_is_never_replaced(self):
        source = ast.parse(Path(M.__file__).read_text())
        run = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == "run_session")
        handler = next(n.handlers[0] for n in run.body if isinstance(n, ast.Try) and n.handlers)
        function = ast.FunctionDef(name="failure", args=ast.arguments(posonlyargs=[],
            args=[ast.arg(arg=name) for name in ("error", "report", "session")], kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=[ast.Try(body=[ast.Raise(exc=ast.Name(id="error", ctx=ast.Load()))], handlers=[copy.deepcopy(handler)], orelse=[], finalbody=[])], decorator_list=[])
        namespace = dict(vars(M))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "actual-session-failure", "exec"), namespace)
        with self.fixture() as (session, file):
            original = RuntimeError("first native failure")
            def stalled_guard():
                self.assertEqual(self.receipt(file)["firstFailure"]["message"], str(original))
                raise self.Stall()
            session.process_guard = stalled_guard
            report = {}
            with self.assertRaises(self.Stall): namespace["failure"](original, report, session)
            session.retain_failure(ValueError("later capture failure"))
            self.assertEqual(self.receipt(file)["firstFailure"], {"type": "RuntimeError", "message": "first native failure"})
            self.assertEqual(report["refusal"]["message"], str(original))

    def test_atomic_progress_is_bounded_monotonic_and_replaces_only_its_own_snapshot(self):
        with self.fixture() as (session, file):
            first = self.receipt(file)["progress"]
            for _ in range(12): session.checkpoint(guard=("root", "entered"))
            value = self.receipt(file)["progress"]
            self.assertGreater(value["sequence"], first["sequence"])
            self.assertGreaterEqual(value["elapsedMs"], first["elapsedMs"])
            self.assertEqual(list(file.parent.iterdir()), [file])
            file.write_bytes(b"foreign receipt")
            session.checkpoint("startup-ready")
            self.assertEqual(file.read_bytes(), b"foreign receipt")
            self.assertTrue(session.evidence["progressCaptureUnavailable"])

    def test_diagnostic_write_failure_does_not_mask_original_exception_or_retry(self):
        with self.fixture() as (session, file):
            original = RuntimeError("original request failed")
            request = Mock(side_effect=original)
            with patch.object(M.os, "replace", side_effect=OSError("capture storage refused")) as replace:
                with self.assertRaises(RuntimeError) as raised:
                    session.observe_request(request)("GET", "/status")
                self.assertIs(raised.exception, original)
                self.assertEqual(replace.call_count, 1)
                self.assertEqual(request.call_count, 1)
            self.assertEqual(session.evidence["firstFailure"]["message"], str(original))
            self.assertFalse(self.receipt(file)["normalCloseObserved"])

    def test_startup_primary_failure_is_saved_before_optional_log_capture_can_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            original = RuntimeError("original startup refusal")
            log = Mock()
            def capture():
                self.assertEqual(self.receipt(root / "session.json")["firstFailure"]["message"], str(original))
                raise OSError("optional capture failed")
            log.pump.side_effect = capture
            log.close.side_effect = OSError("optional close failed")
            def start(session):
                session.logs = log
                raise original
            with patch.object(M.Session, "start", start), self.assertRaises(RuntimeError) as raised:
                M.Session(root, binding())
            self.assertIs(raised.exception, original)
            value = self.receipt(root / "session.json")
            self.assertEqual(value["startupRefused"]["message"], str(original))
            self.assertTrue(value["captureRefused"])
            log.close.assert_called_once()


class DriverReadinessTests(unittest.TestCase):
    def startup(self, *, driver_at=1, backend_at=3, appears_at=1, statuses=(True,), change=None, transport_error=False):
        state = SimpleNamespace(tick=0, requests=[], statuses=iter(statuses), rows={}, closed=set())
        driver = dict(pid=100, parentPid=99, executable="/fixture/tauri-driver", uids=[M.UID] * 4,
                      startTime="100", kernelImageSha256="d" * 64)
        backend = dict(pid=101, parentPid=100, executable="/usr/bin/WebKitWebDriver", uids=[M.UID] * 4,
                       startTime="101", kernelImageSha256="b" * 64)
        state.rows = {100: copy.deepcopy(driver), 101: copy.deepcopy(backend)}
        def process(pid, _):
            if pid not in state.rows:
                raise ProcessLookupError("Synthetic owned process disappeared")
            return copy.deepcopy(state.rows[pid])
        def listener(pid, port):
            return (pid, port) not in state.closed and ((pid, port) == (100, 4444) and state.tick >= driver_at or
                    (pid, port) == (101, 4445) and state.tick >= backend_at)
        def wait(check):
            for _ in range(8):
                state.tick += 1
                if change:
                    change(state)
                if check():
                    return
            raise RuntimeError("Read-only readiness deadline; no mutation retried")
        def request(method, endpoint):
            session.d.guard()
            state.requests.append((method, endpoint, state.tick))
            self.assertEqual((method, endpoint), ("GET", "/status"))
            if not listener(100, 4444) or not listener(101, 4445) or transport_error:
                raise http.client.RemoteDisconnected("Remote end closed connection without response")
            result = {"ready": next(state.statuses)}
            session.d.guard()
            return result
        session = M.Session.__new__(M.Session)
        session.logs = Mock()
        session.logs.metadata.return_value = {"stdout": {"truncated": False}}
        session.child = SimpleNamespace(pid=100, poll=lambda: None)
        session.driver_identity, session.native_driver = driver, {"sha256": "b" * 64}
        session.helper, session.evidence = None, {}
        session.native = SimpleNamespace(native_process=process)
        session.pages = SimpleNamespace(wait=wait, listener=listener,
            subtree=lambda *args: copy.deepcopy({pid: row for pid, row in state.rows.items()
                                                if pid != 101 or state.tick >= appears_at}))
        session.d = SimpleNamespace(guard=lambda: None, request=request)
        # Execute the actual startup statements, stopping before POST /session.
        cls = next(n for n in ast.parse(Path(M.__file__).read_text()).body if isinstance(n, ast.ClassDef) and n.name == "Session")
        start = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "start")
        first = next(i for i, n in enumerate(start.body) if isinstance(n, ast.FunctionDef) and n.name == "bootstrap_guard")
        last = next(i for i, n in enumerate(start.body) if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "response" for t in n.targets))
        wrapper = ast.FunctionDef(name="fixture_start", args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="self")],
            kwonlyargs=[], kw_defaults=[], defaults=[]), body=start.body[first:last], decorator_list=[])
        code = compile(ast.fix_missing_locations(ast.Module(body=[wrapper], type_ignores=[])), "migration-owned-driver-preflight", "exec")
        self.last_state, self.last_session = state, session
        namespace = dict(vars(M))
        exec(code, namespace)
        namespace["fixture_start"](session)
        return state, session

    def test_staggered_owned_listeners_are_ready_before_any_status_or_root_request(self):
        for driver_at, backend_at, appears_at in ((1, 3, 1), (3, 1, 1), (1, 4, 3)):
            with self.subTest(driver_at=driver_at, backend_at=backend_at, appears_at=appears_at):
                state, session = self.startup(driver_at=driver_at, backend_at=backend_at, appears_at=appears_at)
                self.assertEqual(len(state.requests), 1)
                self.assertGreaterEqual(state.requests[0][2], max(driver_at, backend_at, appears_at))
                self.assertEqual(session.evidence["backend"], session.backend)

    def test_missing_listener_or_backend_never_sends_http(self):
        for arguments in (dict(driver_at=99), dict(backend_at=99), dict(appears_at=99)):
            with self.subTest(arguments=arguments), self.assertRaisesRegex(RuntimeError, "Read-only readiness deadline"):
                self.startup(**arguments)
            self.assertEqual(self.last_state.requests, [])

    def test_owned_backend_or_driver_identity_change_fails_before_http(self):
        for pid in (100, 101):
            for field, value in (("kernelImageSha256", "x" * 64), ("parentPid", 999),
                                 ("uids", [0] * 4), ("startTime", "replacement")):
                def change(state):
                    if state.tick == 2:
                        state.rows[pid][field] = value
                with self.subTest(pid=pid, field=field), self.assertRaises(RuntimeError):
                    self.startup(change=change)
                self.assertEqual(self.last_state.requests, [])
        def disappear(state):
            if state.tick == 2:
                del state.rows[101]
        with self.assertRaisesRegex(RuntimeError, "disappeared"):
            self.startup(change=disappear)
        self.assertEqual(self.last_state.requests, [])

    def test_readonly_status_false_can_wait_but_transport_failure_stops_without_retry(self):
        state, _ = self.startup(statuses=(False, True))
        self.assertEqual([(method, path) for method, path, _ in state.requests], [("GET", "/status")] * 2)
        with self.assertRaises(http.client.RemoteDisconnected):
            self.startup(transport_error=True)
        self.assertEqual(len(self.last_state.requests), 1)

    def test_bound_identity_and_both_sockets_remain_guarded_after_preflight(self):
        for field, value in (("kernelImageSha256", "x" * 64), ("parentPid", 999),
                             ("uids", [0] * 4), ("startTime", "replacement")):
            state, session = self.startup()
            state.rows[101][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                session.d.guard()
        for socket in ((100, 4444), (101, 4445)):
            state, session = self.startup()
            state.closed.add(socket)
            with self.subTest(socket=socket), self.assertRaises(RuntimeError):
                session.d.guard()


class PermissionCaptureTests(unittest.TestCase):
    def test_only_exact_failed_pid_is_read_and_only_parsed_kernel_identity_is_exported(self):
        with permission_capture_fixture() as f:
            result = M.inventory_permission_capture(PermissionError(13, "synthetic", "/proc/5152/exe"), f.helper)
            self.assertEqual(f.opened, ["/proc/5152", "stat", "status", "stat", "status"])
            self.assertEqual(f.reads, ["stat", "status", "stat", "status"])
        self.assertEqual(result["pid"], 5152)
        self.assertEqual(result["errno"], 13)
        self.assertTrue(result["readOnly"])
        self.assertTrue(result["stable"])
        self.assertEqual(result["before"], result["after"])
        self.assertEqual(result["before"]["Uid"], [M.UID] * 4)
        self.assertEqual(result["before"]["Gid"], [M.UID] * 4)
        self.assertEqual(result["before"]["startTime"], "12345")
        self.assertEqual(result["before"]["parentPid"], 4000)
        self.assertEqual(result["before"]["procDirectory"]["uid"], M.UID)
        self.assertNotIn("DO_NOT_RETAIN", json.dumps(result))
        self.assertLess(len(json.dumps(result).encode()), 4096)

    def test_mixed_credentials_are_captured_but_changes_or_reused_pid_are_not_stable(self):
        mixed = f"Uid:\t{M.UID}\t0\t0\t0\nGid:\t{M.UID}\t0\t0\t0\n".encode()
        same = f"Uid:\t{M.UID}\t{M.UID}\t{M.UID}\t{M.UID}\nGid:\t{M.UID}\t{M.UID}\t{M.UID}\t{M.UID}\n".encode()
        for statuses, starts, stable in (((mixed, mixed), ("12345", "12345"), True),
                                        ((same, mixed), ("12345", "12345"), False),
                                        ((same, same), ("12345", "54321"), False)):
            with permission_capture_fixture(statuses=statuses, starts=starts) as f:
                result = M.inventory_permission_capture(PermissionError(13, "synthetic", "/proc/5152/exe"), f.helper)
            self.assertIs(result["stable"], stable)
            self.assertIsNotNone(result["before"]); self.assertIsNotNone(result["after"])

    def test_redirects_changed_fds_oversize_or_missing_fields_only_make_capture_unavailable(self):
        for failure in ("symlink", "hardlink", "fd-replaced", "dir-replaced", "path-replaced", "oversized", "missing-uid"):
            with self.subTest(failure=failure), permission_capture_fixture(failure=failure) as f:
                result = M.inventory_permission_capture(PermissionError(13, "synthetic", "/proc/5152/exe"), f.helper)
                self.assertFalse(result["stable"])
                self.assertEqual(result["unavailable"], "RuntimeError")
                self.assertNotIn("DO_NOT_RETAIN", json.dumps(result))
                if failure in ("symlink", "hardlink", "fd-replaced", "dir-replaced"):
                    self.assertFalse(f.reads)

    def test_nonexact_failure_paths_do_not_trigger_any_proc_reads(self):
        for path in (None, "/proc/0/exe", "/proc/../5152/exe", "/proc/5152/cmdline", "/proc/5152/exe (deleted)", "/tmp/5152/exe"):
            with self.subTest(path=path), patch.object(M.os, "open") as opened:
                result = M.inventory_permission_capture(PermissionError(13, "synthetic", path), Mock())
                self.assertFalse(result["stable"])
                self.assertIn("unavailable", result)
                opened.assert_not_called()

    def test_startup_always_retains_capture_and_reraises_the_identical_inventory_exception(self):
        for capture in ({"stable": True, "pid": 5152}, {"stable": False, "pid": 5152}, RuntimeError("capture failed")):
            with self.subTest(capture=capture), tempfile.TemporaryDirectory() as temporary:
                original = PermissionError(13, "synthetic", "/proc/5152/exe")
                log = Mock(); log.metadata.return_value = {"stderr": {"truncated": False}}
                def start(session):
                    session.logs, session.helper = log, Mock()
                    session.driver_identity, session.owned = {"pid": 11}, {"pid": 13}
                    session.child = Mock(pid=11); session.child.poll.return_value = None
                    session.native = SimpleNamespace(native_process=lambda pid, helper: session.driver_identity if pid == 11 else session.owned)
                    session.pages = SimpleNamespace(listener=lambda *args: True, wait=Mock())
                    session.backend_guard = lambda: None
                    session.evidence["root"] = session.owned
                    session.process_guard()
                options = {"side_effect": capture} if isinstance(capture, Exception) else {"return_value": capture}
                inventory = SimpleNamespace(sample=Mock(side_effect=original))
                with patch.object(M.Session, "start", start), patch.object(M, "native_process_inventory", side_effect=AssertionError("No unprivileged global scan")), \
                     patch.object(M, "inventory_permission_capture", **options), self.assertRaises(PermissionError) as raised:
                    M.Session(Path(temporary).resolve(), binding(), inventory=inventory)
                self.assertIs(raised.exception, original)
                file = Path(temporary) / "session.json"
                receipt = json.loads(file.read_bytes())
                self.assertEqual(receipt["startupRefused"]["type"], "PermissionError")
                self.assertEqual(receipt["root"], {"pid": 13})
                if isinstance(capture, Exception):
                    self.assertEqual(receipt["processInventoryRefusal"]["unavailable"], "RuntimeError")
                else:
                    self.assertEqual(receipt["processInventoryRefusal"], capture)
                self.assertFalse(receipt["normalCloseObserved"])
                self.assertLess(file.stat().st_size, 4096)


class ControllerTests(unittest.TestCase):
    def test_ci_directory_allowlist_is_exactly_fourteen_with_only_retained_graph_additions_outer_first(self):
        original = ("/usr/share/applications", "/usr/share/icons", "/usr/share/icons/hicolor",
                    "/usr/share/icons/hicolor/128x128", "/usr/share/icons/hicolor/128x128/apps",
                    "/usr/share/icons/hicolor/32x32", "/usr/share/icons/hicolor/32x32/apps")
        # Run 39357255499: both complete 30-record graphs captured exactly these additional unsafe parents.
        retained_graph_parents = ("/usr/share/dict", "/usr/share/man", "/usr/share/man/man1",
                                  "/usr/share/vim", "/usr/share/vim/vim82", "/usr/share/vim/vim82/doc", "/usr/share/aclocal")
        self.assertEqual(M.CI_SHARED_DIRECTORIES, original + retained_graph_parents)
        self.assertEqual(len(set(M.CI_SHARED_DIRECTORIES)), 14)
        for index, path in enumerate(M.CI_SHARED_DIRECTORIES):
            for parent in M.PurePosixPath(path).parents:
                if str(parent) in M.CI_SHARED_DIRECTORIES:
                    self.assertLess(M.CI_SHARED_DIRECTORIES.index(str(parent)), index)

    def test_fixed_ci_directory_hardening_is_fd_bound_outer_first_with_bounded_pre_post_proofs(self):
        with hardening_fixture() as f:
            f.directories[M.CI_SHARED_DIRECTORIES[0]].st_mode = M.stat.S_IFDIR | 0o755
            inodes = {path: row.st_ino for path, row in f.directories.items()}
            M.harden_fixture_directories(f.env)
            self.assertEqual(f.changes, list(M.CI_SHARED_DIRECTORIES[1:]))
            self.assertFalse(f.fds)
            self.assertEqual(inodes, {path: row.st_ino for path, row in f.directories.items()})
            for phase in ("before", "after"):
                file = f.root / ("fixture-directory-hardening-" + phase + ".json")
                proof = json.loads(file.read_bytes())
                self.assertEqual([row["path"] for row in proof["directories"]], list(M.CI_SHARED_DIRECTORIES))
                self.assertTrue(all(proof[key] is False for key in M.FLAGS))
                self.assertLess(file.stat().st_size, 16384)
            after = json.loads((f.root / "fixture-directory-hardening-after.json").read_bytes())
            self.assertTrue(after["completed"])
            self.assertTrue(all(row["mode"] == 0o755 for row in after["directories"]))

    def test_ci_directory_hardening_rejects_unexpected_owner_modes_and_redirects_without_chmod(self):
        for failure in ("owner", "group", "mode", "symlink", "ancestor"):
            with self.subTest(failure=failure), hardening_fixture() as f:
                first = f.directories[M.CI_SHARED_DIRECTORIES[0]]
                if failure == "owner": first.st_uid = 1001
                if failure == "group": first.st_gid = 1001
                if failure == "mode": first.st_mode = M.stat.S_IFDIR | 0o775
                if failure == "symlink": first.st_mode = M.stat.S_IFLNK | 0o777
                if failure == "ancestor": f.directories["/usr/share"].st_mode = M.stat.S_IFLNK | 0o777
                with self.assertRaises((RuntimeError, OSError)):
                    M.harden_fixture_directories(f.env)
                self.assertEqual(f.changes, []); self.assertFalse(f.fds)
                self.assertFalse(json.loads((f.root / "fixture-directory-hardening-after.json").read_bytes())["completed"])

    def test_ci_directory_hardening_rejects_changed_path_inode_and_retains_original_fd_identity(self):
        with hardening_fixture() as f:
            f.race = M.CI_SHARED_DIRECTORIES[0]
            with self.assertRaises(RuntimeError): M.harden_fixture_directories(f.env)
            self.assertTrue(f.raced); self.assertEqual(f.changes, []); self.assertFalse(f.fds)
            before = json.loads((f.root / "fixture-directory-hardening-before.json").read_bytes())
            after = json.loads((f.root / "fixture-directory-hardening-after.json").read_bytes())
            self.assertNotEqual(before["directories"][0]["ino"], after["directories"][0]["ino"])
            self.assertFalse(after["completed"])

    def test_ci_directory_hardening_refuses_other_roles_phases_and_extra_paths_before_permission_changes(self):
        for failure in ("nonroot", "push", "reused", "extra-path", "unobserved-metadata-parent"):
            with self.subTest(failure=failure), hardening_fixture(uid=M.UID if failure == "nonroot" else 0) as f:
                kwargs = {}
                if failure == "push": f.env["GITHUB_EVENT_NAME"] = "push"
                if failure == "reused": (f.root / "fixture-directory-hardening-before.json").write_bytes(b"original")
                if failure == "extra-path": kwargs["paths"] = (*M.CI_SHARED_DIRECTORIES, "/home/runner")
                if failure == "unobserved-metadata-parent": kwargs["paths"] = (*M.CI_SHARED_DIRECTORIES, "/usr/share/man/man2")
                with self.assertRaises(RuntimeError): M.harden_fixture_directories(f.env, **kwargs)
                self.assertEqual(f.changes, []); self.assertFalse(f.fds)
                self.assertFalse((f.root / "fixture-directory-hardening-after.json").exists())

    def test_ci_hardening_is_before_any_original_deb_install_and_exports_only_two_fixed_proofs(self):
        source = ast.parse((HERE / "native-linux-production-016-migration.py").read_text())
        install = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "install_fixture")
        calls = [node for node in ast.walk(install) if isinstance(node, ast.Call)]
        harden = next(node.lineno for node in calls if isinstance(node.func, ast.Name) and node.func.id == "harden_fixture_directories")
        dpkg = next(node.lineno for node in calls if isinstance(node.func, ast.Name) and node.func.id == "tool" and isinstance(node.args[0], ast.List)
                    and [getattr(value, "value", None) for value in node.args[0].elts[:2]] == ["/usr/bin/dpkg", "--install"])
        self.assertLess(harden, dpkg)
        workflow = (HERE.parent / ".github/workflows/native-linux-production-016-migration.yml").read_text()
        assignment = next(line.strip() for line in workflow.splitlines() if line.lstrip().startswith("names = ["))
        names = ast.literal_eval(assignment.partition(" = ")[2])
        self.assertEqual([name for name in names if "directory-hardening" in name],
                         ["fixture-directory-hardening-before.json", "fixture-directory-hardening-after.json"])

    def test_helper_namespace_is_the_exact_compiled_inspection_files_and_their_finite_parents(self):
        rust = HERE.parent / "native/linux-deb-retirement/src"
        mcp = re.findall(r'pin!\(\s*"([^"]+)"', (rust / "pins.rs").read_text())
        setup = re.findall(r'path: "([^"]+)"', (rust / "setup.rs").read_text())
        system = {"/usr/bin/dpkg", "/usr/bin/dpkg-query", "/var/lib/dpkg/diversions", "/var/lib/dpkg/statoverride",
                  "/var/lib/dpkg/info/creator-works-mcp.list", "/var/lib/dpkg/info/creator-works-mcp.md5sums",
                  "/var/lib/dpkg/info/creator-project-setup.list", "/var/lib/dpkg/info/creator-project-setup.md5sums"}
        self.assertEqual(set(M.HELPER_INSPECTION_FILES), {"/" + name for name in mcp + setup} | system)
        self.assertEqual(set(M.HELPER_INSPECTION_DIRS), {"/var/lib/dpkg/info", "/var/lib/dpkg/updates",
                         "/var/lib/creator-hub-deb-retirement", "/var/lib/creator-hub-deb-retirement-setup"})
        expected = set()
        for leaf in (*M.HELPER_INSPECTION_FILES, *M.HELPER_INSPECTION_DIRS):
            path = M.PurePosixPath(leaf)
            expected.update(map(str, (path, *path.parents)))
        calls = []
        def lstat(path):
            calls.append(path)
            if path.endswith("statoverride"):
                raise FileNotFoundError(2, "synthetic absent metadata")
            kind = M.stat.S_IFREG if path == "/usr/bin/dpkg" else M.stat.S_IFLNK if path == "/usr/bin/dpkg-query" else M.stat.S_IFDIR
            return SimpleNamespace(st_uid=0, st_gid=7 if path == "/usr/share" else 0, st_nlink=3,
                                   st_mode=kind | (0o777 if path == "/usr/share" else 0o755),
                                   st_size=4096, st_dev=1, st_ino=2, st_mtime_ns=3, st_ctime_ns=4)
        with patch.object(M.os, "lstat", side_effect=lstat), patch.object(M.os, "scandir", side_effect=AssertionError("No scan")), \
             patch.object(M, "read_file", side_effect=AssertionError("No file-content reads")):
            snapshot = M.helper_namespace()
        self.assertEqual(calls, sorted(expected))
        self.assertLessEqual(len(calls), 96)
        rows = {row["path"]: row for row in snapshot["entries"]}
        self.assertEqual(rows["/usr/share"]["mode"], 0o777)
        self.assertEqual(rows["/usr/share"]["modeOctal"], "0777")
        self.assertEqual(rows["/usr/share"]["gid"], 7)
        self.assertEqual(rows["/usr/share"]["type"], "directory")
        self.assertEqual(rows["/usr/bin/dpkg"]["type"], "file")
        self.assertEqual(rows["/usr/bin/dpkg"]["nlink"], 3)
        self.assertEqual(rows["/usr/bin/dpkg-query"]["type"], "symlink")
        self.assertEqual(rows["/var/lib/dpkg/statoverride"], {"path": "/var/lib/dpkg/statoverride", "error": "FileNotFoundError", "errno": 2})

    def test_helper_namespace_snapshots_surround_execution_before_reason_or_image_read(self):
        events = []
        snapshots = iter(({"entries": [{"path": "/usr/share", "mode": 0o755}]},
                          {"entries": [{"path": "/usr/share", "mode": 0o777}]}))
        metadata = iter(({"complete": True, "validationAuthority": False}, {"complete": False, "validationAuthority": False}))
        def snapshot():
            events.append("stat"); return next(snapshots)
        def graph():
            events.append("metadata"); return next(metadata)
        def execute(*args, **kwargs):
            events.append("helper"); return subprocess.CompletedProcess(args[0], 2, b'{"reason":"synthetic"}', b"")
        parse = M.P.parse
        def reason(raw):
            events.append("reason"); return parse(raw)
        def image():
            events.append("image"); return {"path": M.HELPER}
        with tempfile.TemporaryDirectory() as temporary, patch.object(M, "BASE", Path(temporary).resolve()) as root, \
             patch.object(M, "helper_namespace", side_effect=snapshot), patch.object(M.subprocess, "run", side_effect=execute), \
             patch.object(M, "helper_metadata", side_effect=graph), \
             patch.object(M.P, "parse", side_effect=reason), patch.object(M, "helper_identity", side_effect=image), \
             patch.multiple(M.os, getuid=Mock(return_value=0), geteuid=Mock(return_value=0),
                            getgid=Mock(return_value=0), getegid=Mock(return_value=0), create=True):
            with self.assertRaises(RuntimeError):
                M.tool([M.HELPER, "inspect"], helper_pin={"size": 64, "sha256": "a" * 64})
            receipt = json.loads((root / "helper-inspection-failure.json").read_bytes())
        self.assertEqual(events, ["stat", "metadata", "helper", "stat", "metadata", "reason", "image"])
        self.assertEqual(receipt["namespaceBefore"]["entries"][0]["mode"], 0o755)
        self.assertEqual(receipt["namespaceAfter"]["entries"][0]["mode"], 0o777)
        self.assertTrue(receipt["metadataBefore"]["complete"])
        self.assertFalse(receipt["metadataAfter"]["complete"])
        self.assertEqual(receipt["reasonExcerpt"], "synthetic")

    def test_helper_inspection_failure_is_saved_before_throw_even_before_user_creation(self):
        actions = ("inspect", "inspect-retained-mcp-2.7.7", "inspect-setup-0.3.7", "inspect-retained-setup-0.3.7")
        pin = {"size": 64, "sha256": "a" * 64}
        actual = {"path": M.HELPER, **pin, "mode": 0o755, "uid": 0, "gid": 0, "dev": 1, "ino": 2, "nlink": 1}
        stdout = json.dumps({"status": "refused", "reason": "r" * 6000}).encode()
        stderr = b"synthetic native diagnostic\n" * 1000
        for uid in (0, M.UID):
            for action in actions:
                with self.subTest(uid=uid, action=action), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary).resolve()
                    if uid:
                        (root / "result").mkdir()
                    destination = root / ("result/helper-inspection-failure.json" if uid else "helper-inspection-failure.json")
                    result = subprocess.CompletedProcess([M.HELPER, action], 2, stdout, stderr)
                    with patch.object(M, "BASE", root), patch.object(M, "helper_identity", return_value=actual), \
                         patch.object(M, "helper_namespace", return_value={"entries": []}), \
                         patch.object(M, "helper_metadata", return_value={"complete": False, "validationAuthority": False}), \
                         patch.multiple(M.os, getuid=Mock(return_value=uid), geteuid=Mock(return_value=uid),
                                        getgid=Mock(return_value=uid), getegid=Mock(return_value=uid), create=True), \
                         patch.object(M.subprocess, "run", return_value=result) as run:
                        with self.assertRaisesRegex(RuntimeError, "Finite native inspection refused; no retry"):
                            M.tool([M.HELPER, action], helper_pin=pin)
                    self.assertTrue(destination.is_file())
                    receipt = json.loads(destination.read_bytes())
                    self.assertEqual(receipt["argv"], [M.HELPER, action])
                    self.assertEqual(receipt["exitCode"], 2)
                    self.assertEqual(receipt["caller"], dict(uid=uid, euid=uid, gid=uid, egid=uid))
                    self.assertEqual(receipt["helperExpected"], {"path": M.HELPER, **pin, "mode": 0o755, "uid": 0, "gid": 0})
                    self.assertEqual(receipt["helperActual"], actual)
                    self.assertEqual(receipt["reasonExcerpt"], "r" * 1024)
                    for name, raw in (("stdout", stdout), ("stderr", stderr)):
                        self.assertEqual(receipt[name], {"bytes": len(raw), "sha256": M.digest(raw),
                                         "excerpt": raw[:2048].decode(), "truncated": True})
                    self.assertLess(destination.stat().st_size, 16384)
                    run.assert_called_once_with([M.HELPER, action], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                stderr=subprocess.PIPE, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}, check=False)
                    if not uid:
                        self.assertFalse((root / "result").exists(), "Pre-user evidence must not need a synthetic home/result directory")

    def test_helper_inspection_diagnostics_never_admit_unknown_actions_or_exit_codes(self):
        pin = {"size": 64, "sha256": "a" * 64}
        for args, kwargs in (([M.HELPER, "retire-mcp-2.7.7"], {"helper_pin": pin}),
                             ([M.HELPER, "inspect", "extra"], {"helper_pin": pin}),
                             ([M.HELPER], {"helper_pin": pin}), ([M.HELPER, "inspect"], {}),
                             ([M.HELPER, "inspect"], {"helper_pin": pin, "allowed": (0, 2)})):
            with self.subTest(args=args, kwargs=kwargs), patch.object(M.subprocess, "run") as run, \
                 patch.object(M, "helper_identity") as identity, patch.object(M, "helper_namespace") as namespace, \
                 patch.object(M, "helper_metadata") as metadata, self.assertRaises(RuntimeError):
                M.tool(args, **kwargs)
            run.assert_not_called(); identity.assert_not_called(); namespace.assert_not_called(); metadata.assert_not_called()

    def test_successful_helper_inspections_remain_read_only_and_oversized_output_still_refuses(self):
        pin = {"size": 64, "sha256": "a" * 64}
        for action in ("inspect", "inspect-retained-mcp-2.7.7", "inspect-setup-0.3.7", "inspect-retained-setup-0.3.7"):
            with patch.object(M.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"{}", b"")) as run, \
                 patch.object(M, "save") as save, patch.object(M, "helper_namespace", return_value={"entries": []}), \
                 patch.object(M, "helper_metadata", return_value={"complete": False, "validationAuthority": False}):
                self.assertEqual(M.tool([M.HELPER, action], helper_pin=pin), b"{}")
                run.assert_called_once(); save.assert_not_called()
        with tempfile.TemporaryDirectory() as temporary, patch.object(M, "BASE", Path(temporary).resolve()) as root, \
             patch.object(M, "helper_identity", return_value={"unavailable": "OSError"}), \
             patch.object(M, "helper_namespace", return_value={"entries": []}), \
             patch.object(M, "helper_metadata", return_value={"complete": False, "validationAuthority": False}), \
             patch.multiple(M.os, getuid=Mock(return_value=0), geteuid=Mock(return_value=0),
                            getgid=Mock(return_value=0), getegid=Mock(return_value=0), create=True), \
             patch.object(M.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"x" * 262145, b"")):
            with self.assertRaises(RuntimeError):
                M.tool([M.HELPER, "inspect"], helper_pin=pin)
            receipt = json.loads((root / "helper-inspection-failure.json").read_bytes())
            self.assertEqual(receipt["stdout"]["bytes"], 262145)
            self.assertEqual(len(receipt["stdout"]["excerpt"]), 2048)
            self.assertEqual(receipt["helperActual"], {"unavailable": "OSError"})

    def test_two_maximum_graph_budgets_preserve_original_reason_inside_existing_export_limit(self):
        graph = {"complete": False, "validationAuthority": False, "evidence": "x" * (M.METADATA_GRAPH_BYTES - 256)}
        with tempfile.TemporaryDirectory() as temporary, patch.object(M, "BASE", Path(temporary).resolve()) as root, \
             patch.object(M, "helper_identity", return_value={"path": M.HELPER}), \
             patch.object(M, "helper_namespace", return_value={"entries": [{"path": "/fixed-" + str(i), "mode": 0o755} for i in range(55)]}), \
             patch.object(M, "helper_metadata", return_value=graph), \
             patch.multiple(M.os, getuid=Mock(return_value=0), geteuid=Mock(return_value=0),
                            getgid=Mock(return_value=0), getegid=Mock(return_value=0), create=True), \
             patch.object(M.subprocess, "run", return_value=subprocess.CompletedProcess([], 2, b'{"reason":"Original helper refusal"}', b"")):
            with self.assertRaisesRegex(RuntimeError, "Finite native inspection refused; no retry"):
                M.tool([M.HELPER, "inspect"], helper_pin={"size": 64, "sha256": "a" * 64})
            file = root / "helper-inspection-failure.json"
            receipt = json.loads(file.read_bytes())
            self.assertLessEqual(file.stat().st_size, 1048576)
            self.assertEqual(receipt["reasonExcerpt"], "Original helper refusal")
            self.assertEqual(receipt["metadataBefore"], graph)
            self.assertEqual(receipt["metadataAfter"], graph)

    def test_helper_identity_is_observed_from_the_fixed_image_not_from_the_expected_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary).resolve() / "helper"
            file.write_bytes(b"synthetic never-executed helper")
            info = file.stat()
            with patch.object(M, "HELPER", str(file)):
                identity = M.helper_identity()
            self.assertEqual(identity["sha256"], M.digest(file.read_bytes()))
            self.assertEqual(identity["size"], info.st_size)
            self.assertEqual(identity["mode"], M.stat.S_IMODE(info.st_mode))
            self.assertEqual(identity["uid"], info.st_uid)
            self.assertEqual(identity["gid"], info.st_gid)

    def test_helper_failure_export_is_two_exact_files_without_wildcard_or_directory_capture(self):
        workflow = (HERE.parent / ".github/workflows/native-linux-production-016-migration.yml").read_text()
        assignment = next(line.strip() for line in workflow.splitlines() if line.lstrip().startswith("names = ["))
        names = ast.literal_eval(assignment.partition(" = ")[2])
        self.assertEqual([name for name in names if "helper-inspection" in name],
                         ["helper-inspection-failure.json", "result/helper-inspection-failure.json"])
        self.assertTrue(all("*" not in name and ".." not in Path(name).parts for name in names))

    def test_manual_exact_workflow_optin_is_independent_of_inspection_mode(self):
        for scenario in M.SCENARIOS:
            self.assertEqual(M.admission(environment(scenario), system="linux", uid=1001), scenario)
        for key, value in (("GITHUB_WORKFLOW_REF", M.WORKFLOW.replace("-migration", "")), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_REF", "refs/heads/main"), ("RUNNER_ENVIRONMENT", "self-hosted"), ("RUNNER_ARCH", "ARM64"),
                           ("CREATOR_MIGRATION_016_EXECUTE", "false"), ("CREATOR_MIGRATION_016_EXECUTE", "1"),
                           ("CREATOR_MIGRATION_016_SCENARIO", "migration-cancel"), ("GITHUB_SHA", ""),
                           ("APPIMAGE", "/tmp/a"), ("LD_PRELOAD", ""), ("PYTHONPATH", ""), ("NODE_OPTIONS", "--inspect")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                M.admission({**environment(), key: value}, system="linux", uid=1001)
        with self.assertRaises(RuntimeError):
            M.admission(environment(), system="win32", uid=1001)

    def test_binding_requires_exact_new_source_features_protocol_and_all_false_inspection_flags(self):
        value = binding()
        self.assertEqual(M.validate_binding(value, "f" * 40), value["profile"])
        mutations = [lambda b: b.update(inspectionOnly=False), lambda b: b.update(migrationAccepted=True),
                     lambda b: b["productionProof"].update(compiledFeatures=["integrated-features"]),
                     lambda b: b["productionProof"].update(sourceTree="0" * 40),
                     lambda b: b["productionProof"]["productionContract"].update(protocolVersion=1),
                     lambda b: b["productionProof"]["productionContract"].update(protocolVersion=True),
                     lambda b: b["productionProof"]["productionContract"].update(nativeAcceptance=True),
                     lambda b: b["productionProof"]["productionContract"].update(externalQualificationRequired=False),
                     lambda b: b["profile"].update(mode="migration-approve"), lambda b: b["api"].update(harnessSource="e" * 40),
                     lambda b: b["packageFiles"].update({"../outside": {"size": 1, "sha256": "a" * 64, "mode": 0o644}}),
                     lambda b: b["packageFiles"][M.P.S.DEB_MEMBERS["helper"]].update(mode=0o777),
                     lambda b: b["resourceFiles"].update({"/outside": "a" * 64}), lambda b: b.update(exec="/bin/true")]
        for index, mutate in enumerate(mutations):
            changed = copy.deepcopy(value); mutate(changed)
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                M.validate_binding(changed, "f" * 40)

    def test_execution_request_binds_scenario_source_workflow_and_original_binding_bytes(self):
        raw = json.dumps(binding()).encode()
        with patch.object(M.sys, "platform", "linux"), patch.object(M.os, "getuid", return_value=1001, create=True):
            request = M.execution_request(environment(), raw)
            self.assertEqual(M.check_request(request, environment(), raw), M.SCENARIOS[0])
            for key, replacement in (("scenario", M.SCENARIOS[1]), ("workflowRef", "other"), ("bindingSha256", "0" * 64),
                                     ("harnessSource", "0" * 40), ("schemaVersion", True), ("extra", True)):
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    M.check_request({**request, key: replacement}, environment(), raw)
            with self.assertRaises(RuntimeError):
                M.check_request(request, environment(), raw + b" ")

    def test_four_actual_scenario_branches_have_finite_order_and_no_followup_on_uncertain_input(self):
        expected = [[("consent", False), ("cancel-check",)], [("consent", True), ("review-connections",), ("mcp", False)],
                    [("consent", True), ("review-connections",), ("mcp", True), ("setup", False)],
                    [("consent", True), ("review-connections",), ("mcp", True), ("setup", True)]]
        for scenario, wanted in zip(M.SCENARIOS, expected):
            events = []
            M.execute_scenario(scenario, lambda approve: events.append(("consent", approve)),
                               lambda target, approve: events.append((target, approve)), lambda: events.append(("cancel-check",)),
                               lambda: events.append(("review-connections",)))
            self.assertEqual(events, wanted)
            for failure in range(len(wanted)):
                events = []
                def step(value):
                    events.append(value)
                    if len(events) == failure + 1:
                        raise RuntimeError("uncertain action")
                with self.assertRaises(RuntimeError):
                    M.execute_scenario(scenario, lambda approve: step(("consent", approve)),
                                       lambda target, approve: step((target, approve)), lambda: step(("cancel-check",)),
                                       lambda: step(("review-connections",)))
                self.assertEqual(events, wanted[:failure + 1])

    def test_unverified_connection_context_binds_exact_clients_beforeimages_and_verified_router(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); before = M.fixture(root); home = root / "home"
            router = home / "verified/router"
            real_read = M.read_file
            def reader(file, *args, **kwargs):
                self.assertEqual(kwargs, {"uid": M.UID, "mode": 0o600})
                return real_read(file, *args)
            with patch.object(M, "read_file", side_effect=reader), patch.object(M, "verified_route", return_value=(router, home / "server")) as verified:
                context = M.connection_review(home, before, binding())
                details = [f"{name}\nCommand: {M.OLD_NODE}\nServer: {M.OLD_SERVER}\nProject kept: {home / 'current-project'}" for name in ("Codex", "Claude Code")]
                self.assertEqual(context["question"], "These existing connections could not be publisher-verified:\n\n" + "\n\n".join(details)
                                 + f"\n\nMove them to the verified Hub router at {router}? Names and ownership markers are not proof. Continue only for your Creator Works connections. Exact backups, client options and other servers are kept. Cancel stops migration before changing any of these clients.")
                self.assertEqual(context["beforeImages"][".claude.json"]["sha256"], M.digest(before[".claude.json"]))
                verified.assert_called_once_with(home, binding())
                for name in (".codex/config.toml", ".claude.json", "config/Claude/claude_desktop_config.json"):
                    file = home / name; file.write_bytes(b"changed")
                    with self.assertRaises(RuntimeError): M.connection_review(home, before, binding())
                    file.write_bytes(before[name])
                extra = home / ".gemini/config/mcp_config.json"; extra.parent.mkdir(parents=True); extra.write_bytes(b"{}")
                with self.assertRaises(RuntimeError): M.connection_review(home, before, binding())

    def test_unverified_native_graph_refuses_other_clients_router_text_buttons_owner_and_extra_labels(self):
        question = "Exact two-client before-images and verified router"
        graph = captured_connection_review_graph(question)
        check = lambda value: M.graph_contract(value, pid=123, title="Warning", question=question, connection_review=True)
        check(graph)
        for mutate in (lambda g: g[6].update(name=question + "\nExtra client"), lambda g: g[6].update(name="Different router"),
                       lambda g: g[0].update(name="Information"), lambda g: g[9].update(name="Move to Hub"),
                       lambda g: g[9].update(pid=999), lambda g: g[9].update(ready=False),
                       lambda g: g.append({**g[6], "reference": [":1.2", "extra"], "name": "Unexpected text"}),
                       lambda g: g.append({**g[9], "reference": [":1.2", "extra"], "name": "Extra action"})):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.assertRaises(RuntimeError): check(bad)

    def test_connection_review_click_is_exactly_once_and_mismatch_or_uncertainty_never_replays(self):
        button, action = Mock(), Mock()
        button.get_action_iface.return_value = action
        action.get_n_actions.return_value = 1; action.get_action_name.return_value = "click"; action.do_action.return_value = True
        profile = {"question": "exact synthetic clients", "beforeImages": {"client": "before"}, "router": "/verified/router", "frame": [0, 0, 50, 50]}
        record = {}; guard = Mock()
        M.approve_connection_review(Mock(return_value=(button, profile)), guard, record)
        action.do_action.assert_called_once_with(0); self.assertEqual(guard.call_count, 4)
        with self.assertRaises(RuntimeError): M.approve_connection_review(Mock(), guard, record)
        for call in (1, 2):
            for key in profile:
                action.do_action.reset_mock()
                changed = {**profile, key: "changed"}; frames = [copy.deepcopy(profile) for _ in range(3)]; frames[call] = changed
                with self.assertRaises(RuntimeError):
                    M.approve_connection_review(Mock(side_effect=[(button, frame) for frame in frames]), Mock(), {})
                action.do_action.assert_not_called()
        action.do_action.return_value = False; action.do_action.reset_mock(); uncertain = {}
        with self.assertRaises(RuntimeError): M.approve_connection_review(Mock(return_value=(button, profile)), Mock(), uncertain)
        self.assertEqual(uncertain["actionAttempts"], 1)
        with self.assertRaises(RuntimeError): M.approve_connection_review(Mock(), Mock(), uncertain)
        action.do_action.assert_called_once_with(0)

    def test_original_authority_and_logind_session_are_revalidated_after_broker_wait_before_any_input(self):
        native = M.load("native-linux-polkit-probe")
        for kind in ("cancel", "authenticate"):
            for changed_peer in ("authority", "parent-session", "agent-session", "root-session"):
                for replacement_wait in ((0, 1, 3, 5) if kind == "authenticate" else (0, 1, 3)):
                    with self.subTest(kind=kind, peer=changed_peer, replacement_wait=replacement_wait):
                        s, sdk = Mock(), Mock(); s.owned = {"pid": 30}; p = s.polkit
                        endpoint = {"owner": ":1.2", "pid": 20, "uid": M.UID, "authority": {"owner": ":1.1", "pid": 1, "uid": 0}}
                        original_session = {"object": "/session/original", "Id": "c1", "Leader": 10, "User": [M.UID, "/user"]}
                        state = {"authority": copy.deepcopy(endpoint["authority"]), "sessions": {pid: copy.deepcopy(original_session) for pid in (10, 20, 30)}}
                        p.bus_identity.side_effect = lambda _bus, name, _glib: state["authority"] if name == "org.freedesktop.PolicyKit1" else {k: endpoint[k] for k in ("owner", "pid", "uid")}
                        p.session.side_effect = lambda _bus, pid, _glib: state["sessions"][pid]
                        a = M.Authorization(s, Mock(), {"pid": 20}, {"pid": 10}, endpoint, Mock(), Mock(), Mock(), "question", [0], sdk, original_session)
                        def replace():
                            if changed_peer == "authority": state["authority"] = {**state["authority"], "owner": ":1.99"}
                            else: state["sessions"][{"parent-session": 10, "agent-session": 20, "root-session": 30}[changed_peer]]["Leader"] = 999
                        waits = [0]
                        def waited(_check):
                            waits[0] += 1
                            if waits[0] == replacement_wait: replace()
                        s.pages.wait.side_effect = waited
                        if replacement_wait == 0: replace()
                        def proof(*_args, **_kwargs):
                            return json.dumps({"request": {"index": a.counter[0], "target": "mcp"}, "ok": True, "proof": {"root": s.owned, "target": "mcp"}}).encode()
                        button, password = Mock(), Mock()
                        password.get_editable_text_iface.return_value.set_text_contents.return_value = True
                        profile = Mock(return_value=((password, button), {"selectedIdentityVerified": True, "selectedIdentity": M.USER}) if kind == "authenticate" else (button, {}))
                        record = {"mode": kind}
                        with patch.dict(M.os.environ, {"CREATOR_MIGRATION_016_SCENARIO": M.SCENARIOS[3]}), patch.object(M, "publish") as publish, patch.object(M, "read_file", side_effect=proof):
                            with self.assertRaises(RuntimeError):
                                if kind == "authenticate": native.authenticate_once(profile, lambda: a.input_guard("mcp", record), record, bytearray(b"a" * 64))
                                else: native.cancel_once(profile, lambda: a.input_guard("mcp", record), record)
                        if replacement_wait <= 1: profile.assert_not_called()
                        button.get_action_iface.assert_not_called()
                        # A replacement after the valid password write must
                        # still prevent the later Authenticate input.
                        self.assertEqual(password.get_editable_text_iface.return_value.set_text_contents.call_count,
                                         1 if kind == "authenticate" and replacement_wait == 5 else 0)
                        self.assertEqual(publish.call_count, replacement_wait)
                        p.own_agent.assert_called()  # The held agent itself never changed.

    def test_each_successful_authentication_guard_rechecks_both_sides_of_the_kernel_proof_wait(self):
        native = M.load("native-linux-polkit-probe")
        s, sdk = Mock(), Mock(); s.owned = {"pid": 30}; p = s.polkit
        endpoint = {"owner": ":1.2", "pid": 20, "uid": M.UID, "authority": {"owner": ":1.1", "pid": 1, "uid": 0}}
        original = {"object": "/session/original", "Leader": 10}
        p.bus_identity.side_effect = lambda _bus, name, _glib: endpoint["authority"] if name == "org.freedesktop.PolicyKit1" else {k: endpoint[k] for k in ("owner", "pid", "uid")}
        p.session.return_value = original
        a = M.Authorization(s, Mock(), {"pid": 20}, {"pid": 10}, endpoint, Mock(), Mock(), Mock(), "question", [0], sdk, original)
        def proof(*_args, **_kwargs):
            return json.dumps({"request": {"index": a.counter[0], "target": "mcp"}, "ok": True, "proof": {"root": s.owned, "target": "mcp"}}).encode()
        password, button, action = Mock(), Mock(), Mock()
        password.get_editable_text_iface.return_value.set_text_contents.return_value = True
        button.get_action_iface.return_value = action
        action.get_n_actions.return_value = 1; action.get_action_name.return_value = "click"; action.do_action.return_value = True
        profile = Mock(return_value=((password, button), {"selectedIdentityVerified": True, "selectedIdentity": M.USER}))
        with patch.dict(M.os.environ, {"CREATOR_MIGRATION_016_SCENARIO": M.SCENARIOS[3]}), patch.object(M, "publish") as publish, patch.object(M, "read_file", side_effect=proof):
            native.authenticate_once(profile, lambda: a.input_guard("mcp", {}), {"mode": "authenticate"}, bytearray(b"a" * 64))
        self.assertEqual(publish.call_count, 5)
        self.assertEqual(sum(call.args[1] == "org.freedesktop.PolicyKit1" for call in p.bus_identity.call_args_list), 10)
        self.assertEqual(p.session.call_count, 30)
        password.get_editable_text_iface.return_value.set_text_contents.assert_called_once(); action.do_action.assert_called_once_with(0)

    def test_observed_journal_delta_retains_both_refusals_in_existing_failure_report_before_assertion(self):
        first = {"revision": 1, "records": records("a", ["load_config", "discover_unity_projects"], [3, 4])}
        for phase, previous in (("first", {"revision": 1, "records": []}), ("reopened", first)):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                report, raw = {"scenarioPassed": False, **M.FLAGS}, json.dumps(previous).encode()
                original = M.journal_delta
                def check(old, current, **kwargs):
                    captured = report["operationJournals"][phase]
                    self.assertEqual(captured["file"], {"size": len(raw), "sha256": M.digest(raw)})
                    self.assertEqual(captured["previous"]["count"], len(previous["records"]))
                    self.assertEqual(captured["current"]["count"], len(previous["records"]))
                    self.assertTrue(captured["prefixEqual"]); self.assertEqual(captured["appendCount"], 0)
                    return original(old, current, **kwargs)
                with patch.object(M, "read_file", return_value=raw) as read, patch.object(M, "journal_delta", side_effect=check):
                    with self.assertRaisesRegex(RuntimeError, "Unexpected operation journal append count"):
                        try:
                            M.observed_journal_delta(previous, home, report, phase)
                        finally:
                            M.save(home / "report.json", report)
                read.assert_called_once_with(home / M.JOURNAL, 65536, uid=M.UID)
                self.assertEqual(json.loads((home / "report.json").read_bytes()), report)
                self.assertFalse(report["scenarioPassed"])
                self.assertTrue(all(report[key] is False for key in M.FLAGS))

    def test_observed_journal_delta_redacts_unknown_metadata_and_bounds_records_without_exporting_payloads(self):
        previous = {"revision": 1, "records": []}
        rows = records("a", ["save_config"] * 40, list(range(1, 41)))
        rows[0].update(outcome="accepted", args={"privateArgument": "argument-secret"}, result="result-secret")
        rows[1].update(session="session-secret", id=True, command="command-secret", outcome="outcome-secret")
        rows[2] = "record-secret"
        rows[3].update(id=9_007_199_254_740_992)
        current = {"revision": 1, "records": rows, "client-secret": {"tls": "tls-secret"}}
        raw, report = json.dumps(current).encode(), {}
        with patch.object(M, "read_file", return_value=raw):
            with self.assertRaises(RuntimeError):
                M.observed_journal_delta(previous, Path("/synthetic/home"), report, "first")
        captured = report["operationJournals"]["first"]
        self.assertEqual((captured["current"]["count"], len(captured["current"]["records"]), captured["current"]["omittedRecords"]), (40, 32, 8))
        self.assertEqual(captured["appendCount"], 40); self.assertTrue(captured["prefixEqual"])
        known, unknown, invalid, oversized = captured["current"]["records"][:4]
        self.assertEqual((known["command"], known["outcome"], known["session"], known["id"]), ("save_config", "accepted", "a" * 64, 1))
        self.assertFalse(known["shapeValid"]); self.assertEqual(invalid, {"shapeValid": False})
        self.assertIsNone(unknown["session"]); self.assertIsNone(unknown["id"]); self.assertIsNone(oversized["id"])
        for key in ("command", "outcome"):
            self.assertEqual(unknown[key], {"redacted": True, "sha256": M.digest((key + "-secret").encode())})
        encoded = json.dumps(report)
        for secret in ("argument-secret", "result-secret", "session-secret", "command-secret", "outcome-secret", "record-secret", "client-secret", "tls-secret", "privateArgument"):
            self.assertNotIn(secret, encoded)
        self.assertLess(len(encoded), 32768); self.assertTrue(captured["diagnosticOnly"])
        self.assertFalse(captured["validationAuthority"])

    def test_observed_journal_delta_keeps_exact_success_and_does_not_swallow_any_oracle_refusal(self):
        previous = {"revision": 1, "records": records("a", ["load_config", "discover_unity_projects"], [3, 4])}
        good = {"revision": 1, "records": previous["records"] + records("b", ["load_config", "discover_unity_projects"], [3, 4])}
        cases = [good, previous, {"revision": 1, "records": good["records"] + records("b", ["save_config"], [5])}]
        for key, value in (("id", 5), ("command", "save_config"), ("outcome", "returned-error"), ("session", "a" * 64)):
            bad = copy.deepcopy(good); bad["records"][-1][key] = value; cases.append(bad)
        bad = copy.deepcopy(good); bad["records"][0]["outcome"] = "returned-error"; cases.append(bad)
        for index, current in enumerate(cases):
            with self.subTest(index=index), patch.object(M, "read_file", return_value=json.dumps(current).encode()):
                report = {}
                if index == 0:
                    self.assertEqual(M.observed_journal_delta(previous, Path("/synthetic/home"), report, "reopened"), good)
                else:
                    with self.assertRaises(RuntimeError) as expected: M.journal_delta(previous, current)
                    with self.assertRaises(RuntimeError) as actual: M.observed_journal_delta(previous, Path("/synthetic/home"), report, "reopened")
                    self.assertEqual(str(actual.exception), str(expected.exception))
                self.assertEqual(report["operationJournals"]["reopened"]["prefixEqual"], current["records"][:len(previous["records"])] == previous["records"])

    def test_journal_diagnostic_allowlists_are_only_the_typed_public_command_and_outcome_names(self):
        source = HERE.parent / "modules/mcp/launcher/src-tauri/src"
        commands = (source / "hosted_commands.rs").read_text(encoding="utf-8").split("pub const COMMANDS: &[&str] = &[", 1)[1].split("];", 1)[0]
        self.assertEqual(M.JOURNAL_COMMANDS, frozenset(re.findall(r'"([a-z_]+)"', commands)))
        outcomes = (source / "hosted_journal.rs").read_text(encoding="utf-8").split("enum Outcome {", 1)[1].split("}", 1)[0]
        expected = {re.sub(r"(?<!^)([A-Z])", r"-\1", value).lower() for value in re.findall(r"\b([A-Z][A-Za-z]+),", outcomes)}
        self.assertEqual(M.JOURNAL_OUTCOMES, frozenset(expected))

    def test_run_session_captures_both_deltas_inside_the_existing_failure_report_finally(self):
        tree = ast.parse((HERE / "native-linux-production-016-migration.py").read_text(encoding="utf-8"))
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run_session")
        owner = next(node for node in run.body if isinstance(node, ast.Try) and node.finalbody)
        calls = [node for node in ast.walk(owner) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "observed_journal_delta"]
        self.assertEqual(len(calls), 2)
        self.assertEqual([node.args[3].value for node in calls], ["first", "reopened"])
        self.assertEqual([ast.unparse(node.args[0]) for node in calls], ["baseline", "current"])
        self.assertTrue(all(ast.unparse(node.args[1]) == "home" and ast.unparse(node.args[2]) == "report" for node in calls))
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "journal_delta" for node in ast.walk(run)))
        saved = [node for statement in owner.finalbody for node in ast.walk(statement)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "save"]
        self.assertEqual([(ast.unparse(node.args[0]), ast.unparse(node.args[1])) for node in saved], [("root / 'report.json'", "report")])

    def test_cancel_journal_requires_original_semantics_bytes_and_pin_in_both_phases(self):
        for baseline in ({"revision": 1, "records": []}, {"revision": 1, "records": records("a", ["save_config"], [2])}):
            raw, report = json.dumps(baseline).encode(), {}
            with patch.object(M, "read_file", return_value=raw) as read, patch.object(M, "journal_delta", side_effect=AssertionError("Cancel cannot use the append oracle")):
                for phase in ("first", "reopened"):
                    self.assertEqual(M.observed_cancel_journal(baseline, raw, Path("/synthetic/home"), report, phase), baseline)
                    captured = report["operationJournals"][phase]
                    self.assertEqual(captured["file"], {"size": len(raw), "sha256": M.digest(raw)})
                    self.assertTrue(captured["prefixEqual"]); self.assertEqual(captured["appendCount"], 0)
                    self.assertEqual(captured["current"]["records"], captured["previous"]["records"])
            self.assertEqual(read.call_count, 2)
            self.assertTrue(all(call.args == (Path("/synthetic/home") / M.JOURNAL, 65536) and call.kwargs == {"uid": M.UID} for call in read.call_args_list))

    def test_cancel_journal_rejects_any_append_changed_old_records_and_reformatted_bytes_after_capture(self):
        empty = {"revision": 1, "records": []}
        old = {"revision": 1, "records": records("a", ["save_config"], [2])}
        cases = [(empty, {"revision": 1, "records": [{**row, "outcome": outcome} for row in records("b", ["save_config"], [3])]})
                 for outcome in (*sorted(M.JOURNAL_OUTCOMES), "unsupported-outcome")]
        cases.append((empty, {"revision": 1, "records": records("b", ["load_config", "discover_unity_projects"], [3, 4])}))
        for key, value in (("id", 3), ("session", "b" * 64), ("command", "load_config"), ("outcome", "accepted")):
            changed = copy.deepcopy(old); changed["records"][0][key] = value; cases.append((old, changed))
        for phase in ("first", "reopened"):
            for baseline, changed in cases:
                with self.subTest(phase=phase, changed=changed), patch.object(M, "read_file", return_value=json.dumps(changed).encode()):
                    report = {}
                    with self.assertRaisesRegex(RuntimeError, "Guide cancellation changed operation journal records"):
                        M.observed_cancel_journal(baseline, json.dumps(baseline).encode(), Path("/synthetic/home"), report, phase)
                    self.assertIn(phase, report["operationJournals"])
            for raw in (json.dumps(empty, separators=(",", ":")).encode(), json.dumps(empty).encode() + b"\n"):
                with self.subTest(phase=phase, raw=raw), patch.object(M, "read_file", return_value=raw):
                    report = {}
                    with self.assertRaisesRegex(RuntimeError, "Guide cancellation changed original operation journal bytes or file pin"):
                        M.observed_cancel_journal(empty, json.dumps(empty).encode(), Path("/synthetic/home"), report, phase)
                    captured = report["operationJournals"][phase]
                    self.assertEqual(captured["appendCount"], 0); self.assertTrue(captured["prefixEqual"])
                    self.assertEqual(captured["file"], {"size": len(raw), "sha256": M.digest(raw)})

    def test_only_initial_guide_cancel_uses_exact_original_journal_checks_on_both_roots(self):
        tree = ast.parse((HERE / "native-linux-production-016-migration.py").read_text(encoding="utf-8"))
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run_session")
        branches = [node for node in ast.walk(run) if isinstance(node, ast.If)
                    and any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "observed_cancel_journal"
                            for statement in node.body for call in ast.walk(statement))]
        self.assertEqual(len(branches), 2)
        for branch, phase, previous in zip(branches, ("first", "reopened"), ("baseline", "current")):
            self.assertEqual(ast.unparse(branch.test), "scenario == SCENARIOS[0]")
            calls = [node for statement in branch.body for node in ast.walk(statement) if isinstance(node, ast.Call)]
            cancel = [node for node in calls if isinstance(node.func, ast.Name) and node.func.id == "observed_cancel_journal"]
            self.assertEqual(len(cancel), 1)
            self.assertEqual([ast.unparse(arg) for arg in cancel[0].args[:4]], ["baseline", "before[JOURNAL]", "home", "report"])
            self.assertEqual(cancel[0].args[4].value, phase)
            other = [node for statement in branch.orelse for node in ast.walk(statement)
                     if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "observed_journal_delta"]
            self.assertEqual(len(other), 1)
            self.assertEqual(ast.unparse(other[0].args[0]), previous)
            self.assertEqual(other[0].args[3].value, phase)

    def test_guide_cancel_allows_only_two_completed_reads_per_new_root_and_preserves_prefix(self):
        empty = {"revision": 1, "records": []}
        first = {"revision": 1, "records": records("a", ["load_config", "discover_unity_projects"], [3, 4])}
        second = {"revision": 1, "records": first["records"] + records("b", ["load_config", "discover_unity_projects"], [3, 4])}
        M.journal_delta(empty, first); M.journal_delta(first, second)
        mutations = [lambda v: v["records"].pop(), lambda v: v["records"].append(dict(v["records"][-1])),
                     lambda v: v["records"][0].update(command="apply_client_config"),
                     lambda v: v["records"][0].update(outcome="unknown"), lambda v: v["records"][0].update(id=True),
                     lambda v: v["records"][1].update(id=5), lambda v: v["records"][1].update(session="b" * 64),
                     lambda v: v.update(revision=True), lambda v: v.update(extra=1)]
        for mutate in mutations:
            bad = copy.deepcopy(first); mutate(bad)
            with self.assertRaises(RuntimeError): M.journal_delta(empty, bad)
        bad = copy.deepcopy(second); bad["records"][0]["outcome"] = "returned-error"
        with self.assertRaises(RuntimeError): M.journal_delta(first, bad)
        repeated = {"revision": 1, "records": first["records"] * 2}
        with self.assertRaises(RuntimeError): M.journal_delta(first, repeated)

    def test_transfer_journal_has_only_source_defined_completed_commands_then_exact_reopen_reads(self):
        names = ["review_existing_client_connections", "review_convergence_server", "load_config", "discover_unity_projects"]
        first = {"revision": 1, "records": records("a", names, [2, 3, 7, 8])}
        M.journal_delta({"revision": 1, "records": []}, first, transferred=True)
        second = {"revision": 1, "records": first["records"] + records("b", names[-2:], [3, 4])}
        M.journal_delta(first, second)
        for index in range(4):
            bad = copy.deepcopy(first); bad["records"][index]["command"] = "unexpected"
            with self.assertRaises(RuntimeError): M.journal_delta({"revision": 1, "records": []}, bad, transferred=True)

    def test_scenario_package_states_do_not_treat_partial_cleanup_as_rollback_or_completion(self):
        self.assertEqual([M.retention_state(s) for s in M.SCENARIOS], [(False, False), (False, False), (True, False), (True, True)])
        with self.assertRaises(RuntimeError): M.retention_state("all")

    def test_inspections_require_production_protocol_exact_types_counts_and_target(self):
        for target in ("mcp", "setup"):
            for retained in (False, True):
                other = "setup" if target == "mcp" else "mcp"
                value = {"protocolVersion": 2, "cohort": "creator-hub-deb-retirement-016-v1", "mode": "production",
                         "status": "inspected-retained-read-only" if retained else "inspected-read-only", "nativeAcceptance": False,
                         "externalQualificationRequired": True, "product": target,
                         "package": "creator-works-mcp" if target == "mcp" else "creator-project-setup",
                         "packageState": "compatibility" if retained else "original",
                         "version": (M.MCP_VERSION if target == "mcp" else M.SETUP_VERSION) if retained else ("2.7.7" if target == "mcp" else "0.3.7"),
                         "readOnly": True, "baselineMatches": not retained, "compatibilityMatches": retained,
                         "snapshotAuthoritative": False, "packageTransactionStarted": False,
                         "retainedFilesVerified": 9 if retained and target == "mcp" else 0,
                         "tombstoneFilesVerified": 1 if retained and target == "setup" else 0,
                         "omittedFilesVerified": 5 if retained else 0}
                M.inspection(value, target, retained)
                with self.assertRaises(RuntimeError): M.inspection(value, other, retained)
                for key, bad in (("protocolVersion", 1), ("nativeAcceptance", True), ("packageTransactionStarted", True),
                                 ("retainedFilesVerified", True), ("omittedFilesVerified", 6), ("extra", False)):
                    with self.subTest(target=target, retained=retained, key=key), self.assertRaises(RuntimeError):
                        M.inspection({**value, key: bad}, target, retained)

    def test_route_verifies_actual_minisig_names_generation_and_every_bound_payload(self):
        home = Path("/synthetic/home")
        base = home / "data/creator-hub"
        resource = {"mcp/server/creator-works-mcp.mjs": b"synthetic server", "mcp/server/runtime/node": b"synthetic node"}
        module = {"executable": "mcp/creator-works-mcp-launcher", "version": "2.7.7",
                  "files": {name: M.digest(raw) for name, raw in resource.items()}}
        generation = M.digest(json.dumps({**module, "files": dict(sorted(module["files"].items()))}, separators=(",", ":")).encode())
        runtime = json.dumps({"module": module}).encode()
        resource.update({"routing/runtime.json": runtime, "routing/runtime.minisig": b"synthetic runtime signature",
                         "routing/router.json": json.dumps({"sha256": M.digest(b"synthetic router")}).encode(),
                         "routing/router.minisig": b"synthetic router signature"})
        active = {"schemaVersion": 1, "descriptorSha256": M.digest(runtime), "generation": generation}
        route = base / "mcp-route-v1/linux-x86_64"
        files = {route / "active.json": json.dumps(active).encode(),
                 route / "router-v1/creator-hub-mcp-router": b"synthetic router"}
        for name, raw in resource.items():
            destination = (route / "descriptors" / active["descriptorSha256"] / name.removeprefix("routing/") if name.startswith("routing/runtime") else
                           route / "router-v1" / name.removeprefix("routing/") if name.startswith("routing/router") else
                           base / "runtime-generations/linux-x86_64" / generation / name)
            files[destination] = raw
        pins = {"resourceFiles": {name: M.digest(raw) for name, raw in resource.items()}}
        def reader(file, *_args, **_kwargs):
            return files[file]
        with patch.object(M, "read_file", side_effect=reader):
            router, server = M.verified_route(home, pins)
            self.assertEqual(router, route / "router-v1/creator-hub-mcp-router")
            self.assertEqual(server, base / "runtime-generations/linux-x86_64" / generation / "mcp/server/creator-works-mcp.mjs")
            for name in list(files):
                if name.name == "active.json": continue
                original = files[name]; files[name] = b"changed"
                with self.subTest(path=str(name)), self.assertRaises((RuntimeError, ValueError)):
                    M.verified_route(home, pins)
                files[name] = original

    def test_pending_kernel_request_is_target_specific_not_historical_sealed_dpkg(self):
        for target, argument in (("mcp", "retire-mcp-2.7.7"), ("setup", "retire-setup-0.3.7")):
            raw = b"\0".join(v.encode() for v in ("/usr/bin/pkexec", "--disable-internal-agent", M.HELPER, argument)) + b"\0"
            M.pending_command(raw, target)
            for bad in (raw + b"extra\0", raw.replace(b"--disable-internal-agent\0", b""), raw.replace(argument.encode(), b"inspect"),
                        b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0"):
                with self.assertRaises(RuntimeError): M.pending_command(bad, target)
        with self.assertRaises(RuntimeError): M.proof_request({"index": 1, "target": "mcp"}, M.SCENARIOS[0])
        with self.assertRaises(RuntimeError): M.proof_request({"index": 1, "target": "setup"}, M.SCENARIOS[1])
        for value in ({"index": True, "target": "mcp"}, {"index": 49, "target": "mcp"}, {"index": 1, "target": "mcp", "command": "other"}):
            with self.assertRaises(RuntimeError): M.proof_request(value, M.SCENARIOS[3])

    def test_policy_remains_uncached_admin_and_fixed_helper(self):
        raw = (HERE.parent / "packaging/linux/com.creatorworks.hub.deb-retirement.production-016.policy").read_bytes()
        self.assertIn("user settings and Unity projects will be kept", M.policy_question(raw))
        for bad in (raw.replace(b"auth_admin", b"yes"), raw.replace(b"auth_admin", b"auth_admin_keep"), raw.replace(M.HELPER.encode(), b"/bin/sh")):
            with self.assertRaises(RuntimeError): M.policy_question(bad)

    def test_native_ax_graph_real_list_references_keep_reverse_parent_and_owner_guards(self):
        native = M.load("native-linux-root-probe")
        owner = SimpleNamespace(root={"pid": 123, "uids": [M.UID] * 4}, renderer=None, node=Mock())
        app = SimpleNamespace(app=SimpleNamespace(bus_name=":1.7"), path="/org/a11y/atspi/accessible/root",
                              get_process_id=lambda: 123)
        other = SimpleNamespace(app=app.app, path="/org/a11y/atspi/accessible/other", get_process_id=lambda: 123)
        states = SimpleNamespace(contains=lambda key: key in ("SHOWING", "ENABLED", "SENSITIVE"))
        dialog = SimpleNamespace(app=app.app, path="/org/a11y/atspi/accessible/dialog", get_process_id=lambda: 123,
                                 get_role=lambda: 2, clear_cache=lambda: None, get_parent=lambda: app,
                                 get_state_set=lambda: states, get_name=lambda: "Information",
                                 get_component_iface=lambda: SimpleNamespace(get_extents=lambda _: SimpleNamespace(x=0, y=0, width=200, height=100)))
        desktop = object()
        helper = SimpleNamespace(fresh_close_children=lambda node, limit: [app] if node is desktop else [dialog] if node is app else [])
        atspi = SimpleNamespace(get_desktop=lambda _: desktop, Role=SimpleNamespace(ALERT=2, DIALOG=16, PASSWORD_TEXT=40),
                                StateType=SimpleNamespace(**{key: key for key in ("EDITABLE", "SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}),
                                CoordType=SimpleNamespace(SCREEN=0))
        refs = native.AxReferences(lambda _: {"owner": ":1.7", "pid": 123, "uid": M.UID})
        parent = refs.identity(app, owner)
        self.assertIsInstance(parent, list)
        graph, nodes = M.ax_graph(atspi, helper, native, refs, owner, (0, 0, 200, 100))
        self.assertEqual(graph[0]["parent"], parent)
        self.assertEqual(nodes, [dialog]); owner.node.assert_called_once_with(dialog)
        for actual in (None, other):
            with self.subTest(parent=actual):
                dialog.get_parent = lambda actual=actual: actual
                with self.assertRaisesRegex(RuntimeError, "Native reverse parent changed"):
                    M.ax_graph(atspi, helper, native, refs, owner, (0, 0, 200, 100))
        dialog.get_parent = lambda: app
        dialog.get_process_id = lambda: 999
        with self.assertRaisesRegex(RuntimeError, "AX graph escaped native owner/bounds"):
            M.ax_graph(atspi, helper, native, refs, owner, (0, 0, 200, 100))
        dialog.get_process_id = lambda: 123
        owner.node.side_effect = RuntimeError("Synthetic owner guard refused")
        with self.assertRaisesRegex(RuntimeError, "Synthetic owner guard refused"):
            M.ax_graph(atspi, helper, native, refs, owner, (0, 0, 200, 100))

    def test_native_guide_graph_requires_source_question_owner_buttons_and_readiness(self):
        question = M.GUIDE + M.GUIDE_SUMMARY + M.GUIDE_END
        graph = [{"reference": [":1.2", str(i)], "parent": [":1.2", "app" if i == 0 else "0"], "pid": 123,
                  "role": role, "name": name, "ready": True} for i, (role, name) in enumerate(
                      [(2, "Information"), (29, question), (43, "Move to Hub"), (43, "Not now")])]
        M.graph_contract(graph, pid=123, title="Information", question=question)
        for mutate in (lambda v: v[1].update(pid=999), lambda v: v[1].update(name="wrong question"),
                       lambda v: v[2].update(name="Install"), lambda v: v[2].update(ready=False),
                       lambda v: v[1].update(parent=[":other", "/outside"]), lambda v: v[1].update(role=40),
                       lambda v: v[2].update(reference=v[1]["reference"])):
            bad = copy.deepcopy(graph); mutate(bad)
            with self.assertRaises(RuntimeError): M.graph_contract(bad, pid=123, title="Information", question=question)
        for bounds in ((-1, 0, 1, 1), (0, 0, 0, 10), (1, 1, 1000, 10), (False, 0, 1, 1)):
            with self.assertRaises(RuntimeError): M.inside(bounds, (0, 0, 100, 100))

    def test_pre_map_empty_inventory_is_not_an_error_or_an_ownership_bypass(self):
        self.assertEqual(M.startup_inventory(None), [])
        self.assertEqual(M.startup_inventory((33, 32, [])), [])
        self.assertEqual(M.startup_inventory((33, 32, [42])), [42])
        for value in ((33, 32, [42, 43]), (1, 32, [42]), (33, 8, [42]), (33, 32, [True]), (33, 32, [0]), []):
            with self.assertRaises(RuntimeError): M.startup_inventory(value)

    def test_native_process_guard_rejects_legacy_gui_and_host_backend_but_allows_private_node(self):
        for image, command in ((M.OLD_NODE, [M.OLD_NODE, M.OLD_SERVER]),
                               ("/usr/bin/creator-hub", ["/usr/bin/creator-hub"]),
                               ("/memfd:creator-node (deleted)", ["node", "/proc/self/fd/9"])):
            M.no_legacy_backend({"executable": image}, b"\0".join(value.encode() for value in command) + b"\0")
        for image, command in (("/usr/bin/creator-works-mcp-launcher", b"launcher\0"),
                               ("/usr/bin/creator-project-setup", b"setup\0"),
                               ("/memfd:creator-works-mcp-launcher (deleted)", b"module\0"),
                               ("/memfd:module (deleted)", b"module\0--creator-hub-host\0"),
                               (M.OLD_NODE, b"node\0--creator-hub-host\0")):
            with self.subTest(image=image), self.assertRaises(RuntimeError):
                M.no_legacy_backend({"executable": image}, command)
        for command in (b"", b"unterminated", b"x" * 8192 + b"\0"):
            with self.assertRaises(RuntimeError): M.no_legacy_backend({"executable": M.OLD_NODE}, command)

    @contextmanager
    def finished_home_fixture(self, *, reopened=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / ("reopened" if reopened else "first")
            root.mkdir(mode=0o700)
            width, height = 560, 480
            row = b"\0" + b"".join(bytes((x % 256, x * 3 % 256, x * 7 % 256)) for x in range(width))
            def chunk(name, raw):
                return struct.pack(">I", len(raw)) + name + raw + struct.pack(">I", zlib.crc32(name + raw))
            png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                   + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b""))
            state = SimpleNamespace(events=[], fault=None, error=None, identity="original", windows=[42], png=png)
            session = M.Session.__new__(M.Session)
            session.root, session.evidence = root, {}
            session.request, session.window = SimpleNamespace(window=42), 42
            session.xres = {"pid": 123, "client": 17, "title": M.TITLE, "mapped": True}
            state.xres = copy.deepcopy(session.xres)
            session.x11, session.dialogs = Mock(), set()
            def process_guard():
                state.events.append("guard")
                M.require(state.identity == "original", "Synthetic Root identity changed")
            session.process_guard = process_guard
            session.helper = SimpleNamespace(bound_window=lambda *_: copy.deepcopy(state.xres))
            def take(request, folder, helper, x11):
                self.assertIs(request, session.request); self.assertIs(helper, session.helper); self.assertIs(x11, session.x11)
                self.assertEqual(folder, root / "home-bitmap"); self.assertEqual(state.events, ["home", "guard"])
                state.events.append("bitmap")
                if state.error is not None:
                    raise state.error
                file = folder / "root-window.png"
                file.write_bytes(png); file.chmod(0o600)
                result = {"nonblank": True, "windowOnly": True, "xid": 42, "xres": copy.deepcopy(session.xres),
                          "width": width, "height": height, "rectangle": (0, 0, width, height),
                          "image": {"size": len(png), "sha256": M.digest(png)}}
                if state.fault == "blank": result["nonblank"] = False
                if state.fault == "foreign-xid": result["xid"] = 43
                if state.fault == "foreign-xres": result["xres"]["client"] += 1
                if state.fault == "wrong-size": result["image"]["size"] += 1
                if state.fault == "wrong-hash": result["image"]["sha256"] = "0" * 64
                if state.fault == "wrong-dimensions": result["width"] += 1
                if state.fault == "wrong-rectangle": result["rectangle"] = (0, 0, width + 1, height)
                if state.fault == "missing": file.unlink()
                if state.fault == "changed-image": file.write_bytes(png + b"changed")
                if state.fault == "after-identity": state.identity = "replacement"
                if state.fault == "after-xres": state.xres["client"] += 1
                if state.fault == "after-window": state.windows.append(43)
                return result
            session.native = SimpleNamespace(bitmap=Mock(side_effect=take), client_ids=lambda _: state.windows)
            session.d = SimpleNamespace(read=Mock(side_effect=lambda selector, endpoint="text":
                "all" if selector == "#project-sdk" else None if endpoint == "attribute/open" else "false"),
                elements=Mock(return_value=["selected"]), click=Mock(),
                call=Mock(side_effect=RuntimeError("WebDriver screenshot transport must not be used")))
            session.pages = SimpleNamespace(wait=lambda check, *args: M.require(bool(check()), "Synthetic UI not ready"),
                                            png_dimensions=M.load("native-linux-integrated-pages").png_dimensions)
            def home(driver, folder):
                self.assertIs(driver, session.d); self.assertEqual(folder, M.BASE / "result/home")
                state.events.append("home")
                return {"platform": "Linux", "fixtureOnly": True}
            original_read = M.read_file
            def read(file, limit, **kwargs):
                self.assertEqual(kwargs, {"uid": M.UID, "mode": 0o600})
                # Pure temporary files do not belong to the native fixture UID.
                return original_read(file, limit)
            state.session = session
            with patch.object(M, "home_observation", side_effect=home), patch.object(M, "read_file", side_effect=read):
                yield state

    def test_finish_ui_retains_guarded_native_bitmap_at_existing_first_and_reopened_exports(self):
        for reopened in (False, True):
            with self.subTest(reopened=reopened), self.finished_home_fixture(reopened=reopened) as f:
                M.finish_ui(f.session, M.SCENARIOS[0], reopened=reopened)
                self.assertEqual(f.events, ["home", "guard", "bitmap", "guard"])
                f.session.native.bitmap.assert_called_once(); f.session.d.call.assert_not_called()
                self.assertEqual((f.session.root / "home.png").read_bytes(), f.png)
                self.assertEqual((f.session.root / "home-bitmap/root-window.png").read_bytes(), f.png)
                evidence = f.session.evidence["homeScreenshot"]
                self.assertEqual((evidence["size"], evidence["sha256"], evidence["dimensions"]),
                                 (len(f.png), M.digest(f.png), (560, 480)))
                self.assertTrue(evidence["nativeBitmap"]["nonblank"])
                self.assertEqual(f.session.d.click.call_args_list, [] if reopened else [unittest.mock.call("#convergence-later")])

    def test_finish_ui_bitmap_failure_never_retries_falls_back_or_accepts_missing_pixels(self):
        with self.finished_home_fixture() as f:
            original = RuntimeError("Owned drawable capture refused")
            f.error = original
            with self.assertRaises(RuntimeError) as raised:
                M.finish_ui(f.session, M.SCENARIOS[0])
            self.assertIs(raised.exception, original)
            f.session.native.bitmap.assert_called_once(); f.session.d.call.assert_not_called()
            self.assertNotIn("homeScreenshot", f.session.evidence)
            self.assertFalse((f.session.root / "home.png").exists())
        for fault in ("blank", "foreign-xid", "foreign-xres", "wrong-size", "wrong-hash", "wrong-dimensions",
                      "wrong-rectangle", "missing", "changed-image"):
            with self.subTest(fault=fault), self.finished_home_fixture() as f:
                f.fault = fault
                with self.assertRaises((RuntimeError, FileNotFoundError)):
                    M.finish_ui(f.session, M.SCENARIOS[0])
                f.session.native.bitmap.assert_called_once(); f.session.d.call.assert_not_called()
                self.assertNotIn("homeScreenshot", f.session.evidence)
                self.assertFalse((f.session.root / "home.png").exists())

    def test_finish_ui_bitmap_checks_real_session_identity_and_root_window_guards_before_and_after(self):
        for fault in ("before-identity", "before-xres", "before-window", "after-identity", "after-xres", "after-window"):
            with self.subTest(fault=fault), self.finished_home_fixture() as f:
                f.fault = fault
                if fault == "before-identity": f.identity = "replacement"
                if fault == "before-xres": f.xres["client"] += 1
                if fault == "before-window": f.windows.append(43)
                with self.assertRaises(RuntimeError):
                    M.finish_ui(f.session, M.SCENARIOS[0])
                self.assertEqual(f.session.native.bitmap.call_count, 0 if fault.startswith("before-") else 1)
                f.session.d.call.assert_not_called()
                self.assertNotIn("homeScreenshot", f.session.evidence)
                self.assertFalse((f.session.root / "home.png").exists())

    def test_finish_ui_bitmap_export_is_exclusive_and_its_written_bytes_are_rechecked(self):
        for fault in ("existing-export", "changed-export"):
            with self.subTest(fault=fault), self.finished_home_fixture() as f:
                target = f.session.root / "home.png"
                if fault == "existing-export": target.write_bytes(b"preserved earlier evidence")
                original_write = M.P.write
                def write(file, raw):
                    self.assertEqual(file, target)
                    original_write(file, b"changed" if fault == "changed-export" else raw)
                with patch.object(M.P, "write", side_effect=write), self.assertRaises((RuntimeError, FileExistsError)):
                    M.finish_ui(f.session, M.SCENARIOS[0])
                self.assertEqual(target.read_bytes(), b"preserved earlier evidence" if fault == "existing-export" else b"changed")
                self.assertNotIn("homeScreenshot", f.session.evidence)
                f.session.d.call.assert_not_called()

    def test_actual_home_observation_requires_linux_version_dense_projects_selection_and_bridge_fields(self):
        home, values = Path("/synthetic/home"), {}
        for selector, text in (("#platform-status", "Linux"), (".footer-version", "0.1.16"), ("#page-title", "CREATOR HUB"),
                               ("#projects-home-title", "Projects"), ("#unified-home-updater #hub-update-title", "Creator Hub update")):
            values[selector, "text"] = text
        for selector, shown in (("#platform-status", True), (".footer-version", True), ("#view-projects", True),
                                ("#projects-home-title", True), ("#unified-home-updater", True), ("#view-hub", False),
                                ("#view-hosted", False), ("#view-native-features", False)):
            values[selector, "displayed"] = shown
        values["#view-projects", "attribute/aria-busy"] = "false"
        for selected, name, y in ((True, "current-project", 100), (False, "missing-project", 220)):
            row = '#project-list .project-row[data-mcp-selected="' + str(selected).lower() + '"]'
            values.update({(row, "displayed"): True, (row + " .project-info small", "text"): str(home / name),
                           (row + " .project-bridge-warning", "text"): "MCP bridge not installed",
                           (row + " .project-bridge-warning", "displayed"): True,
                           (row + " .project-selected", "text"): "Selected for MCP", (row + " .project-selected", "displayed"): True,
                           (row, "css/display"): "flex", (row, "css/padding-top"): "14px", (row, "css/padding-bottom"): "14px",
                           (row + " .project-tags", "css/font-size"): "11px", (row, "rect"): {"x": 24, "y": y, "width": 892, "height": 100}})
        d = Mock()
        d.read.side_effect = lambda selector, endpoint="text": values[selector, endpoint]
        d.elements.side_effect = lambda selector: ["a", "b"] if selector == "#project-list .project-row" else [] if selector == "iframe,object,embed" else ["a"]
        d.call.return_value = ["one-native-root"]
        result = M.home_observation(d, home)
        self.assertEqual(result["platform"], "Linux"); self.assertEqual(result["version"], "0.1.16")
        self.assertTrue(result["rows"][0]["selected"])
        for key, bad in ((("#platform-status", "text"), "Windows"), ((".footer-version", "text"), "0.1.14"),
                         (("#view-hosted", "displayed"), True), (("#view-projects", "attribute/aria-busy"), "true"),
                         (("#platform-status", "displayed"), False)):
            old = values[key]; values[key] = bad
            with self.subTest(key=key), self.assertRaises(RuntimeError): M.home_observation(d, home)
            values[key] = old
        row = '#project-list .project-row[data-mcp-selected="true"]'
        for endpoint, bad in (("css/display", "grid"), ("css/padding-top", "40px"), ("rect", {"x": 24, "y": 210, "width": 892, "height": 100})):
            old = values[row, endpoint]; values[row, endpoint] = bad
            with self.assertRaises(RuntimeError): M.home_observation(d, home)
            values[row, endpoint] = old
        key = row + " .project-bridge-warning", "text"
        values[key] = "MCP bridge not checked"
        with self.assertRaises(RuntimeError): M.home_observation(d, home)

    def test_guide_cancel_preserves_settings_but_not_blanket_ignores_root_journal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            before = M.fixture(root)
            home = root / "home"
            M.preserved(home, before, transferred=False)
            (home / M.JOURNAL).write_text(json.dumps({"revision": 1, "records": records("a", ["load_config", "discover_unity_projects"], [3, 4])}))
            M.journal_delta(M.P.parse(before[M.JOURNAL]), M.P.parse(M.read_file(home / M.JOURNAL)))
            M.preserved(home, before, transferred=False)
            target = home / M.CONFIG; target.write_text("changed")
            with self.assertRaises(RuntimeError): M.preserved(home, before, transferred=False)

    def test_stable_file_reader_rejects_links_sizes_and_descriptor_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary).resolve() / "record.json"
            file.write_bytes(b"original")
            self.assertEqual(M.read_file(file), b"original")
            with self.assertRaises(RuntimeError): M.read_file(file, limit=7)
            with self.assertRaises(RuntimeError): M.read_file(file.parent)
            before = file.stat()
            changed = Mock(**{k: getattr(before, k) for k in dir(before) if k.startswith("st_")})
            changed.st_ino += 1
            with patch.object(M.os, "fstat", return_value=changed), self.assertRaises(RuntimeError):
                M.read_file(file)
            hardlink = file.with_name("hardlink")
            os.link(file, hardlink)
            with self.assertRaises(RuntimeError): M.read_file(file)

    def disposal_fixture(self, outcome):
        session = M.Session.__new__(M.Session)
        session.child, session.native, session.helper, session.pages = Mock(), Mock(), Mock(), Mock()
        session.child.poll.return_value = 0
        session.backend = {"pid": 12}
        session.evidence = {"normalCloseObserved": True}
        session.native.native_process = Mock(**({"side_effect": outcome} if isinstance(outcome, Exception) or callable(outcome)
                                              else {"return_value": outcome}))
        def waiting(check, seconds):
            self.assertEqual(seconds, 10)
            for _ in range(3):
                if check(): return
            raise TimeoutError("Bounded existing backend pidfd did not become ready")
        session.pages.wait.side_effect = waiting
        return session

    def test_backend_disposal_terminal_parse_race_waits_existing_pidfd_without_signals(self):
        helper = M.load("native-unix-window")
        for state in ("Z", "X"):
            def observed(*args):
                return helper.parse_start("12 (backend) " + state + " 11 " + "0 " * 17 + "90", 12)
            session = self.disposal_fixture(observed)
            polls = []
            def poll(*args):
                self.assertEqual(args, ([99], [], [], 0)); polls.append(True)
                return ([99] if len(polls) == 3 else [], [], [])
            with self.subTest(state=state), patch.object(M.select, "select", side_effect=poll), \
                    patch.object(M.signal, "pidfd_send_signal", create=True) as send:
                session.dispose_tools(99)
            self.assertEqual(len(polls), 3)
            session.native.native_process.assert_called_once_with(12, session.helper)
            session.child.terminate.assert_not_called(); send.assert_not_called()
            session.child.wait.assert_called_once_with(timeout=10)

    def test_backend_disposal_terminal_timeout_never_counts_as_exit_or_sends_signal(self):
        session = self.disposal_fixture(RuntimeError("Owned process is not live"))
        with patch.object(M.select, "select", return_value=([], [], [])), \
                patch.object(M.signal, "pidfd_send_signal", create=True) as send:
            with self.assertRaises(TimeoutError): session.dispose_tools(99)
        session.child.terminate.assert_not_called(); send.assert_not_called()
        session.native.native_process.assert_called_once_with(12, session.helper)

    def test_backend_disposal_preserves_other_refusals_and_requires_normal_root_close(self):
        class DifferentRuntimeError(RuntimeError):
            pass
        for original in (RuntimeError("Different liveness refusal"), PermissionError(13, "synthetic", "/proc/12/exe"),
                         ValueError("Malformed process stat"), DifferentRuntimeError("Owned process is not live")):
            session = self.disposal_fixture(original)
            with self.subTest(error=type(original).__name__), patch.object(M.select, "select", return_value=([], [], [])), \
                    patch.object(M.signal, "pidfd_send_signal", create=True) as send:
                with self.assertRaises(type(original)) as raised: session.dispose_tools(99)
            self.assertIs(raised.exception, original)
            session.pages.wait.assert_not_called(); send.assert_not_called()
        original = RuntimeError("Owned process is not live")
        session = self.disposal_fixture(original); session.evidence["normalCloseObserved"] = False
        with patch.object(M.select, "select", return_value=([], [], [])), patch.object(M.signal, "pidfd_send_signal", create=True) as send:
            with self.assertRaises(RuntimeError) as raised: session.dispose_tools(99)
        self.assertIs(raised.exception, original); session.pages.wait.assert_not_called(); send.assert_not_called()

    def test_backend_disposal_live_identity_stays_exact_and_can_signal_only_once(self):
        for replaced in (False, True):
            session = self.disposal_fixture({"pid": 500} if replaced else {"pid": 12})
            with self.subTest(replaced=replaced), patch.object(M.select, "select", side_effect=[([], [], []), ([99], [], [])]), \
                    patch.object(M.signal, "pidfd_send_signal", create=True) as send:
                if replaced:
                    with self.assertRaisesRegex(RuntimeError, "Native driver changed before disposal"): session.dispose_tools(99)
                    send.assert_not_called(); session.pages.wait.assert_not_called()
                else:
                    session.dispose_tools(99)
                    send.assert_called_once_with(99, M.signal.SIGTERM)
            session.child.terminate.assert_not_called()

    def test_tool_disposal_accepts_proven_tool_exit_and_never_signals_product(self):
        s = M.Session.__new__(M.Session)
        s.child, s.native, s.helper, s.pages = Mock(), Mock(), Mock(), Mock()
        s.child.pid = 11
        s.driver_identity, s.backend = {"pid": 11}, {"pid": 12}
        s.child.poll.return_value = 0
        with patch.object(M.select, "select", return_value=([99], [], [])), patch.object(M.signal, "pidfd_send_signal", create=True) as send:
            s.dispose_tools(99)
            s.native.native_process.assert_not_called()
            s.child.terminate.assert_not_called(); send.assert_not_called()
        s.child.poll.return_value = None
        s.native.native_process.side_effect = [s.driver_identity, s.backend]
        with patch.object(M.select, "select", return_value=([], [], [])), patch.object(M.signal, "pidfd_send_signal", create=True) as send:
            s.dispose_tools(99)
            s.child.terminate.assert_called_once()
            send.assert_called_once_with(99, M.signal.SIGTERM)
            self.assertEqual(s.native.native_process.call_args_list[0].args[0], 11)
            self.assertEqual(s.native.native_process.call_args_list[1].args[0], 12)
        s.child.terminate.reset_mock()
        s.native.native_process.side_effect = None
        s.native.native_process.return_value = {"pid": 500}
        with patch.object(M.signal, "pidfd_send_signal", create=True) as send, self.assertRaises(RuntimeError):
            s.dispose_tools(99)
        s.child.terminate.assert_not_called(); send.assert_not_called()

    def test_startup_failure_keeps_bounded_refusal_and_existing_driver_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            log = Mock()
            log.metadata.return_value = {"stderr": {"truncated": False}}
            def start(session):
                session.evidence["root"] = {"pid": 16, "kernelImageSha256": "a" * 64}
                session.logs = log
                raise RuntimeError("Root mapping refused")
            with patch.object(M.Session, "start", start), self.assertRaisesRegex(RuntimeError, "Root mapping refused"):
                M.Session(root, binding())
            receipt = M.P.parse(M.read_file(root / "session.json"))
            self.assertFalse(receipt["normalCloseObserved"])
            self.assertEqual(receipt["root"]["pid"], 16)
            self.assertEqual(receipt["startupRefused"], {"type": "RuntimeError", "message": "Root mapping refused"})
            log.pump.assert_called_once(); log.close.assert_called_once()

    def test_syntax_sdk_uses_locked_library_and_has_no_signal_based_transport_close(self):
        source = (HERE / "native-linux-production-016-migration.py").read_text()
        ast.parse(source, feature_version=(3, 10))
        subprocess.run(["node", "--check", "--input-type=commonjs"], input=M.SDK_JS.encode(), check=True, capture_output=True)
        self.assertIn("@modelcontextprotocol/sdk/client/index.js", M.SDK_JS)
        self.assertIn("stdin.end()", M.SDK_JS)
        for token in ("process.kill", ".kill(", "StdioClientTransport", "eval("):
            self.assertNotIn(token, M.SDK_JS)
        self.assertEqual(M.FLAGS["releaseReady"], False)
        self.assertNotIn("request_restart", source)

    def test_sdk_pin_is_the_actual_linux_checkout_lock_not_windows_crlf_bytes(self):
        lock = (HERE.parent / "modules/mcp/package-lock.json").read_bytes()
        self.assertEqual(M.digest(lock.replace(b"\r\n", b"\n")), M.SDK_LOCK)
        workflow = (HERE.parent / ".github/workflows/native-linux-production-016-migration.yml").read_text()
        self.assertIn("= " + M.SDK_LOCK, workflow)
        self.assertIn('digest(read_file(source / "package-lock.json", 2 * 1024 * 1024)) == SDK_LOCK',
                      (HERE / "native-linux-production-016-migration.py").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
