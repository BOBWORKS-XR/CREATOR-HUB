//! Disposable synthetic transport proof. No product API or settings authority.
//!
//! A live capability cannot be constructed from fields or a trust assertion:
//! ```compile_fail
//! use creator_hub_flatpak_host_launch::FixedEchoSession;
//! let forged = FixedEchoSession {};
//! ```
//! ```compile_fail
//! use creator_hub_flatpak_host_launch::FixedEchoSession;
//! let forged = FixedEchoSession::from_trusted(true);
//! ```
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]
mod gui_protocol;
pub mod protocol;
pub use gui_protocol::{GuiMessage, GuiRequest};
mod gui_api;
pub use gui_api::{GuiError, GuiPeer, GuiSession};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux;

/// A failure of the fixed echo proof, never an authorization or release result.
#[derive(Debug)]
pub struct EchoFailure {
    reason: &'static str,
    owned_child_reaped: bool,
}

impl EchoFailure {
    pub fn reason(&self) -> &'static str {
        self.reason
    }

    pub fn owned_child_reaped(&self) -> bool {
        self.owned_child_reaped
    }
}

impl std::fmt::Display for EchoFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}

impl std::error::Error for EchoFailure {}

/// A live peer proven only against the fixed installed ECHO profile. This is not
/// an authenticated Hub, a signed deployment or a host-operation capability.
/// Fields and construction are private; no descriptor, path or trust assertion
/// can be supplied by a caller. The original 30-second deadline keeps running.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use linux::launch::FixedEchoSession;

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
/// Unsupported platforms can never construct this capability.
pub struct FixedEchoSession {
    _private: (),
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
impl FixedEchoSession {
    pub fn launch_installed() -> Result<Self, EchoFailure> {
        Err(EchoFailure {
            reason: "unsupported-platform",
            owned_child_reaped: false,
        })
    }

    pub fn challenge(&mut self) -> Result<(), EchoFailure> {
        Err(EchoFailure {
            reason: "unsupported-platform",
            owned_child_reaped: false,
        })
    }

    pub fn revalidate(&mut self) -> Result<(), EchoFailure> {
        self.challenge()
    }

    pub fn finish(self) -> Result<(), EchoFailure> {
        Err(EchoFailure {
            reason: "unsupported-platform",
            owned_child_reaped: false,
        })
    }
}

pub fn run() -> String {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        linux::launch::run()
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        report(false, false, "unsupported-platform")
    }
}

pub fn echo() -> bool {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        linux::echo()
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        false
    }
}

fn report(passed: bool, reaped: bool, reason: &str) -> String {
    format!(
        "{{\"schemaVersion\":1,\"scope\":\"synthetic-owned-flatpak-launch-only\",\"syntheticLaunchProofPassed\":{passed},\"ownedChildReaped\":{reaped},\"reason\":\"{reason}\",\"signedDeploymentVerified\":false,\"uiCallerAuthenticated\":false,\"hostReaderExposed\":false,\"hostIntegrationAccepted\":false,\"migrationAccepted\":false,\"releaseReady\":false}}\n"
    )
}

#[cfg(test)]
mod tests {
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    #[test]
    fn unsupported_constructor_cannot_mint_a_live_session() {
        let error = super::FixedEchoSession::launch_installed().err().unwrap();
        assert_eq!(error.reason(), "unsupported-platform");
        assert!(!error.owned_child_reaped());
        assert!(super::run().contains("\"syntheticLaunchProofPassed\":false"));
    }
}
