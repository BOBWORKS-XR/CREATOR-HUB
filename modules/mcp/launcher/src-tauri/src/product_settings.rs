//! Protect the existing shared launcher store; do not introduce a Hub settings copy.
use crate::{client_migration::recovery, settings_backup as storage};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const MAX_CONFIG: usize = 256 * 1024;
static LOADED: Mutex<Option<Snapshot>> = Mutex::new(None);

#[derive(Clone)]
struct Paths {
    current: PathBuf,
    legacy: PathBuf,
    journal: PathBuf,
}
impl Paths {
    fn new(base: &Path) -> Result<Self, String> {
        if !base.is_absolute()
            || base.components().any(|part| part == Component::ParentDir)
            || base.to_string_lossy().starts_with("\\\\")
            || base.to_string_lossy().starts_with("//")
            || base.to_string_lossy().chars().any(char::is_control)
        {
            return Err("Product settings require an unambiguous local config directory.".into());
        }
        storage::reject_links(base)?;
        let current = base
            .join(crate::APP_CONFIG_DIR)
            .join("launcher-config.json");
        Ok(Self {
            journal: current
                .parent()
                .unwrap()
                .join(".creator-hub-product-settings"),
            current,
            legacy: base
                .join(crate::LEGACY_APP_CONFIG_DIR)
                .join("launcher-config.json"),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    current: Option<Vec<u8>>,
    legacy: Option<Vec<u8>>,
}
fn config(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let Some(bytes) = storage::read_bytes(path)? else {
        return Ok(None);
    };
    if bytes.len() > MAX_CONFIG {
        return Err("Product settings exceed the existing 256 KiB preview limit.".into());
    }
    let config: crate::LauncherConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid product settings; originals were left unchanged.")?;
    if config.channels.len() > 256 {
        return Err("Product settings exceed the existing 256-channel preview limit.".into());
    }
    Ok(Some(bytes))
}
fn snapshot(paths: &Paths) -> Result<Snapshot, String> {
    let current = config(&paths.current)?;
    let legacy = if current.is_none() {
        config(&paths.legacy)?
    } else {
        None
    };
    Ok(Snapshot { current, legacy })
}
fn inventory(paths: &Paths) -> Result<Snapshot, String> {
    Ok(Snapshot {
        current: config(&paths.current)?,
        legacy: config(&paths.legacy)?,
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Status {
    None,
    Current,
    LegacyOnly,
    Identical,
    Conflict,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Report {
    pub status: Status,
    pub current_path: PathBuf,
    pub legacy_path: PathBuf,
    pub evidence_path: PathBuf,
    pub backups: Vec<PathBuf>,
    pub recovery: Vec<recovery::Report>,
}

fn backup_path(path: &Path, bytes: &[u8]) -> PathBuf {
    path.parent()
        .unwrap()
        .join(".creator-hub-settings-backups")
        .join(format!(
            "{}.{:x}.bak",
            path.file_name().unwrap().to_string_lossy(),
            Sha256::digest(bytes)
        ))
}
fn transactions(paths: &Paths) -> Result<Vec<recovery::Transaction>, String> {
    storage::reject_links(&paths.journal)?;
    let entries = match fs::read_dir(&paths.journal) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot inspect product settings recovery evidence.".into()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|_| "Cannot inspect product settings receipt.")?
            .path();
        if path.file_name().is_some_and(|name| name == "hub.lock") {
            continue;
        }
        if result.len() >= 32 {
            return Err("Too many product settings journals; inspect manually.".into());
        }
        // A journal cannot select its own destination: the current store path is independently derived.
        result.push(recovery::Transaction::open(
            &path,
            std::slice::from_ref(&paths.current),
        )?);
    }
    Ok(result)
}
fn inspect_paths(paths: &Paths) -> Result<Report, String> {
    let saved = inventory(paths)?;
    let status = match (&saved.current, &saved.legacy) {
        (None, None) => Status::None,
        (Some(_), None) => Status::Current,
        (None, Some(_)) => Status::LegacyOnly,
        (Some(a), Some(b)) if a == b => Status::Identical,
        (Some(_), Some(_)) => Status::Conflict,
    };
    let mut backups = Vec::new();
    for (path, bytes) in [
        (&paths.current, &saved.current),
        (&paths.legacy, &saved.legacy),
    ] {
        if let Some(bytes) = bytes {
            let backup = backup_path(path, bytes);
            if let Some(retained) = storage::read_bytes(&backup)? {
                if retained != *bytes {
                    return Err("A product settings backup differs; inspect manually.".into());
                }
                backups.push(backup);
            }
        }
    }
    let recovery = transactions(paths)?
        .into_iter()
        .map(|transaction| transaction.inspect())
        .collect::<Result<_, _>>()?;
    Ok(Report {
        status,
        current_path: paths.current.clone(),
        legacy_path: paths.legacy.clone(),
        evidence_path: paths.journal.clone(),
        backups,
        recovery,
    })
}
pub(super) fn inspect(base: &Path) -> Result<Report, String> {
    inspect_paths(&Paths::new(base)?)
}

// Only the owned form's load_config handler may renew this UI before-image.
// Background inspection/discovery/onboarding continues using read-only readers.
pub(super) fn load_form(app: &tauri::AppHandle) -> Result<crate::LauncherConfig, String> {
    if option_env!("CREATOR_HUB_INTERNAL_MODULE") != Some("1") {
        return crate::load_config(app.clone());
    }
    let paths =
        Paths::new(&dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?)?;
    let mut loaded = LOADED
        .lock()
        .map_err(|_| "Cannot reserve the loaded settings snapshot.")?;
    let saved = snapshot(&paths)?;
    let config = loaded_config(&saved, || crate::default_mcp_server_path(app))?;
    *loaded = Some(saved);
    Ok(config)
}

fn loaded_config(
    saved: &Snapshot,
    default_server: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<crate::LauncherConfig, String> {
    match saved.current.as_ref().or(saved.legacy.as_ref()) {
        Some(bytes) => {
            serde_json::from_slice(bytes).map_err(|_| "Invalid product settings.".into())
        }
        None => Ok(crate::default_launcher_config(default_server()?)),
    }
}

/// A single backend mutation's exact read snapshot; it never renews the UI form snapshot.
pub(crate) struct Operation {
    paths: Paths,
    before: Snapshot,
}

fn load_operation_at(
    paths: Paths,
    default_server: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<(crate::LauncherConfig, Operation), String> {
    let before = snapshot(&paths)?;
    let config = loaded_config(&before, default_server)?;
    Ok((config, Operation { paths, before }))
}

pub(crate) fn load_operation(
    app: &tauri::AppHandle,
) -> Result<(crate::LauncherConfig, Option<Operation>), String> {
    if option_env!("CREATOR_HUB_INTERNAL_MODULE") != Some("1") {
        return Ok((crate::load_config(app.clone())?, None));
    }
    let paths =
        Paths::new(&dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?)?;
    let (config, operation) = load_operation_at(paths, || crate::default_mcp_server_path(app))?;
    Ok((config, Some(operation)))
}

fn encoded_config(mut config: crate::LauncherConfig) -> Result<Vec<u8>, String> {
    if config.channels.len() > 256 {
        return Err(
            "Saved settings would exceed the existing channel limit. Nothing was saved.".into(),
        );
    }
    config.mcp_server_path = crate::validate_mcp_server_path(&config.mcp_server_path)?
        .to_string_lossy()
        .into_owned();
    config.tool_groups = crate::normalize_tool_groups(&config.tool_groups)?;
    serde_json::to_vec_pretty(&config).map_err(|_| "Cannot serialize product settings.".into())
}

fn require_writable() -> Result<(), String> {
    if cfg!(windows) || cfg!(all(unix, feature = "experimental-unix-hosting")) {
        Ok(())
    } else {
        Err("Production Unix writable settings remain disabled.".into())
    }
}

pub(crate) fn save_operation(
    config: crate::LauncherConfig,
    operation: Option<Operation>,
) -> Result<(), String> {
    if option_env!("CREATOR_HUB_INTERNAL_MODULE") != Some("1") {
        return crate::save_config(config);
    }
    require_writable()?;
    let operation = operation.ok_or("The backend mutation has no captured settings snapshot.")?;
    commit_operation(config, operation)
}

fn commit_operation(config: crate::LauncherConfig, operation: Operation) -> Result<(), String> {
    let after = encoded_config(config)?;
    save_snapshot(&operation.paths, &operation.before, &after).map(|_| ())
}

/// Existing schema/ownership approval belongs to the caller. This binds publication
/// to the exact parsed document, without renewing LOADED or selecting a new store.
pub(crate) fn commit_document(
    label: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
) -> Result<(), String> {
    if option_env!("CREATOR_HUB_INTERNAL_MODULE") != Some("1") {
        return crate::atomic_write(path, after);
    }
    require_writable()?;
    commit_document_at(label, path, before, after.as_bytes())
}

fn commit_document_at(
    label: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &[u8],
) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err("Settings publication requires an absolute, unambiguous path.".into());
    }
    if after.len() as u64 > storage::MAX_BYTES {
        return Err("Settings publication exceeds 2 MiB. Nothing was saved.".into());
    }
    if storage::read_bytes(path)?.as_deref() != before {
        return Err("Settings changed after they were read. Nothing was overwritten.".into());
    }
    if before == Some(after) {
        return Ok(());
    }
    let parent = path.parent().ok_or("Settings have no parent folder.")?;
    if let Some(before) = before {
        let transaction = recovery::Transaction::prepare(
            &parent.join(".creator-hub-product-settings"),
            vec![recovery::ReviewedWrite::new(label, path, before, after)],
        )?;
        let report = transaction.resume(|_| true)?;
        if !report.completed {
            return Err(format!(
                "Settings save needs recovery review at {}. No automatic rollback was attempted.",
                report.journal.display()
            ));
        }
    } else {
        storage::reject_links(parent)?;
        fs::create_dir_all(parent).map_err(|_| "Cannot create the existing settings folder.")?;
        let temporary = parent.join(format!(
            ".creator-hub-settings-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let staged = storage::StagedFile::write(&temporary, |file| {
            file.write_all(after)?;
            file.sync_all()
        })
        .map_err(|_| "Cannot stage new settings; originals were kept.")?;
        staged.publish(|source| storage::durable_move(source, path))
            .map_err(|_| "New settings publication was not confirmed. Recheck the target; an appeared file was not replaced.")?;
    }
    if storage::read_bytes(path)?.as_deref() != Some(after) {
        return Err(
            "Settings changed after publication. Inspect the retained evidence before retrying."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn commit_document_fixture(
    label: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
) -> Result<(), String> {
    commit_document_at(label, path, before, after.as_bytes())
}

fn save_snapshot(paths: &Paths, loaded: &Snapshot, after: &[u8]) -> Result<Snapshot, String> {
    if after.len() > MAX_CONFIG {
        return Err(
            "Saved settings would exceed the existing preview limit. Nothing was saved.".into(),
        );
    }
    if snapshot(paths)? != *loaded {
        return Err("MCP product settings changed since this view loaded. Reload before saving; no settings were overwritten.".into());
    }
    if loaded.current.as_deref() == Some(after) {
        return Ok(loaded.clone());
    }
    let _source: Option<File> = if loaded.current.is_none() {
        // A first explicit save retains the selected legacy before-image, but performs no import
        // on opening the view. Hold its Windows source handle until publication finishes.
        if let Some(before) = &loaded.legacy {
            storage::reject_links(&paths.legacy)?;
            let mut source = storage::protected_options()
                .open(&paths.legacy)
                .map_err(|_| "Cannot reserve legacy settings. Nothing was saved.")?;
            if storage::read(&mut source)? != *before {
                return Err("Legacy settings changed. Reload before saving.".into());
            }
            storage::retain_image(&paths.legacy, before)?;
            Some(source)
        } else {
            None
        }
    } else {
        None
    };
    // The caller is admitted through native writable consent and its owned UI workflow.
    commit_document_at(
        "MCP launcher settings",
        &paths.current,
        loaded.current.as_deref(),
        after,
    )?;
    let fresh = snapshot(paths)?;
    if fresh.current.as_deref() != Some(after) {
        return Err("Saved settings changed after publication. Recheck the current file and retained evidence.".into());
    }
    Ok(fresh)
}
pub(super) fn save(config: crate::LauncherConfig) -> Result<(), String> {
    if option_env!("CREATOR_HUB_INTERNAL_MODULE") != Some("1") {
        return crate::save_config(config);
    }
    require_writable()?;
    let after = encoded_config(config)?;
    let paths =
        Paths::new(&dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?)?;
    let mut loaded = LOADED
        .lock()
        .map_err(|_| "Cannot reserve the loaded settings snapshot.")?;
    let before = loaded
        .as_ref()
        .ok_or("Load MCP settings before saving; no unreviewed overwrite is allowed.")?;
    *loaded = Some(save_snapshot(&paths, before, &after)?);
    Ok(())
}

pub(super) fn native_review(app: &tauri::AppHandle, base: &Path) -> Result<Report, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !crate::settings_review_admission::enabled() {
        return Err(
            "Product settings review requires an admitted writable built-in Hub build.".into(),
        );
    }
    let paths = Paths::new(base)?;
    let mut reviewed_recovery = false;
    for transaction in transactions(&paths)? {
        let report = transaction.inspect()?;
        if report.historical_completed {
            continue;
        }
        reviewed_recovery = true;
        transaction.resume(|report| {
            app.dialog().message(format!("Review the interrupted MCP settings save at {}?\n\nOnly an unchanged reviewed before-image can be resumed. Conflicting, unknown or changed outcomes are not rolled back or overwritten. Exact before/after images remain local. No AI client, Unity project, sign-in or installation is changed.", report.journal.display()))
                .title("Review MCP settings recovery").kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Review and resume".into(), "Keep unchanged".into())).blocking_show()
        })?;
    }
    if reviewed_recovery {
        return inspect_paths(&paths);
    }
    let saved = inventory(&paths)?;
    if saved.current.is_none() && saved.legacy.is_none() {
        return inspect_paths(&paths);
    }
    let approved = app.dialog().message(format!("Keep exact local backups of these MCP settings?\n\nCurrent: {}\nLegacy (kept): {}\n\nCurrent settings remain preferred; legacy-only settings remain in their existing location. Different files are not merged, copied to a new Hub store or overwritten. Unknown fields, projects, terms and installed apps are unchanged.", paths.current.display(), paths.legacy.display()))
        .title("Preserve MCP product settings").kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Keep backups".into(), "Keep unchanged".into())).blocking_show();
    if approved {
        preserve(&paths, &saved)?;
    }
    inspect_paths(&paths)
}
fn preserve(paths: &Paths, reviewed: &Snapshot) -> Result<(), String> {
    let mut held = Vec::new();
    for (path, before) in [
        (&paths.current, &reviewed.current),
        (&paths.legacy, &reviewed.legacy),
    ] {
        if let Some(before) = before {
            storage::reject_links(path)?;
            let mut file = storage::protected_options()
                .open(path)
                .map_err(|_| "Cannot reserve product settings for backup.")?;
            if storage::read(&mut file)? != *before {
                return Err(
                    "Product settings changed during review. Nothing was overwritten.".into(),
                );
            }
            held.push(file);
        }
    }
    if inventory(paths)? != *reviewed {
        return Err("Product settings changed during review. Nothing was overwritten.".into());
    }
    for (path, before) in [
        (&paths.current, &reviewed.current),
        (&paths.legacy, &reviewed.legacy),
    ] {
        if let Some(before) = before {
            storage::retain_image(path, before)?;
        }
    }
    drop(held);
    Ok(())
}

#[cfg(test)]
#[path = "product_settings_tests.rs"]
mod tests;
