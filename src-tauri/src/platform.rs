use crate::catalog::AppId;
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub fn supported() -> bool {
    cfg!(all(windows, target_arch = "x86_64"))
}

pub fn default_exe(app: AppId) -> Result<PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("Local app data is unavailable.")?
        .join(app.name())
        .join(app.exe()))
}

pub fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}

pub fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
            let mut link = meta.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                link |= meta.file_attributes() & 0x400 != 0;
            }
            if link {
                return Err("App paths must not contain symbolic links or junctions.".into());
            }
        }
    }
    Ok(())
}

pub fn registered(app: AppId) -> Result<Vec<PathBuf>, String> {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        let mut paths: Vec<PathBuf> = Vec::new();
        let names: &[&str] = if app == AppId::Mcp {
            &["Creator Works MCP", "BANTWORKS MCP"]
        } else {
            &["Creator Project Setup"]
        };
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                for name in names {
                    let key =
                        format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{name}");
                    let key = match RegKey::predef(hive)
                        .open_subkey_with_flags(&key, KEY_READ | view)
                    {
                        Ok(key) => key,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(_) => return Err(
                            "Could not inspect existing app registrations. Installation is paused."
                                .into(),
                        ),
                    };
                    let location: String = key
                        .get_value("InstallLocation")
                        .map_err(|_| "Existing registration has no readable install location.")?;
                    let path = PathBuf::from(location.trim_matches('"')).join(
                        if *name == "BANTWORKS MCP" {
                            "bantworks-mcp-launcher.exe"
                        } else {
                            app.exe()
                        },
                    );
                    if !path.is_absolute() {
                        return Err("An app registration has an invalid location.".into());
                    }
                    if !paths.iter().any(|p| same_path(p, &path)) {
                        paths.push(path);
                    }
                }
            }
        }
        Ok(paths)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

pub struct Running {
    pub gui: Vec<u32>,
    pub other_copy: bool,
    pub server: bool,
    pub blockers: Vec<UpdateBlocker>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBlocker {
    pub pid: u32,
    pub name: String,
    pub executable: Option<PathBuf>,
    pub parent: Option<ProcessOwner>,
    pub kind: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOwner {
    pub pid: u32,
    pub name: String,
    pub executable: Option<PathBuf>,
}

impl Running {
    pub fn background_block_message(&self) -> Option<String> {
        if !self.server && !self.other_copy {
            return None;
        }
        let names = self
            .blockers
            .iter()
            .take(5)
            .map(|b| {
                let owner = b
                    .parent
                    .as_ref()
                    .map(|p| format!(", started by {} (PID {})", p.name, p.pid))
                    .unwrap_or_default();
                format!("{} (PID {}){owner}", b.name, b.pid)
            })
            .collect::<Vec<_>>()
            .join("; ");
        let action = if self.server {
            "Finish your work, disconnect this MCP in your AI app, or close the listed app."
        } else {
            "Finish your work and close the other copy of this app."
        };
        Some(format!("Update paused: {names}. {action} Then choose Check again. If it remains after closing its app, save your work and restart Windows. Hub will not force-close your AI app. Uninstalling is not needed to close these connections."))
    }
}

fn process_blocker(
    system: &System,
    pid: sysinfo::Pid,
    process: &sysinfo::Process,
    kind: &'static str,
) -> UpdateBlocker {
    let parent = process
        .parent()
        .and_then(|id| system.process(id).map(|p| (id, p)))
        // Ignore parent IDs whose current process started after this child.
        .filter(|(_, p)| parent_predates_child(process.start_time(), p.start_time()))
        .map(|(id, p)| ProcessOwner {
            pid: id.as_u32(),
            name: p.name().to_string_lossy().chars().take(128).collect(),
            executable: p.exe().map(Path::to_path_buf),
        });
    UpdateBlocker {
        pid: pid.as_u32(),
        name: process.name().to_string_lossy().chars().take(128).collect(),
        executable: process.exe().map(Path::to_path_buf),
        parent,
        kind,
    }
}

fn parent_predates_child(child: u64, parent: u64) -> bool {
    child > 0 && parent > 0 && parent <= child
}

fn mcp_connection_kind(
    root: &Path,
    executable: Option<&Path>,
    command: &str,
) -> Result<Option<&'static str>, ()> {
    if executable.is_some_and(|path| path.starts_with(root)) {
        return Ok(Some("connection"));
    }
    if command.is_empty() {
        return Err(());
    }
    let command = command.to_ascii_lowercase();
    let root = root.to_string_lossy().to_ascii_lowercase();
    Ok((command.contains(&root)
        || command.contains("banter-mcp")
        || command.contains("creator-works-mcp"))
    .then_some("possibleConnection"))
}

#[cfg(any(windows, test))]
fn matches_installer_product(product: &str, display: &str, publisher: &str) -> bool {
    // Tauri's NSIS PageReinstall compares concatenated fields with StrCmp.
    format!("{display}{publisher}").eq_ignore_ascii_case(&format!("{product}Creator Works"))
}

#[cfg(any(windows, test))]
fn check_update_record(uninstall: &str, location: &str, folder: &Path) -> Result<(), String> {
    if uninstall.to_ascii_lowercase().contains("msiexec") {
        return Err("This app uses an older Windows installer. Automatic upgrade is paused to protect that installation.".into());
    }
    if !same_path(Path::new(location.trim_matches('"')), folder) {
        return Err(
            "Another installation uses this app's name. Choose or repair it before updating."
                .into(),
        );
    }
    Ok(())
}

// /UPDATE skips old NSIS removal, but a matching MSI record overrides it.
pub fn verify_nsis_update_target(product: &str, exe: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        fn optional_string(key: &RegKey, name: &str) -> Result<String, String> {
            match key.get_value(name) {
                Ok(value) => Ok(value),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
                Err(_) => Err("An installation record could not be read safely.".into()),
            }
        }
        let folder = exe.parent().ok_or("Invalid installed app path.")?;
        let product_key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!("Software\\Creator Works\\{product}"))
            .map_err(|_| "The app's installation record is missing. Repair it before updating.")?;
        let saved: String = product_key
            .get_value("")
            .map_err(|_| "The installed app folder could not be checked.")?;
        if !same_path(Path::new(&saved), folder) {
            return Err(
                "The saved installation folder differs. Repair the app before updating.".into(),
            );
        }
        let mut found = false;
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let root = match RegKey::predef(hive).open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                    KEY_READ | view,
                ) {
                    Ok(root) => root,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => {
                        return Err("Windows installation records could not be checked.".into())
                    }
                };
                for (index, name) in root.enum_keys().enumerate() {
                    if index >= 10000 {
                        return Err("Too many installation records to check safely.".into());
                    }
                    let name =
                        name.map_err(|_| "Windows installation records could not be read.")?;
                    let key = root
                        .open_subkey(&name)
                        .map_err(|_| "An installation record could not be read.")?;
                    let display = optional_string(&key, "DisplayName")?;
                    let publisher = optional_string(&key, "Publisher")?;
                    if !matches_installer_product(product, &display, &publisher) {
                        continue;
                    }
                    let uninstall: String = key
                        .get_value("UninstallString")
                        .map_err(|_| "The existing app's installer type could not be checked.")?;
                    let location: String = key.get_value("InstallLocation").map_err(|_| {
                        "The existing app's installation folder could not be checked."
                    })?;
                    check_update_record(&uninstall, &location, folder)?;
                    found = true;
                }
            }
        }
        if found {
            Ok(())
        } else {
            Err("The app's installation record is missing. Repair it before updating.".into())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (product, exe);
        Err("Windows installation records are required.".into())
    }
}

fn gui_name(app: AppId, name: &str) -> bool {
    name.eq_ignore_ascii_case(app.exe())
        || (app == AppId::Mcp
            && ["bantworks-mcp-launcher.exe", "banter-mcp-launcher.exe"]
                .iter()
                .any(|legacy| name.eq_ignore_ascii_case(legacy)))
}

#[cfg(test)]
mod legacy_name_tests {
    use super::*;
    #[test]
    fn unreadable_commands_stay_blocked_and_heuristic_matches_are_not_called_proven() {
        let root = Path::new("fixture/mcp");
        assert_eq!(
            mcp_connection_kind(root, Some(&root.join("server/runtime/node.exe")), ""),
            Ok(Some("connection"))
        );
        assert_eq!(
            mcp_connection_kind(root, Some(Path::new("other/node.exe")), ""),
            Err(())
        );
        assert_eq!(mcp_connection_kind(root, None, ""), Err(()));
        assert_eq!(
            mcp_connection_kind(
                root,
                Some(Path::new("other/node.exe")),
                "node creator-works-mcp.mjs"
            ),
            Ok(Some("possibleConnection"))
        );
        assert_eq!(
            mcp_connection_kind(
                root,
                Some(Path::new("other/node.exe")),
                "node unrelated-server.js"
            ),
            Ok(None)
        );
        assert!(parent_predates_child(100, 99));
        assert!(parent_predates_child(100, 100));
        assert!(!parent_predates_child(100, 101));
        assert!(!parent_predates_child(100, 0));
        assert!(!parent_predates_child(0, 99));
    }
    #[test]
    fn update_messages_identify_actual_clients_without_a_codex_assumption() {
        let mut state = Running {
            gui: vec![],
            server: true,
            other_copy: false,
            blockers: vec![],
        };
        for (pid, client) in [(40, "claude.exe"), (50, "opencode.exe")] {
            state.blockers.push(UpdateBlocker {
                pid,
                name: "node.exe".into(),
                kind: "connection",
                executable: Some(PathBuf::from("private/node.exe")),
                parent: Some(ProcessOwner {
                    pid: pid + 1,
                    name: client.into(),
                    executable: None,
                }),
            });
        }
        let text = state.background_block_message().unwrap();
        for expected in [
            "node.exe (PID 40)",
            "claude.exe (PID 41)",
            "opencode.exe (PID 51)",
            "Check again",
            "will not force-close",
        ] {
            assert!(text.contains(expected));
        }
        assert!(!text.to_lowercase().contains("codex"));
        let data = serde_json::to_value(&state.blockers).unwrap();
        assert_eq!(data[0]["parent"]["name"], "claude.exe");
        assert!(data[0].get("commandLine").is_none());
        assert!(data[0]["parent"].get("commandLine").is_none());
        state.blockers[0].parent = None;
        assert!(state
            .background_block_message()
            .unwrap()
            .contains("node.exe (PID 40)"));
    }

    #[test]
    fn gui_only_does_not_bypass_guarded_close_and_other_copies_do_not_get_mcp_instructions() {
        let mut state = Running {
            gui: vec![12],
            server: false,
            other_copy: false,
            blockers: vec![],
        };
        assert!(state.background_block_message().is_none());
        state.other_copy = true;
        state.blockers.push(UpdateBlocker {
            pid: 42,
            name: "creator-project-setup.exe".into(),
            executable: None,
            parent: None,
            kind: "otherCopy",
        });
        let message = state.background_block_message().unwrap();
        assert!(message.contains("close the other copy"));
        assert!(!message.contains("disconnect this MCP"));
        assert!(message.contains("PID 42"));
    }

    #[test]
    #[ignore = "Read-only process snapshot; never installs or stops processes"]
    fn live_update_blockers() {
        let state = running(AppId::Mcp, &default_exe(AppId::Mcp).unwrap()).unwrap();
        println!(
            "MCP launchers: {}; connections: {}; other copy: {}; identified parents: {}",
            state.gui.len(),
            state
                .blockers
                .iter()
                .filter(|b| b.kind == "connection")
                .count(),
            state.other_copy,
            state.blockers.iter().filter(|b| b.parent.is_some()).count()
        );
        assert_eq!(
            state.background_block_message().is_some(),
            state.server || state.other_copy
        );
        for blocker in &state.blockers {
            assert!(blocker.pid > 0);
        }
    }

    #[test]
    fn installer_matching_includes_case_and_concatenated_field_boundaries() {
        assert!(matches_installer_product(
            "Creator Works MCP",
            "Creator Works MCP",
            "Creator Works"
        ));
        assert!(matches_installer_product(
            "Creator Works MCP",
            "creator works mcp",
            "creator works"
        ));
        assert!(matches_installer_product(
            "Creator Works MCP",
            "Creator Works M",
            "CPCreator Works"
        ));
        assert!(!matches_installer_product(
            "Creator Works MCP",
            "BANTWORKS MCP",
            "Creator Works"
        ));
        assert!(!matches_installer_product(
            "Creator Works MCP",
            "Creator Works MCP",
            "Someone else"
        ));
    }
    #[test]
    fn update_records_reject_msi_and_different_or_missing_folders() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("selected");
        let other = root.path().join("other");
        std::fs::create_dir(&target).unwrap();
        std::fs::create_dir(&other).unwrap();
        let location = format!("\"{}\"", target.display());
        assert!(check_update_record("uninstall.exe", &location, &target).is_ok());
        assert!(check_update_record("MsIExec.exe /X {fixture}", &location, &target).is_err());
        assert!(check_update_record("uninstall.exe", &location, &other).is_err());
        assert!(check_update_record("uninstall.exe", "missing", &target).is_err());
    }
    #[test]
    #[ignore = "Explicit read-only check of this machine's registered MCP destination"]
    fn installed_mcp_destination_allows_legacy_side_by_side_without_migration() {
        assert_eq!(
            std::env::var("CREATOR_HUB_REAL_NSIS_CHECK").as_deref(),
            Ok("1")
        );
        let exe = default_exe(AppId::Mcp).unwrap();
        assert!(exe.is_file());
        verify_nsis_update_target(AppId::Mcp.name(), &exe).unwrap();
    }
    #[test]
    fn real_bantworks_binary_and_older_alias_are_detected_without_matching_other_apps() {
        for name in [
            "bantworks-mcp-launcher.exe",
            "BANTWORKS-MCP-LAUNCHER.EXE",
            "banter-mcp-launcher.exe",
            "creator-works-mcp-launcher.exe",
        ] {
            assert!(gui_name(AppId::Mcp, name));
            assert!(!gui_name(AppId::Setup, name));
        }
        for name in [
            "bantworks-mcp-launcher.exe.bak",
            "other.exe",
            "creator-project-setup.exe",
        ] {
            assert!(!gui_name(AppId::Mcp, name));
        }
    }
}

pub fn running(app: AppId, exe: &Path) -> Result<Running, String> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::Always)
            .with_cmd(UpdateKind::Always),
    );
    if system.processes().is_empty() {
        return Err("Running apps could not be inspected.".into());
    }
    let mut result = Running {
        gui: Vec::new(),
        other_copy: false,
        server: false,
        blockers: Vec::new(),
    };
    let root = exe.parent().ok_or("Invalid app path.")?;
    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        let portable_setup = app == AppId::Setup
            && name.starts_with("creator-project-setup-")
            && name.ends_with(".exe")
            && !name.ends_with("-setup.exe");
        let is_gui = gui_name(app, &name) || portable_setup;
        if is_gui {
            match process.exe() {
                Some(actual) if same_path(actual, exe) => result.gui.push(pid.as_u32()),
                Some(_) => {
                    result.other_copy = true;
                    result.blockers.push(process_blocker(&system, *pid, process, "otherCopy"));
                }
                None => {
                    return Err(format!("Cannot check {} (PID {}). Close that app and choose Check again. Hub will not force-close your apps.", process.name().to_string_lossy(), pid.as_u32()))
                }
            }
        }
        if app == AppId::Mcp && (name == "node.exe" || name == "node") {
            let command = process
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase();
            let kind = mcp_connection_kind(root, process.exe(), &command).map_err(|()| format!("Cannot check node (PID {}). Hub cannot tell whether it belongs to MCP, so the update is paused. Save your work and close the app using it, then choose Check again. If it remains, restart Windows. Do not end unfamiliar tasks.", pid.as_u32()))?;
            if let Some(kind) = kind {
                result.server = true;
                result
                    .blockers
                    .push(process_blocker(&system, *pid, process, kind));
            }
        }
    }
    result.blockers.sort_by_key(|b| b.pid);
    Ok(result)
}

pub fn window_action(pids: &[u32], executable: &Path, close: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::*;
        use windows_sys::Win32::{Foundation::*, UI::WindowsAndMessaging::*};
        struct Context<'a> {
            pids: &'a [u32],
            executable: &'a Path,
            close: bool,
            found: bool,
        }
        unsafe extern "system" fn visit(hwnd: HWND, context: LPARAM) -> i32 {
            let context = &mut *(context as *mut Context<'_>);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if context.pids.contains(&pid)
                && IsWindowVisible(hwnd) != 0
                && GetWindow(hwnd, GW_OWNER).is_null()
            {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return 1;
                }
                let mut buffer = [0u16; 32768];
                let mut length = buffer.len() as u32;
                let matched =
                    QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) != 0
                        && same_path(
                            &PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])),
                            context.executable,
                        );
                if !matched {
                    CloseHandle(handle);
                    return 1;
                }
                if context.close
                    && (GetPropW(hwnd, windows_sys::w!("CreatorSuite.LifecycleProtocol")) as usize
                        != 1
                        || !GetPropW(hwnd, windows_sys::w!("CreatorSuite.LauncherBusy")).is_null()
                        || !GetPropW(hwnd, windows_sys::w!("CreatorSuite.Closing")).is_null())
                {
                    CloseHandle(handle);
                    return 1;
                }
                context.found = true;
                if context.close {
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                } else {
                    ShowWindowAsync(hwnd, SW_RESTORE);
                    SetForegroundWindow(hwnd);
                }
                CloseHandle(handle);
            }
            1
        }
        let mut context = Context {
            pids,
            executable,
            close,
            found: false,
        };
        unsafe {
            EnumWindows(Some(visit), &mut context as *mut _ as LPARAM);
        }
        if context.found {
            Ok(())
        } else {
            Err("The app is starting or has no available window. Try again shortly.".into())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pids, executable, close);
        Err("Native app lifecycle is not supported on this platform yet.".into())
    }
}
