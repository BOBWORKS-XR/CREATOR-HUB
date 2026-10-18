"""Disposable GNOME polkit capture or one exact Cancel; no authentication/updater."""
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
QUESTION = "Authentication is needed to run `/usr/bin/true' as the super user"
STOCK_POLICY = "/usr/share/polkit-1/actions/org.freedesktop.policykit.policy"
ADMIN_CONFIG = Path("/etc/polkit-1/localauthority.conf.d/51-ubuntu-admin.conf")
ADMIN_CONFIG_PIN = (65, "2d07cca6b69c06239f03a0ce8c0c0e95645deb1cbe67df22419ac78bb76bd348")
STOCK_ARCHIVE = ("https://archive.ubuntu.com/ubuntu/pool/main/p/policykit-1/polkitd_0.105-33ubuntu0.2_amd64.deb",
                 80152, "8a8e123a44e2c3deef2c072db7248e94d9d7ad7c874127facc7d1abaf622ea85")
HELPERS = {"native-linux-root-probe.py": "91983346c5bac811028135b41c11a0dfc10e40a61c9f65aab535df326e354e72",
           "native-unix-window.py": "a8aa761c41b26c4cd4a52f4f3c698046ca4cca20e97c08ee5cd41d68afbfb83f"}
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
    "polkit-gnome-0.105/src/polkitgnomeauthenticator.c": "8580c8f317dbf8bdaf2237ae98c9fccae879274abdea68cce8478e6a19339bc5",
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
    capture_mode(env)


def capture_mode(env):
    mode = env.get("CREATOR_LINUX_POLKIT_MODE", "read-only")
    require(mode in ("read-only", "cancel", "admin-capture"), "Unknown finite polkit fixture mode")
    require(mode == "read-only" or env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Non-default mode requires explicit manual CI mode")
    return mode


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
    authenticator = selected["polkit-gnome-0.105/src/polkitgnomeauthenticator.c"]
    require("polkit_unix_session_new_for_process_sync (getpid ()" in main
            and "POLKIT_AGENT_REGISTER_FLAGS_NONE" in main and AGENT_PATH in main
            and "polkit_agent_listener_register" in main and "goto out;" in main, "Session registration source differs")
    require("gtk_entry_set_visibility (GTK_ENTRY (dialog->priv->password_entry), FALSE)" in dialog
            and "GTK_RESPONSE_CANCEL" in dialog and "GTK_RESPONSE_OK" in dialog, "GTK dialog source differs")
    require("GTK_STOCK_CANCEL," in dialog and "gtk_widget_destroy (authenticator->dialog);" in authenticator,
            "Native Cancel/finalization source differs")
    require('TEXT_COL, _("Select user...")' in dialog and 'gtk_combo_box_set_active (GTK_COMBO_BOX (combo), 0);' in dialog
            and 'g_strv_length (dialog->priv->users) > 1' in dialog
            and 'dialog->priv->selected_user = g_strdup (dialog->priv->users[0]);' in dialog
            and 'g_ascii_strncasecmp (request, "password:", 9)' in authenticator
            and 'strcmp (g_get_user_name (), authenticator->selected_user)' in authenticator,
            "Native administrator-selection/prompt source differs")
    series = selected["debian/patches/series"].splitlines()
    patches = [selected["debian/patches/" + s.strip()] for s in series if s.strip() and not s.startswith("#")]
    require(len(patches) == 6 and sum("src/main.c" in patch for patch in patches) == 1
            and "register_client_to_gnome_session();" in selected["debian/patches/04-autorestart.patch"], "Ubuntu session patch set differs")
    return {"scope": "primary-source-contract-only", "archives": records, "sourceFiles": SOURCE_FILES,
            "requiresRealLogindSession": True, "dbusObjectPath": AGENT_PATH,
            "identitySelection": {"multiIdentityInitialLabel": "Select user...", "singleIdentitySelectsOnlyUser": True,
                                  "ownPasswordLabel": "Password:", "otherPasswordLabel": "Password for %s:"}, **FLAGS}


def admin_config():
    info = ADMIN_CONFIG.lstat()
    require(ADMIN_CONFIG.resolve(strict=True) == ADMIN_CONFIG and stat.S_ISREG(info.st_mode)
            and info.st_uid == info.st_gid == 0 and info.st_nlink == 1, "Exact ordinary root-owned stock admin mapping required")
    return base().pinned(ADMIN_CONFIG, ADMIN_CONFIG_PIN, 0o644)


def group_inventory():
    import grp
    entries = grp.getgrall()
    require(0 < len(entries) <= 256 and len({g.gr_name for g in entries}) == len(entries), "Bounded unique group inventory required")
    require(all(type(g.gr_gid) is int and g.gr_gid >= 0 and len(g.gr_mem) <= 128
                and type(g.gr_name) is str and 0 < len(g.gr_name) <= 128
                and all(type(n) is str and 0 < len(n) <= 128 for n in g.gr_mem)
                and len(set(g.gr_mem)) == len(g.gr_mem) for g in entries), "Ordinary bounded group memberships required")
    # Select public names/GIDs/members only, never credential fields.
    return {g.gr_name: {"gid": g.gr_gid, "members": sorted(g.gr_mem)} for g in entries}


def admin_group_delta(before, after):
    require("sudo" in before and before["sudo"]["gid"] not in (0, UID)
            and not any(USER in group["members"] for group in before.values()), "Fresh fixture must have no supplementary memberships")
    expected = {name: {"gid": group["gid"], "members": list(group["members"])} for name, group in before.items()}
    expected["sudo"]["members"] = sorted([*expected["sudo"]["members"], USER])
    require(after == expected, "Only the fresh fixture may be appended to sudo; all other memberships must stay identical")


def prepare_admin_capture(env, output):
    import pwd
    receipt = {"scope": "disposable-fresh-fixture-sudo-membership-only", "source": env["GITHUB_SHA"],
               "fixture": USER, "uid": UID, "group": "sudo", "passwordProvisioned": False, "policyChanged": False,
               "membershipVerified": False, "phase": "fresh-identity-preflight", **FLAGS}
    try:
        require(capture_mode(env) == "admin-capture" and os.getuid() == os.geteuid() and os.getuid() not in (0, UID),
                "Only disposable provisioning runner may prepare manual admin capture")
        require(not (BASE / "result/home").exists(), "Refusing an already used fixture session")
        account = pwd.getpwnam(USER)
        identity = (account.pw_uid, account.pw_gid, account.pw_dir, account.pw_shell)
        require(identity == (UID, UID, "/var/lib/creator-polkit-fixture", "/bin/bash"), "Exact freshly created fixture identity required")
        require(set(os.getgrouplist(USER, UID)) == {UID}, "Fixture already has supplementary groups")
        before, policy = group_inventory(), admin_config()
        require("sudo" in before and before["sudo"]["gid"] not in (0, UID)
                and not any(USER in group["members"] for group in before.values()), "Fresh fixture must have no supplementary memberships")
        receipt["phase"] = "append-only-sudo"
        code, _raw = base().run_tool(output, "admin-capture-group-append",
            ["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "sudo", USER], seconds=8)
        require(code == 0, "Fixed fixture-only supplementary-group append failed")
        after = group_inventory()
        admin_group_delta(before, after)
        account = pwd.getpwnam(USER)
        require((account.pw_uid, account.pw_gid, account.pw_dir, account.pw_shell) == identity
                and set(os.getgrouplist(USER, UID)) == {UID, before["sudo"]["gid"]},
                "Fixture account or supplementary groups differ after append")
        require(admin_config() == policy, "Stock admin mapping changed")
        receipt.update(membershipVerified=True, sudoGid=before["sudo"]["gid"], otherMembershipsPreserved=True,
            phase="membership-verified",
            beforeMembershipSha256=hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
            afterMembershipSha256=hashlib.sha256(json.dumps(after, sort_keys=True).encode()).hexdigest(), stockAdminMapping=policy)
    except Exception as error:
        receipt["refusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        raise
    finally:
        base().save_json(output / "polkit-admin-group-preflight.json", receipt)
    return receipt


def admin_identity_observation(observed, atspi):
    """Retain actual names/roles only; never select an identity or infer one."""
    require(observed["readOnly"] and observed["actionCount"] == 0 and not observed["authorization"], "Read-only native capture required")
    selectors = {getattr(atspi.Role, key, -1) for key in ("COMBO_BOX", "MENU", "MENU_ITEM", "LIST", "LIST_ITEM", "RADIO_BUTTON")}
    labels, selection, passwords = [], [], []
    for row in observed["nodes"]:
        if row["role"] == int(atspi.Role.PASSWORD_TEXT):
            require(row["editableOrPasswordOmitted"] and "name" not in row and "text" not in row, "Password content must remain omitted")
            passwords.append({key: row[key] for key in ("reference", "role", "showing", "enabled", "sensitive", "editableOrPasswordOmitted")})
        elif row["role"] in selectors:
            selection.append(row)
        elif row["role"] == int(atspi.Role.LABEL) and row.get("name"):
            labels.append(row)
    return {"readOnly": True, "actionCount": 0, "identitySelected": False, "selectedIdentityVerified": False,
            "labels": labels, "selectorNodes": selection, "passwordNodes": passwords, **FLAGS}


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


def agent_bus_identity(bus, agent, glib, observation=None):
    """Find the held agent's unique connection, not proof of registration."""
    authority = bus_identity(bus, "org.freedesktop.PolicyKit1", glib)
    require(authority["uid"] == 0, "Root-owned system authority required")
    names = dbus_call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames", None, (), "(as)", glib)[0]
    require(len(names) <= 256, "System bus name inventory exceeds bound")
    if observation is not None:
        observation.clear()
        observation.update(readOnly=True, authorization=False, actionCount=0, authority=authority,
                           objectPath=AGENT_PATH, registrationProven=False, candidates=[])
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
            # Stock system.conf denies unlisted method calls; polkit 0.105's
            # PolicyKit1.conf grants root the agent interface, not our UID
            # Introspect access. This read is diagnostic, never registration proof.
            try:
                xml = dbus_call(bus, name, AGENT_PATH, "org.freedesktop.DBus.Introspectable", "Introspect", None, (), "(s)", glib)[0]
                require(type(xml) is str and len(xml.encode()) <= 32768, "Bounded source object introspection required")
                document = ET.fromstring(xml)
                interface_names = [i.get("name", "") for i in document.findall("interface")]
                require(len(interface_names) <= 32 and all(len(n) <= 128 for n in interface_names), "Bounded source interface names required")
                candidate.update(interfaces=interface_names, introspectionSha256=hashlib.sha256(xml.encode()).hexdigest())
                interfaces = document.findall("interface[@name='org.freedesktop.PolicyKit1.AuthenticationAgent']")
                methods = {m.attrib["name"]: [a.attrib["type"] for a in m.findall("arg") if a.get("direction", "in") == "in"]
                           for m in interfaces[0].findall("method")} if len(interfaces) == 1 else None
                candidate["sourceInterfaceMatches"] = methods == {
                    "BeginAuthentication": ["s", "s", "s", "a{ss}", "s", "a(sa{sv})"], "CancelAuthentication": ["s"]}
            except Exception as error:
                # No cookies or passwords in this fixed, argument-free read.
                candidate["introspectionRefusal"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        require(bus_identity(bus, name, glib) == identity, "Source agent bus identity changed")
        matches.append({**identity, "authority": authority, "objectPath": AGENT_PATH})
    require(bus_identity(bus, "org.freedesktop.PolicyKit1", glib) == authority, "System authority changed")
    require(len(matches) <= 1, "Ambiguous system agent connection")
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


def cancel_profile(agent, helper, atspi, refs, x11, native, geometry):
    """Exact native GNOME profile; never query a password name/text/action."""
    require(len(native) == 1 and native[0]["pid"] == agent["pid"] and native[0]["client"] > 0
            and native[0]["mapped"] and native[0]["title"] == "Authenticate", "Exact single owned native dialog required")
    require(windows(agent["pid"], helper, x11) == native, "Native dialog changed before profile")
    frame = x11.frame_rectangle(native[0]["window"])
    geometry.update(nativeFrame=None if frame is None else list(frame), axFrame=None)
    require(type(frame) is tuple and len(frame) == 4 and all(type(v) is int for v in frame)
            and all(0 <= v <= 8192 for v in frame[:2]) and all(0 < v <= 8192 for v in frame[2:]), "Bounded native Cancel frame required")
    owner = type("Owner", (), {"root": agent, "renderer": None})()
    refs.recheck()
    apps = [a for a in helper.fresh_close_children(atspi.get_desktop(0), 64) if a.get_process_id() == agent["pid"]]
    require(len(apps) == 1, "Exactly one agent AX application required")
    app = apps[0]
    app.clear_cache()
    require(app.get_role() == atspi.Role.APPLICATION and app.get_name() == "polkit-gnome-authentication-agent-1",
            "Exact native agent application required")
    root_ref = tuple(refs.identity(app, owner))
    tops = helper.fresh_close_children(app, 16)
    require(len(tops) == 1, "Exactly one agent AX top-level required")
    dialog = tops[0]
    graph, nodes, seen, pending = [], [], set(), [(dialog, root_ref, 0)]
    window_roles = {getattr(atspi.Role, k, -1) for k in ("APPLICATION", "DIALOG", "ALERT", "FRAME", "WINDOW")}
    while pending:
        node, parent, depth = pending.pop()
        require(node is not None and len(graph) < 64 and depth < 16, "Cancel graph exceeds bound")
        node.clear_cache()
        require(node.get_process_id() == agent["pid"], "Foreign Cancel graph PID")
        ref = tuple(refs.identity(node, owner))
        require(ref[0] == root_ref[0] and ref not in seen, "Foreign/duplicate Cancel graph reference")
        seen.add(ref)
        actual_parent = node.get_parent()
        require(actual_parent is not None and tuple(refs.identity(actual_parent, owner)) == parent,
                "Cancel graph reverse parent differs")
        role, states = node.get_role(), node.get_state_set()
        password = role == atspi.Role.PASSWORD_TEXT
        require(password or not states.contains(atspi.StateType.EDITABLE), "Unexpected editable Cancel graph node")
        name = None if password else node.get_name()
        require(name is None if password else type(name) is str and len(name) <= 1024, "Cancel graph name exceeds bound")
        if depth == 0:
            require(role == atspi.Role.DIALOG and name == "Authenticate", "Exact GTK dialog role/name required")
        else:
            require(role not in window_roles, "Nested Cancel graph window")
        row = {"reference": list(ref), "parent": list(parent), "role": int(role), "name": name,
               **{s.lower(): states.contains(getattr(atspi.StateType, s)) for s in ("SHOWING", "ENABLED", "SENSITIVE", "DEFUNCT", "BUSY")}}
        graph.append(row)
        nodes.append(node)
        pending.extend((child, ref, depth + 1) for child in reversed(
            helper.fresh_close_children(node, min(32, 64 - len(graph) - len(pending)))))
    labels = [n for n, row in zip(nodes, graph) if row["role"] == int(atspi.Role.LABEL) and row["name"] == QUESTION]
    buttons = [(n, row) for n, row in zip(nodes, graph) if row["role"] == int(atspi.Role.PUSH_BUTTON)]
    passwords = [n for n, row in zip(nodes, graph) if row["role"] == int(atspi.Role.PASSWORD_TEXT)]
    require(len(labels) == len(passwords) == 1 and len(buttons) == 2
            and {row["name"] for _n, row in buttons} == {"Cancel", "Authenticate"}, "Exact question/buttons/password profile required")
    for node in [dialog, *labels, *passwords, *(n for n, _row in buttons)]:
        helper.ready(node, atspi)
    component = dialog.get_component_iface()
    require(component is not None, "Cancel dialog Component unavailable")
    rect = component.get_extents(atspi.CoordType.SCREEN)
    actual = (rect.x, rect.y, rect.width, rect.height)
    geometry["axFrame"] = list(actual)
    # GTK 3.24.33 gtkwindowaccessible.c uses gdk_window_get_frame_extents,
    # not client bounds. Unknown geometry is retained and refuses input.
    require(all(type(v) is int for v in actual) and actual == frame, "Cancel AX/native frame differs")
    controls = {}
    for node, row in buttons:
        component = node.get_component_iface()
        require(component is not None, "Cancel control Component unavailable")
        rect = component.get_extents(atspi.CoordType.SCREEN)
        bounds = (rect.x, rect.y, rect.width, rect.height)
        require(all(type(v) is int for v in bounds) and bounds[2] > 0 and bounds[3] > 0
                and bounds[0] >= frame[0] and bounds[1] >= frame[1]
                and bounds[0] + bounds[2] <= frame[0] + frame[2]
                and bounds[1] + bounds[3] <= frame[1] + frame[3], "Cancel control outside native frame")
        controls[row["name"]] = list(bounds)
    refs.recheck()
    require(windows(agent["pid"], helper, x11) == native and x11.frame_rectangle(native[0]["window"]) == frame,
            "Cancel native ownership/frame changed")
    receipt = {"graph": graph, "native": native, "frame": list(frame), "controls": controls,
               "application": list(root_ref), "axToXidAssociationVerified": True, "passwordRead": False}
    return next(n for n, row in buttons if row["name"] == "Cancel"), receipt


def cancel_once(profile, guard, record):
    """One finite Cancel action, including ambiguous-return failure; no retry."""
    require(record.get("mode") == "cancel" and record.get("cancelActionAttempts", 0) == 0, "Cancel mode/unused action required")
    guard()
    _first, before = profile()
    record["cancelProfile"] = before
    guard()
    button, current = profile()
    require(current == before, "Fresh Cancel graph/frame changed")
    guard()
    button, current = profile()
    require(current == before, "Final Cancel graph/frame changed")
    interface = button.get_action_iface()
    require(interface is not None and interface.get_n_actions() == 1 and interface.get_action_name(0) == "click",
            "Exactly one native Cancel click required")
    record.update(dialogInputAuthorized=True, authorizedControl="Cancel", cancelActionAttempts=1, actionMayHaveRun=True)
    require(interface.do_action(0), "Cancel action refused or uncertain; do not retry")
    record["cancelActionReturned"] = True


def native_window_absence(x11, helper, target, observation):
    """Complete bounded server tree, not an EWMH hint or swallowed X error."""
    c = helper.C
    query = x11.x.XQueryTree
    query.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
                      c.POINTER(c.POINTER(c.c_ulong)), c.POINTER(c.c_uint)]
    query.restype = c.c_int
    root = x11.x.XDefaultRootWindow(x11.display)
    require(type(target) is int and target > 0 and target != root, "Exact non-root target XID required")
    observation.clear()
    observation.update(source="complete-native-XQueryTree", root=root, target=target, complete=False)
    pending, seen = [(root, 0, 0)], set()
    while pending:
        xid, expected_parent, depth = pending.pop()
        require(xid not in seen and len(seen) < 256 and depth < 16, "Native dismissal tree exceeds bound")
        seen.add(xid)
        observation.update(lastQuery=xid, nodes=len(seen))
        root_out, parent, count = c.c_ulong(), c.c_ulong(), c.c_uint()
        children = c.POINTER(c.c_ulong)()
        try:
            require(query(x11.display, xid, c.byref(root_out), c.byref(parent), c.byref(children), c.byref(count)),
                    "Native dismissal query failed")
            x11.sync()
            require(root_out.value == root and parent.value == expected_parent and count.value <= 64
                    and len(seen) + len(pending) + count.value <= 256
                    and (not count.value or bool(children)), "Native dismissal tree changed or exceeds bound")
            pending.extend((children[i], xid, depth + 1) for i in range(count.value))
        finally:
            if children:
                x11.x.XFree(children)
    observation.update(complete=True, absent=target not in seen)
    return observation


def wait_cancel(request, request_log, guard, x11, helper, target, record):
    deadline = time.monotonic() + 10
    record["cancelDismissal"] = {}
    while time.monotonic() < deadline:
        guard()
        request_log.pump(0.02)
        exit_code = request.poll()
        require(exit_code is None or exit_code == 126, "pkexec did not return cancellation status 126")
        native_window_absence(x11, helper, target, record["cancelDismissal"])
        if exit_code == 126 and record["cancelDismissal"]["complete"] and record["cancelDismissal"]["absent"]:
            record["cancelAccepted"] = True
            return
    raise RuntimeError("Cancel completion deadline; no retry or force-close")


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
    record = {"scope": "synthetic-system-agent-attribution-only", "source": env["GITHUB_SHA"], "mode": capture_mode(env),
              "agentAttributed": False, "agentOperationObserved": False, "dialogContractCaptured": False,
              "cancelActionAttempts": 0, "actionMayHaveRun": False, **FLAGS}
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
        if record["mode"] == "admin-capture":
            import grp
            admin = grp.getgrnam("sudo")
            require(USER in admin.gr_mem and admin.gr_gid in os.getgroups(), "Fresh synthetic administrator not in actual session groups")
            record["adminMembership"] = {"fixture": USER, "uid": UID, "sudoGid": admin.gr_gid,
                                         "sessionGroupVerified": True, "stockAdminMapping": admin_config(), "passwordProvisioned": False}
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
        record["agentBusObservation"] = {}
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            own_agent(agent, identity, parent, helper)
            agent_log.pump(0.02)
            endpoint = agent_bus_identity(system, identity, GLib, record["agentBusObservation"])
            if endpoint is not None:
                break
        else:
            raise RuntimeError("Fixed agent bus-identity deadline; no alternate agent/session fallback")
        record["systemBusAgent"] = endpoint
        x11 = helper.X11()
        require(not windows(agent.pid, helper, x11), "Agent already has a window before the fixed request")
        request = subprocess.Popen(list(COMMAND), env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        request_log = b.Capture(request, output, "pkexec")
        record["pkexec"] = {"pid": request.pid, "command": list(COMMAND), "requestedProgram": "/usr/bin/true"}
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
            require(any(n["showing"] and not n["defunct"] and n["role"] in (int(Atspi.Role.DIALOG), int(Atspi.Role.ALERT)) for n in observed["nodes"]),
                    "Agent GTK dialog role not captured; no title-based fallback")
            own_agent(agent, identity, parent, helper)
            for pid, original in ((os.getpid(), record["session"]), (agent.pid, record["agentSession"])):
                current = session(system, pid, GLib)
                require(all(current[key] == original[key] for key in ("object", "Id", "User", "Leader")), "Real session binding changed")
            require(windows(agent.pid, helper, x11) == native and agent_bus_identity(system, identity, GLib) == endpoint,
                    "Native/system agent ownership changed during read-only capture")
            require(request.poll() is None, "Fixed request ended during capture; no authentication claimed")
            record["agentOperationObserved"] = True
            record["agentAttributed"] = True
            record["dialogContractCaptured"] = True
            record["native"] = native
            break
        else:
            raise RuntimeError("Agent GTK dialog deadline; no password/input fallback")
        if record["mode"] == "admin-capture":
            record["adminIdentityObservation"] = admin_identity_observation(observed, Atspi)
        if record["mode"] == "cancel":
            def guard():
                own_agent(agent, identity, parent, helper)
                for pid, original in ((os.getpid(), record["session"]), (agent.pid, record["agentSession"])):
                    current = session(system, pid, GLib)
                    require(all(current[k] == original[k] for k in ("object", "Id", "User", "Leader")), "Cancel session changed")
                require(agent_bus_identity(system, identity, GLib) == endpoint, "Cancel system-bus binding changed")
                refs.recheck()

            record["cancelGeometry"] = {}
            def profile():
                require(request.poll() is None, "Fixed request ended before Cancel")
                return cancel_profile(identity, helper, Atspi, refs, x11, native, record["cancelGeometry"])

            cancel_once(profile, guard, record)
            wait_cancel(request, request_log, guard, x11, helper, native[0]["window"], record)
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
    require(record["dialogContractCaptured"] and "refusal" not in record
            and (record["mode"] in ("read-only", "admin-capture") or record["cancelAccepted"]), "Native polkit capture refused; original evidence retained")
    return record


def deadline_expired(_signum, _frame):
    raise TimeoutError("Native capture deadline")


def main():
    if sys.argv[1:] == ["source-contract"]:
        print(json.dumps(source_contract()))
        return
    admission(os.environ, sys.platform, platform.machine())
    if sys.argv[1:] == ["prepare-admin-capture"]:
        print(json.dumps(prepare_admin_capture(os.environ, base().ordinary(os.environ["RUNNER_TEMP"]))))
        return
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
        print(json.dumps({"error": type(error).__name__, "captureStopped": True, "inputOutcomeInRetainedReport": True,
                          **{k: v for k, v in FLAGS.items() if k not in ("dialogInputAuthorized", "cancelAccepted")}}))
        sys.exit(1)
