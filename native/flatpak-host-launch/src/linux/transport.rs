use super::Result;
use crate::protocol::SIZE;
use std::{
    mem,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    time::Instant,
};

// Linux x86_64 UAPI. setsockopt probes actual support; there is no PID-only fallback.
const SO_PASSPIDFD: libc::c_int = 76;
const SCM_PIDFD: libc::c_int = 4;

pub(crate) struct Message<const N: usize = SIZE> {
    pub bytes: [u8; N],
    pub credentials: libc::ucred,
    pub pidfd: OwnedFd,
}

pub(crate) fn pair() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [-1; 2];
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    } != 0
    {
        return Err("socketpair");
    }
    let host = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let child = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    enable_credentials(&host)?;
    Ok((host, child))
}

pub(crate) fn enable_credentials(fd: &OwnedFd) -> Result<()> {
    let enabled: libc::c_int = 1;
    for option in [libc::SO_PASSCRED, SO_PASSPIDFD] {
        if unsafe {
            libc::setsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                option,
                (&enabled as *const libc::c_int).cast(),
                mem::size_of_val(&enabled) as _,
            )
        } != 0
        {
            return Err("unsupported-kernel-pidfd-credentials");
        }
    }
    Ok(())
}

pub(crate) fn validate(fd: &impl AsRawFd) -> Result<()> {
    for (option, expected) in [
        (libc::SO_TYPE, libc::SOCK_SEQPACKET),
        (libc::SO_DOMAIN, libc::AF_UNIX),
    ] {
        let mut value: libc::c_int = 0;
        let mut len = mem::size_of_val(&value) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                option,
                (&mut value as *mut libc::c_int).cast(),
                &mut len,
            )
        } != 0
            || value != expected
        {
            return Err("not-private-seqpacket");
        }
    }
    Ok(())
}

pub(crate) fn wait(fd: &OwnedFd, events: i16, deadline: Instant) -> Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("deadline")?;
        let timeout = remaining.as_millis().clamp(1, 250) as i32;
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events,
            revents: 0,
        };
        let rc = unsafe { libc::poll(&mut poll, 1, timeout) };
        if rc < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err("poll");
        }
        if rc > 0 {
            if poll.revents & events != 0 {
                return Ok(());
            }
            return Err("endpoint-closed");
        }
    }
}

pub(crate) fn send(fd: &OwnedFd, bytes: &[u8; SIZE], deadline: Instant) -> Result<()> {
    send_bytes(fd, bytes, deadline)
}

pub(crate) fn send_bytes(fd: &OwnedFd, bytes: &[u8], deadline: Instant) -> Result<()> {
    wait(fd, libc::POLLOUT, deadline)?;
    if unsafe {
        libc::send(
            fd.as_raw_fd(),
            bytes.as_ptr().cast(),
            bytes.len(),
            libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
        )
    } != bytes.len() as isize
    {
        return Err("send");
    }
    Ok(())
}

pub(crate) fn receive_plain(fd: &OwnedFd, deadline: Instant) -> Result<[u8; SIZE]> {
    wait(fd, libc::POLLIN, deadline)?;
    let mut bytes = [0; SIZE];
    if unsafe {
        libc::recv(
            fd.as_raw_fd(),
            bytes.as_mut_ptr().cast(),
            SIZE,
            libc::MSG_TRUNC | libc::MSG_DONTWAIT,
        )
    } != SIZE as isize
    {
        return Err("packet-size");
    }
    Ok(bytes)
}

pub(crate) fn receive(fd: &OwnedFd, deadline: Instant) -> Result<Message> {
    let (message, count) = receive_bounded::<SIZE>(fd, deadline)?;
    if count != SIZE {
        return Err("ancillary-or-packet-refused");
    }
    Ok(message)
}

pub(crate) fn receive_bounded<const N: usize>(
    fd: &OwnedFd,
    deadline: Instant,
) -> Result<(Message<N>, usize)> {
    wait(fd, libc::POLLIN, deadline)?;
    let mut bytes = [0; N];
    let mut control = [0usize; 64];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: N,
    };
    let mut msg: libc::msghdr = unsafe { mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = mem::size_of_val(&control);
    let count = unsafe {
        libc::recvmsg(
            fd.as_raw_fd(),
            &mut msg,
            libc::MSG_CMSG_CLOEXEC | libc::MSG_DONTWAIT,
        )
    };
    if count < 0 {
        return Err("recvmsg");
    }
    let mut credentials = None;
    let mut pidfd = None;
    let mut bad = count <= 0
        || count > N as isize
        || msg.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0;
    // Always adopt/close received FDs, including on truncated or forbidden messages.
    let mut h = unsafe { libc::CMSG_FIRSTHDR(&msg) };
    while !h.is_null() {
        let header = unsafe { &*h };
        let base = unsafe { libc::CMSG_LEN(0) } as usize;
        if header.cmsg_len < base {
            return Err("ancillary-header");
        }
        let len = header.cmsg_len - base;
        let data = unsafe { libc::CMSG_DATA(h) };
        match (header.cmsg_level, header.cmsg_type) {
            (libc::SOL_SOCKET, libc::SCM_CREDENTIALS) if len == mem::size_of::<libc::ucred>() => {
                if credentials.is_some() {
                    bad = true;
                }
                credentials = Some(unsafe { std::ptr::read_unaligned(data.cast::<libc::ucred>()) });
            }
            (libc::SOL_SOCKET, SCM_PIDFD | libc::SCM_RIGHTS) => {
                if !len.is_multiple_of(mem::size_of::<libc::c_int>()) {
                    bad = true;
                }
                for offset in (0..len / mem::size_of::<libc::c_int>())
                    .map(|i| i * mem::size_of::<libc::c_int>())
                {
                    let raw =
                        unsafe { std::ptr::read_unaligned(data.add(offset).cast::<libc::c_int>()) };
                    if raw < 0 {
                        bad = true;
                        continue;
                    }
                    let owned = unsafe { OwnedFd::from_raw_fd(raw) };
                    if header.cmsg_type == SCM_PIDFD
                        && len == mem::size_of::<libc::c_int>()
                        && pidfd.is_none()
                    {
                        pidfd = Some(owned);
                    } else {
                        bad = true;
                    }
                }
            }
            _ => bad = true,
        }
        h = unsafe { libc::CMSG_NXTHDR(&msg, h) };
    }
    if bad {
        return Err("ancillary-or-packet-refused");
    }
    Ok((
        Message {
            bytes,
            credentials: credentials.ok_or("missing-credentials")?,
            pidfd: pidfd.ok_or("missing-sender-pidfd")?,
        },
        count as usize,
    ))
}

pub(crate) fn alive(pidfd: &OwnedFd) -> Result<()> {
    let mut p = libc::pollfd {
        fd: pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    if unsafe { libc::poll(&mut p, 1, 0) } != 0 {
        return Err("sender-exited");
    }
    Ok(())
}

#[cfg(test)]
#[path = "transport/tests.rs"]
mod tests;
