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
    time::{Duration, Instant},
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
pub fn preview_compatibility(app: AppId, installed_hash: &str) -> Option<bool> {
    compatible_hash(expected_hash(app), installed_hash)
}
fn compatible_hash(expected: &str, installed: &str) -> Option<bool> {
    // Inventory guidance only. Startup still locks and re-verifies the actual file.
    crate::catalog::hash_valid(expected).then_some(expected == installed)
}
const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_REQUEST: usize = 64 * 1024;
const MAX_LIFECYCLE_FRAME: usize = 512;
const MAX_SAFE_SEQUENCE: u64 = (1_u64 << 53) - 1;

#[derive(Default)]
struct SetupProgressGate {
    last_sent: [Option<Instant>; 3],
}
impl SetupProgressGate {
    fn accept(&mut self, frame: &Value, session: &str, now: Instant) -> bool {
        if frame["type"] != "event" || frame["session"] != session {
            return false;
        }
        let slot = match frame["name"].as_str() {
            Some("setup-progress") => 0,
            Some("existing-progress") => 1,
            Some("requirements-progress") => 2,
            _ => return false,
        };
        // Each bounded stream gets its first event, including an immediate stage handoff.
        if self.last_sent[slot]
            .is_some_and(|last| now.duration_since(last) < Duration::from_millis(40))
        {
            return false;
        }
        self.last_sent[slot] = Some(now);
        true
    }
}

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
    connection: Arc<SessionConnection>,
    replies: mpsc::Receiver<Result<Value, String>>,
    id: u64,
    nonce: String,
    _verified_executable: Arc<File>,
}
#[derive(Default)]
struct SessionConnection {
    input: Mutex<Option<ChildStdin>>,
    operation: Mutex<crate::hosted_operation::SessionOperation<crate::manager::Operation>>,
}
impl SessionConnection {
    fn disconnect(&self) {
        if let Ok(mut operation) = self.operation.lock() {
            operation.disconnect();
        }
        if let Ok(mut input) = self.input.lock() {
            input.take();
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        // EOF asks the backend to exit after its current operation. Never kill Unity work.
        self.connection.disconnect();
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

fn receive_output(
    mut reader: impl BufRead,
    kind: AppId,
    read_only_events: bool,
    session: &str,
    sender: &mpsc::SyncSender<Result<Value, String>>,
    connection: &SessionConnection,
    mut emit: impl FnMut(Value),
) -> String {
    let mut setup_progress = SetupProgressGate::default();
    let mut last_lifecycle_sequence = None;
    let failure = loop {
        match read_frame(&mut reader) {
            Ok(Some((frame, wire_bytes))) if frame["session"] == session => {
                if frame["type"] == "event" {
                    if kind == AppId::Mcp && read_only_events {
                        match lifecycle_sequence(&frame, wire_bytes, session, last_lifecycle_sequence) {
                            Ok(sequence) => last_lifecycle_sequence = Some(sequence),
                            Err(error) => break error,
                        }
                        // Advisory only. Never release Manager's operation from an event.
                        emit(frame);
                    } else if kind == AppId::Setup
                        && setup_progress.accept(&frame, session, Instant::now())
                    {
                        emit(frame);
                    }
                } else if sender.try_send(Ok(frame)).is_err() {
                    break "Hosted response queue overflowed.".to_owned();
                }
            }
            Ok(Some(_)) => break "Hosted app sent a mismatched session identity.".to_owned(),
            Ok(None) => break "Hosted app disconnected. A running operation's outcome may be unknown; do not retry automatically.".to_owned(),
            Err(error) => break error,
        }
    };
    // A reader can fail between requests, with nobody waiting for a reply.
    // Signal EOF independently of the Session lock; retain the lease until exit.
    // Close the unusable output pipe before waiting on a concurrent input writer.
    drop(reader);
    connection.disconnect();
    failure
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
        let mut input = self
            .connection
            .input
            .lock()
            .map_err(|_| "Hosted input state unavailable.")?;
        let input = input.as_mut().ok_or("Hosted app is disconnected.")?;
        input
            .write_all(&bytes)
            .and_then(|_| input.write_all(b"\n"))
            .and_then(|_| input.flush())
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
        let connection = Arc::new(SessionConnection {
            input: Mutex::new(Some(input)),
            ..Default::default()
        });
        let process_connection = Arc::clone(&connection);
        let process_image = Arc::clone(&verified);
        std::thread::spawn(move || {
            // EOF/output failure is not exit. Hold both native authority and the
            // verified image until Windows confirms the backend actually drained.
            if child.wait().is_ok() {
                if let Ok(mut operation) = process_connection.operation.lock() {
                    operation.backend_exited();
                }
            } else {
                // An uninspectable child is not safe to replace. Quarantine the
                // lease for this Hub process instead of pretending it is idle.
                std::mem::forget((process_connection, process_image));
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
        let output_connection = Arc::clone(&connection);
        std::thread::spawn(move || {
            let failure = receive_output(
                BufReader::new(output),
                kind,
                read_only_events,
                &session,
                &sender,
                &output_connection,
                |frame| {
                    let _ = app.emit("hosted-app-event", frame);
                },
            );
            let _ = sender.try_send(Err(failure.clone()));
            let _ = app.emit(
                "hosted-app-disconnected",
                json!({"session":session,"error":failure}),
            );
        });
        let mut backend = Session {
            app: kind,
            writable,
            connection,
            replies: receiver,
            id: 0,
            nonce,
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
        if backend
            .connection
            .input
            .lock()
            .map_err(|_| "Hosted input state unavailable.")?
            .is_none()
        {
            return Err("Hosted app is disconnected. Nothing was sent.".into());
        }
        let next_id = backend
            .id
            .checked_add(1)
            .filter(|id| *id <= MAX_SAFE_SEQUENCE)
            .ok_or("Hosted session exhausted.")?;
        backend
            .connection
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
                    .connection
                    .operation
                    .lock()
                    .map_err(|_| "Hosted operation state unavailable.")?
                    .complete(&result);
                if let Err(error) = completion {
                    backend.connection.disconnect();
                    return Err(error);
                }
                result
            }
            Err(error) => {
                backend.connection.disconnect();
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
            .connection
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
                    .connection
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
        // Reuse the user's verified selection. Hosting still requires the exact build pin.
        let path = if let Some(installed) = manager.hosted_candidate(app)? {
            installed
        } else if adjacent.is_file() {
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
    #[cfg(windows)]
    #[test]
    fn broken_output_between_workflow_requests_drains_input_without_releasing_update_guard() {
        assert_broken_output_drains(true);
    }

    #[cfg(windows)]
    #[test]
    fn broken_output_during_command_drains_input_without_releasing_update_guard() {
        assert_broken_output_drains(false);
    }

    #[cfg(windows)]
    fn assert_broken_output_drains(between_requests: bool) {
        use std::os::windows::process::CommandExt;
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                // This is only the disposable child created by this test.
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let drained = temp.path().join("drained.txt");
        let release = temp.path().join("release.txt");
        let mut fixture = Fixture(Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "[Console]::Out.WriteLine('{not-json}'); [Console]::Out.Flush(); $null = [Console]::In.ReadToEnd(); [IO.File]::WriteAllText($env:CREATOR_TEST_DRAINED, 'accepted work finished'); while (-not [IO.File]::Exists($env:CREATOR_TEST_RELEASE)) { Start-Sleep -Milliseconds 20 }"])
            .env("CREATOR_TEST_DRAINED", &drained)
            .env("CREATOR_TEST_RELEASE", &release)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .creation_flags(0x08000000).spawn().unwrap());
        let manager = crate::manager::Manager::default();
        let connection = Arc::new(SessionConnection {
            input: Mutex::new(fixture.0.stdin.take()),
            ..Default::default()
        });
        connection
            .operation
            .lock()
            .unwrap()
            .begin("begin_ui_operation", &json!({}), || {
                Ok(manager
                    .fixture_operation(File::create(temp.path().join("operation.lock")).unwrap()))
            })
            .unwrap();
        if between_requests {
            connection
                .operation
                .lock()
                .unwrap()
                .complete(&Ok(json!(7)))
                .unwrap();
        }
        let (sender, receiver) = mpsc::sync_channel(4);
        let image = temp.path().join("image-fixture");
        std::fs::write(&image, b"fixture").unwrap();
        let mut backend = Session {
            app: AppId::Mcp,
            writable: true,
            connection: Arc::clone(&connection),
            replies: receiver,
            id: 1,
            nonce: "fixture".into(),
            _verified_executable: Arc::new(File::open(image).unwrap()),
        };
        let failure = receive_output(
            BufReader::new(fixture.0.stdout.take().unwrap()),
            AppId::Mcp,
            true,
            "fixture",
            &sender,
            &connection,
            |_| panic!("Invalid output must not emit an event"),
        );
        assert!(failure.contains("Invalid hosted response JSON"));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !drained.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            drained.exists(),
            "Hub left stdin open after its output reader failed"
        );
        assert!(backend
            .send("get_hosted_snapshot", json!({}))
            .unwrap_err()
            .contains("disconnected"));
        assert!(!manager.allow_close());
        assert!(
            manager.begin().is_err(),
            "An update must not overlap the draining backend"
        );
        assert!(
            fixture.0.try_wait().unwrap().is_none(),
            "Draining is not a forced kill"
        );
        std::fs::write(&release, b"exit normally").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while fixture.0.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(fixture
            .0
            .try_wait()
            .unwrap()
            .is_some_and(|status| status.success()));
        connection.operation.lock().unwrap().backend_exited();
        assert!(!manager.busy());
        assert!(manager.allow_close());
        drop(backend);
    }

    #[test]
    fn every_terminal_output_route_disables_new_requests_and_keeps_active_authority() {
        let reply = "{\"session\":\"fixture\",\"id\":1,\"ok\":true,\"result\":null}\n";
        let cases = [
            (String::new(), "disconnected"),
            ("not json\n".into(), "JSON"),
            ("{}\n".into(), "mismatched"),
            ("{}".into(), "oversized"),
            ("x".repeat(MAX_FRAME + 1), "oversized"),
            (
                "{\"type\":\"event\",\"session\":\"fixture\"}\n".into(),
                "lifecycle",
            ),
            (reply.repeat(5), "overflowed"),
        ];
        let temp = tempfile::tempdir().unwrap();
        for (index, (bytes, expected)) in cases.into_iter().enumerate() {
            let manager = crate::manager::Manager::default();
            let connection = SessionConnection::default();
            connection
                .operation
                .lock()
                .unwrap()
                .begin("begin_ui_operation", &json!({}), || {
                    Ok(manager.fixture_operation(
                        File::create(temp.path().join(index.to_string())).unwrap(),
                    ))
                })
                .unwrap();
            connection
                .operation
                .lock()
                .unwrap()
                .complete(&Ok(json!(7)))
                .unwrap();
            let (sender, _receiver) = mpsc::sync_channel(4);
            let failure = receive_output(
                bytes.as_bytes(),
                AppId::Mcp,
                true,
                "fixture",
                &sender,
                &connection,
                |_| panic!("No valid event expected"),
            );
            assert!(failure.contains(expected), "{index}: {failure}");
            assert!(connection
                .operation
                .lock()
                .unwrap()
                .begin("get_hosted_snapshot", &json!({}), || panic!(
                    "Never reserve work on a failed connection"
                ))
                .is_err());
            assert!(manager.busy());
            connection.disconnect();
            assert!(
                manager.busy(),
                "Repeated disconnect must not release the lease"
            );
            connection.operation.lock().unwrap().backend_exited();
            assert!(!manager.busy());
        }
    }

    #[test]
    fn read_error_disconnects_only_its_own_session() {
        struct BrokenPipe;
        impl Read for BrokenPipe {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        let connection = SessionConnection::default();
        let unaffected = SessionConnection::default();
        let (sender, _receiver) = mpsc::sync_channel(4);
        let failure = receive_output(
            BufReader::new(BrokenPipe),
            AppId::Setup,
            false,
            "fixture",
            &sender,
            &connection,
            |_| panic!(),
        );
        assert_eq!(failure, "Hosted pipe read failed.");
        assert!(connection
            .operation
            .lock()
            .unwrap()
            .begin("probe_environment", &json!({}), || panic!())
            .is_err());
        assert_eq!(
            unaffected
                .operation
                .lock()
                .unwrap()
                .begin("probe_environment", &json!({}), || Err(
                    "unaffected session still accepts reservation".into()
                ))
                .unwrap_err(),
            "unaffected session still accepts reservation"
        );
    }

    #[test]
    fn output_pipe_is_dropped_before_waiting_for_the_input_lock() {
        struct NotifyDrop(mpsc::SyncSender<()>);
        impl Read for NotifyDrop {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        impl Drop for NotifyDrop {
            fn drop(&mut self) {
                let _ = self.0.try_send(());
            }
        }
        let connection = Arc::new(SessionConnection::default());
        let input = connection.input.lock().unwrap();
        let reader_connection = Arc::clone(&connection);
        let (dropped, observed_drop) = mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let (sender, _receiver) = mpsc::sync_channel(4);
            receive_output(
                BufReader::new(NotifyDrop(dropped)),
                AppId::Mcp,
                true,
                "fixture",
                &sender,
                &reader_connection,
                |_| panic!(),
            )
        });
        let dropped_before_unlock = observed_drop.recv_timeout(Duration::from_secs(3)).is_ok();
        drop(input);
        assert_eq!(reader.join().unwrap(), "Hosted pipe read failed.");
        assert!(
            dropped_before_unlock,
            "Drop stdout before waiting for a concurrent writer"
        );
    }

    #[test]
    fn hosted_compatibility_requires_an_approved_matching_hash() {
        let expected = "a".repeat(64);
        assert_eq!(compatible_hash(&expected, &expected), Some(true));
        assert_eq!(compatible_hash(&expected, &"b".repeat(64)), Some(false));
        assert_eq!(compatible_hash(&expected, ""), Some(false));
        assert_eq!(compatible_hash("", ""), None);
        assert_eq!(compatible_hash("invalid", "invalid"), None);
    }
    #[test]
    fn stored_session_identity_controls_authority_and_close_is_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test");
        std::fs::write(&path, b"test").unwrap();
        let fixture = |app, nonce: &str| Session {
            app,
            writable: false,
            connection: Arc::new(SessionConnection::default()),
            replies: mpsc::sync_channel(1).1,
            id: 0,
            nonce: nonce.into(),
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
        assert_eq!(
            hosting
                .call(&manager, "setup", "requirements-progress", json!({}))
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
    fn setup_progress_preserves_immediate_requirements_to_creation_handoff() {
        let mut gate = SetupProgressGate::default();
        let now = Instant::now();
        let requirements = json!({
            "type":"event", "session":"setup", "name":"requirements-progress",
            "payload":{"stage":"Requirements ready", "detail":"Licence checked", "percent":null}
        });
        let creation = json!({
            "type":"event", "session":"setup", "name":"setup-progress",
            "payload":{"step":1,"detail":"Creating project"}
        });
        assert!(gate.accept(&requirements, "setup", now));
        assert!(gate.accept(&creation, "setup", now));
        assert!(!gate.accept(&requirements, "setup", now + Duration::from_millis(39)));
        assert!(!gate.accept(&creation, "setup", now + Duration::from_millis(39)));
        assert!(gate.accept(&requirements, "setup", now + Duration::from_millis(40)));
        assert!(gate.accept(&creation, "setup", now + Duration::from_millis(40)));
    }
    #[test]
    fn setup_progress_rejects_invalid_envelopes_without_spending_valid_budget() {
        let valid = json!({
            "type":"event", "session":"setup", "name":"requirements-progress",
            "payload":{"stage":"Downloading", "detail":"Unity Editor", "percent":42}
        });
        let now = Instant::now();
        for (field, value) in [
            ("session", json!("mcp")),
            ("session", Value::Null),
            ("type", json!("result")),
            ("type", Value::Null),
            ("name", json!("unknown-progress")),
            ("name", json!("creator-mcp-lifecycle")),
            ("name", Value::Null),
            ("name", json!(42)),
        ] {
            let mut gate = SetupProgressGate::default();
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(!gate.accept(&invalid, "setup", now));
            assert!(gate.accept(&valid, "setup", now));
        }
    }
    #[test]
    fn setup_progress_flood_stays_bounded_per_allowlisted_type() {
        let mut gate = SetupProgressGate::default();
        let names = [
            "setup-progress",
            "existing-progress",
            "requirements-progress",
        ];
        let mut counts = [0; 3];
        let start = Instant::now();
        for milliseconds in 0..120 {
            let now = start + Duration::from_millis(milliseconds);
            for (slot, name) in names.iter().enumerate() {
                let frame = json!({"type":"event", "session":"setup", "name":name});
                if gate.accept(&frame, "setup", now) {
                    counts[slot] += 1;
                }
            }
            let unknown = json!({"type":"event", "session":"setup", "name":"other"});
            assert!(!gate.accept(&unknown, "setup", now));
        }
        assert_eq!(counts, [3; 3]);
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
