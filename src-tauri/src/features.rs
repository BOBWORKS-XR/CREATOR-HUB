//! Direct Hub feature APIs. No module application or webview is started here.
use serde::Deserialize;
use serde_json::{json, Value};

#[cfg(feature = "integrated-features")]
use tauri::Manager as _;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Feature {
    Setup,
    Mcp,
}

#[derive(Default)]
pub struct Features {
    last_tool: std::sync::Mutex<Option<Feature>>,
    #[cfg(feature = "integrated-features")]
    mcp: std::sync::Mutex<crate::hosted_operation::SessionOperation<crate::manager::Operation>>,
    #[cfg(feature = "integrated-features")]
    mcp_root: std::sync::Mutex<Option<std::path::PathBuf>>,
    #[cfg(feature = "integrated-features")]
    close_review: std::sync::atomic::AtomicBool,
}

impl Features {
    fn select(&self, feature: Option<Feature>) -> Result<(), String> {
        // Visiting Home to approve an update must not forget the last tool.
        if let Some(feature) = feature {
            *self
                .last_tool
                .lock()
                .map_err(|_| "Hub navigation state is unavailable.")? = Some(feature);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn feature_select(
    state: tauri::State<'_, Features>,
    feature: Option<Feature>,
) -> Result<(), String> {
    if !cfg!(feature = "integrated-features") {
        return Err("Direct feature pages are not enabled in this build.".into());
    }
    state.select(feature)
}

pub fn update_views(handle: &tauri::AppHandle) -> Result<Vec<crate::hosted_restore::View>, String> {
    #[cfg(not(feature = "integrated-features"))]
    {
        let _ = handle;
        Ok(Vec::new())
    }
    #[cfg(feature = "integrated-features")]
    {
        let state = handle.state::<Features>();
        let view = *state
            .last_tool
            .lock()
            .map_err(|_| "Hub navigation state is unavailable.")?;
        view.map(|feature| {
            Ok(crate::hosted_restore::View {
                app: match feature {
                    Feature::Setup => crate::catalog::AppId::Setup,
                    Feature::Mcp => crate::catalog::AppId::Mcp,
                },
                path: std::env::current_exe()
                    .map_err(|_| "Cannot locate Hub for page restoration.")?,
                bundled: true,
                direct: true,
            })
        })
        .into_iter()
        .collect()
    }
}

fn validate(args: &Value) -> Result<(), String> {
    if !args.is_object()
        || serde_json::to_vec(args)
            .map_err(|_| "Invalid feature arguments.")?
            .len()
            > 60_000
    {
        return Err("Invalid or oversized feature arguments.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn feature_status() -> Value {
    json!({
        "integrated": cfg!(feature = "integrated-features"),
        "features": if cfg!(feature = "integrated-features") {
            vec!["setup", "mcp"]
        } else {
            Vec::<&str>::new()
        }
    })
}

#[tauri::command]
pub async fn feature_call(
    handle: tauri::AppHandle,
    feature: Feature,
    command: String,
    args: Value,
) -> Result<Value, String> {
    validate(&args)?;
    #[cfg(not(feature = "integrated-features"))]
    {
        let _ = (handle, feature, command);
        Err("This Hub build does not include direct feature pages.".into())
    }
    #[cfg(feature = "integrated-features")]
    tauri::async_runtime::spawn_blocking(move || match feature {
        Feature::Setup => {
            // This guard belongs to the actual worker, not the renderer future.
            let _operation = handle.state::<crate::manager::Manager>().begin()?;
            creator_project_setup::service::call(&handle, &command, args)
        }
        Feature::Mcp => call_mcp(&handle, &command, args),
    })
    .await
    .map_err(|error| {
        format!("Hub feature worker stopped: {error}. Check its state before retrying.")
    })?
}

#[cfg(feature = "integrated-features")]
pub(crate) fn call_mcp(
    handle: &tauri::AppHandle,
    command: &str,
    args: Value,
) -> Result<Value, String> {
    let state = handle.state::<Features>();
    state
        .mcp
        .lock()
        .map_err(|_| "MCP operation state is unavailable.")?
        .begin(command, &args, || {
            handle.state::<crate::manager::Manager>().begin()
        })?;
    let result = returned_result(|| dispatch_mcp(handle, command, args));
    state
        .mcp
        .lock()
        .map_err(|_| "MCP operation state is unavailable.")?
        .complete(&result)?;
    result
}

#[cfg(any(test, feature = "integrated-features"))]
fn returned_result(dispatch: impl FnOnce() -> Result<Value, String>) -> Result<Value, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(dispatch)).unwrap_or_else(|_| {
        Err("MCP stopped unexpectedly. Its outcome is unknown. Close Hub and review recovery before repeating work.".into())
    })
}

#[cfg(feature = "integrated-features")]
fn dispatch_mcp(handle: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    initialize_mcp(handle)?;
    if creator_works_mcp_launcher::service::needs_managed_route(command) {
        crate::builtin::managed_route(handle)?
            .ok_or("This Hub has no verified managed MCP route. Existing settings were kept.")?;
        creator_works_mcp_launcher::service::bind_managed_route(handle)?;
    }
    creator_works_mcp_launcher::service::call(handle, command, args)
}

#[cfg(feature = "integrated-features")]
pub(crate) fn initialize_mcp(handle: &tauri::AppHandle) -> Result<(), String> {
    let state = handle.state::<Features>();
    let mut root = state
        .mcp_root
        .lock()
        .map_err(|_| "MCP resource state is unavailable.")?;
    if let Some(root) = root.as_ref() {
        return creator_works_mcp_launcher::service::initialize(handle, root.clone());
    }
    let candidate = crate::builtin::hosting_candidate(handle, crate::catalog::AppId::Mcp)?
        .ok_or("This Hub has no verified built-in MCP runtime. Existing settings were kept.")?;
    let directory = candidate
        .path
        .parent()
        .ok_or("Invalid MCP payload location.")?
        .join("server");
    creator_works_mcp_launcher::service::initialize(handle, directory.clone())?;
    *root = Some(directory);
    Ok(())
}

#[cfg(feature = "integrated-features")]
pub(crate) fn mcp_is_idle(handle: &tauri::AppHandle) -> Result<bool, String> {
    let state = handle.state::<Features>();
    if state
        .mcp
        .lock()
        .map_err(|_| "MCP operation state is unavailable.")?
        .busy()
    {
        return Ok(false);
    }
    creator_works_mcp_launcher::service::is_idle(handle)
}

pub fn review_close(handle: &tauri::AppHandle) -> bool {
    #[cfg(not(feature = "integrated-features"))]
    {
        let _ = handle;
        false
    }
    #[cfg(feature = "integrated-features")]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let state = handle.state::<Features>();
        let Ok(operation) = state.mcp.try_lock() else {
            return false;
        };
        if !operation.can_review_close()
            || creator_works_mcp_launcher::service::worker_returned(handle) != Ok(true)
        {
            return false;
        }
        if state
            .close_review
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return true;
        }
        drop(operation);
        let app = handle.clone();
        handle.dialog()
            .message("MCP has an unfinished interface workflow, but its native operation has returned.\n\nClose Hub anyway? Earlier completed changes and recovery records will be kept. Nothing will be rolled back or marked successful. Existing AI connections, Unity and unrelated processes will not be stopped. Check the last outcome before repeating work.")
            .title("Close Creator Hub?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Close Hub".into(), "Keep open".into()))
            .show(move |approved| {
                let state = app.state::<Features>();
                state.close_review.store(false, std::sync::atomic::Ordering::SeqCst);
                if !approved { return; }
                let closed = state.mcp.try_lock().is_ok_and(|mut operation| {
                    operation.can_review_close()
                        && creator_works_mcp_launcher::service::worker_returned(&app) == Ok(true)
                        && operation.close_returned_workflow().is_ok()
                        && app.state::<crate::manager::Manager>().allow_close()
                });
                if closed { app.exit(0); }
                else {
                    use tauri::Emitter;
                    let _ = app.emit("close-blocked", "Hub is still working. Nothing was stopped or marked successful.");
                }
            });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_selection_is_finite_and_case_sensitive() {
        assert_eq!(
            serde_json::from_value::<Feature>(json!("setup")).unwrap(),
            Feature::Setup
        );
        assert_eq!(
            serde_json::from_value::<Feature>(json!("mcp")).unwrap(),
            Feature::Mcp
        );
        for unknown in ["exec", "MCP", "", "plugins", "../setup"] {
            assert!(serde_json::from_value::<Feature>(json!(unknown)).is_err());
        }
    }

    #[test]
    fn arguments_are_bounded_objects() {
        assert!(validate(&json!({})).is_ok());
        for value in [Value::Null, json!([]), json!(true), json!("path")] {
            assert!(validate(&value).is_err());
        }
        assert!(validate(&json!({"path": "x".repeat(60_000)})).is_err());
    }

    #[test]
    fn build_mode_is_explicit_and_does_not_probe_or_change_settings() {
        let status = feature_status();
        assert_eq!(status["integrated"], cfg!(feature = "integrated-features"));
        assert_eq!(
            status["features"].as_array().unwrap().len(),
            if cfg!(feature = "integrated-features") {
                2
            } else {
                0
            }
        );
    }

    #[test]
    fn visiting_home_does_not_forget_the_last_tool_for_an_approved_update() {
        let state = Features::default();
        state.select(None).unwrap();
        assert_eq!(*state.last_tool.lock().unwrap(), None);
        state.select(Some(Feature::Mcp)).unwrap();
        state.select(None).unwrap();
        assert_eq!(*state.last_tool.lock().unwrap(), Some(Feature::Mcp));
        state.select(Some(Feature::Setup)).unwrap();
        state.select(None).unwrap();
        assert_eq!(*state.last_tool.lock().unwrap(), Some(Feature::Setup));
    }

    #[test]
    fn a_panicked_handler_returns_unknown_without_replaying_or_claiming_success() {
        let calls = std::cell::Cell::new(0);
        let result = returned_result(|| {
            calls.set(calls.get() + 1);
            panic!("disposable MCP handler");
        });
        assert_eq!(calls.get(), 1);
        assert!(result.unwrap_err().contains("outcome is unknown"));
        assert_eq!(
            returned_result(|| Err("Original refusal".into())),
            Err("Original refusal".into())
        );
    }

    #[test]
    fn native_close_review_never_blocks_the_main_event_loop() {
        let source = include_str!("features.rs");
        let review = source
            .split("pub fn review_close(")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(!review.contains(".blocking_show("));
        assert!(review.contains(".show(move |approved|"));
        assert!(review.contains("if !approved"));
        assert_eq!(review.matches("service::worker_returned").count(), 2);
        assert!(review.contains("operation.close_returned_workflow().is_ok()"));
    }
}
