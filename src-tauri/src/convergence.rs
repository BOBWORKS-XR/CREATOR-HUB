//! First-launch adoption of retained Creator stores. Removal has a separate
//! native provenance/retention gate; a backup or presence label cannot pass it.
#[path = "../../native/convergence-store.rs"]
mod stores;

use crate::{builtin, catalog::AppId, hosted::Hosting, manager, platform};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
    message: String,
}

struct Plan {
    stores: Vec<stores::Snapshot>,
    report: Report,
    retry_allowed: bool,
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
}

fn record_path() -> Result<PathBuf, String> {
    Ok(manager::child_dir("convergence")?.join("review-v1.json"))
}

fn reviewed_at(path: &std::path::Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("Cannot inspect Hub's retained migration review.".into()),
        Ok(_) => {}
    }
    let saved: ReviewRecord = serde_json::from_slice(&manager::bounded_read(path, 2048)?)
        .map_err(|_| "The migration review needs inspection; old apps were kept.")?;
    if saved.policy != POLICY || saved.standalone_removal_accepted {
        return Err("Unknown migration review; old apps were kept.".into());
    }
    Ok(saved.stores_retained && saved.connections_reviewed)
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
    let already_reviewed = reviewed_at(&record_path()?)?;
    let required = !legacy_apps.is_empty() || (!settings.is_empty() && !already_reviewed);
    Ok(Plan {
        stores: snapshots,
        retry_allowed: true,
        report: Report {
            enabled: true,
            required,
            stage: "review",
            settings,
            legacy_apps,
            backups: vec![],
            message: "Hub can take over your existing settings without moving your Unity projects. Old apps stay installed until connection and removal checks pass.".into(),
        },
    })
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
    Ok(())
}

fn can_retain(plan: &Plan) -> Result<(), String> {
    if !plan.retry_allowed {
        return Err("The previous migration did not finish its workflow and backend exit checks. Keep original apps and review recovery before retrying.".into());
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

fn save_review_at(path: &std::path::Path) -> Result<(), String> {
    reviewed_at(path)?;
    manager::atomic_write(
        path,
        &serde_json::to_vec(&ReviewRecord {
            policy: POLICY,
            stores_retained: true,
            connections_reviewed: true,
            standalone_removal_accepted: false,
        })
        .map_err(|_| "Cannot record migration review.")?,
    )?;
    if !reviewed_at(path)? {
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
            "Let Creator Hub use your existing MCP and Project Setup settings?\n\nExact local backups will be kept. Settings remain in their current locations; Unity projects are not moved or edited. Existing AI connections are reviewed separately before changing them.\n\nNo standalone app, AI client or Unity process is stopped or removed by this step. Cancel leaves the current setup unchanged."
        ).title("Move to unified Creator Hub").kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Back up and continue".into(), "Keep existing".into())).blocking_show();
        if !approved {
            return Err("Migration was cancelled. Existing apps and settings were kept.".into());
        }
        can_retain(plan)?;
        let mut backups = Vec::new();
        for snapshot in &plan.stores {
            if snapshot.bytes().is_some() {
                let backup = snapshot.retain_reviewed()?;
                if snapshot.store() != stores::Store::McpHostedOutcomes {
                    // Adoption uses the same exact store, not a second settings
                    // copy that could drift from the standalone before-image.
                    stores::validate_import(snapshot, &backup, snapshot.bytes(), snapshot.bytes().unwrap())?;
                }
                backups.push(backup.path().to_path_buf());
            }
        }
        recheck(plan)?;
        plan.report.backups = backups;
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
        let session = {
            let _operation = manager.begin()?;
            let candidate = builtin::hosting_candidate(&handle, AppId::Mcp)?
                .ok_or("Verified built-in MCP is unavailable. Old apps were kept.")?;
            let result = hosting.start_verified(
                &handle,
                AppId::Mcp,
                &candidate.path,
                &candidate.hash,
                true,
            )?;
            if result["effectiveMode"] != "writable" {
                return Err("MCP did not admit writable migration; old apps were kept.".into());
            }
            result["session"]
                .as_str()
                .ok_or("MCP returned no migration session.")?
                .to_owned()
        };
        // Own only this temporary backend. Do not close any restored/user view.
        plan.retry_allowed = false;
        let mut workflow_finished = false;
        let transfer = (|| {
            let workflow = hosting.call(&manager, &session, "begin_ui_operation", json!({}))?;
            let operation = (|| {
                require_product_settings_review(&hosting.call(
                    &manager,
                    &session,
                    "product_settings_status",
                    json!({}),
                )?)?;
                require_no_recovery(&hosting.call(
                    &manager,
                    &session,
                    "pending_client_recovery",
                    json!({}),
                )?)?;
                let status = hosting.call(
                    &manager,
                    &session,
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
                accepted_batch(&hosting.call(
                    &manager,
                    &session,
                    "review_existing_client_connections",
                    json!({"clients":clients}),
                )?)?;
                require_no_recovery(&hosting.call(
                    &manager,
                    &session,
                    "pending_client_recovery",
                    json!({}),
                )?)?;
                require_product_settings_review(&hosting.call(
                    &manager,
                    &session,
                    "product_settings_status",
                    json!({}),
                )?)?;
                let store = creator_hub_mcp_router::Store::installed()?;
                let runtime = store.resolve()?;
                let _router = store.router()?;
                recheck_durable_settings(plan)?;
                let transition =
                    hosting.call(&manager, &session, "review_convergence_server", json!({}))?;
                refresh_reviewed_server_paths(plan, &roots()?, &runtime.server, &transition)?;
                Ok::<_, String>(())
            })();
            let finish = hosting.call(
                &manager,
                &session,
                "finish_ui_operation",
                json!({"id":workflow}),
            );
            workflow_finished = finish.is_ok();
            operation?;
            finish?;
            Ok::<_, String>(())
        })();
        let close = manager.begin().and_then(|_operation| {
            hosting.stop_owned_and_wait(&session, std::time::Duration::from_secs(10))
        });
        // Cancel also records a returned outcome. Refresh only the owned journal
        // after observed exit, never the user's project selection/options.
        if workflow_finished && close.is_ok() {
            refresh_finished_outcome_journal(plan, &roots()?)?;
        }
        transfer?;
        close?;
        // Review is not live-client acceptance or permission to uninstall.
        save_review_at(&record_path()?)?;
        plan.report.stage = "connections-reviewed";
        plan.report.message = removal_diagnostics(plan, &manager).unwrap_or_else(|reason| {
            format!("Connections are reviewed; old apps were kept. Removal check paused: {reason}")
        });
        Ok(plan.report.clone())
    })
    .await
    .map_err(|_| {
        "Migration outcome is unknown. Keep original apps and retained recovery records."
    })?
}

fn removal_diagnostics(plan: &Plan, manager: &manager::Manager) -> Result<String, String> {
    let _operation = manager.begin()?;
    recheck(plan)?;
    if plan.report.legacy_apps.is_empty() {
        return Ok("Settings and existing connections are reviewed. No standalone app was found to remove. Native connection acceptance remains a separate release check.".into());
    }
    #[cfg(windows)]
    {
        let installations = crate::legacy_removal_windows::inspect()?;
        if installations.len() != plan.report.legacy_apps.len() {
            return Err("Existing app locations changed; removal remains paused.".into());
        }
        for installation in &installations {
            installation.recheck()?;
        }
        let roots: Vec<_> = installations
            .iter()
            .map(|app| app.root().to_path_buf())
            .collect();
        let store = creator_hub_mcp_router::Store::installed()?;
        let _runtime = store.resolve()?;
        let router = store.router()?;
        let dependencies = crate::convergence_dependencies::snapshot(&roots, &router.command);
        let report = dependencies.report();
        if report.requires_retention {
            return Ok(format!("Old apps were kept. Removal checks found {} dependency blockers and {} unresolved configuration scopes. Custom/project client contexts must be reviewed before cleanup; names and installed status cannot prove it safe.", report.blockers.len(), report.inventory.unresolved.len()));
        }
        dependencies
            .recheck()
            .map_err(|_| "Client settings changed during the removal check; old apps were kept.")?;
        Ok("Removal dependencies passed this inspection. Old apps were kept pending the complete native removal and connection acceptance flow.".into())
    }
    #[cfg(not(windows))]
    Ok("Settings and existing connections are reviewed. Old apps were kept: native removal and connection acceptance are not completed on this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            retry_allowed: true,
            report: Report {
                enabled: true,
                required: true,
                stage: "backed-up",
                settings: vec![],
                legacy_apps: vec![],
                backups: vec![],
                message: String::new(),
            },
        };
        (temp, roots, plan)
    }

    fn write_outcome(roots: &stores::Roots, outcome: &str) {
        let path = stores::Store::McpHostedOutcomes.path(roots).unwrap();
        fs::write(path, serde_json::to_vec(&json!({"revision":1,"records":[{
            "session":"a".repeat(64),"id":1,"command":"review_existing_client_connections","outcome":outcome
        }]})).unwrap()).unwrap();
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
        assert!(save_review_at(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let fresh = temp.path().join("current.json");
        save_review_at(&fresh).unwrap();
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
