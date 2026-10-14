//! Exact legacy Creator store inventory and retained images, not a coordinator.
//! Callers own native review/recovery and publication. No discovery, merge,
//! activation, consent import, client editing, app shutdown or uninstall occurs.
#[allow(dead_code)]
#[path = "../modules/mcp/launcher/src-tauri/src/settings_backup.rs"]
mod storage;

// Shared with the MCP product-settings recognizer once native Unix payload pins
// are established. This is not enabled migration or an uninstall authority.
#[cfg(any(unix, test))]
#[allow(dead_code)]
#[path = "convergence-server-unix.rs"]
pub mod unix_server;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    McpCurrent,
    McpLegacy,
    McpHostedOutcomes,
    SetupEditors,
}

pub const STORES: [Store; 4] = [
    Store::McpCurrent,
    Store::McpLegacy,
    Store::McpHostedOutcomes,
    Store::SetupEditors,
];

// These are the OS base directories, not a store path or a user-selected file.
pub struct Roots {
    pub config: PathBuf,
    pub local_data: PathBuf,
}

impl Store {
    pub fn path(self, roots: &Roots) -> Result<PathBuf, String> {
        let (base, leaf) = match self {
            Self::McpCurrent => (&roots.config, "creator-works-mcp/launcher-config.json"),
            Self::McpLegacy => (&roots.config, "banter-mcp/launcher-config.json"),
            Self::McpHostedOutcomes => (
                &roots.config,
                "creator-works-mcp/hosted-operation-outcomes.json",
            ),
            Self::SetupEditors => (&roots.local_data, "CreatorProjectSetup/editor-roots.json"),
        };
        let text = base.to_string_lossy();
        if !base.is_absolute()
            || base.components().any(|c| c == Component::ParentDir)
            || text.starts_with("\\\\")
            || text.starts_with("//")
            || text.chars().any(char::is_control)
        {
            return Err("Convergence requires unambiguous local OS store roots.".into());
        }
        let path = base.join(leaf);
        storage::reject_links(&path)?;
        Ok(path)
    }

    fn limit(self) -> usize {
        match self {
            Self::McpCurrent | Self::McpLegacy => 256 * 1024,
            Self::McpHostedOutcomes => 65536,
            Self::SetupEditors => 16384,
        }
    }
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct Channel {
    id: String,
    name: String,
    unity_project_path: String,
    scene_path: Option<String>,
    enabled: bool,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

// Validation mirrors LauncherConfig's required types and optional defaults.
// We retain the original bytes rather than serializing defaults or unknown fields.
#[derive(Deserialize)]
#[allow(dead_code)]
struct Launcher {
    channels: Vec<Channel>,
    active_channel_id: Option<String>,
    #[serde(default)]
    mcp_server_path: String,
    auto_start: bool,
    #[serde(default)]
    enable_custom_scripts: bool,
    #[serde(default)]
    allow_all_tests: bool,
    #[serde(default)]
    tool_groups: String,
    #[serde(default)]
    automatic_update_checks: bool,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Outcomes {
    revision: u32,
    records: Vec<OutcomeRecord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutcomeRecord {
    session: String,
    id: u64,
    command: String,
    outcome: Outcome,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Outcome {
    Accepted,
    ReturnedOk,
    ReturnedError,
    UnknownAcknowledged,
}

fn validate(store: Store, bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() > store.limit() {
        return Err("Creator store exceeds its source-defined bound; original kept.".into());
    }
    let invalid = || "Unknown or malformed Creator store; original kept.".to_owned();
    match store {
        Store::McpCurrent | Store::McpLegacy => {
            let config: Launcher = serde_json::from_slice(bytes).map_err(|_| invalid())?;
            if config.channels.len() > 256
                || [
                    "schemaVersion",
                    "schema_version",
                    "formatVersion",
                    "format_version",
                    "$schema",
                ]
                .iter()
                .any(|key| config.extra.contains_key(*key))
            {
                return Err(invalid());
            }
            Ok(false)
        }
        Store::SetupEditors => {
            let roots: Vec<PathBuf> = serde_json::from_slice(bytes).map_err(|_| invalid())?;
            if roots.iter().any(|root| !root.is_absolute()) {
                return Err(invalid());
            }
            Ok(false)
        }
        Store::McpHostedOutcomes => {
            let saved: Outcomes = serde_json::from_slice(bytes).map_err(|_| invalid())?;
            if saved.revision != 1
                || saved.records.len() > 32
                || saved.records.iter().any(|r| {
                    r.session.len() != 64
                        || !r.session.bytes().all(|c| c.is_ascii_hexdigit())
                        || r.id == 0
                        || r.id > 9_007_199_254_740_991
                        || r.command.is_empty()
                        || r.command.len() > 128
                        || !r
                            .command
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                })
            {
                return Err(invalid());
            }
            Ok(saved
                .records
                .iter()
                .any(|r| matches!(r.outcome, Outcome::Accepted | Outcome::UnknownAcknowledged)))
        }
    }
}

pub struct Snapshot {
    store: Store,
    path: PathBuf,
    bytes: Option<Vec<u8>>,
    needs_outcome_review: bool,
}

impl Snapshot {
    pub fn store(&self) -> Store {
        self.store
    }

    pub fn inspect(store: Store, roots: &Roots) -> Result<Self, String> {
        let path = store.path(roots)?;
        let bytes = storage::read_bytes(&path)?;
        let needs_outcome_review = bytes
            .as_deref()
            .map(|value| validate(store, value))
            .transpose()?
            .unwrap_or(false);
        Ok(Self {
            store,
            path,
            bytes,
            needs_outcome_review,
        })
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        self.bytes.as_deref()
    }

    pub fn needs_outcome_review(&self) -> bool {
        self.needs_outcome_review
    }

    pub fn recheck(&self) -> Result<(), String> {
        if storage::read_bytes(&self.path)? != self.bytes {
            return Err("Creator store changed after review; no import permitted.".into());
        }
        Ok(())
    }

    // Only call after native review; this API never supplies or accepts UI consent.
    pub fn retain_reviewed(&self) -> Result<Backup, String> {
        self.recheck()?;
        let bytes = self
            .bytes()
            .ok_or("Missing stores need no imported defaults.")?;
        let path = storage::retain_image(&self.path, bytes)?;
        self.recheck()?;
        let backup = Backup {
            path,
            source: self.path.clone(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        };
        backup.verify(self)?;
        Ok(backup)
    }
}

/// Opaque native before-image identity; no caller-supplied paths or hash inputs.
pub struct Backup {
    path: PathBuf,
    source: PathBuf,
    sha256: String,
}

impl Backup {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Recheck the original retained bytes independently of a renewed live
    /// Snapshot. Does not read the live source, recreate or repair any file.
    /// Callers must separately recheck their current reviewed live snapshot.
    pub fn recheck(&self) -> Result<(), String> {
        if storage::read_bytes(&self.path)?
            .is_none_or(|bytes| format!("{:x}", Sha256::digest(&bytes)) != self.sha256)
        {
            return Err("Creator before-image is missing or changed.".into());
        }
        Ok(())
    }

    fn verify(&self, snapshot: &Snapshot) -> Result<(), String> {
        if self.source != snapshot.path
            || storage::read_bytes(&self.path)?.as_deref() != snapshot.bytes()
            || snapshot
                .bytes()
                .is_none_or(|b| format!("{:x}", Sha256::digest(b)) != self.sha256)
        {
            return Err(
                "Creator before-image is missing, changed or belongs to another store.".into(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ImportValidation {
    CreateOnly,
    AlreadyIdentical,
}

// Pure publication prerequisite, not a writer. Use existing reviewed transaction
// and destination snapshot APIs for the actual import; never blind-overwrite.
pub fn validate_import(
    snapshot: &Snapshot,
    backup: &Backup,
    destination_before: Option<&[u8]>,
    proposed: &[u8],
) -> Result<ImportValidation, String> {
    snapshot.recheck()?;
    backup.verify(snapshot)?;
    if snapshot.store == Store::McpHostedOutcomes {
        return Err("Outcome journals stay in place and require existing recovery APIs.".into());
    }
    validate(snapshot.store, proposed)?;
    if snapshot.bytes() != Some(proposed) {
        return Err(
            "Import must preserve the exact reviewed store, including false/unknown flags.".into(),
        );
    }
    match destination_before {
        None => Ok(ImportValidation::CreateOnly),
        Some(existing) if existing == proposed => Ok(ImportValidation::AlreadyIdentical),
        Some(_) => Err(
            "Creator stores conflict; explicit domain review is required, not overwrite.".into(),
        ),
    }
}

#[cfg(test)]
#[path = "convergence-store-unix.test.rs"]
mod unix_store_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn roots() -> (tempfile::TempDir, Roots) {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let base = temp.path().canonicalize().unwrap();
        #[cfg(windows)]
        let base = temp.path().to_path_buf();
        let roots = Roots {
            config: base.join("config"),
            local_data: base.join("local"),
        };
        (temp, roots)
    }

    fn put(store: Store, roots: &Roots, bytes: &[u8]) -> PathBuf {
        let path = store.path(roots).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn config() -> Vec<u8> {
        br#"{"channels":[],"active_channel_id":null,"auto_start":false,"automatic_update_checks":false,"customFutureOption":{"kept":true}}"#.to_vec()
    }

    #[test]
    fn convergence_allowlist_is_only_four_source_established_creator_files() {
        let (_temp, roots) = roots();
        assert_eq!(STORES.len(), 4);
        assert_eq!(
            Store::McpLegacy.path(&roots).unwrap(),
            roots.config.join("banter-mcp/launcher-config.json")
        );
        assert_eq!(
            Store::McpHostedOutcomes.path(&roots).unwrap(),
            roots
                .config
                .join("creator-works-mcp/hosted-operation-outcomes.json")
        );
        assert_eq!(
            Store::SetupEditors.path(&roots).unwrap(),
            roots
                .local_data
                .join("CreatorProjectSetup/editor-roots.json")
        );
        assert!(!roots.config.exists());
        assert!(!roots.local_data.exists());
    }

    #[test]
    fn convergence_missing_store_remains_missing_without_imported_defaults() {
        let (_temp, roots) = roots();
        for store in STORES {
            let saved = Snapshot::inspect(store, &roots).unwrap();
            assert!(saved.bytes().is_none());
            assert!(saved.retain_reviewed().is_err());
        }
        assert!(!roots.config.exists());
        assert!(!roots.local_data.exists());
    }

    #[test]
    fn convergence_exact_backup_preserves_false_unknown_fields_and_originals() {
        let (_temp, roots) = roots();
        let body = config();
        let source = put(Store::McpLegacy, &roots, &body);
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        assert_eq!(fs::read(backup.path()).unwrap(), body);
        assert_eq!(fs::read(source).unwrap(), body);
        assert_eq!(
            validate_import(&saved, &backup, None, &body).unwrap(),
            ImportValidation::CreateOnly
        );
        assert_eq!(
            validate_import(&saved, &backup, Some(&body), &body).unwrap(),
            ImportValidation::AlreadyIdentical
        );
        assert!(!Store::McpCurrent.path(&roots).unwrap().exists());
        assert_eq!(saved.retain_reviewed().unwrap().path(), backup.path());
    }

    #[test]
    fn convergence_conflicts_and_changed_proposal_never_authorize_overwrite() {
        let (_temp, roots) = roots();
        let body = config();
        put(Store::McpLegacy, &roots, &body);
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        let other = br#"{"channels":[],"auto_start":true}"#;
        assert!(validate_import(&saved, &backup, Some(other), &body).is_err());
        assert!(validate_import(&saved, &backup, None, other).is_err());
    }

    #[test]
    fn convergence_changed_source_refuses_before_retaining_or_importing() {
        let (_temp, roots) = roots();
        let source = put(Store::McpLegacy, &roots, &config());
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        fs::write(&source, br#"{"channels":[],"auto_start":true}"#).unwrap();
        assert!(saved.retain_reviewed().is_err());
        assert!(!source
            .parent()
            .unwrap()
            .join(".creator-hub-settings-backups")
            .exists());
    }

    #[test]
    fn convergence_missing_or_changed_backup_is_not_repaired() {
        let (_temp, roots) = roots();
        let body = config();
        put(Store::McpLegacy, &roots, &body);
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        assert!(backup.recheck().is_ok());
        let changed = String::from_utf8(body.clone())
            .unwrap()
            .replace("\"kept\"", "\"lost\"")
            .into_bytes();
        assert_eq!(changed.len(), body.len());
        fs::write(backup.path(), &changed).unwrap();
        assert!(backup.recheck().is_err());
        assert!(validate_import(&saved, &backup, None, &body).is_err());
        assert!(saved.retain_reviewed().is_err());
        assert_eq!(fs::read(backup.path()).unwrap(), changed);
        fs::remove_file(backup.path()).unwrap();
        assert!(backup.recheck().is_err());
        assert!(validate_import(&saved, &backup, None, &body).is_err());
        assert!(!backup.path().exists());
    }

    #[test]
    fn convergence_backup_recheck_survives_only_reviewed_live_server_field_change() {
        let (_temp, roots) = roots();
        let mut original: serde_json::Value = serde_json::from_slice(&config()).unwrap();
        original["mcp_server_path"] = serde_json::json!(roots.local_data.join("old/server.mjs"));
        let body = serde_json::to_vec(&original).unwrap();
        let source = put(Store::McpCurrent, &roots, &body);
        let saved = Snapshot::inspect(Store::McpCurrent, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        assert!(backup.recheck().is_ok());
        assert!(backup.verify(&saved).is_ok());

        let mut transitioned = original;
        transitioned["mcp_server_path"] =
            serde_json::json!(roots.local_data.join("bundled/server.mjs"));
        let changed_live = serde_json::to_vec(&transitioned).unwrap();
        fs::write(&source, &changed_live).unwrap();
        assert!(saved.recheck().is_err());
        let renewed = Snapshot::inspect(Store::McpCurrent, &roots).unwrap();
        assert!(renewed.recheck().is_ok());
        // Snapshot-bound verification still rejects a new snapshot's bytes,
        // while the independent retained-byte check needs no live snapshot.
        assert!(backup.verify(&renewed).is_err());
        assert!(backup.verify(&saved).is_ok());
        assert!(validate_import(&saved, &backup, None, &body).is_err());
        for _ in 0..2 {
            assert!(backup.recheck().is_ok());
            assert_eq!(fs::read(backup.path()).unwrap(), body);
            assert_eq!(fs::read(&source).unwrap(), changed_live);
        }
        assert_eq!(
            fs::read_dir(backup.path().parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn convergence_backup_recheck_refuses_oversized_or_nonregular_images_without_repair() {
        let (_temp, roots) = roots();
        put(Store::McpLegacy, &roots, &config());
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        let oversized = vec![b'x'; storage::MAX_BYTES as usize + 1];
        fs::write(backup.path(), &oversized).unwrap();
        assert!(backup.recheck().is_err());
        assert_eq!(fs::read(backup.path()).unwrap(), oversized);
        fs::remove_file(backup.path()).unwrap();
        fs::create_dir(backup.path()).unwrap();
        assert!(backup.recheck().is_err());
        assert!(backup.path().is_dir());
    }

    #[test]
    fn convergence_backup_cannot_cross_store_identity() {
        let (_temp, roots) = roots();
        let body = config();
        put(Store::McpLegacy, &roots, &body);
        put(Store::McpCurrent, &roots, &body);
        let legacy = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let current = Snapshot::inspect(Store::McpCurrent, &roots).unwrap();
        let backup = legacy.retain_reviewed().unwrap();
        assert!(validate_import(&current, &backup, None, &body).is_err());
    }

    #[test]
    fn convergence_malformed_future_and_oversized_records_stay_unchanged() {
        let (_temp, roots) = roots();
        let mut future: serde_json::Value = serde_json::from_slice(&config()).unwrap();
        future["schemaVersion"] = 2.into();
        for body in [
            b"not JSON".to_vec(),
            b"{}".to_vec(),
            serde_json::to_vec(&future).unwrap(),
            vec![b' '; 256 * 1024 + 1],
        ] {
            let file = put(Store::McpCurrent, &roots, &body);
            assert!(Snapshot::inspect(Store::McpCurrent, &roots).is_err());
            assert_eq!(fs::read(&file).unwrap(), body);
            assert!(!file
                .parent()
                .unwrap()
                .join(".creator-hub-settings-backups")
                .exists());
        }
    }

    #[test]
    fn convergence_known_field_duplicates_and_wrong_types_refuse() {
        let (_temp, roots) = roots();
        for body in [
            br#"{"channels":[],"auto_start":false,"auto_start":true}"#.as_slice(),
            br#"{"channels":[],"auto_start":"false"}"#.as_slice(),
            br#"{"channels":[{}],"auto_start":false}"#.as_slice(),
        ] {
            put(Store::McpCurrent, &roots, body);
            assert!(Snapshot::inspect(Store::McpCurrent, &roots).is_err());
        }
    }

    #[test]
    fn convergence_editor_cache_is_exact_data_not_installation_authority() {
        let (_temp, roots) = roots();
        let editor = roots.local_data.join("not-installed-editor");
        let body = serde_json::to_vec(&vec![editor]).unwrap();
        put(Store::SetupEditors, &roots, &body);
        let saved = Snapshot::inspect(Store::SetupEditors, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        assert!(validate_import(&saved, &backup, None, &body).is_ok());
        for invalid in [
            br#"["relative"]"#.to_vec(),
            b"{}".to_vec(),
            vec![b' '; 16385],
        ] {
            let file = put(Store::SetupEditors, &roots, &invalid);
            assert!(Snapshot::inspect(Store::SetupEditors, &roots).is_err());
            assert_eq!(fs::read(file).unwrap(), invalid);
        }
    }

    #[test]
    fn convergence_journals_are_retained_never_replayed_or_marked_successful() {
        let (_temp, roots) = roots();
        for outcome in [
            "accepted",
            "returned-ok",
            "returned-error",
            "unknown-acknowledged",
        ] {
            let body = serde_json::to_vec(&serde_json::json!({"revision":1,"records":[{
                "session":"a".repeat(64),"id":1,"command":"save_config","outcome":outcome
            }]}))
            .unwrap();
            put(Store::McpHostedOutcomes, &roots, &body);
            let saved = Snapshot::inspect(Store::McpHostedOutcomes, &roots).unwrap();
            assert_eq!(
                saved.needs_outcome_review(),
                matches!(outcome, "accepted" | "unknown-acknowledged")
            );
            let backup = saved.retain_reviewed().unwrap();
            assert!(validate_import(&saved, &backup, None, &body).is_err());
            assert_eq!(fs::read(backup.path()).unwrap(), body);
        }
    }

    #[test]
    fn convergence_unknown_journal_schema_refuses() {
        let (_temp, roots) = roots();
        for body in [
            br#"{"revision":2,"records":[]}"#.as_slice(),
            br#"{"revision":1,"records":[],"future":true}"#.as_slice(),
        ] {
            let file = put(Store::McpHostedOutcomes, &roots, body);
            assert!(Snapshot::inspect(Store::McpHostedOutcomes, &roots).is_err());
            assert_eq!(fs::read(file).unwrap(), body);
        }
    }

    #[test]
    fn convergence_nonlocal_roots_and_parent_traversal_refuse() {
        let (_temp, mut roots) = roots();
        for base in [
            PathBuf::from("relative"),
            roots.config.join("../other"),
            PathBuf::from("\\\\foreign\\share"),
        ] {
            roots.config = base;
            assert!(Store::McpCurrent.path(&roots).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn convergence_symlinked_store_or_ancestor_refuses() {
        let (_temp, roots) = roots();
        let real = put(Store::McpCurrent, &roots, &config());
        let link = Store::McpLegacy.path(&roots).unwrap();
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(Snapshot::inspect(Store::McpLegacy, &roots).is_err());
        fs::remove_file(&link).unwrap();
        fs::remove_dir(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(real.parent().unwrap(), link.parent().unwrap()).unwrap();
        assert!(Snapshot::inspect(Store::McpLegacy, &roots).is_err());
        assert_eq!(fs::read(real).unwrap(), config());
    }

    #[cfg(windows)]
    #[test]
    fn convergence_junctioned_store_ancestor_refuses() {
        let (_temp, roots) = roots();
        let real = put(Store::McpCurrent, &roots, &config());
        let junction = roots.config.join("banter-mcp");
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(real.parent().unwrap())
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(Snapshot::inspect(Store::McpLegacy, &roots).is_err());
        fs::remove_dir(&junction).unwrap();
        assert_eq!(fs::read(real).unwrap(), config());
    }

    #[cfg(windows)]
    #[test]
    fn convergence_backup_recheck_refuses_junction_even_with_original_image_bytes() {
        let (_temp, roots) = roots();
        let body = config();
        let source = put(Store::McpLegacy, &roots, &body);
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        let junction = backup.path().parent().unwrap();
        let target = roots.config.join("linked-backup-target");
        fs::create_dir(&target).unwrap();
        let target_image = target.join(backup.path().file_name().unwrap());
        fs::write(&target_image, &body).unwrap();
        fs::remove_file(backup.path()).unwrap();
        fs::remove_dir(junction).unwrap();
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(junction)
            .arg(&target)
            .output()
            .unwrap();
        assert!(result.status.success());
        let checked = backup.recheck();
        let verified = backup.verify(&saved);
        // Remove only the disposable junction, never its target directory.
        fs::remove_dir(junction).unwrap();
        assert!(checked.unwrap_err().contains("links or junctions"));
        assert!(verified.is_err());
        assert_eq!(fs::read(target_image).unwrap(), body);
        assert_eq!(fs::read(source).unwrap(), body);
        assert!(!junction.exists());
    }

    #[cfg(unix)]
    #[test]
    fn convergence_backup_recheck_refuses_symlinked_leaf_and_ancestor() {
        let (_temp, roots) = roots();
        let body = config();
        let source = put(Store::McpLegacy, &roots, &body);
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        let target = roots.config.join("linked-backup-target");
        fs::create_dir(&target).unwrap();
        let target_image = target.join(backup.path().file_name().unwrap());
        fs::write(&target_image, &body).unwrap();
        fs::remove_file(backup.path()).unwrap();
        std::os::unix::fs::symlink(&target_image, backup.path()).unwrap();
        assert!(backup.recheck().is_err());
        assert!(backup.verify(&saved).is_err());
        fs::remove_file(backup.path()).unwrap();
        let parent = backup.path().parent().unwrap();
        fs::remove_dir(parent).unwrap();
        std::os::unix::fs::symlink(&target, parent).unwrap();
        assert!(backup.recheck().is_err());
        assert!(backup.verify(&saved).is_err());
        fs::remove_file(parent).unwrap();
        assert_eq!(fs::read(target_image).unwrap(), body);
        assert_eq!(fs::read(source).unwrap(), body);
    }
}
