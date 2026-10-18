//! Hold the fixed GUI inode open for writing without writing any bytes. Linux
//! excludes normal exec of this inode until the helper's descriptor is dropped.
use super::*;

pub(super) struct Guard {
    _image: File,
    _writer: File,
}

fn bind(image: File, before: &Metadata, writer: impl FnOnce() -> Result<File>) -> Result<Guard> {
    let writer = writer()?;
    require(
        stamp(before) == stamp(&image.metadata()?) && stamp(before) == stamp(&writer.metadata()?),
        "Fixed GUI image changed while excluding execution; no transaction started",
    )?;
    Ok(Guard {
        _image: image,
        _writer: writer,
    })
}

pub(super) fn acquire(target: Target) -> Result<Guard> {
    let (members, fixed) = match target {
        Target::Mcp => (pins::FILES, "usr/bin/creator-works-mcp-launcher"),
        Target::Setup => (crate::setup::FILES, "usr/bin/creator-project-setup"),
    };
    let pin = members
        .iter()
        .find(|pin| pin.path == fixed)
        .ok_or("Fixed GUI package member missing")?;
    require(
        !pin.retained && pin.mode == 0o755,
        "Fixed GUI member must be the omitted executable",
    )?;
    let path = Path::new("/").join(pin.path);
    let image = open(&path, libc::O_RDONLY)?;
    let before = image.metadata()?;
    require(
        before.len() == pin.bytes && before.mode() & 0o7777 == pin.mode,
        "Fixed GUI image changed",
    )?;
    copy_pinned(&image, std::io::sink(), pin)?;
    // open() supplies CLOEXEC/NOFOLLOW and protected ancestors. No create,
    // truncate or write: ETXTBSY, read-only mounts and LSM denials all refuse.
    let guard = bind(image, &before, || open(&path, libc::O_WRONLY))?;
    require(
        stamp(&before) == stamp(&open(&path, libc::O_RDONLY)?.metadata()?),
        "Fixed GUI path changed while excluding execution; no transaction started",
    )?;
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Seek, process::Child};

    fn writer(path: &Path) -> Result<File> {
        Ok(OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?)
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("owned-cat");
        fs::copy("/bin/cat", &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        (dir, path)
    }

    fn fingerprint(file: &File) -> (u64, u64, u64, u32, u32, u32, i64, i64, String) {
        let m = file.metadata().unwrap();
        let mut reader = file.try_clone().unwrap();
        reader.rewind().unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mode(),
            m.uid(),
            m.gid(),
            m.mtime(),
            m.mtime_nsec(),
            sha256(&bytes),
        )
    }

    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            drop(self.0.stdin.take());
            assert!(self.0.wait().unwrap().success());
        }
    }

    fn running(path: &Path, image: &File) -> OwnedChild {
        let mut child = OwnedChild(
            Command::new(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let expected = image.metadata().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            // Only our own child: no inventory, argv or unrelated signals.
            if let Ok(m) = fs::metadata(format!("/proc/{}/exe", child.0.id())) {
                if m.dev() == expected.dev() && m.ino() == expected.ino() {
                    return child;
                }
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Owned cat exited before readiness"
            );
            assert!(Instant::now() < deadline, "Owned cat readiness deadline");
            thread::yield_now();
        }
    }

    fn exec_busy(path: &Path) {
        let error = Command::new(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect_err("Exec must refuse");
        assert_eq!(error.raw_os_error(), Some(libc::ETXTBSY));
    }

    fn exec_ok(path: &Path) {
        assert!(Command::new(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn busy_image_refuses_guard_and_preserves_bytes_modes() {
        let (_dir, path) = fixture();
        let image = File::open(&path).unwrap();
        let before = fingerprint(&image);
        let child = running(&path, &image);
        assert_eq!(
            writer(&path)
                .err()
                .unwrap()
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(libc::ETXTBSY)
        );
        assert!(bind(
            image.try_clone().unwrap(),
            &image.metadata().unwrap(),
            || writer(&path)
        )
        .is_err());
        assert_eq!(before, fingerprint(&image));
        drop(child); // stdin EOF, natural exit; no kill/signals.
        assert!(bind(
            image.try_clone().unwrap(),
            &image.metadata().unwrap(),
            || writer(&path)
        )
        .is_ok());
    }

    #[test]
    fn held_guard_blocks_exec_but_allows_rename_and_unlink_without_byte_changes() {
        let (dir, path) = fixture();
        let image = File::open(&path).unwrap();
        let before = fingerprint(&image);
        let before_stamp = stamp(&image.metadata().unwrap());
        let guard = bind(
            image.try_clone().unwrap(),
            &image.metadata().unwrap(),
            || writer(&path),
        )
        .unwrap();
        assert_eq!(
            unsafe { libc::fcntl(guard._writer.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            libc::FD_CLOEXEC
        );
        assert_eq!(
            unsafe { libc::fcntl(guard._writer.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
            libc::O_WRONLY
        );
        exec_busy(&path);
        assert_eq!(before_stamp, stamp(&image.metadata().unwrap()));
        let renamed = dir.path().join("renamed-cat");
        fs::rename(&path, &renamed).unwrap();
        exec_busy(&renamed);
        fs::remove_file(&renamed).unwrap();
        let deleted = PathBuf::from(format!("/proc/self/fd/{}", image.as_raw_fd()));
        exec_busy(&deleted);
        assert_eq!(before, fingerprint(&image));
        drop(guard);
        exec_ok(&deleted);
        assert_eq!(before, fingerprint(&image));
    }

    #[test]
    fn changed_stamp_or_replacement_inode_refuses_binding() {
        let (dir, path) = fixture();
        let image = File::open(&path).unwrap();
        let before = image.metadata().unwrap();
        let replacement = dir.path().join("other-cat");
        fs::copy(&path, &replacement).unwrap();
        assert!(bind(image.try_clone().unwrap(), &before, || writer(&replacement)).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(bind(image, &before, || writer(&path)).is_err());
    }
}
