//! Process-lifetime adapter for the single-threaded headless router only.
//! A separate supervisor observes a private EOF lifeline even after SIGKILL.
use crate::{digest, Runtime};
use std::{
    ffi::{CString, OsStr},
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, process::ExitStatusExt},
    },
    process::ExitStatus,
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
#[path = "unix_exec_linux.rs"]
mod native;
#[cfg(target_os = "macos")]
#[path = "unix_exec_macos.rs"]
mod native;

// The synchronous hook returns the verified buffer under the original file URL,
// preserving import.meta.url and argv without reopening the mutable server path.
const LOADER: &str = r#"
import {readFileSync, closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const source = readFileSync(3);
closeSync(3);
const path = process.argv[1];
const expected = process.argv[2];
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Verified MCP source transport changed. Nothing was loaded.');
}
const entry = pathToFileURL(path).href;
if (process.platform === 'linux') process.execPath = `/proc/${process.pid}/fd/4`;
process.argv = [process.execPath, path];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === entry) return {url: entry, shortCircuit: true};
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === entry) return {format: 'module', source, shortCircuit: true};
    return next(url, context);
  }
});
await import(entry);
"#;

pub(super) struct Pipe {
    read: File,
    write: File,
}

fn high_fd(fd: i32) -> Result<File, String> {
    let high = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if high < 0 {
        return Err("Cannot reserve private MCP file descriptors.".into());
    }
    Ok(unsafe { File::from_raw_fd(high) })
}

impl Pipe {
    fn new() -> Result<Self, String> {
        let mut fds = [-1; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err("Cannot create private MCP supervision pipes.".into());
        }
        let read = unsafe { File::from_raw_fd(fds[0]) };
        let write = unsafe { File::from_raw_fd(fds[1]) };
        Ok(Self {
            read: high_fd(read.as_raw_fd())?,
            write: high_fd(write.as_raw_fd())?,
        })
    }
}

fn cstring(value: &OsStr) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| "Invalid native MCP argument.".into())
}

pub(super) fn clean_environment() -> Result<Vec<CString>, String> {
    std::env::vars_os()
        .filter(|(name, _)| {
            let name = name.as_bytes();
            name != b"NODE_OPTIONS"
                && name != b"NODE_PATH"
                && !name.starts_with(b"LD_")
                && !name.starts_with(b"DYLD_")
        })
        .map(|(name, value)| {
            let mut entry = name.as_bytes().to_vec();
            entry.push(b'=');
            entry.extend_from_slice(value.as_bytes());
            CString::new(entry).map_err(|_| "Invalid native MCP environment.".into())
        })
        .collect()
}

fn pointers(values: &[CString]) -> Vec<*mut libc::c_char> {
    values
        .iter()
        .map(|value| value.as_ptr().cast_mut())
        .chain(std::iter::once(std::ptr::null_mut()))
        .collect()
}

fn wait(pid: libc::pid_t) -> Result<i32, String> {
    let mut status = 0;
    loop {
        if unsafe { libc::waitpid(pid, &mut status, 0) } == pid {
            return Ok(status);
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err("Cannot reap owned MCP process.".into());
        }
    }
}

fn send_source(mut file: File, source: &[u8]) -> Result<(), String> {
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("Cannot bound MCP source transfer.".into());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut remaining = source;
    while !remaining.is_empty() {
        if Instant::now() >= deadline {
            return Err("Verified MCP runtime did not read its source in time.".into());
        }
        match file.write(remaining) {
            Ok(0) => return Err("MCP source transport closed.".into()),
            Ok(count) => remaining = &remaining[count..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let mut poll = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut poll, 1, 100) } < 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
                {
                    return Err("Cannot poll MCP source transport.".into());
                }
            }
            Err(_) => return Err("Verified MCP runtime refused its source transport.".into()),
        }
    }
    Ok(())
}

pub(super) fn run(runtime: Runtime) -> Result<ExitStatus, String> {
    native::ensure_single_thread()?;
    let node = runtime
        ._snapshots
        .get("mcp/server/runtime/node")
        .ok_or("Missing verified Node snapshot.")?;
    let source = runtime
        ._snapshots
        .get("mcp/server/creator-works-mcp.mjs")
        .ok_or("Missing verified server snapshot.")?;
    let executable = native::Executable::prepare(&runtime.node, node)?;
    let arguments = vec![
        cstring(runtime.node.as_os_str())?,
        CString::new("--input-type=module").unwrap(),
        CString::new("--eval").unwrap(),
        CString::new(LOADER).unwrap(),
        cstring(runtime.server.as_os_str())?,
        CString::new(digest(source)).unwrap(),
    ];
    let environment = clean_environment()?;
    let argv = pointers(&arguments);
    let envp = pointers(&environment);
    let life = Pipe::new()?;
    let source_pipe = Pipe::new()?;
    let result = Pipe::new()?;
    // A single-threaded headless caller is required, so the private supervisor
    // cannot inherit allocator locks from other threads. Never fork a Hub GUI.
    let supervisor = unsafe { libc::fork() };
    if supervisor < 0 {
        return Err("Cannot create owned MCP supervisor.".into());
    }
    if supervisor == 0 {
        unsafe {
            libc::signal(libc::SIGCHLD, libc::SIG_DFL);
            libc::close(life.write.as_raw_fd());
            libc::close(source_pipe.write.as_raw_fd());
            libc::close(result.read.as_raw_fd());
        }
        let outcome = supervise(
            &executable,
            &argv,
            &envp,
            life.read.as_raw_fd(),
            source_pipe.read.as_raw_fd(),
        );
        let status = outcome.unwrap_or(-1).to_ne_bytes();
        unsafe {
            libc::write(
                result.write.as_raw_fd(),
                status.as_ptr().cast(),
                status.len(),
            );
            libc::_exit(0);
        }
    }
    drop(life.read);
    drop(source_pipe.read);
    drop(result.write);
    let transfer = send_source(source_pipe.write, source);
    if transfer.is_err() {
        // Closing the only lifeline writer requests cleanup before we return.
        drop(life.write);
    }
    let supervisor_status = wait(supervisor)?;
    let mut result = result.read;
    let mut bytes = [0; 4];
    result
        .read_exact(&mut bytes)
        .map_err(|_| "Owned MCP supervisor stopped without an outcome.")?;
    transfer?;
    let status = i32::from_ne_bytes(bytes);
    if !ExitStatus::from_raw(supervisor_status).success() || status < 0 {
        return Err("Native MCP execution or payload identity was refused; owned processes were cleaned up.".into());
    }
    Ok(ExitStatus::from_raw(status))
}

fn supervise(
    executable: &native::Executable,
    argv: &[*mut libc::c_char],
    envp: &[*mut libc::c_char],
    lifeline: i32,
    source: i32,
) -> Result<i32, String> {
    native::prepare_supervisor()?;
    let pid = executable.spawn(argv, envp, source)?;
    unsafe {
        libc::close(source);
    }
    let mut stopped = false;
    let mut failure = None;
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let check = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if check == 0 && unsafe { info.si_pid() } == pid {
            break;
        }
        if check < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            failure = Some("Cannot observe owned MCP process exit.");
            break;
        }
        let mut poll = libc::pollfd {
            fd: lifeline,
            events: libc::POLLIN,
            revents: 0,
        };
        let polled = unsafe { libc::poll(&mut poll, 1, 50) };
        if polled > 0 && poll.revents != 0 {
            stopped = true;
            break;
        }
        if polled < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            failure = Some("Cannot observe MCP router lifeline.");
            break;
        }
    }
    // Keep the direct child waitable until killpg: its PID/group cannot be
    // recycled while we address the owned group. Never kill by process name.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let status = wait(pid)?;
    native::cleanup_adopted()?;
    if let Some(failure) = failure {
        return Err(failure.into());
    }
    if stopped {
        Err("MCP router disconnected.".into())
    } else {
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_dynamic_loader_and_node_overrides_are_removed() {
        // The test subprocess, not the parallel harness, supplies these values.
        let environment = clean_environment().unwrap();
        for item in environment {
            let name = item.to_bytes().split(|byte| *byte == b'=').next().unwrap();
            assert!(![b"NODE_OPTIONS".as_slice(), b"NODE_PATH"].contains(&name));
            assert!(!name.starts_with(b"LD_") && !name.starts_with(b"DYLD_"));
        }
    }
}
