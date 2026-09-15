use std::path::Path;

pub fn is_private_runtime(root: &Path, executable: &Path) -> bool {
    ["node.exe", "node"].iter().any(|name| {
        let target = root.join("server/runtime").join(name);
        crate::platform::same_path(&target, executable)
            || target
                .components()
                .map(|p| p.as_os_str().to_string_lossy().to_ascii_lowercase())
                .eq(executable
                    .components()
                    .map(|p| p.as_os_str().to_string_lossy().to_ascii_lowercase()))
    })
}

pub fn disconnect(root: &Path, approve: impl FnOnce(usize) -> bool) -> Result<usize, String> {
    #[cfg(windows)]
    {
        use crate::platform;
        use std::{
            path::PathBuf,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{Foundation::*, System::Threading::*};

        struct Handle(HANDLE);
        impl Drop for Handle {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        platform::reject_links(root)?;
        // Cleanup needs positive ownership proof only; unknown processes remain
        // untouched and the separate installer preflight still checks blockers.
        let snapshot = || {
            use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
            let mut system = System::new();
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
            );
            if system.processes().is_empty() {
                return Err("Running processes could not be inspected.");
            }
            Ok(system
                .processes()
                .iter()
                .filter_map(|(pid, process)| {
                    if !["node.exe", "node"]
                        .iter()
                        .any(|name| process.name().to_string_lossy().eq_ignore_ascii_case(name))
                    {
                        return None;
                    }
                    let exe = process.exe()?;
                    is_private_runtime(root, exe).then(|| (pid.as_u32(), exe.to_path_buf()))
                })
                .collect::<Vec<_>>())
        };
        let mut handles = Vec::new();
        for (pid, executable) in snapshot()? {
            platform::reject_links(&executable)?;
            // Hold the checked OS handle across the confirmation. A reused PID
            // or newly respawned runtime can never become an approved target.
            unsafe {
                let handle = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                );
                if handle.is_null() {
                    if GetLastError() == ERROR_INVALID_PARAMETER {
                        continue;
                    }
                    return Err("Windows could not access an MCP runtime. No additional connections were closed.".into());
                }
                let handle = Handle(handle);
                if WaitForSingleObject(handle.0, 0) == WAIT_OBJECT_0 {
                    continue;
                }
                let mut buffer = [0u16; 32768];
                let mut length = buffer.len() as u32;
                if QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut length) == 0
                    || !platform::same_path(
                        &PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])),
                        &executable,
                    )
                {
                    return Err("An MCP process changed during the check. Retry; no connections were closed.".into());
                }
                handles.push(handle);
            }
        }
        if handles.is_empty() {
            return Ok(0);
        }
        if !approve(handles.len()) {
            return Err("MCP disconnect cancelled. No connections were closed.".into());
        }
        let mut stopped = 0;
        for handle in &handles {
            unsafe {
                if WaitForSingleObject(handle.0, 0) == WAIT_OBJECT_0 {
                    continue;
                }
                if TerminateProcess(handle.0, 0) == 0
                    && WaitForSingleObject(handle.0, 0) != WAIT_OBJECT_0
                {
                    return Err("Windows could not stop an approved MCP runtime. Installation has not started.".into());
                }
                stopped += 1;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        for handle in &handles {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u32;
            if unsafe { WaitForSingleObject(handle.0, remaining) } != WAIT_OBJECT_0 {
                return Err("An MCP runtime is still exiting. Wait, then check again.".into());
            }
        }
        if !snapshot()?.is_empty() {
            return Err("Your AI client opened another MCP connection. Pause or disable this MCP in that client, then disconnect again. Hub did not close the new connection or start installation.".into());
        }
        Ok(stopped)
    }
    #[cfg(not(windows))]
    {
        let _ = (root, approve);
        Err("MCP runtime cleanup is available on Windows only.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_private_runtime_paths_are_eligible() {
        let root = Path::new("fixture/mcp");
        assert!(is_private_runtime(
            root,
            &root.join("server/runtime/node.exe")
        ));
        for relative in [
            "node.exe",
            "server/other/node.exe",
            "server/runtime/node-other.exe",
            "server/runtime-other/node.exe",
        ] {
            assert!(!is_private_runtime(root, &root.join(relative)));
        }
        assert!(!is_private_runtime(
            root,
            Path::new("fixture/mcp-other/server/runtime/node.exe")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn native_disconnect_is_confirmed_and_preserves_unrelated_processes_and_files() {
        use std::{
            fs,
            io::{Read, Write},
            process::{Child, Stdio},
        };
        struct Fixture(Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(input) = &mut self.0.stdin {
                    let _ = input.write_all(b"done\n");
                }
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Creator Works MCP");
        let node = crate::platform::command(Path::new("node"))
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap();
        let arguments = [
            "-e",
            "process.stdout.write('Waiting');process.stdin.resume()",
        ];
        let start = |base: &Path| {
            let exe = base.join("server/runtime/node.exe");
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::copy(node.trim(), &exe).unwrap();
            let mut child = Fixture(
                crate::platform::command(&exe)
                    .args(arguments)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let mut ready = [0; 7];
            child
                .0
                .stdout
                .as_mut()
                .unwrap()
                .read_exact(&mut ready)
                .unwrap();
            assert_eq!(&ready, b"Waiting");
            child
        };
        let mut first = start(&root);
        // All old private runtimes must be handled, not just the first match.
        let exe = root.join("server/runtime/node.exe");
        let mut second = Fixture(
            crate::platform::command(&exe)
                .args(arguments)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut ready = [0; 7];
        second
            .0
            .stdout
            .as_mut()
            .unwrap()
            .read_exact(&mut ready)
            .unwrap();
        assert_eq!(&ready, b"Waiting");
        let mut unrelated = start(&temp.path().join("Other Node App"));
        let before = fs::read(&exe).unwrap();
        let cancelled = disconnect(&root, |n| {
            assert_eq!(n, 2);
            false
        })
        .unwrap_err();
        assert!(cancelled.contains("cancelled"), "{cancelled}");
        assert!(first.0.try_wait().unwrap().is_none());
        assert!(second.0.try_wait().unwrap().is_none());
        assert!(unrelated.0.try_wait().unwrap().is_none());
        assert_eq!(
            disconnect(&root, |n| {
                assert_eq!(n, 2);
                true
            })
            .unwrap(),
            2
        );
        assert!(first.0.try_wait().unwrap().is_some());
        assert!(second.0.try_wait().unwrap().is_some());
        assert!(unrelated.0.try_wait().unwrap().is_none());
        assert_eq!(fs::read(&exe).unwrap(), before);
        assert_eq!(
            disconnect(&root, |_| panic!("No prompt with no runtimes")).unwrap(),
            0
        );
        let mut old = start(&root);
        let mut reopened = None;
        let result = disconnect(&root, |count| {
            assert_eq!(count, 1);
            let mut child = Fixture(
                crate::platform::command(&exe)
                    .args(arguments)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let mut ready = [0; 7];
            child
                .0
                .stdout
                .as_mut()
                .unwrap()
                .read_exact(&mut ready)
                .unwrap();
            reopened = Some(child);
            true
        })
        .unwrap_err();
        assert!(result.contains("opened another MCP connection"), "{result}");
        assert!(old.0.try_wait().unwrap().is_some());
        assert!(reopened.as_mut().unwrap().0.try_wait().unwrap().is_none());
        assert!(unrelated.0.try_wait().unwrap().is_none());
    }
}
