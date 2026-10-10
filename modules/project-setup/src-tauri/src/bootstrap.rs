//! Explicitly approved prerequisite installs using the pinned official Unity CLI.
use crate::logic::{self, EditorInstallation, EDITOR_CHANGESET, EDITOR_VERSION};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) static OPERATION: Mutex<()> = Mutex::new(());
const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const MAX_OUTPUT: usize = 4 * MIB as usize;
const MAX_LOG: usize = 16 * MIB as usize;
const MAX_LINE: usize = 64 * 1024;
// IDs verified against the pinned 6000.3.21f1 release manifests for all hosts.
const OPENJDK_MODULE: &str = "android-open-jdk-17.0.18+8";
const WINDOWS_MONO_MODULE: &str = "windows-mono";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub detail: String,
    pub percent: Option<f64>,
    pub transfer: Option<crate::download_progress::Transfer>,
}

fn progress(stage: &str, detail: impl Into<String>) -> Progress {
    Progress {
        stage: stage.into(),
        detail: detail.into(),
        percent: None,
        transfer: None,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    InstallEditor,
    AddModules,
    None,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    action: Action,
    pub install_hub: bool,
    pub editor_root: PathBuf,
    pub cache_root: PathBuf,
    pub modules: Vec<String>,
    pub download_bytes: u64,
    pub reserve_bytes: u64,
    pub log_directory: PathBuf,
}

impl Plan {
    pub fn confirmation(&self) -> String {
        if self.action == Action::None && self.install_hub {
            return "Install Unity Hub so you can activate Unity?\n\nYour existing Editor and build tools will be reused. Unity's official signed Hub installer will be downloaded.\n\nBy selecting Accept and install, you agree to the linked Unity terms. Windows may ask for administrator approval. You will complete sign-in and licence activation in Unity Hub. Existing projects and Editor versions will not be removed.".into();
        }
        format!(
            "Install the missing Unity requirements, then create your project?\n\nUnity {EDITOR_VERSION}; Android SDK, NDK and OpenJDK; Windows support.{}\nEditor: {}\nDownload cache: {}\nEditor/modules download: {:.1} GB.{}\nConservative free-space reserve: {:.1} GB (not an exact installed size).\n\nBy selecting Accept and install, you agree to the Unity Software Terms and the Android SDK/NDK and OpenJDK licences linked in Setup. Unity/Windows may still ask for sign-in, activation or administrator approval.\n\nExisting projects and other Editor versions will not be removed. Installers must finish before Setup can close.",
            if self.install_hub { " Unity Hub will also be installed." } else { "" },
            self.editor_root.display(), self.cache_root.display(),
            self.download_bytes as f64 / 1_000_000_000.0,
            if self.install_hub { " Hub is an additional download." } else { "" },
            self.reserve_bytes as f64 / 1_000_000_000.0,
        )
    }
}

fn roots_file() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("CreatorProjectSetup/editor-roots.json"))
}

pub(crate) fn known_editor_roots() -> Vec<PathBuf> {
    roots_file()
        .and_then(|path| File::open(path).ok())
        .and_then(|file| serde_json::from_reader::<_, Vec<PathBuf>>(file.take(16384)).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|path| path.is_absolute())
        .take(16)
        .collect()
}

fn remember_root(root: &Path) -> Result<(), String> {
    let path = roots_file().ok_or("Local application data is unavailable.")?;
    let mut roots = known_editor_roots();
    let parent = root
        .parent()
        .ok_or("Invalid Editor directory.")?
        .to_path_buf();
    roots.retain(|p| *p != parent);
    roots.insert(0, parent);
    roots.truncate(16);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(
        path,
        serde_json::to_vec_pretty(&roots).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Cannot remember the verified Editor location: {e}"))
}

fn module_selection(editor: Option<&EditorInstallation>) -> Result<(Action, Vec<String>), String> {
    module_selection_for(editor, std::env::consts::OS)
}

fn module_selection_for(
    editor: Option<&EditorInstallation>,
    host: &str,
) -> Result<(Action, Vec<String>), String> {
    let windows_is_module = match host {
        "windows" => false,
        "linux" | "macos" => true,
        _ => return Err("Automatic Unity installation is not supported on this platform.".into()),
    };
    let Some(editor) = editor else {
        let mut modules = vec!["android".into()];
        if windows_is_module {
            modules.push(WINDOWS_MONO_MODULE.into());
        }
        return Ok((Action::InstallEditor, modules));
    };
    if editor.ready {
        return Ok((Action::None, vec![]));
    }
    if editor.urp_template.is_none() || (!windows_is_module && !editor.windows_standalone) {
        return Err("The existing Editor is incomplete: a built-in component or URP template is missing. Setup will not overwrite this installation. Use Unity Hub to repair/reinstall this Editor, then check again.".into());
    }
    let mut modules = Vec::new();
    if !editor.android_player {
        modules.push("android".into());
    } else {
        if !editor.android_sdk || !editor.android_ndk {
            modules.push("android-sdk-ndk-tools".into());
        }
        if !editor.open_jdk {
            modules.push(OPENJDK_MODULE.into());
        }
    }
    if windows_is_module && !editor.windows_standalone {
        modules.push(WINDOWS_MONO_MODULE.into());
    }
    Ok((Action::AddModules, modules))
}

fn arguments(action: &Action, modules: &[String], preview: bool) -> Vec<String> {
    let mut args: Vec<String> = match action {
        Action::InstallEditor => vec!["install", EDITOR_VERSION, "--changeset", EDITOR_CHANGESET],
        Action::AddModules => vec!["install-modules", "--editor-version", EDITOR_VERSION],
        Action::None => vec![],
    }
    .into_iter()
    .map(String::from)
    .collect();
    if !modules.is_empty() {
        args.push("--module".into());
        args.extend_from_slice(modules);
        args.push("--cm".into());
    }
    if *action == Action::AddModules {
        // Include the same selected repair set in dry-run and installation.
        args.push("--reinstall".into());
    }
    if preview {
        args.push("--dry-run".into());
    } else if *action != Action::None {
        args.push("--accept-eula".into());
    }
    args
}

fn absolute_path(value: &Value, field: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(
        value[field]
            .as_str()
            .ok_or("Unity CLI did not report installation paths.")?,
    );
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(
            "Unity CLI reported an invalid installation path. Nothing was installed.".into(),
        );
    }
    Ok(path)
}

fn preview_size(value: &Value) -> Result<u64, String> {
    value["totalDownloadSize"]
        .as_u64()
        .filter(|size| *size > 0 && *size < 100 * GIB)
        .ok_or("Unity did not provide a valid download size. Nothing was installed.".into())
}

fn reserve(download: u64) -> Result<u64, String> {
    // Download cache, an installation/extraction allowance, and project-import headroom.
    download
        .checked_mul(4)
        .and_then(|n| n.checked_add(8 * GIB))
        .ok_or("The reported download is too large.".into())
}

#[cfg(windows)]
fn free_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut existing = path;
    while !existing.exists() {
        existing = existing.parent().ok_or("Cannot find the install volume.")?;
    }
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    if unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(format!(
            "Cannot check free space at {}. Nothing was installed.",
            existing.display()
        ));
    }
    Ok(available)
}

#[cfg(unix)]
fn free_space(path: &Path) -> Result<u64, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let mut existing = path;
    while !existing.exists() {
        existing = existing.parent().ok_or("Cannot find the install volume.")?;
    }
    let c_path = CString::new(existing.as_os_str().as_bytes())
        .map_err(|_| "Invalid path for free space check.")?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } == 0 {
        Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    } else {
        Err(format!(
            "Cannot check free space at {}. Nothing was installed.",
            existing.display()
        ))
    }
}

#[cfg(not(any(windows, unix)))]
fn free_space(_: &Path) -> Result<u64, String> {
    Err("Automatic Unity installation is not supported on this platform.".into())
}

fn check_space(plan: &Plan, project_parent: &Path) -> Result<(), String> {
    // Checking the combined allowance on each involved volume is conservative even
    // when paths share a volume; it never undercounts their simultaneous usage.
    for path in [
        &plan.editor_root,
        &plan.cache_root,
        &project_parent.to_path_buf(),
    ] {
        let available = free_space(path)?;
        if available < plan.reserve_bytes {
            return Err(format!("Not enough free space at {}: {:.1} GB available; {:.1} GB reserved for downloads, extraction and project import. Free space or choose another installation/project location. Nothing was installed.", path.display(), available as f64 / 1e9, plan.reserve_bytes as f64 / 1e9));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn require_editor_closed(executable: &Path) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
        System::{
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
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Cannot check running Editors. Nothing was installed.".into());
        }
        let result = (|| {
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry);
            while more != 0 {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..length])
                    .eq_ignore_ascii_case("Unity.exe")
                {
                    let process =
                        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if process.is_null() {
                        return Err("A Unity Editor is running but its location cannot be verified. Close Unity normally before installing modules.".into());
                    }
                    let mut name = vec![0u16; 32768];
                    let mut count = name.len() as u32;
                    let ok = QueryFullProcessImageNameW(process, 0, name.as_mut_ptr(), &mut count);
                    CloseHandle(process);
                    if ok == 0 {
                        return Err("Cannot verify a running Unity Editor. Close Unity normally before installing modules.".into());
                    }
                    let running = PathBuf::from(String::from_utf16_lossy(&name[..count as usize]));
                    if running
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&executable.to_string_lossy())
                        || fs::canonicalize(&running)
                            .ok()
                            .zip(fs::canonicalize(executable).ok())
                            .is_some_and(|(a, b)| a == b)
                    {
                        return Err(format!("Unity {EDITOR_VERSION} is running. Save your work and close its Editor windows before adding modules. Nothing was force-closed."));
                    }
                }
                more = Process32NextW(snapshot, &mut entry);
            }
            if GetLastError() != ERROR_NO_MORE_FILES {
                return Err(
                    "Could not finish checking running Editors. Nothing was installed.".into(),
                );
            }
            Ok(())
        })();
        CloseHandle(snapshot);
        result
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn require_editor_closed(executable: &Path) -> Result<(), String> {
    crate::unix_editors::require_closed(executable)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn require_editor_closed(_: &Path) -> Result<(), String> {
    Err("Automatic installation is not supported on this platform.".into())
}

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(180)
        .collect()
}

fn dependency_notice(line: &[u8]) -> bool {
    let Ok(line) = std::str::from_utf8(line) else {
        return false;
    };
    let Some(rest) = line.trim_end_matches('\r').strip_prefix("Adding module ") else {
        return false;
    };
    let Some((child, parent)) = rest.split_once(" as dependency of ") else {
        return false;
    };
    let Some(parent) = parent.strip_suffix('.') else {
        return false;
    };
    [child, parent].into_iter().all(|id| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._+".contains(&c))
    })
}

fn parse_report(mut bytes: &[u8], label: &str) -> Result<Value, String> {
    // beta.9 prints dependency notices on stdout even with --quiet --json.
    // Permit only that exact prelude on install previews, then parse ONE complete
    // JSON document. Never scan past unknown warnings/errors to find a success.
    if label == "preview" {
        while let Some(end) = bytes.iter().position(|c| *c == b'\n') {
            if !dependency_notice(&bytes[..end]) {
                break;
            }
            bytes = &bytes[end + 1..];
        }
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| format!("Unity returned an invalid {label} report. Review the requirement logs before retrying."))?;
    if value["success"] != true {
        return Err(format!("Unity could not verify its {label} report. Review the requirement logs before retrying."));
    }
    Ok(value["data"].clone())
}

fn frame_progress(frame: &Value) -> Option<Progress> {
    if frame["type"] != "progress" {
        return None;
    }
    let phase = frame["phase"].as_str()?;
    if !["download", "install"].contains(&phase) {
        return None;
    }
    let name = compact(
        frame["msg"]
            .as_str()
            .or_else(|| frame["name"].as_str())
            .unwrap_or("Unity requirements"),
    );
    let percent = if phase == "download" {
        frame["pct"]
            .as_f64()
            .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
    } else {
        None
    };
    Some(Progress {
        stage: if phase == "download" {
            "Downloading requirements"
        } else {
            "Installing requirements"
        }
        .into(),
        detail: name,
        percent,
        transfer: None,
    })
}

struct Capture {
    bytes: Vec<u8>,
    overflow: bool,
    failed_result: bool,
}

fn capture(
    reader: impl Read,
    mut log: File,
    frames: Option<mpsc::SyncSender<Progress>>,
    record: bool,
) -> Result<Capture, String> {
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    let mut written = 0;
    let mut overflow = false;
    let mut failed_result = false;
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let remaining = if record {
            MAX_LOG.saturating_sub(written)
        } else {
            0
        };
        let keep = remaining.min(line.len());
        if keep > 0 {
            log.write_all(&line[..keep]).map_err(|e| e.to_string())?;
            written += keep;
        }
        if bytes.len() + line.len() <= MAX_OUTPUT {
            bytes.extend_from_slice(&line);
        } else {
            overflow = true;
        }
        if line.len() <= MAX_LINE {
            if let Ok(frame) = serde_json::from_slice::<Value>(&line) {
                failed_result |= frame["type"] == "result" && frame["success"] == false;
                if let (Some(sender), Some(event)) = (&frames, frame_progress(&frame)) {
                    let _ = sender.try_send(event);
                }
            }
        }
    }
    if written == MAX_LOG {
        log.write_all(b"\n[Setup log limit reached; remaining output was drained.]\n")
            .map_err(|e| e.to_string())?;
    }
    Ok(Capture {
        bytes,
        overflow,
        failed_result,
    })
}

fn run_cli(
    helper: &Path,
    args: &[String],
    label: &str,
    logs: &Path,
    preview: bool,
    emit: &impl Fn(Progress),
) -> Result<Value, String> {
    run_cli_tracked(helper, args, label, logs, preview, emit, None)
}

fn run_cli_tracked(
    helper: &Path,
    args: &[String],
    label: &str,
    logs: &Path,
    preview: bool,
    emit: &impl Fn(Progress),
    mut downloads: Option<crate::download_progress::CliDownloads>,
) -> Result<Value, String> {
    let stdout =
        File::create(logs.join(format!("{label}.stdout.log"))).map_err(|e| e.to_string())?;
    let stderr =
        File::create(logs.join(format!("{label}.stderr.log"))).map_err(|e| e.to_string())?;
    let mut command = Command::new(helper);
    command
        .args(args)
        .args([
            "--format",
            if preview { "json" } else { "ndjson" },
            "--non-interactive",
            "--no-banner",
            "--no-pager",
            "--no-color",
        ])
        .env("UNITY_NO_UPDATE_CHECK", "1")
        .env("UNITY_NO_CONSENT_PROMPT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start the verified Unity helper: {e}"))?;
    let out = child.stdout.take().ok_or("Missing Unity output pipe.")?;
    let err = child.stderr.take().ok_or("Missing Unity error pipe.")?;
    let (sender, receiver) = mpsc::sync_channel(32);
    let result = std::thread::scope(|scope| {
        // Path reports may contain proxy settings; licence reports contain account
        // identifiers. Parse their needed fields in memory, never persist the raw data.
        let record = !["paths", "licence"].contains(&label);
        let stdout_reader = scope.spawn(move || capture(out, stdout, Some(sender), record));
        let stderr_reader = scope.spawn(move || capture(err, stderr, None, record));
        let start = Instant::now();
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if preview && start.elapsed() > Duration::from_secs(120) {
                // Only read-only queries may be terminated. Never interrupt an installer.
                child.kill().map_err(|e| e.to_string())?;
                timed_out = true;
                break child.wait().map_err(|e| e.to_string())?;
            }
            if let Ok(event) = receiver.recv_timeout(Duration::from_millis(200)) {
                let event = if let Some(downloads) = &mut downloads {
                    downloads.event(event)
                } else {
                    event
                };
                emit(event);
            }
            if let Some(event) = downloads.as_mut().and_then(|downloads| downloads.poll()) {
                emit(event);
            }
        };
        let out = stdout_reader
            .join()
            .map_err(|_| "Unity output reader stopped.")??;
        let err = stderr_reader
            .join()
            .map_err(|_| "Unity error reader stopped.")??;
        for event in receiver.try_iter() {
            let event = if let Some(downloads) = &mut downloads {
                downloads.event(event)
            } else {
                event
            };
            emit(event);
        }
        if timed_out {
            return Err("Unity's read-only requirement check timed out. Check your connection and try again.".into());
        }
        // A fresh CLI can request sign-in/first-run configuration instead of
        // returning active:false. This means NOT verified, never permission to
        // create a project; let the native Hub handoff handle the user action.
        if preview && label == "licence" && matches!(status.code(), Some(3 | 4)) {
            return Ok(json!({"active":false,"requiresUserAction":true}));
        }
        if !status.success() || out.failed_result || err.failed_result {
            let guidance = match status.code() {
                Some(3) => "Sign in to Unity and check licence activation, then try again.",
                Some(4) => "Unity needs a preference or approval. Check Unity Hub and the local logs.",
                Some(7) => "Unity's download service could not be reached. Check your connection before retrying.",
                _ => "Check for a declined administrator/licence prompt, a failed download or insufficient disk space. Existing installations were preserved; recheck before retrying.",
            };
            return Err(format!(
                "Unity requirement step '{label}' failed (exit {}). {guidance} Logs: {}",
                status
                    .code()
                    .map(|n| n.to_string())
                    .unwrap_or("unknown".into()),
                logs.display()
            ));
        }
        if !preview {
            return Ok(Value::Null);
        }
        if out.overflow {
            return Err("Unity's requirement report was too large. Nothing was installed.".into());
        }
        parse_report(&out.bytes, label)
    });
    result
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).into()).collect()
}

fn active_licence(data: &Value) -> Result<bool, String> {
    data["active"].as_bool().ok_or("Unity did not return a valid licence status. Check activation in Unity Hub before creating the project.".into())
}

pub fn licence_ready(emit: impl Fn(Progress)) -> Result<bool, String> {
    let helper =
        crate::hub::prepare_helper(&|detail| emit(progress("Checking Unity licence", detail)))?;
    emit(progress(
        "Checking Unity licence",
        "Checking activation before creating any project files.",
    ));
    let logs = dirs::data_local_dir()
        .ok_or("Local application data is unavailable.")?
        .join("CreatorProjectSetup/logs")
        .join(format!("licence-{}", crate::hub::unique_id()));
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    active_licence(&run_cli(
        &helper,
        &strings(&["license", "status"]),
        "licence",
        &logs,
        true,
        &emit,
    )?)
}

fn editor_root_for(executable: &Path, host: &str) -> Result<PathBuf, String> {
    let suffix = match host {
        "windows" => Path::new("Editor/Unity.exe"),
        "linux" => Path::new("Editor/Unity"),
        "macos" => Path::new("Unity.app/Contents/MacOS/Unity"),
        _ => return Err("Unsupported Unity Editor platform.".into()),
    };
    if !executable.ends_with(suffix) {
        return Err("Unexpected Unity Editor path.".into());
    }
    executable
        .ancestors()
        .nth(suffix.components().count())
        .map(Path::to_path_buf)
        .ok_or("Unexpected Unity Editor path.".into())
}

fn registered_executable(location: PathBuf, host: &str) -> PathBuf {
    if host == "macos" && location.ends_with("Unity.app") {
        location.join("Contents/MacOS/Unity")
    } else {
        location
    }
}

fn registered_editor(data: &Value) -> Result<Option<EditorInstallation>, String> {
    let editors = data
        .as_array()
        .ok_or("Unity did not return its Editor inventory.")?;
    let matches: Vec<_> = editors
        .iter()
        .filter(|e| e["version"] == EDITOR_VERSION)
        .collect();
    if matches.len() > 1 {
        return Err("Multiple matching Editor installations were found. Resolve the ambiguity in Unity Hub before installing modules.".into());
    }
    let Some(entry) = matches.first() else {
        return Ok(None);
    };
    let executable = registered_executable(absolute_path(entry, "location")?, std::env::consts::OS);
    let root = editor_root_for(&executable, std::env::consts::OS)?;
    let editor = logic::inspect_editor(root).ok_or("The registered Editor is missing or incomplete. Review its installation in Unity Hub before retrying.")?;
    if !editor.exact_recipe || Path::new(&editor.executable) != executable {
        return Err("Unity's registered Editor location does not match the pinned recipe.".into());
    }
    Ok(Some(editor))
}

fn check_local_inventory(
    local: &[EditorInstallation],
    registered: Option<&EditorInstallation>,
) -> Result<(), String> {
    for editor in local.iter().filter(|e| e.exact_recipe) {
        if !registered
            .is_some_and(|entry| entry.executable.eq_ignore_ascii_case(&editor.executable))
        {
            return Err("An existing matching Editor was found outside Unity CLI's verified inventory. Add that installation in Unity Hub and check again. Setup will not install a duplicate or modify an unregistered Editor.".into());
        }
    }
    Ok(())
}

fn check_plan_current(plan: &Plan, paths: &Value, editors: &Value) -> Result<(), String> {
    let existing = registered_editor(editors)?;
    let root = existing
        .as_ref()
        .map(|e| PathBuf::from(&e.root))
        .unwrap_or(absolute_path(paths, "editorInstallPath")?.join(EDITOR_VERSION));
    let (action, modules) = module_selection(existing.as_ref())?;
    if root != plan.editor_root
        || absolute_path(paths, "downloadCachePath")? != plan.cache_root
        || action != plan.action
        || modules != plan.modules
        || (action == Action::InstallEditor && root.exists())
    {
        return Err("Unity's installation location or requirements changed while approval was open. Nothing further was installed. Check again to review a fresh plan.".into());
    }
    if let Some(editor) = existing.filter(|_| action == Action::AddModules) {
        require_editor_closed(Path::new(&editor.executable))?;
    }
    Ok(())
}

pub fn ensure(
    request: &logic::CreateRequest,
    approve: impl Fn(&Plan) -> bool,
    emit: impl Fn(Progress),
) -> Result<(), String> {
    ensure_inner(request, false, approve, emit)
}

pub fn ensure_activation_hub(
    request: &logic::CreateRequest,
    approve: impl Fn(&Plan) -> bool,
    emit: impl Fn(Progress),
) -> Result<(), String> {
    ensure_inner(request, true, approve, emit)
}

fn can_reuse(ready: bool, hub_installed: bool, require_hub: bool) -> bool {
    ready && (!require_hub || hub_installed)
}

fn ensure_inner(
    request: &logic::CreateRequest,
    require_hub: bool,
    approve: impl Fn(&Plan) -> bool,
    emit: impl Fn(Progress),
) -> Result<(), String> {
    let target = logic::creation_target(request)?;
    let initial = logic::probe_environment();
    if can_reuse(initial.ready, initial.hub_installed, require_hub) {
        if free_space(target.parent().unwrap())? < 8 * GIB {
            return Err("Project creation needs an 8 GiB free-space reserve for package downloads and imports. Choose a location with more space before starting.".into());
        }
        return Ok(());
    }
    let logs = dirs::data_local_dir()
        .ok_or("Local application data is unavailable.")?
        .join("CreatorProjectSetup/logs")
        .join(format!("requirements-{}", crate::hub::unique_id()));
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let result = (|| {
        emit(progress(
            "Checking Unity requirements",
            "Preparing the verified official Unity helper.",
        ));
        let helper = crate::hub::prepare_helper(&|detail| {
            emit(progress("Checking Unity requirements", detail))
        })?;
        let paths = run_cli(&helper, &strings(&["env"]), "paths", &logs, true, &emit)?;
        let install_parent = absolute_path(&paths, "editorInstallPath")?;
        let cache_root = absolute_path(&paths, "downloadCachePath")?;
        let editors = run_cli(
            &helper,
            &strings(&["editors", "--installed"]),
            "editors",
            &logs,
            true,
            &emit,
        )?;
        let existing = registered_editor(&editors)?;
        check_local_inventory(&initial.editors, existing.as_ref())?;
        if let Some(editor) = &existing {
            remember_root(Path::new(&editor.root))?;
        }
        let (action, modules) = module_selection(existing.as_ref())?;
        if action == Action::AddModules {
            require_editor_closed(Path::new(&existing.as_ref().unwrap().executable))?;
        }
        if action == Action::None && initial.hub_installed {
            if free_space(target.parent().unwrap())? < 8 * GIB {
                return Err("Project creation needs an 8 GiB free-space reserve. Choose a location with more space.".into());
            }
            return Ok(());
        }
        let editor_root = existing
            .as_ref()
            .map(|e| PathBuf::from(&e.root))
            .unwrap_or_else(|| install_parent.join(EDITOR_VERSION));
        if action == Action::InstallEditor && editor_root.exists() {
            return Err("The target Editor directory already exists but is not a verified registered installation. Setup will not overwrite it. Review the partial/manual installation in Unity Hub.".into());
        }
        let preview = if action == Action::None {
            Value::Null
        } else {
            emit(progress(
                "Planning Unity installation",
                "Checking download sizes without installing anything.",
            ));
            run_cli(
                &helper,
                &arguments(&action, &modules, true),
                "preview",
                &logs,
                true,
                &emit,
            )?
        };
        let download_bytes = if action == Action::None {
            0
        } else {
            preview_size(&preview)?
        };
        let plan = Plan {
            action,
            install_hub: !initial.hub_installed,
            editor_root,
            cache_root,
            modules,
            download_bytes,
            reserve_bytes: reserve(download_bytes)?,
            log_directory: logs.clone(),
        };
        check_space(&plan, target.parent().unwrap())?;
        emit(progress(
            "Approval required",
            "Review Unity's installation location, download and licence terms.",
        ));
        if !approve(&plan) {
            return Err("Setup cancelled before installation. No Editor or modules were installed and no project was created.".into());
        }
        logic::creation_target(request)?;
        check_space(&plan, target.parent().unwrap())?;
        let recheck = || -> Result<(), String> {
            let paths = run_cli(&helper, &strings(&["env"]), "paths", &logs, true, &emit)?;
            let editors = run_cli(
                &helper,
                &strings(&["editors", "--installed"]),
                "editors",
                &logs,
                true,
                &emit,
            )?;
            check_plan_current(&plan, &paths, &editors)
        };
        recheck()?;
        if plan.install_hub {
            emit(progress(
                "Installing Unity Hub",
                if cfg!(windows) {
                    "Downloading the official signed installer. Windows may ask for approval."
                } else {
                    "Installing Unity Hub via the official Unity CLI."
                },
            ));
            #[cfg(windows)]
            crate::hub_installer::install(&logs, &emit)?;
            #[cfg(not(windows))]
            {
                run_cli(
                    &helper,
                    &strings(&["hub", "install"]),
                    "hub-install",
                    &logs,
                    false,
                    &emit,
                )?;
            }
            if !logic::probe_environment().hub_installed {
                return Err("Unity Hub did not appear after installation. Check local logs before retrying.".into());
            }
        }
        if plan.action != Action::None {
            // Hub installation can change its configured Editor location.
            if plan.install_hub {
                recheck()?;
            }
            if let Some(editor) = &existing {
                require_editor_closed(Path::new(&editor.executable))?;
            }
            emit(progress("Installing Unity requirements", "Unity is downloading and installing the approved components. Administrator prompts may appear."));
            run_cli_tracked(
                &helper,
                &arguments(&plan.action, &plan.modules, false),
                "install-editor",
                &logs,
                false,
                &emit,
                Some(crate::download_progress::CliDownloads::new(
                    plan.cache_root.clone(),
                    &preview,
                    plan.download_bytes,
                )),
            )?;
        }
        emit(progress(
            "Verifying Unity requirements",
            "Checking the installed Editor, Android tools, Windows support and URP template.",
        ));
        let installed = logic::inspect_editor(plan.editor_root.clone())
            .ok_or("The required Editor executable is still missing after installation.")?;
        fs::write(
            logs.join("installed-requirements.json"),
            serde_json::to_vec_pretty(&installed).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Cannot record installed requirement checks: {e}"))?;
        if !installed.ready {
            return Err("Unity finished, but one or more required components are still missing. No project was created. Recheck before retrying; inspect the requirement logs.".into());
        }
        remember_root(&plan.editor_root)?;
        if !logic::probe_environment().ready {
            return Err("Requirement verification did not pass. No project was created.".into());
        }
        Ok(())
    })();
    let receipt = json!({ "schemaVersion": 1, "setupVersion": env!("CARGO_PKG_VERSION"), "recordedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(), "editorVersion": EDITOR_VERSION, "success": result.is_ok(), "error": result.as_ref().err(), "logDirectory": logs, "projectCreated": false });
    fs::write(
        logs.join("requirements-receipt.json"),
        serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Cannot write requirement receipt: {e}"))?;
    result.map_err(|error: String| {
        format!(
            "{error} Requirement report: {}",
            logs.join("requirements-receipt.json").display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_fresh_install_preview_allows_only_known_dependency_prelude() {
        let fixture = include_bytes!("../tests/fixtures/cli-install-preview.txt");
        let data = parse_report(fixture, "preview").unwrap();
        assert_eq!(data["alreadyInstalled"], false);
        assert_eq!(preview_size(&data).unwrap(), 6_954_591_148);
        assert!(parse_report(fixture, "paths").is_err());
        for noise in [
            "Error: failed\n",
            "unexpected warning\n",
            "Adding module ;bad as dependency of android.\n",
        ] {
            let output = format!("{noise}{{\"success\":true,\"data\":{{}}}}");
            assert!(parse_report(output.as_bytes(), "preview").is_err());
        }
        assert!(parse_report(
            b"Adding module android as dependency of test.\n{\"success\":false}",
            "preview"
        )
        .is_err());
        assert!(parse_report(b"{\"success\":true} trailing-error", "preview").is_err());
    }

    #[test]
    fn cli_only_install_reuse_depends_on_activation_handoff() {
        assert!(can_reuse(true, false, false));
        assert!(!can_reuse(true, false, true));
        assert!(can_reuse(true, true, true));
        assert!(!can_reuse(false, true, false));
        let plan = Plan {
            action: Action::None,
            install_hub: true,
            editor_root: PathBuf::new(),
            cache_root: PathBuf::new(),
            modules: vec![],
            download_bytes: 0,
            reserve_bytes: 0,
            log_directory: PathBuf::new(),
        };
        assert!(plan
            .confirmation()
            .contains("existing Editor and build tools will be reused"));
        assert!(!plan.confirmation().contains("0.0 GB"));
    }

    #[test]
    #[cfg(windows)]
    fn real_child_pipes_preserve_reports_progress_and_failure_results() {
        let temp = tempfile::tempdir().unwrap();
        let helper = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prerequisite-cli.ps1");
        let call = |mode: &str, query: bool, emit: &dyn Fn(Progress)| {
            run_cli(
                &helper,
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-File".into(),
                    fixture.to_string_lossy().into(),
                    mode.into(),
                ],
                "fixture",
                temp.path(),
                query,
                &|p| emit(p),
            )
        };
        assert_eq!(
            call("query", true, &|_| {}).unwrap()["totalDownloadSize"],
            1234
        );
        assert!(call("bad-json", true, &|_| {}).is_err());
        assert!(
            call("false-result", false, &|_| {}).is_err(),
            "A zero exit code cannot override a failed result"
        );
        assert!(call("offline", false, &|_| {})
            .unwrap_err()
            .contains("connection"));
        let events = Mutex::new(Vec::new());
        call("progress", false, &|event| {
            events.lock().unwrap().push(event)
        })
        .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].percent, Some(42.0));
        assert_eq!(events[0].detail, "Downloading Android Build Support...");
        assert_eq!(events[1].percent, None);
    }

    #[test]
    #[cfg(windows)]
    fn child_download_growth_emits_metrics_even_when_cli_percent_is_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let helper = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prerequisite-cli.ps1");
        let preview = parse_report(
            include_bytes!("../tests/fixtures/cli-install-preview.txt"),
            "preview",
        )
        .unwrap();
        let output = cache.join(
            "jdk17.0.18-8_15e8817d1f5db6db3571ebe7430ef37f7fa8e60e8ff6f3e18ca1cb4c29f78774.zip",
        );
        let events = Mutex::new(Vec::new());
        run_cli_tracked(
            &helper,
            &[
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-File".into(),
                fixture.to_string_lossy().into(),
                "stream-progress".into(),
                output.to_string_lossy().into(),
            ],
            "fixture-stream",
            temp.path(),
            false,
            &|p| events.lock().unwrap().push(p),
            Some(crate::download_progress::CliDownloads::new(
                cache,
                &preview,
                preview_size(&preview).unwrap(),
            )),
        )
        .unwrap();
        let events = events.lock().unwrap();
        assert!(events.iter().filter_map(|p| p.transfer.as_ref()).any(|t| t
            .downloaded_bytes
            .is_some_and(|b| b > 0 && b < 118110508)
            && t.bytes_per_second.is_some_and(|r| r > 0.0 && r.is_finite())));
        assert!(events.last().unwrap().transfer.is_none());
        assert!(events.iter().all(|p| p.percent != Some(8.0)));
        assert_eq!(fs::metadata(output).unwrap().len(), 20 * 65536);
    }

    #[test]
    #[cfg(windows)]
    fn fresh_licence_configuration_requests_handoff_but_other_errors_still_fail() {
        let temp = tempfile::tempdir().unwrap();
        let helper = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prerequisite-cli.ps1");
        for (mode, label, handoff) in [
            ("configuration", "licence", true),
            ("auth", "licence", true),
            ("offline", "licence", false),
            ("bad-json", "licence", false),
            ("configuration", "install-editor", false),
        ] {
            let result = run_cli(
                &helper,
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-File".into(),
                    fixture.to_string_lossy().into(),
                    mode.into(),
                ],
                label,
                temp.path(),
                true,
                &|_| {},
            );
            if handoff {
                let data = result.unwrap();
                assert!(!active_licence(&data).unwrap());
                assert_eq!(data["requiresUserAction"], true);
            } else {
                assert!(result.is_err());
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn active_editor_guard_blocks_only_the_selected_executable() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let helper =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/ping.exe");
        let executable = temp.path().join("Unity.exe");
        fs::copy(helper, &executable).unwrap();
        let mut child = Command::new(&executable)
            .args(["-t", "127.0.0.1"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Capture outcomes before assertions so this exact owned fixture is always reaped.
        let selected = require_editor_closed(&executable);
        let unrelated = require_editor_closed(&temp.path().join("another/Unity.exe"));
        let _ = child.kill();
        child.wait().unwrap();
        assert!(selected.unwrap_err().contains("running"));
        assert!(unrelated.is_ok());
    }

    #[test]
    #[ignore = "installs Unity on an explicitly approved disposable Actions runner only"]
    fn disposable_install_smoke() {
        for (key, value) in [
            ("GITHUB_ACTIONS", "true"),
            ("CI", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("CREATOR_SETUP_ACCEPT_TEST_LICENSES", "true"),
        ] {
            assert_eq!(
                std::env::var(key).as_deref(),
                Ok(value),
                "Disposable installation requires explicit CI licence approval"
            );
        }
        assert_eq!(
            std::env::var("RUNNER_OS").as_deref(),
            Ok(match std::env::consts::OS {
                "windows" => "Windows",
                "linux" => "Linux",
                "macos" => "macOS",
                _ => panic!("Unsupported installation test host"),
            })
        );
        let environment = logic::probe_environment();
        assert!(
            environment.editors.is_empty(),
            "This test requires no existing Editor"
        );
        let parent = std::env::var_os("RUNNER_TEMP").map(PathBuf::from).unwrap();
        let request = logic::CreateRequest {
            project_name: "CreatorBootstrapSmoke".into(),
            parent_directory: parent.to_string_lossy().into(),
        };
        let mut report = json!({"setupVersion":env!("CARGO_PKG_VERSION"), "editorVersion":EDITOR_VERSION,"prerequisitesVerified":false,"cancellationVerified":false,"existingInstallReused":false,"missingJdkRepaired":false,"activationHandoffRequired":false,"completed":false,"projectCreated":false,"unityAccountUsed":false,"licenseActivationTested":false});
        report["platform"] = json!(std::env::consts::OS);
        report["architecture"] = json!(std::env::consts::ARCH);
        report["hubInitiallyInstalled"] = json!(environment.hub_installed);
        let checkpoint = |value: &Value| {
            fs::write(
                parent.join("creator-prerequisite-acceptance.json"),
                serde_json::to_vec_pretty(value).unwrap(),
            )
            .unwrap()
        };
        checkpoint(&report);
        assert!(!parent.join(&request.project_name).exists());
        let cancelled = ensure(&request, |_| false, |_| {}).unwrap_err();
        assert!(
            cancelled.contains("cancelled before installation"),
            "Preflight did not reach cancellation: {cancelled}"
        );
        assert_eq!(
            logic::probe_environment().hub_installed,
            environment.hub_installed
        );
        assert!(logic::probe_environment().editors.is_empty());
        assert!(!parent.join(&request.project_name).exists());
        report["cancellationVerified"] = json!(true);
        checkpoint(&report);
        ensure(
            &request,
            |plan| {
                println!(
                    "Approved disposable plan: {}",
                    serde_json::to_string(plan).unwrap()
                );
                true
            },
            |event| println!("{}", serde_json::to_string(&event).unwrap()),
        )
        .unwrap();
        assert!(logic::probe_environment().ready);
        report["prerequisitesVerified"] = json!(true);
        checkpoint(&report);
        ensure(
            &request,
            |_| panic!("A verified installation must be reused"),
            |_| {},
        )
        .unwrap();

        // Damage only a named file in the installation created above, on this
        // disposable runner, to prove repair defeats stale Installed metadata.
        report["existingInstallReused"] = json!(true);
        checkpoint(&report);
        let installed = logic::probe_environment()
            .editors
            .into_iter()
            .find(|e| e.exact_recipe)
            .unwrap();
        let root = fs::canonicalize(&installed.root).unwrap();
        let android = logic::playback_engines(&root).join("AndroidPlayer");
        let java = android.join(if cfg!(windows) {
            "OpenJDK/bin/java.exe"
        } else {
            "OpenJDK/bin/java"
        });
        assert!(fs::canonicalize(&java).unwrap().starts_with(&root));
        fs::remove_file(&java).unwrap();
        assert!(!logic::probe_environment().ready);
        ensure(
            &request,
            |plan| {
                assert_eq!(plan.action, Action::AddModules);
                assert_eq!(plan.modules, vec![OPENJDK_MODULE]);
                assert!(!plan.install_hub);
                println!(
                    "Approved isolated OpenJDK repair: {}",
                    serde_json::to_string(plan).unwrap()
                );
                true
            },
            |event| println!("{}", serde_json::to_string(&event).unwrap()),
        )
        .unwrap();
        assert!(java.is_file());
        assert!(logic::probe_environment().ready);
        report["missingJdkRepaired"] = json!(true);
        checkpoint(&report);
        let mut tool_versions = serde_json::Map::new();
        for (relative, arg) in [
            (
                if cfg!(windows) {
                    "OpenJDK/bin/java.exe"
                } else {
                    "OpenJDK/bin/java"
                },
                "-version",
            ),
            (
                if cfg!(windows) {
                    "OpenJDK/bin/javac.exe"
                } else {
                    "OpenJDK/bin/javac"
                },
                "-version",
            ),
            (
                if cfg!(windows) {
                    "SDK/platform-tools/adb.exe"
                } else {
                    "SDK/platform-tools/adb"
                },
                "version",
            ),
            (
                match std::env::consts::OS {
                    "windows" => "NDK/toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe",
                    "macos" => "NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin/clang",
                    _ => "NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/clang",
                },
                "--version",
            ),
        ] {
            let mut command = Command::new(android.join(relative));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.arg(arg).stdin(Stdio::null()).output().unwrap();
            assert!(
                output.status.success(),
                "Installed tool cannot run: {relative}"
            );
            let version = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(!version.trim().is_empty());
            tool_versions.insert(relative.into(), json!(compact(&version)));
        }
        report["toolVersions"] = Value::Object(tool_versions);
        checkpoint(&report);
        assert!(
            !licence_ready(|_| {}).unwrap(),
            "This disposable test must require a user activation handoff"
        );
        assert!(
            !parent.join(&request.project_name).exists(),
            "Prerequisite testing must not pretend it created a Unity project"
        );
        report["activationHandoffRequired"] = json!(true);
        report["completed"] = json!(true);
        checkpoint(&report);
    }
    fn editor() -> EditorInstallation {
        EditorInstallation {
            version: EDITOR_VERSION.into(),
            root: "test".into(),
            executable: "test".into(),
            exact_recipe: true,
            android_player: true,
            android_sdk: true,
            android_ndk: true,
            open_jdk: true,
            windows_standalone: true,
            urp_template: Some("template.tgz".into()),
            ready: true,
        }
    }
    #[test]
    fn plans_only_the_missing_android_requirements() {
        assert_eq!(
            module_selection_for(None, "windows").unwrap(),
            (Action::InstallEditor, vec!["android".into()])
        );
        let mut e = editor();
        assert_eq!(module_selection(Some(&e)).unwrap().0, Action::None);
        e.ready = false;
        e.open_jdk = false;
        assert_eq!(module_selection(Some(&e)).unwrap().1, vec![OPENJDK_MODULE]);
        e.android_ndk = false;
        assert_eq!(
            module_selection(Some(&e)).unwrap().1,
            vec!["android-sdk-ndk-tools", OPENJDK_MODULE]
        );
        e.android_player = false;
        assert_eq!(module_selection(Some(&e)).unwrap().1, vec!["android"]);
    }
    #[test]
    fn damaged_core_is_not_silently_reinstalled() {
        let mut e = editor();
        e.ready = false;
        e.urp_template = None;
        assert!(module_selection(Some(&e)).is_err());
        e.urp_template = Some("x".into());
        e.windows_standalone = false;
        assert!(module_selection_for(Some(&e), "windows").is_err());
    }
    #[test]
    fn unix_hosts_install_and_repair_windows_cross_build_support() {
        for host in ["linux", "macos"] {
            assert_eq!(
                module_selection_for(None, host).unwrap(),
                (
                    Action::InstallEditor,
                    vec!["android".into(), WINDOWS_MONO_MODULE.into()]
                )
            );
            let mut e = editor();
            assert_eq!(
                module_selection_for(Some(&e), host).unwrap().0,
                Action::None
            );
            e.ready = false;
            e.windows_standalone = false;
            assert_eq!(
                module_selection_for(Some(&e), host).unwrap(),
                (Action::AddModules, vec![WINDOWS_MONO_MODULE.into()])
            );
            e.open_jdk = false;
            assert_eq!(
                module_selection_for(Some(&e), host).unwrap().1,
                vec![OPENJDK_MODULE, WINDOWS_MONO_MODULE]
            );
            e.android_player = false;
            assert_eq!(
                module_selection_for(Some(&e), host).unwrap().1,
                vec!["android", WINDOWS_MONO_MODULE]
            );
            e.urp_template = None;
            assert!(module_selection_for(Some(&e), host).is_err());
        }
        assert!(module_selection_for(None, "unknown").is_err());
    }
    #[test]
    fn registered_editor_roots_follow_the_host_bundle_layout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(EDITOR_VERSION);
        for (host, suffix) in [
            ("windows", "Editor/Unity.exe"),
            ("linux", "Editor/Unity"),
            ("macos", "Unity.app/Contents/MacOS/Unity"),
        ] {
            assert_eq!(editor_root_for(&root.join(suffix), host).unwrap(), root);
            assert!(editor_root_for(&root.join("Other/Unity"), host).is_err());
        }
        assert!(editor_root_for(&root.join("Editor/Unity"), "unknown").is_err());
        let bundle = root.join("Unity.app");
        let executable = bundle.join("Contents/MacOS/Unity");
        assert_eq!(registered_executable(bundle.clone(), "macos"), executable);
        assert_eq!(
            registered_executable(executable.clone(), "macos"),
            executable
        );
        assert_eq!(registered_executable(bundle.clone(), "linux"), bundle);
        assert_eq!(
            editor_root_for(
                &registered_executable(root.join("Unity.app"), "macos"),
                "macos"
            )
            .unwrap(),
            root
        );
    }
    #[test]
    #[ignore = "downloads the pinned Unity CLI and queries its dry-run plan on a disposable hosted runner"]
    fn disposable_preview_smoke() {
        for (key, value) in [
            ("GITHUB_ACTIONS", "true"),
            ("CI", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
        ] {
            assert_eq!(std::env::var(key).as_deref(), Ok(value));
        }
        let logs = tempfile::tempdir().unwrap();
        let helper = crate::hub::prepare_helper(&|_| {}).unwrap();
        let (action, modules) = module_selection(None).unwrap();
        let args = arguments(&action, &modules, true);
        assert!(args.iter().any(|arg| arg == "--dry-run"));
        assert!(!args.iter().any(|arg| arg == "--accept-eula"));
        let preview = run_cli(&helper, &args, "preview", logs.path(), true, &|_| {}).unwrap();
        assert_eq!(preview["editor"]["version"], EDITOR_VERSION);
        assert!(!preview["alreadyInstalled"].as_bool().unwrap());
        assert!(preview_size(&preview).unwrap() > GIB);
        let planned = preview["modules"].as_array().unwrap();
        for required in ["android", OPENJDK_MODULE, "android-ndk-r27c"] {
            assert!(
                planned.iter().any(|module| module["id"] == required),
                "Missing {required}"
            );
        }
        if !cfg!(windows) {
            assert!(planned
                .iter()
                .any(|module| module["id"] == WINDOWS_MONO_MODULE));
        }
        println!("Verified pinned CLI dry-run on {} {}: {} bytes; no Editor installed or licences accepted.",
            std::env::consts::OS, std::env::consts::ARCH, preview_size(&preview).unwrap());
    }
    #[test]
    fn preview_never_accepts_licences_or_forces_installation() {
        for action in [Action::InstallEditor, Action::AddModules] {
            let args = arguments(&action, &["android".into()], true);
            assert!(args.iter().any(|a| a == "--dry-run"));
            for denied in [
                "--accept-eula",
                "--yes",
                "--force",
                "--skip-signature-check",
                "latest",
            ] {
                assert!(!args.iter().any(|a| a == denied));
            }
            assert!(args.iter().any(|a| a == EDITOR_VERSION));
            assert_eq!(
                args.iter().any(|a| a == "--reinstall"),
                action == Action::AddModules
            );
        }
    }
    #[test]
    fn rejects_missing_or_unreasonable_size_and_paths() {
        for value in [
            json!({}),
            json!({"totalDownloadSize": -1}),
            json!({"totalDownloadSize": 0}),
            json!({"totalDownloadSize": 100 * GIB}),
        ] {
            assert!(preview_size(&value).is_err());
        }
        assert_eq!(preview_size(&json!({"totalDownloadSize": 42})).unwrap(), 42);
        assert!(absolute_path(&json!({"path": "relative"}), "path").is_err());
        assert!(reserve(u64::MAX).is_err());
    }
    #[test]
    fn installer_percentage_is_never_presented_as_download_progress() {
        let event =
            frame_progress(&json!({"type":"progress","phase":"install","pct":50,"name":"Android"}))
                .unwrap();
        assert_eq!(event.percent, None);
        assert_eq!(
            frame_progress(&json!({"type":"progress","phase":"download","pct":24}))
                .unwrap()
                .percent,
            Some(24.0)
        );
        assert_eq!(
            frame_progress(&json!({"type":"progress","phase":"download","pct":101}))
                .unwrap()
                .percent,
            None
        );
        assert!(frame_progress(&json!({"type":"result","success":true})).is_none());
    }
    #[test]
    fn logs_and_capture_are_bounded_and_failed_frames_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = b"{\"type\":\"result\",\"success\":false}\n";
        let result = capture(
            bytes.as_slice(),
            File::create(temp.path().join("log")).unwrap(),
            None,
            true,
        )
        .unwrap();
        assert!(result.failed_result);
        let result = capture(
            vec![b'x'; MAX_OUTPUT + 2].as_slice(),
            File::create(temp.path().join("large")).unwrap(),
            None,
            true,
        )
        .unwrap();
        assert!(result.overflow);
        assert!(result.bytes.len() <= MAX_OUTPUT);
    }

    #[test]
    fn sensitive_query_output_is_never_written_to_local_reports() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("licence.log");
        let content = b"{\"active\":true,\"organization\":\"private-org\"}\n";
        let result = capture(
            content.as_slice(),
            File::create(&path).unwrap(),
            None,
            false,
        )
        .unwrap();
        assert!(!result.bytes.is_empty());
        assert!(fs::read(path).unwrap().is_empty());
        assert!(active_licence(&json!({"active": true})).unwrap());
        assert!(!active_licence(&json!({"active": false})).unwrap());
        assert!(active_licence(&json!({"active": "true"})).is_err());
    }

    #[test]
    fn unregistered_matching_editors_block_duplicate_installation() {
        let e = editor();
        assert!(check_local_inventory(std::slice::from_ref(&e), None).is_err());
        assert!(check_local_inventory(std::slice::from_ref(&e), Some(&e)).is_ok());
        let mut other = e.clone();
        other.executable = "another-editor".into();
        assert!(check_local_inventory(&[other], Some(&e)).is_err());
        assert!(check_local_inventory(&[], None).is_ok());
    }

    #[test]
    fn changed_install_paths_or_occupied_targets_reject_approved_plan() {
        let temp = tempfile::tempdir().unwrap();
        let plan = Plan {
            action: Action::InstallEditor,
            install_hub: false,
            editor_root: temp.path().join(EDITOR_VERSION),
            cache_root: temp.path().join("cache"),
            modules: module_selection(None).unwrap().1,
            download_bytes: 1,
            reserve_bytes: 1,
            log_directory: temp.path().into(),
        };
        let paths = json!({"editorInstallPath": temp.path(), "downloadCachePath": plan.cache_root});
        assert!(check_plan_current(&plan, &paths, &json!([])).is_ok());
        let mut changed = paths.clone();
        changed["downloadCachePath"] = json!(temp.path().join("changed"));
        assert!(check_plan_current(&plan, &changed, &json!([])).is_err());
        fs::create_dir(&plan.editor_root).unwrap();
        assert!(check_plan_current(&plan, &paths, &json!([])).is_err());
    }

    #[test]
    fn free_space_returns_valid_measurement_for_existing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = free_space(temp.path()).unwrap();
        assert!(bytes > 0);
    }

    #[test]
    fn require_editor_closed_allows_when_no_matching_editor_runs() {
        let temp = tempfile::tempdir().unwrap();
        let dummy = temp.path().join("Unity");
        fs::write(&dummy, b"fixture").unwrap();
        assert!(require_editor_closed(&dummy).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn missing_editor_cannot_authorize_module_installation() {
        assert!(require_editor_closed(Path::new("/nonexistent/Unity")).is_err());
    }
}
