//! Existing-file swap and paired capture. Not CAS and never a rollback/retry API.
use crate::settings_backup as storage;
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
};

pub(super) struct Capture {
    target: PathBuf,
    stage: PathBuf,
    displaced: PathBuf,
    target_directory: File,
    capture_directory: File,
    staged: File,
    after_sha256: String,
}

fn error(message: &str) -> io::Error {
    io::Error::other(message)
}
fn name(path: &Path) -> io::Result<CString> {
    CString::new(
        path.file_name()
            .ok_or_else(|| error("Missing publication file name"))?
            .as_bytes(),
    )
    .map_err(|_| error("Invalid publication file name"))
}
fn directory(path: &Path) -> io::Result<File> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(error("Publication paths must be absolute and unambiguous"));
    }
    storage::reject_links(path).map_err(|message| error(&message))?;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}
fn regular(path: &Path) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > storage::MAX_BYTES
        || metadata.mode() & 0o7000 != 0
    {
        return Err(error(
            "Publication requires bounded, owned, single-link regular files",
        ));
    }
    Ok(metadata)
}
fn same_directory(file: &File, path: &Path) -> io::Result<()> {
    storage::reject_links(path).map_err(|message| error(&message))?;
    let held = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if !named.is_dir() || (held.dev(), held.ino()) != (named.dev(), named.ino()) {
        return Err(error("Publication directory changed"));
    }
    Ok(())
}

impl Capture {
    pub(super) fn prepare(
        target: &Path,
        stage: &Path,
        displaced: &Path,
        after_sha256: &str,
    ) -> io::Result<Self> {
        if stage.parent() != displaced.parent()
            || stage == displaced
            || target == stage
            || target == displaced
        {
            return Err(error(
                "Publication needs separate same-directory capture names",
            ));
        }
        let target_directory = directory(
            target
                .parent()
                .ok_or_else(|| error("Target has no parent"))?,
        )?;
        let capture_directory =
            directory(stage.parent().ok_or_else(|| error("Stage has no parent"))?)?;
        if capture_directory.metadata()?.mode() & 0o077 != 0 {
            return Err(error("Capture directory must be private"));
        }
        match fs::symlink_metadata(displaced) {
            Err(failure) if failure.kind() == io::ErrorKind::NotFound => {}
            _ => return Err(error("Displaced capture already exists or is unavailable")),
        }
        let old = regular(target)?;
        let proposed = regular(stage)?;
        if old.dev() != proposed.dev() || old.dev() != capture_directory.metadata()?.dev() {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if (old.dev(), old.ino()) == (proposed.dev(), proposed.ino()) {
            return Err(error("Target and proposed file must be different objects"));
        }
        let staged = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(stage)?;
        let mut capture = Self {
            target: target.into(),
            stage: stage.into(),
            displaced: displaced.into(),
            target_directory,
            capture_directory,
            staged,
            after_sha256: after_sha256.into(),
        };
        capture.check_stage()?;
        capture
            .staged
            .set_permissions(fs::Permissions::from_mode(old.mode() & 0o777))?;
        capture.staged.sync_all()?;
        Ok(capture)
    }

    fn check_stage(&mut self) -> io::Result<()> {
        same_directory(&self.target_directory, self.target.parent().unwrap())?;
        same_directory(&self.capture_directory, self.stage.parent().unwrap())?;
        let held = self.staged.metadata()?;
        let named = regular(&self.stage)?;
        if (held.dev(), held.ino()) != (named.dev(), named.ino()) {
            return Err(error("Proposed publication object changed"));
        }
        let bytes = storage::read(&mut self.staged).map_err(|message| error(&message))?;
        if format!("{:x}", Sha256::digest(bytes)) != self.after_sha256 {
            return Err(error("Proposed publication bytes changed"));
        }
        Ok(())
    }

    pub(super) fn exchange(&mut self) -> io::Result<()> {
        self.exchange_with(|capture| {
            native_rename(
                &capture.target_directory,
                &name(&capture.target)?,
                &capture.capture_directory,
                &name(&capture.stage)?,
                true,
            )
        })
    }

    fn exchange_with(&mut self, exchange: impl FnOnce(&Self) -> io::Result<()>) -> io::Result<()> {
        self.check_stage()?;
        // A replacement regular target is deliberately not compared to the old
        // inode: the atomic swap must retain the actual object at this boundary.
        regular(&self.target)?;
        exchange(self)
    }

    pub(super) fn retain(&self) -> io::Result<()> {
        // After swap, stage names the ACTUAL displaced object. Even failure here
        // leaves it intact; never remove it or swap it blindly back into target.
        native_rename(
            &self.capture_directory,
            &name(&self.stage)?,
            &self.capture_directory,
            &name(&self.displaced)?,
            false,
        )?;
        self.target_directory.sync_all()?;
        self.capture_directory.sync_all()
    }
}

fn native_rename(
    from_dir: &File,
    from: &CString,
    to_dir: &File,
    to: &CString,
    swap: bool,
) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            from_dir.as_raw_fd(),
            from.as_ptr(),
            to_dir.as_raw_fd(),
            to.as_ptr(),
            if swap {
                libc::RENAME_EXCHANGE
            } else {
                libc::RENAME_NOREPLACE
            },
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            from_dir.as_raw_fd(),
            from.as_ptr(),
            to_dir.as_raw_fd(),
            to.as_ptr(),
            if swap {
                libc::RENAME_SWAP
            } else {
                libc::RENAME_EXCL
            },
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _temporary: tempfile::TempDir,
        target: PathBuf,
        stage: PathBuf,
        displaced: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let target = root.join("config");
            let capture = root.join("capture");
            storage::private_directory(&capture).unwrap();
            let stage = capture.join("stage.bin");
            fs::write(&target, b"before").unwrap();
            storage::durable_image(&stage, b"after").unwrap();
            Self {
                _temporary: temporary,
                target,
                stage,
                displaced: capture.join("displaced.bin"),
            }
        }
        fn prepare(&self) -> Capture {
            Capture::prepare(
                &self.target,
                &self.stage,
                &self.displaced,
                &format!("{:x}", Sha256::digest(b"after")),
            )
            .unwrap()
        }
    }
    #[test]
    fn native_swap_captures_actual_replacement_and_preserves_target_mode() {
        let fixture = Fixture::new();
        fs::set_permissions(&fixture.target, fs::Permissions::from_mode(0o640)).unwrap();
        let mut capture = fixture.prepare();
        let replacement = fixture.target.with_extension("external");
        fs::write(&replacement, b"external bytes\xff").unwrap();
        fs::rename(replacement, &fixture.target).unwrap();
        capture.exchange().unwrap();
        assert_eq!(fs::read(&fixture.target).unwrap(), b"after");
        assert_eq!(fs::read(&fixture.stage).unwrap(), b"external bytes\xff");
        capture.retain().unwrap();
        assert!(!fixture.stage.exists());
        assert_eq!(fs::read(&fixture.displaced).unwrap(), b"external bytes\xff");
        assert_eq!(fs::metadata(&fixture.target).unwrap().mode() & 0o777, 0o640);
    }
    #[test]
    fn native_failure_never_falls_back_and_retained_capture_never_replaces_unknown_bytes() {
        let fixture = Fixture::new();
        let mut capture = fixture.prepare();
        for code in [libc::EINVAL, libc::ENOTSUP, libc::EXDEV, libc::ENOSYS] {
            assert!(capture
                .exchange_with(|_| Err(io::Error::from_raw_os_error(code)))
                .is_err());
            assert_eq!(fs::read(&fixture.target).unwrap(), b"before");
            assert_eq!(fs::read(&fixture.stage).unwrap(), b"after");
        }
        capture.exchange().unwrap();
        fs::write(&fixture.displaced, b"not ours").unwrap();
        assert!(capture.retain().is_err());
        assert_eq!(fs::read(&fixture.stage).unwrap(), b"before");
        assert_eq!(fs::read(&fixture.displaced).unwrap(), b"not ours");
        assert_eq!(fs::read(&fixture.target).unwrap(), b"after");
    }
    #[test]
    fn missing_target_changed_stage_and_redirected_paths_refuse_without_recreation() {
        use std::os::unix::fs::symlink;
        for mutation in ["missing", "in-place-stage", "replaced-stage", "link-stage"] {
            let fixture = Fixture::new();
            let mut capture = fixture.prepare();
            match mutation {
                "missing" => fs::remove_file(&fixture.target).unwrap(),
                "in-place-stage" => fs::write(&fixture.stage, b"foreign").unwrap(),
                "replaced-stage" => {
                    fs::remove_file(&fixture.stage).unwrap();
                    fs::write(&fixture.stage, b"after").unwrap();
                }
                _ => {
                    fs::remove_file(&fixture.stage).unwrap();
                    symlink(&fixture.target, &fixture.stage).unwrap();
                }
            }
            assert!(capture.exchange().is_err(), "{mutation}");
            if mutation == "missing" {
                assert!(!fixture.target.exists());
            } else {
                assert_eq!(fs::read(&fixture.target).unwrap(), b"before");
            }
            assert!(!fixture.displaced.exists());
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn real_cross_volume_preflight_refuses_before_any_native_swap() {
        let fixture = Fixture::new();
        let other = tempfile::tempdir_in("/dev/shm").unwrap();
        let other_root = other.path().canonicalize().unwrap();
        assert_ne!(
            fs::metadata(&fixture.target).unwrap().dev(),
            fs::metadata(&other_root).unwrap().dev()
        );
        let private = other_root.join("private-capture");
        storage::private_directory(&private).unwrap();
        let stage = private.join("stage.bin");
        storage::durable_image(&stage, b"after").unwrap();
        let result = Capture::prepare(
            &fixture.target,
            &stage,
            &private.join("displaced.bin"),
            &format!("{:x}", Sha256::digest(b"after")),
        );
        let failure = result.err().unwrap();
        assert_eq!(failure.raw_os_error(), Some(libc::EXDEV), "{failure}");
        assert_eq!(fs::read(&fixture.target).unwrap(), b"before");
        assert_eq!(fs::read(stage).unwrap(), b"after");
    }
}
