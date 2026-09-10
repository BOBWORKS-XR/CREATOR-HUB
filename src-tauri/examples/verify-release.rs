//! Offline verification of exact release assets using the application's trust key.
#[allow(dead_code)]
#[path = "../src/catalog.rs"]
mod catalog;

use base64::Engine;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn hash(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("Usage: verify-release APP-ID SIGNED-DIRECTORY INSTALLER EXTRACTED-EXE".into());
    }
    let directory = Path::new(&args[1]);
    let descriptor = fs::read(directory.join(catalog::DESCRIPTOR_NAME))?;
    let signature = fs::read(directory.join(format!("{}.minisig", catalog::DESCRIPTOR_NAME)))?;
    let release = catalog::verify_signed_id(&args[0], &descriptor, &signature, true)?;
    let installer = Path::new(&args[2]);
    if installer.file_name().and_then(|n| n.to_str()) != Some(&release.asset_name)
        || fs::metadata(installer)?.len() != release.byte_length
        || hash(installer)? != release.sha256
        || hash(Path::new(&args[3]))? != release.executable_sha256
    {
        return Err("Release files do not match the signed descriptor.".into());
    }
    if args[0] == "creator-hub" {
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("latest.json"))?)?;
        let entry = &manifest["platforms"]["windows-x86_64"];
        let expected_url = format!(
            "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v{}/{}",
            release.version, release.asset_name
        );
        if manifest["version"] != release.version || entry["url"] != expected_url {
            return Err("Hub updater manifest differs from the signed release.".into());
        }
        let signature = base64::engine::general_purpose::STANDARD.decode(
            entry["signature"]
                .as_str()
                .ok_or("Missing updater signature.")?,
        )?;
        let signature = minisign_verify::Signature::decode(std::str::from_utf8(&signature)?)?;
        let key = minisign_verify::PublicKey::decode(include_str!("../src/catalog-key.pub"))?;
        key.verify(&fs::read(installer)?, &signature, false)?;
    }
    // Negative control: authentic signatures must reject changed descriptor bytes.
    let mut changed = descriptor;
    changed[0] ^= 1;
    if catalog::verify_signed_id(&args[0], &changed, &signature, true).is_ok() {
        return Err("Tamper rejection failed.".into());
    }
    println!(
        "Verified {} {}: descriptor, installer, installed executable and tamper rejection.",
        release.app_id, release.version
    );
    Ok(())
}
