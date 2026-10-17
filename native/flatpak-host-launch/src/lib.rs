//! Disposable synthetic transport proof. No product API or settings authority.
pub mod protocol;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux;

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
