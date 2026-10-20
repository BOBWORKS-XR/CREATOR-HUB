"""Disposable DEB installation only. No app launch, migration or updater authority."""
import email.parser
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPOSITORY = "BOBWORKS-XR/CREATOR-HUB"
REPOSITORY_ID = 1364807512
SOURCE = "534465a86554e95b909bf9c7decbbb29cbca5267"
TREE = "db8c7b091d22f598bc789ac97d8d0153c391c8ec"
RUN, ATTEMPT, JOB, ARTIFACT = 39042746816, 1, 117425377351, 12104548664
ARTIFACT_NAME = "signed-unix-hub-linux-39042746816-1"
ZIP_PIN = (179416917, "904b51a0192027ba667702feb4a00721ad2d392fe473540b1f87121c6cacb3de")
DEB_MEMBER = "native-packages/Creator Hub_0.1.14_amd64.deb"
DEB_PIN = (62215944, "06beb134dd2be9fbf08dadbb1a49e97a07ff4e591c56967b8d2cc5b8b844b14f")
HUB = "/usr/bin/creator-hub"
HELPER = "/usr/libexec/creator-hub-deb-retirement-helper"
POLICY = "/usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy"
PROTECTED = {
    HUB: (22058224, "3357f024e3caff3e7563e702838b7e15e08bb8effd7915413e25c444d485ea7d", 0o755),
    HELPER: (1155128, "b3e4603af16c4c0f7b1962af8466e19b70d646f9b93dd35d82ec5c06639dc813", 0o755),
    POLICY: (889, "5eb715286ff8d8cda8e612f8dc9d28d396068b2cdd470a5f3d92d7355e3e37c9", 0o644),
}
BASELINE_ASSET = 608099582
BASELINE_NAME = "Creator.Hub_0.1.12_amd64.deb"
BASELINE_URL = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.12/" + BASELINE_NAME
BASELINE_PIN = (5911218, "a1d20fb23544356d90ab2314b6d430b274220e97d9129815eea731ac39c7ffd2")
IMAGE = "ubuntu:22.04@sha256:08ea48a03a3e78ebc7cd526e6a275053223aadd88bfc09cc49b06d5281525fde"
TEMP = Path("/__w/_temp")
WORKSPACE = Path("/__w/CREATOR-HUB/CREATOR-HUB")
ROOT = TEMP / "linux-installed-candidate"
HOME = Path("/home/fixture")
MAX_DATA, MAX_LOG = 512 * 1024 * 1024, 1024 * 1024
FALSE_GATES = {key: False for key in (
    "nativeGuiAccepted", "migrationAccepted", "authenticationAccepted", "signedUpdateAccepted",
    "restartAccepted", "viewsRestored", "aiClientAccepted", "flatpakAccepted", "releaseReady")}


def require(value, message):
    if not value:
        raise ValueError(message)


def unique_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def pins():
    return dict(repository=REPOSITORY, repositoryId=REPOSITORY_ID, source=SOURCE, tree=TREE,
                run=RUN, attempt=ATTEMPT, job=JOB, artifact=ARTIFACT, artifactName=ARTIFACT_NAME,
                zipBytes=ZIP_PIN[0], zipSha256=ZIP_PIN[1], baselineAsset=BASELINE_ASSET,
                baselineName=BASELINE_NAME, baselineUrl=BASELINE_URL,
                baselineBytes=BASELINE_PIN[0], baselineSha256=BASELINE_PIN[1])


def admission(env, system, machine):
    require(system == "linux" and machine == "x86_64", "Native Linux x86_64 required")
    expected = {
        "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
        "RUNNER_ARCH": "X64", "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_REPOSITORY_ID": str(REPOSITORY_ID),
        "GITHUB_REF": "refs/heads/validation/linux-installed-candidate-014",
        "CREATOR_LINUX_INSTALLED_CANDIDATE": "1", "CREATOR_LINUX_INSTALLED_IMAGE": IMAGE,
        "RUNNER_TEMP": str(TEMP), "GITHUB_WORKSPACE": str(WORKSPACE), "HOME": str(HOME),
        "XDG_CONFIG_HOME": str(HOME / ".config"), "XDG_DATA_HOME": str(HOME / ".local/share"),
    }
    require(all(env.get(key) == value for key, value in expected.items()), "Exact opted-in disposable CI admission required")
    require(env.get("GITHUB_EVENT_NAME") in ("workflow_dispatch", "push"), "Only manual or scoped push CI events admitted")
    require(env.get("CREATOR_LINUX_INSTALL_LANE") in ("fresh", "public12"), "Unknown install lane")
    require(re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")), "Test source commit required")
    require(not any(env.get(key) for key in ("FLATPAK_ID", "APPIMAGE", "APPDIR", "DISPLAY", "WAYLAND_DISPLAY")),
            "No sandbox or GUI session admitted")


def ordinary(path):
    path = Path(path)
    require(path.is_absolute() and os.path.normpath(str(path)) == str(path) and path.resolve() == path,
            "Unredirected canonical absolute path required")
    return path


def record(path, limit=MAX_DATA):
    path = ordinary(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                 | getattr(os, "O_BINARY", 0))
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit,
                "Bounded ordinary single-link file required")
        digest, size = hashlib.sha256(), 0
        while chunk := os.read(fd, 65536):
            size += len(chunk)
            require(size <= limit, "File grew beyond bound")
            digest.update(chunk)
        after, named = os.fstat(fd), path.stat()
        fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns")
        # Windows pure fixtures have different deprecated stat/fstat ctime semantics.
        if os.name != "nt":
            fields += ("st_ctime_ns",)
        require(all(getattr(before, key) == getattr(after, key) == getattr(named, key) for key in fields)
                and size == before.st_size, "File identity changed while hashing")
        return dict(size=size, sha256=digest.hexdigest(), mode=stat.S_IMODE(after.st_mode),
                    uid=after.st_uid, gid=after.st_gid, links=after.st_nlink,
                    device=str(after.st_dev), inode=str(after.st_ino),
                    mtimeNs=str(after.st_mtime_ns), ctimeNs=str(after.st_ctime_ns))
    finally:
        os.close(fd)


def pinned(path, pin):
    result = record(path, pin[0])
    require((result["size"], result["sha256"]) == pin, "Pinned bytes differ: " + Path(path).name)
    return result


def write_json(path, value):
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    require(len(data) <= MAX_LOG, "Report exceeds bound")
    with Path(path).open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def validate_source(binding):
    run, artifact, job, commit, baseline = (binding[key] for key in ("run", "artifact", "job", "commit", "baseline"))
    for value in (run["id"], run["run_attempt"], run["repository"]["id"], artifact["id"],
                  artifact["size_in_bytes"], job["id"], job["run_id"], job["run_attempt"], baseline["id"], baseline["size"]):
        require(type(value) is int, "Canonical API integers required")
    require(run["id"] == RUN and run["run_attempt"] == ATTEMPT and run["head_sha"] == SOURCE
            and run["repository"]["id"] == REPOSITORY_ID and run["status"] == "completed"
            and run["conclusion"] == "success" and run["event"] == "workflow_dispatch"
            and run["head_branch"] == "validation/linux-retirement-candidate-014"
            and run["path"] == ".github/workflows/unix-managed-assembly.yml", "Original assembly run differs")
    require(artifact["id"] == ARTIFACT and artifact["name"] == ARTIFACT_NAME and artifact["expired"] is False
            and artifact["size_in_bytes"] == ZIP_PIN[0] and artifact["digest"] == "sha256:" + ZIP_PIN[1],
            "Original artifact differs")
    arun = artifact["workflow_run"]
    require(arun["id"] == RUN and arun["head_sha"] == SOURCE and arun["repository_id"] == REPOSITORY_ID
            and arun["head_repository_id"] == REPOSITORY_ID, "Artifact producer differs")
    require(job["id"] == JOB and job["run_id"] == RUN and job["run_attempt"] == ATTEMPT
            and job["conclusion"] == "success" and job["name"].startswith("assembly (linux,"), "Native job differs")
    require(commit["sha"] == SOURCE and commit["tree"]["sha"] == TREE, "Original source tree differs")
    require(baseline["id"] == BASELINE_ASSET and baseline["name"] == BASELINE_NAME
            and baseline["size"] == BASELINE_PIN[0] and baseline["state"] == "uploaded"
            and baseline["browser_download_url"] == BASELINE_URL and binding["baselineRelease"] == {
                "tag_name": "v0.1.12", "draft": False, "prerelease": False}, "Exact public baseline differs")
    require(binding["baselineRelease"]["draft"] is False and binding["baselineRelease"]["prerelease"] is False,
            "Canonical public release flags required")


def stage_zip(source, target):
    before = pinned(source, ZIP_PIN)
    with zipfile.ZipFile(source) as archive:
        names, total, selected = set(), 0, None
        for member in archive.infolist():
            name = member.orig_filename
            require(name == member.filename and "\\" not in name and not name.startswith("/")
                    and all(part not in ("", ".", "..") for part in name.rstrip("/").split("/"))
                    and not re.search(r"[\x00-\x1f\x7f]", name), "Noncanonical original ZIP member")
            require(name not in names and len(names) < 128, "Duplicate or excessive ZIP members")
            names.add(name)
            kind = stat.S_IFMT(member.external_attr >> 16)
            require(kind in (0, stat.S_IFREG, stat.S_IFDIR) and not member.flag_bits & 1,
                    "ZIP links, special or encrypted entries refused")
            total += member.file_size
            require(0 <= member.file_size <= MAX_DATA and total <= MAX_DATA, "ZIP expansion exceeds bound")
            if name == DEB_MEMBER:
                require(not member.is_dir() and member.file_size == DEB_PIN[0], "Wrong candidate DEB size")
                selected = member
        require(selected is not None, "Exact candidate DEB missing from original ZIP")
        with archive.open(selected) as input_, Path(target).open("xb") as output:
            os.chmod(target, 0o600)
            size = 0
            while chunk := input_.read(65536):
                size += len(chunk)
                require(size <= DEB_PIN[0], "DEB expansion exceeds pin")
                output.write(chunk)
    pinned(target, DEB_PIN)
    require(pinned(source, ZIP_PIN) == before, "Original ZIP changed while staging")


def verifier():
    spec = importlib.util.spec_from_file_location("installed_candidate_retirement_audit", HERE / "linux-retirement-package-verify.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def control_inventory(stream, version, v):
    result, bodies = {}, {}
    for name, member, archive in v.members(stream):
        require(name in ("control", "md5sums") and member.isfile() and member.uid == member.gid == 0
                and member.mode == 0o644 and member.size <= 128 * 1024,
                "No maintainer scripts, triggers, conffiles or other control members admitted")
        body = archive.extractfile(member).read()
        bodies[name] = body
        result[name] = dict(size=len(body), sha256=hashlib.sha256(body).hexdigest(), mode=member.mode, uid=0, gid=0)
    require(set(bodies) == {"control", "md5sums"}, "Complete control inventory required")
    fields = email.parser.Parser().parsestr(bodies["control"].decode("utf-8"))
    require(not fields.defects and all(len(fields.get_all(key)) == 1 for key in fields.keys()), "Malformed/duplicate DEB control")
    require(fields["Package"] == "creator-hub" and fields["Version"] == version
            and fields["Architecture"] == "amd64", "Package identity differs")
    require(not any(key in fields for key in ("Pre-Depends", "Conflicts", "Breaks", "Replaces", "Conffiles")),
            "Unexpected transaction relationship")
    result["fields"] = dict(fields)
    return result


def data_inventory(stream, v):
    result, directories = {}, {}
    for name, member, archive in v.members(stream):
        require(name.startswith("usr/") or name == "usr", "Only fixed /usr package data admitted")
        require(member.uid == member.gid == 0, "Every package member must be root-owned")
        if member.isdir():
            require(member.mode == 0o755, "Protected package directory mode differs")
            directories["/" + name] = dict(mode=member.mode, uid=0, gid=0)
            continue
        require(member.mode in (0o644, 0o755), "Unexpected special/write file mode")
        digest, size = hashlib.sha256(), 0
        with archive.extractfile(member) as input_:
            while chunk := input_.read(65536):
                size += len(chunk)
                require(size <= member.size, "Package member grew")
                digest.update(chunk)
        require(size == member.size, "Truncated package member")
        result["/" + name] = dict(size=size, sha256=digest.hexdigest(), mode=member.mode, uid=0, gid=0)
    require(HUB in result and len(result) <= 128, "Hub package inventory required")
    return dict(files=result, directories=directories)


def audit_deb(package, version):
    pin = DEB_PIN if version == "0.1.14" else BASELINE_PIN
    require(version in ("0.1.12", "0.1.14"), "Unreviewed version")
    before, v, result = pinned(package, pin), verifier(), {}
    if version == "0.1.14":
        # Reuse the original strict helper/policy/control audit, without altered validators.
        result["retirementAudit"] = v.verify(str(package), PROTECTED[HELPER][1], PROTECTED[POLICY][1], version)
    for argument, key in (("--ctrl-tarfile", "control"), ("--fsys-tarfile", "data")):
        with tempfile.TemporaryFile() as output:
            process = subprocess.run(["/usr/bin/dpkg-deb", argument, str(package)], stdout=output,
                                     stderr=subprocess.PIPE, env=clean_env(), cwd="/", timeout=120, check=False)
            require(process.returncode == 0 and not process.stderr and output.tell() <= MAX_DATA,
                    "Read-only DEB inspection failed")
            output.seek(0)
            result[key] = control_inventory(output, version, v) if key == "control" else data_inventory(output, v)
    if version == "0.1.14":
        for name, pin_ in PROTECTED.items():
            require(result["data"]["files"][name] == dict(size=pin_[0], sha256=pin_[1], mode=pin_[2], uid=0, gid=0),
                    "Protected packaged bytes differ")
    require(pinned(package, pin) == before, "Package changed during inspection")
    return dict(package=before, version=version, **result)


def clean_env():
    return {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(HOME),
            "XDG_CONFIG_HOME": str(HOME / ".config"), "XDG_DATA_HOME": str(HOME / ".local/share")}


def capture(label, args, timeout=120):
    require(re.fullmatch(r"[a-z0-9-]+", label), "Fixed capture label required")
    stdout, stderr = ROOT / (label + ".stdout"), ROOT / (label + ".stderr")
    try:
        with stdout.open("xb") as out, stderr.open("xb") as err:
            os.chmod(stdout, 0o600)
            os.chmod(stderr, 0o600)
            process = subprocess.run(args, stdout=out, stderr=err, env=clean_env(), cwd="/", timeout=timeout, check=False)
        result = dict(argv=args, exitCode=process.returncode, stdout=record(stdout, MAX_LOG), stderr=record(stderr, MAX_LOG))
    except subprocess.TimeoutExpired:
        result = dict(argv=args, timedOut=True, stdout=record(stdout, MAX_LOG), stderr=record(stderr, MAX_LOG))
        write_json(ROOT / (label + ".json"), result)
        raise
    write_json(ROOT / (label + ".json"), result)
    return process.returncode, stdout.read_bytes(), stderr.read_bytes()


def package_status(version, label):
    code, out, err = capture(label, ["/usr/bin/dpkg-query", "--show", "--showformat=${Status}\n${Version}\n${Architecture}\n", "creator-hub"])
    require(code == 0 and not err and out == f"install ok installed\n{version}\namd64\n".encode(),
            "Installed dpkg status/version/architecture differs")


def installed_records(inventory):
    result = {}
    for name, wanted in inventory["directories"].items():
        current = ordinary(name).lstat()
        require(stat.S_ISDIR(current.st_mode) and dict(mode=stat.S_IMODE(current.st_mode), uid=current.st_uid,
                gid=current.st_gid) == wanted, "Installed protected package directory differs: " + name)
    for name, wanted in inventory["files"].items():
        current = record(name, wanted["size"])
        require({key: current[key] for key in wanted} == wanted, "Installed package bytes/ownership/mode differ: " + name)
        # Recheck every ancestor; no redirect or user-writable protected installation path.
        for parent in Path(name).parents:
            entry = ordinary(parent).lstat()
            require(stat.S_ISDIR(entry.st_mode) and entry.st_uid == entry.st_gid == 0
                    and not stat.S_IMODE(entry.st_mode) & 0o022, "Unprotected installed ancestor")
        result[name] = current
    return result


def snapshot(home):
    home = ordinary(home)
    result, total = {}, 0
    for directory, dirs, files in os.walk(home, followlinks=False):
        require(len(dirs) + len(files) <= 128, "Fixture directory exceeds bound")
        for item in [Path(directory), *(Path(directory) / name for name in sorted(files))]:
            require(len(result) < 256, "Fixture inventory exceeds bound")
            entry = item.lstat()
            require(not item.is_symlink() and (stat.S_ISREG(entry.st_mode) or stat.S_ISDIR(entry.st_mode)),
                    "Fixture links/special entries refused")
            if item.is_file():
                row = record(item, 1024 * 1024)
                total += row["size"]
                require(total <= 16 * 1024 * 1024, "Fixture data exceeds bound")
            else:
                row = dict(mode=stat.S_IMODE(entry.st_mode), uid=entry.st_uid, gid=entry.st_gid,
                           device=str(entry.st_dev), inode=str(entry.st_ino),
                           mtimeNs=str(entry.st_mtime_ns), ctimeNs=str(entry.st_ctime_ns))
            result[item.relative_to(home).as_posix()] = row
        for name in dirs:
            require(not (Path(directory) / name).is_symlink(), "Fixture directory link refused")
    return result


def fixture_bytes():
    project = str(HOME / "Projects/Unity Fixture")
    server = str(HOME / ".local/share/creator-works-mcp/retained-runtime/server.mjs")
    clients = {"mcpServers": {"creator-works": {"command": "node", "args": [server], "env": {
        "UNITY_PROJECT_PATH": project}}, "unrelated-kept": {"command": "/fixture/not-executed", "args": ["keep-me"]}}}
    config = (json.dumps({"unityProject": project, "projects": [project], "fixtureUnknownField": "preserve"}) + "\n").encode()
    output = {
        ".config/creator-works-mcp/launcher-config.json": config,
        ".config/banter-mcp/launcher-config.json": b'{"legacySetting":"keep-original"}\n',
        ".local/share/CreatorProjectSetup/editor-roots.json": b'["/fixture/unity/editor"]\n',
        ".local/share/CreatorHub/preferences/hub-preferences.json": b'{"includePrereleases":true,"reopenHostedApps":true}\n',
        ".local/share/CreatorHub/consent/hub-usage-terms.json": b'{"fixtureAcknowledgement":"preserve"}\n',
        ".config/Claude/claude_desktop_config.json": (json.dumps(clients) + "\n").encode(),
        ".claude.json": (json.dumps(clients) + "\n").encode(),
        ".codex/config.toml": f'[mcp_servers.creator-works]\ncommand = "node"\nargs = ["{server}"]\n\n[mcp_servers.unrelated-kept]\ncommand = "/fixture/not-executed"\n'.encode(),
        ".local/share/creator-works-mcp/retained-runtime/server.mjs": b"// Synthetic retained server; never executed.\n",
        ".cache/creator-hub/fixture-cache.json": b'{"cacheSentinel":"preserve"}\n',
        "Projects/Unity Fixture/ProjectSettings/ProjectVersion.txt": b"m_EditorVersion: 6000.3.21f1\n",
        "Projects/Unity Fixture/Packages/manifest.json": b'{"dependencies":{},"fixtureSentinel":"preserve"}\n',
        "Projects/Unity Fixture/Assets/DoNotChange.cs": b"// Synthetic project sentinel; never opened in Unity.\n",
    }
    output[".config/creator-works-mcp/.creator-hub-settings-backups/launcher-config.json." +
           hashlib.sha256(config).hexdigest() + ".bak"] = config
    return output


def seed_fixtures(home):
    for name, data in fixture_bytes().items():
        target = home / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with target.open("xb") as output:
            os.chmod(target, 0o600)
            output.write(data)
    return snapshot(home)


def require_preserved(home, before):
    after = snapshot(home)
    require(after == before, "Fixture bytes, ownership, modes, identity, timestamps or inventory changed")
    return after


def native_admission():
    admission(os.environ, sys.platform, platform.machine())
    require(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 1001 and Path("/.dockerenv").is_file(),
            "Unprivileged fixture 1001 inside the pinned disposable container required")
    distro = Path("/etc/os-release").read_text()
    require('\nID=ubuntu\n' in '\n' + distro and 'VERSION_ID="22.04"' in distro, "Ubuntu 22.04 required")
    for directory in (TEMP, WORKSPACE, HOME):
        entry = ordinary(directory).lstat()
        require(stat.S_ISDIR(entry.st_mode) and entry.st_uid == entry.st_gid == 1001, "Fixed fixture directory ownership differs")


def install(package, audited, version, label):
    # Inspect again immediately before the fixed privileged transaction. No repair or retry.
    require(audit_deb(package, version) == audited, "Candidate changed after reviewed pre-install inspection")
    code, _, _ = capture(label, ["/usr/bin/sudo", "--non-interactive", "--", "/usr/bin/dpkg", "--install", str(package)], 600)
    require(code == 0, "dpkg install failed; no repair, uninstall or automatic retry")
    package_status(version, label + "-status")
    code, out, err = capture(label + "-verify", ["/usr/bin/dpkg", "--verify", "creator-hub"])
    require(code == 0 and not out and not err, "dpkg verification differs")
    installed = installed_records(audited["data"])
    write_json(ROOT / (label + "-installed.json"), installed)
    return installed


def diagnostics():
    output = dict(protected={}, **FALSE_GATES)
    for name in PROTECTED:
        try:
            output["protected"][name] = record(name)
        except (OSError, ValueError) as error:
            output["protected"][name] = dict(error=str(error)[:1000])
    write_json(ROOT / "final-protected.json", output)
    capture("final-package-status", ["/usr/bin/dpkg-query", "--show", "--showformat=${Package}\t${Status}\t${Version}\t${Architecture}\n",
                                     "creator-hub", "creator-works-mcp", "creator-project-setup"])
    capture("final-dpkg-verify", ["/usr/bin/dpkg", "--verify", "creator-hub"])


def run():
    native_admission()
    ROOT.mkdir(mode=0o700)
    (ROOT / "input").mkdir(mode=0o700)
    result = dict(schemaVersion=1, scope="disposable-dpkg-install-only", lane=os.environ["CREATOR_LINUX_INSTALL_LANE"],
                  productSource=SOURCE, productTree=TREE, productRun=RUN, productAttempt=ATTEMPT,
                  productArtifact=ARTIFACT, testSource=os.environ["GITHUB_SHA"],
                  freshInstallAccepted=False, manualPreviousPublicUpgradeAccepted=False,
                  settingsFixturesPreserved=False, **FALSE_GATES)
    try:
        for label, executable in (("dpkg-toolchain", "/usr/bin/dpkg"), ("dpkg-deb-toolchain", "/usr/bin/dpkg-deb")):
            code, out, err = capture(label, [executable, "--version"])
            require(code == 0 and out and not err, "Native dpkg toolchain capture failed")
        source_path = TEMP / "linux-installed-candidate-source.json"
        require(record(source_path, 196608)["size"] > 0, "Source binding required")
        binding = unique_json(source_path.read_bytes())
        validate_source(binding)
        write_json(ROOT / "source-binding.json", binding)
        candidate = ROOT / "input/candidate.deb"
        stage_zip(TEMP / "linux-installed-candidate-original.zip", candidate)
        audited = audit_deb(candidate, "0.1.14")
        write_json(ROOT / "candidate-preinstall-audit.json", audited)
        code, out, _ = capture("before-package-state", ["/usr/bin/dpkg-query", "--show", "--showformat=${db:Status-Abbrev}",
                                                       "creator-hub", "creator-works-mcp", "creator-project-setup"])
        require(code == 1 and not out, "Fresh container must have no current or legacy product registrations")
        require(not any(Path(name).exists() or Path(name).is_symlink() for name in PROTECTED),
                "No existing protected candidate files admitted")
        # Admit and record the CI-only elevation path before taking user-fixture snapshots.
        # This is not native polkit authentication or application consent acceptance.
        code, out, err = capture("sudo-dpkg-toolchain", ["/usr/bin/sudo", "--non-interactive", "--", "/usr/bin/dpkg", "--version"])
        require(code == 0 and out and not err, "Fixed disposable sudo/dpkg preflight failed")
        before = seed_fixtures(HOME)
        write_json(ROOT / "fixtures-before.json", before)
        if result["lane"] == "public12":
            baseline = TEMP / "linux-installed-candidate-baseline12.deb"
            baseline_audit = audit_deb(baseline, "0.1.12")
            write_json(ROOT / "baseline12-preinstall-audit.json", baseline_audit)
            install(baseline, baseline_audit, "0.1.12", "baseline12-install")
            write_json(ROOT / "fixtures-after12.json", require_preserved(HOME, before))
        installed = install(candidate, audited, "0.1.14", "candidate14-install")
        write_json(ROOT / "fixtures-after14.json", require_preserved(HOME, before))
        result.update(installedProtected={name: installed[name] for name in PROTECTED}, settingsFixturesPreserved=True,
                      freshInstallAccepted=result["lane"] == "fresh",
                      manualPreviousPublicUpgradeAccepted=result["lane"] == "public12")
    except Exception as error:
        result["failure"] = dict(type=type(error).__name__, message=str(error)[:2000])
        raise
    finally:
        try:
            diagnostics()
        except Exception as error:
            result["diagnosticFailure"] = dict(type=type(error).__name__, message=str(error)[:2000])
            result["freshInstallAccepted"] = result["manualPreviousPublicUpgradeAccepted"] = False
        try:
            if "before" in locals():
                final_fixtures = snapshot(HOME)
                write_json(ROOT / "fixtures-final.json", final_fixtures)
                require(final_fixtures == before, "Final fixture preservation differs")
        except Exception as error:
            result["finalFixtureFailure"] = dict(type=type(error).__name__, message=str(error)[:2000])
            result["freshInstallAccepted"] = result["manualPreviousPublicUpgradeAccepted"] = False
            result["settingsFixturesPreserved"] = False
        write_json(ROOT / "report.json", result)
    require("diagnosticFailure" not in result and "finalFixtureFailure" not in result, "Final diagnostics incomplete")
    return result


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("pins", "run"), "Use pins or run; no paths, URLs or installer overrides")
        print(json.dumps(pins() if sys.argv[1] == "pins" else run(), sort_keys=True))
    except (ValueError, OSError, KeyError, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
