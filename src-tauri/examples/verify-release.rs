//! Offline verification of exact release assets using the application's trust key.
#[allow(dead_code)]
#[path = "../src/catalog.rs"]
mod catalog;
#[allow(dead_code)]
#[path = "../src/update_target.rs"]
mod update_target;

use base64::Engine;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn verification_target(args: &[String]) -> Result<update_target::Target, String> {
    use tauri::utils::config::BundleType;
    if args.is_empty() {
        return update_target::Target::select("windows", "x86_64", None);
    }
    if args.len() != 3 {
        return Err("Supply all three native target fields: OS ARCH PACKAGE.".into());
    }
    let package = match args[2].as_str() {
        "nsis" => BundleType::Nsis,
        "app" => BundleType::App,
        "appimage" => BundleType::AppImage,
        "deb" => BundleType::Deb,
        "rpm" => BundleType::Rpm,
        _ => return Err("Unsupported verification package.".into()),
    };
    update_target::Target::select(&args[0], &args[1], Some(package))
}

fn hash(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 && args.len() != 7 {
        return Err("Usage: verify-release APP-ID SIGNED-DIRECTORY PACKAGE EXTRACTED-EXE [OS ARCH PACKAGE-TYPE]".into());
    }
    let target = verification_target(&args[4..])?;
    let directory = Path::new(&args[1]);
    let name = target.descriptor();
    let descriptor = fs::read(directory.join(&name))?;
    let signature = fs::read(directory.join(format!("{name}.minisig")))?;
    let release = catalog::verify_signed_target(&args[0], &descriptor, &signature, true, target)?;
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
        let entry = &manifest["platforms"][target.updater_key()];
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
    if catalog::verify_signed_target(&args[0], &changed, &signature, true, target).is_ok() {
        return Err("Tamper rejection failed.".into());
    }
    println!(
        "Verified {} {}: descriptor, installer, installed executable and tamper rejection.",
        release.app_id, release.version
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_windows_and_explicit_native_verification_are_discriminated() {
        assert_eq!(
            verification_target(&[]).unwrap().updater_key(),
            "windows-x86_64"
        );
        for (os, arch, package, key) in [
            ("macos", "aarch64", "app", "darwin-aarch64-app"),
            ("macos", "x86_64", "app", "darwin-x86_64-app"),
            ("linux", "x86_64", "appimage", "linux-x86_64-appimage"),
            ("linux", "x86_64", "deb", "linux-x86_64-deb"),
            ("linux", "x86_64", "rpm", "linux-x86_64-rpm"),
        ] {
            let args = [os, arch, package].map(String::from);
            assert_eq!(verification_target(&args).unwrap().updater_key(), key);
        }
        for args in [
            vec!["linux"],
            vec!["linux", "x86_64"],
            vec!["linux", "x86", "deb"],
            vec!["linux", "x86_64", "nsis"],
            vec!["macos", "x86_64", "rpm"],
            vec!["linux", "x86_64", "flatpak"],
        ] {
            assert!(
                verification_target(&args.into_iter().map(String::from).collect::<Vec<_>>())
                    .is_err()
            );
        }
    }
}
