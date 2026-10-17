use super::*;
use crate::{
    linux::identity,
    protocol::{self, Kind},
};
use std::time::Duration;

fn admit() {
    assert_eq!(
        std::env::var("CREATOR_FLATPAK_LAUNCH_KERNEL_TEST").as_deref(),
        Ok("1")
    );
    assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    assert_eq!(
        std::env::var("RUNNER_ENVIRONMENT").as_deref(),
        Ok("github-hosted")
    );
    assert_eq!(
        std::env::var("GITHUB_REPOSITORY").as_deref(),
        Ok("BOBWORKS-XR/CREATOR-HUB")
    );
    assert_ne!(unsafe { libc::getuid() }, 0);
}

struct Fork(libc::pid_t);

impl Fork {
    fn finish(mut self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut status = 0;
            let rc = unsafe { libc::waitpid(self.0, &mut status, libc::WNOHANG) };
            if rc == self.0 {
                self.0 = 0;
                assert!(libc::WIFEXITED(status));
                assert_eq!(libc::WEXITSTATUS(status), 0);
                return;
            }
            assert_eq!(rc, 0);
            assert!(Instant::now() < deadline, "owned test child did not exit");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Fork {
    fn drop(&mut self) {
        if self.0 <= 0 {
            return;
        }
        // Only this unreaped direct fork is signalled, never a process group.
        unsafe {
            libc::kill(self.0, libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if unsafe { libc::waitpid(self.0, std::ptr::null_mut(), libc::WNOHANG) } != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[test]
#[ignore = "parent-coordinated disposable Linux; run with --test-threads=1"]
fn kernel_credentials_name_the_actual_writer_not_socketpair_creator() {
    admit();
    let (host, peer) = pair().expect("Linux SO_PASSPIDFD support is required; no fallback");
    let creator = unsafe { libc::getpid() };
    let mut old: libc::ucred = unsafe { mem::zeroed() };
    let mut len = mem::size_of_val(&old) as libc::socklen_t;
    assert_eq!(
        unsafe {
            libc::getsockopt(
                host.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut old as *mut libc::ucred).cast(),
                &mut len,
            )
        },
        0
    );
    assert_eq!(old.pid, creator);
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        let deadline = Instant::now() + Duration::from_secs(2);
        let ok = send(&peer, &protocol::packet(Kind::Ready, [0; 32]), deadline).is_ok()
            && receive_plain(&peer, deadline).is_ok();
        unsafe {
            libc::_exit(if ok { 0 } else { 90 });
        }
    }
    let child = Fork(pid);
    let deadline = Instant::now() + Duration::from_secs(2);
    let message = receive(&host, deadline).unwrap();
    assert_eq!(message.credentials.pid, pid);
    assert_ne!(message.credentials.pid, old.pid);
    assert_eq!(message.credentials.uid, unsafe { libc::getuid() });
    alive(&message.pidfd).unwrap();
    send(&host, &protocol::packet(Kind::Release, [0; 32]), deadline).unwrap();
    child.finish();
    assert_eq!(alive(&message.pidfd), Err("sender-exited"));
}

#[test]
#[ignore = "parent-coordinated disposable Linux; run with --test-threads=1"]
fn kernel_sender_must_descend_from_the_retained_owned_child() {
    admit();
    let uid = identity::uid().unwrap();
    let (host, peer) = pair().unwrap();
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        let writer = unsafe { libc::fork() };
        if writer < 0 {
            unsafe {
                libc::_exit(91);
            }
        }
        if writer == 0 {
            let deadline = Instant::now() + Duration::from_secs(2);
            let ok = send(&peer, &protocol::packet(Kind::Ready, [0; 32]), deadline).is_ok()
                && receive_plain(&peer, deadline).is_ok();
            unsafe {
                libc::_exit(if ok { 0 } else { 92 });
            }
        }
        let mut status = 0;
        let rc = unsafe { libc::waitpid(writer, &mut status, 0) };
        unsafe {
            libc::_exit(
                if rc == writer && libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
                    0
                } else {
                    93
                },
            );
        }
    }
    let child = Fork(pid);
    let owner = identity::process(pid as u32, uid).unwrap();
    let owner = (pid as u32, owner.start);
    let deadline = Instant::now() + Duration::from_secs(2);
    let message = receive(&host, deadline).unwrap();
    let actual = identity::sender(&message, None, owner, uid).unwrap();
    assert_ne!(actual.0, pid as u32);
    assert_eq!(
        identity::sender(&message, Some((actual.0, actual.1 + 1)), owner, uid),
        Err("sender-changed")
    );
    assert_eq!(
        identity::sender(&message, None, (owner.0, owner.1 + 1), uid),
        Err("foreign-launch-tree")
    );
    assert!(identity::sender(&message, None, owner, uid + 1).is_err());
    send(&host, &protocol::packet(Kind::Release, [0; 32]), deadline).unwrap();
    child.finish();
}

#[test]
#[ignore = "parent-coordinated disposable Linux; run with --test-threads=1"]
fn kernel_rights_are_refused_without_leaking_received_descriptors() {
    admit();
    let (host, peer) = pair().unwrap();
    let count = || std::fs::read_dir("/proc/self/fd").unwrap().count();
    let before = count();
    let mut bytes = protocol::packet(Kind::Ready, [0; 32]);
    let mut control = [0usize; 8];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: SIZE,
    };
    let mut msg: libc::msghdr = unsafe { mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<libc::c_int>() as _) } as usize;
    unsafe {
        let h = libc::CMSG_FIRSTHDR(&msg);
        (*h).cmsg_level = libc::SOL_SOCKET;
        (*h).cmsg_type = libc::SCM_RIGHTS;
        (*h).cmsg_len = libc::CMSG_LEN(mem::size_of::<libc::c_int>() as _) as usize;
        std::ptr::write_unaligned(libc::CMSG_DATA(h).cast::<libc::c_int>(), peer.as_raw_fd());
    }
    assert_eq!(
        unsafe { libc::sendmsg(peer.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) },
        SIZE as isize
    );
    assert!(receive(&host, Instant::now() + Duration::from_secs(1)).is_err());
    assert_eq!(count(), before);
}

#[test]
#[ignore = "parent-coordinated disposable Linux; run with --test-threads=1"]
fn kernel_oversize_missing_credentials_and_timeout_refuse() {
    admit();
    let (host, peer) = pair().unwrap();
    let bytes = [0u8; SIZE + 1];
    assert_eq!(
        unsafe {
            libc::send(
                peer.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                libc::MSG_NOSIGNAL,
            )
        },
        bytes.len() as isize
    );
    assert!(receive(&host, Instant::now() + Duration::from_secs(1)).is_err());
    let disabled: libc::c_int = 0;
    for option in [libc::SO_PASSCRED, SO_PASSPIDFD] {
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    host.as_raw_fd(),
                    libc::SOL_SOCKET,
                    option,
                    (&disabled as *const libc::c_int).cast(),
                    mem::size_of_val(&disabled) as _,
                )
            },
            0
        );
    }
    send(
        &peer,
        &protocol::packet(Kind::Ready, [0; 32]),
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    assert!(receive(&host, Instant::now() + Duration::from_secs(1)).is_err());
    let start = Instant::now();
    assert!(receive(&host, start + Duration::from_millis(30)).is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
}
