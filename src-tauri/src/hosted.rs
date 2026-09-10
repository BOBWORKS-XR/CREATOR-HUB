//! Per-app hosting preview. Only a build-pinned executable can supply UI or commands.
use crate::catalog::AppId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager as _};

pub const SETUP_COMMANDS: &[&str] = &[
    "get_recipe",
    "probe_environment",
    "pick_parent_folder",
    "create_project",
    "open_project",
    "launch_hub",
    "restart_hub",
    "register_project",
    "inspect_project",
    "run_existing_project",
    "open_official_url",
];
pub const MCP_COMMANDS: &[&str] = &[
    "get_hosted_snapshot",
    "pick_project_folder",
    "open_official_url",
];
const MCP_WRITABLE_COMMANDS: &[&str] = &[
    "begin_ui_operation",
    "finish_ui_operation",
    "load_config",
    "save_config",
    "discover_unity_projects",
    "get_onboarding_status",
    "add_project",
    "one_click_setup",
    "get_project_sdk_profile",
    "get_unity_extension_status",
    "update_configured_unity_extensions",
    "update_codex_mcp_config",
    "update_claude_mcp_config",
    "update_antigravity_mcp_config",
    "update_opencode_mcp_config",
    "remove_codex_mcp_config",
    "remove_claude_mcp_config",
    "remove_antigravity_mcp_config",
    "remove_opencode_mcp_config",
    "install_unity_extension",
    "set_unity_custom_scripts",
    "set_unity_allow_all_tests",
    "get_project_feedback_settings",
    "set_project_feedback_settings",
    "get_stable_release",
];
fn commands(app: AppId) -> &'static [&'static str] {
    match app {
        AppId::Setup => SETUP_COMMANDS,
        AppId::Mcp => MCP_COMMANDS,
    }
}
fn expected_hash(app: AppId) -> &'static str {
    match app {
        AppId::Setup => option_env!("CREATOR_SETUP_HOST_SHA256").unwrap_or(""),
        AppId::Mcp => option_env!("CREATOR_MCP_HOST_SHA256").unwrap_or(""),
    }
}
pub fn preview_mode(app: AppId) -> Option<&'static str> {
    // Build pins are preview authority, not capabilities of an installed app.
    if !crate::catalog::hash_valid(expected_hash(app)) {
        return None;
    }
    Some(
        if app == AppId::Mcp && option_env!("CREATOR_MCP_HOST_WRITABLE") != Some("1") {
            "read-only"
        } else {
            "writable"
        },
    )
}
const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_REQUEST: usize = 64 * 1024;
const MAX_LIFECYCLE_FRAME: usize = 512;
const MAX_SAFE_SEQUENCE: u64 = (1_u64 << 53) - 1;

fn initialize_args(read_only_events: bool) -> Value {
    if read_only_events {
        json!({"hostingRevision":2,"requestedMode":"read-only"})
    } else {
        json!({})
    }
}

fn lifecycle_sequence(
    frame: &Value,
    wire_bytes: usize,
    session: &str,
    previous: Option<u64>,
) -> Result<u64, String> {
    let invalid = || "Invalid or stale MCP lifecycle event.".to_owned();
    let envelope = frame.as_object().ok_or_else(invalid)?;
    let payload = frame["payload"].as_object().ok_or_else(invalid)?;
    let sequence = frame["payload"]["sequence"].as_u64().ok_or_else(invalid)?;
    let count = frame["payload"]["commandsInFlight"]
        .as_u64()
        .ok_or_else(invalid)?;
    let active = frame["payload"]["workflowActive"]
        .as_bool()
        .ok_or_else(invalid)?;
    let state = frame["payload"]["state"].as_str().ok_or_else(invalid)?;
    if wire_bytes > MAX_LIFECYCLE_FRAME
        || envelope.len() != 4
        || frame["type"] != "event"
        || frame["name"] != "creator-mcp-lifecycle"
        || frame["session"] != session
        || payload.len() != 5
        || frame["payload"]["revision"] != 1
        || sequence > MAX_SAFE_SEQUENCE
        || previous.is_some_and(|last| sequence <= last)
        || (previous.is_none() && sequence != 0)
        || count > u32::MAX as u64
        || !matches!(state, "idle" | "busy" | "draining")
        || (state == "idle" && (active || count != 0))
        || (state == "busy" && !active && count == 0)
    {
        return Err(invalid());
    }
    Ok(sequence)
}

#[derive(Default)]
pub struct Hosting(Mutex<Vec<Session>>);
struct Session {
    app: AppId,
    writable: bool,
    input: Option<ChildStdin>,
    replies: mpsc::Receiver<Result<Value, String>>,
    id: u64,
    nonce: String,
    operation: Arc<Mutex<crate::hosted_operation::SessionOperation<crate::manager::Operation>>>,
    _verified_executable: Arc<File>,
}
impl Drop for Session {
    fn drop(&mut self) {
        // EOF asks the backend to exit after its current operation. Never kill Unity work.
        self.input.take();
        if let Ok(mut operation) = self.operation.lock() {
            operation.disconnect();
        }
    }
}

fn verify_executable(path: &Path, expected: &str) -> Result<File, String> {
    if expected.len() != 64 || !expected.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("This Hub build has no approved payload for that hosted app.".into());
    }
    crate::platform::reject_links(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep the verified image locked against modification/replacement for the session.
        options.share_mode(1);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot lock the app executable for verification.")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect app executable.")?
        .len()
        > 128 * 1024 * 1024
    {
        return Err("App executable exceeds the size limit.".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot verify app executable.")?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err(
            "This is not the app build approved for this Hub preview. Nothing was launched.".into(),
        );
    }
    Ok(file)
}

fn read_frame(reader: &mut impl BufRead) -> Result<Option<(Value, usize)>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_FRAME + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "Hosted pipe read failed.")?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_FRAME || bytes.last() != Some(&b'\n') {
        return Err("Invalid or oversized hosted response.".into());
    }
    serde_json::from_slice(&bytes)
        .map(|frame| Some((frame, count)))
        .map_err(|_| "Invalid hosted response JSON.".into())
}

impl Session {
    fn send(&mut self, command: &str, args: Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(
            &json!({"protocol":1,"session":self.nonce,"id":self.id,"command":command,"args":args}),
        )
        .map_err(|_| "Cannot encode hosted request.")?;
        if bytes.len() + 1 > MAX_REQUEST {
            return Err("Hosted request exceeds 64 KiB. Nothing was sent.".into());
        }
        self.input
            .as_mut()
            .ok_or("Hosted app is disconnected.")?
            .write_all(&bytes)
            .and_then(|_| self.input.as_mut().unwrap().write_all(b"\n"))
            .and_then(|_| self.input.as_mut().unwrap().flush())
            .map_err(|_| {
                "Hosted app disconnected. Operation outcome is unknown; do not retry automatically."
                    .into()
            })
    }
    fn finish(&self, response: Value) -> Result<Value, String> {
        self.decode_response(response)?
    }
    fn decode_response(&self, response: Value) -> Result<Result<Value, String>, String> {
        if response["session"] != self.nonce || response["id"].as_u64() != Some(self.id) {
            return Err("Mismatched hosted response. No command was retried.".into());
        }
        match response["ok"].as_bool() {
            Some(true) if response.get("result").is_some() => Ok(Ok(response["result"].clone())),
            Some(false) if response["error"].is_string() => Ok(Err(response["error"]
                .as_str()
                .unwrap_or("Hosted app rejected the operation.")
                .to_owned())),
            _ => Err("Hosted app returned an invalid result.".into()),
        }
    }
}

impl Hosting {
    pub fn has_sessions(&self) -> bool {
        self.0.lock().map_or(true, |sessions| !sessions.is_empty())
    }
    pub fn start(
        &self,
        handle: &tauri::AppHandle,
        kind: AppId,
        path: &Path,
    ) -> Result<Value, String> {
        if !cfg!(windows) {
            return Err("Hosted native apps are currently Windows-only.".into());
        }
        let mut state = self.0.lock().map_err(|_| "Hosted state unavailable.")?;
        if state.iter().any(|session| session.app == kind) {
            return Err("This app is already open in Hub. Use its existing view.".into());
        }
        let verified = Arc::new(verify_executable(path, expected_hash(kind))?);
        // Neither a renderer argument nor installed presence can authorize hosting.
        let writable = kind == AppId::Mcp && option_env!("CREATOR_MCP_HOST_WRITABLE") == Some("1");
        let read_only_events = kind == AppId::Mcp
            && (writable || option_env!("CREATOR_MCP_HOST_READONLY_EVENTS") == Some("1"));
        let running = crate::platform::running(kind, path)?;
        // The MCP preview is read-only and does not take over its existing GUI or stdio servers.
        if !running.gui.is_empty() || ((kind == AppId::Setup || writable) && running.other_copy) {
            return Err(format!("{} is already running. Finish its work and close it before this hosting preview. No window was closed.", kind.name()));
        }
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "Cannot create a private session identity.")?;
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut command = Command::new(path);
        command
            .arg("--creator-hub-host")
            .current_dir(path.parent().ok_or("Invalid hosted app path.")?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", kind.name()))?;
        let input = child.stdin.take().ok_or("Missing hosted input pipe.")?;
        let output = child.stdout.take().ok_or("Missing hosted output pipe.")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Missing hosted diagnostic pipe.")?;
        let operation = Arc::new(Mutex::new(
            crate::hosted_operation::SessionOperation::default(),
        ));
        let process_operation = Arc::clone(&operation);
        let process_image = Arc::clone(&verified);
        std::thread::spawn(move || {
            // EOF/output failure is not exit. Hold both native authority and the
            // verified image until Windows confirms the backend actually drained.
            if child.wait().is_ok() {
                if let Ok(mut operation) = process_operation.lock() {
                    operation.backend_exited();
                }
            } else {
                // An uninspectable child is not safe to replace. Quarantine the
                // lease for this Hub process instead of pretending it is idle.
                std::mem::forget((process_operation, process_image));
            }
        });
        // Drain diagnostics independently; never mix them into RPC or retain unbounded logs.
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = [0u8; 4096];
            while matches!(reader.read(&mut buffer), Ok(1..)) {}
        });
        let (sender, receiver) = mpsc::sync_channel(4);
        let app = handle.clone();
        let session = nonce.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let mut last_event = std::time::Instant::now() - Duration::from_secs(1);
            let mut last_lifecycle_sequence = None;
            let failure = loop {
                match read_frame(&mut reader) {
                    Ok(Some((frame, wire_bytes))) if frame["session"] == session => {
                        if frame["type"] == "event" {
                            if kind == AppId::Mcp && read_only_events {
                                match lifecycle_sequence(&frame, wire_bytes, &session, last_lifecycle_sequence) {
                                    Ok(sequence) => last_lifecycle_sequence = Some(sequence),
                                    Err(error) => break error,
                                }
                                // Advisory only. Never release Manager's operation from an event.
                                let _ = app.emit("hosted-app-event", frame);
                            } else if kind == AppId::Setup && ["setup-progress", "existing-progress"].contains(&frame["name"].as_str().unwrap_or("")) && last_event.elapsed() >= Duration::from_millis(40) {
                                let _ = app.emit("hosted-app-event", frame);
                                last_event = std::time::Instant::now();
                            }
                        } else if sender.try_send(Ok(frame)).is_err() { break "Hosted response queue overflowed.".to_owned(); }
                    }
                    Ok(Some(_)) => break "Hosted app sent a mismatched session identity.".to_owned(),
                    Ok(None) => break "Hosted app disconnected. A running operation's outcome may be unknown; do not retry automatically.".to_owned(),
                    Err(error) => break error,
                }
            };
            let _ = sender.try_send(Err(failure.clone()));
            let _ = app.emit(
                "hosted-app-disconnected",
                json!({"session":session,"error":failure}),
            );
        });
        let mut backend = Session {
            app: kind,
            writable,
            input: Some(input),
            replies: receiver,
            id: 0,
            nonce,
            operation,
            _verified_executable: verified,
        };
        let hello = if writable {
            json!({"hostingRevision":2,"requestedMode":"writable"})
        } else {
            initialize_args(read_only_events)
        };
        backend.send("initialize", hello)?;
        let response = backend
            .replies
            .recv_timeout(Duration::from_secs(180))
            .map_err(|_| {
                "Hosted app did not finish opening. Close its consent dialog before retrying."
            })??;
        let result = backend.finish(response)?;
        if result["appId"] != kind.id() || result["protocol"] != 1 || !result["files"].is_object() {
            return Err("The app did not supply a compatible hosted interface.".into());
        }
        if read_only_events
            && (result["hostingRevision"] != 2
                || result["effectiveMode"] != if writable { "writable" } else { "read-only" })
        {
            return Err("MCP did not confirm the requested hosting mode.".into());
        }
        let mut result = json!({"session":backend.nonce,"appId":result["appId"],"version":result["version"],"files":result["files"]});
        if read_only_events {
            result["hostingRevision"] = json!(2);
            result["effectiveMode"] = json!(if writable { "writable" } else { "read-only" });
        }
        state.push(backend);
        Ok(result)
    }

    pub fn call(
        &self,
        manager: &crate::manager::Manager,
        session: &str,
        command: &str,
        args: Value,
    ) -> Result<Value, String> {
        let mut state = self.0.lock().map_err(|_| "Hosted state unavailable.")?;
        let backend = state
            .iter_mut()
            .find(|backend| backend.nonce == session)
            .ok_or("Stale hosted session. Nothing was sent.")?;
        if !(commands(backend.app).contains(&command)
            || (backend.app == AppId::Mcp
                && backend.writable
                && MCP_WRITABLE_COMMANDS.contains(&command)))
            || !args.is_object()
        {
            return Err("This command is not available to that hosted app.".into());
        }
        if backend.input.is_none() {
            return Err("Hosted app is disconnected. Nothing was sent.".into());
        }
        let next_id = backend
            .id
            .checked_add(1)
            .filter(|id| *id <= MAX_SAFE_SEQUENCE)
            .ok_or("Hosted session exhausted.")?;
        backend
            .operation
            .lock()
            .map_err(|_| "Hosted operation state unavailable.")?
            .begin(command, &args, || manager.begin())?;
        backend.id = next_id;
        let result = (|| {
            if command == "get_stable_release" {
                if args.as_object().is_none_or(|args| !args.is_empty()) {
                    return Ok(Err(
                        "Update checks do not accept URLs or other arguments.".into()
                    ));
                }
                // Fixed read-only endpoint. No cookies, caller URLs or renderer network access.
                return Ok((|| {
                    let client = crate::catalog::client()?;
                    let bytes = crate::catalog::fetch_small(&client,
                        "https://api.github.com/repos/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/latest", 512 * 1024)?;
                    serde_json::from_slice(&bytes).map_err(|_| "Invalid release metadata.".into())
                })());
            }
            backend.send(command, args)?;
            // No mutation timeout; lost output cannot release a still-running backend.
            let response = backend
                .replies
                .recv()
                .map_err(|_| "Hosted app disconnected; operation outcome is unknown.")??;
            backend.decode_response(response)
        })();
        match result {
            Ok(result) => {
                let completion = backend
                    .operation
                    .lock()
                    .map_err(|_| "Hosted operation state unavailable.")?
                    .complete(&result);
                if let Err(error) = completion {
                    backend.input.take();
                    return Err(error);
                }
                result
            }
            Err(error) => {
                if let Ok(mut operation) = backend.operation.lock() {
                    operation.disconnect();
                }
                backend.input.take();
                Err(error)
            }
        }
    }

    pub fn stop(&self, session: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "Hosted state unavailable.")?;
        let index = state
            .iter()
            .position(|backend| backend.nonce == session)
            .ok_or("Stale hosted session.")?;
        if state[index]
            .operation
            .lock()
            .map_err(|_| "Hosted operation state unavailable.")?
            .busy()
        {
            return Err("Finish the hosted workflow before closing this view.".into());
        }
        state.remove(index);
        Ok(())
    }
    pub fn close_idle(&self) {
        if let Ok(mut state) = self.0.try_lock() {
            state.retain(|session| {
                session
                    .operation
                    .lock()
                    .map_or(true, |operation| operation.busy())
            });
        }
    }
    pub fn abort_initialization(&self, session: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "Hosted state unavailable.")?;
        let index = state
            .iter()
            .position(|backend| backend.nonce == session && backend.id == 0)
            .ok_or("Only an unused hosted session can be aborted without confirmation.")?;
        state.remove(index);
        Ok(())
    }
}

#[tauri::command]
pub async fn abort_hosted_app(handle: tauri::AppHandle, session: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        let _operation = manager.begin()?;
        handle.state::<Hosting>().abort_initialization(&session)
    })
    .await
    .map_err(|_| "Hosted cleanup worker failed.")?
}

#[tauri::command]
pub async fn start_hosted_app(handle: tauri::AppHandle, app: AppId) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        let _operation = manager.begin()?;
        use tauri_plugin_dialog::DialogExt;
        let hub = std::env::current_exe().map_err(|_| "Cannot locate Hub.")?;
        let directory = hub.parent().ok_or("Invalid Hub location.")?;
        let adjacent = match app {
            AppId::Setup => directory.join(app.exe()),
            AppId::Mcp => directory.join("apps").join("mcp").join(app.exe()),
        };
        // The portable preview pair is discoverable, but still requires the exact pinned hash.
        let path = if adjacent.is_file() {
            adjacent
        } else {
            handle
                .dialog()
                .file()
                .add_filter("Verified Creator app preview", &["exe"])
                .blocking_pick_file()
                .ok_or("No app selected. Nothing changed.")?
                .into_path()
                .map_err(|_| "Choose a local Creator app executable.")?
        };
        handle.state::<Hosting>().start(&handle, app, &path)
    })
    .await
    .map_err(|_| "Hosted startup worker failed.")?
}
#[tauri::command]
pub async fn hosted_app_call(
    handle: tauri::AppHandle,
    session: String,
    command: String,
    args: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        handle
            .state::<Hosting>()
            .call(&manager, &session, &command, args)
    })
    .await
    .map_err(|_| "Hosted worker failed; operation outcome is unknown.")?
}
#[tauri::command]
pub async fn stop_hosted_app(handle: tauri::AppHandle, session: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        let _operation = manager.begin()?;
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        if !handle.dialog().message("Close this hosted app view? Unsaved form entries in this view will be discarded. Project files and the standalone app are unchanged.").title("Close hosted app?").buttons(MessageDialogButtons::OkCancelCustom("Close view".into(), "Keep open".into())).blocking_show() { return Ok(false); }
        handle.state::<Hosting>().stop(&session)?;
        Ok(true)
    }).await.map_err(|_| "Hosted close worker failed.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_session_identity_controls_authority_and_close_is_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test");
        std::fs::write(&path, b"test").unwrap();
        let fixture = |app, nonce: &str| Session {
            app,
            writable: false,
            input: None,
            replies: mpsc::sync_channel(1).1,
            id: 0,
            nonce: nonce.into(),
            operation: Arc::new(Mutex::new(
                crate::hosted_operation::SessionOperation::default(),
            )),
            _verified_executable: Arc::new(File::open(&path).unwrap()),
        };
        let hosting = Hosting(Mutex::new(vec![
            fixture(AppId::Mcp, "mcp"),
            fixture(AppId::Setup, "setup"),
        ]));
        let manager = crate::manager::Manager::default();
        for command in [
            "create_project",
            "probe_environment",
            "install_app",
            "save_config",
            "initialize",
        ] {
            assert_eq!(
                hosting
                    .call(&manager, "mcp", command, json!({}))
                    .unwrap_err(),
                "This command is not available to that hosted app."
            );
        }
        assert_eq!(
            hosting
                .call(&manager, "setup", "get_hosted_snapshot", json!({}))
                .unwrap_err(),
            "This command is not available to that hosted app."
        );
        assert!(hosting
            .call(&manager, "mcp", "get_hosted_snapshot", json!([]))
            .is_err());
        assert!(hosting
            .call(&manager, "mcp", "get_hosted_snapshot", json!({}))
            .unwrap_err()
            .contains("disconnected"));
        hosting.stop("mcp").unwrap();
        assert_eq!(hosting.0.lock().unwrap().len(), 1);
        assert_eq!(hosting.0.lock().unwrap()[0].app, AppId::Setup);
        assert!(hosting
            .call(&manager, "mcp", "get_hosted_snapshot", json!({}))
            .unwrap_err()
            .contains("Stale"));
        hosting.abort_initialization("setup").unwrap();
        assert!(hosting.0.lock().unwrap().is_empty());
    }
    #[test]
    fn frames_are_bounded_and_complete() {
        assert!(read_frame(&mut vec![b'x'; MAX_FRAME + 1].as_slice()).is_err());
        assert!(read_frame(&mut b"{}".as_slice()).is_err());
        assert_eq!(
            read_frame(&mut b"{}\n".as_slice()).unwrap(),
            Some((json!({}), 3))
        );
        assert_eq!(read_frame(&mut b"".as_slice()).unwrap(), None);
    }
    #[test]
    fn only_exact_pinned_files_can_start() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("setup.exe");
        std::fs::write(&path, b"test").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"test"));
        assert!(verify_executable(&path, &hash).is_ok());
        assert!(verify_executable(&path, &"0".repeat(64)).is_err());
        assert!(verify_executable(&path, "").is_err());
    }
    #[test]
    fn lifecycle_preview_never_requests_writable_mode() {
        assert_eq!(initialize_args(false), json!({}));
        assert_eq!(
            initialize_args(true),
            json!({"hostingRevision":2,"requestedMode":"read-only"})
        );
        assert!(!MCP_COMMANDS.contains(&"begin_ui_operation"));
        assert!(!MCP_COMMANDS.contains(&"save_config"));
    }
    #[test]
    fn lifecycle_events_require_bounded_ordered_native_envelopes() {
        let frame = json!({"type":"event","name":"creator-mcp-lifecycle","session":"native-session",
            "payload":{"revision":1,"sequence":0,"state":"idle","workflowActive":false,"commandsInFlight":0}});
        assert_eq!(
            lifecycle_sequence(&frame, 512, "native-session", None).unwrap(),
            0
        );
        assert!(lifecycle_sequence(&frame, 513, "native-session", None).is_err());
        assert!(lifecycle_sequence(&frame, 200, "different-session", None).is_err());
        assert!(lifecycle_sequence(&frame, 200, "native-session", Some(0)).is_err());
        let mut next = frame.clone();
        next["payload"]["sequence"] = json!(1);
        next["payload"]["state"] = json!("busy");
        next["payload"]["commandsInFlight"] = json!(1);
        assert_eq!(
            lifecycle_sequence(&next, 200, "native-session", Some(0)).unwrap(),
            1
        );
        next["payload"]["state"] = json!("draining");
        assert!(lifecycle_sequence(&next, 200, "native-session", Some(0)).is_ok());
        for (key, value) in [
            ("revision", json!(2)),
            ("sequence", json!(-1)),
            ("sequence", json!(0.5)),
            ("sequence", json!(MAX_SAFE_SEQUENCE + 1)),
            ("state", json!("unknown")),
            ("workflowActive", Value::Null),
            ("commandsInFlight", json!(u32::MAX as u64 + 1)),
            ("commandsInFlight", json!(1)),
            ("unexpected", json!(true)),
        ] {
            let mut invalid = frame.clone();
            invalid["payload"][key] = value;
            assert!(
                lifecycle_sequence(&invalid, 200, "native-session", None).is_err(),
                "{key}"
            );
        }
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.resize(512, b' ');
        bytes.push(b'\n');
        let (parsed, wire_bytes) = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(wire_bytes, 513);
        assert!(lifecycle_sequence(&parsed, wire_bytes, "native-session", None).is_err());
    }
    #[test]
    fn unknown_commands_and_stale_sessions_never_execute() {
        let hosting = Hosting::default();
        for command in ["install_app", "open_app", "execute", "shutdown"] {
            assert!(hosting
                .call(
                    &crate::manager::Manager::default(),
                    "fake",
                    command,
                    json!({})
                )
                .is_err());
        }
        assert!(hosting
            .call(
                &crate::manager::Manager::default(),
                "fake",
                "probe_environment",
                json!({})
            )
            .is_err());
        assert!(hosting.stop("fake").is_err());
    }
}
