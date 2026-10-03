use std::path::Path;

pub fn restart(executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    return windows::restart(executable);
    #[cfg(not(windows))]
    {
        let _ = executable;
        Err("Fully quit Unity Hub, then choose Open Unity Hub. Automatic restart is not supported on this platform.".into())
    }
}

#[cfg(windows)]
mod windows {
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::ptr::null;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::RestartManager::*;
    use windows_sys::Win32::System::Threading::*;

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Session(u32);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                RmEndSession(self.0);
            }
        }
    }
    struct Process {
        identity: RM_UNIQUE_PROCESS,
        parent: u32,
        handle: Handle,
    }

    fn error(action: &str) -> String {
        format!(
            "{action}: {}. Nothing will be force-closed.",
            std::io::Error::last_os_error()
        )
    }

    fn matches_executable(actual: &Path, expected: &Path) -> bool {
        fs::canonicalize(actual).is_ok_and(|path| path == expected)
    }

    fn processes(executable: &Path) -> Result<Vec<Process>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(error("Cannot inspect running applications"));
        }
        let snapshot = Handle(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut entries = Vec::new();
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        while more != 0 {
            let end = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end])
                .eq_ignore_ascii_case("Unity Hub.exe")
            {
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        entry.th32ProcessID,
                    )
                };
                if handle.is_null() {
                    if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                        more = unsafe { Process32NextW(snapshot.0, &mut entry) };
                        continue;
                    }
                    return Err(error("Cannot inspect Unity Hub"));
                }
                let handle = Handle(handle);
                let mut path = vec![0u16; 32768];
                let mut length = path.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(handle.0, 0, path.as_mut_ptr(), &mut length)
                } == 0
                {
                    return Err(error("Cannot verify Unity Hub's executable"));
                }
                let path = PathBuf::from(String::from_utf16_lossy(&path[..length as usize]));
                if matches_executable(&path, executable) {
                    let mut start = FILETIME::default();
                    let mut exit = FILETIME::default();
                    let mut kernel = FILETIME::default();
                    let mut user = FILETIME::default();
                    if unsafe {
                        GetProcessTimes(handle.0, &mut start, &mut exit, &mut kernel, &mut user)
                    } == 0
                    {
                        return Err(error("Cannot verify Unity Hub's process identity"));
                    }
                    entries.push(Process {
                        identity: RM_UNIQUE_PROCESS {
                            dwProcessId: entry.th32ProcessID,
                            ProcessStartTime: start,
                        },
                        parent: entry.th32ParentProcessID,
                        handle,
                    });
                }
            }
            more = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return Err(error("Cannot finish inspecting running applications"));
        }
        Ok(entries)
    }

    fn same_process(a: &RM_UNIQUE_PROCESS, b: &RM_UNIQUE_PROCESS) -> bool {
        a.dwProcessId == b.dwProcessId
            && a.ProcessStartTime.dwLowDateTime == b.ProcessStartTime.dwLowDateTime
            && a.ProcessStartTime.dwHighDateTime == b.ProcessStartTime.dwHighDateTime
    }

    fn scope_matches(affected: &[RM_PROCESS_INFO], target: &RM_UNIQUE_PROCESS) -> bool {
        affected
            .iter()
            .all(|p| same_process(&p.Process, target) && p.strServiceShortName[0] == 0)
    }

    fn verify_scope(session: &Session, target: &RM_UNIQUE_PROCESS) -> Result<(), String> {
        let mut needed = 0;
        let mut count = 16;
        let mut reasons = 0;
        let mut affected = [RM_PROCESS_INFO::default(); 16];
        let result = unsafe {
            RmGetList(
                session.0,
                &mut needed,
                &mut count,
                affected.as_mut_ptr(),
                &mut reasons,
            )
        };
        if result != ERROR_SUCCESS
            || reasons != 0
            || count as usize > affected.len()
            || !scope_matches(&affected[..count.min(16) as usize], target)
        {
            return Err("Windows could not limit this restart to Unity Hub alone. Please quit Hub manually; no shutdown was requested.".into());
        }
        Ok(())
    }

    pub fn restart(executable: &Path) -> Result<(), String> {
        let executable =
            fs::canonicalize(executable).map_err(|_| "Unity Hub's executable is unavailable.")?;
        if !executable
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("Unity Hub.exe"))
        {
            return Err("Refusing to restart an executable other than Unity Hub.".into());
        }
        let before = processes(&executable)?;
        let ids: HashSet<_> = before.iter().map(|p| p.identity.dwProcessId).collect();
        let roots: Vec<_> = before.iter().filter(|p| !ids.contains(&p.parent)).collect();
        if roots.len() > 1 || (!before.is_empty() && roots.is_empty()) {
            return Err("More than one Unity Hub instance may be running. Quit Hub manually, then reopen it.".into());
        }
        if let Some(root) = roots.first() {
            let mut session = 0;
            let mut key = [0; CCH_RM_SESSION_KEY as usize + 1];
            let started = unsafe { RmStartSession(&mut session, 0, key.as_mut_ptr()) };
            if started != ERROR_SUCCESS {
                return Err(format!(
                    "Windows could not prepare a Hub restart ({started})."
                ));
            }
            let session = Session(session);
            // Register one PID plus its creation time, never files, services or a process tree.
            let registered =
                unsafe { RmRegisterResources(session.0, 0, null(), 1, &root.identity, 0, null()) };
            if registered != ERROR_SUCCESS {
                return Err(format!(
                    "Windows could not select Unity Hub ({registered})."
                ));
            }
            verify_scope(&session, &root.identity)?;
            // Zero flags: unresponsive applications must never be force-terminated.
            let stopped = unsafe { RmShutdown(session.0, 0, None) };
            let exited = unsafe { WaitForSingleObject(root.handle.0, 5000) } == WAIT_OBJECT_0;
            // Restart Manager requires this even after a partial shutdown. Hub may
            // not register for restart, so explicitly launch below if it stays closed.
            unsafe {
                RmRestart(session.0, 0, None);
            }
            if !exited {
                return Err(format!("Unity Hub did not fully exit ({stopped}). Nothing was force-closed. Quit Hub from its system tray menu, then choose Open Unity Hub."));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while processes(&executable)?.iter().any(|p| {
            before
                .iter()
                .any(|old| same_process(&p.identity, &old.identity))
        }) {
            if Instant::now() >= deadline {
                return Err(
                    "Unity Hub is still closing. Nothing was force-closed. Wait, then retry."
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if processes(&executable)?.is_empty() {
            std::process::Command::new(&executable)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| {
                    format!("Hub closed but could not reopen: {e}. Use Open Unity Hub to retry.")
                })?;
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if !processes(&executable)?.is_empty() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Hub restart was requested, but a new process was not detected. Use Open Unity Hub to retry.".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn process_identity_includes_creation_time() {
            let first = RM_UNIQUE_PROCESS {
                dwProcessId: 123,
                ..Default::default()
            };
            let mut reused = first;
            reused.ProcessStartTime.dwLowDateTime = 1;
            assert!(!same_process(&first, &reused));
            assert!(same_process(&first, &first));
        }
        #[test]
        fn shutdown_scope_rejects_other_processes_services_and_reused_ids() {
            let hub = RM_UNIQUE_PROCESS {
                dwProcessId: 123,
                ..Default::default()
            };
            let allowed = RM_PROCESS_INFO {
                Process: hub,
                ..Default::default()
            };
            assert!(scope_matches(&[allowed], &hub));
            let mut editor = allowed;
            editor.Process.dwProcessId = 456;
            assert!(!scope_matches(&[allowed, editor], &hub));
            let mut service = allowed;
            service.strServiceShortName[0] = 65;
            assert!(!scope_matches(&[service], &hub));
            let mut reused = allowed;
            reused.Process.ProcessStartTime.dwHighDateTime = 1;
            assert!(!scope_matches(&[reused], &hub));
        }
        #[test]
        fn executable_match_requires_exact_path() {
            let dir = tempfile::tempdir().unwrap();
            let hub = dir.path().join("Unity Hub.exe");
            let editor = dir.path().join("Unity.exe");
            fs::write(&hub, b"test").unwrap();
            fs::write(&editor, b"test").unwrap();
            let expected = fs::canonicalize(&hub).unwrap();
            assert!(matches_executable(&hub, &expected));
            assert!(!matches_executable(&editor, &expected));
            assert!(!matches_executable(&dir.path().join("missing"), &expected));
        }
        #[test]
        #[ignore = "requires explicit permission to restart the user's running Unity Hub"]
        fn restart_live_hub() {
            assert_eq!(
                std::env::var("CREATOR_SETUP_ALLOW_HUB_RESTART").as_deref(),
                Ok("1")
            );
            let path = crate::logic::probe_environment().hub_path.unwrap();
            restart(Path::new(&path)).unwrap();
        }
    }
}
