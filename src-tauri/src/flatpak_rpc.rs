//! Typed calls for the native Flatpak Core. This module does not authenticate a
//! peer or expose a listener; the owned GUI transport must admit each message
//! before decoding it. All operations retain their existing native handlers.
use crate::catalog::AppId;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

const MAX_REQUEST: usize = 64 * 1024;

// Integrated pages belong to the native Hub window. The abandoned sandboxed-GUI
// relay does not acquire new feature or settings authority.
#[cfg(test)]
const NATIVE_WINDOW_ONLY: &[&str] = &[
    "feature_status",
    "feature_select",
    "feature_call",
    "move_to_hub",
    "inspect_convergence_outcome",
    "hub_update_recovery_status",
    "review_retained_hub_update",
];

pub(super) const EVENTS: &[&str] = &[
    "app-progress",
    "close-blocked",
    "hosted-app-event",
    "hosted-app-disconnected",
    "hosted-apps-suspended",
    "hub-launch-view",
];

pub(super) fn event_payload(name: &str, payload: &str) -> Result<Value, &'static str> {
    if !EVENTS.contains(&name) || payload.is_empty() || payload.len() > 2 * 1024 * 1024 {
        return Err("Unsupported native Hub event.");
    }
    serde_json::from_str(payload).map_err(|_| "Invalid native Hub event payload.")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

#[derive(Deserialize)]
#[serde(
    tag = "command",
    content = "args",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(super) enum Invocation {
    UsageTermsStatus(Empty),
    AcceptUsageTerms {
        #[serde(rename = "policyVersion")]
        policy_version: String,
        accepted: bool,
    },
    HubPreferencesStatus(Empty),
    SetHubPreference {
        key: crate::preferences::PreferenceKey,
        value: bool,
    },
    ConvergenceStatus(Empty),
    RefreshConvergence(Empty),
    PrepareConvergence(Empty),
    MigrateConvergenceConnections(Empty),
    RetireConvergenceApps(Empty),
    OpenResource {
        resource: String,
    },
    CommunityImportStatus {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    CommunityTransferStatus(Empty),
    CancelCommunityTransfer {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    AppInventory {
        check: bool,
        preview: bool,
    },
    DownloadApp {
        app: AppId,
        version: String,
    },
    InstallApp {
        app: AppId,
        version: String,
        reopen: bool,
        #[serde(rename = "closeRunning")]
        close_running: bool,
    },
    DisconnectMcp(Empty),
    OpenApp {
        app: AppId,
    },
    CancelDownload(Empty),
    UseExistingApp {
        app: AppId,
        path: Option<PathBuf>,
    },
    HubUpdateStatus {
        online: bool,
        preview: bool,
    },
    DownloadHubUpdate {
        version: String,
    },
    InstallHubUpdate {
        version: String,
        #[serde(rename = "restoreViews")]
        restore_views: bool,
    },
    PendingHostedRestore(Empty),
    RestoreHostedApp {
        app: AppId,
    },
    CompleteHostedRestore {
        app: AppId,
    },
    ProjectInventory(Empty),
    AddProjectFolder(Empty),
    RemoveProjectFolder {
        id: String,
    },
    OpenUnityProject {
        id: String,
    },
    GetLaunchRequest(Empty),
    StartHostedApp {
        app: AppId,
    },
    HostedAppCall {
        session: String,
        command: String,
        args: Value,
    },
    StopHostedApp {
        session: String,
    },
    AbortHostedApp {
        session: String,
    },
}

pub(super) fn decode(bytes: &[u8]) -> Result<Invocation, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_REQUEST {
        return Err("Invalid native Hub request size.");
    }
    serde_json::from_slice(bytes).map_err(|_| "Unsupported native Hub request.")
}

fn encode<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
    serde_json::to_value(result?).map_err(|_| "Could not encode the native Hub response.".into())
}

pub(super) async fn execute(
    handle: tauri::AppHandle,
    request: Invocation,
) -> Result<Value, String> {
    use Invocation::*;
    match request {
        UsageTermsStatus(_) => encode(crate::usage_terms::usage_terms_status()),
        AcceptUsageTerms {
            policy_version,
            accepted,
        } => encode(crate::usage_terms::accept_usage_terms(
            policy_version,
            accepted,
        )),
        HubPreferencesStatus(_) => encode(crate::preferences::hub_preferences_status()),
        SetHubPreference { key, value } => {
            encode(crate::preferences::set_hub_preference(key, value))
        }
        ConvergenceStatus(_) => encode(crate::convergence::convergence_status(handle).await),
        RefreshConvergence(_) => encode(crate::convergence::refresh_convergence(handle).await),
        PrepareConvergence(_) => encode(crate::convergence::prepare_convergence(handle).await),
        MigrateConvergenceConnections(_) => {
            encode(crate::convergence::migrate_convergence_connections(handle).await)
        }
        RetireConvergenceApps(_) => {
            encode(crate::convergence::retire_convergence_apps(handle).await)
        }
        OpenResource { resource } => encode(crate::open_resource(resource)),
        CommunityImportStatus {
            project_id,
            request_id,
        } => encode(crate::community_import_status(handle, project_id, request_id).await),
        CommunityTransferStatus(_) => encode(crate::community_transfer_status(handle)),
        CancelCommunityTransfer { operation_id } => {
            encode(crate::cancel_community_transfer(handle, operation_id))
        }
        AppInventory { check, preview } => {
            encode(crate::app_inventory(handle, check, preview).await)
        }
        DownloadApp { app, version } => encode(crate::download_app(handle, app, version).await),
        InstallApp {
            app,
            version,
            reopen,
            close_running,
        } => encode(crate::install_app(handle, app, version, reopen, close_running).await),
        DisconnectMcp(_) => encode(crate::disconnect_mcp(handle).await),
        OpenApp { app } => encode(crate::open_app(handle, app).await),
        CancelDownload(_) => {
            crate::cancel_download(handle);
            Ok(Value::Null)
        }
        UseExistingApp { app, path } => encode(crate::use_existing_app(handle, app, path).await),
        HubUpdateStatus { online, preview } => {
            encode(crate::self_update::hub_update_status(handle, online, preview).await)
        }
        DownloadHubUpdate { version } => {
            encode(crate::self_update::download_hub_update(handle, version).await)
        }
        InstallHubUpdate {
            version,
            restore_views,
        } => encode(crate::self_update::install_hub_update(handle, version, restore_views).await),
        PendingHostedRestore(_) => {
            encode(crate::hosted_restore::pending_hosted_restore(handle).await)
        }
        RestoreHostedApp { app } => {
            encode(crate::hosted_restore::restore_hosted_app(handle, app).await)
        }
        CompleteHostedRestore { app } => {
            encode(crate::hosted_restore::complete_hosted_restore(handle, app))
        }
        ProjectInventory(_) => encode(crate::projects::project_inventory(handle).await),
        AddProjectFolder(_) => encode(crate::projects::add_project_folder(handle).await),
        RemoveProjectFolder { id } => {
            encode(crate::projects::remove_project_folder(handle, id).await)
        }
        OpenUnityProject { id } => encode(crate::projects::open_unity_project(handle, id).await),
        GetLaunchRequest(_) => encode(crate::launch::get_launch_request(handle)),
        StartHostedApp { app } => encode(crate::hosted::start_hosted_app(handle, app).await),
        HostedAppCall {
            session,
            command,
            args,
        } => encode(crate::hosted::hosted_app_call(handle, session, command, args).await),
        StopHostedApp { session } => encode(crate::hosted::stop_hosted_app(handle, session).await),
        AbortHostedApp { session } => {
            encode(crate::hosted::abort_hosted_app(handle, session).await)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_keep_existing_camel_case_arguments_and_app_ids() {
        assert!(matches!(
            decode(br#"{"command":"usage_terms_status","args":{}}"#),
            Ok(Invocation::UsageTermsStatus(_))
        ));
        assert!(matches!(decode(br#"{"command":"install_hub_update","args":{"version":"0.1.15","restoreViews":true}}"#), Ok(Invocation::InstallHubUpdate { restore_views: true, .. })));
        assert!(matches!(
            decode(br#"{"command":"start_hosted_app","args":{"app":"mcp"}}"#),
            Ok(Invocation::StartHostedApp { app: AppId::Mcp })
        ));
        assert!(matches!(decode(br#"{"command":"hosted_app_call","args":{"session":"opaque","command":"load_config","args":{}}}"#), Ok(Invocation::HostedAppCall { .. })));
    }

    #[test]
    fn no_arbitrary_host_or_retired_plugin_operations() {
        for command in [
            "exec",
            "shell",
            "read_file",
            "write_file",
            "host_spawn",
            "community_catalogue",
            "queue_community_import",
            "install_community_menu",
        ] {
            let request = format!(r#"{{"command":"{command}","args":{{}}}}"#);
            assert!(decode(request.as_bytes()).is_err(), "{command}");
        }
    }

    #[test]
    fn malformed_duplicate_unknown_or_oversize_fields_refuse() {
        for input in [
            "{}",
            "[]",
            "null",
            "",
            r#"{"command":"usage_terms_status"}"#,
            r#"{"command":"usage_terms_status","args":{"path":"/etc"}}"#,
            r#"{"command":"usage_terms_status","args":{},"trusted":true}"#,
            r#"{"command":"open_resource","args":{"resource":"github","resource":"sdk-source"}}"#,
            r#"{"command":"open_resource","args":{"resource":"github","trusted":true}}"#,
            r#"{"command":"hub_update_status","args":{"online":true}}"#,
            r#"{"command":"start_hosted_app","args":{"app":"arbitrary"}}"#,
            r#"{"command":"open_plugins_website","args":{}}"#,
        ] {
            assert!(decode(input.as_bytes()).is_err(), "{input}");
        }
        assert!(decode(&vec![b' '; MAX_REQUEST + 1]).is_err());
    }

    #[test]
    fn backend_errors_stay_errors_not_successful_payloads() {
        assert_eq!(encode(Ok::<_, String>(())), Ok(Value::Null));
        assert_eq!(
            encode::<()>(Err("Original consent refusal".into())),
            Err("Original consent refusal".into())
        );
    }

    #[test]
    fn events_are_finite_bounded_and_remain_structured_data() {
        assert_eq!(
            event_payload("app-progress", "{\"received\":4}"),
            Ok(serde_json::json!({"received":4}))
        );
        assert_eq!(
            event_payload("hosted-apps-suspended", "[]"),
            Ok(serde_json::json!([]))
        );
        assert!(event_payload("execute", "{}").is_err());
        assert!(event_payload("app-progress", "not JSON").is_err());
        assert!(event_payload("app-progress", &" ".repeat(2 * 1024 * 1024 + 1)).is_err());
        let mut names = EVENTS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), EVENTS.len());
    }

    #[test]
    fn every_shell_command_has_an_explicit_route_or_native_only_decision() {
        use serde_json::json;
        let fixtures = [
            ("usage_terms_status", json!({})),
            (
                "accept_usage_terms",
                json!({"policyVersion":"fixture", "accepted":false}),
            ),
            ("hub_preferences_status", json!({})),
            (
                "set_hub_preference",
                json!({"key":"restore-hosted-views", "value":true}),
            ),
            ("convergence_status", json!({})),
            ("refresh_convergence", json!({})),
            ("prepare_convergence", json!({})),
            ("migrate_convergence_connections", json!({})),
            ("retire_convergence_apps", json!({})),
            ("open_resource", json!({"resource":"github"})),
            (
                "community_import_status",
                json!({"projectId":"fixture", "requestId":"fixture"}),
            ),
            ("community_transfer_status", json!({})),
            (
                "cancel_community_transfer",
                json!({"operationId":"fixture"}),
            ),
            ("app_inventory", json!({"check":false, "preview":false})),
            ("download_app", json!({"app":"mcp", "version":"fixture"})),
            (
                "install_app",
                json!({"app":"setup", "version":"fixture", "reopen":true, "closeRunning":false}),
            ),
            ("disconnect_mcp", json!({})),
            ("open_app", json!({"app":"mcp"})),
            ("cancel_download", json!({})),
            ("use_existing_app", json!({"app":"setup", "path":null})),
            ("hub_update_status", json!({"online":true, "preview":false})),
            ("download_hub_update", json!({"version":"fixture"})),
            (
                "install_hub_update",
                json!({"version":"fixture", "restoreViews":true}),
            ),
            ("pending_hosted_restore", json!({})),
            ("restore_hosted_app", json!({"app":"mcp"})),
            ("complete_hosted_restore", json!({"app":"setup"})),
            ("project_inventory", json!({})),
            ("add_project_folder", json!({})),
            ("remove_project_folder", json!({"id":"fixture"})),
            ("open_unity_project", json!({"id":"fixture"})),
            ("get_launch_request", json!({})),
            ("start_hosted_app", json!({"app":"setup"})),
            (
                "hosted_app_call",
                json!({"session":"fixture", "command":"get_recipe", "args":{}}),
            ),
            ("stop_hosted_app", json!({"session":"fixture"})),
            ("abort_hosted_app", json!({"session":"fixture"})),
        ];
        let handler = include_str!("main.rs")
            .split("tauri::generate_handler![")
            .nth(1)
            .unwrap()
            .split("];")
            .next()
            .unwrap();
        let mut expected = handler
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap())
            .filter(|s| crate::plugins_retirement::command_error(s).is_none())
            .filter(|s| !NATIVE_WINDOW_ONLY.contains(s))
            .collect::<Vec<_>>();
        let mut actual = fixtures.iter().map(|(name, _)| *name).collect::<Vec<_>>();
        expected.sort_unstable();
        actual.sort_unstable();
        assert_eq!(
            actual, expected,
            "New shell handlers require an explicit native bridge decision"
        );
        for (command, args) in fixtures {
            let bytes = serde_json::to_vec(&json!({"command":command, "args":args})).unwrap();
            assert!(
                decode(&bytes).is_ok(),
                "{command} must preserve its typed arguments"
            );
        }
        for command in NATIVE_WINDOW_ONLY {
            let bytes = serde_json::to_vec(&json!({"command":command,"args":{}})).unwrap();
            assert!(decode(&bytes).is_err(), "{command} is native-window-only");
        }
        assert!(decode(br#"{"command":"feature_call","args":{"feature":"mcp","command":"save_config","args":{}}}"#).is_err());
    }
}
