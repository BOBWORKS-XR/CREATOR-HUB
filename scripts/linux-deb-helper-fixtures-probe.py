"""Unprivileged disposable fixture capture only; never install a package or helper."""
import ast
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
EXPECTED = {
    "CREATOR_LINUX_DEB_HELPER_FIXTURES": "1", "GITHUB_ACTIONS": "true",
    "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
    "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
    "GITHUB_REF": "refs/heads/validation/linux-deb-helper-fixtures-014", "GITHUB_EVENT_NAME": "push",
}
GATES = (
    "productionIntegrated", "privilegedHelperAccepted", "nativeTransactionAccepted",
    "nativeApprovalAccepted", "actualUserAuthenticationAccepted", "nativeCancellationAccepted",
    "guiIdleCloseAccepted", "runtimeRetentionAccepted", "packageGuiRetirementAccepted",
    "recoveryAccepted", "migrationAccepted", "setupTransitionAccepted", "flatpakAccepted",
    "signedUpdateAccepted", "restartAccepted", "releaseReady",
)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def admission(env, system, machine, uid):
    require(system == "Linux" and machine == "x86_64" and uid > 0,
            "Unprivileged native Linux x86_64 required")
    require(all(env.get(k) == v for k, v in EXPECTED.items()),
            "Exact opted-in disposable repository/id/branch/push required")
    require(not any(env.get(k) for k in ("FLATPAK_ID", "APPIMAGE", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH")),
            "Sandbox or injected loader environment refused")


def initial_report(source):
    return {"schemaVersion": 1, "scope": "unprivileged helper fixtures only",
            "sourceRevision": source, "fixtureChecksPassed": False,
            "productionGates": dict.fromkeys(GATES, False), "commands": []}


def capture(root, report, label, argv):
    record = {"label": label, "argv": argv, "exitCode": None,
              "stdout": label + ".stdout", "stderr": label + ".stderr"}
    report["commands"].append(record)
    with (root / record["stdout"]).open("xb") as out, (root / record["stderr"]).open("xb") as err:
        result = subprocess.run(argv, cwd=REPO, env={**os.environ, "LC_ALL": "C", "LANG": "C"},
                                stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=720, check=False)
        record["exitCode"] = result.returncode
    print(label + ": exit " + str(result.returncode), flush=True)
    require(result.returncode == 0, "Fixture command failed: " + label + "; original output retained")


def run(root, report):
    # Parse only before running tests, version tools, Rust or native fixtures.
    for name in ("linux-deb-helper-fixtures-probe.py", "linux-deb-helper-fixtures.test.py"):
        ast.parse((REPO / "scripts" / name).read_text(encoding="utf-8"), filename=name)
    kernel = REPO / "native/linux-deb-retirement/tests/gui-writer-kernel.py"
    ast.parse(kernel.read_text(encoding="utf-8"), filename=str(kernel))
    capture(root, report, "syntax-shell", ["/bin/bash", "-n", "scripts/linux-deb-helper-native-check.sh"])
    capture(root, report, "syntax-node", ["node", "--check", "scripts/linux-deb-helper.test.cjs"])
    capture(root, report, "pure-preflight", [sys.executable, "-B", "scripts/linux-deb-helper-fixtures.test.py"])
    capture(root, report, "source", ["git", "rev-parse", "HEAD"])
    require((root / "source.stdout").read_text().strip() == report["sourceRevision"], "Checkout/source SHA mismatch")
    report["osRelease"] = Path("/etc/os-release").read_text(encoding="utf-8")
    report["kernel"] = platform.release()
    report["uid"] = os.getuid()
    report["rustToolchainConfig"] = (REPO / "rust-toolchain.toml").read_text(encoding="utf-8")
    for label, argv in (
        ("dpkg-version", ["/usr/bin/dpkg", "--version"]),
        ("rust-version", ["rustc", "--version", "--verbose"]),
        ("cargo-version", ["cargo", "--version", "--verbose"]),
        ("node-version", ["node", "--version"]),
        ("python-version", [sys.executable, "--version"]),
    ):
        capture(root, report, label, argv)
        report[label] = (root / (label + ".stdout")).read_text(encoding="utf-8").strip()
    capture(root, report, "native-fixtures", ["/bin/bash", "scripts/linux-deb-helper-native-check.sh"])
    report["fixtureChecksPassed"] = True


def main():
    admission(os.environ, platform.system(), platform.machine(), os.getuid())
    require(len(sys.argv) == 1, "No arguments supported")
    source = os.environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", source), "Exact source revision required")
    parent = Path(os.environ["RUNNER_TEMP"])
    require(parent.is_absolute() and parent.resolve(strict=True) == parent, "Ordinary absolute runner temp required")
    root = parent / "linux-deb-helper-fixtures"
    root.mkdir(mode=0o700)
    report = initial_report(source)
    report["run"] = {"id": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
                     "repository": os.environ["GITHUB_REPOSITORY"], "ref": os.environ["GITHUB_REF"]}
    try:
        run(root, report)
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        (root / "result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
