//! Read-only native account settings prerequisite. No IPC, peer admission or host writer.
#[path = "../../flatpak-host-paths.rs"]
pub mod paths;

#[cfg(target_os = "linux")]
mod linux;

use paths::{Presence, Setting};
use std::io;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InspectionStatus {
    Present { byte_length: usize },
    Absent,
    Unavailable,
}

pub struct NativeHostSettings {
    #[cfg(target_os = "linux")]
    inner: linux::HostSettings,
}

impl NativeHostSettings {
    /// The account and roots come from this native process, never a sandbox request.
    /// This grants no external caller access to the returned bytes.
    pub fn current_user() -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                inner: linux::HostSettings::current_user()?,
            })
        }
        #[cfg(not(target_os = "linux"))]
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Native host settings inspection is Linux-only.",
        ))
    }

    /// Raw bytes remain in-process. This API neither merges nor saves settings.
    pub fn inspect(&mut self, setting: Setting) -> Presence<Vec<u8>> {
        #[cfg(target_os = "linux")]
        {
            self.inner.inspect(setting)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = setting;
            Presence::Unavailable(paths::Unavailable::Read(io::ErrorKind::Unsupported))
        }
    }

    /// A diagnostic projection only; never returns config contents, paths or hashes.
    pub fn inspect_status(&mut self, setting: Setting) -> InspectionStatus {
        match self.inspect(setting) {
            Presence::Present(bytes) => InspectionStatus::Present {
                byte_length: bytes.len(),
            },
            Presence::Absent => InspectionStatus::Absent,
            Presence::Unavailable(_) => InspectionStatus::Unavailable,
        }
    }
}
