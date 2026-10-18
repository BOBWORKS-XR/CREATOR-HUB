use super::{
    identity::{self, Pins, APP_REF, ECHO},
    transport, Result,
};
use crate::{
    protocol::{self, Kind},
    report, EchoFailure,
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
    match FixedEchoSession::launch_installed().and_then(FixedEchoSession::finish) {
        Ok(()) => report(true, true, "synthetic-echo-and-owned-exit"),
        Err(error) => report(false, error.owned_child_reaped(), error.reason()),
    }
}

// Constructed immediately after our own spawn, so constructor failures also reap.
struct OwnedLaunch {
    socket: Option<OwnedFd>,
    child: Child,
    cleaned: bool,
    reaped: bool,
}

impl OwnedLaunch {
    fn socket(&self) -> Result<&OwnedFd> {
        self.socket.as_ref().ok_or("echo-session-closed")
    }

    fn cleanup(&mut self) -> bool {
        if !self.cleaned {
            self.cleaned = true;
            drop(self.socket.take());
            self.reaped = match self.child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => {
                    let _ = self.child.kill();
                    reap(&mut self.child, Instant::now() + Duration::from_secs(2)).is_some()
                }
                // An unresolved child ownership/reap state is not permission to signal.
                Err(_) => false,
            };
        }
        self.reaped
    }
}

impl Drop for OwnedLaunch {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[derive(PartialEq, Eq)]
enum Phase {
    Ready,
    Echoed,
    Failed,
}

pub struct FixedEchoSession {
    owned: OwnedLaunch,
    pins: Pins,
    root: PathBuf,
    uid: u32,
    owner: (u32, u64),
    sender: (u32, u64),
    instance: String,
    messages: Vec<transport::Message>,
    deadline: Instant,
    phase: Phase,
    nonce: [u8; 32],
}

impl FixedEchoSession {
    /// Launch only the original compiled-pin, opted-in installed echo profile.
    pub fn launch_installed() -> std::result::Result<Self, EchoFailure> {
        let deadline = Instant::now() + BUDGET;
        let (pins, root, uid, mut command, host, child_fd, id_read, id_write) =
            prepare(deadline).map_err(|reason| EchoFailure {
                reason,
                owned_child_reaped: false,
            })?;
        let child =
            spawn(&mut command, &child_fd, Some(&id_write)).map_err(|reason| EchoFailure {
                reason,
                owned_child_reaped: false,
            })?;
        let mut owned = OwnedLaunch {
            socket: Some(host),
            child,
            cleaned: false,
            reaped: false,
        };
        drop(child_fd);
        drop(id_write);
        let validated = (|| -> Result<_> {
            let outer = identity::process(owned.child.id(), uid)?;
            let owner = (owned.child.id(), outer.start);
            let instance = read_instance(&id_read, deadline)?;
            let ready = transport::receive(owned.socket()?, deadline)?;
            if !protocol::matches(&ready.bytes, Kind::Ready, [0; 32]) {
                return Err("expected-ready");
            }
            let sender = identity::sender(&ready, None, owner, uid)?;
            identity::deployment(&ready, &root, &pins, &instance, uid, deadline)?;
            Ok((owner, instance, ready, sender))
        })();
        let (owner, instance, ready, sender) = validated.map_err(|reason| EchoFailure {
            reason,
            owned_child_reaped: owned.cleanup(),
        })?;
        Ok(Self {
            owned,
            pins,
            root,
            uid,
            owner,
            sender,
            instance,
            messages: vec![ready],
            deadline,
            phase: Phase::Ready,
            nonce: [0; 32],
        })
    }

    fn checked(&self, message: &transport::Message) -> Result<()> {
        if Instant::now() >= self.deadline {
            return Err("deadline");
        }
        identity::sender(message, Some(self.sender), self.owner, self.uid)?;
        identity::deployment(
            message,
            &self.root,
            &self.pins,
            &self.instance,
            self.uid,
            self.deadline,
        )
    }

    fn failure(&mut self, reason: &'static str) -> EchoFailure {
        self.phase = Phase::Failed;
        EchoFailure {
            reason,
            owned_child_reaped: self.owned.cleanup(),
        }
    }

    /// Recheck the retained last-message pidfd, sender and fixed deployment.
    pub fn revalidate(&mut self) -> std::result::Result<(), EchoFailure> {
        let result = if self.phase == Phase::Failed {
            Err("echo-session-closed")
        } else {
            self.messages
                .last()
                .ok_or("echo-session-closed")
                .and_then(|message| self.checked(message))
        };
        result.map_err(|reason| self.failure(reason))
    }

    /// Exactly one fixed random challenge. Failure permanently closes this session.
    pub fn challenge(&mut self) -> std::result::Result<(), EchoFailure> {
        if self.phase != Phase::Ready {
            return Err(self.failure("echo-challenge-order"));
        }
        // Poison before I/O: a partial exchange can never be retried.
        self.phase = Phase::Failed;
        let result = (|| -> Result<()> {
            self.checked(self.messages.last().ok_or("echo-session-closed")?)?;
            self.nonce = nonce()?;
            transport::send(
                self.owned.socket()?,
                &protocol::packet(Kind::Challenge, self.nonce),
                self.deadline,
            )?;
            let echo = transport::receive(self.owned.socket()?, self.deadline)?;
            self.checked(&echo)?;
            if !protocol::matches(&echo.bytes, Kind::Echo, self.nonce) {
                return Err("echo-mismatch");
            }
            self.messages.push(echo);
            Ok(())
        })();
        result.map_err(|reason| self.failure(reason))?;
        self.phase = Phase::Echoed;
        Ok(())
    }

    /// Complete the fixed exchange once, close the socket and reap normal exit.
    /// This consumes the capability and makes no Hub/publisher acceptance claim.
    pub fn finish(mut self) -> std::result::Result<(), EchoFailure> {
        if self.phase == Phase::Ready {
            self.challenge()?;
        }
        if self.phase != Phase::Echoed {
            return Err(self.failure("echo-session-closed"));
        }
        self.phase = Phase::Failed;
        let result = (|| -> Result<()> {
            self.checked(self.messages.last().ok_or("echo-session-closed")?)?;
            transport::send(
                self.owned.socket()?,
                &protocol::packet(Kind::Close, self.nonce),
                self.deadline,
            )?;
            let closed = transport::receive(self.owned.socket()?, self.deadline)?;
            self.checked(&closed)?;
            if !protocol::matches(&closed.bytes, Kind::Closed, self.nonce) {
                return Err("close-mismatch");
            }
            self.messages.push(closed);
            transport::send(
                self.owned.socket()?,
                &protocol::packet(Kind::Release, self.nonce),
                self.deadline,
            )?;
            // All received sender pidfds remain owned until the outer exit is reaped.
            let status = reap(&mut self.owned.child, self.deadline).ok_or("owned-exit-deadline")?;
            if !status.success() {
                return Err("owned-exit-nonzero");
            }
            Ok(())
        })();
        result.map_err(|reason| self.failure(reason))?;
        if !self.owned.cleanup() {
            return Err(self.failure("owned-exit-deadline"));
        }
        Ok(())
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
            assert_eq!(
                FixedEchoSession::launch_installed().err().unwrap().reason(),
                "unreviewed-build-pins"
            );
        }
    }

    #[test]
    #[ignore = "parent-coordinated fixed installed Flatpak profile only"]
    fn installed_session_retains_live_echo_and_finishes_explicitly() {
        let mut session = FixedEchoSession::launch_installed().unwrap();
        assert!(session.owned.child.try_wait().unwrap().is_none());
        assert_eq!(session.messages.len(), 1);
        session.revalidate().unwrap();
        session.challenge().unwrap();
        assert_eq!(session.messages.len(), 2);
        session.revalidate().unwrap();
        session.finish().unwrap();
    }

    #[test]
    #[ignore = "parent-coordinated fixed installed Flatpak profile only"]
    fn duplicate_challenge_poison_closes_without_retry() {
        let mut session = FixedEchoSession::launch_installed().unwrap();
        session.challenge().unwrap();
        let failure = session.challenge().unwrap_err();
        assert_eq!(failure.reason(), "echo-challenge-order");
        assert!(failure.owned_child_reaped());
        assert!(session.revalidate().is_err());
        assert!(session.finish().is_err());
    }

    #[test]
    #[ignore = "parent-coordinated fixed installed Flatpak profile only"]
    fn drop_reaps_only_its_owned_child_and_other_session_remains_live() {
        let session = FixedEchoSession::launch_installed().unwrap();
        let mut other = FixedEchoSession::launch_installed().unwrap();
        drop(session);
        assert!(other.owned.child.try_wait().unwrap().is_none());
        other.revalidate().unwrap();
        other.finish().unwrap();
    }

    #[test]
    #[ignore = "parent-coordinated fixed installed Flatpak profile only"]
    fn expired_live_session_refuses_and_cannot_restart_exchange() {
        let mut session = FixedEchoSession::launch_installed().unwrap();
        session.deadline = Instant::now();
        let failure = session.challenge().unwrap_err();
        assert_eq!(failure.reason(), "deadline");
        assert!(failure.owned_child_reaped());
        assert!(session.challenge().is_err());
        assert!(session.finish().is_err());
    }
}
