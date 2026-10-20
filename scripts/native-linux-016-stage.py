"""Finite 016 archive/DEB/resource inspection. Never executes candidate code."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PRIVATE_SOURCE = "52e3a537c9d323c81ab259cb82b44bbe0828b414"
BRANCH = "refs/heads/validation/native-linux-016"
PINS = ("deb", "hub", "manifest", "modulesArchive", "assemblyReceipt", "packageIntegrity", "helper", "policy", "service")
MEMBERS = {"deb": "native-packages/Creator Hub_0.1.16_amd64.deb", "manifest": "builtin-manifest.json",
           "modulesArchive": "modules.tar.gz", "assemblyReceipt": "signed-unix-assembly.json", "packageIntegrity": "unix-package-integrity.json"}
DEB_MEMBERS = {"hub": "usr/bin/creator-hub", "modulesArchive": "usr/lib/Creator Hub/modules.tar.gz",
               "helper": "usr/libexec/creator-hub-deb-retirement-helper",
               "policy": "usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy",
               "service": "usr/share/dbus-1/services/com.creatorworks.hub.Host.service"}
LEGACY = {"mcp": (96666824, "db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b"),
          "setup": (5966970, "be18f23450146e71a2960e2110474f6e0409a9521a3ced308b7fd6a6d584c63d")}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def parse(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "Duplicate JSON key")
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False, "Nonfinite JSON"))


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected), "Unknown/missing profile fields")


def profile(value):
    keys(value, ("schemaVersion", "mode", "assembly", "pins"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1, "Profile schema")
    require(value["mode"] in ("pages", "migration-cancel"), "Migration approval is unfinished; mode refused")
    keys(value["assembly"], ("sourceCommit", "runId", "runAttempt", "jobId", "artifactId", "zipBytes", "zipSha256"))
    a = value["assembly"]
    require(type(a["sourceCommit"]) is str and re.fullmatch(r"[a-f0-9]{40}", a["sourceCommit"]), "Assembly source")
    for key in ("runId", "runAttempt", "jobId", "artifactId", "zipBytes"):
        require(type(a[key]) is int and 0 < a[key] < 2**53, "Assembly API integer")
    require(a["zipBytes"] <= 300 * 1024 * 1024 and type(a["zipSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", a["zipSha256"]), "Archive bound/pin")
    keys(value["pins"], PINS)
    for pin in value["pins"].values():
        keys(pin, ("size", "sha256"))
        require(type(pin["size"]) is int and 0 < pin["size"] <= 256 * 1024 * 1024
                and type(pin["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]), "File pin")
    return value


def admission(env):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
                "GITHUB_REF": BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "CREATOR_NATIVE_LINUX_016": "1"}
    require(sys.platform == "linux" and os.getuid() > 0 and all(env.get(k) == v for k, v in expected.items()), "Exact unprivileged disposable 016 context required")
    require(not any(k.startswith(("LD_", "DYLD_", "WEBKIT_", "TAURI_")) or k in ("PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "SSL_CERT_FILE", "SSL_CERT_DIR") for k in env), "Injected runtime refused")
    require(not any(env.get(k) for k in ("FLATPAK_ID", "APPIMAGE", "APPDIR")), "Native DEB only")


def exact(raw, pin):
    require(len(raw) == pin["size"] and digest(raw) == pin["sha256"], "Independent file pin differs")


def write(file, raw, mode=0o600):
    with file.open("xb") as stream:
        os.chmod(file, mode)
        stream.write(raw)


def safe_name(raw):
    require(type(raw) is str and 0 < len(raw) <= 240 and not raw.startswith("/") and "\\" not in raw and ":" not in raw
            and not any(ord(c) < 32 or ord(c) == 127 for c in raw)
            and all(p not in ("", ".", "..") for p in raw.rstrip("/").split("/")), "Unsafe archive name")


def stage_zip(file, target, p):
    raw = file.read_bytes()
    require(len(raw) == p["assembly"]["zipBytes"] and digest(raw) == p["assembly"]["zipSha256"], "Original ZIP differs")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = set()
        rows = archive.infolist()
        require(0 < len(rows) <= 128 and sum(r.file_size for r in rows) <= 1024 * 1024 * 1024, "ZIP inventory bound")
        for row in rows:
            safe_name(row.filename)
            require(row.filename not in names and not row.flag_bits & 1 and 0 <= row.file_size <= 256 * 1024 * 1024
                    and stat.S_IFMT(row.external_attr >> 16) in (0, stat.S_IFDIR, stat.S_IFREG), "ZIP duplicate/link/size")
            names.add(row.filename)
        require(set(MEMBERS.values()) <= names, "Missing selected resources")
        for key, name in MEMBERS.items():
            row = archive.getinfo(name)
            require(not row.is_dir() and row.file_size == p["pins"][key]["size"], "ZIP member size")
            data = archive.read(row); exact(data, p["pins"][key])
            write(target / (key + (".deb" if key == "deb" else ".bin")), data)


def receipt(value, p):
    require(value["schemaVersion"] == 1 and value["product"] == "com.creatorworks.hub.unix-signed-assembly"
            and value["platform"] == "linux" and value["arch"] == "x86_64" and value["hubVersion"] == "0.1.16"
            and value["assemblyCommit"] == p["assembly"]["sourceCommit"], "Assembly receipt target/source")
    private = value["privateSource"]
    require(private["sourceCommit"] == PRIVATE_SOURCE and private["runId"] == 39326776585 and private["runAttempt"] == 1,
            "Private payload receipt differs")
    require(value["privateModulesRecompiled"] is False and value["privateModulesResigned"] is False
            and value["nativeGuiAccepted"] is False and value["releaseReady"] is False and value["mcpMode"] == "writable", "Receipt is not build-only")
    features = value["compiledFeatures"]
    require(type(features) is list and len(set(features)) == len(features)
            and {"integrated-features", "experimental-linux-migration", "experimental-flatpak-host"} <= set(features), "Missing direct/native features")


def modules(stream, manifest):
    binding = manifest["payloadArchive"]
    require(binding["schemaVersion"] == 1 and binding["file"] == "modules.tar.gz", "Module archive binding")
    hashes = {}
    for files in (manifest["modules"]["mcp"]["files"], manifest["modules"]["setup"]["files"], manifest["managedRouting"]["files"]):
        require(type(files) is dict and not set(files).intersection(hashes), "Colliding resource maps")
        hashes.update(files)
    require(set(binding["files"]) == set(hashes) and 0 < len(hashes) <= 64, "Incomplete resource map")
    for name, value in binding["files"].items():
        safe_name(name); keys(value, ("size", "mode"))
        require(type(value["size"]) is int and 0 <= value["size"] <= 256 * 1024 * 1024
                and type(value["mode"]) is int and value["mode"] in (0o644, 0o755)
                and type(hashes[name]) is str and re.fullmatch(r"[a-f0-9]{64}", hashes[name]), "Invalid resource pin")
    total, seen = 0, set()
    with gzip.GzipFile(fileobj=stream, mode="rb") as decoded, tarfile.open(fileobj=decoded, mode="r|") as archive:
        for row in archive:
            name = row.name; safe_name(name)
            require(row.isfile() and name in hashes and name not in seen and row.uid == row.gid == 0, "Unlisted/duplicate/nonregular resource")
            expected = binding["files"][name]
            require(type(row.size) is int and 0 <= row.size <= 256 * 1024 * 1024 and row.size == expected["size"]
                    and row.mode == expected["mode"] and row.mode in (0o644, 0o755), "Resource size/mode")
            total += row.size; require(total <= 512 * 1024 * 1024, "Resource total bound")
            h, count = hashlib.sha256(), 0
            member = archive.extractfile(row)
            while block := member.read(65536):
                h.update(block); count += len(block)
            require(count == row.size and h.hexdigest() == hashes[name], "Raw module digest differs")
            seen.add(name)
        # tarfile normally ignores bytes after its first end marker. Drain its
        # buffered stream to validate gzip CRCs and reject hidden trailing data.
        tail = archive.fileobj.read(1024 * 1024 + 1)
        require(len(tail) <= 1024 * 1024 and not any(tail), "Hidden/oversized trailing module data")
    require(seen == set(hashes) and total == binding["unpackedSize"] and "mcp/server/creator-works-mcp.mjs" in seen, "Incomplete modules")
    return hashes


def deb_records(file):
    # dpkg-deb only decodes, never invokes a package or its maintainer scripts.
    result = subprocess.run(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(file)], capture_output=True, timeout=120, check=True,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"})
    require(not result.stderr and len(result.stdout) <= 512 * 1024 * 1024, "DEB decode bound")
    return result.stdout


def inspect_deb(raw, p, manifest_raw, manifest):
    expected = {name: p["pins"][key] for key, name in DEB_MEMBERS.items()}
    found, all_files, hub = {}, {}, None
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for row in archive:
            name = row.name.removeprefix("./").rstrip("/")
            if name in ("", "."):
                require(row.isdir(), "DEB root type"); continue
            safe_name(name)
            require(row.uid == row.gid == 0 and (row.isdir() or row.isfile()) and not row.mode & 0o7022, "DEB ownership/type/mode")
            if row.isdir():
                continue
            require(name not in all_files and not name.startswith("etc/") and row.size <= 256 * 1024 * 1024, "Unknown system override/duplicate/bound")
            data = archive.extractfile(row).read(); require(len(data) == row.size, "Truncated package resource")
            all_files[name] = {"size": len(data), "sha256": digest(data), "mode": row.mode}
            if name in expected:
                exact(data, expected[name]); found[name] = all_files[name]
                if name == DEB_MEMBERS["hub"]:
                    require(data[:6] == b"\x7fELF\x02\x01" and manifest_raw in data, "ELF/embedded manifest differs"); hub = data
            require(not row.mode & 0o111 or name in (DEB_MEMBERS["hub"], DEB_MEMBERS["helper"]), "Unexpected executable outside opaque modules")
    require(set(found) == set(expected) and hub is not None, "Missing installed package resources")
    return all_files


def main():
    admission(os.environ)
    require(sys.argv[1:] == [], "No path/phase overrides")
    temp = Path(os.environ["RUNNER_TEMP"]); require(temp.resolve() == temp, "Redirected runner temp")
    incoming, output = temp / "native-linux-016-input", temp / "native-linux-016-stage"
    directory = incoming.lstat()
    require(incoming.resolve() == incoming and stat.S_ISDIR(directory.st_mode) and directory.st_uid == os.getuid()
            and stat.S_IMODE(directory.st_mode) == 0o700, "Unprotected input directory")
    for name in ("profile.json", "api-binding.json", "assembly.zip", "mcp.deb", "setup.deb"):
        file = incoming / name; row = file.lstat()
        require(file.resolve() == file and stat.S_ISREG(row.st_mode) and row.st_nlink == 1
                and row.st_uid == os.getuid() and stat.S_IMODE(row.st_mode) == 0o600, "Redirected/unprotected input")
    p = profile(parse((incoming / "profile.json").read_bytes()))
    api = parse((incoming / "api-binding.json").read_bytes())
    require(api["assembly"] == p["assembly"] and api["harnessSource"] == os.environ["GITHUB_SHA"]
            and api["privatePayload"] == {"sourceCommit": PRIVATE_SOURCE, "runId": 39326776585, "runAttempt": 1}, "API provenance differs")
    output.mkdir(mode=0o700); stage_zip(incoming / "assembly.zip", output, p)
    receipt(parse((output / "assemblyReceipt.bin").read_bytes()), p)
    manifest_raw = (output / "manifest.bin").read_bytes(); manifest = parse(manifest_raw)
    require(manifest["platform"] == "linux" and manifest["arch"] == "x86_64", "Wrong resource platform")
    archive = (output / "modulesArchive.bin").read_bytes()
    require(len(archive) == manifest["payloadArchive"]["size"] and digest(archive) == manifest["payloadArchive"]["sha256"], "Manifest archive digest")
    hashes = modules(io.BytesIO(archive), manifest)
    spec = importlib.util.spec_from_file_location("verify_016_deb", HERE / "linux-retirement-package-verify.py")
    verifier = importlib.util.module_from_spec(spec); spec.loader.exec_module(verifier)
    verifier.verify(str(output / "deb.deb"), p["pins"]["helper"]["sha256"], p["pins"]["policy"]["sha256"], "0.1.16", "integrated-candidate")
    records = inspect_deb(deb_records(output / "deb.deb"), p, manifest_raw, manifest)
    integrity = parse((output / "packageIntegrity.bin").read_bytes())
    require(integrity["integrityPassed"] is True and integrity["releaseReady"] is False and len(integrity["packages"]) == 1, "Package integrity receipt")
    package = integrity["packages"][0]
    require(package["format"] == "deb" and package["path"] == MEMBERS["deb"] and package["sha256"] == p["pins"]["deb"]["sha256"]
            and package["hubSha256"] == p["pins"]["hub"]["sha256"] and package["files"] == hashes, "Receipt and DEB/resources disagree")
    for product, (size, sha) in LEGACY.items():
        data = (incoming / (product + ".deb")).read_bytes(); exact(data, {"size": size, "sha256": sha})
    write(output / "binding.json", json.dumps({"schemaVersion": 1, "profile": p, "api": api, "packageFiles": records,
          "releaseReady": False}).encode())
    print(json.dumps({"staged": True, "resourcesVerified": len(hashes), "nativeExecution": False, "releaseReady": False}))


if __name__ == "__main__":
    main()
