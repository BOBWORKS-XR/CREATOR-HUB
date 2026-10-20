"""Finite disposable production016 -> private017 update qualification.

No publication authority. Initial installation is separate from the in-app
update. A successor is observed, never launched by this controller. Import and
pure validation use only the Python 3.10 standard library.
"""
import base64
import ctypes
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import zipfile
import zlib

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = "BOBWORKS-XR/CREATOR-HUB"
BRANCH = "refs/heads/validation/native-linux-production-016-update"
WORKFLOW = REPO + "/.github/workflows/native-linux-production-016-update.yml@" + BRANCH
PROFILE = "production016-private017-native-update"
SCENARIOS = ("deb-native-cancel", "deb-auth-cancel", "deb-approve", "portable-native-cancel", "portable-approve")
BASE = Path("/opt/creator-polkit-fixture")
USER, UID = "creator-polkit-fixture", 21314
TITLE = "Creator Hub - Development Preview"
ROOT_ENTRY = "usr/bin/creator-hub"
RETIREMENT_HELPER = "usr/libexec/creator-hub-deb-retirement-helper"
SELECTOR_ENTRY = "usr/libexec/creator-hub-portable-selector"
STORE = "data/creator-hub-portable"
HOST_SERVICE = "data/dbus-1/services/com.creatorworks.hub.Host.service"
CONFIG = "config/creator-works-mcp/launcher-config.json"
PREFS = "data/CreatorHub/preferences/hub-preferences.json"
TERMS = "data/CreatorHub/consent/hub-usage-terms.json"
KEY_PIN = {"size": 119, "sha256": "23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308"}
FEATURES = ["integrated-features", "experimental-flatpak-host", "linux-production-migration", "experimental-linux-portable-update"]
FIXED = {
    "17": {"source": "75a99ff4a267064aaa3ac9e30039bc91dc791d89", "tree": "5f62bf4bc1ba85eb293ca9a5a30330b06b6b4351",
           "run": 39352480021, "job": 118399713148, "artifact": 12234186813,
           "zip": {"size": 127991424, "sha256": "41afaceed3eb704cf67129c2b1bba01c574535badf94eb721170298b48bf160a"},
           "raw": {"size": 28663912, "sha256": "97f19971eb1ab2e98767aa02f8ea6a585ca617ebef4380ec9e93195a15c779f0"},
           "deb": {"size": 64296202, "sha256": "efc71fb740ab87e2d8a3d8519cbe8fff38edaa6ee95f358e50b2eccc0f5f80fe"},
           "hub": {"size": 28663912, "sha256": "147d7847a1437adbd33d161029307eb32bc1e406482d8f93247822eb805c47cd"},
           "helper": {"size": 1167744, "sha256": "501e97da9c93d370caa750c46f4c3f272d546281e8e2eeedfaf4f01193d644be"},
           "archive": {"size": 55566243, "sha256": "db14fbe37eb69bfb1093107d4c842e4a14f6dd07b2e747ff675416013ef6d202"}},
}
FALSE = dict.fromkeys(("publicDiscovery", "flatpakAccepted", "steamDeckAccepted", "liveAiAccepted", "unityAccepted", "releaseReady"), False)
ENVIRONMENT = ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF", "GITHUB_EVENT_NAME",
               "GITHUB_WORKFLOW_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE",
               "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "UPDATE_SCENARIO", "UPDATE_EXECUTE",
               "UPDATE_PROFILE_SHA256", "CONTROLLER_NODE")
SOURCES = (Path(__file__).name, "native-unix-window.py", "native-linux-root-probe.py", "native-linux-integrated-pages.py",
           "native-linux-polkit-probe.py", "native-linux-update-flow.py", "native-linux-production-016-flatpak.py",
           "linux-retirement-package-verify.py", "private-linux-update-fixture-017-package-verify.py", "linux-update-lab-feed.cjs",
           "native-linux-production-016-migration.py", "native-linux-production-016-stage.py", "native-linux-016-stage.py")
INVENTORY_IMPORTS = ("native-linux-production-016-migration.py", "native-linux-production-016-stage.py",
                     "native-linux-016-stage.py", "linux-retirement-package-verify.py")
PRIVATE_RELEASE, PRIVATE_TAG = 411494394, "v0.1.13-validation"
VERIFIER_PINS = {
    "src-tauri/examples/verify-package-input.rs": {"size": 2266, "sha256": "81207a9e6b17a288c9ee95acf9c400ed9b047cfa319a3a1fed33df320f6fb135"},
    "native/linux-portable-deployment/Cargo.lock": {"size": 10486, "sha256": "e41ae1db82e4a5d63e007cf3e45424ba511ecc194cf6a62359bd4863839f267f"},
    "src-tauri/src/catalog-key.pub": KEY_PIN,
}
MAX_ZIP, MAX_FILE, MAX_TOTAL = 768 * 1024**2, 256 * 1024**2, 512 * 1024**2
ROOT_TOOL_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"
TLS_CERT = Path("/usr/local/share/ca-certificates/creator-production016-update.crt")
TLS_TRUST = Path("/etc/ssl/certs")
TLS_CONFIG = (b"[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=api.github.com\n"
              b"[ext]\nsubjectAltName=DNS:api.github.com,DNS:github.com\nbasicConstraints=critical,CA:TRUE\n"
              b"keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n")
HTML_SCENARIO = "deb-native-cancel"
HTML_DRIVER_VERSION = "2.1.0"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected), "Unknown/missing contract fields")


def parse(raw):
    def unique(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: require(False, "Nonfinite JSON"))


def pin(raw):
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def validate_pin(value, maximum=MAX_FILE):
    keys(value, ("size", "sha256"))
    require(type(value["size"]) is int and 0 < value["size"] <= maximum
            and type(value["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "Bounded independent byte pin required")


def safe_name(name):
    require(type(name) is str and 0 < len(name) <= 240 and not name.startswith("/")
            and re.fullmatch(r"[A-Za-z0-9_ ./+@-]+", name) and all(p not in ("", ".", "..") for p in name.split("/")), "Canonical finite member path required")
    return name


def stamp(info):
    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns")
    # Windows Python exposes different path/handle ctime views. Native Linux
    # retains ctime in both comparisons, in addition to dev/inode/mtime/size.
    if os.name != "nt":
        fields += ("st_ctime_ns",)
    return tuple(getattr(info, n) for n in fields)


def read(file, maximum=262144, *, uid=None, mode=None):
    file = Path(file)
    before = file.lstat()
    require(file.resolve(strict=True) == file and stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and 0 <= before.st_size <= maximum and (uid is None or before.st_uid == uid)
            and (mode is None or stat.S_IMODE(before.st_mode) == mode), "Bounded owned nonlinked file required")
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        require(stamp(os.fstat(fd)) == stamp(before), "File replaced during open")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            body = stream.read(maximum + 1)
        require(len(body) == before.st_size and stamp(os.fstat(fd)) == stamp(before)
                and stamp(file.lstat()) == stamp(before), "File changed during read")
        return body
    finally:
        os.close(fd)


def bound(file, expected, maximum=MAX_FILE, **kwargs):
    body = read(file, maximum, **kwargs)
    require(pin(body) == expected, "Independent bytes differ: " + Path(file).name)
    return body


def write(file, raw, mode=0o600):
    require(type(raw) is bytes, "Explicit byte output required")
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        os.fchmod(fd, mode) if hasattr(os, "fchmod") else None
        with os.fdopen(fd, "wb", closefd=False) as stream:
            require(stream.write(raw) == len(raw), "Short exclusive write")
            stream.flush(); os.fsync(fd)
    finally:
        os.close(fd)


def save(file, value, mode=0o600):
    write(file, (json.dumps(value, sort_keys=True, indent=2) + "\n").encode(), mode)


def load(name):
    require(name in {Path(n).stem for n in SOURCES}, "Only reviewed neutral source may be imported")
    spec = importlib.util.spec_from_file_location("update016_" + name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def inventory_observer(sealed):
    folder = BASE / "scripts"
    protected_ancestry(folder)
    for name in INVENTORY_IMPORTS:
        bound(folder / name, sealed["sources"][name], 2 * 1024**2, uid=0, mode=0o444)
    spec = importlib.util.spec_from_file_location("update016_inventory", folder / INVENTORY_IMPORTS[0])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    require(module.BASE == BASE and module.UID == UID and module.INVENTORY_COHORTS["update"] == SCENARIOS,
            "Fixed shared update inventory cohort differs")
    return module


def admission(env, *, system=None, machine=None):
    require((system or sys.platform) == "linux" and (machine or platform.machine()) == "x86_64", "Native Linux x86_64 only")
    for key, value in {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPO, "GITHUB_REPOSITORY_ID": "1364807512",
                       "GITHUB_REF": BRANCH, "GITHUB_WORKFLOW_REF": WORKFLOW, "GITHUB_EVENT_NAME": "workflow_dispatch",
                       "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "UPDATE_EXECUTE": "true"}.items():
        require(env.get(key) == value, "Exact manual hosted update context required: " + key)
    require(env.get("UPDATE_SCENARIO") in SCENARIOS and re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", ""))
            and re.fullmatch(r"[a-f0-9]{64}", env.get("UPDATE_PROFILE_SHA256", ""))
            and all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "Finite scenario/source/profile/run required")
    require(not any(re.match(r"^(LD_|DYLD_|PYTHON|TAURI_|WEBKIT_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|APPIMAGE$|APPDIR$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)", key)
                    or key.lower().endswith("proxy") for key in env) and not env.get("FLATPAK_ID"), "Inherited injection/trust/package override refused")
    return env["UPDATE_SCENARIO"]


def validate_profile(value, scenario):
    keys(value, ("schemaVersion", "profile", "fromVersion", "toVersion", "baseline", "artifacts", "deliveries", "objects"))
    require(value["schemaVersion"] == 1 and value["profile"] == PROFILE and value["fromVersion"] == "0.1.16"
            and value["toVersion"] == "0.1.17" and scenario in SCENARIOS, "Only closed production016/private017 admitted")
    baseline = value["baseline"]
    keys(baseline, ("version", "source", "tree", "run", "job", "artifact", "zip", "raw", "deb", "hub", "archive", "helper", "policy", "service", "features"))
    require(baseline["version"] == "0.1.16" and baseline["features"] == FEATURES
            and all(type(baseline[n]) is str and re.fullmatch(r"[a-f0-9]{40}", baseline[n]) for n in ("source", "tree"))
            and all(type(baseline[n]) is int and baseline[n] > 0 for n in ("run", "job", "artifact")), "Independently pinned final016 production source/build required; no baseline defaults")
    for name in ("zip", "raw", "deb", "hub", "archive", "helper", "policy", "service"):
        validate_pin(baseline[name], MAX_ZIP if name == "zip" else MAX_FILE)
    roles, deliveries = {"assembly16", "assembly17"}, {"signedDeb17"}
    objects = {"deb16", "deb17", "raw16", "raw17", "assemblyReceipt16", "debDescriptor17", "debSignature17", "latest17"}
    if scenario.startswith("portable-"):
        roles |= {"portable16", "portable17"}
        deliveries = {"signedPortable16", "signedPortable17"}
        objects = {"deb16", "deb17", "raw16", "raw17", "assemblyReceipt16", "appimage16", "archive16", "archive17", "portableManifest16", "portableManifest17",
                    "portableDescriptor16", "portableDescriptor17", "portableSignature16", "portableSignature17",
                    "manifestSignature16", "manifestSignature17"}
    keys(value["artifacts"], roles); keys(value["deliveries"], deliveries); keys(value["objects"], objects)
    for role, item in value["artifacts"].items():
        keys(item, ("source", "tree", "branch", "workflow", "run", "attempt", "job", "artifact", "name", "zip", "files"))
        require(all(type(item[n]) is int and item[n] > 0 for n in ("run", "attempt", "job", "artifact"))
                and item["attempt"] == 1 and all(re.fullmatch(r"[a-f0-9]{40}", item[n]) for n in ("source", "tree")), "Exact producer identity required")
        require(re.fullmatch(r"validation/[a-z0-9-]+", item["branch"]) and re.fullmatch(r".github/workflows/[a-z0-9-]+\.yml", item["workflow"])
                and re.fullmatch(r"[A-Za-z0-9._-]{1,160}", item["name"]), "Finite same-repository producer route required")
        validate_pin(item["zip"], MAX_ZIP)
        require(type(item["files"]) is dict and 0 < len(item["files"]) <= 32, "Complete bounded ZIP inventory required")
        require(len({n.lower() for n in item["files"]}) == len(item["files"]), "Case alias refused")
        for name, expected in item["files"].items():
            safe_name(name); validate_pin(expected)
        if role.startswith("assembly"):
            expected = baseline if role == "assembly16" else FIXED["17"]
            for name in ("source", "tree", "run", "job", "artifact", "zip"):
                require(item[name] == expected[name], "Independently pinned production/private assembly identity changed")
        routes = {
            "assembly16": ("validation/linux-integrated-candidate-016", ".github/workflows/unix-managed-assembly.yml"),
            "assembly17": ("validation/linux-private-update-fixture-017", ".github/workflows/private-linux-update-fixture-017.yml"),
            "portable16": ("validation/linux-016-portable-production", ".github/workflows/linux-016-portable-production.yml"),
            "portable17": ("validation/private-linux-portable-fixture-017", ".github/workflows/private-linux-portable-fixture-017.yml"),
        }
        if role in routes:
            require((item["branch"], item["workflow"]) == routes[role], "No caller-selected producer workflow/profile")
    for role, item in value["deliveries"].items():
        keys(item, ("asset", "name", "zip", "files"))
        require(type(item["asset"]) is int and item["asset"] > 0 and item["name"] == delivery_name(value, role), "Exact closed private draft asset name/ID required")
        validate_pin(item["zip"], MAX_ZIP)
        if role == "signedDeb17":
            require(item["asset"] == 658078066 and item["zip"] == {"size": 64362879, "sha256": "252f14b4b119412d4c0017b18479077c3050228f17725464688545a5fd298a6f"}, "Original private017 signed carrier is immutable")
        require(type(item["files"]) is dict and 0 < len(item["files"]) <= 16
                and len({n.lower() for n in item["files"]}) == len(item["files"]), "Complete private ZIP inventory required")
        for name, expected in item["files"].items():
            safe_name(name); validate_pin(expected)
    require(len({x["asset"] for x in value["deliveries"].values()}) == len(deliveries), "Private asset role alias refused")
    inputs = input_roles(value)
    for name, item in value["objects"].items():
        keys(item, ("artifact", "member"))
        require(item["artifact"] in inputs and item["member"] in inputs[item["artifact"]]["files"], "Object outside pinned complete ZIP")
        expected_role = "assembly" + name[-2:] if name in ("deb16", "deb17", "raw16", "raw17") else None
        if expected_role:
            expected = baseline if name[-2:] == "16" else FIXED["17"]
            require(item["artifact"] == expected_role and object_pin(value, name) == expected[name[:-2]], "Actual original package/raw Root pin differs")
        if name == "assemblyReceipt16":
            require(item["artifact"] == "assembly16", "Compile proof must come from the pinned actual production assembly")
        if name.startswith(("debDescriptor", "debSignature", "latest")):
            require(item["artifact"] == "signedDeb17", "DEB metadata must come from its separately pinned signed delivery")
        if name.startswith(("portableDescriptor", "portableSignature", "manifestSignature")):
            require(item["artifact"] == "signedPortable" + name[-2:], "Signed portable metadata must have its own pinned delivery")
        if name.startswith(("archive", "portableManifest", "appimage")):
            require(item["artifact"] == "portable" + name[-2:], "Portable bytes must come from their actual source producer")
    require(len({(v["artifact"], v["member"]) for v in value["objects"].values()}) == len(objects), "Object alias refused")
    return value


def delivery_name(profile, role):
    if role == "signedDeb17":
        return "signed-private-deb017-carrier-39352480021.zip"
    require(role in ("signedPortable16", "signedPortable17"), "Unknown private delivery role")
    version = role[-2:]
    return "signed-private-portable0" + version + "-carrier-" + str(profile["artifacts"]["portable" + version]["run"]) + ".zip"


def input_roles(profile):
    require(not set(profile["artifacts"]) & set(profile["deliveries"]), "Input role alias")
    return {**profile["artifacts"], **profile["deliveries"]}


def object_pin(profile, name):
    obj = profile["objects"][name]
    return input_roles(profile)[obj["artifact"]]["files"][obj["member"]]


def object_path(folder, profile, name):
    item = profile["objects"][name]
    return folder / "members" / item["artifact"] / item["member"]


def validate_api(proof, expected):
    keys(proof, ("run", "job", "artifact", "commit"))
    run, job, artifact, commit = (proof[n] for n in ("run", "job", "artifact", "commit"))
    require(all(run.get(k) == v for k, v in {"id": expected["run"], "run_attempt": 1, "head_sha": expected["source"],
            "head_branch": expected["branch"], "path": expected["workflow"], "event": "workflow_dispatch", "status": "completed", "conclusion": "success"}.items()), "Fresh producer API identity/status differs")
    require(all(run.get(n, {}).get("id") == 1364807512 and run[n].get("full_name") == REPO for n in ("repository", "head_repository")), "Foreign producer repository")
    require(commit.get("sha") == expected["source"] and commit.get("tree", {}).get("sha") == expected["tree"], "Producer source tree differs")
    require(all(job.get(k) == v for k, v in {"id": expected["job"], "run_id": expected["run"], "run_attempt": 1,
            "head_sha": expected["source"], "status": "completed", "conclusion": "success"}.items()) and "ubuntu-22.04" in job.get("labels", []), "Actual successful hosted job required")
    require(all(artifact.get(k) == v for k, v in {"id": expected["artifact"], "name": expected["name"], "expired": False,
            "size_in_bytes": expected["zip"]["size"], "digest": "sha256:" + expected["zip"]["sha256"]}.items())
            and all(artifact.get("workflow_run", {}).get(k) == v for k, v in {"id": expected["run"], "head_sha": expected["source"], "head_branch": expected["branch"]}.items()), "Artifact API byte/run association differs")


def delivery_receipt(profile, env):
    return {"schemaVersion": 1, "release": PRIVATE_RELEASE, "tag": PRIVATE_TAG,
            "profileSha256": env["UPDATE_PROFILE_SHA256"], "harnessSource": env["GITHUB_SHA"],
            "run": int(env["GITHUB_RUN_ID"]), "attempt": int(env["GITHUB_RUN_ATTEMPT"]),
            "assets": {name: {k: item[k] for k in ("asset", "name", "zip")} for name, item in profile["deliveries"].items()},
            "dataOnly": True, **FALSE}


def validate_delivery_api(value, profile, env):
    # Draft access stays in the data-only write-token job. The read-only native
    # job binds that exact successful job, source/run and immutable output; its
    # inner receipt and independently pinned original ZIPs are checked below.
    keys(value, ("run", "job", "artifact"))
    run, job, artifact = (value[k] for k in ("run", "job", "artifact"))
    require(all(run.get(k) == v for k, v in {"id": int(env["GITHUB_RUN_ID"]), "run_attempt": int(env["GITHUB_RUN_ATTEMPT"]),
            "head_sha": env["GITHUB_SHA"], "head_branch": BRANCH.removeprefix("refs/heads/"), "path": WORKFLOW.split("/CREATOR-HUB/", 1)[1].split("@", 1)[0],
            "event": "workflow_dispatch", "status": "in_progress", "conclusion": None}.items())
            and all(run.get(n, {}).get("id") == 1364807512 and run[n].get("full_name") == REPO for n in ("repository", "head_repository")), "Current data-only carrier run/source differs")
    require(all(job.get(k) == v for k, v in {"name": "stage-input", "run_id": run["id"], "run_attempt": run["run_attempt"],
            "head_sha": run["head_sha"], "status": "completed", "conclusion": "success"}.items()) and "ubuntu-22.04" in job.get("labels", []), "Completed exact data-only stage job required")
    require(type(artifact.get("id")) is int and artifact["id"] > 0 and artifact.get("expired") is False
            and artifact.get("name") == "native-linux-production-016-update-inputs-" + env["GITHUB_RUN_ID"] + "-" + env["GITHUB_RUN_ATTEMPT"]
            and all(artifact.get("workflow_run", {}).get(k) == v for k, v in {"id": run["id"], "head_sha": run["head_sha"], "head_branch": run["head_branch"]}.items())
            and re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("digest", "")) and type(artifact.get("size_in_bytes")) is int
            and 0 < artifact["size_in_bytes"] <= MAX_ZIP, "Current stage artifact identity differs")


def validate_all_api(profile, api, env):
    keys(api, (*profile["artifacts"], "private"))
    for role, expected in profile["artifacts"].items():
        validate_api(api[role], expected)
    validate_delivery_api(api["private"], profile, env)


def unpack_carrier(folder, env):
    raw = read(folder / "profile.json", 65536)
    require(hashlib.sha256(raw).hexdigest() == env["UPDATE_PROFILE_SHA256"], "Carrier profile hash differs")
    profile = validate_profile(parse(raw), env["UPDATE_SCENARIO"])
    api = parse(read(folder / "api.json", 512 * 1024)); validate_all_api(profile, api, env)
    artifact = api["private"]["artifact"]
    receipt = (json.dumps(delivery_receipt(profile, env), sort_keys=True, indent=2) + "\n").encode()
    expected = {"zip": {"size": artifact["size_in_bytes"], "sha256": artifact["digest"].split(":", 1)[1]},
                "files": {**{name + ".zip": value["zip"] for name, value in profile["deliveries"].items()}, "delivery-proof.json": pin(receipt)}}
    output = folder / "carrier"; stage_zip(folder / "carrier.zip", expected, output)
    require(read(output / "delivery-proof.json", 65536) == receipt, "Stage proof is not this exact run/profile")
    for role, value in profile["deliveries"].items():
        write(folder / (role + ".zip"), bound(output / (role + ".zip"), value["zip"], MAX_ZIP))


def stage_zip(file, expected, output):
    bound(file, expected["zip"], MAX_ZIP)
    output.mkdir(mode=0o700)
    with zipfile.ZipFile(file) as archive:
        rows = archive.infolist()
        require(len(rows) == len(expected["files"]) and {row.filename for row in rows} == set(expected["files"]), "Complete exact ZIP inventory required")
        total = 0
        for row in rows:
            safe_name(row.filename)
            require(not row.is_dir() and not row.flag_bits & 1 and row.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    and stat.S_IFMT(row.external_attr >> 16) in (0, stat.S_IFREG), "ZIP link/special/encrypted entry refused")
            wanted = expected["files"][row.filename]
            require(row.file_size == wanted["size"], "ZIP member bound differs")
            total += row.file_size; require(total <= 1024 * 1024**2, "ZIP total bound")
            with archive.open(row) as stream:
                raw = stream.read(wanted["size"] + 1)
            require(pin(raw) == wanted, "ZIP member bytes differ")
            target = output / row.filename; target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            write(target, raw)


def public_root_tool(argv, *, input=None, env=None):
    package = BASE / "inputs/members/assembly16/native-packages/Creator Hub_0.1.16_amd64.deb"
    if input is not None or env is not None:
        return None
    if argv == ["/usr/bin/dpkg", "--install", str(package)]:
        return "baseline-dpkg-install"
    if argv == ["/usr/sbin/update-ca-certificates"]:
        return "update-ca-certificates"
    if argv == ["/usr/sbin/useradd", "--uid", "21314", "--user-group", "--create-home", "--home-dir",
                "/var/lib/creator-polkit-fixture", "--shell", "/bin/bash", "--groups", "sudo", "creator-polkit-fixture"]:
        return "synthetic-useradd"
    return None


def public_tool_failure(argv, out, err, failure_type, returncode=None, *, input=None, env=None):
    # Only these public, independently inspected commands may expose output.
    tool = public_root_tool(argv, input=input, env=env)
    if tool is None:
        return
    record = {"kind": "production016-public-tool-failure", "tool": tool, "pid": os.getpid(), "pidScope": "controller",
              "failureType": failure_type, "returncode": returncode}
    try:
        for label, stream in (("stdout", out), ("stderr", err)):
            size = stream.seek(0, os.SEEK_END); stream.seek(0)
            record[label] = {"bytes": size, "truncated": size > 8192, "text": stream.read(8192).decode("utf-8", errors="replace")}
        save(BASE / f"public-tool-failure-{tool}-{os.getpid()}.json", record, 0o644)
    except Exception as error:
        record["evidencePublicationErrorType"] = type(error).__name__
    try:
        print(json.dumps(record, separators=(",", ":"), allow_nan=False), file=sys.stderr, flush=True)
    except Exception:
        pass  # A failed diagnostic sink must not replace the original failure.


def run_tool(argv, *, input=None, allowed=(0,), timeout=90, env=None, limit=2 * 1024**2):
    path = ROOT_TOOL_PATH if public_root_tool(argv, input=input, env=env) in ("baseline-dpkg-install", "update-ca-certificates") else "/usr/bin:/bin"
    with __import__("tempfile").TemporaryFile() as out, __import__("tempfile").TemporaryFile() as err:
        try:
            result = subprocess.run(argv, input=input, stdin=subprocess.DEVNULL if input is None else None, stdout=out, stderr=err,
                                    env=env or {"PATH": path, "LANG": "C", "LC_ALL": "C"}, cwd="/", timeout=timeout, check=False)
        except Exception as error:
            public_tool_failure(argv, out, err, type(error).__name__, input=input, env=env)
            raise
        bounded = out.tell() <= limit and err.tell() <= 65536
        if not bounded or result.returncode not in allowed:
            public_tool_failure(argv, out, err, "NonzeroExit" if bounded else "DiagnosticLimitExceeded",
                                result.returncode, input=input, env=env)
        require(bounded, "Bounded tool diagnostics exceeded")
        out.seek(0); raw = out.read(limit + 1)
        require(result.returncode in allowed, "Fixed tool failed: " + Path(argv[0]).name)
        return raw


def build_offline_verifier(env):
    shared = load("native-linux-production-016-flatpak")
    parent = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-flatpak"
    work = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-verifier"
    require(shared.locations() == parent and shared.verifier_root() == work
            and parent.parent.resolve(strict=True) == parent.parent and os.getuid() == os.geteuid(), "Fixed verifier/evidence locations and caller required")
    require(not os.path.lexists(parent) and not os.path.lexists(work), "Fresh verifier/evidence parents required; no adoption or ownership repair")
    # The shared collector normally creates this parent. NEW3 reuses only its
    # builder, whose command recorder creates the evidence child, not its parent.
    parent.mkdir(mode=0o700)
    info = parent.lstat()
    require(parent.resolve(strict=True) == parent and stat.S_ISDIR(info.st_mode)
            and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, "Owned private tool-evidence parent required")
    shared.build_signature_verifier()
    shared_tool = shared.signature_verifier()  # builder-UID check only here, before elevation
    tool, evidence = offline_verifier(env)
    require(tool == shared_tool == work / "verify-package-input", "Shared and NEW3 verifier receipts must identify the same tool")
    return tool, evidence


def offline_verifier(env):
    """Recheck the shared builder's source/key/compiler and fresh tool evidence.

    Do not import another controller's admission or run it as root. Root copies
    only these captured tool bytes into its protected scripts directory.
    """
    root = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-verifier"
    receipt_raw = read(root / "receipt.json", 128 * 1024, mode=0o600)
    value = parse(receipt_raw)
    keys(value, ("schemaVersion", "scope", "harnessSource", "inputs", "compilers", "tool", "releaseReady"))
    require(value["schemaVersion"] == 1 and value["scope"] == "ci-only-offline-signature-verifier"
            and value["harnessSource"] == env["GITHUB_SHA"] and value["releaseReady"] is False, "Exact verifier build receipt required")
    source = Path(env["GITHUB_WORKSPACE"])
    pages = load("native-linux-integrated-pages")
    require(type(value["inputs"]) is dict and 3 < len(value["inputs"]) <= 64 and set(VERIFIER_PINS).issubset(value["inputs"])
            and {"native/linux-portable-deployment/Cargo.toml", "native/linux-portable-deployment/src/lib.rs"}.issubset(value["inputs"]), "Complete locked verifier source required")
    require({f.relative_to(root / "source").as_posix() for f in (root / "source").rglob("*") if not f.is_dir()} == set(value["inputs"]), "Verifier source inventory changed")
    for name, item in value["inputs"].items():
        safe_name(name)
        require(name in (*VERIFIER_PINS, "native/linux-portable-deployment/Cargo.toml") or name.startswith("native/linux-portable-deployment/src/") and name.endswith(".rs"), "Foreign verifier source")
        keys(item, ("pin", "originalStamp", "copyStamp")); validate_pin(item["pin"], 2 * 1024**2)
        if name in VERIFIER_PINS:
            require(item["pin"] == VERIFIER_PINS[name], "Production verifier/key/lock changed")
        for file, expected in ((source / name, item["originalStamp"]), (root / "source" / name, item["copyStamp"])):
            bound(file, item["pin"], 2 * 1024**2)
            require(list(pages.stamp(file.lstat())) == expected, "Verifier source identity changed")
    keys(value["compilers"], ("cargo", "rustc"))
    for name, item in value["compilers"].items():
        keys(item, ("path", "record", "stamp", "version")); file = Path(item["path"])
        require(file.name == name and file.parent.name == "bin" and file.parent.parent.name == "1.99.0-x86_64-unknown-linux-gnu"
                and item["version"].startswith(name + " 1.99.0 ") and pages.record(file) == item["record"]
                and list(pages.stamp(file.lstat())) == item["stamp"], "Exact compiler/toolchain identity changed")
    keys(value["tool"], ("pin", "stamp"))
    file = root / "verify-package-input"; raw = bound(file, value["tool"]["pin"], 64 * 1024**2, mode=0o755)
    require(raw[:4] == b"\x7fELF" and list(pages.stamp(file.lstat())) == value["tool"]["stamp"], "Fresh verified tool identity changed")
    return file, {"receipt": pin(receipt_raw), "tool": value["tool"]}


def signature(body, sig, verifier):
    tool, evidence = verifier
    raw, detached = read(body, 128 * 1024), read(sig, 4096)
    require(raw and detached, "Bounded nonempty signing input required")
    before = (stamp(Path(body).lstat()), stamp(Path(sig).lstat()), stamp(tool.lstat()))
    bound(tool, evidence["tool"]["pin"], 64 * 1024**2, mode=0o755)
    answer = run_tool([str(tool), str(body), str(sig)], limit=4096)
    require(answer == ("Verified trusted package signature: " + hashlib.sha256(raw).hexdigest() + ". No activation or client changes.\n").encode(), "Production-key signature refused")
    require((stamp(Path(body).lstat()), stamp(Path(sig).lstat()), stamp(tool.lstat())) == before
            and read(body, 128 * 1024) == raw and read(sig, 4096) == detached, "Signature input/tool changed")
    bound(tool, evidence["tool"]["pin"], 64 * 1024**2, mode=0o755)


def portable_manifest(value, version, baseline=None):
    keys(value, ("schemaVersion", "appId", "platform", "architecture", "version", "sourceCommit", "sourceTree", "format", "entrypoint", "archive", "entries"))
    expected = baseline if version == "16" else FIXED["17"]
    require(type(expected) is dict, "External final016 source binding is mandatory")
    require(all(value[k] == v for k, v in {"schemaVersion": 1, "appId": "creator-hub", "platform": "linux", "architecture": "x86_64",
            "version": "0.1." + version, "sourceCommit": expected["source"], "sourceTree": expected["tree"],
            "format": "appdir-tar-gzip-v1", "entrypoint": ROOT_ENTRY}.items()), "Actual version/source-bound complete portable manifest required")
    keys(value["archive"], ("size", "sha256", "unpackedSize")); validate_pin({k: value["archive"][k] for k in ("size", "sha256")})
    entries = value["entries"]
    require(type(entries) is dict and 0 < len(entries) <= 8192 and len({n.lower() for n in entries}) == len(entries), "Bounded unique complete inventory")
    total = 0
    for name, row in entries.items():
        safe_name(name)
        if row.get("kind") == "directory":
            require(row == {"kind": "directory", "mode": 0o755}, "Canonical directory metadata required")
        else:
            keys(row, ("kind", "mode", "size", "sha256"))
            require(row["kind"] == "file" and row["mode"] in (0o644, 0o755) and type(row["size"]) is int and 0 <= row["size"] <= MAX_FILE
                    and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]), "Canonical regular file metadata required")
            total += row["size"]; require(total <= MAX_TOTAL, "Complete inventory unpacked bound")
        for parent in Path(name).parents:
            if str(parent) != ".":
                require(entries.get(parent.as_posix()) == {"kind": "directory", "mode": 0o755}, "All parents explicitly signed directories")
    require(type(value["archive"]["unpackedSize"]) is int and value["archive"]["unpackedSize"] == total, "Signed total differs")
    for name in (ROOT_ENTRY, SELECTOR_ENTRY, "AppRun"):
        require(entries.get(name, {}).get("kind") == "file" and entries[name]["mode"] == 0o755, "Signed fixed entrypoint missing")
    return value


def verify_tar(file, manifest):
    raw = bound(file, {k: manifest["archive"][k] for k in ("size", "sha256")})
    ceiling = MAX_TOTAL + 8192 * 1024 + 10240
    decoder = zlib.decompressobj(31)
    decoded = decoder.decompress(raw, ceiling + 1)
    require(len(decoded) <= ceiling and decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data, "One bounded complete gzip stream required")
    seen, position, total = set(), 0, 0
    with tarfile.open(fileobj=io.BytesIO(decoded), mode="r:") as archive:
        for member in archive:
            name = safe_name(member.name)
            require(name in manifest["entries"] and name not in seen and not member.pax_headers
                    and member.uid == member.gid == 0 and member.uname == member.gname == ""
                    and member.offset == position and member.offset_data == position + 512, "Canonical signed TAR metadata required")
            wanted = manifest["entries"][name]; seen.add(name)
            require(member.mode == wanted["mode"], "TAR mode differs")
            position = member.offset_data + (member.size + 511) // 512 * 512
            if wanted["kind"] == "directory":
                require(member.isdir() and member.size == 0, "Signed directory became file/link")
            else:
                require(member.isfile() and member.size == wanted["size"], "Signed file became special/link or changed size")
                source = archive.extractfile(member); digest = hashlib.sha256(); count = 0
                while part := source.read(65536):
                    digest.update(part); count += len(part)
                    require(count <= wanted["size"], "TAR file grew")
                require(count == wanted["size"] and digest.hexdigest() == wanted["sha256"], "Signed TAR content differs")
                total += count
    tail = decoded[position:]
    require(seen == set(manifest["entries"]) and total == manifest["archive"]["unpackedSize"]
            and 1024 <= len(tail) <= 10240 and len(tail) % 512 == 0 and not any(tail), "Incomplete/noncanonical TAR ending")


def request(env, profile_raw, api_raw):
    scenario = admission(env)
    require(hashlib.sha256(profile_raw).hexdigest() == env["UPDATE_PROFILE_SHA256"], "External independent profile hash differs")
    profile = validate_profile(parse(profile_raw), scenario)
    validate_all_api(profile, parse(api_raw), env)
    _, verifier = offline_verifier(env)
    node = Path(env["CONTROLLER_NODE"])
    node_raw = read(node, 128 * 1024**2, mode=0o755)
    require(node_raw[:4] == b"\x7fELF", "Native workflow-provisioned Node executable required")
    result = {"schemaVersion": 1, "scenario": scenario, "context": {key: env[key] for key in ENVIRONMENT}, "nodeImage": pin(node_raw),
            "profile": pin(profile_raw), "api": pin(api_raw), "verifier": verifier,
            "sources": {name: pin(read(HERE / name, 2 * 1024**2)) for name in SOURCES},
            **FALSE}
    if scenario == HTML_SCENARIO:
        driver = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
        body = read(driver, 64 * 1024**2, mode=0o755)
        require(body[:4] == b"\x7fELF", "Native pinned-workflow WebDriver tool required")
        result["htmlDriver"] = {"version": HTML_DRIVER_VERSION, "pin": pin(body)}
    return result


def private_target_qualification():
    return {"scope": "private-source75-updater-lifecycle-only", "targetSource": FIXED["17"]["source"],
            "targetRetirementHelper": dict(FIXED["17"]["helper"]), "privateDebApprovalRestoresOldRetirementHelper": True,
            "final016HelperFixRetained": False, "targetFixNativeAcceptance": False, "futurePublic017Qualified": False,
            "releaseReady": False}


def compare_update_packages(baseline, candidate, baseline_pins):
    """Closed NEW3 comparison, not an override of the historical017 verifier.

    Source75's exact old helper is intentional private test data. Replacing the
    final016 helper does not qualify fix retention or a future public017 build.
    """
    shared = load("private-linux-update-fixture-017-package-verify")
    expected = {"baseline": {k: baseline_pins[k] for k in ("deb", "hub", "helper", "policy", "service")},
                "candidate": {k: FIXED["17"][k] for k in ("deb", "hub", "archive")}}
    shared.validate_expected(expected)
    before, after = baseline["fields"], candidate["fields"]
    require(before["Version"] == "0.1.16" and after["Version"] == "0.1.17" and set(before) == set(after), "Only actual016 -> source75 private017 control fields admitted")
    for name in before:
        if name not in ("Version", "Installed-Size"):
            require(before[name] == after[name], "Unreviewed package control delta")
    for fields in (before, after):
        require(fields["Package"] == "creator-hub" and fields["Architecture"] == "amd64"
                and re.fullmatch(r"[1-9][0-9]*", fields.get("Installed-Size", ""))
                and int(fields["Installed-Size"]) <= shared.LIMIT // 1024, "Exact bounded package identity required")
    old, new = baseline["files"], candidate["files"]
    archive = shared.ARCHIVE
    require(set(old) == set(new) and {ROOT_ENTRY, archive, RETIREMENT_HELPER}.issubset(new), "Package paths changed")
    for name in old:
        if name not in (ROOT_ENTRY, archive, RETIREMENT_HELPER):
            require(old[name] == new[name], "Only Root, module archive and the fixed source75 helper may change")
        else:
            require(all(old[name][k] == new[name][k] for k in ("kind", "mode", "uid", "gid"))
                    and new[name]["kind"] == "file", "Changed regular-member ownership or mode")
    for package in (baseline, candidate):
        require(package["md5sums"] == {n: v["md5"] for n, v in package["files"].items() if v["kind"] == "file"}, "DEB checksums do not match actual data")
    shared.baseline_members(baseline, expected["baseline"])
    shared.baseline_members(candidate, {"hub": FIXED["17"]["hub"], "helper": FIXED["17"]["helper"],
                                        "policy": baseline_pins["policy"], "service": baseline_pins["service"]})
    require({k: new[archive][k] for k in ("size", "sha256")} == FIXED["17"]["archive"]
            and old[ROOT_ENTRY]["sha256"] != new[ROOT_ENTRY]["sha256"], "Original source75 Root/archive pins required; relabelling refused")
    for name in (ROOT_ENTRY, RETIREMENT_HELPER):
        header = bytes.fromhex(new[name]["header"])
        require(new[name]["mode"] == 0o755 and header[:7] == b"\x7fELF\x02\x01\x01" and header[18:20] == b"\x3e\x00", "Exact native x86_64 executable required")
    require(new[archive]["mode"] == 0o644, "Exact archive mode required")
    return private_target_qualification()


def stage(folder, env):
    scenario = admission(env)
    profile_raw, api_raw = read(folder / "profile.json", 65536, mode=0o600), read(folder / "api.json", 512 * 1024, mode=0o600)
    sealed = request(env, profile_raw, api_raw); profile = parse(profile_raw)
    expected_names = {"profile.json", "api.json", *(n + ".zip" for n in input_roles(profile))}
    actual_names = {p.name for p in folder.iterdir()}
    require(actual_names in (expected_names, expected_names | {"carrier", "carrier.zip"}), "Fresh complete input set, no partial stage adoption")
    verifier = offline_verifier(env)
    if os.geteuid() == 0:
        tool = BASE / "scripts/verify-package-input"
        bound(tool, sealed["verifier"]["tool"]["pin"], 64 * 1024**2, uid=0, mode=0o755)
        verifier = (tool, sealed["verifier"])
    members = folder / "members"; members.mkdir(mode=0o700)
    for name, artifact in input_roles(profile).items():
        stage_zip(folder / (name + ".zip"), artifact, members / name)
    obj = lambda name: object_path(folder, profile, name)
    if scenario.startswith("deb-"):
        signature(obj("debDescriptor17"), obj("debSignature17"), verifier)
        descriptor = parse(read(obj("debDescriptor17"), 32768))
        require(descriptor["appId"] == "creator-hub" and descriptor["version"] == "0.1.17" and descriptor["platform"] == "linux"
                and descriptor["architecture"] == "x86_64" and descriptor["packageType"] == "deb"
                and descriptor["assetName"] == "Creator_Hub_0.1.17_amd64-acceptance-only.deb"
                and {"size": descriptor["byteLength"], "sha256": descriptor["sha256"]} == FIXED["17"]["deb"]
                and descriptor["executableSha256"] == FIXED["17"]["hub"]["sha256"], "Signed DEB envelope differs from actual private017 package")
        latest = parse(read(obj("latest17"), 32768)); entry = latest["platforms"]["linux-x86_64-deb"]
        detached = base64.b64decode(entry["signature"], validate=True)
        require(latest["version"] == "0.1.17" and set(latest["platforms"]) == {"linux-x86_64-deb"}
                and entry["url"] == "https://github.com/" + REPO + "/releases/download/v0.1.17/" + descriptor["assetName"]
                and 0 < len(detached) <= 4096 and detached.startswith(b"untrusted comment:"), "Exact Tauri signature route/encoding required")
        # The signed descriptor authenticates these exact DEB bytes. The product
        # must additionally verify the separately pinned native installer signature.
    package_verifier = load("private-linux-update-fixture-017-package-verify"); base = package_verifier.base_reader()
    baseline = profile["baseline"]
    receipt = parse(read(obj("assemblyReceipt16"), 2 * 1024**2))
    require(receipt["hubVersion"] == "0.1.16" and receipt["assemblyCommit"] == baseline["source"] and receipt["compiledFeatures"] == FEATURES
            and receipt["portableHostBuild"]["sourceCommit"] == baseline["source"] and receipt["portableHostBuild"]["sourceTree"] == baseline["tree"]
            and receipt["portableHostBuild"]["compiledFeatures"] == FEATURES and receipt["portableHostBuild"]["rawHub"] == baseline["raw"]
            and receipt["productionMigration"]["sourceCommit"] == baseline["source"] and receipt["productionMigration"]["sourceTree"] == baseline["tree"]
            and receipt["productionMigration"]["rawHub"] == baseline["raw"] and receipt["productionMigration"]["compiledFeatures"] == FEATURES
            and receipt["privateModulesRecompiled"] is False and receipt["privateModulesResigned"] is False and receipt["releaseReady"] is False,
            "Actual final016 compile proofs/production four-tuple differ")
    base.verify(str(obj("deb16")), baseline["helper"]["sha256"], baseline["policy"]["sha256"], "0.1.16", "production-migration-016")
    expected = {"baseline": {k: baseline[k] for k in ("deb", "hub", "helper", "policy", "service")},
                "candidate": {"deb": FIXED["17"]["deb"], "hub": FIXED["17"]["hub"], "archive": FIXED["17"]["archive"]}}
    old = package_verifier.inspect(obj("deb16"), expected["baseline"], base, "0.1.16")
    new = package_verifier.inspect(obj("deb17"), {**expected["candidate"], "helper": FIXED["17"]["helper"], **{k: baseline[k] for k in ("policy", "service")}}, base, "0.1.17")
    qualification = compare_update_packages(old, new, baseline)
    for version in ("16", "17"):
        native = load("native-linux-root-probe")
        native.verify_deb_marker(read(obj("raw" + version), MAX_FILE), packaged_root(obj("deb" + version), baseline["hub"] if version == "16" else FIXED["17"]["hub"]))
    review = {"baseline": baseline, "deb16": old["files"], "deb17": new["files"], "portable": {}, "signaturesVerified": True,
              "privateTargetQualification": qualification, **FALSE}
    if scenario.startswith("portable-"):
        for version in ("16", "17"):
            signature(obj("portableDescriptor" + version), obj("portableSignature" + version), verifier)
            signature(obj("portableManifest" + version), obj("manifestSignature" + version), verifier)
            body = read(obj("portableManifest" + version), 128 * 1024)
            manifest = portable_manifest(parse(body), version, baseline)
            envelope = parse(read(obj("portableDescriptor" + version), 32768))
            require(envelope["appId"] == "creator-hub" and envelope["version"] == "0.1." + version
                    and envelope["platform"] == "linux" and envelope["architecture"] == "x86_64" and envelope["packageType"] == "portable-appdir"
                    and envelope["manifest"] == {"assetName": "creator-hub-linux-x86_64-0.1." + version + ".portable-manifest.json", "byteLength": len(body), "sha256": hashlib.sha256(body).hexdigest()}
                    and envelope["archive"] == {"assetName": "creator-hub-linux-x86_64-0.1." + version + ".appdir.tar.gz", "byteLength": manifest["archive"]["size"], "sha256": manifest["archive"]["sha256"]}
                    and envelope["executableSha256"] == manifest["entries"][ROOT_ENTRY]["sha256"] and envelope["restartProtocol"] == 1, "Distinct signed portable envelope/manifest/archive disagree")
            verify_tar(obj("archive" + version), manifest)
            review["portable"][version] = {"generation": hashlib.sha256(body).hexdigest(), "manifest": manifest,
                                            "signature": object_pin(profile, "manifestSignature" + version)}
        source = obj("appimage16"); before = stamp(source.lstat())
        alias = folder / "Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
        write(alias, bound(source, object_pin(profile, "appimage16")), 0o755)
        bound(alias, object_pin(profile, "appimage16"), mode=0o755)
        require(stamp(source.lstat()) == before, "Original AppImage changed during exact-byte setup alias copy")
    save(folder / "review.json", review)
    save(folder / "request.json", sealed)


def packaged_root(package, expected):
    before = stamp(package.lstat())
    raw = run_tool(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(package)], limit=MAX_TOTAL)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        entries = [row for row in archive if row.name.removeprefix("./") == ROOT_ENTRY]
        require(len(entries) == 1 and entries[0].isreg() and entries[0].size == expected["size"], "Exact packaged Root regular entry required")
        with archive.extractfile(entries[0]) as stream:
            body = stream.read(expected["size"] + 1)
    require(pin(body) == expected and stamp(package.lstat()) == before, "Packaged Root bytes changed")
    return body


def phase_identity(record, expected, executable, parent, uid, *, previous=None, baseline=()):
    require(type(record.get("pid")) is int and record["pid"] > 1 and re.fullmatch(r"[1-9][0-9]*", record.get("startTime", ""))
            and record.get("uids") == [uid] * 4 and record.get("parentPid") == parent and record.get("executable") == executable
            and record.get("kernelImageSha256") == expected["sha256"] and int(record.get("image", {}).get("st_size", "-1")) == expected["size"], "Exact live phase PID/start/UID/parent/path/kernel image required")
    if previous:
        require(record["pid"] != previous["pid"] and record["pid"] not in baseline
                and int(record["startTime"]) > int(previous["startTime"]), "Fresh automatic successor required, never baseline/PID reuse")
    return record


def pending_command(raw):
    require(raw == b"/usr/bin/pkexec\0--disable-internal-agent\0/usr/bin/dpkg\0--install\0/proc/self/fd/0\0", "Exact native sealed DPKG request required")


def selection(value, generation, previous=None):
    require(value == {"schemaVersion": 1, "generation": generation, "version": "0.1.17" if previous else "0.1.16", "previousGeneration": previous}, "Exact current/prior signed generation selection required")


def outcome(scenario, evidence):
    require(evidence.get("privateTargetQualification") == private_target_qualification()
            and evidence.get("oldRetirementHelperRestored") is (scenario == "deb-approve"), "Private target must disclose the old helper; no fix-retention/public017 qualification")
    require(scenario in SCENARIOS and all(evidence.get(n) is True for n in ("initial16Verified", "nativeConfirmationObserved", "settingsPreserved", "runtimeSurvived", "normalFinalClose")), "Full initial/consent/preservation/close proof required")
    if scenario == HTML_SCENARIO:
        html = evidence.get("htmlWebDriver", {})
        require(html.get("probePassed") is True and type(html.get("inputCountAtProbe")) is int and html["inputCountAtProbe"] == 0
                and html.get("detached") is True and html.get("toolsClosedAfterRootExit") is True,
                "Attached HTML compatibility and independent normal Root close required")
    if scenario.endswith("native-cancel"):
        require(evidence.get("nativeActions") == ["Not now"] and evidence.get("systemActions") == []
                and evidence.get("oldSelectionUnchanged") is True and evidence.get("initialRootSurvived") is True
                and evidence.get("automaticSuccessor") is None, "Native Cancel must leave original installation/process/selection")
    elif scenario == "deb-auth-cancel":
        require(evidence.get("nativeActions") == ["Update Hub"] and evidence.get("systemActions") == ["Cancel"]
                and evidence.get("sealed17Observed") is True and evidence.get("oldSelectionUnchanged") is True
                and evidence.get("initialRootSurvived") is True and evidence.get("automaticSuccessor") is None, "System Cancel proof incomplete")
    else:
        require(evidence.get("nativeActions") == ["Update Hub"] and evidence.get("systemActions") == (["Authenticate"] if scenario == "deb-approve" else [])
                and all(evidence.get(n) is True for n in ("oldNormalExit", "automaticRestartObserved", "installed17Verified", "fresh17UiVersion", "directPagesObserved"))
                and type(evidence.get("automaticSuccessor")) is dict, "Full real automatic update/restart/UI proof required")
    require(evidence.get("initialBitmap", {}).get("nonblank") is True and (not scenario.endswith("approve")
            or evidence.get("successorBitmap", {}).get("nonblank") is True), "Actual owned nonblank phase images required")
    require(all(evidence.get(k) is False for k in FALSE), "Scope cannot be promoted to public/Flatpak/release acceptance")
    return True


def children(pid):
    result = set()
    for task in Path(f"/proc/{pid}/task").iterdir():
        try:
            with (task / "children").open("rb") as stream:
                raw = stream.read(8193)
        except FileNotFoundError:
            continue
        require(len(raw) <= 8192 and re.fullmatch(rb"[0-9 ]*", raw), "Bounded kernel child inventory required")
        result.update(map(int, raw.split()))
    require(len(result) <= 64, "Kernel child count exceeds bound")
    return result


def alive_stat(pid):
    with Path(f"/proc/{pid}/stat").open("rb") as stream:
        raw = stream.read(4097)
    require(raw.startswith(str(pid).encode() + b" (") and len(raw) <= 4096, "Bounded exact process stat required")
    fields = raw[raw.rfind(b")") + 2:].split()
    require(len(fields) >= 20 and fields[0] not in (b"Z", b"X", b"x"), "Nonlive process is not an update successor")
    return fields


def kernel_record(pid, native, helper):
    before = alive_stat(pid)
    value = native.native_process(pid, helper)
    after = alive_stat(pid)
    require((after[1], after[19]) == (before[1], before[19]), "Process identity/parent changed during live-image observation")
    return value


def wait(test, seconds=30, pump=lambda: None):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump()
        value = test()
        if value:
            return value
        time.sleep(0.05)
    raise RuntimeError("Readiness deadline; no repeated input, manual successor or outcome adoption")


def refusal_diagnostic(error):
    # Never read locals, source lines, exception messages or native objects here.
    frames, visited = [], 0
    current = BaseException.__getattribute__(error, "__traceback__")
    known_files = {str(root / name): name for root in (HERE, BASE / "scripts") for name in SOURCES}
    while current is not None and visited < 64:
        code = current.tb_frame.f_code
        file, function = code.co_filename, code.co_name
        known = file in known_files
        frame = {"file": known_files[file] if known else "other", "line": current.tb_lineno}
        if known and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,95}|<module>|<lambda>", function):
            frame["function"] = function
        else:
            frame["functionSha256"] = hashlib.sha256(function[:4096].encode()).hexdigest()
        if not known:
            frame["filePrefixSha256"] = hashlib.sha256(file[:4096].encode()).hexdigest()
            frame["fileChars"] = len(file)
        frames.append(frame)
        frames = frames[-16:]
        current, visited = current.tb_next, visited + 1
    value = {"schemaVersion": 1, "frames": frames, "visitedFrames": visited,
             "truncated": current is not None or visited > 16}
    module = sys.modules.get("gi._error")
    glib_type = module.__dict__.get("GError") if type(module) is type(sys) else None
    if isinstance(glib_type, type) and isinstance(error, glib_type):
        fields = BaseException.__getattribute__(error, "__dict__")
        domain, code = fields.get("domain"), fields.get("code")
        info = {"domain": {"kind": "unavailable"}, "code": code if type(code) is int and -(2**31) <= code < 2**31 else None}
        if type(domain) is str:
            info["domain"] = ({"value": "atspi_error"} if domain == "atspi_error" else
                              {"kind": "redacted", "chars": len(domain), "prefixSha256": hashlib.sha256(domain[:256].encode()).hexdigest()})
        value["glib"] = info
    require(len(json.dumps(value, allow_nan=False).encode()) <= 8192, "Refusal diagnostic exceeds bound")
    return value


def retain_refusal_diagnostic(record, error):
    try:
        if "refusalDiagnostic" not in record:
            record["refusalDiagnostic"] = refusal_diagnostic(error)
    except Exception:
        record.setdefault("refusalDiagnosticUnavailable", True)


def fingerprint(file):
    first = Path(file).lstat(); raw = read(file, 2 * 1024**2)
    require(stamp(Path(file).lstat()) == stamp(first), "Fixture changed during observation")
    return {**pin(raw), "dev": first.st_dev, "ino": first.st_ino, "uid": first.st_uid, "gid": first.st_gid, "mode": stat.S_IMODE(first.st_mode)}


def fixtures(home):
    selected, other = home / "selected-project", home / "other-project"
    files = {
        CONFIG: {"channels": [{"id": "selected", "name": "Selected update project", "unity_project_path": str(selected), "enabled": True, "scene_path": None},
                              {"id": "other", "name": "Other update project", "unity_project_path": str(other), "enabled": False, "scene_path": None}],
                 "active_channel_id": "selected", "mcp_server_path": "/fixture/never-run-server.mjs", "auto_start": False,
                 "automatic_update_checks": False, "connection_guide_version": 1, "tool_groups": "core", "enable_custom_scripts": False,
                 "allow_all_tests": False, "unknownConfig": {"keep": [16, 17]}},
        PREFS: {"schemaVersion": 1, "preview": False, "autoDownload": False, "restoreHostedViews": True},
        "data/CreatorHub/projects.json": {"paths": [str(selected), str(other)], "unknown": "keep"},
        "data/CreatorProjectSetup/editor-roots.json": ["/fixture/no-editor"],
        "config/Claude/claude_desktop_config.json": {"mcpServers": {"unrelated": {"command": "/fixture/do-not-run", "args": ["retained"]}}, "unknown": "keep"},
        ".claude.json": {"mcpServers": {"unrelated": {"command": "/fixture/do-not-run"}}, "unknown": [16, 17]},
        ".codex/config.toml": 'model = "synthetic-never-run"\n[unrelated]\nkeep = "exact"\n',
        "config/Code/User/mcp.json": {"servers": {"unrelated": {"command": "/fixture/do-not-run"}}, "unknown": "keep"},
        "unrelated/keep.json": {"untouched": ["settings", "projects", "update"]},
    }
    for project in ("selected-project", "other-project"):
        files[project + "/Assets/keep.txt"] = "Synthetic update project; never open in Unity.\n"
        files[project + "/Packages/manifest.json"] = {"dependencies": {"com.sidequest.creator-sdk": "4.0.14"}, "unknown": "keep"}
        files[project + "/ProjectSettings/ProjectVersion.txt"] = "m_EditorVersion: 6000.3.21f1\n"
    for name, value in files.items():
        file = home / name; file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write(file, value.encode() if type(value) is str else (json.dumps(value) + "\n").encode())
    return {name: fingerprint(home / name) for name in files}


def preserved(home, before):
    after = {name: fingerprint(home / name) for name in before}
    require(after == before, "Protected preference/client/project bytes or identity changed")
    require(not any(home.rglob("*.bak")) and not (home / "config/creator-works-mcp/.creator-hub-product-settings").exists()
            and not (home / "data/CreatorHub/client-migrations-v1").exists(), "Update lane unexpectedly migrated or backed up client settings")
    return after


def windows(x11):
    value = x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_CLIENT_LIST_STACKING")
    if value is None:
        return []
    require(value[:2] == (33, 32) and len(value[2]) <= 8 and len(set(value[2])) == len(value[2]), "Malformed/foreign window inventory")
    return value[2]


class _IncompleteHtmlSnapshot(RuntimeError):
    def __init__(self, reason, detail):
        require(reason in ("missing-parent", "missing-child", "changed-child-count", "disposed-accessible"), "Unknown incomplete HTML AX read")
        super().__init__("Incomplete owned HTML AX snapshot")
        self.reason, self.detail = reason, detail


class Surface:
    """One live signed Root, one manifest/system-bound renderer and one XRes frame."""
    def __init__(self, record, x11, helper, native, atspi, *, manifest=None, generation_dir=None, title=TITLE, dialog=False, inventory=None):
        self.record, self.x11, self.helper, self.native, self.atspi = record, x11, helper, native, atspi
        self.inventory = inventory
        self.manifest, self.generation_dir, self.dialog = manifest, generation_dir, dialog
        self.renderer = None
        self.references, self.bus = native.native_ax_references()
        self.root = record
        self.pid = record["pid"]
        self.window = wait(lambda: self.find_window(title))
        self.request = helper.Request("snapshot", self.pid, record["startTime"], record["executable"], record["kernelImageSha256"],
                                      self.window, title, "ALERT" if dialog else "FRAME",
                                      gtk_message_info_frame=x11.frame_rectangle(self.window) if dialog else None)
        self.xres = helper.bound_window(self.request, x11)
        self.main_window = None
        if dialog:
            others = [w for w in windows(x11) if w != self.window]
            require(len(others) == 1, "One exact main/modal pair required")
            main = x11.inspect(others[0])
            require(main["pid"] == self.pid and main["title"] == TITLE and main["mapped"] and main["client"] > 0, "Foreign modal parent window")
            self.main_window = (others[0], {k: main[k] for k in ("pid", "title", "mapped", "client")})
        self.last = None
        self.html_actions = []
        self.call_phase = None
        self.ax_parent_diagnostic = None
        self.ax_snapshot_diagnostic = None

    def find_window(self, title):
        self.stable()
        matches = [w for w in windows(self.x11) if self.x11.inspect(w)["pid"] == self.pid and self.x11.inspect(w)["title"] == title]
        require(len(matches) <= 1, "Ambiguous native frame")
        if not matches:
            return None
        require(self.x11.inspect(matches[0])["mapped"], "Native frame is not mapped")
        return matches[0]

    def stable(self):
        actual = self.native.native_process(self.pid, self.helper, full=False)
        alive_stat(self.pid)
        require(all(self.record.get(key) == value for key, value in actual.items()), "Bound Root changed")

    def recheck(self, full=False):
        self.stable()
        require(self.helper.bound_window(self.request, self.x11) == self.xres, "Bound XRes frame changed")
        if self.main_window:
            window, expected = self.main_window
            require(set(windows(self.x11)) == {self.window, window} and {k: self.x11.inspect(window)[k] for k in expected} == expected,
                    "Owned main/modal pair changed")
        if self.renderer:
            actual = self.native.native_process(self.renderer["pid"], self.helper, full=False)
            alive_stat(self.renderer["pid"])
            require(all(self.renderer.get(key) == value for key, value in actual.items()), "Bound renderer changed")
        if full:
            require(kernel_record(self.pid, self.native, self.helper) == self.record, "Root image changed")
            if self.renderer:
                require(kernel_record(self.renderer["pid"], self.native, self.helper) == self.renderer, "Renderer image changed")
        self.references.recheck()

    def node(self, node):
        self.stable()
        pid = node.get_process_id()
        if pid != self.pid:
            require(not self.dialog, "Native consent must not adopt a renderer/foreign process")
            if self.renderer is None:
                peer = kernel_record(pid, self.native, self.helper)
                require(peer["parentPid"] == self.pid and peer["uids"] == self.record["uids"]
                        and int(peer["startTime"]) >= int(self.record["startTime"]), "Renderer is not a fresh direct owned child")
                if self.manifest:
                    relative = Path(peer["executable"]).relative_to(self.generation_dir).as_posix()
                    require(relative.endswith("/WebKitWebProcess") and relative in self.manifest["entries"], "Renderer outside signed AppDir")
                    entry = self.manifest["entries"][relative]
                    require(entry["kind"] == "file" and entry["mode"] == 0o755
                            and peer["kernelImageSha256"] == entry["sha256"] and int(peer["image"]["st_size"]) == entry["size"], "Renderer differs from signed inventory")
                else:
                    self.native.validate_peer(peer, self.record)
                    self.native.verify_system_webkit()
                self.renderer = peer
            require(pid == self.renderer["pid"], "Additional AX process refused")
        self.references.identity(node, self)
        self.recheck()

    def same_node(self, a, b):
        return a is not None and b is not None and self.references.identity(a, self) == self.references.identity(b, self)

    def live_children(self, node, limit, context):
        # Separate from the strict native-close helper: no partial HTML read authorizes input.
        node.clear_cache()
        count = node.get_child_count()
        require(type(count) is int and 0 <= count <= limit, "Root close child count exceeds bound")
        result = []
        for index in range(count):
            node.clear_cache()
            child = node.get_child_at_index(index)
            if child is None:
                raise _IncompleteHtmlSnapshot("missing-child", {**context, "site": "Surface.live_children", "count": count, "index": index})
            result.append(child)
        node.clear_cache()
        after = node.get_child_count()
        require(type(after) is int and 0 <= after <= limit, "Root close child count exceeds bound")
        if after != count:
            raise _IncompleteHtmlSnapshot("changed-child-count", {**context, "site": "Surface.live_children", "count": count, "afterCount": after})
        return result

    def walk(self):
        self.recheck(full=True)
        deadline = getattr(self, "_snapshot_deadline", None)
        if deadline is None:
            frame = wait(self.native_frame)
        else:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "HTML AX snapshot deadline")
            frame = wait(self.native_frame, seconds=remaining)
        require(frame.get_process_id() == self.pid, "AX frame PID differs")
        ref = self.references.identity(frame, self)
        if self.references.window is None:
            self.references.window = ref
        require(self.references.window == ref, "AX frame wire identity changed")
        pending, nodes, seen, parents = [(frame, None, 0)], [], set(), []
        while pending:
            node, parent, depth = pending.pop()
            require(node is not None and len(nodes) < (64 if self.dialog else 512) and depth < 32, "Bounded owned AX graph required")
            node.clear_cache(); self.node(node)
            key = tuple(self.references.identity(node, self))
            require(key not in seen, "Duplicate/cyclic AX graph")
            seen.add(key)
            if depth:
                role = node.get_role()
                require(role not in (self.atspi.Role.APPLICATION, self.atspi.Role.FRAME, self.atspi.Role.WINDOW), "Nested AX window refused")
                actual = node.get_parent()
                if actual is None and getattr(self, "ax_parent_diagnostic", None) is None:
                    self.ax_parent_diagnostic = {"site": "Surface.walk/parent-presence", "phase": getattr(self, "call_phase", None),
                        "nodeReference": key, "expectedParentReference": parent, "actualParentPresent": False,
                        "depth": depth, "visitedCount": len(nodes), "pendingCount": len(pending), "role": int(role),
                        "unreadFields": ["state", "toolkit", "sourceId"]}
                if actual is None and not self.dialog:
                    raise _IncompleteHtmlSnapshot("missing-parent", {"site": "Surface.walk/parent-presence", "nodeReference": key,
                        "expectedParentReference": parent, "depth": depth, "visitedCount": len(nodes), "pendingCount": len(pending), "role": int(role)})
                require(actual is not None, "Missing AX parent")
                self.node(actual); parents.append(tuple(self.references.identity(actual, self)))
            nodes.append(node)
            limit = min(64, 512 - len(nodes) - len(pending))
            children = (self.helper.fresh_close_children(node, limit) if self.dialog else self.live_children(node, limit,
                {"nodeReference": key, "depth": depth, "visitedCount": len(nodes), "pendingCount": len(pending)}))
            pending.extend((child, key, depth + 1) for child in reversed(children))
        require(all(parent in seen for parent in parents), "AX semantic parent escaped owned frame")
        self.recheck(full=True)
        return nodes

    def native_frame(self):
        self.recheck()
        apps = [app for app in self.helper.fresh_close_children(self.atspi.get_desktop(0), 128) if app.get_process_id() == self.pid]
        require(len(apps) <= 1, "Ambiguous owned AX application")
        if not apps:
            return None
        tops = self.helper.fresh_close_children(apps[0], 32)
        require(all(node.get_process_id() == self.pid for node in tops), "Foreign AX top-level")
        matches = []
        for node in tops:
            node.clear_cache()
            if node.get_name() == self.request.accessibility_name:
                require(node.get_role() == getattr(self.atspi.Role, self.request.role), "Owned frame role differs")
                matches.append(node)
        require(len(matches) <= 1, "Ambiguous exact AX frame")
        if not matches:
            return None
        frame = matches[0]
        state = frame.get_state_set()
        if not all(state.contains(getattr(self.atspi.StateType, name)) for name in ("SHOWING", "ENABLED", "SENSITIVE")) or state.contains(self.atspi.StateType.BUSY):
            return None
        require(not state.contains(self.atspi.StateType.DEFUNCT), "Defunct AX frame")
        if self.dialog:
            rect = frame.get_component_iface().get_extents(self.atspi.CoordType.SCREEN)
            require((rect.x, rect.y, rect.width, rect.height) == self.request.gtk_message_info_frame, "Modal AX/native frame geometry differs")
        return frame

    def _snapshot_rows(self, nodes):
        rows = []
        for node in nodes:
            protected = node.get_role() == self.atspi.Role.PASSWORD_TEXT or node.get_state_set().contains(self.atspi.StateType.EDITABLE)
            attrs = node.get_attributes(); name = "" if protected else (node.get_name() or "")
            require(type(attrs) is dict and len(attrs) <= 32 and len(name) <= 4096, "Bounded source UI metadata")
            states = node.get_state_set()
            row = {"reference": self.references.identity(node, self), "id": attrs.get("id"), "tag": attrs.get("tag"),
                   "toolkit": attrs.get("toolkit"), "role": int(node.get_role()), "name": name,
                   **{s.lower(): states.contains(getattr(self.atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}}
            row["pressed"] = states.contains(self.atspi.StateType.PRESSED)
            if not protected and row["showing"] and node.get_role() in (self.atspi.Role.LABEL, self.atspi.Role.TEXT, self.atspi.Role.STATIC, self.atspi.Role.PARAGRAPH, self.atspi.Role.STATUS_BAR, 72):
                text = node.get_text_iface()
                if node.get_role() == self.atspi.Role.STATUS_BAR:
                    row["textInterfaceAvailable"] = bool(text)
                if text:
                    count = text.get_character_count(); require(type(count) is int and 0 <= count <= 4096, "Bounded UI text")
                    row["text"] = text.get_text(0, count)
                    require(text.get_character_count() == count and len(row["text"].encode()) <= 16384, "UI text changed")
            rows.append(row)
        require(len(json.dumps(rows).encode()) <= 131072, "Bounded UI snapshot")
        return rows

    def _snapshot_once(self):
        nodes = self.walk()
        if self.dialog:
            return self._snapshot_rows(nodes), nodes
        module = sys.modules.get("gi._error")
        candidate = module.__dict__.get("GError") if type(module) is type(sys) else None
        glib_error = candidate if isinstance(candidate, type) and issubclass(candidate, BaseException) else ()
        try:
            rows = self._snapshot_rows(nodes)
        except glib_error as error:
            if type(error) is not glib_error:
                raise
            fields = BaseException.__getattribute__(error, "__dict__")
            if (type(fields.get("domain")) is not str or fields["domain"] != "atspi_error"
                    or type(fields.get("code")) is not int or fields["code"] != 0
                    or self.renderer is None or self.references.window is None):
                raise
            detail = {"site": "Surface._snapshot_rows", "glibDomain": "atspi_error", "glibCode": 0}
            retain_refusal_diagnostic(detail, error)
            if "refusalDiagnostic" not in detail:
                raise
            raise _IncompleteHtmlSnapshot("disposed-accessible", detail) from error
        return rows, nodes

    def snapshot(self):
        if self.dialog:
            result = self._snapshot_once()
            self.last = result[0]
            return result
        # Admission deadline only; synchronous native reads retain their existing timeouts.
        self._snapshot_deadline = time.monotonic() + 30
        evidence = None
        try:
            for attempt in range(1, 9):
                if evidence is not None:
                    evidence["attempts"] = attempt
                require(time.monotonic() < self._snapshot_deadline, "HTML AX snapshot deadline")
                try:
                    result = self._snapshot_once()
                except _IncompleteHtmlSnapshot as error:
                    if self.ax_snapshot_diagnostic is None:
                        self.ax_snapshot_diagnostic = {"firstIncomplete": {**error.detail, "reason": error.reason,
                            "phase": self.call_phase, "attempt": attempt}, "incompleteReads": 0}
                    evidence = self.ax_snapshot_diagnostic
                    evidence.update(incompleteReads=evidence["incompleteReads"] + 1, attempts=attempt, outcome="incomplete")
                    require(time.monotonic() < self._snapshot_deadline, "HTML AX snapshot deadline")
                    self.recheck(full=True)
                    require(time.monotonic() < self._snapshot_deadline, "HTML AX snapshot deadline")
                    continue
                require(time.monotonic() < self._snapshot_deadline, "HTML AX snapshot deadline")
                self.recheck(full=True)
                require(time.monotonic() < self._snapshot_deadline, "HTML AX snapshot deadline")
                if evidence is not None:
                    evidence["outcome"] = "complete"
                self.last = result[0]
                return result
            evidence["outcome"] = "attempt-limit"
            raise RuntimeError("Incomplete owned HTML AX snapshot attempt limit")
        finally:
            del self._snapshot_deadline

    def source(self, source_id, *, optional=False):
        rows, nodes = self.snapshot()
        matches = [(row, node) for row, node in zip(rows, nodes) if row["id"] == source_id and row["showing"] and not row["defunct"]]
        require(len(matches) <= 1, "Ambiguous source control: " + source_id)
        if optional and not matches:
            return None
        require(len(matches) == 1 and matches[0][0]["toolkit"] == "WebKitGTK", "Owned source control missing: " + source_id)
        return matches[0]

    def html_action_interface(self, node, row, control):
        require(control in {"suite-trigger", "usage-terms-checkbox", "usage-terms-continue", "convergence-later",
                            "native-support-install", "hub-update-button", "navigation-mcp", "navigation-setup", "navigation-home"}
                and len(self.html_actions) < 64, "Bounded fixed HTML action diagnostic required")
        entry = {"control": control, "rowSha256": hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest(),
                 "interfacePresent": None, "count": None, "names": []}
        self.html_actions.append(entry)
        try:
            interface = node.get_action_iface()
            entry["interfacePresent"] = bool(interface)
            return interface, entry
        except Exception as error:
            entry["error"] = {"stage": "interface", "type": type(error).__name__ if type(error).__name__ in
                              ("RuntimeError", "ValueError", "TypeError", "AttributeError", "OverflowError") else "other"}
            raise RuntimeError("Owned HTML action metadata unavailable") from None

    def html_action_operands(self, interface, entry):
        count = name = None
        stage = "count"
        try:
            if interface:
                count = interface.get_n_actions()
                if type(count) is int and -4096 <= count <= 4096:
                    entry["count"] = count
                else:
                    entry["countKind"] = "not-bounded-int"
                # Match the original guard's short circuit; never enumerate extra actions.
                if count == 1:
                    stage = "name-0"
                    name = interface.get_action_name(0)
                    observed = {"index": 0}
                    if type(name) is str and name in ("click", "press", "check", "uncheck", "activate", "jump", "select", ""):
                        observed["value"] = name
                    elif type(name) is str:
                        observed["characters"] = len(name)
                        if len(name) <= 4096:
                            observed["sha256"] = hashlib.sha256(name.encode("utf8", errors="surrogatepass")).hexdigest()
                    else:
                        observed["kind"] = "non-string"
                    entry["names"].append(observed)
            return count, name
        except Exception as error:
            entry["error"] = {"stage": stage, "type": type(error).__name__ if type(error).__name__ in
                              ("RuntimeError", "ValueError", "TypeError", "AttributeError", "OverflowError") else "other"}
            raise RuntimeError("Owned HTML action metadata unavailable") from None

    def click(self, source_id, actions):
        require(source_id not in actions, "No repeated UI action")
        require(windows(self.x11) == [self.window], "HTML action refused while another native window is present")
        row, node = self.source(source_id)
        require(row["enabled"] and row["sensitive"] and not row["busy"] and row["tag"] in ("button", "input", "summary"), "Source control unavailable")
        again, current = self.source(source_id)
        require(row == again, "Source control changed before input")
        action, observation = self.html_action_interface(current, again, source_id)
        names = ("check",) if source_id == "usage-terms-checkbox" else ("click", "press")
        count, name = self.html_action_operands(action, observation)
        require(action and count == 1 and name in names, "One reviewed source action required")
        self.recheck(full=True); actions.append(source_id)
        require(action.do_action(0), "UI action uncertain; no retry")

    def dialog_action(self, body, buttons, selected, actions):
        require(self.dialog and selected in buttons and not actions, "One native decision required")
        def capture():
            rows, nodes = self.snapshot()
            labels = [r.get("text", r["name"]) for r in rows if r["role"] == int(self.atspi.Role.LABEL)]
            require(labels.count(body) == 1, "Exact source-bound native consent body differs")
            controls = [(r, n) for r, n in zip(rows, nodes) if r["role"] == int(self.atspi.Role.PUSH_BUTTON)]
            require(len(controls) == len(buttons) and {r["name"] for r, n in controls} == set(buttons), "Exact native consent buttons required")
            for row, node in controls:
                require(row["showing"] and row["enabled"] and row["sensitive"] and not row["defunct"] and not row["busy"], "Native decision not ready")
                rect = node.get_component_iface().get_extents(self.atspi.CoordType.SCREEN)
                frame = self.x11.frame_rectangle(self.window)
                require(frame and rect.width > 0 and rect.height > 0 and rect.x >= frame[0] and rect.y >= frame[1]
                        and rect.x + rect.width <= frame[0] + frame[2] and rect.y + rect.height <= frame[1] + frame[3], "Native decision outside XRes frame")
            return rows, next(node for row, node in controls if row["name"] == selected)
        first, _ = capture(); second, button = capture()
        require(first == second, "Native consent changed before action")
        interface = button.get_action_iface()
        require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click", "One native decision click required")
        self.recheck(full=True); actions.append(selected)
        require(interface.do_action(0), "Native decision uncertain; no retry")

    def close(self):
        self.recheck(full=True)
        self.x11.close_window(self.window, self.helper.bound_window(self.request, self.x11))


def html_automation_environment(env):
    require(not any(key.startswith(("TAURI_", "WEBKIT_")) for key in env), "No inherited automation configuration")
    # Reserve no authority: the released reservation must subsequently be owned by the exact Root.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    require(type(port) is int and 1024 <= port <= 65535 and port not in (4444, 4445), "One private automation endpoint required")
    return {**env, "TAURI_WEBVIEW_AUTOMATION": "true", "WEBKIT_INSPECTOR_SERVER": "127.0.0.1:" + str(port)}, port


def bind_html_owner(surface, *, diagnostic=None):
    """Bind only the native container and WebKit root, never enumerate HTML descendants."""
    deadline = time.monotonic() + 30
    diagnostic = {} if diagnostic is None else diagnostic
    diagnostic.update(schemaVersion=1, attempts=0, notReadyCount=0, firstNotReady=None)

    def budget():
        if time.monotonic() >= deadline:
            diagnostic["outcome"] = "deadline"
            raise RuntimeError("Native WebView readiness deadline")

    def guard():
        budget(); surface.recheck(full=True); budget()
        require(windows(surface.x11) == [surface.window], "Only the bound Root frame may exist during WebView readiness")
        budget()

    def acquire():
        diagnostic.update(phase="before-ownership", walkComplete=False, nodes=[], outcome="reading")
        pending, seen, web_roots = [], set(), []
        try:
            guard()
            diagnostic["phase"] = "native-frame"
            frame = surface.native_frame()
            budget()
            if frame is None:
                diagnostic["phase"] = "after-frame-ownership"
                guard()
                diagnostic["phase"] = "frame-not-ready"
                return None
            diagnostic["phase"] = "frame-wire"
            frame_reference = surface.references.identity(frame, surface)
            require(surface.references.window in (None, frame_reference), "Native frame wire identity changed")
            surface.references.window = frame_reference
            pending = [(frame, 0)]
            while pending:
                budget()
                node, depth = pending.pop()
                diagnostic["phase"] = "node-bound"
                require(depth < 8 and len(seen) < 16, "Bounded native WebView ownership envelope required")
                row = {"depth": depth, "reference": None, "pid": None, "role": None, "childCount": None}
                diagnostic["nodes"].append(row)
                diagnostic["phase"] = "node-owner"
                node.clear_cache(); surface.node(node)
                reference = tuple(surface.references.identity(node, surface))
                row["reference"] = list(reference)
                require(reference not in seen, "Cyclic native WebView envelope")
                if depth:
                    diagnostic["phase"] = "node-parent"
                    parent = node.get_parent()
                    require(parent is not None and tuple(surface.references.identity(parent, surface)) in seen,
                            "Native WebView parent escaped bound frame")
                seen.add(reference)
                diagnostic["phase"] = "node-pid"
                pid = node.get_process_id()
                row["pid"] = pid if type(pid) is int and 0 < pid <= 2147483647 else None
                if pid != surface.pid:
                    require(surface.renderer is not None and node.get_process_id() == surface.renderer["pid"], "Unbound WebKit owner")
                    web_roots.append(reference)
                    continue
                diagnostic["phase"] = "node-toolkit"
                toolkit = node.get_toolkit_name()
                journal_token_metadata(row, "toolkit", toolkit, ("gtk",))
                role = None
                if toolkit == "gtk":
                    diagnostic["phase"] = "node-role"
                    role = int(node.get_role())
                    row["role"] = role if -2147483648 <= role <= 2147483647 else None
                require(toolkit == "gtk" and role in (20, 23), "Unknown native container before WebView")
                diagnostic["phase"] = "node-children"
                budget()
                children = surface.helper.fresh_close_children(node, 8)
                row["childCount"] = len(children)
                pending.extend((child, depth + 1) for child in reversed(children))
            diagnostic.update(phase="cardinality", walkComplete=True)
            require(len(web_roots) <= 1, "One bound WebKit root required")
            require(web_roots or surface.renderer is None, "WebKit root missing after a renderer was bound")
            diagnostic["phase"] = "final-ownership"
            guard()
            diagnostic["phase"] = "final-frame"
            frame.clear_cache()
            require(surface.references.identity(frame, surface) == frame_reference
                    and surface.references.window == frame_reference, "Native frame wire identity changed after read")
            budget()
            if not web_roots:
                diagnostic["phase"] = "web-root-not-ready"
                return None
            require(surface.renderer is not None, "One bound WebKit root required")
            diagnostic["phase"] = "bound"
            return {"frame": surface.references.window, "webRoot": list(web_roots[0]), "renderer": surface.renderer}
        finally:
            # Local facts only, including on refusal: never query AX or replace the first exception.
            diagnostic.update(webRootCount=len(web_roots), rendererBound=surface.renderer is not None,
                              visitedCount=len(seen), pendingCount=len(pending))

    while True:
        budget()
        diagnostic["attempts"] += 1
        result = acquire()
        budget()
        if result is not None:
            diagnostic["outcome"] = "bound"
            return result
        diagnostic["notReadyCount"] += 1
        diagnostic["outcome"] = "not-ready"
        if diagnostic["firstNotReady"] is None:
            diagnostic["firstNotReady"] = {key: diagnostic[key] for key in (
                "phase", "walkComplete", "nodes", "webRootCount", "rendererBound", "visitedCount", "pendingCount")}
        # Same existing readiness cadence, never a new or extended budget.
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))


class HtmlPages:
    """Standard WebDriver elements only; attach to the original Popen, never launch a replacement."""
    def __init__(self, surface, original, pages, driver_pin, port, env, evidence):
        self.surface, self.original, self.pages = surface, original, pages
        self.driver_pin, self.port, self.env, self.evidence = driver_pin, port, env, evidence
        self.child = self.logs = self.backend = self.driver_record = None
        self.detached, self.probed = False, False
        self.started = self.probe_started = self.detach_started = self.tools_stopping = self.input_unknown = False
        self.session_sent = self.detach_sent = False
        self.armed_element = None
        self.expected_modal = None
        self.d = pages.Driver()
        self.d.guard = self.guard
        self.transport = self.d.request
        self.d.request = self.request

    def request(self, method, route, payload=None, limit=131072):
        require(not self.detached, "Detached HTML adapter cannot send commands")
        if (method, route) == ("GET", "/status"):
            require(not self.session_sent and payload is None, "Status is only a pre-attachment read")
        elif (method, route) == ("POST", "/session"):
            require(not self.session_sent and not self.d.session and payload == {"capabilities": {"alwaysMatch": {
                "webkitgtk:browserOptions": {"targetAddress": "127.0.0.1:" + str(self.port)}, "unhandledPromptBehavior": "ignore"}}},
                "One target-only attachment capability body required")
            self.session_sent = True
        else:
            require(self.session_sent and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.d.session), "One established HTML session required")
            prefix = "/session/" + self.d.session
            require(route == prefix or route.startswith(prefix + "/"), "Foreign HTML session route refused")
            suffix = route[len(prefix):]
            if method == "GET":
                require(payload is None and (suffix in ("/window/handles", "/title", "/url") or re.fullmatch(
                    r"/element/[A-Za-z0-9_-]{1,128}/(?:text|name|displayed|enabled|attribute/(?:type|open|aria-busy|disabled|aria-pressed))", suffix)),
                    "Only fixed HTML metadata reads permitted")
            elif (method, suffix) == ("POST", "/elements"):
                require(type(payload) is dict and set(payload) == {"using", "value"} and payload["using"] == "css selector"
                        and type(payload["value"]) is str and 0 < len(payload["value"]) <= 512, "Bounded CSS-only element lookup required")
            elif method == "POST" and self.armed_element is not None and suffix == "/element/" + self.armed_element + "/click":
                require(self.probed and self.input_unknown and payload == {}, "One armed HTML input required")
                self.armed_element = None
            elif method == "DELETE" and not suffix:
                require(self.detach_started and not self.detach_sent and payload is None, "One explicit remote detach only")
                self.detach_sent = True
            else:
                raise RuntimeError("WebDriver route outside finite HTML adapter")
        return self.transport(method, route, payload, limit=limit)

    def endpoint_ready(self):
        require(self.original.pid == self.surface.pid and self.original.poll() is None, "Original owned Popen changed/exited")
        self.surface.recheck(full=True)
        current = windows(self.surface.x11)
        require(self.surface.window in current and len(current) <= (2 if self.expected_modal else 1), "Foreign/modal window before HTML operation")
        for window in current:
            if window == self.surface.window:
                continue
            require(self.expected_modal == "Update Creator Hub", "Unexpected HTML/native transition")
            request = self.surface.helper.Request("snapshot", self.surface.pid, self.surface.record["startTime"],
                self.surface.record["executable"], self.surface.record["kernelImageSha256"], window, self.expected_modal, "ALERT",
                gtk_message_info_frame=self.surface.x11.frame_rectangle(window))
            observed = self.surface.helper.bound_window(request, self.surface.x11)
            previous = self.evidence.get("expectedNativeModal")
            require(previous is None or observed == previous, "Expected native confirmation changed")
            self.evidence["expectedNativeModal"] = observed
        return self.pages.listener(self.surface.pid, self.port)

    def root_guard(self):
        require(self.endpoint_ready(), "Automation endpoint is not owned by the bound Root")

    def tool_guard(self):
        require(self.child is not None and self.child.poll() is None
                and kernel_record(self.child.pid, self.surface.native, self.surface.helper) == self.driver_record,
                "Owned WebDriver changed/exited")
        self.logs.pump()
        require(not any(row["truncated"] for row in self.logs.metadata().values()), "WebDriver log overflow")
        if self.backend is not None:
            require(kernel_record(self.backend["pid"], self.surface.native, self.surface.helper) == self.backend
                    and self.pages.listener(self.backend["pid"], 4445), "Owned WebKitWebDriver changed/exited")

    def guard(self):
        self.tool_guard(); self.root_guard()
        require(self.pages.listener(self.child.pid, 4444), "Owned intermediary listener changed")

    def start(self):
        require(not self.started, "One HTML attachment attempt only")
        self.started = True
        self.evidence.update(probeReadOnly=True, probePassed=False, inputAttempts=[], detached=False, nativeAcceptance=False, **FALSE)
        self.evidence["phase"] = "native-envelope"
        self.evidence["ownership"] = bind_html_owner(self.surface, diagnostic=self.evidence.setdefault("envelopeDiagnostic", {}))
        self.evidence["phase"] = "root-endpoint"
        wait(self.endpoint_ready)
        driver = BASE / "scripts/tauri-driver"
        bound(driver, self.driver_pin, 64 * 1024**2, uid=0, mode=0o755)
        native = self.pages.record("/usr/bin/WebKitWebDriver")
        require(native["uid"] == native["gid"] == 0 and native["mode"] == 0o755, "Protected WebKitWebDriver required")
        require(run_tool(["/usr/bin/dpkg", "--verify", "webkit2gtk-driver"]) == b"", "System WebKitWebDriver package differs")
        self.evidence["phase"] = "driver-launch"
        self.child = subprocess.Popen([str(driver), "--native-driver", "/usr/bin/WebKitWebDriver"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        self.logs = self.surface.native.Capture(self.child, BASE / "result", "html-driver")
        self.driver_record = kernel_record(self.child.pid, self.surface.native, self.surface.helper)
        require(self.driver_record["parentPid"] == os.getpid() and self.driver_record["uids"] == [UID] * 4
                and self.driver_record["kernelImageSha256"] == self.driver_pin["sha256"], "Intermediary image/parent/UID differs")
        def available():
            self.tool_guard(); self.root_guard()
            candidates = [row for row in self.pages.subtree(self.child.pid, self.surface.helper, self.surface.native).values()
                          if row["executable"] == "/usr/bin/WebKitWebDriver" and row["parentPid"] == self.child.pid]
            require(len(candidates) <= 1 and (self.backend is None or len(candidates) == 1), "Native driver missing or duplicated")
            if not candidates:
                return False
            current = kernel_record(candidates[0]["pid"], self.surface.native, self.surface.helper)
            require(current["uids"] == [UID] * 4 and current["kernelImageSha256"] == native["sha256"]
                    and (self.backend is None or current == self.backend), "Native driver image/identity differs")
            self.backend = current
            return self.pages.listener(self.child.pid, 4444) and self.pages.listener(current["pid"], 4445)
        wait(available)
        self.evidence["phase"] = "driver-status"
        wait(lambda: self.d.request("GET", "/status")["ready"] is True)
        # WebKit's targetAddress branch connects instead of calling spawnv. No tauri:options/binary fallback.
        self.evidence["phase"] = "attach-session"
        result = self.d.request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "webkitgtk:browserOptions": {"targetAddress": "127.0.0.1:" + str(self.port)}, "unhandledPromptBehavior": "ignore"}}})
        self.d.session = result["sessionId"]
        require(type(self.d.session) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.d.session), "Bounded WebDriver session required")
        self.probe()

    def probe(self):
        require(not self.probe_started and not self.evidence["inputAttempts"], "One no-input compatibility probe required")
        self.probe_started = True; self.evidence["phase"] = "probe-document"
        self.guard()
        handles = self.d.call("GET", "/window/handles")
        require(type(handles) is list and len(handles) == 1 and type(handles[0]) is str
                and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", handles[0]), "One original product document required")
        require(self.d.call("GET", "/title") == "Creator Hub" and self.d.call("GET", "/url") in ("tauri://localhost", "tauri://localhost/"),
                "Attached document identity/origin differs")
        self.evidence["phase"] = "probe-readiness"
        wait(lambda: self.optional("#platform-status") == "Linux")
        wait(lambda: self.optional(".footer-version") == "0.1.16")
        require(self.d.read("#page-title") == "CREATOR HUB" and not self.d.elements("iframe,object,embed"), "Original native document required")
        self.guard(); phase_processes(self.surface)
        self.probed = True
        self.evidence.update(probePassed=True, inputCountAtProbe=0, originalRoot=self.surface.record,
                             driver=self.driver_record, nativeDriver=self.backend, endpointPort=self.port, phase="probe-complete")

    def optional(self, selector, endpoint="text"):
        rows = self.d.elements(selector)
        require(len(rows) <= 1, "Ambiguous fixed HTML control")
        return self.d.call("GET", "/element/" + rows[0] + "/" + endpoint) if rows else None

    def click(self, selector, actions, label):
        require(self.probed and not self.detached and not self.input_unknown, "HTML input unqualified/unknown; no retry")
        controls = {"usage-terms-checkbox": "#usage-terms-checkbox", "usage-terms-continue": "#usage-terms-continue",
                    "convergence-later": "#convergence-later", "suite-trigger": "#suite-trigger",
                    "view-mcp": '#suite-menu [data-view="mcp"]', "view-setup": '#suite-menu [data-view="setup"]',
                    "view-home": '#suite-menu [data-view="hub"]', "hub-update-button": "#hub-update-button"}
        require(controls.get(label) == selector, "Only finite source-bound HTML actions permitted")
        element = self.d.element(selector)
        prefix = "/element/" + element + "/"
        require(self.d.call("GET", prefix + "name") == ("input" if label == "usage-terms-checkbox" else "button")
                and self.d.call("GET", prefix + "displayed") is True
                and self.d.call("GET", prefix + "enabled") is True, "HTML control not actionable/source-bound")
        if label == "usage-terms-checkbox":
            require(self.d.call("GET", prefix + "attribute/type") == "checkbox", "Actual terms checkbox required")
        require(self.d.element(selector) == element, "HTML target changed before input")
        self.guard()
        actions.append(label); self.evidence["inputAttempts"].append(label)
        self.evidence.update(phase="html-input", control=label)
        self.input_unknown = True
        self.armed_element = element
        if label == "hub-update-button":
            self.expected_modal = "Update Creator Hub"
        self.d.call("POST", "/element/" + element + "/click", {})
        self.input_unknown = False
        self.evidence["phase"] = "html-input-returned"

    def startup(self, home, report):
        def phase(name): report["startupPhase"] = name
        actions = report["startupUi"]
        phase("wait-usage-terms")
        wait(lambda: self.optional("#usage-terms-dialog", "attribute/open") is not None)
        phase("usage-terms-checkbox"); self.click("#usage-terms-checkbox", actions, "usage-terms-checkbox")
        phase("usage-terms-continue"); self.click("#usage-terms-continue", actions, "usage-terms-continue")
        phase("wait-usage-terms-dismissed"); wait(lambda: self.optional("#usage-terms-dialog", "attribute/open") is None)
        phase("wait-convergence-offer"); wait(lambda: self.optional("#convergence-dialog", "attribute/open") is not None)
        wait(lambda: self.optional("#convergence-dialog", "attribute/aria-busy") == "false")
        require(self.d.read("#convergence-later") == "Not now", "Unexpected migration/recovery action")
        phase("convergence-later"); self.click("#convergence-later", actions, "convergence-later")
        phase("wait-convergence-dismissed"); wait(lambda: self.optional("#convergence-dialog", "attribute/open") is None)
        phase("wait-projects-ready")
        wait(lambda: self.optional("#view-projects", "attribute/aria-busy") == "false")
        require(self.d.read("#projects-home-title") == "Projects", "Direct Projects home required")
        for label in ("Open selected-project", "Open other-project"):
            selector = '#project-list button[aria-label="' + label + '"]'
            require(self.d.read(selector, "displayed") is True and self.d.read(selector, "enabled") is True, "Fixture project action unavailable")
        require(self.d.read("#refresh-projects", "enabled") is True and parse(read(home / PREFS))["autoDownload"] is False,
                "Projects readiness/preferences differ")
        phase("complete")

    def direct_pages(self, actions):
        phase_processes(self.surface)
        for feature, heading in (("mcp", "Creator Works MCP"), ("setup", "Project Setup")):
            self.click("#suite-trigger", [], "suite-trigger")
            selector = '#suite-menu [data-view="' + feature + '"]'
            self.click(selector, actions, "view-" + feature)
            prefix = "#feature-" + feature
            wait(lambda: self.optional(prefix, "displayed") is True and self.optional(prefix, "attribute/aria-busy") == "false", 60)
            require(self.d.read(prefix + " h2") == heading and self.d.read(prefix + ' [data-field="status"]') == "Ready"
                    and not self.d.read(prefix + ' [data-field="error"]')
                    and self.d.read(prefix + ' [data-field="controls"]', "attribute/disabled") is None, "Direct feature not Ready")
            require(not self.d.elements("iframe,object,embed") and len(self.d.call("GET", "/window/handles")) == 1, "Separate feature document refused")
            if feature == "mcp":
                selected = prefix + ' .feature-project[data-selected="true"] .feature-project-select'
                other = prefix + ' .feature-project[data-selected="false"] .feature-project-select'
                require(self.d.read(selected, "attribute/aria-pressed") == "true"
                        and self.d.read(other, "attribute/aria-pressed") == "false"
                        and self.d.read(selected + " .feature-project-info strong") == "Selected update project"
                        and self.d.read(other + " .feature-project-info strong") == "Other update project", "Selected MCP project did not survive")
            phase_processes(self.surface)

    def home(self):
        self.click("#suite-trigger", [], "suite-trigger")
        self.click('#suite-menu [data-view="hub"]', [], "view-home")
        wait(lambda: self.optional("#view-projects", "attribute/aria-busy") == "false")
        require(self.d.read("#projects-home-title") == "Projects", "Projects home missing")

    def detach(self):
        require(self.probed and not self.detach_started and not self.input_unknown, "One qualified attachment release only")
        self.detach_started = True; self.evidence["phase"] = "detach"
        self.d.call("DELETE", "")
        self.guard()
        self.detached = True; self.evidence["detached"] = True

    def finish_tools(self):
        require(self.detached and not self.tools_stopping and self.original.poll() == 0, "Tool teardown requires independently observed normal Root exit")
        self.tool_guard()
        self.tools_stopping = True
        self.child.terminate(); self.child.wait(timeout=10)
        self.retain_logs(); self.logs.close(); self.logs = None
        self.evidence["toolsClosedAfterRootExit"] = True

    def retain_logs(self):
        self.logs.pump()
        metadata = self.logs.metadata()
        self.evidence["logs"] = metadata
        require(set(metadata) == {"stdout", "stderr"}, "Only owned WebDriver logs permitted")
        for name, row in metadata.items():
            raw = read(BASE / "result" / ("html-driver." + name), self.surface.native.MAX_LOG, uid=UID)
            row["file"] = pin(raw)
            require(len(raw) == row["retainedBytes"] and row["truncated"] is False, "WebDriver log incomplete/overflowed")


def field_text(surface, source_id):
    row, _ = surface.source(source_id)
    return row.get("text") or row["name"]


def direct_pages(surface, actions):
    surface.call_phase = "direct-pages"
    phase_processes(surface)
    wait(lambda: surface.source("projects-home-title", optional=True))
    require(field_text(surface, "projects-home-title") == "Projects", "Direct Projects page missing")
    rows, _ = surface.snapshot()
    buttons = [r["name"] for r in rows if r["showing"] and r["role"] == int(surface.atspi.Role.PUSH_BUTTON) and r["name"].startswith("Open ")]
    require(buttons.count("Open selected-project") == buttons.count("Open other-project") == 1, "Unique selected/other Home projects not observed")
    require(not any(r["tag"] in ("iframe", "object", "embed") for r in rows), "Separate component document refused")
    # The bound integrated Root exposes its badge, description and status in the AX name.
    for feature, label in (("mcp", "M Creator Works MCP AI tools for Unity Included in Hub"),
                           ("setup", "P Project Setup Unity + Creator SDK projects Included in Hub")):
        surface.click("suite-trigger", [])
        rows, nodes = surface.snapshot()
        candidates = [(row, node) for row, node in zip(rows, nodes) if row["role"] == int(surface.atspi.Role.PUSH_BUTTON)
                      and row["tag"] == "button" and row["toolkit"] == "WebKitGTK"
                      and row["showing"] and row["enabled"] and row["sensitive"] and not row["busy"] and not row["defunct"]
                      and row["name"] == label]
        require(len(candidates) == 1, "One exact first-party navigation button required")
        row, node = candidates[0]; ref = row["reference"]
        current, current_nodes = surface.snapshot()
        matches = [n for r, n in zip(current, current_nodes) if r == row and r["reference"] == ref]
        require(len(matches) == 1, "Navigation changed before input")
        interface, observation = surface.html_action_interface(matches[0], row, "navigation-" + feature); surface.recheck(full=True)
        count, name = surface.html_action_operands(interface, observation)
        require(interface and count == 1 and name == "press", "Navigation action differs")
        actions.append("view-" + feature); require(interface.do_action(0), "Navigation uncertain; no retry")
        rows = wait(lambda: feature_ready(surface, feature), 60)
        if feature == "mcp":
            selected = [r for r in rows if r["showing"] and r["name"] == "Select Selected update project for MCP" and r["role"] == int(surface.atspi.Role.PUSH_BUTTON)]
            other = [r for r in rows if r["showing"] and r["name"] == "Select Other update project for MCP" and r["role"] == int(surface.atspi.Role.PUSH_BUTTON)]
            require(len(selected) == len(other) == 1 and selected[0]["pressed"] is True and other[0]["pressed"] is False, "Actual selected MCP project did not survive")
        require(not any(r["tag"] in ("iframe", "object", "embed") for r in rows), "Private component WebView refused")
    return True


def phase_processes(surface):
    surface.recheck(full=True)
    require(surface.inventory is not None, "Fresh root inventory channel required")
    answer = surface.inventory.sample(wait)
    surface.recheck(full=True)
    roots = []
    for value in answer["processes"]:
        name = Path(value["executable"]).name
        require(name not in ("creator-works-mcp-launcher", "creator-project-setup", "creator-mcp-launcher"), "Legacy GUI/backend subprocess refused")
        if name == "creator-hub":
            if value["pid"] == surface.pid:
                require(value["startTime"] == surface.record["startTime"] and value["executable"] == surface.record["executable"],
                        "Root inventory identity differs from the bound live image")
            roots.append(value["pid"])
    require(roots == [surface.pid], "Exactly the bound Root process required, no hidden/duplicate Root")
    surface.last_inventory = answer


def phase_bitmap(surface, name):
    surface.recheck(full=True)
    folder = BASE / "result" / name; folder.mkdir(mode=0o700)
    result = surface.native.bitmap(surface.request, folder, surface.helper, surface.x11)
    surface.recheck(full=True)
    require(result["nonblank"] is True and result["windowOnly"] is True, "Exact owned phase pixels required")
    return result


def feature_ready(surface, feature):
    require(feature in ("mcp", "setup"), "Finite direct feature")
    rows, _ = surface.snapshot()
    title = "Creator Works MCP" if feature == "mcp" else "Project Setup"
    headings = [r for r in rows if r["showing"] and r["tag"] == "h2" and r["name"] == title and r["toolkit"] == "WebKitGTK"]
    require(len(headings) <= 1, "Duplicate direct feature heading")
    if not headings:
        return None
    groups = [r for r in rows if r["showing"] and r["tag"] == "fieldset" and r["name"] == ("MCP controls" if feature == "mcp" else "Project Setup controls")]
    require(len(groups) <= 1, "Duplicate direct control group")
    if not groups or not groups[0]["enabled"] or not groups[0]["sensitive"]:
        return None
    ready = any(r["showing"] and (r["name"] == "Ready" or r.get("text") == "Ready") for r in rows)
    return rows if ready else None


def pending_proof(root, native, helper, polkit, baseline):
    """Root-only, read-only attribution of the actual sealed private017 stdin."""
    require(os.getuid() == os.geteuid() == 0, "Setuid observer requires the fixed root broker")
    require(root["uids"] == [UID] * 4 and root["executable"] == "/usr/bin/creator-hub"
            and root["kernelImageSha256"] == baseline["hub"]["sha256"]
            and kernel_record(root["pid"], native, helper) == root, "Original production016 Root identity changed")
    supervisor = kernel_record(root["parentPid"], native, helper)
    require(supervisor["uids"] == [UID] * 4 and supervisor["executable"] == "/usr/bin/python3.10", "Root must descend from the exact system Python session")
    command = Path(f"/proc/{supervisor['pid']}/cmdline").read_bytes()
    require(command == b"/usr/bin/python3\0-B\0/opt/creator-polkit-fixture/scripts/native-linux-production-016-update.py\0session\0", "Fixed reviewed session ancestry required")
    matches = []
    import fcntl
    for pid in children(root["pid"]):
        try:
            with Path(f"/proc/{pid}/cmdline").open("rb") as stream:
                raw = stream.read(8193)
        except (FileNotFoundError, ProcessLookupError):
            continue
        require(len(raw) <= 8192, "Bounded pending command")
        if raw.split(b"\0", 1)[0] != b"/usr/bin/pkexec":
            continue
        pending_command(raw)
        process = kernel_record(pid, native, helper)
        require(process["parentPid"] == root["pid"] and process["uids"] == [UID, 0, 0, 0]
                and process["executable"] == "/usr/bin/pkexec" and process["kernelImageSha256"] == polkit.FILES["/usr/bin/pkexec"][3], "Different setuid image/parent/UID")
        fd = os.open(f"/proc/{pid}/fd/0", os.O_RDONLY | os.O_CLOEXEC)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_size == FIXED["17"]["deb"]["size"]
                    and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == 15, "Exact fully sealed private017 package stdin required")
            offset, digest = 0, hashlib.sha256()
            while offset < before.st_size:
                part = os.pread(fd, min(65536, before.st_size - offset), offset)
                require(part, "Truncated sealed package"); offset += len(part); digest.update(part)
            require(digest.hexdigest() == FIXED["17"]["deb"]["sha256"] and stamp(os.fstat(fd)) == stamp(before)
                    and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == 15 and kernel_record(pid, native, helper) == process
                    and kernel_record(root["pid"], native, helper) == root, "Pending sealed package/process changed")
            matches.append({"root": root, "pkexec": process, "package": FIXED["17"]["deb"], "seals": 15, "readOnly": True})
        finally:
            os.close(fd)
    require(len(matches) == 1, "One exact pending Root -> pkexec -> sealed017 request required")
    return matches[0]


def verify_installed(review, version):
    state = run_tool(["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n", "creator-hub"])
    require(state == ("creator-hub\t0.1." + version + "\tamd64\tinstalled\n").encode(), "Actual installed package state differs")
    require(run_tool(["/usr/bin/dpkg", "--verify", "creator-hub"]) == b"", "Installed package verification differs")
    for name, expected in review["deb" + version].items():
        file = Path("/") / name
        info = file.lstat()
        require(file.resolve(strict=True) == file and info.st_uid == info.st_gid == 0, "Installed package path/owner differs")
        if expected["kind"] == "file":
            bound(file, {k: expected[k] for k in ("size", "sha256")}, mode=expected["mode"], uid=0)
        else:
            require(stat.S_ISDIR(info.st_mode), "Installed package directory became a file")
    return {"version": "0.1." + version, "hub": review["baseline"]["hub"] if version == "16" else FIXED["17"]["hub"], "dpkgVerified": True}


def portable_state(home, review, version, *, previous=None):
    package = review["portable"][version]
    store = home / STORE
    selection(parse(read(store / "current.json", 32768, uid=UID, mode=0o600)), package["generation"], previous)
    for pending in ("pending.json", "activation-v1/pending.json", "restart-v1/pending.json"):
        require(not os.path.lexists(store / pending), "Retained portable operation requires review, never auto retry")
    appdir = store / "generations" / package["generation"] / "AppDir"
    for name, entry in package["manifest"]["entries"].items():
        file = appdir / name; info = file.lstat()
        require(file.resolve(strict=True) == file and info.st_uid == UID and not info.st_mode & 0o222
                and (stat.S_ISDIR(info.st_mode) if entry["kind"] == "directory" else stat.S_ISREG(info.st_mode)), "Signed immutable generation changed")
        if entry["kind"] == "file":
            bound(file, {k: entry[k] for k in ("size", "sha256")}, uid=UID, mode=entry["mode"] & ~0o222)
    actual = {p.relative_to(appdir).as_posix() for p in appdir.rglob("*")}
    require(actual == set(package["manifest"]["entries"]), "Unknown file in selected generation")
    selector = store / "activation-v1/creator-hub-portable-selector"
    bound(selector, {k: review["portable"]["16"]["manifest"]["entries"][SELECTOR_ENTRY][k] for k in ("size", "sha256")}, uid=UID, mode=0o555)
    expected_service = f"[D-BUS Service]\nName=com.creatorworks.hub.Host\nExec={selector} activate\n".encode()
    require(read(home / HOST_SERVICE, 4096, uid=UID, mode=0o644) == expected_service, "Stable registered selector/service changed")
    return appdir


def question(portable):
    notice = "\n\nYour open Hub tool page will reopen. Unsaved form entries will be discarded."
    if portable:
        return ("Update portable Creator Hub from 0.1.16 to 0.1.17?\n\nThe signed download has been verified. Hub will close normally; its registered helper will then select and open the new generation. "
                "Your old generations, settings, projects and MCP connections will stay in place. Cancelling keeps the current selection unchanged." + notice)
    return ("Update Creator Hub to 0.1.17?\n\nHub will close and reopen. Your projects, apps and settings will stay in place."
            "\n\nHub will close these idle views: Creator Project Setup. Unsaved form entries will be discarded. "
            "They will reopen after Hub restarts. The apps may ask for permission when reopening. "
            "Standalone apps and MCP connections will stay open.")


def recheck_endpoint(system, polkit, glib, endpoint, session_identity, pids):
    require(polkit.bus_identity(system, endpoint["owner"], glib) == {k: endpoint[k] for k in ("owner", "pid", "uid")}
            and polkit.bus_identity(system, "org.freedesktop.PolicyKit1", glib) == endpoint["authority"], "Bound authentication agent/authority changed")
    require(all(polkit.session(system, pid, glib) == session_identity for pid in pids), "Original logind session changed")


def authorize(surface, agent, agent_record, parent, endpoint, system, glib, atspi, polkit, flow, helper, native, secret, evidence):
    require(not evidence["systemActions"], "At most one authorization action")
    captured = wait(lambda: polkit.windows(agent.pid, helper, surface.x11), 30)
    require(len(captured) == 1, "One owned system authentication window required")
    session_identity = polkit.session(system, parent["pid"], glib)
    refs, bus = native.native_ax_references()
    geometry, record, counter = {}, {"mode": "authenticate" if secret is not None else "cancel"}, 0
    def guard():
        nonlocal counter
        surface.recheck(full=True)
        require(set(windows(surface.x11)) == {surface.window, captured[0]["window"]}, "Only exact Root/authentication window pair allowed at input")
        polkit.own_agent(agent, agent_record, parent, helper)
        recheck_endpoint(system, polkit, glib, endpoint, session_identity, (parent["pid"], agent.pid, surface.pid))
        counter += 1; require(counter <= 12, "Bounded read-only input proof sequence")
        save(BASE / "result" / f"input-{counter}.json", {"index": counter})
        answer_file = BASE / f"input-{counter}.json"
        wait(answer_file.exists)
        answer = parse(read(answer_file, 32768, uid=0, mode=0o644))
        require(answer["index"] == counter and answer["proof"]["root"] == surface.record and answer["proof"]["package"] == FIXED["17"]["deb"], "Fresh kernel sealed-package input proof refused")
        polkit.own_agent(agent, agent_record, parent, helper)
        recheck_endpoint(system, polkit, glib, endpoint, session_identity, (parent["pid"], agent.pid, surface.pid))
        record["lastKernelProof"] = answer["proof"]
    def profile():
        return flow.dpkg_profile(agent_record, helper, atspi, refs, surface.x11, captured, geometry, polkit, authenticate=secret is not None)
    try:
        if secret is None:
            polkit.cancel_once(profile, guard, record)
            evidence["systemActions"].append("Cancel")
        else:
            polkit.authenticate_once(profile, guard, record, secret)
            evidence["systemActions"].append("Authenticate")
        evidence["sealed17Observed"] = True
        wait(lambda: polkit.native_window_absence(surface.x11, helper, captured[0]["window"], {})["absent"])
    finally:
        evidence["systemInput"] = record
        bus.close_sync(None)


def journal_token_metadata(target, field, value, public=()):
    if type(value) is str:
        if value in public:
            target[field] = value
        elif len(value) <= 4096:
            target[field + "Sha256"] = hashlib.sha256(value.encode("utf8", errors="surrogatepass")).hexdigest()
        else:
            target[field + "Characters"] = len(value)
    else:
        target[field + "Kind"] = "non-string"


def journal(home, previous=None, *, diagnostics=None):
    file = home / "config/creator-works-mcp/hosted-operation-outcomes.json"
    info = file.lstat()
    observation = {"uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode),
                   "recordCount": None, "prefixCount": 0 if previous is None else len(previous["records"]),
                   "appendCount": None, "records": []}
    if diagnostics is not None and len(diagnostics) < 4:
        diagnostics.append(observation)
    require(info.st_uid == info.st_gid == UID and stat.S_IMODE(info.st_mode) == 0o644, "Read journal ownership/mode differs")
    value = parse(read(file, 65536, uid=UID, mode=0o644))
    # Retain only bounded metadata already read; admission below remains unchanged.
    records = value.get("records") if type(value) is dict else None
    if type(records) is list:
        observation["recordCount"] = len(records)
        observation["appendCount"] = len(records) - observation["prefixCount"]
        observation["omittedRecords"] = max(0, len(records) - 16)
        for row in records[:16]:
            if type(row) is not dict:
                observation["records"].append({"kind": "non-object"})
                continue
            metadata = {"id": row.get("id") if type(row.get("id")) is int and abs(row["id"]) <= 9007199254740991 else None}
            journal_token_metadata(metadata, "command", row.get("command"), ("load_config", "discover_unity_projects"))
            journal_token_metadata(metadata, "outcome", row.get("outcome"), ("returned-ok",))
            journal_token_metadata(metadata, "session", row.get("session"))
            observation["records"].append(metadata)
    keys(value, ("revision", "records"))
    require(value["revision"] == 1 and type(value["records"]) is list and len(value["records"]) <= 16, "Bounded exact read journal schema")
    prefix = [] if previous is None else previous["records"]
    require(value["records"][:len(prefix)] == prefix, "Prior read outcomes changed")
    rows = value["records"][len(prefix):]
    require(len(rows) == 2, "Exactly one native page read pair per session required")
    nonce = None
    for row, command, request_id in zip(rows, ("load_config", "discover_unity_projects"), (3, 4)):
        keys(row, ("session", "id", "command", "outcome"))
        require(row["command"] == command and type(row["id"]) is int and row["id"] == request_id and row["outcome"] == "returned-ok"
                and re.fullmatch(r"[a-f0-9]{64}", row["session"]), "Only exact successful page reads admitted")
        nonce = row["session"] if nonce is None else nonce
        require(row["session"] == nonce and all(old["session"] != nonce for old in prefix), "Fresh single-session read nonce required")
    return value


def navigate_home(surface):
    surface.call_phase = "navigate-home"
    surface.click("suite-trigger", [])
    rows, nodes = surface.snapshot()
    choices = [(r, n) for r, n in zip(rows, nodes) if r["showing"] and r["role"] == int(surface.atspi.Role.PUSH_BUTTON)
               and r["tag"] == "button" and r["toolkit"] == "WebKitGTK"
               and r["enabled"] and r["sensitive"] and not r["busy"] and not r["defunct"]
               and r["name"] == "H Creator Hub Projects"]
    require(len(choices) == 1, "One exact Home navigation control required")
    row, _ = choices[0]; ref = row["reference"]
    current, current_nodes = surface.snapshot()
    matches = [node for value, node in zip(current, current_nodes) if value == row and value["reference"] == ref]
    require(len(matches) == 1, "Home navigation changed")
    action, observation = surface.html_action_interface(matches[0], row, "navigation-home"); surface.recheck(full=True)
    count, name = surface.html_action_operands(action, observation)
    require(action and count == 1 and name == "press", "Home action differs")
    require(action.do_action(0), "Home action uncertain; no retry")
    wait(lambda: surface.source("projects-home-title", optional=True))


def startup_ui(surface, home, *, first, actions=None, progress=None):
    actions = [] if actions is None else actions
    def phase(value):
        surface.call_phase = "startup-ui:" + value
        if progress is not None:
            progress["startupPhase"] = value
    if first:
        phase("wait-usage-terms")
        wait(lambda: surface.source("usage-terms-checkbox", optional=True))
        phase("usage-terms-checkbox")
        surface.click("usage-terms-checkbox", actions)
        phase("usage-terms-continue")
        surface.click("usage-terms-continue", actions)
        phase("wait-usage-terms-dismissed")
        wait(lambda: surface.source("usage-terms-continue", optional=True) is None)
    else:
        phase("review-existing-terms")
        require(surface.source("usage-terms-continue", optional=True) is None, "Accepted native terms unexpectedly repeated")
    phase("wait-convergence-offer")
    later = wait(lambda: surface.source("convergence-later", optional=True))
    phase("review-convergence-label")
    require(later[0]["name"] == "Not now", "Unexpected migration/recovery UI in updater lane")
    phase("convergence-later")
    surface.click("convergence-later", actions)
    phase("wait-convergence-dismissed")
    wait(lambda: surface.source("convergence-dialog", optional=True) is None)
    phase("wait-projects-home")
    wait(lambda: surface.source("projects-home-title", optional=True))
    def projects_ready():
        rows, _ = surface.snapshot()
        for name in ("Open selected-project", "Open other-project"):
            matches = [row for row in rows if row["name"] == name]
            require(len(matches) <= 1, "Duplicate fixture project Open control")
            if not matches:
                return False
            row = matches[0]
            require(row["role"] == int(surface.atspi.Role.PUSH_BUTTON) and row["tag"] == "button"
                    and row["toolkit"] == "WebKitGTK", "Fixture project Open control differs")
            if not all(row[key] for key in ("showing", "enabled", "sensitive")) or row["busy"] or row["defunct"]:
                return False
        refresh = surface.source("refresh-projects", optional=True)
        return bool(refresh and refresh[0]["enabled"] and refresh[0]["sensitive"] and not refresh[0]["busy"])
    phase("wait-projects-ready")
    wait(projects_ready)
    phase("check-preferences")
    require(parse(read(home / PREFS))["autoDownload"] is False, "Automatic download must remain disabled")
    phase("complete")
    return actions


def verify_bus(record, bus, polkit, glib, *, portable, previous=None):
    name = "com.creatorworks.hub.Host" if portable else "com.creatorworks.hub.SingleInstance"
    def ready():
        present = polkit.dbus_call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", "(s)", (name,), "(b)", glib)[0]
        if not present:
            return None
        result = polkit.bus_identity(bus, name, glib)
        require(result["pid"] == record["pid"] and result["uid"] == UID and (previous is None or result["owner"] != previous["owner"]), "Fresh owned Root bus connection required")
        return result
    return wait(ready)


def observe_successor(old, expected, executable, parent, baseline, native, helper, *, old_child=None):
    """Kernel observation only. No spawn, signals, broad reaping or replacement UI."""
    observed = {}
    def ready():
        if old_child is not None:
            if old_child.poll() is None:
                return None
            require(old_child.returncode == 0, "Old Root did not exit normally")
        elif Path(f"/proc/{old['pid']}").exists():
            return None
        matches = []
        for pid in children(parent) - set(baseline) - {old["pid"]}:
            try:
                value = kernel_record(pid, native, helper)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except RuntimeError as error:
                # A stable zombie is rejected, never counted/adopted/reaped.
                with Path(f"/proc/{pid}/stat").open("rb") as stream:
                    raw = stream.read(4097)
                fields = raw[raw.rfind(b")") + 2:].split()
                if len(raw) <= 4096 and len(fields) >= 20 and fields[0] == b"Z" and fields[1] == str(parent).encode():
                    observed[pid] = "rejected-nonlive-not-reaped"; continue
                raise error
            if value["executable"] != executable:
                continue
            matches.append(phase_identity(value, expected, executable, parent, UID, previous=old, baseline=baseline))
        require(len(matches) <= 1, "Multiple fresh successor candidates")
        return matches[0] if matches else None
    return wait(ready, 60), observed


def portable_ancestry_metadata():
    require(BASE == Path("/opt/creator-polkit-fixture"), "Fixed diagnostic fixture required")
    names = ("/", "/opt", BASE.as_posix(), (BASE / "result").as_posix(), (BASE / "result/home").as_posix(), (BASE / "result/home/data").as_posix(),
             (BASE / "result/home/data/CreatorHub").as_posix(), (BASE / "result/home/data/CreatorHub/hub-portable-updates").as_posix(),
             (BASE / "result/home/data/creator-hub-portable").as_posix(),
             (BASE / "result/home/data/creator-hub-update-cache").as_posix(),
             (BASE / "result/home/data/creator-hub-update-cache/portable").as_posix(),
             (BASE / "result/home/data/creator-hub-update-cache/portable/records").as_posix(),
             (BASE / "result/home/data/creator-hub-update-cache/deb").as_posix(),
             (BASE / "result/home/data/creator-hub-update-cache/deb/records").as_posix())
    handles, observed, entries = {}, {}, []
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        for name in names:
            parent, leaf = os.path.split(name)
            if name != "/" and parent not in handles:
                entries.append({"path": name, "unavailable": "AncestorNotDirectory"}); continue
            try:
                info = os.stat(name, follow_symlinks=False) if name == "/" else os.stat(leaf, dir_fd=handles[parent], follow_symlinks=False)
            except FileNotFoundError:
                entries.append({"path": name, "present": False}); continue
            observed[name] = info
            entries.append({"path": name, "present": True, "directory": stat.S_ISDIR(info.st_mode),
                            "uid": info.st_uid, "gid": info.st_gid, "mode": format(stat.S_IMODE(info.st_mode), "04o"),
                            "dev": info.st_dev, "ino": info.st_ino})
            if stat.S_ISDIR(info.st_mode):
                fd = os.open(name, flags) if name == "/" else os.open(leaf, flags, dir_fd=handles[parent])
                handles[name] = fd
                require(stamp(os.fstat(fd)) == stamp(info), "Diagnostic directory changed during open")
        for name, before in observed.items():
            parent, leaf = os.path.split(name)
            now = os.stat(name, follow_symlinks=False) if name == "/" else os.stat(leaf, dir_fd=handles[parent], follow_symlinks=False)
            require(stamp(now) == stamp(before) and (name not in handles or stamp(os.fstat(handles[name])) == stamp(before)),
                    "Diagnostic directory identity changed")
        return entries
    finally:
        for fd in reversed(tuple(handles.values())):
            os.close(fd)


def owned_process_umask(process, native, helper):
    require(type(process["pid"]) is int and process["pid"] > 1 and process["uids"] == [UID] * 4
            and kernel_record(process["pid"], native, helper) == process, "Owned diagnostic process identity required")
    path = Path(f'/proc/{process["pid"]}/status')
    before = path.lstat(); require(stat.S_ISREG(before.st_mode), "Bounded process status required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        require(stamp(os.fstat(fd)) == stamp(before), "Diagnostic status changed during open")
        raw = bytearray()
        while len(raw) <= 16384:
            part = os.read(fd, 16385 - len(raw))
            if not part:
                break
            raw.extend(part)
        require(len(raw) <= 16384 and stamp(os.fstat(fd)) == stamp(before)
                and stamp(path.lstat()) == stamp(before), "Diagnostic process status changed or oversized")
    finally:
        os.close(fd)
    values = re.findall(rb"^Umask:[ \t]+([0-7]{4})$", raw, re.M)
    require(len(values) == 1 and kernel_record(process["pid"], native, helper) == process, "Owned process umask unavailable or changed")
    return {"pid": process["pid"], "startTime": process["startTime"], "umask": values[0].decode("ascii")}


def owned_journal_directory_acl(home):
    require(home == BASE / "result/home" and home.resolve(strict=True) == home, "Exact synthetic journal home required")
    paths = (home, home / "config", home / "config/creator-works-mcp")
    handles, observed = [], []
    try:
        for index, path in enumerate(paths):
            before = path.lstat() if index == 0 else os.stat(path.name, dir_fd=handles[-1], follow_symlinks=False)
            require(stat.S_ISDIR(before.st_mode) and before.st_uid == before.st_gid == UID, "Owned journal ancestry required")
            fd = os.open(path if index == 0 else path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         **({} if index == 0 else {"dir_fd": handles[-1]}))
            handles.append(fd); observed.append(before)
            require(stamp(os.fstat(fd)) == stamp(before), "Journal ancestry changed during open")
        try:
            raw = os.getxattr(handles[-1], "system.posix_acl_default")
        except OSError as error:
            if error.errno != errno.ENODATA:
                raise
            acl = {"present": False}
        else:
            require(type(raw) is bytes and 0 < len(raw) <= 65536, "Bounded default ACL required")
            acl = {"present": True, **pin(raw)}
        for index, path in enumerate(paths):
            named = path.lstat() if index == 0 else os.stat(path.name, dir_fd=handles[index - 1], follow_symlinks=False)
            require(stamp(named) == stamp(observed[index]) and stamp(os.fstat(handles[index])) == stamp(observed[index]),
                    "Journal ancestry changed during ACL observation")
        info = observed[-1]
        return {"directory": "config/creator-works-mcp", "uid": info.st_uid, "gid": info.st_gid,
                "mode": stat.S_IMODE(info.st_mode), "defaultAcl": acl}
    finally:
        for fd in reversed(handles):
            os.close(fd)


def capture_initial_creation_context(phase, home, process, report, native, helper):
    entry = {"phase": phase, "readOnly": True, "complete": False, "intendedChildUmask": "0022"}
    try:
        require(phase in ("before-first-input", "after-refusal"), "Fixed creation diagnostic phase required")
        records = report.setdefault("creationContextDiagnostics", [])
        require(len(records) < 2 and not any(row["phase"] == phase for row in records), "One creation diagnostic per phase")
        records.append(entry)
        entry["process"] = owned_process_umask(process, native, helper)
        entry["journalDirectory"] = owned_journal_directory_acl(home)
        require(kernel_record(process["pid"], native, helper) == process, "Owned Root changed during creation diagnostic")
        entry["complete"] = True
    except Exception as error:
        # Diagnostics never authorize input or replace the original refusal.
        entry["unavailable"] = {"type": type(error).__name__[:80]}
        if isinstance(error, OSError) and type(error.errno) is int and 0 < error.errno < 4096:
            entry["unavailable"]["errno"] = error.errno
    return entry


def capture_portable_ancestry(phase, process, native, helper):
    require(phase in ("before-launch", "after-refusal"), "Finite portable diagnostic phase required")
    result = {"schemaVersion": 1, "phase": phase, "readOnly": True, "qualified": False, **FALSE}
    try:
        result["entries"] = portable_ancestry_metadata()
    except Exception as error:
        result["ancestryUnavailable"] = type(error).__name__
    try:
        result["process"] = owned_process_umask(process, native, helper)
    except Exception as error:
        result["processUnavailable"] = type(error).__name__
    require(len(json.dumps(result).encode()) <= 8192, "Bounded portable ancestry diagnostic required")
    try:
        save(BASE / "result" / ("portable-ancestry-" + phase + ".json"), result)
    except Exception:
        pass
    return result


def capture_bootstrap_failure(surface, actions):
    result = {"schemaVersion": 1, "readOnly": True, "qualified": False, "root": surface.record, "actions": list(actions)}
    try:
        result["snapshot"], _ = surface.snapshot()
    except Exception as error:
        result["snapshotRefused"] = type(error).__name__
    try:
        result["bitmap"] = phase_bitmap(surface, "bootstrap-failure-bitmap")
    except Exception as error:
        result["bitmapRefused"] = type(error).__name__
    try:
        capture_portable_ancestry("after-refusal", surface.record, surface.native, surface.helper)
    except Exception:
        pass
    try:
        save(BASE / "result/bootstrap-failure-ui.json", result)
    except Exception:
        pass
    return result


def bootstrap16(folder, profile, review, env, helper, native, atspi, x11):
    executable = folder / "Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
    source = object_path(folder, profile, "appimage16")
    bound(source, object_pin(profile, "appimage16"))
    bound(executable, object_pin(profile, "appimage16"), uid=0, mode=0o755)
    child = subprocess.Popen([str(executable), "--appimage-extract-and-run"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    def find():
        require(child.poll() is None, "Native support exited before first-use UI")
        pending, found, seen = [child.pid], [], set()
        while pending:
            pid = pending.pop(); require(pid not in seen and len(seen) < 64, "Bounded owned bootstrap process tree")
            seen.add(pid)
            try:
                value = kernel_record(pid, native, helper)
            except (FileNotFoundError, ProcessLookupError):
                continue
            require(value["uids"] == [UID] * 4, "Foreign bootstrap process UID")
            if value["executable"].endswith("/usr/bin/creator-hub"):
                require(value["kernelImageSha256"] == review["portable"]["16"]["manifest"]["entries"][ROOT_ENTRY]["sha256"], "Bootstrap is not the pinned actual AppImage Root")
                found.append(value)
            pending.extend(children(pid))
        require(len(found) <= 1, "Multiple bootstrap Root processes")
        return found[0] if found else None
    root = wait(find)
    appdir = Path(root["executable"]).parents[2]
    surface = Surface(root, x11, helper, native, atspi, manifest=review["portable"]["16"]["manifest"], generation_dir=appdir)
    actions = []
    try:
        wait(lambda: surface.source("usage-terms-checkbox", optional=True))
        surface.click("usage-terms-checkbox", actions); surface.click("usage-terms-continue", actions)
        wait(lambda: surface.source("native-support-install", optional=True))
        surface.click("native-support-install", actions)
        dialog = Surface(root, x11, helper, native, atspi, title="Install native support", dialog=True)
        generation = review["portable"]["16"]["generation"]
        body = ("Install Creator Hub native support 0.1.16?\n\nThis installs and registers the verified generation " + generation +
                " in your private native data directory. The Hub window runs OUTSIDE the Flatpak sandbox and uses your existing native settings.\n\n"
                "Your projects, MCP connections and settings will not be imported, replaced or migrated here. After installation, close this window normally and reopen Hub from Flatpak. "
                "No app will be launched or restarted automatically.\n\nCancel keeps Store creation, selection and registration unchanged.")
        try:
            dialog.dialog_action(body, ("Install native support", "Cancel"), "Install native support", [])
        finally:
            dialog.bus.close_sync(None)
        expected = "Native support is installed and registered. Close this setup window normally, then reopen Creator Hub from Flatpak. No MCP connection, project or settings migration was started."
        wait(lambda: field_text(surface, "native-support-status") == expected, 180)
        portable_state(Path(env["HOME"]), review, "16")
        surface.close(); wait(lambda: child.poll() is not None)
        require(child.returncode == 0 and not windows(x11), "Setup must close normally before activation")
        surface.bus.close_sync(None)
    except Exception:
        try:
            capture_bootstrap_failure(surface, actions)
        except Exception:
            pass
        raise
    return {"actualSetupUi": True, "installedSignedGeneration": generation, "normalExitCode": child.returncode}


def native_home_guard_diagnostic(env, home):
    paths = {}
    for key, leaf in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items():
        actual = {"present": key in env}
        if key in env:
            value = env[key]
            actual.update(redacted=True, sha256=hashlib.sha256(os.fsencode(value)).hexdigest())
            path = Path(value)
            if path.is_absolute() and str(path) == value and ".." not in path.parts and len(json.dumps(value)) <= 512:
                roots = (BASE, Path("/var/lib/creator-polkit-fixture"))
                if any(path == root or root in path.parents for root in roots):
                    try:
                        if path.resolve(strict=False) == path:
                            actual = {"present": True, "path": value}
                    except (OSError, RuntimeError):
                        pass
        paths[key] = {"expected": str(home / leaf), "actual": actual}
    raw = json.dumps({"kind": "production016-native-home-mismatch", "paths": paths}, separators=(",", ":"), allow_nan=False)
    require(len(raw.encode()) <= 4096, "Bounded synthetic home diagnostic exceeded")
    print(raw, flush=True)


def native_session(env):
    scenario = admission(env)
    require(os.getuid() == os.geteuid() == UID, "Only the fresh synthetic account may run the GUI")
    home, folder = BASE / "result/home", BASE / "inputs"
    if not all(env.get(key) == str(home / leaf) for key, leaf in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items()):
        try:
            native_home_guard_diagnostic(env, home)
        except Exception:
            pass  # Diagnostic failure cannot change the original home refusal.
    require(all(env.get(key) == str(home / leaf) for key, leaf in {"HOME": ".", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache"}.items()), "Exact isolated native home required")
    original_request = parse(read(BASE / "request.json", 65536, uid=0, mode=0o644))
    profile_raw, api_raw = read(folder / "profile.json", 65536), read(folder / "api.json", 512 * 1024)
    # Runtime env paths legitimately differ; the original external context is
    # retained verbatim and all copied source/inputs are re-bound here.
    admission(original_request["context"])
    require(original_request["profile"] == pin(profile_raw) and original_request["api"] == pin(api_raw)
            and original_request["scenario"] == scenario and all(original_request[key] is False for key in FALSE), "Sealed source/input request changed before GUI")
    validate_profile(parse(profile_raw), scenario)
    validate_all_api(parse(profile_raw), parse(api_raw), original_request["context"])
    for name, expected in original_request["sources"].items():
        bound(BASE / "scripts" / name, expected, 2 * 1024**2, uid=0, mode=0o444)
    observer = inventory_observer(original_request)
    inventory = observer.InventoryClient(env["GITHUB_SHA"], scenario, cohort="update")
    bound(BASE / "scripts/verify-package-input", original_request["verifier"]["tool"]["pin"], 64 * 1024**2, uid=0, mode=0o755)
    profile = parse(profile_raw); review = parse(read(BASE / "review.json", 2 * 1024**2, uid=0, mode=0o644))
    require(review["signaturesVerified"] is True and all(review[k] is False for k in FALSE), "Root-reviewed signed stage required")
    control = read_private_control()
    proxy = control["proxyUrl"]
    require(re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", proxy) and 0 < int(proxy.rsplit(":", 1)[1]) < 65536, "Owned loopback lab only")
    secret = bytearray(control["secret"].encode()) if control["secret"] is not None else None
    require((secret is not None) == (scenario == "deb-approve"), "Credentials only in the one DEB approval scenario")
    del control
    import gi
    gi.require_version("Atspi", "2.0"); gi.require_version("Gdk", "3.0")
    from gi.repository import Atspi, Gdk, Gio, GLib
    Gdk.init([]); Atspi.init(); Atspi.set_timeout(1500, 1500)
    pages, helper, native, polkit, flow = (load(n) for n in ("native-linux-integrated-pages", "native-unix-window", "native-linux-root-probe", "native-linux-polkit-probe", "native-linux-update-flow"))
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(36, 1, 0, 0, 0) == 0 and signal.getsignal(signal.SIGCHLD) != signal.SIG_IGN, "Observable owned restart children require subreaper")
    value = ctypes.c_int(); require(libc.prctl(37, ctypes.byref(value), 0, 0, 0) == 0 and value.value == 1, "Subreaper setup not confirmed")
    report = {"schemaVersion": 1, "profile": PROFILE, "scenario": scenario, "harnessSource": env["GITHUB_SHA"],
              "fromSource": profile["baseline"]["source"], "toSource": FIXED["17"]["source"], "nativeActions": [], "systemActions": [], "journalDiagnostics": [],
              "startupUi": [], "startupPhase": "not-started", "initialPageActionAttempts": [], "successorPageActionAttempts": [],
              "automaticSuccessor": None, "scenarioPassed": False, "disposableTeardownRequired": True,
              "privateTargetQualification": private_target_qualification(), "oldRetirementHelperRestored": False, **FALSE}
    portable = scenario.startswith("portable-")
    x11, surface, replacement, agent, runtime, wm, initial = helper.X11(), None, None, None, None, None, None
    html = None
    failure = None
    try:
        wm = subprocess.Popen(["/usr/bin/openbox", "--sm-disable"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wm_record = kernel_record(wm.pid, native, helper)
        wait(lambda: x11.property(x11.x.XDefaultRootWindow(x11.display), "_NET_SUPPORTING_WM_CHECK"))
        require(windows(x11) == [], "Fresh private display required")
        before = fixtures(home)
        report["before"] = before
        app_env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"),
                   "XDG_DATA_HOME": str(home / "data"), "XDG_CACHE_HOME": str(home / "cache"), "XDG_RUNTIME_DIR": env["XDG_RUNTIME_DIR"],
                   "TMPDIR": env["TMPDIR"], "GDK_BACKEND": "x11", "NO_AT_BRIDGE": "0", "HTTPS_PROXY": proxy,
                   "NO_PROXY": "localhost,127.0.0.1,::1", **{k: env[k] for k in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY") if k in env}}
        if scenario == HTML_SCENARIO:
            keys(original_request["htmlDriver"], ("version", "pin"))
            require(original_request["htmlDriver"]["version"] == HTML_DRIVER_VERSION, "Fixed reviewed WebDriver version required")
            validate_pin(original_request["htmlDriver"]["pin"], 64 * 1024**2)
            automation_env, automation_port = html_automation_environment(app_env)
        runtime = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", "import sys; sys.stdin.buffer.read()"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env={k: v for k, v in app_env.items() if k not in ("HTTPS_PROXY", "NO_PROXY")})
        unrelated = kernel_record(runtime.pid, native, helper)
        system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None); bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        parent = kernel_record(os.getpid(), native, helper)
        endpoint = agent_record = None
        if scenario in ("deb-auth-cancel", "deb-approve"):
            polkit.source_contract()
            session_identity = polkit.session(system, os.getpid(), GLib)
            agent = subprocess.Popen([polkit.AGENT], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=app_env)
            agent_record = kernel_record(agent.pid, native, helper)
            polkit.own_agent(agent, agent_record, parent, helper)
            require(polkit.session(system, agent.pid, GLib) == session_identity, "Agent is outside the exact real logind session")
            endpoint = wait(lambda: polkit.agent_bus_identity(system, agent_record, GLib))
        generation_dir = manifest = None
        if portable:
            capture_portable_ancestry("before-launch", parent, native, helper)
            report["bootstrap"] = bootstrap16(folder, profile, review, app_env, helper, native, Atspi, x11)
            generation_dir = portable_state(home, review, "16")
            manifest = review["portable"]["16"]["manifest"]
            selector = home / STORE / "activation-v1/creator-hub-portable-selector"
            initial = subprocess.Popen([str(selector), "activate"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=app_env)
            selector_record = kernel_record(initial.pid, native, helper)
            expected = {k: manifest["entries"][ROOT_ENTRY][k] for k in ("size", "sha256")}
            executable, parent_pid = str(generation_dir / ROOT_ENTRY), initial.pid
            old = wait(lambda: one_root_child(parent_pid, expected, executable, native, helper))
        else:
            report["installed16"] = verify_installed(review, "16")
            initial = subprocess.Popen(["/usr/bin/creator-hub"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       env=automation_env if scenario == HTML_SCENARIO else app_env, umask=0o022)
            expected, executable, parent_pid = profile["baseline"]["hub"], "/usr/bin/creator-hub", os.getpid()
            old = phase_identity(kernel_record(initial.pid, native, helper), expected, executable, parent_pid, UID)
        report["initialRoot"] = old; save(BASE / "result/root.json", old)
        old_bus = verify_bus(old, bus, polkit, GLib, portable=portable)
        surface = Surface(old, x11, helper, native, Atspi, manifest=manifest, generation_dir=generation_dir, inventory=inventory)
        if not portable:
            capture_initial_creation_context("before-first-input", home, old, report, native, helper)
        if scenario == HTML_SCENARIO:
            html = HtmlPages(surface, initial, pages, original_request["htmlDriver"]["pin"], automation_port, app_env,
                             report.setdefault("htmlWebDriver", {}))
            html.start()  # Mandatory runtime compatibility proof, with zero UI inputs before it returns.
            html.startup(home, report)
            html.direct_pages(report["initialPageActionAttempts"])
        else:
            startup_ui(surface, home, first=not portable, actions=report["startupUi"], progress=report)
            direct_pages(surface, report["initialPageActionAttempts"])
        report["initialBitmap"] = phase_bitmap(surface, "initial-bitmap")
        first_journal = journal(home, diagnostics=report["journalDiagnostics"])
        if html is not None:
            html.home()
            wait(lambda: html.optional("#hub-update-status") in ("Version 0.1.17 is available.", "Version 0.1.17 is ready to install."), 90)
            require(html.d.read("#hub-update-button", "enabled") is True, "Actual Update Hub action is not enabled")
        else:
            navigate_home(surface)
            wait(lambda: field_text(surface, "hub-update-status") in ("Version 0.1.17 is available.", "Version 0.1.17 is ready to install."), 90)
            require(surface.source("hub-update-button")[0]["enabled"], "Actual Update Hub action is not enabled")
        before[TERMS] = fingerprint(home / TERMS)
        preserved(home, before)
        old_store = fingerprint(home / STORE / "current.json") if portable else None
        old_service = fingerprint(home / HOST_SERVICE) if portable else None
        generations = set(p.name for p in (home / STORE / "generations").iterdir()) if portable else None
        baseline = children(parent_pid)
        report["initial16Verified"] = True
        if html is not None:
            html.click("#hub-update-button", [], "hub-update-button")
        else:
            surface.click("hub-update-button", [])
        modal = Surface(old, x11, helper, native, Atspi, title="Update Creator Hub", dialog=True)
        report["nativeConfirmationObserved"] = True
        try:
            require(set(windows(x11)) == {surface.window, modal.window}, "Only exact main/consent pair may receive native input")
            modal.dialog_action(question(portable), ("Update Hub", "Not now"), "Not now" if scenario.endswith("native-cancel") else "Update Hub", report["nativeActions"])
        finally:
            modal.bus.close_sync(None)
        wait(lambda: modal.window not in windows(x11), 30)
        if html is not None:
            html.expected_modal = None
            html.guard()
        if scenario in ("deb-auth-cancel", "deb-approve"):
            authorize(surface, agent, agent_record, parent, endpoint, system, GLib, Atspi, polkit, flow, helper, native, secret, report)
        if scenario.endswith("approve"):
            if portable:
                new_generation = review["portable"]["17"]["generation"]
                new_dir = home / STORE / "generations" / new_generation / "AppDir"
                new_pin = {k: review["portable"]["17"]["manifest"]["entries"][ROOT_ENTRY][k] for k in ("size", "sha256")}
                new_executable = str(new_dir / ROOT_ENTRY)
            else:
                new_dir, new_pin, new_executable = None, FIXED["17"]["hub"], "/usr/bin/creator-hub"
            successor, rejected = observe_successor(old, new_pin, new_executable, parent_pid, baseline, native, helper, old_child=None if portable else initial)
            report["automaticSuccessor"], report["nonliveRejected"] = successor, rejected
            verify_bus(successor, bus, polkit, GLib, portable=portable, previous=old_bus)
            replacement = Surface(successor, x11, helper, native, Atspi, manifest=review["portable"]["17"]["manifest"] if portable else None, generation_dir=new_dir, inventory=inventory)
            wait(lambda: feature_ready(replacement, "setup"), 90)
            report["restoredLastTool"] = "setup"
            navigate_home(replacement)
            wait(lambda: field_text(replacement, "hub-update-status") == "You are using Hub 0.1.17. No newer update was found.", 90)
            report["fresh17UiVersion"] = True
            report["directPagesObserved"] = direct_pages(replacement, report["successorPageActionAttempts"])
            report["successorBitmap"] = phase_bitmap(replacement, "successor-bitmap")
            report["readJournal17"] = journal(home, first_journal, diagnostics=report["journalDiagnostics"])
            if portable:
                portable_state(home, review, "17", previous=review["portable"]["16"]["generation"])
                require(fingerprint(home / HOST_SERVICE) == old_service and set(p.name for p in (home / STORE / "generations").iterdir()) == generations | {new_generation}, "Registration/old generations were replaced or extra generations appeared")
                verify_generation(home, review["portable"]["16"])
                require(kernel_record(initial.pid, native, helper) == selector_record, "Original signed selector was replaced")
            else:
                report["installed17"] = verify_installed(review, "17")
                report["oldRetirementHelperRestored"] = True
            report["installed17Verified"] = report["automaticRestartObserved"] = True
            replacement.close()
            if portable:
                wait(lambda: initial.poll() is not None)
                require(initial.returncode == 0, "Selector did not observe normal old/new Root exits")
                report["selectorFinalExitCode"] = 0
            else:
                wait(lambda: adopted_zero_exit(successor["pid"]))
                require(initial.returncode == 0, "Original Root exit was not normal")
            report["oldNormalExit"] = report["normalFinalClose"] = True
        else:
            require(kernel_record(old["pid"], native, helper) == old and initial.poll() is None, "Cancel did not retain original Root")
            require(windows(x11) == [surface.window], "Cancel left an extra/foreign window")
            if portable:
                portable_state(home, review, "16")
                require(fingerprint(home / STORE / "current.json") == old_store and fingerprint(home / HOST_SERVICE) == old_service
                        and set(p.name for p in (home / STORE / "generations").iterdir()) == generations, "Cancel changed selection/generations/registration")
            else:
                report["installedAfterCancel"] = verify_installed(review, "16")
            report["oldSelectionUnchanged"] = report["initialRootSurvived"] = True
            if html is not None:
                html.detach()  # Remote-session deletion must leave this same Popen alive.
            surface.close(); wait(lambda: initial.poll() is not None)
            require(initial.returncode == 0, "Cancelled original Root/selector did not close normally")
            report["normalFinalClose"] = True
            if html is not None:
                html.finish_tools()
        report["after"] = preserved(home, before); report["settingsPreserved"] = True
        require(kernel_record(runtime.pid, native, helper) == unrelated and runtime.poll() is None, "Unrelated EOF-only runtime changed/exited")
        report["runtimeSurvived"] = True
        runtime.stdin.close(); require(runtime.wait(timeout=10) == 0, "Unrelated runtime EOF shutdown failed")
        require(windows(x11) == [] and kernel_record(wm.pid, native, helper) == wm_record, "Visible app remained or WM identity changed")
        report["scenarioPassed"] = outcome(scenario, report)
        report["disposableTeardownRequired"] = False
    except Exception as error:
        failure = error
        report["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        retain_refusal_diagnostic(report, error)
        if not portable and report.get("initialRoot") is not None:
            capture_initial_creation_context("after-refusal", home, report["initialRoot"], report, native, helper)
    finally:
        if secret is not None:
            secret[:] = b"\0" * len(secret)
        for current in (surface, replacement):
            if current is not None:
                try:
                    save(BASE / "result" / ("successor-ui.json" if current is replacement else "original-ui.json"),
                         {"root": current.record, "snapshot": current.last, "htmlButtonActions": current.html_actions,
                          "axParentDiagnostic": getattr(current, "ax_parent_diagnostic", None),
                          "axSnapshotDiagnostic": getattr(current, "ax_snapshot_diagnostic", None)})
                    current.bus.close_sync(None)
                except Exception as error:
                    failure = failure or error
                    report["captureRefused"] = True
        if html is not None and html.logs is not None:
            try:
                html.evidence["lastRequest"] = html.d.last_request
                html.retain_logs()
            except Exception as error:
                failure = failure or error
                report["captureRefused"] = True
            finally:
                try:
                    html.logs.close()
                except Exception as error:
                    failure = failure or error
                    report["captureRefused"] = True
        if failure is not None:
            report["scenarioPassed"] = False; report["disposableTeardownRequired"] = True
            report["recovery"] = "unknown-no-retry-disposable-runner-teardown"
        save(BASE / "result/report.json", report)
    if failure is not None:
        raise failure


def read_private_control():
    require(stat.S_ISFIFO(os.fstat(0).st_mode), "Private broker pipe required")
    raw = bytearray()
    while len(raw) <= 1024:
        part = os.read(0, min(256, 1025 - len(raw)))
        if not part:
            break
        raw.extend(part)
    try:
        require(0 < len(raw) <= 1024 and raw.endswith(b"\n"), "Bounded private control frame required")
        value = parse(raw); keys(value, ("secret", "proxyUrl"))
        require(value["secret"] is None or type(value["secret"]) is str and re.fullmatch(r"[0-9a-f]{64}", value["secret"]), "Synthetic credential format differs")
        return value
    finally:
        raw[:] = b"\0" * len(raw)


def one_root_child(parent, expected, executable, native, helper):
    result = []
    for pid in children(parent):
        try:
            value = kernel_record(pid, native, helper)
        except (FileNotFoundError, ProcessLookupError):
            continue
        if value["executable"] == executable:
            result.append(phase_identity(value, expected, executable, parent, UID))
    require(len(result) <= 1, "Multiple initial Roots")
    return result[0] if result else None


def adopted_zero_exit(pid):
    observed, status = os.waitpid(pid, os.WNOHANG)
    if not observed:
        return False
    require(observed == pid and os.waitstatus_to_exitcode(status) == 0, "Automatic successor final exit was not normal")
    return True


def verify_generation(home, reviewed):
    directory = home / STORE / "generations" / reviewed["generation"]
    require({p.name for p in directory.iterdir()} == {"AppDir", "manifest.json", "manifest.minisig"}, "Unknown retained generation metadata")
    actual = parse(read(directory / "manifest.json", 2 * 1024**2, uid=UID, mode=0o444))
    require(actual == reviewed["manifest"], "Retained signed manifest changed")
    bound(directory / "manifest.minisig", reviewed["signature"], 4096, uid=UID, mode=0o444)
    for name, item in reviewed["manifest"]["entries"].items():
        file = directory / "AppDir" / name
        if item["kind"] == "file":
            bound(file, {k: item[k] for k in ("size", "sha256")}, uid=UID, mode=item["mode"] & ~0o222)
        else:
            info = file.lstat()
            require(file.resolve(strict=True) == file and stat.S_ISDIR(info.st_mode) and info.st_uid == UID and stat.S_IMODE(info.st_mode) == 0o555, "Retained signed directory changed")
    require({p.relative_to(directory / "AppDir").as_posix() for p in (directory / "AppDir").rglob("*")} == set(reviewed["manifest"]["entries"]), "Extra retained generation entries")


def transport_files(profile, scenario):
    if scenario.startswith("deb-"):
        return {"deb17/" + name: role for name, role in (
            ("creator-hub-linux-x86_64-deb.json", "debDescriptor17"),
            ("creator-hub-linux-x86_64-deb.json.minisig", "debSignature17"),
            ("Creator_Hub_0.1.17_amd64-acceptance-only.deb", "deb17"), ("latest.json", "latest17"))}
    files = {}
    for version in ("16", "17"):
        for name, role in (("creator-hub-linux-x86_64-portable.json", "portableDescriptor" + version),
                           ("creator-hub-linux-x86_64-portable.json.minisig", "portableSignature" + version),
                           (f"creator-hub-linux-x86_64-0.1.{version}.portable-manifest.json", "portableManifest" + version),
                           (f"creator-hub-linux-x86_64-0.1.{version}.portable-manifest.json.minisig", "manifestSignature" + version),
                           (f"creator-hub-linux-x86_64-0.1.{version}.appdir.tar.gz", "archive" + version)):
            files["portable" + version + "/" + name] = role
    return files


def transport_path(env):
    return Path(env["RUNNER_TEMP"]) / "native-linux-production-016-update/transport"


def prepare_transport(folder, profile, env):
    root = transport_path(env)
    root.parent.mkdir(mode=0o700)
    root.mkdir(mode=0o700); (root / "inputs").mkdir(mode=0o700)
    scenario = env["UPDATE_SCENARIO"]
    files = transport_files(profile, scenario)
    for relative, role in files.items():
        file = root / "inputs" / relative
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write(file, bound(object_path(folder, profile, role), object_pin(profile, role)))
    pins = {"schemaVersion": 1, "mode": "portable" if scenario.startswith("portable-") else "deb", "fromVersion": "0.1.16", "targetVersion": "0.1.17",
            "files": {name: object_pin(profile, role) for name, role in files.items()}}
    save(root / "transport-pins.json", pins)
    return root, pins


def protected_ancestry(path):
    require(Path(path).resolve(strict=True) == Path(path), "Redirected protected ancestry")
    for directory in (Path(path), *Path(path).parents):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022, "Protected root-owned directory required")


def prepare_fixture_parent(env):
    admission(env)
    require(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0
            and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "Exact root checkout fixture broker required")
    require(BASE == Path("/opt/creator-polkit-fixture") and not os.path.lexists(BASE), "Fresh fixed fixture only; no parent path overrides")
    paths = (("/", Path("/")), ("/opt", Path("/opt")))
    report = {"kind": "production016-update-parent-ancestry", "ciOnly": True, "guardPassed": False,
              "chmodAttemptCount": 0, **FALSE}
    handles, before, failure = [], [], None

    def row(name, file, info):
        return {"path": name, "dev": info.st_dev, "ino": info.st_ino, "uid": info.st_uid, "gid": info.st_gid,
                "mode": format(stat.S_IMODE(info.st_mode), "04o"), "directory": stat.S_ISDIR(info.st_mode),
                "resolvedPath": str(file.resolve(strict=True))}

    def emit(phase):
        raw = json.dumps({**report, "phase": phase}, separators=(",", ":"), allow_nan=False)
        require(len(raw.encode()) <= 8192, "Fixed parent diagnostic exceeds bound")
        print(raw, flush=True)

    def verify(opt_mode):
        after = []
        for index, (name, file) in enumerate(paths):
            named = os.lstat("/") if index == 0 else os.stat("opt", dir_fd=handles[0], follow_symlinks=False)
            for info in (os.fstat(handles[index]), named):
                require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
                        and (info.st_dev, info.st_ino) == (before[index].st_dev, before[index].st_ino)
                        and stat.S_IMODE(info.st_mode) == (0o755 if index == 0 else opt_mode),
                        "CI fixture parent identity changed: " + name)
            require(file.resolve(strict=True) == file, "Redirected CI fixture parent: " + name)
            after.append(row(name, file, named))
        return after

    try:
        report["before"] = []
        for name, file in paths:
            info = file.lstat(); before.append(info); report["before"].append(row(name, file, info))
        # Capture this run's exact metadata before any permission change. Only
        # the previously supported disposable-runner /opt 0777 shape is tightened.
        emit("before")
        for index, (name, file) in enumerate(paths):
            info = before[index]
            require(file.resolve(strict=True) == file and stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
                    and stat.S_IMODE(info.st_mode) in ((0o755,) if index == 0 else (0o755, 0o777)),
                    "Unknown fixed CI directory; no repair: " + name)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        handles.append(os.open("/", flags))
        handles.append(os.open("opt", flags, dir_fd=handles[0]))
        verify(stat.S_IMODE(before[1].st_mode))
        if stat.S_IMODE(before[1].st_mode) == 0o777:
            report["chmodAttemptCount"] = 1
            os.fchmod(handles[1], 0o755)
        report["after"] = verify(0o755)
        protected_ancestry(BASE.parent)
        report["guardPassed"] = True
        return report
    except Exception as error:
        failure = error
        report["error"] = {"type": type(error).__name__, "message": str(error)[:1024]}
        raise
    finally:
        for fd in reversed(handles):
            try:
                os.close(fd)
            except Exception:
                if failure is None:
                    raise
        try:
            emit("after")
        except Exception:
            if failure is None:
                raise


def clean_context(env):
    return {**{key: env[key] for key in ENVIRONMENT}, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}


def copy_inputs(source, target, profile):
    target.mkdir(mode=0o700)
    for name in ("profile.json", "api.json"):
        write(target / name, read(source / name, 512 * 1024))
    for name, artifact in input_roles(profile).items():
        write(target / (name + ".zip"), bound(source / (name + ".zip"), artifact["zip"], MAX_ZIP))


def published_input_mode(file, folder, profile):
    if file.is_dir():
        return 0o755
    alias = folder / "Creator.Hub.Native.Support_0.1.16_amd64.AppImage"
    return 0o755 if file == alias and "appimage16" in profile["objects"] else 0o644


def create_account():
    import grp
    import pwd
    for fn, key in ((pwd.getpwnam, USER), (pwd.getpwuid, UID), (grp.getgrnam, USER), (grp.getgrgid, UID)):
        try:
            fn(key)
        except KeyError:
            continue
        raise RuntimeError("Pre-existing synthetic account/group refused")
    run_tool(["/usr/sbin/useradd", "--uid", str(UID), "--user-group", "--create-home", "--home-dir", "/var/lib/creator-polkit-fixture",
              "--shell", "/bin/bash", "--groups", "sudo", USER])
    account = pwd.getpwnam(USER)
    require((account.pw_uid, account.pw_gid, account.pw_dir, account.pw_shell) == (UID, UID, "/var/lib/creator-polkit-fixture", "/bin/bash")
            and set(os.getgrouplist(USER, UID)) == {UID, grp.getgrnam("sudo").gr_gid}, "Exact fresh synthetic administrator required")


def system_session_command(env):
    result = BASE / "result"
    values = clean_context(env)
    values.update(HOME=str(result / "home"), USER=USER, RUNNER_TEMP=str(result), XDG_CONFIG_HOME=str(result / "home/config"),
                  XDG_DATA_HOME=str(result / "home/data"), XDG_CACHE_HOME=str(result / "home/cache"), XDG_RUNTIME_DIR=str(result / "runtime"),
                  TMPDIR=str(result / "tmp"), GDK_BACKEND="x11", NO_AT_BRIDGE="0")
    return ["/usr/bin/systemd-run", "--wait", "--pipe", "--collect", "--quiet", "--unit=creator-production016-update-fixture",
            "--uid=" + USER, "--property=PAMName=login", "--property=Type=exec", "--property=LimitCORE=0", "--property=WorkingDirectory=" + str(BASE),
            *("--setenv=" + key + "=" + value for key, value in values.items()),
            "/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "-a", "--server-args=-screen 0 1280x1000x24",
             "/usr/bin/env", *(key + "=" + values[key] for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME")),
            "/usr/bin/python3", "-B", str(BASE / "scripts" / Path(__file__).name), "session"]


def publish(file, value):
    require(file.parent == BASE and not os.path.lexists(file), "Fresh root-owned proof publication only")
    protected_ancestry(BASE)
    temporary = file.with_name(file.name + ".publishing")
    save(temporary, value, 0o644)
    require(not os.path.lexists(file), "Foreign proof appeared")
    os.rename(temporary, file)


def verify_stock_sources():
    polkit = load("native-linux-polkit-probe")
    polkit.secure_stock_policy(Path(os.environ["RUNNER_TEMP"]))


def trust_snapshot():
    folder = TLS_TRUST
    protected_ancestry(folder)
    entries = {}
    for file in folder.iterdir():
        require(len(entries) < 2048, "Bounded system trust inventory")
        info = file.lstat()
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 if not stat.S_ISLNK(info.st_mode) else info.st_uid == info.st_gid == 0,
                "Unexpected trust entry owner/mode")
        if stat.S_ISLNK(info.st_mode):
            entries[file.name] = {"link": os.readlink(file)}
        elif stat.S_ISDIR(info.st_mode):
            entries[file.name] = {"kind": "directory", "mode": stat.S_IMODE(info.st_mode)}
        else:
            require(stat.S_ISREG(info.st_mode), "Special trust-store entry refused")
            entries[file.name] = {"mode": stat.S_IMODE(info.st_mode), "bytes": pin(read(file, 2 * 1024**2, uid=0))}
    return {"entries": entries, "bundle": pin(read(folder / "ca-certificates.crt", 2 * 1024**2, uid=0, mode=0o644))}


def trust_restore_difference(before, after, certificate_absent):
    def byte_pin(value):
        keys(value, ("size", "sha256"))
        require(type(value["size"]) is int and 0 <= value["size"] <= 2 * 1024**2
                and type(value["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "Invalid trust diagnostic byte pin")
        return {"size": value["size"], "sha256": value["sha256"]}

    def entry(value):
        if value is None:
            return None
        if "link" in value:
            keys(value, ("link",))
            require(type(value["link"]) is str and len(value["link"]) <= 4096, "Bounded trust link metadata required")
            return {"kind": "symlink", "targetBytes": pin(os.fsencode(value["link"]))}
        require(type(value.get("mode")) is int and 0 <= value["mode"] <= 0o7777, "Invalid trust diagnostic mode")
        if value.get("kind") == "directory":
            keys(value, ("kind", "mode"))
            return {"kind": "directory", "mode": value["mode"]}
        keys(value, ("mode", "bytes"))
        return {"kind": "regular", "mode": value["mode"], "bytes": byte_pin(value["bytes"])}

    require(type(certificate_absent) is bool, "Explicit trust certificate absence required")
    for snapshot in (before, after):
        keys(snapshot, ("entries", "bundle"))
        require(type(snapshot["entries"]) is dict and len(snapshot["entries"]) <= 2048
                and all(type(name) is str and 0 < len(name) <= 255 for name in snapshot["entries"]), "Bounded trust entry metadata required")
    record = {"kind": "production016-tls-restore-failure", "pid": os.getpid(), "certificateAbsent": certificate_absent,
              "beforeBundle": byte_pin(before["bundle"]), "afterBundle": byte_pin(after["bundle"]),
              "beforeEntryCount": len(before["entries"]), "afterEntryCount": len(after["entries"]),
              "addedCount": 0, "removedCount": 0, "changedCount": 0, "changes": []}
    for name in sorted(before["entries"].keys() | after["entries"].keys()):
        old, new = before["entries"].get(name), after["entries"].get(name)
        if old == new:
            continue
        change = "added" if old is None else "removed" if new is None else "changed"
        record[change + "Count"] += 1
        if len(record["changes"]) < 32:
            record["changes"].append({"name": name, "change": change, "before": entry(old), "after": entry(new)})
    record["changeCount"] = sum(record[name] for name in ("addedCount", "removedCount", "changedCount"))
    record["truncated"] = record["changeCount"] > len(record["changes"])
    require(len(json.dumps(record, allow_nan=False).encode()) <= 128 * 1024, "Bounded trust diagnostic exceeded")
    return record


def record_trust_restore_failure(before, after, certificate_absent):
    record = {"kind": "production016-tls-restore-failure", "pid": os.getpid()}
    try:
        record = trust_restore_difference(before, after, certificate_absent)
        save(BASE / f"tls-restore-failure-{os.getpid()}.json", record, 0o644)
    except Exception as error:
        record["evidencePublicationErrorType"] = type(error).__name__
    try:
        print(json.dumps(record, separators=(",", ":"), allow_nan=False), file=sys.stderr, flush=True)
    except Exception:
        pass


def tls_arm(env):
    raw = read(BASE / "tls/armed.json", 256 * 1024, uid=0, mode=0o600)
    value = parse(raw)
    keys(value, ("schemaVersion", "harnessSource", "scenario", "profileSha256", "certificate", "before"))
    require(value["schemaVersion"] == 1 and value["harnessSource"] == env["GITHUB_SHA"] and value["scenario"] == env["UPDATE_SCENARIO"]
            and value["profileSha256"] == env["UPDATE_PROFILE_SHA256"], "No adoption of another TLS cleanup operation")
    return value


def cleanup_owned_trust_aliases(arm, published):
    require(os.getuid() == os.geteuid() == 0 and published["certificate"] == arm["certificate"]
            and not os.path.lexists(TLS_CERT), "Owned removed TLS certificate required before alias cleanup")
    protected_ancestry(TLS_TRUST)
    pem = TLS_CERT.stem + ".pem"
    require(pem not in arm["before"]["entries"], "Original PEM alias must not be removed")
    initial = TLS_TRUST.lstat()
    directory_key = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
    expected_directory = directory_key(initial)
    directory = os.open(TLS_TRUST, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    held = {}
    try:
        def recheck_directory():
            for info in (os.fstat(directory), TLS_TRUST.lstat()):
                require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
                        and directory_key(info) == expected_directory, "Protected trust directory changed")
            require(TLS_TRUST.resolve(strict=True) == TLS_TRUST, "Redirected trust directory refused")

        def inventory():
            recheck_directory()
            names = os.listdir(directory)
            require(len(names) <= 2048 and set(arm["before"]["entries"]).issubset(names), "Original bounded trust inventory required")
            aliases = {}
            for name in names:
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                target = os.readlink(name, dir_fd=directory) if stat.S_ISLNK(info.st_mode) else None
                if name != pem and target not in (pem, str(TLS_CERT)):
                    require(name in arm["before"]["entries"], "Unknown trust entry appeared during alias cleanup")
                    continue
                require(name not in arm["before"]["entries"] and stat.S_ISLNK(info.st_mode)
                        and info.st_uid == info.st_gid == 0 and info.st_nlink == 1,
                        "Original, foreign or non-symlink trust alias refused")
                require((name == pem and target == str(TLS_CERT))
                        or (re.fullmatch(r"[a-f0-9]{8}\.[0-9]{1,2}", name) and target == pem), "Unknown trust alias relationship refused")
                aliases[name] = {"stamp": list(stamp(info)), "target": target}
            require(len(aliases) <= 2 and sum(name != pem for name in aliases) <= 1, "Only one owned PEM/hash alias pair allowed")
            return aliases

        aliases = inventory()
        proof_path = BASE / "tls/aliases.json"
        protected_ancestry(proof_path.parent)
        binding = {"schemaVersion": 1, "certificate": arm["certificate"], "publishedStamp": published["stamp"],
                   "before": pin(json.dumps(arm["before"], sort_keys=True, separators=(",", ":")).encode()),
                   "directory": list(expected_directory)}
        new_proof = not os.path.lexists(proof_path)
        if not new_proof:
            proof = parse(read(proof_path, 16384, uid=0, mode=0o600))
            keys(proof, (*binding, "aliases"))
            require(all(proof[key] == value for key, value in binding.items()) and type(proof["aliases"]) is dict
                    and len(proof["aliases"]) <= 2 and sum(name != pem for name in proof["aliases"]) <= 1, "Foreign trust alias cleanup journal refused")
            require(all(name in proof["aliases"] and value == proof["aliases"][name] for name, value in aliases.items()),
                    "New or replaced trust alias cannot be adopted")
            for name, value in proof["aliases"].items():
                keys(value, ("stamp", "target"))
                require(type(value["stamp"]) is list and len(value["stamp"]) == len(stamp(initial))
                        and all(type(field) is int for field in value["stamp"]) and stat.S_ISLNK(value["stamp"][2])
                        and value["stamp"][3:6] == [0, 0, 1] and name not in arm["before"]["entries"] and ((name == pem and value["target"] == str(TLS_CERT))
                        or (re.fullmatch(r"[a-f0-9]{8}\.[0-9]{1,2}", name) and value["target"] == pem)), "Unknown journaled trust alias refused")
                if name not in aliases:
                    require(name not in os.listdir(directory), "Journaled trust alias was replaced by foreign content")
        else:
            proof = {**binding, "aliases": aliases}

        def recheck_link(name, value, fd):
            recheck_directory()
            for info in (os.fstat(fd), os.stat(name, dir_fd=directory, follow_symlinks=False)):
                require(stat.S_ISLNK(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1
                        and list(stamp(info)) == value["stamp"], "Owned trust alias identity changed")
            require(os.readlink("", dir_fd=fd) == os.readlink(name, dir_fd=directory) == value["target"], "Owned trust alias target changed")

        for name, value in aliases.items():
            held[name] = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            recheck_link(name, value, held[name])
        require(inventory() == aliases, "Trust alias inventory changed before cleanup")
        if new_proof:
            save(proof_path, proof)
            parent = os.open(proof_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        # Remove the hash link first; an interruption leaves a journal-bound PEM.
        for name in sorted(aliases, key=lambda name: name == pem):
            recheck_link(name, aliases[name], held[name])
            os.unlink(name, dir_fd=directory)
        require(not inventory(), "Owned trust aliases reappeared during cleanup")
    finally:
        for fd in held.values():
            os.close(fd)
        os.close(directory)


def tls_cleanup_locked(env):
    arm = tls_arm(env)
    published = None
    if (BASE / "tls/published.json").exists():
        published = parse(read(BASE / "tls/published.json", 16384, uid=0, mode=0o600))
        require(published["certificate"] == arm["certificate"], "Foreign trust publication receipt")
    if os.path.lexists(TLS_CERT):
        require(published is not None, "No authority to remove an unrecorded trust entry")
        info = TLS_CERT.lstat()
        require(published["certificate"] == arm["certificate"] and list(stamp(info)) == published["stamp"], "Owned trust entry identity changed; retained")
        bound(TLS_CERT, arm["certificate"], 65536, uid=0, mode=0o644)
        require(list(stamp(TLS_CERT.lstat())) == published["stamp"], "Trust entry changed before cleanup")
        os.unlink(TLS_CERT)
    if published is not None:
        # An interrupted rebuild after the exact owned unlink is recoverable;
        # an unknown/unrecorded certificate still has no cleanup authority.
        cleanup_owned_trust_aliases(arm, published)
        run_tool(["/usr/sbin/update-ca-certificates"], timeout=60)
    certificate_absent = not os.path.lexists(TLS_CERT)
    after = trust_snapshot()
    restored = certificate_absent and after == arm["before"]
    if not restored:
        record_trust_restore_failure(arm["before"], after, certificate_absent)
    require(restored, "Original CI trust snapshot not restored")
    return {"temporaryCertificateRemoved": True, "originalTrustRestored": True}


def tls_cleanup(env):
    require(os.getuid() == os.geteuid() == 0, "Only the fixed root trust cleanup owner")
    if not os.path.lexists(BASE / "tls/armed.json"):
        require(not os.path.lexists(TLS_CERT), "Unowned pre-existing certificate refused")
        return
    import fcntl
    fd = os.open(BASE / "tls/cleanup.lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return tls_cleanup_locked(env)
    finally:
        os.close(fd)


def tls_guard(env):
    require(os.getuid() == os.geteuid() == 0 and stat.S_ISFIFO(os.fstat(0).st_mode), "Root private cleanup lease required")
    import fcntl
    fd = os.open(BASE / "tls/cleanup.lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    failure = None
    try:
        arm = tls_arm(env)
        require(not os.path.lexists(TLS_CERT) and trust_snapshot() == arm["before"], "Initial CI trust snapshot changed")
        print(json.dumps({"kind": "tls-cleanup-armed", "pid": os.getpid()}), flush=True)
        require(select.select([0], [], [], 30)[0] and os.read(0, 32) == b"install\n", "Only one fixed publication request")
        protected_ancestry(TLS_CERT.parent)
        certificate = bound(BASE / "tls/public.crt", arm["certificate"], 65536, uid=0, mode=0o600)
        write(TLS_CERT, certificate, 0o644)
        save(BASE / "tls/published.json", {"certificate": arm["certificate"], "stamp": list(stamp(TLS_CERT.lstat()))})
        run_tool(["/usr/sbin/update-ca-certificates"], timeout=60)
        print(json.dumps({"kind": "tls-installed", "pid": os.getpid()}), flush=True)
        require(select.select([0], [], [], 1200)[0] and os.read(0, 32) == b"", "Cleanup lease ended without EOF")
    except Exception as error:
        failure = error
    finally:
        try:
            result = tls_cleanup_locked(env)
            if not (BASE / "tls/cleanup.json").exists():
                save(BASE / "tls/cleanup.json", result, 0o644)
        except Exception as error:
            failure = failure or error
        os.close(fd)
    if failure is not None:
        raise failure


class PipeChild:
    def __init__(self, argv, env, label, *, synthetic=False):
        self.child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=BASE,
                                      user=UID if synthetic else None, group=UID if synthetic else None, extra_groups=[] if synthetic else None)
        self.native = load("native-linux-root-probe")
        self.capture = self.native.Capture(self.child, BASE, label)
        self.lines = 0

    def send(self, raw):
        require(type(raw) is bytes and 0 < len(raw) <= 192 * 1024 and raw.endswith(b"\n"), "Bounded private control required")
        require(self.child.stdin.write(raw) == len(raw), "Private control delivery uncertain")
        self.child.stdin.flush()

    def ready(self):
        def check():
            self.capture.pump(0.02)
            require(self.child.poll() is None and not any(r["truncated"] or r["bytes"] > 8192 for r in self.capture.metadata().values()), "Owned control child exited/overflowed")
            raw = bytes(self.capture.items["stdout"]["kept"])
            rows = raw.split(b"\n")[:-1]
            require(len(rows) <= self.lines + 1, "Unexpected control messages")
            if len(rows) == self.lines:
                return None
            value = parse(rows[self.lines]); self.lines += 1
            require(value.get("pid") == self.child.pid, "Control message process identity differs")
            return value
        return wait(check, 60)

    def finish(self, *, close_message=False):
        if not self.child.stdin.closed:
            if close_message and self.child.poll() is None:
                self.send(b"close\n")
            self.child.stdin.close()
        def ended():
            self.capture.pump(0.02)
            return self.child.poll() is not None and all(r["eof"] for r in self.capture.metadata().values())
        try:
            wait(ended, 60)
            require(self.child.returncode == 0 and not any(r["truncated"] or r["bytes"] > 8192 for r in self.capture.metadata().values()), "Owned child cleanup failed/unknown; no signals sent")
        finally:
            self.capture.close()


def prepare_tls(env):
    folder = BASE / "tls"; folder.mkdir(mode=0o700)
    require(not os.path.lexists(TLS_CERT), "Pre-existing test CA refused")
    before = trust_snapshot()
    write(folder / "tls.cnf", TLS_CONFIG)
    run_tool(["/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", str(folder / "tls.cnf"),
              "-keyout", str(folder / "private.pem"), "-out", str(folder / "public.crt")])
    for name in ("private.pem", "public.crt"):
        os.chmod(folder / name, 0o600)
        read(folder / name, 65536, uid=0, mode=0o600)
    arm = {"schemaVersion": 1, "harnessSource": env["GITHUB_SHA"], "scenario": env["UPDATE_SCENARIO"], "profileSha256": env["UPDATE_PROFILE_SHA256"],
           "certificate": pin(read(folder / "public.crt", 65536, uid=0, mode=0o600)), "before": before}
    save(folder / "armed.json", arm); write(folder / "cleanup.lock", b"owned")
    directory_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    child = PipeChild(["/usr/bin/python3", "-B", str(BASE / "scripts" / Path(__file__).name), "_tls-guard"], clean_context(env), "tls-guard")
    try:
        require(child.ready()["kind"] == "tls-cleanup-armed", "Cleanup lease was not armed")
        child.send(b"install\n")
        require(child.ready()["kind"] == "tls-installed", "Temporary CI trust installation not confirmed")
        return child
    except Exception:
        child.finish()
        raise


def transport_context(env):
    result = clean_context(env)
    result["RUNNER_TEMP"] = str(BASE / "result")
    result["HOME"] = str(BASE / "result/home")
    return result


def inspect_transport(env, root, mode):
    raw = run_tool([env["CONTROLLER_NODE"], str(BASE / "scripts/linux-update-lab-feed.cjs"), "update-016-017-inspect", mode, str(root)],
                   env=transport_context(env), limit=65536)
    value = parse(raw)
    require(value["fromVersion"] == "0.1.16" and value["targetVersion"] == "0.1.17" and value["publicDiscovery"] is value["releaseReady"] is False,
            "Closed transport inspection refused; no legacy admission fallback")
    return value


def start_transport(env, root, mode, request_value):
    argv = [env["CONTROLLER_NODE"], str(BASE / "scripts/linux-update-lab-feed.cjs"), "update-016-017", mode, str(root)]
    child = PipeChild(argv, transport_context(env), "transport", synthetic=True)
    try:
        native, helper = load("native-linux-root-probe"), load("native-unix-window")
        image = kernel_record(child.child.pid, native, helper)
        require(image["parentPid"] == os.getpid() and image["uids"] == [UID] * 4
                and image["executable"] == env["CONTROLLER_NODE"] and image["kernelImageSha256"] == request_value["nodeImage"]["sha256"], "Lab Node image/UID/parent changed")
        key = bytearray(read(BASE / "tls/private.pem", 65536, uid=0, mode=0o600))
        try:
            control = bytearray((json.dumps({"key": base64.b64encode(key).decode(), "cert": base64.b64encode(read(BASE / "tls/public.crt", 65536, uid=0, mode=0o600)).decode()}) + "\n").encode())
            try:
                child.send(bytes(control))
            finally:
                control[:] = b"\0" * len(control)
        finally:
            key[:] = b"\0" * len(key)
        value = child.ready()
        keys(value, ("kind", "pid", "mode", "proxyUrl", "publicDiscovery", "nativeAcceptanceTested", "signaturesVerifiedByHarness", "releaseReady"))
        require(value["kind"] == "update-016-017-ready" and value.get("mode") == mode
                and all(value[key] is False for key in ("publicDiscovery", "nativeAcceptanceTested", "signaturesVerifiedByHarness", "releaseReady"))
                and type(value.get("proxyUrl")) is str and re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", value["proxyUrl"])
                and int(value["proxyUrl"].rsplit(":", 1)[1]) < 65536, "Closed owned transport readiness differs")
        child.proxy = value["proxyUrl"]
        return child
    except Exception:
        child.finish()
        raise


def validate_transport_report(value, pins, scenario):
    mode = "portable" if scenario.startswith("portable-") else "deb"
    require(value["schemaVersion"] == 1 and value["mode"] == mode
            and value["scope"] == "linux-" + mode + "-production016-to-private017-lab-transport"
            and value["pins"] == pins["files"] and all(value[k] is False for k in ("nativeAcceptanceTested", "signaturesVerifiedByHarness", "signedUpdateAccepted", "migrationAccepted", "restartAccepted")),
            "Exact closed transport receipt required; no scope promotion")
    require(value["fromVersion"] == "0.1.16" and value["targetVersion"] == "0.1.17" and value["publicDiscovery"] is value["releaseReady"] is False
            and value["closeReason"] == "caller" and value["rejectedRequestCount"] == 0, "Transport did not finish its finite caller-owned scope")
    expected = {}
    for relative, expected_pin in pins["files"].items():
        directory, name = relative.split("/", 1)
        version = "16" if directory == "portable16" else "17"
        expected["/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1." + version + "/" + name] = expected_pin["sha256"]
    served = {}
    for row in value["requests"]:
        require(row["host"] in ("api.github.com", "github.com"), "Foreign served host")
        if row["host"] == "api.github.com":
            require(row["path"] == "/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10", "Foreign feed path")
            continue
        require(row["path"] in expected and row["sha256"] == expected[row["path"]], "Served byte identity differs")
        served[row["path"]] = row["sha256"]
    prefix = "/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/"
    if scenario == "deb-native-cancel":
        require(set(served) == {prefix + "creator-hub-linux-x86_64-deb.json", prefix + "creator-hub-linux-x86_64-deb.json.minisig"},
                "Native Cancel must serve only its signed discovery envelope, not latest or installer")
    else:
        require(set(served) == set(expected), "All exact bootstrap/update assets must actually be requested")
    return {"servedPaths": sorted(served), "publicDiscovery": False, "releaseReady": False}


def closed_transport_diagnostic(value, pins, scenario):
    flags = ("publicDiscovery", "nativeAcceptanceTested", "baselineActuallyTested", "signaturesVerifiedByHarness",
             "signedUpdateAccepted", "migrationAccepted", "restartAccepted", "restoredViewsAccepted", "liveAiAcceptance", "releaseReady")
    counters = ("connectionCount", "requestCount", "receivedHttpBytes", "reservedResponseBytes", "rejectedRequestCount")
    keys(value, ("schemaVersion", "scope", "mode", "fromVersion", "targetVersion", "labDiscovery", "pins", "closeReason", "requests", *flags, *counters))
    mode = "portable" if scenario.startswith("portable-") else "deb"
    require(value["schemaVersion"] == 1 and value["mode"] == mode and value["fromVersion"] == "0.1.16"
            and value["targetVersion"] == "0.1.17" and value["scope"] == "linux-" + mode + "-production016-to-private017-lab-transport"
            and value["pins"] == pins["files"] and value["labDiscovery"] is True
            and all(value[name] is False for name in flags), "Closed diagnostic transport identity differs")
    require(value["closeReason"] in ("caller", "request-budget", "received-byte-budget", "connection-budget", "transport-error", "duration-budget")
            and all(type(value[name]) is int and 0 <= value[name] < 2**40 for name in counters), "Bounded closed transport metadata required")
    expected = {}
    for relative, expected_pin in pins["files"].items():
        directory, name = relative.split("/", 1)
        version = "16" if directory == "portable16" else "17"
        expected["/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1." + version + "/" + name] = expected_pin["sha256"]
    require(type(value["requests"]) is list and len(value["requests"]) <= len(expected) + 1, "Bounded diagnostic routes required")
    requests, seen = [], set()
    for row in value["requests"]:
        keys(row, ("host", "path", "sha256"))
        require(type(row["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]), "Diagnostic route digest required")
        require((row["host"] == "api.github.com" and row["path"] == "/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10")
                or (row["host"] == "github.com" and row["path"] in expected and row["sha256"] == expected[row["path"]]), "Foreign diagnostic route refused")
        identity = (row["host"], row["path"])
        require(identity not in seen, "Duplicate diagnostic route")
        seen.add(identity); requests.append(dict(row))
    result = {"schemaVersion": 1, "readOnly": True, "qualified": False, "mode": mode, "closeReason": value["closeReason"],
              **{name: value[name] for name in counters}, "requests": requests, **dict.fromkeys(flags, False)}
    require(len(json.dumps(result).encode()) <= 16384, "Bounded closed transport diagnostic output")
    return result


def broker(env):
    scenario = admission(env)
    require(os.getuid() == os.geteuid() == 0 and HERE == Path(env["GITHUB_WORKSPACE"]) / "scripts", "Fixed root broker must begin in the reviewed checkout")
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(stat.S_ISCHR(os.fstat(0).st_mode) and os.fstat(0).st_rdev == os.stat("/dev/null").st_rdev, "Broker stdin must be null")
    source = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-update"
    require(source.parent.resolve() == source.parent and not os.path.lexists(BASE), "Fresh fixed runner fixture, no adoption or retry")
    profile_raw, api_raw = read(source / "profile.json", 65536, mode=0o600), read(source / "api.json", 512 * 1024, mode=0o600)
    sealed = request(env, profile_raw, api_raw)
    require(parse(read(source / "request.json", 65536, mode=0o600)) == sealed, "Original sealed request changed before elevation")
    profile = parse(profile_raw)
    for package, executable in (("creator-hub", "/usr/bin/creator-hub"), ("creator-works-mcp", "/usr/bin/creator-works-mcp-launcher"), ("creator-project-setup", "/usr/bin/creator-project-setup")):
        result = subprocess.run(["/usr/bin/dpkg-query", "-W", "-f=${Status}", package], capture_output=True, env={"PATH": "/usr/bin:/bin", "LANG": "C"}, check=False, timeout=10)
        require(result.returncode == 1 and not result.stdout and not os.path.lexists(executable), "Pre-existing product refused; no restoration or replacement")
    prepare_fixture_parent(env)
    protected_ancestry(BASE.parent)
    BASE.mkdir(mode=0o755)
    for name in ("scripts", "result"):
        (BASE / name).mkdir(mode=0o755 if name == "scripts" else 0o700)
    for name, expected in sealed["sources"].items():
        write(BASE / "scripts" / name, bound(HERE / name, expected, 2 * 1024**2), 0o444)
    verifier_tool, verifier_evidence = offline_verifier(env)
    require(verifier_evidence == sealed["verifier"], "Verifier receipt changed before protected handoff")
    write(BASE / "scripts/verify-package-input", bound(verifier_tool, sealed["verifier"]["tool"]["pin"], 64 * 1024**2, mode=0o755), 0o755)
    if scenario == HTML_SCENARIO:
        driver = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-driver/bin/tauri-driver"
        write(BASE / "scripts/tauri-driver", bound(driver, sealed["htmlDriver"]["pin"], 64 * 1024**2, mode=0o755), 0o755)
    copy_inputs(source, BASE / "inputs", profile)
    stage(BASE / "inputs", env)  # independently repeat ZIP, signature and native package checks as root
    review_raw = read(BASE / "inputs/review.json", 2 * 1024**2, uid=0, mode=0o600)
    review = parse(review_raw)
    write(BASE / "request.json", read(BASE / "inputs/request.json", 65536), 0o644)
    write(BASE / "review.json", review_raw, 0o644)
    observer = inventory_observer(sealed)
    create_account()
    os.chown(BASE / "result", UID, UID)
    for file in (BASE / "inputs", *(BASE / "inputs").rglob("*")):
        require(not file.is_symlink(), "No links in private input copy")
        require(file.lstat().st_uid == 0, "Root-owned immutable input handoff required")
        os.chmod(file, published_input_mode(file, BASE / "inputs", profile))
    for name in ("home", "home/config", "home/data", "home/cache", "runtime", "tmp"):
        file = BASE / "result" / name; file.mkdir(mode=0o700); os.chown(file, UID, UID)
    context = transport_context(env)
    transport, pins = prepare_transport(BASE / "inputs", profile, context)
    for file in (transport.parent, transport, *transport.rglob("*")):
        os.chown(file, UID, UID)
    mode = "portable" if scenario.startswith("portable-") else "deb"
    # Execute the real unprivileged admission in inspect mode, never a test bypass.
    inspected = subprocess.run([env["CONTROLLER_NODE"], str(BASE / "scripts/linux-update-lab-feed.cjs"), "update-016-017-inspect", mode, str(transport)],
                               user=UID, group=UID, extra_groups=[], env=context, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=False)
    require(inspected.returncode == 0 and 0 < len(inspected.stdout) <= 65536 and len(inspected.stderr) <= 8192, "Closed lab inspection refused before installation/trust writes")
    inspection = parse(inspected.stdout)
    require(inspection["fromVersion"] == "0.1.16" and inspection["targetVersion"] == "0.1.17"
            and inspection["publicDiscovery"] is inspection["releaseReady"] is False, "Closed lab scope differs")
    polkit, native, helper = load("native-linux-polkit-probe"), load("native-linux-root-probe"), load("native-unix-window")
    polkit.verify_files(BASE); polkit.admin_config(); polkit.credential_tools(BASE)
    require(polkit.fixture_credential("status") == "L", "Fresh locked synthetic account required")
    secret = payload = session = lab = guard = logs = None
    relock, failure = False, None
    record = {"schemaVersion": 1, "profile": PROFILE, "scenario": scenario, "scenarioPassed": False, "fixtureRelocked": False,
              "harnessSource": env["GITHUB_SHA"], "baselineSource": profile["baseline"]["source"], "targetSource": FIXED["17"]["source"],
              "privateTargetQualification": private_target_qualification(), "oldRetirementHelperRestored": False, **FALSE}
    try:
        guard = prepare_tls(env)
        lab = start_transport(env, transport, mode, sealed)
        if scenario.startswith("deb-"):
            # The input was independently inspected above; initial installation
            # is not an update pass and is never repeated between scenarios.
            package = object_path(BASE / "inputs", profile, "deb16")
            bound(package, profile["baseline"]["deb"])
            run_tool(["/usr/bin/dpkg", "--install", str(package)])
            verify_installed(review, "16")
        if scenario == "deb-approve":
            secret = bytearray(secrets.token_hex(32).encode())
            relock = True
            polkit.fixture_credential("provision", secret)
            require(polkit.fixture_credential("status") == "P", "Synthetic provisioning refused")
        payload = bytearray((json.dumps({"secret": None if secret is None else secret.decode(), "proxyUrl": lab.proxy}) + "\n").encode())
        session = subprocess.Popen(system_session_command(env), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, cwd=BASE)
        logs = native.Capture(session, BASE, "session")
        require(session.stdin.write(payload) == len(payload), "Private session control delivery uncertain")
        session.stdin.close(); payload[:] = b"\0" * len(payload)
        if secret is not None:
            secret[:] = b"\0" * len(secret)
        inventory_state = {"sequence": 1, "nonces": set()}
        index, deadline = 1, time.monotonic() + 900
        while session.poll() is None and time.monotonic() < deadline:
            logs.pump(0.02)
            require(not any(r["truncated"] for r in logs.metadata().values()), "Bounded session diagnostic capture exceeded")
            observer.serve_inventory(inventory_state, record, env["GITHUB_SHA"], scenario, native, helper, cohort="update")
            target = BASE / "result" / f"input-{index}.json"
            if os.path.lexists(target):
                require(scenario in ("deb-auth-cancel", "deb-approve") and index <= 12, "Unexpected authorization input request")
                raw = read(target, 256, uid=UID, mode=0o600)
                if raw.endswith(b"\n"):
                    require(parse(raw) == {"index": index}, "Authorization input sequence differs")
                    root = parse(read(BASE / "result/root.json", 16384, uid=UID, mode=0o600))
                    proof = pending_proof(root, native, helper, polkit, profile["baseline"])
                    publish(BASE / f"input-{index}.json", {"index": index, "proof": proof})
                    index += 1
        require(session.poll() == 0, "Native scenario failed/unknown; no retry, signals or manual successor")
        result = parse(read(BASE / "result/report.json", 2 * 1024**2, uid=UID, mode=0o600))
        require(result["scenario"] == scenario and result["harnessSource"] == env["GITHUB_SHA"] and result["fromSource"] == profile["baseline"]["source"]
                and result["toSource"] == FIXED["17"]["source"] and result["scenarioPassed"] is True and outcome(scenario, result), "Native evidence incomplete")
        if scenario.startswith("deb-"):
            verify_installed(review, "17" if scenario == "deb-approve" else "16")
            record["oldRetirementHelperRestored"] = scenario == "deb-approve"
        lab.finish(close_message=True); lab = None
        # The adapter report is checked again after its owned process exits.
        transport_report = parse(read(transport / "lab-transport.json", 65536, uid=UID, mode=0o600))
        record["transport"] = validate_transport_report(transport_report, pins, scenario)
        record["scenarioPassed"] = True
    except Exception as error:
        failure = error
        record["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        retain_refusal_diagnostic(record, error)
        report_path = BASE / "result/report.json"
        if report_path.exists():
            try:
                native_result = parse(read(report_path, 2 * 1024**2, uid=UID, mode=0o600))
                if "refusal" in native_result:
                    record["sessionRefusal"] = native_result["refusal"]
            except Exception:
                record["sessionReceiptUnreadable"] = True
    finally:
        for buffer in (payload, secret):
            if buffer is not None:
                buffer[:] = b"\0" * len(buffer)
        for child, label, close_message in ((lab, "transportCleanup", True), (guard, "trustCleanup", False)):
            if child is not None:
                try:
                    child.finish(close_message=close_message)
                except Exception as error:
                    failure = failure or error
                    record[label] = {"refused": True, "type": type(error).__name__, "message": str(error)[:1000]}
        try:
            transport_diagnostic = closed_transport_diagnostic(parse(read(transport / "lab-transport.json", 65536, uid=UID, mode=0o600)), pins, scenario)
            save(BASE / "result/transport-diagnostic.json", transport_diagnostic)
        except Exception as error:
            record["transportDiagnosticUnavailable"] = type(error).__name__
        try:
            record["tlsCleanup"] = tls_cleanup(env)
        except Exception as error:
            failure = failure or error; record["tlsCleanupRefused"] = True
            record["tlsCleanupError"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        try:
            if relock:
                polkit.fixture_credential("lock")
            require(polkit.fixture_credential("status") == "L", "Synthetic account relock not proven")
            record["fixtureRelocked"] = True
        except Exception as error:
            failure = failure or error; record["relockRefused"] = True
        if logs is not None:
            try:
                logs.pump(); record["logs"] = logs.metadata()
                require(not any(r["truncated"] for r in record["logs"].values()), "Session capture overflow")
            except Exception as error:
                failure = failure or error
            finally:
                logs.close()
        if failure is not None:
            record["scenarioPassed"] = False; record["recovery"] = "unknown-no-retry-disposable-runner-teardown"
        save(BASE / "broker.json", record, 0o644)
    if failure is not None:
        raise failure


def export_evidence(env):
    require(os.getuid() == os.geteuid() == 0, "Root export of fixed synthetic evidence only")
    destination = Path(env["RUNNER_TEMP"]) / "native-linux-production-016-update-evidence"
    require(destination.parent.resolve() == destination.parent and not os.path.lexists(destination), "Fresh canonical export required")
    owner = destination.parent.stat().st_uid
    destination.mkdir(mode=0o700); os.chown(destination, owner, owner)
    names = ("broker.json", "request.json", "review.json", "result/report.json", "result/original-ui.json", "result/successor-ui.json", "session.stdout", "session.stderr",
             "result/html-driver.stdout", "result/html-driver.stderr",
             "result/initial-bitmap/root-window.png", "result/successor-bitmap/root-window.png", "result/bootstrap-failure-ui.json",
             "result/bootstrap-failure-bitmap/root-window.png", "result/transport-diagnostic.json",
             "result/portable-ancestry-before-launch.json", "result/portable-ancestry-after-refusal.json")
    diagnostics = sorted((*BASE.glob("public-tool-failure-*.json"), *BASE.glob("tls-restore-failure-*.json")))
    require(len(diagnostics) <= 8 and all(re.fullmatch(r"(?:public-tool-failure-(baseline-dpkg-install|update-ca-certificates|synthetic-useradd)|tls-restore-failure)-[1-9][0-9]*\.json", file.name)
                                        and file.lstat().st_uid == 0 for file in diagnostics), "Unknown public tool evidence refused")
    names += tuple(file.name for file in diagnostics)
    for name in names:
        file = BASE / name
        if not os.path.lexists(file):
            continue
        info = file.lstat(); require(info.st_uid in (0, UID), "Unexpected evidence owner")
        raw = read(file, 16 * 1024**2 if name.endswith(".png") else 2 * 1024**2)
        target = destination / name.replace("/", "__"); write(target, raw); os.chown(target, owner, owner)


def main():
    require(len(sys.argv) == 2, "One fixed controller phase required")
    mode = sys.argv[1]
    if mode == "preflight-import":
        require(sys.version_info >= (3, 10), "Python 3.10+ required")
        return
    scenario = admission(os.environ)
    root = Path(os.environ["RUNNER_TEMP"]) / "native-linux-production-016-update"
    if mode == "profile":
        raw = os.environ["UPDATE_PROFILE"].encode()
        require(0 < len(raw) <= 65536 and hashlib.sha256(raw).hexdigest() == os.environ["UPDATE_PROFILE_SHA256"], "Exact independent profile text required")
        validate_profile(parse(raw), scenario)
        require(not os.path.lexists(root), "Fresh input root required")
        root.mkdir(mode=0o700); write(root / "profile.json", raw)
    elif mode == "stage":
        stage(root, os.environ)
    elif mode == "api":
        raw = read(root / "profile.json", 65536, mode=0o600)
        require(hashlib.sha256(raw).hexdigest() == os.environ["UPDATE_PROFILE_SHA256"], "Profile changed")
        validate_all_api(validate_profile(parse(raw), scenario), parse(read(root / "api.json", 512 * 1024, mode=0o600)), os.environ)
    elif mode == "carrier":
        unpack_carrier(root, os.environ)
    elif mode == "verifier":
        # Reuse only the shared locked verifier builder, not Flatpak admission.
        build_offline_verifier(os.environ)
    elif mode == "stock-policy":
        verify_stock_sources()
    elif mode == "session":
        native_session(os.environ)
    elif mode == "_tls-guard":
        tls_guard(os.environ)
    elif mode == "tls-cleanup":
        tls_cleanup(os.environ)
    elif mode == "export":
        export_evidence(os.environ)
    else:
        require(mode == "broker", "Unknown controller phase")
        broker(os.environ)


if __name__ == "__main__":
    main()
