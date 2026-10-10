//! Direct-parent verification shared by the built-in modules and native Mac tests.
//! Apple API contract: xnu/libsyscall/wrappers/libproc/libproc.c, proc_pidpath.
use std::{
    os::unix::ffi::OsStringExt,
    path::{Path, PathBuf},
};

fn executable(pid: libc::pid_t) -> Result<PathBuf, String> {
    if pid <= 1 {
        return Err("Cannot verify the parent process.".into());
    }
    let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let count = unsafe { libc::proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if count <= 0 || count as usize >= bytes.len() || bytes[count as usize] != 0 {
        return Err("Cannot inspect Creator Hub's executable.".into());
    }
    bytes.truncate(count as usize);
    let path = PathBuf::from(std::ffi::OsString::from_vec(bytes));
    if !path.is_absolute() {
        return Err("Invalid parent executable path.".into());
    }
    Ok(path)
}

fn is_hub(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "creator-hub")
}

fn private_streams(input: libc::c_int, output: libc::c_int) -> Result<(), String> {
    for fd in [input, output] {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return Err("Cannot inspect hosted streams.".into());
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
            return Err("Hosted mode requires private inherited input and output pipes.".into());
        }
    }
    for fd in [input, output] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err("Cannot prevent hosted pipe inheritance into child processes.".into());
        }
    }
    Ok(())
}

pub fn verify() -> Result<String, String> {
    private_streams(libc::STDIN_FILENO, libc::STDOUT_FILENO)?;
    let parent = unsafe { libc::getppid() };
    let path = executable(parent)?;
    if unsafe { libc::getppid() } != parent || !is_hub(&path) {
        return Err("Hosted mode must be launched directly by Creator Hub.".into());
    }
    path.into_os_string()
        .into_string()
        .map_err(|_| "Invalid host path.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    #[test]
    fn native_process_path_matches_current_image_and_invalid_pids_fail_closed() {
        let current = executable(std::process::id() as libc::pid_t).unwrap();
        assert_eq!(
            current.canonicalize().unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
        for pid in [-1, 0, 1, libc::pid_t::MAX] {
            assert!(executable(pid).is_err());
        }
    }

    #[test]
    fn only_the_actual_hub_binary_name_is_accepted() {
        assert!(is_hub(Path::new(
            "/Applications/Creator Hub.app/Contents/MacOS/creator-hub"
        )));
        for name in ["sh", "creator-hub-helper", "creator-hub.exe", "Creator Hub"] {
            assert!(!is_hub(Path::new(name)));
        }
    }

    #[test]
    fn private_pipes_are_cloexec_and_files_or_sockets_are_rejected() {
        let mut raw = [0; 2];
        assert_eq!(unsafe { libc::pipe(raw.as_mut_ptr()) }, 0);
        let input = unsafe { OwnedFd::from_raw_fd(raw[0]) };
        let output = unsafe { OwnedFd::from_raw_fd(raw[1]) };
        private_streams(input.as_raw_fd(), output.as_raw_fd()).unwrap();
        for fd in [input.as_raw_fd(), output.as_raw_fd()] {
            assert_ne!(
                unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
        }
        let file = tempfile::tempfile().unwrap();
        assert!(private_streams(file.as_raw_fd(), output.as_raw_fd()).is_err());
        let (socket, _) = std::os::unix::net::UnixStream::pair().unwrap();
        assert!(private_streams(input.as_raw_fd(), socket.as_raw_fd()).is_err());
        assert!(private_streams(-1, output.as_raw_fd()).is_err());
    }

    #[test]
    #[ignore = "subprocess fixture invoked by native_parent_identity"]
    fn child_fixture() {
        std::process::exit(if verify().is_ok() { 0 } else { 10 });
    }

    #[test]
    #[ignore = "subprocess fixture invoked by native_parent_identity"]
    fn host_fixture() {
        use std::process::{Command, Stdio};
        let Some(child) = std::env::var_os("CREATOR_MAC_PARENT_TEST_CHILD") else {
            return;
        };
        let status = Command::new(child)
            .args([
                "--exact",
                "host_parent_macos::tests::child_fixture",
                "--ignored",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .unwrap();
        std::process::exit(status.code().unwrap_or(11));
    }

    #[test]
    fn native_parent_identity_accepts_hub_and_rejects_other_processes() {
        let directory = tempfile::tempdir().unwrap();
        let current = std::env::current_exe().unwrap();
        for (name, expected) in [("creator-hub", 0), ("other-host", 10)] {
            let host = directory.path().join(name);
            std::fs::copy(&current, &host).unwrap();
            let status = std::process::Command::new(host)
                .args([
                    "--exact",
                    "host_parent_macos::tests::host_fixture",
                    "--ignored",
                ])
                .env("CREATOR_MAC_PARENT_TEST_CHILD", &current)
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(expected), "{name}");
        }
    }
}
