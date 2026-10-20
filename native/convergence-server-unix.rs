//! Native-only previous-server byte binding for Unix product-settings review.
//! No discovery, config/env reads, writes, backup creation, consent or retirement.
//! A path/name or a digest calculated from a user-selected file is NOT provenance.
//! The caller must independently derive the exact installed/cache path and pin
//! its bytes/hash from verified previous Mac/Linux release payload evidence.
//! This module authenticates neither a release nor that caller assertion.
//!
//! Parent integration: include this file under a module with the existing
//! settings_backup adapter aliased as `storage`, capture a native pin, then pass
//! `|path| previous.recognizes(path)` to product_settings::server_writes both
//! before and after native approval. Keep the settings Snapshot/Backup rechecks
//! and existing recovery transaction. No serialized/renderer input is admitted.

use super::storage;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// Borrowed native evidence, not an input/consent or a discovery result.
/// Must not be assembled from config/env/frontend paths or their current hashes.
pub struct NativeServerPin<'a> {
    pub path: &'a Path,
    pub bytes: usize,
    pub sha256: &'a str,
}

/// Immutable private binding; deliberately no Debug/Serialize/Deserialize.
pub struct PreviousServerSnapshot {
    path: PathBuf,
    bytes: usize,
    sha256: String,
}

fn local_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_str().ok_or("Ambiguous previous MCP server path.")?;
    if !path.is_absolute()
        || text.len() > 8192
        || text.starts_with("//")
        || text.starts_with("\\\\")
        || text.chars().any(char::is_control)
        || path.components().any(|part| part == Component::ParentDir)
        || ["${", "{env:", "{file:", "%"]
            .iter()
            .any(|marker| text.contains(marker))
    {
        return Err("Ambiguous previous MCP server path.".into());
    }
    Ok(path.components().collect())
}

fn known_server_leaf(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("creator-works-mcp.mjs" | "banter-mcp.mjs")
    ) || (path.file_name().is_some_and(|name| name == "index.js")
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "dist"))
}

impl PreviousServerSnapshot {
    /// Read only the independently pinned native server, never a configured path.
    /// Known filenames narrow the read surface; they do not establish identity.
    pub fn inspect(pin: NativeServerPin<'_>) -> Result<Self, String> {
        let path = local_path(pin.path)?;
        if !known_server_leaf(&path)
            || pin.bytes == 0
            || pin.bytes as u64 > storage::MAX_BYTES
            || pin.sha256.len() != 64
            || !pin
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Unverified previous Unix MCP server pin; original kept.".into());
        }
        let snapshot = Self {
            path,
            bytes: pin.bytes,
            sha256: pin.sha256.to_owned(),
        };
        snapshot.recheck()?;
        Ok(snapshot)
    }

    /// Exact lexical binding only; custom paths/aliases are not read or adopted.
    /// A match still requires the existing native review and backup/journal gates.
    pub fn recognizes(&self, configured: &Path) -> Result<bool, String> {
        if !local_path(configured).is_ok_and(|path| path == self.path) {
            return Ok(false);
        }
        self.recheck()?;
        Ok(true)
    }

    /// Bounded read through the existing no-links adapter; no repair or mutation.
    pub fn recheck(&self) -> Result<(), String> {
        let bytes = storage::read_bytes(&self.path)?
            .ok_or("The pinned previous Unix MCP server is missing; original kept.")?;
        if bytes.len() != self.bytes || format!("{:x}", Sha256::digest(&bytes)) != self.sha256 {
            return Err("The pinned previous Unix MCP server changed; original kept.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const BODY: &[u8] = b"disposable previous release server; never executed";

    fn base(temp: &tempfile::TempDir) -> PathBuf {
        #[cfg(unix)]
        let base = temp.path().canonicalize().unwrap();
        #[cfg(windows)]
        let base = temp.path().to_path_buf();
        base
    }

    fn capture(path: &Path) -> Result<PreviousServerSnapshot, String> {
        PreviousServerSnapshot::inspect(NativeServerPin {
            path,
            bytes: BODY.len(),
            sha256: &format!("{:x}", Sha256::digest(BODY)),
        })
    }

    #[test]
    fn exact_native_pin_matches_but_identical_custom_and_missing_paths_are_not_read() {
        let temp = tempfile::tempdir().unwrap();
        let base = base(&temp);
        let official = base.join("creator-works-mcp.mjs");
        let custom = base.join("custom/creator-works-mcp.mjs");
        fs::write(&official, BODY).unwrap();
        fs::create_dir(custom.parent().unwrap()).unwrap();
        fs::write(&custom, BODY).unwrap();
        let saved = capture(&official).unwrap();
        assert!(saved.recognizes(&official).unwrap());
        for path in [
            custom.clone(),
            base.join("missing.mjs"),
            PathBuf::from("relative"),
        ] {
            assert!(!saved.recognizes(&path).unwrap());
        }
        assert_eq!(fs::read(official).unwrap(), BODY);
        assert_eq!(fs::read(custom).unwrap(), BODY);
        assert_eq!(fs::read_dir(base).unwrap().count(), 2);
    }

    #[test]
    fn only_source_established_server_leaves_can_be_pinned() {
        let temp = tempfile::tempdir().unwrap();
        let base = base(&temp);
        for leaf in ["auth.json", "settings.json", "index.js", "arbitrary.mjs"] {
            assert!(capture(&base.join(leaf)).is_err());
        }
        for leaf in ["creator-works-mcp.mjs", "banter-mcp.mjs", "dist/index.js"] {
            let path = base.join(leaf);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, BODY).unwrap();
            assert!(capture(&path).unwrap().recognizes(&path).unwrap());
        }
    }

    #[test]
    fn invalid_pin_bounds_hashes_and_traversal_refuse_before_any_read() {
        let temp = tempfile::tempdir().unwrap();
        let base = base(&temp);
        let path = base.join("creator-works-mcp.mjs");
        let hash = format!("{:x}", Sha256::digest(BODY));
        for (bytes, sha256) in [
            (0, hash.as_str()),
            (storage::MAX_BYTES as usize + 1, hash.as_str()),
            (BODY.len(), "malformed"),
        ] {
            assert!(PreviousServerSnapshot::inspect(NativeServerPin {
                path: &path,
                bytes,
                sha256
            })
            .is_err());
        }
        for path in [
            PathBuf::from("relative/creator-works-mcp.mjs"),
            base.join("../creator-works-mcp.mjs"),
            base.join("${HOME}/creator-works-mcp.mjs"),
        ] {
            assert!(capture(&path).is_err());
        }
        assert_eq!(fs::read_dir(base).unwrap().count(), 0);
    }

    #[test]
    fn changed_missing_and_nonregular_pinned_servers_refuse_without_repair() {
        let temp = tempfile::tempdir().unwrap();
        let path = base(&temp).join("creator-works-mcp.mjs");
        fs::write(&path, BODY).unwrap();
        let saved = capture(&path).unwrap();
        let mut changed = BODY.to_vec();
        changed[0] ^= 1;
        fs::write(&path, &changed).unwrap();
        assert!(saved.recheck().is_err());
        assert!(saved.recognizes(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), changed);
        fs::remove_file(&path).unwrap();
        assert!(saved.recheck().is_err());
        assert!(!path.exists());
        fs::create_dir(&path).unwrap();
        assert!(saved.recheck().is_err());
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn unix_links_refuse_even_when_their_bytes_match_the_pin() {
        let temp = tempfile::tempdir().unwrap();
        let base = base(&temp);
        let real = base.join("real/creator-works-mcp.mjs");
        fs::create_dir(real.parent().unwrap()).unwrap();
        fs::write(&real, BODY).unwrap();
        let link = base.join("creator-works-mcp.mjs");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(capture(&link).is_err());
        fs::remove_file(&link).unwrap();
        let alias = base.join("alias");
        std::os::unix::fs::symlink(real.parent().unwrap(), &alias).unwrap();
        assert!(capture(&alias.join("creator-works-mcp.mjs")).is_err());
        assert_eq!(fs::read(real).unwrap(), BODY);
    }
}
