//! Offline signed AppDir verification and explicit private-store transactions.
//! No launcher, network, service registration, settings migration or execution.
mod archive;
mod filesystem;
mod store;

pub use store::{Activation, Recovery, RecoveryState, Selection, SelectionSnapshot, Store};

use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

const KEY: &str = include_str!("../../../src-tauri/src/catalog-key.pub");
pub const ENTRYPOINT: &str = "usr/bin/creator-hub";
pub const MAX_MANIFEST: usize = 2 * 1024 * 1024;
pub const MAX_SIGNATURE: usize = 4096;
pub const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
pub const MAX_FILE: u64 = 256 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 512 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Refused,
    Cancelled,
    RecoveryRequired,
    OutcomeUnknown,
}

#[derive(Debug)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: &'static str,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn refused(message: &'static str) -> Error {
    Error {
        kind: ErrorKind::Refused,
        message,
    }
}
pub(crate) fn require(value: bool, message: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(refused(message))
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug)]
pub struct Expected {
    version: String,
}

impl Expected {
    /// The public profile has no OS/architecture or key override.
    pub fn linux_x86_64(version: &str) -> Result<Self> {
        require(version.len() <= 64, "Expected version exceeds bound")?;
        let parsed =
            semver::Version::parse(version).map_err(|_| refused("Invalid expected version"))?;
        require(
            parsed.to_string() == version && parsed.pre.is_empty() && parsed.build.is_empty(),
            "Canonical stable version required",
        )?;
        Ok(Self {
            version: version.into(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub app_id: String,
    pub platform: String,
    pub architecture: String,
    pub version: String,
    pub source_commit: String,
    pub source_tree: String,
    pub format: String,
    pub entrypoint: String,
    pub archive: ArchiveBinding,
    #[serde(deserialize_with = "unique_entries")]
    pub entries: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveBinding {
    pub size: u64,
    pub sha256: String,
    pub unpacked_size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Entry {
    File {
        size: u64,
        sha256: String,
        mode: u32,
    },
    Directory {
        mode: u32,
    },
}

/// Construction is private: callers cannot turn supplied hashes into authority.
pub struct VerifiedPackage {
    manifest: Manifest,
    bytes: Vec<u8>,
    signature: Vec<u8>,
    contents: BTreeMap<String, Vec<u8>>,
}

impl VerifiedPackage {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn generation(&self) -> String {
        digest(&self.bytes)
    }
}

pub fn verify(
    manifest: &[u8],
    signature: &[u8],
    archive: &Path,
    expected: &Expected,
) -> Result<VerifiedPackage> {
    let parsed = signed_manifest(manifest, signature, expected, &production_verify)?;
    let raw = filesystem::read_regular(archive, MAX_ARCHIVE, false)?;
    let contents = archive::decode(&raw, &parsed)?;
    Ok(VerifiedPackage {
        manifest: parsed,
        bytes: manifest.into(),
        signature: signature.into(),
        contents,
    })
}

fn production_verify(bytes: &[u8], signature: &[u8]) -> Result<()> {
    let key = PublicKey::decode(KEY).map_err(|_| refused("Invalid compiled catalogue key"))?;
    let text =
        std::str::from_utf8(signature).map_err(|_| refused("Plain Minisign signature required"))?;
    let signature = Signature::decode(text).map_err(|_| refused("Malformed Minisign signature"))?;
    key.verify(bytes, &signature, false)
        .map_err(|_| refused("Catalogue signature verification failed"))
}

type Verifier = dyn Fn(&[u8], &[u8]) -> Result<()>;

fn unique_entries<'de, D: serde::Deserializer<'de>>(
    de: D,
) -> std::result::Result<BTreeMap<String, Entry>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, Entry>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("unique bounded AppDir paths")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, Entry>()? {
                if result.len() >= MAX_ENTRIES || result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom(
                        "duplicate or oversized AppDir inventory",
                    ));
                }
            }
            Ok(result)
        }
    }
    de.deserialize_map(Unique)
}

fn signed_manifest(
    bytes: &[u8],
    signature: &[u8],
    expected: &Expected,
    verify: &Verifier,
) -> Result<Manifest> {
    require(
        !bytes.is_empty()
            && bytes.len() <= MAX_MANIFEST
            && !signature.is_empty()
            && signature.len() <= MAX_SIGNATURE,
        "Bounded manifest/signature required",
    )?;
    verify(bytes, signature)?;
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| refused("Malformed or ambiguous manifest"))?;
    manifest.validate(expected)?;
    Ok(manifest)
}

impl Manifest {
    fn validate(&self, expected: &Expected) -> Result<()> {
        require(
            self.schema_version == 1
                && self.app_id == "creator-hub"
                && self.platform == "linux"
                && self.architecture == "x86_64"
                && self.version == expected.version
                && self.format == "appdir-tar-gzip-v1"
                && self.entrypoint == ENTRYPOINT
                && hex(&self.source_commit, 40)
                && hex(&self.source_tree, 40),
            "Exact signed Linux/x86_64/version/profile required",
        )?;
        require(
            self.archive.size > 0
                && self.archive.size <= MAX_ARCHIVE
                && hex(&self.archive.sha256, 64)
                && self.archive.unpacked_size <= MAX_TOTAL
                && !self.entries.is_empty()
                && self.entries.len() <= MAX_ENTRIES,
            "Archive/manifest bounds exceeded",
        )?;
        let mut total = 0u64;
        let mut folded = std::collections::BTreeSet::new();
        for (name, entry) in &self.entries {
            require(
                archive::relative(name) && folded.insert(name.to_ascii_lowercase()),
                "Noncanonical or ambiguous AppDir path",
            )?;
            if let Some((parent, _)) = name.rsplit_once('/') {
                require(
                    matches!(self.entries.get(parent), Some(Entry::Directory { .. })),
                    "Every parent directory must be listed",
                )?;
            }
            match entry {
                Entry::Directory { mode } => {
                    require(*mode == 0o755, "Only ordinary directory modes accepted")?
                }
                Entry::File { size, sha256, mode } => {
                    require(
                        *size <= MAX_FILE && hex(sha256, 64) && matches!(mode, 0o644 | 0o755),
                        "Invalid AppDir file binding",
                    )?;
                    total = total
                        .checked_add(*size)
                        .ok_or_else(|| refused("AppDir size overflow"))?;
                }
            }
        }
        require(
            total == self.archive.unpacked_size && total <= MAX_TOTAL,
            "Exact unpacked size required",
        )?;
        require(
            matches!(
                self.entries.get(ENTRYPOINT),
                Some(Entry::File {
                    mode: 0o755,
                    size: 20..,
                    ..
                })
            ),
            "Fixed executable entrypoint required",
        )
    }
}
