//! Session-authorized MCP adapter for the suite's inherited-pipe preview protocol.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;

#[cfg(unix)]
#[path = "hosted_unix.rs"]
mod unix_boundary;

const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_CONFIG: usize = 256 * 1024;
const MAX_ID: u64 = 9_007_199_254_740_991;
pub const COMMANDS: &[&str] = &[
    "get_hosted_snapshot",
    "pick_project_folder",
    "open_official_url",
];
const OFFICIAL_URLS: &[&str] = &[
    "https://claude.ai/download",
    "https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package",
    "https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP",
    "https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases",
    "https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases",
    "https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md",
];

fn official_url(url: &str) -> bool {
    if OFFICIAL_URLS.contains(&url) {
        return true;
    }
    let Some(tag) =
        url.strip_prefix("https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/")
    else {
        return false;
    };
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let parts: Vec<_> = version.split('.').collect();
    version.len() <= 80
        && parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|c| c.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    session: String,
    id: u64,
    command: String,
    args: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InitializeArgs {
    hosting_revision: u32,
    requested_mode: String,
    #[serde(default)]
    managed_routing: bool,
    #[cfg(unix)]
    #[serde(default)]
    resource_directory: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkflowArgs {
    id: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlArgs {
    url: String,
}

struct Permission {
    writable: bool,
    journal: Option<crate::hosted_journal::Journal>,
    #[cfg(any(windows, unix))]
    _owner: Option<crate::gui_owner::GuiWriteOwner>,
    _payload: Vec<std::fs::File>,
}

impl Permission {
    fn ensure_current(&self) -> Result<(), String> {
        #[cfg(unix)]
        unix_boundary::ensure_owner(
            self.writable,
            self._owner
                .as_ref()
                .is_some_and(|owner| owner.ensure_current().is_ok()),
        )?;
        Ok(())
    }

    fn read_only() -> Self {
        Self {
            writable: false,
            journal: None,
            #[cfg(any(windows, unix))]
            _owner: None,
            _payload: Vec::new(),
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|_| "Invalid hosted command arguments.".into())
}

fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_REQUEST + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "Cannot read hosted request.")?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_REQUEST || bytes.last() != Some(&b'\n') {
        return Err("Oversized or incomplete hosted request.".into());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "Invalid hosted request.")?;
    if request.protocol != 1
        || request.session.len() != 64
        || !request.session.bytes().all(|c| c.is_ascii_hexdigit())
        || request.id > MAX_ID
        || !request.args.is_object()
    {
        return Err("Invalid hosted protocol, session or request ID.".into());
    }
    Ok(Some(request))
}

fn send(
    output: &mut impl Write,
    session: &str,
    id: u64,
    result: Result<Value, String>,
) -> Result<(), String> {
    let response = match result {
        Ok(value) => json!({"session": session, "id": id, "ok": true, "result": value}),
        Err(error) => json!({"session": session, "id": id, "ok": false, "error": error}),
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|_| "Cannot encode hosted response.")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_RESPONSE {
        return Err("Hosted response exceeds the size limit.".into());
    }
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .map_err(|_| "Host disconnected; no request will be replayed.".into())
}

fn assets(context: &tauri::Context<tauri::Wry>) -> Result<BTreeMap<String, String>, String> {
    let mut files = BTreeMap::new();
    let mut total = 0;
    for (key, _) in context.assets().iter() {
        // Assets::iter exposes compressed release bytes; get decodes them.
        let bytes = context
            .assets()
            .get(&key.as_ref().into())
            .ok_or("Cannot decode MCP asset.")?;
        let name = key.to_string().trim_start_matches('/').to_owned();
        if name.contains("..")
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/_-.".contains(&c))
        {
            return Err("Invalid bundled asset name.".into());
        }
        let encoded = STANDARD.encode(bytes);
        total += name.len() + encoded.len() + 6;
        if total > MAX_RESPONSE - 4096 {
            return Err("Bundled UI exceeds the preview size limit.".into());
        }
        files.insert(name, encoded);
    }
    Ok(files)
}

pub(crate) fn config_snapshot(
    current: &Path,
    legacy: &Path,
) -> Result<(Option<crate::LauncherConfig>, &'static str), String> {
    for (path, source) in [(current, "current"), (legacy, "legacy (not migrated)")] {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err("Cannot read saved MCP configuration; it was left unchanged.".into())
            }
        };
        let mut bytes = Vec::new();
        file.take((MAX_CONFIG + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read saved MCP configuration.")?;
        if bytes.len() > MAX_CONFIG {
            return Err("Saved configuration exceeds the preview size limit.".into());
        }
        let config: crate::LauncherConfig = serde_json::from_slice(&bytes)
            .map_err(|_| "Saved configuration is invalid; it was left unchanged.")?;
        if config.channels.len() > 256 {
            return Err("Too many projects for this bounded preview.".into());
        }
        return Ok((Some(config), source));
    }
    Ok((None, "none"))
}

pub(crate) fn dispatch(app: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    #[cfg(unix)]
    if command == "bind_verified_resources" {
        // Only serve_authorized's validated initializer can reach this branch.
        let args = decode::<ResourceArgs>(args)?;
        let root = crate::hosted_payload::Root::verified(args.resource_directory.join("server"))?;
        if !app.manage(root) {
            return Err("Hosted resource authority already exists.".into());
        }
        return Ok(json!({}));
    }
    if command == "bind_managed_route" {
        decode::<NoArgs>(args)?;
        crate::managed_client::bind(app)?;
        return Ok(json!({}));
    }
    let _command = crate::lifecycle::LIFECYCLE
        .command()
        .map_err(String::from)?;
    match command {
        "get_hosted_snapshot" => {
            decode::<NoArgs>(args)?;
            // No get_config_path, root resolver, migrating loaders or client config readers.
            let base = dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?;
            let (config, source) = config_snapshot(
                &base
                    .join(crate::APP_CONFIG_DIR)
                    .join("launcher-config.json"),
                &base
                    .join(crate::LEGACY_APP_CONFIG_DIR)
                    .join("launcher-config.json"),
            )?;
            Ok(
                json!({ "config": config, "source": source, "readOnly": true,
                "resourceDir": snapshot_resource_directory(
                    app.try_state::<crate::hosted_payload::Root>().as_deref(),
                    || app.path().resource_dir().map_err(|_| "Cannot locate MCP resources.".into()),
                )? }),
            )
        }
        "pick_project_folder" => {
            decode::<NoArgs>(args)?;
            let selection = app
                .dialog()
                .file()
                .set_title("Select a folder (read-only preview)")
                .blocking_pick_folder();
            Ok(json!(selection.map(|path| path.to_string())))
        }
        "open_official_url" => {
            let url = decode::<UrlArgs>(args)?.url;
            if !official_url(&url) {
                return Err("Only fixed official Creator Works links are allowed.".into());
            }
            // Keep the same shell plugin used by standalone; do not add another opener dependency.
            #[allow(deprecated)]
            app.shell()
                .open(url, None)
                .map_err(|_| "Cannot open official page.")?;
            Ok(Value::Null)
        }
        _ => crate::hosted_commands::dispatch(app, command, args),
    }
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResourceArgs {
    resource_directory: PathBuf,
}

fn snapshot_resource_directory(
    _root: Option<&crate::hosted_payload::Root>,
    fallback: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    #[cfg(unix)]
    if let Some(root) = _root {
        return root
            .0
            .parent()
            .map(Path::to_owned)
            .ok_or_else(|| "Cannot locate MCP resources.".into());
    }
    fallback()
}

#[cfg(test)]
fn serve(
    input: &mut impl BufRead,
    output: &mut impl Write,
    files: BTreeMap<String, String>,
    approve: impl FnOnce() -> bool,
    call: impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<(), String> {
    serve_authorized(
        input,
        output,
        files,
        |writable| {
            if writable {
                return Err("Writable hosting was not authorized.".into());
            }
            if approve() {
                Ok(Permission::read_only())
            } else {
                Err("Opening MCP in Hub was declined. Standalone MCP is unchanged.".into())
            }
        },
        call,
    )
}

fn serve_authorized(
    input: &mut impl BufRead,
    output: &mut impl Write,
    files: BTreeMap<String, String>,
    approve: impl FnOnce(bool) -> Result<Permission, String>,
    mut call: impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<(), String> {
    let hello = read_request(input)?.ok_or("Host disconnected before initialization.")?;
    if hello.id != 0 || hello.command != "initialize" {
        return Err("Expected hosted initialization.".into());
    }
    let (lifecycle_events, writable, managed, resource_directory) =
        if hello.args.as_object().is_some_and(|args| args.is_empty()) {
            (false, false, false, None)
        } else {
            let args = decode::<InitializeArgs>(hello.args)?;
            #[cfg(unix)]
            let resource_directory = args.resource_directory;
            #[cfg(not(unix))]
            let resource_directory: Option<PathBuf> = None;
            if args.hosting_revision != 2
                || !["read-only", "writable"].contains(&args.requested_mode.as_str())
                || args.managed_routing && args.requested_mode != "writable"
                || resource_directory.as_ref().is_some_and(|directory| {
                    !directory.is_absolute()
                        || directory
                            .components()
                            .any(|part| matches!(part, std::path::Component::ParentDir))
                })
            {
                return Err("Unsupported hosting revision or mode.".into());
            }
            (
                true,
                args.requested_mode == "writable",
                args.managed_routing,
                resource_directory,
            )
        };
    #[cfg(unix)]
    unix_boundary::require_managed_route(writable, managed)?;
    if let Some(directory) = resource_directory {
        if let Err(error) = call(
            "bind_verified_resources",
            json!({"resourceDirectory": directory}),
        ) {
            send(output, &hello.session, 0, Err(error))?;
            return Ok(());
        }
    }
    let mut permission = match approve(writable) {
        Ok(permission) if permission.writable == writable => permission,
        Ok(_) => return Err("Hosting permission does not match the requested mode.".into()),
        Err(error) => {
            send(output, &hello.session, 0, Err(error))?;
            return Ok(());
        }
    };
    if let Err(error) = permission.ensure_current() {
        send(output, &hello.session, 0, Err(error))?;
        return Ok(());
    }
    if managed {
        if let Err(error) = call("bind_managed_route", json!({})) {
            send(output, &hello.session, 0, Err(error))?;
            return Ok(());
        }
    }
    let mut initialization = json!({"appId": "creator-works-mcp", "version": env!("CARGO_PKG_VERSION"), "protocol": 1, "files": files});
    if lifecycle_events {
        initialization["hostingRevision"] = json!(2);
        initialization["effectiveMode"] = json!(if writable { "writable" } else { "read-only" });
    }
    send(output, &hello.session, 0, Ok(initialization))?;
    let mut native_session = if permission.writable {
        crate::hosted_lifecycle::HostedSession::writable(
            &crate::lifecycle::LIFECYCLE,
            &hello.session,
        )?
    } else {
        crate::hosted_lifecycle::HostedSession::read_only(
            &crate::lifecycle::LIFECYCLE,
            &hello.session,
        )?
    };
    if lifecycle_events {
        output
            .write_all(&native_session.event()?)
            .and_then(|_| output.flush())
            .map_err(|_| "Host disconnected before ready state.")?;
    }
    let mut previous_id = 0;
    while let Some(request) = read_request(input)? {
        if request.session != hello.session || request.id <= previous_id {
            return Err("Mismatched or replayed hosted request.".into());
        }
        previous_id = request.id;
        if !(COMMANDS.contains(&request.command.as_str())
            || writable && crate::hosted_commands::COMMANDS.contains(&request.command.as_str()))
        {
            return Err("Unknown hosted MCP command.".into());
        }
        if crate::hosted_commands::needs_workflow(&request.command)
            && !native_session.has_workflow()
        {
            send(
                output,
                &hello.session,
                request.id,
                Err("Start an owned UI workflow before changing MCP settings or projects.".into()),
            )?;
            continue;
        }
        native_session.begin_command(request.id, &request.command)?;
        if lifecycle_events {
            output
                .write_all(&native_session.event()?)
                .and_then(|_| output.flush())
                .map_err(|_| "Host disconnected before dispatch; command was not invoked.")?;
        }
        // Event delivery can wait; check advisory ownership after it, before
        // recording acceptance or invoking any command (including read helpers).
        if let Err(error) = permission.ensure_current() {
            send(output, &hello.session, request.id, Err(error))?;
            return Ok(());
        }
        let changes = crate::hosted_commands::needs_workflow(&request.command);
        if changes {
            if let Some(journal) = &mut permission.journal {
                journal.begin(&hello.session, request.id, &request.command)?;
            }
        }
        let result = match request.command.as_str() {
            "begin_ui_operation" => decode::<NoArgs>(request.args).and_then(|_| {
                native_session
                    .begin_workflow()
                    .map(|id| json!(id))
                    .map_err(String::from)
            }),
            "finish_ui_operation" => decode::<WorkflowArgs>(request.args).and_then(|args| {
                native_session
                    .finish_workflow(args.id)
                    .map(|_| Value::Null)
                    .map_err(String::from)
            }),
            _ => call(&request.command, request.args),
        };
        if changes {
            if let Some(journal) = &mut permission.journal {
                journal.complete(&hello.session, request.id, result.is_ok())?;
            }
        }
        native_session.complete_command(result.is_ok())?;
        // Complete an accepted command before observing EOF; never replay after a lost reply.
        send(output, &hello.session, request.id, result)?;
        if lifecycle_events {
            output
                .write_all(&native_session.event()?)
                .and_then(|_| output.flush())
                .map_err(|_| "Host disconnected after completion; command will not be replayed.")?;
        }
    }
    native_session.disconnect()?;
    if lifecycle_events {
        output
            .write_all(&native_session.event()?)
            .and_then(|_| output.flush())
            .map_err(|_| "Host disconnected after draining; no command will be replayed.")?;
    }
    Ok(())
}

#[cfg(windows)]
fn parent_host() -> Result<String, String> {
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    unsafe {
        if GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE
            || GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE
        {
            return Err("Hosted mode requires private inherited input and output pipes.".into());
        }
        for stream in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            if SetHandleInformation(GetStdHandle(stream), HANDLE_FLAG_INHERIT, 0) == 0 {
                return Err("Cannot prevent hosting pipe inheritance.".into());
            }
        }
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Cannot inspect parent process.".into());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent = 0;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            if entry.th32ProcessID == std::process::id() {
                parent = entry.th32ParentProcessID;
                break;
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        if parent == 0 {
            return Err("Cannot identify parent process.".into());
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent);
        if process.is_null() {
            return Err("Cannot open parent process identity.".into());
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if ok == 0 {
            return Err("Cannot inspect host executable.".into());
        }
        let path =
            String::from_utf16(&buffer[..length as usize]).map_err(|_| "Invalid host path.")?;
        // Routing check only, not publisher authentication; native consent is still required.
        if !Path::new(&path).file_name().is_some_and(|name| {
            name.to_string_lossy()
                .eq_ignore_ascii_case("creator-hub.exe")
        }) {
            return Err("Hosted mode must be launched directly by Creator Hub.".into());
        }
        Ok(path)
    }
}

#[cfg(target_os = "linux")]
fn parent_host() -> Result<String, String> {
    unix_boundary::parent_host()
}

#[cfg(target_os = "macos")]
fn parent_host() -> Result<String, String> {
    crate::host_parent_macos::verify()
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn parent_host() -> Result<String, String> {
    Err("Native hosting preview is not supported on this platform yet.".into())
}

pub fn run() -> Result<(), String> {
    #[cfg(unix)]
    let parent = Some(unsafe { libc::getppid() });
    #[cfg(not(unix))]
    let parent = None;
    let host = parent_host()?;
    let (host_image, host_hash) = crate::hosted_payload::lock_image(Path::new(&host))?;
    let mut context = tauri::generate_context!();
    let files = assets(&context)?;
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let _host_image = host_image;
                let result = serve_authorized(
                    &mut std::io::stdin().lock(),
                    &mut std::io::stdout().lock(),
                    files,
                    |writable| authorize(&app, &host, &host_hash, writable, parent),
                    |command, args| dispatch(&app, command, args),
                );
                if let Err(error) = &result {
                    eprintln!("Hosted MCP stopped: {error}");
                }
                app.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|error| error.to_string())?
        .run(crate::lifecycle::run_event);
    Ok(())
}

fn authorize(
    app: &tauri::AppHandle,
    host: &str,
    host_hash: &str,
    writable: bool,
    _parent: Option<i32>,
) -> Result<Permission, String> {
    let image_binding = if cfg!(windows) {
        "Its exact running image is locked for this session; the fingerprint is not a publisher signature."
    } else {
        "The direct parent and private pipes are checked. This fingerprint is a file snapshot, not a publisher signature or an immutable executable lock."
    };
    let (message, button) = if writable {
        (format!("Enable the normal MCP controls in this running Creator Hub?\n\n{host}\nSHA-256: {host_hash}\n\nThis permits launcher settings, selected AI-client configuration and Unity bridge changes when you use their controls. Only approve the Hub you intentionally opened. {image_binding} This does not install updates, adopt shortcuts, or stop any client."), "Enable MCP controls")
    } else {
        (format!("Open MCP's read-only preview inside this Creator Hub window?\n\n{host}\n\nOnly continue if you just chose MCP in Hub. It can read saved launcher settings and show a folder picker. It cannot update bridges, migrate settings, install apps, or change shortcuts. The host path alone does not verify its publisher."), "Open read-only preview")
    };
    if !app
        .dialog()
        .message(message)
        .title("Open MCP in Creator Hub?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            button.into(),
            "Not now".into(),
        ))
        .blocking_show()
    {
        return Err("Opening MCP in Hub was declined. Standalone MCP is unchanged.".into());
    }
    if !writable {
        return Ok(Permission::read_only());
    }
    #[cfg(windows)]
    {
        let root = app
            .path()
            .resource_dir()
            .map_err(|_| "Cannot locate MCP resources.")?
            .join("server");
        let payload = crate::hosted_payload::lock(&root)?;
        let owner = crate::gui_owner::GuiWriteOwner::current_user()
            .map_err(|_| "Another MCP window owns these settings, or exclusive access is unavailable. No window was closed.")?;
        let settings = dirs::config_dir()
            .ok_or("Cannot locate settings.")?
            .join(crate::APP_CONFIG_DIR);
        let mut journal = crate::hosted_journal::Journal::open(&settings)?;
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
                    "Previous operation remains unreviewed; writable hosting was not opened."
                        .into(),
                );
            }
            journal.acknowledge_unknowns()?;
        }
        if !app.manage(crate::hosted_payload::Root(root)) {
            return Err("Hosted resource authority already exists.".into());
        }
        Ok(Permission {
            writable: true,
            journal: Some(journal),
            _owner: Some(owner),
            _payload: payload,
        })
    }
    #[cfg(all(unix, feature = "experimental-unix-hosting"))]
    {
        // Recheck direct-parent/private-pipe admission after the native dialog.
        // Snapshot methods bind later resource reads; no advisory lock claim.
        let ensure_host = || -> Result<(), String> {
            if Some(unsafe { libc::getppid() }) != _parent || parent_host()? != host {
                return Err("Creator Hub's direct-parent identity changed during consent.".into());
            }
            Ok(())
        };
        ensure_host()?;
        let payload = if app.try_state::<crate::hosted_payload::Root>().is_some() {
            None
        } else {
            let root = app
                .path()
                .resource_dir()
                .map_err(|_| "Cannot locate MCP resources.")?
                .join("server");
            Some(crate::hosted_payload::Root::verified(root)?)
        };
        let owner = crate::gui_owner::GuiWriteOwner::current_user()
            .map_err(|_| "Another MCP window owns these settings, or exclusive access is unavailable. No window was closed.")?;
        let settings = dirs::config_dir()
            .ok_or("Cannot locate settings.")?
            .join(crate::APP_CONFIG_DIR);
        let mut journal = crate::hosted_journal::Journal::open(&settings)?;
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
                    "Previous operation remains unreviewed; writable hosting was not opened."
                        .into(),
                );
            }
            ensure_host()?;
            owner.ensure_current().map_err(|_| "MCP settings ownership changed during outcome review. No acknowledgement was saved.")?;
            journal.acknowledge_unknowns()?;
        }
        ensure_host()?;
        owner
            .ensure_current()
            .map_err(|_| "MCP settings ownership changed before authorization completed.")?;
        if let Some(payload) = payload {
            if !app.manage(payload) {
                return Err("Hosted resource authority already exists.".into());
            }
        }
        Ok(Permission {
            writable: true,
            journal: Some(journal),
            _owner: Some(owner),
            _payload: Vec::new(),
        })
    }
    #[cfg(not(any(windows, all(unix, feature = "experimental-unix-hosting"))))]
    Err("Production Unix writable hosting remains disabled pending kernel-backed payload use and native acceptance.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialize(args: Value) -> String {
        request(0, "initialize").replace("\"args\":{}", &format!("\"args\":{args}"))
    }

    #[test]
    fn resource_directory_field_is_optional_and_strict() {
        let args = json!({"hostingRevision":2,"requestedMode":"read-only"});
        assert!(decode::<InitializeArgs>(args).is_ok());
        #[cfg(unix)]
        {
            let args =
                json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":null});
            assert!(decode::<InitializeArgs>(args)
                .unwrap()
                .resource_directory
                .is_none());
        }
        let temporary = tempfile::tempdir().unwrap();
        let absolute = temporary.path().canonicalize().unwrap();
        let mut invalid = vec![
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":true}),
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":[]}),
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":""}),
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":"relative"}),
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":absolute.join("../elsewhere")}),
            json!({"hostingRevision":2,"requestedMode":"read-only","resource_directory":absolute}),
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceRoot":absolute}),
            json!({"hostingRevision":3,"requestedMode":"read-only","resourceDirectory":absolute}),
            json!({"resourceDirectory":absolute}),
        ];
        if !cfg!(unix) {
            invalid.push(json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":absolute}));
            invalid.push(
                json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":null}),
            );
        }
        for args in invalid {
            let mut output = Vec::new();
            assert!(serve_authorized(
                &mut initialize(args.clone()).as_bytes(),
                &mut output,
                BTreeMap::new(),
                |_| panic!("Invalid resource handoff must not prompt: {args}"),
                |_, _| panic!("Invalid resource handoff must not bind: {args}"),
            )
            .is_err());
            assert!(output.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn resource_binding_precedes_permission_but_never_grants_managed_scope() {
        use std::cell::Cell;
        let bound = Cell::new(false);
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let hello = initialize(
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":directory}),
        );
        let mut output = Vec::new();
        serve_authorized(
            &mut hello.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |writable| {
                assert!(bound.get());
                assert!(!writable);
                Ok(Permission::read_only())
            },
            |command, args| {
                assert!(!bound.replace(true));
                assert_eq!(command, "bind_verified_resources");
                assert_eq!(args, json!({"resourceDirectory":directory}));
                Ok(json!({}))
            },
        )
        .unwrap();
        let frames = replies(&output);
        assert_eq!(frames[0]["result"]["effectiveMode"], "read-only");
        assert_eq!(frames[0]["result"].as_object().unwrap().len(), 6);

        for command in [
            "save_config",
            "begin_ui_operation",
            "bind_managed_route",
            "bind_verified_resources",
            "initialize",
        ] {
            let input = hello.clone() + &request(1, command);
            let mut calls = 0;
            assert!(serve_authorized(
                &mut input.as_bytes(),
                &mut Vec::new(),
                BTreeMap::new(),
                |_| Ok(Permission::read_only()),
                |name, _| {
                    assert_eq!(name, "bind_verified_resources");
                    calls += 1;
                    Ok(Value::Null)
                },
            )
            .is_err());
            assert_eq!(calls, 1);
        }
        assert!(!COMMANDS.contains(&"bind_verified_resources"));
        assert!(!crate::hosted_commands::COMMANDS.contains(&"bind_verified_resources"));
    }

    #[cfg(unix)]
    #[test]
    fn foreign_resources_fail_before_consent_or_snapshot_dispatch() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        std::fs::create_dir(directory.join("server")).unwrap();
        for (name, _) in crate::hosted_payload::FILES {
            let path = directory.join("server").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"foreign payload").unwrap();
        }
        assert!(!crate::hosted_payload::FILES.is_empty());
        let input = initialize(
            json!({"hostingRevision":2,"requestedMode":"read-only","resourceDirectory":directory}),
        ) + &request(1, "get_hosted_snapshot");
        let mut output = Vec::new();
        serve_authorized(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |_| panic!("Foreign resources must not prompt"),
            |command, args| {
                assert_eq!(command, "bind_verified_resources");
                let args = decode::<ResourceArgs>(args)?;
                crate::hosted_payload::Root::verified(args.resource_directory.join("server"))?;
                Ok(Value::Null)
            },
        )
        .unwrap();
        let frames = replies(&output);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["id"], 0);
        assert_eq!(frames[0]["ok"], false);
        assert!(frames[0]["error"]
            .as_str()
            .unwrap()
            .contains("does not match"));
    }

    #[cfg(unix)]
    #[test]
    fn resource_binding_does_not_bypass_decline_or_writable_admission() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        for args in [
            json!({"hostingRevision":2,"requestedMode":"read-only","managedRouting":true,"resourceDirectory":directory}),
            json!({"hostingRevision":2,"requestedMode":"writable","resourceDirectory":directory}),
        ] {
            assert!(serve_authorized(
                &mut initialize(args).as_bytes(),
                &mut Vec::new(),
                BTreeMap::new(),
                |_| panic!("Invalid route must not prompt"),
                |_, _| panic!("Invalid route must not bind"),
            )
            .is_err());
        }
        for writable in [false, true] {
            let input = initialize(
                json!({"hostingRevision":2,"requestedMode":if writable {"writable"} else {"read-only"},"managedRouting":writable,"resourceDirectory":directory}),
            ) + &request(1, "get_hosted_snapshot");
            let mut output = Vec::new();
            let mut calls = 0;
            serve_authorized(
                &mut input.as_bytes(),
                &mut output,
                BTreeMap::new(),
                |requested| {
                    assert_eq!(requested, writable);
                    Err("Declined".into())
                },
                |command, _| {
                    assert_eq!(command, "bind_verified_resources");
                    calls += 1;
                    Ok(Value::Null)
                },
            )
            .unwrap();
            assert_eq!(calls, 1);
            let frames = replies(&output);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["error"], "Declined");
        }
        let input = initialize(
            json!({"hostingRevision":2,"requestedMode":"writable","managedRouting":true,"resourceDirectory":directory}),
        );
        assert!(serve_authorized(
            &mut input.as_bytes(),
            &mut Vec::new(),
            BTreeMap::new(),
            |_| Ok(Permission::read_only()),
            |command, _| {
                assert_eq!(command, "bind_verified_resources");
                Ok(Value::Null)
            },
        )
        .is_err());
    }

    #[test]
    fn absent_resources_keep_the_existing_snapshot_resolver() {
        let directory = PathBuf::from("standalone resources");
        assert_eq!(
            snapshot_resource_directory(None, || Ok(directory.clone())).unwrap(),
            directory
        );
        assert!(snapshot_resource_directory(None, || Err("resolver failed".into())).is_err());
        #[cfg(windows)]
        assert_eq!(
            snapshot_resource_directory(
                Some(&crate::hosted_payload::Root(PathBuf::from("C:/old/server"))),
                || Ok(directory.clone())
            )
            .unwrap(),
            directory,
        );
    }

    #[cfg(unix)]
    #[test]
    fn bound_snapshot_uses_verified_root_without_the_current_exe_resolver() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let server = directory.join("server");
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for (name, _) in crate::hosted_payload::FILES {
            let from = if name.starts_with("unity-extension/") {
                source.join(name)
            } else {
                source.join("release").join(name)
            };
            let to = server.join(name);
            std::fs::create_dir_all(to.parent().unwrap()).unwrap();
            std::fs::copy(from, to).unwrap();
        }
        assert!(!crate::hosted_payload::FILES.is_empty());
        let root = crate::hosted_payload::Root::verified(server.clone()).unwrap();
        assert_eq!(
            snapshot_resource_directory(Some(&root), || panic!(
                "Hosted Unix resources must not depend on current_exe"
            ))
            .unwrap(),
            directory
        );
        let bridge = "unity-extension/Editor/BanterMCPBridge.cs";
        let approved = root.read_verified(bridge).unwrap();
        std::fs::write(server.join(bridge), b"external replacement").unwrap();
        assert_eq!(root.read_verified(bridge).unwrap(), approved);
        assert!(crate::hosted_payload::Root::verified(server).is_err());
    }

    fn writable_permission(root: &Path) -> Permission {
        let mut permission = Permission::read_only();
        permission.writable = true;
        #[cfg(any(windows, unix))]
        {
            permission._owner = Some(crate::gui_owner::GuiWriteOwner::fixture(root).unwrap());
        }
        permission
    }

    fn writable_hello() -> String {
        request(0, "initialize").replace(
            "\"args\":{}",
            &format!(
                "\"args\":{}",
                json!({"hostingRevision":2,"requestedMode":"writable","managedRouting":cfg!(unix)})
            ),
        )
    }

    #[test]
    fn managed_binding_happens_only_after_permission_and_never_from_read_only() {
        use std::cell::Cell;
        let approved = Cell::new(false);
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let input = request(0, "initialize").replace("\"args\":{}", "\"args\":{\"hostingRevision\":2,\"requestedMode\":\"writable\",\"managedRouting\":true}");
        let mut output = vec![];
        serve_authorized(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |writable| {
                assert!(writable);
                approved.set(true);
                Ok(writable_permission(&root))
            },
            |command, _| {
                assert!(approved.get());
                assert_eq!(command, "bind_managed_route");
                Ok(json!({}))
            },
        )
        .unwrap();
        assert!(String::from_utf8(output).unwrap().contains("effectiveMode"));
        let input = input.replace("\"writable\"", "\"read-only\"");
        assert!(serve_authorized(
            &mut input.as_bytes(),
            &mut vec![],
            BTreeMap::new(),
            |_| panic!("Never prompt"),
            |_, _| panic!("Never bind")
        )
        .is_err());
        let input = request(0, "initialize").replace("\"args\":{}", "\"args\":{\"hostingRevision\":2,\"requestedMode\":\"writable\",\"managedRouting\":true}");
        let mut output = vec![];
        serve_authorized(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |_| Err("declined".into()),
            |_, _| panic!("No binding after decline"),
        )
        .unwrap();
        assert!(String::from_utf8(output).unwrap().contains("declined"));
    }

    #[test]
    fn release_links_are_limited_to_exact_official_stable_tags() {
        let base = "https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/";
        assert!(official_url(&format!("{base}v2.7.0")));
        for tag in [
            "v2.7.0/anything",
            "v2.7.0?redirect=elsewhere",
            "v2.7.0#x",
            "../settings",
            "v02.7.0",
            "v2.7.0-rc.1",
        ] {
            assert!(!official_url(&format!("{base}{tag}")));
        }
        assert!(!official_url(
            "https://github.com.example.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP"
        ));
    }

    fn request(id: u64, command: &str) -> String {
        format!(
            "{}\n",
            json!({"protocol":1,"session":"a".repeat(64),"id":id,"command":command,"args":{}})
        )
    }
    fn replies(output: &[u8]) -> Vec<Value> {
        std::str::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn revision_two_is_explicit_read_only_and_has_bounded_ordered_events() {
        let hello = request(0, "initialize").replace(
            "\"args\":{}",
            "\"args\":{\"hostingRevision\":2,\"requestedMode\":\"read-only\"}",
        );
        let input = hello + &request(1, COMMANDS[0]);
        let mut output = Vec::new();
        let mut calls = 0;
        serve(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            || true,
            |_, _| {
                calls += 1;
                Ok(json!({"readOnly":true}))
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
        let frames = replies(&output);
        assert_eq!(frames[0]["result"]["hostingRevision"], 2);
        assert_eq!(frames[0]["result"]["effectiveMode"], "read-only");
        let events: Vec<_> = frames
            .iter()
            .filter(|frame| frame["type"] == "event")
            .collect();
        assert_eq!(events.len(), 4);
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event["name"], "creator-mcp-lifecycle");
            assert_eq!(event["payload"]["sequence"], index as u64);
            assert!(serde_json::to_vec(event).unwrap().len() < 512);
        }
        assert_eq!(events[0]["payload"]["state"], "idle");
        assert_eq!(events[1]["payload"]["state"], "busy");
        assert_eq!(events[2]["payload"]["state"], "idle");
        assert_eq!(events[3]["payload"]["state"], "draining");
        assert_eq!(events[3]["payload"]["commandsInFlight"], 0);
        assert_eq!(frames[3]["id"], 1);
    }

    #[test]
    fn unknown_initialization_never_prompts_or_dispatches() {
        for args in [
            json!({"hostingRevision":3,"requestedMode":"read-only"}),
            json!({"hostingRevision":2,"requestedMode":"read-only","consent":true}),
        ] {
            let input =
                request(0, "initialize").replace("\"args\":{}", &format!("\"args\":{args}"));
            let mut output = Vec::new();
            assert!(serve(
                &mut input.as_bytes(),
                &mut output,
                BTreeMap::new(),
                || panic!("invalid mode prompted"),
                |_, _| panic!("invalid mode dispatched")
            )
            .is_err());
            assert!(output.is_empty());
        }
    }

    #[test]
    fn writable_negotiation_requires_explicit_native_permission() {
        let hello = writable_hello();
        let mut output = Vec::new();
        serve_authorized(
            &mut hello.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |writable| {
                assert!(writable);
                Err("Declined".into())
            },
            |_, _| panic!("Declined request dispatched"),
        )
        .unwrap();
        assert_eq!(replies(&output).len(), 1);
        assert_eq!(replies(&output)[0]["ok"], false);
        output.clear();
        assert!(serve_authorized(
            &mut hello.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |_| Ok(Permission::read_only()),
            |_, _| panic!()
        )
        .is_err());
        assert!(output.is_empty());
    }

    #[test]
    fn writable_transport_requires_its_own_workflow_before_mutation() {
        let hello = writable_hello();
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        // Never acquire production configuration ownership in a unit test.
        let input = hello
            + &request(1, "save_config")
            + &request(2, "begin_ui_operation")
            + &request(3, "save_config");
        let mut output = Vec::new();
        let mut calls = Vec::new();
        serve_authorized(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |_| Ok(writable_permission(&root)),
            |command, _| {
                if command != "bind_managed_route" {
                    calls.push(command.to_owned());
                }
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert_eq!(calls, ["save_config"]);
        let frames = replies(&output);
        assert_eq!(frames[0]["result"]["effectiveMode"], "writable");
        assert!(frames
            .iter()
            .any(|frame| frame["id"] == 1 && frame["ok"] == false));
        assert!(frames
            .iter()
            .any(|frame| frame["id"] == 3 && frame["ok"] == true));
    }

    #[cfg(unix)]
    #[test]
    fn direct_unix_writable_route_refuses_before_prompt_or_binding() {
        let input = request(0, "initialize").replace(
            "\"args\":{}",
            "\"args\":{\"hostingRevision\":2,\"requestedMode\":\"writable\"}",
        );
        assert!(serve_authorized(
            &mut input.as_bytes(),
            &mut vec![],
            BTreeMap::new(),
            |_| panic!("Direct Unix route must not prompt"),
            |_, _| panic!("Direct Unix route must not bind or dispatch")
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn missing_or_changed_owner_never_binds_managed_routing() {
        for changed in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let mut output = vec![];
            serve_authorized(
                &mut writable_hello().as_bytes(),
                &mut output,
                BTreeMap::new(),
                |_| {
                    let mut permission = if changed {
                        writable_permission(&root)
                    } else {
                        Permission::read_only()
                    };
                    permission.writable = true;
                    if changed {
                        std::fs::remove_file(root.join("launcher-gui.lock")).unwrap();
                        std::fs::write(root.join("launcher-gui.lock"), b"replacement").unwrap();
                    }
                    Ok(permission)
                },
                |_, _| panic!("Invalid owner must not bind or dispatch"),
            )
            .unwrap();
            let frames = replies(&output);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["ok"], false);
            assert!(frames[0]["error"].as_str().unwrap().contains("ownership"));
            assert!(!root.join("hosted-operation-outcomes.json").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn owner_changed_during_busy_delivery_refuses_before_journal_or_dispatch() {
        struct ChangeOwner {
            output: Vec<u8>,
            writes: usize,
            marker: std::path::PathBuf,
        }
        impl Write for ChangeOwner {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.writes += 1;
                if self.writes == 6 {
                    // save_config busy event, after begin_ui_operation completed.
                    std::fs::write(&self.marker, b"external marker change")?;
                }
                self.output.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let input = writable_hello()
            + &request(1, "begin_ui_operation")
            + &request(2, "save_config")
            + &request(3, "save_config");
        let mut output = ChangeOwner {
            output: vec![],
            writes: 0,
            marker: root.join("launcher-gui.lock"),
        };
        let mut calls = Vec::new();
        serve_authorized(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            |_| {
                let mut permission = writable_permission(&root);
                permission.journal = Some(crate::hosted_journal::Journal::open(&root).unwrap());
                Ok(permission)
            },
            |command, _| {
                calls.push(command.to_owned());
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert_eq!(calls, ["bind_managed_route"]);
        assert!(!root.join("hosted-operation-outcomes.json").exists());
        let frames = replies(&output.output);
        assert!(frames
            .iter()
            .any(|frame| frame["id"] == 2 && frame["ok"] == false));
        assert!(!frames.iter().any(|frame| frame["id"] == 3));
    }

    #[test]
    fn lost_busy_event_does_not_invoke_the_native_command() {
        struct FailBusy {
            writes: u32,
        }
        impl Write for FailBusy {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.writes += 1;
                if self.writes == 3 {
                    return Err(std::io::ErrorKind::BrokenPipe.into());
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let hello = request(0, "initialize").replace(
            "\"args\":{}",
            "\"args\":{\"hostingRevision\":2,\"requestedMode\":\"read-only\"}",
        );
        let input = hello + &request(1, COMMANDS[0]);
        let mut output = FailBusy { writes: 0 };
        assert!(serve(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            || true,
            |_, _| panic!("command invoked after busy delivery failed")
        )
        .is_err());
    }
    #[test]
    fn initialization_and_decline_never_dispatch_a_command() {
        for approved in [true, false] {
            let mut output = Vec::new();
            serve(
                &mut request(0, "initialize").as_bytes(),
                &mut output,
                BTreeMap::new(),
                || approved,
                |_, _| panic!("Initialization must not invoke configuration or project commands"),
            )
            .unwrap();
            let reply = &replies(&output)[0];
            assert_eq!(reply["ok"], approved);
            if approved {
                assert_eq!(reply["result"]["appId"], "creator-works-mcp");
                assert_eq!(reply["result"].as_object().unwrap().len(), 4);
            } else {
                assert!(reply.get("result").is_none());
            }
        }
    }
    #[test]
    fn requests_are_sequential_and_errors_do_not_replay() {
        let input = request(0, "initialize") + &request(1, COMMANDS[0]) + &request(2, COMMANDS[0]);
        let mut count = 0;
        let mut output = Vec::new();
        serve(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            || true,
            |name, _| {
                assert_eq!(name, COMMANDS[0]);
                count += 1;
                if count == 1 {
                    Err("fixture failure".into())
                } else {
                    Ok(json!(count))
                }
            },
        )
        .unwrap();
        assert_eq!(count, 2);
        let frames = replies(&output);
        assert_eq!(frames[1]["ok"], false);
        assert_eq!(frames[2]["result"], 2);
    }
    #[test]
    fn replay_wrong_session_and_mutation_commands_fail_closed() {
        for invalid in [
            request(0, COMMANDS[0]),
            request(1, COMMANDS[0]).replace(&"a".repeat(64), &"b".repeat(64)),
            request(1, "save_config"),
            request(1, "load_config"),
            request(1, "begin_ui_operation"),
            request(1, "shutdown"),
        ] {
            let mut output = Vec::new();
            let input = request(0, "initialize") + &invalid;
            assert!(serve(
                &mut input.as_bytes(),
                &mut output,
                BTreeMap::new(),
                || true,
                |_, _| panic!("invalid request dispatched")
            )
            .is_err());
            assert_eq!(replies(&output).len(), 1);
        }
    }
    #[test]
    fn protocol_bounds_and_argument_shapes_are_strict() {
        let valid = request(0, "initialize");
        for input in [
            vec![b'x'; MAX_REQUEST + 1],
            b"{}\n".to_vec(),
            vec![0xff, b'\n'],
            valid.trim_end().as_bytes().to_vec(),
            valid
                .replace("\"id\":0", "\"id\":9007199254740992")
                .into_bytes(),
            valid
                .replace("\"args\":{}", "\"args\":{},\"extra\":true")
                .into_bytes(),
            valid.replace("\"args\":{}", "\"args\":[]").into_bytes(),
        ] {
            assert!(read_request(&mut input.as_slice()).is_err());
        }
        assert!(read_request(&mut b"".as_slice()).unwrap().is_none());
        assert!(decode::<NoArgs>(json!({"path":"extra"})).is_err());
        assert!(decode::<UrlArgs>(json!({"url":"https://example.org", "with":"cmd"})).is_err());
        assert!(!OFFICIAL_URLS.contains(&"file:///C:/test.exe"));
        assert!(!OFFICIAL_URLS
            .contains(&"https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP?run=1"));
    }
    #[test]
    fn large_response_is_rejected_before_any_partial_write() {
        let mut output = Vec::new();
        assert!(send(
            &mut output,
            &"a".repeat(64),
            1,
            Ok(json!("x".repeat(MAX_RESPONSE)))
        )
        .is_err());
        assert!(output.is_empty());
    }
    #[test]
    fn lost_output_does_not_replay_or_start_the_next_request() {
        struct FailAfterHello {
            frames: usize,
        }
        impl Write for FailAfterHello {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.frames += 1;
                if self.frames > 1 {
                    Err(std::io::ErrorKind::BrokenPipe.into())
                } else {
                    Ok(data.len())
                }
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = 0;
        let input = request(0, "initialize") + &request(1, COMMANDS[0]) + &request(2, COMMANDS[0]);
        assert!(serve(
            &mut input.as_bytes(),
            &mut FailAfterHello { frames: 0 },
            BTreeMap::new(),
            || true,
            |_, _| {
                count += 1;
                Ok(Value::Null)
            }
        )
        .is_err());
        assert_eq!(count, 1);
    }
    #[test]
    fn config_reads_do_not_create_migrate_or_repair_files() {
        let root =
            std::env::temp_dir().join(format!("creator-mcp-hosted-{}", uuid::Uuid::new_v4()));
        let current = root.join("current/launcher-config.json");
        let legacy = root.join("legacy/launcher-config.json");
        assert!(config_snapshot(&current, &legacy).unwrap().0.is_none());
        assert!(!root.exists());
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let original = br#"{"channels":[],"active_channel_id":null,"auto_start":false,"mcp_server_path":"C:/old/server.js","tool_groups":"full","unrelated":"preserve"}"#;
        std::fs::write(&legacy, original).unwrap();
        let before = std::fs::metadata(&legacy).unwrap().modified().unwrap();
        let (config, source) = config_snapshot(&current, &legacy).unwrap();
        assert_eq!(source, "legacy (not migrated)");
        assert_eq!(config.unwrap().mcp_server_path, "C:/old/server.js");
        assert!(!current.parent().unwrap().exists());
        assert_eq!(std::fs::read(&legacy).unwrap(), original);
        assert_eq!(
            std::fs::metadata(&legacy).unwrap().modified().unwrap(),
            before
        );
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&current, "invalid").unwrap();
        assert!(config_snapshot(&current, &legacy).is_err());
        assert_eq!(std::fs::read_to_string(&current).unwrap(), "invalid");
        std::fs::write(&current, vec![b'x'; MAX_CONFIG + 1]).unwrap();
        assert!(config_snapshot(&current, &legacy).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn embedded_assets_decode_to_real_html_javascript_and_original_bitmap() {
        let files = assets(&tauri::generate_context!()).unwrap();
        let html = String::from_utf8(STANDARD.decode(&files["index.html"]).unwrap()).unwrap();
        assert!(html.contains("hostedPreview"));
        let script = String::from_utf8(STANDARD.decode(&files["runtime.js"]).unwrap()).unwrap();
        assert!(script.contains("CreatorRuntime"));
        assert_eq!(
            &STANDARD.decode(&files["creator-works-logo.png"]).unwrap()[..8],
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(COMMANDS.len(), 3);
    }
}
