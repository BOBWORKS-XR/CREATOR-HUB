"""Focused prerequisites for native DEB 14 -> acceptance-only 15, not acceptance.

No launcher, installer, signing, transport interception or authentication policy.
The generated Rust example links the real catalog and package-target source.
Native control helpers reuse the existing strict Root/components ownership walk.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
FALSE_GATES = {key: False for key in (
    "signedUpdateAccepted", "restartAccepted", "viewsRestored", "migrationAccepted", "releaseReady")}
CONTROLS = {"check-updates": ("Check for updates", "Creator Hub update"),
            "update-hub": ("Update Hub", "Creator Hub update")}
PRESERVED_FILES = (
    "home/config/creator-works-mcp/launcher-config.json",
    "home/data/CreatorProjectSetup/editor-roots.json",
    "home/data/CreatorHub/preferences/hub-preferences.json",
    "home/data/CreatorHub/consent/hub-usage-terms.json",
    "fixture-server.mjs",
)
BACKUPS = "home/config/creator-works-mcp/.creator-hub-settings-backups"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def components():
    # Its loader independently pins Root bytes; do not duplicate its authority.
    spec = importlib.util.spec_from_file_location("update_reviewed_components", HERE / "native-linux-components-probe.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def press_update_control(action, owner, atspi):
    """One fixed WebKit action; caller must already own Root and its renderer."""
    require(action in CONTROLS, "Unreviewed updater action")
    c = components()
    name, heading = CONTROLS[action]

    def select():
        window = owner.helper.select_window(owner.request, atspi)
        shown = c.visible(c.own_tree(window, owner, atspi), atspi)
        require(any(n.get_name() == heading and n.get_role() == atspi.Role.HEADING for n in shown),
                "Exact updater heading required")
        matches = [n for n in shown if n.get_name() == name and n.get_role() == atspi.Role.PUSH_BUTTON]
        require(len(matches) == 1, "Exact unique updater button required")
        node = matches[0]
        owner.helper.ready(node, atspi)
        require(owner.renderer is not None and node.get_process_id() == owner.renderer["pid"],
                "Updater button is not in the bound renderer")
        interface = node.get_action_iface()
        require(interface and interface.get_n_actions() == 1 and interface.get_action_name(0) == "press",
                "Exact WebKit press action required")
        return node, interface

    first, _ = select()
    second, interface = select()
    require(owner.same_node(first, second), "Updater button changed before action")
    owner.recheck(full=True)
    try:
        require(interface.do_action(0), "Updater press refused; no automatic retry")
    except Exception as error:
        raise owner.helper.ActionError(str(error)) from error
    return {"action": action, "actionCount": 1, "ownership": owner.evidence(), **FALSE_GATES}


def preservation_snapshot(root, b):
    """Hash fixed component-fixture paths under the caller's admitted probe root.

    Take after native preference save and before update; the restore ticket is
    deliberately excluded because production creates and consumes it separately.
    """
    root = b.ordinary(root)
    files = {name: b.file_record(root / name, 131072) for name in PRESERVED_FILES}
    directory = root / BACKUPS
    require(directory.is_dir() and not directory.is_symlink(), "Real native-save backup directory required")
    b.ordinary(directory)
    before = directory.stat()
    names = []
    with os.scandir(directory) as entries:
        for entry in entries:
            require(len(names) < 32, "Native-save backup inventory exceeds bound")
            names.append(entry.name)
    names.sort()
    require(names, "Nonempty bounded native-save backup inventory required")
    for name in names:
        match = re.fullmatch(r"launcher-config\.json\.([a-f0-9]{64})\.bak", name)
        require(match is not None,
                "Unexpected native-save backup member")
        record = b.file_record(directory / name, 131072)
        require(record["sha256"] == match[1], "Native-save backup differs from its content address")
        files[BACKUPS + "/" + name] = record
    after = directory.stat()
    fields = ("st_dev", "st_ino", "st_mode", "st_mtime_ns", "st_ctime_ns")
    require(all(getattr(before, k) == getattr(after, k) for k in fields), "Backup inventory changed during capture")
    require(stat.S_ISDIR(after.st_mode), "Backup directory changed type")
    return files


def require_preserved(root, before, b):
    after = preservation_snapshot(root, b)
    require(after == before, "Settings, acknowledgement, backup bytes or file identity changed")
    return {"preservedFixtureFiles": len(after), **FALSE_GATES}


def release_verifier_source():
    """Emit an example for a disposable checkout's src-tauri/examples directory.

    Uses its existing Cargo.toml/Cargo.lock, no alternate key or catalog parser.
    Compilation and authentic positive input execution are not claimed here.
    """
    return r'''// Acceptance-input verification only. Never installs or grants UI authority.
#[allow(dead_code)]
#[path = "../src/catalog.rs"]
mod catalog;
#[allow(dead_code)]
#[path = "../src/update_target.rs"]
mod update_target;

use base64::Engine;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

fn bounded(path: &Path, max: u64) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() == 0 || before.len() > max {
        return Err("Nonempty bounded regular release input required".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != before.len() { return Err("Release input size changed".into()); }
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 { return Err("Use SIGNED_DIRECTORY DEB EXTRACTED_EXECUTABLE".into()); }
    if std::env::consts::OS != "linux" || std::env::consts::ARCH != "x86_64" {
        return Err("Native Linux x86_64 required".into());
    }
    let target = update_target::Target::select("linux", "x86_64", Some(tauri::utils::config::BundleType::Deb))?;
    if target.descriptor() != "creator-hub-linux-x86_64-deb.json" || target.updater_key() != "linux-x86_64-deb" {
        return Err("Production Linux DEB target changed".into());
    }
    let directory = Path::new(&args[0]);
    let descriptor = bounded(&directory.join(target.descriptor()), catalog::MAX_METADATA)?;
    let detached = bounded(&directory.join(format!("{}.minisig", target.descriptor())), 4096)?;
    let release = catalog::verify_signed_target("creator-hub", &descriptor, &detached, false, target)?;
    if env!("CARGO_PKG_VERSION") != "0.1.14" || release.version != "0.1.15"
        || release.min_hub_version != "0.1.14" || release.required_hub_version().is_some()
        || release.installer_protocol != 1 {
        return Err("Only new 14 -> acceptance-only 15 with guarded installer protocol is admitted".into());
    }
    let deb = Path::new(&args[1]);
    let bytes = bounded(deb, catalog::MAX_ARTIFACT)?;
    let executable = bounded(Path::new(&args[2]), 256 * 1024 * 1024)?;
    if deb.file_name().and_then(|n| n.to_str()) != Some(release.asset_name.as_str())
        || bytes.len() as u64 != release.byte_length || digest(&bytes) != release.sha256
        || digest(&executable) != release.executable_sha256 {
        return Err("Release package/executable differ from signed descriptor".into());
    }
    let manifest: serde_json::Value = serde_json::from_slice(&bounded(&directory.join("latest.json"), catalog::MAX_METADATA)?)?;
    let platforms = manifest["platforms"].as_object().ok_or("Missing updater platforms")?;
    if platforms.len() != 1 || !platforms.contains_key(&target.updater_key()) {
        return Err("Expected only the Linux DEB updater platform".into());
    }
    let entry = platforms.get(&target.updater_key()).ok_or("Missing Linux DEB platform")?;
    let url = catalog::release_url("CREATOR-HUB", &release.version, &release.asset_name);
    if manifest["version"] != release.version || entry["url"] != url {
        return Err("Updater URL/version differ from signed descriptor".into());
    }
    let encoded = entry["signature"].as_str().ok_or("Missing installer signature")?;
    if encoded.len() > 8192 { return Err("Oversized installer signature".into()); }
    let signature = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    if base64::engine::general_purpose::STANDARD.encode(&signature) != encoded {
        return Err("Noncanonical installer signature".into());
    }
    let signature = minisign_verify::Signature::decode(std::str::from_utf8(&signature)?)?;
    let key = minisign_verify::PublicKey::decode(include_str!("../src/catalog-key.pub"))?;
    key.verify(&bytes, &signature, false)?;
    let mut changed_descriptor = descriptor.clone();
    changed_descriptor[0] ^= 1;
    if catalog::verify_signed_target("creator-hub", &changed_descriptor, &detached, false, target).is_ok() {
        return Err("Changed descriptor was accepted".into());
    }
    let foreign = update_target::Target::select("windows", "x86_64", None)?;
    if catalog::verify_signed_target("creator-hub", &descriptor, &detached, false, foreign).is_ok() {
        return Err("Linux descriptor was accepted as Windows".into());
    }
    let mut changed_package = bytes;
    changed_package[0] ^= 1;
    if key.verify(&changed_package, &signature, false).is_ok() {
        return Err("Changed installer was accepted".into());
    }
    println!("{}", serde_json::json!({"releaseInputsVerified": true,
        "version": release.version, "sha256": release.sha256,
        "executableSha256": release.executable_sha256, "nativeAcceptance": false,
        "signedUpdateAccepted": false, "restartAccepted": false, "releaseReady": false}));
    Ok(())
}
'''


def prerequisites():
    c = components()
    return {"status": "blocked", "scope": "linux-deb-outgoing-14-to-acceptance-only-15",
            "existingPinnedOuterSource": c.B.GTK3_REVIEWED_PINS["SOURCE"],
            "existingPinnedPrivateSource": c.B.GTK3_REVIEWED_PINS["PRIVATE_SOURCE"],
            "missing": [
                "Reviewed successful fresh producer/handoff/outer-14 pins including current Linux updater source",
                "Immutable outer-only signed 15 DEB, extracted image, descriptor and latest.json",
                "Acceptance transport for actual catalog discovery and exact GitHub release URLs, without cache seeding",
                "Exact Root PID/start/image/XRes updater confirmation GTK/AT-SPI contract",
                "Exact system-agent PID/start/UID/image/XRes/action ownership and real Cancel/authentication contract",
                "Strict embedded component tree and native preference-save/backup proof before update",
                "Automatic restart identity/lifetime capture and actual restored-view acceptance"],
            "legacy12": "One-time manual package migration, not signed in-app update acceptance",
            **FALSE_GATES}


def main(args):
    if args == ["verifier-source"]:
        print(release_verifier_source(), end="")
        return 0
    require(args == ["prerequisites"], "Use prerequisites or verifier-source; no full-flow action is admitted")
    print(json.dumps(prerequisites(), ensure_ascii=True))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        print(json.dumps({"error": str(error)[:1000], **FALSE_GATES}))
        sys.exit(1)
