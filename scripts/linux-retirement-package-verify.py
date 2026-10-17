"""Read-only DEB header/byte/policy audit. Never extracts or installs system files."""
import email.parser
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET

HELPER = "usr/libexec/creator-hub-deb-retirement-helper"
POLICY = "usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy"
PARENTS = {"usr", "usr/libexec", "usr/share", "usr/share/polkit-1", "usr/share/polkit-1/actions"}
ACTION = "com.creatorworks.hub.deb-retirement"
LIMIT = 512 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def policy(bytes_):
    require(len(bytes_) <= 16 * 1024 and b"<!ENTITY" not in bytes_, "Unexpected policy declarations")
    root = ET.fromstring(bytes_)
    require(root.tag == "policyconfig" and not root.attrib, "Unknown policy root")
    # polkit 0.105 selects by path only; it does not implement exec.argv1.
    require([node.tag for node in root] == ["vendor", "action"], "Exactly one fixed-path policy action required")
    for action in root.findall("action"):
        identifier = action.get("id")
        require(action.attrib == {"id": ACTION} and identifier == ACTION, "Unknown authorization action")
        require([node.tag for node in action] == ["description", "message", "defaults", "annotate"],
                "Unknown authorization fields")
        require(action.findtext("description") and "TEST ONLY" in action.findtext("message", ""), "Missing test-only consent")
        defaults = action.find("defaults")
        require(not defaults.attrib and [node.tag for node in defaults] == ["allow_any", "allow_inactive", "allow_active"],
                "Unknown policy defaults")
        require(all(node.text == "auth_admin" and not node.attrib and not list(node) for node in defaults),
                "Every context must require uncached administrator authentication")
        annotations = action.findall("annotate")
        require([node.attrib for node in annotations] == [{"key": "org.freedesktop.policykit.exec.path"}],
                "No unsupported argument annotations, GUI forwarding or extra authority allowed")
        require([node.text for node in annotations] == ["/" + HELPER], "Only the exact helper is authorized")


def members(stream):
    seen, total = set(), 0
    with tarfile.open(fileobj=stream, mode="r|*") as archive:
        for member in archive:
            raw = member.name.removeprefix("./")
            name = raw.rstrip("/") if member.isdir() else raw
            if name in ("", "."):
                require(member.isdir() and member.uid == member.gid == 0 and member.mode == 0o755,
                        "Archive root must be a protected directory")
                continue
            require(not name.startswith("/") and all(part not in ("", ".", "..") for part in name.split("/")),
                    "Noncanonical archive member")
            require(name not in seen and len(seen) < 256, "Duplicate or excessive package members")
            seen.add(name)
            require(member.isfile() or member.isdir(), "Package links and special files refused")
            total += member.size
            require(0 <= member.size <= LIMIT and total <= LIMIT, "Package data exceeds bound")
            yield name, member, archive


def data(stream, helper_hash, policy_hash):
    expected = {HELPER: (helper_hash, 0o755), POLICY: (policy_hash, 0o644)}
    found, parents = {}, set()
    for name, member, archive in members(stream):
        require(not name.startswith("etc/") and not name.endswith((".rules", ".pkla")), "System policy/config overrides refused")
        if name in PARENTS:
            require(member.isdir() and member.uid == member.gid == 0 and member.mode == 0o755,
                    "Protected helper/policy ancestors must be root-owned mode 0755 directories")
            parents.add(name)
        if name not in expected:
            require(not name.endswith(".policy"), "Additional authorization policy refused")
            require(not (member.isfile() and name.startswith("usr/libexec/")), "Additional privileged helper refused")
            continue
        digest, mode = expected[name]
        require(member.isfile() and member.uid == member.gid == 0 and member.mode == mode,
                "Wrong helper/policy kind, numeric ownership or mode")
        require(member.size <= 32 * 1024 * 1024, "Helper/policy exceeds bound")
        bytes_ = archive.extractfile(member).read()
        require(len(bytes_) == member.size and hashlib.sha256(bytes_).hexdigest() == digest, "Helper/policy bytes changed")
        if name == POLICY:
            policy(bytes_)
        else:
            require(len(bytes_) >= 20 and bytes_[:6] == b"\x7fELF\x02\x01" and bytes_[18:20] == b"\x3e\x00",
                    "Native Linux x86_64 ELF helper required")
        found["/" + name] = {"sha256": digest, "size": len(bytes_), "mode": mode, "uid": 0, "gid": 0}
    require(set(found) == {"/" + name for name in expected} and parents == PARENTS, "Incomplete helper/policy installation payload")
    return found


def control(stream, version):
    found = {}
    for name, member, archive in members(stream):
        require(name in ("control", "md5sums") and member.isfile() and member.uid == member.gid == 0,
                "No maintainer scripts, conffiles or triggers admitted")
        require(member.size <= 128 * 1024, "Oversized control member")
        found[name] = archive.extractfile(member).read()
    require(set(found) == {"control", "md5sums"}, "Incomplete DEB control")
    fields = email.parser.Parser().parsestr(found["control"].decode("utf-8"))
    require(all(len(fields.get_all(key)) == 1 for key in fields.keys()), "Duplicate DEB control fields")
    require(fields["Package"] == "creator-hub" and fields["Architecture"] == "amd64"
            and fields["Version"] == version and fields.get("Description", "").startswith("TEST ONLY - "), "Wrong test package identity")
    require(not any(key in fields for key in ("Pre-Depends", "Conflicts", "Breaks", "Replaces", "Conffiles")),
            "Unexpected package transaction relationships")
    dependencies = {part.strip() for part in fields.get("Depends", "").split(",") if part.strip()}
    require({"policykit-1", "libwebkit2gtk-4.1-0", "libgtk-3-0"} <= dependencies, "Required native dependencies omitted")


def verify(package, helper_hash, policy_hash, version):
    require(all(re.fullmatch(r"[a-f0-9]{64}", digest) for digest in (helper_hash, policy_hash)), "Invalid expected digest")
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
    result = None
    for argument in ("--ctrl-tarfile", "--fsys-tarfile"):
        with tempfile.TemporaryFile() as output:
            process = subprocess.run(["/usr/bin/dpkg-deb", argument, package], stdout=output,
                                     stderr=subprocess.PIPE, env=env, cwd="/", timeout=120, check=False)
            require(process.returncode == 0 and not process.stderr, "DEB read-only query failed or emitted diagnostics")
            require(output.tell() <= LIMIT, "DEB tar output exceeds bound")
            output.seek(0)
            if argument == "--ctrl-tarfile":
                control(output, version)
            else:
                result = data(output, helper_hash, policy_hash)
    return {"files": result}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 5, "Expected DEB, helper SHA256, policy SHA256 and version")
        print(json.dumps(verify(*sys.argv[1:])))
    except (ValueError, OSError, tarfile.TarError, ET.ParseError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
