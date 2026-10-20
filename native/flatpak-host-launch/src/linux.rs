#[path = "linux/gui.rs"]
pub(crate) mod gui;
#[path = "linux/gui_install.rs"]
mod gui_install;
#[path = "linux/identity.rs"]
pub(crate) mod identity;
#[path = "linux/launch.rs"]
pub(crate) mod launch;
#[path = "linux/transport.rs"]
pub(crate) mod transport;

use crate::protocol::{self, Kind};
use std::{
    os::fd::FromRawFd,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, &'static str>;

pub(crate) fn echo() -> bool {
    if unsafe { libc::fcntl(3, libc::F_GETFD) } < 0 {
        return false;
    }
    let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(3) };
    let deadline = Instant::now() + Duration::from_secs(30);
    let exchange = || -> Result<()> {
        transport::validate(&fd)?;
        // Prevent the endpoint from leaking through any later exec.
        use std::os::fd::AsRawFd;
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err("echo-cloexec");
        }
        transport::send(&fd, &protocol::packet(Kind::Ready, [0; 32]), deadline)?;
        let challenge = transport::receive_plain(&fd, deadline)?;
        let mut nonce = [0; 32];
        nonce.copy_from_slice(&challenge[16..]);
        if !protocol::matches(&challenge, Kind::Challenge, nonce) || nonce == [0; 32] {
            return Err("echo-challenge");
        }
        transport::send(&fd, &protocol::packet(Kind::Echo, nonce), deadline)?;
        if !protocol::matches(
            &transport::receive_plain(&fd, deadline)?,
            Kind::Close,
            nonce,
        ) {
            return Err("echo-close");
        }
        transport::send(&fd, &protocol::packet(Kind::Closed, nonce), deadline)?;
        if !protocol::matches(
            &transport::receive_plain(&fd, deadline)?,
            Kind::Release,
            nonce,
        ) {
            return Err("echo-release");
        }
        Ok(())
    };
    exchange().is_ok()
}
