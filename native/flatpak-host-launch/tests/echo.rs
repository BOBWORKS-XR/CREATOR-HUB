#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

// A real child binary and transport, without a Flatpak install or settings reads.
#[path = "../src/gui_protocol.rs"]
#[allow(dead_code)]
mod gui_protocol;
#[path = "../src/linux.rs"]
#[allow(dead_code)]
mod linux;
#[path = "../src/protocol.rs"]
mod protocol;
use gui_protocol::{GuiMessage, GuiRequest};

// Same private error projection as EchoFailure below, not a session constructor.
#[derive(Debug)]
#[allow(dead_code)] // GUI error projection is compiled here; this harness exercises echo only.
struct GuiError {
    reason: &'static str,
    owned_child_reaped: bool,
    outcome_unknown: bool,
}

use std::{
    process::Command,
    time::{Duration, Instant},
};

// Error projection for the source-included modules in this isolated test crate;
// this is not a constructor for a live session or a replacement proof path.
#[derive(Debug)]
struct EchoFailure {
    reason: &'static str,
    owned_child_reaped: bool,
}

impl EchoFailure {
    fn reason(&self) -> &'static str {
        self.reason
    }

    fn owned_child_reaped(&self) -> bool {
        self.owned_child_reaped
    }
}

#[test]
#[ignore = "parent-coordinated disposable Linux kernel execution only"]
fn native_echo_binary_inherits_fd3_completes_protocol_and_exits() {
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
    let (host, peer) = linux::transport::pair().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_creator-hub-flatpak-launch-echo"));
    command.arg("echo-v1").env_clear();
    let mut child = linux::launch::spawn(&mut command, &peer, None).unwrap();
    drop(peer);
    let deadline = Instant::now() + Duration::from_secs(3);
    let proof = (|| -> Result<(), &'static str> {
        let ready = linux::transport::receive(&host, deadline)?;
        if ready.credentials.pid as u32 != child.id()
            || !protocol::matches(&ready.bytes, protocol::Kind::Ready, [0; 32])
        {
            return Err("ready-writer-or-frame");
        }
        let nonce = [29; 32];
        linux::transport::send(
            &host,
            &protocol::packet(protocol::Kind::Challenge, nonce),
            deadline,
        )?;
        let echo = linux::transport::receive(&host, deadline)?;
        if echo.credentials.pid as u32 != child.id()
            || !protocol::matches(&echo.bytes, protocol::Kind::Echo, nonce)
        {
            return Err("echo-writer-or-frame");
        }
        linux::transport::send(
            &host,
            &protocol::packet(protocol::Kind::Close, nonce),
            deadline,
        )?;
        let closed = linux::transport::receive(&host, deadline)?;
        if closed.credentials.pid as u32 != child.id()
            || !protocol::matches(&closed.bytes, protocol::Kind::Closed, nonce)
        {
            return Err("closed-writer-or-frame");
        }
        linux::transport::send(
            &host,
            &protocol::packet(protocol::Kind::Release, nonce),
            deadline,
        )?;
        Ok(())
    })();
    drop(host);
    if proof.is_err() {
        let _ = child.kill();
    }
    let status = linux::launch::reap(&mut child, Instant::now() + Duration::from_secs(2));
    if status.is_none() {
        let _ = child.kill();
        let _ = linux::launch::reap(&mut child, Instant::now() + Duration::from_secs(2));
    }
    proof.unwrap();
    assert!(status.expect("owned echo not reaped").success());
}

// linux.rs is also compiled into this isolated integration-test crate.
fn report(passed: bool, reaped: bool, reason: &str) -> String {
    format!("{passed}:{reaped}:{reason}")
}
