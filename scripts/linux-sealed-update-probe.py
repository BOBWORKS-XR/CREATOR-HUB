"""Disposable proof of a sealed package handoff, not a production updater."""
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import time


PACKAGE = "creator-hub-sealed-update-probe"
ACTION = "org.creatorworks.hub.disposable-sealed-update-probe"
POLICY = Path("/usr/share/polkit-1/actions/" + ACTION + ".policy")
DEST = Path("/usr/share/creator-hub-sealed-update-probe/fixture.txt")
CONTENT = b"Creator Hub disposable sealed package probe\n"
PKEXEC_ARGS = ["/usr/bin/pkexec", "--disable-internal-agent", "/usr/bin/dpkg", "--install", "/proc/self/fd/0"]


def policy_xml():
    # polkit 0.105 uses action XML, not the newer JavaScript rule backend.
    # This disposable no-auth policy grants dpkg, not argument-level authority.
    # It must never be packaged, copied to a user PC, or counted as auth proof.
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<policyconfig>
  <vendor>Creator Hub disposable test only</vendor>
  <action id="{ACTION}">
    <description>Disposable sealed package mechanism test</description>
    <message>Disposable runner only; never install this policy on a user PC</message>
    <defaults><allow_any>yes</allow_any><allow_inactive>yes</allow_inactive><allow_active>yes</allow_active></defaults>
    <annotate key="org.freedesktop.policykit.exec.path">/usr/bin/dpkg</annotate>
  </action>
</policyconfig>
'''


def require(value, message):
    if not value:
        raise RuntimeError(message)


def admission(env, system, machine, uid):
    require(system == "Linux" and machine == "x86_64" and uid > 0,
            "Unprivileged native Linux x86_64 required")
    expected = {"CREATOR_LINUX_SEALED_UPDATE_PROBE": "1", "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB", "GITHUB_REPOSITORY_ID": "1364807512",
                "GITHUB_REF": "refs/heads/validation/linux-sealed-update-014"}
    require(all(env.get(key) == value for key, value in expected.items()),
            "Opted-in exact disposable workflow required")
    require(not any(env.get(key) for key in ("FLATPAK_ID", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH")),
            "Sandbox or injected loader environment refused")


def command(args, env, stdin=None, accepted=(0,)):
    result = subprocess.run(args, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, cwd="/", timeout=90, check=False)
    require(len(result.stdout) <= 32768 and len(result.stderr) <= 32768, "Command output exceeded bound")
    record = {"argv": args, "exitCode": result.returncode,
              "stdout": result.stdout.decode("utf-8", "replace"),
              "stderr": result.stderr.decode("utf-8", "replace")}
    require(result.returncode in accepted, "Native command refused: " + json.dumps(record))
    return record


def sealed_package(body):
    import fcntl
    flags = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    fd = os.memfd_create("creator-hub-update-probe", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    stream = os.fdopen(fd, "w+b")
    try:
        require(stream.write(body) == len(body), "Incomplete sealed package write")
        stream.flush()
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, flags)
        require(fcntl.fcntl(fd, fcntl.F_GET_SEALS) == flags, "Incomplete kernel seals")
        for mutate in (lambda: os.pwrite(fd, b"X", 0), lambda: os.ftruncate(fd, 1),
                       lambda: os.ftruncate(fd, len(body) + 1)):
            try:
                mutate()
            except OSError as error:
                require(error.errno == errno.EPERM, "Unexpected mutation failure")
            else:
                raise RuntimeError("Sealed package was mutable")
        stream.seek(0)
        require(stream.read() == body, "Sealed package bytes changed")
        stream.seek(0)
        return stream
    except BaseException:
        stream.close()
        raise


def protected_tool(path):
    actual = path.resolve(strict=True)
    for item in [actual, *actual.parents]:
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "Unprotected system tool path")
    require(stat.S_ISREG(actual.stat().st_mode) and os.access(actual, os.X_OK), "Executable system tool required")


def run(root, report):
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
    for path in (Path("/usr/bin/pkexec"), Path("/usr/bin/dpkg"), Path("/usr/bin/dpkg-deb")):
        protected_tool(path)
    require(not DEST.exists(), "Fixture destination already exists")
    report["pkexecVersion"] = command(["/usr/bin/pkexec", "--version"], env)
    report["dpkgVersion"] = command(["/usr/bin/dpkg", "--version"], env)
    absent = command(["/usr/bin/dpkg-query", "--show", "--showformat=${db:Status-Status}", PACKAGE], env, accepted=(0, 1))
    require(absent["exitCode"] == 1, "Fixture package already registered")
    require(POLICY.parent.is_dir() and not POLICY.exists(), "Test action directory missing or action already exists")
    policy = root / "fixture.policy"
    policy.write_text(policy_xml(), encoding="ascii")
    try:
        report["policyInstall"] = command(["/usr/bin/sudo", "--non-interactive", "/usr/bin/install", "-o", "root", "-g", "root", "-m", "0644", str(policy), str(POLICY)], env)
        deadline = time.monotonic() + 10
        while True:
            ready = command(["/usr/bin/pkaction", "--action-id", ACTION, "--verbose"], env, accepted=(0, 1))
            if ready["exitCode"] == 0 and ACTION in ready["stdout"]:
                report["policyObserved"] = ready
                break
            require(time.monotonic() < deadline, "Test-only action was not observed by polkit")
            time.sleep(0.05)
        package = root / "package"
        control = package / "DEBIAN"
        control.mkdir(parents=True, mode=0o755)
        (control / "control").write_text(f"Package: {PACKAGE}\nVersion: 0.0.1\nArchitecture: all\nMaintainer: Disposable test <test@example.invalid>\nDescription: Sealed package handoff fixture only\n", encoding="ascii")
        data = package / "usr/share" / PACKAGE
        data.mkdir(parents=True, mode=0o755)
        (data / "fixture.txt").write_bytes(CONTENT)
        deb = root / "fixture.deb"
        report["build"] = command(["/usr/bin/dpkg-deb", "--root-owner-group", "--build", str(package), str(deb)], env)
        body = deb.read_bytes()
        require(0 < len(body) < 1024 * 1024, "Unexpected fixture package size")
        report["input"] = {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        with sealed_package(body) as stream:
            # Removing the original proves the privileged command cannot reopen it.
            deb.unlink()
            report["originalRemovedBeforePrivilege"] = True
            report["kernelSeals"] = 15
            report["mutationAttemptsRefused"] = 3
            report["install"] = command(PKEXEC_ARGS, env, stdin=stream)
            stream.seek(0)
            require(stream.read() == body, "Privileged command changed sealed bytes")
        require(DEST.read_bytes() == CONTENT, "Installed fixture content differs")
        report["installed"] = command(["/usr/bin/dpkg-query", "--show", "--showformat=${Package} ${Version} ${Architecture} ${db:Status-Status}", PACKAGE], env)
        require(report["installed"]["stdout"] == PACKAGE + " 0.0.1 all installed", "Installed package identity differs")
        report["mechanismPassed"] = True
    finally:
        # Never ship this permissive fixture policy or retain it after the probe.
        report["policyRemove"] = command(["/usr/bin/sudo", "--non-interactive", "/usr/bin/rm", "--force", "--", str(POLICY)], env)
        require(not POLICY.exists(), "Test authorization policy remained")


def main():
    admission(os.environ, platform.system(), platform.machine(), os.getuid())
    require(len(sys.argv) == 1 and os.environ.get("USER") == "runner", "Exact runner invocation required")
    parent = Path(os.environ["RUNNER_TEMP"])
    require(parent.is_absolute() and parent.resolve(strict=True) == parent, "Ordinary absolute runner temp required")
    root = parent / "linux-sealed-update-probe"
    root.mkdir(mode=0o700)
    report = {"schemaVersion": 1, "source": os.environ.get("GITHUB_SHA"),
              "mechanismPassed": False, "testOnlyAuthorization": True,
              "actualUserAuthenticationAccepted": False, "cancellationAccepted": False,
              "signedUpdateAccepted": False, "restartAccepted": False, "releaseReady": False}
    try:
        run(root, report)
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        (root / "result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
