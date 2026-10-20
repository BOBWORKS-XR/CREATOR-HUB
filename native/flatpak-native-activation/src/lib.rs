//! Narrow native-window activation, not a sandbox-to-host command bridge.
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

pub const ID: &str = "com.creatorworks.hub";
pub const NAME: &str = "com.creatorworks.hub.Host";
pub const INTERFACE: &str = "com.creatorworks.hub.Host1";
pub const PATH: &str = "/com/creatorworks/hub/Host";
pub const METHOD: &str = "Start";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const SERVICE: &str = include_str!("../com.creatorworks.hub.Host.service");
const KEY: &str = include_str!("../../../src-tauri/src/catalog-key.pub");
pub const DESCRIPTOR: &str = "creator-hub-linux-x86_64-deb.json";
pub const DISCLOSURE: &str = "Creator Hub opens a native window outside the Flatpak sandbox and uses your existing host settings for MCP and Project Setup. If native support is missing, choose Get Native Hub for the dedicated Creator Hub Native Support setup download (Linux x86_64 AppImage), not the ordinary Hub AppImage. Close any existing Hub windows normally, then open the setup download and review native support setup. Installation requires signature verification and your approval. After setup, close that window normally and reopen this Flatpak. A matching native DEB installation is another option on supported distributions. This launcher does not install host software.";
pub const ACTIVATION_UNAVAILABLE: &str = "Native Hub did not confirm activation. This does not tell us whether support is missing or an existing installation needs recovery.\n\nIf native support is already installed, do not delete its records or reinstall over an interrupted update. In a terminal outside Flatpak, run this read-only review:\n\"${XDG_DATA_HOME:-$HOME/.local/share}/creator-hub-portable/activation-v1/creator-hub-portable-selector\" recover-pending\nIt changes nothing and, for a verified pending update, prints a separate acknowledgement command. If the helper is missing or review refuses, keep the records and report the displayed error to support.\n\nFor a first installation, choose Get Native Hub for the dedicated Creator Hub Native Support setup AppImage, not the ordinary Hub AppImage. Close existing Hub windows normally, open the setup download and review native support setup. Then close setup and reopen this Flatpak. This launcher did not install software or change host settings.";

pub fn installer_page() -> String {
    format!("https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v{VERSION}/Creator.Hub.Native.Support_{VERSION}_amd64.AppImage")
}

pub fn launcher_context(id: Option<&str>, arguments: usize) -> Result<(), &'static str> {
    if id != Some(ID) || arguments != 1 {
        return Err("Only the fixed Flatpak launcher entry point is supported.");
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDescriptor {
    schema_version: u32,
    app_id: String,
    version: String,
    platform: String,
    architecture: String,
    package_type: String,
    asset_name: String,
    byte_length: u64,
    sha256: String,
    executable_sha256: String,
    identity_protocol: u32,
    lifecycle_protocol: u32,
    installer_protocol: u32,
    min_hub_version: String,
}

/// Signature verification is about bytes only, not installation, service
/// contents, direct-page operation, package origin, or release acceptance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedNativeInput {
    version: String,
    asset_name: String,
    byte_length: u64,
    sha256: String,
    executable_sha256: String,
    descriptor_sha256: String,
    public_key_sha256: String,
}

fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn descriptor(bytes: &[u8]) -> Result<NativeDescriptor, &'static str> {
    if bytes.is_empty() || bytes.len() > 32768 {
        return Err("Native descriptor exceeds its bound.");
    }
    let value: NativeDescriptor =
        serde_json::from_slice(bytes).map_err(|_| "Malformed native descriptor.")?;
    if value.schema_version != 1
        || value.app_id != "creator-hub"
        || value.version != VERSION
        || value.platform != "linux"
        || value.architecture != "x86_64"
        || value.package_type != "deb"
        || value.installer_protocol != 1
        || value.identity_protocol > 1
        || value.lifecycle_protocol > 1
        || value.byte_length == 0
        || value.byte_length > 512 * 1024 * 1024
        || !hex(&value.sha256)
        || !hex(&value.executable_sha256)
        || value.asset_name.len() > 160
        || !value.asset_name.ends_with(".deb")
        || !value
            .asset_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !value.asset_name.contains(VERSION)
        || value.min_hub_version.len() > 32
        || value.min_hub_version.is_empty()
    {
        return Err("Only the exact native Linux x86_64 DEB version/protocol is accepted.");
    }
    let lower = value.asset_name.to_ascii_lowercase();
    if ["acceptance", "test", "validation"]
        .iter()
        .any(|token| lower.contains(token))
    {
        return Err("TEST ONLY installers cannot authorize native host support.");
    }
    Ok(value)
}

fn verify(key: &PublicKey, bytes: &[u8], signature: &[u8]) -> Result<(), &'static str> {
    if signature.is_empty() || signature.len() > 4096 {
        return Err("Bounded plain Minisign signature required.");
    }
    let text = std::str::from_utf8(signature).map_err(|_| "Signature must be UTF-8.")?;
    let signature = Signature::decode(text).map_err(|_| "Malformed Minisign signature.")?;
    key.verify(bytes, &signature, false)
        .map_err(|_| "Trusted native signature verification failed.")
}

fn bounded(path: &Path, max: u64) -> Result<Vec<u8>, &'static str> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "Missing native verification input.")?;
    if canonical != path
        || path
            .symlink_metadata()
            .map_err(|_| "Cannot inspect native input.")?
            .file_type()
            .is_symlink()
    {
        return Err("Native verification inputs must be canonical, unlinked paths.");
    }
    let mut file = fs::File::open(path).map_err(|_| "Cannot open native input.")?;
    let before = file
        .metadata()
        .map_err(|_| "Cannot inspect open native input.")?;
    if !before.is_file() || before.len() == 0 || before.len() > max {
        return Err("Native verification input exceeds its bound.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.nlink() != 1 {
            return Err("Hard-linked native inputs refused.");
        }
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read native input.")?;
    let after = file
        .metadata()
        .map_err(|_| "Cannot recheck native input.")?;
    let named = fs::metadata(path).map_err(|_| "Native input pathname changed.")?;
    if bytes.len() as u64 != before.len()
        || after.len() != before.len()
        || named.len() != before.len()
        || before.modified().ok() != after.modified().ok()
        || before.modified().ok() != named.modified().ok()
    {
        return Err("Native verification input changed while reading.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (
            before.dev(),
            before.ino(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (after.dev(), after.ino(), after.ctime(), after.ctime_nsec())
            || (
                before.dev(),
                before.ino(),
                before.ctime(),
                before.ctime_nsec(),
            ) != (named.dev(), named.ino(), named.ctime(), named.ctime_nsec())
        {
            return Err("Native input file identity changed.");
        }
    }
    Ok(bytes)
}

pub fn verify_native_input(directory: &Path) -> Result<VerifiedNativeInput, &'static str> {
    let key = PublicKey::decode(KEY).map_err(|_| "Invalid compiled release key.")?;
    let bytes = bounded(&directory.join(DESCRIPTOR), 32768)?;
    verify(
        &key,
        &bytes,
        &bounded(&directory.join(format!("{DESCRIPTOR}.minisig")), 4096)?,
    )?;
    let value = descriptor(&bytes)?;
    let installer = bounded(&directory.join("native-installer.deb"), 512 * 1024 * 1024)?;
    if installer.len() as u64 != value.byte_length
        || format!("{:x}", Sha256::digest(&installer)) != value.sha256
    {
        return Err("Native installer bytes do not match the signed descriptor.");
    }
    verify(
        &key,
        &installer,
        &bounded(&directory.join("native-installer.minisig"), 4096)?,
    )?;
    Ok(VerifiedNativeInput {
        version: value.version,
        asset_name: value.asset_name,
        byte_length: value.byte_length,
        sha256: value.sha256,
        executable_sha256: value.executable_sha256,
        descriptor_sha256: format!("{:x}", Sha256::digest(&bytes)),
        public_key_sha256: format!("{:x}", Sha256::digest(KEY.as_bytes())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body() -> serde_json::Value {
        serde_json::json!({"schemaVersion":1,"appId":"creator-hub","version":VERSION,"platform":"linux","architecture":"x86_64",
            "packageType":"deb","assetName":format!("Creator.Hub_{VERSION}_amd64.deb"),"byteLength":4,"sha256":"a".repeat(64),
            "executableSha256":"b".repeat(64),"identityProtocol":1,"lifecycleProtocol":1,"installerProtocol":1,"minHubVersion":"0.1.12"})
    }
    #[test]
    fn fixed_launcher_has_no_program_path_or_version_arguments() {
        assert!(launcher_context(Some(ID), 1).is_ok());
        for id in [None, Some("foreign")] {
            assert!(launcher_context(id, 1).is_err());
        }
        assert!(launcher_context(Some(ID), 2).is_err());
        assert_eq!(installer_page(), format!("https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v{VERSION}/Creator.Hub.Native.Support_{VERSION}_amd64.AppImage"));
        assert!(!installer_page().contains("latest"));
    }

    #[test]
    fn setup_guidance_is_graphical_and_preserves_explicit_native_consent() {
        for phrase in [
            "outside the Flatpak sandbox",
            "Linux x86_64 AppImage",
            "dedicated Creator Hub Native Support",
            "setup download",
            "not the ordinary Hub AppImage",
            "Close any existing Hub windows normally",
            "signature verification and your approval",
            "reopen this Flatpak",
            "does not install host software",
        ] {
            assert!(DISCLOSURE.contains(phrase), "{phrase}");
        }
        assert!(!DISCLOSURE.contains("--install-native-support"));
        assert!(!DISCLOSURE.contains("DEB installation is required"));
        assert!(!DISCLOSURE.contains(VERSION));
    }
    #[test]
    fn activation_failure_exposes_read_only_recovery_without_claiming_support_is_missing() {
        let source = include_str!("linux.rs");
        assert!(source.contains(".map_err(|_| contract::ACTIVATION_UNAVAILABLE)?"));
        for phrase in [
            "does not tell us whether support is missing",
            "do not delete its records or reinstall over an interrupted update",
            "terminal outside Flatpak",
            "\"${XDG_DATA_HOME:-$HOME/.local/share}/creator-hub-portable/activation-v1/creator-hub-portable-selector\" recover-pending",
            "changes nothing",
            "separate acknowledgement command",
            "keep the records",
            "For a first installation",
            "did not install software or change host settings",
        ] {
            assert!(ACTIVATION_UNAVAILABLE.contains(phrase), "{phrase}");
        }
        assert!(!ACTIVATION_UNAVAILABLE.contains("--acknowledge"));
        assert!(!ACTIVATION_UNAVAILABLE.contains("sudo"));
    }
    #[test]
    fn exact_deb_descriptor_only_no_test_only_or_path_escape() {
        assert!(descriptor(&serde_json::to_vec(&body()).unwrap()).is_ok());
        for (key, value) in [
            ("version", "0.1.15"),
            ("platform", "windows"),
            ("architecture", "aarch64"),
            ("packageType", "rpm"),
            ("assetName", "../foreign.deb"),
            ("assetName", "https://foreign/deb"),
            ("assetName", "Creator.Hub_0.1.14_acceptance-only.deb"),
        ] {
            let mut b = body();
            b[key] = value.into();
            assert!(
                descriptor(&serde_json::to_vec(&b).unwrap()).is_err(),
                "{key}"
            );
        }
        let mut b = body();
        b["extra"] = true.into();
        assert!(descriptor(&serde_json::to_vec(&b).unwrap()).is_err());
    }
    #[test]
    fn malformed_duplicate_and_unbounded_descriptor_refuse() {
        for b in [
            b"{}".to_vec(),
            vec![0; 32769],
            b"{\"version\":1,\"version\":2}".to_vec(),
        ] {
            assert!(descriptor(&b).is_err());
        }
    }
    #[test]
    fn real_minisign_primary_vector_refuses_changed_bytes_and_production_key() {
        let key =
            PublicKey::from_base64("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
                .unwrap();
        let sig = b"untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
        assert!(verify(&key, b"test", sig).is_ok());
        assert!(verify(&key, b"changed", sig).is_err());
        assert!(verify(&PublicKey::decode(KEY).unwrap(), b"test", sig).is_err());
    }
    #[test]
    fn fixed_service_has_no_root_user_shell_or_legacy_module_entrypoint() {
        assert_eq!(SERVICE, "[D-BUS Service]\nName=com.creatorworks.hub.Host\nExec=/usr/bin/creator-hub --flatpak-activate\n");
        for forbidden in [
            "User=",
            "SystemdService=",
            "/bin/sh",
            "pkexec",
            "mcp",
            "setup",
        ] {
            assert!(!SERVICE.contains(forbidden));
        }
    }
}
