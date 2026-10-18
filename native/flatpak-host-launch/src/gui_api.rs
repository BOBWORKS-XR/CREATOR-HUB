//! Production GUI admission. No host operations or publisher trust are conferred.
//!
//! ```compile_fail
//! use creator_hub_flatpak_host_launch::GuiSession;
//! let forged = GuiSession {};
//! ```
//! ```compile_fail
//! use creator_hub_flatpak_host_launch::GuiRequest;
//! let forged = GuiRequest { id: 1, body: vec![], session: [0; 32] };
//! ```
//! ```compile_fail
//! use creator_hub_flatpak_host_launch::GuiPeer;
//! let forged = GuiPeer::from_raw_fd(3);
//! ```

#[derive(Debug)]
pub struct GuiError {
    pub(crate) reason: &'static str,
    pub(crate) owned_child_reaped: bool,
    pub(crate) outcome_unknown: bool,
}
impl GuiError {
    pub fn reason(&self) -> &'static str {
        self.reason
    }
    pub fn owned_child_reaped(&self) -> bool {
        self.owned_child_reaped
    }
    pub fn outcome_unknown(&self) -> bool {
        self.outcome_unknown
    }
}
impl std::fmt::Display for GuiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for GuiError {}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use crate::linux::gui::{GuiPeer, GuiSession};

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
mod unsupported {
    use super::GuiError;
    use crate::{GuiMessage, GuiRequest};
    use std::time::Instant;
    pub struct GuiSession {
        _private: (),
    }
    pub struct GuiPeer {
        _private: (),
    }
    fn unsupported<T>() -> Result<T, GuiError> {
        Err(GuiError {
            reason: "unsupported-platform",
            owned_child_reaped: false,
            outcome_unknown: false,
        })
    }
    impl GuiSession {
        pub fn launch_installed() -> Result<Self, GuiError> {
            unsupported()
        }
        pub fn poll_request(&mut self, _deadline: Instant) -> Result<Option<GuiRequest>, GuiError> {
            unsupported()
        }
        pub fn send_response(
            &mut self,
            _request: GuiRequest,
            _payload: &[u8],
            _deadline: Instant,
        ) -> Result<(), GuiError> {
            unsupported()
        }
        pub fn send_event(&mut self, _payload: &[u8], _deadline: Instant) -> Result<(), GuiError> {
            unsupported()
        }
        pub fn revalidate(&mut self) -> Result<(), GuiError> {
            unsupported()
        }
        pub fn finish(self, _deadline: Instant) -> Result<(), GuiError> {
            unsupported()
        }
    }
    impl GuiPeer {
        pub fn from_inherited() -> Result<Self, GuiError> {
            unsupported()
        }
        pub fn send_request(
            &mut self,
            _payload: &[u8],
            _deadline: Instant,
        ) -> Result<u64, GuiError> {
            unsupported()
        }
        pub fn poll_message(&mut self, _deadline: Instant) -> Result<Option<GuiMessage>, GuiError> {
            unsupported()
        }
    }
    #[test]
    fn unsupported_production_constructors_never_touch_native_state() {
        assert_eq!(
            GuiSession::launch_installed().err().unwrap().reason(),
            "unsupported-platform"
        );
        assert_eq!(
            GuiPeer::from_inherited().err().unwrap().reason(),
            "unsupported-platform"
        );
    }
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub use unsupported::{GuiPeer, GuiSession};
