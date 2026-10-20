//! Shared, default-off Linux portable artifact identity and bounded cache preparation.
//! No updater admission, Store mutation, bootstrap consent or process launch.
use crate::{catalog, manager, platform, self_update};
use creator_hub_linux_portable_deployment::{self as deployment, Entry, Expected, VerifiedPackage};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tauri::{Emitter, Manager as _};

pub(crate) use crate::catalog::PORTABLE_DESCRIPTOR_NAME as DESCRIPTOR_NAME;
const REPO: &str = "CREATOR-HUB";
const PACKAGE: &str = "portable-appdir";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    asset_name: String,
    byte_length: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    schema_version: u32,
    app_id: String,
    version: String,
    platform: String,
    architecture: String,
    package_type: String,
    manifest: Asset,
    archive: Asset,
    executable_sha256: String,
    restart_protocol: u32,
    min_hub_version: String,
}

pub(crate) fn stable(value: &str) -> Result<Version, String> {
    let parsed = Version::parse(value).map_err(|_| "Invalid portable version.")?;
    if value.len() > 64
        || parsed.to_string() != value
        || !parsed.pre.is_empty()
        || !parsed.build.is_empty()
    {
        return Err("Canonical stable portable version required.".into());
    }
    Ok(parsed)
}

impl Descriptor {
    fn validate(&self) -> Result<Version, String> {
        let version = stable(&self.version)?;
        let minimum = stable(&self.min_hub_version)?;
        if self.schema_version != 1
            || self.app_id != "creator-hub"
            || self.platform != "linux"
            || self.architecture != "x86_64"
            || self.package_type != PACKAGE
            || self.restart_protocol != 1
            || minimum > version
            || !catalog::hash_valid(&self.executable_sha256)
        {
            return Err("Incompatible portable release descriptor.".into());
        }
        for (asset, name, maximum) in [
            (
                &self.manifest,
                format!(
                    "creator-hub-linux-x86_64-{}.portable-manifest.json",
                    self.version
                ),
                deployment::MAX_MANIFEST as u64,
            ),
            (
                &self.archive,
                format!("creator-hub-linux-x86_64-{}.appdir.tar.gz", self.version),
                deployment::MAX_ARCHIVE,
            ),
        ] {
            if asset.asset_name != name
                || asset.byte_length == 0
                || asset.byte_length > maximum
                || !catalog::hash_valid(&asset.sha256)
            {
                return Err("Invalid portable artifact binding.".into());
            }
        }
        Ok(version)
    }
}

fn signature(bytes: &[u8], sig: &[u8], maximum: usize) -> Result<(), String> {
    if bytes.is_empty()
        || bytes.len() > maximum
        || sig.is_empty()
        || sig.len() > deployment::MAX_SIGNATURE
    {
        return Err("Portable signed metadata exceeds its bound.".into());
    }
    let key = PublicKey::decode(include_str!("catalog-key.pub"))
        .map_err(|_| "Invalid compiled portable update key.")?;
    let sig =
        Signature::decode(std::str::from_utf8(sig).map_err(|_| "Invalid signature encoding.")?)
            .map_err(|_| "Invalid portable signature.")?;
    key.verify(bytes, &sig, false)
        .map_err(|_| "Portable signature verification failed.".into())
}

pub(crate) fn signed_descriptor(bytes: &[u8], sig: &[u8]) -> Result<SignedDescriptor, String> {
    signature(bytes, sig, catalog::MAX_METADATA as usize)?;
    let descriptor: Descriptor = serde_json::from_slice(bytes)
        .map_err(|_| "Invalid or ambiguous signed portable descriptor.")?;
    descriptor.validate()?;
    Ok(SignedDescriptor(descriptor))
}

/// Signature-checked bounded metadata. A descriptor is not installation consent.
#[derive(Debug, Clone)]
pub(crate) struct SignedDescriptor(Descriptor);

impl SignedDescriptor {
    pub(crate) fn version(&self) -> &str {
        &self.0.version
    }
    pub(crate) fn min_hub_version(&self) -> &str {
        &self.0.min_hub_version
    }
    pub(crate) fn archive_byte_length(&self) -> u64 {
        self.0.archive.byte_length
    }
    pub(crate) fn manifest_sha256(&self) -> &str {
        &self.0.manifest.sha256
    }
    pub(crate) fn validate(&self) -> Result<Version, String> {
        self.0.validate()
    }
}

/// The current-version entry point is separate from strictly-newer discovery.
/// Caller already holds the native Manager lease and owns outside-sandbox consent.
pub(crate) fn fetch_current_descriptor(
    _operation: &manager::Operation,
) -> Result<SignedDescriptor, String> {
    let current = stable(env!("CARGO_PKG_VERSION"))?;
    let client = catalog::client()?;
    let url = catalog::release_url(REPO, &current.to_string(), DESCRIPTOR_NAME);
    let bytes = catalog::fetch_small(&client, &url, catalog::MAX_METADATA)?;
    let signature = catalog::fetch_small(
        &client,
        &format!("{url}.minisig"),
        deployment::MAX_SIGNATURE as u64,
    )?;
    let descriptor = signed_descriptor(&bytes, &signature)?;
    require_current_descriptor(descriptor)
}

/// Exact-current cache preparation for a separately consented native bootstrap.
/// This borrows its caller's lease; it never admits an updater coordinator.
pub(crate) fn fetch_current(
    handle: &tauri::AppHandle,
    operation: &manager::Operation,
) -> Result<VerifiedDownload, String> {
    let descriptor = fetch_current_descriptor(operation)?;
    prepare_download(handle, &descriptor, operation)
}

fn require_current_descriptor(descriptor: SignedDescriptor) -> Result<SignedDescriptor, String> {
    if descriptor.validate()? != stable(env!("CARGO_PKG_VERSION"))? {
        return Err("Bootstrap requires the exact running Hub version; no newer or older package was admitted.".into());
    }
    Ok(descriptor)
}

pub(crate) fn cache_root() -> Result<PathBuf, String> {
    manager::linux_update_cache_path(manager::LinuxUpdateCache::Portable)
}

pub(crate) fn regular(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    platform::reject_links(path)?;
    let named = fs::symlink_metadata(path).map_err(|_| "Portable download is unavailable.")?;
    if !named.is_file() || named.nlink() != 1 || named.len() == 0 || named.len() > maximum {
        return Err("Bounded ordinary portable download required.".into());
    }
    let same = |a: &fs::Metadata, b: &fs::Metadata| {
        (
            a.dev(),
            a.ino(),
            a.len(),
            a.mode(),
            a.nlink(),
            a.uid(),
            a.mtime(),
            a.mtime_nsec(),
            a.ctime(),
            a.ctime_nsec(),
        ) == (
            b.dev(),
            b.ino(),
            b.len(),
            b.mode(),
            b.nlink(),
            b.uid(),
            b.mtime(),
            b.mtime_nsec(),
            b.ctime(),
            b.ctime_nsec(),
        )
    };
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "Cannot open portable download.")?;
    let before = file
        .metadata()
        .map_err(|_| "Cannot inspect portable download.")?;
    if !same(&named, &before) {
        return Err("Portable download changed during open.".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read portable download.")?;
    let after = file
        .metadata()
        .map_err(|_| "Cannot recheck portable download.")?;
    platform::reject_links(path)?;
    let current = fs::symlink_metadata(path).map_err(|_| "Portable download pathname changed.")?;
    if bytes.len() as u64 != before.len() || !same(&before, &after) || !same(&before, &current) {
        return Err("Portable download changed while reading.".into());
    }
    Ok(bytes)
}

fn bound(bytes: &[u8], asset: &Asset) -> Result<(), String> {
    if bytes.len() as u64 != asset.byte_length
        || format!("{:x}", Sha256::digest(bytes)) != asset.sha256
    {
        return Err("Portable download differs from the signed descriptor.".into());
    }
    Ok(())
}

pub(crate) struct VerifiedDownload {
    release: SignedDescriptor,
    package: VerifiedPackage,
}

pub(crate) fn verify_download(
    descriptor: &SignedDescriptor,
    directory: &Path,
) -> Result<VerifiedDownload, String> {
    let release = &descriptor.0;
    release.validate()?;
    let manifest = regular(
        &directory.join("manifest.json"),
        deployment::MAX_MANIFEST as u64,
    )?;
    bound(&manifest, &release.manifest)?;
    let sig = regular(
        &directory.join("manifest.minisig"),
        deployment::MAX_SIGNATURE as u64,
    )?;
    // The existing signed manifest is archive authority. No detached archive
    // signature or alternate Tauri latest.json protocol is introduced.
    let package = deployment::verify(
        &manifest,
        &sig,
        &directory.join("archive.tar.gz"),
        &Expected::linux_x86_64(&release.version).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let m = package.manifest();
    if m.archive.size != release.archive.byte_length
        || m.archive.sha256 != release.archive.sha256
        || !matches!(m.entries.get(deployment::ENTRYPOINT), Some(Entry::File { sha256, .. }) if sha256 == &release.executable_sha256)
    {
        return Err("Portable descriptor differs from its signed package.".into());
    }
    Ok(VerifiedDownload {
        release: descriptor.clone(),
        package,
    })
}

impl VerifiedDownload {
    pub(crate) fn descriptor(&self) -> &SignedDescriptor {
        &self.release
    }
    pub(crate) fn package(&self) -> &VerifiedPackage {
        &self.package
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "Cannot exclusively save portable metadata.")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot finish portable metadata.".into())
}

/// Shared by explicit downloads and direct install. Cache preparation is not
/// Store staging or approval: declining later keeps generations/settings intact.
pub(crate) fn prepare_download(
    handle: &tauri::AppHandle,
    descriptor: &SignedDescriptor,
    _operation: &manager::Operation,
) -> Result<VerifiedDownload, String> {
    let destination = cache_root()?.join(&descriptor.0.manifest.sha256);
    platform::reject_links(&destination)?;
    cached_or_fetch(
        &destination,
        |directory| verify_download(descriptor, directory),
        || fetch_download(handle, descriptor, &destination),
    )
}

fn cached_or_fetch<T>(
    destination: &Path,
    verify: impl FnOnce(&Path) -> Result<T, String>,
    fetch: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if destination
        .try_exists()
        .map_err(|_| "Cannot inspect portable download cache.")?
    {
        // Never replace a corrupt/unreviewed cache by treating failure as absence.
        verify(destination)
    } else {
        fetch()
    }
}

fn fetch_download(
    handle: &tauri::AppHandle,
    descriptor: &SignedDescriptor,
    destination: &Path,
) -> Result<VerifiedDownload, String> {
    let release = &descriptor.0;
    let root = manager::prepare_linux_update_cache(manager::LinuxUpdateCache::Portable)?;
    if destination.parent() != Some(root.as_path()) {
        return Err("Portable download cache location changed.".into());
    }
    let cancel = handle.state::<manager::Manager>();
    if cancel.cancellation().load(Ordering::SeqCst) {
        return Err("Portable download cancelled.".into());
    }
    let _ = handle.emit(
        "app-progress",
        self_update::Progress {
            message: format!(
                "Preparing verified portable Creator Hub {}",
                release.version
            ),
            received: 0,
            total: release.archive.byte_length,
            cancellable: true,
        },
    );
    let client = catalog::client()?;
    let url = catalog::release_url(REPO, &release.version, &release.manifest.asset_name);
    let manifest = catalog::fetch_small(&client, &url, release.manifest.byte_length)?;
    bound(&manifest, &release.manifest)?;
    let sig = catalog::fetch_small(
        &client,
        &format!("{url}.minisig"),
        deployment::MAX_SIGNATURE as u64,
    )?;
    signature(&manifest, &sig, deployment::MAX_MANIFEST)?;
    if cancel.cancellation().load(Ordering::SeqCst) {
        return Err("Portable download cancelled.".into());
    }
    if fs2::available_space(&root).map_err(|_| "Cannot check portable download space.")?
        < release.archive.byte_length.saturating_mul(4) + deployment::MAX_TOTAL
    {
        return Err("Not enough space for the portable download.".into());
    }
    let temporary = tempfile::Builder::new()
        .prefix("portable-download-")
        .tempdir_in(&root)
        .map_err(|_| "Cannot prepare private portable download cache.")?;
    write_new(&temporary.path().join("manifest.json"), &manifest)?;
    write_new(&temporary.path().join("manifest.minisig"), &sig)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(temporary.path().join("archive.tar.gz"))
        .map_err(|_| "Cannot save portable archive.")?;
    let sync = file
        .try_clone()
        .map_err(|_| "Cannot hold portable download.")?;
    manager::download_portable_binding(
        &catalog::release_url(REPO, &release.version, &release.archive.asset_name),
        release.archive.byte_length,
        &release.archive.sha256,
        file,
        cancel.cancellation(),
        |received| {
            let _ = handle.emit(
                "app-progress",
                self_update::Progress {
                    message: format!("Downloading portable Creator Hub {}", release.version),
                    received,
                    total: release.archive.byte_length,
                    cancellable: true,
                },
            );
        },
    )?;
    sync.sync_all()
        .map_err(|_| "Cannot finish portable archive.")?;
    let verified = verify_download(descriptor, temporary.path())?;
    if cancel.cancellation().load(Ordering::SeqCst) {
        return Err("Portable download cancelled.".into());
    }
    fs::rename(temporary.path(), destination)
        .map_err(|_| "Cannot publish verified portable download cache.")?;
    File::open(&root)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "Cannot persist portable download cache.")?;
    Ok(verified)
}

#[cfg(test)]
pub(crate) fn test_descriptor(version: &str, minimum: &str) -> SignedDescriptor {
    let mut data = tests::descriptor();
    data.version = version.into();
    data.min_hub_version = minimum.into();
    data.manifest.asset_name = format!("creator-hub-linux-x86_64-{version}.portable-manifest.json");
    data.archive.asset_name = format!("creator-hub-linux-x86_64-{version}.appdir.tar.gz");
    data.validate().expect("valid test-only descriptor");
    SignedDescriptor(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_probe_uses_existing_verified_bytes_and_never_replaces_invalid_cache() {
        use std::cell::Cell;
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let fetched = Cell::new(false);
        assert_eq!(
            cached_or_fetch(
                &cache,
                |_| Err("must not verify absent cache".into()),
                || {
                    fetched.set(true);
                    Ok(7)
                }
            ),
            Ok(7)
        );
        assert!(fetched.get());
        fs::create_dir(&cache).unwrap();
        fs::write(cache.join("sentinel"), b"kept").unwrap();
        let before = fs::read(cache.join("sentinel")).unwrap();
        fetched.set(false);
        let invalid: Result<(), String> = cached_or_fetch(
            &cache,
            |_| Err("invalid signed cache".into()),
            || {
                fetched.set(true);
                Ok(())
            },
        );
        assert_eq!(invalid, Err("invalid signed cache".into()));
        assert!(!fetched.get());
        assert_eq!(fs::read(cache.join("sentinel")).unwrap(), before);
        assert_eq!(
            cached_or_fetch(
                &cache,
                |_| Ok(9),
                || Err("must not fetch verified cache".into())
            ),
            Ok(9)
        );
    }

    pub(super) fn descriptor() -> Descriptor {
        Descriptor {
            schema_version: 1,
            app_id: "creator-hub".into(),
            version: "0.1.17".into(),
            platform: "linux".into(),
            architecture: "x86_64".into(),
            package_type: PACKAGE.into(),
            manifest: Asset {
                asset_name: "creator-hub-linux-x86_64-0.1.17.portable-manifest.json".into(),
                byte_length: 1,
                sha256: "a".repeat(64),
            },
            archive: Asset {
                asset_name: "creator-hub-linux-x86_64-0.1.17.appdir.tar.gz".into(),
                byte_length: 1,
                sha256: "b".repeat(64),
            },
            executable_sha256: "c".repeat(64),
            restart_protocol: 1,
            min_hub_version: "0.1.16".into(),
        }
    }

    #[test]
    fn stable_portable_profile_is_not_a_native_format_fallback() {
        descriptor().validate().unwrap();
        for version in ["0.1.17-beta.1", "0.1.17+local", "v0.1.17", "../0.1.17"] {
            assert!(stable(version).is_err());
        }
        for field in [
            "architecture",
            "platform",
            "packageType",
            "version",
            "restartProtocol",
        ] {
            let mut raw = serde_json::to_value(descriptor()).unwrap();
            raw[field] = if field == "restartProtocol" {
                serde_json::json!(0)
            } else {
                serde_json::json!("other")
            };
            assert!(serde_json::from_value::<Descriptor>(raw)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut release = descriptor();
        release.archive.asset_name = "other.deb".into();
        assert!(release.validate().is_err());
        assert!(signature(b"{}", b"unsigned", catalog::MAX_METADATA as usize).is_err());
        assert!(signed_descriptor(b"{}", b"unsigned").is_err());
    }

    #[test]
    fn hashes_sizes_minimum_and_schema_are_independently_bounded() {
        let mut release = descriptor();
        release.min_hub_version = "0.1.18".into();
        assert!(release.validate().is_err());
        release = descriptor();
        release.manifest.byte_length = deployment::MAX_MANIFEST as u64 + 1;
        assert!(release.validate().is_err());
        release = descriptor();
        release.archive.byte_length = deployment::MAX_ARCHIVE + 1;
        assert!(release.validate().is_err());
        release = descriptor();
        release.archive.sha256 = "A".repeat(64);
        assert!(release.validate().is_err());
        let mut raw = serde_json::to_value(descriptor()).unwrap();
        raw["archiveSignature"] = serde_json::json!("unneeded");
        assert!(serde_json::from_value::<Descriptor>(raw).is_err());
    }

    #[test]
    fn read_only_download_verification_refuses_links_special_files_and_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data");
        fs::write(&path, b"a").unwrap();
        assert_eq!(regular(&path, 1).unwrap(), b"a");
        assert!(regular(dir.path(), 4096).is_err());
        assert!(regular(&path, 0).is_err());
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(regular(&link, 1).is_err());
        let hard = dir.path().join("hard");
        fs::hard_link(&path, hard).unwrap();
        assert!(regular(&path, 1).is_err());
        let asset = Asset {
            asset_name: "unused".into(),
            byte_length: 1,
            sha256: format!("{:x}", Sha256::digest(b"a")),
        };
        bound(b"a", &asset).unwrap();
        assert!(bound(b"b", &asset).is_err());
        assert!(bound(b"aa", &asset).is_err());
    }
    #[test]
    fn identity_verification_does_not_apply_newer_policy_and_bootstrap_requires_current() {
        let current = stable(env!("CARGO_PKG_VERSION")).unwrap();
        let older = Version::new(
            current.major,
            current.minor,
            current.patch.checked_sub(1).unwrap(),
        );
        let newer = Version::new(current.major, current.minor, current.patch + 1);
        for version in [&older, &current, &newer] {
            let descriptor = test_descriptor(&version.to_string(), "0.0.0");
            assert_eq!(descriptor.validate().unwrap(), *version);
            assert_eq!(
                require_current_descriptor(descriptor).is_ok(),
                *version == current
            );
        }
    }

    #[test]
    fn opaque_package_interfaces_borrow_the_existing_manager_lease() {
        let _: fn(&manager::Operation) -> Result<SignedDescriptor, String> =
            fetch_current_descriptor;
        let _: fn(&tauri::AppHandle, &manager::Operation) -> Result<VerifiedDownload, String> =
            fetch_current;
        let _: fn(
            &tauri::AppHandle,
            &SignedDescriptor,
            &manager::Operation,
        ) -> Result<VerifiedDownload, String> = prepare_download;
        let _: fn(&SignedDescriptor, &Path) -> Result<VerifiedDownload, String> = verify_download;
        let _: fn(&VerifiedDownload) -> &SignedDescriptor = VerifiedDownload::descriptor;
        let _: fn(&VerifiedDownload) -> &VerifiedPackage = VerifiedDownload::package;
        let descriptor = test_descriptor(env!("CARGO_PKG_VERSION"), "0.0.0");
        assert_eq!(descriptor.version(), env!("CARGO_PKG_VERSION"));
        assert_eq!(descriptor.min_hub_version(), "0.0.0");
        assert_eq!(descriptor.archive_byte_length(), 1);
        assert_eq!(descriptor.manifest_sha256(), "a".repeat(64));
    }
}
