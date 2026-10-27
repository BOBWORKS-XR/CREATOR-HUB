"""Read-only synthetic router -> supervisor -> sealed Node qualification."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import select
import stat
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SOURCE_PINS = {
    "unix_exec.rs": "a8e714620c90ac852eaa0b583ecf11ca33ec7dcd3ab5ed176b3bc266cada4872",
    "unix_exec_linux.rs": "ca4552a4db13d5580cdf282da929faec4d08975710decbbe0ad555b1361940a7",
}
MEMFD = "/memfd:creator-hub-node (deleted)"
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def require(value, message):
    if not value:
        raise RuntimeError(message)


def loader():
    bodies = {}
    for name, expected in SOURCE_PINS.items():
        raw = (HERE.parent / "src" / name).read_bytes()
        require(len(raw) <= 65536 and sha(raw) == expected, "Fixed router source changed")
        bodies[name] = raw
    matches = re.findall(rb'^const LOADER: &str = r#"(.*?)"#;', bodies["unix_exec.rs"], re.M | re.S)
    require(len(matches) == 1, "One source-bound fixed loader required")
    return matches[0].decode("utf-8", errors="strict")


def parse_stat(raw, pid):
    text = raw.decode("utf-8", errors="strict")
    require(text.startswith(str(pid) + " ("), "Kernel PID differs")
    end = text.rfind(") ")
    fields = text[end + 2:].split()
    require(end > 0 and len(fields) >= 20 and fields[0] not in ("Z", "X", "x")
            and fields[1].isdigit() and fields[19].isdigit(), "Live kernel process identity required")
    return {"pid": pid, "parentPid": int(fields[1]), "startTime": fields[19]}


def parse_argv(raw):
    require(0 < len(raw) <= 65536 and raw.endswith(b"\0"), "Bounded NUL-terminated kernel argv required")
    values = raw[:-1].split(b"\0")
    require(0 < len(values) <= 16 and all(values), "Finite kernel argv required")
    return [value.decode("utf-8", errors="strict") for value in values]


def contract(value):
    require(type(value) is dict and set(value) == {
        "routerPid", "callerPid", "uid", "gid", "routerPath", "routerImage", "nodePath", "nodeImage", "serverPath", "sourceSha256"
    }, "Exact independent observer contract required")
    for name in ("routerPid", "callerPid", "uid", "gid"):
        require(type(value[name]) is int and value[name] >= (0 if name in ("uid", "gid") else 2), "Invalid owned kernel identity")
    for name in ("routerPath", "nodePath", "serverPath"):
        text = value[name]
        require(type(text) is str and 0 < len(text) <= 2048 and str(PurePosixPath(text)) == text
                and text.startswith("/") and ".." not in PurePosixPath(text).parts
                and not any(c in text for c in ("\0", "\n", "\r", "\\")), "Exact canonical Linux path required")
    require(value["nodePath"] == str(PurePosixPath(value["serverPath"]).parent / "runtime/node"), "Fixed Node/server layout required")
    require(re.search(r"/runtime-generations/linux-(?:x86_64|aarch64)/[a-f0-9]{64}/mcp/server/creator-works-mcp\.mjs$",
                      value["serverPath"]), "Exact manifest-generation server path required")
    for name in ("routerImage", "nodeImage"):
        item = value[name]
        require(type(item) is dict and set(item) == {"size", "sha256"}
                and type(item["size"]) is int and 0 < item["size"] <= 256 * 1024**2
                and type(item["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]), "Exact executable byte pin required")
    require(type(value["sourceSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["sourceSha256"]), "Exact server source digest required")
    return value


def validate_snapshot(snapshot, expected, fixed_loader):
    contract(expected)
    router, supervisor, node = (snapshot[name] for name in ("router", "supervisor", "serverNode"))
    require(router["pid"] == expected["routerPid"] and router["parentPid"] == expected["callerPid"]
            and supervisor["parentPid"] == router["pid"] and node["parentPid"] == supervisor["pid"]
            and len({r["pid"] for r in (router, supervisor, node)}) == 3, "Exact router-supervisor-server ancestry required")
    for row in (router, supervisor, node):
        require(type(row["startTime"]) is str and row["startTime"].isdigit()
                and row["uids"] == [expected["uid"]] * 4 and row["gids"] == [expected["gid"]] * 4,
                "Kernel start time/UID/GID differs")
    require(int(router["startTime"]) <= int(supervisor["startTime"]) <= int(node["startTime"]), "Kernel process start order differs")
    for row in (router, supervisor):
        require(row["executable"] == expected["routerPath"] and row["imagePin"] == expected["routerImage"], "Fixed router/supervisor image differs")
    require(supervisor["argv"] == router["argv"], "Private fork supervisor command changed")
    require(node["argv"] == [expected["nodePath"], "--input-type=module", "--eval", fixed_loader,
                             expected["serverPath"], expected["sourceSha256"]], "Fixed loader argv/server/source digest differs")
    require(node["executable"] == node["fd4Link"] == MEMFD and node["imagePin"] == expected["nodeImage"]
            and node["fd4Image"] == node["image"] and node["seals"] & 15 == 15,
            "Exact sealed executable/fd4/Node hash required")
    image = node["image"]
    require(stat.S_ISREG(image["mode"]) and stat.S_IMODE(image["mode"]) == 0o500
            and image["uid"] == expected["uid"] and image["gid"] == expected["gid"] and image["nlink"] == 0,
            "Sealed memfd owner/mode/link identity differs")
    return {"schemaVersion": 1, "scope": "synthetic-linux-router-node-observer-only", "passed": True,
            "snapshot": snapshot, "loaderSha256": sha(fixed_loader.encode()), "sourceSha256": expected["sourceSha256"],
            "routerSourcePins": SOURCE_PINS,
            "syntheticFixtureOnly": True, "qualified": False, "nativeAdmissionAccepted": False,
            "liveMcpProtocolAccepted": False, "payloadSwapAccepted": False, "releaseReady": False}


class ProcReader:
    def __init__(self, stack, expected):
        require(sys.platform == "linux" and os.getuid() == os.geteuid() == expected["uid"]
                and os.getgid() == os.getegid() == expected["gid"]
                and os.getppid() == expected["callerPid"], "Owned ordinary Linux observer context required")
        import fcntl
        self.stack, self.fcntl = stack, fcntl
        self.held = {}

    def read(self, path, limit):
        with open(path, "rb") as stream:
            raw = stream.read(limit + 1)
        require(len(raw) <= limit, "Kernel metadata exceeded bound")
        return raw

    def children(self, pid):
        raw = self.read(f"/proc/{pid}/task/{pid}/children", 8192)
        fields = raw.split()
        require(len(fields) <= 16 and all(p.isdigit() and int(p) > 1 for p in fields), "Bounded direct-child inventory required")
        values = [int(p) for p in fields]
        require(len(set(values)) == len(values), "Duplicate kernel child PID")
        return values

    def identity(self, pid):
        row = parse_stat(self.read(f"/proc/{pid}/stat", 8192), pid)
        status = self.read(f"/proc/{pid}/status", 65536)
        uids = re.findall(rb"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.M)
        gids = re.findall(rb"^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.M)
        require(len(uids) == len(gids) == 1, "One kernel UID/GID record required")
        return {**row, "uids": [int(x) for x in uids[0]], "gids": [int(x) for x in gids[0]], "executable": os.readlink(f"/proc/{pid}/exe"),
                "argv": parse_argv(self.read(f"/proc/{pid}/cmdline", 65536))}

    def opened(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        self.stack.callback(os.close, fd)
        return fd

    def image(self, fd):
        value = os.fstat(fd)
        return {"dev": value.st_dev, "ino": value.st_ino, "mode": value.st_mode,
                "uid": value.st_uid, "gid": value.st_gid, "nlink": value.st_nlink, "size": value.st_size,
                "mtimeNs": str(value.st_mtime_ns), "ctimeNs": str(value.st_ctime_ns)}

    def snapshot(self, pid, expected_pin, *, server=False):
        pidfd = os.pidfd_open(pid)
        self.stack.callback(os.close, pidfd)
        row = self.identity(pid)
        fd = self.opened(f"/proc/{pid}/exe")
        image = self.image(fd)
        require(stat.S_ISREG(image["mode"]) and image["size"] == expected_pin["size"], "Kernel executable size/type differs")
        digest, size = hashlib.sha256(), 0
        while True:
            block = os.read(fd, min(1024**2, expected_pin["size"] + 1 - size))
            if not block:
                break
            size += len(block)
            require(size <= expected_pin["size"], "Kernel executable grew")
            digest.update(block)
        row.update(image=image, imagePin={"size": size, "sha256": digest.hexdigest()})
        held = {"pidfd": pidfd, "exe": fd, "row": row, "identity": self.identity(pid)}
        require(held["identity"] == {k: row[k] for k in ("pid", "parentPid", "startTime", "uids", "gids", "executable", "argv")}, "Process changed during executable capture")
        if server:
            fd4 = self.opened(f"/proc/{pid}/fd/4")
            row.update(fd4Link=os.readlink(f"/proc/{pid}/fd/4"), fd4Image=self.image(fd4),
                       seals=self.fcntl.fcntl(fd4, self.fcntl.F_GET_SEALS))
            held["fd4"] = fd4
        self.held[pid] = held
        self.recheck(pid)
        return row

    def recheck(self, pid):
        held = self.held[pid]
        poll = select.poll(); poll.register(held["pidfd"], select.POLLIN)
        require(not poll.poll(0), "Observed process exited")
        current_exe = self.opened(f"/proc/{pid}/exe")
        require(self.identity(pid) == held["identity"] and self.image(held["exe"]) == held["row"]["image"]
                and self.image(current_exe) == held["row"]["image"], "Observed process identity changed")
        if "fd4" in held:
            current_fd4 = self.opened(f"/proc/{pid}/fd/4")
            require(os.readlink(f"/proc/{pid}/fd/4") == held["row"]["fd4Link"]
                    and self.image(held["fd4"]) == held["row"]["fd4Image"]
                    and self.image(current_fd4) == held["row"]["fd4Image"]
                    and self.fcntl.fcntl(current_fd4, self.fcntl.F_GET_SEALS) == held["row"]["seals"]
                    and self.fcntl.fcntl(held["fd4"], self.fcntl.F_GET_SEALS) == held["row"]["seals"], "Observed sealed fd4 changed")


def observe(expected):
    contract(expected)
    fixed_loader = loader()
    with ExitStack() as stack:
        reader = ProcReader(stack, expected)
        router = reader.snapshot(expected["routerPid"], expected["routerImage"])
        supervisors = reader.children(router["pid"])
        require(len(supervisors) == 1, "One private supervisor required")
        supervisor = reader.snapshot(supervisors[0], expected["routerImage"])
        nodes = reader.children(supervisor["pid"])
        require(len(nodes) == 1, "One direct sealed server Node required")
        node = reader.snapshot(nodes[0], expected["nodeImage"], server=True)
        require(reader.children(router["pid"]) == supervisors and reader.children(supervisor["pid"]) == nodes, "Observed process tree changed")
        for pid in (router["pid"], supervisor["pid"], node["pid"]):
            reader.recheck(pid)
        return validate_snapshot({"router": router, "supervisor": supervisor, "serverNode": node}, expected, fixed_loader)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 1, "Only the bounded stdin observer contract is supported")
        raw = sys.stdin.buffer.read(16385)
        require(0 < len(raw) <= 16384, "Bounded observer contract required")
        result = observe(json.loads(raw))
        body = json.dumps(result, sort_keys=True)
        require(len(body.encode()) <= 65536, "Observer report exceeded bound")
        print(body)
    except Exception as error:
        print(json.dumps({"passed": False, "scope": "synthetic-linux-router-node-observer-only",
                          "refusalType": type(error).__name__, "message": str(error)[:180],
                          "qualified": False, "nativeAdmissionAccepted": False, "payloadSwapAccepted": False, "releaseReady": False}))
        sys.exit(1)
