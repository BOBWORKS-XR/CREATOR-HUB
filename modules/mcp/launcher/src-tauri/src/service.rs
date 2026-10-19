//! In-process Hub operations. No application, module window or child backend is started.
use crate::{hosted_commands, hosted_journal::Journal, hosted_lifecycle::HostedSession};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs::File, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const MAX_ARGUMENTS: usize = 60_000;
static INITIALIZING: Mutex<()> = Mutex::new(());

/// Home inventory only: verifies payload bytes without acquiring writer
/// ownership, creating a service context, binding routes or changing settings.
pub fn project_bridge_statuses(
    server_root: PathBuf,
    projects: &[PathBuf],
) -> Result<Vec<Value>, String> {
    available()?;
    if projects.len() > 200 {
        return Err("Bridge inventory is limited to 200 projects.".into());
    }
    let root = crate::hosted_payload::Root::verified(server_root)?;
    let bridge = root.read_verified("unity-extension/Editor/BanterMCPBridge.cs")?;
    let logo = root.read_verified("unity-extension/Editor/CreatorWorksMCPLogo.png")?;
    projects
        .iter()
        .map(|project| {
            serde_json::to_value(crate::extension_status_bytes(&bridge, &logo, project))
                .map_err(|_| "Cannot encode the read-only bridge status.".into())
        })
        .collect()
}

/// Exact native preview/import boundary, shared by Root before client writes
/// and by the service before a server transition. No paths or write authority.
pub fn verify_convergence_import(
    expected: &[u8],
    current: Option<&[u8]>,
    legacy: Option<&[u8]>,
) -> Result<(), String> {
    if expected.len() > 256 * 1024 || current != Some(expected) || legacy != Some(expected) {
        return Err("The settings do not match the exact approved project import. No next client or server write was started.".into());
    }
    Ok(())
}

struct Context {
    owner: crate::gui_owner::GuiWriteOwner,
    _payload: Vec<File>,
    state: Mutex<Session<'static>>,
}

struct Session<'a> {
    lifecycle: HostedSession<'a>,
    journal: Journal,
    nonce: String,
    next_id: u64,
    blocked: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishArgs {
    id: u32,
}

fn available() -> Result<(), String> {
    if !cfg!(feature = "integrated-service") || !cfg!(any(windows, target_os = "linux")) {
        return Err(
            "This MCP build does not enable the native Hub service on this platform.".into(),
        );
    }
    Ok(())
}

fn ensure_owner(owner: &crate::gui_owner::GuiWriteOwner) -> Result<(), String> {
    #[cfg(unix)]
    owner.ensure_current().map_err(|_| {
        "MCP settings ownership changed. No next operation will be started.".to_owned()
    })?;
    #[cfg(not(unix))]
    let _ = owner; // Windows retains a deny-sharing handle for the context lifetime.
    Ok(())
}

/// `runtime_root` is the server directory of Root's verified/staged built-in candidate.
/// Payload hashes are independently checked against this library's compiled manifest.
/// This acquires settings ownership but does not activate or approve a client route.
pub fn initialize(app: &AppHandle, runtime_root: PathBuf) -> Result<(), String> {
    available()?;
    let _initializing = INITIALIZING
        .lock()
        .map_err(|_| "MCP initialization is unavailable.")?;
    if let Some(context) = app.try_state::<Context>() {
        let root = app
            .try_state::<crate::hosted_payload::Root>()
            .ok_or("MCP resource authority is missing.")?;
        if root.0 != runtime_root {
            return Err("MCP is already initialized with a different verified payload.".into());
        }
        ensure_owner(&context.owner)?;
        return Ok(());
    }
    if app.try_state::<crate::hosted_payload::Root>().is_some()
        || app
            .try_state::<crate::managed_client::ManagedClient>()
            .is_some()
    {
        return Err("MCP resource authority already belongs to another presentation.".into());
    }
    // Keep Windows images locked; Unix resource consumers use verified byte snapshots.
    let payload = crate::hosted_payload::lock(&runtime_root)?;
    let root = crate::hosted_payload::Root::verified(runtime_root)?;
    let owner = crate::gui_owner::GuiWriteOwner::current_user().map_err(|_| {
        "Another MCP window owns these settings, or exclusive access is unavailable. No window was closed."
    })?;
    let settings = dirs::config_dir()
        .ok_or("Cannot locate MCP settings.")?
        .join(crate::APP_CONFIG_DIR);
    let mut journal = Journal::open(&settings)?;
    if !journal.pending().is_empty() {
        let message = format!("An earlier MCP operation did not record its outcome:\n\n{}\n\nInspect those settings or projects before repeating the operation. Nothing will be retried or rolled back automatically. Acknowledging this warning does not mark it successful.\n\nLocal record: {}", journal.pending().join(", "), settings.join("hosted-operation-outcomes.json").display());
        if !app
            .dialog()
            .message(message)
            .title("Previous MCP outcome needs checking")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Acknowledge".into(),
                "Not now".into(),
            ))
            .blocking_show()
        {
            return Err(
                "Previous operation remains unreviewed; the MCP service was not opened.".into(),
            );
        }
        ensure_owner(&owner)?;
        journal.acknowledge_unknowns()?;
    }
    ensure_owner(&owner)?;
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let session = Session::new(&crate::lifecycle::LIFECYCLE, nonce, journal)?;
    // All fallible preparation precedes publication. Only Context admits service calls.
    if !app.manage(root)
        || !app.manage(Context {
            owner,
            _payload: payload,
            state: Mutex::new(session),
        })
    {
        return Err(
            "MCP service authority was already published; no operation was started.".into(),
        );
    }
    Ok(())
}

/// Bind only after Root has obtained any required approval and activated its signed route.
/// Opening a feature page must not implicitly activate that route.
pub fn bind_managed_route(app: &AppHandle) -> Result<(), String> {
    available()?;
    let context = app
        .try_state::<Context>()
        .ok_or("MCP is not initialized in this Hub.")?;
    let state = context
        .state
        .try_lock()
        .map_err(|_| "An MCP operation is active or unavailable.")?;
    if state.blocked {
        return Err("MCP requires outcome review before another operation.".into());
    }
    let _command = crate::lifecycle::LIFECYCLE
        .command()
        .map_err(String::from)?;
    ensure_owner(&context.owner)?;
    let root = app
        .try_state::<crate::hosted_payload::Root>()
        .ok_or("MCP payload authority is missing.")?;
    let managed = crate::managed_client::prepare(&root)?;
    if let Some(existing) = app.try_state::<crate::managed_client::ManagedClient>() {
        if existing.0.command != managed.0.command {
            return Err(
                "The approved MCP router changed; reopen Hub before writing client settings."
                    .into(),
            );
        }
        return Ok(());
    }
    if !app.manage(managed) {
        return Err("MCP routing authority was already bound.".into());
    }
    Ok(())
}

fn validate(command: &str, args: &Value) -> Result<(), String> {
    if !(hosted_commands::COMMANDS.contains(&command)
        || matches!(command, "get_hosted_snapshot" | "pick_project_folder"))
    {
        return Err("Unsupported native MCP operation.".into());
    }
    if !args.is_object()
        || serde_json::to_vec(args)
            .map_err(|_| "Invalid MCP arguments.")?
            .len()
            > MAX_ARGUMENTS
    {
        return Err("Invalid or oversized MCP arguments.".into());
    }
    Ok(())
}

/// Root must obtain route approval only for these actual client setup/migration actions.
/// Read-only discovery, page opening and workflow bookkeeping do not activate a route.
pub fn needs_managed_route(command: &str) -> bool {
    matches!(
        command,
        "one_click_setup"
            | "review_existing_client_connection"
            | "review_existing_client_connections"
            | "review_convergence_server"
            | "update_codex_mcp_config"
            | "update_claude_mcp_config"
            | "update_claude_desktop_mcp_config"
            | "update_antigravity_mcp_config"
            | "update_opencode_mcp_config"
    )
}

fn require_managed_route(command: &str, bound: bool) -> Result<(), String> {
    if needs_managed_route(command) && !bound {
        return Err("Approve and bind Hub's signed MCP route before this client setup or migration. No client settings were changed.".into());
    }
    Ok(())
}

fn emit(app: &AppHandle, frame: &[u8]) -> Result<(), String> {
    let event: Value = serde_json::from_slice(frame).map_err(|_| "Cannot encode MCP lifecycle.")?;
    app.emit(
        "feature-event",
        json!({"feature":"mcp", "name":"creator-mcp-lifecycle", "payload":event["payload"]}),
    )
    .map_err(|_| "MCP lifecycle delivery failed. Check the last outcome before retrying.".into())
}

fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    if command == "review_product_settings" {
        serde_json::from_value::<NoArgs>(args)
            .map_err(|_| "Invalid hosted command arguments.".to_owned())?;
        let base = dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?;
        return serde_json::to_value(hosted_commands::product_settings::native_review_decision(
            app, &base,
        )?)
        .map_err(|_| "Cannot encode MCP result.".into());
    }
    if matches!(command, "get_hosted_snapshot" | "pick_project_folder") {
        crate::hosted::dispatch(app, command, args)
    } else {
        hosted_commands::dispatch(app, command, args)
    }
}

/// Synchronous: Root calls from a blocking worker and retains its native operation lease.
/// Only existing finite, typed handlers are callable. Arguments/results are never journaled.
pub fn call(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    available()?;
    validate(command, &args)?;
    let context = app
        .try_state::<Context>()
        .ok_or("MCP is not initialized in this Hub.")?;
    require_managed_route(
        command,
        app.try_state::<crate::managed_client::ManagedClient>()
            .is_some(),
    )?;
    let mut state = context
        .state
        .try_lock()
        .map_err(|_| "An MCP operation is active or unavailable.")?;
    state.execute(
        command,
        args,
        || ensure_owner(&context.owner),
        |frame| emit(app, frame),
        |command, args| {
            let _scope = crate::integration_context::Scope::enter()?;
            dispatch(app, command, args)
        },
    )
}

/// Read-only review for Root's integrated migration. It is deliberately not a
/// service command, serializable ticket, global flag or dialog override.
pub struct ConvergenceReview {
    clients: Vec<(PathBuf, Option<Vec<u8>>)>,
    settings: hosted_commands::product_settings::ConvergenceSettings,
}

pub struct ConvergenceConsent {
    review: ConvergenceReview,
}

fn recheck_client_images(clients: &[(PathBuf, Option<Vec<u8>>)]) -> Result<(), String> {
    for (path, before) in clients {
        crate::client_recovery_ui::require_no_pending_adjacent(path)?;
        if crate::settings_backup::read_bytes(path)? != *before {
            return Err(
                "AI-client settings changed after native review. No next client write was started."
                    .into(),
            );
        }
    }
    Ok(())
}

fn approve_snapshot<T>(
    review: T,
    recheck: impl Fn(&T) -> Result<(), String>,
    approve: impl FnOnce() -> bool,
) -> Result<Option<T>, String> {
    recheck(&review)?;
    if !approve() {
        return Ok(None);
    }
    recheck(&review)?;
    Ok(Some(review))
}

fn require_no_convergence_recovery() -> Result<(), String> {
    // This read must use internal admission even before writer initialization;
    // the standalone entry otherwise intentionally reports no recovery support.
    let _scope = if crate::integration_context::active() {
        None
    } else {
        Some(crate::integration_context::Scope::enter()?)
    };
    if !crate::client_recovery_ui::pending_client_recovery()?.is_empty() {
        return Err("Existing client changes need recovery review. Nothing was retried.".into());
    }
    Ok(())
}

impl ConvergenceReview {
    pub fn inspect(server: &std::path::Path, imported: Option<&[u8]>) -> Result<Self, String> {
        available()?;
        let mut clients = Vec::new();
        for id in [
            "codex",
            "claude",
            "claudeDesktop",
            "antigravity",
            "opencode",
        ] {
            if id == "claudeDesktop" && cfg!(target_os = "linux") {
                continue;
            }
            let (_, path, _) = crate::client_target(id)?;
            crate::client_recovery_ui::require_no_pending_adjacent(&path)?;
            clients.push((path.clone(), crate::settings_backup::read_bytes(&path)?));
        }
        require_no_convergence_recovery()?;
        Ok(Self {
            clients,
            settings: hosted_commands::product_settings::ConvergenceSettings::inspect(
                server, imported,
            )?,
        })
    }

    fn recheck_clients(&self) -> Result<(), String> {
        recheck_client_images(&self.clients)?;
        require_no_convergence_recovery()?;
        Ok(())
    }

    pub fn approve(
        self,
        app: &AppHandle,
        native_summary: &str,
    ) -> Result<Option<ConvergenceConsent>, String> {
        let approved = approve_snapshot(
            self,
            |review| {
                review.recheck_clients()?;
                review.settings.recheck_original()
            },
            || {
                app.dialog().message(format!(
            "Move your existing setup to this Creator Hub?\n\n- Back up settings first; add missing projects without duplicates and keep current preferences and selection.\n- Move verified existing AI connections to this Hub's signed runtime; keep other client entries.\n- Retire only verified standalone app entries; keep settings, Unity projects, backups and old runtime files.\n\n{native_summary}\n\nCustom or unverified connections and servers need separate review. Busy apps are not force-closed. Cancel changes no settings or installations."
        )).title("Move to Hub").kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Move to Hub".into(), "Not now".into())).blocking_show()
            },
        )?;
        Ok(approved.map(|review| ConvergenceConsent { review }))
    }
}

impl ConvergenceConsent {
    pub fn recheck(&self) -> Result<(), String> {
        self.review.recheck_clients()?;
        self.review.settings.recheck_original()
    }

    pub(crate) fn recheck_clients(&self) -> Result<(), String> {
        self.review.recheck_clients()
    }

    pub(crate) fn recheck_imported_settings(&self) -> Result<(), String> {
        self.review.settings.recheck_imported()?;
        require_no_convergence_recovery()
    }
}

/// Uses the existing ownership lock, workflow, journal and writer scope. Only
/// the opaque receipt from the native dialog above can enter this path.
pub fn apply_convergence(app: &AppHandle, consent: ConvergenceConsent) -> Result<Value, String> {
    available()?;
    let context = app
        .try_state::<Context>()
        .ok_or("MCP is not initialized in this Hub.")?;
    require_managed_route(
        "review_existing_client_connections",
        app.try_state::<crate::managed_client::ManagedClient>()
            .is_some(),
    )?;
    let mut state = context
        .state
        .try_lock()
        .map_err(|_| "An MCP operation is active or unavailable.")?;
    // Explicit closures keep the consent outside all renderer command arguments.
    state.execute(
        "review_existing_client_connections",
        json!({}),
        || ensure_owner(&context.owner),
        |frame| emit(app, frame),
        |_, _| {
            let _scope = crate::integration_context::Scope::enter()?;
            consent.recheck_clients()?;
            crate::apply_convergence_clients(app, &consent)
        },
    )?;
    require_no_convergence_recovery()?;
    state.execute(
        "review_convergence_server",
        json!({}),
        || ensure_owner(&context.owner),
        |frame| emit(app, frame),
        |_, _| {
            let _scope = crate::integration_context::Scope::enter()?;
            consent.review.settings.apply(app)
        },
    )
}

pub(crate) fn recheck_convergence_owner(app: &AppHandle) -> Result<(), String> {
    let context = app
        .try_state::<Context>()
        .ok_or("MCP writer ownership is unavailable.")?;
    ensure_owner(&context.owner)?;
    let root = app
        .try_state::<crate::hosted_payload::Root>()
        .ok_or("MCP payload authority is unavailable.")?;
    let fresh = crate::managed_client::prepare(&root)?;
    let bound = app
        .try_state::<crate::managed_client::ManagedClient>()
        .ok_or("The signed MCP route is unavailable.")?;
    if fresh.0.command != bound.0.command {
        return Err(
            "The signed MCP route changed after native review. No next write was started.".into(),
        );
    }
    Ok(())
}

/// Read-only quiescence proof. Never closes a backend, clears a workflow or acknowledges outcomes.
/// A running worker holds this mutex through handler return and durable outcome completion.
pub fn is_idle(app: &AppHandle) -> Result<bool, String> {
    available()?;
    let context = app
        .try_state::<Context>()
        .ok_or("MCP is not initialized in this Hub.")?;
    ensure_owner(&context.owner)?;
    idle_state(&context.state)
}

fn idle_state(state: &Mutex<Session<'_>>) -> Result<bool, String> {
    match state.try_lock() {
        Ok(state) => state.is_idle(),
        Err(std::sync::TryLockError::WouldBlock) => Ok(false),
        Err(std::sync::TryLockError::Poisoned(_)) => {
            Err("MCP operation state is unavailable.".into())
        }
    }
}

pub fn busy(app: &AppHandle) -> Result<bool, String> {
    is_idle(app).map(|idle| !idle)
}

/// Only proves no worker holds the context mutex at this instant, not successful completion.
/// Root must separately stop new admission and retain its active-call/close-review guards.
/// This never reads or clears workflow state, acknowledges outcomes or restarts the service.
pub fn worker_returned(app: &AppHandle) -> Result<bool, String> {
    available()?;
    let context = app
        .try_state::<Context>()
        .ok_or("MCP is not initialized in this Hub.")?;
    Ok(worker_returned_state(&context.state))
}

fn worker_returned_state(state: &Mutex<Session<'_>>) -> bool {
    match state.try_lock() {
        Ok(_) => true,
        Err(std::sync::TryLockError::WouldBlock) => false,
        // A poisoned error also owns an acquired guard: the worker unwound.
        // Do not inspect its protected data or clear the poison/unknown outcome.
        Err(std::sync::TryLockError::Poisoned(_)) => true,
    }
}

impl<'a> Session<'a> {
    fn new(
        lifecycle: &'a crate::lifecycle::Lifecycle,
        nonce: String,
        journal: Journal,
    ) -> Result<Self, String> {
        Ok(Self {
            lifecycle: HostedSession::writable(lifecycle, &nonce).map_err(String::from)?,
            journal,
            nonce,
            next_id: 0,
            blocked: false,
        })
    }

    fn is_idle(&self) -> Result<bool, String> {
        Ok(!self.blocked
            && self.journal.pending().is_empty()
            && self.lifecycle.is_idle().map_err(String::from)?)
    }

    fn execute(
        &mut self,
        command: &str,
        args: Value,
        ensure_owner: impl Fn() -> Result<(), String>,
        emit: impl Fn(&[u8]) -> Result<(), String>,
        dispatch: impl FnOnce(&str, Value) -> Result<Value, String>,
    ) -> Result<Value, String> {
        validate(command, &args)?;
        if self.blocked || !self.journal.pending().is_empty() {
            return Err("MCP requires outcome review; no command will be replayed.".into());
        }
        let changes = hosted_commands::needs_workflow(command);
        if changes && !self.lifecycle.has_workflow() {
            return Err(
                "Start an owned UI workflow before changing MCP settings or projects.".into(),
            );
        }
        ensure_owner()?;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("MCP operation IDs exhausted.")?;
        let id = self.next_id;
        self.lifecycle
            .begin_command(id, command)
            .map_err(String::from)?;
        let result = (|| {
            emit(&self.lifecycle.event().map_err(String::from)?)?;
            // Delivery/native dialogs can wait: recheck ownership before acceptance or a handler.
            ensure_owner()?;
            if changes {
                self.journal.begin(&self.nonce, id, command)?;
            }
            let result = match command {
                "begin_ui_operation" => serde_json::from_value::<NoArgs>(args)
                    .map_err(|_| "Invalid MCP workflow arguments.".into())
                    .and_then(|_| {
                        self.lifecycle
                            .begin_workflow()
                            .map(|id| json!(id))
                            .map_err(String::from)
                    }),
                "finish_ui_operation" => serde_json::from_value::<FinishArgs>(args)
                    .map_err(|_| "Invalid MCP workflow receipt.".into())
                    .and_then(|args| {
                        self.lifecycle
                            .finish_workflow(args.id)
                            .map(|_| Value::Null)
                            .map_err(String::from)
                    }),
                _ => dispatch(command, args),
            };
            if changes {
                self.journal.complete(&self.nonce, id, result.is_ok())?;
            }
            self.lifecycle
                .complete_command(result.is_ok())
                .map_err(String::from)?;
            emit(&self.lifecycle.event().map_err(String::from)?)?;
            Ok(result)
        })();
        match result {
            Ok(result) => result,
            Err(error) => {
                // Infrastructure failure is not a handler outcome or permission to retry.
                self.blocked = true;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn convergence_cancel_and_changes_during_native_review_never_issue_a_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("client.json");
        std::fs::write(&path, b"before").unwrap();
        let images = vec![(path.clone(), Some(b"before".to_vec()))];
        let checks = Cell::new(0);
        let check = |images: &Vec<_>| {
            checks.set(checks.get() + 1);
            recheck_client_images(images)
        };
        assert!(approve_snapshot(images.clone(), check, || false)
            .unwrap()
            .is_none());
        assert_eq!(checks.get(), 1);
        assert_eq!(std::fs::read(&path).unwrap(), b"before");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        assert!(approve_snapshot(images, check, || {
            std::fs::write(&path, b"external edit during dialog").unwrap();
            true
        })
        .is_err());
        assert_eq!(checks.get(), 3);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"external edit during dialog"
        );
    }

    #[test]
    fn convergence_rechecks_missing_and_noop_clients_before_any_client_apply() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("existing.json");
        let absent = temp.path().join("missing.json");
        std::fs::write(&existing, b"exact original").unwrap();
        let images = vec![
            (existing.clone(), Some(b"exact original".to_vec())),
            (absent.clone(), None),
        ];
        recheck_client_images(&images).unwrap();
        std::fs::write(&absent, b"appeared after consent").unwrap();
        assert!(recheck_client_images(&images).is_err());
        std::fs::remove_file(&absent).unwrap();
        std::fs::write(&existing, b"changed between backup and client apply").unwrap();
        assert!(recheck_client_images(&images).is_err());
        assert_eq!(
            std::fs::read(&existing).unwrap(),
            b"changed between backup and client apply"
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn native_convergence_remains_outside_renderer_dispatch_and_keeps_rechecks() {
        let source = include_str!("service.rs");
        let apply = source
            .split("pub fn apply_convergence(")
            .nth(1)
            .unwrap()
            .split("pub(crate) fn recheck_convergence_owner")
            .next()
            .unwrap();
        assert!(
            apply.find("consent.recheck_clients()?").unwrap()
                < apply.find("crate::apply_convergence_clients").unwrap()
        );
        assert!(
            apply.find("crate::apply_convergence_clients").unwrap()
                < apply.find("consent.review.settings.apply(app)").unwrap()
        );
        assert_eq!(apply.matches("state.execute(").count(), 2);
        assert!(
            apply.find("require_no_convergence_recovery()?").unwrap()
                < apply.find("consent.review.settings.apply(app)").unwrap()
        );
        assert!(apply.contains("ensure_owner(&context.owner)"));
        for command in [
            "apply_convergence",
            "ConvergenceConsent",
            "approve_snapshot",
        ] {
            assert!(validate(command, &json!({})).is_err());
        }
        let helper = source
            .split("pub fn project_bridge_statuses(")
            .nth(1)
            .unwrap()
            .split("struct Context")
            .next()
            .unwrap();
        assert!(helper.contains("Root::verified"));
        assert!(helper.contains("read_verified"));
        assert!(
            helper.find("projects.len() > 200").unwrap() < helper.find("Root::verified").unwrap()
        );
        for forbidden in [
            "initialize(",
            "bind_managed_route(",
            "GuiWriteOwner",
            "Context {",
            "Store::installed",
        ] {
            assert!(!helper.contains(forbidden));
        }
    }

    #[cfg(feature = "integrated-service")]
    #[test]
    fn pure_bridge_inventory_is_bounded_and_verification_failure_does_not_create_context_or_files()
    {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("missing-payload");
        let projects = vec![dir.path().join("not-a-project"); 201];
        assert!(project_bridge_statuses(root.clone(), &projects)
            .unwrap_err()
            .contains("200"));
        assert!(project_bridge_statuses(root, &projects[..1]).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    fn fixture<'a>(life: &'a crate::lifecycle::Lifecycle, dir: &std::path::Path) -> Session<'a> {
        Session::new(life, "a".repeat(64), Journal::open(dir).unwrap()).unwrap()
    }
    fn invoke(session: &mut Session<'_>, command: &str, args: Value) -> Result<Value, String> {
        session.execute(command, args, || Ok(()), |_| Ok(()), |_, _| Ok(Value::Null))
    }
    fn begin(session: &mut Session<'_>) -> u32 {
        invoke(session, "begin_ui_operation", json!({}))
            .unwrap()
            .as_u64()
            .unwrap() as u32
    }

    #[test]
    fn allowlist_and_bounded_object_arguments_cannot_reach_other_transports() {
        for command in hosted_commands::COMMANDS {
            assert!(validate(command, &json!({})).is_ok(), "{command}");
        }
        for command in ["get_hosted_snapshot", "pick_project_folder"] {
            assert!(validate(command, &json!({})).is_ok());
        }
        for command in [
            "bind_verified_resources",
            "bind_managed_route",
            "open_official_url",
            "eval",
            "exec",
            "run",
            "initialize",
            "download_community_package",
            "",
        ] {
            assert!(validate(command, &json!({})).is_err(), "{command}");
        }
        for value in [Value::Null, json!([]), json!("path"), json!(1)] {
            assert!(validate("load_config", &value).is_err());
        }
        assert!(validate("load_config", &json!({"x":"a".repeat(MAX_ARGUMENTS)})).is_err());
    }

    #[test]
    fn native_workflow_owns_receipt_and_guards_all_command_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let life = crate::lifecycle::Lifecycle::new();
        let mut session = fixture(&life, dir.path());
        assert!(session.is_idle().unwrap());
        assert!(invoke(&mut session, "save_config", json!({})).is_err());
        assert!(!dir.path().join("hosted-operation-outcomes.json").exists());
        let id = begin(&mut session);
        assert!(!session.is_idle().unwrap());
        assert!(!life.request_close());
        assert!(invoke(&mut session, "finish_ui_operation", json!({"id":id+1})).is_err());
        assert!(invoke(
            &mut session,
            "finish_ui_operation",
            json!({"id":id,"extra":true})
        )
        .is_err());
        assert!(!session.is_idle().unwrap());
        invoke(&mut session, "save_config", json!({})).unwrap();
        invoke(&mut session, "finish_ui_operation", json!({"id":id})).unwrap();
        assert!(session.is_idle().unwrap());
        assert!(life.command().is_ok()); // Idle did not request close.
        assert!(invoke(&mut session, "finish_ui_operation", json!({"id":id})).is_err());
    }

    #[test]
    fn journal_precedes_handler_and_completion_follows_handler_return() {
        let dir = tempfile::tempdir().unwrap();
        let life = crate::lifecycle::Lifecycle::new();
        let mut session = fixture(&life, dir.path());
        let id = begin(&mut session);
        let events = Cell::new(0);
        let result = session.execute(
            "save_config",
            json!({"secret":"never-record"}),
            || Ok(()),
            |frame| {
                events.set(events.get() + 1);
                let event: Value = serde_json::from_slice(frame).unwrap();
                assert_eq!(event["name"], "creator-mcp-lifecycle");
                assert!(!String::from_utf8_lossy(frame).contains("never-record"));
                Ok(())
            },
            |_, _| {
                assert_eq!(
                    Journal::open(dir.path()).unwrap().pending(),
                    ["save_config"]
                );
                assert!(!life.is_idle().unwrap());
                Err("handler error".into())
            },
        );
        assert_eq!(result.unwrap_err(), "handler error");
        assert_eq!(events.get(), 2);
        assert!(Journal::open(dir.path()).unwrap().pending().is_empty());
        assert!(
            !std::fs::read_to_string(dir.path().join("hosted-operation-outcomes.json"))
                .unwrap()
                .contains("never-record")
        );
        invoke(&mut session, "finish_ui_operation", json!({"id":id})).unwrap();
        assert!(session.is_idle().unwrap());
    }

    #[test]
    fn idle_query_refuses_a_running_worker_until_its_actual_return() {
        let dir = tempfile::tempdir().unwrap();
        let life = crate::lifecycle::Lifecycle::new();
        let state = Mutex::new(fixture(&life, dir.path()));
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::scope(|scope| {
            let state = &state;
            let worker = scope.spawn(move || {
                state.lock().unwrap().execute(
                    "get_onboarding_status",
                    json!({}),
                    || Ok(()),
                    |_| Ok(()),
                    |_, _| {
                        started_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                        Ok(Value::Null)
                    },
                )
            });
            started_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(!idle_state(state).unwrap());
            assert!(!worker_returned_state(state));
            assert!(!life.is_idle().unwrap());
            release_tx.send(()).unwrap();
            worker.join().unwrap().unwrap();
        });
        assert!(idle_state(&state).unwrap());
        assert!(worker_returned_state(&state));
        assert!(life.command().is_ok());
    }

    #[test]
    fn returned_worker_does_not_clear_blocked_workflow_or_uncertain_journal() {
        for fail_journal in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let life = crate::lifecycle::Lifecycle::new();
            let state = Mutex::new(fixture(&life, dir.path()));
            let id = begin(&mut state.lock().unwrap());
            let journal = dir.path().join("hosted-operation-outcomes.json");
            let retained = dir.path().join("retained.json");
            let events = Cell::new(0);
            assert!(state
                .lock()
                .unwrap()
                .execute(
                    "save_config",
                    json!({}),
                    || Ok(()),
                    |_| {
                        events.set(events.get() + 1);
                        if !fail_journal && events.get() == 2 {
                            Err("completion event failed".into())
                        } else {
                            Ok(())
                        }
                    },
                    |_, _| {
                        assert!(!worker_returned_state(&state));
                        if fail_journal {
                            std::fs::rename(&journal, &retained).unwrap();
                            std::fs::create_dir(&journal).unwrap();
                        }
                        Ok(Value::Null)
                    }
                )
                .is_err());
            let evidence = if fail_journal { retained } else { journal };
            let before = std::fs::read(&evidence).unwrap();
            assert!(worker_returned_state(&state));
            assert!(!idle_state(&state).unwrap());
            assert!(!life.is_idle().unwrap());
            let mut session = state.lock().unwrap();
            assert!(session.blocked && session.lifecycle.has_workflow());
            assert!(invoke(&mut session, "finish_ui_operation", json!({"id":id})).is_err());
            assert_eq!(std::fs::read(&evidence).unwrap(), before);
        }
    }

    #[test]
    fn unwound_worker_proof_does_not_clear_poison_or_acknowledge_accepted_work() {
        let dir = tempfile::tempdir().unwrap();
        let life = crate::lifecycle::Lifecycle::new();
        let state = Mutex::new(fixture(&life, dir.path()));
        assert!(std::panic::catch_unwind(|| {
            let mut session = state.lock().unwrap();
            begin(&mut session);
            let _ = session.execute(
                "save_config",
                json!({}),
                || Ok(()),
                |_| Ok(()),
                |_, _| {
                    assert!(!worker_returned_state(&state));
                    panic!("disposable handler unwind");
                },
            );
        })
        .is_err());
        let journal = dir.path().join("hosted-operation-outcomes.json");
        let before = std::fs::read(&journal).unwrap();
        assert_eq!(
            Journal::open(dir.path()).unwrap().pending(),
            ["save_config"]
        );
        assert!(worker_returned_state(&state));
        assert!(state.is_poisoned());
        assert!(idle_state(&state).is_err());
        assert!(!life.is_idle().unwrap());
        assert_eq!(std::fs::read(journal).unwrap(), before);
    }

    #[test]
    fn delivery_or_changed_ownership_never_invokes_handler_or_reports_idle() {
        for failed_delivery in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let life = crate::lifecycle::Lifecycle::new();
            let mut session = fixture(&life, dir.path());
            let ownership = Cell::new(0);
            let calls = Cell::new(0);
            assert!(session
                .execute(
                    "get_onboarding_status",
                    json!({}),
                    || {
                        ownership.set(ownership.get() + 1);
                        if ownership.get() == 2 {
                            Err("owner changed".into())
                        } else {
                            Ok(())
                        }
                    },
                    |_| if failed_delivery {
                        Err("delivery failed".into())
                    } else {
                        Ok(())
                    },
                    |_, _| {
                        calls.set(calls.get() + 1);
                        Ok(Value::Null)
                    }
                )
                .is_err());
            assert_eq!(calls.get(), 0);
            assert!(!session.is_idle().unwrap());
            assert!(invoke(&mut session, "get_onboarding_status", json!({})).is_err());
            assert!(!dir.path().join("hosted-operation-outcomes.json").exists());
        }
    }

    #[test]
    fn failed_durable_completion_does_not_replay_or_release_guard() {
        let dir = tempfile::tempdir().unwrap();
        let life = crate::lifecycle::Lifecycle::new();
        let mut session = fixture(&life, dir.path());
        begin(&mut session);
        let journal_path = dir.path().join("hosted-operation-outcomes.json");
        let retained = dir.path().join("retained.json");
        let calls = Cell::new(0);
        assert!(session
            .execute(
                "save_config",
                json!({}),
                || Ok(()),
                |_| Ok(()),
                |_, _| {
                    calls.set(calls.get() + 1);
                    std::fs::rename(&journal_path, &retained).unwrap();
                    std::fs::create_dir(&journal_path).unwrap();
                    Ok(Value::Null)
                }
            )
            .is_err());
        assert_eq!(calls.get(), 1);
        assert!(!session.is_idle().unwrap());
        assert!(!life.is_idle().unwrap());
        assert!(invoke(&mut session, "save_config", json!({})).is_err());
        let retained: Value = serde_json::from_slice(&std::fs::read(retained).unwrap()).unwrap();
        assert_eq!(retained["records"][0]["outcome"], "accepted");
    }

    #[test]
    fn recovered_unknown_outcomes_are_not_automatically_acknowledged() {
        let dir = tempfile::tempdir().unwrap();
        let life = crate::lifecycle::Lifecycle::new();
        let mut journal = Journal::open(dir.path()).unwrap();
        journal.begin(&"b".repeat(64), 1, "save_config").unwrap();
        let original = std::fs::read(dir.path().join("hosted-operation-outcomes.json")).unwrap();
        let mut session = fixture(&life, dir.path());
        assert!(!session.is_idle().unwrap());
        assert!(invoke(&mut session, "get_onboarding_status", json!({})).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("hosted-operation-outcomes.json")).unwrap(),
            original
        );
    }

    #[test]
    fn binary_remains_thin_and_service_does_not_start_a_module_application() {
        let main = include_str!("main.rs");
        assert!(main.contains("creator_works_mcp_launcher::run();"));
        assert!(!main.contains("tauri::Builder"));
        let source = include_str!("service.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "tauri::Builder",
            "WebviewWindow",
            "std::process::Command",
            "hosted::run",
            "request_close(",
        ] {
            assert!(!source.contains(forbidden), "{forbidden}");
        }
        assert!(source.contains("\"feature-event\""));
        assert!(source.contains("\"feature\":\"mcp\""));
        assert!(source.contains("hosted_commands::dispatch(app, command, args)"));
    }

    #[test]
    fn authority_is_compile_feature_and_platform_bound_not_an_environment_toggle() {
        assert_eq!(
            available().is_ok(),
            cfg!(feature = "integrated-service") && cfg!(any(windows, target_os = "linux"))
        );
    }

    #[test]
    fn public_root_contract_is_synchronous_and_explicit() {
        let _: fn(&AppHandle, PathBuf) -> Result<(), String> = initialize;
        let _: fn(&AppHandle) -> Result<(), String> = bind_managed_route;
        let _: fn(&AppHandle, &str, Value) -> Result<Value, String> = call;
        let _: fn(&AppHandle) -> Result<bool, String> = is_idle;
        let _: fn(&AppHandle) -> Result<bool, String> = busy;
        let _: fn(&AppHandle) -> Result<bool, String> = worker_returned;
        let _: fn(&str) -> bool = needs_managed_route;
    }

    #[test]
    fn only_actual_client_setup_and_migration_actions_need_route_approval() {
        let expected = [
            "one_click_setup",
            "review_existing_client_connection",
            "review_existing_client_connections",
            "review_convergence_server",
            "update_codex_mcp_config",
            "update_claude_mcp_config",
            "update_claude_desktop_mcp_config",
            "update_antigravity_mcp_config",
            "update_opencode_mcp_config",
        ];
        for command in hosted_commands::COMMANDS {
            assert_eq!(
                needs_managed_route(command),
                expected.contains(command),
                "{command}"
            );
            assert_eq!(
                require_managed_route(command, false).is_err(),
                expected.contains(command),
                "{command}"
            );
            assert!(require_managed_route(command, true).is_ok());
        }
        for command in expected {
            assert!(hosted_commands::COMMANDS.contains(&command));
        }
        for command in [
            "get_hosted_snapshot",
            "pick_project_folder",
            "exec",
            "bind_managed_route",
            "",
        ] {
            assert!(!needs_managed_route(command));
        }
    }
}
