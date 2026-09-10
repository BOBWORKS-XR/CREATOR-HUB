use std::ffi::OsString;

pub fn mode(arguments: impl IntoIterator<Item = OsString>) -> Option<bool> {
    let arguments: Vec<_> = arguments.into_iter().take(3).collect();
    match arguments.as_slice() {
        [flag] if flag == "--installer-preflight" => Some(false),
        [flag] if flag == "--installer-preflight-wait" => Some(true),
        _ => None,
    }
}

#[cfg(any(windows, test))]
trait Processes {
    fn next(&mut self) -> Result<Option<(u32, String)>, ()>;
}

#[cfg(any(windows, test))]
fn scan<P: Processes>(open: impl FnOnce() -> Result<P, ()>, own_pid: u32) -> Result<bool, ()> {
    let mut processes = open()?;
    for _ in 0..100_000 {
        let Some((pid, name)) = processes.next()? else {
            return Ok(false);
        };
        if pid != own_pid && name.eq_ignore_ascii_case("creator-hub.exe") {
            return Ok(true);
        }
    }
    Err(())
}

#[cfg(windows)]
mod native {
    use super::Processes;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
        },
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    pub struct Snapshot {
        handle: HANDLE,
        first: bool,
    }

    impl Snapshot {
        pub fn open() -> Result<Self, ()> {
            let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                return Err(());
            }
            Ok(Self {
                handle,
                first: true,
            })
        }
    }

    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    impl Processes for Snapshot {
        fn next(&mut self) -> Result<Option<(u32, String)>, ()> {
            // All fields are integer types; Windows requires this exact initialized size.
            let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let success = unsafe {
                if self.first {
                    self.first = false;
                    Process32FirstW(self.handle, &mut entry)
                } else {
                    Process32NextW(self.handle, &mut entry)
                }
            };
            if success == 0 {
                let error = unsafe { GetLastError() };
                return if error == ERROR_NO_MORE_FILES {
                    Ok(None)
                } else {
                    Err(())
                };
            }
            let end = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            Ok(Some((
                entry.th32ProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..end]),
            )))
        }
    }
}

pub fn run(wait: bool) -> i32 {
    #[cfg(windows)]
    {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            match scan(native::Snapshot::open, std::process::id()) {
                Ok(false) => return 0,
                Err(()) => return 11,
                Ok(true) if !wait || std::time::Instant::now() >= deadline => return 10,
                Ok(true) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = wait;
        11
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Fixture(VecDeque<Result<Option<(u32, String)>, ()>>);
    impl Processes for Fixture {
        fn next(&mut self) -> Result<Option<(u32, String)>, ()> {
            self.0.pop_front().expect("Unexpected extra enumeration")
        }
    }
    fn row(pid: u32, name: &str) -> Result<Option<(u32, String)>, ()> {
        Ok(Some((pid, name.into())))
    }

    #[test]
    fn accepts_only_exact_read_only_probe_arguments() {
        assert_eq!(mode(["--installer-preflight".into()]), Some(false));
        assert_eq!(mode(["--installer-preflight-wait".into()]), Some(true));
        for args in [
            vec![],
            vec!["--INSTALLER-PREFLIGHT"],
            vec!["--installer-preflight", "--install"],
            vec!["--installer-preflight=1"],
        ] {
            assert_eq!(mode(args.into_iter().map(OsString::from)), None);
        }
    }

    #[test]
    fn snapshot_first_and_next_errors_cannot_authorize_installation() {
        assert_eq!(scan(|| Err::<Fixture, _>(()), 99), Err(()));
        assert_eq!(scan(|| Ok(Fixture([Err(())].into())), 99), Err(()));
        assert_eq!(
            scan(|| Ok(Fixture([row(1, "other.exe"), Err(())].into())), 99),
            Err(())
        );
    }

    #[test]
    fn checks_first_entry_and_all_users_without_terminating_anything() {
        assert_eq!(
            scan(|| Ok(Fixture([row(1, "CREATOR-HUB.EXE")].into())), 99),
            Ok(true)
        );
        assert_eq!(
            scan(
                || Ok(Fixture(
                    [row(1, "other.exe"), row(2, "creator-hub.exe")].into()
                )),
                99
            ),
            Ok(true)
        );
    }

    #[test]
    fn absence_requires_enumeration_end_and_probe_does_not_match_itself() {
        assert_eq!(scan(|| Ok(Fixture([Ok(None)].into())), 99), Ok(false));
        assert_eq!(
            scan(
                || Ok(Fixture(
                    [
                        row(99, "creator-hub.exe"),
                        row(1, "creator-hub-preflight.exe"),
                        Ok(None)
                    ]
                    .into()
                )),
                99
            ),
            Ok(false)
        );
    }
}
