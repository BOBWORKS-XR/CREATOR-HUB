"""Disposable GNOME polkit dialog attribution only; no dialog input or updater."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BRANCH = "refs/heads/validation/linux-polkit-contract-014"
BASE = Path("/opt/creator-polkit-fixture")
USER, UID = "creator-polkit-fixture", 21314
AGENT = "/usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1"
AGENT_PATH = "/org/gnome/PolicyKit1/AuthenticationAgent"
COMMAND = ("/usr/bin/pkexec", "--disable-internal-agent", "/usr/bin/true")
STOCK_POLICY = "/usr/share/polkit-1/actions/org.freedesktop.policykit.policy"
STOCK_ARCHIVE = ("https://archive.ubuntu.com/ubuntu/pool/main/p/policykit-1/polkitd_0.105-33ubuntu0.2_amd64.deb",
                 80152, "8a8e123a44e2c3deef2c072db7248e94d9d7ad7c874127facc7d1abaf622ea85")
HELPERS = {"native-linux-root-probe.py": "91983346c5bac811028135b41c11a0dfc10e40a61c9f65aab535df326e354e72",
           "native-unix-window.py": "da62bd6644bebd21059893b2dbfa2685fb2deb9b2ca54281d87c599f4cd3f636"}
# Independent primary Ubuntu archive bytes, not hashes learned from a live PID.
FILES = {
    AGENT: ("policykit-1-gnome", "0.105-7ubuntu3", 55448, "871825e1437644fbf8bde51b27b65e93f43e439df662183f012983258e45e48c", 0o755),
    COMMAND[0]: ("pkexec", "0.105-33ubuntu0.2", 30872, "e8e0d68a9dfed5d45f505f07a37cb543209c8ea0b36a9662605229f1569642f8", 0o4755),
    COMMAND[2]: ("coreutils", "8.32-4.1ubuntu1.4", 26936, "94f5d1c6ad51bbd532bf2e702b3d28cb57ba8887435b4514a06e4ba0cd7fedba", 0o755),
    "/usr/libexec/polkitd": ("polkitd", "0.105-33ubuntu0.2", 121504, "73a752ee6823f95f0a935e14e0de3045071232a9cf29eb2ace645e39d95b4934", 0o755),
    "/usr/share/polkit-1/actions/org.freedesktop.policykit.policy": ("polkitd", "0.105-33ubuntu0.2", 1524,
        "813df7ecb2ec4606b1a6e994863be7e3b04960473f63b9739b5de623001ed90d", 0o644),
}
SOURCE_BASE = "https://archive.ubuntu.com/ubuntu/pool/universe/p/policykit-1-gnome/"
SOURCES = {
    "policykit-1-gnome_0.105.orig.tar.xz": (310876, "1784494963b8bf9a00eedc6cd3a2868fb123b8a5e516e66c5eda48df17ab9369"),
    "policykit-1-gnome_0.105-7ubuntu3.debian.tar.xz": (11860, "20d8379a2eda742fc261bbbbf46575d19adcb50f19e3a038510275822eb98e21"),
}
SOURCE_FILES = {
    "polkit-gnome-0.105/src/main.c": "ba11d1f29399de06fd856a839ff4111a4c91943f6601f7f83fa5f46b91291cc2",
    "polkit-gnome-0.105/src/polkitgnomeauthenticationdialog.c": "e26dd41f1e341b95bf1d477b1872e74846f7248dcb2361d22665392ff4a4fe89",
}
FLAGS = {k: False for k in ("dialogInputAuthorized", "passwordRead", "authenticationAccepted", "cancelAccepted",
                           "actualUpdaterAccepted", "signedUpdateAccepted", "restartAccepted", "releaseReady")}
_b = None


def require(value, message):
    if not value:
        raise RuntimeError(message)


def base():
    global _b
    if _b is None:
        for name, digest in HELPERS.items():
            require(hashlib.sha256((HERE / name).read_bytes()).hexdigest() == digest, "Reviewed helper bytes changed")
        spec = importlib.util.spec_from_file_location("polkit_existing_root_helpers", HERE / "native-linux-root-probe.py")
        _b = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = _b
        spec.loader.exec_module(_b)
    return _b


def admission(env, system, machine):
    base().admission(env, system, machine)
    require(env.get("CREATOR_LINUX_POLKIT_PROBE") == "1" and env.get("GITHUB_REF") == BRANCH
            and env.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch")
            and re.fullmatch("[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Exact polkit CI branch/event/source required")


def source_contract(fetch=None):
    """Public immutable source reads only; safe to run before native admission."""
    if fetch is None:
        def fetch(name, size):
            url = SOURCE_BASE + name
            with urllib.request.urlopen(url, timeout=20) as response:
                require(response.url == url, "Source redirect refused")
                return response.read(size + 1)
    records, selected = {}, {}
    for name, (size, digest) in SOURCES.items():
        data = fetch(name, size)
        require(len(data) == size and hashlib.sha256(data).hexdigest() == digest, "Pinned primary source archive differs")
        records[name] = {"bytes": size, "sha256": digest, "url": SOURCE_BASE + name}
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
            members = archive.getmembers()
            require(len(members) <= 256 and len({m.name for m in members}) == len(members)
                    and sum(m.size for m in members) <= 4 * 1024 * 1024, "Bounded unique source archive required")
            for member in members:
                if member.name in SOURCE_FILES or member.name.startswith("debian/patches/") and member.isfile():
                    require(member.isfile() and member.size <= 65536, "Ordinary bounded source member required")
                    selected[member.name] = archive.extractfile(member).read().decode("utf-8")
    for name, digest in SOURCE_FILES.items():
        require(hashlib.sha256(selected[name].encode()).hexdigest() == digest, "Fixed source file differs")
    main = selected["polkit-gnome-0.105/src/main.c"]
    dialog = selected["polkit-gnome-0.105/src/polkitgnomeauthenticationdialog.c"]
    require("polkit_unix_session_new_for_process_sync (getpid ()" in main
            and "POLKIT_AGENT_REGISTER_FLAGS_NONE" in main and AGENT_PATH in main
            and "polkit_agent_listener_register" in main and "goto out;" in main, "Session registration source differs")
    require("gtk_entry_set_visibility (GTK_ENTRY (dialog->priv->password_entry), FALSE)" in dialog
            and "GTK_RESPONSE_CANCEL" in dialog and "GTK_RESPONSE_OK" in dialog, "GTK dialog source differs")
    series = selected["debian/patches/series"].splitlines()
    patches = [selected["debian/patches/" + s.strip()] for s in series if s.strip() and not s.startswith("#")]
    require(len(patches) == 6 and sum("src/main.c" in patch for patch in patches) == 1
            and "register_client_to_gnome_session();" in selected["debian/patches/04-autorestart.patch"], "Ubuntu session patch set differs")
    return {"scope": "primary-source-contract-only", "archives": records, "sourceFiles": SOURCE_FILES,
            "requiresRealLogindSession": True, "dbusObjectPath": AGENT_PATH, **FLAGS}


def stock_policy_contract(tar_bytes):
    require(0 < len(tar_bytes) <= 1024 * 1024, "Bounded factory package TAR required")
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        members = archive.getmembers()
        require(len(members) <= 128 and len({m.name for m in members}) == len(members), "Unique bounded factory package inventory required")
        matches = [m for m in members if m.name == "." + STOCK_POLICY]
        require(len(matches) == 1, "Exact stock policy package member required")
        member = matches[0]
        pin = FILES[STOCK_POLICY]
        require(member.isfile() and not member.linkname and member.uid == member.gid == 0
                and member.mode == pin[4] == 0o644 and member.size == pin[2], "Factory stock policy owner/mode/size differs")
        data = archive.extractfile(member).read()
        require(len(data) == pin[2] and hashlib.sha256(data).hexdigest() == pin[3], "Factory stock policy hash differs")
        actions = ET.fromstring(data).findall("action[@id='org.freedesktop.policykit.exec']")
        require(len(actions) == 1 and [actions[0].findtext("defaults/" + k) for k in ("allow_any", "allow_inactive", "allow_active")]
                == ["auth_admin"] * 3, "Factory stock authentication policy differs")
        return {"path": STOCK_POLICY, "uid": 0, "gid": 0, "mode": member.mode, "size": len(data), "sha256": pin[3]}


def stock_leaf(path, record):
    info = path.lstat()
    require(str(path) == STOCK_POLICY and path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode)
            and info.st_nlink == 1 and info.st_uid == info.st_gid == 0, "Exact ordinary root-owned stock leaf required")
    require(stat.S_IMODE(info.st_mode) == record["mode"] and record["mode"] in (0o644, 0o777)
            and (record["size"], record["sha256"]) == FILES[STOCK_POLICY][2:4], "Unreviewed stock leaf mode/bytes refused")


def secure_stock_policy(output):
    """Restore one proven package mode on disposable CI; never edit policy bytes."""
    b, report = base(), {"scope": "disposable-runner-stock-leaf-mode-only", "policyContentChanged": False,
                         "recursiveChange": False, "modeChanged": False, **FLAGS}
    try:
        require(os.getuid() > 0 and os.getuid() != UID, "Only non-root provisioning runner may secure the stock leaf")
        url, size, digest = STOCK_ARCHIVE
        with urllib.request.urlopen(url, timeout=20) as response:
            require(response.url == url, "Factory package redirect refused")
            data = response.read(size + 1)
        require(len(data) == size and hashlib.sha256(data).hexdigest() == digest, "Independent factory DEB pin differs")
        deb = output / "polkit-stock-mode-source.deb"
        b.write_new(deb, data)
        unpacked = subprocess.run(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(deb)], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=8)
        require(unpacked.returncode == 0 and len(unpacked.stderr) <= 8192, "Fixed factory package inspection refused")
        b.pinned(deb, (size, digest))
        report["factoryPolicy"] = stock_policy_contract(unpacked.stdout)
        report["factoryArchive"] = {"url": url, "size": size, "sha256": digest}
        path = Path(STOCK_POLICY)
        before = b.file_record(path, FILES[STOCK_POLICY][2])
        report["before"] = before
        stock_leaf(path, before)
        _code, state = b.run_tool(output, "stock-leaf-package", ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n", "polkitd"])
        _code, owner = b.run_tool(output, "stock-leaf-owner", ["/usr/bin/dpkg-query", "-S", STOCK_POLICY])
        require(state == b"polkitd\t0.105-33ubuntu0.2\tamd64\tinstalled\n"
                and owner == ("polkitd: " + STOCK_POLICY + "\n").encode(), "Exact stock leaf package provenance required")
        require(b.file_record(path, FILES[STOCK_POLICY][2]) == before, "Stock leaf changed before mode restoration")
        stock_leaf(path, before)
        if before["mode"] == 0o777:
            b.run_tool(output, "restore-one-factory-leaf-mode", ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "0644", "--", STOCK_POLICY])
            report["modeChanged"] = True
        after = b.pinned(path, FILES[STOCK_POLICY][2:4], 0o644)
        stock_leaf(path, after)
        require(all(after[k] == before[k] for k in ("device", "inode", "size", "sha256")), "Stock leaf identity or bytes changed")
        report["after"] = after
    except Exception as error:
        report["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        raise
    finally:
        b.save_json(output / "polkit-stock-policy-preflight.json", report)
    return report


def system_file_observation(output):
    """Read-only evidence before a guard refuses; never an input allowance."""
    b, rows = base(), {}
    for filename, (package, version, size, digest, mode) in FILES.items():
        path = Path(filename)
        row = {"expectedPackage": package, "expectedVersion": version, "expectedMode": mode,
               "expectedSize": size, "expectedSha256": digest, "authorization": False}
        rows[filename] = row
        try:
            info = path.lstat()
            row.update(mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid, size=info.st_size,
                       canonical=path.resolve(strict=True) == path, regular=stat.S_ISREG(info.st_mode))
            if row["canonical"] and row["regular"]:
                row["file"] = b.file_record(path, 256 * 1024)
            status, state = b.run_tool(output, "observed-package-" + path.name,
                ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n", package], allowed=(0, 1))
            row.update(packageExitCode=status, packageRaw=state.decode("utf-8"))
            status, owner = b.run_tool(output, "observed-owner-" + path.name,
                ["/usr/bin/dpkg-query", "-S", filename if package != "coreutils" else "/bin/true"], allowed=(0, 1))
            row.update(ownerExitCode=status, ownerRaw=owner.decode("utf-8"))
        except Exception as error:
            row["observationRefusal"] = type(error).__name__
    b.save_json(output / "system-files-observation.json", {"scope": "read-only-before-system-file-guards", "files": rows, **FLAGS})


def verify_files(output):
    b, result = base(), {}
    system_file_observation(output)
    for filename, (package, version, size, digest, mode) in FILES.items():
        path = Path(filename)
        require(path.resolve(strict=True) == path and path.stat().st_uid == path.stat().st_gid == 0, "Canonical root-owned system file required")
        try:
            record = b.pinned(path, (size, digest), mode)
        except Exception as error:
            raise RuntimeError("Exact system file pin refused: " + filename) from error
        _code, state = b.run_tool(output, "package-" + path.name, ["/usr/bin/dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n", package])
        require(state == f"{package}\t{version}\tamd64\tinstalled\n".encode(), "Exact installed system package required")
        _code, owner = b.run_tool(output, "owner-" + path.name, ["/usr/bin/dpkg-query", "-S", filename if package != "coreutils" else "/bin/true"])
        require(owner == f"{package}: {filename if package != 'coreutils' else '/bin/true'}\n".encode(), "Package file ownership differs")
        if mode & 0o111:
            require(b.bounded_read(path, size)[:7] == b"\x7fELF\x02\x01\x01", "Scriptless x86_64 system ELF required")
        result[filename] = {"package": package, "version": version, **record}
    policy = ET.fromstring(base().bounded_read(Path(next(f for f in FILES if f.endswith(".policy"))), 4096))
    action = policy.findall("action[@id='org.freedesktop.policykit.exec']")
    require(len(action) == 1 and [action[0].findtext("defaults/" + k) for k in ("allow_any", "allow_inactive", "allow_active")]
            == ["auth_admin"] * 3, "Stock authentication policy required")
    return result


def finite_environment(env, output):
    result = base().child_env(env, output)
    result.update(HOME=str(output / "home"), LANG="C", LC_ALL="C")
    return result


def dbus_call(bus, destination, object_path, interface, method, signature, arguments, reply, glib):
    return bus.call_sync(destination, object_path, interface, method,
        glib.Variant(signature, arguments) if signature else None, glib.VariantType.new(reply),
        0, 1500, None).unpack()


def bus_identity(bus, name, glib):
    call = lambda method, arg, reply: dbus_call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", method, "(s)", (arg,), reply, glib)[0]
    owner = call("GetNameOwner", name, "(s)")
    require(re.fullmatch(r":[0-9]+\.[0-9]+", owner), "Unique system bus owner required")
    result = {"owner": owner, "pid": call("GetConnectionUnixProcessID", owner, "(u)"),
              "uid": call("GetConnectionUnixUser", owner, "(u)")}
    require(call("GetNameOwner", name, "(s)") == owner, "System bus owner changed")
    return result


def session(bus, pid, glib):
    require(bus_identity(bus, "org.freedesktop.login1", glib)["uid"] == 0, "Root-owned logind required")
    obj = dbus_call(bus, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
                    "GetSessionByPID", "(u)", (pid,), "(o)", glib)[0]
    require(re.fullmatch(r"/org/freedesktop/login1/session/[A-Za-z0-9_]+", obj), "Real logind session object required")
    properties = dbus_call(bus, "org.freedesktop.login1", obj, "org.freedesktop.DBus.Properties", "GetAll",
                          "(s)", ("org.freedesktop.login1.Session",), "(a{sv})", glib)[0]
    result = {key: properties[key] for key in ("Id", "User", "Leader", "Class", "Type", "Remote", "State")}
    require(result["User"][0] == UID and not result["Remote"], "Synthetic local session required")
    return {"object": obj, **result}


def registered_agent(bus, agent, glib, observation=None):
    authority = bus_identity(bus, "org.freedesktop.PolicyKit1", glib)
    require(authority["uid"] == 0, "Root-owned system authority required")
    names = dbus_call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames", None, (), "(as)", glib)[0]
    require(len(names) <= 256, "System bus name inventory exceeds bound")
    if observation is not None:
        observation.clear()
        observation.update(readOnly=True, authorization=False, actionCount=0, authority=authority,
                           objectPath=AGENT_PATH, candidates=[])
    matches = []
    for name in names:
        if not re.fullmatch(r":[0-9]+\.[0-9]+", name):
            continue
        identity = bus_identity(bus, name, glib)
        if identity["pid"] != agent["pid"]:
            continue
        require(identity["uid"] == UID, "Foreign system agent UID")
        candidate = {**identity, "objectPath": AGENT_PATH}
        if observation is not None:
            require(len(observation["candidates"]) < 4, "Agent system-bus candidate inventory exceeds bound")
            observation["candidates"].append(candidate)
        try:
            xml = dbus_call(bus, name, AGENT_PATH, "org.freedesktop.DBus.Introspectable", "Introspect", None, (), "(s)", glib)[0]
        except Exception as error:
            # This fixed, argument-free read carries no authentication cookie
            # or password. Preserve its error instead of assuming registration
            # has not happened yet. A refusal never grants authority.
            candidate["introspectionRefusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
            continue
        require(type(xml) is str and len(xml.encode()) <= 32768, "Bounded source object introspection required")
        document = ET.fromstring(xml)
        interface_names = [i.get("name", "") for i in document.findall("interface")]
        require(len(interface_names) <= 32 and all(len(n) <= 128 for n in interface_names), "Bounded source interface names required")
        candidate.update(interfaces=interface_names, introspectionSha256=hashlib.sha256(xml.encode()).hexdigest())
        interfaces = document.findall("interface[@name='org.freedesktop.PolicyKit1.AuthenticationAgent']")
        if len(interfaces) != 1:
            continue
        methods = {m.attrib["name"]: [a.attrib["type"] for a in m.findall("arg") if a.get("direction", "in") == "in"]
                   for m in interfaces[0].findall("method")}
        require(methods == {"BeginAuthentication": ["s", "s", "s", "a{ss}", "s", "a(sa{sv})"], "CancelAuthentication": ["s"]}, "Source agent interface differs")
        require(bus_identity(bus, name, glib) == identity, "Source agent bus identity changed")
        matches.append({**identity, "authority": authority, "objectPath": AGENT_PATH, "methods": methods,
                        "introspectionSha256": hashlib.sha256(xml.encode()).hexdigest()})
    require(len(matches) <= 1, "Ambiguous system agent source object")
    return matches[0] if matches else None


def own_agent(process, expected, parent, helper):
    require(process.poll() is None and base().native_process(os.getpid(), helper) == parent, "Held probe/agent exited or changed")
    actual = base().native_process(process.pid, helper)
    require(actual == expected and actual["parentPid"] == parent["pid"] and actual["uids"] == [UID] * 4
            and actual["executable"] == AGENT and actual["kernelImageSha256"] == FILES[AGENT][3], "Independent agent kernel identity differs")


def windows(pid, helper, x11):
    # _NET_WM_PID only filters; the independent XRes client PID is authoritative.
    root = x11.x.XDefaultRootWindow(x11.display)
    prop = x11.property(root, "_NET_CLIENT_LIST_STACKING")
    if prop is None:
        return []
    require(prop[:2] == (33, 32) and len(prop[2]) <= 16 and len(set(prop[2])) == len(prop[2]), "Bounded native window inventory required")
    result = []
    for xid in prop[2]:
        claim = x11.property(xid, "_NET_WM_PID")
        if claim and claim[:2] == (6, 32) and claim[2] == [pid]:
            info = x11.inspect(xid)
            require(info["pid"] == pid and info["client"] > 0, "Claimed agent window has foreign XRes owner")
            if info["mapped"]:
                result.append({"window": xid, **info})
    return result


def raw_ax(agent, helper, atspi, refs):
    owner = type("Owner", (), {"root": agent, "renderer": None})()
    apps = [a for a in helper.children(atspi.get_desktop(0), 64) if a.get_process_id() == agent["pid"]]
    require(len(apps) <= 1, "Ambiguous agent AX applications")
    if not apps:
        return None
    nodes, pending, seen = [], [(apps[0], 0, None)], set()
    while pending:
        node, depth, parent = pending.pop()
        require(len(nodes) < 256 and depth < 24 and node.get_process_id() == agent["pid"], "Bounded agent-only AX tree required")
        ref = tuple(refs.identity(node, owner))
        require(ref not in seen, "Duplicate/cyclic agent AX object")
        seen.add(ref)
        role, states = node.get_role(), node.get_state_set()
        sensitive = role == atspi.Role.PASSWORD_TEXT or states.contains(atspi.StateType.EDITABLE)
        row = {"reference": list(ref), "parent": parent, "pid": agent["pid"], "depth": depth, "role": int(role),
               "roleName": (node.get_role_name() or "")[:64], "editableOrPasswordOmitted": sensitive,
               **{s.lower(): states.contains(getattr(atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}}
        if not sensitive:
            name = node.get_name() or ""
            require(type(name) is str and len(name) <= 1024, "Native AX name exceeds bound")
            row["name"] = name
            if role in {getattr(atspi.Role, name, -1) for name in ("LABEL", "TEXT", "STATIC", "PARAGRAPH")}:
                text = node.get_text_iface()
                if text is not None:
                    size = text.get_character_count()
                    require(type(size) is int and 0 <= size <= 2048, "Native AX text exceeds bound")
                    row["text"] = text.get_text(0, size)
        nodes.append(row)
        require(len(json.dumps(nodes).encode()) <= 65536, "Native AX report exceeds bound")
        pending.extend((n, depth + 1, list(ref)) for n in reversed(helper.children(node, min(64, 256 - len(nodes) - len(pending)))))
    refs.recheck()
    return {"readOnly": True, "authorization": False, "actionCount": 0, "nodes": nodes,
            "axToXidAssociationVerified": False, **FLAGS}


def probe(env):
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, Gio, GLib
    Atspi.set_timeout(1500, 1500)
    b, helper = base(), base().load_helper()
    output = BASE / "result"
    require(os.getuid() == os.geteuid() == UID and env.get("USER") == USER, "Only fixed synthetic UID may launch native fixture")
    require(HERE == BASE / "scripts" and HERE.stat().st_uid == 0 and stat.S_IMODE(HERE.stat().st_mode) == 0o755,
            "Root-installed fixture source required")
    require(output.resolve(strict=True) == output and output.stat().st_uid == UID and stat.S_IMODE(output.stat().st_mode) == 0o700,
            "Fresh private result directory required")
    record = {"scope": "synthetic-system-agent-attribution-only", "source": env["GITHUB_SHA"], "agentAttributed": False,
              "dialogContractCaptured": False, **FLAGS}
    agent = request = agent_log = request_log = x11 = axbus = None
    try:
        binding_file = BASE / "source-binding.json"
        require(binding_file.stat().st_uid == 0 and stat.S_IMODE(binding_file.stat().st_mode) == 0o644, "Root-owned source binding required")
        binding = b.unique_json(b.bounded_read(binding_file, 8192))
        require(binding["source"] == env["GITHUB_SHA"] and set(binding["files"]) == {*HELPERS, Path(__file__).name}, "Exact fixture source binding required")
        for name, digest in binding["files"].items():
            script = HERE / name
            require(script.resolve(strict=True) == script and script.stat().st_uid == 0
                    and stat.S_IMODE(script.stat().st_mode) == 0o644
                    and b.file_record(script, 256 * 1024)["sha256"] == digest, "Root-installed fixture source differs")
        record["scriptBinding"] = binding
        record["files"] = verify_files(output)
        for name in ("home", "home/config", "home/data", "home/cache", "tmp"):
            (output / name).mkdir(mode=0o700)
        child_env = finite_environment(env, output)
        require(re.fullmatch(r":[0-9]{1,5}", child_env.get("DISPLAY", "")) and child_env.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:"),
                "Private X11/session bus required")
        system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        record["session"] = session(system, os.getpid(), GLib)
        record["parent"] = parent = b.native_process(os.getpid(), helper)
        agent = subprocess.Popen([AGENT], env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        agent_log = b.Capture(agent, output, "agent")
        record["agent"] = identity = b.native_process(agent.pid, helper)
        own_agent(agent, identity, parent, helper)
        record["agentSession"] = session(system, agent.pid, GLib)
        require(all(record["agentSession"][key] == record["session"][key] for key in ("object", "Id", "User", "Leader")),
                "Agent and probe must share the same real session")
        record["registrationObservation"] = {}
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            own_agent(agent, identity, parent, helper)
            agent_log.pump(0.02)
            endpoint = registered_agent(system, identity, GLib, record["registrationObservation"])
            if endpoint is not None:
                break
        else:
            raise RuntimeError("Fixed agent registration deadline; no alternate agent/session fallback")
        record["systemBusAgent"] = endpoint
        record["agentAttributed"] = True
        request = subprocess.Popen(list(COMMAND), env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        request_log = b.Capture(request, output, "pkexec")
        record["pkexec"] = {"pid": request.pid, "command": list(COMMAND), "requestedProgram": "/usr/bin/true"}
        x11 = helper.X11()
        refs, axbus = b.native_ax_references()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            own_agent(agent, identity, parent, helper)
            agent_log.pump(0.02)
            request_log.pump()
            require(request.poll() is None, "pkexec completed without a captured dialog; no authentication claimed")
            native = windows(agent.pid, helper, x11)
            require(len(native) <= 1, "Ambiguous agent native windows")
            if not native:
                continue
            observed = raw_ax(identity, helper, Atspi, refs)
            if observed is None:
                continue
            # Retain unmodified bounded GTK names/roles before interpreting them.
            b.save_json(output / "original-gtk-contract.json", {"native": native, "ax": observed, **FLAGS})
            require(any(n["showing"] and n["role"] in (int(Atspi.Role.DIALOG), int(Atspi.Role.ALERT)) for n in observed["nodes"]),
                    "Agent GTK dialog role not captured; no title-based fallback")
            own_agent(agent, identity, parent, helper)
            require(windows(agent.pid, helper, x11) == native and registered_agent(system, identity, GLib) == endpoint,
                    "Native/system agent ownership changed during read-only capture")
            record["dialogContractCaptured"] = True
            record["native"] = native
            break
        else:
            raise RuntimeError("Agent GTK dialog deadline; no password/input fallback")
    except Exception as error:
        record["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
    finally:
        for name, child, capture in (("agent", agent, agent_log), ("pkexec", request, request_log)):
            if capture is not None:
                capture.pump()
                record[name + "Output"] = capture.metadata()
                capture.close()
            record[name + "ExitCode"] = None if child is None else child.poll()
        if axbus is not None:
            axbus.close_sync(None)
        if x11 is not None:
            x11.dispose()
        record["sessionTeardownRequired"] = True
        b.save_json(output / "polkit-report.json", record)
    require(record["dialogContractCaptured"] and "refusal" not in record, "Native polkit capture refused; original evidence retained")
    return record


def deadline_expired(_signum, _frame):
    raise TimeoutError("Native capture deadline")


def main():
    if sys.argv[1:] == ["source-contract"]:
        print(json.dumps(source_contract()))
        return
    admission(os.environ, sys.platform, platform.machine())
    if sys.argv[1:] == ["secure-stock-policy"]:
        print(json.dumps(secure_stock_policy(base().ordinary(os.environ["RUNNER_TEMP"]))))
        return
    require(sys.argv[1:] == ["probe"], "Use source-contract or fixed probe only")
    # Bound native RPC/tree collection without signalling any agent or dialog.
    signal.signal(signal.SIGALRM, deadline_expired)
    signal.alarm(60)
    try:
        print(json.dumps(probe(os.environ)))
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "captureStopped": True, **FLAGS}))
        sys.exit(1)
