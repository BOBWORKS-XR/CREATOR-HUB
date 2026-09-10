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
    };
    let root = exe.parent().ok_or("Invalid app path.")?;
    let root_text = root.to_string_lossy().to_ascii_lowercase();
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
                Some(_) => result.other_copy = true,
                None => {
                    return Err(
                        "An app process cannot be inspected. Close it before continuing.".into(),
                    )
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
            if command.is_empty() {
                return Err(
                    "A Node process cannot be inspected. MCP update safety is unverified.".into(),
                );
            }
            let bundled = process.exe().is_some_and(|p| p.starts_with(root));
            result.server |= bundled
                || command.contains(&root_text)
                || command.contains("banter-mcp")
                || command.contains("creator-works-mcp");
        }
    }
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
