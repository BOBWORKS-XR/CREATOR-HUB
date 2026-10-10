//! Settings ownership for cooperating writable presentations.
//! Read-only hosting and client-owned MCP stdio servers never acquire this file.
//! Unix locks are advisory, not Windows deny-write/delete image protection.
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

const LOCK_FILE: &str = "launcher-gui.lock";

#[derive(Debug)]
pub struct GuiWriteOwner {
    _file: File,
    #[cfg(unix)]
    marker: unix::Marker,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OwnershipError {
    Busy,
    Unavailable,
}

impl GuiWriteOwner {
    pub fn current_user() -> Result<Self, OwnershipError> {
        let root = dirs::config_dir().ok_or(OwnershipError::Unavailable)?;
        Self::acquire(&root.join(crate::APP_CONFIG_DIR))
    }

    #[cfg(windows)]
    fn acquire(settings_directory: &Path) -> Result<Self, OwnershipError> {
        fs::create_dir_all(settings_directory).map_err(|_| OwnershipError::Unavailable)?;
        // Windows resolves aliases/case to the same file identity. Denying all
        // sharing also prevents deleting/replacing the lock while it is held.
        // Keep this ordinary file on release; deleting it introduces a race.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(settings_directory.join(LOCK_FILE))
            .map_err(|error| match error.raw_os_error() {
                Some(32 | 33) => OwnershipError::Busy,
                _ => OwnershipError::Unavailable,
            })?;
        Ok(Self { _file: file })
    }

    #[cfg(unix)]
    fn acquire(settings_directory: &Path) -> Result<Self, OwnershipError> {
        unix::acquire(settings_directory)
    }

    #[cfg(unix)]
    pub fn ensure_current(&self) -> Result<(), OwnershipError> {
        self.marker.check(&self._file)
    }
}

#[cfg(unix)]
impl Drop for GuiWriteOwner {
    fn drop(&mut self) {
        // A duplicated handle must not retain ownership after the guard ends.
        let _ = fs2::FileExt::unlock(&self._file);
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt, fs::OpenOptionsExt},
        },
        path::{Component, PathBuf},
    };

    #[derive(Debug, PartialEq, Eq)]
    struct Stamp {
        device: u64,
        inode: u64,
        length: u64,
        modified: (i64, i64),
        changed: (i64, i64),
        mode: u32,
    }

    impl Stamp {
        fn read(meta: &fs::Metadata) -> Result<Self, OwnershipError> {
            if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
                return Err(OwnershipError::Unavailable);
            }
            Ok(Self {
                device: meta.dev(),
                inode: meta.ino(),
                length: meta.len(),
                modified: (meta.mtime(), meta.mtime_nsec()),
                changed: (meta.ctime(), meta.ctime_nsec()),
                mode: meta.mode(),
            })
        }
    }

    #[derive(Debug)]
    pub(super) struct Marker {
        pub(super) directory: File,
        path: PathBuf,
        requested_path: PathBuf,
        stamp: Stamp,
    }

    fn reject_links(path: &Path) -> Result<(), OwnershipError> {
        for ancestor in path.ancestors() {
            let meta = fs::symlink_metadata(ancestor).map_err(|_| OwnershipError::Unavailable)?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(OwnershipError::Unavailable);
            }
        }
        Ok(())
    }

    impl Marker {
        pub(super) fn check(&self, file: &File) -> Result<(), OwnershipError> {
            reject_links(&self.path)?;
            reject_links(&self.requested_path)?;
            let held = self
                .directory
                .metadata()
                .map_err(|_| OwnershipError::Unavailable)?;
            let named =
                fs::symlink_metadata(&self.path).map_err(|_| OwnershipError::Unavailable)?;
            if (held.dev(), held.ino()) != (named.dev(), named.ino()) {
                return Err(OwnershipError::Unavailable);
            }
            let requested = fs::symlink_metadata(&self.requested_path)
                .map_err(|_| OwnershipError::Unavailable)?;
            if (held.dev(), held.ino()) != (requested.dev(), requested.ino()) {
                return Err(OwnershipError::Unavailable);
            }
            for meta in [
                file.metadata(),
                fs::symlink_metadata(self.path.join(LOCK_FILE)),
            ] {
                if Stamp::read(&meta.map_err(|_| OwnershipError::Unavailable)?)? != self.stamp {
                    return Err(OwnershipError::Unavailable);
                }
            }
            Ok(())
        }
    }

    // Walk/create relative to pinned directories; no component may redirect
    // marker creation through a symlink, even during concurrent path changes.
    fn directory(path: &Path) -> Result<File, OwnershipError> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(OwnershipError::Unavailable);
        }
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open("/")
            .map_err(|_| OwnershipError::Unavailable)?;
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let name = CString::new(name.as_bytes()).map_err(|_| OwnershipError::Unavailable)?;
            let mut fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                let created = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if created != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(OwnershipError::Unavailable);
                }
                fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            }
            if fd < 0 {
                return Err(OwnershipError::Unavailable);
            }
            directory = unsafe { File::from_raw_fd(fd) };
        }
        Ok(directory)
    }

    pub(super) fn acquire(path: &Path) -> Result<GuiWriteOwner, OwnershipError> {
        let directory = directory(path)?;
        reject_links(path)?;
        let requested_path = path.to_path_buf();
        let path = path
            .canonicalize()
            .map_err(|_| OwnershipError::Unavailable)?;
        let name = CString::new(LOCK_FILE).unwrap();
        let flags =
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(OwnershipError::Unavailable);
        }
        let file = unsafe { File::from_raw_fd(fd) };
        Stamp::read(&file.metadata().map_err(|_| OwnershipError::Unavailable)?)?;
        fs2::FileExt::try_lock_exclusive(&file).map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                OwnershipError::Busy
            } else {
                OwnershipError::Unavailable
            }
        })?;
        let stamp = Stamp::read(&file.metadata().map_err(|_| OwnershipError::Unavailable)?)?;
        let owner = GuiWriteOwner {
            _file: file,
            marker: Marker {
                directory,
                path,
                requested_path,
                stamp,
            },
        };
        owner.ensure_current()?;
        Ok(owner)
    }
}

#[cfg(windows)]
pub fn show_blocked(error: OwnershipError) {
    use windows_sys::{
        core::w,
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONEXCLAMATION, MB_OK},
    };
    let message = match error {
        OwnershipError::Busy => w!("Creator Works MCP settings are already being managed by another compatible window. Close that window before opening another writable MCP window. No application has been stopped."),
        OwnershipError::Unavailable => w!("Creator Works MCP could not reserve access to its launcher settings. No settings were changed. Check the settings folder permissions before trying again."),
    };
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message,
            w!("Creator Works MCP"),
            MB_OK | MB_ICONEXCLAMATION,
        );
    }
}

#[cfg(unix)]
pub fn blocked_message(error: &OwnershipError) -> &'static str {
    match error {
        OwnershipError::Busy => "Creator Works MCP settings are already being managed by another compatible window. Close that window before opening another writable MCP window. No application has been stopped.",
        OwnershipError::Unavailable => "Creator Works MCP could not reserve access to its launcher settings. No settings were changed. Check the settings folder permissions and symbolic links before trying again.",
    }
}

#[cfg(unix)]
pub fn show_blocked(app: &tauri::AppHandle, error: &OwnershipError) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(blocked_message(error))
        .title("Creator Works MCP")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Command};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("creator-gui-owner-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            #[cfg(unix)]
            let path = path.canonicalize().unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn same_settings_aliases_are_exclusive_and_release_without_truncation() {
        let fixture = Fixture::new();
        let marker = fixture.0.join(LOCK_FILE);
        fs::write(&marker, b"preserve-existing-marker").unwrap();
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&fixture.0).unwrap_err(),
            OwnershipError::Busy
        );
        #[cfg(windows)]
        let alias = PathBuf::from(fixture.0.to_string_lossy().to_lowercase()).join(".");
        #[cfg(unix)]
        let alias = fixture.0.join(".");
        assert_eq!(
            GuiWriteOwner::acquire(&alias).unwrap_err(),
            OwnershipError::Busy
        );
        let canonical = fs::canonicalize(&fixture.0).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&canonical).unwrap_err(),
            OwnershipError::Busy
        );
        #[cfg(windows)]
        assert!(fs::remove_file(&marker).is_err());
        #[cfg(unix)]
        owner.ensure_current().unwrap();
        drop(owner);
        assert_eq!(fs::read(&marker).unwrap(), b"preserve-existing-marker");
        let again = GuiWriteOwner::acquire(&fixture.0).unwrap();
        drop(again);
    }

    #[test]
    fn other_settings_roots_are_independent_and_access_errors_are_not_idle() {
        let first = Fixture::new();
        let second = Fixture::new();
        let _a = GuiWriteOwner::acquire(&first.0).unwrap();
        let b = GuiWriteOwner::acquire(&second.0).unwrap();
        drop(b);
        fs::remove_file(second.0.join(LOCK_FILE)).unwrap();
        fs::create_dir(second.0.join(LOCK_FILE)).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&second.0).unwrap_err(),
            OwnershipError::Unavailable
        );
    }

    #[test]
    #[ignore = "subprocess fixture, invoked by cross_process_ownership"]
    fn process_fixture() {
        let Some(root) = std::env::var_os("CREATOR_GUI_OWNER_TEST_ROOT") else {
            return;
        };
        let result = GuiWriteOwner::acquire(Path::new(&root));
        std::process::exit(match result {
            Ok(_) => 0,
            Err(OwnershipError::Busy) => 10,
            Err(_) => 11,
        });
    }

    #[test]
    fn cross_process_ownership() {
        #[cfg(windows)]
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let child = || {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "gui_owner::tests::process_fixture", "--ignored"])
                .env("CREATOR_GUI_OWNER_TEST_ROOT", &fixture.0);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            command.status().unwrap().code()
        };
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        assert_eq!(child(), Some(10));
        drop(owner);
        assert_eq!(child(), Some(0));
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        drop(owner);
    }

    #[test]
    #[cfg(unix)]
    fn new_settings_directory_is_created_and_marker_is_retained() {
        let fixture = Fixture::new();
        let root = fixture.0.join("new/settings");
        let owner = GuiWriteOwner::acquire(&root).unwrap();
        owner.ensure_current().unwrap();
        drop(owner);
        assert!(root.join(LOCK_FILE).is_file());
        assert!(GuiWriteOwner::acquire(&root).is_ok());
        for path in [
            Path::new("relative/settings"),
            &fixture.0.join("child/../settings"),
        ] {
            assert_eq!(
                GuiWriteOwner::acquire(path).unwrap_err(),
                OwnershipError::Unavailable
            );
        }
        assert!(!fixture.0.join("child").exists());
    }

    #[test]
    #[cfg(unix)]
    fn symlink_directories_markers_and_non_regular_files_fail_closed() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let real = fixture.0.join("real");
        fs::create_dir(&real).unwrap();
        let alias = fixture.0.join("alias");
        symlink(&real, &alias).unwrap();
        for root in [&alias, &alias.join("new")] {
            assert_eq!(
                GuiWriteOwner::acquire(root).unwrap_err(),
                OwnershipError::Unavailable
            );
        }
        assert!(!real.join("new").exists());
        let original = fixture.0.join("original");
        fs::write(&original, b"preserve").unwrap();
        let marker = real.join(LOCK_FILE);
        symlink(&original, &marker).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&real).unwrap_err(),
            OwnershipError::Unavailable
        );
        fs::remove_file(&marker).unwrap();
        fs::hard_link(&original, &marker).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&real).unwrap_err(),
            OwnershipError::Unavailable
        );
        fs::remove_file(&marker).unwrap();
        let name = std::ffi::CString::new(marker.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(
            GuiWriteOwner::acquire(&real).unwrap_err(),
            OwnershipError::Unavailable
        );
        assert_eq!(fs::read(&original).unwrap(), b"preserve");
    }

    #[test]
    #[cfg(unix)]
    fn unlink_replace_or_change_marker_rejects_next_admission() {
        let fixture = Fixture::new();
        let marker = fixture.0.join(LOCK_FILE);
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        fs::remove_file(&marker).unwrap();
        assert_eq!(owner.ensure_current(), Err(OwnershipError::Unavailable));
        let replacement = GuiWriteOwner::acquire(&fixture.0).unwrap();
        // Advisory locks cannot stop unlink/recreation. The original guard
        // must refuse further dispatch, not silently authorize the new inode.
        assert_eq!(owner.ensure_current(), Err(OwnershipError::Unavailable));
        replacement.ensure_current().unwrap();
        drop(owner);
        assert_eq!(
            GuiWriteOwner::acquire(&fixture.0).unwrap_err(),
            OwnershipError::Busy
        );
        fs::write(&marker, b"changed outside the cooperating contract").unwrap();
        assert_eq!(
            replacement.ensure_current(),
            Err(OwnershipError::Unavailable)
        );
        drop(replacement);
        assert_eq!(
            fs::read(&marker).unwrap(),
            b"changed outside the cooperating contract"
        );
    }

    #[test]
    #[cfg(unix)]
    fn renamed_root_or_symlinked_parent_rejects_next_admission() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let root = fixture.0.join("settings");
        let owner = GuiWriteOwner::acquire(&root).unwrap();
        let renamed = fixture.0.join("renamed");
        fs::rename(&root, &renamed).unwrap();
        assert_eq!(owner.ensure_current(), Err(OwnershipError::Unavailable));
        symlink(&renamed, &root).unwrap();
        assert_eq!(owner.ensure_current(), Err(OwnershipError::Unavailable));
        fs::remove_file(&root).unwrap();
        let replacement = GuiWriteOwner::acquire(&root).unwrap();
        assert_eq!(owner.ensure_current(), Err(OwnershipError::Unavailable));
        replacement.ensure_current().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn explicit_unlock_releases_clones_and_descriptors_are_cloexec() {
        use std::os::fd::AsRawFd;
        let fixture = Fixture::new();
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        for file in [&owner._file, &owner.marker.directory] {
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            assert!(flags >= 0);
            assert_ne!(flags & libc::FD_CLOEXEC, 0);
        }
        let clone = owner._file.try_clone().unwrap();
        drop(owner);
        let next = GuiWriteOwner::acquire(&fixture.0).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&fixture.0).unwrap_err(),
            OwnershipError::Busy
        );
        drop(clone);
        assert_eq!(
            GuiWriteOwner::acquire(&fixture.0).unwrap_err(),
            OwnershipError::Busy
        );
        drop(next);
        assert!(fixture.0.join(LOCK_FILE).is_file());
    }
}
