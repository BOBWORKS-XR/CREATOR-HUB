//! Preview protocol: private inherited pipes, native host consent, no network listener.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, Read, Write},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const MAX_REQUEST: usize = 64 * 1024;
pub const COMMANDS: &[&str] = &[
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

#[derive(Default)]
pub struct Output(Mutex<Option<String>>);
impl Output {
    fn send(&self, mut message: Value) -> Result<(), String> {
        let session = self.0.lock().map_err(|_| "Hosted output is unavailable.")?;
        message["session"] = json!(session.as_deref().ok_or("No hosted session.")?);
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &message).map_err(|e| e.to_string())?;
        stdout
            .write_all(b"\n")
            .and_then(|_| stdout.flush())
            .map_err(|e| e.to_string())
    }
}

pub fn emit(app: &tauri::AppHandle, name: &str, payload: impl serde::Serialize + Clone) {
    if let Some(output) = app.try_state::<Output>() {
        let _ = output.send(json!({ "type": "event", "name": name, "payload": payload }));
    } else {
        let _ = app.emit(name, payload);
    }
}

pub fn assets(context: &tauri::Context<tauri::Wry>) -> Result<BTreeMap<String, String>, String> {
    context
        .assets()
        .iter()
        .map(|(key, _)| {
            // iter() exposes packed bytes in release builds; get() performs decompression.
            let bytes = context
                .assets()
                .get(&key.as_ref().into())
                .ok_or("Cannot decode bundled Setup asset.")?;
            Ok((
                key.to_string().trim_start_matches('/').to_owned(),
                STANDARD.encode(bytes),
            ))
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    session: String,
    id: u64,
    command: String,
    args: Value,
}

fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_REQUEST + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
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
        || !request.args.is_object()
    {
        return Err("Invalid hosted protocol or session.".into());
    }
    Ok(Some(request))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathArgs {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlArgs {
    url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wrapped<T> {
    request: T,
}
fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("Invalid command arguments: {e}"))
}
fn value(result: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn dispatch(app: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    // Reuse the exact standalone command functions, including their validation and guards.
    match command {
        "get_recipe" => {
            decode::<NoArgs>(args)?;
            value(crate::get_recipe()?)
        }
        "probe_environment" => {
            decode::<NoArgs>(args)?;
            value(crate::probe_environment()?)
        }
        "pick_parent_folder" => {
            decode::<NoArgs>(args)?;
            value(crate::pick_parent_folder(app.clone())?)
        }
        "create_project" => value(tauri::async_runtime::block_on(crate::create_project(
            app.clone(),
            decode::<Wrapped<crate::logic::CreateRequest>>(args)?.request,
        ))?),
        "open_project" => value(crate::open_project(decode::<PathArgs>(args)?.path)?),
        "launch_hub" => {
            decode::<NoArgs>(args)?;
            value(crate::launch_hub()?)
        }
        "restart_hub" => {
            decode::<NoArgs>(args)?;
            value(tauri::async_runtime::block_on(crate::restart_hub(
                app.clone(),
            ))?)
        }
        "register_project" => value(tauri::async_runtime::block_on(crate::register_project(
            decode::<PathArgs>(args)?.path,
        ))?),
        "inspect_project" => value(tauri::async_runtime::block_on(crate::inspect_project(
            decode::<PathArgs>(args)?.path,
        ))?),
        "run_existing_project" => value(tauri::async_runtime::block_on(
            crate::run_existing_project(
                app.clone(),
                decode::<Wrapped<crate::repair::ExistingRequest>>(args)?.request,
            ),
        )?),
        "open_official_url" => value(crate::open_official_url(
            app.clone(),
            decode::<UrlArgs>(args)?.url,
        )?),
        _ => Err("Unsupported hosted Setup command.".into()),
    }
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
                return Err("Cannot prevent hosted pipe inheritance into child processes.".into());
            }
        }
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Cannot verify the parent process.".into());
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
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent);
        if process.is_null() {
            return Err("Cannot verify Creator Hub's process.".into());
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if ok == 0 {
            return Err("Cannot inspect Creator Hub's executable.".into());
        }
        let path =
            String::from_utf16(&buffer[..length as usize]).map_err(|_| "Invalid host path.")?;
        if !std::path::Path::new(&path).file_name().is_some_and(|name| {
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
    unsafe {
        let mut stat_in: libc::stat = std::mem::zeroed();
        let mut stat_out: libc::stat = std::mem::zeroed();
        if libc::fstat(0, &mut stat_in) != 0 || libc::fstat(1, &mut stat_out) != 0 {
            return Err("Cannot inspect hosted streams.".into());
        }
        if (stat_in.st_mode & libc::S_IFMT) != libc::S_IFIFO
            || (stat_out.st_mode & libc::S_IFMT) != libc::S_IFIFO
        {
            return Err("Hosted mode requires private inherited input and output pipes.".into());
        }
        let ppid = libc::getppid();
        if ppid <= 1 {
            return Err("Cannot verify the parent process.".into());
        }
        let exe_link = format!("/proc/{ppid}/exe");
        let path = std::fs::read_link(&exe_link)
            .map_err(|_| String::from("Cannot verify Creator Hub's process."))?;
        let valid_name = path.file_name().is_some_and(|name| {
            let n = name.to_string_lossy();
            n.eq_ignore_ascii_case("creator-hub") || n.eq_ignore_ascii_case("creator-hub.exe")
        });
        if !valid_name {
            return Err("Hosted mode must be launched directly by Creator Hub.".into());
        }
        Ok(path.to_string_lossy().into_owned())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn parent_host() -> Result<String, String> {
    Err("Native hosted mode is not supported on this platform yet.".into())
}

pub fn run(app: tauri::AppHandle, files: BTreeMap<String, String>) {
    let result = serve(&app, files);
    if let Err(error) = result {
        eprintln!("Hosted Setup stopped: {error}");
    }
    app.exit(0);
}

fn serve(app: &tauri::AppHandle, files: BTreeMap<String, String>) -> Result<(), String> {
    let host = parent_host()?;
    let mut input = std::io::stdin().lock();
    let hello = read_request(&mut input)?.ok_or("Host disconnected before initialization.")?;
    if hello.id != 0 || hello.command != "initialize" {
        return Err("Expected a hosted initialization request.".into());
    }
    decode::<NoArgs>(hello.args)?;
    let approved = app.dialog().message(format!("Run Project Setup inside this Creator Hub window?\n\n{host}\n\nThis preview uses your existing Setup operations. It does not install an app or change shortcuts. Only continue if you just chose Project Setup in Hub."))
        .title("Open Setup in Creator Hub?").kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Open in Hub".into(), "Not now".into())).blocking_show();
    let output = app.state::<Output>();
    *output.0.lock().map_err(|_| "Hosted output unavailable.")? = Some(hello.session.clone());
    if !approved {
        output.send(json!({"id": 0, "ok": false, "error": "Opening Setup in Hub was declined. Standalone Setup is unchanged."}))?;
        return Ok(());
    }
    output.send(json!({"id": 0, "ok": true, "result": {"appId": "creator-project-setup", "version": env!("CARGO_PKG_VERSION"), "protocol": 1, "files": files}}))?;
    let mut previous_id = 0;
    while let Some(request) = read_request(&mut input)? {
        if request.session != hello.session || request.id <= previous_id {
            return Err("Mismatched or replayed hosted request.".into());
        }
        previous_id = request.id;
        if !COMMANDS.contains(&request.command.as_str()) {
            return Err("Unknown hosted command.".into());
        }
        let result = dispatch(app, &request.command, request.args);
        let response = match result {
            Ok(result) => json!({"id": request.id, "ok": true, "result": result}),
            Err(error) => json!({"id": request.id, "ok": false, "error": error}),
        };
        // A lost host never cancels a Unity mutation midway; the command completes first.
        output.send(response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiled_assets_are_decoded_not_compressed_bytes() {
        let context = tauri::generate_context!();
        let files = assets(&context).unwrap();
        let html = String::from_utf8(STANDARD.decode(&files["index.html"]).unwrap()).unwrap();
        assert!(html.contains("project-name"));
        let script = String::from_utf8(STANDARD.decode(&files["runtime.js"]).unwrap()).unwrap();
        assert!(script.contains("CreatorRuntime"));
        let image = STANDARD.decode(&files["creator-works-logo.png"]).unwrap();
        assert_eq!(&image[..8], b"\x89PNG\r\n\x1a\n");
    }
    #[test]
    fn protocol_rejects_oversized_truncated_and_unknown_fields() {
        for bytes in [
            vec![b'x'; MAX_REQUEST + 1],
            b"{}".to_vec(),
            b"{}\n".to_vec(),
        ] {
            assert!(read_request(&mut bytes.as_slice()).is_err());
        }
        let mut input =
            json!({"protocol":1,"session":"a".repeat(64),"id":0,"command":"initialize","args":{}})
                .to_string();
        input.push('\n');
        assert!(read_request(&mut input.as_bytes()).unwrap().is_some());
        assert!(read_request(&mut b"".as_slice()).unwrap().is_none());
        assert!(decode::<NoArgs>(json!({"path":"unexpected"})).is_err());
    }
    #[test]
    fn only_existing_setup_commands_are_exposed() {
        assert_eq!(COMMANDS.len(), 11);
        for denied in [
            "install_app",
            "execute",
            "shell",
            "shutdown",
            "download_app",
        ] {
            assert!(!COMMANDS.contains(&denied));
        }
    }
}
