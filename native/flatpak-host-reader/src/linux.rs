use crate::paths::{
    DeclaredGrants, HostHints, HostPaths, HostSettingPath, Presence, PrivatePaths, Setting,
    SettingsReader, Unavailable,
};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString, OsString},
    fs::{self, File, Metadata},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
};

fn denied(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn exact_path(path: &Path) -> io::Result<()> {
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() > 4096
        || !bytes.starts_with(b"/")
        || bytes.len() == 1
        || bytes.iter().any(|b| b.is_ascii_control())
        || bytes[1..]
            .split(|b| *b == b'/')
            .any(|p| p.is_empty() || p == b"." || p == b"..")
    {
        return Err(invalid("An exact absolute native path is required."));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    uid: [u32; 3],
    gid: [u32; 3],
    pid: u32,
}

impl Identity {
    fn capture() -> io::Result<Self> {
        let mut uid = [0; 3];
        let mut gid = [0; 3];
        // These are kernel identities of this process, not claimed peer credentials.
        unsafe {
            let u = uid.as_mut_ptr();
            let g = gid.as_mut_ptr();
            if libc::getresuid(u, u.add(1), u.add(2)) != 0
                || libc::getresgid(g, g.add(1), g.add(2)) != 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self {
            uid,
            gid,
            pid: unsafe { libc::getpid() } as u32,
        })
    }

    fn admit(self, sandbox: bool) -> io::Result<Self> {
        if sandbox
            || self.uid[0] == 0
            || self.uid.iter().any(|uid| *uid != self.uid[0])
            || self.gid.iter().any(|gid| *gid != self.gid[0])
            || self.pid <= 1
        {
            return Err(denied(
                "An unprivileged native current-user process is required.",
            ));
        }
        Ok(self)
    }
}

fn sandbox_present() -> io::Result<bool> {
    if std::env::var_os("FLATPAK_ID").is_some() {
        return Ok(true);
    }
    match fs::symlink_metadata("/.flatpak-info") {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn account_home(uid: u32) -> io::Result<PathBuf> {
    for size in [1024, 4096, 16384, 65536] {
        let mut buffer = vec![0u8; size];
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            continue;
        }
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        if result.is_null() {
            return Err(denied("The native account record is unavailable."));
        }
        let record = unsafe { record.assume_init() };
        if record.pw_uid != uid || record.pw_dir.is_null() {
            return Err(denied(
                "The native account record does not match this user.",
            ));
        }
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(
            unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes(),
        ));
        exact_path(&home)?;
        return Ok(home);
    }
    Err(invalid("The native account record exceeds its size bound."))
}

fn derive_paths(
    home: &Path,
    config: Option<OsString>,
    data: Option<OsString>,
) -> io::Result<HostPaths> {
    exact_path(home)?;
    let private_base = home.join(".var/app/com.creatorworks.hub");
    let private = PrivatePaths::new(private_base.join("config"), private_base.join("data"))
        .map_err(|_| invalid("Invalid private settings roots."))?;
    let config = config.map(PathBuf::from);
    let data = data.map(PathBuf::from);
    for root in [config.as_ref(), data.as_ref()].into_iter().flatten() {
        exact_path(root)?;
        if root.starts_with(home.join(".var/app")) {
            return Err(denied(
                "Sandbox-private XDG roots are not native host settings.",
            ));
        }
    }
    HostPaths::from_hints(&private, home, HostHints { config, data })
        .map_err(|_| invalid("Invalid or overlapping native settings roots."))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    links: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

impl From<&Metadata> for Stamp {
    fn from(meta: &Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            uid: meta.uid(),
            gid: meta.gid(),
            mode: meta.mode(),
            links: meta.nlink(),
            size: meta.len(),
            mtime: (meta.mtime(), meta.mtime_nsec()),
            ctime: (meta.ctime(), meta.ctime_nsec()),
        }
    }
}

fn open_at(parent: RawFd, name: &std::ffi::OsStr, flags: i32) -> io::Result<File> {
    let name = CString::new(name.as_bytes()).map_err(|_| invalid("NUL in native path."))?;
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn directory(meta: &Metadata, uid: u32, leaf: bool) -> io::Result<()> {
    if !meta.is_dir()
        || (meta.uid() != uid && (leaf || meta.uid() != 0))
        || meta.mode() & 0o7022 != 0
        || meta.mode() & 0o100 == 0
    {
        return Err(denied(
            "Native directory owner, type or permissions refused.",
        ));
    }
    Ok(())
}

struct Chain {
    leaf: File,
    stamps: Vec<Stamp>,
}

impl Chain {
    fn open(path: &Path, uid: u32) -> io::Result<Self> {
        exact_path(path)?;
        let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut leaf = open_at(libc::AT_FDCWD, std::ffi::OsStr::new("/"), flags)?;
        let meta = leaf.metadata()?;
        directory(&meta, uid, false)?;
        let mut stamps = vec![Stamp::from(&meta)];
        let components = path.components().skip(1).collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            leaf = open_at(leaf.as_raw_fd(), component.as_os_str(), flags)?;
            let meta = leaf.metadata()?;
            directory(&meta, uid, index + 1 == components.len())?;
            stamps.push(Stamp::from(&meta));
        }
        Ok(Self { leaf, stamps })
    }
}

fn regular(meta: &Metadata, uid: u32, limit: usize) -> io::Result<Stamp> {
    if !meta.is_file()
        || meta.uid() != uid
        || meta.nlink() != 1
        || meta.mode() & 0o7133 != 0
        || meta.mode() & 0o400 == 0
    {
        return Err(denied(
            "Native settings owner, type, links or permissions refused.",
        ));
    }
    if meta.len() > limit as u64 {
        return Err(invalid("Native settings exceed their size bound."));
    }
    Ok(Stamp::from(meta))
}

struct ProtectedReader {
    uid: u32,
    paths: HostPaths,
    roots: BTreeMap<PathBuf, Chain>,
    proc_fds: File,
    #[cfg(test)]
    before_read: Option<Box<dyn FnOnce()>>,
}

impl ProtectedReader {
    fn new(uid: u32, paths: HostPaths) -> io::Result<Self> {
        let proc_fds = Chain::open(
            &PathBuf::from(format!("/proc/{}/fd", unsafe { libc::getpid() })),
            uid,
        )?
        .leaf;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(proc_fds.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { stat.assume_init() }.f_type != libc::PROC_SUPER_MAGIC {
            return Err(denied("A native procfs descriptor directory is required."));
        }
        Ok(Self {
            uid,
            paths,
            roots: BTreeMap::new(),
            proc_fds,
            #[cfg(test)]
            before_read: None,
        })
    }

    fn bind(&mut self, setting: Setting) -> io::Result<PathBuf> {
        let file = self.paths.setting(setting);
        let root = file.as_path().parent().unwrap().to_owned();
        if !self.roots.contains_key(&root) {
            self.roots
                .insert(root.clone(), Chain::open(&root, self.uid)?);
        }
        Ok(root)
    }
}

impl SettingsReader for ProtectedReader {
    fn check_root(&mut self, root: &Path) -> io::Result<()> {
        let bound = self
            .roots
            .get(root)
            .ok_or_else(|| denied("Unbound settings directory refused."))?;
        let current = Chain::open(root, self.uid)?;
        if current.stamps != bound.stamps
            || Stamp::from(&bound.leaf.metadata()?) != *bound.stamps.last().unwrap()
        {
            return Err(denied("Native settings directory identity changed."));
        }
        Ok(())
    }

    fn read_setting(&mut self, file: &HostSettingPath, limit: usize) -> io::Result<Vec<u8>> {
        let expected = self.paths.setting(file.setting());
        if file.as_path() != expected.as_path() || limit != file.setting().limit() {
            return Err(denied(
                "Only the fixed native settings allowlist can be read.",
            ));
        }
        let root = file.as_path().parent().unwrap();
        self.check_root(root)?;
        let parent = self.roots.get(root).unwrap().leaf.as_raw_fd();
        let name = file.as_path().file_name().unwrap();
        let flags = libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // O_PATH pins the object without opening a substituted FIFO/device for I/O.
        let pinned = open_at(parent, name, flags)?;
        let before = regular(&pinned.metadata()?, self.uid, limit)?;
        // Only this known, still-live regular-file FD is followed through verified procfs.
        let mut input = open_at(
            self.proc_fds.as_raw_fd(),
            std::ffi::OsStr::new(&pinned.as_raw_fd().to_string()),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_NOATIME,
        )?;
        if regular(&input.metadata()?, self.uid, limit)? != before {
            return Err(denied("The pinned settings file changed while reopening."));
        }
        #[cfg(test)]
        if let Some(hook) = self.before_read.take() {
            hook();
        }
        let mut bytes = Vec::with_capacity(before.size as usize);
        input
            .by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        let named = open_at(parent, name, flags)?;
        if bytes.len() > limit
            || bytes.len() as u64 != before.size
            || regular(&input.metadata()?, self.uid, limit)? != before
            || regular(&pinned.metadata()?, self.uid, limit)? != before
            || regular(&named.metadata()?, self.uid, limit)? != before
        {
            return Err(invalid(
                "Native settings changed during their bounded read.",
            ));
        }
        self.check_root(root)?;
        Ok(bytes)
    }
}

pub(crate) struct HostSettings {
    identity: Identity,
    paths: HostPaths,
    reader: ProtectedReader,
}

impl HostSettings {
    pub(crate) fn current_user() -> io::Result<Self> {
        let identity = Identity::capture()?.admit(sandbox_present()?)?;
        let home = account_home(identity.uid[0])?;
        let paths = derive_paths(
            &home,
            std::env::var_os("XDG_CONFIG_HOME"),
            std::env::var_os("XDG_DATA_HOME"),
        )?;
        let reader = ProtectedReader::new(identity.uid[0], paths.clone())?;
        Ok(Self {
            identity,
            paths,
            reader,
        })
    }

    pub(crate) fn inspect(&mut self, setting: Setting) -> Presence<Vec<u8>> {
        if Identity::capture()
            .and_then(|id| id.admit(sandbox_present()?))
            .is_ok_and(|id| id == self.identity)
        {
            let root = match self.reader.bind(setting) {
                Ok(root) => root,
                Err(error) => return Presence::Unavailable(Unavailable::Root(error.kind())),
            };
            let grants = match DeclaredGrants::new(&self.paths, vec![root]) {
                Ok(grants) => grants,
                Err(_) => return Presence::Unavailable(Unavailable::NotGranted),
            };
            self.paths.inspect(setting, &grants, &mut self.reader)
        } else {
            Presence::Unavailable(Unavailable::Read(io::ErrorKind::PermissionDenied))
        }
    }
}

#[cfg(test)]
mod tests;
