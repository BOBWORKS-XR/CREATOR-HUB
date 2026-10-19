//! First-launch adoption of retained Creator stores. Removal has a separate
//! native provenance/retention gate; a backup or presence label cannot pass it.
#[path = "../../native/convergence-store.rs"]
mod stores;

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
    enabled: bool,
    required: bool,
    stage: &'static str,
    settings: Vec<&'static str>,
    legacy_apps: Vec<LegacyApp>,
    backups: Vec<PathBuf>,
    retirement_available: bool,
    message: String,
    review_key: Option<String>,
}

struct Plan {
    stores: Vec<stores::Snapshot>,
    retained_images: Vec<stores::Backup>,
    report: Report,
    retry_allowed: bool,
    #[cfg(windows)]
    retirement_dependencies: Option<crate::convergence_dependencies::GuiRetirementSnapshot>,
    #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
    retirement_linux: Option<crate::convergence_linux::Plan>,
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

fn inspect() -> Result<Plan, String> {
    let mut snapshots = Vec::new();
    let mut settings = Vec::new();
    let base = roots()?;
    for store in stores::STORES {
        let snapshot = stores::Snapshot::inspect(store, &base)?;
        if snapshot.bytes().is_some() {
            settings.push(label(store));
        }
        snapshots.push(snapshot);
    }
    let legacy_apps = legacy_apps()?;
    // Validate even when legacy apps exist; do not short-circuit a newer policy.
    let already_reviewed = reviewed_snapshots_at(&record_path()?, &snapshots)?;
    let pending_retirement = retirement_pending()?;
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
    Ok(Plan {
        stores: snapshots,
        retained_images: Vec::new(),
        retry_allowed: true,
        #[cfg(windows)]
        retirement_dependencies: None,
        #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
        retirement_linux: None,
        report: Report {
            enabled: true,
            required,
            stage: "review",
            settings,
            legacy_apps,
            backups: vec![],
            retirement_available: false,
            review_key: Some(review_key),
            message: if pending_retirement {
                "An earlier standalone-app cleanup was interrupted. Review fresh backups and connections before resuming; no saved operation is replayed."
            } else if already_using_hub {
                "Your MCP settings already use Hub's verified runtime. No standalone apps were found."
            } else {
                "Hub can take over your existing settings without moving your Unity projects. Old apps stay installed until connection and retirement checks pass."
            }.into(),
        },
    })
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
    if crate::hosted::preview_mode(AppId::Mcp) != Some("writable") {
        return Err(
            "This Hub cannot take over writable MCP settings yet. Old apps were kept.".into(),
        );
    }
    if !crate::usage_terms::usage_terms_status()? {
        return Err("Review Hub's terms before migrating existing apps.".into());
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

fn can_retain(plan: &Plan) -> Result<(), String> {
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
    let current = plan.stores[0].bytes();
    let legacy = plan.stores[1].bytes();
    if matches!((current, legacy), (Some(a), Some(b)) if a != b) {
        return Err("Current and earlier MCP settings differ. Both were kept; review which setup to use before migration.".into());
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
        can_retain(plan)?;
        let approved = handle.dialog().message(
            "Let Creator Hub use your existing MCP and Project Setup settings?\n\nHub will ask verified idle standalone app windows to close normally, then keep exact local backups. Busy or unverified apps are not force-closed. AI clients, Unity and Node connections stay open.\n\nSettings remain in their current locations; Unity projects are not moved or edited. Existing AI connections are reviewed separately before changing them. No standalone installation is removed by this step. Cancel leaves the current setup unchanged."
        ).title("Move to unified Creator Hub").kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Back up and continue".into(), "Keep existing".into())).blocking_show();
        if !approved {
            return Err("Migration was cancelled. Existing apps and settings were kept.".into());
        }
        can_retain(plan)?;
        close_reviewed_guis(plan)?;
        can_retain(plan)?;
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
        plan.report.stage = "backed-up";
        plan.report.message = "Exact settings backups are verified. Next, review existing AI connections. Old apps have not been removed.".into();
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
            #[cfg(windows)]
            retirement_dependencies: None,
            #[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]
            retirement_linux: None,
            report: Report {
                enabled: true,
                required: true,
                stage: "backed-up",
                settings: vec![],
                legacy_apps: vec![],
                backups: vec![],
                retirement_available: false,
                message: String::new(),
                review_key: None,
            },
        };
        (temp, roots, plan)
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
