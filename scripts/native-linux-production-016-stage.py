"""Production 016 data-only inspection. No install, GUI, signing or candidate execution.

Only a future independently guarded controller may consume binding.json. A
successful inspection is not migration, update, restart or Flatpak acceptance.
"""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
from types import SimpleNamespace
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = load("native-linux-016-stage")
V = load("linux-retirement-package-verify")
COHORT = "production-migration-016"
BRANCH = "refs/heads/validation/native-linux-production-016"
FEATURES = ["integrated-features", "experimental-flatpak-host", "linux-production-migration", "experimental-linux-portable-update"]
PINS = (*S.PINS, "rawHub")
PRIVATE = {"sourceCommit": "085131ba6f3050a795fd513139a34975658ba321", "runId": 40538427509, "runAttempt": 1}
JOURNAL_A_PRIVATE = {"sourceCommit": "f9c6da1af4ea51fc0214fba058c3946c1cda255a", "runId": 40893082867, "runAttempt": 1}
JOURNAL_A_ASSEMBLY = {"sourceCommit": "be0adef208c80a60f8599bd466a45b28bde73588",
                      "sourceTree": "8eb710826de448d820a3cee6d964e4a3f3a24e10", "runId": 40899552207,
                      "runAttempt": 1, "jobId": 123537944797, "artifactId": 12909617948, "zipBytes": 183999603,
                      "zipSha256": "d6612027fded7b6163e8212453b853a08285f6551baaa1d0871f0121a040a2a7"}
JOURNAL_A_PROFILE_SHA = "08f2df3b8139f00f5bd5b84619218228c7878d62ae0e4ec180fdcaaec6b87fc3"
PRIVATE_PATHS = ("modules/mcp", "modules/project-setup", "native/mcp-router", "native/host_parent_macos.rs",
                 "native/plugins_retirement.rs", "native/convergence-server-unix.rs", "src-tauri/src/module_archive.rs", "src-tauri/src/catalog-key.pub")
FLAGS = dict.fromkeys(("nativeExecution", "nativeGuiAccepted", "migrationAccepted", "authenticationAccepted",
                       "signedUpdateAccepted", "automaticRestartAccepted", "flatpakAccepted", "releaseReady"), False)
require, parse, digest, exact, write = S.require, S.parse, S.digest, S.exact, S.write


def profile(value):
    S.keys(value, ("schemaVersion", "cohort", "mode", "assembly", "pins"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["cohort"] == COHORT, "Production cohort required")
    require(value["mode"] in ("pages", "migration-cancel"), "Production approval/update/Flatpak execution is not implemented")
    assembly = value["assembly"]
    S.keys(assembly, ("sourceCommit", "sourceTree", "runId", "runAttempt", "jobId", "artifactId", "zipBytes", "zipSha256"))
    for key in ("sourceCommit", "sourceTree"):
        require(type(assembly[key]) is str and re.fullmatch(r"[a-f0-9]{40}", assembly[key]), "Independent production commit/tree required")
    # Reuse the finite prototype field validator, not its cohort/admission.
    base = {"schemaVersion": 1, "mode": value["mode"], "assembly": {k: v for k, v in assembly.items() if k != "sourceTree"},
            "pins": {k: v for k, v in value["pins"].items() if k != "rawHub"}}
    S.profile(base)
    S.keys(value["pins"], PINS)
    raw = value["pins"]["rawHub"]
    S.keys(raw, ("size", "sha256"))
    require(type(raw["size"]) is int and 64 <= raw["size"] <= 256 * 1024 * 1024
            and type(raw["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", raw["sha256"]), "Independent raw Root pin required")
    candidate = any(assembly[k] == JOURNAL_A_ASSEMBLY[k] for k in ("sourceCommit", "runId", "jobId", "artifactId"))
    if candidate:
        require(assembly == JOURNAL_A_ASSEMBLY, "Fresh A assembly tuple is incomplete or mixed")
        expected = (HERE / "fixtures/journal-a-native-incoming.UNBOUND.json").read_bytes()
        require(len(expected) == 1763 and hashlib.sha256(expected).hexdigest() == JOURNAL_A_PROFILE_SHA,
                "Fresh A source-bound profile differs")
        require(value == parse(expected), "Fresh A profile differs")
    return value


def admission(env):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
                "GITHUB_REF": BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "CREATOR_NATIVE_LINUX_PRODUCTION_016": "1"}
    require(sys.platform == "linux" and os.getuid() > 0 and all(env.get(k) == v for k, v in expected.items()), "Exact unprivileged production inspection context required")
    require(type(env.get("GITHUB_SHA")) is str and re.fullmatch(r"[a-f0-9]{40}", env["GITHUB_SHA"]), "Harness source required")
    require(not any(k.startswith(("LD_", "DYLD_", "WEBKIT_", "TAURI_")) or k in ("PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "SSL_CERT_FILE", "SSL_CERT_DIR") for k in env), "Injected runtime refused")
    require(not any(env.get(k) for k in ("FLATPAK_ID", "APPIMAGE", "APPDIR")), "Native DEB inspection only")


def read_owned(file, maximum):
    require(file.resolve() == file, "Redirected production input")
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid()
            and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= maximum, "Unprotected/bounded production input required")
    fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_nlink", "st_uid", "st_gid", "st_mtime_ns", "st_ctime_ns")
    stamp = lambda info: tuple(getattr(info, key) for key in fields)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    with os.fdopen(os.open(file, flags), "rb") as stream:
        require(stamp(os.fstat(stream.fileno())) == stamp(before), "Input changed before read")
        raw = stream.read(maximum + 1)
        require(len(raw) == before.st_size and stamp(os.fstat(stream.fileno())) == stamp(before), "Input changed during read")
    require(stamp(file.lstat()) == stamp(before), "Input pathname changed")
    return raw


def api_binding(api, p, harness):
    S.keys(api, ("schemaVersion", "cohort", "harnessSource", "assembly", "privatePayload", "privateSourcePaths", "legacy", *FLAGS))
    profile({**p, "assembly": api["assembly"]})
    S.keys(api["privatePayload"], PRIVATE)
    require(type(api["privatePayload"]["sourceCommit"]) is str
            and all(type(api["privatePayload"][k]) is int for k in ("runId", "runAttempt")), "Typed private API identity required")
    assembly = p["assembly"]
    candidate = any(assembly[k] == JOURNAL_A_ASSEMBLY[k] for k in ("sourceCommit", "runId", "jobId", "artifactId"))
    if candidate:
        require(assembly == JOURNAL_A_ASSEMBLY, "Fresh A assembly tuple is incomplete or mixed")
    private_source = JOURNAL_A_PRIVATE if candidate else PRIVATE
    require(type(api["schemaVersion"]) is int and api["schemaVersion"] == 1 and api["cohort"] == COHORT
            and api["harnessSource"] == harness and re.fullmatch(r"[a-f0-9]{40}", harness)
            and api["assembly"] == assembly and api["privatePayload"] == private_source, "Production API/source binding differs")
    for key in FLAGS:
        require(api[key] is False, "API receipt cannot self-certify acceptance")
    S.keys(api["privateSourcePaths"], PRIVATE_PATHS)
    require(all(type(v) is str and re.fullmatch(r"[a-f0-9]{40}", v) for v in api["privateSourcePaths"].values()), "Private source Git identities required")
    require(type(api["legacy"]) is list and len(api["legacy"]) == 2, "Original legacy API receipts required")
    for row, product, repo, tag, name in zip(api["legacy"], ("mcp", "setup"),
            ("CREATOR-WORKS-UNITY-MCP", "CREATOR-PROJECT-SETUP"), ("v2.7.7", "v0.3.7"),
            ("Creator.Works.MCP_2.7.7_amd64.deb", "Creator.Project.Setup_0.3.7_amd64.deb")):
        S.keys(row, ("assetId", "releaseId", "product", "repo", "tag", "name", "size", "sha256"))
        size, sha = S.LEGACY[product]
        require((row["product"], row["repo"], row["tag"], row["name"], row["size"], row["sha256"]) == (product, repo, tag, name, size, sha)
                and all(type(row[k]) is int and 0 < row[k] < 2**53 for k in ("assetId", "releaseId")), "Legacy identity differs")


def stage_archive(raw, output, p):
    # The neutral ZIP inspector receives these already bounded, immutable bytes.
    S.stage_zip(SimpleNamespace(read_bytes=lambda: raw), output, p)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        row = archive.getinfo("creator-hub")
        require(not row.is_dir() and row.file_size == p["pins"]["rawHub"]["size"], "Raw Root archive member differs")
        body = archive.read(row)
        exact(body, p["pins"]["rawHub"])
        write(output / "rawHub.bin", body)


def check_proofs():
    # Fixed trusted source checker only; never a program/path from the profile.
    result = subprocess.run(["node", str(HERE / "native-linux-production-016-input.cjs"), "--verify-staged"],
                            capture_output=True, timeout=120, check=True)
    require(not result.stderr and 0 < len(result.stdout) <= 65536, "Production proof checker output differs")
    return parse(result.stdout)


def inspect_stage(incoming, output, p, api):
    stage_archive(read_owned(incoming / "assembly.zip", 300 * 1024 * 1024), output, p)
    receipt = parse((output / "assemblyReceipt.bin").read_bytes())  # duplicate keys fail before the Node checker
    require(receipt.get("compiledFeatures") == FEATURES and receipt.get("assemblyCommit") == p["assembly"]["sourceCommit"], "Production receipt tuple/source differs")
    manifest_raw = (output / "manifest.bin").read_bytes()
    manifest = parse(manifest_raw)
    require(manifest["platform"] == "linux" and manifest["arch"] == "x86_64", "Resource platform differs")
    archive = (output / "modulesArchive.bin").read_bytes()
    require(len(archive) == manifest["payloadArchive"]["size"] and digest(archive) == manifest["payloadArchive"]["sha256"], "Resource archive differs")
    resource_files = S.modules(io.BytesIO(archive), manifest)
    verified = V.verify(str(output / "deb.deb"), p["pins"]["helper"]["sha256"], p["pins"]["policy"]["sha256"], "0.1.16", COHORT)
    raw_deb = S.deb_records(output / "deb.deb")
    records = S.inspect_deb(raw_deb, p, manifest_raw, manifest)
    expected = {"/" + name: {**records[name], "uid": 0, "gid": 0} for name in
                (S.DEB_MEMBERS["helper"], S.DEB_MEMBERS["policy"], S.DEB_MEMBERS["service"])}
    require(verified == {"files": expected, "profile": COHORT}, "Production verifier and inspected package differ")
    with tarfile.open(fileobj=io.BytesIO(raw_deb), mode="r:") as decoded:
        rows = [r for r in decoded if r.name.removeprefix("./").rstrip("/") == S.DEB_MEMBERS["hub"]]
        require(len(rows) == 1 and rows[0].isfile(), "One packaged Root required")
        body = decoded.extractfile(rows[0]).read()
        exact(body, p["pins"]["hub"])
        write(output / "hub.bin", body)
    integrity = parse((output / "packageIntegrity.bin").read_bytes())
    S.keys(integrity, ("schemaVersion", "platform", "arch", "experimental", "mcpMode", "writableGuiAccepted", "releaseReady", "packages", "integrityPassed"))
    require(type(integrity["schemaVersion"]) is int and integrity["schemaVersion"] == 1 and integrity["platform"] == "linux"
            and integrity["arch"] == "x86_64" and integrity["experimental"] is True and integrity["mcpMode"] == "writable"
            and integrity["writableGuiAccepted"] is False and integrity["releaseReady"] is False
            and integrity["integrityPassed"] is True and type(integrity["packages"]) is list and len(integrity["packages"]) == 1, "Production package integrity receipt differs")
    package = integrity["packages"][0]
    S.keys(package, ("format", "path", "sha256", "hubSha256", "files"))
    require(package["format"] == "deb" and package["path"] == S.MEMBERS["deb"] and package["sha256"] == p["pins"]["deb"]["sha256"]
            and package["hubSha256"] == p["pins"]["hub"]["sha256"] and package["files"] == resource_files, "DEB/resource receipt differs")
    proof = check_proofs()
    S.keys(proof, ("cohort", "sourceCommit", "sourceTree", "compiledFeatures", "rawHub", "hub", "productionContract", "rawToPackaged", *FLAGS))
    require(proof["cohort"] == COHORT and proof["sourceCommit"] == p["assembly"]["sourceCommit"] and proof["sourceTree"] == p["assembly"]["sourceTree"]
            and proof["compiledFeatures"] == FEATURES and proof["rawHub"] == p["pins"]["rawHub"] and proof["hub"] == p["pins"]["hub"]
            and proof["productionContract"] == receipt["productionMigration"]["staging"]["productionContract"]
            and proof["rawToPackaged"] == "exact-tauri-bundle-marker-deb" and all(proof[k] is False for k in FLAGS), "Trusted production proof check differs")
    for product, (size, sha) in S.LEGACY.items():
        exact(read_owned(incoming / (product + ".deb"), size), {"size": size, "sha256": sha})
    return {"schemaVersion": 1, "cohort": COHORT, "inspectionOnly": True, "profile": p, "api": api,
            "productionProof": proof, "packageFiles": records, "resourceFiles": resource_files, **FLAGS}


def main():
    admission(os.environ)
    require(sys.argv[1:] == [], "No production path or execution overrides")
    temp = Path(os.environ["RUNNER_TEMP"])
    require(temp.resolve() == temp, "Redirected runner temp")
    incoming, output = temp / "native-linux-production-016-input", temp / "native-linux-production-016-stage"
    info = incoming.lstat()
    require(incoming.resolve() == incoming and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, "Private production input directory required")
    require({p.name for p in incoming.iterdir()} == {"profile.json", "api-binding.json", "assembly.zip", "mcp.deb", "setup.deb"}, "Unknown/missing production inputs")
    p = profile(parse(read_owned(incoming / "profile.json", 16384)))
    api = parse(read_owned(incoming / "api-binding.json", 65536))
    api_binding(api, p, os.environ["GITHUB_SHA"])
    output.mkdir(mode=0o700)  # no replacement, adoption or cleanup
    binding = inspect_stage(incoming, output, p, api)
    write(output / "binding.json", json.dumps(binding).encode())
    print(json.dumps({"productionInspectionPassed": True, "cohort": COHORT, **FLAGS}))


if __name__ == "__main__":
    main()
