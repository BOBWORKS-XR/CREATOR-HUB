"""Exact Setup transaction fixture in the pinned disposable MCP helper container.

No native consent/authentication, installed-user settings or release acceptance.
Only finite test phases are accepted; no path or package arguments are admitted.
"""
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("mcp_helper_fixture", Path(__file__).with_name("linux-deb-helper-transaction-probe.py"))
base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)
require = base.require
PACKAGE = "creator-project-setup"
ASSET = "Creator.Project.Setup_0.3.7_amd64.deb"
OLD = "0.3.7"
NEW = "0.3.7-1+hub.retention014.1"
PRIVATE = "/var/lib/creator-hub-deb-retirement-setup"
NOTICE = "usr/share/doc/creator-project-setup/retired-by-creator-hub.txt"
NOTICE_SHA = "a78a28ee51d81f81ae96c18c47fef7e66034262a59c9d189497c6e39043f5307"
PACKAGE_SHA = "be18f23450146e71a2960e2110474f6e0409a9521a3ced308b7fd6a6d584c63d"
FILES = {
    "usr/bin/creator-project-setup": (20899824, 0o755, "f9c3a25c062b68cafed0c46b762532bed72127635015587324119a02d63b2944"),
    "usr/share/applications/Creator Project Setup.desktop": (255, 0o644, "2e1476333e1463aef76b9117dfde1c980829b1a76952f25717a6ce303bd087db"),
    "usr/share/icons/hicolor/32x32/apps/creator-project-setup.png": (1533, 0o644, "cd24c1c5d53c558422571b466b6f1950ea0ddca76e1e3de9330fb00a5a174e10"),
    "usr/share/icons/hicolor/256x256@2/apps/creator-project-setup.png": (14336, 0o644, "840d17fe62d8d5230cc9a3611f6e2492f9f9e29bdb6c7c278f762d4d9774f712"),
    "usr/share/icons/hicolor/128x128/apps/creator-project-setup.png": (6966, 0o644, "cff3b008e6e0379beee23305e683a00ce0013a73cbb7b6a445cdc73217b3ecbe"),
}
RETIRE = ["/usr/bin/sudo", "-n", base.HELPER, "retire-setup-0.3.7"]


def helper_result(code, out, err, repeat=False):
    require(not err, "Unexpected Setup helper stderr; retain original capture")
    value = json.loads(out)
    require(value.get("experimentalTransactionCompiled") is True and value.get("installationEnabled") is False
            and value.get("nativeAcceptance") is False, "Experimental-only Setup report required")
    if repeat:
        require(code == 2 and value.get("status") == "manual-repair-required"
                and value.get("manualRepairRequired") is True and value.get("packageTransactionStarted") is None
                and value.get("packageTransactionMayHaveStarted") is True
                and "An earlier transaction attempt is recorded" in value.get("reason", ""),
                "Setup repeat must refuse at its own prior attempt marker")
    else:
        require(code == 0 and value.get("status") == "experimental-transaction-verified"
                and value.get("product") == "setup" and value.get("package") == PACKAGE
                and value.get("version") == NEW and value.get("packageTransactionStarted") is True
                and value.get("manualRepairRequired") is False and value.get("retainedFilesVerified") == 0
                and value.get("omittedFilesVerified") == 5 and value.get("tombstoneFilesVerified") == 1
                and value.get("retryPolicy") == "attempt marker retained; no automatic retry",
                "Setup transaction did not verify; no retry permitted")
        require(re.fullmatch(re.escape(PRIVATE) + r"/setup-0\.3\.7-preparation-[0-9a-f]{32}/gui-tombstone\.deb",
                             value.get("candidate", "")), "Unexpected protected Setup candidate")
    return value


def package_paths(files, compatibility):
    paths = {"/."} if compatibility else set()
    for name in files:
        current = PurePosixPath("/" + name)
        while current != PurePosixPath("/"):
            paths.add(str(current))
            current = current.parent
    return paths


class SetupProbe(base.Probe):
    def __init__(self):
        super().__init__()
        base.container_admission(os.environ, os.getuid(), os.geteuid(), Path("/.dockerenv").is_file())
        self.root = self.root / "setup"
        self.root.mkdir(mode=0o700, exist_ok=True)
        info = self.root.lstat()
        require(stat.S_ISDIR(info.st_mode) and self.root.resolve() == self.root
                and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "Private owned Setup fixture directory required")
        self.old = Path(os.environ["RUNNER_TEMP"]) / "linux-setup-helper-transaction-input" / ASSET

    def inspect(self, phase, retained=False):
        action = "inspect-retained-setup-0.3.7" if retained else "inspect-setup-0.3.7"
        code, out, err = self.command(phase + "-inspect", [base.HELPER, action])
        value = json.loads(out)
        require(code == 0 and not err and value.get("product") == "setup" and value.get("package") == PACKAGE
                and value.get("readOnly") is True and value.get("snapshotAuthoritative") is False
                and value.get("installationEnabled") is False and value.get("nativeAcceptance") is False
                and value.get("packageTransactionStarted") is False and value.get("experimentalTransactionCompiled") is True,
                "Unknown Setup inspection protocol")
        if retained:
            require(value.get("status") == "inspected-retained-read-only" and value.get("packageState") == "compatibility"
                    and value.get("version") == NEW and value.get("baselineMatches") is False
                    and value.get("compatibilityMatches") is True and value.get("tombstoneFilesVerified") == 1
                    and value.get("omittedFilesVerified") == 5, "Independent retained Setup inspection failed")
        return self.save(phase + "-inspection", value)

    def prepare(self):
        original = base.fixture.fingerprint(self.old)
        require((original["bytes"], original["sha256"]) == (5966970, PACKAGE_SHA), "Exact public Setup DEB required")
        raw = self.command("original-control", ["/usr/bin/dpkg-deb", "--ctrl-tarfile", str(self.old)])[1]
        controls = {}
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for member in archive:
                name = base.fixture.member_name(member.name)
                if member.isdir() and not name:
                    continue
                require(member.isfile() and name in ("control", "md5sums") and name not in controls,
                        "Unexpected Setup scripts or control members")
                require(member.size <= 16384, "Oversized Setup control")
                controls[name] = archive.extractfile(member).read()
        require(set(controls) == {"control", "md5sums"}, "Incomplete Setup controls")
        for name in controls:
            require(controls[name] == (base.REPO / "native/linux-deb-retirement/tests/fixtures" / ("setup-0.3.7." + name)).read_bytes(),
                    "Setup control differs from reviewed baseline")
        require(set(base.fixture.md5_entries(controls["md5sums"])) == set(FILES), "Setup file set differs")
        require(not os.path.lexists(PRIVATE) and not os.path.lexists("/" + NOTICE)
                and all(not os.path.lexists("/" + name) for name in FILES), "Existing Setup files refused")
        require(self.command("initial-package", ["/usr/bin/dpkg-query", "-W", "-f=${Status}", PACKAGE], allowed=(1,))[0] == 1,
                "Pre-existing Setup package refused")
        helper = base.fixture.fingerprint(Path(base.HELPER))
        require(helper["uid"] == helper["gid"] == 0 and helper["mode"] == 0o755, "Protected existing helper required")
        absent = self.inspect("absent")
        require(absent.get("packageState") == "absent" and absent.get("version") is None
                and absent.get("baselineMatches") is False and absent.get("compatibilityMatches") is False,
                "Exact absent Setup state required")
        return self.save("plan", {"original": original, "helper": helper, "productionGates": dict.fromkeys(base.GATES, False)})

    def mcp_private(self, label):
        listing = self.command(label, ["/usr/bin/sudo", "-n", "/usr/bin/find", base.PRIVATE, "-xdev", "-maxdepth", "3",
                                      "-printf", "%y %m %U %G %s %p\n"])[1]
        marker = self.command(label + "-marker", ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", base.PRIVATE + "/transaction-attempted"])[1]
        if label != "mcp-private-before":
            require(listing == (self.root / "mcp-private-before.stdout").read_bytes()
                    and marker == (self.root / "mcp-private-before-marker.stdout").read_bytes(),
                    "Setup transaction changed MCP recovery state")

    def unchanged_helper(self):
        plan = json.loads((self.root / "plan.json").read_text())
        require(base.fixture.fingerprint(Path(base.HELPER)) == plan["helper"], "Helper changed between product transactions")

    def install(self):
        self.unchanged_helper()
        require(base.fixture.fingerprint(self.old) == json.loads((self.root / "plan.json").read_text())["original"], "Setup input changed")
        self.command("install-public-baseline", ["/usr/bin/sudo", "-n", "/usr/bin/dpkg", "--install", str(self.old)], timeout=None)
        return self.save("installed", {"fixtureBaselineInstalled": True, "nativeAcceptance": False})

    def snapshot(self, phase):
        self.unchanged_helper()
        compatibility = phase != "before"
        version = NEW if compatibility else OLD
        expected = {NOTICE: (200, 0o644, NOTICE_SHA)} if compatibility else FILES
        state = self.command(phase + "-state", ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", PACKAGE])[1]
        require(state == f"{PACKAGE}\t{version}\tamd64\tinstall ok installed\n".encode(), "Setup package state differs")
        listing = self.command(phase + "-list", ["/usr/bin/dpkg-query", "-L", PACKAGE])[1].decode().splitlines()
        require(len(listing) == len(set(listing)) and set(listing) == package_paths(expected, compatibility), "Complete Setup file list differs")
        files = {}
        for index, (name, (size, mode, digest)) in enumerate(expected.items()):
            observed = base.fixture.fingerprint(Path("/" + name))
            require((observed["bytes"], observed["mode"], observed["sha256"], observed["uid"], observed["gid"])
                    == (size, mode, digest, 0, 0), "Setup installed file differs: " + name)
            owner = self.command(phase + "-owner-" + str(index), ["/usr/bin/dpkg-query", "-S", "/" + name])[1]
            require(owner == f"{PACKAGE}: /{name}\n".encode(), "Nonexclusive Setup file ownership")
            files[name] = observed
        if compatibility:
            self.mcp_private(phase + "-mcp-private")
            for index, name in enumerate(FILES):
                require(not os.path.lexists("/" + name), "Omitted Setup GUI still exists")
                require(not self.command(phase + "-omitted-" + str(index), ["/usr/bin/dpkg-query", "-S", "/" + name], allowed=(1,))[1], "Omitted Setup ownership remains")
        inspected = self.inspect(phase, retained=compatibility)
        if not compatibility:
            require(inspected.get("packageState") == "original" and inspected.get("version") == OLD
                    and inspected.get("baselineMatches") is True and inspected.get("compatibilityMatches") is False,
                    "Exact original Setup inspection required")
        for label, args in (("audit", ["--audit"]), ("verify", ["--verify", PACKAGE])):
            _, out, err = self.command(phase + "-" + label, ["/usr/bin/dpkg", *args])
            require(not out and not err, "Setup dpkg health check not clean")
        return self.save(phase, {"files": files, "version": version, "cleanDpkgState": True})

    def retire(self):
        require((self.root / "before.json").is_file(), "Verified Setup baseline snapshot required")
        self.unchanged_helper()
        self.mcp_private("mcp-private-before")
        return self.save("retire", helper_result(*self.command("retire-helper", RETIRE, allowed=(0, 2), timeout=None)))

    def repeat(self):
        require((self.root / "after.json").is_file(), "Only verified Setup success permits a negative repeat test")
        helper_result(0, (self.root / "retire.json").read_bytes(), b"")
        args = ["/usr/bin/sudo", "-n", "/usr/bin/find", PRIVATE, "-xdev", "-maxdepth", "3", "-printf", "%y %m %U %G %s %p\n"]
        listing = self.command("repeat-private-before", args)[1]
        marker_args = ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", PRIVATE + "/transaction-attempted"]
        marker = self.command("repeat-marker-before", marker_args)[1]
        candidate = json.loads((self.root / "retire.json").read_text())["candidate"]
        require(("Stage: " + candidate + "\n").encode() in marker, "Setup marker must identify its own candidate")
        value = helper_result(*self.command("repeat-helper", RETIRE, allowed=(2,), timeout=None), repeat=True)
        require(self.command("repeat-private-after", args)[1] == listing
                and self.command("repeat-marker-after", marker_args)[1] == marker, "Setup repeat changed protected state")
        self.snapshot("after-repeat")
        return self.save("repeat", value)

    def diagnostics(self):
        # Never elevate a repository script or infer arbitrary paths from output.
        observations = {"productionGates": dict.fromkeys(base.GATES, False), "captureErrors": [], "protectedStages": []}
        def capture(label, args):
            try:
                code, out, _ = self.command(label, args, allowed=(0, 1, 2))
                require(code == 0, "Diagnostic unavailable: " + label)
                return out
            except Exception as error:
                observations["captureErrors"].append(str(error))
                return b""
        capture("final-package-state", ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}\n", PACKAGE])
        capture("final-audit", ["/usr/bin/dpkg", "--audit"])
        capture("final-verify", ["/usr/bin/dpkg", "--verify", PACKAGE])
        capture("final-package-list", ["/usr/bin/dpkg-query", "-L", PACKAGE])
        capture("final-md5sums", ["/usr/bin/cat", "/var/lib/dpkg/info/creator-project-setup.md5sums"])
        capture("final-notice-stat", ["/usr/bin/stat", "--", "/" + NOTICE])
        capture("system-path-exclusions", ["/usr/bin/cat", "/etc/dpkg/dpkg.cfg.d/excludes"])
        capture("attempt-marker", ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", PRIVATE + "/transaction-attempted"])
        listing = capture("private-stages", ["/usr/bin/sudo", "-n", "/usr/bin/find", PRIVATE, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-printf", "%f\n"])
        for index, name in enumerate(listing.decode().splitlines()):
            if index >= 4 or not re.fullmatch(r"setup-0\.3\.7-preparation-[0-9a-f]{32}", name):
                observations["captureErrors"].append("Unknown/excess Setup stage preserved")
                continue
            observations["protectedStages"].append(name)
            for filename in ("dpkg.stdout", "dpkg.stderr"):
                capture("stage-" + str(index) + "-" + filename.replace(".", "-"),
                        ["/usr/bin/sudo", "-n", "/usr/bin/cat", "--", PRIVATE + "/" + name + "/" + filename])
            capture("stage-" + str(index) + "-candidate-sha256", ["/usr/bin/sudo", "-n", "/usr/bin/sha256sum", "--", PRIVATE + "/" + name + "/gui-tombstone.deb"])
        observations["evidenceComplete"] = not observations["captureErrors"] and len(observations["protectedStages"]) == 1
        self.save("diagnostics", observations)
        if (self.root / "after.json").is_file():
            require(observations["evidenceComplete"], "Setup success lacks protected transaction diagnostics")
        return observations


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("prepare", "install", "before", "retire", "after", "repeat", "diagnostics"), "One fixed Setup fixture phase required")
    phase = sys.argv[1]
    probe = SetupProbe()
    result = probe.snapshot(phase) if phase in ("before", "after") else getattr(probe, phase)()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
