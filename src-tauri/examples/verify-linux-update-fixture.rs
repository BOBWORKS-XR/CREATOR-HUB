//! Offline acceptance-input verification, not a native install/update/restart test.
#[allow(dead_code)]
#[path = "../src/catalog.rs"]
mod catalog;
#[allow(dead_code)]
#[path = "../src/update_target.rs"]
mod update_target;

use base64::Engine;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

const SOURCE_VERSION: &str = "0.1.14";
const TARGET_VERSION: &str = "0.1.15";
const ASSET: &str = "Creator_Hub_0.1.15_amd64-acceptance-only.deb";
const PLATFORM_KEY: &str = "linux-x86_64-deb";
const URL: &str = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/Creator_Hub_0.1.15_amd64-acceptance-only.deb";

fn bounded(path: &Path, max: u64) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let before = fs::symlink_metadata(path)?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() == 0
        || before.len() > max
    {
        return Err("Nonempty bounded regular release input required".into());
    }
    let file = fs::File::open(path)?;
    if file.metadata()?.len() != before.len() {
        return Err("Release input changed before reading".into());
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    let after = fs::symlink_metadata(path)?;
    if bytes.len() as u64 != before.len()
        || !after.is_file()
        || after.file_type().is_symlink()
        || after.len() != before.len()
        || after.modified()? != before.modified()?
    {
        return Err("Release input changed while reading".into());
    }
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("Use SIGNED_DIRECTORY DEB EXTRACTED_INSTALLED_ELF".into());
    }
    // Select the release's target explicitly; this verifier may run on another OS.
    let target = update_target::Target::select(
        "linux",
        "x86_64",
        Some(tauri::utils::config::BundleType::Deb),
    )?;
    if target.descriptor() != "creator-hub-linux-x86_64-deb.json"
        || target.updater_key() != PLATFORM_KEY
    {
        return Err("Production Linux DEB target changed".into());
    }
    let directory = Path::new(&args[0]);
    let descriptor = bounded(&directory.join(target.descriptor()), catalog::MAX_METADATA)?;
    let detached = bounded(
        &directory.join(format!("{}.minisig", target.descriptor())),
        4096,
    )?;
    let release =
        catalog::verify_signed_target("creator-hub", &descriptor, &detached, false, target)?;
    if env!("CARGO_PKG_VERSION") != SOURCE_VERSION
        || release.version != TARGET_VERSION
        || release.min_hub_version != SOURCE_VERSION
        || release.required_hub_version().is_some()
        || release.installer_protocol != 1
        || release.asset_name != ASSET
    {
        return Err("Only source 14 -> acceptance-only Linux DEB 15 is admitted".into());
    }
    let deb = Path::new(&args[1]);
    let bytes = bounded(deb, catalog::MAX_ARTIFACT)?;
    let executable = bounded(Path::new(&args[2]), 256 * 1024 * 1024)?;
    if deb.file_name().and_then(|name| name.to_str()) != Some(ASSET)
        || bytes.len() as u64 != release.byte_length
        || digest(&bytes) != release.sha256
        || digest(&executable) != release.executable_sha256
        || !bytes.starts_with(b"!<arch>\n")
        || !executable.starts_with(b"\x7fELF\x02\x01")
        || executable.get(18..20) != Some(&[0x3e, 0x00])
    {
        return Err("DEB/installed x86_64 ELF differ from signed release inputs".into());
    }
    let manifest: serde_json::Value = serde_json::from_slice(&bounded(
        &directory.join("latest.json"),
        catalog::MAX_METADATA,
    )?)?;
    let platforms = manifest["platforms"]
        .as_object()
        .ok_or("Missing updater platforms")?;
    if platforms.len() != 1 || !platforms.contains_key(PLATFORM_KEY) {
        return Err("Expected only the Linux DEB updater platform".into());
    }
    let entry = platforms
        .get(PLATFORM_KEY)
        .ok_or("Missing Linux DEB platform")?;
    if manifest["version"] != TARGET_VERSION
        || entry["url"] != URL
        || catalog::release_url("CREATOR-HUB", &release.version, &release.asset_name) != URL
    {
        return Err("Updater URL/version differ from exact acceptance-only release".into());
    }
    let encoded = entry["signature"]
        .as_str()
        .ok_or("Missing installer signature")?;
    if encoded.is_empty() || encoded.len() > 8192 {
        return Err("Missing/oversized installer signature".into());
    }
    let signature = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    if base64::engine::general_purpose::STANDARD.encode(&signature) != encoded {
        return Err("Noncanonical installer signature".into());
    }
    let signature = minisign_verify::Signature::decode(std::str::from_utf8(&signature)?)?;
    let key = minisign_verify::PublicKey::decode(include_str!("../src/catalog-key.pub"))?;
    key.verify(&bytes, &signature, false)?;

    let mut changed_descriptor = descriptor.clone();
    changed_descriptor[0] ^= 1;
    if catalog::verify_signed_target("creator-hub", &changed_descriptor, &detached, false, target)
        .is_ok()
    {
        return Err("Changed descriptor was accepted".into());
    }
    let windows = update_target::Target::select("windows", "x86_64", None)?;
    if catalog::verify_signed_target("creator-hub", &descriptor, &detached, false, windows).is_ok()
    {
        return Err("Linux descriptor was accepted as Windows".into());
    }
    let mut changed_installer = bytes;
    changed_installer[0] ^= 1;
    if key.verify(&changed_installer, &signature, false).is_ok() {
        return Err("Changed installer was accepted".into());
    }
    println!(
        "{}",
        serde_json::json!({
            "scope": "offline-linux-acceptance-fixture-inputs-only",
            "releaseInputsVerified": true,
            "sourceVersion": SOURCE_VERSION,
            "version": release.version,
            "platformKey": PLATFORM_KEY,
            "assetName": release.asset_name,
            "byteLength": release.byte_length,
            "sha256": release.sha256,
            "executableSha256": release.executable_sha256,
            "negativeControlsPassed": ["changedDescriptor", "foreignWindowsTarget", "changedInstaller"],
            "nativeAcceptance": false,
            "signedUpdateAccepted": false,
            "restartAccepted": false,
            "releaseReady": false
        })
    );
    Ok(())
}
