use super::{
    identity::{self, Pins, APP_REF, ECHO},
    transport, Result,
};
use crate::{
    protocol::{self, Kind},
    report,
};
use std::{
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const BUDGET: Duration = Duration::from_secs(30);
const CLOSE_RANGE_CLOEXEC: u32 = 4;

pub(crate) fn run() -> String {
    let deadline = Instant::now() + BUDGET;
    match prepare(deadline) {
        Err(reason) => report(false, false, reason),
        Ok((pins, root, uid, mut command, host, child_fd, id_read, id_write)) => {
            let mut child = match spawn(&mut command, &child_fd, Some(&id_write)) {
                Ok(child) => child,
                Err(reason) => return report(false, false, reason),
            };
            drop(child_fd);
            drop(id_write);
            let proof = (|| -> Result<()> {
                let outer = identity::process(child.id(), uid)?;
                let owner = (child.id(), outer.start);
                let instance = read_instance(&id_read, deadline)?;
                let ready = transport::receive(&host, deadline)?;
                if !protocol::matches(&ready.bytes, Kind::Ready, [0; 32]) {
                    return Err("expected-ready");
                }
                let sender = identity::sender(&ready, None, owner, uid)?;
                identity::deployment(&ready, &root, &pins, &instance, uid, deadline)?;
                let nonce = nonce()?;
                transport::send(&host, &protocol::packet(Kind::Challenge, nonce), deadline)?;
                let echo = transport::receive(&host, deadline)?;
                identity::sender(&echo, Some(sender), owner, uid)?;
                identity::deployment(&echo, &root, &pins, &instance, uid, deadline)?;
                if !protocol::matches(&echo.bytes, Kind::Echo, nonce) {
                    return Err("echo-mismatch");
                }
                transport::send(&host, &protocol::packet(Kind::Close, nonce), deadline)?;
                let closed = transport::receive(&host, deadline)?;
                identity::sender(&closed, Some(sender), owner, uid)?;
                identity::deployment(&closed, &root, &pins, &instance, uid, deadline)?;
                if !protocol::matches(&closed.bytes, Kind::Closed, nonce) {
                    return Err("close-mismatch");
                }
                transport::send(&host, &protocol::packet(Kind::Release, nonce), deadline)?;
                // Keep all sender pidfds alive until the owned outer process exits.
                let status = reap(&mut child, deadline).ok_or("owned-exit-deadline")?;
                if !status.success() {
                    return Err("owned-exit-nonzero");
                }
                Ok(())
            })();
            drop(host);
            let reaped = match child.try_wait() {
                Ok(Some(_)) => true,
                _ => {
                    // The retained Child cannot refer to a reused PID before reap.
                    let _ = child.kill();
                    reap(&mut child, Instant::now() + Duration::from_secs(2)).is_some()
                }
            };
            report(
                proof.is_ok() && reaped,
                reaped,
                proof.err().unwrap_or("synthetic-echo-and-owned-exit"),
            )
        }
    }
}

type Prepared = (
    Pins,
    PathBuf,
    u32,
    Command,
    OwnedFd,
    OwnedFd,
    OwnedFd,
    OwnedFd,
);

fn prepare(deadline: Instant) -> Result<Prepared> {
    // Missing source-reviewed pins refuses before process, environment or filesystem work.
    let pins = Pins::compiled()?;
    let uid = identity::uid()?;
    for (key, value) in [
        ("CREATOR_FLATPAK_LAUNCH_PROOF", "1"),
        ("GITHUB_ACTIONS", "true"),
        ("RUNNER_ENVIRONMENT", "github-hosted"),
        ("GITHUB_REPOSITORY", "BOBWORKS-XR/CREATOR-HUB"),
    ] {
        if std::env::var(key).as_deref() != Ok(value) {
            return Err("disposable-runner-required");
        }
    }
    if std::env::var_os("FLATPAK_ID").is_some()
        || Path::new("/.flatpak-info")
            .try_exists()
            .map_err(|_| "native-context")?
    {
        return Err("native-context");
    }
    let temp = std::env::var_os("RUNNER_TEMP").ok_or("runner-temp")?;
    let root = PathBuf::from(temp).join("creator-flatpak-launch-proof");
    identity::directory(&root, uid, true)?;
    for name in [
        "home", "config", "data", "cache", "runtime", "tmp", "flatpak",
    ] {
        identity::directory(&root.join(name), uid, true)?;
    }
    let bin = identity::directory(Path::new("/usr/bin"), uid, false)?;
    identity::digest(
        identity::at(&bin, "flatpak", libc::O_RDONLY | libc::O_NOFOLLOW)?,
        pins.flatpak,
        deadline,
    )?;
    let (host, child) = transport::pair()?;
    let mut pipe = [-1; 2];
    if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
        return Err("instance-pipe");
    }
    let reader = unsafe { OwnedFd::from_raw_fd(pipe[0]) };
    let writer = unsafe { OwnedFd::from_raw_fd(pipe[1]) };
    let mut command = Command::new("/usr/bin/flatpak");
    command.args([
        "run",
        "--user",
        "--no-session-bus",
        "--no-a11y-bus",
        "--no-documents-portal",
        "--die-with-parent",
        "--instance-id-fd=4",
        &format!("--commit={}", pins.app),
        &format!("--runtime-commit={}", pins.runtime),
        &format!("--command={ECHO}"),
        APP_REF,
        "echo-v1",
    ]);
    command.env_clear().current_dir(&root);
    for (key, name) in [
        ("HOME", "home"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_RUNTIME_DIR", "runtime"),
        ("TMPDIR", "tmp"),
        ("FLATPAK_USER_DIR", "flatpak"),
    ] {
        command.env(key, root.join(name));
    }
    command.env("PATH", "/usr/bin:/bin").env("LANG", "C.UTF-8");
    Ok((pins, root, uid, command, host, child, reader, writer))
}

pub(crate) fn spawn(
    command: &mut Command,
    socket: &OwnedFd,
    instance: Option<&OwnedFd>,
) -> Result<Child> {
    fn duplicate(fd: &OwnedFd) -> Result<OwnedFd> {
        let raw = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
        if raw < 0 {
            return Err("fd-duplicate");
        }
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    }
    let socket = duplicate(socket)?;
    let instance = instance.map(duplicate).transpose()?;
    let raw_socket = socket.as_raw_fd();
    let raw_instance = instance.as_ref().map(AsRawFd::as_raw_fd);
    let parent = unsafe { libc::getpid() };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != parent
            {
                return Err(std::io::Error::from_raw_os_error(libc::EPERM));
            }
            // CLOEXEC preserves Rust's exec-error pipe until exec, unlike closing all FDs.
            if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) != 0
                || libc::dup2(raw_socket, 3) < 0
                || raw_instance.is_some_and(|fd| libc::dup2(fd, 4) < 0)
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().map_err(|_| "owned-launch")
}

pub(crate) fn reap(child: &mut Child, deadline: Instant) -> Option<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Err(_) => return None,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn nonce() -> Result<[u8; 32]> {
    let mut bytes = [0; 32];
    if unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), libc::GRND_NONBLOCK) }
        != bytes.len() as isize
        || bytes == [0; 32]
    {
        return Err("nonce-unavailable");
    }
    Ok(bytes)
}

fn read_instance(fd: &OwnedFd, deadline: Instant) -> Result<String> {
    let mut value = Vec::new();
    loop {
        transport::wait(fd, libc::POLLIN | libc::POLLHUP, deadline)?;
        let mut bytes = [0; 33];
        let n = unsafe { libc::read(fd.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
        if n < 0 {
            return Err("instance-read");
        }
        if n == 0 {
            break;
        }
        value.extend_from_slice(&bytes[..n as usize]);
        if value.len() > 32 {
            return Err("instance-limit");
        }
    }
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        return Err("instance-format");
    }
    String::from_utf8(value).map_err(|_| "instance-format")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_pins_cannot_start_flatpak() {
        if Pins::compiled().is_err() {
            assert!(run().contains("unreviewed-build-pins"));
        }
    }
}
