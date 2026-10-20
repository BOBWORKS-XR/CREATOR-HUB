#!/usr/bin/env python3
"""Owned executable kernel proof only: no package/helper/GUI acceptance."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tempfile
import time


def fingerprint(fd):
    meta = os.fstat(fd)
    return {
        "dev": meta.st_dev, "ino": meta.st_ino, "bytes": meta.st_size,
        "mode": meta.st_mode, "uid": meta.st_uid, "gid": meta.st_gid,
        "mtimeNs": meta.st_mtime_ns,
        "sha256": hashlib.sha256(os.pread(fd, meta.st_size, 0)).hexdigest(),
    }


def busy(action):
    try:
        result = action()
    except OSError as error:
        assert error.errno == errno.ETXTBSY, error
        return error.errno
    if isinstance(result, int):
        os.close(result)
    elif isinstance(result, subprocess.Popen):
        if result.stdin:
            result.stdin.close()
        result.wait()
    raise AssertionError("Expected ETXTBSY")


def proof():
    assert platform.system() == "Linux", "Native Linux only"
    # TemporaryDirectory creates an exclusive 0700 root. Only these owned files
    # are removed, and every child gets EOF rather than a signal.
    with tempfile.TemporaryDirectory(prefix="creator-gui-writer-") as root:
        assert os.stat(root).st_mode & 0o777 == 0o700
        path = os.path.join(root, "owned-cat")
        shutil.copyfile("/bin/cat", path)
        os.chmod(path, 0o755)
        read_fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        writer = None
        child = None
        try:
            baseline = fingerprint(read_fd)
            child = subprocess.Popen([path], stdin=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL)
            deadline = time.monotonic() + 3
            while True:
                actual = os.stat(f"/proc/{child.pid}/exe")
                if (actual.st_dev, actual.st_ino) == (baseline["dev"], baseline["ino"]):
                    break
                assert child.poll() is None and time.monotonic() < deadline
            flags = os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
            running_errno = busy(lambda: os.open(path, flags))
            assert fingerprint(read_fd) == baseline
            child.stdin.close()
            assert child.wait(timeout=5) == 0
            child = None
            writer = os.open(path, flags)  # No create/truncate/write.
            assert os.fstat(writer).st_ino == baseline["ino"]
            assert os.fstat(writer).st_dev == baseline["dev"]
            assert fcntl.fcntl(writer, fcntl.F_GETFD) & fcntl.FD_CLOEXEC
            assert fcntl.fcntl(writer, fcntl.F_GETFL) & os.O_ACCMODE == os.O_WRONLY
            held_meta = os.fstat(read_fd)

            def launch(name):
                return subprocess.Popen([name], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, pass_fds=(read_fd,))

            held_errno = busy(lambda: launch(path))
            assert os.fstat(read_fd).st_ctime_ns == held_meta.st_ctime_ns
            assert fingerprint(read_fd) == baseline
            renamed = os.path.join(root, "renamed-cat")
            os.rename(path, renamed)
            renamed_errno = busy(lambda: launch(renamed))
            os.unlink(renamed)
            deleted = f"/proc/self/fd/{read_fd}"
            deleted_errno = busy(lambda: launch(deleted))
            assert fingerprint(read_fd) == baseline
            os.close(writer)
            writer = None
            assert launch(deleted).wait(timeout=5) == 0
            assert fingerprint(read_fd) == baseline
            return {"passed": True, "kernel": platform.release(),
                    "scope": "owned-executable-kernel-only", "baseline": baseline,
                    "runningImageWriteOpenErrno": running_errno,
                    "heldWriteOpenExecErrno": held_errno,
                    "renamedImageExecErrno": renamed_errno,
                    "deletedImageExecErrno": deleted_errno,
                    "bytesModesPreserved": True, "normalExecAfterCloseExitCode": 0,
                    "allOwnChildrenExitedNormally": True,
                    "dpkgRetirementAccepted": False, "nativeMigrationAccepted": False}
        finally:
            if child is not None:
                child.stdin.close()
                child.wait(timeout=5)
            if writer is not None:
                os.close(writer)
            os.close(read_fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt")
    args = parser.parse_args()
    result = json.dumps(proof(), sort_keys=True) + "\n"
    if args.receipt:
        fd = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as receipt:
            receipt.write(result)
    print(result, end="")
