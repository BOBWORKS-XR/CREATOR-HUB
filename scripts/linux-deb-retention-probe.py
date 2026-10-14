"""One disposable Ubuntu same-package upgrade; never a production mutator."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
from email.parser import Parser

sys.dont_write_bytecode = True
REPO = "BOBWORKS-XR/CREATOR-HUB"
BRANCH = "refs/heads/validation/linux-deb-retention-014"
ASSET = "Creator.Works.MCP_2.7.7_amd64.deb"
PACKAGE_SHA = "db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b"
PACKAGE_BYTES = 96666824
PACKAGE = "creator-works-mcp"
OLD, NEW = "2.7.7", "2.7.7-1+hub.retention014.1"
REUSE_RUN, REUSE_ARTIFACT = 38642404016, 11929999662
CANDIDATE_BYTES = 69843476
CANDIDATE_SHA = "0f3c7ade0eba54b8d44a8ea5e71d33da0938f96f6c3f4b68502e937532eccd19"
SERVER = "usr/lib/Creator Works MCP/server/"
RUNTIME = {SERVER + s for s in (
    "LICENSE", "THIRD_PARTY_NOTICES.md", "creator-works-mcp.mjs", "runtime/LICENSE",
    "runtime/VERSION", "runtime/node", "runtime/node.exe",
    "unity-extension/Editor/BanterMCPBridge.cs", "unity-extension/Editor/CreatorWorksMCPLogo.png")}
RETIRED = {"usr/bin/creator-works-mcp-launcher", "usr/share/applications/Creator Works MCP.desktop"}
RETIRED |= {f"usr/share/icons/hicolor/{size}/apps/creator-works-mcp-launcher.png"
            for size in ("32x32", "256x256@2", "128x128")}
FALSE_GATES = {k: False for k in ("nativeCancellationAccepted", "tamperAccepted", "recoveryAccepted",
    "guiIdleCloseAccepted", "setupTransitionAccepted", "productionIntegrated", "migrationAccepted",
    "flatpakAccepted", "signedUpdateAccepted", "releaseReady")}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def admission(env, system, machine):
    require(system == "Linux" and machine == "x86_64", "Native Linux x86_64 only")
    required = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "GITHUB_REPOSITORY": REPO,
        "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": BRANCH,
        "CREATOR_LINUX_DEB_RETENTION": "1", "GITHUB_EVENT_NAME": "push"}
    require(all(env.get(k) == v for k, v in required.items()), "Exact opted-in disposable runner required")
    require(not any(env.get(k) for k in ("FLATPAK_ID", "APPIMAGE", "APPDIR")), "Native DEB only")


def control_fields(data):
    message = Parser().parsestr(data.decode("utf-8"))
    keys = [k.lower() for k in message.keys()]
    require(not message.defects and len(keys) == len(set(keys)), "Malformed/duplicate control fields")
    require(not message.get_payload(), "Multiple control stanzas refused")
    return dict(message.items())


def member_name(name):
    if name == ".":
        return ""
    if name.startswith("./"):
        name = name[2:]
    p = PurePosixPath(name)
    require(name and not p.is_absolute() and ".." not in p.parts and str(p) == name,
            "Noncanonical archive member")
    return name


def md5_entries(data):
    entries = {}
    for line in data.decode("utf-8").splitlines():
        digest, name = line.split("  ", 1)
        require(len(digest) == 32 and all(c in "0123456789abcdef" for c in digest), "Bad md5 entry")
        require(name == member_name(name) and name not in entries, "Duplicate/unsafe md5 member")
        entries[name] = digest
    return entries


def desktop_discovery(gio):
    # PyGObject raises TypeError for the missing DesktopAppInfo.new() result on Ubuntu 22.04.
    matches = [{"id": app.get_id(), "executable": app.get_executable()}
               for app in gio.AppInfo.get_all() if app.get_id() == "Creator Works MCP.desktop"]
    require(len(matches) <= 1, "Duplicate desktop registration")
    return matches[0] if matches else None


def fingerprint(path):
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and path.resolve() == path,
            "Ordinary unredirected single-link file required: " + str(path))
    sha, md5 = hashlib.sha256(), hashlib.md5()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
            md5.update(chunk)
    after = path.lstat()
    require(all(getattr(s, k) == getattr(after, k) for k in ("st_dev", "st_ino", "st_size", "st_mode",
                "st_nlink", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")), "File changed during capture")
    return {"bytes": s.st_size, "sha256": sha.hexdigest(), "md5": md5.hexdigest(),
            "mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid, "inode": s.st_ino}


def payload(stream, expected):
    files, seen = {}, set()
    ancestors = {""}
    for name in expected:
        ancestors.update(str(p) for p in PurePosixPath(name).parents if str(p) != ".")
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for entry in archive:
            name = member_name(entry.name)
            require(name not in seen, "Duplicate payload member")
            seen.add(name)
            require(entry.uid == entry.gid == 0, "Non-root package ownership")
            if entry.isdir():
                require(name in ancestors and entry.mode == 0o755, "Unexpected payload directory/mode")
                continue
            require(entry.isfile() and name in expected and 0 < entry.size <= 123459976,
                    "Unexpected payload file/type/size")
            require(entry.mode in (0o644, 0o755), "Unexpected payload mode")
            sha, md5 = hashlib.sha256(), hashlib.md5()
            source = archive.extractfile(entry)
            while chunk := source.read(1024 * 1024):
                sha.update(chunk)
                md5.update(chunk)
            files[name] = {"bytes": entry.size, "sha256": sha.hexdigest(), "md5": md5.hexdigest(),
                           "mode": entry.mode, "uid": entry.uid, "gid": entry.gid}
    require(set(files) == set(expected), "Incomplete payload")
    return files


class Probe:
    def __init__(self):
        admission(os.environ, platform.system(), platform.machine())
        release = dict(line.rstrip().split("=", 1) for line in Path("/etc/os-release").read_text().splitlines()
                       if "=" in line)
        require(release.get("ID") == "ubuntu" and release.get("VERSION_ID", "").strip('"') == "22.04",
                "Pinned Ubuntu 22.04 required")
        self.root = Path(os.environ["RUNNER_TEMP"]) / "linux-deb-retention"
        require(self.root.parent.resolve() == self.root.parent, "Unredirected runner temp required")
        self.root.mkdir(mode=0o700, exist_ok=True)
        require(self.root.resolve() == self.root, "Redirected output refused")
        self.old = self.root / ASSET
        self.new = self.root / f"{PACKAGE}_{NEW}_amd64.deb"
        pins = json.loads((Path(__file__).resolve().parents[1] /
                          "docs/evidence/legacy-unix-public-package-pins-014.json").read_text())
        rows = [p for p in pins["packages"] if p["asset"] == ASSET]
        require(len(rows) == 1, "One exact public DEB pin required")
        self.pin = rows[0]
        require(self.pin["packageSha256"] == PACKAGE_SHA and self.pin["packageBytes"] == PACKAGE_BYTES,
                "Public DEB pin changed")

    def save(self, name, value):
        with (self.root / (name + ".json")).open("x", encoding="utf-8") as target:
            json.dump(value, target, indent=2)
            target.write("\n")
        return value

    def command(self, label, argv, timeout=120, allowed=(0,)):
        result = subprocess.run(argv, capture_output=True, timeout=timeout, env={**os.environ, "LC_ALL": "C"})
        require(len(result.stdout) + len(result.stderr) <= 2 * 1024 * 1024, "Command output exceeded bound")
        (self.root / (label + ".stdout")).write_bytes(result.stdout)
        (self.root / (label + ".stderr")).write_bytes(result.stderr)
        self.save(label + "-command", {"argv": argv, "exitCode": result.returncode})
        require(result.returncode in allowed, "Command failed: " + label)
        return result

    def verify_old(self):
        row = fingerprint(self.old)
        require((row["bytes"], row["sha256"]) == (PACKAGE_BYTES, PACKAGE_SHA), "Original DEB differs")
        return row

    def package_payload(self, deb, expected):
        child = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE)
        try:
            result = payload(child.stdout, expected)
            child.stdout.read()
        finally:
            child.stdout.close()
            code = child.wait(timeout=120)
        require(code == 0, "dpkg-deb payload read failed")
        return result

    def prepare(self):
        url = f"https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/download/v2.7.7/{ASSET}"
        require(self.pin["packageUrl"] == url, "Unexpected public URL")
        reuse = self.root.parent / "linux-deb-retention-reuse"
        if reuse.is_dir():
            shutil.copyfile(reuse / ASSET, self.old)
        else:
            with urllib.request.urlopen(url, timeout=120) as response, self.old.open("xb") as target:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    require(total <= PACKAGE_BYTES, "Download exceeds exact package size")
                    target.write(chunk)
        original = self.verify_old()
        control_tar = self.command("original-control-tar", ["dpkg-deb", "--ctrl-tarfile", str(self.old)]).stdout
        controls = {}
        with tarfile.open(fileobj=io.BytesIO(control_tar)) as archive:
            for entry in archive:
                name = member_name(entry.name)
                if entry.isdir() and name == "":
                    continue
                require(entry.isfile() and name in ("control", "md5sums") and name not in controls,
                        "Unexpected control member/script/conffile")
                controls[name] = archive.extractfile(entry).read()
        require(set(controls) == {"control", "md5sums"}, "Original controls incomplete")
        for pin in self.pin["control"]:
            data = controls[pin["member"]]
            require(len(data) == pin["bytes"] and hashlib.sha256(data).hexdigest() == pin["sha256"],
                    "Original control pin differs")
        fields = control_fields(controls["control"])
        require((fields["Package"], fields["Version"], fields["Architecture"]) == (PACKAGE, OLD, "amd64"),
                "Original package identity differs")
        sums = md5_entries(controls["md5sums"])
        require(set(sums) == RUNTIME | RETIRED, "Original package file set differs")
        files = self.package_payload(self.old, sums)
        for name, record in files.items():
            require(record["md5"] == sums[name], "Original md5 manifest mismatch")
        for pin in self.pin["members"]:
            record = files[pin["member"]]
            require((record["bytes"], record["sha256"]) == (pin["bytes"], pin["sha256"]),
                    "Original selected member pin differs")
        self.command("version-order", ["dpkg", "--compare-versions", NEW, "gt", OLD])
        source, stage = self.root / "original", self.root / "candidate"
        self.command("extract-original", ["dpkg-deb", "--extract", str(self.old), str(source)])
        for name in sorted(RUNTIME):
            require(all(fingerprint(source / name)[k] == v for k, v in files[name].items()
                        if k not in ("uid", "gid")), "Extracted original differs")
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, destination)
        metadata = stage / "DEBIAN"
        metadata.mkdir()
        new_fields = {"Package": PACKAGE, "Version": NEW, "Architecture": "amd64",
            "Maintainer": "Creator Hub Retention Validation <noreply@example.invalid>", "Priority": "optional",
            "Depends": fields["Depends"], "Installed-Size": str((sum(files[n]["bytes"] for n in RUNTIME) + 1023) // 1024),
            "Description": "TEST ONLY - original MCP 2.7.7 runtime compatibility payload\n No launcher or desktop entries; not a published Creator Hub transition."}
        (metadata / "control").write_text("".join(f"{k}: {v}\n" for k, v in new_fields.items()))
        (metadata / "md5sums").write_text("".join(f"{files[n]['md5']}  {n}\n" for n in sorted(RUNTIME)))
        if reuse.is_dir():
            retained = fingerprint(reuse / self.new.name)
            require((retained["bytes"], retained["sha256"]) == (CANDIDATE_BYTES, CANDIDATE_SHA),
                    "Exact immutable candidate from first run required")
            shutil.copyfile(reuse / self.new.name, self.new)
        else:
            self.command("build-candidate", ["dpkg-deb", "--root-owner-group", "-Zxz", "-z1", "--build",
                         str(stage), str(self.new)], timeout=180)
        require(self.package_payload(self.new, RUNTIME) == {n: files[n] for n in RUNTIME},
                "Candidate changed original runtime bytes/modes/ownership")
        candidate_control = self.command("candidate-control", ["dpkg-deb", "--field", str(self.new)]).stdout
        require(control_fields(candidate_control) == new_fields, "Built candidate control differs")
        self.command("ldd-original-node", ["ldd", str(source / (SERVER + "runtime/node"))])
        plan = {"original": original, "originalControl": fields, "candidate": fingerprint(self.new),
                "candidateControl": new_fields, "files": files, "runtime": sorted(RUNTIME), "retired": sorted(RETIRED)}
        if reuse.is_dir():
            plan["reusedImmutableInput"] = {"runId": REUSE_RUN, "artifactId": REUSE_ARTIFACT,
                "sourceRevision": "a0297d5622681b633ce6364d9b97244ffe892416"}
        return self.save("plan", plan)

    def plan(self):
        self.verify_old()
        plan = json.loads((self.root / "plan.json").read_text())
        require(fingerprint(self.new) == plan["candidate"], "Candidate changed after build")
        return plan

    def install(self):
        self.plan()
        state = self.command("initial-package-state", ["dpkg-query", "-W", "-f=${db:Status-Status}", PACKAGE],
                             allowed=(0, 1))
        require(state.returncode == 1, "Pre-existing installation refused")
        require(all(not os.path.lexists("/" + n) for n in RUNTIME | RETIRED), "Pre-existing payload refused")
        self.command("install-public-baseline", ["sudo", "-n", "apt-get", "install", "-y",
                     "--no-install-recommends", str(self.old)], timeout=480)
        return {"installedPublicBaseline": True}

    def snapshot(self, phase):
        require(phase in ("before", "after"), "Unknown capture phase")
        plan = self.plan()
        state = self.command(phase + "-package", ["dpkg-query", "-W",
            "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", PACKAGE]).stdout.decode().strip()
        version = OLD if phase == "before" else NEW
        require(state == f"{PACKAGE}\t{version}\tamd64\tinstall ok installed", "Package state differs")
        listing = self.command(phase + "-file-list", ["dpkg-query", "-L", PACKAGE]).stdout.decode().splitlines()
        expected = RUNTIME | RETIRED if phase == "before" else RUNTIME
        ordinary = {p.lstrip("/") for p in listing if Path(p).is_file()}
        require(ordinary == expected, "Installed regular file set differs")
        records = {}
        for name in sorted(expected):
            record = fingerprint(Path("/" + name))
            require(all(record[k] == v for k, v in plan["files"][name].items()), "Installed member differs: " + name)
            owner = self.command(phase + "-owner-" + str(len(records)), ["dpkg-query", "-S", "/" + name]).stdout.decode().strip()
            require(owner == f"{PACKAGE}: /{name}", "Package ownership differs")
            records[name] = {**record, "owner": owner}
        if phase == "after":
            for index, name in enumerate(sorted(RETIRED)):
                require(not os.path.lexists("/" + name), "Retired file remains")
                result = self.command("after-retired-owner-" + str(index), ["dpkg-query", "-S", "/" + name], allowed=(1,))
                require(not result.stdout, "Retired package ownership remains")
        verification = self.command(phase + "-verify", ["dpkg", "--verify", PACKAGE])
        require(not verification.stdout and not verification.stderr, "dpkg verification reported differences")
        desktop = self.command(phase + "-desktop-discovery", ["/usr/bin/python3", "-B", str(Path(__file__).resolve()), "desktop"])
        discovery = json.loads(desktop.stdout)
        if phase == "before":
            require(discovery == {"id": "Creator Works MCP.desktop", "executable": "creator-works-mcp-launcher"},
                    "Original desktop entry not discoverable")
        else:
            require(discovery is None, "Retired desktop entry still discoverable")
        return self.save(phase, {"packageState": state, "files": records, "desktopDiscovery": discovery,
                                 "dpkgVerifyClean": True})

    def upgrade(self):
        self.plan()
        require((self.root / "before.json").is_file(), "Verified installed baseline required")
        # Fresh disposable baseline; this harness never launches the GUI. Real idle/close remains untested.
        self.command("upgrade-runtime-only", ["sudo", "-n", "dpkg", "--install", str(self.new)], timeout=180)
        return {"dpkgUpgradeCompleted": True}


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("prepare", "install", "before", "upgrade", "after", "desktop"), "Fixed phase required")
    probe = Probe()
    phase = sys.argv[1]
    if phase == "desktop":
        from gi.repository import Gio
        result = desktop_discovery(Gio)
    else:
        result = probe.snapshot(phase) if phase in ("before", "after") else getattr(probe, phase)()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
