use std::{
    fs,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
pub fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn ancestors(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Use an absolute, unredirected path.".into());
    }
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(m) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err("Reparse path refused.".into());
                    }
                }
                if m.file_type().is_symlink() || (part != path && !m.is_dir()) {
                    return Err("Redirected ancestor refused.".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(e)),
        }
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: std::time::SystemTime,
    identity: Vec<u64>,
}

fn stamp(file: &File) -> Result<Stamp> {
    let m = file.metadata().map_err(error)?;
    if !m.is_file() {
        return Err("Only regular files are allowed.".into());
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        if m.nlink() != 1 || m.uid() != unsafe { libc::geteuid() } {
            return Err("Foreign or hard-linked input refused.".into());
        }
        vec![
            m.dev(),
            m.ino(),
            u64::from(m.mode()),
            u64::from(m.uid()),
            u64::from(m.gid()),
            m.nlink(),
            m.ctime() as u64,
            m.ctime_nsec() as u64,
        ]
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(error(std::io::Error::last_os_error()));
        }
        if info.nNumberOfLinks != 1 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Hard-linked or reparse input refused.".into());
        }
        vec![
            u64::from(info.dwVolumeSerialNumber),
            u64::from(info.nFileIndexHigh),
            u64::from(info.nFileIndexLow),
            u64::from(info.dwFileAttributes),
            u64::from(info.ftCreationTime.dwHighDateTime),
            u64::from(info.ftCreationTime.dwLowDateTime),
        ]
    };
    Ok(Stamp {
        size: m.len(),
        modified: m.modified().map_err(error)?,
        identity,
    })
}

fn open(path: &Path) -> Result<File> {
    ancestors(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path).map_err(error)
}

pub struct Held {
    path: PathBuf,
    file: File,
    initial: Stamp,
}
impl Held {
    pub fn open(path: &Path, limit: u64, mode: Option<u32>) -> Result<Self> {
        let file = open(path)?;
        let initial = stamp(&file)?;
        if initial.size == 0 || initial.size > limit {
            return Err("Input size exceeds its bound.".into());
        }
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            if file.metadata().map_err(error)?.permissions().mode() & 0o7777 != mode {
                return Err("Native mode differs from the prepared record.".into());
            }
        }
        #[cfg(not(unix))]
        let _ = mode;
        let held = Self {
            path: path.to_owned(),
            file,
            initial,
        };
        held.recheck()?;
        Ok(held)
    }
    pub fn read(&mut self, limit: u64) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        (&mut self.file)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        self.recheck()?;
        if bytes.len() as u64 != self.initial.size || bytes.len() as u64 > limit {
            return Err("Input drift or size bound failure.".into());
        }
        Ok(bytes)
    }
    pub fn recheck(&self) -> Result<()> {
        if stamp(&self.file)? != self.initial || stamp(&open(&self.path)?)? != self.initial {
            return Err("Input identity changed.".into());
        }
        Ok(())
    }
}

pub fn new_directory(path: &Path) -> Result<()> {
    ancestors(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(error)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path).map_err(error)
    }
}
