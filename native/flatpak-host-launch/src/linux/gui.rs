//! Production channel admission only. Payloads require the Core's finite decoder.
use super::{
    gui_install::Installation,
    identity,
    launch::{self, OwnedLaunch},
    transport, Result,
};
use crate::{
    gui_protocol::{self as wire, Assembly, Kind, Requests, Wire, MAX_ID, PACKET},
    GuiError, GuiMessage, GuiRequest,
};
use std::{
    os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const EXCHANGE: Duration = Duration::from_secs(30);
const REQUEST_LIMIT: usize = 64 * 1024;
static INHERITED_ADOPTED: AtomicBool = AtomicBool::new(false);

fn bounded_deadline(deadline: Instant) -> Result<()> {
    if deadline.saturating_duration_since(Instant::now()) > EXCHANGE {
        return Err("gui-deadline-bound");
    }
    Ok(())
}
fn error(reason: &'static str, unknown: bool) -> GuiError {
    GuiError {
        reason,
        owned_child_reaped: false,
        outcome_unknown: unknown,
    }
}

pub struct GuiSession {
    owned: OwnedLaunch,
    installed: Installation,
    owner: (u32, u64),
    sender: Option<(u32, u64)>,
    instance: String,
    last: Option<transport::Message<PACKET>>,
    session: [u8; 32],
    requests: Requests,
    event: u64,
    closed: bool,
}

impl GuiSession {
    pub fn launch_installed() -> std::result::Result<Self, GuiError> {
        let deadline = Instant::now() + EXCHANGE;
        let installed = Installation::inspect(deadline).map_err(|r| error(r, false))?;
        let (host, peer) = transport::pair().map_err(|r| error(r, false))?;
        let mut pipe = [-1; 2];
        if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
            return Err(error("gui-instance-pipe", false));
        }
        let reader = unsafe { OwnedFd::from_raw_fd(pipe[0]) };
        let writer = unsafe { OwnedFd::from_raw_fd(pipe[1]) };
        let mut command = installed.command().map_err(|r| error(r, false))?;
        let child =
            launch::spawn(&mut command, &peer, Some(&writer)).map_err(|r| error(r, false))?;
        let mut owned = OwnedLaunch {
            socket: Some(host),
            child,
            cleaned: false,
            reaped: false,
        };
        drop(peer);
        drop(writer);
        let ready = (|| -> Result<_> {
            let p = identity::process(owned.child.id(), installed.uid)?;
            Ok((
                (owned.child.id(), p.start),
                launch::read_instance(&reader, deadline)?,
            ))
        })();
        let (owner, instance) = ready.map_err(|r| GuiError {
            reason: r,
            owned_child_reaped: owned.cleanup(),
            outcome_unknown: false,
        })?;
        let mut result = Self {
            owned,
            installed,
            owner,
            sender: None,
            instance,
            last: None,
            session: [0; 32],
            requests: Requests::default(),
            event: 0,
            closed: false,
        };
        let handshake = (|| -> Result<()> {
            let ready = result.read(deadline)?.ok_or("gui-ready-deadline")?;
            wire::exact(&ready, Kind::Ready, 0, [0; 32])?;
            result.session = launch::nonce()?;
            result.write(Kind::Challenge, 0, &[], deadline)?;
            let accepted = result.read(deadline)?.ok_or("gui-handshake-deadline")?;
            wire::exact(&accepted, Kind::Accepted, 0, result.session)
        })();
        handshake.map_err(|r| result.fail(r))?;
        Ok(result)
    }

    fn checked(
        &self,
        message: &transport::Message<PACKET>,
        deadline: Instant,
    ) -> Result<(u32, u64)> {
        self.installed.recheck_os()?;
        let sender = identity::sender(message, self.sender, self.owner, self.installed.uid)?;
        identity::deployment_image(
            message,
            &identity::Deployment {
                app_path: &self.installed.app_path,
                runtime_path: &self.installed.runtime_path,
                executable_directory: "bin",
                executable: "creator-hub",
                executable_hash: self.installed.hash,
                app_commit: &self.installed.app_commit,
                runtime_commit: &self.installed.runtime_commit,
                instance: &self.instance,
                sandbox: identity::Sandbox::Gui(
                    self.installed
                        .image
                        .as_ref()
                        .ok_or("gui-image-pin-required")?,
                ),
            },
            self.installed.uid,
            deadline,
        )?;
        Ok(sender)
    }
    fn check(&self, deadline: Instant) -> Result<()> {
        if self.closed {
            return Err("gui-session-closed");
        }
        self.checked(
            self.last.as_ref().ok_or("gui-no-verified-sender")?,
            deadline,
        )?;
        Ok(())
    }
    fn fail(&mut self, reason: &'static str) -> GuiError {
        self.closed = true;
        GuiError {
            reason,
            owned_child_reaped: self.owned.cleanup(),
            outcome_unknown: !self.requests.pending.is_empty(),
        }
    }
    fn read(&mut self, idle: Instant) -> Result<Option<Wire>> {
        bounded_deadline(idle)?;
        let mut assembly = Assembly::default();
        let mut first = true;
        let mut deadline = idle;
        loop {
            let received = transport::receive_bounded::<PACKET>(self.owned.socket()?, deadline);
            let (message, count) = match received {
                Err("deadline") if first => return Ok(None),
                other => other?,
            };
            if first {
                deadline = Instant::now() + EXCHANGE;
                first = false;
            }
            self.sender = Some(self.checked(&message, deadline)?);
            let result = assembly.push(&message.bytes[..count])?;
            self.last = Some(message);
            if let Some(result) = result {
                return Ok(Some(result));
            }
        }
    }
    fn write(&mut self, kind: Kind, id: u64, payload: &[u8], deadline: Instant) -> Result<()> {
        bounded_deadline(deadline)?;
        for frame in wire::frames(kind, id, self.session, payload)? {
            self.check(deadline)?;
            transport::send_bytes(self.owned.socket()?, &frame, deadline)?;
        }
        Ok(())
    }
    pub fn revalidate(&mut self) -> std::result::Result<(), GuiError> {
        self.check(Instant::now() + EXCHANGE)
            .map_err(|r| self.fail(r))
    }
    /// Idle expiry does not invalidate a lease. Once a packet arrives, incomplete
    /// assembly has a fresh, finite exchange budget and cannot be retried.
    pub fn poll_request(
        &mut self,
        deadline: Instant,
    ) -> std::result::Result<Option<GuiRequest>, GuiError> {
        let result = (|| -> Result<_> {
            if self.closed {
                return Err("gui-session-closed");
            }
            let Some(message) = self.read(deadline)? else {
                self.check(Instant::now() + EXCHANGE)?;
                return Ok(None);
            };
            if message.kind != Kind::Request
                || message.session != self.session
                || message.body.is_empty()
                || message.body.len() > REQUEST_LIMIT
            {
                return Err("gui-request-shape");
            }
            self.requests.add(message.id)?;
            Ok(Some(GuiRequest {
                id: message.id,
                body: message.body,
                session: self.session,
            }))
        })();
        result.map_err(|r| self.fail(r))
    }
    pub fn send_response(
        &mut self,
        request: GuiRequest,
        payload: &[u8],
        deadline: Instant,
    ) -> std::result::Result<(), GuiError> {
        let result = (|| -> Result<()> {
            if request.session != self.session || !self.requests.pending.contains(&request.id) {
                return Err("gui-foreign-response-token");
            }
            if payload.is_empty() {
                return Err("gui-empty-response");
            }
            self.write(Kind::Response, request.id, payload, deadline)?;
            self.requests.complete(request.id)
        })();
        result.map_err(|r| self.fail(r))
    }
    pub fn send_event(
        &mut self,
        payload: &[u8],
        deadline: Instant,
    ) -> std::result::Result<(), GuiError> {
        let result = (|| -> Result<()> {
            let next = self
                .event
                .checked_add(1)
                .filter(|n| *n <= MAX_ID)
                .ok_or("gui-event-id-exhausted")?;
            if payload.is_empty() {
                return Err("gui-empty-event");
            }
            self.write(Kind::Event, next, payload, deadline)?;
            self.event = next;
            Ok(())
        })();
        result.map_err(|r| self.fail(r))
    }
    /// Refuses to close over unacknowledged work; the Core owns backend draining.
    pub fn finish(mut self, deadline: Instant) -> std::result::Result<(), GuiError> {
        let result = (|| -> Result<()> {
            if !self.requests.pending.is_empty() {
                return Err("gui-pending-outcome-unknown");
            }
            self.write(Kind::Close, 0, &[], deadline)?;
            let closed = self.read(deadline)?.ok_or("gui-close-deadline")?;
            wire::exact(&closed, Kind::Closed, 0, self.session)?;
            self.write(Kind::Release, 0, &[], deadline)?;
            if !launch::reap(&mut self.owned.child, deadline)
                .ok_or("gui-owned-exit-deadline")?
                .success()
            {
                return Err("gui-owned-exit-nonzero");
            }
            if !self.owned.cleanup() {
                return Err("gui-owned-exit-unreaped");
            }
            self.closed = true;
            Ok(())
        })();
        result.map_err(|r| self.fail(r))
    }
}

/// GUI-side endpoint. Adopt before WebKit/other children start, then keep it on
/// one I/O thread. The inherited channel is not a publisher-signature assertion.
pub struct GuiPeer {
    socket: Option<OwnedFd>,
    session: [u8; 32],
    requests: Requests,
    event: u64,
    host: Option<OwnedFd>,
    uid: u32,
}
impl GuiPeer {
    pub fn from_inherited() -> std::result::Result<Self, GuiError> {
        // This is the sole production adoption path; no public FD constructor.
        if INHERITED_ADOPTED.swap(true, Ordering::AcqRel) {
            return Err(error("gui-inherited-fd-already-adopted", false));
        }
        let flags = unsafe { libc::fcntl(3, libc::F_GETFD) };
        if flags < 0 {
            return Err(error("gui-inherited-fd-required", false));
        }
        // A normal Root launch may already have some other file at FD 3. Do not
        // take ownership or close it unless it is the private socket shape.
        let borrowed = unsafe { BorrowedFd::borrow_raw(3) };
        transport::validate(&borrowed).map_err(|r| error(r, false))?;
        let mut name: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of_val(&name) as libc::socklen_t;
        if unsafe { libc::getpeername(3, (&mut name as *mut libc::sockaddr_un).cast(), &mut len) }
            != 0
            || len as usize != std::mem::size_of::<libc::sa_family_t>()
        {
            return Err(error("gui-private-socket-required", false));
        }
        let socket = unsafe { OwnedFd::from_raw_fd(3) };
        let mut result = Self {
            socket: Some(socket),
            session: [0; 32],
            requests: Requests::default(),
            event: 0,
            host: None,
            uid: identity::uid().map_err(|r| error(r, false))?,
        };
        let handshake = (|| -> Result<()> {
            let fd = result.socket()?;
            transport::validate(fd)?;
            if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0
            {
                return Err("gui-cloexec");
            }
            let status = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
            if status < 0
                || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, status | libc::O_NONBLOCK) }
                    < 0
            {
                return Err("gui-nonblock");
            }
            transport::enable_credentials(fd)?;
            let deadline = Instant::now() + EXCHANGE;
            result.write(Kind::Ready, 0, &[], deadline)?;
            let challenge = result.read(deadline)?.ok_or("gui-challenge-deadline")?;
            if challenge.session == [0; 32] {
                return Err("gui-empty-session");
            }
            wire::exact(&challenge, Kind::Challenge, 0, challenge.session)?;
            result.session = challenge.session;
            result.write(Kind::Accepted, 0, &[], deadline)
        })();
        handshake.map_err(|r| result.fail(r))?;
        Ok(result)
    }
    fn socket(&self) -> Result<&OwnedFd> {
        self.socket.as_ref().ok_or("gui-session-closed")
    }
    fn fail(&mut self, reason: &'static str) -> GuiError {
        drop(self.socket.take());
        error(reason, !self.requests.pending.is_empty())
    }
    fn write(&self, kind: Kind, id: u64, body: &[u8], deadline: Instant) -> Result<()> {
        bounded_deadline(deadline)?;
        if let Some(host) = &self.host {
            transport::alive(host)?;
        }
        for frame in wire::frames(kind, id, self.session, body)? {
            transport::send_bytes(self.socket()?, &frame, deadline)?;
        }
        Ok(())
    }
    fn read(&mut self, idle: Instant) -> Result<Option<Wire>> {
        bounded_deadline(idle)?;
        let mut assembly = Assembly::default();
        let mut first = true;
        let mut deadline = idle;
        loop {
            let received = transport::receive_bounded::<PACKET>(self.socket()?, deadline);
            let (message, count) = match received {
                Err("deadline") if first => return Ok(None),
                other => other?,
            };
            if first {
                first = false;
                deadline = Instant::now() + EXCHANGE;
            }
            if message.credentials.uid != self.uid {
                return Err("gui-host-uid");
            }
            transport::alive(&message.pidfd)?;
            let result = assembly.push(&message.bytes[..count])?;
            self.host = Some(message.pidfd);
            if let Some(result) = result {
                return Ok(Some(result));
            }
        }
    }
    pub fn send_request(
        &mut self,
        payload: &[u8],
        deadline: Instant,
    ) -> std::result::Result<u64, GuiError> {
        let result = (|| -> Result<u64> {
            if payload.is_empty() || payload.len() > REQUEST_LIMIT {
                return Err("gui-request-size");
            }
            let next = self
                .requests
                .last
                .checked_add(1)
                .ok_or("gui-request-id-exhausted")?;
            self.requests.add(next)?;
            self.write(Kind::Request, next, payload, deadline)?;
            Ok(next)
        })();
        result.map_err(|r| self.fail(r))
    }
    pub fn poll_message(
        &mut self,
        deadline: Instant,
    ) -> std::result::Result<Option<GuiMessage>, GuiError> {
        let result = (|| -> Result<_> {
            let Some(message) = self.read(deadline)? else {
                return Ok(None);
            };
            if message.session != self.session {
                return Err("gui-response-session");
            }
            match message.kind {
                Kind::Response if !message.body.is_empty() => {
                    self.requests.complete(message.id)?;
                    Ok(Some(GuiMessage::Response {
                        id: message.id,
                        payload: message.body,
                    }))
                }
                Kind::Event if !message.body.is_empty() => {
                    if message.id
                        != self
                            .event
                            .checked_add(1)
                            .filter(|id| *id <= MAX_ID)
                            .ok_or("gui-event-id-exhausted")?
                    {
                        return Err("gui-event-order");
                    }
                    self.event = message.id;
                    Ok(Some(GuiMessage::Event {
                        payload: message.body,
                    }))
                }
                Kind::Close => {
                    wire::exact(&message, Kind::Close, 0, self.session)?;
                    if !self.requests.pending.is_empty() {
                        return Err("gui-pending-outcome-unknown");
                    }
                    let end = Instant::now() + EXCHANGE;
                    self.write(Kind::Closed, 0, &[], end)?;
                    let release = self.read(end)?.ok_or("gui-release-deadline")?;
                    wire::exact(&release, Kind::Release, 0, self.session)?;
                    drop(self.socket.take());
                    Ok(Some(GuiMessage::Closed))
                }
                _ => Err("gui-response-order-or-shape"),
            }
        })();
        result.map_err(|r| self.fail(r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deadlines_are_per_exchange_not_a_lease_expiration() {
        assert!(bounded_deadline(Instant::now()).is_ok());
        assert!(bounded_deadline(Instant::now() + Duration::from_secs(31)).is_err());
    }
}
