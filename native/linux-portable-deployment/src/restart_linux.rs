use super::*;
use std::{
    fs::File,
    io::Read as _,
    mem,
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    os::unix::process::CommandExt,
    process::{Child, ExitStatus},
    time::Instant,
};

const CHANNEL_MARKER: &str = "CREATOR_HUB_RESTART_CHANNEL";
const CHILD_FD: RawFd = 198;
const FRAME_SIZE: usize = 137;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Frame {
    kind: Kind,
    target: Target,
}

impl Frame {
    fn encode(&self) -> Result<[u8; FRAME_SIZE]> {
        Expected::linux_x86_64(&self.target.version)?;
        require(
            hex(&self.target.generation, 64),
            "Invalid restart generation identity",
        )?;
        let mut bytes = [0; FRAME_SIZE];
        bytes[..4].copy_from_slice(b"CHRS");
        bytes[4] = 1;
        bytes[5] = self.kind as u8;
        bytes[8..72].copy_from_slice(self.target.generation.as_bytes());
        bytes[72] = self.target.version.len() as u8;
        bytes[73..73 + self.target.version.len()].copy_from_slice(self.target.version.as_bytes());
        Ok(bytes)
    }
    fn decode(bytes: &[u8]) -> Result<Self> {
        require(
            bytes.len() == FRAME_SIZE
                && bytes[..4] == *b"CHRS"
                && bytes[4] == 1
                && bytes[6..8] == [0, 0],
            "Malformed restart packet",
        )?;
        let kind = match bytes[5] {
            1 => Kind::Hello,
            2 => Kind::HelloAck,
            3 => Kind::Prepare,
            4 => Kind::Ready,
            5 => Kind::Arm,
            6 => Kind::Armed,
            7 => Kind::Cancel,
            8 => Kind::Cancelled,
            9 => Kind::ExitIntent,
            10 => Kind::ExitGranted,
            _ => return Err(refused("Unknown restart packet kind")),
        };
        let length = bytes[72] as usize;
        require(
            (1..=64).contains(&length) && bytes[73 + length..].iter().all(|v| *v == 0),
            "Invalid restart version padding",
        )?;
        let target = Target {
            generation: std::str::from_utf8(&bytes[8..72])
                .map_err(|_| refused("Invalid generation encoding"))?
                .into(),
            version: std::str::from_utf8(&bytes[73..73 + length])
                .map_err(|_| refused("Invalid version encoding"))?
                .into(),
        };
        require(
            hex(&target.generation, 64),
            "Invalid restart generation digest",
        )?;
        Expected::linux_x86_64(&target.version)?;
        Ok(Self { kind, target })
    }
}

#[derive(Clone, Copy, Debug)]
struct Credentials {
    pid: libc::pid_t,
    uid: libc::uid_t,
    gid: libc::gid_t,
}

enum Received {
    Pending,
    Closed,
    Packet(Frame, Credentials),
}

struct Channel(OwnedFd);

impl Channel {
    fn pair() -> Result<(Self, Self)> {
        let mut fds = [-1; 2];
        require(
            unsafe {
                libc::socketpair(
                    libc::AF_UNIX,
                    libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                    0,
                    fds.as_mut_ptr(),
                )
            } == 0,
            "Cannot create inherited restart channel",
        )?;
        let pair = unsafe {
            (
                Self(OwnedFd::from_raw_fd(fds[0])),
                Self(OwnedFd::from_raw_fd(fds[1])),
            )
        };
        for socket in [&pair.0, &pair.1] {
            let enabled: libc::c_int = 1;
            require(
                unsafe {
                    libc::setsockopt(
                        socket.fd(),
                        libc::SOL_SOCKET,
                        libc::SO_PASSCRED,
                        (&enabled as *const libc::c_int).cast(),
                        mem::size_of_val(&enabled) as _,
                    )
                } == 0,
                "Cannot enable per-message restart credentials",
            )?;
        }
        Ok(pair)
    }
    fn inherited() -> Result<Option<Self>> {
        let Some(marker) = std::env::var_os(CHANNEL_MARKER) else {
            return Ok(None);
        };
        require(marker == "1", "Unrecognized restart channel marker")?;
        let fd = unsafe { libc::fcntl(CHILD_FD, libc::F_DUPFD_CLOEXEC, CHILD_FD + 1) };
        require(fd >= 0, "Inherited restart channel is unavailable")?;
        let channel = Self(unsafe { OwnedFd::from_raw_fd(fd) });
        channel.validate()?;
        // Do not leak an admitted channel into later MCP/other child execs.
        require(
            unsafe { libc::fcntl(CHILD_FD, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "Cannot protect inherited restart descriptor",
        )?;
        Ok(Some(channel))
    }
    fn validate(&self) -> Result<()> {
        for (option, expected) in [
            (libc::SO_TYPE, libc::SOCK_SEQPACKET),
            (libc::SO_DOMAIN, libc::AF_UNIX),
            (libc::SO_PASSCRED, 1),
        ] {
            let mut value: libc::c_int = 0;
            let mut length = mem::size_of_val(&value) as libc::socklen_t;
            require(
                unsafe {
                    libc::getsockopt(
                        self.fd(),
                        libc::SOL_SOCKET,
                        option,
                        (&mut value as *mut libc::c_int).cast(),
                        &mut length,
                    )
                } == 0
                    && length as usize == mem::size_of_val(&value)
                    && value == expected,
                "Inherited descriptor is not the fixed credentialled packet channel",
            )?;
        }
        Ok(())
    }
    fn fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
    fn shutdown(&self) {
        unsafe {
            libc::shutdown(self.fd(), libc::SHUT_RDWR);
        }
    }
    fn send(&self, frame: &Frame) -> Result<()> {
        let bytes = frame.encode()?;
        require(
            unsafe {
                libc::send(
                    self.fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
                )
            } == bytes.len() as isize,
            "Restart packet could not be sent; no retry",
        )
    }
    fn receive(&self) -> Result<Received> {
        let mut bytes = [0u8; FRAME_SIZE];
        // Native-word alignment permits cmsghdr access. SCM_RIGHTS is never
        // accepted, but every delivered descriptor is closed before refusal.
        let mut control = [0usize; 64];
        let mut vector = libc::iovec {
            iov_base: bytes.as_mut_ptr().cast(),
            iov_len: bytes.len(),
        };
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = mem::size_of_val(&control);
        let count = unsafe {
            libc::recvmsg(
                self.fd(),
                &mut message,
                libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC | libc::MSG_TRUNC,
            )
        };
        if count < 0 {
            return match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EAGAIN | libc::EINTR) => Ok(Received::Pending),
                _ => Err(refused("Cannot receive restart packet")),
            };
        }
        let mut credentials = None;
        let mut invalid_control = false;
        let mut messages = 0;
        let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        while !header.is_null() {
            messages += 1;
            let length = unsafe { (*header).cmsg_len };
            let minimum = unsafe { libc::CMSG_LEN(0) } as usize;
            let offset = header as usize - control.as_ptr() as usize;
            if length < minimum || offset + length > message.msg_controllen {
                invalid_control = true;
                break;
            }
            let data = unsafe { libc::CMSG_DATA(header) };
            let size = length - minimum;
            let (level, kind) = unsafe { ((*header).cmsg_level, (*header).cmsg_type) };
            if level == libc::SOL_SOCKET && kind == libc::SCM_RIGHTS {
                for at in (0..size / mem::size_of::<RawFd>()).map(|n| n * mem::size_of::<RawFd>()) {
                    unsafe {
                        libc::close(std::ptr::read_unaligned(data.add(at).cast::<RawFd>()));
                    }
                }
                invalid_control = true;
            } else if level == libc::SOL_SOCKET
                && kind == libc::SCM_CREDENTIALS
                && size == mem::size_of::<libc::ucred>()
                && credentials.is_none()
            {
                let cred = unsafe { std::ptr::read_unaligned(data.cast::<libc::ucred>()) };
                credentials = Some(Credentials {
                    pid: cred.pid,
                    uid: cred.uid,
                    gid: cred.gid,
                });
            } else {
                invalid_control = true;
            }
            header = unsafe { libc::CMSG_NXTHDR(&message, header) };
        }
        require(
            !invalid_control && message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) == 0,
            "Truncated/extra ancillary restart data refused",
        )?;
        if count == 0 {
            require(
                messages == 0 && credentials.is_none(),
                "Empty restart packet is not channel EOF",
            )?;
            return Ok(Received::Closed);
        }
        require(
            count as usize == FRAME_SIZE && messages == 1,
            "Wrong restart packet size/ancillary count",
        )?;
        let credentials =
            credentials.ok_or_else(|| refused("Missing per-message kernel restart credentials"))?;
        Ok(Received::Packet(Frame::decode(&bytes)?, credentials))
    }
    fn wait(&self, deadline: Instant) -> Result<(Frame, Credentials)> {
        match self.wait_received(deadline)? {
            Received::Packet(frame, credentials) => Ok((frame, credentials)),
            _ => Err(refused("Restart channel closed without acknowledgement")),
        }
    }
    fn wait_received(&self, deadline: Instant) -> Result<Received> {
        loop {
            if Instant::now() >= deadline {
                return Err(refused("Restart channel deadline expired"));
            }
            match self.receive()? {
                packet @ (Received::Packet(_, _) | Received::Closed) => return Ok(packet),
                Received::Pending => self.poll(deadline),
            }
        }
    }
    fn poll(&self, deadline: Instant) {
        let millis = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(100) as i32;
        let mut poll = libc::pollfd {
            fd: self.fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe {
            libc::poll(&mut poll, 1, millis);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Birth {
    pid: i32,
    parent: i32,
    start: u64,
}

fn parse_stat(pid: i32, text: &str) -> Result<Birth> {
    require(
        pid > 0 && text.len() <= 8192 && text.starts_with(&format!("{pid} (")),
        "Invalid kernel process identity",
    )?;
    let end = text
        .rfind(") ")
        .ok_or_else(|| refused("Cannot parse kernel process name"))?;
    let fields: Vec<_> = text[end + 2..].split_ascii_whitespace().collect();
    require(
        fields.len() >= 20 && fields[0].len() == 1,
        "Incomplete kernel process status",
    )?;
    let parent = fields[1]
        .parse()
        .map_err(|_| refused("Invalid kernel parent PID"))?;
    let start = fields[19]
        .parse()
        .map_err(|_| refused("Invalid kernel process start time"))?;
    require(parent >= 0 && start > 0, "Unbound kernel process birth")?;
    Ok(Birth { pid, parent, start })
}

fn birth(pid: i32) -> Result<Birth> {
    let mut text = String::new();
    File::open(format!("/proc/{pid}/stat"))
        .and_then(|file| file.take(8193).read_to_string(&mut text))
        .map_err(|_| refused("Cannot inspect kernel process birth"))?;
    parse_stat(pid, &text)
}

struct Process {
    birth: Birth,
    image: File,
}

impl Process {
    fn capture(pid: i32) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let before = birth(pid)?;
        let owner = fs::metadata(format!("/proc/{pid}"))
            .map_err(|_| refused("Cannot inspect native process owner"))?;
        require(
            owner.uid() == unsafe { libc::geteuid() },
            "Foreign native process owner",
        )?;
        let image = File::open(format!("/proc/{pid}/exe"))
            .map_err(|_| refused("Cannot inspect kernel executable image"))?;
        require(
            birth(pid)? == before,
            "Process identity changed during image admission",
        )?;
        Ok(Self {
            birth: before,
            image,
        })
    }
    fn check(&self, credentials: Credentials) -> Result<()> {
        require(
            credentials.pid == self.birth.pid
                && credentials.uid == unsafe { libc::geteuid() }
                && credentials.gid == unsafe { libc::getgid() },
            "Restart sender credentials do not match the admitted native process",
        )?;
        self.live()
    }
    fn live(&self) -> Result<()> {
        let current = Self::capture(self.birth.pid)?;
        require(
            current.birth == self.birth
                && super::super::host::same_file(&current.image, &self.image)?,
            "Native process start/image changed",
        )
    }
    // Cleanup-only proof: a dead selector may reparent the still-live Root.
    // Admission and packet authentication retain the stronger parent check.
    fn alive_image(&self) -> Result<()> {
        let current = Self::capture(self.birth.pid)?;
        require(
            current.birth.pid == self.birth.pid
                && current.birth.start == self.birth.start
                && super::super::host::same_file(&current.image, &self.image)?,
            "Root process start/image changed during abort resolution",
        )
    }
}

/// Only Unknown blocks an ordinary close. Prepared is not exit authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartDisposition {
    Idle,
    Prepared,
    ExitAuthorized,
    Aborted,
    SafeNotArmed,
    PeerClosedSafe,
    Unknown,
}

/// Opaque Root client. An admission error is updater unavailability, not a
/// request to terminate normal Root. Existing portable startup admission stays.
#[must_use]
pub struct RootRestart {
    channel: Channel,
    root: PathBuf,
    before: SelectionSnapshot,
    me: Process,
    selector: Process,
    ready: Option<Target>,
    pending: Option<Target>,
    intent_sent: bool,
    disposition: RestartDisposition,
    spent: bool,
}

#[must_use]
#[derive(Debug)]
pub struct RestartReady {
    target: Target,
    root_start: u64,
    selector_start: u64,
}

impl RootRestart {
    pub fn admit(session: &HostSession, store: &Store) -> Result<Option<Self>> {
        let Some(channel) = Channel::inherited()? else {
            return Ok(None);
        };
        disk::admit()?;
        require(
            store.root == session.store_path(),
            "Restart client must use the fixed native store",
        )?;
        store.no_registration_recovery()?;
        let before = store
            .snapshot()?
            .ok_or_else(|| refused("No signed Root selection"))?;
        store.bind_current_process(&Expected::linux_x86_64(&before.selection().version)?)?;
        let me = Process::capture(unsafe { libc::getpid() })?;
        let (hello, credentials) = channel.wait(Instant::now() + ADMISSION_TIMEOUT)?;
        require(
            hello
                == Frame {
                    kind: Kind::Hello,
                    target: target_of(&before),
                },
            "Wrong restart admission identity",
        )?;
        require(
            credentials.pid == me.birth.parent,
            "Root is not the selector's same owned AppRun child",
        )?;
        let selector = Process::capture(credentials.pid)?;
        selector.check(credentials)?;
        require(
            super::super::host::same_file(
                &selector.image,
                &store.registered_selector_image(session)?,
            )?,
            "Restart parent is not the signed registered selector",
        )?;
        me.live()?;
        selector.live()?;
        channel.send(&Frame {
            kind: Kind::HelloAck,
            target: target_of(&before),
        })?;
        // Only a successfully authenticated inherited endpoint is consumed.
        unsafe {
            libc::close(CHILD_FD);
        }
        Ok(Some(Self {
            channel,
            root: store.root.clone(),
            before,
            me,
            selector,
            ready: None,
            pending: None,
            intent_sent: false,
            disposition: RestartDisposition::Idle,
            spent: false,
        }))
    }
    fn check(&self) -> Result<Store> {
        let session = HostSession::capture()?;
        require(
            session.store_path() == self.root,
            "Native restart settings context changed",
        )?;
        let store = Store::open(&self.root)?;
        store.no_registration_recovery()?;
        require(
            store.snapshot()?.as_ref() == Some(&self.before),
            "Root restart selection changed",
        )?;
        self.me.live()?;
        self.selector.live()?;
        require(
            super::super::host::same_file(
                &self.selector.image,
                &store.registered_selector_image(&session)?,
            )?,
            "Registered selector image changed",
        )?;
        Ok(store)
    }
    pub fn prepare(&mut self, staged: StagedRestart) -> Result<RestartReady> {
        require(
            !self.spent && self.ready.is_none(),
            "Restart channel already used",
        )?;
        self.spent = true;
        require(
            staged.root == self.root && staged.before == self.before,
            "Staged restart belongs to another Root selection",
        )?;
        let store = self.check()?;
        store.check_restart_target(&self.before, &staged.target, &production_verify)?;
        let deadline = Instant::now() + ADMISSION_TIMEOUT;
        self.prepare_after_validation(staged.target, deadline, deadline, &|client, credentials| {
            client.selector.check(credentials)?;
            client.check().map(|_| ())
        })
    }
    fn prepare_after_validation(
        &mut self,
        target: Target,
        ready_deadline: Instant,
        armed_deadline: Instant,
        validate: &dyn Fn(&Self, Credentials) -> Result<()>,
    ) -> Result<RestartReady> {
        // Retain abort authority before any proposal/Arm can reach the peer.
        self.pending = Some(target.clone());
        let result = prepare_exchange(
            &self.channel,
            &target,
            ready_deadline,
            armed_deadline,
            &|credentials| validate(self, credentials),
        );
        if let Err(error) = result {
            // Preparation never sends ExitIntent. Even a lost Armed ACK cannot
            // authorize a later ordinary zero-code exit to change selection.
            return match self.abort_pending() {
                Ok(()) => Err(error),
                Err(unknown) => Err(unknown),
            };
        }
        self.ready = Some(target.clone());
        self.disposition = RestartDisposition::Prepared;
        Ok(RestartReady {
            target,
            root_start: self.me.birth.start,
            selector_start: self.selector.birth.start,
        })
    }
    pub fn disposition(&self) -> RestartDisposition {
        self.disposition
    }
    /// Only unresolved exit authorization blocks an ordinary zero-code close.
    /// Prepared permits ordinary close WITHOUT updating. Update close requires
    /// successful authorize_exit and ExitAuthorized, not this predicate alone.
    pub fn normal_exit_allowed(&self) -> bool {
        self.disposition != RestartDisposition::Unknown
    }
    /// Call only from the reviewed, serialized Root close path. Preparation
    /// alone never authorizes selection. Retain this client on Unknown.
    pub fn authorize_exit(&mut self, ready: RestartReady) -> Result<()> {
        self.require_token(&ready)?;
        self.ready = None;
        let target = ready.target;
        let checked = self.check().and_then(|store| {
            store.check_restart_target(&self.before, &target, &production_verify)
        });
        if let Err(error) = checked {
            return match self.abort_pending() {
                Ok(()) => Err(error),
                Err(unknown) => Err(unknown),
            };
        }
        self.authorize_after_validation(
            target,
            Instant::now() + ADMISSION_TIMEOUT,
            &|client, cred| {
                client.selector.check(cred)?;
                client.check().map(|_| ())
            },
        )
    }
    fn authorize_after_validation(
        &mut self,
        target: Target,
        deadline: Instant,
        validate: &dyn Fn(&Self, Credentials) -> Result<()>,
    ) -> Result<()> {
        // Conservatively retain authority even if send itself reports an error.
        self.intent_sent = true;
        self.disposition = RestartDisposition::Unknown;
        let sent = self.channel.send(&Frame {
            kind: Kind::ExitIntent,
            target: target.clone(),
        });
        let result = sent.and_then(|()| {
            expect_packet(
                &self.channel,
                Kind::ExitGranted,
                &target,
                deadline,
                &|cred| validate(self, cred),
            )
        });
        if let Err(error) = result {
            return match self.abort_pending() {
                Ok(()) => Err(error),
                Err(unknown) => Err(unknown),
            };
        }
        self.disposition = RestartDisposition::ExitAuthorized;
        Ok(())
    }
    /// Available without a RestartReady token, including after prepare failed.
    /// Confirmed Cancelled or observable safe peer closure resolves authority.
    pub fn abort_pending(&mut self) -> Result<()> {
        self.abort_with_deadline(Instant::now() + ADMISSION_TIMEOUT)
    }
    fn abort_with_deadline(&mut self, deadline: Instant) -> Result<()> {
        self.ready = None;
        let Some(target) = &self.pending else {
            return Ok(());
        };
        let result = abort_exchange(
            &self.channel,
            target,
            deadline,
            &|credentials| {
                self.me.live()?;
                self.selector.check(credentials)
            },
            &|| self.me.alive_image(),
        );
        let disposition = match result {
            Ok(AbortResolution::Acknowledged) => RestartDisposition::Aborted,
            Ok(AbortResolution::PeerClosed) => RestartDisposition::PeerClosedSafe,
            Err(_) if !self.intent_sent => RestartDisposition::SafeNotArmed,
            Err(_) => {
                self.disposition = RestartDisposition::Unknown;
                return Err(Error {
                    kind: ErrorKind::OutcomeUnknown,
                    message: "Exit authorization may have reached the coordinator; abort was not acknowledged and safe peer closure was not observed. Retain this client, block exit zero and retry abort resolution; do not claim unchanged.",
                });
            }
        };
        self.disposition = disposition;
        self.pending = None;
        self.channel.shutdown();
        Ok(())
    }
    pub fn cancel(&mut self, ready: RestartReady) -> Result<()> {
        self.require_token(&ready)?;
        self.abort_pending()
    }
    fn require_token(&self, ready: &RestartReady) -> Result<()> {
        require(
            self.ready.as_ref() == Some(&ready.target)
                && self.pending.as_ref() == Some(&ready.target)
                && ready.root_start == self.me.birth.start
                && ready.selector_start == self.selector.birth.start,
            "Readiness token belongs to another coordinator",
        )
    }
}

fn expect_packet(
    channel: &Channel,
    kind: Kind,
    target: &Target,
    deadline: Instant,
    validate: &dyn Fn(Credentials) -> Result<()>,
) -> Result<()> {
    let (frame, credentials) = channel.wait(deadline)?;
    validate(credentials)?;
    require(
        frame
            == Frame {
                kind,
                target: target.clone(),
            },
        "Unexpected restart acknowledgement",
    )
}

fn prepare_exchange(
    channel: &Channel,
    target: &Target,
    ready_deadline: Instant,
    armed_deadline: Instant,
    validate: &dyn Fn(Credentials) -> Result<()>,
) -> Result<()> {
    channel.send(&Frame {
        kind: Kind::Prepare,
        target: target.clone(),
    })?;
    expect_packet(channel, Kind::Ready, target, ready_deadline, validate)?;
    channel.send(&Frame {
        kind: Kind::Arm,
        target: target.clone(),
    })?;
    expect_packet(channel, Kind::Armed, target, armed_deadline, validate)
}

enum AbortResolution {
    Acknowledged,
    PeerClosed,
}

fn abort_exchange(
    channel: &Channel,
    target: &Target,
    deadline: Instant,
    validate: &dyn Fn(Credentials) -> Result<()>,
    alive_root: &dyn Fn() -> Result<()>,
) -> Result<AbortResolution> {
    let sent = channel.send(&Frame {
        kind: Kind::Cancel,
        target: target.clone(),
    });
    // The authenticated endpoint can close after disarming (or dying). Since
    // this exact Root is still alive, that peer cannot have observed its exit.
    if let Err(error) = sent {
        return match channel.receive()? {
            Received::Closed => {
                alive_root()?;
                Ok(AbortResolution::PeerClosed)
            }
            _ => Err(error),
        };
    }
    // At most three already-in-flight readiness/exit ACKs precede cancellation.
    // They are authenticated but do not constitute abort success or readiness.
    for _ in 0..4 {
        let (frame, credentials) = match channel.wait_received(deadline)? {
            Received::Closed => {
                alive_root()?;
                return Ok(AbortResolution::PeerClosed);
            }
            Received::Packet(frame, credentials) => (frame, credentials),
            Received::Pending => unreachable!("wait_received never returns Pending"),
        };
        validate(credentials)?;
        require(
            frame.target == *target,
            "Abort acknowledgement target differs",
        )?;
        match frame.kind {
            Kind::Cancelled => return Ok(AbortResolution::Acknowledged),
            Kind::Ready | Kind::Armed | Kind::ExitGranted => {}
            _ => return Err(refused("Unexpected abort acknowledgement")),
        }
    }
    Err(refused("Restart abort acknowledgement budget exhausted"))
}

#[derive(Debug)]
pub struct SupervisionOutcome {
    pub exit_code: Option<i32>,
    pub restarted: bool,
    pub restart_unavailable: bool,
}

enum ObservedExit {
    Unarmed(ExitStatus, bool),
    Approved(SelectionSnapshot, Target),
}

impl Store {
    pub fn supervise_registered(&self, session: &HostSession) -> Result<SupervisionOutcome> {
        disk::admit()?;
        let selector_image = self.admit_registered_selector(session)?;
        let selector = match Process::capture(unsafe { libc::getpid() }) {
            Ok(value) => value,
            Err(_) => {
                // Missing restart-specific /proc support must not disable the
                // already guarded ordinary native activation path.
                let status = self
                    .activate_registered(session)?
                    .wait()
                    .map_err(|_| refused("Cannot observe ordinary native Hub exit"))?;
                return Ok(SupervisionOutcome {
                    exit_code: status.code(),
                    restarted: false,
                    restart_unavailable: true,
                });
            }
        };
        require(
            super::super::host::same_file(&selector.image, &selector_image)?,
            "Coordinator is not the admitted selector image",
        )?;
        let mut restarted = false;
        loop {
            let observed = self.supervise_one(session, &selector).map_err(|error| {
                if restarted { Error { kind: ErrorKind::OutcomeUnknown, message: "Approved generation was selected but subsequent launch/supervision failed; no automatic retry or rollback was attempted" } } else { error }
            })?;
            match observed {
                ObservedExit::Unarmed(status, unavailable) => {
                    return Ok(SupervisionOutcome {
                        exit_code: status.code(),
                        restarted,
                        restart_unavailable: unavailable,
                    })
                }
                ObservedExit::Approved(before, target) => {
                    selector.live()?;
                    self.admit_registered_selector(session)?;
                    self.check_restart_target(&before, &target, &production_verify)?;
                    // No installer, restart override, rollback, fallback or retry.
                    let outcome = self.activate(
                        &target.generation,
                        &Expected::linux_x86_64(&target.version)?,
                        Some(&before),
                        || false,
                    )?;
                    require(
                        matches!(outcome, Activation::Committed(_)),
                        "Restart did not commit the approved target",
                    )?;
                    restarted = true;
                }
            }
        }
    }

    fn supervise_one(&self, session: &HostSession, selector: &Process) -> Result<ObservedExit> {
        self.admit_registered_selector(session)?;
        let lease = self.selected_activation(session)?;
        let before = self
            .snapshot()?
            .ok_or_else(|| refused("No selected supervised generation"))?;
        require(
            before.selection() == lease.selection(),
            "Supervised selection changed",
        )?;
        let root_path = self
            .root
            .join("generations")
            .join(&before.selection().generation)
            .join("AppDir")
            .join(crate::ENTRYPOINT);
        let (root_image, _) = disk::hold_regular(&root_path, MAX_FILE, true)?;
        let (channel, inherited) = match Channel::pair() {
            Ok(value) => value,
            // No child has been started, so this is ordinary guarded activation,
            // not a failed process launch followed by a blind retry.
            Err(_) => return wait_unarmed(lease.spawn(session)?, true),
        };
        let child_fd = inherited.fd();
        let mut command = lease.command(session);
        command.env(CHANNEL_MARKER, "1");
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(child_fd, CHILD_FD) < 0 || libc::fcntl(CHILD_FD, libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        lease.revalidate()?;
        let mut child = command
            .spawn()
            .map_err(|_| refused("Supervised signed AppRun could not start"))?;
        drop(inherited);
        drop(lease);
        let child_birth = match birth(child.id() as i32) {
            Ok(value) => value,
            Err(_) => return wait_without_restart(child, channel),
        };
        let hello = Frame {
            kind: Kind::Hello,
            target: target_of(&before),
        };
        if channel.send(&hello).is_err() {
            return wait_without_restart(child, channel);
        }
        let start = Instant::now();
        let mut machine = Machine::new();
        let mut root: Option<Process> = None;
        let mut eof = false;
        loop {
            if machine.expired(start.elapsed()) {
                return wait_disarmed(child, channel, &mut machine);
            }
            if !eof {
                let received = match channel.receive() {
                    Ok(value) => value,
                    Err(_) => return wait_disarmed(child, channel, &mut machine),
                };
                match received {
                    Received::Packet(frame, credentials) => {
                        let valid: Result<()> = (|| {
                            selector.live()?;
                            self.admit_registered_selector(session)?;
                            require(
                                credentials.pid == child_birth.pid,
                                "AppRun did not exec Root in its owned child PID",
                            )?;
                            let current = Process::capture(credentials.pid)?;
                            require(
                                current.birth == child_birth
                                    && current.birth.parent == selector.birth.pid
                                    && super::super::host::same_file(&current.image, &root_image)?,
                                "AppRun/Root PID, start, parent or signed image differs",
                            )?;
                            current.check(credentials)?;
                            if let Some(admitted) = &root {
                                admitted.check(credentials)?;
                            } else {
                                root = Some(current);
                            }
                            if matches!(frame.kind, Kind::Prepare | Kind::Arm | Kind::ExitIntent) {
                                self.check_restart_target(
                                    &before,
                                    &frame.target,
                                    &production_verify,
                                )?;
                            }
                            let reply = machine.accept(
                                frame.kind,
                                frame.target.clone(),
                                &hello.target,
                                start.elapsed(),
                            )?;
                            if let Some(kind) = reply {
                                channel.send(&Frame {
                                    kind,
                                    target: frame.target,
                                })?;
                            }
                            Ok(())
                        })();
                        if valid.is_err() || matches!(machine.phase, Phase::Disarmed) {
                            return wait_disarmed(child, channel, &mut machine);
                        }
                    }
                    Received::Closed => {
                        // Only explicit exit authorization makes closure expected.
                        // EOF itself is never an exit result or commit trigger.
                        if !matches!(machine.phase, Phase::Exiting(_, _)) {
                            return wait_disarmed(child, channel, &mut machine);
                        }
                        eof = true;
                    }
                    Received::Pending => {}
                }
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| refused("Cannot observe owned Root exit; no selection attempted"))?
            {
                // Reject late queued control packets; never interpret their PID
                // using /proc after the owned child was reaped.
                if !eof && !matches!(channel.receive(), Ok(Received::Pending | Received::Closed)) {
                    return Ok(ObservedExit::Unarmed(status, true));
                }
                if root.is_some() {
                    if let Some(target) = machine.exited(status.code(), start.elapsed()) {
                        return Ok(ObservedExit::Approved(before, target));
                    }
                }
                return Ok(ObservedExit::Unarmed(status, false));
            }
            if eof {
                std::thread::sleep(Duration::from_millis(25));
            } else {
                channel.poll(Instant::now() + Duration::from_millis(100));
            }
        }
    }
}

fn target_of(snapshot: &SelectionSnapshot) -> Target {
    Target {
        generation: snapshot.selection().generation.clone(),
        version: snapshot.selection().version.clone(),
    }
}

fn wait_unarmed(mut child: Child, unavailable: bool) -> Result<ObservedExit> {
    child
        .wait()
        .map(|status| ObservedExit::Unarmed(status, unavailable))
        .map_err(|_| refused("Cannot observe unsupervised exit; no selection attempted"))
}

fn wait_without_restart(child: Child, channel: Channel) -> Result<ObservedExit> {
    channel.shutdown();
    drop(channel);
    wait_unarmed(child, true)
}

fn wait_disarmed(child: Child, channel: Channel, machine: &mut Machine) -> Result<ObservedExit> {
    machine.disarm();
    // Publish disarm as observable EOF BEFORE waiting for an ordinary app exit.
    // Otherwise a still-running Root cannot resolve its retained abort authority.
    wait_without_restart(child, channel)
}

#[cfg(test)]
#[path = "restart_linux_tests.rs"]
mod tests;
