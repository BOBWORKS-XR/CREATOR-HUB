//! First-launch adoption of retained Creator stores. Removal has a separate
//! native provenance/retention gate; a backup or presence label cannot pass it.
#[path = "../../native/convergence-store.rs"]
pub(crate) mod stores;

use crate::{builtin, catalog::AppId, hosted::Hosting, manager, platform};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::Manager as _;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const POLICY: u32 = 1;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyApp {
    name: String,
    path: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    streamlined: bool,
    move_available: bool,
    settings_import_available: bool,
    enabled: bool,
    required: bool,
    stage: &'static str,
    settings: Vec<&'static str>,
    legacy_apps: Vec<LegacyApp>,
    backups: Vec<PathBuf>,
    retirement_available: bool,
    message: String,
    review_key: Option<String>,
    recovery_help: Option<String>,
}

fn recovery_help(phase: Option<&str>, path: &std::path::Path) -> String {
    let step = match phase {
        Some("backup") => "In MCP, open Saved MCP settings and review the retained settings evidence. Do not delete either settings folder or restore a backup over newer settings.",
        Some("connections") => "In MCP, open Existing client connections and recovery, then Check interrupted changes. Resume only a change that Hub explicitly marks eligible.",
        Some("cleanup") => "Standalone cleanup may be partial. Keep the remaining apps and compatibility runtime files. Have support review the retained phase record and package state before removing or reinstalling an app.",
        _ => "Have support review the retained phase record before retrying migration. Do not delete or edit recovery records to bypass the check.",
    };
    format!(
        "Creator Hub {}\nLast migration phase: {}\nRetained phase record: {}\n\nChoose Not now to keep using Hub. Migration remains incomplete.\n\n{step}\n\nIf review cannot resolve the outcome, share these details with support. Keep the original records and backups; no operation has been replayed. These details contain local paths, not settings contents. Review paths before sharing.",
        env!("CARGO_PKG_VERSION"), phase.unwrap_or("unknown"), path.display()
    )
}

struct Plan {
    stores: Vec<stores::Snapshot>,
    retained_images: Vec<stores::Backup>,
    report: Report,
    retry_allowed: bool,
    settings_import_recovery: Option<SettingsImportRecovery>,
    #[cfg(windows)]
    retirement_dependencies: Option<crate::convergence_dependencies::GuiRetirementSnapshot>,
    #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
    retirement_linux: Option<crate::convergence_linux::Plan>,
}

#[derive(Clone)]
enum SettingsImportRecovery {
    Unconfirmed(PathBuf),
    Transaction(PathBuf),
}

fn mark_settings_import_recovery(plan: &mut Plan, evidence: SettingsImportRecovery) {
    let location = match &evidence {
        SettingsImportRecovery::Unconfirmed(root) => format!(
            "No settings transaction record has been confirmed. Preparation may have stopped before a record was created or left incomplete evidence. Settings recovery directory: {}",
            root.display()
        ),
        SettingsImportRecovery::Transaction(path) => {
            format!("Retained settings transaction: {}", path.display())
        }
    };
    plan.retry_allowed = false;
    plan.settings_import_recovery = Some(evidence);
    plan.report.required = true;
    plan.report.move_available = false;
    plan.report.settings_import_available = false;
    plan.report.retirement_available = false;
    // A reminder for the pre-import snapshot is not a recovery decision.
    plan.report.review_key = None;
    plan.report.message = "Saved MCP project import needs recovery review. Keep current settings and original backups; no automatic retry was started.".into();
    plan.report.recovery_help = Some(format!(
        "Saved MCP project import needs review.\n{location}\n\nIn MCP, open Saved MCP settings and review the retained settings evidence. Resume only a change explicitly marked eligible. After recovery completes, restart Hub to check the saved outcome. If no eligible record is available, have support review this directory; do not delete records or overwrite newer settings with a backup. Choose Not now to keep using Hub. No import, client migration or app removal has been retried."
    ));
}

fn preserve_settings_import_recovery(fresh: &mut Plan, prior: Option<&Plan>) -> bool {
    if let Some(prior) = prior {
        if let Some(evidence) = &prior.settings_import_recovery {
            if fresh.settings_import_recovery.is_none() {
                mark_settings_import_recovery(fresh, evidence.clone());
            }
            fresh.report.backups = prior.report.backups.clone();
        }
    }
    fresh.settings_import_recovery.is_some()
}

fn restore_settings_import_recovery(plan: &mut Plan, base: &stores::Roots) -> Result<(), String> {
    let current = stores::Store::McpCurrent.path(base)?;
    let legacy = stores::Store::McpLegacy.path(base)?;
    let root = current.parent().unwrap().join(".creator-hub-product-settings");
    let evidence = (|| -> Result<Option<SettingsImportRecovery>, String> {
        stores::storage::reject_links(&root)?;
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot inspect settings recovery.".into()),
        };
        let allowed = [current, legacy];
        let mut count = 0;
        for entry in entries {
            let path = entry.map_err(|_| "Cannot inspect settings evidence.")?.path();
            if path.file_name().is_some_and(|name| name == "hub.lock") {
                continue;
            }
            count += 1;
            if count > 32 {
                return Err("Settings recovery history exceeds its review bound.".into());
            }
            let report = crate::convergence_recovery::Transaction::open_allowlisted(&path, &allowed)?
                .inspect()?;
            if !report.completed && !report.historical_completed {
                return Ok(Some(SettingsImportRecovery::Transaction(report.journal)));
            }
        }
        Ok(None)
    })();
    match evidence {
        Ok(Some(evidence)) => mark_settings_import_recovery(plan, evidence),
        Err(_) => mark_settings_import_recovery(plan, SettingsImportRecovery::Unconfirmed(root)),
        Ok(None) => {}
    }
    Ok(())
}

#[derive(Default)]
pub struct Convergence(Mutex<Option<Plan>>);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReviewRecord {
    policy: u32,
    stores_retained: bool,
    connections_reviewed: bool,
    // This deliberately never records or authorizes standalone removal.
    standalone_removal_accepted: bool,
    #[serde(default)]
    retained_legacy_sha256: Option<String>,
}

fn record_path() -> Result<PathBuf, String> {
    Ok(manager::child_dir("convergence")?.join("review-v1.json"))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BatchRecord {
    policy: u32,
    phase: String,
    outcome: String,
    review_key: String,
    retry_blocked: bool,
}

fn batch_path() -> Result<PathBuf, String> {
    Ok(manager::child_dir("convergence")?.join("move-v1.json"))
}

fn read_batch_at(path: &std::path::Path) -> Result<Option<BatchRecord>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect the previous Move to Hub outcome.".into()),
        Ok(_) => {}
    }
    let record: BatchRecord = serde_json::from_slice(&manager::bounded_read(path, 4096)?)
        .map_err(|_| "Unknown Move to Hub record; keep retained files for review.")?;
    if record.policy != POLICY
        || !["backup", "connections", "cleanup"].contains(&record.phase.as_str())
        || !["started", "stopped", "complete"].contains(&record.outcome.as_str())
        || record.review_key.len() != 64
        || !record
            .review_key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || (record.outcome == "complete" && (record.phase != "cleanup" || record.retry_blocked))
    {
        return Err("Unknown Move to Hub record; no operation was retried.".into());
    }
    Ok(Some(record))
}

fn batch_needs_review(record: &BatchRecord) -> bool {
    record.outcome == "started" || record.retry_blocked
}

#[cfg(any(feature = "integrated-features", test))]
fn record_batch_at(path: &std::path::Path, record: &BatchRecord) -> Result<(), String> {
    // Never overwrite an unknown/newer record, including on an error path.
    read_batch_at(path)?;
    let bytes = serde_json::to_vec(record).map_err(|_| "Cannot encode migration phase.")?;
    manager::atomic_write(path, &bytes)?;
    if manager::bounded_read(path, 4096)? != bytes {
        return Err(
            "Migration phase publication could not be verified. Do not repeat the move.".into(),
        );
    }
    Ok(())
}

#[cfg(any(feature = "integrated-features", test))]
struct BatchJournal {
    path: PathBuf,
    before: Option<Vec<u8>>,
}

#[cfg(any(feature = "integrated-features", test))]
impl BatchJournal {
    fn open(path: PathBuf) -> Result<Self, String> {
        read_batch_at(&path)?;
        let before = stores::storage::read_bytes(&path)?;
        Ok(Self { path, before })
    }

    fn record(&mut self, record: &BatchRecord) -> Result<(), String> {
        if stores::storage::read_bytes(&self.path)? != self.before {
            return Err(
                "The native migration phase record changed; inspect it before continuing.".into(),
            );
        }
        record_batch_at(&self.path, record)?;
        self.before = stores::storage::read_bytes(&self.path)?;
        Ok(())
    }
}

fn read_review_at(path: &std::path::Path) -> Result<Option<ReviewRecord>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect Hub's retained migration review.".into()),
        Ok(_) => {}
    }
    let saved: ReviewRecord = serde_json::from_slice(&manager::bounded_read(path, 2048)?)
        .map_err(|_| "The migration review needs inspection; old apps were kept.")?;
    if saved.policy != POLICY
        || saved.standalone_removal_accepted
        || saved.retained_legacy_sha256.as_ref().is_some_and(|hash| {
            hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("Unknown migration review; old apps were kept.".into());
    }
    Ok(Some(saved))
}

fn reviewed_at(path: &std::path::Path) -> Result<bool, String> {
    Ok(read_review_at(path)?
        .is_some_and(|saved| saved.stores_retained && saved.connections_reviewed))
}

fn legacy_image_hash(snapshots: &[stores::Snapshot]) -> Option<String> {
    snapshots
        .iter()
        .find(|saved| saved.store() == stores::Store::McpLegacy)
        .and_then(stores::Snapshot::bytes)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

fn reviewed_snapshots_at(
    path: &std::path::Path,
    snapshots: &[stores::Snapshot],
) -> Result<bool, String> {
    Ok(read_review_at(path)?.is_some_and(|saved| {
        saved.stores_retained
            && saved.connections_reviewed
            && !snapshots.iter().any(stores::Snapshot::needs_outcome_review)
            && saved.retained_legacy_sha256 == legacy_image_hash(snapshots)
    }))
}

fn roots() -> Result<stores::Roots, String> {
    Ok(stores::Roots {
        config: dirs::config_dir().ok_or("Creator configuration directory is unavailable.")?,
        local_data: dirs::data_local_dir().ok_or("Creator local data is unavailable.")?,
    })
}

fn legacy_apps() -> Result<Vec<LegacyApp>, String> {
    let mut apps = Vec::new();
    for app in [AppId::Mcp, AppId::Setup] {
        let mut paths = platform::registered(app)?;
        paths.push(platform::default_exe(app)?);
        #[cfg(target_os = "macos")]
        {
            for base in [
                Some(PathBuf::from("/Applications")),
                dirs::home_dir().map(|home| home.join("Applications")),
            ]
            .into_iter()
            .flatten()
            {
                paths.push(
                    base.join(format!("{}.app", app.name()))
                        .join("Contents/MacOS")
                        .join(app.exe()),
                );
            }
        }
        #[cfg(target_os = "linux")]
        paths.push(PathBuf::from("/usr/bin").join(app.exe()));
        for path in paths {
            platform::reject_links(&path)?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("Cannot inspect an existing Creator app; it was kept.".into()),
                Ok(meta) if !meta.is_file() => {
                    return Err("An existing Creator app path is not a regular file.".into())
                }
                Ok(_) => {}
            }
            if !apps
                .iter()
                .any(|known: &LegacyApp| platform::same_path(&known.path, &path))
            {
                apps.push(LegacyApp {
                    name: app.name().into(),
                    path,
                });
            }
        }
    }
    Ok(apps)
}

fn label(store: stores::Store) -> &'static str {
    match store {
        stores::Store::McpCurrent => "MCP project selection and options",
        stores::Store::McpLegacy => "Earlier Banter MCP settings",
        stores::Store::McpHostedOutcomes => "MCP operation recovery evidence",
        stores::Store::SetupEditors => "Project Setup's saved Unity Editor locations",
    }
}

fn migration_relevant(snapshot: &stores::Snapshot) -> bool {
    snapshot.bytes().is_some()
        && (snapshot.store() != stores::Store::McpHostedOutcomes || snapshot.needs_outcome_review())
}

fn inspect() -> Result<Plan, String> {
    let mut snapshots = Vec::new();
    let mut settings = Vec::new();
    let base = roots()?;
    for store in stores::STORES {
        let snapshot = stores::Snapshot::inspect(store, &base)?;
        if migration_relevant(&snapshot) {
            settings.push(label(store));
        }
        snapshots.push(snapshot);
    }
    let legacy_apps = legacy_apps()?;
    // Validate even when legacy apps exist; do not short-circuit a newer policy.
    let already_reviewed = reviewed_snapshots_at(&record_path()?, &snapshots)?;
    let phase_path = batch_path()?;
    let pending_batch = read_batch_at(&phase_path)?;
    let uncertain_batch = pending_batch.as_ref().is_some_and(batch_needs_review);
    let pending_retirement = retirement_pending()?
        || pending_batch
            .as_ref()
            .is_some_and(|record| record.outcome != "complete");
    let review_key = prompt_review_key(&snapshots, &legacy_apps, pending_retirement)?;
    let already_using_hub = legacy_apps.is_empty()
        && !pending_retirement
        && snapshots[0].bytes().is_some()
        && creator_hub_mcp_router::Store::installed()
            .and_then(|store| store.resolve())
            .is_ok_and(|runtime| settings_use_verified_runtime(&snapshots, &runtime.server));
    let required = migration_required(
        legacy_apps.len(),
        settings.len(),
        already_reviewed || already_using_hub,
        pending_retirement,
    );
    let settings_import_available =
        settings_import_available(&snapshots, "review", !uncertain_batch);
    let mut plan = Plan {
        stores: snapshots,
        retained_images: Vec::new(),
        retry_allowed: !uncertain_batch,
        settings_import_recovery: None,
        #[cfg(windows)]
        retirement_dependencies: None,
        #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
        retirement_linux: None,
        report: Report {
            streamlined: cfg!(feature = "integrated-features"),
            move_available: !uncertain_batch,
            settings_import_available,
            enabled: true,
            required,
            stage: "review",
            settings,
            legacy_apps,
            backups: vec![],
            retirement_available: false,
            review_key: Some(review_key),
            recovery_help: uncertain_batch.then(|| recovery_help(
                pending_batch.as_ref().map(|record| record.phase.as_str()),
                &phase_path,
            )),
            message: if uncertain_batch {
                "An earlier Move to Hub operation has an uncertain or partial outcome. Settings, backups and recovery records were kept. Review the native phase record before repeating any operation."
            } else if pending_batch.as_ref().is_some_and(|record| record.outcome != "complete") {
                "An earlier Move to Hub stopped before completion. Retained state can be inspected before a fresh native review. No transaction is replayed."
            } else if pending_retirement {
                "An earlier standalone-app cleanup was interrupted. Review fresh backups and connections before resuming; no saved operation is replayed."
            } else if already_using_hub {
                "Your MCP settings already use Hub's verified runtime. No standalone apps were found."
            } else {
                "Hub can take over your existing settings without moving your Unity projects. Old apps stay installed until connection and retirement checks pass."
            }.into(),
        },
    };
    restore_settings_import_recovery(&mut plan, &base)?;
    Ok(plan)
}

fn prompt_review_key(
    snapshots: &[stores::Snapshot],
    apps: &[LegacyApp],
    pending: bool,
) -> Result<String, String> {
    // A reminder preference is not migration approval. Completed operation
    // history does not invalidate it, but new uncertain outcomes must do so.
    let images: Vec<_> = snapshots
        .iter()
        .map(|saved| {
            let relevant =
                saved.store() != stores::Store::McpHostedOutcomes || saved.needs_outcome_review();
            (
                label(saved.store()),
                relevant
                    .then(|| {
                        saved
                            .bytes()
                            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                    })
                    .flatten(),
            )
        })
        .collect();
    let bytes = serde_json::to_vec(&(POLICY, pending, images, apps))
        .map_err(|_| "Cannot identify the migration reminder; existing data were kept.")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn settings_need_review(snapshots: &[stores::Snapshot]) -> bool {
    let current = snapshots
        .iter()
        .find(|saved| saved.store() == stores::Store::McpCurrent)
        .and_then(stores::Snapshot::bytes);
    snapshots.iter().any(stores::Snapshot::needs_outcome_review)
        || snapshots
            .iter()
            .find(|saved| saved.store() == stores::Store::McpLegacy)
            .and_then(stores::Snapshot::bytes)
            .is_some_and(|legacy| current.is_some_and(|current| legacy != current))
}

fn settings_import_available(
    snapshots: &[stores::Snapshot],
    stage: &str,
    retry_allowed: bool,
) -> bool {
    // Settings-only review does not grant route migration or app retirement.
    stage == "review"
        && retry_allowed
        && !snapshots.iter().any(stores::Snapshot::needs_outcome_review)
        && settings_need_review(snapshots)
}

fn settings_use_verified_runtime(
    snapshots: &[stores::Snapshot],
    verified_server: &std::path::Path,
) -> bool {
    let Some(current) = snapshots
        .iter()
        .find(|saved| saved.store() == stores::Store::McpCurrent)
        .and_then(stores::Snapshot::bytes)
    else {
        return false;
    };
    if settings_need_review(snapshots) {
        return false;
    }
    // Compare only with the independently verified native runtime path. A saved
    // path cannot select a file to inspect or authorize standalone retirement.
    serde_json::from_slice::<Value>(current)
        .ok()
        .and_then(|value| value["mcp_server_path"].as_str().map(PathBuf::from))
        .is_some_and(|configured| configured.is_absolute() && configured == verified_server)
}

fn migration_required(apps: usize, settings: usize, reviewed: bool, pending: bool) -> bool {
    pending || apps != 0 || (settings != 0 && !reviewed)
}

fn retirement_pending() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let mut pending = false;
        for app in [AppId::Mcp, AppId::Setup] {
            pending |= crate::legacy_retirement_windows::journal_status(app)? == Some(false);
        }
        Ok(pending)
    }
    #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
    {
        crate::convergence_linux::pending()
    }
    #[cfg(not(any(
        windows,
        all(target_os = "linux", feature = "experimental-linux-migration")
    )))]
    Ok(false)
}

#[cfg(windows)]
fn retirement_plans(
    plan: &Plan,
) -> Result<Vec<crate::legacy_retirement_windows::RetirementPlan>, String> {
    let mut result = Vec::new();
    let mut matched = 0;
    for app in [AppId::Mcp, AppId::Setup] {
        let exe = platform::default_exe(app)?;
        let found = plan
            .report
            .legacy_apps
            .iter()
            .filter(|old| old.name == app.name() && platform::same_path(&old.path, &exe))
            .count();
        if found > 1 {
            return Err("Ambiguous old app locations; no app was retired.".into());
        }
        matched += found;
        let journal = crate::legacy_retirement_windows::journal_status(app)?;
        if found != 0 || journal == Some(false) {
            result.push(crate::legacy_retirement_windows::RetirementPlan::inspect(
                app,
            )?);
        }
    }
    if matched != plan.report.legacy_apps.len() {
        return Err("Custom or unverified app locations were kept. Review them before retiring standalone apps.".into());
    }
    Ok(result)
}

fn close_reviewed_guis(plan: &Plan) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Inspection binds exact accepted GUI bytes/registration before any close.
        for app in retirement_plans(plan)? {
            let exe = platform::default_exe(app.app())?;
            let state = platform::running_gui(app.app(), &exe)?;
            if state.other_copy {
                return Err("Another standalone app copy is open. Close it and choose Check again; no copy was force-closed.".into());
            }
            if state.gui.is_empty() {
                continue;
            }
            platform::window_action(&state.gui, &exe, true)?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let state = platform::running_gui(app.app(), &exe)?;
                if state.other_copy {
                    return Err("An app copy appeared while closing; review again.".into());
                }
                if state.gui.is_empty() {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("The old app has not closed normally. Save your work, close it, then choose Check again. No process was killed.".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        recheck(plan).map_err(|_| "The app saved changed settings while closing. They were kept; choose Check again to review their latest contents.".into())
    }
    #[cfg(target_os = "linux")]
    {
        // Published Unix GUIs do not expose the verified idle-close protocol.
        // Detect them by their kernel image; never substitute a signal for close.
        for app in [AppId::Mcp, AppId::Setup] {
            let state = platform::running_gui(app, &platform::default_exe(app)?)?;
            if !state.gui.is_empty() || state.other_copy {
                return Err(format!("Close the standalone {} window, then choose Check again. Its settings and all Node/AI connections were kept; Hub did not force-close any process.", app.name()));
            }
        }
        recheck(plan)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = plan;
        Ok(())
    }
}

fn require_builtin() -> Result<(), String> {
    if !builtin::enabled() {
        return Err("Convergence is only available in a verified built-in Hub.".into());
    }
    require_mcp_migration_mode(crate::hosted::preview_mode(AppId::Mcp))?;
    if !crate::usage_terms::usage_terms_status()? {
        return Err("Review Hub's terms before migrating existing apps.".into());
    }
    Ok(())
}

fn require_mcp_migration_mode(hosted_mode: Option<&str>) -> Result<(), String> {
    // The internal service owns write admission; the legacy flag only gates hosted apps.
    let integrated_service = cfg!(all(
        feature = "integrated-features",
        any(windows, target_os = "linux")
    ));
    if !integrated_service && hosted_mode != Some("writable") {
        return Err(
            "This Hub cannot take over writable MCP settings yet. Old apps were kept.".into(),
        );
    }
    Ok(())
}

fn recheck(plan: &Plan) -> Result<(), String> {
    for saved in &plan.stores {
        saved.recheck()?;
    }
    for backup in &plan.retained_images {
        backup.recheck()?;
    }
    Ok(())
}

fn recheck_durable_settings(plan: &Plan) -> Result<(), String> {
    // The owned MCP backend records this very workflow in its outcome journal.
    // Keep its original before-image, but do not mistake that expected write
    // for an external edit of the user's project selection/options.
    for saved in &plan.stores {
        if saved.store() != stores::Store::McpHostedOutcomes {
            saved.recheck()?;
        }
    }
    for backup in &plan.retained_images {
        backup.recheck()?;
    }
    Ok(())
}

fn can_prepare(plan: &Plan) -> Result<(), String> {
    if !plan.retry_allowed {
        return Err("The previous migration did not finish its operation and completion checks. Keep original apps and review recovery before retrying.".into());
    }
    recheck(plan)?;
    if plan
        .stores
        .iter()
        .any(stores::Snapshot::needs_outcome_review)
    {
        return Err("An earlier MCP operation has an unresolved outcome. Review it in MCP before removing any app. Original data were kept.".into());
    }
    Ok(())
}

fn settings_conflict(plan: &Plan) -> bool {
    matches!((plan.stores[0].bytes(), plan.stores[1].bytes()), (Some(a), Some(b)) if a != b)
}

fn can_retain(plan: &Plan) -> Result<(), String> {
    can_prepare(plan)?;
    if settings_conflict(plan) {
        return Err("Current and earlier MCP settings differ. Both were kept; review which setup to use before migration.".into());
    }
    Ok(())
}

#[derive(Debug)]
struct ProjectImport {
    bytes: Vec<u8>,
    added: usize,
    already_present: usize,
    current_sha256: String,
    legacy_sha256: String,
}

fn project_key(channel: &Value) -> Result<String, String> {
    use std::path::{Component, Path};
    let text = channel["unity_project_path"]
        .as_str()
        .ok_or("A saved project has no folder.")?;
    let path = Path::new(text);
    if !path.is_absolute()
        || text.chars().any(char::is_control)
        || path.components().any(|part| part == Component::ParentDir)
    {
        return Err(
            "A saved project folder is ambiguous. Both configurations were kept for review.".into(),
        );
    }
    // Match Hub's project inventory without requiring an offline drive to exist.
    Ok(crate::projects::key(path))
}

fn merge_project_settings(current: &[u8], legacy: &[u8]) -> Result<ProjectImport, String> {
    use std::collections::HashSet;
    stores::validate(stores::Store::McpCurrent, current)?;
    stores::validate(stores::Store::McpLegacy, legacy)?;
    let mut result: Value =
        serde_json::from_slice(current).map_err(|_| "Cannot read current MCP settings.")?;
    let earlier: Value =
        serde_json::from_slice(legacy).map_err(|_| "Cannot read earlier MCP settings.")?;
    let channels = result["channels"]
        .as_array_mut()
        .ok_or("Cannot read current MCP projects.")?;
    let mut paths = HashSet::new();
    let mut ids = HashSet::new();
    for channel in channels.iter() {
        paths.insert(project_key(channel)?);
        let id = channel["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("A current project ID is missing.")?;
        if !ids.insert(id.to_owned()) {
            return Err(
                "Current project IDs are duplicated. Both configurations were kept for review."
                    .into(),
            );
        }
    }
    let mut added = 0;
    let mut already_present = 0;
    for channel in earlier["channels"]
        .as_array()
        .ok_or("Cannot read earlier MCP projects.")?
    {
        if !paths.insert(project_key(channel)?) {
            already_present += 1;
            continue;
        }
        if channels.len() >= 256 {
            return Err("Import would exceed the 256-project limit. Both originals were kept; nothing was imported.".into());
        }
        let mut imported = channel.clone();
        let id = imported["id"]
            .as_str()
            .ok_or("An earlier project ID is missing.")?
            .to_owned();
        if id.is_empty() || !ids.insert(id) {
            loop {
                let id = uuid::Uuid::new_v4().to_string();
                if ids.insert(id.clone()) {
                    imported["id"] = json!(id);
                    break;
                }
            }
        }
        channels.push(imported);
        added += 1;
    }
    // Avoid a formatting-only rewrite when every earlier project is already listed.
    let bytes = if added == 0 {
        current.to_vec()
    } else {
        serde_json::to_vec_pretty(&result).map_err(|_| "Cannot encode imported MCP projects.")?
    };
    stores::validate(stores::Store::McpCurrent, &bytes)?;
    Ok(ProjectImport {
        bytes,
        added,
        already_present,
        current_sha256: format!("{:x}", Sha256::digest(current)),
        legacy_sha256: format!("{:x}", Sha256::digest(legacy)),
    })
}

fn check_settings_recovery(base: &stores::Roots) -> Result<PathBuf, String> {
    let current = stores::Store::McpCurrent.path(base)?;
    let legacy = stores::Store::McpLegacy.path(base)?;
    let journal = current
        .parent()
        .unwrap()
        .join(".creator-hub-product-settings");
    stores::storage::reject_links(&journal)?;
    let entries = match fs::read_dir(&journal) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(journal),
        Err(_) => {
            return Err(
                "Cannot inspect MCP settings recovery; both configurations were kept.".into(),
            )
        }
    };
    let allowed = [current, legacy];
    let mut count = 0;
    for entry in entries {
        let path = entry
            .map_err(|_| "Cannot inspect MCP settings recovery.")?
            .path();
        if path.file_name().is_some_and(|name| name == "hub.lock") {
            continue;
        }
        count += 1;
        // The frozen MCP backend accepts 32 records. Reserve one record for
        // this import and one for the subsequent reviewed server transition.
        if count >= 31 {
            return Err(
                "MCP settings recovery history is full for this migration. Existing settings were not replaced; retain and review the completed history before continuing."
                    .into(),
            );
        }
        let status = crate::convergence_recovery::Transaction::open_allowlisted(&path, &allowed)?
            .inspect()?;
        if !status.completed && !status.historical_completed {
            return Err(format!("An earlier MCP settings change needs recovery review at {}. Resolve it in MCP before importing projects; both configurations were kept.", path.display()));
        }
    }
    Ok(journal)
}

fn import_missing_projects(plan: &mut Plan, base: &stores::Roots) -> Result<usize, String> {
    can_prepare(plan)?;
    if !settings_conflict(plan) {
        return Err("The settings changed. Check again before importing projects.".into());
    }
    let import = merge_project_settings(
        plan.stores[0].bytes().unwrap(),
        plan.stores[1].bytes().unwrap(),
    )?;
    import_reviewed_projects(plan, base, &import)
}

fn import_reviewed_projects(
    plan: &mut Plan,
    base: &stores::Roots,
    import: &ProjectImport,
) -> Result<usize, String> {
    use crate::convergence_recovery::{ReviewedWrite, Transaction};
    can_prepare(plan)?;
    if !settings_conflict(plan) {
        return Err("The settings changed. Check again before importing projects.".into());
    }
    for snapshot in &plan.stores {
        if snapshot.bytes().is_some()
            && !plan
                .retained_images
                .iter()
                .any(|backup| backup.verify(snapshot).is_ok())
        {
            return Err("Both original configurations must have verified backups before importing projects.".into());
        }
    }
    if format!("{:x}", Sha256::digest(plan.stores[0].bytes().unwrap())) != import.current_sha256
        || format!("{:x}", Sha256::digest(plan.stores[1].bytes().unwrap())) != import.legacy_sha256
    {
        return Err(
            "The approved project-import before-images changed. Nothing was imported.".into(),
        );
    }
    stores::validate(stores::Store::McpCurrent, &import.bytes)?;
    let mut writes = Vec::new();
    let mut reservations = Vec::new();
    for saved in &plan.stores[..2] {
        let path = saved.store().path(base)?;
        let before = saved.bytes().unwrap();
        if before != import.bytes {
            writes.push(ReviewedWrite::new(
                "MCP missing-project import",
                &path,
                before,
                &import.bytes,
            ));
        } else {
            // A byte-identical current store is not rewritten. Reserve it while
            // the other member is published; changed members use transaction guards.
            let mut file = stores::storage::protected_options()
                .open(&path)
                .map_err(|_| "Current MCP settings are busy. Nothing was imported.")?;
            if stores::storage::read(&mut file)? != before {
                return Err(
                    "MCP settings changed after review. Check again; nothing was imported.".into(),
                );
            }
            reservations.push(file);
        }
    }
    let journal = check_settings_recovery(base)?;
    let original_report = plan.report.clone();
    mark_settings_import_recovery(plan, SettingsImportRecovery::Unconfirmed(journal.clone()));
    let transaction = Transaction::prepare(&journal, writes)?;
    resume_project_import(plan, &transaction)?;
    let mut renewed = Vec::new();
    for (index, previous) in plan.stores.iter().enumerate() {
        let fresh = stores::Snapshot::inspect(previous.store(), base)?;
        if index <= 1 {
            if fresh.bytes() != Some(import.bytes.as_slice()) {
                return Err("Settings changed during import. Keep the backups and review recovery before continuing.".into());
            }
        } else {
            previous.recheck()?;
        }
        renewed.push(fresh);
    }
    for backup in &plan.retained_images {
        backup.recheck()?;
    }
    plan.stores = renewed;
    plan.retry_allowed = true;
    plan.settings_import_recovery = None;
    plan.report = original_report;
    plan.report.settings_import_available = false;
    Ok(import.added)
}

fn resume_project_import(
    plan: &mut Plan,
    transaction: &crate::convergence_recovery::Transaction,
) -> Result<(), String> {
    mark_settings_import_recovery(
        plan,
        SettingsImportRecovery::Transaction(transaction.inspect()?.journal),
    );
    recheck(plan)?;
    let outcome = transaction.resume(|_| true)?;
    if !outcome.completed {
        return Err(format!("Project import needs recovery review at {}. Both originals are backed up; no automatic retry was started.", outcome.journal.display()));
    }
    Ok(())
}

fn refresh_finished_outcome_journal(plan: &mut Plan, base: &stores::Roots) -> Result<(), String> {
    recheck_durable_settings(plan)?;
    let journal = stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, base)?;
    if journal.needs_outcome_review() {
        return Err(
            "MCP recorded an uncertain outcome; review it before retrying migration.".into(),
        );
    }
    let previous = plan
        .stores
        .iter_mut()
        .find(|saved| saved.store() == stores::Store::McpHostedOutcomes)
        .ok_or("Migration outcome inventory is incomplete.")?;
    *previous = journal;
    plan.retry_allowed = true;
    Ok(())
}

fn refresh_reviewed_server_paths(
    plan: &mut Plan,
    base: &stores::Roots,
    server: &std::path::Path,
    response: &Value,
) -> Result<(), String> {
    if response["changed"].as_bool().is_none() || response["server"].as_str() != server.to_str() {
        return Err(
            "The reviewed server transition could not be verified; old apps were kept.".into(),
        );
    }
    let mut updates = Vec::new();
    for (index, previous) in plan.stores.iter().enumerate() {
        if !matches!(
            previous.store(),
            stores::Store::McpCurrent | stores::Store::McpLegacy
        ) {
            if previous.store() != stores::Store::McpHostedOutcomes {
                previous.recheck()?;
            }
            continue;
        }
        let fresh = stores::Snapshot::inspect(previous.store(), base)?;
        if previous.bytes() == fresh.bytes() {
            continue;
        }
        let mut before: Value = serde_json::from_slice(
            previous
                .bytes()
                .ok_or("MCP settings appeared during migration; review again.")?,
        )
        .map_err(|_| "Cannot verify retained MCP settings.")?;
        let after: Value = serde_json::from_slice(
            fresh
                .bytes()
                .ok_or("MCP settings disappeared during migration.")?,
        )
        .map_err(|_| "Cannot verify reviewed MCP settings.")?;
        let object = before
            .as_object_mut()
            .ok_or("Cannot verify retained MCP settings.")?;
        object.insert("mcp_server_path".into(), json!(server));
        if response["changed"] != true || before != after {
            return Err("Other MCP settings changed during server migration; originals and old apps were kept.".into());
        }
        updates.push((index, fresh));
    }
    // Do not renew any before-image until every durable store is checked.
    for (index, fresh) in updates {
        plan.stores[index] = fresh;
    }
    Ok(())
}

fn save_review_at(path: &std::path::Path, snapshots: &[stores::Snapshot]) -> Result<(), String> {
    reviewed_at(path)?;
    for saved in snapshots {
        saved.recheck()?;
    }
    if snapshots.iter().any(stores::Snapshot::needs_outcome_review) {
        return Err(
            "An unfinished operation still needs review; existing records were kept.".into(),
        );
    }
    manager::atomic_write(
        path,
        &serde_json::to_vec(&ReviewRecord {
            policy: POLICY,
            stores_retained: true,
            connections_reviewed: true,
            standalone_removal_accepted: false,
            retained_legacy_sha256: legacy_image_hash(snapshots),
        })
        .map_err(|_| "Cannot record migration review.")?,
    )?;
    if !reviewed_snapshots_at(path, snapshots)? {
        return Err("Migration review could not be verified; old apps were kept.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn convergence_status(handle: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_builtin()?;
        let _operation = handle.state::<manager::Manager>().begin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state
            .0
            .lock()
            .map_err(|_| "Migration state is unavailable.")?;
        if saved.is_none() {
            *saved = Some(inspect()?);
        }
        Ok(saved.as_ref().unwrap().report.clone())
    })
    .await
    .map_err(|_| "Migration inspection failed; no app was removed.")?
}

#[tauri::command]
pub async fn refresh_convergence(handle: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_builtin()?;
        let _operation = handle.state::<manager::Manager>().begin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state.0.lock().map_err(|_| "Migration state is unavailable.")?;
        if saved.as_ref().is_some_and(|plan| !plan.retry_allowed) {
            return Err("The previous migration has an uncertain MCP operation outcome. Review recovery before restarting the guide.".into());
        }
        let fresh = inspect()?;
        let report = fresh.report.clone();
        *saved = Some(fresh);
        Ok(report)
    }).await.map_err(|_| "Migration refresh failed; existing data were kept.")?
}

// Read-only inspection is available even when mutation admission is blocked.
// It never clears an uncertain journal, resumes a transaction or retries cleanup.
#[tauri::command]
pub async fn inspect_convergence_outcome(handle: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_builtin()?;
        let _operation = handle.state::<manager::Manager>().begin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state.0.lock().map_err(|_| "Migration state is unavailable.")?;
        let mut fresh = inspect()?;
        let record = read_batch_at(&batch_path()?)?;
        let prior_blocked = saved.as_ref().is_some_and(|plan| !plan.retry_allowed);
        // An unrelated completed Move to Hub record cannot clear an import failure.
        let import_needs_review = preserve_settings_import_recovery(&mut fresh, saved.as_ref());
        if !import_needs_review && !inspection_can_admit(prior_blocked, record.as_ref()) {
            fresh.retry_allowed = false;
            fresh.report.settings_import_available = false;
            fresh.report.move_available = false;
            fresh.report.required = true;
            fresh.report.message = "Retained state was inspected without changing it. A partial or uncertain native outcome still needs explicit recovery review. No transaction was retried.".into();
            fresh.report.recovery_help = Some(recovery_help(record.as_ref().map(|record| record.phase.as_str()), &batch_path()?));
        }
        let report = fresh.report.clone();
        *saved = Some(fresh);
        Ok(report)
    }).await.map_err(|_| "Retained-state inspection failed. No operation was replayed.")?
}

fn inspection_can_admit(prior_blocked: bool, record: Option<&BatchRecord>) -> bool {
    match record {
        Some(record) => !batch_needs_review(record),
        None => !prior_blocked,
    }
}

fn prepare_confirmation(
    settings_only: bool,
    import: Option<&ProjectImport>,
) -> (&'static str, &'static str, String) {
    let import_message = import.map(|proposal| format!(
        "\n\nMissing projects to import: {}. Earlier entries already listed: {}. Projects are matched by folder and will not be duplicated. Current preferences, selected project and existing project entries are kept. Both original configurations are backed up first, then both active settings files receive the combined project list with current preferences. Older preferences remain in their backup.",
        proposal.added, proposal.already_present
    )).unwrap_or_default();
    if settings_only {
        (
            "Import saved MCP projects",
            "Back up and import projects",
            format!(
                "Import saved MCP projects into your current settings?{import_message}\n\nHub will ask any verified idle standalone app windows to close normally before keeping exact local backups. Busy or unverified apps are not force-closed. AI clients, Unity and Node connections stay open.\n\nOnly the reviewed MCP settings are updated. AI-client settings, Project Setup settings and installed apps are not changed. Project folders are not moved or edited. No client migration or app removal is performed. Cancel leaves the current setup unchanged."
            ),
        )
    } else {
        (
            "Move to unified Creator Hub",
            "Back up and continue",
            format!(
                "Let Creator Hub use your existing MCP and Project Setup settings?{import_message}\n\nHub will ask verified idle standalone app windows to close normally, then keep exact local backups. Busy or unverified apps are not force-closed. AI clients, Unity and Node connections stay open.\n\nSettings remain in their current locations; Unity projects are not moved or edited. Existing AI connections are reviewed separately before changing them. No standalone installation is removed by this step. Cancel leaves the current setup unchanged."
            ),
        )
    }
}

#[tauri::command]
pub async fn prepare_convergence(handle: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_builtin()?;
        let _operation = handle.state::<manager::Manager>().begin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state.0.lock().map_err(|_| "Migration state is unavailable.")?;
        let plan = saved.as_mut().ok_or("Check existing apps before migration.")?;
        if plan.report.stage != "review" {
            recheck(plan)?;
            return Ok(plan.report.clone());
        }
        can_prepare(plan)?;
        let import = if settings_conflict(plan) {
            Some(merge_project_settings(plan.stores[0].bytes().unwrap(), plan.stores[1].bytes().unwrap())?)
        } else { None };
        let settings_only = !plan.report.required && import.is_some();
        let (title, action, message) = prepare_confirmation(settings_only, import.as_ref());
        let approved = handle.dialog().message(message).title(title).kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(action.into(), "Keep existing".into())).blocking_show();
        if !approved {
            return Err("Migration was cancelled. Existing apps and settings were kept.".into());
        }
        can_prepare(plan)?;
        close_reviewed_guis(plan)?;
        can_prepare(plan)?;
        let mut backups = Vec::new();
        let mut retained_images = Vec::new();
        for snapshot in &plan.stores {
            if snapshot.bytes().is_some() {
                let backup = snapshot.retain_reviewed()?;
                if snapshot.store() != stores::Store::McpHostedOutcomes {
                    // Adoption uses the same exact store, not a second settings
                    // copy that could drift from the standalone before-image.
                    stores::validate_import(snapshot, &backup, snapshot.bytes(), snapshot.bytes().unwrap())?;
                }
                backups.push(backup.path().to_path_buf());
                retained_images.push(backup);
            }
        }
        recheck(plan)?;
        plan.report.backups = backups;
        plan.retained_images = retained_images;
        let imported = if import.is_some() { Some(import_missing_projects(plan, &roots()?)?) } else { None };
        can_retain(plan)?;
        plan.report.stage = "backed-up";
        plan.report.settings_import_available = false;
        plan.report.message = match imported {
            Some(count) if settings_only => format!("Exact backups of both configurations are verified. Imported {count} missing project(s) without duplicates; current preferences, selected project and existing project entries were kept. AI-client settings, Project Setup settings and installed apps were not changed."),
            Some(count) => format!("Exact backups of both configurations are verified. Imported {count} missing project(s) without duplicates; current preferences and existing project entries were kept. Next, review existing AI connections. Old apps have not been removed."),
            None => "Exact settings backups are verified. Next, review existing AI connections. Old apps have not been removed.".into(),
        };
        Ok(plan.report.clone())
    }).await.map_err(|_| "Backup outcome is unknown. Retained files were kept; no app was removed.")?
}

const CLIENTS: [&str; 5] = [
    "codex",
    "claude",
    "claudeDesktop",
    "antigravity",
    "opencode",
];

fn supported_clients(status: &Value) -> Result<Vec<String>, String> {
    let clients = status["clients"]
        .as_array()
        .ok_or("Cannot verify existing AI-client inventory.")?;
    if clients.len() != CLIENTS.len() {
        return Err("Incomplete AI-client inventory; old apps were kept.".into());
    }
    let mut selected = Vec::new();
    for id in CLIENTS {
        let matches: Vec<_> = clients.iter().filter(|item| item["id"] == id).collect();
        if matches.len() != 1 {
            return Err("Ambiguous AI-client inventory; old apps were kept.".into());
        }
        let item = matches[0];
        match item["supported"].as_bool() {
            Some(true) if item["issue"].is_null() => selected.push(id.into()),
            Some(false) if id == "claudeDesktop" && cfg!(target_os = "linux") => {}
            _ => {
                return Err(format!(
                    "{id} needs configuration review before old apps can be removed."
                ))
            }
        }
    }
    Ok(selected)
}

fn require_no_recovery(value: &Value) -> Result<(), String> {
    if value.as_array().is_some_and(Vec::is_empty) {
        Ok(())
    } else {
        Err("An existing client migration needs recovery review. Old apps were kept.".into())
    }
}

fn require_product_settings_review(value: &Value) -> Result<(), String> {
    let status = value["status"]
        .as_str()
        .ok_or("Product settings review is unavailable.")?;
    let recovery = value["recovery"]
        .as_array()
        .ok_or("Product settings recovery is unavailable.")?;
    if !["none", "current", "legacy-only", "identical"].contains(&status)
        || recovery
            .iter()
            .any(|record| record["completed"] != true && record["historical_completed"] != true)
    {
        return Err(
            "Product settings need conflict or recovery review. Old apps were kept.".into(),
        );
    }
    Ok(())
}

fn accepted_batch(value: &Value) -> Result<(), String> {
    if ["migrated", "unchanged"]
        .iter()
        .any(|status| value["status"] == *status)
        && value["count"].as_u64().is_some_and(|count| count <= 5)
    {
        Ok(())
    } else {
        Err("Connections were not fully reviewed. Old apps were kept.".into())
    }
}

enum MigrationMcp {
    #[cfg(not(feature = "integrated-features"))]
    Hosted(String),
    #[cfg(feature = "integrated-features")]
    Direct,
}

impl MigrationMcp {
    fn start(
        handle: &tauri::AppHandle,
        hosting: &Hosting,
        manager: &manager::Manager,
    ) -> Result<Self, String> {
        let _operation = manager.begin()?;
        #[cfg(feature = "integrated-features")]
        {
            let _ = hosting;
            crate::features::initialize_mcp(handle)?;
            builtin::managed_route(handle)?
                .ok_or("Verified managed MCP routing is unavailable. Old apps were kept.")?;
            creator_works_mcp_launcher::service::bind_managed_route(handle)?;
            Ok(Self::Direct)
        }
        #[cfg(not(feature = "integrated-features"))]
        {
            let candidate = builtin::hosting_candidate(handle, AppId::Mcp)?
                .ok_or("Verified built-in MCP is unavailable. Old apps were kept.")?;
            let result = hosting.start_verified(
                handle,
                AppId::Mcp,
                &candidate.path,
                &candidate.hash,
                true,
            )?;
            if result["effectiveMode"] != "writable" {
                return Err("MCP did not admit writable migration; old apps were kept.".into());
            }
            Ok(Self::Hosted(
                result["session"]
                    .as_str()
                    .ok_or("MCP returned no migration session.")?
                    .to_owned(),
            ))
        }
    }

    fn call(
        &self,
        handle: &tauri::AppHandle,
        hosting: &Hosting,
        manager: &manager::Manager,
        command: &str,
        args: Value,
    ) -> Result<Value, String> {
        match self {
            #[cfg(feature = "integrated-features")]
            Self::Direct => {
                let _ = (hosting, manager);
                crate::features::call_mcp(handle, command, args)
            }
            #[cfg(not(feature = "integrated-features"))]
            Self::Hosted(session) => {
                let _ = handle;
                hosting.call(manager, session, command, args)
            }
        }
    }

    fn finish(
        &self,
        handle: &tauri::AppHandle,
        hosting: &Hosting,
        manager: &manager::Manager,
    ) -> Result<manager::Operation, String> {
        let operation = manager.begin()?;
        match self {
            #[cfg(feature = "integrated-features")]
            Self::Direct => {
                let _ = hosting;
                if !crate::features::mcp_is_idle(handle)? {
                    return Err(
                        "MCP still has active work or an uncertain outcome. Old apps were kept."
                            .into(),
                    );
                }
                Ok(operation)
            }
            #[cfg(not(feature = "integrated-features"))]
            Self::Hosted(session) => {
                let _ = handle;
                hosting.stop_owned_and_wait(session, std::time::Duration::from_secs(10))?;
                Ok(operation)
            }
        }
    }
}

#[tauri::command]
pub async fn migrate_convergence_connections(handle: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_builtin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state
            .0
            .lock()
            .map_err(|_| "Migration state is unavailable.")?;
        let plan = saved
            .as_mut()
            .ok_or("Check existing apps before migration.")?;
        if plan.report.stage != "backed-up" {
            return Err("Retain verified settings backups before moving connections.".into());
        }
        can_retain(plan)?;
        let hosting = handle.state::<Hosting>();
        let manager = handle.state::<manager::Manager>();
        let session = MigrationMcp::start(&handle, &hosting, &manager)?;
        let call = |command: &str, args: Value| session.call(&handle, &hosting, &manager, command, args);
        // Own only this temporary backend. Do not close any restored/user view.
        plan.retry_allowed = false;
        let mut workflow_finished = false;
        let transfer = (|| {
            let workflow = call("begin_ui_operation", json!({}))?;
            let operation = (|| {
                require_product_settings_review(&call(
                    "product_settings_status",
                    json!({}),
                )?)?;
                require_no_recovery(&call(
                    "pending_client_recovery",
                    json!({}),
                )?)?;
                let status = call(
                    "get_onboarding_status",
                    json!({"unityProjectPath":null}),
                )?;
                let clients = supported_clients(&status)?;
                if status["runtime"]["ready"] != true
                    || status["runtime"]["bundled"] != true
                    || status["managedRouting"] != true
                {
                    return Err(
                        "MCP did not verify its bundled managed runtime. Old apps were kept."
                            .into(),
                    );
                }
                accepted_batch(&call(
                    "review_existing_client_connections",
                    json!({"clients":clients}),
                )?)?;
                require_no_recovery(&call(
                    "pending_client_recovery",
                    json!({}),
                )?)?;
                require_product_settings_review(&call(
                    "product_settings_status",
                    json!({}),
                )?)?;
                let store = creator_hub_mcp_router::Store::installed()?;
                let runtime = store.resolve()?;
                let _router = store.router()?;
                recheck_durable_settings(plan)?;
                let transition =
                    call("review_convergence_server", json!({}))?;
                refresh_reviewed_server_paths(plan, &roots()?, &runtime.server, &transition)?;
                Ok::<_, String>(())
            })();
            let finish = call(
                "finish_ui_operation",
                json!({"id":workflow}),
            );
            workflow_finished = finish.is_ok();
            operation?;
            finish?;
            Ok::<_, String>(())
        })();
        let close = session.finish(&handle, &hosting, &manager);
        // Cancel also records a returned outcome. Refresh only the owned journal
        // after observed exit (legacy) or joined, idle internal work (direct),
        // never the user's project selection/options.
        if workflow_finished && close.is_ok() {
            refresh_finished_outcome_journal(plan, &roots()?)?;
        }
        transfer?;
        let completion_guard = close?;
        // Review is not live-client acceptance or permission to uninstall.
        recheck(plan)?;
        save_review_at(&record_path()?, &plan.stores)?;
        plan.report.stage = "connections-reviewed";
        drop(completion_guard);
        plan.report.message = retirement_diagnostics(plan, &manager).unwrap_or_else(|reason|
            format!("Connections are reviewed; standalone cleanup paused: {reason}. Choose Check again to review a fresh plan."));
        Ok(plan.report.clone())
    })
    .await
    .map_err(|_| {
        "Migration outcome is unknown. Keep original apps and retained recovery records."
    })?
}

fn retirement_diagnostics(plan: &mut Plan, manager: &manager::Manager) -> Result<String, String> {
    let _operation = manager.begin()?;
    retirement_diagnostics_locked(plan)
}

fn retirement_diagnostics_locked(plan: &mut Plan) -> Result<String, String> {
    recheck(plan)?;
    #[cfg(windows)]
    {
        plan.retirement_dependencies = None;
        plan.report.retirement_available = false;
        let installations = retirement_plans(plan)?;
        let paths = installations
            .iter()
            .map(|app| app.mutation_paths())
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if paths.is_empty() {
            plan.report.retirement_available = true;
            return Ok("Settings and connections are reviewed. No standalone app remains to retire; finish migration to continue.".into());
        }
        let store = creator_hub_mcp_router::Store::installed()?;
        let _runtime = store.resolve()?;
        let router = store.router()?;
        let dependencies =
            crate::convergence_dependencies::gui_retirement_snapshot(&paths, &router.command);
        dependencies.recheck().map_err(|_| {
            "Known client settings or GUI dependencies need review; standalone apps were kept."
        })?;
        plan.retirement_dependencies = Some(dependencies);
        plan.report.retirement_available = true;
        Ok("Ready to retire verified standalone app entries after your approval. All settings and old MCP Node/server paths stay in place. Custom launchers that open the old GUI or find it through its app registration need separate review; unknown client scopes do not authorize deleting the retained runtime.".into())
    }
    #[cfg(target_os = "linux")]
    {
        plan.report.retirement_available = false;
        #[cfg(feature = "experimental-linux-migration")]
        {
            plan.retirement_linux = None;
            let current = legacy_apps()?;
            if !plan.report.legacy_apps.is_empty() || !current.is_empty() {
                let store = creator_hub_mcp_router::Store::installed()?;
                let _runtime = store.resolve()?;
                let router = store.router()?;
                let paths = current
                    .iter()
                    .map(|app| app.path.clone())
                    .collect::<Vec<_>>();
                let native = crate::convergence_linux::Plan::inspect(&paths, &router.command)?;
                plan.retirement_linux = Some(native);
                plan.report.retirement_available = true;
                return Ok("Development test only: the verified standalone DEB apps shown in this review are ready for separately confirmed system-authorized retirement. Only exact MCP 2.7.7 and Project Setup 0.3.7 packages are eligible. The TEST ONLY helper is not release acceptance. All settings and old MCP Node/server paths stay in place; custom old-GUI integrations need separate review.".into());
            }
            if crate::convergence_linux::pending()? {
                let store = creator_hub_mcp_router::Store::installed()?;
                let _runtime = store.resolve()?;
                let router = store.router()?;
                plan.retirement_linux = Some(crate::convergence_linux::Plan::inspect_retained(
                    &router.command,
                )?);
                plan.report.retirement_available = true;
                return Ok("Retained package state for pending MCP and/or Project Setup cleanup was independently checked. Review completion to finish the guide; this will not repeat any package transaction.".into());
            }
        }
        require_no_retirement(plan, &legacy_apps()?)?;
        plan.report.retirement_available = true;
        Ok("Settings and connections are reviewed. No known standalone app was found; finish migration to continue. No installation will be removed.".into())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    Ok("Settings and existing connections are reviewed. Old apps were kept: native removal and connection acceptance are not completed on this platform.".into())
}

// Opaque native authority, minted only after the service's snapshot-bound
// native dialog. Neither renderer arguments nor persisted review records mint it.
#[cfg(feature = "integrated-features")]
pub(crate) struct NativeConsent {
    route_key: String,
    review_key: String,
}

#[cfg(feature = "integrated-features")]
impl NativeConsent {
    pub(crate) fn authorize_route(&self, key: &str) -> Result<(), String> {
        if self.route_key != key {
            return Err("The signed routing review changed; no route was activated.".into());
        }
        Ok(())
    }

    fn recheck(&self, plan: &Plan) -> Result<(), String> {
        self.recheck_at(plan, &legacy_apps()?, retirement_pending()?)
    }

    fn recheck_at(&self, plan: &Plan, apps: &[LegacyApp], pending: bool) -> Result<(), String> {
        can_prepare(plan)?;
        if prompt_review_key(&plan.stores, apps, pending)? != self.review_key {
            return Err(
                "Settings or standalone app state changed during native consent. Review again."
                    .into(),
            );
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    outcome: &'static str,
    phase: &'static str,
    report: Report,
    message: String,
}

#[cfg(feature = "integrated-features")]
fn retain_batch_settings(
    plan: &mut Plan,
    base: &stores::Roots,
    import: Option<&ProjectImport>,
    native_recheck: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    can_prepare(plan)?;
    native_recheck()?;
    close_reviewed_guis(plan)?;
    retain_after_close(plan, base, import, native_recheck)
}

#[cfg(any(feature = "integrated-features", test))]
fn retain_after_close(
    plan: &mut Plan,
    base: &stores::Roots,
    import: Option<&ProjectImport>,
    native_recheck: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    can_prepare(plan)?;
    native_recheck()?;
    let mut images = Vec::new();
    for snapshot in &plan.stores {
        if let Some(before) = snapshot.bytes() {
            let backup = snapshot.retain_reviewed()?;
            if snapshot.store() != stores::Store::McpHostedOutcomes {
                stores::validate_import(snapshot, &backup, Some(before), before)?;
            }
            images.push(backup);
        }
    }
    recheck(plan)?;
    plan.report.backups = images
        .iter()
        .map(|image| image.path().to_path_buf())
        .collect();
    plan.retained_images = images;
    if settings_conflict(plan) {
        import_reviewed_projects(
            plan,
            base,
            import.ok_or(
                "The exact approved project import is unavailable. Review again before continuing.",
            )?,
        )?;
    } else if import.is_some() {
        return Err("The settings no longer match the approved project import.".into());
    }
    can_retain(plan)?;
    plan.report.stage = "backed-up";
    plan.report.settings_import_available = false;
    Ok(())
}

#[cfg(any(
    all(windows, feature = "integrated-features"),
    all(
        target_os = "linux",
        feature = "experimental-linux-migration",
        feature = "integrated-features"
    ),
    test,
))]
fn track_cleanup_evidence<T>(
    cleanup_started: &mut bool,
    mut prior_evidence: impl FnMut() -> Result<bool, String>,
    operation: impl FnOnce(&mut bool) -> Result<T, String>,
) -> Result<T, String> {
    match prior_evidence() {
        Ok(true) => *cleanup_started = true,
        Ok(false) => {}
        Err(reason) => {
            *cleanup_started = true;
            return Err(reason);
        }
    }
    let result = operation(cleanup_started);
    // Diagnostics can wait or fail before reaching the callback-protected leaf.
    // New or unreadable prior evidence is not proof of an untouched installation.
    if result.is_err() && prior_evidence().unwrap_or(true) {
        *cleanup_started = true;
    }
    result
}

#[cfg(all(windows, feature = "integrated-features"))]
fn retire_batch_apps(
    plan: &mut Plan,
    installations: &[crate::legacy_retirement_windows::RetirementPlan],
    cleanup_started: &mut bool,
) -> Result<(), String> {
    track_cleanup_evidence(
        cleanup_started,
        || {
            if retirement_pending()? {
                return Ok(true);
            }
            for installation in installations {
                if installation.has_prior_evidence()? {
                    return Ok(true);
                }
            }
            Ok(false)
        },
        |cleanup_started| {
            retirement_diagnostics_locked(plan)?;
            if !plan.report.retirement_available {
                return Err("Standalone cleanup is not available for this reviewed setup.".into());
            }
            let store = creator_hub_mcp_router::Store::installed()?;
            let runtime = store.resolve()?;
            let router = store.router()?;
            let preflight = || {
                can_retain(plan)?;
                if !installations.is_empty() {
                    plan.retirement_dependencies.as_ref().ok_or("The reviewed client snapshot is unavailable.")?.recheck()
                .map_err(|_| "Client settings changed or a GUI dependency appeared. Cleanup stopped; retained files were kept.")?;
                }
                if store.resolve()?.generation != runtime.generation
                    || store.router()?.command != router.command
                {
                    return Err(
                        "The signed runtime changed. Cleanup stopped; retained files were kept."
                            .into(),
                    );
                }
                Ok(())
            };
            preflight()?;
            for installation in installations {
                installation
                    .retire_after_native_review_batch(preflight, || *cleanup_started = true)?;
                if !installation.completed()? {
                    return Err("Standalone cleanup did not verify completion.".into());
                }
            }
            preflight()?;
            if !legacy_apps()?.is_empty() || retirement_pending()? {
                return Err(
            "Standalone app cleanup is not verified complete. Keep retained files for review."
                .into(),
        );
            }
            plan.report.stage = "complete";
            plan.report.required = false;
            plan.report.retirement_available = false;
            plan.report.legacy_apps.clear();
            plan.retirement_dependencies = None;
            Ok(())
        },
    )
}

#[cfg(all(
    target_os = "linux",
    feature = "experimental-linux-migration",
    feature = "integrated-features"
))]
fn linux_originals(plan: &Plan) -> Result<Option<crate::convergence_linux::Originals>, String> {
    if retirement_pending()? {
        return Err(
            "An earlier Linux cleanup needs explicit outcome review. No transaction was replayed."
                .into(),
        );
    }
    if plan.report.legacy_apps.is_empty() {
        require_no_retirement(plan, &legacy_apps()?)?;
        return Ok(None);
    }
    let paths = plan
        .report
        .legacy_apps
        .iter()
        .map(|app| app.path.clone())
        .collect::<Vec<_>>();
    crate::convergence_linux::Originals::inspect(&paths).map(Some)
}

#[cfg(any(
    all(
        target_os = "linux",
        feature = "experimental-linux-migration",
        feature = "integrated-features"
    ),
    test
))]
fn track_linux_cleanup<T>(
    attempted: &std::cell::Cell<bool>,
    inspect: impl FnMut() -> Result<bool, String>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut started = attempted.get();
    let result = track_cleanup_evidence(&mut started, inspect, |_| operation());
    attempted.set(attempted.get() || started);
    result
}

#[cfg(all(
    target_os = "linux",
    feature = "experimental-linux-migration",
    feature = "integrated-features"
))]
fn retire_linux_batch(
    plan: &mut Plan,
    native: Option<&crate::convergence_linux::Plan>,
    generation: &str,
    router: &std::path::Path,
    attempted: &std::cell::Cell<bool>,
) -> Result<(), String> {
    track_linux_cleanup(attempted, retirement_pending, || {
        let store = creator_hub_mcp_router::Store::installed()?;
        let preflight = || {
            can_retain(plan)?;
            if store.resolve()?.generation != generation
                || store.router()?.command.as_path() != router
            {
                return Err("The signed MCP route changed during Linux migration. Cleanup stopped; retained files were kept.".into());
            }
            Ok(())
        };
        preflight()?;
        if let Some(native) = native {
            match native.retire_after_native_review_batch(preflight, || attempted.set(true))? {
                crate::linux_retirement::Outcome::Cancelled => {
                    return Err("System authorization was cancelled. Settings and connection transfer were kept; no later app cleanup was started.".into());
                }
                crate::linux_retirement::Outcome::ExperimentalVerified => {}
            }
            preflight()?;
            if !legacy_apps()?.is_empty() {
                return Err("A standalone GUI remains after Linux cleanup. Keep retained files and review package state.".into());
            }
            native.complete_review()?;
            preflight()?;
        } else {
            require_no_retirement(plan, &legacy_apps()?)?;
        }
        if retirement_pending()? {
            return Err(
                "Linux cleanup still has a pending outcome. No transaction was replayed.".into(),
            );
        }
        plan.report.stage = "complete";
        plan.report.required = false;
        plan.report.retirement_available = false;
        plan.report.legacy_apps.clear();
        Ok(())
    })
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        feature = "integrated-features",
        feature = "linux-production-migration"
    )
))]
const LINUX_PRODUCTION_RETIREMENT_CONSENT: &str = "Only exact MCP 2.7.7 and Project Setup 0.3.7 DEBs are eligible. Linux requests administrator authentication separately for each app after settings and connections transfer. Cancelling a later system prompt does not undo earlier cleanup or the completed transfer. Unknown outcomes require review, never automatic retry. All nine old MCP Node/server/license/bridge files stay at their existing paths. Setup keeps one fixed non-executable retirement notice.\n\nContinuing also accepts the unknown custom-GUI integration risk: custom integrations requiring an old app window or its desktop registration may stop working and are not converted. Cancel if you need those integrations.";

#[tauri::command]
pub async fn move_to_hub(handle: tauri::AppHandle) -> Result<MoveOutcome, String> {
    #[cfg(not(feature = "integrated-features"))]
    {
        let _ = handle;
        Err("Streamlined migration requires first-party integrated Hub services.".into())
    }
    #[cfg(feature = "integrated-features")]
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        require_builtin()?;
        // One admission spans every phase and the durable completion publication.
        let _operation = handle.state::<manager::Manager>().begin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state.0.try_lock().map_err(|_| "Migration is already active or unavailable.")?;
        let plan = saved.as_mut().ok_or("Inspect existing settings before moving to Hub.")?;
        if plan.report.stage != "review" || !plan.report.required {
            return Err("Check the retained outcome before starting a fresh migration review.".into());
        }
        let mut phase = "review";
        let mut cancelled = false;
        #[cfg(windows)]
        let mut cleanup_started = false;
        #[cfg(not(windows))]
        let cleanup_started = false;
        #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
        let linux_cleanup_started = std::cell::Cell::new(false);
        let mut journal_started = false;
        let mut approved_key = String::new();
        let mut journal = BatchJournal::open(batch_path()?)?;
        let result = (|| {
            can_prepare(plan)?;
            let base = roots()?;
            if read_batch_at(&batch_path()?)?.as_ref().is_some_and(batch_needs_review) {
                return Err("The previous native migration outcome needs review. No write was repeated.".into());
            }
            check_settings_recovery(&base)?;
            let import = if settings_conflict(plan) {
                Some(merge_project_settings(plan.stores[0].bytes().unwrap(), plan.stores[1].bytes().unwrap())?)
            } else { None };
            // Native provenance plans bind original GUI/registration identities,
            // not a renderer list or an installation discovered after approval.
            #[cfg(windows)]
            let installations = retirement_plans(plan)?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let originals = linux_originals(plan)?;
            #[cfg(all(target_os = "linux", not(feature = "experimental-linux-migration")))]
            require_no_retirement(plan, &legacy_apps()?)?;
            let route = builtin::convergence_route_review(&handle)?.ok_or("This Hub has no signed MCP route.")?;
            let candidate = builtin::hosting_candidate(&handle, AppId::Mcp)?.ok_or("Verified internal MCP is unavailable.")?;
            let server_root = candidate.path.parent().ok_or("Invalid internal MCP payload.")?.join("server");
            let server = server_root.join("creator-works-mcp.mjs");
            let review = creator_works_mcp_launcher::service::ConvergenceReview::inspect(
                &server, import.as_ref().map(|proposal| proposal.bytes.as_slice()))?;
            let route_key = route.key();
            let review_key = prompt_review_key(&plan.stores, &plan.report.legacy_apps, retirement_pending()?)?;
            let summary = format!("{} missing project(s); {} known standalone app location(s). Custom launchers that need an old GUI or its registration are not converted.",
                import.as_ref().map_or(0, |proposal| proposal.added), plan.report.legacy_apps.len());
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration", not(feature = "linux-production-migration")))]
            let summary = if originals.is_some() {
                format!("{summary}\n\nLinux development test only: only exact MCP 2.7.7 and Project Setup 0.3.7 DEBs are eligible. Linux requests administrator authentication separately for each app after settings and connections transfer. Cancelling a later system prompt does not undo earlier cleanup or the completed transfer. Unknown outcomes require review, never automatic retry. All nine old MCP Node/server/license/bridge files stay at their existing paths. Setup keeps one fixed non-executable retirement notice.\n\nContinuing also accepts the unknown custom-GUI integration risk: custom integrations requiring an old app window or its desktop registration may stop working and are not converted. Cancel if you need those integrations. These TEST ONLY packages are not release acceptance.")
            } else { summary };
            #[cfg(all(target_os = "linux", feature = "linux-production-migration"))]
            let summary = if originals.is_some() {
                format!("{summary}\n\n{LINUX_PRODUCTION_RETIREMENT_CONSENT}")
            } else { summary };
            let Some(approved) = review.approve(&handle, &summary)? else {
                cancelled = true;
                return Ok(());
            };
            let consent = NativeConsent { route_key, review_key };
            consent.recheck(plan)?;
            route.recheck()?;
            approved.recheck()?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            if let Some(originals) = &originals { originals.recheck()?; }
            approved_key = consent.review_key.clone();
            phase = "backup";
            journal.record(&BatchRecord { policy: POLICY, phase: phase.into(), outcome: "started".into(), review_key: approved_key.clone(), retry_blocked: true })?;
            journal_started = true;
            let _ = handle.emit("convergence-progress", phase);
            retain_batch_settings(plan, &base, import.as_ref(), || {
                approved.recheck()?;
                #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
                if let Some(originals) = &originals { originals.recheck()?; }
                Ok(())
            })?;
            if let Some(proposal) = &import {
                creator_works_mcp_launcher::service::verify_convergence_import(
                    &proposal.bytes, plan.stores[0].bytes(), plan.stores[1].bytes())?;
            }
            phase = "connections";
            journal.record(&BatchRecord { policy: POLICY, phase: phase.into(), outcome: "started".into(), review_key: approved_key.clone(), retry_blocked: true })?;
            let _ = handle.emit("convergence-progress", phase);
            // No legacy child GUI, hosted launch/hash prompt or dialog bypass.
            // Initial routing approval is this native receipt for the exact route.
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let linux_router = route.activate_convergence(&consent)?;
            #[cfg(not(all(target_os = "linux", feature = "experimental-linux-migration")))]
            route.activate_convergence(&consent)?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let linux_store = creator_hub_mcp_router::Store::installed()?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let linux_receipt = linux_store.snapshot()?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let linux_runtime = linux_store.resolve()?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let recheck_linux_transfer = || -> Result<(), String> {
                if let Some(originals) = &originals { originals.recheck()?; }
                let runtime = linux_store.resolve()?;
                if linux_store.snapshot()? != linux_receipt
                    || linux_store.router()?.command != linux_router.command
                    || runtime.generation != linux_runtime.generation
                    || runtime.hub_version != linux_runtime.hub_version
                    || runtime.node != linux_runtime.node
                    || runtime.server != linux_runtime.server
                {
                    return Err("The approved MCP route or runtime changed during connection transfer. Apps were kept; review the retained outcome.".into());
                }
                Ok(())
            };
            creator_works_mcp_launcher::service::initialize(&handle, server_root)?;
            creator_works_mcp_launcher::service::bind_managed_route(&handle)?;
            plan.retry_allowed = false;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            recheck_linux_transfer()?;
            let workflow = creator_works_mcp_launcher::service::call(&handle, "begin_ui_operation", json!({}))?;
            let transfer = creator_works_mcp_launcher::service::apply_convergence(&handle, approved);
            let finish = creator_works_mcp_launcher::service::call(&handle, "finish_ui_operation", json!({"id":workflow}));
            let idle = creator_works_mcp_launcher::service::is_idle(&handle)?;
            if finish.is_ok() && idle {
                // This only renews the service's known completed outcome journal.
                // The server fields are renewed below from its checked transition.
                if let Ok(transition) = &transfer {
                    refresh_reviewed_server_paths(plan, &base, &server, transition)?;
                }
                refresh_finished_outcome_journal(plan, &base)?;
            }
            transfer?;
            finish?;
            if !idle { return Err("The internal MCP workflow still needs outcome review.".into()); }
            recheck(plan)?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            recheck_linux_transfer()?;
            // Strict GUI dependency checks run only after approved connections
            // have moved; Originals retained baseline authority throughout.
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            let linux_native = originals.map(|originals| originals.bind(&linux_router.command)).transpose()?;
            save_review_at(&record_path()?, &plan.stores)?;
            plan.report.stage = "connections-reviewed";
            phase = "cleanup";
            journal.record(&BatchRecord { policy: POLICY, phase: phase.into(), outcome: "started".into(), review_key: approved_key.clone(), retry_blocked: true })?;
            let _ = handle.emit("convergence-progress", phase);
            #[cfg(windows)]
            retire_batch_apps(plan, &installations, &mut cleanup_started)?;
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            retire_linux_batch(plan, linux_native.as_ref(), &linux_runtime.generation, &linux_router.command, &linux_cleanup_started)?;
            #[cfg(all(target_os = "linux", not(feature = "experimental-linux-migration")))]
            finish_without_retirement(plan, |plan| {
                can_retain(plan)?;
                require_no_retirement(plan, &legacy_apps()?)?;
                if retirement_pending()? { return Err("System cleanup outcome needs explicit native review; no transaction was replayed.".into()); }
                Ok(())
            }, || true)?;
            #[cfg(not(any(windows, target_os = "linux")))]
            return Err("Native standalone cleanup is not available on this platform.".into());
            Ok::<_, String>(())
        })();
        #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
        let cleanup_started = cleanup_started || linux_cleanup_started.get();
        let (mut outcome, mut message) = match result {
            Ok(()) if cancelled => ("cancelled", "Move to Hub was cancelled. Settings, client connections and installations were not changed.".to_owned()),
            Ok(()) if plan.report.stage == "complete" => ("complete", "Move complete. Settings and backups were kept; standalone cleanup was verified.".to_owned()),
            Ok(()) => ("stopped", format!("Migration stopped during {phase}. Completion was not verified; keep the retained settings and backups.")),
            Err(reason) => {
                if phase == "cleanup" {
                    cleanup_failure(plan, cleanup_started);
                    if let Ok(apps) = legacy_apps() { plan.report.legacy_apps = apps; }
                }
                let cleanup = if cleanup_started { " Cleanup may be partial." } else { " Standalone cleanup was not started." };
                ("stopped", format!("Migration stopped during {phase}: {reason} Settings and any backups, recovery records and compatibility runtime files were retained.{cleanup} No automatic retry was started."))
            }
        };
        if journal_started {
            let publication = journal.record(&BatchRecord {
                policy: POLICY, phase: phase.into(), outcome: if outcome == "complete" { "complete" } else { "stopped" }.into(),
                review_key: approved_key, retry_blocked: !plan.retry_allowed,
            });
            if let Err(reason) = publication {
                outcome = "stopped";
                plan.retry_allowed = false;
                // Never advertise completion without its durable phase outcome.
                plan.report.stage = if phase == "cleanup" { "connections-reviewed" } else { plan.report.stage };
                plan.report.required = true;
                plan.report.retirement_available = false;
                message = format!("Migration outcome publication failed during {phase}: {reason} Retained files and the last phase record were kept. Do not repeat the move.");
            }
        }
        if outcome != "cancelled" { plan.report.message = message.clone(); }
        if !plan.retry_allowed && plan.settings_import_recovery.is_none() {
            plan.report.recovery_help = Some(recovery_help(Some(phase), &journal.path));
        }
        plan.report.move_available = plan.retry_allowed && plan.report.stage == "review";
        plan.report.settings_import_available = settings_import_available(
            &plan.stores, plan.report.stage, plan.retry_allowed,
        );
        Ok(MoveOutcome { outcome, phase, report: plan.report.clone(), message })
    }).await.map_err(|_| "Migration outcome is unknown. Keep retained files and review recovery; do not repeat the move.")?
}

#[cfg(any(feature = "integrated-features", test))]
fn cleanup_failure(plan: &mut Plan, attempted: bool) {
    plan.report.retirement_available = false;
    if attempted {
        plan.retry_allowed = false;
    }
}

#[cfg(any(target_os = "linux", test))]
fn require_no_retirement(plan: &Plan, current: &[LegacyApp]) -> Result<(), String> {
    if !plan.report.legacy_apps.is_empty() || !current.is_empty() {
        return Err("Standalone apps are still present or the installation changed. Native Linux removal is not available yet; apps and data were kept.".into());
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn finish_without_retirement(
    plan: &mut Plan,
    preflight: impl Fn(&Plan) -> Result<(), String>,
    approve: impl FnOnce() -> bool,
) -> Result<Report, String> {
    preflight(plan)?;
    if !approve() {
        return Err("Migration completion was cancelled. Apps and settings were kept.".into());
    }
    preflight(plan)?;
    plan.report.stage = "complete";
    plan.report.required = false;
    plan.report.retirement_available = false;
    plan.report.message = "Migration complete. Use MCP and Project Setup in Creator Hub. Your reviewed settings and backups are kept. No standalone installation was removed.".into();
    Ok(plan.report.clone())
}

#[tauri::command]
pub async fn retire_convergence_apps(handle: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_builtin()?;
        let _operation = handle.state::<manager::Manager>().begin()?;
        let state = handle.state::<Convergence>();
        let mut saved = state.0.lock().map_err(|_| "Migration state is unavailable.")?;
        let plan = saved.as_mut().ok_or("Review migration before retiring apps.")?;
        if plan.report.stage != "connections-reviewed" || !plan.report.retirement_available {
            return Err("Back up settings and review current connections before retiring standalone apps.".into());
        }
        can_retain(plan)?;
        #[cfg(windows)]
        {
            let installations = retirement_plans(plan)?;
            let store = creator_hub_mcp_router::Store::installed()?;
            let runtime = store.resolve()?;
            let router = store.router()?;
            let dependencies = plan.retirement_dependencies.as_ref();
            let preflight = || {
                can_retain(plan)?;
                if !installations.is_empty() {
                    dependencies.ok_or("The reviewed client snapshot is unavailable; check again.")?
                        .recheck().map_err(|_| "Client settings changed or a GUI dependency appeared. Cleanup paused; retained files were kept.")?;
                }
                let fresh_runtime = store.resolve()?;
                let fresh_router = store.router()?;
                if fresh_runtime.generation != runtime.generation || fresh_router.command != router.command {
                    return Err("The signed MCP route changed; cleanup paused.".into());
                }
                Ok::<_, String>(())
            };
            preflight()?;
            let approved = handle.dialog().message(
                "Finish moving to Creator Hub?\n\nHub will retire only the verified standalone MCP/Project Setup windows, default shortcuts and installed-app entries. Settings, AI-client options, Unity projects and local backups are kept. Old Node/server files remain at the same paths so existing MCP connections can continue and reconnect.\n\nCustom launchers that start the old GUI or look it up through its installed-app registration must be reviewed separately. They are not converted by this step. Only continue if you do not need those standalone GUI integrations. AI clients, Unity and Node processes are never force-closed.\n\nAn interrupted cleanup can be reviewed and resumed on next launch. Cancel leaves all installations unchanged."
            ).title("Retire standalone Creator apps").kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Finish migration".into(), "Keep existing".into())).blocking_show();
            if !approved {
                return Err("Standalone retirement was cancelled. Apps and settings were kept.".into());
            }
            let result = (|| {
                preflight()?;
                for app in &installations {
                    // Original GUIs were cooperatively closed before backup/review.
                    // The leaf reserves exact files exclusively, refusing a reopened GUI.
                    app.retire_after_native_review(preflight)?;
                    if !app.completed()? {
                        return Err("Standalone retirement did not record a verified completion.".into());
                    }
                }
                preflight()?;
                Ok::<_, String>(())
            })();
            match result {
                Ok(()) => {
                    plan.report.stage = "complete";
                    plan.report.required = false;
                    plan.report.retirement_available = false;
                    plan.report.legacy_apps.clear();
                    plan.retirement_dependencies = None;
                    plan.report.message = "Migration complete. Use MCP and Project Setup in Creator Hub. Your settings and backups are kept; retained old MCP runtime paths continue to support existing connections.".into();
                }
                Err(reason) => {
                    // Return the current phase even after a partial mutation. Never
                    // let the renderer keep presenting an untouched installation.
                    plan.report.message = format!("Standalone cleanup paused: {reason}. Some app entries may already be retired. Settings and compatibility runtime files were kept. Retry here, or choose Check again for a fresh backup/connection review.");
                    if let Ok(current) = legacy_apps() {
                        plan.report.legacy_apps = current;
                    }
                }
            }
            Ok(plan.report.clone())
        }
        #[cfg(target_os = "linux")]
        {
            let store = creator_hub_mcp_router::Store::installed()?;
            let runtime = store.resolve()?;
            let router = store.router()?;
            #[cfg(feature = "experimental-linux-migration")]
            if let Some(native) = plan.retirement_linux.take() {
                let preflight = || {
                    can_retain(plan)?;
                    let fresh_runtime = store.resolve()?;
                    let fresh_router = store.router()?;
                    if fresh_runtime.generation != runtime.generation || fresh_router.command != router.command {
                        return Err("The signed MCP route changed; Linux cleanup was paused.".into());
                    }
                    Ok::<_, String>(())
                };
                preflight()?;
                native.recheck()?;
                let message = if native.retained_only() {
                    "Review completion of the earlier development cleanup?\n\nThe system helper independently verified retained package state and missing old GUI files for pending MCP and/or Project Setup cleanup. Your settings, backed-up files and current connection route have been reviewed again.\n\nThis step only records completion. No package transaction, administrator prompt, client rewrite or process closure will be repeated. Cancel keeps the outcome review pending. This remains a TEST ONLY development result, not release acceptance."
                } else {
                    "Development migration test only.\n\nRetire the verified standalone DEB apps shown in this review? Only exact MCP 2.7.7 and Project Setup 0.3.7 packages are eligible. MCP retirement keeps all nine original Node/server/license/bridge files at their existing paths. Project Setup retirement keeps no runtime files and adds one fixed non-executable retirement notice. Settings, AI-client options, Unity projects and Hub backups are kept.\n\nCustom launchers that depend on either old GUI or its desktop registration need separate review. AI clients, Unity and Node processes will not be force-closed.\n\nLinux requests administrator authentication separately for each unretired app. Cancel here starts no new transaction and keeps earlier outcome reviews pending. Cancelling a later system prompt does not undo earlier cleanup. Unknown or interrupted outcomes require manual review; no transaction is automatically retried. These TEST ONLY packages are not a published transition."
                };
                let confirm = if native.retained_only() { "Complete outcome review" } else { "Continue to system authorization" };
                let approved = handle.dialog().message(message).title("Test Linux Creator app retirement").kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(confirm.into(), "Keep existing".into())).blocking_show();
                if !approved {
                    plan.retirement_linux = Some(native);
                    return Err("Standalone retirement was cancelled. No new package transaction was started; settings and any pending outcome review were kept.".into());
                }
                let result: Result<bool, String> = (|| {
                    preflight()?;
                    match native.retire_after_native_review()? {
                        crate::linux_retirement::Outcome::Cancelled => return Ok(false),
                        crate::linux_retirement::Outcome::ExperimentalVerified => {}
                    }
                    preflight()?;
                    if !legacy_apps()?.is_empty() {
                        return Err("A standalone GUI remains after cleanup. Keep retained files and review package state.".into());
                    }
                    native.complete_review()?;
                    Ok(true)
                })();
                plan.report.retirement_available = false;
                plan.report.legacy_apps = legacy_apps().unwrap_or_else(|_| plan.report.legacy_apps.clone());
                plan.report.message = match result {
                    Ok(false) => {
                        plan.retirement_linux = Some(native);
                        plan.report.retirement_available = true;
                        "System authorization was cancelled. The standalone installation, settings and connections were kept.".into()
                    }
                    Ok(true) => {
                        plan.report.stage = "complete";
                        plan.report.required = false;
                        "Experimental Linux retirement verified for the reviewed app entries. Any original MCP runtime paths, reviewed settings and backups were kept. This development result is not release acceptance.".into()
                    }
                    Err(reason) => format!("Linux cleanup needs review: {reason} No automatic retry was started. Keep settings, backups and retained runtime files."),
                };
                return Ok(plan.report.clone());
            }
            finish_without_retirement(plan, |plan| {
                can_retain(plan)?;
                require_no_retirement(plan, &legacy_apps()?)?;
                #[cfg(feature = "experimental-linux-migration")]
                if crate::convergence_linux::pending()? {
                    return Err("The Linux cleanup outcome needs review before completion. No transaction was replayed.".into());
                }
                let fresh_runtime = store.resolve()?;
                let fresh_router = store.router()?;
                if fresh_runtime.generation != runtime.generation || fresh_router.command != router.command {
                    return Err("The signed MCP route changed; check again before completing migration.".into());
                }
                Ok(())
            }, || handle.dialog().message(
                "Finish moving to Creator Hub?\n\nYour settings backups and existing AI connections have been reviewed. No known standalone MCP or Project Setup installation was found. This step only finishes the guide; it does not remove an app, change client settings, move projects or stop a connection.\n\nCancel keeps the guide open."
            ).title("Finish Creator Hub migration").kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Finish migration".into(), "Keep reviewing".into())).blocking_show())
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        Err("Native standalone retirement is not accepted on this platform. Existing apps and data were kept.".into())
    }).await.map_err(|_| "Cleanup outcome is unknown. Keep the retained files and review migration on next launch.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("convergence_profiles_tests.rs");

    #[test]
    fn migration_write_admission_matches_the_current_presentation() {
        assert!(require_mcp_migration_mode(Some("writable")).is_ok());
        for mode in [None, Some("read-only"), Some("unknown")] {
            assert_eq!(
                require_mcp_migration_mode(mode).is_ok(),
                cfg!(all(
                    feature = "integrated-features",
                    any(windows, target_os = "linux")
                )),
                "Native service admission must not depend on the legacy hosted flag; legacy presentation must keep its write restriction"
            );
        }
    }

    #[test]
    fn uncertain_migration_handoff_names_the_retained_record_without_replaying() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("move-v1.json");
        fs::write(&path, b"retained evidence").unwrap();
        for phase in [None, Some("backup"), Some("connections"), Some("cleanup")] {
            let text = recovery_help(phase, &path);
            assert!(text.contains(&path.display().to_string()));
            assert!(text.contains("Migration remains incomplete"));
            assert!(text.contains("Choose Not now"));
            assert!(text.contains("not settings contents"));
            assert!(!text.contains("retained evidence"));
            assert_eq!(fs::read(&path).unwrap(), b"retained evidence");
        }
        assert!(recovery_help(Some("backup"), &path).contains("Saved MCP settings"));
        assert!(recovery_help(Some("connections"), &path).contains("Check interrupted changes"));
        assert!(recovery_help(Some("cleanup"), &path).contains("before removing or reinstalling"));
    }

    #[test]
    fn linux_production_consent_keeps_retirement_disclosures_without_test_only_claims() {
        let body = LINUX_PRODUCTION_RETIREMENT_CONSENT;
        for required in [
            "Only exact MCP 2.7.7 and Project Setup 0.3.7 DEBs are eligible.",
            "administrator authentication separately for each app after settings and connections transfer",
            "Cancelling a later system prompt does not undo earlier cleanup or the completed transfer.",
            "Unknown outcomes require review, never automatic retry.",
            "All nine old MCP Node/server/license/bridge files stay at their existing paths.",
            "Setup keeps one fixed non-executable retirement notice.",
            "custom integrations requiring an old app window or its desktop registration may stop working and are not converted.",
            "Cancel if you need those integrations.",
        ] {
            assert!(body.contains(required), "missing consent disclosure: {required}");
        }
        for forbidden in [
            "TEST ONLY",
            "development",
            "release acceptance",
            "release ready",
        ] {
            assert!(!body.contains(forbidden));
        }
    }

    #[test]
    fn linux_native_consent_text_is_selected_only_by_the_production_cfg() {
        let source = include_str!("convergence.rs");
        let body = source
            .split("pub async fn move_to_hub(")
            .nth(1)
            .unwrap()
            .split("fn cleanup_failure(")
            .next()
            .unwrap();
        let development = body.find("#[cfg(all(target_os = \"linux\", feature = \"experimental-linux-migration\", not(feature = \"linux-production-migration\")))]").unwrap();
        let production = body
            .find("#[cfg(all(target_os = \"linux\", feature = \"linux-production-migration\"))]")
            .unwrap();
        let approval = body.find("review.approve(&handle, &summary)").unwrap();
        assert!(development < production && production < approval);
        assert!(body[development..production].contains("Linux development test only:"));
        assert!(body[development..production]
            .contains("These TEST ONLY packages are not release acceptance."));
        let selected = &body[production..approval];
        assert!(selected.contains("if originals.is_some()"));
        assert!(selected.contains("{LINUX_PRODUCTION_RETIREMENT_CONSENT}"));
        assert!(selected.contains("else { summary }"));
        assert!(!selected.contains("TEST ONLY"));
        assert!(!selected.contains("development"));
    }

    #[test]
    fn batch_phase_journal_is_durable_and_never_replays_or_overwrites_unknown_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("move.json");
        let mut journal = BatchJournal::open(path.clone()).unwrap();
        assert!(!path.exists());
        for phase in ["backup", "connections", "cleanup"] {
            journal
                .record(&BatchRecord {
                    policy: POLICY,
                    phase: phase.into(),
                    outcome: "started".into(),
                    review_key: "a".repeat(64),
                    retry_blocked: true,
                })
                .unwrap();
            let retained = read_batch_at(&path).unwrap().unwrap();
            assert_eq!(retained.phase, phase);
            assert!(batch_needs_review(&retained));
            assert!(!inspection_can_admit(false, Some(&retained)));
        }
        let original = fs::read(&path).unwrap();
        fs::write(&path, b"unknown future journal").unwrap();
        assert!(journal
            .record(&BatchRecord {
                policy: POLICY,
                phase: "cleanup".into(),
                outcome: "complete".into(),
                review_key: "a".repeat(64),
                retry_blocked: false
            })
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unknown future journal");
        assert!(BatchJournal::open(path.clone()).is_err());
        fs::write(&path, original).unwrap();
        let retained = read_batch_at(&path).unwrap().unwrap();
        assert!(batch_needs_review(&retained));
    }

    #[test]
    fn known_cleanup_refusal_is_inspectable_but_uncertain_cleanup_never_reopens_mutation() {
        let (_temp, _base, mut plan) = fixture_plan();
        cleanup_failure(&mut plan, false);
        assert!(plan.retry_allowed);
        let mut record = BatchRecord {
            policy: POLICY,
            phase: "cleanup".into(),
            outcome: "stopped".into(),
            review_key: "b".repeat(64),
            retry_blocked: false,
        };
        assert!(inspection_can_admit(false, Some(&record)));
        cleanup_failure(&mut plan, true);
        assert!(!plan.retry_allowed);
        record.retry_blocked = true;
        assert!(!inspection_can_admit(true, Some(&record)));
        assert!(!inspection_can_admit(true, None));
        record.outcome = "started".into();
        record.retry_blocked = false;
        assert!(!inspection_can_admit(false, Some(&record)));
    }

    #[test]
    fn coordinator_prior_evidence_blocks_retry_when_diagnostics_refuse_before_leaf() {
        for unknown in [false, true] {
            let (temp, _base, mut plan) = fixture_plan();
            let before = temp.path().join("retirement-before.json");
            fs::write(&before, b"retained pending evidence").unwrap();
            let diagnostics_called = std::cell::Cell::new(false);
            let mut started = false;
            let result = track_cleanup_evidence::<()>(
                &mut started,
                || {
                    if unknown {
                        Err("prior evidence is unreadable".into())
                    } else {
                        Ok(fs::read(&before).unwrap() == b"retained pending evidence")
                    }
                },
                |started| {
                    assert!(
                        *started,
                        "Prior evidence must be classified before diagnostics"
                    );
                    diagnostics_called.set(true);
                    Err("dependency diagnostic refused before leaf".into())
                },
            );
            assert!(result.is_err());
            assert_eq!(diagnostics_called.get(), !unknown);
            assert!(started);
            cleanup_failure(&mut plan, started);
            assert!(!plan.retry_allowed);
            let path = temp.path().join("move.json");
            let mut journal = BatchJournal::open(path.clone()).unwrap();
            journal
                .record(&BatchRecord {
                    policy: POLICY,
                    phase: "cleanup".into(),
                    outcome: "stopped".into(),
                    review_key: "a".repeat(64),
                    retry_blocked: !plan.retry_allowed,
                })
                .unwrap();
            let retained = read_batch_at(&path).unwrap().unwrap();
            assert!(retained.retry_blocked);
            assert!(!inspection_can_admit(false, Some(&retained)));
            assert_eq!(fs::read(&before).unwrap(), b"retained pending evidence");
        }
    }

    #[test]
    fn coordinator_fresh_evidence_free_busy_refusal_stays_inspectable() {
        let (temp, _base, mut plan) = fixture_plan();
        let before = temp.path().join("retirement-before.json");
        let mut started = false;
        let checks = std::cell::Cell::new(0);
        let result = track_cleanup_evidence::<()>(
            &mut started,
            || {
                checks.set(checks.get() + 1);
                Ok(before.exists())
            },
            |started| {
                assert!(!*started);
                Err("fresh busy refusal before leaf".into())
            },
        );
        assert!(result.is_err());
        assert_eq!(checks.get(), 2);
        assert!(!started);
        assert!(!before.exists());
        cleanup_failure(&mut plan, started);
        assert!(plan.retry_allowed);
        let path = temp.path().join("move.json");
        let mut journal = BatchJournal::open(path.clone()).unwrap();
        journal
            .record(&BatchRecord {
                policy: POLICY,
                phase: "cleanup".into(),
                outcome: "stopped".into(),
                review_key: "a".repeat(64),
                retry_blocked: !plan.retry_allowed,
            })
            .unwrap();
        let retained = read_batch_at(&path).unwrap().unwrap();
        assert!(!retained.retry_blocked);
        assert!(inspection_can_admit(false, Some(&retained)));
    }

    #[test]
    fn coordinator_refusal_rechecks_new_or_unreadable_evidence_before_classifying_fresh() {
        for unreadable in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let before = temp.path().join("retirement-before.json");
            let checks = std::cell::Cell::new(0);
            let mut started = false;
            let result = track_cleanup_evidence::<()>(
                &mut started,
                || {
                    checks.set(checks.get() + 1);
                    if unreadable && checks.get() > 1 {
                        Err("evidence became unreadable".into())
                    } else {
                        Ok(before.exists())
                    }
                },
                |_| {
                    fs::write(&before, b"appeared during dependency inspection").unwrap();
                    Err("coordinator refused before leaf".into())
                },
            );
            assert!(result.is_err());
            assert_eq!(checks.get(), 2);
            assert!(started);
            assert_eq!(
                fs::read(&before).unwrap(),
                b"appeared during dependency inspection"
            );
        }
    }

    #[test]
    fn batch_cleanup_admission_uses_the_leaf_start_signal_not_method_entry() {
        let source = include_str!("convergence.rs");
        let body = source
            .split("fn retire_batch_apps(")
            .nth(1)
            .unwrap()
            .split("pub async fn move_to_hub(")
            .next()
            .unwrap();
        assert_eq!(body.matches("*cleanup_started = true").count(), 1);
        assert!(body
            .contains("retire_after_native_review_batch(preflight, || *cleanup_started = true)"));
        assert!(!body.contains("installation.retire_after_native_review(preflight)"));
        assert!(
            body.find("retire_after_native_review_batch(").unwrap()
                < body.find("*cleanup_started = true").unwrap()
        );
        assert!(
            body.find("track_cleanup_evidence(").unwrap()
                < body.find("retirement_diagnostics_locked(plan)").unwrap()
        );
        assert!(body.contains("retirement_pending()?"));
        assert!(body.contains("installation.has_prior_evidence()?"));
        let leaf = include_str!("legacy_retirement_windows.rs");
        let probe = leaf
            .split("pub(super) fn has_prior_evidence(")
            .nth(1)
            .unwrap()
            .split("/// The coordinator")
            .next()
            .unwrap();
        assert!(probe.contains("prior_retirement_evidence(&self.archive)"));
    }

    #[cfg(feature = "integrated-features")]
    #[test]
    fn consent_to_backup_drift_preserves_external_edits_without_creating_backups() {
        let (_temp, base, mut plan) = fixture_plan();
        let consent = NativeConsent {
            route_key: "a".repeat(64),
            review_key: prompt_review_key(&plan.stores, &[], false).unwrap(),
        };
        consent.recheck_at(&plan, &[], false).unwrap();
        let path = stores::Store::McpCurrent.path(&base).unwrap();
        fs::write(&path, b"external edit after approval").unwrap();
        assert!(consent.recheck_at(&plan, &[], false).is_err());
        assert!(retain_after_close(&mut plan, &base, None, || Ok(())).is_err());
        assert!(plan.retained_images.is_empty());
        assert!(plan.report.backups.is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"external edit after approval");
    }

    #[test]
    fn client_drift_after_close_stops_backup_and_project_import() {
        let (_temp, base, mut plan) = conflicting_plan();
        let originals: Vec<_> = plan
            .stores
            .iter()
            .map(|snapshot| snapshot.bytes().map(Vec::from))
            .collect();
        assert!(retain_after_close(&mut plan, &base, None, || Err(
            "client changed during close".into()
        ))
        .is_err());
        assert!(plan.retained_images.is_empty());
        for (snapshot, before) in plan.stores.iter().zip(originals) {
            snapshot.recheck().unwrap();
            assert_eq!(snapshot.bytes(), before.as_deref());
        }
    }

    #[test]
    fn batched_native_source_keeps_approval_phase_journals_and_completion_in_order() {
        let source = include_str!("convergence.rs");
        let body = source
            .split("pub async fn move_to_hub(")
            .nth(1)
            .unwrap()
            .split("fn cleanup_failure(")
            .next()
            .unwrap();
        let approval = body.find("review.approve(&handle").unwrap();
        let receipt = body.find("let consent = NativeConsent").unwrap();
        let snapshot = body.find("approved.recheck()?").unwrap();
        let backup_record = body.find("journal.record(").unwrap();
        let backup = body.find("retain_batch_settings(plan").unwrap();
        let activation = body.find("route.activate_convergence(&consent)").unwrap();
        let clients = body.find("service::apply_convergence").unwrap();
        let finish = body.find("\"finish_ui_operation\"").unwrap();
        let idle = body.find("service::is_idle").unwrap();
        let review = body.find("save_review_at(").unwrap();
        let cleanup = body.find("retire_batch_apps(").unwrap();
        assert!(
            approval < receipt
                && receipt < snapshot
                && snapshot < backup_record
                && backup_record < backup
        );
        assert!(
            backup < activation
                && activation < clients
                && clients < finish
                && finish < idle
                && idle < review
                && review < cleanup
        );
        assert_eq!(body.matches(".begin()?").count(), 1);
        for forbidden in [
            "Hosting::",
            "MigrationMcp::start",
            "prepare_convergence(",
            "migrate_convergence_connections(",
            "retire_convergence_apps(",
        ] {
            assert!(!body.contains(forbidden));
        }
    }

    #[test]
    fn linux_single_action_prepares_originals_before_the_only_guide_approval() {
        let body = include_str!("convergence.rs")
            .split("pub async fn move_to_hub(")
            .nth(1)
            .unwrap()
            .split("fn cleanup_failure(")
            .next()
            .unwrap();
        let originals = body.find("let originals = linux_originals(plan)?").unwrap();
        let approval = body.find("review.approve(&handle").unwrap();
        let cancelled = body.find("cancelled = true;").unwrap();
        let journal = body.find("journal.record(").unwrap();
        assert!(originals < approval && approval < cancelled && cancelled < journal);
        assert_eq!(body.matches("review.approve(&handle").count(), 1);
        assert!(!body.contains(".blocking_show()"));
        assert!(body.contains("originals.recheck()?"));
        assert!(body.contains("administrator authentication separately for each app"));
        assert!(body.contains("Cancelling a later system prompt does not undo earlier cleanup"));
        assert!(body.contains("Continuing also accepts the unknown custom-GUI integration risk"));
        assert!(body.contains("These TEST ONLY packages are not release acceptance"));
        assert!(body.contains("{LINUX_PRODUCTION_RETIREMENT_CONSENT}"));
        assert!(LINUX_PRODUCTION_RETIREMENT_CONSENT.contains(
            "All nine old MCP Node/server/license/bridge files stay at their existing paths."
        ));
        assert!(LINUX_PRODUCTION_RETIREMENT_CONSENT.contains("custom integrations requiring an old app window or its desktop registration may stop working and are not converted"));
        let guarded_call = "#[cfg(all(target_os = \"linux\", not(feature = \"experimental-linux-migration\")))]\n            require_no_retirement";
        let has_guarded_call = |source: &str| source.replace("\r\n", "\n").contains(guarded_call);
        assert!(has_guarded_call(body));
        for newline in ["\n", "\r\n"] {
            let fixture = guarded_call.replace('\n', newline);
            assert!(has_guarded_call(&fixture));
            let wrong_guard = fixture.replace(
                "not(feature = \"experimental-linux-migration\")",
                "feature = \"experimental-linux-migration\"",
            );
            assert!(!has_guarded_call(&wrong_guard));
            assert!(!has_guarded_call(&fixture.replace(
                "require_no_retirement",
                "unrelated_call(); require_no_retirement",
            )));
        }
        let native = include_str!("convergence_linux.rs");
        let originals = native
            .split("impl Originals {")
            .nth(1)
            .unwrap()
            .split("pub struct Plan")
            .next()
            .unwrap();
        assert!(originals.contains("linux_retirement::Plan::inspect(target)?"));
        assert!(originals.contains("helper.recheck_baseline()?"));
        for write in [
            "save(",
            "retire_after_native_review",
            "atomic_write",
            "prepare_router",
        ] {
            assert!(
                !originals.contains(write),
                "initial read-only plan: {write}"
            );
        }
    }

    #[test]
    fn gui_retirement_linux_strict_plan_is_bound_only_after_completed_connection_transfer() {
        let body = include_str!("convergence.rs")
            .split("pub async fn move_to_hub(")
            .nth(1)
            .unwrap()
            .split("fn cleanup_failure(")
            .next()
            .unwrap();
        let bind = body.find("originals.bind(&linux_router.command)").unwrap();
        let transfer = body.find("transfer?;").unwrap();
        let finish = body.find("finish?;").unwrap();
        let idle = body.find("if !idle").unwrap();
        let rechecked = transfer + body[transfer..].find("recheck(plan)?;").unwrap();
        let cleanup = body.find("retire_linux_batch(").unwrap();
        assert!(
            transfer < finish
                && finish < idle
                && idle < rechecked
                && rechecked < bind
                && bind < cleanup,
            "A strict GUI-retirement Plan must not block the native legacy-connection review before transfer, or authorize cleanup before transfer/finish/idle/settings checks complete"
        );
        let native = include_str!("convergence_linux.rs");
        let bind_body = native
            .split("pub fn bind(self, router: &Path)")
            .nth(1)
            .unwrap()
            .split("pub struct Plan")
            .next()
            .unwrap();
        assert!(bind_body.contains("self.recheck()?"));
        assert!(bind_body.contains("gui_retirement_snapshot"));
        assert!(bind_body.contains("dependencies.recheck()"));
        assert!(bind_body.contains("plan.recheck()?"));
    }

    #[test]
    fn linux_strict_binding_follows_transfer_and_never_replaces_original_helper_plans() {
        let body = include_str!("convergence.rs")
            .split("pub async fn move_to_hub(")
            .nth(1)
            .unwrap()
            .split("fn cleanup_failure(")
            .next()
            .unwrap();
        let bind = body.find("originals.bind(&linux_router.command)").unwrap();
        let boundary = body.find("recheck_linux_transfer()?").unwrap();
        let apply = body.find("service::apply_convergence(").unwrap();
        let finish = body.find("transfer?;").unwrap();
        let idle = body.find("if !idle").unwrap();
        let renewal = body.rfind("recheck_linux_transfer()?").unwrap();
        let cleanup = body.find("retire_linux_batch(plan").unwrap();
        assert!(
            boundary < apply
                && apply < finish
                && finish < idle
                && idle < renewal
                && renewal < bind
                && bind < cleanup
        );
        assert!(!body.contains("native.begin_connection_transfer()"));
        assert!(!body.contains("transfer.complete()?"));
        assert!(body[..renewal].contains("refresh_reviewed_server_paths(plan"));
        assert!(body[..renewal].contains("refresh_finished_outcome_journal(plan"));
        let native = include_str!("convergence_linux.rs");
        let bind_source = native
            .split("pub fn bind(self, router: &Path)")
            .nth(1)
            .unwrap()
            .split("pub struct Plan")
            .next()
            .unwrap();
        assert!(bind_source.contains("self.recheck()?"));
        assert!(bind_source.contains("for (target, helper) in self.installations"));
        assert!(bind_source.contains("dependencies.recheck()"));
        assert!(bind_source.contains("plan.recheck()?"));
        for replaced in [
            "linux_retirement::Plan::inspect",
            "app.helper =",
            "plan.installations =",
        ] {
            assert!(
                !bind_source.contains(replaced),
                "original identity must stay bound: {replaced}"
            );
        }
        let cleanup = include_str!("convergence.rs")
            .split("fn retire_linux_batch(")
            .nth(1)
            .unwrap()
            .split("pub async fn move_to_hub(")
            .next()
            .unwrap();
        for guard in [
            "can_retain(plan)?",
            "store.resolve()?.generation != generation",
            "store.router()?.command.as_path() != router",
            "retire_after_native_review_batch(preflight, || attempted.set(true))",
            "native.complete_review()?",
            "retirement_pending()?",
        ] {
            assert!(cleanup.contains(guard), "Linux batch guard: {guard}");
        }
        assert!(!cleanup.contains(".blocking_show()"));
    }

    #[test]
    fn linux_transfer_keeps_original_signed_route_and_runtime_checks_around_service_writes() {
        let normalize = |source: &str| source.replace("\r\n", "\n");
        let body = normalize(
            include_str!("convergence.rs")
                .split("pub async fn move_to_hub(")
                .nth(1)
                .unwrap()
                .split("fn cleanup_failure(")
                .next()
                .unwrap(),
        );
        let check = body
            .split("let recheck_linux_transfer =")
            .nth(1)
            .unwrap()
            .split("service::initialize(")
            .next()
            .unwrap();
        for guard in [
            "originals.recheck()?",
            "linux_store.resolve()?",
            "linux_store.snapshot()? != linux_receipt",
            "linux_store.router()?.command != linux_router.command",
            "runtime.generation != linux_runtime.generation",
            "runtime.hub_version != linux_runtime.hub_version",
            "runtime.node != linux_runtime.node",
            "runtime.server != linux_runtime.server",
        ] {
            assert!(check.contains(guard), "transfer identity guard: {guard}");
        }
        assert_eq!(body.matches("recheck_linux_transfer()?").count(), 2);
        for statement in [
            "let linux_store =",
            "let linux_receipt =",
            "let linux_runtime =",
            "let recheck_linux_transfer =",
            "recheck_linux_transfer()?;",
            "let linux_native =",
        ] {
            let guarded = format!(
                "#[cfg(all(target_os = \"linux\", feature = \"experimental-linux-migration\"))]\n            {statement}"
            );
            assert!(body.contains(&guarded), "non-Linux exclusion: {statement}");
        }
        for (guard, statement, wrong_guard) in [
            (
                "#[cfg(not(all(target_os = \"linux\", feature = \"experimental-linux-migration\")))]",
                "route.activate_convergence(&consent)?;",
                "#[cfg(all(target_os = \"linux\", feature = \"experimental-linux-migration\"))]",
            ),
            (
                "#[cfg(windows)]",
                "retire_batch_apps(plan, &installations, &mut cleanup_started)?;",
                "#[cfg(unix)]",
            ),
        ] {
            let expected = format!("{guard}\n            {statement}");
            assert!(body.contains(&expected));
            for newline in ["\n", "\r\n"] {
                let fixture = expected.replace('\n', newline);
                assert!(normalize(&fixture).contains(&expected));
                for wrong in [
                    fixture.replace(guard, wrong_guard),
                    fixture.replace(guard, ""),
                    fixture.replace(statement, &format!("unrelated_call(); {statement}")),
                ] {
                    assert!(!normalize(&wrong).contains(&expected));
                }
            }
        }
    }

    #[test]
    fn linux_cancelled_or_unknown_cleanup_blocks_batch_replay_and_keeps_backups() {
        for outcome in [
            "first-system-cancel",
            "later-system-cancel",
            "unknown-helper-outcome",
        ] {
            let (temp, base, mut plan) = fixture_plan();
            retain_after_close(&mut plan, &base, None, || Ok(())).unwrap();
            plan.report.stage = "connections-reviewed";
            let before: Vec<_> = plan
                .stores
                .iter()
                .map(|snapshot| snapshot.bytes().map(Vec::from))
                .collect();
            cleanup_failure(&mut plan, true);
            assert!(!plan.retry_allowed, "{outcome}");
            assert!(can_prepare(&plan).is_err(), "{outcome}");
            let path = temp.path().join("move-v1.json");
            record_batch_at(
                &path,
                &BatchRecord {
                    policy: POLICY,
                    phase: "cleanup".into(),
                    outcome: "stopped".into(),
                    review_key: "a".repeat(64),
                    retry_blocked: !plan.retry_allowed,
                },
            )
            .unwrap();
            assert!(batch_needs_review(&read_batch_at(&path).unwrap().unwrap()));
            assert!(!plan.retained_images.is_empty());
            for (snapshot, expected) in plan.stores.iter().zip(&before) {
                snapshot.recheck().unwrap();
                assert_eq!(snapshot.bytes(), expected.as_deref());
            }
            for backup in &plan.retained_images {
                backup.recheck().unwrap();
            }
        }
    }

    #[test]
    fn linux_new_or_unreadable_cleanup_evidence_never_reopens_batch_retry() {
        for evidence in [
            Ok(false),
            Ok(true),
            Err("unknown cleanup record".to_owned()),
        ] {
            let (temp, _base, mut plan) = fixture_plan();
            let attempted = std::cell::Cell::new(false);
            let unknown = evidence.is_err();
            let expected = evidence.as_ref().copied().unwrap_or(true);
            let router_opened = std::cell::Cell::new(false);
            let result = track_linux_cleanup(
                &attempted,
                || evidence.clone(),
                || {
                    router_opened.set(true);
                    Err::<(), String>("router store admission refused".into())
                },
            );
            assert!(result.is_err());
            assert_eq!(router_opened.get(), !unknown);
            assert_eq!(attempted.get(), expected);
            cleanup_failure(&mut plan, attempted.get());
            assert_eq!(plan.retry_allowed, !expected);
            let path = temp.path().join("move-v1.json");
            record_batch_at(
                &path,
                &BatchRecord {
                    policy: POLICY,
                    phase: "cleanup".into(),
                    outcome: "stopped".into(),
                    review_key: "a".repeat(64),
                    retry_blocked: !plan.retry_allowed,
                },
            )
            .unwrap();
            assert_eq!(
                batch_needs_review(&read_batch_at(&path).unwrap().unwrap()),
                expected
            );
        }
        let attempted = std::cell::Cell::new(true);
        track_linux_cleanup(&attempted, || Ok(false), || Ok(())).unwrap();
        assert!(attempted.get());
    }

    #[test]
    fn linux_evidence_appearing_during_refusing_diagnostics_latches_uncertainty() {
        for unreadable in [false, true] {
            let (temp, _base, mut plan) = fixture_plan();
            let attempted = std::cell::Cell::new(false);
            let diagnostic_entered = std::cell::Cell::new(false);
            let observations = std::cell::Cell::new(0);
            let result = track_linux_cleanup(
                &attempted,
                || {
                    observations.set(observations.get() + 1);
                    if diagnostic_entered.get() && unreadable {
                        Err("cleanup record became unreadable".into())
                    } else {
                        Ok(diagnostic_entered.get())
                    }
                },
                || {
                    diagnostic_entered.set(true);
                    Err::<(), String>("router diagnostic refused before any helper call".into())
                },
            );
            assert_eq!(
                result.unwrap_err(),
                "router diagnostic refused before any helper call"
            );
            assert_eq!(observations.get(), 2);
            assert!(attempted.get());
            cleanup_failure(&mut plan, attempted.get());
            assert!(can_prepare(&plan).is_err());
            let path = temp.path().join("move-v1.json");
            record_batch_at(
                &path,
                &BatchRecord {
                    policy: POLICY,
                    phase: "cleanup".into(),
                    outcome: "stopped".into(),
                    review_key: "a".repeat(64),
                    retry_blocked: !plan.retry_allowed,
                },
            )
            .unwrap();
            assert!(batch_needs_review(&read_batch_at(&path).unwrap().unwrap()));
        }
        // Preserve the exact helper-attempt callback even if both journal reads
        // happen to report no pending entry. Absence cannot clear observed work.
        let attempted = std::cell::Cell::new(false);
        assert!(track_linux_cleanup(
            &attempted,
            || Ok(false),
            || {
                attempted.set(true);
                Err::<(), String>("helper outcome unknown".into())
            }
        )
        .is_err());
        assert!(attempted.get());
    }

    #[test]
    fn linux_cleanup_latch_covers_router_admission_and_refusal_tail() {
        let source = include_str!("convergence.rs");
        let body = source
            .split("fn retire_linux_batch(")
            .nth(1)
            .unwrap()
            .split("pub async fn move_to_hub(")
            .next()
            .unwrap();
        let latch = body
            .find("track_linux_cleanup(attempted, retirement_pending, || {")
            .expect("Linux cleanup evidence must surround all admission, not just preflight");
        let router = body.find("Store::installed()?").unwrap();
        assert!(latch < router);
        let adapter = source
            .split("fn track_linux_cleanup<")
            .nth(1)
            .unwrap()
            .split("fn retire_linux_batch(")
            .next()
            .unwrap();
        assert!(adapter.contains("track_cleanup_evidence("));
        assert!(adapter.contains("attempted.set(attempted.get() || started)"));
    }

    #[test]
    fn completion_keeps_native_admission_until_durable_review_publication() {
        let source = include_str!("convergence.rs");
        let finish = source
            .split("    fn finish(")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(finish.contains("Result<manager::Operation, String>"));
        assert!(finish.contains("Ok(operation)"));
        let body = source
            .split("pub async fn migrate_convergence_connections(")
            .nth(1)
            .unwrap()
            .split("fn retirement_diagnostics(")
            .next()
            .unwrap();
        let journal = body.find("refresh_finished_outcome_journal(plan").unwrap();
        let guard = body.find("let completion_guard = close?").unwrap();
        let publication = body
            .find("save_review_at(&record_path()?, &plan.stores)?")
            .unwrap();
        let release = body.find("drop(completion_guard)").unwrap();
        assert!(journal < guard && guard < publication && publication < release);
        assert_eq!(body.matches("drop(completion_guard)").count(), 1);
    }

    #[test]
    fn partial_retirement_requires_review_even_without_any_original_gui() {
        assert!(migration_required(0, 0, true, true));
        assert!(migration_required(0, 4, true, true));
        assert!(migration_required(1, 4, true, false));
        assert!(!migration_required(0, 4, true, false));
        assert!(migration_required(0, 1, false, false));
        assert!(!migration_required(0, 0, false, false));
    }

    #[test]
    fn migration_relevance_fresh_page_history_does_not_prompt_on_reopen() {
        let (_temp, base, _) = fixture_plan();
        let current = stores::Store::McpCurrent.path(&base).unwrap();
        fs::remove_file(&current).unwrap();
        let before: Vec<_> = stores::STORES
            .into_iter()
            .map(|kind| stores::Snapshot::inspect(kind, &base).unwrap())
            .collect();
        let key = prompt_review_key(&before, &[], false).unwrap();
        assert!(!before.iter().any(migration_relevant));
        // Fresh16 run 39357446683 completed exactly these read operations before normal close.
        let body = serde_json::to_vec(&json!({"revision":1,"records":[
            {"session":"a".repeat(64),"id":3,"command":"load_config","outcome":"returned-ok"},
            {"session":"a".repeat(64),"id":4,"command":"discover_unity_projects","outcome":"returned-ok"}
        ]}))
        .unwrap();
        let path = stores::Store::McpHostedOutcomes.path(&base).unwrap();
        fs::write(&path, &body).unwrap();
        for _ in 0..2 {
            let snapshots: Vec<_> = stores::STORES
                .into_iter()
                .map(|kind| stores::Snapshot::inspect(kind, &base).unwrap())
                .collect();
            assert_eq!(snapshots.len(), stores::STORES.len());
            let settings = snapshots
                .iter()
                .filter(|saved| migration_relevant(saved))
                .count();
            assert_eq!(settings, 0);
            assert!(!migration_required(0, settings, false, false));
            assert_eq!(prompt_review_key(&snapshots, &[], false).unwrap(), key);
            let journal = snapshots
                .iter()
                .find(|saved| saved.store() == stores::Store::McpHostedOutcomes)
                .unwrap();
            assert_eq!(journal.bytes(), Some(body.as_slice()));
            for snapshot in &snapshots {
                snapshot.recheck().unwrap();
            }
            assert!(!current.exists());
            assert_eq!(fs::read(&path).unwrap(), body);
        }
    }

    #[test]
    fn migration_relevance_preserves_uncertain_outcome_semantics_and_journal_bytes() {
        let (_temp, base, _) = fixture_plan();
        fs::remove_file(stores::Store::McpCurrent.path(&base).unwrap()).unwrap();
        let path = stores::Store::McpHostedOutcomes.path(&base).unwrap();
        for (outcome, required) in [
            ("accepted", true),
            ("unknown-acknowledged", true),
            ("returned-ok", false),
            ("returned-error", false),
        ] {
            write_outcome(&base, outcome);
            let bytes = fs::read(&path).unwrap();
            let snapshots: Vec<_> = stores::STORES
                .into_iter()
                .map(|kind| stores::Snapshot::inspect(kind, &base).unwrap())
                .collect();
            assert_eq!(snapshots.len(), stores::STORES.len());
            assert_eq!(snapshots[2].needs_outcome_review(), required);
            let settings = snapshots
                .iter()
                .filter(|saved| migration_relevant(saved))
                .count();
            assert_eq!(migration_required(0, settings, false, false), required);
            assert_eq!(settings_need_review(&snapshots), required);
            assert_eq!(snapshots[2].bytes(), Some(bytes.as_slice()));
            snapshots[2].recheck().unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn migration_relevance_unknown_journals_still_fail_closed_and_remain_unchanged() {
        let (_temp, base, _) = fixture_plan();
        fs::remove_file(stores::Store::McpCurrent.path(&base).unwrap()).unwrap();
        let path = stores::Store::McpHostedOutcomes.path(&base).unwrap();
        for body in [
            br#"{"revision":2,"records":[]}"#.to_vec(),
            br#"{"revision":1,"records":[],"future":true}"#.to_vec(),
            b"malformed journal".to_vec(),
            serde_json::to_vec(&json!({"revision":1,"records":[{
                "session":"a".repeat(64),"id":3,"command":"load_config","outcome":"future-outcome"
            }]}))
            .unwrap(),
        ] {
            fs::write(&path, &body).unwrap();
            let inspected: Result<Vec<_>, _> = stores::STORES
                .into_iter()
                .map(|kind| stores::Snapshot::inspect(kind, &base))
                .collect();
            assert!(inspected.is_err());
            assert_eq!(fs::read(&path).unwrap(), body);
        }
    }

    #[test]
    fn migration_relevance_keeps_real_settings_apps_and_pending_batches_required() {
        for kind in [
            stores::Store::McpCurrent,
            stores::Store::McpLegacy,
            stores::Store::SetupEditors,
        ] {
            let (_temp, base, _) = fixture_plan();
            let current = stores::Store::McpCurrent.path(&base).unwrap();
            let mut bytes = fs::read(&current).unwrap();
            fs::remove_file(&current).unwrap();
            if kind == stores::Store::SetupEditors {
                bytes = b"[]".to_vec();
            }
            let path = kind.path(&base).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &bytes).unwrap();
            let snapshots: Vec<_> = stores::STORES
                .into_iter()
                .map(|kind| stores::Snapshot::inspect(kind, &base).unwrap())
                .collect();
            let settings = snapshots
                .iter()
                .filter(|saved| migration_relevant(saved))
                .count();
            assert_eq!(settings, 1);
            assert!(migration_required(0, settings, false, false));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        assert!(migration_required(1, 0, false, false));
        let (temp, _, _) = fixture_plan();
        let path = temp.path().join("move.json");
        for outcome in ["started", "stopped"] {
            record_batch_at(
                &path,
                &BatchRecord {
                    policy: POLICY,
                    phase: "backup".into(),
                    outcome: outcome.into(),
                    review_key: "a".repeat(64),
                    retry_blocked: outcome == "started",
                },
            )
            .unwrap();
            let pending = read_batch_at(&path).unwrap().unwrap();
            assert!(migration_required(
                0,
                0,
                false,
                pending.outcome != "complete"
            ));
        }
    }

    fn fixture_plan() -> (tempfile::TempDir, stores::Roots, Plan) {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let base = temp.path().canonicalize().unwrap();
        #[cfg(windows)]
        let base = temp.path().to_path_buf();
        let roots = stores::Roots {
            config: base.join("config"),
            local_data: base.join("local"),
        };
        let path = stores::Store::McpCurrent.path(&roots).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"channels":[],"auto_start":false,"futureOption":"kept"}"#,
        )
        .unwrap();
        let plan = Plan {
            stores: stores::STORES
                .into_iter()
                .map(|kind| stores::Snapshot::inspect(kind, &roots).unwrap())
                .collect(),
            retained_images: Vec::new(),
            retry_allowed: true,
            settings_import_recovery: None,
            #[cfg(windows)]
            retirement_dependencies: None,
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            retirement_linux: None,
            report: Report {
                streamlined: cfg!(feature = "integrated-features"),
                move_available: true,
                settings_import_available: false,
                enabled: true,
                required: true,
                stage: "backed-up",
                settings: vec![],
                legacy_apps: vec![],
                backups: vec![],
                retirement_available: false,
                message: String::new(),
                review_key: None,
                recovery_help: None,
            },
        };
        (temp, roots, plan)
    }

    fn conflicting_plan() -> (tempfile::TempDir, stores::Roots, Plan) {
        let (temp, base, mut plan) = fixture_plan();
        let path = stores::Store::McpLegacy.path(&base).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"channels":[],"auto_start":true,"futureOption":"earlier","allow_all_tests":false}"#).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &base).unwrap();
        (temp, base, plan)
    }

    fn retain_fixture(plan: &mut Plan) {
        plan.retained_images = plan
            .stores
            .iter()
            .filter(|s| s.bytes().is_some())
            .map(|s| s.retain_reviewed().unwrap())
            .collect();
    }

    fn project(id: &str, path: &std::path::Path) -> Value {
        json!({"id":id,"name":"Same project name","unity_project_path":path,
            "scene_path":null,"enabled":false,"futureChannelOption":{"keep":true}})
    }

    fn config_with(channels: Vec<Value>) -> Value {
        json!({"channels":channels,"active_channel_id":null,"auto_start":false,
            "allow_all_tests":false,"automatic_update_checks":false,"futurePreference":{"keep":true}})
    }

    #[test]
    fn project_merge_only_adds_missing_folders_and_preserves_all_current_preferences() {
        let (_temp, base, _) = fixture_plan();
        let existing = project("current", &base.local_data.join("existing"));
        let mut current = config_with(vec![existing.clone()]);
        current["active_channel_id"] = json!("current");
        current["mcp_server_path"] = json!("keep-current-server");
        let mut duplicate = existing.clone();
        duplicate["id"] = json!("old-id");
        duplicate["enabled"] = json!(true);
        duplicate["scene_path"] = json!("old-scene");
        let missing = project("missing", &base.local_data.join("missing"));
        let mut legacy = config_with(vec![duplicate, missing.clone(), missing.clone()]);
        legacy["auto_start"] = json!(true);
        legacy["allow_all_tests"] = json!(true);
        legacy["automatic_update_checks"] = json!(true);
        legacy["active_channel_id"] = json!("missing");
        legacy["oldOnlyPreference"] = json!("do not activate");
        let import = merge_project_settings(
            &serde_json::to_vec(&current).unwrap(),
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let result: Value = serde_json::from_slice(&import.bytes).unwrap();
        assert_eq!((import.added, import.already_present), (1, 2));
        let mut expected = current;
        expected["channels"] = json!([existing, missing]);
        assert_eq!(result, expected);
        let again =
            merge_project_settings(&import.bytes, &serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(again.bytes, import.bytes);
    }

    #[test]
    fn project_merge_remaps_only_colliding_import_ids_not_current_selection() {
        let (_temp, base, _) = fixture_plan();
        let mut current = config_with(vec![project("same-id", &base.local_data.join("one"))]);
        current["active_channel_id"] = json!("same-id");
        let legacy = config_with(vec![
            project("same-id", &base.local_data.join("two")),
            project("same-id", &base.local_data.join("three")),
        ]);
        let import = merge_project_settings(
            &serde_json::to_vec(&current).unwrap(),
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let result: Value = serde_json::from_slice(&import.bytes).unwrap();
        assert_eq!(import.added, 2);
        assert_eq!(result["active_channel_id"], current["active_channel_id"]);
        assert_eq!(result["channels"][0], current["channels"][0]);
        let ids: std::collections::HashSet<_> = result["channels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 3);
        assert!(uuid::Uuid::parse_str(result["channels"][1]["id"].as_str().unwrap()).is_ok());
    }

    #[test]
    fn colliding_id_preview_survives_backup_import_and_service_byte_validation_unchanged() {
        let (_temp, base, mut plan) = conflicting_plan();
        let mut current = config_with(vec![project("collision", &base.local_data.join("current"))]);
        current["active_channel_id"] = json!("collision");
        let legacy = config_with(vec![project("collision", &base.local_data.join("earlier"))]);
        let originals = [
            serde_json::to_vec(&current).unwrap(),
            serde_json::to_vec(&legacy).unwrap(),
        ];
        for (index, bytes) in originals.iter().enumerate() {
            fs::write(plan.stores[index].store().path(&base).unwrap(), bytes).unwrap();
            plan.stores[index] =
                stores::Snapshot::inspect(plan.stores[index].store(), &base).unwrap();
        }
        let proposal = merge_project_settings(&originals[0], &originals[1]).unwrap();
        let approved_bytes = proposal.bytes.clone();
        let preview: Value = serde_json::from_slice(&approved_bytes).unwrap();
        let imported_id = preview["channels"][1]["id"].as_str().unwrap();
        assert_ne!(imported_id, "collision");
        retain_after_close(&mut plan, &base, Some(&proposal), || Ok(())).unwrap();
        let actual_current = fs::read(plan.stores[0].store().path(&base).unwrap()).unwrap();
        let actual_legacy = fs::read(plan.stores[1].store().path(&base).unwrap()).unwrap();
        assert_eq!(actual_current, approved_bytes);
        assert_eq!(actual_legacy, approved_bytes);
        #[cfg(feature = "integrated-features")]
        creator_works_mcp_launcher::service::verify_convergence_import(
            &approved_bytes,
            Some(&actual_current),
            Some(&actual_legacy),
        )
        .unwrap();
        for (backup, original) in plan.retained_images.iter().zip(originals) {
            assert_eq!(fs::read(backup.path()).unwrap(), original);
        }
        let saved: Value = serde_json::from_slice(&actual_current).unwrap();
        assert_eq!(saved["active_channel_id"], "collision");
        assert_eq!(saved["channels"][0], current["channels"][0]);
        assert_eq!(saved["channels"][1]["id"], imported_id);
        assert!(plan.retry_allowed);
    }

    #[test]
    fn approved_import_is_bound_to_original_images_not_only_its_output_shape() {
        let (_temp, base, mut plan) = conflicting_plan();
        let proposal = merge_project_settings(
            plan.stores[0].bytes().unwrap(),
            plan.stores[1].bytes().unwrap(),
        )
        .unwrap();
        let path = plan.stores[0].store().path(&base).unwrap();
        let different = br#"{"channels":[],"auto_start":true,"futureOption":"new current"}"#;
        fs::write(&path, different).unwrap();
        plan.stores[0] = stores::Snapshot::inspect(stores::Store::McpCurrent, &base).unwrap();
        retain_fixture(&mut plan);
        assert!(import_reviewed_projects(&mut plan, &base, &proposal)
            .unwrap_err()
            .contains("before-images changed"));
        assert_eq!(fs::read(path).unwrap(), different);
    }

    #[test]
    fn project_merge_reuses_inventory_folder_normalization_without_needing_live_drives() {
        let (_temp, base, _) = fixture_plan();
        let folder = base.local_data.join("Project");
        let first = project("one", &folder);
        let mut alias = first.clone();
        let spelling = folder.join(".").to_string_lossy().into_owned();
        alias["unity_project_path"] = json!(if cfg!(windows) {
            format!("{}/", spelling.replace('\\', "/").to_uppercase())
        } else {
            format!("{spelling}/")
        });
        let current = config_with(vec![first]);
        let legacy = config_with(vec![alias]);
        let bytes = serde_json::to_vec_pretty(&current).unwrap();
        let import = merge_project_settings(&bytes, &serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(import.added, 0);
        assert_eq!(import.already_present, 1);
        assert_eq!(import.bytes, bytes);
        assert!(!folder.exists());
    }

    #[test]
    fn project_merge_keeps_distinct_unix_case_sensitive_folders() {
        if cfg!(windows) {
            return;
        }
        let (_temp, base, _) = fixture_plan();
        let current = config_with(vec![project("one", &base.local_data.join("Project"))]);
        let legacy = config_with(vec![project("two", &base.local_data.join("project"))]);
        assert_eq!(
            merge_project_settings(
                &serde_json::to_vec(&current).unwrap(),
                &serde_json::to_vec(&legacy).unwrap()
            )
            .unwrap()
            .added,
            1
        );
    }

    #[test]
    fn project_merge_refuses_ambiguous_paths_duplicate_current_ids_and_output_limits() {
        let (_temp, base, _) = fixture_plan();
        let valid = serde_json::to_vec(&config_with(vec![])).unwrap();
        for path in [
            std::path::PathBuf::from("relative"),
            base.local_data.join("../ambiguous"),
        ] {
            let invalid = serde_json::to_vec(&config_with(vec![project("one", &path)])).unwrap();
            assert!(merge_project_settings(&valid, &invalid).is_err());
        }
        let duplicated_ids = config_with(vec![
            project("one", &base.local_data.join("one")),
            project("one", &base.local_data.join("two")),
        ]);
        assert!(
            merge_project_settings(&serde_json::to_vec(&duplicated_ids).unwrap(), &valid).is_err()
        );
        let current = config_with(
            (0..256)
                .map(|n| {
                    project(
                        &format!("id-{n}"),
                        &base.local_data.join(format!("project-{n}")),
                    )
                })
                .collect(),
        );
        let missing = config_with(vec![project("new", &base.local_data.join("new"))]);
        assert!(merge_project_settings(
            &serde_json::to_vec(&current).unwrap(),
            &serde_json::to_vec(&missing).unwrap()
        )
        .unwrap_err()
        .contains("256-project"));
        let mut large = config_with(vec![]);
        large["padding"] = json!("x".repeat(256 * 1024 - 220));
        let large = serde_json::to_vec(&large).unwrap();
        assert!(large.len() <= 256 * 1024);
        assert!(merge_project_settings(&large, &serde_json::to_vec(&missing).unwrap()).is_err());
    }

    #[test]
    fn project_import_publishes_one_recoverable_two_store_transaction_after_exact_backups() {
        let (_temp, base, mut plan) = conflicting_plan();
        let current = config_with(vec![project("current", &base.local_data.join("current"))]);
        let legacy = config_with(vec![project("old", &base.local_data.join("old"))]);
        for (index, value) in [current.clone(), legacy].iter().enumerate() {
            fs::write(
                plan.stores[index].store().path(&base).unwrap(),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
            plan.stores[index] =
                stores::Snapshot::inspect(plan.stores[index].store(), &base).unwrap();
        }
        let originals: Vec<_> = plan.stores[..2]
            .iter()
            .map(|s| s.bytes().unwrap().to_vec())
            .collect();
        retain_fixture(&mut plan);
        assert_eq!(import_missing_projects(&mut plan, &base).unwrap(), 1);
        assert!(can_retain(&plan).is_ok());
        let result: Value = serde_json::from_slice(plan.stores[0].bytes().unwrap()).unwrap();
        assert_eq!(result["channels"].as_array().unwrap().len(), 2);
        for (key, value) in current.as_object().unwrap() {
            if key != "channels" {
                assert_eq!(&result[key], value);
            }
        }
        for (backup, original) in plan.retained_images.iter().zip(originals) {
            assert_eq!(fs::read(backup.path()).unwrap(), original);
        }
        let journal = base
            .config
            .join("creator-works-mcp/.creator-hub-product-settings");
        let directory = fs::read_dir(journal)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.is_dir())
            .unwrap();
        let report = crate::convergence_recovery::Transaction::open_allowlisted(
            &directory,
            &[
                stores::Store::McpCurrent.path(&base).unwrap(),
                stores::Store::McpLegacy.path(&base).unwrap(),
            ],
        )
        .unwrap()
        .inspect()
        .unwrap();
        assert!(report.completed);
        assert_eq!(report.files.len(), 2);
    }

    #[test]
    #[ignore = "Read-only preview of this machine's two MCP stores; never publishes or creates backups"]
    fn live_project_import_preview_preserves_preferences_and_original_files() {
        let base = roots().unwrap();
        let current = stores::Snapshot::inspect(stores::Store::McpCurrent, &base).unwrap();
        let legacy = stores::Snapshot::inspect(stores::Store::McpLegacy, &base).unwrap();
        let preview =
            merge_project_settings(current.bytes().unwrap(), legacy.bytes().unwrap()).unwrap();
        let before: Value = serde_json::from_slice(current.bytes().unwrap()).unwrap();
        let after: Value = serde_json::from_slice(&preview.bytes).unwrap();
        for (key, value) in before.as_object().unwrap() {
            if key != "channels" {
                assert_eq!(&after[key], value);
            }
        }
        assert!(after["channels"]
            .as_array()
            .unwrap()
            .starts_with(before["channels"].as_array().unwrap()));
        current.recheck().unwrap();
        legacy.recheck().unwrap();
        println!("Read-only import preview: current={}, missing={}, already_present={}; preferences and both original files unchanged",
            before["channels"].as_array().unwrap().len(), preview.added, preview.already_present);
    }

    #[test]
    fn project_import_preserves_current_bytes_when_no_projects_are_missing() {
        let (_temp, base, mut plan) = conflicting_plan();
        let originals = [
            plan.stores[0].bytes().unwrap().to_vec(),
            plan.stores[1].bytes().unwrap().to_vec(),
        ];
        assert!(can_prepare(&plan).is_ok());
        assert!(can_retain(&plan).is_err());
        retain_fixture(&mut plan);
        assert_eq!(import_missing_projects(&mut plan, &base).unwrap(), 0);
        assert!(can_retain(&plan).is_ok());
        let selected = &originals[0];
        for saved in &plan.stores[..2] {
            assert_eq!(saved.bytes(), Some(selected.as_slice()));
            saved.recheck().unwrap();
        }
        for (backup, original) in plan.retained_images.iter().zip(&originals) {
            assert_eq!(fs::read(backup.path()).unwrap(), *original);
            backup.recheck().unwrap();
        }
        let journal = base
            .config
            .join("creator-works-mcp/.creator-hub-product-settings");
        let directory = fs::read_dir(journal)
            .unwrap()
            .map(|p| p.unwrap().path())
            .find(|p| p.is_dir())
            .unwrap();
        let outcome = crate::convergence_recovery::Transaction::open_allowlisted(
            &directory,
            &[
                stores::Store::McpCurrent.path(&base).unwrap(),
                stores::Store::McpLegacy.path(&base).unwrap(),
            ],
        )
        .unwrap()
        .inspect()
        .unwrap();
        assert!(outcome.completed);
        assert!(!plan.report.retirement_available);
        assert!(plan.report.required);
        assert!(import_missing_projects(&mut plan, &base).is_err());
    }

    #[test]
    fn settings_selection_refuses_missing_or_changed_original_backups() {
        for corrupted in [false, true] {
            let (_temp, base, mut plan) = conflicting_plan();
            let originals = [
                plan.stores[0].bytes().unwrap().to_vec(),
                plan.stores[1].bytes().unwrap().to_vec(),
            ];
            if corrupted {
                retain_fixture(&mut plan);
                fs::write(plan.retained_images[1].path(), b"changed backup").unwrap();
            }
            assert!(import_missing_projects(&mut plan, &base).is_err());
            for (saved, original) in plan.stores[..2].iter().zip(originals) {
                assert_eq!(
                    fs::read(saved.store().path(&base).unwrap()).unwrap(),
                    original
                );
            }
        }
    }

    #[test]
    fn settings_selection_refuses_external_edits_and_unknown_operation_outcomes() {
        for index in 0..3 {
            let (_temp, base, mut plan) = conflicting_plan();
            retain_fixture(&mut plan);
            if index == 2 {
                write_outcome(&base, "accepted");
                plan.stores[2] =
                    stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &base).unwrap();
            } else {
                fs::write(
                    plan.stores[index].store().path(&base).unwrap(),
                    b"external edit",
                )
                .unwrap();
            }
            assert!(import_missing_projects(&mut plan, &base).is_err());
            assert!(!base
                .config
                .join("creator-works-mcp/.creator-hub-product-settings")
                .exists());
        }
    }

    #[test]
    fn settings_selection_never_creates_a_missing_legacy_store() {
        let (_temp, base, mut plan) = fixture_plan();
        retain_fixture(&mut plan);
        assert!(import_missing_projects(&mut plan, &base).is_err());
        assert!(!stores::Store::McpLegacy.path(&base).unwrap().exists());
    }

    #[test]
    fn settings_selection_does_not_bypass_a_pending_change_to_either_store() {
        use crate::convergence_recovery::{ReviewedWrite, Transaction};
        for pending in [stores::Store::McpCurrent, stores::Store::McpLegacy] {
            let (_temp, base, mut plan) = conflicting_plan();
            retain_fixture(&mut plan);
            let index = if pending == stores::Store::McpCurrent {
                0
            } else {
                1
            };
            let journal = base
                .config
                .join("creator-works-mcp/.creator-hub-product-settings");
            Transaction::prepare(
                &journal,
                vec![ReviewedWrite::new(
                    "Pending test save",
                    &pending.path(&base).unwrap(),
                    plan.stores[index].bytes().unwrap(),
                    br#"{"channels":[],"auto_start":false}"#,
                )],
            )
            .unwrap();
            assert!(import_missing_projects(&mut plan, &base)
                .unwrap_err()
                .contains("recovery review"));
            for snapshot in &plan.stores {
                snapshot.recheck().unwrap();
            }
        }
    }

    #[test]
    fn settings_selection_reserves_history_capacity_for_the_following_server_transition() {
        use crate::convergence_recovery::{ReviewedWrite, Transaction};
        let (_temp, base, mut plan) = conflicting_plan();
        let path = stores::Store::McpCurrent.path(&base).unwrap();
        let journal = base
            .config
            .join("creator-works-mcp/.creator-hub-product-settings");
        for index in 0..31 {
            let before = fs::read(&path).unwrap();
            let after = serde_json::to_vec(&json!({"channels":[],"auto_start":false,"save":index}))
                .unwrap();
            assert!(
                Transaction::prepare(
                    &journal,
                    vec![ReviewedWrite::new(
                        "Completed fixture save",
                        &path,
                        &before,
                        &after
                    )]
                )
                .unwrap()
                .resume(|_| true)
                .unwrap()
                .completed
            );
            if index == 29 {
                assert!(check_settings_recovery(&base).is_ok());
            }
        }
        plan.stores[0] = stores::Snapshot::inspect(stores::Store::McpCurrent, &base).unwrap();
        retain_fixture(&mut plan);
        assert!(import_missing_projects(&mut plan, &base)
            .unwrap_err()
            .contains("history is full"));
        for snapshot in &plan.stores {
            snapshot.recheck().unwrap();
        }
        assert_eq!(
            fs::read_dir(journal)
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().path().is_dir())
                .count(),
            31
        );
    }

    #[test]
    fn no_retirement_completion_rechecks_after_native_approval_and_keeps_data() {
        let (_temp, _base, mut plan) = fixture_plan();
        plan.report.stage = "connections-reviewed";
        plan.report.retirement_available = true;
        let before = plan.stores[0].bytes().unwrap().to_vec();
        let checks = std::cell::Cell::new(0);
        let result = finish_without_retirement(
            &mut plan,
            |plan| {
                checks.set(checks.get() + 1);
                can_retain(plan)?;
                require_no_retirement(plan, &[])
            },
            || {
                assert_eq!(checks.get(), 1);
                true
            },
        )
        .unwrap();
        assert_eq!(checks.get(), 2);
        assert_eq!(result.stage, "complete");
        assert!(!result.required);
        assert!(!result.retirement_available);
        assert_eq!(plan.stores[0].bytes().unwrap(), before);
        plan.stores[0].recheck().unwrap();
        assert!(result
            .message
            .contains("No standalone installation was removed"));
    }

    #[test]
    fn no_retirement_completion_cancellation_and_post_approval_drift_stay_pending() {
        for approve in [false, true] {
            let (_temp, base, mut plan) = fixture_plan();
            plan.report.stage = "connections-reviewed";
            plan.report.retirement_available = true;
            let original = plan.stores[0].bytes().unwrap().to_vec();
            let file = stores::Store::McpCurrent.path(&base).unwrap();
            let checks = std::cell::Cell::new(0);
            let result = finish_without_retirement(
                &mut plan,
                |plan| {
                    checks.set(checks.get() + 1);
                    can_retain(plan)?;
                    require_no_retirement(plan, &[])
                },
                || {
                    if approve {
                        fs::write(&file, b"changed during approval").unwrap();
                    }
                    approve
                },
            );
            assert!(result.is_err());
            assert_eq!(checks.get(), if approve { 2 } else { 1 });
            assert_eq!(plan.report.stage, "connections-reviewed");
            assert!(plan.report.required);
            if !approve {
                assert_eq!(fs::read(file).unwrap(), original);
            }
        }
    }

    #[test]
    fn existing_or_new_standalone_apps_cannot_use_no_retirement_completion() {
        for (reviewed, current) in [(true, false), (false, true), (true, true)] {
            let (_temp, _base, mut plan) = fixture_plan();
            plan.report.stage = "connections-reviewed";
            plan.report.retirement_available = true;
            let app = || LegacyApp {
                name: "Creator Works MCP".into(),
                path: PathBuf::from("/usr/bin/creator-works-mcp-launcher"),
            };
            if reviewed {
                plan.report.legacy_apps.push(app());
            }
            let current = if current { vec![app()] } else { vec![] };
            assert!(finish_without_retirement(
                &mut plan,
                |plan| { require_no_retirement(plan, &current) },
                || panic!("An existing app must refuse before native approval")
            )
            .is_err());
            assert_eq!(plan.report.stage, "connections-reviewed");
            assert!(plan.report.required);
        }
    }

    fn write_outcome(roots: &stores::Roots, outcome: &str) {
        let path = stores::Store::McpHostedOutcomes.path(roots).unwrap();
        fs::write(path, serde_json::to_vec(&json!({"revision":1,"records":[{
            "session":"a".repeat(64),"id":1,"command":"review_existing_client_connections","outcome":outcome
        }]})).unwrap()).unwrap();
    }

    #[test]
    fn reminder_key_changes_for_settings_apps_cleanup_and_uncertain_outcomes_only() {
        let (_temp, base, mut plan) = fixture_plan();
        let key = prompt_review_key(&plan.stores, &[], false).unwrap();
        assert_eq!(key.len(), 64);
        assert_eq!(key, prompt_review_key(&plan.stores, &[], false).unwrap());
        write_outcome(&base, "returned-ok");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &base).unwrap();
        assert_eq!(key, prompt_review_key(&plan.stores, &[], false).unwrap());
        write_outcome(&base, "accepted");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &base).unwrap();
        assert_ne!(key, prompt_review_key(&plan.stores, &[], false).unwrap());
        write_outcome(&base, "returned-ok");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &base).unwrap();
        assert_ne!(key, prompt_review_key(&plan.stores, &[], true).unwrap());
        let app = LegacyApp {
            name: "Creator Works MCP".into(),
            path: base.local_data.join("launcher.exe"),
        };
        assert_ne!(key, prompt_review_key(&plan.stores, &[app], false).unwrap());
        let legacy = stores::Store::McpLegacy.path(&base).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, br#"{"channels":[],"auto_start":true}"#).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &base).unwrap();
        assert_ne!(key, prompt_review_key(&plan.stores, &[], false).unwrap());
        assert!(can_retain(&plan).unwrap_err().contains("settings differ"));
    }

    #[test]
    fn verified_hub_settings_do_not_become_legacy_merely_after_a_save() {
        let (temp, base, mut plan) = fixture_plan();
        let server = temp.path().join("verified-runtime/creator-works-mcp.mjs");
        assert!(!settings_use_verified_runtime(&plan.stores, &server));
        let file = stores::Store::McpCurrent.path(&base).unwrap();
        let body = serde_json::to_vec(&json!({"channels":[],"auto_start":false,"mcp_server_path":server,"unknown":"preserve"})).unwrap();
        fs::write(&file, &body).unwrap();
        plan.stores[0] = stores::Snapshot::inspect(stores::Store::McpCurrent, &base).unwrap();
        assert!(settings_use_verified_runtime(&plan.stores, &server));
        assert!(
            !server.exists(),
            "The pure comparison must not open any configured server file"
        );
        assert!(!settings_use_verified_runtime(
            &plan.stores,
            &temp.path().join("foreign.mjs")
        ));
        let legacy = stores::Store::McpLegacy.path(&base).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, &body).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &base).unwrap();
        assert!(settings_use_verified_runtime(&plan.stores, &server));
        fs::write(&legacy, br#"{"channels":[],"auto_start":true}"#).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &base).unwrap();
        assert!(!settings_use_verified_runtime(&plan.stores, &server));
        plan.stores[1] = stores::Snapshot::inspect(
            stores::Store::McpLegacy,
            &stores::Roots {
                config: temp.path().join("absent"),
                local_data: base.local_data.clone(),
            },
        )
        .unwrap();
        write_outcome(&base, "accepted");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &base).unwrap();
        assert!(!settings_use_verified_runtime(&plan.stores, &server));
        assert_eq!(fs::read(file).unwrap(), body);
    }

    #[test]
    fn owned_settings_still_cannot_skip_existing_or_interrupted_app_retirement() {
        assert!(!migration_required(0, 2, true, false));
        assert!(migration_required(1, 2, true, false));
        assert!(migration_required(0, 2, true, true));
    }

    #[test]
    fn review_keeps_approved_legacy_image_but_not_new_edits_or_pending_outcomes() {
        let (_temp, roots, mut plan) = fixture_plan();
        let review = roots.config.join("review.json");
        let legacy = stores::Store::McpLegacy.path(&roots).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, plan.stores[0].bytes().unwrap()).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &roots).unwrap();
        save_review_at(&review, &plan.stores).unwrap();
        assert!(reviewed_snapshots_at(&review, &plan.stores).unwrap());
        let current = stores::Store::McpCurrent.path(&roots).unwrap();
        fs::write(&current, br#"{"channels":[],"auto_start":false,"futureOption":"kept","mcp_server_path":"C:/verified/runtime.mjs"}"#).unwrap();
        plan.stores[0] = stores::Snapshot::inspect(stores::Store::McpCurrent, &roots).unwrap();
        // Migration changes the active path while keeping its original image.
        assert!(settings_need_review(&plan.stores));
        assert!(reviewed_snapshots_at(&review, &plan.stores).unwrap());
        let original_legacy = fs::read(&legacy).unwrap();
        fs::write(&legacy, br#"{"channels":[],"auto_start":true}"#).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &roots).unwrap();
        assert!(!reviewed_snapshots_at(&review, &plan.stores).unwrap());
        fs::write(&legacy, &original_legacy).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &roots).unwrap();
        write_outcome(&roots, "accepted");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &roots).unwrap();
        assert!(!reviewed_snapshots_at(&review, &plan.stores).unwrap());
        let review_bytes = fs::read(&review).unwrap();
        assert!(save_review_at(&review, &plan.stores).is_err());
        assert_eq!(fs::read(&review).unwrap(), review_bytes);
        write_outcome(&roots, "returned-ok");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &roots).unwrap();
        assert!(reviewed_snapshots_at(&review, &plan.stores).unwrap());
        assert!(!migration_required(
            0,
            3,
            reviewed_snapshots_at(&review, &plan.stores).unwrap(),
            false
        ));
        fs::remove_file(&legacy).unwrap();
        plan.stores[1] = stores::Snapshot::inspect(stores::Store::McpLegacy, &roots).unwrap();
        assert!(!reviewed_snapshots_at(&review, &plan.stores).unwrap());
    }

    #[test]
    fn server_transition_renews_only_the_native_reviewed_field() {
        let (_temp, base, mut plan) = fixture_plan();
        let server = base.local_data.join("verified/server.mjs");
        let path = stores::Store::McpCurrent.path(&base).unwrap();
        let mut value: Value = serde_json::from_slice(plan.stores[0].bytes().unwrap()).unwrap();
        value["mcp_server_path"] = json!(server);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        refresh_reviewed_server_paths(
            &mut plan,
            &base,
            &server,
            &json!({"changed":true,"server":server}),
        )
        .unwrap();
        assert!(recheck_durable_settings(&plan).is_ok());
        value["auto_start"] = json!(true);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(refresh_reviewed_server_paths(
            &mut plan,
            &base,
            &server,
            &json!({"changed":true,"server":server})
        )
        .is_err());
        assert!(recheck_durable_settings(&plan).is_err());
    }

    #[test]
    fn cleanup_keeps_original_backups_bound_after_reviewed_server_transition() {
        let (_temp, base, mut plan) = fixture_plan();
        let backup = plan.stores[0].retain_reviewed().unwrap();
        let before_image = backup.path().to_path_buf();
        let original = fs::read(&before_image).unwrap();
        plan.retained_images.push(backup);
        assert!(can_retain(&plan).is_ok());
        let server = base.local_data.join("verified/server.mjs");
        let live = stores::Store::McpCurrent.path(&base).unwrap();
        let mut value: Value = serde_json::from_slice(plan.stores[0].bytes().unwrap()).unwrap();
        value["mcp_server_path"] = json!(server);
        fs::write(&live, serde_json::to_vec(&value).unwrap()).unwrap();
        refresh_reviewed_server_paths(
            &mut plan,
            &base,
            &server,
            &json!({"changed":true,"server":server}),
        )
        .unwrap();
        assert!(can_retain(&plan).is_ok());
        assert_eq!(fs::read(&before_image).unwrap(), original);
        fs::write(&before_image, b"changed before-image").unwrap();
        assert!(can_retain(&plan).is_err());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&live).unwrap()).unwrap(),
            value
        );
        fs::remove_file(&before_image).unwrap();
        assert!(can_retain(&plan).is_err());
        assert!(!before_image.exists());
    }

    #[test]
    fn missing_backup_refuses_finished_journal_refresh_before_review_publication() {
        let (_temp, base, mut plan) = fixture_plan();
        let backup = plan.stores[0].retain_reviewed().unwrap();
        let image = backup.path().to_path_buf();
        plan.retained_images.push(backup);
        write_outcome(&base, "returned-ok");
        fs::remove_file(&image).unwrap();
        assert!(recheck_durable_settings(&plan).is_err());
        assert!(refresh_finished_outcome_journal(&mut plan, &base).is_err());
        assert!(recheck(&plan).is_err());
        assert!(!image.exists());
    }

    #[test]
    fn unverified_server_transition_cannot_renew_any_snapshot() {
        let (_temp, base, mut plan) = fixture_plan();
        let server = base.local_data.join("verified/server.mjs");
        for response in [
            Value::Null,
            json!({"changed":true}),
            json!({"changed":true,"server":"elsewhere"}),
        ] {
            assert!(refresh_reviewed_server_paths(&mut plan, &base, &server, &response).is_err());
        }
        let path = stores::Store::McpCurrent.path(&base).unwrap();
        let mut value: Value = serde_json::from_slice(plan.stores[0].bytes().unwrap()).unwrap();
        value["mcp_server_path"] = json!(server);
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(refresh_reviewed_server_paths(
            &mut plan,
            &base,
            &server,
            &json!({"changed":false,"server":server})
        )
        .is_err());
    }

    #[test]
    fn known_cancelled_attempt_can_retry_without_renewing_user_settings() {
        let (_temp, base, mut plan) = fixture_plan();
        assert!(can_retain(&plan).is_ok());
        plan.retry_allowed = false;
        write_outcome(&base, "returned-error");
        assert!(can_retain(&plan).is_err());
        refresh_finished_outcome_journal(&mut plan, &base).unwrap();
        assert!(can_retain(&plan).is_ok());
        let path = stores::Store::McpCurrent.path(&base).unwrap();
        fs::write(
            path,
            br#"{"channels":[],"auto_start":true,"futureOption":"external-edit"}"#,
        )
        .unwrap();
        assert!(refresh_finished_outcome_journal(&mut plan, &base).is_err());
        assert!(can_retain(&plan).is_err());
    }

    #[test]
    fn unknown_attempt_journal_never_enables_retry_or_replays_operation() {
        for outcome in ["accepted", "unknown-acknowledged"] {
            let (_temp, base, mut plan) = fixture_plan();
            plan.retry_allowed = false;
            write_outcome(&base, outcome);
            assert!(refresh_finished_outcome_journal(&mut plan, &base).is_err());
            assert!(!plan.retry_allowed);
            assert!(can_retain(&plan).is_err());
        }
    }

    #[test]
    fn future_review_record_is_preserved_even_at_final_publication_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("future.json");
        let bytes = br#"{"policy":2,"stores_retained":true,"connections_reviewed":true,"standalone_removal_accepted":false}"#;
        fs::write(&path, bytes).unwrap();
        assert!(save_review_at(&path, &[]).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let fresh = temp.path().join("current.json");
        save_review_at(&fresh, &[]).unwrap();
        assert!(reviewed_at(&fresh).unwrap());
    }

    fn client_inventory() -> Value {
        json!({"clients":CLIENTS.map(|id| json!({"id":id,"supported":true,"issue":null,"configured":false,"detected":false}))})
    }

    #[test]
    fn inspect_clients_does_not_treat_presence_or_detected_labels_as_route_proof() {
        let status = client_inventory();
        assert_eq!(supported_clients(&status).unwrap().len(), 5);
        let mut duplicate = status.clone();
        duplicate["clients"][4]["id"] = json!("codex");
        assert!(supported_clients(&duplicate).is_err());
        let mut unreadable = status;
        unreadable["clients"][0]["issue"] = json!("unreadable settings");
        assert!(supported_clients(&unreadable).is_err());
        assert!(supported_clients(&json!({"clients":[]})).is_err());
    }

    #[test]
    fn unsupported_client_never_silently_disappears_from_removal_checks() {
        let mut status = client_inventory();
        status["clients"][0]["supported"] = json!(false);
        assert!(supported_clients(&status).is_err());
    }

    #[test]
    fn unknown_cancelled_or_incomplete_batches_cannot_advance_adoption() {
        for value in [
            Value::Null,
            json!({"status":"cancelled","count":0}),
            json!({"status":"migrated"}),
            json!({"status":"migrated","count":6}),
        ] {
            assert!(accepted_batch(&value).is_err());
        }
        assert!(accepted_batch(&json!({"status":"unchanged","count":0})).is_ok());
    }

    #[test]
    fn recovery_requires_known_empty_result_not_missing_or_opaque_status() {
        assert!(require_no_recovery(&json!([])).is_ok());
        for value in [
            Value::Null,
            json!({"completed":true}),
            json!([{"canResume":true}]),
        ] {
            assert!(require_no_recovery(&value).is_err());
        }
    }

    #[test]
    fn product_settings_conflict_and_uncertain_recovery_block_client_changes() {
        for value in [
            Value::Null,
            json!({"status":"current"}),
            json!({"status":"conflict","recovery":[]}),
            json!({"status":"current","recovery":[{"completed":false,"historical_completed":false}]}),
            json!({"status":"future-format","recovery":[]}),
        ] {
            assert!(require_product_settings_review(&value).is_err());
        }
        assert!(
            require_product_settings_review(&json!({"status":"current","recovery":[]})).is_ok()
        );
        assert!(require_product_settings_review(&json!({"status":"current","recovery":[{"completed":false,"historical_completed":true}]})).is_ok());
    }

    #[test]
    fn durable_review_never_grants_app_removal_or_downgrades_unknown_policy() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("review.json");
        assert!(!reviewed_at(&path).unwrap());
        for policy in [0, 2] {
            fs::write(
                &path,
                serde_json::to_vec(&ReviewRecord {
                    policy,
                    stores_retained: true,
                    connections_reviewed: true,
                    standalone_removal_accepted: false,
                    retained_legacy_sha256: None,
                })
                .unwrap(),
            )
            .unwrap();
            assert!(reviewed_at(&path).is_err());
        }
        fs::write(&path, br#"{"policy":1,"stores_retained":true,"connections_reviewed":true,"standalone_removal_accepted":true}"#).unwrap();
        assert!(reviewed_at(&path).is_err());
        fs::write(&path, br#"{"policy":1,"stores_retained":true,"connections_reviewed":true,"standalone_removal_accepted":false}"#).unwrap();
        assert!(reviewed_at(&path).unwrap());
    }
}
