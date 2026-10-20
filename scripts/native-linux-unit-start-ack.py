"""Finite, manually admitted CI-only systemd/PAM contrast; no product authority."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

try:
    import grp
    import pwd
except ImportError:  # Pure refusal/contract tests also run on Windows.
    grp = pwd = None

BRANCH = "refs/heads/validation/native-linux-unit-start-ack"
WORKFLOW = "BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-unit-start-ack.yml@" + BRANCH
UID = 21426
CASES = (("exec-pam", "exec", "login"), ("exec-no-pam", "exec", ""), ("simple-pam", "simple", "login"))
PROPERTIES = ("Id", "LoadState", "Transient", "InvocationID", "User", "PAMName", "Type", "MainPID", "ExecMainPID",
              "ActiveState", "SubState", "Result", "TimeoutStartUSec", "TimeoutStopUSec", "RuntimeMaxUSec",
              "ExecMainCode", "ExecMainStatus", "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic")
ENVIRONMENT = ("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REF", "GITHUB_EVENT_NAME",
               "GITHUB_WORKFLOW_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE",
               "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "CREATOR_UNIT_ACK_EXECUTE")
CLEAN = {"PATH": "/usr/bin:/bin:/usr/sbin", "LANG": "C", "LC_ALL": "C"}
TOOLS = ("/usr/bin/systemctl", "/usr/bin/systemd-run", "/usr/bin/sleep", "/usr/sbin/useradd", "/usr/bin/passwd")
SLEEP_SECONDS, START_SECONDS, RUNTIME_SECONDS, STOP_SECONDS = 8, 3, 12, 2
LIMIT = 16384


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def admission(env, platform=None, uid=None):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "BOBWORKS-XR/CREATOR-HUB",
                "GITHUB_REPOSITORY_ID": "1364807512", "GITHUB_REF": BRANCH, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_WORKFLOW_REF": WORKFLOW, "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
                "RUNNER_ARCH": "X64", "CREATOR_UNIT_ACK_EXECUTE": "true"}
    require((sys.platform if platform is None else platform) == "linux"
            and (os.getuid() if uid is None else uid) == 0 and all(env.get(k) == v for k, v in expected.items()),
            "Exact opted-in hosted Linux root probe required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Exact source required")
    require(re.fullmatch(r"[1-9][0-9]{0,14}", env.get("GITHUB_RUN_ID", ""))
            and env.get("GITHUB_RUN_ATTEMPT") == "1", "One fresh run attempt required")
    require(not any(k.startswith(("LD_", "DYLD_")) or k in ("PYTHONPATH", "PYTHONHOME") for k in env),
            "Injected interpreter/runtime refused")
    return "creator-ack-" + env["GITHUB_RUN_ID"]


def stamp(meta):
    return tuple(getattr(meta, k) for k in ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
                                          "st_size", "st_mtime_ns", "st_ctime_ns"))


def read_fd(fd, limit):
    chunks, size = [], 0
    while True:
        block = os.read(fd, min(65536, limit + 1 - size))
        if not block:
            return b"".join(chunks)
        size += len(block)
        require(size <= limit, "Bounded read exceeded")
        chunks.append(block)


def ordinary(file, limit, protected=True):
    require(file.is_absolute() and file.resolve(strict=True) == file, "Canonical input required")
    for parent in file.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), "Redirected parent refused")
        if protected:
            require(info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o022, "Unprotected parent refused")
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit,
            "Bounded ordinary file required")
    if protected:
        require(before.st_uid == before.st_gid == 0 and not before.st_mode & 0o022, "Unprotected file refused")
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stamp(os.fstat(fd)) == stamp(before), "File replaced before read")
        raw = read_fd(fd, limit)
        require(len(raw) == before.st_size and stamp(os.fstat(fd)) == stamp(before)
                and stamp(file.lstat()) == stamp(before), "File changed during read")
        return raw, {"stamp": list(stamp(before)), "sha256": hashlib.sha256(raw).hexdigest()}
    finally:
        os.close(fd)


def tool_pin(name):
    require(name in TOOLS, "Fixed tool required")
    raw, pin = ordinary(Path(name), 16 * 1024 * 1024)
    require(Path(name).stat().st_mode & 0o111 == 0o111, "Executable tool required")
    return pin


def start(command):
    tool_pin(command[0])
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=CLEAN)
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    for name in streams:
        pipe = getattr(child, name)
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, name)
    return child, selector, streams


def pump(handle, wait=0):
    child, selector, streams = handle
    for key, _ in selector.select(wait):
        block = os.read(key.fileobj.fileno(), 4096)
        if block:
            streams[key.data].extend(block)
            require(len(streams[key.data]) <= LIMIT, "Tool output bound exceeded")
        else:
            selector.unregister(key.fileobj)
    return child.poll() is not None and not selector.get_map()


def close(handle):
    child, selector, _ = handle
    selector.close()
    child.stdout.close()
    child.stderr.close()
    # No process signal, stop, kill, reset-failed or retry. The disposable runner
    # owns teardown; the test services have their own explicit runtime bound.


def bounded(command, seconds=2):
    pin = tool_pin(command[0])
    handle = start(command)
    deadline = time.monotonic() + seconds
    try:
        while not pump(handle, 0.02):
            require(time.monotonic() < deadline, "Read-only tool deadline exceeded")
        child, _, streams = handle
        require(child.returncode == 0 and tool_pin(command[0]) == pin, "Fixed tool failed/changed")
        return bytes(streams["stdout"])
    finally:
        close(handle)


def parse_properties(raw, names=PROPERTIES):
    require(type(raw) is bytes and len(raw) <= LIMIT, "Property bound exceeded")
    result = {}
    for line in raw.decode("ascii").splitlines():
        key, sep, value = line.partition("=")
        require(sep and key in names and key not in result and len(value) <= 4096
                and all(32 <= ord(c) <= 126 for c in value), "Unexpected property")
        result[key] = value
    require(set(result) == set(names), "Missing property")
    return result


def unit_name(user, case):
    require(re.fullmatch(r"creator-ack-[1-9][0-9]{0,14}", user) and case in dict((r[0], r) for r in CASES), "Fixed case required")
    return user + "-a1-" + case + ".service"


def show(unit):
    require(re.fullmatch(r"creator-ack-[1-9][0-9]{0,14}-a1-(exec-pam|exec-no-pam|simple-pam)\.service", unit), "Fixed unit required")
    return parse_properties(bounded(["/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", "show", "--all",
                                     "--property=" + ",".join(PROPERTIES), unit]))


def absent(unit):
    row = show(unit)
    require(row["Id"] == unit and row["LoadState"] == "not-found" and row["Transient"] == "no"
            and row["InvocationID"] == "" and row["MainPID"] == row["ExecMainPID"] == "0", "Preexisting unit refused")


def command(user, case):
    name, kind, pam = next((row for row in CASES if row[0] == case), (None, None, None))
    require(name is not None, "Fixed case required")
    return ["/usr/bin/systemd-run", "--wait", "--pipe", "--no-ask-password", "--unit=" + unit_name(user, case),
            "--uid=" + user, "--property=Type=" + kind, "--property=PAMName=" + pam,
            "--property=TimeoutStartSec=" + str(START_SECONDS) + "s", "--property=TimeoutStopSec=" + str(STOP_SECONDS) + "s",
            "--property=RuntimeMaxSec=" + str(RUNTIME_SECONDS) + "s", "--property=LimitCORE=0", "--property=WorkingDirectory=/",
            "/usr/bin/sleep", str(SLEEP_SECONDS)]


def proc_fields(raw):
    text = raw.decode("ascii")
    end = text.rfind(")")
    require(end > 0 and re.fullmatch(r"[1-9][0-9]* \(.*", text[:end]), "Malformed process stat")
    fields = text[end + 2:].split()
    require(len(fields) >= 20 and fields[0] not in ("Z", "X") and len(fields[0]) == 1
            and fields[1].isdigit() and fields[19].isdigit(), "Process not live/unknown")
    return {"state": fields[0], "parentPid": int(fields[1]), "startTime": fields[19]}


def identity_tuples(raw):
    result = {}
    for line in raw.decode("ascii").splitlines():
        key, _, value = line.partition(":")
        if key in ("Uid", "Gid"):
            require(key not in result, "Duplicate identity tuple")
            result[key] = [int(v) for v in value.split()]
    require(result == {"Uid": [UID] * 4, "Gid": [UID] * 4}, "Sleep identity differs")
    return result


def native_sleep(pid, pin):
    require(type(pid) is int and 1 < pid < 2**31, "Bounded MainPID required")
    directory = Path("/proc") / str(pid)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        def read(name, limit):
            item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                return read_fd(item, limit)
            finally:
                os.close(item)
        first = proc_fields(read("stat", 8192))
        require(first["parentPid"] == 1, "Unexpected service parent")
        if os.readlink("exe", dir_fd=fd) != "/usr/bin/sleep":
            return None  # A pre-exec image is not evidence of sleep execution.
        tuples = identity_tuples(read("status", LIMIT))
        require(before.st_uid == before.st_gid == UID, "Process directory identity differs")
        image = os.open("exe", os.O_RDONLY | os.O_NONBLOCK, dir_fd=fd)
        try:
            meta = os.fstat(image)
            require(list(stamp(meta)) == pin["stamp"], "Kernel sleep image differs")
            sha = hashlib.sha256(read_fd(image, 16 * 1024 * 1024)).hexdigest()
            require(sha == pin["sha256"] and stamp(os.fstat(image)) == stamp(meta), "Kernel image changed")
        finally:
            os.close(image)
        last = proc_fields(read("stat", 8192))
        require(last["parentPid"] == first["parentPid"] and last["startTime"] == first["startTime"]
                and identity_tuples(read("status", LIMIT)) == tuples
                and os.readlink("exe", dir_fd=fd) == "/usr/bin/sleep" and stamp(os.fstat(fd)) == stamp(before)
                and stamp(directory.lstat()) == stamp(before) and tool_pin("/usr/bin/sleep") == pin,
                "Process identity changed")
        return {"pid": pid, "parentPid": first["parentPid"], "startTime": first["startTime"],
                "uids": tuples["Uid"], "gids": tuples["Gid"],
                "executable": "/usr/bin/sleep", "image": pin, "kernelImageVerified": True}
    finally:
        os.close(fd)


def bind_unit(row, unit, user, case, invocation=None):
    _, kind, pam = next(r for r in CASES if r[0] == case)
    require(row["Id"] == unit and row["LoadState"] == "loaded" and row["Transient"] == "yes"
            and row["User"] == user and row["PAMName"] == pam and row["Type"] == kind
            and re.fullmatch(r"[a-f0-9]{32}", row["InvocationID"]) and row["InvocationID"] != "0" * 32,
            "Unit identity differs")
    require(invocation is None or row["InvocationID"] == invocation, "Unit invocation replaced")
    require(row["TimeoutStartUSec"] == "3s" and row["TimeoutStopUSec"] == "2s" and row["RuntimeMaxUSec"] == "12s",
            "Test-only unit limits differ")
    return row["InvocationID"]


def outcome(returncode, stderr):
    lines = stderr.splitlines()
    if returncode == 0 and lines.count("Finished with result: success") == 1 \
            and lines.count("Main processes terminated with: code=exited/status=0") == 1:
        return "normal-exit"
    if returncode == 1 and lines.count("Finished with result: timeout") == 1 \
            and sum(lines.count("Main processes terminated with: code=killed/status=" + sig) for sig in ("TERM", "KILL")) == 1:
        return "timeout"
    raise RuntimeError("Unproved wrapper outcome")


def seal_wrapper(handle):
    child, selector, streams = handle
    require(type(child.pid) is int and 1 < child.pid < 2**31, "Unknown original wrapper PID")
    pipes = tuple((getattr(child, name), getattr(child, name).fileno()) for name in ("stdout", "stderr"))
    require(all(type(fd) is int and fd >= 0 for _pipe, fd in pipes) and pipes[0][1] != pipes[1][1],
            "Unknown original wrapper pipes")
    return child, selector, streams, child.pid, pipes


def wrapper_state(handle, sealed):
    child, selector, streams = handle
    require(child is sealed[0] and selector is sealed[1] and streams is sealed[2] and child.pid == sealed[3],
            "Original wrapper identity changed")
    require(type(streams) is dict and set(streams) == {"stdout", "stderr"}
            and all(type(v) is bytearray and len(v) <= LIMIT for v in streams.values()), "Unknown wrapper output state")
    for name, (pipe, fd) in zip(("stdout", "stderr"), sealed[4]):
        require(getattr(child, name) is pipe and pipe.fileno() == fd, "Original wrapper pipe changed")
    opened = []
    for key in selector.get_map().values():
        require(key.data in ("stdout", "stderr") and key.data not in opened
                and key.fileobj is getattr(child, key.data) and key.fd == key.fileobj.fileno()
                and key.events == selectors.EVENT_READ, "Unknown wrapper pipe registration")
        opened.append(key.data)
    code = child.poll()
    require(code is None or type(code) is int, "Unknown wrapper exit state")
    return {"pid": child.pid, "returnCode": code, "openPipes": sorted(opened),
            "bytes": {name: len(raw) for name, raw in streams.items()}}


def observe_collected_wrapper(handle, sealed, record, row, cached_complete, deadline):
    observation = {"firstNotFound": row, "cachedCompleteBeforeQuery": cached_complete, "drainPumps": 0}
    record["terminalObservation"] = observation
    try:
        state = wrapper_state(handle, sealed)
        observation["before"] = state
        observation["after"] = state
        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "Terminal wrapper incomplete at original deadline; no signal/retry")
            if state["returnCode"] is not None and not state["openPipes"]:
                return True
            # Continue draining only these original pipes. No unit query,
            # service/admission retry, new deadline or process signal.
            pump(handle, min(0.1, remaining))
            observation["drainPumps"] += 1
            state = wrapper_state(handle, sealed)
            observation["after"] = state
    except Exception as error:
        observation["errorType"] = type(error).__name__
        raise


def run_case(user, case, record):
    unit = unit_name(user, case)
    record["stage"] = "absent-unit"
    absent(unit)
    record.update(case=case, unit=unit, command=command(user, case), executionObserved=False)
    record["stage"] = "protected-tools"
    pin, wrapper_pin = tool_pin("/usr/bin/sleep"), tool_pin("/usr/bin/systemd-run")
    handle = start(record["command"])
    started = time.monotonic()
    deadline = started + 18
    invocation = None
    try:
        sealed_wrapper = seal_wrapper(handle)
        for _ in range(180):
            done = pump(handle, 0.1)
            require(time.monotonic() < deadline, "Probe deadline exceeded; no signal/retry")
            record["stage"] = "unit-properties"
            row = show(unit)
            if row["LoadState"] == "loaded":
                invocation = bind_unit(row, unit, user, case, invocation)
                if row["MainPID"] != "0" and not record["executionObserved"]:
                    require(row["MainPID"].isdigit() and row["MainPID"] == row["ExecMainPID"], "MainPID differs")
                    record.update(stage="kernel-sleep", executionUnitBefore=row)
                    observed = native_sleep(int(row["MainPID"]), pin)
                    if observed is not None:
                        record["stage"] = "unit-after-kernel"
                        after = show(unit)
                        bind_unit(after, unit, user, case, invocation)
                        record["stage"] = "kernel-recheck"
                        require(after["MainPID"] == row["MainPID"] and after["ExecMainPID"] == row["ExecMainPID"]
                                and native_sleep(observed["pid"], pin) == observed, "Observed execution changed")
                        record.update(executionObserved=True, execution={"before": row, "kernel": observed, "after": after,
                                                                       "elapsedMs": int((time.monotonic() - started) * 1000)})
                record["lastBoundUnit"] = row
            else:
                require(type(row["LoadState"]) is str and row["LoadState"] == "not-found"
                        and row["Id"] == unit and row["Transient"] == "no" and row["InvocationID"] == ""
                        and row["MainPID"] == row["ExecMainPID"] == "0",
                        "Unit disappeared before wrapper completion")
                if invocation is not None:
                    require(record["executionObserved"] is True
                            and record["execution"]["kernel"]["kernelImageVerified"] is True
                            and record["execution"]["before"]["InvocationID"] == invocation
                            and record["execution"]["after"]["InvocationID"] == invocation,
                            "Collected unit lacks bound running sleep proof")
                    record["stage"] = "terminal-observation"
                    done = observe_collected_wrapper(handle, sealed_wrapper, record, row, done, deadline)
            if done:
                record["stage"] = "wrapper-outcome"
                record.update(returnCode=handle[0].returncode, elapsedMs=int((time.monotonic() - started) * 1000),
                              terminal=row, stdout=bytes(handle[2]["stdout"]).decode("utf-8"),
                              stderr=bytes(handle[2]["stderr"]).decode("utf-8"), pipesClosed=True)
                require(record["executionObserved"] and invocation is not None and tool_pin("/usr/bin/systemd-run") == wrapper_pin,
                        "No bound running sleep proof")
                record["outcome"] = outcome(record["returnCode"], record["stderr"])
                record["completed"] = True
                record["stage"] = "complete"
                return
        raise RuntimeError("Observation count exceeded; no retry")
    finally:
        record["wrapperReturnCodeAtClose"] = handle[0].poll()
        record["stdout"] = bytes(handle[2]["stdout"]).decode("utf-8", errors="replace")
        record["stderr"] = bytes(handle[2]["stderr"]).decode("utf-8", errors="replace")
        close(handle)


def fresh_user(user):
    for lookup, value in ((pwd.getpwnam, user), (pwd.getpwuid, UID), (grp.getgrnam, user), (grp.getgrgid, UID)):
        try:
            lookup(value)
        except KeyError:
            continue
        raise RuntimeError("Preexisting account/group refused")
    for case, _, _ in CASES:
        absent(unit_name(user, case))
    bounded(["/usr/sbin/useradd", "--uid", str(UID), "--user-group", "--no-create-home", "--no-log-init",
             "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "--password", "!", user])
    account, group = pwd.getpwnam(user), grp.getgrnam(user)
    require(account.pw_uid == account.pw_gid == group.gr_gid == UID and account.pw_shell == "/usr/sbin/nologin"
            and account.pw_dir == "/nonexistent" and pwd.getpwuid(UID).pw_name == user and grp.getgrgid(UID).gr_name == user,
            "New synthetic identity differs")
    status = bounded(["/usr/bin/passwd", "-S", user]).decode("ascii").split()
    require(len(status) == 7 and status[0] == user and status[1] == "L", "Locked account not proved")


def platform_proof():
    raw, pin = ordinary(Path("/usr/lib/os-release"), LIMIT)
    fields = dict(line.split("=", 1) for line in raw.decode("ascii").splitlines() if "=" in line)
    require(fields.get("ID") == "ubuntu" and fields.get("VERSION_ID") == '"22.04"', "Ubuntu 22.04 only")
    version = parse_properties(bounded(["/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", "show",
                                        "--all", "--property=Version"]), ("Version",))
    return {"osRelease": pin, "managerVersion": version["Version"]}


def base_path(env):
    return Path("/usr/lib") / ("creator-unit-start-ack-" + env["GITHUB_RUN_ID"] + "-a1")


def staging_parent():
    # Pinned runner configure-system.sh (1710984) chmods /opt and /usr/share.
    # Nevertheless validate the actual complete chain before creating anything.
    parent = Path("/usr/lib")
    for entry in (parent, *parent.parents):
        info = entry.lstat()
        require(entry.is_absolute() and entry.resolve(strict=True) == entry and stat.S_ISDIR(info.st_mode)
                and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                "Protected staging ancestry required")
    return parent


def main():
    require(sys.argv[1:] in (["prepare"], ["probe"]), "Fixed prepare/probe role required")
    env = dict(os.environ)
    user = admission(env)
    base = base_path(env)
    if sys.argv[1] == "prepare":
        platform_proof()
        source = Path(env["GITHUB_WORKSPACE"]) / "scripts/native-linux-unit-start-ack.py"
        require(Path(__file__).resolve() == source and not os.path.lexists(base), "Fresh fixed probe source/directory required")
        raw, _ = ordinary(source, 128 * 1024, protected=False)
        require(base.parent == staging_parent(), "Fixed protected staging parent required")
        base.mkdir(mode=0o755)
        file = base / "probe.py"
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
        os.execve("/usr/bin/python3", ["/usr/bin/python3", "-I", "-S", "-B", str(file), "probe"],
                  {**{k: env[k] for k in ENVIRONMENT}, **CLEAN})
    raw, source_pin = ordinary(base / "probe.py", 128 * 1024)
    require(Path(__file__) == base / "probe.py", "Protected staged probe required")
    report = {"diagnosticOnly": True, "authorityGranted": False, "releaseReady": False, "probeCompleted": False,
              "harnessSource": env["GITHUB_SHA"], "runId": env["GITHUB_RUN_ID"], "runAttempt": 1,
              "source": source_pin, "user": user, "uid": UID, "cases": []}
    fd = os.open(base / "report.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    def save():
        data = json.dumps(report, allow_nan=False).encode("ascii")
        require(len(data) <= 128 * 1024, "Receipt bound exceeded")
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        require(os.write(fd, data) == len(data), "Receipt write incomplete")
        os.fsync(fd)
    try:
        report["platform"] = platform_proof()
        report["stage"] = "fresh-locked-account"
        fresh_user(user)
        report["accountLocked"] = True
        report["sleepImage"] = tool_pin("/usr/bin/sleep")
        save()
        for case, _, _ in CASES:
            report["stage"] = case
            record = {}
            report["cases"].append(record)
            require(tool_pin("/usr/bin/sleep") == report["sleepImage"], "Sleep changed between cases")
            run_case(user, case, record)
            require(record["execution"]["kernel"]["image"] == report["sleepImage"], "Case image differs")
            save()
        report["probeCompleted"] = True
    except Exception as error:
        report["errorType"] = type(error).__name__
        raise
    finally:
        save()
        os.close(fd)


if __name__ == "__main__":
    main()
