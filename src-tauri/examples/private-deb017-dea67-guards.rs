//! Fixed, offline private 16 -> 17 inspection/signature verification. Never installs.
#[allow(dead_code)]
#[path = "../src/catalog.rs"]
mod catalog;
#[allow(dead_code)]
#[path = "../src/update_target.rs"]
mod update_target;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, fs, io::Read, path::Path};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const PROFILE: &str = "private-linux-deb-update-017";
const FROM: &str = "0.1.16";
const VERSION: &str = "0.1.17";
const ASSET: &str = "Creator_Hub_0.1.17_amd64-acceptance-only.deb";
const DESCRIPTOR: &str = "creator-hub-linux-x86_64-deb.json";
const PLATFORM: &str = "linux-x86_64-deb";
const URL: &str = "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/Creator_Hub_0.1.17_amd64-acceptance-only.deb";
const DEB: (u64, &str) = (
    64516566,
    "1bd69ef6ad81f6af396175e8d2ce74fdabc7df39c936bf8c8e3704a92260f222",
);
const RAW: (u64, &str) = (
    29086768,
    "47ea1c9c158df10b8e64709422ce99b91ac5f9e69152fb18248ac783e9f2e387",
);
const INSTALLED: (u64, &str) = (
    29086768,
    "fedc79bd67928a4e3570ca86c6157f4ecb553d046f0febe6823b3a976803a673",
);
const MODULES: (u64, &str) = (
    55576707,
    "5a41b14f5b1ece0d772a5cf71d028517db7e0711891d16019f247b3362009828",
);
const MANIFEST: (u64, &str) = (
    3663,
    "42ec01cf6b4c34b2c0c2b9f13aef493b41e14bab0703f8cee06c78e49097c4bd",
);
const MAX_TAR: u64 = 128 * 1024 * 1024;

fn require(ok: bool, message: &'static str) -> Result<()> {
    if !ok {
        return Err(message.into());
    }
    Ok(())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn pin(bytes: &[u8], expected: (u64, &str)) -> Result<()> {
    require(
        bytes.len() as u64 == expected.0 && digest(bytes) == expected.1,
        "Fixed actual017 byte pin differs",
    )
}
fn record(expected: (u64, &str)) -> Value {
    json!({ "size": expected.0, "sha256": expected.1 })
}
fn canonical(path: &Path) -> Result<()> {
    require(path.is_absolute(), "Absolute offline input path required")?;
    for ancestor in path.ancestors() {
        require(
            !fs::symlink_metadata(ancestor)?.file_type().is_symlink(),
            "Redirected offline path refused",
        )?;
    }
    Ok(())
}
fn bounded(path: &Path, max: u64) -> Result<Vec<u8>> {
    canonical(path)?;
    let before = fs::symlink_metadata(path)?;
    require(
        before.is_file() && before.len() > 0 && before.len() <= max,
        "Bounded regular offline input required",
    )?;
    let file = fs::File::open(path)?;
    require(
        file.metadata()?.len() == before.len(),
        "Offline input changed before read",
    )?;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    let after = fs::symlink_metadata(path)?;
    canonical(path)?;
    require(
        bytes.len() as u64 == before.len()
            && after.is_file()
            && after.len() == before.len()
            && after.modified()? == before.modified()?,
        "Offline input changed while reading",
    )?;
    Ok(bytes)
}
fn ar(bytes: &[u8]) -> Result<BTreeMap<String, &[u8]>> {
    require(bytes.starts_with(b"!<arch>\n"), "DEB ar magic differs")?;
    let mut at = 8usize;
    let mut result = BTreeMap::new();
    for expected in ["debian-binary", "control.tar.gz", "data.tar.gz"] {
        let header = bytes.get(at..at + 60).ok_or("Truncated ar header")?;
        require(&header[58..] == b"`\n", "ar header trailer differs")?;
        let name = std::str::from_utf8(&header[..16])?
            .trim()
            .trim_end_matches('/');
        require(
            name == expected,
            "Only the fixed three ordinary ar roles are admitted",
        )?;
        let text = std::str::from_utf8(&header[48..58])?.trim();
        require(
            !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
            "ar length differs",
        )?;
        let size: usize = text.parse()?;
        let start = at.checked_add(60).ok_or("ar overflow")?;
        let end = start.checked_add(size).ok_or("ar overflow")?;
        let body = bytes.get(start..end).ok_or("Truncated ar member")?;
        require(
            result.insert(name.to_string(), body).is_none(),
            "Duplicate ar member",
        )?;
        at = end.checked_add(size % 2).ok_or("ar overflow")?;
    }
    require(
        at == bytes.len() && result["debian-binary"] == b"2.0\n",
        "Extra ar data or DEB version differs",
    )?;
    Ok(result)
}
struct Entry {
    directory: bool,
    mode: u32,
    bytes: Vec<u8>,
}
fn tar_gzip(bytes: &[u8]) -> Result<BTreeMap<String, Entry>> {
    let cursor = std::io::Cursor::new(bytes);
    let mut decoder = flate2::bufread::GzDecoder::new(cursor);
    let mut raw = Vec::new();
    decoder.by_ref().take(MAX_TAR + 1).read_to_end(&mut raw)?;
    require(
        raw.len() as u64 <= MAX_TAR && decoder.into_inner().position() == bytes.len() as u64,
        "Gzip expansion or trailing/concatenated stream refused",
    )?;
    require(
        raw.len() >= 1024 && raw.len() % 512 == 0,
        "TAR framing differs",
    )?;
    let mut archive = tar::Archive::new(std::io::Cursor::new(&raw));
    let mut result = BTreeMap::new();
    for item in archive.entries()? {
        let mut item = item?;
        require(result.len() < 64, "TAR entry bound exceeded")?;
        let name = std::str::from_utf8(item.path_bytes().as_ref())?.to_string();
        require(
            !name.is_empty()
                && !name.starts_with('/')
                && !name.contains(['\\', ':'])
                && name
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
                && name.bytes().all(|b| (32..127).contains(&b)),
            "Unsafe TAR path",
        )?;
        let header = item.header();
        let kind = header.entry_type();
        require(
            kind.is_file() || kind.is_dir(),
            "Links or special TAR entries refused",
        )?;
        require(
            header.uid()? == 0 && header.gid()? == 0,
            "Non-root package ownership refused",
        )?;
        let mode = header.mode()?;
        let size = header.size()?;
        require(
            size <= MAX_TAR && (!kind.is_dir() || size == 0),
            "TAR member exceeds bound",
        )?;
        let mut body = Vec::new();
        item.by_ref().take(MAX_TAR + 1).read_to_end(&mut body)?;
        require(body.len() as u64 == size, "TAR member length differs")?;
        require(
            result
                .insert(
                    name,
                    Entry {
                        directory: kind.is_dir(),
                        mode,
                        bytes: body,
                    },
                )
                .is_none(),
            "Duplicate TAR path",
        )?;
    }
    let position = archive.into_inner().position() as usize;
    require(
        position <= raw.len() && raw[position..].iter().all(|b| *b == 0),
        "Hidden trailing TAR content refused",
    )?;
    Ok(result)
}
fn expected_files() -> BTreeMap<&'static str, (u32, u64, &'static str)> {
    BTreeMap::from([
        ("usr/bin/creator-hub", (0o755, INSTALLED.0, INSTALLED.1)),
        (
            "usr/lib/Creator Hub/modules.tar.gz",
            (0o644, MODULES.0, MODULES.1),
        ),
        (
            "usr/libexec/creator-hub-deb-retirement-helper",
            (
                0o755,
                1168536,
                "7f22822e50ee8b96829c64c95da9e1b098c3e080a1370f577ae2b69055eed94a",
            ),
        ),
        (
            "usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy",
            (
                0o644,
                878,
                "f4819f08e0a96e98d10a449a82a26b4f59d69714460eb9082387f746e1889bb4",
            ),
        ),
        (
            "usr/share/dbus-1/services/com.creatorworks.hub.Host.service",
            (
                0o644,
                92,
                "9a270a39c219b4f2d294cfaa2a849db84b1e1883fa532d2c90d7f95625780340",
            ),
        ),
        (
            "usr/share/applications/Creator Hub.desktop",
            (
                0o644,
                170,
                "4d61099d5890876993a750d51195a02f9f723a951384058b4a7536e7d611b20b",
            ),
        ),
        (
            "usr/share/icons/hicolor/32x32/apps/creator-hub.png",
            (
                0o644,
                2001,
                "d43f1d37f34de6e2720ecac0a869905cfabe18f02f29e8b97c083e531e80edf7",
            ),
        ),
        (
            "usr/share/icons/hicolor/128x128/apps/creator-hub.png",
            (
                0o644,
                8835,
                "4be3a9795c9478c9c37b5e7fdb8b775168fc574352097fa0a038a31ea88245cb",
            ),
        ),
        (
            "usr/share/icons/hicolor/256x256@2/apps/creator-hub.png",
            (
                0o644,
                19571,
                "6a4e772d7a76ff364cdf9065d05473f43de58d9dd8a6dacc4407adb20ba34d75",
            ),
        ),
        (
            "usr/share/icons/hicolor/512x512/apps/creator-hub.png",
            (
                0o644,
                57743,
                "5dc63bd8fcb18e5af2564077292a40df99ec0c9e87a8fdb9f9c53c562c80bf3a",
            ),
        ),
    ])
}
fn transform(raw: &[u8]) -> Result<Vec<u8>> {
    require(
        raw.starts_with(b"\x7fELF\x02\x01") && raw.get(18..20) == Some(&[0x3e, 0]),
        "Expected little-endian x86_64 ELF",
    )?;
    let marker = b"__TAURI_BUNDLE_TYPE_VAR_UNK";
    let positions: Vec<_> = raw
        .windows(marker.len())
        .enumerate()
        .filter(|(_, b)| *b == marker)
        .map(|(i, _)| i)
        .collect();
    require(
        positions.len() == 1,
        "Exactly one raw UNK bundle marker required",
    )?;
    let mut result = raw.to_vec();
    let at = positions[0] + marker.len() - 3;
    result[at..at + 3].copy_from_slice(b"DEB");
    Ok(result)
}
fn inspect(deb: &[u8], raw: &[u8], manifest: &[u8], modules: &[u8]) -> Result<()> {
    pin(deb, DEB)?;
    pin(raw, RAW)?;
    pin(manifest, MANIFEST)?;
    pin(modules, MODULES)?;
    require(
        raw.windows(manifest.len()).any(|w| w == manifest),
        "Actual builtin descriptor is not embedded in Root",
    )?;
    let members = ar(deb)?;
    let control = tar_gzip(members["control.tar.gz"])?;
    require(
        control
            .keys()
            .map(String::as_str)
            .eq(["control", "md5sums"]),
        "Maintainer scripts or extra control entries refused",
    )?;
    for entry in control.values() {
        require(
            !entry.directory && entry.mode == 0o644 && !entry.bytes.is_empty(),
            "Control entry differs",
        )?;
    }
    let text = std::str::from_utf8(&control["control"].bytes)?;
    for field in [
        "Package: creator-hub",
        "Version: 0.1.17",
        "Architecture: amd64",
        "Depends: policykit-1, libwebkit2gtk-4.1-0, libgtk-3-0",
    ] {
        require(
            text.lines()
                .filter(|line| line.split(':').next() == field.split(':').next())
                .eq([field]),
            "Fixed package control field differs",
        )?;
    }
    let entries = tar_gzip(members["data.tar.gz"])?;
    let expected = expected_files();
    let mut directories = std::collections::BTreeSet::new();
    for name in expected.keys() {
        let mut parent = Path::new(name).parent();
        while let Some(path) = parent {
            if path.as_os_str().is_empty() {
                break;
            }
            directories.insert(
                path.to_str()
                    .ok_or("Non-UTF8 package directory")?
                    .replace('\\', "/"),
            );
            parent = path.parent();
        }
    }
    require(
        entries.len() == expected.len() + directories.len(),
        "Incomplete or additional package resources",
    )?;
    for (name, entry) in &entries {
        if entry.directory {
            require(
                directories.contains(name) && entry.mode == 0o755,
                "Package directory differs",
            )?;
        } else {
            let &(mode, size, hash) = expected
                .get(name.as_str())
                .ok_or("Foreign package resource")?;
            require(entry.mode == mode, "Package file mode differs")?;
            pin(&entry.bytes, (size, hash))?;
        }
    }
    require(
        entries["usr/bin/creator-hub"].bytes == transform(raw)?,
        "Raw -> DEB ELF differs beyond bundle marker",
    )?;
    require(
        entries["usr/lib/Creator Hub/modules.tar.gz"].bytes == modules,
        "Embedded private archive differs",
    )?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
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
fn descriptor(bytes: &[u8]) -> Result<()> {
    let d: Descriptor = serde_json::from_slice(bytes)?;
    require(
        d.schema_version == 1
            && d.app_id == "creator-hub"
            && d.version == VERSION
            && d.platform == "linux"
            && d.architecture == "x86_64"
            && d.package_type == "deb"
            && d.asset_name == ASSET
            && d.byte_length == DEB.0
            && d.sha256 == DEB.1
            && d.executable_sha256 == INSTALLED.1
            && d.identity_protocol == 0
            && d.lifecycle_protocol == 0
            && d.installer_protocol == 1
            && d.min_hub_version == FROM,
        "Only the private actual16 -> 17 DEB descriptor is admitted",
    )
}
fn signature(bytes: &[u8], detached: &[u8]) -> Result<()> {
    require(
        !detached.is_empty() && detached.len() <= 4096,
        "Signature exceeds bound",
    )?;
    let key = PublicKey::decode(include_str!("../src/catalog-key.pub"))?;
    let signature = Signature::decode(std::str::from_utf8(detached)?)?;
    key.verify(bytes, &signature, false)?;
    let mut changed = bytes.to_vec();
    require(!changed.is_empty(), "Empty signing body")?;
    changed[0] ^= 1;
    require(
        key.verify(&changed, &signature, false).is_err(),
        "Changed signing body was accepted",
    )
}
fn verify(directory: &Path, deb: &[u8]) -> Result<()> {
    let bytes = bounded(&directory.join(DESCRIPTOR), 128 * 1024)?;
    descriptor(&bytes)?;
    let detached = bounded(&directory.join(format!("{DESCRIPTOR}.minisig")), 4096)?;
    signature(&bytes, &detached)?;
    let target = update_target::Target::select(
        "linux",
        "x86_64",
        Some(tauri::utils::config::BundleType::Deb),
    )?;
    let release = catalog::verify_signed_target("creator-hub", &bytes, &detached, false, target)?;
    require(
        release.min_hub_version == FROM
            && release.version == VERSION
            && release.installer_protocol == 1,
        "Root production DEB parser refused fixed private target",
    )?;
    let packaged = bounded(&directory.join(ASSET), DEB.0)?;
    require(
        packaged == deb,
        "Output DEB differs from inspected original",
    )?;
    let plain = bounded(&directory.join(format!("{ASSET}.minisig")), 4096)?;
    signature(&packaged, &plain)?;
    let latest: Value =
        serde_json::from_slice(&bounded(&directory.join("latest.json"), 128 * 1024)?)?;
    let expected = json!({ "version": VERSION, "notes": "Private native qualification input only. Not release acceptance.",
        "platforms": { (PLATFORM): { "url": URL, "signature": base64::engine::general_purpose::STANDARD.encode(&plain) } } });
    require(
        latest == expected,
        "latest.json is not the exact one-platform plain-Minisign transport",
    )?;
    Ok(())
}
fn report(mode: &str) -> Value {
    json!({ "scope": PROFILE, "mode": mode, "sourceVersion": FROM, "targetVersion": VERSION, "deb": record(DEB),
        "rawHub": record(RAW), "installedHub": record(INSTALLED), "fullResourcesVerified": true, "signaturesVerified": mode == "verify",
        "acceptanceOnly": true, "nativeGuiAccepted": false, "migrationAccepted": false, "authenticationAccepted": false,
        "signedUpdateAccepted": false, "restartAccepted": false, "releaseReady": false, "privateModulesRecompiled": false,
        "privateModulesResigned": false, "rootRecompiled": false, "applicationLaunched": false, "approvedForStable": false, "approvedForPrerelease": false })
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    require((args.len() == 5 && args[0] == "inspect") || (args.len() == 6 && args[0] == "verify"),
        "Use inspect DEB RAW_ELF BUILTIN_MANIFEST MODULES_ARCHIVE, or verify followed by those paths and SIGNED_DIRECTORY")?;
    let deb = bounded(Path::new(&args[1]), DEB.0)?;
    let raw = bounded(Path::new(&args[2]), RAW.0)?;
    let manifest = bounded(Path::new(&args[3]), 65536)?;
    let modules = bounded(Path::new(&args[4]), MODULES.0)?;
    inspect(&deb, &raw, &manifest, &modules)?;
    if args[0] == "verify" {
        verify(Path::new(&args[5]), &deb)?;
    }
    println!("{}", report(&args[0]));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor_bytes() -> Vec<u8> {
        serde_json::to_vec(&json!({ "schemaVersion": 1, "appId": "creator-hub", "version": VERSION, "platform": "linux",
            "architecture": "x86_64", "packageType": "deb", "assetName": ASSET, "byteLength": DEB.0, "sha256": DEB.1,
            "executableSha256": INSTALLED.1, "identityProtocol": 0, "lifecycleProtocol": 0, "installerProtocol": 1, "minHubVersion": FROM })).unwrap()
    }
    #[test]
    fn only_exact_private_descriptor_and_protocols_are_admitted() {
        let bytes = descriptor_bytes();
        descriptor(&bytes).unwrap();
        for (name, wrong) in [
            ("version", json!("0.1.16")),
            ("minHubVersion", json!("0.1.14")),
            ("platform", json!("windows")),
            ("installerProtocol", json!(0)),
            ("identityProtocol", json!(1)),
            ("lifecycleProtocol", json!(1)),
            ("sha256", json!(RAW.1)),
            ("executableSha256", json!(RAW.1)),
            ("approvedForStable", json!(true)),
        ] {
            let mut value: Value = serde_json::from_slice(&bytes).unwrap();
            value[name] = wrong;
            assert!(
                descriptor(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{name}"
            );
        }
    }
    #[test]
    fn wrong_package_elf_and_tamper_refuse_without_signatures() {
        assert!(inspect(b"wrong package", b"wrong ELF", b"manifest", b"archive").is_err());
        assert!(pin(b"tampered package", DEB).is_err());
        assert!(pin(b"tampered ELF", RAW).is_err());
        assert!(transform(b"not ELF").is_err());
        assert!(signature(b"body", b"not a Minisign").is_err());
    }
    #[test]
    fn transform_only_changes_one_unique_bundle_marker() {
        let mut raw = vec![0; 64];
        raw[..6].copy_from_slice(b"\x7fELF\x02\x01");
        raw[18] = 0x3e;
        raw.extend_from_slice(b"__TAURI_BUNDLE_TYPE_VAR_UNK");
        let changed = transform(&raw).unwrap();
        assert_eq!(&changed[..changed.len() - 3], &raw[..raw.len() - 3]);
        assert!(changed.ends_with(b"DEB"));
        raw.extend_from_slice(b"__TAURI_BUNDLE_TYPE_VAR_UNK");
        assert!(transform(&raw).is_err());
    }
    #[test]
    fn neither_mode_claims_native_or_release_acceptance() {
        for mode in ["inspect", "verify"] {
            let value = report(mode);
            assert_eq!(value["signaturesVerified"], mode == "verify");
            for name in [
                "nativeGuiAccepted",
                "migrationAccepted",
                "signedUpdateAccepted",
                "restartAccepted",
                "releaseReady",
                "approvedForStable",
                "approvedForPrerelease",
            ] {
                assert_eq!(value[name], false);
            }
        }
    }
}

#[cfg(test)]
mod actual_b017_guard_regressions {
    use super::*;
    use std::io::Write;
    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut out = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        out.write_all(raw).unwrap(); out.finish().unwrap()
    }
    fn member(name: &str, kind: u8, uid: u64, gid: u64, size: u64, body: &[u8]) -> Vec<u8> {
        let mut h = tar::Header::new_ustar();
        h.set_mode(0o644); h.set_uid(uid); h.set_gid(gid); h.set_size(size);
        h.set_entry_type(tar::EntryType::new(kind)); h.set_mtime(0);
        h.as_mut_bytes()[..100].fill(0); h.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes()); h.set_cksum();
        let mut raw = h.as_bytes().to_vec(); raw.extend_from_slice(body); raw.resize(raw.len().div_ceil(512) * 512, 0); raw
    }
    fn archive(mut raw: Vec<u8>) -> Vec<u8> { raw.extend_from_slice(&[0; 1024]); gzip(&raw) }
    fn ar_bytes(names: [&str; 3]) -> Vec<u8> {
        let mut raw = b"!<arch>\n".to_vec();
        for name in names {
            let b: &[u8] = if name == "debian-binary" { b"2.0\n" } else { b"x" };
            let h = format!("{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n", format!("{name}/"), 0, 0, 0, "100644", b.len());
            assert_eq!(h.len(), 60); raw.extend_from_slice(h.as_bytes()); raw.extend_from_slice(b);
            if b.len() % 2 != 0 { raw.push(b'\n'); }
        } raw
    }
    #[test]
    fn ar_order_truncation_extra_data_and_version_refuse() {
        let raw = ar_bytes(["debian-binary", "control.tar.gz", "data.tar.gz"]); assert!(ar(&raw).is_ok());
        assert!(ar(&ar_bytes(["debian-binary", "data.tar.gz", "control.tar.gz"])).is_err());
        assert!(ar(&raw[..raw.len()-1]).is_err());
        let mut extra = raw.clone(); extra.push(0); assert!(ar(&extra).is_err());
        let mut wrong = raw; wrong[68] = b'3'; assert!(ar(&wrong).is_err());
    }
    #[test]
    fn tar_unsafe_paths_links_special_entries_and_ownership_refuse() {
        assert!(tar_gzip(&archive(member("safe", b'0', 0, 0, 1, b"x"))).is_ok());
        for name in ["../escape", "/absolute", "a\\b", "a:b", "a//b", "a/./b"] {
            assert!(tar_gzip(&archive(member(name, b'0', 0, 0, 1, b"x"))).is_err(), "{name}");
        }
        for kind in [b'1', b'2', b'3', b'6'] { assert!(tar_gzip(&archive(member("safe", kind, 0, 0, 0, b""))).is_err(), "{kind}"); }
        assert!(tar_gzip(&archive(member("safe", b'0', 1, 0, 1, b"x"))).is_err());
        assert!(tar_gzip(&archive(member("safe", b'0', 0, 1, 1, b"x"))).is_err());
        assert!(tar_gzip(&archive(member("safe", b'0', 0, 0, MAX_TAR + 1, b""))).is_err());
    }
    #[test]
    fn tar_duplicate_trailing_and_concatenated_gzip_refuse() {
        let entry = member("safe", b'0', 0, 0, 1, b"x");
        let mut duplicate = entry.clone(); duplicate.extend_from_slice(&entry); assert!(tar_gzip(&archive(duplicate)).is_err());
        let clean = archive(entry);
        let mut trailing = clean.clone(); trailing.push(1); assert!(tar_gzip(&trailing).is_err());
        let mut concatenated = clean.clone(); concatenated.extend_from_slice(&clean); assert!(tar_gzip(&concatenated).is_err());
        assert!(tar_gzip(b"not gzip").is_err());
    }
    #[test]
    fn actual_root_marker_is_unique_and_transform_is_the_fixed_installed_pin() {
        let raw = fs::read(std::env::var("ACTUAL_B017_ROOT").unwrap()).unwrap();
        pin(&raw, RAW).unwrap(); let installed = transform(&raw).unwrap(); pin(&installed, INSTALLED).unwrap();
        let marker = b"__TAURI_BUNDLE_TYPE_VAR_UNK"; let at = raw.windows(marker.len()).position(|w| w == marker).unwrap();
        let mut missing = raw.clone(); missing[at] ^= 1; assert!(transform(&missing).is_err());
        let mut duplicate = raw.clone(); duplicate.extend_from_slice(marker); assert!(transform(&duplicate).is_err());
        let mut foreign = raw; foreign[18] = 0; assert!(transform(&foreign).is_err());
    }
    #[test]
    fn actual_public_runtime_signature_verifies_and_tamper_refuses() {
        let body = fs::read(std::env::var("B017_PUBLIC_BODY").unwrap()).unwrap();
        let sig = fs::read(std::env::var("B017_PUBLIC_SIGNATURE").unwrap()).unwrap(); signature(&body, &sig).unwrap();
        let mut changed = body.clone(); changed[0] ^= 1; assert!(signature(&changed, &sig).is_err());
        assert!(signature(&body, b"untrusted comment: malformed").is_err());
    }
    #[test]
    fn actual_descriptor_rejects_old_dce_and_raw_installed_aliases() {
        let good = json!({ "schemaVersion": 1, "appId": "creator-hub", "version": VERSION, "platform": "linux",
            "architecture": "x86_64", "packageType": "deb", "assetName": ASSET, "byteLength": DEB.0, "sha256": DEB.1,
            "executableSha256": INSTALLED.1, "identityProtocol": 0, "lifecycleProtocol": 0, "installerProtocol": 1, "minHubVersion": FROM });
        descriptor(&serde_json::to_vec(&good).unwrap()).unwrap();
        for (field, bad) in [("sha256", json!("f58801c95e6932266a897a7b139c6ad3cf4fdfb22ea518398f3a91ed3829ed54")),
            ("executableSha256", json!("1fae9d03ddd889068fdccb8416ad3644952027304c10038d0b6810f068e2a952")),
            ("executableSha256", json!(RAW.1)), ("byteLength", json!(64455526)), ("architecture", json!("aarch64")),
            ("packageType", json!("appimage")), ("installerProtocol", json!(0)), ("identityProtocol", json!(1)),
            ("lifecycleProtocol", json!(1)), ("releaseReady", json!(true))] {
            let mut value = good.clone(); value[field] = bad; assert!(descriptor(&serde_json::to_vec(&value).unwrap()).is_err(), "{field}");
        }
    }
}
