use crate::{refused, require, Result};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
};

pub(crate) fn admit() -> Result<()> {
    require(
        cfg!(all(target_os = "linux", target_arch = "x86_64")),
        "Portable store is Linux x86_64 only",
    )?;
    #[cfg(unix)]
    require(
        unsafe { libc::getuid() } > 0 && unsafe { libc::getuid() == libc::geteuid() },
        "Unprivileged same-user deployment only",
    )?;
    Ok(())
}

pub(crate) fn unlinked(path: &Path) -> Result<()> {
    require(
        path.is_absolute()
            && !path.components().any(|c| {
                matches!(c, Component::ParentDir)
                    || matches!(c, Component::Normal(v) if v == "." || v == "..")
            }),
        "Absolute unlinked storage path required",
    )?;
    for target in path.ancestors() {
        match fs::symlink_metadata(target) {
            Ok(info) => {
                #[allow(unused_mut)]
                let mut link = info.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    link |= info.file_attributes() & 0x400 != 0;
                }
                require(!link, "Links/junctions are not deployment authority")?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    require(
                        info.uid() == 0 || info.uid() == unsafe { libc::geteuid() },
                        "Foreign deployment ancestor refused",
                    )?;
                    let protected_temporary_root =
                        info.is_dir() && info.uid() == 0 && info.mode() & 0o1000 != 0;
                    require(
                        info.mode() & 0o022 == 0 || protected_temporary_root,
                        "Foreign-writable deployment ancestry refused",
                    )?;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(refused("Cannot inspect deployment ancestry")),
        }
    }
    Ok(())
}

pub(crate) fn metadata(
    path: &Path,
    directory: bool,
    mode: Option<u32>,
    owned: bool,
) -> Result<Metadata> {
    unlinked(path)?;
    let info = fs::symlink_metadata(path).map_err(|_| refused("Deployment object missing"))?;
    require(
        if directory {
            info.is_dir()
        } else {
            info.is_file()
        },
        "Ordinary deployment object required",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        require(
            directory || info.nlink() == 1,
            "Hard-linked deployment file refused",
        )?;
        require(
            !owned || info.uid() == unsafe { libc::geteuid() },
            "Foreign deployment owner refused",
        )?;
        require(
            mode.is_none_or(|m| info.mode() & 0o7777 == m),
            "Deployment permissions changed",
        )?;
    }
    #[cfg(not(unix))]
    let _ = (mode, owned);
    Ok(info)
}

pub(crate) fn same(first: &Metadata, last: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (
            first.dev(),
            first.ino(),
            first.uid(),
            first.mode(),
            first.nlink(),
            first.ctime(),
            first.ctime_nsec(),
        ) != (
            last.dev(),
            last.ino(),
            last.uid(),
            last.mode(),
            last.nlink(),
            last.ctime(),
            last.ctime_nsec(),
        ) {
            return false;
        }
    }
    first.len() == last.len() && first.modified().ok() == last.modified().ok()
}

pub(crate) fn read_regular(path: &Path, limit: u64, owned: bool) -> Result<Vec<u8>> {
    hold_regular(path, limit, owned).map(|(_, bytes)| bytes)
}

pub(crate) fn hold_regular(path: &Path, limit: u64, owned: bool) -> Result<(File, Vec<u8>)> {
    let named = metadata(path, false, None, owned)?;
    require(named.len() <= limit, "Deployment file exceeds bound")?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options
        .open(path)
        .map_err(|_| refused("Cannot open deployment file"))?;
    let before = file
        .metadata()
        .map_err(|_| refused("Cannot inspect deployment file"))?;
    require(
        before.is_file() && same(&named, &before),
        "Deployment file replaced before reading",
    )?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused("Cannot read deployment file"))?;
    let after = file
        .metadata()
        .map_err(|_| refused("Cannot recheck deployment file"))?;
    let current = metadata(path, false, None, owned)?;
    require(
        bytes.len() as u64 <= limit
            && bytes.len() as u64 == before.len()
            && same(&before, &after)
            && same(&before, &current),
        "Deployment file changed while reading",
    )?;
    Ok((file, bytes))
}

pub(crate) fn create_dir(path: &Path) -> Result<()> {
    unlinked(path)?;
    #[allow(unused_mut)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| refused("Cannot exclusively create deployment directory"))?;
    metadata(path, true, Some(0o700), true)?;
    Ok(())
}

pub(crate) fn set_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|_| refused("Cannot protect deployment object"))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

pub(crate) fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    unlinked(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(path)
        .map_err(|_| refused("Cannot reserve new deployment file"))?;
    file.write_all(bytes)
        .map_err(|_| refused("Cannot write deployment file"))?;
    set_mode(path, mode)?;
    file.sync_all()
        .map_err(|_| refused("Cannot flush deployment file"))
}

pub(crate) fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| refused("Cannot flush deployment directory"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// No fallback to an overwriting rename. Used only for a complete private
/// bootstrap directory and fixed native store name, with held parent handles.
#[cfg(target_os = "linux")]
pub(crate) fn publish_directory_noreplace(
    source_parent: &File,
    source_name: &std::ffi::OsStr,
    target_parent: &File,
    target_name: &std::ffi::OsStr,
) -> Result<()> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
    let component = |name: &std::ffi::OsStr| -> Result<std::ffi::CString> {
        let bytes = name.as_bytes();
        require(
            !bytes.is_empty() && bytes != b"." && bytes != b".." && !bytes.contains(&b'/'),
            "Only fixed single-component bootstrap names accepted",
        )?;
        std::ffi::CString::new(bytes).map_err(|_| refused("Invalid bootstrap publication name"))
    };
    let source = component(source_name)?;
    let target = component(target_name)?;
    require(
        unsafe {
            libc::renameat2(
                source_parent.as_raw_fd(),
                source.as_ptr(),
                target_parent.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } == 0,
        "Bootstrap directory not published; existing target kept or no-replace rename unavailable",
    )
}

pub(crate) fn lock(path: &Path) -> Result<File> {
    let before = metadata(path, false, Some(0o600), true)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let lock = options
        .open(path)
        .map_err(|_| refused("Cannot open deployment lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| refused("Another deployment transaction holds the lock"))?;
    require(
        same(
            &before,
            &lock
                .metadata()
                .map_err(|_| refused("Cannot inspect deployment lock"))?,
        ) && same(&before, &metadata(path, false, Some(0o600), true)?),
        "Deployment lock replaced",
    )?;
    Ok(lock)
}
