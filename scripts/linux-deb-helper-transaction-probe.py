"""One opted-in disposable helper transaction; no auth/production acceptance.

Never invoke on a user PC. The baseline apt install is fixture provisioning,
not the helper's privilege interface. Only the fixed helper constructs and
installs its candidate. No failed transaction is retried, repaired or rolled back.
The workflow's hard deadline/cancellation is not an interruption-safety proof.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("retention_fixture", REPO / "scripts/linux-deb-retention-probe.py")
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)
require = fixture.require
HELPER = "/usr/libexec/creator-hub-deb-retirement-helper"
PRIVATE = "/var/lib/creator-hub-deb-retirement"
RETIRE = ["/usr/bin/sudo", "-n", HELPER, "retire-mcp-2.7.7"]
EXPECTED = {"CREATOR_LINUX_DEB_HELPER_TRANSACTION": "1", "GITHUB_ACTIONS": "true",
    "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
    "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
    "GITHUB_REF": "refs/heads/validation/linux-deb-helper-transaction-014", "GITHUB_EVENT_NAME": "push"}
STAGE = re.compile(r"mcp-2\.7\.7-preparation-[0-9a-f]{32}")
METADATA_PARENTS = ("/", "/usr", "/usr/share")
CONTAINER_IMAGE = "ubuntu:22.04@sha256:08ea48a03a3e78ebc7cd526e6a275053223aadd88bfc09cc49b06d5281525fde"
CONTAINER_SOURCE = "https://hub.docker.com/v2/repositories/library/ubuntu/tags/22.04"
CONTAINER_INDEX = "sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401"
GATES = ("productionIntegrated", "privilegedHelperAccepted", "nativeTransactionAccepted",
    "nativeApprovalAccepted", "actualUserAuthenticationAccepted", "nativeCancellationAccepted",
    "guiIdleCloseAccepted", "runtimeRetentionAccepted", "packageGuiRetirementAccepted",
    "recoveryAccepted", "migrationAccepted", "setupTransitionAccepted", "flatpakAccepted",
    "signedUpdateAccepted", "restartAccepted", "releaseReady", "nativeContentionAccepted")


def admission(env, system, machine, uid):
    require(system == "Linux" and machine == "x86_64" and uid > 0, "Unprivileged native Linux x86_64 required")
    require(all(env.get(k) == v for k, v in EXPECTED.items()), "Exact opted-in disposable repository/id/branch/push required")
    require(not any(env.get(k) for k in ("FLATPAK_ID", "APPIMAGE", "APPDIR", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH")),
            "Sandbox or injected loader refused")


def container_admission(env, uid, euid, docker_marker):
    require(uid == euid == 1001 and docker_marker
            and env.get("CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE") == CONTAINER_IMAGE,
            "Exact pinned container and real/effective fixture UID 1001 required")


def helper_result(code, out, err, repeat=False):
    require(not err, "Unexpected helper stderr; retain original capture")
    result = json.loads(out)
    require(result.get("experimentalTransactionCompiled") is True and result.get("installationEnabled") is False
            and result.get("nativeAcceptance") is False, "Experimental-only result required")
    if repeat:
        require(code == 2 and result.get("status") == "manual-repair-required"
                and result.get("manualRepairRequired") is True and result.get("packageTransactionStarted") is None
                and result.get("packageTransactionMayHaveStarted") is True
                and "An earlier transaction attempt is recorded" in result.get("reason", ""),
                "Repeat must refuse specifically at prior attempt marker")
    else:
        require(code == 0 and result.get("status") == "experimental-transaction-verified"
                and result.get("packageTransactionStarted") is True and result.get("manualRepairRequired") is False
                and result.get("retainedFilesVerified") == 9 and result.get("omittedFilesVerified") == 5
                and result.get("version") == fixture.NEW, "Helper transaction did not verify; no retry permitted")
        require(re.fullmatch(re.escape(PRIVATE) + r"/mcp-2\.7\.7-preparation-[0-9a-f]{32}/runtime-only\.deb",
                             result.get("candidate", "")), "Unexpected protected candidate path")
    return result


def stage_built_helper(source, destination):
    # Cargo hard-links final binaries from deps. Copy only build output, never
    # relax the single-link checks for packages, installed resources or image.
    before = source.lstat()
    require(stat.S_ISREG(before.st_mode) and source.resolve() == source and before.st_nlink >= 1,
            "Ordinary unredirected Cargo output required")
    fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_nlink", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")
    stamp = lambda info: tuple(getattr(info, field) for field in fields)
    digest = hashlib.sha256()
    with source.open("rb") as incoming:
        opened = os.fstat(incoming.fileno())
        # Compare descriptor identity separately: Windows stat/fstat report mode
        # and ctime differently. Each full metadata view must remain unchanged.
        identity = ("st_dev", "st_ino", "st_size", "st_nlink", "st_uid", "st_gid", "st_mtime_ns")
        require(stat.S_ISREG(opened.st_mode) and all(getattr(opened, key) == getattr(before, key) for key in identity),
                "Cargo source changed before copy")
        with destination.open("xb") as outgoing:
            while chunk := incoming.read(1024 * 1024):
                require(outgoing.write(chunk) == len(chunk), "Incomplete helper image copy")
                digest.update(chunk)
        require(stamp(os.fstat(incoming.fileno())) == stamp(opened) and stamp(source.lstat()) == stamp(before),
                "Cargo source changed during copy")
    copied = fixture.fingerprint(destination)
    require(copied["bytes"] == before.st_size and copied["sha256"] == digest.hexdigest(), "Staged helper bytes differ")
    return copied


class Probe:
    def __init__(self, preflight=False):
        admission(os.environ, platform.system(), platform.machine(), os.getuid())
        if os.environ.get("CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE"):
            container_admission(os.environ, os.getuid(), os.geteuid(), Path("/.dockerenv").is_file())
        release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
        require(release.get("ID", "").strip('"') == "ubuntu" and release.get("VERSION_ID", "").strip('"') == "22.04",
                "Pinned Ubuntu 22.04 required")
        parent = Path(os.environ["RUNNER_TEMP"])
        require(parent.is_absolute() and parent.resolve(strict=True) == parent, "Ordinary absolute runner temp required")
        self.root = parent / ("linux-deb-helper-preflight" if preflight else "linux-deb-helper-transaction")
        self.root.mkdir(mode=0o700, exist_ok=True)
        require(self.root.resolve() == self.root and stat.S_ISDIR(self.root.lstat().st_mode)
                and self.root.stat().st_uid == os.getuid() and stat.S_IMODE(self.root.stat().st_mode) == 0o700,
                "Ordinary private owned output directory required")
        self.old = parent / "linux-deb-helper-transaction-input" / fixture.ASSET

    def save(self, label, value):
        with (self.root / (label + ".json")).open("x", encoding="utf-8") as target:
            json.dump(value, target, indent=2)
            target.write("\n")
        return value

    def command(self, label, argv, allowed=(0,), timeout=120):
        record = {"argv": argv, "exitCode": None}
        # No helper timeout or forced child kill. Workflow cancellation remains unaccepted.
        try:
            with (self.root / (label + ".stdout")).open("xb") as out, (self.root / (label + ".stderr")).open("xb") as err:
                result = subprocess.run(argv, cwd=REPO, env={**os.environ, "LANG": "C", "LC_ALL": "C"},
                    stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=timeout, check=False)
                record["exitCode"] = result.returncode
        finally:
            self.save(label + "-command", record)
        stdout = (self.root / (label + ".stdout")).read_bytes()
        stderr = (self.root / (label + ".stderr")).read_bytes()
        require(len(stdout) + len(stderr) <= 4 * 1024 * 1024, "Command output exceeded capture bound")
        require(result.returncode in allowed, "Command failed: " + label + "; original logs retained")
        return result.returncode, stdout, stderr

    def plan(self):
        row = fixture.fingerprint(self.old)
        require((row["bytes"], row["sha256"]) == (fixture.PACKAGE_BYTES, fixture.PACKAGE_SHA), "Exact original public DEB required")
        return json.loads((self.root / "plan.json").read_text())

    def container_identity(self):
        container_admission(os.environ, os.getuid(), os.geteuid(), Path("/.dockerenv").is_file())
        versions = {}
        for name, argv in (("dpkg", ["/usr/bin/dpkg", "--version"]), ("rustc", ["rustc", "--version", "--verbose"]),
                ("cargo", ["cargo", "--version", "--verbose"]), ("node", ["node", "--version"])):
            code, out, err = self.command("container-" + name, argv, timeout=30)
            require(len(out) + len(err) <= 16 * 1024, "Container version capture exceeded bound")
            versions[name] = {"exitCode": code, "stdout": out.decode("utf-8"), "stderr": err.decode("utf-8")}
        require(versions["node"]["stdout"] == "v24.17.0\n" and versions["rustc"]["stdout"].startswith("rustc 1.99.0 ")
                and versions["cargo"]["stdout"].startswith("cargo 1.99.0 "), "Exact container toolchain required")
        return self.save("container-identity", {"schemaVersion": 1, "scope": "disposable-container-mechanism-only",
            "configuredContainerImage": CONTAINER_IMAGE, "imageSourceUrl": CONTAINER_SOURCE,
            "observedTagIndexDigest": CONTAINER_INDEX, "osRelease": Path("/etc/os-release").read_text(),
            "uid": os.getuid(), "euid": os.geteuid(), "kernel": platform.release(),
            "sourceRevision": os.environ.get("GITHUB_SHA"), "runId": os.environ.get("GITHUB_RUN_ID"),
            "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "environment": {key: os.environ.get(key) for key in EXPECTED},
            "versions": versions, "packageTransactionStarted": False, "nativeAcceptance": False,
            "productionGates": dict.fromkeys(GATES, False)})

    def metadata_diagnostic(self):
        uid, euid = os.getuid(), os.geteuid()
        require(uid > 0 and euid > 0, "Unprivileged metadata diagnostic required")
        observations = {"schemaVersion": 1, "scope": "read-only-parent-metadata-before-native-gate",
            "sourceRevision": os.environ.get("GITHUB_SHA"), "runId": os.environ.get("GITHUB_RUN_ID"),
            "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "uid": uid, "euid": euid,
            "paths": {}, "captureErrors": [], "packageTransactionStarted": False,
            "nativeAcceptance": False, "productionGates": dict.fromkeys(GATES, False)}
        for name in METADATA_PARENTS:
            try:
                info = Path(name).lstat()
                kind = "directory" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "regular-file" if stat.S_ISREG(info.st_mode) else "other"
                observations["paths"][name] = {"type": kind, "mode": info.st_mode,
                    "permissionsOctal": format(stat.S_IMODE(info.st_mode), "04o"),
                    "uid": info.st_uid, "gid": info.st_gid, "dev": info.st_dev, "ino": info.st_ino,
                    "nlink": info.st_nlink, "size": info.st_size,
                    "mtimeNs": info.st_mtime_ns, "ctimeNs": info.st_ctime_ns,
                    "helperParentChecks": {"directory": stat.S_ISDIR(info.st_mode), "rootOwned": info.st_uid == 0,
                        "modeMaskClear": info.st_mode & 0o7022 == 0},
                    "disallowedModeBitsOctal": format(info.st_mode & 0o7022, "04o")}
            except OSError as error:
                observations["paths"][name] = {"captureError": str(error), "errno": error.errno}
                observations["captureErrors"].append("lstat unavailable: " + name)
        try:
            code, out, err = self.command("metadata-diagnostic-dpkg-version", ["/usr/bin/dpkg", "--version"],
                allowed=(0, 1, 2), timeout=10)
            truncated = len(out) + len(err) > 16 * 1024
            observations["dpkgVersion"] = {"exitCode": code, "stdout": out[:16 * 1024].decode("utf-8", errors="replace"),
                "stderr": err[:16 * 1024].decode("utf-8", errors="replace"), "truncated": truncated}
            if code != 0 or truncated:
                observations["captureErrors"].append("dpkg version unavailable or oversized; exit " + str(code))
        except Exception as error:
            observations["dpkgVersion"] = {"captureError": str(error)}
            observations["captureErrors"].append("dpkg version capture failed")
        observations["captureComplete"] = not observations["captureErrors"]
        self.save("metadata-diagnostic", observations)
        require(observations["captureComplete"], "Read-only metadata capture incomplete; see metadata-diagnostic.json")
        return observations

    def provision_metadata_fixture(self):
        admission(os.environ, platform.system(), platform.machine(), os.getuid())
        require(os.geteuid() > 0, "Fixture provisioning requires an unprivileged caller")
        captured = json.loads((self.root / "metadata-diagnostic.json").read_text())
        require(captured.get("captureComplete") is True and all(captured.get(key) == os.environ.get(env)
            for key, env in (("sourceRevision", "GITHUB_SHA"), ("runId", "GITHUB_RUN_ID"), ("runAttempt", "GITHUB_RUN_ATTEMPT"))), "Same-run read-only capture required")
        fields = ("mode", "uid", "gid", "dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs")
        attrs = ("st_mode", "st_uid", "st_gid", "st_dev", "st_ino", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        def observe():
            return {name: dict(zip(fields, (getattr(info, attr) for attr in attrs)))
                for name in METADATA_PARENTS for info in [Path(name).lstat()]}
        def entries():
            names = sorted(os.listdir("/usr/share"))
            require(len(names) <= 8192, "Fixture entry inventory exceeded bound")
            return {"count": len(names), "sha256": hashlib.sha256(json.dumps(names).encode()).hexdigest()}
        before = observe()
        require(before == {name: {key: captured["paths"][name][key] for key in fields} for name in METADATA_PARENTS}, "Parent metadata drift since capture")
        require(all(stat.S_ISDIR(row["mode"]) and row["uid"] == 0 for row in before.values())
            and all(before[name]["mode"] & 0o7022 == 0 for name in ("/", "/usr")), "Unprotected fixture parent")
        mode = stat.S_IMODE(before["/usr/share"]["mode"])
        require(mode in (0o777, 0o755), "Only exact fixture 0777 or 0755 admitted")
        names = entries()
        common = {"scope": "disposable-hosted-fixture-only", "nativeAcceptance": False,
            "packageTransactionStarted": False, "productionGates": dict.fromkeys(GATES, False)}
        self.save("metadata-fixture-before", {**common, "paths": before, "entries": names})
        require(observe() == before and entries() == names, "Fixture drift before chmod")
        try:
            if mode == 0o777:
                self.command("metadata-fixture-chmod", ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "--", "0755", "/usr/share"], timeout=10)
        finally:
            after, after_names = observe(), entries()
            expected = {**before["/usr/share"], "mode": stat.S_IFDIR | 0o755,
                "ctimeNs": after["/usr/share"]["ctimeNs"] if mode == 0o777 else before["/usr/share"]["ctimeNs"]}
            valid = all(after[name] == before[name] for name in ("/", "/usr")) and after["/usr/share"] == expected and after_names == names
            result = {**common, "paths": after, "entries": after_names, "chmodRequested": mode == 0o777, "fixtureStateVerified": valid}
            self.save("metadata-fixture-after", result)
        require(valid, "Fixture post-state drift; no retry or other-path repair")
        return result

    def prepare(self):
        source = self.command("source", ["git", "rev-parse", "HEAD"])[1].decode().strip()
        require(re.fullmatch(r"[0-9a-f]{40}", source) and source == os.environ.get("GITHUB_SHA"), "Checkout/source mismatch")
        versions = {"sourceRevision": source, "osRelease": Path("/etc/os-release").read_text(),
                    "kernel": platform.release(), "rustToolchain": (REPO / "rust-toolchain.toml").read_text()}
        for label, argv in (("dpkg-version", ["/usr/bin/dpkg", "--version"]),
                ("rust-version", ["rustc", "--version", "--verbose"]), ("cargo-version", ["cargo", "--version", "--verbose"]),
                ("node-version", ["node", "--version"]), ("python-version", [sys.executable, "--version"])):
            versions[label] = self.command(label, argv)[1].decode()
        self.save("environment", versions)
        original = fixture.fingerprint(self.old)
        require((original["bytes"], original["sha256"]) == (fixture.PACKAGE_BYTES, fixture.PACKAGE_SHA), "Original DEB pin differs")
        controls = {}
        raw = self.command("original-control-tar", ["/usr/bin/dpkg-deb", "--ctrl-tarfile", str(self.old)])[1]
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for member in archive:
                name = fixture.member_name(member.name)
                if member.isdir() and not name:
                    continue
                require(member.isfile() and name in ("control", "md5sums") and name not in controls, "Unexpected original control member")
                controls[name] = archive.extractfile(member).read()
        require(set(controls) == {"control", "md5sums"}, "Incomplete original controls")
        baseline = (REPO / "native/linux-deb-retirement/tests/fixtures/baseline.control").read_text()
        require(fixture.control_fields(controls["control"]) == fixture.control_fields(baseline.encode()), "Baseline control differs")
        sums = fixture.md5_entries(controls["md5sums"])
        require(set(sums) == fixture.RUNTIME | fixture.RETIRED, "Original fourteen-file set differs")
        with (self.root / "original-payload.stderr").open("xb") as err:
            child = subprocess.Popen(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(self.old)], stdout=subprocess.PIPE, stderr=err)
            try:
                files = fixture.payload(child.stdout, sums)
                child.stdout.read()
            finally:
                child.stdout.close()
                require(child.wait(timeout=120) == 0, "Original payload extraction failed")
        require(all(files[name]["md5"] == digest for name, digest in sums.items()), "Original payload md5 mismatch")
        return self.save("plan", {"original": original, "files": files, "reuseRun": fixture.REUSE_RUN,
            "reuseArtifact": fixture.REUSE_ARTIFACT, "helperBuildOnly": True, "productionGates": dict.fromkeys(GATES, False)})

    def install(self):
        self.plan()
        require(not os.path.lexists(HELPER) and not os.path.lexists(PRIVATE), "Existing helper/private state refused")
        code = self.command("initial-package", ["/usr/bin/dpkg-query", "-W", "-f=${db:Status-Status}", fixture.PACKAGE], allowed=(0, 1))[0]
        require(code == 1 and all(not os.path.lexists("/" + n) for n in fixture.RUNTIME | fixture.RETIRED), "Pre-existing baseline refused")
        target = self.root / "target"
        self.command("build-helper", ["cargo", "build", "--locked", "--release", "--features", "experimental-transaction",
            "--manifest-path", "native/linux-deb-retirement/Cargo.toml", "--target-dir", str(target)], timeout=600)
        binary = target / "release/creator-hub-linux-deb-retirement"
        metadata = binary.lstat()
        self.save("cargo-helper-source", {"path": str(binary), "links": metadata.st_nlink, "bytes": metadata.st_size,
            "mode": metadata.st_mode, "uid": metadata.st_uid, "gid": metadata.st_gid, "resolved": str(binary.resolve())})
        staged = self.root / "helper-install-image"
        built = stage_built_helper(binary, staged)
        parent = Path(HELPER).parent
        if not parent.exists():
            self.command("helper-directory", ["/usr/bin/sudo", "-n", "/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m", "0755", str(parent)])
        self.command("install-helper", ["/usr/bin/sudo", "-n", "/usr/bin/install", "-T", "-o", "root", "-g", "root", "-m", "0755", str(staged), HELPER])
        image = fixture.fingerprint(Path(HELPER))
        require(image["sha256"] == built["sha256"] and image["uid"] == image["gid"] == 0 and image["mode"] == 0o755, "Installed helper image differs")
        self.save("helper-image", {"built": built, "installed": image})
        self.command("apt-update", ["/usr/bin/sudo", "-n", "/usr/bin/apt-get", "update"], timeout=360)
        self.command("install-public-baseline", ["/usr/bin/sudo", "-n", "/usr/bin/apt-get", "install", "-y", "--no-install-recommends", str(self.old)], timeout=None)
        self.plan()
        return {"fixtureBaselineInstalled": True, "fixedProtectedHelperInstalled": True}

    def snapshot(self, phase):
        plan = self.plan()
        expected = fixture.RUNTIME | fixture.RETIRED if phase == "before" else fixture.RUNTIME
        version = fixture.OLD if phase == "before" else fixture.NEW
        state = self.command(phase + "-state", ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", fixture.PACKAGE])[1]
        require(state.decode() == f"{fixture.PACKAGE}\t{version}\tamd64\tinstall ok installed\n", "Package state differs")
        listing = self.command(phase + "-list", ["/usr/bin/dpkg-query", "-L", fixture.PACKAGE])[1].decode().splitlines()
        known = (REPO / ("native/linux-deb-retirement/tests/fixtures/" + ("baseline.list" if phase == "before" else "compatibility.list"))).read_text().splitlines()
        require(len(listing) == len(set(listing)) and set(listing) == set(known), "Complete package file list differs")
        files = {}
        for index, name in enumerate(sorted(expected)):
            row = fixture.fingerprint(Path("/" + name))
            require(all(row[k] == v for k, v in plan["files"][name].items()), "Installed resource differs: " + name)
            owner = self.command(phase + "-owner-" + str(index), ["/usr/bin/dpkg-query", "-S", "/" + name])[1].decode()
            require(owner == f"{fixture.PACKAGE}: /{name}\n", "Nonexclusive resource ownership")
            files[name] = {**row, "owner": owner}
        if phase != "before":
            for index, name in enumerate(sorted(fixture.RETIRED)):
                require(not os.path.lexists("/" + name), "Omitted GUI path still exists")
                require(not self.command(phase + "-omitted-owner-" + str(index), ["/usr/bin/dpkg-query", "-S", "/" + name], allowed=(1,))[1], "Omitted ownership remains")
        for label, args in (("audit", ["--audit"]), ("verify", ["--verify", fixture.PACKAGE])):
            _, out, err = self.command(phase + "-" + label, ["/usr/bin/dpkg", *args])
            require(not out and not err, "dpkg health check not clean")
        return self.save(phase, {"files": files, "version": version, "cleanDpkgState": True})

    def global_state(self, prefix):
        # Do not clear unrelated global entries to make this deliberately strict helper pass.
        observations = {}
        for name in ("diversions", "statoverride"):
            path = Path("/var/lib/dpkg") / name
            try:
                info = path.lstat()
                observations[name] = {"mode": info.st_mode, "uid": info.st_uid, "gid": info.st_gid, "bytes": info.st_size}
                if stat.S_ISREG(info.st_mode):
                    code, raw, _ = self.command(prefix + "-" + name,
                        ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", str(path)], allowed=(0, 1))
                    observations[name]["captureExitCode"] = code
                    if code == 0:
                        observations[name]["capturedSha256"] = hashlib.sha256(raw).hexdigest()
                else:
                    observations[name]["unknownTypePreserved"] = True
            except FileNotFoundError:
                observations[name] = {"absent": True}
            except Exception as error:
                observations.setdefault(name, {})["captureError"] = str(error)
        for name, args in (("diversions-list", ["/usr/bin/dpkg-divert", "--list"]),
                ("statoverride-list", ["/usr/bin/dpkg-statoverride", "--list"]),
                ("package-state", ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", fixture.PACKAGE]),
                ("audit", ["/usr/bin/dpkg", "--audit"])):
            try:
                code, _, _ = self.command(prefix + "-" + name, args, allowed=(0, 1, 2))
                observations[name] = {"captureExitCode": code}
            except Exception as error:
                observations[name] = {"captureError": str(error)}
        return self.save(prefix + "-global-state", observations)

    def retire(self):
        require((self.root / "before.json").is_file(), "Verified original baseline snapshot required")
        self.global_state("pre-retire")
        # One attempted transaction only. No previous preparation path is supplied.
        result = helper_result(*self.command("retire-helper", RETIRE, allowed=(0, 2), timeout=None))
        return self.save("retire", result)

    def private_listing(self, label):
        return self.command(label, ["/usr/bin/sudo", "-n", "/usr/bin/find", PRIVATE, "-xdev", "-maxdepth", "3",
            "-printf", "%y %m %U %G %s %p\n"])[1]

    def repeat(self):
        require((self.root / "retire.json").is_file() and (self.root / "after.json").is_file(), "Only verified success permits a negative repeat test")
        helper_result(0, (self.root / "retire.json").read_bytes(), b"")
        before = self.private_listing("repeat-private-before")
        marker_args = ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", PRIVATE + "/transaction-attempted"]
        marker = self.command("repeat-marker-before", marker_args)[1]
        candidate = json.loads((self.root / "retire.json").read_text())["candidate"]
        require(("Stage: " + candidate + "\n").encode() in marker, "Attempt marker must identify the successful private candidate")
        result = helper_result(*self.command("repeat-helper", RETIRE, allowed=(2,), timeout=None), repeat=True)
        require(self.private_listing("repeat-private-after") == before, "Repeat changed private stage/marker/log metadata")
        require(self.command("repeat-marker-after", marker_args)[1] == marker, "Repeat changed attempt marker bytes")
        self.snapshot("after-repeat")
        return self.save("repeat", result)

    def diagnostics(self):
        global_state = self.global_state("final")
        # Root-private capture uses fixed read-only system commands, never an elevated repo script.
        observations = {"productionGates": dict.fromkeys(GATES, False), "captureErrors": [], "commands": []}
        for name, row in global_state.items():
            if "captureError" in row or row.get("captureExitCode", 0) != 0 or row.get("unknownTypePreserved"):
                observations["captureErrors"].append("Global state capture incomplete: " + name)

        def capture(label, args):
            try:
                code, _, _ = self.command(label, args, allowed=(0, 1, 2))
                observations["commands"].append({"label": label, "exitCode": code})
                if code != 0:
                    observations["captureErrors"].append(label + " unavailable; exit " + str(code))
            except Exception as error:
                observations["captureErrors"].append(str(error))

        jobs = [("private-manifest", ["/usr/bin/sudo", "-n", "/usr/bin/find", PRIVATE, "-xdev", "-maxdepth", "3", "-printf", "%y %m %U %G %s %p\n"]),
                ("attempt-marker", ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", PRIVATE + "/transaction-attempted"]),
                ("private-stages", ["/usr/bin/sudo", "-n", "/usr/bin/find", PRIVATE, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-printf", "%f\n"])]
        for label, args in jobs:
            capture(label, args)
        listing = self.root / "private-stages.stdout"
        stages = []
        if listing.is_file():
            for index, name in enumerate(listing.read_text().splitlines()):
                if index >= 4 or not STAGE.fullmatch(name):
                    observations["captureErrors"].append("Unknown/excess protected stage preserved: " + name)
                    continue
                stages.append(name)
                for filename in ("dpkg.stdout", "dpkg.stderr"):
                    capture("stage-" + str(index) + "-" + filename.replace(".", "-"),
                        ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", PRIVATE + "/" + name + "/" + filename])
                capture("stage-" + str(index) + "-candidate-sha256",
                    ["/usr/bin/sudo", "-n", "/usr/bin/sha256sum", "--", PRIVATE + "/" + name + "/runtime-only.deb"])
        observations["protectedStages"] = stages
        observations["evidenceComplete"] = not observations["captureErrors"] and len(stages) == 1
        self.save("diagnostics", observations)
        report = self.root / "report.json"
        if report.is_file() and json.loads(report.read_text()).get("helperMechanismAccepted") is True:
            require(observations["evidenceComplete"], "Reported helper success lacks complete diagnostics; no acceptance of this lane")
        return observations


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("prepare", "install", "before", "retire", "after", "repeat", "diagnostics", "metadata-diagnostic", "provision-metadata-fixture", "container-identity"), "One fixed fixture phase required")
    phase = sys.argv[1]
    probe = Probe(preflight=phase in ("container-identity", "metadata-diagnostic", "provision-metadata-fixture"))
    if phase == "container-identity":
        result = probe.container_identity()
    elif phase == "metadata-diagnostic":
        result = probe.metadata_diagnostic()
    elif phase == "provision-metadata-fixture":
        result = probe.provision_metadata_fixture()
    else:
        result = probe.snapshot(phase) if phase in ("before", "after") else getattr(probe, phase)()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
