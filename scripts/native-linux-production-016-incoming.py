"""Finite disposable DEB installation/page qualification, not update or retirement.

No product build, live-account settings, authentication, package restoration or
action retry. The only WebView script writes three fixed synthetic old-Hub
preference keys while its unaccepted terms modal blocks application startup.
"""
import email.parser
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BRANCH = "refs/heads/validation/native-linux-production-016"
WORKFLOW = "BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-incoming.yml@" + BRANCH
SCENARIOS = ("fresh16", "public012-to16")
BASE = Path("/opt/creator-incoming-016-fixture")
HUB = "/usr/bin/creator-hub"
TITLE = "Creator Hub - Development Preview"
INPUT = "native-linux-production-016-input"
STAGE = "native-linux-production-016-stage"
RESULT = "native-linux-production-016-incoming"
TERMS = "data/CreatorHub/consent/hub-usage-terms.json"
PREFERENCES = "data/CreatorHub/preferences/hub-preferences.json"
CONFIG = "config/creator-works-mcp/launcher-config.json"
JOURNAL = "config/creator-works-mcp/hosted-operation-outcomes.json"
FLAGS = dict.fromkeys(("freshInstallAccepted", "manualPublic012UpgradeAccepted", "directPagesObserved",
                      "manualReopenObserved", "preservationAccepted", "migrationAccepted", "authenticationAccepted",
                      "signedUpdateAccepted", "automaticRestartAccepted", "flatpakAccepted", "liveAiAccepted",
                      "unityAccepted", "releaseReady"), False)
PROFILE = {
    "schemaVersion": 1, "cohort": "production-migration-016", "mode": "pages",
    "assembly": {"sourceCommit": "4d9e073465928b9e00719d5ba594343281cd1280",
                 "sourceTree": "e338ffaea6ab359fb37a212f96ac2d6172b6484c", "runId": 39430509970,
                 "runAttempt": 1, "jobId": 118654160337, "artifactId": 12268801490, "zipBytes": 183661772,
                 "zipSha256": "ffc211f64dd131f926cc3b47bdb93513aa8c2096afbc08f8a0968517f139016d"},
    "pins": {
        "rawHub": {"size": 28808088, "sha256": "b3ec9649a072de2fd229bce70533427b128f6ec0c8eb17445ac0bae03158daba"},
        "deb": {"size": 64351274, "sha256": "73497fcf96112e85427f8ba92ff2dcc1816e7f95a6d3a0fe9f8be1893f951d18"},
        "hub": {"size": 28808088, "sha256": "bb7087c07ea4b68c70c1e6f7c6630f83199950d0af8158c9541d6ed317dc6811"},
        "manifest": {"size": 3663, "sha256": "d52dc1f5fd6ef4ce373db605411fb53a93aa45bbd1cf4d72994ffe07e22c41a3"},
        "modulesArchive": {"size": 55566243, "sha256": "5dc48637de643ff52d09fbfbf7dd4e258116646d6cf44ea58b1679237c3a8fb0"},
        "assemblyReceipt": {"size": 3547, "sha256": "fd4def1a2fbf3a5610b91fcfc21bdb22e2580323697bf083bf2699aad0cd6db7"},
        "packageIntegrity": {"size": 2151, "sha256": "434f1fb84746bb8d547c6efbc12d1387d4faa84d371b7c23a31da1f7cb221770"},
        "helper": {"size": 1168536, "sha256": "7f22822e50ee8b96829c64c95da9e1b098c3e080a1370f577ae2b69055eed94a"},
        "policy": {"size": 878, "sha256": "f4819f08e0a96e98d10a449a82a26b4f59d69714460eb9082387f746e1889bb4"},
        "service": {"size": 92, "sha256": "9a270a39c219b4f2d294cfaa2a849db84b1e1883fa532d2c90d7f95625780340"}}}
BASELINE = {"releaseId": 402585934, "assetId": 608099582, "tagObject": "4c11a9ebaf5076fe0b051455b35b7d2dce48c119",
            "source": "35a16a45814d821d65b5d203628478449174cd55", "name": "Creator.Hub_0.1.12_amd64.deb",
            "size": 5911218, "sha256": "a1d20fb23544356d90ab2314b6d430b274220e97d9129815eea731ac39c7ffd2"}
INSPECTION = {"run": 39435273515, "job": 118670553277, "workflow": 389992948,
              "artifact": 12270560239, "size": 5438,
              "sha256": "5d7214eae45ecffd23a499ecd9aa2c92f087265197baf5605c96e3fc365044cf",
              "source": "19440127394abe5d5fddc333df009aa3ffe1528d"}
PREF_KEYS = ("creator-hub.preview", "creator-hub.auto-download", "creator-hub.restore-hosted-views")
PREF_IDS = ("preview-channel", "auto-download", "restore-hosted-views")
# https://github.com/BOBWORKS-XR/CREATOR-HUB/blob/35a16a45814d821d65b5d203628478449174cd55/src/app.js
# Fixed fixture initialization only. No parameters, native IPC, shell authority,
# arbitrary script input, settings file access, credentials or other storage keys.
INITIALIZE_012_STORAGE = """localStorage.setItem('creator-hub.preview', 'false');
localStorage.setItem('creator-hub.auto-download', 'false');
localStorage.setItem('creator-hub.restore-hosted-views', 'false');
return ['creator-hub.preview', 'creator-hub.auto-download', 'creator-hub.restore-hosted-views'].map(k => localStorage.getItem(k));"""
SOURCES = (Path(__file__).name, "native-linux-production-016-stage.py", "native-linux-016-stage.py",
           "native-linux-016-pages.py", "native-linux-integrated-pages.py", "native-linux-root-probe.py",
           "native-unix-window.py", "linux-retirement-package-verify.py")
CONTEXT = ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF", "GITHUB_EVENT_NAME",
           "GITHUB_WORKFLOW_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE",
           "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "CREATOR_INCOMING_016_EXECUTE",
           "CREATOR_INCOMING_016_SCENARIO", "CREATOR_NATIVE_LINUX_PRODUCTION_016")


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


P = load("native-linux-production-016-stage")
require, parse, digest = P.require, P.parse, P.digest


def admission(env, *, system=None, uid=None):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB",
                "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_WORKFLOW_REF": WORKFLOW, "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
                "RUNNER_ARCH": "X64", "CREATOR_INCOMING_016_EXECUTE": "true", "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1"}
    require((sys.platform if system is None else system) == "linux"
            and type(os.getuid() if uid is None else uid) is int
            and all(env.get(k) == v for k, v in expected.items()), "Exact manually opted-in incoming workflow required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", ""))
            and all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "Harness source/run required")
    require(env.get("CREATOR_INCOMING_016_SCENARIO") in SCENARIOS, "One finite fresh scenario required")
    require(not any(k.startswith(("LD_", "DYLD_", "WEBKIT_", "TAURI_")) or k in
                    ("NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "SSL_CERT_FILE", "SSL_CERT_DIR") for k in env), "Injected runtime refused")
    require(not any(env.get(k) for k in ("APPIMAGE", "APPDIR", "FLATPAK_ID")), "Native DEB only")
    return env["CREATOR_INCOMING_016_SCENARIO"]


def same(actual, expected, message):
    require(type(actual) is type(expected), message)
    if isinstance(expected, dict):
        require(actual.keys() == expected.keys(), message)
        for key in expected:
            same(actual[key], expected[key], message)
    elif isinstance(expected, list):
        require(len(actual) == len(expected), message)
        for left, right in zip(actual, expected):
            same(left, right, message)
    else:
        require(actual == expected, message)


def file_stamp(info):
    # Windows named stat reports birth time here; its fstat reports change time.
    # Native execution is Linux-only and retains the complete change-time guard.
    fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_nlink", "st_uid", "st_gid", "st_mtime_ns")
    if sys.platform == "linux":
        fields += ("st_ctime_ns",)
    return tuple(getattr(info, key) for key in fields)


def read(file, limit=262144, *, uid=None, mode=None):
    file = Path(file)
    require(file.resolve() == file, "Redirected input")
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit
            and (uid is None or before.st_uid == uid) and (mode is None or stat.S_IMODE(before.st_mode) == mode), "Unbounded/foreign input")
    stamp = file_stamp
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    with os.fdopen(os.open(file, flags), "rb") as stream:
        require(stamp(os.fstat(stream.fileno())) == stamp(before), "Input changed before read")
        body = stream.read(limit + 1)
        require(len(body) == before.st_size and stamp(os.fstat(stream.fileno())) == stamp(before), "Input changed during read")
    require(stamp(file.lstat()) == stamp(before), "Input pathname changed")
    return body


def pin(body):
    return {"size": len(body), "sha256": digest(body)}


def save(file, value, mode=0o600):
    P.write(file, json.dumps(value, allow_nan=False).encode(), mode)


def validate_api(value):
    P.S.keys(value, ("inspectionRun", "inspectionJob", "inspectionArtifact", "release", "asset", "tag", "tagObject"))
    run, job, artifact = (value[k] for k in ("inspectionRun", "inspectionJob", "inspectionArtifact"))
    require(all(type(n) is int for n in (run["id"], run["run_attempt"], run["workflow_id"], run["repository"]["id"],
                                        job["id"], job["run_id"], job["run_attempt"], artifact["id"], artifact["size_in_bytes"])), "Canonical inspection API integers required")
    require(run["id"] == INSPECTION["run"] and run["run_attempt"] == 1 and run["workflow_id"] == INSPECTION["workflow"]
            and run["head_sha"] == INSPECTION["source"] and run["head_branch"] == BRANCH.removeprefix("refs/heads/")
            and run["path"] == ".github/workflows/native-linux-production-016.yml" and run["event"] == "workflow_dispatch"
            and run["repository"]["id"] == 1364807512 and run["status"] == "completed" and run["conclusion"] == "success", "Original production inspection run differs")
    require(job["id"] == INSPECTION["job"] and job["run_id"] == run["id"] and job["run_attempt"] == 1
            and job["status"] == "completed" and job["conclusion"] == "success", "Original inspection job differs")
    require(artifact["id"] == INSPECTION["artifact"] and artifact["name"] == "native-linux-production-016-inspection-39435273515-1"
            and artifact["size_in_bytes"] == INSPECTION["size"] and artifact["digest"] == "sha256:" + INSPECTION["sha256"]
            and artifact["expired"] is False and artifact["workflow_run"]["id"] == run["id"]
            and artifact["workflow_run"]["head_sha"] == run["head_sha"]
            and artifact["workflow_run"]["repository_id"] == artifact["workflow_run"]["head_repository_id"] == 1364807512,
            "Original inspection artifact differs")
    release, asset, tag, tag_object = (value[k] for k in ("release", "asset", "tag", "tagObject"))
    require(release["id"] == BASELINE["releaseId"] and release["tag_name"] == "v0.1.12"
            and release["draft"] is False and release["prerelease"] is False, "Exact public 012 release required")
    require(tag["ref"] == "refs/tags/v0.1.12" and tag["object"]["type"] == "tag" and tag["object"]["sha"] == BASELINE["tagObject"]
            and tag_object["sha"] == BASELINE["tagObject"] and tag_object["tag"] == "v0.1.12"
            and tag_object["object"] == {"type": "commit", "sha": BASELINE["source"],
                                        "url": "https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/git/commits/" + BASELINE["source"]}, "Public 012 tag moved")
    matches = [a for a in release["assets"] if a["name"] == BASELINE["name"]]
    require(len(matches) == 1 and matches[0] == asset and asset["id"] == BASELINE["assetId"]
            and asset["size"] == BASELINE["size"] and asset["digest"] == "sha256:" + BASELINE["sha256"]
            and asset["state"] == "uploaded" and asset["browser_download_url"] ==
            "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.12/" + BASELINE["name"], "Exact public 012 asset differs")


def validate_binding(binding, env):
    P.S.keys(binding, ("schemaVersion", "cohort", "inspectionOnly", "profile", "api", "productionProof", "packageFiles", "resourceFiles", *P.FLAGS))
    same(binding["profile"], PROFILE, "Frozen production profile differs")
    require(binding["schemaVersion"] == 1 and type(binding["schemaVersion"]) is int and binding["cohort"] == P.COHORT
            and binding["inspectionOnly"] is True and all(binding[k] is False for k in P.FLAGS), "Inspection is not execution acceptance")
    P.api_binding(binding["api"], PROFILE, env["GITHUB_SHA"])
    proof = binding["productionProof"]
    same(proof["compiledFeatures"], P.FEATURES, "Production features differ")
    require(proof["sourceCommit"] == PROFILE["assembly"]["sourceCommit"] and proof["sourceTree"] == PROFILE["assembly"]["sourceTree"]
            and proof["rawHub"] == PROFILE["pins"]["rawHub"] and proof["hub"] == PROFILE["pins"]["hub"]
            and proof["rawToPackaged"] == "exact-tauri-bundle-marker-deb" and all(proof[k] is False for k in P.FLAGS), "Production proofs differ")
    for name, entry in binding["packageFiles"].items():
        P.S.safe_name(name)
        P.S.keys(entry, ("size", "sha256", "mode"))
        require(name.startswith("usr/") and type(entry["size"]) is int and 0 < entry["size"] <= 256 * 1024 * 1024
                and re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]) and type(entry["mode"]) is int and entry["mode"] in (0o644, 0o755), "Invalid package inventory")
    require(binding["packageFiles"][HUB[1:]] == {**PROFILE["pins"]["hub"], "mode": 0o755}, "Fixed Root missing")


def process_environment(env):
    return {**{k: env[k] for k in CONTEXT}, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


def tool(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=120,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"})
    require(len(result.stdout) <= 1048576 and len(result.stderr) <= 65536, "Tool output exceeds bound")
    require(result.returncode == 0, "Fixed tool failed: " + args[0] + ": " + result.stderr.decode("utf-8", "replace")[:700])
    return result.stdout


def no_legacy_packages():
    for package, file in (("creator-works-mcp", "/usr/bin/creator-works-mcp-launcher"), ("creator-project-setup", "/usr/bin/creator-project-setup")):
        result = subprocess.run(["/usr/bin/dpkg-query", "-W", "-f=${Status}", package], capture_output=True, check=False)
        require(result.returncode == 1 and not result.stdout and not os.path.lexists(file), "Standalone package present; incoming is not retirement")


def installed(files, version):
    require(tool(["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", "creator-hub"])
            == f"creator-hub\t{version}\tamd64\tinstall ok installed\n".encode(), "Installed Hub identity differs")
    require(not tool(["/usr/bin/dpkg", "--verify", "creator-hub"]), "Installed Hub integrity differs")
    for name, expected in files.items():
        file = Path("/") / name
        body = read(file, 256 * 1024 * 1024, uid=0, mode=expected["mode"])
        require(file.stat().st_gid == 0 and pin(body) == {k: expected[k] for k in ("size", "sha256")}, "Installed bytes differ: " + name)
    no_legacy_packages()


def audit_baseline(package):
    require(pin(read(package, BASELINE["size"])) == {k: BASELINE[k] for k in ("size", "sha256")}, "Public DEB bytes differ")
    result = {}
    for argument in ("--ctrl-tarfile", "--fsys-tarfile"):
        with tempfile.TemporaryFile() as stream:
            done = subprocess.run(["/usr/bin/dpkg-deb", argument, str(package)], stdout=stream, stderr=subprocess.PIPE, check=False, timeout=120)
            require(done.returncode == 0 and not done.stderr and 0 < stream.tell() <= 512 * 1024 * 1024, "Bounded public DEB inspection failed")
            stream.seek(0)
            control = {}
            for name, member, archive in P.V.members(stream):
                require(member.uid == member.gid == 0, "Foreign package ownership")
                if argument == "--ctrl-tarfile":
                    require(name in ("control", "md5sums") and member.isfile() and member.mode == 0o644 and member.size <= 131072, "Public maintainer script/unknown control refused")
                    control[name] = archive.extractfile(member).read()
                elif member.isdir():
                    require((name == "usr" or name.startswith("usr/")) and member.mode == 0o755, "Foreign public package directory")
                else:
                    require(name.startswith("usr/") and member.isfile() and member.mode in (0o644, 0o755) and member.size <= 256 * 1024 * 1024, "Foreign public package file")
                    body = archive.extractfile(member).read()
                    if name == HUB[1:]:
                        require(len(body) >= 64 and body[:7] == b"\x7fELF\x02\x01\x01" and int.from_bytes(body[16:18], "little") in (2, 3)
                                and int.from_bytes(body[18:20], "little") == 62 and member.mode == 0o755, "Public Root must be x86_64 ELF")
                    result[name] = {**pin(body), "mode": member.mode}
            if argument == "--ctrl-tarfile":
                require(set(control) == {"control", "md5sums"}, "Complete public control inventory required")
                fields = email.parser.Parser().parsestr(control["control"].decode("utf-8"))
                require(not fields.defects and all(len(fields.get_all(key)) == 1 for key in fields)
                        and fields["Package"] == "creator-hub" and fields["Version"] == "0.1.12" and fields["Architecture"] == "amd64"
                        and not any(k in fields for k in ("Pre-Depends", "Conflicts", "Breaks", "Replaces", "Conffiles")), "Public package control differs")
    require(HUB[1:] in result and 0 < len(result) <= 128, "Public Root inventory missing")
    require(pin(read(package, BASELINE["size"])) == {k: BASELINE[k] for k in ("size", "sha256")}, "Public DEB changed during inspection")
    return result


def execution_request(env, binding_raw, api_raw, driver):
    scenario = admission(env)
    binding = parse(binding_raw)
    validate_binding(binding, env)
    validate_api(parse(api_raw))
    return {"schemaVersion": 1, "scenario": scenario, "context": {k: env[k] for k in CONTEXT},
            "binding": pin(binding_raw), "api": pin(api_raw), "driver": pin(driver),
            "sources": {name: pin(read(HERE / name)) for name in SOURCES}}


def check_request(value, env, binding_raw, api_raw, driver):
    same(value, execution_request(env, binding_raw, api_raw, driver), "Sealed incoming request changed")


def recheck_request(env, binding_raw):
    temp = Path(env["RUNNER_TEMP"])
    raw = read(temp / "incoming-016-request.json", uid=os.getuid(), mode=0o600)
    require(read(BASE / "request.json", uid=0, mode=0o644) == raw, "Root-owned request changed before GUI")
    request = parse(raw)
    check_request(request, env, binding_raw, read(temp / "incoming-016-api.json", uid=os.getuid(), mode=0o600),
                  read(temp / "native-linux-production-016-driver/bin/tauri-driver", 64 * 1024 * 1024, uid=os.getuid(), mode=0o755))
    return request


def broker(env, phase):
    scenario = admission(env)
    require(os.getuid() == os.geteuid() == 0 and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "Fixed CI root installer only")
    temp = Path(env["RUNNER_TEMP"])
    require(temp.resolve() == temp, "Redirected runner temp")
    owner = temp.stat().st_uid
    binding_raw = read(temp / STAGE / "binding.json", uid=owner, mode=0o600)
    api_raw = read(temp / "incoming-016-api.json", uid=owner, mode=0o600)
    driver = read(temp / "native-linux-production-016-driver/bin/tauri-driver", 64 * 1024 * 1024, uid=owner, mode=0o755)
    request_raw = read(temp / "incoming-016-request.json", uid=owner, mode=0o600)
    request = parse(request_raw)
    check_request(request, env, binding_raw, api_raw, driver)
    binding = parse(binding_raw)
    if phase == "install-first":
        require(not os.path.lexists(BASE), "Existing installer state refused; no adoption or retry")
        no_legacy_packages()
        result = subprocess.run(["/usr/bin/dpkg-query", "-W", "-f=${Status}", "creator-hub"], capture_output=True, check=False)
        require(result.returncode == 1 and not result.stdout and not os.path.lexists(HUB), "Pre-existing Hub refused")
        ancestry = protect_fixture_parent()
        BASE.mkdir(mode=0o755)
        save(BASE / "ancestry.json", ancestry, 0o644)
        P.write(BASE / "request.json", request_raw, 0o644)
        for name, source, expected in (("hub.deb", temp / STAGE / "deb.deb", PROFILE["pins"]["deb"]),
                                       ("baseline.deb", temp / "incoming-016-baseline.deb", {k: BASELINE[k] for k in ("size", "sha256")})):
            body = read(source, 256 * 1024 * 1024, uid=owner, mode=0o600)
            require(pin(body) == expected, "Installer input changed before owned handoff")
            P.write(BASE / name, body, 0o600)
        baseline_files = audit_baseline(BASE / "baseline.deb")
        save(BASE / "baseline-files.json", baseline_files, 0o644)
        manifest_raw = read(temp / STAGE / "manifest.bin", 65536, uid=owner, mode=0o600)
        require(pin(manifest_raw) == PROFILE["pins"]["manifest"], "Staged signed-resource manifest changed")
        records = P.S.inspect_deb(P.S.deb_records(BASE / "hub.deb"), PROFILE, manifest_raw, parse(manifest_raw))
        same(records, binding["packageFiles"], "Installed inventory differs from actual frozen DEB")
        P.V.verify(str(BASE / "hub.deb"), PROFILE["pins"]["helper"]["sha256"], PROFILE["pins"]["policy"]["sha256"], "0.1.16", P.COHORT)
        package = "baseline.deb" if scenario == SCENARIOS[1] else "hub.deb"
        version = "0.1.12" if scenario == SCENARIOS[1] else "0.1.16"
    else:
        require(phase == "install16" and scenario == SCENARIOS[1], "No second install in fresh lane")
        require(read(BASE / "request.json", uid=0, mode=0o644) == request_raw, "Root-owned request changed")
        require((BASE / "install-first-complete.json").exists(), "Original install did not complete")
        baseline_files = parse(read(BASE / "baseline-files.json", uid=0, mode=0o644))
        installed(baseline_files, "0.1.12")
        require(not hub_pids(), "Old Hub is still running; no force close")
        package, version = "hub.deb", "0.1.16"
    files = baseline_files if version == "0.1.12" else binding["packageFiles"]
    selected = BASE / package
    expected = PROFILE["pins"]["deb"] if version == "0.1.16" else {k: BASELINE[k] for k in ("size", "sha256")}
    require(pin(read(selected, 256 * 1024 * 1024, uid=0, mode=0o600)) == expected, "Root-owned installer changed")
    save(BASE / (phase + "-started.json"), {"version": version, "package": expected})
    tool(["/usr/bin/dpkg", "--install", str(selected)])
    installed(files, version)
    save(BASE / (phase + "-complete.json"), {"version": version, "package": expected}, 0o644)


def protect_fixture_parent():
    # Match the reviewed disposable native lane's finite hosted-image parents.
    # Tighten only known root-owned 0777 directories; never repair other paths.
    rows = []
    for name in ("/", "/usr", "/opt", "/usr/share", "/usr/share/polkit-1", "/usr/share/polkit-1/actions"):
        file = Path(name)
        before = file.lstat()
        require(file.resolve() == file and stat.S_ISDIR(before.st_mode) and before.st_uid == before.st_gid == 0
                and stat.S_IMODE(before.st_mode) in ((0o755,) if name in ("/", "/usr") else (0o755, 0o777)), "Unprotected fixture parent")
        if stat.S_IMODE(before.st_mode) == 0o777:
            os.chmod(file, 0o755)
        after = file.lstat()
        require((before.st_dev, before.st_ino, before.st_uid, before.st_gid) == (after.st_dev, after.st_ino, 0, 0)
                and stat.S_IMODE(after.st_mode) == 0o755, "Fixture parent changed")
        rows.append({"path": name, "before": stat.S_IMODE(before.st_mode), "after": 0o755})
    return rows


def hub_pids():
    found = []
    entries = list(Path("/proc").iterdir())
    require(len(entries) <= 65536, "Process inventory exceeds bound")
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            target = os.readlink(entry / "exe")
        except FileNotFoundError:
            continue
        except PermissionError:
            continue  # Other UIDs are not this isolated runner's product session.
        if target == HUB or target == HUB + " (deleted)":
            found.append(int(entry.name))
    return found


def fixtures(home, scenario):
    values = {"unrelated/keep.json": {"unknown": {"preserve": [16, "incoming"]}}}
    if scenario == SCENARIOS[1]:
        selected, other = home / "selected-project", home / "other-project"
        values.update({CONFIG: {"channels": [{"id": "selected", "name": "Selected incoming project", "unity_project_path": str(selected), "scene_path": None, "enabled": True},
                                           {"id": "other", "name": "Other incoming project", "unity_project_path": str(other), "scene_path": None, "enabled": False}],
                                "active_channel_id": "selected", "mcp_server_path": "/fixture/retained-server.mjs", "auto_start": False,
                                "tool_groups": "core", "enable_custom_scripts": False, "allow_all_tests": False,
                                "automatic_update_checks": False, "connection_guide_version": 1, "unknownConfig": {"nested": [12, 16]}},
                       "data/CreatorHub/projects.json": {"paths": [str(selected), str(other)], "unknownProjectField": "kept"},
                       "data/CreatorProjectSetup/editor-roots.json": ["/fixture/no-unity-editor"],
                       "config/Claude/claude_desktop_config.json": {"mcpServers": {"unrelated": {"command": "/fixture/never-run"}}, "unknownClient": "kept"}})
        for project in ("selected-project", "other-project"):
            values[project + "/Packages/manifest.json"] = {"dependencies": {"com.sidequest.creator-sdk": "4.0.14"}, "unknownManifest": "kept"}
            values[project + "/Assets/keep.txt"] = "Synthetic manifest-only project; never opened in Unity.\n"
            values[project + "/ProjectSettings/ProjectVersion.txt"] = "m_EditorVersion: 6000.3.21f1\n"
    for name, value in values.items():
        file = home / name
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        P.write(file, value.encode() if isinstance(value, str) else json.dumps(value).encode())
    return {name: fingerprint(home / name) for name in values}


def fingerprint(file):
    before = file.lstat()
    body = read(file, 2 * 1024 * 1024)
    info = file.lstat()
    require(file_stamp(before) == file_stamp(info), "Fixture changed during fingerprint")
    return {**pin(body), "dev": info.st_dev, "ino": info.st_ino, "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode)}


def preserved(home, before):
    after = {name: fingerprint(home / name) for name in before}
    require(after == before, "Protected incoming settings/client/project changed")
    for name in ("config/creator-works-mcp/.creator-hub-product-settings", "data/CreatorHub/client-migrations-v1"):
        require(not os.path.lexists(home / name), "Incoming page lane unexpectedly migrated settings/connections")
    require(not list(home.rglob("*.bak")), "Incoming page lane unexpectedly created a backup")
    return after


def present(d, selector):
    matches = d.elements(selector)
    require(len(matches) <= 1, "Ambiguous readiness control")
    return bool(matches) and d.read(selector, "displayed") is True


def initialize_old_storage(d):
    require(d.read("#usage-terms-dialog", "attribute/open") is not None
            and d.read(".footer-version") == "0.1.12", "Only exact old Hub blocked terms may initialize fixture storage")
    require(d.call("POST", "/execute/sync", {"script": INITIALIZE_012_STORAGE, "args": []}) == ["false"] * 3, "Old fixture storage initialization did not return exact values")
    d.call("POST", "/refresh", {})  # One deliberate reload applies the fixture, never an action retry.


def preferences_ui(d, expected, *, integrated):
    if integrated and d.read("#update-settings", "attribute/open") is None:
        d.click("#update-settings > summary")
    values = []
    for selector in PREF_IDS:
        require(d.read("#" + selector, "property/checked") is expected, "Known Hub preference changed")
        values.append(expected)
    require(d.read("#auto-download", "displayed") is True and d.read("#restore-hosted-views", "displayed") is True, "Preference controls not observable")
    return dict(zip(PREF_KEYS, values))


def native_preferences(home, expected):
    value = parse(read(home / PREFERENCES, 2048))
    same(value, {"schemaVersion": 1, "preview": expected, "autoDownload": expected, "restoreHostedViews": expected}, "Native preferences differ from observed old values/defaults")
    return fingerprint(home / PREFERENCES)


def terms(d, home, wait, *, accept, old=False):
    file = home / TERMS
    if accept:
        require(not os.path.lexists(file), "Terms may not be seeded or reaccepted")
        wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
        require(d.read("#usage-terms-dialog", "attribute/open") is not None, "Actual terms modal missing")
        started = time.time_ns() // 1000000
        d.click("#usage-terms-checkbox")
        d.click("#usage-terms-continue")
        wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
    else:
        started = 1
    if old:
        require(accept and not os.path.lexists(file), "Public012 terms must use its genuine localStorage UI, not a native fixture")
        return {"policyVersion": "2026-09-28-v1", "genuineOldTermsUiAccepted": True, "nativeRecordAbsent": True,
                "acceptedAfterMs": started}
    wait(lambda: file.exists() and d.read("#usage-terms-dialog", "attribute/open") is None)
    value = parse(read(file, 2048))
    same({k: v for k, v in value.items() if k != "acceptedAtMs"}, {"schemaVersion": 1, "policyVersion": "2026-09-28-v1"}, "Terms record differs")
    require(type(value.get("acceptedAtMs")) is int and started <= value["acceptedAtMs"] <= time.time_ns() // 1000000, "Terms timestamp differs")
    return fingerprint(file)


def direct_pages(d, pages, scenario):
    pages.wait(lambda: present(d, "#view-projects"))
    # Only a settings review can appear here; no standalone apps were installed.
    if d.read("#convergence-dialog", "attribute/open") is not None:
        pages.wait(lambda: d.read("#convergence-dialog", "attribute/aria-busy") == "false")
        require(scenario == SCENARIOS[1] and d.read("#convergence-title") == "Move to Hub"
                and d.read("#convergence-later") == "Not now", "Unexpected incoming startup consent")
        d.click("#convergence-later")
    pages.wait(lambda: d.read("#view-projects", "attribute/aria-busy") == "false")
    require(d.read("#projects-home-title") == "Projects" and d.read("#view-hub", "displayed") is False, "Direct Projects home missing")
    if scenario == SCENARIOS[1]:
        pages.wait(lambda: present(d, '#project-list .project-row[data-mcp-selected="true"]'))
        rows = d.elements("#project-list .project-row")
        require(len(rows) == 2 and len(d.elements('#project-list .project-row[data-mcp-selected="true"]')) == 1
                and "selected-project" in d.read('#project-list .project-row[data-mcp-selected="true"]'), "Selected/unique projects not retained")
    else:
        require(not d.elements("#project-list .project-row") and present(d, "#project-list .project-empty"), "Fresh Projects state differs")
    prefs = preferences_ui(d, scenario == SCENARIOS[0], integrated=True)
    for feature in ("mcp", "setup"):
        d.click("#suite-trigger")
        selector = '#suite-menu [data-view="' + feature + '"]'
        pages.wait(lambda: present(d, selector))
        d.click(selector)
        prefix = "#feature-" + feature
        pages.wait(lambda: present(d, prefix) and d.read(prefix, "attribute/aria-busy") == "false"
                   and d.read(prefix + ' [data-field="status"]') == "Ready")
        if feature == "mcp" and scenario == SCENARIOS[0]:
            guide = prefix + ' [data-field="guide-dialog"]'
            start = prefix + ' [data-field="guide-start"]'
            pages.wait(lambda: present(d, guide) and d.read(guide, "attribute/open") is not None)
            require(d.read("#feature-mcp-guide-title") == "Connect your AI to Unity"
                    and d.read(start) == "Set up a connection", "Unexpected fresh MCP guide")
            d.click(start)
            pages.wait(lambda: d.read(guide, "attribute/open") is None)
        require(not d.read(prefix + ' [data-field="error"]')
                and d.read(prefix + ' [data-field="controls"]', "attribute/disabled") is None, "Direct feature failed")
        if feature == "mcp" and scenario == SCENARIOS[1]:
            require(len(d.elements(prefix + ' .feature-project[data-selected="true"]')) == 1
                    and "Selected incoming project" in d.read(prefix + ' .feature-project[data-selected="true"]'), "MCP selection lost")
        require(not d.elements("iframe,object,embed") and len(d.call("GET", "/window/handles")) == 1, "Separate module document/window")
    return {"projects": True, "mcp": True, "setup": True, "preferences": prefs}


def driver_preflight(d, child, guard, neutral, helpers, native, webkit):
    backend = None

    def sockets_ready():
        nonlocal backend
        guard()
        peers = [p for p in neutral.subtree(child.pid, helpers, native).values()
                 if p["executable"] == "/usr/bin/WebKitWebDriver" and p["parentPid"] == child.pid]
        require(len(peers) <= 1 and (backend is None or len(peers) == 1), "Owned system driver disappeared or duplicated")
        if not peers:
            return False
        current = native.native_process(peers[0]["pid"], helpers)
        require(current["parentPid"] == child.pid and current["uids"] == [os.getuid()] * 4
                and current["kernelImageSha256"] == webkit["sha256"], "System driver image/parent/UID differs")
        require(backend is None or current == backend, "System driver identity changed during startup")
        backend = current
        ready = neutral.listener(child.pid, 4444) and neutral.listener(backend["pid"], 4445)
        guard()
        return ready

    # tauri-driver 2.1.0 spawns WebKit without awaiting its bind and forwards /status.
    # https://github.com/tauri-apps/tauri/blob/tauri-driver-v2.1.0/crates/tauri-driver/src/server.rs
    neutral.wait(sockets_ready)

    def backend_guard():
        guard()
        require(native.native_process(backend["pid"], helpers) == backend and neutral.listener(child.pid, 4444)
                and neutral.listener(backend["pid"], 4445), "Bound driver identity/socket changed")

    d.guard = backend_guard
    neutral.wait(lambda: d.request("GET", "/status")["ready"] is True)
    return backend


def session(folder, home, binding, *, old=False, reopened=False):
    neutral = load("native-linux-integrated-pages")
    helpers, native = neutral.helpers()
    readiness = load("native-linux-016-pages")
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    Gdk.init([])
    d, x11 = neutral.Driver(), helpers.X11()
    driver = Path(os.environ["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
    request = recheck_request(os.environ, read(Path(os.environ["RUNNER_TEMP"]) / STAGE / "binding.json", uid=os.getuid(), mode=0o600))
    require(pin(read(driver, 64 * 1024 * 1024, mode=0o755)) == request["driver"], "Driver bytes changed")
    webkit = neutral.record("/usr/bin/WebKitWebDriver")
    require(webkit["uid"] == webkit["gid"] == 0 and webkit["mode"] == 0o755, "Unprotected system driver")
    require(not hub_pids(), "A previous Root is still live; no adoption")
    wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    child = subprocess.Popen([str(driver), "--native-driver", "/usr/bin/WebKitWebDriver"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    logs = native.Capture(child, folder, "driver")
    for name in ("stdout", "stderr"):
        os.chmod(folder / ("driver." + name), 0o600)
    evidence = {"normalCloseObserved": False, "oldPublic012": old, "reopened": reopened, "disposableTeardownRequired": True}
    owned_request = pidfd = None
    failure = None
    try:
        identity = native.native_process(child.pid, helpers)
        require(identity["kernelImageSha256"] == request["driver"]["sha256"], "Driver image differs")
        wm_identity = native.native_process(wm.pid, helpers)
        def tool_guard():
            readiness.check_logs(logs)
            require(child.poll() is None and native.native_process(child.pid, helpers) == identity
                    and wm.poll() is None and native.native_process(wm.pid, helpers) == wm_identity, "Owned tooling identity changed")
        backend = driver_preflight(d, child, tool_guard, neutral, helpers, native, webkit)
        backend_guard = d.guard
        evidence["tools"] = {"driver": identity, "systemDriver": backend, "windowManager": wm_identity}
        response = d.request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": HUB, "args": []}}}})
        d.session = response["sessionId"]
        require(type(d.session) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", d.session), "Invalid session identity")
        roots = [p for p in neutral.subtree(child.pid, helpers, native).values() if p["executable"] == HUB]
        require(len(roots) == 1 and hub_pids() == [roots[0]["pid"]], "Exactly one owned Root required")
        owned = native.native_process(roots[0]["pid"], helpers)
        expected = parse(read(BASE / "baseline-files.json", uid=0, mode=0o644))[HUB[1:]] if old else PROFILE["pins"]["hub"]
        require(owned["uids"] == [os.getuid()] * 4 and owned["parentPid"] == backend["pid"]
                and owned["kernelImageSha256"] == expected["sha256"], "Root binary/parent/UID differs")
        pidfd = os.pidfd_open(owned["pid"])
        evidence["root"] = owned
        startup = {"attempts": 0}
        evidence["startupWindowReadiness"] = startup
        neutral.wait(lambda: readiness.startup_client_id(x11, backend_guard, startup) is not None)
        window = native.client_ids(x11)[0]
        owned_request = helpers.Request("snapshot", owned["pid"], owned["startTime"], HUB, owned["kernelImageSha256"], window, TITLE, "FRAME")
        def guard():
            backend_guard()
            require(native.native_process(owned["pid"], helpers) == owned and hub_pids() == [owned["pid"]], "Root identity changed/duplicated")
            require(native.client_ids(x11) == [window], "Foreign/extra native window")
            helpers.bound_window(owned_request, x11)
            tree = neutral.subtree(child.pid, helpers, native)
            require(not any(legacy_process(p) for p in tree.values()), "Legacy backend/runtime launched")
        d.guard = guard
        guard()
        version = "0.1.12" if old else "0.1.16"
        neutral.wait(lambda: present(d, ".footer-version") and d.read(".footer-version") == version)
        evidence["visibleVersion"] = d.read(".footer-version")
        require(evidence["visibleVersion"] == version, "Visible Hub version differs")
        if old:
            neutral.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
            initialize_old_storage(d)
            neutral.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is not None)
        accept = old or (os.environ["CREATOR_INCOMING_016_SCENARIO"] == SCENARIOS[0] and not reopened)
        evidence["terms"] = terms(d, home, neutral.wait, accept=accept, old=old)
        neutral.wait(lambda: d.read("#usage-terms-dialog", "attribute/open") is None)
        if old:
            neutral.wait(lambda: d.read("#auto-download", "enabled") is True)
            evidence["preferences"] = preferences_ui(d, False, integrated=False)
            require(not os.path.lexists(home / PREFERENCES), "Public012 unexpectedly wrote native preferences")
        else:
            evidence["pages"] = direct_pages(d, neutral, os.environ["CREATOR_INCOMING_016_SCENARIO"])
            evidence["nativePreferences"] = native_preferences(home, os.environ["CREATOR_INCOMING_016_SCENARIO"] == SCENARIOS[0])
        physical = folder / "physical"
        physical.mkdir(mode=0o700)
        evidence["bitmap"] = native.bitmap(owned_request, physical, helpers, x11)
        require(evidence["bitmap"].get("nonblank") is True, "Blank owned surface")
    except Exception as error:
        failure = error
        evidence["error"] = str(error)[:1500]
        if owned_request is not None:
            def bitmap():
                physical = folder / "failure-physical"
                physical.mkdir(mode=0o700)
                return native.bitmap(owned_request, physical, helpers, x11)
            readiness.capture_failure(d, evidence, bitmap)
    finally:
        if owned_request is not None:
            try:
                d.guard()
                x11.close_window(owned_request.window, helpers.bound_window(owned_request, x11))
                neutral.wait(lambda: bool(select.select([pidfd], [], [], 0)[0]) and not Path(f"/proc/{owned_request.pid}").exists(), 15)
                evidence["normalCloseObserved"] = True
                require(native.native_process(child.pid, helpers) == identity, "Driver changed before tool disposal")
                child.terminate()
                child.wait(timeout=10)
                subprocess.run(["/usr/bin/openbox", "--exit"], stdin=subprocess.DEVNULL, check=True, timeout=10)
                wm.wait(timeout=10)
                evidence["disposableTeardownRequired"] = False
            except Exception as error:
                evidence["closeError"] = str(error)[:700]
                if failure is None:
                    failure = error
        if pidfd is not None:
            os.close(pidfd)
        try:
            logs.pump()
            evidence["logs"] = readiness.log_evidence(logs, folder)
            require(not any(item["truncated"] for item in evidence["logs"].values()), "Driver log overflow")
        except Exception as error:
            evidence["logError"] = str(error)[:700]
            if failure is None:
                failure = error
        finally:
            logs.close()
            x11.dispose()
            save(folder / "session.json", evidence)
    if failure is not None:
        raise failure
    require(evidence["normalCloseObserved"] and not hub_pids(), "Normal close incomplete")
    return evidence


def legacy_process(item):
    executable = item["executable"]
    return (Path(executable).name in ("creator-works-mcp-launcher", "creator-project-setup", "creator-mcp", "node")
            or executable.startswith(("/usr/lib/Creator Works MCP/", "/usr/lib/creator-hub/modules/")))


def invoke_broker(env, phase):
    clean = process_environment(env)
    subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/env", "-i", *[key + "=" + value for key, value in clean.items()],
                    "/usr/bin/python3", "-B", str(HERE / Path(__file__).name), phase], stdin=subprocess.DEVNULL, check=True)


def run_session(env):
    scenario = admission(env)
    require(os.getuid() > 0, "GUI must remain unprivileged")
    temp = Path(env["RUNNER_TEMP"])
    result = temp / RESULT
    home = result / "home"
    require(all(env.get(key) == str(home / part) for key, part in
                {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items()), "Only this disposable HOME may be used")
    binding_raw = read(temp / STAGE / "binding.json", mode=0o600)
    binding = parse(binding_raw)
    validate_binding(binding, env)
    recheck_request(env, binding_raw)
    report = {"schemaVersion": 1, "scenario": scenario, "harnessSource": env["GITHUB_SHA"], "assembly": PROFILE["assembly"],
              "scope": "manual DEB installation, native direct pages and protected-state preservation only", **FLAGS}
    before = parse(read(result / "before.json"))
    try:
        if scenario == SCENARIOS[1]:
            installed(parse(read(BASE / "baseline-files.json", uid=0, mode=0o644)), "0.1.12")
            old = result / "old012"
            old.mkdir(mode=0o700)
            report["old012"] = session(old, home, binding, old=True)
            report["protectedAfter012"] = preserved(home, before)
            require(not os.path.lexists(home / PREFERENCES), "Native preference fixture must not replace genuine old localStorage")
            require(not os.path.lexists(home / TERMS), "Public012 must not seed the incoming native consent file")
            invoke_broker(env, "install16")
        installed(binding["packageFiles"], "0.1.16")
        report["protectedAfterInstall16"] = preserved(home, before)
        first = result / "first16"
        first.mkdir(mode=0o700)
        report["first16"] = session(first, home, binding)
        report["protectedAfterFirst"] = preserved(home, before)
        if scenario == SCENARIOS[0]:
            require(not os.path.lexists(home / CONFIG), "Read-only fresh MCP page unexpectedly wrote configuration")
        before[TERMS] = fingerprint(home / TERMS)
        before[PREFERENCES] = fingerprint(home / PREFERENCES)
        readiness = load("native-linux-016-pages")
        first_journal = readiness.page_journal(home, {"revision": 1, "records": []})
        report["firstReadJournal"] = first_journal
        reopened = result / "reopened16"
        reopened.mkdir(mode=0o700)
        report["reopened16"] = session(reopened, home, binding, reopened=True)
        require(report["first16"]["root"]["pid"] != report["reopened16"]["root"]["pid"], "Reopen did not create a fresh Root")
        report["reopenedReadJournal"] = readiness.page_journal(home, first_journal["data"])
        report["protectedAfterReopen"] = preserved(home, before)
        if scenario == SCENARIOS[0]:
            require(not os.path.lexists(home / CONFIG), "Read-only fresh MCP reopen unexpectedly wrote configuration")
        installed(binding["packageFiles"], "0.1.16")
        report.update(freshInstallAccepted=scenario == SCENARIOS[0], manualPublic012UpgradeAccepted=scenario == SCENARIOS[1],
                      directPagesObserved=True, manualReopenObserved=True, preservationAccepted=True)
    except Exception as error:
        report["error"] = str(error)[:1500]
        raise
    finally:
        save(result / "report.json", report)


def run(env):
    scenario = admission(env)
    require(os.getuid() > 0 and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "Exact unprivileged checkout required")
    temp = Path(env["RUNNER_TEMP"])
    require(temp.resolve() == temp, "Redirected runner temp")
    binding = read(temp / STAGE / "binding.json", mode=0o600)
    api = read(temp / "incoming-016-api.json", mode=0o600)
    driver = read(temp / "native-linux-production-016-driver/bin/tauri-driver", 64 * 1024 * 1024, mode=0o755)
    request = execution_request(env, binding, api, driver)
    save(temp / "incoming-016-request.json", request)
    result = temp / RESULT
    result.mkdir(mode=0o700)
    for name in ("home", "home/config", "home/data", "home/cache", "runtime", "tmp"):
        (result / name).mkdir(mode=0o700)
    before = fixtures(result / "home", scenario)
    save(result / "before.json", before)
    invoke_broker(env, "install-first")
    clean = process_environment(env)
    clean.update(HOME=str(result / "home"), XDG_CONFIG_HOME=str(result / "home/config"), XDG_DATA_HOME=str(result / "home/data"),
                 XDG_CACHE_HOME=str(result / "home/cache"), XDG_RUNTIME_DIR=str(result / "runtime"), TMPDIR=str(result / "tmp"),
                 GDK_BACKEND="x11", NO_AT_BRIDGE="0")
    completed = subprocess.run(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1000x24", "/usr/bin/dbus-run-session", "--",
                                "/usr/bin/python3", "-B", str(HERE / Path(__file__).name), "session"], env=clean, stdin=subprocess.DEVNULL, check=False)
    require(completed.returncode == 0, "Native incoming session failed; no replay or force close")


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("profile", "run", "session", "install-first", "install16"), "One fixed phase required")
    admission(os.environ)
    if sys.argv[1] == "profile":
        print(json.dumps(PROFILE))
    elif sys.argv[1] == "run":
        run(os.environ)
    elif sys.argv[1] == "session":
        run_session(os.environ)
    else:
        broker(os.environ, sys.argv[1])


if __name__ == "__main__":
    main()
