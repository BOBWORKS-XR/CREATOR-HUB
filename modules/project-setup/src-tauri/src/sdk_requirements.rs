//! Read-only SDK requirements. Absence is not evidence of incompatibility.
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::marker::PhantomData;
use std::path::{Component, Path};
use std::time::Duration;

pub const PACKAGE_NAME: &str = "com.sidequest.creator-sdk";
pub const MAX_METADATA_BYTES: usize = 64 * 1024;
pub const MAX_PROJECT_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_DEPENDENCIES: usize = 128;
const MAX_CACHE_ENTRIES: usize = 512;
const REGISTRY: &str = "https://greenfield-registry.sdq.st/com.sidequest.creator-sdk/";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirements {
    pub version: String,
    /// The declared precision is retained; no patch version is invented.
    pub unity_version: Option<String>,
    /// Only exact SemVer dependencies are actionable. Missing entries must be preserved.
    pub dependencies: BTreeMap<String, String>,
}

#[derive(Debug)]
enum MetadataError {
    Unknown(String),
    Unsafe(String),
}

impl MetadataError {
    fn message(self) -> String {
        match self {
            Self::Unknown(message) => format!("SDK requirements are unknown: {message}"),
            Self::Unsafe(message) => format!("SDK metadata refused: {message}"),
        }
    }
}

fn unique_map<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Unique<T>(PhantomData<T>);
    impl<'de, T: Deserialize<'de>> Visitor<'de> for Unique<T> {
        type Value = BTreeMap<String, T>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an object with unique package names")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((name, value)) = map.next_entry::<String, T>()? {
                if result.insert(name, value).is_some() {
                    return Err(de::Error::custom("duplicate package name"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Unique(PhantomData))
}

#[derive(Deserialize)]
struct Document {
    name: String,
    version: String,
    unity: Option<String>,
    #[serde(rename = "unityRelease")]
    unity_release: Option<String>,
    #[serde(default, deserialize_with = "unique_map")]
    dependencies: BTreeMap<String, String>,
}

fn bounded(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_METADATA_BYTES {
        return Err("SDK metadata is empty or exceeds 64 KiB.".into());
    }
    Ok(())
}

fn project_json_bounded(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_PROJECT_JSON_BYTES {
        return Err("Project package selection JSON is empty or exceeds 2 MiB.".into());
    }
    Ok(())
}

fn exact_version(value: &str) -> Result<String, String> {
    if value.len() > 128 {
        return Err("SDK version exceeds its length bound.".into());
    }
    let parsed = semver::Version::parse(value).map_err(|_| "An exact SDK SemVer is required.")?;
    if parsed.to_string() != value {
        return Err("An exact canonical SDK SemVer is required.".into());
    }
    Ok(value.to_owned())
}

fn safe_name(name: &str) -> bool {
    name.len() <= 200
        && name.contains('.')
        && name.split('.').all(|part| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_lowercase()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        })
}

fn decimal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 10
        && value.bytes().all(|b| b.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

/// Combine the SDK's Unity minimum without pinning the app to a numeric allowlist.
pub fn unity_minimum(unity: Option<&str>, release: Option<&str>) -> Result<Option<String>, String> {
    let Some(unity) = unity else {
        return if release.is_none() {
            Ok(None)
        } else {
            Err("unityRelease requires unity.".into())
        };
    };
    let parts: Vec<_> = unity.split('.').collect();
    if parts.len() != 2 || !parts.iter().all(|part| decimal(part)) {
        return Err("Invalid declared Unity major/minor minimum.".into());
    }
    let Some(release) = release else {
        return Ok(Some(unity.to_owned()));
    };
    if release.len() > 32 {
        return Err("Invalid declared Unity release minimum.".into());
    }
    let first_letter = release
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(release.len());
    if !decimal(&release[..first_letter]) || first_letter == release.len() {
        return Err("Invalid declared Unity release minimum.".into());
    }
    let mut suffix = &release[first_letter..];
    while !suffix.is_empty() {
        if !suffix.as_bytes()[0].is_ascii_lowercase() {
            return Err("Invalid declared Unity release minimum.".into());
        }
        suffix = &suffix[1..];
        let end = suffix
            .bytes()
            .position(|b| !b.is_ascii_digit())
            .unwrap_or(suffix.len());
        if !decimal(&suffix[..end]) {
            return Err("Invalid declared Unity release minimum.".into());
        }
        suffix = &suffix[end..];
    }
    Ok(Some(format!("{unity}.{release}")))
}

fn parse_document(bytes: &[u8]) -> Result<Requirements, MetadataError> {
    bounded(bytes).map_err(MetadataError::Unsafe)?;
    let doc: Document = serde_json::from_slice(bytes).map_err(|_| {
        MetadataError::Unknown("package.json is not supported valid metadata.".into())
    })?;
    if doc.name != PACKAGE_NAME {
        return Err(MetadataError::Unsafe(
            "package name is not com.sidequest.creator-sdk.".into(),
        ));
    }
    let version = exact_version(&doc.version).map_err(MetadataError::Unsafe)?;
    if doc.dependencies.len() > MAX_DEPENDENCIES {
        return Err(MetadataError::Unsafe("too many SDK dependencies.".into()));
    }
    let mut dependencies = BTreeMap::new();
    for (name, value) in doc.dependencies {
        if !safe_name(&name) || value.len() > 2048 {
            return Err(MetadataError::Unsafe(
                "unsafe SDK dependency name or oversized value.".into(),
            ));
        }
        if let Ok(version) = exact_version(&value) {
            dependencies.insert(name, version);
        }
    }
    Ok(Requirements {
        version,
        unity_version: unity_minimum(doc.unity.as_deref(), doc.unity_release.as_deref())
            .map_err(MetadataError::Unknown)?,
        dependencies,
    })
}

pub fn parse(bytes: &[u8]) -> Result<Requirements, String> {
    parse_document(bytes).map_err(MetadataError::message)
}

pub fn parse_exact(bytes: &[u8], expected_version: &str) -> Result<Requirements, String> {
    let expected = exact_version(expected_version)?;
    let result = parse(bytes)?;
    if result.version != expected {
        return Err("SDK metadata version differs from the selected exact version.".into());
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct Selection<T> {
    #[serde(default, deserialize_with = "unique_map")]
    dependencies: BTreeMap<String, T>,
}

#[derive(Deserialize)]
struct LockedVersion {
    version: String,
}

/// Non-exact registry ranges, git/file references and absent entries are unknown.
pub fn manifest_version(bytes: &[u8]) -> Result<Option<String>, String> {
    project_json_bounded(bytes)?;
    let doc: Selection<String> =
        serde_json::from_slice(bytes).map_err(|_| "Invalid project manifest metadata.")?;
    Ok(doc
        .dependencies
        .get(PACKAGE_NAME)
        .and_then(|v| exact_version(v).ok()))
}

pub fn lock_version(bytes: &[u8]) -> Result<Option<String>, String> {
    project_json_bounded(bytes)?;
    let doc: Selection<LockedVersion> =
        serde_json::from_slice(bytes).map_err(|_| "Invalid package-lock metadata.")?;
    Ok(doc
        .dependencies
        .get(PACKAGE_NAME)
        .and_then(|v| exact_version(&v.version).ok()))
}

fn plain(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}

fn check_path(path: &Path) -> Result<bool, MetadataError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err(MetadataError::Unsafe(
            "SDK metadata path must be absolute and contain no traversal.".into(),
        ));
    }
    let mut exists = true;
    for ancestor in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if !plain(&meta) => {
                return Err(MetadataError::Unsafe(
                    "Linked SDK metadata paths are refused.".into(),
                ))
            }
            Ok(meta) if ancestor != path && !meta.is_dir() => {
                return Err(MetadataError::Unsafe(
                    "SDK metadata ancestor is not a directory.".into(),
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => exists = false,
            Err(_) => {
                return Err(MetadataError::Unknown(
                    "SDK metadata path cannot be inspected.".into(),
                ))
            }
        }
    }
    Ok(exists)
}

fn file_identity(file: &File) -> Result<(u64, u64), MetadataError> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), info.as_mut_ptr()) }
            == 0
        {
            return Err(MetadataError::Unknown(
                "Cannot verify SDK metadata file identity.".into(),
            ));
        }
        let info = unsafe { info.assume_init() };
        if info.nNumberOfLinks != 1 || info.dwFileAttributes & 0x400 != 0 {
            return Err(MetadataError::Unsafe(
                "Linked SDK metadata files are refused.".into(),
            ));
        }
        Ok((
            info.dwVolumeSerialNumber as u64,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file
            .metadata()
            .map_err(|_| MetadataError::Unknown("Cannot inspect SDK metadata file.".into()))?;
        if meta.nlink() != 1 {
            return Err(MetadataError::Unsafe(
                "Linked SDK metadata files are refused.".into(),
            ));
        }
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = file;
        Err(MetadataError::Unknown(
            "Safe SDK metadata inspection is unsupported on this platform.".into(),
        ))
    }
}

fn open_read(path: &Path) -> Result<File, MetadataError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x0020_0000);
    }
    options
        .open(path)
        .map_err(|_| MetadataError::Unknown("SDK metadata file cannot be read.".into()))
}

fn read(path: &Path, max_bytes: usize) -> Result<Option<Vec<u8>>, MetadataError> {
    if !check_path(path)? {
        return Ok(None);
    }
    let named = fs::symlink_metadata(path)
        .map_err(|_| MetadataError::Unknown("Cannot inspect SDK metadata file.".into()))?;
    if !named.is_file() || named.len() > max_bytes as u64 {
        return Err(MetadataError::Unsafe(format!(
            "JSON metadata must be an ordinary file of at most {max_bytes} bytes."
        )));
    }
    let file = open_read(path)?;
    let before = file
        .metadata()
        .map_err(|_| MetadataError::Unknown("Cannot inspect SDK metadata file.".into()))?;
    if !plain(&before) || !before.is_file() || before.len() > max_bytes as u64 {
        return Err(MetadataError::Unsafe(format!(
            "JSON metadata must be an ordinary file of at most {max_bytes} bytes."
        )));
    }
    let identity = file_identity(&file)?;
    let mut bytes = Vec::new();
    (&file)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| MetadataError::Unknown("Cannot read SDK metadata bytes.".into()))?;
    if bytes.len() > max_bytes {
        return Err(MetadataError::Unsafe(format!(
            "JSON metadata exceeds {max_bytes} bytes."
        )));
    }
    if !check_path(path)?
        || file_identity(&open_read(path)?)? != identity
        || file
            .metadata()
            .map_err(|_| MetadataError::Unknown("Cannot recheck SDK metadata.".into()))?
            .modified()
            .ok()
            != before.modified().ok()
        || bytes.len() as u64 != before.len()
    {
        return Err(MetadataError::Unsafe(
            "SDK metadata changed during inspection.".into(),
        ));
    }
    Ok(Some(bytes))
}

fn provided_manifest_path(path: &Path, byte_length: usize) -> Result<bool, MetadataError> {
    if byte_length > MAX_PROJECT_JSON_BYTES {
        return Err(MetadataError::Unsafe(
            "Provided manifest exceeds 2 MiB.".into(),
        ));
    }
    if !check_path(path)? {
        return Ok(false);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| MetadataError::Unknown("Cannot inspect the manifest path.".into()))?;
    if !plain(&metadata) || !metadata.is_file() || metadata.len() > MAX_PROJECT_JSON_BYTES as u64 {
        return Err(MetadataError::Unsafe(
            "Manifest must be an ordinary file of at most 2 MiB.".into(),
        ));
    }
    if metadata.len() != byte_length as u64 {
        return Err(MetadataError::Unsafe(
            "Manifest byte snapshot no longer matches its file size.".into(),
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Query identity only. No data access, and the caller's writer stays protected.
        let inspect = || {
            OpenOptions::new()
                .access_mode(0)
                .share_mode(3)
                .custom_flags(0x0020_0000)
                .open(path)
                .map_err(|_| MetadataError::Unknown("Cannot inspect the manifest identity.".into()))
        };
        let file = inspect()?;
        let identity = file_identity(&file)?;
        let current = file.metadata().map_err(|_| {
            MetadataError::Unknown("Cannot inspect the manifest attributes.".into())
        })?;
        if !plain(&current)
            || !current.is_file()
            || current.len() != metadata.len()
            || current.modified().ok() != metadata.modified().ok()
            || !check_path(path)?
            || file_identity(&inspect()?)? != identity
        {
            return Err(MetadataError::Unsafe(
                "Manifest path changed during inspection.".into(),
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(MetadataError::Unsafe(
                "Linked manifest files are refused.".into(),
            ));
        }
    }
    #[cfg(not(any(windows, unix)))]
    return Err(MetadataError::Unknown(
        "Safe manifest path inspection is unsupported on this platform.".into(),
    ));
    Ok(true)
}

fn local_document(path: &Path, expected: &str) -> Result<Option<Requirements>, MetadataError> {
    let Some(bytes) = read(path, MAX_METADATA_BYTES)? else {
        return Ok(None);
    };
    match parse_document(&bytes) {
        Ok(result) if result.version == expected => Ok(Some(result)),
        _ => Ok(None),
    }
}

/// No network or writes. Missing, unreadable or untrusted metadata is advisory None.
/// Err is reserved for physical path, link, size or inspection-race safety failures.
pub fn installed(root: &Path, expected_version: &str) -> Result<Option<Requirements>, String> {
    local_inspection_result(installed_inner(root, expected_version, None))
}

/// The caller must bind these exact bytes to its own held manifest guard/review.
/// Only the duplicate manifest content read is omitted; all other checks remain.
pub(crate) fn installed_with_manifest(
    root: &Path,
    expected_version: &str,
    manifest_bytes: &[u8],
) -> Result<Option<Requirements>, String> {
    local_inspection_result(installed_inner(
        root,
        expected_version,
        Some(manifest_bytes),
    ))
}

fn local_inspection_result(
    result: Result<Option<Requirements>, MetadataError>,
) -> Result<Option<Requirements>, String> {
    match result {
        Ok(result) => Ok(result),
        Err(MetadataError::Unknown(_)) => Ok(None),
        Err(error) => Err(error.message()),
    }
}

fn installed_inner(
    root: &Path,
    expected_version: &str,
    provided_manifest: Option<&[u8]>,
) -> Result<Option<Requirements>, MetadataError> {
    let Ok(expected) = exact_version(expected_version) else {
        return Ok(None);
    };
    if !check_path(root)? || !root.is_dir() {
        return Err(MetadataError::Unsafe(
            "Project root is not an ordinary directory.".into(),
        ));
    }
    let manifest_path = root.join("Packages/manifest.json");
    let disk_manifest = if provided_manifest.is_none() {
        read(&manifest_path, MAX_PROJECT_JSON_BYTES)?
    } else {
        None
    };
    let manifest = if let Some(bytes) = provided_manifest {
        if !provided_manifest_path(&manifest_path, bytes.len())? {
            return Ok(None);
        }
        Some(bytes)
    } else {
        disk_manifest.as_deref()
    };
    let lock = read(
        &root.join("Packages/packages-lock.json"),
        MAX_PROJECT_JSON_BYTES,
    )?;
    let manifest_selection = manifest.map(manifest_version).transpose();
    let lock_selection = lock.as_deref().map(lock_version).transpose();
    let (Ok(manifest_selection), Ok(lock_selection)) = (manifest_selection, lock_selection) else {
        return Ok(None);
    };
    let selected = [manifest_selection.flatten(), lock_selection.flatten()];
    if selected.iter().flatten().any(|v| v != &expected) {
        return Ok(None);
    }
    if selected.iter().all(Option::is_none) {
        return Ok(None);
    }
    let embedded = root.join("Packages").join(PACKAGE_NAME);
    if check_path(&embedded)? {
        if !embedded.is_dir() {
            return Err(MetadataError::Unsafe(
                "Embedded SDK is not an ordinary directory.".into(),
            ));
        }
        return local_document(&embedded.join("package.json"), &expected);
    }
    let cache = root.join("Library/PackageCache");
    if !check_path(&cache)? {
        return Ok(None);
    }
    if !cache.is_dir() {
        return Err(MetadataError::Unsafe(
            "SDK package cache is not an ordinary directory.".into(),
        ));
    }
    let mut candidates = Vec::new();
    for (index, entry) in fs::read_dir(&cache)
        .map_err(|_| MetadataError::Unknown("Cannot inspect SDK package cache.".into()))?
        .enumerate()
    {
        if index >= MAX_CACHE_ENTRIES {
            return Err(MetadataError::Unsafe(
                "SDK package cache exceeds its inspection bound.".into(),
            ));
        }
        let entry = entry.map_err(|_| {
            MetadataError::Unknown("Cannot inspect SDK package cache entry.".into())
        })?;
        let name = entry.file_name();
        let Some(suffix) = name
            .to_str()
            .and_then(|name| name.strip_prefix("com.sidequest.creator-sdk@"))
        else {
            continue;
        };
        if suffix.is_empty()
            || suffix.contains("..")
            || !suffix.bytes().all(|b| {
                b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_' || b == b'+'
            })
        {
            return Err(MetadataError::Unsafe(
                "Unsafe SDK package cache name.".into(),
            ));
        }
        if exact_version(suffix).is_ok_and(|v| v != expected) {
            continue;
        }
        candidates.push((entry.path(), exact_version(suffix).is_ok()));
    }
    candidates.sort();
    let mut result = None;
    for (directory, version_named) in candidates {
        if !check_path(&directory)? || !directory.is_dir() {
            return Err(MetadataError::Unsafe(
                "SDK cache entry is not an ordinary directory.".into(),
            ));
        }
        let path = directory.join("package.json");
        let Some(bytes) = read(&path, MAX_METADATA_BYTES)? else {
            continue;
        };
        let parsed = match parse_document(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(None),
        };
        if parsed.version != expected {
            if version_named {
                return Ok(None);
            }
            continue;
        }
        if result.as_ref().is_some_and(|previous| previous != &parsed) {
            return Ok(None);
        }
        result = Some(parsed);
    }
    Ok(result)
}

fn endpoint(version: Option<&str>) -> Result<reqwest::Url, String> {
    let selector = match version {
        Some(value) => exact_version(value)?,
        None => "latest".into(),
    };
    let url = reqwest::Url::parse(REGISTRY)
        .map_err(|_| "Invalid official SDK registry.")?
        .join(&selector)
        .map_err(|_| "Invalid SDK registry selector.")?;
    if url.scheme() != "https"
        || url.host_str() != Some("greenfield-registry.sdq.st")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Non-official SDK registry endpoint refused.".into());
    }
    Ok(url)
}

fn fetch(version: Option<&str>) -> Result<Requirements, String> {
    let url = endpoint(version)?;
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "SDK registry client is unavailable.")?;
    let response = client
        .get(url.clone())
        .send()
        .map_err(|_| "SDK requirements are unknown: official registry request failed.")?;
    if response.url() != &url || response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "SDK requirements are unknown: official registry returned {} (redirects are refused).",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_METADATA_BYTES as u64)
    {
        return Err("Official SDK metadata exceeds 64 KiB.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_METADATA_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "SDK requirements are unknown: official response could not be read.")?;
    match version {
        Some(version) => parse_exact(&bytes, version),
        None => parse(&bytes),
    }
}

pub fn latest() -> Result<Requirements, String> {
    fetch(None)
}
#[cfg(test)]
fn exact(version: &str) -> Result<Requirements, String> {
    fetch(Some(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn metadata(version: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({"name":PACKAGE_NAME,"version":version,"unity":"6000.3","unityRelease":"21f1",
            "dependencies":{"com.unity.render-pipelines.universal":"17.4.0","com.unity.inputsystem":"1.4.4","com.unity.visualscripting":"1.9.1"}})).unwrap()
    }
    fn project(version: &str) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("Packages")).unwrap();
        fs::write(
            root.path().join("Packages/manifest.json"),
            serde_json::to_vec(&json!({"dependencies":{PACKAGE_NAME:version}})).unwrap(),
        )
        .unwrap();
        root
    }
    fn write(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn selection_fixture(locked: bool, size: usize) -> Vec<u8> {
        let entry = if locked {
            json!({"version":"4.0.25","depth":0,"source":"registry","dependencies":{}})
        } else {
            json!("4.0.25")
        };
        let mut dependencies = serde_json::Map::new();
        dependencies.insert(PACKAGE_NAME.into(), entry.clone());
        for index in 0..512 {
            dependencies.insert(format!("com.example.package{index}"), entry.clone());
        }
        let mut document = json!({"dependencies":dependencies,"fixturePadding":""});
        let initial_size = serde_json::to_vec(&document).unwrap().len();
        document["fixturePadding"] = json!("x".repeat(size.checked_sub(initial_size).unwrap()));
        let bytes = serde_json::to_vec(&document).unwrap();
        assert_eq!(bytes.len(), size);
        bytes
    }
    #[test]
    fn seventy_kib_project_json_keeps_verified_sdk_requirements() {
        let root = project("4.0.25");
        let manifest = selection_fixture(false, 70 * 1024);
        let lock = selection_fixture(true, 70 * 1024);
        assert_eq!(
            manifest_version(&manifest).unwrap().as_deref(),
            Some("4.0.25")
        );
        assert_eq!(lock_version(&lock).unwrap().as_deref(), Some("4.0.25"));
        write(root.path(), "Packages/manifest.json", &manifest);
        write(root.path(), "Packages/packages-lock.json", &lock);
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("4.0.25"),
        );
        assert_eq!(
            installed(root.path(), "4.0.25").unwrap(),
            Some(parse(&metadata("4.0.25")).unwrap())
        );
        assert_eq!(
            fs::read(root.path().join("Packages/manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read(root.path().join("Packages/packages-lock.json")).unwrap(),
            lock
        );
    }
    #[test]
    fn project_json_two_mib_boundary_does_not_raise_sdk_metadata_limit() {
        let root = project("4.0.25");
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("4.0.25"),
        );
        for (locked, relative) in [
            (false, "Packages/manifest.json"),
            (true, "Packages/packages-lock.json"),
        ] {
            let allowed = selection_fixture(locked, MAX_PROJECT_JSON_BYTES);
            let refused = selection_fixture(locked, MAX_PROJECT_JSON_BYTES + 1);
            let parser = if locked {
                lock_version
            } else {
                manifest_version
            };
            assert_eq!(parser(&allowed).unwrap().as_deref(), Some("4.0.25"));
            assert!(parser(&refused).is_err());
            write(root.path(), relative, &allowed);
            assert_eq!(
                installed(root.path(), "4.0.25").unwrap().unwrap().version,
                "4.0.25"
            );
            write(root.path(), relative, &refused);
            assert!(installed(root.path(), "4.0.25").is_err());
            assert_eq!(fs::read(root.path().join(relative)).unwrap(), refused);
            write(root.path(), relative, &allowed);
        }
        let mut package = metadata("4.0.25");
        package.resize(70 * 1024, b' ');
        assert!(serde_json::from_slice::<serde_json::Value>(&package).is_ok());
        assert!(parse(&package).is_err());
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &package,
        );
        assert!(installed(root.path(), "4.0.25").is_err());
    }
    #[test]
    fn current_and_future_versions_use_declared_requirements() {
        for version in ["4.0.25", "100.42.7", "101.0.0-preview.1+build.5"] {
            let r = parse_exact(&metadata(version), version).unwrap();
            assert_eq!(r.version, version);
            assert_eq!(r.unity_version.as_deref(), Some("6000.3.21f1"));
            assert_eq!(r.dependencies["com.unity.inputsystem"], "1.4.4");
            assert_eq!(
                r.dependencies["com.unity.render-pipelines.universal"],
                "17.4.0"
            );
        }
    }
    #[test]
    fn identity_versions_bounds_and_duplicates_are_refused() {
        assert!(parse_exact(&metadata("4.0.25"), "4.0.24").is_err());
        for version in [
            "4.0",
            "^4.0.25",
            "v4.0.25",
            " 4.0.25",
            "4.00.25",
            "file:../sdk",
        ] {
            assert!(parse(&metadata(version)).is_err());
        }
        assert!(parse(br#"{"name":"other.sdk","version":"4.0.25"}"#).is_err());
        assert!(parse(
            br#"{"name":"com.sidequest.creator-sdk","version":"4.0.25","version":"4.0.26"}"#
        )
        .is_err());
        assert!(parse(&vec![b' '; MAX_METADATA_BYTES + 1]).is_err());
        assert!(parse(b"").is_err());
    }
    #[test]
    fn declared_unity_precision_and_unknown_are_preserved() {
        assert_eq!(unity_minimum(None, None).unwrap(), None);
        assert_eq!(
            unity_minimum(Some("2022.3"), None).unwrap().as_deref(),
            Some("2022.3")
        );
        assert_eq!(
            unity_minimum(Some("6000.3"), Some("21f1c1"))
                .unwrap()
                .as_deref(),
            Some("6000.3.21f1c1")
        );
        for (unity, release) in [
            (None, Some("21f1")),
            (Some("6000.3.21"), None),
            (Some("6000.3"), Some("../21f1")),
            (Some("6000.3"), Some("21f")),
            (Some("6000.3"), Some("21\u{e9}1")),
        ] {
            assert!(unity_minimum(unity, release).is_err());
        }
    }
    #[test]
    fn dependency_ranges_are_not_actionable_and_unsafe_names_are_refused() {
        let mut doc: serde_json::Value = serde_json::from_slice(&metadata("4.0.25")).unwrap();
        doc["dependencies"]["com.example.range"] = json!("^2.0.0");
        doc["dependencies"]["com.example.git"] = json!("https://example.invalid/x.git");
        let parsed = parse(&serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(parsed.dependencies.len(), 3);
        assert_eq!(
            parsed.dependencies.keys().next().unwrap(),
            "com.unity.inputsystem"
        );
        doc["dependencies"]["../outside"] = json!("1.0.0");
        assert!(parse(&serde_json::to_vec(&doc).unwrap()).is_err());
        doc["dependencies"] = json!({});
        for i in 0..=MAX_DEPENDENCIES {
            doc["dependencies"][format!("com.example.p{i}")] = json!("1.0.0");
        }
        assert!(parse(&serde_json::to_vec(&doc).unwrap()).is_err());
    }
    #[test]
    fn selection_parsers_require_exact_actionable_versions() {
        assert_eq!(
            manifest_version(br#"{"dependencies":{"com.sidequest.creator-sdk":"4.0.25"}}"#)
                .unwrap(),
            Some("4.0.25".into())
        );
        assert_eq!(
            manifest_version(br#"{"dependencies":{"com.sidequest.creator-sdk":"file:../sdk"}}"#)
                .unwrap(),
            None
        );
        assert_eq!(lock_version(br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25","source":"registry"}}}"#).unwrap(), Some("4.0.25".into()));
        assert!(lock_version(br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25","version":"4.0.26"}}}"#).is_err());
    }
    #[test]
    fn embedded_inspection_is_read_only_and_bound_to_selection() {
        let root = project("100.0.0");
        let bytes = metadata("100.0.0");
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &bytes,
        );
        assert_eq!(
            installed(root.path(), "100.0.0").unwrap(),
            Some(parse(&bytes).unwrap())
        );
        assert_eq!(
            fs::read(
                root.path()
                    .join("Packages/com.sidequest.creator-sdk/package.json")
            )
            .unwrap(),
            bytes
        );
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
        write(
            root.path(),
            "Packages/packages-lock.json",
            br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25"}}}"#,
        );
        assert_eq!(installed(root.path(), "100.0.0").unwrap(), None);
    }
    #[test]
    fn absent_or_unparseable_local_metadata_is_unknown_not_incompatibility() {
        let root = project("4.0.25");
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            b"not JSON",
        );
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("4.0.24"),
        );
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
    }
    #[test]
    fn unusable_metadata_never_authorizes_dependency_repairs() {
        let root = project("99.0.0");
        for bytes in [
            Vec::new(),
            br#"{"name":"another.package","version":"99.0.0"}"#.to_vec(),
            br#"{"name":"com.sidequest.creator-sdk","version":"99.0.0","unity":"unknown"}"#.to_vec(),
            br#"{"name":"com.sidequest.creator-sdk","version":"99.0.0","dependencies":{"../bad":"1.0.0"}}"#.to_vec(),
        ] {
            write(root.path(), "Packages/com.sidequest.creator-sdk/package.json", &bytes);
            assert_eq!(installed(root.path(), "99.0.0").unwrap(), None);
            assert_eq!(fs::read(root.path().join("Packages/com.sidequest.creator-sdk/package.json")).unwrap(), bytes);
        }
        assert_eq!(installed(root.path(), "not-exact-semver").unwrap(), None);
    }
    #[cfg(windows)]
    #[test]
    fn held_metadata_is_stable_unknown_until_readable_and_never_written() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = project("99.0.0");
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("99.0.0"),
        );
        write(
            root.path(),
            "Packages/packages-lock.json",
            br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"99.0.0"}}}"#,
        );
        for relative in [
            "Packages/com.sidequest.creator-sdk/package.json",
            "Packages/manifest.json",
            "Packages/packages-lock.json",
        ] {
            let path = root.path().join(relative);
            let before = fs::read(&path).unwrap();
            let held = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            for _ in 0..2 {
                assert_eq!(installed(root.path(), "99.0.0").unwrap(), None);
            }
            drop(held);
            assert_eq!(fs::read(&path).unwrap(), before);
            assert_eq!(
                installed(root.path(), "99.0.0").unwrap().unwrap().version,
                "99.0.0"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn owned_manifest_writer_can_supply_bytes_without_loosening_content_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = project("99.0.0");
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("99.0.0"),
        );
        let path = root.path().join("Packages/manifest.json");
        let before = fs::read(&path).unwrap();
        let mut owner = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let mut owned_bytes = Vec::new();
        owner.read_to_end(&mut owned_bytes).unwrap();
        assert_eq!(owned_bytes, before);
        assert_eq!(installed(root.path(), "99.0.0").unwrap(), None);
        for _ in 0..2 {
            assert_eq!(
                installed_with_manifest(root.path(), "99.0.0", &owned_bytes).unwrap(),
                Some(parse(&metadata("99.0.0")).unwrap())
            );
            assert!(OpenOptions::new().write(true).open(&path).is_err());
        }
        drop(owner);
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    #[test]
    fn provided_manifest_keeps_selector_lock_sdk_and_size_checks() {
        let root = project("4.0.25");
        let path = root.path().join("Packages/manifest.json");
        let manifest = fs::read(&path).unwrap();
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("4.0.25"),
        );
        assert!(installed_with_manifest(root.path(), "4.0.25", &manifest)
            .unwrap()
            .is_some());
        assert_eq!(
            installed_with_manifest(root.path(), "4.0.24", &manifest).unwrap(),
            None
        );
        assert_eq!(
            installed_with_manifest(root.path(), "4.0.25", &vec![b' '; manifest.len()]).unwrap(),
            None
        );
        assert!(installed_with_manifest(
            root.path(),
            "4.0.25",
            &vec![b' '; MAX_PROJECT_JSON_BYTES + 1]
        )
        .is_err());
        write(
            root.path(),
            "Packages/packages-lock.json",
            br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.24"}}}"#,
        );
        assert_eq!(
            installed_with_manifest(root.path(), "4.0.25", &manifest).unwrap(),
            None
        );
        write(
            root.path(),
            "Packages/packages-lock.json",
            br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25"}}}"#,
        );
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("4.0.24"),
        );
        assert_eq!(
            installed_with_manifest(root.path(), "4.0.25", &manifest).unwrap(),
            None
        );
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &vec![b' '; MAX_METADATA_BYTES + 1],
        );
        assert!(installed_with_manifest(root.path(), "4.0.25", &manifest).is_err());
        fs::remove_file(path).unwrap();
        assert_eq!(
            installed_with_manifest(root.path(), "4.0.25", &manifest).unwrap(),
            None
        );
    }
    #[test]
    fn provided_manifest_does_not_trust_a_hardlinked_path() {
        let root = project("4.0.25");
        let path = root.path().join("Packages/manifest.json");
        let manifest = fs::read(&path).unwrap();
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &metadata("4.0.25"),
        );
        fs::hard_link(&path, root.path().join("manifest-alias.json")).unwrap();
        assert!(installed_with_manifest(root.path(), "4.0.25", &manifest).is_err());
        assert_eq!(fs::read(path).unwrap(), manifest);
    }
    #[test]
    fn nonregular_metadata_is_a_physical_safety_error() {
        let root = project("4.0.25");
        fs::create_dir_all(
            root.path()
                .join("Packages/com.sidequest.creator-sdk/package.json"),
        )
        .unwrap();
        assert!(installed(root.path(), "4.0.25").is_err());
    }
    #[test]
    fn package_cache_matches_version_or_hash_folders_and_rejects_conflicts() {
        let root = project("4.0.25");
        write(
            root.path(),
            "Library/PackageCache/com.sidequest.creator-sdk@abc123/package.json",
            &metadata("4.0.25"),
        );
        write(
            root.path(),
            "Library/PackageCache/com.sidequest.creator-sdk@4.0.24/package.json",
            &metadata("4.0.24"),
        );
        assert_eq!(
            installed(root.path(), "4.0.25").unwrap().unwrap().version,
            "4.0.25"
        );
        let mut different: serde_json::Value = serde_json::from_slice(&metadata("4.0.25")).unwrap();
        different["unityRelease"] = json!("22f1");
        write(
            root.path(),
            "Library/PackageCache/com.sidequest.creator-sdk@def456/package.json",
            &serde_json::to_vec(&different).unwrap(),
        );
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
    }
    #[test]
    fn version_named_cache_cannot_substitute_other_metadata() {
        let root = project("4.0.25");
        write(
            root.path(),
            "Library/PackageCache/com.sidequest.creator-sdk@4.0.25/package.json",
            &metadata("4.0.24"),
        );
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
    }
    #[test]
    fn future_cache_version_with_semver_build_metadata_is_supported() {
        let version = "99.0.0-preview.1+build.5";
        let root = project(version);
        write(
            root.path(),
            &format!("Library/PackageCache/{PACKAGE_NAME}@{version}/package.json"),
            &metadata(version),
        );
        assert_eq!(
            installed(root.path(), version).unwrap().unwrap().version,
            version
        );
    }
    #[test]
    fn links_traversal_and_oversized_files_are_refused() {
        let root = project("4.0.25");
        let external = tempfile::tempdir().unwrap();
        let file = external.path().join("package.json");
        fs::write(&file, metadata("4.0.25")).unwrap();
        let embedded = root.path().join("Packages/com.sidequest.creator-sdk");
        fs::create_dir(&embedded).unwrap();
        fs::hard_link(&file, embedded.join("package.json")).unwrap();
        assert!(installed(root.path(), "4.0.25").is_err());
        fs::remove_file(embedded.join("package.json")).unwrap();
        write(
            root.path(),
            "Packages/com.sidequest.creator-sdk/package.json",
            &vec![b' '; MAX_METADATA_BYTES + 1],
        );
        assert!(installed(root.path(), "4.0.25").is_err());
        assert!(installed(&root.path().join(".."), "4.0.25").is_err());
        assert_eq!(fs::read(&file).unwrap(), metadata("4.0.25"));
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_package_directory_is_refused() {
        let root = project("4.0.25");
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("package.json"), metadata("4.0.25")).unwrap();
        std::os::unix::fs::symlink(
            external.path(),
            root.path().join("Packages/com.sidequest.creator-sdk"),
        )
        .unwrap();
        assert!(installed(root.path(), "4.0.25").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn junction_is_refused_even_when_metadata_leaf_is_missing() {
        let root = project("4.0.25");
        let external = tempfile::tempdir().unwrap();
        let junction = root.path().join("Library");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(external.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Cannot create isolated junction fixture"
        );
        let result = installed(root.path(), "4.0.25");
        fs::remove_dir(&junction).unwrap();
        assert!(result.unwrap_err().contains("Linked"));
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
    }
    #[test]
    fn malformed_selection_is_unknown_and_no_selection_does_not_adopt_cache() {
        let root = project("4.0.25");
        write(
            root.path(),
            "Library/PackageCache/com.sidequest.creator-sdk@4.0.25/package.json",
            &metadata("4.0.25"),
        );
        write(root.path(), "Packages/packages-lock.json", b"not JSON");
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
        write(
            root.path(),
            "Packages/packages-lock.json",
            br#"{"dependencies":{}}"#,
        );
        write(
            root.path(),
            "Packages/manifest.json",
            br#"{"dependencies":{}}"#,
        );
        assert_eq!(installed(root.path(), "4.0.25").unwrap(), None);
        write(
            root.path(),
            "Packages/packages-lock.json",
            br#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25"}}}"#,
        );
        assert_eq!(
            installed(root.path(), "4.0.25").unwrap().unwrap().version,
            "4.0.25"
        );
    }
    #[test]
    fn serialization_is_stable_and_includes_unknown_unity() {
        let first = parse(br#"{"name":"com.sidequest.creator-sdk","version":"99.0.0","dependencies":{"com.example.z":"2.0.0","com.example.a":"1.0.0"}}"#).unwrap();
        let second = parse(br#"{"dependencies":{"com.example.a":"1.0.0","com.example.z":"2.0.0"},"version":"99.0.0","name":"com.sidequest.creator-sdk"}"#).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            r#"{"version":"99.0.0","unityVersion":null,"dependencies":{"com.example.a":"1.0.0","com.example.z":"2.0.0"}}"#
        );
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
    }
    #[test]
    fn registry_selectors_cannot_escape_official_origin() {
        assert_eq!(
            endpoint(None).unwrap().as_str(),
            format!("{REGISTRY}latest")
        );
        assert_eq!(
            endpoint(Some("99.0.0-preview.1")).unwrap().as_str(),
            format!("{REGISTRY}99.0.0-preview.1")
        );
        for bad in [
            "../latest",
            "https://evil.invalid/x",
            "//evil.invalid",
            "4.0.25?x=1",
            "4.0.25#x",
            "4.0.25%2fother",
        ] {
            assert!(endpoint(Some(bad)).is_err());
        }
    }

    #[test]
    #[ignore = "Read-only official SDK registry check; no project, settings or package writes"]
    fn live_official_metadata_read_only() {
        let current = latest().unwrap();
        let pinned = exact(&current.version).unwrap();
        assert_eq!(current, pinned);
        println!("{}", serde_json::to_string(&current).unwrap());
    }
}
