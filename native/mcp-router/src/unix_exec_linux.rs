use super::{high_fd, wait, Pipe};
use std::{
    fs::File,
    io::Write,
    os::fd::{AsRawFd, FromRawFd},
    path::Path,
};

pub(super) struct Executable(File);

pub(super) fn ensure_single_thread() -> Result<(), String> {
    if std::fs::read_dir("/proc/self/task")
        .map_err(|_| "Cannot inspect router thread ownership.")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot enumerate router thread ownership.")?
        .len()
        != 1
    {
        return Err("Unix MCP execution requires a single-threaded headless router.".into());
    }
    Ok(())
}

impl Executable {
    pub(super) fn prepare(_path: &Path, bytes: &[u8]) -> Result<Self, String> {
        if bytes.get(..5) != Some(b"\x7fELF\x02") {
            return Err("Verified MCP Node is not a native 64-bit ELF executable.".into());
        }
        let flags = libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING;
        let mut fd =
            unsafe { libc::memfd_create(c"creator-hub-node".as_ptr(), flags | libc::MFD_EXEC) };
        // Old kernels do not recognize MFD_EXEC. Never fall back after a
        // policy refusal; vm.memfd_noexec=2 must remain a fail-closed result.
        if fd < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
            fd = unsafe { libc::memfd_create(c"creator-hub-node".as_ptr(), flags) };
        }
        if fd < 0 {
            return Err("This Linux kernel/policy does not allow sealed MCP execution.".into());
        }
        let initial = unsafe { File::from_raw_fd(fd) };
        let mut file = high_fd(initial.as_raw_fd())?;
        file.write_all(bytes)
            .map_err(|_| "Cannot snapshot verified MCP executable.")?;
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o500) } != 0 {
            return Err("Cannot make sealed MCP executable usable.".into());
        }
        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0
            || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) } & seals != seals
        {
            return Err("Linux could not enforce complete MCP executable sealing.".into());
        }
        Ok(Self(file))
    }

    pub(super) fn spawn(
        &self,
        argv: &[*mut libc::c_char],
        envp: &[*mut libc::c_char],
        source: i32,
    ) -> Result<libc::pid_t, String> {
        let error = Pipe::new()?;
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err("Cannot fork verified MCP executable.".into());
        }
        if pid == 0 {
            unsafe {
                libc::close(error.read.as_raw_fd());
                if libc::setpgid(0, 0) == 0
                    && libc::dup2(source, 3) == 3
                    && libc::dup2(self.0.as_raw_fd(), 4) == 4
                {
                    libc::execveat(
                        4,
                        c"".as_ptr(),
                        argv.as_ptr().cast(),
                        envp.as_ptr().cast(),
                        libc::AT_EMPTY_PATH,
                    );
                }
                let code: i32 = std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or(libc::EIO);
                libc::write(error.write.as_raw_fd(), (&code as *const i32).cast(), 4);
                libc::_exit(127);
            }
        }
        drop(error.write);
        let mut code = 0i32;
        let count =
            unsafe { libc::read(error.read.as_raw_fd(), (&mut code as *mut i32).cast(), 4) };
        if count != 0 {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
            }
            let _ = wait(pid);
            return Err("Linux refused fd-bound MCP execution.".into());
        }
        Ok(pid)
    }
}

pub(super) fn prepare_supervisor() -> Result<(), String> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err("Linux cannot retain owned MCP orphan cleanup.".into());
    }
    Ok(())
}

pub(super) fn cleanup_adopted() -> Result<(), String> {
    // Only direct children of this dedicated subreaper. Killing/reaping each
    // parent adopts its children, including helpers that called setsid().
    let children = format!("/proc/self/task/{}/children", unsafe { libc::getpid() });
    loop {
        let text = std::fs::read_to_string(&children)
            .map_err(|_| "Cannot inspect owned Linux MCP children.")?;
        let pids: Vec<libc::pid_t> = text
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(|_| "Invalid owned Linux process identity.")?;
        if pids.is_empty() {
            return Ok(());
        }
        for pid in pids {
            if pid <= 1 {
                return Err("Invalid owned Linux process identity.".into());
            }
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
            wait(pid)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seals_reject_noncooperating_write_truncate_and_shared_mapping() {
        let image = Executable::prepare(Path::new("/unused"), b"\x7fELF\x02fixture").unwrap();
        let fd = image.0.as_raw_fd();
        assert_eq!(unsafe { libc::pwrite(fd, b"x".as_ptr().cast(), 1, 0) }, -1);
        assert_eq!(unsafe { libc::ftruncate(fd, 0) }, -1);
        assert_eq!(unsafe { libc::ftruncate(fd, 1000) }, -1);
        assert_eq!(
            unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    4096,
                    libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                )
            },
            libc::MAP_FAILED
        );
    }
}
